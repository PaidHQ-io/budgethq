import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

// ─── DESIGN SYSTEM ────────────────────────────────────────────────────────────
// Cool-gray "Obsidian" palette (redesign, July 2026) — Mo asked to move away from the
// pixel/retro treatment back to a softer, rounded, conventional look, with a browser-tab
// style top nav using exact colors he picked: topbar #DCE0E9, body #F0F1F5, left column
// #E6E9F0, dividers #CED2DB. Gold (#FFC249) stays as the one accent color threaded through
// both themes. Dark theme has no reference and is an original counterpart, built by
// inverting these same structural roles (topbar/body/sidebar/divider) into dark grays.
const THEMES = {
  dark: {
    bg:"#14171E",surface:"#1E222B",surfaceEl:"#262B35",surfaceHover:"#2E333F",
    border:"#2A2E38",borderStrong:"#3A3F4C",
    text:"#EDEEF2",textSub:"#A8AEBB",textMuted:"#6B7180",textDim:"#2A2E38",
    accent:"#FFC249",accentHover:"#FFD375",
    accentBg:"rgba(255,194,73,0.14)",accentBorder:"rgba(255,194,73,0.3)",accentText:"#FFC249",
    success:"#5CBE86",successBg:"rgba(92,190,134,0.12)",successBorder:"rgba(92,190,134,0.28)",
    warning:"#E2953F",warningBg:"rgba(226,149,63,0.12)",warningBorder:"rgba(226,149,63,0.3)",
    danger:"#FF6259",dangerBg:"rgba(255,98,89,0.12)",dangerBorder:"rgba(255,98,89,0.3)",
    rowHover:"#262B35",rowSelected:"rgba(255,194,73,0.08)",
    inputBg:"#1E222B",headerBg:"#191C24",sidebarBg:"#181B23",topbarBg:"#20242E",
    logo:"#FFC249",pill:"#262B35",pillBorder:"#2A2E38",railDivider:"#2A2E38",
    badgeColors:["#FF6259","#8C6FFF","#FFC249","#B08D4F"],
    heroGradient:"linear-gradient(135deg,#C24A78 0%,#2E7D6B 100%)",
    shadow:"0 1px 2px rgba(0,0,0,0.4)",
    shadowMd:"0 8px 24px rgba(0,0,0,0.45),0 2px 8px rgba(0,0,0,0.3)",
    shadowLg:"0 16px 48px rgba(0,0,0,0.55),0 4px 16px rgba(0,0,0,0.35)",
  },
  light: {
    bg:"#F0F1F5",surface:"#FFFFFF",surfaceEl:"#F7F8FA",surfaceHover:"#ECEEF2",
    border:"#CED2DB",borderStrong:"#B7BCC8",
    text:"#1E222A",textSub:"#5B6272",textMuted:"#8A90A0",textDim:"#CED2DB",
    accent:"#FFC249",accentHover:"#F0AC2B",
    accentBg:"rgba(255,194,73,0.16)",accentBorder:"rgba(255,194,73,0.35)",accentText:"#8A5F00",
    success:"#2F8F5B",successBg:"rgba(47,143,91,0.1)",successBorder:"rgba(47,143,91,0.25)",
    warning:"#C2721F",warningBg:"rgba(194,114,31,0.1)",warningBorder:"rgba(194,114,31,0.28)",
    danger:"#FD4438",dangerBg:"rgba(253,68,56,0.1)",dangerBorder:"rgba(253,68,56,0.28)",
    rowHover:"#F7F8FA",rowSelected:"rgba(255,194,73,0.1)",
    inputBg:"#FFFFFF",headerBg:"#F7F8FA",sidebarBg:"#E6E9F0",topbarBg:"#DCE0E9",
    logo:"#FFC249",pill:"#F7F8FA",pillBorder:"#CED2DB",railDivider:"#CED2DB",
    badgeColors:["#FD4438","#4807EA","#FFC249","#452F01"],
    heroGradient:"linear-gradient(135deg,#E8749A 0%,#5FBFA6 100%)",
    shadow:"0 1px 3px rgba(30,34,42,0.06)",
    shadowMd:"0 10px 30px rgba(30,34,42,0.08),0 2px 8px rgba(30,34,42,0.04)",
    shadowLg:"0 20px 56px rgba(30,34,42,0.12),0 6px 18px rgba(30,34,42,0.06)",
  },
};

const MONTHS=[{key:"01",label:"Jan"},{key:"02",label:"Feb"},{key:"03",label:"Mar"},{key:"04",label:"Apr"},{key:"05",label:"May"},{key:"06",label:"Jun"},{key:"07",label:"Jul"},{key:"08",label:"Aug"},{key:"09",label:"Sep"},{key:"10",label:"Oct"},{key:"11",label:"Nov"},{key:"12",label:"Dec"}];
const QUARTERS=[{key:"Q1",months:["01","02","03"],label:"Q1 Cap"},{key:"Q2",months:["04","05","06"],label:"Q2 Cap"},{key:"Q3",months:["07","08","09"],label:"Q3 Cap"},{key:"Q4",months:["10","11","12"],label:"Q4 Cap"}];
const MONTH_MAP={jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",january:"01",february:"02",march:"03",april:"04",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"};
// Two-level campaign hierarchy: "campaign_group_name" is the top level (LinkedIn's own
// "Campaign Group"; what Meta/Google/Bing/Reddit simply call "Campaign"). "campaign_name" is
// the leaf level actually being tagged (LinkedIn's own "Campaign" object; Meta/Reddit's
// "Ad Set"; Google/Bing's "Ad Group"). Only campaign_group_name is required — campaign_name
// falls back to it for platforms/exports that don't have a second level of breakdown, so
// nothing breaks for data that predates this two-level model.
const REQUIRED_COLS=["campaign_group_name","spend","date"];
const OPTIONAL_COLS=["campaign_name","platform","campaign_type","impressions","clicks","campaign_id","adset_id"];
// campaign_type: the platform's own authoritative type field (Google Ads' "Campaign type" column
// — Search/Display/Demand Gen/Performance Max/Video) when the export has one. This is trusted
// over name-based guessing in derivePlatform() below, since naming conventions are ambiguous —
// e.g. Google's Demand Gen campaigns are frequently still named with a legacy "GDN-" prefix
// (carried over from before Display/Discovery rolled into Demand Gen) with no text in the name
// that distinguishes them from real Display campaigns.
const COL_PATTERNS={campaign_group_name:/campaign.?group/i,campaign_name:/ad.?set|ad.?group/i,spend:/cost|spend|amount/i,date:/^date$|^day$/i,platform:/platform|traffic.source|channel|source/i,campaign_type:/campaign.?type/i,impressions:/impression/i,clicks:/^clicks?$/i,campaign_id:/campaign.*id/i,adset_id:/ad.?set.*id|ad.?group.*id/i};
const COL_LABELS={campaign_group_name:"Campaign Group Name",campaign_name:"Campaign Name (Ad Set / Ad Group)",spend:"Spend / Cost",date:"Date",platform:"Platform / Traffic Source",campaign_type:"Campaign Type (Search/Display/Demand Gen)",impressions:"Impressions",clicks:"Clicks",campaign_id:"Campaign ID",adset_id:"Ad Set ID"};
// Composite identity key — ad set / ad group names often repeat across different campaigns
// (e.g. two campaigns both have a "Retargeting" ad set), so tagging and dedup identity must
// combine both levels, not just the leaf name alone.
const campaignKey=(groupName,name)=>`${groupName||name||""}||${name||groupName||""}`;
const DEFAULT_DIMS=["Product","Region","Funnel","Pillar"];
const PLATFORM_COLORS={LinkedIn:"#0a66c2","Google Search":"#4285f4","Google Display":"#34a853","Demand Gen":"#f59e0b","Performance Max":"#ef4444",Meta:"#1877f2",Bing:"#00809d",YouTube:"#ff0000",Capterra:"#ff6d2d",Unknown:"#9B9A92"};
const NAV=[{key:"dashboard",label:"Dashboard",icon:"bolt"},{key:"tagger",label:"Campaign Tagger",icon:"tag"},{key:"budget",label:"Budget Panel",icon:"wallet"},{key:"pacing",label:"Reporting & Pacing",icon:"chart"}];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function autoDetect(h){
  const m={};
  h.forEach(c=>{for(const[f,p]of Object.entries(COL_PATTERNS)){if(!m[f]&&p.test(c.trim()))m[f]=c;}});
  // A bare "Campaign" header is ambiguous: for Meta/Google/Bing/Reddit it IS the campaign group
  // (handled by the fallback below), but when a dedicated "Campaign Group" column was already
  // found above (LinkedIn's export shape), "Campaign" is LinkedIn's own Campaign object — i.e.
  // our leaf-level campaign_name — not the group.
  if(!m.campaign_name){const c=h.find(c=>/^campaign$/i.test(c.trim()));if(c&&m.campaign_group_name)m.campaign_name=c;}
  if(!m.campaign_group_name){const c=h.find(c=>/campaign/i.test(c)&&!/id|group|type/i.test(c));if(c)m.campaign_group_name=c;}
  if(!m.spend){const c=h.find(c=>/cost|spend/i.test(c));if(c)m.spend=c;}
  if(!m.date){const c=h.find(c=>/date|day/i.test(c));if(c)m.date=c;}
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
function derivePlatform(groupName,name,pv,campaignType){
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
const parseMoney=v=>{if(v===""||v==null)return null;const n=parseFloat(String(v).replace(/[$,\s%]/g,""));return isNaN(n)?null:n;};
const fmt$=n=>{if(!n)return"";return"$"+Math.round(n).toLocaleString();};
const fmtFull=n=>n?"$"+Math.round(n).toLocaleString():"—";
const isMonthHdr=c=>{const x=c.trim().toLowerCase().replace(/\s+\d{4}$/,"");return!!MONTH_MAP[x];};
const getMonthKey=c=>{const x=c.trim().toLowerCase().replace(/\s+\d{4}$/,"");return MONTH_MAP[x]||null;};
function parsePeriod(val){if(!val)return null;const s=String(val).trim();let m=s.match(/^(\d{4})-(\d{2})$/);if(m)return m[2];m=s.match(/^(\d{1,2})\/(\d{4})$/);if(m)return String(m[1]).padStart(2,"0");const l=s.toLowerCase().replace(/[,\s]+/g," ");for(const[n,k]of Object.entries(MONTH_MAP)){if(l.startsWith(n))return k;}return null;}

// Parse any file (CSV or Excel) to array of arrays
function parseFileToRows(file,callback){
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
function forwardFillGroups(row){
  let last="";
  return row.map(v=>{const s=String(v||"").trim();if(s&&!/^(channel|group|category|platform)$/i.test(s))last=s;return last;});
}

// Download helper
function downloadCSV(rows, filename){
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
const VERSIONS_DB_NAME="paidhq_versions";
const VERSIONS_STORE_NAME="versions";
const MAX_VERSIONS=40;

function openVersionsDB(){
  return new Promise((resolve,reject)=>{
    if(typeof indexedDB==="undefined"){reject(new Error("IndexedDB not available"));return;}
    const req=indexedDB.open(VERSIONS_DB_NAME,1);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(VERSIONS_STORE_NAME)){
        const store=db.createObjectStore(VERSIONS_STORE_NAME,{keyPath:"id"});
        store.createIndex("timestamp","timestamp");
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}

async function saveVersionRecord(record){
  const db=await openVersionsDB();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(VERSIONS_STORE_NAME,"readwrite");
    tx.objectStore(VERSIONS_STORE_NAME).put(record);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
  // Prune anything beyond the cap, oldest first, so storage doesn't grow unbounded across a
  // long-lived instance.
  const all=await listVersionRecords();
  if(all.length>MAX_VERSIONS){
    const toDelete=all.slice(MAX_VERSIONS);
    const db2=await openVersionsDB();
    const tx2=db2.transaction(VERSIONS_STORE_NAME,"readwrite");
    toDelete.forEach(v=>tx2.objectStore(VERSIONS_STORE_NAME).delete(v.id));
  }
}

function listVersionRecords(){
  return openVersionsDB().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction(VERSIONS_STORE_NAME,"readonly");
    const req=tx.objectStore(VERSIONS_STORE_NAME).getAll();
    req.onsuccess=()=>resolve((req.result||[]).sort((a,b)=>b.timestamp-a.timestamp));
    req.onerror=()=>reject(req.error);
  }));
}

function deleteVersionRecord(id){
  return openVersionsDB().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction(VERSIONS_STORE_NAME,"readwrite");
    tx.objectStore(VERSIONS_STORE_NAME).delete(id);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  }));
}

// Groups version records into "Today" / "Yesterday" / weekday-or-date buckets, same convention
// Google Sheets' version history panel uses, so the list reads as a scannable timeline instead
// of a flat log of timestamps.
function groupVersionsByDay(versions){
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

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────
const SectionLabel=({children,T,style={}})=>(<div style={{fontSize:10,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted,marginBottom:6,...style}}>{children}</div>);
const Pill=({children,color,bg,border,style,...rest})=>(<span style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:500,padding:"2px 9px",borderRadius:20,background:bg,color,border:`1px solid ${border}`,whiteSpace:"nowrap",...style}} {...rest}>{children}</span>);
// Soft rounded button — back to a conventional subtle-border, light-shadow style
// (moved away from the pixel/retro hard-shadow treatment).
const Btn=({children,onClick,variant="ghost",size="sm",disabled,T,style={}})=>{
  const s={sm:{padding:"6px 14px",fontSize:12},md:{padding:"8px 18px",fontSize:13},lg:{padding:"10px 24px",fontSize:14}};
  const v={primary:{background:T.accent,color:T.text,border:`1px solid ${T.accentHover}`},ghost:{background:T.surface,color:T.text,border:`1px solid ${T.border}`},subtle:{background:T.surfaceEl,color:T.text,border:`1px solid ${T.border}`},success:{background:T.successBg,color:T.success,border:`1px solid ${T.successBorder}`},danger:{background:T.dangerBg,color:T.danger,border:`1px solid ${T.dangerBorder}`}};
  return <button className="bhq-btn" disabled={disabled} onClick={disabled?undefined:onClick} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,borderRadius:8,cursor:disabled?"not-allowed":"pointer",fontWeight:600,transition:"all 0.12s",fontFamily:"Inter,sans-serif",boxShadow:disabled?"none":T.shadow,opacity:disabled?0.5:1,...s[size],...v[variant],...style}}>{children}</button>;
};
const Inp=({value,onChange,placeholder,T,style={},mono=false,onKeyDown})=>(<input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} onKeyDown={onKeyDown} style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:mono?"Inter,sans-serif":"Inter,sans-serif",width:"100%",transition:"border-color 0.12s",...style}}/>);
const Sel=({value,onChange,children,T,style={}})=>(<select value={value} onChange={e=>onChange(e.target.value)} style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:value?T.text:T.textMuted,padding:"6px 10px",fontSize:12,outline:"none",cursor:"pointer",fontFamily:"Inter,sans-serif",width:"100%",...style}}>{children}</select>);
// stopPropagation on both: several call sites wrap these in a parent <div> that has its own
// onClick doing the same toggle (for a bigger click target). Without stopping propagation here,
// clicking directly on the switch/checkbox fires both handlers and the toggle cancels itself out.
const Tog=({value,onChange,T})=>(<div onClick={e=>{e.stopPropagation();onChange(!value);}} style={{width:30,height:17,borderRadius:9,background:value?T.accent:T.borderStrong,position:"relative",cursor:"pointer",transition:"background 0.2s",flexShrink:0}}><div style={{position:"absolute",top:2,left:value?15:2,width:13,height:13,borderRadius:7,background:"#fff",transition:"left 0.18s",boxShadow:"0 1px 3px rgba(0,0,0,0.25)"}}/></div>);
const Chk=({checked,onChange,T})=>(<div onClick={e=>{e.stopPropagation();onChange();}} style={{width:15,height:15,borderRadius:4,border:`1.5px solid ${checked?T.accent:T.borderStrong}`,background:checked?T.accent:"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0,transition:"all 0.12s"}}>{checked&&<svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke={T.text} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}</div>);
const StatRow=({label,value,color,T})=>(<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0"}}><span style={{fontSize:12,color:T.textSub}}>{label}</span><span style={{fontSize:12,fontFamily:"Inter,sans-serif",fontWeight:600,color:color||T.text}}>{value}</span></div>);
const Divider=({T})=><div style={{height:1,background:T.border,margin:"12px 0"}}/>;
// Pixel-block icon set (retro redesign, July 2026) — replaces the flat line-icon set.
// Every glyph is built from a handful of solid squares, no curves/strokes, matching the
// notched-panel / hard-shadow "8-bit" surface language used everywhere a soft rounded
// shadow card used to be.
// Flat lined icons (Obsidian-style) — thin strokes, no fill, replacing the earlier
// pixel-block rect icons as part of moving the whole app back to a softer, conventional look.
const Icon=({name,size=18,color="currentColor"})=>{
  const p={width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke:color,strokeWidth:1.7,strokeLinecap:"round",strokeLinejoin:"round"};
  switch(name){
    case"bolt":return<svg {...p}><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1H10v-5a2 2 0 0 1 4 0v5h3.5a1 1 0 0 0 1-1v-9"/></svg>; // home — Dashboard
    case"tag":return<svg {...p}><path d="M3 11.5V5a1 1 0 0 1 1-1h6.5L21 13.5a1 1 0 0 1 0 1.4l-6.1 6.1a1 1 0 0 1-1.4 0L3 11.5Z"/><circle cx="8" cy="8" r="1.3" fill={color} stroke="none"/></svg>;
    case"wallet":return<svg {...p}><path d="M3 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1"/><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H6a2 2 0 0 1-2-2Z"/><path d="M16 13.2h2.2"/></svg>;
    case"chart":return<svg {...p}><path d="M4 20V13"/><path d="M10 20V9"/><path d="M16 20V5"/><path d="M3 20h18"/></svg>;
    case"export":return<svg {...p}><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>;
    case"sun":return<svg {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>;
    case"moon":return<svg {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>;
    case"alert":return<svg {...p}><path d="M12 3.5 21.5 20H2.5Z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17" r="0.6" fill={color} stroke="none"/></svg>;
    case"gear":return<svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.4 7.4 0 0 0 0-2l2-1.5-2-3.4-2.4.7a7.4 7.4 0 0 0-1.7-1L14.9 3h-3.8l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-.7-2 3.4L6.6 11a7.4 7.4 0 0 0 0 2l-2 1.5 2 3.4 2.4-.7a7.4 7.4 0 0 0 1.7 1l.4 2.4h3.8l.4-2.4a7.4 7.4 0 0 0 1.7-1l2.4.7 2-3.4-2-1.5Z"/></svg>;
    case"clock":return<svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>;
    case"save":return<svg {...p}><path d="M5 3h11l3 3v15H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M8 3v6h7V3"/><path d="M8 21v-7h8v7"/></svg>;
    case"dots":return<svg {...p}><circle cx="5" cy="12" r="1.6" fill={color} stroke="none"/><circle cx="12" cy="12" r="1.6" fill={color} stroke="none"/><circle cx="19" cy="12" r="1.6" fill={color} stroke="none"/></svg>;
    case"mail":return<svg {...p}><path d="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"/><path d="M3.5 7 12 13l8.5-6"/></svg>;
    case"download":return<svg {...p}><path d="M12 4v11"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>;
    default:return null;
  }
};
// Soft rounded card — replaces the earlier notched-corner / hard-offset-shadow "pixel
// panel" surface now that the app is moving back to a conventional, easier-to-read look.
// Kept the same component name and prop shape (notch/border/shadowOffset are accepted
// but no longer used) so the many existing call sites across the app didn't need to change.
const PixelPanel=({T,children,style={},contentStyle={},onClick})=>(
  <div onClick={onClick} style={{borderRadius:12,border:`1px solid ${T.border}`,background:T.surface,boxShadow:T.shadow,cursor:onClick?"pointer":undefined,...style,...contentStyle}}>
    {children}
  </div>
);

// Small hover tooltip for the warning-triangle icons scattered through the Budget/Reporting
// tables — replaces the native `title` attribute (invisible until a slow hover, unstyled)
// with a small styled callout box. Visibility is toggled by mutating the child's style
// directly on mouseenter/mouseleave, rather than adding per-row React state for 20+ rows.
const WarnTip=({T,text,size=12,color})=>(
  <span
    onMouseEnter={e=>{const t=e.currentTarget.querySelector("[data-tip]");if(t)t.style.opacity=1;}}
    onMouseLeave={e=>{const t=e.currentTarget.querySelector("[data-tip]");if(t)t.style.opacity=0;}}
    style={{marginLeft:6,display:"inline-flex",position:"relative",cursor:"help"}}>
    <Icon name="alert" size={size} color={color||T.warning}/>
    <span data-tip style={{position:"absolute",bottom:"140%",left:"50%",transform:"translateX(-50%)",opacity:0,pointerEvents:"none",transition:"opacity 0.1s",background:T.surface,color:T.text,fontSize:11,fontWeight:500,lineHeight:1.45,padding:"8px 10px",borderRadius:8,border:`1px solid ${T.border}`,boxShadow:T.shadowMd,width:220,whiteSpace:"normal",textAlign:"left",zIndex:50,fontFamily:"Inter,sans-serif"}}>
      {text}
    </span>
  </span>
);

// ─── BUDGET MANAGER ───────────────────────────────────────────────────────────
function BudgetManager({campaignTags,setTags,tagDimensions,T,onAddDimensions,budgets,setBudgets,budgetDims,setBudgetDims,budgetRowMeta,setBudgetRowMeta,budgetMetaDims,setBudgetMetaDims,budgetImportMeta,setBudgetImportMeta,mergedNormRows,onCheckpoint,sidebarEl}){
  const yr=new Date().getFullYear();
  const[year,setYear]=useState(yr.toString());
  const[showQ,setShowQ]=useState(false);
  const[showA,setShowA]=useState(false);
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
  const[preview,setPreview]=useState([]);
  const[customDims,setCustomDims]=useState([]); // [{name,col}] — new dims created during import
  const[aiAnalyzing,setAiAnalyzing]=useState(false);
  const[aiError,setAiError]=useState("");
  const fileRef=useRef();
  const years=[(yr-1).toString(),yr.toString(),(yr+1).toString()];

  const showNotif=msg=>{setNotif(msg);setTimeout(()=>setNotif(null),3000);};

  const[showAddRow,setShowAddRow]=useState(false);
  const[newRowVals,setNewRowVals]=useState({});

  const segMatchCount=useCallback(segKey=>{
    if(!budgetDims.length)return 0;
    return Object.values(campaignTags||{}).filter(t=>{
      const vals=budgetDims.map(d=>t[d]);
      return vals.every(v=>v)&&vals.join("|")===segKey;
    }).length;
  },[budgetDims,campaignTags]);

  const addManualRow=()=>{
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
    const pacing=computePacing({mergedNormRows:mergedNormRows||[],tags:campaignTags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date()});
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
    if(!applyMetaDim||!applyMetaVal||!selRows.size)return;
    setBudgetRowMeta(p=>{const nx={...p};selRows.forEach(k=>{nx[k]={...(nx[k]||{}),[applyMetaDim]:applyMetaVal};});return nx;});
    showNotif(`Tagged ${selRows.size} rows — ${applyMetaDim}: ${applyMetaVal}`);
    setSelRows(new Set());setApplyMetaVal("");
  };
  const saveMetaEdit=()=>{
    if(!editingMeta)return;
    const trimmed=editMetaVal.trim();
    setBudgetRowMeta(p=>{const nx={...p};const ts={...(nx[editingMeta.segKey]||{})};if(trimmed)ts[editingMeta.dim]=trimmed;else delete ts[editingMeta.dim];nx[editingMeta.segKey]=ts;return nx;});
    setEditingMeta(null);setEditMetaVal("");
  };
  const addMetaDim=()=>{
    const d=newMetaDim.trim();
    if(!d||budgetMetaDims.includes(d))return;
    setBudgetMetaDims(p=>[...p,d]);setNewMetaDim("");
    showNotif(`Added dimension: ${d}`);
  };

  const saveSegEdit=()=>{
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
    const matchCount=countSegmentCampaigns(campaignTags,budgetDims,segKey);
    const tagNote=matchCount>0?` This also un-tags ${matchCount} matching campaign${matchCount>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete "${label}"?\n\nThis removes all monthly budget values for this row.${tagNote}`))return;
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(nx[year])delete nx[year][segKey];return nx;});
    setBudgetRowMeta(p=>{const nx={...p};delete nx[segKey];return nx;});
    setTags?.(p=>untagSegmentCampaigns(p,budgetDims,segKey));
    setSelRows(p=>{const nx=new Set(p);nx.delete(segKey);return nx;});
    showNotif(matchCount>0?`Row deleted — un-tagged ${matchCount} campaign${matchCount>1?"s":""}`:"Row deleted");
  };
  const bulkDeleteSelected=()=>{
    if(!selRows.size)return;
    const n=selRows.size;
    const totalMatches=[...selRows].reduce((s,k)=>s+countSegmentCampaigns(campaignTags,budgetDims,k),0);
    const tagNote=totalMatches>0?` This also un-tags ${totalMatches} matching campaign${totalMatches>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete ${n} segment${n>1?"s":""}?\n\nThis removes all monthly budget values for ${n>1?"these rows":"this row"}.${tagNote}`))return;
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(nx[year])selRows.forEach(k=>{delete nx[year][k];});return nx;});
    setBudgetRowMeta(p=>{const nx={...p};selRows.forEach(k=>delete nx[k]);return nx;});
    setTags?.(p=>{let nt=p;selRows.forEach(k=>{nt=untagSegmentCampaigns(nt,budgetDims,k);});return nt;});
    showNotif(`Deleted ${n} segment${n>1?"s":""}${totalMatches>0?` — un-tagged ${totalMatches} campaign${totalMatches>1?"s":""}`:""}`);
    setSelRows(new Set());
  };

  const segs=useMemo(()=>{
    if(!budgetDims.length)return[];
    const seen=new Set();const out=[];
    // Source 1: tagged campaigns
    Object.entries(campaignTags||{}).forEach(([,tags])=>{
      const vals=budgetDims.map(d=>tags[d]);if(vals.some(v=>!v))return;
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
  },[budgetDims,campaignTags,budgets,year]);

  // Segments filtered by per-dimension substring match (ANDed) — drives what's visible,
  // what "select all" selects, and what a bulk delete targets. Covers both the primary
  // budgetDims (e.g. Product, stored on the segment itself) and any annotation dimensions
  // added as budgetMetaDims (e.g. Region, Pillar, Funnel — stored in budgetRowMeta per segment).
  const filteredSegs=useMemo(()=>segs.filter(seg=>{
    const meta=budgetRowMeta[seg.key]||{};
    return budgetDims.every(d=>{
      const f=(segFilters[d]||"").trim().toLowerCase();
      return!f||(seg[d]||"").toLowerCase().includes(f);
    })&&budgetMetaDims.every(d=>{
      const f=(segFilters[d]||"").trim().toLowerCase();
      return!f||(meta[d]||"").toLowerCase().includes(f);
    });
  }),[segs,budgetDims,budgetMetaDims,budgetRowMeta,segFilters]);
  const hasSegFilters=Object.values(segFilters).some(v=>(v||"").trim());
  const clearSegFilters=()=>setSegFilters({});

  const getMV=useCallback((sk,mk)=>budgets[year]?.[sk]?.monthly?.[mk]??"",[budgets,year]);
  const getQC=useCallback((sk,qk)=>budgets[year]?.[sk]?.quarterly?.[qk]??"",[budgets,year]);
  const getAC=useCallback(sk=>budgets[year]?.[sk]?.annual??"",[budgets,year]);
  const setMV=useCallback((sk,mk,v)=>{const n=parseMoney(v);setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][sk])nx[year][sk]={};if(!nx[year][sk].monthly)nx[year][sk].monthly={};if(n===null)delete nx[year][sk].monthly[mk];else nx[year][sk].monthly[mk]=n;return nx;});},[year]);
  const setQC=useCallback((sk,qk,v)=>{const n=parseMoney(v);setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][sk])nx[year][sk]={};if(!nx[year][sk].quarterly)nx[year][sk].quarterly={};if(n===null)delete nx[year][sk].quarterly[qk];else nx[year][sk].quarterly[qk]=n;return nx;});},[year]);
  const setAC=useCallback((sk,v)=>{const n=parseMoney(v);setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[year])nx[year]={};if(!nx[year][sk])nx[year][sk]={};if(n===null)delete nx[year][sk].annual;else nx[year][sk].annual=n;return nx;});},[year]);
  const rowTotal=useCallback(sk=>Object.values(budgets[year]?.[sk]?.monthly||{}).reduce((s,v)=>s+(v||0),0),[budgets,year]);
  const qTotal=useCallback((sk,q)=>q.months.reduce((s,m)=>s+(budgets[year]?.[sk]?.monthly?.[m]||0),0),[budgets,year]);
  const qOver=useCallback((sk,q)=>{const c=parseMoney(getQC(sk,q.key));return c!==null&&qTotal(sk,q)>c;},[getQC,qTotal]);
  const aOver=useCallback(sk=>{const c=parseMoney(getAC(sk));return c!==null&&rowTotal(sk)>c;},[getAC,rowTotal]);
  const totalY=useMemo(()=>segs.reduce((s,sg)=>s+rowTotal(sg.key),0),[segs,rowTotal]);
  const dimCount=d=>[...new Set(Object.values(campaignTags||{}).map(t=>t[d]).filter(Boolean))].length;
  const toggleDim=d=>setBudgetDims(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d]);
  const dcw=130;

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

  const handleImportFile=file=>{
    if(!file)return;
    setIFileName(file.name);
    parseFileToRows(file,rawRows=>{
      setIRawRows(rawRows);
      // Auto-detect header row: first row where >2 cells have content
      let headerIdx=0;
      for(let i=0;i<Math.min(rawRows.length,10);i++){
        const filled=rawRows[i].filter(v=>String(v||"").trim()).length;
        if(filled>2){headerIdx=i;break;}
      }
      setIHeaderRow(headerIdx);
      setIStep("header");
    });
  };

  const applyHeaderRow=()=>{
    const{headers,rows}=processRows(iRawRows,iHeaderRow,iSkipStr);
    setIHeaders(headers);setIRows(rows);
    // Detect format: wide (months as cols), transposed (months as rows), long (period+amount cols)
    const monthColCount=headers.filter(h=>isMonthHdr(h)).length;
    const firstColPeriods=rows.slice(0,6).filter(r=>parsePeriod(String(r[headers[0]]||""))).length;
    let fmt="long";
    if(monthColCount>=3) fmt="wide";
    else if(firstColPeriods>=2) fmt="transposed";
    setIFmt(fmt);
    // Auto-map existing dimensions
    const am={};(tagDimensions||[]).forEach(d=>{const m=headers.find(h=>h.toLowerCase()===d.toLowerCase()||h.toLowerCase().includes(d.toLowerCase()));if(m)am[d]=m;});
    setDimMap(am);
    if(fmt==="long"){setPeriodCol(headers.find(h=>/month|period|date/i.test(h))||"");setAmtCol(headers.find(h=>/budget|amount|spend|cost/i.test(h))||"");}
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
        const sp=activeDims.map(d=>({dim:d.dim,val:row[d.col]}));
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
    }else{
      iRows.forEach(row=>{
        const sp=activeDims.map(d=>({dim:d.dim,val:row[d.col]}));
        if(sp.some(p=>!p.val))return;
        const sk=sp.map(p=>p.val).join("|");const mk=parsePeriod(row[periodCol]);const amt=parseMoney(row[amtCol]);
        if(mk&&amt!==null&&amt>0)entries.push({segKey:sk,dims:Object.fromEntries(sp.map(p=>[p.dim,p.val])),monthKey:mk,amount:amt});
      });
    }
    return entries;
  },[iFmt,iHeaders,iRows,iSegDim,iGroupHeaderRow,iGroupDim,iRawRows,tagDimensions,dimMap,customDims,periodCol,amtCol,canonicalDims]);

  const goPreview=()=>{setPreview(buildPreview());setIStep("preview");};

  // Writes the import into state. mergeDecisions (approved pairs from the merge-review modal,
  // or [] when there's nothing to merge) tells it which pre-existing segments are being
  // superseded by a new, more-detailed segKey from this same import.
  const doImport=(mergeDecisions=[])=>{
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
  const resetImport=()=>{setIStep("upload");setIFileName("");setIRawRows([]);setIHeaderRow(0);setIHeaders([]);setIRows([]);setDimMap({});setPeriodCol("");setAmtCol("");setPreview([]);setCustomDims([]);setAiError("");setISegDim("Campaign");setIGroupHeaderRow(-1);setIGroupDim("Channel");};
  const closeImport=()=>{setImportOpen(false);resetImport();};

  const analyzeWithAI=async()=>{
    setAiAnalyzing(true);setAiError("");
    try{
      const sample=iRawRows.slice(0,300).map(row=>row.slice(0,20).map(v=>String(v||"").trim()));
      const prompt=`Analyze this complete budget spreadsheet and return a JSON mapping.\n\nUser's existing tag dimensions: ${(tagDimensions||[]).join(", ")}\n\nComplete file data (${sample.length} rows, up to 20 columns shown — file has ${iRawRows[0]?.length||0} total columns):\n${sample.map((row,i)=>`Row ${i+1}: ${row.map(v=>v.replace(/#REF!/g,"0")).join(" | ")}`).join("\n")}\n\nReturn ONLY this JSON object (no markdown):\n{\n  \"headerRow\": <0-based row index of the main column header row>,\n  \"groupHeaderRow\": <row index of a channel/platform grouping row ABOVE the main header that groups columns, or -1 if none>,\n  \"groupDimension\": <name for the group dimension e.g. \"Channel\" or null>,\n  \"skipPattern\": <substring in subtotal/total rows to skip, or \"\">,\n  \"format\": \"wide\", \"long\", or \"transposed\",\n  \"segmentDimension\": <for transposed: name for the campaign column dimension e.g. \"Campaign\">,\n  \"dimensions\": [{\"name\": <existing dim name>, \"column\": <exact column header>}],\n  \"newDimensions\": [{\"name\": <new dim name>, \"column\": <exact column header>}],\n  \"periodColumn\": <for long format: period column, else null>,\n  \"amountColumn\": <for long format: amount column, else null>,\n  \"hasQuarterlyCaps\": <true/false>,\n  \"hasAnnualCap\": <true/false>\n}\nFormat rules: wide=month names as column headers; transposed=months as rows + campaigns as columns (if a row ABOVE the header groups columns into channels set groupHeaderRow); long=one row per period. Existing dimensions to map: ${(tagDimensions||[]).join(", ")}`;

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
      let fmt=result.format||"long";
      if(fmt!=="transposed"&&fmt!=="wide"&&fmt!=="long"){
        if(monthColCount>=3)fmt="wide";
        else if(firstColPeriods>=2)fmt="transposed";
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

      setIStep("map");
    }catch(e){
      setAiError(`AI analysis failed (${e.message||"unknown error"}) — please map columns manually.`);
      console.error(e);
    }finally{setAiAnalyzing(false);}
  };

  const pvGrouped=useMemo(()=>{const m={};(preview||[]).forEach(e=>{if(!m[e.segKey])m[e.segKey]={dims:e.dims,months:{}};m[e.segKey].months[e.monthKey]=e.amount;});return Object.values(m).sort((a,b)=>Object.values(a.dims).join("|").localeCompare(Object.values(b.dims).join("|")));},[preview]);
  const dimCols=(tagDimensions||[]).filter(d=>dimMap[d]);
  const canMap=iFmt==="transposed"?!!iSegDim:((tagDimensions||[]).filter(d=>dimMap[d]).length>0||customDims.some(c=>c.name&&c.col))&&(iFmt==="wide"||(periodCol&&amtCol));
  const IMPORT_STEPS=["upload","header","map","preview"];

  const cellIn=(val,onChange,over=false,cap=false)=>(
    <input type="text" value={val===""?"":(!isNaN(parseFloat(String(val).replace(/[$,]/g,"")))?`${parseFloat(String(val).replace(/[$,]/g,"")).toLocaleString()}`:val)} onChange={e=>onChange(e.target.value)} placeholder="—"
      style={{background:cap?(over?T.dangerBg:T.warningBg):(over?T.dangerBg:T.inputBg),border:`1px solid ${over?T.danger:cap?T.warningBorder:T.border}`,borderRadius:5,color:over?T.danger:cap?T.warning:T.text,padding:"4px 6px",fontSize:11,width:"100%",boxSizing:"border-box",fontFamily:"Inter,sans-serif",textAlign:"right",outline:"none",display:"block"}}/>
  );
  const TH={fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text,padding:"15px 8px 9px",verticalAlign:"middle",borderBottom:`1px solid ${T.border}`,background:T.bg,whiteSpace:"nowrap",textAlign:"right"};

  return(
    <div style={{display:"flex",height:"100%",background:T.bg,overflow:"hidden"}}>
      {/* Sidebar content now renders via portal into the app-shell's stats sidebar (see sidebarEl) */}
      {sidebarEl&&createPortal(
        <div style={{display:"flex",flexDirection:"column",gap:0}}>
          <div style={{display:"flex",flexDirection:"column",gap:8,paddingBottom:12}}>
          <Btn onClick={()=>setImportOpen(true)} variant="success" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↑ Import CSV / Excel</Btn>
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
            <div style={{display:"flex",gap:4}}>{years.map(y=><button key={y} className={year===y?undefined:"bhq-row"} onClick={()=>setYear(y)} style={{flex:1,padding:"5px 0",borderRadius:6,border:`1.5px solid ${year===y?T.accentHover:T.border}`,background:year===y?T.accent:"transparent",color:year===y?T.text:T.textMuted,cursor:"pointer",fontSize:12,fontWeight:year===y?700:400,fontFamily:"Inter,sans-serif"}}>{y}</button>)}</div>
          </div>
          <Divider T={T}/>
          <div style={{padding:"12px 0"}}>
            <SectionLabel T={T}>Budget By</SectionLabel>
            {(tagDimensions||[]).map(d=>{const on=budgetDims.includes(d);return(
              <div key={d} className={on?undefined:"bhq-row"} onClick={()=>toggleDim(d)} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 8px",borderRadius:6,cursor:"pointer",background:on?T.accentBg:"transparent",border:on?`1px solid ${T.accentBorder}`:"1px solid transparent",marginBottom:2}}>
                <Chk checked={on} onChange={()=>toggleDim(d)} T={T}/>
                <span style={{fontSize:13,color:T.text,fontWeight:on?700:400}}>{d}</span>
                <span style={{fontSize:11,color:T.textMuted,marginLeft:"auto",fontFamily:"Inter,sans-serif"}}>{dimCount(d)}</span>
              </div>
            );})}
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
          </div>
        </div>,
        sidebarEl
      )}

      {/* Table */}
      <div style={{flex:1,overflow:"auto",minWidth:0}}>
        {!budgetDims.length?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40}}>
            <div style={{width:52,height:52,background:T.accent,border:`3px solid ${T.text}`,boxShadow:`4px 4px 0 0 ${T.text}`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:22}}><Icon name="wallet" size={24} color={T.text}/></div>
            <div style={{fontSize:17,fontWeight:700,color:T.text,marginBottom:6}}>Set up your budget structure</div>
            <div style={{fontSize:13,color:T.textSub,maxWidth:340,lineHeight:1.65,marginBottom:20}}>Select dimensions to budget by, or import an existing budget file.</div>
            <Btn onClick={()=>setImportOpen(true)} variant="success" T={T} size="md">↑ Import CSV / Excel</Btn>
          </div>
        ):segs.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40}}>
            <div style={{fontSize:17,fontWeight:700,color:T.text,marginBottom:6}}>No tagged segments found</div>
            <div style={{fontSize:13,color:T.textSub,maxWidth:320,lineHeight:1.65}}>Tag campaigns with <strong style={{color:T.text}}>{budgetDims.join(" + ")}</strong> in the Tagger first.</div>
          </div>
        ):(
          <>
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
                <input type="checkbox" checked={filteredSegs.length>0&&selRows.size===filteredSegs.length} onChange={selAllRows} style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
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
                <tr><td colSpan={2+budgetDims.length+budgetMetaDims.length+MONTHS.length+QUARTERS.length+1+(showQ?QUARTERS.length:0)+(showA?1:0)} style={{padding:"32px 20px",textAlign:"center",color:T.textMuted,fontSize:13}}>No segments match your filters. <span onClick={clearSegFilters} style={{color:T.accent,cursor:"pointer",fontWeight:500}}>Clear filters</span></td></tr>
              )}
              {filteredSegs.map((seg)=>{const rt=rowTotal(seg.key);const ao=aOver(seg.key);const rb="transparent";const rbb=`1px dashed ${T.borderStrong}`;const isSel=selRows.has(seg.key);return(
                <tr key={seg.key} className={isSel?undefined:"bhq-tr"} style={{background:isSel?T.rowSelected:rb}}>
                  <td style={{padding:"7px 8px 7px 16px",borderBottom:rbb,position:"sticky",left:0,background:isSel?T.rowSelected:T.bg,zIndex:1}}>
                    <input type="checkbox" checked={isSel} onChange={()=>toggleRowSel(seg.key)} style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
                  </td>
                  {budgetDims.map((d,i)=><td key={d} style={{padding:"7px 14px",borderBottom:rbb,position:"sticky",left:32+i*dcw,background:isSel?T.rowSelected:T.bg,zIndex:1,whiteSpace:"nowrap"}}>
                    {editingSegVal?.segKey===seg.key&&editingSegVal?.dim===d?(
                      <input autoFocus value={editSegVal} onChange={e=>setEditSegVal(e.target.value)}
                        onBlur={saveSegEdit} onKeyDown={e=>{if(e.key==="Enter")saveSegEdit();if(e.key==="Escape"){setEditingSegVal(null);setEditSegVal("");}}}
                        style={{background:T.inputBg,border:`1px solid ${T.accentBorder}`,borderRadius:6,color:T.text,padding:"3px 8px",fontSize:11,outline:"none",fontFamily:"Inter,sans-serif",minWidth:80}}/>
                    ):(
                      <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:"Inter,sans-serif",fontWeight:600,cursor:"text",borderRadius:6}}
                        onClick={()=>{setEditingSegVal({segKey:seg.key,dim:d});setEditSegVal(seg[d]);}}>{seg[d]}</Pill>
                    )}
                    {i===budgetDims.length-1&&segMatchCount(seg.key)===0&&(
                      <WarnTip T={T} text="No campaigns are tagged to this segment yet. Spend won't roll up here until a campaign is tagged with this exact combination in the Tagger."/>
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
                            style={{background:T.inputBg,border:`1px solid ${T.accentBorder}`,borderRadius:5,color:T.text,padding:"3px 7px",fontSize:11,outline:"none",fontFamily:"Inter,sans-serif",width:"100%"}}/>
                        ):(
                          <span style={{fontSize:11,color:val?T.text:T.textMuted,cursor:"text",padding:"3px 6px",display:"block",borderRadius:5,border:`1px solid transparent`,minHeight:22,fontFamily:"Inter,sans-serif"}}>
                            {val||<span style={{opacity:0.4}}>—</span>}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  {MONTHS.map(m=>{const q=QUARTERS.find(q=>q.months.includes(m.key));const qo=showQ&&q&&qOver(seg.key,q);return <td key={m.key} style={{padding:"4px",borderBottom:rbb,background:rb}}>{cellIn(getMV(seg.key,m.key),v=>setMV(seg.key,m.key,v),qo)}</td>;})}
                  {QUARTERS.map(q=>{const qt=qTotal(seg.key,q);return <td key={"qt-"+q.key} style={{padding:"4px 10px",borderBottom:rbb,textAlign:"right",fontFamily:"Inter,sans-serif",fontSize:11,color:T.textSub,background:rb}}>{qt>0?fmt$(qt):"—"}</td>;})}
                  <td style={{padding:"4px 12px",borderBottom:rbb,textAlign:"right",fontFamily:"Inter,sans-serif",fontWeight:700,color:ao?T.danger:T.text,whiteSpace:"nowrap",background:rb}}><span style={{display:"inline-flex",alignItems:"center",gap:4}}>{rt>0?fmtFull(rt):"—"}{ao&&<Icon name="alert" size={11} color={T.danger}/>}</span></td>
                  {showQ&&QUARTERS.map(q=>{const qo=qOver(seg.key,q);const qt=qTotal(seg.key,q);return <td key={"qc-"+q.key} style={{padding:"4px",borderBottom:rbb,background:rb}}><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>{cellIn(getQC(seg.key,q.key),v=>setQC(seg.key,q.key,v),qo,true)}{qt>0&&<span style={{fontSize:10,color:qo?T.danger:T.textMuted,fontFamily:"Inter,sans-serif",display:"inline-flex",alignItems:"center",gap:3}}>{fmt$(qt)}{qo&&<Icon name="alert" size={10} color={T.danger}/>}</span>}</div></td>;})}
                  {showA&&<td style={{padding:"4px",borderBottom:rbb,background:rb}}><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>{cellIn(getAC(seg.key),v=>setAC(seg.key,v),ao,true)}{rt>0&&<span style={{fontSize:10,color:ao?T.danger:T.textMuted,fontFamily:"Inter,sans-serif",display:"inline-flex",alignItems:"center",gap:3}}>{fmt$(rt)}{ao&&<Icon name="alert" size={10} color={T.danger}/>}</span>}</div></td>}
                  <td style={{padding:"4px 8px",borderBottom:rbb,background:rb}}>
                    <button onClick={()=>deleteRow(seg.key,budgetDims.map(d=>seg[d]).join(" · "))} title="Delete row"
                      style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:5,color:T.textMuted,cursor:"pointer",fontSize:12,lineHeight:1,padding:0,opacity:0.4,transition:"all 0.1s"}}
                      onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.border=`1px solid ${T.danger}`;e.currentTarget.style.color=T.danger;}}
                      onMouseLeave={e=>{e.currentTarget.style.opacity=0.4;e.currentTarget.style.border="1px solid transparent";e.currentTarget.style.color=T.textMuted;}}>✕</button>
                  </td>
                </tr>);})}
              <tr style={{borderTop:`1px solid ${T.border}`,background:T.surface}}>
                <td style={{padding:"10px 8px 10px 16px",position:"sticky",left:0,background:T.surface,zIndex:1}}/>
                {budgetDims.map((d,i)=><td key={d} style={{padding:"10px 14px",position:"sticky",left:32+i*dcw,background:T.surface,zIndex:1}}>{i===0&&<SectionLabel T={T} style={{marginBottom:0,color:T.text}}>Totals</SectionLabel>}</td>)}
                {budgetMetaDims.map(d=><td key={d}/>)}
                {MONTHS.map(m=>{const t=filteredSegs.reduce((s,sg)=>s+(budgets[year]?.[sg.key]?.monthly?.[m.key]||0),0);return <td key={m.key} style={{padding:"10px 8px",textAlign:"right",fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:600,color:T.text}}>{t>0?fmt$(t):"—"}</td>;})}
                {QUARTERS.map(q=>{const qt=filteredSegs.reduce((s,sg)=>s+qTotal(sg.key,q),0);return <td key={"qt-"+q.key} style={{padding:"10px 10px",textAlign:"right",fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:600,color:T.textSub}}>{qt>0?fmt$(qt):"—"}</td>;})}
                <td style={{padding:"10px 12px",textAlign:"right",fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:700,color:T.text}}>{(()=>{const ft=filteredSegs.reduce((s,sg)=>s+rowTotal(sg.key),0);return ft>0?fmtFull(ft):"—";})()}</td>
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
              <span style={{marginLeft:"auto",fontSize:11,color:T.textMuted}}>{filteredSegs.length} of {segs.length} segments</span>
            </div>
            {budgetDims.length>0&&(!showAddRow?(
                <Btn onClick={()=>setShowAddRow(true)} variant="ghost" size="sm" T={T} style={{alignSelf:"flex-start"}}>+ Add segment manually</Btn>
              ):(
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  {budgetDims.map(d=>(
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
                      Year: <strong>{iYear}</strong> · {iFmt==="wide"?"Wide (months as columns)":iFmt==="transposed"?"Transposed (months as rows, campaigns as columns)":"Long (period + amount columns)"} · {iRows.length} data rows · {iHeaders.length} columns
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
                  {aiAnalyzing?<span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:12,height:12,border:`2px solid rgba(255,255,255,0.3)`,borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/> Analyzing…</span>:<span>✨ Analyze with AI</span>}
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
                          <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:12,color:confMeta.color,background:confMeta.bg,border:`1px solid ${confMeta.border}`}}>{confMeta.label}</span>
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

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({T,onNavigate,stats,hasData,themeKey}){
  const cardBg=themeKey==="light"?"#FFFFFF":T.surface;
  const bc=T.badgeColors||[T.accent,T.accent,T.accent,T.accent,T.accent];
  const cards=[
    {
      key:"tagger",icon:"tag",title:"Start with spend data",
      desc:"Upload a spend CSV from Google Ads, LinkedIn, Meta, Bing or Capterra. Tag campaigns into custom segments like Product, Region, and Funnel.",
      action:"Import spend data →",color:bc[2],primary:true,
    },
    {
      key:"budget",icon:"wallet",title:"Start with a budget file",
      desc:"Upload your budget spreadsheet (Excel or CSV). AI maps your columns automatically. Set monthly budgets by segment — no spend data needed.",
      action:"Import budget file →",color:bc[1],primary:true,
    },
    {
      key:"pacing",icon:"chart",title:"Reporting & Pacing",
      desc:"Track burn rate, PTD spend vs budget, forecast to end of period, and break down spend by region, platform, funnel, or any other dimension.",
      action:"Open reporting →",color:bc[3],
    },
    {
      key:"export",icon:"export",title:"Export",
      desc:"Export clean data — no formulas — to plug into your own Google Sheets or Excel trackers.",
      action:"Coming soon",color:T.textMuted,disabled:true,
    },
  ];
  return(
    <div style={{flex:1,overflow:"auto",background:T.bg}}>
      <div style={{maxWidth:960,margin:"0 auto",padding:"48px 32px"}}>
        {/* Hero */}
        <div style={{marginBottom:40,position:"relative"}}>
          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:18,position:"relative"}}>
            <div style={{width:48,height:48,borderRadius:12,background:T.accent,boxShadow:T.shadow,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <Icon name="bolt" size={24} color={T.text}/>
            </div>
            <div>
              <h1 style={{fontSize:30,fontWeight:800,color:T.text,letterSpacing:"-0.6px",marginBottom:2,fontFamily:"Inter,sans-serif"}}>BudgetHQ</h1>
              <div style={{fontSize:12,fontWeight:600,color:T.textSub,letterSpacing:"0.02em",fontFamily:"Inter,sans-serif"}}>Paid media budget intelligence · by PaidHQ</div>
            </div>
          </div>
          <p style={{fontSize:15,color:T.textSub,lineHeight:1.7,maxWidth:560,fontFamily:"Inter,sans-serif",position:"relative"}}>
            Set budgets by custom segment, track pacing against actuals, and manage spend across every ad platform — without breaking a spreadsheet.
          </p>
          <div style={{marginTop:14,display:"inline-flex",alignItems:"center",gap:8,padding:"8px 16px",borderRadius:8,background:T.accentBg,border:`1px solid ${T.accentBorder}`,position:"relative"}}>
            <span style={{fontSize:13,color:T.text,fontFamily:"Inter,sans-serif"}}>Start with spend data <strong>or</strong> a budget file — connect them later for pacing.</span>
          </div>
        </div>

        {/* Cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:22}}>
          {cards.map(card=>(
            <PixelPanel key={card.key} T={T}
              onClick={card.disabled?undefined:()=>onNavigate(card.key)}
              style={{opacity:card.disabled?0.5:1}}
              contentStyle={{padding:"24px 26px",background:cardBg,cursor:card.disabled?"default":"pointer",transition:"all 0.1s"}}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14}}>
                <div style={{width:42,height:42,borderRadius:10,background:T.surfaceEl,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={card.icon} size={19} color={card.disabled?T.textMuted:T.textSub}/></div>
                {!card.disabled&&<span style={{fontSize:16,fontWeight:700,color:T.textMuted,lineHeight:1}}>→</span>}
              </div>
              <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6,fontFamily:"Inter,sans-serif"}}>{card.title}</div>
              <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,marginBottom:14,fontFamily:"Inter,sans-serif"}}>{card.desc}</div>
              <div style={{fontSize:12,fontWeight:600,color:card.disabled?T.textMuted:T.text,fontFamily:"Inter,sans-serif"}}>{card.action}</div>
            </PixelPanel>
          ))}
        </div>

        {/* Date range if data loaded */}
        {hasData&&stats.dateRange&&(
          <div style={{marginTop:24,padding:"10px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,display:"inline-flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:11,color:T.textMuted,fontFamily:"Inter,sans-serif"}}>Data loaded:</span>
            <span style={{fontSize:11,color:T.text,fontFamily:"Inter,sans-serif",fontWeight:500}}>{stats.dateRange}</span>
            <span style={{fontSize:11,color:T.textMuted,fontFamily:"Inter,sans-serif"}}>· {stats.totalRows.toLocaleString()} rows</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Normalize raw CSV rows to standard format using colMap. campaign_name (the leaf level — ad
// set/ad group/LinkedIn campaign) falls back to campaign_group_name when the CSV/export doesn't
// have a second level of breakdown, so single-level data keeps working unchanged.
function normalizeRows(rows,colMap){
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

// Merge normalized rows — deduplicate by campaign group + campaign + date, new data wins
function mergeRows(existing,incoming){
  const key=r=>`${campaignKey(r.campaign_group_name,r.campaign_name)}||${r.date}`;
  const map=new Map(existing.map(r=>[key(r),r]));
  incoming.forEach(r=>map.set(key(r),r));
  return Array.from(map.values());
}

// ─── PACING ENGINE ────────────────────────────────────────────────────────────
// Robust date parser — handles "YYYY-MM-DD", "M/D/YYYY", "MM/DD/YY", and falls back to native Date parsing.
function parseSpendDate(v){
  if(!v)return null;
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m)return new Date(+m[1],+m[2]-1,+m[3]);
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if(m){let y=+m[3];if(y<100)y+=2000;return new Date(y,+m[1]-1,+m[2]);}
  const d=new Date(s);
  return isNaN(d.getTime())?null:d;
}

// Resolve a period type + selectors into a date range and the set of month-keys it covers
function getPeriodRange(periodType,year,month,quarter){
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
function renameDimensionValue({budgets,budgetRowMeta,tags,budgetDims,dim,oldVal,newVal}){
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

// Removes just the budgetDims tag values (not the whole campaign) from every campaign that
// matches this segment's exact dimension combo — used when deleting a budget row, so a deleted
// segment doesn't leave campaigns still carrying a tag combination with no budget behind it.
// Spend data itself is untouched; matching campaigns simply lose these specific tags and fall
// back to "needs review" in the Tagger.
function untagSegmentCampaigns(tags,budgetDims,segKey){
  const vals=segKey.split("|");
  if(vals.length!==budgetDims.length)return tags;
  const newTags={...(tags||{})};
  Object.entries(tags||{}).forEach(([campaign,t])=>{
    if(!budgetDims.every((d,i)=>t[d]===vals[i]))return;
    const nt={...t};
    budgetDims.forEach(d=>delete nt[d]);
    newTags[campaign]=nt;
  });
  return newTags;
}
function countSegmentCampaigns(tags,budgetDims,segKey){
  const vals=segKey.split("|");
  if(vals.length!==budgetDims.length)return 0;
  return Object.values(tags||{}).filter(t=>budgetDims.every((d,i)=>t[d]===vals[i])).length;
}

// Reporting drill-down: sums spend for a segment (matched by budgetDims/segKey, within a date
// range) grouped by ONE secondary dimension — independent of budgets entirely, so it works
// whether or not a formal budget exists at that level. "Platform" is a synthetic option derived
// per-row (same logic the rest of the app uses for platform badges), since it isn't a manual tag.
function computeSpendBreakdown({mergedNormRows,tags,budgetDims,segKey,breakdownDim,start,end}){
  const vals=segKey.split("|");
  const map={};
  mergedNormRows.forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d||d<start||d>end)return;
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    if(!budgetDims.every((dim,i)=>rowTags[dim]===vals[i]))return;
    const bval=breakdownDim==="Platform"?derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type):(rowTags[breakdownDim]||"Untagged");
    map[bval]=(map[bval]||0)+row.spend;
  });
  const total=Object.values(map).reduce((s,v)=>s+v,0);
  return Object.entries(map).map(([value,spend])=>({value,spend,pct:total>0?spend/total:0})).sort((a,b)=>b.spend-a.spend);
}

// One pass over mergedNormRows producing {segKey: {monthKey: actualSpend}} for a given calendar
// year — used to build the optional monthly/quarterly "Actual" column blocks in the budget
// export, so each block only costs one scan regardless of how many segments/months it covers.
function computeActualsByMonth({mergedNormRows,tags,budgetDims,year}){
  const map={};
  if(!budgetDims.length)return map;
  mergedNormRows.forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d||d.getFullYear()!==Number(year))return;
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    const vals=budgetDims.map(dim=>rowTags[dim]);
    if(vals.some(v=>!v))return;
    const sk=vals.join("|");
    const mk=String(d.getMonth()+1).padStart(2,"0");
    if(!map[sk])map[sk]={};
    map[sk][mk]=(map[sk][mk]||0)+row.spend;
  });
  return map;
}

// Core pacing calculation: aggregates spend into budget segments for a period and
// compares actual spend-to-date against time-elapsed expectation.
function computePacing({mergedNormRows,tags,budgetDims,budgets,year,periodType,month,quarter,today}){
  const{start,end,months}=getPeriodRange(periodType,year,month,quarter);
  const totalDays=Math.round((end-start)/86400000)+1;
  let elapsedDays;
  if(today<start)elapsedDays=0;
  else if(today>end)elapsedDays=totalDays;
  else elapsedDays=Math.floor((today-start)/86400000)+1;
  const daysRemaining=Math.max(0,totalDays-elapsedDays);
  const expectedPct=totalDays?elapsedDays/totalDays:0;

  const spendMap={};
  // Independent of the period/date range — how many tagged campaigns exist for each segment
  // at all. If this is 0 for a segment that has a budget, spend will NEVER show up for it no
  // matter what period you're looking at — it's a tagging/dimension mismatch, not "no spend yet".
  const campaignCountMap={};
  if(budgetDims.length){
    Object.values(tags||{}).forEach(t=>{
      const vals=budgetDims.map(dim=>t[dim]);
      if(vals.some(v=>!v))return;
      const sk=vals.join("|");
      campaignCountMap[sk]=(campaignCountMap[sk]||0)+1;
    });
    mergedNormRows.forEach(row=>{
      const d=parseSpendDate(row.date);
      if(!d||d<start||d>end)return;
      const vals=budgetDims.map(dim=>(tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{})[dim]);
      if(vals.some(v=>!v))return;
      const sk=vals.join("|");
      spendMap[sk]=(spendMap[sk]||0)+row.spend;
    });
  }

  const yearBudgets=budgets[year]||{};
  const segKeys=new Set([...Object.keys(yearBudgets),...Object.keys(spendMap)]);

  const segments=[...segKeys].map(sk=>{
    const monthly=yearBudgets[sk]?.monthly||{};
    const budget=months.reduce((s,mk)=>s+(monthly[mk]||0),0);
    const spend=spendMap[sk]||0;
    const dims=sk.split("|");
    const actualPct=budget>0?spend/budget:null;
    const dailyRate=elapsedDays>0?spend/elapsedDays:0;
    const projected=elapsedDays>0?dailyRate*totalDays:null;
    const projectedVariance=budget>0&&projected!=null?projected-budget:null;
    let status="no-budget";
    if(budget>0){
      if(spend>budget)status="over";
      else{
        const delta=(actualPct??0)-expectedPct;
        if(delta>0.1)status="ahead";
        else if(delta<-0.1)status="behind";
        else status="on-track";
      }
    }
    return{segKey:sk,dims,budget,spend,actualPct,dailyRate,projected,projectedVariance,status,matchCount:campaignCountMap[sk]||0};
  }).filter(s=>s.budget>0||s.spend>0).sort((a,b)=>b.spend-a.spend);

  const totals=segments.reduce((acc,s)=>({budget:acc.budget+s.budget,spend:acc.spend+s.spend}),{budget:0,spend:0});
  return{segments,totals,totalDays,elapsedDays,daysRemaining,expectedPct,start,end};
}

function pacingStatusMeta(status,T){
  switch(status){
    case"over":return{label:"Over budget",color:T.danger,bg:T.dangerBg,border:T.dangerBorder};
    case"ahead":return{label:"Ahead of pace",color:T.warning,bg:T.warningBg,border:T.warningBorder};
    case"behind":return{label:"Behind pace",color:T.accent,bg:T.accentBg,border:T.accentBorder};
    case"on-track":return{label:"On track",color:T.success,bg:T.successBg,border:T.successBorder};
    default:return{label:"No budget set",color:T.textMuted,bg:T.surfaceEl,border:T.border};
  }
}

const fmtSigned=n=>n==null?"—":(n>0?"+":n<0?"−":"")+"$"+Math.round(Math.abs(n)).toLocaleString();

// ─── EXPORTS (CSV / XLSX / PDF / HTML / Email) ─────────────────────────────────
// Every exportable view (Dashboard, Campaign Tagger, Budget Panel, Reporting & Pacing) is first
// turned into one common shape — {title, subtitle, sections:[{heading,headers,rows}]} — regardless
// of which tab it came from. The four format generators below only have to be written once against
// that shape, and "Email a copy" reuses the exact same generators (as a Blob instead of a download),
// so a report never has to be built twice or risk drifting between the download and email paths.

function buildDashboardReport({mergedNormRows,tags,tagDims,budgets,budgetDims}){
  const campaignMap={};
  (mergedNormRows||[]).forEach(row=>{
    const name=row.campaign_name;if(!name)return;
    const key=campaignKey(row.campaign_group_name||name,name);
    if(!campaignMap[key])campaignMap[key]={spend:0};
    campaignMap[key].spend+=row.spend||0;
  });
  const keys=Object.keys(campaignMap);
  const totalSpend=keys.reduce((s,k)=>s+campaignMap[k].spend,0);
  const taggedCount=keys.filter(k=>Object.keys(tags[k]||{}).length>0).length;
  const untaggedCount=keys.length-taggedCount;

  const overviewRows=[
    ["Total spend",`$${Math.round(totalSpend).toLocaleString()}`],
    ["Campaigns",keys.length.toLocaleString()],
    ["Tagged",`${taggedCount.toLocaleString()} (${keys.length?Math.round(taggedCount/keys.length*100):0}%)`],
    ["Needs review",untaggedCount.toLocaleString()],
  ];

  const dimSections=(tagDims||[]).map(dim=>{
    const map={};
    (mergedNormRows||[]).forEach(row=>{
      const key=campaignKey(row.campaign_group_name||row.campaign_name,row.campaign_name);
      const val=(tags[key]||{})[dim]||"Untagged";
      map[val]=(map[val]||0)+(row.spend||0);
    });
    const rows=Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([val,spend])=>[val,`$${Math.round(spend).toLocaleString()}`]);
    return{heading:`Spend by ${dim}`,headers:[dim,"Spend"],rows};
  });

  const statusCounts={};
  if((budgetDims||[]).length){
    Object.keys(budgets||{}).forEach(year=>{
      const pacing=computePacing({mergedNormRows:mergedNormRows||[],tags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date()});
      pacing.segments.forEach(s=>{statusCounts[s.status]=(statusCounts[s.status]||0)+1;});
    });
  }
  const pacingRows=Object.entries(statusCounts).map(([status,count])=>[pacingStatusMeta(status,THEMES.light).label,String(count)]);

  return{
    title:"Dashboard summary",
    subtitle:`Generated ${new Date().toLocaleString()}`,
    sections:[
      {heading:"Overview",headers:["Metric","Value"],rows:overviewRows},
      ...dimSections,
      ...(pacingRows.length?[{heading:"Budget pacing status (all years)",headers:["Status","Segments"],rows:pacingRows}]:[]),
    ],
  };
}

function buildTaggerReport({mergedNormRows,tags,tagDims}){
  const campaignMap={};
  (mergedNormRows||[]).forEach(row=>{
    const name=row.campaign_name;if(!name)return;
    const groupName=row.campaign_group_name||name;
    const key=campaignKey(groupName,name);
    const platform=derivePlatform(groupName,name,row.platform,row.campaign_type);
    if(!campaignMap[key])campaignMap[key]={key,name,groupName,platform,spend:0};
    campaignMap[key].spend+=row.spend||0;
  });
  const campaigns=Object.values(campaignMap).sort((a,b)=>b.spend-a.spend);
  const headers=["Campaign Group","Campaign","Platform","Spend",...(tagDims||[])];
  const rows=campaigns.map(c=>{
    const t=tags[c.key]||{};
    return[c.groupName,c.name,c.platform,`$${Math.round(c.spend).toLocaleString()}`,...(tagDims||[]).map(d=>t[d]||"")];
  });
  return{
    title:"Campaign Tagger export",
    subtitle:`Generated ${new Date().toLocaleString()} · ${campaigns.length.toLocaleString()} campaigns`,
    sections:[{heading:"Campaigns",headers,rows}],
  };
}

function buildBudgetReport({budgets,budgetDims,budgetRowMeta,budgetMetaDims,mergedNormRows,tags}){
  const years=Object.keys(budgets||{}).sort();
  const sections=years.map(year=>{
    const yearBudgets=budgets[year]||{};
    const pacing=(budgetDims||[]).length?computePacing({mergedNormRows:mergedNormRows||[],tags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date()}):{segments:[]};
    const pacingBySeg={};
    pacing.segments.forEach(s=>{pacingBySeg[s.segKey]=s;});
    const headers=[...budgetDims,...(budgetMetaDims||[]),"Annual Budget","Actual Spend","% Used","Pacing Status"];
    const rows=Object.keys(yearBudgets).sort().map(segKey=>{
      const vals=segKey.split("|");
      if(vals.length!==budgetDims.length)return null;
      const meta=(budgetRowMeta||{})[segKey]||{};
      const monthly=yearBudgets[segKey]?.monthly||{};
      const total=Object.values(monthly).reduce((s,v)=>s+(v||0),0);
      const p=pacingBySeg[segKey];
      return[...vals,...(budgetMetaDims||[]).map(d=>meta[d]||""),
        `$${Math.round(total).toLocaleString()}`,
        p?`$${Math.round(p.spend).toLocaleString()}`:"$0",
        p&&p.actualPct!=null?`${Math.round(p.actualPct*100)}%`:"—",
        p?pacingStatusMeta(p.status,THEMES.light).label:pacingStatusMeta("no-budget",THEMES.light).label,
      ];
    }).filter(Boolean);
    return{heading:`${year} budgets`,headers,rows};
  });
  return{
    title:"Budget Panel export",
    subtitle:`Generated ${new Date().toLocaleString()}`,
    sections:sections.length?sections:[{heading:"Budgets",headers:["No budget data yet"],rows:[]}],
  };
}

function buildPacingReport({budgets,budgetDims,mergedNormRows,tags}){
  const years=Object.keys(budgets||{}).sort();
  const headers=[...(budgetDims||[]),"Year","Budget","Actual Spend","% Used","Daily Run Rate","Projected Year-End","Variance","Status"];
  const rows=[];
  years.forEach(year=>{
    if(!(budgetDims||[]).length)return;
    const pacing=computePacing({mergedNormRows:mergedNormRows||[],tags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date()});
    pacing.segments.forEach(s=>{
      rows.push([...s.dims,year,
        `$${Math.round(s.budget).toLocaleString()}`,
        `$${Math.round(s.spend).toLocaleString()}`,
        s.actualPct!=null?`${Math.round(s.actualPct*100)}%`:"—",
        `$${Math.round(s.dailyRate).toLocaleString()}`,
        s.projected!=null?`$${Math.round(s.projected).toLocaleString()}`:"—",
        s.projectedVariance!=null?fmtSigned(s.projectedVariance):"—",
        pacingStatusMeta(s.status,THEMES.light).label,
      ]);
    });
  });
  return{
    title:"Reporting & Pacing export",
    subtitle:`Generated ${new Date().toLocaleString()}`,
    sections:[{heading:"Pacing by segment",headers,rows:rows.length?rows:[]}],
  };
}

const EXPORTABLE_VIEWS={
  dashboard:{label:"Dashboard",build:buildDashboardReport,filenameBase:"budgethq-dashboard"},
  tagger:{label:"Campaign Tagger",build:buildTaggerReport,filenameBase:"budgethq-campaign-tagger"},
  budget:{label:"Budget Panel",build:buildBudgetReport,filenameBase:"budgethq-budget-panel"},
  pacing:{label:"Reporting & Pacing",build:buildPacingReport,filenameBase:"budgethq-reporting-pacing"},
};
const EXPORT_FORMATS=[{key:"csv",label:"CSV",mime:"text/csv;charset=utf-8"},{key:"xlsx",label:"Excel",mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},{key:"pdf",label:"PDF",mime:"application/pdf"},{key:"html",label:"HTML",mime:"text/html;charset=utf-8"}];

const escHtml=s=>String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function reportToCSVString(report){
  const rows=[];
  report.sections.forEach((sec,i)=>{
    if(i>0)rows.push([]);
    rows.push([sec.heading]);
    rows.push(sec.headers);
    (sec.rows.length?sec.rows:[["No data"]]).forEach(r=>rows.push(r));
  });
  return rows.map(r=>r.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\n");
}

function reportToHTMLString(report){
  const sectionsHtml=report.sections.map(sec=>`
    <h2 style="font-size:16px;font-weight:700;color:#1E222A;margin:28px 0 10px;">${escHtml(sec.heading)}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr>${sec.headers.map(h=>`<th style="text-align:left;padding:8px 10px;background:#F7F8FA;border-bottom:2px solid #CED2DB;color:#5B6272;font-weight:600;">${escHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${(sec.rows.length?sec.rows:null)?sec.rows.map((r,i)=>`<tr style="background:${i%2?"#FAFBFC":"#FFFFFF"};">${r.map(c=>`<td style="padding:7px 10px;border-bottom:1px solid #EEF0F3;color:#1E222A;">${escHtml(c)}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${sec.headers.length}" style="padding:14px 10px;color:#8A90A0;">No data</td></tr>`}</tbody>
    </table>`).join("");
  return`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(report.title)}</title></head>
  <body style="font-family:-apple-system,Inter,sans-serif;background:#F0F1F5;padding:32px;margin:0;">
    <div style="max-width:900px;margin:0 auto;background:#FFFFFF;border-radius:12px;padding:32px 36px;border:1px solid #CED2DB;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
        <span style="width:26px;height:26px;border-radius:7px;background:#FFC249;display:inline-block;"></span>
        <span style="font-size:15px;font-weight:700;color:#1E222A;">BudgetHQ</span>
      </div>
      <h1 style="font-size:22px;font-weight:800;color:#1E222A;margin:18px 0 2px;">${escHtml(report.title)}</h1>
      <p style="font-size:12px;color:#8A90A0;margin:0 0 8px;">${escHtml(report.subtitle)}</p>
      ${sectionsHtml}
    </div>
  </body></html>`;
}

function buildReportPDFDoc(report){
  const doc=new jsPDF({unit:"pt",format:"letter"});
  const marginX=40;let y=50;
  doc.setFillColor(255,194,73);
  doc.roundedRect(marginX,y-14,18,18,4,4,"F");
  doc.setFontSize(13);doc.setTextColor(30,34,42);doc.setFont(undefined,"bold");
  doc.text("BudgetHQ",marginX+26,y+1);
  y+=28;
  doc.setFontSize(18);doc.text(report.title,marginX,y);
  y+=15;
  doc.setFont(undefined,"normal");doc.setFontSize(9);doc.setTextColor(138,144,160);
  doc.text(report.subtitle,marginX,y);
  y+=12;
  report.sections.forEach(sec=>{
    if(y>700){doc.addPage();y=50;}
    doc.setFontSize(12);doc.setTextColor(30,34,42);doc.setFont(undefined,"bold");
    doc.text(sec.heading,marginX,y+16);
    autoTable(doc,{
      startY:y+22,margin:{left:marginX,right:marginX},
      head:[sec.headers],
      body:sec.rows.length?sec.rows:[sec.headers.map((h,i)=>i===0?"No data":"")],
      styles:{fontSize:8.5,cellPadding:5,textColor:[30,34,42]},
      headStyles:{fillColor:[247,248,250],textColor:[91,98,114],fontStyle:"bold",lineWidth:0.5,lineColor:[206,210,219]},
      alternateRowStyles:{fillColor:[250,251,252]},
      theme:"grid",
    });
    y=doc.lastAutoTable.finalY+26;
  });
  return doc;
}

// Builds the same file either format produces, as a Blob — shared by the download buttons and
// "Email a copy" (which base64-encodes this same Blob as an email attachment) so there's exactly
// one code path per format, not two that could quietly drift apart.
function buildReportBlob(report,format){
  if(format==="csv")return new Blob(["﻿"+reportToCSVString(report)],{type:"text/csv;charset=utf-8"});
  if(format==="xlsx"){
    const wb=XLSX.utils.book_new();
    report.sections.forEach((sec,i)=>{
      const aoa=[[sec.heading],sec.headers,...(sec.rows.length?sec.rows:[["No data"]])];
      const ws=XLSX.utils.aoa_to_sheet(aoa);
      const name=(sec.heading||`Sheet${i+1}`).replace(/[\\/*?:[\]]/g,"").slice(0,31)||`Sheet${i+1}`;
      XLSX.utils.book_append_sheet(wb,ws,name);
    });
    const out=XLSX.write(wb,{bookType:"xlsx",type:"array"});
    return new Blob([out],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  }
  if(format==="html")return new Blob([reportToHTMLString(report)],{type:"text/html;charset=utf-8"});
  if(format==="pdf")return buildReportPDFDoc(report).output("blob");
  throw new Error(`Unknown export format: ${format}`);
}

function downloadReport(report,format,filenameBase){
  const blob=buildReportBlob(report,format);
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=`${filenameBase}.${format}`;a.click();URL.revokeObjectURL(url);
}

function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onloadend=()=>resolve(String(reader.result).split(",")[1]||"");
    reader.onerror=reject;
    reader.readAsDataURL(blob);
  });
}

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

function PacingDashboard({campaignTags,setTags,tagDimensions,budgetDims,budgets,setBudgets,budgetRowMeta,setBudgetRowMeta,mergedNormRows,T,onNavigate,sidebarEl}){
  const now=new Date();
  const yr=now.getFullYear();
  const[year,setYear]=useState(yr.toString());
  const[periodType,setPeriodType]=useState("monthly");
  const[month,setMonth]=useState(String(now.getMonth()+1).padStart(2,"0"));
  const[quarter,setQuarter]=useState(`Q${Math.floor(now.getMonth()/3)+1}`);
  const years=[(yr-1).toString(),yr.toString(),(yr+1).toString()];

  const[selRows,setSelRows]=useState(new Set());
  const[segFilters,setSegFilters]=useState({}); // {dim: filterText} — substring match, ANDed across dims
  const[statusFilter,setStatusFilter]=useState("all");
  const[notif,setNotif]=useState(null);
  const[editingSegVal,setEditingSegVal]=useState(null); // {segKey, dim}
  const[editSegVal,setEditSegVal]=useState("");
  const[breakdownDim,setBreakdownDim]=useState(""); // "" = no drill-down; else "Platform" or a tag dimension
  const[expandedRows,setExpandedRows]=useState(new Set());
  const showNotif=msg=>{setNotif(msg);setTimeout(()=>setNotif(null),3000);};
  // Selecting rows only makes sense within the period/year currently being viewed — clear on change
  const changeYear=y=>{setYear(y);setSelRows(new Set());};
  const changePeriodType=k=>{setPeriodType(k);setSelRows(new Set());};
  const changeMonth=m=>{setMonth(m);setSelRows(new Set());};
  const changeQuarter=q=>{setQuarter(q);setSelRows(new Set());};
  // Breakdown options: Platform is always available (derived per spend row, not a manual tag);
  // any other tag dimension not already used as the primary segmentation is offered too.
  const breakdownOptions=["Platform",...(tagDimensions||[]).filter(d=>!budgetDims.includes(d))];
  const toggleExpand=key=>setExpandedRows(p=>{const nx=new Set(p);nx.has(key)?nx.delete(key):nx.add(key);return nx;});

  const pacing=useMemo(()=>computePacing({mergedNormRows,tags:campaignTags,budgetDims,budgets,year,periodType,month,quarter,today:now}),
    [mergedNormRows,campaignTags,budgetDims,budgets,year,periodType,month,quarter]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredSegments=useMemo(()=>pacing.segments.filter(seg=>{
    if(statusFilter!=="all"&&seg.status!==statusFilter)return false;
    return budgetDims.every((d,i)=>{
      const f=(segFilters[d]||"").trim().toLowerCase();
      return!f||(seg.dims[i]||"").toLowerCase().includes(f);
    });
  }),[pacing.segments,budgetDims,segFilters,statusFilter]);
  const hasSegFilters=statusFilter!=="all"||Object.values(segFilters).some(v=>(v||"").trim());
  const clearSegFilters=()=>{setSegFilters({});setStatusFilter("all");};
  const toggleRowSel=key=>setSelRows(p=>{const nx=new Set(p);nx.has(key)?nx.delete(key):nx.add(key);return nx;});
  const selAllRows=()=>setSelRows(selRows.size===filteredSegments.length?new Set():new Set(filteredSegments.map(s=>s.segKey)));

  const saveSegEdit=()=>{
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
    const matchCount=countSegmentCampaigns(campaignTags,budgetDims,segKey);
    const tagNote=matchCount>0?` This also un-tags ${matchCount} matching campaign${matchCount>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete "${label}"?\n\nThis removes all monthly budget values for this segment in ${year}.${tagNote}`))return;
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(nx[year])delete nx[year][segKey];return nx;});
    setBudgetRowMeta?.(p=>{const nx={...p};delete nx[segKey];return nx;});
    setTags?.(p=>untagSegmentCampaigns(p,budgetDims,segKey));
    setSelRows(p=>{const nx=new Set(p);nx.delete(segKey);return nx;});
    showNotif(matchCount>0?`Segment deleted — un-tagged ${matchCount} campaign${matchCount>1?"s":""}`:"Segment deleted");
  };
  const bulkDeleteSegments=()=>{
    if(!selRows.size)return;
    const n=selRows.size;
    const totalMatches=[...selRows].reduce((s,k)=>s+countSegmentCampaigns(campaignTags,budgetDims,k),0);
    const tagNote=totalMatches>0?` This also un-tags ${totalMatches} matching campaign${totalMatches>1?"s":""} — they'll show as needs review in the Tagger. Spend data itself is not affected.`:" Spend data itself is not affected.";
    if(!window.confirm(`Delete ${n} segment${n>1?"s":""}?\n\nThis removes all monthly budget values for ${n>1?"these segments":"this segment"} in ${year}.${tagNote}`))return;
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(nx[year])selRows.forEach(k=>{delete nx[year][k];});return nx;});
    setBudgetRowMeta?.(p=>{const nx={...p};selRows.forEach(k=>delete nx[k]);return nx;});
    setTags?.(p=>{let nt=p;selRows.forEach(k=>{nt=untagSegmentCampaigns(nt,budgetDims,k);});return nt;});
    showNotif(`Deleted ${n} segment${n>1?"s":""}${totalMatches>0?` — un-tagged ${totalMatches} campaign${totalMatches>1?"s":""}`:""}`);
    setSelRows(new Set());
  };

  const periodLabel=periodType==="monthly"?`${MONTHS.find(m=>m.key===month)?.label} ${year}`:periodType==="quarterly"?`${quarter} ${year}`:`FY ${year}`;
  const overallPct=pacing.totals.budget>0?pacing.totals.spend/pacing.totals.budget:null;
  const TH={fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text,padding:"10px 8px",borderBottom:`1px solid ${T.border}`,background:T.headerBg,whiteSpace:"nowrap",textAlign:"right"};
  const safeTextColor=c=>c===T.accent?T.text:c; // gold is a fine fill/border color but never body text, per the established house rule

  if(!budgetDims.length){
    return(
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40,background:T.bg}}>
        <div style={{width:52,height:52,background:T.accent,border:`3px solid ${T.text}`,boxShadow:`4px 4px 0 0 ${T.text}`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:22}}><Icon name="chart" size={24} color={T.text}/></div>
        <div style={{fontSize:17,fontWeight:700,color:T.text,marginBottom:6}}>Set up budgets first</div>
        <div style={{fontSize:13,color:T.textSub,maxWidth:340,lineHeight:1.65,marginBottom:20}}>Pacing compares spend to your budget segments. Head to Budgets, choose dimensions to budget by, and set monthly amounts.</div>
        <Btn onClick={()=>onNavigate?.("budget")} variant="success" T={T} size="md">Go to Budgets →</Btn>
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
                <button key={k} className={periodType===k?undefined:"bhq-row"} onClick={()=>changePeriodType(k)} style={{flex:1,padding:"6px 0",borderRadius:6,border:`1.5px solid ${periodType===k?T.accentHover:T.border}`,background:periodType===k?T.accent:"transparent",color:periodType===k?T.text:T.textMuted,cursor:"pointer",fontSize:11,fontWeight:periodType===k?700:400,fontFamily:"Inter,sans-serif"}}>{l}</button>
              ))}
            </div>
            <div style={{display:"flex",gap:4,marginBottom:8}}>
              {years.map(y=>(
                <button key={y} className={year===y?undefined:"bhq-row"} onClick={()=>changeYear(y)} style={{flex:1,padding:"6px 0",borderRadius:6,border:`1.5px solid ${year===y?T.accentHover:T.border}`,background:year===y?T.accent:"transparent",color:year===y?T.text:T.textMuted,cursor:"pointer",fontSize:11,fontWeight:year===y?700:400,fontFamily:"Inter,sans-serif"}}>{y}</button>
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
                <div style={{fontSize:19,fontWeight:700,color:s.color,fontFamily:"Inter,sans-serif"}}>{s.value}</div>
              </PixelPanel>
            ))}
          </div>
        </div>,
        sidebarEl
      )}

      {/* Segment table */}
      <div style={{flex:1,overflow:"auto",padding:"20px 24px 24px"}}>
        {pacing.segments.length===0?(
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
                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"Inter,sans-serif",width:120}}/>
            ))}
            <Sel value={statusFilter} onChange={setStatusFilter} T={T} style={{width:150}}>
              <option value="all">All statuses</option>
              <option value="on-track">On track</option>
              <option value="ahead">Ahead of pace</option>
              <option value="behind">Behind pace</option>
              <option value="over">Over budget</option>
              <option value="no-budget">No budget set</option>
            </Sel>
            {hasSegFilters&&<Btn onClick={clearSegFilters} variant="ghost" size="sm" T={T}>Clear filters</Btn>}
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
          <table style={{borderCollapse:"collapse",minWidth:"100%",fontSize:12}}>
            <thead><tr>
              <th style={{...TH,width:20}}/>
              <th style={{...TH,width:32,textAlign:"left"}}>
                <input type="checkbox" checked={filteredSegments.length>0&&selRows.size===filteredSegments.length} onChange={selAllRows} style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
              </th>
              {budgetDims.map(d=><th key={d} style={{...TH,textAlign:"left"}}>{d}</th>)}
              <th style={TH}>Budget</th>
              <th style={TH}>Spend PTD</th>
              <th style={TH}>Pacing</th>
              <th style={TH}>Expected</th>
              <th style={TH}>Daily Burn</th>
              <th style={TH}>Projected</th>
              <th style={{...TH,textAlign:"left"}}>Status</th>
              <th style={TH}/>
            </tr></thead>
            <tbody>
              {filteredSegments.length===0&&(
                <tr><td colSpan={4+budgetDims.length+6} style={{padding:"32px 20px",textAlign:"center",color:T.textMuted,fontSize:13}}>No segments match your filters. <span onClick={clearSegFilters} style={{color:T.accent,cursor:"pointer",fontWeight:500}}>Clear filters</span></td></tr>
              )}
              {filteredSegments.flatMap((seg)=>{
                const meta=pacingStatusMeta(seg.status,T);
                const isSel=selRows.has(seg.segKey);
                const label=budgetDims.map((d,i)=>seg.dims[i]).join(" · ");
                const isExpanded=breakdownDim&&expandedRows.has(seg.segKey);
                const rowBg=isSel?T.rowSelected:"transparent";
                const rbb=`1px dashed ${T.borderStrong}`;
                const parentRow=(
                  <tr key={seg.segKey} className={isSel?undefined:"bhq-tr"} style={{background:rowBg}}>
                    <td style={{padding:"8px 4px",borderBottom:rbb,textAlign:"center"}}>
                      {breakdownDim&&<button onClick={()=>toggleExpand(seg.segKey)} title={`Break down by ${breakdownDim}`}
                        style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11,padding:2,lineHeight:1,transform:isExpanded?"rotate(90deg)":"none",transition:"transform 0.12s"}}>▸</button>}
                    </td>
                    <td style={{padding:"8px 8px",borderBottom:rbb}}>
                      <input type="checkbox" checked={isSel} onChange={()=>toggleRowSel(seg.segKey)} style={{cursor:"pointer",accentColor:T.accent,width:13,height:13}}/>
                    </td>
                    {seg.dims.map((v,i)=><td key={i} style={{padding:"8px 14px",borderBottom:rbb,whiteSpace:"nowrap"}}>
                      {editingSegVal?.segKey===seg.segKey&&editingSegVal?.dim===budgetDims[i]?(
                        <input autoFocus value={editSegVal} onChange={e=>setEditSegVal(e.target.value)}
                          onBlur={saveSegEdit} onKeyDown={e=>{if(e.key==="Enter")saveSegEdit();if(e.key==="Escape"){setEditingSegVal(null);setEditSegVal("");}}}
                          style={{background:T.inputBg,border:`1px solid ${T.accentBorder}`,borderRadius:6,color:T.text,padding:"3px 8px",fontSize:11,outline:"none",fontFamily:"Inter,sans-serif",minWidth:80}}/>
                      ):(
                        <Pill color={T.text} bg={T.pill} border={T.pillBorder} style={{fontFamily:"Inter,sans-serif",fontWeight:600,cursor:"text",borderRadius:6}}
                          onClick={()=>{setEditingSegVal({segKey:seg.segKey,dim:budgetDims[i]});setEditSegVal(v);}}>{v}</Pill>
                      )}
                      {i===seg.dims.length-1&&seg.budget>0&&seg.matchCount===0&&(
                        <WarnTip T={T} text="No tagged campaigns match this segment. Spend will always show as $0 here, regardless of period, until a campaign is tagged with this exact combination in the Tagger."/>
                      )}
                    </td>)}
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"Inter,sans-serif",color:T.text}}>{seg.budget>0?fmtFull(seg.budget):"—"}</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"Inter,sans-serif",color:T.text}}>{fmtFull(seg.spend)}</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right"}}>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",gap:8}}>
                        <span style={{fontFamily:"Inter,sans-serif",fontWeight:600,color:safeTextColor(meta.color)}}>{seg.actualPct!=null?`${Math.round(seg.actualPct*100)}%`:"—"}</span>
                        <PacingBar actualPct={seg.actualPct} expectedPct={pacing.expectedPct} status={seg.status} T={T}/>
                      </div>
                    </td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"Inter,sans-serif",color:T.textMuted}}>{Math.round(pacing.expectedPct*100)}%</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"Inter,sans-serif",color:T.text}}>{fmtFull(seg.dailyRate)}/day</td>
                    <td style={{padding:"8px 8px",borderBottom:rbb,textAlign:"right"}}>
                      <div style={{fontFamily:"Inter,sans-serif",color:T.text}}>{seg.projected!=null?fmtFull(seg.projected):"—"}</div>
                      {seg.projectedVariance!=null&&<div style={{fontSize:10,color:seg.projectedVariance>0?T.danger:T.success,fontFamily:"Inter,sans-serif"}}>{fmtSigned(seg.projectedVariance)}</div>}
                    </td>
                    <td style={{padding:"8px 14px",borderBottom:rbb}}>
                      <Pill color={safeTextColor(meta.color)} bg={meta.bg} border={meta.border}>{meta.label}</Pill>
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
                    <td colSpan={budgetDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:11,color:T.textMuted,fontStyle:"italic"}}>No spend in this period to break down by {breakdownDim}</td>
                    <td colSpan={8} style={{borderBottom:rbb}}/>
                  </tr>
                ]:breakdown.map(b=>(
                  <tr key={seg.segKey+"-"+b.value} style={{background:rowBg}}>
                    <td/><td/>
                    <td colSpan={budgetDims.length} style={{padding:"6px 14px 6px 34px",borderBottom:rbb,fontSize:12,color:T.textSub}}>↳ {b.value}</td>
                    <td style={{borderBottom:rbb}}/>
                    <td style={{padding:"6px 8px",borderBottom:rbb,textAlign:"right",fontFamily:"Inter,sans-serif",fontSize:12}}>
                      {fmtFull(b.spend)}<span style={{color:T.textMuted,marginLeft:6,fontSize:11}}>({Math.round(b.pct*100)}%)</span>
                    </td>
                    <td colSpan={6} style={{borderBottom:rbb}}/>
                  </tr>
                ));
                return[parentRow,...breakdownRows];
              })}
            </tbody>
          </table>
          </>
        )}
      </div>
      {notif&&<div style={{position:"fixed",bottom:20,right:20,background:T.success,color:"#fff",padding:"10px 16px",borderRadius:8,fontSize:13,fontWeight:600,zIndex:100,boxShadow:T.shadowMd,fontFamily:"Inter,sans-serif"}}>{notif}</div>}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function BudgetHQ(){
  const[themeKey,setThemeKey]=useState("light");
  const T=THEMES[themeKey];
  const[width,setWidth]=useState(typeof window!=="undefined"?window.innerWidth:1200);
  useEffect(()=>{const h=()=>setWidth(window.innerWidth);window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);
  const isMobile=width<768;

  const[step,setStep]=useState("upload");
  const[view,setView]=useState("dashboard");
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
  const[selectedTagFilters,setSelectedTagFilters]=useState(new Set()); // Set of "dim:val"
  const toggleTagFilter=useCallback((dim,val)=>{
    const key=`${dim}:${val}`;
    setSelectedTagFilters(p=>{const nx=new Set(p);nx.has(key)?nx.delete(key):nx.add(key);return nx;});
  },[]);
  const[fStatus,setFStatus]=useState("all");
  const fileRef=useRef();

  const[budgets,setBudgets]=useState({});
  const[budgetDims,setBudgetDims]=useState([]);
  const[budgetRowMeta,setBudgetRowMeta]=useState({}); // {segKey: {dim: value}}
  const[budgetMetaDims,setBudgetMetaDims]=useState([]); // annotation dims on budget rows
  const[budgetImportMeta,setBudgetImportMeta]=useState({}); // {year: {hasQuarterlyTotals, hasAnnualTotal}} — captured at import time, used to inform the export-time AI granularity suggestion

  // ── Version history ──
  const[fileMenuOpen,setFileMenuOpen]=useState(false);
  const[versionHistoryOpen,setVersionHistoryOpen]=useState(false);
  const[versions,setVersions]=useState([]);
  const[versionsLoading,setVersionsLoading]=useState(false);
  const[nameVersionOpen,setNameVersionOpen]=useState(false);
  const[nameVersionInput,setNameVersionInput]=useState("");
  const[pendingVersionLabel,setPendingVersionLabel]=useState(null); // {label,trigger} — set right after a mutation, consumed once state has actually settled (see effect below)

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
    const record={id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,timestamp:Date.now(),label,trigger,snapshot};
    saveVersionRecord(record).catch(e=>console.error("[version save]",e));
  },[]);
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
    setFileMenuOpen(false);setVersionHistoryOpen(true);setVersionsLoading(true);
    listVersionRecords().then(setVersions).catch(e=>{console.error("[version list]",e);setVersions([]);}).finally(()=>setVersionsLoading(false));
  },[]);
  const saveNamedVersion=useCallback(()=>{
    const label=nameVersionInput.trim();
    if(!label)return;
    snapshotNow(label,"manual");
    setNameVersionOpen(false);setNameVersionInput("");setFileMenuOpen(false);
    showNotif(`Saved version "${label}"`);
  },[nameVersionInput,snapshotNow]);
  const restoreVersion=useCallback(record=>{
    if(!window.confirm(`Restore "${record.label}"?\n\nFrom ${new Date(record.timestamp).toLocaleString()}. Your current data will be saved as a new version first, so you can always come back to it.\n\nThis replaces your current Tagger and Budget data.`))return;
    snapshotNow("Before restoring an earlier version","pre_restore");
    const s=record.snapshot||{};
    setTags(s.tags||{});setTagDims(s.tagDims||DEFAULT_DIMS);setMergedNormRows(s.mergedNormRows||[]);
    setBudgets(s.budgets||{});setBudgetDims(s.budgetDims||[]);setBudgetRowMeta(s.budgetRowMeta||{});setBudgetMetaDims(s.budgetMetaDims||[]);setBudgetImportMeta(s.budgetImportMeta||{});
    setStep((s.mergedNormRows||[]).length?"tag":"upload");
    setVersionHistoryOpen(false);
    showNotif("Version restored");
  },[snapshotNow]);
  const deleteVersion=useCallback((id,e)=>{
    e.stopPropagation();
    if(!window.confirm("Delete this saved version? This can't be undone."))return;
    deleteVersionRecord(id).then(()=>setVersions(p=>p.filter(v=>v.id!==id))).catch(err=>console.error("[version delete]",err));
  },[]);

  useEffect(()=>{try{
    // Migrate legacy tags from before the two-level campaign group + campaign model: old keys
    // were the plain campaign name alone (e.g. "My Campaign"), but campaignKey() now looks up
    // composite keys (e.g. "My Campaign||My Campaign" when group==name). Any key without the
    // "||" separator is legacy and gets rewritten so existing tagged data isn't orphaned.
    const t=localStorage.getItem("paidhq_tags");
    if(t){
      const parsed=JSON.parse(t);
      const migrated={};
      Object.entries(parsed).forEach(([k,v])=>{migrated[k.includes("||")?k:campaignKey(k,k)]=v;});
      setTags(migrated);
    }
    const d=localStorage.getItem("paidhq_dims");if(d)setTagDims(JSON.parse(d));
    const th=localStorage.getItem("paidhq_theme");if(th)setThemeKey(th);
    const b=localStorage.getItem("paidhq_budgets");if(b)setBudgets(JSON.parse(b));
    const bd=localStorage.getItem("paidhq_budget_dims");if(bd)setBudgetDims(JSON.parse(bd));
    const bm=localStorage.getItem("paidhq_budget_meta");if(bm)setBudgetRowMeta(JSON.parse(bm));
    const bmd=localStorage.getItem("paidhq_budget_meta_dims");if(bmd)setBudgetMetaDims(JSON.parse(bmd));
    const bim=localStorage.getItem("paidhq_budget_import_meta");if(bim)setBudgetImportMeta(JSON.parse(bim));
    const v=localStorage.getItem("paidhq_view");if(v&&["dashboard","tagger","budget","pacing","settings"].includes(v))setView(v);
    const le=localStorage.getItem("paidhq_last_export_email");if(le)setEmailExportTo(le);
    // Restore spend data — legacy rows predate campaign_group_name, so backfill it from
    // campaign_name (matches how normalizeRows falls back when a CSV has no second level).
    const sr=localStorage.getItem("paidhq_rows");
    if(sr){
      const rows=JSON.parse(sr).map(r=>r.campaign_group_name?r:{...r,campaign_group_name:r.campaign_name});
      setMergedNormRows(rows);setStep("tag");
    }
  }catch(e){};},[]);
  useEffect(()=>{try{localStorage.setItem("paidhq_tags",JSON.stringify(tags));}catch(e){};},[tags]);
  useEffect(()=>{try{localStorage.setItem("paidhq_dims",JSON.stringify(tagDims));}catch(e){};},[tagDims]);
  useEffect(()=>{try{localStorage.setItem("paidhq_theme",themeKey);}catch(e){};},[themeKey]);
  useEffect(()=>{try{localStorage.setItem("paidhq_budgets",JSON.stringify(budgets));}catch(e){};},[budgets]);
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_dims",JSON.stringify(budgetDims));}catch(e){};},[budgetDims]);
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_meta",JSON.stringify(budgetRowMeta));}catch(e){};},[budgetRowMeta]);
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_meta_dims",JSON.stringify(budgetMetaDims));}catch(e){};},[budgetMetaDims]);
  useEffect(()=>{try{localStorage.setItem("paidhq_view",view);}catch(e){};},[view]);
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_import_meta",JSON.stringify(budgetImportMeta));}catch(e){};},[budgetImportMeta]);
  useEffect(()=>{try{
    if(mergedNormRows.length){
      localStorage.setItem("paidhq_rows",JSON.stringify(mergedNormRows));
    }
  }catch(e){};},[mergedNormRows]);

  // ── Platform sync ──────────────────────────────────────────────────────────
  const[syncState,setSyncState]=useState({}); // {platform: "idle"|"loading"|"done"|"error"}
  const PLATFORMS=[
    {key:"linkedin",label:"LinkedIn",status:"live",color:"#0A66C2"},
    {key:"bing",label:"Bing",status:"live",color:"#00809D"},
    {key:"google",label:"Google",status:"csv",color:"#EA4335"},
    {key:"meta",label:"Meta",status:"csv",color:"#1877F2"},
    {key:"capterra",label:"Capterra",status:"live",color:"#FF7043"},
  ];
  const[lastSyncRange,setLastSyncRange]=useState(()=>{
    try{const s=localStorage.getItem("paidhq_sync_range");return s?JSON.parse(s):null;}catch(e){return null;}
  });
  const[syncDateRange,setSyncDateRange]=useState(()=>{
    const now=new Date();
    const y=now.getFullYear();
    const q=Math.floor(now.getMonth()/3);
    const qStart=new Date(y,q*3,1);
    const qEnd=new Date(y,q*3+3,0);
    return{
      start:qStart.toISOString().slice(0,10),
      end:qEnd.toISOString().slice(0,10),
    };
  });

  const syncPlatform=useCallback(async(platformKey)=>{
    setSyncState(p=>({...p,[platformKey]:"loading"}));
    try{
      const res=await fetch("/api/spend",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({platform:platformKey,startDate:syncDateRange.start,endDate:syncDateRange.end}),
      });
      if(!res.ok){
        const err=await res.json();
        throw new Error(err.error||"API error");
      }
      const{rows}=await res.json();
      if(rows.length===0) throw new Error("No spend data returned for this date range");
      // Merge with existing data — don't replace
      setMergedNormRows(prev=>mergeRows(prev,rows));
      setStep("tag");
      setSyncState(p=>({...p,[platformKey]:"done"}));
      setLastSyncRange({start:syncDateRange.start,end:syncDateRange.end});
      try{localStorage.setItem("paidhq_sync_range",JSON.stringify({start:syncDateRange.start,end:syncDateRange.end}));}catch(e){}
      checkpoint(`Synced ${platformKey} spend data (${rows.length} rows)`,"tagger_sync");
      showNotif(`Loaded ${rows.length} ${platformKey} campaigns — merged with existing data`);
    }catch(e){
      setSyncState(p=>({...p,[platformKey]:"error:"+e.message}));
    }
  },[syncDateRange,checkpoint]);

  const handleFile=useCallback(file=>{
    if(!file)return;setFileName(file.name);
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      setRawRows(r.data);setHeaders(r.meta.fields||[]);setColMap(autoDetect(r.meta.fields||[]));
      // Carry-forward: count how many campaigns already have tags
      const existingTagCount=r.data.reduce((count,row)=>{
        const name=(row[autoDetect(r.meta.fields||[]).campaign_group_name]||"").trim();
        return count+(name&&Object.keys(tags[name]||{}).length>0?1:0);
      },0);
      if(existingTagCount>0) showNotif(`${existingTagCount} campaigns already tagged from previous session`);
      setStep("map");
    }});
  },[tags]);
  const handleDrop=useCallback(e=>{e.preventDefault();setDragOver(false);const f=e.dataTransfer.files[0];if(f)handleFile(f);},[handleFile]);

  // "key" is the composite identity (campaign group + campaign) used everywhere tags/selection
  // are looked up — ad set/ad group names often repeat across different campaigns, so the leaf
  // name alone isn't a safe identity. "name" (leaf) and "groupName" stay separate for display.
  const campaigns=useMemo(()=>{
    if(!mergedNormRows.length)return[];
    const map={};
    mergedNormRows.forEach(row=>{
      const name=row.campaign_name;if(!name)return;
      const groupName=row.campaign_group_name||name;
      const key=campaignKey(groupName,name);
      const platform=derivePlatform(groupName,name,row.platform,row.campaign_type);
      if(!map[key])map[key]={key,name,groupName,platform,spend:0,rows:0};
      map[key].spend+=row.spend;
      map[key].rows++;
    });
    return Object.values(map);
  },[mergedNormRows]);
  const allPlats=useMemo(()=>[...new Set(campaigns.map(c=>c.platform))].sort(),[campaigns]);
  const stats=useMemo(()=>{
    const totalSpend=campaigns.reduce((s,c)=>s+c.spend,0);
    const tagged=campaigns.filter(c=>Object.keys(tags[c.key]||{}).length>0).length;
    const dates=mergedNormRows.map(r=>r.date).filter(Boolean).sort();
    const derivedRange=dates.length?`${dates[0]} → ${dates[dates.length-1]}`:"";
    const displayRange=lastSyncRange?`${lastSyncRange.start} → ${lastSyncRange.end}`:derivedRange;
    return{total:campaigns.length,tagged,untagged:campaigns.length-tagged,totalSpend,totalRows:mergedNormRows.length,dateRange:displayRange};
  },[campaigns,tags,rawRows,colMap,lastSyncRange]);

  const filtered=useMemo(()=>{let r=campaigns.filter(c=>{
    if(fCamp&&!c.name.toLowerCase().includes(fCamp.toLowerCase()))return false;
    if(fCampExclude&&c.name.toLowerCase().includes(fCampExclude.toLowerCase()))return false;
    if(fGroup&&!c.groupName.toLowerCase().includes(fGroup.toLowerCase()))return false;
    if(fGroupExclude&&c.groupName.toLowerCase().includes(fGroupExclude.toLowerCase()))return false;
    if(fPlat&&c.platform!==fPlat)return false;
    if(fSMin&&c.spend<parseFloat(fSMin))return false;
    if(fSMax&&c.spend>parseFloat(fSMax))return false;
    if(fTag){const ts=tags[c.key]||{};const s=Object.entries(ts).map(([d,v])=>`${d}:${v}`).join(" ").toLowerCase();if(!s.includes(fTag.toLowerCase()))return false;}
    if(fTagExclude){const ts=tags[c.key]||{};const s=Object.entries(ts).map(([d,v])=>`${d}:${v}`).join(" ").toLowerCase();if(s.includes(fTagExclude.toLowerCase()))return false;}
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
  });return[...r].sort((a,b)=>{if(sortCol==="spend")return sortDir==="asc"?a.spend-b.spend:b.spend-a.spend;if(sortCol==="campaign")return sortDir==="asc"?a.name.localeCompare(b.name):b.name.localeCompare(a.name);if(sortCol==="group")return sortDir==="asc"?a.groupName.localeCompare(b.groupName):b.groupName.localeCompare(a.groupName);if(sortCol==="platform")return sortDir==="asc"?a.platform.localeCompare(b.platform):b.platform.localeCompare(a.platform);const at=Object.keys(tags[a.key]||{}).length;const bt=Object.keys(tags[b.key]||{}).length;return sortDir==="asc"?at-bt:bt-at;});},[campaigns,fCamp,fCampExclude,fGroup,fGroupExclude,fPlat,fSMin,fSMax,fTag,fTagExclude,selectedTagFilters,fStatus,sortCol,sortDir,tags]);

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
  const applyTags=useCallback(()=>{if(!applyDim||!applyVal||!selected.size)return;pushHistory(tags);const u={};selected.forEach(n=>{u[n]={...(tags[n]||{}),[applyDim]:applyVal};});setTags(p=>({...p,...u}));showNotif(`Tagged ${selected.size} campaigns — ${applyDim}: ${applyVal}`);setSelected(new Set());setApplyVal("");},[applyDim,applyVal,selected,tags,pushHistory]);
  const applySug=useCallback((dim,val)=>{pushHistory(tags);const u={};filtered.forEach(c=>{if(!(tags[c.key]?.[dim]))u[c.key]={...(tags[c.key]||{}),[dim]:val};});setTags(p=>({...p,...u}));showNotif(`Applied ${dim}: ${val} to ${Object.keys(u).length} campaigns`);},[filtered,tags,pushHistory]);
  const removeTag=useCallback((cn,dim)=>{pushHistory(tags);setTags(p=>{const ts={...(p[cn]||{})};delete ts[dim];return{...p,[cn]:ts};});},[tags,pushHistory]);
  const bulkRemoveTag=useCallback(dim=>{if(!dim||!selected.size)return;pushHistory(tags);setTags(p=>{const nx={...p};selected.forEach(n=>{if(nx[n]){const ts={...nx[n]};delete ts[dim];nx[n]=ts;}});return nx;});showNotif(`Removed ${dim} tag from ${selected.size} campaigns`);setSelected(new Set());},[selected,tags,pushHistory]);
  const saveEdit=useCallback(()=>{
    if(!editingTag)return;
    const trimmed=editVal.trim();
    const current=(tags[editingTag.campaign]||{})[editingTag.dim];
    if(trimmed===current){setEditingTag(null);setEditVal("");return;}
    pushHistory(tags);
    setTags(p=>{
      const ts={...(p[editingTag.campaign]||{})};
      if(trimmed)ts[editingTag.dim]=trimmed;else delete ts[editingTag.dim];
      return{...p,[editingTag.campaign]:ts};
    });
    setEditingTag(null);setEditVal("");
  },[editingTag,editVal,tags,pushHistory]);
  const exportTags=()=>{
    const header=["Campaign Group","Campaign","Platform","Spend",...tagDims];
    const rows=[header,...campaigns.map(c=>[c.groupName,c.name,c.platform,c.spend.toFixed(2),...tagDims.map(d=>(tags[c.key]||{})[d]||"")])];
    downloadCSV(rows,"budgethq-tags.csv");
    showNotif("Tags exported");
  };

  const importTagsRef=useRef(null);
  const importTagsFromCSV=useCallback((file)=>{
    if(!file)return;
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      const rows=r.data;
      const fields=r.meta.fields||[];
      // Detect campaign group + campaign columns (exported files have both; older exports from
      // before the two-level model only have "Campaign", which is treated as both levels).
      const groupCol=fields.find(f=>/campaign.?group/i.test(f));
      const campCol=fields.find(f=>/campaign/i.test(f)&&f!==groupCol);
      if(!campCol){showNotif("Could not find Campaign column");return;}
      // Detect dimension columns (exclude Campaign Group, Campaign, Platform, Spend, Date)
      const skipCols=new Set(["campaign group","campaign","platform","spend","date","impressions","clicks","campaign_name","campaign_group_name","campaign_id"]);
      const dimCols=fields.filter(f=>!skipCols.has(f.toLowerCase())&&f!==campCol&&f!==groupCol);
      let restored=0;
      setTags(p=>{
        const nx={...p};
        rows.forEach(row=>{
          const name=(row[campCol]||"").trim();
          if(!name)return;
          const groupName=(groupCol?row[groupCol]:"")?.trim()||name;
          const key=campaignKey(groupName,name);
          const t={...(nx[key]||{})};
          dimCols.forEach(d=>{if(row[d]&&row[d].trim())t[d]=row[d].trim();});
          nx[key]=t;
          restored++;
        });
        return nx;
      });
      // Add any new dimensions found in the file
      const newDims=dimCols.filter(d=>!tagDims.includes(d));
      if(newDims.length)setTagDims(p=>[...new Set([...p,...newDims])]);
      showNotif(`Restored tags for ${restored} campaigns`);
    }});
  },[tags,tagDims]);
  const toggleSel=n=>setSelected(p=>{const nx=new Set(p);nx.has(n)?nx.delete(n):nx.add(n);return nx;});
  const selAll=()=>setSelected(selected.size===filtered.length?new Set():new Set(filtered.map(c=>c.key)));
  // Isolate-and-delete-an-import: filter the table down to what you want gone (e.g. Platform =
  // Google), select-all within that filter, then this removes exactly those campaigns' spend
  // rows from mergedNormRows. Tags are left untouched (matches the single-row "Remove" behavior)
  // so re-syncing or re-uploading the same campaigns later restores them pre-tagged.
  const bulkRemoveCampaigns=useCallback(()=>{
    if(!selected.size)return;
    const n=selected.size;
    const removedSpend=campaigns.filter(c=>selected.has(c.key)).reduce((s,c)=>s+c.spend,0);
    if(!window.confirm(`Remove ${n} campaign${n>1?"s":""} (${fmt$(removedSpend)} total spend) from this dataset?\n\nThis only affects the current session's spend data — your tags are kept. You can re-sync or re-upload to restore it.\n\nA version is saved first — you can undo from ··· → Version History.`))return;
    snapshotNow(`Before removing ${n} campaign${n>1?"s":""} from dataset (${fmt$(removedSpend)})`,"pre_clear");
    setMergedNormRows(prev=>prev.filter(r=>!selected.has(campaignKey(r.campaign_group_name,r.campaign_name))));
    showNotif(`Removed ${n} campaign${n>1?"s":""} — ${fmt$(removedSpend)}`);
    setSelected(new Set());
  },[selected,campaigns,snapshotNow]);
  const addDim=()=>{const n=newDim.trim();if(!n||tagDims.includes(n))return;setTagDims(p=>[...p,n]);setNewDim("");};
  const doSort=col=>{setSortDir(sortCol===col&&sortDir==="desc"?"asc":"desc");setSortCol(col);};
  const clearF=()=>{setFCamp("");setFCampExclude("");setFGroup("");setFGroupExclude("");setFPlat("");setFSMin("");setFSMax("");setFTag("");setFTagExclude("");setSelectedTagFilters(new Set());setFStatus("all");};

  // Cmd+Z / Ctrl+Z undo
  useEffect(()=>{
    const handler=(e)=>{if((e.metaKey||e.ctrlKey)&&e.key==="z"&&!e.shiftKey){e.preventDefault();undoTags();}};
    window.addEventListener("keydown",handler);return()=>window.removeEventListener("keydown",handler);
  },[undoTags]);
  const hasF=fCamp||fCampExclude||fGroup||fGroupExclude||fPlat||fSMin||fSMax||fTag||fTagExclude||selectedTagFilters.size>0||fStatus!=="all";
  const canProceed=colMap.campaign_group_name&&colMap.spend;

  // Settings — independent data-clear actions. Reporting has no state of its own (it's a
  // computed pacing view over Budget + Tagger data), so there's no separate "clear reporting"
  // action — clearing either of the two source datasets is reflected there automatically.
  const clearTaggerData=()=>{
    if(!window.confirm("Clear all Tagger data?\n\nThis removes every imported spend row, every campaign tag, and your custom tag dimensions. Budget allocations are not affected.\n\nA version of your current data is saved first — you can restore it from File → Version History.\n\nThis cannot be undone from here."))return;
    snapshotNow("Before clearing Tagger data","pre_clear");
    setMergedNormRows([]);setTags({});setTagDims(DEFAULT_DIMS);setColMap({});setStep("upload");setLastSyncRange(null);setTagsHistory([]);
    try{["paidhq_rows","paidhq_tags","paidhq_dims","paidhq_sync_range"].forEach(k=>localStorage.removeItem(k));}catch(e){}
    showNotif("Tagger data cleared");
  };
  const clearBudgetData=()=>{
    if(!window.confirm("Clear all Budget data?\n\nThis removes every budget allocation, budget segment, and annotation dimension across all years. Tagged campaign data is not affected.\n\nA version of your current data is saved first — you can restore it from File → Version History.\n\nThis cannot be undone from here."))return;
    snapshotNow("Before clearing Budget data","pre_clear");
    setBudgets({});setBudgetDims([]);setBudgetRowMeta({});setBudgetMetaDims([]);setBudgetImportMeta({});
    try{["paidhq_budgets","paidhq_budget_dims","paidhq_budget_meta","paidhq_budget_meta_dims","paidhq_budget_import_meta"].forEach(k=>localStorage.removeItem(k));}catch(e){}
    showNotif("Budget data cleared");
  };
  const clearAllData=()=>{
    if(!window.confirm("Delete ALL data for this instance?\n\nThis clears Tagger data (spend rows, tags, dimensions) AND Budget data (allocations, segments) across every year. Your theme and layout preferences are kept.\n\nA version of your current data is saved first — you can restore it from File → Version History.\n\nThis cannot be undone from here."))return;
    snapshotNow("Before deleting all data","pre_clear");
    clearTaggerDataSilent();clearBudgetDataSilent();
    showNotif("All data deleted");
  };
  function clearTaggerDataSilent(){
    setMergedNormRows([]);setTags({});setTagDims(DEFAULT_DIMS);setColMap({});setStep("upload");setLastSyncRange(null);setTagsHistory([]);
    try{["paidhq_rows","paidhq_tags","paidhq_dims","paidhq_sync_range"].forEach(k=>localStorage.removeItem(k));}catch(e){}
  }
  function clearBudgetDataSilent(){
    setBudgets({});setBudgetDims([]);setBudgetRowMeta({});setBudgetMetaDims([]);setBudgetImportMeta({});
    try{["paidhq_budgets","paidhq_budget_dims","paidhq_budget_meta","paidhq_budget_meta_dims","paidhq_budget_import_meta"].forEach(k=>localStorage.removeItem(k));}catch(e){}
  }

  // ── Export (the ··· menu's "Export [view]" + "Email a copy") ──
  // dashboard/tagger/budget/pacing each build their own report from state that already lives in
  // this top-level component — settings has nothing to export, so exportableView is null there
  // and the dots menu just shows the version-history items on its own.
  const exportableView=EXPORTABLE_VIEWS[view]||null;
  const buildCurrentReport=useCallback(()=>{
    if(!exportableView)return null;
    return exportableView.build({mergedNormRows,tags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims});
  },[exportableView,mergedNormRows,tags,tagDims,budgets,budgetDims,budgetRowMeta,budgetMetaDims]);
  const handleExportDownload=useCallback(format=>{
    const report=buildCurrentReport();
    if(!report||!exportableView)return;
    downloadReport(report,format,exportableView.filenameBase);
    showNotif(`Exported ${exportableView.label} as ${EXPORT_FORMATS.find(f=>f.key===format)?.label||format.toUpperCase()}`);
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

  const SH=({col,label})=>(<span onClick={()=>doSort(col)} style={{fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.text,textDecoration:sortCol===col?"underline":"none",textUnderlineOffset:2,cursor:"pointer",userSelect:"none",display:"inline-flex",alignItems:"center",gap:3}}>{label}<span style={{opacity:0.7,fontSize:9}}>{sortCol===col?(sortDir==="desc"?"▾":"▴"):"⇅"}</span></span>);
  const fIn={background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:11,outline:"none",fontFamily:"Inter,sans-serif",width:"100%",marginTop:3};

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

  return(
    <div style={{height:"100vh",width:"100vw",display:"flex",flexDirection:"column",background:T.bg,color:T.text,fontFamily:"Inter,sans-serif",overflow:"hidden",position:"relative"}}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>

      {/* ── TOP BAR ──
          The divider under the bar is NOT one continuous border on this outer div — that made
          "erasing" it under just the active tab fragile (overlap/margin tricks kept leaving a
          hairline). Instead every piece (logo, each tab, the trailing filler, actions) draws its
          OWN bottom border at the same fixed height, and the active tab's is simply colored to
          match the body (T.bg) instead of T.border, so it reads as blank/seamless there.
          The "···" menu on the right (Notion-style) covers file-level actions (version history)
          instead of a dedicated "File" trigger — its dropdown is positioned relative to this
          outer wrapper so it isn't clipped by any child's overflow:hidden. ── */}
      <div style={{display:"flex",alignItems:"stretch",height:46,flexShrink:0,background:T.topbarBg,zIndex:30,position:"relative"}}>
        <div style={{width:isMobile?undefined:(statsOpen?statsWidth:56),display:"flex",alignItems:"center",justifyContent:statsOpen||isMobile?"flex-start":"center",gap:8,padding:statsOpen||isMobile?"0 16px":0,flexShrink:0,boxSizing:"border-box",borderBottom:`1px solid ${T.border}`,borderRight:isMobile?"none":`1px solid ${T.border}`,overflow:"hidden",transition:statsResizing.current?"none":"width 0.15s"}}>
          <div style={{width:22,height:22,borderRadius:6,background:T.accent,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <Icon name="bolt" size={13} color={T.text}/>
          </div>
          {(statsOpen||isMobile)&&<div style={{fontSize:14,fontWeight:700,color:T.text,letterSpacing:"-0.3px",whiteSpace:"nowrap"}}>BudgetHQ</div>}
        </div>
        <div style={{display:"flex",alignItems:"flex-end",gap:2,flex:1,paddingLeft:isMobile?4:16,minWidth:0,overflowX:isMobile?"auto":"visible"}}>
          {NAV.map(item=>{
            const active=view===item.key;
            return <button key={item.key} className={active?undefined:"bhq-tab"} onClick={()=>{
                if(item.key==="tagger"){if(step!=="tag")setStep("upload");setView("tagger");}
                else setView(item.key);
              }} style={{display:"flex",alignItems:"center",gap:7,padding:isMobile?"0 12px":"0 16px",height:38,marginTop:8,boxSizing:"border-box",flexShrink:0,borderRadius:"8px 8px 0 0",borderTop:`1px solid ${active?T.border:"transparent"}`,borderLeft:`1px solid ${active?T.border:"transparent"}`,borderRight:`1px solid ${active?T.border:"transparent"}`,borderBottom:`1px solid ${active?T.bg:T.border}`,background:active?T.bg:"transparent",color:active?T.text:T.textSub,fontSize:13,fontWeight:active?600:500,cursor:"pointer",fontFamily:"Inter,sans-serif",whiteSpace:"nowrap",transition:"background 0.12s,color 0.12s"}}>
              <Icon name={item.icon} size={15} color={active?T.text:T.textSub}/>
              {!isMobile&&item.label}
            </button>;
          })}
          {/* Trailing filler — covers the gap after the last tab so the divider still runs the
              full width of the tab strip before the right-side actions begin. */}
          <div style={{flex:1,alignSelf:"stretch",boxSizing:"border-box",borderBottom:`1px solid ${T.border}`}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?4:8,padding:isMobile?"0 8px":"0 14px",flexShrink:0,boxSizing:"border-box",borderBottom:`1px solid ${T.border}`}}>
          {step==="tag"&&!isMobile&&(
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:20}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:stats.untagged>0?T.warning:T.success,flexShrink:0}}/>
              <span style={{fontSize:11,color:T.textSub}}><span style={{color:T.text,fontWeight:600}}>{stats.tagged}</span>/{stats.total} tagged</span>
            </div>
          )}
          {step==="tag"&&<Btn onClick={()=>setStep("upload")} variant="ghost" size="sm" T={T}>{isMobile?"↑":"↑ Add data"}</Btn>}
          {step==="tag"&&mergedNormRows.length>0&&<Btn onClick={()=>{setMergedNormRows([]);setStep("upload");setLastSyncRange(null);try{localStorage.removeItem("paidhq_rows");localStorage.removeItem("paidhq_sync_range");}catch(e){};}} variant="ghost" size="sm" T={T} style={{color:T.danger}}>{isMobile?"✕":"✕ Clear all"}</Btn>}
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
                      style={{flex:1,padding:"6px 0",borderRadius:6,border:`1px solid ${T.border}`,background:"transparent",color:T.textSub,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"Inter,sans-serif"}}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <button className="bhq-row" onClick={()=>{setFileMenuOpen(false);openEmailExport();}}
                  style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"Inter,sans-serif",textAlign:"left"}}>
                  <Icon name="mail" size={14} color={T.textSub}/> Email a copy…
                </button>
                <div style={{height:1,background:T.border,margin:"6px 4px"}}/>
              </>)}
              <button className="bhq-row" onClick={()=>{setFileMenuOpen(false);setNameVersionOpen(true);}}
                style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"Inter,sans-serif",textAlign:"left"}}>
                <Icon name="save" size={14} color={T.textSub}/> Name current version…
              </button>
              <button className="bhq-row" onClick={openVersionHistory}
                style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:13,cursor:"pointer",fontFamily:"Inter,sans-serif",textAlign:"left"}}>
                <Icon name="clock" size={14} color={T.textSub}/> Version history
              </button>
            </div>
          </>)}
        </div>
      </div>

      {/* ── BODY ROW ── */}
      <div style={{flex:1,display:"flex",flexDirection:"row",overflow:"hidden",minHeight:0,position:"relative"}}>

      {/* ── STATS SIDEBAR ── */}
      {!isMobile&&(<>
        <aside style={{width:statsOpen?statsWidth:0,flexShrink:0,background:T.sidebarBg,borderRight:statsOpen?`1px solid ${T.border}`:"none",display:"flex",flexDirection:"column",padding:statsOpen?"18px 14px":0,overflow:"hidden",gap:12,zIndex:20,transition:statsResizing.current?"none":"width 0.15s,padding 0.15s"}}>

          {view==="budget"?(
            <div ref={setBudgetSidebarEl} style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="pacing"?(
            <div ref={setPacingSidebarEl} style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}/>
          ):view==="tagger"?(
            // Lives directly in this component (unlike Budget/Pacing, the Tagger flow isn't a
            // separate child component) so no portal is needed — just render it here in place.
            <div style={{flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column"}}>
              <SectionLabel T={T} style={{marginBottom:8}}>Tag Dimensions</SectionLabel>
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:8}}>
                {tagDims.map(dim=>(
                  <div key={dim} className={applyDim===dim?undefined:"bhq-row"} onClick={()=>setApplyDim(dim)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 8px",borderRadius:6,cursor:"pointer",background:applyDim===dim?T.accentBg:"transparent",border:applyDim===dim?`1px solid ${T.accentBorder}`:"1px solid transparent"}}>
                    <span style={{fontSize:13,color:T.text,fontWeight:applyDim===dim?700:400}}>{dim}</span>
                    <span style={{fontSize:11,color:T.textMuted,fontFamily:"Inter,sans-serif"}}>{Object.values(tags).filter(t=>t[dim]).length}</span>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:5,marginBottom:12}}>
                <Inp value={newDim} onChange={setNewDim} placeholder="New dimension…" T={T} onKeyDown={e=>e.key==="Enter"&&addDim()} style={{fontSize:12,padding:"5px 8px"}}/>
                <Btn onClick={addDim} variant="subtle" size="sm" T={T}>+</Btn>
              </div>
              <Divider T={T}/>
              <div style={{padding:"12px 0",flex:1}}>
                <SectionLabel T={T}>Overview</SectionLabel>
                {[{l:"Campaigns",v:stats.total.toString()},{l:"Platforms",v:[...new Set(mergedNormRows.map(r=>r.platform))].filter(Boolean).join(", ")||"—"},{l:"Showing",v:filtered.length.toString(),c:T.text},{l:"Filtered spend",v:"$"+Math.round(filtered.reduce((s,c)=>s+c.spend,0)).toLocaleString(),c:T.text},{l:"Tagged",v:stats.tagged.toString(),c:T.success},{l:"Needs review",v:stats.untagged.toString(),c:stats.untagged>0?T.warning:T.success},{l:"Total spend",v:fmt$(stats.totalSpend)},{l:"Data rows",v:stats.totalRows.toLocaleString()}].map(s=><StatRow key={s.l} label={s.l} value={s.v} color={s.c} T={T}/>)}
                {stats.dateRange&&<div style={{fontSize:11,color:T.textMuted,marginTop:8,fontFamily:"Inter,sans-serif",lineHeight:1.6}}>{stats.dateRange}</div>}
                <div style={{marginTop:10,height:3,background:T.border,borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${stats.total?(stats.tagged/stats.total)*100:0}%`,background:T.accent,transition:"width 0.4s",borderRadius:2}}/></div>
                <div style={{fontSize:11,color:T.textMuted,marginTop:4}}>{stats.total?Math.round((stats.tagged/stats.total)*100):0}% tagged</div>
                <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:6}}>
                  <Btn onClick={exportTags} disabled={!campaigns.length} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↓ Export tags CSV</Btn>
                  <Btn onClick={()=>importTagsRef.current?.click()} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↑ Import tags CSV</Btn>
                  <input ref={importTagsRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>{importTagsFromCSV(e.target.files[0]);e.target.value="";}} />
                </div>

                {/* Tag browser */}
                {tagDims.some(d=>Object.keys(tagValueMap[d]||{}).length>0)&&(
                  <div style={{marginTop:16,borderTop:`1px solid ${T.border}`,paddingTop:14}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                      <SectionLabel T={T} style={{marginBottom:0}}>Filter by tag</SectionLabel>
                      {selectedTagFilters.size>0&&<span style={{fontSize:10,color:T.text,fontWeight:600,fontFamily:"Inter,sans-serif"}}>{selectedTagFilters.size} active</span>}
                    </div>
                    {tagDims.map(dim=>{
                      const vals=Object.entries(tagValueMap[dim]||{}).sort((a,b)=>b[1]-a[1]);
                      if(!vals.length)return null;
                      return(
                        <div key={dim} style={{marginBottom:12}}>
                          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.textMuted,marginBottom:5,fontFamily:"Inter,sans-serif"}}>{dim}</div>
                          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                            {vals.map(([val,count])=>{
                              const key=`${dim}:${val}`;
                              const active=selectedTagFilters.has(key);
                              return(
                                <button key={val} onClick={()=>toggleTagFilter(dim,val)}
                                  style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:14,fontSize:11,fontWeight:500,cursor:"pointer",fontFamily:"Inter,sans-serif",
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
                      <div style={{fontSize:11,color:T.textMuted,marginTop:4,fontFamily:"Inter,sans-serif"}}>
                        AND across dimensions · OR within
                        <button onClick={()=>setSelectedTagFilters(new Set())} style={{display:"block",fontSize:11,color:T.danger,background:"transparent",border:"none",cursor:"pointer",padding:"4px 0",fontFamily:"Inter,sans-serif"}}>Clear tag filters ×</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ):(<>
          <PixelPanel T={T} style={{opacity:hasSidebarData?1:0.7}} contentStyle={{padding:"14px 16px",background:T.accentBg}}>
            <div style={{fontSize:10,fontWeight:700,color:T.textSub,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:6}}>Total spend</div>
            <div style={{fontSize:20,fontWeight:800,color:T.text,fontFamily:"Inter,sans-serif"}}>{hasSidebarData?"$"+Math.round(stats.totalSpend).toLocaleString():"No data yet"}</div>
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
              <div style={{fontSize:19,fontWeight:700,color:T.text,fontFamily:"Inter,sans-serif"}}>{s.value}</div>
            </PixelPanel>
          ))}
          </>)}
        </aside>

        {/* Drag-to-resize handle for the stats column — thin strip on the divider line */}
        {statsOpen&&(
          <div onMouseDown={()=>{statsResizing.current=true;document.body.style.cursor="col-resize";}}
            title="Drag to resize"
            style={{position:"absolute",top:0,bottom:0,left:statsWidth-3,width:7,cursor:"col-resize",zIndex:32}}/>
        )}

        {/* Collapse handle for the stats column */}
        <button className="bhq-iconbtn" onClick={()=>setStatsOpen(o=>!o)} title={statsOpen?"Hide stats":"Show stats"}
          style={{position:"absolute",top:"50%",left:(statsOpen?statsWidth:0)-9,transform:"translateY(-50%)",width:18,height:18,borderRadius:"50%",background:T.surface,border:`1px solid ${T.border}`,padding:0,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:T.textSub,fontWeight:700,fontSize:9,lineHeight:1,zIndex:40,boxShadow:T.shadow,transition:statsResizing.current?"none":"left 0.15s, background 0.12s"}}>
          {statsOpen?"‹":"›"}
        </button>
      </>)}

      {/* ── MAIN ── */}
      <main style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>

      {notif&&<div style={{position:"fixed",bottom:20,right:20,background:T.success,color:"#fff",padding:"10px 16px",borderRadius:8,fontSize:13,fontWeight:600,zIndex:100,boxShadow:T.shadowMd,fontFamily:"Inter,sans-serif"}}>{notif}</div>}

      {/* ── UPLOAD ── */}
      {step==="upload"&&view==="tagger"&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"auto"}}>
          {/* Platform sync */}
          <div style={{padding:"16px 24px",borderBottom:`1px solid ${T.border}`,background:T.surface,flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
              <SectionLabel T={T} style={{marginBottom:0}}>Pull live spend data</SectionLabel>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <span style={{fontSize:11,color:T.textMuted}}>Range:</span>
                <input type="date" value={syncDateRange.start} onChange={e=>setSyncDateRange(p=>({...p,start:e.target.value}))}
                  style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:5,color:T.text,padding:"3px 6px",fontSize:11,outline:"none"}}/>
                <span style={{fontSize:11,color:T.textMuted}}>→</span>
                <input type="date" value={syncDateRange.end} onChange={e=>setSyncDateRange(p=>({...p,end:e.target.value}))}
                  style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:5,color:T.text,padding:"3px 6px",fontSize:11,outline:"none"}}/>
              </div>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {PLATFORMS.map(pl=>{
                const s=syncState[pl.key]||"idle";
                const loading=s==="loading";
                const done=s==="done";
                const err=s.startsWith("error:");
                const live=pl.status==="live";
                return(
                  <button key={pl.key} onClick={()=>live&&!loading&&syncPlatform(pl.key)}
                    title={live?`Sync ${pl.label} spend`:`${pl.label} — upload CSV below`}
                    style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:7,
                      border:`1px solid ${live?(done?"#10B981":err?"#ef4444":T.accentBorder):T.border}`,
                      background:live?(done?"rgba(16,185,129,0.08)":err?"rgba(239,68,68,0.08)":T.accentBg):T.surfaceEl,
                      cursor:live&&!loading?"pointer":"default",opacity:live?1:0.55,transition:"all 0.15s"}}>
                    <span style={{width:8,height:8,borderRadius:"50%",flexShrink:0,
                      background:live?(done?"#10B981":err?"#ef4444":pl.color):"#9ca3af",
                      ...(loading?{border:`2px solid rgba(0,0,0,0.1)`,borderTopColor:pl.color,background:"transparent",animation:"spin 0.7s linear infinite"}:{})}}/>
                    <span style={{fontSize:12,fontWeight:600,color:live?T.text:T.textMuted,fontFamily:"Inter,sans-serif"}}>{pl.label}</span>
                    <span style={{fontSize:10,color:live?(done?"#10B981":err?"#ef4444":T.accent):T.textMuted,fontFamily:"Inter,sans-serif"}}>
                      {live?(loading?"syncing…":done?"✓ synced":err?"error":"sync"):"CSV"}
                    </span>
                  </button>
                );
              })}
            </div>
            {Object.entries(syncState).filter(([,s])=>s.startsWith("error:")).map(([k,s])=>(
              <div key={k} style={{marginTop:6,fontSize:11,color:"#ef4444"}}>{k}: {s.replace("error:","")}</div>
            ))}
          </div>

          {/* Upload zone */}
          <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{width:"100%",maxWidth:560}}>

            {/* Header with cancel */}
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:28}}>
              <div>
                <h1 style={{fontSize:isMobile?22:26,fontWeight:700,color:T.text,letterSpacing:"-0.5px",marginBottom:6}}>Add data</h1>
                <p style={{fontSize:14,color:T.textSub,lineHeight:1.65}}>Import spend data to tag campaigns, or load a budget file to set monthly allocations.</p>
              </div>
              {(mergedNormRows.length>0||view)&&(
                <button onClick={()=>{if(mergedNormRows.length>0)setStep("tag");else{setView("dashboard");setStep("upload");}}}
                  style={{background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:7,color:T.textMuted,cursor:"pointer",fontSize:12,padding:"6px 12px",fontFamily:"Inter,sans-serif",flexShrink:0,marginLeft:16,marginTop:4}}>
                  ← Cancel
                </button>
              )}
            </div>

            {/* Two import options */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:24}}>
              <PixelPanel T={T} contentStyle={{background:T.surface,padding:"16px"}}>
                <div style={{marginBottom:8}}><Icon name="chart" size={22} color={T.text}/></div>
                <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:4}}>Spend data</div>
                <div style={{fontSize:12,color:T.textMuted,marginBottom:12,lineHeight:1.5}}>CSV from Google Ads, LinkedIn, Meta, Bing or Capterra</div>
                <div onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={handleDrop} onClick={()=>fileRef.current?.click()}
                  style={{border:`1.5px dashed ${dragOver?T.accent:T.borderStrong}`,borderRadius:10,padding:"14px",textAlign:"center",cursor:"pointer",background:dragOver?T.accentBg:"transparent",transition:"all 0.15s"}}>
                  <div style={{fontSize:12,fontWeight:600,color:T.accent}}>Drop CSV or click to browse</div>
                  <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
                </div>
              </PixelPanel>
              <PixelPanel T={T} onClick={()=>{setView("budget");}} contentStyle={{background:T.surface,padding:"16px",cursor:"pointer"}}>
                <div style={{marginBottom:8}}><Icon name="wallet" size={22} color={T.text}/></div>
                <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:4}}>Budget file</div>
                <div style={{fontSize:12,color:T.textMuted,marginBottom:12,lineHeight:1.5}}>Excel or CSV budget spreadsheet — AI maps your columns</div>
                <div style={{border:`1.5px dashed ${T.borderStrong}`,borderRadius:10,padding:"14px",textAlign:"center",background:"transparent"}}>
                  <div style={{fontSize:12,fontWeight:600,color:T.accent}}>Go to Budgets →</div>
                </div>
              </PixelPanel>
            </div>

            <PixelPanel T={T} contentStyle={{background:T.surface,padding:"10px 14px"}}>
              <SectionLabel T={T} style={{marginBottom:8}}>Supported sources</SectionLabel>
              <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                {["Google Ads","LinkedIn","Meta Ads","Microsoft Ads","Capterra","Funnel.io"].map(p=><span key={p} style={{fontSize:11,background:T.surfaceEl,color:T.textSub,padding:"3px 8px",borderRadius:5,fontWeight:500,border:`1px solid ${T.border}`}}>{p}</span>)}
              </div>
            </PixelPanel>
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
              {/* Platform override */}
              <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?"5px":"12px",padding:"10px 16px",borderBottom:`1px solid ${T.border}`,alignItems:"center",background:T.accentBg}}>
                <div>
                  <span style={{fontSize:13,fontWeight:500,color:T.text}}>Platform</span>
                  <div style={{fontSize:11,color:T.textMuted,marginTop:2}}>Override all rows, or map a column below</div>
                </div>
                <Sel value={uploadPlatform} onChange={setUploadPlatform} T={T}>
                  {PLATFORM_OPTIONS.map(p=><option key={p} value={p}>{p==="auto"?"— Auto-detect from data —":p}</option>)}
                </Sel>
              </div>
              {[...REQUIRED_COLS,...OPTIONAL_COLS].map((field,i)=>{
                // Hide platform column mapping if a specific platform is selected
                if(field==="platform"&&uploadPlatform!=="auto")return null;
                return(
                <div key={field} style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?"5px":"12px",padding:"10px 16px",borderBottom:i<REQUIRED_COLS.length+OPTIONAL_COLS.length-1?`1px solid ${T.border}`:"none",alignItems:"center",background:REQUIRED_COLS.includes(field)&&!colMap[field]?T.dangerBg:"transparent"}}>
                  <div><span style={{fontSize:13,fontWeight:500,color:T.text}}>{COL_LABELS[field]}</span>{REQUIRED_COLS.includes(field)&&<span style={{fontSize:10,color:T.danger,marginLeft:6,fontWeight:600}}>required</span>}{!REQUIRED_COLS.includes(field)&&<span style={{fontSize:10,color:T.textMuted,marginLeft:6}}>optional</span>}</div>
                  <Sel value={colMap[field]||""} onChange={v=>setColMap(p=>({...p,[field]:v||undefined}))} T={T}><option value="">— not mapped —</option>{headers.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                </div>
                );
              })}
            </PixelPanel>
            {canProceed&&<div style={{padding:"10px 14px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:8,marginBottom:14,fontSize:13,color:T.success,fontWeight:500}}>✓ Found <strong>{campaigns.length}</strong> campaigns · <strong>{fmt$(campaigns.reduce((s,c)=>s+c.spend,0))}</strong> total spend</div>}
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <Btn onClick={()=>setStep("upload")} variant="ghost" T={T}>← Back</Btn>
              <Btn onClick={()=>{
                const norm=normalizeRows(rawRows,colMap);
                const withPlatform=uploadPlatform==="auto"?norm:norm.map(r=>({...r,platform:uploadPlatform}));
                setMergedNormRows(prev=>mergeRows(prev,withPlatform));
                checkpoint(`Imported spend data — ${fileName||"CSV"} (${withPlatform.length} rows)`,"tagger_import");
                showNotif(`Added ${withPlatform.length} rows — merged with existing data`);
                setUploadPlatform("auto");
                setStep("tag");
              }} disabled={!canProceed} variant="primary" T={T} size="md">Continue to tagging →</Btn>
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
                {suggestions.map(s=><button key={s.key} onClick={()=>applySug(s.dim,s.val)} style={{fontSize:12,background:T.surface,border:`1px solid ${T.border}`,color:T.text,borderRadius:14,padding:"3px 10px",cursor:"pointer",fontFamily:"Inter,sans-serif",fontWeight:500}}>Apply {s.dim}: {s.val} to {s.count} untagged</button>)}
              </div>
            )}
            {selected.size>0&&(
              <div style={{padding:"8px 16px",background:T.surface,borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",flexShrink:0}}>
                <Pill color={T.text} bg={T.accent} border={T.text}>{selected.size} selected</Pill>
                <span style={{color:T.textMuted,fontSize:13}}>→</span>
                <Sel value={applyDim} onChange={setApplyDim} T={T} style={{width:130,fontSize:12}}><option value="">Dimension…</option>{tagDims.map(d=><option key={d} value={d}>{d}</option>)}</Sel>
                <Inp value={applyVal} onChange={setApplyVal} placeholder="Tag value…" T={T} style={{width:130,fontSize:12}} onKeyDown={e=>e.key==="Enter"&&applyTags()}/>
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

            <div style={{borderBottom:`1px solid ${T.border}`,background:T.headerBg,flexShrink:0}}>
              <div style={{display:"grid",gridTemplateColumns:isMobile?"32px 1fr 90px":"32px minmax(160px,1fr) minmax(160px,1fr) 110px 130px minmax(180px,1fr)",padding:"9px 16px 4px",alignItems:"end",gap:6}}>
                <input type="checkbox" checked={filtered.length>0&&selected.size===filtered.length} onChange={selAll} style={{cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                {!isMobile&&<SH col="group" label="Campaign Group"/>}
                <SH col="campaign" label="Campaign"/>
                <SH col="spend" label="Spend"/>
                {!isMobile&&<SH col="platform" label="Platform"/>}
                {!isMobile&&<div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <SH col="tags" label="Tags"/>
                  {tagsHistory.length>0&&<button onClick={undoTags} title="Undo last tag action (⌘Z)"
                    style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:5,color:T.text,cursor:"pointer",fontSize:10,padding:"1px 6px",fontFamily:"Inter,sans-serif",whiteSpace:"nowrap"}}>
                    ↩ Undo ({tagsHistory.length})
                  </button>}
                </div>}
              </div>
              <div style={{display:"grid",gridTemplateColumns:isMobile?"32px 1fr 90px":"32px minmax(160px,1fr) minmax(160px,1fr) 110px 130px minmax(180px,1fr)",padding:"3px 16px 8px",gap:6,alignItems:"start"}}>
                <div/>
                {!isMobile&&<div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <input value={fGroup} onChange={e=>setFGroup(e.target.value)} placeholder="Group contains…" style={fIn}/>
                  <input value={fGroupExclude} onChange={e=>setFGroupExclude(e.target.value)} placeholder="≠ excludes…" style={{...fIn,borderColor:fGroupExclude?"#ef4444":undefined,color:fGroupExclude?"#ef4444":undefined}}/>
                </div>}
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <input value={fCamp} onChange={e=>setFCamp(e.target.value)} placeholder="Campaign contains…" style={fIn}/>
                  <input value={fCampExclude} onChange={e=>setFCampExclude(e.target.value)} placeholder="≠ excludes…" style={{...fIn,borderColor:fCampExclude?"#ef4444":undefined,color:fCampExclude?"#ef4444":undefined}}/>
                </div>
                <div style={{display:"flex",gap:2}}><input value={fSMin} onChange={e=>setFSMin(e.target.value)} placeholder="Min" style={{...fIn,width:"50%"}}/><input value={fSMax} onChange={e=>setFSMax(e.target.value)} placeholder="Max" style={{...fIn,width:"50%"}}/></div>
                {!isMobile&&<select value={fPlat} onChange={e=>setFPlat(e.target.value)} style={{...fIn,cursor:"pointer"}}><option value="">All platforms</option>{allPlats.map(p=><option key={p} value={p}>{p}</option>)}</select>}
                {!isMobile&&<div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <div style={{display:"flex",gap:4}}>
                    <input value={fTag} onChange={e=>setFTag(e.target.value)} placeholder="Tag contains…" style={{...fIn,flex:1}}/>
                    <select value={fStatus} onChange={e=>setFStatus(e.target.value)} style={{...fIn,width:120,cursor:"pointer"}}><option value="all">All</option><option value="tagged">Tagged</option><option value="untagged">Needs review</option></select>
                    {hasF&&<button onClick={clearF} style={{background:T.dangerBg,border:`1px solid ${T.danger}`,color:T.danger,borderRadius:6,padding:"0 8px",cursor:"pointer",fontSize:11,fontFamily:"Inter,sans-serif",whiteSpace:"nowrap"}}>Clear ×</button>}
                  </div>
                  <input value={fTagExclude} onChange={e=>setFTagExclude(e.target.value)} placeholder="≠ tag excludes…" style={{...fIn,borderColor:fTagExclude?"#ef4444":undefined,color:fTagExclude?"#ef4444":undefined}}/>
                </div>}
              </div>
            </div>

            <div style={{overflow:"auto",flex:1}}>
              {filtered.map((c)=>{
                const ts=tags[c.key]||{};const tc=Object.keys(ts).length;const isSel=selected.has(c.key);const pc=PLATFORM_COLORS[c.platform]||T.textMuted;
                return(
                  <div key={c.key} className={isSel?undefined:"bhq-row"} onClick={()=>toggleSel(c.key)}
                    style={{display:"grid",gridTemplateColumns:isMobile?"32px 1fr 90px":"32px minmax(160px,1fr) minmax(160px,1fr) 110px 130px minmax(180px,1fr) 24px",padding:"9px 16px",borderBottom:`1px dashed ${T.borderStrong}`,alignItems:"center",cursor:"pointer",background:isSel?T.rowSelected:"transparent",transition:"background 0.1s",gap:6}}>
                    <input type="checkbox" checked={isSel} onChange={()=>toggleSel(c.key)} onClick={e=>e.stopPropagation()} style={{cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                    {!isMobile&&<div style={{fontSize:11,fontFamily:"Inter,sans-serif",color:T.textSub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.groupName}</div>}
                    <div style={{minWidth:0,fontSize:11,fontFamily:"Inter,sans-serif",color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</div>
                    <div style={{fontSize:12,fontFamily:"Inter,sans-serif",fontWeight:600,color:T.text}}>{fmt$(c.spend)}</div>
                    {!isMobile&&<div onClick={e=>e.stopPropagation()}>
                      {editingPlatform===c.key?(
                        <select autoFocus value={c.platform}
                          onChange={e=>{const plat=e.target.value;setMergedNormRows(prev=>prev.map(r=>campaignKey(r.campaign_group_name,r.campaign_name)===c.key?{...r,platform:plat}:r));setEditingPlatform(null);}}
                          onBlur={()=>setEditingPlatform(null)}
                          style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:5,color:T.text,fontSize:11,padding:"2px 6px",outline:"none",fontFamily:"Inter,sans-serif",cursor:"pointer"}}>
                          {PLATFORM_OPTIONS.filter(p=>p!=="auto").map(p=><option key={p} value={p}>{p}</option>)}
                        </select>
                      ):(
                        <span onClick={()=>setEditingPlatform(c.key)} title="Click to change platform"
                          style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:500,padding:"2px 8px",borderRadius:14,background:pc+"18",color:pc,border:`1px solid ${pc}`,whiteSpace:"nowrap",cursor:"pointer"}}>
                          {c.platform}
                        </span>
                      )}
                    </div>}
                    {!isMobile&&<div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
                      {tc===0?<Pill color={T.warning} bg={T.warningBg} border={T.warningBorder}>needs review</Pill>:
                        Object.entries(ts).map(([dim,val])=>(
                          <span key={dim} style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:500,padding:"2px 4px 2px 8px",borderRadius:14,background:T.accentBg,color:T.text,border:`1px solid ${T.accentBorder}`,gap:2,fontFamily:"Inter,sans-serif"}}>
                            <span style={{opacity:0.7,marginRight:1}}>{dim}:</span>
                            {editingTag?.campaign===c.key&&editingTag?.dim===dim?(
                              <input autoFocus value={editVal} onChange={e=>setEditVal(e.target.value)}
                                onBlur={saveEdit}
                                onKeyDown={e=>{if(e.key==="Enter")saveEdit();if(e.key==="Escape"){setEditingTag(null);setEditVal("");}e.stopPropagation();}}
                                onClick={e=>e.stopPropagation()}
                                style={{background:"transparent",border:"none",outline:"none",color:T.text,fontSize:11,fontWeight:600,width:Math.max(40,editVal.length*7)+"px",fontFamily:"Inter,sans-serif",padding:0}}/>
                            ):(
                              <span onClick={e=>{e.stopPropagation();setEditingTag({campaign:c.key,dim});setEditVal(val);}} style={{cursor:"text",fontWeight:600}}>{val}</span>
                            )}
                            <span onClick={e=>{e.stopPropagation();removeTag(c.key,dim);}} style={{color:T.textMuted,cursor:"pointer",fontSize:13,lineHeight:1,marginLeft:1,padding:"0 2px"}}>×</span>
                          </span>
                        ))
                      }
                    </div>}
                    {!isMobile&&<button onClick={e=>{e.stopPropagation();if(window.confirm(`Remove "${c.name}" from this dataset?\n\nThis only affects the current session — your tags are kept. You can re-sync or re-upload to restore it.`)){setMergedNormRows(prev=>prev.filter(r=>campaignKey(r.campaign_group_name,r.campaign_name)!==c.key));}}} title="Remove this campaign"
                      style={{width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"1px solid transparent",borderRadius:5,color:T.textMuted,cursor:"pointer",fontSize:12,lineHeight:1,padding:0,opacity:0.4,transition:"all 0.1s"}}
                      onMouseEnter={e=>{e.currentTarget.style.opacity=1;e.currentTarget.style.border=`1px solid ${T.danger}`;e.currentTarget.style.color=T.danger;}}
                      onMouseLeave={e=>{e.currentTarget.style.opacity=0.4;e.currentTarget.style.border="1px solid transparent";e.currentTarget.style.color=T.textMuted;}}>✕</button>}
                  </div>
                );
              })}
              {filtered.length===0&&<div style={{padding:"52px 20px",textAlign:"center",color:T.textMuted,fontSize:13}}>No campaigns match your filters.{hasF&&<span onClick={clearF} style={{color:T.text,cursor:"pointer",marginLeft:6,fontWeight:600,textDecoration:"underline"}}>Clear filters</span>}</div>}
            </div>
          </div>
        </div>
      )}

      {view==="dashboard"&&<Dashboard T={T} themeKey={themeKey} onNavigate={v=>{if(v==="tagger"){if(step==="upload"||step==="map"){}else setStep("tag");setView("tagger");}else setView(v);}} stats={stats} hasData={mergedNormRows.length>0}/>}
      {view==="budget"&&<BudgetManager campaignTags={tags} setTags={setTags} tagDimensions={tagDims} T={T} onAddDimensions={newDims=>setTagDims(p=>[...new Set([...p,...newDims])])} budgets={budgets} setBudgets={setBudgets} budgetDims={budgetDims} setBudgetDims={setBudgetDims} budgetRowMeta={budgetRowMeta} setBudgetRowMeta={setBudgetRowMeta} budgetMetaDims={budgetMetaDims} setBudgetMetaDims={setBudgetMetaDims} budgetImportMeta={budgetImportMeta} setBudgetImportMeta={setBudgetImportMeta} mergedNormRows={mergedNormRows} onCheckpoint={checkpoint} sidebarEl={budgetSidebarEl}/>}
      {view==="pacing"&&<PacingDashboard campaignTags={tags} setTags={setTags} tagDimensions={tagDims} budgetDims={budgetDims} budgets={budgets} setBudgets={setBudgets} budgetRowMeta={budgetRowMeta} setBudgetRowMeta={setBudgetRowMeta} mergedNormRows={mergedNormRows} T={T} onNavigate={setView} sidebarEl={pacingSidebarEl}/>}
      {view==="settings"&&(()=>{
        const budgetYears=Object.keys(budgets).length;
        const budgetSegs=Object.values(budgets).reduce((s,y)=>s+Object.keys(y).length,0);
        const rowSection=({title,desc,stat,action,label,disabled})=>(
          <div style={{border:`1px solid ${T.border}`,borderRadius:12,background:T.surface,padding:"20px 22px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:20}}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4,fontFamily:"Inter,sans-serif"}}>{title}</div>
              <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"Inter,sans-serif",maxWidth:480}}>{desc}</div>
              <div style={{fontSize:12,color:T.textMuted,marginTop:8,fontFamily:"Inter,sans-serif"}}>{stat}</div>
            </div>
            <Btn onClick={action} variant="danger" size="sm" T={T} disabled={disabled} style={{flexShrink:0}}>{label}</Btn>
          </div>
        );
        return(
          <div style={{flex:1,overflow:"auto",background:T.bg}}>
            <div style={{maxWidth:760,margin:"0 auto",padding:"48px 32px"}}>
              <div style={{marginBottom:32}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                  <div style={{width:36,height:36,borderRadius:10,background:T.surfaceEl,display:"flex",alignItems:"center",justifyContent:"center"}}><Icon name="gear" size={17} color={T.text}/></div>
                  <h1 style={{fontSize:22,fontWeight:800,color:T.text,letterSpacing:"-0.4px",fontFamily:"Inter,sans-serif"}}>Settings</h1>
                </div>
                <p style={{fontSize:13,color:T.textSub,fontFamily:"Inter,sans-serif"}}>Manage the data stored in this BudgetHQ instance. Reporting has no data of its own — it's computed live from Tagger and Budget data, so clearing either one updates Reporting automatically.</p>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{border:`1px solid ${T.border}`,borderRadius:12,background:T.surface,padding:"20px 22px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:20}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4,fontFamily:"Inter,sans-serif"}}>Appearance</div>
                    <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"Inter,sans-serif",maxWidth:480}}>Switch between light and dark mode.</div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                    <Icon name={themeKey==="dark"?"moon":"sun"} size={15} color={T.textSub}/>
                    <Tog value={themeKey==="dark"} onChange={v=>setThemeKey(v?"dark":"light")} T={T}/>
                  </div>
                </div>
                {rowSection({
                  title:"Clear Tagger data",
                  desc:"Removes every imported spend row, campaign tag, and custom tag dimension. Budget allocations are kept.",
                  stat:`${mergedNormRows.length.toLocaleString()} spend rows · ${Object.keys(tags).length.toLocaleString()} tagged campaigns`,
                  action:clearTaggerData,label:"Clear Tagger data",disabled:!mergedNormRows.length&&!Object.keys(tags).length,
                })}
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
              </div>
            </div>
          </div>
        );
      })()}

      </main>

      </div>

      {/* ── NAME CURRENT VERSION ── */}
      {nameVersionOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{width:"100%",maxWidth:400,background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15,fontWeight:700,color:T.text}}>Name current version</div>
            <div style={{padding:20}}>
              <div style={{fontSize:12,color:T.textSub,marginBottom:10}}>Saves a snapshot of everything — Tagger and Budget data — as it is right now, so you can come back to this exact point later.</div>
              <input autoFocus value={nameVersionInput} onChange={e=>setNameVersionInput(e.target.value)} placeholder="e.g. Before Q3 revision" onKeyDown={e=>{if(e.key==="Enter")saveNamedVersion();if(e.key==="Escape")setNameVersionOpen(false);}}
                style={{width:"100%",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:T.text,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"Inter,sans-serif"}}/>
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
          <div style={{width:"100%",maxWidth:420,background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,boxShadow:T.shadowMd}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15,fontWeight:700,color:T.text}}>Email {exportableView.label}</div>
            <div style={{padding:20,display:"flex",flexDirection:"column",gap:14}}>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:T.textSub,marginBottom:5}}>To</div>
                <input autoFocus type="email" value={emailExportTo} onChange={e=>setEmailExportTo(e.target.value)} placeholder="name@company.com"
                  style={{width:"100%",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:T.text,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"Inter,sans-serif",boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:T.textSub,marginBottom:5}}>Format</div>
                <div style={{display:"flex",gap:6}}>
                  {EXPORT_FORMATS.map(f=>(
                    <button key={f.key} onClick={()=>setEmailExportFormat(f.key)}
                      style={{flex:1,padding:"7px 0",borderRadius:6,border:`1.5px solid ${emailExportFormat===f.key?T.accentHover:T.border}`,background:emailExportFormat===f.key?T.accent:"transparent",color:emailExportFormat===f.key?T.text:T.textMuted,fontSize:12,fontWeight:emailExportFormat===f.key?700:500,cursor:"pointer",fontFamily:"Inter,sans-serif"}}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:T.textSub,marginBottom:5}}>Note <span style={{fontWeight:400,color:T.textMuted}}>(optional)</span></div>
                <textarea value={emailExportNote} onChange={e=>setEmailExportNote(e.target.value)} placeholder="Add a message for the recipient…" rows={3}
                  style={{width:"100%",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:7,color:T.text,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"Inter,sans-serif",resize:"vertical",boxSizing:"border-box"}}/>
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
          <div style={{width:"100%",maxWidth:520,maxHeight:"85vh",background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,boxShadow:T.shadowMd,display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:15,fontWeight:700,color:T.text}}>Version history</div>
                <div style={{fontSize:12,color:T.textSub,marginTop:2}}>Saved automatically after imports and data clears, or manually via ⋯ → Name current version.</div>
              </div>
              <button onClick={()=>setVersionHistoryOpen(false)} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22,lineHeight:1,fontFamily:"Inter,sans-serif"}}>×</button>
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
                        <button onClick={e=>{e.stopPropagation();restoreVersion(v);}} style={{fontSize:11,fontWeight:600,color:T.accent,background:"transparent",border:`1px solid ${T.accentBorder}`,borderRadius:6,padding:"4px 9px",cursor:"pointer",fontFamily:"Inter,sans-serif",flexShrink:0}}>Restore</button>
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

      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        html,body{height:100%;width:100%;overflow:hidden;}
        #root{height:100%;width:100%;display:flex;flex-direction:column;}
        body{font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;}
        input,select,button,textarea{font-family:'Inter',sans-serif;}
        input::placeholder{color:${T.textDim};}
        select option{background:${T.surface};color:${T.text};}
        ::-webkit-scrollbar{width:5px;height:5px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:${T.borderStrong};border-radius:3px;}
        @keyframes spin{to{transform:rotate(360deg);}}
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
      `}</style>
    </div>
  );
}
