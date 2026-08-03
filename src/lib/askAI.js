import { campaignKey, derivePlatform, parseSpendDate, getPeriodRange, computePacing, NUMERIC_FIELDS, NUMERIC_OPERATORS, matchesNumericFilters } from "./core.js";
import { PIPELINE_METRIC_MAP_OPTIONS, AD_GROUP_TAG_KEY, CHANNEL_TAG_KEY } from "./pipelineColumnMapping.js";
import { isRateMetric, computeDerivedPipelineMetrics, DERIVED_PIPELINE_METRICS, computeCustomMetrics } from "./reportingMetrics.js";
import { createChangeEvents, CHANGE_TYPE_OPTIONS, ENTITY_TYPE_OPTIONS } from "./changeEventsApi.js";

// How many individual segments a having-filtered or small unfiltered result includes in
// matching_segments (see askAIQueryPacing) before falling back to just the count — keeps a
// "list everything over $X" question answerable in one tool call without risking an unbounded
// response for a workspace with hundreds of segments.
const ASK_AI_MAX_LISTED_SEGMENTS=50;

// Google connector's extra_metrics fields (api/connectors/google.js) that askAIQuerySpend now
// surfaces (2026-08-03, per Mo's DDMQL/channel-signal request). Split into two families because
// they aggregate differently — see accumulateExtraMetrics/finalizeExtraMetrics below:
//   - EXTRA_METRIC_SUM_FIELDS: plain counts/dollar totals, safe to sum directly across rows, same
//     "only ever sum an absolute" rule reportingMetrics.js's isRateMetric already enforces for
//     pipeline data.
//   - IMPRESSION_SHARE_FIELDS: ratios (impressions received / impressions eligible) — naively
//     averaging per-row percentages across ad groups with very different impression volumes would
//     be misleading (a 100-impression ad group at 100% share and a 10,000-impression one at 20%
//     share should blend to ~20%, not 60%), so these get impressions-weighted aggregation instead.
// average_cpc/ctr are deliberately NOT in either list — they're exactly total_spend/total_clicks and
// total_clicks/total_impressions respectively, which askAIQuerySpend already computes correctly from
// its existing totals, so re-aggregating the raw per-row fields would be redundant.
const EXTRA_METRIC_SUM_FIELDS=["ddmql","conversions","conversions_value","all_conversions","all_conversions_value"];
const IMPRESSION_SHARE_FIELDS=["search_impression_share","search_top_impression_share","search_absolute_top_impression_share","search_rank_lost_impression_share","search_rank_lost_top_impression_share","search_rank_lost_absolute_top_impression_share"];
const EXTRA_METRIC_HAVING_FIELDS=[...EXTRA_METRIC_SUM_FIELDS,"cost_per_ddmql",...IMPRESSION_SHARE_FIELDS];

// Accumulator for the extra-metrics fields above across a set of matching rows — see the two
// families' doc note up top for why sums and impression-share fields aggregate differently.
function emptyExtraAccumulator(){
  return{
    sums:Object.fromEntries(EXTRA_METRIC_SUM_FIELDS.map(k=>[k,0])),
    shareWeighted:Object.fromEntries(IMPRESSION_SHARE_FIELDS.map(k=>[k,{weightedImpr:0,eligibleImpr:0}])),
  };
}
function accumulateExtraMetrics(acc,row){
  const em=row.extra_metrics||{};
  const impr=row.impressions||0;
  EXTRA_METRIC_SUM_FIELDS.forEach(k=>{if(typeof em[k]==="number")acc.sums[k]+=em[k];});
  IMPRESSION_SHARE_FIELDS.forEach(k=>{
    const share=em[k];
    // impressions_eligible = impressions_received / share (share=0 means either no eligible
    // auctions or a genuine 0% share — either way there's nothing safe to divide by, so skip it
    // rather than risk a divide-by-zero/Infinity poisoning the blended total).
    if(typeof share==="number"&&share>0&&impr>0){
      acc.shareWeighted[k].weightedImpr+=impr;
      acc.shareWeighted[k].eligibleImpr+=impr/share;
    }
  });
}
// Collapses an accumulator into plain output fields — a sum field is omitted entirely if it never
// saw a real value (same "drop rather than fabricate a 0" rule used throughout this file), same for
// an impression-share field with no weighted data to blend.
function finalizeExtraMetrics(acc,spend){
  const out={};
  EXTRA_METRIC_SUM_FIELDS.forEach(k=>{if(acc.sums[k])out[k]=Math.round(acc.sums[k]*100)/100;});
  IMPRESSION_SHARE_FIELDS.forEach(k=>{
    const w=acc.shareWeighted[k];
    if(w.eligibleImpr>0)out[k]=Math.round((w.weightedImpr/w.eligibleImpr)*10000)/10000;
  });
  if(typeof out.ddmql==="number"&&out.ddmql>0)out.cost_per_ddmql=Math.round((spend/out.ddmql)*100)/100;
  return out;
}

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
    description:"Get total ACTUAL spend/clicks/impressions for campaigns matching a set of dimension filters within a date range, optionally broken down by one more dimension, optionally restricted to only fully-tagged or only untagged campaigns. This has no concept of budget — use query_budget or query_pacing for anything about allocated/planned amounts. This is the only source of truth for spend numbers — never estimate or recall a figure without calling this."+
      " CHANNEL SIGNAL (2026-08-03): Google-synced rows only (not other platforms, not manually-imported/CSV rows) also carry ddmql, cost_per_ddmql (derived), conversions/conversions_value/all_conversions/all_conversions_value (blended totals across EVERY conversion action the account counts — NOT ddmql-specific), and the search_impression_share family (search_impression_share, search_top_impression_share, search_absolute_top_impression_share, search_rank_lost_impression_share, search_rank_lost_top_impression_share, search_rank_lost_absolute_top_impression_share — impressions-weighted when broken down by group_by, never a naive average of percentages) in the response whenever present."+
      " ddmql is Mo's own Google Ads conversion action used as a directional proxy for MQLs at the ad-group level (PowerBI's real MQL/SQL/pipeline data — query_pipeline — only exists at Campaign grain, never Ad Group). It is NOT validated against PowerBI at the ad-group level and the size (and direction) of the gap between ddmql and the real PowerBI MQL count VARIES by campaign and date range — never assume a gap seen for one campaign applies to another. Whenever a question uses ddmql to recommend an ad-group-level action (e.g. where to allocate budget), ALSO call query_pipeline filtered to that ad group's parent campaign over the same date range, and explicitly state the ddmql-vs-PowerBI comparison for that specific scope in the answer — never present a ddmql-based recommendation without that live cross-check.",
    input_schema:{type:"object",properties:{
      filters:{type:"object",description:"Map of dimension name -> exact value to filter to (use \"Platform\", \"Campaign\", or \"Ad Group\" as a key to filter on those). Omit a dimension entirely to not filter on it.",additionalProperties:{type:"string"}},
      start_date:{type:"string",description:"YYYY-MM-DD, inclusive. Omit for no lower bound."},
      end_date:{type:"string",description:"YYYY-MM-DD, inclusive. Omit for no upper bound."},
      group_by:{type:"string",description:"Optional dimension name (or \"Platform\", \"Campaign\", \"Ad Group\") to break the total down by."},
      tagged_status:{type:"string",enum:["any","tagged","untagged"],description:"\"tagged\" = only campaigns that have a value set for EVERY tag dimension (fully tagged, matching the Tagger's own definition). \"untagged\" = campaigns missing at least one. Defaults to \"any\" (no restriction). Use this for questions like \"how much spend is untagged\" or \"what's tagged vs. not\"."},
      having:havingSchema(["spend",...EXTRA_METRIC_HAVING_FIELDS]),
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
  {
    name:"query_pipeline",
    description:"Get pipeline/funnel performance — Spend, Leads, MQLs, SQLs, Pipeline Value, Revenue, and whichever other funnel-stage counts this workspace tracks (MQAs, Handraisers, Demos, Free Trials, PQLs, Meetings Booked, SALs, Closed Won/Lost), PLUS derived cost-per metrics (cp_lead, cp_mql, cp_sal, cp_sql, cp_win) and conversion-rate metrics (lead_to_mql_rate, mql_to_sal_rate, mql_to_sql_rate, sal_to_sql_rate, sql_to_win_rate, win_rate, roas) — for rows matching a set of dimension filters within a date range, optionally broken down by one more dimension. This is the SAME tagged pipeline/funnel data the Performance Intelligence tab shows — a SEPARATE dataset from ad-platform spend/click data (imported and tagged independently, even though both happen to have a \"spend\" and \"Campaign\"/\"Ad Group\" concept). Use this for ANY question about leads, MQLs, SQLs, demos, pipeline value, revenue, funnel conversion rates, or cost-per-X — use query_spend/query_budget/query_pacing instead for pure ad-platform spend or budget/pacing questions. Any workspace-defined custom metric also appears in the response under its own key (see its label from list_tag_dimensions is not applicable — custom metric keys are self-descriptive, e.g. \"custom_cost_per_demo\") but can't be filtered via `having`.",
    input_schema:{type:"object",properties:{
      filters:{type:"object",description:"Map of dimension name -> exact value to filter to. Use \"Campaign\", \"Ad Group\", or \"Channel\" as a key to filter on those — Channel and this dataset's own Ad Group are pipeline-specific fields with their own value pools, distinct from spend data's Platform/Ad Group. Any other key must be a real tag dimension name from list_tag_dimensions. Omit a dimension entirely to not filter on it.",additionalProperties:{type:"string"}},
      start_date:{type:"string",description:"YYYY-MM-DD, inclusive — matched against each imported period's month (this data is monthly/quarterly/yearly, never daily-grain). Omit for no lower bound."},
      end_date:{type:"string",description:"YYYY-MM-DD, inclusive. Omit for no upper bound."},
      group_by:{type:"string",description:"Optional dimension name (or \"Campaign\", \"Ad Group\", \"Channel\") to break the totals down by — e.g. group_by=\"Product\" to compare pipeline performance across products, or group_by=\"Campaign\" (with a Product filter set) to see campaign-level performance within one product."},
      having:{
        type:"array",
        description:`Optional post-aggregation numeric threshold filter(s) on the group_by breakdown — REQUIRES group_by to be set, since this filters which breakdown GROUPS appear (like SQL's HAVING), not individual rows. Each entry: {field, operator, value}. field must be one of: ${[...PIPELINE_METRIC_MAP_OPTIONS.map(m=>m.key),...DERIVED_PIPELINE_METRICS.map(d=>d.key)].join(", ")}. operator is one of ${NUMERIC_OPERATORS.join(", ")}. Multiple entries are ANDed together. The rate fields (${DERIVED_PIPELINE_METRICS.filter(d=>d.pct).map(d=>d.key).join(", ")}) and roas are FRACTIONS/multipliers, not the 0-100 number a person would say out loud — e.g. use value:0.5 for "a 50% MQL to SQL rate", not value:50.`,
        items:{type:"object",properties:{field:{type:"string"},operator:{type:"string",enum:NUMERIC_OPERATORS},value:{type:"number"}},required:["field","operator","value"]},
      },
    },required:[]},
  },
  {
    // Change History's write tool (2026-08-19, per Mo — "what If I share a screenshot with Ask AI
    // and have Ask AI log the changes in PaidHQ from the screenshot?"). Every OTHER tool in this
    // array is a pure read against already-loaded ctx data; this is the one exception — it makes a
    // real network write to core.change_events (see askAIExecuteTool's handler below), which is why
    // askAIRun filters it OUT of the tools list entirely for a view-only (!canEdit) caller rather
    // than relying on the model to decline, and why askAIExecuteTool is async (every other tool
    // handler is a synchronous return). entries is an ARRAY specifically so one screenshot showing
    // several rows (e.g. Google Ads' own native Change History page, which is exactly the kind of
    // screenshot Mo described) logs in a single tool call instead of one round-trip per row.
    name:"log_change_event",
    description:"Log one or more changes into PaidHQ's Change History (core.change_events) — use this when the user shares a screenshot or description of changes made in an ad platform (e.g. a screenshot of Google Ads' own \"Change history\" page) and asks you to log them here. Extract EACH distinct row/change as its own entry in the array — never merge multiple different changes into one entry, and never invent a value that isn't actually shown or stated; omit an optional field rather than guess. This always creates MANUAL entries (entrySource is not settable) — it does not affect or duplicate the separate automated Google Ads pull. Requires edit access; if the workspace member asking doesn't have it, this tool won't be offered at all.",
    input_schema:{type:"object",properties:{
      entries:{
        type:"array",
        description:"One object per distinct change.",
        items:{type:"object",properties:{
          platform:{type:"string",description:"e.g. \"Google\", \"Meta\", \"LinkedIn\", \"Bing\", \"Capterra\", \"Reddit\", \"TikTok\", \"YouTube\", \"Pinterest\", or \"Other\" if genuinely unclear."},
          entity_type:{type:"string",enum:ENTITY_TYPE_OPTIONS,description:"What kind of object changed, if determinable."},
          entity_name:{type:"string",description:"The campaign or ad group name the change applied to, if shown."},
          change_type:{type:"string",enum:CHANGE_TYPE_OPTIONS,description:"Best-fit category for the change."},
          summary:{type:"string",description:"Short human-readable description, e.g. \"Budget amount increased\" or \"1 ad group enabled\" — mirror the platform's own wording where possible rather than paraphrasing."},
          details:{type:"string",description:"Any additional detail shown (e.g. the full row's extra text) that doesn't fit summary/old/new value."},
          old_value:{type:"string",description:"The value before the change, if shown (e.g. \"$400.00\")."},
          new_value:{type:"string",description:"The value after the change, if shown (e.g. \"$1,200.00\")."},
          changed_by:{type:"string",description:"Who made the change, if shown (e.g. an email address)."},
          changed_at:{type:"string",description:"When the change happened, if shown — any reasonably parseable date/time string (e.g. \"Aug 3, 2026, 1:32:33 PM\"). Omit if not shown; defaults to right now."},
        },required:["platform","change_type","summary"]},
      },
    },required:["entries"]},
  },
];

// Resolves one dimension's value for a reporting_facts row (2026-08-11, per Mo — "train the AI on
// all of the spend, budget and pipeline performance data"). "Campaign", "Ad Group", "Channel" are
// synthetic/reserved for THIS dataset specifically — Ad Group and Channel live inside the row's own
// `tags` object under pipelineColumnMapping.js's reserved AD_GROUP_TAG_KEY/CHANNEL_TAG_KEY (never
// as a real tag_dims entry, so they can't collide with a user-created dimension of the same name —
// see that file's own doc comment), rather than being derived from anything spend-side. A plain tag
// dimension name (e.g. "Product") reads straight off row.tags, same convention as askAIDimValue.
function askAIPipelineDimValue(row,dim,fallback=""){
  const d=(dim||"").toLowerCase();
  if(d==="campaign")return (row.campaignName||"").trim()||fallback;
  if(d==="ad group"||d==="adgroup"||d==="ad set"||d==="adset")return (row.tags||{})[AD_GROUP_TAG_KEY]||fallback;
  if(d==="channel")return (row.tags||{})[CHANNEL_TAG_KEY]||fallback;
  return (row.tags||{})[dim]||fallback;
}

// Unions spend-side and pipeline-side values for one dimension — a tag dimension name (e.g.
// "Product") is shared vocabulary, but the two datasets are tagged INDEPENDENTLY (Campaign Tagger's
// own per-campaign tags vs. reporting_facts rows' own tags — see reportingFacts param's own callers
// for why), so a value used only on one side (or spelled slightly differently) would otherwise be
// invisible to whichever query_* tool needs the other side's exact spelling. reportingFacts is
// optional so this still works for spend-only questions when Ask AI hasn't loaded any pipeline data
// (e.g. a workspace that's never used Pipeline Tagger).
export function askAIListDimensionValues({mergedNormRows,tags,reportingFacts,dimension}){
  const vals=new Set();
  (mergedNormRows||[]).forEach(row=>{
    const key=campaignKey(row.campaign_group_name,row.campaign_name);
    const rowTags=tags[key]||{};
    const v=askAIDimValue(row,rowTags,dimension);
    if(v)vals.add(v);
  });
  (reportingFacts||[]).forEach(row=>{
    const v=askAIPipelineDimValue(row,dimension);
    if(v)vals.add(v);
  });
  return Array.from(vals).sort();
}

// Rounds every numeric metric to cent-level precision for the response — same convention this
// file already uses everywhere else ($/count totals rounded via Math.round(x*100)/100) — and drops
// any non-finite value rather than surfacing a NaN/Infinity to the model.
function roundPipelineMetrics(metrics){
  const out={};
  Object.entries(metrics||{}).forEach(([k,v])=>{
    if(typeof v!=="number"||!isFinite(v))return;
    out[k]=Math.round(v*100)/100;
  });
  return out;
}

// Pipeline/funnel query (2026-08-11, per Mo's "train the AI on all of the spend, budget and
// pipeline performance data" request) — reuses the EXACT SAME rollup rules Performance
// Intelligence itself uses (reportingMetrics.js's isRateMetric/computeDerivedPipelineMetrics/
// computeCustomMetrics): every absolute funnel count/dollar figure sums correctly across rows, a
// rate/cost-per metric is NEVER summed or averaged directly, only recomputed from already-summed
// absolutes. periodStart/periodType mean this data is never daily-grain, so date filtering matches
// by MONTH slice (YYYY-MM), same convention PipelineTagger's own range filter already uses.
export function askAIQueryPipeline({reportingFacts,customMetrics,filters,startDate,endDate,groupBy,having}){
  const filterEntries=Object.entries(filters||{}).filter(([,v])=>v);
  const startMonth=startDate?startDate.slice(0,7):null;
  const endMonth=endDate?endDate.slice(0,7):null;
  const absoluteTotals={};
  const groupMap={};
  const campaignSet=new Set();
  (reportingFacts||[]).forEach(row=>{
    const rowMonth=(row.periodStart||"").slice(0,7);
    if(startMonth&&rowMonth<startMonth)return;
    if(endMonth&&rowMonth>endMonth)return;
    const matches=filterEntries.every(([dim,val])=>askAIPipelineDimValue(row,dim).toLowerCase()===String(val).toLowerCase());
    if(!matches)return;
    campaignSet.add((row.campaignName||"").trim()||"(no campaign)");
    const addTo=target=>Object.entries(row.metrics||{}).forEach(([k,v])=>{
      if(isRateMetric(k))return; // never sum a raw imported rate — see reportingMetrics.js's own doc comment
      const n=Number(v);
      if(isNaN(n))return;
      target[k]=(target[k]||0)+n;
    });
    addTo(absoluteTotals);
    if(groupBy){
      const gv=askAIPipelineDimValue(row,groupBy,"Untagged");
      if(!groupMap[gv])groupMap[gv]={};
      addTo(groupMap[gv]);
    }
  });
  const result={
    campaign_count:campaignSet.size,
    metrics:roundPipelineMetrics({...absoluteTotals,...computeDerivedPipelineMetrics(absoluteTotals),...computeCustomMetrics(absoluteTotals,customMetrics)}),
  };
  if(groupBy){
    const havingFields=[...PIPELINE_METRIC_MAP_OPTIONS.map(m=>m.key),...DERIVED_PIPELINE_METRICS.map(d=>d.key)];
    const havingFilters=sanitizeNumericFilters(having,havingFields);
    const rows=Object.entries(groupMap).map(([value,sums])=>({
      value,
      metrics:roundPipelineMetrics({...sums,...computeDerivedPipelineMetrics(sums),...computeCustomMetrics(sums,customMetrics)}),
    }));
    result.breakdown=(havingFilters.length?rows.filter(r=>matchesNumericFilters(r.metrics,havingFilters)):rows)
      .sort((a,b)=>(b.metrics.spend||0)-(a.metrics.spend||0)||(b.metrics.pipeline_value||0)-(a.metrics.pipeline_value||0));
  }
  return result;
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
  const totalExtra=emptyExtraAccumulator();
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
    accumulateExtraMetrics(totalExtra,row);
    seenCampaigns.add(key);
    if(groupBy){
      const gv=askAIDimValue(row,rowTags,groupBy,"Untagged");
      if(!groupMap[gv])groupMap[gv]={spend:0,extra:emptyExtraAccumulator()};
      groupMap[gv].spend+=(row.spend||0);
      accumulateExtraMetrics(groupMap[gv].extra,row);
    }
  });
  const result={
    total_spend:Math.round(totalSpend*100)/100,
    total_clicks:totalClicks,
    total_impressions:totalImpr,
    campaign_count:seenCampaigns.size,
    ...finalizeExtraMetrics(totalExtra,totalSpend),
  };
  if(groupBy){
    const havingFilters=sanitizeNumericFilters(having,["spend",...EXTRA_METRIC_HAVING_FIELDS]);
    result.breakdown=Object.entries(groupMap)
      .map(([value,g])=>({value,spend:Math.round(g.spend*100)/100,...finalizeExtraMetrics(g.extra,g.spend)}))
      .filter(r=>matchesNumericFilters(r,havingFilters))
      .sort((a,b)=>b.spend-a.spend);
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
//
// ASYNC (2026-08-19) even though every branch except log_change_event is a synchronous, pure
// computation over ctx's already-loaded data — log_change_event is the one tool that makes a real
// network write (see its own branch below), and askAIRun's call site now awaits this uniformly
// rather than having two different call conventions for "most tools" vs. "the one that writes".
export async function askAIExecuteTool(toolName,input,ctx){
  if(toolName==="list_tag_dimensions"){
    return{
      dimensions:ctx.tagDims,
      budget_dimensions:ctx.budgetDims||[],
      budget_years_with_data:Object.keys(ctx.budgets||{}).sort(),
    };
  }
  if(toolName==="list_dimension_values")return{values:askAIListDimensionValues({mergedNormRows:ctx.mergedNormRows,tags:ctx.tags,reportingFacts:ctx.reportingFacts,dimension:input.dimension})};
  if(toolName==="query_spend")return askAIQuerySpend({mergedNormRows:ctx.mergedNormRows,tags:ctx.tags,tagDims:ctx.tagDims,filters:input.filters,startDate:input.start_date,endDate:input.end_date,groupBy:input.group_by,taggedStatus:input.tagged_status,having:input.having});
  if(toolName==="query_budget"){
    if(!(ctx.budgetDims||[]).length)return{error:"No Budget By dimensions are set up yet in the Budget Panel — there's no budget data to query."};
    return askAIQueryBudget({budgets:ctx.budgets,budgetDims:ctx.budgetDims,filters:input.filters,year:input.year,periodType:input.period_type,month:input.month,quarter:input.quarter,groupBy:input.group_by,having:input.having});
  }
  if(toolName==="query_pacing"){
    if(!(ctx.budgetDims||[]).length)return{error:"No Budget By dimensions are set up yet in the Budget Panel — there's no budget data to compare spend against."};
    return askAIQueryPacing({mergedNormRows:ctx.mergedNormRows,tags:ctx.tags,budgetDims:ctx.budgetDims,budgets:ctx.budgets,budgetRowMeta:ctx.budgetRowMeta,defaultForecastModel:ctx.defaultForecastModel,filters:input.filters,year:input.year,periodType:input.period_type,month:input.month,quarter:input.quarter,groupBy:input.group_by,having:input.having,combineGoogleChannels:ctx.combineGoogleChannels});
  }
  if(toolName==="query_pipeline"){
    if(!(ctx.reportingFacts||[]).length)return{error:"No pipeline/funnel data has been imported yet — nothing to query. Import it via Pipeline Tagger first."};
    return askAIQueryPipeline({reportingFacts:ctx.reportingFacts,customMetrics:ctx.customMetrics,filters:input.filters,startDate:input.start_date,endDate:input.end_date,groupBy:input.group_by,having:input.having});
  }
  if(toolName==="log_change_event"){
    // Belt-and-suspenders alongside askAIRun's tools-list filtering below (which keeps a !canEdit
    // caller's model from ever being OFFERED this tool in the first place) — defends the same rule
    // a second way in case ctx.canEdit and the filtered tools list ever drift out of sync.
    if(!ctx.canEdit)return{error:"This workspace member has view-only access, so I can't log changes here."};
    if(!ctx.session||!ctx.workspaceId)return{error:"Missing session/workspace context — can't log a change right now."};
    const entries=Array.isArray(input.entries)?input.entries:[];
    if(!entries.length)return{error:"No entries provided."};
    const rows=entries.map(e=>({
      platform:e.platform,
      entityType:e.entity_type||null,
      entityName:e.entity_name||null,
      changeType:e.change_type,
      summary:e.summary,
      details:e.details||null,
      oldValue:e.old_value||null,
      newValue:e.new_value||null,
      changedBy:e.changed_by||null,
      // A date string the model read off a screenshot (e.g. "Aug 3, 2026, 1:32:33 PM") goes through
      // plain Date parsing — good enough for a human-supplied timestamp from a UI it's reading, same
      // trust level as the "+ Log a change" form's own datetime-local input. Falls back to right now
      // if omitted or unparseable, rather than rejecting the whole entry over a missing/bad date.
      changedAt:(()=>{const d=e.changed_at?new Date(e.changed_at):null;return d&&!isNaN(d.getTime())?d.toISOString():new Date().toISOString();})(),
      entrySource:"manual",
    }));
    try{
      const result=await createChangeEvents(ctx.session,ctx.workspaceId,rows);
      return{logged:result.inserted,skipped:result.skipped};
    }catch(err){
      return{error:err.message||"Failed to log the change(s)."};
    }
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
// Raised from 6 to 9 (2026-08-16, alongside the maxTokens bump above) — a genuinely multi-step
// analytical question (e.g. a specific campaign's month-by-month spend/pipeline breakdown across
// 5 months, since query_pipeline groups by DIMENSION rather than by period, so a per-month trend
// means one call per month) could legitimately need most of the old 6-round budget just for tool
// calls, leaving no room for a final synthesis round. Still a hard cap either way — runs out into
// the same "took too many steps" error below rather than looping forever.
export const ASK_AI_MAX_ROUNDS=9;
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
  const hasPipeline=(ctx.reportingFacts||[]).length>0;
  // log_change_event is the one tool in ASK_AI_TOOLS that writes rather than reads — offered to the
  // model at all ONLY when the caller actually has edit access (2026-08-19, per Mo's screenshot-
  // logging request). Filtering it out of the tools list here means a view-only member's model never
  // even considers calling it, rather than calling it and getting back an error every time — belt-
  // and-suspenders with askAIExecuteTool's own ctx.canEdit check.
  const tools=ctx.canEdit?ASK_AI_TOOLS:ASK_AI_TOOLS.filter(t=>t.name!=="log_change_event");
  const system=`You are answering questions about the user's paid-media budget, spend, and pipeline/funnel data inside PaidHQ. Today's date is ${today}. Tag dimensions in use: ${ctx.tagDims.join(", ")} (plus "Platform", "Campaign", and "Ad Group" are always available for query_spend too — these three are derived automatically from spend data, not stored as tags: Platform from platform/traffic-source, Campaign from the campaign/campaign-group name, Ad Group from the ad set/ad group name; query_pipeline has its OWN separate "Campaign"/"Ad Group" plus "Channel", from the pipeline dataset — see query_pipeline's own description). ${hasBudgets?`Budget By dimensions (the only ones valid for query_budget/query_pacing): ${ctx.budgetDims.join(", ")}.`:"No Budget By dimensions are set up yet, so budget/pacing questions have nothing to query — say so rather than guessing."} ${hasPipeline?"Pipeline/funnel data (leads, MQLs, SQLs, pipeline value, revenue, and the workspace's own custom metrics) IS available via query_pipeline.":"No pipeline/funnel data has been imported yet, so query_pipeline has nothing to query — say so rather than guessing if asked about leads/MQLs/SQLs/pipeline value."} Dates for query_spend and query_pipeline must be YYYY-MM-DD; year/period for query_budget and query_pacing use separate year/period_type/month/quarter fields, not date strings. Always use the tools to get real numbers — never state a figure you didn't get from a tool call. Pick the right tool for what's actually being asked: query_spend for actual ad-platform spend only (including tagged vs. untagged via tagged_status), query_budget for allocated/planned amounts only, query_pacing when a question compares the two, asks about pace/over-under-budget, or asks about daily burn rate or projected spend (query_pacing is the ONLY tool with those two figures), query_pipeline for anything about leads, MQLs, SQLs, demos, pipeline value, revenue, funnel conversion rates, or cost-per-X — query_pipeline's own "spend" field belongs to the pipeline dataset, NOT the same number query_spend would return for the same campaign, since the two are imported/tagged independently; never mix a query_pipeline total with a query_spend total as if they were one figure. For "campaign performance for each product" or similar cross-dimension questions, call query_pipeline once with group_by="Product" for the overview, then call it again per product with a Product filter and group_by="Campaign" to drill into that product's campaigns — don't guess at campaign names. For a numeric-threshold question ("which segments spent more than $10,000", "campaigns pacing over 100%", "anything projected to blow past budget", "daily burn above $500", "products with an MQL to SQL rate under 20%"), use the tool's \`having\` param rather than trying to express it in \`filters\` (which only does exact string equality) — see each tool's having description for its exact field names and, for query_pacing, its \`matching_segments\` list of individual matches. When a user names a value casually (e.g. "emea"), call list_dimension_values first to find the exact stored spelling before filtering — this also resolves values for query_pipeline's filters, including Channel. If the user attached an image (a dashboard screenshot, a chart, a spend report), look at it directly and factor what you see into your answer, but still use the tools for any actual number you cite rather than reading it off the image${ctx.canEdit?" — UNLESS it's a screenshot of a platform's own change-history/audit page (e.g. Google Ads' \"Change history\") and the user is asking you to log or save those changes, in which case call log_change_event with one entry per distinct row you can see, using exactly what's shown (never invent a value that isn't visibly there)":""}. If the user attached a CSV/spreadsheet file, its content appears as plain text context below the question, clearly marked — that data is NOT part of the workspace's real budget/spend/pipeline data (it was never imported), so don't call query_spend/query_budget/query_pacing/query_pipeline expecting to find it; just read and reason about the attached text directly, and say so if the question seems to assume it was imported. Answer conversationally and concisely, citing the actual numbers returned. If asked to format as a list or table, plain markdown (bullets, numbered lists, pipe tables, **bold**) is fine — it renders correctly in this chat.`;
  const messages=[...history,{role:"user",content:question}];
  const steps=[];
  const usage={inputTokens:0,outputTokens:0};
  for(let round=0;round<ASK_AI_MAX_ROUNDS;round++){
    // maxTokens raised from 1200 to 4096 (2026-08-16, per Mo — reported "(no response)" on detailed
    // multi-tool-call questions, e.g. a specific campaign's month-over-month spend-to-pipeline-dollar
    // breakdown). Root cause: 1200 output tokens isn't always enough for a round that BOTH continues
    // calling tools (a large tool_use input) AND, on a later round, synthesizes a full comparative
    // answer — when the model hit that ceiling mid-generation, Anthropic reports stop_reason
    // "max_tokens" (not "tool_use"), so this loop took the "final answer" branch below, but the
    // round's content had EITHER no text block yet (still mid tool_use when cut off) or only a
    // partial one — the "no text block at all" case is exactly what produced "(no response)": a
    // real, if truncated, model turn silently presented as an empty one.
    // Raised from 4096 to 8192 (2026-08-19, per Mo — a "log these changes" request over a screenshot
    // with ~14 rows was hitting max_tokens mid-generation of log_change_event's entries array before
    // ever finishing it, so the tool call never actually executed and nothing got logged (Anthropic
    // reports stop_reason "max_tokens", not "tool_use", when this happens — see the early-return
    // branch right below). Structured JSON (many fields per entry, plus key names/quotes/braces) eats
    // more tokens per unit of real content than prose does, so the 2026-08-16 bump to 4096 (sized for
    // a detailed comparative PROSE answer) wasn't enough headroom for a bulk structured tool call.
    // 8192 needs no extra API beta header (checked against api/analyze.js's request shape) and covers
    // a page of ~30-40 logged rows comfortably, not just Mo's original 14.
    const data=await streamAnalyze({messages,system,tools,maxTokens:8192,model,signal,onTextDelta,token});
    usage.inputTokens+=data.usage.input_tokens||0;
    usage.outputTokens+=data.usage.output_tokens||0;
    if(data.stop_reason!=="tool_use"){
      const text=data.content.find(b=>b.type==="text")?.text||"";
      // Distinguishes "the model was cut off before producing any text" from a genuine empty
      // response — the former is a real answer that just ran out of room, worth telling the user
      // to retry/narrow their question rather than implying nothing happened at all.
      const answer=text||(data.stop_reason==="max_tokens"?"(response cut off before finishing — try asking a more specific or narrower question)":"(no response)");
      // failed (2026-08-19, per Mo — "Ask AI hasn't been working for a while", tracked down to this:
      // a turn that produced no real text was STILL saved into permanent chat history (messages,
      // which by this point can already contain several rounds' worth of tool_use/tool_result
      // exchanges from the failed attempt), so every LATER question in the same chat inherited that
      // bloat too — explaining the climbing token counts (9K -> 34K -> 49K -> 162K) across unrelated
      // questions in one thread. AskAI.jsx's runTurn uses this flag to skip saving that wreckage into
      // history on a failed turn instead of compounding it forward.
      return{answer,messages,steps,usage,failed:true};
    }
    // Strip empty text blocks before this assistant turn joins the conversation history (2026-08-16,
    // per Mo — reported "messages: text content blocks must be non-empty" from the API after a few
    // rounds of tool calls). streamAnalyze's content_block_start always seeds a text block as
    // {type:"text",text:""} (see that function above) — if the model streams straight into tool_use
    // without ever sending a text_delta for it (common on a tool-only round, no visible preamble),
    // that block stays permanently empty and rides into `messages` unchanged. Anthropic's API
    // accepts an empty text block as the LATEST message in a request, but rejects it once it's
    // replayed back as HISTORY on the next round/turn — exactly what happened here. A text block
    // with nothing in it carries no information anyway, so it's safe to just drop it; the tool_use
    // block(s) in the same turn are untouched.
    const assistantContent=data.content.filter(b=>b.type!=="text"||b.text.length>0);
    messages.push({role:"assistant",content:assistantContent});
    const toolResults=[];
    for(const block of data.content){
      if(block.type!=="tool_use")continue;
      let output;
      try{output=await askAIExecuteTool(block.name,block.input||{},ctx);}
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
    // Same defensive filter as askAIRun above — this loop doesn't go through streamAnalyze (it's a
    // plain non-streaming fetch), so an empty text block is less likely here, but guarding costs
    // nothing and keeps both tool-loops consistent.
    messages.push({role:"assistant",content:(data.content||[]).filter(b=>b.type!=="text"||b.text.length>0)});
    const toolResults=[];
    for(const block of data.content){
      if(block.type!=="tool_use"||block.name==="apply_view")continue;
      let output;
      try{output=await askAIExecuteTool(block.name,block.input||{},ctx);}
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
  const system=`You are writing a short summary for a paid-media budget dashboard called PaidHQ. Below is pre-computed JSON data — it is already correct, do not recompute or second-guess any numbers, just narrate them. Write 3-5 sentences of plain prose (no markdown headers, no bullet lists), citing the real figures. If a list is empty, don't dwell on it. ${focus}`;
  const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({messages:[{role:"user",content:JSON.stringify(payload)}],system,maxTokens:400})});
  const data=await res.json();
  if(!res.ok)throw new Error(data?.error||"Summary request failed");
  return data.text||"(no response)";
}

// Self-contained "✨ AI Summary" trigger + result card, shared by the Budget Panel and Reporting &
// Pacing tabs (see aiSummarizeBudgetPacing above). Owns its own idle/loading/done/error state so
// each tab gets an independent summary rather than sharing one across navigation.
