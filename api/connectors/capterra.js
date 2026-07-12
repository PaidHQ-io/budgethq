/**
 * Capterra (Gartner Digital Markets) connector — Click Report API
 *
 * Capterra issues a SEPARATE API key per campaign/product — there's no single account-level
 * key that covers every product, each one has to be requested individually from Capterra's
 * account manager team (Vendor Portal → pick a campaign → API docs → "Email Account Manager").
 * CAPTERRA_API_KEYS holds all of them as one JSON object, so adding a new product later is
 * just an env var edit, not a code change:
 *   CAPTERRA_API_KEYS = {"Auth0":"key1","EZ Lease":"key2","insightsoftware - Financial Reporting":"key3"}
 * Each object key becomes that campaign's campaign_group_name in BudgetHQ.
 *
 * VERIFICATION NEEDED: Capterra's CORS policy blocks testing this endpoint from anywhere but
 * their own docs page, so this is built against the endpoint's documented v1 field shape
 * (cost, clicks, date, category, country, channel — confirmed via a major ad-reporting
 * platform's public integration docs) rather than something we could test directly. The
 * Vendor Portal shows a v2 endpoint, which is assumed to be response-compatible but hasn't
 * been confirmed. Search this file for "VERIFY" for the exact spots to check once a real key
 * is available — auth header name/scheme and the date-range query param names are the two
 * genuine guesses here.
 *
 * Also worth knowing: Capterra's own docs note click data isn't final until the monthly
 * invoice is issued, so numbers pulled mid-month may be a slight overstatement versus the
 * eventual invoice.
 *
 * Endpoint: GET https://public-api.capterra.com/v2/clicks
 * Docs: sign in to the Capterra Vendor Portal → pick a campaign → API docs
 */

const BASE = "https://public-api.capterra.com/v2";

async function fetchClicksForKey(apiKey, startDate, endDate) {
  const rows = [];
  let scrollId = null;
  do {
    const params = new URLSearchParams({
      // VERIFY: confirm these date-range param names against a real v2 response — guessed
      // from the "date_of_report" field name the response itself is documented to use.
      date_of_report_start: startDate,
      date_of_report_end: endDate,
    });
    if (scrollId) params.set("scroll_id", scrollId);
    const res = await fetch(`${BASE}/clicks?${params.toString()}`, {
      headers: {
        // VERIFY: the Vendor Portal's "Authorize" dialog asks for an "api_key" value but
        // doesn't publicly document whether it's sent as a header (and under what name) or
        // a query param — this guesses header.
        api_key: apiKey,
      },
    });
    if (!res.ok) throw new Error(`Capterra API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const page = data.clicks || data.results || data.data || [];
    rows.push(...page);
    scrollId = data.scroll_id || null;
  } while (scrollId);
  return rows;
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
    campaigns.map(async ([campaignName, apiKey]) => {
      try {
        const clicks = await fetchClicksForKey(apiKey, startDate, endDate);
        clicks.forEach((c) => {
          const cost = parseFloat(c.cost ?? c.total_cost ?? 0) || 0;
          if (cost <= 0) return;
          const category = c.category || "General";
          allRows.push({
            campaign_group_name: campaignName,
            campaign_name: category,
            campaign_id: `capterra-${campaignName}-${category}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            platform: "Capterra",
            date: c.date || c.date_of_report || null,
            spend: Math.round(cost * 100) / 100,
            impressions: 0,
            clicks: parseInt(c.clicks, 10) || 0,
          });
        });
      } catch (err) {
        errors.push(`${campaignName}: ${err.message}`);
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
