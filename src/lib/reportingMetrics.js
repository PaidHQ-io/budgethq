import { getDecimalAdjust } from "./core.js";

/**
 * Shared helpers for displaying core.reporting_facts' now-open metrics object (see reportingAI.js's
 * OPEN METRICS SCHEMA doc comment, 2026-08-02 — the extraction schema stopped being a fixed ~32-key
 * enum so different clients' exports, e.g. Salesforce/HockeyStack vs. Dreamdata/PowerBI, can keep
 * their own column names). Anything that needs to turn a raw metric key into a human label, decide
 * whether it's a dollar figure, or decide whether it's safe to SUM across rows lives here — used by
 * both ReportingAnalyzer.jsx's review table and the Performance Intelligence breakdown view
 * (PipelineTagger.jsx) so the two don't drift into slightly different labeling/formatting rules.
 */

const METRIC_LABEL_OVERRIDES = {
  spend: "Spend",
  budget_goal: "Budget Goal",
  mqls: "MQL",
  sqls: "SQL",
  sql_pipeline: "SQL Pipeline",
  // Pipeline column-mapping's canonical absolutes (pipelineColumnMapping.js's
  // PIPELINE_METRIC_MAP_OPTIONS) and their derived cost-per/conversion-rate metrics (see
  // DERIVED_PIPELINE_METRICS below) — 2026-08-02, per Mo's column-mapping request.
  leads: "Leads",
  // Optional intermediate funnel-stage metrics (2026-08-06, per Mo — "add MQA, Handraiser, Demo,
  // Free Trial, PQL, Meeting Booked to the fields ... so the user can pick the one he/she wants to
  // use"). PIPELINE_METRIC_MAP_OPTIONS already carries the correctly-cased label Pipeline Tagger/
  // Reporting Intelligence's metric pickers actually render, so these overrides only matter for any
  // OTHER place that falls back to labelForMetricKey for one of these keys (e.g. a generic metric-
  // column render outside those two components) — without them, "mqas"/"pqls" would title-case to
  // "Mqas"/"Pqls" instead of "MQAs"/"PQLs".
  mqas: "MQAs",
  handraisers: "Handraisers",
  demos: "Demos",
  free_trials: "Free Trials",
  pqls: "PQLs",
  meetings_booked: "Meetings Booked",
  sals: "SAL",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
  pipeline_value: "Pipeline Value",
  revenue: "Revenue",
  lead_to_mql_rate: "Lead → MQL Rate",
  mql_to_sal_rate: "MQL → SAL Rate",
  mql_to_sql_rate: "MQL → SQL Rate",
  sal_to_sql_rate: "SAL → SQL Rate",
  sql_to_win_rate: "SQL → Win Rate",
};
// Short acronyms that should stay upper-case in a derived label (e.g. "cp_mql" -> "CP MQL" rather
// than "Cp Mql") — covers this app's own known metric vocabulary; anything else just gets
// title-cased word by word, which is a reasonable default for an arbitrary client-supplied header.
const METRIC_LABEL_ACRONYMS = new Set(["mql", "mqls", "sql", "sqls", "sal", "sals", "ctr", "cpc", "cvr", "cp", "roi", "roas", "cpa", "cpl", "arr", "mrr"]);

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

// `pct`: renders n as a percentage (n=0.324 -> "32.4%") — used for the derived conversion-rate
// metrics below, which are stored as plain fractions (won/total), not "as shown" percentages the
// way REPORTING_METRICS_HELP's AI-extracted rate metrics are. Existing callers only ever pass
// (v, money), so this stays backward compatible.
// Decimal places (2026-08-06, per Mo — "increase or decrease the decimal of any numbered/dollar
// value field") come from core.js's getDecimalAdjust — the same global, workspace-shared "Number
// formatting" preference fmt$/fmtFull read, ADDED to each branch's own baseline rather than
// replacing it: money/plain start at 0 decimals, percent stays at its existing 1-decimal baseline
// (so "increase" from a percent's current 3.2% goes to 3.24%, not to a jarring 3.200000%).
export function fmtMetric(v, money, pct) {
  if (v === undefined || v === null || v === "") return "—";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  const adjust = getDecimalAdjust();
  if (pct) return `${(n * 100).toLocaleString(undefined, { minimumFractionDigits: 1 + adjust, maximumFractionDigits: 1 + adjust })}%`;
  return money ? `$${n.toLocaleString(undefined, { minimumFractionDigits: adjust, maximumFractionDigits: adjust })}` : n.toLocaleString(undefined, { minimumFractionDigits: adjust, maximumFractionDigits: adjust });
}

// Cost-per and conversion-rate metrics computed FROM SUMMED canonical absolutes (spend, leads,
// mqls, sals, sqls, closed_won, closed_lost, pipeline_value, revenue — see
// pipelineColumnMapping.js's PIPELINE_METRIC_MAP_OPTIONS) rather than imported directly (2026-08-02,
// per Mo: "we can calculate all of the cost per metrics as well as the conversion rate metrics from
// the absolute values. We don't need to import those."). This is safe where the generic rate-metric
// exclusion in aggregateByDimension (PipelineTagger.jsx) isn't: unlike an arbitrary client-supplied
// rate key with unknown inputs, these 11 keys' underlying counts are exactly the 9 canonical
// absolutes above, so recomputing from a SUM of those (never summing/averaging the rates themselves)
// is always correct — see this file's isRateMetric doc comment for why that distinction matters.
// `sums`: a { [canonicalKey]: number } object (missing keys treated as 0/undefined). A metric is
// omitted from the result (not shown as 0 or Infinity) when its denominator is 0 or missing.
const safeDiv = (num, den) => (den ? num / den : undefined);
export const DERIVED_PIPELINE_METRICS = [
  { key: "cp_lead", money: true, compute: (s) => safeDiv(s.spend, s.leads) },
  { key: "cp_mql", money: true, compute: (s) => safeDiv(s.spend, s.mqls) },
  { key: "cp_sal", money: true, compute: (s) => safeDiv(s.spend, s.sals) },
  { key: "cp_sql", money: true, compute: (s) => safeDiv(s.spend, s.sqls) },
  { key: "cp_win", money: true, compute: (s) => safeDiv(s.spend, s.closed_won) },
  { key: "lead_to_mql_rate", pct: true, compute: (s) => safeDiv(s.mqls, s.leads) },
  { key: "mql_to_sal_rate", pct: true, compute: (s) => safeDiv(s.sals, s.mqls) },
  // MQL -> SQL (2026-08-04, per Mo's Reporting Intelligence rework request — "conversion rate
  // metrics for lead -> MQL, MQL -> SQL"): a DIRECT mqls-to-sqls rate, distinct from the
  // mql_to_sal_rate/sal_to_sql_rate pair above (which chains through SAL) — some workspaces don't
  // use SAL as a real qualifying stage, so this skips straight from MQL to SQL instead of forcing a
  // read of two chained rates to get the same answer.
  { key: "mql_to_sql_rate", pct: true, compute: (s) => safeDiv(s.sqls, s.mqls) },
  { key: "sal_to_sql_rate", pct: true, compute: (s) => safeDiv(s.sqls, s.sals) },
  { key: "sql_to_win_rate", pct: true, compute: (s) => safeDiv(s.closed_won, s.sqls) },
  { key: "win_rate", pct: true, compute: (s) => safeDiv(s.closed_won, (s.closed_won || 0) + (s.closed_lost || 0)) },
  { key: "roas", compute: (s) => safeDiv(s.revenue, s.spend) },
];

// Returns { [derivedKey]: number } — only keys whose compute() produced a finite value (see the doc
// comment above on why a missing denominator omits the key rather than showing 0/Infinity).
export function computeDerivedPipelineMetrics(sums) {
  const out = {};
  DERIVED_PIPELINE_METRICS.forEach((d) => {
    const v = d.compute(sums || {});
    if (v !== undefined && isFinite(v)) out[d.key] = v;
  });
  return out;
}

// USER-DEFINED CUSTOM METRICS (2026-08-02, per Mo — "allow users to create custom fields for
// cost/lead, cost/demo, cost/SQL, cost/pipeline dollar generated, pipeline dollar generated/spend,
// demo -> MQL conversion rate, MQL -> SQL conversion rate, etc."). Unlike the fixed
// DERIVED_PIPELINE_METRICS list above, these are workspace-configured (stored as
// workspace_config.customMetrics, see PaidHQ.jsx's Settings "Custom Metrics" panel) — a flexible
// left-to-right term chain rather than a single fixed numerator/denominator, so a workspace can
// build anything from a simple ratio (spend / demos) up to a multi-step formula (e.g.
// (mqls - sals) / leads) without needing a real expression parser. No operator precedence/
// parentheses — each term is applied strictly in the order the user added it, which covers every
// example above (all single-operator two-term formulas) and stays predictable for anything longer.
//
// Shape of one entry in workspace_config.customMetrics:
//   { key, label, format: "money"|"pct"|"number", terms: [{field,op}, ...] }
// terms[0].op is ignored (nothing precedes the first term). `field` is always one of
// pipelineColumnMapping.js's PIPELINE_METRIC_MAP_OPTIONS keys — the same canonical, safe-to-sum
// absolutes DERIVED_PIPELINE_METRICS itself reads from, so these are computed FROM SUMS the exact
// same way (never summed/averaged as a rate directly — see this file's isRateMetric doc comment).
export const CUSTOM_METRIC_OPERATORS = [
  { value: "/", label: "÷ (divide by)" },
  { value: "*", label: "× (multiply by)" },
  { value: "+", label: "+ (add)" },
  { value: "-", label: "− (subtract)" },
];
function applyCustomMetricOp(acc, op, v) {
  if (op === "/") return v ? acc / v : undefined; // a zero/missing denominator anywhere omits the whole metric, same as safeDiv
  if (op === "*") return acc * v;
  if (op === "-") return acc - v;
  return acc + v; // default/"+"
}
// Returns undefined (never NaN/Infinity) when the formula can't be evaluated — no terms, or a
// division landed on a zero/missing denominator partway through the chain.
export function computeCustomMetric(sums, customMetric) {
  const terms = customMetric && customMetric.terms;
  if (!Array.isArray(terms) || terms.length === 0) return undefined;
  const valueOf = (field) => { const n = Number((sums || {})[field]); return isNaN(n) ? 0 : n; };
  let acc = valueOf(terms[0].field);
  for (let i = 1; i < terms.length; i++) {
    const next = applyCustomMetricOp(acc, terms[i].op || "+", valueOf(terms[i].field));
    if (next === undefined) return undefined;
    acc = next;
  }
  return isFinite(acc) ? acc : undefined;
}
// Returns { [customMetricKey]: number } — mirrors computeDerivedPipelineMetrics's own contract,
// used identically (merged into an already-summed absolutes object, never before summing).
export function computeCustomMetrics(sums, customMetrics) {
  const out = {};
  (customMetrics || []).forEach((cm) => {
    const v = computeCustomMetric(sums, cm);
    if (v !== undefined) out[cm.key] = v;
  });
  return out;
}
// Human-readable formula preview for the Settings list, e.g. "Spend ÷ Demos" or
// "Mqls − Sals ÷ Leads" — purely cosmetic, used nowhere in computation.
export function formulaPreview(customMetric) {
  const terms = (customMetric && customMetric.terms) || [];
  const opLabel = { "/": "÷", "*": "×", "+": "+", "-": "−" };
  return terms.map((t, i) => (i === 0 ? labelForMetricKey(t.field) : `${opLabel[t.op] || "+"} ${labelForMetricKey(t.field)}`)).join(" ");
}

// Derives which metric keys are worth showing as columns from whatever rows are actually present,
// instead of a fixed list — see this file's top doc comment. `excludeRates`: pass true for an
// AGGREGATED view (multiple rows summed into one) where rate-like keys would be mathematically
// wrong to show; leave false for a per-row view where the source value is still meaningful as-is.
// Caps how wide the summary columns get for an unusually wide export. Raised from 8 -> 20
// (2026-08-04, per Mo — "Pipeline Value is missing"): pipelineColumnMapping.js's own canonical
// funnel absolutes (PIPELINE_METRIC_MAP_OPTIONS) are 9 keys wide on their own, so the old cap of 8
// was silently dropping whichever one landed last in a given row's own key-insertion order (CSV
// column order-dependent, not a fixed drop) — Pipeline Value or Revenue, most often, since they're
// listed last in that array. 20 comfortably fits all 9 canonical absolutes plus a wide arbitrary
// client export's own custom columns without meaningfully changing the "don't let this table get
// absurdly wide" intent the cap exists for.
const MAX_METRIC_COLUMNS = 20;
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

// Column defs for whichever DERIVED_PIPELINE_METRICS keys actually got a value somewhere in
// `groupsMetrics` (an array of already-summed { [key]: number } objects, one per breakdown group —
// see PipelineTagger.jsx's aggregateByDimension). Unlike deriveMetricColumns, these are never
// excluded as "rate metrics" — they're already the correctly-recomputed-from-sums values, not a
// raw imported rate that would be wrong to sum. `pct` on the returned def tells fmtMetric to render
// it as a percentage instead of a plain number/dollar figure.
export function deriveDerivedPipelineColumns(groupsMetrics) {
  const present = new Set();
  (groupsMetrics || []).forEach((m) => {
    DERIVED_PIPELINE_METRICS.forEach((d) => {
      if (m && m[d.key] !== undefined) present.add(d.key);
    });
  });
  return DERIVED_PIPELINE_METRICS.filter((d) => present.has(d.key)).map((d) => ({
    key: d.key,
    label: labelForMetricKey(d.key),
    money: !!d.money,
    pct: !!d.pct,
  }));
}
