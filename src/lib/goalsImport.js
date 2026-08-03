/**
 * Pure data-transformation logic for GoalsImportWizard.jsx (2026-08-19), split out of that component
 * so it can be sanity-tested directly (a .jsx file with real JSX can't be imported by a plain Node
 * script the way the rest of this app's sanity scripts already do for pipelineColumnMapping.js) and
 * so the component itself stays focused on state/rendering. See GoalsImportWizard.jsx's own top doc
 * comment for the full "why" behind this rebuild (Mo — "duplicate the process of importing a budget
 * file... same popup and UX, just change it slightly for goals").
 *
 * POSITION-INDEXED, NOT HEADER-TEXT-KEYED (the one deliberate departure from BudgetManager.jsx's own
 * processRows, which keys row objects by header string): Mo's real goals file repeats the same header
 * text twice — "January".."December" once for an MQL-goal block of columns and again for a
 * Pipeline-goal block. Keying by header text would let the second block's columns silently overwrite
 * the first's in every row object, so every column reference throughout this module is a column
 * INDEX, and `headers` may legitimately contain duplicate strings.
 */
import { forwardFillGroups, parseMoney } from "./core.js";
import { detectMonthColumn, detectQuarterColumn, parsePeriodCell } from "./pipelineColumnMapping.js";
import { normalizePeriodStart } from "./reportingPeriods.js";

// Total/summary rows (per Mo — "we need to ignore total rows or columns"): checked against every
// mapped dimension value in a row. A small local copy of pipelineColumnMapping.js's own isTotalRow
// logic, rather than importing that function directly — this module's mapping shape (activeDims,
// column INDEX-keyed) is different enough from that file's `mapping` encoding that sharing the exact
// function isn't a clean fit; the actual LABEL SET matching totals is identical on purpose.
const TOTAL_ROW_LABELS = new Set(["total", "totals", "grand total", "sub total", "subtotal", "overall total"]);
function normTxt(v) { return String(v ?? "").trim().toLowerCase(); }
export function isTotalLabel(v) { return TOTAL_ROW_LABELS.has(normTxt(v)); }

// Splits `rawRows` at `headerIdx` into { headers, rows } — headers from that one row (blank cells
// become "Column N"), data rows are everything below it that (a) has at least one non-blank cell and
// (b) doesn't contain `skipStr` anywhere in its joined text (case-insensitive) — mirrors
// BudgetManager's iSkipStr ("total" by default) so an in-file grand-total row never becomes a data
// row in the first place, on top of the isTotalLabel dimension-value check applied later in
// buildGoalsPreview (belt-and-suspenders: a total row might say "Total" in a column that ISN'T
// mapped as a dimension, in which case only this skip-string check catches it).
export function processRowsPositional(rawRows, headerIdx, skipStr) {
  const headerRow = rawRows[headerIdx] || [];
  const headers = headerRow.map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`);
  const skip = (skipStr || "").trim().toLowerCase();
  const rows = (rawRows || [])
    .slice(headerIdx + 1)
    .filter((r) => {
      if (!r || !r.some((c) => String(c ?? "").trim() !== "")) return false;
      if (skip && r.some((c) => String(c ?? "").toLowerCase().includes(skip))) return false;
      return true;
    })
    .map((r) => headers.map((_, i) => (r[i] === undefined ? "" : r[i])));
  return { headers, rows };
}

// "wide" (2+ bare month/quarter columns — a horizontal file) vs "long" (a period column whose value
// varies per row — a vertical file). Mirrors BudgetManager's own monthColCount>=3 threshold for wide
// detection, lowered to >=2 here since a goals file might legitimately report just 2 quarters (a
// half-year rolling forecast) and still be "wide," not "long."
export function detectFormat(headers) {
  const periodColCount = (headers || []).filter((h) => detectMonthColumn(h) || detectQuarterColumn(h)).length;
  return periodColCount >= 2 ? "wide" : "long";
}

// Distinct metric-group labels found by forward-filling `groupRow` (BudgetManager's own
// forwardFillGroups helper — simulates a merged cell spanning several columns), restricted to
// columns that are themselves detected month/quarter columns. A group label sitting over a
// DIMENSION column (Mo's real file has exactly this — the merge visually spans the Product column
// too, purely cosmetically) is irrelevant here since only period columns ever get grouped into a
// metric; see pipelineColumnMapping.js's resolveHeaderRows doc comment for the identical reasoning
// applied to header-row merging.
export function groupLabelsForColumns(headers, groupRow) {
  if (!groupRow) return [];
  const filled = forwardFillGroups(groupRow);
  const labels = (headers || []).map((h, i) => ((detectMonthColumn(h) || detectQuarterColumn(h)) ? (filled[i] || "") : "")).filter(Boolean);
  return [...new Set(labels)];
}

// Builds normalized reporting_facts-shaped rows: { source, periodType, periodStart, campaignName,
// tags, metrics }. Several metrics for the same segment+period merge into ONE output row (bucketed by
// segKey+periodStart) rather than one row per metric — e.g. an MQL Goal and a Pipeline Goal for the
// same Product/January both land in the same row's `metrics` object. A row is dropped entirely
// (contributes nothing) if any active dimension value is blank OR looks like a Total/Summary label
// (isTotalLabel) — see this module's own doc comment on why that's checked here in addition to (not
// instead of) processRowsPositional's skip-string row filter.
//
// params:
//   gFmt: "wide" | "long"
//   headers, dataRows: processRowsPositional's output
//   rawRows, groupHeaderRow: for wide format's optional metric-group row (-1 = none)
//   groupMetricMap: {groupLabel: metricKey} — used when groupHeaderRow >= 0
//   singleMetric: metricKey — used when groupHeaderRow < 0 (whole file is one metric)
//   activeDims: [{dim, col}] — which columns identify a segment
//   periodColIdx: column index of the per-row period value (long format only)
//   metricColMap: {metricKey: colIndex} (long format only)
//   year: fallback year for a bare month/quarter with no year of its own
export function buildGoalsPreview({
  gFmt, headers, dataRows, rawRows, groupHeaderRow, groupMetricMap, singleMetric,
  activeDims, periodColIdx, metricColMap, year, sourceLabel = "goals_csv_mapped",
}) {
  const buckets = new Map();
  const bucketFor = (segKey, dimPairs, periodType, periodStart) => {
    const key = `${segKey}__${periodStart}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        source: sourceLabel,
        periodType, periodStart,
        campaignName: dimPairs.map((p) => p.val).join(" / "),
        tags: Object.fromEntries(dimPairs.map((p) => [p.dim, p.val])),
        metrics: {},
      });
    }
    return buckets.get(key);
  };

  if (gFmt === "wide") {
    let groupValues = null;
    if (groupHeaderRow >= 0 && rawRows[groupHeaderRow]) {
      const filled = forwardFillGroups(rawRows[groupHeaderRow]);
      groupValues = {};
      headers.forEach((_, i) => { groupValues[i] = filled[i] || ""; });
    }
    (dataRows || []).forEach((row) => {
      const dp = activeDims.map((d) => ({ dim: d.dim, val: String(row[d.col] ?? "").trim() }));
      if (dp.some((p) => !p.val) || dp.some((p) => isTotalLabel(p.val))) return;
      const segKey = dp.map((p) => p.val).join("|");
      headers.forEach((h, i) => {
        const mo = detectMonthColumn(h);
        const q = mo ? null : detectQuarterColumn(h);
        if (!mo && !q) return;
        const metricKey = groupValues ? groupMetricMap[groupValues[i]] : singleMetric;
        if (!metricKey) return;
        const n = parseMoney(row[i]);
        if (n === null) return;
        const periodType = mo ? "month" : "quarter";
        const periodStart = mo
          ? normalizePeriodStart("month", `${year}-${String(mo).padStart(2, "0")}-01`)
          : normalizePeriodStart("quarter", `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`);
        bucketFor(segKey, dp, periodType, periodStart).metrics[metricKey] = n;
      });
    });
  } else {
    (dataRows || []).forEach((row) => {
      const dp = activeDims.map((d) => ({ dim: d.dim, val: String(row[d.col] ?? "").trim() }));
      if (dp.some((p) => !p.val) || dp.some((p) => isTotalLabel(p.val))) return;
      const segKey = dp.map((p) => p.val).join("|");
      const period = periodColIdx !== "" && periodColIdx !== undefined ? parsePeriodCell(row[Number(periodColIdx)], year) : null;
      if (!period) return;
      Object.entries(metricColMap || {}).forEach(([metricKey, colIdx]) => {
        if (colIdx === "" || colIdx === undefined) return;
        const n = parseMoney(row[Number(colIdx)]);
        if (n === null) return;
        bucketFor(segKey, dp, period.periodType, period.periodStart).metrics[metricKey] = n;
      });
    });
  }

  return Array.from(buckets.values()).filter((b) => Object.keys(b.metrics).length > 0);
}
