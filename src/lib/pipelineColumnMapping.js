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

// GOALS_STRUCTURAL_FIELD_OPTIONS (2026-08-19, per Mo — "once the user selects 'goals' as the import
// type, it should be a different import UX and process than the pipeline performance import"):
// pipeline's structural targets assume ad-platform concepts (Ad Group/Ad Set, Channel) that don't
// apply to a goals/targets file — Mo's actual file is one row per PRODUCT, not per campaign/ad group,
// and has no per-row channel at all. Reuses the same "campaign" mapping-target VALUE (buildNormalized
// PipelineRows already just stores whatever's mapped to it as campaignName, regardless of what the
// dropdown option is labeled) so no data-model change is needed — only the label users see differs,
// plus Ad Group/Channel are dropped from the dropdown entirely for goals imports.
//
// "period" (2026-08-19, per Mo — "month and/or quarter headers (could be horizontal or vertical)"):
// a VERTICAL goals file has one row per (dimension, period) pair with a single column whose value
// (e.g. "January", "Q1 2026", "2026-03") varies row to row, rather than one column per month/quarter
// (the horizontal/wide shape detectMonthColumn/detectQuarterColumn already unpivot). Mapping a column
// to "period" tells buildNormalizedPipelineRows to date each row from THAT row's own cell instead of
// the single whole-file Reporting Period fallback — see buildNormalizedPipelineRows' own doc comment
// for exactly how a row's own period wins over the fallback. Pipeline import never offers this target
// (PIPELINE_STRUCTURAL_FIELD_OPTIONS doesn't include it) since pipeline files are deliberately still
// one-period-per-file, per this file's top doc comment.
export const GOALS_STRUCTURAL_FIELD_OPTIONS = [
  { value: "campaign", label: "Product / Item Name" },
  { value: "period", label: "Month / Quarter (varies per row)" },
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
// "product"/"item" variants added 2026-08-19 for goals imports (GOALS_STRUCTURAL_FIELD_OPTIONS reuses
// this same "campaign" target under the label "Product / Item Name" — a goals file's primary
// identifier is usually a product/item, not a campaign; buildNormalizedPipelineRows already just
// stores whatever's mapped here as campaignName regardless of what it semantically represents).
const CAMPAIGN_ALIASES = ["campaign name", "campaign", "opportunity name", "opportunity", "deal name", "account name", "product", "product name", "item", "item name"];
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

// Returns one of "ignore" | "campaign" | "adgroup" | "channel" | "period" | `tag::${dimName}` |
// `metric::${key}` for a single raw header — see guessColumnMapping below for the array-of-headers
// version this backs. Structural fields are checked before tag dimensions so a workspace that
// happens to have created a tag dimension literally named "Channel" still gets the dedicated
// structural handling (with its own platform dropdown) rather than being treated as a generic tag.
//
// structuralFieldValues (2026-08-19, per Mo's goals-import UX split): which structural targets are
// actually offered by the CALLER's dropdown (PIPELINE_STRUCTURAL_FIELD_OPTIONS' values by default,
// or GOALS_STRUCTURAL_FIELD_OPTIONS' values for a goals import — see PipelineColumnMapper.jsx's
// structuralFieldOptions prop). Guessing a target the caller isn't actually offering would set
// mapping[i] to a value with no matching <option>, leaving that column's dropdown showing nothing
// selected — so every alias check below is gated on whether its target is in this list. "period"
// (a per-ROW month/quarter column — vertical-layout goals files, as opposed to the wide/horizontal
// month-COLUMN layout detectMonthColumn handles) only ever appears in GOALS_STRUCTURAL_FIELD_OPTIONS.
function guessOneColumn(header, tagDims, metricKeySuffix, structuralFieldValues) {
  const n = normalizeHeader(header);
  const allowed = structuralFieldValues || ["campaign", "adgroup", "channel"];
  if (allowed.includes("campaign") && CAMPAIGN_ALIASES.includes(n)) return "campaign";
  if (allowed.includes("adgroup") && ADGROUP_ALIASES.includes(n)) return "adgroup";
  if (allowed.includes("channel") && CHANNEL_ALIASES.includes(n)) return "channel";
  if (allowed.includes("period") && PERIOD_COLUMN_ALIASES.includes(n)) return "period";
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
//
// Trailing-token fallback (2026-08-19, per Mo's actual file — a two-row-header export where a group
// title like "Paid Media MQLs" sits above a block of month columns; see resolveHeaderRows' own doc
// comment for why that gets merged into ONE header per column, e.g. "Paid Media MQLs January"): after
// a merge, the bare month name is no longer the WHOLE header, just its last word. Checking the last
// token keeps this still narrow — "Jan-26"'s last token is "26" (not a month), "January 2026"'s last
// token is "2026" (not a month), "Q1 Total"'s last token is "total" (not a month) — so none of those
// deliberately-excluded shapes start matching just because this fallback was added.
export function detectMonthColumn(header) {
  const n = normalizeHeader(header);
  if (MONTH_NAME_TO_NUM[n]) return MONTH_NAME_TO_NUM[n];
  const tokens = n.split(" ");
  const last = tokens[tokens.length - 1];
  return (tokens.length > 1 && MONTH_NAME_TO_NUM[last]) || null;
}

// Bare quarter label ("Q1", "Quarter 1", "Qtr 2") -> 1-4 (2026-08-19, per Mo — goals headers can be
// quarterly instead of/alongside monthly, e.g. a file with only Q1-Q4 columns and no month columns at
// all). Mirrors detectMonthColumn's own deliberately narrow matching for exactly the same reason:
// "Q1 Total"/"Q1 2026" (year- or total-combined) must NOT match, or a quarter-total column sitting
// next to its own underlying month columns could double-count if both get mapped to the same metric.
const QUARTER_BARE_RE = /^q(?:uarter|tr)?\s*([1-4])$/;
export function detectQuarterColumn(header) {
  const n = normalizeHeader(header);
  const direct = QUARTER_BARE_RE.exec(n);
  if (direct) return Number(direct[1]);
  const tokens = n.split(" ");
  if (tokens.length > 1) {
    const last = QUARTER_BARE_RE.exec(tokens[tokens.length - 1]);
    if (last) return Number(last[1]);
  }
  return null;
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
// structuralFieldValues (2026-08-19, per Mo's goals-import UX split): see guessOneColumn's own doc
// comment — which structural targets ("campaign"/"adgroup"/"channel"/"period") are actually valid to
// guess, since the caller's dropdown might not offer all of them.
// Returns an array aligned to `headers` (index, not header text, is the identity — see the doc
// comment on why below in parsePipelineFileRaw).
export function guessColumnMapping(headers, tagDims = [], metricKeySuffix = "", structuralFieldValues) {
  return (headers || []).map((h) => guessOneColumn(h, tagDims, metricKeySuffix, structuralFieldValues));
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

function nonBlankCount(row) {
  return (row || []).filter((c) => String(c ?? "").trim() !== "").length;
}

// A row "looks like data" when most of its non-blank cells parse as numbers — the practical signal
// that separates an actual value row from a text-labeled header row.
function isDataish(row) {
  const cells = (row || []).filter((c) => String(c ?? "").trim() !== "");
  if (!cells.length) return false;
  const numeric = cells.filter((c) => String(c).trim() !== "" && !Number.isNaN(Number(String(c).replace(/[,$%]/g, "").trim())));
  return numeric.length / cells.length >= 0.6;
}

// TWO-ROW / MERGED-CELL HEADERS (2026-08-19, per Mo's actual goals file — a real PowerBI/Excel-style
// export where row 1 has a FEW sparse group-title cells ("Paid Media MQLs" merged across a block of
// month columns, "Marketing Pipeline" merged across another), and the real per-column names (BU,
// Product Pillar, Product, January, February, ..., Total) live in row 2. findHeaderRowIdx's ">=2
// non-blank cells" rule picked row 1 (it has exactly 2 non-blank cells — the two group titles), so
// almost every column fell back to "Column N" and the real "January"/"BU"/etc. labels were read as
// the FIRST DATA ROW instead — nothing downstream (metric guessing, month detection, period
// detection) had a chance, hence the "why am I being asked for a channel/month" confusion: nothing
// mapped, so the mapper fell all the way back to manual everything.
//
// resolveHeaderRows detects this specific shape and merges the two rows into one real header per
// column, rather than trying to be a general N-row-header solver: starting from findHeaderRowIdx's
// own candidate (call it i0), if the row immediately below (i0+1) is BOTH more densely populated than
// i0 AND itself looks header-like (mostly text, not numbers), AND the row after THAT (i0+2, the
// presumed first real data row) looks data-like (mostly numbers) — three independent signals, not
// one — then i0 is treated as a sparse group-title overlay rather than the real header.
//
// Only DUPLICATED column labels get the group prefix, not every column the group cell happens to
// visually span. This matters because a real merged group cell (e.g. C1:O1 to make a nice title bar
// in Excel) can visually overlap a structural column too — Mo's actual file had "Paid Media MQLs"
// merged starting at the SAME column as "Product" (the merge was cosmetic, spanning Product's column
// plus all its month columns), not starting at the first month column. Forward-filling the group
// value onto every column under it would rename "Product" itself to "Paid Media MQLs Product",
// breaking guessOneColumn's exact-alias match for the one column that most needs to resolve cleanly.
// Prefixing only labels that collide (both "January" columns, both "Q1 Total" columns, ...) fixes the
// actual ambiguity — telling the two identical month columns apart — without touching any column
// whose plain label is already unique. detectMonthColumn's trailing-token fallback (added alongside
// this) still recognizes "Paid Media MQLs January" as month 1 despite the prefix.
//
// Any of the three overlay signals failing (no i0+1, i0+1 isn't text-majority, i0+1 isn't denser than
// i0, or there's no i0+2 to confirm data starts there) falls straight back to the original
// single-header-row behavior — every ordinary single-header file (nearly everything imported into
// PaidHQ so far) is completely unaffected.
export function resolveHeaderRows(rows) {
  const i0 = findHeaderRowIdx(rows);
  if (i0 === -1) return null;
  const groupRow = rows[i0];
  const headerRow = rows[i0 + 1];
  const firstDataRow = rows[i0 + 2];
  const looksLikeGroupOverlay =
    headerRow &&
    firstDataRow &&
    nonBlankCount(headerRow) > nonBlankCount(groupRow) &&
    !isDataish(headerRow) &&
    isDataish(firstDataRow);
  if (!looksLikeGroupOverlay) {
    return { headers: (rows[i0] || []).map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`), dataStartIdx: i0 + 1 };
  }

  const plainLabels = headerRow.map((h) => String(h ?? "").trim());
  const labelCounts = new Map();
  plainLabels.forEach((label) => {
    if (!label) return;
    labelCounts.set(normalizeHeader(label), (labelCounts.get(normalizeHeader(label)) || 0) + 1);
  });

  let lastGroup = "";
  const headers = plainLabels.map((label, i) => {
    const g = String((groupRow || [])[i] ?? "").trim();
    if (g) lastGroup = g;
    if (!label) return `Column ${i + 1}`;
    const isDuplicate = (labelCounts.get(normalizeHeader(label)) || 0) > 1;
    return isDuplicate && lastGroup ? `${lastGroup} ${label}` : label;
  });
  return { headers, dataStartIdx: i0 + 2 };
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
        const resolved = resolveHeaderRows(rawRows);
        if (!resolved) throw new Error("Couldn't find a header row in this file.");
        const { headers, dataStartIdx } = resolved;
        const rows = rawRows
          .slice(dataStartIdx)
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

// TOTAL/SUMMARY ROWS (2026-08-19, per Mo — "we need to ignore total rows or columns"): a goals (or
// pipeline) file commonly has a trailing "Total"/"Grand Total" row summing every dimension value,
// which must never get imported as if it were a real product/region/etc — it would silently inflate
// whatever period it lands in. Checked against every column mapped to "campaign" or a tag:: dimension
// (not just the first column), since some exports put "Total" in an earlier dimension column (e.g.
// "BU") rather than the primary identifier. Total COLUMNS ("Q1 Total", grand "Total") are handled
// separately, at detection time — see detectMonthColumn/detectQuarterColumn's own doc comments for
// why those headers are deliberately never auto-mapped to a period in the first place.
const TOTAL_ROW_LABELS = new Set(["total", "totals", "grand total", "sub total", "subtotal", "overall total"]);
function isTotalLabel(v) {
  return TOTAL_ROW_LABELS.has(normalizeHeader(String(v ?? "")));
}
// Exported so PipelineColumnMapper.jsx can surface a "N rows will be skipped" count in the UI before
// the user confirms, using the exact same rule buildNormalizedPipelineRows uses to actually skip them.
// Checks "campaign"/tag:: dimension columns (a "Total" row often has "Total"/"Grand Total" as its
// Product/BU/etc. value) AND a "period" column (a VERTICAL file's summary row often has "Total"/
// "Grand Total" in the same column that otherwise holds "January"/"Q1"/etc. — see GOALS_STRUCTURAL_
// FIELD_OPTIONS' "period" target).
export function isTotalRow(headers, row, mapping) {
  return (headers || []).some((_, i) => {
    const target = mapping[i];
    if (target !== "campaign" && target !== "period" && !(target || "").startsWith("tag::")) return false;
    return isTotalLabel(row[i]);
  });
}

// Parses a single VERTICAL "period" column cell (2026-08-19, per Mo — "month and/or quarter headers
// ... could be horizontal or vertical") into { periodType, periodStart }, or null if unparseable.
// Tries, in order: a "Q1 2026"/"2026 Q1" quarter label (parseQuarterLabel), then a real date-ish value
// via normalizePeriodStart (handles "2026-03-01", "March 2026", "Mar-26", etc. — this is a per-row
// DATA cell, not a header, so it doesn't need detectMonthColumn's deliberately narrow bare-name-only
// matching), then a BARE quarter ("Q1") or bare month name ("January") with no year of its own, paired
// with fallbackYear (the same year picker PipelineColumnMapper.jsx already uses for wide/horizontal
// month columns) since a vertical file's period column occasionally omits the year when the whole
// file is implicitly "this year."
function parsePeriodCell(v, fallbackYear) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const q = parseQuarterLabel(s);
  if (q) return { periodType: "quarter", periodStart: q };
  const m = normalizePeriodStart("month", s);
  if (m) return { periodType: "month", periodStart: m };
  if (fallbackYear) {
    const bareQ = detectQuarterColumn(s);
    if (bareQ) return { periodType: "quarter", periodStart: normalizePeriodStart("quarter", `${fallbackYear}-${String((bareQ - 1) * 3 + 1).padStart(2, "0")}-01`) };
    const bareM = detectMonthColumn(s);
    if (bareM) return { periodType: "month", periodStart: normalizePeriodStart("month", `${fallbackYear}-${String(bareM).padStart(2, "0")}-01`) };
  }
  return null;
}

// headers/rows: parsePipelineFileRaw's output. mapping: { [headerIndex]: target } using the same
// "ignore" | "campaign" | "adgroup" | "channel" | "period" | `tag::${dim}` | `metric::${key}`
// encoding guessColumnMapping produces. sourceLabel: this batch's reporting_facts `source` value.
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
// rowPeriodYear (2026-08-19, per Mo's VERTICAL-layout follow-up): the year to pair with a "period"
// column's cell when that cell is a bare month/quarter with no year of its own — same value as
// PipelineColumnMapper.jsx's `year` state, already used identically for wide/horizontal columnPeriods.
// A column mapped to "period" gives each row ITS OWN period (parsePeriodCell), which wins over
// resolvedPeriod for every metric column that ISN'T already dated by columnPeriods (a wide-format
// month/quarter column is more specific than a per-row period column, so it keeps priority if a file
// somehow has both). A row whose period cell doesn't parse falls back to resolvedPeriod, same as if
// no period column were mapped at all.
//
// Returns the same per-row shape ReportingAnalyzer's AI-extraction path already normalizes into
// (source, periodType, periodStart, campaignName, tags, metrics) — now possibly SEVERAL rows per
// input row (one per distinct period bucket that got at least one metric value) instead of always
// exactly one. A column mapped to a metric only sets that key when parseMoney succeeds — a blank/
// non-numeric cell just leaves the key absent rather than writing a false 0, consistent with how a
// missing field is already handled elsewhere (deriveMetricColumns/fmtMetric render an absent key as
// "—", not 0). A source row with no metric value at all (every mapped metric column blank, or every
// column "Ignore") still produces exactly one output row under the default period, preserving the
// existing "every row in the file comes in" guarantee — UNLESS the row itself looks like a Total/
// Summary row (isTotalRow), in which case it's skipped entirely and contributes zero output rows.
export function buildNormalizedPipelineRows({ headers, rows }, mapping, sourceLabel, resolvedPeriod, hardcodedChannel, columnPeriods, rowPeriodYear) {
  const defaultPeriodType = resolvedPeriod?.periodType || "unknown";
  const defaultPeriodStart = resolvedPeriod?.periodStart;
  const periodColIdx = Object.keys(mapping).find((i) => mapping[i] === "period");

  return (rows || []).flatMap((row) => {
    if (isTotalRow(headers, row, mapping)) return [];

    let campaignName = "";
    const tags = {};

    // This row's own fallback period: its mapped "period" column value if one is mapped and parses,
    // else the whole-file resolvedPeriod — exactly as if no "period" column existed.
    const rowPeriod = periodColIdx !== undefined ? parsePeriodCell(row[periodColIdx], rowPeriodYear) : null;
    const rowDefaultPeriodType = rowPeriod?.periodType || defaultPeriodType;
    const rowDefaultPeriodStart = rowPeriod?.periodStart || defaultPeriodStart;

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
      if (!target || target === "ignore" || target === "period") return;
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
        const bucket = colPeriod ? bucketFor(colPeriod.periodType, colPeriod.periodStart) : bucketFor(rowDefaultPeriodType, rowDefaultPeriodStart);
        bucket.metrics[key] = n;
      }
    });
    if (hardcodedChannel) tags[CHANNEL_TAG_KEY] = hardcodedChannel;

    if (buckets.size === 0) {
      return [{ source: sourceLabel, periodType: rowDefaultPeriodType, periodStart: rowDefaultPeriodStart, campaignName, tags, metrics: {} }];
    }
    return Array.from(buckets.values()).map((b) => ({
      source: sourceLabel, periodType: b.periodType, periodStart: b.periodStart, campaignName, tags: { ...tags }, metrics: b.metrics,
    }));
  });
}
