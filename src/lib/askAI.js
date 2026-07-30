import { campaignKey, derivePlatform, parseSpendDate, getPeriodRange, computePacing, NUMERIC_FIELDS, NUMERIC_OPERATORS, matchesNumericFilters } from "./core.js";

// How many individual segments a having-filtered or small unfiltered result includes in
// matching_segments (see askAIQueryPacing) before falling back to just the count — keeps a
// "list everything over $X" question answerable in one tool call without risking an unbounded
// response for a workspace with hundreds of segments.
const ASK_AI_MAX_LISTED_SEGMENTS=50;

// Model picker options (2026-07-28, per Mo). Values must match api/analyze.js's ALLOWED_MODELS
// allow-list exactly — that file validates server-side and silently falls back to the default if
// a value here ever drifts out of sync with it, so a stale/renamed model just quietly downgrades
// to Sonnet rather than erroring, but keep them matched by hand regardless.
export const ASK_AI_MODELS=[
  {value:"claude-sonnet-5",label:"Sonnet",hint:"Balanced default — fast and capable for almost every question."},
  {value:"claude-opus-5",label:"Opus",hint:"Most capable — worth it for a gnarly multi-step analysis question, slower and more expensive per message."},
  {value:"claude-haiku-4-5-20251001",label:"Haiku",hint:"Fastest and cheapest — good for a quick lookup, less reliable on anything requiring several tool calls chained together."},
];
export const ASK_AI_DEFAULT_MODEL="claude-sonnet-5";

// Shared validation for a raw `having`/`numeric_filters` array coming from the model — drops any
// entry with an unrecognized field, operator, or non-finite value rather than trusting it blindly
// (same defensive posture as aiConfigToViewConfig's dim/filter validation below), and restricts to
// whichever fields make sense for the calling tool (allowedFields).
function sanitizeNumericFilters(raw,allowedFields){
  if(!Array.isArray(raw))return[];
  return raw.filter(f=>f&&allowedFields.includes(f.field)&&NUMERIC_OPERATORS.includes(f.operator)&&typeof f.value==="number"&&Number.isFinite(f.value));
}

// Builds the `having` property definition for a query_* tool's input_schema — same {field,
// operator,value} shape everywhere, but the two families of caller filter at different grains:
// query_spend/query_budget have no natural per-row unit besides a group_by bucket, so `having`
// there filters GROUPS after aggregation (SQL HAVING — requires group_by). query_pacing already
// has a natural per-row unit (a budget segment), so its `having` filters SEGMENTS directly (SQL
// WHERE on an already-computed column) — group_by is optional there, applied AFTER having narrows
// the segment set.
function havingSchema(fields,{requiresGroupBy}={requiresGroupBy:true}){
  const pctNote=fields.includes("actualPct")?` actualPct is a FRACTION where 1.0 = 100% pacing — e.g. use value:1.0 for "over 100% pacing", value:0.5 for "under 50%".`:"";
  const scopeNote=requiresGroupBy
    ?`Optional post-aggregation numeric threshold filter(s) on the group_by breakdown — REQUIRES group_by to be set, since this filters which breakdown GROUPS appear (like SQL's HAVING), not individual rows.`
    :`Optional numeric threshold filter(s) applied directly to each matching SEGMENT (group_by is independent and optional — if set, it aggregates whichever segments already passed having).`;
  return{
    type:"array",
    description:`${scopeNote} Each entry: {field, operator, value}. field must be one of: ${fields.join(", ")}. operator is one of ${NUMERIC_OPERATORS.join(", ")}. Multiple entries are ANDed together. Use this for "X over $Y" / "X below Z%" style questions — e.g. to answer "which campaigns spent more than $10,000", call query_spend with group_by="Campaign" and having=[{"field":"spend","operator":">","value":10000}].${pctNote}`,
    items:{type:"object",properties:{field:{type:"string"},operator:{type:"string",enum:NUMERIC_OPERATORS},value:{type:"number"}},required:["field","operator","value"]},
  };
}

// Resolves one dimension's value for a spend row inside Ask AI's tool layer — the same three
// derived pseudo-dimensions core.js's resolveDimValue knows about (Platform, Campaign, Ad Group;
// see DERIVED_DIMS), but matched by dimension NAME case-insensitively, since the model doesn't
// always echo back the exact casing it saw from list_tag_dimensions/list_dimension_values. Callers
// pick their own "no value" fallback: filter-matching wants "" (an empty actual value can never
// equal a real filter value, so the filter cleanly fails), a groupBy bucket wants "Untagged" (same
// convention askAIQuerySpend's group_by already used for real tags before this existed).
function askAIDimValue(row,rowTags,dim,fallback=""){
  const d=(dim||"").toLowerCase();
  if(d==="platform")return derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
  if(d==="campaign")return row.campaign_group_name||fallback;
  if(d==="ad group"||d==="adgroup"||d==="ad set"||d==="adset")return row.campaign_name||fallback;
  return rowTags[dim]||fallback;
}

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
    description:"List the tag dimension names available for filtering/grouping (e.g. Product, Region, Funnel, Pillar, plus any custom ones the user has added), which of those are actually used as Budget By dimensions (only budget_dimensions can be filtered/grouped on in query_budget or query_pacing — the rest only apply to query_spend), and which budget years have any budget data at all. \"Platform\", \"Campaign\", and \"Ad Group\" are always also available as synthetic dimensions for query_spend even though none of the three is a tag — Platform is derived from the platform/traffic-source data, Campaign is the campaign/campaign-group name, and Ad Group is the ad set/ad group name.",
    input_schema:{type:"object",properties:{},required:[]},
  },
  {
    name:"list_dimension_values",
    description:"List the exact distinct values actually present for one dimension (a tag dimension, or \"Platform\"/\"Campaign\"/\"Ad Group\"). ALWAYS call this before filtering on a dimension value from a user's question, since tag values are free text and spelling/capitalization must match exactly (e.g. the user might say \"emea\" but the real tag value is \"EMEA\").",
    input_schema:{type:"object",properties:{dimension:{type:"string",description:"A dimension name from list_tag_dimensions, or \"Platform\"/\"Campaign\"/\"Ad Group\"."}},required:["dimension"]},
  },
  {
    name:"query_spend",
    description:"Get total ACTUAL spend/clicks/impressions for campaigns matching a set of dimension filters within a date range, optionally broken down by one more dimension, optionally restricted to only fully-tagged or only untagged campaigns. This has no concept of budget — use query_budget or query_pacing for anything about allocated/planned amounts. This is the only source of truth for spend numbers — never estimate or recall a figure without calling this.",
    input_schema:{type:"object",properties:{
      filters:{type:"object",description:"Map of dimension name -> exact value to filter to (use \"Platform\", \"Campaign\", or \"Ad Group\" as a key to filter on those). Omit a dimension entirely to not filter on it.",additionalProperties:{type:"string"}},
      start_date:{type:"string",description:"YYYY-MM-DD, inclusive. Omit for no lower bound."},
      end_date:{type:"string",description:"YYYY-MM-DD, inclusive. Omit for no upper bound."},
      group_by:{type:"string",description:"Optional dimension name (or \"Platform\", \"Campaign\", \"Ad Group\") to break the total down by."},
      tagged_status:{type:"string",enum:["any","tagged","untagged"],description:"\"tagged\" = only campaigns that have a value set for EVERY tag dimension (fully tagged, matching the Tagger's own definition). \"untagged\" = campaigns missing at least one. Defaults to \"any\" (no restriction). Use this for questions like \"how much spend is untagged\" or \"what's tagged vs. not\"."},
      having:havingSchema(["spend"]),
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
      having:havingSchema(["budget"]),
    },required:["year"]},
  },
  {
    name:"query_pacing",
    description:"Get ALLOCATED BUDGET, ACTUAL SPEND, PACING %, DAILY BURN RATE, and PROJECTED full-period spend TOGETHER for segments matching dimension filters, for one year/period — the combined view, mirroring exactly what the Reporting & Pacing tab itself computes (same status/variance/projection logic), so use this whenever a question compares budget to spend, asks about being over/under/on pace, asks about daily burn or projected spend, or asks \"how are we doing\" for a segment or the whole workspace. When `having` narrows the result (or the match is small — 25 segments or fewer — even without having), the response includes a `matching_segments` list with each individual segment's budget/spend/actual_pct/daily_burn/projected/variance/status, not just aggregate totals — use this to answer \"which segments...\" / \"list...\" style questions without a second tool call.",
    input_schema:{type:"object",properties:{
      filters:{type:"object",description:"Map of Budget By dimension name -> exact value. Omit a dimension entirely to not filter on it.",additionalProperties:{type:"string"}},
      year:{type:"string",description:"e.g. \"2026\". Required."},
      period_type:{type:"string",enum:["monthly","quarterly","annual"],description:"Defaults to \"annual\" (the full year) if omitted."},
      month:{type:"string",description:"\"01\"-\"12\" — required if period_type is \"monthly\"."},
      quarter:{type:"string",description:"\"Q1\"-\"Q4\" — required if period_type is \"quarterly\"."},
      group_by:{type:"string",description:"Optional Budget By dimension name to break the total down by."},
      having:havingSchema(["budget","spend","actualPct","dailyRate","projected","projectedVariance"],{requiresGroupBy:false}),
    },required:["year"]},
  },
];

export function askAIListDimensionValues({mergedNormRows,tags,dimension}){
  const vals=new Set();
  mergedNormRows.forEach(row=>{
    const key=campaignKey(row.campaign_group_name,row.campaign_name);
    const rowTags=tags[key]||{};
    const v=askAIDimValue(row,rowTags,dimension);
    if(v)vals.add(v);
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

export function askAIQuerySpend({mergedNormRows,tags,tagDims,filters,startDate,endDate,groupBy,taggedStatus,having}){
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
    const matches=filterEntries.every(([dim,val])=>askAIDimValue(row,rowTags,dim).toLowerCase()===String(val).toLowerCase());
    if(!matches)return;
    totalSpend+=row.spend||0;totalClicks+=row.clicks||0;totalImpr+=row.impressions||0;
    seenCampaigns.add(key);
    if(groupBy){
      const gv=askAIDimValue(row,rowTags,groupBy,"Untagged");
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
    const havingFilters=sanitizeNumericFilters(having,["spend"]);
    result.breakdown=Object.entries(groupMap)
      .filter(([,spend])=>matchesNumericFilters({spend},havingFilters))
      .sort((a,b)=>b[1]-a[1]).map(([value,spend])=>({value,spend:Math.round(spend*100)/100}));
  }
  return result;
}

// Budget-only query — deliberately does NOT join spend at all (see query_pacing below for the
// combined view), so this can answer "what did we allocate" even for a period/segment with zero
// actual spend synced yet. Reads budgets[year] directly rather than routing through
// computePacing(), which unions in spend-derived segKeys too — budget allocation shouldn't
// silently disappear from this view just because computePacing's segment set is spend-shaped.
export function askAIQueryBudget({budgets,budgetDims,filters,year,periodType,month,quarter,groupBy,having}){
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
    const havingFilters=sanitizeNumericFilters(having,["budget"]);
    result.breakdown=Object.entries(groupMap)
      .filter(([,budget])=>matchesNumericFilters({budget},havingFilters))
      .sort((a,b)=>b[1]-a[1]).map(([value,budget])=>({value,budget:Math.round(budget*100)/100}));
  }
  return result;
}

// Combined budget+spend query — reuses computePacing() (the exact function the Reporting &
// Pacing tab itself renders from) rather than re-deriving status/variance logic separately, so
// Ask AI's "over budget"/"behind pace" answers can never drift from what that tab shows for the
// same period.
export function askAIQueryPacing({mergedNormRows,tags,budgetDims,budgets,budgetRowMeta,defaultForecastModel,filters,year,periodType,month,quarter,groupBy,having,combineGoogleChannels=false}){
  const pacing=computePacing({mergedNormRows,tags,budgetDims,budgets,year,periodType:periodType||"annual",month,quarter,today:new Date(),budgetRowMeta,defaultForecastModel,combineGoogleChannels});
  const filterEntries=Object.entries(filters||{}).filter(([,v])=>v);
  let matched=pacing.segments.filter(seg=>filterEntries.every(([dim,val])=>{
    const idx=budgetDims.indexOf(dim);
    if(idx===-1)return false; // not a Budget By dimension — nothing to match against here
    return (seg.dims[idx]||"").toLowerCase()===String(val).toLowerCase();
  }));
  // having filters SEGMENTS directly (unlike query_spend/query_budget's group-level having — see
  // havingSchema's doc comment) — applied here, before group_by, so a grouped breakdown below only
  // ever aggregates segments that already passed the threshold.
  const havingFilters=sanitizeNumericFilters(having,["budget","spend","actualPct","dailyRate","projected","projectedVariance"]);
  if(havingFilters.length)matched=matched.filter(seg=>matchesNumericFilters(seg,havingFilters));
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
      if(!groupMap[gv])groupMap[gv]={budget:0,spend:0,dailyRate:0,projected:0,capacityConstrained:0};
      const g=groupMap[gv];
      g.budget+=seg.budget;g.spend+=seg.spend;g.dailyRate+=seg.dailyRate||0;g.projected+=seg.projected||0;
      if(seg.capacitySignal==="constrained")g.capacityConstrained++;
    });
    result.breakdown=Object.entries(groupMap)
      .map(([value,v])=>({
        value,
        budget:Math.round(v.budget*100)/100,
        spend:Math.round(v.spend*100)/100,
        variance:Math.round((v.spend-v.budget)*100)/100,
        actual_pct:v.budget>0?Math.round((v.spend/v.budget)*1000)/10:null,
        daily_burn:Math.round(v.dailyRate*100)/100,
        projected:Math.round(v.projected*100)/100,
        segments_capacity_constrained:v.capacityConstrained,
      }))
      .sort((a,b)=>b.spend-a.spend);
  }
  // Individual segment detail — always included when having narrowed the result (the whole point
  // of a threshold query is usually "list them," not just "how many"), and also for a small
  // unfiltered result (cheap enough to include, and often what's actually wanted for "how's X
  // doing" questions about a handful of segments) — see ASK_AI_MAX_LISTED_SEGMENTS.
  if(havingFilters.length||matched.length<=ASK_AI_MAX_LISTED_SEGMENTS){
    const listed=matched.slice(0,ASK_AI_MAX_LISTED_SEGMENTS);
    result.matching_segments=listed.map(seg=>({
      segment:seg.dims.join(" / "),
      budget:Math.round(seg.budget*100)/100,
      spend:Math.round(seg.spend*100)/100,
      actual_pct:seg.actualPct==null?null:Math.round(seg.actualPct*1000)/10,
      daily_burn:seg.dailyRate==null?null:Math.round(seg.dailyRate*100)/100,
      projected:seg.projected==null?null:Math.round(seg.projected*100)/100,
      variance:seg.projectedVariance==null?null:Math.round(seg.projectedVariance*100)/100,
      status:seg.status,
      capacity_signal:seg.capacitySignal||null,
    }));
    if(matched.length>ASK_AI_MAX_LISTED_SEGMENTS)result.matching_segments_truncated=matched.length-ASK_AI_MAX_LISTED_SEGMENTS;
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
  if(toolName==="query_spend")return askAIQuerySpend({mergedNormRows:ctx.mergedNormRows,tags:ctx.tags,tagDims:ctx.tagDims,filters:input.filters,startDate:input.start_date,endDate:input.end_date,groupBy:input.group_by,taggedStatus:input.tagged_status,having:input.having});
  if(toolName==="query_budget"){
    if(!(ctx.budgetDims||[]).length)return{error:"No Budget By dimensions are set up yet in the Budget Panel — there's no budget data to query."};
    return askAIQueryBudget({budgets:ctx.budgets,budgetDims:ctx.budgetDims,filters:input.filters,year:input.year,periodType:input.period_type,month:input.month,quarter:input.quarter,groupBy:input.group_by,having:input.having});
  }
  if(toolName==="query_pacing"){
    if(!(ctx.budgetDims||[]).length)return{error:"No Budget By dimensions are set up yet in the Budget Panel — there's no budget data to compare spend against."};
    return askAIQueryPacing({mergedNormRows:ctx.mergedNormRows,tags:ctx.tags,budgetDims:ctx.budgetDims,budgets:ctx.budgets,budgetRowMeta:ctx.budgetRowMeta,defaultForecastModel:ctx.defaultForecastModel,filters:input.filters,year:input.year,periodType:input.period_type,month:input.month,quarter:input.quarter,groupBy:input.group_by,having:input.having,combineGoogleChannels:ctx.combineGoogleChannels});
  }
  return{error:`Unknown tool: ${toolName}`};
}

// Streams one /api/analyze call and reconstructs it into the exact same {content, stop_reason,
// usage} shape the non-streaming JSON response returns — so askAIRun's round loop below doesn't
// need two code paths, only one (streaming) that happens to also report progress as it goes.
// Parses Anthropic's raw SSE event stream directly (api/analyze.js is a byte-for-byte pass-through
// when stream:true — see its doc comment) rather than depending on any SDK: buffers incoming
// chunks, splits on blank-line-delimited SSE records, and handles the event types Anthropic's
// Messages API actually emits — message_start (initial input token count), content_block_start/
// delta/stop (text streams in piece by piece via text_delta; tool_use input streams in as
// fragments of a JSON string via input_json_delta, only valid to JSON.parse once the block
// closes), message_delta (final stop_reason + output token count), message_stop, and error (a
// mid-stream failure, e.g. an overload — surfaced by throwing rather than silently truncating the
// answer). onTextDelta, if given, is called with the CURRENT ROUND's full accumulated text after
// every text delta — the caller (AskAI.jsx) shows this live instead of a static "Thinking…".
async function streamAnalyze({messages,system,tools,maxTokens,model,signal,onTextDelta,token}){
  const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({messages,system,tools,maxTokens,model,stream:true}),signal});
  if(!res.ok){
    const data=await res.json().catch(()=>({}));
    throw new Error(data?.error||"Ask AI request failed");
  }
  const reader=res.body.getReader();
  const decoder=new TextDecoder();
  let buf="";
  const blocks=[]; // sparse array indexed by Anthropic's content_block index
  let stopReason=null;
  const usage={input_tokens:0,output_tokens:0};
  let liveText="";
  const handleEvent=raw=>{
    let dataStr="";
    for(const line of raw.split("\n")){
      if(line.startsWith("data:"))dataStr+=line.slice(5).trim();
    }
    if(!dataStr)return;
    let evt;
    try{evt=JSON.parse(dataStr);}catch{return;} // malformed/partial record — skip rather than abort the whole stream
    if(evt.type==="message_start"){
      usage.input_tokens=evt.message?.usage?.input_tokens||0;
    }else if(evt.type==="content_block_start"){
      const cb=evt.content_block||{};
      blocks[evt.index]=cb.type==="tool_use"
        ?{type:"tool_use",id:cb.id,name:cb.name,input:{},_partialJson:""}
        :{type:"text",text:""};
    }else if(evt.type==="content_block_delta"){
      const block=blocks[evt.index];
      if(!block)return;
      if(evt.delta?.type==="text_delta"){
        block.text+=evt.delta.text;
        liveText+=evt.delta.text;
        onTextDelta?.(liveText);
      }else if(evt.delta?.type==="input_json_delta"){
        block._partialJson=(block._partialJson||"")+(evt.delta.partial_json||"");
      }
    }else if(evt.type==="content_block_stop"){
      const block=blocks[evt.index];
      if(block?.type==="tool_use"){
        try{block.input=block._partialJson?JSON.parse(block._partialJson):{};}
        catch{block.input={};}
        delete block._partialJson;
      }
    }else if(evt.type==="message_delta"){
      if(evt.delta?.stop_reason)stopReason=evt.delta.stop_reason;
      if(evt.usage?.output_tokens!=null)usage.output_tokens=evt.usage.output_tokens;
    }else if(evt.type==="error"){
      throw new Error(evt.error?.message||"Ask AI streaming error");
    }
  };
  while(true){
    const{done,value}=await reader.read();
    if(done)break;
    buf+=decoder.decode(value,{stream:true});
    let idx;
    while((idx=buf.indexOf("\n\n"))!==-1){
      const raw=buf.slice(0,idx);
      buf=buf.slice(idx+2);
      handleEvent(raw);
    }
  }
  return{content:blocks.filter(Boolean),stop_reason:stopReason,usage};
}

// Runs the full tool-use loop against /api/analyze: send the conversation, execute any tool
// calls the model makes against real local data, send the results back, repeat until the model
// gives a final text answer. Capped at MAX_TOOL_ROUNDS as a runaway guard.
export const ASK_AI_MAX_ROUNDS=6;
// question can be a plain string OR an Anthropic content-blocks array (used when images/files are
// attached — see AskAI.jsx's send(), which builds the block array itself so this function stays a
// dumb pass-through rather than knowing about File/canvas/CSV-parsing details). model/signal are
// both optional passthroughs (2026-07-28, per Mo): model picks which Claude model answers this
// chat (see ASK_AI_MODELS; api/analyze.js validates/defaults it server-side regardless of what's
// sent), signal is an AbortController's signal so the caller's Stop button can cancel an in-flight
// request. onTextDelta (2026-07-28, per Mo's streaming request) is called with the current round's
// live accumulated text as it streams in — reset to "" implicitly at the start of every new round
// since streamAnalyze's liveText is scoped per call. steps is returned alongside the answer — one
// entry per tool call actually executed (name/input/output) — so the UI can show a "what I
// checked" trace under the response instead of the tool loop being entirely invisible. usage sums
// input/output tokens across every round this turn actually took (a tool-calling turn is several
// separate Anthropic requests, not one), so the UI can show one honest total per chat message
// rather than just the final round's count. token (2026-07-29, per the workspace-siloing review —
// /api/analyze now requires a valid Supabase Bearer token, see that file's doc comment) is the
// caller's session.access_token, forwarded straight through to streamAnalyze; passing none here
// isn't a silent no-op, it's a guaranteed 401 from the API now that auth is required there.
export async function askAIRun({question,history,ctx,model,signal,onTextDelta,token}){
  const today=new Date().toISOString().slice(0,10);
  const hasBudgets=(ctx.budgetDims||[]).length>0;
  const system=`You are answering questions about the user's paid-media budget and spend data inside BudgetHQ. Today's date is ${today}. Tag dimensions in use: ${ctx.tagDims.join(", ")} (plus "Platform", "Campaign", and "Ad Group" are always available for query_spend too — these three are derived automatically from spend data, not stored as tags: Platform from platform/traffic-source, Campaign from the campaign/campaign-group name, Ad Group from the ad set/ad group name). ${hasBudgets?`Budget By dimensions (the only ones valid for query_budget/query_pacing): ${ctx.budgetDims.join(", ")}.`:"No Budget By dimensions are set up yet, so budget/pacing questions have nothing to query — say so rather than guessing."} Dates for query_spend must be YYYY-MM-DD; year/period for query_budget and query_pacing use separate year/period_type/month/quarter fields, not date strings. Always use the tools to get real numbers — never state a figure you didn't get from a tool call. Pick the right tool for what's actually being asked: query_spend for actual spend only (including tagged vs. untagged via tagged_status), query_budget for allocated/planned amounts only, query_pacing when a question compares the two, asks about pace/over-under-budget, or asks about daily burn rate or projected spend (query_pacing is the ONLY tool with those two figures). For a numeric-threshold question ("which segments spent more than $10,000", "campaigns pacing over 100%", "anything projected to blow past budget", "daily burn above $500"), use the tool's \`having\` param rather than trying to express it in \`filters\` (which only does exact string equality) — see each tool's having description for its exact field names and, for query_pacing, its \`matching_segments\` list of individual matches. When a user names a value casually (e.g. "emea"), call list_dimension_values first to find the exact stored spelling before filtering. If the user attached an image (a dashboard screenshot, a chart, a spend report), look at it directly and factor what you see into your answer, but still use the tools for any actual number you cite rather than reading it off the image. If the user attached a CSV/spreadsheet file, its content appears as plain text context below the question, clearly marked — that data is NOT part of the workspace's real budget/spend data (it was never imported), so don't call query_spend/query_budget/query_pacing expecting to find it; just read and reason about the attached text directly, and say so if the question seems to assume it was imported. Answer conversationally and concisely, citing the actual numbers returned. If asked to format as a list or table, plain markdown (bullets, numbered lists, pipe tables, **bold**) is fine — it renders correctly in this chat.`;
  const messages=[...history,{role:"user",content:question}];
  const steps=[];
  const usage={inputTokens:0,outputTokens:0};
  for(let round=0;round<ASK_AI_MAX_ROUNDS;round++){
    const data=await streamAnalyze({messages,system,tools:ASK_AI_TOOLS,maxTokens:1200,model,signal,onTextDelta,token});
    usage.inputTokens+=data.usage.input_tokens||0;
    usage.outputTokens+=data.usage.output_tokens||0;
    if(data.stop_reason!=="tool_use"){
      const text=data.content.find(b=>b.type==="text")?.text||"";
      return{answer:text||"(no response)",messages,steps,usage};
    }
    messages.push({role:"assistant",content:data.content});
    const toolResults=[];
    for(const block of data.content){
      if(block.type!=="tool_use")continue;
      let output;
      try{output=askAIExecuteTool(block.name,block.input||{},ctx);}
      catch(err){output={error:err.message};}
      steps.push({tool:block.name,input:block.input||{},output});
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
      dims:{type:"array",items:{type:"string"},description:"mode=\"custom\" only: which dimension(s) (tag dimensions, or \"Platform\"/\"Campaign\"/\"Ad Group\") to group rows by. Include every dimension you're also filtering on. Ignored for other modes."},
      filters:{type:"object",additionalProperties:{type:"string"},description:"Map of dimension name -> exact stored value. mode=\"budget\": keys must be Budget By dimensions. mode=\"custom\": keys must also appear in dims. mode=\"trend\": only the first entry is used, as the single filter dim/value."},
      status_filter:{type:"string",enum:["all","on-track","ahead","behind","over","committed","no-budget","no-data"],description:"mode=\"budget\" only: restrict to one pacing status. Defaults to \"all\"."},
      breakdown_dim:{type:"string",description:"mode=\"budget\" or \"custom\": an optional dimension to drill each row down by. Omit for none."},
      numeric_filters:{
        type:"array",
        description:`Optional numeric threshold filter(s) applied to each row/segment — e.g. "daily burn over $500" or "pacing under 50%". Each entry: {field, operator, value}. field must be one of: ${Object.keys(NUMERIC_FIELDS).join(", ")}. mode="budget" segments have all of these; mode="custom" segments only have spend/dailyRate/projected (no budget/actualPct/projectedVariance — custom mode has no budget concept). Ignored in mode="trend". operator is one of ${NUMERIC_OPERATORS.join(", ")}. actualPct is a FRACTION where 1.0 = 100% (e.g. value:1.0 for "over 100% pacing", value:0.5 for "under 50%"). Multiple entries are ANDed together.`,
        items:{type:"object",properties:{field:{type:"string"},operator:{type:"string",enum:NUMERIC_OPERATORS},value:{type:"number"}},required:["field","operator","value"]},
      },
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
export async function askAIBuildView({question,ctx,token}){
  const hasBudgets=(ctx.budgetDims||[]).length>0;
  const system=`You configure the Reporting & Pacing tab's "View by" table from a plain-English request. Tag dimensions: ${ctx.tagDims.join(", ")} (plus "Platform", "Campaign", and "Ad Group" are always available too — derived automatically from spend data, not stored as tags: Platform from platform/traffic-source, Campaign from the campaign/campaign-group name, Ad Group from the ad set/ad group name). ${hasBudgets?`Budget By dimensions (the ONLY ones usable for mode="budget" grouping/filters/status): ${ctx.budgetDims.join(", ")}. If the user wants to filter or group by something outside that list, use mode="custom" instead (include the dimension in dims).`:"No Budget By dimensions are set up yet, so mode=\"budget\" has nothing to group by — use mode=\"custom\" for anything about spend by dimension."} When the user names a value casually (e.g. "meta" or "emea"), call list_dimension_values first to confirm the exact stored spelling before filtering — filters must match exactly, not a substring. For requests with a numeric condition ("daily burn over $500", "pacing above 100%", "spend under $10,000", "projected to blow past budget"), use apply_view's numeric_filters param — do NOT try to express a numeric condition via the plain-text filters map, which only does exact string equality. Call apply_view exactly once, as your final action.`;
  const tools=[ASK_AI_TOOLS[0],ASK_AI_TOOLS[1],APPLY_VIEW_TOOL]; // list_tag_dimensions, list_dimension_values, apply_view
  const messages=[{role:"user",content:question}];
  for(let round=0;round<ASK_AI_VIEW_MAX_ROUNDS;round++){
    const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({messages,system,tools,maxTokens:800})});
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
  // Same {field,operator,value} shape PacingDashboard's own numeric filter chips build and store
  // (see its numericFilters state) — restricted to whichever NUMERIC_FIELDS entries are valid for
  // the resolved mode, so a model-proposed filter can never reference a field the mode's segments
  // don't actually have (e.g. "budget" in custom mode, which has no budget concept).
  const numericFilters=mode==="trend"?[]:sanitizeNumericFilters(raw.numeric_filters,Object.keys(NUMERIC_FIELDS).filter(f=>NUMERIC_FIELDS[f].modes.includes(mode)));
  if(mode==="trend"){
    const[fDim,fVal]=Object.entries(rawFilters).find(([d])=>allDims.includes(d))||[];
    const seriesDim=allDims.includes(raw.trend_series_dim)?raw.trend_series_dim:"Platform";
    return{
      viewMode:"trend",customDims:[],segFilters:{},statusFilter:"all",breakdownDim:"",numericFilters:[],
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
      numericFilters,
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
    numericFilters,
    trendFilterDim:"",trendFilterValue:"",trendSeriesDim:"Platform",trendMonthSpan:6,
  };
}

// Powers the "✨ AI Summary" card on the Budget Panel and Reporting & Pacing tabs. Deliberately NOT
// a tool-use loop like askAIRun — computePacing()/computeCustomGrouping()/computeSpendTrend()
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
export async function aiSummarizeBudgetPacing({mergedNormRows,tags,budgetDims,budgets,budgetRowMeta,defaultForecastModel,mode,view,token,combineGoogleChannels=false}){
  let payload,focus;
  if(mode==="pacing"&&view){
    const{viewMode,periodLabel,dims,segments,totals,expectedPct,daysRemaining,statusFilter,segFilters,numericFilters,trend,trendFilterDim,trendFilterValue,trendSeriesDim}=view;
    // Numeric filter chips (see NumericFilterChips/NUMERIC_FIELDS in PacingDashboard) formatted
    // the same way a person reads them off the chip itself — actualPct back to a whole percent,
    // everything else through fmtFull's $ formatting — so the summary's activeFilters mention
    // matches what's literally on screen, not raw internal units.
    const fmtFilterVal=f=>{
      const meta=NUMERIC_FIELDS[f.field];
      if(!meta)return String(f.value);
      return meta.isPct?`${Math.round(f.value*1000)/10}%`:`$${f.value.toLocaleString()}`;
    };
    const activeFilters=[
      ...(statusFilter&&statusFilter!=="all"?[`status = ${statusFilter}`]:[]),
      ...Object.entries(segFilters||{}).filter(([,v])=>(v||"").trim()).map(([d,v])=>`${d} contains "${v.trim()}"`),
      ...(numericFilters||[]).map(f=>`${NUMERIC_FIELDS[f.field]?.label||f.field} ${f.operator} ${fmtFilterVal(f)}`),
    ];
    if(viewMode==="trend"){
      const{periods,series,periodTotals,budgetValues,grandTotal}=trend||{periods:[],series:[],periodTotals:[],budgetValues:null,grandTotal:0};
      payload={
        viewType:"trend",
        dateRange:periods.length?`${periods[0].label} – ${periods[periods.length-1].label}`:"(no periods in range)",
        filterDim:trendFilterDim||null,
        filterValue:trendFilterValue||null,
        seriesDim:trendSeriesDim||null,
        grandTotal:Math.round(grandTotal),
        topSeries:series.slice(0,5).map(s=>({label:s.label,total:Math.round(s.total)})),
        periodTotals:periods.map((p,i)=>({period:p.label,total:Math.round(periodTotals[i]||0)})),
        totalBudget:budgetValues?Math.round(budgetValues.reduce((s,v)=>s+v,0)):null,
      };
      focus="This is the Budget Pacing tab's Trend view — spend (and, when available, budget) over a date range, bucketed by whatever grain the user picked (day/week/month/quarter/year), broken out by series (e.g. Platform or a tag dimension). Describe the overall trend across periods (growing, declining, or flat), call out which series dominates spend, mention any notable period-over-period swings, and if totalBudget is present, compare total spend to total budget.";
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
      const capacityConstrainedCount=segments.filter(s=>s.capacitySignal==="constrained").length;
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
        segmentsCapacityConstrained:capacityConstrainedCount,
        activeFilters,
      };
      focus=`This is the Reporting & Pacing tab, scoped to ${periodLabel} — use exactly this period, not the full year. Focus on pacing performance: overall pace vs the expected pace for this point in ${periodLabel}, which segments are most over budget, which are furthest behind pace, and what's worth a closer look. segmentsCommitted are lump-sum/prepaid budget lines deliberately excluded from pace comparisons — mention them only if the count is non-zero, and don't call them "behind" or "ahead." segmentsCapacityConstrained are behind-pace segments with real budget headroom left whose impressions haven't grown recently — a signal that raising the budget likely won't fix them; mention this only if the count is non-zero, and frame it as "worth investigating (creative/audience/frequency), not just a budget problem."${activeFilters.length?` The user has filtered this view (${activeFilters.join("; ")}) — every figure above already reflects only that filtered subset, so base the summary on it and mention that it's filtered.`:""}`;
    }
  }else{
    const year=String(new Date().getFullYear());
    const pacing=computePacing({mergedNormRows,tags,budgetDims,budgets,year,periodType:"annual",month:null,quarter:null,today:new Date(),budgetRowMeta,defaultForecastModel,combineGoogleChannels});
    const withVariance=pacing.segments.map(s=>({...s,overBy:s.spend-s.budget}));
    const topOver=[...withVariance].filter(s=>s.status==="over").sort((a,b)=>b.overBy-a.overBy).slice(0,5)
      .map(s=>({segment:s.dims.join(" / "),budget:Math.round(s.budget),spend:Math.round(s.spend),overBy:Math.round(s.overBy)}));
    const topBehind=[...pacing.segments].filter(s=>s.status==="behind").sort((a,b)=>(a.actualPct??0)-(b.actualPct??0)).slice(0,5)
      .map(s=>({segment:s.dims.join(" / "),budget:Math.round(s.budget),spend:Math.round(s.spend),actualPct:s.actualPct==null?null:Math.round(s.actualPct*100)}));
    const noDataCount=pacing.segments.filter(s=>s.budget>0&&!s.hasData).length;
    const committedCount=pacing.segments.filter(s=>s.status==="committed").length;
    const capacityConstrainedCount=pacing.segments.filter(s=>s.capacitySignal==="constrained").length;
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
      segmentsCapacityConstrained:capacityConstrainedCount,
    };
    focus="This is for the Budget Panel (where budgets are set up), so focus on budget SETUP and coverage: how many segments are budgeted, the total budgeted amount, and flag segmentsWithBudgetButNoSpendDataYet as a likely tagging gap worth checking (a segment has a budget but no matching spend rows yet). segmentsCapacityConstrained are behind-pace segments whose impressions haven't grown recently despite budget headroom — a signal more budget likely won't fix them; mention only if non-zero.";
  }
  const system=`You are writing a short summary for a paid-media budget dashboard called BudgetHQ. Below is pre-computed JSON data — it is already correct, do not recompute or second-guess any numbers, just narrate them. Write 3-5 sentences of plain prose (no markdown headers, no bullet lists), citing the real figures. If a list is empty, don't dwell on it. ${focus}`;
  const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({messages:[{role:"user",content:JSON.stringify(payload)}],system,maxTokens:400})});
  const data=await res.json();
  if(!res.ok)throw new Error(data?.error||"Summary request failed");
  return data.text||"(no response)";
}

// Self-contained "✨ AI Summary" trigger + result card, shared by the Budget Panel and Reporting &
// Pacing tabs (see aiSummarizeBudgetPacing above). Owns its own idle/loading/done/error state so
// each tab gets an independent summary rather than sharing one across navigation.
