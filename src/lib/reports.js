import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { THEME } from "./core.js";
import { campaignKey, derivePlatform, computePacing, pacingStatusMeta } from "./core.js";

// src/lib/reports.js — Export report builders (2026-07-25 split, per Mo). Every exportable
// view (Dashboard, Campaign Tagger, Budget Panel, Reporting & Pacing) is first turned into one
// common shape — {title, subtitle, sections:[{heading,headers,rows}]} — regardless of which tab
// it came from. The four format generators below only have to be written once against that
// shape, and "Email a copy" reuses the exact same generators (as a Blob instead of a download),
// so a report never has to be built twice or risk drifting between the download and email paths.
// Uses THEME directly (not a T prop) since these run outside the React render tree.

export function buildDashboardReport({mergedNormRows,tags,tagDims,budgets,budgetDims,budgetRowMeta,defaultForecastModel,combineGoogleChannels=false}){
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
      const pacing=computePacing({mergedNormRows:mergedNormRows||[],tags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date(),budgetRowMeta,defaultForecastModel,combineGoogleChannels});
      pacing.segments.forEach(s=>{statusCounts[s.status]=(statusCounts[s.status]||0)+1;});
    });
  }
  const pacingRows=Object.entries(statusCounts).map(([status,count])=>[pacingStatusMeta(status,THEME).label,String(count)]);

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

export function buildTaggerReport({mergedNormRows,tags,tagDims}){
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

export function buildBudgetReport({budgets,budgetDims,budgetRowMeta,defaultForecastModel,budgetMetaDims,mergedNormRows,tags,combineGoogleChannels=false}){
  const years=Object.keys(budgets||{}).sort();
  const sections=years.map(year=>{
    const yearBudgets=budgets[year]||{};
    const pacing=(budgetDims||[]).length?computePacing({mergedNormRows:mergedNormRows||[],tags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date(),budgetRowMeta,defaultForecastModel,combineGoogleChannels}):{segments:[]};
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
        p?pacingStatusMeta(p.status,THEME).label:pacingStatusMeta("no-budget",THEME).label,
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

// buildPacingReport lived here until 2026-08-01 (per Mo — "export function from the budget
// pacing tab"). Removed rather than fixed: it hardcoded periodType:"annual" and looped every
// year in `budgets`, which was always wrong once Budget Pacing became its own tab with its own
// Mo/Qtr/Yr period picker (that period selection is local state inside PacingDashboard.jsx —
// this top-level EXPORTABLE_VIEWS/handleExportDownload machinery in PaidHQ.jsx has no way to
// see it). A period-aware export now lives directly in PacingDashboard's own toolbar instead,
// built from the exact same filteredSegments/customPacing the visible table already computes —
// see buildPacingExportReport there. "pacing" was removed from EXPORTABLE_VIEWS below so the
// rail's "More" menu doesn't offer a second, disagreeing, non-period-aware export for that tab.

export const EXPORTABLE_VIEWS={
  dashboard:{label:"Dashboard",build:buildDashboardReport,filenameBase:"paidhq-dashboard"},
  tagger:{label:"Campaign Tagger",build:buildTaggerReport,filenameBase:"paidhq-campaign-tagger"},
  budget:{label:"Budget Panel",build:buildBudgetReport,filenameBase:"paidhq-budget-panel"},
};
export const EXPORT_FORMATS=[{key:"csv",label:"CSV",mime:"text/csv;charset=utf-8"},{key:"xlsx",label:"Excel",mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},{key:"pdf",label:"PDF",mime:"application/pdf"},{key:"html",label:"HTML",mime:"text/html;charset=utf-8"}];

export const escHtml=s=>String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

export function reportToCSVString(report){
  const rows=[];
  report.sections.forEach((sec,i)=>{
    if(i>0)rows.push([]);
    rows.push([sec.heading]);
    rows.push(sec.headers);
    (sec.rows.length?sec.rows:[["No data"]]).forEach(r=>rows.push(r));
  });
  return rows.map(r=>r.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\n");
}

export function reportToHTMLString(report){
  const sectionsHtml=report.sections.map(sec=>`
    <h2 style="font-size:16px;font-weight:700;color:#171717;margin:28px 0 10px;">${escHtml(sec.heading)}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr>${sec.headers.map(h=>`<th style="text-align:left;padding:8px 10px;background:#FAFAFA;border-bottom:2px solid #D4D4D4;color:#666666;font-weight:600;">${escHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${(sec.rows.length?sec.rows:null)?sec.rows.map((r,i)=>`<tr style="background:${i%2?"#FAFAFA":"#FFFFFF"};">${r.map(c=>`<td style="padding:7px 10px;border-bottom:1px solid #EAEAEA;color:#171717;">${escHtml(c)}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${sec.headers.length}" style="padding:14px 10px;color:#8F8F8F;">No data</td></tr>`}</tbody>
    </table>`).join("");
  return`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(report.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"></head>
  <body style="font-family:'DM Sans',-apple-system,sans-serif;background:#FFFFFF;padding:32px;margin:0;">
    <div style="max-width:900px;margin:0 auto;background:#FFFFFF;border-radius:8px;padding:32px 36px;border:1px solid #EAEAEA;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
        <span style="width:26px;height:26px;border-radius:7px;background:#000000;display:inline-block;"></span>
        <span style="font-size:15px;font-weight:700;color:#171717;">PaidHQ</span>
      </div>
      <h1 style="font-size:22px;font-weight:800;color:#171717;margin:18px 0 2px;">${escHtml(report.title)}</h1>
      <p style="font-size:12px;color:#8F8F8F;margin:0 0 8px;">${escHtml(report.subtitle)}</p>
      ${sectionsHtml}
    </div>
  </body></html>`;
}

export function buildReportPDFDoc(report){
  const doc=new jsPDF({unit:"pt",format:"letter"});
  const marginX=40;let y=50;
  doc.setFillColor(0,0,0);
  doc.roundedRect(marginX,y-14,18,18,4,4,"F");
  doc.setFontSize(13);doc.setTextColor(23,23,23);doc.setFont(undefined,"bold");
  doc.text("PaidHQ",marginX+26,y+1);
  y+=28;
  doc.setFontSize(18);doc.text(report.title,marginX,y);
  y+=15;
  doc.setFont(undefined,"normal");doc.setFontSize(9);doc.setTextColor(143,143,143);
  doc.text(report.subtitle,marginX,y);
  y+=12;
  report.sections.forEach(sec=>{
    if(y>700){doc.addPage();y=50;}
    doc.setFontSize(12);doc.setTextColor(23,23,23);doc.setFont(undefined,"bold");
    doc.text(sec.heading,marginX,y+16);
    autoTable(doc,{
      startY:y+22,margin:{left:marginX,right:marginX},
      head:[sec.headers],
      body:sec.rows.length?sec.rows:[sec.headers.map((h,i)=>i===0?"No data":"")],
      styles:{fontSize:8.5,cellPadding:5,textColor:[23,23,23]},
      headStyles:{fillColor:[250,250,250],textColor:[102,102,102],fontStyle:"bold",lineWidth:0.5,lineColor:[212,212,212]},
      alternateRowStyles:{fillColor:[250,250,250]},
      theme:"grid",
    });
    y=doc.lastAutoTable.finalY+26;
  });
  return doc;
}

// Builds the same file either format produces, as a Blob — shared by the download buttons and
// "Email a copy" (which base64-encodes this same Blob as an email attachment) so there's exactly
// one code path per format, not two that could quietly drift apart.
export function buildReportBlob(report,format){
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

export function downloadReport(report,format,filenameBase){
  const blob=buildReportBlob(report,format);
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=`${filenameBase}.${format}`;a.click();URL.revokeObjectURL(url);
}

export function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onloadend=()=>resolve(String(reader.result).split(",")[1]||"");
    reader.onerror=reject;
    reader.readAsDataURL(blob);
  });
}

// Hand-rolled multi-line SVG chart for computeSpendTrend's output — no charting library
// dependency, matching every other visual in this file (PacingBar, SpendVsBudgetBar,
// PlatformSpendBars are all plain SVG/div too). One polyline per series (e.g. one per channel),
// sharing a single y-axis scaled to the highest point across every series so lines stay
// comparable to each other rather than each auto-scaling to its own range.
