import Papa from "papaparse";
import * as XLSX from "xlsx";

// src/lib/core.js — pure data/pacing logic extracted from the monolithic BudgetHQ.jsx
// (2026-07-25 split, per Mo). No React, no JSX — every export here is a plain function or
// constant, safe to import from lib code, tab components, or the root app equally. Combines
// what were three conceptual layers in the original file (CSV/column-detection constants +
// general data utilities, spend-row merge/dedupe + budget-segment helpers, and the pacing/
// forecasting engine) into one module rather than three, since splitting them further would
// have meant several small cross-file imports for no real isolation benefit — nothing here
// depends on anything outside this file.

// Vercel-matched palette (redesign, July 2026) — monochrome black/white/gray surfaces like the
// Vercel dashboard, with a black primary accent instead of a colored one. Lives here (not
// components/shared.jsx) so lib/reports.js can use it directly too — report builders run outside
// the React render tree and need a fixed T to pass into pacingStatusMeta, not a live prop.
export const THEME = {
  bg:"#FAFAFA",surface:"#FFFFFF",surfaceEl:"#FAFAFA",surfaceHover:"#F2F2F2",
  border:"#EAEAEA",borderStrong:"#D4D4D4",
  text:"#171717",textSub:"#666666",textMuted:"#8F8F8F",textDim:"#E5E5E5",
  accent:"#36565F",accentHover:"#141414",onAccent:"#FFFFFF",
  accentBg:"#E2F0F0",accentBorder:"rgba(54,86,95,0.3)",accentText:"#141414",
  accentSoft:"#5F8190",
  success:"#0C7A43",successBg:"rgba(12,122,67,0.08)",successBorder:"rgba(12,122,67,0.24)",
  warning:"#B25E09",warningBg:"rgba(178,94,9,0.08)",warningBorder:"rgba(178,94,9,0.24)",
  danger:"#E5484D",dangerBg:"rgba(229,72,77,0.08)",dangerBorder:"rgba(229,72,77,0.24)",
  rowHover:"#FAFAFA",rowSelected:"rgba(54,86,95,0.08)",
  inputBg:"#FFFFFF",headerBg:"#FFFFFF",sidebarBg:"#FAFAFA",topbarBg:"#FFFFFF",
  pill:"#F2F2F2",pillBorder:"#EAEAEA",
  badgeColors:["#36565F","#5F8190","#141414","#4A7080","#23414A","#7A9CAA","#0A2226"],
  shadow:"none",
  shadowMd:"0 8px 24px rgba(0,0,0,0.08),0 2px 6px rgba(0,0,0,0.04)",
  shadowLg:"0 20px 48px rgba(0,0,0,0.12),0 6px 16px rgba(0,0,0,0.06)",
};

export const MONTHS=[{key:"01",label:"Jan"},{key:"02",label:"Feb"},{key:"03",label:"Mar"},{key:"04",label:"Apr"},{key:"05",label:"May"},{key:"06",label:"Jun"},{key:"07",label:"Jul"},{key:"08",label:"Aug"},{key:"09",label:"Sep"},{key:"10",label:"Oct"},{key:"11",label:"Nov"},{key:"12",label:"Dec"}];
export const QUARTERS=[{key:"Q1",months:["01","02","03"],label:"Q1 Cap"},{key:"Q2",months:["04","05","06"],label:"Q2 Cap"},{key:"Q3",months:["07","08","09"],label:"Q3 Cap"},{key:"Q4",months:["10","11","12"],label:"Q4 Cap"}];
// Forecast-model options for a budget segment (see budgetRowMeta[segKey]._forecastModel and
// computePacing/projectPlatformSegment for the math each one drives).
//
// Redesigned 2026-07-25 per Mo, replacing the original 7-option list (full-period/committed/
// trailing1/3/7/14/30) — that list required understanding what a "trailing window" even was and
// picking a number with no real guidance, for a payoff (more reactive pacing) most people didn't
// actually need most of the time. Down to three real choices now:
//   "auto"      — the new default (see computePacing's fallback chain below). Adaptive: blends
//                 the full-period rate with a short recent one, see computeAutoBlendWeight/
//                 projectPlatformSegment. Right for almost every segment, no tuning required.
//   "committed" — unchanged: a known lump sum, skips run-rate projection entirely.
//   "manual"    — replaces the old fixed trailing1/3/7/14/30 presets with one free-form
//                 "trailing N days" number the user picks themselves. Stored the same way the
//                 presets always were internally (the literal string "trailingN", parsed by
//                 projectPlatformSegment's trailingMatch regex) — "manual" only exists as a UI-
//                 level grouping label; there is no separate stored "manual" value.
// The legacy literal "full-period" string is still recognized by projectPlatformSegment (for
// configs saved before this redesign) but is no longer offered as a choice anywhere in the UI —
// it behaves as a distinct always-cumulative mode, deliberately not folded into "auto", so existing
// saved data doesn't silently change behavior underneath anyone.
export const FORECAST_MODELS=[
  {value:"auto",label:"Auto",hint:"Adaptive — blends the full-period rate with the last 7 days, leaning on whichever is more trustworthy as they diverge. The right choice for almost every segment."},
  {value:"committed",label:"Committed spend",hint:"A known lump sum/prepaid amount — skips run-rate projection entirely."},
];
// Default trailing window (in days) prefilled for a segment/workspace switching into Manual mode
// for the first time — matches the old "trailing7" preset, the most commonly used one.
export const DEFAULT_MANUAL_TRAILING_DAYS=7;
// Human label for ANY forecastModel value actually seen in the wild — "auto"/"committed" (current),
// "trailingN" for any N (Manual, or a legacy preset), and the legacy literal "full-period". Used
// anywhere a value needs to be displayed (tooltips, row-level select, reports) instead of a raw
// FORECAST_MODELS.find(), since Manual's N is free-form and can't be enumerated in that list.
export function forecastModelLabel(value){
  if(!value||value==="auto")return "Auto";
  if(value==="committed")return "Committed spend";
  if(value==="full-period")return "Full period (legacy)";
  const m=/^trailing(\d+)$/.exec(value);
  if(m)return `Manual (trailing ${m[1]}d)`;
  return value;
}
// Row-level picker sentinel — "inherit the workspace's global default" is stored as simply having
// NO _forecastModel key at all (see setForecastModel below), same as before global defaults
// existed. This constant is just the <select>'s value for that state; never itself persisted.
export const FORECAST_MODEL_INHERIT="";
export const MONTH_MAP={jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",january:"01",february:"02",march:"03",april:"04",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"};
// Two-level campaign hierarchy: "campaign_group_name" is the top level (LinkedIn's own
// "Campaign Group"; what Meta/Google/Bing/Reddit simply call "Campaign"). "campaign_name" is
// the leaf level actually being tagged (LinkedIn's own "Campaign" object; Meta/Reddit's
// "Ad Set"; Google/Bing's "Ad Group"). Only campaign_group_name is required — campaign_name
// falls back to it for platforms/exports that don't have a second level of breakdown, so
// nothing breaks for data that predates this two-level model.
export const REQUIRED_COLS=["campaign_group_name","spend","date"];
export const OPTIONAL_COLS=["campaign_name","platform","campaign_type","impressions","clicks","campaign_id","adset_id"];
// campaign_type: the platform's own authoritative type field (Google Ads' "Campaign type" column
// — Search/Display/Demand Gen/Performance Max/Video) when the export has one. This is trusted
// over name-based guessing in derivePlatform() below, since naming conventions are ambiguous —
// e.g. Google's Demand Gen campaigns are frequently still named with a legacy "GDN-" prefix
// (carried over from before Display/Discovery rolled into Demand Gen) with no text in the name
// that distinguishes them from real Display campaigns.
// Negative lookaheads on campaign_group_name/campaign_name guard against "status" columns —
// Google's "Ad group status" otherwise matches the bare /ad.?group/i pattern just as eagerly as
// the real "Ad group" column, and since autoDetect() takes the first match per header order, a
// "status" column earlier in the file silently wins and the real name column never gets mapped.
// date matches "Month" too — Google/Bing's manual exports report one row per ad group PER MONTH,
// with a column literally named "Month" (not "Date"/"Day"), which the old pattern never caught.
// impressions matches "Impr."/"Imp." (Google/Bing's actual abbreviated header) in addition to the
// full word "impression" — anchored so it doesn't also grab "Impr. (Top) %" or similar columns
// that start the same way but aren't the impressions count itself.
export const COL_PATTERNS={campaign_group_name:/^(?!.*status)campaign.?group/i,campaign_name:/^(?!.*status)(ad.?set|ad.?group)/i,spend:/cost|spend|amount/i,date:/^date$|^day$|^month$/i,platform:/platform|traffic.source|channel|source/i,campaign_type:/campaign.?type/i,impressions:/^impr?\.?$|impression/i,clicks:/^clicks?$/i,campaign_id:/campaign.*id/i,adset_id:/ad.?set.*id|ad.?group.*id/i};
export const COL_LABELS={campaign_group_name:"Campaign Group Name",campaign_name:"Campaign Name (Ad Set / Ad Group)",spend:"Spend / Cost",date:"Date",platform:"Platform / Traffic Source",campaign_type:"Campaign Type (Search/Display/Demand Gen)",impressions:"Impressions",clicks:"Clicks",campaign_id:"Campaign ID",adset_id:"Ad Set ID"};
// Composite identity key — ad set / ad group names often repeat across different campaigns
// (e.g. two campaigns both have a "Retargeting" ad set), so tagging and dedup identity must
// combine both levels, not just the leaf name alone.
export const campaignKey=(groupName,name)=>`${groupName||name||""}||${name||groupName||""}`;
// Used by the debounced-save empty-write guard (see the big comment near hadRealConfigRef in the
// main BudgetHQ component) — "empty" means nothing worth protecting, i.e. no tags, no budgets, and
// no budget dimension setup either (tagDims/budgetRowMeta/budgetImportMeta are metadata that only
// matter alongside actual tags/budgets, so they're deliberately not checked here).
export const isEmptyConfig=c=>!Object.keys(c?.tags||{}).length&&!Object.keys(c?.budgets||{}).length;
// Comma-separated multi-term filter matching, used by the Tagger's Group/Campaign/Tag filters —
// both the "contains" and "excludes" side of each. Terms are OR'd together: "google,bing" as an
// include filter matches anything containing EITHER term; as an exclude filter, it drops anything
// containing EITHER term. Empty/whitespace-only terms from stray commas are dropped.
export const splitFilterTerms=s=>(s||"").split(",").map(t=>t.trim().toLowerCase()).filter(Boolean);
// mode "or" = matches/excludes if ANY term is present; "and" = only if ALL terms are present.
export const matchesTerms=(haystackLower,terms,mode)=>mode==="and"?terms.every(t=>haystackLower.includes(t)):terms.some(t=>haystackLower.includes(t));
// Distinct value already used per budget dimension, across every year — feeds the Tagger's
// autocomplete so typing a tag value can suggest e.g. "EPM Suite" for Pillar instead of risking a
// typo that creates an orphaned segment. Segment keys are dims.join("|"), so splitting one back
// apart and zipping against budgetDims recovers each dimension's actual value for that segment.
export function getBudgetDimValues(budgets,budgetDims){
  const map={};
  (budgetDims||[]).forEach(d=>map[d]=new Set());
  Object.values(budgets||{}).forEach(yearBudgets=>{
    Object.keys(yearBudgets||{}).forEach(segKey=>{
      const vals=segKey.split("|");
      (budgetDims||[]).forEach((d,i)=>{if(vals[i])map[d].add(vals[i]);});
    });
  });
  const result={};
  (budgetDims||[]).forEach(d=>result[d]=[...map[d]].sort((a,b)=>a.localeCompare(b)));
  return result;
}
export const DEFAULT_DIMS=["Product","Region","Funnel","Pillar"];
// Pre-auth localStorage keys — see the "one-time import of pre-auth localStorage data" block in
// BudgetHQ() for what reads/clears these.
export const LEGACY_LOCAL_KEYS=["paidhq_tags","paidhq_dims","paidhq_budgets","paidhq_budget_dims","paidhq_budget_meta","paidhq_budget_meta_dims","paidhq_budget_import_meta","paidhq_rows"];
export const PLATFORM_COLORS={LinkedIn:"#0a66c2","Google Search":"#4285f4","Google Display":"#34a853","Demand Gen":"#f59e0b","Performance Max":"#ef4444",Meta:"#0082FB",Bing:"#00809d",YouTube:"#ff0000",Capterra:"#ff6d2d",Unknown:"#9B9A92"};
// Applied-tag pill colors in the Tagger — a plain white/grey pill read as too flat to spot at a
// glance, so pills use a tinted "selected chip" treatment (light background + colored border/text)
// instead of a flat outline, with a distinct color PER TAG DIMENSION (Product/Module/Brand/etc. each
// get their own hue) so the Tags column reads at a glance without having to read every label.
// Pulled straight from Mo's brand palette (2026-07-21) — Deep Slate/Ocean Steel/Jet Black are the
// only three colors in the new slate palette dark enough to read as distinct pill colors (Cloud
// Mist and Pure White are too light for text-on-tint contrast), so the remaining entries are
// lighter/darker tints of those same three hues rather than off-palette colors, keeping every
// dimension's pill "on brand" instead of reaching for an arbitrary rainbow.
export const TAG_DIM_COLORS=["#36565F","#5F8190","#141414","#4A7080","#23414A","#7A9CAA","#0A2226","#8FB0BC"];
export const NAV=[{key:"dashboard",label:"Dashboard",icon:"bolt"},{key:"data",label:"Data Sources",icon:"download"},{key:"tagger",label:"Campaign Tagger",icon:"tag"},{key:"budget",label:"Budget Panel",icon:"wallet"},{key:"pacing",label:"Reporting & Pacing",icon:"chart"},{key:"ask",label:"Ask AI",icon:"sparkle"}];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
export function autoDetect(h){
  const m={};
  h.forEach(c=>{for(const[f,p]of Object.entries(COL_PATTERNS)){if(!m[f]&&p.test(c.trim()))m[f]=c;}});
  // A bare "Campaign" header is ambiguous: for Meta/Google/Bing/Reddit it IS the campaign group
  // (handled by the fallback below), but when a dedicated "Campaign Group" column was already
  // found above (LinkedIn's export shape), "Campaign" is LinkedIn's own Campaign object — i.e.
  // our leaf-level campaign_name — not the group.
  if(!m.campaign_name){const c=h.find(c=>/^campaign$/i.test(c.trim()));if(c&&m.campaign_group_name)m.campaign_name=c;}
  if(!m.campaign_group_name){const c=h.find(c=>/campaign/i.test(c)&&!/id|group|type/i.test(c));if(c)m.campaign_group_name=c;}
  if(!m.spend){const c=h.find(c=>/cost|spend/i.test(c));if(c)m.spend=c;}
  if(!m.date){const c=h.find(c=>/date|day|month/i.test(c));if(c)m.date=c;}
  return m;
}
// Infers a specific platform label (Google Search vs Google Display vs Demand Gen vs YouTube,
// etc.). Trusts an explicit campaign_type value first — Google Ads' own "Campaign type" API/export
// field (Search/Display/Demand Gen/Performance Max/Video) — since that's ground truth and naming
// conventions are genuinely ambiguous (Google has been rolling Display into Demand Gen, so a
// legacy "GDN-" prefixed campaign may really be Demand Gen with no text distinguishing it from
// real Display). Only falls back to naming-convention prefixes when campaign_type isn't mapped —
// e.g. platforms without a type field, or older exports. Checks the CAMPAIGN GROUP name before
// the leaf (ad set/ad group) name — in every real export seen so far (Google Ads, LinkedIn), the
// SEA-/GDN-/YT-/LIN-/FB-/BIN- prefix convention lives on the campaign, not the ad group.
export function derivePlatform(groupName,name,pv,campaignType){
  const ct=(campaignType||"").trim().toLowerCase();
  if(ct==="search")return"Google Search";
  if(ct==="display")return"Google Display";
  if(ct==="demand gen"||ct==="demandgen")return"Demand Gen";
  if(ct==="performance max"||ct==="performancemax"||ct==="pmax")return"Performance Max";
  if(ct==="video")return"YouTube";

  const p=(pv||"").toLowerCase();
  for(const raw of [groupName,name]){
    const u=(raw||"").toUpperCase();
    if(!u)continue;
    if(/^LIN[-|]/.test(u))return"LinkedIn";
    if(/^FB[-|]/.test(u))return"Meta";
    if(/^BIN[-|]/.test(u))return"Bing";
    if(/^YT[-|]/.test(u))return"YouTube";
    if(/demand.?gen|discovery/i.test(u))return"Demand Gen";
    if(/^SEA[-|]/.test(u))return"Google Search";
    if(/^GDN[-|]/.test(u))return"Google Display";
    if(/pmax|performance.max/i.test(u))return"Performance Max";
  }
  if(p.includes("linkedin"))return"LinkedIn";
  if(p.includes("facebook")||p.includes("meta"))return"Meta";
  if(p.includes("bing"))return"Bing";
  if(p.includes("youtube"))return"YouTube";
  if(p==="search")return"Google Search";
  if(p==="display")return"Google Display";
  if(p==="demand gen")return"Demand Gen";
  if(p.includes("google"))return"Google Search";
  if(p.includes("capterra"))return"Capterra";
  return pv||"Unknown";
}
// "Platform" as a BUDGETING dimension (Budget By / Pacing segment matching, not just Reporting
// breakdowns) — added 2026-07 so someone can budget/forecast purely by channel with zero manual
// tagging, same as Reporting's breakdown/AskAI views already allow via resolveDimValue. Unlike a
// real tag dimension, "Platform" is never stored in campaignTags — there's nothing to look up by
// campaign key alone, so any code matching campaigns against a segment that includes "Platform"
// needs a campaignKey -> derived-platform lookup built from actual spend rows. Built once per
// mergedNormRows change and threaded through to every function below that used to read
// tags[key][dim] directly for budgetDims.
export function buildCampaignPlatformIndex(mergedNormRows){
  const idx={};
  (mergedNormRows||[]).forEach(row=>{
    const key=campaignKey(row.campaign_group_name,row.campaign_name);
    if(!idx[key])idx[key]=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
  });
  return idx;
}
// Formats a Date's LOCAL calendar day as YYYY-MM-DD — deliberately NOT d.toISOString().slice(0,10),
// which reads UTC fields. That distinction only bites when a Date was built from local y/m/d
// components (e.g. new Date(year,0,1) for "start of this year"): toISOString() on that value walks
// it back to UTC first, so anyone west of Greenwich (all of the US) gets Dec 31 instead of Jan 1 —
// caught live 2026-07-24 via the sync range picker's "This year" preset (and the picker's own
// this-quarter default) reporting an import start one day earlier than the date actually picked.
// d.getFullYear()/getMonth()/getDate() below read the same LOCAL fields the Date was constructed
// from, so this round-trips exactly instead of drifting across the UTC boundary.
export const localISODate=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
export const parseMoney=v=>{if(v===""||v==null)return null;const n=parseFloat(String(v).replace(/[$,\s%]/g,""));return isNaN(n)?null:n;};
export const fmt$=n=>{if(!n)return"";return"$"+Math.round(n).toLocaleString();};
export const fmtFull=n=>n?"$"+Math.round(n).toLocaleString():"—";
export const isMonthHdr=c=>{const x=c.trim().toLowerCase().replace(/\s+\d{4}$/,"");return!!MONTH_MAP[x];};
export const getMonthKey=c=>{const x=c.trim().toLowerCase().replace(/\s+\d{4}$/,"");return MONTH_MAP[x]||null;};
// Detects a single flat recurring-monthly amount column (e.g. "Monthly Budget", "Monthly Spend")
// — distinct from a genuine period/date column. Tables that have this AND no named-month columns
// AND no parseable period column are a 4th import shape ("flat"): one row per segment, no
// per-month breakdown at all, just a monthly run-rate figure to replicate across every month.
export const findFlatMonthlyCol=headers=>headers.find(h=>/monthly/i.test(h)&&/budget|amount|spend|cost/i.test(h));
export function parsePeriod(val){if(!val)return null;const s=String(val).trim();let m=s.match(/^(\d{4})-(\d{2})$/);if(m)return m[2];m=s.match(/^(\d{1,2})\/(\d{4})$/);if(m)return String(m[1]).padStart(2,"0");const l=s.toLowerCase().replace(/[,\s]+/g," ");for(const[n,k]of Object.entries(MONTH_MAP)){if(l.startsWith(n))return k;}return null;}

// Parse any file (CSV or Excel) to array of arrays
export function parseFileToRows(file,callback){
  const ext=file.name.split(".").pop().toLowerCase();
  if(ext==="csv"){
    Papa.parse(file,{header:false,skipEmptyLines:false,complete:r=>callback(r.data.map(row=>row.map(v=>String(v??""))))});
  } else {
    const reader=new FileReader();
    reader.onload=e=>{
      const wb=XLSX.read(new Uint8Array(e.target.result),{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:"",raw:false});
      callback(rows.map(row=>row.map(v=>String(v??""))));;
    };
    reader.readAsArrayBuffer(file);
  }
}

// Forward-fill empty cells in a row (for merged-cell group headers in CSV)
export function forwardFillGroups(row){
  let last="";
  return row.map(v=>{const s=String(v||"").trim();if(s&&!/^(channel|group|category|platform)$/i.test(s))last=s;return last;});
}

// Download helper
export function downloadCSV(rows, filename){
  const csv=rows.map(r=>r.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob=new Blob(["\uFEFF"+csv,],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}

// \u2500\u2500\u2500 VERSION HISTORY (IndexedDB) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Full-app snapshots (Tagger + Budget data together, since they're interdependent \u2014 e.g. a
// budget-import merge also retags campaigns, so restoring one without the other could leave
// spend attribution broken) stored via IndexedDB rather than localStorage: a handful of
// snapshots of budgets+tags+spend rows can easily exceed localStorage's ~5-10MB ceiling, while
// IndexedDB has effectively no practical limit for data this size. A new version is saved
// automatically after major actions (imports, clears, merge resolutions) \u2014 not on every
// keystroke \u2014 plus on demand via "Name current version\u2026", mirroring Google Sheets' model of
// checkpointing meaningful moments rather than every edit.
// Version history and File Store are now server-backed (see listVersions/saveVersion/
// deleteVersion and listFiles/uploadFile/deleteFile/downloadFile imported above from
// workspaceApi.js), workspace-scoped instead of living in one fixed-name IndexedDB database
// shared across every workspace ever opened in this browser. The load/save call sites live
// further down inside the BudgetHQ component, where session/workspace are in scope.

// Groups version records into "Today" / "Yesterday" / weekday-or-date buckets, same convention
// Google Sheets' version history panel uses, so the list reads as a scannable timeline instead
// of a flat log of timestamps.
export function groupVersionsByDay(versions){
  const now=new Date();
  const startOfDay=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
  const today=startOfDay(now);
  const yesterday=today-86400000;
  const groups=[];
  versions.forEach(v=>{
    const day=startOfDay(new Date(v.timestamp));
    const label=day===today?"Today":day===yesterday?"Yesterday":new Date(v.timestamp).toLocaleDateString(undefined,{weekday:"long",month:"short",day:"numeric"});
    let g=groups.find(g=>g.label===label);
    if(!g){g={label,items:[]};groups.push(g);}
    g.items.push(v);
  });
  return groups;
}

// ─── FILE STORE (server-backed, workspace-scoped) ──────────────────────────────
// Archive of raw uploaded/exported files (tagging CSVs, channel spend import CSVs, PDFs, etc.).
// Auto-captured at the CSV import/export call sites (see handleFile, exportTags,
// importTagsFromCSV) plus a manual "Add file" upload for anything else (PDFs, insertion orders,
// etc.) the app never parses itself. archiveFile itself is defined inside the BudgetHQ component
// (needs session/workspace in scope to call the API) — see the "archiveFile" useCallback below.

export const fmtFileSize=n=>{
  if(!n)return"0 KB";
  if(n<1024*1024)return`${Math.max(1,Math.round(n/1024))} KB`;
  return`${(n/(1024*1024)).toFixed(1)} MB`;
};

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────

export function normalizeRows(rows,colMap){
  return rows.map(row=>{
    const groupName=(row[colMap.campaign_group_name]||"").trim();
    const leafName=(row[colMap.campaign_name]||"").trim()||groupName;
    return{
      campaign_group_name:groupName,
      campaign_name:leafName,
      spend:parseFloat(String(row[colMap.spend]||"0").replace(/[$, ]/g,""))||0,
      platform:(row[colMap.platform]||"").trim()||"Unknown",
      campaign_type:(row[colMap.campaign_type]||"").trim(),
      date:String(row[colMap.date]||"").trim(),
      impressions:parseInt(String(row[colMap.impressions]||"0").replace(/,/g,""))||0,
      clicks:parseInt(String(row[colMap.clicks]||"0").replace(/,/g,""))||0,
    };
  }).filter(r=>r.campaign_group_name&&r.spend>0);
}

// Merge normalized rows — deduplicate by campaign group + campaign + CALENDAR DAY (not the raw
// date string), new data wins.
//
// FIX (2026-07-21): the identity key used to join on r.date as a raw string. That meant the exact
// same real day could hash to two different keys across two pulls/uploads that happen to format
// dates differently -- a live API returning "2026-07-21T00:00:00.000Z" one time and
// "2026-07-21" the next, or re-exporting "the same" CSV from a spreadsheet that serializes dates
// differently on a second export -- and instead of overwriting, that silently ADDED a second row
// for the same real day, doubling its spend. This was the actual reported bug: syncing a channel
// twice, or uploading nominally the same CSV twice/three times, added spend instead of deduping.
// Keying on parseSpendDate's already-parsed calendar day collapses every date format this app
// already treats as equivalent everywhere else (pacing math, trend charts) down to one identity,
// so re-pulling/re-uploading the same data now always overwrites. Campaign identity is trimmed for
// the same reason -- stray leading/trailing whitespace from a spreadsheet shouldn't be enough to
// make "Retargeting" and "Retargeting " look like two different ad sets.
export function spendRowKey(r){
  const d=parseSpendDate(r.date);
  const dateKey=d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`:String(r.date||"").trim();
  return `${campaignKey((r.campaign_group_name||"").trim(),(r.campaign_name||"").trim())}||${dateKey}`;
}
export function mergeRows(existing,incoming){
  const map=new Map(existing.map(r=>[spendRowKey(r),r]));
  incoming.forEach(r=>map.set(spendRowKey(r),r));
  return Array.from(map.values());
}

// Flags manually-imported rows (CSV/screenshot/Google Sheets) that share identity with an
// already-LIVE-SYNCED row (same campaign group + campaign + calendar day, via spendRowKey) but
// disagree on spend — added 2026-07-24 per Mo, since mergeRows above is silent last-write-wins
// with no platform check in its identity key at all. Without this, a manual import whose campaign
// naming happens to line up with a synced platform's row would silently overwrite real platform
// data with no warning; naming that DOESN'T line up exactly would instead double-count as a
// separate row. This only catches the first case (the identity match) — it can't detect the
// second (naming mismatch) since there's nothing to key on; that's a naming/mapping problem, not
// a value conflict, and is out of scope here.
// Only compares against rows whose source is a real platform sync (source starts with "sync:") —
// two manual imports disagreeing with each other is just an ordinary re-import (expected,
// last-write-wins), not "wrong compared to synced platform spend."
// Threshold is intentionally loose (>$1 or >1% of the synced value, whichever is larger) so this
// doesn't nag about floating-point/rounding noise between two exports of what's really the same
// number.
export function detectSpendConflicts(existingRows,incomingRows){
  const syncedByKey=new Map();
  existingRows.forEach(r=>{if((r.source||"").startsWith("sync:"))syncedByKey.set(spendRowKey(r),r);});
  const conflicts=[];
  incomingRows.forEach(r=>{
    const synced=syncedByKey.get(spendRowKey(r));
    if(!synced)return;
    const diff=Math.abs((r.spend||0)-(synced.spend||0));
    if(diff>Math.max(1,synced.spend*0.01)){
      conflicts.push({
        key:spendRowKey(r),
        campaignGroupName:r.campaign_group_name,
        campaignName:r.campaign_name,
        date:r.date,
        syncedSpend:synced.spend,
        syncedPlatform:synced.source.replace(/^sync:/,""),
        importedSpend:r.spend,
      });
    }
  });
  return conflicts;
}

export const MONTH_ABBR={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

// ─── PACING ENGINE ────────────────────────────────────────────────────────────
// Robust date parser — handles "YYYY-MM-DD", "M/D/YYYY", "MM/DD/YY", month-label formats
// (see below), "YYYY-MM", and falls back to native Date parsing for anything else.
//
// MONTH-LABEL FIX (2026-07): Google/Bing's manual monthly exports report one row per month, with
// values like "Jul-26" (Google) or "2026-07-01" (Bing) rather than a real per-day date — both mean
// "the whole month," not a specific day. "2026-07-01" was already handled fine by the YYYY-MM-DD
// case above. "Jul-26" was NOT — it fell through to native `new Date("Jul-26")`, which (confirmed
// directly) parses it as day=26 of a fixed default year (2001), not July 2026. That's a real bug:
// silently sending a date decades in the past into every downstream calculation, which either drops
// the row from every period entirely (date never falls in range) or, combined with the per-platform
// freshness projection, feeds garbage into the pacing math. Handled explicitly now instead of
// trusting native parsing for this ambiguous shape. Represented as the 1st of that month, same
// convention as the existing YYYY-MM-DD handling of Bing's format.
export function parseSpendDate(v){
  if(!v)return null;
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m)return new Date(+m[1],+m[2]-1,+m[3]);
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if(m){let y=+m[3];if(y<100)y+=2000;return new Date(y,+m[1]-1,+m[2]);}
  // "Jul-26", "Jul 2026", "July-2026", "Jul/26" — month name/abbreviation + 2-or-4-digit year
  m=s.match(/^([A-Za-z]{3,9})[\s\-/]+(\d{2,4})$/);
  if(m){
    const mon=MONTH_ABBR[m[1].slice(0,3).toLowerCase()];
    if(mon!=null){let y=+m[2];if(y<100)y+=2000;return new Date(y,mon,1);}
  }
  // "2026-07" — year-month, no day
  m=s.match(/^(\d{4})-(\d{1,2})$/);
  if(m)return new Date(+m[1],+m[2]-1,1);
  const d=new Date(s);
  return isNaN(d.getTime())?null:d;
}

// Resolve a period type + selectors into a date range and the set of month-keys it covers
export function getPeriodRange(periodType,year,month,quarter){
  const y=Number(year);
  if(periodType==="monthly"){
    const m=Number(month);
    return{start:new Date(y,m-1,1),end:new Date(y,m,0),months:[month]};
  }
  if(periodType==="quarterly"){
    const qd=QUARTERS.find(q=>q.key===quarter)||QUARTERS[0];
    const qi=Number(quarter.replace("Q",""));
    return{start:new Date(y,(qi-1)*3,1),end:new Date(y,qi*3,0),months:qd.months};
  }
  return{start:new Date(y,0,1),end:new Date(y,11,31),months:MONTHS.map(m=>m.key)};
}

// Renames every occurrence of a dimension value (e.g. Product "PowerON" -> "Power On") across:
// budgets (every year, any segKey with this dim's value at the matching position),
// budgetRowMeta (same segKey remapping), and campaign tags (every campaign tagged with the old
// value for this dimension). This is what makes an inline edit actually reconnect Pacing —
// renaming just the budget row's label alone wouldn't retag campaigns, so spend would still
// never match. If the renamed key collides with an already-existing segment, monthly budget
// amounts are summed rather than overwritten so no data is silently lost.
export function renameDimensionValue({budgets,budgetRowMeta,tags,budgetDims,dim,oldVal,newVal}){
  const dimIdx=budgetDims.indexOf(dim);
  if(dimIdx===-1||oldVal===newVal)return{budgets,budgetRowMeta,tags};

  const remapKey=oldKey=>{
    const parts=oldKey.split("|");
    if(parts.length!==budgetDims.length||parts[dimIdx]!==oldVal)return null;
    const newParts=[...parts];newParts[dimIdx]=newVal;
    return newParts.join("|");
  };

  const newBudgets=JSON.parse(JSON.stringify(budgets||{}));
  Object.keys(newBudgets).forEach(yr=>{
    const yearObj=newBudgets[yr];
    Object.keys(yearObj).forEach(oldKey=>{
      const newKey=remapKey(oldKey);
      if(!newKey||newKey===oldKey)return;
      const oldEntry=yearObj[oldKey];
      if(yearObj[newKey]){
        const merged={...yearObj[newKey]};
        merged.monthly={...(yearObj[newKey].monthly||{})};
        Object.entries(oldEntry.monthly||{}).forEach(([mk,amt])=>{merged.monthly[mk]=(merged.monthly[mk]||0)+(amt||0);});
        if(oldEntry.quarterly||yearObj[newKey].quarterly)merged.quarterly={...(oldEntry.quarterly||{}),...(yearObj[newKey].quarterly||{})};
        if(oldEntry.annual!=null&&merged.annual==null)merged.annual=oldEntry.annual;
        yearObj[newKey]=merged;
      }else{
        yearObj[newKey]=oldEntry;
      }
      delete yearObj[oldKey];
    });
  });

  const newBudgetRowMeta={...(budgetRowMeta||{})};
  Object.keys(budgetRowMeta||{}).forEach(oldKey=>{
    const newKey=remapKey(oldKey);
    if(!newKey||newKey===oldKey)return;
    if(!newBudgetRowMeta[newKey])newBudgetRowMeta[newKey]=newBudgetRowMeta[oldKey];
    delete newBudgetRowMeta[oldKey];
  });

  const newTags={...(tags||{})};
  Object.entries(tags||{}).forEach(([campaign,t])=>{
    if(t[dim]===oldVal)newTags[campaign]={...t,[dim]:newVal};
  });

  return{budgets:newBudgets,budgetRowMeta:newBudgetRowMeta,tags:newTags};
}

// Collapses budget segKeys that differ only by leading/trailing whitespace in one or more
// dimension values (e.g. "APAC|Search" and "APAC |Search" from two exports of "the same" budget
// file, or a spreadsheet that trims inconsistently) down to one, summing monthly amounts on
// collision -- same merge semantics as the intentional rename-merge in renameDimensionValue above,
// since a whitespace-only difference is never a genuinely different segment. Without this,
// re-importing a budget file whose values pick up stray whitespace on a later export creates a
// second, phantom segKey that coexists with the original instead of overwriting it -- both then
// count toward totals.budget in computePacing, silently doubling that segment's budgeted amount.
// Run once on load (see the workspace-data load effect) so any duplication already sitting in a
// workspace's stored data self-heals the next time it's opened, not just going forward.
export function consolidateBudgetSegKeys(budgets,budgetRowMeta){
  let changed=false;
  const newBudgets=JSON.parse(JSON.stringify(budgets||{}));
  const newBudgetRowMeta={...(budgetRowMeta||{})};
  Object.keys(newBudgets).forEach(yr=>{
    const yearObj=newBudgets[yr];
    const output={};
    Object.keys(yearObj).forEach(oldKey=>{
      const trimmedKey=oldKey.split("|").map(s=>s.trim()).join("|");
      const entry=yearObj[oldKey];
      if(trimmedKey!==oldKey){
        changed=true;
        if(newBudgetRowMeta[oldKey]&&!newBudgetRowMeta[trimmedKey]){newBudgetRowMeta[trimmedKey]=newBudgetRowMeta[oldKey];delete newBudgetRowMeta[oldKey];}
      }
      if(output[trimmedKey]){
        changed=true;
        const merged={...output[trimmedKey]};
        merged.monthly={...(output[trimmedKey].monthly||{})};
        Object.entries(entry.monthly||{}).forEach(([mk,amt])=>{merged.monthly[mk]=(merged.monthly[mk]||0)+(amt||0);});
        if(entry.quarterly||output[trimmedKey].quarterly)merged.quarterly={...(entry.quarterly||{}),...(output[trimmedKey].quarterly||{})};
        if(entry.annual!=null&&merged.annual==null)merged.annual=entry.annual;
        output[trimmedKey]=merged;
      }else{
        output[trimmedKey]=entry;
      }
    });
    newBudgets[yr]=output;
  });
  return{budgets:newBudgets,budgetRowMeta:newBudgetRowMeta,changed};
}

// Removes just the budgetDims tag values (not the whole campaign) from every campaign that
// matches this segment's exact dimension combo — used when deleting a budget row, so a deleted
// segment doesn't leave campaigns still carrying a tag combination with no budget behind it.
// Spend data itself is untouched; matching campaigns simply lose these specific tags and fall
// back to "needs review" in the Tagger. "Platform" is never actually stored as a tag (see
// buildCampaignPlatformIndex) so there's nothing to delete for it specifically — matching still
// needs platformIndex to know which campaigns it applies to, but the delete step itself just
// skips over it.
export function untagSegmentCampaigns(tags,budgetDims,segKey,platformIndex){
  const vals=segKey.split("|");
  if(vals.length!==budgetDims.length)return tags;
  const newTags={...(tags||{})};
  Object.entries(tags||{}).forEach(([campaign,t])=>{
    const matches=budgetDims.every((d,i)=>(d==="Platform"?(platformIndex?.[campaign]||""):t[d])===vals[i]);
    if(!matches)return;
    const nt={...t};
    budgetDims.forEach(d=>{if(d!=="Platform")delete nt[d];});
    newTags[campaign]=nt;
  });
  return newTags;
}
// Campaigns matching a segment aren't limited to ones already present in `tags` once "Platform"
// is one of the budgetDims — a campaign with zero manual tags can still match a Platform-only (or
// Platform + already-tagged) segment. Unions tag-known campaign keys with platform-known ones so
// both are considered; platformIndex is only needed (and only non-empty) when budgetDims actually
// includes "Platform" — every other caller passes it as undefined and gets the old behavior.
export function countSegmentCampaigns(tags,budgetDims,segKey,platformIndex){
  const vals=segKey.split("|");
  if(vals.length!==budgetDims.length)return 0;
  const allKeys=new Set([...Object.keys(tags||{}),...(platformIndex?Object.keys(platformIndex):[])]);
  let count=0;
  allKeys.forEach(key=>{
    const t=(tags||{})[key]||{};
    const matches=budgetDims.every((d,i)=>(d==="Platform"?(platformIndex?.[key]||""):t[d])===vals[i]);
    if(matches)count++;
  });
  return count;
}

// Reporting drill-down: sums spend for a segment (matched by budgetDims/segKey, within a date
// range) grouped by ONE secondary dimension — independent of budgets entirely, so it works
// whether or not a formal budget exists at that level. "Platform" is a synthetic option derived
// per-row (same logic the rest of the app uses for platform badges), since it isn't a manual tag.
export function computeSpendBreakdown({mergedNormRows,tags,budgetDims,segKey,breakdownDim,start,end}){
  const vals=segKey.split("|");
  const map={};
  mergedNormRows.forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d||d<start||d>end)return;
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    if(!budgetDims.every((dim,i)=>resolveDimValue(row,rowTags,dim)===vals[i]))return;
    const bval=breakdownDim==="Platform"?derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type):(rowTags[breakdownDim]||"Untagged");
    map[bval]=(map[bval]||0)+row.spend;
  });
  const total=Object.values(map).reduce((s,v)=>s+v,0);
  return Object.entries(map).map(([value,spend])=>({value,spend,pct:total>0?spend/total:0})).sort((a,b)=>b.spend-a.spend);
}

// ─── ASK AI ───────────────────────────────────────────────────────────────────
// Grounded query tools + tool-use loop backing the "Ask AI" chat. Rather than dumping raw
// spend rows into a prompt and hoping the model's arithmetic is right, Claude is given a small
// set of tools that run REAL JS aggregation (the same kind of filter+sum used by Pacing's
// breakdown above) and can only answer from what those tools actually return — the model does
// the natural-language understanding (parsing "January vs March", matching "EMEA" to a Region
// tag) but never invents a number itself.

// Tool schemas in Anthropic's tool-use format.
//
// EXPANDED 2026-07-21: originally spend-only (query_spend) — Ask AI had no way to answer anything
// about budgets (what was ALLOCATED) or pacing (allocated vs actual together), and no way to
// isolate tagged vs. untagged spend specifically, even though those are exactly the three lenses
// the rest of the app is built around (Budget Panel = allocation, Tagger = tagged/untagged spend,
// Reporting & Pacing = both together). Added query_budget (budget data alone), query_pacing
// (budget + spend together, mirroring computePacing's own status/variance logic so Ask AI's
// answers can't drift from what the Reporting tab itself shows), and a tagged_status filter on
// query_spend (spend data alone, sliced by whether a campaign carries every Budget By tag or not).

export function computeActualsByMonth({mergedNormRows,tags,budgetDims,year}){
  const map={};
  if(!budgetDims.length)return map;
  mergedNormRows.forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d||d.getFullYear()!==Number(year))return;
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    const vals=budgetDims.map(dim=>resolveDimValue(row,rowTags,dim));
    if(vals.some(v=>!v))return;
    const sk=vals.join("|");
    const mk=String(d.getMonth()+1).padStart(2,"0");
    if(!map[sk])map[sk]={};
    map[sk][mk]=(map[sk][mk]||0)+row.spend;
  });
  return map;
}

// For each derived platform, the most recent date we actually have spend data for — global,
// not scoped to any one period. This is what "last updated" means per source: live-synced
// platforms (LinkedIn, Capterra) are current as of the last sync, but manually-uploaded ones
// (Google, Bing CSVs) are only as fresh as the last time someone re-uploaded a file, which is
// often days behind "today". Used both to drive the corrected pacing projection below and to
// show a per-platform freshness indicator in the Pacing UI.
export function computePlatformFreshness(mergedNormRows){
  const map={};
  (mergedNormRows||[]).forEach(row=>{
    // as_of_date (set at upload time via the "Data accurate through" override) takes priority
    // over the row's own Date column — needed for range-exported platforms (Google/Bing) where
    // Date often reflects the range's START rather than the as-of/end date the spend is actually
    // current through. See uploadAsOf state comment in the map step for the full explanation.
    const d=row.as_of_date?parseSpendDate(row.as_of_date):parseSpendDate(row.date);
    if(!d)return;
    const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
    if(!map[platform]||d>map[platform])map[platform]=d;
  });
  return map;
}

// Per-platform day-of-week spend index — e.g. index[3]===1.4 means Wednesdays for this platform run
// ~40% above that platform's typical day, index[0]===0.3 means Sundays run ~70% below. Computed
// from ALL of a workspace's spend history (not scoped to any one period, same as
// computePlatformFreshness above), since a segment newly created this quarter won't have enough of
// its own history yet to learn a weekly shape from.
//
// WHY THIS MATTERS (added 2026-07-25, per Mo): projectPlatformSegment's trailing-N-day models
// (especially trailing1/trailing3) previously treated every day as interchangeable — a Sunday's
// naturally-quieter $50 spend read as "the daily rate crashed to $50," not "this is a normal
// Sunday." That's real noise in the projection, not signal. This index lets the projection
// deseasonalize each known day (actual ÷ that weekday's index = a "typical-day-equivalent" amount)
// before averaging, then reseasonalize when projecting forward (typical-day rate × each future
// day's own index) — see projectPlatformSegment for the actual math. With every index at the
// neutral default of 1 (below), this reduces to exactly the old flat-average behavior, so this is
// a strict accuracy improvement, not a new mode to pick.
//
// Platform-level, not per-segment: most individual segments won't have enough history yet to
// reliably learn their own weekly shape (a brand-new campaign has zero), while a platform's overall
// shape (aggregated across every campaign on it) has much more data to work with sooner. A
// reasonable simplification — revisit if a specific segment's real pattern turns out to diverge
// meaningfully from its platform's overall shape (e.g. a B2B-only campaign on a platform whose
// other campaigns skew consumer/weekend-heavy).
export const DOW_MIN_SAMPLES=3; // need at least this many distinct historical occurrences of a weekday
                          // before trusting an index computed from it — otherwise neutral (1).
export const DOW_INDEX_CLAMP=[0.25,3]; // one outlier historical day can't swing the index past this range
export function computePlatformDayOfWeekIndex(mergedNormRows){
  const sums={}; // {platform: [{total,days:Set<dateStr>} x7]}, index 0=Sunday..6=Saturday (Date#getDay)
  (mergedNormRows||[]).forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d)return;
    const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
    if(!sums[platform])sums[platform]=Array.from({length:7},()=>({total:0,days:new Set()}));
    const bucket=sums[platform][d.getDay()];
    bucket.total+=row.spend||0;
    bucket.days.add(localISODate(d));
  });
  const index={};
  Object.entries(sums).forEach(([platform,byDow])=>{
    const dailyAvgs=byDow.map(b=>b.days.size?b.total/b.days.size:null);
    const trustedAvgs=dailyAvgs.filter((v,i)=>v!=null&&byDow[i].days.size>=DOW_MIN_SAMPLES);
    const overallAvg=trustedAvgs.length?trustedAvgs.reduce((s,v)=>s+v,0)/trustedAvgs.length:null;
    index[platform]=dailyAvgs.map((v,i)=>{
      if(v==null||byDow[i].days.size<DOW_MIN_SAMPLES||!overallAvg||overallAvg<=0)return 1;
      return Math.min(DOW_INDEX_CLAMP[1],Math.max(DOW_INDEX_CLAMP[0],v/overallAvg));
    });
  });
  return index; // {platform: [sunIdx,monIdx,tueIdx,wedIdx,thuIdx,friIdx,satIdx]}
}
export const DEFAULT_DOW_INDEX=[1,1,1,1,1,1,1];

// Full min/max date range of spend data actually present in BudgetHQ for each platform, regardless
// of how it got there (live sync, Google Sheets pull, CSV/screenshot upload). Distinct from
// computePlatformFreshness above, which is specifically "as of what date is this platform's
// spend current" for pacing/projection math (as_of_date-aware, always the max). This is the
// simpler, source-agnostic question "what date range of data do we actually have for this
// platform" — uses each row's own Date column directly (not as_of_date, which describes when
// a range-exported upload was accurate through, not what calendar days its rows represent).
export function computePlatformDateRange(mergedNormRows){
  const map={};
  (mergedNormRows||[]).forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d)return;
    const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
    if(!map[platform])map[platform]={min:d,max:d};
    else{
      if(d<map[platform].min)map[platform].min=d;
      if(d>map[platform].max)map[platform].max=d;
    }
  });
  return map;
}

// Core pacing calculation: aggregates spend into budget segments for a period and compares
// actual spend-to-date against time-elapsed expectation.
//
// PROJECTION NOTE (fixed 2026-07): the naive version of this divided a segment's TOTAL blended
// spend (across every platform) by ONE shared "days elapsed since period start" figure based on
// calendar "today". That's wrong whenever platforms don't all report in real time — e.g. Google/
// Bing here are manually re-uploaded roughly weekly, so their spend total is frozen as of the
// last upload while "days elapsed" keeps climbing every calendar day regardless. That understated
// their daily rate more and more between uploads, then jumped all at once when fresh data landed.
// LinkedIn/Capterra are live-synced and always current, so they didn't have this problem — but
// blending them together with the stale platforms let the stale ones drag the whole segment's
// projection down.
//
// Fix: each platform's rate is computed against ITS OWN as-of date (computePlatformFreshness,
// clamped to the period and to today), then each platform's projection is summed per segment —
// instead of blending raw spend first and dividing by one shared calendar-elapsed-days number.
//
// Shared by both computePacing (budget segments) and computeCustomGrouping (arbitrary dimension
// view) — the per-platform projection math doesn't care what a segment IS, only how much each
// platform spent within it and how fresh that platform's data is.
//
// forecastModel (optional, computePacing only — computeCustomGrouping never passes one, which
// now means it gets Auto below, same as any segment that hasn't set anything explicitly):
//   - "auto" (or unset/unrecognized) — see computeAutoBlendWeight and the isAuto branch below.
//   - "trailingN" (Manual) — a single flat N-day window, no blending. N is parsed straight out of
//     the model string rather than hardcoded per value.
//   - "full-period" (legacy only, no longer offered in the UI) — a single flat window of every
//     elapsed day, exactly the pre-2026-07-25 default behavior.
//   - "committed" — reaches this function too (harmless; computePacing ignores its projectedSum
//     and uses the committed amount directly instead), takes the full-period branch.
//
// platformDowIndex (optional — see computePlatformDayOfWeekIndex; omitted/missing entries fall
// back to DEFAULT_DOW_INDEX, i.e. neutral/no adjustment) deseasonalizes every known day in each
// estimation window before averaging (actual ÷ that weekday's index), then reseasonalizes when
// projecting across the full period (typical-day rate × each individual day's own index, summed —
// not a flat totalDays count, since a period ending on a weekend has a different weekday mix than
// one ending mid-week). This is what fixes a short window's biggest weakness: without it, a quiet
// Sunday reads as "spend crashed," not "this is a normal Sunday."
//
// Shared by both computePacing (budget segments) and computeCustomGrouping (arbitrary dimension
// view) — the per-platform projection math doesn't care what a segment IS, only how much each
// platform spent within it, how fresh that platform's data is, and (now) that platform's weekly
// shape. requires platformSpendMap's per-platform entries to carry a `byDate` breakdown (see
// computePacing's aggregation loop) — computeCustomGrouping's entries have one too for this reason.

// Shared by both branches below — averages a platform's deseasonalized daily spend (actual ÷ that
// weekday's index) over the `windowDays` immediately before and including `asOf`. A flat window,
// same math either way; what differs between Auto and Manual/full-period is which window(s) get
// computed and how they're combined, not how any single window itself is averaged.
function deseasonalizedRate(byDate,dowIdx,asOf,windowDays){
  if(!windowDays)return 0;
  let sum=0;
  for(let i=0;i<windowDays;i++){
    const d=new Date(asOf.getTime()-i*86400000);
    sum+=(byDate[localISODate(d)]||0)/(dowIdx[d.getDay()]||1);
  }
  return sum/windowDays;
}
// Auto's tuning knobs. Below AUTO_DIVERGENCE_LOW relative difference between the long-run and
// short-run rate, they're close enough that the long-run (more stable, less noisy) rate is used
// outright. Above AUTO_DIVERGENCE_HIGH, they've diverged enough that something real clearly
// changed recently (a budget shift, a platform coming online, a pause), so the short-run rate is
// trusted outright instead. In between, a linear ramp blends the two — no hard cutoff, so a
// borderline segment doesn't flip its whole projection based on one extra dollar of spend.
export const AUTO_SHORT_WINDOW=7;
export const AUTO_DIVERGENCE_LOW=0.15;
export const AUTO_DIVERGENCE_HIGH=0.50;
// Returns the WEIGHT ON THE SHORT RATE, 0 (ignore it, pure long-run) to 1 (pure short-run). Only
// exported for testability/reuse — projectPlatformSegment is the only real caller.
export function computeAutoBlendWeight(longRate,shortRate){
  if(!(longRate>0))return shortRate>0?1:0; // nothing to compare against yet — trust whatever exists
  const divergence=Math.abs(shortRate-longRate)/longRate;
  if(divergence<=AUTO_DIVERGENCE_LOW)return 0;
  if(divergence>=AUTO_DIVERGENCE_HIGH)return 1;
  return(divergence-AUTO_DIVERGENCE_LOW)/(AUTO_DIVERGENCE_HIGH-AUTO_DIVERGENCE_LOW);
}
export function projectPlatformSegment(platformSpendMap,platformFreshness,{start,end,today,totalDays,forecastModel,platformDowIndex}){
  let platformProjectedSum=0;
  // See PROJECTION NOTE above — platforms whose projection here was extrapolated from a single
  // day of data across a multi-day period get flagged so the UI can warn instead of silently
  // trusting a wildly inflated number.
  const lowConfidencePlatforms=[];
  const trailingMatch=/^trailing(\d+)$/.exec(forecastModel||"");
  const trailingDays=trailingMatch?parseInt(trailingMatch[1],10):null;
  // Anything that isn't a recognized Manual (trailingN), the legacy "full-period" literal, or
  // "committed" gets Auto — which includes the explicit "auto" string, undefined (every
  // computeCustomGrouping call), and any unrecognized future value, so this fails toward the
  // better default rather than silently reverting to flat full-period math.
  const isAuto=!trailingDays&&forecastModel!=="full-period"&&forecastModel!=="committed";
  Object.entries(platformSpendMap||{}).forEach(([platform,pData])=>{
    const byDate=pData?.byDate||{};
    const dowIdx=platformDowIndex?.[platform]||DEFAULT_DOW_INDEX;
    const freshest=platformFreshness[platform];
    let asOf=freshest&&freshest<today?freshest:today;
    if(asOf>end)asOf=end;
    const pElapsedDays=asOf<start?0:Math.min(totalDays,Math.floor((asOf-start)/86400000)+1);
    if(pElapsedDays>0){
      let typicalDayRate;
      if(isAuto){
        // Blend the full-period ("long-run") deseasonalized rate with a short recent window,
        // weighted by how much they've diverged (computeAutoBlendWeight). Barely any history yet
        // (pElapsedDays<=AUTO_SHORT_WINDOW) skips the blend entirely — a "recent window" isn't
        // meaningfully different from "everything so far" yet, so there's nothing to weigh.
        const longRate=deseasonalizedRate(byDate,dowIdx,asOf,pElapsedDays);
        if(pElapsedDays>AUTO_SHORT_WINDOW){
          const shortRate=deseasonalizedRate(byDate,dowIdx,asOf,AUTO_SHORT_WINDOW);
          const weight=computeAutoBlendWeight(longRate,shortRate);
          typicalDayRate=longRate+(shortRate-longRate)*weight;
        }else{
          typicalDayRate=longRate;
        }
      }else{
        // Manual (trailingN) or legacy full-period — one flat window, no blending. Window is
        // clamped to min(trailingDays,pElapsedDays) so a segment only a few days into its period
        // ramps up gracefully instead of needing N full days of history before producing a number.
        const window=trailingDays?Math.min(trailingDays,pElapsedDays):pElapsedDays;
        typicalDayRate=deseasonalizedRate(byDate,dowIdx,asOf,window);
      }
      let periodDowSum=0;
      for(let d=new Date(start);d<=end;d=new Date(d.getTime()+86400000)){
        periodDowSum+=dowIdx[d.getDay()]||1;
      }
      platformProjectedSum+=typicalDayRate*periodDowSum;
    }
    if(pElapsedDays===1&&totalDays>1)lowConfidencePlatforms.push(platform);
  });
  return{projectedSum:platformProjectedSum,dailyRate:totalDays?platformProjectedSum/totalDays:0,lowConfidencePlatforms};
}

// Resolves a single dimension's value for a spend row — "Platform" is derived per row (not a
// manual tag), everything else comes from that campaign's tags. Shared by computePacing,
// computeCustomGrouping, and their breakdown counterparts so "Platform" behaves identically
// wherever it's used as a grouping or breakdown dimension.
export function resolveDimValue(row,rowTags,dim){
  return dim==="Platform"?derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type):(rowTags[dim]||"");
}

// Capacity-vs-budget signal (added 2026-07-25, per Mo — the other half of "why is this segment
// behind pace," alongside the day-of-week work above). Nothing before this distinguished "behind
// pace because nobody raised the budget/bids" from "behind pace because the campaign(s)
// structurally can't spend more" (audience size, frequency cap, or the ad platform's own bid/
// approval limits capping delivery) — a budget-headroom number alone can't tell those apart, but
// `spend_rows`' impressions column (already collected, never used until now) can: if a segment's
// impressions have been flat for a couple weeks despite real budget headroom, more budget alone
// won't fix it, because delivery has hit some ceiling that has nothing to do with the dollar
// amount. Requires BOTH spend AND impressions to be flat — impressions flat while spend keeps
// climbing (or vice versa) usually just means costs changed (CPM/CPC drift, bid strategy), not a
// delivery ceiling, so this only ever looks at impressions, not spend, to make that call.
//
// Heuristic, not a hard verdict — returns:
//   "constrained" — genuinely behind pace, has budget headroom, AND impressions haven't grown
//                   meaningfully over the last two comparable windows. Worth a human look.
//   "growing"     — behind pace with headroom, but impressions ARE still climbing — give it time,
//                   don't necessarily push more budget/bids at it yet.
//   null          — not enough signal either way: not behind pace, no headroom, or too little
//                   impressions history yet to compare two windows.
//
// Known limitation: only counts CALENDAR DAYS THAT HAVE AT LEAST ONE ROW as part of the window, so
// a campaign paused for a few days (zero rows, not zero-valued rows) silently shrinks the window
// rather than counting as a real dip — reasonable for a v1 heuristic, not a claim of precision.
export const CAPACITY_MIN_DAYS=10; // need at least this many distinct days of impressions history total
export const CAPACITY_WINDOW=7; // compare the last N days against the N days before that
export const CAPACITY_GROWTH_THRESHOLD=0.15; // impressions must grow at least 15% to count as "still growing"
export function detectCapacitySignal(dailyMap,{expectedPct,actualPct,budget,spend}){
  if(!(budget>0)||spend>=budget)return null; // no headroom left to even ask the question
  if(actualPct==null)return null;
  // Mirrors computePacing's own "behind" threshold (delta<-0.1) — only worth asking this question
  // when the segment is actually reading as behind pace, not just slightly under expected.
  if(actualPct-expectedPct>=-0.1)return null;
  const dates=Object.keys(dailyMap||{}).sort();
  if(dates.length<CAPACITY_MIN_DAYS)return null;
  const recent=dates.slice(-CAPACITY_WINDOW);
  const prior=dates.slice(-CAPACITY_WINDOW*2,-CAPACITY_WINDOW);
  if(prior.length<Math.floor(CAPACITY_WINDOW/2))return null; // not enough of a "before" window to compare against
  const avgImpr=days=>days.length?days.reduce((s,d)=>s+(dailyMap[d].impressions||0),0)/days.length:0;
  const recentImpr=avgImpr(recent);
  const priorImpr=avgImpr(prior);
  if(priorImpr<=0)return null; // can't compute meaningful growth off a zero base
  return(recentImpr-priorImpr)/priorImpr<CAPACITY_GROWTH_THRESHOLD?"constrained":"growing";
}

// defaultForecastModel (optional, 2026-07-25) — the workspace-wide fallback set via
// PacingDashboard's global model selector (see BudgetHQ's own defaultForecastModel state/prop
// threading). A row's own budgetRowMeta[sk]._forecastModel, when present, always wins over this —
// see the fallback chain below, same priority order as the legacy _committed key. Every caller
// that doesn't have this value handy (report builders, AI tools called from contexts that never
// threaded it through) can simply omit it; it defaults to "auto" (2026-07-25, was "full-period"
// before the Auto/Manual/Committed redesign — see FORECAST_MODELS above), so an un-updated caller
// now gets the better adaptive default instead of the old always-cumulative one.
export function computePacing({mergedNormRows,tags,budgetDims,budgets,year,periodType,month,quarter,today,budgetRowMeta,defaultForecastModel}){
  const{start,end,months}=getPeriodRange(periodType,year,month,quarter);
  const totalDays=Math.round((end-start)/86400000)+1;
  let elapsedDays;
  if(today<start)elapsedDays=0;
  else if(today>end)elapsedDays=totalDays;
  else elapsedDays=Math.floor((today-start)/86400000)+1;
  const daysRemaining=Math.max(0,totalDays-elapsedDays);
  const expectedPct=totalDays?elapsedDays/totalDays:0;
  const platformFreshness=computePlatformFreshness(mergedNormRows);
  const platformDowIndex=computePlatformDayOfWeekIndex(mergedNormRows);

  const spendMap={};
  // {segKey: {platform: {total, byDate: {"YYYY-MM-DD": spend}}}} — feeds the per-platform
  // projection. byDate exists so projectPlatformSegment can compute a trailing-window average
  // (not just the full-period-to-date one) when a segment's forecastModel asks for it — see that
  // function's doc comment.
  const platformSpendMap={};
  // {segKey: {"YYYY-MM-DD": {spend, impressions}}} — segment-level (summed across every platform,
  // unlike platformSpendMap above which stays split by platform), used only by
  // detectCapacitySignal below to compare recent-vs-prior spend/impressions trends. Capacity is a
  // read on "can this segment's total delivery grow at all," not a per-platform question, so it
  // doesn't need platformSpendMap's per-platform split.
  const segDailyMap={};
  // Independent of the period/date range — how many campaigns exist for each segment at all. If
  // this is 0 for a segment that has a budget, spend will NEVER show up for it no matter what
  // period you're looking at — it's a tagging/dimension mismatch, not "no spend yet".
  const campaignCountMap={};
  if(budgetDims.length){
    // Every campaign that's ever had spend data, not just ones with an entry in `tags` — a
    // budgetDims of just ["Platform"] resolves entirely from derived data (resolveDimValue),
    // needing zero manual tagging, so membership can't depend on the campaign already existing
    // as a tags key the way pure tag-dimension budgeting implicitly could.
    const seenCampaigns=new Set();
    mergedNormRows.forEach(row=>{
      const key=campaignKey(row.campaign_group_name,row.campaign_name);
      if(seenCampaigns.has(key))return;
      seenCampaigns.add(key);
      const rowTags=tags[key]||{};
      const vals=budgetDims.map(dim=>resolveDimValue(row,rowTags,dim));
      if(vals.some(v=>!v))return;
      const sk=vals.join("|");
      campaignCountMap[sk]=(campaignCountMap[sk]||0)+1;
    });
    mergedNormRows.forEach(row=>{
      const d=parseSpendDate(row.date);
      if(!d||d<start||d>end)return;
      const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
      const vals=budgetDims.map(dim=>resolveDimValue(row,rowTags,dim));
      if(vals.some(v=>!v))return;
      const sk=vals.join("|");
      spendMap[sk]=(spendMap[sk]||0)+row.spend;
      const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
      if(!platformSpendMap[sk])platformSpendMap[sk]={};
      if(!platformSpendMap[sk][platform])platformSpendMap[sk][platform]={total:0,byDate:{}};
      platformSpendMap[sk][platform].total+=row.spend;
      const dateKey=localISODate(d);
      platformSpendMap[sk][platform].byDate[dateKey]=(platformSpendMap[sk][platform].byDate[dateKey]||0)+row.spend;
      if(!segDailyMap[sk])segDailyMap[sk]={};
      if(!segDailyMap[sk][dateKey])segDailyMap[sk][dateKey]={spend:0,impressions:0};
      segDailyMap[sk][dateKey].spend+=row.spend;
      segDailyMap[sk][dateKey].impressions+=row.impressions||0;
    });
  }

  const yearBudgets=budgets[year]||{};
  const segKeys=new Set([...Object.keys(yearBudgets),...Object.keys(spendMap)]);

  const segments=[...segKeys].map(sk=>{
    const monthly=yearBudgets[sk]?.monthly||{};
    const budget=months.reduce((s,mk)=>s+(monthly[mk]||0),0);
    const spend=spendMap[sk]||0;
    const dims=sk.split("|");
    // Whether ANY spend row actually matched this segment in this period — distinct from spend===0,
    // which is also true for a segment nobody's synced data for yet. Without this, a never-synced
    // segment's actualPct computes as a real 0%, which then reads as a genuine "behind pace" delta.
    const hasData=!!platformSpendMap[sk];
    const actualPct=budget>0&&hasData?spend/budget:null;
    // Per-segment forecast model (Auto, Committed lump-sum, or Manual trailing-N-day average) —
    // flagged per budget line (same _-prefixed-key-in-budgetRowMeta pattern as _notBudgeted, set
    // via PacingDashboard's per-row model picker) rather than inferred from spend shape, since
    // "this is a lump sum" / "I want a specific window" is knowledge the user has that the data
    // itself can't reveal. Priority: an explicit per-row override always wins, then the legacy
    // `_committed` boolean (segments toggled on before multi-model shipped), then the workspace's
    // global default (see defaultForecastModel above), then "auto" as the last-resort default if
    // nothing is set anywhere. See item 45 in ROADMAP.md.
    const rowMeta=budgetRowMeta?.[sk]||{};
    const forecastModel=rowMeta._forecastModel||(rowMeta._committed?"committed":(defaultForecastModel||"auto"));
    const committed=forecastModel==="committed";

    // Sum each platform's own projection rather than one blended rate — see PROJECTION NOTE.
    const{projectedSum,dailyRate,lowConfidencePlatforms}=projectPlatformSegment(platformSpendMap[sk],platformFreshness,{start,end,today,totalDays,forecastModel,platformDowIndex});
    // Committed rows skip the run-rate extrapolation entirely — projected is just the committed
    // amount (budget), or actual spend if that's already higher (an overspend is still real even
    // on a committed line). Everything else (full-period or trailing-N) uses whatever daily rate
    // projectPlatformSegment computed for that model.
    const projected=committed?Math.max(spend,budget):(elapsedDays>0&&hasData?projectedSum:null);
    const projectedVariance=budget>0&&projected!=null?projected-budget:null;
    let status="no-budget";
    if(budget>0){
      if(spend>budget)status="over";
      else if(committed)status="committed";
      else if(!hasData)status="no-data";
      else{
        const delta=(actualPct??0)-expectedPct;
        if(delta>0.1)status="ahead";
        else if(delta<-0.1)status="behind";
        else status="on-track";
      }
    }
    // See detectCapacitySignal's doc comment — only meaningful (non-null) when the segment is
    // actually behind pace with real budget headroom left; committed rows never get flagged since
    // they don't pace against a daily rate at all.
    const capacitySignal=committed?null:detectCapacitySignal(segDailyMap[sk],{expectedPct,actualPct,budget,spend});
    return{segKey:sk,dims,budget,spend,actualPct,dailyRate:hasData?dailyRate:null,projected,projectedVariance,status,matchCount:campaignCountMap[sk]||0,lowConfidencePlatforms,hasData,committed,forecastModel,capacitySignal};
  }).filter(s=>s.budget>0||s.spend>0).sort((a,b)=>b.spend-a.spend);

  const totals=segments.reduce((acc,s)=>({budget:acc.budget+s.budget,spend:acc.spend+s.spend}),{budget:0,spend:0});
  return{segments,totals,totalDays,elapsedDays,daysRemaining,expectedPct,start,end,platformFreshness};
}

// Steps a {periodType,year,month,quarter} tuple back exactly one period of that same granularity —
// e.g. monthly Jan'26 → Dec'25, quarterly Q1'26 → Q4'25, annual 2026 → 2025. Shared by the
// Dashboard's period-over-period comparison (one step back) and its trend chart (repeated stepping
// to build a trailing window) — both need the exact same "what's the previous period" logic, and
// getting the year-rollover cases right in two places would be an easy way to drift out of sync.
export function stepPeriodBack({periodType,year,month,quarter}){
  if(periodType==="monthly"){
    let y=parseInt(year,10),m=parseInt(month,10)-1;
    if(m<1){m=12;y-=1;}
    return{year:String(y),month:String(m).padStart(2,"0"),quarter:null};
  }
  if(periodType==="quarterly"){
    let y=parseInt(year,10),qn=parseInt(quarter.slice(1),10)-1;
    if(qn<1){qn=4;y-=1;}
    return{year:String(y),month:null,quarter:`Q${qn}`};
  }
  return{year:String(parseInt(year,10)-1),month:null,quarter:null};
}

// "View by" alternate to computePacing — groups spend by an arbitrary, user-chosen combination of
// dimensions (any tag dimension, plus the derived "Platform" pseudo-dimension) instead of the
// fixed budgetDims combo Budget Panel happens to be set up with. No Budget/Pacing/Status here —
// budgets in this app are only ever entered against a budgetDims combo, so there's nothing to
// compare an arbitrary grouping like "just Platform" against; this returns Spend/Daily Burn/
// Projected only, using the exact same per-platform freshness projection as computePacing.
export function computeCustomGrouping({mergedNormRows,tags,dims,year,periodType,month,quarter,today}){
  const{start,end}=getPeriodRange(periodType,year,month,quarter);
  const totalDays=Math.round((end-start)/86400000)+1;
  let elapsedDays;
  if(today<start)elapsedDays=0;
  else if(today>end)elapsedDays=totalDays;
  else elapsedDays=Math.floor((today-start)/86400000)+1;
  const daysRemaining=Math.max(0,totalDays-elapsedDays);
  const expectedPct=totalDays?elapsedDays/totalDays:0;
  const platformFreshness=computePlatformFreshness(mergedNormRows);
  const platformDowIndex=computePlatformDayOfWeekIndex(mergedNormRows);

  const spendMap={};
  const platformSpendMap={};
  const campaignSetMap={};
  if(dims.length){
    mergedNormRows.forEach(row=>{
      const d=parseSpendDate(row.date);
      if(!d||d<start||d>end)return;
      const ck=campaignKey(row.campaign_group_name,row.campaign_name);
      const rowTags=tags[ck]||{};
      const vals=dims.map(dim=>resolveDimValue(row,rowTags,dim));
      if(vals.some(v=>!v))return; // same convention as budget segments — every chosen dim must be present
      const sk=vals.join("|");
      spendMap[sk]=(spendMap[sk]||0)+row.spend;
      const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
      if(!platformSpendMap[sk])platformSpendMap[sk]={};
      if(!platformSpendMap[sk][platform])platformSpendMap[sk][platform]={total:0,byDate:{}};
      platformSpendMap[sk][platform].total+=row.spend;
      const dateKey=localISODate(d);
      platformSpendMap[sk][platform].byDate[dateKey]=(platformSpendMap[sk][platform].byDate[dateKey]||0)+row.spend;
      if(!campaignSetMap[sk])campaignSetMap[sk]=new Set();
      campaignSetMap[sk].add(ck);
    });
  }

  const segments=Object.keys(spendMap).map(sk=>{
    const spend=spendMap[sk];
    const{projectedSum,dailyRate,lowConfidencePlatforms}=projectPlatformSegment(platformSpendMap[sk],platformFreshness,{start,end,today,totalDays,platformDowIndex});
    const projected=elapsedDays>0?projectedSum:null;
    return{segKey:sk,dims:sk.split("|"),spend,dailyRate,projected,lowConfidencePlatforms,campaignCount:campaignSetMap[sk]?.size||0};
  }).sort((a,b)=>b.spend-a.spend);

  const totals=segments.reduce((acc,s)=>({spend:acc.spend+s.spend}),{spend:0});
  return{segments,totals,totalDays,elapsedDays,daysRemaining,expectedPct,start,end,platformFreshness,dims};
}

// Expand-row breakdown for computeCustomGrouping, mirroring computeSpendBreakdown but matching
// against an arbitrary dims array (via resolveDimValue) instead of the fixed budgetDims.
export function computeCustomBreakdown({mergedNormRows,tags,dims,segKey,breakdownDim,start,end}){
  const vals=segKey.split("|");
  const map={};
  mergedNormRows.forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d||d<start||d>end)return;
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    if(!dims.every((dim,i)=>resolveDimValue(row,rowTags,dim)===vals[i]))return;
    const bval=resolveDimValue(row,rowTags,breakdownDim)||"Untagged";
    map[bval]=(map[bval]||0)+row.spend;
  });
  const total=Object.values(map).reduce((s,v)=>s+v,0);
  return Object.entries(map).map(([value,spend])=>({value,spend,pct:total>0?spend/total:0})).sort((a,b)=>b.spend-a.spend);
}

// Powers Reporting & Pacing's "Trend" view — the one gap computePacing/computeCustomGrouping
// don't cover: both of those answer "how much for ONE period", never "how did this change over
// several months." Buckets spend into calendar months across [start,end], optionally narrowed to
// rows whose `filterDim` value contains `filterValue` (a plain substring match, same convention
// as every other filter input in this table — e.g. filterDim="Tag: Segment", filterValue="ISW
// Branded Search"), then splits each month's total into a series per `seriesDim` value (typically
// "Platform", to get one line per channel). seriesDim is optional — pass "" to get one combined
// "Spend" series with no split.
export function computeMonthlyTrend({mergedNormRows,tags,filterDim,filterValue,seriesDim,start,end}){
  const months=[];
  let cur=new Date(start.getFullYear(),start.getMonth(),1);
  const last=new Date(end.getFullYear(),end.getMonth(),1);
  while(cur<=last){
    months.push({key:`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,"0")}`,label:cur.toLocaleDateString("en-US",{month:"short",year:"2-digit"})});
    cur=new Date(cur.getFullYear(),cur.getMonth()+1,1);
  }
  const monthIndex=Object.fromEntries(months.map((m,i)=>[m.key,i]));
  const seriesMap={};
  const fv=(filterValue||"").trim().toLowerCase();
  (mergedNormRows||[]).forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d)return;
    const mk=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    const mi=monthIndex[mk];
    if(mi==null)return; // outside the selected range
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    if(filterDim&&fv){
      const val=(resolveDimValue(row,rowTags,filterDim)||"").toLowerCase();
      if(!val.includes(fv))return;
    }
    const bval=seriesDim?(resolveDimValue(row,rowTags,seriesDim)||"Untagged"):"Spend";
    if(!seriesMap[bval])seriesMap[bval]=new Array(months.length).fill(0);
    seriesMap[bval][mi]+=row.spend||0;
  });
  const series=Object.entries(seriesMap)
    .map(([label,values])=>({label,values,total:values.reduce((s,v)=>s+v,0)}))
    .sort((a,b)=>b.total-a.total);
  const monthTotals=months.map((_,i)=>series.reduce((s,ser)=>s+ser.values[i],0));
  return{months,series,monthTotals,grandTotal:monthTotals.reduce((s,v)=>s+v,0)};
}

export function pacingStatusMeta(status,T){
  switch(status){
    case"over":return{label:"Over budget",color:T.danger,bg:T.dangerBg,border:T.dangerBorder};
    case"ahead":return{label:"Ahead of pace",color:T.warning,bg:T.warningBg,border:T.warningBorder};
    case"behind":return{label:"Behind pace",color:T.accent,bg:T.accentBg,border:T.accentBorder};
    case"on-track":return{label:"On track",color:T.success,bg:T.successBg,border:T.successBorder};
    // Committed (lump-sum/prepaid) budget lines are deliberately excluded from pace comparisons —
    // see computePacing's `committed` handling — so this reads as a neutral "known, accounted for"
    // state rather than a pace verdict, distinct from both the warning colors above and the flatter
    // "no-data"/"no-budget" gray below (this segment DOES have a budget and a real reason not to
    // pace it, not an absence of information).
    case"committed":return{label:"Committed spend",color:T.textSub,bg:T.surfaceEl,border:T.border};
    // Distinct from "behind" on purpose — zero spend rows matched for this segment/period isn't the
    // same signal as "we have real spend data and it's genuinely trailing plan." Blending the two
    // made every never-synced segment look like an active problem (see 2026-07-19 UX review).
    case"no-data":return{label:"No data yet",color:T.textMuted,bg:T.surfaceEl,border:T.border};
    default:return{label:"No budget set",color:T.textMuted,bg:T.surfaceEl,border:T.border};
  }
}

export const fmtSigned=n=>n==null?"—":(n>0?"+":n<0?"−":"")+"$"+Math.round(Math.abs(n)).toLocaleString();
