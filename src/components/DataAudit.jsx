import { useMemo, useState } from "react";
import { computeDataAudit, PLATFORM_COLORS, fmtFull } from "../lib/core.js";
import { Icon, PixelPanel, DashStatTile, Pill, SectionLabel } from "./shared.jsx";

// src/components/DataAudit.jsx — Data Audit tab (2026-07-31, per Mo).
//
// "I need a new tab where I can review in detail what data has been brought into BudgetHQ and from
// where. I need to know if there are any gaps in dates... where there is any overlap... where there
// are any conflicts from a data standpoint... whether manual or synced." Scoped to spend/dates only
// for now — channel-specific data beyond spend, PowerBI, and CRM data are explicitly future work.
//
// Deliberately reads the RAW mergedNormRows, not the excludedFromData-filtered visibleNormRows —
// same reasoning as Data Sources' own Import start/end columns (see BudgetHQ.jsx's
// importDateRangeByProvider): an audit tool that hides a paused/excluded connector's history isn't
// actually auditing the true stored state, it's auditing a curated subset of it.
//
// All the actual gap/overlap math lives in computeDataAudit (lib/core.js) — see that function's own
// doc comment for the important limitation this tab inherits: mergeRows() is last-write-wins, so a
// VALUE disagreement between two sources for a day that already got merged can't be reconstructed
// after the fact, only RANGE overlap (which sources claim overlapping date spans) can.

const MANUAL_SOURCE_LABELS={
  csv:"CSV upload",
  screenshot:"Screenshot import",
  "sheet-onetime":"Google Sheet (one-time pull)",
  manual:"Manual import (unlabeled — synced/imported before source tagging shipped)",
};
// Mirrors PLATFORMS' labels in BudgetHQ.jsx for the "sync:<provider>" case — duplicated rather than
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

export default // ─── DATA AUDIT ───────────────────────────────────────────────────────────────
function DataAudit({T,mergedNormRows,combineGoogleChannels=false}){
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

  if(!overview.totalRows){
    return(
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:40}}>
        <div style={{textAlign:"center",maxWidth:420}}>
          <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6,fontFamily:"'DM Sans',sans-serif"}}>No spend data yet</div>
          <div style={{fontSize:13,color:T.textMuted,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif"}}>Connect a data source or upload a CSV/screenshot in Data Sources, then come back here to see coverage, gaps, and overlaps across everything that's been brought in.</div>
        </div>
      </div>
    );
  }

  return(
    <div style={{flex:1,overflow:"auto",padding:isMobilePad()?"16px":"24px 28px"}}>
      <div style={{maxWidth:1040,margin:"0 auto"}}>
        <div style={{marginBottom:20}}>
          <h2 style={{fontSize:20,fontWeight:700,color:T.text,letterSpacing:"-0.3px",marginBottom:4,fontFamily:"'DM Sans',sans-serif"}}>Data Audit</h2>
          <p style={{fontSize:13,color:T.textSub,fontFamily:"'DM Sans',sans-serif",maxWidth:640}}>Every spend row currently stored in BudgetHQ — where it came from, what date range it covers, and where there are gaps or overlapping coverage. Covers spend and dates only for now.</p>
        </div>

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
            {overview.unparseableDates.toLocaleString()} row{overview.unparseableDates===1?"":"s"} {overview.unparseableDates===1?"has":"have"} a date BudgetHQ couldn't parse — excluded from every stat below (not from your actual data, just this audit's date math).
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
      </div>
    </div>
  );
}

// Deliberately tiny/local rather than pulling in a shared isMobile prop — this tab's grid tweak is
// the only place it matters, and every other tab thread this down from the top-level width
// listener; not worth widening this component's props just for one breakpoint check. Falls back to
// a real viewport check so it still behaves correctly stand-alone.
function isMobilePad(){return typeof window!=="undefined"&&window.innerWidth<640;}
