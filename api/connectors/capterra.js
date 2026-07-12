/**
 * Capterra (Gartner Digital Markets) connector — Click Report API
 *
 * Capterra issues a SEPARATE API key per campaign/product — there's no single account-level
 * key that covers every product, each one has to be requested individually from Capterra's
 * account manager team (Vendor Portal → pick a campaign → API docs → "Email Account Manager").
 * CAPTERRA_API_KEYS holds all of them as one JSON object, so adding a new product later is
 * just an env var edit, not a code change:
 *   CAPTERRA_API_KEYS = {"Auth0":"key1","EZ Lease":"key2","insightsoftware - Financial Reporting":"key3"}
 *
 * Request/response shape below is confirmed against real requests run from the Vendor Portal's
 * own docs page (2026-07), not guessed:
 *   GET https://public-api.capterra.com/v2/clicks?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&channel=<channel>&include_conversion_type=false
 *   Header: Authorization: <raw api key>  (no "Bearer " prefix, no custom header name)
 *   Response: { clicks: [{date_of_report, campaign_name, product_name, category, channel,
 *               country, campaign_id, cost, clicks, avg_cpc, avg_position, conversions,
 *               conversion_rate, cpl, landing_page, conversions_by_type}], meta: {...} }
 *
 * `channel` is a single-value filter, not a label — one API key's spend is split across three
 * separate Gartner Digital Markets properties (confirmed via live test requests): "capterra",
 * "getapp", and "software advice" (note the space). A key only covering "capterra" undercounts
 * total spend substantially, so every campaign is queried against all three and merged.
 *
 * campaign_name (the ad set/ad group equivalent in BudgetHQ) is Capterra's `product_name` field
 * (e.g. "Jet Reports", "Spreadsheet Server") — the named product within the campaign, not the
 * category or channel. Falls back to `category` only if a row is ever missing product_name.
 *
 * Rows are aggregated to MONTHLY (dated the 1st of the month), not daily — matches how Capterra
 * itself finalizes spend (click data isn't final until the monthly invoice, so daily data is
 * provisional anyway) and keeps row counts sane across many product/channel/country splits.
 * Note this trades off pacing's daily run-rate accuracy the same way LinkedIn's monthly-bucketed
 * sync does: a whole month's cost lands on the 1st, so mid-month pacing for Capterra segments
 * will look artificially "ahead" right after that date, then flat until the next month's data
 * arrives — same known tradeoff, just a different source.
 *
 * AGGREGATION NOTE: the API returns multiple rows per product per day, broken out by channel
 * and/or country (confirmed live — e.g. two "Spreadsheet" rows on the same date, one per
 * country, each with its own cost) — and now also across every day within a month, since we're
 * rolling up to monthly. mergeRows() upstream (src/BudgetHQ.jsx) de-dupes by
 * campaign_group_name + campaign_name + date and OVERWRITES on a collision rather than summing
 * — so this connector pre-aggregates (sums cost/clicks) down to one row per campaign+product+
 * month before returning, otherwise those splits would silently disappear on merge instead of
 * adding up to the true total.
 *
 * Pagination: no scroll/cursor field was observed in any confirmed response, just an unopened
 * `meta` object of unknown shape. This connector does a single request per campaign per channel
 * per sync. If a very large date range ever looks truncated, check what's inside `meta`.
 *
 * Also worth knowing: Capterra's own docs note click data isn't final until the monthly
 * invoice is issued, so numbers pulled mid-month may be a slight overstatement versus the
 * eventual invoice.
 */

const BASE = "https://public-api.capterra.com/v2";
const CHANNELS = ["capterra", "getapp", "software advice"];

async function fetchClicksForKey(apiKey, startDate, endDate, channel) {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    channel,
    include_conversion_type: "false",
  });
  const res = await fetch(`${BASE}/clicks?${params.toString()}`, {
    headers: {
      accept: "application/json",
      Authorization: apiKey,
    },
  });
  if (!res.ok) throw new Error(`Capterra API ${res.status} (channel=${channel}): ${await res.text()}`);
  const data = await res.json();
  return data.clicks || [];
}

export async function getSpend({ startDate, endDate }) {
  const raw = process.env.CAPTERRA_API_KEYS;
  if (!raw) throw new Error("CAPTERRA_API_KEYS not set");
  let keyMap;
  try {
    keyMap = JSON.parse(raw);
  } catch {
    throw new Error('CAPTERRA_API_KEYS is not valid JSON — expected {"Campaign Name": "api_key", ...}');
  }
  const campaigns = Object.entries(keyMap);
  if (!campaigns.length) throw new Error("CAPTERRA_API_KEYS has no campaigns configured");

  // Keyed by campaign_group_name+campaign_name+date and summed as rows come in — see
  // AGGREGATION NOTE above for why this can't just push every row and let mergeRows() dedupe.
  const agg = new Map();
  const errors = [];

  await Promise.all(
    campaigns.flatMap(([campaignLabel, apiKey]) =>
      CHANNELS.map(async (channel) => {
        try {
          const clicks = await fetchClicksForKey(apiKey, startDate, endDate, channel);
          clicks.forEach((c) => {
            const cost = parseFloat(c.cost ?? 0) || 0;
            if (cost <= 0) return;
            if (!c.date_of_report) return;
            // Roll every day up to the 1st of its month — see the file-level comment for why.
            const date = `${c.date_of_report.slice(0, 7)}-01`;
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
          errors.push(`${campaignLabel} (${channel}): ${err.message}`);
        }
      })
    )
  );

  const allRows = Array.from(agg.values());
  if (!allRows.length && errors.length) {
    throw new Error(`Capterra sync failed for all campaigns — ${errors.join("; ")}`);
  }
  // Partial failure (some campaign/channel combos worked, some didn't) still returns what
  // succeeded rather than blocking the whole sync — logged server-side so a bad key or a
  // hiccup on one channel doesn't silently vanish, it just shows up in Vercel's function
  // logs instead of the UI.
  if (errors.length) console.error("[capterra] partial failure:", errors.join(" | "));

  return allRows;
}

export const meta = {
  platform: "Capterra",
  label: "Capterra",
  icon: "C",
  status: "live",
  requiredEnvVars: ["CAPTERRA_API_KEYS"],
};
