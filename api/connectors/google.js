/**
 * Google Ads connector — GAQL (Google Ads Query Language) via the REST search endpoint
 *
 * PER-WORKSPACE AUTH (2026-07-25): a workspace connects its OWN Google Ads account via a full
 * OAuth2 flow (api/oauth/google/{start,callback,accounts}.js), same shape as LinkedIn/Bing/Meta —
 * see lib/googleAdsOAuth.js for the full credential shape, the developer-token prerequisite (a
 * single BudgetHQ-wide GOOGLE_ADS_DEVELOPER_TOKEN env var, not stored per workspace — same pattern
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
 * Google Ads' hierarchy is Campaign > Ad Group > Ad. BudgetHQ's two-level model
 * (campaign_group_name / campaign_name) maps Campaign -> campaign_group_name and Ad Group ->
 * campaign_name — same correspondence LinkedIn (Campaign Group -> Campaign) and Bing (Campaign ->
 * Ad Group) use, see connectors/linkedin.js's doc comment for that taxonomy note.
 */
import { adsApiSearchAll } from "../lib/googleAdsOAuth.js";

// ad_group (not campaign or ad_group_ad) — one row per ad group per real calendar day via
// segments.date, not a range total. Same reasoning as Meta's time_increment=1: BudgetHQ's pacing
// engine (computePlatformFreshness/computePacing) assumes "live-synced" platforms report true
// day-by-day data and derives each platform's projection off the most recent date it actually has
// spend for — a range-total response here would hit the same overstated-projection bug LinkedIn's
// connector already documents having fixed.
function buildQuery(startDate, endDate) {
  return `
    SELECT
      campaign.id, campaign.name,
      ad_group.id, ad_group.name,
      segments.date,
      metrics.cost_micros, metrics.impressions, metrics.clicks
    FROM ad_group
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
  `.trim();
}

export async function getSpend({ startDate, endDate, credential }) {
  if (!credential?.accessToken) throw new Error("This workspace hasn't connected Google Ads yet.");
  if (!credential?.accountId) throw new Error("No Google Ads account selected yet for this workspace — pick one to finish connecting.");

  const query = buildQuery(startDate, endDate);
  const raw = await adsApiSearchAll(credential.accountId, query, {
    accessToken: credential.accessToken,
    // Only set when the connected Google user reaches this account through a manager (MCC) account
    // rather than being a direct user on it — see api/oauth/google/accounts.js's doc comment for
    // when/why this gets populated (the manual Customer ID fallback's optional second field).
    // Google Ads API returns PERMISSION_DENIED for the child account without it in that case, even
    // though the user genuinely can see the account inside the Google Ads UI itself.
    loginCustomerId: credential.loginCustomerId || undefined,
  });

  // costMicros comes back as a string (Google's REST JSON encodes int64 fields as strings to avoid
  // JS/other clients' float precision loss) — divide by 1,000,000 per Google's documented "micros"
  // convention (same unit Search Ads 360/other Google Ads-adjacent APIs use).
  return raw
    .map((r) => {
      const spend = Math.round((parseInt(r.metrics?.costMicros || "0", 10) / 1e6) * 100) / 100;
      const date = r.segments?.date || null;
      if (!date || spend <= 0) return null;
      return {
        campaign_group_name: r.campaign?.name || `Campaign ${r.campaign?.id || ""}`.trim(),
        campaign_name: r.adGroup?.name || `Ad Group ${r.adGroup?.id || ""}`.trim(),
        campaign_id: String(r.adGroup?.id || r.campaign?.id || ""),
        platform: "Google",
        date,
        spend,
        impressions: parseInt(r.metrics?.impressions || "0", 10) || 0,
        clicks: parseInt(r.metrics?.clicks || "0", 10) || 0,
      };
    })
    .filter(Boolean);
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
