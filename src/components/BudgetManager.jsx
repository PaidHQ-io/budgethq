import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { AreaChart } from "@tremor/react";
import {
  buildCampaignPlatformIndex, countSegmentCampaigns, untagSegmentCampaigns, renameDimensionValue,
  resolveBudgetDimValue, DERIVED_DIMS,
  campaignKey, parseMoney, fmtFull, fmt$, isMonthHdr, getMonthKey,
  parsePeriod, findFlatMonthlyCol, parseFileToRows, forwardFillGroups, downloadCSV,
  computeActualsByMonth, computePacing, pacingStatusMeta, MONTHS, QUARTERS,
  splitFilterTerms, matchesTerms,
} from "../lib/core.js";
import {
  SectionLabel, Pill, Btn, Inp, Sel, Tog, Icon,
  PixelPanel, WarnTip, AISummaryCard, MatchModeToggle, IconField,
} from "./shared.jsx";
// Card/cn (2026-08-07, per Mo's reference screenshot — a bordered chart card + a bordered table
// card, matching Venture's Analytics page). This file is still on the legacy T-theme system
// (see PaidHQ.jsx's tailwind.config.js corePlugins.preflight comment for why), but Tailwind
// utility classes work regardless of which styling system the REST of a component uses — these
// two net-new cards are built Tailwind-native (same Card primitive Dashboard.jsx already uses)
// rather than hand-rolling T-theme styles for something that needs to look exactly like the
// Venture kit's own card anatomy.
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.jsx";
// Button/Checkbox/Switch/Input (2026-08-07, per Mo: "the secondary vertical menu...everything in
// it is based on the old theme") — swapping the portal sidebar's T-theme Btn/Chk/Tog/<input> for
// the real Venture primitives, same ones PaidHQ.jsx's shell/Settings already use.
import { Button } from "./ui/button.jsx";
import { Checkbox } from "./ui/checkbox.jsx";
import { Switch } from "./ui/switch.jsx";
import { Input } from "./ui/input.jsx";
import { UploadSimple, DownloadSimple, ClockCounterClockwise, ArrowUUpLeft, ArrowUUpRight, X as XIcon } from "@phosphor-icons/react";
import { cn } from "../lib/utils.js";
import { useGoogleSheetConnect } from "../hooks/useGoogleSheetConnect.js";
import { pickSpreadsheet, appendRowsToGoogleSheet } from "../lib/googleSheets.js";
import { authHeader } from "../lib/workspaceApi.js";
import { usePersistentState } from "../lib/persist.js";

// src/components/BudgetManager.jsx — Budget Panel tab (2026-07-25 split, per Mo: split the
// four tab components out of the PaidHQ.jsx monolith into their own files so each tab's code
// can be lazy-loaded instead of every tab shipping in one bundle on every page load).

// Custom hover tooltip for the Budget chart card (2026-08-07, per Mo's reference screenshot of
// Venture's Analytics "Sales Revenues" card — a floating card with a dot-icon + period label row,
// then a "metric name / value" row). Tremor's built-in tooltip doesn't have a dedicated icon slot,
// so this is a from-scratch render via AreaChart's customTooltip prop rather than a style override
// of the stock one. Module-level (not defined inside BudgetManager) since it doesn't need any of
// that component's state/closures — same posture as Dashboard.jsx's local TrendDelta helper.
function BudgetChartTooltip({payload,active,label}){
  if(!active||!payload?.length)return null;
  const val=payload[0]?.value;
  return(
    <div className="rounded-md border border-border bg-background px-3 py-2 shadow-md">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-[9px] font-bold text-background">$</span>
        {label}
      </div>
      <div className="flex items-center justify-between gap-6 text-sm">
        <span className="text-muted-foreground">Budgeted</span>
        <span className="font-semibold text-foreground">{fmtFull(val||0)}</span>
      </div>
    </div>
  );
}

// Per-segment currency LABEL only (2026-07-31, per Mo — "currency label only to start", no FX
// conversion). Every number in the grid stays exactly as typed; this just tags a row with which
// currency those numbers are actually denominated in, for clients with international budgets on
// different currencies. Stored in budgetRowMeta under an underscore-prefixed key, same pattern
// as _notBudgeted — never added to budgetMetaDims, so it never becomes a real dimension column.
const CURRENCIES=["USD","EUR","GBP","CAD","AUD","JPY","CHF","MXN","BRL","INR"];

// promptAndArchiveFile defaults to a no-op passthrough (resolves immediately, no naming modal, no
// File Store save) so this component still works standalone/in isolation (e.g. tests, Storybook-
// style usage) without PaidHQ.jsx's real implementation wired in — see that function's own doc
// comment in PaidHQ.jsx for what it actually does when a real one IS passed (2026-08-06, per Mo's
// save-and-one-click-reapply request).
export default function BudgetManager({campaignTags,setTags,tagDimensions,T,session,onAddDimensions,budgets,setBudgets,budgetDims,setBudgetDims,budgetRowMeta,setBudgetRowMeta,budgetMetaDims,setBudgetMetaDims,budgetImportMeta,setBudgetImportMeta,defaultForecastModel,mergedNormRows,onCheckpoint,sidebarEl,canEdit=true,combineGoogleChannels=false,initialImportFile,onConsumeInitialImportFile,promptAndArchiveFile=async file=>({name:file?.name,fileId:null})}){
  const yr=new Date().getFullYear();
  // year/showQ/showA/segFilters persisted (2026-07-30, per Mo — "whatever screen with whatever
  // filters on any tab I've selected" should survive a refresh), same pattern as
  // showRollups/hideNotBudgeted/hiddenRollupDims just below.
  const[year,setYear]=usePersistentState("paidhq_budget_year",yr.toString());
  const[showQ,setShowQ]=usePersistentState("paidhq_budget_showQ",false);
  const[showA,setShowA]=usePersistentState("paidhq_budget_showA",false);
  const[showCurrency,setShowCurrency]=usePersistentState("paidhq_budget_showCurrency",false);
  // Persisted to localStorage (like the top-level view/askChats prefs) rather than plain useState
  // — BudgetManager itself now stays mounted across tab switches (see the display:none wrapper in
  // PaidHQ's render), so this survives that on its own, but persisting it too means the toggle
  // also survives a hard page reload, matching how every other "which view mode am I in" pref in
  // the app behaves.
  const[showRollups,setShowRollups]=useState(()=>{try{return localStorage.getItem("paidhq_budget_show_rollups")==="1";}catch{return false;}});
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_show_rollups",showRollups?"1":"0");}catch{/* storage unavailable (private browsing, quota, etc.) — best-effort save, safe to skip */}},[showRollups]);
  // Same persistence pattern as showRollups. Filters segments marked "not budgeted" out of both
  // the detail grid and rollupTables (which is derived from filteredSegs) in one place.
  const[hideNotBudgeted,setHideNotBudgeted]=useState(()=>{try{return localStorage.getItem("paidhq_budget_hide_not_budgeted")==="1";}catch{return false;}});
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_hide_not_budgeted",hideNotBudgeted?"1":"0");}catch{/* storage unavailable — best-effort save, safe to skip */}},[hideNotBudgeted]);
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
  const[importHistoryOpen,setImportHistoryOpen]=useState(false);
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
  // Filter/sort (2026-07-31, per Mo — "stronger filter and sort... at the top, like the campaign
  // tagger"). Generalized across whatever budgetDims/budgetMetaDims are active (unlike Tagger's
  // fixed Campaign/Group/Platform/Tag fields), so this is keyed by dimension name rather than one
  // named state var per field: {[dim]: "term1, term2"} for both include and exclude, each with its
  // own AND/OR match mode, reusing the exact same splitFilterTerms/matchesTerms helpers and
  // MatchModeToggle component Tagger's filters already use — same comma-separated-terms UX in
  // both places. segFilters kept as the include-filter variable name (was already persisted under
  // this key as a plain substring filter; upgrading it in place to comma-separated multi-term
  // matching is a strict superset of the old single-substring behavior, not a breaking shape
  // change for anyone's already-saved filter text).
  const[segFilters,setSegFilters]=usePersistentState("paidhq_budget_segFilters",{}); // {dim: "term1, term2"} — include
  const[segFiltersExclude,setSegFiltersExclude]=usePersistentState("paidhq_budget_segFiltersExclude",{});
  const[segFilterInclMode,setSegFilterInclMode]=usePersistentState("paidhq_budget_segFilterInclMode",{}); // {dim:"or"|"and"}
  const[segFilterExclMode,setSegFilterExclMode]=usePersistentState("paidhq_budget_segFilterExclMode",{});
  const[totalMin,setTotalMin]=usePersistentState("paidhq_budget_totalMin","");
  const[totalMax,setTotalMax]=usePersistentState("paidhq_budget_totalMax","");
  const[budgetSortCol,setBudgetSortCol]=usePersistentState("paidhq_budget_sortCol",""); // "" (unsorted/import order) | a dim/meta-dim name | "_total"
  const[budgetSortDir,setBudgetSortDir]=usePersistentState("paidhq_budget_sortDir","desc");
  const[filtersOpen,setFiltersOpen]=usePersistentState("paidhq_budget_filtersOpen",false);
  // Toolbar search + pagination (2026-08-07, per Mo's reference screenshot of a Venture-style
  // table — free-text search across every visible dimension/meta value, plus a real paginated
  // footer instead of one long scrollable table). Search persists like the other filters; page
  // number deliberately does NOT persist (starting back on page 1 after a reload is the expected
  // behavior for pagination, unlike a saved filter). budgetPageSize persists so "Show 25 Row"
  // sticks per the same "whatever screen with whatever filters" posture as everything else here.
  const[budgetSearchQuery,setBudgetSearchQuery]=usePersistentState("paidhq_budget_search","");
  const[budgetPageSize,setBudgetPageSize]=usePersistentState("paidhq_budget_pageSize",25);
  const[budgetPage,setBudgetPage]=useState(1);
  // Card-style rows (2026-08-07, per Mo's reference screenshot of Venture's Transaction Details —
  // bordered, spaced rows instead of a flat grid). Experimental, so it's a persisted toggle rather
  // than a hard rewrite — Mo can flip it off live ("we can always revert back") if the dense wide
  // financial grid reads worse this way. Default on so it shows the moment he opens the panel.
  const[cardRows,setCardRows]=usePersistentState("paidhq_budget_cardRows",true);
  // Budget roll-up (2026-08-07, per Mo — "shouldn't budgets roll up to whatever is selected so
  // budgets always show?"). Budgets are stored keyed by the joined values of the Budget By dims
  // that were active when they were entered (its "grain"). budgetGrains records, per year, that
  // native ordered dim list. When the user then views a COARSER subset of those dims, we aggregate
  // the stored granular entries up into read-only summed totals for the current view (see viewBudget
  // below), so numbers always show instead of going blank. Editing stays at the native grain.
  const[budgetGrains,setBudgetGrains]=usePersistentState("paidhq_budget_grains",{}); // {year: [dim,...]}
  // maxParts = the finest grain any stored budget for this year uses (# of "|"-joined dimension
  // values in its key). grain = the ordered dim list those keys were entered under (recorded by the
  // effect below whenever the current selection matches that finest grain). isRolledUp is true when
  // the user is now viewing a strict, same-set subset of that grain — i.e. they deselected one or
  // more dims, so we should sum up. Declared up here so every write path below can consult it.
  const budgetKeysThisYear=useMemo(()=>Object.keys(budgets[year]||{}),[budgets,year]);
  const maxParts=useMemo(()=>budgetKeysThisYear.reduce((m,k)=>Math.max(m,k.split("|").length),0),[budgetKeysThisYear]);
  const grain=budgetGrains[year]||null;
  const isRolledUp=!!(grain&&budgetDims.length<grain.length&&budgetDims.every(d=>grain.includes(d)));
  useEffect(()=>{
    if(!budgetKeysThisYear.length||maxParts===0)return;
    if(budgetDims.length!==maxParts)return;
    const next=[...budgetDims];
    const cur=budgetGrains[year];
    if(!cur||cur.join("|")!==next.join("|"))setBudgetGrains(p=>({...p,[year]:next}));
  },[budgetKeysThisYear,maxParts,budgetDims,year,budgetGrains,setBudgetGrains]);
  // viewBudget — the effective {segKey:{monthly,quarterly,annual}} for the CURRENT view. In the
  // native (non-rolled) view it's just budgets[year]. When rolled up, each stored granular entry is
  // projected onto the current dims (via the grain's dim→value map) and summed into the coarser key.
  const viewBudget=useMemo(()=>{
    const src=budgets[year]||{};
    if(!isRolledUp)return src;
    const out={};
    Object.entries(src).forEach(([k,v])=>{
      const parts=k.split("|");
      if(parts.length!==grain.length)return; // only aggregate entries at the native grain
      const dimMap={};grain.forEach((d,i)=>{dimMap[d]=parts[i];});
      const viewKey=budgetDims.map(d=>dimMap[d]).join("|");
      const o=out[viewKey]||(out[viewKey]={monthly:{},quarterly:{},annual:0});
      if(v.monthly)for(const mk in v.monthly)o.monthly[mk]=(o.monthly[mk]||0)+(v.monthly[mk]||0);
      if(v.quarterly)for(const qk in v.quarterly)o.quarterly[qk]=(o.quarterly[qk]||0)+(v.quarterly[qk]||0);
      if(v.annual)o.annual=(o.annual||0)+(v.annual||0);
    });
    return out;
  },[budgets,year,isRolledUp,grain,budgetDims]);
  // "View" popover in the top action bar (2026-08-07, per Mo) — folds Rollups + Optional Columns
  // out of the tall stats sidebar into a compact dropdown.
  const[viewMenuOpen,setViewMenuOpen]=useState(false);
  const viewMenuRef=useRef(null);
  useEffect(()=>{
    if(!viewMenuOpen)return;
    const onDoc=e=>{if(viewMenuRef.current&&!viewMenuRef.current.contains(e.target))setViewMenuOpen(false);};
    document.addEventListener("mousedown",onDoc);
    return()=>document.removeEventListener("mousedown",onDoc);
  },[viewMenuOpen]);
  const[applyMetaDim,setApplyMetaDim]=useState("");
  const[applyMetaVal,setApplyMetaVal]=useState("");
  const[bulkPct,setBulkPct]=useState("");
  const[cloneTargetYear,setCloneTargetYear]=useState("");
  const[editingMeta,setEditingMeta]=useState(null); // {segKey, dim}
  const[editMetaVal,setEditMetaVal]=useState("");
  const[newMetaDim,setNewMetaDim]=useState("");
  const[editingSegVal,setEditingSegVal]=useState(null); // {segKey, dim}
  const[editSegVal,setEditSegVal]=useState("");
  // Grid paste (2026-07-31, per Mo — "copy a row or column in Sheets/Excel and paste it into
  // the Budget Panel"). Tracks which month cell last had focus so a paste event (which only
  // tells you WHAT was on the clipboard, not where the user "meant" to drop it beyond the single
  // focused element) knows where to start filling. A ref, not state — updating it on every
  // month-cell focus shouldn't trigger a re-render, it's only ever read at the moment a paste
  // actually happens.
  const pasteAnchorRef=useRef(null); // {segIdx, monthIdx}
  // Excel-grid interaction state (2026-07-31, per Mo — "as much Excel functionality as I can
  // get"). All of keyboard navigation, range selection, Delete-to-clear, copy-from-grid, and
  // fill-down share this one set of state rather than each owning a private copy, since they're
  // all really facets of "what cell(s) is the user working with right now":
  //   - cellRefs: DOM node per month cell (keyed "segIdx-monthIdx"), so keyboard nav can call
  //     .focus() on a specific cell instead of walking the DOM.
  //   - activeCell (state, triggers re-render): the single cell that's currently focused — drives
  //     the fill-handle's position and the active-cell outline.
  //   - selAnchor + selEnd: a shift-extended range is anchor→end, both state — the render path
  //     (isCellSelected, called from inside cellIn) reads the anchor to compute the highlight, and
  //     refs aren't safe to read during render (React can't track that as a dependency), so this
  //     has to be real state even though every write already happens alongside a selEnd update.
  //   - suppressAnchorResetRef: onFocus normally collapses any selection to "just this cell" (Tab,
  //     a plain click, a plain arrow key all do this in real spreadsheets) — but a shift+click or
  //     shift+arrow needs the anchor to stay put while focus moves to the new end of the range.
  //     This flag is how those two code paths tell the onFocus handler "don't reset this time."
  //   - fillDrag: the in-progress drag-to-fill gesture (see startFillDrag below).
  const cellRefs=useRef({});
  const[activeCell,setActiveCell]=useState(null); // {segIdx,monthIdx}
  const[selAnchor,setSelAnchor]=useState(null); // {segIdx,monthIdx}
  const[selEnd,setSelEnd]=useState(null); // {segIdx,monthIdx} | null
  const suppressAnchorResetRef=useRef(false);
  const[fillDrag,setFillDrag]=useState(null); // {segIdx,monthIdx,value,dragToSegIdx} | null
  // Progressive Ctrl/Cmd+A (2026-07-31, per Mo — matches Excel/Sheets' own escalating behavior):
  // 0 = next press selects just this cell's text (native browser behavior, not intercepted at
  // all); 1 = next press selects the rest of this row (same colType); 2+ = next press selects
  // the whole colType grid. Resets to 0 on any other key or a focus/click move to a different
  // cell (handleCellFocus) — only a run of repeated Ctrl/Cmd+A presses on the SAME cell without
  // any other interaction in between climbs the stages.
  const selectAllStageRef=useRef(0);
  // Undo/redo (2026-07-31, per Mo). Scoped to `budgets` (the money values) specifically, not the
  // segment structure/tags/annotation metadata a row delete also touches — same reasoning as grid
  // paste/selection/fill-down staying scoped to values rather than trying to be a full app-wide
  // undo system. Snapshots are the WHOLE `budgets` object (all years), not just the current one,
  // so undo still works correctly right after a year switch. Capped at 50 steps each way so this
  // can't grow unbounded over a long editing session.
  //
  // historySnapshotTakenRef coalesces a "burst" of plain keystroke edits (typing "12000" fires
  // onChange 5 times) into ONE undo step — it's set the first time a snapshot is pushed, checked
  // (not pushed again) on every subsequent keystroke, and reset back to false whenever focus moves
  // to a different cell (handleCellFocus) or a discrete action (paste/fill/delete/bulk edit) runs
  // and pushes its own always-fresh snapshot.
  const[undoStack,setUndoStack]=useState([]); // budgets snapshots, oldest first
  const[redoStack,setRedoStack]=useState([]);
  const historySnapshotTakenRef=useRef(false);
  // The handler functions that actually DO something with this state (focusCell, handleCellKeyDown,
  // handleGridCopy, startFillDrag, and the fill-drag useEffect) live further down, right before
  // cellIn — they need filteredSegs/getMV/setMV in scope, which aren't declared until later in
  // this component.

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
  // Constrained value lists for the "Campaign"/"Ad Group" pseudo-dimensions — same reasoning as
  // platformValues above (used to populate a real dropdown for the "add segment manually" flow,
  // instead of a free-typed value that could silently never match real spend data).
  const campaignGroupValues=useMemo(()=>[...new Set((mergedNormRows||[]).map(r=>r.campaign_group_name).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),[mergedNormRows]);
  const campaignNameValues=useMemo(()=>[...new Set((mergedNormRows||[]).map(r=>r.campaign_name).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),[mergedNormRows]);
  // Which of the CURRENTLY selected budgetDims are derived vs. real manual tags — drives the
  // "Platform/Campaign/Ad Group is detected automatically" empty-state copy below.
  const derivedActiveDims=useMemo(()=>budgetDims.filter(d=>DERIVED_DIMS.includes(d)),[budgetDims]);
  const manualActiveDims=useMemo(()=>budgetDims.filter(d=>!DERIVED_DIMS.includes(d)),[budgetDims]);

  const segMatchCount=useCallback(segKey=>countSegmentCampaigns(campaignTags,budgetDims,segKey,platformIndex),[budgetDims,campaignTags,platformIndex]);

  const addManualRow=()=>{
    if(!canEdit||isRolledUp)return;
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
  // Shared row-building for both export targets (CSV download and append-to-Google-Sheet below)
  // — pulled out of exportBudgets so the two paths can't silently drift out of sync on column
  // shape. Returns {header, dataRows} rather than one combined array so a Sheets append can
  // choose to send just dataRows when appending onto a tab that already has a header.
  const buildBudgetExportRows=({includeMonthly=false,includeQuarterly=false}={})=>{
    const pacing=computePacing({mergedNormRows:mergedNormRows||[],tags:campaignTags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date(),budgetRowMeta,defaultForecastModel,combineGoogleChannels});
    const pacingBySeg={};
    pacing.segments.forEach(s=>{pacingBySeg[s.segKey]=s;});
    const actualsByMonth=(includeMonthly||includeQuarterly)?computeActualsByMonth({mergedNormRows:mergedNormRows||[],tags:campaignTags,budgetDims,year,combineGoogleChannels}):{};
    const header=[...budgetDims,...budgetMetaDims,"Currency",...MONTHS.map(m=>m.label),"Total",
      ...(includeMonthly?MONTHS.map(m=>`${m.label} Actual`):[]),
      ...(includeQuarterly?QUARTERS.map(q=>`${q.key} Actual`):[]),
      "Actual Spend","% of Budget Used","Daily Run Rate","Projected Year-End Spend","Projected Variance ($)","Pacing Status"];
    const dataRows=[];
    // Export "what you see" (2026-08-07, per Mo): the current filtered rows at the current view
    // grain — filteredSegs (respects search + filters) and viewBudget (rolled-up totals when a
    // coarser Budget By subset is selected, or the raw stored values in the native view).
    filteredSegs.forEach(seg=>{
      const monthly=viewBudget[seg.key]?.monthly||{};
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
      dataRows.push([...budgetDims.map(d=>seg[d]),...budgetMetaDims.map(d=>meta[d]||""),meta._currency||"USD",...amts,total||"",...monthlyActualCols,...quarterlyActualCols,...pacingCols]);
    });
    return{header,dataRows};
  };
  const exportBudgets=({includeMonthly=false,includeQuarterly=false}={})=>{
    const{header,dataRows}=buildBudgetExportRows({includeMonthly,includeQuarterly});
    downloadCSV([header,...dataRows],`paidhq-budgets-pacing-${year}.csv`);
    showNotif("Budgets + pacing snapshot exported");
  };
  // Append-to-existing-Google-Sheet (2026-07-31, per Mo — "instead of always creating a new
  // file"). Reuses pickSpreadsheet()'s Picker flow (same drive.file grant as the rest of the
  // Sheets integration) so the user chooses an existing spreadsheet, then appendRowsToGoogleSheet
  // writes into a named tab within it — creating that tab if it doesn't exist yet, or just
  // appending rows after whatever's already there if it does.
  const[sheetsAppending,setSheetsAppending]=useState(false);
  const[appendTabName,setAppendTabName]=useState("");
  const appendBudgetToGoogleSheet=async()=>{
    setSheetsAppending(true);
    try{
      const picked=await pickSpreadsheet();
      if(!picked){setSheetsAppending(false);return;} // user closed the picker
      const{header,dataRows}=buildBudgetExportRows({includeMonthly:exportIncludeMonthly,includeQuarterly:exportIncludeQuarterly});
      const tabName=(appendTabName||`Budget ${year}`).trim()||`Budget ${year}`;
      const result=await appendRowsToGoogleSheet(picked.id,tabName,header,dataRows);
      showNotif(`Appended ${dataRows.length} row${dataRows.length===1?"":"s"} to "${picked.name}" → ${tabName}${result.createdTab?" (new tab)":""}`);
      setExportPreviewOpen(false);
    }catch(e){
      console.error("[budget append to sheet]",e);
      window.alert(e.message||"Couldn't append to that Google Sheet. Try again.");
    }finally{
      setSheetsAppending(false);
    }
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
      const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...authHeader(session)},body:JSON.stringify({prompt,maxTokens:300})});
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
    if(!canEdit||isRolledUp)return;
    if(!applyMetaDim||!applyMetaVal||!selRows.size)return;
    setBudgetRowMeta(p=>{const nx={...p};selRows.forEach(k=>{nx[k]={...(nx[k]||{}),[applyMetaDim]:applyMetaVal};});return nx;});
    showNotif(`Tagged ${selRows.size} rows — ${applyMetaDim}: ${applyMetaVal}`);
    setSelRows(new Set());setApplyMetaVal("");
  };
  const saveMetaEdit=()=>{
    if(!canEdit||isRolledUp)return;
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
    if(!canEdit||isRolledUp)return;
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
    if(!canEdit||isRolledUp)return;
    const matchCount=countSegmentCampaigns(campaignTags,budgetDims,segKey,platformIndex);
    const tagNote=matchCount>0?` This also un-tags ${matchCount} matching campaign${matchCount>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete "${label}"?\n\nThis removes all monthly budget values for this row.${tagNote}`))return;
    commitHistorySnapshot(); // undo restores the budget amounts; the un-tag/metadata cleanup below isn't covered
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
    if(!canEdit||isRolledUp)return;
    setBudgetRowMeta(p=>{
      const nx={...p};
      const cur={...(nx[segKey]||{})};
      if(cur._notBudgeted)delete cur._notBudgeted;else cur._notBudgeted=true;
      nx[segKey]=cur;
      return nx;
    });
  };
  const getRowCurrency=segKey=>(budgetRowMeta[segKey]||{})._currency||"";
  const setRowCurrency=(segKey,code)=>{
    if(!canEdit||isRolledUp)return;
    setBudgetRowMeta(p=>{
      const nx={...p};
      const cur={...(nx[segKey]||{})};
      if(code)cur._currency=code;else delete cur._currency;
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
    if(!canEdit||isRolledUp)return;
    if(!selRows.size)return;
    const n=selRows.size;
    const totalMatches=[...selRows].reduce((s,k)=>s+countSegmentCampaigns(campaignTags,budgetDims,k,platformIndex),0);
    const tagNote=totalMatches>0?` This also un-tags ${totalMatches} matching campaign${totalMatches>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete ${n} segment${n>1?"s":""}?\n\nThis removes all monthly budget values for ${n>1?"these rows":"this row"}.${tagNote}`))return;
    commitHistorySnapshot(); // undo restores the budget amounts; the un-tag/metadata cleanup below isn't covered
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(nx[year])selRows.forEach(k=>{delete nx[year][k];});return nx;});
    setBudgetRowMeta(p=>{const nx={...p};selRows.forEach(k=>delete nx[k]);return nx;});
    setTags?.(p=>{let nt=p;selRows.forEach(k=>{nt=untagSegmentCampaigns(nt,budgetDims,k,platformIndex);});return nt;});
    showNotif(`Deleted ${n} segment${n>1?"s":""}${totalMatches>0?` — un-tagged ${totalMatches} campaign${totalMatches>1?"s":""}`:""}`);
    setSelRows(new Set());
  };
  // Bulk % increase/decrease (2026-07-31, per Mo). Scales every existing monthly value on each
  // selected row by (1+pct/100) — e.g. -10 trims a row 10% across the board, +15 pads it. Only
  // touches months that already have a value (blank cells stay blank, not "0 * pct = 0"), and
  // deliberately leaves quarterly/annual caps untouched — those are limits the user set
  // separately, not part of "the budget" being scaled here. One setBudgets pass over all
  // selected rows (mirroring bulkDeleteSelected's approach) rather than calling setMV in a loop,
  // so this is one undo step and one re-render regardless of selection size.
  const bulkAdjustPct=()=>{
    if(!canEdit||isRolledUp)return;
    const pct=parseFloat(bulkPct);
    if(!selRows.size||!bulkPct.trim()||isNaN(pct))return;
    commitHistorySnapshot();
    setBudgets(p=>{
      const nx=JSON.parse(JSON.stringify(p));
      if(!nx[year])return nx;
      selRows.forEach(k=>{
        const row=nx[year][k];
        if(!row||!row.monthly)return;
        Object.keys(row.monthly).forEach(mk=>{
          const n=parseMoney(row.monthly[mk]);
          if(n===null)return;
          row.monthly[mk]=Math.round(n*(1+pct/100)*100)/100;
        });
      });
      return nx;
    });
    showNotif(`${pct>=0?"Increased":"Decreased"} ${selRows.size} row${selRows.size>1?"s":""} by ${Math.abs(pct)}%`);
    setBulkPct("");
  };
  // Clone a year's budget structure + values into a new year (2026-07-31, per Mo — "instead of
  // rebuilding from scratch"). Deep-copies the whole per-year object (monthly, quarterly cap,
  // annual cap for every segment) as-is; pairs naturally with the bulk-% adjuster above for the
  // common "start from last year, then trim/pad by X%" workflow. `toYear` isn't restricted to the
  // 3-button year switcher — it's a free-typed 4-digit year, since planning often runs ahead of
  // the fixed prev/current/next window that switcher shows.
  const cloneYearInto=(fromYear,toYearRaw)=>{
    if(!canEdit)return;
    const toYear=(toYearRaw||"").trim();
    if(!/^\d{4}$/.test(toYear)){showNotif("Enter a valid 4-digit year to clone into");return;}
    if(toYear===fromYear){showNotif("Pick a different year to clone into");return;}
    const fromData=budgets[fromYear];
    const fromCount=fromData?Object.keys(fromData).length:0;
    if(!fromCount){showNotif(`${fromYear} has no budget data to clone`);return;}
    const existingCount=budgets[toYear]?Object.keys(budgets[toYear]).length:0;
    if(existingCount>0&&!window.confirm(`${toYear} already has ${existingCount} budgeted row${existingCount>1?"s":""}. Overwrite it with a copy of ${fromYear}'s budget (${fromCount} row${fromCount>1?"s":""})?`))return;
    commitHistorySnapshot();
    setBudgets(p=>{
      const nx=JSON.parse(JSON.stringify(p));
      nx[toYear]=JSON.parse(JSON.stringify(fromData));
      return nx;
    });
    showNotif(`Cloned ${fromYear}'s budget into ${toYear} — ${fromCount} row${fromCount>1?"s":""}`);
    setCloneTargetYear("");
    setYear(toYear);
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
      const vals=budgetDims.map(d=>resolveBudgetDimValue(d,ck,t,platformIndex));
      if(vals.some(v=>!v))return;
      const key=vals.join("|");
      if(!seen.has(key)){seen.add(key);const c={key};budgetDims.forEach((d,i)=>{c[d]=vals[i];});out.push(c);}
    });
    // Source 2: budget data at the current view grain (viewBudget = budgets[year] natively, or the
    // rolled-up aggregate when a coarser subset of the grain is selected) — so imported/rolled
    // budgets show even if not yet tagged.
    Object.keys(viewBudget).forEach(key=>{
      if(seen.has(key))return;
      const vals=key.split("|");
      if(vals.length!==budgetDims.length)return;
      seen.add(key);const c={key};
      budgetDims.forEach((d,i)=>{c[d]=vals[i]||"—";});
      out.push(c);
    });
    return out.sort((a,b)=>a.key.localeCompare(b.key));
  },[budgetDims,campaignTags,viewBudget,mergedNormRows,platformIndex]);

  // Reads go through viewBudget so a rolled-up view returns summed totals; the native view returns
  // the stored value unchanged (viewBudget === budgets[year] there).
  const getMV=useCallback((sk,mk)=>viewBudget[sk]?.monthly?.[mk]??"",[viewBudget]);
  const getQC=useCallback((sk,qk)=>viewBudget[sk]?.quarterly?.[qk]??"",[viewBudget]);
  const getAC=useCallback(sk=>viewBudget[sk]?.annual??"",[viewBudget]);
  // setBudgets added to these three deps arrays (2026-08-07, lint cleanup) — it's the plain
  // useState setter passed down from PaidHQ.jsx (see its `const[budgets,setBudgets]=useState({})`),
  // so its identity is stable across renders per React's own guarantee; listing it satisfies
  // exhaustive-deps with zero behavior change.
  // isRolledUp guard (2026-08-07): in a rolled-up view the cells are read-only summed totals, so no
  // writes should land (also protects paste/fill/import paths that call these directly).
  const setMV=useCallback((sk,mk,v)=>{if(!canEdit||isRolledUp)return;const n=parseMoney(v);setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][sk])nx[year][sk]={};if(!nx[year][sk].monthly)nx[year][sk].monthly={};if(n===null)delete nx[year][sk].monthly[mk];else nx[year][sk].monthly[mk]=n;return nx;});},[year,canEdit,isRolledUp,setBudgets]);
  const setQC=useCallback((sk,qk,v)=>{if(!canEdit||isRolledUp)return;const n=parseMoney(v);setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][sk])nx[year][sk]={};if(!nx[year][sk].quarterly)nx[year][sk].quarterly={};if(n===null)delete nx[year][sk].quarterly[qk];else nx[year][sk].quarterly[qk]=n;return nx;});},[year,canEdit,isRolledUp,setBudgets]);
  const setAC=useCallback((sk,v)=>{if(!canEdit||isRolledUp)return;const n=parseMoney(v);setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][sk])nx[year][sk]={};if(n===null)delete nx[year][sk].annual;else nx[year][sk].annual=n;return nx;});},[year,canEdit,isRolledUp,setBudgets]);
  const rowTotal=useCallback(sk=>Object.values(viewBudget[sk]?.monthly||{}).reduce((s,v)=>s+(v||0),0),[viewBudget]);
  // Segments filtered + sorted (2026-07-31, per Mo — "stronger filter and sort... like the
  // campaign tagger"). Drives what's visible, what "select all" selects, and what a bulk
  // delete/adjust targets. Covers both the primary budgetDims (e.g. Product, stored on the
  // segment itself) and any annotation dimensions added as budgetMetaDims (e.g. Region, Pillar —
  // stored in budgetRowMeta per segment) uniformly, since both are just "a named field on this
  // row" from the filter/sort's point of view. Placed after rowTotal (rather than up where the
  // old plain-substring version lived) since sorting/filtering by "Total" needs it.
  //
  // Include/exclude use the exact same splitFilterTerms/matchesTerms comma-separated-terms +
  // AND/OR-mode matching Campaign Tagger's filters already use, not a fresh implementation —
  // same UX in both places, and "row1, row2" style multi-value filtering that a plain substring
  // match couldn't do.
  const filteredSegs=useMemo(()=>{
    const allDims=[...budgetDims,...budgetMetaDims];
    // Toolbar search (2026-08-07) — a single free-text box ORed across every dim/meta value on
    // the row, same "any field, any of these comma-terms" spirit as the per-dimension Filters
    // panel below but scoped to one quick box instead of opening that panel, matching the
    // reference screenshot's single Search field.
    const searchLower=budgetSearchQuery.trim().toLowerCase();
    let r=segs.filter(seg=>{
      const meta=budgetRowMeta[seg.key]||{};
      if(hideNotBudgeted&&meta._notBudgeted)return false;
      if(searchLower){
        const hit=allDims.some(d=>((budgetDims.includes(d)?seg[d]:meta[d])||"").toLowerCase().includes(searchLower));
        if(!hit)return false;
      }
      for(const d of allDims){
        const val=(budgetDims.includes(d)?seg[d]:meta[d])||"";
        const valLower=val.toLowerCase();
        const incl=(segFilters[d]||"").trim();
        if(incl){
          const terms=splitFilterTerms(incl);
          if(terms.length&&!matchesTerms(valLower,terms,segFilterInclMode[d]||"or"))return false;
        }
        const excl=(segFiltersExclude[d]||"").trim();
        if(excl){
          const terms=splitFilterTerms(excl);
          if(terms.length&&matchesTerms(valLower,terms,segFilterExclMode[d]||"or"))return false;
        }
      }
      if(totalMin&&rowTotal(seg.key)<parseFloat(totalMin))return false;
      if(totalMax&&rowTotal(seg.key)>parseFloat(totalMax))return false;
      return true;
    });
    if(budgetSortCol){
      r=[...r].sort((a,b)=>{
        if(budgetSortCol==="_total"){
          const av=rowTotal(a.key),bv=rowTotal(b.key);
          return budgetSortDir==="asc"?av-bv:bv-av;
        }
        const aMeta=budgetRowMeta[a.key]||{},bMeta=budgetRowMeta[b.key]||{};
        const av=(budgetDims.includes(budgetSortCol)?a[budgetSortCol]:aMeta[budgetSortCol])||"";
        const bv=(budgetDims.includes(budgetSortCol)?b[budgetSortCol]:bMeta[budgetSortCol])||"";
        return budgetSortDir==="asc"?av.localeCompare(bv):bv.localeCompare(av);
      });
    }
    return r;
  },[segs,budgetDims,budgetMetaDims,budgetRowMeta,segFilters,segFiltersExclude,segFilterInclMode,segFilterExclMode,totalMin,totalMax,hideNotBudgeted,budgetSortCol,budgetSortDir,rowTotal,budgetSearchQuery]);
  const hasSegFilters=Object.values(segFilters).some(v=>(v||"").trim())||Object.values(segFiltersExclude).some(v=>(v||"").trim())||!!totalMin||!!totalMax;
  const clearSegFilters=()=>{setSegFilters({});setSegFiltersExclude({});setTotalMin("");setTotalMax("");setBudgetPage(1);};
  // Pagination (2026-08-07) — derived at render time rather than via a reset-effect: budgetPage
  // is clamped into range here instead of a useEffect that would fire setBudgetPage during every
  // edit (rowTotal-based Year Total filters can reclassify a segment in/out of filteredSegs while
  // someone's mid-edit in a cell, and an effect-driven page reset there would yank focus off the
  // cell they're typing in). Self-corrects every render with no extra state.
  const budgetTotalPages=Math.max(1,Math.ceil(filteredSegs.length/budgetPageSize));
  const budgetCurrentPage=Math.min(budgetPage,budgetTotalPages);
  const budgetPageStart=(budgetCurrentPage-1)*budgetPageSize;
  const budgetPageEnd=budgetPageStart+budgetPageSize;
  // Page-number list with an ellipsis for gaps once there are more pages than fit comfortably —
  // always shows first/last plus a window around the current page, same pattern as the reference
  // screenshot's "1 2 3 4 5 … 10".
  const budgetPageNumbers=useMemo(()=>{
    const total=budgetTotalPages,cur=budgetCurrentPage;
    if(total<=7)return Array.from({length:total},(_,i)=>i+1);
    const keep=new Set([1,2,total-1,total,cur-1,cur,cur+1]);
    const sorted=[...keep].filter(p=>p>=1&&p<=total).sort((a,b)=>a-b);
    const out=[];
    sorted.forEach((p,i)=>{if(i>0&&p-sorted[i-1]>1)out.push("…");out.push(p);});
    return out;
  },[budgetTotalPages,budgetCurrentPage]);
  const doBudgetSort=col=>{setBudgetSortDir(budgetSortCol===col&&budgetSortDir==="desc"?"asc":"desc");setBudgetSortCol(col);};
  const qTotal=useCallback((sk,q)=>q.months.reduce((s,m)=>s+(viewBudget[sk]?.monthly?.[m]||0),0),[viewBudget]);
  const qOver=useCallback((sk,q)=>{const c=parseMoney(getQC(sk,q.key));return c!==null&&qTotal(sk,q)>c;},[getQC,qTotal]);
  const aOver=useCallback(sk=>{const c=parseMoney(getAC(sk));return c!==null&&rowTotal(sk)>c;},[getAC,rowTotal]);
  const totalY=useMemo(()=>segs.reduce((s,sg)=>s+rowTotal(sg.key),0),[segs,rowTotal]);
  // Chart card data (2026-08-07, per Mo's reference screenshot — a headline-number + line-chart
  // card above the segments table, matching Venture's "Sales Revenues" Analytics card). Budgeted
  // $ by month/quarter across the CURRENT filtered segment set — same rows the table below shows
  // — so the chart and table never disagree about what's included.
  const[chartGranularity,setChartGranularity]=useState("month"); // "month" | "quarter"
  const chartMonthlyData=useMemo(()=>MONTHS.map(m=>({
    period:m.label,
    Budgeted:filteredSegs.reduce((s,sg)=>s+(viewBudget[sg.key]?.monthly?.[m.key]||0),0),
  })),[filteredSegs,viewBudget]);
  const chartQuarterlyData=useMemo(()=>QUARTERS.map(q=>({
    period:q.key,
    Budgeted:q.months.reduce((s,mk)=>s+filteredSegs.reduce((ss,sg)=>ss+(viewBudget[sg.key]?.monthly?.[mk]||0),0),0),
  })),[filteredSegs,viewBudget]);
  const chartData=chartGranularity==="quarter"?chartQuarterlyData:chartMonthlyData;
  const chartTotal=useMemo(()=>chartMonthlyData.reduce((s,d)=>s+d.Budgeted,0),[chartMonthlyData]);
  // Prior-year comparison for the trend badge, same filtered segment set against last year's
  // budgets — only meaningful (and only rendered) once the prior year actually has something
  // budgeted to compare against, so a workspace's first-ever budgeted year doesn't show a
  // nonsensical "+Infinity%" or divide-by-zero artifact.
  const prevYearTotal=useMemo(()=>{
    const py=String(Number(year)-1);
    // Sum the entire prior year (grain-independent) rather than by current segKey — the current
    // view's keys may be rolled-up viewKeys that don't exist under last year's raw budgets.
    return Object.values(budgets[py]||{}).reduce((s,v)=>s+Object.values(v?.monthly||{}).reduce((ss,x)=>ss+(x||0),0),0);
  },[budgets,year]);
  const chartDeltaPct=prevYearTotal>0?Math.round(((chartTotal-prevYearTotal)/prevYearTotal)*100):null;
  const dimCount=d=>d==="Platform"?platformValues.length:d==="Campaign"?campaignGroupValues.length:d==="Ad Group"?campaignNameValues.length:[...new Set(Object.values(campaignTags||{}).map(t=>t[d]).filter(Boolean))].length;
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
  // Grid paste (2026-07-31, per Mo — "copy a row or column in Sheets/Excel and paste it into
  // the Budget Panel"). Lives on the scrollable table wrapper so a paste bubbles up to it
  // regardless of which cell had focus. Two branches, chosen by WHAT was focused when the paste
  // landed, not by inspecting clipboard content up front (a segKey Pill and a month amount cell
  // demand very different handling and there's no reliable way to tell them apart from the text
  // alone — e.g. "1200" is a plausible product name in some org's naming and a plausible dollar
  // figure, so the anchor is the source of truth, not a heuristic over the pasted text):
  //   - Pasting into a segment's dimension cell (editingSegVal is set — see the Pill's onClick a
  //     few hundred lines down) almost always means "these are new Brand/Product rows copied
  //     straight out of Sheets," not "rename this one cell" — a single-value paste still renames
  //     in place (falls through, does nothing here, browser handles it), but a multi-cell block
  //     gets routed into the exact same reviewed import pipeline a CSV/XLSX upload uses
  //     (ingestRawRows → header detection → dimension mapping → preview → merge-review dedup)
  //     rather than this handler trying to guess column mapping itself.
  //   - Pasting into a month amount cell (pasteAnchorRef, set by that cell's onFocus below) fills
  //     across months and down segment rows starting there, Excel-style — but ONLY into rows that
  //     already exist. A pure-numbers paste has no Brand/Product info to create a new row from, so
  //     rows past the end of the table are silently skipped (with a toast explaining why) rather
  //     than guessed at.
  const handleGridPaste=e=>{
    const text=e.clipboardData?.getData("text")||"";
    if(!text.includes("\t")&&!text.includes("\n"))return; // single value — let the browser paste it normally
    const rows=text.replace(/\r/g,"").split("\n");
    while(rows.length&&rows[rows.length-1]===""){rows.pop();}
    if(!rows.length)return;
    const grid=rows.map(r=>r.split("\t"));

    if(editingSegVal){
      e.preventDefault();
      setEditingSegVal(null);setEditSegVal("");
      setImportOpen(true);
      ingestRawRows("Pasted from clipboard",grid);
      return;
    }

    const anchor=pasteAnchorRef.current;
    if(!anchor)return; // paste didn't land on a recognized cell — leave default behavior alone
    e.preventDefault();
    commitHistorySnapshot(); // one undo step for the whole paste, not one per cell it fills
    let filled=0,overflowRows=0,hasText=false;
    grid.forEach((rowCells,ri)=>{
      const seg=filteredSegs[anchor.segIdx+ri];
      if(!seg){if(rowCells.some(c=>c.trim()))overflowRows++;return;}
      rowCells.forEach((cellVal,ci)=>{
        const month=MONTHS[anchor.colIdx+ci];
        if(!month)return; // pasted past December — ignore rather than spilling into quarter/cap columns
        const v=String(cellVal).trim();
        if(v==="")return;
        if(v!=="-"&&isNaN(parseMoney(v))){hasText=true;return;}
        setMV(seg.key,month.key,v);
        filled++;
      });
    });
    if(hasText){
      showNotif("That paste included text, not just numbers — to add new Brand/Product rows, paste starting on a dimension cell instead.");
    }else if(overflowRows>0){
      showNotif(`Pasted into ${filled} cell${filled===1?"":"s"} — ${overflowRows} row${overflowRows===1?"":"s"} past the end of the table were skipped.`);
    }else if(filled){
      showNotif(`Pasted ${filled} value${filled===1?"":"s"}.`);
    }
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
  // Naming/archiving into File Store (2026-08-06, per Mo — "save the files I upload... apply/
  // import them into PaidHQ with one click") happens up-front via promptAndArchiveFile at this
  // function's call site below, before handleImportFile itself runs — same choke-point pattern
  // PaidHQ.jsx's own spend/tag/pipeline import entry points use. No config sidecar is captured for
  // budget imports in this first pass (unlike spend/pipeline) — this wizard's own header/format/
  // dimension-mapping detection (ingestRawRows below) always restarts fresh on a reloaded file, so
  // "Apply" on a saved budget file re-opens this same review wizard rather than skipping it
  // pre-filled. Re-confirming the mapping once more per file was judged an acceptable trade-off
  // against the much larger surgery full replay of iFmt/dimMap/periodCol/amtCol/etc. would need.
  const handleImportFile=file=>{
    if(!file)return;
    parseFileToRows(file,rawRows=>ingestRawRows(file.name,rawRows));
  };

  // Handoff from the unified Data Sources uploader (2026-08-01, per Mo — "Spend, Budget or
  // Performance file" classifies a file as "budget" and sends it here instead of re-implementing
  // this whole wizard a second time). BudgetManager is kept permanently mounted (see the doc
  // comment at its render site in PaidHQ.jsx) rather than getting a fresh mount at handoff time the
  // way ReportingAnalyzer/AskAI's one-shot relays do — so unlike those, this genuinely IS "react to
  // a later prop change on an already-mounted instance," not "seed initial state," and can't be
  // rewritten as a lazy useState initializer. setImportOpen(true) is required in addition to
  // ingestRawRows — ingestRawRows only sets the wizard's internal step/rows state, it doesn't open
  // the modal itself (confirmed against the grid-paste-into-dimension-cell call site above, which
  // pairs the two the same way). Same justified exception as PacingDashboard's initialViewConfig
  // effect — see its doc comment for the general reasoning.
  /* eslint-disable react-hooks/set-state-in-effect -- external handoff on an always-mounted
     component reacting to a prop change, not a prop-into-state sync; see doc comment above. */
  useEffect(()=>{
    if(!initialImportFile)return;
    setImportOpen(true);
    parseFileToRows(initialImportFile,rawRows=>ingestRawRows(initialImportFile.name,rawRows));
    onConsumeInitialImportFile?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[initialImportFile]);
  /* eslint-enable react-hooks/set-state-in-effect */
  // Parses the vision model's "JSON array of row arrays" response, tolerating the case where the
  // response got cut off mid-row before finishing (2026-07-31, per a real failure Mo hit on a
  // large multi-brand budget table — "Unterminated string in JSON at position 6451" surfaced as a
  // raw parse error instead of a usable result). A straight JSON.parse is tried first; if that
  // fails, every COMPLETE `[...]` row is salvaged individually — each row is a flat array of
  // strings with no nested brackets, so a balanced-bracket regex reliably finds every row that
  // finished before the cutoff and skips only the one row (if any) that was mid-write when the
  // response ran out of room. Returns however many complete rows it found, so a big table degrades
  // to "most of the table, with a clear heads-up" instead of an all-or-nothing failure.
  const parseTruncatedGridJSON=text=>{
    const cleaned=String(text||"").replace(/```json|```/g,"").trim();
    try{
      const direct=JSON.parse(cleaned);
      if(Array.isArray(direct))return{rows:direct,truncated:false};
    }catch{/* fall through to salvage */}
    const rowMatches=cleaned.match(/\[(?:[^[\]]|\\.)*\]/g)||[];
    const rows=[];
    rowMatches.forEach(m=>{try{const row=JSON.parse(m);if(Array.isArray(row))rows.push(row);}catch{/* skip the row that was cut off mid-write */}});
    return{rows,truncated:true};
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
        const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...authHeader(session)},body:JSON.stringify({
          messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mediaType,data:base64}},{type:"text",text:prompt}]}],
          // Was 4000 — too tight for a wide, many-row table (e.g. a multi-brand budget with 15+
          // columns and dozens of rows easily runs past that as JSON), which produced a response
          // truncated mid-row and a raw "Unterminated string in JSON" parse error instead of a
          // usable result. 8000 covers meaningfully larger tables; parseTruncatedGridJSON above is
          // the backstop for whatever still doesn't fit in one pass.
          maxTokens:8000,
        })});
        const data=await res.json();
        if(!res.ok)throw new Error(data?.error||"Screenshot analysis failed");
        const{rows:parsed,truncated}=parseTruncatedGridJSON(data.text);
        if(!Array.isArray(parsed)||!parsed.length)throw new Error("Couldn't read a table from that screenshot — try a clearer image or a wider crop.");
        const rawRows=parsed.map(row=>Array.isArray(row)?row.map(v=>String(v??"")):[String(row??"")]);
        ingestRawRows(file.name,rawRows);
        if(truncated||data.stop_reason==="max_tokens"){
          showNotif(`Transcribed ${rawRows.length} rows — this table may be too large to read in one pass. Check the end of the preview, and if rows are missing, crop a screenshot of just the remaining ones and import again.`);
        }
      }catch(err){
        setScreenshotImportError(err.message);
      }finally{
        setScreenshotImporting(false);
      }
    };
    reader.onerror=()=>{setScreenshotImportError("Could not read image file");setScreenshotImporting(false);};
    reader.readAsDataURL(file);
  };
  // Keep the latest handleImportScreenshot in a ref so the paste effect below can call it without
  // listing it as a dependency — that avoids both the exhaustive-deps warning and a stale-closure
  // bug (the handler would otherwise capture whatever version existed when the effect last ran on
  // an importOpen/iStep change, missing state that changed while the modal stayed open).
  const handleImportScreenshotRef=useRef(handleImportScreenshot);
  useEffect(()=>{handleImportScreenshotRef.current=handleImportScreenshot;});
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
      handleImportScreenshotRef.current(file);
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
    if(!canEdit||isRolledUp)return;
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
    // Import history log (2026-07-31, per Mo — "nothing's retained today once the import modal
    // closes"). doImport is the single choke point every import source (CSV, XLSX, screenshot,
    // Google Sheet pull, and grid-paste-into-new-segments) already funnels through via the shared
    // ingestRawRows -> preview -> beginImport pipeline, so logging here covers all of them
    // uniformly without threading a "source" param through each entry point separately —
    // iFileName already carries a source-appropriate label from whichever entry point set it
    // (a real filename, a sheet's tab title, or "Pasted from clipboard").
    //
    // Piggybacks on budgetImportMeta (an existing jsonb field already wired into whatever
    // top-level save path persists workspace_config) under a reserved `_log` key, rather than
    // standing up a new DB table/migration/API route for what's fundamentally the same kind of
    // per-workspace import metadata this field already stores — same JSONB-first reasoning
    // db/schema.sql's own doc comment gives for keeping budgets/tags unnormalized. Capped at 200
    // entries so this can't grow unbounded over a long account's lifetime.
    const importedAt=Date.now();
    const logEntry={ts:importedAt,year:iYear,source:iFileName||"Unknown source",entryCount:preview.length,segmentCount:new Set(preview.map(e=>e.segKey)).size,mergedCount:mergeDecisions.length};
    setBudgetImportMeta?.(p=>({...p,[iYear]:{hasQuarterlyTotals,hasAnnualTotal,importedAt},_log:[logEntry,...(p?._log||[])].slice(0,200)}));
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
        const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...authHeader(session)},body:JSON.stringify({prompt,maxTokens:1200})});
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
      // Escaping note (2026-08-07, lint cleanup): this is a template literal (backtick string),
      // where only backtick / ${ / backslash need escaping — plain " needs none at all. The
      // \" throughout the JSON-shape example below were leftover from an earlier plain-string
      // version of this prompt and were flagged by no-useless-escape; removed here (same string
      // value either way — " and \" are identical characters inside a template literal, this is
      // a pure lint fix, not a content change).
      const prompt=`Analyze this complete budget spreadsheet and return a JSON mapping.\n\nUser's existing tag dimensions: ${(tagDimensions||[]).join(", ")}\n\nComplete file data (${sample.length} rows, up to 20 columns shown — file has ${iRawRows[0]?.length||0} total columns):\n${sample.map((row,i)=>`Row ${i+1}: ${row.map(v=>v.replace(/#REF!/g,"0")).join(" | ")}`).join("\n")}\n\nReturn ONLY this JSON object (no markdown):\n{\n  "headerRow": <0-based row index of the main column header row>,\n  "groupHeaderRow": <row index of a channel/platform grouping row ABOVE the main header that groups columns, or -1 if none>,\n  "groupDimension": <name for the group dimension e.g. "Channel" or null>,\n  "skipPattern": <substring in subtotal/total rows to skip, or "">,\n  "format": "wide", "long", "transposed", or "flat",\n  "segmentDimension": <for transposed: name for the campaign column dimension e.g. "Campaign">,\n  "dimensions": [{"name": <existing dim name>, "column": <exact column header>}],\n  "newDimensions": [{"name": <new dim name>, "column": <exact column header>}],\n  "periodColumn": <for long format: period column, else null>,\n  "amountColumn": <for long or flat format: amount column, else null>,\n  "hasQuarterlyCaps": <true/false>,\n  "hasAnnualCap": <true/false>\n}\nFormat rules: wide=month names as column headers; transposed=months as rows + campaigns as columns (if a row ABOVE the header groups columns into channels set groupHeaderRow); long=one row per period with an explicit period/date column; flat=one row per segment with a single recurring monthly amount column (e.g. "Monthly Budget") and NO period/date column and NO per-month columns — do not force this into "long" just because there's a column with "month" in its name, that column IS the amount column, not a period. Existing dimensions to map: ${(tagDimensions||[]).join(", ")}`;

      const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...authHeader(session)},body:JSON.stringify({prompt})});
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

  // Excel-grid interaction handlers (2026-07-31, per Mo — "as much Excel functionality as I can
  // get"). Placed here rather than up with the state block near pasteAnchorRef because these all
  // need filteredSegs/getMV/setMV/getQC/setQC/getAC/setAC in scope, which aren't declared until
  // above this point.
  //
  // Generalized (2026-07-31, same session, per Mo's follow-up ask to also cover the quarterly-cap
  // and annual-cap columns) from a month-only {segIdx,monthIdx} model to {segIdx,colType,colIdx},
  // where colType is "month"|"quarter"|"annual". Selection/keyboard-nav/fill-down deliberately
  // stay WITHIN one colType — a range or a fill-drag can't span from, say, December into a
  // quarterly cap column, since those are different kinds of values (spend vs. a cap), not
  // adjacent cells of the same series. Paste stays month-only regardless (see handleGridPaste's
  // doc comment) — pasteAnchorRef is only ever set when focus is on a month cell.
  // Pushes the CURRENT `budgets` (pre-edit) onto the undo stack and clears the redo stack (a new
  // edit invalidates whatever was previously redoable — standard undo/redo semantics). Called
  // right before a mutation, not after, so what's on the stack is always "what to restore to get
  // back to before this edit."
  const commitHistorySnapshot=useCallback(()=>{
    setUndoStack(s=>[...s.slice(-49),budgets]);
    setRedoStack([]);
    historySnapshotTakenRef.current=true;
  },[budgets]);
  const handleUndo=()=>{
    if(!undoStack.length||!canEdit)return;
    const prev=undoStack[undoStack.length-1];
    setUndoStack(s=>s.slice(0,-1));
    setRedoStack(s=>[...s,budgets]);
    setBudgets(prev);
  };
  const handleRedo=()=>{
    if(!redoStack.length||!canEdit)return;
    const next=redoStack[redoStack.length-1];
    setRedoStack(s=>s.slice(0,-1));
    setUndoStack(s=>[...s,budgets]);
    setBudgets(next);
  };
  // Catches Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z bubbling up from anywhere in the grid area (a focused
  // cell, the bulk-action bar's buttons, etc.) rather than a document-level listener — scopes undo
  // to "while working in this panel" for free, without needing to track whether this tab is the
  // currently-active one (BudgetManager stays mounted across tab switches).
  const handleGridKeyDown=e=>{
    if(!(e.metaKey||e.ctrlKey)||(e.key!=="z"&&e.key!=="Z"))return;
    e.preventDefault();
    if(e.shiftKey)handleRedo();else handleUndo();
  };
  const colCount=colType=>colType==="month"?MONTHS.length:colType==="quarter"?QUARTERS.length:1;
  const getColVal=(colType,seg,colIdx)=>{
    if(!seg)return"";
    if(colType==="month")return getMV(seg.key,MONTHS[colIdx].key);
    if(colType==="quarter")return getQC(seg.key,QUARTERS[colIdx].key);
    return getAC(seg.key);
  };
  const setColVal=useCallback((colType,seg,colIdx,v)=>{
    if(colType==="month")setMV(seg.key,MONTHS[colIdx].key,v);
    else if(colType==="quarter")setQC(seg.key,QUARTERS[colIdx].key,v);
    else setAC(seg.key,v);
  },[setMV,setQC,setAC]);
  const cellKey=(segIdx,colType,colIdx)=>`${segIdx}-${colType}-${colIdx}`;
  const focusCell=ctx=>{
    if(!filteredSegs[ctx.segIdx]||ctx.colIdx<0||ctx.colIdx>=colCount(ctx.colType))return false;
    const el=cellRefs.current[cellKey(ctx.segIdx,ctx.colType,ctx.colIdx)];
    if(el)el.focus();
    return true;
  };
  // Normalizes anchor+end into a rectangle, or null if there's no real multi-cell range (nothing
  // shift-extended yet, a shift gesture landed back on its own starting cell, or the anchor/end
  // ended up on different colTypes — which shouldn't normally happen since nav/shift-click both
  // keep the pair on one colType, but this is the defensive fallback if it ever does).
  const selRect=()=>{
    const a=selAnchor,b=selEnd;
    if(!a||!b||a.colType!==b.colType)return null;
    if(a.segIdx===b.segIdx&&a.colIdx===b.colIdx)return null;
    return{colType:a.colType,segIdx0:Math.min(a.segIdx,b.segIdx),segIdx1:Math.max(a.segIdx,b.segIdx),colIdx0:Math.min(a.colIdx,b.colIdx),colIdx1:Math.max(a.colIdx,b.colIdx)};
  };
  const isCellSelected=(segIdx,colType,colIdx)=>{
    const r=selRect();
    return!!r&&r.colType===colType&&segIdx>=r.segIdx0&&segIdx<=r.segIdx1&&colIdx>=r.colIdx0&&colIdx<=r.colIdx1;
  };
  const handleCellFocus=ctx=>{
    pasteAnchorRef.current=ctx.colType==="month"?ctx:null;
    setActiveCell(ctx);
    if(suppressAnchorResetRef.current){suppressAnchorResetRef.current=false;}
    else{setSelAnchor(ctx);setSelEnd(null);}
    historySnapshotTakenRef.current=false; // moving to a new cell starts a fresh undo "burst"
    selectAllStageRef.current=0; // moving to a new cell restarts the Ctrl/Cmd+A progression
  };
  const handleCellMouseDown=(e,ctx)=>{
    if(e.shiftKey&&selAnchor&&selAnchor.colType===ctx.colType){suppressAnchorResetRef.current=true;setSelEnd(ctx);}
    else{setSelAnchor(ctx);setSelEnd(null);}
  };
  const handleCellMouseEnter=ctx=>{
    if(!fillDrag||ctx.colType!==fillDrag.colType)return;
    const dSeg=ctx.segIdx-fillDrag.segIdx,dCol=ctx.colIdx-fillDrag.colIdx;
    // Locks to whichever axis the drag has moved further along — matches the "drag mostly down"
    // vs. "drag mostly right" feel of a real fill handle, rather than requiring a perfectly
    // straight drag. Down-only/right-only (see startFillDrag's doc comment).
    if(Math.abs(dSeg)>=Math.abs(dCol)){
      if(dSeg>=0)setFillDrag(fd=>fd?{...fd,dragToSegIdx:ctx.segIdx,dragToColIdx:fd.colIdx}:fd);
    }else if(dCol>=0){
      setFillDrag(fd=>fd?{...fd,dragToColIdx:ctx.colIdx,dragToSegIdx:fd.segIdx}:fd);
    }
  };
  const handleCellKeyDown=(e,ctx)=>{
    const{segIdx,colType,colIdx}=ctx;
    const input=e.currentTarget;
    const atStart=input.selectionStart===0&&input.selectionEnd===0;
    const atEnd=input.selectionStart===input.value.length&&input.selectionEnd===input.value.length;
    const isSelectAll=(e.metaKey||e.ctrlKey)&&(e.key==="a"||e.key==="A");
    // Any key other than a repeated Ctrl/Cmd+A restarts the progressive select-all below at
    // stage 0 — only an unbroken run of Ctrl/Cmd+A presses on the same cell climbs the stages.
    if(!isSelectAll)selectAllStageRef.current=0;
    const moveTo=(nSegIdx,nColIdx,extend)=>{
      if(!filteredSegs[nSegIdx]||nColIdx<0||nColIdx>=colCount(colType))return;
      e.preventDefault();
      const nCtx={segIdx:nSegIdx,colType,colIdx:nColIdx};
      if(extend){suppressAnchorResetRef.current=true;setSelEnd(nCtx);}
      focusCell(nCtx);
    };
    // Left/Right only move cells when the caret is already at that edge of the text — otherwise
    // they're just normal cursor movement while editing a multi-digit number.
    if(e.key==="ArrowDown"){moveTo(segIdx+1,colIdx,e.shiftKey);return;}
    if(e.key==="ArrowUp"){moveTo(segIdx-1,colIdx,e.shiftKey);return;}
    if(e.key==="ArrowRight"&&atEnd){moveTo(segIdx,colIdx+1,e.shiftKey);return;}
    if(e.key==="ArrowLeft"&&atStart){moveTo(segIdx,colIdx-1,e.shiftKey);return;}
    if(e.key==="Enter"){moveTo(segIdx+(e.shiftKey?-1:1),colIdx,false);return;}
    // Progressive select-all (2026-07-31, per Mo — match Excel/Sheets' escalating Ctrl/Cmd+A):
    // 1st press selects just this cell's text (native browser behavior — don't intercept it at
    // all), 2nd press selects the rest of the current row, 3rd+ press selects the whole colType
    // grid (every row, every column of that one type — not literally everything on screen, since
    // "all of months + all of quarterly caps + the annual cap" in one rectangle doesn't mean
    // anything, they're different units). Stage resets on any other key or a focus/click move to
    // a different cell (handleCellFocus), so this only escalates on an unbroken run of presses.
    if(isSelectAll){
      if(!filteredSegs.length)return;
      const stage=selectAllStageRef.current;
      if(stage===0){
        // Let the browser's own "select all text in this input" happen; just advance the stage
        // so the NEXT press (still on this same cell) escalates to row-select instead.
        selectAllStageRef.current=1;
        return;
      }
      e.preventDefault();
      if(stage===1){
        setSelAnchor({segIdx,colType,colIdx:0});
        setSelEnd({segIdx,colType,colIdx:colCount(colType)-1});
        selectAllStageRef.current=2;
        return;
      }
      setSelAnchor({segIdx:0,colType,colIdx:0});
      setSelEnd({segIdx:filteredSegs.length-1,colType,colIdx:colCount(colType)-1});
      selectAllStageRef.current=3;
      return;
    }
    if(e.key==="Delete"||e.key==="Backspace"){
      const r=selRect();
      if(!r)return; // single cell — let the browser's own text-delete behavior handle it
      e.preventDefault();
      commitHistorySnapshot(); // one undo step for the whole cleared range
      for(let si=r.segIdx0;si<=r.segIdx1;si++){
        const seg=filteredSegs[si];
        if(!seg)continue;
        for(let ci=r.colIdx0;ci<=r.colIdx1;ci++){setColVal(r.colType,seg,ci,"");}
      }
    }
  };
  // Copy-from-grid: only intercepts when a real multi-cell range is selected (selRect()!=null) —
  // a plain single-cell copy falls through to the browser's own "copy the input's text" behavior
  // untouched, same "don't override the common case" posture as handleGridPaste's single-value
  // check.
  const handleGridCopy=e=>{
    const r=selRect();
    if(!r)return;
    e.preventDefault();
    const lines=[];
    for(let si=r.segIdx0;si<=r.segIdx1;si++){
      const seg=filteredSegs[si];
      const cells=[];
      for(let ci=r.colIdx0;ci<=r.colIdx1;ci++){cells.push(seg?String(getColVal(r.colType,seg,ci)??""):"");}
      lines.push(cells.join("\t"));
    }
    e.clipboardData.setData("text/plain",lines.join("\n"));
  };
  // Fill drag handle: mirrors Excel's little square at a cell's bottom-right corner. Drag down
  // within one column, or right within one row, to replicate that cell's value into every
  // cell the drag passes over — deliberately copy-only (no smart series detection) and one
  // direction at a time (see handleCellMouseEnter's axis-lock above), and always confined to a
  // single colType, same reasoning as selection above.
  const startFillDrag=(e,ctx)=>{
    e.preventDefault();e.stopPropagation();
    const seg=filteredSegs[ctx.segIdx];
    if(!seg||ctx.colIdx<0||ctx.colIdx>=colCount(ctx.colType))return;
    setFillDrag({segIdx:ctx.segIdx,colType:ctx.colType,colIdx:ctx.colIdx,value:getColVal(ctx.colType,seg,ctx.colIdx),dragToSegIdx:ctx.segIdx,dragToColIdx:ctx.colIdx});
  };
  useEffect(()=>{
    if(!fillDrag)return;
    const onUp=()=>{
      const seg0=filteredSegs[fillDrag.segIdx];
      const draggedDown=fillDrag.dragToSegIdx>fillDrag.segIdx,draggedRight=fillDrag.dragToColIdx>fillDrag.colIdx;
      if(seg0&&(draggedDown||draggedRight)){
        commitHistorySnapshot(); // one undo step for the whole fill, not one per cell it touches
        if(draggedDown){
          for(let si=fillDrag.segIdx+1;si<=fillDrag.dragToSegIdx;si++){
            const seg=filteredSegs[si];
            if(seg)setColVal(fillDrag.colType,seg,fillDrag.colIdx,fillDrag.value);
          }
        }else{
          for(let ci=fillDrag.colIdx+1;ci<=fillDrag.dragToColIdx;ci++){setColVal(fillDrag.colType,seg0,ci,fillDrag.value);}
        }
      }
      setFillDrag(null);
    };
    document.addEventListener("mouseup",onUp);
    return()=>document.removeEventListener("mouseup",onUp);
  },[fillDrag,filteredSegs,setColVal,commitHistorySnapshot]);

  // gridCtx ({segIdx, colType, colIdx}) is passed for every cell in the month grid AND the
  // quarterly-cap/annual-cap columns (colType "month"|"quarter"|"annual") — keyboard nav,
  // range-select, and fill-down all work across all three; paste alone stays month-only (see
  // handleGridPaste's doc comment and handleCellFocus's pasteAnchorRef line). When present, it
  // wires up the full set: a DOM ref (so keyboard nav can .focus() a specific cell), focus/
  // mousedown/keydown/mouseenter handlers (see the big state block above cellIn's declaration for
  // what each does), a highlight when the cell's inside an active shift-selected range, and — only
  // on the cell that's currently focused — a small drag handle at its bottom-right corner for
  // fill-down/fill-right.
  const cellIn=(val,onChange,over=false,cap=false,gridCtx=null)=>{
    // Rolled-up view = read-only summed totals (per Mo): render the value as static right-aligned
    // text instead of an editable input, since these numbers are the aggregate of finer-grained
    // rows and are only editable at the native grain.
    if(isRolledUp){
      const num=val===""||val==null?null:Number(String(val).replace(/[$,]/g,""));
      return <span style={{display:"block",textAlign:"right",padding:"4px 6px",fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:over?T.danger:cap?T.warning:"#272727",fontFamily:T.font}}>{num?fmt$(num):"—"}</span>;
    }
    const selected=gridCtx&&isCellSelected(gridCtx.segIdx,gridCtx.colType,gridCtx.colIdx);
    const isActive=gridCtx&&activeCell&&activeCell.segIdx===gridCtx.segIdx&&activeCell.colType===gridCtx.colType&&activeCell.colIdx===gridCtx.colIdx;
    const inFillPreview=gridCtx&&fillDrag&&gridCtx.colType===fillDrag.colType&&(
      (fillDrag.dragToSegIdx>fillDrag.segIdx&&gridCtx.colIdx===fillDrag.colIdx&&gridCtx.segIdx>fillDrag.segIdx&&gridCtx.segIdx<=fillDrag.dragToSegIdx)||
      (fillDrag.dragToColIdx>fillDrag.colIdx&&gridCtx.segIdx===fillDrag.segIdx&&gridCtx.colIdx>fillDrag.colIdx&&gridCtx.colIdx<=fillDrag.dragToColIdx)
    );
    // First keystroke in a cell-edit "burst" snapshots pre-edit `budgets` for undo; subsequent
    // keystrokes in the same burst (still the same focused cell) don't push again — see
    // historySnapshotTakenRef's doc comment up at its declaration.
    const handleChange=v=>{
      if(gridCtx&&!historySnapshotTakenRef.current)commitHistorySnapshot();
      onChange(v);
    };
    return(<>
      <input type="text" value={val===""?"":(!isNaN(parseFloat(String(val).replace(/[$,]/g,"")))?`${parseFloat(String(val).replace(/[$,]/g,"")).toLocaleString()}`:val)} onChange={e=>handleChange(e.target.value)} placeholder="—"
        ref={gridCtx?el=>{cellRefs.current[cellKey(gridCtx.segIdx,gridCtx.colType,gridCtx.colIdx)]=el;}:undefined}
        onFocus={gridCtx?()=>handleCellFocus(gridCtx):undefined}
        onMouseDown={gridCtx?e=>handleCellMouseDown(e,gridCtx):undefined}
        onKeyDown={gridCtx?e=>handleCellKeyDown(e,gridCtx):undefined}
        onMouseEnter={gridCtx?()=>handleCellMouseEnter(gridCtx):undefined}
        style={{background:inFillPreview?T.accentBg:selected?T.rowSelected:cap?(over?T.dangerBg:T.warningBg):(over?T.dangerBg:T.inputBg),border:`1px solid ${over?T.danger:cap?T.warningBorder:T.border}`,borderRadius:T.r5,color:over?T.danger:cap?T.warning:"#272727",padding:"4px 6px",fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",width:"100%",boxSizing:"border-box",fontFamily:T.font,textAlign:"right",outline:isActive?`1px solid ${T.accent}`:"none",outlineOffset:-1,display:"block"}}/>
      {isActive&&(
        <div onMouseDown={e=>startFillDrag(e,gridCtx)} title="Drag down or right to fill this value into other cells"
          style={{position:"absolute",bottom:-3,right:-3,width:7,height:7,background:T.accent,border:`1px solid ${T.surface}`,borderRadius:1,cursor:"crosshair",zIndex:2}}/>
      )}
    </>);
  };
  // position:sticky+top:0 freezes the header row while scrolling vertically (2026-07-31, per Mo
  // — "as much Excel functionality as I can get"). zIndex:2 keeps it above the plain body cells
  // (zIndex:1 on the sticky-left dimension columns); the checkbox/budgetDims corner cells below
  // are BOTH top- and left-sticky, so they need a higher zIndex still to stay above every other
  // sticky header cell scrolling underneath them in both directions at once.
  // Header row (2026-08-07, per Mo — "grey with borders, like the reference"): a light-grey fill
  // plus top+bottom hairlines; in card-rows mode the .bhq-cardrows CSS also gives it side borders
  // and rounded ends so it reads as its own bordered bar above the row-cards.
  const TH={fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text,padding:"12px 8px 11px",verticalAlign:"middle",borderTop:`1px solid ${T.border}`,borderBottom:`1px solid ${T.border}`,background:T.surfaceHover,whiteSpace:"nowrap",textAlign:"center",position:"sticky",top:0,zIndex:2};

  // Sortable column-header label (2026-07-31, per Mo) — same click-to-toggle-direction affordance
  // as Campaign Tagger's own SH component (underline + ▾/▴/⇅ indicator), reimplemented locally
  // rather than imported since Tagger's SH is wired to Tagger's fixed column set (col is one of
  // "campaign"/"group"/"spend"/"platform"/"tags") where this one takes any dim name or "_total".
  // A plain function returning JSX (called as budgetHeader(...), not rendered as <BH/>) rather
  // than a component defined inline in the render body — the latter trips
  // react-hooks/static-components (React remounts a fresh component identity every render,
  // losing DOM/focus state), which a directly-invoked helper function doesn't.
  const budgetHeader=(col,label)=>(
    <span onClick={()=>doBudgetSort(col)} title="Click to sort" style={{cursor:"pointer",userSelect:"none",display:"inline-flex",alignItems:"center",gap:3,textDecoration:budgetSortCol===col?"underline":"none",textUnderlineOffset:2}}>
      {label}<span style={{opacity:0.7,fontSize:9*(T.fsScale||1)}}>{budgetSortCol===col?(budgetSortDir==="desc"?"▾":"▴"):"⇅"}</span>
    </span>
  );
  // Same filter-input style Tagger's own `fIn` constant uses, redefined locally rather than
  // shared since it's a plain style object, not worth extracting a component for.
  const fIn={background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,color:T.text,padding:"6px 9px",fontSize:11*(T.fsScale||1),outline:"none",fontFamily:T.font,width:"100%",height:30,boxSizing:"border-box"};

  // Manual "type a row in by hand" control (2026-07-31, per Mo — a blank starting canvas for
  // workspaces that don't want to import a file or wait on Tagger data). Was already fully built
  // as addManualRow/newRowVals, but only ever rendered in the bottom bar below a table that
  // already has at least one row — meaning a brand-new workspace with dimensions picked but zero
  // segments yet had no visible way to just start typing, only "import a file" or "go tag
  // campaigns first." Extracted here so the exact same control can render in that empty state
  // too, instead of duplicating the JSX in two places and risking drift.
  const addSegmentControl=budgetDims.length>0&&canEdit&&!isRolledUp&&(!showAddRow?(
    <Btn onClick={()=>setShowAddRow(true)} variant="ghost" size="sm" T={T} style={{alignSelf:"flex-start"}}>+ Add segment manually</Btn>
  ):(
    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
      {budgetDims.map(d=>DERIVED_DIMS.includes(d)?(
        // Constrained to values actually present in spend data — a free-typed value here
        // ("google" vs the canonical "Google Search", or a mistyped campaign/ad group name)
        // would silently create a segment that never matches real spend, unlike ordinary tag
        // dimensions where that risk is more visible/correctable in the Tagger itself.
        <Sel key={d} value={newRowVals[d]||""} onChange={v=>setNewRowVals(p=>({...p,[d]:v}))} T={T} style={{width:150}}>
          <option value="">{d}…</option>
          {(d==="Platform"?platformValues:d==="Campaign"?campaignGroupValues:campaignNameValues).map(p=><option key={p} value={p}>{p}</option>)}
        </Sel>
      ):(
        <input key={d} value={newRowVals[d]||""} onChange={e=>setNewRowVals(p=>({...p,[d]:e.target.value}))} placeholder={d}
          style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 8px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,width:130}}/>
      ))}
      <Btn onClick={addManualRow} disabled={budgetDims.some(d=>!newRowVals[d]?.trim())} variant="primary" size="sm" T={T}>Add</Btn>
      <Btn onClick={()=>{setShowAddRow(false);setNewRowVals({});}} variant="ghost" size="sm" T={T}>Cancel</Btn>
    </div>
  ));

  return(
    <div style={{display:"flex",height:"100%",background:T.bg,overflow:"hidden"}}>
      {/* Sidebar content now renders via portal into the app-shell's stats sidebar (see sidebarEl) */}
      {/* Sidebar content (2026-08-07, per Mo: "the secondary vertical menu...everything in it is
          based on the old theme") — rebuilt on the real Venture Tailwind primitives (Button/
          Checkbox/Switch/Input from ./ui/) instead of shared.jsx's T-theme Btn/Chk/Tog/<input>.
          Deliberately NOT touching shared.jsx itself — those components are still used file-wide
          by other not-yet-migrated pages. */}
      {sidebarEl&&createPortal(
        <div className="flex flex-col gap-0">
          {/* pb-5 gives the tag-dimension chips real breathing room before the first divider
              (2026-08-07, per Mo). Dividers below use -mx-3.5 to bleed to the full column width
              past the aside's 14px horizontal padding. */}
          <div className="flex flex-col gap-2 pb-5">
            {/* Actions + Budget Year moved to the horizontal bar above the chart (2026-08-07, per
                Mo) — the sidebar keeps only what needs vertical room. */}
            {/* Metadata dimensions */}
            <div>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Annotation Dimensions</div>
              <div className="mb-2 text-xs leading-relaxed text-muted-foreground">Add Pillar, Region, Funnel etc. as columns to annotate budget rows.</div>
              {budgetMetaDims.map(d=>(
                <div key={d} className="flex items-center justify-between py-1">
                  <span className="text-xs text-foreground">{d}</span>
                  <button onClick={()=>setBudgetMetaDims(p=>p.filter(x=>x!==d))} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${d}`}>
                    <XIcon size={12}/>
                  </button>
                </div>
              ))}
              <div className="mt-1.5 flex gap-1.5">
                <Input value={newMetaDim} onChange={e=>setNewMetaDim(e.target.value)} placeholder="e.g. Pillar, Region…" onKeyDown={e=>e.key==="Enter"&&addMetaDim()} className="h-8 text-xs"/>
                <Button onClick={addMetaDim} disabled={!newMetaDim.trim()} variant="secondary" size="sm">+ Add</Button>
              </div>
              {tagDimensions?.filter(d=>!budgetDims.includes(d)&&!budgetMetaDims.includes(d)).length>0&&(
                <div className="mt-2">
                  <div className="mb-1 text-[10px] text-muted-foreground">From your tag dimensions:</div>
                  <div className="flex flex-wrap gap-1">
                    {tagDimensions.filter(d=>!budgetDims.includes(d)&&!budgetMetaDims.includes(d)).map(d=>(
                      <button key={d} onClick={()=>{setBudgetMetaDims(p=>[...p,d]);showNotif(`Added ${d}`);}}
                        className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] text-foreground hover:bg-secondary/70">+ {d}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="-mx-3.5 border-t border-border px-3.5 py-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Budget By</div>
            {["Platform","Campaign","Ad Group",...(tagDimensions||[])].map(d=>{const on=budgetDims.includes(d);return(
              <div key={d} onClick={()=>toggleDim(d)}
                className={cn("mb-0.5 flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5",on?"bg-secondary":"hover:bg-secondary/50")}>
                {/* Checkbox is display-only (pointer-events-none) — the row's onClick is the single
                    toggle. Previously it also had its own onCheckedChange, so clicking the box fired
                    the toggle twice (box handler + row bubble) and net-cancelled, which is why a
                    selected dimension couldn't be un-selected (2026-08-07 fix, per Mo). */}
                <Checkbox checked={on} className="pointer-events-none"/>
                <span className={cn("text-sm text-foreground",on&&"font-semibold")}>{d}</span>
                <span className="ml-auto text-xs text-muted-foreground">{dimCount(d)}</span>
              </div>
            );})}
          </div>
          {/* Rollups + Optional Columns moved to the top action bar's "View" popover (2026-08-07,
              per Mo) to keep this column short. */}
          <div className="-mx-3.5 border-t border-border px-3.5 py-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Summary</div>
            <div className="flex items-center justify-between py-1 text-xs">
              <span className="text-muted-foreground">Segments</span>
              <span className="font-medium text-foreground">{segs.length}</span>
            </div>
            <div className="flex items-center justify-between py-1 text-xs">
              <span className="text-muted-foreground">Total {year}</span>
              <span className="font-medium text-foreground">{totalY>0?fmtFull(totalY):"$0"}</span>
            </div>
            {segs.some(sg=>isNotBudgeted(sg.key))&&(
              <div className="flex items-center justify-between py-1 text-xs">
                <span className="text-muted-foreground">Not budgeted</span>
                <span className="font-medium text-foreground">{segs.filter(sg=>isNotBudgeted(sg.key)).length}</span>
              </div>
            )}
          </div>
        </div>,
        sidebarEl
      )}

      {/* Table */}
      <div style={{flex:1,overflow:"auto",minWidth:0}} onPaste={handleGridPaste} onCopy={handleGridCopy} onKeyDown={handleGridKeyDown}>
        {!budgetDims.length?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40}}>
            <div style={{fontSize:17*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:6}}>Set up your budget structure</div>
            <div style={{fontSize:13*(T.fsScale||1),color:T.textSub,maxWidth:340,lineHeight:1.65,marginBottom:20}}>{canEdit?"Select dimensions to budget by, or import an existing budget file.":"This workspace doesn't have a budget structure yet — ask an owner or admin to set one up."}</div>
            {canEdit&&<Btn onClick={()=>setImportOpen(true)} variant="success" T={T} size="md">↑ Import CSV / Excel</Btn>}
          </div>
        ):segs.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40}}>
            <div style={{fontSize:17*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:6}}>No segments found</div>
            <div style={{fontSize:13*(T.fsScale||1),color:T.textSub,maxWidth:320,lineHeight:1.65}}>
              {derivedActiveDims.length?(
                manualActiveDims.length?
                  <>Import spend data and tag campaigns with <strong style={{color:T.text}}>{manualActiveDims.join(" + ")}</strong> in the Tagger — {derivedActiveDims.join(", ")} {derivedActiveDims.length>1?"are":"is"} detected automatically, no tagging needed for {derivedActiveDims.length>1?"them":"it"}.</>
                  :<>Import spend data in the Tagger — {derivedActiveDims.join(", ")} {derivedActiveDims.length>1?"are":"is"} detected automatically, no manual tagging needed.</>
              ):(
                <>Tag campaigns with <strong style={{color:T.text}}>{budgetDims.join(" + ")}</strong> in the Tagger first.</>
              )}
            </div>
            {addSegmentControl&&<div style={{marginTop:16}}>{addSegmentControl}</div>}
          </div>
        ):(
          <>
          {/* Chart card + bordered table card (2026-08-07, per Mo's reference screenshot of
              Venture's Analytics page — a headline-number chart card, then a separately-bordered
              table card below it, both inset with page padding rather than edge-to-edge). Both
              live inside the SAME outer scrolling div this fragment already renders into (see the
              enclosing <div style={{flex:1,overflow:"auto"...}}> above) — deliberately not given
              their own scroll/overflow so the existing sticky-header/sticky-left-column math on
              the segments table below (which resolves against THAT outer div) keeps working
              unchanged. Only the wide table itself gets its own horizontal-scroll wrapper further
              down, with overflowY explicitly set to "visible" so it doesn't accidentally become a
              second vertical scroll context (a real CSS quirk: setting only overflow-x on an
              element implicitly promotes its overflow-y to "auto" too unless you say otherwise) —
              that would silently break the header's sticky-top-of-page behavior. */}
          {/* Horizontal action bar (2026-08-07, per Mo — "add a second horizontal menu bar above
              the chart with a limited amount of options" to thin out the tall, scrolling stats
              sidebar). Holds the actions (Import/Export/History/Undo/Redo) and Budget Year that
              used to live at the top of the sidebar; the sidebar now only carries the things that
              genuinely need vertical space (Annotation Dimensions, Budget By, view toggles,
              Summary). */}
          <div style={{padding:"16px 20px 0"}}>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={()=>setImportOpen(true)} disabled={!canEdit} title={canEdit?undefined:"View-only access"}>
                <UploadSimple size={14}/> Import
              </Button>
              <Button size="sm" variant="outline" onClick={openExportPreview} disabled={!segs.length}>
                <DownloadSimple size={14}/> Export
              </Button>
              <Button size="sm" variant="outline" onClick={()=>setImportHistoryOpen(true)}>
                <ClockCounterClockwise size={14}/> History
              </Button>
              {canEdit&&(
                <>
                  <Button size="icon" variant="outline" className="h-8 w-8" onClick={handleUndo} disabled={!undoStack.length} title={`Undo (${navigator.platform?.includes("Mac")?"⌘":"Ctrl"}+Z)`}>
                    <ArrowUUpLeft size={14}/>
                  </Button>
                  <Button size="icon" variant="outline" className="h-8 w-8" onClick={handleRedo} disabled={!redoStack.length} title={`Redo (${navigator.platform?.includes("Mac")?"⌘":"Ctrl"}+Shift+Z)`}>
                    <ArrowUUpRight size={14}/>
                  </Button>
                </>
              )}
              <div className="mx-1 h-6 w-px bg-border"/>
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Year</span>
              <div className="flex items-center gap-1">
                {years.map(y=>(
                  <button key={y} onClick={()=>setYear(y)}
                    className={cn("rounded-sm border px-2.5 py-1 text-xs font-medium transition-colors",
                      year===y?"border-foreground bg-secondary text-foreground":"border-border text-muted-foreground hover:bg-secondary/60")}>
                    {y}
                  </button>
                ))}
              </div>
              {canEdit&&(
                <div className="flex items-center gap-1">
                  <Input value={cloneTargetYear} onChange={e=>setCloneTargetYear(e.target.value)} placeholder={`Clone into ${Number(year)+1}…`} onKeyDown={e=>e.key==="Enter"&&cloneYearInto(year,cloneTargetYear||String(Number(year)+1))}
                    title={`Copy every segment's monthly/quarterly/annual budget from ${year} into another year`} className="h-8 w-40 text-xs"/>
                  <Button size="sm" variant="secondary" onClick={()=>cloneYearInto(year,cloneTargetYear||String(Number(year)+1))}>Clone</Button>
                </div>
              )}
              {/* View menu (2026-08-07, per Mo) — Rollups + Optional Columns, folded out of the
                  sidebar into a compact popover to keep that column short. */}
              <div className="relative ml-auto" ref={viewMenuRef}>
                <Button size="sm" variant="outline" onClick={()=>setViewMenuOpen(o=>!o)}>
                  <Icon name="gear" size={14} color="currentColor"/> View
                  <Icon name="chevronDown" size={12} color="currentColor"/>
                </Button>
                {viewMenuOpen&&(
                  <div className="absolute right-0 z-50 mt-1 w-64 rounded-md border border-border bg-background p-3 shadow-card">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground">Rollups</span>
                      <Switch checked={showRollups} onCheckedChange={setShowRollups}/>
                    </div>
                    <p className="mb-3 text-xs leading-relaxed text-muted-foreground">Budget totals by each Budget By dimension on its own, above the table, broken out by month, quarter, and year.</p>
                    <div className="border-t border-border pt-2">
                      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Optional Columns</div>
                      {[{label:"Quarterly caps",v:showQ,s:setShowQ},{label:"Annual cap",v:showA,s:setShowA},{label:"Currency labels",v:showCurrency,s:setShowCurrency}].map(({label,v,s})=>(
                        <div key={label} className="flex items-center justify-between py-1">
                          <span className="text-xs text-foreground">{label}</span>
                          <Switch checked={v} onCheckedChange={s}/>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          {isRolledUp&&(
            <div style={{padding:"12px 20px 0"}}>
              <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
                <Icon name="info" size={14} color="currentColor"/>
                <span>Showing rolled-up totals from <span className="font-medium text-foreground">{grain?.join(" + ")}</span>. Numbers are read-only here — reselect all of those dimensions to edit individual budgets.</span>
              </div>
            </div>
          )}
          <div style={{padding:"16px 20px 0"}}>
            <Card>
              <CardHeader className="flex flex-row items-start justify-between pb-2">
                <div>
                  <CardTitle className="text-xs font-medium text-muted-foreground">Budget · {year}</CardTitle>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-h4 font-medium text-foreground">{fmtFull(chartTotal)}</span>
                    {chartDeltaPct!=null&&(
                      <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium",
                        chartDeltaPct>=0?"bg-success-bg text-success":"bg-destructive-bg text-destructive")}>
                        {chartDeltaPct>=0?"↗":"↘"} {Math.abs(chartDeltaPct)}%
                      </span>
                    )}
                  </div>
                  {chartDeltaPct!=null&&<div className="mt-0.5 text-xs text-muted-foreground">vs {Number(year)-1}</div>}
                </div>
                <div className="flex items-center gap-1 rounded-sm border border-border p-1">
                  {[["month","Month"],["quarter","Quarter"]].map(([k,l])=>(
                    <button key={k} type="button" onClick={()=>setChartGranularity(k)}
                      className={cn("rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                        chartGranularity===k?"bg-secondary text-foreground":"text-muted-foreground hover:bg-secondary/60")}>
                      {l}
                    </button>
                  ))}
                </div>
              </CardHeader>
              <CardContent>
                {chartTotal>0?(
                  // Y-axis uses a compact "k" formatter (matching Venture's 300k/200k/100k/0k
                  // reference) — the old fmtFull produced "$300,000"-width labels that overran
                  // yAxisWidth and got clipped on the left. The hover tooltip still shows the full
                  // value via BudgetChartTooltip/fmtFull.
                  <AreaChart data={chartData} index="period" categories={["Budgeted"]} colors={["neutral"]}
                    className="h-60" showAnimation={false} showLegend={false}
                    valueFormatter={v=>v>=1e6?`${(v/1e6).toFixed(1)}M`:v>=1000?`${Math.round(v/1000)}k`:`${Math.round(v)}`} yAxisWidth={70}
                    customTooltip={BudgetChartTooltip}/>
                ):(
                  // Empty/zero state (2026-08-07, per Mo) — a friendlier prompt than a bare "$0"
                  // chart. Distinguishes "no rows at all" from "rows exist but nothing budgeted yet".
                  <div className="flex h-60 flex-col items-center justify-center gap-2 text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                      <Icon name="chart" size={20} color="currentColor"/>
                    </div>
                    <div className="text-sm font-medium text-foreground">No budget set for {year} yet</div>
                    <div className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                      {segs.length>0
                        ? "Enter monthly amounts in the table below, or import a file to fill it in."
                        : "Import a CSV/Excel file or add a segment to start building this year's budget."}
                    </div>
                    {canEdit&&!isRolledUp&&(
                      <Button size="sm" className="mt-1" onClick={()=>setImportOpen(true)}>
                        <UploadSimple size={14}/> Import CSV / Excel
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          <div style={{padding:20}}>
          {/* Toolbar card (2026-08-07, per Mo) — the filter row + AI Summary live in their own
              white bordered card, like the reference's Transaction Details toolbar header, so they
              read as the table's toolbar instead of floating loose on the grey. It stays white in
              both grid and card-rows modes; only the table region below goes transparent when rows
              are floating. */}
          <Card className="mb-4 overflow-hidden">
          {/* Filters panel (2026-07-31, per Mo — "stronger filter and sort... at the top, like
              the campaign tagger"). Same collapsible-toggle + include/exclude-with-match-mode UX
              as Tagger's own Filters bar, generalized across whatever budgetDims/budgetMetaDims
              are active plus a Year Total range, instead of Tagger's fixed Campaign/Group/
              Platform/Tag fields. */}
          <div style={{borderBottom:`1px solid ${T.border}`,background:T.surfaceEl,flexShrink:0}}>
            {/* Toolbar controls (search, Filters toggle, Sort By, Card-rows toggle, count).
                (2026-08-07, per Mo) When the filter panel is CLOSED these sit on their own compact
                row. When it's OPEN they move down into the filter grid, to the right of Year Total,
                so the whole section is shorter instead of stacking a control row above the grid. */}
            {(() => {
              const controls = (
                <>
                  {/* Search (Venture-style table toolbar) — a single free-text box ahead of the
                      per-dimension Filters panel, same relationship the two search surfaces have in
                      Campaign Tagger. */}
                  <IconField icon="search" color={T.textMuted} style={{flex:"0 0 220px",width:220}}>
                    <input value={budgetSearchQuery} onChange={e=>{setBudgetSearchQuery(e.target.value);setBudgetPage(1);}} placeholder="Search segments…"
                      style={{...fIn,paddingLeft:26,height:28}}/>
                  </IconField>
                  <button onClick={()=>setFiltersOpen(o=>!o)} title={filtersOpen?"Hide filters":"Show filters"}
                    style={{display:"flex",alignItems:"center",gap:5,background:filtersOpen?T.surfaceHover:"transparent",border:`1px solid ${T.border}`,borderRadius:T.r6,padding:"3px 8px",height:28,cursor:"pointer",fontFamily:T.font,fontSize:11*(T.fsScale||1),fontWeight:600,color:T.text,outline:"none"}}>
                    <Icon name="filter" size={12} color={T.text}/>
                    Filters
                    {hasSegFilters&&<span style={{width:6,height:6,borderRadius:"50%",background:T.accent,flexShrink:0}}/>}
                  </button>
                  {/* Sort By — same doBudgetSort the column headers call on click, surfaced as an
                      explicit toolbar control too since the reference screenshot calls one out. */}
                  <Sel value={budgetSortCol} onChange={doBudgetSort} T={T} style={{width:150,fontSize:11*(T.fsScale||1),height:28}}>
                    <option value="">Sort by…</option>
                    {budgetDims.map(d=><option key={d} value={d}>{d}</option>)}
                    {budgetMetaDims.map(d=><option key={d} value={d}>{d}</option>)}
                    <option value="_total">Year Total</option>
                  </Sel>
                  {/* Card-rows toggle (2026-08-07, per Mo — experimental Venture card-style rows) */}
                  <button onClick={()=>setCardRows(v=>!v)} title={cardRows?"Switch to compact grid rows":"Switch to card-style rows"}
                    style={{display:"flex",alignItems:"center",gap:5,background:cardRows?T.surfaceHover:"transparent",border:`1px solid ${T.border}`,borderRadius:T.r6,padding:"3px 8px",height:28,cursor:"pointer",fontFamily:T.font,fontSize:11*(T.fsScale||1),fontWeight:600,color:T.text,outline:"none"}}>
                    <Icon name="panelLeft" size={12} color={T.text}/>
                    {cardRows?"Cards":"Grid"}
                  </button>
                  {!filtersOpen&&hasSegFilters&&<button onClick={clearSegFilters} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11*(T.fsScale||1),fontFamily:T.font,textDecoration:"underline",padding:0,outline:"none"}}>Clear filters</button>}
                  <span style={{marginLeft:"auto",fontSize:11*(T.fsScale||1),color:T.textMuted,whiteSpace:"nowrap"}}>{filteredSegs.length} of {segs.length} segments</span>
                </>
              );
              return filtersOpen ? (
                <div style={{padding:"10px 16px 12px",display:"flex",flexWrap:"wrap",gap:12,alignItems:"flex-end"}}>
                  {[...budgetDims,...budgetMetaDims].map(d=>(
                    <div key={d} style={{display:"flex",flexDirection:"column",gap:3,width:170}}>
                      <div style={{fontSize:11*(T.fsScale||1),fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted}}>{d}</div>
                      <div style={{display:"flex",gap:3}}>
                        <IconField icon="search" color={T.textMuted}>
                          <input value={segFilters[d]||""} onChange={e=>setSegFilters(p=>({...p,[d]:e.target.value}))} placeholder="Contains… (a, b)"
                            title={`Comma-separate multiple terms — ${(segFilterInclMode[d]||"or")==="and"?"row must contain ALL of them":"matches ANY of them"}`}
                            style={{...fIn,paddingLeft:26}}/>
                        </IconField>
                        <MatchModeToggle mode={segFilterInclMode[d]||"or"} onChange={m=>setSegFilterInclMode(p=>({...p,[d]:m}))} T={T}/>
                      </div>
                      <div style={{display:"flex",gap:3}}>
                        <input value={segFiltersExclude[d]||""} onChange={e=>setSegFiltersExclude(p=>({...p,[d]:e.target.value}))} placeholder="≠ excludes… (a, b)"
                          title={`Comma-separate multiple terms — ${(segFilterExclMode[d]||"or")==="and"?"excludes only rows containing ALL of them":"excludes any of them"}`}
                          style={{...fIn,flex:1}}/>
                        <MatchModeToggle mode={segFilterExclMode[d]||"or"} onChange={m=>setSegFilterExclMode(p=>({...p,[d]:m}))} T={T}/>
                      </div>
                    </div>
                  ))}
                  <div style={{display:"flex",flexDirection:"column",gap:3,width:130}}>
                    <div style={{fontSize:11*(T.fsScale||1),fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted}}>Year Total</div>
                    <div style={{display:"flex",gap:4}}>
                      <input value={totalMin} onChange={e=>setTotalMin(e.target.value)} placeholder="Min" style={{...fIn,width:"50%"}}/>
                      <input value={totalMax} onChange={e=>setTotalMax(e.target.value)} placeholder="Max" style={{...fIn,width:"50%"}}/>
                    </div>
                  </div>
                  {/* Controls sit to the right of Year Total (2026-08-07, per Mo) — flex:1 lets the
                      row of search/Filters/Sort/Cards/count fill the remaining width beside the
                      Year Total block rather than stacking above the grid. */}
                  <div style={{flex:"1 1 420px",display:"flex",alignItems:"flex-end",gap:8,minWidth:0}}>
                    {controls}
                  </div>
                  {hasSegFilters&&<Btn onClick={clearSegFilters} variant="ghost" size="sm" T={T} style={{alignSelf:"flex-end"}}>Clear all filters</Btn>}
                </div>
              ) : (
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 16px"}}>
                  {controls}
                </div>
              );
            })()}
          </div>
          <div style={{padding:"14px 16px"}}>
            <AISummaryCard T={T} session={session} mergedNormRows={mergedNormRows} tags={campaignTags} budgetDims={budgetDims} budgets={budgets} budgetRowMeta={budgetRowMeta} defaultForecastModel={defaultForecastModel} combineGoogleChannels={combineGoogleChannels} mode="budget"/>
          </div>
          </Card>
          {/* Table region — its own card, transparent in card-rows mode so the rows float on grey;
              a normal white bordered card in grid mode (task #119). */}
          <Card className={cn("overflow-hidden",cardRows&&"border-0 bg-transparent shadow-none")}>
          {/* Rollups — budget totals by one Budget By dimension at a time, independent of the
              detail grid's row grain */}
          {showRollups&&rollupTables.length>0&&(
            <div style={{padding:"14px 16px",borderBottom:`1px solid ${T.border}`,background:T.surface,display:"flex",flexDirection:"column",gap:16,overflowX:"auto"}}>
              {hiddenRollupDims.length>0&&(
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:11*(T.fsScale||1),color:T.textMuted}}>
                  <span>{hiddenRollupDims.length} rollup table{hiddenRollupDims.length===1?"":"s"} hidden</span>
                  <span onClick={showAllRollupTables} style={{color:T.accent,cursor:"pointer",fontWeight:600}}>Show all</span>
                </div>
              )}
              {rollupTables.filter(({dim})=>!hiddenRollupDims.includes(dim)).map(({dim,rows,total})=>(
                <div key={dim} style={{border:`1px solid ${T.border}`,borderRadius:T.r8,overflow:"hidden"}}>
                  <div style={{padding:"8px 10px",background:T.headerBg,borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span style={{fontSize:11*(T.fsScale||1),fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.text}}>By {dim}</span>
                    <span title="Hide this rollup table"><Tog value={true} onChange={()=>hideRollupTable(dim)} T={T}/></span>
                  </div>
                  <table style={{borderCollapse:"collapse",width:"100%"}}>
                    <thead>
                      <tr>
                        <th style={{padding:"5px 10px",fontSize:11*(T.fsScale||1),fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted,textAlign:"left",borderBottom:`1px solid ${T.border}`,background:T.bg}}></th>
                        {MONTHS.map(m=>(
                          <th key={m.key} style={{padding:"5px 8px",fontSize:11*(T.fsScale||1),fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted,textAlign:"right",borderBottom:`1px solid ${T.border}`,background:T.bg,whiteSpace:"nowrap"}}>{m.label}</th>
                        ))}
                        {QUARTERS.map(q=>(
                          <th key={q.key} style={{padding:"5px 8px",fontSize:10*(T.fsScale||1),fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.textSub,textAlign:"right",borderBottom:`1px solid ${T.border}`,background:T.bg,whiteSpace:"nowrap",borderLeft:q.key==="Q1"?`1px solid ${T.border}`:undefined}}>{q.key}</th>
                        ))}
                        <th style={{padding:"5px 10px",fontSize:10*(T.fsScale||1),fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.text,textAlign:"right",borderBottom:`1px solid ${T.border}`,borderLeft:`1px solid ${T.border}`,background:T.bg,whiteSpace:"nowrap"}}>{year}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r=>(
                        <tr key={r.value}>
                          <td style={{padding:"6px 10px",fontSize:12*(T.fsScale||1),color:T.text,borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{r.value}</td>
                          {MONTHS.map(m=>(
                            <td key={m.key} style={{padding:"6px 8px",fontSize:12*(T.fsScale||1),color:r.months[m.key]?T.text:T.textDim,textAlign:"right",fontFamily:T.font,borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{r.months[m.key]?fmt$(r.months[m.key]):"—"}</td>
                          ))}
                          {QUARTERS.map(q=>{
                            const qv=q.months.reduce((s,mk)=>s+(r.months[mk]||0),0);
                            return <td key={q.key} style={{padding:"6px 8px",fontSize:12*(T.fsScale||1),color:qv?T.textSub:T.textDim,textAlign:"right",fontFamily:T.font,borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap",borderLeft:q.key==="Q1"?`1px solid ${T.border}`:undefined}}>{qv?fmt$(qv):"—"}</td>;
                          })}
                          <td style={{padding:"6px 10px",fontSize:12*(T.fsScale||1),color:T.accent,fontWeight:700,textAlign:"right",fontFamily:T.font,borderBottom:`1px solid ${T.border}`,borderLeft:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{fmt$(r.total)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{padding:"6px 10px",fontSize:12*(T.fsScale||1),fontWeight:700,color:T.text}}>Total</td>
                        {MONTHS.map(m=>{
                          const mv=rows.reduce((s,r)=>s+(r.months[m.key]||0),0);
                          return <td key={m.key} style={{padding:"6px 8px",fontSize:12*(T.fsScale||1),fontWeight:600,color:T.text,textAlign:"right",fontFamily:T.font,whiteSpace:"nowrap"}}>{mv?fmt$(mv):"—"}</td>;
                        })}
                        {QUARTERS.map(q=>{
                          const qv=rows.reduce((s,r)=>s+q.months.reduce((ss,mk)=>ss+(r.months[mk]||0),0),0);
                          return <td key={q.key} style={{padding:"6px 8px",fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textSub,textAlign:"right",fontFamily:T.font,whiteSpace:"nowrap",borderLeft:q.key==="Q1"?`1px solid ${T.border}`:undefined}}>{qv?fmt$(qv):"—"}</td>;
                        })}
                        <td style={{padding:"6px 10px",fontSize:12*(T.fsScale||1),fontWeight:700,color:T.accent,textAlign:"right",fontFamily:T.font,borderLeft:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{fmt$(total)}</td>
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
              <span style={{color:T.textMuted,fontSize:13*(T.fsScale||1)}}>→</span>
              <Sel value={applyMetaDim} onChange={setApplyMetaDim} T={T} style={{width:140,fontSize:12*(T.fsScale||1)}}>
                <option value="">Dimension…</option>
                {[...budgetDims,...budgetMetaDims].map(d=><option key={d} value={d}>{d}</option>)}
              </Sel>
              <input value={applyMetaVal} onChange={e=>setApplyMetaVal(e.target.value)} placeholder="Value…" onKeyDown={e=>e.key==="Enter"&&applyMetaToSelected()}
                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 8px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,width:130}}/>
              <Btn onClick={applyMetaToSelected} disabled={!applyMetaDim||!applyMetaVal} variant="primary" size="sm" T={T}>Apply</Btn>
              <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
              <input value={bulkPct} onChange={e=>setBulkPct(e.target.value)} placeholder="% e.g. 10 or -15" onKeyDown={e=>e.key==="Enter"&&bulkAdjustPct()}
                title="Scales every existing monthly value on the selected rows by this percent" style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 8px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,width:120}}/>
              <Btn onClick={bulkAdjustPct} disabled={!bulkPct.trim()||isNaN(parseFloat(bulkPct))} variant="subtle" size="sm" T={T}>Adjust %</Btn>
              <Btn onClick={()=>setSelRows(new Set())} variant="ghost" size="sm" T={T}>Clear</Btn>
              <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
              <Btn onClick={bulkDeleteSelected} variant="danger" size="sm" T={T}>✕ Delete {selRows.size}</Btn>
            </div>
          )}
          {/* overflowY:"visible" is load-bearing, not decorative — see this fragment's opening
              comment. Without it, this div's own overflow-x:auto would implicitly become a second
              vertical scroll context, and the header's position:sticky/top:0 below would stick to
              THIS div's (nonexistent, single-row-tall) scrollport instead of the outer page's. */}
          <div className="bhq-hscroll" style={{overflowX:"auto",overflowY:"visible"}}>
          {/* cardRows (2026-08-07, per Mo) — the .bhq-cardrows class in PaidHQ.jsx's <style> block
              switches the data rows to bordered, vertically-spaced "cards" via border-collapse:
              separate + per-row side/rounded borders. Kept as a class toggle (not an inline-style
              rewrite of every <td>) so it layers cleanly on top of the existing grid and Mo can
              flip it off with the toolbar "Grid" button without a code revert. */}
          <table className={cardRows?"bhq-cardrows":undefined} style={{borderCollapse:cardRows?"separate":"collapse",borderSpacing:cardRows?"0 8px":undefined,minWidth:"100%",fontSize:12*(T.fsScale||1),background:cardRows?"transparent":T.surface}}>
            <thead><tr>
              <th style={{...TH,width:32,padding:"12px 8px 11px 16px",left:0,zIndex:6,background:T.surfaceHover}}>
                <input type="checkbox" disabled={isRolledUp} checked={filteredSegs.length>0&&selRows.size===filteredSegs.length} onChange={selAllRows} title={isRolledUp?"Read-only in rolled-up view":"Select all rows — reveals bulk actions (tag, delete) once selected"} style={{cursor:isRolledUp?"default":"pointer",accentColor:T.accent,width:13,height:13,opacity:isRolledUp?0.4:1}}/>
              </th>
              {budgetDims.map((d,i)=><th key={d} style={{...TH,padding:"12px 14px 11px",minWidth:dcw,left:32+i*dcw,zIndex:5,background:T.surfaceHover}}>{budgetHeader(d,d)}</th>)}
              {budgetMetaDims.map(d=><th key={d} style={{...TH,padding:"15px 14px 9px",minWidth:110}}>{budgetHeader(d,d)}</th>)}
              {showCurrency&&<th style={{...TH,padding:"15px 14px 9px",minWidth:76}}>Currency</th>}
              {MONTHS.map(m=><th key={m.key} style={{...TH,textAlign:"center",minWidth:76}}>{m.label}</th>)}
              {QUARTERS.map(q=><th key={"qt-"+q.key} style={{...TH,textAlign:"center",minWidth:90}}>{q.key}</th>)}
              <th style={{...TH,textAlign:"center",minWidth:100}}>{budgetHeader("_total","Year Total")}</th>
              {showQ&&QUARTERS.map(q=><th key={"qc-"+q.key} style={{...TH,color:T.warning,minWidth:96}}>{q.label}</th>)}
              {showA&&<th style={{...TH,color:T.warning,minWidth:96}}>Annual Cap</th>}
            </tr></thead>
            <tbody>
              {filteredSegs.length===0&&segs.length>0&&(
                <tr><td colSpan={2+budgetDims.length+budgetMetaDims.length+MONTHS.length+QUARTERS.length+1+(showQ?QUARTERS.length:0)+(showA?1:0)+(showCurrency?1:0)} style={{padding:"32px 20px",textAlign:"center",color:T.textMuted,fontSize:13*(T.fsScale||1)}}>
                  {hideNotBudgeted&&!hasSegFilters?"All matching segments are marked not budgeted. ":"No segments match your filters. "}
                  <span onClick={()=>{clearSegFilters();setHideNotBudgeted(false);}} style={{color:T.accent,cursor:"pointer",fontWeight:500}}>{hideNotBudgeted&&!hasSegFilters?"Show them":"Clear filters"}</span>
                </td></tr>
              )}
              {filteredSegs.map((seg,segIdx)=>{
                // Pagination (2026-08-07) — only render rows on the current page, but keep
                // mapping over the FULL filteredSegs array so segIdx stays a real index into it.
                // Every bit of keyboard-nav/fill-drag/copy-paste machinery below (focusCell,
                // selRect, handleGridCopy, etc.) addresses cells by segIdx into filteredSegs, not
                // by on-screen row position — slicing the array before mapping would silently
                // desync those indices from what's actually rendered. Returning null here instead
                // is a pure rendering-visibility filter: the indices everything else depends on
                // never change. (Arrow-key nav across a page boundary is a no-op — focusCell
                // already no-ops safely when the target cell isn't mounted — same tradeoff any
                // paginated spreadsheet-style grid makes.)
                if(segIdx<budgetPageStart||segIdx>=budgetPageEnd)return null;
                const rt=rowTotal(seg.key);const ao=aOver(seg.key);const rb=T.surface;const rbb=`1px solid ${T.border}`;const isSel=selRows.has(seg.key);const nb=isNotBudgeted(seg.key);return(
                <tr key={seg.key} className={cn("bhq-datarow",!isSel&&"bhq-tr")} style={{background:isSel?T.rowSelected:rb,opacity:nb?0.5:1}}>
                  <td style={{padding:"7px 8px 7px 16px",borderBottom:rbb,position:"sticky",left:0,background:isSel?T.rowSelected:rb,zIndex:1}}>
                    <input type="checkbox" disabled={isRolledUp} checked={isSel} onChange={()=>toggleRowSel(seg.key)} title={isRolledUp?"Read-only in rolled-up view":"Select row — reveals bulk actions (tag, delete) once selected"} style={{cursor:isRolledUp?"default":"pointer",accentColor:T.accent,width:13,height:13,opacity:isRolledUp?0.4:1}}/>
                  </td>
                  {budgetDims.map((d,i)=><td key={d} style={{padding:"7px 14px",borderBottom:rbb,position:"sticky",left:32+i*dcw,background:isSel?T.rowSelected:rb,zIndex:1,whiteSpace:"nowrap"}}>
                    {DERIVED_DIMS.includes(d)?(
                      // Derived, not stored — renaming here would only relabel the budget row
                      // while spend keeps resolving to the original channel name, silently
                      // breaking the match. Not editable.
                      <Pill color="#272727" bg={T.pill} border={T.pillBorder} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",borderRadius:T.r6}} title="Derived from spend data — not editable">{seg[d]}</Pill>
                    ):editingSegVal?.segKey===seg.key&&editingSegVal?.dim===d?(
                      <input autoFocus value={editSegVal} onChange={e=>setEditSegVal(e.target.value)}
                        onBlur={saveSegEdit} onKeyDown={e=>{if(e.key==="Enter")saveSegEdit();if(e.key==="Escape"){setEditingSegVal(null);setEditSegVal("");}}}
                        style={{background:T.inputBg,border:`1px solid ${T.accentBorder}`,borderRadius:T.r6,color:T.text,padding:"3px 8px",fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",outline:"none",fontFamily:T.font,minWidth:80}}/>
                    ):(
                      <Pill color="#272727" bg={T.pill} border={T.pillBorder} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",cursor:isRolledUp?"default":"text",borderRadius:T.r6}}
                        onClick={isRolledUp?undefined:()=>{setEditingSegVal({segKey:seg.key,dim:d});setEditSegVal(seg[d]);}}>{seg[d]}</Pill>
                    )}
                    {i===budgetDims.length-1&&!nb&&segMatchCount(seg.key)===0&&(
                      <WarnTip T={T} text="No campaigns are tagged to this segment yet. Spend won't roll up here until a campaign is tagged with this exact combination in the Tagger."/>
                    )}
                    {i===budgetDims.length-1&&nb&&(
                      <span style={{marginLeft:6,fontSize:10*(T.fsScale||1),fontWeight:600,color:T.textMuted,background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r10,padding:"1px 7px",fontFamily:T.font}}>Not budgeted</span>
                    )}
                  </td>)}
                  {budgetMetaDims.map(d=>{
                    const val=(budgetRowMeta[seg.key]||{})[d]||"";
                    const isEditing=editingMeta?.segKey===seg.key&&editingMeta?.dim===d;
                    return(
                      <td key={d} style={{padding:"4px 8px",borderBottom:rbb,minWidth:110}} onClick={isRolledUp?undefined:()=>{setEditingMeta({segKey:seg.key,dim:d});setEditMetaVal(val);}}>
                        {isEditing?(
                          <input autoFocus value={editMetaVal} onChange={e=>setEditMetaVal(e.target.value)}
                            onBlur={saveMetaEdit} onKeyDown={e=>{if(e.key==="Enter")saveMetaEdit();if(e.key==="Escape"){setEditingMeta(null);setEditMetaVal("");}}}
                            style={{background:T.inputBg,border:`1px solid ${T.accentBorder}`,borderRadius:T.r5,color:T.text,padding:"3px 7px",fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",outline:"none",fontFamily:T.font,width:"100%"}}/>
                        ):(
                          <span style={{fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:val?"#272727":T.textMuted,cursor:"text",padding:"3px 6px",display:"block",borderRadius:T.r5,border:`1px solid transparent`,minHeight:22,fontFamily:T.font}}>
                            {val||<span style={{opacity:0.4}}>—</span>}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  {showCurrency&&(
                    <td style={{padding:"4px 8px",borderBottom:rbb,background:rb}}>
                      <Sel value={getRowCurrency(seg.key)} onChange={v=>setRowCurrency(seg.key,v)} T={T} disabled={!canEdit||isRolledUp} style={{width:"100%",fontSize:12*(T.fsScale||1)}}>
                        <option value="">—</option>
                        {CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
                      </Sel>
                    </td>
                  )}
                  {MONTHS.map((m,monthIdx)=>{const q=QUARTERS.find(q=>q.months.includes(m.key));const qo=showQ&&q&&qOver(seg.key,q);return <td key={m.key} style={{padding:"4px",borderBottom:rbb,background:rb,position:"relative"}}>{cellIn(getMV(seg.key,m.key),v=>setMV(seg.key,m.key,v),qo,false,{segIdx,colType:"month",colIdx:monthIdx})}</td>;})}
                  {QUARTERS.map(q=>{const qt=qTotal(seg.key,q);return <td key={"qt-"+q.key} style={{padding:"4px 10px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:T.text,background:rb}}>{qt>0?fmt$(qt):"—"}</td>;})}
                  {/* Over-annual-cap red + alert only in the native (editable) view — in a rolled-up
                      view the caps are summed read-only aggregates, so the warning is just noise
                      (2026-08-07, per Mo). */}
                  <td title={ao&&!isRolledUp?`This year's budget (${fmtFull(rt)}) exceeds the annual cap set for this segment (${fmtFull(parseMoney(getAC(seg.key))||0)}).`:undefined} style={{padding:"4px 12px",borderBottom:rbb,textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:(ao&&!isRolledUp)?T.danger:"#272727",whiteSpace:"nowrap",background:rb}}><span style={{display:"inline-flex",alignItems:"center",gap:4}}>{rt>0?fmtFull(rt):"—"}{ao&&!isRolledUp&&<Icon name="alert" size={11} color={T.danger}/>}</span></td>
                  {showQ&&QUARTERS.map((q,qIdx)=>{const qo=qOver(seg.key,q);const qt=qTotal(seg.key,q);return <td key={"qc-"+q.key} style={{padding:"4px",borderBottom:rbb,background:rb}}><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2,position:"relative"}}>{cellIn(getQC(seg.key,q.key),v=>setQC(seg.key,q.key,v),qo,true,{segIdx,colType:"quarter",colIdx:qIdx})}{qt>0&&<span style={{fontSize:10*(T.fsScale||1),color:qo?T.danger:T.textMuted,fontFamily:T.font,display:"inline-flex",alignItems:"center",gap:3}}>{fmt$(qt)}{qo&&<Icon name="alert" size={10} color={T.danger}/>}</span>}</div></td>;})}
                  {showA&&<td style={{padding:"4px",borderBottom:rbb,background:rb}}><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2,position:"relative"}}>{cellIn(getAC(seg.key),v=>setAC(seg.key,v),ao,true,{segIdx,colType:"annual",colIdx:0})}{rt>0&&<span style={{fontSize:10*(T.fsScale||1),color:ao?T.danger:T.textMuted,fontFamily:T.font,display:"inline-flex",alignItems:"center",gap:3}}>{fmt$(rt)}{ao&&<Icon name="alert" size={10} color={T.danger}/>}</span>}</div></td>}
                  <td style={{padding:"4px 8px",borderBottom:rbb,background:rb}}>
                    {!isRolledUp&&(
                    <div style={{display:"flex",alignItems:"center",gap:2}}>
                      <button onClick={()=>toggleNotBudgeted(seg.key)} title={nb?"Unmark — this segment does need a budget":"Mark as not budgeted — hides the missing-budget signal for this segment"}
                        style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:nb?T.accentBg:"transparent",border:`1px solid ${nb?T.accentBorder:"transparent"}`,borderRadius:T.r5,color:nb?T.accent:T.textMuted,cursor:"pointer",fontSize:11*(T.fsScale||1),lineHeight:1,padding:0,opacity:nb?1:0.4,transition:"all 0.1s"}}
                        onMouseEnter={e=>{e.currentTarget.style.opacity=1;if(!nb){e.currentTarget.style.border=`1px solid ${T.border}`;}}}
                        onMouseLeave={e=>{e.currentTarget.style.opacity=nb?1:0.4;if(!nb){e.currentTarget.style.border="1px solid transparent";}}}>
                        <Icon name="ban" size={12} color={nb?T.accent:T.textMuted}/>
                      </button>
                      <button onClick={()=>deleteRow(seg.key,budgetDims.map(d=>seg[d]).join(" · "))} title="Delete row"
                        style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:T.r5,color:T.textMuted,cursor:"pointer",fontSize:12*(T.fsScale||1),lineHeight:1,padding:0,opacity:0.4,transition:"all 0.1s"}}
                        onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.border=`1px solid ${T.danger}`;e.currentTarget.style.color=T.danger;}}
                        onMouseLeave={e=>{e.currentTarget.style.opacity=0.4;e.currentTarget.style.border="1px solid transparent";e.currentTarget.style.color=T.textMuted;}}>✕</button>
                    </div>
                    )}
                  </td>
                </tr>);})}
              <tr className="bhq-totalrow" style={{borderTop:`1px solid ${T.border}`,background:T.surfaceHover}}>
                <td style={{padding:"10px 8px 10px 16px",position:"sticky",left:0,background:T.surfaceHover,zIndex:1}}/>
                {budgetDims.map((d,i)=><td key={d} style={{padding:"10px 14px",position:"sticky",left:32+i*dcw,background:T.surfaceHover,zIndex:1}}>{i===0&&<SectionLabel T={T} style={{marginBottom:0,color:T.text}}>Totals</SectionLabel>}</td>)}
                {budgetMetaDims.map(d=><td key={d}/>)}
                {MONTHS.map(m=>{const t=filteredSegs.reduce((s,sg)=>s+(viewBudget[sg.key]?.monthly?.[m.key]||0),0);return <td key={m.key} style={{padding:"10px 8px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:T.text}}>{t>0?fmt$(t):"—"}</td>;})}
                {QUARTERS.map(q=>{const qt=filteredSegs.reduce((s,sg)=>s+qTotal(sg.key,q),0);return <td key={"qt-"+q.key} style={{padding:"10px 10px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:T.text}}>{qt>0?fmt$(qt):"—"}</td>;})}
                <td style={{padding:"10px 12px",textAlign:"right",fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,lineHeight:"25px",letterSpacing:"-0.16px",color:T.text}}>{(()=>{const ft=filteredSegs.reduce((s,sg)=>s+rowTotal(sg.key),0);return ft>0?fmtFull(ft):"—";})()}</td>
                {showQ&&QUARTERS.map(q=><td key={"qc-"+q.key}/>)}
                {showA&&<td/>}
                <td/>
              </tr>
            </tbody>
          </table>
          </div>

          {/* Pagination (2026-08-07, per Mo's reference screenshot) — page-size selector + numbered
              pills, separate from the "add row / not-budgeted" footer below so the two don't get
              visually tangled. Only shown once there's actually more than one page's worth of
              content, same as the reference table only needing this when rows overflow. */}
          {filteredSegs.length>0&&(
            <div style={{padding:"10px 16px",background:T.surface,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8,flexShrink:0,...(cardRows?{border:`1px solid ${T.border}`,borderRadius:8,marginTop:8}:{borderTop:`1px solid ${T.border}`})}}>
              <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12*(T.fsScale||1),color:T.textSub,fontFamily:T.font}}>
                Show
                <Sel value={String(budgetPageSize)} onChange={v=>{setBudgetPageSize(Number(v));setBudgetPage(1);}} T={T} style={{width:66,fontSize:12*(T.fsScale||1)}}>
                  {[5,10,25,50,100].map(n=><option key={n} value={n}>{n}</option>)}
                </Sel>
                Row
              </div>
              {budgetTotalPages>1&&(
                <div style={{display:"flex",alignItems:"center",gap:4}}>
                  <button onClick={()=>setBudgetPage(p=>Math.max(1,p-1))} disabled={budgetCurrentPage===1} title="Previous page"
                    style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",border:`1px solid ${T.border}`,borderRadius:T.r6,background:"transparent",color:T.text,cursor:budgetCurrentPage===1?"default":"pointer",opacity:budgetCurrentPage===1?0.35:1,fontFamily:T.font}}>‹</button>
                  {budgetPageNumbers.map((p,i)=>p==="…"?(
                    <span key={`ellip-${i}`} style={{padding:"0 3px",fontSize:12*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>…</span>
                  ):(
                    <button key={p} onClick={()=>setBudgetPage(p)} title={`Page ${p}`}
                      style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",border:`1px solid ${p===budgetCurrentPage?T.text:T.border}`,borderRadius:T.r6,background:p===budgetCurrentPage?T.text:"transparent",color:p===budgetCurrentPage?T.bg:T.text,cursor:"pointer",fontSize:12*(T.fsScale||1),fontWeight:p===budgetCurrentPage?700:400,fontFamily:T.font}}>{p}</button>
                  ))}
                  <button onClick={()=>setBudgetPage(p=>Math.min(budgetTotalPages,p+1))} disabled={budgetCurrentPage===budgetTotalPages} title="Next page"
                    style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",border:`1px solid ${T.border}`,borderRadius:T.r6,background:"transparent",color:T.text,cursor:budgetCurrentPage===budgetTotalPages?"default":"pointer",opacity:budgetCurrentPage===budgetTotalPages?0.35:1,fontFamily:T.font}}>›</button>
                </div>
              )}
            </div>
          )}

          {/* Bottom bar — add row + not-budgeted toggle, sharing one footer. Filtering itself
              moved to the top Filters panel (2026-07-31, per Mo — "like the campaign tagger"). */}
          <div style={{padding:"10px 16px",background:T.surface,display:"flex",flexDirection:"column",gap:8,flexShrink:0,...(cardRows?{border:`1px solid ${T.border}`,borderRadius:8,marginTop:8}:{borderTop:`1px solid ${T.border}`})}}>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              {segs.some(sg=>isNotBudgeted(sg.key))&&(
                <label style={{display:"flex",alignItems:"center",gap:5,fontSize:12*(T.fsScale||1),color:T.textSub,cursor:"pointer"}}>
                  <input type="checkbox" checked={hideNotBudgeted} onChange={e=>setHideNotBudgeted(e.target.checked)} style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
                  Hide not-budgeted
                </label>
              )}
              <span style={{marginLeft:"auto",fontSize:11*(T.fsScale||1),color:T.textMuted}}>{filteredSegs.length} of {segs.length} segments</span>
            </div>
            {addSegmentControl}
          </div>
          </Card>
          </div>
          </>
        )}
      </div>

      {notif&&<div style={{position:"fixed",bottom:24,right:24,background:T.success,color:"#fff",padding:"10px 16px",borderRadius:T.r8,fontSize:13*(T.fsScale||1),fontWeight:600,zIndex:300,boxShadow:T.shadowMd,fontFamily:T.font}}>{notif}</div>}

      {/* ── IMPORT MODAL ── */}
      {importOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:680,maxHeight:"90vh"}} contentStyle={{background:T.surface,maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>

            {/* Modal header */}
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
              <div>
                <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Import Budget File</div>
                <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginTop:2}}>
                  {iStep==="upload"&&"CSV or Excel · any layout"}
                  {iStep==="header"&&`${iFileName} · Click the row that contains your column headers`}
                  {iStep==="map"&&"Map columns to your tag dimensions"}
                  {iStep==="preview"&&`${preview.length} entries ready to import`}
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:14}}>
                {["Upload","Headers","Map","Preview"].map((label,i)=>{
                  const sk=IMPORT_STEPS[i];const idx=IMPORT_STEPS.indexOf(iStep);
                  return <div key={sk} style={{display:"flex",alignItems:"center",gap:5}}>{i>0&&<span style={{color:T.textDim,fontSize:11*(T.fsScale||1)}}>›</span>}<span style={{fontSize:12*(T.fsScale||1),color:iStep===sk?T.accent:idx>i?T.success:T.textMuted,fontWeight:iStep===sk?600:400}}>{idx>i?"✓ ":""}{label}</span></div>;
                })}
                <button onClick={closeImport} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22*(T.fsScale||1),lineHeight:1,marginLeft:6,fontFamily:T.font}}>×</button>
              </div>
            </div>

            {/* Modal body */}
            <div style={{flex:1,overflow:"auto",padding:22}}>

              {/* STEP 1: Upload + Year */}
              {iStep==="upload"&&(
                <div>
                  <div style={{marginBottom:22}}>
                    <div style={{fontSize:13*(T.fsScale||1),fontWeight:600,color:T.text,marginBottom:4}}>Which year do these budgets apply to?</div>
                    <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:10}}>Applied to all entries — even if the year isn't in the file.</div>
                    <div style={{display:"flex",gap:8}}>
                      {years.map(y=><button key={y} onClick={()=>setIYear(y)} style={{flex:1,padding:"10px 0",borderRadius:T.r8,border:`1.5px solid ${iYear===y?T.accent:T.border}`,background:iYear===y?T.accentBg:"transparent",color:iYear===y?T.accent:T.textSub,cursor:"pointer",fontSize:15*(T.fsScale||1),fontWeight:iYear===y?700:400,fontFamily:T.font}}>{y}</button>)}
                    </div>
                  </div>
                  <div onClick={()=>fileRef.current?.click()} style={{border:`1.5px dashed ${T.borderStrong}`,borderRadius:T.r10,padding:"36px 20px",textAlign:"center",cursor:"pointer",background:T.surfaceEl}}>
                    <div style={{marginBottom:10,display:"flex",justifyContent:"center"}}><Icon name="export" size={30} color={T.textSub}/></div>
                    <div style={{fontSize:13*(T.fsScale||1),fontWeight:600,color:T.text,marginBottom:4}}>Drop your budget file here or click to browse</div>
                    <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted}}>Supports <strong style={{color:T.textSub}}>.xlsx</strong> and <strong style={{color:T.textSub}}>.csv</strong> · any row/column layout</div>
                    <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{display:"none"}} onChange={e=>{
                      const f=e.target.files[0];e.target.value="";
                      if(!f)return;
                      promptAndArchiveFile(f,"Budget import").then(named=>{if(named)handleImportFile(f);});
                    }}/>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:10,margin:"14px 0"}}>
                    <div style={{flex:1,height:1,background:T.border}}/>
                    <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>or</span>
                    <div style={{flex:1,height:1,background:T.border}}/>
                  </div>
                  <div onClick={()=>!screenshotImporting&&screenshotFileRef.current?.click()} style={{border:`1.5px dashed ${T.borderStrong}`,borderRadius:T.r10,padding:"20px",textAlign:"center",cursor:screenshotImporting?"default":"pointer",background:T.surfaceEl}}>
                    <div style={{fontSize:13*(T.fsScale||1),fontWeight:600,color:T.accent,marginBottom:4}}>{screenshotImporting?"Reading screenshot…":"Or upload a screenshot of a budget table"}</div>
                    <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted}}>Google Sheets, Excel, a PDF export — AI reads the grid, then you review it in the same steps as a file upload</div>
                    <input ref={screenshotFileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{handleImportScreenshot(e.target.files[0]);e.target.value="";}}/>
                  </div>
                  {screenshotImportError&&<div style={{marginTop:8,fontSize:11*(T.fsScale||1),color:T.danger}}>{screenshotImportError}</div>}

                  <div style={{display:"flex",alignItems:"center",gap:10,margin:"14px 0"}}>
                    <div style={{flex:1,height:1,background:T.border}}/>
                    <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>or</span>
                    <div style={{flex:1,height:1,background:T.border}}/>
                  </div>
                  <div style={{border:`1.5px dashed ${T.borderStrong}`,borderRadius:T.r10,padding:"16px",background:T.surfaceEl}}>
                    <div style={{fontSize:13*(T.fsScale||1),fontWeight:600,color:T.accent,marginBottom:4}}>Or connect a Google Sheet</div>
                    <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,marginBottom:10}}>Pick a sheet from your Drive — this pulls a one-time snapshot, same review steps as a file upload. Live auto-refresh is coming later; for now, reconnect and re-import whenever you want the latest numbers.</div>
                    {gsBudget.tabs?.length>1?(
                      <div>
                        <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:8}}>This spreadsheet has multiple tabs — which one has the budget?</div>
                        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
                          {gsBudget.tabs.map(t=>(
                            <button key={t.sheetId} disabled={gsBudget.fetching} onClick={()=>gsBudget.fetchTab(gsBudget.spreadsheetId,t.title)}
                              style={{padding:"6px 12px",borderRadius:T.r6,border:`1px solid ${T.border}`,background:T.surface,color:T.text,cursor:gsBudget.fetching?"default":"pointer",fontSize:12*(T.fsScale||1),fontFamily:T.font,opacity:gsBudget.fetching?0.6:1}}>{t.title}</button>
                          ))}
                        </div>
                        <Btn onClick={gsBudget.cancelTabs} variant="ghost" size="sm" T={T}>Cancel</Btn>
                      </div>
                    ):(
                      <Btn onClick={gsBudget.openPicker} disabled={gsBudget.fetching} variant="primary" size="sm" T={T}>{gsBudget.fetching?"Connecting…":"Choose from Google Drive"}</Btn>
                    )}
                    {gsBudget.error&&(
                      <div style={{marginTop:8,fontSize:11*(T.fsScale||1),color:T.danger}}>
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
                      <div key={f.label} style={{padding:"10px 12px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r8}}>
                        <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.text,marginBottom:3}}>{f.label}</div>
                        <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>{f.example}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* STEP 2: Header row picker */}
              {iStep==="header"&&(
                <div>
                  {aiError&&<div style={{padding:"9px 12px",background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,borderRadius:T.r8,marginBottom:14,fontSize:12*(T.fsScale||1),color:T.danger}}>{aiError}</div>}
                  <div style={{padding:"10px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:T.r8,marginBottom:16,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                    <span style={{fontSize:12*(T.fsScale||1),color:T.accent,fontWeight:500}}>Year: <strong>{iYear}</strong> · Click a row to set it as the header</span>
                    <div style={{display:"flex",gap:4}}>{years.map(y=><button key={y} onClick={()=>setIYear(y)} style={{padding:"2px 8px",borderRadius:T.r4,border:`1px solid ${iYear===y?T.accent:T.border}`,background:iYear===y?T.accentBg:"transparent",color:iYear===y?T.accent:T.textMuted,cursor:"pointer",fontSize:11*(T.fsScale||1),fontFamily:T.font}}>{y}</button>)}</div>
                  </div>

                  <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                    <div style={{fontSize:12*(T.fsScale||1),color:T.textSub}}>
                      Header row: <strong style={{color:T.text}}>Row {iHeaderRow+1}</strong>
                      <span style={{color:T.textMuted,marginLeft:8}}>({iRawRows[iHeaderRow]?.filter(v=>String(v||"").trim()).length||0} columns detected)</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginLeft:"auto"}}>
                      <span style={{fontSize:12*(T.fsScale||1),color:T.textSub}}>Skip rows containing:</span>
                      <Inp value={iSkipStr} onChange={setISkipStr} placeholder="e.g. total" T={T} style={{width:120,fontSize:12*(T.fsScale||1)}}/>
                    </div>
                  </div>

                  {/* Row preview table */}
                  <div style={{border:`1px solid ${T.border}`,borderRadius:T.r8,overflow:"auto",maxHeight:320}}>
                    <table style={{borderCollapse:"collapse",width:"100%",fontSize:11*(T.fsScale||1)}}>
                      <tbody>
                        {iRawRows.slice(0,Math.min(iRawRows.length,15)).map((row,ri)=>{
                          const isHeader=ri===iHeaderRow;
                          const isEmpty=row.every(v=>!String(v||"").trim());
                          const isSkip=iSkipStr&&row.join(" ").toLowerCase().includes(iSkipStr.toLowerCase());
                          return(
                            <tr key={ri} onClick={()=>setIHeaderRow(ri)}
                              style={{cursor:"pointer",background:isHeader?T.accentBg:isSkip?T.dangerBg:isEmpty?T.surfaceEl:"transparent",borderBottom:`1px solid ${T.border}`,transition:"background 0.1s"}}>
                              <td style={{padding:"6px 8px",width:32,textAlign:"center",borderRight:`1px solid ${T.border}`,color:isHeader?T.accent:T.textMuted,fontSize:10*(T.fsScale||1),fontWeight:isHeader?700:400}}>
                                {isHeader?"→":ri+1}
                              </td>
                              {row.slice(0,8).map((cell,ci)=>(
                                <td key={ci} style={{padding:"6px 10px",color:isHeader?T.accent:isSkip?T.danger:isEmpty?T.textDim:T.text,fontWeight:isHeader?600:400,fontFamily:isHeader?"'DM Sans',sans-serif":"'DM Sans',sans-serif",fontSize:isHeader?11:11,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                                  {cell||""}
                                </td>
                              ))}
                              {row.length>8&&<td style={{padding:"6px 8px",color:T.textMuted,fontSize:10*(T.fsScale||1)}}>+{row.length-8} more</td>}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{marginTop:10,fontSize:11*(T.fsScale||1),color:T.textMuted}}>
                    <span style={{color:T.accent,fontWeight:600}}>→ highlighted row</span> = header &nbsp;·&nbsp;
                    <span style={{color:T.danger}}>red rows</span> = will be skipped &nbsp;·&nbsp;
                    <span style={{color:T.textDim}}>dim rows</span> = empty
                  </div>
                </div>
              )}

              {/* STEP 3: Map columns */}
              {iStep==="map"&&(
                <div>
                  <div style={{padding:"9px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:T.r8,marginBottom:16}}>
                    <span style={{fontSize:12*(T.fsScale||1),color:T.accent,fontWeight:500}}>
                      Year: <strong>{iYear}</strong> · {iFmt==="wide"?"Wide (months as columns)":iFmt==="transposed"?"Transposed (months as rows, campaigns as columns)":iFmt==="flat"?"Flat (one recurring monthly amount, no named months)":"Long (period + amount columns)"} · {iRows.length} data rows · {iHeaders.length} columns
                    </span>
                  </div>

                  {/* Transposed format UI */}
                  {iFmt==="transposed"&&(
                    <div style={{marginBottom:20}}>
                      <SectionLabel T={T} style={{marginBottom:8}}>Transposed format detected</SectionLabel>
                      <div style={{padding:"12px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r8,marginBottom:14,fontSize:12*(T.fsScale||1),color:T.textSub,lineHeight:1.6}}>
                        Your file has <strong style={{color:T.text}}>months as rows</strong> and <strong style={{color:T.text}}>{iHeaders.slice(1).filter(h=>h&&!/(total|quarterly|last.updated|#ref)/i.test(h)).length} campaign/channel columns</strong>. Each column becomes a segment value. Columns matching "total", "quarterly", "last updated", or #REF are excluded.
                      </div>

                      {/* Campaign dimension name */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,alignItems:"center",marginBottom:10}}>
                        <div>
                          <div style={{fontSize:13*(T.fsScale||1),fontWeight:500,color:T.text}}>Campaign/segment dimension name</div>
                          <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>What are these columns? e.g. Campaign, Ad Set</div>
                        </div>
                        <input value={iSegDim} onChange={e=>setISegDim(e.target.value)} placeholder="e.g. Campaign"
                          style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"7px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                      </div>

                      {/* Group header row */}
                      <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginTop:4}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                          <div>
                            <div style={{fontSize:13*(T.fsScale||1),fontWeight:500,color:T.text}}>Channel / group header row</div>
                            <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>Optional — use a row above the header that groups campaigns into channels</div>
                          </div>
                          <Tog value={iGroupHeaderRow>=0} onChange={v=>setIGroupHeaderRow(v?Math.max(0,iHeaderRow-1):-1)} T={T}/>
                        </div>
                        {iGroupHeaderRow>=0&&(
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:8}}>
                            <div>
                              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:4}}>Which row contains channel labels?</div>
                              <select value={iGroupHeaderRow} onChange={e=>setIGroupHeaderRow(parseInt(e.target.value))}
                                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 10px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,width:"100%"}}>
                                {iRawRows.slice(0,iHeaderRow).map((_,i)=>(
                                  <option key={i} value={i}>Row {i+1}: {(iRawRows[i]||[]).filter(v=>String(v||"").trim()).slice(0,3).join(" | ")}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:4}}>Name for this group dimension</div>
                              <input value={iGroupDim} onChange={e=>setIGroupDim(e.target.value)} placeholder="e.g. Channel, Platform"
                                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 10px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,width:"100%"}}/>
                            </div>
                          </div>
                        )}
                        {iGroupHeaderRow>=0&&iRawRows[iGroupHeaderRow]&&(
                          <div style={{marginTop:8,padding:"8px 10px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:T.r6,fontSize:11*(T.fsScale||1),color:T.accent}}>
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
                          <span style={{fontSize:13*(T.fsScale||1),color:T.text,fontWeight:500}}>{d}</span>
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
                      {customDims.length===0&&<div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,padding:"8px 0"}}>Map any additional columns to new tag dimensions not yet in your list.</div>}
                      {customDims.map((cd,i)=>(
                        <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 28px",gap:8,marginBottom:8,alignItems:"center"}}>
                          <input value={cd.name} onChange={e=>setCustomDims(p=>p.map((x,j)=>j===i?{...x,name:e.target.value}:x))} placeholder="Dimension name (e.g. BU)" style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 10px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                          <Sel value={cd.col} onChange={v=>setCustomDims(p=>p.map((x,j)=>j===i?{...x,col:v}:x))} T={T}><option value="">— select column —</option>{iHeaders.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                          <button onClick={()=>setCustomDims(p=>p.filter((_,j)=>j!==i))} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:16*(T.fsScale||1),lineHeight:1,padding:"4px",fontFamily:T.font}}>×</button>
                        </div>
                      ))}
                    </div>
                  </div>}

                  {/* Long format extra */}
                  {iFmt==="long"&&<div style={{borderTop:`1px solid ${T.border}`,paddingTop:16,marginTop:8}}>
                    <SectionLabel T={T} style={{marginBottom:10}}>Long format columns</SectionLabel>
                    {[{l:"Period / Month",v:periodCol,s:setPeriodCol,h:"e.g. 2026-01, Jan 2026"},{l:"Budget Amount",v:amtCol,s:setAmtCol,h:"e.g. Budget, Amount"}].map(({l,v,s,h})=>(
                      <div key={l} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:8,alignItems:"center"}}>
                        <div><div style={{fontSize:13*(T.fsScale||1),color:T.text,fontWeight:500}}>{l}</div><div style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>{h}</div></div>
                        <Sel value={v} onChange={s} T={T}><option value="">— select —</option>{iHeaders.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                      </div>
                    ))}
                  </div>}

                  {/* Flat format extra — one recurring monthly amount, no named months/period col */}
                  {iFmt==="flat"&&<div style={{borderTop:`1px solid ${T.border}`,paddingTop:16,marginTop:8}}>
                    <SectionLabel T={T} style={{marginBottom:10}}>Monthly amount column</SectionLabel>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16,alignItems:"center"}}>
                      <div><div style={{fontSize:13*(T.fsScale||1),color:T.text,fontWeight:500}}>Monthly Budget</div><div style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>e.g. Monthly Budget, Monthly Spend</div></div>
                      <Sel value={amtCol} onChange={setAmtCol} T={T}><option value="">— select —</option>{iHeaders.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                    </div>

                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <SectionLabel T={T} style={{marginBottom:0}}>Apply to which month(s) of {iYear}?</SectionLabel>
                      <div style={{display:"flex",gap:6}}>
                        <Btn onClick={()=>setIFlatMonths(MONTHS.map(m=>m.key))} variant="subtle" size="sm" T={T}>Whole year</Btn>
                        <Btn onClick={()=>setIFlatMonths([])} variant="subtle" size="sm" T={T}>Clear</Btn>
                      </div>
                    </div>
                    <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginBottom:10}}>
                      This table has no named months — pick which month(s) this recurring amount should be written into. e.g. a client starting in July only needs Jul–Dec, not a back-filled Jan–Jun.
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:6,marginBottom:14}}>
                      {MONTHS.map(m=>{
                        const active=iFlatMonths.includes(m.key);
                        return(
                          <button key={m.key} type="button" onClick={()=>setIFlatMonths(p=>active?p.filter(k=>k!==m.key):[...p,m.key].sort())}
                            style={{padding:"6px 4px",borderRadius:T.r6,fontSize:12*(T.fsScale||1),fontWeight:600,cursor:"pointer",fontFamily:T.font,textAlign:"center",
                              background:active?T.accent:T.surfaceEl,color:active?"#fff":T.text,
                              border:`1px solid ${active?T.accentHover:T.border}`}}>
                            {m.label}
                          </button>
                        );
                      })}
                    </div>

                    <div style={{padding:"9px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:T.r8,fontSize:12*(T.fsScale||1),color:T.accent,lineHeight:1.5}}>
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
                  <div style={{padding:"9px 12px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:T.r8,marginBottom:14,fontSize:12*(T.fsScale||1),color:T.success,fontWeight:500}}>
                    ✓ <strong>{preview.length} entries</strong> across <strong>{pvGrouped.length} segments</strong> ready for <strong>{iYear}</strong>
                  </div>
                  <div style={{border:`1px solid ${T.border}`,borderRadius:T.r8,overflow:"auto",maxHeight:360}}>
                    <table style={{borderCollapse:"collapse",width:"100%",fontSize:11*(T.fsScale||1)}}>
                      <thead><tr>
                        {dimCols.map(d=><th key={d} style={{padding:"8px 10px",textAlign:"left",background:T.headerBg,borderBottom:`1px solid ${T.border}`,fontSize:10*(T.fsScale||1),fontWeight:700,color:T.textMuted,letterSpacing:"0.07em",textTransform:"uppercase",position:"sticky",top:0}}>{d}</th>)}
                        {MONTHS.filter(m=>(preview||[]).some(e=>e.monthKey===m.key)).map(m=><th key={m.key} style={{padding:"8px 6px",textAlign:"right",background:T.headerBg,borderBottom:`1px solid ${T.border}`,fontSize:10*(T.fsScale||1),fontWeight:700,color:T.textMuted,textTransform:"uppercase",position:"sticky",top:0}}>{m.label}</th>)}
                        <th style={{padding:"8px 10px",textAlign:"right",background:T.headerBg,borderBottom:`1px solid ${T.border}`,fontSize:10*(T.fsScale||1),fontWeight:700,color:T.accent,textTransform:"uppercase",position:"sticky",top:0}}>Total</th>
                      </tr></thead>
                      <tbody>
                        {pvGrouped.map((sg,i)=>{const rt=Object.values(sg.months).reduce((s,v)=>s+v,0);return(
                          <tr key={i}>
                            {dimCols.map(d=><td key={d} style={{padding:"7px 10px",borderBottom:`1px solid ${T.border}`,color:T.text}}>{sg.dims[d]||"—"}</td>)}
                            {MONTHS.filter(m=>(preview||[]).some(e=>e.monthKey===m.key)).map(m=><td key={m.key} style={{padding:"7px 6px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,color:sg.months[m.key]?T.text:T.textDim}}>{sg.months[m.key]?fmt$(sg.months[m.key]):"—"}</td>)}
                            <td style={{padding:"7px 10px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:T.font,fontWeight:700,color:T.accent}}>{fmt$(rt)}</td>
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
              <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Export preview — {year}</div>
              <button onClick={()=>setExportPreviewOpen(false)} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22*(T.fsScale||1),lineHeight:1,fontFamily:T.font}}>×</button>
            </div>
            <div style={{padding:22}}>
              {exportAnalyzing?(
                <div style={{display:"flex",alignItems:"center",gap:8,color:T.textSub,fontSize:13*(T.fsScale||1)}}>
                  <span style={{width:14,height:14,border:`2px solid ${T.border}`,borderTopColor:T.accent,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/>
                  Checking how your {year} budget file was structured…
                </div>
              ):(
                <>
                  {exportAiReason&&(
                    <div style={{padding:"9px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:T.r8,marginBottom:16,fontSize:12*(T.fsScale||1),color:T.text,lineHeight:1.5}}>✨ {exportAiReason}</div>
                  )}
                  {exportAiError&&(
                    <div style={{padding:"9px 12px",background:T.warningBg,border:`1px solid ${T.warningBorder}`,borderRadius:T.r8,marginBottom:16,fontSize:12*(T.fsScale||1),color:T.warning,lineHeight:1.5}}>{exportAiError}</div>
                  )}
                  <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:12}}>Always included: annual actual spend, % of budget used, projected year-end spend, and pacing status. Choose what else to append:</div>
                  <label style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0",cursor:"pointer"}}>
                    <input type="checkbox" checked={exportIncludeMonthly} onChange={e=>setExportIncludeMonthly(e.target.checked)} style={{marginTop:2,cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                    <span><span style={{fontSize:13*(T.fsScale||1),fontWeight:600,color:T.text}}>Monthly actual spend</span><br/><span style={{fontSize:12*(T.fsScale||1),color:T.textMuted}}>Adds a Jan–Dec Actual column next to each budgeted month.</span></span>
                  </label>
                  <label style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0",cursor:"pointer"}}>
                    <input type="checkbox" checked={exportIncludeQuarterly} onChange={e=>setExportIncludeQuarterly(e.target.checked)} style={{marginTop:2,cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                    <span><span style={{fontSize:13*(T.fsScale||1),fontWeight:600,color:T.text}}>Quarterly actual spend</span><br/><span style={{fontSize:12*(T.fsScale||1),color:T.textMuted}}>Adds Q1–Q4 Actual columns, matching quarterly totals in your original file.</span></span>
                  </label>
                  <div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${T.border}`}}>
                    <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.text,marginBottom:6}}>Or append to an existing Google Sheet</div>
                    <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,marginBottom:8,lineHeight:1.5}}>Pick a spreadsheet you already have — this adds rows to a tab in it instead of creating a new file. The tab is created if it doesn't exist yet.</div>
                    <input value={appendTabName} onChange={e=>setAppendTabName(e.target.value)} placeholder={`Budget ${year}`}
                      style={{width:"100%",boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 10px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                  </div>
                </>
              )}
            </div>
            <div style={{padding:"14px 22px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8,flexWrap:"wrap"}}>
              <Btn onClick={()=>setExportPreviewOpen(false)} variant="ghost" T={T}>Cancel</Btn>
              <Btn onClick={appendBudgetToGoogleSheet} disabled={exportAnalyzing||sheetsAppending} variant="subtle" T={T}>{sheetsAppending?"Appending…":"→ Append to Sheet"}</Btn>
              <Btn onClick={confirmExport} disabled={exportAnalyzing} variant="primary" T={T}>↓ Download CSV</Btn>
            </div>
          </PixelPanel>
        </div>
      )}

      {importHistoryOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:560}} contentStyle={{background:T.surface,padding:0}}>
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Import history</div>
              <button onClick={()=>setImportHistoryOpen(false)} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22*(T.fsScale||1),lineHeight:1,fontFamily:T.font}}>×</button>
            </div>
            <div style={{padding:"8px 22px 22px",maxHeight:440,overflow:"auto"}}>
              {!(budgetImportMeta?._log||[]).length?(
                <div style={{padding:"28px 0",textAlign:"center",color:T.textMuted,fontSize:13*(T.fsScale||1)}}>No imports recorded yet. Every CSV/Excel upload, screenshot import, Google Sheet pull, and paste-into-new-segments will show up here.</div>
              ):(
                <div>
                  {budgetImportMeta._log.map((entry,i)=>(
                    <div key={entry.ts+"-"+i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0",borderBottom:i<budgetImportMeta._log.length-1?`1px solid ${T.border}`:"none"}}>
                      <div style={{width:26,height:26,borderRadius:"50%",background:T.accentBg,border:`1px solid ${T.accentBorder}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:12*(T.fsScale||1)}}>↑</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13*(T.fsScale||1),fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.source}</div>
                        <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:2}}>
                          {new Date(entry.ts).toLocaleString(undefined,{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"})}
                          {" · "}{entry.year}{" · "}{entry.entryCount} entr{entry.entryCount===1?"y":"ies"} across {entry.segmentCount} segment{entry.segmentCount===1?"":"s"}
                          {entry.mergedCount>0&&` · merged ${entry.mergedCount} segment${entry.mergedCount===1?"":"s"}`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{padding:"14px 22px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end"}}>
              <Btn onClick={()=>setImportHistoryOpen(false)} variant="ghost" T={T}>Close</Btn>
            </div>
          </PixelPanel>
        </div>
      )}

      {mergeReviewOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:210,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:560,maxHeight:"85vh"}} contentStyle={{background:T.surface,padding:0,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Possible duplicate segments</div>
              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginTop:2}}>This import adds a new dimension to segments you've already budgeted. Merge the ones below into your existing rows, or keep them separate.</div>
            </div>
            <div style={{flex:1,overflow:"auto",padding:22}}>
              {mergeAiError&&(
                <div style={{padding:"9px 12px",background:T.warningBg,border:`1px solid ${T.warningBorder}`,borderRadius:T.r8,marginBottom:16,fontSize:12*(T.fsScale||1),color:T.warning,lineHeight:1.5}}>{mergeAiError}</div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {mergeCandidates.map((c,i)=>{
                  const confMeta=c.confidence==="exact"?{label:"Exact match",color:T.success,bg:T.successBg,border:T.successBorder}:c.confidence==="high"?{label:"High confidence",color:T.accent,bg:T.accentBg,border:T.accentBorder}:{label:"Review suggested",color:T.warning,bg:T.warningBg,border:T.warningBorder};
                  return(
                    <label key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",borderRadius:T.r8,border:`1px solid ${T.border}`,cursor:"pointer",background:c.approved?T.accentBg:"transparent"}}>
                      <input type="checkbox" checked={c.approved} onChange={()=>toggleMergeCandidate(i)} style={{marginTop:3,cursor:"pointer",accentColor:T.accent,width:14,height:14,flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                          <span style={{fontSize:11*(T.fsScale||1),fontWeight:700,padding:"2px 8px",borderRadius:T.r20,color:confMeta.color,background:confMeta.bg,border:`1px solid ${confMeta.border}`}}>{confMeta.label}</span>
                        </div>
                        <div style={{fontSize:13*(T.fsScale||1),color:T.text,fontWeight:600,marginBottom:2}}>{c.newLabel}</div>
                        <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,marginBottom:4}}>↳ merges into existing: <strong style={{color:T.textSub}}>{c.oldLabel}</strong></div>
                        <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,lineHeight:1.5}}>{c.reason}</div>
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
              <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text,display:"flex",alignItems:"center",gap:8}}><Icon name="alert" size={16} color={T.warning}/> This import tracks fewer dimensions</div>
              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginTop:4,lineHeight:1.6}}>Your {year} budget already uses <strong style={{color:T.text}}>{budgetDims.join(", ")}</strong>. This file only maps <strong style={{color:T.text}}>{contractionNewDims.join(", ")}</strong>. These are lossy, shorter keys — they can't be safely auto-merged into your existing detailed segments, since more than one of those could match the same shorter key.</div>
            </div>
            <div style={{flex:1,overflow:"auto",padding:22}}>
              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:12}}>If you continue, this import will create <strong style={{color:T.text}}>{contractionInfo.length}</strong> new, less-specific segment{contractionInfo.length===1?"":"s"} — separate from your existing rows below, not combined with them:</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {contractionInfo.map((c,i)=>(
                  <div key={i} style={{padding:"10px 12px",borderRadius:T.r8,border:`1px solid ${T.border}`}}>
                    <div style={{fontSize:13*(T.fsScale||1),color:T.text,fontWeight:600,marginBottom:4}}>New: {c.newLabel}</div>
                    <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,lineHeight:1.6}}>Sits alongside {c.matchCount} existing segment{c.matchCount===1?"":"s"} that also match{c.matchCount===1?"es":""}: {c.examples.join(" · ")}{c.matchCount>c.examples.length?` +${c.matchCount-c.examples.length} more`:""}</div>
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
