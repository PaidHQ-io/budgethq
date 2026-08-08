import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  computePacing, computePlatformDateRange, computeCustomGrouping, computeCustomBreakdown,
  computeSpendTrend, computeSpendBreakdown, renameDimensionValue, countSegmentCampaigns,
  untagSegmentCampaigns, buildCampaignPlatformIndex, DERIVED_DIMS, pacingStatusMeta, fmtFull, fmtSigned,
  FORECAST_MODELS, FORECAST_MODEL_INHERIT, DEFAULT_MANUAL_TRAILING_DAYS, forecastModelLabel,
  AUTO_SHORT_WINDOW, AUTO_DIVERGENCE_LOW, AUTO_DIVERGENCE_HIGH, CAPACITY_WINDOW, MONTHS, QUARTERS,
  NUMERIC_FIELDS, NUMERIC_OPERATORS, matchesNumericFilters, getPeriodRange, GOOGLE_SUBCHANNELS,
} from "../lib/core.js";
import { askAIBuildView, aiConfigToViewConfig } from "../lib/askAI.js";
import { Icon, Btn, SectionLabel, Sel, PixelPanel, AISummaryCard, Pill, WarnTip, InfoTip } from "./shared.jsx";
// Venture Tailwind primitives (2026-08-07, per Mo — Pacing tab retheme, same migration as the
// Budget Panel). Used to rebuild the portal sidebar off the legacy T-theme Btn/Sel/PixelPanel.
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select.jsx";
import { Wallet, Coins, Gauge, Clock, Stack, Target, CheckCircle } from "@phosphor-icons/react";
import { cn } from "../lib/utils.js";
import { usePersistentState } from "../lib/persist.js";
import { EXPORT_FORMATS, downloadReport } from "../lib/reports.js";
import { exportReportToGoogleSheets } from "../lib/googleSheets";
import { listReportingFacts } from "../lib/reportingApi.js";
import { isGoalsSource } from "../lib/pipelineColumnMapping.js";
import { stepPeriodStart } from "../lib/reportingPeriods.js";

// ─── MQL GOAL/ACTUAL IN TREND TABLE (2026-08-06, per Mo — "can we get MQL budgets and actuals into
// the budget pacing tab?") ──────────────────────────────────────────────────────────────────────
// core.reporting_facts (goals + pipeline actuals, see GoalsObjectives.jsx/ReportingAnalyzer.jsx)
// carries its OWN period grain per row (periodType/periodStart — day/week/month/quarter/year, see
// lib/reportingPeriods.js), independent of whatever grain the Trend view is currently showing
// (trendGrain). A row's grain can be coarser than the view (e.g. one yearly MQL goal row shown at
// Quarter grain) or finer (a monthly actual shown at Quarter/Year grain) — either way, naively
// keying off trendBucketKey (which assumes a single Date, not a Date range) would either drop the
// row (grain mismatch) or dump its whole value into just the first overlapping bucket (wrong
// total). Below instead computes each row's own [start,end] date range from its periodType/
// periodStart, finds every CURRENT-view bucket that range overlaps, and splits the row's value
// evenly across however many buckets that is — exact or intentionally-approximate in exactly the
// same "prorate the whole value across everything it actually spans" spirit as computeSpendTrend's
// existing is_monthly proration and budgetValues month-to-day proration above, not a new pattern.
//
// Deliberately NOT placed in lib/core.js: reportingMetrics.js already imports from core.js
// (getDecimalAdjust) — importing reportingMetrics.js/pipelineColumnMapping.js back into core.js for
// labelForMetricKey/isGoalsSource would create a circular import. This component already imports
// both safely as a leaf consumer, so the aggregation lives here instead.
function periodKeyRange(grain, key) {
  if (grain === "day") { const [y, m, d] = key.split("-").map(Number); const dt = new Date(y, m - 1, d); return { start: dt, end: dt }; }
  if (grain === "week") { const [y, m, d] = key.split("-").map(Number); const start = new Date(y, m - 1, d); return { start, end: new Date(y, m - 1, d + 6) }; }
  if (grain === "quarter") { const [y, qs] = key.split("-Q"); const q = Number(qs), yr = Number(y); return { start: new Date(yr, (q - 1) * 3, 1), end: new Date(yr, q * 3, 0) }; }
  if (grain === "year") { const yr = Number(key); return { start: new Date(yr, 0, 1), end: new Date(yr, 11, 31) }; }
  const [y, m] = key.split("-").map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 0) };
}
// A reporting_facts row's own [start,end] range, built in local time from its periodType/
// periodStart string (never via new Date(isoString), same "avoid the UTC/local shift" reasoning as
// fmtCalendarDate's fix elsewhere in this app — see core.js's parseSpendDate doc comment).
function reportingFactPeriodRange(periodType, periodStart) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(periodStart || "");
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const nextStr = stepPeriodStart(periodType, periodStart);
  const nm = nextStr && /^(\d{4})-(\d{2})-(\d{2})/.exec(nextStr);
  const end = nm ? new Date(Number(nm[1]), Number(nm[2]) - 1, Number(nm[3]) - 1) : start;
  return { start, end };
}
// Buckets one reporting_facts metric (e.g. "mqls") into an arbitrary array of [start,end] date
// ranges — either the SAME periods array computeSpendTrend already built for the Trend table (via
// periodKeyRange, one range per period/column), or a single one-element range for the single-period
// Budget/Custom view's Monthly/Quarterly/Yearly picker (via core.js's getPeriodRange) — both callers
// below just hand in whatever ranges apply to them, this function doesn't care which. Filtered by
// the same trendFilterDim/trendFilterValue substring match computeSpendTrend uses, so the MQL
// numbers always agree with whatever the spend table above is currently filtered to.
// BUGFIX (2026-08-19, per Mo — MQL Goal always showing blank in the Trend/single-period views, found
// investigating a parallel "MQLs coming in blank" report on the Goals & Objectives tab, same root
// cause): a goal row never stores its value under the plain metric key ("mqls") — GoalsImportWizard.jsx
// writes every goal metric under GOAL_METRIC_MAP_OPTIONS' "_goal"-suffixed key ("mqls_goal") specifically
// so a goal number can never collide with real pipeline performance data (see that constant's own doc
// comment in pipelineColumnMapping.js). This function used to look up `row.metrics?.[metricKey]`
// ("mqls") for EVERY row regardless of source, then route the result to goalValues/actualValues based
// on isGoalsSource — so a real goal row's actual value (sitting under "mqls_goal") was never found at
// all, `val == null` short-circuited, and goalValues stayed all-zero forever. Now looks up the
// SOURCE-APPROPRIATE key up front — `${metricKey}_goal` for a goals row, plain metricKey otherwise —
// instead of one shared lookup key for both.
function computeReportingMetricTrend({ reportingFacts, metricKey, filterDim, filterValue, periodRanges }) {
  const fv = (filterValue || "").trim().toLowerCase();
  const goalValues = new Array(periodRanges.length).fill(0);
  const actualValues = new Array(periodRanges.length).fill(0);
  (reportingFacts || []).forEach((row) => {
    const isGoal = isGoalsSource(row.source);
    const val = row.metrics?.[isGoal ? `${metricKey}_goal` : metricKey];
    if (val == null) return;
    if (filterDim && fv) {
      const tv = String(row.tags?.[filterDim] || "").toLowerCase();
      if (!tv.includes(fv)) return;
    }
    const range = reportingFactPeriodRange(row.periodType, row.periodStart);
    if (!range) return;
    const overlapping = [];
    periodRanges.forEach((pr, i) => { if (range.start <= pr.end && range.end >= pr.start) overlapping.push(i); });
    if (!overlapping.length) return;
    const share = val / overlapping.length;
    const target = isGoal ? goalValues : actualValues;
    overlapping.forEach((i) => { target[i] += share; });
  });
  return {
    goalValues, actualValues,
    goalTotal: goalValues.reduce((s, v) => s + v, 0),
    actualTotal: actualValues.reduce((s, v) => s + v, 0),
  };
}
// Plain count formatter (MQLs aren't dollars) — fmtFull/fmt$ in core.js are both money-only.
const fmtCount = (n) => (n ? Math.round(n).toLocaleString() : "—");

// Forecast-model "mode" — the 3 user-facing choices (Auto/Committed/Manual) — vs. the raw stored
// string (see FORECAST_MODELS in lib/core.js): Manual doesn't have one fixed stored value, it's
// "trailingN" for whatever N the user picked, so it can't be enumerated as a plain <select> option
// the way Auto/Committed can. These two helpers translate between the two, used by both the global
// control and the per-row picker below so that logic isn't duplicated for each.
const forecastModeOf=v=>{
  if(!v||v===FORECAST_MODEL_INHERIT)return FORECAST_MODEL_INHERIT;
  if(v==="committed")return "committed";
  if(v==="auto")return "auto";
  return "manual"; // "trailingN" (Manual, current or legacy preset) or the legacy "full-period"
};
const manualDaysOf=v=>{
  const m=/^trailing(\d+)$/.exec(v||"");
  return m?parseInt(m[1],10):DEFAULT_MANUAL_TRAILING_DAYS;
};
// Explanation of the forecasting plumbing (per Mo, 2026-07-25) — surfaced via an InfoTip next to
// the global control. Kept as one shared string (not JSX) so the exact same explanation shows up
// whether it's triggered from the global control or, in future, from anywhere else that wants it.
const FORECAST_EXPLANATION=`How projections work, in order:

1. Each platform's own spend is projected separately (not one blended rate for a segment), using that platform's own "as of" date — so a platform that's a week stale doesn't drag down one that's synced live.

2. Every day is first deseasonalized by that platform's day-of-week pattern (a quiet Sunday isn't read as "spend crashed") before any averaging happens — this applies underneath all three models below.

Auto (default): blends the full-period rate with the last ${AUTO_SHORT_WINDOW} days. Under ${Math.round(AUTO_DIVERGENCE_LOW*100)}% divergence between them, it trusts the full-period rate. Over ${Math.round(AUTO_DIVERGENCE_HIGH*100)}%, it trusts the recent rate. In between, it blends the two proportionally. No tuning needed.

Manual: projects from a trailing window of a specific number of days you choose — reacts to a recent budget change exactly as fast as your window is short, at the cost of more day-to-day noise the shorter it gets.

Committed: skips projection entirely — treats the budget as a known lump sum already spent (or actual spend, if that's already higher).`;

// src/components/PacingDashboard.jsx — Budget Pacing tab (2026-07-25 split, per Mo).
// Includes TrendBarChart and PacingBar, the two small chart components only this tab uses.

const TREND_COLORS=["#F97316","#3B82F6","#10B981","#8B5CF6","#EC4899","#F59E0B","#06B6D4"];
// Grouped bar chart (2026-07-30, per Mo — replaces the old line-chart TrendLineChart so Budget can
// sit alongside each spend series as its own bar per period; widened to fill the panel on 2026-07-30
// per Mo's follow-up, since a fixed pixel width left the common month/quarter/year case looking
// cramped against the left edge of a much wider panel).
//
// Two layout modes depending on bucket count:
// - Typical case (<=24 buckets — a two-year month view, a multi-year quarter/year view, or even a
//   few weeks of day-grain): bars are sized to fill the full panel width responsively, same as the
//   old line chart's width:"100%" behavior, so it never looks stranded on the left.
// - Dense case (>24 buckets — day/week grain over a multi-month range can mean hundreds of
//   buckets): bars get a fixed minimum pixel width instead of being squeezed to invisible slivers,
//   and the chart becomes horizontally scrollable so it stays legible.
const TrendBarChart=({T,periods,series,budgetValues})=>{
  const H=230,padL=56,padB=34,padT=12,padR=16;
  const barGap=3;
  const barsPerGroup=Math.max(1,series.length+(budgetValues?1:0));
  const n=Math.max(1,periods.length);
  const dense=n>24;
  let W,plotW,groupWidth,groupGap,barW;
  if(dense){
    barW=14;groupGap=18;
    groupWidth=barsPerGroup*barW+(barsPerGroup-1)*barGap;
    plotW=n*groupWidth+Math.max(0,n-1)*groupGap;
    W=padL+padR+plotW;
  }else{
    W=720; // viewBox reference only — actual rendered size stretches to 100% of the panel below
    plotW=W-padL-padR;
    groupGap=Math.min(18,(plotW/n)*0.3);
    groupWidth=Math.max(6,plotW/n-groupGap);
    barW=Math.max(2,(groupWidth-(barsPerGroup-1)*barGap)/barsPerGroup);
  }
  const plotH=H-padT-padB;
  const maxY=Math.max(1,...(budgetValues||[]),...series.flatMap(s=>s.values));
  const yFor=v=>padT+plotH-(v/maxY)*plotH;
  const yTicks=[0,0.25,0.5,0.75,1].map(f=>Math.round(maxY*f));
  const fmtTick=v=>v>=1000?`$${Math.round(v/1000)}k`:`$${v}`;
  // Day/week grain over a multi-month range can produce far more buckets than there's room for
  // one label each (a 6-month day view is ~180 groups) — thin the x-axis labels out to roughly
  // one every 28px instead of cramming every single one in and rendering them unreadable.
  const labelStep=Math.max(1,Math.ceil(28/(groupWidth+groupGap)));
  const chart=(
    <svg viewBox={`0 0 ${W} ${H}`} {...(dense?{width:W}:{})} style={{width:dense?undefined:"100%",height:"auto",display:"block"}}>
      {yTicks.map((t,i)=>{
        const y=yFor(t);
        return(
          <g key={i}>
            <line x1={padL} y1={y} x2={W-padR} y2={y} stroke={T.border} strokeWidth={1}/>
            <text x={padL-8} y={y+3} textAnchor="end" fontSize={9} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>{fmtTick(t)}</text>
          </g>
        );
      })}
      {periods.map((p,pi)=>{
        const groupX=padL+pi*(groupWidth+groupGap);
        let barX=groupX;
        const bars=[];
        if(budgetValues){
          const v=budgetValues[pi]||0;
          const h=(v/maxY)*plotH;
          bars.push(<rect key="budget" x={barX} y={padT+plotH-h} width={barW} height={h} fill={T.textMuted} opacity={0.35} rx={2}/>);
          barX+=barW+barGap;
        }
        series.forEach((s,si)=>{
          const v=s.values[pi]||0;
          const h=(v/maxY)*plotH;
          bars.push(<rect key={s.label} x={barX} y={padT+plotH-h} width={barW} height={h} fill={TREND_COLORS[si%TREND_COLORS.length]} rx={2}/>);
          barX+=barW+barGap;
        });
        return(
          <g key={p.key}>
            {bars}
            {pi%labelStep===0&&(
              <text x={groupX+groupWidth/2} y={H-10} textAnchor="middle" fontSize={9} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>{p.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
  return dense?<div style={{overflowX:"auto"}}>{chart}</div>:chart;
};

const PacingBar=({actualPct,expectedPct,status,T})=>{
  const pct=Math.min(1,Math.max(0,actualPct||0));
  const meta=pacingStatusMeta(status,T);
  return(
    <div style={{position:"relative",width:84,height:6,borderRadius:T.r3,background:T.surfaceEl,flexShrink:0}}>
      <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct*100}%`,background:meta.color,borderRadius:T.r3,transition:"width 0.2s"}}/>
      <div title="Expected pace" style={{position:"absolute",left:`${Math.min(1,Math.max(0,expectedPct))*100}%`,top:-2,bottom:-2,width:2,background:T.text,opacity:0.45}}/>
    </div>
  );
};

// Numeric threshold filter chips (2026-07-28, per Mo — "daily burn > $500", "pacing over 100%",
// etc., alongside the existing per-dimension text filters). Shared by both the budget-mode and
// custom-mode filter bars below — `mode` picks which NUMERIC_FIELDS entries are offered, since
// custom-mode segments have no budget/actualPct/projectedVariance (see core.js's NUMERIC_FIELDS
// doc comment). Renders existing filters as removable pills plus a "+ Add filter" control that
// expands into a field/operator/value picker. Percent fields (currently just Pacing/actualPct)
// are typed as a human percent (e.g. "50") and converted to the internal fraction (0.5) — see
// NUMERIC_FIELDS[field].isPct — right when the filter is added, so everything stored in
// numericFilters is already apples-to-apples with the segment property it'll be compared against.
const NumericFilterChips=({numericFilters,setNumericFilters,mode,T})=>{
  const[open,setOpen]=useState(false);
  const[field,setField]=useState("");
  const[operator,setOperator]=useState(">");
  const[value,setValue]=useState("");
  const fields=Object.entries(NUMERIC_FIELDS).filter(([,meta])=>meta.modes.includes(mode));
  if(!fields.length)return null;
  const addFilter=()=>{
    const n=parseFloat(value);
    if(!field||Number.isNaN(n))return;
    const meta=NUMERIC_FIELDS[field];
    setNumericFilters(p=>[...p,{field,operator,value:meta.isPct?n/100:n}]);
    setField("");setOperator(">");setValue("");setOpen(false);
  };
  const fmtChipValue=f=>{
    const meta=NUMERIC_FIELDS[f.field];
    if(!meta)return String(f.value);
    return meta.isPct?`${Math.round(f.value*1000)/10}%`:fmtFull(f.value);
  };
  return(
    <>
      {numericFilters.map((f,i)=>(
        <Pill key={i} color={T.text} bg={T.pill} border={T.pillBorder} style={{fontSize:12*(T.fsScale||1),display:"flex",alignItems:"center",gap:5}}>
          {(NUMERIC_FIELDS[f.field]?.label||f.field)} {f.operator} {fmtChipValue(f)}
          <span onClick={()=>setNumericFilters(p=>p.filter((_,idx)=>idx!==i))} title="Remove filter" style={{cursor:"pointer",color:T.textMuted,lineHeight:1}}>✕</span>
        </Pill>
      ))}
      {open?(
        <div style={{display:"flex",gap:4,alignItems:"center"}}>
          <Sel value={field} onChange={setField} T={T} style={{width:112}}>
            <option value="">Field…</option>
            {fields.map(([k,meta])=><option key={k} value={k}>{meta.label}</option>)}
          </Sel>
          <Sel value={operator} onChange={setOperator} T={T} style={{width:52}}>
            {NUMERIC_OPERATORS.map(op=><option key={op} value={op}>{op}</option>)}
          </Sel>
          <input value={value} onChange={e=>setValue(e.target.value)} type="number"
            placeholder={field&&NUMERIC_FIELDS[field]?.isPct?"%":"$"}
            onKeyDown={e=>{if(e.key==="Enter")addFilter();if(e.key==="Escape")setOpen(false);}}
            style={{width:76,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 8px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
          <Btn onClick={addFilter} disabled={!field||value===""} variant="primary" size="sm" T={T}>Add</Btn>
          <Btn onClick={()=>{setOpen(false);setField("");setOperator(">");setValue("");}} variant="ghost" size="sm" T={T}>✕</Btn>
        </div>
      ):(
        <Btn onClick={()=>setOpen(true)} variant="ghost" size="sm" T={T}>+ Add filter</Btn>
      )}
    </>
  );
};

// Pacing-status → Venture semantic-token bubble (2026-08-07, per Mo — "all colors on theme"). The
// legacy pacingStatusMeta() colors come off the T-theme object (e.g. "behind" = the old #006CFF
// blue), so the status pill maps status → the on-theme success/warning/info/destructive tint pair
// instead; committed/no-data/no-budget stay neutral.
function statusBubbleClass(status){
  switch(status){
    case"over":return"bg-destructive-bg text-destructive";
    case"ahead":return"bg-warning-bg text-warning";
    case"behind":return"bg-info-bg text-info";
    case"on-track":return"bg-success-bg text-success";
    default:return"bg-secondary text-muted-foreground";
  }
}

export default function PacingDashboard({campaignTags,setTags,tagDimensions,budgetDims,budgets,setBudgets,budgetRowMeta,setBudgetRowMeta,savedViews,setSavedViews,defaultForecastModel,setDefaultForecastModel,mergedNormRows,T,session,workspace,onNavigate,sidebarEl,canEdit=true,onAskAboutView,initialViewConfig,onConsumeInitialViewConfig,combineGoogleChannels=false}){
  const now=new Date();
  const yr=now.getFullYear();
  // Period/filter/view-mode controls below are persisted to localStorage (2026-07-30, per Mo —
  // "whatever screen with whatever filters on any tab I've selected" should survive a refresh, not
  // reset back to defaults). Purely transient UI state (row selection, expanded rows, in-place
  // editing, the notif toast) stays on plain useState below, unpersisted on purpose — see
  // usePersistentState's doc comment in shared.jsx.
  const[year,setYear]=usePersistentState("paidhq_pacing_year",yr.toString());
  const[periodType,setPeriodType]=usePersistentState("paidhq_pacing_periodType","monthly");
  const[month,setMonth]=usePersistentState("paidhq_pacing_month",()=>String(now.getMonth()+1).padStart(2,"0"));
  const[quarter,setQuarter]=usePersistentState("paidhq_pacing_quarter",()=>`Q${Math.floor(now.getMonth()/3)+1}`);
  const years=[(yr-1).toString(),yr.toString(),(yr+1).toString()];

  const[selRows,setSelRows]=useState(new Set());
  const[segFilters,setSegFilters]=usePersistentState("paidhq_pacing_segFilters",{}); // {dim: filterText} — substring match, ANDed across dims
  const[numericFilters,setNumericFilters]=usePersistentState("paidhq_pacing_numericFilters",[]); // [{field,operator,value}] — see NumericFilterChips/NUMERIC_FIELDS; ANDed with each other and with segFilters/statusFilter
  const[statusFilter,setStatusFilter]=usePersistentState("paidhq_pacing_statusFilter","all");
  const[notif,setNotif]=useState(null);
  const[editingSegVal,setEditingSegVal]=useState(null); // {segKey, dim}
  const[editSegVal,setEditSegVal]=useState("");
  const[breakdownDim,setBreakdownDim]=usePersistentState("paidhq_pacing_breakdownDim",""); // "" = no drill-down; else "Platform" or a tag dimension
  const[expandedRows,setExpandedRows]=useState(new Set());
  const showNotif=msg=>{setNotif(msg);setTimeout(()=>setNotif(null),3000);};
  // See buildCampaignPlatformIndex's doc comment — needed anywhere budgetDims might include
  // "Platform", since that value is never actually stored in campaignTags.
  const platformIndex=useMemo(()=>buildCampaignPlatformIndex(mergedNormRows),[mergedNormRows]);

  // "View by" — the table's PRIMARY grouping is normally your budget segments (BU/Pillar/Product,
  // whatever budgetDims is set to), since that's the only grouping with a $ budget attached to
  // compare against. "custom" lets you regroup the whole table by any combination of dimensions
  // instead — e.g. Platform alone, or Platform + Region — trading the Budget/Pacing/Status columns
  // (there's no budget defined at an arbitrary grouping like that) for Spend/Daily Burn/Projected
  // computed fresh for whatever combination you pick.
  // Defaults to "custom" (not "budget") when no budget structure exists yet — spend-by-dimension
  // is still valuable before anyone's set up budgets, so this shouldn't force people through Budget
  // Panel first just to see how spend breaks out by Platform/tags. customDims seeds to ["Platform"]
  // in that case so the table renders something useful immediately, not an empty "pick a dimension"
  // state.
  const[viewMode,setViewMode]=usePersistentState("paidhq_pacing_viewMode",()=>budgetDims.length?"budget":"custom"); // "budget" | "custom" | "trend"
  const[customDims,setCustomDims]=usePersistentState("paidhq_pacing_customDims",()=>budgetDims.length?[]:["Platform"]);
  const allDimOptions=["Platform","Campaign","Ad Group",...(tagDimensions||[])];
  const activeDims=viewMode==="custom"?customDims:budgetDims;
  const changeViewMode=v=>{setViewMode(v);setSelRows(new Set());setExpandedRows(new Set());setBreakdownDim("");setSegFilters({});};
  const toggleCustomDim=d=>{setCustomDims(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d]);setExpandedRows(new Set());setBreakdownDim("");setSegFilters({});};

  // "Trend" — the third View-by mode, distinct from budget/custom above: those two answer "how
  // much for ONE period you pick," this answers "how did spend change over SEVERAL months" for a
  // segment you narrow down to (e.g. a specific tag value like "ISW Branded Search") split into a
  // line per channel/platform. Its own filter/series state, separate from segFilters/breakdownDim
  // above, since it's a genuinely different shape (a date RANGE spanning many months, not a single
  // period) rather than another variation on the existing budget/custom table.
  const monthStr=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  const[trendFilterDim,setTrendFilterDim]=usePersistentState("paidhq_pacing_trendFilterDim","");
  const[trendFilterValue,setTrendFilterValue]=usePersistentState("paidhq_pacing_trendFilterValue","");
  const[trendSeriesDim,setTrendSeriesDim]=usePersistentState("paidhq_pacing_trendSeriesDim","Platform");
  // Grain (2026-07-30, per Mo — day/week added alongside the original month/quarter/year since
  // we're synced live with most ad channels; monthly-only sources like Google's bulk uploads just
  // show one flat step per month at day/week grain, which is expected, not a bug).
  const[trendGrain,setTrendGrain]=usePersistentState("paidhq_pacing_trendGrain","month"); // "day"|"week"|"month"|"quarter"|"year"
  const[trendStartMonth,setTrendStartMonth]=usePersistentState("paidhq_pacing_trendStartMonth",()=>monthStr(new Date(now.getFullYear(),now.getMonth()-5,1)));
  const[trendEndMonth,setTrendEndMonth]=usePersistentState("paidhq_pacing_trendEndMonth",()=>monthStr(now));
  const trendFilterOptions=allDimOptions.filter(d=>d!==trendSeriesDim);
  const trendSeriesOptions=allDimOptions.filter(d=>d!==trendFilterDim);

  // ── Saved Views (item 42) — save the current View-by setup (mode + dims/filters/status/
  // breakdown, or trend filter/series/window length) as a named view for one-click recall.
  // Deliberately does NOT capture year/periodType/month/quarter, or an absolute trend date range —
  // per Mo, a saved view should always reflect whatever period you're currently looking at (or a
  // rolling N-month trend window ending "now"), not be frozen to the exact period it was saved in,
  // so e.g. "Meta segments behind pace" stays useful every quarter instead of only ever showing
  // Q1 2026. trendMonthSpan is that rolling-window length in months, recomputed against "now" every
  // time the view is applied (see applyViewConfig below) rather than storing absolute months.
  const monthsBetween=(startStr,endStr)=>{
    const[sy,sm]=startStr.split("-").map(Number);
    const[ey,em]=endStr.split("-").map(Number);
    return Math.max(1,(ey-sy)*12+(em-sm)+1);
  };
  const[savedViewModalOpen,setSavedViewModalOpen]=useState(false);
  const[savedViewNameDraft,setSavedViewNameDraft]=useState("");
  const[savedViewsMenuOpen,setSavedViewsMenuOpen]=useState(false);
  const[aiViewOpen,setAiViewOpen]=useState(false);
  const[aiViewQuestion,setAiViewQuestion]=useState("");
  const[aiViewLoading,setAiViewLoading]=useState(false);
  const[aiViewError,setAiViewError]=useState("");

  // The canonical view-config shape — built from live UI state here, or from AI output via
  // aiConfigToViewConfig — that both savedViews entries and applyViewConfig below share.
  const currentViewConfig=()=>({
    viewMode,
    customDims:viewMode==="custom"?customDims:[],
    segFilters:viewMode!=="trend"?segFilters:{},
    statusFilter:viewMode==="budget"?statusFilter:"all",
    breakdownDim:viewMode!=="trend"?breakdownDim:"",
    numericFilters:viewMode!=="trend"?numericFilters:[],
    trendFilterDim:viewMode==="trend"?trendFilterDim:"",
    trendFilterValue:viewMode==="trend"?trendFilterValue:"",
    trendSeriesDim:viewMode==="trend"?trendSeriesDim:"Platform",
    trendMonthSpan:viewMode==="trend"?monthsBetween(trendStartMonth,trendEndMonth):6,
    trendGrain:viewMode==="trend"?trendGrain:"month",
  });
  // The one function both "click a saved view" and "AI view applied" funnel through, so the two
  // entry points can never drift into different behavior for the same config shape.
  const applyViewConfig=cfg=>{
    setViewMode(cfg.viewMode);
    setSelRows(new Set());setExpandedRows(new Set());
    if(cfg.viewMode==="custom")setCustomDims(cfg.customDims?.length?cfg.customDims:["Platform"]);
    if(cfg.viewMode==="trend"){
      const span=Math.min(24,Math.max(1,cfg.trendMonthSpan||6));
      setTrendEndMonth(monthStr(now));
      setTrendStartMonth(monthStr(new Date(now.getFullYear(),now.getMonth()-(span-1),1)));
      setTrendFilterDim(cfg.trendFilterDim||"");
      setTrendFilterValue(cfg.trendFilterValue||"");
      setTrendSeriesDim(cfg.trendSeriesDim||"Platform");
      setTrendGrain(cfg.trendGrain||"month");
      setSegFilters({});setStatusFilter("all");setBreakdownDim("");setNumericFilters([]);
    }else{
      setSegFilters(cfg.segFilters||{});
      setStatusFilter(cfg.viewMode==="budget"?(cfg.statusFilter||"all"):"all");
      setBreakdownDim(cfg.breakdownDim||"");
      setNumericFilters(cfg.numericFilters||[]);
    }
  };
  // Consumes AskAI's "Save as view" relay (2026-07-29, per Mo — see PaidHQ.jsx's
  // pendingViewConfig doc comment) — initialViewConfig arrives already in the canonical shape
  // (built by AskAI.jsx's handleSaveAsView via the same aiConfigToViewConfig this component's own
  // "Ask AI to build a view" box uses below), so this just applies it and clears the relay. Unlike
  // AskAI.jsx's single-field initialQuestion (a lazy useState initializer), applyViewConfig fans
  // out into ~9 separate state setters depending on cfg.viewMode, so there's no single-field lazy
  // initializer to convert this into — this genuinely is "apply an external handoff on arrival,"
  // not "sync a prop into state" in the sense react-hooks/set-state-in-effect warns about (this
  // component gets a fresh mount every time the handoff arrives — see the pendingViewConfig doc
  // comment — so this effect body runs at most once per mount, exactly like a constructor would).
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot external handoff consumed on
     arrival (applyViewConfig fans out into several setState calls internally), not a prop-into-
     state sync; see the doc comment above this effect for why that distinction holds here. */
  useEffect(()=>{
    if(initialViewConfig){
      applyViewConfig(initialViewConfig);
      onConsumeInitialViewConfig?.();
      showNotif("Applied view from Ask AI");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[initialViewConfig,onConsumeInitialViewConfig]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const openSaveViewModal=prefillName=>{setSavedViewNameDraft(prefillName||"");setSavedViewModalOpen(true);};
  const saveCurrentView=()=>{
    const name=savedViewNameDraft.trim();
    if(!name)return;
    const view={id:`sv_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,name,createdAt:new Date().toISOString(),...currentViewConfig()};
    setSavedViews?.(p=>[...(p||[]),view]);
    setSavedViewModalOpen(false);setSavedViewNameDraft("");
    showNotif(`Saved view "${name}"`);
  };
  const applySavedView=view=>{applyViewConfig(view);setSavedViewsMenuOpen(false);showNotif(`Applied "${view.name}"`);};
  const deleteSavedView=(id,name)=>{
    if(!window.confirm(`Delete saved view "${name}"?`))return;
    setSavedViews?.(p=>(p||[]).filter(v=>v.id!==id));
  };
  // "AI-driven views" (item 42) — a plain-English request gets turned into a View-by config via
  // askAIBuildView's tool-use loop, applied immediately, then the Save View modal opens pre-filled
  // with the AI's suggested name so it can become a normal saved view in one click if it's useful.
  const runAiView=async()=>{
    const q=aiViewQuestion.trim();
    if(!q)return;
    setAiViewLoading(true);setAiViewError("");
    try{
      const raw=await askAIBuildView({question:q,ctx:{mergedNormRows,tags:campaignTags,tagDims:tagDimensions,budgetDims,budgets,budgetRowMeta},token:session?.access_token});
      const canonical=aiConfigToViewConfig(raw,{allDimOptions,budgetDims});
      applyViewConfig(canonical);
      setAiViewOpen(false);setAiViewQuestion("");
      openSaveViewModal(raw.name||"AI view");
      showNotif("Applied AI view — review and save it if it's useful");
    }catch(err){
      setAiViewError(err.message||"Couldn't build that view.");
    }finally{
      setAiViewLoading(false);
    }
  };

  // Selecting rows only makes sense within the period/year currently being viewed — clear on change
  const changeYear=y=>{setYear(y);setSelRows(new Set());};
  const changePeriodType=k=>{setPeriodType(k);setSelRows(new Set());};
  const changeMonth=m=>{setMonth(m);setSelRows(new Set());};
  const changeQuarter=q=>{setQuarter(q);setSelRows(new Set());};
  // Breakdown options: whatever isn't already used as the primary grouping (budgetDims, or
  // customDims in the custom view) is offered as a secondary drill-down.
  const breakdownOptions=allDimOptions.filter(d=>!activeDims.includes(d));
  const toggleExpand=key=>setExpandedRows(p=>{const nx=new Set(p);nx.has(key)?nx.delete(key):nx.add(key);return nx;});

  const pacing=useMemo(()=>computePacing({mergedNormRows,tags:campaignTags,budgetDims,budgets,year,periodType,month,quarter,today:now,budgetRowMeta,defaultForecastModel,combineGoogleChannels}),
    [mergedNormRows,campaignTags,budgetDims,budgets,year,periodType,month,quarter,budgetRowMeta,defaultForecastModel,combineGoogleChannels]); // eslint-disable-line react-hooks/exhaustive-deps
  const platformDateRange=useMemo(()=>computePlatformDateRange(mergedNormRows),[mergedNormRows]);
  const customPacing=useMemo(()=>viewMode==="custom"&&customDims.length?computeCustomGrouping({mergedNormRows,tags:campaignTags,dims:customDims,year,periodType,month,quarter,today:now,combineGoogleChannels}):null,
    [viewMode,mergedNormRows,campaignTags,customDims,year,periodType,month,quarter,combineGoogleChannels]); // eslint-disable-line react-hooks/exhaustive-deps
  const trendRange=useMemo(()=>{
    const[sy,sm]=trendStartMonth.split("-").map(Number);
    const[ey,em]=trendEndMonth.split("-").map(Number);
    let start=new Date(sy,sm-1,1),end=new Date(ey,em,0,23,59,59,999); // end = last day of end month
    if(start>end)[start,end]=[end,start]; // swapped range picker inputs shouldn't produce zero months
    return{start,end};
  },[trendStartMonth,trendEndMonth]);
  const trendData=useMemo(()=>viewMode==="trend"?computeSpendTrend({mergedNormRows,tags:campaignTags,filterDim:trendFilterDim,filterValue:trendFilterValue,seriesDim:trendSeriesDim,start:trendRange.start,end:trendRange.end,grain:trendGrain,budgets,budgetDims,combineGoogleChannels}):null,
    [viewMode,mergedNormRows,campaignTags,trendFilterDim,trendFilterValue,trendSeriesDim,trendRange,trendGrain,budgets,budgetDims,combineGoogleChannels]);

  // MQL goal/actual (2026-08-06, per Mo) — fetched once per workspace, unfiltered by period on
  // purpose (unlike spend, reporting_facts rows can be a coarser grain than the current view — see
  // computeReportingMetricTrend's doc comment above — so period filtering happens client-side
  // against the actual overlap, not via the API's strict period_start >= start / <= end filter).
  // reporting_facts is a small, aggregated-by-period dataset per workspace (not one row per
  // campaign per day like spend_rows), so fetching it unfiltered here is cheap.
  const[reportingFacts,setReportingFacts]=useState([]);
  useEffect(()=>{
    if(!workspace?.id)return;
    listReportingFacts(session,workspace.id).then(setReportingFacts).catch(()=>{});
  },[session,workspace?.id]);
  const mqlTrend=useMemo(()=>(viewMode==="trend"&&trendData)?computeReportingMetricTrend({reportingFacts,metricKey:"mqls",filterDim:trendFilterDim,filterValue:trendFilterValue,periodRanges:trendData.periods.map(p=>periodKeyRange(trendGrain,p.key))}):null,
    [viewMode,trendData,reportingFacts,trendFilterDim,trendFilterValue,trendGrain]);
  // Single-period MQL Goal/Actual (2026-08-06, per Mo — "we should have monthly, quarterly and
  // yearly for MQLs," i.e. this figure should track whatever Monthly/Quarterly/Yearly period the
  // Budget/Custom view (not just Trend) is currently set to, via the SAME year/periodType/month/
  // quarter picker pacing/customPacing above already use). One-element periodRanges array — see
  // computeReportingMetricTrend's doc comment for why it accepts ranges generically instead of only
  // the Trend view's multi-column shape. Workspace-wide (not per-segment) on purpose, for now — a
  // per-segment MQL breakdown would need reporting_facts rows matched against budgetDims the same
  // way spend rows are, real added scope beyond what was asked for here.
  const periodRange=useMemo(()=>{const{start,end}=getPeriodRange(periodType,year,month,quarter);return{start,end};},[periodType,year,month,quarter]);
  const periodMqlTrend=useMemo(()=>computeReportingMetricTrend({reportingFacts,metricKey:"mqls",periodRanges:[periodRange]}),
    [reportingFacts,periodRange]);

  const filteredSegments=useMemo(()=>pacing.segments.filter(seg=>{
    if(statusFilter!=="all"&&seg.status!==statusFilter)return false;
    if(!matchesNumericFilters(seg,numericFilters))return false;
    return budgetDims.every((d,i)=>{
      const f=(segFilters[d]||"").trim().toLowerCase();
      return!f||(seg.dims[i]||"").toLowerCase().includes(f);
    });
  }),[pacing.segments,budgetDims,segFilters,statusFilter,numericFilters]);
  // Same filtering, parametrized on customDims — kept separate from filteredSegments above rather
  // than merging the two into one generalized function, so the existing budget-segment table (and
  // everything wired to it — edit/delete/rename/bulk-actions) stays completely untouched.
  const filteredCustomSegments=useMemo(()=>(customPacing?.segments||[]).filter(seg=>
    matchesNumericFilters(seg,numericFilters)&&customDims.every((d,i)=>{
      const f=(segFilters[d]||"").trim().toLowerCase();
      return!f||(seg.dims[i]||"").toLowerCase().includes(f);
    })
  ),[customPacing,customDims,segFilters,numericFilters]);
  const hasSegFilters=statusFilter!=="all"||numericFilters.length>0||Object.values(segFilters).some(v=>(v||"").trim());
  const clearSegFilters=()=>{setSegFilters({});setStatusFilter("all");setNumericFilters([]);};

  // Export (2026-08-01, per Mo — "export function from the budget pacing tab to csv, excel, pdf,
  // google sheets"). Builds from filteredSegments/filteredCustomSegments — the exact same rows
  // the table on screen already computes — so the export always matches whatever period (Mo/Qtr/
  // Yr) and filters are currently active. This replaces the old top-rail "More" menu's export for
  // this tab (see reports.js's doc comment on the removed buildPacingReport): that one had no way
  // to see this component's own period-selection state, so it was hardcoded to a full-year rollup
  // regardless of what was actually on screen. Only meaningful for the two table view modes;
  // Trend is a chart, so the Export control is simply hidden there (see the JSX below).
  const buildPacingExportReport=()=>{
    const isCustom=viewMode==="custom";
    const dims=isCustom?customDims:budgetDims;
    const segs=isCustom?filteredCustomSegments:filteredSegments;
    const expectedPct=isCustom?(customPacing?.expectedPct??0):pacing.expectedPct;
    const headers=isCustom
      ?[...dims,"Spend","Daily Burn","Projected"]
      :[...dims,"Budget","Spend PTD","Pacing","Expected","Daily Burn","Projected","Projected %","Variance","Status"];
    const rows=segs.map(seg=>isCustom?[
      ...seg.dims,
      fmtFull(seg.spend),
      `${fmtFull(seg.dailyRate)}/day`,
      seg.projected!=null?fmtFull(seg.projected):"—",
    ]:[
      ...seg.dims,
      seg.budget>0?fmtFull(seg.budget):"—",
      fmtFull(seg.spend),
      seg.actualPct!=null?`${Math.round(seg.actualPct*100)}%`:"—",
      `${Math.round(expectedPct*100)}%`,
      `${fmtFull(seg.dailyRate)}/day`,
      seg.projected!=null?fmtFull(seg.projected):"—",
      seg.projected!=null&&seg.budget>0?`${Math.round((seg.projected/seg.budget)*100)}%`:"—",
      seg.projectedVariance!=null?fmtSigned(seg.projectedVariance):"—",
      pacingStatusMeta(seg.status,T).label,
    ]);
    return{
      title:"Budget Pacing export",
      subtitle:`${periodLabel} · ${pacing.elapsedDays} of ${pacing.totalDays} days elapsed · Generated ${new Date().toLocaleString()}`,
      sections:[{heading:`${isCustom?"Custom":"Budget"} segments — ${periodLabel}`,headers,rows}],
    };
  };
  const[exportMenuOpen,setExportMenuOpen]=useState(false);
  const[sheetsExporting,setSheetsExporting]=useState(false);
  const handleExportDownload=format=>{
    downloadReport(buildPacingExportReport(),format,"paidhq-budget-pacing");
    setExportMenuOpen(false);
  };
  const handleExportToGoogleSheets=async()=>{
    setExportMenuOpen(false);
    // Same synchronous-blank-tab pattern as the rail's Google Sheets export (see PaidHQ.jsx) —
    // opening the tab here, before the awaited API call, keeps it inside the click's "user
    // gesture" window so browsers don't pop-up-block it.
    const preOpened=window.open("","_blank","noopener,noreferrer");
    if(preOpened)preOpened.document.write("<title>Exporting…</title><body style=\"font-family:sans-serif;color:#666;padding:40px\">Creating your Google Sheet…</body>");
    setSheetsExporting(true);
    try{
      const url=await exportReportToGoogleSheets(buildPacingExportReport());
      if(preOpened&&!preOpened.closed)preOpened.location.href=url;
      else window.open(url,"_blank","noopener,noreferrer");
    }catch(e){
      console.error("[budget pacing google sheets export]",e);
      if(preOpened&&!preOpened.closed)preOpened.close();
      window.alert(e.message||"Couldn't export to Google Sheets. Try again.");
    }finally{
      setSheetsExporting(false);
    }
  };

  // "Ask AI about this view →" (2026-07-28, per Mo's scope-awareness ask) — templates the
  // currently active View-by mode + filters into a plain-English question and hands it to
  // onAskAboutView (wired up in PaidHQ.jsx to stash it and switch to the Ask AI tab). This is
  // the fix for a real gap: Ask AI's chat always queries the full unfiltered dataset from
  // scratch, with zero awareness of whatever's on screen here unless the question restates it —
  // this button restates it for you instead of leaving Ask AI blind to your filters.
  const fmtNumFilterVal=f=>{
    const meta=NUMERIC_FIELDS[f.field];
    if(!meta)return String(f.value);
    return meta.isPct?`${Math.round(f.value*1000)/10}%`:fmtFull(f.value);
  };
  const buildAskAboutViewText=()=>{
    if(viewMode==="trend"){
      const bits=[`from ${trendStartMonth} to ${trendEndMonth}`,`by ${trendGrain}`,`split by ${trendSeriesDim}`];
      if(trendFilterDim&&trendFilterValue)bits.push(`filtered to ${trendFilterDim} = "${trendFilterValue}"`);
      return `Looking at the Budget Pacing Trend view, ${bits.join(", ")}. What's the trend telling us, and is anything worth flagging?`;
    }
    const segBits=Object.entries(segFilters).filter(([,v])=>(v||"").trim()).map(([d,v])=>`${d} contains "${v.trim()}"`);
    const numBits=numericFilters.map(f=>`${NUMERIC_FIELDS[f.field]?.label||f.field} ${f.operator} ${fmtNumFilterVal(f)}`);
    if(viewMode==="custom"){
      const bits=[`grouped by ${customDims.join(" + ")||"(no dimension selected)"}`,...segBits,...numBits];
      if(breakdownDim)bits.push(`broken down by ${breakdownDim}`);
      return `Looking at the Reporting & Pacing Custom view for ${periodLabel}, ${bits.join(", ")}. What should I know about this?`;
    }
    const bits=[];
    if(statusFilter!=="all")bits.push(`status = ${statusFilter}`);
    bits.push(...segBits,...numBits);
    if(breakdownDim)bits.push(`broken down by ${breakdownDim}`);
    const filterText=bits.length?`filtered to ${bits.join(", ")}`:"with no filters applied (the full set of budget segments)";
    return `Looking at the Reporting & Pacing Budget Segments view for ${periodLabel}, ${filterText}. What should I know about this?`;
  };
  // A plain helper function returning JSX, called directly at each use site (NOT a capitalized
  // component invoked as a JSX tag) — an inline component defined inside another component's body
  // gets torn down and recreated every render, which react-hooks' static-components rule flags
  // (and rightly so: it'd reset any state/identity on every keystroke elsewhere in the tab).
  const renderAskAboutViewBtn=style=>onAskAboutView&&(
    <Btn onClick={()=>onAskAboutView(buildAskAboutViewText())} variant="ghost" size="sm" T={T} style={{gap:5,...style}} title="Send this view's current filters to Ask AI as a starting question">
      <Icon name="sparkle" size={12} color={T.accent}/> Ask AI about this view
    </Btn>
  );
  const toggleRowSel=key=>setSelRows(p=>{const nx=new Set(p);nx.has(key)?nx.delete(key):nx.add(key);return nx;});
  const selAllRows=()=>setSelRows(selRows.size===filteredSegments.length?new Set():new Set(filteredSegments.map(s=>s.segKey)));

  const saveSegEdit=()=>{
    if(!canEdit)return;
    if(!editingSegVal)return;
    const trimmed=editSegVal.trim();
    if(!trimmed){setEditingSegVal(null);setEditSegVal("");return;}
    const{segKey,dim}=editingSegVal;
    const seg=pacing.segments.find(s=>s.segKey===segKey);
    if(!seg){setEditingSegVal(null);setEditSegVal("");return;}
    const dimIdx=budgetDims.indexOf(dim);
    const oldVal=seg.dims[dimIdx];
    if(oldVal===trimmed){setEditingSegVal(null);setEditSegVal("");return;}
    const newKey=budgetDims.map((d,i)=>i===dimIdx?trimmed:seg.dims[i]).join("|");
    // Renames everywhere — budgets across all years, budgetRowMeta, and any campaign tagged
    // with the old value — so the segment reconnects to real spend, not just relabels a row.
    const result=renameDimensionValue({budgets,budgetRowMeta,tags:campaignTags,budgetDims,dim,oldVal,newVal:trimmed});
    setBudgets(result.budgets);
    setBudgetRowMeta?.(result.budgetRowMeta);
    setTags?.(result.tags);
    setSelRows(p=>{const nx=new Set(p);if(nx.has(segKey)){nx.delete(segKey);nx.add(newKey);}return nx;});
    showNotif(`Renamed "${oldVal}" → "${trimmed}" — updated budgets and tagged campaigns`);
    setEditingSegVal(null);setEditSegVal("");
  };

  const deleteSegment=(segKey,label)=>{
    if(!canEdit)return;
    const matchCount=countSegmentCampaigns(campaignTags,budgetDims,segKey,platformIndex);
    const tagNote=matchCount>0?` This also un-tags ${matchCount} matching campaign${matchCount>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete "${label}"?\n\nThis removes all monthly budget values for this segment in ${year}.${tagNote}`))return;
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(nx[year])delete nx[year][segKey];return nx;});
    setBudgetRowMeta?.(p=>{const nx={...p};delete nx[segKey];return nx;});
    setTags?.(p=>untagSegmentCampaigns(p,budgetDims,segKey,platformIndex));
    setSelRows(p=>{const nx=new Set(p);nx.delete(segKey);return nx;});
    showNotif(matchCount>0?`Segment deleted — un-tagged ${matchCount} campaign${matchCount>1?"s":""}`:"Segment deleted");
  };
  // Per-segment forecast model (item 45, redesigned 2026-07-25 into Auto/Manual/Committed — see
  // forecastModeOf/manualDaysOf and FORECAST_MODELS' doc comment in lib/core.js) — lives here, not
  // the Budget Panel, per Mo: choosing HOW a segment's spend gets projected is a pacing/projection
  // decision, not a budget-setup one, so the picker belongs where you're actually looking at pacing
  // status and projected spend. Same underscore-prefixed budgetRowMeta storage as everywhere else
  // (_notBudgeted in BudgetManager, etc.) — this reads/writes the exact same shared object, just
  // from this tab instead. Falls back to the pre-multi-model `_committed` boolean for rows toggled
  // on before this shipped.
  //
  // Global default (2026-07-25, per Mo: "there should be a global forecasting model selector
  // instead of just individual rows. the individual row selector should override the global") —
  // getForecastModelOverride returns "" (FORECAST_MODEL_INHERIT) when a row has no explicit
  // override, which is what drives the row picker's displayed mode; getEffectiveForecastModel is
  // the value actually used for computation (mirrors computePacing's own fallback chain exactly,
  // so what's shown here can never drift from what's projected). setForecastModel's "" case is the
  // row's "go back to inheriting the global default" action — same underlying storage as before
  // (deleting the key), just reachable from an explicit menu item now instead of only implicitly.
  const getForecastModelOverride=segKey=>{
    const m=budgetRowMeta?.[segKey]||{};
    return m._forecastModel||(m._committed?"committed":FORECAST_MODEL_INHERIT);
  };
  const getEffectiveForecastModel=segKey=>getForecastModelOverride(segKey)||defaultForecastModel||"auto";
  const setForecastModel=(segKey,model)=>{
    if(!canEdit)return;
    setBudgetRowMeta?.(p=>{
      const nx={...p};
      const cur={...(nx[segKey]||{})};
      delete cur._committed; // legacy key, fully superseded by _forecastModel going forward
      if(model===FORECAST_MODEL_INHERIT)delete cur._forecastModel;else cur._forecastModel=model;
      nx[segKey]=cur;
      return nx;
    });
  };
  // Row picker's onChange target — takes the 3-way mode (inherit/auto/committed/manual) selected
  // in the <select> and writes the actual stored value: "manual" needs a day count, which it either
  // reuses from the row's existing override (switching Manual's number, or coming from a different
  // mode back to a Manual row someone had already set) or falls back to DEFAULT_MANUAL_TRAILING_DAYS
  // for a row going into Manual for the very first time.
  const setForecastModelMode=(segKey,mode)=>{
    if(mode==="manual")setForecastModel(segKey,`trailing${manualDaysOf(getForecastModelOverride(segKey))}`);
    else setForecastModel(segKey,mode);
  };
  const setForecastModelManualDays=(segKey,days)=>{
    const n=Math.max(1,Math.min(365,parseInt(days,10)||DEFAULT_MANUAL_TRAILING_DAYS));
    setForecastModel(segKey,`trailing${n}`);
  };
  // Same mode/manual-days split as the row picker above, but for the workspace-wide default —
  // there's no "inherit" state here (this IS the fallback everything else inherits), so the
  // segmented control just has the 3 real modes.
  const setDefaultForecastModelMode=mode=>{
    if(!canEdit)return;
    if(mode==="manual")setDefaultForecastModel?.(`trailing${manualDaysOf(defaultForecastModel)}`);
    else setDefaultForecastModel?.(mode);
  };
  const setDefaultForecastModelManualDays=days=>{
    if(!canEdit)return;
    const n=Math.max(1,Math.min(365,parseInt(days,10)||DEFAULT_MANUAL_TRAILING_DAYS));
    setDefaultForecastModel?.(`trailing${n}`);
  };
  const bulkDeleteSegments=()=>{
    if(!canEdit)return;
    if(!selRows.size)return;
    const n=selRows.size;
    const totalMatches=[...selRows].reduce((s,k)=>s+countSegmentCampaigns(campaignTags,budgetDims,k,platformIndex),0);
    const tagNote=totalMatches>0?` This also un-tags ${totalMatches} matching campaign${totalMatches>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete ${n} segment${n>1?"s":""}?\n\nThis removes all monthly budget values for ${n>1?"these segments":"this segment"} in ${year}.${tagNote}`))return;
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(nx[year])selRows.forEach(k=>{delete nx[year][k];});return nx;});
    setBudgetRowMeta?.(p=>{const nx={...p};selRows.forEach(k=>delete nx[k]);return nx;});
    setTags?.(p=>{let nt=p;selRows.forEach(k=>{nt=untagSegmentCampaigns(nt,budgetDims,k,platformIndex);});return nt;});
    showNotif(`Deleted ${n} segment${n>1?"s":""}${totalMatches>0?` — un-tagged ${totalMatches} campaign${totalMatches>1?"s":""}`:""}`);
    setSelRows(new Set());
  };

  const periodLabel=periodType==="monthly"?`${MONTHS.find(m=>m.key===month)?.label} ${year}`:periodType==="quarterly"?`${quarter} ${year}`:`FY ${year}`;
  const overallPct=pacing.totals.budget>0?pacing.totals.spend/pacing.totals.budget:null;
  // Venture grey header (2026-08-07, per Mo — same treatment as the Budget Panel table): light-grey
  // fill + top/bottom hairlines instead of a flat white header.
  const TH={fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text,padding:"11px 8px",borderTop:`1px solid ${T.border}`,borderBottom:`1px solid ${T.border}`,background:T.surfaceHover,whiteSpace:"nowrap",textAlign:"center"};

  // Only block entirely when there's truly nothing to show — no budget structure AND no spend
  // synced yet. If spend exists but budgets don't, fall through to the full view below (defaulted
  // to "custom" mode above) so spend-by-Platform/tag is still visible — that's useful on its own,
  // independent of whether budgets have been set up.
  if(!budgetDims.length&&!mergedNormRows.length){
    return(
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40,background:T.bg}}>
        <div style={{fontSize:17*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:6}}>No data yet</div>
        <div style={{fontSize:13*(T.fsScale||1),color:T.textSub,maxWidth:340,lineHeight:1.65,marginBottom:20}}>Import spend data and set up budget segments to see pacing and spend breakdowns here.</div>
        <Btn onClick={()=>onNavigate?.("tagger")} variant="success" T={T} size="md">Go to Campaign Tagger →</Btn>
      </div>
    );
  }

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100%",background:T.bg,overflow:"auto"}}>
      {/* Controls + summary now render via portal into the app-shell's stats sidebar */}
      {sidebarEl&&createPortal(
        <div className="flex flex-col gap-0">
          {/* Sidebar rebuilt on Venture Tailwind primitives (2026-08-07, per Mo — same treatment as
              the Budget Panel: lighter uppercase labels, pill toggles, full-bleed dividers). The
              aside carries no horizontal padding for this view (see PaidHQ.jsx), so each section
              carries its own px-3.5 and the border-t dividers span the full column width. */}
          <div className="px-3.5 pb-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Period</div>
            <div className="mb-2 flex gap-1">
              {[["monthly","Month"],["quarterly","Quarter"],["annual","Year"]].map(([k,l])=>(
                <button key={k} onClick={()=>changePeriodType(k)}
                  className={cn("flex-1 rounded-sm border py-1.5 text-xs font-medium transition-colors",
                    periodType===k?"border-foreground bg-secondary text-foreground":"border-border text-muted-foreground hover:bg-secondary/60")}>
                  {l}
                </button>
              ))}
            </div>
            <div className="mb-2 flex gap-1">
              {years.map(y=>(
                <button key={y} onClick={()=>changeYear(y)}
                  className={cn("flex-1 rounded-sm border py-1.5 text-xs font-medium transition-colors",
                    year===y?"border-foreground bg-secondary text-foreground":"border-border text-muted-foreground hover:bg-secondary/60")}>
                  {y}
                </button>
              ))}
            </div>
            {periodType==="monthly"&&(
              <Select value={month} onValueChange={changeMonth}>
                <SelectTrigger className="mb-2 h-9 text-sm"><SelectValue/></SelectTrigger>
                <SelectContent>{MONTHS.map(m=><SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}</SelectContent>
              </Select>
            )}
            {periodType==="quarterly"&&(
              <Select value={quarter} onValueChange={changeQuarter}>
                <SelectTrigger className="mb-2 h-9 text-sm"><SelectValue/></SelectTrigger>
                <SelectContent>{QUARTERS.map(q=><SelectItem key={q.key} value={q.key}>{q.key}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <div className="text-xs leading-relaxed text-muted-foreground">
              {periodLabel} · {pacing.elapsedDays} of {pacing.totalDays} days elapsed{pacing.daysRemaining>0?` · ${pacing.daysRemaining} remaining`:""}
            </div>
          </div>
          <div className="border-t border-border px-3.5 py-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Summary</div>
            {/* Leading icons (2026-08-07, per Mo) — muted-grey, each metaphor distinct: Wallet
                (budget) vs Coins (spend going out); Gauge (actual pace) vs Clock (expected/time);
                Stack (segments); Target (goal) vs CheckCircle (actual). Kept monochrome so color
                stays reserved for the pacing-status value. */}
            {[
              {label:"Total Budget",value:fmtFull(pacing.totals.budget),icon:Wallet},
              {label:"Spend to Date",value:fmtFull(pacing.totals.spend),icon:Coins},
              // Overall Pacing rendered as a Venture semantic-token bubble (per Mo) — warning when
              // ahead of expected pace, info (blue) when behind, success when on pace.
              {label:"Overall Pacing",value:overallPct!=null?`${Math.round(overallPct*100)}%`:"—",badge:overallPct==null?"":(overallPct-pacing.expectedPct>0.1?"bg-warning-bg text-warning":overallPct-pacing.expectedPct<-0.1?"bg-info-bg text-info":"bg-success-bg text-success"),icon:Gauge},
              {label:"Expected Pace",value:`${Math.round(pacing.expectedPct*100)}%`,icon:Clock},
              {label:"Segments",value:pacing.segments.length.toString(),icon:Stack},
              // MQL Goal/Actual (2026-08-06, per Mo) — only shown once there's actually MQL data
              // imported (goals and/or pipeline actuals) for THIS period.
              ...(periodMqlTrend.goalTotal>0||periodMqlTrend.actualTotal>0?[
                {label:"MQL Goal",value:fmtCount(periodMqlTrend.goalTotal),icon:Target},
                {label:"MQL Actual",value:fmtCount(periodMqlTrend.actualTotal),icon:CheckCircle},
              ]:[]),
            ].map(s=>(
              <div key={s.label} className="flex items-center justify-between py-1.5 text-xs">
                <span className="flex items-center gap-2 text-muted-foreground"><s.icon size={14}/> {s.label}</span>
                {s.badge?(
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium",s.badge)}>{s.value}</span>
                ):(
                  <span className="font-medium text-foreground">{s.value}</span>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-border px-3.5 py-4">
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Data freshness</div>
            <div className="mb-2 text-[10px] leading-relaxed text-muted-foreground">Date range each platform actually has spend data for — projections use each platform's own last date instead of assuming everyone's current through today.</div>
            {(()=>{
              // Collapse all Google sub-channels (Search/Display/Demand Gen/PMax/YouTube) into a
              // single "Google" freshness line (2026-08-07, per Mo) — take the most recent date and
              // the widest range across them. The forecasting engine still tracks each sub-channel
              // separately (see groupGooglePlatform's doc comment); this only groups the display.
              const gset=new Set(GOOGLE_SUBCHANNELS);
              const merged={}; // label -> {date, min, max}
              Object.entries(pacing.platformFreshness||{}).forEach(([platform,date])=>{
                const label=gset.has(platform)?"Google":platform;
                const range=platformDateRange[platform];
                const cur=merged[label]||(merged[label]={date:0,min:null,max:null});
                if(date>cur.date)cur.date=date;
                if(range){
                  if(cur.min==null||range.min<cur.min)cur.min=range.min;
                  if(cur.max==null||range.max>cur.max)cur.max=range.max;
                }
              });
              const fmtShort=d=>d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
              return Object.entries(merged).sort(([,a],[,b])=>b.date-a.date).map(([platform,info])=>{
                const daysStale=Math.floor((now-info.date)/86400000);
                // Venture semantic-token bubbles (2026-08-07, per Mo — "colored bubbles with text
                // darker than the bubble, all on theme"): light tint background + darker foreground
                // from the same hue. success (green) ≤1d, info (blue) ≤3d, warning (orange) ≤6d,
                // destructive (red) older.
                const badge=daysStale<=1?"bg-success-bg text-success":daysStale<=3?"bg-info-bg text-info":daysStale<=6?"bg-warning-bg text-warning":"bg-destructive-bg text-destructive";
                const label=daysStale<=0?"Today":daysStale===1?"Yesterday":`${daysStale} days ago`;
                return(
                  <div key={platform} className="flex flex-col gap-0.5 py-1">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate text-foreground">{platform}</span>
                      <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium",badge)}>{label}</span>
                    </div>
                    {info.min&&info.max&&<div className="whitespace-nowrap text-[10px] text-muted-foreground">{fmtShort(info.min)} – {fmtShort(info.max)}</div>}
                  </div>
                );
              });
            })()}
            {Object.keys(pacing.platformFreshness||{}).length===0&&<div className="text-[11px] text-muted-foreground">No spend data yet</div>}
          </div>
        </div>,
        sidebarEl
      )}

      {/* Segment table */}
      {/* Horizontal padding moved off this outer container (2026-08-01, per Mo — row borders should
          reach edge-to-edge like the Campaign Tagger and Budget Panel tables, which use the same
          zero-container-padding + per-row/per-cell inset pattern instead of a padded wrapper that
          stops every row's border short of the card edges). The toolbars/banners above each table
          are wrapped in their own "0 24px" padded div (or carry that padding directly), while each
          table itself spans the full unpadded width so tr borders reach true left/right edges —
          the tables' own first/last header and data cells carry a matching 24px inset instead, so
          content still lines up visually with the toolbars above. */}
      <div style={{flex:1,overflow:"auto",padding:"20px 0 24px"}}>
        <div style={{padding:"0 24px"}}>
        <AISummaryCard T={T} session={session} mergedNormRows={mergedNormRows} tags={campaignTags} budgetDims={budgetDims} budgets={budgets} budgetRowMeta={budgetRowMeta} defaultForecastModel={defaultForecastModel} combineGoogleChannels={combineGoogleChannels} mode="pacing"
          view={{
            viewMode,
            periodLabel,
            dims:activeDims,
            segments:viewMode==="custom"?filteredCustomSegments:filteredSegments,
            totals:viewMode==="custom"?(customPacing?.totals||{spend:0}):pacing.totals,
            expectedPct:viewMode==="custom"?(customPacing?.expectedPct||0):pacing.expectedPct,
            daysRemaining:viewMode==="custom"?(customPacing?.daysRemaining||0):pacing.daysRemaining,
            statusFilter,
            segFilters,
            numericFilters,
            trend:viewMode==="trend"?trendData:null,
            trendFilterDim,trendFilterValue,trendSeriesDim,
          }}/>
        {!budgetDims.length&&(
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:T.r8,marginBottom:14,fontSize:12*(T.fsScale||1),color:T.text,fontFamily:T.font}}>
            No budget structure set up yet — showing spend by dimension only.{" "}
            <span onClick={()=>onNavigate?.("budget")} style={{color:T.accentText,fontWeight:600,cursor:"pointer"}}>Set up budgets →</span>
          </div>
        )}
        {/* View by — Budget Segments (the only grouping with $ budgets) vs Custom (any dimension
            combo, spend-only). Shown regardless of whether budget segments exist, since switching
            away to Custom is exactly what you'd want to do if they don't. */}
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:14}}>
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">View by:</span>
          <div className="flex gap-1">
            {[["budget","Budget Segments"],["custom","Custom"],["trend","Trend"]].map(([k,l])=>(
              <button key={k} onClick={()=>changeViewMode(k)}
                className={cn("rounded-sm border px-3 py-1.5 text-xs font-medium transition-colors",
                  viewMode===k?"border-foreground bg-secondary text-foreground":"border-border text-muted-foreground hover:bg-secondary/60")}>{l}</button>
            ))}
          </div>
          {viewMode==="custom"&&(
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-muted-foreground">Group by:</span>
              {allDimOptions.map(d=>{
                const active=customDims.includes(d);
                return(
                  <button key={d} onClick={()=>toggleCustomDim(d)}
                    className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                      active?"border-foreground bg-secondary text-foreground":"border-border text-muted-foreground hover:bg-secondary/60")}>{d}</button>
                );
              })}
            </div>
          )}
          {viewMode==="trend"&&(
            <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>From</span>
                <input type="month" value={trendStartMonth} onChange={e=>setTrendStartMonth(e.target.value)}
                  style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 8px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>to</span>
                <input type="month" value={trendEndMonth} onChange={e=>setTrendEndMonth(e.target.value)}
                  style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 8px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
              </div>
              <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>By</span>
                <Sel value={trendGrain} onChange={setTrendGrain} T={T} style={{width:96}}>
                  <option value="day">Day</option>
                  <option value="week">Week</option>
                  <option value="month">Month</option>
                  <option value="quarter">Quarter</option>
                  <option value="year">Year</option>
                </Sel>
              </div>
              <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>Filter by</span>
                <Sel value={trendFilterDim} onChange={v=>{setTrendFilterDim(v);setTrendFilterValue("");}} T={T} style={{width:130}}>
                  <option value="">No filter</option>
                  {trendFilterOptions.map(d=><option key={d} value={d}>{d}</option>)}
                </Sel>
                {trendFilterDim&&(
                  <input value={trendFilterValue} onChange={e=>setTrendFilterValue(e.target.value)} placeholder={`${trendFilterDim} contains…`}
                    style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 8px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,width:150}}/>
                )}
              </div>
              <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>Split by</span>
                <Sel value={trendSeriesDim} onChange={setTrendSeriesDim} T={T} style={{width:130}}>
                  <option value="">Don't split</option>
                  {trendSeriesOptions.map(d=><option key={d} value={d}>{d}</option>)}
                </Sel>
              </div>
              {renderAskAboutViewBtn()}
            </div>
          )}
        </div>
        {/* Saved Views + AI-driven views (item 42). "Views" lists/applies/deletes saved
            configurations; "Ask AI to build a view" turns a plain-English request into a
            configuration via askAIBuildView, applies it immediately, then opens the same Save
            View modal pre-filled with the AI's suggested name so it's one click to keep. */}
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:14}}>
          <div style={{position:"relative"}}>
            <Btn onClick={()=>setSavedViewsMenuOpen(p=>!p)} variant="ghost" size="sm" T={T}>
              <span style={{display:"inline-flex",alignItems:"center",gap:5}}><Icon name="save" size={12} color={T.textSub}/> Views{savedViews?.length?` (${savedViews.length})`:""} <Icon name="chevronDown" size={11} color={T.textMuted}/></span>
            </Btn>
            {savedViewsMenuOpen&&(
              <>
                <div onClick={()=>setSavedViewsMenuOpen(false)} style={{position:"fixed",inset:0,zIndex:99}}/>
                <div style={{position:"absolute",top:"calc(100% + 6px)",left:0,zIndex:100,minWidth:240,maxHeight:320,overflow:"auto",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd,padding:6}}>
                  {!savedViews?.length&&<div style={{padding:"10px 8px",fontSize:12*(T.fsScale||1),color:T.textMuted}}>No saved views yet.</div>}
                  {(savedViews||[]).map(v=>(
                    <div key={v.id} style={{display:"flex",alignItems:"center",gap:2}}>
                      <button onClick={()=>applySavedView(v)} className="bhq-row" style={{flex:1,display:"block",textAlign:"left",padding:"7px 8px",borderRadius:T.r6,background:"transparent",border:"none",color:T.text,fontSize:12*(T.fsScale||1),cursor:"pointer",fontFamily:T.font,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.name}</button>
                      <button onClick={()=>deleteSavedView(v.id,v.name)} title="Delete saved view" style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"none",borderRadius:T.r5,color:T.textMuted,cursor:"pointer",fontSize:13*(T.fsScale||1),flexShrink:0,fontFamily:T.font}}>✕</button>
                    </div>
                  ))}
                  <div style={{height:1,background:T.border,margin:"4px 2px"}}/>
                  <button onClick={()=>{setSavedViewsMenuOpen(false);openSaveViewModal();}} className="bhq-row" style={{display:"flex",alignItems:"center",gap:6,width:"100%",textAlign:"left",padding:"7px 8px",borderRadius:T.r6,background:"transparent",border:"none",color:T.accentText,fontSize:12*(T.fsScale||1),fontWeight:600,cursor:"pointer",fontFamily:T.font}}><Icon name="plus" size={12} color={T.accentText}/> Save current view</button>
                </div>
              </>
            )}
          </div>
          {/* Export (2026-08-01, per Mo). Hidden on Trend — that view is a chart, not a table, so
              there's nothing here to export; switch to Budget Segments or Custom first. */}
          {viewMode!=="trend"&&(
            <div style={{position:"relative"}}>
              <Btn onClick={()=>setExportMenuOpen(p=>!p)} variant="ghost" size="sm" T={T}>
                <span style={{display:"inline-flex",alignItems:"center",gap:5}}><Icon name="download" size={12} color={T.textSub}/> Export <Icon name="chevronDown" size={11} color={T.textMuted}/></span>
              </Btn>
              {exportMenuOpen&&(
                <>
                  <div onClick={()=>setExportMenuOpen(false)} style={{position:"fixed",inset:0,zIndex:99}}/>
                  <div style={{position:"absolute",top:"calc(100% + 6px)",left:0,zIndex:100,minWidth:200,background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd,padding:6,display:"flex",flexDirection:"column"}}>
                    <div style={{padding:"5px 10px 5px",fontSize:10*(T.fsScale||1),fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:T.textMuted}}>Export {periodLabel}</div>
                    <div style={{display:"flex",gap:4,padding:"0 6px 6px"}}>
                      {EXPORT_FORMATS.map(f=>(
                        <button key={f.key} className="bhq-row" onClick={()=>handleExportDownload(f.key)}
                          style={{flex:1,padding:"6px 0",borderRadius:T.r6,border:`1px solid ${T.border}`,background:"transparent",color:T.textSub,fontSize:11*(T.fsScale||1),fontWeight:600,cursor:"pointer",fontFamily:T.font}}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                    <button className="bhq-row" disabled={sheetsExporting} onClick={handleExportToGoogleSheets}
                      style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:T.r6,background:"transparent",border:"none",color:T.text,fontSize:13*(T.fsScale||1),cursor:sheetsExporting?"default":"pointer",opacity:sheetsExporting?0.6:1,fontFamily:T.font,textAlign:"left"}}>
                      <Icon name="export" size={14} color={T.textSub}/> {sheetsExporting?"Exporting to Google Sheets…":"Export to Google Sheets"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <Btn onClick={()=>setAiViewOpen(p=>!p)} variant="ghost" size="sm" T={T}>✨ Ask AI to build a view</Btn>
          {aiViewOpen&&(
            <div style={{display:"flex",gap:6,alignItems:"center",flex:"1 1 320px",minWidth:260}}>
              <input autoFocus value={aiViewQuestion} onChange={e=>setAiViewQuestion(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter"&&!aiViewLoading)runAiView();}}
                placeholder={`e.g. "segments behind pace on Meta this quarter"`}
                style={{flex:1,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 10px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
              <Btn onClick={runAiView} disabled={aiViewLoading||!aiViewQuestion.trim()} variant="primary" size="sm" T={T}>{aiViewLoading?"Thinking…":"Go"}</Btn>
            </div>
          )}
          {aiViewError&&<span style={{fontSize:11*(T.fsScale||1),color:T.danger}}>{aiViewError}</span>}
        </div>
        {savedViewModalOpen&&(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:210,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setSavedViewModalOpen(false)}>
            <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:380,background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r10,padding:20,boxShadow:T.shadowMd}}>
              <div style={{fontSize:14*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:4}}>Save this view</div>
              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:12}}>Saves the current View-by setup — mode, filters, and breakdown — for one-click recall later. Always reflects whatever period you're viewing when you reopen it.</div>
              <input autoFocus value={savedViewNameDraft} onChange={e=>setSavedViewNameDraft(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter")saveCurrentView();if(e.key==="Escape")setSavedViewModalOpen(false);}}
                placeholder="e.g. Meta segments behind pace"
                style={{width:"100%",boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"8px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font,marginBottom:14}}/>
              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                <Btn onClick={()=>setSavedViewModalOpen(false)} variant="ghost" size="sm" T={T}>Cancel</Btn>
                <Btn onClick={saveCurrentView} disabled={!savedViewNameDraft.trim()} variant="primary" size="sm" T={T}>Save view</Btn>
              </div>
            </div>
          </div>
        )}
        </div>
        {viewMode==="budget"&&(pacing.segments.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:60,textAlign:"center"}}>
            <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:6}}>No budget or spend data for {periodLabel}</div>
            <div style={{fontSize:13*(T.fsScale||1),color:T.textSub}}>Set a budget or import spend data for this period.</div>
          </div>
        ):(
          <>
          {/* Filter bar */}
          <div style={{padding:"8px 24px",borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>Filter:</span>
            {budgetDims.map(d=>(
              <input key={d} value={segFilters[d]||""} onChange={e=>setSegFilters(p=>({...p,[d]:e.target.value}))} placeholder={d}
                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 8px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,width:120}}/>
            ))}
            <Sel value={statusFilter} onChange={setStatusFilter} T={T} style={{width:150}}>
              <option value="all">All statuses</option>
              <option value="on-track">On track</option>
              <option value="ahead">Ahead of pace</option>
              <option value="behind">Behind pace</option>
              <option value="over">Over budget</option>
              <option value="committed">Committed spend</option>
              <option value="no-budget">No budget set</option>
            </Sel>
            <NumericFilterChips numericFilters={numericFilters} setNumericFilters={setNumericFilters} mode="budget" T={T}/>
            {hasSegFilters&&<Btn onClick={clearSegFilters} variant="ghost" size="sm" T={T}>Clear filters</Btn>}
            <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
            {/* Global forecast model (item 45, 2026-07-25; redesigned same day from a 7-option
                <select> into this Auto/Manual/Committed segmented control — per Mo: "there should
                be a global forecasting model selector instead of just individual rows. the
                individual row selector should override the global," followed by "we have too many
                [models] and I don't understand them ... the point is accurate forecasting, not
                overly complex options.") Sets defaultForecastModel, the workspace-wide fallback
                computePacing uses for every segment that doesn't have its own explicit per-row
                override (see getForecastModelOverride/getEffectiveForecastModel above and each
                row's picker, which defaults to "Use global default"). Budget-mode only — Custom/
                Trend views group ad-hoc, not by budget segment, so there's no per-row model to
                default for. */}
            <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>Default forecast model:</span>
            <div style={{display:"flex",alignItems:"center",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,padding:2,gap:2}}>
              {[{mode:"auto",label:"Auto"},{mode:"manual",label:"Manual"},{mode:"committed",label:"Committed"}].map(o=>{
                const active=forecastModeOf(defaultForecastModel)===o.mode;
                return(
                  <button key={o.mode} onClick={()=>setDefaultForecastModelMode(o.mode)} disabled={!canEdit}
                    title={FORECAST_MODELS.find(fm=>fm.value===o.mode)?.hint||(o.mode==="manual"?"Projects from a trailing window of a specific number of days you choose.":"")}
                    style={{border:"none",borderRadius:T.r4,padding:"5px 10px",fontSize:12*(T.fsScale||1),fontFamily:T.font,cursor:canEdit?"pointer":"default",background:active?T.surfaceHover:"transparent",color:active?T.text:T.textSub,fontWeight:active?600:500,transition:"all 0.1s"}}>
                    {o.label}
                  </button>
                );
              })}
            </div>
            {forecastModeOf(defaultForecastModel)==="manual"&&(
              <span style={{display:"flex",alignItems:"center",gap:4,fontSize:11*(T.fsScale||1),color:T.textSub}}>
                trailing
                <input type="number" min={1} max={365} value={manualDaysOf(defaultForecastModel)} disabled={!canEdit}
                  onChange={e=>setDefaultForecastModelManualDays(e.target.value)}
                  style={{width:48,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 6px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                days
              </span>
            )}
            <InfoTip T={T} text={FORECAST_EXPLANATION} width={360}/>
            <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
            <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>Break down by:</span>
            <Sel value={breakdownDim} onChange={v=>{setBreakdownDim(v);setExpandedRows(new Set());}} T={T} style={{width:150}}>
              <option value="">None</option>
              {breakdownOptions.map(d=><option key={d} value={d}>{d}</option>)}
            </Sel>
            {renderAskAboutViewBtn({marginLeft:"auto"})}
            <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>{filteredSegments.length} of {pacing.segments.length} segments</span>
          </div>
          {/* Bulk action bar */}
          {selRows.size>0&&(
            <div style={{padding:"8px 24px",borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <Pill color={T.text} bg={T.accent} border={T.text}>{selRows.size} selected</Pill>
              <Btn onClick={()=>setSelRows(new Set())} variant="ghost" size="sm" T={T}>Clear</Btn>
              <Btn onClick={bulkDeleteSegments} variant="danger" size="sm" T={T}>✕ Delete {selRows.size}</Btn>
            </div>
          )}
          <table style={{borderCollapse:"collapse",minWidth:"100%",fontSize:13*(T.fsScale||1),background:T.surface}}>
            <thead><tr>
              <th style={{...TH,width:20,paddingLeft:24}}/>
              <th style={{...TH,width:32}}>
                <input type="checkbox" checked={filteredSegments.length>0&&selRows.size===filteredSegments.length} onChange={selAllRows} title="Select all rows — reveals bulk delete once selected" style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
              </th>
              {budgetDims.map(d=><th key={d} style={{...TH,...(d==="Product"?{maxWidth:110}:d==="Module"?{maxWidth:140}:{})}}>{d}</th>)}
              <th style={TH}>Budget</th>
              <th style={TH}>Spend PTD</th>
              <th style={TH}>Pacing</th>
              <th style={TH}>Expected</th>
              <th style={TH}>Daily Burn</th>
              <th style={TH}>Projected</th>
              <th style={{...TH,minWidth:200}}>Status</th>
              <th style={{...TH,paddingRight:24}}/>
            </tr></thead>
            <tbody>
              {filteredSegments.length===0&&(
                <tr><td colSpan={4+budgetDims.length+6} style={{padding:"32px 24px",textAlign:"center",color:T.textMuted,fontSize:13*(T.fsScale||1)}}>No segments match your filters. <span onClick={clearSegFilters} style={{color:T.accent,cursor:"pointer",fontWeight:400}}>Clear filters</span></td></tr>
              )}
              {filteredSegments.flatMap((seg)=>{
                const meta=pacingStatusMeta(seg.status,T);
                const isSel=selRows.has(seg.segKey);
                const label=budgetDims.map((d,i)=>seg.dims[i]).join(" · ");
                const isExpanded=breakdownDim&&expandedRows.has(seg.segKey);
                const rowBg=isSel?T.rowSelected:T.surface;
                const rbb=`1px solid ${T.border}`;
                const parentRow=(
                  <tr key={seg.segKey} className={isSel?undefined:"bhq-tr"} style={{background:rowBg}}>
                    <td style={{padding:"8px 4px",borderBottom:rbb,textAlign:"center",paddingLeft:24}}>
                      {breakdownDim&&<button onClick={()=>toggleExpand(seg.segKey)} title={`Break down by ${breakdownDim}`}
                        style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11*(T.fsScale||1),padding:2,lineHeight:1,transform:isExpanded?"rotate(90deg)":"none",transition:"transform 0.12s"}}>▸</button>}
                    </td>
                    <td style={{padding:"8px 8px",borderBottom:rbb}}>
                      <input type="checkbox" checked={isSel} onChange={()=>toggleRowSel(seg.segKey)} title="Select row — reveals bulk delete once selected" style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
                    </td>
                    {seg.dims.map((v,i)=>{const dimMaxW=budgetDims[i]==="Product"?110:budgetDims[i]==="Module"?140:undefined;return(
                    <td key={i} style={{padding:"8px 14px",borderBottom:rbb,whiteSpace:"nowrap",...(dimMaxW?{maxWidth:dimMaxW,overflow:"hidden",textOverflow:"ellipsis"}:{})}}>
                      {DERIVED_DIMS.includes(budgetDims[i])?(
                        // Derived, not stored — see the same guard in the Budget Panel's table.
                        <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,borderRadius:T.r6}} title="Derived from spend data — not editable">{v}</Pill>
                      ):editingSegVal?.segKey===seg.segKey&&editingSegVal?.dim===budgetDims[i]?(
                        <input autoFocus value={editSegVal} onChange={e=>setEditSegVal(e.target.value)}
                          onBlur={saveSegEdit} onKeyDown={e=>{if(e.key==="Enter")saveSegEdit();if(e.key==="Escape"){setEditingSegVal(null);setEditSegVal("");}}}
                          style={{background:T.inputBg,border:`1px solid ${T.accentBorder}`,borderRadius:T.r6,color:T.text,padding:"3px 8px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font,minWidth:80}}/>
                      ):(
                        <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,cursor:"text",borderRadius:T.r6}}
                          onClick={()=>{setEditingSegVal({segKey:seg.segKey,dim:budgetDims[i]});setEditSegVal(v);}}>{v}</Pill>
                      )}
                      {i===seg.dims.length-1&&seg.budget>0&&seg.matchCount===0&&(
                        <WarnTip T={T} text="No tagged campaigns match this segment. Spend will always show as $0 here, regardless of period, until a campaign is tagged with this exact combination in the Tagger."/>
                      )}
                    </td>);})}
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,color:T.text}}>{seg.budget>0?fmtFull(seg.budget):"—"}</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,color:T.text}}>{fmtFull(seg.spend)}</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right"}}>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",gap:8}}>
                        <span style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text}}>{seg.actualPct!=null?`${Math.round(seg.actualPct*100)}%`:"—"}</span>
                        <PacingBar actualPct={seg.actualPct} expectedPct={pacing.expectedPct} status={seg.status} T={T}/>
                      </div>
                    </td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,color:T.textMuted}}>{Math.round(pacing.expectedPct*100)}%</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,color:T.text}}>{fmtFull(seg.dailyRate)}/day</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right"}}>
                      <div style={{fontFamily:T.font,color:T.text,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                        {seg.projected!=null?fmtFull(seg.projected):"—"}
                        {seg.projected!=null&&seg.budget>0&&<span style={{color:T.textMuted,marginLeft:6,fontSize:13*(T.fsScale||1)}}>({Math.round((seg.projected/seg.budget)*100)}%)</span>}
                        {seg.lowConfidencePlatforms?.length>0&&(
                          <WarnTip T={T} text={`Projection may be unreliable — ${seg.lowConfidencePlatforms.join(", ")} only has a single as-of data point for this period, so its spend is being extrapolated across every day instead of an actual daily rate. Check that platform's Date/"Data accurate through" mapping.`}/>
                        )}
                      </div>
                      {seg.projectedVariance!=null&&<div style={{fontSize:13*(T.fsScale||1),color:seg.projectedVariance>0?T.danger:T.success,fontFamily:T.font}}>{fmtSigned(seg.projectedVariance)}</div>}
                    </td>
                    <td style={{padding:"8px 14px",borderBottom:rbb,minWidth:200}}>
                      <span className={cn("inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",statusBubbleClass(seg.status))}>{meta.label}</span>
                      {/* Capacity-vs-budget signal (item 45) — see detectCapacitySignal's doc
                          comment. Only ever shown for the "constrained" case; "growing" and null
                          are both non-findings, not worth a badge. */}
                      {seg.capacitySignal==="constrained"&&(
                        <WarnTip T={T} color={T.accent} text={`Impressions have been flat for about ${CAPACITY_WINDOW*2} days despite budget headroom — more budget alone probably won't fix this. Likely capped by audience size, frequency cap, or the platform's own bid/approval limits, not by dollars.`}/>
                      )}
                      {/* Forecast model (item 45, redesigned 2026-07-25 into Auto/Manual/Committed
                          — see the global control's comment above) — lives here, not the Budget
                          Panel, since it's a pacing/projection choice, not a budget-setup one.
                          Affects Daily Burn/Projected/Status above via computePacing reading
                          budgetRowMeta. Defaults to inheriting the tab's global model (set above
                          the table) — picking anything else here is an explicit per-row override,
                          highlighted so it's obvious which rows deviate from the workspace default.
                          Manual shows a second, narrower trailing-days input right below the select
                          — kept as two stacked controls rather than crammed onto one line. Container
                          widened to 168px (2026-07-28, per Mo — the old 118px cap clipped the native
                          dropdown arrow off the right edge of the "Use global (Auto)" option since
                          the text alone almost filled the box) and the select truncates with an
                          ellipsis + full text in its title tooltip if a label is still too long. */}
                      <div style={{marginTop:4,display:"flex",flexDirection:"column",gap:2,maxWidth:168}}>
                        <select value={forecastModeOf(getForecastModelOverride(seg.segKey))} onChange={e=>setForecastModelMode(seg.segKey,e.target.value)} disabled={!canEdit}
                          title={`Forecast model — how this segment's spend is projected across the period. Currently: ${forecastModelLabel(getEffectiveForecastModel(seg.segKey))}${getForecastModelOverride(seg.segKey)?" (row override)":" (inherited from global default)"}`}
                          style={{display:"block",width:"100%",boxSizing:"border-box",fontSize:13*(T.fsScale||1),color:getForecastModelOverride(seg.segKey)?T.text:T.textMuted,background:getForecastModelOverride(seg.segKey)?T.surfaceHover:"transparent",border:`1px solid ${getForecastModelOverride(seg.segKey)?T.borderStrong:T.border}`,borderRadius:T.r5,padding:"2px 4px",cursor:canEdit?"pointer":"default",fontFamily:T.font,outline:"none",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          <option value={FORECAST_MODEL_INHERIT}>Use global ({forecastModelLabel(defaultForecastModel)})</option>
                          <option value="auto">Auto</option>
                          <option value="committed">Committed</option>
                          <option value="manual">Manual</option>
                        </select>
                        {forecastModeOf(getForecastModelOverride(seg.segKey))==="manual"&&(
                          <input type="number" min={1} max={365} value={manualDaysOf(getForecastModelOverride(seg.segKey))} disabled={!canEdit}
                            onChange={e=>setForecastModelManualDays(seg.segKey,e.target.value)} title="Trailing window, in days"
                            style={{width:52,fontSize:13*(T.fsScale||1),color:T.text,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r5,padding:"1px 3px",fontFamily:T.font,outline:"none"}}/>
                        )}
                      </div>
                    </td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,paddingRight:24}}>
                      <button onClick={()=>deleteSegment(seg.segKey,label)} title="Delete segment"
                        style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:T.r5,color:T.textMuted,cursor:"pointer",fontSize:12*(T.fsScale||1),lineHeight:1,padding:0,opacity:0.4,transition:"all 0.1s"}}
                        onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.border=`1px solid ${T.danger}`;e.currentTarget.style.color=T.danger;}}
                        onMouseLeave={e=>{e.currentTarget.style.opacity=0.4;e.currentTarget.style.border="1px solid transparent";e.currentTarget.style.color=T.textMuted;}}>✕</button>
                    </td>
                  </tr>
                );
                if(!isExpanded)return[parentRow];
                const breakdown=computeSpendBreakdown({mergedNormRows,tags:campaignTags,budgetDims,segKey:seg.segKey,breakdownDim,start:pacing.start,end:pacing.end,today:now,forecastModel:seg.forecastModel,combineGoogleChannels});
                const breakdownRows=breakdown.length===0?[
                  <tr key={seg.segKey+"-empty"} style={{background:rowBg}}>
                    <td/><td/>
                    <td colSpan={budgetDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:13*(T.fsScale||1),color:T.textMuted,fontStyle:"italic"}}>No spend in this period to break down by {breakdownDim}</td>
                    <td colSpan={8} style={{borderBottom:rbb}}/>
                  </tr>
                ]:breakdown.map(b=>(
                  <tr key={seg.segKey+"-"+b.value} style={{background:rowBg}}>
                    <td/><td/>
                    <td colSpan={budgetDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:13*(T.fsScale||1),color:T.textSub}}>↳ {b.value}</td>
                    <td style={{borderBottom:rbb}}/>
                    <td style={{padding:"6px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1)}}>
                      {fmtFull(b.spend)}<span style={{color:T.textMuted,marginLeft:6,fontSize:13*(T.fsScale||1)}}>({Math.round(b.pct*100)}%)</span>
                    </td>
                    <td colSpan={2} style={{borderBottom:rbb}}/>
                    <td style={{padding:"6px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),color:T.textMuted}}>{fmtFull(b.dailyRate)}/day</td>
                    <td style={{padding:"6px 8px",borderBottom:rbb,textAlign:"right"}}>
                      <div style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),color:T.textMuted,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                        {b.projected!=null?fmtFull(b.projected):"—"}
                        {b.lowConfidencePlatforms?.length>0&&(
                          <WarnTip T={T} text={`Projection may be unreliable — ${b.lowConfidencePlatforms.join(", ")} only has a single as-of data point for this period, so its spend is being extrapolated across every day instead of an actual daily rate.`}/>
                        )}
                      </div>
                    </td>
                    <td colSpan={2} style={{borderBottom:rbb}}/>
                  </tr>
                ));
                return[parentRow,...breakdownRows];
              })}
              {filteredSegments.length>0&&(()=>{
                // Totals across whatever's currently filtered/visible, not the whole dataset —
                // matches the Budget Panel's own totals-row behavior (sums filteredSegs, not segs)
                // so a filtered view here answers "how much across just what I'm looking at."
                const ft=filteredSegments.reduce((acc,s)=>({
                  budget:acc.budget+s.budget,
                  spend:acc.spend+s.spend,
                  dailyRate:acc.dailyRate+s.dailyRate,
                  projected:acc.projected+(s.projected||0),
                  hasProjected:acc.hasProjected||s.projected!=null,
                }),{budget:0,spend:0,dailyRate:0,projected:0,hasProjected:false});
                const ftActualPct=ft.budget>0?ft.spend/ft.budget:null;
                const ftVariance=ft.budget>0&&ft.hasProjected?ft.projected-ft.budget:null;
                return(
                  <tr style={{borderTop:`2px solid ${T.border}`,background:T.surface}}>
                    <td style={{padding:"10px 4px"}}/>
                    <td style={{padding:"10px 8px"}}/>
                    {budgetDims.map((d,i)=><td key={d} style={{padding:"10px 14px"}}>{i===0&&<SectionLabel T={T} style={{marginBottom:0,color:T.text}}>Totals ({filteredSegments.length})</SectionLabel>}</td>)}
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text}}>{ft.budget>0?fmtFull(ft.budget):"—"}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text}}>{fmtFull(ft.spend)}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text}}>{ftActualPct!=null?`${Math.round(ftActualPct*100)}%`:"—"}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),color:T.textMuted}}>{Math.round(pacing.expectedPct*100)}%</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text}}>{fmtFull(ft.dailyRate)}/day</td>
                    <td style={{padding:"10px 8px",textAlign:"right"}}>
                      <div style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                        {ft.hasProjected?fmtFull(ft.projected):"—"}
                        {ft.hasProjected&&ft.budget>0&&<span style={{color:T.textMuted,marginLeft:6,fontWeight:400,fontSize:13*(T.fsScale||1)}}>({Math.round((ft.projected/ft.budget)*100)}%)</span>}
                      </div>
                      {ftVariance!=null&&<div style={{fontSize:13*(T.fsScale||1),color:ftVariance>0?T.danger:T.success,fontFamily:T.font}}>{fmtSigned(ftVariance)}</div>}
                    </td>
                    <td/>
                    <td/>
                  </tr>
                );
              })()}
            </tbody>
          </table>
          </>
        ))}
        {viewMode==="custom"&&(customDims.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:60,textAlign:"center"}}>
            <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:6}}>Choose at least one dimension</div>
            <div style={{fontSize:13*(T.fsScale||1),color:T.textSub}}>Pick Platform, Region, or any tag dimension above to group by.</div>
          </div>
        ):!customPacing||customPacing.segments.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:60,textAlign:"center"}}>
            <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:6}}>No spend data for {periodLabel}</div>
            <div style={{fontSize:13*(T.fsScale||1),color:T.textSub}}>Import spend data, or pick a different period or dimension combination.</div>
          </div>
        ):(
          <>
          {/* Filter bar */}
          <div style={{padding:"8px 24px",borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>Filter:</span>
            {customDims.map(d=>(
              <input key={d} value={segFilters[d]||""} onChange={e=>setSegFilters(p=>({...p,[d]:e.target.value}))} placeholder={d}
                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 8px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,width:120}}/>
            ))}
            <NumericFilterChips numericFilters={numericFilters} setNumericFilters={setNumericFilters} mode="custom" T={T}/>
            {hasSegFilters&&<Btn onClick={clearSegFilters} variant="ghost" size="sm" T={T}>Clear filters</Btn>}
            <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
            <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>Break down by:</span>
            <Sel value={breakdownDim} onChange={v=>{setBreakdownDim(v);setExpandedRows(new Set());}} T={T} style={{width:150}}>
              <option value="">None</option>
              {breakdownOptions.map(d=><option key={d} value={d}>{d}</option>)}
            </Sel>
            {renderAskAboutViewBtn({marginLeft:"auto"})}
            <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>{filteredCustomSegments.length} of {customPacing.segments.length} groups</span>
          </div>
          <table style={{borderCollapse:"collapse",minWidth:"100%",fontSize:13*(T.fsScale||1),background:T.surface}}>
            <thead><tr>
              <th style={{...TH,width:20,paddingLeft:24}}/>
              {customDims.map(d=><th key={d} style={{...TH,...(d==="Product"?{maxWidth:110}:d==="Module"?{maxWidth:140}:{})}}>{d}</th>)}
              <th style={TH}>Spend PTD</th>
              <th style={TH}>Daily Burn</th>
              <th style={TH}>Projected</th>
              <th style={{...TH,paddingRight:24}}>Campaigns</th>
            </tr></thead>
            <tbody>
              {filteredCustomSegments.length===0&&(
                <tr><td colSpan={2+customDims.length+3} style={{padding:"32px 24px",textAlign:"center",color:T.textMuted,fontSize:13*(T.fsScale||1)}}>No groups match your filters. <span onClick={clearSegFilters} style={{color:T.accent,cursor:"pointer",fontWeight:400}}>Clear filters</span></td></tr>
              )}
              {filteredCustomSegments.flatMap(seg=>{
                const isExpanded=breakdownDim&&expandedRows.has(seg.segKey);
                const rbb=`1px solid ${T.border}`;
                const parentRow=(
                  <tr key={seg.segKey} className="bhq-tr">
                    <td style={{padding:"8px 4px",borderBottom:rbb,textAlign:"center",paddingLeft:24}}>
                      {breakdownDim&&<button onClick={()=>toggleExpand(seg.segKey)} title={`Break down by ${breakdownDim}`}
                        style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11*(T.fsScale||1),padding:2,lineHeight:1,transform:isExpanded?"rotate(90deg)":"none",transition:"transform 0.12s"}}>▸</button>}
                    </td>
                    {seg.dims.map((v,i)=>{const dimMaxW=customDims[i]==="Product"?110:customDims[i]==="Module"?140:undefined;return(
                    <td key={i} style={{padding:"8px 14px",borderBottom:rbb,whiteSpace:"nowrap",...(dimMaxW?{maxWidth:dimMaxW,overflow:"hidden",textOverflow:"ellipsis"}:{})}}>
                      <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,borderRadius:T.r6}}>{v}</Pill>
                    </td>);})}
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,color:T.text}}>{fmtFull(seg.spend)}</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,color:T.text}}>{fmtFull(seg.dailyRate)}/day</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right"}}>
                      <div style={{fontFamily:T.font,color:T.text,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                        {seg.projected!=null?fmtFull(seg.projected):"—"}
                        {seg.lowConfidencePlatforms?.length>0&&(
                          <WarnTip T={T} text={`Projection may be unreliable — ${seg.lowConfidencePlatforms.join(", ")} only has a single as-of data point for this period, so its spend is being extrapolated across every day instead of an actual daily rate.`}/>
                        )}
                      </div>
                    </td>
                    <td style={{padding:"8px 14px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,color:T.textMuted,paddingRight:24}}>{seg.campaignCount}</td>
                  </tr>
                );
                if(!isExpanded)return[parentRow];
                const breakdown=computeCustomBreakdown({mergedNormRows,tags:campaignTags,dims:customDims,segKey:seg.segKey,breakdownDim,start:customPacing.start,end:customPacing.end,today:now,combineGoogleChannels});
                const breakdownRows=breakdown.length===0?[
                  <tr key={seg.segKey+"-empty"}>
                    <td/>
                    <td colSpan={customDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:13*(T.fsScale||1),color:T.textMuted,fontStyle:"italic"}}>No spend in this period to break down by {breakdownDim}</td>
                    <td colSpan={4} style={{borderBottom:rbb}}/>
                  </tr>
                ]:breakdown.map(b=>(
                  <tr key={seg.segKey+"-"+b.value}>
                    <td/>
                    <td colSpan={customDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:13*(T.fsScale||1),color:T.textSub}}>↳ {b.value}</td>
                    <td style={{padding:"6px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1)}}>
                      {fmtFull(b.spend)}<span style={{color:T.textMuted,marginLeft:6,fontSize:13*(T.fsScale||1)}}>({Math.round(b.pct*100)}%)</span>
                    </td>
                    <td style={{padding:"6px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),color:T.textMuted}}>{fmtFull(b.dailyRate)}/day</td>
                    <td style={{padding:"6px 8px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),color:T.textMuted}}>{b.projected!=null?fmtFull(b.projected):"—"}</td>
                    <td style={{borderBottom:rbb}}/>
                  </tr>
                ));
                return[parentRow,...breakdownRows];
              })}
              {filteredCustomSegments.length>0&&(()=>{
                const ft=filteredCustomSegments.reduce((acc,s)=>({
                  spend:acc.spend+s.spend,
                  dailyRate:acc.dailyRate+s.dailyRate,
                  projected:acc.projected+(s.projected||0),
                  hasProjected:acc.hasProjected||s.projected!=null,
                  campaignCount:acc.campaignCount+s.campaignCount,
                }),{spend:0,dailyRate:0,projected:0,hasProjected:false,campaignCount:0});
                return(
                  <tr style={{borderTop:`2px solid ${T.border}`,background:T.surface}}>
                    <td style={{padding:"10px 4px"}}/>
                    {customDims.map((d,i)=><td key={d} style={{padding:"10px 14px"}}>{i===0&&<SectionLabel T={T} style={{marginBottom:0,color:T.text}}>Totals ({filteredCustomSegments.length})</SectionLabel>}</td>)}
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text}}>{fmtFull(ft.spend)}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text}}>{fmtFull(ft.dailyRate)}/day</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text}}>{ft.hasProjected?fmtFull(ft.projected):"—"}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.textMuted}}>{ft.campaignCount}</td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
          </>
        ))}
        {viewMode==="trend"&&(!trendData||trendData.grandTotal===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:60,textAlign:"center"}}>
            <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:6}}>No spend data in this range</div>
            <div style={{fontSize:13*(T.fsScale||1),color:T.textSub}}>{trendFilterDim?`Nothing matched "${trendFilterValue}" in ${trendFilterDim} between ${trendStartMonth} and ${trendEndMonth}.`:"Widen the date range, or check the filter above."}</div>
          </div>
        ):(
          <>
          <PixelPanel T={T} style={{margin:"0 24px"}} contentStyle={{padding:"18px 20px"}}>
            <TrendBarChart T={T} periods={trendData.periods} series={trendData.series} budgetValues={trendData.budgetValues}/>
            {(trendData.series.length>0||trendData.budgetValues)&&(
              <div style={{display:"flex",gap:14,flexWrap:"wrap",marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                {trendData.budgetValues&&(
                  <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12*(T.fsScale||1),fontFamily:T.font}}>
                    <span style={{width:9,height:9,borderRadius:T.r2,background:T.textMuted,opacity:0.35,flexShrink:0}}/>
                    <span style={{color:T.text,fontWeight:600}}>Budget</span>
                    <span style={{color:T.textMuted}}>{fmtFull(trendData.budgetValues.reduce((s,v)=>s+v,0))} total</span>
                  </div>
                )}
                {trendData.series.map((s,i)=>(
                  <div key={s.label} style={{display:"flex",alignItems:"center",gap:6,fontSize:12*(T.fsScale||1),fontFamily:T.font}}>
                    <span style={{width:9,height:9,borderRadius:T.r2,background:TREND_COLORS[i%TREND_COLORS.length],flexShrink:0}}/>
                    <span style={{color:T.text,fontWeight:600}}>{s.label}</span>
                    <span style={{color:T.textMuted}}>{fmtFull(s.total)} total</span>
                  </div>
                ))}
              </div>
            )}
            {trendData.budgetFilterNote&&(
              <div style={{marginTop:8,fontSize:11*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>{trendData.budgetFilterNote}</div>
            )}
            {trendData.spendProrationNote&&(
              <div style={{marginTop:8,fontSize:11*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>{trendData.spendProrationNote}</div>
            )}
          </PixelPanel>
          <table style={{borderCollapse:"collapse",minWidth:"100%",fontSize:13*(T.fsScale||1),marginTop:16,background:T.surface}}>
            <thead><tr>
              <th style={{...TH,textAlign:"left",paddingLeft:24}}>{trendSeriesDim||"Period"}</th>
              {trendData.periods.map(p=><th key={p.key} style={{...TH,textAlign:"right"}}>{p.label}</th>)}
              <th style={{...TH,textAlign:"right",paddingRight:24}}>Total</th>
            </tr></thead>
            <tbody>
              {trendData.budgetValues&&(
                <tr className="bhq-tr">
                  <td style={{padding:"8px 14px",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap",paddingLeft:24}}>
                    <Pill color={T.textMuted} bg={T.pill} border={T.pillBorder} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,borderRadius:T.r6}}>Budget</Pill>
                  </td>
                  {trendData.budgetValues.map((v,i)=><td key={i} style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,color:T.textMuted}}>{v>0?fmtFull(v):"—"}</td>)}
                  <td style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.textMuted,paddingRight:24}}>{fmtFull(trendData.budgetValues.reduce((s,v)=>s+v,0))}</td>
                </tr>
              )}
              {trendData.series.map(s=>(
                <tr key={s.label} className="bhq-tr">
                  <td style={{padding:"8px 14px",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap",paddingLeft:24}}>
                    <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,borderRadius:T.r6}}>{s.label}</Pill>
                  </td>
                  {s.values.map((v,i)=><td key={i} style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,color:T.text}}>{v>0?fmtFull(v):"—"}</td>)}
                  <td style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text,paddingRight:24}}>{fmtFull(s.total)}</td>
                </tr>
              ))}
              <tr style={{borderTop:`2px solid ${T.border}`,background:T.surface}}>
                <td style={{padding:"10px 14px",paddingLeft:24}}><SectionLabel T={T} style={{marginBottom:0,color:T.text}}>Total</SectionLabel></td>
                {trendData.periodTotals.map((v,i)=><td key={i} style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text}}>{fmtFull(v)}</td>)}
                <td style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text,paddingRight:24}}>{fmtFull(trendData.grandTotal)}</td>
              </tr>
              {mqlTrend&&(mqlTrend.goalTotal>0||mqlTrend.actualTotal>0)&&(
                <>
                  <tr>
                    <td colSpan={trendData.periods.length+2} style={{padding:"14px 14px 4px",paddingLeft:24,borderTop:`1px solid ${T.border}`}}>
                      <SectionLabel T={T} style={{marginBottom:0,color:T.textSub}}>MQLs</SectionLabel>
                    </td>
                  </tr>
                  <tr className="bhq-tr">
                    <td style={{padding:"8px 14px",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap",paddingLeft:24}}>
                      <Pill color={T.textMuted} bg={T.pill} border={T.pillBorder} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,borderRadius:T.r6}}>MQL Goal</Pill>
                    </td>
                    {mqlTrend.goalValues.map((v,i)=><td key={i} style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,color:T.textMuted}}>{v>0?fmtCount(v):"—"}</td>)}
                    <td style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.textMuted,paddingRight:24}}>{fmtCount(mqlTrend.goalTotal)}</td>
                  </tr>
                  <tr className="bhq-tr">
                    <td style={{padding:"8px 14px",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap",paddingLeft:24}}>
                      <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,borderRadius:T.r6}}>MQL Actual</Pill>
                    </td>
                    {mqlTrend.actualValues.map((v,i)=><td key={i} style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,color:T.text}}>{v>0?fmtCount(v):"—"}</td>)}
                    <td style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,color:T.text,paddingRight:24}}>{fmtCount(mqlTrend.actualTotal)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          </>
        ))}
      </div>
      {notif&&<div style={{position:"fixed",bottom:20,right:20,background:T.success,color:"#fff",padding:"10px 16px",borderRadius:T.r8,fontSize:13*(T.fsScale||1),fontWeight:600,zIndex:100,boxShadow:T.shadowMd,fontFamily:T.font}}>{notif}</div>}
    </div>
  );
}
