/**
 * LinkedIn Marketing API connector
 * Pulls ad (creative)-level spend data via adAnalyticsV2
 *
 * AD-LEVEL PULL (2026-08-19, per Mo — bringing ad-level granularity into paid social so ads can be
 * tagged by dimension, not just campaigns/campaign groups): pivot=CREATIVE (was CAMPAIGN), with a
 * new third resolution level (creative -> campaign -> campaign group) below the pre-existing
 * two-level one. LinkedIn's naming inversion (see the pivot doc note below) means "campaign" here
 * still maps to PaidHQ's campaign_name/campaign_group_name exactly as before — only ad_name/ad_id
 * are new. See spendRowsColumns.js's doc comment for the shared core.spend_rows columns both this
 * and meta.js now populate.
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

// Module-level cache for creative/campaign/campaign-group name resolution, keyed by URN (2026-08-05,
// per Mo — a manual "Sync now" backfill walks the whole configured date range in 7-day chunks
// (syncPlatform's SYNC_CHUNK_DAYS in PaidHQ.jsx), and getSpend below was re-resolving every
// creative/campaign/campaign-group name FROM SCRATCH on every single chunk, since LinkedIn's
// Advertising API has no bulk-lookup endpoint — one REST call per ID, batched only 20-at-a-time. A
// months-long backfill re-asked LinkedIn "what's creative #X called?" up to 30+ times for the exact
// same ID across consecutive weekly chunks, which is most of why a full history sync was taking
// several minutes. Vercel commonly reuses the same warm function instance across a rapid burst of
// sequential requests like a sync loop firing chunk after chunk within a few minutes, so a plain
// module-level Map (declared outside any function, so it survives across invocations on the same
// warm instance) is very likely to catch most of that repetition. Pure speedup, zero correctness
// risk: a cache miss (cold start, or a URN never seen before) just falls through to the same fetch
// as before, and nothing here changes what data gets returned or written to spend_rows. No TTL or
// eviction needed — a serverless container recycling on its own (Vercel doesn't keep one warm for
// more than a few idle minutes) is the only invalidation this needs; a creative/campaign/group
// getting renamed mid-backfill is rare enough not to be worth adding complexity for. Shared by all
// three resolve*Names functions below since URNs are namespaced by LinkedIn's own type prefix
// (sponsoredCreative/sponsoredCampaign/sponsoredCampaignGroup) — no collision risk from one Map.
const nameCache = new Map();

// Shared batched-resolve-with-cache helper — see nameCache's doc comment above for why this exists.
// `fetchOne(urn, token)` resolves ONE urn's data (or throws, caught by the caller) exactly the way
// each resolve*Names function used to inline; this just adds the cache check/write around it while
// keeping the same "batch of 20 concurrent, sequential batches" shape as before.
async function resolveCached(token, urns, fetchOne) {
  const result = {};
  const uncached = [];
  for (const urn of urns) {
    if (nameCache.has(urn)) result[urn] = nameCache.get(urn);
    else uncached.push(urn);
  }
  const batches = [];
  for (let i = 0; i < uncached.length; i += 20) batches.push(uncached.slice(i, i + 20));
  for (const batch of batches) {
    await Promise.all(batch.map(async (urn) => {
      const value = await fetchOne(urn, token);
      nameCache.set(urn, value);
      result[urn] = value;
    }));
  }
  return result;
}

// Resolve campaign names + their parent campaignGroup URN individually by ID — bulk fetch not
// supported on Advertising API tier. Note: LinkedIn's "Campaign" object is PaidHQ's leaf-level
// campaign_name (equivalent to an ad set/ad group on other platforms); LinkedIn's "Campaign Group"
// is PaidHQ's campaign_group_name (equivalent to what other platforms simply call "Campaign").
async function resolveCampaignNames(token, urns) {
  return resolveCached(token, urns, async (urn, tok) => {
    const id = urn.split(":").pop();
    try {
      const res = await fetch(`${BASE}/adCampaignsV2/${id}`, { headers: restHeaders(tok) });
      if (res.ok) {
        const data = await res.json();
        return { id: String(id), name: data.name || `Campaign ${id}`, groupUrn: data.campaignGroup || null };
      }
      return { id: String(id), name: `Campaign ${id}`, groupUrn: null };
    } catch {
      return { id: String(id), name: `Campaign ${id}`, groupUrn: null };
    }
  });
}

// Resolve campaign group names individually by ID (mirrors resolveCampaignNames' batching).
async function resolveCampaignGroupNames(token, urns) {
  return resolveCached(token, urns, async (urn, tok) => {
    const id = urn.split(":").pop();
    try {
      const res = await fetch(`${BASE}/adCampaignGroupsV2/${id}`, { headers: restHeaders(tok) });
      if (res.ok) {
        const data = await res.json();
        return data.name || `Campaign Group ${id}`;
      }
      return `Campaign Group ${id}`;
    } catch {
      return `Campaign Group ${id}`;
    }
  });
}

// Resolve creative names + their parent campaign URN individually by ID (mirrors
// resolveCampaignNames' batching — same "bulk fetch not supported" constraint applies to
// adCreativesV2). ad-level pull (2026-08-19, per Mo — bringing ad-level granularity into paid
// social so ads can be tagged by dimension). Unlike campaigns/campaign groups, LinkedIn ad
// creatives don't always carry a human-set "name" the way an advertiser names a Campaign or
// Campaign Group — a creative is usually identified by its underlying content (a Sponsored Content
// post, a Text Ad, an inline Direct Sponsored Content unit), not a separate name field an
// advertiser fills in. This falls back through a few plausible shapes (top-level name, inline
// variable text) before giving up and using "Creative {id}", same never-throw-on-a-missing-name
// posture as resolveCampaignNames/resolveCampaignGroupNames. Verify the actual ad_name values that
// come through on the first live sync — if LinkedIn's account has creatives worth relabeling here
// with something more specific, that's a follow-up, not guessed at blind.
async function resolveCreativeNames(token, urns) {
  return resolveCached(token, urns, async (urn, tok) => {
    const id = urn.split(":").pop();
    try {
      const res = await fetch(`${BASE}/adCreativesV2/${id}`, { headers: restHeaders(tok) });
      if (res.ok) {
        const data = await res.json();
        const inlineText = data.variables?.data?.["com.linkedin.ads.SponsoredUpdateCreativeVariables"]?.share?.text
          || data.variables?.data?.["com.linkedin.ads.TextAdCreativeVariables"]?.headline;
        return { id: String(id), name: data.name || inlineText || `Creative ${id}`, campaignUrn: data.campaign || null };
      }
      return { id: String(id), name: `Creative ${id}`, campaignUrn: null };
    } catch {
      return { id: String(id), name: `Creative ${id}`, campaignUrn: null };
    }
  });
}

async function fetchAnalytics(token, accountId, startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);

  // timeGranularity=DAILY (found 2026-07, was MONTHLY): MONTHLY collapses an entire month's spend
  // into ONE row per campaign, dated to the 1st of that month (see the date-mapping fix below) —
  // PaidHQ's pacing engine (computePlatformFreshness/computePacing in src/PaidHQ.jsx) assumes
  // "live-synced" platforms like LinkedIn report true day-by-day data and derives each platform's
  // projection off the most recent date it actually has spend for. With MONTHLY granularity, the
  // current month's row is always dated the 1st, so freshness "as of" the 1st plus a large lump
  // sum reads as one day's spend, wildly overstating the projected total for the rest of the month
  // (same failure mode Google/Bing's manual monthly CSV exports hit, just baked into the live sync
  // instead). DAILY returns one row per campaign per real day, which is what the pacing math
  // actually needs and removes the need for any as-of override for this platform.
  // pivot=CREATIVE (was CAMPAIGN — 2026-08-19, per Mo's ad-level pull): pivotValues now come back
  // as creative URNs instead of campaign URNs, one row per creative per day. getSpend resolves
  // creative -> campaign -> campaign group as a third resolution level below.
  const url =
    `${BASE}/adAnalyticsV2` +
    `?q=analytics` +
    `&pivot=CREATIVE` +
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

  // Three-level resolution (2026-08-19, ad-level pull): creative -> campaign -> campaign group.
  // pivotValues[0] is now a creative URN (see fetchAnalytics), so this adds one more hop below the
  // pre-existing campaign -> campaign group resolution.
  const creativeUrns = [...new Set(withSpend.map((el) => (el.pivotValues || [])[0]).filter(Boolean))];
  const creatives = await resolveCreativeNames(token, creativeUrns);

  const campaignUrns = [...new Set(Object.values(creatives).map((c) => c.campaignUrn).filter(Boolean))];
  const campaigns = campaignUrns.length ? await resolveCampaignNames(token, campaignUrns) : {};

  const groupUrns = [...new Set(Object.values(campaigns).map((c) => c.groupUrn).filter(Boolean))];
  const groups = groupUrns.length ? await resolveCampaignGroupNames(token, groupUrns) : {};

  return withSpend
    .map((el) => {
      const creativeUrn = (el.pivotValues || [])[0];
      const cr = creatives[creativeUrn] || { id: creativeUrn?.split(":").pop() || "unknown", name: creativeUrn || "Unknown", campaignUrn: null };
      const c = (cr.campaignUrn && campaigns[cr.campaignUrn]) || { id: cr.campaignUrn?.split(":").pop() || "unknown", name: "Unknown Campaign", groupUrn: null };
      const dr = el.dateRange?.start;
      return {
        campaign_group_name: (c.groupUrn && groups[c.groupUrn]) || c.name,
        campaign_name: c.name,
        campaign_id: c.id,
        ad_name: cr.name,
        ad_id: cr.id,
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
