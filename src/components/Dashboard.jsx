import { useMemo, useState } from "react";
import {
  derivePlatform, parseSpendDate, computePacing, computePlatformFreshness,
  stepPeriodBack, pacingStatusMeta, fmtFull, fmtSigned, MONTHS,
} from "../lib/core.js";
import { Icon, Pill, StatRow, DashStatTile, SpendVsBudgetBar, PlatformSpendBars, DashQuickAction, PixelPanel, Breadcrumb } from "./shared.jsx";

// src/components/Dashboard.jsx — Dashboard tab (2026-07-25 split, per Mo).

export default // ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({T,onNavigate,stats,hasData,budgets,budgetDims,budgetRowMeta,defaultForecastModel,campaignTags,mergedNormRows,connectionDetails,exportTags,combineGoogleChannels=false}){
  const cardBg=T.surface;
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

  // A brand-new workspace (no spend data AND no budget entered anywhere) still gets the original
  // onboarding hero below. The instant either exists, the page's job changes from "how do I start"
  // to "what's the state of things" — see 2026-07-19 UX review for why those can't be the same
  // screen. hasBudgetData checks every year's budget object, not just the current year, so a
  // workspace someone only set up for next year still counts as populated.
  const hasBudgetData=useMemo(()=>Object.keys(budgets||{}).some(y=>Object.keys(budgets[y]||{}).length>0),[budgets]);
  const isPopulated=hasData||hasBudgetData;

  const now=new Date();
  const year=String(now.getFullYear());
  const month=String(now.getMonth()+1).padStart(2,"0");
  const monthLabel=MONTHS.find(m=>m.key===month)?.label||month;
  const quarter=`Q${Math.floor(now.getMonth()/3)+1}`;

  // Granularity for the "This month" snapshot — always the CURRENT month/quarter/year, never a
  // manually-picked past period (that's what the Pacing tab's full period picker is for). This is
  // just "zoom the lens," not a date navigator, so the Dashboard stays a fast glance. Persisted so
  // it sticks across visits, same pattern as showRollups/hideNotBudgeted.
  const[dashPeriodType,setDashPeriodType]=useState(()=>{
    try{return localStorage.getItem("paidhq_dashboard_period_type")||"monthly";}catch{return"monthly";}
  });
  const changeDashPeriodType=k=>{
    setDashPeriodType(k);
    try{localStorage.setItem("paidhq_dashboard_period_type",k);}catch{/* ignore */}
  };
  const periodSectionLabel=dashPeriodType==="monthly"?"This month":dashPeriodType==="quarterly"?"This quarter":"This year";
  const periodDateLabel=dashPeriodType==="monthly"?`${monthLabel} ${year}`:dashPeriodType==="quarterly"?`${quarter} ${year}`:`FY ${year}`;

  // Reuses the exact same pacing engine Reporting & Pacing runs, just re-scoped to whichever
  // granularity the switch above is set to. Safe to call even with no budget structure yet —
  // computePacing degrades to an empty segments array rather than throwing.
  const pacing=useMemo(()=>{
    if(!isPopulated)return null;
    return computePacing({mergedNormRows:mergedNormRows||[],tags:campaignTags||{},budgetDims:budgetDims||[],budgets:budgets||{},year,periodType:dashPeriodType,month,quarter,today:now,budgetRowMeta,defaultForecastModel,combineGoogleChannels});
  },[isPopulated,mergedNormRows,campaignTags,budgetDims,budgets,year,month,quarter,dashPeriodType,budgetRowMeta,defaultForecastModel]); // eslint-disable-line react-hooks/exhaustive-deps

  // pacing.daysRemaining is already computed for the projection math — surfacing it here too means
  // "62% spent, expected 58%" comes with the other half of the context (how much runway is left)
  // instead of making someone do that math themselves.
  const daysLeftLabel=pacing?.daysRemaining!=null?`${pacing.daysRemaining} day${pacing.daysRemaining===1?"":"s"} left`:null;

  // Period-over-period comparison — same granularity, one step back, always the fully-completed
  // prior period (computePacing already treats a period entirely in the past as 100% elapsed, so
  // this naturally gives a real final total rather than a partial one). Only rendered when the
  // prior period actually has spend to compare against — a 0-to-something jump reads as noise, not
  // signal, for a brand-new workspace's first month.
  const prevPeriod=useMemo(()=>stepPeriodBack({periodType:dashPeriodType,year,month,quarter}),[dashPeriodType,year,month,quarter]);
  const prevPacing=useMemo(()=>{
    if(!isPopulated)return null;
    return computePacing({mergedNormRows:mergedNormRows||[],tags:campaignTags||{},budgetDims:budgetDims||[],budgets:budgets||{},year:prevPeriod.year,periodType:dashPeriodType,month:prevPeriod.month,quarter:prevPeriod.quarter,today:now,budgetRowMeta,defaultForecastModel,combineGoogleChannels});
  },[isPopulated,mergedNormRows,campaignTags,budgetDims,budgets,prevPeriod,dashPeriodType,budgetRowMeta,defaultForecastModel]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevPeriodSpend=prevPacing?.totals?.spend||0;
  const spendDeltaPct=prevPeriodSpend>0&&hasData?Math.round(((pacing?.totals?.spend||0)-prevPeriodSpend)/prevPeriodSpend*100):null;
  const prevPeriodWord=dashPeriodType==="monthly"?"last month":dashPeriodType==="quarterly"?"last quarter":"last year";

  // Spend by platform, scoped to the same period the switch is set to — unlike the pacing tiles
  // above, this doesn't need budgetDims or a budget structure at all (derivePlatform works off raw
  // spend rows), so it's meaningful for any workspace that has synced spend, budget setup or not.
  const platformSpend=useMemo(()=>{
    if(!hasData||!pacing)return[];
    const map={};
    (mergedNormRows||[]).forEach(row=>{
      const d=parseSpendDate(row.date);
      if(!d||d<pacing.start||d>pacing.end)return;
      const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
      map[platform]=(map[platform]||0)+row.spend;
    });
    return Object.entries(map).map(([platform,spend])=>({platform,spend})).sort((a,b)=>b.spend-a.spend);
  },[hasData,pacing,mergedNormRows]);

  const freshness=useMemo(()=>hasData?computePlatformFreshness(mergedNormRows):{},[hasData,mergedNormRows]);

  // Only real problems — segments with actual spend data that are genuinely over or behind plan.
  // "no-data"/"no-budget" segments deliberately excluded here (see the pacingStatusMeta "no-data"
  // fix from the earlier UX pass) — an unsynced segment isn't "attention," it's just unmeasured.
  const attention=useMemo(()=>{
    if(!pacing)return[];
    return pacing.segments.filter(s=>s.status==="over"||s.status==="behind")
      .sort((a,b)=>Math.abs(b.projectedVariance||0)-Math.abs(a.projectedVariance||0))
      .slice(0,6);
  },[pacing]);

  // Segments with real spend but nobody's entered a budget for them yet — a genuinely actionable
  // gap, distinct from "behind pace," and only detectable once there's spend data to compare against.
  const noBudgetCount=useMemo(()=>pacing?pacing.segments.filter(s=>s.status==="no-budget"&&s.spend>0).length:0,[pacing]);

  // Data Source Health (2026-07-24, per Mo — modeled on Funnel.io's Home dashboard card). Reuses
  // the exact same connectionDetails already fetched for Settings' Connections table — no new
  // endpoint. A connector "needs attention" if its OAuth token needs reconnecting (LinkedIn's fixed
  // ~60-day window, or Bing's refresh actually failing), it's missing an ad account selection, or
  // its last automated rolling-sync run errored out.
  const dataSourceIssues=useMemo(()=>(connectionDetails||[]).filter(c=>c.needsReconnect||c.needsAccountSelection||c.lastAutoSyncStatus==="error"),[connectionDetails]);

  const safeTextColor=c=>c===T.accent?T.text:c;

  if(!isPopulated){
    return(
      <div style={{flex:1,overflow:"auto",background:T.bg}}>
        <div style={{maxWidth:960,margin:"0 auto",padding:"48px 32px"}}>
          {/* Hero — space-station illustration (2026-07-26, per Mo, from the licensed "Geometric
              Space Collection" set) sits opposite the welcome copy on this first-run screen only;
              it's a hub connecting modules, which is the same job this onboarding moment is doing
              (get every data source/budget file plugged into one command center). Hidden below
              ~860px so it never crowds the actual "start here" cards on a narrow window. */}
          <div style={{marginBottom:40,position:"relative",display:"flex",alignItems:"center",justifyContent:"space-between",gap:24}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:18,position:"relative"}}>
                <div style={{width:48,height:48,borderRadius:T.r10,background:T.accentBg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {/* 2026-08-01, per Mo — dropped the space-station illustration (see below for the
                      hero image removal too); back to the plain line-icon set the rest of the app
                      already uses everywhere else. */}
                  <Icon name="bolt" size={22} color={T.accent}/>
                </div>
                <div>
                  <h1 style={{fontSize:30*(T.fsScale||1),fontWeight:800,color:T.text,letterSpacing:"-0.6px",marginBottom:2,fontFamily:T.font}}>PaidHQ</h1>
                  <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.textSub,letterSpacing:"0.02em",fontFamily:T.font}}>Paid media budget intelligence · by PaidHQ</div>
                </div>
              </div>
              <p style={{fontSize:15*(T.fsScale||1),color:T.textSub,lineHeight:1.7,maxWidth:560,fontFamily:T.font,position:"relative"}}>
                Set budgets by custom segment, track pacing against actuals, and manage spend across every ad platform — without breaking a spreadsheet.
              </p>
              <div style={{marginTop:14,display:"inline-flex",alignItems:"center",gap:8,padding:"8px 16px",borderRadius:T.r8,background:T.accentBg,border:`1px solid ${T.accentBorder}`,position:"relative"}}>
                <span style={{fontSize:13*(T.fsScale||1),color:T.text,fontFamily:T.font}}>Start with spend data <strong>or</strong> a budget file — connect them later for pacing.</span>
              </div>
            </div>
          </div>

          {/* Cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:22}}>
            {cards.map(card=>(
              <PixelPanel key={card.key} T={T}
                variant={card.primary?"featured":undefined}
                onClick={card.disabled?undefined:()=>onNavigate(card.key)}
                style={{opacity:card.disabled?0.5:1}}
                contentStyle={{padding:"24px 26px",cursor:card.disabled?"default":"pointer",transition:"all 0.1s"}}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14}}>
                  <div style={{width:42,height:42,borderRadius:T.r10,background:T.surfaceEl,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={card.icon} size={19} color={card.disabled?T.textMuted:T.textSub}/></div>
                  {!card.disabled&&<span style={{fontSize:16*(T.fsScale||1),fontWeight:700,color:T.textMuted,lineHeight:1}}>→</span>}
                </div>
                <div style={{fontSize:T.fsCardTitle,fontWeight:T.fsCardTitleWeight,color:T.text,marginBottom:6,fontFamily:T.font}}>{card.title}</div>
                <div style={{fontSize:13*(T.fsScale||1),color:T.textSub,lineHeight:1.6,marginBottom:14,fontFamily:T.font}}>{card.desc}</div>
                <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:card.disabled?T.textMuted:T.text,fontFamily:T.font}}>{card.action}</div>
              </PixelPanel>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const totalBudget=pacing?.totals?.budget||0;
  const totalSpend=pacing?.totals?.spend||0;
  // hasData gate matters here too — without it, a budget-only workspace (real budget, zero synced
  // spend) computes 0/budget = 0% and displays a measured-looking "0%" instead of "—", the exact
  // false-signal bug the "no-data" pacing status fix addressed elsewhere on this page.
  const overallPct=hasData&&totalBudget>0?totalSpend/totalBudget:null;

  // Expected-pace context for the "Overall pacing" tile — a raw "42%" is meaningless without
  // knowing how far through the period we are. Same ±10pt ahead/behind/on-track thresholds
  // computePacing already uses per-segment, applied here to the aggregate so the language matches
  // what "Needs attention" is built from.
  const paceDelta=overallPct!=null&&pacing?.expectedPct!=null?overallPct-pacing.expectedPct:null;
  const expectedPctInt=pacing?.expectedPct!=null?Math.round(pacing.expectedPct*100):null;
  const paceSub=paceDelta==null?null:paceDelta>0.1?`Ahead of pace · expected ${expectedPctInt}%`:paceDelta<-0.1?`Behind pace · expected ${expectedPctInt}%`:`On pace · expected ${expectedPctInt}%`;
  const paceSubColor=paceDelta==null?undefined:paceDelta>0.1?T.warning:paceDelta<-0.1?T.textMuted:T.success;

  // Period-over-period sub-line for "Spend to date" — see prevPeriod/prevPacing above.
  const spendSub=spendDeltaPct==null?null:`${spendDeltaPct>0?"↑":spendDeltaPct<0?"↓":"→"} ${Math.abs(spendDeltaPct)}% vs ${prevPeriodWord}`;

  return(
    <div style={{flex:1,overflow:"auto",background:T.bg}}>
      <div style={{maxWidth:1040,margin:"0 auto",padding:"32px 32px 48px"}}>
        {/* 2026-08-01 (per Mo — "add the breadcrumb and big page-title header"): T.wideLayout
            branch matches the reference's own header composition (breadcrumb trail above a bare,
            large h1 — no icon, no subtitle line) instead of the original compact icon+title+
            subtitle row. Classic/Midnight (T.wideLayout undefined) keep that original compact
            header exactly as it was. */}
        {T.wideLayout?(
          <div style={{marginBottom:26}}>
            <Breadcrumb T={T} items={["Home",`${monthLabel} ${year}`,"Dashboard"]}/>
            <h1 style={{fontSize:36,fontWeight:600,color:T.text,letterSpacing:"-0.6px",fontFamily:T.font,margin:0}}>Dashboard</h1>
          </div>
        ):(
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:26}}>
            <div style={{width:36,height:36,borderRadius:T.r8,background:T.accentBg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <Icon name="bolt" size={17} color={T.accent}/>
            </div>
            <div>
              <div style={{fontSize:T.fsPageTitle,fontWeight:T.fsPageTitleWeight,color:T.text,letterSpacing:"-0.4px",fontFamily:T.font}}>Dashboard</div>
              <div style={{fontSize:11*(T.fsScale||1),fontWeight:600,color:T.textSub,fontFamily:T.font}}>{monthLabel} {year} · this workspace</div>
            </div>
          </div>
        )}

        {/* Workspace/campaign totals — folded in from what used to be a separate persistent
            sidebar column (Total spend/Campaigns/Tagged/Needs review). That column no longer
            renders at all for this view (see the <aside> gating in the main render) — a second
            mostly-empty vertical strip next to an already-full page just wasted width. These are
            all-time tallies across every campaign ever tagged, not scoped to "this month" like
            the pacing row below — labeled separately so the two scopes aren't confused. */}
        <div style={{marginBottom:8,fontSize:10*(T.fsScale||1),fontWeight:700,color:T.textMuted,letterSpacing:"0.06em",textTransform:"uppercase",fontFamily:T.font}}>All campaigns</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:22}}>
          <DashStatTile T={T} label="Total spend (all-time)" value={hasData?fmtFull(stats.totalSpend):"No data yet"}/>
          <DashStatTile T={T} label="Campaigns" value={hasData?stats.total.toLocaleString():"—"}/>
          <DashStatTile T={T} label="Tagged" value={hasData?`${stats.tagged.toLocaleString()} (${stats.total?Math.round((stats.tagged/stats.total)*100):0}%)`:"—"}/>
          <DashStatTile T={T} label="Needs review" value={hasData?stats.untagged.toLocaleString():"—"} valueColor={hasData&&stats.untagged>0?T.warning:undefined}/>
        </div>

        {/* This whole section used to be gated on budgetDims.length>0 alone, which hid the platform
            breakdown too — but that panel doesn't need a budget structure, only spend data. Every
            tile and panel in here already degrades gracefully on its own (—/0/"no budget set"/"no
            spend synced"), so the section just needs a reason to exist at all: either a budget
            structure or actual spend to look at. */}
        {(budgetDims.length>0||hasData)&&(<>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <div style={{fontSize:10*(T.fsScale||1),fontWeight:700,color:T.textMuted,letterSpacing:"0.06em",textTransform:"uppercase",fontFamily:T.font}}>
              {periodSectionLabel} <span style={{textTransform:"none",letterSpacing:0,fontWeight:500,color:T.textMuted}}>· {periodDateLabel}{daysLeftLabel?` · ${daysLeftLabel}`:""}</span>
            </div>
            <div style={{display:"flex",gap:2}}>
              {[["monthly","Mo"],["quarterly","Qtr"],["annual","Yr"]].map(([k,l])=>(
                <button key={k} onClick={()=>changeDashPeriodType(k)} title={`View ${l==="Mo"?"month":l==="Qtr"?"quarter":"year"}-to-date pacing`}
                  style={{padding:"3px 9px 5px",borderRadius:T.r0,border:"none",borderBottom:`2px solid ${dashPeriodType===k?T.accent:"transparent"}`,background:"transparent",color:dashPeriodType===k?T.text:T.textMuted,cursor:"pointer",fontSize:11*(T.fsScale||1),fontWeight:dashPeriodType===k?700:500,fontFamily:T.font,transition:"color 0.12s,border-color 0.12s"}}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:22}}>
            <DashStatTile T={T} label={`Total budget (${periodSectionLabel.toLowerCase()})`} value={totalBudget>0?fmtFull(totalBudget):"—"}/>
            <DashStatTile T={T} label="Spend to date" value={hasData?fmtFull(totalSpend):"—"} sub={spendSub}/>
            <DashStatTile T={T} label="Overall pacing" value={overallPct!=null?`${Math.round(overallPct*100)}%`:"—"} sub={paceSub} subColor={paceSubColor}/>
            <DashStatTile T={T} label="Needs attention" value={budgetDims.length===0?"—":String(attention.length)} valueColor={budgetDims.length===0?undefined:attention.length>0?T.danger:T.success}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:22,alignItems:"start"}}>
            <PixelPanel T={T} contentStyle={{padding:T.cardPad||"16px 18px"}}>
              <div style={{fontSize:T.fsCardTitle,fontWeight:T.fsCardTitleWeight,color:T.text,marginBottom:12,fontFamily:T.font}}>Spend vs. budget · {periodDateLabel}</div>
              <SpendVsBudgetBar T={T} spend={totalSpend} budget={totalBudget} fmtFull={fmtFull}/>
            </PixelPanel>
            <PixelPanel T={T} contentStyle={{padding:T.cardPad||"16px 18px"}}>
              <div style={{fontSize:T.fsCardTitle,fontWeight:T.fsCardTitleWeight,color:T.text,marginBottom:12,fontFamily:T.font}}>Spend by platform · {periodDateLabel}</div>
              <PlatformSpendBars T={T} rows={platformSpend} fmtFull={fmtFull}/>
            </PixelPanel>
          </div>
        </>)}

        <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr",gap:16,marginBottom:22,alignItems:"start"}}>
          {/* Needs attention */}
          <PixelPanel T={T} contentStyle={{padding:T.cardPad||"16px 18px"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <div style={{fontSize:T.fsCardTitle,fontWeight:T.fsCardTitleWeight,color:T.text,fontFamily:T.font}}>Needs attention</div>
              <span onClick={()=>onNavigate("pacing")} style={{fontSize:11*(T.fsScale||1),color:T.accent,cursor:"pointer",fontWeight:600,fontFamily:T.font}}>Open Reporting & Pacing →</span>
            </div>
            {budgetDims.length===0?(
              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,lineHeight:1.6,fontFamily:T.font}}>
                Set up a budget structure to see pacing here. <span onClick={()=>onNavigate("budget")} style={{color:T.accent,cursor:"pointer",fontWeight:600}}>Go to Budget Panel →</span>
              </div>
            ):!hasData?(
              <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,lineHeight:1.6,fontFamily:T.font}}>No spend data synced yet — pacing will show up here once spend is imported.</div>
            ):attention.length===0?(
              <div style={{fontSize:12*(T.fsScale||1),color:T.success,lineHeight:1.6,fontFamily:T.font}}>Nothing needs attention right now — every budgeted segment is on track or ahead.</div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:2}}>
                {attention.map(s=>{
                  const meta=pacingStatusMeta(s.status,T);
                  const label=budgetDims.map((d,i)=>s.dims[i]).join(" · ");
                  return(
                    <div key={s.segKey} onClick={()=>onNavigate("pacing")} className="bhq-row" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 6px",borderRadius:T.r6,cursor:"pointer",gap:10}}>
                      <span style={{fontSize:12*(T.fsScale||1),color:T.text,fontFamily:T.font,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{label}</span>
                      <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                        <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>{fmtSigned(s.projectedVariance)}</span>
                        <Pill color={safeTextColor(meta.color)} bg={meta.bg} border={meta.border}>{meta.label}</Pill>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </PixelPanel>

          {/* Data Source Health, Data freshness, Follow-ups, Quick Actions */}
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            {/* Modeled on Funnel.io's "Data Source Health" card — same connectionDetails already
                powering the Data Sources tab's connection-details table, just summarized here so a
                problem is visible before it silently breaks a sync. */}
            <PixelPanel T={T} contentStyle={{padding:T.cardPad||"16px 18px"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <div style={{fontSize:T.fsCardTitle,fontWeight:T.fsCardTitleWeight,color:T.text,fontFamily:T.font}}>Data source health</div>
                <span onClick={()=>onNavigate("data")} style={{fontSize:11*(T.fsScale||1),color:T.accent,cursor:"pointer",fontWeight:600,fontFamily:T.font}}>Go to Data Sources →</span>
              </div>
              {!connectionDetails||connectionDetails.length===0?(
                <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,lineHeight:1.6,fontFamily:T.font}}>No connectors set up yet.</div>
              ):dataSourceIssues.length===0?(
                <div style={{fontSize:12*(T.fsScale||1),color:T.success,lineHeight:1.6,fontFamily:T.font}}>All {connectionDetails.length} connected data source{connectionDetails.length===1?"":"s"} healthy.</div>
              ):(
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  {dataSourceIssues.map(c=>{
                    const reason=c.needsReconnect?"Needs reconnect":c.needsAccountSelection?"Needs account selection":"Last sync failed";
                    return(
                      <div key={c.provider} onClick={()=>onNavigate("data")} className="bhq-row" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 6px",borderRadius:T.r6,cursor:"pointer",gap:10}}>
                        <span style={{fontSize:12*(T.fsScale||1),color:T.text,fontFamily:T.font,fontWeight:500,textTransform:"capitalize"}}>{c.provider}</span>
                        <Pill color={T.warning} bg={T.warning+"14"} border={T.warning+"55"}>{reason}</Pill>
                      </div>
                    );
                  })}
                </div>
              )}
            </PixelPanel>

            <PixelPanel T={T} contentStyle={{padding:T.cardPad||"16px 18px"}}>
              <div style={{fontSize:T.fsCardTitle,fontWeight:T.fsCardTitleWeight,color:T.text,marginBottom:10,fontFamily:T.font}}>Data freshness</div>
              {Object.keys(freshness).length===0?(
                <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>No spend data synced yet.</div>
              ):(
                <div style={{display:"flex",flexDirection:"column"}}>
                  {Object.entries(freshness).map(([platform,date])=>(
                    <StatRow key={platform} T={T} label={platform} value={date instanceof Date?date.toISOString().slice(0,10):"—"}/>
                  ))}
                </div>
              )}
            </PixelPanel>

            <PixelPanel T={T} contentStyle={{padding:T.cardPad||"16px 18px"}}>
              {/* Renamed from "Quick actions" (2026-07-24) to make room for the new static Quick
                  Actions panel below without two panels sharing one name — this one is unchanged
                  otherwise, still the same contextual to-do nudges. */}
              <div style={{fontSize:T.fsCardTitle,fontWeight:T.fsCardTitleWeight,color:T.text,marginBottom:8,fontFamily:T.font}}>Follow-ups</div>
              <div style={{display:"flex",flexDirection:"column"}}>
                {stats.untagged>0&&(
                  <DashQuickAction T={T} label={`${stats.untagged} campaign${stats.untagged===1?"":"s"} need tagging`} onClick={()=>onNavigate("tagger")}/>
                )}
                {noBudgetCount>0&&(
                  <DashQuickAction T={T} label={`${noBudgetCount} segment${noBudgetCount===1?"":"s"} spending with no budget set`} onClick={()=>onNavigate("budget")}/>
                )}
                {stats.untagged===0&&noBudgetCount===0&&(
                  <div style={{fontSize:12*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>Nothing pending — you're all caught up.</div>
                )}
              </div>
            </PixelPanel>

            {/* New static Quick Actions panel (2026-07-24, per Mo — modeled on Funnel.io's Home
                dashboard). "Create dashboard" and "Quick start videos" deliberately left out — no
                multi-dashboard concept in PaidHQ yet, and videos are coming later per Mo. "Export
                your data" reuses the same exportTags() the Tagger sidebar's "Export tags CSV" button
                already calls, rather than a new "coming soon" stub. */}
            <PixelPanel T={T} contentStyle={{padding:T.cardPad||"16px 18px"}}>
              <div style={{fontSize:T.fsCardTitle,fontWeight:T.fsCardTitleWeight,color:T.text,marginBottom:8,fontFamily:T.font}}>Quick actions</div>
              <div style={{display:"flex",flexDirection:"column"}}>
                <DashQuickAction T={T} label="Connect data sources" onClick={()=>onNavigate("data")}/>
                <DashQuickAction T={T} label="Explore your data" onClick={()=>onNavigate("tagger")}/>
                <DashQuickAction T={T} label="Add a new user to your workspace" onClick={()=>onNavigate("settings")}/>
                {hasData?(
                  <DashQuickAction T={T} label="Export your data" onClick={exportTags}/>
                ):(
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 8px",opacity:0.5}}>
                    <span style={{fontSize:12*(T.fsScale||1),color:T.text,fontFamily:T.font}}>Export your data</span>
                    <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>No data yet</span>
                  </div>
                )}
              </div>
            </PixelPanel>
          </div>
        </div>

        {/* Condensed quick links — same destinations as the empty-state cards, secondary now that
            there's real content above */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
          {cards.map(card=>(
            <PixelPanel key={card.key} T={T}
              onClick={card.disabled?undefined:()=>onNavigate(card.key)}
              style={{opacity:card.disabled?0.5:1}}
              contentStyle={{padding:"12px 14px",background:cardBg,cursor:card.disabled?"default":"pointer",display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:28,height:28,borderRadius:T.r7,background:T.surfaceEl,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={card.icon} size={14} color={card.disabled?T.textMuted:T.textSub}/></div>
              <div style={{fontSize:12*(T.fsScale||1),fontWeight:600,color:T.text,fontFamily:T.font}}>{card.title}</div>
            </PixelPanel>
          ))}
        </div>

        {hasData&&stats.dateRange&&(
          <div style={{marginTop:20,padding:"10px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,display:"inline-flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>Data loaded:</span>
            <span style={{fontSize:11*(T.fsScale||1),color:T.text,fontFamily:T.font,fontWeight:500}}>{stats.dateRange}</span>
            <span style={{fontSize:11*(T.fsScale||1),color:T.textMuted,fontFamily:T.font}}>· {stats.totalRows.toLocaleString()} rows</span>
          </div>
        )}
      </div>
    </div>
  );
}
