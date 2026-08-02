/**
 * Shared helpers for displaying core.reporting_facts' now-open metrics object (see reportingAI.js's
 * OPEN METRICS SCHEMA doc comment, 2026-08-02 — the extraction schema stopped being a fixed ~32-key
 * enum so different clients' exports, e.g. Salesforce/HockeyStack vs. Dreamdata/PowerBI, can keep
 * their own column names). Anything that needs to turn a raw metric key into a human label, decide
 * whether it's a dollar figure, or decide whether it's safe to SUM across rows lives here — used by
 * both ReportingAnalyzer.jsx's review table and the Reporting Intelligence breakdown view
 * (PipelineTagger.jsx) so the two don't drift into slightly different labeling/formatting rules.
 */

const METRIC_LABEL_OVERRIDES = {
  spend: "Spend",
  budget_goal: "Budget Goal",
  mqls: "MQL",
  sqls: "SQL",
  sql_pipeline: "SQL Pipeline",
};
// Short acronyms that should stay upper-case in a derived label (e.g. "cp_mql" -> "CP MQL" rather
// than "Cp Mql") — covers this app's own known metric vocabulary; anything else just gets
// title-cased word by word, which is a reasonable default for an arbitrary client-supplied header.
const METRIC_LABEL_ACRONYMS = new Set(["mql", "mqls", "sql", "sqls", "ctr", "cpc", "cvr", "cp", "roi", "roas", "cpa", "cpl", "arr", "mrr"]);

export function labelForMetricKey(key) {
  if (METRIC_LABEL_OVERRIDES[key]) return METRIC_LABEL_OVERRIDES[key];
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => (METRIC_LABEL_ACRONYMS.has(part.toLowerCase()) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

// Heuristic only (no per-column format metadata is stored) — good enough to right-align/$-format
// the obviously-dollar metrics without needing a client-by-client mapping step.
const MONEY_METRIC_RE = /spend|budget|pipeline|cost|revenue|^cp[_$]|_cp$/i;
export function isMoneyMetric(key) {
  return MONEY_METRIC_RE.test(key);
}

// A rate/percentage/cost-per metric (ctr, cvr, cp_mql, mql_attainment_pct, ...) can NEVER be
// correctly summed across rows the way a plain count (spend, mqls, clicks) can — see this
// codebase's established "metric rollup correctness" rule: rate/cost-per metrics must be
// RECOMPUTED from the underlying summed counts, never averaged/summed directly. With an open,
// per-client metrics schema there's no reliable generic way to know which raw counts a given rate
// key was derived from (e.g. is "win_rate" opportunities/leads or deals/meetings?), so the
// breakdown view's v1 rollup deliberately EXCLUDES anything this matches rather than showing a
// number that looks precise but is mathematically wrong. Per-row (unaggregated) values are still
// shown as-is — this only affects values that would otherwise get summed across multiple rows.
const RATE_METRIC_RE = /_pct$|_percent$|_rate$|attainment|forecast|^ctr$|^cvr$|^cpc$|^cp_|_cp$|\broi\b|\broas\b|\bwin_rate\b/i;
export function isRateMetric(key) {
  return RATE_METRIC_RE.test(key);
}

export function fmtMetric(v, money) {
  if (v === undefined || v === null || v === "") return "—";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return money ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : n.toLocaleString();
}

// Derives which metric keys are worth showing as columns from whatever rows are actually present,
// instead of a fixed list — see this file's top doc comment. `excludeRates`: pass true for an
// AGGREGATED view (multiple rows summed into one) where rate-like keys would be mathematically
// wrong to show; leave false for a per-row view where the source value is still meaningful as-is.
const MAX_METRIC_COLUMNS = 8; // caps how wide the summary columns get for an unusually wide export
export function deriveMetricColumns(rows, { excludeRates = false } = {}) {
  const seen = [];
  const known = new Set();
  for (const row of rows || []) {
    for (const key of Object.keys(row.metrics || {})) {
      if (excludeRates && isRateMetric(key)) continue;
      if (!known.has(key)) {
        known.add(key);
        seen.push(key);
      }
    }
  }
  return seen.slice(0, MAX_METRIC_COLUMNS).map((key) => ({ key, label: labelForMetricKey(key), money: isMoneyMetric(key) }));
}
