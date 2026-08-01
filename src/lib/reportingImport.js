/**
 * Deterministic (non-AI) importer for the campaign-level PowerBI/Dreamdata export ("Source B", per
 * Mo — 2026-08-01: "I say we ignore that daily csv report altogether... Let's focus just on Source
 * B and Source C"). Unlike the screenshot/PDF path (reportingAI.js), this file is a clean, already-
 * tidy one-row-per-campaign table with stable known headers — no AI extraction needed, just a
 * column-name map, same spirit as core.js's spend-row CSV/XLSX import.
 *
 * The export itself has no period column (the month is chosen before exporting, not printed
 * per-row) — callers land the parsed rows into ReportingAnalyzer's existing pendingRows review
 * flow with periodType "unknown", same as an image extraction that couldn't find a date; the
 * existing period-picker UI handles assigning one period to the whole batch.
 *
 * Every metric this source provides already exists in reportingAI.js's fixed vocabulary (spend,
 * all_conversions, inquiries, cp_inquiry, mqls, all_conv_to_mql_rate, cp_mql, sqls,
 * mql_to_sql_rate, sql_pipeline) — no schema extension needed here, unlike Source C.
 *
 * READS RAW CELL VALUES, NOT core.js's parseFileToRows (2026-08-01 — caught while smoke-testing
 * this parser against the real sample export): parseFileToRows reads XLSX cells with `raw:false`,
 * which returns each cell's DISPLAY-FORMATTED text rather than its stored value — right for
 * core.js's own CSV/budget-import callers, but wrong here. This specific PowerBI export has count
 * columns (All Conversions, Inquiries, CP Inquiry, MQLs, SQL) whose cells are stored as plain
 * numbers but carry stray percentage NUMBER FORMATTING — confirmed on the real file: a cell holding
 * 242.126 renders as the display text "24213%". Stripping "%" from that display text (the same way
 * REPORTING_METRICS_HELP's "percentage as shown" convention treats genuine percentage metrics)
 * would silently inflate every one of those columns 100x. Reading with `raw:true` instead returns
 * the actual stored number and sidesteps the display-format artifact entirely.
 */
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { parseMoney } from "./core.js";

// Same CSV/XLSX branching as core.js's parseFileToRows, except the XLSX branch reads raw:true —
// see the doc comment above for why. CSV has no per-cell number formatting to begin with, so
// Papa.parse's plain string output is unaffected by this issue.
function readRowsRaw(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "csv") {
      Papa.parse(file, { header: false, skipEmptyLines: false, complete: (r) => resolve(r.data) });
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          resolve(XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true }));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    }
  });
}

// Case/underscore/whitespace-insensitive header aliases — matched against a normalized header
// string (lowercased, underscores -> spaces, whitespace collapsed). A couple of plausible variants
// are included defensively (the export's exact header text could drift slightly release to
// release) but this is deliberately not fuzzy-matched — an unrecognized header is just dropped
// (its column is ignored) rather than guessed at.
const CAMPAIGN_HEADER_ALIASES = ["campaign name", "campaign"];

const METRIC_HEADER_ALIASES = {
  "total spend": "spend",
  spend: "spend",
  "all conversions": "all_conversions",
  inquiries: "inquiries",
  "cp inquiry": "cp_inquiry",
  mqls: "mqls",
  mql: "mqls",
  "all conv > mqls rate": "all_conv_to_mql_rate",
  "all conv to mqls rate": "all_conv_to_mql_rate",
  "cp mql": "cp_mql",
  sql: "sqls",
  sqls: "sqls",
  "mql to sql rate": "mql_to_sql_rate",
  "sql pipeline": "sql_pipeline",
};

// Rows the export itself injects that aren't real campaigns — a grand-total summary row, and two
// placeholder buckets for spend/pipeline the client's IT team couldn't attribute to a named
// campaign (confirmed present in the sample file: "Total", "Unmatched", "Unknown Campaign").
const EXCLUDED_CAMPAIGN_NAMES = new Set(["total", "unmatched", "unknown campaign", ""]);

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

function mapCampaignReportRows(rows) {
  if (!rows || !rows.length) throw new Error("File appears to be empty.");
  const headerRowIdx = rows.findIndex((r) => (r || []).some((c) => CAMPAIGN_HEADER_ALIASES.includes(normalizeHeader(c))));
  if (headerRowIdx === -1) {
    throw new Error("Couldn't find a CAMPAIGN_NAME column — is this the campaign-level PowerBI export?");
  }
  const headers = rows[headerRowIdx];
  const campaignColIdx = headers.findIndex((h) => CAMPAIGN_HEADER_ALIASES.includes(normalizeHeader(h)));
  const metricCols = headers
    .map((h, i) => ({ i, key: METRIC_HEADER_ALIASES[normalizeHeader(h)] }))
    .filter((c) => c.key);

  const out = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const campaignName = String(row[campaignColIdx] ?? "").trim();
    if (EXCLUDED_CAMPAIGN_NAMES.has(campaignName.toLowerCase())) continue;
    const metrics = {};
    metricCols.forEach(({ i: ci, key }) => {
      const n = parseMoney(row[ci]);
      if (n !== null) metrics[key] = n;
    });
    if (!Object.keys(metrics).length) continue; // stray footer/"Applied filters" note row, etc.
    out.push({ campaignName, metrics });
  }
  if (!out.length) throw new Error("No campaign rows found in this file.");
  return out;
}

// file: a File from an <input type="file"> or drop handler. Resolves to an array of
// { campaignName, metrics } — the same per-row shape ReportingAnalyzer normalizes AI-extracted
// rows into, minus period info (caller sets periodType "unknown" so the review UI's existing
// period-picker handles it) and tags (blank — tagging happens afterward in Pipeline Tagger).
export async function parseCampaignReportFile(file) {
  const rows = await readRowsRaw(file);
  return mapCampaignReportRows(rows);
}
