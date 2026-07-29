import { useState, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  computePacing, computePlatformDateRange, computeCustomGrouping, computeCustomBreakdown,
  computeMonthlyTrend, computeSpendBreakdown, renameDimensionValue, countSegmentCampaigns,
  untagSegmentCampaigns, buildCampaignPlatformIndex, DERIVED_DIMS, pacingStatusMeta, fmtFull, fmtSigned,
  FORECAST_MODELS, FORECAST_MODEL_INHERIT, DEFAULT_MANUAL_TRAILING_DAYS, forecastModelLabel,
  AUTO_SHORT_WINDOW, AUTO_DIVERGENCE_LOW, AUTO_DIVERGENCE_HIGH, CAPACITY_WINDOW, MONTHS, QUARTERS,
  NUMERIC_FIELDS, NUMERIC_OPERATORS, matchesNumericFilters,
} from "../lib/core.js";
import { askAIBuildView, aiConfigToViewConfig } from "../lib/askAI.js";
import { Icon, Btn, SectionLabel, Sel, Divider, PixelPanel, AISummaryCard, Pill, WarnTip, InfoTip } from "./shared.jsx";
import lifeSupportBackpackIcon from "../assets/icons/life-support-backpack.png";

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

// src/components/PacingDashboard.jsx — Reporting & Pacing tab (2026-07-25 split, per Mo).
// Includes TrendLineChart and PacingBar, the two small chart components only this tab uses.

const TREND_COLORS=["#F97316","#3B82F6","#10B981","#8B5CF6","#EC4899","#F59E0B","#06B6D4"];
const TrendLineChart=({T,months,series})=>{
  const W=720,H=230,padL=56,padB=26,padT=12,padR=16;
  const plotW=W-padL-padR,plotH=H-padT-padB;
  const maxY=Math.max(1,...series.flatMap(s=>s.values));
  const xStep=months.length>1?plotW/(months.length-1):0;
  const yFor=v=>padT+plotH-(v/maxY)*plotH;
  const xFor=i=>padL+(months.length>1?i*xStep:plotW/2);
  const yTicks=[0,0.25,0.5,0.75,1].map(f=>Math.round(maxY*f));
  const fmtTick=v=>v>=1000?`$${Math.round(v/1000)}k`:`$${v}`;
  return(
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block"}}>
      {yTicks.map((t,i)=>{
        const y=yFor(t);
        return(
          <g key={i}>
            <line x1={padL} y1={y} x2={W-padR} y2={y} stroke={T.border} strokeWidth={1}/>
            <text x={padL-8} y={y+3} textAnchor="end" fontSize={9} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>{fmtTick(t)}</text>
          </g>
        );
      })}
      {months.map((m,i)=>(
        <text key={m.key} x={xFor(i)} y={H-6} textAnchor="middle" fontSize={9} fontFamily="'DM Sans',sans-serif" fill={T.textMuted}>{m.label}</text>
      ))}
      {series.map((s,si)=>{
        const color=TREND_COLORS[si%TREND_COLORS.length];
        const pts=s.values.map((v,i)=>`${xFor(i)},${yFor(v)}`).join(" ");
        return(
          <g key={s.label}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"/>
            {s.values.map((v,i)=><circle key={i} cx={xFor(i)} cy={yFor(v)} r={2.5} fill={color}/>)}
          </g>
        );
      })}
    </svg>
  );
};

const PacingBar=({actualPct,expectedPct,status,T})=>{
  const pct=Math.min(1,Math.max(0,actualPct||0));
  const meta=pacingStatusMeta(status,T);
  return(
    <div style={{position:"relative",width:84,height:6,borderRadius:3,background:T.surfaceEl,flexShrink:0}}>
      <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct*100}%`,background:meta.color,borderRadius:3,transition:"width 0.2s"}}/>
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
        <Pill key={i} color={T.text} bg={T.pill} border={T.pillBorder} style={{fontSize:12,display:"flex",alignItems:"center",gap:5}}>
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
            style={{width:76,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
          <Btn onClick={addFilter} disabled={!field||value===""} variant="primary" size="sm" T={T}>Add</Btn>
          <Btn onClick={()=>{setOpen(false);setField("");setOperator(">");setValue("");}} variant="ghost" size="sm" T={T}>✕</Btn>
        </div>
      ):(
        <Btn onClick={()=>setOpen(true)} variant="ghost" size="sm" T={T}>+ Add filter</Btn>
      )}
    </>
  );
};

export default function PacingDashboard({campaignTags,setTags,tagDimensions,budgetDims,budgets,setBudgets,budgetRowMeta,setBudgetRowMeta,savedViews,setSavedViews,defaultForecastModel,setDefaultForecastModel,mergedNormRows,T,onNavigate,sidebarEl,canEdit=true}){
  const now=new Date();
  const yr=now.getFullYear();
  const[year,setYear]=useState(yr.toString());
  const[periodType,setPeriodType]=useState("monthly");
  const[month,setMonth]=useState(String(now.getMonth()+1).padStart(2,"0"));
  const[quarter,setQuarter]=useState(`Q${Math.floor(now.getMonth()/3)+1}`);
  const years=[(yr-1).toString(),yr.toString(),(yr+1).toString()];

  const[selRows,setSelRows]=useState(new Set());
  const[segFilters,setSegFilters]=useState({}); // {dim: filterText} — substring match, ANDed across dims
  const[numericFilters,setNumericFilters]=useState([]); // [{field,operator,value}] — see NumericFilterChips/NUMERIC_FIELDS; ANDed with each other and with segFilters/statusFilter
  const[statusFilter,setStatusFilter]=useState("all");
  const[notif,setNotif]=useState(null);
  const[editingSegVal,setEditingSegVal]=useState(null); // {segKey, dim}
  const[editSegVal,setEditSegVal]=useState("");
  const[breakdownDim,setBreakdownDim]=useState(""); // "" = no drill-down; else "Platform" or a tag dimension
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
  const[viewMode,setViewMode]=useState(()=>budgetDims.length?"budget":"custom"); // "budget" | "custom" | "trend"
  const[customDims,setCustomDims]=useState(()=>budgetDims.length?[]:["Platform"]);
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
  const[trendFilterDim,setTrendFilterDim]=useState("");
  const[trendFilterValue,setTrendFilterValue]=useState("");
  const[trendSeriesDim,setTrendSeriesDim]=useState("Platform");
  const[trendStartMonth,setTrendStartMonth]=useState(()=>monthStr(new Date(now.getFullYear(),now.getMonth()-5,1)));
  const[trendEndMonth,setTrendEndMonth]=useState(()=>monthStr(now));
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
      setSegFilters({});setStatusFilter("all");setBreakdownDim("");setNumericFilters([]);
    }else{
      setSegFilters(cfg.segFilters||{});
      setStatusFilter(cfg.viewMode==="budget"?(cfg.statusFilter||"all"):"all");
      setBreakdownDim(cfg.breakdownDim||"");
      setNumericFilters(cfg.numericFilters||[]);
    }
  };
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
      const raw=await askAIBuildView({question:q,ctx:{mergedNormRows,tags:campaignTags,tagDims:tagDimensions,budgetDims,budgets,budgetRowMeta}});
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

  const pacing=useMemo(()=>computePacing({mergedNormRows,tags:campaignTags,budgetDims,budgets,year,periodType,month,quarter,today:now,budgetRowMeta,defaultForecastModel}),
    [mergedNormRows,campaignTags,budgetDims,budgets,year,periodType,month,quarter,budgetRowMeta,defaultForecastModel]); // eslint-disable-line react-hooks/exhaustive-deps
  const platformDateRange=useMemo(()=>computePlatformDateRange(mergedNormRows),[mergedNormRows]);
  const customPacing=useMemo(()=>viewMode==="custom"&&customDims.length?computeCustomGrouping({mergedNormRows,tags:campaignTags,dims:customDims,year,periodType,month,quarter,today:now}):null,
    [viewMode,mergedNormRows,campaignTags,customDims,year,periodType,month,quarter]); // eslint-disable-line react-hooks/exhaustive-deps
  const trendRange=useMemo(()=>{
    const[sy,sm]=trendStartMonth.split("-").map(Number);
    const[ey,em]=trendEndMonth.split("-").map(Number);
    let start=new Date(sy,sm-1,1),end=new Date(ey,em,0,23,59,59,999); // end = last day of end month
    if(start>end)[start,end]=[end,start]; // swapped range picker inputs shouldn't produce zero months
    return{start,end};
  },[trendStartMonth,trendEndMonth]);
  const trendData=useMemo(()=>viewMode==="trend"?computeMonthlyTrend({mergedNormRows,tags:campaignTags,filterDim:trendFilterDim,filterValue:trendFilterValue,seriesDim:trendSeriesDim,start:trendRange.start,end:trendRange.end}):null,
    [viewMode,mergedNormRows,campaignTags,trendFilterDim,trendFilterValue,trendSeriesDim,trendRange]);

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
  const TH={fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text,padding:"10px 8px",borderBottom:`1px solid ${T.border}`,background:T.headerBg,whiteSpace:"nowrap",textAlign:"center"};
  const safeTextColor=c=>c===T.accent?T.text:c; // gold is a fine fill/border color but never body text, per the established house rule

  // Only block entirely when there's truly nothing to show — no budget structure AND no spend
  // synced yet. If spend exists but budgets don't, fall through to the full view below (defaulted
  // to "custom" mode above) so spend-by-Platform/tag is still visible — that's useful on its own,
  // independent of whether budgets have been set up.
  if(!budgetDims.length&&!mergedNormRows.length){
    return(
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40,background:T.bg}}>
        {/* Life-support-backpack illustration (2026-07-26, per Mo, licensed "Geometric Space
            Collection" set) replaces the plain chart-icon tile — a PLSS keeps a person alive and
            monitored, the same job this tab does for a budget's pacing/health once it has data. */}
        <img src={lifeSupportBackpackIcon} alt="" aria-hidden="true" style={{width:130,height:"auto",marginBottom:18}}/>
        <div style={{fontSize:17,fontWeight:700,color:T.text,marginBottom:6}}>No data yet</div>
        <div style={{fontSize:13,color:T.textSub,maxWidth:340,lineHeight:1.65,marginBottom:20}}>Import spend data and set up budget segments to see pacing and spend breakdowns here.</div>
        <Btn onClick={()=>onNavigate?.("tagger")} variant="success" T={T} size="md">Go to Campaign Tagger →</Btn>
      </div>
    );
  }

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100%",background:T.bg,overflow:"auto"}}>
      {/* Controls + summary now render via portal into the app-shell's stats sidebar */}
      {sidebarEl&&createPortal(
        <div style={{display:"flex",flexDirection:"column",gap:0}}>
          <div style={{paddingBottom:12}}>
            <SectionLabel T={T} style={{marginBottom:8}}>Period</SectionLabel>
            <div style={{display:"flex",gap:4,marginBottom:8}}>
              {[["monthly","Mo"],["quarterly","Qtr"],["annual","Yr"]].map(([k,l])=>(
                <button key={k} className={periodType===k?undefined:"bhq-row"} onClick={()=>changePeriodType(k)} style={{flex:1,padding:"6px 0",borderRadius:6,border:`1.5px solid ${periodType===k?T.accentHover:T.border}`,background:periodType===k?T.accentBg:"transparent",color:periodType===k?T.text:T.textMuted,cursor:"pointer",fontSize:11,fontWeight:periodType===k?700:400,fontFamily:"'DM Sans',sans-serif"}}>{l}</button>
              ))}
            </div>
            <div style={{display:"flex",gap:4,marginBottom:8}}>
              {years.map(y=>(
                <button key={y} className={year===y?undefined:"bhq-row"} onClick={()=>changeYear(y)} style={{flex:1,padding:"6px 0",borderRadius:6,border:`1.5px solid ${year===y?T.accentHover:T.border}`,background:year===y?T.accentBg:"transparent",color:year===y?T.text:T.textMuted,cursor:"pointer",fontSize:11,fontWeight:year===y?700:400,fontFamily:"'DM Sans',sans-serif"}}>{y}</button>
              ))}
            </div>
            {periodType==="monthly"&&(
              <Sel value={month} onChange={changeMonth} T={T} style={{marginBottom:8}}>
                {MONTHS.map(m=><option key={m.key} value={m.key}>{m.label}</option>)}
              </Sel>
            )}
            {periodType==="quarterly"&&(
              <Sel value={quarter} onChange={changeQuarter} T={T} style={{marginBottom:8}}>
                {QUARTERS.map(q=><option key={q.key} value={q.key}>{q.key}</option>)}
              </Sel>
            )}
            <div style={{fontSize:11,color:T.textMuted,lineHeight:1.5}}>
              {periodLabel} · {pacing.elapsedDays} of {pacing.totalDays} days elapsed{pacing.daysRemaining>0?` · ${pacing.daysRemaining} remaining`:""}
            </div>
          </div>
          <Divider T={T}/>
          <div style={{padding:"12px 0",display:"flex",flexDirection:"column",gap:10}}>
            <SectionLabel T={T} style={{marginBottom:2}}>Summary</SectionLabel>
            {[
              {label:"Total Budget",value:fmtFull(pacing.totals.budget),color:T.text},
              {label:"Spend to Date",value:fmtFull(pacing.totals.spend),color:T.text},
              {label:"Overall Pacing",value:overallPct!=null?`${Math.round(overallPct*100)}%`:"—",color:overallPct!=null&&overallPct-pacing.expectedPct>0.1?T.warning:overallPct!=null&&overallPct-pacing.expectedPct<-0.1?T.accent:T.success},
              {label:"Expected Pace",value:`${Math.round(pacing.expectedPct*100)}%`,color:T.text},
              {label:"Segments",value:pacing.segments.length.toString(),color:T.text},
            ].map(s=>(
              <PixelPanel key={s.label} T={T} contentStyle={{padding:"12px 14px",background:T.bg}}>
                <div style={{fontSize:10,fontWeight:600,color:T.textMuted,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:6}}>{s.label}</div>
                <div style={{fontSize:19,fontWeight:700,color:s.color,fontFamily:"'DM Sans',sans-serif"}}>{s.value}</div>
              </PixelPanel>
            ))}
          </div>
          <Divider T={T}/>
          <div style={{padding:"12px 0 4px",display:"flex",flexDirection:"column",gap:6}}>
            <SectionLabel T={T} style={{marginBottom:2}}>Data freshness</SectionLabel>
            <div style={{fontSize:10,color:T.textMuted,lineHeight:1.5,marginBottom:4}}>Date range each platform actually has spend data for, regardless of source (sync, Google Sheet, CSV/screenshot) — projections use each platform's own last date instead of assuming everyone's current through today.</div>
            {Object.entries(pacing.platformFreshness||{}).sort(([,a],[,b])=>b-a).map(([platform,date])=>{
              const daysStale=Math.floor((now-date)/86400000);
              // Same 4-color scale as the Pacing column's status colors (pacingStatusMeta) instead
              // of a plain 3-tier success/warning/danger — gives freshness more graduated signal
              // (e.g. "2 days ago" across every platform used to render as one flat color) using
              // colors already established elsewhere in this view.
              const color=daysStale<=1?T.success:daysStale<=3?T.accent:daysStale<=6?T.warning:T.danger;
              const label=daysStale<=0?"Today":daysStale===1?"Yesterday":`${daysStale} days ago`;
              const range=platformDateRange[platform];
              const fmtShort=d=>d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
              return(
                <div key={platform} style={{display:"flex",flexDirection:"column",gap:1,padding:"3px 0"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,fontSize:11,fontFamily:"'DM Sans',sans-serif"}}>
                    <span style={{color:T.textSub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{platform}</span>
                    <span style={{color,fontWeight:600,whiteSpace:"nowrap"}}>{label}</span>
                  </div>
                  {range&&<div style={{fontSize:10,color:T.textMuted,whiteSpace:"nowrap"}}>{fmtShort(range.min)} – {fmtShort(range.max)}</div>}
                </div>
              );
            })}
            {Object.keys(pacing.platformFreshness||{}).length===0&&<div style={{fontSize:11,color:T.textMuted}}>No spend data yet</div>}
          </div>
        </div>,
        sidebarEl
      )}

      {/* Segment table */}
      <div style={{flex:1,overflow:"auto",padding:"20px 24px 24px"}}>
        <AISummaryCard T={T} mergedNormRows={mergedNormRows} tags={campaignTags} budgetDims={budgetDims} budgets={budgets} budgetRowMeta={budgetRowMeta} defaultForecastModel={defaultForecastModel} mode="pacing"
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
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:8,marginBottom:14,fontSize:12,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>
            No budget structure set up yet — showing spend by dimension only.{" "}
            <span onClick={()=>onNavigate?.("budget")} style={{color:T.accentText,fontWeight:600,cursor:"pointer"}}>Set up budgets →</span>
          </div>
        )}
        {/* View by — Budget Segments (the only grouping with $ budgets) vs Custom (any dimension
            combo, spend-only). Shown regardless of whether budget segments exist, since switching
            away to Custom is exactly what you'd want to do if they don't. */}
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:14}}>
          <span style={{fontSize:11,color:T.text,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"}}>View by:</span>
          <div style={{display:"flex",gap:4}}>
            {[["budget","Budget Segments"],["custom","Custom"],["trend","Trend"]].map(([k,l])=>(
              <button key={k} onClick={()=>changeViewMode(k)}
                style={{padding:"6px 12px",borderRadius:6,border:`1.5px solid ${viewMode===k?T.accentHover:T.border}`,background:viewMode===k?T.accentBg:"transparent",color:viewMode===k?T.text:T.textMuted,cursor:"pointer",fontSize:12,fontWeight:viewMode===k?700:400,fontFamily:"'DM Sans',sans-serif"}}>{l}</button>
            ))}
          </div>
          {viewMode==="custom"&&(
            <div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:11,color:T.textMuted}}>Group by:</span>
              {allDimOptions.map(d=>{
                const active=customDims.includes(d);
                return(
                  <button key={d} onClick={()=>toggleCustomDim(d)}
                    style={{fontSize:11,padding:"4px 10px",borderRadius:14,border:`1.5px solid ${active?T.accentHover:T.border}`,background:active?T.accentBg:"transparent",color:active?T.text:T.textMuted,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:active?700:500}}>{d}</button>
                );
              })}
            </div>
          )}
          {viewMode==="trend"&&(
            <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <span style={{fontSize:11,color:T.textMuted}}>From</span>
                <input type="month" value={trendStartMonth} onChange={e=>setTrendStartMonth(e.target.value)}
                  style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                <span style={{fontSize:11,color:T.textMuted}}>to</span>
                <input type="month" value={trendEndMonth} onChange={e=>setTrendEndMonth(e.target.value)}
                  style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
              </div>
              <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <span style={{fontSize:11,color:T.textMuted}}>Filter by</span>
                <Sel value={trendFilterDim} onChange={v=>{setTrendFilterDim(v);setTrendFilterValue("");}} T={T} style={{width:130}}>
                  <option value="">No filter</option>
                  {trendFilterOptions.map(d=><option key={d} value={d}>{d}</option>)}
                </Sel>
                {trendFilterDim&&(
                  <input value={trendFilterValue} onChange={e=>setTrendFilterValue(e.target.value)} placeholder={`${trendFilterDim} contains…`}
                    style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif",width:150}}/>
                )}
              </div>
              <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <span style={{fontSize:11,color:T.textMuted}}>Split by</span>
                <Sel value={trendSeriesDim} onChange={setTrendSeriesDim} T={T} style={{width:130}}>
                  <option value="">Don't split</option>
                  {trendSeriesOptions.map(d=><option key={d} value={d}>{d}</option>)}
                </Sel>
              </div>
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
                <div style={{position:"absolute",top:"calc(100% + 6px)",left:0,zIndex:100,minWidth:240,maxHeight:320,overflow:"auto",background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd,padding:6}}>
                  {!savedViews?.length&&<div style={{padding:"10px 8px",fontSize:12,color:T.textMuted}}>No saved views yet.</div>}
                  {(savedViews||[]).map(v=>(
                    <div key={v.id} style={{display:"flex",alignItems:"center",gap:2}}>
                      <button onClick={()=>applySavedView(v)} className="bhq-row" style={{flex:1,display:"block",textAlign:"left",padding:"7px 8px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:12,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.name}</button>
                      <button onClick={()=>deleteSavedView(v.id,v.name)} title="Delete saved view" style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"none",borderRadius:5,color:T.textMuted,cursor:"pointer",fontSize:13,flexShrink:0,fontFamily:"'DM Sans',sans-serif"}}>✕</button>
                    </div>
                  ))}
                  <div style={{height:1,background:T.border,margin:"4px 2px"}}/>
                  <button onClick={()=>{setSavedViewsMenuOpen(false);openSaveViewModal();}} className="bhq-row" style={{display:"flex",alignItems:"center",gap:6,width:"100%",textAlign:"left",padding:"7px 8px",borderRadius:6,background:"transparent",border:"none",color:T.accentText,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}><Icon name="plus" size={12} color={T.accentText}/> Save current view</button>
                </div>
              </>
            )}
          </div>
          <Btn onClick={()=>setAiViewOpen(p=>!p)} variant="ghost" size="sm" T={T}>✨ Ask AI to build a view</Btn>
          {aiViewOpen&&(
            <div style={{display:"flex",gap:6,alignItems:"center",flex:"1 1 320px",minWidth:260}}>
              <input autoFocus value={aiViewQuestion} onChange={e=>setAiViewQuestion(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter"&&!aiViewLoading)runAiView();}}
                placeholder={`e.g. "segments behind pace on Meta this quarter"`}
                style={{flex:1,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
              <Btn onClick={runAiView} disabled={aiViewLoading||!aiViewQuestion.trim()} variant="primary" size="sm" T={T}>{aiViewLoading?"Thinking…":"Go"}</Btn>
            </div>
          )}
          {aiViewError&&<span style={{fontSize:11,color:T.danger}}>{aiViewError}</span>}
        </div>
        {savedViewModalOpen&&(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:210,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setSavedViewModalOpen(false)}>
            <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:380,background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:20,boxShadow:T.shadowMd}}>
              <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4}}>Save this view</div>
              <div style={{fontSize:12,color:T.textSub,marginBottom:12}}>Saves the current View-by setup — mode, filters, and breakdown — for one-click recall later. Always reflects whatever period you're viewing when you reopen it.</div>
              <input autoFocus value={savedViewNameDraft} onChange={e=>setSavedViewNameDraft(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter")saveCurrentView();if(e.key==="Escape")setSavedViewModalOpen(false);}}
                placeholder="e.g. Meta segments behind pace"
                style={{width:"100%",boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif",marginBottom:14}}/>
              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                <Btn onClick={()=>setSavedViewModalOpen(false)} variant="ghost" size="sm" T={T}>Cancel</Btn>
                <Btn onClick={saveCurrentView} disabled={!savedViewNameDraft.trim()} variant="primary" size="sm" T={T}>Save view</Btn>
              </div>
            </div>
          </div>
        )}
        {viewMode==="budget"&&(pacing.segments.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:60,textAlign:"center"}}>
            <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6}}>No budget or spend data for {periodLabel}</div>
            <div style={{fontSize:13,color:T.textSub}}>Set a budget or import spend data for this period.</div>
          </div>
        ):(
          <>
          {/* Filter bar */}
          <div style={{padding:"8px 0",borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:11,color:T.text,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"}}>Filter:</span>
            {budgetDims.map(d=>(
              <input key={d} value={segFilters[d]||""} onChange={e=>setSegFilters(p=>({...p,[d]:e.target.value}))} placeholder={d}
                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif",width:120}}/>
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
            <span style={{fontSize:11,color:T.text,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"}}>Default forecast model:</span>
            <div style={{display:"flex",alignItems:"center",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,padding:2,gap:2}}>
              {[{mode:"auto",label:"Auto"},{mode:"manual",label:"Manual"},{mode:"committed",label:"Committed"}].map(o=>{
                const active=forecastModeOf(defaultForecastModel)===o.mode;
                return(
                  <button key={o.mode} onClick={()=>setDefaultForecastModelMode(o.mode)} disabled={!canEdit}
                    title={FORECAST_MODELS.find(fm=>fm.value===o.mode)?.hint||(o.mode==="manual"?"Projects from a trailing window of a specific number of days you choose.":"")}
                    style={{border:"none",borderRadius:4,padding:"5px 10px",fontSize:12,fontFamily:"'DM Sans',sans-serif",cursor:canEdit?"pointer":"default",background:active?T.accent:"transparent",color:active?T.onAccent:T.textSub,fontWeight:active?600:500,transition:"all 0.1s"}}>
                    {o.label}
                  </button>
                );
              })}
            </div>
            {forecastModeOf(defaultForecastModel)==="manual"&&(
              <span style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:T.textSub}}>
                trailing
                <input type="number" min={1} max={365} value={manualDaysOf(defaultForecastModel)} disabled={!canEdit}
                  onChange={e=>setDefaultForecastModelManualDays(e.target.value)}
                  style={{width:48,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 6px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                days
              </span>
            )}
            <InfoTip T={T} text={FORECAST_EXPLANATION} width={360}/>
            <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
            <span style={{fontSize:11,color:T.text,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"}}>Break down by:</span>
            <Sel value={breakdownDim} onChange={v=>{setBreakdownDim(v);setExpandedRows(new Set());}} T={T} style={{width:150}}>
              <option value="">None</option>
              {breakdownOptions.map(d=><option key={d} value={d}>{d}</option>)}
            </Sel>
            <span style={{marginLeft:"auto",fontSize:11,color:T.textMuted}}>{filteredSegments.length} of {pacing.segments.length} segments</span>
          </div>
          {/* Bulk action bar */}
          {selRows.size>0&&(
            <div style={{padding:"8px 0",borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <Pill color={T.text} bg={T.accent} border={T.text}>{selRows.size} selected</Pill>
              <Btn onClick={()=>setSelRows(new Set())} variant="ghost" size="sm" T={T}>Clear</Btn>
              <Btn onClick={bulkDeleteSegments} variant="danger" size="sm" T={T}>✕ Delete {selRows.size}</Btn>
            </div>
          )}
          <table style={{borderCollapse:"collapse",minWidth:"100%",fontSize:13,background:T.surface}}>
            <thead><tr>
              <th style={{...TH,width:20}}/>
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
              <th style={TH}/>
            </tr></thead>
            <tbody>
              {filteredSegments.length===0&&(
                <tr><td colSpan={4+budgetDims.length+6} style={{padding:"32px 20px",textAlign:"center",color:T.textMuted,fontSize:13}}>No segments match your filters. <span onClick={clearSegFilters} style={{color:T.accent,cursor:"pointer",fontWeight:400}}>Clear filters</span></td></tr>
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
                    <td style={{padding:"8px 4px",borderBottom:rbb,textAlign:"center"}}>
                      {breakdownDim&&<button onClick={()=>toggleExpand(seg.segKey)} title={`Break down by ${breakdownDim}`}
                        style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11,padding:2,lineHeight:1,transform:isExpanded?"rotate(90deg)":"none",transition:"transform 0.12s"}}>▸</button>}
                    </td>
                    <td style={{padding:"8px 8px",borderBottom:rbb}}>
                      <input type="checkbox" checked={isSel} onChange={()=>toggleRowSel(seg.segKey)} title="Select row — reveals bulk delete once selected" style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
                    </td>
                    {seg.dims.map((v,i)=>{const dimMaxW=budgetDims[i]==="Product"?110:budgetDims[i]==="Module"?140:undefined;return(
                    <td key={i} style={{padding:"8px 14px",borderBottom:rbb,whiteSpace:"nowrap",...(dimMaxW?{maxWidth:dimMaxW,overflow:"hidden",textOverflow:"ellipsis"}:{})}}>
                      {DERIVED_DIMS.includes(budgetDims[i])?(
                        // Derived, not stored — see the same guard in the Budget Panel's table.
                        <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,borderRadius:6}} title="Derived from spend data — not editable">{v}</Pill>
                      ):editingSegVal?.segKey===seg.segKey&&editingSegVal?.dim===budgetDims[i]?(
                        <input autoFocus value={editSegVal} onChange={e=>setEditSegVal(e.target.value)}
                          onBlur={saveSegEdit} onKeyDown={e=>{if(e.key==="Enter")saveSegEdit();if(e.key==="Escape"){setEditingSegVal(null);setEditSegVal("");}}}
                          style={{background:T.inputBg,border:`1px solid ${T.accentBorder}`,borderRadius:6,color:T.text,padding:"3px 8px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif",minWidth:80}}/>
                      ):(
                        <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,cursor:"text",borderRadius:6}}
                          onClick={()=>{setEditingSegVal({segKey:seg.segKey,dim:budgetDims[i]});setEditSegVal(v);}}>{v}</Pill>
                      )}
                      {i===seg.dims.length-1&&seg.budget>0&&seg.matchCount===0&&(
                        <WarnTip T={T} text="No tagged campaigns match this segment. Spend will always show as $0 here, regardless of period, until a campaign is tagged with this exact combination in the Tagger."/>
                      )}
                    </td>);})}
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",color:T.text}}>{seg.budget>0?fmtFull(seg.budget):"—"}</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",color:T.text}}>{fmtFull(seg.spend)}</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right"}}>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",gap:8}}>
                        <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:safeTextColor(meta.color)}}>{seg.actualPct!=null?`${Math.round(seg.actualPct*100)}%`:"—"}</span>
                        <PacingBar actualPct={seg.actualPct} expectedPct={pacing.expectedPct} status={seg.status} T={T}/>
                      </div>
                    </td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",color:T.textMuted}}>{Math.round(pacing.expectedPct*100)}%</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",color:T.text}}>{fmtFull(seg.dailyRate)}/day</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right"}}>
                      <div style={{fontFamily:"'DM Sans',sans-serif",color:T.text,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                        {seg.projected!=null?fmtFull(seg.projected):"—"}
                        {seg.projected!=null&&seg.budget>0&&<span style={{color:T.textMuted,marginLeft:6,fontSize:13}}>({Math.round((seg.projected/seg.budget)*100)}%)</span>}
                        {seg.lowConfidencePlatforms?.length>0&&(
                          <WarnTip T={T} text={`Projection may be unreliable — ${seg.lowConfidencePlatforms.join(", ")} only has a single as-of data point for this period, so its spend is being extrapolated across every day instead of an actual daily rate. Check that platform's Date/"Data accurate through" mapping.`}/>
                        )}
                      </div>
                      {seg.projectedVariance!=null&&<div style={{fontSize:13,color:seg.projectedVariance>0?T.danger:T.success,fontFamily:"'DM Sans',sans-serif"}}>{fmtSigned(seg.projectedVariance)}</div>}
                    </td>
                    <td style={{padding:"8px 14px",borderBottom:rbb,minWidth:200}}>
                      <Pill color={safeTextColor(meta.color)} bg={meta.bg} border={meta.border} style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,whiteSpace:"nowrap"}}>{meta.label}</Pill>
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
                          style={{display:"block",width:"100%",boxSizing:"border-box",fontSize:13,color:getForecastModelOverride(seg.segKey)?T.accent:T.textMuted,background:getForecastModelOverride(seg.segKey)?T.accentBg:"transparent",border:`1px solid ${getForecastModelOverride(seg.segKey)?T.accentBorder:T.border}`,borderRadius:5,padding:"2px 4px",cursor:canEdit?"pointer":"default",fontFamily:"'DM Sans',sans-serif",outline:"none",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          <option value={FORECAST_MODEL_INHERIT}>Use global ({forecastModelLabel(defaultForecastModel)})</option>
                          <option value="auto">Auto</option>
                          <option value="committed">Committed</option>
                          <option value="manual">Manual</option>
                        </select>
                        {forecastModeOf(getForecastModelOverride(seg.segKey))==="manual"&&(
                          <input type="number" min={1} max={365} value={manualDaysOf(getForecastModelOverride(seg.segKey))} disabled={!canEdit}
                            onChange={e=>setForecastModelManualDays(seg.segKey,e.target.value)} title="Trailing window, in days"
                            style={{width:52,fontSize:13,color:T.text,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:5,padding:"1px 3px",fontFamily:"'DM Sans',sans-serif",outline:"none"}}/>
                        )}
                      </div>
                    </td>
                    <td style={{padding:"8px 8px",borderBottom:rbb}}>
                      <button onClick={()=>deleteSegment(seg.segKey,label)} title="Delete segment"
                        style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:5,color:T.textMuted,cursor:"pointer",fontSize:12,lineHeight:1,padding:0,opacity:0.4,transition:"all 0.1s"}}
                        onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.border=`1px solid ${T.danger}`;e.currentTarget.style.color=T.danger;}}
                        onMouseLeave={e=>{e.currentTarget.style.opacity=0.4;e.currentTarget.style.border="1px solid transparent";e.currentTarget.style.color=T.textMuted;}}>✕</button>
                    </td>
                  </tr>
                );
                if(!isExpanded)return[parentRow];
                const breakdown=computeSpendBreakdown({mergedNormRows,tags:campaignTags,budgetDims,segKey:seg.segKey,breakdownDim,start:pacing.start,end:pacing.end});
                const breakdownRows=breakdown.length===0?[
                  <tr key={seg.segKey+"-empty"} style={{background:rowBg}}>
                    <td/><td/>
                    <td colSpan={budgetDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:13,color:T.textMuted,fontStyle:"italic"}}>No spend in this period to break down by {breakdownDim}</td>
                    <td colSpan={8} style={{borderBottom:rbb}}/>
                  </tr>
                ]:breakdown.map(b=>(
                  <tr key={seg.segKey+"-"+b.value} style={{background:rowBg}}>
                    <td/><td/>
                    <td colSpan={budgetDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:13,color:T.textSub}}>↳ {b.value}</td>
                    <td style={{borderBottom:rbb}}/>
                    <td style={{padding:"6px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>
                      {fmtFull(b.spend)}<span style={{color:T.textMuted,marginLeft:6,fontSize:13}}>({Math.round(b.pct*100)}%)</span>
                    </td>
                    <td colSpan={6} style={{borderBottom:rbb}}/>
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
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{ft.budget>0?fmtFull(ft.budget):"—"}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{fmtFull(ft.spend)}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{ftActualPct!=null?`${Math.round(ftActualPct*100)}%`:"—"}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,color:T.textMuted}}>{Math.round(pacing.expectedPct*100)}%</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{fmtFull(ft.dailyRate)}/day</td>
                    <td style={{padding:"10px 8px",textAlign:"right"}}>
                      <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                        {ft.hasProjected?fmtFull(ft.projected):"—"}
                        {ft.hasProjected&&ft.budget>0&&<span style={{color:T.textMuted,marginLeft:6,fontWeight:400,fontSize:13}}>({Math.round((ft.projected/ft.budget)*100)}%)</span>}
                      </div>
                      {ftVariance!=null&&<div style={{fontSize:13,color:ftVariance>0?T.danger:T.success,fontFamily:"'DM Sans',sans-serif"}}>{fmtSigned(ftVariance)}</div>}
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
            <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6}}>Choose at least one dimension</div>
            <div style={{fontSize:13,color:T.textSub}}>Pick Platform, Region, or any tag dimension above to group by.</div>
          </div>
        ):!customPacing||customPacing.segments.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:60,textAlign:"center"}}>
            <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6}}>No spend data for {periodLabel}</div>
            <div style={{fontSize:13,color:T.textSub}}>Import spend data, or pick a different period or dimension combination.</div>
          </div>
        ):(
          <>
          {/* Filter bar */}
          <div style={{padding:"8px 0",borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:11,color:T.text,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"}}>Filter:</span>
            {customDims.map(d=>(
              <input key={d} value={segFilters[d]||""} onChange={e=>setSegFilters(p=>({...p,[d]:e.target.value}))} placeholder={d}
                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif",width:120}}/>
            ))}
            <NumericFilterChips numericFilters={numericFilters} setNumericFilters={setNumericFilters} mode="custom" T={T}/>
            {hasSegFilters&&<Btn onClick={clearSegFilters} variant="ghost" size="sm" T={T}>Clear filters</Btn>}
            <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
            <span style={{fontSize:11,color:T.text,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"}}>Break down by:</span>
            <Sel value={breakdownDim} onChange={v=>{setBreakdownDim(v);setExpandedRows(new Set());}} T={T} style={{width:150}}>
              <option value="">None</option>
              {breakdownOptions.map(d=><option key={d} value={d}>{d}</option>)}
            </Sel>
            <span style={{marginLeft:"auto",fontSize:11,color:T.textMuted}}>{filteredCustomSegments.length} of {customPacing.segments.length} groups</span>
          </div>
          <table style={{borderCollapse:"collapse",minWidth:"100%",fontSize:13,background:T.surface}}>
            <thead><tr>
              <th style={{...TH,width:20}}/>
              {customDims.map(d=><th key={d} style={{...TH,...(d==="Product"?{maxWidth:110}:d==="Module"?{maxWidth:140}:{})}}>{d}</th>)}
              <th style={TH}>Spend PTD</th>
              <th style={TH}>Daily Burn</th>
              <th style={TH}>Projected</th>
              <th style={TH}>Campaigns</th>
            </tr></thead>
            <tbody>
              {filteredCustomSegments.length===0&&(
                <tr><td colSpan={2+customDims.length+3} style={{padding:"32px 20px",textAlign:"center",color:T.textMuted,fontSize:13}}>No groups match your filters. <span onClick={clearSegFilters} style={{color:T.accent,cursor:"pointer",fontWeight:400}}>Clear filters</span></td></tr>
              )}
              {filteredCustomSegments.flatMap(seg=>{
                const isExpanded=breakdownDim&&expandedRows.has(seg.segKey);
                const rbb=`1px solid ${T.border}`;
                const parentRow=(
                  <tr key={seg.segKey} className="bhq-tr">
                    <td style={{padding:"8px 4px",borderBottom:rbb,textAlign:"center"}}>
                      {breakdownDim&&<button onClick={()=>toggleExpand(seg.segKey)} title={`Break down by ${breakdownDim}`}
                        style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11,padding:2,lineHeight:1,transform:isExpanded?"rotate(90deg)":"none",transition:"transform 0.12s"}}>▸</button>}
                    </td>
                    {seg.dims.map((v,i)=>{const dimMaxW=customDims[i]==="Product"?110:customDims[i]==="Module"?140:undefined;return(
                    <td key={i} style={{padding:"8px 14px",borderBottom:rbb,whiteSpace:"nowrap",...(dimMaxW?{maxWidth:dimMaxW,overflow:"hidden",textOverflow:"ellipsis"}:{})}}>
                      <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,borderRadius:6}}>{v}</Pill>
                    </td>);})}
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",color:T.text}}>{fmtFull(seg.spend)}</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",color:T.text}}>{fmtFull(seg.dailyRate)}/day</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right"}}>
                      <div style={{fontFamily:"'DM Sans',sans-serif",color:T.text,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                        {seg.projected!=null?fmtFull(seg.projected):"—"}
                        {seg.lowConfidencePlatforms?.length>0&&(
                          <WarnTip T={T} text={`Projection may be unreliable — ${seg.lowConfidencePlatforms.join(", ")} only has a single as-of data point for this period, so its spend is being extrapolated across every day instead of an actual daily rate.`}/>
                        )}
                      </div>
                    </td>
                    <td style={{padding:"8px 14px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",color:T.textMuted}}>{seg.campaignCount}</td>
                  </tr>
                );
                if(!isExpanded)return[parentRow];
                const breakdown=computeCustomBreakdown({mergedNormRows,tags:campaignTags,dims:customDims,segKey:seg.segKey,breakdownDim,start:customPacing.start,end:customPacing.end});
                const breakdownRows=breakdown.length===0?[
                  <tr key={seg.segKey+"-empty"}>
                    <td/>
                    <td colSpan={customDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:13,color:T.textMuted,fontStyle:"italic"}}>No spend in this period to break down by {breakdownDim}</td>
                    <td colSpan={3} style={{borderBottom:rbb}}/>
                  </tr>
                ]:breakdown.map(b=>(
                  <tr key={seg.segKey+"-"+b.value}>
                    <td/>
                    <td colSpan={customDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:13,color:T.textSub}}>↳ {b.value}</td>
                    <td style={{padding:"6px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>
                      {fmtFull(b.spend)}<span style={{color:T.textMuted,marginLeft:6,fontSize:13}}>({Math.round(b.pct*100)}%)</span>
                    </td>
                    <td colSpan={2} style={{borderBottom:rbb}}/>
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
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{fmtFull(ft.spend)}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{fmtFull(ft.dailyRate)}/day</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{ft.hasProjected?fmtFull(ft.projected):"—"}</td>
                    <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.textMuted}}>{ft.campaignCount}</td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
          </>
        ))}
        {viewMode==="trend"&&(!trendData||trendData.grandTotal===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:60,textAlign:"center"}}>
            <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6}}>No spend data in this range</div>
            <div style={{fontSize:13,color:T.textSub}}>{trendFilterDim?`Nothing matched "${trendFilterValue}" in ${trendFilterDim} between ${trendStartMonth} and ${trendEndMonth}.`:"Widen the date range, or check the filter above."}</div>
          </div>
        ):(
          <>
          <PixelPanel T={T} contentStyle={{padding:"18px 20px"}}>
            <TrendLineChart T={T} months={trendData.months} series={trendData.series}/>
            {trendData.series.length>0&&(
              <div style={{display:"flex",gap:14,flexWrap:"wrap",marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                {trendData.series.map((s,i)=>(
                  <div key={s.label} style={{display:"flex",alignItems:"center",gap:6,fontSize:12,fontFamily:"'DM Sans',sans-serif"}}>
                    <span style={{width:9,height:9,borderRadius:2,background:TREND_COLORS[i%TREND_COLORS.length],flexShrink:0}}/>
                    <span style={{color:T.text,fontWeight:600}}>{s.label}</span>
                    <span style={{color:T.textMuted}}>{fmtFull(s.total)} total</span>
                  </div>
                ))}
              </div>
            )}
          </PixelPanel>
          <table style={{borderCollapse:"collapse",minWidth:"100%",fontSize:13,marginTop:16,background:T.surface}}>
            <thead><tr>
              <th style={TH}>{trendSeriesDim||"Month"}</th>
              {trendData.months.map(m=><th key={m.key} style={TH}>{m.label}</th>)}
              <th style={TH}>Total</th>
            </tr></thead>
            <tbody>
              {trendData.series.map(s=>(
                <tr key={s.label} className="bhq-tr">
                  <td style={{padding:"8px 14px",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>
                    <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,borderRadius:6}}>{s.label}</Pill>
                  </td>
                  {s.values.map((v,i)=><td key={i} style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:"'DM Sans',sans-serif",color:T.text}}>{v>0?fmtFull(v):"—"}</td>)}
                  <td style={{padding:"8px 8px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{fmtFull(s.total)}</td>
                </tr>
              ))}
              <tr style={{borderTop:`2px solid ${T.border}`,background:T.surface}}>
                <td style={{padding:"10px 14px"}}><SectionLabel T={T} style={{marginBottom:0,color:T.text}}>Total</SectionLabel></td>
                {trendData.monthTotals.map((v,i)=><td key={i} style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{fmtFull(v)}</td>)}
                <td style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,color:T.text}}>{fmtFull(trendData.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
          </>
        ))}
      </div>
      {notif&&<div style={{position:"fixed",bottom:20,right:20,background:T.success,color:"#fff",padding:"10px 16px",borderRadius:8,fontSize:13,fontWeight:600,zIndex:100,boxShadow:T.shadowMd,fontFamily:"'DM Sans',sans-serif"}}>{notif}</div>}
    </div>
  );
}
