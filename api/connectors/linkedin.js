/**
 * LinkedIn Marketing API connector
 * Pulls campaign-level spend data via adAnalyticsV2
 *
 * PER-WORKSPACE AUTH (2026-07-22): a workspace connects its OWN LinkedIn ad account via a full
 * OAuth2 flow (api/oauth/linkedin/{start,callback,accounts}.js) rather than pasting anything —
 * LinkedIn access tokens aren't something a user can generate by hand, they only come from
 * completing LinkedIn's own consent screen. credential holds {accessToken, accountId} (see
 * lib/linkedinOAuth.js for the full shape, including refreshToken/expiresAt — spend.js handles
 * refreshing before it ever reaches here). Falls back to the legacy shared env vars when no
 * credential is passed, so Mo's own existing InsightSoftware workspace keeps working without
 * having to go through the OAuth flow itself — only OTHER workspaces are required to connect
 * their own account.
 *
 * Legacy shared env vars (fallback only):
 *   LINKEDIN_ACCESS_TOKEN
 *   LINKEDIN_ACCOUNT_ID
 */

const BASE = "https://api.linkedin.com/v2";

const analyticsHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const restHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "LinkedIn-Version": "202503",
  "X-Restli-Protocol-Version": "2.0.0",
});

// Resolve campaign names + their parent campaignGroup URN individually by ID — bulk fetch not
// supported on Advertising API tier. Note: LinkedIn's "Campaign" object is BudgetHQ's leaf-level
// campaign_name (equivalent to an ad set/ad group on other platforms); LinkedIn's "Campaign Group"
// is BudgetHQ's campaign_group_name (equivalent to what other platforms simply call "Campaign").
async function resolveCampaignNames(token, urns) {
  const campaigns = {};
  const batches = [];
  for (let i = 0; i < urns.length; i += 20) batches.push(urns.slice(i, i + 20));

  for (const batch of batches) {
    await Promise.all(batch.map(async (urn) => {
      const id = urn.split(":").pop();
      try {
        const res = await fetch(`${BASE}/adCampaignsV2/${id}`, { headers: restHeaders(token) });
        if (res.ok) {
          const data = await res.json();
          campaigns[urn] = {
            id: String(id),
            name: data.name || `Campaign ${id}`,
            groupUrn: data.campaignGroup || null,
          };
        } else {
          campaigns[urn] = { id: String(id), name: `Campaign ${id}`, groupUrn: null };
        }
      } catch {
        campaigns[urn] = { id: String(id), name: `Campaign ${id}`, groupUrn: null };
      }
    }));
  }
  return campaigns;
}

// Resolve campaign group names individually by ID (mirrors resolveCampaignNames' batching).
async function resolveCampaignGroupNames(token, urns) {
  const groups = {};
  const batches = [];
  for (let i = 0; i < urns.length; i += 20) batches.push(urns.slice(i, i + 20));

  for (const batch of batches) {
    await Promise.all(batch.map(async (urn) => {
      const id = urn.split(":").pop();
      try {
        const res = await fetch(`${BASE}/adCampaignGroupsV2/${id}`, { headers: restHeaders(token) });
        if (res.ok) {
          const data = await res.json();
          groups[urn] = data.name || `Campaign Group ${id}`;
        } else {
          groups[urn] = `Campaign Group ${id}`;
        }
      } catch {
        groups[urn] = `Campaign Group ${id}`;
      }
    }));
  }
  return groups;
}

async function fetchAnalytics(token, accountId, startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);

  // timeGranularity=DAILY (found 2026-07, was MONTHLY): MONTHLY collapses an entire month's spend
  // into ONE row per campaign, dated to the 1st of that month (see the date-mapping fix below) —
  // BudgetHQ's pacing engine (computePlatformFreshness/computePacing in src/BudgetHQ.jsx) assumes
  // "live-synced" platforms like LinkedIn report true day-by-day data and derives each platform's
  // projection off the most recent date it actually has spend for. With MONTHLY granularity, the
  // current month's row is always dated the 1st, so freshness "as of" the 1st plus a large lump
  // sum reads as one day's spend, wildly overstating the projected total for the rest of the month
  // (same failure mode Google/Bing's manual monthly CSV exports hit, just baked into the live sync
  // instead). DAILY returns one row per campaign per real day, which is what the pacing math
  // actually needs and removes the need for any as-of override for this platform.
  const url =
    `${BASE}/adAnalyticsV2` +
    `?q=analytics` +
    `&pivot=CAMPAIGN` +
    `&dateRange.start.year=${s.getFullYear()}` +
    `&dateRange.start.month=${s.getMonth() + 1}` +
    `&dateRange.start.day=${s.getDate()}` +
    `&dateRange.end.year=${e.getFullYear()}` +
    `&dateRange.end.month=${e.getMonth() + 1}` +
    `&dateRange.end.day=${e.getDate()}` +
    `&timeGranularity=DAILY` +
    `&accounts[0]=urn:li:sponsoredAccount:${accountId}` +
    `&fields=dateRange,pivotValues,costInLocalCurrency,impressions,clicks`;

  const res = await fetch(url, { headers: analyticsHeaders(token) });
  if (!res.ok) throw new Error(`LinkedIn analytics API ${res.status}: ${await res.text()}`);
  return (await res.json()).elements || [];
}

export async function getSpend({ startDate, endDate, credential }) {
  const token = credential?.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
  const accountId = credential?.accountId || process.env.LINKEDIN_ACCOUNT_ID;
  if (!token) throw new Error("This workspace hasn't connected LinkedIn yet — reconnect this workspace's LinkedIn account.");
  if (!accountId) {
    throw new Error(
      credential
        ? "No LinkedIn ad account selected yet for this workspace — pick one to finish connecting."
        : "LINKEDIN_ACCOUNT_ID not set"
    );
  }

  const analytics = await fetchAnalytics(token, accountId, startDate, endDate);
  const withSpend = analytics.filter((el) => parseFloat(el.costInLocalCurrency || "0") > 0);

  // Resolve campaign names from URNs, then their parent campaign group names
  const urns = [...new Set(withSpend.map((el) => (el.pivotValues || [])[0]).filter(Boolean))];
  const campaigns = await resolveCampaignNames(token, urns);

  const groupUrns = [...new Set(Object.values(campaigns).map((c) => c.groupUrn).filter(Boolean))];
  const groups = groupUrns.length ? await resolveCampaignGroupNames(token, groupUrns) : {};

  return withSpend
    .map((el) => {
      const urn = (el.pivotValues || [])[0];
      const c = campaigns[urn] || { id: urn?.split(":").pop() || "unknown", name: urn || "Unknown", groupUrn: null };
      const dr = el.dateRange?.start;
      return {
        campaign_group_name: (c.groupUrn && groups[c.groupUrn]) || c.name,
        campaign_name: c.name,
        campaign_id: c.id,
        platform: "LinkedIn",
        date: dr ? `${dr.year}-${String(dr.month).padStart(2, "0")}-${String(dr.day || 1).padStart(2, "0")}` : null,
        spend: Math.round(parseFloat(el.costInLocalCurrency) * 100) / 100,
        impressions: el.impressions || 0,
        clicks: el.clicks || 0,
      };
    })
    .filter((r) => r.date);
}

export const meta = {
  platform: "LinkedIn",
  label: "LinkedIn Ads",
  status: "live",
  perWorkspaceAuth: true,
  envVarFallback: true, // see spend.js's doc comment — falls back to LINKEDIN_ACCESS_TOKEN if unconnected
  oauth: true, // no connectFields form — frontend renders a "Connect with LinkedIn" button instead
  requiredEnvVars: ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_ACCOUNT_ID"],
};
