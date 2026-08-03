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
 */
import { adsApiSearchAll } from "../lib/googleAdsOAuth.js";

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
function buildAssetGroupQuery(startDate, endDate) {
  return `
    SELECT
      campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type,
      asset_group.id, asset_group.name, asset_group.status,
      segments.date,
      metrics.cost_micros, metrics.impressions, metrics.clicks,
      metrics.conversions, metrics.conversions_value, metrics.all_conversions,
      metrics.all_conversions_value, metrics.average_cpc, metrics.ctr
    FROM asset_group
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
  `.trim();
}

// Builds the extra_metrics bag from a GAQL row's metrics/campaign/child fields — only includes a
// key when the API actually returned something for it, same "drop rather than fabricate" rule
// roundPipelineMetrics (src/lib/askAI.js) already uses, so a field Google didn't return (e.g. an
// impression-share metric with no eligible auctions that day) doesn't show up as a misleading 0.
// Micros fields (average_cpc) get the same /1e6 treatment as cost_micros in mapRow below; ratio
// fields (ctr, conversions counts/values, impression-share fractions) are used as-is.
export function buildExtraMetrics(r, child) {
  const m = r.metrics || {};
  const out = {};
  const put = (key, raw, transform = (x) => x) => {
    if (raw === undefined || raw === null) return;
    const n = transform(Number(raw));
    if (Number.isFinite(n)) out[key] = Math.round(n * 10000) / 10000;
  };
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
function mapRow(r, child) {
  const spend = Math.round((parseInt(r.metrics?.costMicros || "0", 10) / 1e6) * 100) / 100;
  const date = r.segments?.date || null;
  if (!date || spend <= 0) return null;
  return {
    campaign_group_name: r.campaign?.name || `Campaign ${r.campaign?.id || ""}`.trim(),
    campaign_name: child?.name || `Ad Group ${child?.id || ""}`.trim(),
    campaign_id: String(child?.id || r.campaign?.id || ""),
    platform: "Google",
    date,
    spend,
    impressions: parseInt(r.metrics?.impressions || "0", 10) || 0,
    clicks: parseInt(r.metrics?.clicks || "0", 10) || 0,
    extra_metrics: buildExtraMetrics(r, child),
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

  const [adGroupRows, assetGroupRows] = await Promise.all([
    adsApiSearchAll(credential.accountId, buildQuery(startDate, endDate), auth),
    adsApiSearchAll(credential.accountId, buildAssetGroupQuery(startDate, endDate), auth),
  ]);

  return [
    ...adGroupRows.map((r) => mapRow(r, r.adGroup)),
    ...assetGroupRows.map((r) => mapRow(r, r.assetGroup)),
  ].filter(Boolean);
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
