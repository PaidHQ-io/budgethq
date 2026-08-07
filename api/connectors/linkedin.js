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

// REST_BASE (2026-08-07, mirrored from paidhq-core's identical copy — see that repo's linkedin.js
// for the fuller doc comment). LinkedIn's Account Structure APIs (Campaigns/Campaign Groups/
// Creatives) are on a SEPARATE deprecation timeline from the analytics/reporting APIs (adAnalyticsV2
// stays on BASE, unaffected). resolveCampaignNames and resolveCreativeNames below were still calling
// the deprecated /v2/adCampaignsV2 and /v2/adCreativesV2 endpoints, which is why creative names came
// back blank or ID-only and objective came back blank — the current, documented replacements are the
// versioned REST endpoints under /rest/adAccounts/{accountId}/... . resolveCampaignGroupNames is
// deliberately left on the old BASE/v2 endpoint — Mo's own screenshot showed campaign group names
// resolving correctly already, so only what was demonstrably broken gets touched.
const REST_BASE = "https://api.linkedin.com/rest";

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
// objectiveType + format (2026-08-07, mirrored from paidhq-core's identical copy — see that repo's
// linkedin.js for the fuller doc comment). Now on REST_BASE's versioned /adAccounts/{accountId}/
// adCampaigns/{id} endpoint (was the deprecated /v2/adCampaignsV2/{id}) — confirmed via LinkedIn's
// official docs that this is a bare numeric ID in the path, not a URN. format is the campaignFormat
// enum (STANDARD_UPDATE, CAROUSEL, SINGLE_VIDEO, etc.) — reused as the Ad Format column's source
// since LinkedIn constrains creatives under a campaign to match that campaign's format.
// Diagnostic logging (2026-08-07, mirrored from paidhq-core's identical copy — see that repo's
// linkedin.js for the fuller doc comment): both resolve*Names branches previously swallowed a
// failure with no trace of why. Pure diagnostic addition, zero behavior change.
async function logResolveFailure(kind, id, res, err) {
  if (err) { console.error(`[linkedin connector] ${kind} ${id} threw:`, err.message); return; }
  const body = await res.text().catch(() => "<unreadable body>");
  console.error(`[linkedin connector] ${kind} ${id} failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
}

async function resolveCampaignNames(token, accountId, urns) {
  return resolveCached(token, urns, async (urn, tok) => {
    const id = urn.split(":").pop();
    try {
      const res = await fetch(`${REST_BASE}/adAccounts/${accountId}/adCampaigns/${id}`, { headers: restHeaders(tok) });
      if (res.ok) {
        const data = await res.json();
        return { id: String(id), name: data.name || `Campaign ${id}`, groupUrn: data.campaignGroup || null, objectiveType: data.objectiveType || null, format: data.format || null };
      }
      await logResolveFailure("campaign", id, res);
      return { id: String(id), name: `Campaign ${id}`, groupUrn: null, objectiveType: null, format: null };
    } catch (err) {
      await logResolveFailure("campaign", id, null, err);
      return { id: String(id), name: `Campaign ${id}`, groupUrn: null, objectiveType: null, format: null };
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
// resolveCampaignNames' batching). Now on REST_BASE's versioned /adAccounts/{accountId}/creatives/
// {creativeUrn} endpoint (was the deprecated /v2/adCreativesV2/{id}) — mirrored from paidhq-core's
// identical copy, see that repo's linkedin.js for the fuller doc comment on why this was broken
// (blank/ID-fallback ad names). Per LinkedIn's official docs, this endpoint takes the FULL
// URL-encoded creative URN in the path (not a bare numeric ID like campaigns), and returns a real
// advertiser-set `name` field directly — no more falling back to inline content-text scraping, that
// was the old v2-only schema's workaround and is no longer needed.
async function resolveCreativeNames(token, accountId, urns) {
  return resolveCached(token, urns, async (urn, tok) => {
    const id = urn.split(":").pop();
    try {
      const res = await fetch(`${REST_BASE}/adAccounts/${accountId}/creatives/${encodeURIComponent(urn)}`, { headers: restHeaders(tok) });
      if (res.ok) {
        const data = await res.json();
        return { id: String(id), name: data.name || `Creative ${id}`, campaignUrn: data.campaign || null };
      }
      await logResolveFailure("creative", id, res);
      return { id: String(id), name: `Creative ${id}`, campaignUrn: null };
    } catch (err) {
      await logResolveFailure("creative", id, null, err);
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
  const creatives = await resolveCreativeNames(token, accountId, creativeUrns);

  const campaignUrns = [...new Set(Object.values(creatives).map((c) => c.campaignUrn).filter(Boolean))];
  const campaigns = campaignUrns.length ? await resolveCampaignNames(token, accountId, campaignUrns) : {};

  const groupUrns = [...new Set(Object.values(campaigns).map((c) => c.groupUrn).filter(Boolean))];
  const groups = groupUrns.length ? await resolveCampaignGroupNames(token, groupUrns) : {};

  // Resolution summary (2026-08-07, mirrored from paidhq-core's identical copy — see that repo's
  // linkedin.js for the fuller doc comment).
  const creativeFallbacks = Object.values(creatives).filter((c) => c.name.startsWith("Creative ")).length;
  const campaignsMissingObjective = Object.values(campaigns).filter((c) => !c.objectiveType).length;
  console.log(`[linkedin connector] resolved ${creativeUrns.length} creatives (${creativeFallbacks} fell back to ID), ${campaignUrns.length} campaigns (${campaignsMissingObjective} missing objective/format), ${groupUrns.length} campaign groups`);

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
        // ad_format (2026-08-07, mirrored from paidhq-core's identical copy): campaign-level format
        // is treated as the ad's format since LinkedIn constrains creatives under a campaign to
        // match that campaign's format.
        extra_metrics: { objective: c.objectiveType || undefined, ad_format: c.format || undefined },
      };
    })
    .filter((r) => r.date);
}

// Reach & frequency (2026-08-07, mirrored from paidhq-core's identical copy — see that repo's
// linkedin.js for the fuller doc comment). Deliberately NOT folded into getSpend/synced into
// spend_rows — reach is deduplicated/non-additive across days, so it's fetched LIVE for the exact
// window the caller needs, never summed from daily rows. LinkedIn hard-caps this to 92-day windows.
export async function getReachMetrics({ startDate, endDate, credential }) {
  const token = credential?.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
  const accountId = credential?.accountId || process.env.LINKEDIN_ACCOUNT_ID;
  if (!token || !accountId) return {};

  const s = new Date(startDate);
  const e = new Date(endDate);
  const days = Math.round((e - s) / 86400000) + 1;
  if (days > 92) throw new Error("LinkedIn reach data is only available for date ranges of 92 days or less — narrow the time frame to see it.");

  const url =
    `${BASE}/adAnalyticsV2` +
    `?q=analytics` +
    `&pivot=CREATIVE` +
    `&dateRange.start.year=${s.getFullYear()}&dateRange.start.month=${s.getMonth() + 1}&dateRange.start.day=${s.getDate()}` +
    `&dateRange.end.year=${e.getFullYear()}&dateRange.end.month=${e.getMonth() + 1}&dateRange.end.day=${e.getDate()}` +
    `&accounts[0]=urn:li:sponsoredAccount:${accountId}` +
    `&fields=pivotValues,impressions,approximateMemberReach`;

  const res = await fetch(url, { headers: analyticsHeaders(token) });
  if (!res.ok) throw new Error(`LinkedIn analytics API ${res.status}: ${await res.text()}`);
  const elements = (await res.json()).elements || [];

  const out = {};
  for (const el of elements) {
    const creativeUrn = (el.pivotValues || [])[0];
    const id = creativeUrn?.split(":").pop();
    if (!id) continue;
    const reach = el.approximateMemberReach || 0;
    const impressions = el.impressions || 0;
    out[id] = { reach, frequency: reach > 0 ? Math.round((impressions / reach) * 100) / 100 : null };
  }
  // Diagnostic logging (2026-08-07, mirrored from paidhq-core's identical copy — see that repo's
  // linkedin.js for the fuller doc comment).
  console.log(`[linkedin connector] reach: ${elements.length} elements returned, ${Object.keys(out).length} keyed by creative id, ${Object.values(out).filter((v) => v.reach > 0).length} with reach > 0`);
  return out;
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
