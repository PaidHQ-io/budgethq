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

async function fetchAllCampaigns(token, accountId) {
  const campaigns = {};
  let start = 0;
  const count = 100;
  while (true) {
    const url =
      `${BASE}/adCampaignsV2?q=search` +
      `&search.account.values[0]=urn%3Ali%3AsponsoredAccount%3A${accountId}` +
      `&start=${start}&count=${count}&fields=id,name,status`;
    const res = await fetch(url, { headers: restHeaders(token) });
    if (!res.ok) throw new Error(`LinkedIn campaigns API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const elements = data.elements || [];
    elements.forEach((c) => {
      campaigns[`urn:li:sponsoredCampaign:${c.id}`] = { id: String(c.id), name: c.name || String(c.id) };
    });
    if (elements.length < count) break;
    start += count;
  }
  return campaigns;
}

async function fetchAnalytics(token, accountId, startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);

  // accounts param must use unencoded URN in List() notation
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

  // accounts param must NOT be encoded by URLSearchParams — append raw
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

  const [campaigns, analytics] = await Promise.all([
    fetchAllCampaigns(token, accountId),
    fetchAnalytics(token, accountId, startDate, endDate),
  ]);

  return analytics
    .filter((el) => parseFloat(el.costInLocalCurrency || "0") > 0)
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
