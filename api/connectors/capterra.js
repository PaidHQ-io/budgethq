/**
 * Capterra (Gartner Digital Markets) connector — Click Report API
 *
 * Capterra issues a SEPARATE API key per campaign/product — there's no single account-level
 * key that covers every product, each one has to be requested individually from Capterra's
 * account manager team (Vendor Portal → pick a campaign → API docs → "Email Account Manager").
 *
 * PER-WORKSPACE AUTH (2026-07-22): a workspace connects its own Capterra keys via the generic
 * connect-panel flow (see connections.js), storing { apiKeys: {"Product A":"key1",...} } — the
 * exact same shape CAPTERRA_API_KEYS always held, just per-workspace now instead of one shared
 * env var for the whole app. Falls back to CAPTERRA_API_KEYS when no credential is passed so
 * Mo's own existing InsightSoftware workspace keeps working without having to re-paste anything
 * — only OTHER workspaces (which have no such env var) are required to connect their own keys.
 *   CAPTERRA_API_KEYS = {"Auth0":"key1","insightsoftware - Financial Reporting":"key2"}
 *
 * Request/response shape below is confirmed against real requests run from the Vendor Portal's
 * own docs page (2026-07), not guessed:
 *   GET https://public-api.capterra.com/v2/clicks?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&include_conversion_type=false
 *   Header: Authorization: <raw api key>  (no "Bearer " prefix, no custom header name)
 *   Response: { clicks: [{date_of_report, campaign_name, product_name, category, channel,
 *               country, campaign_id, cost, clicks, avg_cpc, avg_position, conversions,
 *               conversion_rate, cpl, landing_page, conversions_by_type}], meta: {next?: string} }
 *
 * `channel` (Capterra/GetApp/Software Advice) is left OFF the request entirely — confirmed live
 * that an unfiltered request returns rows spanning all three Gartner Digital Markets properties
 * in a single response (each row carries its own `channel` field), so querying per channel isn't
 * necessary. An earlier version of this connector queried each of the three channel values
 * separately and merged — harmless, but not the actual source of the undercount below.
 *
 * PAGINATION (this WAS the source of a ~5x undercount, found 2026-07): the API paginates via
 * `meta.next`, a full URL with a `cursor` param, present whenever more results remain — confirmed
 * live that one page for a ~6-month range only covered the most recent ~3 weeks. This connector
 * follows `meta.next` until it's absent, capped at MAX_PAGES as a runaway guard. Skipping this
 * (the original implementation only read `data.clicks` from page 1) silently dropped most of the
 * year's data, and dropped a different amount per campaign depending on that campaign's daily
 * volume — which is why the undercount wasn't a clean multiplier across products.
 *
 * campaign_name (the ad set/ad group equivalent in BudgetHQ) is Capterra's `product_name` field
 * (e.g. "Jet Reports", "Spreadsheet Server") — the named product within the campaign, not the
 * category or channel. Falls back to `category` only if a row is ever missing product_name.
 *
 * Rows stay at DAILY granularity (Capterra's native `date_of_report`) rather than rolling up to
 * monthly — kept this way deliberately so pacing's daily run-rate math has real day-by-day data
 * to work with instead of a lump sum landing on the 1st (the tradeoff monthly aggregation would
 * introduce, same as LinkedIn's sync already has).
 *
 * AGGREGATION NOTE: the API returns multiple rows per product per day, broken out by channel
 * and/or country (confirmed live — e.g. two "Spreadsheet" rows on the same date, one per
 * country, each with its own cost). mergeRows() upstream (src/BudgetHQ.jsx) de-dupes by
 * campaign_group_name + campaign_name + date and OVERWRITES on a collision rather than summing
 * — so this connector pre-aggregates (sums cost/clicks) down to one row per campaign+product+day
 * before returning, otherwise those channel/country splits would silently disappear on merge
 * instead of adding up to the true total.
 *
 * Also worth knowing: Capterra's own docs note click data isn't final until the monthly
 * invoice is issued, so numbers pulled mid-month may be a slight overstatement versus the
 * eventual invoice.
 */

const BASE = "https://public-api.capterra.com/v2";
const MAX_PAGES = 200; // runaway guard — a normal sync is a handful of pages per key

async function fetchAllClicksForKey(apiKey, startDate, endDate) {
  const rows = [];
  let url = `${BASE}/clicks?${new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    include_conversion_type: "false",
  }).toString()}`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        Authorization: apiKey,
      },
    });
    if (!res.ok) throw new Error(`Capterra API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    rows.push(...(data.clicks || []));
    url = data.meta?.next || null;
  }
  return rows;
}

export async function getSpend({ startDate, endDate, credential }) {
  // credential.apiKeys is the per-workspace connected value; raw is the legacy shared fallback.
  const raw = credential?.apiKeys ?? process.env.CAPTERRA_API_KEYS;
  if (!raw) throw new Error("This workspace hasn't connected Capterra yet — reconnect this workspace's Capterra account.");
  let keyMap;
  try {
    keyMap = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('Capterra API keys are not valid JSON — expected {"Campaign Name": "api_key", ...}');
  }
  const campaigns = Object.entries(keyMap || {});
  if (!campaigns.length) throw new Error("No Capterra campaigns configured for this credential");

  // Keyed by campaign_group_name+campaign_name+date and summed as rows come in — see
  // AGGREGATION NOTE above for why this can't just push every row and let mergeRows() dedupe.
  const agg = new Map();
  const errors = [];

  await Promise.all(
    campaigns.map(async ([campaignLabel, apiKey]) => {
      try {
        const clicks = await fetchAllClicksForKey(apiKey, startDate, endDate);
        clicks.forEach((c) => {
          const cost = parseFloat(c.cost ?? 0) || 0;
          if (cost <= 0) return;
          const date = c.date_of_report;
          if (!date) return;
          // Prefer the campaign name Capterra itself reports (authoritative) over our own
          // env-var label, falling back to the label only if the response ever omits it.
          const group = c.campaign_name || campaignLabel;
          const leaf = c.product_name || c.category || "General";
          const key = `${group}||${leaf}||${date}`;
          const clickCount = parseInt(c.clicks, 10) || 0;
          const prior = agg.get(key);
          if (prior) {
            prior.spend = Math.round((prior.spend + cost) * 100) / 100;
            prior.clicks += clickCount;
          } else {
            agg.set(key, {
              campaign_group_name: group,
              campaign_name: leaf,
              campaign_id: c.campaign_id != null ? String(c.campaign_id) : `capterra-${group}-${leaf}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
              platform: "Capterra",
              date,
              spend: Math.round(cost * 100) / 100,
              impressions: 0,
              clicks: clickCount,
            });
          }
        });
      } catch (err) {
        errors.push(`${campaignLabel}: ${err.message}`);
      }
    })
  );

  const allRows = Array.from(agg.values());
  if (!allRows.length && errors.length) {
    throw new Error(`Capterra sync failed for all campaigns — ${errors.join("; ")}`);
  }
  // Partial failure (some campaigns worked, some didn't) still returns what succeeded rather
  // than blocking the whole sync — logged server-side so a bad key or a hiccup doesn't silently
  // vanish, it just shows up in Vercel's function logs instead of the UI.
  if (errors.length) console.error("[capterra] partial failure:", errors.join(" | "));

  return allRows;
}

export const meta = {
  platform: "Capterra",
  label: "Capterra",
  icon: "C",
  status: "live",
  perWorkspaceAuth: true,
  envVarFallback: true, // see spend.js's doc comment — falls back to CAPTERRA_API_KEYS if unconnected
  connectFields: [
    { key: "apiKeys", label: "API keys (JSON)", placeholder: '{"Product A":"key1","Product B":"key2"}' },
  ],
  requiredEnvVars: ["CAPTERRA_API_KEYS"],
};
