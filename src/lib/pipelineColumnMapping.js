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
 * CANONICAL METRICS: per Mo, the mapping targets are deliberately just the 9 absolute funnel
 * numbers (spend, leads, mqls, sals, sqls, closed_won, closed_lost, pipeline_value, revenue) —
 * "We can calculate all of the cost per metrics as well as the conversion rate metrics from the
 * absolute values. We don't need to import those." Cost-per/conversion-rate metrics are never a
 * mapping target here; they're computed FROM these absolutes elsewhere (reportingMetrics.js's
 * DERIVED_PIPELINE_METRICS/computeDerivedPipelineMetrics, consumed by the Reporting Intelligence
 * breakdown) rather than expected to already exist as CSV columns. Keeping them out of the mapping
 * step also sidesteps the "metric rollup correctness" trap entirely on the import side — nothing
 * rate-shaped ever gets stored as if it were a summable count.
 */
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { parseMoney } from "./core.js";

// The only mapping targets a CSV column can become besides "ignore" / "campaign" / a tag
// dimension — see this file's top doc comment for why cost-per/rate metrics are deliberately absent.
export const PIPELINE_METRIC_MAP_OPTIONS = [
  { key: "spend", label: "Spend" },
  { key: "leads", label: "Leads" },
  { key: "mqls", label: "MQLs" },
  { key: "sals", label: "SALs" },
  { key: "sqls", label: "SQLs" },
  { key: "closed_won", label: "Closed Won" },
  { key: "closed_lost", label: "Closed Lost" },
  { key: "pipeline_value", label: "Pipeline Value" },
  { key: "revenue", label: "Revenue" },
];

function normalizeHeader(h) {
  return String(h ?? "").trim().toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ");
}

// Exact-match aliases only (deliberately not fuzzy/substring — see this file's top doc comment on
// why a wrong auto-guess is worse than leaving a column on "Ignore" for the user to set by hand).
// A couple of plausible Salesforce/PowerBI/HockeyStack variants are included per column, but this
// isn't meant to be exhaustive — it's a head start, not the whole mapping step.
const CAMPAIGN_ALIASES = ["campaign name", "campaign", "opportunity name", "opportunity", "deal name", "account name"];
const METRIC_ALIASES = {
  spend: ["spend", "total spend", "ad spend", "cost", "total cost", "media spend"],
  leads: ["leads", "total leads", "lead count", "new leads", "inquiries", "inquiry"],
  mqls: ["mqls", "mql", "marketing qualified leads", "marketing qualified lead"],
  sals: ["sals", "sal", "sales accepted leads", "sales accepted lead"],
  sqls: ["sqls", "sql", "sales qualified leads", "sales qualified lead"],
  closed_won: ["closed won", "won", "wins", "deals won", "closed won opportunities"],
  closed_lost: ["closed lost", "lost", "losses", "deals lost"],
  pipeline_value: ["pipeline value", "pipeline", "open pipeline", "total pipeline", "pipeline amount", "pipeline $"],
  revenue: ["revenue", "closed revenue", "won revenue", "total revenue", "bookings", "closed won revenue"],
};

// Returns one of "ignore" | "campaign" | `tag::${dimName}` | `metric::${key}` for a single raw
// header — see guessColumnMapping below for the array-of-headers version this backs.
function guessOneColumn(header, tagDims) {
  const n = normalizeHeader(header);
  if (CAMPAIGN_ALIASES.includes(n)) return "campaign";
  for (const dim of tagDims || []) {
    if (normalizeHeader(dim) === n) return `tag::${dim}`;
  }
  for (const [key, aliases] of Object.entries(METRIC_ALIASES)) {
    if (aliases.includes(n)) return `metric::${key}`;
  }
  return "ignore";
}

// headers: raw header strings in column order. tagDims: this workspace's current tag dimension
// names (Product, Region, etc. — same vocabulary as Campaign Tagger, see dimension-values.js),
// offered as mapping targets so e.g. a Salesforce "Product Line" column can map straight to the
// "Product" tag dimension instead of tagging every row by hand afterward in Pipeline Tagger.
// Returns an array aligned to `headers` (index, not header text, is the identity — see the doc
// comment on why below in parsePipelineFileRaw).
export function guessColumnMapping(headers, tagDims = []) {
  return (headers || []).map((h) => guessOneColumn(h, tagDims));
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
// "ignore" | "campaign" | `tag::${dim}` | `metric::${key}` encoding guessColumnMapping produces.
// sourceLabel: this batch's reporting_facts `source` value. Returns the same per-row shape
// ReportingAnalyzer's AI-extraction path already normalizes into (source, periodType, periodStart,
// campaignName, tags, metrics) — periodType is always "unknown" here (this export shape has no
// period column of its own to read), same as reportingImport.js's campaign-report rows; the review
// table's existing per-row period picker handles assigning one.
//
// A column mapped to a metric only sets that key when parseMoney succeeds — a blank/non-numeric
// cell just leaves the key absent for that row rather than writing a false 0, consistent with how a
// missing field is already handled elsewhere (deriveMetricColumns/fmtMetric render an absent key as
// "—", not 0).
export function buildNormalizedPipelineRows({ headers, rows }, mapping, sourceLabel) {
  return (rows || []).map((row) => {
    let campaignName = "";
    const tags = {};
    const metrics = {};
    (headers || []).forEach((_, i) => {
      const target = mapping[i];
      if (!target || target === "ignore") return;
      const raw = row[i];
      if (target === "campaign") {
        if (!campaignName) campaignName = String(raw ?? "").trim();
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
        if (n !== null) metrics[key] = n;
      }
    });
    return { source: sourceLabel, periodType: "unknown", periodStart: undefined, campaignName, tags, metrics };
  });
}
