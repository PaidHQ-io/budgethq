import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PixelPanel, SectionLabel, Sel, Icon, Pill, IconField, MatchModeToggle, Divider } from "./shared.jsx";
import { listReportingFacts } from "../lib/reportingApi.js";
import { getReportingColumnViews, putReportingColumnViews } from "../lib/workspaceApi.js";
import {
  fmtMetric, isRateMetric, isMoneyMetric, labelForMetricKey,
  computeDerivedPipelineMetrics, DERIVED_PIPELINE_METRICS,
  computeCustomMetrics,
} from "../lib/reportingMetrics.js";
import { PIPELINE_METRIC_MAP_OPTIONS, AD_GROUP_TAG_KEY, CHANNEL_TAG_KEY } from "../lib/pipelineColumnMapping.js";
import { stepPeriodStart, labelForPeriod, normalizePeriodStart } from "../lib/reportingPeriods.js";
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
// CUSTOM DIMENSIONS + SAVED VIEWS (2026-08-17, per Mo — "rather than try to merge rows [when ad
// platform campaign names and CRM UTM-based campaign names don't match the same campaign], we
// should build reports based on filtering and then custom dimensions... look at performance trends
// regardless of whether or not UTM parameters or campaign names changed... an easy way to view
// those reports/trends as well as save a whole bunch of views for easy access").
//
// Two-tier design (confirmed with Mo before building):
//   - A CUSTOM DIMENSION (pipelineDimensions, workspace-persisted) is just a NAMED, SAVED snapshot
//     of this toolbar's own filter fields — Campaign contains/excludes+mode, Ad Group
//     contains/excludes+mode, Channel, Tag contains/excludes+mode. It's a live rule re-evaluated
//     against whatever rows exist at view time (via the exact same filteredRows predicate every
//     other filter already runs through), NOT a static per-campaign tag lookup — so it keeps
//     matching a segment like "SPS NA, non-brand, non-competitor" even after next month's import
//     shows up under a slightly different literal campaign/UTM string, as long as it still matches
//     the same contains/excludes terms. Dimensions can overlap (a row may satisfy more than one) —
//     deliberately NOT mutually-exclusive buckets like the existing Tag Dimensions/tagDims system
//     (that's a different, older feature: a manual per-campaign categorical tag, e.g. Product ∈
//     {A,B,C}, still used for Slice By/Breakdown below and untouched by this feature).
//   - A SAVED VIEW (pipelineViews, workspace-persisted) is a full report snapshot: which Custom
//     Dimension to scope down to (dimensionId, nullable = "all campaigns"), plus this tab's own
//     display config (Slice by, selected funnel/cost metrics, chart metrics, period grain/range,
//     hide-empty-rows). Views REFERENCE a dimension by id rather than embedding a frozen copy of its
//     filter fields, so refining a dimension's rule later (e.g. adding an excluded term) improves
//     every view built on it automatically. If a view's referenced dimension is later deleted,
//     applying that view falls back to "all campaigns" (see applyPipelineView) rather than erroring.
// activeDimensionId below is a plain "last applied" hint (not a live equality check against the
// current filter fields) — same simplification this file already documents elsewhere for cheap,
// good-enough UX (e.g. hasNoSelectedMetricData) rather than perfect state tracking.
const DIMENSION_FIELD_KEYS = ["fCampaignName", "fCampaignNameExclude", "fCampaignNameInclMode", "fCampaignNameExclMode", "fAdGroup", "fAdGroupExclude", "fAdGroupInclMode", "fAdGroupExclMode", "fChannel", "fTag", "fTagExclude", "fTagInclMode", "fTagExclMode"];

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

// Generic column-sort for the three tables below (2026-08-10, per Mo — "sortable"). `getLabelSort`
// returns the value the "label" column (Period, or the slice/campaign key) sorts by — a raw ISO
// date string for periods (chronological) or the group's own label for breakdown/campaign
// (alphabetical); `getRowsCount` returns the row count for the Rows column. sort.key===null is the
// caller's cue to fall back to that table's own default order instead of calling this at all.
// Undefined/missing metric values always sort last regardless of direction — same "don't pretend a
// missing value is a 0" convention this file already uses when DISPLAYING a metric (fmtMetric's
// "—" for undefined).
function applySort(items, sort, getLabelSort, getRowsCount) {
  if (!sort.key) return items;
  const dirMul = sort.dir === "asc" ? 1 : -1;
  return items.slice().sort((a, b) => {
    let av, bv;
    if (sort.key === "__label__") { av = getLabelSort(a); bv = getLabelSort(b); }
    else if (sort.key === "__rows__") { av = getRowsCount(a); bv = getRowsCount(b); }
    else { av = a.metrics[sort.key]; bv = b.metrics[sort.key]; }
    const aU = av === undefined || av === null, bU = bv === undefined || bv === null;
    if (aU && bU) return 0;
    if (aU) return 1;
    if (bU) return -1;
    if (typeof av === "string" || typeof bv === "string") return dirMul * String(av).localeCompare(String(bv));
    return dirMul * (av - bv);
  });
}

// Sortable <th> shared by the Trend-by-period, Breakdown, and Campaign tables — click toggles sort
// on that column (asc/desc), with a small ▲/▼ marking whichever column is currently active.
function SortTh({ label, sortKey, sort, onSort, align, T }) {
  const active = sort.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} title="Click to sort"
      style={{ padding: "8px 10px", fontSize: 10 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: active ? T.text : T.textMuted, textAlign: align, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      {label}{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}

// Static, non-sortable "#" row-number column — shared by all three tables (Trend by period,
// Breakdown, By Campaign) plus the Breakdown table's nested per-campaign drill-down (2026-08-19, per
// Mo — "add a row number to the campaign tagger and pipeline tagger"). Numbers reflect the table's
// current sort/filter order (row 1 is whatever's on top right now, not a stable per-record id) —
// that's the useful thing here: "row 12" is unambiguous when talking through a table together, and
// it stays meaningful after re-sorting since it's always "position on screen right now." Not
// sortable itself (nothing to sort by) and not exported to CSV (the export functions below key off
// the underlying row/group objects, not the rendered table, so adding this didn't touch them).
function NumTh({ T, small }) {
  return (
    <th style={{ padding: small ? "6px 8px" : "8px 10px", fontSize: (small ? 9 : 10) * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: "right", width: small ? 26 : 32 }}>#</th>
  );
}
function NumTd({ T, n, small }) {
  return (
    <td style={{ padding: small ? "6px 8px" : "8px 10px", color: T.textMuted, fontSize: (small ? 11 : 12) * (T.fsScale || 1), textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n}</td>
  );
}

// GRAIN ROLL-UP (2026-08-14, per Mo — "when I select QTR or YR in the filter, everything
// disappears. Are we not aggregating across months to get to quarter and across months to get to
// year?"): reporting_facts rows can be imported at month, quarter, OR year grain (whatever the
// source file actually reported), and most real imports are monthly. The Period sidebar's grain
// picker used to mean "show ONLY rows literally tagged at this exact periodType" — selecting Qtr on
// an all-monthly dataset filtered every row out, since none of them were natively "quarter" rows.
// GRAIN_RANK gives month/quarter/year a coarseness order; periodStartAtGrain rolls a row's own
// native period UP to a coarser target grain (month -> its containing quarter/year, quarter -> its
// containing year) by truncating to that grain's own start date — returns null if the row is
// ALREADY coarser than the target (a year row can't be expressed as one quarter, so it's excluded
// rather than guessed at). This is a legitimate, lossless aggregation: every absolute metric these
// rows carry is safe to sum (see this file's top METRIC ROLLUP CORRECTNESS comment) regardless of
// which finer periods it's being re-summed across.
// BUGFIX (2026-08-14, per Mo — "the quarterly aggregate isn't working properly, its just adding
// everything together and saying its for Q1, 2001"): this used to hand-roll its own Date parsing —
// `new Date(`${periodStart}T00:00:00Z`)` — which assumes periodStart is a bare "YYYY-MM-DD" string.
// It isn't always: reporting_facts' period_start comes back from the API as whatever the Postgres
// driver serializes a `date` column to, which can already carry a full timestamp (e.g.
// "2024-01-01T00:00:00.000Z"). Appending another "T00:00:00Z" onto THAT produced a doubly-stamped,
// malformed string — V8's lenient Date parser didn't reject it outright, it just misparsed it into
// some other (wrong, but valid-looking) date, and since every row's periodStart has that same
// mangled SUFFIX shape, every row landed on the exact same misparsed result — hence "every row
// collapses into one bucket" instead of five different quarters. reportingPeriods.js already has a
// robust parser for exactly this ambiguity (parseDateUTC, used by normalizePeriodStart below) — a
// regex that matches a YYYY-MM-DD prefix and ignores whatever follows it, so it doesn't matter if
// periodStart is a bare date or a full timestamp. Reusing that instead of a second, fragile parser.
const GRAIN_RANK = { month: 0, quarter: 1, year: 2 };
function periodStartAtGrain(periodType, periodStart, targetGrain) {
  if (GRAIN_RANK[periodType] === undefined || GRAIN_RANK[targetGrain] === undefined) return null;
  if (GRAIN_RANK[periodType] > GRAIN_RANK[targetGrain]) return null; // too coarse to express at a finer/equal target
  if (periodType === targetGrain) return periodStart;
  return normalizePeriodStart(targetGrain, periodStart);
}

// One bucket per exact (periodType, periodStart) pair actually present in the filtered rows when NO
// target grain is given ("All" — a quarter-imported row is never split into 3 months, a run of
// monthly rows is never merged up into a quarter, so a bucket's own total is exactly what was
// imported for it). When a targetGrain IS given (Qtr/Yr picked in the sidebar — see the GRAIN
// ROLL-UP comment above), every row's own periodStart is first rolled up to that grain via
// periodStartAtGrain before bucketing, so e.g. 3 monthly rows in the same quarter correctly become
// ONE summed quarter bucket instead of 3 separate (and, before this fix, entirely hidden) ones.
// Sorted chronologically by periodStart for the trend chart/table either way.
function bucketByPeriod(rows, targetGrain) {
  const map = new Map();
  (rows || []).forEach((r) => {
    if (!r.periodStart) return;
    const periodType = targetGrain && targetGrain !== "all" ? targetGrain : r.periodType;
    const periodStart = targetGrain && targetGrain !== "all" ? periodStartAtGrain(r.periodType, r.periodStart, targetGrain) : r.periodStart;
    if (!periodStart) return; // upstream row filter already excludes these; guarded here too
    const key = `${periodType}|${periodStart}`;
    if (!map.has(key)) map.set(key, { key, periodType, periodStart, rows: [], metrics: {} });
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
// safeStart re-normalizes the raw periodStart through normalizePeriodStart before building a Date
// from it (2026-08-14 — same bugfix as periodStartAtGrain above: the raw value from the API isn't
// guaranteed to be a bare "YYYY-MM-DD" string, and blindly appending "T00:00:00Z" onto something
// that already has its own time/zone suffix produces a malformed string a lenient Date parser can
// silently misparse). stepPeriodStart already goes through the same robust parser internally and
// always returns a clean toISO() string, so nextStart never needed this — only the raw `periodStart`
// input did.
function periodBounds(periodType, periodStart) {
  const safeStart = normalizePeriodStart(periodType, periodStart) || periodStart;
  const start = new Date(`${safeStart}T00:00:00Z`);
  const nextStart = stepPeriodStart(periodType, periodStart);
  const end = nextStart ? new Date(`${nextStart}T00:00:00Z`) : null;
  return { start, end };
}

const fIn = { background: "transparent", border: "none", outline: "none", width: "100%" };

export default function PipelineTagger({ T, session, workspace, tagDims, customMetrics, sidebarEl, pipelineDimensions, setPipelineDimensions, pipelineViews, setPipelineViews, canEdit = true }) {
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

  // Custom Dimensions + Saved Views — see this file's top doc comment for the full design. All UI
  // state here is transient (plain useState) — only the dimensions/views lists themselves
  // (pipelineDimensions/pipelineViews, passed down from PaidHQ.jsx) are workspace-persisted.
  const [activeDimensionId, setActiveDimensionId] = useState(null);
  const [dimensionsMenuOpen, setDimensionsMenuOpen] = useState(false);
  const [dimensionModalOpen, setDimensionModalOpen] = useState(false);
  const [dimensionNameDraft, setDimensionNameDraft] = useState("");
  const [viewsMenuOpen, setViewsMenuOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewNameDraft, setViewNameDraft] = useState("");
  const [notif, setNotif] = useState(null);
  const showNotif = (msg) => { setNotif(msg); setTimeout(() => setNotif(null), 3000); };
  const activeDimension = (pipelineDimensions || []).find((d) => d.id === activeDimensionId) || null;

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
  // metrics we want to compare and review and analyze, just like the pipeline tagger"). Drives the
  // sidebar's own Summary stat tiles ONLY — see PER-TABLE COLUMNS below for the three tables' own,
  // independent column sets (2026-08-17 rework).
  const [metrics, setMetrics] = usePersistentState("paidhq_reporting_intel_metrics", DEFAULT_METRICS);

  // PER-TABLE COLUMNS (2026-08-17, per Mo — "I need to be able to adjust the columns in these
  // tables so I can move metrics/fields, add new ones..., and remove existing ones. I also need to
  // be able to save column views at the user level... Each table and the graph should be
  // independent"). Trend by period / Breakdown / By Campaign each get their OWN ordered column list
  // plus their own named saved presets — replacing the single shared `metrics` selection those three
  // tables used to all read from together. The Trend chart stays on its own separate, pre-existing
  // chartMetrics selection above (already independent of the tables, per Mo's own framing) — this
  // rework only touches the three tables' column sets, not the chart's.
  //
  // Stored server-side per (workspace, user) — see api/workspaces/[id]/reporting-column-views.js —
  // rather than usePersistentState's localStorage, since "at the user level" specifically means
  // following the user across devices/browsers, not just this one machine. Starts from DEFAULT_
  // METRICS locally so the tables render sensibly before the server round-trip resolves, then gets
  // overwritten once loadedColumnViews below actually returns this user's saved state (or confirms
  // there isn't one yet, in which case the default stands).
  const defaultColState = () => ({ activeColumns: DEFAULT_METRICS, views: [], activeViewId: null });
  const [periodColState, setPeriodColState] = useState(defaultColState);
  const [breakdownColState, setBreakdownColState] = useState(defaultColState);
  const [campaignColState, setCampaignColState] = useState(defaultColState);
  const [columnViewsLoaded, setColumnViewsLoaded] = useState(false);
  const columnViewsSaveTimer = useRef(null);

  // Normalizes whatever this user last saved (or an absent/malformed entry) into the full shape
  // every column-state consumer below expects, so a partially-written or pre-this-feature record
  // can't throw off rendering.
  const normalizeColState = (raw) => ({
    activeColumns: Array.isArray(raw?.activeColumns) && raw.activeColumns.length ? raw.activeColumns : DEFAULT_METRICS,
    views: Array.isArray(raw?.views) ? raw.views : [],
    activeViewId: raw?.activeViewId ?? null,
  });

  useEffect(() => {
    if (!workspace?.id || !session) return;
    getReportingColumnViews(session, workspace.id)
      .then((data) => {
        setPeriodColState(normalizeColState(data.periodTable));
        setBreakdownColState(normalizeColState(data.breakdownTable));
        setCampaignColState(normalizeColState(data.campaignTable));
      })
      .catch((err) => console.error("[reporting column views load]", err))
      .finally(() => setColumnViewsLoaded(true));
  }, [session, workspace?.id]);

  // Debounced save, same shape as PaidHQ.jsx's own workspace-config save — guarded on
  // columnViewsLoaded so the initial mount (still holding the DEFAULT_METRICS placeholder in all
  // three, before the fetch above resolves) can never race ahead and overwrite this user's actual
  // saved state with the placeholder default.
  useEffect(() => {
    if (!workspace?.id || !session || !columnViewsLoaded) return;
    clearTimeout(columnViewsSaveTimer.current);
    columnViewsSaveTimer.current = setTimeout(() => {
      putReportingColumnViews(session, workspace.id, {
        periodTable: periodColState, breakdownTable: breakdownColState, campaignTable: campaignColState,
      }).catch((err) => console.error("[reporting column views save]", err));
    }, 700);
    return () => clearTimeout(columnViewsSaveTimer.current);
  }, [periodColState, breakdownColState, campaignColState, workspace?.id, session, columnViewsLoaded]);

  // One set of handlers per table, all sharing the same shape — toggling/reordering/saving/applying/
  // deleting a column or a saved preset. Plain factory (not useCallback) since these just close over
  // whichever state/setState pair they're built from and are cheap to recreate each render, same
  // convention as this file's other non-memoized per-render helpers (e.g. campaignsForGroup).
  const makeColumnHandlers = (state, setState) => ({
    toggleColumn: (key) => setState({
      ...state,
      activeColumns: state.activeColumns.includes(key) ? state.activeColumns.filter((k) => k !== key) : [...state.activeColumns, key],
    }),
    reorderColumns: (fromIndex, toIndex) => {
      if (fromIndex === toIndex) return;
      const next = state.activeColumns.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      setState({ ...state, activeColumns: next });
    },
    saveView: (name) => {
      const trimmed = (name || "").trim();
      if (!trimmed) return;
      const view = { id: `col_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: trimmed, columns: state.activeColumns, createdAt: new Date().toISOString() };
      setState({ ...state, views: [...state.views, view], activeViewId: view.id });
    },
    applyView: (view) => setState({ ...state, activeColumns: view.columns.slice(), activeViewId: view.id }),
    deleteView: (id) => setState({ ...state, views: state.views.filter((v) => v.id !== id), activeViewId: state.activeViewId === id ? null : state.activeViewId }),
  });
  const periodColHandlers = makeColumnHandlers(periodColState, setPeriodColState);
  const breakdownColHandlers = makeColumnHandlers(breakdownColState, setBreakdownColState);
  const campaignColHandlers = makeColumnHandlers(campaignColState, setCampaignColState);
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

  // Table sort + show/hide (2026-08-10, per Mo — "sortable (as do trend by period and breakdown by
  // product)... Add a toggle at the top right of each table to show or hide the table"). Sort state
  // is transient (plain useState, not persisted — same convention persist.js documents for
  // selection/UI state), one { key, dir } pair per table; key===null means "use that table's own
  // natural default order" (chronological for periods, biggest-group-first for breakdown/campaign)
  // rather than forcing a sort choice on tables that already had a sensible default. Visibility
  // toggles ARE persisted (usePersistentState) since collapsing a table you don't care about is a
  // real preference worth keeping across a refresh, same tier as filtersOpen.
  const [periodSort, setPeriodSort] = useState({ key: null, dir: "desc" });
  const [breakdownSort, setBreakdownSort] = useState({ key: null, dir: "desc" });
  const [campaignSort, setCampaignSort] = useState({ key: null, dir: "desc" });
  const toggleSort = (setSort, key) => setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "__label__" ? "asc" : "desc" }));
  const [periodTableOpen, setPeriodTableOpen] = usePersistentState("paidhq_reporting_intel_periodTableOpen", true);
  const [breakdownTableOpen, setBreakdownTableOpen] = usePersistentState("paidhq_reporting_intel_breakdownTableOpen", true);
  const [campaignTableOpen, setCampaignTableOpen] = usePersistentState("paidhq_reporting_intel_campaignTableOpen", true);
  // Which table's "Columns" modal is open, if any — null | "period" | "breakdown" | "campaign".
  // Transient (plain useState), not persisted — same tier as every other open/closed dropdown/modal
  // flag in this file.
  const [openColumnsModal, setOpenColumnsModal] = useState(null);
  // Nested Product -> Campaign breakdown (2026-08-11, per Mo — "I need to understand performance
  // trends at the campaign level for each product... it needs to be easy for me to surface"). Only
  // meaningful when Slice by is a TAG dimension (Product, Channel, etc.) — when Slice by is already
  // Campaign, expanding a campaign row into its own campaign breakdown would be a no-op, so the
  // expand control is hidden entirely in that case (the separate always-on "By Campaign" table
  // below already covers that view). Transient (plain useState), not persisted — which rows are
  // expanded is exploratory state, not a saved preference.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const toggleExpandGroup = (key) => setExpandedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // Computed on demand (only for rows actually expanded) rather than eagerly for every group —
  // reuses the exact same aggregateByDimension + derived/custom metric merge every other table
  // here uses, just scoped to one group's own rows instead of all searchedRows. Also respects the
  // "hide empty rows" toggle, against the Breakdown table's OWN active columns (2026-08-17 rework —
  // these nested rows show the same columns as their parent Breakdown table) — hasNoSelectedMetric
  // Data/hideEmptyRows/activeBreakdownColumns are defined further down this component, but this
  // function is only ever CALLED from the JSX further below still, by which point all three are
  // already initialized — same closure-over-later-const pattern is safe here.
  const campaignsForGroup = (g) => {
    const list = aggregateByDimension(g.rows, "campaignName")
      .map((c) => ({ ...c, metrics: { ...c.metrics, ...computeDerivedPipelineMetrics(c.metrics), ...computeCustomMetrics(c.metrics, customMetrics) } }))
      .sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
    return hideEmptyRows ? list.filter((c) => !hasNoSelectedMetricData(c.metrics, activeBreakdownColumns)) : list;
  };

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
      // Grain filter (2026-08-14, per Mo — see the GRAIN ROLL-UP comment on bucketByPeriod above):
      // a row survives if its OWN native grain is the same as or FINER than the selected grain —
      // month/quarter rows both count toward a Qtr/Yr view (they get rolled up), a year row is
      // simply too coarse to express within a Qtr view so it's excluded there, same as it always
      // was for the exact-match "month" case.
      if (periodGrain !== "all" && (GRAIN_RANK[r.periodType] === undefined || GRAIN_RANK[r.periodType] > GRAIN_RANK[periodGrain])) return false;
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
    setActiveDimensionId(null);
  };

  // Custom Dimensions — see this file's top doc comment. Reads/writes exactly the
  // DIMENSION_FIELD_KEYS fields (Campaign/Ad Group contains+excludes+mode, Channel, Tag
  // contains+excludes+mode) — everything else in the toolbar (period, status, search) is left alone
  // when a dimension is applied, since those are "how am I looking at it" prefs, not "which
  // campaigns" prefs.
  const currentDimensionFields = () => ({
    fCampaignName, fCampaignNameExclude, fCampaignNameInclMode, fCampaignNameExclMode,
    fAdGroup, fAdGroupExclude, fAdGroupInclMode, fAdGroupExclMode,
    fChannel, fTag, fTagExclude, fTagInclMode, fTagExclMode,
  });
  const DIMENSION_FIELD_SETTERS = {
    fCampaignName: setFCampaignName, fCampaignNameExclude: setFCampaignNameExclude,
    fCampaignNameInclMode: setFCampaignNameInclMode, fCampaignNameExclMode: setFCampaignNameExclMode,
    fAdGroup: setFAdGroup, fAdGroupExclude: setFAdGroupExclude,
    fAdGroupInclMode: setFAdGroupInclMode, fAdGroupExclMode: setFAdGroupExclMode,
    fChannel: setFChannel, fTag: setFTag, fTagExclude: setFTagExclude,
    fTagInclMode: setFTagInclMode, fTagExclMode: setFTagExclMode,
  };
  const applyDimensionFields = (dim) => {
    DIMENSION_FIELD_KEYS.forEach((k) => {
      const isMode = k.endsWith("InclMode") || k.endsWith("ExclMode");
      DIMENSION_FIELD_SETTERS[k](dim ? (dim[k] ?? (isMode ? "or" : "")) : (isMode ? "or" : ""));
    });
  };
  const openSaveDimensionModal = () => { setDimensionNameDraft(""); setDimensionModalOpen(true); };
  const saveCurrentDimension = () => {
    const name = dimensionNameDraft.trim();
    if (!name) return;
    const dim = { id: `dim_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, createdAt: new Date().toISOString(), ...currentDimensionFields() };
    setPipelineDimensions?.((prev) => [...(prev || []), dim]);
    setActiveDimensionId(dim.id);
    setDimensionModalOpen(false); setDimensionNameDraft("");
    showNotif(`Saved dimension "${name}"`);
  };
  const applyPipelineDimension = (dim) => {
    applyDimensionFields(dim);
    setActiveDimensionId(dim.id);
    setDimensionsMenuOpen(false);
    showNotif(`Applied "${dim.name}"`);
  };
  const deletePipelineDimension = (id, name) => {
    if (!window.confirm(`Delete the "${name}" dimension?\n\nAny saved views built on it will fall back to "All campaigns" when applied.`)) return;
    setPipelineDimensions?.((prev) => (prev || []).filter((d) => d.id !== id));
    if (activeDimensionId === id) setActiveDimensionId(null);
    showNotif("Dimension deleted");
  };

  // Saved Views — a full report snapshot (which dimension to scope to, plus this tab's own display
  // config). References a dimension by id rather than embedding a frozen copy of its filter fields,
  // so refining a dimension later improves every view built on it (see this file's top doc comment).
  const currentViewConfig = () => ({
    dimensionId: activeDimensionId || null,
    sliceBy, metrics, chartMetrics, periodGrain, rangeStart, rangeEnd, hideEmptyRows,
  });
  const openSaveViewModal = () => { setViewNameDraft(""); setViewModalOpen(true); };
  const saveCurrentView = () => {
    const name = viewNameDraft.trim();
    if (!name) return;
    // id-stamping only ever runs from a user click/Enter handler, never during render, exactly like
    // PacingDashboard's own saveCurrentView (same Date.now()/Math.random() pattern there isn't
    // flagged) — the compiler's reachability heuristic just happens to catch this occurrence.
    // eslint-disable-next-line react-hooks/purity
    const view = { id: `pv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, createdAt: new Date().toISOString(), ...currentViewConfig() };
    setPipelineViews?.((prev) => [...(prev || []), view]);
    setViewModalOpen(false); setViewNameDraft("");
    showNotif(`Saved view "${name}"`);
  };
  const applyPipelineView = (view) => {
    const dim = view.dimensionId ? (pipelineDimensions || []).find((d) => d.id === view.dimensionId) : null;
    if (view.dimensionId && !dim) {
      applyDimensionFields(null);
      setActiveDimensionId(null);
    } else if (dim) {
      applyDimensionFields(dim);
      setActiveDimensionId(dim.id);
    } else {
      applyDimensionFields(null);
      setActiveDimensionId(null);
    }
    setSliceBy(view.sliceBy || "campaignName");
    setMetrics(view.metrics || DEFAULT_METRICS);
    setChartMetrics(view.chartMetrics || ["pipeline_value"]);
    setPeriodGrain(view.periodGrain || "all");
    setRangeStart(view.rangeStart || defaultRangeStart);
    setRangeEnd(view.rangeEnd || nowMonthStr);
    setHideEmptyRows(!!view.hideEmptyRows);
    setViewsMenuOpen(false);
    showNotif(view.dimensionId && !dim ? `Applied "${view.name}" — its dimension was deleted, showing all campaigns` : `Applied "${view.name}"`);
  };
  const deletePipelineView = (id, name) => {
    if (!window.confirm(`Delete the "${name}" view?`)) return;
    setPipelineViews?.((prev) => (prev || []).filter((v) => v.id !== id));
    showNotif("View deleted");
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
    () => bucketByPeriod(searchedRows, periodGrain).map((b) => ({ ...b, metrics: { ...b.metrics, ...computeDerivedPipelineMetrics(b.metrics), ...computeCustomMetrics(b.metrics, customMetrics) } })),
    [searchedRows, periodGrain, customMetrics]
  );

  const sliceGroups = useMemo(
    () => aggregateByDimension(searchedRows, sliceBy || null).map((g) => ({ ...g, metrics: { ...g.metrics, ...computeDerivedPipelineMetrics(g.metrics), ...computeCustomMetrics(g.metrics, customMetrics) } })),
    [searchedRows, sliceBy, customMetrics]
  );

  // No longer needs to re-filter by fSearch itself — sliceGroups above is already built from
  // searchedRows, so every group here already matches. Default order (no column clicked yet) is
  // biggest-group-first; applySort takes over once the user clicks a column header.
  const filteredSliceGroups = useMemo(() => {
    if (breakdownSort.key) return applySort(sliceGroups, breakdownSort, (g) => g.key, (g) => g.rows.length);
    return sliceGroups.slice().sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
  }, [sliceGroups, breakdownSort]);

  // Campaign-level table (2026-08-10, per Mo — "I need a campaign level table at the bottom that
  // lists performance by campaign... any filters at the top need to be applicable to the campaign
  // table"). Deliberately ALWAYS grouped by campaignName regardless of whatever the "Slice by"
  // dropdown above is set to — this is a fixed, always-available view, not another slice option —
  // but built from searchedRows so it still inherits every active filter (sidebar Filters, period
  // range, AND the slice search box) exactly like the other two tables.
  const campaignGroups = useMemo(
    () => aggregateByDimension(searchedRows, "campaignName").map((g) => ({ ...g, metrics: { ...g.metrics, ...computeDerivedPipelineMetrics(g.metrics), ...computeCustomMetrics(g.metrics, customMetrics) } })),
    [searchedRows, customMetrics]
  );
  const sortedCampaignGroups = useMemo(() => {
    if (campaignSort.key) return applySort(campaignGroups, campaignSort, (g) => g.key, (g) => g.rows.length);
    return campaignGroups.slice().sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
  }, [campaignGroups, campaignSort]);

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

  // Trend-by-period table's own sort — kept SEPARATE from periodBuckets itself (which stays
  // chronological for the chart above and for forecast's "last bucket" logic) so sorting the table
  // never disturbs either of those. Default order (no column clicked) is the original chronological
  // one.
  const sortedPeriodBuckets = useMemo(() => {
    if (!periodSort.key) return periodBuckets;
    return applySort(periodBuckets, periodSort, (b) => b.periodStart, (b) => b.rows.length);
  }, [periodBuckets, periodSort]);

  const activeMetricColumns = useMemo(() => ALL_METRIC_OPTIONS.filter((m) => metrics.includes(m.key)), [metrics, ALL_METRIC_OPTIONS]);
  const toggleMetric = (key) => setMetrics((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  // Per-table column objects (2026-08-17 rework — see PER-TABLE COLUMNS above) — each table's own
  // ordered activeColumns (a plain array of metric KEYS) resolved into the actual option objects
  // (label/money/pct) the table cells below need, in that same saved order. Order comes from the
  // state itself now, not from ALL_METRIC_OPTIONS' fixed master order — a user-reordered column set
  // renders in the order they put it in.
  const activePeriodColumns = periodColState.activeColumns.map((k) => METRIC_OPTION_BY_KEY[k]).filter(Boolean);
  const activeBreakdownColumns = breakdownColState.activeColumns.map((k) => METRIC_OPTION_BY_KEY[k]).filter(Boolean);
  const activeCampaignColumns = campaignColState.activeColumns.map((k) => METRIC_OPTION_BY_KEY[k]).filter(Boolean);

  // Hide empty rows (2026-08-12, per Mo — "give me a way to hide rows with 0 data anywhere (ignore
  // the first column for the number of rows)"): a row can have real underlying reporting_facts rows
  // (a non-zero Rows count) but still show nothing useful in any of the currently SELECTED metric
  // columns — e.g. a mis-tagged/variant campaign name that only ever carried metrics other than the
  // ones on screen right now. "No data" means every active metric column is blank/undefined OR
  // literally 0 — deliberately excludes the Rows column itself per Mo's own parenthetical, since
  // that count being non-zero is exactly the confusing case this exists to surface/hide. Parameterized
  // by columns (2026-08-17 rework) since each of the three tables now has its own independent column
  // set, so "no data" means something different per table rather than one shared definition. A pure
  // display declutter, not a data filter — Totals rows stay computed from the full unfiltered set
  // (grandTotals/searchedRows), same as sorting a table never changes its own Total row either.
  const [hideEmptyRows, setHideEmptyRows] = usePersistentState("paidhq_reporting_intel_hideEmptyRows", false);
  const hasNoSelectedMetricData = (metricsObj, columns) => columns.length > 0 && columns.every((c) => {
    const v = metricsObj[c.key];
    return v === undefined || v === null || (typeof v === "number" && (isNaN(v) || v === 0));
  });
  // Plain consts, deliberately not useMemo — each is just one cheap array filter over an already-
  // computed list, and wrapping a locally-defined (non-hook) function in a dependency array here
  // trips this repo's react-compiler lint rule over the function reference's own stability, for no
  // real perf benefit at this scale.
  const visiblePeriodBuckets = hideEmptyRows ? sortedPeriodBuckets.filter((b) => !hasNoSelectedMetricData(b.metrics, activePeriodColumns)) : sortedPeriodBuckets;
  const visibleSliceGroups = hideEmptyRows ? filteredSliceGroups.filter((g) => !hasNoSelectedMetricData(g.metrics, activeBreakdownColumns)) : filteredSliceGroups;
  const visibleCampaignGroups = hideEmptyRows ? sortedCampaignGroups.filter((g) => !hasNoSelectedMetricData(g.metrics, activeCampaignColumns)) : sortedCampaignGroups;
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

                {/* Custom Dimensions — see this file's top doc comment. A named, saved snapshot of
                    the filter fields above (Campaign/Ad Group contains+excludes, Channel, Tag
                    contains+excludes) that keeps matching a segment as literal campaign/UTM names
                    drift, instead of a one-time manual bulk-tag pass. */}
                <div style={{ position: "relative" }}>
                  <button onClick={() => setDimensionsMenuOpen((o) => !o)} title="Custom dimensions — saved filter rules for segments like &quot;SPS NA, non-brand, non-competitor&quot; that keep matching regardless of naming changes"
                    style={{ display: "flex", alignItems: "center", gap: 5, background: activeDimension ? T.accentBg : "transparent", border: `1px solid ${activeDimension ? T.accentBorder : T.border}`, borderRadius: T.r6, padding: "3px 8px", cursor: "pointer", fontFamily: T.font, fontSize: 11 * (T.fsScale || 1), fontWeight: 600, color: activeDimension ? T.text : T.textMuted, outline: "none", maxWidth: 200 }}>
                    <Icon name="target" size={12} color={activeDimension ? T.text : T.textMuted} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeDimension ? activeDimension.name : "Dimensions"}</span>
                    <Icon name="chevronDown" size={11} color={T.textMuted} />
                  </button>
                  {dimensionsMenuOpen && (
                    <>
                      <div onClick={() => setDimensionsMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
                      <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100, minWidth: 260, maxHeight: 320, overflow: "auto", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r8, boxShadow: T.shadowMd, padding: 6 }}>
                        {!(pipelineDimensions || []).length && <div style={{ padding: "10px 8px", fontSize: 12 * (T.fsScale || 1), color: T.textMuted }}>No custom dimensions yet.</div>}
                        {(pipelineDimensions || []).map((d) => (
                          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                            <button onClick={() => applyPipelineDimension(d)} className="bhq-row" style={{ flex: 1, display: "block", textAlign: "left", padding: "7px 8px", borderRadius: T.r6, background: activeDimensionId === d.id ? T.accentBg : "transparent", border: "none", color: T.text, fontSize: 12 * (T.fsScale || 1), cursor: "pointer", fontFamily: T.font, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</button>
                            {canEdit && <button onClick={() => deletePipelineDimension(d.id, d.name)} title="Delete dimension" style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", borderRadius: T.r5, color: T.textMuted, cursor: "pointer", fontSize: 13 * (T.fsScale || 1), flexShrink: 0, fontFamily: T.font }}>✕</button>}
                          </div>
                        ))}
                        {activeDimension && (
                          <button onClick={() => { applyDimensionFields(null); setActiveDimensionId(null); setDimensionsMenuOpen(false); }} className="bhq-row" style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 8px", borderRadius: T.r6, background: "transparent", border: "none", color: T.textMuted, fontSize: 12 * (T.fsScale || 1), cursor: "pointer", fontFamily: T.font }}>Clear active dimension</button>
                        )}
                        {canEdit && (
                          <>
                            <div style={{ height: 1, background: T.border, margin: "4px 2px" }} />
                            <button onClick={() => { setDimensionsMenuOpen(false); openSaveDimensionModal(); }} className="bhq-row" style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", padding: "7px 8px", borderRadius: T.r6, background: "transparent", border: "none", color: T.accentText, fontSize: 12 * (T.fsScale || 1), fontWeight: 600, cursor: "pointer", fontFamily: T.font }}><Icon name="plus" size={12} color={T.accentText} /> Save current filters as dimension</button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Saved Views — full report snapshots (dimension + Slice by/metrics/grain/hide-
                    empty), same interaction shape as Reporting & Pacing's own Views menu. */}
                <div style={{ position: "relative" }}>
                  <button onClick={() => setViewsMenuOpen((o) => !o)}
                    style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "3px 8px", cursor: "pointer", fontFamily: T.font, fontSize: 11 * (T.fsScale || 1), fontWeight: 600, color: T.textMuted, outline: "none" }}>
                    <Icon name="save" size={12} color={T.textSub} />
                    Views{pipelineViews?.length ? ` (${pipelineViews.length})` : ""}
                    <Icon name="chevronDown" size={11} color={T.textMuted} />
                  </button>
                  {viewsMenuOpen && (
                    <>
                      <div onClick={() => setViewsMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
                      <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100, minWidth: 240, maxHeight: 320, overflow: "auto", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r8, boxShadow: T.shadowMd, padding: 6 }}>
                        {!(pipelineViews || []).length && <div style={{ padding: "10px 8px", fontSize: 12 * (T.fsScale || 1), color: T.textMuted }}>No saved views yet.</div>}
                        {(pipelineViews || []).map((v) => (
                          <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                            <button onClick={() => applyPipelineView(v)} className="bhq-row" style={{ flex: 1, display: "block", textAlign: "left", padding: "7px 8px", borderRadius: T.r6, background: "transparent", border: "none", color: T.text, fontSize: 12 * (T.fsScale || 1), cursor: "pointer", fontFamily: T.font, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</button>
                            {canEdit && <button onClick={() => deletePipelineView(v.id, v.name)} title="Delete saved view" style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", borderRadius: T.r5, color: T.textMuted, cursor: "pointer", fontSize: 13 * (T.fsScale || 1), flexShrink: 0, fontFamily: T.font }}>✕</button>}
                          </div>
                        ))}
                        {canEdit && (
                          <>
                            <div style={{ height: 1, background: T.border, margin: "4px 2px" }} />
                            <button onClick={() => { setViewsMenuOpen(false); openSaveViewModal(); }} className="bhq-row" style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", padding: "7px 8px", borderRadius: T.r6, background: "transparent", border: "none", color: T.accentText, fontSize: 12 * (T.fsScale || 1), fontWeight: 600, cursor: "pointer", fontFamily: T.font }}><Icon name="plus" size={12} color={T.accentText} /> Save current view</button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
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
                <button onClick={() => setHideEmptyRows((v) => !v)} title="Hide rows where every selected metric is blank or zero (row count itself doesn't count)"
                  style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, background: hideEmptyRows ? T.accentBg : "transparent", border: `1px solid ${hideEmptyRows ? T.accentBorder : T.border}`, borderRadius: T.r6, padding: "3px 8px", cursor: "pointer", fontFamily: T.font, fontSize: 11 * (T.fsScale || 1), fontWeight: 600, color: hideEmptyRows ? T.text : T.textMuted, outline: "none" }}>
                  <input type="checkbox" checked={hideEmptyRows} readOnly style={{ pointerEvents: "none", cursor: "pointer", accentColor: T.accent, width: 12, height: 12 }} />
                  Hide empty rows
                </button>
                <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>
                  {visibleSliceGroups.length} group{visibleSliceGroups.length === 1 ? "" : "s"} · {searchedRows.length} row{searchedRows.length === 1 ? "" : "s"}
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
                CHARTABLE_METRICS above). Full-width flat section, not a PixelPanel "bubble" card
                (2026-08-13, per Mo — "make the tables and the chart section full width so they're
                not bubbles") — same background tint as before for section separation, just without
                the rounded border/shadow that made every section read as a floating, width-capped
                card instead of a full-bleed part of the page. */}
            <div style={{ background: T.surface, padding: 16, marginBottom: 16 }}>
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
            </div>

            {/* Trend by period — every selected metric as a column, one row per period bucket.
                Sortable (click any header) + collapsible (2026-08-10, per Mo). Full-width flat
                section, not a PixelPanel "bubble" card — see the Trend chart's own comment above. */}
            <div style={{ background: T.surface, marginBottom: 16 }}>
              <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: periodTableOpen ? `1px solid ${T.border}` : "none" }}>
                <div style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>Trend by period</div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <button onClick={() => setOpenColumnsModal("period")} title="Add, remove, or reorder this table's columns" style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "3px 8px", color: T.textSub, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font }}>
                    <Icon name="gear" size={11} color={T.textSub} /> Columns ({activePeriodColumns.length})
                  </button>
                  <button onClick={() => setPeriodTableOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, padding: 0 }}>
                    {periodTableOpen ? "Hide" : "Show"}
                    <Icon name="chevronDown" size={12} color={T.textMuted} style={{ transform: periodTableOpen ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }} />
                  </button>
                </div>
              </div>
              {periodTableOpen && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 * (T.fsScale || 1) }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                        <NumTh T={T} />
                        <SortTh label="Period" sortKey="__label__" sort={periodSort} onSort={(k) => toggleSort(setPeriodSort, k)} align="left" T={T} />
                        <SortTh label="Rows" sortKey="__rows__" sort={periodSort} onSort={(k) => toggleSort(setPeriodSort, k)} align="right" T={T} />
                        {activePeriodColumns.map((c) => (
                          <SortTh key={c.key} label={c.label} sortKey={c.key} sort={periodSort} onSort={(k) => toggleSort(setPeriodSort, k)} align="right" T={T} />
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visiblePeriodBuckets.length === 0 && (
                        <tr><td colSpan={3 + activePeriodColumns.length} style={{ padding: "32px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>{hideEmptyRows && sortedPeriodBuckets.length > 0 ? "Every period is hidden by \"Hide empty rows.\"" : "No periods match your filters."}</td></tr>
                      )}
                      {visiblePeriodBuckets.map((b, bi) => {
                        // Matched by KEY, not array position — sorting the table can reorder rows,
                        // but the forecast is always for one specific real bucket (the most recent
                        // one chronologically), so "is this the forecast row" must stay tied to
                        // that bucket's identity rather than "am I last in whatever order I'm in".
                        const isForecastRow = forecast && b.key === forecast.bucket.key;
                        return (
                          <tr key={b.key} className="bhq-row" style={{ borderBottom: `1px solid ${T.border}` }}>
                            <NumTd T={T} n={bi + 1} />
                            <td style={{ padding: "8px 10px", fontWeight: 600, color: T.text }}>
                              {labelForPeriod(b.periodType, b.periodStart)}
                              {isForecastRow && <Pill color={T.accent} bg={T.accentBg} border={T.accentBorder} style={{ marginLeft: 8, fontSize: 10 * (T.fsScale || 1) }}>in progress</Pill>}
                            </td>
                            <td style={{ padding: "8px 10px", color: T.textSub, fontSize: 12 * (T.fsScale || 1), textAlign: "right" }}>{b.rows.length}</td>
                            {activePeriodColumns.map((c) => (
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
                    {sortedPeriodBuckets.length > 0 && (
                      <tfoot>
                        <tr style={{ borderTop: `2px solid ${T.border}` }}>
                          <td style={{ padding: "8px 10px" }} />
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>Total</td>
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text, fontSize: 12 * (T.fsScale || 1), textAlign: "right" }}>{searchedRows.length}</td>
                          {activePeriodColumns.map((c) => (
                            <td key={c.key} style={{ padding: "8px 10px", fontWeight: 700, color: T.text, textAlign: "right" }}>{fmtMetric(grandTotals[c.key], c.money, c.pct)}</td>
                          ))}
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>

            {/* Breakdown by dimension — unchanged shape from v1, now driven by the same selected
                metric columns as the trend table above instead of a derived/capped column list.
                Sortable + collapsible, same as the other two tables (2026-08-10, per Mo). Full-width
                flat section, not a PixelPanel "bubble" card — see the Trend chart's own comment above. */}
            <div style={{ background: T.surface, marginBottom: 16 }}>
              <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: breakdownTableOpen ? `1px solid ${T.border}` : "none" }}>
                <div style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>Breakdown by {sliceOptions.find((o) => o.value === sliceBy)?.label || "Slice"}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <button onClick={() => setOpenColumnsModal("breakdown")} title="Add, remove, or reorder this table's columns" style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "3px 8px", color: T.textSub, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font }}>
                    <Icon name="gear" size={11} color={T.textSub} /> Columns ({activeBreakdownColumns.length})
                  </button>
                  <button onClick={() => setBreakdownTableOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, padding: 0 }}>
                    {breakdownTableOpen ? "Hide" : "Show"}
                    <Icon name="chevronDown" size={12} color={T.textMuted} style={{ transform: breakdownTableOpen ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }} />
                  </button>
                </div>
              </div>
              {breakdownTableOpen && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 * (T.fsScale || 1) }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                        <NumTh T={T} />
                        <SortTh label={sliceOptions.find((o) => o.value === sliceBy)?.label || "Slice"} sortKey="__label__" sort={breakdownSort} onSort={(k) => toggleSort(setBreakdownSort, k)} align="left" T={T} />
                        <SortTh label="Rows" sortKey="__rows__" sort={breakdownSort} onSort={(k) => toggleSort(setBreakdownSort, k)} align="right" T={T} />
                        {activeBreakdownColumns.map((c) => (
                          <SortTh key={c.key} label={c.label} sortKey={c.key} sort={breakdownSort} onSort={(k) => toggleSort(setBreakdownSort, k)} align="right" T={T} />
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleSliceGroups.length === 0 && (
                        <tr><td colSpan={3 + activeBreakdownColumns.length} style={{ padding: "32px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>{hideEmptyRows && filteredSliceGroups.length > 0 ? "Every group is hidden by \"Hide empty rows.\"" : "No groups match your filters."}</td></tr>
                      )}
                      {visibleSliceGroups.map((g, gi) => {
                        // Nested campaign expand (2026-08-11, per Mo — "performance trends at the
                        // campaign level for each product"). Hidden when Slice by is already
                        // Campaign — expanding a campaign row into its own campaign breakdown would
                        // just repeat the same row.
                        const canExpand = sliceBy !== "campaignName";
                        const expanded = canExpand && expandedGroups.has(g.key);
                        return (
                          <Fragment key={g.key}>
                            <tr className="bhq-row" style={{ borderBottom: expanded ? "none" : `1px solid ${T.border}` }}>
                              <NumTd T={T} n={gi + 1} />
                              <td onClick={canExpand ? () => toggleExpandGroup(g.key) : undefined}
                                style={{ padding: "8px 10px", fontWeight: 600, color: T.text, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: canExpand ? "pointer" : "default", userSelect: canExpand ? "none" : "auto" }} title={g.key}>
                                {canExpand && <Icon name="chevronDown" size={10} color={T.textMuted} style={{ marginRight: 6, transform: expanded ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }} />}
                                {g.key}
                              </td>
                              <td style={{ padding: "8px 10px", color: T.textSub, fontSize: 12 * (T.fsScale || 1), textAlign: "right" }}>{g.rows.length}</td>
                              {activeBreakdownColumns.map((c) => (
                                <td key={c.key} style={{ padding: "8px 10px", color: T.text, textAlign: "right" }}>{fmtMetric(g.metrics[c.key], c.money, c.pct)}</td>
                              ))}
                            </tr>
                            {expanded && (
                              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                                <td colSpan={3 + activeBreakdownColumns.length} style={{ padding: "0 10px 12px 28px", background: T.surfaceEl }}>
                                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 * (T.fsScale || 1) }}>
                                    <thead>
                                      <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                                        <NumTh T={T} small />
                                        <th style={{ padding: "6px 8px", fontSize: 9 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: "left" }}>Campaign</th>
                                        <th style={{ padding: "6px 8px", fontSize: 9 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: "right" }}>Rows</th>
                                        {activeBreakdownColumns.map((c) => (
                                          <th key={c.key} style={{ padding: "6px 8px", fontSize: 9 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: "right" }}>{c.label}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {campaignsForGroup(g).map((c, ci) => (
                                        <tr key={c.key} className="bhq-row">
                                          <NumTd T={T} n={ci + 1} small />
                                          <td style={{ padding: "6px 8px", color: T.textSub, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.key}>{c.key}</td>
                                          <td style={{ padding: "6px 8px", color: T.textMuted, fontSize: 11 * (T.fsScale || 1), textAlign: "right" }}>{c.rows.length}</td>
                                          {activeBreakdownColumns.map((col) => (
                                            <td key={col.key} style={{ padding: "6px 8px", color: T.textSub, textAlign: "right" }}>{fmtMetric(c.metrics[col.key], col.money, col.pct)}</td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                    {filteredSliceGroups.length > 0 && (
                      <tfoot>
                        <tr style={{ borderTop: `2px solid ${T.border}` }}>
                          <td style={{ padding: "8px 10px" }} />
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>Total</td>
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text, fontSize: 12 * (T.fsScale || 1), textAlign: "right" }}>{searchedRows.length}</td>
                          {activeBreakdownColumns.map((c) => (
                            <td key={c.key} style={{ padding: "8px 10px", fontWeight: 700, color: T.text, textAlign: "right" }}>{fmtMetric(grandTotals[c.key], c.money, c.pct)}</td>
                          ))}
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>

            {/* By Campaign (2026-08-10, per Mo — "I need a campaign level table at the bottom that
                lists performance by campaign"). Always grouped by campaignName regardless of the
                "Slice by" dropdown above — see campaignGroups' own doc comment. Sortable +
                collapsible, same as the other two tables. Full-width flat section, not a PixelPanel
                "bubble" card — see the Trend chart's own comment above. */}
            <div style={{ background: T.surface }}>
              <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: campaignTableOpen ? `1px solid ${T.border}` : "none" }}>
                <div style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>By Campaign</div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <button onClick={() => setOpenColumnsModal("campaign")} title="Add, remove, or reorder this table's columns" style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "3px 8px", color: T.textSub, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font }}>
                    <Icon name="gear" size={11} color={T.textSub} /> Columns ({activeCampaignColumns.length})
                  </button>
                  <button onClick={() => setCampaignTableOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, padding: 0 }}>
                    {campaignTableOpen ? "Hide" : "Show"}
                    <Icon name="chevronDown" size={12} color={T.textMuted} style={{ transform: campaignTableOpen ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }} />
                  </button>
                </div>
              </div>
              {campaignTableOpen && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 * (T.fsScale || 1) }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                        <NumTh T={T} />
                        <SortTh label="Campaign" sortKey="__label__" sort={campaignSort} onSort={(k) => toggleSort(setCampaignSort, k)} align="left" T={T} />
                        <SortTh label="Rows" sortKey="__rows__" sort={campaignSort} onSort={(k) => toggleSort(setCampaignSort, k)} align="right" T={T} />
                        {activeCampaignColumns.map((c) => (
                          <SortTh key={c.key} label={c.label} sortKey={c.key} sort={campaignSort} onSort={(k) => toggleSort(setCampaignSort, k)} align="right" T={T} />
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleCampaignGroups.length === 0 && (
                        <tr><td colSpan={3 + activeCampaignColumns.length} style={{ padding: "32px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>{hideEmptyRows && sortedCampaignGroups.length > 0 ? "Every campaign is hidden by \"Hide empty rows.\"" : "No campaigns match your filters."}</td></tr>
                      )}
                      {visibleCampaignGroups.map((g, gi) => (
                        <tr key={g.key} className="bhq-row" style={{ borderBottom: `1px solid ${T.border}` }}>
                          <NumTd T={T} n={gi + 1} />
                          <td style={{ padding: "8px 10px", fontWeight: 600, color: T.text, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={g.key}>{g.key}</td>
                          <td style={{ padding: "8px 10px", color: T.textSub, fontSize: 12 * (T.fsScale || 1), textAlign: "right" }}>{g.rows.length}</td>
                          {activeCampaignColumns.map((c) => (
                            <td key={c.key} style={{ padding: "8px 10px", color: T.text, textAlign: "right" }}>{fmtMetric(g.metrics[c.key], c.money, c.pct)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                    {sortedCampaignGroups.length > 0 && (
                      <tfoot>
                        <tr style={{ borderTop: `2px solid ${T.border}` }}>
                          <td style={{ padding: "8px 10px" }} />
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>Total</td>
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text, fontSize: 12 * (T.fsScale || 1), textAlign: "right" }}>{searchedRows.length}</td>
                          {activeCampaignColumns.map((c) => (
                            <td key={c.key} style={{ padding: "8px 10px", fontWeight: 700, color: T.text, textAlign: "right" }}>{fmtMetric(grandTotals[c.key], c.money, c.pct)}</td>
                          ))}
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {openColumnsModal === "period" && (
        <ColumnsModal T={T} title="Trend by period" allOptions={ALL_METRIC_OPTIONS} state={periodColState} handlers={periodColHandlers} onClose={() => setOpenColumnsModal(null)} />
      )}
      {openColumnsModal === "breakdown" && (
        <ColumnsModal T={T} title={`Breakdown by ${sliceOptions.find((o) => o.value === sliceBy)?.label || "Slice"}`} allOptions={ALL_METRIC_OPTIONS} state={breakdownColState} handlers={breakdownColHandlers} onClose={() => setOpenColumnsModal(null)} />
      )}
      {openColumnsModal === "campaign" && (
        <ColumnsModal T={T} title="By Campaign" allOptions={ALL_METRIC_OPTIONS} state={campaignColState} handlers={campaignColHandlers} onClose={() => setOpenColumnsModal(null)} />
      )}

      {dimensionModalOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 210, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setDimensionModalOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 380, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r10, padding: 20, boxShadow: T.shadowMd }}>
            <div style={{ fontSize: 14 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 4 }}>Save as custom dimension</div>
            <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, marginBottom: 12 }}>Saves the Campaign/Ad Group/Channel/Tag filters currently set above as a named, reusable rule — e.g. "SPS NA, non-brand, non-competitor". It'll keep matching this segment later even if campaign or UTM names change, as long as they still fit these terms.</div>
            <input autoFocus value={dimensionNameDraft} onChange={(e) => setDimensionNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveCurrentDimension(); if (e.key === "Escape") setDimensionModalOpen(false); }}
              placeholder="e.g. SPS NA, non-brand, non-competitor"
              style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "8px 10px", fontSize: 13 * (T.fsScale || 1), outline: "none", fontFamily: T.font, marginBottom: 14 }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setDimensionModalOpen(false)} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.textSub, borderRadius: T.r6, padding: "6px 12px", cursor: "pointer", fontFamily: T.font, fontSize: 12 * (T.fsScale || 1) }}>Cancel</button>
              <button onClick={saveCurrentDimension} disabled={!dimensionNameDraft.trim()} style={{ background: dimensionNameDraft.trim() ? T.accent : T.surfaceHover, border: "none", color: dimensionNameDraft.trim() ? "#fff" : T.textMuted, borderRadius: T.r6, padding: "6px 14px", cursor: dimensionNameDraft.trim() ? "pointer" : "default", fontFamily: T.font, fontSize: 12 * (T.fsScale || 1), fontWeight: 600 }}>Save dimension</button>
            </div>
          </div>
        </div>
      )}

      {viewModalOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 210, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setViewModalOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 380, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r10, padding: 20, boxShadow: T.shadowMd }}>
            <div style={{ fontSize: 14 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 4 }}>Save this view</div>
            <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, marginBottom: 12 }}>
              Saves {activeDimension ? `"${activeDimension.name}"` : "All campaigns"}, Slice by, selected metrics, chart metrics, period grain/range, and Hide empty rows for one-click recall. If the dimension's rule changes later, this view picks up the change automatically.
            </div>
            <input autoFocus value={viewNameDraft} onChange={(e) => setViewNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveCurrentView(); if (e.key === "Escape") setViewModalOpen(false); }}
              placeholder="e.g. SPS NA trends"
              style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "8px 10px", fontSize: 13 * (T.fsScale || 1), outline: "none", fontFamily: T.font, marginBottom: 14 }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setViewModalOpen(false)} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.textSub, borderRadius: T.r6, padding: "6px 12px", cursor: "pointer", fontFamily: T.font, fontSize: 12 * (T.fsScale || 1) }}>Cancel</button>
              <button onClick={saveCurrentView} disabled={!viewNameDraft.trim()} style={{ background: viewNameDraft.trim() ? T.accent : T.surfaceHover, border: "none", color: viewNameDraft.trim() ? "#fff" : T.textMuted, borderRadius: T.r6, padding: "6px 14px", cursor: viewNameDraft.trim() ? "pointer" : "default", fontFamily: T.font, fontSize: 12 * (T.fsScale || 1), fontWeight: 600 }}>Save view</button>
            </div>
          </div>
        </div>
      )}

      {notif && <div style={{ position: "fixed", bottom: 20, right: 20, background: T.success, color: "#fff", padding: "10px 16px", borderRadius: T.r8, fontSize: 13 * (T.fsScale || 1), fontWeight: 600, zIndex: 300, boxShadow: T.shadowMd, fontFamily: T.font }}>{notif}</div>}
    </>
  );
}

// Per-table "Columns" editor (2026-08-17, per Mo — "I need to be able to adjust the columns in
// these tables so I can move metrics/fields, add new ones..., and remove existing ones. I also need
// to be able to save column views at the user level"). One shared modal, rendered once per table
// with that table's own {activeColumns,views,activeViewId} state + handlers (see PipelineTagger's
// PER-TABLE COLUMNS section) — not a single instance shared across tables, so each table's "which
// columns, in what order, under what saved presets" stays fully independent, matching Mo's own
// framing ("Each table... should be independent so users can look at the kpis they want to").
//
// Reordering is native HTML5 drag-and-drop (draggable + onDragStart/onDragOver/onDrop) rather than a
// library — this codebase has no drag-and-drop dependency installed, and a plain index-swap on drop
// is all a single flat "Shown" list needs; no nested/multi-list dragging to justify pulling one in.
function ColumnsModal({ T, title, allOptions, state, handlers, onClose }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [presetName, setPresetName] = useState("");

  const activeSet = new Set(state.activeColumns);
  const shown = state.activeColumns.map((k) => allOptions.find((o) => o.key === k)).filter(Boolean);
  const groups = [
    { label: "Funnel metrics", options: allOptions.filter((o) => o.kind === "absolute" && !activeSet.has(o.key)) },
    { label: "Cost & conversion", options: allOptions.filter((o) => o.kind === "derived" && !activeSet.has(o.key)) },
    { label: "Custom", options: allOptions.filter((o) => o.kind === "custom" && !activeSet.has(o.key)) },
  ].filter((g) => g.options.length > 0);

  const commitSave = () => {
    const name = presetName.trim();
    if (!name) return;
    handlers.saveView(name);
    setPresetName("");
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 210, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 480, maxHeight: "85vh", overflow: "auto", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r10, padding: 20, boxShadow: T.shadowMd }}>
        <div style={{ fontSize: 14 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 4 }}>{title} — columns</div>
        <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, marginBottom: 14 }}>Drag to reorder. Click a metric below to add it, or the × on a shown column to remove it.</div>

        <SectionLabel T={T} style={{ marginBottom: 6 }}>Shown</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 }}>
          {shown.length === 0 && <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted }}>No columns selected — add one below.</div>}
          {shown.map((opt, i) => (
            <div key={opt.key}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) handlers.reorderColumns(dragIndex, i); setDragIndex(null); }}
              onDragEnd={() => setDragIndex(null)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: T.r6, border: `1px solid ${T.border}`, background: dragIndex === i ? T.surfaceHover : T.surface, cursor: "grab", opacity: dragIndex === i ? 0.5 : 1 }}>
              <Icon name="dots" size={13} color={T.textMuted} />
              <span style={{ flex: 1, fontSize: 13 * (T.fsScale || 1), color: T.text, fontFamily: T.font }}>{opt.label}</span>
              <button onClick={() => handlers.toggleColumn(opt.key)} title="Remove column" style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 13 * (T.fsScale || 1), fontFamily: T.font }}>✕</button>
            </div>
          ))}
        </div>

        {groups.map((g) => (
          <div key={g.label} style={{ marginBottom: 12 }}>
            <SectionLabel T={T} style={{ marginBottom: 6 }}>{g.label}</SectionLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {g.options.map((opt) => (
                <button key={opt.key} onClick={() => handlers.toggleColumn(opt.key)}
                  style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 * (T.fsScale || 1), background: "transparent", border: `1px solid ${T.border}`, color: T.textSub, borderRadius: T.r14, padding: "3px 9px", cursor: "pointer", fontFamily: T.font }}>
                  <Icon name="plus" size={10} color={T.textMuted} />{opt.label}
                </button>
              ))}
            </div>
          </div>
        ))}

        <Divider T={T} style={{ margin: "14px 0" }} />
        <SectionLabel T={T} style={{ marginBottom: 6 }}>Saved presets</SectionLabel>
        {state.views.length === 0 && <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, marginBottom: 10 }}>No saved presets yet — set up your columns above, then save them as a named preset below.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 10 }}>
          {state.views.map((v) => (
            <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button onClick={() => handlers.applyView(v)} className="bhq-row" style={{ flex: 1, textAlign: "left", padding: "6px 8px", borderRadius: T.r6, background: state.activeViewId === v.id ? T.accentBg : "transparent", border: "none", color: T.text, fontSize: 12 * (T.fsScale || 1), cursor: "pointer", fontFamily: T.font }}>{v.name}</button>
              <button onClick={() => handlers.deleteView(v.id)} title="Delete preset" style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 13 * (T.fsScale || 1), fontFamily: T.font }}>✕</button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
          <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Preset name…"
            onKeyDown={(e) => { if (e.key === "Enter") commitSave(); }}
            style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 9px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
          <button onClick={commitSave} disabled={!presetName.trim()}
            style={{ background: presetName.trim() ? T.accent : T.surfaceHover, border: "none", color: presetName.trim() ? "#fff" : T.textMuted, borderRadius: T.r6, padding: "6px 14px", cursor: presetName.trim() ? "pointer" : "default", fontSize: 12 * (T.fsScale || 1), fontWeight: 600, fontFamily: T.font }}>Save as new preset</button>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={{ background: T.accent, border: "none", color: "#fff", borderRadius: T.r6, padding: "7px 16px", cursor: "pointer", fontSize: 12 * (T.fsScale || 1), fontWeight: 600, fontFamily: T.font }}>Done</button>
        </div>
      </div>
    </div>
  );
}

// Simple grouped bar chart — one bar per period bucket for a single metric, plus a lighter
// "projected" bar appended after the last actual bar when the most recent period is still in
// progress (see this file's top FORECAST doc comment). Deliberately much simpler than
// PacingDashboard's own TrendBarChart (no dense/multi-series layout branch) since this only ever
// plots one metric at a time — mixed count/$/% scales don't share an axis meaningfully.
// Reworked 2026-08-09 (per Mo — "select up to three metrics to view month by month or quarter by
// quarter") from a single-series bar chart into a grouped-bar chart: one differently-colored bar
// per selected metric within each period's slot. Each bar carries a native SVG <title> so the
// exact value is still available on hover regardless of how either axis renders it.
//
// DUAL AXIS (2026-08-10, per Mo — "All three metrics can't use the same left vertical axis since
// the numbers can differ significantly... if we have MQLs, SQLs and pipeline value, then MQLs and
// SQLs can use the same axis (left) and pipeline value can use the right axis"): series split into
// two axis groups by their own .money flag — non-money counts (MQLs, SQLs, leads, ...) on the
// LEFT, money figures (Spend, Pipeline Value, Revenue) on the RIGHT. A right axis is only drawn
// when BOTH groups are non-empty; if every selected metric happens to be the same kind (all money,
// or all counts), there's nothing to split and everything just shares the left axis as before. Both
// axes plot against the SAME 0/25/50/75/100% height fractions (each bar's height is value/its OWN
// axis's max), so one shared gridline legitimately labels both axes at once — this is what makes a
// dual-axis chart honest rather than two unrelated charts stacked on top of each other.
// SVG UNIT SCALING (2026-08-12, per Mo — "reduce the text size of the x and y axis, they're both
// much too large"): this chart used to hardcode viewBox width to 720 while its CSS width was
// "100%" — on this tab's actual (quite wide) layout, the rendered width ends up 2-3x the viewBox's
// 720 units, and since an SVG scales EVERYTHING inside it (including fontSize, which is just
// another number in viewBox units) uniformly with that stretch, a "9px" axis label was actually
// rendering at 20+ real pixels. useElementWidth measures the wrapper div's actual rendered width via
// ResizeObserver and feeds that back in as the viewBox width, with the CSS height pinned to the
// same fixed pixel value as the viewBox height — so viewBox units map 1:1 to real CSS pixels no
// matter how wide the container is, and every fontSize below means what it says.
function useElementWidth(fallback) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function TrendMiniChart({ T, periods, series, hasForecast }) {
  let axisLeft = series.filter((s) => !s.money);
  let axisRight = series.filter((s) => s.money);
  if (axisLeft.length === 0) { axisLeft = axisRight; axisRight = []; } // all-money selection — everything on one axis
  const hasRightAxis = axisRight.length > 0;
  const rightKeys = new Set(axisRight.map((s) => s.key));

  const [containerRef, measuredWidth] = useElementWidth(720);
  // padT/padB widened (2026-08-12) — padT for headroom above the tallest bar's own value label (see
  // the per-bar <text> below), padB for the larger period-label font (see AXIS_FS/LABEL_FS below,
  // 2026-08-13, per Mo — the previous sizes were "too small" once the earlier scaling bug was fixed).
  const H = 220, padT = 30, padB = 34, padL = 60, padR = hasRightAxis ? 60 : 16;
  const n = periods.length + (hasForecast ? 1 : 0);

  // FIXED PER-PERIOD WIDTH PAST 12 PERIODS (2026-08-17, per Mo — "I like how the data gets smaller
  // to accommodate more months but there should be a limit and then we should just allow horizontal
  // scroll. Let's fix things at the size of 12 months before we turn on horizontal scroll"): this
  // chart used to shrink every bar/group to squeeze however many periods were selected into the
  // container's own width, so a wide date range (e.g. a 31-month Jan 2024-Jul 2026 span in Reporting
  // Intelligence) compressed bars and period labels until adjacent months' labels overlapped
  // illegibly. Fixed by computing the per-period width from a fixed 12-period reference layout (the
  // container's own current width divided across 12 slots) and never shrinking narrower than that —
  // past 12 periods, the chart's total width grows beyond the container instead, and the outer
  // wrapper (containerRef below) scrolls horizontally rather than continuing to compress.
  const MAX_FIT_PERIODS = 12;
  const availableW = Math.max(1, measuredWidth - padL - padR);
  const unitPlotW = availableW / MAX_FIT_PERIODS;
  const needsScroll = n > MAX_FIT_PERIODS;
  const plotW = needsScroll ? unitPlotW * n : availableW;
  const W = plotW + padL + padR;
  const plotH = H - padT - padB;
  const seriesCount = Math.max(1, series.length);
  const groupGap = Math.min(18, (plotW / n) * 0.3);
  const groupW = plotW / n - groupGap;
  const barGap = 3;
  const barW = Math.max(3, (groupW - barGap * (seriesCount - 1)) / seriesCount);

  // Default the scroll position to the MOST RECENT periods, not the earliest (2026-08-17, per Mo —
  // "the graph isn't working when anything is in the filter now"): a browser's own default scroll
  // position for an overflowing element is scrollLeft=0, i.e. the chart opened showing the OLDEST
  // periods first. That's fine for an unfiltered view where data is spread across the whole range,
  // but a narrow filter (e.g. one campaign that only started running a year into a multi-year
  // range) can leave every bar in that oldest-first slice at zero, making the chart look empty/
  // broken even though it's rendering correctly — the real data was just scrolled out of view to the
  // right. Scrolls to the far right whenever the actual period RANGE changes (new filter, new date
  // range, new grain) — deliberately NOT keyed on `series` too, so toggling a chart metric on/off
  // doesn't yank the view away from wherever the user has manually scrolled to.
  const periodsKey = periods.join("|");
  useEffect(() => {
    if (!needsScroll) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- containerRef is a stable ref object (see useElementWidth), not reactive state
  }, [periodsKey, needsScroll]);

  const valuesFor = (arr) => arr.flatMap((s) => (hasForecast ? [...s.values, s.projectedValue || 0] : s.values));
  const leftMax = Math.max(1, ...valuesFor(axisLeft));
  const rightMax = Math.max(1, ...(hasRightAxis ? valuesFor(axisRight) : [0]));
  const maxFor = (key) => (rightKeys.has(key) ? rightMax : leftMax);
  const leftMoney = axisLeft.length > 0 && axisLeft.every((s) => s.money); // only true in the "all-money, no split" fallback above

  const fracs = [0, 0.25, 0.5, 0.75, 1];
  const fmtTick = (v, money) => { const prefix = money ? "$" : ""; return v >= 1000 ? `${prefix}${Math.round(v / 1000)}k` : `${prefix}${Math.round(v)}`; };
  // Axis tick/period-label and per-bar value-label sizes (2026-08-13, per Mo — "the x/y axis labels
  // are too small, as is the value label"). Bumped up from the original 9/7.5 now that the viewBox-
  // scaling fix above means these numbers actually render at face value instead of getting stretched.
  const AXIS_FS = 12, VALUE_FS = 11;
  // Per-bar value label (2026-08-12, per Mo — "give me data value on the columns in the graph (make
  // sure its small enough not to overlap other text or columns)"). Reuses fmtTick's own compact
  // "$157k"/"160" formatting rather than a raw toLocaleString() — a full "157,000" would overflow a
  // single bar's width almost everywhere this chart is used. Zero-value bars skip their label
  // entirely (there's no bar to point it at, and it's one less thing crowding a dense chart) — the
  // full exact number is always still available via each bar's own <title> hover regardless.
  const barLabel = (v, money) => (v > 0 ? fmtTick(v, money) : null);

  return (
    <div ref={containerRef} style={needsScroll ? { overflowX: "auto" } : undefined}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: needsScroll ? W : "100%", height: H, display: "block" }}>
        {fracs.map((f, i) => {
          const y = padT + plotH - f * plotH;
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke={T.border} strokeWidth={1} />
              <text x={padL - 8} y={y + 4} textAnchor="end" fontSize={AXIS_FS} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>{fmtTick(leftMax * f, leftMoney)}</text>
              {hasRightAxis && (
                <text x={W - padR + 8} y={y + 4} textAnchor="start" fontSize={AXIS_FS} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>{fmtTick(rightMax * f, true)}</text>
              )}
            </g>
          );
        })}
        {periods.map((p, i) => {
          const groupX = padL + i * (groupW + groupGap);
          return (
            <g key={p + i}>
              {series.map((s, si) => {
                const v = s.values[i] || 0;
                const h = (v / maxFor(s.key)) * plotH;
                const x = groupX + si * (barW + barGap);
                const barTop = padT + plotH - h;
                const label = barLabel(v, s.money);
                return (
                  <g key={s.key}>
                    <rect x={x} y={barTop} width={barW} height={h} fill={s.color} rx={2}>
                      <title>{s.label}{rightKeys.has(s.key) ? " (right axis)" : hasRightAxis ? " (left axis)" : ""}: {v.toLocaleString()}</title>
                    </rect>
                    {label && (
                      <text x={x + barW / 2} y={barTop - 4} textAnchor="middle" fontSize={VALUE_FS} fontWeight={600} fontFamily="'DM Sans',sans-serif" fill={T.textSub}>{label}</text>
                    )}
                  </g>
                );
              })}
              <text x={groupX + groupW / 2} y={H - padB + 18} textAnchor="middle" fontSize={AXIS_FS} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>{p}</text>
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
                    const h = (v / maxFor(s.key)) * plotH;
                    const x = groupX + si * (barW + barGap);
                    const barTop = padT + plotH - h;
                    const label = barLabel(v, s.money);
                    return (
                      <g key={s.key}>
                        <rect x={x} y={barTop} width={barW} height={h} fill={s.color} opacity={0.35} rx={2}>
                          <title>{s.label} (proj.): {v.toLocaleString()}</title>
                        </rect>
                        {label && (
                          <text x={x + barW / 2} y={barTop - 4} textAnchor="middle" fontSize={VALUE_FS} fontWeight={600} fontFamily="'DM Sans',sans-serif" fill={T.textSub}>{label}</text>
                        )}
                      </g>
                    );
                  })}
                  <text x={groupX + groupW / 2} y={H - padB + 18} textAnchor="middle" fontSize={AXIS_FS} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>proj.</text>
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
              <span style={{ fontSize: 11, color: T.textSub, fontFamily: "'DM Sans',sans-serif" }}>{s.label}{rightKeys.has(s.key) ? " (right axis)" : hasRightAxis ? " (left axis)" : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
