/**
 * Column-mapping import for arbitrary pipeline CSV/XLSX exports (2026-08-02, per Mo — "when I
 * upload a pipeline csv document from PowerBI or Salesforce, I want all of the rows to come into
 * the pipeline tagger... the fields from the csv should also show up in the pipeline tagger table
 * as mappable"). This replaces reportingImport.js's parseCampaignReportFile for the "pipeline"
 * unified-upload type specifically — that file is a deterministic parser for ONE fixed campaign-
 * level PowerBI export shape (a hardcoded header-alias map, rows with no recognized metric silently
 * dropped); it still exists and is still used for the "goals" type, but a Salesforce/HockeyStack/
 * whatever-else pipeline export can use entirely different column names, and per Mo's request every
 * row should land in the review table regardless of whether its columns were recognized.
 *
 * The flow: parsePipelineFileRaw reads every row of the file untouched (no column-name matching, no
 * row filtering beyond skipping genuinely blank rows) into a plain { headers, rows } grid.
 * guessColumnMapping then proposes a mapping per column (exact-alias match only, same
 * "false-positive is worse than asking" philosophy as ReportingFactsTagger's cross-match
 * suggestions) — the user confirms or overrides every column in PipelineColumnMapper.jsx before
 * anything is normalized. buildNormalizedPipelineRows turns the confirmed mapping into the same row
 * shape ReportingAnalyzer's existing review table/pendingRows already expects.
 *
 * CANONICAL METRICS: per Mo, the mapping targets are deliberately just the absolute funnel
 * numbers (spend, leads, mqls, sals, sqls, closed_won, closed_lost, pipeline_value, revenue) —
 * "We can calculate all of the cost per metrics as well as the conversion rate metrics from the
 * absolute values. We don't need to import those." Cost-per/conversion-rate metrics are never a
 * mapping target here; they're computed FROM these absolutes elsewhere (reportingMetrics.js's
 * DERIVED_PIPELINE_METRICS/computeDerivedPipelineMetrics, consumed by the Reporting Intelligence
 * breakdown) rather than expected to already exist as CSV columns. Keeping them out of the mapping
 * step also sidesteps the "metric rollup correctness" trap entirely on the import side — nothing
 * rate-shaped ever gets stored as if it were a summable count.
 *
 * STRUCTURAL FIELDS (2026-08-03, per Mo — "make the pipeline tagger... identical to the campaign
 * tagger", which has a two-level Campaign/Ad Group identity plus a Platform field): reporting_facts
 * only has ONE flat `campaign_name` column (see this table's own doc comment in the last session's
 * handoff) — no schema migration was in scope here, since core.reporting_facts is owned by a
 * separate shared repo ("paidhq-core" per this file's sibling doc comments), not this one. Ad
 * Group/Ad Set Name and Channel are instead stored as two RESERVED keys inside the existing `tags`
 * jsonb blob (AD_GROUP_TAG_KEY/CHANNEL_TAG_KEY below) — deliberately not plain "Ad Group" / "Channel"
 * strings, so they can never collide with a real user-created tag_dims entry of the same name. The
 * tags API route doesn't validate keys against tag_dims (see reporting-facts.js's POST doc comment),
 * so this is safe; dimension-values.js's tagDims list is seeded ONLY from workspace_config.tag_dims,
 * so these reserved keys never leak into the regular tag-dimension UI even though they ride in the
 * same jsonb column.
 */
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { parseMoney } from "./core.js";
import { normalizePeriodStart } from "./reportingPeriods.js";

// The only mapping targets a CSV column can become besides "ignore" / a structural field / a tag
// dimension — see this file's top doc comment for why cost-per/rate metrics are deliberately absent.
//
// The six after Leads (2026-08-06, per Mo — "add MQA, Handraiser, Demo, Free Trial, PQL, Meeting
// Booked to the fields ... so the user can pick the one he/she wants to use") are optional
// intermediate funnel stages some workspaces track between Leads and MQLs/SALs and some don't — they
// show up as ordinary selectable/mappable metrics everywhere PIPELINE_METRIC_MAP_OPTIONS already
// drives that (Pipeline Tagger's column picker in ReportingFactsTagger.jsx, Reporting Intelligence's
// metric picker in PipelineTagger.jsx, and this file's own column-mapping dropdown/unmapped-metrics
// banner), with no obligation to use any of them — a workspace that doesn't track Handraisers just
// never maps a column to it and it never appears with data. No derived cost-per/conversion-rate
// metric was added for these (unlike Lead/MQL/SQL) since Mo didn't ask for one and there's no fixed
// "stage order" across workspaces to safely assume a rate between them and an adjacent stage.
export const PIPELINE_METRIC_MAP_OPTIONS = [
  { key: "spend", label: "Spend" },
  { key: "leads", label: "Leads" },
  { key: "mqas", label: "MQAs" },
  { key: "handraisers", label: "Handraisers" },
  { key: "demos", label: "Demos" },
  { key: "free_trials", label: "Free Trials" },
  { key: "pqls", label: "PQLs" },
  { key: "meetings_booked", label: "Meetings Booked" },
  { key: "mqls", label: "MQLs" },
  { key: "sals", label: "SALs" },
  { key: "sqls", label: "SQLs" },
  { key: "closed_won", label: "Closed Won" },
  { key: "closed_lost", label: "Closed Lost" },
  { key: "pipeline_value", label: "Pipeline Value" },
  { key: "revenue", label: "Revenue" },
];

// Goal-flavored mirror of the list above (2026-08-19, per Mo — a goals import that reused
// PipelineColumnMapper's PIPELINE_METRIC_MAP_OPTIONS unchanged let a "goal" number get mapped under
// the exact same key ("mqls", "pipeline_value", ...) real pipeline PERFORMANCE data uses — meaning a
// goal and an actual could silently sum together anywhere downstream that isn't careful to filter by
// source. Every key here gets a "_goal" suffix (mqls -> mqls_goal, pipeline_value ->
// pipeline_value_goal, etc.) so a goal number can never collide with — or accidentally get summed
// into — the real performance metric it's a target FOR. isMoneyMetric (reportingMetrics.js) already
// generalizes to these via a substring regex (matches "pipeline"/"spend"/"revenue" wherever they
// appear in a key), so $ formatting for e.g. pipeline_value_goal works with no changes there.
export const GOAL_METRIC_MAP_OPTIONS = PIPELINE_METRIC_MAP_OPTIONS.map(({ key, label }) => ({
  key: `${key}_goal`,
  label: `${label} Goal`,
}));

// Reserved tags keys for the two structural (non-metric, non-user-dimension) fields Campaign Tagger
// has that reporting_facts doesn't have real columns for — see this file's top doc comment.
export const AD_GROUP_TAG_KEY = "__pipeline_ad_group";
export const CHANNEL_TAG_KEY = "__pipeline_channel";

// Goals vs. pipeline live in the SAME core.reporting_facts table (see GoalsObjectives.jsx's own
// STORAGE doc note) — the only thing distinguishing a row is whether its `source` starts with this
// prefix. Centralized here (2026-08-19, per Mo's goals-import build) as the ONE place both source-
// filter predicates are defined, rather than each of ReportingAnalyzer.jsx/GoalsObjectives.jsx
// re-deriving its own "startsWith" check and risking the two definitions drifting apart. Both
// predicates are plain top-level functions (not created inline in JSX/useCallback) specifically so
// they're stable references forever — ReportingFactsTagger.jsx's refresh() depends on whichever one
// a caller passes, and a fresh function identity on every render would re-trigger that effect and
// silently refetch on every render.
export const GOALS_SOURCE_PREFIX = "goals";
export const isGoalsSource = (source) => (source || "").startsWith(GOALS_SOURCE_PREFIX);
export const isPipelineSource = (source) => !isGoalsSource(source);

// Mapping targets "campaign" | "adgroup" | "channel" (as opposed to "ignore", `tag::${dim}`, or
// `metric::${key}`) — driven from one array so PipelineColumnMapper.jsx's dropdown and this file's
// guessing logic can't drift out of sync with each other.
export const PIPELINE_STRUCTURAL_FIELD_OPTIONS = [
  { value: "campaign", label: "Campaign Name" },
  { value: "adgroup", label: "Ad Group / Ad Set Name" },
  { value: "channel", label: "Channel" },
];

// Strips common unit/currency NOISE punctuation before collapsing whitespace (2026-08-05, per Mo —
// "pipeline value still isn't coming in ... blank everywhere"): a real-world export header like
// "Pipeline ($)" or "Total Pipeline Value:" used to normalize to "pipeline ($)" / "total pipeline
// value:" — neither matches any alias below verbatim, so the column silently stayed on "Ignore"
// unless the user happened to notice and fix that one dropdown by hand. Parentheses/$/#/: are
// stripped outright (not just the underscore/hyphen -> space swap this already did) so "Pipeline
// ($)" -> "pipeline" and "Total Pipeline Value:" -> "total pipeline value", both of which now match.
function normalizeHeader(h) {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[()$#:]/g, " ")
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Exact-match aliases only (deliberately not fuzzy/substring — see this file's top doc comment on
// why a wrong auto-guess is worse than leaving a column on "Ignore" for the user to set by hand).
// A couple of plausible Salesforce/PowerBI/HockeyStack variants are included per column, but this
// isn't meant to be exhaustive — it's a head start, not the whole mapping step. See
// PipelineColumnMapper.jsx's "not mapped" banner for the actual safety net when a header doesn't
// match anything here — it surfaces every canonical metric that didn't get a column BEFORE import,
// instead of a miss silently showing up as "blank everywhere" after the fact.
const CAMPAIGN_ALIASES = ["campaign name", "campaign", "opportunity name", "opportunity", "deal name", "account name"];
const ADGROUP_ALIASES = ["ad group", "ad set", "ad group name", "ad set name", "adset", "adset name", "adgroup name"];
const CHANNEL_ALIASES = ["channel", "platform", "marketing channel", "source channel", "medium"];
const METRIC_ALIASES = {
  spend: ["spend", "total spend", "ad spend", "cost", "total cost", "media spend"],
  leads: ["leads", "total leads", "lead count", "new leads", "inquiries", "inquiry"],
  mqas: ["mqa", "mqas", "marketing qualified accounts", "marketing qualified account"],
  handraisers: ["handraiser", "handraisers", "hand raiser", "hand raisers", "hand raise"],
  demos: ["demo", "demos", "demo requests", "demo request", "demos scheduled", "demos completed"],
  free_trials: ["free trial", "free trials", "trial", "trials", "trial signups", "trial signup"],
  pqls: ["pql", "pqls", "product qualified leads", "product qualified lead"],
  meetings_booked: ["meeting booked", "meetings booked", "meeting", "meetings", "booked meetings", "booked meeting"],
  mqls: ["mqls", "mql", "marketing qualified leads", "marketing qualified lead"],
  sals: ["sals", "sal", "sales accepted leads", "sales accepted lead"],
  sqls: ["sqls", "sql", "sales qualified leads", "sales qualified lead"],
  closed_won: ["closed won", "won", "wins", "deals won", "closed won opportunities"],
  closed_lost: ["closed lost", "lost", "losses", "deals lost"],
  pipeline_value: ["pipeline value", "pipeline", "open pipeline", "total pipeline", "pipeline amount", "pipeline $", "total pipeline value", "open pipeline value", "pipeline value $", "sql pipeline", "sql pipeline value", "pipeline $ value"],
  revenue: ["revenue", "closed revenue", "won revenue", "total revenue", "bookings", "closed won revenue"],
};

// Returns one of "ignore" | "campaign" | "adgroup" | "channel" | `tag::${dimName}` |
// `metric::${key}` for a single raw header — see guessColumnMapping below for the array-of-headers
// version this backs. Structural fields are checked before tag dimensions so a workspace that
// happens to have created a tag dimension literally named "Channel" still gets the dedicated
// structural handling (with its own platform dropdown) rather than being treated as a generic tag.
function guessOneColumn(header, tagDims, metricKeySuffix) {
  const n = normalizeHeader(header);
  if (CAMPAIGN_ALIASES.includes(n)) return "campaign";
  if (ADGROUP_ALIASES.includes(n)) return "adgroup";
  if (CHANNEL_ALIASES.includes(n)) return "channel";
  for (const dim of tagDims || []) {
    if (normalizeHeader(dim) === n) return `tag::${dim}`;
  }
  for (const [key, aliases] of Object.entries(METRIC_ALIASES)) {
    if (aliases.includes(n)) return `metric::${key}${metricKeySuffix || ""}`;
  }
  return "ignore";
}

// PERIOD-AT-IMPORT (2026-08-03, per Mo — "look for/auto detect a period field. If none is found,
// allow the user to specify what year and month OR what year and quarter... In the actual data rows
// (the campaign rows), there should be no date field"): unlike reportingImport.js's old campaign
// export (which always landed as periodType "unknown" for a per-row picker), a pipeline CSV/XLSX now
// resolves to exactly ONE period for the WHOLE file — either detected here, or picked once by the
// user in PipelineColumnMapper.jsx — applied to every row. day/week grains are deliberately never
// produced here (only "month"/"quarter"), per Mo: "we don't accept weekly or daily."
const PERIOD_COLUMN_ALIASES = ["date", "month", "period", "reporting period", "reporting month", "period start", "fiscal month", "fiscal quarter", "quarter", "month/year", "report month", "report date", "reporting date"];

// "Q1 2026" / "2026 Q1" style labels — common in quarter-grain CRM/BI exports — don't parse as a
// real date at all, so they get their own regex pass before falling back to normalizePeriodStart.
const QUARTER_LABEL_RE = /^q\s*([1-4])[\s,./-]+(\d{4})$|^(\d{4})[\s,./-]+q\s*([1-4])$/i;
function parseQuarterLabel(v) {
  const m = QUARTER_LABEL_RE.exec(String(v ?? "").trim());
  if (!m) return null;
  const q = Number(m[1] || m[4]);
  const year = Number(m[2] || m[3]);
  if (!q || !year) return null;
  return `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
}

// headers/rows: parsePipelineFileRaw's output. Finds a period-looking column by EXACT alias match
// (same "don't guess, ask" philosophy as guessColumnMapping — a wrongly-detected period silently
// mis-dates every row in the batch, worse than one extra click to confirm manually) and checks
// whether every non-blank value in it collapses to the SAME single month or the same single
// quarter — i.e. this file represents one reporting period as a whole, the only shape this import
// path supports. Returns { periodType, periodStart } when a single consistent period is found
// (month checked before quarter, since it's the more specific/informative grain), else null — the
// caller falls back to asking the user to pick one manually.
export function detectImportPeriod(headers, rows) {
  const colIdx = (headers || []).findIndex((h) => PERIOD_COLUMN_ALIASES.includes(normalizeHeader(h)));
  if (colIdx === -1) return null;
  const values = (rows || []).map((r) => r[colIdx]).filter((v) => String(v ?? "").trim() !== "");
  if (!values.length) return null;

  const quarterLabels = values.map(parseQuarterLabel);
  if (quarterLabels.every(Boolean)) {
    const uniq = new Set(quarterLabels);
    if (uniq.size === 1) return { periodType: "quarter", periodStart: quarterLabels[0] };
  }

  const monthStarts = values.map((v) => normalizePeriodStart("month", v)).filter(Boolean);
  if (monthStarts.length === values.length && new Set(monthStarts).size === 1) {
    return { periodType: "month", periodStart: monthStarts[0] };
  }
  const quarterStarts = values.map((v) => normalizePeriodStart("quarter", v)).filter(Boolean);
  if (quarterStarts.length === values.length && new Set(quarterStarts).size === 1) {
    return { periodType: "quarter", periodStart: quarterStarts[0] };
  }
  return null;
}

// Bare month name/abbreviation -> 1-12 (2026-08-19, per Mo's goals-file-shape follow-up — a real
// file had one row per Product with 12 separate MONTH COLUMNS per metric, e.g. "January".."December",
// rather than one row per period). Deliberately narrow: matches ONLY a bare month name/abbreviation,
// nothing combined with a year ("Jan-26", "January 2026") and nothing quarter/grand-total shaped
// ("Q1 Total", "Total") — see detectMonthColumn's own doc comment for why those stay unmapped/manual
// rather than auto-detected.
const MONTH_NAME_TO_NUM = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// Recognizes a column header that IS a bare month name/abbreviation — used by PipelineColumnMapper.jsx
// to unpivot "wide" files (one column per month) into one dated row per month instead of folding
// every mapped metric column into the single whole-file period from the Reporting Period section.
// Returns 1-12 or null. Deliberately does NOT match "Q1 Total"/"Total"/"Jan-26"-style headers — a
// quarter-total or grand-total column sitting alongside its own underlying month columns would
// double-count if BOTH got auto-mapped to the same metric; keeping those un-auto-detected means a
// user has to consciously choose to map one or the other, not both, rather than the tool silently
// deciding for them.
export function detectMonthColumn(header) {
  const n = normalizeHeader(header);
  return MONTH_NAME_TO_NUM[n] || null;
}

// headers: raw header strings in column order. tagDims: this workspace's current tag dimension
// names (Product, Region, etc. — same vocabulary as Campaign Tagger, see dimension-values.js),
// offered as mapping targets so e.g. a Salesforce "Product Line" column can map straight to the
// "Product" tag dimension instead of tagging every row by hand afterward in Pipeline Tagger.
// metricKeySuffix (2026-08-19, per the goals-import metric-vocabulary fix — see
// GOAL_METRIC_MAP_OPTIONS's own doc note): appended to every guessed metric:: key, e.g. "_goal" when
// guessing against GoalsObjectives' own metric list instead of pipeline's, so an alias match still
// resolves to a real option in whichever list the caller is actually offering. Defaults to "" —
// unchanged behavior for every existing (pipeline) call site.
// Returns an array aligned to `headers` (index, not header text, is the identity — see the doc
// comment on why below in parsePipelineFileRaw).
export function guessColumnMapping(headers, tagDims = [], metricKeySuffix = "") {
  return (headers || []).map((h) => guessOneColumn(h, tagDims, metricKeySuffix));
}

// A header row candidate is the first row with at least 2 non-blank cells — cheap enough to
// sidestep a single-cell report title row above the real header (seen in real PowerBI exports),
// without trying to be a general-purpose "detect the header row" solver. Not foolproof for
// unusually-shaped exports, but the mapping step below lets the user see exactly what got
// interpreted as headers/data before confirming anything, so a wrong guess here is visible and
// recoverable rather than silently wrong.
function findHeaderRowIdx(rows) {
  for (let i = 0; i < (rows || []).length; i++) {
    const nonBlank = (rows[i] || []).filter((c) => String(c ?? "").trim() !== "");
    if (nonBlank.length >= 2) return i;
  }
  return -1;
}

// file: a File from an <input type="file"> or drop handler. Resolves to { headers: string[],
// rows: Array<Array<string|number>> } — EVERY data row below the detected header row, in the file's
// own column order, no row dropped for lacking a recognized column and no column dropped for not
// matching a known alias (per Mo: "I want all of the rows to come into the pipeline tagger"). Rows
// are indexed by column position (not header text) throughout this module — real exports sometimes
// repeat a header (two "Amount" columns meaning different things), and keying by text would silently
// collapse those into one.
//
// XLSX reads with raw:true (not core.js's own parseFileToRows, which uses raw:false) — same
// display-vs-stored-value bug reportingImport.js's readRowsRaw doc comment describes for the
// campaign-level export (a cell holding 242.126 can render as "24213%" if it carries stray percent
// formatting); raw:true returns the actual stored number and sidesteps it. blankrows:false /
// skipEmptyLines:true both drop genuinely empty rows (a blank spacer line isn't a data row to bring
// in) without touching rows that have real content in even one cell.
export function parsePipelineFileRaw(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split(".").pop().toLowerCase();
    const finish = (rawRows) => {
      try {
        const headerRowIdx = findHeaderRowIdx(rawRows);
        if (headerRowIdx === -1) throw new Error("Couldn't find a header row in this file.");
        const headerRow = rawRows[headerRowIdx];
        const headers = headerRow.map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`);
        const rows = rawRows
          .slice(headerRowIdx + 1)
          .filter((r) => (r || []).some((c) => String(c ?? "").trim() !== ""))
          .map((r) => headers.map((_, i) => (r[i] === undefined ? "" : r[i])));
        if (!rows.length) throw new Error("No data rows found below the header row.");
        resolve({ headers, rows });
      } catch (err) {
        reject(err);
      }
    };
    if (ext === "csv") {
      Papa.parse(file, { header: false, skipEmptyLines: true, complete: (r) => finish(r.data) });
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          finish(XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true, blankrows: false }));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    }
  });
}

// Any confirmed target used on more than one column is ambiguous (two columns both claiming to be
// "Spend," or both claiming the "Campaign Name" identity) — the caller should block confirming until
// this comes back empty rather than silently picking one. Returns the list of duplicated targets.
export function findDuplicateMappingTargets(mapping) {
  const seen = new Set();
  const dupes = new Set();
  Object.values(mapping || {}).forEach((target) => {
    if (!target || target === "ignore") return;
    if (seen.has(target)) dupes.add(target);
    seen.add(target);
  });
  return Array.from(dupes);
}

// headers/rows: parsePipelineFileRaw's output. mapping: { [headerIndex]: target } using the same
// "ignore" | "campaign" | "adgroup" | "channel" | `tag::${dim}` | `metric::${key}` encoding
// guessColumnMapping produces. sourceLabel: this batch's reporting_facts `source` value.
// resolvedPeriod: { periodType, periodStart } — either detectImportPeriod's result or the user's
// manual Year+Month/Year+Quarter pick from PipelineColumnMapper.jsx; applied to EVERY row (this
// import path only ever supports one period per file — see detectImportPeriod's doc comment). Falls
// back to periodType "unknown" only if a caller genuinely doesn't have one yet.
//
// hardcodedChannel (2026-08-05, per Mo — "I'm going to start bringing the data in channel by channel
// ... I would like a hard coded channel field that is hard coded when the data is imported so I know
// that that row came in as that particular channel"): when set, OVERRIDES whatever a "channel"-mapped
// column would have produced for every row in this file, rather than trusting the campaign-naming
// convention (Mo's own example: a Bing export with campaigns still prefixed "SEA-" because they were
// duplicated from Google, and a Google export with campaigns prefixed "BIN-" for the same reason —
// neither the campaign name nor a "Channel" column in the source system can be trusted here, but Mo
// importing one channel's file at a time can just say so directly). Left undefined/"" this behaves
// exactly as before (whatever the "channel" column mapping produces, if any).
//
// columnPeriods (2026-08-19, per Mo's goals-file-shape follow-up — see detectMonthColumn's doc
// comment): { [headerIndex]: {periodType,periodStart} } for any column whose header PipelineColumnMapper
// detected as a bare month name — computed there (it's the one place that knows the user's chosen
// year to pair with each column's own month). A metric:: column with an entry here contributes its
// value to a row dated by THAT column's own period instead of the file's single resolvedPeriod; every
// other metric:: column (and every file with no wide columns at all — the historical case) still
// falls into one shared "default" bucket dated by resolvedPeriod, exactly as before. Structural
// fields (campaign/adgroup/channel/tag::) don't vary by period, so they're copied onto every output
// row this source row produces, however many buckets it ends up fanning out into.
//
// Returns the same per-row shape ReportingAnalyzer's AI-extraction path already normalizes into
// (source, periodType, periodStart, campaignName, tags, metrics) — now possibly SEVERAL rows per
// input row (one per distinct period bucket that got at least one metric value) instead of always
// exactly one. A column mapped to a metric only sets that key when parseMoney succeeds — a blank/
// non-numeric cell just leaves the key absent rather than writing a false 0, consistent with how a
// missing field is already handled elsewhere (deriveMetricColumns/fmtMetric render an absent key as
// "—", not 0). A source row with no metric value at all (every mapped metric column blank, or every
// column "Ignore") still produces exactly one output row under the default period, preserving the
// existing "every row in the file comes in" guarantee.
export function buildNormalizedPipelineRows({ headers, rows }, mapping, sourceLabel, resolvedPeriod, hardcodedChannel, columnPeriods) {
  const defaultPeriodType = resolvedPeriod?.periodType || "unknown";
  const defaultPeriodStart = resolvedPeriod?.periodStart;
  return (rows || []).flatMap((row) => {
    let campaignName = "";
    const tags = {};
    // Keyed by periodStart (or a sentinel for the no-period-detected default bucket) -> that
    // bucket's own {periodType, periodStart, metrics}.
    const buckets = new Map();
    const bucketFor = (periodType, periodStart) => {
      const key = periodStart || "__default__";
      if (!buckets.has(key)) buckets.set(key, { periodType, periodStart, metrics: {} });
      return buckets.get(key);
    };

    (headers || []).forEach((_, i) => {
      const target = mapping[i];
      if (!target || target === "ignore") return;
      const raw = row[i];
      if (target === "campaign") {
        if (!campaignName) campaignName = String(raw ?? "").trim();
        return;
      }
      if (target === "adgroup") {
        const v = String(raw ?? "").trim();
        if (v) tags[AD_GROUP_TAG_KEY] = v;
        return;
      }
      if (target === "channel") {
        const v = String(raw ?? "").trim();
        if (v) tags[CHANNEL_TAG_KEY] = v;
        return;
      }
      if (target.startsWith("tag::")) {
        const dim = target.slice(5);
        const v = String(raw ?? "").trim();
        if (v) tags[dim] = v;
        return;
      }
      if (target.startsWith("metric::")) {
        const key = target.slice(8);
        const n = parseMoney(raw);
        if (n === null) return;
        const colPeriod = columnPeriods?.[i];
        const bucket = colPeriod ? bucketFor(colPeriod.periodType, colPeriod.periodStart) : bucketFor(defaultPeriodType, defaultPeriodStart);
        bucket.metrics[key] = n;
      }
    });
    if (hardcodedChannel) tags[CHANNEL_TAG_KEY] = hardcodedChannel;

    if (buckets.size === 0) {
      return [{ source: sourceLabel, periodType: defaultPeriodType, periodStart: defaultPeriodStart, campaignName, tags, metrics: {} }];
    }
    return Array.from(buckets.values()).map((b) => ({
      source: sourceLabel, periodType: b.periodType, periodStart: b.periodStart, campaignName, tags: { ...tags }, metrics: b.metrics,
    }));
  });
}
