import { campaignKey, derivePlatform, parseSpendDate, getPeriodRange, computePacing } from "./core.js";

// src/lib/askAI.js — Ask AI's grounded tool-use engine (2026-07-25 split, per Mo). Every
// function here either answers one grounded tool call against real local data
// (askAIQuerySpend/Budget/Pacing, askAIListDimensionValues) or drives one of the two
// tool-use loops built on top of them: askAIRun (the Ask AI tab's chat) and askAIBuildView
// (Reporting & Pacing's "Ask AI to build a view" box). aiSummarizeBudgetPacing is the single-
// turn cousin of both — condenses whatever's already computed and on screen into one prose
// write-up instead of running its own tool loop.

export const ASK_AI_TOOLS=[
  {
    name:"list_tag_dimensions",
    description:"List the tag dimension names available for filtering/grouping (e.g. Product, Region, Funnel, Pillar, plus any custom ones the user has added), which of those are actually used as Budget By dimensions (only budget_dimensions can be filtered/grouped on in query_budget or query_pacing — the rest only apply to query_spend), and which budget years have any budget data at all. \"Platform\" is always also available as a synthetic dimension for query_spend even though it isn't a tag dimension.",
    input_schema:{type:"object",properties:{},required:[]},
  },
  {
    name:"list_dimension_values",
    description:"List the exact distinct values actually present for one dimension (a tag dimension, or \"Platform\"). ALWAYS call this before filtering on a dimension value from a user's question, since tag values are free text and spelling/capitalization must match exactly (e.g. the user might say \"emea\" but the real tag value is \"EMEA\").",
    input_schema:{type:"object",properties:{dimension:{type:"string",description:"A dimension name from list_tag_dimensions, or \"Platform\"."}},required:["dimension"]},
  },
  {
    name:"query_spend",
    description:"Get total ACTUAL spend/clicks/impressions for campaigns matching a set of dimension filters within a date range, optionally broken down by one more dimension, optionally restricted to only fully-tagged or only untagged campaigns. This has no concept of budget — use query_budget or query_pacing for anything about allocated/planned amounts. This is the only source of truth for spend numbers — never estimate or recall a figure without calling this.",
    input_schema:{type:"object",properties:{
      filters:{type:"object",description:"Map of dimension name -> exact value to filter to (use \"Platform\" as a key for platform filtering). Omit a dimension entirely to not filter on it.",additionalProperties:{type:"string"}},
      start_date:{type:"string",description:"YYYY-MM-DD, inclusive. Omit for no lower bound."},
      end_date:{type:"string",description:"YYYY-MM-DD, inclusive. Omit for no upper bound."},
      group_by:{type:"string",description:"Optional dimension name (or \"Platform\") to break the total down by."},
      tagged_status:{type:"string",enum:["any","tagged","untagged"],description:"\"tagged\" = only campaigns that have a value set for EVERY tag dimension (fully tagged, matching the Tagger's own definition). \"untagged\" = campaigns missing at least one. Defaults to \"any\" (no restriction). Use this for questions like \"how much spend is untagged\" or \"what's tagged vs. not\"."},
    },required:[]},
  },
  {
    name:"query_budget",
    description:"Get total ALLOCATED BUDGET (not actual spend) for segments matching dimension filters, for one year/period. Budgets only exist across the workspace's Budget By dimensions (budget_dimensions from list_tag_dimensions) — filtering on any other dimension returns zero. Use this for questions about what was PLANNED, not what was spent — use query_spend for actual spend, or query_pacing to compare the two.",
    input_schema:{type:"object",properties:{
      filters:{type:"object",description:"Map of Budget By dimension name -> exact value. Omit a dimension entirely to not filter on it.",additionalProperties:{type:"string"}},
      year:{type:"string",description:"e.g. \"2026\". Required."},
      period_type:{type:"string",enum:["monthly","quarterly","annual"],description:"Defaults to \"annual\" (the full year) if omitted."},
      month:{type:"string",description:"\"01\"-\"12\" — required if period_type is \"monthly\"."},
      quarter:{type:"string",description:"\"Q1\"-\"Q4\" — required if period_type is \"quarterly\"."},
      group_by:{type:"string",description:"Optional Budget By dimension name to break the total down by."},
    },required:["year"]},
  },
  {
    name:"query_pacing",
    description:"Get ALLOCATED BUDGET, ACTUAL SPEND, and pacing status TOGETHER for segments matching dimension filters, for one year/period — the combined view, mirroring exactly what the Reporting & Pacing tab itself computes (same status/variance logic), so use this whenever a question compares budget to spend, asks about being over/under/on pace, or asks \"how are we doing\" for a segment or the whole workspace.",
    input_schema:{type:"object",properties:{
      filters:{type:"object",description:"Map of Budget By dimension name -> exact value. Omit a dimension entirely to not filter on it.",additionalProperties:{type:"string"}},
      year:{type:"string",description:"e.g. \"2026\". Required."},
      period_type:{type:"string",enum:["monthly","quarterly","annual"],description:"Defaults to \"annual\" (the full year) if omitted."},
      month:{type:"string",description:"\"01\"-\"12\" — required if period_type is \"monthly\"."},
      quarter:{type:"string",description:"\"Q1\"-\"Q4\" — required if period_type is \"quarterly\"."},
      group_by:{type:"string",description:"Optional Budget By dimension name to break the total down by."},
    },required:["year"]},
  },
];

export function askAIListDimensionValues({mergedNormRows,tags,dimension}){
  const vals=new Set();
  const isPlatform=dimension.toLowerCase()==="platform";
  mergedNormRows.forEach(row=>{
    if(isPlatform){
      vals.add(derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type));
    }else{
      const key=campaignKey(row.campaign_group_name,row.campaign_name);
      const v=(tags[key]||{})[dimension];
      if(v)vals.add(v);
    }
  });
  return Array.from(vals).sort();
}

// "tagged" here means the SAME thing the Tagger's own "needs review" count means: every tag
// dimension in use has a value on that campaign, not just the dimensions a particular question
// happens to filter on. Kept as its own check (rather than reusing the filters loop) so
// tagged_status stays correct regardless of what else a query does or doesn't filter on.
export function isFullyTagged(rowTags,tagDims){
  return (tagDims||[]).every(d=>rowTags[d]);
}

export function askAIQuerySpend({mergedNormRows,tags,tagDims,filters,startDate,endDate,groupBy,taggedStatus}){
  const start=startDate?parseSpendDate(startDate):null;
  const end=endDate?parseSpendDate(endDate):null;
  const filterEntries=Object.entries(filters||{}).filter(([,v])=>v);
  const groupMap={};
  const seenCampaigns=new Set();
  let totalSpend=0,totalClicks=0,totalImpr=0;
  mergedNormRows.forEach(row=>{
    const d=parseSpendDate(row.date);
    if(start&&(!d||d<start))return;
    if(end&&(!d||d>end))return;
    const key=campaignKey(row.campaign_group_name,row.campaign_name);
    const rowTags=tags[key]||{};
    if(taggedStatus&&taggedStatus!=="any"){
      const tagged=isFullyTagged(rowTags,tagDims);
      if(taggedStatus==="tagged"&&!tagged)return;
      if(taggedStatus==="untagged"&&tagged)return;
    }
    const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
    const matches=filterEntries.every(([dim,val])=>{
      const actual=dim.toLowerCase()==="platform"?platform:(rowTags[dim]||"");
      return actual.toLowerCase()===String(val).toLowerCase();
    });
    if(!matches)return;
    totalSpend+=row.spend||0;totalClicks+=row.clicks||0;totalImpr+=row.impressions||0;
    seenCampaigns.add(key);
    if(groupBy){
      const gv=groupBy.toLowerCase()==="platform"?platform:(rowTags[groupBy]||"Untagged");
      groupMap[gv]=(groupMap[gv]||0)+(row.spend||0);
    }
  });
  const result={
    total_spend:Math.round(totalSpend*100)/100,
    total_clicks:totalClicks,
    total_impressions:totalImpr,
    campaign_count:seenCampaigns.size,
  };
  if(groupBy){
    result.breakdown=Object.entries(groupMap).sort((a,b)=>b[1]-a[1]).map(([value,spend])=>({value,spend:Math.round(spend*100)/100}));
  }
  return result;
}

// Budget-only query — deliberately does NOT join spend at all (see query_pacing below for the
// combined view), so this can answer "what did we allocate" even for a period/segment with zero
// actual spend synced yet. Reads budgets[year] directly rather than routing through
// computePacing(), which unions in spend-derived segKeys too — budget allocation shouldn't
// silently disappear from this view just because computePacing's segment set is spend-shaped.
export function askAIQueryBudget({budgets,budgetDims,filters,year,periodType,month,quarter,groupBy}){
  const yearBudgets=(budgets||{})[year]||{};
  const{months}=getPeriodRange(periodType||"annual",year,month,quarter);
  const filterEntries=Object.entries(filters||{}).filter(([,v])=>v);
  let total=0,segCount=0;
  const groupMap={};
  Object.entries(yearBudgets).forEach(([segKey,entry])=>{
    const vals=segKey.split("|");
    if(vals.length!==budgetDims.length)return; // stale/mismatched-dims segKey — not addressable by current filters
    const dimVals=Object.fromEntries(budgetDims.map((d,i)=>[d,vals[i]]));
    const matches=filterEntries.every(([dim,val])=>(dimVals[dim]||"").toLowerCase()===String(val).toLowerCase());
    if(!matches)return;
    const monthly=entry.monthly||{};
    const amt=months.reduce((s,mk)=>s+(monthly[mk]||0),0);
    if(amt<=0)return;
    total+=amt;segCount++;
    if(groupBy){
      const gv=dimVals[groupBy]||"Unknown";
      groupMap[gv]=(groupMap[gv]||0)+amt;
    }
  });
  const result={total_budget:Math.round(total*100)/100,segment_count:segCount};
  if(groupBy){
    result.breakdown=Object.entries(groupMap).sort((a,b)=>b[1]-a[1]).map(([value,budget])=>({value,budget:Math.round(budget*100)/100}));
  }
  return result;
}

// Combined budget+spend query — reuses computePacing() (the exact function the Reporting &
// Pacing tab itself renders from) rather than re-deriving status/variance logic separately, so
// Ask AI's "over budget"/"behind pace" answers can never drift from what that tab shows for the
// same period.
export function askAIQueryPacing({mergedNormRows,tags,budgetDims,budgets,budgetRowMeta,defaultForecastModel,filters,year,periodType,month,quarter,groupBy}){
  const pacing=computePacing({mergedNormRows,tags,budgetDims,budgets,year,periodType:periodType||"annual",month,quarter,today:new Date(),budgetRowMeta,defaultForecastModel});
  const filterEntries=Object.entries(filters||{}).filter(([,v])=>v);
  const matched=pacing.segments.filter(seg=>filterEntries.every(([dim,val])=>{
    const idx=budgetDims.indexOf(dim);
    if(idx===-1)return false; // not a Budget By dimension — nothing to match against here
    return (seg.dims[idx]||"").toLowerCase()===String(val).toLowerCase();
  }));
  const totalBudget=matched.reduce((s,x)=>s+x.budget,0);
  const totalSpend=matched.reduce((s,x)=>s+x.spend,0);
  const result={
    total_budget:Math.round(totalBudget*100)/100,
    total_spend:Math.round(totalSpend*100)/100,
    variance:Math.round((totalSpend-totalBudget)*100)/100,
    expected_pace_pct:Math.round(pacing.expectedPct*100),
    segment_count:matched.length,
    segments_over_budget:matched.filter(s=>s.status==="over").length,
    segments_behind_pace:matched.filter(s=>s.status==="behind").length,
    segments_no_spend_data_yet:matched.filter(s=>s.status==="no-data").length,
    // Committed (lump-sum/prepaid) segments are deliberately excluded from ahead/behind pace
    // math — surfaced separately so an answer like "how many segments are behind pace" doesn't
    // need to explain why committed lines never show up there.
    segments_committed:matched.filter(s=>s.status==="committed").length,
    // "constrained" = behind pace, has budget headroom, but impressions haven't grown over the
    // last couple weeks — a candidate signal that more budget won't fix it (see
    // detectCapacitySignal's doc comment). Distinct from segments_behind_pace above: every
    // capacity-constrained segment is also counted there, this is a narrower "and here's why" flag.
    segments_capacity_constrained:matched.filter(s=>s.capacitySignal==="constrained").length,
  };
  if(groupBy){
    const groupMap={};
    matched.forEach(seg=>{
      const idx=budgetDims.indexOf(groupBy);
      const gv=idx>=0?(seg.dims[idx]||"Unknown"):"Unknown";
      if(!groupMap[gv])groupMap[gv]={budget:0,spend:0};
      groupMap[gv].budget+=seg.budget;groupMap[gv].spend+=seg.spend;
    });
    result.breakdown=Object.entries(groupMap)
      .map(([value,v])=>({value,budget:Math.round(v.budget*100)/100,spend:Math.round(v.spend*100)/100,variance:Math.round((v.spend-v.budget)*100)/100}))
      .sort((a,b)=>b.spend-a.spend);
  }
  return result;
}

// Executes one tool_use block against the app's actual in-memory data — this is what keeps
// answers grounded, since the model never sees raw rows, only what these return.
export function askAIExecuteTool(toolName,input,ctx){
  if(toolName==="list_tag_dimensions"){
    return{
      dimensions:ctx.tagDims,
      budget_dimensions:ctx.budgetDims||[],
      budget_years_with_data:Object.keys(ctx.budgets||{}).sort(),
    };
  }
  if(toolName==="list_dimension_values")return{values:askAIListDimensionValues({mergedNormRows:ctx.mergedNormRows,tags:ctx.tags,dimension:input.dimension})};
  if(toolName==="query_spend")return askAIQuerySpend({mergedNormRows:ctx.mergedNormRows,tags:ctx.tags,tagDims:ctx.tagDims,filters:input.filters,startDate:input.start_date,endDate:input.end_date,groupBy:input.group_by,taggedStatus:input.tagged_status});
  if(toolName==="query_budget"){
    if(!(ctx.budgetDims||[]).length)return{error:"No Budget By dimensions are set up yet in the Budget Panel — there's no budget data to query."};
    return askAIQueryBudget({budgets:ctx.budgets,budgetDims:ctx.budgetDims,filters:input.filters,year:input.year,periodType:input.period_type,month:input.month,quarter:input.quarter,groupBy:input.group_by});
  }
  if(toolName==="query_pacing"){
    if(!(ctx.budgetDims||[]).length)return{error:"No Budget By dimensions are set up yet in the Budget Panel — there's no budget data to compare spend against."};
    return askAIQueryPacing({mergedNormRows:ctx.mergedNormRows,tags:ctx.tags,budgetDims:ctx.budgetDims,budgets:ctx.budgets,budgetRowMeta:ctx.budgetRowMeta,defaultForecastModel:ctx.defaultForecastModel,filters:input.filters,year:input.year,periodType:input.period_type,month:input.month,quarter:input.quarter,groupBy:input.group_by});
  }
  return{error:`Unknown tool: ${toolName}`};
}

// Runs the full tool-use loop against /api/analyze: send the conversation, execute any tool
// calls the model makes against real local data, send the results back, repeat until the model
// gives a final text answer. Capped at MAX_TOOL_ROUNDS as a runaway guard.
export const ASK_AI_MAX_ROUNDS=6;
export async function askAIRun({question,history,ctx}){
  const today=new Date().toISOString().slice(0,10);
  const hasBudgets=(ctx.budgetDims||[]).length>0;
  const system=`You are answering questions about the user's paid-media budget and spend data inside BudgetHQ. Today's date is ${today}. Tag dimensions in use: ${ctx.tagDims.join(", ")} (plus "Platform" is always available for query_spend). ${hasBudgets?`Budget By dimensions (the only ones valid for query_budget/query_pacing): ${ctx.budgetDims.join(", ")}.`:"No Budget By dimensions are set up yet, so budget/pacing questions have nothing to query — say so rather than guessing."} Dates for query_spend must be YYYY-MM-DD; year/period for query_budget and query_pacing use separate year/period_type/month/quarter fields, not date strings. Always use the tools to get real numbers — never state a figure you didn't get from a tool call. Pick the right tool for what's actually being asked: query_spend for actual spend only (including tagged vs. untagged via tagged_status), query_budget for allocated/planned amounts only, query_pacing when a question compares the two or asks about pace/over-under-budget. When a user names a value casually (e.g. "emea"), call list_dimension_values first to find the exact stored spelling before filtering. Answer conversationally and concisely, citing the actual numbers returned.`;
  const messages=[...history,{role:"user",content:question}];
  for(let round=0;round<ASK_AI_MAX_ROUNDS;round++){
    const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages,system,tools:ASK_AI_TOOLS,maxTokens:1200})});
    const data=await res.json();
    if(!res.ok)throw new Error(data?.error||"Ask AI request failed");
    if(data.stop_reason!=="tool_use"){
      return{answer:data.text||"(no response)",messages};
    }
    messages.push({role:"assistant",content:data.content});
    const toolResults=[];
    for(const block of data.content){
      if(block.type!=="tool_use")continue;
      let output;
      try{output=askAIExecuteTool(block.name,block.input||{},ctx);}
      catch(err){output={error:err.message};}
      toolResults.push({type:"tool_result",tool_use_id:block.id,content:JSON.stringify(output)});
    }
    messages.push({role:"user",content:toolResults});
  }
  throw new Error("Ask AI took too many steps without a final answer");
}

// Tool for the "✨ Ask AI to build a view" box on the Reporting & Pacing tab (item 42 — AI-driven
// views) — distinct from ASK_AI_TOOLS' query_* tools, which return numbers for a chat answer; this
// one returns a View-by CONFIGURATION for askAIBuildView to apply directly to the table. See that
// function's system prompt for the mode-specific filtering rules this schema's description text
// depends on (budget-mode filters restricted to Budget By dims, custom-mode filters requiring the
// filtered dim to also be in `dims`).
export const APPLY_VIEW_TOOL={
  name:"apply_view",
  description:"Configure the Reporting & Pacing tab's \"View by\" table to match the user's plain-English request. Call this exactly once, as your final action, with the fully resolved configuration — resolve any loosely-typed dimension values via list_dimension_values first so filters match the exact stored spelling/casing.",
  input_schema:{
    type:"object",
    properties:{
      mode:{type:"string",enum:["budget","custom","trend"],description:"\"budget\": group by the workspace's existing Budget By segments — the only mode with $ Budget/Pacing/Status columns, and filters/status_filter can ONLY use Budget By dimensions in this mode. \"custom\": group spend by any combination of dimensions (no budget column) — filters can only apply to a dimension that's also included in dims, since there's no way to filter without grouping by it too (include the dimension in dims even if the user didn't ask to see it broken out as a column). \"trend\": a month-over-month line per series value for at most ONE filter dimension, not a single-period table."},
      dims:{type:"array",items:{type:"string"},description:"mode=\"custom\" only: which dimension(s) (tag dimensions, or \"Platform\") to group rows by. Include every dimension you're also filtering on. Ignored for other modes."},
      filters:{type:"object",additionalProperties:{type:"string"},description:"Map of dimension name -> exact stored value. mode=\"budget\": keys must be Budget By dimensions. mode=\"custom\": keys must also appear in dims. mode=\"trend\": only the first entry is used, as the single filter dim/value."},
      status_filter:{type:"string",enum:["all","on-track","ahead","behind","over","committed","no-budget","no-data"],description:"mode=\"budget\" only: restrict to one pacing status. Defaults to \"all\"."},
      breakdown_dim:{type:"string",description:"mode=\"budget\" or \"custom\": an optional dimension to drill each row down by. Omit for none."},
      trend_series_dim:{type:"string",description:"mode=\"trend\" only: dimension that splits the trend into separate lines, e.g. \"Platform\". Omit for a single unsplit line."},
      trend_months:{type:"number",description:"mode=\"trend\" only: how many trailing months to show, ending this month. Defaults to 6."},
      name:{type:"string",description:"Short human-readable name for this view, e.g. \"Meta segments behind pace\" — used to pre-fill the \"Save this view\" prompt after the view is applied."},
    },
    required:["mode","name"],
  },
};

// Same tool-use-loop shape as askAIRun, but built to produce a structured View-by configuration
// instead of a text answer. Reuses list_tag_dimensions/list_dimension_values from ASK_AI_TOOLS so
// the model can resolve loosely-typed values before filtering, same as the chat version — the only
// way this loop ends successfully is the model calling apply_view; a plain text reply (the model
// asking a clarifying question, or explaining it can't do something) is surfaced as an error the
// caller shows inline rather than silently applying nothing.
export const ASK_AI_VIEW_MAX_ROUNDS=4;
export async function askAIBuildView({question,ctx}){
  const hasBudgets=(ctx.budgetDims||[]).length>0;
  const system=`You configure the Reporting & Pacing tab's "View by" table from a plain-English request. Tag dimensions: ${ctx.tagDims.join(", ")} (plus "Platform" is always available too). ${hasBudgets?`Budget By dimensions (the ONLY ones usable for mode="budget" grouping/filters/status): ${ctx.budgetDims.join(", ")}. If the user wants to filter or group by something outside that list, use mode="custom" instead (include the dimension in dims).`:"No Budget By dimensions are set up yet, so mode=\"budget\" has nothing to group by — use mode=\"custom\" for anything about spend by dimension."} When the user names a value casually (e.g. "meta" or "emea"), call list_dimension_values first to confirm the exact stored spelling before filtering — filters must match exactly, not a substring. Call apply_view exactly once, as your final action.`;
  const tools=[ASK_AI_TOOLS[0],ASK_AI_TOOLS[1],APPLY_VIEW_TOOL]; // list_tag_dimensions, list_dimension_values, apply_view
  const messages=[{role:"user",content:question}];
  for(let round=0;round<ASK_AI_VIEW_MAX_ROUNDS;round++){
    const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages,system,tools,maxTokens:800})});
    const data=await res.json();
    if(!res.ok)throw new Error(data?.error||"Ask AI request failed");
    const applyBlock=(data.content||[]).find(b=>b.type==="tool_use"&&b.name==="apply_view");
    if(applyBlock)return applyBlock.input;
    if(data.stop_reason!=="tool_use"){
      throw new Error(data.text||"Couldn't figure out a view for that — try rephrasing.");
    }
    messages.push({role:"assistant",content:data.content});
    const toolResults=[];
    for(const block of data.content){
      if(block.type!=="tool_use"||block.name==="apply_view")continue;
      let output;
      try{output=askAIExecuteTool(block.name,block.input||{},ctx);}
      catch(err){output={error:err.message};}
      toolResults.push({type:"tool_result",tool_use_id:block.id,content:JSON.stringify(output)});
    }
    messages.push({role:"user",content:toolResults});
  }
  throw new Error("Took too many steps to build that view — try a more specific request.");
}

// Translates apply_view's raw tool input into the canonical view-config shape PacingDashboard's
// applyViewConfig()/savedViews use (see PacingDashboard's currentViewConfig for the same shape
// built from live UI state) — with defensive validation, since this is model output: drops
// filters/dims/status/breakdown values that don't actually exist in this workspace rather than
// trusting them blindly, and auto-includes any custom-mode filter's dimension in dims (the only
// way custom mode can filter on it at all — see APPLY_VIEW_TOOL's description).
export function aiConfigToViewConfig(raw,{allDimOptions,budgetDims}){
  const allDims=allDimOptions||["Platform"];
  const mode=["budget","custom","trend"].includes(raw.mode)&&(raw.mode!=="budget"||(budgetDims||[]).length)?raw.mode:"custom";
  const rawFilters=raw.filters&&typeof raw.filters==="object"?raw.filters:{};
  if(mode==="trend"){
    const[fDim,fVal]=Object.entries(rawFilters).find(([d])=>allDims.includes(d))||[];
    const seriesDim=allDims.includes(raw.trend_series_dim)?raw.trend_series_dim:"Platform";
    return{
      viewMode:"trend",customDims:[],segFilters:{},statusFilter:"all",breakdownDim:"",
      trendFilterDim:fDim&&fDim!==seriesDim?fDim:"",
      trendFilterValue:fDim&&fDim!==seriesDim?(fVal||""):"",
      trendSeriesDim:seriesDim,
      trendMonthSpan:Math.min(24,Math.max(1,Math.round(raw.trend_months)||6)),
    };
  }
  if(mode==="budget"){
    const filters={};
    Object.entries(rawFilters).forEach(([d,v])=>{if((budgetDims||[]).includes(d))filters[d]=v;});
    const statuses=["all","on-track","ahead","behind","over","committed","no-budget","no-data"];
    return{
      viewMode:"budget",customDims:[],segFilters:filters,
      statusFilter:statuses.includes(raw.status_filter)?raw.status_filter:"all",
      breakdownDim:allDims.includes(raw.breakdown_dim)?raw.breakdown_dim:"",
      trendFilterDim:"",trendFilterValue:"",trendSeriesDim:"Platform",trendMonthSpan:6,
    };
  }
  // custom
  let dims=(raw.dims||[]).filter(d=>allDims.includes(d));
  const filters={};
  Object.entries(rawFilters).forEach(([d,v])=>{
    if(!allDims.includes(d))return;
    filters[d]=v;
    if(!dims.includes(d))dims.push(d); // filtering requires grouping by it too — see tool description
  });
  if(!dims.length)dims=["Platform"];
  return{
    viewMode:"custom",customDims:dims,segFilters:filters,statusFilter:"all",
    breakdownDim:allDims.includes(raw.breakdown_dim)&&!dims.includes(raw.breakdown_dim)?raw.breakdown_dim:"",
    trendFilterDim:"",trendFilterValue:"",trendSeriesDim:"Platform",trendMonthSpan:6,
  };
}

// Powers the "✨ AI Summary" card on the Budget Panel and Reporting & Pacing tabs. Deliberately NOT
// a tool-use loop like askAIRun — computePacing()/computeCustomGrouping()/computeMonthlyTrend()
// already compute the exact same numbers those tabs render on screen, so re-deriving them via tool
// calls would just risk the model getting its own arithmetic wrong. Instead this condenses whatever
// is ALREADY computed and on screen into a small JSON payload and asks Claude for a single-turn
// prose write-up of it — one request, no risk of the tool loop going sideways.
//
// For the Reporting & Pacing tab (mode==="pacing"), `view` carries the tab's live state — which
// View-by mode is selected (budget/custom/trend), the current period, and any status/segment
// filters — so the summary matches whatever's actually on screen instead of a fixed, always-the-
// same full-year snapshot. Previously this ignored the tab entirely and always recomputed one
// generic annual budget-dims summary regardless of what the user had selected, which is exactly
// the "same every time" complaint that prompted this change. The Budget Panel (mode==="budget")
// doesn't have this per-view concept — it's a fixed monthly/quarterly/annual grid, not a tab you
// reconfigure — so it keeps its original always-annual behavior via the `else` branch below.
export async function aiSummarizeBudgetPacing({mergedNormRows,tags,budgetDims,budgets,budgetRowMeta,defaultForecastModel,mode,view}){
  let payload,focus;
  if(mode==="pacing"&&view){
    const{viewMode,periodLabel,dims,segments,totals,expectedPct,daysRemaining,statusFilter,segFilters,trend,trendFilterDim,trendFilterValue,trendSeriesDim}=view;
    const activeFilters=[
      ...(statusFilter&&statusFilter!=="all"?[`status = ${statusFilter}`]:[]),
      ...Object.entries(segFilters||{}).filter(([,v])=>(v||"").trim()).map(([d,v])=>`${d} contains "${v.trim()}"`),
    ];
    if(viewMode==="trend"){
      const{months,series,monthTotals,grandTotal}=trend||{months:[],series:[],monthTotals:[],grandTotal:0};
      payload={
        viewType:"trend",
        dateRange:months.length?`${months[0].label} – ${months[months.length-1].label}`:"(no months in range)",
        filterDim:trendFilterDim||null,
        filterValue:trendFilterValue||null,
        seriesDim:trendSeriesDim||null,
        grandTotal:Math.round(grandTotal),
        topSeries:series.slice(0,5).map(s=>({label:s.label,total:Math.round(s.total)})),
        monthlyTotals:months.map((m,i)=>({month:m.label,total:Math.round(monthTotals[i]||0)})),
      };
      focus="This is the Reporting & Pacing tab's Trend view — monthly spend over a date range broken out by series (e.g. Platform or a tag dimension), NOT a single-period budget-vs-actual comparison, so there is no budget figure to compare against. Describe the overall trend across the months (growing, declining, or flat), call out which series dominates spend, and mention any notable month-over-month swings.";
    }else if(viewMode==="custom"){
      const topSpenders=[...segments].sort((a,b)=>b.spend-a.spend).slice(0,5)
        .map(s=>({segment:s.dims.join(" / "),spend:Math.round(s.spend),projected:s.projected==null?null:Math.round(s.projected)}));
      payload={
        viewType:"custom-grouping",
        periodLabel,
        groupedBy:dims,
        segmentCount:segments.length,
        totalSpend:Math.round(totals?.spend||0),
        expectedPacePct:Math.round((expectedPct||0)*100),
        daysRemaining,
        topSpenders,
        activeFilters,
      };
      focus=`This is the Reporting & Pacing tab's Custom view, grouped by ${dims.join(" + ")||"(no dimension selected)"} instead of the budget structure — there is no budget figure here, only spend. Focus on which ${dims.join("/")||"segment"} combinations are driving the most spend for ${periodLabel}, and how projected spend for the full period compares to spend-to-date.${activeFilters.length?` The user has filtered this view (${activeFilters.join("; ")}) — every figure above already reflects only that filtered subset, so base the summary on it and mention that it's filtered.`:""}`;
    }else{
      const withVariance=segments.map(s=>({...s,overBy:(s.spend||0)-(s.budget||0)}));
      const topOver=withVariance.filter(s=>s.status==="over").sort((a,b)=>b.overBy-a.overBy).slice(0,5)
        .map(s=>({segment:s.dims.join(" / "),budget:Math.round(s.budget),spend:Math.round(s.spend),overBy:Math.round(s.overBy)}));
      const topBehind=segments.filter(s=>s.status==="behind").sort((a,b)=>(a.actualPct??0)-(b.actualPct??0)).slice(0,5)
        .map(s=>({segment:s.dims.join(" / "),budget:Math.round(s.budget),spend:Math.round(s.spend),actualPct:s.actualPct==null?null:Math.round(s.actualPct*100)}));
      const noDataCount=segments.filter(s=>s.budget>0&&!s.hasData).length;
      const committedCount=segments.filter(s=>s.status==="committed").length;
      payload={
        viewType:"budget-pacing",
        periodLabel,
        totalBudget:Math.round(totals?.budget||0),
        totalSpend:Math.round(totals?.spend||0),
        expectedPacePct:Math.round((expectedPct||0)*100),
        daysRemaining,
        segmentCount:segments.length,
        segmentsOverBudget:topOver,
        segmentsBehindPace:topBehind,
        segmentsWithBudgetButNoSpendDataYet:noDataCount,
        segmentsCommitted:committedCount,
        activeFilters,
      };
      focus=`This is the Reporting & Pacing tab, scoped to ${periodLabel} — use exactly this period, not the full year. Focus on pacing performance: overall pace vs the expected pace for this point in ${periodLabel}, which segments are most over budget, which are furthest behind pace, and what's worth a closer look. segmentsCommitted are lump-sum/prepaid budget lines deliberately excluded from pace comparisons — mention them only if the count is non-zero, and don't call them "behind" or "ahead."${activeFilters.length?` The user has filtered this view (${activeFilters.join("; ")}) — every figure above already reflects only that filtered subset, so base the summary on it and mention that it's filtered.`:""}`;
    }
  }else{
    const year=String(new Date().getFullYear());
    const pacing=computePacing({mergedNormRows,tags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date(),budgetRowMeta,defaultForecastModel});
    const withVariance=pacing.segments.map(s=>({...s,overBy:s.spend-s.budget}));
    const topOver=[...withVariance].filter(s=>s.status==="over").sort((a,b)=>b.overBy-a.overBy).slice(0,5)
      .map(s=>({segment:s.dims.join(" / "),budget:Math.round(s.budget),spend:Math.round(s.spend),overBy:Math.round(s.overBy)}));
    const topBehind=[...pacing.segments].filter(s=>s.status==="behind").sort((a,b)=>(a.actualPct??0)-(b.actualPct??0)).slice(0,5)
      .map(s=>({segment:s.dims.join(" / "),budget:Math.round(s.budget),spend:Math.round(s.spend),actualPct:s.actualPct==null?null:Math.round(s.actualPct*100)}));
    const noDataCount=pacing.segments.filter(s=>s.budget>0&&!s.hasData).length;
    const committedCount=pacing.segments.filter(s=>s.status==="committed").length;
    payload={
      year,
      totalBudgetYTD:Math.round(pacing.totals.budget),
      totalSpendYTD:Math.round(pacing.totals.spend),
      expectedPacePct:Math.round(pacing.expectedPct*100),
      daysRemainingInYear:pacing.daysRemaining,
      segmentCount:pacing.segments.length,
      segmentsOverBudget:topOver,
      segmentsBehindPace:topBehind,
      segmentsWithBudgetButNoSpendDataYet:noDataCount,
      segmentsCommitted:committedCount,
    };
    focus="This is for the Budget Panel (where budgets are set up), so focus on budget SETUP and coverage: how many segments are budgeted, the total budgeted amount, and flag segmentsWithBudgetButNoSpendDataYet as a likely tagging gap worth checking (a segment has a budget but no matching spend rows yet).";
  }
  const system=`You are writing a short summary for a paid-media budget dashboard called BudgetHQ. Below is pre-computed JSON data — it is already correct, do not recompute or second-guess any numbers, just narrate them. Write 3-5 sentences of plain prose (no markdown headers, no bullet lists), citing the real figures. If a list is empty, don't dwell on it. ${focus}`;
  const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:JSON.stringify(payload)}],system,maxTokens:400})});
  const data=await res.json();
  if(!res.ok)throw new Error(data?.error||"Summary request failed");
  return data.text||"(no response)";
}

// Self-contained "✨ AI Summary" trigger + result card, shared by the Budget Panel and Reporting &
// Pacing tabs (see aiSummarizeBudgetPacing above). Owns its own idle/loading/done/error state so
// each tab gets an independent summary rather than sharing one across navigation.
