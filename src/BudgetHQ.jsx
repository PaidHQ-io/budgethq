import { useState, useMemo, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import Papa from "papaparse";
import {
  getWorkspaceConfig, putWorkspaceConfig, getSpendRows, putSpendRows,
  getAskAIData, putAskAIData,
  listVersions, saveVersion, deleteVersion as apiDeleteVersion,
  listFiles, uploadFile as apiUploadFile, deleteFile as apiDeleteFile, downloadFile as apiDownloadFile, fileToBase64,
  copyFileToWorkspace, authHeader,
} from "./lib/workspaceApi";
import { listMembers, updateMemberRole, removeMember, listInvites, inviteMember, revokeInvite, renameWorkspace, deleteWorkspace, deleteAccount, listConnections, saveConnectionCredential, patchConnection, deleteConnection, startOAuth, getOAuthAccounts, saveOAuthAccount, syncSpend } from "./lib/coreApi";
import { exportReportToGoogleSheets, preloadGoogleSheetsApi, preloadGoogleSheetsPicker } from "./lib/googleSheets";
import {
  THEME, REQUIRED_COLS, OPTIONAL_COLS, COL_LABELS, campaignKey, isEmptyConfig, splitFilterTerms,
  matchesTerms, getBudgetDimValues, DEFAULT_DIMS, LEGACY_LOCAL_KEYS, PLATFORM_COLORS,
  TAG_DIM_COLORS, NAV, autoDetect, derivePlatform, localISODate, fmt$, downloadCSV,
  groupVersionsByDay, fmtFileSize, normalizeRows, spendRowKey, mergeRows, detectSpendConflicts,
  parseSpendDate, consolidateBudgetSegKeys,
} from "./lib/core.js";
import { EXPORTABLE_VIEWS, EXPORT_FORMATS, buildReportBlob, downloadReport, blobToBase64 } from "./lib/reports.js";
import {
  SectionLabel, Pill, GoogleAdsMark, BingMark, CsvMark, ScreenshotMark, BudgetFileMark, PlatformLogo, Btn, Inp, Sel, StatRow,
  MatchModeToggle, IconField, TagAutocompleteInput, Divider, Icon, PixelPanel, WarnTip,
} from "./components/shared.jsx";
import { useGoogleSheetConnect } from "./hooks/useGoogleSheetConnect.js";
import lunarRoverIcon from "./assets/icons/lunar-rover.png";
import explorationRoverIcon from "./assets/icons/exploration-rover.png";
import maintenanceRobotIcon from "./assets/icons/maintenance-robot.png";
import geologicalSampleBoxIcon from "./assets/icons/geological-sample-collection-box.png";

// Lazy-loaded tab components (2026-07-25 split, per Mo — "there should be a global forecasting
// model selector" conversation led into a broader ask to split the four tab components out of
// this file so each ships its own bundle chunk instead of all four loading on every visit
// regardless of which tab is open). Dashboard/PacingDashboard/AskAI are only ever mounted when
// their tab is active, so lazy() genuinely defers their chunk until the user navigates there.
// BudgetManager is the one exception — see the comment at its <Suspense> below.
const Dashboard = lazy(() => import("./components/Dashboard.jsx"));
const BudgetManager = lazy(() => import("./components/BudgetManager.jsx"));
const PacingDashboard = lazy(() => import("./components/PacingDashboard.jsx"));
const AskAI = lazy(() => import("./components/AskAI.jsx"));
// ReportingHQ folded back into BudgetHQ as a tab (2026-07-30, per Mo — running it as a separate
// product meant constantly re-porting shared UI, like the Data Sources connector grid, into two
// codebases). Covers Dreamdata/PowerBI funnel/pipeline performance data (core.reporting_facts) —
// distinct from this tab's own Data Sources connectors, which already cover ad-platform spend.
const ReportingAnalyzer = lazy(() => import("./components/ReportingAnalyzer.jsx"));

// Minimal, theme-matched fallback while a lazily-loaded tab chunk is still fetching — deliberately
// plain (no logo/branding) since this only ever shows for a moment on a cold chunk load.
const TabLoadingFallback = () => (
  <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:60,color:THEME.textMuted,fontSize:13,fontFamily:"'DM Sans',sans-serif"}}>
    <span style={{width:14,height:14,border:`2px solid ${THEME.border}`,borderTopColor:THEME.accent,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block",marginRight:8}}/>
    Loading…
  </div>
);

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function BudgetHQ({session,onSignOut,workspace,workspaces,onSwitchWorkspace,onCreateWorkspace,accounts,activeAccountKey,onSwitchAccount,onAddAccount,onSignOutAccount,onWorkspacesChanged}={}){
  const T=THEME;
  const[accountMenuOpen,setAccountMenuOpen]=useState(false);
  const[workspaceMenuOpen,setWorkspaceMenuOpen]=useState(false);
  const[width,setWidth]=useState(typeof window!=="undefined"?window.innerWidth:1200);
  useEffect(()=>{const h=()=>setWidth(window.innerWidth);window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);
  const isMobile=width<768;
  // Fetch Google's Identity Services script (+ the Picker widget's script) as soon as the app
  // loads rather than waiting for the first Sheets export/connect click — see
  // preloadGoogleSheetsApi's doc comment for why the async gap otherwise risks the consent popup
  // getting silently blocked by the browser.
  useEffect(()=>{preloadGoogleSheetsApi();preloadGoogleSheetsPicker();},[]);

  const[step,setStep]=useState("upload");
  // Which tab was open persists across a refresh/reopen (2026-07-20 — previously always forced
  // back to Dashboard on load; changed on request so refreshing doesn't feel like it dropped you
  // out of whatever you were doing). Device-local, same as sidebar width below — not workspace
  // data, so it doesn't follow you to a different browser/device, which is fine since "what tab
  // was I on" is a per-device habit, not something a team needs to share.
  // "data" (Data Sources) was missing here even though setView("data") is a real, persisted state
  // (see the useEffect below) — meant a real top-level navigation away and back, like the OAuth
  // connect round-trip every provider's callback.js does, always got rejected by this check and
  // fell back to "dashboard" instead of staying on Data Sources where the account picker needs to
  // open. Fixed 2026-07-28, per Mo.
  const VALID_VIEWS=["dashboard","tagger","budget","pacing","ask","settings","data"];
  const[view,setView]=useState(()=>{
    try{const v=localStorage.getItem("paidhq_last_view");return VALID_VIEWS.includes(v)?v:"dashboard";}catch(e){return "dashboard";}
  });
  const[statsOpen,setStatsOpen]=useState(true);
  // Resizable stats sidebar — width is user-adjustable (drag handle on its right edge) and
  // persisted across sessions, since it now hosts contextual panel content (e.g. the full
  // Budget controls) that benefits from more room than the old fixed 180px.
  const[statsWidth,setStatsWidth]=useState(()=>{
    try{const v=+localStorage.getItem("paidhq_sidebar_width");return v&&v>=180&&v<=480?v:240;}catch(e){return 240;}
  });
  const statsWidthRef=useRef(statsWidth);
  const statsResizing=useRef(false);
  const[budgetSidebarEl,setBudgetSidebarEl]=useState(null); // portal target inside <aside> for the Budget tab's controls
  const[pacingSidebarEl,setPacingSidebarEl]=useState(null); // portal target inside <aside> for the Reporting tab's controls
  const[askSidebarEl,setAskSidebarEl]=useState(null); // portal target inside <aside> for Ask AI's search/projects/labels/pinned-chats panel — replaces the generic "Total spend" stat tiles that used to show here (not relevant to Ask AI, see 2026-07-21 UX note)
  useEffect(()=>{
    const onMove=e=>{
      if(!statsResizing.current)return;
      const w=Math.min(480,Math.max(180,e.clientX));
      statsWidthRef.current=w;
      setStatsWidth(w);
    };
    const onUp=()=>{
      if(statsResizing.current){try{localStorage.setItem("paidhq_sidebar_width",String(statsWidthRef.current));}catch(e){}}
      statsResizing.current=false;
      document.body.style.cursor="";
    };
    window.addEventListener("mousemove",onMove);
    window.addEventListener("mouseup",onUp);
    return()=>{window.removeEventListener("mousemove",onMove);window.removeEventListener("mouseup",onUp);};
  },[]);
  const[fileName,setFileName]=useState("");
  const[rawRows,setRawRows]=useState([]);
  const[headers,setHeaders]=useState([]);
  const[colMap,setColMap]=useState({});
  const[uploadPlatform,setUploadPlatform]=useState("auto"); // "auto" or specific platform
  // Explicit "data accurate through" override for this upload — see PROJECTION NOTE near
  // computePlatformFreshness. Needed because Google/Bing exports (manual only — daily API pulls
  // aren't allowed) report ONE ROW PER MONTH — the Date column is a month label like "Jan-26" or
  // "2026-01-01", not a real per-day date — even though the spend figure itself is accurate
  // spend-to-date (Mo always pulls through the day before export). Auto-defaulted to yesterday
  // for files that look month-grained (see handleFile), editable, and left blank for files with
  // real daily dates (LinkedIn, Capterra), where freshness keeps using row dates as before.
  const[uploadAsOf,setUploadAsOf]=useState("");
  // Whether this file reports one row per month rather than real daily rows — previously only an
  // invisible heuristic driving the uploadAsOf auto-fill above; promoted to an explicit,
  // user-confirmable checkbox (see the map step) so a wrong guess is visible and correctable
  // before merging, instead of silently mis-projecting pacing off an unconfirmed assumption.
  const[uploadIsMonthly,setUploadIsMonthly]=useState(false);
  const[editingPlatform,setEditingPlatform]=useState(null); // campaign name being edited
  const PLATFORM_OPTIONS=["auto","Google","Meta","LinkedIn","Bing","Capterra","Reddit","Pinterest","TikTok","YouTube","Other"];
  const[mergedNormRows,setMergedNormRows]=useState([]); // normalized rows across ALL platform uploads
  const[tagDims,setTagDims]=useState(DEFAULT_DIMS);
  const[tags,setTags]=useState({});
  const[selected,setSelected]=useState(new Set());
  const[newDim,setNewDim]=useState("");
  const[tagsHistory,setTagsHistory]=useState([]); // undo stack, max 50
  const[editingTag,setEditingTag]=useState(null); // {campaign, dim}
  const[editVal,setEditVal]=useState("");
  const[applyDim,setApplyDim]=useState("");
  const[applyVal,setApplyVal]=useState("");
  const[dragOver,setDragOver]=useState(false);
  const[notif,setNotif]=useState(null);
  const[sortCol,setSortCol]=useState("spend");
  const[sortDir,setSortDir]=useState("desc");
  const[fCamp,setFCamp]=useState("");
  const[fCampExclude,setFCampExclude]=useState("");
  const[fGroup,setFGroup]=useState("");
  const[fGroupExclude,setFGroupExclude]=useState("");
  const[fPlat,setFPlat]=useState("");
  const[fSMin,setFSMin]=useState("");
  const[fSMax,setFSMax]=useState("");
  const[fTag,setFTag]=useState("");
  const[fTagExclude,setFTagExclude]=useState("");
  // How comma-separated terms within one filter field combine — "or"/ANY vs "and"/ALL — with
  // independent modes for include vs exclude on each field.
  //
  // CORRECTED (2026-07): exclude's default was briefly set to "and" (co-occurrence — only drop a
  // row if it contains every term together) on the theory that that's what "AND" means for an
  // exclude list. Live-tested against a real filter ("oracle,sap" excluding Campaign, mode set to
  // AND) and it was wrong: rows containing only "oracle" kept showing, because under co-occurrence
  // logic they correctly don't have BOTH terms — but that's not what "AND" means to a person reading
  // an exclude field. In natural language, "exclude oracle AND exclude sap" means each term is its
  // own drop rule — a row is gone if it has oracle, and ALSO gone if it has sap — which is "ANY term
  // present" (terms.some), not "every term present" (terms.every). That's the classic De Morgan's
  // mismatch: "excluded if A or B" and "kept only if not-A and not-B" describe the exact same set,
  // but people asking for an exclude list say the second one and mean the first. So exclude now
  // defaults to "or"/ANY (matches that reading), same default as include. "and"/ALL — only drop rows
  // containing every term together — is still available as the narrower option for the rarer case of
  // excluding one specific combination while leaving partial matches alone.
  const[fGroupInclMode,setFGroupInclMode]=useState("or");
  const[fGroupExclMode,setFGroupExclMode]=useState("or");
  const[fCampInclMode,setFCampInclMode]=useState("or");
  const[fCampExclMode,setFCampExclMode]=useState("or");
  const[fTagInclMode,setFTagInclMode]=useState("or");
  const[fTagExclMode,setFTagExclMode]=useState("or");
  const[selectedTagFilters,setSelectedTagFilters]=useState(new Set()); // Set of "dim:val"
  const toggleTagFilter=useCallback((dim,val)=>{
    const key=`${dim}:${val}`;
    setSelectedTagFilters(p=>{const nx=new Set(p);nx.has(key)?nx.delete(key):nx.add(key);return nx;});
  },[]);
  const[fStatus,setFStatus]=useState("all");
  const[filtersOpen,setFiltersOpen]=useState(()=>{try{const v=localStorage.getItem("paidhq_tagger_filters_open");return v===null?true:v==="1";}catch(e){return true;}});
  useEffect(()=>{try{localStorage.setItem("paidhq_tagger_filters_open",filtersOpen?"1":"0");}catch(e){}},[filtersOpen]);
  const fileRef=useRef();
  const screenshotRef=useRef();
  const[screenshotProcessing,setScreenshotProcessing]=useState(false);
  const[screenshotError,setScreenshotError]=useState("");
  const[screenshotPreview,setScreenshotPreview]=useState([]); // rows extracted from an image, pending confirm
  const[screenshotFileName,setScreenshotFileName]=useState("");
  // Ask AI chats — {id,title,messages,history,updatedAt,pinned,projectId,labels}[], persisted
  // server-side per (workspace,user) — see getAskAIData/putAskAIData. activeAskChatId=null means
  // "viewing a blank/new chat"; a chat record is only actually created (and added to askChats) once
  // its first message is sent, so clicking "New chat" repeatedly doesn't pile up empty entries.
  // askProjects (2026-07-21) is the folder/project list chats can optionally be filed under —
  // {id,name}[] — see AskAI's sidebar for create/rename/delete and the assign-to-project action.
  const[askChats,setAskChats]=useState([]);
  const[askProjects,setAskProjects]=useState([]);
  const[activeAskChatId,setActiveAskChatId]=useState(null);
  // "Ask AI about this view →" (2026-07-28, per Mo's scope-awareness ask) — Reporting & Pacing
  // has no way to hand its live filter state straight to AskAI (they're two separately-lazy-
  // loaded tab components, not parent/child), so this is a one-shot relay sitting at the level
  // that already owns both: PacingDashboard calls onAskAboutView(text) to stash a templated
  // question here and switch tabs, AskAI reads it as initialQuestion and immediately clears it
  // via onConsumeInitialQuestion so it doesn't keep re-filling the box on a later visit.
  const[pendingAskQuestion,setPendingAskQuestion]=useState(null);
  // "Save as view" (2026-07-29, per Mo's "build them all" follow-up) — the exact same one-shot
  // relay pattern as pendingAskQuestion above, just running the other direction: AskAI resolves a
  // chat answer's originating question into a canonical view-config (via askAIBuildView +
  // aiConfigToViewConfig — see AskAI.jsx's handleSaveAsView) and hands it here, then this switches
  // to the Reporting & Pacing tab where PacingDashboard applies it via its own applyViewConfig and
  // immediately clears it via onConsumeInitialViewConfig so a later visit doesn't re-apply it.
  const[pendingViewConfig,setPendingViewConfig]=useState(null);

  const[budgets,setBudgets]=useState({});
  const[budgetDims,setBudgetDims]=useState([]);
  const[budgetRowMeta,setBudgetRowMeta]=useState({}); // {segKey: {dim: value}}
  const[budgetMetaDims,setBudgetMetaDims]=useState([]); // annotation dims on budget rows
  const[budgetImportMeta,setBudgetImportMeta]=useState({}); // {year: {hasQuarterlyTotals, hasAnnualTotal}} — captured at import time, used to inform the export-time AI granularity suggestion
  // Saved Views (item 42) — [{id,name,createdAt,viewMode,customDims,segFilters,statusFilter,
  // breakdownDim,trendFilterDim,trendFilterValue,trendSeriesDim,trendMonthSpan}], built/consumed
  // entirely within PacingDashboard (see its currentViewConfig/applyViewConfig). Lives at this
  // top level only because it rides the same debounced workspace-config save/load as
  // budgetRowMeta etc. below, not because anything outside the Reporting & Pacing tab reads it.
  const[savedViews,setSavedViews]=useState([]);
  // Global default forecast model (item 45, 2026-07-25) — the workspace-wide fallback used by
  // computePacing whenever a segment has no per-row override (budgetRowMeta[sk]._forecastModel).
  // Lives at this same top level, rides the same debounced save, for the same reason savedViews
  // does above: a single value the whole workspace shares, not something scoped to one tab's UI
  // state. Defaults to "auto" (2026-07-25, was "full-period" before the Auto/Manual/Committed
  // redesign — see FORECAST_MODELS in lib/core.js) — the same default computePacing itself falls
  // back to, so an unconfigured workspace gets the adaptive model out of the box.
  const[defaultForecastModel,setDefaultForecastModel]=useState("auto");

  // Tag-value autocomplete sources: values already used in the Budget Panel for each dimension,
  // unioned with values already used on other campaigns' tags — either one matching exactly is
  // what actually connects a tagged campaign to a budget segment, so suggesting both keeps new
  // tags consistent with whichever already exists instead of drifting into near-duplicates.
  const budgetDimValues=useMemo(()=>getBudgetDimValues(budgets,budgetDims),[budgets,budgetDims]);
  const tagDimValues=useMemo(()=>{
    const map={};
    Object.values(tags||{}).forEach(t=>{
      Object.entries(t||{}).forEach(([dim,val])=>{
        if(!val)return;
        if(!map[dim])map[dim]=new Set();
        map[dim].add(val);
      });
    });
    const result={};
    Object.keys(map).forEach(d=>result[d]=[...map[d]]);
    return result;
  },[tags]);
  const dimSuggestions=useCallback(dim=>{
    if(!dim)return[];
    return[...new Set([...(budgetDimValues[dim]||[]),...(tagDimValues[dim]||[])])].sort((a,b)=>a.localeCompare(b));
  },[budgetDimValues,tagDimValues]);

  // ── Version history ──
  const[fileMenuOpen,setFileMenuOpen]=useState(false);
  const[versionHistoryOpen,setVersionHistoryOpen]=useState(false);
  const[versions,setVersions]=useState([]);
  const[versionsLoading,setVersionsLoading]=useState(false);
  const[nameVersionOpen,setNameVersionOpen]=useState(false);
  const[nameVersionInput,setNameVersionInput]=useState("");
  const[pendingVersionLabel,setPendingVersionLabel]=useState(null); // {label,trigger} — set right after a mutation, consumed once state has actually settled (see effect below)

  // ── Settings → Clear Tagger data by date range ──
  const[clearRangePlatform,setClearRangePlatform]=useState("all");
  const[clearRangeStart,setClearRangeStart]=useState("");
  const[clearRangeEnd,setClearRangeEnd]=useState("");

  // ── Settings → Team ──
  // myRole comes straight off the workspace prop (already returned by paidhq-core's GET
  // /api/workspaces alongside the workspace itself — no separate fetch needed to know your own
  // access level). "member" is view-only everywhere in the product; the actual enforcement lives
  // server-side (requireEditAccess in every product API route) — this just drives what the Team
  // panel and a few other write affordances show/allow, so a view-only person isn't shown controls
  // that would just 403 if clicked.
  const myRole=workspace?.role||"member";
  const canEdit=myRole!=="member";
  const canManageTeam=myRole==="owner"||myRole==="admin";
  const[teamMembers,setTeamMembers]=useState([]);
  const[teamMembersLoading,setTeamMembersLoading]=useState(false);
  const[teamInvites,setTeamInvites]=useState([]);
  const[inviteEmail,setInviteEmail]=useState("");
  const[inviteRole,setInviteRole]=useState("member");
  const[inviteSending,setInviteSending]=useState(false);
  const[inviteError,setInviteError]=useState("");
  const refreshTeam=useCallback(()=>{
    if(!workspace?.id||!session)return;
    setTeamMembersLoading(true);
    Promise.all([
      listMembers(session,workspace.id),
      canManageTeam?listInvites(session,workspace.id):Promise.resolve([]),
    ]).then(([m,i])=>{setTeamMembers(m);setTeamInvites(i);})
      .catch(e=>console.error("[team]",e))
      .finally(()=>setTeamMembersLoading(false));
  },[workspace?.id,session,canManageTeam]);
  const sendInvite=useCallback(()=>{
    const email=inviteEmail.trim();
    if(!email)return;
    setInviteSending(true);setInviteError("");
    inviteMember(session,workspace.id,{email,role:inviteRole})
      .then(result=>{
        setInviteEmail("");
        refreshTeam();
        if(result.emailSent)showNotif(`Invite sent to ${email}`);
        else{
          // RESEND_API_KEY isn't configured on paidhq-core yet — the invite itself was still
          // created (accepting it works fine), just nothing was emailed. Put the link on the
          // clipboard so it can still be shared by hand instead of silently going nowhere.
          navigator.clipboard?.writeText(result.inviteLink).catch(()=>{});
          showNotif(`Invite created for ${email} — email isn't set up yet, link copied to clipboard instead`);
        }
      })
      .catch(e=>setInviteError(e.message||"Couldn't send that invite."))
      .finally(()=>setInviteSending(false));
  },[session,workspace,inviteEmail,inviteRole,refreshTeam]);
  const changeTeamRole=useCallback((userId,role)=>{
    updateMemberRole(session,workspace.id,userId,role).then(refreshTeam).catch(e=>window.alert(e.message||"Couldn't change that role."));
  },[session,workspace,refreshTeam]);
  const removeTeamMember=useCallback((userId,label)=>{
    if(!window.confirm(`Remove ${label} from this workspace?`))return;
    removeMember(session,workspace.id,userId).then(refreshTeam).catch(e=>window.alert(e.message||"Couldn't remove that member."));
  },[session,workspace,refreshTeam]);
  const revokeTeamInvite=useCallback((email)=>{
    revokeInvite(session,workspace.id,email).then(refreshTeam).catch(e=>window.alert(e.message||"Couldn't revoke that invite."));
  },[session,workspace,refreshTeam]);

  // ── Settings → Workspace (rename + danger-zone delete) ──────────────────────────────────────
  const isOwner=myRole==="owner";
  const[workspaceNameInput,setWorkspaceNameInput]=useState(workspace?.name||"");
  const[workspaceNameSaving,setWorkspaceNameSaving]=useState(false);
  const[workspaceNameError,setWorkspaceNameError]=useState("");
  // Mirrors workspace.name locally rather than editing the prop directly — resets whenever the
  // active workspace itself changes (switching workspaces, or a rename lands from elsewhere).
  useEffect(()=>{setWorkspaceNameInput(workspace?.name||"");setWorkspaceNameError("");},[workspace?.id,workspace?.name]);
  const saveWorkspaceName=useCallback(()=>{
    const name=workspaceNameInput.trim();
    if(!name||name===workspace?.name)return;
    setWorkspaceNameSaving(true);setWorkspaceNameError("");
    renameWorkspace(session,workspace.id,name)
      .then(()=>{onWorkspacesChanged&&onWorkspacesChanged();})
      .catch(e=>setWorkspaceNameError(e.message||"Couldn't rename this workspace."))
      .finally(()=>setWorkspaceNameSaving(false));
  },[session,workspace,workspaceNameInput,onWorkspacesChanged]);

  const[deleteWorkspaceOpen,setDeleteWorkspaceOpen]=useState(false);
  const[deleteWorkspaceConfirmText,setDeleteWorkspaceConfirmText]=useState("");
  const[deleteWorkspaceSaving,setDeleteWorkspaceSaving]=useState(false);
  const[deleteWorkspaceError,setDeleteWorkspaceError]=useState("");
  const confirmDeleteWorkspace=useCallback(()=>{
    if(deleteWorkspaceConfirmText.trim()!==workspace?.name)return;
    setDeleteWorkspaceSaving(true);setDeleteWorkspaceError("");
    deleteWorkspace(session,workspace.id)
      .then(()=>{
        setDeleteWorkspaceOpen(false);setDeleteWorkspaceConfirmText("");
        onWorkspacesChanged&&onWorkspacesChanged();
      })
      .catch(e=>setDeleteWorkspaceError(e.message||"Couldn't delete this workspace."))
      .finally(()=>setDeleteWorkspaceSaving(false));
  },[session,workspace,deleteWorkspaceConfirmText,onWorkspacesChanged]);

  // ── Settings → Account (danger-zone: permanently delete this login) ─────────────────────────
  const[deleteAccountOpen,setDeleteAccountOpen]=useState(false);
  const[deleteAccountConfirmText,setDeleteAccountConfirmText]=useState("");
  const[deleteAccountSaving,setDeleteAccountSaving]=useState(false);
  const[deleteAccountError,setDeleteAccountError]=useState("");
  const confirmDeleteAccount=useCallback(()=>{
    if(deleteAccountConfirmText.trim().toLowerCase()!==(session?.user?.email||"").toLowerCase())return;
    setDeleteAccountSaving(true);setDeleteAccountError("");
    deleteAccount(session)
      .then(()=>{
        // Permanently gone server-side — now retire it from this browser's switcher too (same
        // teardown "Sign out" already does: revokes the local client, drops it from the known-
        // accounts list, and switches over to whatever's left). Reusing onSignOutAccount rather
        // than a separate path keeps there being exactly one place that does this cleanup.
        onSignOutAccount&&onSignOutAccount(activeAccountKey);
      })
      .catch(e=>{setDeleteAccountError(e.message||"Couldn't delete this account.");setDeleteAccountSaving(false);});
  },[session,deleteAccountConfirmText,onSignOutAccount,activeAccountKey]);

  // ── Settings → File Store (server-backed, workspace-scoped — see files.js/workspaceApi.js) ──
  const[fileStoreList,setFileStoreList]=useState([]);
  const[fileStoreLoading,setFileStoreLoading]=useState(false);
  const manualFileRef=useRef(null);
  const refreshFileStore=useCallback(()=>{
    if(!workspace?.id||!session)return;
    setFileStoreLoading(true);
    listFiles(session,workspace.id).then(setFileStoreList).catch(e=>console.error("[file store list]",e)).finally(()=>setFileStoreLoading(false));
  },[workspace?.id,session]);
  // Team and File Store are populated only when refreshTeam()/refreshFileStore() actually run --
  // until recently that only happened from the Settings gear icon's onClick, which misses two real
  // cases: (1) `view` is restored from localStorage on load (see its useState initializer above),
  // so landing directly on Settings on a fresh page load -- simply reloading while already there,
  // as happened while debugging a "members don't show up" report -- never ran through that onClick
  // at all, leaving both panels stuck on their empty initial state with no visible error; (2)
  // switching workspaces while already sitting on the Settings tab left both panels showing the
  // PREVIOUS workspace's data. Watching `view` and `workspace?.id` here covers every path into
  // "the Settings tab, showing the right workspace's data" -- however you got there.
  useEffect(()=>{
    if(view!=="settings")return;
    refreshFileStore();
    refreshTeam();
  },[view,workspace?.id,refreshFileStore,refreshTeam]);
  // Fire-and-forget wrapper for the auto-capture call sites (handleFile, exportTags,
  // importTagsFromCSV below) — a File Store write should never block or fail the actual
  // import/export it's shadowing.
  const archiveFile=useCallback((file,category)=>{
    if(!file||!workspace?.id||!session)return Promise.resolve();
    return fileToBase64(file)
      .then(dataBase64=>apiUploadFile(session,workspace.id,{name:file.name||"untitled",category,mimeType:file.type||"",dataBase64}))
      .catch(e=>console.error("[file store save]",e));
  },[workspace?.id,session]);
  // Previously this failed completely silently on error (console.error only) and gave zero visual
  // feedback even on success -- the list just quietly re-rendered after refreshFileStore resolved.
  // With no loading state and no confirmation, a slow network response or a swallowed error both
  // look identical to the user as "nothing happened", which is what got reported as the button
  // "not working." Now mirrors copyFileToOtherWorkspace's pattern: confirm, show a disabled/loading
  // state on the clicked row's own button, surface failures via alert, and confirm success visibly.
  const[deletingFileId,setDeletingFileId]=useState(null);
  const deleteFileFromStore=useCallback((id,name)=>{
    if(!workspace?.id||!session)return;
    if(!window.confirm(`Delete "${name||"this file"}"? This can't be undone.`))return;
    setDeletingFileId(id);
    apiDeleteFile(session,workspace.id,id)
      .then(()=>{refreshFileStore();showNotif(`Deleted ${name||"file"}`);})
      .catch(e=>window.alert(e.message||"Couldn't delete this file."))
      .finally(()=>setDeletingFileId(null));
  },[workspace?.id,session,refreshFileStore]);
  const downloadFileFromStore=useCallback((rec)=>{
    if(!workspace?.id||!session)return;
    apiDownloadFile(session,workspace.id,rec.id,rec.name).catch(e=>console.error("[file store download]",e));
  },[workspace?.id,session]);
  // Cross-workspace file sharing — opt-in and explicit (see copy.js's doc comment): files are
  // hard-siloed by default, this is the one deliberate escape hatch. Only workspaces where this
  // person has edit access are offered as targets client-side (the server enforces the same rule
  // authoritatively either way) — `workspaces` already carries each entry's `role` from
  // paidhq-core's GET /api/workspaces, no extra fetch needed to build this list.
  const copyTargetWorkspaces=useMemo(()=>
    (workspaces||[]).filter(w=>w.id!==workspace?.id&&(w.role==="owner"||w.role==="admin")),
  [workspaces,workspace?.id]);
  const[copyMenuOpenId,setCopyMenuOpenId]=useState(null);
  // The file list this button lives in scrolls (maxHeight+overflow:auto) — an absolutely
  // positioned dropdown nested inside it would get clipped by that scroll container's bounds
  // instead of floating above the page. Rendered as a portal into document.body instead,
  // positioned from the trigger button's own on-click bounding rect, so it's never clipped
  // regardless of which row it opens from.
  const[copyMenuAnchorRect,setCopyMenuAnchorRect]=useState(null);
  const[copyingFileId,setCopyingFileId]=useState(null);
  const copyFileToOtherWorkspace=useCallback((fileId,targetWorkspaceId,targetWorkspaceName)=>{
    if(!workspace?.id||!session)return;
    setCopyMenuOpenId(null);
    setCopyingFileId(fileId);
    copyFileToWorkspace(session,workspace.id,fileId,targetWorkspaceId)
      .then(()=>showNotif(`Copied to ${targetWorkspaceName}`))
      .catch(e=>window.alert(e.message||"Couldn't copy this file."))
      .finally(()=>setCopyingFileId(null));
  },[session,workspace]);
  const addManualFile=useCallback((file)=>{
    if(!file)return;
    archiveFile(file,"Manual upload").then(refreshFileStore);
    showNotif(`Saved ${file.name} to File Store`);
  },[archiveFile,refreshFileStore]);

  // ── Export (CSV/XLSX/PDF/HTML downloads + email) ──
  const[emailExportOpen,setEmailExportOpen]=useState(false);
  const[emailExportFormat,setEmailExportFormat]=useState("pdf");
  const[emailExportTo,setEmailExportTo]=useState("");
  const[emailExportNote,setEmailExportNote]=useState("");
  const[emailSending,setEmailSending]=useState(false);
  const[emailError,setEmailError]=useState("");

  const buildSnapshot=useCallback(()=>({tags,tagDims,mergedNormRows,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta}),
    [tags,tagDims,mergedNormRows,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta]);
  const persistVersion=useCallback((label,trigger,snapshot)=>{
    if(!workspace?.id||!session)return;
    saveVersion(session,workspace.id,{label,trigger,snapshot}).catch(e=>console.error("[version save]",e));
  },[workspace?.id,session]);
  // Call right AFTER triggering a mutation (setState calls already issued). Multiple setState
  // calls from the same event handler are batched by React into one render, so by the time this
  // effect's dependencies actually change and it runs, every sibling update from that same
  // handler — not just this flag — is already reflected in the values buildSnapshot() reads.
  const checkpoint=useCallback((label,trigger="auto")=>setPendingVersionLabel({label,trigger}),[]);
  useEffect(()=>{
    if(!pendingVersionLabel)return;
    persistVersion(pendingVersionLabel.label,pendingVersionLabel.trigger,buildSnapshot());
    setPendingVersionLabel(null);
  },[pendingVersionLabel,buildSnapshot,persistVersion]);
  // Call BEFORE mutating state, when the CURRENT (about-to-change) values need capturing rather
  // than whatever they become after — used by restoreVersion so undoing a restore is possible.
  const snapshotNow=useCallback((label,trigger="auto")=>persistVersion(label,trigger,buildSnapshot()),[persistVersion,buildSnapshot]);

  const openVersionHistory=useCallback(()=>{
    setFileMenuOpen(false);setVersionHistoryOpen(true);
    if(!workspace?.id||!session){setVersions([]);return;}
    setVersionsLoading(true);
    listVersions(session,workspace.id).then(setVersions).catch(e=>{console.error("[version list]",e);setVersions([]);}).finally(()=>setVersionsLoading(false));
  },[workspace?.id,session]);
  const saveNamedVersion=useCallback(()=>{
    const label=nameVersionInput.trim();
    if(!label)return;
    snapshotNow(label,"manual");
    setNameVersionOpen(false);setNameVersionInput("");setFileMenuOpen(false);
    showNotif(`Saved version "${label}"`);
  },[nameVersionInput,snapshotNow]);
  const restoreVersion=useCallback(record=>{
    if(!canEdit)return;
    if(!window.confirm(`Restore "${record.label}"?\n\nFrom ${new Date(record.timestamp).toLocaleString()}. Your current data will be saved as a new version first, so you can always come back to it.\n\nThis replaces your current Tagger and Budget data.`))return;
    snapshotNow("Before restoring an earlier version","pre_restore");
    const s=record.snapshot||{};
    // A restored version can legitimately be empty (e.g. restoring to a point before any data
    // existed) — that's a deliberate user choice via this confirm dialog, same authorization
    // pattern as the Settings clear-* actions use for the debounced-save empty-write guard.
    allowEmptyConfigWriteRef.current=true;allowEmptyRowsWriteRef.current=true;
    setTags(s.tags||{});setTagDims(s.tagDims||DEFAULT_DIMS);setMergedNormRows(s.mergedNormRows||[]);
    setBudgets(s.budgets||{});setBudgetDims(s.budgetDims||[]);setBudgetRowMeta(s.budgetRowMeta||{});setBudgetMetaDims(s.budgetMetaDims||[]);setBudgetImportMeta(s.budgetImportMeta||{});
    setStep((s.mergedNormRows||[]).length?"tag":"upload");
    setVersionHistoryOpen(false);
    showNotif("Version restored");
  },[snapshotNow,canEdit]);
  const deleteVersion=useCallback((id,e)=>{
    e.stopPropagation();
    if(!workspace?.id||!session)return;
    if(!window.confirm("Delete this saved version? This can't be undone."))return;
    apiDeleteVersion(session,workspace.id,id).then(()=>setVersions(p=>p.filter(v=>v.id!==id))).catch(err=>console.error("[version delete]",err));
  },[workspace?.id,session]);

  // Device-local preferences only (not workspace data — these stay in localStorage even after
  // the data-layer migration below, since there's no reason a sidebar width should follow you to
  // a different browser/device). askChats itself moved to per-(workspace,user) server storage —
  // see the load/save effects below — since it's real conversation history that shouldn't vanish
  // on a new device, and definitely shouldn't leak between different workspaces the way a single
  // fixed localStorage key did.
  useEffect(()=>{try{
    const le=localStorage.getItem("paidhq_last_export_email");if(le)setEmailExportTo(le);
    const aid=localStorage.getItem("paidhq_ask_active_chat");if(aid)setActiveAskChatId(aid);
  }catch(e){};},[]);
  // Persists whichever tab is open (see the VALID_VIEWS-checked useState above) so a refresh
  // reopens the same tab instead of always resetting to Dashboard.
  useEffect(()=>{try{localStorage.setItem("paidhq_last_view",view);}catch(e){};},[view]);
  useEffect(()=>{try{if(activeAskChatId)localStorage.setItem("paidhq_ask_active_chat",activeAskChatId);else localStorage.removeItem("paidhq_ask_active_chat");}catch(e){};},[activeAskChatId]);

  // Stable across a token refresh (only actually changes on a real login/logout/user switch) —
  // used as an effect dependency below instead of the `session` object itself, and declared here
  // (rather than down by sessionRef, where it originally lived) since the AI-chats effects right
  // below need it and run before that point in this function.
  const sessionUserId=session?.user?.id;

  // ── Ask AI chat history — server-backed, scoped per (workspace, user) ──────────────────────
  // Loads fresh every time the active workspace (or signed-in user) changes, and saves back with
  // a short debounce, same pattern as the workspace-config/spend-rows saves below just without
  // their elaborate empty-write guard — losing a few seconds of in-progress chat on a hard crash
  // is a much smaller deal than losing budget/tag edits, so that complexity isn't worth mirroring
  // here. aiChatsLoadedRef blocks the save effect from firing (and overwriting real server data
  // with []) before the initial load for a newly-selected workspace has actually resolved.
  const aiChatsLoadedRef=useRef(false);
  const saveAiChatsTimer=useRef(null);
  useEffect(()=>{
    if(!workspace?.id||!session)return;
    aiChatsLoadedRef.current=false;
    getAskAIData(session,workspace.id)
      .then(({chats,projects})=>{setAskChats(chats||[]);setAskProjects(projects||[]);aiChatsLoadedRef.current=true;})
      .catch(e=>console.error("[ai chats load]",e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[workspace?.id,sessionUserId]);
  useEffect(()=>{
    if(!workspace?.id||!session||!aiChatsLoadedRef.current)return;
    clearTimeout(saveAiChatsTimer.current);
    saveAiChatsTimer.current=setTimeout(()=>{
      putAskAIData(session,workspace.id,{chats:askChats,projects:askProjects}).catch(e=>console.error("[ai chats save]",e));
    },800);
    return()=>clearTimeout(saveAiChatsTimer.current);
  },[askChats,askProjects,workspace?.id,session]);

  // ── Workspace data (tags/dims/budgets/spend rows) — synced with the server, not localStorage ──
  // Tags, tag dimensions, budgets, budget dimensions/annotations, and spend rows are the actual
  // product data — the whole point of the multi-tenant backend is that this lives per-workspace
  // on the server, not per-browser, so it's there on any device and shareable across a team. Two
  // "loaded" refs (rather than state, since they don't need to trigger renders) gate the debounced
  // save effects below so they never fire with the still-empty initial state before the real data
  // has come back from the GETs — without that guard, mounting the component would briefly hold
  // {}/[] and the save effects would immediately overwrite real server data with those defaults.
  const[workspaceDataLoading,setWorkspaceDataLoading]=useState(true);
  const[workspaceDataError,setWorkspaceDataError]=useState("");
  const configLoadedRef=useRef(false);
  const rowsLoadedRef=useRef(false);
  const saveConfigTimer=useRef(null);
  const saveRowsTimer=useRef(null);

  // One-time import of pre-auth localStorage data — anyone who used BudgetHQ before login/
  // workspaces existed has real tags/budgets/spend rows sitting under the old "paidhq_*" keys in
  // this browser. That data doesn't disappear just because loading now goes through the server,
  // but it also won't show up in a brand-new empty workspace on its own — this offers a one-time
  // "import it into this workspace" prompt the first time a workspace with no server data yet is
  // opened in a browser that still has that legacy local data lying around.
  const[localImportPrompt,setLocalImportPrompt]=useState(null);
  function readLegacyLocalData(){
    try{
      const t=localStorage.getItem("paidhq_tags");
      let tags=null;
      if(t){
        const parsed=JSON.parse(t);
        tags={};
        // Same "||" composite-key migration the old mount-time loader used to do — old keys were
        // the plain campaign name alone, campaignKey() now expects "group||name".
        Object.entries(parsed).forEach(([k,v])=>{tags[k.includes("||")?k:campaignKey(k,k)]=v;});
      }
      const d=localStorage.getItem("paidhq_dims");
      const b=localStorage.getItem("paidhq_budgets");
      const bd=localStorage.getItem("paidhq_budget_dims");
      const bm=localStorage.getItem("paidhq_budget_meta");
      const bmd=localStorage.getItem("paidhq_budget_meta_dims");
      const bim=localStorage.getItem("paidhq_budget_import_meta");
      const sr=localStorage.getItem("paidhq_rows");
      const rows=sr?JSON.parse(sr).map(r=>r.campaign_group_name?r:{...r,campaign_group_name:r.campaign_name}):null;
      if(!tags&&!d&&!b&&!bd&&!bm&&!bmd&&!bim&&!rows)return null;
      return{
        tags:tags||{},
        tagDims:d?JSON.parse(d):DEFAULT_DIMS,
        budgets:b?JSON.parse(b):{},
        budgetDims:bd?JSON.parse(bd):[],
        budgetRowMeta:bm?JSON.parse(bm):{},
        budgetMetaDims:bmd?JSON.parse(bmd):[],
        budgetImportMeta:bim?JSON.parse(bim):{},
        rows:rows||[],
      };
    }catch(e){console.error("[legacy local data read]",e);return null;}
  }
  const clearLegacyLocalKeys=useCallback(()=>{
    try{LEGACY_LOCAL_KEYS.forEach(k=>localStorage.removeItem(k));}catch(e){console.error("[legacy local data clear]",e);}
  },[]);
  const importLegacyLocalData=useCallback(()=>{
    if(!canEdit)return;
    if(!localImportPrompt)return;
    setTags(localImportPrompt.tags);
    setTagDims(localImportPrompt.tagDims.length?localImportPrompt.tagDims:DEFAULT_DIMS);
    setBudgets(localImportPrompt.budgets);
    setBudgetDims(localImportPrompt.budgetDims);
    setBudgetRowMeta(localImportPrompt.budgetRowMeta);
    setBudgetMetaDims(localImportPrompt.budgetMetaDims);
    setBudgetImportMeta(localImportPrompt.budgetImportMeta);
    setMergedNormRows(localImportPrompt.rows);
    if(localImportPrompt.rows.length){setStep("tag");setView("tagger");}
    clearLegacyLocalKeys();
    setLocalImportPrompt(null);
    checkpoint("Imported data from before sign-in","import_legacy");
    showNotif("Imported your existing data into this workspace");
  },[localImportPrompt,checkpoint,clearLegacyLocalKeys,canEdit]);
  const dismissLegacyLocalData=useCallback(()=>{
    clearLegacyLocalKeys();
    setLocalImportPrompt(null);
  },[clearLegacyLocalKeys]);

  // Supabase's onAuthStateChange (see AuthGate.jsx) fires with a BRAND NEW `session` object on
  // every background token refresh — which supabase-js explicitly triggers on tab-visibility
  // regain, not just its normal hourly cadence. That new object is a different reference for the
  // exact same logged-in user, but every effect below used to have `session` itself in its
  // dependency array — so simply switching browser tabs away and back could silently re-fire the
  // load effect just below, which immediately does configLoadedRef.current=false and re-fetches,
  // OVERWRITING any not-yet-saved local edit with whatever's still on the server. THIS, not the
  // page-unload race the keepalive flush further down addresses, was the actual "data disappears
  // when I move away from the tab" bug — a token refresh alone was enough to trigger it, no
  // navigation or reload required. Fix: key every effect below off `session?.user?.id` (stable
  // across a token refresh, only actually changes on a real login/logout/user switch) instead of
  // the `session` object itself, while a ref keeps the latest token available for the API calls
  // those effects make so auth still works correctly long after an effect last re-ran.
  const sessionRef=useRef(session);
  useEffect(()=>{sessionRef.current=session;});
  // Same "want the latest value without retriggering this effect" reasoning as sessionRef above —
  // used by the setStep("tag") default a few lines down, which needs to know which tab was active
  // at the moment this data finished loading WITHOUT re-running the entire workspace-data fetch
  // every time the user switches tabs (view changes far more often than workspace/session do).
  const viewRef=useRef(view);
  useEffect(()=>{viewRef.current=view;});

  useEffect(()=>{
    if(!workspace?.id||!session){setWorkspaceDataLoading(false);return;}
    setWorkspaceDataLoading(true);setWorkspaceDataError("");
    configLoadedRef.current=false;rowsLoadedRef.current=false;
    Promise.all([getWorkspaceConfig(sessionRef.current,workspace.id),getSpendRows(sessionRef.current,workspace.id)])
      .then(([config,rows])=>{
        setTags(config.tags||{});
        setTagDims((config.tagDims||[]).length?config.tagDims:DEFAULT_DIMS);
        // Both passes below self-heal any duplication already sitting in this workspace's stored
        // data (from before the 2026-07-21 dedup fix) every time it loads, not just going forward —
        // see mergeRows and consolidateBudgetSegKeys's doc comments for exactly what causes each.
        const{budgets:cleanBudgets,budgetRowMeta:cleanBudgetRowMeta,changed:budgetsDeduped}=consolidateBudgetSegKeys(config.budgets||{},config.budgetRowMeta||{});
        setBudgets(cleanBudgets);
        setBudgetDims(config.budgetDims||[]);
        setBudgetRowMeta(cleanBudgetRowMeta);
        setBudgetMetaDims(config.budgetMetaDims||[]);
        setBudgetImportMeta(config.budgetImportMeta||{});
        setSavedViews(config.savedViews||[]);
        setDefaultForecastModel(config.defaultForecastModel||"auto");
        const dedupedRows=mergeRows([],rows||[]);
        const rowsDeduped=dedupedRows.length!==(rows||[]).length;
        setMergedNormRows(dedupedRows);
        // Defaults straight to the Tagger's "tag" step when data already exists, so a fresh load
        // doesn't dump you on an empty-looking upload screen — EXCEPT when Data Sources (view==="data")
        // is the tab actually active at that moment. Data Sources has its own "upload" step meaning
        // (its connector table/add-source grid, gated by step==="upload"&&view==="data" further down)
        // — unconditionally overwriting it here meant ANY full-page reload while parked on Data
        // Sources with existing data (any hard refresh, or the OAuth connect round-trip's real
        // top-level navigation back — see VALID_VIEWS's fix above for the sibling half of this same
        // bug class) silently forced step to "tag" and left Data Sources permanently blank, since
        // the one thing that normally resets step back to "upload" is the nav bar's own Data Sources
        // click handler, which a full reload never fires. Reproduced live 2026-07-28 (per Mo) via a
        // debug overlay showing step="tag" while view="data" — an in-app tab switch was never
        // involved. Fixed by leaving step alone whenever Data Sources is the active tab at load time.
        if(dedupedRows.length&&viewRef.current!=="data")setStep("tag");
        configLoadedRef.current=true;rowsLoadedRef.current=true;
        const configEmpty=isEmptyConfig(config);
        const rowsEmpty=!dedupedRows.length;
        // Remember that this workspace is CONFIRMED to have real data on the server — the guard
        // just below refuses to let a later save silently replace it with nothing. Only flips to
        // true, never back to false by loading — going empty has to be an explicit, user-confirmed
        // clear action (which sets the allowEmpty*Ref flags itself) or a workspace that was
        // genuinely empty from the very first load.
        if(!configEmpty)hadRealConfigRef.current=true;
        if(!rowsEmpty)hadRealRowsRef.current=true;
        if(configEmpty&&rowsEmpty){
          const legacy=readLegacyLocalData();
          if(legacy)setLocalImportPrompt(legacy);
        }
        // Surfacing this rather than silently rewriting history — the next debounced save (already
        // watching mergedNormRows/budgets/budgetRowMeta) persists the cleaned data automatically.
        if(rowsDeduped||budgetsDeduped){
          const parts=[];
          if(rowsDeduped)parts.push(`${(rows||[]).length-dedupedRows.length} duplicate spend row${(rows||[]).length-dedupedRows.length===1?"":"s"}`);
          if(budgetsDeduped)parts.push("duplicate budget segments");
          showNotif(`Cleaned up ${parts.join(" and ")} found on load`);
        }
      })
      .catch(e=>{
        console.error("[workspace data load]",e);
        setWorkspaceDataError(e.message||"Couldn't load this workspace's data.");
      })
      .finally(()=>setWorkspaceDataLoading(false));
  },[workspace?.id,sessionUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data-loss fix (2026-07-20): the debounced saves below have an 800ms window where a real
  // edit sits only in React state, not yet on the server. Refreshing, closing the tab, or
  // navigating away inside that window used to just abandon the pending setTimeout — the save
  // never fired, and the edit was gone for good on reload. These refs track "is there an unsaved
  // change right now" plus the latest snapshot to send, so a beforeunload/visibilitychange
  // listener (registered once, below) can flush immediately instead of waiting out the debounce —
  // see flushPendingSaves.
  const configDirtyRef=useRef(false);
  const rowsDirtyRef=useRef(false);
  const latestConfigRef=useRef(null);
  const latestRowsRef=useRef(null);
  useEffect(()=>{latestConfigRef.current={tags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta,savedViews,defaultForecastModel};});
  useEffect(()=>{latestRowsRef.current=mergedNormRows;});

  // ── Second, independent safety net (2026-07-20) ─────────────────────────────────────────────
  // The session-churn bug above was real and is fixed, but data still went missing on a plain
  // refresh even on a confirmed-live deploy of that fix — meaning there's at least one more path
  // to an accidental empty save that hasn't been pinned down yet. Rather than keep chasing timing
  // bugs one at a time while real data is at risk, this is a hard backstop in the save layer
  // itself: once a workspace is known to have real data (hadRealConfigRef/hadRealRowsRef, set by
  // the load above), NO save is allowed to replace it with an all-empty payload UNLESS one of the
  // explicit, user-confirmed "Clear data" actions in Settings set the matching allowEmpty*Ref
  // right before doing it (each one does, see clearTaggerData/clearBudgetData/clearPlatformData/
  // etc.). Any other empty payload gets skipped (not sent) and logged loudly instead of silently
  // destroying server data — worst case it just keeps retrying every 800ms until either real data
  // reappears or someone notices the console error, which is a vastly better failure mode than
  // what prompted this.
  const hadRealConfigRef=useRef(false);
  const hadRealRowsRef=useRef(false);
  const allowEmptyConfigWriteRef=useRef(false);
  const allowEmptyRowsWriteRef=useRef(false);

  // Debounced whole-document save — mirrors the shape api/workspaces/[id]/data.js's PUT expects.
  // Keyed off sessionUserId, not session itself — see the big comment above the load effect.
  useEffect(()=>{
    if(!workspace?.id||!session||!configLoadedRef.current)return;
    configDirtyRef.current=true;
    clearTimeout(saveConfigTimer.current);
    saveConfigTimer.current=setTimeout(()=>{
      const payload={tags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta,savedViews,defaultForecastModel};
      if(isEmptyConfig(payload)&&hadRealConfigRef.current&&!allowEmptyConfigWriteRef.current){
        console.error("[workspace config save] BLOCKED — refusing to overwrite known real data with an empty payload. This save was skipped, not sent; nothing on the server changed. If you meant to clear this workspace's data, use Settings → Clear data instead of whatever just triggered this.");
        return; // stays dirty — retries on the next change, or once real data is back
      }
      allowEmptyConfigWriteRef.current=false; // one-shot — consumed whether or not this payload was actually empty
      putWorkspaceConfig(sessionRef.current,workspace.id,payload)
        .then(()=>{configDirtyRef.current=false;if(!isEmptyConfig(payload))hadRealConfigRef.current=true;})
        .catch(e=>console.error("[workspace config save]",e)); // stays flagged dirty — next flush/edit retries it
    },800);
    return()=>clearTimeout(saveConfigTimer.current);
  },[tags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta,savedViews,defaultForecastModel,workspace?.id,sessionUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced whole-dataset replace for spend rows — see spend-rows.js PUT doc comment for why
  // replace-all (not incremental) is the sync model here.
  useEffect(()=>{
    if(!workspace?.id||!session||!rowsLoadedRef.current)return;
    rowsDirtyRef.current=true;
    clearTimeout(saveRowsTimer.current);
    saveRowsTimer.current=setTimeout(()=>{
      const rowsEmpty=mergedNormRows.length===0;
      if(rowsEmpty&&hadRealRowsRef.current&&!allowEmptyRowsWriteRef.current){
        console.error("[spend rows save] BLOCKED — refusing to overwrite known real spend data with an empty payload. This save was skipped, not sent; nothing on the server changed. If you meant to clear this workspace's spend data, use Settings → Clear data instead of whatever just triggered this.");
        return;
      }
      allowEmptyRowsWriteRef.current=false;
      putSpendRows(sessionRef.current,workspace.id,mergedNormRows)
        .then(()=>{rowsDirtyRef.current=false;if(!rowsEmpty)hadRealRowsRef.current=true;})
        .catch(e=>console.error("[spend rows save]",e)); // stays flagged dirty — next flush/edit retries it
    },800);
    return()=>clearTimeout(saveRowsTimer.current);
  },[mergedNormRows,workspace?.id,sessionUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fires the pending save(s) immediately instead of waiting out the 800ms debounce — called right
  // before the page actually goes away. Uses `keepalive:true` so the request survives past the
  // point the browser would normally cancel in-flight fetches for an unloading page (same
  // mechanism sendBeacon uses, chosen over sendBeacon itself because it needs a custom
  // Authorization header). One real limit worth knowing: keepalive requests are capped around 64KB
  // by the browser, so a workspace with a very large spend-rows dataset could still lose its very
  // last edit in this narrow window — everything below 800ms-old at unload time for smaller/
  // typical workspaces is covered, which is the vast majority of real "I refreshed too fast" cases.
  // Same empty-payload guard as the two debounced effects above — a flush is still just a save.
  const flushPendingSaves=useCallback(()=>{
    if(!workspace?.id||!sessionRef.current)return;
    if(configDirtyRef.current&&latestConfigRef.current){
      clearTimeout(saveConfigTimer.current);
      const blocked=isEmptyConfig(latestConfigRef.current)&&hadRealConfigRef.current&&!allowEmptyConfigWriteRef.current;
      if(blocked){
        console.error("[workspace config flush] BLOCKED — refusing to overwrite known real data with an empty payload on unload/tab-hide.");
      }else{
        allowEmptyConfigWriteRef.current=false;
        putWorkspaceConfig(sessionRef.current,workspace.id,latestConfigRef.current,{keepalive:true}).catch(()=>{});
        configDirtyRef.current=false;
      }
    }
    if(rowsDirtyRef.current&&latestRowsRef.current){
      clearTimeout(saveRowsTimer.current);
      const rowsBlocked=latestRowsRef.current.length===0&&hadRealRowsRef.current&&!allowEmptyRowsWriteRef.current;
      if(rowsBlocked){
        console.error("[spend rows flush] BLOCKED — refusing to overwrite known real spend data with an empty payload on unload/tab-hide.");
      }else{
        allowEmptyRowsWriteRef.current=false;
        putSpendRows(sessionRef.current,workspace.id,latestRowsRef.current,{keepalive:true}).catch(()=>{});
        rowsDirtyRef.current=false;
      }
    }
  },[workspace?.id]);

  useEffect(()=>{
    const onHide=()=>{if(document.visibilityState==="hidden")flushPendingSaves();};
    window.addEventListener("beforeunload",flushPendingSaves);
    document.addEventListener("visibilitychange",onHide);
    return()=>{
      window.removeEventListener("beforeunload",flushPendingSaves);
      document.removeEventListener("visibilitychange",onHide);
    };
  },[flushPendingSaves]);

  // ── Platform sync ──────────────────────────────────────────────────────────
  const[syncState,setSyncState]=useState({}); // {platform: "idle"|"loading"|"done"|"error"}
  // perWorkspaceAuth: true marks a platform whose credential is connected per-workspace (stored
  // in core.connector_credentials, see connections.js) rather than the single shared
  // process.env credential linkedin/bing/capterra use for the whole app. isSheets is a third,
  // different shape again — no stored credential at all, just a client-side Google OAuth token
  // used once per pull (see lib/googleSheets.js), so it's excluded from both the sync-button flow
  // AND the connect-panel flow below and gets its own small inline connector.
  const PLATFORMS=[
    {key:"linkedin",label:"LinkedIn",status:"live",perWorkspaceAuth:true,oauth:true,color:"#0A66C2",desc:"Ad account, OAuth-connected",domain:"linkedin.com"},
    {key:"bing",label:"Bing",status:"live",perWorkspaceAuth:true,oauth:true,color:"#00809D",desc:"Microsoft Advertising, OAuth-connected",domain:"bing.com",mark:BingMark},
    {key:"google",label:"Google Ads",status:"live",perWorkspaceAuth:true,oauth:true,color:"#EA4335",desc:"Ad account, OAuth-connected",domain:"ads.google.com",mark:GoogleAdsMark},
    {key:"meta",label:"Meta Ads",status:"live",perWorkspaceAuth:true,oauth:true,color:"#1877F2",desc:"Ad account, OAuth-connected",domain:"meta.com"},
    {key:"capterra",label:"Capterra",status:"live",perWorkspaceAuth:true,color:"#FF7043",desc:"API key per product",domain:"capterra.com",
      connectFields:[
        {key:"apiKeys",label:"Product API keys",type:"keyvaluelist",pairLabelName:"Product name",pairValueName:"API key",pairLabelPlaceholder:"e.g. Financial Reporting",pairValuePlaceholder:"Paste the key Capterra emailed you"},
      ]},
    {key:"funnel",label:"Funnel.io",status:"live",perWorkspaceAuth:true,color:"#6C5CE7",desc:"Blended multi-channel data via Funnel's API",domain:"funnel.io",
      connectFields:[
        {key:"apiToken",label:"API token",placeholder:"Account Settings → API in Funnel.io"},
        {key:"accountId",label:"Account ID",placeholder:"From your Funnel.io app URL"},
        {key:"projectId",label:"Project ID",placeholder:"From your Funnel.io app URL"},
      ]},
    {key:"supermetrics",label:"Supermetrics",status:"live",perWorkspaceAuth:true,color:"#00C2A8",desc:"Blended multi-channel data via Supermetrics' API",domain:"supermetrics.com",
      connectFields:[
        {key:"apiKey",label:"API key",placeholder:"User settings → API Authentication in Supermetrics"},
        {key:"dsId",label:"Data source ID",placeholder:"e.g. GAWA (Google Ads), FACEBOOK, LINKEDIN"},
        {key:"dsAccounts",label:"Account ID (optional)",placeholder:"Leave blank for every account this key can access"},
      ]},
    {key:"sheets",label:"Google Sheets",status:"live",isSheets:true,color:"#0F9D58",desc:"One-time pull from a sheet URL — no stored credential",domain:"sheets.google.com"},
    {key:"excel",label:"Excel Online",status:"csv",color:"#217346",desc:"No direct API yet — upload a CSV export",domain:"office.com"},
  ];
  // Data Sources tab (2026-07-24, modeled on Funnel.io's Data sources / Connect data source split
  // per Mo — he's planning to add more connectors over time and wants a dedicated page for browsing/
  // adding them, separate from the table that manages what's already connected): "connections" is
  // the default — the table of already-connected sources; "add" is the full grid of everything
  // connectable (including the CSV/Screenshot/Budget file manual imports) plus a search box and a
  // breadcrumb back. Resets to "connections" on leaving the Data Sources tab entirely so it never
  // opens back up mid-browse.
  const[dataSourcesSubView,setDataSourcesSubView]=useState("connections");
  const[dataSourceSearch,setDataSourceSearch]=useState("");
  useEffect(()=>{if(view!=="data")setDataSourcesSubView("connections");},[view]);
  const[lastSyncRange,setLastSyncRange]=useState(()=>{
    try{const s=localStorage.getItem("paidhq_sync_range");return s?JSON.parse(s):null;}catch(e){return null;}
  });
  // Defaults to Jan 1 of the current year through today — matches the "This year" preset below
  // (2026-07-24, per Mo: quarter-to-date was too narrow a default for a first sync).
  const[syncDateRange,setSyncDateRange]=useState(()=>{
    const now=new Date();
    return{start:localISODate(new Date(now.getFullYear(),0,1)),end:localISODate(now)};
  });
  // Recommended/Custom date-range picker for the manual "Pull live spend data" bar (2026-07-23) —
  // replaces two bare date inputs with Funnel.io-style presets, since typing exact dates every sync
  // is the friction Mo flagged. Presets always compute relative to "today" at click time (not the
  // range's own start/end), same as Funnel's "Recommended" tab. Custom keeps the plain fixed-date
  // inputs for the "I need this exact past window" case (e.g. redoing Jan–Jun) that no preset covers.
  const[syncRangePickerOpen,setSyncRangePickerOpen]=useState(false);
  const[syncRangeTab,setSyncRangeTab]=useState("recommended");
  const SYNC_RANGE_PRESETS=[
    {label:"Last 7 days",days:7},{label:"Last 14 days",days:14},{label:"Last 30 days",days:30},
    {label:"Last 3 months",months:3},{label:"Last 6 months",months:6},{label:"This year",thisYear:true},
  ];
  const applySyncRangePreset=(preset)=>{
    const now=new Date();
    const end=localISODate(now);
    let start;
    if(preset.thisYear){start=localISODate(new Date(now.getFullYear(),0,1));}
    else if(preset.months){const s=new Date(now);s.setMonth(s.getMonth()-preset.months);start=localISODate(s);}
    else{const s=new Date(now);s.setDate(s.getDate()-(preset.days-1));start=localISODate(s);}
    setSyncDateRange({start,end});
    setSyncRangePickerOpen(false);
  };

  // ── Per-workspace connector credentials (Funnel.io, Supermetrics) ──────────────────────────
  // Which perWorkspaceAuth platforms this workspace has already connected — drives whether
  // clicking the platform button opens the "connect your account" panel or runs a normal sync.
  const[connectedProviders,setConnectedProviders]=useState({});
  // Full per-provider detail (connectedAt/connectedBy/summary/needsReconnect/needsAccountSelection)
  // for the Data Sources tab's connector table + Add data source grid. Used to carry two sibling
  // boolean maps (providersNeedingReconnect/providersNeedingAccountSelection) for the old sync-bar
  // pills; removed 2026-07-24 when those pills were replaced — every consumer now reads
  // needsReconnect/needsAccountSelection straight off the matching connectionDetails entry instead.
  const[connectionDetails,setConnectionDetails]=useState([]);
  const refreshConnectedProviders=useCallback(()=>{
    if(!workspace?.id||!session?.access_token)return;
    listConnections(session,workspace.id)
      .then(connections=>{
        setConnectedProviders(Object.fromEntries((connections||[]).map(c=>[c.provider,true])));
        setConnectionDetails(connections||[]);
      })
      .catch(()=>{}); // non-fatal — worst case the button just offers to (re)connect
  },[workspace?.id,session?.access_token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{refreshConnectedProviders();},[refreshConnectedProviders]);
  // Settings → Connections "Disconnect" — removes the stored credential entirely (existing DELETE
  // endpoint, previously built but never wired to any button). Confirmed inline rather than a
  // window.confirm since disconnecting isn't destructive to any DATA already synced, just stops
  // future syncs until reconnected.
  const[disconnectingProvider,setDisconnectingProvider]=useState(null);
  const disconnectConnection=useCallback((provider)=>{
    if(!workspace?.id||!session?.access_token)return;
    const label=PLATFORMS.find(p=>p.key===provider)?.label||provider;
    if(!window.confirm(`Disconnect ${label}? Already-synced spend data stays put — you'll just need to reconnect before syncing again.`))return;
    setDisconnectingProvider(provider);
    deleteConnection(session,workspace.id,provider)
      .then(()=>{refreshConnectedProviders();showNotif(`Disconnected ${label}.`);})
      .catch(e=>showNotif(`Couldn't disconnect: ${e.message}`))
      .finally(()=>setDisconnectingProvider(null));
  },[workspace?.id,session?.access_token,refreshConnectedProviders]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settings → Connections "Sync schedule" — PATCHes the same connection's sync_mode/window/
  // frequency. Saves immediately on change (same instant-save pattern as the Team panel's role
  // dropdown) rather than needing a separate Save button. See api/cron/sync-connectors.js's doc
  // comment for why "weekly" doesn't mean an exact custom time of day the way Funnel.io's picker
  // implies — it's a once-daily heartbeat that skips connections that aren't due yet.
  const[savingSchedule,setSavingSchedule]=useState(null); // provider currently saving, or null
  const updateSyncSchedule=useCallback((provider,{syncMode,rollingWindowDays,syncFrequency})=>{
    if(!workspace?.id||!session?.access_token)return;
    setSavingSchedule(provider);
    patchConnection(session,workspace.id,provider,{syncMode,rollingWindowDays,syncFrequency})
      .then(()=>{refreshConnectedProviders();showNotif(syncMode==="rolling"?"Rolling sync enabled — runs once daily and checks if this connection is due.":"Switched back to manual sync.");})
      .catch(e=>showNotif(`Couldn't save schedule: ${e.message}`))
      .finally(()=>setSavingSchedule(null));
  },[workspace?.id,session?.access_token,refreshConnectedProviders]); // eslint-disable-line react-hooks/exhaustive-deps

  // Data Sources connector table's "Pause import" / "Don't use data in BudgetHQ" actions (2026-07-24)
  // — same instant-save PATCH pattern as the schedule dropdown above, just toggling one boolean at
  // a time. `flags` is a partial {paused?, excludedFromData?} object so a caller only ever sends the
  // one thing it's actually changing. See schema.sql's doc comment on these columns for exactly what
  // each one does.
  const[savingConnectionFlag,setSavingConnectionFlag]=useState(null); // provider currently saving, or null
  const updateConnectionFlags=useCallback((provider,flags)=>{
    if(!workspace?.id||!session?.access_token)return;
    setSavingConnectionFlag(provider);
    patchConnection(session,workspace.id,provider,flags)
      .then(()=>{
        refreshConnectedProviders();
        const label=PLATFORMS.find(p=>p.key===provider)?.label||provider;
        if(flags.paused!==undefined)showNotif(flags.paused?`Paused ${label} — it won't sync until resumed.`:`Resumed ${label}.`);
        if(flags.excludedFromData!==undefined)showNotif(flags.excludedFromData?`${label}'s data is hidden from BudgetHQ — reversible any time.`:`${label}'s data is back in BudgetHQ.`);
      })
      .catch(e=>showNotif(`Couldn't save: ${e.message}`))
      .finally(()=>setSavingConnectionFlag(null));
  },[workspace?.id,session?.access_token,refreshConnectedProviders]); // eslint-disable-line react-hooks/exhaustive-deps
  // Connector table's "⋯" actions menu (Switch account/Reconnect/Pause/Exclude/Disconnect) —
  // same anchored-portal-dropdown pattern as the File Store's "copy to workspace" menu.
  const[connActionsMenuProvider,setConnActionsMenuProvider]=useState(null);
  const[connActionsMenuAnchorRect,setConnActionsMenuAnchorRect]=useState(null);
  // Always clear BOTH together — the menu's fixed, inset:0, full-viewport backdrop (which sits on
  // top of the entire page, nav bar included, while open) is only NOT rendered when
  // connActionsMenuProvider is null; leaving connActionsMenuAnchorRect stale behind isn't the bug
  // by itself (the render check requires both), but this makes it structurally impossible for the
  // two to ever disagree — reported 2026-07-24 as "clicking anything, including other nav tabs,
  // does nothing" right after using this menu, which is exactly what a stuck-open backdrop looks
  // like from the outside (it's fully transparent, so there's nothing to see).
  const closeConnActionsMenu=useCallback(()=>{setConnActionsMenuProvider(null);setConnActionsMenuAnchorRect(null);},[]);
  // Extra safety net on top of closeConnActionsMenu being used at every click site: every action in
  // this menu ends by calling refreshConnectedProviders() (or navigating away entirely), so there's
  // no legitimate reason for the menu to still be open once connectionDetails has actually changed
  // — force it closed whenever that happens, so a stuck-open backdrop can't survive past the next
  // data refresh even in some edge case the per-click closes above didn't anticipate.
  useEffect(()=>{closeConnActionsMenu();},[connectionDetails,closeConnActionsMenu]);

  // ── OAuth-connect platforms (LinkedIn 2026-07-22, Bing 2026-07-22) ─────────────────────────
  // Both are perWorkspaceAuth like Funnel.io/Supermetrics, but neither has a form to fill in — an
  // access token only exists after the user completes that provider's own consent screen, so
  // clicking "connect" kicks off a real browser redirect instead of opening connectPanelKey's
  // generic field form. Shared across both providers via api/oauth/{provider}/{start,callback,
  // accounts}.js, which all follow the same shape.
  const OAUTH_PROVIDER_LABELS={linkedin:"LinkedIn",bing:"Microsoft Advertising",meta:"Meta",google:"Google Ads"};
  const[oauthPicker,setOauthPicker]=useState(null); // {provider,accounts,selectedAccountId} | null
  const[oauthPickerSaving,setOauthPickerSaving]=useState(false);
  // Manual account-entry fallback (2026-07-26, per Mo) — Google Ads' listAccessibleCustomers only
  // ever returns accounts DIRECTLY on the authenticated Google user (see googleAdsOAuth.js's
  // KNOWN LIMITATION note); anyone whose access is only via a manager/MCC account gets a
  // correctly-empty list back, not an error. Rather than block on building full MCC-hierarchy
  // traversal, let the account picker fall back to typing in the numeric Customer ID directly
  // (visible top-right in the Google Ads UI) whenever the auto-discovered list comes back empty —
  // works for any provider's picker, not just Google's, in case another one ever hits this too.
  const[oauthManualId,setOauthManualId]=useState("");
  const[oauthManualName,setOauthManualName]=useState("");
  // Optional — only needed when the connected Google user reaches the ad account through a
  // manager (MCC) account rather than being a direct user on it. Discovered live (2026-07-26, per
  // Mo): even with the right Customer ID entered above, Google Ads API returns PERMISSION_DENIED
  // for the account unless the manager's OWN customer ID is also sent as login-customer-id — see
  // api/oauth/google/accounts.js's doc comment. Same top-right corner of the Google Ads UI shows
  // it (switch into the manager account first).
  const[oauthManualLoginCustomerId,setOauthManualLoginCustomerId]=useState("");
  const startProviderOAuth=useCallback(async(provider)=>{
    if(!canEdit)return;
    if(!workspace?.id||!session?.access_token){showNotif("No active session — try reloading.");return;}
    try{
      const{url}=await startOAuth(session,workspace.id,provider);
      window.location.href=url;
    }catch(e){
      showNotif(`Couldn't connect ${OAUTH_PROVIDER_LABELS[provider]||provider}: ${e.message}`);
    }
  },[workspace?.id,session?.access_token,canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const finalizeOAuthAccount=useCallback(async(provider,accountId,customerId,accountName,loginCustomerId)=>{
    if(!workspace?.id||!session?.access_token)return;
    setOauthPickerSaving(true);
    try{
      // loginCustomerId is Google-specific (see paidhq-core's api/oauth/google/accounts.js doc
      // comment) — harmless extra field for every other provider's accounts.js, which just ignores it.
      await saveOAuthAccount(session,workspace.id,provider,{accountId,customerId,accountName,loginCustomerId});
      setOauthPicker(null);
      refreshConnectedProviders(); // clears needsAccountSelection so the pill flips back to a normal sync button
      showNotif(`${OAUTH_PROVIDER_LABELS[provider]||provider} account set — click Sync to pull spend.`);
    }catch(e){
      showNotif(`Couldn't save ${OAUTH_PROVIDER_LABELS[provider]||provider} account: ${e.message}`);
    }finally{
      setOauthPickerSaving(false);
    }
  },[workspace?.id,session?.access_token]); // eslint-disable-line react-hooks/exhaustive-deps
  // Reopens the account picker for an already-connected provider whose token never got an account
  // saved (providersNeedingAccountSelection) — reuses the EXISTING token via GET .../accounts
  // instead of restarting the OAuth consent screen, since the token itself is fine.
  const openAccountPicker=useCallback((provider)=>{
    if(!workspace?.id||!session?.access_token)return;
    getOAuthAccounts(session,workspace.id,provider)
      .then(({accounts,selectedAccountId})=>{setOauthPicker({provider,accounts:accounts||[],selectedAccountId});})
      .catch(()=>showNotif(`Couldn't load ${OAUTH_PROVIDER_LABELS[provider]||provider} accounts — try reconnecting instead.`));
  },[workspace?.id,session?.access_token]); // eslint-disable-line react-hooks/exhaustive-deps
  // Handles landing back here after an OAuth redirect round-trip (each provider's callback.js
  // sends the browser back to `${APP_URL}/?{provider}_oauth=success|select_account|error&...`).
  // Runs once per mount for each known oauth provider — the query params are stripped from the URL
  // right after reading so a refresh doesn't re-fire it.
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    for(const provider of Object.keys(OAUTH_PROVIDER_LABELS)){
      const status=params.get(`${provider}_oauth`);
      if(!status)continue;
      const wsId=params.get("workspaceId");
      const message=params.get("message");
      const cleanUrl=new URL(window.location.href);
      [`${provider}_oauth`,"workspaceId","message"].forEach(k=>cleanUrl.searchParams.delete(k));
      window.history.replaceState({},"",cleanUrl.toString());
      const label=OAUTH_PROVIDER_LABELS[provider];
      if(status==="error"){showNotif(`${label} connect failed: ${message||"unknown error"}`);return;}
      if(status==="success"){showNotif(`Connected ${label} — click Sync to pull spend.`);refreshConnectedProviders();return;}
      if(status==="select_account"&&wsId&&session?.access_token){
        getOAuthAccounts(session,wsId,provider)
          .then(({accounts,selectedAccountId})=>{
            setOauthPicker({provider,accounts:accounts||[],selectedAccountId});
            refreshConnectedProviders();
          })
          .catch(()=>showNotif(`Connected ${label}, but couldn't load accounts — reconnect if Sync fails.`));
      }
      return;
    }
  },[session?.access_token]); // eslint-disable-line react-hooks/exhaustive-deps

  const[connectPanelKey,setConnectPanelKey]=useState(null); // which platform's connect form is open, or null
  const[connectValues,setConnectValues]=useState({});
  // connectPairs holds the guided-form state for "keyvaluelist" fields (currently just Capterra's
  // apiKeys — one Product name + API key row per product) — {fieldKey: [{label,value},...]}.
  // Kept separate from connectValues (which holds a single string per field for every other
  // connector) because a field's whole point here is "list of pairs", not one value.
  const[connectPairs,setConnectPairs]=useState({});
  const[connectSaving,setConnectSaving]=useState(false);
  const[connectError,setConnectError]=useState("");

  const openConnectPanel=platformKey=>{
    setConnectPanelKey(platformKey);setConnectValues({});setConnectPairs({});setConnectError("");
  };
  // Always returns at least one (possibly empty) row so there's always something to render/type
  // into, even right after the panel opens or after the last row gets removed.
  const pairRowsFor=fieldKey=>(connectPairs[fieldKey]?.length?connectPairs[fieldKey]:[{label:"",value:""}]);
  const setPairRow=(fieldKey,idx,patch)=>setConnectPairs(p=>{
    const rows=[...pairRowsFor(fieldKey)];
    rows[idx]={...rows[idx],...patch};
    return {...p,[fieldKey]:rows};
  });
  const addPairRow=fieldKey=>setConnectPairs(p=>({...p,[fieldKey]:[...pairRowsFor(fieldKey),{label:"",value:""}]}));
  const removePairRow=(fieldKey,idx)=>setConnectPairs(p=>{
    const rows=pairRowsFor(fieldKey).filter((_,i)=>i!==idx);
    return {...p,[fieldKey]:rows.length?rows:[{label:"",value:""}]};
  });
  // Recognizes the #1 real-world shape these keys actually arrive in: a list emailed by
  // Capterra's account manager team (or copied out of the Vendor Portal), one
  // "Product name: key" per line. Lets someone paste that whole list directly into a Product
  // name box and get one row per product back, instead of having to split it apart and
  // hand-type each pair — or worse, hand-build a JSON blob, which is what this replaces. Bails
  // out (returns null, so the paste behaves normally) unless EVERY non-empty line matches —
  // partial matches are more likely a coincidence than an actual key list.
  const parseMultilineKeyPaste=text=>{
    const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if(lines.length<2)return null;
    const rows=[];
    for(const line of lines){
      const m=line.match(/^(.+):\s*(\S+)$/)||line.match(/^(.+?)\t+(\S+)$/);
      if(!m)return null;
      const label=m[1].replace(/^["']|["']$/g,"").trim();
      const value=m[2].replace(/^["']|["']$/g,"").trim();
      if(!label||!value)return null;
      rows.push({label,value});
    }
    return rows;
  };
  const handlePairPaste=(fieldKey,e)=>{
    const text=e.clipboardData?.getData("text")||"";
    const rows=parseMultilineKeyPaste(text);
    if(!rows)return; // not a multi-line key list — let the normal single-field paste happen
    e.preventDefault();
    setConnectPairs(p=>({...p,[fieldKey]:rows}));
    showNotif(`Parsed ${rows.length} key${rows.length===1?"":"s"} from pasted text.`);
  };
  const saveConnection=useCallback(async(platformKey)=>{
    if(!canEdit)return;
    if(!workspace?.id||!session?.access_token){setConnectError("No active session — try reloading.");return;}
    setConnectSaving(true);setConnectError("");
    try{
      const pl=PLATFORMS.find(p=>p.key===platformKey);
      // Fields typed "keyvaluelist" build their bit of the credential from connectPairs' rows
      // (dropping any half-filled row) instead of connectValues — everything else is unchanged.
      const credential={...connectValues};
      (pl?.connectFields||[]).forEach(f=>{
        if(f.type!=="keyvaluelist")return;
        const obj={};
        pairRowsFor(f.key).forEach(({label,value})=>{
          if(label.trim()&&value.trim())obj[label.trim()]=value.trim();
        });
        credential[f.key]=obj;
      });
      await saveConnectionCredential(session,workspace.id,platformKey,credential);
      setConnectedProviders(p=>({...p,[platformKey]:true}));
      setConnectPanelKey(null);
      showNotif(`Connected ${PLATFORMS.find(p=>p.key===platformKey)?.label||platformKey} — click Sync to pull spend.`);
    }catch(e){
      setConnectError(e.message);
    }finally{
      setConnectSaving(false);
    }
  },[workspace?.id,session?.access_token,connectValues,connectPairs]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncPlatform=useCallback(async(platformKey)=>{
    if(!canEdit)return;
    // Belt-and-suspenders alongside the sync bar disabling a paused connector's button (see
    // PLATFORMS.map's clickable/handleClick below) — blocks it here too in case this ever gets
    // called from somewhere else that doesn't check first.
    const pausedConn=connectionDetails.find(c=>c.provider===platformKey);
    if(pausedConn?.paused){showNotif(`${PLATFORMS.find(p=>p.key===platformKey)?.label||platformKey} is paused — resume it in Data Sources before syncing.`);return;}
    setSyncState(p=>({...p,[platformKey]:"loading"}));
    try{
      // Moved to paidhq-core 2026-07-30 — syncSpend (lib/coreApi.js) calls the shared
      // /api/spend there instead of this app's own local route, so any product's Sync button
      // hits the same endpoint. workspaceId is harmless to always send: paidhq-core's route only
      // actually reads it for perWorkspaceAuth connectors (every live one today), same as before.
      const{rows,endDate:effectiveEndDate}=await syncSpend(session,{platform:platformKey,startDate:syncDateRange.start,endDate:syncDateRange.end,workspaceId:workspace?.id});
      if(rows.length===0) throw new Error("No spend data returned for this date range");
      // Tag each row with which connector pulled it — `sync:${provider}` matches the convention
      // api/lib/spendRowsStore.js already uses for the cron rolling-sync path, so a manual Sync
      // click and an automated one are equally traceable back to their connector. This is what
      // lets "Don't use data in BudgetHQ" (excludedFromData) and the Import start/end date columns
      // in the connector table find exactly this provider's rows without touching CSV-uploaded or
      // screenshot-imported data for the same platform. Rows pulled before this shipped (2026-07-24)
      // won't have this tag until their connector syncs again.
      const taggedRows=rows.map(r=>({...r,source:`sync:${platformKey}`}));
      // Merge with existing data — don't replace
      setMergedNormRows(prev=>mergeRows(prev,taggedRows));
      // Deliberately does NOT touch step/view — a manual "Sync now" click happens from the
      // Connections table on the Data Sources tab, and per Mo (2026-07-24) there's no reason that
      // should yank the user over to Campaign Tagger; the merged rows are already live wherever
      // they go next. This relies on step/view being left exactly as they already were (untouched,
      // not reset), which is only safe because "Sync now" always fires from view==="data" — if this
      // ever gets called from a different screen, that screen's own step/view stays intact too,
      // there's just no visual acknowledgment of the sync beyond the notif below and the Connections
      // table's own Import start/end columns updating on next refresh.
      setSyncState(p=>({...p,[platformKey]:"done"}));
      setLastSyncRange({start:syncDateRange.start,end:syncDateRange.end});
      try{localStorage.setItem("paidhq_sync_range",JSON.stringify({start:syncDateRange.start,end:syncDateRange.end}));}catch(e){}
      checkpoint(`Synced ${platformKey} spend data (${rows.length} rows)`,"tagger_sync");
      // /api/spend silently clamps a requested end date past today (see its doc comment — there's
      // no such thing as spend data for a day that hasn't happened yet). Surfacing that here means
      // a quarter/half-year range doesn't quietly look "fully synced" when only the portion through
      // today actually has data.
      const adjustedNote=effectiveEndDate&&effectiveEndDate!==syncDateRange.end
        ?` — synced through ${effectiveEndDate} (no data yet for ${effectiveEndDate} to ${syncDateRange.end})`
        :"";
      showNotif(`Loaded ${rows.length} ${platformKey} campaigns — merged with existing data${adjustedNote}`);
    }catch(e){
      setSyncState(p=>({...p,[platformKey]:"error:"+e.message}));
    }
  },[syncDateRange,checkpoint,workspace?.id,session?.access_token,connectionDetails]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Google Sheets spend pull ────────────────────────────────────────────────────────────────
  // Deliberately NOT the same "stored credential, click Sync" shape as Funnel/Supermetrics above
  // — reuses the exact client-side-only Google OAuth token flow already built for Budget/Tagger's
  // "Connect a Google Sheet" (lib/googleSheets.js), so there's no new Google Cloud setup and no
  // server-side storage. Each pull is a manual one-shot: paste a link, fetch the grid, review/map
  // columns on the same step==="map" screen a CSV upload lands on — same pipeline, different source.
  const[gsheetSpendOpen,setGsheetSpendOpen]=useState(false);

  // Shared by handleFile's Papa.parse callback and the Sheets grid below — both end up with
  // the same shape (array of row objects + field names) and need to land on the same review step.
  const applySpendGrid=useCallback((data,fields,sourceLabel)=>{
    setFileName(sourceLabel);
    const detected=autoDetect(fields||[]);
    setRawRows(data);setHeaders(fields||[]);setColMap(detected);
    const existingTagCount=data.reduce((count,row)=>{
      const name=(row[detected.campaign_group_name]||"").trim();
      return count+(name&&Object.keys(tags[name]||{}).length>0?1:0);
    },0);
    if(existingTagCount>0) showNotif(`${existingTagCount} campaigns already tagged from previous session`);
    setUploadAsOf("");
    setUploadIsMonthly(false);
    setStep("map");
  },[tags]); // eslint-disable-line react-hooks/exhaustive-deps

  // Connection logic itself lives in the shared useGoogleSheetConnect hook (see its doc comment)
  // — this just converts the fetched grid into the same {rows, fields} shape a CSV upload's
  // Papa.parse output has, then feeds it into applySpendGrid above.
  const gsSpend=useGoogleSheetConnect((grid,tabTitle)=>{
    const[headerRow,...dataRows]=grid;
    const fields=headerRow.map((h,i)=>h||`Column ${i+1}`);
    const data=dataRows.map(row=>Object.fromEntries(fields.map((f,i)=>[f,row[i]||""])));
    applySpendGrid(data,fields,tabTitle);
    setGsheetSpendOpen(false);
  });

  const handleFile=useCallback(file=>{
    if(!file)return;
    archiveFile(file,"Spend import");
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      applySpendGrid(r.data,r.meta.fields||[],file.name);
    }});
  },[applySpendGrid,archiveFile]);
  const handleDrop=useCallback(e=>{e.preventDefault();setDragOver(false);const f=e.dataTransfer.files[0];if(f)handleFile(f);},[handleFile]);

  // Auto-default "Data accurate through" for month-grain exports (Google/Bing report one row per
  // ad group PER MONTH — e.g. "Jul-26" — not a real per-day date). Runs off colMap.date (the field
  // actually being used), not the raw auto-detect result, because Google's "Month" header doesn't
  // match the auto-detect pattern (/^date$|^day$/i) — it only gets mapped once picked manually in
  // the dropdown below, and that has to be able to trigger this too, not just the initial
  // auto-detect at file-parse time.
  //
  // Detection: a distinct-value COUNT threshold doesn't work here — Google's own exports are often
  // a full historical dump (one row per ad group per month, going back many months/years), so a
  // real file can easily have 15+ distinct month labels even though every single one is month-grain,
  // not daily. The reliable signal instead: every unique date value parses to the 1st of its month.
  // Real daily data (LinkedIn, Capterra, or any file with genuine per-day rows) will have dates
  // scattered across day 1-31 and essentially never satisfy that for real data. Only fires when the
  // field is still blank, so it never overwrites a value already set.
  useEffect(()=>{
    if(!colMap.date||!rawRows.length||uploadAsOf)return;
    const uniqueDates=new Set(rawRows.map(row=>(row[colMap.date]||"").trim()).filter(Boolean));
    if(!uniqueDates.size)return;
    const parsedDates=[...uniqueDates].map(v=>parseSpendDate(v)).filter(Boolean);
    const looksMonthly=parsedDates.length>0&&parsedDates.every(d=>d.getDate()===1);
    if(looksMonthly){
      const y=new Date();y.setDate(y.getDate()-1);
      setUploadAsOf(`${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,"0")}-${String(y.getDate()).padStart(2,"0")}`);
      setUploadIsMonthly(true);
    }
  },[colMap.date,rawRows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Screenshot-to-data: sends the image to Claude (vision, via /api/analyze) with instructions
  // to extract whatever spend rows it can read into the same shape normalizeRows() produces for
  // a CSV upload, then lands in a review step (screenshotPreview) — never auto-committed, since
  // vision extraction from a photo/screenshot can misread a digit or a column in a way a person
  // reviewing the source CSV directly wouldn't. Confirming pushes it through mergeRows() exactly
  // like a normal CSV import would.
  const handleScreenshotFile=useCallback(file=>{
    if(!file)return;
    setScreenshotFileName(file.name);setScreenshotError("");setScreenshotProcessing(true);
    const reader=new FileReader();
    reader.onload=async e=>{
      try{
        const dataUrl=String(e.target.result||"");
        const m=dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if(!m)throw new Error("Could not read image file");
        const[,mediaType,base64]=m;
        const prompt=`You are extracting advertising spend data from a screenshot of a report, dashboard, or spreadsheet. Look at the image and extract every row of spend data you can find.\n\nFor each row, output an object with these fields (use "" or 0 for anything not visible/applicable):\n{"campaign_group_name": <campaign or product name>, "campaign_name": <ad set/ad group/sub-item name, or same as campaign_group_name if there's no second level shown>, "platform": <ad platform if identifiable, e.g. "Google", "Meta", "LinkedIn", "Capterra", "Bing", else "">, "date": <YYYY-MM-DD if a specific day is shown, or YYYY-MM-01 if only a month/period is shown>, "spend": <numeric spend/cost, no currency symbols or commas>, "impressions": <numeric, 0 if not shown>, "clicks": <numeric, 0 if not shown>}\n\nReturn ONLY a JSON array of these objects, no markdown fences, no explanation. If a table has a grand-total row, skip it — only extract individual line items. If you can't confidently read any spend data, return [].`;
        const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...authHeader(session)},body:JSON.stringify({
          messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mediaType,data:base64}},{type:"text",text:prompt}]}],
          maxTokens:4000,
        })});
        const data=await res.json();
        if(!res.ok)throw new Error(data?.error||"Screenshot analysis failed");
        const parsed=JSON.parse((data.text||"[]").replace(/```json|```/g,"").trim());
        if(!Array.isArray(parsed))throw new Error("Unexpected response shape from AI");
        const rows=parsed.map(r=>({
          campaign_group_name:String(r.campaign_group_name||"").trim(),
          campaign_name:String(r.campaign_name||r.campaign_group_name||"").trim(),
          platform:String(r.platform||"").trim()||"Unknown",
          campaign_type:"",
          date:String(r.date||"").trim(),
          spend:parseFloat(r.spend)||0,
          impressions:parseInt(r.impressions,10)||0,
          clicks:parseInt(r.clicks,10)||0,
        })).filter(r=>r.campaign_group_name&&r.spend>0);
        if(!rows.length)throw new Error("Couldn't find any spend rows in that screenshot — try a clearer image or a wider crop.");
        setScreenshotPreview(rows);
        setStep("screenshot");
      }catch(err){
        setScreenshotError(err.message);
      }finally{
        setScreenshotProcessing(false);
      }
    };
    reader.onerror=()=>{setScreenshotError("Could not read image file");setScreenshotProcessing(false);};
    reader.readAsDataURL(file);
  },[session]);
  const handleScreenshotDrop=useCallback(e=>{e.preventDefault();setDragOver(false);const f=e.dataTransfer.files[0];if(f)handleScreenshotFile(f);},[handleScreenshotFile]);
  const confirmScreenshotImport=useCallback(()=>{
    if(!canEdit)return;
    setMergedNormRows(prev=>mergeRows(prev,screenshotPreview));
    checkpoint(`Imported spend data from screenshot — ${screenshotFileName||"image"} (${screenshotPreview.length} rows)`,"tagger_import");
    showNotif(`Added ${screenshotPreview.length} rows from screenshot — merged with existing data`);
    setScreenshotPreview([]);setScreenshotFileName("");
    setStep("tag");setView("tagger");
  },[screenshotPreview,screenshotFileName,checkpoint,canEdit]);

  // "Don't use data in BudgetHQ" (excludedFromData, see the connector table's action menu) filters
  // that provider's rows out of every calculation/view below — reversible, doesn't touch what's
  // actually stored. Only rows tagged source==="sync:<provider>" are affected (see syncPlatform's
  // tagging comment above and spendRowsStore.js's matching convention on the cron side); manually
  // uploaded CSV/screenshot/Sheets rows for the same platform are never touched by this, even if
  // they happen to share a platform label with an excluded connector. mergedNormRows itself stays
  // the raw, untouched dataset everywhere else (autosave, snapshots, Settings' "Delete all data") —
  // visibleNormRows is a read-only view for display/math, not a replacement for it.
  const excludedProviders=useMemo(()=>new Set((connectionDetails||[]).filter(c=>c.excludedFromData).map(c=>c.provider)),[connectionDetails]);
  const visibleNormRows=useMemo(()=>{
    if(excludedProviders.size===0)return mergedNormRows;
    return mergedNormRows.filter(r=>!r.source||!excludedProviders.has(r.source.replace(/^sync:/,"")));
  },[mergedNormRows,excludedProviders]);

  // Connector table's "Import start date"/"Import end date" columns (2026-07-24) — per Mo, these
  // are read-only and auto-computed from sync history rather than a separate editable field: the
  // earliest/latest date among the rows THIS connector actually pulled (source==="sync:<provider>"),
  // read from the raw mergedNormRows (not visibleNormRows) so the range still shows correctly while
  // a connector is excluded — excluding shouldn't make its own history disappear from its own row.
  // Caveat worth knowing: rows synced before this shipped never got a `source` tag, so an
  // already-connected provider shows "—" here until its next sync backfills the tag.
  const importDateRangeByProvider=useMemo(()=>{
    const map={};
    mergedNormRows.forEach(r=>{
      if(!r.source||!r.date)return;
      const provider=r.source.replace(/^sync:/,"");
      if(provider===r.source)return; // wasn't a "sync:" tag at all
      if(!map[provider])map[provider]={start:r.date,end:r.date};
      else{
        if(r.date<map[provider].start)map[provider].start=r.date;
        if(r.date>map[provider].end)map[provider].end=r.date;
      }
    });
    return map;
  },[mergedNormRows]);

  // "key" is the composite identity (campaign group + campaign) used everywhere tags/selection
  // are looked up — ad set/ad group names often repeat across different campaigns, so the leaf
  // name alone isn't a safe identity. "name" (leaf) and "groupName" stay separate for display.
  const campaigns=useMemo(()=>{
    if(!visibleNormRows.length)return[];
    const map={};
    visibleNormRows.forEach(row=>{
      const name=row.campaign_name;if(!name)return;
      const groupName=row.campaign_group_name||name;
      const key=campaignKey(groupName,name);
      const platform=derivePlatform(groupName,name,row.platform,row.campaign_type);
      if(!map[key])map[key]={key,name,groupName,platform,spend:0,rows:0};
      map[key].spend+=row.spend;
      map[key].rows++;
    });
    return Object.values(map);
  },[visibleNormRows]);
  const allPlats=useMemo(()=>[...new Set(campaigns.map(c=>c.platform))].sort(),[campaigns]);
  const stats=useMemo(()=>{
    const totalSpend=campaigns.reduce((s,c)=>s+c.spend,0);
    const tagged=campaigns.filter(c=>Object.keys(tags[c.key]||{}).length>0).length;
    const dates=visibleNormRows.map(r=>r.date).filter(Boolean).sort();
    const derivedRange=dates.length?`${dates[0]} → ${dates[dates.length-1]}`:"";
    const displayRange=lastSyncRange?`${lastSyncRange.start} → ${lastSyncRange.end}`:derivedRange;
    return{total:campaigns.length,tagged,untagged:campaigns.length-tagged,totalSpend,totalRows:visibleNormRows.length,dateRange:displayRange};
  },[campaigns,tags,rawRows,colMap,lastSyncRange,visibleNormRows]);

  const filtered=useMemo(()=>{let r=campaigns.filter(c=>{
    if(fCamp){const terms=splitFilterTerms(fCamp);if(terms.length&&!matchesTerms(c.name.toLowerCase(),terms,fCampInclMode))return false;}
    if(fCampExclude){const terms=splitFilterTerms(fCampExclude);if(terms.length&&matchesTerms(c.name.toLowerCase(),terms,fCampExclMode))return false;}
    if(fGroup){const terms=splitFilterTerms(fGroup);if(terms.length&&!matchesTerms(c.groupName.toLowerCase(),terms,fGroupInclMode))return false;}
    if(fGroupExclude){const terms=splitFilterTerms(fGroupExclude);if(terms.length&&matchesTerms(c.groupName.toLowerCase(),terms,fGroupExclMode))return false;}
    if(fPlat&&c.platform!==fPlat)return false;
    if(fSMin&&c.spend<parseFloat(fSMin))return false;
    if(fSMax&&c.spend>parseFloat(fSMax))return false;
    if(fTag){const ts=tags[c.key]||{};const s=Object.entries(ts).map(([d,v])=>`${d}:${v}`).join(" ").toLowerCase();const terms=splitFilterTerms(fTag);if(terms.length&&!matchesTerms(s,terms,fTagInclMode))return false;}
    if(fTagExclude){const ts=tags[c.key]||{};const s=Object.entries(ts).map(([d,v])=>`${d}:${v}`).join(" ").toLowerCase();const terms=splitFilterTerms(fTagExclude);if(terms.length&&matchesTerms(s,terms,fTagExclMode))return false;}
    if(selectedTagFilters.size>0){
      // Group by dimension: AND across dims, OR within same dim
      const dimMap={};
      selectedTagFilters.forEach(key=>{const idx=key.indexOf(":");const d=key.slice(0,idx);const v=key.slice(idx+1).toLowerCase();if(!dimMap[d])dimMap[d]=new Set();dimMap[d].add(v);});
      const ts=tags[c.key]||{};
      const passes=Object.entries(dimMap).every(([dim,vals])=>vals.has((ts[dim]||"").toLowerCase()));
      if(!passes)return false;
    }
    if(fStatus==="tagged"&&Object.keys(tags[c.key]||{}).length===0)return false;
    if(fStatus==="untagged"&&Object.keys(tags[c.key]||{}).length>0)return false;
    return true;
  });return[...r].sort((a,b)=>{if(sortCol==="spend")return sortDir==="asc"?a.spend-b.spend:b.spend-a.spend;if(sortCol==="campaign")return sortDir==="asc"?a.name.localeCompare(b.name):b.name.localeCompare(a.name);if(sortCol==="group")return sortDir==="asc"?a.groupName.localeCompare(b.groupName):b.groupName.localeCompare(a.groupName);if(sortCol==="platform")return sortDir==="asc"?a.platform.localeCompare(b.platform):b.platform.localeCompare(a.platform);const at=Object.keys(tags[a.key]||{}).length;const bt=Object.keys(tags[b.key]||{}).length;return sortDir==="asc"?at-bt:bt-at;});},[campaigns,fCamp,fCampExclude,fCampInclMode,fCampExclMode,fGroup,fGroupExclude,fGroupInclMode,fGroupExclMode,fPlat,fSMin,fSMax,fTag,fTagExclude,fTagInclMode,fTagExclMode,selectedTagFilters,fStatus,sortCol,sortDir,tags]);

  const suggestions=useMemo(()=>{if(!fCamp||fCamp.length<3)return[];const term=fCamp.toLowerCase();const seen=new Set();const out=[];tagDims.forEach(dim=>{Object.entries(tags).forEach(([cn,ts])=>{if(ts[dim]&&cn.toLowerCase().includes(term)){const key=`${dim}:${ts[dim]}`;if(!seen.has(key)){seen.add(key);const count=filtered.filter(c=>!(tags[c.key]?.[dim])).length;if(count>0)out.push({key,dim,val:ts[dim],count});}}});});return out.slice(0,3);},[fCamp,filtered,tags,tagDims]);

  // Tag browser: all unique values per dimension with campaign counts
  const tagValueMap=useMemo(()=>{
    const result={};
    tagDims.forEach(dim=>{
      result[dim]={};
      campaigns.forEach(c=>{
        const val=(tags[c.key]||{})[dim];
        if(val)result[dim][val]=(result[dim][val]||0)+1;
      });
    });
    return result;
  },[tagDims,tags,campaigns]);

  const showNotif=msg=>{setNotif(msg);setTimeout(()=>setNotif(null),3000);};
  const pushHistory=useCallback(currentTags=>{setTagsHistory(h=>[...h.slice(-49),currentTags]);},[]);
  const undoTags=useCallback(()=>{if(!tagsHistory.length)return;setTags(tagsHistory[tagsHistory.length-1]);setTagsHistory(h=>h.slice(0,-1));showNotif("Undone");},[tagsHistory]);
  // Accepts an optional override value — used when TagAutocompleteInput's Enter handler commits a
  // suggestion and calls onEnter(value) in the same tick as setApplyVal(value), before the state
  // update has actually landed; reading applyVal here would still see the previous value. Guarded
  // with typeof since this is also wired directly as a raw onClick handler (Btn passes the click
  // event through as the first arg), which must NOT be mistaken for an override value.
  const applyTags=useCallback((valOverride)=>{
    if(!canEdit)return;
    const v=typeof valOverride==="string"?valOverride:applyVal;
    if(!applyDim||!v||!selected.size)return;
    pushHistory(tags);
    const u={};selected.forEach(n=>{u[n]={...(tags[n]||{}),[applyDim]:v};});
    setTags(p=>({...p,...u}));
    showNotif(`Tagged ${selected.size} campaigns — ${applyDim}: ${v}`);
    // Selection deliberately NOT cleared here — tagging is usually done one dimension at a time
    // (BU, then Pillar, then Product…) against the same set of rows, so clearing forced re-selecting
    // the same campaigns after every single dimension. Use the toolbar's "Clear" button when done.
    setApplyVal("");
  },[applyDim,applyVal,selected,tags,pushHistory,canEdit]);
  const applySug=useCallback((dim,val)=>{if(!canEdit)return;pushHistory(tags);const u={};filtered.forEach(c=>{if(!(tags[c.key]?.[dim]))u[c.key]={...(tags[c.key]||{}),[dim]:val};});setTags(p=>({...p,...u}));showNotif(`Applied ${dim}: ${val} to ${Object.keys(u).length} campaigns`);},[filtered,tags,pushHistory,canEdit]);
  const removeTag=useCallback((cn,dim)=>{if(!canEdit)return;pushHistory(tags);setTags(p=>{const ts={...(p[cn]||{})};delete ts[dim];return{...p,[cn]:ts};});},[tags,pushHistory,canEdit]);
  const bulkRemoveTag=useCallback(dim=>{if(!canEdit)return;if(!dim||!selected.size)return;pushHistory(tags);setTags(p=>{const nx={...p};selected.forEach(n=>{if(nx[n]){const ts={...nx[n]};delete ts[dim];nx[n]=ts;}});return nx;});showNotif(`Removed ${dim} tag from ${selected.size} campaigns`);setSelected(new Set());},[selected,tags,pushHistory,canEdit]);
  // Deletes a tag dimension entirely — removes it from the Tag Dimensions list AND strips it out of
  // every campaign's tags (not just the ones currently selected/filtered), so no orphaned dimension
  // data is left sitting invisibly in the data model. Blocked if the dimension is currently used as
  // a Budget By dimension: budgetDims values are baked into every budget segment's key (segKey =
  // dims.join("|")), so removing one out from under an active budget structure would mean collapsing
  // and re-merging every segment's dollar amounts — real data-migration territory, not something to
  // do silently as a side effect of a tag-dimension delete. Annotation-only usage (budgetMetaDims) is
  // safe to clean up automatically since those are just extra display columns, not part of any key.
  const deleteDimension=useCallback(dim=>{
    if(!canEdit)return;
    if(!dim)return;
    if(budgetDims.includes(dim)){
      window.alert(`"${dim}" is currently used as a Budget By dimension in the Budget Panel, so it can't be deleted from here — doing so would break your existing budget segments. Go to Budget Panel → Budget By and un-check "${dim}" first, then delete it here.`);
      return;
    }
    const matchCount=Object.values(tags).filter(t=>t&&t[dim]).length;
    const tagNote=matchCount>0?` This removes the "${dim}" tag from ${matchCount} campaign${matchCount>1?"s":""} — any that only had this tag will show as needs review in the Tagger. Spend data itself is not affected.`:" No campaigns currently have this tag applied.";
    if(!window.confirm(`Delete the "${dim}" dimension?\n\nThis removes it from Tag Dimensions entirely, not just from the list.${tagNote}`))return;
    pushHistory(tags);
    setTags(p=>{
      const nx={};
      Object.entries(p).forEach(([key,t])=>{
        if(t&&Object.prototype.hasOwnProperty.call(t,dim)){const nt={...t};delete nt[dim];nx[key]=nt;}
        else nx[key]=t;
      });
      return nx;
    });
    setTagDims(p=>p.filter(d=>d!==dim));
    if(budgetMetaDims.includes(dim))setBudgetMetaDims(p=>p.filter(d=>d!==dim));
    if(applyDim===dim)setApplyDim("");
    showNotif(matchCount>0?`Deleted "${dim}" — removed from ${matchCount} campaign${matchCount>1?"s":""}`:`Deleted "${dim}"`);
  },[tags,budgetDims,budgetMetaDims,applyDim,pushHistory,canEdit]);
  // Same override pattern as applyTags above, and for the same reason — also wired directly as a
  // raw onBlur handler elsewhere, hence the typeof guard.
  const saveEdit=useCallback((valOverride)=>{
    if(!canEdit)return;
    if(!editingTag)return;
    const trimmed=(typeof valOverride==="string"?valOverride:editVal).trim();
    const current=(tags[editingTag.campaign]||{})[editingTag.dim];
    if(trimmed===current){setEditingTag(null);setEditVal("");return;}
    pushHistory(tags);
    setTags(p=>{
      const ts={...(p[editingTag.campaign]||{})};
      if(trimmed)ts[editingTag.dim]=trimmed;else delete ts[editingTag.dim];
      return{...p,[editingTag.campaign]:ts};
    });
    setEditingTag(null);setEditVal("");
  },[editingTag,editVal,tags,pushHistory,canEdit]);
  const exportTags=()=>{
    const header=["Campaign Group","Campaign","Platform","Spend",...tagDims];
    const rows=[header,...campaigns.map(c=>[c.groupName,c.name,c.platform,c.spend.toFixed(2),...tagDims.map(d=>(tags[c.key]||{})[d]||"")])];
    downloadCSV(rows,"budgethq-tags.csv");
    // Archive a copy alongside the download — same CSV serialization downloadCSV uses internally,
    // wrapped as a File so archiveFile has a .name/.size/.type to work with.
    const csv=rows.map(r=>r.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\n");
    archiveFile(new File(["﻿"+csv],"budgethq-tags.csv",{type:"text/csv;charset=utf-8"}),"Tag export").then(refreshFileStore);
    showNotif("Tags exported");
  };

  // Shared row-processing core for both the CSV tag import and the screenshot tag import below —
  // takes row objects keyed by column name (exactly what Papa.parse({header:true}) produces, and
  // what the screenshot path asks Claude's vision to produce directly). Per user decision, this no
  // longer applies changes immediately: it builds a preview (matched campaigns + any unrecognized
  // columns detected as new tag dimensions) and opens tagImportPreview for confirmation — the
  // actual merge happens in confirmTagImport below. All three import entry points (CSV, screenshot,
  // Google Sheets) route through this one function, so building the preview here covers all three.
  const[tagImportPreview,setTagImportPreview]=useState(null); // {rows,campCol,groupCol,dimCols,newDims,includedNewDims:Set,matchedCount,skippedCount,sample}
  const applyTagRowsFromRecords=useCallback((rows,fields)=>{
    if(!canEdit)return;
    // Detect campaign group + campaign columns (exported files have both; older exports from
    // before the two-level model only have "Campaign", which is treated as both levels).
    const groupCol=fields.find(f=>/campaign.?group/i.test(f));
    const campCol=fields.find(f=>/campaign/i.test(f)&&f!==groupCol);
    if(!campCol){showNotif("Could not find Campaign column");return;}
    // Detect dimension columns (exclude Campaign Group, Campaign, Platform, Spend, Date)
    const skipCols=new Set(["campaign group","campaign","platform","spend","date","impressions","clicks","campaign_name","campaign_group_name","campaign_id"]);
    const dimCols=fields.filter(f=>!skipCols.has(f.toLowerCase())&&f!==campCol&&f!==groupCol);
    const validRows=rows.filter(row=>(row[campCol]||"").trim());
    const newDims=dimCols.filter(d=>!tagDims.includes(d));
    const sample=validRows.slice(0,5).map(row=>{
      const name=(row[campCol]||"").trim();
      const groupName=(groupCol?row[groupCol]:"")?.trim()||name;
      return groupName!==name?`${groupName} · ${name}`:name;
    });
    setTagImportPreview({
      rows:validRows,campCol,groupCol,dimCols,newDims,
      includedNewDims:new Set(newDims), // default: include — user confirms/unchecks in the preview modal
      matchedCount:validRows.length,
      skippedCount:rows.length-validRows.length,
      sample,
    });
  },[tagDims,canEdit]);
  const toggleNewTagDim=(d)=>{
    setTagImportPreview(p=>{
      if(!p)return p;
      const nx=new Set(p.includedNewDims);
      if(nx.has(d))nx.delete(d);else nx.add(d);
      return{...p,includedNewDims:nx};
    });
  };
  const cancelTagImport=()=>setTagImportPreview(null);
  const confirmTagImport=()=>{
    if(!tagImportPreview||!canEdit)return;
    const{rows,campCol,groupCol,dimCols,includedNewDims}=tagImportPreview;
    const allowedDims=dimCols.filter(d=>tagDims.includes(d)||includedNewDims.has(d));
    let restored=0;
    setTags(p=>{
      const nx={...p};
      rows.forEach(row=>{
        const name=(row[campCol]||"").trim();
        if(!name)return;
        const groupName=(groupCol?row[groupCol]:"")?.trim()||name;
        const key=campaignKey(groupName,name);
        const t={...(nx[key]||{})};
        allowedDims.forEach(d=>{if(row[d]&&row[d].trim())t[d]=row[d].trim();});
        nx[key]=t;
        restored++;
      });
      return nx;
    });
    const dimsToAdd=dimCols.filter(d=>includedNewDims.has(d));
    if(dimsToAdd.length)setTagDims(p=>[...new Set([...p,...dimsToAdd])]);
    showNotif(`Restored tags for ${restored} campaigns`);
    setTagImportPreview(null);
  };
  const importTagsRef=useRef(null);
  const importTagsFromCSV=useCallback((file)=>{
    if(!file)return;
    archiveFile(file,"Tag import");
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      applyTagRowsFromRecords(r.data,r.meta.fields||[]);
    }});
  },[applyTagRowsFromRecords,archiveFile]);
  // Screenshot tag import — same idea as the spend-data screenshot flow, but asks Claude to read
  // the header row itself and return row objects keyed by those header names (rather than a raw
  // grid), since applyTagRowsFromRecords already knows how to find the Campaign/Campaign Group
  // columns and treat everything else as a tag dimension — exactly what Papa.parse({header:true})
  // hands it for a CSV, so no separate merge path is needed for the screenshot case.
  const[tagScreenshotImporting,setTagScreenshotImporting]=useState(false);
  const[tagScreenshotError,setTagScreenshotError]=useState("");
  const importTagsScreenshotRef=useRef(null);
  const importTagsFromScreenshot=useCallback((file)=>{
    if(!file)return;
    setTagScreenshotError("");setTagScreenshotImporting(true);
    const reader=new FileReader();
    reader.onload=async e=>{
      try{
        const dataUrl=String(e.target.result||"");
        const m=dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if(!m)throw new Error("Could not read image file");
        const[,mediaType,base64]=m;
        const prompt=`You are extracting a campaign-tagging table from a screenshot of a spreadsheet (Google Sheets, Excel, or similar). It has a header row naming each column — things like "Campaign", "Campaign Group", and various tagging dimensions such as "Product", "Region", or "Funnel" — and one data row per campaign.\n\nRead the header row exactly as shown, then for each data row output an object keyed by those exact header names, e.g. {"Campaign":"...", "Campaign Group":"...", "Product":"...", ...}. Use "" for any empty cell.\n\nReturn ONLY a JSON array of these row objects — no markdown fences, no explanation.`;
        const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...authHeader(session)},body:JSON.stringify({
          messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mediaType,data:base64}},{type:"text",text:prompt}]}],
          maxTokens:4000,
        })});
        const data=await res.json();
        if(!res.ok)throw new Error(data?.error||"Screenshot analysis failed");
        const parsed=JSON.parse((data.text||"[]").replace(/```json|```/g,"").trim());
        if(!Array.isArray(parsed)||!parsed.length)throw new Error("Couldn't read a tagging table from that screenshot — try a clearer image or a wider crop.");
        const fields=[...new Set(parsed.flatMap(r=>Object.keys(r||{})))];
        applyTagRowsFromRecords(parsed,fields);
      }catch(err){
        setTagScreenshotError(err.message);
      }finally{
        setTagScreenshotImporting(false);
      }
    };
    reader.onerror=()=>{setTagScreenshotError("Could not read image file");setTagScreenshotImporting(false);};
    reader.readAsDataURL(file);
  },[applyTagRowsFromRecords,session]);
  // Google Sheets manual connect for tags — same idea as the Budget import's version, but converts
  // the fetched raw grid into {header:true}-shaped row objects (row 0 = headers) since
  // applyTagRowsFromRecords expects that shape, same as Papa.parse's CSV output. Connection logic
  // itself lives in the shared useGoogleSheetConnect hook (see its doc comment).
  const[gsheetTagOpen,setGsheetTagOpen]=useState(false);
  // Auto-detects the header row (scans the first 10 rows) instead of always trusting row 0 — a
  // title row, note, or blank spacer row above the real header would otherwise make this silently
  // grab the wrong row and, since a tag import specifically needs a Campaign column, produce
  // exactly the "Could not find Campaign column" error even when the sheet is perfectly valid.
  // Prefers a row that actually contains something matching "campaign"; falls back to the first
  // row with several filled cells (same style of heuristic as the Budget import's header-row
  // detection) if no such row turns up in that window.
  const findTagHeaderRow=rawRows=>{
    const scanLimit=Math.min(rawRows.length,10);
    for(let i=0;i<scanLimit;i++){if((rawRows[i]||[]).some(v=>/campaign/i.test(String(v||""))))return i;}
    for(let i=0;i<scanLimit;i++){if((rawRows[i]||[]).filter(v=>String(v||"").trim()).length>2)return i;}
    return 0;
  };
  const gridToRecords=rawRows=>{
    const headerIdx=findTagHeaderRow(rawRows);
    const headerRow=rawRows[headerIdx]||[];
    // Keep each header's original column index so blank/unnamed columns can be dropped from
    // `fields` without breaking the row[i]<->field alignment for the columns that remain.
    const cols=[];
    headerRow.forEach((h,i)=>{const name=String(h||"").trim();if(name)cols.push({name,i});});
    const fields=cols.map(c=>c.name);
    const rows=rawRows.slice(headerIdx+1).filter(r=>r.some(v=>String(v||"").trim())).map(r=>{
      const obj={};cols.forEach(c=>{obj[c.name]=String(r[c.i]||"").trim();});return obj;
    });
    return{fields,rows};
  };
  const gsTags=useGoogleSheetConnect((grid,tabTitle)=>{
    const{fields,rows}=gridToRecords(grid);
    if(!rows.length)throw new Error(`"${tabTitle}" has a header row but no data rows.`);
    applyTagRowsFromRecords(rows,fields);
    setGsheetTagOpen(false);
  });
  // Clipboard paste (Ctrl/Cmd+V) for screenshots — lets someone with a screenshot already copied
  // (e.g. Cmd+Shift+4 / Snipping Tool) just paste it in rather than saving it as a file first and
  // clicking through a file picker. Scoped to whichever screenshot-import capability is actually
  // on screen right now rather than firing globally: step==="upload" is the Tagger's spend-data
  // screenshot dropzone, step==="tag" is where the "Import tags from screenshot" button lives.
  // Ordinary text pastes into filter boxes, tag values, etc. are untouched — this only ever acts
  // when the clipboard payload itself contains an image, and only preventDefault()s in that case.
  useEffect(()=>{
    const handler=e=>{
      const items=e.clipboardData?.items;
      if(!items)return;
      const imageItem=Array.from(items).find(it=>it.type&&it.type.startsWith("image/"));
      if(!imageItem)return;
      const file=imageItem.getAsFile();
      if(!file)return;
      if(view==="data"&&step==="upload"){
        e.preventDefault();
        handleScreenshotFile(file);
      }else if(view==="tagger"&&step==="tag"){
        e.preventDefault();
        importTagsFromScreenshot(file);
      }
    };
    document.addEventListener("paste",handler);
    return()=>document.removeEventListener("paste",handler);
  },[view,step,handleScreenshotFile,importTagsFromScreenshot]);
  const toggleSel=n=>setSelected(p=>{const nx=new Set(p);nx.has(n)?nx.delete(n):nx.add(n);return nx;});
  const selAll=()=>setSelected(selected.size===filtered.length?new Set():new Set(filtered.map(c=>c.key)));
  // Isolate-and-delete-an-import: filter the table down to what you want gone (e.g. Platform =
  // Google), select-all within that filter, then this removes exactly those campaigns' spend
  // rows from mergedNormRows. Tags are left untouched (matches the single-row "Remove" behavior)
  // so re-syncing or re-uploading the same campaigns later restores them pre-tagged.
  const bulkRemoveCampaigns=useCallback(()=>{
    if(!canEdit)return;
    if(!selected.size)return;
    const n=selected.size;
    const removedSpend=campaigns.filter(c=>selected.has(c.key)).reduce((s,c)=>s+c.spend,0);
    if(!window.confirm(`Remove ${n} campaign${n>1?"s":""} (${fmt$(removedSpend)} total spend) from this dataset?\n\nThis only affects the current session's spend data — your tags are kept. You can re-sync or re-upload to restore it.\n\nA version is saved first — you can undo from ··· → Version History.`))return;
    snapshotNow(`Before removing ${n} campaign${n>1?"s":""} from dataset (${fmt$(removedSpend)})`,"pre_clear");
    setMergedNormRows(prev=>prev.filter(r=>!selected.has(campaignKey(r.campaign_group_name,r.campaign_name))));
    showNotif(`Removed ${n} campaign${n>1?"s":""} — ${fmt$(removedSpend)}`);
    setSelected(new Set());
  },[selected,campaigns,snapshotNow,canEdit]);
  const addDim=()=>{if(!canEdit)return;const n=newDim.trim();if(!n||tagDims.includes(n))return;setTagDims(p=>[...p,n]);setNewDim("");};
  const doSort=col=>{setSortDir(sortCol===col&&sortDir==="desc"?"asc":"desc");setSortCol(col);};
  const clearF=()=>{setFCamp("");setFCampExclude("");setFGroup("");setFGroupExclude("");setFPlat("");setFSMin("");setFSMax("");setFTag("");setFTagExclude("");setSelectedTagFilters(new Set());setFStatus("all");};

  // Cmd+Z / Ctrl+Z undo
  useEffect(()=>{
    const handler=(e)=>{if((e.metaKey||e.ctrlKey)&&e.key==="z"&&!e.shiftKey){e.preventDefault();undoTags();}};
    window.addEventListener("keydown",handler);return()=>window.removeEventListener("keydown",handler);
  },[undoTags]);
  const hasF=fCamp||fCampExclude||fGroup||fGroupExclude||fPlat||fSMin||fSMax||fTag||fTagExclude||selectedTagFilters.size>0||fStatus!=="all";
  // "auto" here means "multiple channels — read platform per-row from a mapped column" (see the
  // Channels selector in the map step). A report with mixed channels but no Platform column
  // mapped would otherwise silently fall back to normalizeRows' "Unknown" default per row, so
  // require the mapping in that mode rather than letting rows quietly go unlabeled.
  const canProceed=colMap.campaign_group_name&&colMap.spend&&(uploadPlatform!=="auto"||!!colMap.platform);
  // Distinct channels detected in the mapped Platform column, resolved through the same
  // derivePlatform naming/campaign-type logic used everywhere else (freshness, pacing, filters) —
  // so what's previewed here is exactly what the rest of the app will call each row, not just the
  // raw column text. Lets someone importing a multi-channel report catch a bad column pick or an
  // unrecognized channel label before merging, instead of after.
  const channelPreview=useMemo(()=>{
    if(uploadPlatform!=="auto"||!colMap.platform||!rawRows.length)return[];
    const counts={};
    rawRows.forEach(row=>{
      const raw=(row[colMap.platform]||"").trim();
      if(!raw)return;
      const resolved=derivePlatform(row[colMap.campaign_group_name],row[colMap.campaign_name],raw,row[colMap.campaign_type]);
      counts[resolved]=(counts[resolved]||0)+1;
    });
    return Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  },[uploadPlatform,colMap.platform,colMap.campaign_group_name,colMap.campaign_name,colMap.campaign_type,rawRows]);

  // Settings — independent data-clear actions. Reporting has no state of its own (it's a
  // computed pacing view over Budget + Tagger data), so there's no separate "clear reporting"
  // action — clearing either of the two source datasets is reflected there automatically.
  // Every clear-* handler below sets allowEmptyConfigWriteRef/allowEmptyRowsWriteRef right before
  // its setState calls — that's what authorizes the debounced save's empty-write guard (see
  // hadRealConfigRef/hadRealRowsRef higher up) to actually let this specific empty payload through
  // instead of blocking it as a suspected accidental save. Every one of these is already gated
  // behind its own window.confirm() and a pre-clear version snapshot, so this is a real,
  // user-initiated clear, not the kind of accidental empty save the guard exists to catch.
  const clearTaggerData=()=>{
    if(!canEdit)return;
    if(!window.confirm("Clear all Tagger data?\n\nThis removes every imported spend row, every campaign tag, and your custom tag dimensions. Budget allocations are not affected.\n\nA version of your current data is saved first — you can restore it from File → Version History.\n\nThis cannot be undone from here."))return;
    snapshotNow("Before clearing Tagger data","pre_clear");
    allowEmptyConfigWriteRef.current=true;allowEmptyRowsWriteRef.current=true;
    setMergedNormRows([]);setTags({});setTagDims(DEFAULT_DIMS);setColMap({});setStep("upload");setLastSyncRange(null);setTagsHistory([]);
    try{["paidhq_rows","paidhq_tags","paidhq_dims","paidhq_sync_range"].forEach(k=>localStorage.removeItem(k));}catch(e){}
    showNotif("Tagger data cleared");
  };
  const clearBudgetData=()=>{
    if(!canEdit)return;
    if(!window.confirm("Clear all Budget data?\n\nThis removes every budget allocation, budget segment, and annotation dimension across all years. Tagged campaign data is not affected.\n\nA version of your current data is saved first — you can restore it from File → Version History.\n\nThis cannot be undone from here."))return;
    snapshotNow("Before clearing Budget data","pre_clear");
    allowEmptyConfigWriteRef.current=true;
    setBudgets({});setBudgetDims([]);setBudgetRowMeta({});setBudgetMetaDims([]);setBudgetImportMeta({});
    try{["paidhq_budgets","paidhq_budget_dims","paidhq_budget_meta","paidhq_budget_meta_dims","paidhq_budget_import_meta"].forEach(k=>localStorage.removeItem(k));}catch(e){}
    showNotif("Budget data cleared");
  };
  const clearAllData=()=>{
    if(!canEdit)return;
    if(!window.confirm("Delete ALL data for this instance?\n\nThis clears Tagger data (spend rows, tags, dimensions) AND Budget data (allocations, segments) across every year. Your theme and layout preferences are kept.\n\nA version of your current data is saved first — you can restore it from File → Version History.\n\nThis cannot be undone from here."))return;
    snapshotNow("Before deleting all data","pre_clear");
    clearTaggerDataSilent();clearBudgetDataSilent();
    showNotif("All data deleted");
  };
  function clearTaggerDataSilent(){
    allowEmptyConfigWriteRef.current=true;allowEmptyRowsWriteRef.current=true;
    setMergedNormRows([]);setTags({});setTagDims(DEFAULT_DIMS);setColMap({});setStep("upload");setLastSyncRange(null);setTagsHistory([]);
    try{["paidhq_rows","paidhq_tags","paidhq_dims","paidhq_sync_range"].forEach(k=>localStorage.removeItem(k));}catch(e){}
  }
  function clearBudgetDataSilent(){
    allowEmptyConfigWriteRef.current=true;
    setBudgets({});setBudgetDims([]);setBudgetRowMeta({});setBudgetMetaDims([]);setBudgetImportMeta({});
    try{["paidhq_budgets","paidhq_budget_dims","paidhq_budget_meta","paidhq_budget_meta_dims","paidhq_budget_import_meta"].forEach(k=>localStorage.removeItem(k));}catch(e){}
  }
  // Per-channel clear — same idea as "Delete from dataset" in the Tagger's multi-select toolbar
  // (bulkRemoveCampaigns), just reachable from Settings without having to filter/select rows by
  // hand first. Only drops spend rows for that platform; tags on a campaign are left as-is (same
  // convention as bulkRemoveCampaigns/the Tagger's single-row delete) — if that campaign's other
  // rows are gone too, it just won't appear until re-imported, at which point it'll need retagging.
  const clearPlatformData=(platform,rowCount)=>{
    if(!canEdit)return;
    if(!rowCount)return;
    if(!window.confirm(`Clear all "${platform}" spend data?\n\nThis removes ${rowCount.toLocaleString()} spend row${rowCount===1?"":"s"} for ${platform} from the Tagger. Tags are kept — a campaign only disappears here if none of its rows are left. Budget allocations are not affected.\n\nA version of your current data is saved first — you can restore it from File → Version History.\n\nThis cannot be undone from here.`))return;
    snapshotNow(`Before clearing ${platform} data`,"pre_clear");
    allowEmptyRowsWriteRef.current=true;
    setMergedNormRows(prev=>prev.filter(r=>derivePlatform(r.campaign_group_name,r.campaign_name,r.platform,r.campaign_type)!==platform));
    showNotif(`${platform} data cleared — ${rowCount.toLocaleString()} row${rowCount===1?"":"s"} removed`);
  };
  // Date-range-scoped clear — closes the gap platform-level clear doesn't cover: redoing or
  // purging just one slice of time (e.g. "March's Google data was wrong, but April/May are fine")
  // without touching everything else for that platform. Matches on row.date, same parseSpendDate
  // used everywhere else, so it's consistent with how spend gets bucketed into periods elsewhere.
  const clearRangeMatch=useCallback(r=>{
    if(clearRangePlatform!=="all"&&derivePlatform(r.campaign_group_name,r.campaign_name,r.platform,r.campaign_type)!==clearRangePlatform)return false;
    const d=parseSpendDate(r.date);
    if(!d)return false;
    if(clearRangeStart){const s=parseSpendDate(clearRangeStart);if(s&&d<s)return false;}
    if(clearRangeEnd){const e=parseSpendDate(clearRangeEnd);if(e&&d>e)return false;}
    return true;
  },[clearRangePlatform,clearRangeStart,clearRangeEnd]);
  const clearDateRangeData=()=>{
    if(!canEdit)return;
    const matches=mergedNormRows.filter(clearRangeMatch);
    if(!matches.length)return;
    const campaignCount=new Set(matches.map(r=>campaignKey(r.campaign_group_name,r.campaign_name))).size;
    const platLabel=clearRangePlatform==="all"?"all platforms":clearRangePlatform;
    const rangeLabel=`${clearRangeStart||"the beginning"} through ${clearRangeEnd||"today"}`;
    if(!window.confirm(`Clear spend data for ${platLabel}, ${rangeLabel}?\n\nThis removes ${matches.length.toLocaleString()} spend row${matches.length===1?"":"s"} across ${campaignCount.toLocaleString()} campaign${campaignCount===1?"":"s"}. Tags are kept — a campaign only disappears here if none of its rows are left. Budget allocations are not affected.\n\nA version of your current data is saved first — you can restore it from File → Version History.\n\nThis cannot be undone from here.`))return;
    snapshotNow(`Before clearing ${platLabel} data (${rangeLabel})`,"pre_clear");
    allowEmptyRowsWriteRef.current=true;
    setMergedNormRows(prev=>prev.filter(r=>!clearRangeMatch(r)));
    showNotif(`Cleared ${matches.length.toLocaleString()} row${matches.length===1?"":"s"} for ${platLabel}, ${rangeLabel}`);
    setClearRangeStart("");setClearRangeEnd("");
  };

  // ── Export (the ··· menu's "Export [view]" + "Email a copy") ──
  // dashboard/tagger/budget/pacing each build their own report from state that already lives in
  // this top-level component — settings has nothing to export, so exportableView is null there
  // and the dots menu just shows the version-history items on its own.
  const exportableView=EXPORTABLE_VIEWS[view]||null;
  const buildCurrentReport=useCallback(()=>{
    if(!exportableView)return null;
    return exportableView.build({mergedNormRows:visibleNormRows,tags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,defaultForecastModel});
  },[exportableView,visibleNormRows,tags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,defaultForecastModel]);
  const handleExportDownload=useCallback(format=>{
    const report=buildCurrentReport();
    if(!report||!exportableView)return;
    downloadReport(report,format,exportableView.filenameBase);
    showNotif(`Exported ${exportableView.label} as ${EXPORT_FORMATS.find(f=>f.key===format)?.label||format.toUpperCase()}`);
  },[buildCurrentReport,exportableView]);
  const[sheetsExporting,setSheetsExporting]=useState(false);
  const handleExportToGoogleSheets=useCallback(async()=>{
    const report=buildCurrentReport();
    if(!report||!exportableView)return;
    // Open a blank tab SYNCHRONOUSLY, right here in the click handler, before any of the awaited
    // API calls below — that's what makes the browser treat it as a direct result of the user's
    // click and allow it. Once the real spreadsheet URL is ready we just navigate this already-
    // open tab to it. Doing `window.open(url)` AFTER those awaits (the original code) opens the
    // tab many ticks after the click, outside any "user gesture" window most browsers require,
    // so it silently gets popup-blocked — this is exactly what just happened during testing.
    const preOpened=window.open("","_blank","noopener,noreferrer");
    if(preOpened)preOpened.document.write("<title>Exporting…</title><body style=\"font-family:sans-serif;color:#666;padding:40px\">Creating your Google Sheet…</body>");
    setSheetsExporting(true);
    try{
      const url=await exportReportToGoogleSheets(report);
      showNotif(`Exported ${exportableView.label} to Google Sheets`);
      if(preOpened&&!preOpened.closed)preOpened.location.href=url;
      else window.open(url,"_blank","noopener,noreferrer"); // fallback if even the blank tab got blocked
    }catch(e){
      console.error("[google sheets export]",e);
      if(preOpened&&!preOpened.closed)preOpened.close();
      window.alert(e.message||"Couldn't export to Google Sheets. Try again.");
    }finally{
      setSheetsExporting(false);
    }
  },[buildCurrentReport,exportableView]);
  const openEmailExport=useCallback(()=>{
    setEmailError("");setEmailExportOpen(true);
  },[]);
  const sendEmailExport=useCallback(async()=>{
    const report=buildCurrentReport();
    if(!report||!exportableView)return;
    const to=emailExportTo.trim();
    if(!to){setEmailError("Enter a recipient email address.");return;}
    setEmailSending(true);setEmailError("");
    try{
      const blob=buildReportBlob(report,emailExportFormat);
      const base64=await blobToBase64(blob);
      const fmt=EXPORT_FORMATS.find(f=>f.key===emailExportFormat);
      const filename=`${exportableView.filenameBase}.${emailExportFormat}`;
      const res=await fetch("/api/email",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        to,subject:`${report.title} — BudgetHQ`,note:emailExportNote,reportTitle:report.title,reportSubtitle:report.subtitle,
        filename,mime:fmt?.mime||"application/octet-stream",base64,
      })});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data?.error||"Failed to send email");
      try{localStorage.setItem("paidhq_last_export_email",to);}catch(e){}
      setEmailExportOpen(false);setEmailExportNote("");
      showNotif(`Emailed ${exportableView.label} to ${to}`);
    }catch(err){
      setEmailError(err.message||"Failed to send email");
    }finally{
      setEmailSending(false);
    }
  },[buildCurrentReport,exportableView,emailExportTo,emailExportFormat,emailExportNote]);

  // Per Mo's request (2026-07-24): headers used to fade to T.textMuted (grey) until actively
  // sorted, and only turn T.text (dark) on the active sort column. Now always T.text — active sort
  // is still shown via the underline below, just no longer via color.
  const SH=({col,label,center})=>(<span onClick={()=>doSort(col)} style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text,textDecoration:sortCol===col?"underline":"none",textUnderlineOffset:2,cursor:"pointer",userSelect:"none",display:"inline-flex",alignItems:"center",gap:3,...(center?{justifyContent:"center",width:"100%"}:{})}}>{label}<span style={{opacity:0.7,fontSize:9}}>{sortCol===col?(sortDir==="desc"?"▾":"▴"):"⇅"}</span></span>);
  // White fill, same as the toolbar behind it — Vercel's filter pills are white-on-white with
  // just a border for separation, not a gray fill. paddingLeft is bumped separately on the three
  // primary "contains" fields to make room for the search icon from IconField.
  const fIn={background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,padding:"6px 9px",fontSize:11,outline:"none",fontFamily:"'DM Sans',sans-serif",width:"100%",marginTop:3,height:30,boxSizing:"border-box"};

  // Persistent stats sidebar (middle column) — shown regardless of which tab is active.
  // Falls back to labeled sample numbers before any real data is loaded, same treatment
  // the Dashboard cards used to do on their own before that block moved here.
  const hasSidebarData=mergedNormRows.length>0;
  const sidebarBc=T.badgeColors||[T.accent,T.accent,T.accent,T.accent];
  const sidebarStatRows=[
    {label:"Campaigns",value:hasSidebarData?stats.total.toLocaleString():"—",dot:sidebarBc[1]},
    {label:"Tagged",value:hasSidebarData?`${stats.tagged.toLocaleString()} (${stats.total?Math.round((stats.tagged/stats.total)*100):0}%)`:"—",dot:sidebarBc[3]},
    {label:"Needs review",value:hasSidebarData?stats.untagged.toLocaleString():"—",dot:hasSidebarData?(stats.untagged>0?sidebarBc[0]:sidebarBc[3]):sidebarBc[0]},
  ];

  // Spend-conflict review — shown at the "Continue to tagging" choke-point (shared by CSV upload
  // AND Google Sheets spend pull) when an incoming row's spend disagrees with a value that came
  // from a live platform sync for the same campaign+date. Per user decision: warn and require
  // explicit confirmation before a sheet/CSV value silently overwrites synced platform data.
  const[spendConflictReview,setSpendConflictReview]=useState(null); // {conflicts,pendingRows,fileLabel,useImportedSet:Set<key>}
  // "Use imported" toggling lets the user override the default (keep synced value) per-row rather
  // than all-or-nothing, since a sheet/CSV disagreeing with sync could be right for some rows
  // (a genuine correction) and wrong for others (stale export) within the same import.
  const toggleUseImported=(key)=>{
    setSpendConflictReview(p=>{
      if(!p)return p;
      const nx=new Set(p.useImportedSet);
      if(nx.has(key))nx.delete(key);else nx.add(key);
      return{...p,useImportedSet:nx};
    });
  };
  const cancelSpendConflictImport=()=>setSpendConflictReview(null);
  const confirmSpendConflictImport=()=>{
    if(!spendConflictReview||!canEdit)return;
    const{pendingRows,fileLabel,useImportedSet}=spendConflictReview;
    const conflictKeys=new Set(spendConflictReview.conflicts.map(c=>c.key));
    // Rows that weren't flagged as conflicts always import normally. Flagged rows only overwrite
    // the synced value if the user explicitly opted in via the checkbox; otherwise drop them from
    // the incoming set so mergeRows leaves the existing synced row untouched.
    const rowsToMerge=pendingRows.filter(r=>{
      const key=spendRowKey(r);
      return!conflictKeys.has(key)||useImportedSet.has(key);
    });
    setMergedNormRows(prev=>mergeRows(prev,rowsToMerge));
    const kept=useImportedSet.size;
    checkpoint(`Imported spend data — ${fileLabel} (${rowsToMerge.length} rows)`,"tagger_import");
    showNotif(`Added ${rowsToMerge.length} rows — ${kept} conflict${kept===1?"":"s"} overwritten, rest kept synced values`);
    setSpendConflictReview(null);
    setUploadPlatform("auto");
    setUploadAsOf("");
    setUploadIsMonthly(false);
    setStep("tag");setView("tagger");
  };

  // While this workspace's tags/budgets/spend rows are still loading from the server (or failed
  // to load), show that instead of the normal app shell — better than letting someone start
  // interacting with an empty upload screen that's about to be overwritten once the real data
  // lands, or silently losing data if a save effect fired against the pre-load empty state.
  if(workspace&&workspaceDataLoading){
    return(
      <div style={{height:"100vh",width:"100vw",display:"flex",alignItems:"center",justifyContent:"center",background:T.bg,color:T.textMuted,fontFamily:"'DM Sans',sans-serif",fontSize:13}}>
        Loading {workspace.name}…
      </div>
    );
  }
  if(workspace&&workspaceDataError){
    return(
      <div style={{height:"100vh",width:"100vw",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,background:T.bg,fontFamily:"'DM Sans',sans-serif",padding:24}}>
        <div style={{padding:"12px 16px",background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,borderRadius:8,color:T.danger,fontSize:13,maxWidth:420,textAlign:"center"}}>{workspaceDataError}</div>
        <button onClick={()=>window.location.reload()} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"7px 16px",fontSize:12,color:T.text,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Reload</button>
      </div>
    );
  }

  return(
    <div style={{height:"100vh",width:"100vw",display:"flex",flexDirection:"column",background:T.bg,color:T.text,fontFamily:"'DM Sans',sans-serif",overflow:"hidden",position:"relative"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"/>

      {/* ── TOP BAR ──
          The divider under the bar is NOT one continuous border on this outer div — that made
          "erasing" it under just the active tab fragile (overlap/margin tricks kept leaving a
          hairline). Instead every piece (logo, each tab, the trailing filler, actions) draws its
          OWN bottom border at the same fixed height, and the active tab's is simply colored to
          match the body (T.bg) instead of T.border, so it reads as blank/seamless there.
          The "···" menu on the right (Notion-style) covers file-level actions (version history)
          instead of a dedicated "File" trigger — its dropdown is positioned relative to this
          outer wrapper so it isn't clipped by any child's overflow:hidden. ── */}
      <div style={{display:"flex",alignItems:"stretch",height:48,flexShrink:0,background:T.topbarBg,borderBottom:`1px solid ${T.border}`,zIndex:30,position:"relative"}}>
        <div style={{width:isMobile?undefined:(statsOpen?statsWidth:56),display:"flex",alignItems:"center",justifyContent:statsOpen||isMobile?"flex-start":"center",gap:6,padding:statsOpen||isMobile?"0 16px":0,flexShrink:0,boxSizing:"border-box",borderRight:isMobile?"none":`1px solid ${T.border}`,overflow:"hidden",transition:statsResizing.current?"none":"width 0.15s"}}>
          <div style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <Icon name="bolt" size={17} color={T.text}/>
          </div>
          {(statsOpen||isMobile)&&<div style={{fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:500,color:T.text,letterSpacing:"-0.3px",whiteSpace:"nowrap"}}>BudgetHQ</div>}
          {/* Bigger, easier-to-hit sidebar toggle living right next to the wordmark — the tiny 18px
              circle riding the sidebar's edge (below) is still there, but it's a fiddly target.
              This is the primary way to hide/show the column now. Doesn't apply to Dashboard, which
              has no sidebar column of its own. */}
          {!isMobile&&view!=="dashboard"&&(
            <button className="bhq-iconbtn" onClick={()=>setStatsOpen(o=>!o)} title={statsOpen?"Hide sidebar":"Show sidebar"}
              style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"none",borderRadius:5,color:T.textMuted,cursor:"pointer",padding:0,flexShrink:0}}>
              <Icon name="panelLeft" size={15} color={T.textMuted}/>
            </button>
          )}
        </div>
        {/* Tabs underline the active one with a 2px accent bottom-border rather than the old
            "browser tab" bordered-box treatment — flat until active/hover, per the VaultHQ
            top-bar convention. */}
        {/* overflowX was "visible" on desktop (only scrolling on mobile) — fine while the trailing
            actions area stayed small, but at moderate window widths with a full action toolbar
            (tagged-count pill + Add data + Clear all, all removed 2026-07-24) this flex item had
            nowhere to shrink to and its content spilled out over the neighboring actions area
            instead of wrapping, which is what the overlapping "Reporting & Pacing" label Mo
            screenshotted actually was. Always-auto means if tabs ever don't fit again, this row
            scrolls horizontally instead of painting over its neighbor. */}
        <div style={{display:"flex",alignItems:"stretch",gap:2,flex:1,paddingLeft:isMobile?4:16,minWidth:0,overflowX:"auto"}}>
          {NAV.map(item=>{
            const active=view===item.key;
            return <button key={item.key} className={active?undefined:"bhq-tab"} onClick={()=>{
                // Add Data now lives at view==="data" (2026-07-24) instead of nested under Campaign
                // Tagger's own step==="upload" — clicking Tagger with no data yet sends you to Data
                // Sources first, matching "connect data before tagging it." Clicking Data Sources
                // itself always resets to the upload step, same reasoning as the old Tagger branch.
                //
                // BUG FIX (2026-07-24): this used to branch on `step!=="tag"` instead of whether data
                // actually exists. `step` is a transient UI-flow flag other buttons leave sitting on
                // "upload" long after the fact — e.g. the Tagger toolbar's "↑ Add data" button, or
                // simply visiting Data Sources — and nothing ever resets it back to "tag" unless you
                // complete a new import. Once that happened, clicking this tab while already on Data
                // Sources (view==="data", step==="upload") called setStep("upload") and
                // setView("data") — both no-ops — so literally nothing happened, even though tagged
                // data was sitting right there. Branching on mergedNormRows.length instead makes this
                // tab always land you on the Tagger table whenever there's data to show, no matter
                // what step some earlier click left behind.
                if(item.key==="tagger"){if(mergedNormRows.length>0){setStep("tag");setView("tagger");}else{setStep("upload");setView("data");}}
                else if(item.key==="data"){setStep("upload");setView("data");}
                else setView(item.key);
              }} style={{display:"flex",alignItems:"center",gap:7,padding:isMobile?"0 12px":"0 16px",boxSizing:"border-box",flexShrink:0,border:"none",borderBottom:`2px solid ${active?T.accent:"transparent"}`,background:"transparent",color:active?T.text:T.textSub,fontSize:14,fontWeight:active?600:500,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap",transition:"color 0.12s,border-color 0.12s"}}>
              <Icon name={item.icon} size={15} color={active?T.accent:T.textSub}/>
              {!isMobile&&item.label}
            </button>;
          })}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?4:8,padding:isMobile?"0 8px":"0 14px",flexShrink:0,boxSizing:"border-box"}}>
          {/* Removed 2026-07-24, per Mo — this trio (tagged-count pill, "Add data", "Clear all")
              was crowding the bar badly enough at moderate widths that it visually overlapped the
              nav tabs (see the responsive fix on the tabs container below too). All three were also
              redundant with something that already exists elsewhere: the tagged count is in the
              persistent stats sidebar, "Add data" duplicated the Data Sources nav tab immediately to
              its left, and "Clear all" duplicated Settings' "Clear Tagger data" section — that one
              specifically is also the safer home for a destructive, irreversible action anyway.
              "Add data"'s back-to-Data-Sources role is replaced by a proper "← Back to Data Sources"
              link inside the Tagger table's own filter row instead (below), rather than living up
              here. */}
          {workspace&&workspaces&&(
            <div style={{position:"relative"}}>
              <button className="bhq-iconbtn" onClick={()=>setWorkspaceMenuOpen(o=>!o)}
                style={{display:"flex",alignItems:"center",gap:6,height:30,padding:"0 10px",borderRadius:8,background:workspaceMenuOpen?T.surfaceHover:"transparent",border:`1px solid ${T.border}`,cursor:"pointer",transition:"background 0.12s",fontFamily:"'DM Sans',sans-serif"}}>
                {!isMobile&&<span style={{fontSize:11,fontWeight:600,color:T.text,maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{workspace.name}</span>}
                <Icon name="chevronDown" size={11} color={T.textMuted}/>
              </button>
              {workspaceMenuOpen&&(<>
                <div onClick={()=>setWorkspaceMenuOpen(false)} style={{position:"fixed",inset:0,zIndex:249}}/>
                <div style={{position:"absolute",top:38,right:0,zIndex:250,minWidth:240,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd,padding:6,display:"flex",flexDirection:"column"}}>
                  <div style={{padding:"5px 10px 6px",fontSize:10,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:T.textMuted}}>Workspaces</div>
                  {workspaces.map(w=>(
                    <button key={w.id} className="bhq-row" onClick={()=>{setWorkspaceMenuOpen(false);onSwitchWorkspace&&onSwitchWorkspace(w.id);}}
                      style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"7px 10px",borderRadius:6,background:w.id===workspace.id?T.accentBg:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",textAlign:"left"}}>
                      <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{w.name}</span>
                      {w.id===workspace.id&&<Icon name="check" size={13} color={T.accent}/>}
                    </button>
                  ))}
                  <div style={{height:1,background:T.border,margin:"6px 4px"}}/>
                  <button className="bhq-row" onClick={()=>{setWorkspaceMenuOpen(false);onCreateWorkspace&&onCreateWorkspace();}}
                    style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",textAlign:"left"}}>
                    + New workspace
                  </button>
                </div>
              </>)}
            </div>
          )}
          {session&&(
            <div style={{position:"relative"}}>
              <button className="bhq-iconbtn" title={session.user?.email} onClick={()=>setAccountMenuOpen(o=>!o)}
                style={{width:30,height:30,borderRadius:"50%",background:accountMenuOpen?T.surfaceHover:T.accentBg,border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"background 0.12s",fontSize:11,fontWeight:700,color:T.accent,fontFamily:"'DM Sans',sans-serif"}}>
                {(session.user?.email||"?")[0].toUpperCase()}
              </button>
              {accountMenuOpen&&(<>
                <div onClick={()=>setAccountMenuOpen(false)} style={{position:"fixed",inset:0,zIndex:249}}/>
                <div style={{position:"absolute",top:38,right:0,zIndex:250,minWidth:240,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd,padding:6,display:"flex",flexDirection:"column"}}>
                  <div style={{padding:"7px 10px 8px",fontSize:12,color:T.text,fontWeight:600,wordBreak:"break-all"}}>{session.user?.email}</div>
                  <div style={{height:1,background:T.border,margin:"2px 4px 6px"}}/>
                  <button className="bhq-row" onClick={()=>{setAccountMenuOpen(false);onSignOut&&onSignOut();}}
                    style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.danger,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",textAlign:"left"}}>
                    Sign out
                  </button>
                  {/* Other accounts held in this browser (e.g. a client's login alongside your
                      own) — clicking one flips the whole app over to it, landing on that account's
                      last-active workspace. See AuthGate.jsx for how these sessions stay alive in
                      the background. */}
                  {accounts&&accounts.filter(a=>a.storageKey!==activeAccountKey).length>0&&(<>
                    <div style={{height:1,background:T.border,margin:"6px 4px"}}/>
                    <div style={{padding:"5px 10px 6px",fontSize:10,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:T.textMuted}}>Switch account</div>
                    {accounts.filter(a=>a.storageKey!==activeAccountKey).map(a=>(
                      <button key={a.storageKey} className="bhq-row" onClick={()=>{setAccountMenuOpen(false);onSwitchAccount&&onSwitchAccount(a.storageKey);}}
                        style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",textAlign:"left",overflow:"hidden"}}>
                        <span style={{width:18,height:18,borderRadius:"50%",background:T.accentBg,color:T.accent,fontSize:10,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{(a.email||"?")[0].toUpperCase()}</span>
                        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.email}</span>
                      </button>
                    ))}
                  </>)}
                  <div style={{height:1,background:T.border,margin:"6px 4px"}}/>
                  <button className="bhq-row" onClick={()=>{setAccountMenuOpen(false);onAddAccount&&onAddAccount();}}
                    style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",textAlign:"left"}}>
                    + Add account
                  </button>
                </div>
              </>)}
            </div>
          )}
          <button className="bhq-iconbtn" title="Settings" onClick={()=>setView("settings")}
            style={{width:30,height:30,borderRadius:8,background:view==="settings"?T.surfaceHover:"transparent",border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"background 0.12s"}}>
            <Icon name="gear" size={15} color={T.textSub}/>
          </button>
          <button className="bhq-iconbtn" title="More" onClick={()=>setFileMenuOpen(o=>!o)}
            style={{width:30,height:30,borderRadius:8,background:fileMenuOpen?T.surfaceHover:"transparent",border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"background 0.12s"}}>
            <Icon name="dots" size={15} color={T.textSub}/>
          </button>
          {fileMenuOpen&&(<>
            <div onClick={()=>setFileMenuOpen(false)} style={{position:"fixed",inset:0,zIndex:249}}/>
            <div style={{position:"absolute",top:44,right:isMobile?8:14,zIndex:250,minWidth:240,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd,padding:6,display:"flex",flexDirection:"column"}}>
              {exportableView&&(<>
                <div style={{padding:"5px 10px 5px",fontSize:10,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:T.textMuted}}>Export {exportableView.label}</div>
                <div style={{display:"flex",gap:4,padding:"0 6px 6px"}}>
                  {EXPORT_FORMATS.map(f=>(
                    <button key={f.key} className="bhq-row" onClick={()=>{setFileMenuOpen(false);handleExportDownload(f.key);}}
                      style={{flex:1,padding:"6px 0",borderRadius:6,border:`1px solid ${T.border}`,background:"transparent",color:T.textSub,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <button className="bhq-row" disabled={sheetsExporting} onClick={()=>{setFileMenuOpen(false);handleExportToGoogleSheets();}}
                  style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:sheetsExporting?"default":"pointer",opacity:sheetsExporting?0.6:1,fontFamily:"'DM Sans',sans-serif",textAlign:"left"}}>
                  <Icon name="export" size={14} color={T.textSub}/> {sheetsExporting?"Exporting to Google Sheets…":"Export to Google Sheets"}
                </button>
                <button className="bhq-row" onClick={()=>{setFileMenuOpen(false);openEmailExport();}}
                  style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",textAlign:"left"}}>
                  <Icon name="mail" size={14} color={T.textSub}/> Email a copy…
                </button>
                <div style={{height:1,background:T.border,margin:"6px 4px"}}/>
              </>)}
              {canEdit&&<button className="bhq-row" onClick={()=>{setFileMenuOpen(false);setNameVersionOpen(true);}}
                style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",textAlign:"left"}}>
                <Icon name="save" size={14} color={T.textSub}/> Name current version…
              </button>}
              {canEdit&&<button className="bhq-row" onClick={openVersionHistory}
                style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",textAlign:"left"}}>
                <Icon name="clock" size={14} color={T.textSub}/> Version history
              </button>}
            </div>
          </>)}
        </div>
      </div>

      {/* View-only banner — "member" role can see every tab but every product API route rejects
          their writes server-side (requireEditAccess). This is the one place that surfaces that
          plainly regardless of which tab you're on, rather than only finding out via a failed
          save. Owners/admins never see this. */}
      {!canEdit&&(
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"7px 16px",background:T.accentBg,borderBottom:`1px solid ${T.accentBorder}`,fontSize:12,color:T.text,fontFamily:"'DM Sans',sans-serif",flexShrink:0}}>
          <Icon name="lock" size={12} color={T.textSub}/>
          You have view-only access to this workspace — ask an owner or admin for edit access.
        </div>
      )}

      {/* ── BODY ROW ── */}
      <div style={{flex:1,display:"flex",flexDirection:"row",overflow:"hidden",minHeight:0,position:"relative"}}>

      {/* ── STATS SIDEBAR ── */}
      {!isMobile&&(<>
        {/* Dashboard deliberately gets no stats column at all — its own content now houses what
            this generic sidebar used to show (Total spend/Campaigns/Tagged/Needs review), and a
            second, mostly-empty vertical column next to a page that's already a full layout was
            just wasted width (see 2026-07-19 UX note). Every other view keeps the normal
            open/collapsible behavior. */}
        <aside style={{width:view==="dashboard"?0:(statsOpen?statsWidth:0),flexShrink:0,background:T.sidebarBg,borderRight:view==="dashboard"?"none":(statsOpen?`1px solid ${T.border}`:"none"),display:"flex",flexDirection:"column",padding:view==="dashboard"?0:(statsOpen?"18px 14px":0),overflow:"hidden",gap:12,zIndex:20,transition:statsResizing.current?"none":"width 0.15s,padding 0.15s"}}>

          {view==="dashboard"?null:view==="budget"?(
            <div ref={setBudgetSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="pacing"?(
            <div ref={setPacingSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="ask"?(
            <div ref={setAskSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="data"?(
            // Data Sources' own left column (2026-07-24, per Mo — modeled on Funnel.io's Data
            // sources page, scoped down since BudgetHQ has ~8 connectors total, not Funnel's scale).
            // Health list reuses the exact same connectionDetails Settings' Connections table and
            // the Dashboard's "Data source health" card both already read — one source of truth,
            // three places it's summarized.
            <div className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}>
              <SectionLabel T={T} style={{marginBottom:8,fontSize:11}}>Data source health</SectionLabel>
              {(()=>{
                const issues=(connectionDetails||[]).filter(c=>c.needsReconnect||c.needsAccountSelection||c.lastAutoSyncStatus==="error");
                if(!connectionDetails||connectionDetails.length===0)return<div style={{fontSize:12,color:T.textMuted,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",marginBottom:14}}>No connectors set up yet — connect one below.</div>;
                if(issues.length===0)return<div style={{fontSize:12,color:T.success,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",marginBottom:14}}>All {connectionDetails.length} connected source{connectionDetails.length===1?"":"s"} healthy.</div>;
                return(
                  <div style={{display:"flex",flexDirection:"column",gap:2,marginBottom:14}}>
                    {/* Maintenance-robot illustration (2026-07-26, per Mo, licensed set) — only
                        shown when something actually needs fixing, same logic as the pills below it. */}
                    <img src={maintenanceRobotIcon} alt="" aria-hidden="true" style={{width:64,height:"auto",alignSelf:"center",marginBottom:6}}/>
                    {issues.map(c=>{
                      const reason=c.needsReconnect?"Reconnect":c.needsAccountSelection?"Pick account":"Sync failed";
                      return(
                        <div key={c.provider} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"5px 0",gap:8}}>
                          <span style={{fontSize:12,color:T.text,fontFamily:"'DM Sans',sans-serif",textTransform:"capitalize"}}>{c.provider}</span>
                          <Pill color={T.warning} bg={T.warning+"14"} border={T.warning+"55"} style={{fontSize:10}}>{reason}</Pill>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              <Divider T={T}/>
              <div style={{padding:"12px 0"}}>
                <SectionLabel T={T} style={{fontSize:11}}>Overview</SectionLabel>
                <StatRow T={T} size={11} label="Live connectors" value={PLATFORMS.filter(p=>p.status==="live").length.toString()}/>
                <StatRow T={T} size={11} label="Connected" value={Object.keys(connectedProviders).length.toString()}/>
                <StatRow T={T} size={11} label="Platforms with data" value={[...new Set(visibleNormRows.map(r=>r.platform))].filter(Boolean).length.toString()}/>
                <StatRow T={T} size={11} label="Data rows" value={stats.totalRows.toLocaleString()}/>
              </div>
              <Divider T={T}/>
              {/* Quick actions (2026-07-26, per Mo — left column had dead space below Overview).
                  "Sync all" fires the same syncPlatform() every per-row Sync button already uses,
                  just once per connected-and-not-paused provider instead of one at a time. */}
              <div style={{padding:"12px 0"}}>
                <SectionLabel T={T} style={{fontSize:11}}>Quick actions</SectionLabel>
                {(()=>{
                  const syncablePlatforms=connectionDetails.filter(c=>!c.paused&&PLATFORMS.some(p=>p.key===c.provider));
                  const anySyncing=Object.values(syncState).some(s=>s==="loading");
                  return(
                    <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      <Btn T={T} variant="subtle" size="sm"
                        disabled={!canEdit||anySyncing||syncablePlatforms.length===0}
                        onClick={()=>syncablePlatforms.forEach(c=>syncPlatform(c.provider))}
                        style={{width:"100%"}}>
                        {anySyncing?"Syncing…":`⟳ Sync all${syncablePlatforms.length?` (${syncablePlatforms.length})`:""}`}
                      </Btn>
                      <Btn T={T} variant="ghost" size="sm" onClick={()=>setDataSourcesSubView("add")} style={{width:"100%"}}>+ Add data source</Btn>
                    </div>
                  );
                })()}
              </div>
              <Divider T={T}/>
              {/* Data freshness — one line per connected provider, worst-first (sync failures,
                  then most-recently-synced, then manual connectors that only show how current
                  their imported DATA is since a manual pull has no persisted "ran at" timestamp,
                  then never-synced-yet last). Reuses lastAutoSyncAt/Status (rolling sync) and
                  importDateRangeByProvider (manual) — both already computed for the Connections
                  table below, no new state needed. */}
              <div style={{padding:"12px 0"}}>
                <SectionLabel T={T} style={{fontSize:11}}>Data freshness</SectionLabel>
                {(()=>{
                  const relTime=iso=>{
                    const mins=Math.round((Date.now()-new Date(iso).getTime())/60000);
                    if(mins<1)return"just now";
                    if(mins<60)return`${mins}m ago`;
                    const hrs=Math.round(mins/60);
                    if(hrs<24)return`${hrs}h ago`;
                    const days=Math.round(hrs/24);
                    if(days<7)return`${days}d ago`;
                    return new Date(iso).toLocaleDateString(undefined,{month:"short",day:"numeric"});
                  };
                  const rows=connectionDetails.map(c=>{
                    const pl=PLATFORMS.find(p=>p.key===c.provider);
                    if(!pl)return null;
                    const rolling=c.syncMode==="rolling";
                    const importEnd=importDateRangeByProvider[c.provider]?.end;
                    let text,color,bucket,sortTime;
                    if(rolling&&c.lastAutoSyncAt){
                      const failed=c.lastAutoSyncStatus==="error";
                      text=(failed?"Sync failed ":"Synced ")+relTime(c.lastAutoSyncAt);
                      color=failed?T.danger:T.success;
                      bucket=failed?0:1;
                      sortTime=new Date(c.lastAutoSyncAt).getTime();
                    }else if(importEnd){
                      text=`Data through ${new Date(importEnd).toLocaleDateString(undefined,{month:"short",day:"numeric"})}`;
                      color=T.textMuted;
                      bucket=2;
                      sortTime=new Date(importEnd).getTime();
                    }else{
                      text="Not synced yet";
                      color=T.textMuted;
                      bucket=3;
                      sortTime=0;
                    }
                    return{key:c.provider,label:pl.label,domain:pl.domain,platColor:pl.color,mark:pl.mark,text,color,bucket,sortTime};
                  }).filter(Boolean).sort((a,b)=>a.bucket-b.bucket||b.sortTime-a.sortTime);
                  if(rows.length===0)return<div style={{border:`1px dashed ${T.border}`,borderRadius:6,padding:"8px 10px",backgroundColor:T.surfaceEl,backgroundImage:T.hatchBg,fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}>Nothing connected yet.</div>;
                  return(
                    <div style={{display:"flex",flexDirection:"column",gap:7}}>
                      {rows.map(r=>(
                        <div key={r.key} style={{display:"flex",alignItems:"center",gap:7,minWidth:0}}>
                          <PlatformLogo domain={r.domain} color={r.platColor} mark={r.mark} size={16}/>
                          <div style={{minWidth:0,flex:1}}>
                            <div style={{fontSize:11,fontWeight:600,color:T.text,fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.label}</div>
                            <div style={{fontSize:11,color:r.color,fontFamily:"'DM Sans',sans-serif"}}>{r.text}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <Divider T={T}/>
              {/* Spend by platform — a quick "where's the money going" split using every imported
                  row (not date-filtered by the Range picker above, same scope as the Data rows
                  stat above it), same derivePlatform grouping Settings' own breakdown uses. */}
              <div style={{padding:"12px 0"}}>
                <SectionLabel T={T} style={{fontSize:11}}>Spend by platform</SectionLabel>
                {(()=>{
                  const map={};
                  visibleNormRows.forEach(r=>{
                    const p=derivePlatform(r.campaign_group_name,r.campaign_name,r.platform,r.campaign_type);
                    map[p]=(map[p]||0)+(r.spend||0);
                  });
                  const arr=Object.entries(map).map(([platform,spend])=>({platform,spend})).sort((a,b)=>b.spend-a.spend);
                  if(arr.length===0)return<div style={{border:`1px dashed ${T.border}`,borderRadius:6,padding:"8px 10px",backgroundColor:T.surfaceEl,backgroundImage:T.hatchBg,fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}>No spend data yet.</div>;
                  const max=arr[0].spend||1;
                  return(
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {arr.slice(0,5).map(p=>(
                        <div key={p.platform}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11,marginBottom:3,gap:6}}>
                            <span style={{display:"flex",alignItems:"center",gap:5,minWidth:0,overflow:"hidden"}}>
                              <span style={{width:6,height:6,borderRadius:"50%",background:PLATFORM_COLORS[p.platform]||T.textMuted,flexShrink:0}}/>
                              <span style={{color:T.text,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.platform}</span>
                            </span>
                            <span style={{color:T.textMuted,flexShrink:0,fontFamily:"'DM Sans',sans-serif"}}>{fmt$(p.spend)}</span>
                          </div>
                          <div style={{height:4,borderRadius:2,background:T.surfaceEl,overflow:"hidden"}}>
                            <div style={{height:"100%",width:`${Math.max(3,Math.round(p.spend/max*100))}%`,background:PLATFORM_COLORS[p.platform]||T.accent,borderRadius:2}}/>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          ):view==="tagger"?(
            // Lives directly in this component (unlike Budget/Pacing, the Tagger flow isn't a
            // separate child component) so no portal is needed — just render it here in place.
            <div className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}>
              <SectionLabel T={T} style={{marginBottom:8,fontSize:11}}>Tag Dimensions</SectionLabel>
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:8}}>
                {tagDims.map(dim=>(
                  /* Padding/weights aligned to StatRow (2026-07-24, per Mo) — "4px 0" instead of
                     "6px 8px" so labels start flush left same as Overview's, label weight matches
                     Overview's (no override, was 700 when selected — background/border below still
                     show selection), and the count now weight:600 to match StatRow's value weight.
                     × moved before the count (rather than after) so the count itself, not the
                     button, is the flush-right element — same right edge as Overview's values. */
                  <div key={dim} className={applyDim===dim?undefined:"bhq-row"} onClick={()=>setApplyDim(dim)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 0",borderRadius:6,cursor:"pointer",background:applyDim===dim?T.accentBg:"transparent",border:applyDim===dim?`1px solid ${T.accentBorder}`:"1px solid transparent"}}>
                    <span style={{fontSize:11,color:T.text}}>{dim}</span>
                    <span style={{display:"flex",alignItems:"center",gap:6}}>
                      <button onClick={e=>{e.stopPropagation();deleteDimension(dim);}} title={`Delete "${dim}" dimension`}
                        style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:14,lineHeight:1,padding:0,opacity:0.5,transition:"opacity 0.1s, color 0.1s"}}
                        onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.color=T.danger;}}
                        onMouseLeave={e=>{e.currentTarget.style.opacity=0.5;e.currentTarget.style.color=T.textMuted;}}>×</button>
                      <span style={{fontSize:11,fontWeight:600,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}>{Object.values(tags).filter(t=>t[dim]).length}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:5,marginBottom:12}}>
                <Inp value={newDim} onChange={setNewDim} placeholder="New dimension…" T={T} onKeyDown={e=>e.key==="Enter"&&addDim()} style={{fontSize:12,padding:"5px 8px"}}/>
                <Btn onClick={addDim} variant="subtle" size="sm" T={T}>+</Btn>
              </div>
              <Divider T={T}/>
              <div style={{padding:"12px 0",flex:1}}>
                <SectionLabel T={T} style={{fontSize:11}}>Overview</SectionLabel>
                {[{l:"Campaigns",v:stats.total.toString()},{l:"Platforms",v:[...new Set(visibleNormRows.map(r=>r.platform))].filter(Boolean).join(", ")||"—"},{l:"Showing",v:filtered.length.toString(),c:T.text},{l:"Filtered spend",v:"$"+Math.round(filtered.reduce((s,c)=>s+c.spend,0)).toLocaleString(),c:T.text},{l:"Tagged",v:stats.tagged.toString(),c:T.success},{l:"Needs review",v:stats.untagged.toString(),c:stats.untagged>0?T.warning:T.success},{l:"Total spend",v:fmt$(stats.totalSpend)},{l:"Data rows",v:stats.totalRows.toLocaleString()}].map(s=><StatRow key={s.l} label={s.l} value={s.v} color={s.c} T={T} size={11}/>)}
                {stats.dateRange&&<div style={{fontSize:11,color:T.textMuted,marginTop:8,fontFamily:"'DM Sans',sans-serif",lineHeight:1.6}}>{stats.dateRange}</div>}
                <div style={{marginTop:10,height:3,background:T.border,borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${stats.total?(stats.tagged/stats.total)*100:0}%`,background:T.accent,transition:"width 0.4s",borderRadius:2}}/></div>
                <div style={{fontSize:11,color:T.textMuted,marginTop:4}}>{stats.total?Math.round((stats.tagged/stats.total)*100):0}% tagged</div>
                <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:6}}>
                  <Btn onClick={exportTags} disabled={!campaigns.length} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↓ Export tags CSV</Btn>
                  <Btn onClick={()=>importTagsRef.current?.click()} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↑ Import tags CSV</Btn>
                  <input ref={importTagsRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>{importTagsFromCSV(e.target.files[0]);e.target.value="";}} />
                  <Btn onClick={()=>!tagScreenshotImporting&&importTagsScreenshotRef.current?.click()} disabled={tagScreenshotImporting} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>{tagScreenshotImporting?"Reading screenshot…":"📷 Import tags from screenshot"}</Btn>
                  <input ref={importTagsScreenshotRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{importTagsFromScreenshot(e.target.files[0]);e.target.value="";}} />
                  {tagScreenshotError&&<div style={{fontSize:11,color:T.danger}}>{tagScreenshotError}</div>}
                  <Btn onClick={()=>setGsheetTagOpen(o=>!o)} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>🔗 Connect Google Sheet</Btn>
                  {gsheetTagOpen&&(
                    <div style={{padding:"10px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:8}}>
                      {gsTags.tabs?.length>1?(
                        <div>
                          <div style={{fontSize:11,color:T.textSub,marginBottom:6}}>Which tab has the tagging table?</div>
                          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
                            {gsTags.tabs.map(t=>(
                              <button key={t.sheetId} disabled={gsTags.fetching} onClick={()=>gsTags.fetchTab(gsTags.spreadsheetId,t.title)}
                                style={{padding:"4px 9px",borderRadius:6,border:`1px solid ${T.border}`,background:T.surface,color:T.text,cursor:gsTags.fetching?"default":"pointer",fontSize:11,fontFamily:"'DM Sans',sans-serif",opacity:gsTags.fetching?0.6:1}}>{t.title}</button>
                            ))}
                          </div>
                          <Btn onClick={gsTags.cancelTabs} variant="ghost" size="sm" T={T}>Cancel</Btn>
                        </div>
                      ):(
                        <Btn onClick={gsTags.openPicker} disabled={gsTags.fetching} variant="primary" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>{gsTags.fetching?"Connecting…":"Choose from Google Drive"}</Btn>
                      )}
                      {gsTags.error&&(
                        <div style={{marginTop:6,fontSize:11,color:T.danger}}>
                          {gsTags.error}
                          {/(permission|forbidden|403)/i.test(gsTags.error)&&(
                            <div style={{marginTop:4}}>
                              Wrong Google account for this sheet? <span onClick={gsTags.retryWithNewAccount} style={{color:T.accent,cursor:"pointer",fontWeight:600,textDecoration:"underline"}}>Try a different account</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Tag browser */}
                {tagDims.some(d=>Object.keys(tagValueMap[d]||{}).length>0)&&(
                  <div style={{marginTop:16,borderTop:`1px solid ${T.border}`,paddingTop:14}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                      <SectionLabel T={T} style={{marginBottom:0,fontSize:11}}>Filter by tag</SectionLabel>
                      {selectedTagFilters.size>0&&<span style={{fontSize:10,color:T.text,fontWeight:600,fontFamily:"'DM Sans',sans-serif"}}>{selectedTagFilters.size} active</span>}
                    </div>
                    {tagDims.map(dim=>{
                      const vals=Object.entries(tagValueMap[dim]||{}).sort((a,b)=>b[1]-a[1]);
                      if(!vals.length)return null;
                      return(
                        <div key={dim} style={{marginBottom:12}}>
                          <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.textMuted,marginBottom:5,fontFamily:"'DM Sans',sans-serif"}}>{dim}</div>
                          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                            {vals.map(([val,count])=>{
                              const key=`${dim}:${val}`;
                              const active=selectedTagFilters.has(key);
                              return(
                                <button key={val} onClick={()=>toggleTagFilter(dim,val)}
                                  style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:14,fontSize:11,fontWeight:500,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",
                                    background:active?T.accent:T.surfaceEl,
                                    color:T.text,
                                    border:`1px solid ${active?T.accentHover:T.border}`,
                                    transition:"all 0.12s"}}>
                                  {val}
                                  <span style={{fontSize:10,opacity:0.7,background:active?"rgba(0,0,0,0.12)":T.border,borderRadius:8,padding:"0 4px"}}>{count}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {selectedTagFilters.size>0&&(
                      <div style={{fontSize:11,color:T.textMuted,marginTop:4,fontFamily:"'DM Sans',sans-serif"}}>
                        AND across dimensions · OR within
                        <button onClick={()=>setSelectedTagFilters(new Set())} style={{display:"block",fontSize:11,color:T.danger,background:"transparent",border:"none",cursor:"pointer",padding:"4px 0",fontFamily:"'DM Sans',sans-serif"}}>Clear tag filters ×</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ):(<>
          <PixelPanel T={T} style={{opacity:hasSidebarData?1:0.7}} contentStyle={{padding:"14px 16px",background:T.accentBg}}>
            <div style={{fontSize:10,fontWeight:700,color:T.textSub,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:6}}>Total spend</div>
            <div style={{fontSize:20,fontWeight:800,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>{hasSidebarData?"$"+Math.round(stats.totalSpend).toLocaleString():"No data yet"}</div>
          </PixelPanel>
          {!hasSidebarData&&(
            <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"3px 10px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:20,alignSelf:"flex-start"}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:T.textMuted,flexShrink:0}}/>
              <span style={{fontSize:9,fontWeight:600,color:T.textMuted,letterSpacing:"0.05em",textTransform:"uppercase"}}>No data yet</span>
            </div>
          )}
          {sidebarStatRows.map(s=>(
            <PixelPanel key={s.label} T={T} style={{opacity:hasSidebarData?1:0.7}} contentStyle={{padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:s.dot,flexShrink:0}}/>
                <span style={{fontSize:10,fontWeight:600,color:T.textMuted,letterSpacing:"0.06em",textTransform:"uppercase"}}>{s.label}</span>
              </div>
              <div style={{fontSize:19,fontWeight:700,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>{s.value}</div>
            </PixelPanel>
          ))}
          </>)}
        </aside>

        {/* Drag-to-resize handle for the stats column — thin strip on the divider line. Not shown
            on Dashboard, which has no stats column to resize. */}
        {view!=="dashboard"&&statsOpen&&(
          <div onMouseDown={()=>{statsResizing.current=true;document.body.style.cursor="col-resize";}}
            title="Drag to resize"
            style={{position:"absolute",top:0,bottom:0,left:statsWidth-3,width:7,cursor:"col-resize",zIndex:32}}/>
        )}

        {/* Collapse handle for the stats column — same reasoning, hidden on Dashboard */}
        {view!=="dashboard"&&(
          <button className="bhq-iconbtn" onClick={()=>setStatsOpen(o=>!o)} title={statsOpen?"Hide stats":"Show stats"}
            style={{position:"absolute",top:"50%",left:(statsOpen?statsWidth:0)-9,transform:"translateY(-50%)",width:18,height:18,borderRadius:"50%",background:T.surface,border:`1px solid ${T.border}`,padding:0,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:T.textSub,fontWeight:700,fontSize:9,lineHeight:1,zIndex:40,boxShadow:T.shadow,transition:statsResizing.current?"none":"left 0.15s, background 0.12s"}}>
            {statsOpen?"‹":"›"}
          </button>
        )}
      </>)}

      {/* ── MAIN ── */}
      <main style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>

      {notif&&<div style={{position:"fixed",bottom:20,right:20,background:T.success,color:"#fff",padding:"10px 16px",borderRadius:8,fontSize:13,fontWeight:600,zIndex:100,boxShadow:T.shadowMd,fontFamily:"'DM Sans',sans-serif"}}>{notif}</div>}

      {/* ── UPLOAD ── (moved 2026-07-24 from view==="tagger" to its own view==="data" — see NAV) */}
      {step==="upload"&&view==="data"&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"auto"}}>
          {/* Shared inline forms — connect-panel / oauth-picker / Google Sheets panel. Rendered once
              here (not per-subview) since both the Connections table's ⋯ menu AND the Add data
              source grid's Connect actions below key off this same connectPanelKey/oauthPicker/
              gsheetSpendOpen state, whichever subview happens to be active when they're triggered. */}
          {(connectPanelKey||oauthPicker||gsheetSpendOpen)&&(
            <div style={{padding:"14px 24px 0",background:T.surface,borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
              {connectPanelKey&&(()=>{
                const pl=PLATFORMS.find(p=>p.key===connectPanelKey);
                if(!pl)return null;
                // "keyvaluelist" fields (Capterra's one-key-per-product list) render two inputs
                // per row side by side, so they need more breathing room than the standard
                // single-input connect panels — widen it just for those.
                const hasPairField=(pl.connectFields||[]).some(f=>f.type==="keyvaluelist");
                return(
                  <div style={{marginBottom:14,padding:"12px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:8,maxWidth:hasPairField?560:420}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <div style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>Connect {pl.label}</div>
                      <span onClick={()=>setConnectPanelKey(null)} style={{fontSize:12,color:T.textMuted,cursor:"pointer"}}>✕</span>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
                      {(pl.connectFields||[]).map(f=>{
                        if(f.type==="keyvaluelist"){
                          const rows=pairRowsFor(f.key);
                          return(
                            <div key={f.key}>
                              {f.label&&<div style={{fontSize:11,fontWeight:600,color:T.textMuted,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>{f.label}</div>}
                              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                                {rows.map((row,idx)=>(
                                  <div key={idx} style={{display:"flex",gap:5,alignItems:"center"}}>
                                    <input value={row.label} placeholder={f.pairLabelPlaceholder}
                                      onChange={e=>setPairRow(f.key,idx,{label:e.target.value})}
                                      onPaste={e=>handlePairPaste(f.key,e)}
                                      style={{flex:"1 1 45%",minWidth:0,boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 9px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                                    <input value={row.value} placeholder={f.pairValuePlaceholder}
                                      onChange={e=>setPairRow(f.key,idx,{value:e.target.value})}
                                      onPaste={e=>handlePairPaste(f.key,e)}
                                      style={{flex:"1 1 45%",minWidth:0,boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 9px",fontSize:12,outline:"none",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}/>
                                    <span onClick={()=>removePairRow(f.key,idx)} title="Remove this row" style={{fontSize:13,color:T.textMuted,cursor:"pointer",padding:"0 2px",flexShrink:0}}>✕</span>
                                  </div>
                                ))}
                              </div>
                              <span onClick={()=>addPairRow(f.key)} style={{display:"inline-block",marginTop:6,fontSize:11,fontWeight:600,color:T.accent,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>+ Add another {f.pairLabelName?.toLowerCase()||"row"}</span>
                              <div style={{fontSize:11,color:T.textMuted,marginTop:5,fontFamily:"'DM Sans',sans-serif"}}>Tip: paste a whole "{f.pairLabelName||"name"}: {f.pairValueName||"key"}" list into any {f.pairLabelName?.toLowerCase()||"name"} box to fill every row at once.</div>
                            </div>
                          );
                        }
                        const val=connectValues[f.key]||"";
                        return(
                          <div key={f.key}>
                            <input value={val} placeholder={f.placeholder}
                              onChange={e=>setConnectValues(v=>({...v,[f.key]:e.target.value}))}
                              style={{width:"100%",boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 9px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                          </div>
                        );
                      })}
                    </div>
                    {connectError&&<div style={{fontSize:11,color:T.danger,marginBottom:8}}>{connectError}</div>}
                    <Btn onClick={()=>saveConnection(pl.key)}
                      disabled={connectSaving||(pl.connectFields||[]).some(f=>{
                        if(f.type==="keyvaluelist")return !pairRowsFor(f.key).some(r=>r.label.trim()&&r.value.trim());
                        return !f.key.endsWith("Accounts")&&!(connectValues[f.key]||"").trim();
                      })}
                      variant="primary" size="sm" T={T}>{connectSaving?"Connecting…":"Connect"}</Btn>
                  </div>
                );
              })()}
              {oauthPicker&&(
                <div style={{marginBottom:14,padding:"12px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:8,maxWidth:420}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>Which {OAUTH_PROVIDER_LABELS[oauthPicker.provider]||oauthPicker.provider} account?</div>
                    <span onClick={()=>{setOauthPicker(null);setOauthManualId("");setOauthManualName("");setOauthManualLoginCustomerId("");}} style={{fontSize:12,color:T.textMuted,cursor:"pointer"}}>✕</span>
                  </div>
                  {oauthPicker.accounts.length===0?(
                    <div>
                      <div style={{fontSize:11,color:T.textMuted,marginBottom:10,lineHeight:1.5}}>
                        {oauthPicker.provider==="google"
                          ?"Couldn't auto-discover accounts — this happens when your Google login only has access via a manager (MCC) account rather than directly on the ad account itself. Paste the Customer ID instead (top-right corner of the Google Ads UI, format 123-456-7890)."
                          :"Connected, but couldn't load your accounts. Try Sync — if it fails, reconnect."}
                      </div>
                      {oauthPicker.provider==="google"&&(
                        <div style={{display:"flex",flexDirection:"column",gap:6}}>
                          <input value={oauthManualId} onChange={e=>setOauthManualId(e.target.value)} placeholder="Customer ID, e.g. 123-456-7890"
                            style={{width:"100%",boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 9px",fontSize:12,outline:"none",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}/>
                          <input value={oauthManualLoginCustomerId} onChange={e=>setOauthManualLoginCustomerId(e.target.value)} placeholder="Manager account ID (only if accessed via an MCC — leave blank otherwise)"
                            style={{width:"100%",boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 9px",fontSize:12,outline:"none",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}/>
                          <input value={oauthManualName} onChange={e=>setOauthManualName(e.target.value)} placeholder="Account name (optional, for display only)"
                            style={{width:"100%",boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 9px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                          <div style={{fontSize:10,color:T.textMuted,lineHeight:1.4}}>Getting "PERMISSION_DENIED" on sync after entering just the Customer ID above? You're almost certainly reaching this account through a manager account — switch into that manager account in the Google Ads UI, copy ITS Customer ID (top-right corner), and paste it here too.</div>
                          <Btn T={T} variant="primary" size="sm"
                            disabled={oauthPickerSaving||!oauthManualId.replace(/[^0-9]/g,"").trim()}
                            onClick={()=>{
                              const digitsOnly=oauthManualId.replace(/[^0-9]/g,"");
                              const managerDigitsOnly=oauthManualLoginCustomerId.replace(/[^0-9]/g,"");
                              finalizeOAuthAccount("google",digitsOnly,null,oauthManualName.trim()||null,managerDigitsOnly||null);
                              setOauthManualId("");setOauthManualName("");setOauthManualLoginCustomerId("");
                            }}
                            style={{width:"100%"}}>{oauthPickerSaving?"Saving…":"Use this account"}</Btn>
                        </div>
                      )}
                    </div>
                  ):(
                    <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      {oauthPicker.accounts.map(a=>(
                        <button key={a.id} disabled={oauthPickerSaving} onClick={()=>finalizeOAuthAccount(oauthPicker.provider,a.id,a.customerId,a.name)}
                          style={{textAlign:"left",padding:"7px 10px",borderRadius:6,
                            border:`1px solid ${a.id===oauthPicker.selectedAccountId?T.accentBorder:T.border}`,
                            background:a.id===oauthPicker.selectedAccountId?T.accentBg:T.surface,
                            color:T.text,cursor:oauthPickerSaving?"default":"pointer",fontSize:12,fontFamily:"'DM Sans',sans-serif",opacity:oauthPickerSaving?0.6:1}}>
                          {a.name} <span style={{color:T.textMuted,fontSize:10}}>({a.id})</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {gsheetSpendOpen&&(
                <div style={{marginBottom:14,padding:"12px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:8,maxWidth:420}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>Pull spend from Google Sheets</div>
                    <span onClick={()=>setGsheetSpendOpen(false)} style={{fontSize:12,color:T.textMuted,cursor:"pointer"}}>✕</span>
                  </div>
                  {gsSpend.tabs?.length>1?(
                    <div>
                      <div style={{fontSize:11,color:T.textSub,marginBottom:6}}>Which tab has the spend data?</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
                        {gsSpend.tabs.map(t=>(
                          <button key={t.sheetId} disabled={gsSpend.fetching} onClick={()=>gsSpend.fetchTab(gsSpend.spreadsheetId,t.title)}
                            style={{padding:"4px 9px",borderRadius:6,border:`1px solid ${T.border}`,background:T.surface,color:T.text,cursor:gsSpend.fetching?"default":"pointer",fontSize:11,fontFamily:"'DM Sans',sans-serif",opacity:gsSpend.fetching?0.6:1}}>{t.title}</button>
                        ))}
                      </div>
                    </div>
                  ):(
                    <Btn onClick={gsSpend.openPicker} disabled={gsSpend.fetching} variant="primary" size="sm" T={T}>{gsSpend.fetching?"Connecting…":"Choose from Google Drive"}</Btn>
                  )}
                  {gsSpend.error&&(
                    <div style={{marginTop:8,fontSize:11,color:T.danger}}>
                      {gsSpend.error}
                      {/(permission|forbidden|403)/i.test(gsSpend.error)&&(
                        <>{" "}<span onClick={gsSpend.retryWithNewAccount} style={{color:T.accent,cursor:"pointer",fontWeight:600,textDecoration:"underline"}}>Try a different Google account</span></>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Hidden file inputs for the manual-import cards on the Add data source grid — kept
              mounted here rather than per-card so fileRef/screenshotRef stay valid no matter which
              card (or which subview) triggers them. */}
          <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
          <input ref={screenshotRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>handleScreenshotFile(e.target.files[0])}/>

          {dataSourcesSubView==="add"?(
            /* ── ADD DATA SOURCE ── (2026-07-24, modeled on Funnel.io's "Connect data source" page
                per Mo — he's planning to add more connectors over time and wants a dedicated,
                searchable page for browsing/adding them, separate from the table that manages
                what's already connected. CSV/Screenshot/Budget file are cards here too, alongside
                the live connectors, per his call when scoping this.) */
            <div style={{flex:1,padding:isMobile?16:"24px 32px",overflow:"auto"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,fontSize:12,fontFamily:"'DM Sans',sans-serif"}}>
                <span onClick={()=>setDataSourcesSubView("connections")} style={{color:T.accent,cursor:"pointer",fontWeight:600}}>Data Sources</span>
                <span style={{color:T.textMuted}}>/</span>
                <span style={{color:T.textSub}}>Add data source</span>
              </div>
              <h1 style={{fontSize:isMobile?20:24,fontWeight:700,color:T.text,letterSpacing:"-0.4px",margin:"6px 0 14px"}}>Add data source</h1>
              <input value={dataSourceSearch} onChange={e=>setDataSourceSearch(e.target.value)} placeholder="Search data sources…"
                style={{width:"100%",maxWidth:360,boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,padding:"8px 12px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif",marginBottom:20}}/>
              {(()=>{
                const cards=[
                  ...PLATFORMS.map(pl=>{
                    const conn=pl.perWorkspaceAuth?connectionDetails.find(c=>c.provider===pl.key):null;
                    const isConnected=!!conn;
                    const warn=isConnected&&(conn.needsReconnect||conn.needsAccountSelection);
                    let actionLabel,onAction;
                    if(pl.isSheets){actionLabel="Connect now";onAction=()=>setGsheetSpendOpen(true);}
                    else if(pl.status==="csv"){actionLabel="Upload CSV";onAction=()=>fileRef.current?.click();}
                    else if(isConnected&&conn.needsReconnect){actionLabel="Reconnect";onAction=()=>startProviderOAuth(pl.key);}
                    else if(isConnected&&conn.needsAccountSelection){actionLabel="Pick account";onAction=()=>openAccountPicker(pl.key);}
                    else if(isConnected){actionLabel="✓ Connected";onAction=()=>setDataSourcesSubView("connections");}
                    else if(pl.oauth){actionLabel="Connect now";onAction=()=>startProviderOAuth(pl.key);}
                    else{actionLabel="Connect now";onAction=()=>openConnectPanel(pl.key);}
                    return{key:pl.key,label:pl.label,desc:pl.desc,color:pl.color,domain:pl.domain,mark:pl.mark,isConnected,warn,actionLabel,onAction};
                  }),
                  {key:"_csv",label:"Spend Data CSV",desc:"Any spend CSV — Google Ads, LinkedIn, Meta, Bing, Capterra exports all work",color:T.textMuted,mark:CsvMark,actionLabel:"Upload CSV",onAction:()=>fileRef.current?.click()},
                  {key:"_screenshot",label:"Screenshot",desc:"Share a screenshot of a spend report — AI reads it into data",color:T.textMuted,mark:ScreenshotMark,actionLabel:"Upload image",onAction:()=>!screenshotProcessing&&screenshotRef.current?.click()},
                  {key:"_budget",label:"Budget file",desc:"Excel or CSV budget spreadsheet — AI maps your columns",color:T.textMuted,mark:BudgetFileMark,actionLabel:"Go to Budgets →",onAction:()=>setView("budget")},
                ].filter(c=>c.label.toLowerCase().includes(dataSourceSearch.trim().toLowerCase()));
                return(
                  <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(230px,1fr))",gap:14}}>
                    {cards.map(c=>{
                      // CSV/Screenshot cards double as drop targets — same handleDrop/
                      // handleScreenshotDrop the old upload zone used, so dragging a file straight
                      // onto the card works exactly like clicking it and picking one.
                      const isDropTarget=c.key==="_csv"||c.key==="_screenshot";
                      const dropProps=isDropTarget?{
                        onDragOver:e=>{e.preventDefault();setDragOver(true);},
                        onDragLeave:()=>setDragOver(false),
                        onDrop:c.key==="_csv"?handleDrop:handleScreenshotDrop,
                      }:{};
                      return(
                      <div key={c.key} onClick={c.onAction} className="bhq-row" {...dropProps}
                        style={{border:`1px solid ${isDropTarget&&dragOver?T.accent:T.border}`,borderRadius:10,background:isDropTarget&&dragOver?T.accentBg:T.surface,padding:"16px",cursor:"pointer",transition:"all 0.15s"}}>
                        <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:10}}>
                          <PlatformLogo domain={c.domain} color={c.color} mark={c.mark}/>
                          <span style={{fontSize:13,fontWeight:700,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>{c.label}</span>
                          {c.isConnected&&!c.warn&&<Pill color={T.success} bg={T.successBg} border={T.successBorder} style={{fontSize:9}}>Connected</Pill>}
                          {c.warn&&<Pill color={T.warning} bg={T.warningBg} border={T.warningBorder} style={{fontSize:9}}>Needs attention</Pill>}
                        </div>
                        <div style={{fontSize:12,color:T.textMuted,lineHeight:1.5,marginBottom:c.key==="_screenshot"&&screenshotError?6:14,minHeight:32}}>{c.desc}</div>
                        {c.key==="_screenshot"&&screenshotError&&<div style={{fontSize:11,color:T.danger,marginBottom:8}}>{screenshotError}</div>}
                        <div style={{fontSize:12,fontWeight:600,color:T.accent}}>{c.key==="_screenshot"&&screenshotProcessing?"Reading screenshot…":`${c.actionLabel} →`}</div>
                      </div>
                      );
                    })}
                    {cards.length===0&&(
                      <div style={{gridColumn:"1/-1",fontSize:13,color:T.textMuted,fontFamily:"'DM Sans',sans-serif",padding:"20px 0"}}>No data sources match "{dataSourceSearch}".</div>
                    )}
                  </div>
                );
              })()}
            </div>
          ):(
            /* ── CONNECTIONS ── (default landing — table of already-connected sources only; browsing/
                adding new ones now happens on the "add" subview above) */
            <div style={{padding:"16px 24px",background:T.surface,flexShrink:0}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4,flexWrap:"wrap",gap:10}}>
                <SectionLabel T={T} style={{marginBottom:0}}>Connections</SectionLabel>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{position:"relative"}}>
                    <button onClick={()=>setSyncRangePickerOpen(o=>!o)}
                      style={{display:"flex",alignItems:"center",gap:6,padding:"4px 9px",borderRadius:6,border:`1px solid ${T.border}`,background:T.inputBg,color:T.text,cursor:"pointer",fontSize:11,fontFamily:"'DM Sans',sans-serif"}}>
                      <span style={{color:T.textMuted}}>Range:</span> {syncDateRange.start} → {syncDateRange.end}
                    </button>
                    {syncRangePickerOpen&&(
                      <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,zIndex:50,width:340,padding:"12px 14px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd}}>
                        <div style={{display:"flex",gap:14,marginBottom:12,borderBottom:`1px solid ${T.border}`}}>
                          {["recommended","custom"].map(tab=>(
                            <span key={tab} onClick={()=>setSyncRangeTab(tab)}
                              style={{fontSize:12,fontWeight:600,paddingBottom:8,cursor:"pointer",color:syncRangeTab===tab?T.accent:T.textMuted,borderBottom:syncRangeTab===tab?`2px solid ${T.accent}`:"2px solid transparent",textTransform:"capitalize",fontFamily:"'DM Sans',sans-serif"}}>{tab}</span>
                          ))}
                        </div>
                        {syncRangeTab==="recommended"?(
                          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                            {SYNC_RANGE_PRESETS.map(p=>(
                              <button key={p.label} onClick={()=>applySyncRangePreset(p)}
                                style={{padding:"5px 10px",borderRadius:20,border:`1px solid ${T.border}`,background:T.surfaceEl,color:T.text,cursor:"pointer",fontSize:11,fontFamily:"'DM Sans',sans-serif"}}>{p.label}</button>
                            ))}
                          </div>
                        ):(
                          <div>
                            <div style={{fontSize:11,color:T.textMuted,marginBottom:8,fontFamily:"'DM Sans',sans-serif"}}>Pick an exact start and end date — useful for redoing a specific past window a preset doesn't cover.</div>
                            <div style={{display:"flex",gap:6,alignItems:"center"}}>
                              <input type="date" value={syncDateRange.start} onChange={e=>setSyncDateRange(p=>({...p,start:e.target.value}))}
                                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:5,color:T.text,padding:"5px 7px",fontSize:11,outline:"none"}}/>
                              <span style={{fontSize:11,color:T.textMuted}}>→</span>
                              <input type="date" value={syncDateRange.end} max={localISODate(new Date())}
                                title="Can't pull spend data for dates that haven't happened yet"
                                onChange={e=>{
                                  const todayStr=localISODate(new Date());
                                  setSyncDateRange(p=>({...p,end:e.target.value>todayStr?todayStr:e.target.value}));
                                }}
                                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:5,color:T.text,padding:"5px 7px",fontSize:11,outline:"none"}}/>
                            </div>
                            <Btn onClick={()=>setSyncRangePickerOpen(false)} variant="primary" size="sm" T={T} style={{marginTop:10}}>Done</Btn>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <Btn onClick={()=>setDataSourcesSubView("add")} variant="primary" size="sm" T={T}>
                    <Icon name="plus" size={12} color={T.onAccent}/> Add data source
                  </Btn>
                </div>
              </div>
              <div style={{fontSize:12,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",maxWidth:620,marginBottom:10}}>
                Every ad account this workspace pulls live spend from — see who connected each one, when it last imported, and manage it from the ⋯ menu.
              </div>
              {Object.entries(syncState).filter(([,s])=>s.startsWith("error:")).map(([k,s])=>(
                <div key={k} style={{marginBottom:6,fontSize:11,color:T.danger}}>{k}: {s.replace("error:","")}</div>
              ))}
              {(()=>{
                const GRID="150px minmax(140px,1.4fr) minmax(140px,1fr) 130px 96px 100px 92px 92px 32px";
                const connectedPlatforms=PLATFORMS.filter(pl=>pl.perWorkspaceAuth&&connectionDetails.find(c=>c.provider===pl.key));
                if(connectedPlatforms.length===0){
                  return(
                    <div style={{border:`1px dashed ${T.borderStrong}`,borderRadius:10,padding:"28px 20px",textAlign:"center",backgroundColor:T.surfaceEl}}>
                      {/* Lunar-rover illustration (2026-07-26, per Mo, licensed "Geometric Space
                          Collection" set, background stripped) — a rover goes out and gathers data,
                          same job this empty state is asking the user to do for the first time. */}
                      <img src={lunarRoverIcon} alt="" aria-hidden="true" style={{width:120,height:"auto",marginBottom:10}}/>
                      <div style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:"'DM Sans',sans-serif",marginBottom:4}}>No data sources connected yet</div>
                      <div style={{fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif",marginBottom:14}}>Connect LinkedIn, Bing, Funnel.io and more — or upload a CSV/screenshot directly.</div>
                      <Btn onClick={()=>setDataSourcesSubView("add")} variant="primary" size="sm" T={T}>+ Add data source</Btn>
                    </div>
                  );
                }
                return(
                <div style={{border:`1px solid ${T.border}`,borderRadius:8,overflow:"hidden"}}>
                  {!isMobile&&(
                    <div style={{display:"grid",gridTemplateColumns:GRID,gap:8,padding:"7px 10px",background:T.headerBg,borderBottom:`1px solid ${T.border}`}}>
                      {["Connector","Data source name","Credentials","Status","Sync","Connected","Import start","Import end",""].map(h=>(
                        <SectionLabel key={h} T={T} style={{marginBottom:0,fontSize:13,fontWeight:700,color:T.text,textAlign:"center"}}>{h}</SectionLabel>
                      ))}
                    </div>
                  )}
                  {connectedPlatforms.map((pl,i)=>{
                    const conn=connectionDetails.find(c=>c.provider===pl.key);
                    const connectedByEmail=conn.connectedBy?(teamMembers.find(m=>m.userId===conn.connectedBy)?.email||conn.connectedBy):null;
                    const summary=conn.summary||{};
                    const summaryText=
                      pl.oauth?(summary.accountName?`${summary.accountName} (${summary.accountId||"—"})`:(summary.accountId||"No account selected yet")):
                      pl.key==="funnel"?(summary.accountId?`Account ${summary.accountId}${summary.projectId?` · Project ${summary.projectId}`:""}`:"—"):
                      pl.key==="supermetrics"?(summary.dsId?`${summary.dsId}${summary.dsAccounts?` · ${summary.dsAccounts}`:""}`:"—"):
                      pl.key==="capterra"?(summary.products?.length?summary.products.join(", "):"—"):
                      "—";
                    const statusLabel=conn.needsReconnect?"Reconnect needed":conn.needsAccountSelection?"Pick account":conn.paused?"Paused":"Connected";
                    const warn=conn.needsReconnect||conn.needsAccountSelection;
                    const statusColor=warn?T.warning:conn.paused?T.textMuted:T.success;
                    const statusBg=warn?T.warningBg:conn.paused?T.surfaceEl:T.successBg;
                    const statusBorder=warn?T.warningBorder:conn.paused?T.border:T.successBorder;
                    // Sync frequency (2026-07-25, per Mo) — shared by both the desktop grid column
                    // and the mobile card below, so "is this on rolling sync or still manual" is
                    // answerable at a glance instead of needing the ⋯ menu opened per connector.
                    const syncRolling=conn.syncMode==="rolling";
                    const syncFailed=syncRolling&&conn.lastAutoSyncStatus==="error";
                    const syncLabel=syncRolling?(conn.syncFrequency==="weekly"?"Weekly":"Daily"):"Manual";
                    const syncColor=syncFailed?T.danger:syncRolling?T.accent:T.textMuted;
                    const syncBg=syncFailed?T.dangerBg:syncRolling?T.accentBg:T.surfaceEl;
                    const syncBorder=syncFailed?T.dangerBorder:syncRolling?T.accentBorder:T.border;
                    const syncTitle=syncRolling?`Rolling sync — ${syncLabel.toLowerCase()}, last ${conn.rollingWindowDays||14} days. Set from the ⋯ menu's Sync schedule.`:"Manual only — data only updates when someone clicks Sync now, or from the ⋯ menu's Sync schedule.";
                    const importRange=importDateRangeByProvider[pl.key];
                    const fmtShort=d=>d?new Date(d).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}):"—";
                    const menuOpen=connActionsMenuProvider===pl.key;
                    const syncing=(syncState[pl.key]||"idle")==="loading";
                    const saving=savingConnectionFlag===pl.key||disconnectingProvider===pl.key||syncing;
                    const cell=(content,extra)=><div style={{fontSize:13,color:T.textSub,fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"flex",alignItems:"center",...extra}}>{content}</div>;
                    const actionsMenu=menuOpen&&connActionsMenuAnchorRect&&createPortal(
                      <>
                        <div onClick={closeConnActionsMenu} style={{position:"fixed",inset:0,zIndex:999}}/>
                        <div style={{position:"fixed",top:connActionsMenuAnchorRect.bottom+6,left:Math.max(8,connActionsMenuAnchorRect.right-220),zIndex:1000,minWidth:220,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd,padding:6,display:"flex",flexDirection:"column"}}>
                          {!conn.paused&&!conn.needsReconnect&&!conn.needsAccountSelection&&(
                            <button onClick={()=>{closeConnActionsMenu();syncPlatform(pl.key);}} disabled={!canEdit||syncing} className="bhq-row" style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:canEdit&&!syncing?"pointer":"default",fontFamily:"'DM Sans',sans-serif",textAlign:"left",opacity:canEdit&&!syncing?1:0.5}}>{syncing?"Syncing…":"Sync now"}</button>
                          )}
                          {conn.needsAccountSelection&&(
                            <button onClick={()=>{closeConnActionsMenu();openAccountPicker(pl.key);}} disabled={!canEdit} className="bhq-row" style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:canEdit?"pointer":"default",fontFamily:"'DM Sans',sans-serif",textAlign:"left",opacity:canEdit?1:0.5}}>Pick account</button>
                          )}
                          {conn.needsReconnect&&(
                            <button onClick={()=>{closeConnActionsMenu();startProviderOAuth(pl.key);}} disabled={!canEdit} className="bhq-row" style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:canEdit?"pointer":"default",fontFamily:"'DM Sans',sans-serif",textAlign:"left",opacity:canEdit?1:0.5}}>Reconnect</button>
                          )}
                          {!conn.needsAccountSelection&&!conn.needsReconnect&&(
                            <button onClick={()=>{closeConnActionsMenu();pl.oauth?openAccountPicker(pl.key):openConnectPanel(pl.key);}} disabled={!canEdit} className="bhq-row" style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:canEdit?"pointer":"default",fontFamily:"'DM Sans',sans-serif",textAlign:"left",opacity:canEdit?1:0.5}}>{pl.oauth?"Switch account":"Edit connection"}</button>
                          )}
                          {!warn&&(
                            <div style={{padding:"6px 10px 4px"}} onClick={e=>e.stopPropagation()}>
                              <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.textMuted,marginBottom:5}}>Sync schedule</div>
                              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                                <Sel value={conn.syncMode==="rolling"?conn.syncFrequency:"manual"} T={T} style={{fontSize:11,padding:"4px 7px"}}
                                  onChange={v=>{if(!canEdit||savingSchedule===pl.key)return;v==="manual"
                                    ?updateSyncSchedule(pl.key,{syncMode:"manual"})
                                    :updateSyncSchedule(pl.key,{syncMode:"rolling",syncFrequency:v,rollingWindowDays:conn.rollingWindowDays||14});}}>
                                  <option value="manual">Manual only</option>
                                  <option value="daily">Daily</option>
                                  <option value="weekly">Weekly</option>
                                </Sel>
                                {conn.syncMode==="rolling"&&(
                                  <Sel value={String(conn.rollingWindowDays||14)} T={T} style={{fontSize:11,padding:"4px 7px"}}
                                    onChange={v=>{if(!canEdit||savingSchedule===pl.key)return;updateSyncSchedule(pl.key,{syncMode:"rolling",syncFrequency:conn.syncFrequency,rollingWindowDays:Number(v)});}}>
                                    <option value="7">Last 7 days</option>
                                    <option value="14">Last 14 days</option>
                                    <option value="30">Last 30 days</option>
                                    <option value="60">Last 60 days</option>
                                    <option value="90">Last 90 days</option>
                                  </Sel>
                                )}
                              </div>
                              {conn.syncMode==="rolling"&&conn.lastAutoSyncAt&&(
                                <div style={{fontSize:10,color:conn.lastAutoSyncStatus==="error"?T.danger:T.textMuted,fontFamily:"'DM Sans',sans-serif",marginTop:5}}>
                                  {conn.lastAutoSyncStatus==="error"
                                    ?`Auto-sync failed ${new Date(conn.lastAutoSyncAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}: ${conn.lastAutoSyncError||"unknown error"}`
                                    :`Auto-synced ${new Date(conn.lastAutoSyncAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}`}
                                </div>
                              )}
                            </div>
                          )}
                          <div style={{height:1,background:T.border,margin:"4px 2px"}}/>
                          <button onClick={()=>{closeConnActionsMenu();updateConnectionFlags(pl.key,{paused:!conn.paused});}} disabled={!canEdit||saving} className="bhq-row" style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:canEdit&&!saving?"pointer":"default",fontFamily:"'DM Sans',sans-serif",textAlign:"left",opacity:canEdit&&!saving?1:0.5}}>{conn.paused?"Resume import":"Pause import"}</button>
                          <button onClick={()=>{closeConnActionsMenu();updateConnectionFlags(pl.key,{excludedFromData:!conn.excludedFromData});}} disabled={!canEdit||saving} className="bhq-row" style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:canEdit&&!saving?"pointer":"default",fontFamily:"'DM Sans',sans-serif",textAlign:"left",opacity:canEdit&&!saving?1:0.5}}>{conn.excludedFromData?"Use this data in BudgetHQ":"Don't use this data in BudgetHQ"}</button>
                          <div style={{height:1,background:T.border,margin:"4px 2px"}}/>
                          <button onClick={()=>{closeConnActionsMenu();disconnectConnection(pl.key);}} disabled={!canEdit||saving} className="bhq-row" style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.danger,fontSize:13,cursor:canEdit&&!saving?"pointer":"default",fontFamily:"'DM Sans',sans-serif",textAlign:"left",opacity:canEdit&&!saving?1:0.5}}>Disconnect</button>
                        </div>
                      </>,
                      document.body
                    );
                    const dotsButton=(
                      <div style={{position:"relative",display:"flex",justifyContent:"flex-end"}}>
                        <button onClick={e=>{
                            if(menuOpen){closeConnActionsMenu();return;}
                            setConnActionsMenuAnchorRect(e.currentTarget.getBoundingClientRect());
                            setConnActionsMenuProvider(pl.key);
                          }} title="Actions" disabled={saving}
                          style={{width:24,height:24,borderRadius:6,background:menuOpen?T.surfaceHover:"transparent",border:`1px solid ${T.border}`,cursor:saving?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",opacity:saving?0.5:1,fontSize:13,color:T.textSub,fontFamily:"'DM Sans',sans-serif",lineHeight:1}}>⋯</button>
                        {actionsMenu}
                      </div>
                    );
                    if(isMobile){
                      return(
                        <div key={pl.key} style={{padding:"11px 10px",borderTop:i>0?`1px solid ${T.border}`:"none"}}>
                          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:4}}>
                            <div style={{display:"flex",alignItems:"center",gap:7,minWidth:0}}>
                              <PlatformLogo domain={pl.domain} color={pl.color} mark={pl.mark} size={18}/>
                              <span style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>{pl.label}</span>
                              <Pill color={statusColor} bg={statusBg} border={statusBorder} style={{fontSize:10}}>{statusLabel}</Pill>
                              <Pill color={syncColor} bg={syncBg} border={syncBorder} style={{fontSize:10}} title={syncTitle}>{syncLabel}</Pill>
                              {syncFailed&&(
                                <WarnTip T={T} text={`Auto-sync failed ${conn.lastAutoSyncAt?new Date(conn.lastAutoSyncAt).toLocaleDateString(undefined,{month:"short",day:"numeric"}):"recently"}: ${conn.lastAutoSyncError||"unknown error"}`}/>
                              )}
                            </div>
                            {dotsButton}
                          </div>
                          <div style={{fontSize:13,color:T.textSub,fontFamily:"'DM Sans',sans-serif"}}>{summaryText}</div>
                          <div style={{fontSize:13,color:T.textMuted,fontFamily:"'DM Sans',sans-serif",marginTop:3}}>
                            {connectedByEmail||"—"} · connected {fmtShort(conn.connectedAt)} · imported {fmtShort(importRange?.start)}–{fmtShort(importRange?.end)}
                          </div>
                        </div>
                      );
                    }
                    return(
                      <div key={pl.key} style={{display:"grid",gridTemplateColumns:GRID,gap:8,padding:"9px 10px",alignItems:"center",borderTop:i>0?`1px solid ${T.border}`:"none"}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,minWidth:0}}>
                          <PlatformLogo domain={pl.domain} color={pl.color} mark={pl.mark} size={18}/>
                          <span style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{pl.label}</span>
                        </div>
                        {cell(summaryText,{color:T.text})}
                        {cell(connectedByEmail||"—")}
                        <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                          <Pill color={statusColor} bg={statusBg} border={statusBorder} style={{fontSize:10}}>{statusLabel}</Pill>
                          {conn.excludedFromData&&<Pill color={T.textMuted} bg={T.surfaceEl} border={T.border} style={{fontSize:10}}>Hidden</Pill>}
                        </div>
                        {/* Sync frequency column (2026-07-25, per Mo — this was previously only
                            visible by opening the ⋯ menu's "Sync schedule" section, which meant the
                            "is this actually on rolling sync or still just manual" question needed
                            a click per connector to answer, and was the direct cause of confusion
                            around item 41's cron fix (rolling sync being off by default read as
                            "the cron still isn't working" until the ⋯ menu was checked). Manual
                            (the default for every connector until someone opts in) reads as a muted
                            neutral pill, matching "Paused"'s treatment elsewhere — it's not an
                            error state, just the default. Daily/Weekly on rolling sync gets the
                            same accent treatment as "Connected" in the Status column. A failed
                            auto-sync (lastAutoSyncStatus==="error") overrides to a danger pill with
                            a WarnTip carrying the actual error message and date, same copy already
                            used in the ⋯ menu's own failure note. */}
                        <div style={{display:"flex",alignItems:"center",gap:4}}>
                          <Pill color={syncColor} bg={syncBg} border={syncBorder} style={{fontSize:10}} title={syncTitle}>{syncLabel}</Pill>
                          {syncFailed&&(
                            <WarnTip T={T} text={`Auto-sync failed ${conn.lastAutoSyncAt?new Date(conn.lastAutoSyncAt).toLocaleDateString(undefined,{month:"short",day:"numeric"}):"recently"}: ${conn.lastAutoSyncError||"unknown error"}`}/>
                          )}
                        </div>
                        {cell(fmtShort(conn.connectedAt))}
                        {cell(fmtShort(importRange?.start))}
                        {cell(fmtShort(importRange?.end))}
                        {dotsButton}
                      </div>
                    );
                  })}
                </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* ── SCREENSHOT PREVIEW ── */}
      {step==="screenshot"&&(
        <div style={{flex:1,overflow:"auto"}}>
          <div style={{maxWidth:720,margin:"0 auto",padding:isMobile?"16px":"32px 24px"}}>
            <div style={{marginBottom:22}}>
              <h2 style={{fontSize:20,fontWeight:700,color:T.text,letterSpacing:"-0.3px",marginBottom:4}}>Review extracted data</h2>
              <p style={{fontSize:13,color:T.textSub}}><strong style={{color:T.text,fontWeight:600}}>{screenshotFileName}</strong> · {screenshotPreview.length.toLocaleString()} rows found — check these against the screenshot before adding.</p>
            </div>
            <PixelPanel T={T} style={{marginBottom:18}} contentStyle={{background:T.surface,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 90px 90px 90px",padding:"8px 16px",borderBottom:`1px solid ${T.border}`,background:T.headerBg}}>
                <SectionLabel T={T} style={{marginBottom:0}}>Campaign</SectionLabel>
                <SectionLabel T={T} style={{marginBottom:0}}>Ad Set / Group</SectionLabel>
                <SectionLabel T={T} style={{marginBottom:0}}>Platform</SectionLabel>
                <SectionLabel T={T} style={{marginBottom:0}}>Date</SectionLabel>
                <SectionLabel T={T} style={{marginBottom:0}}>Spend</SectionLabel>
              </div>
              <div style={{maxHeight:420,overflow:"auto"}}>
                {screenshotPreview.map((r,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 90px 90px 90px",padding:"7px 16px",borderBottom:`1px solid ${T.border}`,alignItems:"center",gap:4}}>
                    <div style={{fontSize:11,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.campaign_group_name}</div>
                    <div style={{fontSize:11,color:T.textSub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.campaign_name}</div>
                    <div style={{fontSize:11,color:T.textSub}}>{r.platform}</div>
                    <div style={{fontSize:11,color:T.textSub}}>{r.date}</div>
                    <div style={{fontSize:12,fontWeight:600,color:T.text}}>{fmt$(r.spend)}</div>
                  </div>
                ))}
              </div>
            </PixelPanel>
            <div style={{padding:"10px 14px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:8,marginBottom:14,fontSize:13,color:T.success,fontWeight:500}}>
              ✓ <strong>{screenshotPreview.length}</strong> rows · <strong>{fmt$(screenshotPreview.reduce((s,r)=>s+r.spend,0))}</strong> total spend — this was read by AI and may contain mistakes, double-check against the source before confirming.
            </div>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <Btn onClick={()=>{setScreenshotPreview([]);setScreenshotFileName("");setStep("upload");}} variant="ghost" T={T}>← Cancel</Btn>
              <Btn onClick={confirmScreenshotImport} variant="primary" T={T} size="md">Add {screenshotPreview.length} rows →</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── MAP ── */}
      {step==="map"&&(
        <div style={{flex:1,overflow:"auto"}}>
          <div style={{maxWidth:660,margin:"0 auto",padding:isMobile?"16px":"32px 24px"}}>
            <div style={{marginBottom:22}}>
              <h2 style={{fontSize:20,fontWeight:700,color:T.text,letterSpacing:"-0.3px",marginBottom:4}}>Map your columns</h2>
              <p style={{fontSize:13,color:T.textSub}}><strong style={{color:T.text,fontWeight:600}}>{fileName}</strong> · {rawRows.length.toLocaleString()} rows</p>
            </div>
            <PixelPanel T={T} style={{marginBottom:18}} contentStyle={{background:T.surface,overflow:"hidden"}}>
              {/* Channels — single platform override, or multiple channels read per-row from a
                  mapped column. Reports combining several platforms in one export (a blended
                  agency report, a multi-channel Sheet) need the latter; a single-platform export
                  with no Platform column at all needs the former. */}
              <div style={{padding:"10px 16px",borderBottom:`1px solid ${T.border}`,background:T.accentBg}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:isMobile?"wrap":"nowrap"}}>
                  <div>
                    <span style={{fontSize:13,fontWeight:500,color:T.text}}>Channels in this file</span>
                    <div style={{fontSize:11,color:T.textMuted,marginTop:2}}>{uploadPlatform==="auto"?"Map the Platform column below — every distinct value becomes its own channel.":"Every row will be labeled as this one platform."}</div>
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    <button type="button" onClick={()=>setUploadPlatform("auto")}
                      style={{padding:"6px 12px",borderRadius:6,border:`1px solid ${uploadPlatform==="auto"?T.accent:T.border}`,background:uploadPlatform==="auto"?T.accent:T.surface,color:uploadPlatform==="auto"?"#fff":T.text,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Multiple channels</button>
                    <button type="button" onClick={()=>setUploadPlatform(p=>p==="auto"?"Google":p)}
                      style={{padding:"6px 12px",borderRadius:6,border:`1px solid ${uploadPlatform!=="auto"?T.accent:T.border}`,background:uploadPlatform!=="auto"?T.accent:T.surface,color:uploadPlatform!=="auto"?"#fff":T.text,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Single channel</button>
                  </div>
                </div>
                {uploadPlatform!=="auto"&&(
                  <div style={{marginTop:10}}>
                    <Sel value={uploadPlatform} onChange={setUploadPlatform} T={T}>
                      {PLATFORM_OPTIONS.filter(p=>p!=="auto").map(p=><option key={p} value={p}>{p}</option>)}
                    </Sel>
                  </div>
                )}
                {uploadPlatform==="auto"&&channelPreview.length>0&&(
                  <div style={{marginTop:10,display:"flex",flexWrap:"wrap",gap:6}}>
                    {channelPreview.map(([name,count])=>(
                      <span key={name} style={{fontSize:11,fontWeight:600,padding:"3px 9px",borderRadius:20,background:T.surface,border:`1px solid ${T.border}`,color:T.text}}>{name} · {count.toLocaleString()}</span>
                    ))}
                  </div>
                )}
                {uploadPlatform==="auto"&&!colMap.platform&&rawRows.length>0&&(
                  <div style={{marginTop:10,fontSize:11,color:T.danger,fontWeight:600}}>Map the Platform column below to continue.</div>
                )}
              </div>
              {/* Monthly-grain confirmation — previously a silent heuristic driving uploadAsOf's
                  auto-fill; now an explicit toggle so a wrong guess is visible and correctable. */}
              <div style={{padding:"10px 16px",borderBottom:`1px solid ${T.border}`,background:T.accentBg}}>
                <label style={{display:"flex",alignItems:"flex-start",gap:9,cursor:"pointer"}}>
                  <input type="checkbox" checked={uploadIsMonthly} onChange={e=>{
                    const checked=e.target.checked;
                    setUploadIsMonthly(checked);
                    if(checked&&!uploadAsOf){
                      const y=new Date();y.setDate(y.getDate()-1);
                      setUploadAsOf(`${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,"0")}-${String(y.getDate()).padStart(2,"0")}`);
                    }
                  }} style={{marginTop:2,cursor:"pointer",accentColor:T.accent,width:14,height:14,flexShrink:0}}/>
                  <div>
                    <span style={{fontSize:13,fontWeight:500,color:T.text}}>This file has one row per month, not per day</span>
                    <div style={{fontSize:11,color:T.textMuted,marginTop:2}}>Google/Bing's manual exports report one row per campaign PER MONTH (e.g. "Jul-26") with the month's total spend — not a real daily date. Checked automatically when every date in the file looks like the 1st of a month; uncheck if this file actually has real per-day rows.</div>
                  </div>
                </label>
                {uploadIsMonthly&&(
                  <div style={{marginTop:10,display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?"5px":"12px",alignItems:"center"}}>
                    <div>
                      <span style={{fontSize:12,fontWeight:500,color:T.text}}>Data accurate through</span>
                      <div style={{fontSize:11,color:T.textMuted,marginTop:2}}>Each row's full-month spend is treated as current through this date — adjust if you pulled the export on a different day than today.</div>
                    </div>
                    <input type="date" value={uploadAsOf} onChange={e=>setUploadAsOf(e.target.value)}
                      style={{background:T.inputBg,border:`1px solid ${uploadIsMonthly&&!uploadAsOf?T.dangerBorder:T.border}`,borderRadius:6,color:T.text,padding:"7px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                  </div>
                )}
              </div>
              {[...REQUIRED_COLS,...OPTIONAL_COLS].map((field,i)=>{
                // Hide platform column mapping if a specific platform is selected
                if(field==="platform"&&uploadPlatform!=="auto")return null;
                const isRequired=REQUIRED_COLS.includes(field)||(field==="platform"&&uploadPlatform==="auto");
                return(
                <div key={field} style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?"5px":"12px",padding:"10px 16px",borderBottom:i<REQUIRED_COLS.length+OPTIONAL_COLS.length-1?`1px solid ${T.border}`:"none",alignItems:"center",background:isRequired&&!colMap[field]?T.dangerBg:"transparent"}}>
                  <div><span style={{fontSize:13,fontWeight:500,color:T.text}}>{COL_LABELS[field]}</span>{isRequired&&<span style={{fontSize:10,color:T.danger,marginLeft:6,fontWeight:600}}>required</span>}{!isRequired&&<span style={{fontSize:10,color:T.textMuted,marginLeft:6}}>optional</span>}</div>
                  <Sel value={colMap[field]||""} onChange={v=>setColMap(p=>({...p,[field]:v||undefined}))} T={T}><option value="">— not mapped —</option>{headers.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                </div>
                );
              })}
            </PixelPanel>
            {canProceed&&(
              <div style={{padding:"10px 14px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:8,marginBottom:14,fontSize:13,color:T.success,fontWeight:500}}>
                ✓ Found <strong>{campaigns.length}</strong> campaigns · <strong>{fmt$(campaigns.reduce((s,c)=>s+c.spend,0))}</strong> total spend
                <div style={{fontWeight:400,marginTop:2,fontSize:12}}>{uploadIsMonthly?`Each row treated as one month's total, accurate through ${uploadAsOf||"—"}.`:"Each row treated as a single day's spend."} {uploadPlatform==="auto"?`Channels read per-row from "${colMap.platform}".`:`All rows labeled "${uploadPlatform}".`}</div>
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <Btn onClick={()=>setStep("upload")} variant="ghost" T={T}>← Back</Btn>
              <Btn onClick={()=>{
                if(!canEdit)return;
                const norm=normalizeRows(rawRows,colMap);
                const withPlatform=uploadPlatform==="auto"?norm:norm.map(r=>({...r,platform:uploadPlatform}));
                const withAsOf=uploadAsOf?withPlatform.map(r=>({...r,as_of_date:uploadAsOf})):withPlatform;
                const fileLabel=fileName||"CSV";
                const conflicts=detectSpendConflicts(mergedNormRows,withAsOf);
                if(conflicts.length){
                  setSpendConflictReview({conflicts,pendingRows:withAsOf,fileLabel,useImportedSet:new Set()});
                  return;
                }
                setMergedNormRows(prev=>mergeRows(prev,withAsOf));
                checkpoint(`Imported spend data — ${fileLabel} (${withAsOf.length} rows)`,"tagger_import");
                showNotif(`Added ${withAsOf.length} rows — merged with existing data`);
                setUploadPlatform("auto");
                setUploadAsOf("");
                setUploadIsMonthly(false);
                setStep("tag");setView("tagger");
              }} disabled={!canProceed||!canEdit} variant="primary" T={T} size="md">Continue to tagging →</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── TAGGER ── */}
      {step==="tag"&&view==="tagger"&&(
        <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
            {suggestions.length>0&&(
              <div style={{padding:"7px 16px",background:T.accentBg,borderBottom:`1px solid ${T.border}`,display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",flexShrink:0}}>
                <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text}}>Suggest</span>
                {suggestions.map(s=><button key={s.key} onClick={()=>applySug(s.dim,s.val)} style={{fontSize:12,background:T.surface,border:`1px solid ${T.border}`,color:T.text,borderRadius:14,padding:"3px 10px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:500}}>Apply {s.dim}: {s.val} to {s.count} untagged</button>)}
              </div>
            )}
            {selected.size>0&&(
              <div style={{padding:"8px 16px",background:T.surface,borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",flexShrink:0}}>
                <Pill color={T.text} bg={T.accent} border={T.text}>{selected.size} selected</Pill>
                <span style={{color:T.textMuted,fontSize:13}}>→</span>
                <Sel value={applyDim} onChange={setApplyDim} T={T} style={{width:130,fontSize:12}}><option value="">Dimension…</option>{tagDims.map(d=><option key={d} value={d}>{d}</option>)}</Sel>
                <TagAutocompleteInput T={T} value={applyVal} onChange={setApplyVal} suggestions={dimSuggestions(applyDim)} onEnter={applyTags} placeholder="Tag value…" style={{width:130}}
                  inputStyle={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif",transition:"border-color 0.12s"}}/>
                <Btn onClick={applyTags} disabled={!applyDim||!applyVal} variant="primary" size="sm" T={T}>Apply</Btn>
                <Btn onClick={()=>bulkRemoveTag(applyDim)} disabled={!applyDim} variant="danger" size="sm" T={T}>Remove</Btn>
                <div style={{width:1,height:16,background:T.border}}/>
                <Btn onClick={bulkRemoveCampaigns} variant="danger" size="sm" T={T} title="Delete these campaigns' spend rows entirely — e.g. filter Platform to isolate a bad import, select-all, then delete">Delete from dataset</Btn>
                <Btn onClick={()=>setSelected(new Set())} variant="ghost" size="sm" T={T}>Clear</Btn>
                <div style={{marginLeft:"auto"}}>
                  <Btn onClick={undoTags} disabled={!tagsHistory.length} variant="ghost" size="sm" T={T} title="Undo last tag action (⌘Z)">↩ Undo {tagsHistory.length>0&&`(${tagsHistory.length})`}</Btn>
                </div>
              </div>
            )}

            <div style={{borderBottom:`1px solid ${T.border}`,background:T.surfaceEl,flexShrink:0}}>
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 16px 0"}}>
                <button onClick={()=>setFiltersOpen(o=>!o)} title={filtersOpen?"Hide filters":"Show filters"}
                  style={{display:"flex",alignItems:"center",gap:5,background:filtersOpen?T.surfaceHover:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"3px 8px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:600,color:T.text,outline:"none"}}>
                  <Icon name="filter" size={12} color={T.text}/>
                  Filters
                  {hasF&&<span style={{width:6,height:6,borderRadius:"50%",background:T.accent,flexShrink:0}}/>}
                </button>
                {!filtersOpen&&hasF&&<button onClick={clearF} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11,fontFamily:"'DM Sans',sans-serif",textDecoration:"underline",padding:0,outline:"none"}}>Clear filters</button>}
                {/* Replaces the top bar's old "↑ Add data" button (removed 2026-07-24, see the
                    doc comment where it used to live) — same destination, just living down here
                    with the rest of this table's own controls instead of the crowded global bar. */}
                <div style={{marginLeft:"auto"}}>
                  <Btn onClick={()=>{setStep("upload");setView("data");}} variant="ghost" size="sm" T={T}>← Back to Data Sources</Btn>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:isMobile?"32px 1fr 90px":"32px minmax(160px,1fr) minmax(160px,1fr) 110px 130px minmax(180px,1fr)",padding:"11px 16px 5px",alignItems:"end",gap:8,background:T.headerBg}}>
                <input type="checkbox" checked={filtered.length>0&&selected.size===filtered.length} onChange={selAll} style={{cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                {/* Relabeled 2026-07-24 to match current platform terminology (LinkedIn recently
                    renamed its own UI to "Campaign"/"Ad Set", matching what most other platforms
                    already call Campaign/Ad Set or Ad Group) — display labels only, the underlying
                    campaign_group_name/campaign_name fields and CSV import/export column names are
                    unchanged, since those stay platform-agnostic across Google/Meta/etc. imports. */}
                {!isMobile&&<SH col="group" label="Campaign" center/>}
                <SH col="campaign" label="Ad Group/Ad Set" center/>
                <SH col="spend" label="Spend" center/>
                {!isMobile&&<SH col="platform" label="Platform" center/>}
                {!isMobile&&<div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <SH col="tags" label="Tags"/>
                  {tagsHistory.length>0&&<button onClick={undoTags} title="Undo last tag action (⌘Z)"
                    style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:5,color:T.text,cursor:"pointer",fontSize:10,padding:"1px 6px",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}>
                    ↩ Undo ({tagsHistory.length})
                  </button>}
                </div>}
              </div>
              {filtersOpen&&<div style={{display:"grid",gridTemplateColumns:isMobile?"32px 1fr 90px":"32px minmax(160px,1fr) minmax(160px,1fr) 110px 130px minmax(180px,1fr)",padding:"3px 16px 10px",gap:8,alignItems:"start"}}>
                <div/>
                {!isMobile&&<div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <div style={{display:"flex",gap:3,marginTop:3}}>
                    <IconField icon="search" color={T.textMuted}>
                      <input value={fGroup} onChange={e=>setFGroup(e.target.value)} placeholder="Group contains… (a, b)" title={`Comma-separate multiple terms — ${fGroupInclMode==="and"?"row must contain ALL of them":"matches ANY of them"}`} style={{...fIn,marginTop:0,paddingLeft:26}}/>
                    </IconField>
                    <MatchModeToggle mode={fGroupInclMode} onChange={setFGroupInclMode} T={T}/>
                  </div>
                  <div style={{display:"flex",gap:3}}>
                    <input value={fGroupExclude} onChange={e=>setFGroupExclude(e.target.value)} placeholder="≠ excludes… (a, b)" title={`Comma-separate multiple terms — ${fGroupExclMode==="and"?"excludes only rows containing ALL of them":"excludes any of them"}`} style={{...fIn,flex:1,marginTop:0}}/>
                    <MatchModeToggle mode={fGroupExclMode} onChange={setFGroupExclMode} T={T}/>
                  </div>
                </div>}
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <div style={{display:"flex",gap:3,marginTop:3}}>
                    <IconField icon="search" color={T.textMuted}>
                      <input value={fCamp} onChange={e=>setFCamp(e.target.value)} placeholder="Campaign contains… (a, b)" title={`Comma-separate multiple terms — ${fCampInclMode==="and"?"row must contain ALL of them":"matches ANY of them"}`} style={{...fIn,marginTop:0,paddingLeft:26}}/>
                    </IconField>
                    <MatchModeToggle mode={fCampInclMode} onChange={setFCampInclMode} T={T}/>
                  </div>
                  <div style={{display:"flex",gap:3}}>
                    <input value={fCampExclude} onChange={e=>setFCampExclude(e.target.value)} placeholder="≠ excludes… (a, b)" title={`Comma-separate multiple terms — ${fCampExclMode==="and"?"excludes only rows containing ALL of them":"excludes any of them"}`} style={{...fIn,flex:1,marginTop:0}}/>
                    <MatchModeToggle mode={fCampExclMode} onChange={setFCampExclMode} T={T}/>
                  </div>
                </div>
                <div style={{display:"flex",gap:2}}><input value={fSMin} onChange={e=>setFSMin(e.target.value)} placeholder="Min" style={{...fIn,width:"50%"}}/><input value={fSMax} onChange={e=>setFSMax(e.target.value)} placeholder="Max" style={{...fIn,width:"50%"}}/></div>
                {!isMobile&&<select value={fPlat} onChange={e=>setFPlat(e.target.value)} style={{...fIn,cursor:"pointer"}}><option value="">All platforms</option>{allPlats.map(p=><option key={p} value={p}>{p}</option>)}</select>}
                {!isMobile&&<div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <div style={{display:"flex",gap:4,marginTop:3}}>
                    <IconField icon="search" color={T.textMuted}>
                      <input value={fTag} onChange={e=>setFTag(e.target.value)} placeholder="Tag contains… (a, b)" title={`Comma-separate multiple terms — ${fTagInclMode==="and"?"row must contain ALL of them":"matches ANY of them"}`} style={{...fIn,marginTop:0,paddingLeft:26}}/>
                    </IconField>
                    <MatchModeToggle mode={fTagInclMode} onChange={setFTagInclMode} T={T}/>
                    <select value={fStatus} onChange={e=>setFStatus(e.target.value)} style={{...fIn,width:120,cursor:"pointer",marginTop:0}}><option value="all">All</option><option value="tagged">Tagged</option><option value="untagged">Needs review</option></select>
                    {hasF&&<button onClick={clearF} style={{background:T.dangerBg,border:`1px solid ${T.danger}`,color:T.danger,borderRadius:6,padding:"0 8px",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}>Clear ×</button>}
                  </div>
                  <div style={{display:"flex",gap:4}}>
                    <input value={fTagExclude} onChange={e=>setFTagExclude(e.target.value)} placeholder="≠ tag excludes… (a, b)" title={`Comma-separate multiple terms — ${fTagExclMode==="and"?"excludes only rows containing ALL of them":"excludes any of them"}`} style={{...fIn,flex:1,marginTop:0}}/>
                    <MatchModeToggle mode={fTagExclMode} onChange={setFTagExclMode} T={T}/>
                  </div>
                </div>}
              </div>}
            </div>

            <div style={{overflow:"auto",flex:1}}>
              {filtered.map((c)=>{
                const ts=tags[c.key]||{};const tc=Object.keys(ts).length;const isSel=selected.has(c.key);const pc=PLATFORM_COLORS[c.platform]||T.textMuted;
                return(
                  <div key={c.key} className={isSel?undefined:"bhq-row"} onClick={()=>toggleSel(c.key)}
                    style={{display:"grid",gridTemplateColumns:isMobile?"32px 1fr 90px":"32px minmax(160px,1fr) minmax(160px,1fr) 110px 130px minmax(180px,1fr) 24px",padding:"11px 16px",borderBottom:`1px solid ${T.border}`,alignItems:"center",cursor:"pointer",background:isSel?T.rowSelected:T.surface,transition:"background 0.1s",gap:6}}>
                    <input type="checkbox" checked={isSel} onChange={()=>toggleSel(c.key)} onClick={e=>e.stopPropagation()} style={{cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                    {/* Group and Campaign now share one text treatment (size/weight/color) instead
                        of a muted-vs-bold pair — Vercel's row title and metadata fields read at the
                        same visual weight, just differing in which column they sit in. Weight
                        dropped to 400 (2026-07-24, per Mo) — no benefit to bolding row data. */}
                    {!isMobile&&<div title={c.groupName} style={{fontSize:13,fontWeight:400,fontFamily:"'DM Sans',sans-serif",color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.groupName}</div>}
                    {/* Status dot mirrors the "Ready"-style indicator on a Vercel deployment row —
                        here it means tagged (accent) vs needs review (neutral grey), so the row list
                        reads at a glance without scanning all the way over to the Tags column. */}
                    <div style={{minWidth:0,display:"flex",alignItems:"center",gap:11}}>
                      <span title={tc>0?"Tagged":"Needs review"} style={{width:9,height:9,borderRadius:"50%",background:tc>0?T.accent:"#A1A1AA",flexShrink:0}}/>
                      <span title={c.name} style={{minWidth:0,fontSize:13,fontWeight:400,fontFamily:"'DM Sans',sans-serif",color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</span>
                    </div>
                    <div style={{fontSize:13,fontFamily:"'DM Sans',sans-serif",fontWeight:400,color:T.text}}>{fmt$(c.spend)}</div>
                    {!isMobile&&<div onClick={e=>e.stopPropagation()}>
                      {editingPlatform===c.key?(
                        <select autoFocus value={c.platform}
                          onChange={e=>{if(!canEdit)return;const plat=e.target.value;setMergedNormRows(prev=>prev.map(r=>campaignKey(r.campaign_group_name,r.campaign_name)===c.key?{...r,platform:plat}:r));setEditingPlatform(null);}}
                          onBlur={()=>setEditingPlatform(null)}
                          style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:5,color:T.text,fontSize:13,padding:"2px 6px",outline:"none",fontFamily:"'DM Sans',sans-serif",cursor:"pointer"}}>
                          {PLATFORM_OPTIONS.filter(p=>p!=="auto").map(p=><option key={p} value={p}>{p}</option>)}
                        </select>
                      ):(
                        <span onClick={()=>canEdit&&setEditingPlatform(c.key)} title={canEdit?"Click to change platform":"View-only access"}
                          style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:13,fontWeight:400,padding:"3px 8px",borderRadius:6,background:pc+"14",color:pc,border:`1px solid ${pc}55`,whiteSpace:"nowrap",cursor:canEdit?"pointer":"default"}}>
                          <span style={{width:5,height:5,borderRadius:"50%",background:pc,flexShrink:0}}/>
                          {c.platform}
                        </span>
                      )}
                    </div>}
                    {!isMobile&&<div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
                      {tc===0?<Pill color={T.text} bg={T.surfaceEl} border={T.border} style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:400,borderRadius:6}}>needs review</Pill>:
                        // Ordered by tagDims (the canonical dimension order), not Object.entries(ts) —
                        // a plain object's key order follows INSERTION order, which is whatever
                        // sequence that specific campaign happened to get tagged in (BU-then-Product
                        // for one row, Product-then-BU for another), so pills visibly reshuffled
                        // between rows even though the underlying data was identical. tagDims order
                        // is fixed regardless of tagging order, so every row's pills line up the same.
                        [...tagDims.filter(d=>Object.prototype.hasOwnProperty.call(ts,d)),...Object.keys(ts).filter(d=>!tagDims.includes(d))].map(dim=>{
                          const val=ts[dim];
                          const dimIdx=tagDims.indexOf(dim);
                          const dc=TAG_DIM_COLORS[(dimIdx>=0?dimIdx:0)%TAG_DIM_COLORS.length];
                          return(
                          <span key={dim} style={{display:"inline-flex",alignItems:"center",fontSize:13,fontWeight:400,padding:"2px 4px 2px 8px",borderRadius:6,background:dc+"14",color:dc,border:`1px solid ${dc}40`,gap:2,fontFamily:"'DM Sans',sans-serif"}}>
                            <span style={{opacity:0.75,marginRight:1}}>{dim}:</span>
                            {editingTag?.campaign===c.key&&editingTag?.dim===dim?(
                              <TagAutocompleteInput T={T} autoFocus value={editVal} onChange={setEditVal} suggestions={dimSuggestions(dim)}
                                onEnter={saveEdit} onEscape={()=>{setEditingTag(null);setEditVal("");}} onBlur={saveEdit}
                                style={{width:Math.max(60,editVal.length*7+20)+"px"}}
                                inputStyle={{background:"transparent",border:"none",outline:"none",color:T.text,fontSize:13,fontWeight:400,width:"100%",fontFamily:"'DM Sans',sans-serif",padding:0}}/>
                            ):(
                              <span onClick={e=>{e.stopPropagation();if(!canEdit)return;setEditingTag({campaign:c.key,dim});setEditVal(val);}} style={{cursor:canEdit?"text":"default",fontWeight:400}}>{val}</span>
                            )}
                            {canEdit&&<span onClick={e=>{e.stopPropagation();removeTag(c.key,dim);}} style={{color:T.textMuted,cursor:"pointer",fontSize:13,lineHeight:1,marginLeft:1,padding:"0 2px"}}>×</span>}
                          </span>
                          );
                        })
                      }
                    </div>}
                    {!isMobile&&canEdit&&<button onClick={e=>{e.stopPropagation();if(window.confirm(`Remove "${c.name}" from this dataset?\n\nThis only affects the current session — your tags are kept. You can re-sync or re-upload to restore it.`)){setMergedNormRows(prev=>prev.filter(r=>campaignKey(r.campaign_group_name,r.campaign_name)!==c.key));}}} title="Remove this campaign"
                      style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:5,color:T.textMuted,cursor:"pointer",fontSize:12,lineHeight:1,padding:0,opacity:0.4,transition:"all 0.1s"}}
                      onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.border=`1px solid ${T.danger}`;e.currentTarget.style.color=T.danger;}}
                      onMouseLeave={e=>{e.currentTarget.style.opacity=0.4;e.currentTarget.style.border="1px solid transparent";e.currentTarget.style.color=T.textMuted;}}>✕</button>}
                  </div>
                );
              })}
              {filtered.length===0&&<div style={{padding:"40px 20px 52px",textAlign:"center",color:T.textMuted,fontSize:13}}>
                {/* Exploration-rover illustration (2026-07-26, per Mo, licensed set) — a rover
                    searching empty terrain reads as "nothing found," the exact state of a filtered-
                    to-zero campaign list. */}
                <img src={explorationRoverIcon} alt="" aria-hidden="true" style={{width:110,height:"auto",marginBottom:10}}/>
                <div>No campaigns match your filters.{hasF&&<span onClick={clearF} style={{color:T.text,cursor:"pointer",marginLeft:6,fontWeight:400,textDecoration:"underline"}}>Clear filters</span>}</div>
              </div>}
            </div>
          </div>
        </div>
      )}

      {/* onNavigate("tagger") from an empty-state card (e.g. "Start with spend data") needs to land
          on Data Sources (view="data") when there's no data flow in progress yet (step is still
          "upload"/"map"), not the Tagger table itself — matches the same branch in the NAV.map
          click handler above, now that Add Data lives at view==="data" instead of nested under
          view==="tagger". */}
      {/* Same fix as the top-nav Tagger tab above: route off mergedNormRows.length (is there
          actually data to show), not the transient step flag — see that button's doc comment for
          why branching on step left this dead-clicking whenever step had drifted off "tag". */}
      {view==="dashboard"&&<Suspense fallback={<TabLoadingFallback/>}><Dashboard T={T} onNavigate={v=>{if(v==="tagger"){if(mergedNormRows.length>0){setStep("tag");setView("tagger");}else{setStep("upload");setView("data");}}else if(v==="data"){setStep("upload");setView("data");}else setView(v);}} stats={stats} hasData={visibleNormRows.length>0} budgets={budgets} budgetDims={budgetDims} budgetRowMeta={budgetRowMeta} defaultForecastModel={defaultForecastModel} campaignTags={tags} mergedNormRows={visibleNormRows} connectionDetails={connectionDetails} exportTags={exportTags}/></Suspense>}
      {/* Kept mounted (display:none when inactive) rather than conditionally unmounted like the
          other views below — Budget owns an in-progress Import modal (importOpen/iStep/iRawRows/
          dimMap/preview/etc.) as local state, and unmounting on every tab switch was silently
          discarding an open import if the user navigated away mid-flow. sidebarEl naturally
          becomes null while hidden (its portal target only exists when view==="budget"), so the
          sidebar contents disappear correctly without any extra guard. */}
      {/* Suspense here still helps even though BudgetManager is always mounted (see comment
          above) — its chunk is fetched once on first mount instead of shipping in the main
          bundle, it just isn't deferred until the Budget tab is actually opened the way the
          other three tabs' chunks are. */}
      <div style={{display:view==="budget"?"contents":"none"}}>
        <Suspense fallback={<TabLoadingFallback/>}>
        <BudgetManager campaignTags={tags} setTags={setTags} tagDimensions={tagDims} T={T} session={session} onAddDimensions={newDims=>setTagDims(p=>[...new Set([...p,...newDims])])} budgets={budgets} setBudgets={setBudgets} budgetDims={budgetDims} setBudgetDims={setBudgetDims} budgetRowMeta={budgetRowMeta} setBudgetRowMeta={setBudgetRowMeta} budgetMetaDims={budgetMetaDims} setBudgetMetaDims={setBudgetMetaDims} budgetImportMeta={budgetImportMeta} setBudgetImportMeta={setBudgetImportMeta} defaultForecastModel={defaultForecastModel} mergedNormRows={visibleNormRows} onCheckpoint={checkpoint} sidebarEl={budgetSidebarEl} canEdit={canEdit}/>
        </Suspense>
      </div>
      {view==="pacing"&&<Suspense fallback={<TabLoadingFallback/>}><PacingDashboard campaignTags={tags} setTags={setTags} tagDimensions={tagDims} budgetDims={budgetDims} budgets={budgets} setBudgets={setBudgets} budgetRowMeta={budgetRowMeta} setBudgetRowMeta={setBudgetRowMeta} savedViews={savedViews} setSavedViews={setSavedViews} defaultForecastModel={defaultForecastModel} setDefaultForecastModel={setDefaultForecastModel} mergedNormRows={visibleNormRows} T={T} session={session} onNavigate={setView} sidebarEl={pacingSidebarEl} onAskAboutView={q=>{setPendingAskQuestion(q);setView("ask");}} initialViewConfig={pendingViewConfig} onConsumeInitialViewConfig={()=>setPendingViewConfig(null)}/></Suspense>}
      {view==="ask"&&<Suspense fallback={<TabLoadingFallback/>}><AskAI T={T} session={session} mergedNormRows={visibleNormRows} tags={tags} tagDims={tagDims} budgetDims={budgetDims} budgets={budgets} budgetRowMeta={budgetRowMeta} defaultForecastModel={defaultForecastModel} hasData={visibleNormRows.length>0} askChats={askChats} setAskChats={setAskChats} askProjects={askProjects} setAskProjects={setAskProjects} activeAskChatId={activeAskChatId} setActiveAskChatId={setActiveAskChatId} sidebarEl={askSidebarEl} initialQuestion={pendingAskQuestion} onConsumeInitialQuestion={()=>setPendingAskQuestion(null)} onSaveAsView={cfg=>{setPendingViewConfig(cfg);setView("pacing");}}/></Suspense>}
      {view==="reportingAnalyzer"&&<Suspense fallback={<TabLoadingFallback/>}><ReportingAnalyzer T={T} session={session} workspace={workspace}/></Suspense>}
      {view==="settings"&&(()=>{
        const budgetYears=Object.keys(budgets).length;
        const budgetSegs=Object.values(budgets).reduce((s,y)=>s+Object.keys(y).length,0);
        const platformBreakdown=(()=>{
          const map={};
          visibleNormRows.forEach(r=>{
            const p=derivePlatform(r.campaign_group_name,r.campaign_name,r.platform,r.campaign_type);
            if(!map[p])map[p]={platform:p,rows:0,spend:0,campaigns:new Set()};
            map[p].rows++;map[p].spend+=r.spend;map[p].campaigns.add(campaignKey(r.campaign_group_name,r.campaign_name));
          });
          return Object.values(map).map(m=>({platform:m.platform,rows:m.rows,spend:m.spend,campaigns:m.campaigns.size})).sort((a,b)=>b.spend-a.spend);
        })();
        // disabled always also folds in !canEdit — every one of these is a destructive write
        // (clear data), so a view-only member sees the same disabled state a real 403 would force
        // anyway, rather than a button that looks clickable and then just fails.
        const rowSection=({title,desc,stat,action,label,disabled})=>(
          <div style={{border:`1px solid ${T.border}`,borderRadius:8,background:T.surface,padding:"20px 22px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:20}}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>{title}</div>
              <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",maxWidth:480}}>{desc}</div>
              <div style={{fontSize:12,color:T.textMuted,marginTop:8,fontFamily:"'DM Sans',sans-serif"}}>{stat}</div>
            </div>
            <Btn onClick={action} variant="danger" size="sm" T={T} disabled={disabled||!canEdit} title={canEdit?undefined:"View-only access"} style={{flexShrink:0}}>{label}</Btn>
          </div>
        );
        return(
          <div style={{flex:1,overflow:"auto",background:T.bg}}>
            <div style={{maxWidth:760,margin:"0 auto",padding:"48px 32px"}}>
              <div style={{marginBottom:32}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                  <div style={{width:36,height:36,borderRadius:10,background:T.surfaceEl,display:"flex",alignItems:"center",justifyContent:"center"}}><Icon name="gear" size={17} color={T.text}/></div>
                  <h1 style={{fontSize:22,fontWeight:800,color:T.text,letterSpacing:"-0.4px",fontFamily:"'DM Sans',sans-serif"}}>Settings</h1>
                </div>
                <p style={{fontSize:13,color:T.textSub,fontFamily:"'DM Sans',sans-serif"}}>Manage the data stored in this BudgetHQ instance. Reporting has no data of its own — it's computed live from Tagger and Budget data, so clearing either one updates Reporting automatically.</p>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                {canManageTeam&&(
                  <div style={{border:`1px solid ${T.border}`,borderRadius:8,background:T.surface,padding:"20px 22px"}}>
                    <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>Workspace</div>
                    <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",maxWidth:520,marginBottom:14}}>Rename this workspace, or permanently delete it below.</div>
                    <div style={{display:"flex",gap:6,marginBottom:workspaceNameError?6:0}}>
                      <input value={workspaceNameInput} onChange={e=>{setWorkspaceNameInput(e.target.value);setWorkspaceNameError("");}}
                        onKeyDown={e=>e.key==="Enter"&&saveWorkspaceName()}
                        style={{flex:1,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"7px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                      <Btn onClick={saveWorkspaceName} variant="primary" size="sm" T={T} disabled={workspaceNameSaving||!workspaceNameInput.trim()||workspaceNameInput.trim()===workspace?.name}>{workspaceNameSaving?"Saving…":"Save"}</Btn>
                    </div>
                    {workspaceNameError&&<div style={{fontSize:11,color:T.danger}}>{workspaceNameError}</div>}
                    {isOwner&&(
                      <div style={{marginTop:16,paddingTop:16,borderTop:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:20}}>
                        <div>
                          <div style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>Delete this workspace</div>
                          <div style={{fontSize:12,color:T.textMuted,marginTop:2,fontFamily:"'DM Sans',sans-serif"}}>Permanently removes all spend data, tags, budgets, files, version history, and AI chats. There's no undo.</div>
                        </div>
                        <Btn onClick={()=>{setDeleteWorkspaceOpen(true);setDeleteWorkspaceConfirmText("");setDeleteWorkspaceError("");}} variant="danger" size="sm" T={T} style={{flexShrink:0}}>Delete workspace</Btn>
                      </div>
                    )}
                  </div>
                )}
                <div style={{border:`1px solid ${T.border}`,borderRadius:8,background:T.surface,padding:"20px 22px"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,marginBottom:4}}>
                    <div style={{fontSize:14,fontWeight:700,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>Team</div>
                    <Pill color={T.textSub} bg={T.surfaceEl} border={T.border} style={{fontSize:11}}>Your access: {myRole==="owner"?"Owner":myRole==="admin"?"Admin":"Member (view only)"}</Pill>
                  </div>
                  <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",maxWidth:520,marginBottom:14}}>
                    {canManageTeam?"Invite people to this workspace and control what they can do. Members can view every tab but can't edit tags, budgets, or spend data — Admins and Owners have full edit access.":"Owners and admins manage who has access here and what they can do."}
                  </div>
                  {canManageTeam&&(
                    <div style={{marginBottom:16}}>
                      <div style={{display:"flex",gap:6}}>
                        <input value={inviteEmail} onChange={e=>{setInviteEmail(e.target.value);setInviteError("");}}
                          onKeyDown={e=>e.key==="Enter"&&!inviteSending&&inviteEmail.trim()&&sendInvite()}
                          placeholder="Email address" type="email"
                          style={{flex:1,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"7px 10px",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                        <div style={{width:130}}>
                          <Sel value={inviteRole} onChange={setInviteRole} T={T}>
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                            <option value="owner">Owner</option>
                          </Sel>
                        </div>
                        <Btn onClick={sendInvite} variant="primary" size="sm" T={T} disabled={inviteSending||!inviteEmail.trim()}>{inviteSending?"Sending…":"Invite"}</Btn>
                      </div>
                      {inviteError&&<div style={{marginTop:6,fontSize:11,color:T.danger}}>{inviteError}</div>}
                    </div>
                  )}
                  {teamMembersLoading?(
                    <div style={{fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif",padding:"8px 0"}}>Loading…</div>
                  ):(
                    <div>
                      {teamMembers.map((m,i)=>{
                        const isMe=m.userId===sessionUserId;
                        return(
                          <div key={m.userId} className="bhq-row" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,padding:"9px 4px",borderTop:i>0?`1px solid ${T.border}`:"none"}}>
                            <div style={{minWidth:0,display:"flex",alignItems:"center",gap:8}}>
                              <div style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:280}}>{m.email||m.userId}</div>
                              {isMe&&<span style={{fontSize:11,color:T.textMuted}}>(you)</span>}
                              {!m.acceptedAt&&<Pill color={T.textSub} bg={T.surfaceEl} border={T.border} style={{fontSize:10}}>pending</Pill>}
                            </div>
                            <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                              {canManageTeam&&!isMe?(
                                <div style={{width:110}}>
                                  <Sel value={m.role} onChange={r=>changeTeamRole(m.userId,r)} T={T} style={{fontSize:11,padding:"4px 8px"}}>
                                    <option value="member">Member</option>
                                    <option value="admin">Admin</option>
                                    <option value="owner">Owner</option>
                                  </Sel>
                                </div>
                              ):(
                                <Pill color={T.text} bg={T.surfaceEl} border={T.border} style={{fontSize:11}}>{m.role==="owner"?"Owner":m.role==="admin"?"Admin":"Member"}</Pill>
                              )}
                              {canManageTeam&&!isMe&&(
                                <button onClick={()=>removeTeamMember(m.userId,m.email||"this person")} title="Remove"
                                  style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:5,color:T.textMuted,cursor:"pointer",fontSize:12,padding:0}}
                                  onMouseEnter={e=>{e.currentTarget.style.color=T.danger;}}
                                  onMouseLeave={e=>{e.currentTarget.style.color=T.textMuted;}}>✕</button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {canManageTeam&&teamInvites.length>0&&(
                    <div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${T.border}`}}>
                      <div style={{fontSize:11,fontWeight:700,color:T.textMuted,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:8}}>Pending invites</div>
                      {teamInvites.map((inv,i)=>(
                        <div key={inv.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,padding:"7px 4px",borderTop:i>0?`1px solid ${T.border}`:"none"}}>
                          <div style={{fontSize:12,color:T.textSub,fontFamily:"'DM Sans',sans-serif"}}>{inv.email} <span style={{color:T.textMuted}}>· {inv.role==="owner"?"Owner":inv.role==="admin"?"Admin":"Member"}</span></div>
                          <span onClick={()=>revokeTeamInvite(inv.email)} style={{fontSize:11,color:T.textMuted,cursor:"pointer"}}>Revoke</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{border:`1px solid ${T.border}`,borderRadius:8,background:T.surface,padding:"20px 22px"}}>
                  <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>Connections</div>
                  <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",maxWidth:560,marginBottom:14}}>
                    Connecting and managing ad accounts (LinkedIn, Microsoft Advertising, Funnel.io, Supermetrics, Capterra) now lives in Data Sources — sync schedules, reconnects, and disconnects included.
                  </div>
                  <Btn onClick={()=>{setStep("upload");setView("data");}} variant="primary" size="sm" T={T}>Go to Data Sources →</Btn>
                </div>
                {canEdit&&<div style={{border:`1px solid ${T.border}`,borderRadius:8,background:T.surface,padding:"20px 22px"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,marginBottom:4}}>
                    <div style={{fontSize:14,fontWeight:700,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>File Store</div>
                    <Btn onClick={()=>manualFileRef.current?.click()} variant="subtle" size="sm" T={T}>
                      <Icon name="plus" size={12} color={T.text}/> Add file
                    </Btn>
                    <input ref={manualFileRef} type="file" style={{display:"none"}} onChange={e=>{addManualFile(e.target.files[0]);e.target.value="";}}/>
                  </div>
                  <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",maxWidth:520,marginBottom:14}}>Every spend CSV you import and every tag CSV you import or export is automatically archived here as a backup copy. Add anything else you want to keep on hand — PDFs, insertion orders, whatever — with "Add file". These are just stored for reference; nothing here is read by the rest of the app.</div>
                  {fileStoreLoading?(
                    <div style={{fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif",padding:"12px 0"}}>Loading…</div>
                  ):fileStoreList.length===0?(
                    <div style={{textAlign:"center",padding:"12px 0"}}>
                      {/* Geological-sample-collection-box illustration (2026-07-26, per Mo,
                          licensed "Geometric Space Collection 2.0" set) — a sample case is a
                          storage/archive metaphor, same job File Store does for uploaded files. */}
                      <img src={geologicalSampleBoxIcon} alt="" aria-hidden="true" style={{width:56,height:"auto",marginBottom:6}}/>
                      <div style={{fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}>No files saved yet.</div>
                    </div>
                  ):(
                    <div style={{maxHeight:320,overflow:"auto"}}>
                      {fileStoreList.map((f,i)=>(
                        <div key={f.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,padding:"9px 0",borderTop:i>0?`1px solid ${T.border}`:"none"}}>
                          <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
                            <Icon name="file" size={14} color={T.textMuted}/>
                            <div style={{minWidth:0}}>
                              <div style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:340}}>{f.name}</div>
                              <div style={{fontSize:11,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}>
                                <Pill color={T.textSub} bg={T.surfaceEl} border={T.border} style={{marginRight:6,fontSize:10}}>{f.category}</Pill>
                                {fmtFileSize(f.size)} · {new Date(f.createdAt).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}
                              </div>
                            </div>
                          </div>
                          <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                            <button onClick={()=>downloadFileFromStore(f)} title="Download" style={{width:26,height:26,borderRadius:6,background:"transparent",border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                              <Icon name="download" size={12} color={T.textSub}/>
                            </button>
                            {copyTargetWorkspaces.length>0&&(
                              <div style={{position:"relative"}}>
                                <button onClick={(e)=>{
                                    if(copyMenuOpenId===f.id){setCopyMenuOpenId(null);return;}
                                    setCopyMenuAnchorRect(e.currentTarget.getBoundingClientRect());
                                    setCopyMenuOpenId(f.id);
                                  }} title="Copy to another workspace" disabled={copyingFileId===f.id}
                                  style={{width:26,height:26,borderRadius:6,background:copyMenuOpenId===f.id?T.surfaceHover:"transparent",border:`1px solid ${T.border}`,cursor:copyingFileId===f.id?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",opacity:copyingFileId===f.id?0.5:1}}>
                                  <Icon name="send" size={12} color={T.textSub}/>
                                </button>
                                {copyMenuOpenId===f.id&&copyMenuAnchorRect&&createPortal(
                                  <>
                                    <div onClick={()=>setCopyMenuOpenId(null)} style={{position:"fixed",inset:0,zIndex:999}}/>
                                    <div style={{position:"fixed",top:copyMenuAnchorRect.bottom+6,left:Math.max(8,copyMenuAnchorRect.right-200),zIndex:1000,minWidth:200,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd,padding:6,display:"flex",flexDirection:"column"}}>
                                      <div style={{padding:"5px 10px 6px",fontSize:10,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:T.textMuted}}>Copy to workspace</div>
                                      {copyTargetWorkspaces.map(w=>(
                                        <button key={w.id} className="bhq-row" onClick={()=>copyFileToOtherWorkspace(f.id,w.id,w.name)}
                                          style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",textAlign:"left",overflow:"hidden"}}>
                                          <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{w.name}</span>
                                        </button>
                                      ))}
                                    </div>
                                  </>,
                                  document.body
                                )}
                              </div>
                            )}
                            <button onClick={()=>deleteFileFromStore(f.id,f.name)} title="Delete" disabled={deletingFileId===f.id}
                              style={{width:26,height:26,borderRadius:6,background:"transparent",border:`1px solid ${T.border}`,cursor:deletingFileId===f.id?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",opacity:deletingFileId===f.id?0.5:1}}>
                              <Icon name="trash" size={12} color={T.danger}/>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>}
                {canEdit&&rowSection({
                  title:"Clear Tagger data",
                  desc:"Removes every imported spend row, campaign tag, and custom tag dimension. Budget allocations are kept.",
                  stat:`${mergedNormRows.length.toLocaleString()} spend rows · ${Object.keys(tags).length.toLocaleString()} tagged campaigns`,
                  action:clearTaggerData,label:"Clear Tagger data",disabled:!mergedNormRows.length&&!Object.keys(tags).length,
                })}
                {canEdit&&platformBreakdown.length>0&&(
                  <div style={{border:`1px solid ${T.border}`,borderRadius:8,background:T.surface,padding:"20px 22px"}}>
                    <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>Clear Tagger data by channel</div>
                    <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",maxWidth:480,marginBottom:14}}>Remove just one platform's spend rows — handy if you imported the wrong file and need to isolate and undo it. Tags are kept; a campaign only disappears once none of its rows are left.</div>
                    <div>
                      {platformBreakdown.map((p,i)=>(
                        <div key={p.platform} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,padding:"10px 0",borderTop:i>0?`1px solid ${T.border}`:"none"}}>
                          <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
                            <span style={{width:8,height:8,borderRadius:"50%",background:PLATFORM_COLORS[p.platform]||T.textMuted,flexShrink:0}}/>
                            <div style={{minWidth:0}}>
                              <div style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>{p.platform}</div>
                              <div style={{fontSize:11,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}>{p.rows.toLocaleString()} row{p.rows===1?"":"s"} · {p.campaigns.toLocaleString()} campaign{p.campaigns===1?"":"s"} · {fmt$(p.spend)}</div>
                            </div>
                          </div>
                          <Btn onClick={()=>clearPlatformData(p.platform,p.rows)} variant="danger" size="sm" T={T} style={{flexShrink:0}}>Clear</Btn>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {canEdit&&mergedNormRows.length>0&&(
                  <div style={{border:`1px solid ${T.border}`,borderRadius:8,background:T.surface,padding:"20px 22px"}}>
                    <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>Clear Tagger data by date range</div>
                    <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",maxWidth:520,marginBottom:14}}>Remove spend rows within a specific date range, optionally scoped to one platform — e.g. redo or purge just one month without touching the rest. Tags are kept; a campaign only disappears once none of its rows are left.</div>
                    <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end",marginBottom:14}}>
                      <div>
                        <div style={{fontSize:11,fontWeight:600,color:T.textMuted,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>Platform</div>
                        <Sel value={clearRangePlatform} onChange={setClearRangePlatform} T={T} style={{width:180}}>
                          <option value="all">All platforms</option>
                          {platformBreakdown.map(p=><option key={p.platform} value={p.platform}>{p.platform}</option>)}
                        </Sel>
                      </div>
                      <div>
                        <div style={{fontSize:11,fontWeight:600,color:T.textMuted,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>From</div>
                        <input type="date" value={clearRangeStart} onChange={e=>setClearRangeStart(e.target.value)}
                          style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"7px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                      </div>
                      <div>
                        <div style={{fontSize:11,fontWeight:600,color:T.textMuted,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>Through</div>
                        <input type="date" value={clearRangeEnd} onChange={e=>setClearRangeEnd(e.target.value)}
                          style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"7px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                      </div>
                    </div>
                    {(()=>{
                      const matches=mergedNormRows.filter(clearRangeMatch);
                      const campaignCount=new Set(matches.map(r=>campaignKey(r.campaign_group_name,r.campaign_name))).size;
                      const spend=matches.reduce((s,r)=>s+r.spend,0);
                      const hasRange=clearRangeStart||clearRangeEnd;
                      return(
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
                          <div style={{fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}>
                            {hasRange?`${matches.length.toLocaleString()} row${matches.length===1?"":"s"} · ${campaignCount.toLocaleString()} campaign${campaignCount===1?"":"s"} · ${fmt$(spend)} match this range`:"Pick a start and/or end date to see what matches"}
                          </div>
                          <Btn onClick={clearDateRangeData} variant="danger" size="sm" T={T} disabled={!hasRange||!matches.length} style={{flexShrink:0}}>Clear range</Btn>
                        </div>
                      );
                    })()}
                  </div>
                )}
                {rowSection({
                  title:"Clear Budget data",
                  desc:"Removes every budget allocation, segment, and annotation dimension across all years. Tagged campaign data is kept.",
                  stat:`${budgetSegs.toLocaleString()} budget row${budgetSegs===1?"":"s"} across ${budgetYears} year${budgetYears===1?"":"s"}`,
                  action:clearBudgetData,label:"Clear Budget data",disabled:!budgetSegs,
                })}
                <div style={{marginTop:8,paddingTop:20,borderTop:`1px solid ${T.border}`}}>
                  {rowSection({
                    title:"Delete all data",
                    desc:"Clears Tagger data AND Budget data at once — everything above, in one step. Theme and layout preferences are kept.",
                    stat:"This is the only irreversible action on this page — there's no undo.",
                    action:clearAllData,label:"Delete all data",disabled:!mergedNormRows.length&&!Object.keys(tags).length&&!budgetSegs,
                  })}
                </div>
                <div style={{marginTop:8,paddingTop:20,borderTop:`1px solid ${T.border}`}}>
                  <div style={{border:`1px solid ${T.border}`,borderRadius:8,background:T.surface,padding:"20px 22px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:20}}>
                    <div>
                      <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>Delete your PaidHQ account</div>
                      <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",maxWidth:480}}>Permanently deletes the login itself ({session?.user?.email}) — not just this workspace, every workspace you're in across all of PaidHQ. This is different from "Sign out," which only forgets this account in this browser.</div>
                      <div style={{fontSize:12,color:T.textMuted,marginTop:8,fontFamily:"'DM Sans',sans-serif"}}>Blocked if this account is the sole owner of any workspace — transfer ownership or delete those workspaces first.</div>
                    </div>
                    <Btn onClick={()=>{setDeleteAccountOpen(true);setDeleteAccountConfirmText("");setDeleteAccountError("");}} variant="danger" size="sm" T={T} style={{flexShrink:0}}>Delete account</Btn>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      </main>

      </div>

      {/* ── IMPORT PRE-LOGIN LOCAL DATA ── */}
      {localImportPrompt&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{width:"100%",maxWidth:440,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15,fontWeight:700,color:T.text}}>Import your existing data?</div>
            <div style={{padding:20,fontSize:13,color:T.textSub,lineHeight:1.6}}>
              This browser has BudgetHQ data from before you signed in — {localImportPrompt.rows.length?`${localImportPrompt.rows.length.toLocaleString()} spend rows, `:""}{Object.keys(localImportPrompt.tags).length?`${Object.keys(localImportPrompt.tags).length.toLocaleString()} tagged campaigns, `:""}{Object.keys(localImportPrompt.budgets).length?"budget allocations":""}.
              <br/><br/>
              Import it into <strong style={{color:T.text}}>{workspace?.name}</strong>? This only happens once — if you skip it, this local data stays in your browser but won't be brought in automatically later.
            </div>
            <div style={{padding:"14px 20px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8}}>
              <Btn onClick={dismissLegacyLocalData} variant="ghost" T={T}>Start fresh instead</Btn>
              <Btn onClick={importLegacyLocalData} variant="primary" T={T}>Import into {workspace?.name}</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE WORKSPACE (type-to-confirm) ── */}
      {deleteWorkspaceOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{width:"100%",maxWidth:440,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15,fontWeight:700,color:T.danger}}>Delete "{workspace?.name}"?</div>
            <div style={{padding:20}}>
              <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,marginBottom:14}}>This permanently deletes every spend row, tag, budget, file, version, and AI chat in this workspace, for everyone on the team. There's no undo.</div>
              <div style={{fontSize:12,fontWeight:600,color:T.textMuted,marginBottom:6}}>Type <strong style={{color:T.text}}>{workspace?.name}</strong> to confirm</div>
              <input autoFocus value={deleteWorkspaceConfirmText} onChange={e=>{setDeleteWorkspaceConfirmText(e.target.value);setDeleteWorkspaceError("");}}
                onKeyDown={e=>{if(e.key==="Enter"&&deleteWorkspaceConfirmText.trim()===workspace?.name)confirmDeleteWorkspace();if(e.key==="Escape")setDeleteWorkspaceOpen(false);}}
                style={{width:"100%",boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:T.text,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
              {deleteWorkspaceError&&<div style={{marginTop:8,fontSize:12,color:T.danger}}>{deleteWorkspaceError}</div>}
            </div>
            <div style={{padding:"14px 20px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8}}>
              <Btn onClick={()=>setDeleteWorkspaceOpen(false)} variant="ghost" T={T}>Cancel</Btn>
              <Btn onClick={confirmDeleteWorkspace} variant="danger" T={T} disabled={deleteWorkspaceSaving||deleteWorkspaceConfirmText.trim()!==workspace?.name}>{deleteWorkspaceSaving?"Deleting…":"Delete workspace"}</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE ACCOUNT (type-to-confirm) ── */}
      {deleteAccountOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{width:"100%",maxWidth:440,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15,fontWeight:700,color:T.danger}}>Delete this account?</div>
            <div style={{padding:20}}>
              <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,marginBottom:14}}>This permanently deletes the <strong style={{color:T.text}}>{session?.user?.email}</strong> login — you'll lose access to every workspace it belongs to, everywhere in PaidHQ. There's no undo.</div>
              <div style={{fontSize:12,fontWeight:600,color:T.textMuted,marginBottom:6}}>Type <strong style={{color:T.text}}>{session?.user?.email}</strong> to confirm</div>
              <input autoFocus value={deleteAccountConfirmText} onChange={e=>{setDeleteAccountConfirmText(e.target.value);setDeleteAccountError("");}}
                onKeyDown={e=>{if(e.key==="Enter"&&deleteAccountConfirmText.trim().toLowerCase()===(session?.user?.email||"").toLowerCase())confirmDeleteAccount();if(e.key==="Escape")setDeleteAccountOpen(false);}}
                style={{width:"100%",boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:T.text,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
              {deleteAccountError&&<div style={{marginTop:8,fontSize:12,color:T.danger}}>{deleteAccountError}</div>}
            </div>
            <div style={{padding:"14px 20px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8}}>
              <Btn onClick={()=>setDeleteAccountOpen(false)} variant="ghost" T={T}>Cancel</Btn>
              <Btn onClick={confirmDeleteAccount} variant="danger" T={T} disabled={deleteAccountSaving||deleteAccountConfirmText.trim().toLowerCase()!==(session?.user?.email||"").toLowerCase()}>{deleteAccountSaving?"Deleting…":"Delete account"}</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── NAME CURRENT VERSION ── */}
      {nameVersionOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{width:"100%",maxWidth:400,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15,fontWeight:700,color:T.text}}>Name current version</div>
            <div style={{padding:20}}>
              <div style={{fontSize:12,color:T.textSub,marginBottom:10}}>Saves a snapshot of everything — Tagger and Budget data — as it is right now, so you can come back to this exact point later.</div>
              <input autoFocus value={nameVersionInput} onChange={e=>setNameVersionInput(e.target.value)} placeholder="e.g. Before Q3 revision" onKeyDown={e=>{if(e.key==="Enter")saveNamedVersion();if(e.key==="Escape")setNameVersionOpen(false);}}
                style={{width:"100%",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:T.text,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
            </div>
            <div style={{padding:"14px 20px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8}}>
              <Btn onClick={()=>{setNameVersionOpen(false);setNameVersionInput("");}} variant="ghost" T={T}>Cancel</Btn>
              <Btn onClick={saveNamedVersion} disabled={!nameVersionInput.trim()} variant="primary" T={T}>Save version</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── EMAIL A COPY ── */}
      {emailExportOpen&&exportableView&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{width:"100%",maxWidth:420,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15,fontWeight:700,color:T.text}}>Email {exportableView.label}</div>
            <div style={{padding:20,display:"flex",flexDirection:"column",gap:14}}>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:T.textSub,marginBottom:5}}>To</div>
                <input autoFocus type="email" value={emailExportTo} onChange={e=>setEmailExportTo(e.target.value)} placeholder="name@company.com"
                  style={{width:"100%",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:T.text,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif",boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:T.textSub,marginBottom:5}}>Format</div>
                <div style={{display:"flex",gap:6}}>
                  {EXPORT_FORMATS.map(f=>(
                    <button key={f.key} onClick={()=>setEmailExportFormat(f.key)}
                      style={{flex:1,padding:"7px 0",borderRadius:6,border:`1.5px solid ${emailExportFormat===f.key?T.accentHover:T.border}`,background:emailExportFormat===f.key?T.accent:"transparent",color:emailExportFormat===f.key?T.text:T.textMuted,fontSize:12,fontWeight:emailExportFormat===f.key?700:500,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:T.textSub,marginBottom:5}}>Note <span style={{fontWeight:400,color:T.textMuted}}>(optional)</span></div>
                <textarea value={emailExportNote} onChange={e=>setEmailExportNote(e.target.value)} placeholder="Add a message for the recipient…" rows={3}
                  style={{width:"100%",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"'DM Sans',sans-serif",resize:"vertical",boxSizing:"border-box"}}/>
              </div>
              {emailError&&<div style={{fontSize:12,color:T.danger,background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,borderRadius:7,padding:"8px 10px"}}>{emailError}</div>}
            </div>
            <div style={{padding:"14px 20px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8}}>
              <Btn onClick={()=>{setEmailExportOpen(false);setEmailError("");}} variant="ghost" T={T} disabled={emailSending}>Cancel</Btn>
              <Btn onClick={sendEmailExport} disabled={emailSending||!emailExportTo.trim()} variant="primary" T={T}>{emailSending?"Sending…":"Send email"}</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── VERSION HISTORY ── */}
      {versionHistoryOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{width:"100%",maxWidth:520,maxHeight:"85vh",background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd,display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:15,fontWeight:700,color:T.text}}>Version history</div>
                <div style={{fontSize:12,color:T.textSub,marginTop:2}}>Saved automatically after imports and data clears, or manually via ⋯ → Name current version.</div>
              </div>
              <button onClick={()=>setVersionHistoryOpen(false)} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22,lineHeight:1,fontFamily:"'DM Sans',sans-serif"}}>×</button>
            </div>
            <div style={{flex:1,overflow:"auto",padding:"8px 12px"}}>
              {versionsLoading?(
                <div style={{display:"flex",alignItems:"center",gap:8,color:T.textSub,fontSize:13,padding:"20px 8px"}}>
                  <span style={{width:14,height:14,border:`2px solid ${T.border}`,borderTopColor:T.accent,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/> Loading versions…
                </div>
              ):versions.length===0?(
                <div style={{padding:"32px 20px",textAlign:"center",color:T.textMuted,fontSize:13}}>No saved versions yet. They're created automatically after imports and data clears — or save one now from ⋯ → Name current version.</div>
              ):(
                groupVersionsByDay(versions).map(g=>(
                  <div key={g.label} style={{marginBottom:14}}>
                    <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.textMuted,padding:"8px 8px 4px"}}>{g.label}</div>
                    {g.items.map(v=>(
                      <div key={v.id} onClick={()=>restoreVersion(v)}
                        style={{display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:8,cursor:"pointer"}}
                        className="bhq-row">
                        <Icon name={v.trigger==="manual"?"save":v.trigger?.startsWith("pre_")?"alert":"clock"} size={14} color={T.textMuted}/>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,color:T.text,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{v.label}</div>
                          <div style={{fontSize:11,color:T.textMuted}}>{new Date(v.timestamp).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})}</div>
                        </div>
                        <button onClick={e=>{e.stopPropagation();restoreVersion(v);}} style={{fontSize:11,fontWeight:600,color:T.accent,background:"transparent",border:`1px solid ${T.accentBorder}`,borderRadius:6,padding:"4px 9px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",flexShrink:0}}>Restore</button>
                        <button onClick={e=>deleteVersion(v.id,e)} title="Delete this version"
                          style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:5,color:T.textMuted,cursor:"pointer",fontSize:12,lineHeight:1,padding:0,flexShrink:0}}>✕</button>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {spendConflictReview&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:210,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:620,maxHeight:"85vh"}} contentStyle={{background:T.surface,padding:0,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:15,fontWeight:700,color:T.text,display:"flex",alignItems:"center",gap:8}}><Icon name="alert" size={16} color={T.warning}/> This import disagrees with synced data</div>
              <div style={{fontSize:12,color:T.textSub,marginTop:4,lineHeight:1.6}}><strong style={{color:T.text}}>{spendConflictReview.conflicts.length}</strong> row{spendConflictReview.conflicts.length===1?"":"s"} in this import have a spend that doesn't match what's already synced from a live platform connection for the same campaign and date. By default the synced value is kept — check a row below to overwrite it with the imported value instead.</div>
            </div>
            <div style={{flex:1,overflow:"auto",padding:22}}>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {spendConflictReview.conflicts.map((c,i)=>{
                  const useImported=spendConflictReview.useImportedSet.has(c.key);
                  return(
                    <label key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",borderRadius:8,border:`1px solid ${T.border}`,cursor:"pointer",background:useImported?T.warningBg:"transparent"}}>
                      <input type="checkbox" checked={useImported} onChange={()=>toggleUseImported(c.key)} style={{marginTop:3,cursor:"pointer",accentColor:T.accent,width:14,height:14,flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,color:T.text,fontWeight:600,marginBottom:4}}>{c.campaignGroupName&&c.campaignGroupName!==c.campaignName?`${c.campaignGroupName} · `:""}{c.campaignName} — {c.date}</div>
                        <div style={{fontSize:12,color:T.textMuted,lineHeight:1.6}}>Synced from <strong style={{color:T.textSub}}>{c.syncedPlatform}</strong>: <strong style={{color:T.text}}>{fmt$(c.syncedSpend)}</strong> · This import says: <strong style={{color:useImported?T.warning:T.text}}>{fmt$(c.importedSpend)}</strong></div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
            <div style={{padding:"14px 22px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",gap:8}}>
              <Btn onClick={cancelSpendConflictImport} variant="ghost" T={T}>Cancel import</Btn>
              <Btn onClick={confirmSpendConflictImport} variant="primary" T={T}>Continue to tagging →</Btn>
            </div>
          </PixelPanel>
        </div>
      )}

      {tagImportPreview&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:210,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:560,maxHeight:"85vh"}} contentStyle={{background:T.surface,padding:0,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:15,fontWeight:700,color:T.text}}>Review tag import</div>
              <div style={{fontSize:12,color:T.textSub,marginTop:2}}>Matched <strong style={{color:T.text}}>{tagImportPreview.matchedCount}</strong> campaign{tagImportPreview.matchedCount===1?"":"s"}{tagImportPreview.skippedCount>0?` · skipped ${tagImportPreview.skippedCount} row${tagImportPreview.skippedCount===1?"":"s"} with no campaign name`:""}.</div>
            </div>
            <div style={{flex:1,overflow:"auto",padding:22}}>
              {tagImportPreview.sample.length>0&&(
                <div style={{marginBottom:tagImportPreview.newDims.length?18:0}}>
                  <div style={{fontSize:11,fontWeight:700,color:T.textMuted,textTransform:"uppercase",letterSpacing:0.4,marginBottom:8}}>Campaigns being tagged</div>
                  <div style={{fontSize:12,color:T.textSub,lineHeight:1.8}}>
                    {tagImportPreview.sample.map((s,i)=><div key={i}>{s}</div>)}
                    {tagImportPreview.matchedCount>tagImportPreview.sample.length&&<div style={{color:T.textMuted}}>+{tagImportPreview.matchedCount-tagImportPreview.sample.length} more</div>}
                  </div>
                </div>
              )}
              {tagImportPreview.newDims.length>0&&(
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:T.textMuted,textTransform:"uppercase",letterSpacing:0.4,marginBottom:8}}>New tag dimensions detected</div>
                  <div style={{fontSize:12,color:T.textSub,marginBottom:10,lineHeight:1.6}}>These columns don't match any dimension you're already tracking. Uncheck any that shouldn't be added.</div>
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {tagImportPreview.newDims.map(d=>(
                      <label key={d} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,border:`1px solid ${T.border}`,cursor:"pointer",background:tagImportPreview.includedNewDims.has(d)?T.accentBg:"transparent"}}>
                        <input type="checkbox" checked={tagImportPreview.includedNewDims.has(d)} onChange={()=>toggleNewTagDim(d)} style={{cursor:"pointer",accentColor:T.accent,width:14,height:14,flexShrink:0}}/>
                        <span style={{fontSize:13,color:T.text,fontWeight:600}}>{d}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div style={{padding:"14px 22px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",gap:8}}>
              <Btn onClick={cancelTagImport} variant="ghost" T={T}>Cancel</Btn>
              <Btn onClick={confirmTagImport} variant="primary" T={T}>✓ Apply tags</Btn>
            </div>
          </PixelPanel>
        </div>
      )}

      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        html,body{height:100%;width:100%;overflow:hidden;}
        #root{height:100%;width:100%;display:flex;flex-direction:column;}
        body{font-family:'DM Sans',sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;}
        input,select,button,textarea{font-family:'DM Sans',sans-serif;}
        input::placeholder{color:${T.textMuted};}
        select option{background:${T.surface};color:${T.text};}
        ::-webkit-scrollbar{width:5px;height:5px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:${T.borderStrong};border-radius:3px;}
        /* Overlay-style scrollbar for the left sidebar column — invisible until you're actually
           scrolling/hovering it, like macOS's overlay scrollbars. A thin gray bar sitting there at
           rest reads as a permanent UI element even when there's nothing to indicate; hiding it by
           default and revealing it on hover keeps the column looking clean without losing the
           affordance once someone's interacting with it. */
        .bhq-scroll::-webkit-scrollbar-thumb{background:transparent;}
        .bhq-scroll:hover::-webkit-scrollbar-thumb{background:${T.borderStrong};}
        @keyframes spin{to{transform:rotate(360deg);}}
        /* Ask AI's mic button while recording (2026-07-28, per Mo's voice-input request) — a
           simple opacity pulse rather than a scale/glow effect, consistent with how understated
           the rest of the app's motion is (spin above is the only other animation anywhere). */
        @keyframes bhqPulse{0%,100%{opacity:1;}50%{opacity:0.35;}}
        @media(max-width:768px){input,select{font-size:16px!important;}}
        /* Dashboard onboarding hero's space-station illustration (2026-07-26, per Mo) — decorative
           only (aria-hidden), so it's fine to just drop it on narrow windows rather than reflow
           around it. */
        @media(max-width:860px){.bhq-hero-illustration{display:none!important;}}
        /* Hover feedback — the app is styled almost entirely with inline styles (each element's
           own background is set inline per its state), so a plain CSS class can't win the
           cascade against that without !important. These are intentionally scoped to elements
           that opt in via className, so they never fight the "active/selected" inline states. */
        .bhq-btn:not(:disabled):hover{filter:brightness(0.96);}
        .bhq-tab:hover{background:${T.surfaceHover} !important;color:${T.text} !important;}
        .bhq-iconbtn:hover{background:${T.surfaceHover} !important;}
        .bhq-row:hover{background:${T.surfaceHover} !important;}
        .bhq-tr:hover td{background:${T.rowHover} !important;}
      `}</style>
    </div>
  );
}
