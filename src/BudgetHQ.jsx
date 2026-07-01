import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";

// ─── DESIGN SYSTEM ────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    bg:"#141412",surface:"#1C1B18",surfaceEl:"#252420",surfaceHover:"#2C2B27",
    border:"#2E2D29",borderStrong:"#3D3C37",
    text:"#F0EFE9",textSub:"#A8A79E",textMuted:"#6B6A62",textDim:"#3D3C37",
    accent:"#10B981",accentHover:"#0EA572",
    accentBg:"rgba(16,185,129,0.1)",accentBorder:"rgba(16,185,129,0.22)",accentText:"#34D399",
    success:"#10B981",successBg:"rgba(16,185,129,0.1)",successBorder:"rgba(16,185,129,0.22)",
    warning:"#F59E0B",warningBg:"rgba(245,158,11,0.1)",warningBorder:"rgba(245,158,11,0.28)",
    danger:"#EF4444",dangerBg:"rgba(239,68,68,0.1)",dangerBorder:"rgba(239,68,68,0.28)",
    rowHover:"#1F1E1B",rowSelected:"rgba(16,185,129,0.08)",
    inputBg:"#252420",headerBg:"#1C1B18",sidebarBg:"#141412",
    logo:"#10B981",pill:"#252420",pillBorder:"#2E2D29",
    shadow:"0 1px 2px rgba(0,0,0,0.4)",
    shadowMd:"0 4px 20px rgba(0,0,0,0.5),0 2px 8px rgba(0,0,0,0.3)",
    shadowLg:"0 8px 40px rgba(0,0,0,0.6),0 4px 12px rgba(0,0,0,0.4)",
  },
  light: {
    bg:"#F7F6F3",surface:"#FFFFFF",surfaceEl:"#F0EFE9",surfaceHover:"#ECEAE3",
    border:"#E5E3DB",borderStrong:"#C9C7BE",
    text:"#1A1917",textSub:"#6B6A62",textMuted:"#9B9A92",textDim:"#C9C7BE",
    accent:"#059669",accentHover:"#047857",
    accentBg:"rgba(5,150,105,0.08)",accentBorder:"rgba(5,150,105,0.2)",accentText:"#059669",
    success:"#059669",successBg:"rgba(5,150,105,0.08)",successBorder:"rgba(5,150,105,0.2)",
    warning:"#D97706",warningBg:"rgba(217,119,6,0.08)",warningBorder:"rgba(217,119,6,0.25)",
    danger:"#DC2626",dangerBg:"rgba(220,38,38,0.08)",dangerBorder:"rgba(220,38,38,0.25)",
    rowHover:"#F0EFE9",rowSelected:"rgba(5,150,105,0.06)",
    inputBg:"#FFFFFF",headerBg:"#FFFFFF",sidebarBg:"#F7F6F3",
    logo:"#059669",pill:"#F0EFE9",pillBorder:"#E5E3DB",
    shadow:"0 1px 2px rgba(0,0,0,0.06)",
    shadowMd:"0 4px 20px rgba(0,0,0,0.1),0 2px 8px rgba(0,0,0,0.06)",
    shadowLg:"0 8px 40px rgba(0,0,0,0.14),0 4px 12px rgba(0,0,0,0.08)",
  },
};

const MONTHS=[{key:"01",label:"Jan"},{key:"02",label:"Feb"},{key:"03",label:"Mar"},{key:"04",label:"Apr"},{key:"05",label:"May"},{key:"06",label:"Jun"},{key:"07",label:"Jul"},{key:"08",label:"Aug"},{key:"09",label:"Sep"},{key:"10",label:"Oct"},{key:"11",label:"Nov"},{key:"12",label:"Dec"}];
const QUARTERS=[{key:"Q1",months:["01","02","03"],label:"Q1 Cap"},{key:"Q2",months:["04","05","06"],label:"Q2 Cap"},{key:"Q3",months:["07","08","09"],label:"Q3 Cap"},{key:"Q4",months:["10","11","12"],label:"Q4 Cap"}];
const MONTH_MAP={jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",january:"01",february:"02",march:"03",april:"04",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"};
const REQUIRED_COLS=["campaign_name","spend","date"];
const OPTIONAL_COLS=["adset_name","platform","impressions","clicks","campaign_id","adset_id"];
const COL_PATTERNS={campaign_name:/^campaign$/i,adset_name:/ad.?set|ad.?group/i,spend:/cost|spend|amount/i,date:/^date$|^day$/i,platform:/platform|traffic.source|channel|source/i,impressions:/impression/i,clicks:/^clicks?$/i,campaign_id:/campaign.*id/i,adset_id:/ad.?set.*id|ad.?group.*id/i};
const COL_LABELS={campaign_name:"Campaign Name",adset_name:"Ad Set / Ad Group Name",spend:"Spend / Cost",date:"Date",platform:"Platform / Traffic Source",impressions:"Impressions",clicks:"Clicks",campaign_id:"Campaign ID",adset_id:"Ad Set ID"};
const DEFAULT_DIMS=["Product","Region","Funnel","Pillar"];
const PLATFORM_COLORS={LinkedIn:"#0a66c2","Google Search":"#4285f4","Google Display":"#34a853","Demand Gen":"#f59e0b","Performance Max":"#ef4444",Meta:"#1877f2",Bing:"#00809d",YouTube:"#ff0000",Capterra:"#ff6d2d",Unknown:"#9B9A92"};
const NAV=[{key:"dashboard",label:"Dashboard",icon:"⚡"},{key:"tagger",label:"Tagger",icon:"🏷"},{key:"budget",label:"Budgets",icon:"💰"}];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function autoDetect(h){const m={};h.forEach(c=>{for(const[f,p]of Object.entries(COL_PATTERNS)){if(!m[f]&&p.test(c.trim()))m[f]=c;}});if(!m.campaign_name){const c=h.find(c=>/campaign/i.test(c)&&!/id|group|type/i.test(c));if(c)m.campaign_name=c;}if(!m.spend){const c=h.find(c=>/cost|spend/i.test(c));if(c)m.spend=c;}if(!m.date){const c=h.find(c=>/date|day/i.test(c));if(c)m.date=c;}return m;}
function derivePlatform(n,pv){const u=(n||"").toUpperCase();const p=(pv||"").toLowerCase();if(/^LIN[-|]/.test(u)||p.includes("linkedin"))return"LinkedIn";if(/^FB[-|]/.test(u)||p.includes("facebook")||p.includes("meta"))return"Meta";if(/^BIN[-|]/.test(u)||p.includes("bing"))return"Bing";if(/^YT[-|]/.test(u)||p.includes("youtube"))return"YouTube";if(/^SEA[-|]/.test(u)||p==="search")return"Google Search";if(/^GDN[-|]/.test(u)||p==="display")return"Google Display";if(/demand.gen/i.test(u)||p==="demand gen")return"Demand Gen";if(/pmax|performance.max/i.test(u))return"Performance Max";if(p.includes("google"))return"Google Search";if(p.includes("capterra"))return"Capterra";return pv||"Unknown";}
const parseSpend=v=>{if(!v)return 0;return parseFloat(String(v).replace(/[$,\s]/g,""))||0;};
const parseMoney=v=>{if(v===""||v==null)return null;const n=parseFloat(String(v).replace(/[$,\s%]/g,""));return isNaN(n)?null:n;};
const fmt$=n=>{if(!n)return"";if(n>=1e6)return"$"+(n/1e6).toFixed(1)+"M";if(n>=1e3)return"$"+(n/1e3).toFixed(1)+"K";return"$"+n.toFixed(0);};
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

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────
const SectionLabel=({children,T,style={}})=>(<div style={{fontSize:10,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted,marginBottom:6,...style}}>{children}</div>);
const Pill=({children,color,bg,border})=>(<span style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:500,padding:"2px 8px",borderRadius:20,background:bg,color,border:`1px solid ${border}`,whiteSpace:"nowrap"}}>{children}</span>);
const PlatformBadge=({platform,T})=>{const c=PLATFORM_COLORS[platform]||T.textMuted;return <span style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:500,padding:"2px 8px",borderRadius:5,background:c+"18",color:c,border:`1px solid ${c}30`,whiteSpace:"nowrap"}}>{platform}</span>;};
const Btn=({children,onClick,variant="ghost",size="sm",disabled,T,style={}})=>{
  const s={sm:{padding:"5px 12px",fontSize:12},md:{padding:"7px 16px",fontSize:13},lg:{padding:"9px 22px",fontSize:14}};
  const v={primary:{background:T.accent,color:"#fff",border:"none"},ghost:{background:"transparent",color:T.textSub,border:`1px solid ${T.border}`},subtle:{background:T.surfaceEl,color:T.textSub,border:`1px solid ${T.border}`},success:{background:T.successBg,color:T.success,border:`1px solid ${T.successBorder}`},danger:{background:T.dangerBg,color:T.danger,border:`1px solid ${T.dangerBorder}`}};
  return <button disabled={disabled} onClick={disabled?undefined:onClick} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,borderRadius:6,cursor:disabled?"not-allowed":"pointer",fontWeight:500,transition:"all 0.12s",fontFamily:"Manrope,sans-serif",opacity:disabled?0.4:1,...s[size],...v[variant],...style}}>{children}</button>;
};
const Inp=({value,onChange,placeholder,T,style={},mono=false,onKeyDown})=>(<input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} onKeyDown={onKeyDown} style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:mono?"'JetBrains Mono',monospace":"Manrope,sans-serif",width:"100%",transition:"border-color 0.12s",...style}}/>);
const Sel=({value,onChange,children,T,style={}})=>(<select value={value} onChange={e=>onChange(e.target.value)} style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:value?T.text:T.textMuted,padding:"6px 10px",fontSize:12,outline:"none",cursor:"pointer",fontFamily:"Manrope,sans-serif",width:"100%",...style}}>{children}</select>);
const Tog=({value,onChange,T})=>(<div onClick={()=>onChange(!value)} style={{width:30,height:17,borderRadius:9,background:value?T.accent:T.borderStrong,position:"relative",cursor:"pointer",transition:"background 0.2s",flexShrink:0}}><div style={{position:"absolute",top:2,left:value?15:2,width:13,height:13,borderRadius:7,background:"#fff",transition:"left 0.18s",boxShadow:"0 1px 3px rgba(0,0,0,0.25)"}}/></div>);
const Chk=({checked,onChange,T})=>(<div onClick={onChange} style={{width:15,height:15,borderRadius:4,border:`1.5px solid ${checked?T.accent:T.borderStrong}`,background:checked?T.accent:"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0,transition:"all 0.12s"}}>{checked&&<svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}</div>);
const StatRow=({label,value,color,T})=>(<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0"}}><span style={{fontSize:12,color:T.textSub}}>{label}</span><span style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace",fontWeight:600,color:color||T.text}}>{value}</span></div>);
const Divider=({T})=><div style={{height:1,background:T.border,margin:"12px 0"}}/>;

// ─── BUDGET MANAGER ───────────────────────────────────────────────────────────
function BudgetManager({campaignTags,tagDimensions,T,isMobile,onAddDimensions,budgets,setBudgets,budgetDims,setBudgetDims}){
  const yr=new Date().getFullYear();
  const[year,setYear]=useState(yr.toString());
  const[showQ,setShowQ]=useState(false);
  const[showA,setShowA]=useState(false);
  const[importOpen,setImportOpen]=useState(false);
  const[notif,setNotif]=useState(null);

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

  const exportBudgets=()=>{
    const header=[...budgetDims,...MONTHS.map(m=>m.label),"Total"];
    const rows=[header];
    segs.forEach(seg=>{
      const monthly=budgets[year]?.[seg.key]?.monthly||{};
      const amts=MONTHS.map(m=>monthly[m.key]||"");
      const total=MONTHS.reduce((s,m)=>s+(monthly[m.key]||0),0);
      rows.push([...budgetDims.map(d=>seg[d]),...amts,total||""]);
    });
    downloadCSV(rows,`budgethq-budgets-${year}.csv`);
    showNotif("Budgets exported");
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
    const maxCol=rawRows[headerRowIdx].length;
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

  const buildPreview=useCallback(()=>{
    const entries=[];
    const activeDims=[
      ...(tagDimensions||[]).filter(d=>dimMap[d]).map(d=>({dim:d,col:dimMap[d]})),
      ...customDims.filter(c=>c.name&&c.col),
    ];
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
  },[iFmt,iHeaders,iRows,iSegDim,iGroupHeaderRow,iGroupDim,iRawRows,tagDimensions,dimMap,customDims,periodCol,amtCol]);

  const goPreview=()=>{setPreview(buildPreview());setIStep("preview");};
  const confirmImport=()=>{
    setBudgets(p=>{const nx=JSON.parse(JSON.stringify(p));if(!nx[iYear])nx[iYear]={};preview.forEach(({segKey:sk,monthKey:mk,amount:amt})=>{if(!nx[iYear][sk])nx[iYear][sk]={};if(!nx[iYear][sk].monthly)nx[iYear][sk].monthly={};nx[iYear][sk].monthly[mk]=amt;});return nx;});
    setYear(iYear);
    // Add all mapped dims (existing + custom) to budgetDims
    const allMapped=[
      ...(tagDimensions||[]).filter(d=>dimMap[d]),
      ...customDims.filter(c=>c.name&&c.col).map(c=>c.name),
    ];
    setBudgetDims(p=>{const nx=new Set(p);allMapped.forEach(d=>nx.add(d));return[...nx];});
    // Register new custom dimensions with parent so they appear in Tagger too
    const newDimNames=customDims.filter(c=>c.name&&c.col&&!(tagDimensions||[]).includes(c.name)).map(c=>c.name);
    if(newDimNames.length) onAddDimensions?.(newDimNames);
    setImportOpen(false);resetImport();
    showNotif(`Imported ${preview.length} budget entries into ${iYear}`);
  };
  const resetImport=()=>{setIStep("upload");setIFileName("");setIRawRows([]);setIHeaderRow(0);setIHeaders([]);setIRows([]);setDimMap({});setPeriodCol("");setAmtCol("");setPreview([]);setCustomDims([]);setAiError("");setISegDim("Campaign");setIGroupHeaderRow(-1);setIGroupDim("Channel");};
  const closeImport=()=>{setImportOpen(false);resetImport();};

  const analyzeWithAI=async()=>{
    setAiAnalyzing(true);setAiError("");
    try{
      const sample=iRawRows.slice(0,300).map(row=>row.slice(0,20).map(v=>String(v||"").trim()));
      const prompt=`Analyze this complete budget spreadsheet and return a JSON mapping.\n\nUser's existing tag dimensions: ${(tagDimensions||[]).join(", ")}\n\nComplete file data (${sample.length} rows, up to 20 columns shown — file has ${iRawRows[0]?.length||0} total columns):\n${sample.map((row,i)=>`Row ${i+1}: ${row.map(v=>v.replace(/#REF!/g,"0")).join(" | ")}`).join("\n")}\n\nReturn ONLY this JSON object (no markdown):\n{\n  \"headerRow\": <0-based row index of the main column header row>,\n  \"groupHeaderRow\": <row index of a channel/platform grouping row ABOVE the main header that groups columns, or -1 if none>,\n  \"groupDimension\": <name for the group dimension e.g. \"Channel\" or null>,\n  \"skipPattern\": <substring in subtotal/total rows to skip, or \"\">,\n  \"format\": \"wide\", \"long\", or \"transposed\",\n  \"segmentDimension\": <for transposed: name for the campaign column dimension e.g. \"Campaign\">,\n  \"dimensions\": [{\"name\": <existing dim name>, \"column\": <exact column header>}],\n  \"newDimensions\": [{\"name\": <new dim name>, \"column\": <exact column header>}],\n  \"periodColumn\": <for long format: period column, else null>,\n  \"amountColumn\": <for long format: amount column, else null>,\n  \"hasQuarterlyCaps\": <true/false>,\n  \"hasAnnualCap\": <true/false>\n}\nFormat rules: wide=month names as column headers; transposed=months as rows + campaigns as columns (if a row ABOVE the header groups columns into channels set groupHeaderRow); long=one row per period. Existing dimensions to map: ${(tagDimensions||[]).join(", ")}`;

      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:2000,messages:[{role:"user",content:prompt}]})});
      const data=await res.json();
      const text=(data.content||[]).find(b=>b.type==="text")?.text||"";
      const result=JSON.parse(text.replace(/```json|```/g,"").trim());

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
      setAiError("AI analysis failed — please map columns manually.");
      console.error(e);
    }finally{setAiAnalyzing(false);}
  };

  const pvGrouped=useMemo(()=>{const m={};(preview||[]).forEach(e=>{if(!m[e.segKey])m[e.segKey]={dims:e.dims,months:{}};m[e.segKey].months[e.monthKey]=e.amount;});return Object.values(m).sort((a,b)=>Object.values(a.dims).join("|").localeCompare(Object.values(b.dims).join("|")));},[preview]);
  const dimCols=(tagDimensions||[]).filter(d=>dimMap[d]);
  const canMap=iFmt==="transposed"?!!iSegDim:((tagDimensions||[]).filter(d=>dimMap[d]).length>0||customDims.some(c=>c.name&&c.col))&&(iFmt==="wide"||(periodCol&&amtCol));
  const IMPORT_STEPS=["upload","header","map","preview"];

  const cellIn=(val,onChange,over=false,cap=false)=>(
    <input type="text" value={val===""?"":(!isNaN(parseFloat(String(val).replace(/[$,]/g,"")))?`${parseFloat(String(val).replace(/[$,]/g,"")).toLocaleString()}`:val)} onChange={e=>onChange(e.target.value)} placeholder="—"
      style={{background:cap?(over?T.dangerBg:T.warningBg):(over?T.dangerBg:T.inputBg),border:`1px solid ${over?T.danger:cap?T.warningBorder:T.border}`,borderRadius:5,color:over?T.danger:cap?T.warning:T.text,padding:"4px 6px",fontSize:11,width:cap?80:70,fontFamily:"'JetBrains Mono',monospace",textAlign:"right",outline:"none",display:"block"}}/>
  );
  const TH={fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.textMuted,padding:"10px 8px",borderBottom:`1px solid ${T.border}`,background:T.headerBg,whiteSpace:"nowrap",textAlign:"right"};

  return(
    <div style={{display:"flex",height:"calc(100vh - 48px)",background:T.bg,overflow:"hidden"}}>
      {/* Sidebar */}
      {!isMobile&&(
        <div style={{width:220,flexShrink:0,borderRight:`1px solid ${T.border}`,background:T.sidebarBg,overflow:"auto",display:"flex",flexDirection:"column"}}>
          <div style={{padding:"14px 14px 12px",display:"flex",flexDirection:"column",gap:8}}>
          <Btn onClick={()=>setImportOpen(true)} variant="success" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↑ Import CSV / Excel</Btn>
          <Btn onClick={exportBudgets} disabled={!segs.length} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↓ Export CSV</Btn>
        </div>
          <Divider T={T}/>
          <div style={{padding:"0 14px 12px"}}>
            <SectionLabel T={T}>Budget Year</SectionLabel>
            <div style={{display:"flex",gap:4}}>{years.map(y=><button key={y} onClick={()=>setYear(y)} style={{flex:1,padding:"5px 0",borderRadius:5,border:`1px solid ${year===y?T.accent:T.border}`,background:year===y?T.accentBg:"transparent",color:year===y?T.accent:T.textMuted,cursor:"pointer",fontSize:12,fontWeight:year===y?600:400,fontFamily:"Manrope,sans-serif"}}>{y}</button>)}</div>
          </div>
          <Divider T={T}/>
          <div style={{padding:"0 14px 12px"}}>
            <SectionLabel T={T}>Budget By</SectionLabel>
            {(tagDimensions||[]).map(d=>{const on=budgetDims.includes(d);return(
              <div key={d} onClick={()=>toggleDim(d)} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 8px",borderRadius:6,cursor:"pointer",background:on?T.accentBg:"transparent",marginBottom:1}}>
                <Chk checked={on} onChange={()=>toggleDim(d)} T={T}/>
                <span style={{fontSize:13,color:on?T.accent:T.text,fontWeight:on?500:400}}>{d}</span>
                <span style={{fontSize:11,color:T.textMuted,marginLeft:"auto",fontFamily:"'JetBrains Mono',monospace"}}>{dimCount(d)}</span>
              </div>
            );})}
          </div>
          <Divider T={T}/>
          <div style={{padding:"0 14px 12px"}}>
            <SectionLabel T={T}>Optional Caps</SectionLabel>
            {[{label:"Quarterly caps",v:showQ,s:setShowQ},{label:"Annual cap",v:showA,s:setShowA}].map(({label,v,s})=>(
              <div key={label} onClick={()=>s(x=>!x)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"5px 0",cursor:"pointer"}}>
                <span style={{fontSize:12,color:T.textSub}}>{label}</span><Tog value={v} onChange={s} T={T}/>
              </div>
            ))}
          </div>
          <Divider T={T}/>
          <div style={{padding:"0 14px",flex:1}}>
            <SectionLabel T={T}>Summary</SectionLabel>
            <StatRow label="Segments" value={segs.length.toString()} T={T}/>
            <StatRow label={`Total ${year}`} value={totalY>0?fmtFull(totalY):"$0"} color={T.accent} T={T}/>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{flex:1,overflow:"auto",minWidth:0}}>
        {!budgetDims.length?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",textAlign:"center",padding:40}}>
            <div style={{width:52,height:52,borderRadius:14,background:T.accentBg,border:`1px solid ${T.accentBorder}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,marginBottom:18}}>💰</div>
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
          <table style={{borderCollapse:"collapse",minWidth:"100%",fontSize:12}}>
            <thead><tr>
              {budgetDims.map((d,i)=><th key={d} style={{...TH,textAlign:"left",padding:"10px 14px",minWidth:dcw,position:"sticky",left:i*dcw,zIndex:3,background:T.headerBg}}>{d}</th>)}
              {MONTHS.map(m=><th key={m.key} style={{...TH,minWidth:76}}>{m.label}</th>)}
              <th style={{...TH,color:T.accent,minWidth:100}}>Total</th>
              {showQ&&QUARTERS.map(q=><th key={q.key} style={{...TH,color:T.warning,minWidth:96}}>{q.label}</th>)}
              {showA&&<th style={{...TH,color:T.warning,minWidth:96}}>Annual Cap</th>}
            </tr></thead>
            <tbody>
              {segs.map((seg,ri)=>{const rt=rowTotal(seg.key);const ao=aOver(seg.key);const rb=ri%2===0?"transparent":T.surfaceEl;return(
                <tr key={seg.key} style={{background:rb}}>
                  {budgetDims.map((d,i)=><td key={d} style={{padding:"7px 14px",borderBottom:`1px solid ${T.border}`,position:"sticky",left:i*dcw,background:ri%2===0?T.bg:T.surfaceEl,zIndex:1,whiteSpace:"nowrap"}}>
                    <Pill color={T.accent} bg={T.accentBg} border={T.accentBorder}>{seg[d]}</Pill>
                    {i===budgetDims.length-1&&segMatchCount(seg.key)===0&&(
                      <span title="No tagged campaigns match this segment" style={{marginLeft:6,fontSize:12,cursor:"help"}}>⚠️</span>
                    )}
                  </td>)}
                  {MONTHS.map(m=>{const q=QUARTERS.find(q=>q.months.includes(m.key));const qo=showQ&&q&&qOver(seg.key,q);return <td key={m.key} style={{padding:"4px",borderBottom:`1px solid ${T.border}`,background:rb}}>{cellIn(getMV(seg.key,m.key),v=>setMV(seg.key,m.key,v),qo)}</td>;})}
                  <td style={{padding:"4px 12px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:ao?T.danger:T.accent,whiteSpace:"nowrap",background:rb}}>{rt>0?fmtFull(rt):"—"}{ao&&" ⚠️"}</td>
                  {showQ&&QUARTERS.map(q=>{const qo=qOver(seg.key,q);const qt=qTotal(seg.key,q);return <td key={q.key} style={{padding:"4px",borderBottom:`1px solid ${T.border}`,background:rb}}><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>{cellIn(getQC(seg.key,q.key),v=>setQC(seg.key,q.key,v),qo,true)}{qt>0&&<span style={{fontSize:10,color:qo?T.danger:T.textMuted,fontFamily:"'JetBrains Mono',monospace"}}>{fmt$(qt)}{qo?" ⚠️":""}</span>}</div></td>;})}
                  {showA&&<td style={{padding:"4px",borderBottom:`1px solid ${T.border}`,background:rb}}><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>{cellIn(getAC(seg.key),v=>setAC(seg.key,v),ao,true)}{rt>0&&<span style={{fontSize:10,color:ao?T.danger:T.textMuted,fontFamily:"'JetBrains Mono',monospace"}}>{fmt$(rt)}{ao?" ⚠️":""}</span>}</div></td>}
                </tr>);})}
              <tr style={{borderTop:`2px solid ${T.borderStrong}`,background:T.surface}}>
                {budgetDims.map((d,i)=><td key={d} style={{padding:"10px 14px",position:"sticky",left:i*dcw,background:T.surface,zIndex:1}}>{i===0&&<SectionLabel T={T} style={{marginBottom:0}}>Totals</SectionLabel>}</td>)}
                {MONTHS.map(m=>{const t=segs.reduce((s,sg)=>s+(budgets[year]?.[sg.key]?.monthly?.[m.key]||0),0);return <td key={m.key} style={{padding:"10px 8px",textAlign:"right",fontFamily:"'JetBrains Mono',monospace",fontSize:11,fontWeight:600,color:T.text}}>{t>0?fmt$(t):"—"}</td>;})}
                <td style={{padding:"10px 12px",textAlign:"right",fontFamily:"'JetBrains Mono',monospace",fontSize:12,fontWeight:700,color:T.accent}}>{totalY>0?fmtFull(totalY):"—"}</td>
                {showQ&&QUARTERS.map(q=><td key={q.key}/>)}
                {showA&&<td/>}
              </tr>
            </tbody>
          </table>

          {/* + Add row */}
          {budgetDims.length>0&&(
            <div style={{padding:"10px 14px",borderTop:`1px solid ${T.border}`,background:T.surface}}>
              {!showAddRow?(
                <button onClick={()=>setShowAddRow(true)} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:12,fontFamily:"Manrope,sans-serif",display:"flex",alignItems:"center",gap:5,padding:0}}>
                  <span style={{fontSize:16,lineHeight:1}}>+</span> Add segment manually
                </button>
              ):(
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  {budgetDims.map(d=>(
                    <input key={d} value={newRowVals[d]||""} onChange={e=>setNewRowVals(p=>({...p,[d]:e.target.value}))} placeholder={d}
                      style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"Manrope,sans-serif",width:130}}/>
                  ))}
                  <Btn onClick={addManualRow} disabled={budgetDims.some(d=>!newRowVals[d]?.trim())} variant="primary" size="sm" T={T}>Add</Btn>
                  <Btn onClick={()=>{setShowAddRow(false);setNewRowVals({});}} variant="ghost" size="sm" T={T}>Cancel</Btn>
                </div>
              )}
            </div>
          )}
          </>
        )}
      </div>

      {notif&&<div style={{position:"fixed",bottom:24,right:24,background:T.success,color:"#fff",padding:"10px 16px",borderRadius:8,fontSize:13,fontWeight:600,zIndex:300,boxShadow:T.shadowMd,fontFamily:"Manrope,sans-serif"}}>{notif}</div>}

      {/* ── IMPORT MODAL ── */}
      {importOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:14,width:"100%",maxWidth:680,maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:T.shadowLg}}>

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
                <button onClick={closeImport} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22,lineHeight:1,marginLeft:6,fontFamily:"Manrope,sans-serif"}}>×</button>
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
                      {years.map(y=><button key={y} onClick={()=>setIYear(y)} style={{flex:1,padding:"10px 0",borderRadius:8,border:`1.5px solid ${iYear===y?T.accent:T.border}`,background:iYear===y?T.accentBg:"transparent",color:iYear===y?T.accent:T.textSub,cursor:"pointer",fontSize:15,fontWeight:iYear===y?700:400,fontFamily:"Manrope,sans-serif"}}>{y}</button>)}
                    </div>
                  </div>
                  <div onClick={()=>fileRef.current?.click()} style={{border:`1.5px dashed ${T.borderStrong}`,borderRadius:10,padding:"36px 20px",textAlign:"center",cursor:"pointer",background:T.surfaceEl}}>
                    <div style={{fontSize:32,marginBottom:10}}>📋</div>
                    <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:4}}>Drop your budget file here or click to browse</div>
                    <div style={{fontSize:12,color:T.textMuted}}>Supports <strong style={{color:T.textSub}}>.xlsx</strong> and <strong style={{color:T.textSub}}>.csv</strong> · any row/column layout</div>
                    <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{display:"none"}} onChange={e=>handleImportFile(e.target.files[0])}/>
                  </div>
                  <div style={{marginTop:14,display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                    {[{label:"Wide format",example:"Product | Jan | Feb | Mar | Apr..."},{label:"Long format",example:"Product | Platform | Month | Budget"}].map(f=>(
                      <div key={f.label} style={{padding:"10px 12px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:8}}>
                        <div style={{fontSize:12,fontWeight:600,color:T.text,marginBottom:3}}>{f.label}</div>
                        <div style={{fontSize:11,color:T.textMuted,fontFamily:"'JetBrains Mono',monospace"}}>{f.example}</div>
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
                    <div style={{display:"flex",gap:4}}>{years.map(y=><button key={y} onClick={()=>setIYear(y)} style={{padding:"2px 8px",borderRadius:4,border:`1px solid ${iYear===y?T.accent:T.border}`,background:iYear===y?T.accentBg:"transparent",color:iYear===y?T.accent:T.textMuted,cursor:"pointer",fontSize:11,fontFamily:"Manrope,sans-serif"}}>{y}</button>)}</div>
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
                                <td key={ci} style={{padding:"6px 10px",color:isHeader?T.accent:isSkip?T.danger:isEmpty?T.textDim:T.text,fontWeight:isHeader?600:400,fontFamily:isHeader?"Manrope,sans-serif":"'JetBrains Mono',monospace",fontSize:isHeader?11:11,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
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
                          style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"7px 10px",fontSize:13,outline:"none",fontFamily:"Manrope,sans-serif"}}/>
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
                                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:"Manrope,sans-serif",width:"100%"}}>
                                {iRawRows.slice(0,iHeaderRow).map((_,i)=>(
                                  <option key={i} value={i}>Row {i+1}: {(iRawRows[i]||[]).filter(v=>String(v||"").trim()).slice(0,3).join(" | ")}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <div style={{fontSize:12,color:T.textSub,marginBottom:4}}>Name for this group dimension</div>
                              <input value={iGroupDim} onChange={e=>setIGroupDim(e.target.value)} placeholder="e.g. Channel, Platform"
                                style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:"Manrope,sans-serif",width:"100%"}}/>
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
                          <input value={cd.name} onChange={e=>setCustomDims(p=>p.map((x,j)=>j===i?{...x,name:e.target.value}:x))} placeholder="Dimension name (e.g. BU)" style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,padding:"6px 10px",fontSize:12,outline:"none",fontFamily:"Manrope,sans-serif"}}/>
                          <Sel value={cd.col} onChange={v=>setCustomDims(p=>p.map((x,j)=>j===i?{...x,col:v}:x))} T={T}><option value="">— select column —</option>{iHeaders.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                          <button onClick={()=>setCustomDims(p=>p.filter((_,j)=>j!==i))} style={{background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:16,lineHeight:1,padding:"4px",fontFamily:"Manrope,sans-serif"}}>×</button>
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
                            {MONTHS.filter(m=>(preview||[]).some(e=>e.monthKey===m.key)).map(m=><td key={m.key} style={{padding:"7px 6px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:"'JetBrains Mono',monospace",color:sg.months[m.key]?T.text:T.textDim}}>{sg.months[m.key]?fmt$(sg.months[m.key]):"—"}</td>)}
                            <td style={{padding:"7px 10px",borderBottom:`1px solid ${T.border}`,textAlign:"right",fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:T.accent}}>{fmt$(rt)}</td>
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
                {iStep==="preview"&&<Btn onClick={confirmImport} variant="primary" T={T}>✓ Import {preview.length} entries into {iYear}</Btn>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({T,onNavigate,stats,hasData}){
  const cards=[
    {
      key:"tagger",icon:"🏷",title:"Start with spend data",
      desc:"Upload a spend CSV from Google Ads, LinkedIn, Meta, Bing or Capterra. Tag campaigns into custom segments like Product, Region, and Funnel.",
      action:"Import spend data →",color:T.accent,primary:true,
    },
    {
      key:"budget",icon:"💰",title:"Start with a budget file",
      desc:"Upload your budget spreadsheet (Excel or CSV). AI maps your columns automatically. Set monthly budgets by segment — no spend data needed.",
      action:"Import budget file →",color:T.accent,primary:true,
    },
    {
      key:"pacing",icon:"📈",title:"Pacing Dashboard",
      desc:"Track burn rate, PTD spend vs budget, and forecast to end of period across every segment. Requires spend data and budgets.",
      action:"Coming soon",color:T.textMuted,disabled:true,
    },
    {
      key:"export",icon:"📤",title:"Export",
      desc:"Export clean data — no formulas — to plug into your own Google Sheets or Excel trackers.",
      action:"Coming soon",color:T.textMuted,disabled:true,
    },
  ];
  return(
    <div style={{flex:1,overflow:"auto",background:T.bg}}>
      <div style={{maxWidth:900,margin:"0 auto",padding:"48px 32px"}}>
        {/* Hero */}
        <div style={{marginBottom:48}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
            <div style={{width:44,height:44,borderRadius:11,background:T.accentBg,border:`1px solid ${T.accentBorder}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><polyline points="2,16 7,10 11,13 20,4" stroke={T.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="7" cy="10" r="1.8" fill={T.accent}/><circle cx="11" cy="13" r="1.8" fill={T.accent}/></svg>
            </div>
            <div>
              <h1 style={{fontSize:26,fontWeight:700,color:T.text,letterSpacing:"-0.5px",marginBottom:2,fontFamily:"Manrope,sans-serif"}}>BudgetHQ</h1>
              <div style={{fontSize:12,color:T.textMuted,fontFamily:"Manrope,sans-serif"}}>Paid media budget intelligence · by PaidHQ</div>
            </div>
          </div>
          <p style={{fontSize:15,color:T.textSub,lineHeight:1.7,maxWidth:560,fontFamily:"Manrope,sans-serif"}}>
            Set budgets by custom segment, track pacing against actuals, and manage spend across every ad platform — without breaking a spreadsheet.
          </p>
          <div style={{marginTop:12,display:"inline-flex",alignItems:"center",gap:8,padding:"7px 12px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:8}}>
            <span style={{fontSize:13,color:T.accent,fontFamily:"Manrope,sans-serif"}}>Start with spend data <strong>or</strong> a budget file — connect them later for pacing.</span>
          </div>
        </div>

        {/* Stats bar — only shown if data is loaded */}
        {hasData&&(
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:40}}>
            {[
              {label:"Campaigns",value:stats.total.toLocaleString(),color:T.text},
              {label:"Tagged",value:`${stats.tagged.toLocaleString()} (${stats.total?Math.round((stats.tagged/stats.total)*100):0}%)`,color:T.success},
              {label:"Needs review",value:stats.untagged.toLocaleString(),color:stats.untagged>0?T.warning:T.success},
              {label:"Total spend",value:stats.totalSpend>=1e6?"$"+(stats.totalSpend/1e6).toFixed(1)+"M":stats.totalSpend>=1e3?"$"+(stats.totalSpend/1e3).toFixed(1)+"K":"$"+Math.round(stats.totalSpend).toLocaleString(),color:T.accent},
            ].map(s=>(
              <div key={s.label} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px",boxShadow:T.shadow}}>
                <div style={{fontSize:11,fontWeight:600,color:T.textMuted,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:6,fontFamily:"Manrope,sans-serif"}}>{s.label}</div>
                <div style={{fontSize:20,fontWeight:700,color:s.color,fontFamily:"'JetBrains Mono',monospace"}}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:16}}>
          {cards.map(card=>(
            <div key={card.key} onClick={card.disabled?undefined:()=>onNavigate(card.key)}
              style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"22px 24px",cursor:card.disabled?"default":"pointer",opacity:card.disabled?0.5:1,transition:"all 0.15s",boxShadow:T.shadow}}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:10}}>
                <div style={{width:36,height:36,borderRadius:9,background:card.disabled?T.surfaceEl:T.accentBg,border:`1px solid ${card.disabled?T.border:T.accentBorder}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{card.icon}</div>
                {!card.disabled&&<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke={T.textMuted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              </div>
              <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6,fontFamily:"Manrope,sans-serif"}}>{card.title}</div>
              <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,marginBottom:14,fontFamily:"Manrope,sans-serif"}}>{card.desc}</div>
              <div style={{fontSize:12,fontWeight:600,color:card.color,fontFamily:"Manrope,sans-serif"}}>{card.action}</div>
            </div>
          ))}
        </div>

        {/* Date range if data loaded */}
        {hasData&&stats.dateRange&&(
          <div style={{marginTop:24,padding:"10px 14px",background:T.surfaceEl,borderRadius:8,border:`1px solid ${T.border}`,display:"inline-flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:11,color:T.textMuted,fontFamily:"Manrope,sans-serif"}}>Data loaded:</span>
            <span style={{fontSize:11,color:T.text,fontFamily:"'JetBrains Mono',monospace",fontWeight:500}}>{stats.dateRange}</span>
            <span style={{fontSize:11,color:T.textMuted,fontFamily:"Manrope,sans-serif"}}>· {stats.totalRows.toLocaleString()} rows</span>
          </div>
        )}
      </div>
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
  const[fileName,setFileName]=useState("");
  const[rawRows,setRawRows]=useState([]);
  const[headers,setHeaders]=useState([]);
  const[colMap,setColMap]=useState({});
  const[tagDims,setTagDims]=useState(DEFAULT_DIMS);
  const[tags,setTags]=useState({});
  const[selected,setSelected]=useState(new Set());
  const[newDim,setNewDim]=useState("");
  const[applyDim,setApplyDim]=useState("");
  const[applyVal,setApplyVal]=useState("");
  const[dragOver,setDragOver]=useState(false);
  const[notif,setNotif]=useState(null);
  const[sortCol,setSortCol]=useState("spend");
  const[sortDir,setSortDir]=useState("desc");
  const[fCamp,setFCamp]=useState("");
  const[fCampExclude,setFCampExclude]=useState("");
  const[fPlat,setFPlat]=useState("");
  const[fSMin,setFSMin]=useState("");
  const[fSMax,setFSMax]=useState("");
  const[fTag,setFTag]=useState("");
  const[fTagExclude,setFTagExclude]=useState("");
  const[fStatus,setFStatus]=useState("all");
  const fileRef=useRef();

  const[budgets,setBudgets]=useState({});
  const[budgetDims,setBudgetDims]=useState([]);

  useEffect(()=>{try{
    const t=localStorage.getItem("paidhq_tags");if(t)setTags(JSON.parse(t));
    const d=localStorage.getItem("paidhq_dims");if(d)setTagDims(JSON.parse(d));
    const th=localStorage.getItem("paidhq_theme");if(th)setThemeKey(th);
    const b=localStorage.getItem("paidhq_budgets");if(b)setBudgets(JSON.parse(b));
    const bd=localStorage.getItem("paidhq_budget_dims");if(bd)setBudgetDims(JSON.parse(bd));
    // Restore spend data
    const sr=localStorage.getItem("paidhq_rows");
    const sh=localStorage.getItem("paidhq_headers");
    const sc=localStorage.getItem("paidhq_colmap");
    if(sr&&sh&&sc){setRawRows(JSON.parse(sr));setHeaders(JSON.parse(sh));setColMap(JSON.parse(sc));setStep("tag");}
  }catch(e){};},[]);
  useEffect(()=>{try{localStorage.setItem("paidhq_tags",JSON.stringify(tags));}catch(e){};},[tags]);
  useEffect(()=>{try{localStorage.setItem("paidhq_dims",JSON.stringify(tagDims));}catch(e){};},[tagDims]);
  useEffect(()=>{try{localStorage.setItem("paidhq_theme",themeKey);}catch(e){};},[themeKey]);
  useEffect(()=>{try{localStorage.setItem("paidhq_budgets",JSON.stringify(budgets));}catch(e){};},[budgets]);
  useEffect(()=>{try{localStorage.setItem("paidhq_budget_dims",JSON.stringify(budgetDims));}catch(e){};},[budgetDims]);
  useEffect(()=>{try{
    if(rawRows.length){
      localStorage.setItem("paidhq_rows",JSON.stringify(rawRows));
      localStorage.setItem("paidhq_headers",JSON.stringify(headers));
      localStorage.setItem("paidhq_colmap",JSON.stringify(colMap));
    }
  }catch(e){};},[rawRows,headers,colMap]);

  // ── Platform sync ──────────────────────────────────────────────────────────
  const PLATFORMS=[
    {key:"linkedin",label:"LinkedIn",status:"live",color:"#0A66C2"},
    {key:"google",label:"Google",status:"csv",color:"#EA4335"},
    {key:"meta",label:"Meta",status:"csv",color:"#1877F2"},
    {key:"bing",label:"Bing",status:"csv",color:"#00809D"},
    {key:"capterra",label:"Capterra",status:"csv",color:"#FF7043"},
  ];
  const[syncState,setSyncState]=useState({}); // {platform: "idle"|"loading"|"done"|"error"}
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
      // Merge into rawRows / headers / campaigns as if a CSV was uploaded
      if(rows.length===0) throw new Error("No spend data returned for this date range");
      const fields=["campaign_name","campaign_id","platform","date","spend","impressions","clicks"];
      setHeaders(fields);
      setColMap({campaign_name:"campaign_name",spend:"spend",platform:"platform",date:"date",impressions:"impressions",clicks:"clicks"});
      setRawRows(rows);
      setStep("tag");
      setSyncState(p=>({...p,[platformKey]:"done"}));
      showNotif(`Loaded ${rows.length} ${platformKey} campaigns`);
    }catch(e){
      setSyncState(p=>({...p,[platformKey]:"error:"+e.message}));
    }
  },[syncDateRange]);

  const handleFile=useCallback(file=>{
    if(!file)return;setFileName(file.name);
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      setRawRows(r.data);setHeaders(r.meta.fields||[]);setColMap(autoDetect(r.meta.fields||[]));
      // Carry-forward: count how many campaigns already have tags
      const existingTagCount=r.data.reduce((count,row)=>{
        const name=(row[autoDetect(r.meta.fields||[]).campaign_name]||"").trim();
        return count+(name&&Object.keys(tags[name]||{}).length>0?1:0);
      },0);
      if(existingTagCount>0) showNotif(`${existingTagCount} campaigns already tagged from previous session`);
      setStep("map");
    }});
  },[tags]);
  const handleDrop=useCallback(e=>{e.preventDefault();setDragOver(false);const f=e.dataTransfer.files[0];if(f)handleFile(f);},[handleFile]);

  const campaigns=useMemo(()=>{if(!rawRows.length||!colMap.campaign_name)return[];const map={};rawRows.forEach(row=>{const name=(row[colMap.campaign_name]||"").trim();if(!name)return;const spend=parseSpend(row[colMap.spend]);const platform=derivePlatform(name,colMap.platform?row[colMap.platform]:"");if(!map[name])map[name]={name,platform,spend:0,rows:0,adsets:new Set()};map[name].spend+=spend;map[name].rows++;if(colMap.adset_name&&row[colMap.adset_name])map[name].adsets.add(row[colMap.adset_name]);});return Object.values(map).map(c=>({...c,adsetCount:c.adsets.size}));},[rawRows,colMap]);
  const allPlats=useMemo(()=>[...new Set(campaigns.map(c=>c.platform))].sort(),[campaigns]);
  const stats=useMemo(()=>{const totalSpend=campaigns.reduce((s,c)=>s+c.spend,0);const tagged=campaigns.filter(c=>Object.keys(tags[c.name]||{}).length>0).length;const dates=rawRows.map(r=>r[colMap.date]).filter(Boolean).sort();return{total:campaigns.length,tagged,untagged:campaigns.length-tagged,totalSpend,totalRows:rawRows.length,dateRange:dates.length?`${dates[0]} → ${dates[dates.length-1]}`:""};},[campaigns,tags,rawRows,colMap]);

  const filtered=useMemo(()=>{let r=campaigns.filter(c=>{
    if(fCamp&&!c.name.toLowerCase().includes(fCamp.toLowerCase()))return false;
    if(fCampExclude&&c.name.toLowerCase().includes(fCampExclude.toLowerCase()))return false;
    if(fPlat&&c.platform!==fPlat)return false;
    if(fSMin&&c.spend<parseFloat(fSMin))return false;
    if(fSMax&&c.spend>parseFloat(fSMax))return false;
    if(fTag){const ts=tags[c.name]||{};const s=Object.entries(ts).map(([d,v])=>`${d}:${v}`).join(" ").toLowerCase();if(!s.includes(fTag.toLowerCase()))return false;}
    if(fTagExclude){const ts=tags[c.name]||{};const s=Object.entries(ts).map(([d,v])=>`${d}:${v}`).join(" ").toLowerCase();if(s.includes(fTagExclude.toLowerCase()))return false;}
    if(fStatus==="tagged"&&Object.keys(tags[c.name]||{}).length===0)return false;
    if(fStatus==="untagged"&&Object.keys(tags[c.name]||{}).length>0)return false;
    return true;
  });return[...r].sort((a,b)=>{if(sortCol==="spend")return sortDir==="asc"?a.spend-b.spend:b.spend-a.spend;if(sortCol==="campaign")return sortDir==="asc"?a.name.localeCompare(b.name):b.name.localeCompare(a.name);if(sortCol==="platform")return sortDir==="asc"?a.platform.localeCompare(b.platform):b.platform.localeCompare(a.platform);const at=Object.keys(tags[a.name]||{}).length;const bt=Object.keys(tags[b.name]||{}).length;return sortDir==="asc"?at-bt:bt-at;});},[campaigns,fCamp,fCampExclude,fPlat,fSMin,fSMax,fTag,fTagExclude,fStatus,sortCol,sortDir,tags]);

  const suggestions=useMemo(()=>{if(!fCamp||fCamp.length<3)return[];const term=fCamp.toLowerCase();const seen=new Set();const out=[];tagDims.forEach(dim=>{Object.entries(tags).forEach(([cn,ts])=>{if(ts[dim]&&cn.toLowerCase().includes(term)){const key=`${dim}:${ts[dim]}`;if(!seen.has(key)){seen.add(key);const count=filtered.filter(c=>!(tags[c.name]?.[dim])).length;if(count>0)out.push({key,dim,val:ts[dim],count});}}});});return out.slice(0,3);},[fCamp,filtered,tags,tagDims]);

  const showNotif=msg=>{setNotif(msg);setTimeout(()=>setNotif(null),3000);};
  const applyTags=useCallback(()=>{if(!applyDim||!applyVal||!selected.size)return;const u={};selected.forEach(n=>{u[n]={...(tags[n]||{}),[applyDim]:applyVal};});setTags(p=>({...p,...u}));showNotif(`Tagged ${selected.size} campaigns — ${applyDim}: ${applyVal}`);setSelected(new Set());setApplyVal("");},[applyDim,applyVal,selected,tags]);
  const applySug=useCallback((dim,val)=>{const u={};filtered.forEach(c=>{if(!(tags[c.name]?.[dim]))u[c.name]={...(tags[c.name]||{}),[dim]:val};});setTags(p=>({...p,...u}));showNotif(`Applied ${dim}: ${val} to ${Object.keys(u).length} campaigns`);},[filtered,tags]);
  const removeTag=useCallback((cn,dim)=>{setTags(p=>{const ts={...(p[cn]||{})};delete ts[dim];return{...p,[cn]:ts};});},[]);
  const bulkRemoveTag=useCallback(dim=>{if(!dim||!selected.size)return;setTags(p=>{const nx={...p};selected.forEach(n=>{if(nx[n]){const ts={...nx[n]};delete ts[dim];nx[n]=ts;}});return nx;});showNotif(`Removed ${dim} tag from ${selected.size} campaigns`);setSelected(new Set());},[selected,tags]);
  const exportTags=()=>{
    const header=["Campaign","Platform","Spend",...tagDims];
    const rows=[header,...campaigns.map(c=>[c.name,c.platform,c.spend.toFixed(2),...tagDims.map(d=>(tags[c.name]||{})[d]||"")])];
    downloadCSV(rows,"budgethq-tags.csv");
    showNotif("Tags exported");
  };

  const importTagsRef=useRef(null);
  const importTagsFromCSV=useCallback((file)=>{
    if(!file)return;
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      const rows=r.data;
      const fields=r.meta.fields||[];
      // Detect campaign name column
      const campCol=fields.find(f=>/campaign/i.test(f));
      if(!campCol){showNotif("Could not find Campaign column");return;}
      // Detect dimension columns (exclude Campaign, Platform, Spend, Date)
      const skipCols=new Set(["campaign","platform","spend","date","impressions","clicks","campaign_name","campaign_id"]);
      const dimCols=fields.filter(f=>!skipCols.has(f.toLowerCase())&&f!==campCol);
      let restored=0;
      setTags(p=>{
        const nx={...p};
        rows.forEach(row=>{
          const name=(row[campCol]||"").trim();
          if(!name)return;
          const t={...(nx[name]||{})};
          dimCols.forEach(d=>{if(row[d]&&row[d].trim())t[d]=row[d].trim();});
          nx[name]=t;
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
  const selAll=()=>setSelected(selected.size===filtered.length?new Set():new Set(filtered.map(c=>c.name)));
  const addDim=()=>{const n=newDim.trim();if(!n||tagDims.includes(n))return;setTagDims(p=>[...p,n]);setNewDim("");};
  const doSort=col=>{setSortDir(sortCol===col&&sortDir==="desc"?"asc":"desc");setSortCol(col);};
  const clearF=()=>{setFCamp("");setFCampExclude("");setFPlat("");setFSMin("");setFSMax("");setFTag("");setFTagExclude("");setFStatus("all");};
  const hasF=fCamp||fCampExclude||fPlat||fSMin||fSMax||fTag||fTagExclude||fStatus!=="all";
  const canProceed=colMap.campaign_name&&colMap.spend;
  const showNav=true;

  const SH=({col,label})=>(<span onClick={()=>doSort(col)} style={{fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:sortCol===col?T.accent:T.textMuted,cursor:"pointer",userSelect:"none",display:"inline-flex",alignItems:"center",gap:3}}>{label}<span style={{opacity:0.7,fontSize:9}}>{sortCol===col?(sortDir==="desc"?"▾":"▴"):"⇅"}</span></span>);
  const fIn={background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:5,color:T.text,padding:"5px 8px",fontSize:11,outline:"none",fontFamily:"Manrope,sans-serif",width:"100%",marginTop:3};

  return(
    <div style={{height:"100vh",width:"100vw",display:"flex",flexDirection:"column",background:T.bg,color:T.text,fontFamily:"Manrope,sans-serif",overflow:"hidden"}}>
      <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* ── HEADER ── */}
      <header style={{height:48,background:T.headerBg,borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",padding:"0 16px",gap:8,flexShrink:0,zIndex:30,boxShadow:T.shadow}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginRight:4}}>
          <div style={{width:28,height:28,borderRadius:7,background:T.accentBg,border:`1px solid ${T.accentBorder}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><polyline points="1,11 5,7 8,9 14,3" stroke={T.accent} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="5" cy="7" r="1.2" fill={T.accent}/><circle cx="8" cy="9" r="1.2" fill={T.accent}/></svg>
          </div>
          <span style={{fontSize:15,fontWeight:700,color:T.text,letterSpacing:"-0.4px"}}>BudgetHQ</span>
          <span style={{fontSize:10,fontWeight:600,color:T.textMuted,background:T.pill,border:`1px solid ${T.pillBorder}`,padding:"2px 7px",borderRadius:8,letterSpacing:"0.04em",textTransform:"uppercase"}}>by PaidHQ</span>
        </div>
        <nav style={{display:"flex",alignItems:"center",gap:1,marginLeft:8}}>
          {NAV.map(item=>{
            const active=view===item.key;
            const locked=item.key==="tagger"&&step==="upload"&&view!=="tagger";
          return <button key={item.key} onClick={()=>{
              if(item.key==="tagger"){if(step!=="tag")setStep("upload");setView("tagger");}
              else setView(item.key);
            }} style={{padding:"0 12px",height:32,background:active?T.surfaceEl:"transparent",border:active?`1px solid ${T.border}`:"1px solid transparent",borderRadius:6,color:active?T.text:T.textMuted,cursor:"pointer",fontSize:13,fontWeight:active?600:400,fontFamily:"Manrope,sans-serif",display:"flex",alignItems:"center",gap:5}}><span>{item.icon}</span>{!isMobile&&item.label}</button>;
          })}
        </nav>
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
          {step==="tag"&&!isMobile&&(
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"3px 10px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:6}}>
              <span style={{width:6,height:6,borderRadius:3,background:stats.untagged>0?T.warning:T.success,display:"inline-block"}}/>
              <span style={{fontSize:12,color:T.textSub}}><span style={{color:T.text,fontWeight:600}}>{stats.tagged}</span>/{stats.total} tagged</span>
            </div>
          )}
          {step==="tag"&&<Btn onClick={()=>{setStep("upload");try{localStorage.removeItem("paidhq_rows");localStorage.removeItem("paidhq_headers");localStorage.removeItem("paidhq_colmap");}catch(e){};}} variant="ghost" size="sm" T={T}>↑ New file</Btn>}
          <button onClick={()=>setThemeKey(k=>k==="dark"?"light":"dark")} style={{background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:12,color:T.textSub,fontFamily:"Manrope,sans-serif",display:"flex",alignItems:"center",gap:5}}>
            {themeKey==="dark"?"☀️":"🌙"}{!isMobile&&(themeKey==="dark"?" Light":" Dark")}
          </button>
        </div>
      </header>

      {notif&&<div style={{position:"fixed",bottom:20,right:20,background:T.success,color:"#fff",padding:"10px 16px",borderRadius:8,fontSize:13,fontWeight:600,zIndex:100,boxShadow:T.shadowMd,fontFamily:"Manrope,sans-serif"}}>{notif}</div>}

      {/* ── UPLOAD ── */}
      {step==="upload"&&(
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
                    <span style={{fontSize:12,fontWeight:600,color:live?T.text:T.textMuted,fontFamily:"Manrope,sans-serif"}}>{pl.label}</span>
                    <span style={{fontSize:10,color:live?(done?"#10B981":err?"#ef4444":T.accent):T.textMuted,fontFamily:"Manrope,sans-serif"}}>
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
          <div style={{width:"100%",maxWidth:520}}>
            <div style={{marginBottom:28}}>
              <h1 style={{fontSize:isMobile?22:28,fontWeight:700,color:T.text,letterSpacing:"-0.5px",marginBottom:6}}>Import your spend data</h1>
              <p style={{fontSize:14,color:T.textSub,lineHeight:1.65}}>Upload a CSV from any ad platform. We auto-detect your columns and help you tag campaigns into custom segments.</p>
            </div>
            <div onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={handleDrop} onClick={()=>fileRef.current?.click()}
              style={{border:`1.5px dashed ${dragOver?T.accent:T.borderStrong}`,borderRadius:12,padding:isMobile?"28px 16px":"44px 32px",textAlign:"center",cursor:"pointer",background:dragOver?T.accentBg:T.surface,transition:"all 0.18s",boxShadow:T.shadow}}>
              <div style={{width:52,height:52,borderRadius:13,background:T.accentBg,border:`1px solid ${T.accentBorder}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,margin:"0 auto 14px"}}>📊</div>
              <div style={{fontSize:15,fontWeight:600,color:T.text,marginBottom:5}}>Drop your spend CSV here</div>
              <div style={{fontSize:13,color:T.textMuted}}>or click to browse</div>
              <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
            </div>
            <div style={{marginTop:12,padding:"12px 14px",background:T.surface,borderRadius:9,border:`1px solid ${T.border}`,boxShadow:T.shadow}}>
              <SectionLabel T={T} style={{marginBottom:8}}>Supported sources</SectionLabel>
              <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                {["Google Ads","LinkedIn","Meta Ads","Microsoft Ads","Capterra","Funnel.io"].map(p=><span key={p} style={{fontSize:11,background:T.surfaceEl,color:T.textSub,padding:"3px 8px",borderRadius:5,fontWeight:500,border:`1px solid ${T.border}`}}>{p}</span>)}
              </div>
            </div>
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
            <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden",marginBottom:18,boxShadow:T.shadow}}>
              {[...REQUIRED_COLS,...OPTIONAL_COLS].map((field,i)=>(
                <div key={field} style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?"5px":"12px",padding:"10px 16px",borderBottom:i<REQUIRED_COLS.length+OPTIONAL_COLS.length-1?`1px solid ${T.border}`:"none",alignItems:"center",background:REQUIRED_COLS.includes(field)&&!colMap[field]?T.dangerBg:"transparent"}}>
                  <div><span style={{fontSize:13,fontWeight:500,color:T.text}}>{COL_LABELS[field]}</span>{REQUIRED_COLS.includes(field)&&<span style={{fontSize:10,color:T.danger,marginLeft:6,fontWeight:600}}>required</span>}{!REQUIRED_COLS.includes(field)&&<span style={{fontSize:10,color:T.textMuted,marginLeft:6}}>optional</span>}</div>
                  <Sel value={colMap[field]||""} onChange={v=>setColMap(p=>({...p,[field]:v||undefined}))} T={T}><option value="">— not mapped —</option>{headers.map(h=><option key={h} value={h}>{h}</option>)}</Sel>
                </div>
              ))}
            </div>
            {canProceed&&<div style={{padding:"10px 14px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:8,marginBottom:14,fontSize:13,color:T.success,fontWeight:500}}>✓ Found <strong>{campaigns.length}</strong> campaigns · <strong>{fmt$(campaigns.reduce((s,c)=>s+c.spend,0))}</strong> total spend</div>}
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <Btn onClick={()=>setStep("upload")} variant="ghost" T={T}>← Back</Btn>
              <Btn onClick={()=>setStep("tag")} disabled={!canProceed} variant="primary" T={T} size="md">Continue to tagging →</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── TAGGER ── */}
      {step==="tag"&&view==="tagger"&&(
        <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>
          {!isMobile&&(
            <aside style={{width:216,flexShrink:0,borderRight:`1px solid ${T.border}`,background:T.sidebarBg,overflow:"auto",display:"flex",flexDirection:"column"}}>
              <div style={{padding:"14px 14px 0"}}>
                <SectionLabel T={T}>Tag Dimensions</SectionLabel>
                <div style={{display:"flex",flexDirection:"column",gap:1,marginBottom:8}}>
                  {tagDims.map(dim=>(
                    <div key={dim} onClick={()=>setApplyDim(dim)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 8px",borderRadius:6,cursor:"pointer",background:applyDim===dim?T.accentBg:"transparent"}}>
                      <span style={{fontSize:13,color:applyDim===dim?T.accent:T.text,fontWeight:applyDim===dim?600:400}}>{dim}</span>
                      <span style={{fontSize:11,color:T.textMuted,fontFamily:"'JetBrains Mono',monospace"}}>{Object.values(tags).filter(t=>t[dim]).length}</span>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",gap:5,marginBottom:2}}>
                  <Inp value={newDim} onChange={setNewDim} placeholder="New dimension…" T={T} onKeyDown={e=>e.key==="Enter"&&addDim()} style={{fontSize:12,padding:"5px 8px"}}/>
                  <button onClick={addDim} style={{background:T.accentBg,border:`1px solid ${T.accentBorder}`,color:T.accent,borderRadius:6,padding:"0 10px",cursor:"pointer",fontSize:16,lineHeight:1,flexShrink:0,fontFamily:"Manrope,sans-serif"}}>+</button>
                </div>
              </div>
              <Divider T={T}/>
              <div style={{padding:"0 14px",flex:1}}>
                <SectionLabel T={T}>Overview</SectionLabel>
                {[{l:"Campaigns",v:stats.total.toString()},{l:"Showing",v:filtered.length.toString(),c:T.accent},{l:"Tagged",v:stats.tagged.toString(),c:T.success},{l:"Needs review",v:stats.untagged.toString(),c:stats.untagged>0?T.warning:T.success},{l:"Total spend",v:fmt$(stats.totalSpend)},{l:"Data rows",v:stats.totalRows.toLocaleString()}].map(s=><StatRow key={s.l} label={s.l} value={s.v} color={s.c} T={T}/>)}
                {stats.dateRange&&<div style={{fontSize:11,color:T.textMuted,marginTop:8,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.6}}>{stats.dateRange}</div>}
                <div style={{marginTop:10,height:3,background:T.border,borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${stats.total?(stats.tagged/stats.total)*100:0}%`,background:T.accent,transition:"width 0.4s",borderRadius:2}}/></div>
                <div style={{fontSize:11,color:T.textMuted,marginTop:4}}>{stats.total?Math.round((stats.tagged/stats.total)*100):0}% tagged</div>
              <div style={{marginTop:12}}>
                <Btn onClick={exportTags} disabled={!campaigns.length} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↓ Export tags CSV</Btn>
                <Btn onClick={()=>importTagsRef.current?.click()} variant="ghost" size="sm" T={T} style={{width:"100%",justifyContent:"center"}}>↑ Import tags CSV</Btn>
                <input ref={importTagsRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>{importTagsFromCSV(e.target.files[0]);e.target.value="";}} />
              </div>
              </div>
            </aside>
          )}

          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
            {suggestions.length>0&&(
              <div style={{padding:"7px 16px",background:T.accentBg,borderBottom:`1px solid ${T.accentBorder}`,display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",flexShrink:0}}>
                <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",color:T.accent}}>Suggest</span>
                {suggestions.map(s=><button key={s.key} onClick={()=>applySug(s.dim,s.val)} style={{fontSize:12,background:T.surface,border:`1px solid ${T.accentBorder}`,color:T.accent,borderRadius:20,padding:"3px 10px",cursor:"pointer",fontFamily:"Manrope,sans-serif",fontWeight:500}}>Apply {s.dim}: {s.val} to {s.count} untagged</button>)}
              </div>
            )}
            {selected.size>0&&(
              <div style={{padding:"8px 16px",background:T.surface,borderBottom:`1px solid ${T.border}`,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",flexShrink:0}}>
                <Pill color={T.accent} bg={T.accentBg} border={T.accentBorder}>{selected.size} selected</Pill>
                <span style={{color:T.textMuted,fontSize:13}}>→</span>
                <Sel value={applyDim} onChange={setApplyDim} T={T} style={{width:130,fontSize:12}}><option value="">Dimension…</option>{tagDims.map(d=><option key={d} value={d}>{d}</option>)}</Sel>
                <Inp value={applyVal} onChange={setApplyVal} placeholder="Tag value…" T={T} style={{width:130,fontSize:12}} onKeyDown={e=>e.key==="Enter"&&applyTags()}/>
                <Btn onClick={applyTags} disabled={!applyDim||!applyVal} variant="primary" size="sm" T={T}>Apply</Btn>
                <Btn onClick={()=>bulkRemoveTag(applyDim)} disabled={!applyDim} variant="danger" size="sm" T={T}>Remove</Btn>
                <Btn onClick={()=>setSelected(new Set())} variant="ghost" size="sm" T={T}>Clear</Btn>
              </div>
            )}

            <div style={{borderBottom:`1px solid ${T.border}`,background:T.headerBg,flexShrink:0}}>
              <div style={{display:"grid",gridTemplateColumns:isMobile?"32px 1fr 90px":"32px minmax(200px,1fr) 110px 130px minmax(180px,1fr)",padding:"9px 16px 4px",alignItems:"end",gap:6}}>
                <input type="checkbox" checked={filtered.length>0&&selected.size===filtered.length} onChange={selAll} style={{cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                <SH col="campaign" label="Campaign"/>
                <SH col="spend" label="Spend"/>
                {!isMobile&&<SH col="platform" label="Platform"/>}
                {!isMobile&&<SH col="tags" label="Tags"/>}
              </div>
              <div style={{display:"grid",gridTemplateColumns:isMobile?"32px 1fr 90px":"32px minmax(200px,1fr) 110px 130px minmax(180px,1fr)",padding:"3px 16px 8px",gap:6,alignItems:"start"}}>
                <div/>
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
                    {hasF&&<button onClick={clearF} style={{background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,color:T.danger,borderRadius:5,padding:"0 8px",cursor:"pointer",fontSize:11,fontFamily:"Manrope,sans-serif",whiteSpace:"nowrap"}}>Clear ×</button>}
                  </div>
                  <input value={fTagExclude} onChange={e=>setFTagExclude(e.target.value)} placeholder="≠ tag excludes…" style={{...fIn,borderColor:fTagExclude?"#ef4444":undefined,color:fTagExclude?"#ef4444":undefined}}/>
                </div>}
              </div>
            </div>

            <div style={{overflow:"auto",flex:1}}>
              {filtered.map((c,ri)=>{
                const ts=tags[c.name]||{};const tc=Object.keys(ts).length;const isSel=selected.has(c.name);const pc=PLATFORM_COLORS[c.platform]||T.textMuted;
                return(
                  <div key={c.name} onClick={()=>toggleSel(c.name)}
                    style={{display:"grid",gridTemplateColumns:isMobile?"32px 1fr 90px":"32px minmax(200px,1fr) 110px 130px minmax(180px,1fr)",padding:"9px 16px",borderBottom:`1px solid ${T.border}`,alignItems:"center",cursor:"pointer",background:isSel?T.rowSelected:ri%2===0?"transparent":T.surfaceEl,transition:"background 0.1s",gap:6}}>
                    <input type="checkbox" checked={isSel} onChange={()=>toggleSel(c.name)} onClick={e=>e.stopPropagation()} style={{cursor:"pointer",accentColor:T.accent,width:14,height:14}}/>
                    <div style={{minWidth:0}}><div style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</div>{c.adsetCount>0&&<div style={{fontSize:10,color:T.textMuted,marginTop:1}}>{c.adsetCount} ad sets</div>}</div>
                    <div style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace",fontWeight:600,color:T.text}}>{fmt$(c.spend)}</div>
                    {!isMobile&&<div><span style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:500,padding:"2px 8px",borderRadius:5,background:pc+"18",color:pc,border:`1px solid ${pc}30`,whiteSpace:"nowrap"}}>{c.platform}</span></div>}
                    {!isMobile&&<div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
                      {tc===0?<Pill color={T.warning} bg={T.warningBg} border={T.warningBorder}>needs review</Pill>:
                        Object.entries(ts).map(([dim,val])=>(
                          <span key={dim} style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:500,padding:"2px 8px",borderRadius:20,background:T.accentBg,color:T.accent,border:`1px solid ${T.accentBorder}`,gap:3,fontFamily:"Manrope,sans-serif"}}>
                            {dim}: {val}<span onClick={e=>{e.stopPropagation();removeTag(c.name,dim);}} style={{color:T.textMuted,cursor:"pointer",fontSize:13,lineHeight:1,marginLeft:1}}>×</span>
                          </span>
                        ))
                      }
                    </div>}
                  </div>
                );
              })}
              {filtered.length===0&&<div style={{padding:"52px 20px",textAlign:"center",color:T.textMuted,fontSize:13}}>No campaigns match your filters.{hasF&&<span onClick={clearF} style={{color:T.accent,cursor:"pointer",marginLeft:6,fontWeight:500}}>Clear filters</span>}</div>}
            </div>
          </div>
        </div>
      )}

      {view==="dashboard"&&<Dashboard T={T} onNavigate={v=>{if(v==="tagger"){if(step==="upload"||step==="map"){}else setStep("tag");setView("tagger");}else setView(v);}} stats={stats} hasData={step==="tag"}/>}
      {view==="budget"&&<BudgetManager campaignTags={tags} tagDimensions={tagDims} T={T} isMobile={isMobile} onAddDimensions={newDims=>setTagDims(p=>[...new Set([...p,...newDims])])} budgets={budgets} setBudgets={setBudgets} budgetDims={budgetDims} setBudgetDims={setBudgetDims}/>}

      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        html,body{height:100%;width:100%;overflow:hidden;}
        #root{height:100%;width:100%;display:flex;flex-direction:column;}
        body{font-family:'Manrope',sans-serif;-webkit-font-smoothing:antialiased;}
        input,select,button,textarea{font-family:'Manrope',sans-serif;}
        input::placeholder{color:${T.textDim};}
        select option{background:${T.surface};color:${T.text};}
        ::-webkit-scrollbar{width:5px;height:5px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:${T.borderStrong};border-radius:3px;}
        @keyframes spin{to{transform:rotate(360deg);}}
        @media(max-width:768px){input,select{font-size:16px!important;}}
      `}</style>
    </div>
  );
}
