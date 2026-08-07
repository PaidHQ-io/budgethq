import { useMemo, useState } from "react";
import { AreaChart, BarChart, BarList, DonutChart, LineChart } from "@tremor/react";
import {
  Lightning, Tag, Wallet, ChartLineUp, Export, ArrowUpRight, ArrowDownRight,
  CheckCircle, Plugs, CaretRight,
} from "@phosphor-icons/react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.jsx";
import { Badge } from "./ui/badge.jsx";
import { cn } from "../lib/utils.js";
import {
  derivePlatform, parseSpendDate, computePacing, computePlatformFreshness,
  stepPeriodBack, fmtFull, fmtSigned, MONTHS,
} from "../lib/core.js";

// src/components/Dashboard.jsx — Dashboard tab. Rebuilt 2026-08-07 off the legacy T-theme system
// onto Tailwind/shadcn/Tremor, matching Venture CRM's Dashboard V1 frame (Figma node 1366:73194 —
// Mo picked V1 over V2's CRM/email-contacts layout specifically because V1's task/revenue/expense
// framing maps far more directly onto a paid-media budget tool).
//
// This is a STRUCTURAL match, not a literal content port: Venture's "Task Progress" / "Total
// Expenses" / "Task Management Summaries" / "Total Revenue" / "Expenses Allocation" / "Highlighted
// Companies" / "Completed Task" cards are a task-management app's placeholder content, so each slot
// below carries BudgetHQ's own real metric playing the same visual role rather than a nonsensical
// literal translation:
//   Task Progress (donut + headline %)        → Overall pacing (spend/budget donut)
//   Total Expenses (headline $ + sparkline)    → Spend to date (headline $ + daily sparkline)
//   Average Finished Task (compact stat)       → Needs attention (compact stat, links to Pacing)
//   Task Management Summaries (stacked bars)   → Spend by platform, daily (stacked bars)
//   Highlighted Companies (compact list)       → Data source health (compact list)
//   Total Revenue (headline $ + line chart)    → Spend pacing (actual vs. straight-line target)
//   Expenses Allocation (horizontal bar list)  → Spend by platform, totals (horizontal bar list)
//   Completed Task (compact stat + View All)   → Tagged campaigns (compact stat, links to Tagger)
// All the underlying pacing/attention/data-health business logic is unchanged from the pre-rebuild
// version — only the render layer moved off T-theme inline styles. None of the original panels lost
// functionality: the full "Needs attention" list, data freshness, follow-ups and quick actions all
// still render below the Venture-style hero grid, just re-skinned in Tailwind/Card.

const ICONS={tagger:Tag,budget:Wallet,pacing:ChartLineUp,export:Export};

// Monochrome ramp for chart series — Venture's own Task Management Summaries / Total Revenue charts
// are grayscale (black/dark-gray/light-gray), not the colorful multi-hue palettes Tremor defaults
// to, so charts here deliberately use neutral/gray/stone/zinc/slate rather than blue/emerald/etc.
const CHART_COLORS=["neutral","gray","stone","zinc","slate"];

function attentionBadgeVariant(status){
  if(status==="over")return"destructive";
  if(status==="behind")return"warning";
  return"secondary";
}

function TrendDelta({pct}){
  if(pct==null)return null;
  const up=pct>0;
  const flat=pct===0;
  const Icon=flat?null:up?ArrowUpRight:ArrowDownRight;
  return(
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium",
      flat?"text-muted-foreground":up?"text-success":"text-destructive")}>
      {Icon&&<Icon className="h-3 w-3" weight="bold"/>}
      {Math.abs(pct)}%
    </span>
  );
}

export default function Dashboard({onNavigate,stats,hasData,budgets,budgetDims,budgetRowMeta,defaultForecastModel,campaignTags,mergedNormRows,connectionDetails,exportTags,combineGoogleChannels=false}){
  const cards=[
    {key:"tagger",title:"Start with spend data",
      desc:"Upload a spend CSV from Google Ads, LinkedIn, Meta, Bing or Capterra. Tag campaigns into custom segments like Product, Region, and Funnel.",
      action:"Import spend data",primary:true},
    {key:"budget",title:"Start with a budget file",
      desc:"Upload your budget spreadsheet (Excel or CSV). AI maps your columns automatically. Set monthly budgets by segment — no spend data needed.",
      action:"Import budget file",primary:true},
    {key:"pacing",title:"Reporting & Pacing",
      desc:"Track burn rate, PTD spend vs budget, forecast to end of period, and break down spend by region, platform, funnel, or any other dimension.",
      action:"Open reporting"},
    {key:"export",title:"Export",
      desc:"Export clean data — no formulas — to plug into your own Google Sheets or Excel trackers.",
      action:"Coming soon",disabled:true},
  ];

  // A brand-new workspace (no spend data AND no budget entered anywhere) still gets the onboarding
  // hero below. The instant either exists, the page's job changes from "how do I start" to "what's
  // the state of things" — see 2026-07-19 UX review for why those can't be the same screen.
  const hasBudgetData=useMemo(()=>Object.keys(budgets||{}).some(y=>Object.keys(budgets[y]||{}).length>0),[budgets]);
  const isPopulated=hasData||hasBudgetData;

  const now=new Date();
  const year=String(now.getFullYear());
  const month=String(now.getMonth()+1).padStart(2,"0");
  const monthLabel=MONTHS.find(m=>m.key===month)?.label||month;
  const quarter=`Q${Math.floor(now.getMonth()/3)+1}`;

  // Granularity for the "This month" snapshot — always the CURRENT month/quarter/year, never a
  // manually-picked past period (that's what the Pacing tab's full period picker is for).
  const[dashPeriodType,setDashPeriodType]=useState(()=>{
    try{return localStorage.getItem("paidhq_dashboard_period_type")||"monthly";}catch{return"monthly";}
  });
  const changeDashPeriodType=k=>{
    setDashPeriodType(k);
    try{localStorage.setItem("paidhq_dashboard_period_type",k);}catch{/* ignore */}
  };
  const periodSectionLabel=dashPeriodType==="monthly"?"This month":dashPeriodType==="quarterly"?"This quarter":"This year";
  const periodDateLabel=dashPeriodType==="monthly"?`${monthLabel} ${year}`:dashPeriodType==="quarterly"?`${quarter} ${year}`:`FY ${year}`;

  const pacing=useMemo(()=>{
    if(!isPopulated)return null;
    return computePacing({mergedNormRows:mergedNormRows||[],tags:campaignTags||{},budgetDims:budgetDims||[],budgets:budgets||{},year,periodType:dashPeriodType,month,quarter,today:now,budgetRowMeta,defaultForecastModel,combineGoogleChannels});
  },[isPopulated,mergedNormRows,campaignTags,budgetDims,budgets,year,month,quarter,dashPeriodType,budgetRowMeta,defaultForecastModel]); // eslint-disable-line react-hooks/exhaustive-deps

  const daysLeftLabel=pacing?.daysRemaining!=null?`${pacing.daysRemaining} day${pacing.daysRemaining===1?"":"s"} left`:null;

  const prevPeriod=useMemo(()=>stepPeriodBack({periodType:dashPeriodType,year,month,quarter}),[dashPeriodType,year,month,quarter]);
  const prevPacing=useMemo(()=>{
    if(!isPopulated)return null;
    return computePacing({mergedNormRows:mergedNormRows||[],tags:campaignTags||{},budgetDims:budgetDims||[],budgets:budgets||{},year:prevPeriod.year,periodType:dashPeriodType,month:prevPeriod.month,quarter:prevPeriod.quarter,today:now,budgetRowMeta,defaultForecastModel,combineGoogleChannels});
  },[isPopulated,mergedNormRows,campaignTags,budgetDims,budgets,prevPeriod,dashPeriodType,budgetRowMeta,defaultForecastModel]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevPeriodSpend=prevPacing?.totals?.spend||0;
  const spendDeltaPct=prevPeriodSpend>0&&hasData?Math.round(((pacing?.totals?.spend||0)-prevPeriodSpend)/prevPeriodSpend*100):null;
  const prevPeriodWord=dashPeriodType==="monthly"?"last month":dashPeriodType==="quarterly"?"last quarter":"last year";

  // Spend by platform, scoped to the period — used for both the "Expenses Allocation" horizontal
  // bar list (totals) and to pick the top platforms for the daily stacked bar chart below.
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

  // Daily-bucketed spend within the period, split by the top 5 platforms — powers the "Task
  // Management Summaries" stacked-bar analog (spend by platform, per day) and the "Total Revenue"
  // analog (a simple straight-line-target vs. actual cumulative spend pacing chart). "target" is a
  // simplified even-daily-spread of the period budget, distinct from computePacing's real day-
  // weighted forecast model — good enough for an at-a-glance chart, not meant to replace the Pacing
  // tab's precise math.
  const periodSeries=useMemo(()=>{
    if(!hasData||!pacing)return{daily:[],platforms:[],cumulative:[]};
    const dayMap={};
    const platformTotals={};
    (mergedNormRows||[]).forEach(row=>{
      const d=parseSpendDate(row.date);
      if(!d||d<pacing.start||d>pacing.end)return;
      const dateKey=d.toISOString().slice(0,10);
      const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
      if(!dayMap[dateKey])dayMap[dateKey]={date:dateKey};
      dayMap[dateKey][platform]=(dayMap[dateKey][platform]||0)+row.spend;
      platformTotals[platform]=(platformTotals[platform]||0)+row.spend;
    });
    const topPlatforms=Object.entries(platformTotals).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([p])=>p);
    const days=Object.keys(dayMap).sort();
    const daily=days.map(dateKey=>{
      const row=dayMap[dateKey];
      const out={date:dateKey.slice(5)};
      let dayTotal=0;
      topPlatforms.forEach(p=>{const v=Math.round(row[p]||0);out[p]=v;dayTotal+=v;});
      out.__total=dayTotal;
      return out;
    });
    const budget=pacing.totals?.budget||0;
    let running=0;
    const cumulative=daily.map((row,i)=>{
      running+=row.__total;
      return{date:row.date,Actual:Math.round(running),Target:budget>0?Math.round(budget*(i+1)/daily.length):null};
    });
    return{daily,platforms:topPlatforms,cumulative};
  },[hasData,pacing,mergedNormRows]);

  const freshness=useMemo(()=>hasData?computePlatformFreshness(mergedNormRows):{},[hasData,mergedNormRows]);

  // Only real problems — segments with actual spend data that are genuinely over or behind plan.
  const attention=useMemo(()=>{
    if(!pacing)return[];
    return pacing.segments.filter(s=>s.status==="over"||s.status==="behind")
      .sort((a,b)=>Math.abs(b.projectedVariance||0)-Math.abs(a.projectedVariance||0))
      .slice(0,6);
  },[pacing]);

  const noBudgetCount=useMemo(()=>pacing?pacing.segments.filter(s=>s.status==="no-budget"&&s.spend>0).length:0,[pacing]);

  const dataSourceIssues=useMemo(()=>(connectionDetails||[]).filter(c=>c.needsReconnect||c.needsAccountSelection||c.lastAutoSyncStatus==="error"),[connectionDetails]);

  if(!isPopulated){
    return(
      <div className="flex-1 overflow-auto bg-background">
        <div className="mx-auto max-w-[960px] px-8 py-12">
          <div className="mb-10 flex items-center gap-3.5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-sm bg-secondary">
              <Lightning className="h-5 w-5 text-foreground" weight="bold"/>
            </div>
            <div>
              <h1 className="text-h3 font-medium text-foreground">PaidHQ</h1>
              <div className="text-xs font-semibold text-muted-foreground">Paid media budget intelligence · by PaidHQ</div>
            </div>
          </div>
          <p className="mb-4 max-w-[560px] text-sm leading-relaxed text-muted-foreground">
            Set budgets by custom segment, track pacing against actuals, and manage spend across every ad platform — without breaking a spreadsheet.
          </p>
          <div className="mb-10 inline-flex items-center gap-2 rounded-sm border border-border bg-secondary px-4 py-2">
            <span className="text-sm text-foreground">Start with spend data <strong>or</strong> a budget file — connect them later for pacing.</span>
          </div>

          <div className="grid grid-cols-2 gap-5">
            {cards.map(card=>{
              const CardIcon=ICONS[card.key];
              return(
                <Card key={card.key}
                  onClick={card.disabled?undefined:()=>onNavigate(card.key)}
                  className={cn("transition-colors",card.disabled?"opacity-50":"cursor-pointer hover:bg-secondary/40")}>
                  <CardContent className="p-6">
                    <div className="mb-3.5 flex items-start justify-between">
                      <div className="flex h-[42px] w-[42px] items-center justify-center rounded-sm bg-secondary">
                        <CardIcon className="h-5 w-5 text-muted-foreground" weight="regular"/>
                      </div>
                      {!card.disabled&&<CaretRight className="h-4 w-4 text-muted-foreground"/>}
                    </div>
                    <div className="mb-1.5 text-sm font-semibold text-foreground">{card.title}</div>
                    <div className="mb-3.5 text-xs leading-relaxed text-muted-foreground">{card.desc}</div>
                    <div className={cn("text-xs font-semibold",card.disabled?"text-muted-foreground":"text-foreground")}>{card.action}</div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  const totalBudget=pacing?.totals?.budget||0;
  const totalSpend=pacing?.totals?.spend||0;
  const overallPct=hasData&&totalBudget>0?totalSpend/totalBudget:null;

  const paceDelta=overallPct!=null&&pacing?.expectedPct!=null?overallPct-pacing.expectedPct:null;
  const expectedPctInt=pacing?.expectedPct!=null?Math.round(pacing.expectedPct*100):null;
  const paceSub=paceDelta==null?null:paceDelta>0.1?`Ahead of pace · expected ${expectedPctInt}%`:paceDelta<-0.1?`Behind pace · expected ${expectedPctInt}%`:`On pace · expected ${expectedPctInt}%`;
  const paceSubClass=paceDelta==null?"text-muted-foreground":paceDelta>0.1?"text-warning":paceDelta<-0.1?"text-muted-foreground":"text-success";

  const donutData=totalBudget>0?[
    {name:"Spent",value:Math.round(totalSpend)},
    {name:"Remaining",value:Math.max(Math.round(totalBudget-totalSpend),0)},
  ]:[];

  const barListData=platformSpend.map(p=>({name:p.platform,value:Math.round(p.spend)}));

  const taggedPct=stats.total?Math.round((stats.tagged/stats.total)*100):0;

  return(
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto max-w-[1200px] px-8 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-h3 font-medium text-foreground">Dashboard</h1>
            <div className="text-xs font-medium text-muted-foreground">{periodSectionLabel} · {monthLabel} {year} · this workspace</div>
          </div>
          <div className="flex items-center gap-1 rounded-sm border border-border p-1">
            {[["monthly","Month"],["quarterly","Quarter"],["annual","Year"]].map(([k,l])=>(
              <button key={k} type="button" onClick={()=>changeDashPeriodType(k)}
                className={cn("rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                  dashPeriodType===k?"bg-secondary text-foreground":"text-muted-foreground hover:bg-secondary/60")}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Venture V1 hero grid: 2/3 main column (pacing donut + spend sparkline, big daily
            stacked-bar chart, pacing line chart + platform bar list) alongside a 1/3 right rail of
            three compact stat cards (needs attention / data source health / tagged campaigns) —
            matching the source frame's exact column split and card cadence. */}
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2 flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <Card>
                <CardContent className="flex items-center gap-4 p-5">
                  <div className="h-[88px] w-[88px] shrink-0">
                    {donutData.length>0?(
                      <DonutChart data={donutData} category="value" index="name" colors={["neutral","gray"]}
                        className="h-[88px] w-[88px]" showAnimation={false} showLabel={false} showTooltip={false}/>
                    ):(
                      <div className="flex h-[88px] w-[88px] items-center justify-center rounded-full border-4 border-secondary">
                        <span className="text-xs text-muted-foreground">—</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">Overall pacing</div>
                    <div className="text-h4 font-medium text-foreground">{overallPct!=null?`${Math.round(overallPct*100)}%`:"—"}</div>
                    {paceSub&&<div className={cn("text-xs font-medium",paceSubClass)}>{paceSub}</div>}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Spend to date · {periodDateLabel}</span>
                    <TrendDelta pct={spendDeltaPct}/>
                  </div>
                  <div className="text-h4 font-medium text-foreground">{hasData?fmtFull(totalSpend):"—"}</div>
                  {spendDeltaPct!=null&&<div className="mb-2 text-xs text-muted-foreground">vs {prevPeriodWord}</div>}
                  {periodSeries.daily.length>0?(
                    <AreaChart data={periodSeries.daily} index="date" categories={["__total"]}
                      colors={["neutral"]} className="mt-2 h-14" showXAxis={false} showYAxis={false}
                      showGridLines={false} showLegend={false} showTooltip={false} showAnimation={false} curveType="monotone"/>
                  ):(
                    <div className="mt-2 h-14"/>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle>Spend by platform · daily</CardTitle>
                <span className="text-xs text-muted-foreground">{periodDateLabel}{daysLeftLabel?` · ${daysLeftLabel}`:""}</span>
              </CardHeader>
              <CardContent>
                {periodSeries.daily.length>0?(
                  <BarChart data={periodSeries.daily} index="date" categories={periodSeries.platforms}
                    colors={CHART_COLORS} type="stacked" className="h-56" showAnimation={false}
                    valueFormatter={fmtFull} yAxisWidth={56}/>
                ):(
                  <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">No spend data synced for this period yet.</div>
                )}
              </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2"><CardTitle>Spend pacing · actual vs. target</CardTitle></CardHeader>
                <CardContent>
                  {periodSeries.cumulative.length>0&&totalBudget>0?(
                    <LineChart data={periodSeries.cumulative} index="date" categories={["Actual","Target"]}
                      colors={["neutral","gray"]} className="h-48" showAnimation={false}
                      valueFormatter={fmtFull} yAxisWidth={56}/>
                  ):(
                    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                      {totalBudget>0?"No spend data synced yet.":"Set a budget to see pacing here."}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2"><CardTitle>Spend by platform · total</CardTitle></CardHeader>
                <CardContent>
                  {barListData.length>0?(
                    <BarList data={barListData} valueFormatter={fmtFull} className="mt-1"/>
                  ):(
                    <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">No spend data synced yet.</div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Right rail — three compact stat cards, matching Venture's Average Finished Task /
              Highlighted Companies / Completed Task column exactly in cadence and height. */}
          <div className="flex flex-col gap-4">
            <Card>
              <CardContent className="p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Needs attention</span>
                  <button type="button" onClick={()=>onNavigate("pacing")} className="text-xs font-medium text-foreground hover:underline">Open Pacing →</button>
                </div>
                <div className="text-h4 font-medium text-foreground">{budgetDims.length===0?"—":attention.length}</div>
                <div className="text-xs text-muted-foreground">{budgetDims.length===0?"No budget structure set up":attention.length>0?"segments over or behind plan":"everything on track"}</div>
              </CardContent>
            </Card>

            <Card className="flex-1">
              <CardContent className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Data source health</span>
                  <button type="button" onClick={()=>onNavigate("data")} className="text-xs font-medium text-foreground hover:underline">Manage →</button>
                </div>
                {!connectionDetails||connectionDetails.length===0?(
                  <div className="text-xs text-muted-foreground">No connectors set up yet.</div>
                ):dataSourceIssues.length===0?(
                  <div className="flex items-center gap-2 text-xs text-success">
                    <CheckCircle className="h-4 w-4" weight="fill"/>
                    All {connectionDetails.length} connected source{connectionDetails.length===1?"":"s"} healthy
                  </div>
                ):(
                  <div className="flex flex-col gap-2">
                    {dataSourceIssues.map(c=>{
                      const reason=c.needsReconnect?"Needs reconnect":c.needsAccountSelection?"Needs account selection":"Last sync failed";
                      return(
                        <div key={c.provider} onClick={()=>onNavigate("data")} className="flex cursor-pointer items-center justify-between rounded-sm px-1.5 py-1 hover:bg-secondary/60">
                          <span className="flex items-center gap-1.5 text-xs font-medium capitalize text-foreground">
                            <Plugs className="h-3.5 w-3.5 text-muted-foreground"/>{c.provider}
                          </span>
                          <Badge variant="warning">{reason}</Badge>
                        </div>
                      );
                    })}
                  </div>
                )}
                {Object.keys(freshness).length>0&&(
                  <div className="mt-4 flex flex-col gap-1.5 border-t border-border pt-3">
                    {Object.entries(freshness).map(([platform,date])=>(
                      <div key={platform} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{platform}</span>
                        <span className="font-medium text-foreground">{date instanceof Date?date.toISOString().slice(0,10):"—"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Tagged campaigns</span>
                  <button type="button" onClick={()=>onNavigate("tagger")} className="text-xs font-medium text-foreground hover:underline">View all →</button>
                </div>
                <div className="text-h4 font-medium text-foreground">{hasData?`${stats.tagged.toLocaleString()}`:"—"}</div>
                <div className="text-xs text-muted-foreground">{hasData?`${taggedPct}% of ${stats.total.toLocaleString()} campaigns`:"No data yet"}</div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Full attention list + follow-ups + quick actions — everything the compact right-rail
            stat cards summarize above, in full detail. Nothing from the pre-rebuild page was cut. */}
        <div className="mt-4 grid grid-cols-[1.4fr_1fr] gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle>Needs attention · detail</CardTitle>
            </CardHeader>
            <CardContent>
              {budgetDims.length===0?(
                <div className="text-xs text-muted-foreground">
                  Set up a budget structure to see pacing here. <button type="button" onClick={()=>onNavigate("budget")} className="font-semibold text-foreground hover:underline">Go to Budget Panel →</button>
                </div>
              ):!hasData?(
                <div className="text-xs text-muted-foreground">No spend data synced yet — pacing will show up here once spend is imported.</div>
              ):attention.length===0?(
                <div className="flex items-center gap-2 text-xs text-success">
                  <CheckCircle className="h-4 w-4" weight="fill"/>
                  Nothing needs attention right now — every budgeted segment is on track or ahead.
                </div>
              ):(
                <div className="flex flex-col gap-1">
                  {attention.map(s=>{
                    const label=budgetDims.map((d,i)=>s.dims[i]).join(" · ");
                    return(
                      <div key={s.segKey} onClick={()=>onNavigate("pacing")} className="flex cursor-pointer items-center justify-between gap-3 rounded-sm px-1.5 py-1.5 hover:bg-secondary/60">
                        <span className="truncate text-xs font-medium text-foreground">{label}</span>
                        <div className="flex shrink-0 items-center gap-2.5">
                          <span className="text-xs text-muted-foreground">{fmtSigned(s.projectedVariance)}</span>
                          <Badge variant={attentionBadgeVariant(s.status)}>{s.status==="over"?"Over budget":"Behind pace"}</Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card>
              <CardContent className="p-5">
                <div className="mb-2 text-xs font-medium text-muted-foreground">Follow-ups</div>
                <div className="flex flex-col gap-1.5">
                  {stats.untagged>0&&(
                    <button type="button" onClick={()=>onNavigate("tagger")} className="flex items-center justify-between rounded-sm px-1.5 py-1 text-left text-xs font-medium text-foreground hover:bg-secondary/60">
                      {stats.untagged} campaign{stats.untagged===1?"":"s"} need tagging <CaretRight className="h-3.5 w-3.5 text-muted-foreground"/>
                    </button>
                  )}
                  {noBudgetCount>0&&(
                    <button type="button" onClick={()=>onNavigate("budget")} className="flex items-center justify-between rounded-sm px-1.5 py-1 text-left text-xs font-medium text-foreground hover:bg-secondary/60">
                      {noBudgetCount} segment{noBudgetCount===1?"":"s"} spending with no budget set <CaretRight className="h-3.5 w-3.5 text-muted-foreground"/>
                    </button>
                  )}
                  {stats.untagged===0&&noBudgetCount===0&&(
                    <div className="px-1.5 py-1 text-xs text-muted-foreground">Nothing pending — you're all caught up.</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="mb-2 text-xs font-medium text-muted-foreground">Quick actions</div>
                <div className="flex flex-col gap-1.5">
                  <button type="button" onClick={()=>onNavigate("data")} className="flex items-center justify-between rounded-sm px-1.5 py-1 text-left text-xs font-medium text-foreground hover:bg-secondary/60">
                    Connect data sources <CaretRight className="h-3.5 w-3.5 text-muted-foreground"/>
                  </button>
                  <button type="button" onClick={()=>onNavigate("tagger")} className="flex items-center justify-between rounded-sm px-1.5 py-1 text-left text-xs font-medium text-foreground hover:bg-secondary/60">
                    Explore your data <CaretRight className="h-3.5 w-3.5 text-muted-foreground"/>
                  </button>
                  <button type="button" onClick={()=>onNavigate("settings")} className="flex items-center justify-between rounded-sm px-1.5 py-1 text-left text-xs font-medium text-foreground hover:bg-secondary/60">
                    Add a new user to your workspace <CaretRight className="h-3.5 w-3.5 text-muted-foreground"/>
                  </button>
                  {hasData?(
                    <button type="button" onClick={exportTags} className="flex items-center justify-between rounded-sm px-1.5 py-1 text-left text-xs font-medium text-foreground hover:bg-secondary/60">
                      Export your data <CaretRight className="h-3.5 w-3.5 text-muted-foreground"/>
                    </button>
                  ):(
                    <div className="flex items-center justify-between px-1.5 py-1 opacity-50">
                      <span className="text-xs text-foreground">Export your data</span>
                      <span className="text-xs text-muted-foreground">No data yet</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Condensed quick links to every module — same destinations as the empty-state cards. */}
        <div className="mt-4 grid grid-cols-4 gap-3">
          {cards.map(card=>{
            const CardIcon=ICONS[card.key];
            return(
              <Card key={card.key}
                onClick={card.disabled?undefined:()=>onNavigate(card.key)}
                className={cn("transition-colors",card.disabled?"opacity-50":"cursor-pointer hover:bg-secondary/40")}>
                <CardContent className="flex items-center gap-2.5 p-3.5">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-secondary">
                    <CardIcon className="h-3.5 w-3.5 text-muted-foreground"/>
                  </div>
                  <div className="text-xs font-semibold text-foreground">{card.title}</div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {hasData&&stats.dateRange&&(
          <div className="mt-5 inline-flex items-center gap-2 rounded-sm border border-border px-3.5 py-2.5">
            <span className="text-xs text-muted-foreground">Data loaded:</span>
            <span className="text-xs font-medium text-foreground">{stats.dateRange}</span>
            <span className="text-xs text-muted-foreground">· {stats.totalRows.toLocaleString()} rows</span>
          </div>
        )}
      </div>
    </div>
  );
}
