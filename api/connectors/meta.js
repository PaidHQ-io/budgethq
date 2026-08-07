/**
 * Meta Marketing API connector
 * Pulls ad-set-level spend data via the Insights endpoint
 *
 * PER-WORKSPACE AUTH (2026-07-24): a workspace connects its OWN Meta ad account via a full OAuth2
 * flow (api/oauth/meta/{start,callback,accounts}.js), same shape as LinkedIn/Bing — see
 * lib/metaOAuth.js for the full credential shape and its doc comment for why Meta's token model
 * (extend a long-lived token, no refresh_token grant) needed its own implementation rather than
 * reusing linkedinOAuth.js/bingOAuth.js's refresh logic. No env-var fallback for an unconnected
 * workspace (unlike linkedin/capterra) — every workspace, including Mo's own, connects through the
 * same Connect button.
 *
 * Meta's hierarchy is Campaign > Ad Set > Ad. PaidHQ's two-level model (campaign_group_name /
 * campaign_name) maps Campaign -> campaign_group_name and Ad Set -> campaign_name, the same
 * correspondence LinkedIn's connector uses (LinkedIn Campaign Group -> Campaign).
 *
 * AD-LEVEL PULL (2026-08-19, per Mo — bringing ad-level granularity into paid social so ads can be
 * tagged by dimension, not just campaigns/ad sets): level=ad instead of level=adset, with
 * ad_name/ad_id added to fields. Unlike LinkedIn, Meta's Insights endpoint returns every requested
 * breakdown field (campaign, ad set, AND ad) together on the same row per ad per day — no extra
 * per-ID resolution calls needed, since Meta already resolves names server-side for whatever level
 * you request. campaign_group_name/campaign_name keep mapping to Campaign/Ad Set exactly as
 * before; ad_name/ad_id are new, additive fields (see spendRowsColumns.js's doc comment for the
 * shared core.spend_rows columns both this and linkedin.js now populate).
 */

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function fetchInsightsPage(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    const err = data?.error || {};
    throw new Error(err.code === 190
      ? "Meta access token is invalid or expired — reconnect this workspace's Meta account."
      : `Meta Insights API error (${err.code ?? res.status}): ${err.message || "unknown error"}`);
  }
  return data;
}

// Meta paginates Insights results (default/max page size well under what a busy account can
// return for a multi-month range) — paging.next is a complete, ready-to-fetch URL for the next
// page, or absent once there isn't one. Capped at 50 pages (12,500 rows at limit=250) as a runaway
// guard against an unbounded loop if Meta's paging ever misbehaves; a real account pulling that
// much daily ad-set-level data in one sync window would need windowing at the call-site anyway.
async function fetchAllInsights(firstUrl) {
  const rows = [];
  let url = firstUrl;
  let pages = 0;
  while (url && pages < 50) {
    const page = await fetchInsightsPage(url);
    rows.push(...(page.data || []));
    url = page.paging?.next || null;
    pages++;
  }
  return rows;
}

// Campaign objective (2026-08-07, mirrored from paidhq-core's identical copy — see that repo's
// meta.js for the fuller doc comment). Insights doesn't return objective directly (it's a Campaign-
// node property, not a metric), so this is its own per-campaign fetch, cached module-level same as
// linkedin.js's nameCache.
const objectiveCache = new Map();
async function resolveCampaignObjectives(token, campaignIds) {
  const result = {};
  const uncached = [];
  for (const id of campaignIds) {
    if (objectiveCache.has(id)) result[id] = objectiveCache.get(id);
    else uncached.push(id);
  }
  const batches = [];
  for (let i = 0; i < uncached.length; i += 20) batches.push(uncached.slice(i, i + 20));
  for (const batch of batches) {
    await Promise.all(batch.map(async (id) => {
      let objective = null;
      try {
        const res = await fetch(`${GRAPH_BASE}/${id}?fields=objective&access_token=${token}`);
        const data = await res.json().catch(() => null);
        if (res.ok) objective = data?.objective || null;
      } catch {
        objective = null;
      }
      objectiveCache.set(id, objective);
      result[id] = objective;
    }));
  }
  return result;
}

export async function getSpend({ startDate, endDate, credential }) {
  const token = credential?.accessToken;
  const accountId = credential?.accountId;
  if (!token) throw new Error("This workspace hasn't connected Meta yet — connect this workspace's Meta account.");
  if (!accountId) throw new Error("No Meta ad account selected yet for this workspace — pick one to finish connecting.");

  // level=ad + time_increment=1: one row per AD per real calendar day, not a range total —
  // PaidHQ's pacing engine (computePlatformFreshness/computePacing in src/PaidHQ.jsx) assumes
  // "live-synced" platforms report true day-by-day data and derives each platform's projection off
  // the most recent date it actually has spend for. A range-total or monthly-grain response here
  // would hit the exact same overstated-projection bug LinkedIn's connector already documents
  // having fixed (see linkedin.js's fetchAnalytics doc comment) — time_increment=1 avoids it from
  // the start rather than needing the same fix applied twice. Was level=adset before the 2026-08-19
  // ad-level pull — bumping the level (not just adding fields) is what actually returns one row per
  // ad instead of one row per ad set with ad_name/ad_id blank.
  const params = new URLSearchParams({
    access_token: token,
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify({ since: startDate, until: endDate }),
    fields: "campaign_name,campaign_id,adset_name,adset_id,ad_name,ad_id,spend,impressions,clicks,date_start",
    limit: "250",
  });
  const firstUrl = `${GRAPH_BASE}/${accountId}/insights?${params.toString()}`;

  const raw = await fetchAllInsights(firstUrl);

  const uniqueCampaignIds = [...new Set(raw.map((r) => r.campaign_id).filter(Boolean))];
  const objectives = uniqueCampaignIds.length ? await resolveCampaignObjectives(token, uniqueCampaignIds) : {};

  return raw
    .map((r) => ({
      campaign_group_name: r.campaign_name || `Campaign ${r.campaign_id}`,
      campaign_name: r.adset_name || `Ad Set ${r.adset_id}`,
      campaign_id: r.adset_id || r.campaign_id,
      ad_name: r.ad_name || (r.ad_id ? `Ad ${r.ad_id}` : null),
      ad_id: r.ad_id || null,
      platform: "Meta",
      date: r.date_start || null,
      spend: Math.round(parseFloat(r.spend || "0") * 100) / 100,
      impressions: parseInt(r.impressions || "0", 10) || 0,
      clicks: parseInt(r.clicks || "0", 10) || 0,
      extra_metrics: { objective: objectives[r.campaign_id] || undefined },
    }))
    .filter((r) => r.date && r.spend > 0);
}

// Reach & frequency (2026-08-07, mirrored from paidhq-core's identical copy — see that repo's
// meta.js for the fuller doc comment). Deliberately NOT synced into spend_rows — see
// linkedin.js's getReachMetrics doc comment for why. Meta's Insights API returns true period reach
// AND frequency directly when time_increment is omitted (one row per ad for the whole range).
export async function getReachMetrics({ startDate, endDate, credential }) {
  const token = credential?.accessToken;
  const accountId = credential?.accountId;
  if (!token || !accountId) return {};

  const params = new URLSearchParams({
    access_token: token,
    level: "ad",
    time_range: JSON.stringify({ since: startDate, until: endDate }),
    fields: "ad_id,reach,frequency",
    limit: "250",
  });
  const firstUrl = `${GRAPH_BASE}/${accountId}/insights?${params.toString()}`;
  const raw = await fetchAllInsights(firstUrl);

  const out = {};
  for (const r of raw) {
    if (!r.ad_id) continue;
    out[r.ad_id] = {
      reach: parseInt(r.reach || "0", 10) || 0,
      frequency: r.frequency != null ? Math.round(parseFloat(r.frequency) * 100) / 100 : null,
    };
  }
  return out;
}

export const meta = {
  platform: "Meta",
  label: "Meta Ads",
  icon: "M",
  status: "live",
  perWorkspaceAuth: true,
  oauth: true, // no connectFields form — frontend renders a "Connect with Meta" button instead
  requiredEnvVars: ["META_CLIENT_ID", "META_CLIENT_SECRET", "META_REDIRECT_URI"],
};
