import { useEffect, useMemo, useState } from "react";
import { computeDataAudit, computeReportingAudit, PLATFORM_COLORS, fmtFull } from "../lib/core.js";
import { listReportingFacts } from "../lib/reportingApi.js";
import { PERIOD_TYPE_LABELS, labelForPeriod } from "../lib/reportingPeriods.js";
import { Icon, PixelPanel, DashStatTile, Pill, SectionLabel } from "./shared.jsx";

// src/components/DataAudit.jsx — Data Audit tab (2026-07-31, per Mo; PowerBI/reporting_facts
// section added 2026-08-01, per Mo — "let's add the powerBI data to it").
//
// "I need a new tab where I can review in detail what data has been brought into PaidHQ and from
// where. I need to know if there are any gaps in dates... where there is any overlap... where there
// are any conflicts from a data standpoint... whether manual or synced." Originally scoped to
// spend/dates only — CRM data is still future work, but Dreamdata/PowerBI (core.reporting_facts,
// the same table the Reporting Analyzer tab imports into) now has its own section below the spend
// one, covering the exact same questions (coverage, gaps, sources) for that data instead.
//
// Two independent data domains, two independent audits: computeDataAudit (spend_rows, via
// mergedNormRows already loaded by PaidHQ.jsx) and computeReportingAudit (reporting_facts, fetched
// by this component directly via listReportingFacts — reporting_facts isn't part of PaidHQ.jsx's
// central workspace-data load the way spend is, so this tab loads it independently, same pattern
// ReportingAnalyzer.jsx's own refreshHistory already uses). See computeReportingAudit's own doc
// comment (lib/core.js) for why its shape differs from computeDataAudit's — mixed period grains
// instead of daily rows, no platform dimension, and no overlap concept (reporting_facts can't
// silently conflict the way spend can; its upsert path merges instead of overwriting).
//
// Deliberately reads the RAW mergedNormRows, not the excludedFromData-filtered visibleNormRows —
// same reasoning as Data Sources' own Import start/end columns (see PaidHQ.jsx's
// importDateRangeByProvider): an audit tool that hides a paused/excluded connector's history isn't
// actually auditing the true stored state, it's auditing a curated subset of it.
//
// All the actual spend gap/overlap math lives in computeDataAudit (lib/core.js) — see that
// function's own doc comment for the important limitation this tab inherits: mergeRows() is
// last-write-wins, so a VALUE disagreement between two sources for a day that already got merged
// can't be reconstructed after the fact, only RANGE overlap (which sources claim overlapping date
// spans) can.

const MANUAL_SOURCE_LABELS={
  csv:"CSV upload",
  screenshot:"Screenshot import",
  "sheet-onetime":"Google Sheet (one-time pull)",
  manual:"Manual import (unlabeled — synced/imported before source tagging shipped)",
};
// Mirrors PLATFORMS' labels in PaidHQ.jsx for the "sync:<provider>" case — duplicated rather than
// imported since PLATFORMS is defined inline in that file, not exported (same accepted
// duplicated-metadata pattern already used elsewhere in this codebase, e.g. bing.js/googlesheets.js
// across the two repos).
const CONNECTOR_LABELS={
  googlesheets:"Google Sheets",bing:"Bing",linkedin:"LinkedIn",meta:"Meta Ads",google:"Google Ads",
  funnel:"Funnel.io",supermetrics:"Supermetrics",capterra:"Capterra",
};
function sourceLabel(sourceKey){
  if(!sourceKey||sourceKey==="manual")return MANUAL_SOURCE_LABELS.manual;
  if(sourceKey.startsWith("sync:")){
    const provider=sourceKey.slice(5);
    return`Live sync — ${CONNECTOR_LABELS[provider]||provider}`;
  }
  return MANUAL_SOURCE_LABELS[sourceKey]||sourceKey;
}
function sourceIsLive(sourceKey){return(sourceKey||"").startsWith("sync:");}
const fmtDate=iso=>iso?new Date(`${iso}T00:00:00`).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}):"—";
const fmtRange=(start,end)=>start&&end?(start===end?fmtDate(start):`${fmtDate(start)} → ${fmtDate(end)}`):"—";

// reporting_facts' own source vocabulary (see api/workspaces/[id]/reporting-facts.js's column
// comment: "dreamdata_csv" | "dreamdata_screenshot") — separate map from MANUAL_SOURCE_LABELS above
// since spend's "screenshot" and reporting's "dreamdata_screenshot" are different sources on
// different tables, not the same value reused.
const REPORTING_SOURCE_LABELS={
  dreamdata_screenshot:"Dreamdata/PowerBI screenshot",
  dreamdata_csv:"Dreamdata/PowerBI CSV",
};
function reportingSourceLabel(sourceKey){
  if(!sourceKey||sourceKey==="manual")return"Manual import (unlabeled)";
  return REPORTING_SOURCE_LABELS[sourceKey]||sourceKey;
}
const fmtPct=n=>`${n}%`;

export default // ─── DATA AUDIT ───────────────────────────────────────────────────────────────
function DataAudit({T,session,workspace,mergedNormRows,combineGoogleChannels=false,tagDims=[]}){
  const audit=useMemo(()=>computeDataAudit({mergedNormRows:mergedNormRows||[],combineGoogleChannels}),[mergedNormRows,combineGoogleChannels]);
  const{overview,bySource,byPlatform}=audit;
  const platformsWithGaps=byPlatform.filter(p=>p.gapDayCount>0);
  const platformsWithOverlap=byPlatform.filter(p=>p.overlapRanges.length>0);
  // Collapsed by default once there's real data (a workspace with a handful of platforms and years
  // of history would otherwise dump a wall of gap/overlap detail on first load) — auto-expanded for
  // any platform that actually has something to flag, so the useful bit is never hidden behind an
  // extra click while the clean ones stay tidy.
  const[expanded,setExpanded]=useState(()=>new Set());
  const isExpanded=p=>expanded.has(p)||byPlatform.find(x=>x.platform===p)?.gapDayCount>0||byPlatform.find(x=>x.platform===p)?.overlapRanges.length>0;
  const toggle=p=>setExpanded(s=>{const n=new Set(s);if(isExpanded(p)&&s.has(p)){n.delete(p);}else if(isExpanded(p)){n.add(p);/* was auto-expanded via flags; explicit add lets the next click collapse it */}else n.add(p);return n;});

  // reporting_facts isn't part of PaidHQ.jsx's central workspace-data load (mergedNormRows is) —
  // it's loaded independently here, same pattern ReportingAnalyzer.jsx's own refreshHistory already
  // uses. null = still loading (distinct from [], an actually-empty workspace) so the section below
  // can show "Loading…" instead of flashing an empty state first.
  const[reportingFacts,setReportingFacts]=useState(null);
  const[reportingFactsError,setReportingFactsError]=useState("");
  useEffect(()=>{
    if(!workspace?.id||!session)return;
    listReportingFacts(session,workspace.id)
      .then(rows=>{setReportingFacts(rows);setReportingFactsError("");})
      .catch(err=>{setReportingFacts([]);setReportingFactsError(err.message||"Couldn't load Reporting Analyzer data.");});
  },[session,workspace?.id]);
  const reportingLoading=reportingFacts===null;
  const reportingAudit=useMemo(()=>computeReportingAudit({reportingFacts:reportingFacts||[],tagDims}),[reportingFacts,tagDims]);
  const{overview:rOverview,bySource:rBySource,byPeriodType,tagCompleteness}=reportingAudit;
  const periodTypesWithGaps=byPeriodType.filter(p=>p.gapPeriodCount>0);
  const incompleteTagDims=tagCompleteness.filter(t=>t.missing>0);
  const[reportingExpanded,setReportingExpanded]=useState(()=>new Set());
  const isReportingExpanded=pt=>reportingExpanded.has(pt)||byPeriodType.find(x=>x.periodType===pt)?.gapPeriodCount>0;
  const toggleReporting=pt=>setReportingExpanded(s=>{const n=new Set(s);if(isReportingExpanded(pt)&&s.has(pt)){n.delete(pt);}else if(isReportingExpanded(pt)){n.add(pt);}else n.add(pt);return n;});

  const hasSpend=overview.totalRows>0;
  const hasReporting=rOverview.totalRows>0;

  if(!hasSpend&&!hasReporting&&!reportingLoading){
    return(
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:40}}>
        <div style={{textAlign:"center",maxWidth:420}}>
          <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6,fontFamily:"'DM Sans',sans-serif"}}>No data yet</div>
          <div style={{fontSize:13,color:T.textMuted,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif"}}>Connect a data source or upload a CSV/screenshot in Data Sources, or import a Dreamdata/PowerBI screenshot in Reporting Analyzer, then come back here to see coverage, gaps, and overlaps across everything that's been brought in.</div>
        </div>
      </div>
    );
  }

  return(
    <div style={{flex:1,overflow:"auto",padding:isMobilePad()?"16px":"24px 28px"}}>
      <div style={{maxWidth:1040,margin:"0 auto"}}>
        <div style={{marginBottom:20}}>
          <h2 style={{fontSize:20,fontWeight:700,color:T.text,letterSpacing:"-0.3px",marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>Data Audit</h2>
          <p style={{fontSize:13,color:T.textSub,fontFamily:"'DM Sans',sans-serif",maxWidth:640}}>Every spend row and every Dreamdata/PowerBI import currently stored in PaidHQ — where it came from, what date range it covers, and where there are gaps or overlapping coverage. CRM data is still future work.</p>
        </div>

        <SectionLabel T={T} style={{marginBottom:8}}>Spend</SectionLabel>
        {!hasSpend?(
          <div style={{fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif",marginBottom:24}}>No spend data imported yet — connect a source or upload a CSV/screenshot in Data Sources.</div>
        ):(<>
        {/* Overview */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:18}}>
          <DashStatTile T={T} label="Spend rows" value={overview.totalRows.toLocaleString()}/>
          <DashStatTile T={T} label="Total spend" value={fmtFull(overview.totalSpend)}/>
          <DashStatTile T={T} label="Date range" value={fmtRange(overview.earliest,overview.latest)}/>
          <DashStatTile T={T} label="Platforms" value={overview.platformCount.toLocaleString()}/>
          <DashStatTile T={T} label="Sources" value={overview.sourceCount.toLocaleString()}/>
          <DashStatTile T={T} label="Campaigns" value={overview.campaignCount.toLocaleString()}/>
        </div>
        {overview.unparseableDates>0&&(
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:T.warningBg,border:`1px solid ${T.warningBorder}`,borderRadius:8,marginBottom:14,fontSize:12,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>
            <Icon name="alert" size={13} color={T.warning}/>
            {overview.unparseableDates.toLocaleString()} row{overview.unparseableDates===1?"":"s"} {overview.unparseableDates===1?"has":"have"} a date PaidHQ couldn't parse — excluded from every stat below (not from your actual data, just this audit's date math).
          </div>
        )}

        {/* Triage banner — only shows when there's actually something to flag */}
        {(platformsWithGaps.length>0||platformsWithOverlap.length>0)&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:18}}>
            {platformsWithGaps.length>0&&(
              <Pill color={T.danger} bg={T.dangerBg} border={T.dangerBorder}>
                <Icon name="alert" size={11} color={T.danger} style={{marginRight:4}}/>
                {platformsWithGaps.length} platform{platformsWithGaps.length===1?"":"s"} with date gaps
              </Pill>
            )}
            {platformsWithOverlap.length>0&&(
              <Pill color={T.warning} bg={T.warningBg} border={T.warningBorder}>
                <Icon name="info" size={11} color={T.warning} style={{marginRight:4}}/>
                {platformsWithOverlap.length} platform{platformsWithOverlap.length===1?"":"s"} with overlapping source coverage
              </Pill>
            )}
          </div>
        )}
        {platformsWithGaps.length===0&&platformsWithOverlap.length===0&&(
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:8,marginBottom:18,fontSize:12,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>
            <Icon name="check" size={13} color={T.success}/>
            No date gaps or overlapping source coverage detected across any platform.
          </div>
        )}

        {/* By source */}
        <SectionLabel T={T} style={{marginBottom:8}}>By source</SectionLabel>
        <PixelPanel T={T} style={{marginBottom:24,overflow:"hidden"}} contentStyle={{background:T.surface}}>
          <div style={{display:"grid",gridTemplateColumns:isMobilePad()?undefined:"1.6fr 1fr 1.4fr 0.7fr 0.9fr 0.7fr",gap:8,padding:"8px 14px",background:T.headerBg,borderBottom:`1px solid ${T.border}`,fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.textMuted}}>
            <div>Source</div><div>Kind</div><div>Date range</div><div style={{textAlign:"right"}}>Rows</div><div style={{textAlign:"right"}}>Spend</div><div style={{textAlign:"right"}}>Campaigns</div>
          </div>
          {bySource.map((s,i)=>(
            <div key={s.sourceKey} style={{display:"grid",gridTemplateColumns:isMobilePad()?undefined:"1.6fr 1fr 1.4fr 0.7fr 0.9fr 0.7fr",gap:8,padding:"10px 14px",borderTop:i>0?`1px solid ${T.border}`:"none",fontSize:12.5,color:T.text,alignItems:"center",fontFamily:"'DM Sans',sans-serif"}}>
              <div style={{fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sourceLabel(s.sourceKey)}</div>
              <div>
                <Pill color={sourceIsLive(s.sourceKey)?T.success:T.textSub} bg={sourceIsLive(s.sourceKey)?T.successBg:T.surfaceEl} border={sourceIsLive(s.sourceKey)?T.successBorder:T.border} style={{fontSize:10}}>
                  {sourceIsLive(s.sourceKey)?"Live sync":"Manual"}
                </Pill>
              </div>
              <div style={{color:T.textSub}}>{fmtRange(s.start,s.end)}</div>
              <div style={{textAlign:"right"}}>{s.rows.toLocaleString()}</div>
              <div style={{textAlign:"right",fontWeight:600}}>{fmtFull(s.spend)}</div>
              <div style={{textAlign:"right",color:T.textSub}}>{s.campaigns.toLocaleString()}</div>
            </div>
          ))}
        </PixelPanel>

        {/* By platform */}
        <SectionLabel T={T} style={{marginBottom:8}}>By platform</SectionLabel>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
          {byPlatform.map(p=>{
            const open=isExpanded(p.platform);
            const hasIssues=p.gapDayCount>0||p.overlapRanges.length>0;
            return(
              <PixelPanel key={p.platform} T={T} contentStyle={{background:T.surface,overflow:"hidden"}}>
                <div onClick={()=>toggle(p.platform)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,padding:"12px 16px",cursor:"pointer"}}>
                  <div style={{display:"flex",alignItems:"center",gap:9,minWidth:0}}>
                    <span style={{width:9,height:9,borderRadius:"50%",background:PLATFORM_COLORS[p.platform]||T.textMuted,flexShrink:0}}/>
                    <span style={{fontSize:14,fontWeight:700,color:T.text,fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.platform}</span>
                    {hasIssues&&(
                      <span style={{display:"flex",gap:5,flexShrink:0}}>
                        {p.gapDayCount>0&&<Pill color={T.danger} bg={T.dangerBg} border={T.dangerBorder} style={{fontSize:10}}>{p.gapDayCount} gap day{p.gapDayCount===1?"":"s"}</Pill>}
                        {p.overlapRanges.length>0&&<Pill color={T.warning} bg={T.warningBg} border={T.warningBorder} style={{fontSize:10}}>overlap</Pill>}
                      </span>
                    )}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:16,flexShrink:0,fontSize:12,color:T.textSub,fontFamily:"'DM Sans',sans-serif"}}>
                    <span>{fmtRange(p.start,p.end)}</span>
                    <span style={{fontWeight:600,color:T.text}}>{fmtFull(p.spend)}</span>
                    <Icon name="chevronDown" size={14} color={T.textMuted} style={{transform:open?"rotate(180deg)":"none",transition:"transform 0.12s"}}/>
                  </div>
                </div>
                {open&&(
                  <div style={{padding:"0 16px 16px",borderTop:`1px solid ${T.border}`}}>
                    <div style={{display:"flex",gap:24,flexWrap:"wrap",padding:"12px 0"}}>
                      <div style={{fontSize:11,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}><strong style={{color:T.text}}>{p.rows.toLocaleString()}</strong> rows</div>
                      <div style={{fontSize:11,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}><strong style={{color:T.text}}>{p.campaigns.toLocaleString()}</strong> campaigns</div>
                      <div style={{fontSize:11,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}><strong style={{color:T.text}}>{p.sources.length.toLocaleString()}</strong> source{p.sources.length===1?"":"s"}</div>
                    </div>

                    <div style={{fontSize:11,fontWeight:700,color:T.textMuted,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:6}}>Sources feeding this platform</div>
                    <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:14}}>
                      {p.sources.map(s=>(
                        <div key={s.sourceKey} style={{display:"flex",justifyContent:"space-between",gap:10,fontSize:12,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>
                          <span>{sourceLabel(s.sourceKey)}</span>
                          <span style={{color:T.textSub,flexShrink:0}}>{fmtRange(s.start,s.end)} · {s.rows.toLocaleString()} rows · {fmtFull(s.spend)}</span>
                        </div>
                      ))}
                    </div>

                    {p.gapRanges.length>0&&(
                      <>
                        <div style={{fontSize:11,fontWeight:700,color:T.danger,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:6}}>Missing days ({p.gapDayCount})</div>
                        <div style={{fontSize:11,color:T.textMuted,marginBottom:6,fontFamily:"'DM Sans',sans-serif"}}>No data from any source on these calendar days, within this platform's own {fmtRange(p.start,p.end)} span.</div>
                        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:14}}>
                          {p.gapRanges.map((r,i)=>(
                            <Pill key={i} color={T.danger} bg={T.dangerBg} border={T.dangerBorder} style={{fontSize:10.5}}>
                              {r.start===r.end?fmtDate(r.start):`${fmtDate(r.start)} – ${fmtDate(r.end)}`} ({r.days}d)
                            </Pill>
                          ))}
                        </div>
                      </>
                    )}

                    {p.overlapRanges.length>0&&(
                      <>
                        <div style={{fontSize:11,fontWeight:700,color:T.warning,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:6}}>Overlapping coverage</div>
                        <div style={{fontSize:11,color:T.textMuted,marginBottom:6,fontFamily:"'DM Sans',sans-serif"}}>These sources both claim data for the same days — only one value is stored per campaign/day (the most recently synced or imported wins), so this doesn't necessarily mean the numbers disagreed, just that it was possible.</div>
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          {p.overlapRanges.map((o,i)=>(
                            <div key={i} style={{fontSize:12,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>
                              <strong>{sourceLabel(o.sourceA)}</strong> ↔ <strong>{sourceLabel(o.sourceB)}</strong>
                              <span style={{color:T.textSub}}> · {fmtRange(o.start,o.end)} ({o.days} day{o.days===1?"":"s"})</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </PixelPanel>
            );
          })}
        </div>
        </>)}

        {/* ── Reporting Analyzer / Dreamdata / PowerBI ────────────────────────────────────────── */}
        <SectionLabel T={T} style={{marginBottom:8}}>Reporting Analyzer (Dreamdata / PowerBI)</SectionLabel>
        {reportingLoading?(
          <div style={{fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif",marginBottom:24}}>Loading…</div>
        ):reportingFactsError?(
          <div style={{padding:"9px 12px",background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,borderRadius:8,fontSize:12,color:T.danger,fontFamily:"'DM Sans',sans-serif",marginBottom:24}}>{reportingFactsError}</div>
        ):!hasReporting?(
          <div style={{fontSize:12,color:T.textMuted,fontFamily:"'DM Sans',sans-serif",marginBottom:24}}>Nothing imported yet — upload a Dreamdata/PowerBI screenshot in Reporting Analyzer.</div>
        ):(<>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:18}}>
          <DashStatTile T={T} label="Reporting rows" value={rOverview.totalRows.toLocaleString()}/>
          <DashStatTile T={T} label="Date range" value={fmtRange(rOverview.earliest,rOverview.latest)}/>
          <DashStatTile T={T} label="Period grains" value={rOverview.periodTypeCount.toLocaleString()}/>
          <DashStatTile T={T} label="Sources" value={rOverview.sourceCount.toLocaleString()}/>
          <DashStatTile T={T} label="Campaigns" value={rOverview.campaignCount.toLocaleString()}/>
          <DashStatTile T={T} label="Last imported" value={rOverview.lastImportedAt?fmtDate(rOverview.lastImportedAt.slice(0,10)):"—"}/>
        </div>

        {/* Triage banner */}
        {(periodTypesWithGaps.length>0||incompleteTagDims.length>0)&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:18}}>
            {periodTypesWithGaps.length>0&&(
              <Pill color={T.danger} bg={T.dangerBg} border={T.dangerBorder}>
                <Icon name="alert" size={11} color={T.danger} style={{marginRight:4}}/>
                {periodTypesWithGaps.length} period grain{periodTypesWithGaps.length===1?"":"s"} with gaps
              </Pill>
            )}
            {incompleteTagDims.length>0&&(
              <Pill color={T.warning} bg={T.warningBg} border={T.warningBorder}>
                <Icon name="info" size={11} color={T.warning} style={{marginRight:4}}/>
                {incompleteTagDims.length} tag dimension{incompleteTagDims.length===1?"":"s"} incomplete on some rows
              </Pill>
            )}
          </div>
        )}
        {periodTypesWithGaps.length===0&&incompleteTagDims.length===0&&(
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:T.successBg,border:`1px solid ${T.successBorder}`,borderRadius:8,marginBottom:18,fontSize:12,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>
            <Icon name="check" size={13} color={T.success}/>
            No period gaps or incomplete tagging detected.
          </div>
        )}

        {tagDims.length>0&&(
          <>
            <SectionLabel T={T} style={{marginBottom:8}}>Tag completeness</SectionLabel>
            <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:24}}>
              {tagCompleteness.map(t=>(
                <div key={t.dimension} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:T.surface,border:`1px solid ${t.missing>0?T.warningBorder:T.border}`,borderRadius:8,fontSize:12,fontFamily:"'DM Sans',sans-serif"}}>
                  <span style={{fontWeight:600,color:T.text}}>{t.dimension}</span>
                  <span style={{color:t.missing>0?T.warning:T.textMuted}}>{t.missing===0?"complete":`${fmtPct(t.missingPct)} missing`}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* By source */}
        <SectionLabel T={T} style={{marginBottom:8}}>By source</SectionLabel>
        <PixelPanel T={T} style={{marginBottom:24,overflow:"hidden"}} contentStyle={{background:T.surface}}>
          <div style={{display:"grid",gridTemplateColumns:isMobilePad()?undefined:"1.8fr 1.6fr 0.7fr 0.9fr",gap:8,padding:"8px 14px",background:T.headerBg,borderBottom:`1px solid ${T.border}`,fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",color:T.textMuted}}>
            <div>Source</div><div>Date range</div><div style={{textAlign:"right"}}>Rows</div><div style={{textAlign:"right"}}>Campaigns</div>
          </div>
          {rBySource.map((s,i)=>(
            <div key={s.sourceKey} style={{display:"grid",gridTemplateColumns:isMobilePad()?undefined:"1.8fr 1.6fr 0.7fr 0.9fr",gap:8,padding:"10px 14px",borderTop:i>0?`1px solid ${T.border}`:"none",fontSize:12.5,color:T.text,alignItems:"center",fontFamily:"'DM Sans',sans-serif"}}>
              <div style={{fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{reportingSourceLabel(s.sourceKey)}</div>
              <div style={{color:T.textSub}}>{fmtRange(s.start,s.end)}</div>
              <div style={{textAlign:"right"}}>{s.rows.toLocaleString()}</div>
              <div style={{textAlign:"right",color:T.textSub}}>{s.campaigns.toLocaleString()}</div>
            </div>
          ))}
        </PixelPanel>

        {/* By period grain */}
        <SectionLabel T={T} style={{marginBottom:8}}>By period grain</SectionLabel>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
          {byPeriodType.map(p=>{
            const open=isReportingExpanded(p.periodType);
            const hasIssues=p.gapPeriodCount>0;
            return(
              <PixelPanel key={p.periodType} T={T} contentStyle={{background:T.surface,overflow:"hidden"}}>
                <div onClick={()=>toggleReporting(p.periodType)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,padding:"12px 16px",cursor:"pointer"}}>
                  <div style={{display:"flex",alignItems:"center",gap:9,minWidth:0}}>
                    <span style={{fontSize:14,fontWeight:700,color:T.text,fontFamily:"'DM Sans',sans-serif"}}>{PERIOD_TYPE_LABELS[p.periodType]||p.periodType}</span>
                    {hasIssues&&(
                      <Pill color={T.danger} bg={T.dangerBg} border={T.dangerBorder} style={{fontSize:10}}>{p.gapPeriodCount} missing period{p.gapPeriodCount===1?"":"s"}</Pill>
                    )}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:16,flexShrink:0,fontSize:12,color:T.textSub,fontFamily:"'DM Sans',sans-serif"}}>
                    <span>{fmtRange(p.start,p.end)}</span>
                    <span style={{fontWeight:600,color:T.text}}>{p.rows.toLocaleString()} rows</span>
                    <Icon name="chevronDown" size={14} color={T.textMuted} style={{transform:open?"rotate(180deg)":"none",transition:"transform 0.12s"}}/>
                  </div>
                </div>
                {open&&(
                  <div style={{padding:"0 16px 16px",borderTop:`1px solid ${T.border}`}}>
                    <div style={{display:"flex",gap:24,flexWrap:"wrap",padding:"12px 0"}}>
                      <div style={{fontSize:11,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}><strong style={{color:T.text}}>{p.rows.toLocaleString()}</strong> rows</div>
                      <div style={{fontSize:11,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}><strong style={{color:T.text}}>{p.campaigns.toLocaleString()}</strong> campaigns</div>
                    </div>
                    {p.gapRanges.length>0?(
                      <>
                        <div style={{fontSize:11,fontWeight:700,color:T.danger,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:6}}>Missing periods ({p.gapPeriodCount})</div>
                        <div style={{fontSize:11,color:T.textMuted,marginBottom:6,fontFamily:"'DM Sans',sans-serif"}}>No {(PERIOD_TYPE_LABELS[p.periodType]||p.periodType).toLowerCase()} row for these periods, within this grain's own {fmtRange(p.start,p.end)} span.</div>
                        <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                          {p.gapRanges.map((r,i)=>(
                            <Pill key={i} color={T.danger} bg={T.dangerBg} border={T.dangerBorder} style={{fontSize:10.5}}>
                              {r.start===r.end?labelForPeriod(p.periodType,r.start):`${labelForPeriod(p.periodType,r.start)} – ${labelForPeriod(p.periodType,r.end)}`} ({r.periods})
                            </Pill>
                          ))}
                        </div>
                      </>
                    ):(
                      <div style={{fontSize:11,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}>No gaps within this grain's own span.</div>
                    )}
                  </div>
                )}
              </PixelPanel>
            );
          })}
        </div>
        </>)}
      </div>
    </div>
  );
}

// Deliberately tiny/local rather than pulling in a shared isMobile prop — this tab's grid tweak is
// the only place it matters, and every other tab thread this down from the top-level width
// listener; not worth widening this component's props just for one breakpoint check. Falls back to
// a real viewport check so it still behaves correctly stand-alone.
function isMobilePad(){return typeof window!=="undefined"&&window.innerWidth<640;}
