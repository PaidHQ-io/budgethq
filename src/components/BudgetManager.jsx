import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  buildCampaignPlatformIndex, countSegmentCampaigns, untagSegmentCampaigns, renameDimensionValue,
  campaignKey, parseMoney, fmtFull, fmt$, isMonthHdr, getMonthKey,
  parsePeriod, findFlatMonthlyCol, parseFileToRows, forwardFillGroups, downloadCSV,
  computeActualsByMonth, computePacing, pacingStatusMeta, MONTHS, QUARTERS,
} from "../lib/core.js";
import {
  SectionLabel, Pill, Btn, Inp, Sel, Tog, Chk, StatRow, Divider, Icon,
  PixelPanel, WarnTip, AISummaryCard,
} from "./shared.jsx";
import { useGoogleSheetConnect } from "../hooks/useGoogleSheetConnect.js";

// src/components/BudgetManager.jsx — Budget Panel tab (2026-07-25 split, per Mo: split the
// four tab components out of the BudgetHQ.jsx monolith into their own files so each tab's code
// can be lazy-loaded instead of every tab shipping in one bundle on every page load).

export default function BudgetManager({campaignTags,setTags,tagDimensions,T,onAddDimensions,budgets,setBudgets,budgetDims,setBudgetDims,budgetRowMeta,setBudgetRowMeta,budgetMetaDims,setBudgetMetaDims,budgetImportMeta,setBudgetImportMeta,defaultForecastModel,mergedNormRows,onCheckpoint,sidebarEl,canEdit=true}){
  const yr=new Date().getFullYear();
  const[year,setYear]=useState(yr.toString());
  const[showQ,setShowQ]=useState(false);
  const[showA,setShowA]=useState(false);
  // Persisted to localStorage (like the top-level view/askChats prefs) rather than plain useState
  // — BudgetManager itself now stays mounted across tab switches (see the display:none wrapper in
  // BudgetHQ's render), so this survives that on its own, but persisting it too means the toggle
  // also survives a hard page reload, matching how every other "which view mode am I in" pref in
  // the app behaves.
  const[showRollups,setShowRollups]=useState(()=>{try{return localStorage.getItem("paidhq_budget_show_rollups")==="1";}catch(e){return false;}});
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_show_rollups",showRollups?"1":"0");}catch(e){}},[showRollups]);
  // Same persistence pattern as showRollups. Filters segments marked "not budgeted" out of both
  // the detail grid and rollupTables (which is derived from filteredSegs) in one place.
  const[hideNotBudgeted,setHideNotBudgeted]=useState(()=>{try{return localStorage.getItem("paidhq_budget_hide_not_budgeted")==="1";}catch(e){return false;}});
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_hide_not_budgeted",hideNotBudgeted?"1":"0");}catch(e){}},[hideNotBudgeted]);
  // Per-table hide, on top of the master showRollups toggle above — that one is all-or-nothing;
  // this lets someone with several Budget By dimensions hide just the one or two rollup tables
  // they don't care about day-to-day (e.g. keep "By Channel" visible, hide "By Region") without
  // losing them entirely — "Show all" below brings every hidden one back in one click. Stores
  // dimension NAMES, not indexes, so it stays correct if Budget By dimensions are reordered.
  const[hiddenRollupDims,setHiddenRollupDims]=useState(()=>{
    try{const v=JSON.parse(localStorage.getItem("paidhq_budget_hidden_rollups")||"[]");return Array.isArray(v)?v:[];}catch{return [];}
  });
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_hidden_rollups",JSON.stringify(hiddenRollupDims));}catch{/* ignore */}},[hiddenRollupDims]);
  const hideRollupTable=useCallback(dim=>setHiddenRollupDims(p=>p.includes(dim)?p:[...p,dim]),[]);
  const showAllRollupTables=useCallback(()=>setHiddenRollupDims([]),[]);
  const[importOpen,setImportOpen]=useState(false);
  const[notif,setNotif]=useState(null);
  // Export preview — AI suggests which actual-spend granularity (monthly/quarterly) to append
  // based on how the original budget file for this year was structured, user can override before
  // downloading.
  const[exportPreviewOpen,setExportPreviewOpen]=useState(false);
  const[exportAnalyzing,setExportAnalyzing]=useState(false);
  const[exportAiReason,setExportAiReason]=useState("");
  const[exportAiError,setExportAiError]=useState("");
  const[exportIncludeMonthly,setExportIncludeMonthly]=useState(false);
  const[exportIncludeQuarterly,setExportIncludeQuarterly]=useState(false);
  // Merge review — when a re-import maps MORE dimensions than the year's existing budgets used
  // (e.g. adding "BU" on top of an already-imported Product Pillar/Product structure), the new
  // segKeys won't match the old ones and would otherwise just pile up as parallel duplicate rows.
  // Exact-projection matches are found locally for free; AI is only called to catch fuzzy/near
  // matches (spelling, whitespace) among whatever's left unresolved.
  const[mergeReviewOpen,setMergeReviewOpen]=useState(false);
  const[importAnalyzing,setImportAnalyzing]=useState(false);
  const[mergeAiError,setMergeAiError]=useState("");
  const[mergeCandidates,setMergeCandidates]=useState([]); // [{newSegKey,oldSegKey,newLabel,oldLabel,confidence,reason,approved}]
  const pendingImportRef=useRef(null); // {oldBudgetDims,newActiveDims} captured at beginImport time
  // Dims-contracted warning — shown instead of merge review when this import maps FEWER
  // dimensions than the year already tracks (no safe auto-merge, so just warn + let user decide).
  const[contractionWarningOpen,setContractionWarningOpen]=useState(false);
  const[contractionInfo,setContractionInfo]=useState([]); // [{newSegKey,newLabel,matchCount,examples}]
  const[contractionNewDims,setContractionNewDims]=useState([]); // this import's active dims — for display only, kept in state (not read from the ref) since refs can't be read during render
  // Budget row tagging
  const[selRows,setSelRows]=useState(new Set());
  const[segFilters,setSegFilters]=useState({}); // {dim: filterText} — substring match, ANDed across dims
  const[applyMetaDim,setApplyMetaDim]=useState("");
  const[applyMetaVal,setApplyMetaVal]=useState("");
  const[editingMeta,setEditingMeta]=useState(null); // {segKey, dim}
  const[editMetaVal,setEditMetaVal]=useState("");
  const[newMetaDim,setNewMetaDim]=useState("");
  const[editingSegVal,setEditingSegVal]=useState(null); // {segKey, dim}
  const[editSegVal,setEditSegVal]=useState("");

  // Import state
  const[iStep,setIStep]=useState("upload");
  const[iYear,setIYear]=useState(yr.toString());
  const[iFileName,setIFileName]=useState("");
  const[iRawRows,setIRawRows]=useState([]); // array of arrays (all rows)
  const[iHeaderRow,setIHeaderRow]=useState(0); // 0-based index of header row
  const[iSkipStr,setISkipStr]=useState("total");
  const[iHeaders,setIHeaders]=useState([]);
  const[iRows,setIRows]=useState([]); // processed rows as objects
  const[iFmt,setIFmt]=useState("wide");
  const[iSegDim,setISegDim]=useState("Campaign"); // dimension name for transposed format
  const[iGroupHeaderRow,setIGroupHeaderRow]=useState(-1); // -1 = none, otherwise row index
  const[iGroupDim,setIGroupDim]=useState("Channel"); // dimension name for group header row
  const[dimMap,setDimMap]=useState({});
  const[periodCol,setPeriodCol]=useState("");
  const[amtCol,setAmtCol]=useState("");
  const[iFlatMonths,setIFlatMonths]=useState([]); // for "flat" format: which month(s) the recurring amount applies to
  const[preview,setPreview]=useState([]);
  const[customDims,setCustomDims]=useState([]); // [{name,col}] — new dims created during import
  const[aiAnalyzing,setAiAnalyzing]=useState(false);
  const[aiError,setAiError]=useState("");
  const fileRef=useRef();
  const years=[(yr-1).toString(),yr.toString(),(yr+1).toString()];
  // Screenshot import — same downstream pipeline (header-row picker → dimension mapping → AI
  // analysis → preview → merge review) as a CSV/XLSX upload, just fed by vision-transcribed grid
  // data instead of Papa.parse/XLSX.utils output. See ingestRawRows below.
  const[screenshotImporting,setScreenshotImporting]=useState(false);
  const[screenshotImportError,setScreenshotImportError]=useState("");
  const screenshotFileRef=useRef();

  const showNotif=msg=>{setNotif(msg);setTimeout(()=>setNotif(null),3000);};

  const[showAddRow,setShowAddRow]=useState(false);
  const[newRowVals,setNewRowVals]=useState({});

  // See buildCampaignPlatformIndex's doc comment — needed anywhere budgetDims might include
  // "Platform", since that value is never actually stored in campaignTags.
  const platformIndex=useMemo(()=>buildCampaignPlatformIndex(mergedNormRows),[mergedNormRows]);
  const platformValues=useMemo(()=>[...new Set(Object.values(platformIndex))].sort((a,b)=>a.localeCompare(b)),[platformIndex]);

  const segMatchCount=useCallback(segKey=>countSegmentCampaigns(campaignTags,budgetDims,segKey,platformIndex),[budgetDims,campaignTags,platformIndex]);

  const addManualRow=()=>{
    if(!canEdit)return;
    const vals=budgetDims.map(d=>newRowVals[d]||"");
    if(vals.some(v=>!v.trim()))return;
    const key=vals.join("|");
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][key])nx[year][key]={monthly:{}};return nx;});
    setShowAddRow(false);setNewRowVals({});
  };

  // Export = original budget grid, unchanged, PLUS actual-spend data appended as new columns
  // to the right (same segment rows, same order) — never touches the existing columns, so a
  // re-import of this same export still round-trips cleanly. The annual pacing snapshot (actual
  // spend to date, % of budget used, run rate, projected year-end spend + variance, and pacing
  // status — mirroring exactly what the Reporting tab computes via computePacing()) is always
  // included. Monthly and/or quarterly actual-spend breakdown blocks are optional, controlled by
  // the export-preview modal's granularity choice (which the AI suggestion pre-fills based on
  // whether the originally-imported file for this year had quarterly/annual total columns).
  const exportBudgets=({includeMonthly=false,includeQuarterly=false}={})=>{
    const pacing=computePacing({mergedNormRows:mergedNormRows||[],tags:campaignTags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date(),budgetRowMeta,defaultForecastModel});
    const pacingBySeg={};
    pacing.segments.forEach(s=>{pacingBySeg[s.segKey]=s;});
    const actualsByMonth=(includeMonthly||includeQuarterly)?computeActualsByMonth({mergedNormRows:mergedNormRows||[],tags:campaignTags,budgetDims,year}):{};
    const header=[...budgetDims,...budgetMetaDims,...MONTHS.map(m=>m.label),"Total",
      ...(includeMonthly?MONTHS.map(m=>`${m.label} Actual`):[]),
      ...(includeQuarterly?QUARTERS.map(q=>`${q.key} Actual`):[]),
      "Actual Spend","% of Budget Used","Daily Run Rate","Projected Year-End Spend","Projected Variance ($)","Pacing Status"];
    const rows=[header];
    segs.forEach(seg=>{
      const monthly=budgets[year]?.[seg.key]?.monthly||{};
      const meta=budgetRowMeta[seg.key]||{};
      const amts=MONTHS.map(m=>monthly[m.key]||"");
      const total=MONTHS.reduce((s,m)=>s+(monthly[m.key]||0),0);
      const segActuals=actualsByMonth[seg.key]||{};
      const monthlyActualCols=includeMonthly?MONTHS.map(m=>Math.round((segActuals[m.key]||0)*100)/100):[];
      const quarterlyActualCols=includeQuarterly?QUARTERS.map(q=>Math.round(q.months.reduce((s,mk)=>s+(segActuals[mk]||0),0)*100)/100):[];
      const p=pacingBySeg[seg.key];
      const pacingCols=[
        p?Math.round(p.spend*100)/100:0,
        p&&p.actualPct!=null?`${Math.round(p.actualPct*100)}%`:"—",
        p?Math.round(p.dailyRate*100)/100:0,
        p&&p.projected!=null?Math.round(p.projected*100)/100:"—",
        p&&p.projectedVariance!=null?Math.round(p.projectedVariance*100)/100:"—",
        p?pacingStatusMeta(p.status,T).label:pacingStatusMeta("no-budget",T).label,
      ];
      rows.push([...budgetDims.map(d=>seg[d]),...budgetMetaDims.map(d=>meta[d]||""),...amts,total||"",...monthlyActualCols,...quarterlyActualCols,...pacingCols]);
    });
    downloadCSV(rows,`budgethq-budgets-pacing-${year}.csv`);
    showNotif("Budgets + pacing snapshot exported");
  };

  // Opens the export-preview modal and asks the AI to recommend a granularity based on how the
  // originally-imported file for this year was shaped (captured at import time in
  // budgetImportMeta). Falls back to a plain structural default (no LLM call needed) if the
  // request fails, so a flaky/unconfigured AI backend never blocks the export itself.
  const openExportPreview=async()=>{
    // budgetImportMeta only has an entry for years that were imported (or re-imported) AFTER
    // this capture step existed — years synced live from an ad platform, or imported before this
    // feature shipped, have no entry at all. That's a genuinely different state from "we checked
    // and confirmed there's no quarterly/annual columns" and the prompt below must say so — the
    // AI can only report false certainty about a file's structure if we hand it false certainty.
    const importMeta=budgetImportMeta?.[year];
    const structureKnown=!!importMeta;
    setExportPreviewOpen(true);setExportAnalyzing(true);setExportAiError("");setExportAiReason("");
    const fallback=()=>{setExportIncludeMonthly(!structureKnown);setExportIncludeQuarterly(!!importMeta?.hasQuarterlyTotals);};
    try{
      const structureDesc=!structureKnown
        ?"This year's original import structure wasn't recorded — either it predates this feature, or the data came from a live platform sync rather than a file import — so it's unknown whether the source had quarterly or annual subtotal columns."
        :`Their original budget file for ${year} was ${importMeta.hasQuarterlyTotals?"structured with quarterly subtotal columns (Q1-Q4) alongside monthly columns":"structured with monthly columns only, no quarterly subtotal columns detected"}, and ${importMeta.hasAnnualTotal?"had an annual total column":"had no annual total column detected"}.`;
      const prompt=`A user is exporting a budget-vs-actual report from a paid media budgeting tool. ${structureDesc} There are ${segs.length} budget segment rows, tracked by: ${budgetDims.join(", ")||"(no dimensions set)"}.\n\nThe export always includes an annual actual-spend/projection summary. Recommend whether to ALSO append a month-by-month actual-spend breakdown and/or a quarter-by-quarter actual-spend breakdown, to mirror how this user already organizes their budget file. If the original structure is unknown, default to recommending the monthly breakdown (the safer, more granular option) and say so.\n\nReply ONLY with this JSON (no markdown): {"includeMonthly": true/false, "includeQuarterly": true/false, "reason": "<one short sentence explaining the recommendation>"}`;
      const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt,maxTokens:300})});
      const data=await res.json();
      if(!res.ok)throw new Error(data?.error||"AI suggestion request failed");
      const result=JSON.parse((data.text||"").replace(/```json|```/g,"").trim());
      setExportIncludeMonthly(!!result.includeMonthly);
      setExportIncludeQuarterly(!!result.includeQuarterly);
      setExportAiReason(result.reason||"");
    }catch(e){
      console.error("[export AI suggestion]",e);
      setExportAiError(`AI suggestion unavailable (${e.message||"unknown error"}) — defaulted based on your file's structure. You can still adjust below.`);
      fallback();
    }finally{setExportAnalyzing(false);}
  };
  const confirmExport=()=>{
    exportBudgets({includeMonthly:exportIncludeMonthly,includeQuarterly:exportIncludeQuarterly});
    setExportPreviewOpen(false);
  };

  // Budget row tagging
  const toggleRowSel=key=>setSelRows(p=>{const nx=new Set(p);nx.has(key)?nx.delete(key):nx.add(key);return nx;});
  const selAllRows=()=>setSelRows(selRows.size===filteredSegs.length?new Set():new Set(filteredSegs.map(s=>s.key)));
  const applyMetaToSelected=()=>{
    if(!canEdit)return;
    if(!applyMetaDim||!applyMetaVal||!selRows.size)return;
    setBudgetRowMeta(p=>{const nx={...p};selRows.forEach(k=>{nx[k]={...(nx[k]||{}),[applyMetaDim]:applyMetaVal};});return nx;});
    showNotif(`Tagged ${selRows.size} rows — ${applyMetaDim}: ${applyMetaVal}`);
    setSelRows(new Set());setApplyMetaVal("");
  };
  const saveMetaEdit=()=>{
    if(!canEdit)return;
    if(!editingMeta)return;
    const trimmed=editMetaVal.trim();
    setBudgetRowMeta(p=>{const nx={...p};const ts={...(nx[editingMeta.segKey]||{})};if(trimmed)ts[editingMeta.dim]=trimmed;else delete ts[editingMeta.dim];nx[editingMeta.segKey]=ts;return nx;});
    setEditingMeta(null);setEditMetaVal("");
  };
  const addMetaDim=()=>{
    if(!canEdit)return;
    const d=newMetaDim.trim();
    if(!d||budgetMetaDims.includes(d))return;
    setBudgetMetaDims(p=>[...p,d]);setNewMetaDim("");
    showNotif(`Added dimension: ${d}`);
  };

  const saveSegEdit=()=>{
    if(!canEdit)return;
    if(!editingSegVal)return;
    const trimmed=editSegVal.trim();
    if(!trimmed){setEditingSegVal(null);setEditSegVal("");return;}
    const{segKey,dim}=editingSegVal;
    const seg=segs.find(s=>s.key===segKey);
    if(!seg||seg[dim]===trimmed){setEditingSegVal(null);setEditSegVal("");return;}
    const oldVal=seg[dim];
    const newKey=budgetDims.map(d=>d===dim?trimmed:seg[d]).join("|");
    // Renames everywhere — budgets across all years, budgetRowMeta, and any campaign tagged
    // with the old value — so the segment reconnects to real spend, not just relabels a row.
    const result=renameDimensionValue({budgets,budgetRowMeta,tags:campaignTags,budgetDims,dim,oldVal,newVal:trimmed});
    setBudgets(result.budgets);
    setBudgetRowMeta(result.budgetRowMeta);
    setTags?.(result.tags);
    setSelRows(p=>{const nx=new Set(p);if(nx.has(segKey)){nx.delete(segKey);nx.add(newKey);}return nx;});
    showNotif(`Renamed "${oldVal}" → "${trimmed}" — updated budgets and tagged campaigns`);
    setEditingSegVal(null);setEditSegVal("");
  };

  const deleteRow=(segKey,label)=>{
    if(!canEdit)return;
    const matchCount=countSegmentCampaigns(campaignTags,budgetDims,segKey,platformIndex);
    const tagNote=matchCount>0?` This also un-tags ${matchCount} matching campaign${matchCount>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete "${label}"?\n\nThis removes all monthly budget values for this row.${tagNote}`))return;
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(nx[year])delete nx[year][segKey];return nx;});
    setBudgetRowMeta(p=>{const nx={...p};delete nx[segKey];return nx;});
    setTags?.(p=>untagSegmentCampaigns(p,budgetDims,segKey,platformIndex));
    setSelRows(p=>{const nx=new Set(p);nx.delete(segKey);return nx;});
    showNotif(matchCount>0?`Row deleted — un-tagged ${matchCount} campaign${matchCount>1?"s":""}`:"Row deleted");
  };
  // "Not budgeted" — an explicit, per-segment flag distinct from just having $0 in every month.
  // Every unique combination tagged in the Tagger auto-appears here as a segment row (by design,
  // so nothing tagged silently goes unbudgeted) — but some of those combinations legitimately
  // never need a budget (test campaigns, parked segments, etc). Marking one here is a deliberate
  // "I looked at this, it doesn't need a budget" decision that persists, as opposed to a session-
  // only display filter that can't distinguish "not budgeted yet" from "never will be." Stored as
  // an underscore-prefixed key inside budgetRowMeta (same object/save-path as annotation
  // dimensions like Region/Pillar) so it doesn't need its own schema field — it's never added to
  // budgetMetaDims, so it never renders as a column.
  const isNotBudgeted=segKey=>!!(budgetRowMeta[segKey]||{})._notBudgeted;
  const toggleNotBudgeted=segKey=>{
    if(!canEdit)return;
    setBudgetRowMeta(p=>{
      const nx={...p};
      const cur={...(nx[segKey]||{})};
      if(cur._notBudgeted)delete cur._notBudgeted;else cur._notBudgeted=true;
      nx[segKey]=cur;
      return nx;
    });
  };
  // Per-segment forecast model (full-period/committed/trailing-N) lives in the Reporting & Pacing
  // tab now, not here — see PacingDashboard's getForecastModel/setForecastModel. Per Mo: choosing
  // HOW a segment's spend should be projected belongs where pacing/projections are actually
  // viewed and acted on, not in the Budget Panel where you're just setting $ allocations. Budget
  // Panel still only owns _notBudgeted (isNotBudgeted/toggleNotBudgeted above) since that's a
  // budget-setup concept, not a projection one. budgetRowMeta itself is unchanged — it's the same
  // shared object either UI reads/writes, just no picker rendered here anymore.
  const bulkDeleteSelected=()=>{
    if(!canEdit)return;
    if(!selRows.size)return;
    const n=selRows.size;
    const totalMatches=[...selRows].reduce((s,k)=>s+countSegmentCampaigns(campaignTags,budgetDims,k,platformIndex),0);
    const tagNote=totalMatches>0?` This also un-tags ${totalMatches} matching campaign${totalMatches>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete ${n} segment${n>1?"s":""}?\n\nThis removes all monthly budget values for ${n>1?"these rows":"this row"}.${tagNote}`))return;
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(nx[year])selRows.forEach(k=>{delete nx[year][k];});return nx;});
    setBudgetRowMeta(p=>{const nx={...p};selRows.forEach(k=>delete nx[k]);return nx;});
    setTags?.(p=>{let nt=p;selRows.forEach(k=>{nt=untagSegmentCampaigns(nt,budgetDims,k,platformIndex);});return nt;});
    showNotif(`Deleted ${n} segment${n>1?"s":""}${totalMatches>0?` — un-tagged ${totalMatches} campaign${totalMatches>1?"s":""}`:""}`);
    setSelRows(new Set());
  };

  const segs=useMemo(()=>{
    if(!budgetDims.length)return[];
    const seen=new Set();const out=[];
    // Source 1: every campaign that's ever had spend data, tagged or not — a segment auto-appears
    // once ALL budgetDims resolve to a real value for it (manual tags for ordinary dimensions,
    // derived automatically via platformIndex for "Platform"), same "nothing spending silently
    // goes unbudgeted" principle as before, now true whether or not any manual tagging happened.
    const seenCampaigns=new Set();
    (mergedNormRows||[]).forEach(row=>{
      const ck=campaignKey(row.campaign_group_name,row.campaign_name);
      if(seenCampaigns.has(ck))return;
      seenCampaigns.add(ck);
      const t=campaignTags[ck]||{};
      const vals=budgetDims.map(d=>d==="Platform"?(platformIndex[ck]||""):t[d]);
      if(vals.some(v=>!v))return;
      const key=vals.join("|");
      if(!seen.has(key)){seen.add(key);const c={key};budgetDims.forEach((d,i)=>{c[d]=vals[i];});out.push(c);}
    });
    // Source 2: imported budget data (so imported budgets show even if not yet tagged)
    if(budgets[year]){
      Object.keys(budgets[year]).forEach(key=>{
        if(seen.has(key))return;
        const vals=key.split("|");
        if(vals.length!==budgetDims.length)return;
        seen.add(key);const c={key};
        budgetDims.forEach((d,i)=>{c[d]=vals[i]||"—";});
        out.push(c);
      });
    }
    return out.sort((a,b)=>a.key.localeCompare(b.key));
  },[budgetDims,campaignTags,budgets,year,mergedNormRows,platformIndex]);

  // Segments filtered by per-dimension substring match (ANDed) — drives what's visible,
  // what "select all" selects, and what a bulk delete targets. Covers both the primary
  // budgetDims (e.g. Product, stored on the segment itself) and any annotation dimensions
  // added as budgetMetaDims (e.g. Region, Pillar, Funnel — stored in budgetRowMeta per segment).
  const filteredSegs=useMemo(()=>segs.filter(seg=>{
    const meta=budgetRowMeta[seg.key]||{};
    if(hideNotBudgeted&&meta._notBudgeted)return false;
    return budgetDims.every(d=>{
      const f=(segFilters[d]||"").trim().toLowerCase();
      return!f||(seg[d]||"").toLowerCase().includes(f);
    })&&budgetMetaDims.every(d=>{
      const f=(segFilters[d]||"").trim().toLowerCase();
      return!f||(meta[d]||"").toLowerCase().includes(f);
    });
  }),[segs,budgetDims,budgetMetaDims,budgetRowMeta,segFilters,hideNotBudgeted]);
  const hasSegFilters=Object.values(segFilters).some(v=>(v||"").trim());
  const clearSegFilters=()=>setSegFilters({});

  const getMV=useCallback((sk,mk)=>budgets[year]?.[sk]?.monthly?.[mk]??"",[budgets,year]);
  const getQC=useCallback((sk,qk)=>budgets[year]?.[sk]?.quarterly?.[qk]??"",[budgets,year]);
  const getAC=useCallback(sk=>budgets[year]?.[sk]?.annual??"",[budgets,year]);
  const setMV=useCallback((sk,mk,v)=>{if(!canEdit)return;const n=parseMoney(v);setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][sk])nx[year][sk]={};if(!nx[year][sk].monthly)nx[year][sk].monthly={};if(n===null)delete nx[year][sk].monthly[mk];else nx[year][sk].monthly[mk]=n;return nx;});},[year,canEdit]);
  const setQC=useCallback((sk,qk,v)=>{if(!canEdit)return;const n=parseMoney(v);setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][sk])nx[year][sk]={};if(!nx[year][sk].quarterly)nx[year][sk].quarterly={};if(n===null)delete nx[year][sk].quarterly[qk];else nx[year][sk].quarterly[qk]=n;return nx;});},[year,canEdit]);
  const setAC=useCallback((sk,v)=>{if(!canEdit)return;const n=parseMoney(v);setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][sk])nx[year][sk]={};if(n===null)delete nx[year][sk].annual;else nx[year][sk].annual=n;return nx;});},[year,canEdit]);
  const rowTotal=useCallback(sk=>Object.values(budgets[year]?.[sk]?.monthly||{}).reduce((s,v)=>s+(v||0),0),[budgets,year]);
  const qTotal=useCallback((sk,q)=>q.months.reduce((s,m)=>s+(budgets[year]?.[sk]?.monthly?.[m]||0),0),[budgets,year]);
  const qOver=useCallback((sk,q)=>{const c=parseMoney(getQC(sk,q.key));return c!==null&&qTotal(sk,q)>c;},[getQC,qTotal]);
  const aOver=useCallback(sk=>{const c=parseMoney(getAC(sk));return c!==null&&rowTotal(sk)>c;},[getAC,rowTotal]);
  const totalY=useMemo(()=>segs.reduce((s,sg)=>s+rowTotal(sg.key),0),[segs,rowTotal]);
  const dimCount=d=>d==="Platform"?platformValues.length:[...new Set(Object.values(campaignTags||{}).map(t=>t[d]).filter(Boolean))].length;
  const toggleDim=d=>{if(!canEdit)return;setBudgetDims(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d]);};
  const dcw=130;

  // Rollup: budgets summed by ONE dimension at a time (e.g. Channel alone, ignoring Region and
  // Segment), computed live from the already-loaded filteredSegs/budgets data. Deliberately NOT
  // implemented by unchecking dimensions in "Budget By" above — that changes budgetDims, which
  // changes the segKey grain budgets are actually stored under, and would make existing imported
  // budgets stop matching their keys entirely. This is purely a display-time aggregation.
  const rollupTables=useMemo(()=>{
    return budgetDims.map(dim=>{
      const byVal={};
      filteredSegs.forEach(seg=>{
        const v=seg[dim]||"—";
        if(!byVal[v])byVal[v]={value:v,months:{},total:0};
        MONTHS.forEach(m=>{
          const amt=getMV(seg.key,m.key);
          if(amt!==""&&amt!=null){byVal[v].months[m.key]=(byVal[v].months[m.key]||0)+(parseFloat(amt)||0);}
        });
        byVal[v].total+=rowTotal(seg.key);
      });
      const rows=Object.values(byVal).sort((a,b)=>b.total-a.total);
      return{dim,rows,total:rows.reduce((s,r)=>s+r.total,0)};
    });
  },[budgetDims,filteredSegs,getMV,rowTotal]);

  // Build processed rows from selected header row
  const processRows=useCallback((rawRows,headerRowIdx,skipStr)=>{
    if(!rawRows.length||headerRowIdx>=rawRows.length)return{headers:[],rows:[]};
    const headers=rawRows[headerRowIdx].map(h=>String(h||"").trim()).filter(h=>h);
    const rows=rawRows.slice(headerRowIdx+1)
      .filter(row=>{
        if(!row||row.every(v=>!String(v).trim()))return false;
        if(skipStr){const rs=row.join(" ").toLowerCase();if(rs.includes(skipStr.toLowerCase()))return false;}
        return true;
      })
      .map(row=>{
        const obj={};
        headers.forEach((h,i)=>{obj[h]=String(row[i]||"").trim();});
        return obj;
      });
    return{headers,rows};
  },[]);

  // Shared entry point for both a parsed CSV/XLSX file and a vision-transcribed screenshot —
  // either way we end up with the same raw 2D grid shape, so everything past this point (header
  // row detection, dimension mapping, AI column analysis, preview, merge review) is identical.
  const ingestRawRows=(fileName,rawRows)=>{
    setIFileName(fileName);
    setIRawRows(rawRows);
    // Auto-detect header row: first row where >2 cells have content, PREFERRING one that
    // contains recognizable month headers if any candidate does. Plain CSV/XLSX exports of a
    // merged "year spanning 12 month columns" cell only store the year in one cell, so that row
    // naturally has few filled cells and the real month-name row below it wins on its own. A
    // screenshot has no cell-merge data though — a vision transcription of that same merged label
    // is prone to repeating "2026" under every column it visually spans, making that row look
    // fully filled and get picked first, which then makes month-column detection (isMonthHdr)
    // find nothing and silently produce 0 imported rows. Preferring a month-header candidate row
    // when one exists fixes that case without changing behavior for files that never have one.
    let headerIdx=0;
    const candidates=[];
    for(let i=0;i<Math.min(rawRows.length,10);i++){
      const filled=rawRows[i].filter(v=>String(v||"").trim()).length;
      if(filled>2)candidates.push(i);
    }
    if(candidates.length){
      const withMonths=candidates.find(i=>rawRows[i].filter(v=>isMonthHdr(String(v||""))).length>=2);
      headerIdx=withMonths!==undefined?withMonths:candidates[0];
    }
    setIHeaderRow(headerIdx);
    setIStep("header");
  };
  // Google Sheets manual connect — same downstream pipeline as the file/screenshot imports above,
  // fed by a live fetch of the sheet's grid instead. Connection logic itself lives in the shared
  // useGoogleSheetConnect hook (see its doc comment) — this just feeds the fetched grid straight
  // into ingestRawRows, the exact same entry point a file upload uses. Declared here (after
  // ingestRawRows, not up near the other useRef/useState declarations above) so the closure below
  // doesn't reference ingestRawRows before it's been declared in this same component body.
  // Deliberately a plain inline function, NOT useCallback — the hook's onGridRef always captures
  // whichever version ran most recently (see its doc comment), so this can safely close over
  // ingestRawRows (itself redefined every render, same reasoning) without going stale.
  const gsBudget=useGoogleSheetConnect((grid,tabTitle)=>{ingestRawRows(tabTitle,grid);});
  const handleImportFile=file=>{
    if(!file)return;
    parseFileToRows(file,rawRows=>ingestRawRows(file.name,rawRows));
  };
  // Sends the screenshot to Claude (vision, via /api/analyze) with instructions to transcribe the
  // visible table into a raw 2D grid — literally, no interpretation — then hands that grid to the
  // exact same ingestRawRows() pipeline a CSV/XLSX upload uses. This is deliberately NOT a second
  // "guess the budget structure" AI path — reusing the existing header-row picker + "Analyze with
  // AI" column-mapping step means a screenshot import gets the same review/correction opportunity
  // a file upload does, rather than silently trusting two AI passes stacked on top of each other.
  const handleImportScreenshot=file=>{
    if(!file)return;
    setScreenshotImportError("");setScreenshotImporting(true);
    const reader=new FileReader();
    reader.onload=async e=>{
      try{
        const dataUrl=String(e.target.result||"");
        const m=dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if(!m)throw new Error("Could not read image file");
        const[,mediaType,base64]=m;
        const prompt=`You are transcribing a table from a screenshot of a spreadsheet (Google Sheets, Excel, or similar) into raw grid data — a budget breakdown by some set of dimensions (e.g. Product, Region) and time period (e.g. monthly columns).\n\nLook at the image and transcribe EVERY visible row and column exactly as shown, including header rows, group/category header rows, and blank cells (use "" for empty cells). Preserve the exact left-to-right column order and top-to-bottom row order — do not summarize, merge, reformat, or interpret the data in any way, just transcribe each cell's visible text literally, the same way an export of this exact table to CSV would look.\n\nReturn ONLY a JSON array of arrays of strings — one inner array per row, one string per cell, all rows the same length (pad short rows with "") — no markdown fences, no explanation.`;
        const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
          messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mediaType,data:base64}},{type:"text",text:prompt}]}],
          maxTokens:4000,
        })});
        const data=await res.json();
        if(!res.ok)throw new Error(data?.error||"Screenshot analysis failed");
        const parsed=JSON.parse((data.text||"[]").replace(/```json|```/g,"").trim());
        if(!Array.isArray(parsed)||!parsed.length)throw new Error("Couldn't read a table from that screenshot — try a clearer image or a wider crop.");
        const rawRows=parsed.map(row=>Array.isArray(row)?row.map(v=>String(v??"")):[String(row??"")]);
        ingestRawRows(file.name,rawRows);
      }catch(err){
        setScreenshotImportError(err.message);
      }finally{
        setScreenshotImporting(false);
      }
    };
    reader.onerror=()=>{setScreenshotImportError("Could not read image file");setScreenshotImporting(false);};
    reader.readAsDataURL(file);
  };
  // Clipboard paste (Ctrl/Cmd+V) support — only acts while the import modal is open on its
  // upload step, mirroring the same "only intercept when the clipboard actually has an image"
  // safety as the Tagger's paste handler, so pasting text elsewhere in the app is never affected.
  useEffect(()=>{
    if(!importOpen||iStep!=="upload")return;
    const handler=e=>{
      const items=e.clipboardData?.items;
      if(!items)return;
      const imageItem=Array.from(items).find(it=>it.type&&it.type.startsWith("image/"));
      if(!imageItem)return;
      const file=imageItem.getAsFile();
      if(!file)return;
      e.preventDefault();
      handleImportScreenshot(file);
    };
    document.addEventListener("paste",handler);
    return()=>document.removeEventListener("paste",handler);
  },[importOpen,iStep]);

  const applyHeaderRow=()=>{
    const{headers,rows}=processRows(iRawRows,iHeaderRow,iSkipStr);
    setIHeaders(headers);setIRows(rows);
    // Detect format: wide (months as cols), transposed (months as rows), flat (one recurring
    // monthly amount, no named months/period col), long (period+amount cols)
    const monthColCount=headers.filter(h=>isMonthHdr(h)).length;
    const firstColPeriods=rows.slice(0,6).filter(r=>parsePeriod(String(r[headers[0]]||""))).length;
    const flatMonthlyCol=findFlatMonthlyCol(headers);
    let fmt="long";
    if(monthColCount>=3) fmt="wide";
    else if(firstColPeriods>=2) fmt="transposed";
    else if(flatMonthlyCol) fmt="flat";
    setIFmt(fmt);
    // Auto-map existing dimensions
    const am={};(tagDimensions||[]).forEach(d=>{const m=headers.find(h=>h.toLowerCase()===d.toLowerCase()||h.toLowerCase().includes(d.toLowerCase()));if(m)am[d]=m;});
    setDimMap(am);
    if(fmt==="long"){setPeriodCol(headers.find(h=>/month|period|date/i.test(h))||"");setAmtCol(headers.find(h=>/budget|amount|spend|cost/i.test(h))||"");}
    else if(fmt==="flat"){setAmtCol(flatMonthlyCol||"");setIFlatMonths(MONTHS.map(m=>m.key));}
    setIStep("map");
  };

  // Reorders {dim,...} pairs so dimensions already established in budgetDims keep their
  // existing position — guaranteeing a repeat import of the same segment/period/year produces
  // the identical segKey and overwrites instead of appending a duplicate row. Brand-new
  // dimensions (not yet in budgetDims) are ordered alphabetically for determinism, since their
  // order otherwise depends on ad hoc mapping order (manual clicks, or AI analysis, which can
  // vary import to import).
  const canonicalDims=useCallback(rawDims=>{
    return[...rawDims].sort((a,b)=>{
      const ai=budgetDims.indexOf(a.dim),bi=budgetDims.indexOf(b.dim);
      if(ai!==-1&&bi!==-1)return ai-bi;
      if(ai!==-1)return-1;
      if(bi!==-1)return 1;
      return a.dim.localeCompare(b.dim);
    });
  },[budgetDims]);

  const buildPreview=useCallback(()=>{
    const entries=[];
    const rawDims=[
      ...(tagDimensions||[]).filter(d=>dimMap[d]).map(d=>({dim:d,col:dimMap[d]})),
      ...customDims.filter(c=>c.name&&c.col).map(c=>({dim:c.name,col:c.col})),
    ];
    const activeDims=canonicalDims(rawDims);
    if(iFmt==="wide"){
      const mc=iHeaders.filter(h=>isMonthHdr(h));
      iRows.forEach(row=>{
        // Trimmed so stray leading/trailing whitespace in a dimension value (a spreadsheet that
        // exports slightly differently between two pulls of "the same" file is a common source of
        // this) doesn't produce a segKey that looks new instead of matching the existing segment —
        // see consolidateBudgetSegKeys's doc comment for the duplication this otherwise causes.
        const sp=activeDims.map(d=>({dim:d.dim,val:String(row[d.col]??"").trim()}));
        if(sp.some(p=>!p.val))return;
        const sk=sp.map(p=>p.val).join("|");
        mc.forEach(col=>{const mk=getMonthKey(col);const amt=parseMoney(row[col]);if(mk&&amt!==null&&amt>0)entries.push({segKey:sk,dims:Object.fromEntries(sp.map(p=>[p.dim,p.val])),monthKey:mk,amount:amt});});
      });
    }else if(iFmt==="transposed"){
      const skipPat=/(total|quarterly|last.updated|#ref)/i;
      const periodColKey=iHeaders[0];
      const segCols=iHeaders.slice(1).filter(h=>h&&!skipPat.test(h));
      const dimName=iSegDim||"Campaign";
      // Build group values if group header row is set
      let groupValues=null;
      if(iGroupHeaderRow>=0&&iRawRows[iGroupHeaderRow]){
        const filled=forwardFillGroups(iRawRows[iGroupHeaderRow]);
        groupValues={};
        iHeaders.forEach((h,i)=>{groupValues[h]=filled[i]||"";});
      }
      iRows.forEach(row=>{
        const mk=parsePeriod(String(row[periodColKey]||""));
        if(!mk)return;
        segCols.forEach(col=>{
          const amt=parseMoney(String(row[col]||"").replace(/#REF!/g,""));
          if(amt!==null&&amt>0){
            const groupVal=groupValues?groupValues[col]:"";
            const dims=groupVal?{[iGroupDim||"Channel"]:groupVal,[dimName]:col}:{[dimName]:col};
            const sk=groupVal?[groupVal,col].join("|"):col;
            entries.push({segKey:sk,dims,monthKey:mk,amount:amt});
          }
        });
      });
    }else if(iFmt==="flat"){
      // No named months, no period column — just one recurring monthly amount per segment. The
      // secondary "Quarterly Budget"-style column, if any, is intentionally not imported — it's
      // redundant with Monthly×3. Which month(s) the amount actually gets written into is the
      // user's call (iFlatMonths, picked in the map step) rather than always assuming the full
      // year — e.g. a new client starting in July shouldn't get Jan–Jun back-filled. The user can
      // still hand-adjust any individual month afterward in the Budget Panel grid.
      iRows.forEach(row=>{
        // Trimmed so stray leading/trailing whitespace in a dimension value (a spreadsheet that
        // exports slightly differently between two pulls of "the same" file is a common source of
        // this) doesn't produce a segKey that looks new instead of matching the existing segment —
        // see consolidateBudgetSegKeys's doc comment for the duplication this otherwise causes.
        const sp=activeDims.map(d=>({dim:d.dim,val:String(row[d.col]??"").trim()}));
        if(sp.some(p=>!p.val))return;
        const sk=sp.map(p=>p.val).join("|");
        const amt=parseMoney(row[amtCol]);
        if(amt!==null&&amt>0){
          iFlatMonths.forEach(mk=>entries.push({segKey:sk,dims:Object.fromEntries(sp.map(p=>[p.dim,p.val])),monthKey:mk,amount:amt}));
        }
      });
    }else{
      iRows.forEach(row=>{
        // Trimmed so stray leading/trailing whitespace in a dimension value (a spreadsheet that
        // exports slightly differently between two pulls of "the same" file is a common source of
        // this) doesn't produce a segKey that looks new instead of matching the existing segment —
        // see consolidateBudgetSegKeys's doc comment for the duplication this otherwise causes.
        const sp=activeDims.map(d=>({dim:d.dim,val:String(row[d.col]??"").trim()}));
        if(sp.some(p=>!p.val))return;
        const sk=sp.map(p=>p.val).join("|");const mk=parsePeriod(row[periodCol]);const amt=parseMoney(row[amtCol]);
        if(mk&&amt!==null&&amt>0)entries.push({segKey:sk,dims:Object.fromEntries(sp.map(p=>[p.dim,p.val])),monthKey:mk,amount:amt});
      });
    }
    return entries;
  },[iFmt,iHeaders,iRows,iSegDim,iGroupHeaderRow,iGroupDim,iRawRows,tagDimensions,dimMap,customDims,periodCol,amtCol,iFlatMonths,canonicalDims]);

  const goPreview=()=>{setPreview(buildPreview());setIStep("preview");};

  // Writes the import into state. mergeDecisions (approved pairs from the merge-review modal,
  // or [] when there's nothing to merge) tells it which pre-existing segments are being
  // superseded by a new, more-detailed segKey from this same import.
  const doImport=(mergeDecisions=[])=>{
    if(!canEdit)return;
    setBudgets(p=>{
      const nx=JSON.parse(JSON.stringify(p));
      if(!nx[iYear])nx[iYear]={};
      preview.forEach(({segKey:sk,monthKey:mk,amount:amt})=>{
        if(!nx[iYear][sk])nx[iYear][sk]={};
        if(!nx[iYear][sk].monthly)nx[iYear][sk].monthly={};
        nx[iYear][sk].monthly[mk]=amt;
      });
      // The old segKey is only removed from THIS year — other years may still legitimately use
      // the old (shorter) key if they were never re-imported with the extra dimension.
      mergeDecisions.forEach(({oldSegKey})=>{delete nx[iYear][oldSegKey];});
      return nx;
    });

    if(mergeDecisions.length){
      // Carry over any annotation-dimension values (Region, Pillar, etc.) from the retired old
      // segKey onto the new one, without clobbering values the new import may already carry.
      setBudgetRowMeta(p=>{
        const nx={...p};
        mergeDecisions.forEach(({newSegKey,oldSegKey})=>{
          if(nx[oldSegKey]){nx[newSegKey]={...nx[oldSegKey],...(nx[newSegKey]||{})};delete nx[oldSegKey];}
        });
        return nx;
      });
      // Retag every campaign that matched the OLD (shorter) segment with the value(s) for
      // whichever dimension(s) this import added — otherwise the segment rows get merged but
      // spend still wouldn't roll up under the fuller key, since Tagger tags are what actually
      // drive spend attribution, not the budget row itself.
      const{oldBudgetDims,newActiveDims}=pendingImportRef.current||{oldBudgetDims:budgetDims,newActiveDims:budgetDims};
      const addedDims=newActiveDims.filter(d=>!oldBudgetDims.includes(d));
      if(addedDims.length){
        const newSegMap={};preview.forEach(e=>{if(!newSegMap[e.segKey])newSegMap[e.segKey]=e.dims;});
        setTags(p=>{
          const nx={...p};
          mergeDecisions.forEach(({newSegKey,oldSegKey})=>{
            const oldVals=oldSegKey.split("|");
            const newDims=newSegMap[newSegKey]||{};
            Object.entries(p).forEach(([campaign,t])=>{
              if(oldBudgetDims.every((d,i)=>t[d]===oldVals[i])){
                const patch={};addedDims.forEach(d=>{if(newDims[d])patch[d]=newDims[d];});
                nx[campaign]={...t,...patch};
              }
            });
          });
          return nx;
        });
      }
    }

    setYear(iYear);
    // Add all mapped dims (existing + custom) to budgetDims, in the same canonical order used
    // to build segKeys above — keeps the two in sync so table columns and stored keys always
    // line up, even across repeat imports with differently-ordered column mapping.
    const rawMapped=[
      ...(tagDimensions||[]).filter(d=>dimMap[d]).map(d=>({dim:d})),
      ...customDims.filter(c=>c.name&&c.col).map(c=>({dim:c.name})),
    ];
    const orderedMapped=canonicalDims(rawMapped).map(d=>d.dim);
    setBudgetDims(p=>{const nx=[...p];orderedMapped.forEach(d=>{if(!nx.includes(d))nx.push(d);});return nx;});
    // Register new custom dimensions with parent so they appear in Tagger too
    const newDimNames=customDims.filter(c=>c.name&&c.col&&!(tagDimensions||[]).includes(c.name)).map(c=>c.name);
    if(newDimNames.length) onAddDimensions?.(newDimNames);
    // Record the original file's time-granularity shape (does it roll up into quarterly and/or
    // annual total columns alongside the monthly ones?) so the export step can later suggest
    // matching that structure instead of guessing blind.
    const hasQuarterlyTotals=iHeaders.some(h=>/^q[1-4]\b/i.test(h.trim()));
    const hasAnnualTotal=iHeaders.some(h=>/^(total|annual)/i.test(h.trim()));
    setBudgetImportMeta?.(p=>({...p,[iYear]:{hasQuarterlyTotals,hasAnnualTotal,importedAt:Date.now()}}));
    setImportOpen(false);setMergeReviewOpen(false);setMergeCandidates([]);pendingImportRef.current=null;resetImport();
    const summary=mergeDecisions.length?`Imported ${preview.length} entries into ${iYear} — merged ${mergeDecisions.length} segment${mergeDecisions.length>1?"s":""} with existing rows`:`Imported ${preview.length} budget entries into ${iYear}`;
    onCheckpoint?.(summary,"budget_import");
    showNotif(summary);
  };

  // Entry point for the "Import N entries" button. Detects whether this import maps MORE
  // dimensions than the year's existing budgets used (the "added BU on top of an already-
  // imported Product Pillar/Product structure" case) — if so, finds likely-duplicate segments
  // (exact matches locally, fuzzy/near matches via AI) and opens a review step before writing
  // anything. Otherwise imports immediately, unchanged from before.
  const beginImport=async()=>{
    const rawMapped=[
      ...(tagDimensions||[]).filter(d=>dimMap[d]).map(d=>({dim:d})),
      ...customDims.filter(c=>c.name&&c.col).map(c=>({dim:c.name})),
    ];
    const newActiveDims=canonicalDims(rawMapped).map(d=>d.dim);
    const oldBudgetDims=budgetDims;
    const existingSegKeys=Object.keys(budgets[iYear]||{});
    const dimsExpanded=oldBudgetDims.length>0&&newActiveDims.length>oldBudgetDims.length&&oldBudgetDims.every(d=>newActiveDims.includes(d))&&existingSegKeys.length>0;
    // The opposite of "expanded": this import maps FEWER dimensions than the year already
    // tracks (e.g. skipping Pillar/BU that a previous import included). Unlike the expanded
    // case, this is NOT safe to auto-merge — collapsing dimensions is lossy and can be
    // many-to-one (several detailed segments can all project down to the same shorter key), so
    // there's no single unambiguous "old segment" to merge into. Instead, warn clearly and let
    // the user choose to go back and remap, or proceed knowingly.
    const dimsContracted=!dimsExpanded&&oldBudgetDims.length>0&&newActiveDims.length<oldBudgetDims.length&&newActiveDims.every(d=>oldBudgetDims.includes(d))&&existingSegKeys.length>0;

    if(dimsContracted){
      const newSegMap={};
      preview.forEach(e=>{if(!newSegMap[e.segKey])newSegMap[e.segKey]=e.dims;});
      const info=Object.entries(newSegMap).map(([sk,dims])=>{
        const matches=existingSegKeys.filter(ok=>{
          const vals=ok.split("|");
          return newActiveDims.every(d=>vals[oldBudgetDims.indexOf(d)]===dims[d]);
        });
        return{
          newSegKey:sk,
          newLabel:newActiveDims.map(d=>dims[d]||"—").join(" · "),
          matchCount:matches.length,
          examples:matches.slice(0,3).map(ok=>oldBudgetDims.map((d,i)=>ok.split("|")[i]||"—").join(" · ")),
        };
      }).filter(i=>i.matchCount>0);
      if(info.length){
        pendingImportRef.current={oldBudgetDims,newActiveDims};
        setContractionInfo(info);
        setContractionNewDims(newActiveDims);
        setContractionWarningOpen(true);
        return;
      }
    }

    if(!dimsExpanded){doImport([]);return;}
    pendingImportRef.current={oldBudgetDims,newActiveDims};

    const newSegMap={};
    preview.forEach(e=>{if(!newSegMap[e.segKey])newSegMap[e.segKey]=e.dims;});

    // Exact matches cost nothing and need no AI: project each new segment down to only the
    // dimensions the year already tracked, and see if that exact combination already exists.
    const exact=[];
    const needsCheck=[];
    Object.entries(newSegMap).forEach(([sk,dims])=>{
      const projected=oldBudgetDims.map(d=>dims[d]||"").join("|");
      if(sk!==projected&&existingSegKeys.includes(projected)){
        exact.push({newSegKey:sk,oldSegKey:projected,confidence:"exact",reason:"Same values on your existing dimensions — this import just adds more detail."});
      }else if(!existingSegKeys.includes(sk)){
        needsCheck.push({segKey:sk,dims});
      }
    });

    const claimedOld=new Set(exact.map(m=>m.oldSegKey));
    const unclaimedOld=existingSegKeys.filter(k=>!claimedOld.has(k));

    let fuzzy=[];setMergeAiError("");
    if(needsCheck.length&&unclaimedOld.length){
      setImportAnalyzing(true);
      try{
        const oldLabels=unclaimedOld.map(k=>({key:k,label:oldBudgetDims.map((d,i)=>k.split("|")[i]||"").join(" · ")}));
        const newLabels=needsCheck.map(n=>({key:n.segKey,label:newActiveDims.map(d=>n.dims[d]||"").join(" · ")}));
        const prompt=`A budgeting tool is importing new segment rows that may be the same underlying items as existing segments, just with an extra dimension added and/or minor spelling or whitespace differences.\n\nExisting segments (dimensions: ${oldBudgetDims.join(", ")}):\n${oldLabels.map(o=>`- ${o.label}`).join("\n")}\n\nNew segments from this import (dimensions: ${newActiveDims.join(", ")}):\n${newLabels.map(n=>`- ${n.label}`).join("\n")}\n\nFor each new segment that likely represents the SAME real-world item as an existing one, return a match — do not guess at unrelated items just because they share a category. Reply ONLY with this JSON (no markdown): {"matches":[{"newLabel":"<exact new segment label from the list above>","oldLabel":"<exact existing segment label from the list above>","confidence":"high"|"medium","reason":"<short reason>"}]}`;
        const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt,maxTokens:1200})});
        const data=await res.json();
        if(!res.ok)throw new Error(data?.error||"AI match request failed");
        const result=JSON.parse((data.text||"").replace(/```json|```/g,"").trim());
        const oldByLabel=Object.fromEntries(oldLabels.map(o=>[o.label,o.key]));
        const newByLabel=Object.fromEntries(newLabels.map(n=>[n.label,n.key]));
        // Guard against the AI proposing the same old or new segment in more than one pair —
        // each side can only be claimed once, first match wins, so a merge never targets or
        // consumes a segment twice.
        const usedOld=new Set(),usedNew=new Set();
        fuzzy=(result.matches||[])
          .filter(m=>oldByLabel[m.oldLabel]&&newByLabel[m.newLabel])
          .filter(m=>{
            const ok=oldByLabel[m.oldLabel],nk=newByLabel[m.newLabel];
            if(usedOld.has(ok)||usedNew.has(nk))return false;
            usedOld.add(ok);usedNew.add(nk);return true;
          })
          .map(m=>({
            newSegKey:newByLabel[m.newLabel],oldSegKey:oldByLabel[m.oldLabel],
            confidence:m.confidence==="high"?"high":"medium",reason:m.reason||"AI-detected likely match.",
          }));
      }catch(e){
        console.error("[import merge detection]",e);
        setMergeAiError(`AI overlap check unavailable (${e.message||"unknown error"}) — showing exact matches only. You can still adjust below.`);
      }finally{setImportAnalyzing(false);}
    }

    const allCandidates=[...exact,...fuzzy].map(c=>({
      ...c,
      newLabel:newActiveDims.map(d=>(newSegMap[c.newSegKey]||{})[d]||"—").join(" · "),
      oldLabel:oldBudgetDims.map((d,i)=>c.oldSegKey.split("|")[i]||"—").join(" · "),
      approved:c.confidence!=="medium", // exact + high-confidence pre-checked; medium left for manual review
    }));

    if(!allCandidates.length){doImport([]);return;}
    setMergeCandidates(allCandidates);
    setMergeReviewOpen(true);
  };
  const toggleMergeCandidate=idx=>setMergeCandidates(p=>p.map((c,i)=>i===idx?{...c,approved:!c.approved}:c));
  const confirmMergeReview=()=>{doImport(mergeCandidates.filter(c=>c.approved).map(({newSegKey,oldSegKey})=>({newSegKey,oldSegKey})));};
  const skipMergeReview=()=>{doImport([]);};
  const cancelContraction=()=>{setContractionWarningOpen(false);setContractionInfo([]);setContractionNewDims([]);pendingImportRef.current=null;setIStep("map");};
  const continueContraction=()=>{setContractionWarningOpen(false);setContractionInfo([]);setContractionNewDims([]);doImport([]);};
  const resetImport=()=>{setIStep("upload");setIFileName("");setIRawRows([]);setIHeaderRow(0);setIHeaders([]);setIRows([]);setDimMap({});setPeriodCol("");setAmtCol("");setIFlatMonths([]);setPreview([]);setCustomDims([]);setAiError("");setISegDim("Campaign");setIGroupHeaderRow(-1);setIGroupDim("Channel");setScreenshotImportError("");gsBudget.reset();};
  const closeImport=()=>{setImportOpen(false);resetImport();};

  const analyzeWithAI=async()=>{
    setAiAnalyzing(true);setAiError("");
    try{
      const sample=iRawRows.slice(0,300).map(row=>row.slice(0,20).map(v=>String(v||"").trim()));
      const prompt=`Analyze this complete budget spreadsheet and return a JSON mapping.\n\nUser's existing tag dimensions: ${(tagDimensions||[]).join(", ")}\n\nComplete file data (${sample.length} rows, up to 20 columns shown — file has ${iRawRows[0]?.length||0} total columns):\n${sample.map((row,i)=>`Row ${i+1}: ${row.map(v=>v.replace(/#REF!/g,"0")).join(" | ")}`).join("\n")}\n\nReturn ONLY this JSON object (no markdown):\n{\n  \"headerRow\": <0-based row index of the main column header row>,\n  \"groupHeaderRow\": <row index of a channel/platform grouping row ABOVE the main header that groups columns, or -1 if none>,\n  \"groupDimension\": <name for the group dimension e.g. \"Channel\" or null>,\n  \"skipPattern\": <substring in subtotal/total rows to skip, or \"\">,\n  \"format\": \"wide\", \"long\", \"transposed\", or \"flat\",\n  \"segmentDimension\": <for transposed: name for the campaign column dimension e.g. \"Campaign\">,\n  \"dimensions\": [{\"name\": <existing dim name>, \"column\": <exact column header>}],\n  \"newDimensions\": [{\"name\": <new dim name>, \"column\": <exact column header>}],\n  \"periodColumn\": <for long format: period column, else null>,\n  \"amountColumn\": <for long or flat format: amount column, else null>,\n  \"hasQuarterlyCaps\": <true/false>,\n  \"hasAnnualCap\": <true/false>\n}\nFormat rules: wide=month names as column headers; transposed=months as rows + campaigns as columns (if a row ABOVE the header groups columns into channels set groupHeaderRow); long=one row per period with an explicit period/date column; flat=one row per segment with a single recurring monthly amount column (e.g. "Monthly Budget") and NO period/date column and NO per-month columns — do not force this into "long" just because there's a column with "month" in its name, that column IS the amount column, not a period. Existing dimensions to map: ${(tagDimensions||[]).join(", ")}`;

      const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt})});
      const data=await res.json();
      if(!res.ok)throw new Error(data?.error||"AI analysis request failed");
      const result=JSON.parse((data.text||"").replace(/```json|```/g,"").trim());

      const hri=typeof result.headerRow==="number"?result.headerRow:iHeaderRow;
      const skip=typeof result.skipPattern==="string"?result.skipPattern:iSkipStr;
      setIHeaderRow(hri);setISkipStr(skip);

      const{headers,rows}=processRows(iRawRows,hri,skip);
      setIHeaders(headers);setIRows(rows);

      // Detect format with same logic as applyHeaderRow
      const monthColCount=headers.filter(h=>isMonthHdr(h)).length;
      const firstColPeriods=rows.slice(0,6).filter(r=>parsePeriod(String(r[headers[0]]||""))).length;
      const flatMonthlyCol=findFlatMonthlyCol(headers);
      let fmt=result.format||"long";
      if(fmt!=="transposed"&&fmt!=="wide"&&fmt!=="long"&&fmt!=="flat"){
        if(monthColCount>=3)fmt="wide";
        else if(firstColPeriods>=2)fmt="transposed";
        else if(flatMonthlyCol)fmt="flat";
        else fmt="long";
      }
      setIFmt(fmt);

      // Transposed: set segment + group dimension names
      if(fmt==="transposed"){
        if(result.segmentDimension) setISegDim(result.segmentDimension);
        if(typeof result.groupHeaderRow==="number"&&result.groupHeaderRow>=0){
          setIGroupHeaderRow(result.groupHeaderRow);
          if(result.groupDimension) setIGroupDim(result.groupDimension);
        }
      }

      // Map existing dimensions (for wide/long)
      const dm={};
      (result.dimensions||[]).forEach(({name,column})=>{if((tagDimensions||[]).includes(name)&&column&&headers.includes(column))dm[name]=column;});
      setDimMap(dm);

      const nc=(result.newDimensions||[]).filter(d=>d.name&&d.column&&headers.includes(d.column)).map(d=>({name:d.name,col:d.column}));
      setCustomDims(nc);

      if(result.periodColumn&&headers.includes(result.periodColumn))setPeriodCol(result.periodColumn);
      if(result.amountColumn&&headers.includes(result.amountColumn))setAmtCol(result.amountColumn);
      else if(fmt==="flat")setAmtCol(flatMonthlyCol||"");
      if(fmt==="flat")setIFlatMonths(MONTHS.map(m=>m.key));

      setIStep("map");
    }catch(e){
      setAiError(`AI analysis failed (${e.message||"unknown error"}) — please map columns manually.`);
      console.error(e);
    }finally{setAiAnalyzing(false);}
  };

  const pvGrouped=useMemo(()=>{const m={};(preview||[]).forEach(e=>{if(!m[e.segKey])m[e.segKey]={dims:e.dims,months:{}};m[e.segKey].months[e.monthKey]=e.amount;});return Object.values(m).sort((a,b)=>Object.values(a.dims).join("|").localeCompare(Object.values(b.dims).join("|")));},[preview]);
  const dimCols=(tagDimensions||[]).filter(d=>dimMap[d]);
  const canMap=iFmt==="transposed"?!!iSegDim:((tagDimensions||[]).filter(d=>dimMap[d]).length>0||customDims.some(c=>c.name&&c.col))&&(iFmt==="wide"||(iFmt==="flat"?!!amtCol&&iFlatMonths.length>0:(periodCol&&amtCol)));
  const IMPORT_STEPS=["upload","header","map","preview"];

  const cellIn=(val,onChange,over=false,cap=false)=>(
    <input type="text" value={val===""?"":(!isNaN(parseFloat(String(val).replace(/[$,]/g,"")))?`${parseFloat(String(val).replace(/[$,]/g,"")).toLocaleString()}`:val)} onChange={e=>onChange(e.target.value)} placeholder="—"
      style={{background:cap?(over?T.dangerBg:T.warningBg):(over?T.dangerBg:T.inputBg),border:`1px solid ${over?T.danger:cap?T.warningBorder:T.border}`,borderRadius:5,color:over?T.danger:cap?T.warning:"#3F00B3",padding:"4px 6px",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",width:"100%",boxSizing:"border-box",fontFamily:"'DM Sans',sans-serif",textAlign:"right",outline:"none",display:"block"}}/>
  );
  const TH={fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text,padding:"15px 8px 9px",verticalAlign:"middle",borderBottom:`1px solid ${T.border}`,background:T.bg,whiteSpace:"nowrap",textAlign:"right"};

  return(
    <div style={{display:"flex",height:"100%",background:T.bg,overflow:"hidden"}}>
      {/* Sidebar content now renders via portal into the app-shell's stats sidebar (see sidebarEl) */}
      {sidebarEl&&createPortal(
        <div style={{display:"flex",flexDirection:"column",gap:0}}>
          <div style={{display:"flex",flexDirection:"column",gap:8,paddingBottom:12}}>
          <Btn onClick={()=>setImportOpen(true)} disabled={!canEdit} title={canEdit?undefined:"View-only access"} variant="success" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↑ Import CSV / Excel</Btn>
          <Btn onClick={openExportPreview} disabled={!segs.length} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↓ Export budgets + pacing</Btn>

          {/* Metadata dimensions */}
          <div style={{borderTop:`1px solid ${T.border}`,marginTop:10,paddingTop:12}}>
            <SectionLabel T={T} style={{marginBottom:8}}>Annotation Dimensions</SectionLabel>
            <div style={{fontSize:11,color:T.textMuted,marginBottom:8,lineHeight:1.5}}>Add Pillar, Region, Funnel etc. as columns to annotate budget rows.</div>
            {budgetMetaDims.map(d=>(
              <div key={d} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 0"}}>
                <span style={{fontSize:12,color:T.text,fontFamily:"Inter,sans-serif"}}>{d}</span>
                <button onClick={()=>setBudgetMetaDims(p=>p.filter(x=>x!==d))} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:13,padding:0,lineHeight:1}}>×</button>
              </div>
            ))}
            <div style={{display:"flex",gap:4,marginTop:6}}>
              <input value={newMetaDim} onChange={e=>setNewMetaDim(e.target.value)} placeholder="e.g. Pillar, Region…" onKeyDown={e=>e.key==="Enter"&&addMetaDim()}
                style={{flex:1,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:11,outline:"none",fontFamily:"Inter,sans-serif"}}/>
              <Btn onClick={addMetaDim} disabled={!newMetaDim.trim()} variant="subtle" size="sm" T={T}>+ Add</Btn>
            </div>
            {tagDimensions?.filter(d=>!budgetDims.includes(d)&&!budgetMetaDims.includes(d)).length>0&&(
              <div style={{marginTop:8}}>
                <div style={{fontSize:10,color:T.textMuted,marginBottom:4}}>From your tag dimensions:</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                  {tagDimensions.filter(d=>!budgetDims.includes(d)&&!budgetMetaDims.includes(d)).map(d=>(
                    <button key={d} onClick={()=>{setBudgetMetaDims(p=>[...p,d]);showNotif(`Added ${d}`);}}
                      style={{fontSize:11,padding:"2px 8px",borderRadius:14,background:T.surfaceEl,border:`1px solid ${T.border}`,color:T.text,cursor:"pointer",fontFamily:"Inter,sans-serif"}}>+ {d}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
          <Divider T={T}/>
          <div style={{padding:"12px 0"}}>
            <SectionLabel T={T}>Budget Year</SectionLabel>
            <div style={{display:"flex",gap:4}}>{years.map(y=><button key={y} className={year===y?undefined:"bhq-row"} onClick={()=>setYear(y)} style={{flex:1,padding:"5px 0",borderRadius:6,border:`1.5px solid ${year===y?T.accentHover:T.border}`,background:year===y?T.accentBg:"transparent",color:year===y?T.text:T.textMuted,cursor:"pointer",fontSize:12,fontWeight:year===y?700:400,fontFamily:"Inter,sans-serif"}}>{y}</button>)}</div>
          </div>
          <Divider T={T}/>
          <div style={{padding:"12px 0"}}>
            <SectionLabel T={T}>Budget By</SectionLabel>
            {["Platform",...(tagDimensions||[])].map(d=>{const on=budgetDims.includes(d);return(
              <div key={d} className={on?undefined:"bhq-row"} onClick={()=>toggleDim(d)} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 8px",borderRadius:6,cursor:"pointer",background:on?T.accentBg:"transparent",border:on?`1px solid ${T.accentBorder}`:"1px solid transparent",marginBottom:2}}>
                <Chk checked={on} onChange={()=>toggleDim(d)} T={T}/>
                <span style={{fontSize:13,color:T.text,fontWeight:on?700:400}}>{d}</span>
                <span style={{fontSize:11,color:T.textMuted,marginLeft:"auto",fontFamily:"Inter,sans-serif"}}>{dimCount(d)}</span>
              </div>
            );})}
          </div>
          <Divider T={T}/>
          <div style={{padding:"12px 0"}}>
            <div onClick={()=>setShowRollups(x=>!x)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",marginBottom:showRollups?8:0}}>
              <SectionLabel T={T} style={{marginBottom:0}}>Rollups</SectionLabel>
              <Tog value={showRollups} onChange={setShowRollups} T={T}/>
            </div>
            {showRollups&&<div style={{fontSize:11,color:T.textMuted,lineHeight:1.5}}>Shows budget totals by each Budget By dimension on its own — e.g. Channel summed across all regions/segments — above the table, broken out by month, quarter, and year.</div>}
          </div>
          <Divider T={T}/>
          <div style={{padding:"12px 0"}}>
            <SectionLabel T={T}>Optional Caps</SectionLabel>
            {[{label:"Quarterly caps",v:showQ,s:setShowQ},{label:"Annual cap",v:showA,s:setShowA}].map(({label,v,s})=>(
              <div key={label} onClick={()=>s(x=>!x)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"5px 0",cursor:"pointer"}}>
                <span style={{fontSize:12,color:T.textSub}}>{label}</span><Tog value={v} onChange={s} T={T}/>
              </div>
            ))}
          </div>
          <Divider T={T}/>
          <div style={{padding:"12px 0"}}>
            <SectionLabel T={T}>Summary</SectionLabel>
            <StatRow label="Segments" value={segs.length.toString()} T={T}/>
            <StatRow label={`Total ${year}`} value={totalY>0?fmtFull(totalY):"$0"} T={T}/>
            {segs.some(sg=>isNotBudgeted(sg.key))&&<StatRow label="Not budgeted" value={segs.filter(sg=>isNotBudgeted(sg.key)).length.toString()} T={T}/>}
          </div>
        </div>,
        sidebarEl
      )}

      {/* Table */}
      <div style={{flex:1,overflow:"auto",minWidth:0}}>
        {!budgetDims.length?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40}}>
            <div style={{width:52,height:52,borderRadius:12,background:T.accent,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:22}}><Icon name="wallet" size={24} color={T.onAccent}/></div>
            <div style={{fontSize:17,fontWeight:700,color:T.text,marginBottom:6}}>Set up your budget structure</div>
            <div style={{fontSize:13,color:T.textSub,maxWidth:340,lineHeight:1.65,marginBottom:20}}>{canEdit?"Select dimensions to budget by, or import an existing budget file.":"This workspace doesn't have a budget structure yet — ask an owner or admin to set one up."}</div>
            {canEdit&&<Btn onClick={()=>setImportOpen(true)} variant="success" T={T} size="md">↑ Import CSV / Excel</Btn>}
          </div>
        ):segs.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40}}>
            <div style={{fontSize:17,fontWeight:700,color:T.text,marginBottom:6}}>No segments found</div>
            <div style={{fontSize:13,color:T.textSub,maxWidth:320,lineHeight:1.65}}>
              {budgetDims.includes("Platform")?(
                budgetDims.length>1?
                  <>Import spend data and tag campaigns with <strong style={{color:T.text}}>{budgetDims.filter(d=>d!=="Platform").join(" + ")}</strong> in the Tagger — Platform is detected automatically, no tagging needed for it.</>
                  :<>Import spend data in the Tagger — Platform is detected automatically, no manual tagging needed.</>
              ):(
                <>Tag campaigns with <strong style={{color:T.text}}>{budgetDims.join(" + ")}</strong> in the Tagger first.</>
              )}
            </div>
          </div>
        ):(
          <>
          <div style={{padding:"14px 16px 0"}}>
            <AISummaryCard T={T} mergedNormRows={mergedNormRows} tags={campaignTags} budgetDims={budgetDims} budgets={budgets} budgetRowMeta={budgetRowMeta} defaultForecastModel={defaultForecastModel} mode="budget"/>
          </div>
          {/* Rollups — budget totals by one Budget By dimension at a time, independent of the
              detail grid's row grain */}
          {showRollups&&rollupTables.length>0&&(
            <div style={{padding:"14px 16px",borderBottom:`1px solid ${T.border}`,background:T.surface,display:"flex",flexDirection:"column",gap:16,overflowX:"auto"}}>
              {hiddenRollupDims.length>0&&(
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:T.textMuted}}>
                  <span>{hiddenRollupDims.length} rollup table{hiddenRollupDims.length===1?"":"s"} hidden</span>
                  <span onClick={showAllRollupTables} style={{color:T.accent,cursor:"pointer",fontWeight:600}}>Show all</span>
                </div>
              )}
              {rollupTables.filter(({dim})=>!hiddenRollupDims.includes(dim)).map(({dim,rows,total})=>(
                <div key={dim} style={{border:`1px solid ${T.border}`,borderRadius:8,overflow:"hidden"}}>
                  <div style={{padding:"8px 10px",background:T.headerBg,borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span style={{fontSize:11,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.text}}>By {dim}</span>
                    <span title="Hide this rollup table"><Tog value={true} onChange={()=>hideRollupTable(dim)} T={T}/></span>
                  </div>
                  <table style={{borderCollapse:"collapse",width:"100%"}}>
                    <thead>
                      <tr>
                        <th style={{padding:"5px 10px",fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.textMuted,textAlign:"left",borderBottom:`1px solid ${T.border}`,background:T.bg}}></th>
                        {MONTHS.map(m=>(
                          <th key={m.key} style={{padding:"5px 8px",fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.textMuted,textAlign:"right",borderBottom:`1px solid ${T.border}`,background:T.bg,whiteSpace:"nowrap"}}>{m.label}</th>
                        ))}
                        {QUARTERS.map(q=>(
                          <th key={q.key} style={{padding:"5px 8px",fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.textSub,textAlign:"right",borderBottom:`1px solid ${T.border}`,background:T.bg,whiteSpace:"nowrap",borderLeft:q.key==="Q1"?`1px solid ${T.border}`:undefined}}>{q.key}</th>
                        ))}
                        <th style={{padding:"5px 10px",fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.text,textAlign:"right",borderBottom:`1px solid ${T.border}`,borderLeft:`1px solid ${T.border}`,background:T.bg,whiteSpace:"nowrap"}}>{year}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r=>(
                        <tr key={r.value}>
                          <td style={{padding:"6px 10px",fontSize:12,color:T.text,borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{r.value}</td>
                          {MONTHS.map(m=>(
                            <td key={m.key} style={{padding:"6px 8px",fontSize:12,color:r.months[m.key]?T.text:T.textDim,textAlign:"right",fontFamily:"Inter,sans-serif",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{r.months[m.key]?fmt$(r.months[m.key]):"—"}</td>
                          ))}
                          {QUARTERS.map(q=>{
                            const qv=q.months.reduce((s,mk)=>s+(r.months[mk]||0),0);
                            return <td key={q.key} style={{padding:"6px 8px",fontSize:12,color:qv?T.textSub:T.textDim,textAlign:"right",fontFamily:"Inter,sans-serif",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap",borderLeft:q.key==="Q1"?`1px solid ${T.border}`:undefined}}>{qv?fmt$(qv):"—"}</td>;
                          })}
                          <td style={{padding:"6px 10px",fontSize:12,color:T.accent,fontWeight:700,textAlign:"right",fontFamily:"Inter,sans-serif",borderBottom:`1px solid ${T.border}`,borderLeft:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{fmt$(r.total)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{padding:"6px 10px",fontSize:12,fontWeight:700,color:T.text}}>Total</td>
                        {MONTHS.map(m=>{
                          const mv=rows.reduce((s,r)=>s+(r.months[m.key]||0),0);
                          return <td key={m.key} style={{padding:"6px 8px",fontSize:12,fontWeight:600,color:T.text,textAlign:"right",fontFamily:"Inter,sans-serif",whiteSpace:"nowrap"}}>{mv?fmt$(mv):"—"}</td>;
                        })}
                        {QUARTERS.map(q=>{
                          const qv=rows.reduce((s,r)=>s+q.months.reduce((ss,mk)=>ss+(r.months[mk]||0),0),0);
                          return <td key={q.key} style={{padding:"6px 8px",fontSize:12,fontWeight:600,color:T.textSub,textAlign:"right",fontFamily:"Inter,sans-serif",whiteSpace:"nowrap",borderLeft:q.key==="Q1"?`1px solid ${T.border}`:undefined}}>{qv?fmt$(qv):"—"}</td>;
                        })}
                        <td style={{padding:"6px 10px",fontSize:12,fontWeight:700,color:T.accent,textAlign:"right",fontFamily:"Inter,sans-serif",borderLeft:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{fmt$(total)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
          {/* Bulk action bar */}
          {selRows.size>0&&(
            <div style={{padding:"8px 16px",background:T.surface,borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",flexShrink:0}}>
              <Pill color={T.text} bg={T.accent} border={T.text}>{selRows.size} selected</Pill>
              <span style={{color:T.textMuted,fontSize:13}}>→</span>
              <Sel value={applyMetaDim} onChange={setApplyMetaDim} T={T} style={{width:140,fontSize:12}}>
                <option value="">Dimension…</option>
                {[...budgetDims,...budgetMetaDims].map(d=><option key={d} value={d}>{d}</option>)}
              </Sel>
              <input value={applyMetaVal} onChange={e=>setApplyMetaVal(e.target.value)} placeholder="Value…" onKeyDown={e=>e.key==="Enter"&&applyMetaToSelected()}
                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"Inter,sans-serif",width:130}}/>
              <Btn onClick={applyMetaToSelected} disabled={!applyMetaDim||!applyMetaVal} variant="primary" size="sm" T={T}>Apply</Btn>
              <Btn onClick={()=>setSelRows(new Set())} variant="ghost" size="sm" T={T}>Clear</Btn>
              <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
              <Btn onClick={bulkDeleteSelected} variant="danger" size="sm" T={T}>✕ Delete {selRows.size}</Btn>
            </div>
          )}
          <table style={{borderCollapse:"collapse",minWidth:"100%",fontSize:12}}>
            <thead><tr>
              <th style={{...TH,width:32,padding:"15px 8px 9px 16px",position:"sticky",left:0,zIndex:4,background:T.bg}}>
                <input type="checkbox" checked={filteredSegs.length>0&&selRows.size===filteredSegs.length} onChange={selAllRows} title="Select all rows — reveals bulk actions (tag, delete) once selected" style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
              </th>
              {budgetDims.map((d,i)=><th key={d} style={{...TH,textAlign:"left",padding:"15px 14px 9px",minWidth:dcw,position:"sticky",left:32+i*dcw,zIndex:3,background:T.bg}}>{d}</th>)}
              {budgetMetaDims.map(d=><th key={d} style={{...TH,textAlign:"left",padding:"15px 14px 9px",minWidth:110}}>{d}</th>)}
              {MONTHS.map(m=><th key={m.key} style={{...TH,textAlign:"center",minWidth:76}}>{m.label}</th>)}
              {QUARTERS.map(q=><th key={"qt-"+q.key} style={{...TH,textAlign:"center",minWidth:90}}>{q.key}</th>)}
              <th style={{...TH,textAlign:"center",minWidth:100}}>Year Total</th>
              {showQ&&QUARTERS.map(q=><th key={"qc-"+q.key} style={{...TH,color:T.warning,minWidth:96}}>{q.label}</th>)}
              {showA&&<th style={{...TH,color:T.warning,minWidth:96}}>Annual Cap</th>}
            </tr></thead>
            <tbody>
              {filteredSegs.length===0&&segs.length>0&&(
                <tr><td colSpan={2+budgetDims.length+budgetMetaDims.length+MONTHS.length+QUARTERS.length+1+(showQ?QUARTERS.length:0)+(showA?1:0)} style={{padding:"32px 20px",textAlign:"center",color:T.textMuted,fontSize:13}}>
                  {hideNotBudgeted&&!hasSegFilters?"All matching segments are marked not budgeted. ":"No segments match your filters. "}
                  <span onClick={()=>{clearSegFilters();setHideNotBudgeted(false);}} style={{color:T.accent,cursor:"pointer",fontWeight:500}}>{hideNotBudgeted&&!hasSegFilters?"Show them":"Clear filters"}</span>
                </td></tr>
              )}
              {filteredSegs.map((seg)=>{const rt=rowTotal(seg.key);const ao=aOver(seg.key);const rb="transparent";const rbb=`1px solid ${T.border}`;const isSel=selRows.has(seg.key);const nb=isNotBudgeted(seg.key);return(
                <tr key={seg.key} className={isSel?undefined:"bhq-tr"} style={{background:isSel?T.rowSelected:rb,opacity:nb?0.5:1}}>
                  <td style={{padding:"7px 8px 7px 16px",borderBottom:rbb,position:"sticky",left:0,background:isSel?T.rowSelected:T.bg,zIndex:1}}>
                    <input type="checkbox" checked={isSel} onChange={()=>toggleRowSel(seg.key)} title="Select row — reveals bulk actions (tag, delete) once selected" style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
                  </td>
                  {budgetDims.map((d,i)=><td key={d} style={{padding:"7px 14px",borderBottom:rbb,position:"sticky",left:32+i*dcw,background:isSel?T.rowSelected:T.bg,zIndex:1,whiteSpace:"nowrap"}}>
                    {d==="Platform"?(
                      // Derived, not stored — renaming here would only relabel the budget row
                      // while spend keeps resolving to the original channel name, silently
                      // breaking the match. Not editable.
                      <Pill color="#3F00B3" bg={T.pill} border={T.pillBorder} style={{fontFamily:"'DM Sans',sans-serif",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",borderRadius:6}} title="Derived from spend data — not editable">{seg[d]}</Pill>
                    ):editingSegVal?.segKey===seg.key&&editingSegVal?.dim===d?(
                      <input autoFocus value={editSegVal} onChange={e=>setEditSegVal(e.target.value)}
                        onBlur={saveSegEdit} onKeyDown={e=>{if(e.key==="Enter")saveSegEdit();if(e.key==="Escape"){setEditingSegVal(null);setEditSegVal("");}}}
                        style={{background:T.inputBg,border:`1px solid ${T.accentBorder}`,borderRadius:6,color:"#3F00B3",padding:"3px 8px",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",outline:"none",fontFamily:"'DM Sans',sans-serif",minWidth:80}}/>
                    ):(
                      <Pill color="#3F00B3" bg={T.pill} border={T.pillBorder} style={{fontFamily:"'DM Sans',sans-serif",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",cursor:"text",borderRadius:6}}
                        onClick={()=>{setEditingSegVal({segKey:seg.key,dim:d});setEditSegVal(seg[d]);}}>{seg[d]}</Pill>
                    )}
                    {i===budgetDims.length-1&&!nb&&segMatchCount(seg.key)===0&&(
                      <WarnTip T={T} text="No campaigns are tagged to this segment yet. Spend won't roll up here until a campaign is tagged with this exact combination in the Tagger."/>
                    )}
                    {i===budgetDims.length-1&&nb&&(
                      <span style={{marginLeft:6,fontSize:10,fontWeight:600,color:T.textMuted,background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:10,padding:"1px 7px",fontFamily:"Inter,sans-serif"}}>Not budgeted</span>
                    )}
                  </td>)}
                  {budgetMetaDims.map(d=>{
                    const val=(budgetRowMeta[seg.key]||{})[d]||"";
                    const isEditing=editingMeta?.segKey===seg.key&&editingMeta?.dim===d;
                    return(
                      <td key={d} style={{padding:"4px 8px",borderBottom:rbb,minWidth:110}} onClick={()=>{setEditingMeta({segKey:seg.key,dim:d});setEditMetaVal(val);}}>
                        {isEditing?(
                          <input autoFocus value={editMetaVal} onChange={e=>setEditMetaVal(e.target.value)}
                            onBlur={saveMetaEdit} onKeyDown={e=>{if(e.key==="Enter")saveMetaEdit();if(e.key==="Escape"){setEditingMeta(null);setEditMetaVal("");}}}
                            style={{background:T.inputBg,border:`1px solid ${T.accentBorder}`,borderRadius:5,color:"#3F00B3",padding:"3px 7px",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",outline:"none",fontFamily:"'DM Sans',sans-serif",width:"100%"}}/>
                        ):(
                          <span style={{fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:val?"#3F00B3":T.textMuted,cursor:"text",padding:"3px 6px",display:"block",borderRadius:5,border:`1px solid transparent`,minHeight:22,fontFamily:"'DM Sans',sans-serif"}}>
                            {val||<span style={{opacity:0.4}}>—</span>}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  {MONTHS.map(m=>{const q=QUARTERS.find(q=>q.months.includes(m.key));const qo=showQ&&q&&qOver(seg.key,q);return <td key={m.key} style={{padding:"4px",borderBottom:rbb,background:rb}}>{cellIn(getMV(seg.key,m.key),v=>setMV(seg.key,m.key,v),qo)}</td>;})}
                  {QUARTERS.map(q=>{const qt=qTotal(seg.key,q);return <td key={"qt-"+q.key} style={{padding:"4px 10px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:"#3F00B3",background:rb}}>{qt>0?fmt$(qt):"—"}</td>;})}
                  <td style={{padding:"4px 12px",borderBottom:rbb,textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:ao?T.danger:"#3F00B3",whiteSpace:"nowrap",background:rb}}><span style={{display:"inline-flex",alignItems:"center",gap:4}}>{rt>0?fmtFull(rt):"—"}{ao&&<Icon name="alert" size={11} color={T.danger}/>}</span></td>
                  {showQ&&QUARTERS.map(q=>{const qo=qOver(seg.key,q);const qt=qTotal(seg.key,q);return <td key={"qc-"+q.key} style={{padding:"4px",borderBottom:rbb,background:rb}}><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>{cellIn(getQC(seg.key,q.key),v=>setQC(seg.key,q.key,v),qo,true)}{qt>0&&<span style={{fontSize:10,color:qo?T.danger:T.textMuted,fontFamily:"'DM Sans',sans-serif",display:"inline-flex",alignItems:"center",gap:3}}>{fmt$(qt)}{qo&&<Icon name="alert" size={10} color={T.danger}/>}</span>}</div></td>;})}
                  {showA&&<td style={{padding:"4px",borderBottom:rbb,background:rb}}><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>{cellIn(getAC(seg.key),v=>setAC(seg.key,v),ao,true)}{rt>0&&<span style={{fontSize:10,color:ao?T.danger:T.textMuted,fontFamily:"'DM Sans',sans-serif",display:"inline-flex",alignItems:"center",gap:3}}>{fmt$(rt)}{ao&&<Icon name="alert" size={10} color={T.danger}/>}</span>}</div></td>}
                  <td style={{padding:"4px 8px",borderBottom:rbb,background:rb}}>
                    <div style={{display:"flex",alignItems:"center",gap:2}}>
                      <button onClick={()=>toggleNotBudgeted(seg.key)} title={nb?"Unmark — this segment does need a budget":"Mark as not budgeted — hides the missing-budget signal for this segment"}
                        style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:nb?T.accentBg:"transparent",border:`1px solid ${nb?T.accentBorder:"transparent"}`,borderRadius:5,color:nb?T.accent:T.textMuted,cursor:"pointer",fontSize:11,lineHeight:1,padding:0,opacity:nb?1:0.4,transition:"all 0.1s"}}
                        onMouseEnter={e=>{e.currentTarget.style.opacity=1;if(!nb){e.currentTarget.style.border=`1px solid ${T.border}`;}}}
                        onMouseLeave={e=>{e.currentTarget.style.opacity=nb?1:0.4;if(!nb){e.currentTarget.style.border="1px solid transparent";}}}>
                        <Icon name="ban" size={12} color={nb?T.accent:T.textMuted}/>
                      </button>
                      <button onClick={()=>deleteRow(seg.key,budgetDims.map(d=>seg[d]).join(" · "))} title="Delete row"
                        style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:5,color:T.textMuted,cursor:"pointer",fontSize:12,lineHeight:1,padding:0,opacity:0.4,transition:"all 0.1s"}}
                        onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.border=`1px solid ${T.danger}`;e.currentTarget.style.color=T.danger;}}
                        onMouseLeave={e=>{e.currentTarget.style.opacity=0.4;e.currentTarget.style.border="1px solid transparent";e.currentTarget.style.color=T.textMuted;}}>✕</button>
                    </div>
                  </td>
                </tr>);})}
              <tr style={{borderTop:`1px solid ${T.border}`,background:T.surface}}>
                <td style={{padding:"10px 8px 10px 16px",position:"sticky",left:0,background:T.surface,zIndex:1}}/>
                {budgetDims.map((d,i)=><td key={d} style={{padding:"10px 14px",position:"sticky",left:32+i*dcw,background:T.surface,zIndex:1}}>{i===0&&<SectionLabel T={T} style={{marginBottom:0,color:T.text}}>Totals</SectionLabel>}</td>)}
                {budgetMetaDims.map(d=><td key={d}/>)}
                {MONTHS.map(m=>{const t=filteredSegs.reduce((s,sg)=>s+(budgets[year]?.[sg.key]?.monthly?.[m.key]||0),0);return <td key={m.key} style={{padding:"10px 8px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:"#3F00B3"}}>{t>0?fmt$(t):"—"}</td>;})}
                {QUARTERS.map(q=>{const qt=filteredSegs.reduce((s,sg)=>s+qTotal(sg.key,q),0);return <td key={"qt-"+q.key} style={{padding:"10px 10px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:"#3F00B3"}}>{qt>0?fmt$(qt):"—"}</td>;})}
                <td style={{padding:"10px 12px",textAlign:"right",fontFamily:"'DM Sans',sans-serif",fontSize:16,fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:"#3F00B3"}}>{(()=>{const ft=filteredSegs.reduce((s,sg)=>s+rowTotal(sg.key),0);return ft>0?fmtFull(ft):"—";})()}</td>
                {showQ&&QUARTERS.map(q=><td key={"qc-"+q.key}/>)}
                {showA&&<td/>}
                <td/>
              </tr>
            </tbody>
          </table>

          {/* Bottom bar — filters + add row, sharing one footer */}
          <div style={{padding:"10px 16px",borderTop:`1px solid ${T.border}`,background:T.surface,display:"flex",flexDirection:"column",gap:8,flexShrink:0}}>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <span style={{fontSize:11,color:T.text,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"}}>Filter:</span>
              {[...budgetDims,...budgetMetaDims].map(d=>(
                <input key={d} value={segFilters[d]||""} onChange={e=>setSegFilters(p=>({...p,[d]:e.target.value}))} placeholder={d}
                  style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"Inter,sans-serif",width:120}}/>
              ))}
              {hasSegFilters&&<Btn onClick={clearSegFilters} variant="ghost" size="sm" T={T}>Clear filters</Btn>}
              {segs.some(sg=>isNotBudgeted(sg.key))&&(
                <label style={{display:"flex",alignItems:"center",gap:5,fontSize:12,color:T.textSub,cursor:"pointer"}}>
                  <input type="checkbox" checked={hideNotBudgeted} onChange={e=>setHideNotBudgeted(e.target.checked)} style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
                  Hide not-budgeted
                </label>
              )}
              <span style={{marginLeft:"auto",fontSize:11,color:T.textMuted}}>{filteredSegs.length} of {segs.length} segments</span>
            </div>
            {budgetDims.length>0&&(!showAddRow?(
                <Btn onClick={()=>setShowAddRow(true)} variant="ghost" size="sm" T={T} style={{alignSelf:"flex-start"}}>+ Add segment manually</Btn>
              ):(
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  {budgetDims.map(d=>d==="Platform"?(
                    // Constrained to channels actually present in spend data — a free-typed value
                    // here ("google" vs the canonical "Google Search") would silently create a
                    // segment that never matches real spend, unlike ordinary tag dimensions where
                    // that risk is more visible/correctable in the Tagger itself.
                    <Sel key={d} value={newRowVals[d]||""} onChange={v=>setNewRowVals(p=>({...p,[d]:v}))} T={T} style={{width:150}}>
                      <option value="">Platform…</option>
                      {platformValues.map(p=><option key={p} value={p}>{p}</option>)}
                    </Sel>
                  ):(
                    <input key={d} value={newRowVals[d]||""} onChange={e=>setNewRowVals(p=>({...p,[d]:e.target.value}))} placeholder={d}
                      style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"Inter,sans-serif",width:130}}/>
                  ))}
                  <Btn onClick={addManualRow} disabled={budgetDims.some(d=>!newRowVals[d]?.trim())} variant="primary" size="sm" T={T}>Add</Btn>
                  <Btn onClick={()=>{setShowAddRow(false);setNewRowVals({});}} variant="ghost" size="sm" T={T}>Cancel</Btn>
                </div>
              ))}
          </div>
          </>
        )}
      </div>

      {notif&&<div style={{position:"fixed",bottom:24,right:24,background:T.success,color:"#fff",padding:"10px 16px",borderRadius:8,fontSize:13,fontWeight:600,zIndex:300,boxShadow:T.shadowMd,fontFamily:"Inter,sans-serif"}}>{notif}</div>}

      {/* ── IMPORT MODAL ── */}
      {importOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:680,maxHeight:"90vh"}} contentStyle={{background:T.surface,maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>

            {/* Modal header */}
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
              <div>
                <div style={{fontSize:15,fontWeight:700,color:T.text}}>Import Budget File</div>
                <div style={{fontSize:12,color:T.textSub,marginTop:2}}>
                  {iStep==="upload"&&"CSV or Excel · any layout"}
                  {iStep==="header"&&`${iFileName} · Click the row that contains your column headers`}
                  {iStep==="map"&&"Map columns to your tag dimensions"}
                  {iStep==="preview"&&`${preview.length} entries ready to import`}
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:14}}>
                {["Upload","Headers","Map","Preview"].map((label,i)=>{
                  const sk=IMPORT_STEPS[i];const idx=IMPORT_STEPS.indexOf(iStep);
                  return <div key={sk} style={{display:"flex",alignItems:"center",gap:5}}>{i>0&&<span style={{color:T.textDim,fontSize:11}}>›</span>}<span style={{fontSize:12,color:iStep===sk?T.accent:idx>i?T.success:T.textMuted,fontWeight:iStep===sk?600:400}}>{idx>i?"✓ ":""}{label}</span></div>;
                })}
                <button onClick={closeImport} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22,lineHeight:1,marginLeft:6,fontFamily:"Inter,sans-serif"}}>×</button>
              </div>
            </div>

            {/* Modal body */}
            <div style={{flex:1,overflow:"auto",padding:22}}>

              {/* STEP 1: Upload + Year */}
              {iStep==="upload"&&(
                <div>
                  <div style={{marginBottom:22}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:4}}>Which year do these budgets apply to?</div>
                    <div style={{fontSize:12,color:T.textSub,marginBottom:10}}>Applied to all entries — even if the year isn't in the file.</div>
                    <div style={{display:"flex",gap:8}}>
                      {years.map(y=><button key={y} onClick={()=>setIYear(y)} style={{flex:1,padding:"10px 0",borderRadius:8,border:`1.5px solid ${iYear===y?T.accent:T.border}`,background:iYear===y?T.accentBg:"transparent",color:iYear===y?T.accent:T.textSub,cursor:"pointer",fontSize:15,fontWeight:iYear===y?700:400,fontFamily:"Inter,sans-serif"}}>{y}</button>)}
                    </div>
                  </div>
                  <div onClick={()=>fileRef.current?.click()} style={{border:`1.5px dashed ${T.borderStrong}`,borderRadius:10,padding:"36px 20px",textAlign:"center",cursor:"pointer",background:T.surfaceEl}}>
                    <div style={{marginBottom:10,display:"flex",justifyContent:"center"}}><Icon name="export" size={30} color={T.textSub}/></div>
                    <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:4}}>Drop your budget file here or click to browse</div>
                    <div style={{fontSize:12,color:T.textMuted}}>Supports <strong style={{color:T.textSub}}>.xlsx</strong> and <strong style={{color:T.textSub}}>.csv</strong> · any row/column layout</div>
                    <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{display:"none"}} onChange={e=>handleImportFile(e.target.files[0])}/>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:10,margin:"14px 0"}}>
                    <div style={{flex:1,height:1,background:T.border}}/>
                    <span style={{fontSize:11,color:T.textMuted}}>or</span>
                    <div style={{flex:1,height:1,background:T.border}}/>
                  </div>
                  <div onClick={()=>!screenshotImporting&&screenshotFileRef.current?.click()} style={{border:`1.5px dashed ${T.borderStrong}`,borderRadius:10,padding:"20px",textAlign:"center",cursor:screenshotImporting?"default":"pointer",background:T.surfaceEl}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.accent,marginBottom:4}}>{screenshotImporting?"Reading screenshot…":"Or upload a screenshot of a budget table"}</div>
                    <div style={{fontSize:12,color:T.textMuted}}>Google Sheets, Excel, a PDF export — AI reads the grid, then you review it in the same steps as a file upload</div>
                    <input ref={screenshotFileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{handleImportScreenshot(e.target.files[0]);e.target.value="";}}/>
                  </div>
                  {screenshotImportError&&<div style={{marginTop:8,fontSize:11,color:T.danger}}>{screenshotImportError}</div>}

                  <div style={{display:"flex",alignItems:"center",gap:10,margin:"14px 0"}}>
                    <div style={{flex:1,height:1,background:T.border}}/>
                    <span style={{fontSize:11,color:T.textMuted}}>or</span>
                    <div style={{flex:1,height:1,background:T.border}}/>
                  </div>
                  <div style={{border:`1.5px dashed ${T.borderStrong}`,borderRadius:10,padding:"16px",background:T.surfaceEl}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.accent,marginBottom:4}}>Or connect a Google Sheet</div>
                    <div style={{fontSize:12,color:T.textMuted,marginBottom:10}}>Paste the sheet's URL — this pulls a one-time snapshot, same review steps as a file upload. Live auto-refresh is coming later; for now, reconnect and re-import whenever you want the latest numbers.</div>
                    {gsBudget.tabs?.length>1?(
                      <div>
                        <div style={{fontSize:12,color:T.textSub,marginBottom:8}}>This spreadsheet has multiple tabs — which one has the budget?</div>
                        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
                          {gsBudget.tabs.map(t=>(
                            <button key={t.sheetId} disabled={gsBudget.fetching} onClick={()=>gsBudget.fetchTab(gsBudget.spreadsheetId,t.title)}
                              style={{padding:"6px 12px",borderRadius:6,border:`1px solid ${T.border}`,background:T.surface,color:T.text,cursor:gsBudget.fetching?"default":"pointer",fontSize:12,fontFamily:"Inter,sans-serif",opacity:gsBudget.fetching?0.6:1}}>{t.title}</button>
                          ))}
                        </div>
                        <Btn onClick={gsBudget.cancelTabs} variant="ghost" size="sm" T={T}>Cancel</Btn>
                      </div>
                    ):(
                      <div style={{display:"flex",gap:8}}>
                        <input value={gsBudget.url} onChange={e=>gsBudget.setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…"
                          onKeyDown={e=>e.key==="Enter"&&!gsBudget.fetching&&gsBudget.url.trim()&&gsBudget.connect()}
                          style={{flex:1,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"7px 10px",fontSize:12,outline:"none",fontFamily:"Inter,sans-serif"}}/>
                        <Btn onClick={gsBudget.connect} disabled={gsBudget.fetching||!gsBudget.url.trim()} variant="primary" size="sm" T={T}>{gsBudget.fetching?"Connecting…":"Connect"}</Btn>
                      </div>
                    )}
                    {gsBudget.error&&(
                      <div style={{marginTop:8,fontSize:11,color:T.danger}}>
                        {gsBudget.error}
                        {/(permission|forbidden|403)/i.test(gsBudget.error)&&(
                          <div style={{marginTop:4}}>
                            That usually means the Google account you're connected as doesn't have access to this sheet. <span onClick={gsBudget.retryWithNewAccount} style={{color:T.accent,cursor:"pointer",fontWeight:600,textDecoration:"underline"}}>Try a different Google account</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={{marginTop:14,display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                    {[{label:"Wide format",example:"Product | Jan | Feb | Mar | Apr..."},{label:"Long format",example:"Product | Platform | Month | Budget"}].map(f=>(
                      <div key={f.label} style={{padding:"10px 12px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:8}}>
                        <div style={{fontSize:12,fontWeight:600,color:T.text,marginBottom:3}}>{f.label}</div>
                        <div style={{fontSize:11,color:T.textMuted,fontFamily:"Inter,sans-serif"}}>{f.example}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* STEP 2: Header row picker */}
              {iStep==="header"&&(
                <div>
                  {aiError&&<div style={{padding:"9px 12px",background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,borderRadius:8,marginBottom:14,fontSize:12,color:T.danger}}>{aiError}</div>}
                  <div style={{padding:"10px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:8,marginBottom:16,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                    <span style={{fontSize:12,color:T.accent,fontWeight:500}}>Year: <strong>{iYear}</strong> · Click a row to set it as the header</span>
                    <div style={{display:"flex",gap:4}}>{years.map(y=><button key={y} onClick={()=>setIYear(y)} style={{padding:"2px 8px",borderRadius:4,border:`1px solid ${iYear===y?T.accent:T.border}`,background:iYear===y?T.accentBg:"transparent",color:iYear===y?T.accent:T.textMuted,cursor:"pointer",fontSize:11,fontFamily:"Inter,sans-serif"}}>{y}</button>)}</div>
                  </div>

                  <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                    <div style={{fontSize:12,color:T.textSub}}>
                      Header row: <strong style={{color:T.text}}>Row {iHeaderRow+1}</strong>
                      <span style={{color:T.textMuted,marginLeft:8}}>({iRawRows[iHeaderRow]?.filter(v=>String(v||"").trim()).length||0} columns detected)</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginLeft:"auto"}}>
                      <span style={{fontSize:12,color:T.textSub}}>Skip rows containing:</span>
                      <Inp value={iSkipStr} onChange={setISkipStr} placeholder="e.g. total" T={T} style={{width:120,fontSize:12}}/>
                    </div>
                  </div>

                  {/* Row preview table */}
                  <div style={{border:`1px solid ${T.border}`,borderRadius:8,overflow:"auto",maxHeight:320}}>
                    <table style={{borderCollapse:"collapse",width:"100%",fontSize:11}}>
                      <tbody>
                        {iRawRows.slice(0,Math.min(iRawRows.length,15)).map((row,ri)=>{
                          const isHeader=ri===iHeaderRow;
                          const isEmpty=row.every(v=>!String(v||"").trim());
                          const isSkip=iSkipStr&&row.join(" ").toLowerCase().includes(iSkipStr.toLowerCase());
                          return(
                            <tr key={ri} onClick={()=>setIHeaderRow(ri)}
                              style={{cursor:"pointer",background:isHeader?T.accentBg:isSkip?T.dangerBg:isEmpty?T.surfaceEl:"transparent",borderBottom:`1px solid ${T.border}`,transition:"background 0.1s"}}>
                              <td style={{padding:"6px 8px",width:32,textAlign:"center",borderRight:`1px solid ${T.border}`,color:isHeader?T.accent:T.textMuted,fontSize:10,fontWeight:isHeader?700:400}}>
                                {isHeader?"→":ri+1}
                              </td>
                              {row.slice(0,8).map((cell,ci)=>(
                                <td key={ci} style={{padding:"6px 10px",color:isHeader?T.accent:isSkip?T.danger:isEmpty?T.textDim:T.text,fontWeight:isHeader?600:400,fontFamily:isHeader?"Inter,sans-serif":"Inter,sans-serif",fontSize:isHeader?11:11,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                                  {cell||""}
                                </td>
                              ))}
                              {row.length>8&&<td style={{padding:"6px 8px",color:T.textMuted,fontSize:10}}>+{row.length-8} more</td>}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{marginTop:10,fontSize:11,color:T.textMuted}}>
                    <span style={{color:T.accent,fontWeight:600}}>→ highlighted row</span> = header &nbsp;·&nbsp;
                    <span style={{color:T.danger}}>red rows</span> = will be skipped &nbsp;·&nbsp;
                    <span style={{color:T.textDim}}>dim rows</span> = empty
                  </div>
                </div>
              )}

              {/* STEP 3: Map columns */}
              {iStep==="map"&&(
                <div>
                  <div style={{padding:"9px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:8,marginBottom:16}}>
                    <span style={{fontSize:12,color:T.accent,fontWeight:500}}>
                      Year: <strong>{iYear}</strong> · {iFmt==="wide"?"Wide (months as columns)":iFmt==="transposed"?"Transposed (months as rows, campaigns as columns)":iFmt==="flat"?"Flat (one recurring monthly amount, no named months)":"Long (period + amount columns)"} · {iRows.length} data rows · {iHeaders.length} columns
                    </span>
                  </div>

                  {/* Transposed format UI */}
                  {iFmt==="transposed"&&(
                    <div style={{marginBottom:20}}>
                      <SectionLabel T={T} style={{marginBottom:8}}>Transposed format detected</SectionLabel>
                      <div style={{padding:"12px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:8,marginBottom:14,fontSize:12,color:T.textSub,lineHeight:1.6}}>
                        Your file has <strong style={{color:T.text}}>months as rows</strong> and <strong style={{color:T.text}}>{iHeaders.slice(1).filter(h=>h&&!/(total|quarterly|last.updated|#ref)/i.test(h)).length} campaign/channel columns</strong>. Each column becomes a segment value. Columns matching "total", "quarterly", "last updated", or #REF are excluded.
                      </div>

                      {/* Campaign dimension name */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,alignItems:"center",marginBottom:10}}>
                        <div>
                          <div style={{fontSize:13,fontWeight:500,color:T.text}}>Campaign/segment dimension name</div>
                          <div style={{fontSize:11,color:T.textMuted}}>What are these columns? e.g. Campaign, Ad Set</div>
                        </div>
                        <input value={iSegDim} onChange={e=>setISegDim(e.target.value)} placeholder="e.g. Campaign"
                          style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"7px 10px",fontSize:13,outline:"none",fontFamily:"Inter,sans-serif"}}/>
                      </div>

                      {/* Group header row */}
                      <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginTop:4}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                          <div>
                            <div style={{fontSize:13,fontWeight:500,color:T.text}}>Channel / group header row</div>
                            <div style={{fontSize:11,color:T.textMuted}}>Optional — use a row above the header that groups campaigns into channels</div>
                          </div>
                          <Tog value={iGroupHeaderRow>=0} onChange={v=>setIGroupHeaderRow(v?Math.max(0,iHeaderRow-1):-1)} T={T}/>
                        </div>
                        {iGroupHeaderRow>=0&&(
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:8}}>
                            <div>
                              <div style={{fontSize:12,color:T.textSub,marginBottom:4}}>Which row contains channel labels?</div>
                              <select value={iGroupHeaderRow} onChange={e=>setIGroupHeaderRow(parseInt(e.target.value))}
                                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:"Inter,sans-serif",width:"100%"}}>
                                {iRawRows.slice(0,iHeaderRow).map((_,i)=>(
                                  <option key={i} value={i}>Row {i+1}: {(iRawRows[i]||[]).filter(v=>String(v||"").trim()).slice(0,3).join(" | ")}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <div style={{fontSize:12,color:T.textSub,marginBottom:4}}>Name for this group dimension</div>
                              <input value={iGroupDim} onChange={e=>setIGroupDim(e.target.value)} placeholder="e.g. Channel, Platform"
                                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:"Inter,sans-serif",width:"100%"}}/>
                            </div>
                          </div>
                        )}
                        {iGroupHeaderRow>=0&&iRawRows[iGroupHeaderRow]&&(
                          <div style={{marginTop:8,padding:"8px 10px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:6,fontSize:11,color:T.accent}}>
                            Preview: {forwardFillGroups(iRawRows[iGroupHeaderRow]).filter((v,i)=>i>0&&v).filter((v,i,a)=>a.indexOf(v)===i).join(", ")}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Existing tag dimensions + custom dims — not needed for transposed */}
                  {iFmt!=="transposed"&&<div>
                    <SectionLabel T={T} style={{marginBottom:10}}>Map columns to existing tag dimensions</SectionLabel>
                    <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
                      {(tagDimensions||[]).map(d=>(
                        <div key={d} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,alignItems:"center"}}>
                          <span style={{fontSize:13,color:T.text,fontWeight:500}}>{d}</span>
                          <Sel value={dimMap[d]||""} onChange={v=>setDimMap(p=>({...p,[d]:v||undefined}))} T={T}>
                            <option value="">— skip —</option>
                            {iHeaders.map(h=><option key={h} value={h}>{h}</option>)}
                          </Sel>
                        </div>
                      ))}
                    </div>
                    <div style={{borderTop:`1px solid ${T.border}`,paddingTop:16,marginTop:4}}>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                        <SectionLabel T={T} style={{marginBottom:0}}>Add custom dimensions</SectionLabel>
                        <Btn onClick={()=>setCustomDims(p=>[...p,{name:"",col:""}])} variant="subtle" size="sm" T={T}>+ Add dimension</Btn>
                      </div>
                      {customDims.length===0&&<div style={{fontSize:12,color:T.textMuted,padding:"8px 0"}}>Map any additional columns to new tag dimensions not yet in your list.</div>}
                      {customDims.map((cd,i)=>(
                        <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 28px",gap:8,marginBottom:8,alignItems:"center"}}>
                          <input value={cd.name} onChange={e=>setCustomDims(p=>p.map((x,j)=>j===i?{...x,name:e.target.value}:x))} placeholder="Dimension name (e.g. BU)" style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:"Inter,sans-serif"}}/>
                          <Sel value={cd.col} onChange={v=>setCustomDims(p=>p.map((x,j)=>j===i?{...x,col:v}:x))} T={T}><option value="">— select column —</option>{iHeaders.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                          <button onClick={()=>setCustomDims(p=>p.filter((_,j)=>j!==i))} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:16,lineHeight:1,padding:"4px",fontFamily:"Inter,sans-serif"}}>×</button>
                        </div>
                      ))}
                    </div>
                  </div>}

                  {/* Long format extra */}
                  {iFmt==="long"&&<div style={{borderTop:`1px solid ${T.border}`,paddingTop:16,marginTop:8}}>
                    <SectionLabel T={T} style={{marginBottom:10}}>Long format columns</SectionLabel>
                    {[{l:"Period / Month",v:periodCol,s:setPeriodCol,h:"e.g. 2026-01, Jan 2026"},{l:"Budget Amount",v:amtCol,s:setAmtCol,h:"e.g. Budget, Amount"}].map(({l,v,s,h})=>(
                      <div key={l} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:8,alignItems:"center"}}>
                        <div><div style={{fontSize:13,color:T.text,fontWeight:500}}>{l}</div><div style={{fontSize:11,color:T.textMuted}}>{h}</div></div>
                        <Sel value={v} onChange={s} T={T}><option value="">— select —</option>{iHeaders.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                      </div>
                    ))}
                  </div>}

                  {/* Flat format extra — one recurring monthly amount, no named months/period col */}
                  {iFmt==="flat"&&<div style={{borderTop:`1px solid ${T.border}`,paddingTop:16,marginTop:8}}>
                    <SectionLabel T={T} style={{marginBottom:10}}>Monthly amount column</SectionLabel>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16,alignItems:"center"}}>
                      <div><div style={{fontSize:13,color:T.text,fontWeight:500}}>Monthly Budget</div><div style={{fontSize:11,color:T.textMuted}}>e.g. Monthly Budget, Monthly Spend</div></div>
                      <Sel value={amtCol} onChange={setAmtCol} T={T}><option value="">— select —</option>{iHeaders.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                    </div>

                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <SectionLabel T={T} style={{marginBottom:0}}>Apply to which month(s) of {iYear}?</SectionLabel>
                      <div style={{display:"flex",gap:6}}>
                        <Btn onClick={()=>setIFlatMonths(MONTHS.map(m=>m.key))} variant="subtle" size="sm" T={T}>Whole year</Btn>
                        <Btn onClick={()=>setIFlatMonths([])} variant="subtle" size="sm" T={T}>Clear</Btn>
                      </div>
                    </div>
                    <div style={{fontSize:11,color:T.textMuted,marginBottom:10}}>
                      This table has no named months — pick which month(s) this recurring amount should be written into. e.g. a client starting in July only needs Jul–Dec, not a back-filled Jan–Jun.
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:6,marginBottom:14}}>
                      {MONTHS.map(m=>{
                        const active=iFlatMonths.includes(m.key);
                        return(
                          <button key={m.key} type="button" onClick={()=>setIFlatMonths(p=>active?p.filter(k=>k!==m.key):[...p,m.key].sort())}
                            style={{padding:"6px 4px",borderRadius:6,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"Inter,sans-serif",textAlign:"center",
                              background:active?T.accent:T.surfaceEl,color:active?"#fff":T.text,
                              border:`1px solid ${active?T.accentHover:T.border}`}}>
                            {m.label}
                          </button>
                        );
                      })}
                    </div>

                    <div style={{padding:"9px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:8,fontSize:12,color:T.accent,lineHeight:1.5}}>
                      {iFlatMonths.length===0
                        ? "Select at least one month above to continue."
                        : <>This amount will be applied to <strong>{iFlatMonths.length===12?`all 12 months of ${iYear}`:iFlatMonths.map(k=>MONTHS.find(m=>m.key===k)?.label).join(", ")}</strong> for each segment.</>}
                      {" "}Any secondary total column (e.g. Quarterly Budget) is skipped on import — it's redundant with this figure. You can hand-adjust any individual month afterward right in the Budget Panel grid.
                    </div>
                  </div>}
                </div>
              )}

              {/* STEP 4: Preview */}
              {iStep==="preview"&&(
                <div>
                  <div style={{padding:"9px 12px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:8,marginBottom:14,fontSize:12,color:T.success,fontWeight:500}}>
                    ✓ <strong>{preview.length} entries</strong> across <strong>{pvGrouped.length} segments</strong> ready for <strong>{iYear}</strong>
                  </div>
                  <div style={{border:`1px solid ${T.border}`,borderRadius:8,overflow:"auto",maxHeight:360}}>
                    <table style={{borderCollapse:"collapse",width:"100%",fontSize:11}}>
                      <thead><tr>
                        {dimCols.map(d=><th key={d} style={{padding:"8px 10px",textAlign:"left",background:T.headerBg,borderBottom:`1px solid ${T.border}`,fontSize:10,fontWeight:700,color:T.textMuted,letterSpacing:"0.07em",textTransform:"uppercase",position:"sticky",top:0}}>{d}</th>)}
                        {MONTHS.filter(m=>(preview||[]).some(e=>e.monthKey===m.key)).map(m=><th key={m.key} style={{padding:"8px 6px",textAlign:"right",background:T.headerBg,borderBottom:`1px solid ${T.border}`,fontSize:10,fontWeight:700,color:T.textMuted,textTransform:"uppercase",position:"sticky",top:0}}>{m.label}</th>)}
                        <th style={{padding:"8px 10px",textAlign:"right",background:T.headerBg,borderBottom:`1px solid ${T.border}`,fontSize:10,fontWeight:700,color:T.accent,textTransform:"uppercase",position:"sticky",top:0}}>Total</th>
                      </tr></thead>
                      <tbody>
                        {pvGrouped.map((sg,i)=>{const rt=Object.values(sg.months).reduce((s,v)=>s+v,0);return(
                          <tr key={i}>
                            {dimCols.map(d=><td key={d} style={{padding:"7px 10px",borderBottom:`1px solid ${T.border}`,color:T.text}}>{sg.dims[d]||"—"}</td>)}
                            {MONTHS.filter(m=>(preview||[]).some(e=>e.monthKey===m.key)).map(m=><td key={m.key} style={{padding:"7px 6px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:"Inter,sans-serif",color:sg.months[m.key]?T.text:T.textDim}}>{sg.months[m.key]?fmt$(sg.months[m.key]):"—"}</td>)}
                            <td style={{padding:"7px 10px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:"Inter,sans-serif",fontWeight:700,color:T.accent}}>{fmt$(rt)}</td>
                          </tr>
                        );})}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div style={{padding:"14px 22px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",flexShrink:0}}>
              <Btn onClick={()=>{if(iStep==="header")setIStep("upload");else if(iStep==="map")setIStep("header");else if(iStep==="preview")setIStep("map");else closeImport();}} variant="ghost" T={T}>{iStep==="upload"?"Cancel":"← Back"}</Btn>
              <div style={{display:"flex",gap:8}}>
              {iStep==="header"&&<div style={{display:"flex",gap:8}}>
                <Btn onClick={analyzeWithAI} disabled={aiAnalyzing} variant="success" T={T} style={{gap:6}}>
                  {aiAnalyzing?<span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:12,height:12,border:`2px solid ${T.successBorder}`,borderTopColor:T.success,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/> Analyzing…</span>:<span>✨ Analyze with AI</span>}
                </Btn>
                <Btn onClick={applyHeaderRow} variant="primary" T={T}>Confirm headers →</Btn>
              </div>}
                {iStep==="map"&&<Btn onClick={goPreview} disabled={!canMap} variant="primary" T={T}>Preview import →</Btn>}
                {iStep==="preview"&&<Btn onClick={beginImport} disabled={importAnalyzing} variant="primary" T={T} style={{gap:6}}>
                  {importAnalyzing?<span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:12,height:12,border:`2px solid rgba(255,255,255,0.3)`,borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/> Checking for overlaps…</span>:<span>✓ Import {preview.length} entries into {iYear}</span>}
                </Btn>}
              </div>
            </div>
          </PixelPanel>
        </div>
      )}

      {exportPreviewOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:460}} contentStyle={{background:T.surface,padding:0}}>
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontSize:15,fontWeight:700,color:T.text}}>Export preview — {year}</div>
              <button onClick={()=>setExportPreviewOpen(false)} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22,lineHeight:1,fontFamily:"Inter,sans-serif"}}>×</button>
            </div>
            <div style={{padding:22}}>
              {exportAnalyzing?(
                <div style={{display:"flex",alignItems:"center",gap:8,color:T.textSub,fontSize:13}}>
                  <span style={{width:14,height:14,border:`2px solid ${T.border}`,borderTopColor:T.accent,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/>
                  Checking how your {year} budget file was structured…
                </div>
              ):(
                <>
                  {exportAiReason&&(
                    <div style={{padding:"9px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:8,marginBottom:16,fontSize:12,color:T.text,lineHeight:1.5}}>✨ {exportAiReason}</div>
                  )}
                  {exportAiError&&(
                    <div style={{padding:"9px 12px",background:T.warningBg,border:`1px solid ${T.warningBorder}`,borderRadius:8,marginBottom:16,fontSize:12,color:T.warning,lineHeight:1.5}}>{exportAiError}</div>
                  )}
                  <div style={{fontSize:12,color:T.textSub,marginBottom:12}}>Always included: annual actual spend, % of budget used, projected year-end spend, and pacing status. Choose what else to append:</div>
                  <label style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0",cursor:"pointer"}}>
                    <input type="checkbox" checked={exportIncludeMonthly} onChange={e=>setExportIncludeMonthly(e.target.checked)} style={{marginTop:2,cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                    <span><span style={{fontSize:13,fontWeight:600,color:T.text}}>Monthly actual spend</span><br/><span style={{fontSize:12,color:T.textMuted}}>Adds a Jan–Dec Actual column next to each budgeted month.</span></span>
                  </label>
                  <label style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0",cursor:"pointer"}}>
                    <input type="checkbox" checked={exportIncludeQuarterly} onChange={e=>setExportIncludeQuarterly(e.target.checked)} style={{marginTop:2,cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                    <span><span style={{fontSize:13,fontWeight:600,color:T.text}}>Quarterly actual spend</span><br/><span style={{fontSize:12,color:T.textMuted}}>Adds Q1–Q4 Actual columns, matching quarterly totals in your original file.</span></span>
                  </label>
                </>
              )}
            </div>
            <div style={{padding:"14px 22px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8}}>
              <Btn onClick={()=>setExportPreviewOpen(false)} variant="ghost" T={T}>Cancel</Btn>
              <Btn onClick={confirmExport} disabled={exportAnalyzing} variant="primary" T={T}>↓ Download CSV</Btn>
            </div>
          </PixelPanel>
        </div>
      )}

      {mergeReviewOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:210,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:560,maxHeight:"85vh"}} contentStyle={{background:T.surface,padding:0,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:15,fontWeight:700,color:T.text}}>Possible duplicate segments</div>
              <div style={{fontSize:12,color:T.textSub,marginTop:2}}>This import adds a new dimension to segments you've already budgeted. Merge the ones below into your existing rows, or keep them separate.</div>
            </div>
            <div style={{flex:1,overflow:"auto",padding:22}}>
              {mergeAiError&&(
                <div style={{padding:"9px 12px",background:T.warningBg,border:`1px solid ${T.warningBorder}`,borderRadius:8,marginBottom:16,fontSize:12,color:T.warning,lineHeight:1.5}}>{mergeAiError}</div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {mergeCandidates.map((c,i)=>{
                  const confMeta=c.confidence==="exact"?{label:"Exact match",color:T.success,bg:T.successBg,border:T.successBorder}:c.confidence==="high"?{label:"High confidence",color:T.accent,bg:T.accentBg,border:T.accentBorder}:{label:"Review suggested",color:T.warning,bg:T.warningBg,border:T.warningBorder};
                  return(
                    <label key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",borderRadius:8,border:`1px solid ${T.border}`,cursor:"pointer",background:c.approved?T.accentBg:"transparent"}}>
                      <input type="checkbox" checked={c.approved} onChange={()=>toggleMergeCandidate(i)} style={{marginTop:3,cursor:"pointer",accentColor:T.accent,width:14,height:14,flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                          <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:20,color:confMeta.color,background:confMeta.bg,border:`1px solid ${confMeta.border}`}}>{confMeta.label}</span>
                        </div>
                        <div style={{fontSize:13,color:T.text,fontWeight:600,marginBottom:2}}>{c.newLabel}</div>
                        <div style={{fontSize:12,color:T.textMuted,marginBottom:4}}>↳ merges into existing: <strong style={{color:T.textSub}}>{c.oldLabel}</strong></div>
                        <div style={{fontSize:11,color:T.textMuted,lineHeight:1.5}}>{c.reason}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
            <div style={{padding:"14px 22px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",gap:8}}>
              <Btn onClick={skipMergeReview} variant="ghost" T={T}>Keep all separate</Btn>
              <Btn onClick={confirmMergeReview} variant="primary" T={T}>✓ Import & merge {mergeCandidates.filter(c=>c.approved).length} segment{mergeCandidates.filter(c=>c.approved).length===1?"":"s"}</Btn>
            </div>
          </PixelPanel>
        </div>
      )}

      {contractionWarningOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:210,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:560,maxHeight:"85vh"}} contentStyle={{background:T.surface,padding:0,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:15,fontWeight:700,color:T.text,display:"flex",alignItems:"center",gap:8}}><Icon name="alert" size={16} color={T.warning}/> This import tracks fewer dimensions</div>
              <div style={{fontSize:12,color:T.textSub,marginTop:4,lineHeight:1.6}}>Your {year} budget already uses <strong style={{color:T.text}}>{budgetDims.join(", ")}</strong>. This file only maps <strong style={{color:T.text}}>{contractionNewDims.join(", ")}</strong>. These are lossy, shorter keys — they can't be safely auto-merged into your existing detailed segments, since more than one of those could match the same shorter key.</div>
            </div>
            <div style={{flex:1,overflow:"auto",padding:22}}>
              <div style={{fontSize:12,color:T.textSub,marginBottom:12}}>If you continue, this import will create <strong style={{color:T.text}}>{contractionInfo.length}</strong> new, less-specific segment{contractionInfo.length===1?"":"s"} — separate from your existing rows below, not combined with them:</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {contractionInfo.map((c,i)=>(
                  <div key={i} style={{padding:"10px 12px",borderRadius:8,border:`1px solid ${T.border}`}}>
                    <div style={{fontSize:13,color:T.text,fontWeight:600,marginBottom:4}}>New: {c.newLabel}</div>
                    <div style={{fontSize:12,color:T.textMuted,lineHeight:1.6}}>Sits alongside {c.matchCount} existing segment{c.matchCount===1?"":"s"} that also match{c.matchCount===1?"es":""}: {c.examples.join(" · ")}{c.matchCount>c.examples.length?` +${c.matchCount-c.examples.length} more`:""}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{padding:"14px 22px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",gap:8}}>
              <Btn onClick={cancelContraction} variant="primary" T={T}>← Back and remap columns</Btn>
              <Btn onClick={continueContraction} variant="ghost" T={T} style={{color:T.danger}}>Continue anyway</Btn>
            </div>
          </PixelPanel>
        </div>
      )}
    </div>
  );
}
