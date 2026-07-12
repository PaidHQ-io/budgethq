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
 * Request/response shape below is confirmed against a real request run from the Vendor Portal's
 * own docs page (2026-07), not guessed:
 *   GET https://public-api.capterra.com/v2/clicks?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&channel=capterra&include_conversion_type=false
 *   Header: Authorization: <raw api key>  (no "Bearer " prefix, no custom header name)
 *   Response: { clicks: [{date_of_report, campaign_name, product_name, category, channel,
 *               country, campaign_id, cost, clicks, avg_cpc, avg_position, conversions,
 *               conversion_rate, cpl, landing_page, conversions_by_type}], meta: {...} }
 *
 * `channel` is hardcoded to "capterra" — Gartner Digital Markets keys can apparently also cover
 * GetApp and Software Advice clicks under the same vendor account, which this connector doesn't
 * pull today. Worth revisiting if those channels matter later.
 *
 * Pagination: the confirmed response didn't include a scroll/cursor field at the top level of
 * `clicks`, just an unopened `meta` object of unknown shape. This connector does a single
 * request per campaign per sync for now. If a very large date range ever looks truncated,
 * check what's inside `meta` — that's almost certainly where a page cursor would live.
 *
 * Also worth knowing: Capterra's own docs note click data isn't final until the monthly
 * invoice is issued, so numbers pulled mid-month may be a slight overstatement versus the
 * eventual invoice.
 */

const BASE = "https://public-api.capterra.com/v2";

async function fetchClicksForKey(apiKey, startDate, endDate) {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    channel: "capterra",
    include_conversion_type: "false",
  });
  const res = await fetch(`${BASE}/clicks?${params.toString()}`, {
    headers: {
      accept: "application/json",
      Authorization: apiKey,
    },
  });
  if (!res.ok) throw new Error(`Capterra API ${res.status}: ${await res.text()}`);
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

  const allRows = [];
  const errors = [];
  await Promise.all(
    campaigns.map(async ([campaignLabel, apiKey]) => {
      try {
        const clicks = await fetchClicksForKey(apiKey, startDate, endDate);
        clicks.forEach((c) => {
          const cost = parseFloat(c.cost ?? 0) || 0;
          if (cost <= 0) return;
          // Prefer the campaign name Capterra itself reports (authoritative) over our own
          // env-var label, falling back to the label only if the response ever omits it.
          const group = c.campaign_name || campaignLabel;
          const leaf = c.category || c.product_name || "General";
          allRows.push({
            campaign_group_name: group,
            campaign_name: leaf,
            campaign_id: c.campaign_id != null ? String(c.campaign_id) : `capterra-${group}-${leaf}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            platform: "Capterra",
            date: c.date_of_report || null,
            spend: Math.round(cost * 100) / 100,
            impressions: 0,
            clicks: parseInt(c.clicks, 10) || 0,
          });
        });
      } catch (err) {
        errors.push(`${campaignLabel}: ${err.message}`);
      }
    })
  );

  if (!allRows.length && errors.length) {
    throw new Error(`Capterra sync failed for all campaigns — ${errors.join("; ")}`);
  }
  // Partial failure (some campaigns worked, some didn't) still returns what succeeded rather
  // than blocking the whole sync — logged server-side so a bad/expired key for one product
  // doesn't silently vanish, it just shows up in Vercel's function logs instead of the UI.
  if (errors.length) console.error("[capterra] partial failure:", errors.join(" | "));

  return allRows.filter((r) => r.date);
}

export const meta = {
  platform: "Capterra",
  label: "Capterra",
  icon: "C",
  status: "live",
  requiredEnvVars: ["CAPTERRA_API_KEYS"],
};
