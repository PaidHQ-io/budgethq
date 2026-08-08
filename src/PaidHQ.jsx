import { useState, useMemo, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { classifyImportFile, IMPORT_TYPE_LABELS } from "./lib/fileTypeDetect.js";
import { extractReportingRowsFromPdf } from "./lib/reportingAI.js";
import { parseCampaignReportFile } from "./lib/reportingImport.js";
import { parsePipelineFileRaw, CHANNEL_TAG_KEY, PIPELINE_METRIC_MAP_OPTIONS } from "./lib/pipelineColumnMapping.js";
import { CUSTOM_METRIC_OPERATORS, computeCustomMetric, formulaPreview, fmtMetric } from "./lib/reportingMetrics.js";
import { listReportingFacts, deleteReportingFacts } from "./lib/reportingApi.js";
import { normalizePeriodStart } from "./lib/reportingPeriods.js";
import {
  getWorkspaceConfig, putWorkspaceConfig, getSpendRows, putSpendRows,
  getAskAIData, putAskAIData,
  listVersions, saveVersion, deleteVersion as apiDeleteVersion,
  listFiles, uploadFile as apiUploadFile, uploadFileViaBlob, deleteFile as apiDeleteFile, downloadFile as apiDownloadFile, fileToBase64, fetchFileBlob,
  copyFileToWorkspace, authHeader, renameFile as apiRenameFile,
} from "./lib/workspaceApi";
import { listMembers, updateMemberRole, removeMember, listInvites, inviteMember, revokeInvite, renameWorkspace, deleteWorkspace, deleteAccount, listConnections, saveConnectionCredential, patchConnection, deleteConnection, startOAuth, getOAuthAccounts, saveOAuthAccount, syncSpend, previewConnector } from "./lib/coreApi";
import { exportReportToGoogleSheets, preloadGoogleSheetsApi, preloadGoogleSheetsPicker } from "./lib/googleSheets";
import {
  THEME, THEME_CLASSIC, THEME_AIDA, THEME_MIDNIGHT, THEME_NOTION, REQUIRED_COLS, OPTIONAL_COLS, COL_LABELS, campaignKey, isEmptyConfig, splitFilterTerms,
  matchesTerms, getBudgetDimValues, DEFAULT_DIMS, LEGACY_LOCAL_KEYS, PLATFORM_COLORS, PLATFORM_OPTIONS,
  TAG_DIM_COLORS, NAV, autoDetect, derivePlatform, localISODate, fmtCalendarDate, fmt$, downloadCSV,
  groupVersionsByDay, fmtFileSize, normalizeRows, spendRowKey, mergeRows, detectSpendConflicts,
  parseSpendDate, consolidateBudgetSegKeys, computePlatformFreshness,
  renameDimensionValue, GOOGLE_SUBCHANNELS, groupGooglePlatform, migrateGoogleChannelGrouping,
  setDecimalAdjust as setGlobalDecimalAdjust,
} from "./lib/core.js";
import { EXPORTABLE_VIEWS, EXPORT_FORMATS, buildReportBlob, downloadReport, blobToBase64 } from "./lib/reports.js";
import {
  SectionLabel, Pill, GoogleAdsMark, BingMark, CsvMark, ScreenshotMark, PlatformLogo, Btn, Inp, Sel, StatRow,
  MatchModeToggle, IconField, TagAutocompleteInput, Divider, Icon, PixelPanel, WarnTip, NameFileModal,
} from "./components/shared.jsx";
import { useGoogleSheetConnect } from "./hooks/useGoogleSheetConnect.js";
import { usePersistentState } from "./lib/persist.js";
import { cn } from "./lib/utils.js";
import { Card, CardContent } from "./components/ui/card.jsx";
import { Badge } from "./components/ui/badge.jsx";
import { Button } from "./components/ui/button.jsx";
import { Checkbox } from "./components/ui/checkbox.jsx";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "./components/ui/select.jsx";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/ui/table.jsx";
import {
  Plus, X, File, PencilSimple, DownloadSimple, PaperPlaneTilt, Trash, Check,
  MagnifyingGlass, Question, CaretDown, CaretRight, DotsThree, Export as ExportIcon, EnvelopeSimple, FloppyDisk, ClockCounterClockwise,
  Gauge, Database, ListChecks, Tag, Wallet, ChartBar, FunnelSimple, Target, Funnel, Compass, Sparkle, Lock, Gear, Lightning,
  SidebarSimple,
} from "@phosphor-icons/react";
import { NavItem } from "./components/ui/nav-item.jsx";

// Sidebar nav icons (2026-08-07, Venture retheme) — Phosphor, matching every other icon in the
// retheme (see icons.jsx/Dashboard.jsx's own doc comments on why Phosphor is the icon source for
// anything newly matched to this kit) rather than the old shared.jsx Icon component's hand-drawn
// SVG set, which would have looked visually inconsistent sitting in a NavItem right next to
// Phosphor-based icons everywhere else in the retheme.
const NAV_ICONS={
  dashboard:Gauge,data:Database,dataAudit:ListChecks,tagger:Tag,budget:Wallet,pacing:ChartBar,
  reportingAnalyzer:FunnelSimple,pipelineTagger:MagnifyingGlass,goalsObjectives:Target,
  campaignAudit:Funnel,accountPlanning:Compass,changeHistory:ClockCounterClockwise,vault:Lock,ask:Sparkle,
};

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
// ReportingHQ folded back into PaidHQ as a tab (2026-07-30, per Mo — running it as a separate
// product meant constantly re-porting shared UI, like the Data Sources connector grid, into two
// codebases). Covers Dreamdata/PowerBI funnel/pipeline performance data (core.reporting_facts) —
// distinct from this tab's own Data Sources connectors, which already cover ad-platform spend.
const ReportingAnalyzer = lazy(() => import("./components/ReportingAnalyzer.jsx"));
// Pipeline Tagger (2026-08-01, per Mo — a Campaign-Tagger-equivalent for reporting_facts data:
// tag every imported PowerBI/Dreamdata/HubSpot/Salesforce row with the same tag_dims vocabulary
// Campaign Tagger uses, kept entirely separate from that spend data — see the component's own doc
// comment for why this never touches platform spend/budget).
const PipelineTagger = lazy(() => import("./components/PipelineTagger.jsx"));
// Goals & Objectives (2026-08-01, per Mo — minimal first pass: a read-only view over reporting_facts
// rows the unified Data Sources uploader classified as "goals". See the component's own doc
// comment for why this doesn't have its own storage yet.
const GoalsObjectives = lazy(() => import("./components/GoalsObjectives.jsx"));
// Change History (2026-08-19, per Mo — a filterable log of campaign/ad-group/budget changes across
// every channel, automated where a platform's API supports it, manually logged everywhere else. See
// the component's own doc comment for the full scope/reasoning.
const ChangeHistory = lazy(() => import("./components/ChangeHistory.jsx"));
// Data Audit tab (2026-07-31, per Mo — "I need a new tab where I can review in detail what data
// has been brought into PaidHQ and from where"). Read-only view over mergedNormRows; no data of
// its own to fetch, so lazy-loading it costs nothing beyond the chunk itself.
const DataAudit = lazy(() => import("./components/DataAudit.jsx"));
// Ads mode for Campaign Tagger (2026-08-19, per Mo — ad-level tagging for paid social channels).
// A separate component rather than more inline code in this already-huge file, and a separate data
// path from Campaigns mode's own mergedNormRows/campaigns useMemo below — see the component's own
// doc comment for the full reasoning (independent adKey identity, own aggregate-endpoint fetch).
const AdTagger = lazy(() => import("./components/AdTagger.jsx"));
// Vault (2026-08-19, per Mo — folding VaultHQ's document/resource storage into PaidHQ as its own
// tab; Phase 1 of 2 confirmed via AskUserQuestion — storage/resources now, Ask AI grounding later).
// See Vault.jsx's own doc comment for what's in/out of scope this phase.
const Vault = lazy(() => import("./components/Vault.jsx"));
// Account Planning (2026-08-06, per Mo — restructure/rebuild-an-account planning: design a target
// taxonomy, map old structure to new). No longer receives mergedNormRows/combineGoogleChannels/
// tags/tagDims/adTags (2026-08-07) — those were only ever used by its Audit step, which moved out to
// its own tab (CampaignAudit, right below) per Mo's "it shouldn't live under campaign planning."
const AccountPlanning = lazy(() => import("./components/AccountPlanning.jsx"));
// Campaign Audit (2026-08-07, per Mo — "the audit section, let's get rid of that altogether [from
// Account Planning]... we can move the audit to another section of PaidHQ"). Same "self-contained
// tab, own reporting_facts fetch" shape Account Planning's Audit step used to have — this component
// IS that step, just promoted to its own top-level tab and stripped of plan-scoped state (no
// auditDecisions, no Add-to-Mapping — see the component's own doc comment).
const CampaignAudit = lazy(() => import("./components/CampaignAudit.jsx"));

// Minimal, theme-matched fallback while a lazily-loaded tab chunk is still fetching — deliberately
// plain (no logo/branding) since this only ever shows for a moment on a cold chunk load.
const TabLoadingFallback = () => (
  <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:60,color:THEME.textMuted,fontSize:13*(THEME.fsScale||1),fontFamily:THEME.font}}>
    <span style={{width:14,height:14,border:`2px solid ${THEME.border}`,borderTopColor:THEME.accent,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block",marginRight:8}}/>
    Loading…
  </div>
);

// Settings → "Clear Pipeline data" date-range mode picks whole months (same <input type="month">
// convention Pipeline Tagger/Reporting Intelligence already use); the DELETE endpoint itself wants a
// real end-of-month date so a row dated anywhere within the selected end month is still included.
function pipelineMonthEndDate(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of next month = last day of this month
}

// Save & one-click reapply (2026-08-06, per Mo — "I need a way to save the files that I upload...
// with one click apply them/import them into PaidHQ... really it should apply to any file"). The
// File Store (api/workspaces/[id]/files.js / core.files) has no metadata/JSON column of its own —
// that table's schema lives in the separate paidhq-core repo, not this one, so adding a column
// wasn't an option here. Instead, a per-import "config" (column mapping, resolved period, platform
// override, etc. — whatever that flow needs to pre-fill its OWN review screen later) rides as a
// second, linked FILE in the same File Store: a tiny JSON blob named after the data file's own id,
// filed under a reserved category so it never shows up as a real file in the visible list (see
// Settings' File Store rendering, which filters this category out) — no schema migration needed.
const IMPORT_CONFIG_CATEGORY = "__import_config__";
const importConfigFileName = (dataFileId) => `.paidhq-import-config-${dataFileId}.json`;
// archiveFile's blob-vs-base64 size cutoff (2026-08-19, per Mo — a >10MB manual "Add file" upload
// was failing with a generic "request failed", really Vercel's hard 4.5MB serverless function
// body limit — see blob-upload-token.js's doc comment). Module-level, not per-render state, since
// it's a fixed constant — keeps archiveFile's useCallback dependency array honest.
const BLOB_UPLOAD_THRESHOLD = 3 * 1024 * 1024;
// Browser-safe UTF-8 -> base64 (btoa alone chokes on non-Latin1 characters e.g. a smart quote in a
// filename) — same escape/unescape trick used broadly for this exact problem.
function base64EncodeJson(value) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function PaidHQ({session,onSignOut,workspace,workspaces,onSwitchWorkspace,onCreateWorkspace,accounts,activeAccountKey,onSwitchAccount,onAddAccount,onSignOutAccount,onWorkspacesChanged}={}){
  // Appearance (2026-07-31, per Mo — bought a "finance dashboard" Tailwind mockup and wanted its
  // look as a switchable second theme, with an easy way back). Device-local (usePersistentState =
  // localStorage), same as the tab/filter preferences elsewhere — not workspace data, so it
  // doesn't sync across devices or need a server round-trip, and switching workspaces doesn't
  // reset it. Settings' Appearance card (see the Settings view below) is the only place this is
  // ever written; everywhere else in this file just reads T same as it always has, so this is a
  // one-line change from the app's perspective.
  const[themeName,setThemeName]=usePersistentState("paidhq_theme","classic");
  const T=themeName==="aida"?THEME_AIDA:themeName==="midnight"?THEME_MIDNIGHT:themeName==="notion"?THEME_NOTION:THEME_CLASSIC;
  const[accountMenuOpen,setAccountMenuOpen]=useState(false);
  const[workspaceMenuOpen,setWorkspaceMenuOpen]=useState(false);
  // 2026-08-07 (per Mo's direct comparison against Venture's reference) — Venture's sidebar Logo row
  // has a collapse/expand toggle (the "Slider" node, a CaretDoubleHorizontal button) that this shell
  // rebuild had dropped entirely. Collapsing fully hides the 240px rail rather than shrinking to an
  // icon-only rail — BudgetHQ's NAV items don't have an icon-only rendering mode built yet, and a
  // full hide/show is still a faithful, working version of the same affordance.
  const[primaryNavCollapsed,setPrimaryNavCollapsed]=useState(false);
  // "Budget & Actuals" nav group (2026-08-07, per Mo) — folds Budget Panel + Budget Pacing under
  // one expandable parent (Venture's Emails→General/Analytics pattern). Default open so both stay
  // one click away; the two view keys ("budget"/"pacing") are unchanged.
  const[budgetGroupOpen,setBudgetGroupOpen]=useState(true);
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
  // Stats sidebar width (2026-08-07, per Mo — "just like the first one but adjust depending on
  // screen size. I don't want users to be able to slide the size larger or smaller"). No longer
  // user-draggable/persisted; it's a responsive value derived from the viewport, clamped to a
  // sensible min/max, recomputed on window resize below. The primary nav is a fixed 240px, so this
  // tracks near that on typical screens but narrows on small ones and widens a little on large ones.
  const computeStatsWidth=()=>{
    if(typeof window==="undefined")return 240;
    return Math.round(Math.min(300,Math.max(210,window.innerWidth*0.18)));
  };
  const[statsWidth,setStatsWidth]=useState(computeStatsWidth);
  const statsResizing=useRef(false); // retained (always false now) so existing transition guards below keep working
  const[budgetSidebarEl,setBudgetSidebarEl]=useState(null); // portal target inside <aside> for the Budget tab's controls
  const[pacingSidebarEl,setPacingSidebarEl]=useState(null); // portal target inside <aside> for the Reporting tab's controls
  const[askSidebarEl,setAskSidebarEl]=useState(null); // portal target inside <aside> for Ask AI's search/projects/labels/pinned-chats panel — replaces the generic "Total spend" stat tiles that used to show here (not relevant to Ask AI, see 2026-07-21 UX note)
  const[reportingAnalyzerSidebarEl,setReportingAnalyzerSidebarEl]=useState(null); // portal target inside <aside> for Pipeline Tagger's own tagged/filtered overview (2026-08-03, per Mo — same reasoning as askSidebarEl above, the generic ad-spend stat tiles never applied to reporting_facts data)
  const[pipelineTaggerSidebarEl,setPipelineTaggerSidebarEl]=useState(null); // portal target inside <aside> for Reporting Intelligence's Period/Metrics/Summary controls (2026-08-04, per Mo — "works like the budget pacing tab", same portal pattern as pacingSidebarEl above)
  const[goalsObjectivesSidebarEl,setGoalsObjectivesSidebarEl]=useState(null); // portal target inside <aside> for Goals & Objectives' own tagged/filtered overview (2026-08-19) — same reasoning as reportingAnalyzerSidebarEl above, just for the goals-scoped ReportingFactsTagger instance instead of the pipeline one
  const[changeHistorySidebarEl,setChangeHistorySidebarEl]=useState(null); // portal target inside <aside> for Change History's own overview (2026-08-19) — same reasoning as goalsObjectivesSidebarEl above
  const[vaultSidebarEl,setVaultSidebarEl]=useState(null); // portal target inside <aside> for Vault's own overview (2026-08-19) — same reasoning as changeHistorySidebarEl above
  const[accountPlanningSidebarEl,setAccountPlanningSidebarEl]=useState(null); // portal target inside <aside> for Account Planning's step nav (2026-08-07, per Mo — "make it the width of campaign tagger and include the second vertical column"); previously accountPlanning was special-cased to a zero-width/no-content sidebar (see that branch's own doc comment below) — this gives it a real one, same pattern as every other Tailwind-and-legacy-alike tab
  useEffect(()=>{
    const onResize=()=>setStatsWidth(computeStatsWidth());
    window.addEventListener("resize",onResize);
    return()=>window.removeEventListener("resize",onResize);
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
  // PLATFORM_OPTIONS moved to core.js (2026-08-03) — shared with Pipeline Tagger's new Channel
  // column editor so both surfaces offer exactly the same platform list.
  const[mergedNormRows,setMergedNormRows]=useState([]); // normalized rows across ALL platform uploads
  const[tagDims,setTagDims]=useState(DEFAULT_DIMS);
  const[tags,setTags]=useState({});
  // Campaign Tagger's Ads mode (2026-08-19) — own tag storage, own identity (adKey, not
  // campaignKey), saved as a parallel key in the same workspace_config blob as `tags` (see
  // workspaceApi.js's config-shape doc comment). taggerMode is deliberately NOT persisted
  // (session-only, defaults back to Campaigns on reload) — it's a view toggle, not data.
  const[adTags,setAdTags]=useState({});
  const[taggerMode,setTaggerMode]=useState("campaigns");
  const[selected,setSelected]=useState(new Set());
  const[newDim,setNewDim]=useState("");
  const[tagsHistory,setTagsHistory]=useState([]); // undo stack, max 50
  const[editingTag,setEditingTag]=useState(null); // {campaign, dim}
  const[editVal,setEditVal]=useState("");
  const[applyDim,setApplyDim]=useState("");
  const[applyVal,setApplyVal]=useState("");
  const[dragOver,setDragOver]=useState(false);
  const[notif,setNotif]=useState(null);
  // Campaign Tagger's sort + filter state, persisted to localStorage (2026-07-30, per Mo —
  // "whatever screen with whatever filters on any tab I've selected" should survive a refresh).
  // selectedTagFilters is handled separately just below (it's a Set, not JSON-friendly on its own).
  const[sortCol,setSortCol]=usePersistentState("paidhq_tagger_sortCol","spend");
  const[sortDir,setSortDir]=usePersistentState("paidhq_tagger_sortDir","desc");
  const[fCamp,setFCamp]=usePersistentState("paidhq_tagger_fCamp","");
  const[fCampExclude,setFCampExclude]=usePersistentState("paidhq_tagger_fCampExclude","");
  const[fGroup,setFGroup]=usePersistentState("paidhq_tagger_fGroup","");
  const[fGroupExclude,setFGroupExclude]=usePersistentState("paidhq_tagger_fGroupExclude","");
  const[fPlat,setFPlat]=usePersistentState("paidhq_tagger_fPlat","");
  const[fSMin,setFSMin]=usePersistentState("paidhq_tagger_fSMin","");
  const[fSMax,setFSMax]=usePersistentState("paidhq_tagger_fSMax","");
  const[fTag,setFTag]=usePersistentState("paidhq_tagger_fTag","");
  const[fTagExclude,setFTagExclude]=usePersistentState("paidhq_tagger_fTagExclude","");
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
  const[fGroupInclMode,setFGroupInclMode]=usePersistentState("paidhq_tagger_fGroupInclMode","or");
  const[fGroupExclMode,setFGroupExclMode]=usePersistentState("paidhq_tagger_fGroupExclMode","or");
  const[fCampInclMode,setFCampInclMode]=usePersistentState("paidhq_tagger_fCampInclMode","or");
  const[fCampExclMode,setFCampExclMode]=usePersistentState("paidhq_tagger_fCampExclMode","or");
  const[fTagInclMode,setFTagInclMode]=usePersistentState("paidhq_tagger_fTagInclMode","or");
  const[fTagExclMode,setFTagExclMode]=usePersistentState("paidhq_tagger_fTagExclMode","or");
  // Set of "dim:val" — kept as a plain useState (Sets aren't JSON-friendly) with its own
  // localStorage read/write below instead of going through usePersistentState, same array<->Set
  // bridging pattern already used for Budget Panel's hiddenRollupDims.
  const[selectedTagFilters,setSelectedTagFilters]=useState(()=>{
    try{const v=JSON.parse(localStorage.getItem("paidhq_tagger_selectedTagFilters")||"[]");return new Set(Array.isArray(v)?v:[]);}catch{return new Set();}
  });
  useEffect(()=>{try{localStorage.setItem("paidhq_tagger_selectedTagFilters",JSON.stringify([...selectedTagFilters]));}catch{/* ignore */}},[selectedTagFilters]);
  const toggleTagFilter=useCallback((dim,val)=>{
    const key=`${dim}:${val}`;
    setSelectedTagFilters(p=>{const nx=new Set(p);nx.has(key)?nx.delete(key):nx.add(key);return nx;});
  },[]);
  const[fStatus,setFStatus]=usePersistentState("paidhq_tagger_fStatus","all");
  const[filtersOpen,setFiltersOpen]=useState(()=>{try{const v=localStorage.getItem("paidhq_tagger_filters_open");return v===null?true:v==="1";}catch(e){return true;}});
  useEffect(()=>{try{localStorage.setItem("paidhq_tagger_filters_open",filtersOpen?"1":"0");}catch(e){}},[filtersOpen]);
  const fileRef=useRef();
  const unifiedFileRef=useRef();
  const screenshotRef=useRef();
  const[screenshotProcessing,setScreenshotProcessing]=useState(false);
  const[screenshotError,setScreenshotError]=useState("");
  const[screenshotPreview,setScreenshotPreview]=useState([]); // rows extracted from an image, pending confirm
  const[screenshotFileName,setScreenshotFileName]=useState("");
  // Monthly-grain "accurate through" for screenshot imports (2026-07-30, per Mo — the CSV path has
  // had this since 2026-07-24 via uploadIsMonthly/uploadAsOf, but screenshots never got the same
  // treatment, so a screenshot of a monthly dashboard landed with no as_of_date at all and
  // immediately read as stale — computePlatformFreshness falls back to the row's own date, which
  // for a monthly row is just the 1st of the month, not "today"). Separate state from
  // uploadIsMonthly/uploadAsOf (not reused) since those already get reset at the end of a CSV
  // import — sharing one pair of state variables across both flows would let a setting from one
  // leak into the other.
  const[screenshotIsMonthly,setScreenshotIsMonthly]=useState(false);
  const[screenshotAsOf,setScreenshotAsOf]=useState("");
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

  // Unified upload handoff (2026-08-01, per Mo — "one upload surface in Data Sources, route by
  // file content" instead of separate CSV/budget/pipeline upload buttons scattered across tabs).
  // Same one-shot relay pattern as pendingAskQuestion/pendingViewConfig above: the Data Sources
  // upload handler classifies a file, then for "budget"/"pipeline"/"goals" types it can't finish
  // the import itself (budget's wizard lives inside BudgetManager; pipeline/goals' review table
  // lives inside ReportingAnalyzer, and neither is necessarily mounted right now) — it stashes
  // the handoff payload here and switches tabs, and the destination tab consumes-and-clears it on
  // mount via onConsumeInitial.../initialImportFile props, same as initialQuestion/initialViewConfig.
  const[pendingBudgetImportFile,setPendingBudgetImportFile]=useState(null); // a raw File
  const[pendingReportingRows,setPendingReportingRows]=useState(null); // already-extracted/parsed rows, or null
  // Raw (un-mapped) pipeline CSV/XLSX handoff — {headers,rows,sourceLabel} or null. Separate from
  // pendingReportingRows above because a pipeline CSV/XLSX (2026-08-02, per Mo's column-mapping
  // request) needs a mapping step inside ReportingAnalyzer before it becomes normalized rows; PDFs
  // and screenshots still go straight to pendingReportingRows since reportingAI.js already derives
  // its own metric keys per column during extraction. See pipelineColumnMapping.js's top doc comment.
  const[pendingReportingRawImport,setPendingReportingRawImport]=useState(null);
  // Goals import handoff (2026-08-19, REBUILT per Mo — "duplicate the process of importing a budget
  // file... same popup and UX"): now mirrors pendingBudgetImportFile exactly — a raw, un-parsed File —
  // instead of pre-parsed {headers,rows}. GoalsImportWizard.jsx (modeled on BudgetManager's own Import
  // modal) does its own header-row detection/picking internally, the same way BudgetManager does for
  // pendingBudgetImportFile, rather than PaidHQ.jsx parsing it up front the way the old
  // PipelineColumnMapper-based flow used to.
  const[pendingGoalsImportFile,setPendingGoalsImportFile]=useState(null);

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
  // Pipeline Tagger / Reporting Intelligence's own Custom Dimensions + Saved Views (2026-08-17, per
  // Mo — "build reports based on filtering and then custom dimensions... save a whole bunch of
  // views for easy access"). Same "lives at this top level only to ride the shared debounced
  // config save" reasoning as savedViews right above — see PipelineTagger.jsx's own top doc comment
  // for the full two-tier design (dimensions = named saved filter rules; views = full report
  // snapshots that reference a dimension by id plus this tab's own metric/grain/chart config).
  const[pipelineDimensions,setPipelineDimensions]=useState([]);
  const[pipelineViews,setPipelineViews]=useState([]);
  // Global default forecast model (item 45, 2026-07-25) — the workspace-wide fallback used by
  // computePacing whenever a segment has no per-row override (budgetRowMeta[sk]._forecastModel).
  // Lives at this same top level, rides the same debounced save, for the same reason savedViews
  // does above: a single value the whole workspace shares, not something scoped to one tab's UI
  // state. Defaults to "auto" (2026-07-25, was "full-period" before the Auto/Manual/Committed
  // redesign — see FORECAST_MODELS in lib/core.js) — the same default computePacing itself falls
  // back to, so an unconfigured workspace gets the adaptive model out of the box.
  const[defaultForecastModel,setDefaultForecastModel]=useState("auto");
  // Workspace-wide "combine Google sub-channels" setting (2026-07-30, per Mo; reshaped 2026-07-31
  // from a single on/off toggle to a per-channel choice — some workspaces want everything folded
  // into one "Google" line, others want everything broken out, others want some mix like "combine
  // everything except YouTube"; different workspaces, different preferences, so this lives here
  // rather than as a fixed app-wide behavior). Same tier as defaultForecastModel above — a
  // workspace-shared setting, not per-tab UI state. Shape is {channelName: true} for each
  // GOOGLE_SUBCHANNELS entry the workspace has chosen to combine — see migrateGoogleChannelGrouping
  // for how a legacy boolean or brand-new workspace becomes this shape on load. Applies everywhere
  // Platform shows up as a grouping/breakdown dimension: Budget Panel, Reporting & Pacing, Ask AI,
  // Campaign Tagger, and the Data Sources "Spend by platform" widget — see groupGooglePlatform in
  // lib/core.js for where this actually takes effect.
  const[combineGoogleChannels,setCombineGoogleChannels]=useState(()=>migrateGoogleChannelGrouping(false));

  // Number formatting (2026-08-06, per Mo — "give users the ability to increase or decrease the
  // decimal of any numbered/dollar value field"). Workspace-shared, same tier as
  // combineGoogleChannels above — a report built with 2-decimal precision should look the same to
  // everyone else on the team, not just the person who set it. The actual number is just an
  // integer "how many decimals beyond each value type's own baseline" (0 = today's existing
  // behavior — whole dollars, whole numbers, 1-decimal percentages) — see core.js's
  // setDecimalAdjust/getDecimalAdjust for why this rides as a plain module-level variable those
  // shared formatters read directly instead of a prop threaded through every table in the app.
  const[decimalAdjust,setDecimalAdjust]=useState(0);
  useEffect(()=>{setGlobalDecimalAdjust(decimalAdjust);},[decimalAdjust]);
  // Budget Panel chart color (2026-08-08, per Mo — "universal color pick + presets ... saved and
  // persistent on the server"). A single workspace-level hex, persisted in the same config blob as
  // decimalAdjust/defaultForecastModel below (load, payload, latestConfigRef, and save deps all
  // include it). "" falls back to the default grey in BudgetManager. Same tier as the other
  // appearance prefs — workspace data, not device-local.
  const[budgetChartColor,setBudgetChartColor]=useState("");

  // Custom metrics (2026-08-08, per Mo — "allow users to create custom fields for cost/lead,
  // cost/demo, cost/SQL, cost/pipeline dollar generated, pipeline dollar generated/spend, demo -> MQL
  // conversion rate, MQL -> SQL conversion rate, etc."). Workspace-shared, same tier as tags/budgets
  // — a formula built by one teammate should show up for everyone. Each entry is
  // { key, label, format:"money"|"pct"|"number", terms:[{field,op},...] }, evaluated by
  // reportingMetrics.js's computeCustomMetric against Performance Intelligence's already-SUMMED
  // canonical absolutes (see that file's own doc comment for why no operator precedence is needed).
  // Only consumed by PipelineTagger.jsx today (Performance Intelligence) — that's the only tab with
  // the canonical funnel absolutes (spend/leads/demos/mqls/sqls/pipeline_value/...) these formulas
  // are built from.
  const[customMetrics,setCustomMetrics]=useState([]);
  // Add/edit modal state for the above — null editKey means "creating new"; editing an existing
  // metric keeps its stable `key` (so it stays selected wherever a teammate already toggled it on
  // in Performance Intelligence's metric picker) and only replaces label/format/terms.
  const[customMetricModalOpen,setCustomMetricModalOpen]=useState(false);
  const[customMetricEditKey,setCustomMetricEditKey]=useState(null);
  const[customMetricName,setCustomMetricName]=useState("");
  const[customMetricFormat,setCustomMetricFormat]=useState("money");
  const[customMetricTerms,setCustomMetricTerms]=useState([{field:"spend",op:null},{field:"leads",op:"/"}]);
  const[customMetricError,setCustomMetricError]=useState("");
  const openAddCustomMetric=()=>{
    setCustomMetricEditKey(null);
    setCustomMetricName("");
    setCustomMetricFormat("money");
    setCustomMetricTerms([{field:"spend",op:null},{field:"leads",op:"/"}]);
    setCustomMetricError("");
    setCustomMetricModalOpen(true);
  };
  const openEditCustomMetric=(cm)=>{
    setCustomMetricEditKey(cm.key);
    setCustomMetricName(cm.label);
    setCustomMetricFormat(cm.format||"number");
    setCustomMetricTerms((cm.terms&&cm.terms.length?cm.terms:[{field:"spend",op:null},{field:"leads",op:"/"}]).map(t=>({...t})));
    setCustomMetricError("");
    setCustomMetricModalOpen(true);
  };
  const addCustomMetricTerm=()=>setCustomMetricTerms(prev=>[...prev,{field:PIPELINE_METRIC_MAP_OPTIONS[0].key,op:"/"}]);
  const removeCustomMetricTerm=(i)=>setCustomMetricTerms(prev=>prev.length>2?prev.filter((_,idx)=>idx!==i):prev);
  const updateCustomMetricTerm=(i,patch)=>setCustomMetricTerms(prev=>prev.map((t,idx)=>idx===i?{...t,...patch}:t));
  // Slugifies the name into a stable key, deduping against every OTHER custom metric's key (not
  // against this one's own current key when editing, so re-saving under the same name doesn't
  // collide with itself) — this key is what Performance Intelligence's metrics array/columns key
  // off of, so it needs to be unique and to never change once teammates may have it toggled on.
  const slugifyCustomMetricKey=(name)=>{
    const base="custom_"+(name.trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"metric");
    const others=customMetrics.filter(cm=>cm.key!==customMetricEditKey).map(cm=>cm.key);
    let key=base,n=2;
    while(others.includes(key)){key=`${base}_${n}`;n++;}
    return key;
  };
  const saveCustomMetric=()=>{
    const name=customMetricName.trim();
    if(!name){setCustomMetricError("Give this metric a name.");return;}
    if(customMetricTerms.some(t=>!t.field)){setCustomMetricError("Every term needs a field selected.");return;}
    const key=customMetricEditKey||slugifyCustomMetricKey(name);
    const next={key,label:name,format:customMetricFormat,terms:customMetricTerms.map((t,i)=>({field:t.field,op:i===0?null:(t.op||"/")}))};
    setCustomMetrics(prev=>{
      const exists=prev.some(cm=>cm.key===key);
      return exists?prev.map(cm=>cm.key===key?next:cm):[...prev,next];
    });
    setCustomMetricModalOpen(false);
  };
  const deleteCustomMetric=(key)=>setCustomMetrics(prev=>prev.filter(cm=>cm.key!==key));
  // Sample values for the modal's live preview — realistic-looking round numbers spanning every
  // canonical field a formula might reference, so a preview is always computable regardless of
  // which fields the user picks (2026-08-08, per Mo's "user picks per metric" formatting answer —
  // seeing the actual $/%/number rendering before saving is what makes that choice meaningful).
  const CUSTOM_METRIC_PREVIEW_SUMS={spend:10000,leads:500,mqas:300,handraisers:120,demos:80,free_trials:60,pqls:40,meetings_booked:70,mqls:150,sals:90,sqls:50,closed_won:12,closed_lost:28,pipeline_value:240000,revenue:96000};

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
  // ── Settings → Clear Pipeline data (server-backed core.reporting_facts rows — 2026-08-06, per Mo:
  // "move the deletion section to settings along with the other delete functions." Previously this
  // was its own "Bulk delete…" button + modal inside Pipeline Tagger's toolbar; moved here so it sits
  // next to Clear Tagger data/Clear Tagger data by channel/by date range/Clear Budget data instead of
  // living apart from every other destructive action in the app. Same DELETE /reporting-facts
  // endpoint as before (see reportingApi.js's deleteReportingFacts doc comment) — only the UI moved. ──
  const[pipelineRows,setPipelineRows]=useState(null); // null = not loaded yet
  const[pipelineRowsLoading,setPipelineRowsLoading]=useState(false);
  const refreshPipelineRows=useCallback(()=>{
    if(!workspace?.id||!session)return;
    setPipelineRowsLoading(true);
    listReportingFacts(session,workspace.id).then(setPipelineRows).catch(e=>console.error("[pipeline rows list]",e)).finally(()=>setPipelineRowsLoading(false));
  },[workspace?.id,session]);
  const[pdMode,setPdMode]=useState("date"); // "date" | "source" | "tag" | "channel" | "all"
  const[pdStart,setPdStart]=useState("");
  const[pdEnd,setPdEnd]=useState("");
  const[pdSource,setPdSource]=useState("");
  const[pdTagDim,setPdTagDim]=useState("");
  const[pdTagValue,setPdTagValue]=useState("");
  const[pdChannel,setPdChannel]=useState("");
  const[pdConfirmText,setPdConfirmText]=useState("");
  const[pdDeleting,setPdDeleting]=useState(false);
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
    refreshPipelineRows();
  },[view,workspace?.id,refreshFileStore,refreshTeam,refreshPipelineRows]);
  // Fire-and-forget wrapper for the auto-capture call sites (handleFile, exportTags,
  // importTagsFromCSV below) — a File Store write should never block or fail the actual
  // import/export it's shadowing. Files over BLOB_UPLOAD_THRESHOLD (module-level, above) go
  // straight to Vercel Blob instead of base64-through-the-function; everyday CSV/XLSX imports
  // stay on the faster single-request base64 path below that.
  const archiveFile=useCallback((file,category,customName)=>{
    if(!file||!workspace?.id||!session)return Promise.resolve(null);
    const name=customName||file.name||"untitled";
    if(file.size>BLOB_UPLOAD_THRESHOLD){
      return uploadFileViaBlob(session,workspace.id,file,{category,name})
        .catch(e=>{console.error("[file store save]",e);return null;});
    }
    return fileToBase64(file)
      .then(dataBase64=>apiUploadFile(session,workspace.id,{name,category,mimeType:file.type||"",dataBase64}))
      .catch(e=>{console.error("[file store save]",e);return null;});
  },[workspace?.id,session]);
  // Writes the linked "how to pre-fill this flow's review screen next time" sidecar for a just-
  // archived data file — see IMPORT_CONFIG_CATEGORY's doc comment above for why this rides as a
  // second File Store record instead of a real metadata column. Fire-and-forget, same as
  // archiveFile itself — a failed sidecar write just means a future "Apply" on this file starts
  // from a fresh guess instead of the exact prior mapping, never blocks or fails the import it's
  // shadowing.
  const archiveImportConfig=useCallback((dataFileId,metadata)=>{
    if(!dataFileId||!workspace?.id||!session)return Promise.resolve(null);
    return apiUploadFile(session,workspace.id,{
      name:importConfigFileName(dataFileId),category:IMPORT_CONFIG_CATEGORY,mimeType:"application/json",
      dataBase64:base64EncodeJson(metadata),
    }).catch(e=>{console.error("[import config save]",e);return null;});
  },[workspace?.id,session]);
  // The one shared choke point every real file-import entry point (spend CSV/XLSX, tag CSV, budget
  // CSV/XLSX, pipeline CSV/XLSX) now routes through (2026-08-06, per Mo — "force the user to rename
  // (or save the same name) upon import"): shows the NameFileModal, then archives the file under
  // whatever name was confirmed. Resolves to null if the user cancels (callers should bail out
  // without processing the file at all), or {name, fileId} once archived — fileId is null if
  // archiving itself failed (no workspace/session, or a network error already logged by
  // archiveFile), in which case the import still proceeds under the chosen name, just without a
  // File Store record to attach a later "Apply" config to.
  const[pendingNamedFile,setPendingNamedFile]=useState(null); // {file, defaultName, onConfirm, onCancel}
  const promptAndArchiveFile=useCallback((file,category)=>{
    if(!file)return Promise.resolve(null);
    // Defaults to the LAST saved name for this SAME category (2026-08-08, per Mo — "save the name
    // of the last file that was saved so we can just make minor edits to it (e.g. the next month)
    // instead of rewriting the whole name again") rather than the raw uploaded filename, which is
    // usually a meaningless browser-generated one like "data (17).xlsx". fileStoreList is already
    // sorted newest-first (see its own "sorted newest-first" comment above), so the first record
    // matching this category IS the last one saved for it. Falls back to the raw filename the first
    // time a given category is ever named (nothing to reuse yet).
    const lastForCategory=fileStoreList.find(f=>f.category===category);
    return new Promise(resolve=>{
      setPendingNamedFile({
        file,defaultName:lastForCategory?.name||file.name,
        onConfirm:(name)=>{
          setPendingNamedFile(null);
          archiveFile(file,category,name).then(record=>resolve({name,fileId:record?.id||null}));
        },
        onCancel:()=>{setPendingNamedFile(null);resolve(null);},
      });
    });
  },[archiveFile,fileStoreList]);
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
  // Rename (2026-08-17, per Mo — "I need a way of editing the names of all stored files"). Same
  // inline-edit shape AskAI.jsx's own chat-title rename uses (renamingXId/renamingXTitle + a commit
  // function that trims/no-ops on blank, Enter to commit, Escape to cancel) — one row turns its
  // name into an autofocused input rather than opening a modal, since this is a quick single-field
  // edit, not a multi-field form. Updates fileStoreList in place on success (matching every other
  // File Store mutation's own optimistic-refresh pattern) rather than a full refreshFileStore()
  // round-trip, since the PATCH response already carries the corrected record.
  const[renamingFileId,setRenamingFileId]=useState(null);
  const[renamingFileName,setRenamingFileName]=useState("");
  const commitFileRename=useCallback((id,name)=>{
    setRenamingFileId(null);
    const trimmed=(name||"").trim();
    const current=fileStoreList.find(f=>f.id===id);
    if(!trimmed||!current||trimmed===current.name)return;
    apiRenameFile(session,workspace.id,id,trimmed)
      .then(updated=>{setFileStoreList(prev=>prev.map(f=>f.id===id?{...f,name:updated.name}:f));showNotif(`Renamed to ${updated.name}`);})
      .catch(e=>window.alert(e.message||"Couldn't rename this file."));
  },[session,workspace?.id,fileStoreList]);
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
    promptAndArchiveFile(file,"Manual upload").then(named=>{
      if(!named)return;
      refreshFileStore();
      showNotif(`Saved ${named.name} to File Store`);
    });
  },[promptAndArchiveFile,refreshFileStore]);

  // ── Export (CSV/XLSX/PDF/HTML downloads + email) ──
  const[emailExportOpen,setEmailExportOpen]=useState(false);
  const[emailExportFormat,setEmailExportFormat]=useState("pdf");
  const[emailExportTo,setEmailExportTo]=useState("");
  const[emailExportNote,setEmailExportNote]=useState("");
  const[emailSending,setEmailSending]=useState(false);
  const[emailError,setEmailError]=useState("");

  const buildSnapshot=useCallback(()=>({tags,adTags,tagDims,mergedNormRows,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta}),
    [tags,adTags,tagDims,mergedNormRows,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta]);
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
    setTags(s.tags||{});setAdTags(s.adTags||{});setTagDims(s.tagDims||DEFAULT_DIMS);setMergedNormRows(s.mergedNormRows||[]);
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

  // One-time import of pre-auth localStorage data — anyone who used PaidHQ before login/
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
        setAdTags(config.adTags||{});
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
        setPipelineDimensions(config.pipelineDimensions||[]);
        setPipelineViews(config.pipelineViews||[]);
        setDefaultForecastModel(config.defaultForecastModel||"auto");
        // Migrates a legacy boolean (the old all-or-nothing toggle) to the new per-channel object
        // shape, or fills in any channel added to GOOGLE_SUBCHANNELS since this workspace last
        // saved — see migrateGoogleChannelGrouping's own doc comment for exactly what each case
        // preserves. Safe to run on every load; a no-op once a workspace is already on the new shape.
        setCombineGoogleChannels(migrateGoogleChannelGrouping(config.combineGoogleChannels));
        setDecimalAdjust(config.decimalAdjust||0);
        setCustomMetrics(config.customMetrics||[]);
        setBudgetChartColor(config.budgetChartColor||"");
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
  useEffect(()=>{latestConfigRef.current={tags,adTags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta,savedViews,pipelineDimensions,pipelineViews,defaultForecastModel,combineGoogleChannels,decimalAdjust,customMetrics,budgetChartColor};});
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

  // ── Concurrency guard for the spend-rows save (2026-08-05, per Mo — found via a Google Sheets
  // "why is my data stale" report that turned into discovering core.spend_rows was 67% duplicate
  // rows across EVERY platform, not just the one being investigated) ─────────────────────────────
  // putSpendRows (workspaceApi.js) does a whole-dataset "replace" for a small workspace, but once a
  // workspace's history is too big to fit one request it CHUNKS: the first chunk deletes-then-
  // inserts, every chunk after that is append-only (see spend-rows.js's PUT doc comment for why —
  // an append-only continuation can't wipe out the earlier chunks THIS SAME save already wrote).
  // That's safe for one save running alone, but the debounced effect below had nothing stopping a
  // SECOND save from starting while a first one's chunk sequence was still mid-flight (any
  // mergedNormRows change — a sync, a tag edit, even the next chunk of a wide-range sync's own
  // per-chunk setMergedNormRows calls — resets the 800ms timer and, once it fires, kicks off
  // another full save independent of whether the previous one finished). Two overlapping saves each
  // still open with a real delete (harmless — whichever's delete lands last just wins), but their
  // append-only chunks after that both insert their own copy of the same rows on top of each other.
  // N overlapping saves means every non-first-chunk row gets duplicated N times — which is exactly
  // what turned up: content-identity counts clustering at exactly 3x and 5x across Bing, Google,
  // LinkedIn, Meta, and Capterra alike, not just whatever was being actively synced that day.
  //
  // savingRowsRef marks a chunk sequence as in flight; rowsSaveQueuedRef records "something changed
  // while that was running" instead of firing a second save on top of it — the in-flight save's own
  // completion handler checks this flag and immediately runs one more save (against latestRowsRef,
  // i.e. whatever's current BY THEN, not a stale snapshot from when the change happened) rather than
  // ever letting two chunk sequences run at once. Net effect: saves are now strictly serialized, so
  // no edit is ever lost, it's just queued instead of parallelized.
  const savingRowsRef=useRef(false);
  const rowsSaveQueuedRef=useRef(false);

  // Runs one save cycle against whatever's currently in latestRowsRef. Shared by the debounce timer
  // below and flushPendingSaves (the beforeunload/tab-hide flush) so there's exactly one code path
  // that's allowed to call putSpendRows — see the concurrency-guard comment above for why a second
  // path calling it independently would reintroduce the same overlapping-save bug.
  const runRowsSave=useCallback(()=>{
    if(savingRowsRef.current){
      rowsSaveQueuedRef.current=true;
      return;
    }
    const rows=latestRowsRef.current||[];
    const rowsEmpty=rows.length===0;
    if(rowsEmpty&&hadRealRowsRef.current&&!allowEmptyRowsWriteRef.current){
      console.error("[spend rows save] BLOCKED — refusing to overwrite known real spend data with an empty payload. This save was skipped, not sent; nothing on the server changed. If you meant to clear this workspace's spend data, use Settings → Clear data instead of whatever just triggered this.");
      return;
    }
    allowEmptyRowsWriteRef.current=false;
    savingRowsRef.current=true;
    putSpendRows(sessionRef.current,workspace.id,rows)
      .then(()=>{rowsDirtyRef.current=false;if(!rowsEmpty)hadRealRowsRef.current=true;})
      .catch(e=>console.error("[spend rows save]",e)) // stays flagged dirty — next flush/edit retries it
      .finally(()=>{
        savingRowsRef.current=false;
        // Something changed mid-save — run the queued save now (serialized, not parallel) instead
        // of waiting for whatever timer would otherwise fire next.
        if(rowsSaveQueuedRef.current){
          rowsSaveQueuedRef.current=false;
          runRowsSave();
        }
      });
  },[workspace?.id]);

  // Debounced whole-document save — mirrors the shape api/workspaces/[id]/data.js's PUT expects.
  // Keyed off sessionUserId, not session itself — see the big comment above the load effect.
  useEffect(()=>{
    if(!workspace?.id||!session||!configLoadedRef.current)return;
    configDirtyRef.current=true;
    clearTimeout(saveConfigTimer.current);
    saveConfigTimer.current=setTimeout(()=>{
      const payload={tags,adTags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta,savedViews,pipelineDimensions,pipelineViews,defaultForecastModel,combineGoogleChannels,decimalAdjust,customMetrics,budgetChartColor};
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
  },[tags,adTags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,budgetImportMeta,savedViews,pipelineDimensions,pipelineViews,defaultForecastModel,combineGoogleChannels,decimalAdjust,customMetrics,budgetChartColor,workspace?.id,sessionUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced whole-dataset replace for spend rows — see spend-rows.js PUT doc comment for why
  // replace-all (not incremental) is the sync model here. Actual save logic lives in runRowsSave
  // above (shared with flushPendingSaves) — this effect's only job is debouncing rapid-fire changes
  // down to one runRowsSave call 800ms after they settle.
  useEffect(()=>{
    if(!workspace?.id||!session||!rowsLoadedRef.current)return;
    rowsDirtyRef.current=true;
    clearTimeout(saveRowsTimer.current);
    saveRowsTimer.current=setTimeout(runRowsSave,800);
    return()=>clearTimeout(saveRowsTimer.current);
  },[mergedNormRows,workspace?.id,sessionUserId,runRowsSave]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // savingRowsRef check (2026-08-05, per Mo — see runRowsSave's concurrency-guard doc comment
    // above): a debounced save could already be mid-chunk-sequence when the tab hides/unloads. This
    // keepalive flush firing its OWN putSpendRows call on top of that would be exactly the
    // overlapping-save scenario that caused the 3x/5x duplicate clustering in core.spend_rows in the
    // first place — skipped here rather than risking that, even though it means an edit inside the
    // last ~800ms before an in-flight save started could still be lost on a fast unload. rowsDirtyRef
    // stays true in that case, so the next load's save cycle picks it up instead of it just vanishing.
    if(rowsDirtyRef.current&&latestRowsRef.current&&!savingRowsRef.current){
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
  // 7 days — the widest window empirically confirmed (2026-08-05, live test against
  // paidhq-core's /api/spend) to reliably avoid the "Failed to fetch" oversized-response failure
  // on ad-level LinkedIn/Meta pulls. See syncPlatform's doc comment below for the full story.
  const SYNC_CHUNK_DAYS=7;
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
    // Daily-sync workaround for Google Ads accounts stuck behind Google's OAuth brand-verification
    // review (2026-07-31, per Mo) — NOT the same thing as the "sheets"/isSheets entry below (that's
    // a one-time manual pull with no stored credential; this is a real live connector, synced daily
    // just like Bing/LinkedIn/Meta, just reading a public Google Sheet instead of an ad platform API
    // directly). Some OTHER tool (Google Ads' own Sheets export, Supermetrics, an Apps Script, etc.)
    // has to land spend data into that sheet on its own schedule — PaidHQ only reads it.
    {key:"googlesheets",label:"Google Sheets (Ads workaround)",status:"live",perWorkspaceAuth:true,color:"#0F9D58",desc:"Daily sync from a public Google Sheet — works around Google Ads OAuth verification",domain:"sheets.google.com",
      connectNote:"1) In the Sheet: File → Share → change to \"Anyone with the link\" → Viewer. 2) Paste that link below and click Preview sheet — you'll get a chance to check (or fix) which column is which before connecting. The sheet needs Campaign Group Name, Spend, and Date columns at minimum (same as a CSV upload); add a Campaign Type column (Search/Display/Demand Gen/Performance Max) too if you want an accurate breakdown — without it, every row is reported as Google Search. Something else (Google Ads' own Sheets export, Supermetrics, Apps Script, etc.) needs to keep the sheet updated — PaidHQ only reads it, once a day.",
      connectFields:[
        {key:"sheetUrl",label:"Google Sheet URL",placeholder:"https://docs.google.com/spreadsheets/d/.../edit#gid=0"},
      ]},
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
  // Status filter for the "Add data source" grid's left rail (2026-08-07, Venture retheme) — matches
  // Venture's Integration page's CATEGORIES rail structurally, but BudgetHQ's connectors don't carry
  // real categories, so this filters by connection status instead (All/Connected/Not connected).
  const[dataSourceStatusFilter,setDataSourceStatusFilter]=useState("all");
  useEffect(()=>{if(view!=="data")setDataSourcesSubView("connections");},[view]);
  const[lastSyncRange,setLastSyncRange]=useState(()=>{
    try{const s=localStorage.getItem("paidhq_sync_range");return s?JSON.parse(s):null;}catch(e){return null;}
  });
  // Defaults to Jan 1 of the current year through YESTERDAY — matches the "This year" preset below
  // (2026-07-24, per Mo: quarter-to-date was too narrow a default for a first sync; 2026-08-05, per
  // Mo: end date moved from today to yesterday — today's data is always a partial day mid-sync, and
  // a partial day's spend skews the pacing/forecast math the same way a half-loaded platform does.
  // Every platform connector already reports real, complete days — this just stops the DEFAULT
  // range from asking for one that hasn't finished yet. Someone who genuinely wants today's
  // (partial) numbers can still pick it via the Custom tab below; this only changes what "Sync now"
  // asks for out of the box).
  const yesterday=(now)=>{const d=new Date(now);d.setDate(d.getDate()-1);return localISODate(d);};
  const[syncDateRange,setSyncDateRange]=useState(()=>{
    const now=new Date();
    return{start:localISODate(new Date(now.getFullYear(),0,1)),end:yesterday(now)};
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
    // Same "stop at yesterday, not today" reasoning as the default range above — applies to every
    // preset, not just "This year", since a partial today skews forecasting the same way regardless
    // of how far back the range starts.
    const end=yesterday(now);
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

  // Data Sources connector table's "Pause import" / "Don't use data in PaidHQ" actions (2026-07-24)
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
        if(flags.excludedFromData!==undefined)showNotif(flags.excludedFromData?`${label}'s data is hidden from PaidHQ — reversible any time.`:`${label}'s data is back in PaidHQ.`);
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

  // Google Sheets (Ads workaround) connector's "Setup guide" modal (2026-07-31, per Mo) — the
  // connect panel's connectNote is a couple sentences; getting spend INTO the sheet in the first
  // place (PaidHQ only ever reads it) needs real step-by-step instructions for the two realistic
  // ways to do that, which don't fit inline. Lives here rather than a separate docs page since
  // someone only needs this exactly when they're mid-setup on this one connector.
  const[googleSheetsGuideOpen,setGoogleSheetsGuideOpen]=useState(false);
  const[connectPanelKey,setConnectPanelKey]=useState(null); // which platform's connect form is open, or null
  const[connectValues,setConnectValues]=useState({});
  // connectPairs holds the guided-form state for "keyvaluelist" fields (currently just Capterra's
  // apiKeys — one Product name + API key row per product) — {fieldKey: [{label,value},...]}.
  // Kept separate from connectValues (which holds a single string per field for every other
  // connector) because a field's whole point here is "list of pairs", not one value.
  const[connectPairs,setConnectPairs]=useState({});
  const[connectSaving,setConnectSaving]=useState(false);
  const[connectError,setConnectError]=useState("");
  // Google Sheets column-mapping review step (2026-07-31, per Mo) — sheetPreview holds what the
  // server actually saw when it fetched the sheet (headers/auto-detected guess/a sample row);
  // sheetColumnMap is the user-adjustable {field: header} the mapping dropdowns write to, seeded
  // from sheetPreview.colMap but editable before Connect is clicked. Both null/empty means "haven't
  // previewed yet" — the connect panel shows a "Preview sheet" button instead of the mapping table
  // until then. Reused for both the initial connect flow AND "Adjust mapping" on an already-
  // connected sheet (see openAdjustMapping below) — same panel, same state, the only difference is
  // whether connectValues.sheetUrl/sheetColumnMap start pre-filled from the existing connection.
  const[sheetPreview,setSheetPreview]=useState(null);
  const[sheetPreviewLoading,setSheetPreviewLoading]=useState(false);
  const[sheetColumnMap,setSheetColumnMap]=useState({});

  const openConnectPanel=platformKey=>{
    setConnectPanelKey(platformKey);setConnectValues({});setConnectPairs({});setConnectError("");
    setSheetPreview(null);setSheetColumnMap({});
  };
  // Re-opens the connect panel for an ALREADY-connected Google Sheet, pre-filled with its current
  // sheetUrl, and immediately re-previews it so the mapping table shows up right away instead of
  // making the user click "Preview sheet" again for a sheet PaidHQ already knows about. Seeds
  // sheetColumnMap from whatever's currently saved (conn.columnMap, from SAFE_SUMMARY) rather than
  // the freshly auto-detected guess, so re-opening this doesn't silently discard a prior manual
  // override — falls back to the fresh guess only if nothing was saved yet (pre-mapping-feature
  // connections). Triggered from the connections table's ⋯ menu.
  const openAdjustMapping=useCallback(async conn=>{
    const sheetUrl=conn?.summary?.sheetUrl;
    if(!sheetUrl)return;
    setConnectPanelKey("googlesheets");setConnectValues({sheetUrl});setConnectPairs({});setConnectError("");
    setSheetPreview(null);setSheetColumnMap({});
    setSheetPreviewLoading(true);
    try{
      const result=await previewConnector(session,"googlesheets",{sheetUrl});
      setSheetPreview(result);
      setSheetColumnMap(conn?.summary?.columnMap&&Object.keys(conn.summary.columnMap).length?conn.summary.columnMap:(result.colMap||{}));
    }catch(e){
      setConnectError(e.message);
    }finally{
      setSheetPreviewLoading(false);
    }
  },[session]); // eslint-disable-line react-hooks/exhaustive-deps
  // Fields the mapping table shows dropdowns for, in the same order/vocabulary as core.js's
  // REQUIRED_COLS/OPTIONAL_COLS and the googlesheets connector's own COL_PATTERNS — required ones
  // block Connect until mapped, optional ones can be left as "— Not in this sheet —".
  const GSHEET_FIELDS=[
    {key:"campaign_group_name",label:"Campaign Group Name",required:true},
    {key:"spend",label:"Spend",required:true},
    {key:"date",label:"Date",required:true},
    {key:"campaign_name",label:"Campaign Name",required:false},
    {key:"platform",label:"Platform",required:false},
    {key:"campaign_type",label:"Campaign Type",required:false},
    {key:"campaign_id",label:"Campaign ID",required:false},
    {key:"adset_id",label:"Ad Set ID",required:false},
    {key:"impressions",label:"Impressions",required:false},
    {key:"clicks",label:"Clicks",required:false},
  ];
  const handlePreviewSheet=useCallback(async()=>{
    const sheetUrl=(connectValues.sheetUrl||"").trim();
    if(!sheetUrl){setConnectError("Paste a Google Sheet link first.");return;}
    setConnectError("");setSheetPreviewLoading(true);
    try{
      const result=await previewConnector(session,"googlesheets",{sheetUrl});
      setSheetPreview(result);
      setSheetColumnMap(result.colMap||{});
    }catch(e){
      setConnectError(e.message);
      setSheetPreview(null);
    }finally{
      setSheetPreviewLoading(false);
    }
  },[connectValues.sheetUrl,session]);
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
      // Google Sheets carries the user-confirmed mapping alongside sheetUrl (2026-07-31, per Mo) —
      // only the fields actually mapped to a real header make it in, so an optional field left as
      // "— Not in this sheet —" isn't saved as an empty string (getSpend's REQUIRED_COLS check
      // treats a falsy colMap entry as "not mapped", same as if the key were absent entirely).
      if(platformKey==="googlesheets"){
        const map={};
        Object.entries(sheetColumnMap).forEach(([field,header])=>{if(header)map[field]=header;});
        credential.columnMap=map;
      }
      await saveConnectionCredential(session,workspace.id,platformKey,credential);
      setConnectedProviders(p=>({...p,[platformKey]:true}));
      setConnectPanelKey(null);
      setSheetPreview(null);setSheetColumnMap({});
      showNotif(`Connected ${PLATFORMS.find(p=>p.key===platformKey)?.label||platformKey} — click Sync to pull spend.`);
    }catch(e){
      setConnectError(e.message);
    }finally{
      setConnectSaving(false);
    }
  },[workspace?.id,session?.access_token,connectValues,connectPairs,sheetColumnMap]); // eslint-disable-line react-hooks/exhaustive-deps

  // Splits [start,end] into consecutive <=chunkDays windows (e.g. 2026-01-01..2026-01-20 with
  // chunkDays=7 -> [01-01..01-07, 01-08..01-14, 01-15..01-20]). Used by syncPlatform below — see
  // its doc comment for why.
  const splitDateRangeIntoChunks=(start,end,chunkDays)=>{
    const chunks=[];
    let cursor=new Date(`${start}T00:00:00Z`);
    const endD=new Date(`${end}T00:00:00Z`);
    while(cursor<=endD){
      const chunkStart=cursor.toISOString().slice(0,10);
      const chunkEndCandidate=new Date(cursor);
      chunkEndCandidate.setUTCDate(chunkEndCandidate.getUTCDate()+chunkDays-1);
      const chunkEndD=chunkEndCandidate>endD?endD:chunkEndCandidate;
      chunks.push({start:chunkStart,end:chunkEndD.toISOString().slice(0,10)});
      cursor=new Date(chunkEndD);
      cursor.setUTCDate(cursor.getUTCDate()+1);
    }
    return chunks;
  };
  // 2026-08-05, per Mo — a wide-date-range ad-level LinkedIn/Meta sync ("Sync now" over months of
  // data, e.g. to backfill ad_name onto rows pulled before the pivot=CREATIVE/level=ad connector
  // change) was coming back as a browser-side "Failed to fetch" even though paidhq-core's own
  // runtime logs showed /api/spend completing and returning 200. Root cause: /api/spend returns
  // the FULL pulled row set as one JSON response (no pagination/streaming) — a wide ad-level range
  // is thousands of rows, large enough that the response gets cut off in transit, which the
  // browser can't distinguish from a network failure. Confirmed live: the exact same sync
  // succeeded every time when narrowed to a 7-day range. Rather than make every user manually
  // chop their own date range into weekly pieces, syncPlatform now does that automatically —
  // /api/spend itself is untouched (still returns rows for review before the debounced whole-
  // dataset PUT persists them, same as always), this just calls it once per SYNC_CHUNK_DAYS-day
  // window instead of once for the whole range, merging each chunk's rows in as they arrive.
  // Connector table's "Import start date"/"Import end date" columns (2026-07-24) — per Mo, these
  // are read-only and auto-computed from sync history rather than a separate editable field: the
  // earliest/latest date among the rows THIS connector actually pulled (source==="sync:<provider>"),
  // read from the raw mergedNormRows (not visibleNormRows) so the range still shows correctly while
  // a connector is excluded — excluding shouldn't make its own history disappear from its own row.
  // Caveat worth knowing: rows synced before this shipped never got a `source` tag, so an
  // already-connected provider shows "—" here until its next sync backfills the tag. Declared here
  // (moved 2026-08-05, was originally further down near visibleNormRows) because syncPlatform below
  // now reads it to compute an incremental sync's start date — useCallback's dependency array is
  // evaluated during render, so referencing a const declared LATER in this function would throw
  // "Cannot access before initialization"; this has to come first.
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

  const syncPlatform=useCallback(async(platformKey,opts)=>{
    if(!canEdit)return;
    // Belt-and-suspenders alongside the sync bar disabling a paused connector's button (see
    // PLATFORMS.map's clickable/handleClick below) — blocks it here too in case this ever gets
    // called from somewhere else that doesn't check first.
    const pausedConn=connectionDetails.find(c=>c.provider===platformKey);
    if(pausedConn?.paused){showNotif(`${PLATFORMS.find(p=>p.key===platformKey)?.label||platformKey} is paused — resume it in Data Sources before syncing.`);return;}
    // Incremental by default (2026-08-05, per Mo — "I don't want to have to download the same data
    // over and over again... I want to append the data to what's already there"): Sync now used to
    // always re-walk the ENTIRE syncDateRange (the date picker above the Connections table, e.g.
    // Jan 1 -> today) in 7-day chunks every single click, no matter how much of that range this
    // platform already has data for — a platform that's been syncing daily since day one still
    // redid dozens of redundant chunk requests re-fetching months already sitting in
    // core.spend_rows untouched. Now the chunk loop's start date clamps forward to the day after
    // this platform's own latest known date (importDateRangeByProvider — the same value the
    // Connections table's Import End column reads), so a routine Sync now only pulls what's
    // actually new. Pass {forceFull:true} (wired to the ⋯ menu's "Full resync" item) to bypass
    // this and walk the whole picker range anyway — still needed for a genuine backfill/repair
    // (e.g. after reconnecting an account, or a historical data cleanup).
    const knownEnd=importDateRangeByProvider[platformKey]?.end;
    // Parses the y/m/d components directly and builds a local Date from them, rather than
    // `new Date(isoString)` (which parses a bare "YYYY-MM-DD" as UTC midnight) + setDate (which
    // reads/writes in LOCAL time) — that mismatch silently shifts the result by a day in any
    // timezone behind UTC, which would make an already-fully-synced platform (knownEnd === today)
    // compute effectiveStart === today instead of tomorrow, re-pulling today's data as if it were
    // still missing on every single Sync now click.
    const dayAfter=iso=>{const[y,m,d]=iso.split("-").map(Number);return localISODate(new Date(y,m-1,d+1));};
    const effectiveStart=(!opts?.forceFull&&knownEnd&&dayAfter(knownEnd)>syncDateRange.start)?dayAfter(knownEnd):syncDateRange.start;
    if(effectiveStart>syncDateRange.end){
      showNotif(`${PLATFORMS.find(p=>p.key===platformKey)?.label||platformKey} is already up to date through ${syncDateRange.end} — nothing new to pull.`);
      return;
    }
    setSyncState(p=>({...p,[platformKey]:"loading"}));
    // FULL-RESYNC DUPLICATION FIX (2026-08-06, found live — LinkedIn and Meta both showing ~2x
    // real spend after a Full resync): mergeRows below only overwrites a row whose identity key
    // (campaign+campaign group+date+ad_name — see spendRowKey in lib/core.js) exactly matches an
    // incoming row. If a connector's granularity ever changes (LinkedIn/Meta both switched from
    // campaign-level rows, ad_name="", to ad-level rows, ad_name=<real ad>, earlier this session),
    // the OLD rows and the NEW rows have different identities entirely — mergeRows just piles the
    // new ones on top instead of replacing anything, and the next debounced save (a whole-dataset
    // replace, see runRowsSave above) faithfully persists both, double-counting the same real
    // spend. A routine incremental "Sync now" never hits this in practice (it only ever asks for
    // days after the platform's own last-known end date, so there's nothing old to collide with),
    // but "Full resync" deliberately re-walks a wide, already-covered range — exactly where a
    // granularity change would surface. Before re-fetching, strip every existing row this exact
    // platform's sync tag owns within the range about to be re-walked (never touches CSV/
    // screenshot/other-platform rows, and never touches dates outside this resync's own range) —
    // matches the delete-then-insert semantics the cron's replaceWindow already uses server-side,
    // which is exactly why a routine daily cron sync was never able to reproduce this bug.
    if(opts?.forceFull){
      setMergedNormRows(prev=>prev.filter(r=>!(r.source===`sync:${platformKey}`&&r.date>=syncDateRange.start&&r.date<=syncDateRange.end)));
    }
    const chunks=splitDateRangeIntoChunks(effectiveStart,syncDateRange.end,SYNC_CHUNK_DAYS);
    let totalRows=0;
    let lastEffectiveEndDate=null;
    try{
      for(const chunk of chunks){
        // Moved to paidhq-core 2026-07-30 — syncSpend (lib/coreApi.js) calls the shared
        // /api/spend there instead of this app's own local route, so any product's Sync button
        // hits the same endpoint. workspaceId is harmless to always send: paidhq-core's route only
        // actually reads it for perWorkspaceAuth connectors (every live one today), same as before.
        const{rows,endDate:effectiveEndDate}=await syncSpend(session,{platform:platformKey,startDate:chunk.start,endDate:chunk.end,workspaceId:workspace?.id});
        lastEffectiveEndDate=effectiveEndDate;
        if(rows.length===0)continue; // a quiet week within a wider range isn't an error on its own
        // Tag each row with which connector pulled it — `sync:${provider}` matches the convention
        // api/lib/spendRowsStore.js already uses for the cron rolling-sync path, so a manual Sync
        // click and an automated one are equally traceable back to their connector. This is what
        // lets "Don't use data in PaidHQ" (excludedFromData) and the Import start/end date columns
        // in the connector table find exactly this provider's rows without touching CSV-uploaded or
        // screenshot-imported data for the same platform. Rows pulled before this shipped (2026-07-24)
        // won't have this tag until their connector syncs again.
        const taggedRows=rows.map(r=>({...r,source:`sync:${platformKey}`}));
        // Merge with existing data — don't replace. Merged per-chunk (not once at the end) so a
        // very wide range's early weeks are already live in mergedNormRows even if a later chunk
        // fails partway through.
        setMergedNormRows(prev=>mergeRows(prev,taggedRows));
        totalRows+=rows.length;
      }
      if(totalRows===0) throw new Error("No spend data returned for this date range");
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
      checkpoint(`Synced ${platformKey} spend data (${totalRows} rows)`,"tagger_sync");
      // /api/spend silently clamps a requested end date past today (see its doc comment — there's
      // no such thing as spend data for a day that hasn't happened yet). Surfacing that here means
      // a quarter/half-year range doesn't quietly look "fully synced" when only the portion through
      // today actually has data.
      const adjustedNote=lastEffectiveEndDate&&lastEffectiveEndDate!==syncDateRange.end
        ?` — synced through ${lastEffectiveEndDate} (no data yet for ${lastEffectiveEndDate} to ${syncDateRange.end})`
        :"";
      // Only worth telling the user this pulled a narrower range than the picker shows when it
      // actually did (effectiveStart clamped forward past syncDateRange.start) — a forced full
      // resync or a platform with no prior data still starts exactly where the picker says.
      const incrementalNote=effectiveStart!==syncDateRange.start?` (resumed from ${effectiveStart}, already had data before that)`:"";
      showNotif(`Loaded ${totalRows} ${platformKey} campaigns — merged with existing data${adjustedNote}${incrementalNote}`);
    }catch(e){
      setSyncState(p=>({...p,[platformKey]:"error:"+e.message}));
      // 2026-07-31, per Mo — a failed sync used to only leave a small red line above the
      // connections table (easy to miss, clears on refresh) with zero toast at all, which is
      // exactly why a real failure (e.g. a Google Sheet that isn't actually shared "Anyone with
      // the link can view" yet) could look indistinguishable from success. This doesn't replace
      // that inline line — just makes the failure impossible to miss in the moment it happens.
      showNotif(`${PLATFORMS.find(p=>p.key===platformKey)?.label||platformKey} sync failed — ${e.message}`,"error");
    }
  },[syncDateRange,checkpoint,workspace?.id,session?.access_token,connectionDetails,importDateRangeByProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Google Sheets spend pull ────────────────────────────────────────────────────────────────
  // Deliberately NOT the same "stored credential, click Sync" shape as Funnel/Supermetrics above
  // — reuses the exact client-side-only Google OAuth token flow already built for Budget/Tagger's
  // "Connect a Google Sheet" (lib/googleSheets.js), so there's no new Google Cloud setup and no
  // server-side storage. Each pull is a manual one-shot: paste a link, fetch the grid, review/map
  // columns on the same step==="map" screen a CSV upload lands on — same pipeline, different source.
  const[gsheetSpendOpen,setGsheetSpendOpen]=useState(false);

  // Which kind of manual import is sitting in the "map" review step right now — "csv" (a real
  // uploaded file) or "sheet-onetime" (the one-time "Connect a Google Sheet" pull just below,
  // distinct from the DAILY-SYNCING googlesheets connector in Data Sources). Tags the rows at
  // confirm time (2026-07-31, per Mo's Data Audit tab — "I need to know... from where" — before
  // this, neither kind set a `source` at all, so a CSV upload, a screenshot, and a one-time Sheet
  // pull were all indistinguishable in mergedNormRows). Defaults to "csv" since handleFile's
  // Papa.parse path is the far more common case; gsSpend's callback below overrides it right before
  // calling applySpendGrid.
  const[uploadSourceKind,setUploadSourceKind]=useState("csv");

  // Shared by handleFile's Papa.parse callback and the Sheets grid below — both end up with
  // the same shape (array of row objects + field names) and need to land on the same review step.
  //
  // `overrides` (2026-08-06, per Mo's save-and-one-click-reapply request — see
  // promptAndArchiveFile/archiveImportConfig's doc comments above) — when a file is replayed via
  // File Store's "Apply" instead of freshly picked, this carries the column mapping/platform/
  // monthly/as-of choices captured the FIRST time this file was imported, so the "map" step lands
  // pre-filled with the same answers instead of a fresh autoDetect guess. Omitted (undefined) for
  // every live upload, which behaves exactly as before this feature existed.
  const applySpendGrid=useCallback((data,fields,sourceLabel,overrides)=>{
    setFileName(sourceLabel);
    const detected=overrides?.colMap||autoDetect(fields||[]);
    setRawRows(data);setHeaders(fields||[]);setColMap(detected);
    const existingTagCount=data.reduce((count,row)=>{
      const name=(row[detected.campaign_group_name]||"").trim();
      return count+(name&&Object.keys(tags[name]||{}).length>0?1:0);
    },0);
    if(existingTagCount>0) showNotif(`${existingTagCount} campaigns already tagged from previous session`);
    setUploadAsOf(overrides?.uploadAsOf||"");
    setUploadIsMonthly(!!overrides?.uploadIsMonthly);
    if(overrides?.uploadPlatform)setUploadPlatform(overrides.uploadPlatform);
    setStep("map");
  },[tags]); // eslint-disable-line react-hooks/exhaustive-deps

  // Connection logic itself lives in the shared useGoogleSheetConnect hook (see its doc comment)
  // — this just converts the fetched grid into the same {rows, fields} shape a CSV upload's
  // Papa.parse output has, then feeds it into applySpendGrid above.
  const gsSpend=useGoogleSheetConnect((grid,tabTitle)=>{
    const[headerRow,...dataRows]=grid;
    const fields=headerRow.map((h,i)=>h||`Column ${i+1}`);
    const data=dataRows.map(row=>Object.fromEntries(fields.map((f,i)=>[f,row[i]||""])));
    setUploadSourceKind("sheet-onetime");
    applySpendGrid(data,fields,tabTitle);
    setGsheetSpendOpen(false);
  });

  // Which File Store record (if any) the file CURRENTLY on the "map" screen was archived under —
  // set by handleFile/handleSpendXlsxFile below, read by the "Continue to tagging" commit further
  // down to attach a linked import-config sidecar once the user's actual mapping choices are known
  // (see archiveImportConfig's doc comment above). Naming/archiving itself now happens BEFORE these
  // are called (via promptAndArchiveFile at each entry point), so these two no longer archive
  // anything themselves — `opts.archivedFileId` is just handed straight through.
  const[pendingSpendArchivedFileId,setPendingSpendArchivedFileId]=useState(null);
  // Called from BOTH spend commit points (the direct "Continue to tagging" click below, and
  // confirmSpendConflictImport when a conflict review had to happen first) right after the merge
  // actually succeeds, while colMap/uploadPlatform/etc still hold the choices that were just used —
  // writes the linked sidecar config so a later "Apply" on this same File Store record can restore
  // this exact mapping instead of guessing fresh (see archiveImportConfig's doc comment above).
  const commitPendingSpendImportConfig=useCallback(()=>{
    if(!pendingSpendArchivedFileId)return;
    archiveImportConfig(pendingSpendArchivedFileId,{kind:"spend",colMap,uploadPlatform,uploadIsMonthly,uploadAsOf,uploadSourceKind});
    setPendingSpendArchivedFileId(null);
  },[pendingSpendArchivedFileId,archiveImportConfig,colMap,uploadPlatform,uploadIsMonthly,uploadAsOf,uploadSourceKind]);

  const handleFile=useCallback((file,opts={})=>{
    if(!file)return;
    setPendingSpendArchivedFileId(opts.archivedFileId||null);
    setUploadSourceKind("csv");
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      applySpendGrid(r.data,r.meta.fields||[],opts.archiveName||file.name,opts.overrides);
    }});
  },[applySpendGrid]);

  // Spend files can now arrive as .xlsx/.xls too (the unified Data Sources uploader accepts
  // csv/xlsx/pdf for every import type — see handleUnifiedUpload below), not just CSV. Mirrors
  // gsSpend's own {data,fields} construction above rather than adding a header:1 branch — Excel's
  // default sheet_to_json (no header:1) already returns row objects keyed by header, the exact
  // shape applySpendGrid expects.
  const handleSpendXlsxFile=useCallback((file,opts={})=>{
    if(!file)return;
    setPendingSpendArchivedFileId(opts.archivedFileId||null);
    setUploadSourceKind("xlsx");
    const reader=new FileReader();
    reader.onload=e=>{
      const wb=XLSX.read(new Uint8Array(e.target.result),{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const data=XLSX.utils.sheet_to_json(ws,{defval:""});
      const fields=data.length?Object.keys(data[0]):[];
      applySpendGrid(data,fields,opts.archiveName||file.name,opts.overrides);
    };
    reader.readAsArrayBuffer(file);
  },[applySpendGrid]);

  function fileToDataUrl(file){
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result);
      reader.onerror=reject;
      reader.readAsDataURL(file);
    });
  }

  // ── Unified upload (2026-08-01, per Mo) ──────────────────────────────────────────────────────
  // Single entry point for the "Spend, Budget or Performance file" card: classify the file
  // (fileTypeDetect.js), show a confirm/override banner, then route to whichever existing importer
  // owns that data type. Doesn't parse/extract anything itself beyond the cheap classification
  // preview — the actual parse happens in confirmUnifiedUpload once the type is confirmed, using
  // the SAME importers each type already had (applySpendGrid, BudgetManager's ingestRawRows via
  // the pendingBudgetImportFile handoff, reportingAI.js/reportingImport.js for pipeline/goals).
  const[unifiedClassifying,setUnifiedClassifying]=useState(false);
  // PDFs take noticeably longer than CSV/Excel — Claude has to actually read the whole document
  // (there's no cheap way to peek at a PDF's structure the way a header row can be sniffed
  // instantly), and this one call now also does the extraction, not just classification (see
  // fileTypeDetect.js's PDF branch). Tracked separately so the button/status can say why it's
  // slower rather than just spinning with no explanation.
  const[unifiedClassifyingIsPdf,setUnifiedClassifyingIsPdf]=useState(false);
  const[unifiedClassifyError,setUnifiedClassifyError]=useState("");
  const[pendingClassification,setPendingClassification]=useState(null); // {file, type, confidence, reasoning, rows?}

  const handleUnifiedUpload=useCallback(async file=>{
    if(!file)return;
    setUnifiedClassifyError("");
    setUnifiedClassifyingIsPdf(file.name.split(".").pop().toLowerCase()==="pdf");
    setUnifiedClassifying(true);
    try{
      // tagDims forwarded so a PDF's classification call (which, per fileTypeDetect.js, doubles as
      // its extraction call for pipeline/goals content) tags with this workspace's real dimension
      // names instead of a placeholder set.
      const result=await classifyImportFile({file,token:session?.access_token,tagDims});
      setPendingClassification({file,...result});
    }catch(err){
      setUnifiedClassifyError(err.message||"Couldn't read that file.");
    }finally{
      setUnifiedClassifying(false);
    }
  },[session,tagDims]);

  const[unifiedRouting,setUnifiedRouting]=useState(false);
  const[unifiedRouteError,setUnifiedRouteError]=useState("");

  // NAMING/ARCHIVING (2026-08-06, per Mo — "I need a way to save the files that I upload in the
  // settings and then with one click apply them/import them into PaidHQ... force the user to
  // rename... upon import"): spend/budget/pipeline CSV/XLSX each get routed through
  // promptAndArchiveFile right here, before their own branch actually processes the file — one
  // choke point for every unified-upload path instead of duplicating the naming step per branch.
  // If the user cancels the name prompt, `pendingClassification` is deliberately left untouched
  // (not cleared) so the classify-then-confirm banner stays up and they can just hit "Continue →"
  // again. Goals imports and pipeline PDFs are NOT included (out of scope for this feature per Mo —
  // "I'm speaking here about the pipeline data" meant the column-mapped CSV/XLSX flow specifically)
  // and keep their prior no-archive behavior unchanged.
  const confirmUnifiedUpload=useCallback(async()=>{
    if(!pendingClassification)return;
    const{file,type,rows:alreadyExtractedRows}=pendingClassification;
    const ext=file.name.split(".").pop().toLowerCase();
    if(type==="spend"){
      if(ext!=="csv"&&ext!=="xlsx"&&ext!=="xls"){setPendingClassification(null);setUnifiedRouteError("PDF spend files aren't supported yet — try a CSV or Excel export.");return;}
      const named=await promptAndArchiveFile(file,"Spend import");
      if(!named)return;
      setPendingClassification(null);
      if(ext==="csv")handleFile(file,{archiveName:named.name,archivedFileId:named.fileId});
      else handleSpendXlsxFile(file,{archiveName:named.name,archivedFileId:named.fileId});
      return;
    }
    if(type==="budget"){
      if(ext==="pdf"){setPendingClassification(null);setUnifiedRouteError("PDF budget files aren't supported yet — try a CSV or Excel export.");return;}
      const named=await promptAndArchiveFile(file,"Budget import");
      if(!named)return;
      setPendingClassification(null);
      setPendingBudgetImportFile(file);
      setView("budget");
      return;
    }
    // pipeline / goals both land in reporting_facts via ReportingAnalyzer's (or, for goals,
    // GoalsObjectives') review table — the extraction has to happen here (not inside either tab)
    // since neither is necessarily mounted right now. `type` becomes each row's tag: goals-
    // classified rows get a distinct source prefix so GoalsObjectives.jsx can filter to just those,
    // everything else (pipeline) keeps the existing powerbi_* source naming reportingAI.js/
    // reportingImport.js already use.
    //
    // Pipeline AND (as of 2026-08-19, per Mo — "build the goals & objectives import like we've done
    // with... pipeline import") Goals CSV/XLSX both skip parseCampaignReportFile's fixed header-
    // alias map entirely: every row/column reads in untouched, and PipelineColumnMapper shows a
    // column-mapping step before anything becomes a normalized row — same open-mapping flow for
    // both, differing only in sourceLabel/archive-category/destination view/destination state, which
    // is why these two branches are near-identical rather than actually shared code: they hand off
    // to two separately-mounted tabs (ReportingAnalyzer vs GoalsObjectives), each with its own
    // one-shot relay state (pendingReportingRawImport vs pendingGoalsRawImport — see PaidHQ.jsx's own
    // state declarations for why these can't just be one shared piece of state). PDF stays on the
    // OLD parseCampaignReportFile/AI-extraction path below for both types, unchanged — out of scope
    // for this pass, matching exactly how pipeline's own PDF vs CSV/XLSX split already worked before
    // goals import existed.
    if(type==="pipeline"&&ext!=="pdf"){
      const named=await promptAndArchiveFile(file,"Pipeline import");
      if(!named)return;
      setPendingClassification(null);
      setUnifiedRouteError("");
      setUnifiedRouting(true);
      try{
        const raw=await parsePipelineFileRaw(file);
        // archivedFileId rides along on this handoff so ReportingAnalyzer/PipelineColumnMapper can
        // attach a linked import-config sidecar (mapping + resolved period) once the user confirms
        // them — see PipelineColumnMapper.jsx's handleConfirm and ReportingAnalyzer's
        // handleMappedImport for where that actually gets written.
        setPendingReportingRawImport({...raw,sourceLabel:"pipeline_csv_mapped",archivedFileId:named.fileId});
        setView("reportingAnalyzer");
      }catch(err){
        setUnifiedRouteError(err.message||"Couldn't read that file.");
      }finally{
        setUnifiedRouting(false);
      }
      return;
    }
    if(type==="goals"&&ext!=="pdf"){
      // Mirrors the "budget" branch above exactly (2026-08-19, REBUILT per Mo — "duplicate the
      // process of importing a budget file"): archive, hand off the raw File, switch tabs.
      // GoalsImportWizard (inside GoalsObjectives) does its own parsing/header-row-picking from
      // here, the same way BudgetManager does for pendingBudgetImportFile.
      const named=await promptAndArchiveFile(file,"Goals import");
      if(!named)return;
      setPendingClassification(null);
      setPendingGoalsImportFile(file);
      setView("goalsObjectives");
      return;
    }
    setPendingClassification(null);
    setUnifiedRouteError("");
    setUnifiedRouting(true);
    try{
      let rows;
      if(ext==="pdf"){
        // classifyImportFile's PDF path (fileTypeDetect.js -> reportingAI.js's
        // classifyAndExtractPdf) already extracted these rows as part of classifying the file, so
        // confirming here doesn't cost a second full PDF read — only re-extract if that somehow
        // didn't happen (defensive; shouldn't occur in practice for a "pipeline"/"goals" result).
        const raw=alreadyExtractedRows&&alreadyExtractedRows.length
          ?alreadyExtractedRows
          :await(async()=>{const dataUrl=await fileToDataUrl(file);return extractReportingRowsFromPdf({dataUrl,token:session?.access_token,tagDims});})();
        rows=raw.map(r=>({
          source:type==="goals"?"goals_pdf":"powerbi_pdf_goals_pacing",
          periodType:r.period_type||"unknown",
          periodStart:r.period_type&&r.period_type!=="unknown"?normalizePeriodStart(r.period_type,r.period_start)||undefined:undefined,
          campaignName:r.campaign_name||"",
          tags:r.tags||{},
          metrics:r.metrics||{},
        }));
      }else{
        const parsed=await parseCampaignReportFile(file);
        rows=parsed.map(r=>({
          source:type==="goals"?"goals_campaign_export":"powerbi_campaign_export",
          periodType:"unknown",
          periodStart:undefined,
          campaignName:r.campaignName||"",
          tags:{},
          metrics:r.metrics||{},
        }));
      }
      setPendingReportingRows(rows);
      setView("reportingAnalyzer");
    }catch(err){
      setUnifiedRouteError(err.message||"Couldn't read that file.");
    }finally{
      setUnifiedRouting(false);
    }
  },[pendingClassification,handleFile,handleSpendXlsxFile,session,tagDims,promptAndArchiveFile]);

  const handleDrop=useCallback(e=>{e.preventDefault();setDragOver(false);const f=e.dataTransfer.files[0];if(f)handleUnifiedUpload(f);},[handleUnifiedUpload]);

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

  // Same auto-default as the CSV path above, but for a screenshot's extracted rows (2026-07-30,
  // per Mo — screenshots never got this treatment at all, so a screenshot of a monthly dashboard
  // landed with no as_of_date and read as stale immediately, since freshness falls back to the
  // row's own date — the 1st of the month — when as_of_date is missing). Same signal (every
  // extracted row's date parses to the 1st of its month), same "only fires if still blank" guard.
  // The vision prompt already asks the model for "YYYY-MM-01 if only a month/period is shown," so
  // this reuses that same convention rather than needing a new one.
  useEffect(()=>{
    if(!screenshotPreview.length||screenshotAsOf)return;
    const parsedDates=screenshotPreview.map(r=>parseSpendDate(r.date)).filter(Boolean);
    const looksMonthly=parsedDates.length>0&&parsedDates.every(d=>d.getDate()===1);
    if(looksMonthly){
      const y=new Date();y.setDate(y.getDate()-1);
      setScreenshotAsOf(`${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,"0")}-${String(y.getDate()).padStart(2,"0")}`);
      setScreenshotIsMonthly(true);
    }
  },[screenshotPreview]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Same as_of_date attachment as the CSV path's withAsOf (2026-07-30, per Mo — this is the
    // actual fix: without it, a monthly screenshot's freshness fell back to the row's own date,
    // the 1st of the month, reading as stale immediately instead of "current as of today/whenever
    // the screenshot was taken"). is_monthly rides along too, same as the CSV path — closes the
    // DOW-seasonality contamination gap for screenshot imports as well.
    const rowsToImport=(screenshotIsMonthly&&screenshotAsOf
      ?screenshotPreview.map(r=>({...r,as_of_date:screenshotAsOf,is_monthly:true}))
      :screenshotPreview
    // Tagged "screenshot" (2026-07-31, per Mo's Data Audit tab) so it's distinguishable from a CSV
    // upload — same reasoning as applySpendGrid's uploadSourceKind, just no review-step detour
    // since screenshots don't share that flow.
    ).map(r=>({...r,source:"screenshot"}));
    setMergedNormRows(prev=>mergeRows(prev,rowsToImport));
    checkpoint(`Imported spend data from screenshot — ${screenshotFileName||"image"} (${rowsToImport.length} rows)`,"tagger_import");
    showNotif(`Added ${rowsToImport.length} rows from screenshot — merged with existing data`);
    setScreenshotPreview([]);setScreenshotFileName("");
    setScreenshotIsMonthly(false);setScreenshotAsOf("");
    setStep("tag");setView("tagger");
  },[screenshotPreview,screenshotFileName,screenshotIsMonthly,screenshotAsOf,checkpoint,canEdit]);

  // "Don't use data in PaidHQ" (excludedFromData, see the connector table's action menu) filters
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

  // "key" is the composite identity (campaign group + campaign) used everywhere tags/selection
  // are looked up — ad set/ad group names often repeat across different campaigns, so the leaf
  // name alone isn't a safe identity. "name" (leaf) and "groupName" stay separate for display.
  //
  // platform runs through groupGooglePlatform (2026-07-31, per Mo — Campaign Tagger used to call
  // derivePlatform() raw here, meaning the combineGoogleChannels setting had zero effect on Tagger's
  // own Platform filter/grouping even though Budget Panel/Pacing/Ask AI all already respected it;
  // this is what makes it a genuinely universal, workspace-wide setting instead of one that only
  // applied downstream of Tagger).
  const campaigns=useMemo(()=>{
    if(!visibleNormRows.length)return[];
    const map={};
    visibleNormRows.forEach(row=>{
      const name=row.campaign_name;if(!name)return;
      const groupName=row.campaign_group_name||name;
      const key=campaignKey(groupName,name);
      const platform=groupGooglePlatform(derivePlatform(groupName,name,row.platform,row.campaign_type),combineGoogleChannels);
      if(!map[key])map[key]={key,name,groupName,platform,spend:0,rows:0};
      map[key].spend+=row.spend;
      map[key].rows++;
    });
    return Object.values(map);
  },[visibleNormRows,combineGoogleChannels]);
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
    // Selected rows are exempt from the tagged/untagged status filter (2026-08-01, per Mo — bulk-
    // tagging a "needs review" batch across several dimensions in one sitting: Platform, then
    // Pillar, then Product, all against the same selected rows). Without this, the instant a
    // selected row picks up its FIRST tag it flips from untagged→tagged and the "needs review"
    // filter yanks it out of `filtered` mid-session — even though `selected` (see toggleSel/
    // applyTags) deliberately keeps holding it precisely so the next dimension can be applied to
    // the same batch. A row only gets re-evaluated against fStatus once it's no longer selected —
    // deselecting it (or hitting the toolbar's "Clear") is the natural "I'm done with this one"
    // signal. This only affects what's rendered here; the app-wide tagged/untagged definition used
    // by Dashboard stats etc. is untouched.
    if(!selected.has(c.key)){
      if(fStatus==="tagged"&&Object.keys(tags[c.key]||{}).length===0)return false;
      if(fStatus==="untagged"&&Object.keys(tags[c.key]||{}).length>0)return false;
    }
    return true;
  });return[...r].sort((a,b)=>{if(sortCol==="spend")return sortDir==="asc"?a.spend-b.spend:b.spend-a.spend;if(sortCol==="campaign")return sortDir==="asc"?a.name.localeCompare(b.name):b.name.localeCompare(a.name);if(sortCol==="group")return sortDir==="asc"?a.groupName.localeCompare(b.groupName):b.groupName.localeCompare(a.groupName);if(sortCol==="platform")return sortDir==="asc"?a.platform.localeCompare(b.platform):b.platform.localeCompare(a.platform);const at=Object.keys(tags[a.key]||{}).length;const bt=Object.keys(tags[b.key]||{}).length;return sortDir==="asc"?at-bt:bt-at;});},[campaigns,fCamp,fCampExclude,fCampInclMode,fCampExclMode,fGroup,fGroupExclude,fGroupInclMode,fGroupExclMode,fPlat,fSMin,fSMax,fTag,fTagExclude,fTagInclMode,fTagExclMode,selectedTagFilters,fStatus,sortCol,sortDir,tags,selected]);

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

  // 2026-07-31, per Mo — a failed sync (e.g. googlesheets connector hitting "not publicly viewable")
  // previously never surfaced a toast at all, only a small 11px red line above the connections
  // table that's easy to miss and clears on refresh. That's exactly what caused a synced-Google-
  // Sheet-that-actually-failed to look like "it worked" — silence read as success. Now any call
  // site can opt into an error-styled toast (red, 6s instead of 3s so there's time to actually read
  // an error message) by passing "error" as the second arg; every existing single-arg call site
  // keeps behaving exactly as before (green, 3s).
  const showNotif=(msg,type="success")=>{setNotif({msg,type});setTimeout(()=>setNotif(null),type==="error"?6000:3000);};
  // Toggling ONE Google channel's combine setting on (2026-07-30, per Mo; reshaped 2026-07-31 from
  // a single all-or-nothing toggle to per-channel — see combineGoogleChannels' own doc comment) —
  // when Platform is one of the Budget By dimensions, that ONE channel's existing budget rows are
  // immediately folded into a single "Google" row (merging monthly amounts, not overwriting — same
  // renameDimensionValue merge-on-collision behavior the inline segment-rename UI already uses), so
  // the Budget Panel/Pacing tables don't end up showing a stray combined "Google" segment with $0
  // budget sitting alongside the old sub-channel row still holding the real numbers. Every OTHER
  // channel's combine setting (and its budget rows) is untouched — checking "Demand Gen" doesn't
  // also fold in Search unless Search is checked too. Unchecking a channel deliberately does NOT
  // reverse a previous merge — there's no way to un-sum a combined "Google" row back into its
  // original per-channel amounts, so a channel that was already merged stays merged until someone
  // manually re-splits it; unchecking only stops that channel from joining future merges.
  const handleToggleGoogleChannel=(channel,checked)=>{
    if(!canEdit)return;
    if(checked&&!combineGoogleChannels[channel]&&budgetDims.includes("Platform")){
      const merged=renameDimensionValue({budgets,budgetRowMeta,tags,budgetDims,dim:"Platform",oldVal:channel,newVal:"Google"});
      setBudgets(merged.budgets);
      setBudgetRowMeta(merged.budgetRowMeta);
      setTags(merged.tags);
      showNotif(`Combined "${channel}" budget rows into "Google"`);
    }
    setCombineGoogleChannels(prev=>({...prev,[channel]:checked}));
  };
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
    downloadCSV(rows,"paidhq-tags.csv");
    // Archive a copy alongside the download — same CSV serialization downloadCSV uses internally,
    // wrapped as a File so archiveFile has a .name/.size/.type to work with.
    const csv=rows.map(r=>r.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\n");
    archiveFile(new File(["﻿"+csv],"paidhq-tags.csv",{type:"text/csv;charset=utf-8"}),"Tag export").then(refreshFileStore);
    showNotif("Tags exported");
  };
  // Same shape as exportTags above, scoped to just the multi-select's checked rows instead of every
  // campaign (2026-08-01, per Mo — "select the rows I want to highlight and export to csv"). Reads
  // against `campaigns` (the full, unfiltered set) rather than `filtered` — matches how applyTags/
  // bulkRemoveTag/bulkRemoveCampaigns above all resolve `selected` already: a row stays part of the
  // selection even if a filter tweak after selecting it would now hide it from view, so this export
  // can't silently drop a row the toolbar's own "N selected" count still promises is included.
  const exportSelectedCsv=()=>{
    const rowsToExport=campaigns.filter(c=>selected.has(c.key));
    if(!rowsToExport.length)return;
    const header=["Campaign Group","Campaign","Platform","Spend",...tagDims];
    const rows=[header,...rowsToExport.map(c=>[c.groupName,c.name,c.platform,c.spend.toFixed(2),...tagDims.map(d=>(tags[c.key]||{})[d]||"")])];
    downloadCSV(rows,"paidhq-selected-campaigns.csv");
    const csv=rows.map(r=>r.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\n");
    archiveFile(new File(["﻿"+csv],"paidhq-selected-campaigns.csv",{type:"text/csv;charset=utf-8"}),"Selected campaigns export").then(refreshFileStore);
    showNotif(`Exported ${rowsToExport.length} selected campaign${rowsToExport.length===1?"":"s"}`);
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
  // Archiving now happens up-front via promptAndArchiveFile at this function's call site(s) (2026-
  // 08-06, per Mo's save-and-one-click-reapply request) rather than here — no config sidecar is
  // needed for a tag import specifically, since applyTagRowsFromRecords already re-derives which
  // column is Campaign/Ad Group/which tag dimension purely from header text every time it runs, so
  // "Apply" on a saved tag CSV can just re-run this same function on the reloaded file verbatim.
  const importTagsFromCSV=useCallback((file)=>{
    if(!file)return;
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      applyTagRowsFromRecords(r.data,r.meta.fields||[]);
    }});
  },[applyTagRowsFromRecords]);

  // Settings → File Store "Apply" (2026-08-06, per Mo — "with one click apply them/import them
  // into PaidHQ so that if I delete all the data to start again, I can easily find all of the files
  // that I want to use"). Categories a live import actually archives under today — see
  // promptAndArchiveFile's call sites above — double as the whitelist for which File Store records
  // even offer this button; a manually-added reference file (PDF, insertion order, "Manual upload")
  // has no importer to re-run, so it never gets one.
  const APPLY_CATEGORIES=useMemo(()=>new Set(["Spend import","Tag import","Pipeline import","Budget import","Goals import"]),[]);
  const[applyingFileId,setApplyingFileId]=useState(null);
  const applyStoredFile=useCallback(async(rec)=>{
    if(!workspace?.id||!session)return;
    setApplyingFileId(rec.id);
    try{
      const blob=await fetchFileBlob(session,workspace.id,rec.id);
      const file=new File([blob],rec.name,{type:rec.mimeType||""});
      // Spend/Pipeline look for a linked sidecar config (see IMPORT_CONFIG_CATEGORY's doc comment)
      // written the last time THIS record was successfully imported — most-recent match wins since
      // fileStoreList is already sorted newest-first (files.js's GET orders by created_at desc), so
      // re-Applying after tweaking the mapping keeps using the latest tweak, not the original guess.
      let config=null;
      if(rec.category==="Spend import"||rec.category==="Pipeline import"){
        const sidecar=fileStoreList.find(f=>f.category===IMPORT_CONFIG_CATEGORY&&f.name===importConfigFileName(rec.id));
        if(sidecar){
          try{
            const cfgBlob=await fetchFileBlob(session,workspace.id,sidecar.id);
            config=JSON.parse(await cfgBlob.text());
          }catch(e){console.error("[import config load]",e);}
        }
      }
      if(rec.category==="Spend import"){
        setView("data");
        const ext=rec.name.split(".").pop().toLowerCase();
        const overrides=config?{colMap:config.colMap,uploadPlatform:config.uploadPlatform,uploadIsMonthly:config.uploadIsMonthly,uploadAsOf:config.uploadAsOf}:undefined;
        const opts={archiveName:rec.name,archivedFileId:rec.id,overrides};
        if(ext==="xlsx"||ext==="xls")handleSpendXlsxFile(file,opts);else handleFile(file,opts);
      }else if(rec.category==="Tag import"){
        importTagsFromCSV(file);
      }else if(rec.category==="Budget import"){
        setPendingBudgetImportFile(file);
        setView("budget");
      }else if(rec.category==="Pipeline import"){
        const raw=await parsePipelineFileRaw(file);
        setPendingReportingRawImport({
          ...raw,sourceLabel:rec.name,archivedFileId:rec.id,
          initialMapping:config?.mapping,initialPeriodMode:config?.periodMode,
          initialYear:config?.year,initialMonth:config?.month,initialQuarter:config?.quarter,
          initialHardcodedChannel:config?.hardcodedChannel,
        });
        setView("reportingAnalyzer");
      }else if(rec.category==="Goals import"){
        // Mirrors "Budget import" above exactly — no saved-mapping replay (GoalsImportWizard has no
        // equivalent to Pipeline import's config sidecar, matching Budget's own simpler "Apply just
        // reopens the wizard fresh" behavior).
        setPendingGoalsImportFile(file);
        setView("goalsObjectives");
      }
    }catch(err){
      showNotif(err.message||"Couldn't reapply this file.","error");
    }finally{
      setApplyingFileId(null);
    }
  },[workspace?.id,session,fileStoreList,handleFile,handleSpendXlsxFile,importTagsFromCSV]);
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
    if(!window.confirm("Clear all Tagger data?\n\nThis removes every imported spend row, every campaign tag (including Ads-mode tags), and your custom tag dimensions. Budget allocations are not affected.\n\nA version of your current data is saved first — you can restore it from File → Version History.\n\nThis cannot be undone from here."))return;
    snapshotNow("Before clearing Tagger data","pre_clear");
    allowEmptyConfigWriteRef.current=true;allowEmptyRowsWriteRef.current=true;
    setMergedNormRows([]);setTags({});setAdTags({});setTagDims(DEFAULT_DIMS);setColMap({});setStep("upload");setLastSyncRange(null);setTagsHistory([]);
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
    setMergedNormRows([]);setTags({});setAdTags({});setTagDims(DEFAULT_DIMS);setColMap({});setStep("upload");setLastSyncRange(null);setTagsHistory([]);
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

  // Settings → Clear Pipeline data's own source-of-truth lists, computed from the raw reporting_facts
  // rows fetched by refreshPipelineRows above — same shape/approach as ReportingFactsTagger.jsx's own
  // former bulk-delete panel this replaced (see that file's git history), just living here now.
  const pipelineDistinctSources=useMemo(()=>Array.from(new Set((pipelineRows||[]).map(r=>r.source).filter(Boolean))).sort(),[pipelineRows]);
  const pipelineDistinctChannels=useMemo(()=>Array.from(new Set((pipelineRows||[]).map(r=>(r.tags||{})[CHANNEL_TAG_KEY]).filter(Boolean))).sort(),[pipelineRows]);
  const pipelineDistinctTagValues=useMemo(()=>{
    if(!pdTagDim)return[];
    return Array.from(new Set((pipelineRows||[]).map(r=>(r.tags||{})[pdTagDim]).filter(Boolean))).sort();
  },[pipelineRows,pdTagDim]);
  const pipelineDeletePreviewCount=useMemo(()=>{
    if(!pipelineRows)return null;
    if(pdMode==="all")return pipelineRows.length;
    if(pdMode==="date"){
      if(!pdStart||!pdEnd)return null;
      return pipelineRows.filter(r=>{const m=(r.periodStart||"").slice(0,7);return m>=pdStart&&m<=pdEnd;}).length;
    }
    if(pdMode==="source")return pdSource?pipelineRows.filter(r=>r.source===pdSource).length:null;
    if(pdMode==="tag")return pdTagDim&&pdTagValue?pipelineRows.filter(r=>(r.tags||{})[pdTagDim]===pdTagValue).length:null;
    if(pdMode==="channel")return pdChannel?pipelineRows.filter(r=>(r.tags||{})[CHANNEL_TAG_KEY]===pdChannel).length:null;
    return null;
  },[pipelineRows,pdMode,pdStart,pdEnd,pdSource,pdTagDim,pdTagValue,pdChannel]);
  const canDeletePipelineData=
    pdMode==="all"?pdConfirmText.trim().toUpperCase()==="DELETE"
    :pdMode==="date"?!!(pdStart&&pdEnd)
    :pdMode==="source"?!!pdSource
    :pdMode==="tag"?!!(pdTagDim&&pdTagValue)
    :pdMode==="channel"?!!pdChannel
    :false;
  const resetPipelineDeleteForm=()=>{
    setPdMode("date");setPdStart("");setPdEnd("");setPdSource("");setPdTagDim("");setPdTagValue("");setPdChannel("");setPdConfirmText("");
  };
  const doPipelineDelete=async()=>{
    if(!canEdit||!canDeletePipelineData)return;
    let filters=null;let label="";
    if(pdMode==="all"){filters={all:true};label="ALL pipeline data in this workspace";}
    else if(pdMode==="date"){filters={start:`${pdStart}-01`,end:pipelineMonthEndDate(pdEnd)};label=`pipeline data from ${pdStart} through ${pdEnd}`;}
    else if(pdMode==="source"){filters={source:pdSource};label=`pipeline data from source "${pdSource}"`;}
    else if(pdMode==="tag"){filters={tags:{[pdTagDim]:pdTagValue}};label=`pipeline data tagged ${pdTagDim}: "${pdTagValue}"`;}
    else if(pdMode==="channel"){filters={tags:{[CHANNEL_TAG_KEY]:pdChannel}};label=`pipeline data on channel "${pdChannel}"`;}
    if(!filters)return;
    if(pdMode!=="all"&&!window.confirm(`Permanently delete ${label} (${pipelineDeletePreviewCount??"?"} row${pipelineDeletePreviewCount===1?"":"s"}) from the database?\n\nThis cannot be undone.`))return;
    setPdDeleting(true);
    try{
      const result=await deleteReportingFacts(session,workspace.id,filters);
      showNotif(`Deleted ${result.deleted} pipeline row${result.deleted===1?"":"s"}`);
      resetPipelineDeleteForm();
      refreshPipelineRows();
    }catch(err){
      showNotif(err.message||"Delete failed","error");
    }finally{
      setPdDeleting(false);
    }
  };

  // ── Export (the ··· menu's "Export [view]" + "Email a copy") ──
  // dashboard/tagger/budget/pacing each build their own report from state that already lives in
  // this top-level component — settings has nothing to export, so exportableView is null there
  // and the dots menu just shows the version-history items on its own.
  const exportableView=EXPORTABLE_VIEWS[view]||null;
  const buildCurrentReport=useCallback(()=>{
    if(!exportableView)return null;
    return exportableView.build({mergedNormRows:visibleNormRows,tags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,defaultForecastModel,combineGoogleChannels});
  },[exportableView,visibleNormRows,tags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims,defaultForecastModel,combineGoogleChannels]);
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
        to,subject:`${report.title} — PaidHQ`,note:emailExportNote,reportTitle:report.title,reportSubtitle:report.subtitle,
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
  const SH=({col,label,center})=>(<span onClick={()=>doSort(col)} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text,textDecoration:sortCol===col?"underline":"none",textUnderlineOffset:2,cursor:"pointer",userSelect:"none",display:"inline-flex",alignItems:"center",gap:3,...(center?{justifyContent:"center",width:"100%"}:{})}}>{label}<span style={{opacity:0.7,fontSize:9*(T.fsScale||1)}}>{sortCol===col?(sortDir==="desc"?"▾":"▴"):"⇅"}</span></span>);
  // White fill, same as the toolbar behind it — Vercel's filter pills are white-on-white with
  // just a border for separation, not a gray fill. paddingLeft is bumped separately on the three
  // primary "contains" fields to make room for the search icon from IconField.
  const fIn={background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,color:T.text,padding:"6px 9px",fontSize:11*(T.fsScale||1),outline:"none",fontFamily:T.font,width:"100%",marginTop:3,height:30,boxSizing:"border-box"};

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
    commitPendingSpendImportConfig();
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
      <div style={{height:"100vh",width:"100vw",display:"flex",alignItems:"center",justifyContent:"center",background:T.bg,color:T.textMuted,fontFamily:T.font,fontSize:13*(T.fsScale||1)}}>
        Loading {workspace.name}…
      </div>
    );
  }
  if(workspace&&workspaceDataError){
    return(
      <div style={{height:"100vh",width:"100vw",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,background:T.bg,fontFamily:T.font,padding:24}}>
        <div style={{padding:"12px 16px",background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,borderRadius:T.r8,color:T.danger,fontSize:13*(T.fsScale||1),maxWidth:420,textAlign:"center"}}>{workspaceDataError}</div>
        <button onClick={()=>window.location.reload()} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:T.r6,padding:"7px 16px",fontSize:12*(T.fsScale||1),color:T.text,cursor:"pointer",fontFamily:T.font}}>Reload</button>
      </div>
    );
  }

  return(
    <div style={{height:"100vh",width:"100vw",display:"flex",flexDirection:"row",background:T.bg,color:T.text,fontFamily:T.font,overflow:"hidden",position:"relative"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"/>

      {/* ── SIDEBAR ── (rebuilt 2026-08-07, Venture CRM retheme, per Mo: "I want the exact same
          layout, same buttons, same font and text, same vertical menu bar, same horizontal top
          menu bar... same lines and borders, same background colors" — replaces the prior
          icon-only 64px utility rail + horizontal pill-tab bar (2026-08-01 design, see git
          history) with Venture's actual shell anatomy: a full labeled left sidebar (logo, primary
          nav, workspace switcher footer) plus a top header (search / help / profile), matching
          Venture's General Settings screenshot exactly. Every dropdown/menu that used to live in
          the old icon rail is preserved with identical handlers and content, just relocated to
          the equivalent Venture slot: workspace switcher → sidebar footer (Venture's "M Marketing
          Team's" cluster), account menu (sign out/switch/add account) → TopHeader profile
          cluster, Settings → a plain nav item at the bottom of the sidebar list (matching
          Venture's own Settings nav item), file/export "more" menu → a TopHeader icon button next
          to Help Center (Venture has no equivalent contextual export menu, so this is the closest
          slot for it). */}
      {/* bg-muted (2026-08-07, per Mo: "the main body of the site is white, even the top menu bar.
          Only the left vertical column is grey") — Figma's General Settings frame (562:37686) confirms
          the shell's left rail sits on Background/Secondary (#f9f9f9 = --muted here), while the top
          header and every content column stay on Background/Primary (#fff = --background).
          Collapsed = an icons-only rail (2026-08-07, per Mo — was width-0, which left the toggle
          overlapping the border) matching Venture's collapsed sidebar; labels hide, icons stay
          centered, and each item's name surfaces via a native tooltip (NavItem's collapsed mode). */}
      <aside className={cn("flex h-full shrink-0 flex-col border-r border-border bg-muted transition-[width] duration-150",
        primaryNavCollapsed?"w-[60px]":"w-[240px]")}>
        <div className={cn("flex h-[64px] items-center border-b border-border",primaryNavCollapsed?"justify-center px-2":"gap-2 px-5")}>
          {!primaryNavCollapsed&&(
            <>
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-primary">
                <Lightning size={15} color="#fff" weight="fill"/>
              </div>
              <span className="whitespace-nowrap text-base font-semibold text-foreground">PaidHQ</span>
            </>
          )}
          <button onClick={()=>setPrimaryNavCollapsed(v=>!v)} title={primaryNavCollapsed?"Expand sidebar":"Collapse sidebar"}
            className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-secondary text-muted-foreground hover:bg-secondary/80",!primaryNavCollapsed&&"ml-auto")}>
            <SidebarSimple size={16}/>
          </button>
        </div>

        {/* overflow-x-hidden (2026-08-07, per Mo — "small grey line at the bottom when collapsed"):
            overflow-y-auto implicitly promotes overflow-x to auto per the CSS spec, so a sub-pixel-
            wide child was spawning a stray horizontal scrollbar at the rail's bottom. */}
        <nav className={cn("flex flex-1 flex-col overflow-y-auto overflow-x-hidden py-4",primaryNavCollapsed?"items-center px-2":"px-3")}>
          <div className={cn("flex w-full flex-col gap-0.5",primaryNavCollapsed&&"items-center")}>
            {NAV.map(item=>{
              // "pacing" is rendered as a child of the Budget & Actuals group when the rail is
              // expanded — skip its standalone row there (in the collapsed icon rail it still shows
              // as its own icon, since a nested expandable group doesn't fit a 60px rail).
              if(item.key==="pacing"&&!primaryNavCollapsed)return null;
              // "budget" becomes the expandable Budget & Actuals group (parent + Budget Panel /
              // Budget Pacing children) when expanded.
              if(item.key==="budget"&&!primaryNavCollapsed){
                return(
                  <div key="budget-group" className="flex w-full flex-col gap-0.5">
                    <NavItem icon={<Wallet size={16}/>} onClick={()=>setBudgetGroupOpen(o=>!o)}
                      trailingIcon={budgetGroupOpen?<CaretDown size={12}/>:<CaretRight size={12}/>}>
                      Budget Panel
                    </NavItem>
                    {budgetGroupOpen&&(
                      // ml-[18px] puts the connecting line under the parent icon's centre; border-l
                      // draws it and pl-3 indents the children past it, matching Venture's nested
                      // Emails->General/Analytics group (2026-08-07, per Mo).
                      <div className="ml-[18px] flex flex-col gap-0.5 border-l border-border pl-5">
                        <NavItem active={view==="budget"} onClick={()=>setView("budget")}>Budgets</NavItem>
                        <NavItem active={view==="pacing"} onClick={()=>setView("pacing")}>Pacing</NavItem>
                      </div>
                    )}
                  </div>
                );
              }
              const active=view===item.key;
              const ItemIcon=NAV_ICONS[item.key]||Gauge;
              return(
                <NavItem key={item.key} active={active} collapsed={primaryNavCollapsed} icon={<ItemIcon size={16}/>}
                  onClick={()=>{
                    // Same routing as before (see git history's prior version of this loop) —
                    // Tagger/Data Sources still branch on whether data already exists rather than
                    // on the transient `step` flag.
                    if(item.key==="tagger"){if(mergedNormRows.length>0){setStep("tag");setView("tagger");}else{setStep("upload");setView("data");}}
                    else if(item.key==="data"){setStep("upload");setView("data");}
                    else setView(item.key);
                  }}>
                  {item.label}
                </NavItem>
              );
            })}
          </div>
          <div className="my-3 w-full border-t border-border"/>
          <NavItem active={view==="settings"} collapsed={primaryNavCollapsed} icon={<Gear size={16}/>} onClick={()=>setView("settings")}>Settings</NavItem>
        </nav>

        {/* Workspace switcher footer — same menu content/handlers as the old rail's version,
            repositioned to match Venture's bottom-left workspace cluster. */}
        {workspace&&workspaces&&(
          <div className={cn("relative border-t border-border",primaryNavCollapsed?"flex justify-center p-2":"p-3")}>
            <button onClick={()=>setWorkspaceMenuOpen(o=>!o)} title={primaryNavCollapsed?workspace.name:undefined}
              className={cn("flex items-center rounded-sm hover:bg-secondary/60",primaryNavCollapsed?"h-9 w-9 justify-center p-0":"w-full gap-2 p-2")}>
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {(workspace.name||"?")[0].toUpperCase()}
              </div>
              {!primaryNavCollapsed&&(<>
                <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">{workspace.name}</span>
                <CaretDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
              </>)}
            </button>
            {workspaceMenuOpen&&(<>
              <div onClick={()=>setWorkspaceMenuOpen(false)} className="fixed inset-0 z-[249]"/>
              <div className="absolute bottom-full left-3 z-[250] mb-1.5 min-w-[220px] rounded-sm border border-border bg-background p-1.5 shadow-card">
                <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Workspaces</div>
                {workspaces.map(w=>(
                  <button key={w.id} onClick={()=>{setWorkspaceMenuOpen(false);onSwitchWorkspace&&onSwitchWorkspace(w.id);}}
                    className={cn("flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary",w.id===workspace.id&&"bg-secondary")}>
                    <span className="truncate">{w.name}</span>
                    {w.id===workspace.id&&<Check className="h-3.5 w-3.5 shrink-0"/>}
                  </button>
                ))}
                <div className="my-1 h-px bg-border"/>
                <button onClick={()=>{setWorkspaceMenuOpen(false);onCreateWorkspace&&onCreateWorkspace();}}
                  className="w-full rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary">+ New workspace</button>
              </div>
            </>)}
          </div>
        )}
      </aside>

      {/* ── RIGHT COLUMN ── explicit bg-background (2026-08-07, per Mo's direct comparison against
          Venture — the header/content column was relying on inherited/body background rather than
          an explicit white fill; making it explicit here removes any doubt). */}
      <div className="bg-background" style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0,position:"relative"}}>

      {/* ── TOP HEADER ── search + file/export menu + Help Center + profile/account menu, matching
          Venture's exact header anatomy (search bar left, utility cluster right). */}
      <div className="flex h-[64px] shrink-0 items-center justify-between border-b border-border bg-background px-6">
        <div className="flex h-9 w-[280px] items-center justify-between rounded-sm border border-input px-3 text-muted-foreground">
          <span className="flex items-center gap-2">
            <MagnifyingGlass className="h-4 w-4"/>
            <span className="text-sm">Search</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="flex h-5 w-5 items-center justify-center rounded-[2px] bg-muted text-xs font-medium text-muted-foreground">⌘</span>
            <span className="flex h-5 w-5 items-center justify-center rounded-[2px] bg-muted text-xs font-medium text-muted-foreground">F</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* File/export "more" menu — unchanged content/handlers from the old rail, relocated
              here since Venture has no equivalent contextual export menu of its own. */}
          <div className="relative">
            <button title="More" onClick={()=>setFileMenuOpen(o=>!o)}
              className={cn("flex h-8 w-8 items-center justify-center rounded-sm border border-border text-muted-foreground",fileMenuOpen&&"bg-secondary")}>
              <DotsThree className="h-4 w-4" weight="bold"/>
            </button>
            {fileMenuOpen&&(<>
              <div onClick={()=>setFileMenuOpen(false)} className="fixed inset-0 z-[249]"/>
              <div className="absolute right-0 top-full z-[250] mt-1.5 min-w-[240px] rounded-sm border border-border bg-background p-1.5 shadow-card">
                {exportableView&&(<>
                  <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Export {exportableView.label}</div>
                  <div className="flex gap-1 px-1.5 pb-1.5">
                    {EXPORT_FORMATS.map(f=>(
                      <button key={f.key} onClick={()=>{setFileMenuOpen(false);handleExportDownload(f.key);}}
                        className="flex-1 rounded-sm border border-border py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary">{f.label}</button>
                    ))}
                  </div>
                  <button disabled={sheetsExporting} onClick={()=>{setFileMenuOpen(false);handleExportToGoogleSheets();}}
                    className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary disabled:opacity-60">
                    <ExportIcon className="h-3.5 w-3.5 text-muted-foreground"/> {sheetsExporting?"Exporting to Google Sheets…":"Export to Google Sheets"}
                  </button>
                  <button onClick={()=>{setFileMenuOpen(false);openEmailExport();}}
                    className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary">
                    <EnvelopeSimple className="h-3.5 w-3.5 text-muted-foreground"/> Email a copy…
                  </button>
                  <div className="my-1 h-px bg-border"/>
                </>)}
                {canEdit&&<button onClick={()=>{setFileMenuOpen(false);setNameVersionOpen(true);}}
                  className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary">
                  <FloppyDisk className="h-3.5 w-3.5 text-muted-foreground"/> Name current version…
                </button>}
                {canEdit&&<button onClick={openVersionHistory}
                  className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary">
                  <ClockCounterClockwise className="h-3.5 w-3.5 text-muted-foreground"/> Version history
                </button>}
              </div>
            </>)}
          </div>

          <button className="flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary/60">
            <Question className="h-4 w-4"/> Help Center
          </button>

          {/* Profile / account menu — unchanged content/handlers, relocated from the old rail. */}
          {session&&(
            <div className="relative">
              <button onClick={()=>setAccountMenuOpen(o=>!o)} className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {(session.user?.email||"?")[0].toUpperCase()}
                </div>
                <CaretDown className="h-3.5 w-3.5 text-muted-foreground"/>
              </button>
              {accountMenuOpen&&(<>
                <div onClick={()=>setAccountMenuOpen(false)} className="fixed inset-0 z-[249]"/>
                <div className="absolute right-0 top-full z-[250] mt-1.5 min-w-[240px] rounded-sm border border-border bg-background p-1.5 shadow-card">
                  <div className="break-all px-2.5 py-1.5 text-sm font-semibold text-foreground">{session.user?.email}</div>
                  <div className="my-1 h-px bg-border"/>
                  <button onClick={()=>{setAccountMenuOpen(false);onSignOut&&onSignOut();}}
                    className="w-full rounded-sm px-2.5 py-1.5 text-left text-sm text-destructive hover:bg-secondary">Sign out</button>
                  {accounts&&accounts.filter(a=>a.storageKey!==activeAccountKey).length>0&&(<>
                    <div className="my-1 h-px bg-border"/>
                    <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Switch account</div>
                    {accounts.filter(a=>a.storageKey!==activeAccountKey).map(a=>(
                      <button key={a.storageKey} onClick={()=>{setAccountMenuOpen(false);onSwitchAccount&&onSwitchAccount(a.storageKey);}}
                        className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary">
                        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-foreground">{(a.email||"?")[0].toUpperCase()}</span>
                        <span className="truncate">{a.email}</span>
                      </button>
                    ))}
                  </>)}
                  <div className="my-1 h-px bg-border"/>
                  <button onClick={()=>{setAccountMenuOpen(false);onAddAccount&&onAddAccount();}}
                    className="w-full rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary">+ Add account</button>
                </div>
              </>)}
            </div>
          )}
        </div>
      </div>

      {/* View-only banner — "member" role can see every tab but every product API route rejects
          their writes server-side (requireEditAccess). Unchanged from before. */}
      {!canEdit&&(
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"7px 16px",background:T.accentBg,borderBottom:`1px solid ${T.accentBorder}`,fontSize:12*(T.fsScale||1),color:T.text,fontFamily:T.font,flexShrink:0}}>
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
            open/collapsible behavior. accountPlanning USED to be special-cased here the same way
            (2026-08-06) — reverted 2026-08-07 per Mo ("make it the width of campaign tagger and
            include the second vertical column, just like the campaign tagger"): it now gets the
            normal open/collapsible sidebar like every other tab, portalling its own step nav in
            via accountPlanningSidebarEl below instead of the zero-width collapse.
            Settings gets zero-width too (2026-08-07, per Mo's direct comparison against Venture's
            General Settings reference) — that page now has its own full-height two-column nav+
            content layout matching Venture's exact anatomy, and this generic legacy stats sidebar
            (old T-theme PixelPanel styling, "Total spend/Campaigns/Tagged/Needs review") isn't part
            of Venture's Settings design at all. It was rendering as an unwanted 3rd vertical column
            — Mo counted "three vertical menus in settings instead of two." */}
        <aside style={{width:(view==="dashboard"||view==="settings")?0:(statsOpen?statsWidth:0),flexShrink:0,background:(view==="budget"||view==="pacing")?T.surface:T.sidebarBg,borderRight:(view==="dashboard"||view==="settings")?"none":(statsOpen?`1px solid ${T.border}`:"none"),display:"flex",flexDirection:"column",padding:(view==="dashboard"||view==="settings")?0:(statsOpen?((view==="budget"||view==="pacing")?"18px 0":"18px 14px"):0),overflow:"hidden",gap:12,zIndex:20,transition:statsResizing.current?"none":"width 0.15s,padding 0.15s"}}>

          {view==="dashboard"||view==="settings"?null:view==="accountPlanning"?(
            <div ref={setAccountPlanningSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="budget"?(
            // overflowX hidden (2026-08-07) so the Budget sidebar's full-bleed section dividers
            // (which use -mx to reach past the aside's horizontal padding) don't trigger a
            // horizontal scrollbar.
            <div ref={setBudgetSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflowY:"auto",overflowX:"hidden",display:"flex",flexDirection:"column"}}/>
          ):view==="pacing"?(
            // overflowX hidden (2026-08-07) so the Pacing sidebar's full-bleed section dividers
            // (-mx past the aside's horizontal padding) don't trigger a horizontal scrollbar.
            <div ref={setPacingSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflowY:"auto",overflowX:"hidden",display:"flex",flexDirection:"column"}}/>
          ):view==="ask"?(
            <div ref={setAskSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="reportingAnalyzer"?(
            <div ref={setReportingAnalyzerSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="goalsObjectives"?(
            <div ref={setGoalsObjectivesSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="changeHistory"?(
            <div ref={setChangeHistorySidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="vault"?(
            <div ref={setVaultSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="pipelineTagger"?(
            <div ref={setPipelineTaggerSidebarEl} className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="data"?(
            // Data Sources' own left column (2026-07-24, per Mo — modeled on Funnel.io's Data
            // sources page, scoped down since PaidHQ has ~8 connectors total, not Funnel's scale).
            // Health list reuses the exact same connectionDetails Settings' Connections table and
            // the Dashboard's "Data source health" card both already read — one source of truth,
            // three places it's summarized.
            <div className="bhq-scroll" style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}>
              <SectionLabel T={T} style={{marginBottom:8,fontSize:11*(T.fsScale||1)}}>Data source health</SectionLabel>
              {(()=>{
                const issues=(connectionDetails||[]).filter(c=>c.needsReconnect||c.needsAccountSelection||c.lastAutoSyncStatus==="error");
                if(!connectionDetails||connectionDetails.length===0)return<div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,lineHeight:1.6,fontFamily:T.font,marginBottom:14}}>No connectors set up yet — connect one below.</div>;
                if(issues.length===0)return<div style={{fontSize:12*(T.fsScale||1),color:T.success,lineHeight:1.6,fontFamily:T.font,marginBottom:14}}>All {connectionDetails.length} connected source{connectionDetails.length===1?"":"s"} healthy.</div>;
                return(
                  <div style={{display:"flex",flexDirection:"column",gap:2,marginBottom:14}}>
                    {issues.map(c=>{
                      const reason=c.needsReconnect?"Reconnect":c.needsAccountSelection?"Pick account":"Sync failed";
                      return(
                        <div key={c.provider} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"5px 0",gap:8}}>
                          <span style={{fontSize:12*(T.fsScale||1),color:T.text,fontFamily:T.font,textTransform:"capitalize"}}>{c.provider}</span>
                          <Pill color={T.warning} bg={T.warning+"14"} border={T.warning+"55"} style={{fontSize:10*(T.fsScale||1)}}>{reason}</Pill>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              <Divider T={T}/>
              <div style={{padding:"12px 0"}}>
                <SectionLabel T={T} style={{fontSize:11*(T.fsScale||1)}}>Overview</SectionLabel>
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
                <SectionLabel T={T} style={{fontSize:11*(T.fsScale||1)}}>Quick actions</SectionLabel>
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
                <SectionLabel T={T} style={{fontSize:11*(T.fsScale||1)}}>Data freshness</SectionLabel>
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
                      text=`Data through ${fmtCalendarDate(importEnd,{month:"short",day:"numeric"})}`;
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
                  if(rows.length===0)return<div style={{border:`1px dashed ${T.border}`,borderRadius:T.r6,padding:"8px 10px",backgroundColor:T.surfaceEl,backgroundImage:T.hatchBg,fontSize:12*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>Nothing connected yet.</div>;
                  return(
                    <div style={{display:"flex",flexDirection:"column",gap:7}}>
                      {rows.map(r=>(
                        <div key={r.key} style={{display:"flex",alignItems:"center",gap:7,minWidth:0}}>
                          <PlatformLogo domain={r.domain} color={r.platColor} mark={r.mark} size={16} T={T}/>
                          <div style={{minWidth:0,flex:1}}>
                            <div style={{fontSize:11*(T.fsScale||1),fontWeight:600,color:T.text,fontFamily:T.font,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.label}</div>
                            <div style={{fontSize:11*(T.fsScale||1),color:r.color,fontFamily:T.font}}>{r.text}</div>
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
                  stat above it). Runs through groupGooglePlatform (2026-07-31) so this reporting
                  widget reflects the same combineGoogleChannels choice as Tagger/Budget Panel/
                  Pacing/Ask AI — Settings' OWN breakdown further down intentionally does NOT (see
                  that section's comment — it needs the real underlying platform for per-channel
                  data deletion). */}
              <div style={{padding:"12px 0"}}>
                <SectionLabel T={T} style={{fontSize:11*(T.fsScale||1)}}>Spend by platform</SectionLabel>
                {(()=>{
                  const map={};
                  visibleNormRows.forEach(r=>{
                    const p=groupGooglePlatform(derivePlatform(r.campaign_group_name,r.campaign_name,r.platform,r.campaign_type),combineGoogleChannels);
                    map[p]=(map[p]||0)+(r.spend||0);
                  });
                  const arr=Object.entries(map).map(([platform,spend])=>({platform,spend})).sort((a,b)=>b.spend-a.spend);
                  if(arr.length===0)return<div style={{border:`1px dashed ${T.border}`,borderRadius:T.r6,padding:"8px 10px",backgroundColor:T.surfaceEl,backgroundImage:T.hatchBg,fontSize:12*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>No spend data yet.</div>;
                  const max=arr[0].spend||1;
                  return(
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {arr.slice(0,5).map(p=>(
                        <div key={p.platform}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11*(T.fsScale||1),marginBottom:3,gap:6}}>
                            <span style={{display:"flex",alignItems:"center",gap:5,minWidth:0,overflow:"hidden"}}>
                              <span style={{width:6,height:6,borderRadius:"50%",background:PLATFORM_COLORS[p.platform]||T.textMuted,flexShrink:0}}/>
                              <span style={{color:T.text,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.platform}</span>
                            </span>
                            <span style={{color:T.textMuted,flexShrink:0,fontFamily:T.font}}>{fmt$(p.spend)}</span>
                          </div>
                          <div style={{height:4,borderRadius:T.r2,background:T.surfaceEl,overflow:"hidden"}}>
                            <div style={{height:"100%",width:`${Math.max(3,Math.round(p.spend/max*100))}%`,background:PLATFORM_COLORS[p.platform]||T.accent,borderRadius:T.r2}}/>
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
              <SectionLabel T={T} style={{marginBottom:8,fontSize:11*(T.fsScale||1)}}>Tag Dimensions</SectionLabel>
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:8}}>
                {tagDims.map(dim=>(
                  /* Padding/weights aligned to StatRow (2026-07-24, per Mo) — "4px 0" instead of
                     "6px 8px" so labels start flush left same as Overview's, label weight matches
                     Overview's (no override, was 700 when selected — background/border below still
                     show selection), and the count now weight:600 to match StatRow's value weight.
                     × moved before the count (rather than after) so the count itself, not the
                     button, is the flush-right element — same right edge as Overview's values. */
                  <div key={dim} className={applyDim===dim?undefined:"bhq-row"} onClick={()=>setApplyDim(dim)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 0",borderRadius:T.r6,cursor:"pointer",background:applyDim===dim?T.accentBg:"transparent",border:applyDim===dim?`1px solid ${T.accentBorder}`:"1px solid transparent"}}>
                    <span style={{fontSize:11*(T.fsScale||1),color:T.text}}>{dim}</span>
                    <span style={{display:"flex",alignItems:"center",gap:6}}>
                      <button onClick={e=>{e.stopPropagation();deleteDimension(dim);}} title={`Delete "${dim}" dimension`}
                        style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:14*(T.fsScale||1),lineHeight:1,padding:0,opacity:0.5,transition:"opacity 0.1s, color 0.1s"}}
                        onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.color=T.danger;}}
                        onMouseLeave={e=>{e.currentTarget.style.opacity=0.5;e.currentTarget.style.color=T.textMuted;}}>×</button>
                      <span style={{fontSize:11*(T.fsScale||1),fontWeight:600,color:T.textMuted,fontFamily:T.font}}>{Object.values(tags).filter(t=>t[dim]).length}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:5,marginBottom:12}}>
                <Inp value={newDim} onChange={setNewDim} placeholder="New dimension…" T={T} onKeyDown={e=>e.key==="Enter"&&addDim()} style={{fontSize:12*(T.fsScale||1),padding:"5px 8px"}}/>
                <Btn onClick={addDim} variant="subtle" size="sm" T={T}>+</Btn>
              </div>
              <Divider T={T}/>
              <div style={{padding:"12px 0",flex:1}}>
                <SectionLabel T={T} style={{fontSize:11*(T.fsScale||1)}}>Overview</SectionLabel>
                {[{l:"Campaigns",v:stats.total.toString()},{l:"Platforms",v:[...new Set(visibleNormRows.map(r=>r.platform))].filter(Boolean).join(", ")||"—"},{l:"Showing",v:filtered.length.toString(),c:T.text},{l:"Filtered spend",v:"$"+Math.round(filtered.reduce((s,c)=>s+c.spend,0)).toLocaleString(),c:T.text},{l:"Tagged",v:stats.tagged.toString(),c:T.success},{l:"Needs review",v:stats.untagged.toString(),c:stats.untagged>0?T.warning:T.success},{l:"Total spend",v:fmt$(stats.totalSpend)},{l:"Data rows",v:stats.totalRows.toLocaleString()}].map(s=><StatRow key={s.l} label={s.l} value={s.v} color={s.c} T={T} size={11}/>)}
                {stats.dateRange&&<div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:8,fontFamily:T.font,lineHeight:1.6}}>{stats.dateRange}</div>}
                <div style={{marginTop:10,height:3,background:T.border,borderRadius:T.r2,overflow:"hidden"}}><div style={{height:"100%",width:`${stats.total?(stats.tagged/stats.total)*100:0}%`,background:T.accent,transition:"width 0.4s",borderRadius:T.r2}}/></div>
                <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:4}}>{stats.total?Math.round((stats.tagged/stats.total)*100):0}% tagged</div>
                <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:6}}>
                  <Btn onClick={exportTags} disabled={!campaigns.length} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↓ Export tags CSV</Btn>
                  <Btn onClick={()=>importTagsRef.current?.click()} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↑ Import tags CSV</Btn>
                  <input ref={importTagsRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>{
                    const f=e.target.files[0];e.target.value="";
                    if(!f)return;
                    promptAndArchiveFile(f,"Tag import").then(named=>{if(named)importTagsFromCSV(f);});
                  }} />
                  <Btn onClick={()=>!tagScreenshotImporting&&importTagsScreenshotRef.current?.click()} disabled={tagScreenshotImporting} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>{tagScreenshotImporting?"Reading screenshot…":"📷 Import tags from screenshot"}</Btn>
                  <input ref={importTagsScreenshotRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{importTagsFromScreenshot(e.target.files[0]);e.target.value="";}} />
                  {tagScreenshotError&&<div style={{fontSize:11*(T.fsScale||1),color:T.danger}}>{tagScreenshotError}</div>}
                  <Btn onClick={()=>setGsheetTagOpen(o=>!o)} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>🔗 Connect Google Sheet</Btn>
                  {gsheetTagOpen&&(
                    <div style={{padding:"10px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r8}}>
                      {gsTags.tabs?.length>1?(
                        <div>
                          <div style={{fontSize:11*(T.fsScale||1),color:T.textSub,marginBottom:6}}>Which tab has the tagging table?</div>
                          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
                            {gsTags.tabs.map(t=>(
                              <button key={t.sheetId} disabled={gsTags.fetching} onClick={()=>gsTags.fetchTab(gsTags.spreadsheetId,t.title)}
                                style={{padding:"4px 9px",borderRadius:T.r6,border:`1px solid ${T.border}`,background:T.surface,color:T.text,cursor:gsTags.fetching?"default":"pointer",fontSize:11*(T.fsScale||1),fontFamily:T.font,opacity:gsTags.fetching?0.6:1}}>{t.title}</button>
                            ))}
                          </div>
                          <Btn onClick={gsTags.cancelTabs} variant="ghost" size="sm" T={T}>Cancel</Btn>
                        </div>
                      ):(
                        <Btn onClick={gsTags.openPicker} disabled={gsTags.fetching} variant="primary" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>{gsTags.fetching?"Connecting…":"Choose from Google Drive"}</Btn>
                      )}
                      {gsTags.error&&(
                        <div style={{marginTop:6,fontSize:11*(T.fsScale||1),color:T.danger}}>
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
                      <SectionLabel T={T} style={{marginBottom:0,fontSize:11*(T.fsScale||1)}}>Filter by tag</SectionLabel>
                      {selectedTagFilters.size>0&&<span style={{fontSize:10*(T.fsScale||1),color:T.text,fontWeight:600,fontFamily:T.font}}>{selectedTagFilters.size} active</span>}
                    </div>
                    {tagDims.map(dim=>{
                      const vals=Object.entries(tagValueMap[dim]||{}).sort((a,b)=>b[1]-a[1]);
                      if(!vals.length)return null;
                      return(
                        <div key={dim} style={{marginBottom:12}}>
                          <div style={{fontSize:11*(T.fsScale||1),fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.textMuted,marginBottom:5,fontFamily:T.font}}>{dim}</div>
                          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                            {vals.map(([val,count])=>{
                              const key=`${dim}:${val}`;
                              const active=selectedTagFilters.has(key);
                              return(
                                <button key={val} onClick={()=>toggleTagFilter(dim,val)}
                                  style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:T.r14,fontSize:11*(T.fsScale||1),fontWeight:500,cursor:"pointer",fontFamily:T.font,
                                    background:active?T.accent:T.surfaceEl,
                                    color:T.text,
                                    border:`1px solid ${active?T.accentHover:T.border}`,
                                    transition:"all 0.12s"}}>
                                  {val}
                                  <span style={{fontSize:10*(T.fsScale||1),opacity:0.7,background:active?"rgba(0,0,0,0.12)":T.border,borderRadius:T.r8,padding:"0 4px"}}>{count}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {selectedTagFilters.size>0&&(
                      <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:4,fontFamily:T.font}}>
                        AND across dimensions · OR within
                        <button onClick={()=>setSelectedTagFilters(new Set())} style={{display:"block",fontSize:11*(T.fsScale||1),color:T.danger,background:"transparent",border:"none",cursor:"pointer",padding:"4px 0",fontFamily:T.font}}>Clear tag filters ×</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ):(<>
          <PixelPanel T={T} style={{opacity:hasSidebarData?1:0.7}} contentStyle={{padding:"14px 16px",background:T.accentBg}}>
            <div style={{fontSize:10*(T.fsScale||1),fontWeight:700,color:T.textSub,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:6}}>Total spend</div>
            <div style={{fontSize:20*(T.fsScale||1),fontWeight:800,color:T.text,fontFamily:T.font}}>{hasSidebarData?"$"+Math.round(stats.totalSpend).toLocaleString():"No data yet"}</div>
          </PixelPanel>
          {!hasSidebarData&&(
            <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"3px 10px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r20,alignSelf:"flex-start"}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:T.textMuted,flexShrink:0}}/>
              <span style={{fontSize:9*(T.fsScale||1),fontWeight:600,color:T.textMuted,letterSpacing:"0.05em",textTransform:"uppercase"}}>No data yet</span>
            </div>
          )}
          {sidebarStatRows.map(s=>(
            <PixelPanel key={s.label} T={T} style={{opacity:hasSidebarData?1:0.7}} contentStyle={{padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:s.dot,flexShrink:0}}/>
                <span style={{fontSize:10*(T.fsScale||1),fontWeight:600,color:T.textMuted,letterSpacing:"0.06em",textTransform:"uppercase"}}>{s.label}</span>
              </div>
              <div style={{fontSize:19*(T.fsScale||1),fontWeight:700,color:T.text,fontFamily:T.font}}>{s.value}</div>
            </PixelPanel>
          ))}
          </>)}
        </aside>

        {/* Collapse handle for the stats column — hidden on Dashboard/Settings (no stats column).
            The width is responsive and no longer user-draggable (2026-08-07, per Mo), so there's no
            resize handle. When collapsed the button used to sit at left:-9, half off the container's
            left edge (clipped / floating over the main content) — it now clamps to a small positive
            offset so the "show" button stays fully visible and tidy at the content's left edge. */}
        {view!=="dashboard"&&view!=="settings"&&(
          <button className="bhq-iconbtn" onClick={()=>setStatsOpen(o=>!o)} title={statsOpen?"Hide stats":"Show stats"}
            style={{position:"absolute",top:"50%",left:statsOpen?statsWidth-9:4,transform:"translateY(-50%)",width:18,height:18,borderRadius:"50%",background:T.surface,border:`1px solid ${T.border}`,padding:0,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:T.textSub,fontWeight:700,fontSize:9*(T.fsScale||1),lineHeight:1,zIndex:40,boxShadow:T.shadow,transition:"left 0.15s, background 0.12s"}}>
            {statsOpen?"‹":"›"}
          </button>
        )}
      </>)}

      {/* ── MAIN ── */}
      <main style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>

      {notif&&<div style={{position:"fixed",bottom:20,right:20,background:notif.type==="error"?T.danger:T.success,color:"#fff",padding:"10px 16px",borderRadius:T.r8,fontSize:13*(T.fsScale||1),fontWeight:600,zIndex:100,boxShadow:T.shadowMd,fontFamily:T.font,maxWidth:420}}>{notif.msg}</div>}

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
                const isGSheet=pl.key==="googlesheets";
                return(
                  <div style={{marginBottom:14,padding:"12px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r8,maxWidth:hasPairField?560:(isGSheet&&sheetPreview?520:420)}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <div style={{fontSize:12*(T.fsScale||1),fontWeight:700,color:T.text,fontFamily:T.font}}>Connect {pl.label}</div>
                      <span onClick={()=>setConnectPanelKey(null)} style={{fontSize:12*(T.fsScale||1),color:T.textMuted,cursor:"pointer"}}>✕</span>
                    </div>
                    {pl.connectNote&&<div style={{fontSize:11*(T.fsScale||1),color:T.textSub,lineHeight:1.5,marginBottom:10,fontFamily:T.font}}>{pl.connectNote}</div>}
                    {pl.key==="googlesheets"&&<div onClick={()=>setGoogleSheetsGuideOpen(true)} style={{fontSize:11*(T.fsScale||1),fontWeight:600,color:T.accent,cursor:"pointer",marginBottom:10,fontFamily:T.font}}>Need help getting Google Ads spend into a Sheet? Setup guide →</div>}
                    <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
                      {(pl.connectFields||[]).map(f=>{
                        if(f.type==="keyvaluelist"){
                          const rows=pairRowsFor(f.key);
                          return(
                            <div key={f.key}>
                              {f.label&&<div style={{fontSize:11*(T.fsScale||1),fontWeight:600,color:T.textMuted,marginBottom:4,fontFamily:T.font}}>{f.label}</div>}
                              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                                {rows.map((row,idx)=>(
                                  <div key={idx} style={{display:"flex",gap:5,alignItems:"center"}}>
                                    <input value={row.label} placeholder={f.pairLabelPlaceholder}
                                      onChange={e=>setPairRow(f.key,idx,{label:e.target.value})}
                                      onPaste={e=>handlePairPaste(f.key,e)}
                                      style={{flex:"1 1 45%",minWidth:0,boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 9px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                                    <input value={row.value} placeholder={f.pairValuePlaceholder}
                                      onChange={e=>setPairRow(f.key,idx,{value:e.target.value})}
                                      onPaste={e=>handlePairPaste(f.key,e)}
                                      style={{flex:"1 1 45%",minWidth:0,boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 9px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}/>
                                    <span onClick={()=>removePairRow(f.key,idx)} title="Remove this row" style={{fontSize:13*(T.fsScale||1),color:T.textMuted,cursor:"pointer",padding:"0 2px",flexShrink:0}}>✕</span>
                                  </div>
                                ))}
                              </div>
                              <span onClick={()=>addPairRow(f.key)} style={{display:"inline-block",marginTop:6,fontSize:11*(T.fsScale||1),fontWeight:600,color:T.accent,cursor:"pointer",fontFamily:T.font}}>+ Add another {f.pairLabelName?.toLowerCase()||"row"}</span>
                              <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:5,fontFamily:T.font}}>Tip: paste a whole "{f.pairLabelName||"name"}: {f.pairValueName||"key"}" list into any {f.pairLabelName?.toLowerCase()||"name"} box to fill every row at once.</div>
                            </div>
                          );
                        }
                        const val=connectValues[f.key]||"";
                        return(
                          <div key={f.key}>
                            <input value={val} placeholder={f.placeholder}
                              onChange={e=>setConnectValues(v=>({...v,[f.key]:e.target.value}))}
                              style={{width:"100%",boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 9px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                          </div>
                        );
                      })}
                    </div>
                    {isGSheet&&sheetPreviewLoading&&(
                      <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginBottom:10,fontFamily:T.font}}>Reading sheet…</div>
                    )}
                    {/* Column mapping review — the actual point of this step (2026-07-31, per Mo):
                        show the user exactly what PaidHQ found in their sheet (real headers + a
                        sample value) instead of silently auto-detecting, so a wrong guess is
                        obvious right here instead of surfacing later as "spend just isn't showing
                        up." sheetColumnMap starts seeded from the server's own auto-detected guess
                        (see handlePreviewSheet/openAdjustMapping) — this is a review-and-override
                        step, not a from-scratch mapping chore. */}
                    {isGSheet&&sheetPreview&&(
                      <div style={{marginBottom:10}}>
                        <div style={{fontSize:11*(T.fsScale||1),fontWeight:600,color:T.text,marginBottom:2,fontFamily:T.font}}>
                          Column mapping{sheetPreview.rowCount!=null&&<span style={{fontWeight:400,color:T.textMuted}}> · {sheetPreview.rowCount} data row{sheetPreview.rowCount===1?"":"s"} found</span>}
                        </div>
                        <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginBottom:8,fontFamily:T.font}}>Auto-detected from your sheet's headers — check these are right, or change any of them.</div>
                        <div style={{display:"flex",flexDirection:"column",gap:5,maxHeight:260,overflowY:"auto",paddingRight:2}}>
                          {GSHEET_FIELDS.map(f=>{
                            const chosen=sheetColumnMap[f.key]||"";
                            const sample=chosen&&sheetPreview.sampleRow?sheetPreview.sampleRow[chosen]:null;
                            return(
                              <div key={f.key} style={{display:"flex",alignItems:"center",gap:6}}>
                                <div style={{width:132,flexShrink:0,fontSize:11*(T.fsScale||1),color:T.textSub,fontFamily:T.font}}>{f.label}{f.required&&<span style={{color:T.danger}}> *</span>}</div>
                                <select value={chosen} onChange={e=>setSheetColumnMap(m=>({...m,[f.key]:e.target.value}))}
                                  style={{flex:1,minWidth:0,background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"5px 7px",fontSize:11.5*(T.fsScale||1),outline:"none",fontFamily:T.font}}>
                                  <option value="">{f.required?"— Select a column —":"— Not in this sheet —"}</option>
                                  {sheetPreview.headers.map(h=><option key={h} value={h}>{h}</option>)}
                                </select>
                                {sample!=null&&String(sample).trim()!==""&&(
                                  <div title={String(sample)} style={{width:84,flexShrink:0,fontSize:10.5*(T.fsScale||1),color:T.textMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>{String(sample)}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <span onClick={()=>{setSheetPreview(null);setSheetColumnMap({});}} style={{display:"inline-block",marginTop:8,fontSize:11*(T.fsScale||1),fontWeight:600,color:T.accent,cursor:"pointer",fontFamily:T.font}}>← Use a different sheet</span>
                      </div>
                    )}
                    {connectError&&<div style={{fontSize:11*(T.fsScale||1),color:T.danger,marginBottom:8}}>{connectError}</div>}
                    {isGSheet&&!sheetPreview?(
                      <Btn onClick={handlePreviewSheet} disabled={sheetPreviewLoading||!(connectValues.sheetUrl||"").trim()}
                        variant="primary" size="sm" T={T}>{sheetPreviewLoading?"Reading sheet…":"Preview sheet"}</Btn>
                    ):(
                      <Btn onClick={()=>saveConnection(pl.key)}
                        disabled={connectSaving||(isGSheet
                          ?GSHEET_FIELDS.some(f=>f.required&&!sheetColumnMap[f.key])
                          :(pl.connectFields||[]).some(f=>{
                            if(f.type==="keyvaluelist")return !pairRowsFor(f.key).some(r=>r.label.trim()&&r.value.trim());
                            return !f.key.endsWith("Accounts")&&!(connectValues[f.key]||"").trim();
                          }))}
                        variant="primary" size="sm" T={T}>{connectSaving?"Connecting…":(isGSheet?"Confirm & connect":"Connect")}</Btn>
                    )}
                  </div>
                );
              })()}
              {oauthPicker&&(
                <div style={{marginBottom:14,padding:"12px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r8,maxWidth:420}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontSize:12*(T.fsScale||1),fontWeight:700,color:T.text,fontFamily:T.font}}>Which {OAUTH_PROVIDER_LABELS[oauthPicker.provider]||oauthPicker.provider} account?</div>
                    <span onClick={()=>{setOauthPicker(null);setOauthManualId("");setOauthManualName("");setOauthManualLoginCustomerId("");}} style={{fontSize:12*(T.fsScale||1),color:T.textMuted,cursor:"pointer"}}>✕</span>
                  </div>
                  {oauthPicker.accounts.length===0?(
                    <div>
                      <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginBottom:10,lineHeight:1.5}}>
                        {oauthPicker.provider==="google"
                          ?"Couldn't auto-discover accounts — this happens when your Google login only has access via a manager (MCC) account rather than directly on the ad account itself. Paste the Customer ID instead (top-right corner of the Google Ads UI, format 123-456-7890)."
                          :"Connected, but couldn't load your accounts. Try Sync — if it fails, reconnect."}
                      </div>
                      {oauthPicker.provider==="google"&&(
                        <div style={{display:"flex",flexDirection:"column",gap:6}}>
                          <input value={oauthManualId} onChange={e=>setOauthManualId(e.target.value)} placeholder="Customer ID, e.g. 123-456-7890"
                            style={{width:"100%",boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 9px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}/>
                          <input value={oauthManualLoginCustomerId} onChange={e=>setOauthManualLoginCustomerId(e.target.value)} placeholder="Manager account ID (only if accessed via an MCC — leave blank otherwise)"
                            style={{width:"100%",boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 9px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}/>
                          <input value={oauthManualName} onChange={e=>setOauthManualName(e.target.value)} placeholder="Account name (optional, for display only)"
                            style={{width:"100%",boxSizing:"border-box",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 9px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                          <div style={{fontSize:10*(T.fsScale||1),color:T.textMuted,lineHeight:1.4}}>Getting "PERMISSION_DENIED" on sync after entering just the Customer ID above? You're almost certainly reaching this account through a manager account — switch into that manager account in the Google Ads UI, copy ITS Customer ID (top-right corner), and paste it here too.</div>
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
                          style={{textAlign:"left",padding:"7px 10px",borderRadius:T.r6,
                            border:`1px solid ${a.id===oauthPicker.selectedAccountId?T.accentBorder:T.border}`,
                            background:a.id===oauthPicker.selectedAccountId?T.accentBg:T.surface,
                            color:T.text,cursor:oauthPickerSaving?"default":"pointer",fontSize:12*(T.fsScale||1),fontFamily:T.font,opacity:oauthPickerSaving?0.6:1}}>
                          {a.name} <span style={{color:T.textMuted,fontSize:10*(T.fsScale||1)}}>({a.id})</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {gsheetSpendOpen&&(
                <div style={{marginBottom:14,padding:"12px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r8,maxWidth:420}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontSize:12*(T.fsScale||1),fontWeight:700,color:T.text,fontFamily:T.font}}>Pull spend from Google Sheets</div>
                    <span onClick={()=>setGsheetSpendOpen(false)} style={{fontSize:12*(T.fsScale||1),color:T.textMuted,cursor:"pointer"}}>✕</span>
                  </div>
                  {gsSpend.tabs?.length>1?(
                    <div>
                      <div style={{fontSize:11*(T.fsScale||1),color:T.textSub,marginBottom:6}}>Which tab has the spend data?</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
                        {gsSpend.tabs.map(t=>(
                          <button key={t.sheetId} disabled={gsSpend.fetching} onClick={()=>gsSpend.fetchTab(gsSpend.spreadsheetId,t.title)}
                            style={{padding:"4px 9px",borderRadius:T.r6,border:`1px solid ${T.border}`,background:T.surface,color:T.text,cursor:gsSpend.fetching?"default":"pointer",fontSize:11*(T.fsScale||1),fontFamily:T.font,opacity:gsSpend.fetching?0.6:1}}>{t.title}</button>
                        ))}
                      </div>
                    </div>
                  ):(
                    <Btn onClick={gsSpend.openPicker} disabled={gsSpend.fetching} variant="primary" size="sm" T={T}>{gsSpend.fetching?"Connecting…":"Choose from Google Drive"}</Btn>
                  )}
                  {gsSpend.error&&(
                    <div style={{marginTop:8,fontSize:11*(T.fsScale||1),color:T.danger}}>
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
              card (or which subview) triggers them. fileRef stays CSV-only/spend-only — it's shared
              by the per-platform "status==='csv'" cards (e.g. Capterra) where the platform is
              already known from which card was clicked, so there's nothing to classify.
              unifiedFileRef backs the "Spend, Budget or Performance file" card below (2026-08-01,
              per Mo — one upload surface, route by file content instead of a separate button per
              destination) and accepts csv/xlsx/pdf, running every file through classifyImportFile
              first rather than assuming spend. */}
          <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>{
            const f=e.target.files[0];e.target.value="";
            if(!f)return;
            promptAndArchiveFile(f,"Spend import").then(named=>{if(named)handleFile(f,{archiveName:named.name,archivedFileId:named.fileId});});
          }}/>
          <input ref={unifiedFileRef} type="file" accept=".csv,.xlsx,.xls,.pdf" style={{display:"none"}} onChange={e=>{handleUnifiedUpload(e.target.files[0]);e.target.value="";}}/>
          <input ref={screenshotRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>handleScreenshotFile(e.target.files[0])}/>

          {dataSourcesSubView==="add"?(
            /* ── ADD DATA SOURCE ── (2026-07-24, modeled on Funnel.io's "Connect data source" page
                per Mo — he's planning to add more connectors over time and wants a dedicated,
                searchable page for browsing/adding them, separate from the table that manages
                what's already connected. CSV/Screenshot/Budget file are cards here too, alongside
                the live connectors, per his call when scoping this.)
                Rebuilt 2026-08-07 on Tailwind/shadcn, matching Venture's Integration page (Figma
                node 291:5558): a left filter rail + card grid, each card icon/name/desc with a
                top-right action pill (black "Install"-style button) or status badge ("Installed"-
                style, matching our Connected/Needs attention states). Venture's own rail groups by
                category (Advertising/Analytics/Payment/...) — BudgetHQ's connectors don't carry
                real categories, so this rail filters by connection status instead (All/Connected/
                Not connected) — same rail structure, BudgetHQ-relevant grouping. */
            <div className="flex-1 overflow-auto px-8 py-6">
              <div className="mb-1 flex items-center gap-1.5 text-xs">
                <button onClick={()=>setDataSourcesSubView("connections")} className="font-semibold text-foreground hover:underline">Data Sources</button>
                <span className="text-muted-foreground">/</span>
                <span className="text-muted-foreground">Add data source</span>
              </div>
              <h1 className="my-2 text-h4 font-medium text-foreground">Add data source</h1>

              {unifiedClassifyError&&(
                <div className="mb-4 rounded-sm border border-destructive/30 bg-destructive-bg px-3.5 py-2.5 text-xs text-destructive">{unifiedClassifyError}</div>
              )}
              {unifiedRouteError&&(
                <div className="mb-4 rounded-sm border border-destructive/30 bg-destructive-bg px-3.5 py-2.5 text-xs text-destructive">{unifiedRouteError}</div>
              )}
              {unifiedRouting&&(
                <div className="mb-4 rounded-sm border border-border bg-secondary px-3.5 py-2.5 text-xs text-foreground">Reading file…</div>
              )}
              {pendingClassification&&(
                <Card className="mb-5">
                  <CardContent className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-[220px] flex-1">
                      <div className="mb-0.5 text-sm font-semibold text-foreground">"{pendingClassification.file.name}"</div>
                      <div className="text-xs text-muted-foreground">
                        We think this is a <strong>{IMPORT_TYPE_LABELS[pendingClassification.type]}</strong> file
                        {pendingClassification.confidence==="low"&&" (not very confident — please double-check)"}.
                        {pendingClassification.reasoning?` ${pendingClassification.reasoning}`:""}
                      </div>
                    </div>
                    <Select value={pendingClassification.type} onValueChange={v=>setPendingClassification(p=>({...p,type:v}))}>
                      <SelectTrigger className="w-[190px]"><SelectValue/></SelectTrigger>
                      <SelectContent>
                        {Object.entries(IMPORT_TYPE_LABELS).map(([v,l])=>(<SelectItem key={v} value={v}>{l}</SelectItem>))}
                      </SelectContent>
                    </Select>
                    <Button onClick={confirmUnifiedUpload}>Continue →</Button>
                    <Button onClick={()=>setPendingClassification(null)} variant="ghost">Cancel</Button>
                  </CardContent>
                </Card>
              )}

              <div className="flex gap-8">
                <nav className="hidden w-[160px] shrink-0 flex-col gap-3 lg:flex">
                  <div>
                    <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Filter</div>
                    <div className="flex flex-col gap-0.5">
                      {[
                        {key:"all",label:"All"},
                        {key:"connected",label:"Connected"},
                        {key:"not-connected",label:"Not connected"},
                      ].map(f=>(
                        <button key={f.key} type="button" onClick={()=>setDataSourceStatusFilter(f.key)}
                          className={cn("rounded-sm px-2 py-1.5 text-left text-sm font-medium",dataSourceStatusFilter===f.key?"bg-secondary text-foreground":"text-muted-foreground hover:bg-secondary/60 hover:text-foreground")}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <input value={dataSourceSearch} onChange={e=>setDataSourceSearch(e.target.value)} placeholder="Search…"
                    className="h-9 rounded-sm border border-input bg-background px-2.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"/>
                </nav>

                <div className="min-w-0 flex-1">
                  <div className="mb-4 lg:hidden">
                    <input value={dataSourceSearch} onChange={e=>setDataSourceSearch(e.target.value)} placeholder="Search data sources…"
                      className="h-10 w-full max-w-[360px] rounded-sm border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"/>
                  </div>
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
                        else if(isConnected){actionLabel="Connected";onAction=()=>setDataSourcesSubView("connections");}
                        else if(pl.oauth){actionLabel="Connect now";onAction=()=>startProviderOAuth(pl.key);}
                        else{actionLabel="Connect now";onAction=()=>openConnectPanel(pl.key);}
                        return{key:pl.key,label:pl.label,desc:pl.desc,color:pl.color,domain:pl.domain,mark:pl.mark,isConnected,warn,actionLabel,onAction};
                      }),
                      {key:"_csv",label:"Spend, Budget or Performance file",desc:"CSV, Excel or PDF — we detect whether it's spend, budget, pipeline performance or goals data",color:"hsl(var(--muted-foreground))",mark:CsvMark,isConnected:false,warn:false,actionLabel:unifiedClassifying?(unifiedClassifyingIsPdf?"Reading PDF…":"Reading…"):"Upload file",onAction:()=>!unifiedClassifying&&unifiedFileRef.current?.click()},
                      {key:"_screenshot",label:"Screenshot",desc:"Share a screenshot of a spend report — AI reads it into data",color:"hsl(var(--muted-foreground))",mark:ScreenshotMark,isConnected:false,warn:false,actionLabel:screenshotProcessing?"Reading…":"Upload image",onAction:()=>!screenshotProcessing&&screenshotRef.current?.click()},
                    ]
                      .filter(c=>c.label.toLowerCase().includes(dataSourceSearch.trim().toLowerCase()))
                      .filter(c=>dataSourceStatusFilter==="all"||(dataSourceStatusFilter==="connected"?c.isConnected:!c.isConnected));
                    return(
                      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
                        {cards.map(c=>{
                          const isDropTarget=c.key==="_csv"||c.key==="_screenshot";
                          const dropProps=isDropTarget?{
                            onDragOver:e=>{e.preventDefault();setDragOver(true);},
                            onDragLeave:()=>setDragOver(false),
                            onDrop:c.key==="_csv"?handleDrop:handleScreenshotDrop,
                          }:{};
                          return(
                            <Card key={c.key} onClick={c.onAction} {...dropProps}
                              className={cn("cursor-pointer transition-colors hover:bg-secondary/30",isDropTarget&&dragOver&&"border-foreground bg-secondary/40")}>
                              <CardContent className="p-4">
                                <div className="mb-3 flex items-start justify-between gap-2">
                                  <PlatformLogo domain={c.domain} color={c.color} mark={c.mark} T={T}/>
                                  {c.isConnected&&!c.warn&&<Badge variant="success">Connected</Badge>}
                                  {c.warn&&<Badge variant="warning">Needs attention</Badge>}
                                  {!c.isConnected&&!c.warn&&(
                                    <span className="shrink-0 rounded-sm bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground">{c.actionLabel}</span>
                                  )}
                                </div>
                                <div className="mb-1 text-sm font-semibold text-foreground">{c.label}</div>
                                <div className="text-xs leading-relaxed text-muted-foreground">{c.desc}</div>
                                {c.key==="_screenshot"&&screenshotError&&<div className="mt-1.5 text-xs text-destructive">{screenshotError}</div>}
                              </CardContent>
                            </Card>
                          );
                        })}
                        {cards.length===0&&(
                          <div className="col-span-full py-6 text-sm text-muted-foreground">No data sources match "{dataSourceSearch}".</div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          ):(
            /* ── CONNECTIONS ── (default landing — table of already-connected sources only; browsing/
                adding new ones now happens on the "add" subview above). Rebuilt 2026-08-07 on the
                Table primitive (Table/TableHeader/TableRow/TableHead/TableCell) rather than Venture's
                single-app Integration Details page (Figma node 368:32769) — that frame is a per-app
                marketing/detail page (hero, description, "Related Apps" carousel) with no multi-row
                list anatomy, so it doesn't actually fit "manage every connected source at a glance."
                Venture's own Table component (which Mo named separately as its own adoption target)
                is the correct match for this content shape, so that's what this uses. */
            <div className="flex-1 overflow-auto px-8 py-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-h4 font-medium text-foreground">Connections</h1>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <button onClick={()=>setSyncRangePickerOpen(o=>!o)}
                      className="flex items-center gap-1.5 rounded-sm border border-input bg-background px-2.5 py-1.5 text-xs text-foreground">
                      <span className="text-muted-foreground">Range:</span> {syncDateRange.start} → {syncDateRange.end}
                    </button>
                    {syncRangePickerOpen&&(
                      <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[340px] rounded-sm border border-border bg-background p-3.5 shadow-card">
                        <div className="mb-3 flex gap-3.5 border-b border-border">
                          {["recommended","custom"].map(tab=>(
                            <button key={tab} type="button" onClick={()=>setSyncRangeTab(tab)}
                              className={cn("pb-2 text-xs font-semibold capitalize",syncRangeTab===tab?"border-b-2 border-foreground text-foreground":"text-muted-foreground")}>
                              {tab}
                            </button>
                          ))}
                        </div>
                        {syncRangeTab==="recommended"?(
                          <div className="flex flex-wrap gap-1.5">
                            {SYNC_RANGE_PRESETS.map(p=>(
                              <button key={p.label} type="button" onClick={()=>applySyncRangePreset(p)}
                                className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-foreground">{p.label}</button>
                            ))}
                          </div>
                        ):(
                          <div>
                            <div className="mb-2 text-xs text-muted-foreground">Pick an exact start and end date — useful for redoing a specific past window a preset doesn't cover.</div>
                            <div className="flex items-center gap-1.5">
                              <input type="date" value={syncDateRange.start} onChange={e=>setSyncDateRange(p=>({...p,start:e.target.value}))}
                                className="rounded-sm border border-input bg-background px-1.5 py-1 text-xs text-foreground outline-none"/>
                              <span className="text-xs text-muted-foreground">→</span>
                              <input type="date" value={syncDateRange.end} max={localISODate(new Date())}
                                title="Can't pull spend data for dates that haven't happened yet"
                                onChange={e=>{
                                  const todayStr=localISODate(new Date());
                                  setSyncDateRange(p=>({...p,end:e.target.value>todayStr?todayStr:e.target.value}));
                                }}
                                className="rounded-sm border border-input bg-background px-1.5 py-1 text-xs text-foreground outline-none"/>
                            </div>
                            <Button onClick={()=>setSyncRangePickerOpen(false)} size="sm" className="mt-2.5">Done</Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <Button onClick={()=>setDataSourcesSubView("add")} size="sm">
                    <Plus className="h-3.5 w-3.5"/> Add data source
                  </Button>
                </div>
              </div>
              <div className="mb-4 max-w-[620px] text-xs leading-relaxed text-muted-foreground">
                Every ad account this workspace pulls live spend from — see who connected each one, when it last imported, and manage it from the ⋯ menu.
              </div>
              {Object.entries(syncState).filter(([,s])=>s.startsWith("error:")).map(([k,s])=>(
                <div key={k} className="mb-1.5 text-xs text-destructive">{k}: {s.replace("error:","")}</div>
              ))}
              {(()=>{
                const connectedPlatforms=PLATFORMS.filter(pl=>pl.perWorkspaceAuth&&connectionDetails.find(c=>c.provider===pl.key));
                if(connectedPlatforms.length===0){
                  return(
                    <Card className="border-dashed">
                      <CardContent className="flex flex-col items-center gap-1 p-8 text-center">
                        <div className="text-sm font-semibold text-foreground">No data sources connected yet</div>
                        <div className="mb-2.5 text-xs text-muted-foreground">Connect LinkedIn, Bing, Funnel.io and more — or upload a CSV/screenshot directly.</div>
                        <Button onClick={()=>setDataSourcesSubView("add")} size="sm">
                          <Plus className="h-3.5 w-3.5"/> Add data source
                        </Button>
                      </CardContent>
                    </Card>
                  );
                }

                const rows=connectedPlatforms.map(pl=>{
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
                  const statusVariant=warn?"warning":conn.paused?"secondary":"success";
                  const syncRolling=conn.syncMode==="rolling";
                  const syncFailed=syncRolling&&conn.lastAutoSyncStatus==="error";
                  const syncLabel=syncRolling?(conn.syncFrequency==="weekly"?"Weekly":"Daily"):"Manual";
                  const syncVariant=syncFailed?"destructive":syncRolling?"default":"secondary";
                  const syncTitle=syncRolling?`Rolling sync — ${syncLabel.toLowerCase()}, last ${conn.rollingWindowDays||14} days. Set from the ⋯ menu's Sync schedule.`:"Manual only — data only updates when someone clicks Sync now, or from the ⋯ menu's Sync schedule.";
                  const importRange=importDateRangeByProvider[pl.key];
                  const fmtShort=d=>d?fmtCalendarDate(d,{month:"short",day:"numeric",year:"numeric"}):"—";
                  const menuOpen=connActionsMenuProvider===pl.key;
                  const syncing=(syncState[pl.key]||"idle")==="loading";
                  const saving=savingConnectionFlag===pl.key||disconnectingProvider===pl.key||syncing;
                  return{pl,conn,connectedByEmail,summaryText,statusLabel,warn,statusVariant,syncLabel,syncVariant,syncFailed,syncTitle,importRange,fmtShort,menuOpen,syncing,saving};
                });

                const ActionsMenu=({r})=>r.menuOpen&&connActionsMenuAnchorRect&&createPortal(
                  <>
                    <div onClick={closeConnActionsMenu} className="fixed inset-0 z-[999]"/>
                    <div className="fixed z-[1000] flex min-w-[220px] flex-col rounded-sm border border-border bg-background p-1.5 shadow-card"
                      style={{top:connActionsMenuAnchorRect.bottom+6,left:Math.max(8,connActionsMenuAnchorRect.right-220)}}>
                      {!r.conn.paused&&!r.conn.needsReconnect&&!r.conn.needsAccountSelection&&(
                        <button onClick={()=>{closeConnActionsMenu();syncPlatform(r.pl.key);}} disabled={!canEdit||r.syncing}
                          className="rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary disabled:opacity-50">{r.syncing?"Syncing…":"Sync now"}</button>
                      )}
                      {!r.conn.paused&&!r.conn.needsReconnect&&!r.conn.needsAccountSelection&&(
                        <button onClick={()=>{closeConnActionsMenu();syncPlatform(r.pl.key,{forceFull:true});}} disabled={!canEdit||r.syncing}
                          title="Re-pulls the entire selected date range from scratch, even days already synced — for backfills/repairs, not routine use."
                          className="rounded-sm px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-secondary disabled:opacity-50">{r.syncing?"Syncing…":"Full resync"}</button>
                      )}
                      {r.conn.needsAccountSelection&&(
                        <button onClick={()=>{closeConnActionsMenu();openAccountPicker(r.pl.key);}} disabled={!canEdit}
                          className="rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary disabled:opacity-50">Pick account</button>
                      )}
                      {r.conn.needsReconnect&&(
                        <button onClick={()=>{closeConnActionsMenu();startProviderOAuth(r.pl.key);}} disabled={!canEdit}
                          className="rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary disabled:opacity-50">Reconnect</button>
                      )}
                      {!r.conn.needsAccountSelection&&!r.conn.needsReconnect&&(
                        <button onClick={()=>{closeConnActionsMenu();r.pl.oauth?openAccountPicker(r.pl.key):openConnectPanel(r.pl.key);}} disabled={!canEdit}
                          className="rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary disabled:opacity-50">{r.pl.oauth?"Switch account":"Edit connection"}</button>
                      )}
                      {r.pl.key==="googlesheets"&&!r.conn.needsAccountSelection&&!r.conn.needsReconnect&&(
                        <button onClick={()=>{closeConnActionsMenu();openAdjustMapping(r.conn);}} disabled={!canEdit}
                          className="rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary disabled:opacity-50">Adjust mapping</button>
                      )}
                      {!r.warn&&(
                        <div className="px-2.5 pb-1 pt-1.5" onClick={e=>e.stopPropagation()}>
                          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sync schedule</div>
                          <div className="flex flex-col gap-1.5">
                            <Select value={r.conn.syncMode==="rolling"?r.conn.syncFrequency:"manual"}
                              onValueChange={v=>{if(!canEdit||savingSchedule===r.pl.key)return;v==="manual"
                                ?updateSyncSchedule(r.pl.key,{syncMode:"manual"})
                                :updateSyncSchedule(r.pl.key,{syncMode:"rolling",syncFrequency:v,rollingWindowDays:r.conn.rollingWindowDays||14});}}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue/></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="manual">Manual only</SelectItem>
                                <SelectItem value="daily">Daily</SelectItem>
                                <SelectItem value="weekly">Weekly</SelectItem>
                              </SelectContent>
                            </Select>
                            {r.conn.syncMode==="rolling"&&(
                              <Select value={String(r.conn.rollingWindowDays||14)}
                                onValueChange={v=>{if(!canEdit||savingSchedule===r.pl.key)return;updateSyncSchedule(r.pl.key,{syncMode:"rolling",syncFrequency:r.conn.syncFrequency,rollingWindowDays:Number(v)});}}>
                                <SelectTrigger className="h-8 text-xs"><SelectValue/></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="7">Last 7 days</SelectItem>
                                  <SelectItem value="14">Last 14 days</SelectItem>
                                  <SelectItem value="30">Last 30 days</SelectItem>
                                  <SelectItem value="60">Last 60 days</SelectItem>
                                  <SelectItem value="90">Last 90 days</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                          {r.conn.syncMode==="rolling"&&r.conn.lastAutoSyncAt&&(
                            <div className={cn("mt-1.5 text-[10px]",r.conn.lastAutoSyncStatus==="error"?"text-destructive":"text-muted-foreground")}>
                              {r.conn.lastAutoSyncStatus==="error"
                                ?`Auto-sync failed ${new Date(r.conn.lastAutoSyncAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}: ${r.conn.lastAutoSyncError||"unknown error"}`
                                :`Auto-synced ${new Date(r.conn.lastAutoSyncAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}`}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="my-1 h-px bg-border"/>
                      <button onClick={()=>{closeConnActionsMenu();updateConnectionFlags(r.pl.key,{paused:!r.conn.paused});}} disabled={!canEdit||r.saving}
                        className="rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary disabled:opacity-50">{r.conn.paused?"Resume import":"Pause import"}</button>
                      <button onClick={()=>{closeConnActionsMenu();updateConnectionFlags(r.pl.key,{excludedFromData:!r.conn.excludedFromData});}} disabled={!canEdit||r.saving}
                        className="rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary disabled:opacity-50">{r.conn.excludedFromData?"Use this data in PaidHQ":"Don't use this data in PaidHQ"}</button>
                      <div className="my-1 h-px bg-border"/>
                      <button onClick={()=>{closeConnActionsMenu();disconnectConnection(r.pl.key);}} disabled={!canEdit||r.saving}
                        className="rounded-sm px-2.5 py-1.5 text-left text-sm text-destructive hover:bg-secondary disabled:opacity-50">Disconnect</button>
                    </div>
                  </>,
                  document.body
                );

                const DotsButton=({r})=>(
                  <div className="relative flex justify-end">
                    <button onClick={e=>{
                        if(r.menuOpen){closeConnActionsMenu();return;}
                        setConnActionsMenuAnchorRect(e.currentTarget.getBoundingClientRect());
                        setConnActionsMenuProvider(r.pl.key);
                      }} title="Actions" disabled={r.saving}
                      className={cn("flex h-6 w-6 items-center justify-center rounded-sm border border-border text-muted-foreground disabled:opacity-50",r.menuOpen&&"bg-secondary")}>⋯</button>
                    <ActionsMenu r={r}/>
                  </div>
                );

                if(isMobile){
                  return(
                    <div className="rounded-sm border border-border">
                      {rows.map((r,i)=>(
                        <div key={r.pl.key} className={cn("px-2.5 py-2.5",i>0&&"border-t border-border")}>
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <PlatformLogo domain={r.pl.domain} color={r.pl.color} mark={r.pl.mark} size={18} T={T}/>
                              <span className="text-sm font-semibold text-foreground">{r.pl.label}</span>
                              <Badge variant={r.statusVariant}>{r.statusLabel}</Badge>
                              <Badge variant={r.syncVariant} title={r.syncTitle}>{r.syncLabel}</Badge>
                              {r.syncFailed&&(
                                <WarnTip T={T} text={`Auto-sync failed ${r.conn.lastAutoSyncAt?new Date(r.conn.lastAutoSyncAt).toLocaleDateString(undefined,{month:"short",day:"numeric"}):"recently"}: ${r.conn.lastAutoSyncError||"unknown error"}`}/>
                              )}
                            </div>
                            <DotsButton r={r}/>
                          </div>
                          <div className="text-sm text-muted-foreground">{r.summaryText}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {r.connectedByEmail||"—"} · connected {r.fmtShort(r.conn.connectedAt)} · imported {r.fmtShort(r.importRange?.start)}–{r.fmtShort(r.importRange?.end)}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                }

                return(
                  <Card className="overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Connector</TableHead>
                          <TableHead>Data source name</TableHead>
                          <TableHead>Credentials</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Sync</TableHead>
                          <TableHead>Connected</TableHead>
                          <TableHead>Import start</TableHead>
                          <TableHead>Import end</TableHead>
                          <TableHead/>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map(r=>(
                          <TableRow key={r.pl.key}>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                <PlatformLogo domain={r.pl.domain} color={r.pl.color} mark={r.pl.mark} size={18} T={T}/>
                                <span className="font-medium text-foreground">{r.pl.label}</span>
                              </div>
                            </TableCell>
                            <TableCell className="max-w-[200px] truncate">{r.summaryText}</TableCell>
                            <TableCell className="max-w-[160px] truncate">{r.connectedByEmail||"—"}</TableCell>
                            <TableCell>
                              <div className="flex flex-wrap items-center gap-1">
                                <Badge variant={r.statusVariant}>{r.statusLabel}</Badge>
                                {r.conn.excludedFromData&&<Badge variant="secondary">Hidden</Badge>}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Badge variant={r.syncVariant} title={r.syncTitle}>{r.syncLabel}</Badge>
                                {r.syncFailed&&(
                                  <WarnTip T={T} text={`Auto-sync failed ${r.conn.lastAutoSyncAt?new Date(r.conn.lastAutoSyncAt).toLocaleDateString(undefined,{month:"short",day:"numeric"}):"recently"}: ${r.conn.lastAutoSyncError||"unknown error"}`}/>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>{r.fmtShort(r.conn.connectedAt)}</TableCell>
                            <TableCell>{r.fmtShort(r.importRange?.start)}</TableCell>
                            <TableCell>{r.fmtShort(r.importRange?.end)}</TableCell>
                            <TableCell><DotsButton r={r}/></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
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
              <h2 style={{fontSize:20*(T.fsScale||1),fontWeight:700,color:T.text,letterSpacing:"-0.3px",marginBottom:4}}>Review extracted data</h2>
              <p style={{fontSize:13*(T.fsScale||1),color:T.textSub}}><strong style={{color:T.text,fontWeight:600}}>{screenshotFileName}</strong> · {screenshotPreview.length.toLocaleString()} rows found — check these against the screenshot before adding.</p>
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
                    <div style={{fontSize:11*(T.fsScale||1),color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.campaign_group_name}</div>
                    <div style={{fontSize:11*(T.fsScale||1),color:T.textSub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.campaign_name}</div>
                    <div style={{fontSize:11*(T.fsScale||1),color:T.textSub}}>{r.platform}</div>
                    <div style={{fontSize:11*(T.fsScale||1),color:T.textSub}}>{r.date}</div>
                    <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.text}}>{fmt$(r.spend)}</div>
                  </div>
                ))}
              </div>
            </PixelPanel>
            {/* Monthly-grain confirmation — same treatment as the CSV mapping step's equivalent
                block (2026-07-30, per Mo — screenshots previously had no way to set this at all,
                so a monthly dashboard screenshot always read as stale the moment it landed, since
                freshness falls back to the row's own date — the 1st of the month — when
                as_of_date is missing). Auto-checked when every extracted row's date looks like the
                1st of a month; uncheck if the screenshot actually showed real per-day numbers. */}
            <PixelPanel T={T} style={{marginBottom:18}} contentStyle={{background:T.accentBg,padding:"10px 16px"}}>
              <label style={{display:"flex",alignItems:"flex-start",gap:9,cursor:"pointer"}}>
                <input type="checkbox" checked={screenshotIsMonthly} onChange={e=>{
                  const checked=e.target.checked;
                  setScreenshotIsMonthly(checked);
                  if(checked&&!screenshotAsOf){
                    const y=new Date();y.setDate(y.getDate()-1);
                    setScreenshotAsOf(`${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,"0")}-${String(y.getDate()).padStart(2,"0")}`);
                  }
                }} style={{marginTop:2,cursor:"pointer",accentColor:T.accent,width:14,height:14,flexShrink:0}}/>
                <div>
                  <span style={{fontSize:13*(T.fsScale||1),fontWeight:500,color:T.text}}>This screenshot shows one number per month, not per day</span>
                  <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:2}}>A monthly dashboard/report screenshot (e.g. Google/Bing's manual view) reports the whole month's total, not a real daily figure. Checked automatically when every extracted row's date looks like the 1st of a month; uncheck if this screenshot actually showed real per-day numbers.</div>
                </div>
              </label>
              {screenshotIsMonthly&&(
                <div style={{marginTop:10,display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?"5px":"12px",alignItems:"center"}}>
                  <div>
                    <span style={{fontSize:12*(T.fsScale||1),fontWeight:500,color:T.text}}>Data accurate through</span>
                    <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:2}}>Each row's full-month spend is treated as current through this date — adjust if the screenshot is from a different day than today.</div>
                  </div>
                  <input type="date" value={screenshotAsOf} onChange={e=>setScreenshotAsOf(e.target.value)}
                    style={{background:T.inputBg,border:`1px solid ${screenshotIsMonthly&&!screenshotAsOf?T.dangerBorder:T.border}`,borderRadius:T.r6,color:T.text,padding:"7px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                </div>
              )}
              {/* Soft nudge, not a requirement (2026-07-30, per Mo) — monthly-grain data is fully
                  supported (pacing/forecasting handle it correctly), this is purely an FYI for
                  anyone who happens to have a per-day option and didn't realize it'd help. Never
                  blocks or requires anything — screenshots of monthly-only sources (a client's
                  monthly report, an exec dashboard) are a completely normal, supported case. */}
              {screenshotIsMonthly&&(
                <div style={{marginTop:8,fontSize:11*(T.fsScale||1),color:T.textMuted}}>💡 For a smoother day-by-day Trend view later, a per-day export or screenshot works even better than monthly — but monthly totals work fine too if that's what's available.</div>
              )}
            </PixelPanel>
            <div style={{padding:"10px 14px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:T.r8,marginBottom:14,fontSize:13*(T.fsScale||1),color:T.success,fontWeight:500}}>
              ✓ <strong>{screenshotPreview.length}</strong> rows · <strong>{fmt$(screenshotPreview.reduce((s,r)=>s+r.spend,0))}</strong> total spend — this was read by AI and may contain mistakes, double-check against the source before confirming.
              {screenshotIsMonthly&&<div style={{fontWeight:400,marginTop:2,fontSize:12*(T.fsScale||1)}}>Each row treated as one month's total, accurate through {screenshotAsOf||"—"}.</div>}
            </div>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <Btn onClick={()=>{setScreenshotPreview([]);setScreenshotFileName("");setScreenshotIsMonthly(false);setScreenshotAsOf("");setStep("upload");}} variant="ghost" T={T}>← Cancel</Btn>
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
              <h2 style={{fontSize:20*(T.fsScale||1),fontWeight:700,color:T.text,letterSpacing:"-0.3px",marginBottom:4}}>Map your columns</h2>
              <p style={{fontSize:13*(T.fsScale||1),color:T.textSub}}><strong style={{color:T.text,fontWeight:600}}>{fileName}</strong> · {rawRows.length.toLocaleString()} rows</p>
            </div>
            <PixelPanel T={T} style={{marginBottom:18}} contentStyle={{background:T.surface,overflow:"hidden"}}>
              {/* Channels — single platform override, or multiple channels read per-row from a
                  mapped column. Reports combining several platforms in one export (a blended
                  agency report, a multi-channel Sheet) need the latter; a single-platform export
                  with no Platform column at all needs the former. */}
              <div style={{padding:"10px 16px",borderBottom:`1px solid ${T.border}`,background:T.accentBg}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:isMobile?"wrap":"nowrap"}}>
                  <div>
                    <span style={{fontSize:13*(T.fsScale||1),fontWeight:500,color:T.text}}>Channels in this file</span>
                    <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:2}}>{uploadPlatform==="auto"?"Map the Platform column below — every distinct value becomes its own channel.":"Every row will be labeled as this one platform."}</div>
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    <button type="button" onClick={()=>setUploadPlatform("auto")}
                      style={{padding:"6px 12px",borderRadius:T.r6,border:`1px solid ${uploadPlatform==="auto"?T.accent:T.border}`,background:uploadPlatform==="auto"?T.accent:T.surface,color:uploadPlatform==="auto"?"#fff":T.text,fontSize:12*(T.fsScale||1),fontWeight:600,cursor:"pointer",fontFamily:T.font}}>Multiple channels</button>
                    <button type="button" onClick={()=>setUploadPlatform(p=>p==="auto"?"Google":p)}
                      style={{padding:"6px 12px",borderRadius:T.r6,border:`1px solid ${uploadPlatform!=="auto"?T.accent:T.border}`,background:uploadPlatform!=="auto"?T.accent:T.surface,color:uploadPlatform!=="auto"?"#fff":T.text,fontSize:12*(T.fsScale||1),fontWeight:600,cursor:"pointer",fontFamily:T.font}}>Single channel</button>
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
                      <span key={name} style={{fontSize:11*(T.fsScale||1),fontWeight:600,padding:"3px 9px",borderRadius:T.r20,background:T.surface,border:`1px solid ${T.border}`,color:T.text}}>{name} · {count.toLocaleString()}</span>
                    ))}
                  </div>
                )}
                {uploadPlatform==="auto"&&!colMap.platform&&rawRows.length>0&&(
                  <div style={{marginTop:10,fontSize:11*(T.fsScale||1),color:T.danger,fontWeight:600}}>Map the Platform column below to continue.</div>
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
                    <span style={{fontSize:13*(T.fsScale||1),fontWeight:500,color:T.text}}>This file has one row per month, not per day</span>
                    <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:2}}>Google/Bing's manual exports report one row per campaign PER MONTH (e.g. "Jul-26") with the month's total spend — not a real daily date. Checked automatically when every date in the file looks like the 1st of a month; uncheck if this file actually has real per-day rows.</div>
                  </div>
                </label>
                {uploadIsMonthly&&(
                  <div style={{marginTop:10,display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?"5px":"12px",alignItems:"center"}}>
                    <div>
                      <span style={{fontSize:12*(T.fsScale||1),fontWeight:500,color:T.text}}>Data accurate through</span>
                      <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginTop:2}}>Each row's full-month spend is treated as current through this date — adjust if you pulled the export on a different day than today.</div>
                    </div>
                    <input type="date" value={uploadAsOf} onChange={e=>setUploadAsOf(e.target.value)}
                      style={{background:T.inputBg,border:`1px solid ${uploadIsMonthly&&!uploadAsOf?T.dangerBorder:T.border}`,borderRadius:T.r6,color:T.text,padding:"7px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
                  </div>
                )}
                {/* Soft nudge, not a requirement (2026-07-30, per Mo) — monthly-grain data is fully
                    supported (pacing/forecasting handle it correctly), this is purely an FYI for
                    anyone who happens to have a per-day export option and didn't realize it'd
                    help. Never blocks or requires anything — monthly-only sources (an agency's
                    monthly report, a platform whose manual export only rolls up to month) are a
                    completely normal, supported case. */}
                {uploadIsMonthly&&(
                  <div style={{marginTop:8,fontSize:11*(T.fsScale||1),color:T.textMuted}}>💡 For a smoother day-by-day Trend view later, a per-day export works even better than monthly — but monthly totals work fine too if that's what's available.</div>
                )}
              </div>
              {[...REQUIRED_COLS,...OPTIONAL_COLS].map((field,i)=>{
                // Hide platform column mapping if a specific platform is selected
                if(field==="platform"&&uploadPlatform!=="auto")return null;
                const isRequired=REQUIRED_COLS.includes(field)||(field==="platform"&&uploadPlatform==="auto");
                return(
                <div key={field} style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?"5px":"12px",padding:"10px 16px",borderBottom:i<REQUIRED_COLS.length+OPTIONAL_COLS.length-1?`1px solid ${T.border}`:"none",alignItems:"center",background:isRequired&&!colMap[field]?T.dangerBg:"transparent"}}>
                  <div><span style={{fontSize:13*(T.fsScale||1),fontWeight:500,color:T.text}}>{COL_LABELS[field]}</span>{isRequired&&<span style={{fontSize:10*(T.fsScale||1),color:T.danger,marginLeft:6,fontWeight:600}}>required</span>}{!isRequired&&<span style={{fontSize:10*(T.fsScale||1),color:T.textMuted,marginLeft:6}}>optional</span>}</div>
                  <Sel value={colMap[field]||""} onChange={v=>setColMap(p=>({...p,[field]:v||undefined}))} T={T}><option value="">— not mapped —</option>{headers.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                </div>
                );
              })}
            </PixelPanel>
            {canProceed&&(
              <div style={{padding:"10px 14px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:T.r8,marginBottom:14,fontSize:13*(T.fsScale||1),color:T.success,fontWeight:500}}>
                ✓ Found <strong>{campaigns.length}</strong> campaigns · <strong>{fmt$(campaigns.reduce((s,c)=>s+c.spend,0))}</strong> total spend
                <div style={{fontWeight:400,marginTop:2,fontSize:12*(T.fsScale||1)}}>{uploadIsMonthly?`Each row treated as one month's total, accurate through ${uploadAsOf||"—"}.`:"Each row treated as a single day's spend."} {uploadPlatform==="auto"?`Channels read per-row from "${colMap.platform}".`:`All rows labeled "${uploadPlatform}".`}</div>
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <Btn onClick={()=>setStep("upload")} variant="ghost" T={T}>← Back</Btn>
              <Btn onClick={()=>{
                if(!canEdit)return;
                const norm=normalizeRows(rawRows,colMap);
                const withPlatform=uploadPlatform==="auto"?norm:norm.map(r=>({...r,platform:uploadPlatform}));
                // is_monthly rides along with as_of_date (2026-07-30, per Mo — closes the DOW-
                // seasonality contamination gap: without this, computePlatformDayOfWeekIndex had
                // no way to tell a real day's spend apart from a whole month's total sitting on
                // one row, and would learn a skewed weekly pattern from it).
                const withAsOfBase=uploadAsOf?withPlatform.map(r=>({...r,as_of_date:uploadAsOf,...(uploadIsMonthly?{is_monthly:true}:{})})):withPlatform;
                // Tags every row with which manual-import path produced it (2026-07-31, per Mo's
                // Data Audit tab) — "csv" for a real uploaded file, "sheet-onetime" for the one-time
                // "Connect a Google Sheet" pull just below (NOT the same thing as the daily-syncing
                // googlesheets connector in Data Sources, which tags "sync:googlesheets" instead).
                // Matches the `sync:<provider>` convention closely enough that Data Audit's source
                // labeling can tell every import method apart at a glance.
                const withAsOf=withAsOfBase.map(r=>({...r,source:uploadSourceKind}));
                const fileLabel=fileName||"CSV";
                const conflicts=detectSpendConflicts(mergedNormRows,withAsOf);
                if(conflicts.length){
                  setSpendConflictReview({conflicts,pendingRows:withAsOf,fileLabel,useImportedSet:new Set()});
                  return;
                }
                setMergedNormRows(prev=>mergeRows(prev,withAsOf));
                commitPendingSpendImportConfig();
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
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0}}>
          {/* Campaigns/Ads mode toggle (2026-08-19, per Mo — "tag Ads by tags and dimension" for
              paid social channels: LinkedIn/Meta/Reddit/6sense). Ads mode is a SEPARATE component
              (AdTagger.jsx) built on its own identity (campaign+ad group+ad name, see adKey in
              core.js) and its own tag storage (adTags, a parallel key in workspace_config) rather
              than extending campaignKey/tags to a third level — campaignKey is used in ~15 places
              across this file/core.js (Budget Panel, Pacing, exports, Ask AI, Data Audit...) that
              have no reason to know about ads, so keeping Ads additive avoids regression risk
              across all of that surface. AdTagger loads via the new GET ?aggregate=identity
              endpoint (spend-rows.js) rather than reducing every raw row client-side the way
              Campaigns mode's own `campaigns` useMemo below does, so it stays fast once ad-level
              data multiplies row counts. */}
          <div style={{display:"flex",gap:6,padding:"10px 16px 0",flexShrink:0}}>
            {[{key:"campaigns",label:"Campaigns"},{key:"ads",label:"Ads"}].map(m=>(
              <button key={m.key} onClick={()=>setTaggerMode(m.key)}
                style={{padding:"5px 12px",borderRadius:T.r7,border:`1px solid ${taggerMode===m.key?T.accentHover:T.border}`,background:taggerMode===m.key?T.accent:T.surface,color:T.text,cursor:"pointer",fontFamily:T.font,fontSize:12*(T.fsScale||1),fontWeight:600}}>
                {m.label}
              </button>
            ))}
          </div>
          {taggerMode==="ads"?(
            <Suspense fallback={<TabLoadingFallback/>}>
              <AdTagger T={T} session={session} workspace={workspace} canEdit={canEdit} tagDims={tagDims}
                tags={tags} adTags={adTags} setAdTags={setAdTags} combineGoogleChannels={combineGoogleChannels}/>
            </Suspense>
          ):(
        <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
            {suggestions.length>0&&(
              <div style={{padding:"7px 16px",background:T.accentBg,borderBottom:`1px solid ${T.border}`,display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",flexShrink:0}}>
                <span style={{fontSize:10*(T.fsScale||1),fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text}}>Suggest</span>
                {suggestions.map(s=><button key={s.key} onClick={()=>applySug(s.dim,s.val)} style={{fontSize:12*(T.fsScale||1),background:T.surface,border:`1px solid ${T.border}`,color:T.text,borderRadius:T.r14,padding:"3px 10px",cursor:"pointer",fontFamily:T.font,fontWeight:500}}>Apply {s.dim}: {s.val} to {s.count} untagged</button>)}
              </div>
            )}
            {selected.size>0&&(
              <div style={{padding:"8px 16px",background:T.surface,borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",flexShrink:0}}>
                <Pill color={T.text} bg={T.accent} border={T.text}>{selected.size} selected</Pill>
                <span style={{color:T.textMuted,fontSize:13*(T.fsScale||1)}}>→</span>
                <Sel value={applyDim} onChange={setApplyDim} T={T} style={{width:130,fontSize:12*(T.fsScale||1)}}><option value="">Dimension…</option>{tagDims.map(d=><option key={d} value={d}>{d}</option>)}</Sel>
                <TagAutocompleteInput T={T} value={applyVal} onChange={setApplyVal} suggestions={dimSuggestions(applyDim)} onEnter={applyTags} placeholder="Tag value…" style={{width:130}}
                  inputStyle={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r7,color:T.text,padding:"6px 10px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,transition:"border-color 0.12s"}}/>
                <Btn onClick={applyTags} disabled={!applyDim||!applyVal} variant="primary" size="sm" T={T}>Apply</Btn>
                <Btn onClick={()=>bulkRemoveTag(applyDim)} disabled={!applyDim} variant="danger" size="sm" T={T}>Remove</Btn>
                <div style={{width:1,height:16,background:T.border}}/>
                <Btn onClick={exportSelectedCsv} variant="ghost" size="sm" T={T} title="Download just the selected rows — Campaign Group, Campaign, Platform, Spend, and every tag dimension">Export CSV</Btn>
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
                  style={{display:"flex",alignItems:"center",gap:5,background:filtersOpen?T.surfaceHover:"transparent",border:`1px solid ${T.border}`,borderRadius:T.r6,padding:"3px 8px",cursor:"pointer",fontFamily:T.font,fontSize:11*(T.fsScale||1),fontWeight:600,color:T.text,outline:"none"}}>
                  <Icon name="filter" size={12} color={T.text}/>
                  Filters
                  {hasF&&<span style={{width:6,height:6,borderRadius:"50%",background:T.accent,flexShrink:0}}/>}
                </button>
                {!filtersOpen&&hasF&&<button onClick={clearF} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11*(T.fsScale||1),fontFamily:T.font,textDecoration:"underline",padding:0,outline:"none"}}>Clear filters</button>}
                {/* Replaces the top bar's old "↑ Add data" button (removed 2026-07-24, see the
                    doc comment where it used to live) — same destination, just living down here
                    with the rest of this table's own controls instead of the crowded global bar. */}
                <div style={{marginLeft:"auto"}}>
                  <Btn onClick={()=>{setStep("upload");setView("data");}} variant="ghost" size="sm" T={T}>← Back to Data Sources</Btn>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:isMobile?"22px 32px 1fr 90px":"22px 32px minmax(160px,1fr) minmax(160px,1fr) 110px 130px minmax(180px,1fr)",padding:"11px 16px 5px",alignItems:"end",gap:8,background:T.headerBg}}>
                {/* Row number column (2026-08-19, per Mo — "add a row number to the campaign tagger
                    and pipeline tagger"). Reflects the table's current sort/filter position, not a
                    stable per-campaign id — same reasoning as PipelineTagger.jsx's NumTh/NumTd. */}
                <span style={{fontSize:10*(T.fsScale||1),fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.textMuted,textAlign:"right"}}>#</span>
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
                    style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:T.r5,color:T.text,cursor:"pointer",fontSize:10*(T.fsScale||1),padding:"1px 6px",fontFamily:T.font,whiteSpace:"nowrap"}}>
                    ↩ Undo ({tagsHistory.length})
                  </button>}
                </div>}
              </div>
              {filtersOpen&&<div style={{display:"grid",gridTemplateColumns:isMobile?"22px 32px 1fr 90px":"22px 32px minmax(160px,1fr) minmax(160px,1fr) 110px 130px minmax(180px,1fr)",padding:"3px 16px 10px",gap:8,alignItems:"start"}}>
                <div/>
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
                    {hasF&&<button onClick={clearF} style={{background:T.dangerBg,border:`1px solid ${T.danger}`,color:T.danger,borderRadius:T.r6,padding:"0 8px",cursor:"pointer",fontSize:11*(T.fsScale||1),fontFamily:T.font,whiteSpace:"nowrap"}}>Clear ×</button>}
                  </div>
                  <div style={{display:"flex",gap:4}}>
                    <input value={fTagExclude} onChange={e=>setFTagExclude(e.target.value)} placeholder="≠ tag excludes… (a, b)" title={`Comma-separate multiple terms — ${fTagExclMode==="and"?"excludes only rows containing ALL of them":"excludes any of them"}`} style={{...fIn,flex:1,marginTop:0}}/>
                    <MatchModeToggle mode={fTagExclMode} onChange={setFTagExclMode} T={T}/>
                  </div>
                </div>}
              </div>}
            </div>

            <div style={{overflow:"auto",flex:1}}>
              {filtered.map((c,ci)=>{
                const ts=tags[c.key]||{};const tc=Object.keys(ts).length;const isSel=selected.has(c.key);const pc=PLATFORM_COLORS[c.platform]||T.textMuted;
                return(
                  <div key={c.key} className={isSel?undefined:"bhq-row"} onClick={()=>toggleSel(c.key)}
                    style={{display:"grid",gridTemplateColumns:isMobile?"22px 32px 1fr 90px":"22px 32px minmax(160px,1fr) minmax(160px,1fr) 110px 130px minmax(180px,1fr) 24px",padding:"11px 16px",borderBottom:`1px solid ${T.border}`,alignItems:"center",cursor:"pointer",background:isSel?T.rowSelected:T.surface,transition:"background 0.1s",gap:6}}>
                    <span style={{fontSize:12*(T.fsScale||1),color:T.textMuted,textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{ci+1}</span>
                    <input type="checkbox" checked={isSel} onChange={()=>toggleSel(c.key)} onClick={e=>e.stopPropagation()} style={{cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                    {/* Group and Campaign now share one text treatment (size/weight/color) instead
                        of a muted-vs-bold pair — Vercel's row title and metadata fields read at the
                        same visual weight, just differing in which column they sit in. Weight
                        dropped to 400 (2026-07-24, per Mo) — no benefit to bolding row data. */}
                    {!isMobile&&<div title={c.groupName} style={{fontSize:13*(T.fsScale||1),fontWeight:400,fontFamily:T.font,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.groupName}</div>}
                    {/* Status dot mirrors the "Ready"-style indicator on a Vercel deployment row —
                        here it means tagged (accent) vs needs review (neutral grey), so the row list
                        reads at a glance without scanning all the way over to the Tags column. */}
                    <div style={{minWidth:0,display:"flex",alignItems:"center",gap:11}}>
                      <span title={tc>0?"Tagged":"Needs review"} style={{width:9,height:9,borderRadius:"50%",background:tc>0?T.accent:"#A1A1AA",flexShrink:0}}/>
                      <span title={c.name} style={{minWidth:0,fontSize:13*(T.fsScale||1),fontWeight:400,fontFamily:T.font,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</span>
                    </div>
                    <div style={{fontSize:13*(T.fsScale||1),fontFamily:T.font,fontWeight:400,color:T.text}}>{fmt$(c.spend)}</div>
                    {!isMobile&&<div onClick={e=>e.stopPropagation()}>
                      {editingPlatform===c.key?(
                        <select autoFocus value={c.platform}
                          onChange={e=>{if(!canEdit)return;const plat=e.target.value;setMergedNormRows(prev=>prev.map(r=>campaignKey(r.campaign_group_name,r.campaign_name)===c.key?{...r,platform:plat}:r));setEditingPlatform(null);}}
                          onBlur={()=>setEditingPlatform(null)}
                          style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r5,color:T.text,fontSize:13*(T.fsScale||1),padding:"2px 6px",outline:"none",fontFamily:T.font,cursor:"pointer"}}>
                          {PLATFORM_OPTIONS.filter(p=>p!=="auto").map(p=><option key={p} value={p}>{p}</option>)}
                        </select>
                      ):(
                        <span onClick={()=>canEdit&&setEditingPlatform(c.key)} title={canEdit?"Click to change platform":"View-only access"}
                          style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:13*(T.fsScale||1),fontWeight:400,padding:"3px 8px",borderRadius:T.r6,background:pc+"14",color:pc,border:`1px solid ${pc}55`,whiteSpace:"nowrap",cursor:canEdit?"pointer":"default"}}>
                          <span style={{width:5,height:5,borderRadius:"50%",background:pc,flexShrink:0}}/>
                          {c.platform}
                        </span>
                      )}
                    </div>}
                    {!isMobile&&<div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
                      {tc===0?<Pill color={T.text} bg={T.surfaceEl} border={T.border} style={{fontFamily:T.font,fontSize:13*(T.fsScale||1),fontWeight:400,borderRadius:T.r6}}>needs review</Pill>:
                        // Ordered by tagDims (the canonical dimension order), not Object.entries(ts) —
                        // a plain object's key order follows INSERTION order, which is whatever
                        // sequence that specific campaign happened to get tagged in (BU-then-Product
                        // for one row, Product-then-BU for another), so pills visibly reshuffled
                        // between rows even though the underlying data was identical. tagDims order
                        // is fixed regardless of tagging order, so every row's pills line up the same.
                        [...tagDims.filter(d=>Object.prototype.hasOwnProperty.call(ts,d)),...Object.keys(ts).filter(d=>!tagDims.includes(d))].map(dim=>{
                          const val=ts[dim];
                          const dimIdx=tagDims.indexOf(dim);
                          const dimColors=T.tagDimColors||TAG_DIM_COLORS;
                          const dc=dimColors[(dimIdx>=0?dimIdx:0)%dimColors.length];
                          return(
                          <span key={dim} style={{display:"inline-flex",alignItems:"center",fontSize:13*(T.fsScale||1),fontWeight:400,padding:"2px 4px 2px 8px",borderRadius:T.r6,background:dc+"14",color:dc,border:`1px solid ${dc}40`,gap:2,fontFamily:T.font}}>
                            <span style={{opacity:0.75,marginRight:1}}>{dim}:</span>
                            {editingTag?.campaign===c.key&&editingTag?.dim===dim?(
                              <TagAutocompleteInput T={T} autoFocus value={editVal} onChange={setEditVal} suggestions={dimSuggestions(dim)}
                                onEnter={saveEdit} onEscape={()=>{setEditingTag(null);setEditVal("");}} onBlur={saveEdit}
                                style={{width:Math.max(60,editVal.length*7+20)+"px"}}
                                inputStyle={{background:"transparent",border:"none",outline:"none",color:T.text,fontSize:13*(T.fsScale||1),fontWeight:400,width:"100%",fontFamily:T.font,padding:0}}/>
                            ):(
                              <span onClick={e=>{e.stopPropagation();if(!canEdit)return;setEditingTag({campaign:c.key,dim});setEditVal(val);}} style={{cursor:canEdit?"text":"default",fontWeight:400}}>{val}</span>
                            )}
                            {canEdit&&<span onClick={e=>{e.stopPropagation();removeTag(c.key,dim);}} style={{color:T.textMuted,cursor:"pointer",fontSize:13*(T.fsScale||1),lineHeight:1,marginLeft:1,padding:"0 2px"}}>×</span>}
                          </span>
                          );
                        })
                      }
                    </div>}
                    {!isMobile&&canEdit&&<button onClick={e=>{e.stopPropagation();if(window.confirm(`Remove "${c.name}" from this dataset?\n\nThis only affects the current session — your tags are kept. You can re-sync or re-upload to restore it.`)){setMergedNormRows(prev=>prev.filter(r=>campaignKey(r.campaign_group_name,r.campaign_name)!==c.key));}}} title="Remove this campaign"
                      style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:T.r5,color:T.textMuted,cursor:"pointer",fontSize:12*(T.fsScale||1),lineHeight:1,padding:0,opacity:0.4,transition:"all 0.1s"}}
                      onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.border=`1px solid ${T.danger}`;e.currentTarget.style.color=T.danger;}}
                      onMouseLeave={e=>{e.currentTarget.style.opacity=0.4;e.currentTarget.style.border="1px solid transparent";e.currentTarget.style.color=T.textMuted;}}>✕</button>}
                  </div>
                );
              })}
              {filtered.length===0&&<div style={{padding:"40px 20px 52px",textAlign:"center",color:T.textMuted,fontSize:13*(T.fsScale||1)}}>
                <div>No campaigns match your filters.{hasF&&<span onClick={clearF} style={{color:T.text,cursor:"pointer",marginLeft:6,fontWeight:400,textDecoration:"underline"}}>Clear filters</span>}</div>
              </div>}
            </div>
          </div>
        </div>
          )}
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
      {view==="dashboard"&&<Suspense fallback={<TabLoadingFallback/>}><Dashboard T={T} onNavigate={v=>{if(v==="tagger"){if(mergedNormRows.length>0){setStep("tag");setView("tagger");}else{setStep("upload");setView("data");}}else if(v==="data"){setStep("upload");setView("data");}else setView(v);}} stats={stats} hasData={visibleNormRows.length>0} budgets={budgets} budgetDims={budgetDims} budgetRowMeta={budgetRowMeta} defaultForecastModel={defaultForecastModel} campaignTags={tags} mergedNormRows={visibleNormRows} connectionDetails={connectionDetails} exportTags={exportTags} combineGoogleChannels={combineGoogleChannels}/></Suspense>}
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
        <BudgetManager campaignTags={tags} setTags={setTags} tagDimensions={tagDims} T={T} session={session} onAddDimensions={newDims=>setTagDims(p=>[...new Set([...p,...newDims])])} budgets={budgets} setBudgets={setBudgets} budgetDims={budgetDims} setBudgetDims={setBudgetDims} budgetRowMeta={budgetRowMeta} setBudgetRowMeta={setBudgetRowMeta} budgetMetaDims={budgetMetaDims} setBudgetMetaDims={setBudgetMetaDims} budgetImportMeta={budgetImportMeta} setBudgetImportMeta={setBudgetImportMeta} defaultForecastModel={defaultForecastModel} mergedNormRows={visibleNormRows} onCheckpoint={checkpoint} sidebarEl={budgetSidebarEl} canEdit={canEdit} combineGoogleChannels={combineGoogleChannels} initialImportFile={pendingBudgetImportFile} onConsumeInitialImportFile={()=>setPendingBudgetImportFile(null)} promptAndArchiveFile={promptAndArchiveFile} budgetChartColor={budgetChartColor} setBudgetChartColor={setBudgetChartColor}/>
        </Suspense>
      </div>
      {view==="pacing"&&<Suspense fallback={<TabLoadingFallback/>}><PacingDashboard campaignTags={tags} setTags={setTags} tagDimensions={tagDims} budgetDims={budgetDims} budgets={budgets} setBudgets={setBudgets} budgetRowMeta={budgetRowMeta} setBudgetRowMeta={setBudgetRowMeta} savedViews={savedViews} setSavedViews={setSavedViews} defaultForecastModel={defaultForecastModel} setDefaultForecastModel={setDefaultForecastModel} mergedNormRows={visibleNormRows} T={T} session={session} workspace={workspace} onNavigate={setView} sidebarEl={pacingSidebarEl} onAskAboutView={q=>{setPendingAskQuestion(q);setView("ask");}} initialViewConfig={pendingViewConfig} onConsumeInitialViewConfig={()=>setPendingViewConfig(null)} combineGoogleChannels={combineGoogleChannels}/></Suspense>}
      {view==="ask"&&<Suspense fallback={<TabLoadingFallback/>}><AskAI T={T} session={session} workspace={workspace} canEdit={canEdit} mergedNormRows={visibleNormRows} tags={tags} tagDims={tagDims} budgetDims={budgetDims} budgets={budgets} budgetRowMeta={budgetRowMeta} defaultForecastModel={defaultForecastModel} customMetrics={customMetrics} hasData={visibleNormRows.length>0} askChats={askChats} setAskChats={setAskChats} askProjects={askProjects} setAskProjects={setAskProjects} activeAskChatId={activeAskChatId} setActiveAskChatId={setActiveAskChatId} sidebarEl={askSidebarEl} initialQuestion={pendingAskQuestion} onConsumeInitialQuestion={()=>setPendingAskQuestion(null)} onSaveAsView={cfg=>{setPendingViewConfig(cfg);setView("pacing");}} combineGoogleChannels={combineGoogleChannels}/></Suspense>}
      {view==="reportingAnalyzer"&&<Suspense fallback={<TabLoadingFallback/>}><ReportingAnalyzer T={T} session={session} workspace={workspace} initialPendingRows={pendingReportingRows} onConsumeInitialPendingRows={()=>setPendingReportingRows(null)} initialRawPipelineImport={pendingReportingRawImport} onConsumeInitialRawPipelineImport={()=>setPendingReportingRawImport(null)} campaignTags={tags} tagDims={tagDims} canEdit={canEdit} onBackToDataSources={()=>setView("data")} sidebarEl={reportingAnalyzerSidebarEl} archiveImportConfig={archiveImportConfig}/></Suspense>}
      {view==="pipelineTagger"&&<Suspense fallback={<TabLoadingFallback/>}><PipelineTagger T={T} session={session} workspace={workspace} tagDims={tagDims} customMetrics={customMetrics} sidebarEl={pipelineTaggerSidebarEl} pipelineDimensions={pipelineDimensions} setPipelineDimensions={setPipelineDimensions} pipelineViews={pipelineViews} setPipelineViews={setPipelineViews} canEdit={canEdit}/></Suspense>}
      {view==="goalsObjectives"&&<Suspense fallback={<TabLoadingFallback/>}><GoalsObjectives T={T} session={session} workspace={workspace} tagDims={tagDims} canEdit={canEdit} sidebarEl={goalsObjectivesSidebarEl} promptAndArchiveFile={promptAndArchiveFile} initialImportFile={pendingGoalsImportFile} onConsumeInitialImportFile={()=>setPendingGoalsImportFile(null)}/></Suspense>}
      {/* Account Planning — no longer takes mergedNormRows/tags/etc (2026-08-07, see the lazy
          import's own doc comment above); it's purely the plan wizard now. Sidebar portal
          (accountPlanningSidebarEl) unchanged. */}
      {view==="accountPlanning"&&<Suspense fallback={<TabLoadingFallback/>}><AccountPlanning T={T} session={session} workspace={workspace} canEdit={canEdit} sidebarEl={accountPlanningSidebarEl}/></Suspense>}
      {/* Campaign Audit — same "raw mergedNormRows, own reporting_facts fetch" shape Account
          Planning's old Audit step had (deliberately NOT visibleNormRows — an audit of what's
          working shouldn't silently hide a paused/excluded connector's history, same reasoning as
          Data Audit's own comment below). No sidebar portal needed (self-contained page, same as
          Data Audit). */}
      {view==="campaignAudit"&&<Suspense fallback={<TabLoadingFallback/>}><CampaignAudit T={T} session={session} workspace={workspace} mergedNormRows={mergedNormRows} combineGoogleChannels={combineGoogleChannels} tags={tags} tagDims={tagDims} adTags={adTags}/></Suspense>}
      {view==="changeHistory"&&<Suspense fallback={<TabLoadingFallback/>}><ChangeHistory T={T} session={session} workspace={workspace} canEdit={canEdit} sidebarEl={changeHistorySidebarEl}/></Suspense>}
      {view==="vault"&&<Suspense fallback={<TabLoadingFallback/>}><Vault T={T} session={session} workspace={workspace} canEdit={canEdit} sidebarEl={vaultSidebarEl}/></Suspense>}
      {/* Data Audit — read-only view over the full merged spend history (mergedNormRows, not the
          exclusion-filtered visibleNormRows), so gap/overlap detection sees every row that's ever
          been imported, including anything a user has since hidden from the dashboards. */}
      {view==="dataAudit"&&<Suspense fallback={<TabLoadingFallback/>}><DataAudit T={T} session={session} workspace={workspace} mergedNormRows={mergedNormRows} combineGoogleChannels={combineGoogleChannels} tagDims={tagDims}/></Suspense>}
      {view==="settings"&&(()=>{
        const budgetYears=Object.keys(budgets).length;
        const budgetSegs=Object.values(budgets).reduce((s,y)=>s+Object.keys(y).length,0);
        // Hides the linked import-config sidecars (IMPORT_CONFIG_CATEGORY) from the visible File
        // Store list — they're a real record in the same table (see that constant's doc comment
        // for why), just not a "file" anyone should see, download, or delete by hand.
        const visibleFileStoreList=fileStoreList.filter(f=>f.category!==IMPORT_CONFIG_CATEGORY);
        const platformFreshness=computePlatformFreshness(visibleNormRows);
        // Deliberately does NOT run through groupGooglePlatform (2026-07-31) even though the Data
        // Sources sidebar's own "Spend by platform" widget now does — this table drives "Clear
        // Tagger data by channel" below, a real DELETE action against whichever underlying
        // sub-channel actually has the rows. Showing/deleting by the combined "Google" label would
        // make it impossible to isolate and undo just one bad Search import without also nuking
        // Display/Demand Gen data that was fine, so this one intentionally stays raw/granular
        // regardless of the workspace's combine setting.
        const platformBreakdown=(()=>{
          const map={};
          visibleNormRows.forEach(r=>{
            const p=derivePlatform(r.campaign_group_name,r.campaign_name,r.platform,r.campaign_type);
            if(!map[p])map[p]={platform:p,rows:0,spend:0,campaigns:new Set()};
            map[p].rows++;map[p].spend+=r.spend;map[p].campaigns.add(campaignKey(r.campaign_group_name,r.campaign_name));
          });
          return Object.values(map).map(m=>({platform:m.platform,rows:m.rows,spend:m.spend,campaigns:m.campaigns.size,lastDate:platformFreshness[m.platform]||null})).sort((a,b)=>b.spend-a.spend);
        })();
        const fmtLastImport=d=>{
          if(!d)return"—";
          const daysStale=Math.floor((new Date()-d)/86400000);
          const label=daysStale<=0?"Today":daysStale===1?"Yesterday":`${daysStale} days ago`;
          return`${label} (${d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})})`;
        };
        // disabled always also folds in !canEdit — every one of these is a destructive write
        // (clear data), so a view-only member sees the same disabled state a real 403 would force
        // anyway, rather than a button that looks clickable and then just fails.
        const SettingsRow=({title,desc,stat,action,label,disabled})=>(
          <Card>
            <CardContent className="flex items-center justify-between gap-5 p-5">
              <div>
                <div className="mb-1 text-sm font-semibold text-foreground">{title}</div>
                <div className="max-w-[480px] text-xs leading-relaxed text-muted-foreground">{desc}</div>
                <div className="mt-2 text-xs text-muted-foreground">{stat}</div>
              </div>
              <Button onClick={action} variant="destructive" size="sm" disabled={disabled||!canEdit} title={canEdit?undefined:"View-only access"} className="shrink-0">{label}</Button>
            </CardContent>
          </Card>
        );

        // Settings nav — jump-to-section links, matching Venture's General Settings two-group left
        // rail (Figma node 562:37686: GENERAL SETTINGS / WORKSPACE SETTINGS grouped nav + content
        // panels). BudgetHQ's settings are data-management-heavy rather than Venture's generic Apps/
        // Account/Notification categories, so the group/item labels here are BudgetHQ's own — but the
        // grouped-list-with-uppercase-header structure and two-column layout are a direct match.
        // Click-to-scroll rather than true scroll-spy (no active-section tracking as you scroll) —
        // a reasonable v1 scope cut for what's still a single long page, not real routed sub-pages.
        const NAV_GROUPS=[
          {label:"General",items:[
            {id:"settings-appearance",label:"Appearance & Formatting"},
            {id:"settings-metrics",label:"Custom Metrics"},
            {id:"settings-connections",label:"Connections"},
            {id:"settings-files",label:"File Store"},
          ]},
          {label:"Workspace",items:[
            {id:"settings-workspace",label:"Workspace & Team"},
            {id:"settings-data",label:"Data Management"},
            {id:"settings-account",label:"Account"},
          ]},
        ];
        const scrollToSection=id=>document.getElementById(id)?.scrollIntoView({behavior:"smooth",block:"start"});

        return(
          // 2026-08-07 layout fix — per Mo's direct comparison against the Venture reference: this
          // used to be a centered max-w-[1160px] container with a floating sticky nav (no border, no
          // background, no divider between groups) — nothing like Venture's actual anatomy, which is
          // a full-height, edge-to-edge two-column layout: a 248px bordered/backgrounded nav column
          // (matching the primary sidebar's own width) butted directly against the content column,
          // with a real divider line between the GENERAL/WORKSPACE groups, not just a gap.
          <div className="flex flex-1 overflow-hidden">
            <nav className="flex h-full w-[248px] shrink-0 flex-col overflow-y-auto border-r border-border bg-background py-4">
              {NAV_GROUPS.map((group,gi)=>(
                <div key={group.label}>
                  {gi>0&&<div className="mx-4 my-4 border-t border-border"/>}
                  <div className="flex flex-col gap-3 px-4">
                    <div className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</div>
                    <div className="flex flex-col gap-0.5">
                      {group.items.map(item=>(
                        <button key={item.id} type="button" onClick={()=>scrollToSection(item.id)}
                          className="rounded-sm px-2 py-1.5 text-left text-sm font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground">
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </nav>

            <div className="min-w-0 flex-1 overflow-auto bg-background">
              <div className="max-w-[880px] px-8 py-8">
                <div className="mb-6 border-b border-border pb-5">
                  <h1 className="text-h3 font-medium text-foreground">Settings</h1>
                  <p className="mt-1.5 max-w-[560px] text-sm text-muted-foreground">Manage the data stored in this PaidHQ instance. Reporting has no data of its own — it's computed live from Tagger and Budget data, so clearing either one updates Reporting automatically.</p>
                </div>

                <div className="flex flex-col gap-8">
                  {/* Appearance & Formatting */}
                  <section id="settings-appearance" className="flex flex-col gap-4">
                    <Card>
                      <CardContent className="p-5">
                        <div className="mb-1 text-sm font-semibold text-foreground">Appearance</div>
                        <div className="mb-3.5 max-w-[520px] text-xs leading-relaxed text-muted-foreground">Device-only preference — doesn't affect anyone else on this workspace, and switching back is instant.</div>
                        <div className="grid grid-cols-4 gap-2.5">
                          {[
                            {key:"classic",label:"Classic",desc:"Current look — DM Sans, compact corners",swatch:THEME_CLASSIC},
                            {key:"aida",label:"Aida",desc:"New theme — Poppins, rounder, soft mint accent",swatch:THEME_AIDA},
                            {key:"midnight",label:"Midnight",desc:"Dark mode — same shapes as Classic, inverted",swatch:THEME_MIDNIGHT},
                            {key:"notion",label:"Notion",desc:"Light, flat, borders not shadows — Inter, blue accent",swatch:THEME_NOTION},
                          ].map(opt=>{
                            const active=themeName===opt.key;
                            return(
                              <div key={opt.key} onClick={()=>setThemeName(opt.key)} role="button" tabIndex={0}
                                onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setThemeName(opt.key);}}}
                                className={cn("cursor-pointer rounded-sm border-2 p-3 transition-colors",active?"border-foreground":"border-border")}
                                style={{background:opt.swatch.surface}}>
                                <div className="mb-2.5 flex items-center justify-between">
                                  <div className="flex gap-1">
                                    <div className="h-4 w-4 rounded-full border" style={{background:opt.swatch.bg,borderColor:opt.swatch.border}}/>
                                    <div className="h-4 w-4 rounded-full" style={{background:opt.swatch.accent}}/>
                                    <div className="h-4 w-4 rounded-full" style={{background:opt.swatch.accentSoft}}/>
                                  </div>
                                  {active&&<Check weight="bold" className="h-3.5 w-3.5 text-foreground"/>}
                                </div>
                                <div className="mb-0.5 text-xs font-semibold" style={{color:opt.swatch.text,fontFamily:opt.swatch.font}}>{opt.label}</div>
                                <div className="text-[10px]" style={{color:opt.swatch.textMuted,fontFamily:opt.swatch.font}}>{opt.desc}</div>
                              </div>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardContent className="p-5">
                        <div className="mb-1 text-sm font-semibold text-foreground">Number formatting</div>
                        <div className="mb-3.5 max-w-[520px] text-xs leading-relaxed text-muted-foreground">Workspace-shared — everyone sees the same decimal precision on spend, budgets, pacing %, and other reported values. Works like Excel's increase/decrease decimal buttons: raises or lowers precision beyond each value type's normal default.</div>
                        <div className="mb-3.5 flex items-center gap-2.5">
                          <Button onClick={()=>setDecimalAdjust(d=>Math.max(0,d-1))} variant="ghost" size="sm" disabled={decimalAdjust<=0||!canEdit}>.0◂</Button>
                          <div className="min-w-[110px] text-center text-sm text-foreground">{decimalAdjust===0?"Default precision":`+${decimalAdjust} decimal${decimalAdjust===1?"":"s"}`}</div>
                          <Button onClick={()=>setDecimalAdjust(d=>Math.min(6,d+1))} variant="ghost" size="sm" disabled={decimalAdjust>=6||!canEdit}>▸.00</Button>
                        </div>
                        <div className="flex gap-5 rounded-sm bg-secondary px-3.5 py-3">
                          <div>
                            <div className="mb-0.5 text-[10px] text-muted-foreground">Dollar</div>
                            <div className="text-sm font-semibold text-foreground">{fmt$(48213.7)}</div>
                          </div>
                          <div>
                            <div className="mb-0.5 text-[10px] text-muted-foreground">Number</div>
                            <div className="text-sm font-semibold text-foreground">{(1284).toLocaleString(undefined,{minimumFractionDigits:decimalAdjust,maximumFractionDigits:decimalAdjust})}</div>
                          </div>
                          <div>
                            <div className="mb-0.5 text-[10px] text-muted-foreground">Percent</div>
                            <div className="text-sm font-semibold text-foreground">{(87.436).toLocaleString(undefined,{minimumFractionDigits:1+decimalAdjust,maximumFractionDigits:1+decimalAdjust})}%</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </section>

                  {/* Custom Metrics */}
                  <section id="settings-metrics">
                    <Card>
                      <CardContent className="p-5">
                        <div className="mb-1 flex items-center justify-between gap-3.5">
                          <div className="text-sm font-semibold text-foreground">Custom metrics</div>
                          <Button onClick={openAddCustomMetric} variant="ghost" size="sm" disabled={!canEdit}>
                            <Plus className="h-3.5 w-3.5"/> Add custom metric
                          </Button>
                        </div>
                        <div className={cn("max-w-[520px] text-xs leading-relaxed text-muted-foreground",customMetrics.length&&"mb-3.5")}>Workspace-shared formulas — e.g. cost/demo, pipeline $ generated/spend, MQL → SQL rate — built from Performance Intelligence's canonical funnel fields (Spend, Leads, Demos, MQLs, SQLs, Pipeline Value, ...). Show up as toggleable columns in Performance Intelligence's metric picker.</div>
                        {customMetrics.length>0&&(
                          <div className="flex flex-col gap-2">
                            {customMetrics.map(cm=>(
                              <div key={cm.key} className="flex items-center justify-between gap-3 rounded-sm border border-border bg-secondary/40 px-3 py-2.5">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-foreground">{cm.label}</div>
                                  <div className="mt-0.5 text-xs text-muted-foreground">{formulaPreview(cm)} · {cm.format==="money"?"$":cm.format==="pct"?"%":"number"}</div>
                                </div>
                                <div className="flex shrink-0 gap-1.5">
                                  <Button onClick={()=>openEditCustomMetric(cm)} variant="ghost" size="sm" disabled={!canEdit}>Edit</Button>
                                  <button onClick={()=>deleteCustomMetric(cm.key)} disabled={!canEdit} title="Delete this custom metric"
                                    className="flex h-7 w-7 items-center justify-center rounded-sm border border-border text-destructive disabled:opacity-50">
                                    <X className="h-3.5 w-3.5"/>
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </section>

                  {/* Connections */}
                  <section id="settings-connections">
                    <Card>
                      <CardContent className="p-5">
                        <div className="mb-1 text-sm font-semibold text-foreground">Connections</div>
                        <div className="mb-3.5 max-w-[560px] text-xs leading-relaxed text-muted-foreground">
                          Connecting and managing ad accounts (LinkedIn, Microsoft Advertising, Funnel.io, Supermetrics, Capterra) now lives in Data Sources — sync schedules, reconnects, and disconnects included.
                        </div>
                        <Button onClick={()=>{setStep("upload");setView("data");}} size="sm">Go to Data Sources →</Button>
                      </CardContent>
                    </Card>
                  </section>

                  {/* File Store */}
                  {canEdit&&(
                    <section id="settings-files">
                      <Card>
                        <CardContent className="p-5">
                          <div className="mb-1 flex items-center justify-between gap-3.5">
                            <div className="text-sm font-semibold text-foreground">File Store</div>
                            <Button onClick={()=>manualFileRef.current?.click()} variant="secondary" size="sm">
                              <Plus className="h-3.5 w-3.5"/> Add file
                            </Button>
                            <input ref={manualFileRef} type="file" className="hidden" onChange={e=>{addManualFile(e.target.files[0]);e.target.value="";}}/>
                          </div>
                          <div className="mb-3.5 max-w-[520px] text-xs leading-relaxed text-muted-foreground">Every spend, tag, budget, or pipeline file you import is automatically saved here — you're always asked to name it first, so it's easy to find again later. Click "Apply" on any of them to reload it and reopen its import screen, pre-filled with how it was mapped last time (handy after a "Clear"/"Delete" above, or just to redo an import). Add anything else you want to keep on hand — PDFs, insertion orders, whatever — with "Add file"; those are just stored for reference.</div>
                          {fileStoreLoading?(
                            <div className="py-3 text-xs text-muted-foreground">Loading…</div>
                          ):visibleFileStoreList.length===0?(
                            <div className="py-3 text-center text-xs text-muted-foreground">No files saved yet.</div>
                          ):(
                            <div className="max-h-[320px] overflow-auto">
                              {visibleFileStoreList.map((f,i)=>(
                                <div key={f.id} className={cn("flex items-center justify-between gap-3.5 py-2.5",i>0&&"border-t border-border")}>
                                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                                    <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                                    <div className="min-w-0 flex-1">
                                      {renamingFileId===f.id?(
                                        <input autoFocus value={renamingFileName} onChange={e=>setRenamingFileName(e.target.value)}
                                          onKeyDown={e=>{if(e.key==="Enter")commitFileRename(f.id,renamingFileName);if(e.key==="Escape")setRenamingFileId(null);}}
                                          onBlur={()=>commitFileRename(f.id,renamingFileName)}
                                          className="w-full max-w-[340px] rounded-sm border border-ring bg-background px-1.5 py-0.5 text-sm font-medium text-foreground outline-none"/>
                                      ):(
                                        <div className="flex items-center gap-1.5">
                                          <div className="max-w-[340px] truncate text-sm font-medium text-foreground">{f.name}</div>
                                          {canEdit&&(
                                            <button onClick={()=>{setRenamingFileId(f.id);setRenamingFileName(f.name);}} title="Rename"
                                              className="flex h-5 w-5 shrink-0 items-center justify-center opacity-50 hover:opacity-100">
                                              <PencilSimple className="h-3 w-3 text-muted-foreground"/>
                                            </button>
                                          )}
                                        </div>
                                      )}
                                      <div className="text-xs text-muted-foreground">
                                        <Badge variant="secondary" className="mr-1.5">{f.category}</Badge>
                                        {fmtFileSize(f.size)} · {new Date(f.createdAt).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    {canEdit&&APPLY_CATEGORIES.has(f.category)&&(
                                      <Button onClick={()=>applyStoredFile(f)} disabled={applyingFileId===f.id} variant="secondary" size="sm"
                                        title="Reload this file and reopen its import review screen, pre-filled with how it was mapped last time">
                                        {applyingFileId===f.id?"Applying…":"Apply"}
                                      </Button>
                                    )}
                                    <button onClick={()=>downloadFileFromStore(f)} title="Download" className="flex h-[26px] w-[26px] items-center justify-center rounded-sm border border-border">
                                      <DownloadSimple className="h-3.5 w-3.5 text-muted-foreground"/>
                                    </button>
                                    {copyTargetWorkspaces.length>0&&(
                                      <div className="relative">
                                        <button onClick={(e)=>{
                                            if(copyMenuOpenId===f.id){setCopyMenuOpenId(null);return;}
                                            setCopyMenuAnchorRect(e.currentTarget.getBoundingClientRect());
                                            setCopyMenuOpenId(f.id);
                                          }} title="Copy to another workspace" disabled={copyingFileId===f.id}
                                          className={cn("flex h-[26px] w-[26px] items-center justify-center rounded-sm border border-border",copyMenuOpenId===f.id&&"bg-secondary",copyingFileId===f.id&&"opacity-50")}>
                                          <PaperPlaneTilt className="h-3.5 w-3.5 text-muted-foreground"/>
                                        </button>
                                        {copyMenuOpenId===f.id&&copyMenuAnchorRect&&createPortal(
                                          <>
                                            <div onClick={()=>setCopyMenuOpenId(null)} className="fixed inset-0 z-[999]"/>
                                            <div className="fixed z-[1000] flex min-w-[200px] flex-col rounded-sm border border-border bg-background p-1.5 shadow-card"
                                              style={{top:copyMenuAnchorRect.bottom+6,left:Math.max(8,copyMenuAnchorRect.right-200)}}>
                                              <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Copy to workspace</div>
                                              {copyTargetWorkspaces.map(w=>(
                                                <button key={w.id} onClick={()=>copyFileToOtherWorkspace(f.id,w.id,w.name)}
                                                  className="truncate rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-secondary">
                                                  {w.name}
                                                </button>
                                              ))}
                                            </div>
                                          </>,
                                          document.body
                                        )}
                                      </div>
                                    )}
                                    <button onClick={()=>deleteFileFromStore(f.id,f.name)} title="Delete" disabled={deletingFileId===f.id}
                                      className={cn("flex h-[26px] w-[26px] items-center justify-center rounded-sm border border-border",deletingFileId===f.id&&"opacity-50")}>
                                      <Trash className="h-3.5 w-3.5 text-destructive"/>
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </section>
                  )}

                  {/* Workspace & Team */}
                  <section id="settings-workspace" className="flex flex-col gap-4">
                    {canManageTeam&&(
                      <Card>
                        <CardContent className="p-5">
                          <div className="mb-1 text-sm font-semibold text-foreground">Workspace</div>
                          <div className="mb-3.5 max-w-[520px] text-xs leading-relaxed text-muted-foreground">Rename this workspace, or permanently delete it below.</div>
                          <div className={cn("flex gap-1.5",workspaceNameError&&"mb-1.5")}>
                            <input value={workspaceNameInput} onChange={e=>{setWorkspaceNameInput(e.target.value);setWorkspaceNameError("");}}
                              onKeyDown={e=>e.key==="Enter"&&saveWorkspaceName()}
                              className="h-10 flex-1 rounded-sm border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"/>
                            <Button onClick={saveWorkspaceName} size="sm" disabled={workspaceNameSaving||!workspaceNameInput.trim()||workspaceNameInput.trim()===workspace?.name}>{workspaceNameSaving?"Saving…":"Save"}</Button>
                          </div>
                          {workspaceNameError&&<div className="text-xs text-destructive">{workspaceNameError}</div>}
                          {isOwner&&(
                            <div className="mt-4 flex items-center justify-between gap-5 border-t border-border pt-4">
                              <div>
                                <div className="text-sm font-medium text-foreground">Delete this workspace</div>
                                <div className="mt-0.5 text-xs text-muted-foreground">Permanently removes all spend data, tags, budgets, files, version history, and AI chats. There's no undo.</div>
                              </div>
                              <Button onClick={()=>{setDeleteWorkspaceOpen(true);setDeleteWorkspaceConfirmText("");setDeleteWorkspaceError("");}} variant="destructive" size="sm" className="shrink-0">Delete workspace</Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    <Card>
                      <CardContent className="p-5">
                        <div className="mb-1 flex items-center justify-between gap-3.5">
                          <div className="text-sm font-semibold text-foreground">Team</div>
                          <Badge variant="secondary">Your access: {myRole==="owner"?"Owner":myRole==="admin"?"Admin":"Member (view only)"}</Badge>
                        </div>
                        <div className="mb-3.5 max-w-[520px] text-xs leading-relaxed text-muted-foreground">
                          {canManageTeam?"Invite people to this workspace and control what they can do. Members can view every tab but can't edit tags, budgets, or spend data — Admins and Owners have full edit access.":"Owners and admins manage who has access here and what they can do."}
                        </div>
                        {canManageTeam&&(
                          <div className="mb-4">
                            <div className="flex gap-1.5">
                              <input value={inviteEmail} onChange={e=>{setInviteEmail(e.target.value);setInviteError("");}}
                                onKeyDown={e=>e.key==="Enter"&&!inviteSending&&inviteEmail.trim()&&sendInvite()}
                                placeholder="Email address" type="email"
                                className="h-10 flex-1 rounded-sm border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"/>
                              <Select value={inviteRole} onValueChange={setInviteRole}>
                                <SelectTrigger className="w-[130px]"><SelectValue/></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="member">Member</SelectItem>
                                  <SelectItem value="admin">Admin</SelectItem>
                                  <SelectItem value="owner">Owner</SelectItem>
                                </SelectContent>
                              </Select>
                              <Button onClick={sendInvite} size="sm" disabled={inviteSending||!inviteEmail.trim()}>{inviteSending?"Sending…":"Invite"}</Button>
                            </div>
                            {inviteError&&<div className="mt-1.5 text-xs text-destructive">{inviteError}</div>}
                          </div>
                        )}
                        {teamMembersLoading?(
                          <div className="py-2 text-xs text-muted-foreground">Loading…</div>
                        ):(
                          <div>
                            {teamMembers.map((m,i)=>{
                              const isMe=m.userId===sessionUserId;
                              return(
                                <div key={m.userId} className={cn("flex items-center justify-between gap-3.5 py-2",i>0&&"border-t border-border")}>
                                  <div className="flex min-w-0 items-center gap-2">
                                    <div className="max-w-[280px] truncate text-sm font-medium text-foreground">{m.email||m.userId}</div>
                                    {isMe&&<span className="text-xs text-muted-foreground">(you)</span>}
                                    {!m.acceptedAt&&<Badge variant="secondary">pending</Badge>}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    {canManageTeam&&!isMe?(
                                      <Select value={m.role} onValueChange={r=>changeTeamRole(m.userId,r)}>
                                        <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue/></SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="member">Member</SelectItem>
                                          <SelectItem value="admin">Admin</SelectItem>
                                          <SelectItem value="owner">Owner</SelectItem>
                                        </SelectContent>
                                      </Select>
                                    ):(
                                      <Badge variant="secondary">{m.role==="owner"?"Owner":m.role==="admin"?"Admin":"Member"}</Badge>
                                    )}
                                    {canManageTeam&&!isMe&&(
                                      <button onClick={()=>removeTeamMember(m.userId,m.email||"this person")} title="Remove"
                                        className="flex h-[22px] w-[22px] items-center justify-center rounded-sm text-muted-foreground hover:text-destructive">
                                        <X className="h-3 w-3"/>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {canManageTeam&&teamInvites.length>0&&(
                          <div className="mt-3.5 border-t border-border pt-3.5">
                            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pending invites</div>
                            {teamInvites.map((inv,i)=>(
                              <div key={inv.id} className={cn("flex items-center justify-between gap-3.5 py-1.5",i>0&&"border-t border-border")}>
                                <div className="text-xs text-muted-foreground">{inv.email} <span>· {inv.role==="owner"?"Owner":inv.role==="admin"?"Admin":"Member"}</span></div>
                                <button onClick={()=>revokeTeamInvite(inv.email)} className="text-xs text-muted-foreground hover:text-foreground">Revoke</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </section>

                  {/* Data Management */}
                  <section id="settings-data" className="flex flex-col gap-4">
                    {canEdit&&(
                      <SettingsRow title="Clear Tagger data"
                        desc="Removes every imported spend row, campaign tag, and custom tag dimension. Budget allocations are kept."
                        stat={`${mergedNormRows.length.toLocaleString()} spend rows · ${Object.keys(tags).length.toLocaleString()} tagged campaigns`}
                        action={clearTaggerData} label="Clear Tagger data" disabled={!mergedNormRows.length&&!Object.keys(tags).length}/>
                    )}

                    <Card>
                      <CardContent className="p-5">
                        <div className="mb-1 text-sm font-semibold text-foreground">Combine Google channels</div>
                        <div className="mb-3 max-w-[560px] text-xs leading-relaxed text-muted-foreground">
                          {/* 2026-07-31, per Mo: "they need to have the flexibility to combine or
                              separate whatever they want, not just a toggle on or off" — replaced the
                              old single Separate/Combined switch (all 3 sub-channels or none) with a
                              per-channel checkbox, so e.g. "combine everything except YouTube" or
                              "just keep Search separate" are both one click away instead of impossible. */}
                          Check any Google sub-channels that should report as a single "Google" line instead of their own separate line — any combination works, from all of them down to just one. Applies everywhere Platform is used for grouping or breakdowns: Campaign Tagger, Budget Panel, Reporting &amp; Pacing, and Ask AI. Forecasting stays accurate per sub-channel behind the scenes either way — only budgeting/reporting grouping is affected.
                        </div>
                        <div className="flex flex-col gap-0.5">
                          {GOOGLE_SUBCHANNELS.map(channel=>(
                            <label key={channel} title={canEdit?undefined:"View-only access"}
                              className={cn("flex items-center gap-2.5 py-1.5 text-sm text-foreground",canEdit?"cursor-pointer":"cursor-default opacity-50")}>
                              <Checkbox checked={!!combineGoogleChannels[channel]} disabled={!canEdit}
                                onCheckedChange={v=>handleToggleGoogleChannel(channel,!!v)}/>
                              {channel}
                            </label>
                          ))}
                        </div>
                        {GOOGLE_SUBCHANNELS.some(c=>combineGoogleChannels[c])&&budgetDims.includes("Platform")&&(
                          <div className="mt-2.5 text-xs text-muted-foreground">Existing budget rows for a checked channel are merged into "Google" the moment it's checked — unchecking it later doesn't split them back apart.</div>
                        )}
                      </CardContent>
                    </Card>

                    {canEdit&&platformBreakdown.length>0&&(
                      <Card>
                        <CardContent className="p-5">
                          <div className="mb-1 text-sm font-semibold text-foreground">Clear Tagger data by channel</div>
                          <div className="mb-3.5 max-w-[480px] text-xs leading-relaxed text-muted-foreground">Remove just one platform's spend rows — handy if you imported the wrong file and need to isolate and undo it. Tags are kept; a campaign only disappears once none of its rows are left.</div>
                          <div>
                            {platformBreakdown.map((p,i)=>(
                              <div key={p.platform} className={cn("flex items-center justify-between gap-3.5 py-2.5",i>0&&"border-t border-border")}>
                                <div className="flex min-w-0 items-center gap-2.5">
                                  <span className="h-2 w-2 shrink-0 rounded-full" style={{background:PLATFORM_COLORS[p.platform]||"hsl(var(--muted-foreground))"}}/>
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium text-foreground">{p.platform}</div>
                                    <div className="text-xs text-muted-foreground">{p.rows.toLocaleString()} row{p.rows===1?"":"s"} · {p.campaigns.toLocaleString()} campaign{p.campaigns===1?"":"s"} · {fmt$(p.spend)} · last import {fmtLastImport(p.lastDate)}</div>
                                  </div>
                                </div>
                                <Button onClick={()=>clearPlatformData(p.platform,p.rows)} variant="destructive" size="sm" className="shrink-0">Clear</Button>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {canEdit&&mergedNormRows.length>0&&(
                      <Card>
                        <CardContent className="p-5">
                          <div className="mb-1 text-sm font-semibold text-foreground">Clear Tagger data by date range</div>
                          <div className="mb-3.5 max-w-[520px] text-xs leading-relaxed text-muted-foreground">Remove spend rows within a specific date range, optionally scoped to one platform — e.g. redo or purge just one month without touching the rest. Tags are kept; a campaign only disappears once none of its rows are left.</div>
                          <div className="mb-3.5 flex flex-wrap items-end gap-2.5">
                            <div>
                              <div className="mb-1 text-xs font-medium text-muted-foreground">Platform</div>
                              <Select value={clearRangePlatform} onValueChange={setClearRangePlatform}>
                                <SelectTrigger className="w-[180px]"><SelectValue/></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="all">All platforms</SelectItem>
                                  {platformBreakdown.map(p=><SelectItem key={p.platform} value={p.platform}>{p.platform}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                            <div>
                              <div className="mb-1 text-xs font-medium text-muted-foreground">From</div>
                              <input type="date" value={clearRangeStart} onChange={e=>setClearRangeStart(e.target.value)}
                                className="h-10 rounded-sm border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"/>
                            </div>
                            <div>
                              <div className="mb-1 text-xs font-medium text-muted-foreground">Through</div>
                              <input type="date" value={clearRangeEnd} onChange={e=>setClearRangeEnd(e.target.value)}
                                className="h-10 rounded-sm border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"/>
                            </div>
                          </div>
                          {(()=>{
                            const matches=mergedNormRows.filter(clearRangeMatch);
                            const campaignCount=new Set(matches.map(r=>campaignKey(r.campaign_group_name,r.campaign_name))).size;
                            const spend=matches.reduce((s,r)=>s+r.spend,0);
                            const hasRange=clearRangeStart||clearRangeEnd;
                            return(
                              <div className="flex flex-wrap items-center justify-between gap-3.5">
                                <div className="text-xs text-muted-foreground">
                                  {hasRange?`${matches.length.toLocaleString()} row${matches.length===1?"":"s"} · ${campaignCount.toLocaleString()} campaign${campaignCount===1?"":"s"} · ${fmt$(spend)} match this range`:"Pick a start and/or end date to see what matches"}
                                </div>
                                <Button onClick={clearDateRangeData} variant="destructive" size="sm" disabled={!hasRange||!matches.length} className="shrink-0">Clear range</Button>
                              </div>
                            );
                          })()}
                        </CardContent>
                      </Card>
                    )}

                    {canEdit&&pipelineRowsLoading&&pipelineRows===null&&(
                      <Card><CardContent className="p-5 text-xs text-muted-foreground">Loading pipeline data…</CardContent></Card>
                    )}
                    {canEdit&&pipelineRows&&pipelineRows.length>0&&(
                      <Card>
                        <CardContent className="p-5">
                          <div className="mb-1 text-sm font-semibold text-foreground">Clear Pipeline data</div>
                          <div className="mb-3.5 max-w-[560px] text-xs leading-relaxed text-muted-foreground">
                            Permanently removes reporting/pipeline rows (MQLs, SQLs, Pipeline Value, and the rest of the funnel data behind Pipeline Tagger and Reporting Intelligence) from the database. Tagger spend data and Budget allocations are not affected.
                          </div>
                          <div className="mb-3.5 flex flex-col gap-1.5">
                            {[
                              {key:"date",label:"By date range"},
                              {key:"source",label:"By source"},
                              {key:"tag",label:"By tag dimension (Product, Module, Brand, etc.)"},
                              {key:"channel",label:"By channel/platform"},
                              {key:"all",label:"Everything"},
                            ].map(m=>(
                              <label key={m.key} className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                                <input type="radio" name="pdMode" checked={pdMode===m.key} onChange={()=>setPdMode(m.key)}
                                  className="cursor-pointer" style={{accentColor:"hsl(var(--primary))"}}/>
                                {m.label}
                              </label>
                            ))}
                          </div>
                          {pdMode==="date"&&(
                            <div className="mb-3.5 flex items-center gap-2">
                              <input type="month" value={pdStart} onChange={e=>setPdStart(e.target.value)} className="h-9 rounded-sm border border-input bg-background px-2.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"/>
                              <span className="text-muted-foreground">→</span>
                              <input type="month" value={pdEnd} onChange={e=>setPdEnd(e.target.value)} className="h-9 rounded-sm border border-input bg-background px-2.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"/>
                            </div>
                          )}
                          {pdMode==="source"&&(
                            <div className="mb-3.5 max-w-[260px]">
                              <Select value={pdSource} onValueChange={setPdSource}>
                                <SelectTrigger><SelectValue placeholder="Select a source…"/></SelectTrigger>
                                <SelectContent>
                                  {pipelineDistinctSources.map(s=><SelectItem key={s} value={s}>{s}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                          {pdMode==="tag"&&(
                            <div className="mb-3.5 flex max-w-[400px] gap-2">
                              <Select value={pdTagDim} onValueChange={v=>{setPdTagDim(v);setPdTagValue("");}}>
                                <SelectTrigger className="flex-1"><SelectValue placeholder="Dimension…"/></SelectTrigger>
                                <SelectContent>
                                  {(tagDims||[]).map(d=><SelectItem key={d} value={d}>{d}</SelectItem>)}
                                </SelectContent>
                              </Select>
                              <Select value={pdTagValue} onValueChange={setPdTagValue} disabled={!pdTagDim}>
                                <SelectTrigger className="flex-1"><SelectValue placeholder="Value…"/></SelectTrigger>
                                <SelectContent>
                                  {pipelineDistinctTagValues.map(v=><SelectItem key={v} value={v}>{v}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                          {pdMode==="channel"&&(
                            <div className="mb-3.5 max-w-[260px]">
                              <Select value={pdChannel} onValueChange={setPdChannel}>
                                <SelectTrigger><SelectValue placeholder="Select a channel…"/></SelectTrigger>
                                <SelectContent>
                                  {pipelineDistinctChannels.map(c=><SelectItem key={c} value={c}>{c}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                          {pdMode==="all"&&(
                            <div className="mb-3.5 max-w-[320px]">
                              <div className="mb-1.5 text-xs text-destructive">This deletes every pipeline row in this workspace. Type DELETE to confirm.</div>
                              <input value={pdConfirmText} onChange={e=>setPdConfirmText(e.target.value)} placeholder="DELETE"
                                className="w-full rounded-sm border border-input bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"/>
                            </div>
                          )}
                          <div className="flex flex-wrap items-center justify-between gap-3.5">
                            <div className="text-xs text-muted-foreground">
                              {pipelineDeletePreviewCount===null?"Select the criteria above.":`Matches ${pipelineDeletePreviewCount.toLocaleString()} row${pipelineDeletePreviewCount===1?"":"s"}.`}
                            </div>
                            <Button onClick={doPipelineDelete} disabled={!canDeletePipelineData||pdDeleting} variant="destructive" size="sm" className="shrink-0">{pdDeleting?"Deleting…":"Delete"}</Button>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    <SettingsRow title="Clear Budget data"
                      desc="Removes every budget allocation, segment, and annotation dimension across all years. Tagged campaign data is kept."
                      stat={`${budgetSegs.toLocaleString()} budget row${budgetSegs===1?"":"s"} across ${budgetYears} year${budgetYears===1?"":"s"}`}
                      action={clearBudgetData} label="Clear Budget data" disabled={!budgetSegs}/>

                    <div className="border-t border-border pt-4">
                      <SettingsRow title="Delete all data"
                        desc="Clears Tagger data AND Budget data at once — everything above, in one step. Theme and layout preferences are kept."
                        stat="This is the only irreversible action on this page — there's no undo."
                        action={clearAllData} label="Delete all data" disabled={!mergedNormRows.length&&!Object.keys(tags).length&&!budgetSegs}/>
                    </div>
                  </section>

                  {/* Account */}
                  <section id="settings-account" className="border-t border-border pt-4">
                    <Card>
                      <CardContent className="flex items-center justify-between gap-5 p-5">
                        <div>
                          <div className="mb-1 text-sm font-semibold text-foreground">Delete your PaidHQ account</div>
                          <div className="max-w-[480px] text-xs leading-relaxed text-muted-foreground">Permanently deletes the login itself ({session?.user?.email}) — not just this workspace, every workspace you're in across all of PaidHQ. This is different from "Sign out," which only forgets this account in this browser.</div>
                          <div className="mt-2 text-xs text-muted-foreground">Blocked if this account is the sole owner of any workspace — transfer ownership or delete those workspaces first.</div>
                        </div>
                        <Button onClick={()=>{setDeleteAccountOpen(true);setDeleteAccountConfirmText("");setDeleteAccountError("");}} variant="destructive" size="sm" className="shrink-0">Delete account</Button>
                      </CardContent>
                    </Card>
                  </section>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      </main>

      </div>

      <NameFileModal key={pendingNamedFile?"open":"closed"} T={T} open={!!pendingNamedFile} defaultName={pendingNamedFile?.defaultName}
        onConfirm={name=>pendingNamedFile?.onConfirm(name)} onCancel={()=>pendingNamedFile?.onCancel()}/>

      {/* ── IMPORT PRE-LOGIN LOCAL DATA ── */}
      {localImportPrompt&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{width:"100%",maxWidth:440,background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Import your existing data?</div>
            <div style={{padding:20,fontSize:13*(T.fsScale||1),color:T.textSub,lineHeight:1.6}}>
              This browser has PaidHQ data from before you signed in — {localImportPrompt.rows.length?`${localImportPrompt.rows.length.toLocaleString()} spend rows, `:""}{Object.keys(localImportPrompt.tags).length?`${Object.keys(localImportPrompt.tags).length.toLocaleString()} tagged campaigns, `:""}{Object.keys(localImportPrompt.budgets).length?"budget allocations":""}.
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
          <div style={{width:"100%",maxWidth:440,background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15*(T.fsScale||1),fontWeight:700,color:T.danger}}>Delete "{workspace?.name}"?</div>
            <div style={{padding:20}}>
              <div style={{fontSize:13*(T.fsScale||1),color:T.textSub,lineHeight:1.6,marginBottom:14}}>This permanently deletes every spend row, tag, budget, file, version, and AI chat in this workspace, for everyone on the team. There's no undo.</div>
              <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textMuted,marginBottom:6}}>Type <strong style={{color:T.text}}>{workspace?.name}</strong> to confirm</div>
              <input autoFocus value={deleteWorkspaceConfirmText} onChange={e=>{setDeleteWorkspaceConfirmText(e.target.value);setDeleteWorkspaceError("");}}
                onKeyDown={e=>{if(e.key==="Enter"&&deleteWorkspaceConfirmText.trim()===workspace?.name)confirmDeleteWorkspace();if(e.key==="Escape")setDeleteWorkspaceOpen(false);}}
                style={{width:"100%",boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r7,color:T.text,padding:"8px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
              {deleteWorkspaceError&&<div style={{marginTop:8,fontSize:12*(T.fsScale||1),color:T.danger}}>{deleteWorkspaceError}</div>}
            </div>
            <div style={{padding:"14px 20px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8}}>
              <Btn onClick={()=>setDeleteWorkspaceOpen(false)} variant="ghost" T={T}>Cancel</Btn>
              <Btn onClick={confirmDeleteWorkspace} variant="danger" T={T} disabled={deleteWorkspaceSaving||deleteWorkspaceConfirmText.trim()!==workspace?.name}>{deleteWorkspaceSaving?"Deleting…":"Delete workspace"}</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── GOOGLE SHEETS (ADS WORKAROUND) SETUP GUIDE ── */}
      {googleSheetsGuideOpen&&(
        <div onClick={()=>setGoogleSheetsGuideOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:640,maxHeight:"85vh",display:"flex",flexDirection:"column",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
              <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text,fontFamily:T.font}}>Getting Google Ads spend into a Sheet</div>
              <span onClick={()=>setGoogleSheetsGuideOpen(false)} style={{fontSize:14*(T.fsScale||1),color:T.textMuted,cursor:"pointer"}}>✕</span>
            </div>
            <div style={{padding:20,overflow:"auto",fontSize:13*(T.fsScale||1),color:T.textSub,lineHeight:1.65,fontFamily:T.font}}>
              <p style={{margin:"0 0 16px"}}>
                PaidHQ only <em>reads</em> the sheet — something else has to keep it filled with fresh Google Ads spend. Below are the two realistic ways to do that. Either one works; pick based on how much control you want over what gets exported.
              </p>

              <div style={{fontSize:13*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:4}}>Option 1 — Sheets' built-in Google Ads connector</div>
              <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,marginBottom:8}}>Fastest to set up. Less control over exactly what's in the export.</div>
              <ol style={{margin:"0 0 16px",paddingLeft:20}}>
                <li style={{marginBottom:6}}>Open a blank Google Sheet (start fresh rather than reusing an old one — a sheet can only ever be linked to one Google Ads account at a time).</li>
                <li style={{marginBottom:6}}>Insert menu → Data connector → Google Ads.</li>
                <li style={{marginBottom:6}}>Sign in with the Google account that has <strong>direct user access on the Ads account itself</strong> — not just access through a Manager (MCC) account. Check this in Google Ads → Admin (gear icon) → Access and security → Users before you start; that's the exact list "isn't associated with a Google Ads account" errors are complaining about.</li>
                <li style={{marginBottom:6}}>Pick the ad account, choose your columns/date range, and insert the report.</li>
                <li>Sheets can refresh this on its own schedule — check the connector's own refresh settings so it stays current daily.</li>
              </ol>

              <div style={{fontSize:13*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:4}}>Option 2 — Scheduled report from Google Ads, segmented by ad group (recommended)</div>
              <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,marginBottom:8}}>More setup, but you control exactly what's exported and it avoids the account-association error entirely since the sheet is created fresh from inside the correct Ads account.</div>
              <ol style={{margin:"0 0 16px",paddingLeft:20}}>
                <li style={{marginBottom:6}}>In Google Ads (ads.google.com), signed in as the account with access, go to Reports → Report editor.</li>
                <li style={{marginBottom:6}}>Build a report with <strong>Ad group</strong> as a dimension/segment alongside Campaign, Date, and Cost — this gives PaidHQ real ad-group-level granularity instead of one lump sum per campaign. Add Campaign type too if you want Search/Display/Demand Gen/Performance Max broken out accurately (see the column note below).</li>
                <li style={{marginBottom:6}}>Save the report, then use the download/export icon and choose Google Sheets as the destination — this creates a new linked sheet.</li>
                <li>Click Schedule on that export and set it to run daily, so the sheet stays current without anyone touching it.</li>
              </ol>

              <div style={{fontSize:13*(T.fsScale||1),fontWeight:700,color:T.text,marginBottom:4}}>Column names</div>
              <p style={{margin:"0 0 8px"}}>
                Whatever Google Ads calls its columns is fine — PaidHQ auto-detects common variants the same way CSV uploads do. As a target, aim for something close to:
              </p>
              <div style={{background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r6,padding:"8px 12px",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",fontSize:11.5*(T.fsScale||1),marginBottom:8}}>
                Campaign → <strong>Campaign Group Name</strong> (required)<br/>
                Ad group → <strong>Campaign Name</strong> (recommended)<br/>
                Cost → <strong>Spend</strong> (required)<br/>
                Day → <strong>Date</strong> (required)<br/>
                Campaign type → <strong>Campaign Type</strong> (recommended — Search/Display/Demand Gen/Performance Max)<br/>
                Impr. / Clicks → <strong>Impressions</strong> / <strong>Clicks</strong> (optional)
              </div>
              <p style={{margin:0}}>
                Without a Campaign Type column, every row reports as generic Google Search rather than split by sub-channel.
              </p>

              <div style={{marginTop:16,paddingTop:16,borderTop:`1px solid ${T.border}`,fontSize:12*(T.fsScale||1),color:T.textMuted}}>
                Once the sheet is set up and refreshing on its own: File → Share → change to "Anyone with the link" → Viewer, then paste that link into the connect form. PaidHQ pulls from it once a day.
              </div>
            </div>
            <div style={{padding:"14px 20px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",flexShrink:0}}>
              <Btn onClick={()=>setGoogleSheetsGuideOpen(false)} variant="primary" T={T}>Got it</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE ACCOUNT (type-to-confirm) ── */}
      {deleteAccountOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{width:"100%",maxWidth:440,background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15*(T.fsScale||1),fontWeight:700,color:T.danger}}>Delete this account?</div>
            <div style={{padding:20}}>
              <div style={{fontSize:13*(T.fsScale||1),color:T.textSub,lineHeight:1.6,marginBottom:14}}>This permanently deletes the <strong style={{color:T.text}}>{session?.user?.email}</strong> login — you'll lose access to every workspace it belongs to, everywhere in PaidHQ. There's no undo.</div>
              <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textMuted,marginBottom:6}}>Type <strong style={{color:T.text}}>{session?.user?.email}</strong> to confirm</div>
              <input autoFocus value={deleteAccountConfirmText} onChange={e=>{setDeleteAccountConfirmText(e.target.value);setDeleteAccountError("");}}
                onKeyDown={e=>{if(e.key==="Enter"&&deleteAccountConfirmText.trim().toLowerCase()===(session?.user?.email||"").toLowerCase())confirmDeleteAccount();if(e.key==="Escape")setDeleteAccountOpen(false);}}
                style={{width:"100%",boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r7,color:T.text,padding:"8px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
              {deleteAccountError&&<div style={{marginTop:8,fontSize:12*(T.fsScale||1),color:T.danger}}>{deleteAccountError}</div>}
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
          <div style={{width:"100%",maxWidth:400,background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Name current version</div>
            <div style={{padding:20}}>
              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:10}}>Saves a snapshot of everything — Tagger and Budget data — as it is right now, so you can come back to this exact point later.</div>
              <input autoFocus value={nameVersionInput} onChange={e=>setNameVersionInput(e.target.value)} placeholder="e.g. Before Q3 revision" onKeyDown={e=>{if(e.key==="Enter")saveNamedVersion();if(e.key==="Escape")setNameVersionOpen(false);}}
                style={{width:"100%",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r7,color:T.text,padding:"8px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
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
          <div style={{width:"100%",maxWidth:420,background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Email {exportableView.label}</div>
            <div style={{padding:20,display:"flex",flexDirection:"column",gap:14}}>
              <div>
                <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textSub,marginBottom:5}}>To</div>
                <input autoFocus type="email" value={emailExportTo} onChange={e=>setEmailExportTo(e.target.value)} placeholder="name@company.com"
                  style={{width:"100%",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r7,color:T.text,padding:"8px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font,boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textSub,marginBottom:5}}>Format</div>
                <div style={{display:"flex",gap:6}}>
                  {EXPORT_FORMATS.map(f=>(
                    <button key={f.key} onClick={()=>setEmailExportFormat(f.key)}
                      style={{flex:1,padding:"7px 0",borderRadius:T.r6,border:`1.5px solid ${emailExportFormat===f.key?T.accentHover:T.border}`,background:emailExportFormat===f.key?T.accent:"transparent",color:emailExportFormat===f.key?T.text:T.textMuted,fontSize:12*(T.fsScale||1),fontWeight:emailExportFormat===f.key?700:500,cursor:"pointer",fontFamily:T.font}}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textSub,marginBottom:5}}>Note <span style={{fontWeight:400,color:T.textMuted}}>(optional)</span></div>
                <textarea value={emailExportNote} onChange={e=>setEmailExportNote(e.target.value)} placeholder="Add a message for the recipient…" rows={3}
                  style={{width:"100%",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"8px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font,resize:"vertical",boxSizing:"border-box"}}/>
              </div>
              {emailError&&<div style={{fontSize:12*(T.fsScale||1),color:T.danger,background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,borderRadius:T.r7,padding:"8px 10px"}}>{emailError}</div>}
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
          <div style={{width:"100%",maxWidth:520,maxHeight:"85vh",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd,display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Version history</div>
                <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginTop:2}}>Saved automatically after imports and data clears, or manually via ⋯ → Name current version.</div>
              </div>
              <button onClick={()=>setVersionHistoryOpen(false)} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22*(T.fsScale||1),lineHeight:1,fontFamily:T.font}}>×</button>
            </div>
            <div style={{flex:1,overflow:"auto",padding:"8px 12px"}}>
              {versionsLoading?(
                <div style={{display:"flex",alignItems:"center",gap:8,color:T.textSub,fontSize:13*(T.fsScale||1),padding:"20px 8px"}}>
                  <span style={{width:14,height:14,border:`2px solid ${T.border}`,borderTopColor:T.accent,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/> Loading versions…
                </div>
              ):versions.length===0?(
                <div style={{padding:"32px 20px",textAlign:"center",color:T.textMuted,fontSize:13*(T.fsScale||1)}}>No saved versions yet. They're created automatically after imports and data clears — or save one now from ⋯ → Name current version.</div>
              ):(
                groupVersionsByDay(versions).map(g=>(
                  <div key={g.label} style={{marginBottom:14}}>
                    <div style={{fontSize:10*(T.fsScale||1),fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.textMuted,padding:"8px 8px 4px"}}>{g.label}</div>
                    {g.items.map(v=>(
                      <div key={v.id} onClick={()=>restoreVersion(v)}
                        style={{display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:T.r8,cursor:"pointer"}}
                        className="bhq-row">
                        <Icon name={v.trigger==="manual"?"save":v.trigger?.startsWith("pre_")?"alert":"clock"} size={14} color={T.textMuted}/>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13*(T.fsScale||1),color:T.text,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{v.label}</div>
                          <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted}}>{new Date(v.timestamp).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})}</div>
                        </div>
                        <button onClick={e=>{e.stopPropagation();restoreVersion(v);}} style={{fontSize:11*(T.fsScale||1),fontWeight:600,color:T.accent,background:"transparent",border:`1px solid ${T.accentBorder}`,borderRadius:T.r6,padding:"4px 9px",cursor:"pointer",fontFamily:T.font,flexShrink:0}}>Restore</button>
                        <button onClick={e=>deleteVersion(v.id,e)} title="Delete this version"
                          style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:T.r5,color:T.textMuted,cursor:"pointer",fontSize:12*(T.fsScale||1),lineHeight:1,padding:0,flexShrink:0}}>✕</button>
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
              <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text,display:"flex",alignItems:"center",gap:8}}><Icon name="alert" size={16} color={T.warning}/> This import disagrees with synced data</div>
              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginTop:4,lineHeight:1.6}}><strong style={{color:T.text}}>{spendConflictReview.conflicts.length}</strong> row{spendConflictReview.conflicts.length===1?"":"s"} in this import have a spend that doesn't match what's already synced from a live platform connection for the same campaign and date. By default the synced value is kept — check a row below to overwrite it with the imported value instead.</div>
            </div>
            <div style={{flex:1,overflow:"auto",padding:22}}>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {spendConflictReview.conflicts.map((c,i)=>{
                  const useImported=spendConflictReview.useImportedSet.has(c.key);
                  return(
                    <label key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",borderRadius:T.r8,border:`1px solid ${T.border}`,cursor:"pointer",background:useImported?T.warningBg:"transparent"}}>
                      <input type="checkbox" checked={useImported} onChange={()=>toggleUseImported(c.key)} style={{marginTop:3,cursor:"pointer",accentColor:T.accent,width:14,height:14,flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13*(T.fsScale||1),color:T.text,fontWeight:600,marginBottom:4}}>{c.campaignGroupName&&c.campaignGroupName!==c.campaignName?`${c.campaignGroupName} · `:""}{c.campaignName} — {c.date}</div>
                        <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,lineHeight:1.6}}>Synced from <strong style={{color:T.textSub}}>{c.syncedPlatform}</strong>: <strong style={{color:T.text}}>{fmt$(c.syncedSpend)}</strong> · This import says: <strong style={{color:useImported?T.warning:T.text}}>{fmt$(c.importedSpend)}</strong></div>
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
              <div style={{fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Review tag import</div>
              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginTop:2}}>Matched <strong style={{color:T.text}}>{tagImportPreview.matchedCount}</strong> campaign{tagImportPreview.matchedCount===1?"":"s"}{tagImportPreview.skippedCount>0?` · skipped ${tagImportPreview.skippedCount} row${tagImportPreview.skippedCount===1?"":"s"} with no campaign name`:""}.</div>
            </div>
            <div style={{flex:1,overflow:"auto",padding:22}}>
              {tagImportPreview.sample.length>0&&(
                <div style={{marginBottom:tagImportPreview.newDims.length?18:0}}>
                  <div style={{fontSize:11*(T.fsScale||1),fontWeight:700,color:T.textMuted,textTransform:"uppercase",letterSpacing:0.4,marginBottom:8}}>Campaigns being tagged</div>
                  <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,lineHeight:1.8}}>
                    {tagImportPreview.sample.map((s,i)=><div key={i}>{s}</div>)}
                    {tagImportPreview.matchedCount>tagImportPreview.sample.length&&<div style={{color:T.textMuted}}>+{tagImportPreview.matchedCount-tagImportPreview.sample.length} more</div>}
                  </div>
                </div>
              )}
              {tagImportPreview.newDims.length>0&&(
                <div>
                  <div style={{fontSize:11*(T.fsScale||1),fontWeight:700,color:T.textMuted,textTransform:"uppercase",letterSpacing:0.4,marginBottom:8}}>New tag dimensions detected</div>
                  <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:10,lineHeight:1.6}}>These columns don't match any dimension you're already tracking. Uncheck any that shouldn't be added.</div>
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {tagImportPreview.newDims.map(d=>(
                      <label key={d} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:T.r8,border:`1px solid ${T.border}`,cursor:"pointer",background:tagImportPreview.includedNewDims.has(d)?T.accentBg:"transparent"}}>
                        <input type="checkbox" checked={tagImportPreview.includedNewDims.has(d)} onChange={()=>toggleNewTagDim(d)} style={{cursor:"pointer",accentColor:T.accent,width:14,height:14,flexShrink:0}}/>
                        <span style={{fontSize:13*(T.fsScale||1),color:T.text,fontWeight:600}}>{d}</span>
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

      {/* ── CUSTOM METRIC BUILDER (2026-08-08, per Mo — "allow users to create custom fields for
          cost/lead, cost/demo, ... etc.") — see the customMetrics state block above for the full
          "why" on the data shape. Flexible left-to-right term chain (no operator precedence), user
          picks the display format explicitly rather than it being inferred. ── */}
      {customMetricModalOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <PixelPanel T={T} style={{width:"100%",maxWidth:520,maxHeight:"85vh"}} contentStyle={{background:T.surface,padding:0,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${T.border}`,fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>{customMetricEditKey?"Edit custom metric":"Add custom metric"}</div>
            <div style={{flex:1,overflow:"auto",padding:22,display:"flex",flexDirection:"column",gap:16}}>
              <div>
                <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textMuted,marginBottom:6,fontFamily:T.font}}>Name</div>
                <input autoFocus value={customMetricName} onChange={e=>{setCustomMetricName(e.target.value);setCustomMetricError("");}}
                  placeholder="e.g. Cost per Demo" style={{width:"100%",boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r7,color:T.text,padding:"8px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
              </div>
              <div>
                <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textMuted,marginBottom:6,fontFamily:T.font}}>Display as</div>
                <div style={{display:"flex",gap:6}}>
                  {[["money","$ Cost"],["pct","% Rate"],["number","Number"]].map(([k,l])=>(
                    <button key={k} onClick={()=>setCustomMetricFormat(k)}
                      style={{flex:1,fontSize:12*(T.fsScale||1),fontWeight:600,padding:"7px 0",borderRadius:T.r7,border:`1.5px solid ${customMetricFormat===k?T.accentHover:T.border}`,background:customMetricFormat===k?T.accentBg:"transparent",color:customMetricFormat===k?T.text:T.textMuted,cursor:"pointer",fontFamily:T.font}}>{l}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textMuted,marginBottom:6,fontFamily:T.font}}>Formula</div>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {customMetricTerms.map((t,i)=>(
                    <div key={i} style={{display:"flex",gap:6,alignItems:"center"}}>
                      {i===0?(
                        <div style={{width:100,flexShrink:0,fontSize:12*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>—</div>
                      ):(
                        <div style={{width:100,flexShrink:0}}>
                          <Sel value={t.op||"/"} onChange={v=>updateCustomMetricTerm(i,{op:v})} T={T}>
                            {CUSTOM_METRIC_OPERATORS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
                          </Sel>
                        </div>
                      )}
                      <div style={{flex:1}}>
                        <Sel value={t.field} onChange={v=>updateCustomMetricTerm(i,{field:v})} T={T}>
                          {PIPELINE_METRIC_MAP_OPTIONS.map(m=><option key={m.key} value={m.key}>{m.label}</option>)}
                        </Sel>
                      </div>
                      <button onClick={()=>removeCustomMetricTerm(i)} disabled={customMetricTerms.length<=2} title="Remove term"
                        style={{width:26,height:26,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:`1px solid ${T.border}`,borderRadius:T.r6,color:customMetricTerms.length<=2?T.textMuted:T.danger,cursor:customMetricTerms.length<=2?"not-allowed":"pointer",fontSize:12*(T.fsScale||1),padding:0,opacity:customMetricTerms.length<=2?0.5:1}}>✕</button>
                    </div>
                  ))}
                </div>
                <Btn onClick={addCustomMetricTerm} variant="ghost" size="sm" T={T} style={{marginTop:8}}>+ Add term</Btn>
              </div>
              <div>
                <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textMuted,marginBottom:6,fontFamily:T.font}}>Preview (sample numbers)</div>
                <div style={{padding:"12px 14px",background:T.surfaceEl,borderRadius:T.r6,fontFamily:T.font}}>
                  <div style={{fontSize:11*(T.fsScale||1),color:T.textMuted,marginBottom:4}}>{formulaPreview({terms:customMetricTerms})}</div>
                  <div style={{fontSize:17*(T.fsScale||1),fontWeight:700,color:T.text}}>
                    {(()=>{const v=computeCustomMetric(CUSTOM_METRIC_PREVIEW_SUMS,{terms:customMetricTerms});return v===undefined?"—":fmtMetric(v,customMetricFormat==="money",customMetricFormat==="pct");})()}
                  </div>
                </div>
              </div>
              {customMetricError&&<div style={{fontSize:12*(T.fsScale||1),color:T.danger}}>{customMetricError}</div>}
            </div>
            <div style={{padding:"14px 22px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8}}>
              <Btn onClick={()=>setCustomMetricModalOpen(false)} variant="ghost" T={T}>Cancel</Btn>
              <Btn onClick={saveCustomMetric} variant="primary" T={T}>{customMetricEditKey?"Save changes":"Add metric"}</Btn>
            </div>
          </PixelPanel>
        </div>
      )}

      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        html,body{height:100%;width:100%;overflow:hidden;}
        #root{height:100%;width:100%;display:flex;flex-direction:column;}
        /* Was hardcoded to 'DM Sans' regardless of theme (2026-08-01 fix, per Mo — "are you sure
           we're using Poppins in Aida? It looks like DM Sans still"). Elements that set their own
           fontFamily:T.font inline already overrode this, but any bare <input>/<select>/<button>/
           <textarea> or text node without its own inline font-family fell back to this rule no
           matter what theme was active. Now uses T.font, which is 'DM Sans',sans-serif for
           Classic/Midnight anyway (this template literal already closes over T two lines below) —
           so this is a no-op for those two and Aida-only in effect, per Mo's "Aida only" instruction. */
        body{font-family:${T.font};-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;}
        input,select,button,textarea{font-family:${T.font};}
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
        /* Hover feedback — the app is styled almost entirely with inline styles (each element's
           own background is set inline per its state), so a plain CSS class can't win the
           cascade against that without !important. These are intentionally scoped to elements
           that opt in via className, so they never fight the "active/selected" inline states. */
        .bhq-btn:not(:disabled):hover{filter:brightness(0.96);}
        .bhq-tab:hover{background:${T.surfaceHover} !important;color:${T.text} !important;}
        .bhq-iconbtn:hover{background:${T.surfaceHover} !important;}
        .bhq-row:hover{background:${T.surfaceHover} !important;}
        .bhq-tr:hover td{background:${T.rowHover} !important;}
        /* Card-style budget rows (2026-08-07, per Mo — Venture Transaction Details reference).
           The Budget table opts in with .bhq-cardrows (border-collapse:separate + row gaps set
           inline); this adds the top/bottom borders on every data cell and rounds + side-borders
           the first/last cell so each data row reads as a bordered card. Scoped to .bhq-datarow so
           the Totals row and empty-state row stay flat. Only data cells here — the existing inline
           borderBottom on each td matches this color, so nothing fights. */
        .bhq-cardrows tbody tr.bhq-datarow td{border-top:1px solid ${T.border};border-bottom:1px solid ${T.border};}
        .bhq-cardrows tbody tr.bhq-datarow td:first-child{border-left:1px solid ${T.border};border-top-left-radius:8px;border-bottom-left-radius:8px;}
        .bhq-cardrows tbody tr.bhq-datarow td:last-child{border-right:1px solid ${T.border};border-top-right-radius:8px;border-bottom-right-radius:8px;}
        .bhq-cardrows tbody tr.bhq-datarow:hover td{background:${T.rowHover} !important;}
        /* Header row + Totals row as their own bordered bars in card-rows mode (2026-08-07, per Mo
           — "grey header with borders, and the totals row is missing borders"). Same side-border +
           rounded-ends treatment as the data-row cards so all three read consistently. */
        .bhq-cardrows thead th{border-left:0;border-right:0;border-top:1px solid ${T.border};}
        .bhq-cardrows thead th:first-child{border-left:1px solid ${T.border};border-top-left-radius:8px;border-bottom-left-radius:8px;}
        .bhq-cardrows thead th:last-child{border-right:1px solid ${T.border};border-top-right-radius:8px;border-bottom-right-radius:8px;}
        .bhq-cardrows tbody tr.bhq-totalrow td{border-top:1px solid ${T.border};border-bottom:1px solid ${T.border};background:${T.surfaceHover};}
        .bhq-cardrows tbody tr.bhq-totalrow td:first-child{border-left:1px solid ${T.border};border-top-left-radius:8px;border-bottom-left-radius:8px;}
        .bhq-cardrows tbody tr.bhq-totalrow td:last-child{border-right:1px solid ${T.border};border-top-right-radius:8px;border-bottom-right-radius:8px;}
        /* Drill-down breakdown rows (2026-08-07, per Mo — "a white sheet that comes down like a roll
           of paper"): white and borderless so they read as one continuous sheet extending from the
           parent row (fully connected in grid mode; white borderless rows in card mode). */
        tr.bhq-drilldown td{border:0 !important;}
        .bhq-cardrows tbody tr.bhq-drilldown td{border:0 !important;border-radius:0 !important;}
        /* Slim rounded horizontal scrollbar for the wide budget table (2026-08-07, per Mo's
           reference) — a thin track with a rounded grey thumb, appearing on hover like the sidebar. */
        .bhq-hscroll{scrollbar-width:thin;scrollbar-color:${T.border} transparent;}
        .bhq-hscroll::-webkit-scrollbar{height:10px;}
        .bhq-hscroll::-webkit-scrollbar-track{background:transparent;}
        .bhq-hscroll::-webkit-scrollbar-thumb{background:${T.border};border-radius:9999px;border:3px solid transparent;background-clip:padding-box;}
        .bhq-hscroll:hover::-webkit-scrollbar-thumb{background:${T.borderStrong};background-clip:padding-box;}
        /* Budget Panel chart color override (2026-08-08, per Mo) — Tremor's AreaChart only accepts
           named palette colors, so to honor an arbitrary user-picked hex we override recharts' area
           fill + top line via a CSS var (--bchart) set on the .bhq-budgetchart wrapper. CSS wins over
           recharts' presentation attrs / gradient. Falls back to neutral when the var is unset. */
        .bhq-budgetchart .recharts-area-area{fill:var(--bchart,${T.textSub})!important;fill-opacity:0.16!important;}
        .bhq-budgetchart .recharts-area-curve{stroke:var(--bchart,${T.textSub})!important;}
        .bhq-budgetchart .recharts-area-dots circle,.bhq-budgetchart .recharts-active-dot circle{fill:var(--bchart,${T.textSub})!important;stroke:var(--bchart,${T.textSub})!important;}
      `}</style>
      </div>
    </div>
  );
}
