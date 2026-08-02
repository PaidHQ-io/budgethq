import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { PixelPanel, SectionLabel, Sel, Icon, Pill, IconField, MatchModeToggle, Divider } from "./shared.jsx";
import { listReportingFacts } from "../lib/reportingApi.js";
import {
  fmtMetric, isRateMetric, isMoneyMetric, labelForMetricKey,
  computeDerivedPipelineMetrics, DERIVED_PIPELINE_METRICS,
  computeCustomMetrics,
} from "../lib/reportingMetrics.js";
import { PIPELINE_METRIC_MAP_OPTIONS, AD_GROUP_TAG_KEY, CHANNEL_TAG_KEY } from "../lib/pipelineColumnMapping.js";
import { stepPeriodStart, labelForPeriod } from "../lib/reportingPeriods.js";
import { splitFilterTerms, matchesTerms } from "../lib/core.js";
import { usePersistentState } from "../lib/persist.js";

// REWORKED 2026-08-04 (per Mo — "rework the Reporting Intelligence tab so it works like the budget
// pacing tab, only for MQLs and Pipeline"). v1 of this tab (see git history) was a single fixed
// breakdown table with whatever metric columns happened to be present. This version borrows Budget
// Pacing's OVERALL shape — a sidebar Period control + a Metrics selector feeding both a trend chart
// and a table, plus a run-rate projection for the period still in progress — without literally
// reusing PacingDashboard.jsx's own engine, which is built around daily spend_rows/budgets and
// doesn't apply here (reporting_facts is monthly/quarterly/yearly totals, never daily — see the
// FORECAST section below for the different, simpler model this uses instead).
//
// FILTER SYSTEM: intentionally the exact same interaction pattern as ReportingFactsTagger's own
// toolbar (2026-08-04, per Mo — "the same filter system") — Campaign/Ad Group contains+excludes
// with AND/OR mode toggles, a Channel dropdown, a Tag contains+excludes, and a tagged/untagged
// status filter — operating on individual reporting_facts rows BEFORE they get bucketed into
// periods or sliced by dimension below, so every downstream number already reflects the filters.
//
// METRIC ROLLUP CORRECTNESS (unchanged from v1 — see DERIVED_PIPELINE_METRICS' own doc comment in
// reportingMetrics.js): every absolute funnel count/dollar figure (spend, leads, mqls, ..., pipeline
// value, revenue) is safe to sum across rows; a rate/cost-per metric is NEVER summed or averaged
// directly — it's recomputed from each bucket's own SUMMED absolutes, after summing, never before.
//
// FORECAST: reporting_facts has no daily grain to project from the way spend_rows does, so instead
// of Auto/Committed/Manual trailing-window blending, this uses a single, simple, clearly-labeled
// model — CALENDAR ELAPSED-TIME run-rate — applied ONLY to the most recent period bucket if today's
// date actually falls inside it (i.e. that period is still in progress): projected = actual-to-date
// / (days elapsed in the period / total days in the period). A period that's already fully closed
// just shows its actual total, no projection. This is legitimate specifically because canonical
// pipeline metrics (leads, mqls, spend, ...) are cumulative counts that only grow through a period —
// unlike ad spend's own day-of-week noise, there's no seasonality correction to make here, just a
// straight-line extrapolation of what's landed so far.
const RESERVED_TAG_KEYS = new Set([AD_GROUP_TAG_KEY, CHANNEL_TAG_KEY]);

const ABSOLUTE_METRIC_OPTIONS = PIPELINE_METRIC_MAP_OPTIONS.map((m) => ({ key: m.key, label: m.label, money: isMoneyMetric(m.key), pct: false, kind: "absolute" }));
const DERIVED_METRIC_OPTIONS = DERIVED_PIPELINE_METRICS.map((d) => ({ key: d.key, label: labelForMetricKey(d.key), money: !!d.money, pct: !!d.pct, kind: "derived" }));
// Default selection centers on MQLs + Pipeline (per Mo's framing of this tab's focus) plus the
// specific cost-per/conversion metrics called out by name, with Spend/Leads/SQLs along for context
// since a cost-per or conversion number is meaningless without its inputs visible alongside it.
const DEFAULT_METRICS = ["spend", "leads", "mqls", "sqls", "pipeline_value", "cp_lead", "cp_mql", "cp_sql", "lead_to_mql_rate", "mql_to_sql_rate"];
const CHARTABLE_METRICS = ABSOLUTE_METRIC_OPTIONS.filter((m) => m.key !== "closed_lost"); // any absolute count/$ is chartable; rates/cost-per have an incompatible scale, kept table-only

// Groups raw reporting_facts rows into one entry per Campaign or per tag VALUE (unchanged logic
// from v1 — see this file's METRIC ROLLUP CORRECTNESS doc comment above for why rate-shaped raw
// metric keys are excluded from the sum here).
// Shared by aggregateByDimension below AND the row-level search filter (see this component's
// searchedRows memo) so "which group does this row belong to" is computed exactly one way.
function groupLabelForRow(r, dimKey) {
  if (!dimKey) return "All rows";
  if (dimKey === "campaignName") return (r.campaignName || "").trim() || "(no campaign)";
  return (r.tags || {})[dimKey] || "(untagged)";
}
function aggregateByDimension(rows, dimKey) {
  const map = new Map();
  (rows || []).forEach((r) => {
    const label = groupLabelForRow(r, dimKey);
    if (!map.has(label)) map.set(label, { key: label, rows: [], metrics: {} });
    const g = map.get(label);
    g.rows.push(r);
    Object.entries(r.metrics || {}).forEach(([k, v]) => {
      if (isRateMetric(k)) return;
      const n = Number(v);
      if (isNaN(n)) return;
      g.metrics[k] = (g.metrics[k] || 0) + n;
    });
  });
  return Array.from(map.values());
}

// One bucket per exact (periodType, periodStart) pair actually present in the filtered rows — never
// re-grained (a quarter-imported row never gets split into 3 months, a run of monthly rows never
// gets merged up into a quarter) so a bucket's own total is always exactly what was imported for it,
// summed only when more than one row shares that literal period (e.g. two campaigns both dated the
// same month). Sorted chronologically by periodStart for the trend chart/table.
function bucketByPeriod(rows) {
  const map = new Map();
  (rows || []).forEach((r) => {
    if (!r.periodStart) return;
    const key = `${r.periodType}|${r.periodStart}`;
    if (!map.has(key)) map.set(key, { key, periodType: r.periodType, periodStart: r.periodStart, rows: [], metrics: {} });
    const b = map.get(key);
    b.rows.push(r);
    Object.entries(r.metrics || {}).forEach(([k, v]) => {
      if (isRateMetric(k)) return;
      const n = Number(v);
      if (isNaN(n)) return;
      b.metrics[k] = (b.metrics[k] || 0) + n;
    });
  });
  return Array.from(map.values()).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

// [start, end) as real Date objects for a period bucket, using stepPeriodStart to find the NEXT
// period's start rather than hand-rolling month/quarter/year-length math again here.
function periodBounds(periodType, periodStart) {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const nextStart = stepPeriodStart(periodType, periodStart);
  const end = nextStart ? new Date(`${nextStart}T00:00:00Z`) : null;
  return { start, end };
}

const fIn = { background: "transparent", border: "none", outline: "none", width: "100%" };

export default function PipelineTagger({ T, session, workspace, tagDims, customMetrics, sidebarEl }) {
  const [rows, setRows] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");

  // Workspace-configured custom metrics (2026-08-08, per Mo — see PaidHQ.jsx's Settings "Custom
  // Metrics" panel and reportingMetrics.js's own doc comment on computeCustomMetric). Merged
  // alongside the fixed DERIVED_PIPELINE_METRICS everywhere below — same "computed from summed
  // absolutes, never from a raw per-row rate" rule applies.
  const CUSTOM_METRIC_OPTIONS = useMemo(
    () => (customMetrics || []).map((cm) => ({ key: cm.key, label: cm.label, money: cm.format === "money", pct: cm.format === "pct", kind: "custom" })),
    [customMetrics]
  );
  const ALL_METRIC_OPTIONS = useMemo(() => [...ABSOLUTE_METRIC_OPTIONS, ...DERIVED_METRIC_OPTIONS, ...CUSTOM_METRIC_OPTIONS], [CUSTOM_METRIC_OPTIONS]);
  const METRIC_OPTION_BY_KEY = useMemo(() => Object.fromEntries(ALL_METRIC_OPTIONS.map((m) => [m.key, m])), [ALL_METRIC_OPTIONS]);

  // Filters — see this file's top "FILTER SYSTEM" doc comment.
  const [filtersOpen, setFiltersOpen] = usePersistentState("paidhq_reporting_intel_filtersOpen", true);
  const [fCampaignName, setFCampaignName] = usePersistentState("paidhq_reporting_intel_fCampaignName", "");
  const [fCampaignNameExclude, setFCampaignNameExclude] = usePersistentState("paidhq_reporting_intel_fCampaignNameExclude", "");
  const [fCampaignNameInclMode, setFCampaignNameInclMode] = usePersistentState("paidhq_reporting_intel_fCampaignNameInclMode", "or");
  const [fCampaignNameExclMode, setFCampaignNameExclMode] = usePersistentState("paidhq_reporting_intel_fCampaignNameExclMode", "or");
  const [fAdGroup, setFAdGroup] = usePersistentState("paidhq_reporting_intel_fAdGroup", "");
  const [fAdGroupExclude, setFAdGroupExclude] = usePersistentState("paidhq_reporting_intel_fAdGroupExclude", "");
  const [fAdGroupInclMode, setFAdGroupInclMode] = usePersistentState("paidhq_reporting_intel_fAdGroupInclMode", "or");
  const [fAdGroupExclMode, setFAdGroupExclMode] = usePersistentState("paidhq_reporting_intel_fAdGroupExclMode", "or");
  const [fChannel, setFChannel] = usePersistentState("paidhq_reporting_intel_fChannel", "");
  const [fTag, setFTag] = usePersistentState("paidhq_reporting_intel_fTag", "");
  const [fTagExclude, setFTagExclude] = usePersistentState("paidhq_reporting_intel_fTagExclude", "");
  const [fTagInclMode, setFTagInclMode] = usePersistentState("paidhq_reporting_intel_fTagInclMode", "or");
  const [fTagExclMode, setFTagExclMode] = usePersistentState("paidhq_reporting_intel_fTagExclMode", "or");
  const [fStatus, setFStatus] = usePersistentState("paidhq_reporting_intel_fStatus", "all");

  // Period filter — grain + range, modeled on Budget Pacing's own sidebar Period block (2026-08-04,
  // per Mo — "include the period filter, just like with the budget pacer"). "Grain" narrows to rows
  // imported at one periodType; the From/To range narrows by calendar month regardless of grain
  // (a quarter/year row's periodStart is always the 1st of a month, so comparing "YYYY-MM" slices
  // works for every grain without special-casing any of them).
  const now = new Date();
  const nowMs = now.getTime(); // captured once per render (not inside a memo) — same pattern PacingDashboard's own `now` uses
  const nowMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const defaultRangeStart = (() => { const d = new Date(now.getFullYear(), now.getMonth() - 11, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
  const [periodGrain, setPeriodGrain] = usePersistentState("paidhq_reporting_intel_periodGrain", "all"); // all|month|quarter|year
  const [rangeStart, setRangeStart] = usePersistentState("paidhq_reporting_intel_rangeStart", defaultRangeStart);
  const [rangeEnd, setRangeEnd] = usePersistentState("paidhq_reporting_intel_rangeEnd", nowMonthStr);

  const [sliceBy, setSliceBy] = usePersistentState("paidhq_reporting_intel_sliceBy", "campaignName");
  const [fSearch, setFSearch] = usePersistentState("paidhq_reporting_intel_fSearch", "");
  // Metrics — like Pipeline Tagger's own "Columns:" toggle pills (2026-08-04, per Mo — "select the
  // metrics we want to compare and review and analyze, just like the pipeline tagger").
  const [metrics, setMetrics] = usePersistentState("paidhq_reporting_intel_metrics", DEFAULT_METRICS);
  // Trend chart metrics (2026-08-09, per Mo — "allow users to select up to three metrics to view
  // month by month or quarter by quarter"). Was a single-metric dropdown; now a small multi-select
  // (still capped at 3 — any more than that on one grouped-bar chart stops being readable,
  // especially once money/count-scale metrics are mixed together). Renamed persistence key since
  // the shape changed from a string to an array — the old paidhq_reporting_intel_chartMetric key is
  // simply abandoned, not migrated (worst case someone's chart resets to the Pipeline Value
  // default once, same as any other new user).
  const MAX_CHART_METRICS = 3;
  const [chartMetrics, setChartMetrics] = usePersistentState("paidhq_reporting_intel_chartMetrics", ["pipeline_value"]);
  const toggleChartMetric = (key) => setChartMetrics((prev) => {
    if (prev.includes(key)) return prev.filter((k) => k !== key);
    if (prev.length >= MAX_CHART_METRICS) return prev; // at cap — ignored, the picker below disables the button so this is just a safety no-op
    return [...prev, key];
  });

  useEffect(() => {
    listReportingFacts(session, workspace.id)
      .then((r) => { setRows(r); setLoadError(""); })
      .catch((err) => setLoadError(err.message || "Couldn't load pipeline data."));
  }, [session, workspace.id]);

  const distinctChannels = useMemo(
    () => Array.from(new Set((rows || []).map((r) => (r.tags || {})[CHANNEL_TAG_KEY]).filter(Boolean))).sort(),
    [rows]
  );

  const filteredRows = useMemo(() => {
    return (rows || []).filter((r) => {
      const campaignName = (r.campaignName || "").trim();
      const adGroup = ((r.tags || {})[AD_GROUP_TAG_KEY] || "").trim();
      const channel = (r.tags || {})[CHANNEL_TAG_KEY] || "";
      const regularTags = Object.entries(r.tags || {}).filter(([k]) => !RESERVED_TAG_KEYS.has(k));
      if (fCampaignName) {
        const terms = splitFilterTerms(fCampaignName);
        if (terms.length && !matchesTerms(campaignName.toLowerCase(), terms, fCampaignNameInclMode)) return false;
      }
      if (fCampaignNameExclude) {
        const terms = splitFilterTerms(fCampaignNameExclude);
        if (terms.length && matchesTerms(campaignName.toLowerCase(), terms, fCampaignNameExclMode)) return false;
      }
      if (fAdGroup) {
        const terms = splitFilterTerms(fAdGroup);
        if (terms.length && !matchesTerms(adGroup.toLowerCase(), terms, fAdGroupInclMode)) return false;
      }
      if (fAdGroupExclude) {
        const terms = splitFilterTerms(fAdGroupExclude);
        if (terms.length && matchesTerms(adGroup.toLowerCase(), terms, fAdGroupExclMode)) return false;
      }
      if (fChannel && channel !== fChannel) return false;
      if (fTag) {
        const s = regularTags.map(([d, v]) => `${d}:${v}`).join(" ").toLowerCase();
        const terms = splitFilterTerms(fTag);
        if (terms.length && !matchesTerms(s, terms, fTagInclMode)) return false;
      }
      if (fTagExclude) {
        const s = regularTags.map(([d, v]) => `${d}:${v}`).join(" ").toLowerCase();
        const terms = splitFilterTerms(fTagExclude);
        if (terms.length && matchesTerms(s, terms, fTagExclMode)) return false;
      }
      if (fStatus !== "all") {
        const tagged = regularTags.length > 0;
        if (fStatus === "tagged" && !tagged) return false;
        if (fStatus === "untagged" && tagged) return false;
      }
      if (periodGrain !== "all" && r.periodType !== periodGrain) return false;
      const rowMonth = (r.periodStart || "").slice(0, 7);
      if (rangeStart && rowMonth < rangeStart) return false;
      if (rangeEnd && rowMonth > rangeEnd) return false;
      return true;
    });
  }, [rows, fCampaignName, fCampaignNameExclude, fCampaignNameInclMode, fCampaignNameExclMode, fAdGroup, fAdGroupExclude, fAdGroupInclMode, fAdGroupExclMode, fChannel, fTag, fTagExclude, fTagInclMode, fTagExclMode, fStatus, periodGrain, rangeStart, rangeEnd]);

  const hasF = fCampaignName || fCampaignNameExclude || fAdGroup || fAdGroupExclude || fChannel || fTag || fTagExclude || fStatus !== "all";
  const clearF = () => {
    setFCampaignName(""); setFCampaignNameExclude("");
    setFAdGroup(""); setFAdGroupExclude("");
    setFChannel("");
    setFTag(""); setFTagExclude("");
    setFStatus("all");
  };

  // Search-by-group fix (2026-08-09, per Mo — "it also needs to filter properly by whatever the
  // user is filtering for. Right now its not filtering at all"): the search box next to "Slice by"
  // used to only prune empty groups OUT of the Breakdown table below (filteredSliceGroups), while
  // the Trend chart, Trend-by-period table, and grand totals kept summing every row regardless —
  // so typing e.g. "logi" narrowed one table to 1 group but everything above it still showed all
  // 374 rows' worth of totals. Fixed by pruning at the ROW level, using the exact same
  // groupLabelForRow the Breakdown table itself groups by, BEFORE periods/totals/groups are
  // computed — now every number on the page reflects the search the same way the sidebar Filters
  // already do.
  const searchedRows = useMemo(() => {
    const fs = fSearch.trim().toLowerCase();
    if (!fs) return filteredRows;
    return filteredRows.filter((r) => groupLabelForRow(r, sliceBy || null).toLowerCase().includes(fs));
  }, [filteredRows, fSearch, sliceBy]);

  // Grand totals — one plain sum across every filtered+searched row's absolute metrics (always
  // correct), then the known derived metrics recomputed from THOSE totals (never summed/averaged
  // directly — see this file's top doc comment). Used as the Total row on both tables below.
  const grandTotals = useMemo(() => {
    const absoluteTotals = {};
    searchedRows.forEach((r) => {
      Object.entries(r.metrics || {}).forEach(([k, v]) => {
        if (isRateMetric(k)) return;
        const n = Number(v);
        if (!isNaN(n)) absoluteTotals[k] = (absoluteTotals[k] || 0) + n;
      });
    });
    return { ...absoluteTotals, ...computeDerivedPipelineMetrics(absoluteTotals), ...computeCustomMetrics(absoluteTotals, customMetrics) };
  }, [searchedRows, customMetrics]);

  const periodBuckets = useMemo(
    () => bucketByPeriod(searchedRows).map((b) => ({ ...b, metrics: { ...b.metrics, ...computeDerivedPipelineMetrics(b.metrics), ...computeCustomMetrics(b.metrics, customMetrics) } })),
    [searchedRows, customMetrics]
  );

  const sliceGroups = useMemo(
    () => aggregateByDimension(searchedRows, sliceBy || null).map((g) => ({ ...g, metrics: { ...g.metrics, ...computeDerivedPipelineMetrics(g.metrics), ...computeCustomMetrics(g.metrics, customMetrics) } })),
    [searchedRows, sliceBy, customMetrics]
  );

  // No longer needs to re-filter by fSearch itself — sliceGroups above is already built from
  // searchedRows, so every group here already matches. Just sorts.
  const filteredSliceGroups = useMemo(
    () => sliceGroups.slice().sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key)),
    [sliceGroups]
  );

  // FORECAST — see this file's top doc comment for the full "why." Only ever computed for the
  // LAST (most recent) period bucket actually in the filtered set, and only if today's date falls
  // inside that bucket's own [start,end) — a fully-closed historical period never gets a projection,
  // it just shows its real total.
  const forecast = useMemo(() => {
    if (!periodBuckets.length) return null;
    const last = periodBuckets[periodBuckets.length - 1];
    if (!["month", "quarter", "year"].includes(last.periodType)) return null;
    const { start, end } = periodBounds(last.periodType, last.periodStart);
    if (!end) return null;
    if (nowMs < start.getTime() || nowMs >= end.getTime()) return null;
    const totalMs = end.getTime() - start.getTime();
    const elapsedMs = Math.max(nowMs - start.getTime(), totalMs / 1000); // floor so day-1 doesn't divide by ~0
    const fraction = elapsedMs / totalMs;
    const projectedAbsolutes = {};
    ABSOLUTE_METRIC_OPTIONS.forEach((m) => {
      const v = last.metrics[m.key];
      if (v !== undefined) projectedAbsolutes[m.key] = v / fraction;
    });
    return {
      bucket: last,
      fraction,
      elapsedDays: Math.round(elapsedMs / 86400000),
      totalDays: Math.round(totalMs / 86400000),
      projected: { ...projectedAbsolutes, ...computeDerivedPipelineMetrics(projectedAbsolutes), ...computeCustomMetrics(projectedAbsolutes, customMetrics) },
    };
  }, [periodBuckets, nowMs, customMetrics]);

  const activeMetricColumns = useMemo(() => ALL_METRIC_OPTIONS.filter((m) => metrics.includes(m.key)), [metrics, ALL_METRIC_OPTIONS]);
  const toggleMetric = (key) => setMetrics((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  // One series per selected chart metric, each carrying its own color (assigned by selection
  // order, stable as long as the selection itself doesn't change) — see TrendMiniChart below for
  // how these get drawn as grouped bars.
  const CHART_SERIES_COLORS = useMemo(() => [T.accent, T.success, T.warning], [T.accent, T.success, T.warning]);
  const chartSeries = useMemo(
    () => chartMetrics.map((key, i) => {
      const opt = METRIC_OPTION_BY_KEY[key];
      return {
        key,
        label: opt?.label || key,
        money: !!opt?.money,
        color: CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length],
        values: periodBuckets.map((b) => b.metrics[key] || 0),
        projectedValue: forecast ? forecast.projected[key] : undefined,
      };
    }),
    [chartMetrics, periodBuckets, forecast, METRIC_OPTION_BY_KEY, CHART_SERIES_COLORS]
  );

  const sliceOptions = [{ value: "campaignName", label: "Campaign" }, ...((tagDims || []).map((d) => ({ value: d, label: d })))];

  // Left-column overview + controls (2026-08-04, per Mo — "works like the budget pacing tab"),
  // portaled into the shared stats <aside> the same way PacingDashboard/ReportingFactsTagger do —
  // see PaidHQ.jsx's own view==="pipelineTagger" branch for the portal target this renders into.
  const sidebarPortal = sidebarEl && createPortal(
    <div className="bhq-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <SectionLabel T={T} style={{ marginBottom: 8 }}>Performance Intelligence</SectionLabel>
      <div style={{ paddingBottom: 12 }}>
        <SectionLabel T={T} style={{ marginBottom: 8, fontSize: 11 * (T.fsScale || 1) }}>Period</SectionLabel>
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          {[["all", "All"], ["month", "Mo"], ["quarter", "Qtr"], ["year", "Yr"]].map(([k, l]) => (
            <button key={k} className={periodGrain === k ? undefined : "bhq-row"} onClick={() => setPeriodGrain(k)}
              style={{ flex: 1, padding: "6px 0", borderRadius: T.r6, border: `1.5px solid ${periodGrain === k ? T.accentHover : T.border}`, background: periodGrain === k ? T.accentBg : "transparent", color: periodGrain === k ? T.text : T.textMuted, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontWeight: periodGrain === k ? 700 : 400, fontFamily: T.font }}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 10 * (T.fsScale || 1), color: T.textMuted, width: 28 }}>From</span>
          <input type="month" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "5px 7px", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, outline: "none" }} />
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 10 * (T.fsScale || 1), color: T.textMuted, width: 28 }}>To</span>
          <input type="month" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "5px 7px", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, outline: "none" }} />
        </div>
        {forecast ? (
          <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, lineHeight: 1.5 }}>
            {labelForPeriod(forecast.bucket.periodType, forecast.bucket.periodStart)} in progress — {forecast.elapsedDays} of {forecast.totalDays} days elapsed
          </div>
        ) : (
          <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, lineHeight: 1.5 }}>
            {periodBuckets.length} period{periodBuckets.length === 1 ? "" : "s"} in range
          </div>
        )}
      </div>
      <Divider T={T} />
      <div style={{ padding: "12px 0" }}>
        <SectionLabel T={T} style={{ marginBottom: 6, fontSize: 11 * (T.fsScale || 1) }}>Funnel metrics</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
          {ABSOLUTE_METRIC_OPTIONS.map((m) => {
            const on = metrics.includes(m.key);
            return (
              <button key={m.key} onClick={() => toggleMetric(m.key)}
                style={{ fontSize: 11 * (T.fsScale || 1), background: on ? T.accentBg : "transparent", border: `1px solid ${on ? T.accentBorder : T.border}`, color: on ? T.text : T.textMuted, borderRadius: T.r14, padding: "2px 9px", cursor: "pointer", fontFamily: T.font, fontWeight: 500 }}>
                {m.label}
              </button>
            );
          })}
        </div>
        <SectionLabel T={T} style={{ marginBottom: 6, fontSize: 11 * (T.fsScale || 1) }}>Cost &amp; conversion</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: CUSTOM_METRIC_OPTIONS.length ? 10 : 0 }}>
          {DERIVED_METRIC_OPTIONS.map((m) => {
            const on = metrics.includes(m.key);
            return (
              <button key={m.key} onClick={() => toggleMetric(m.key)}
                style={{ fontSize: 11 * (T.fsScale || 1), background: on ? T.accentBg : "transparent", border: `1px solid ${on ? T.accentBorder : T.border}`, color: on ? T.text : T.textMuted, borderRadius: T.r14, padding: "2px 9px", cursor: "pointer", fontFamily: T.font, fontWeight: 500 }}>
                {m.label}
              </button>
            );
          })}
        </div>
        {/* Custom metrics (2026-08-08, per Mo) — built in Settings, only shown here once at least
            one exists so a workspace that hasn't defined any doesn't see an empty section. */}
        {CUSTOM_METRIC_OPTIONS.length > 0 && (
          <>
            <SectionLabel T={T} style={{ marginBottom: 6, fontSize: 11 * (T.fsScale || 1) }}>Custom</SectionLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {CUSTOM_METRIC_OPTIONS.map((m) => {
                const on = metrics.includes(m.key);
                return (
                  <button key={m.key} onClick={() => toggleMetric(m.key)}
                    style={{ fontSize: 11 * (T.fsScale || 1), background: on ? T.accentBg : "transparent", border: `1px solid ${on ? T.accentBorder : T.border}`, color: on ? T.text : T.textMuted, borderRadius: T.r14, padding: "2px 9px", cursor: "pointer", fontFamily: T.font, fontWeight: 500 }}>
                    {m.label}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
      <Divider T={T} />
      <div style={{ padding: "12px 0", display: "flex", flexDirection: "column", gap: 10 }}>
        <SectionLabel T={T} style={{ marginBottom: 2 }}>Summary</SectionLabel>
        {activeMetricColumns.slice(0, 6).map((c) => (
          <PixelPanel key={c.key} T={T} contentStyle={{ padding: "12px 14px", background: T.bg }}>
            <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 600, color: T.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: 19 * (T.fsScale || 1), fontWeight: 700, color: T.text, fontFamily: T.font }}>{fmtMetric(grandTotals[c.key], c.money, c.pct)}</div>
            {forecast && forecast.projected[c.key] !== undefined && (
              <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.accent, marginTop: 4 }}>Proj. {fmtMetric(forecast.projected[c.key], c.money, c.pct)}</div>
            )}
          </PixelPanel>
        ))}
        {activeMetricColumns.length === 0 && <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>Select a metric above to see it here.</div>}
      </div>
    </div>,
    sidebarEl
  );

  if (rows === null && !loadError) {
    return (
      <>
        {sidebarPortal}
        <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading…</div>
      </>
    );
  }

  return (
    <>
      {sidebarPortal}
      <div style={{ padding: 24, overflow: "auto", height: "100%", boxSizing: "border-box", fontFamily: T.font }}>
        {loadError && (
          <div style={{ padding: "9px 12px", background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.danger, marginBottom: 16 }}>
            {loadError}
          </div>
        )}

        {rows.length === 0 && !loadError ? (
          <PixelPanel T={T} contentStyle={{ padding: 40, textAlign: "center" }}>
            <div style={{ fontSize: 15 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Nothing imported yet</div>
            <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub }}>Import a file in Pipeline Tagger first.</div>
          </PixelPanel>
        ) : (
          <>
            {/* Filter toolbar — see this file's top "FILTER SYSTEM" doc comment. */}
            <div style={{ border: `1px solid ${T.border}`, borderRadius: T.r8, background: T.surfaceEl, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", flexWrap: "wrap" }}>
                <button onClick={() => setFiltersOpen((o) => !o)} title={filtersOpen ? "Hide filters" : "Show filters"}
                  style={{ display: "flex", alignItems: "center", gap: 5, background: filtersOpen ? T.surfaceHover : "transparent", border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "3px 8px", cursor: "pointer", fontFamily: T.font, fontSize: 11 * (T.fsScale || 1), fontWeight: 600, color: T.text, outline: "none" }}>
                  <Icon name="filter" size={12} color={T.text} />
                  Filters
                  {hasF && <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.accent, flexShrink: 0 }} />}
                </button>
                {!filtersOpen && hasF && <button onClick={clearF} style={{ background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, textDecoration: "underline", padding: 0, outline: "none" }}>Clear filters</button>}
                <div style={{ width: 1, height: 16, background: T.border }} />
                <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>Slice by</span>
                <Sel value={sliceBy} onChange={setSliceBy} T={T} style={{ width: 160 }}>
                  {sliceOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Sel>
                <input
                  value={fSearch}
                  onChange={(e) => setFSearch(e.target.value)}
                  placeholder={`Search ${sliceOptions.find((o) => o.value === sliceBy)?.label.toLowerCase() || "value"}…`}
                  style={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font, width: 190 }}
                />
                <span style={{ marginLeft: "auto", fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>
                  {filteredSliceGroups.length} group{filteredSliceGroups.length === 1 ? "" : "s"} · {searchedRows.length} row{searchedRows.length === 1 ? "" : "s"}
                </span>
              </div>

              {filtersOpen && (
                <div style={{ display: "flex", padding: "3px 12px 12px", gap: 10, alignItems: "start", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 210, flex: "1.4 1 210px", display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", gap: 3 }}>
                      <IconField icon="search" color={T.textMuted}>
                        <input value={fCampaignName} onChange={(e) => setFCampaignName(e.target.value)} placeholder="Campaign contains… (a, b)" style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px 6px 26px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      </IconField>
                      <MatchModeToggle mode={fCampaignNameInclMode} onChange={setFCampaignNameInclMode} T={T} />
                    </div>
                    <div style={{ display: "flex", gap: 3 }}>
                      <input value={fCampaignNameExclude} onChange={(e) => setFCampaignNameExclude(e.target.value)} placeholder="≠ excludes… (a, b)" style={{ ...fIn, flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      <MatchModeToggle mode={fCampaignNameExclMode} onChange={setFCampaignNameExclMode} T={T} />
                    </div>
                  </div>
                  <div style={{ minWidth: 190, flex: "1.2 1 190px", display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", gap: 3 }}>
                      <IconField icon="search" color={T.textMuted}>
                        <input value={fAdGroup} onChange={(e) => setFAdGroup(e.target.value)} placeholder="Ad Group contains… (a, b)" style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px 6px 26px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      </IconField>
                      <MatchModeToggle mode={fAdGroupInclMode} onChange={setFAdGroupInclMode} T={T} />
                    </div>
                    <div style={{ display: "flex", gap: 3 }}>
                      <input value={fAdGroupExclude} onChange={(e) => setFAdGroupExclude(e.target.value)} placeholder="≠ excludes… (a, b)" style={{ ...fIn, flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      <MatchModeToggle mode={fAdGroupExclMode} onChange={setFAdGroupExclMode} T={T} />
                    </div>
                  </div>
                  <div style={{ width: 150, flexShrink: 0 }}>
                    <select value={fChannel} onChange={(e) => setFChannel(e.target.value)} style={{ width: "100%", cursor: "pointer", border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text, fontFamily: T.font }}>
                      <option value="">All channels</option>
                      {distinctChannels.map((ch) => <option key={ch} value={ch}>{ch}</option>)}
                    </select>
                  </div>
                  <div style={{ minWidth: 220, flex: "1.6 1 220px", display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", gap: 4 }}>
                      <IconField icon="search" color={T.textMuted}>
                        <input value={fTag} onChange={(e) => setFTag(e.target.value)} placeholder="Tag contains… (a, b)" style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px 6px 26px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      </IconField>
                      <MatchModeToggle mode={fTagInclMode} onChange={setFTagInclMode} T={T} />
                      <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} style={{ width: 120, cursor: "pointer", border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text, fontFamily: T.font }}>
                        <option value="all">All</option>
                        <option value="tagged">Tagged</option>
                        <option value="untagged">Needs review</option>
                      </select>
                      {hasF && <button onClick={clearF} style={{ background: T.dangerBg, border: `1px solid ${T.danger}`, color: T.danger, borderRadius: T.r6, padding: "0 8px", cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, whiteSpace: "nowrap" }}>Clear ×</button>}
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <input value={fTagExclude} onChange={(e) => setFTagExclude(e.target.value)} placeholder="≠ tag excludes… (a, b)" style={{ ...fIn, flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      <MatchModeToggle mode={fTagExclMode} onChange={setFTagExclMode} T={T} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Trend chart — single metric at a time (mixed count/$/% scales don't chart together
                legibly), switchable via the Sel below; rates/cost-per stay table-only (see
                CHARTABLE_METRICS above). */}
            <PixelPanel T={T} contentStyle={{ padding: 16, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>Trend</div>
                <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>Compare up to {MAX_CHART_METRICS}</div>
              </div>
              {/* Multi-select (2026-08-09, per Mo — "select up to three metrics to view month by
                  month or quarter by quarter") — was a single-metric Sel dropdown; still limited to
                  CHARTABLE_METRICS (absolute counts/$ only, same as before) since a rate/cost-per's
                  scale doesn't chart meaningfully next to a raw count/dollar figure. Each selected
                  metric becomes its own colored series in the grouped-bar chart below; buttons past
                  the 3rd disable themselves rather than silently doing nothing. */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
                {CHARTABLE_METRICS.map((m) => {
                  const on = chartMetrics.includes(m.key);
                  const atCap = !on && chartMetrics.length >= MAX_CHART_METRICS;
                  const color = on ? CHART_SERIES_COLORS[chartMetrics.indexOf(m.key) % CHART_SERIES_COLORS.length] : null;
                  return (
                    <button key={m.key} onClick={() => toggleChartMetric(m.key)} disabled={atCap}
                      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 * (T.fsScale || 1), background: on ? T.accentBg : "transparent", border: `1px solid ${on ? T.accentBorder : T.border}`, color: atCap ? T.textMuted : on ? T.text : T.textSub, borderRadius: T.r14, padding: "2px 9px", cursor: atCap ? "not-allowed" : "pointer", fontFamily: T.font, fontWeight: 500, opacity: atCap ? 0.5 : 1 }}>
                      {on && <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />}
                      {m.label}
                    </button>
                  );
                })}
              </div>
              {periodBuckets.length === 0 ? (
                <div style={{ padding: "24px 0", textAlign: "center", color: T.textMuted, fontSize: 12 * (T.fsScale || 1) }}>No periods match your filters.</div>
              ) : chartSeries.length === 0 ? (
                <div style={{ padding: "24px 0", textAlign: "center", color: T.textMuted, fontSize: 12 * (T.fsScale || 1) }}>Select a metric above to chart it.</div>
              ) : (
                <TrendMiniChart T={T} periods={periodBuckets.map((b) => labelForPeriod(b.periodType, b.periodStart))} series={chartSeries} hasForecast={!!forecast} />
              )}
            </PixelPanel>

            {/* Trend by period — every selected metric as a column, one row per period bucket. */}
            <PixelPanel T={T} contentStyle={{ padding: 0, marginBottom: 16 }}>
              <div style={{ padding: "12px 16px", fontSize: 13 * (T.fsScale || 1), fontWeight: 700, color: T.text, borderBottom: `1px solid ${T.border}` }}>Trend by period</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 * (T.fsScale || 1) }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                      {["Period", "Rows", ...activeMetricColumns.map((c) => c.label)].map((h, i) => (
                        <th key={i} style={{ padding: "8px 10px", fontSize: 10 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: i >= 2 ? "right" : "left" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {periodBuckets.length === 0 && (
                      <tr><td colSpan={2 + activeMetricColumns.length} style={{ padding: "32px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>No periods match your filters.</td></tr>
                    )}
                    {periodBuckets.map((b, i) => {
                      const isForecastRow = forecast && i === periodBuckets.length - 1;
                      return (
                        <tr key={b.key} className="bhq-row" style={{ borderBottom: `1px solid ${T.border}` }}>
                          <td style={{ padding: "8px 10px", fontWeight: 600, color: T.text }}>
                            {labelForPeriod(b.periodType, b.periodStart)}
                            {isForecastRow && <Pill color={T.accent} bg={T.accentBg} border={T.accentBorder} style={{ marginLeft: 8, fontSize: 10 * (T.fsScale || 1) }}>in progress</Pill>}
                          </td>
                          <td style={{ padding: "8px 10px", color: T.textSub, fontSize: 12 * (T.fsScale || 1) }}>{b.rows.length}</td>
                          {activeMetricColumns.map((c) => (
                            <td key={c.key} style={{ padding: "8px 10px", color: T.text, textAlign: "right" }}>
                              {fmtMetric(b.metrics[c.key], c.money, c.pct)}
                              {isForecastRow && forecast.projected[c.key] !== undefined && (
                                <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.accent }}>proj. {fmtMetric(forecast.projected[c.key], c.money, c.pct)}</div>
                              )}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                  {periodBuckets.length > 0 && (
                    <tfoot>
                      <tr style={{ borderTop: `2px solid ${T.border}` }}>
                        <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>Total</td>
                        <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text, fontSize: 12 * (T.fsScale || 1) }}>{searchedRows.length}</td>
                        {activeMetricColumns.map((c) => (
                          <td key={c.key} style={{ padding: "8px 10px", fontWeight: 700, color: T.text, textAlign: "right" }}>{fmtMetric(grandTotals[c.key], c.money, c.pct)}</td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </PixelPanel>

            {/* Breakdown by dimension — unchanged shape from v1, now driven by the same selected
                metric columns as the trend table above instead of a derived/capped column list. */}
            <PixelPanel T={T} contentStyle={{ padding: 0 }}>
              <div style={{ padding: "12px 16px", fontSize: 13 * (T.fsScale || 1), fontWeight: 700, color: T.text, borderBottom: `1px solid ${T.border}` }}>
                Breakdown by {sliceOptions.find((o) => o.value === sliceBy)?.label || "Slice"}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 * (T.fsScale || 1) }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                      {[sliceOptions.find((o) => o.value === sliceBy)?.label || "Slice", "Rows", ...activeMetricColumns.map((c) => c.label)].map((h, i) => (
                        <th key={i} style={{ padding: "8px 10px", fontSize: 10 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: i >= 2 ? "right" : "left" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSliceGroups.length === 0 && (
                      <tr><td colSpan={2 + activeMetricColumns.length} style={{ padding: "32px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>No groups match your filters.</td></tr>
                    )}
                    {filteredSliceGroups.map((g) => (
                      <tr key={g.key} className="bhq-row" style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td style={{ padding: "8px 10px", fontWeight: 600, color: T.text, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={g.key}>{g.key}</td>
                        <td style={{ padding: "8px 10px", color: T.textSub, fontSize: 12 * (T.fsScale || 1) }}>{g.rows.length}</td>
                        {activeMetricColumns.map((c) => (
                          <td key={c.key} style={{ padding: "8px 10px", color: T.text, textAlign: "right" }}>{fmtMetric(g.metrics[c.key], c.money, c.pct)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {filteredSliceGroups.length > 0 && (
                    <tfoot>
                      <tr style={{ borderTop: `2px solid ${T.border}` }}>
                        <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>Total</td>
                        <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text, fontSize: 12 * (T.fsScale || 1) }}>{searchedRows.length}</td>
                        {activeMetricColumns.map((c) => (
                          <td key={c.key} style={{ padding: "8px 10px", fontWeight: 700, color: T.text, textAlign: "right" }}>{fmtMetric(grandTotals[c.key], c.money, c.pct)}</td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </PixelPanel>
          </>
        )}
      </div>
    </>
  );
}

// Simple grouped bar chart — one bar per period bucket for a single metric, plus a lighter
// "projected" bar appended after the last actual bar when the most recent period is still in
// progress (see this file's top FORECAST doc comment). Deliberately much simpler than
// PacingDashboard's own TrendBarChart (no dense/multi-series layout branch) since this only ever
// plots one metric at a time — mixed count/$/% scales don't share an axis meaningfully.
// Reworked 2026-08-09 (per Mo — "select up to three metrics to view month by month or quarter by
// quarter") from a single-series bar chart into a grouped-bar chart: one differently-colored bar
// per selected metric within each period's slot, sharing one linear Y axis. A shared axis is a
// deliberate simplification — mixing e.g. Spend ($) with a small count metric can make one series
// look flat next to the other, but a real dual/independent-axis chart is a much bigger build than
// this tab's existing "simple, honest, table-backed" charts elsewhere, and most real comparisons
// (spend vs. pipeline value, or leads vs. MQLs vs. SQLs) sit at roughly the same order of magnitude
// anyway. Y-axis tick labels only get a "$" prefix when EVERY selected series is a money metric —
// mixing money and count series shows plain numbers rather than mislabeling a count as a dollar
// figure. Each bar carries a native SVG <title> so the exact value is still available on hover
// regardless of how the shared axis renders it.
function TrendMiniChart({ T, periods, series, hasForecast }) {
  const H = 200, padL = 56, padB = 30, padT = 12, padR = 16;
  const n = periods.length + (hasForecast ? 1 : 0);
  const W = 720;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const seriesCount = Math.max(1, series.length);
  const groupGap = Math.min(18, (plotW / n) * 0.3);
  const groupW = plotW / n - groupGap;
  const barGap = 3;
  const barW = Math.max(3, (groupW - barGap * (seriesCount - 1)) / seriesCount);
  const allMoney = series.length > 0 && series.every((s) => s.money);
  const allValues = series.flatMap((s) => (hasForecast ? [...s.values, s.projectedValue || 0] : s.values));
  const maxY = Math.max(1, ...allValues);
  const yFor = (v) => padT + plotH - (v / maxY) * plotH;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxY * f));
  const fmtTick = (v) => { const prefix = allMoney ? "$" : ""; return v >= 1000 ? `${prefix}${Math.round(v / 1000)}k` : `${prefix}${v}`; };
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {yTicks.map((t, i) => {
          const y = yFor(t);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke={T.border} strokeWidth={1} />
              <text x={padL - 8} y={y + 3} textAnchor="end" fontSize={9} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>{fmtTick(t)}</text>
            </g>
          );
        })}
        {periods.map((p, i) => {
          const groupX = padL + i * (groupW + groupGap);
          return (
            <g key={p + i}>
              {series.map((s, si) => {
                const v = s.values[i] || 0;
                const h = (v / maxY) * plotH;
                const x = groupX + si * (barW + barGap);
                return (
                  <rect key={s.key} x={x} y={padT + plotH - h} width={barW} height={h} fill={s.color} rx={2}>
                    <title>{s.label}: {v.toLocaleString()}</title>
                  </rect>
                );
              })}
              <text x={groupX + groupW / 2} y={H - padB + 14} textAnchor="middle" fontSize={9} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>{p}</text>
            </g>
          );
        })}
        {hasForecast && (
          <g>
            {(() => {
              const groupX = padL + periods.length * (groupW + groupGap);
              return (
                <>
                  {series.map((s, si) => {
                    const v = s.projectedValue || 0;
                    const h = (v / maxY) * plotH;
                    const x = groupX + si * (barW + barGap);
                    return (
                      <rect key={s.key} x={x} y={padT + plotH - h} width={barW} height={h} fill={s.color} opacity={0.35} rx={2}>
                        <title>{s.label} (proj.): {v.toLocaleString()}</title>
                      </rect>
                    );
                  })}
                  <text x={groupX + groupW / 2} y={H - padB + 14} textAnchor="middle" fontSize={9} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>proj.</text>
                </>
              );
            })()}
          </g>
        )}
      </svg>
      {series.length > 1 && (
        <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginTop: 4 }}>
          {series.map((s) => (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: T.textSub, fontFamily: "'DM Sans',sans-serif" }}>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
