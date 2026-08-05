/**
 * Google Ads connector — GAQL (Google Ads Query Language) via the REST search endpoint
 *
 * PER-WORKSPACE AUTH (2026-07-25): a workspace connects its OWN Google Ads account via a full
 * OAuth2 flow (api/oauth/google/{start,callback,accounts}.js), same shape as LinkedIn/Bing/Meta —
 * see lib/googleAdsOAuth.js for the full credential shape, the developer-token prerequisite (a
 * single PaidHQ-wide GOOGLE_ADS_DEVELOPER_TOKEN env var, not stored per workspace — same pattern
 * as BING_DEVELOPER_TOKEN), and its doc comment's SETUP REQUIRED section for what still needs to
 * happen in Google Cloud / Google Ads before this can run against a real account at all. Replaces
 * the old CSV-only stub (pre-per-workspace-OAuth-era, single shared env-var credential) — no env-
 * var fallback for an unconnected workspace, same as Bing/Meta.
 *
 * IMPLEMENTATION CONFIDENCE NOTE — same caveat as lib/googleAdsOAuth.js: built from Google's
 * published REST reference (developers.google.com/google-ads/api/rest/reference/rest), NOT yet
 * live-tested against a real account, because the developer token application that's a prerequisite
 * for ANY real API call hadn't been submitted as of this writing (2026-07-25). Treat every request/
 * response shape below as unverified until a real sync is attempted — see the Bing connector's own
 * doc comment for the class of nested-field-order/shape landmine to watch for once that happens.
 *
 * Google Ads' hierarchy is Campaign > Ad Group > Ad. PaidHQ's two-level model
 * (campaign_group_name / campaign_name) maps Campaign -> campaign_group_name and Ad Group ->
 * campaign_name — same correspondence LinkedIn (Campaign Group -> Campaign) and Bing (Campaign ->
 * Ad Group) use, see connectors/linkedin.js's doc comment for that taxonomy note.
 *
 * PERFORMANCE MAX (2026-07-27, per Mo — building PMax-specific tests): Performance Max campaigns
 * are asset-based, not ad-group-based — they have NO ad_group rows at all, so the ad_group query
 * below silently returns zero spend for them (no error, they just never show up). Fixed by running
 * a SECOND query against the asset_group resource, which is PMax's structural equivalent of an ad
 * group, explicitly filtered to campaign.advertising_channel_type = 'PERFORMANCE_MAX' so it can't
 * double-count anything the ad_group query already covers for other channel types. Together the two
 * queries now cover Search, Display, Video, Shopping, Demand Gen (all ad_group-based) and
 * Performance Max (asset_group-based). Still NOT covered: App, Local, and Smart campaigns — those
 * are fully automated/closed campaign types with no per-ad-group or per-asset-group cost breakdown
 * resource in the Google Ads API at all, so there's no query that would surface them short of
 * campaign-level-only totals (a different, coarser resource than either query here).
 *
 * WIDENED FIELD SET (2026-08-03, per Mo — "pull in all of the data that will not increase the row
 * count, just the data per row, for both google and bing"): both queries below now also pull
 * conversions/conversion value, average CPC, CTR, campaign/ad-group status, and bidding strategy —
 * all plain metric/attribute fields, so grain is unchanged (still one row per ad group per day).
 * The ad_group (Search-eligible) query additionally pulls the search-impression-share family, which
 * doesn't apply to PMax's asset_group resource so it's omitted from buildAssetGroupQuery. These new
 * values land in mapRow's returned `extra_metrics` object (see below), NOT as new top-level spend/
 * impressions/clicks-style fields — same "flexible bag, not a schema migration per metric" approach
 * already used for core.ai_chats/core.reporting_column_views (see spendRowsColumns.js's toColumns
 * for where extra_metrics gets written to core.spend_rows).
 *
 * CONFIDENCE NOTE on the new fields: metrics.conversions/.conversions_value/.all_conversions/
 * .all_conversions_value/.average_cpc/.ctr and campaign.status/.advertising_channel_type/
 * .bidding_strategy_type and ad_group.status/asset_group.status are all long-stable, well-documented
 * GAQL fields — high confidence. The search-impression-share family (search_impression_share,
 * search_top_impression_share, search_absolute_top_impression_share, search_rank_lost_impression_
 * share, search_rank_lost_top_impression_share, search_rank_lost_absolute_top_impression_share) is
 * lower confidence — Google's docs split "lost to rank" vs "lost to budget" as separate metrics and
 * the exact field-name split used below hasn't been checked against a live account (still no
 * developer token as of this writing, same blocker the rest of this file's confidence notes
 * describe). If the very first live sync throws an UNRECOGNIZED_FIELD/INVALID_QUERY fault, start by
 * removing the search-impression-share lines one at a time to isolate which name is wrong before
 * assuming a different bug class — everything else in this query is the well-documented tier.
 *
 * DDMQL (2026-08-03, per Mo — validated as "close enough to work with" as a directional ad-group
 * signal, unlike DDSQL/DD Pipeline which were found to diverge from PowerBI by 3-4x — see that
 * conversation for the full reconciliation investigation). metrics.conversions/.all_conversions
 * above are BLENDED totals across every conversion action the account counts as a conversion — they
 * do NOT isolate DDMQL specifically. Getting one named conversion action's own number requires
 * segmenting by segments.conversion_action_name, which — if selected in the main query above — would
 * multiply row grain to one row per ad group per day per conversion action, breaking the "won't
 * increase row count" requirement this whole round of connector changes was scoped to. Fixed instead
 * by running a THIRD, separate query (buildDdmqlQuery) that both selects AND filters on
 * segments.conversion_action_name — safe, ordinary GAQL segment usage, unlike the WHERE-only-without-
 * SELECT filtering some advertisers use to avoid segmenting (deliberately NOT used here since that
 * behavior isn't something this file's author could verify without a live account) — then merges its
 * per-(campaign, ad group, date) value into the SAME row buildQuery()'s results already produce, via
 * ddmqlByKey (see getSpend below). Net effect: an extra API query, but zero extra stored rows.
 *
 * DDMQL_CONVERSION_ACTION_NAME is hardcoded to Mo's own account's conversion action name — this is
 * workspace-specific, not something every PaidHQ workspace would share, so it'll need to become a
 * per-workspace config value (e.g. a Settings field: "which conversion action represents your MQL
 * signal") the moment a second workspace wants this. Not built that way yet since only one workspace
 * uses this today. If the name is ever renamed in Google Ads, this silently returns zero DDMQL rows
 * rather than erroring — worth spot-checking after any Google Ads conversion-action rename.
 *
 * Scoped to the ad_group (Search-eligible) query only, not PMax's asset_group — DDMQL activity on
 * PMax campaigns, if any, isn't captured here yet (known gap, not verified either way).
 */
import { adsApiSearchAll } from "../lib/googleAdsOAuth.js";

// See DDMQL doc note up top for why this is hardcoded and what needs to change to support a second
// workspace.
const DDMQL_CONVERSION_ACTION_NAME = "DDMQL";

// ad_group (not campaign or ad_group_ad) — one row per ad group per real calendar day via
// segments.date, not a range total. Same reasoning as Meta's time_increment=1: PaidHQ's pacing
// engine (computePlatformFreshness/computePacing) assumes "live-synced" platforms report true
// day-by-day data and derives each platform's projection off the most recent date it actually has
// spend for — a range-total response here would hit the same overstated-projection bug LinkedIn's
// connector already documents having fixed.
function buildQuery(startDate, endDate) {
  return `
    SELECT
      campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      ad_group.id, ad_group.name, ad_group.status,
      segments.date,
      metrics.cost_micros, metrics.impressions, metrics.clicks,
      metrics.conversions, metrics.conversions_value, metrics.all_conversions,
      metrics.all_conversions_value, metrics.average_cpc, metrics.ctr,
      metrics.search_impression_share, metrics.search_top_impression_share,
      metrics.search_absolute_top_impression_share, metrics.search_rank_lost_impression_share,
      metrics.search_rank_lost_top_impression_share,
      metrics.search_rank_lost_absolute_top_impression_share
    FROM ad_group
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
  `.trim();
}

// Performance Max's equivalent of the query above — same shape, but asset_group instead of
// ad_group (see PERFORMANCE MAX doc note up top). The advertising_channel_type filter is what
// keeps this from ever overlapping with buildQuery()'s results. No search-impression-share fields
// here — that metric family is Search-network-specific and doesn't apply to PMax's asset_group
// resource (see WIDENED FIELD SET note up top).
// average_cpc/ctr REMOVED (2026-08-05, mirrored from paidhq-core's identical copy — see that
// file's fuller doc comment): threw Google Ads API error (INVALID_ARGUMENT) on Mo's first live
// sync — average_cpc/ctr are click-based/search-context metrics not selectable on the asset_group
// resource (Performance Max doesn't use traditional CPC bidding). buildQuery()'s ad_group query
// still pulls both fine for every other campaign type.
function buildAssetGroupQuery(startDate, endDate) {
  return `
    SELECT
      campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type,
      asset_group.id, asset_group.name, asset_group.status,
      segments.date,
      metrics.cost_micros, metrics.impressions, metrics.clicks,
      metrics.conversions, metrics.conversions_value, metrics.all_conversions,
      metrics.all_conversions_value
    FROM asset_group
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
  `.trim();
}

// DDMQL-specific query — see DDMQL doc note up top. Selecting AND filtering on
// segments.conversion_action_name together is ordinary, well-documented GAQL segment usage (unlike
// filtering on it alone without selecting it, which this file's author couldn't verify without a
// live account and so deliberately avoided) — the query below returns one row per (ad group, date)
// where DDMQL actually fired, segmented by conversion_action_name, which getSpend() below reduces
// back down to a per-(campaign, ad group, date) lookup before merging into buildQuery()'s rows.
function buildDdmqlQuery(startDate, endDate) {
  return `
    SELECT
      campaign.id, ad_group.id,
      segments.date, segments.conversion_action_name,
      metrics.all_conversions
    FROM ad_group
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND segments.conversion_action_name = '${DDMQL_CONVERSION_ACTION_NAME}'
  `.trim();
}

// campaignId/adGroupId/date -> summed DDMQL value. Summed rather than assigned directly in case
// Google ever returns more than one row per key for a single named conversion action (shouldn't
// happen given the exact-name filter above, but summing degrades safely instead of silently
// dropping data if it ever does).
export function buildDdmqlLookup(rows) {
  const map = new Map();
  for (const r of rows) {
    const n = Number(r.metrics?.allConversions);
    if (!Number.isFinite(n)) continue;
    const key = `${r.campaign?.id || ""}|${r.adGroup?.id || ""}|${r.segments?.date || ""}`;
    map.set(key, (map.get(key) || 0) + n);
  }
  return map;
}

// Builds the extra_metrics bag from a GAQL row's metrics/campaign/child fields — only includes a
// key when the API actually returned something for it, same "drop rather than fabricate" rule
// roundPipelineMetrics (src/lib/askAI.js) already uses, so a field Google didn't return (e.g. an
// impression-share metric with no eligible auctions that day) doesn't show up as a misleading 0.
// Micros fields (average_cpc) get the same /1e6 treatment as cost_micros in mapRow below; ratio
// fields (ctr, conversions counts/values, impression-share fractions) are used as-is.
export function buildExtraMetrics(r, child, ddmql) {
  const m = r.metrics || {};
  const out = {};
  const put = (key, raw, transform = (x) => x) => {
    if (raw === undefined || raw === null) return;
    const n = transform(Number(raw));
    if (Number.isFinite(n)) out[key] = Math.round(n * 10000) / 10000;
  };
  put("ddmql", ddmql);
  put("conversions", m.conversions);
  put("conversions_value", m.conversionsValue);
  put("all_conversions", m.allConversions);
  put("all_conversions_value", m.allConversionsValue);
  put("average_cpc", m.averageCpc, (x) => x / 1e6);
  put("ctr", m.ctr);
  put("search_impression_share", m.searchImpressionShare);
  put("search_top_impression_share", m.searchTopImpressionShare);
  put("search_absolute_top_impression_share", m.searchAbsoluteTopImpressionShare);
  put("search_rank_lost_impression_share", m.searchRankLostImpressionShare);
  put("search_rank_lost_top_impression_share", m.searchRankLostTopImpressionShare);
  put("search_rank_lost_absolute_top_impression_share", m.searchRankLostAbsoluteTopImpressionShare);
  if (r.campaign?.status) out.campaign_status = r.campaign.status;
  if (r.campaign?.advertisingChannelType) out.advertising_channel_type = r.campaign.advertisingChannelType;
  if (r.campaign?.biddingStrategyType) out.bidding_strategy_type = r.campaign.biddingStrategyType;
  if (child?.status) out.ad_group_status = child.status;
  return out;
}

// costMicros comes back as a string (Google's REST JSON encodes int64 fields as strings to avoid
// JS/other clients' float precision loss) — divide by 1,000,000 per Google's documented "micros"
// convention (same unit Search Ads 360/other Google Ads-adjacent APIs use). `child` is whichever of
// r.adGroup/r.assetGroup this row came from — the thing that plays Ad Group's role as PaidHQ's
// second grouping level (see the two-level-model doc note up top).
function mapRow(r, child, ddmqlByKey) {
  const spend = Math.round((parseInt(r.metrics?.costMicros || "0", 10) / 1e6) * 100) / 100;
  const date = r.segments?.date || null;
  if (!date || spend <= 0) return null;
  const ddmqlKey = `${r.campaign?.id || ""}|${child?.id || ""}|${date}`;
  return {
    campaign_group_name: r.campaign?.name || `Campaign ${r.campaign?.id || ""}`.trim(),
    campaign_name: child?.name || `Ad Group ${child?.id || ""}`.trim(),
    campaign_id: String(child?.id || r.campaign?.id || ""),
    platform: "Google",
    date,
    spend,
    impressions: parseInt(r.metrics?.impressions || "0", 10) || 0,
    clicks: parseInt(r.metrics?.clicks || "0", 10) || 0,
    extra_metrics: buildExtraMetrics(r, child, ddmqlByKey?.get(ddmqlKey)),
  };
}

export async function getSpend({ startDate, endDate, credential }) {
  if (!credential?.accessToken) throw new Error("This workspace hasn't connected Google Ads yet.");
  if (!credential?.accountId) throw new Error("No Google Ads account selected yet for this workspace — pick one to finish connecting.");

  const auth = {
    accessToken: credential.accessToken,
    // Only set when the connected Google user reaches this account through a manager (MCC) account
    // rather than being a direct user on it — see api/oauth/google/accounts.js's doc comment for
    // when/why this gets populated (the manual Customer ID fallback's optional second field).
    // Google Ads API returns PERMISSION_DENIED for the child account without it in that case, even
    // though the user genuinely can see the account inside the Google Ads UI itself.
    loginCustomerId: credential.loginCustomerId || undefined,
  };

  const [adGroupRows, assetGroupRows, ddmqlRows] = await Promise.all([
    adsApiSearchAll(credential.accountId, buildQuery(startDate, endDate), auth),
    adsApiSearchAll(credential.accountId, buildAssetGroupQuery(startDate, endDate), auth),
    adsApiSearchAll(credential.accountId, buildDdmqlQuery(startDate, endDate), auth),
  ]);
  const ddmqlByKey = buildDdmqlLookup(ddmqlRows);

  return [
    ...adGroupRows.map((r) => mapRow(r, r.adGroup, ddmqlByKey)),
    ...assetGroupRows.map((r) => mapRow(r, r.assetGroup, null)),
  ].filter(Boolean);
}

// ── CHANGE HISTORY (2026-08-19, per Mo — "automatically pulls in non automated and non bulk edit
// changes from Google, Bing, Meta and LinkedIn and Capterra"). Google Ads is the only one of those
// five with a documented public change-history API (the change_event resource) — Bing/LinkedIn have
// no equivalent public endpoint (hence Change History's manual-entry path, see ChangeHistory.jsx),
// and Capterra isn't an ad-buying platform at all (pay-per-click listing/lead-gen billing, no
// campaigns/budgets to change in the first place).
//
// IMPLEMENTATION CONFIDENCE NOTE (same caveat as the rest of this file — see top doc comment): built
// from Google's published change_event reference (developers.google.com/google-ads/api/fields/
// latest/change_event), NOT yet live-tested against a real account. Specific unverified assumptions,
// flagged individually below: change_date_time's exact string format/timezone, whether campaign.name/
// ad_group.name are actually selectable alongside change_event fields (attributed-resource joins are
// well-documented elsewhere in this file for ad_group/asset_group, but not confirmed specifically for
// change_event), and changed_fields' exact JSON shape (FieldMask — assumed to arrive as either an
// array of path strings or a single comma-joined string; handled defensively either way below).
//
// RETENTION: Google only keeps change_event data for the last 30 days, and a single query's
// change_date_time range can't exceed 30 days — clampChangeEventWindow below enforces both by
// clamping the caller's requested startDate forward to at most 30 days before endDate, rather than
// erroring (a sync job asking for a wider window just silently gets the freshest 30 days instead of
// failing outright).
const CHANGE_EVENT_MAX_LOOKBACK_DAYS = 30;

export function clampChangeEventWindow(startDate, endDate) {
  const end = new Date(`${endDate}T00:00:00Z`);
  const maxStart = new Date(end);
  maxStart.setUTCDate(maxStart.getUTCDate() - (CHANGE_EVENT_MAX_LOOKBACK_DAYS - 1));
  const requestedStart = new Date(`${startDate}T00:00:00Z`);
  const clamped = requestedStart < maxStart ? maxStart : requestedStart;
  return clamped.toISOString().slice(0, 10);
}

// client_type values that represent automated/bulk/programmatic activity rather than a genuine
// one-off human edit — excluded per Mo's own framing ("non automated and non bulk edit changes").
// GOOGLE_ADS_EDITOR is deliberately KEPT (a human using the Editor desktop tool is still a human
// decision, just made in a different client) — same for SEARCH_ADS_360/INTERNAL_TOOL/OTHER/UNKNOWN,
// kept rather than silently dropped so an unrecognized future client_type still surfaces instead of
// vanishing (better to show something filterable than hide data — client_type is stored on every row
// regardless, see buildExtraMetrics-style "store the raw value, filter in the UI" pattern used
// elsewhere in this file).
const CHANGE_EVENT_EXCLUDE_CLIENT_TYPES = new Set([
  "GOOGLE_ADS_AUTOMATED_RULE", "GOOGLE_ADS_BULK_UPLOAD", "GOOGLE_ADS_API",
  "GOOGLE_ADS_SCRIPTS", "GOOGLE_ADS_RECOMMENDATIONS",
]);

// change_resource_type (Google's enum) -> this app's ENTITY_TYPE_OPTIONS vocabulary
// (src/lib/changeEventsApi.js). Falls back to "other" for anything not explicitly mapped so a
// resource type Google adds later doesn't throw, it just shows up as a generic entry. The CRITERION
// check MUST run before the generic CAMPAIGN_/AD_GROUP_ prefix checks below — CAMPAIGN_CRITERION
// would otherwise always match the broader t.startsWith("CAMPAIGN_") branch first and the criterion
// branch would be unreachable dead code.
// Exported (alongside mapChangeType/normalizeChangedFields/mapChangeEventRow below) purely so a
// plain Node sanity script can exercise this file's change_event mapping logic directly against
// fake API response shapes, the same way buildDdmqlLookup/buildExtraMetrics already are above —
// none of these are meant to be called from outside this connector in real app code.
export function mapEntityType(changeResourceType) {
  const t = changeResourceType || "";
  if (t === "AD_GROUP_CRITERION" || t === "CAMPAIGN_CRITERION") return "keyword"; // covers keywords, audiences, and placements alike — GAQL's change_event doesn't expose the criterion's specific sub-type, see doc note above
  if (t === "CAMPAIGN" || t === "CAMPAIGN_BUDGET" || t.startsWith("CAMPAIGN_")) return "campaign";
  if (t === "AD_GROUP" || t.startsWith("AD_GROUP_BID")) return "ad_group";
  if (t === "AD" || t === "AD_GROUP_AD") return "ad";
  return "other";
}

// Best-effort change_type (this app's CHANGE_TYPE_OPTIONS vocabulary) inferred from resource type +
// changed field names — heuristic, not authoritative (Google doesn't classify changes into these
// buckets itself). Order matters: budget/status checks run before the coarser resource-type fallback
// so e.g. a CAMPAIGN_BUDGET resource change is always "budget" even though CAMPAIGN* alone would
// otherwise map to "other".
export function mapChangeType(changeResourceType, changedFields) {
  const t = changeResourceType || "";
  const fields = (changedFields || []).map((f) => String(f).toLowerCase());
  if (t === "CAMPAIGN_BUDGET" || fields.some((f) => f.includes("budget") || f.includes("amount_micros"))) return "budget";
  if (fields.some((f) => f.includes("status"))) return "status";
  if (fields.some((f) => f.includes("bidding") || f.includes("bid_"))) return "bid_strategy";
  if (t === "AD_GROUP_CRITERION" || t === "CAMPAIGN_CRITERION") return "targeting";
  if (t === "AD" || t === "AD_GROUP_AD") return "creative";
  return "other";
}

// changed_fields (a FieldMask) — handled defensively since its exact REST JSON shape isn't confirmed
// (see IMPLEMENTATION CONFIDENCE NOTE above): could arrive as an array of path strings, or a single
// comma-joined string (proto3 FieldMask's standard JSON encoding).
export function normalizeChangedFields(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function buildChangeEventQuery(startDate, endDate) {
  return `
    SELECT
      change_event.resource_name, change_event.change_date_time,
      change_event.change_resource_type, change_event.change_resource_name,
      change_event.client_type, change_event.user_email,
      change_event.resource_change_operation, change_event.changed_fields,
      change_event.old_resource, change_event.new_resource,
      campaign.id, campaign.name, ad_group.id, ad_group.name
    FROM change_event
    WHERE change_event.change_date_time BETWEEN '${startDate}T00:00:00' AND '${endDate}T23:59:59'
    ORDER BY change_event.change_date_time DESC
    LIMIT 10000
  `.trim();
}

// Truncated JSON snapshot of a change_event's old/new sub-resource — genuinely type-specific
// (a CAMPAIGN_BUDGET change's relevant field lives at a different path than an AD_GROUP status
// change's), so rather than guess field paths this file's author can't verify without a live
// account, this stores the raw (truncated) object as-is. Better than a guaranteed-wrong guess;
// worth revisiting with real sync output once this has run against Mo's account at least once.
function snapshotResource(obj) {
  if (!obj || typeof obj !== "object") return null;
  try {
    const s = JSON.stringify(obj);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return null;
  }
}

export function mapChangeEventRow(r) {
  const ce = r.changeEvent || {};
  if (!ce.resourceName || !ce.changeDateTime) return null;
  if (CHANGE_EVENT_EXCLUDE_CLIENT_TYPES.has(ce.clientType)) return null;

  const changedFields = normalizeChangedFields(ce.changedFields);
  const entityType = mapEntityType(ce.changeResourceType);
  const changeType = mapChangeType(ce.changeResourceType, changedFields);
  const entityName = r.adGroup?.name || r.campaign?.name || null;
  const operation = (ce.resourceChangeOperation || "").replace(/_/g, " ").toLowerCase() || "changed";
  const resourceLabel = (ce.changeResourceType || "resource").replace(/_/g, " ").toLowerCase();
  const summary = `${operation.charAt(0).toUpperCase()}${operation.slice(1)} ${resourceLabel}${entityName ? ` — ${entityName}` : ""}`
    + (changedFields.length ? ` (${changedFields.slice(0, 5).join(", ")}${changedFields.length > 5 ? ", …" : ""})` : "");

  return {
    platform: "Google",
    entityType,
    entityName,
    changeType,
    summary,
    details: changedFields.length ? `Changed fields: ${changedFields.join(", ")}` : null,
    oldValue: snapshotResource(ce.oldResource),
    newValue: snapshotResource(ce.newResource),
    changedBy: ce.userEmail || null,
    // UNVERIFIED (see IMPLEMENTATION CONFIDENCE NOTE): change_date_time's documented format is
    // "yyyy-MM-dd HH:mm:ss.ffffff" in the ACCOUNT's own timezone, not UTC — the naive `T`-swap below
    // is treated as UTC, which will be off by the account's UTC offset until this is checked against
    // a real sync. Worth fixing once Mo's account's actual timezone offset is known.
    changedAt: new Date(ce.changeDateTime.replace(" ", "T") + "Z").toISOString(),
    clientType: ce.clientType || null,
    externalChangeId: ce.resourceName,
  };
}

// startDate/endDate: caller's requested window (same shape as getSpend) — clamped to Google's own
// 30-day change_event retention/range limit before querying (see clampChangeEventWindow above).
export async function getChangeEvents({ startDate, endDate, credential }) {
  if (!credential?.accessToken) throw new Error("This workspace hasn't connected Google Ads yet.");
  if (!credential?.accountId) throw new Error("No Google Ads account selected yet for this workspace — pick one to finish connecting.");

  const auth = {
    accessToken: credential.accessToken,
    loginCustomerId: credential.loginCustomerId || undefined,
  };
  const clampedStart = clampChangeEventWindow(startDate, endDate);
  const rows = await adsApiSearchAll(credential.accountId, buildChangeEventQuery(clampedStart, endDate), auth);
  return rows.map(mapChangeEventRow).filter(Boolean);
}

export const meta = {
  platform: "Google",
  label: "Google Ads",
  icon: "G",
  status: "live",
  perWorkspaceAuth: true,
  oauth: true, // no connectFields form — frontend renders a "Connect with Google" button instead
  csvInstructions:
    "Download from Google Ads → Reports → Predefined reports → " +
    "Time → Month. Include: Campaign, Cost, Impressions, Clicks.",
  requiredEnvVars: [
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REDIRECT_URI",
  ],
};
