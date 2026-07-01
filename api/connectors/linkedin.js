/**
 * LinkedIn Marketing API connector
 * Pulls campaign-level spend data via adAnalyticsV2
 *
 * Env vars required:
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

// Resolve campaign names by fetching each URN individually
async function resolveCampaignNames(token, urns) {
  const campaigns = {};
  // Batch in groups of 20 to avoid rate limits
  const batches = [];
  for (let i = 0; i < urns.length; i += 20) batches.push(urns.slice(i, i + 20));

  for (const batch of batches) {
    await Promise.all(batch.map(async (urn) => {
      const id = urn.split(":").pop();
      try {
        const res = await fetch(`${BASE}/adCampaignsV2/${id}`, { headers: restHeaders(token) });
        if (res.ok) {
          const data = await res.json();
          campaigns[urn] = { id: String(id), name: data.name || `Campaign ${id}` };
        } else {
          campaigns[urn] = { id: String(id), name: `Campaign ${id}` };
        }
      } catch {
        campaigns[urn] = { id: String(id), name: `Campaign ${id}` };
      }
    }));
  }
  return campaigns;
}

async function fetchAnalytics(token, accountId, startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);
  const accountUrn = `urn:li:sponsoredAccount:${accountId}`;

  const params = new URLSearchParams({
    q: "analytics",
    pivot: "CAMPAIGN",
    "dateRange.start.year": s.getFullYear(),
    "dateRange.start.month": s.getMonth() + 1,
    "dateRange.start.day": s.getDate(),
    "dateRange.end.year": e.getFullYear(),
    "dateRange.end.month": e.getMonth() + 1,
    "dateRange.end.day": e.getDate(),
    timeGranularity: "MONTHLY",
    fields: "dateRange,pivotValues,costInLocalCurrency,impressions,clicks",
  }).toString();

  // accounts List() must not be URL-encoded
  const url = `${BASE}/adAnalyticsV2?${params}&accounts=List(${accountUrn})`;
  const res = await fetch(url, { headers: analyticsHeaders(token) });
  if (!res.ok) throw new Error(`LinkedIn analytics API ${res.status}: ${await res.text()}`);
  return (await res.json()).elements || [];
}

export async function getSpend({ startDate, endDate }) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const accountId = process.env.LINKEDIN_ACCOUNT_ID;
  if (!token) throw new Error("LINKEDIN_ACCESS_TOKEN not set");
  if (!accountId) throw new Error("LINKEDIN_ACCOUNT_ID not set");

  // First get analytics
  const analytics = await fetchAnalytics(token, accountId, startDate, endDate);
  const withSpend = analytics.filter((el) => parseFloat(el.costInLocalCurrency || "0") > 0);

  // Extract unique campaign URNs and resolve names
  const urns = [...new Set(withSpend.map((el) => (el.pivotValues || [])[0]).filter(Boolean))];
  const campaigns = await resolveCampaignNames(token, urns);

  return withSpend
    .map((el) => {
      const urn = (el.pivotValues || [])[0];
      const c = campaigns[urn] || { id: urn?.split(":").pop() || "unknown", name: urn || "Unknown" };
      const dr = el.dateRange?.start;
      return {
        campaign_name: c.name,
        campaign_id: c.id,
        platform: "LinkedIn",
        date: dr ? `${dr.year}-${String(dr.month).padStart(2, "0")}-01` : null,
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
  requiredEnvVars: ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_ACCOUNT_ID"],
};
