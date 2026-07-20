/**
 * Supermetrics connector
 * Status: live, per-workspace credentialed — same reasoning as connectors/funnel.js. Each
 * BudgetHQ workspace connects its own Supermetrics API key rather than sharing one process.env
 * credential across the whole app.
 *
 * API: Supermetrics Query API — GET https://api.supermetrics.com/query/data/json
 *   Bearer-auth'd, JSON query params ({ds_id, ds_accounts, start_date, end_date, fields}).
 *   Docs: https://docs.supermetrics.com/apidocs/query-data
 *
 * Supermetrics is itself an aggregator over ~100 underlying ad platforms — there's no single
 * "spend" endpoint, you query a specific `ds_id` (e.g. "GAWA" for Google Ads, "FACEBOOK" for Meta,
 * "LINKEDIN" for LinkedIn Ads) and each data source has its own field catalogue. This connector
 * queries Supermetrics' "common fields" schema (date/campaign_name/cost/impressions/clicks), which
 * Supermetrics documents as mapping consistently across most ad-platform data sources specifically
 * so integrations like this one don't need a per-platform field table — but that's the one thing
 * most likely to need a tweak once tested against a real ds_id, if a given data source doesn't
 * support the common schema.
 *
 * Credential shape (stored in budgethq.connector_credentials.credential):
 *   { apiKey, dsId, dsAccounts }
 * apiKey and dsId are required; dsAccounts is optional (a specific account/profile ID within that
 * data source — omit to query every account the key has access to for that ds_id).
 *
 * NOT tested against a live Supermetrics account (no credentials available while building this) —
 * built directly off Supermetrics' documented Query API request/response shape.
 */

const ENDPOINT = "https://api.supermetrics.com/query/data/json";
const COMMON_FIELDS = ["date", "campaign_name", "cost", "impressions", "clicks"];

export async function getSpend({ startDate, endDate, credential }) {
  const { apiKey, dsId, dsAccounts } = credential || {};
  if (!apiKey) throw new Error("Supermetrics API key is missing — reconnect this workspace's Supermetrics account.");
  if (!dsId) throw new Error("Supermetrics data source (ds_id) is missing — reconnect this workspace's Supermetrics account.");

  const query = {
    ds_id: dsId,
    start_date: startDate,
    end_date: endDate,
    fields: COMMON_FIELDS,
    max_rows: 100000,
  };
  if (dsAccounts) query.ds_accounts = Array.isArray(dsAccounts) ? dsAccounts : [dsAccounts];

  const url = `${ENDPOINT}?json=${encodeURIComponent(JSON.stringify(query))}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error?.message || `Supermetrics API ${res.status}`);
  }

  // Response rows are arrays of string values, positionally matching the `fields` order requested
  // above (per query.fields metadata in the response) — not an array of named objects.
  const fieldOrder = (body?.query?.fields || []).map((f) => f.field_id || f.id);
  const idx = (name) => fieldOrder.indexOf(name);
  const dateIdx = idx("date") >= 0 ? idx("date") : 0;
  const campaignIdx = idx("campaign_name") >= 0 ? idx("campaign_name") : 1;
  const costIdx = idx("cost") >= 0 ? idx("cost") : 2;
  const impressionsIdx = idx("impressions") >= 0 ? idx("impressions") : 3;
  const clicksIdx = idx("clicks") >= 0 ? idx("clicks") : 4;

  const rows = body?.data || [];
  return rows
    .map((r) => {
      const spend = Number(r[costIdx] || 0);
      const date = r[dateIdx];
      if (!date || !spend) return null;
      const campaign = r[campaignIdx] || "Unknown campaign";
      return {
        campaign_group_name: dsId,
        campaign_name: campaign,
        campaign_id: null,
        platform: dsId,
        date,
        spend: Math.round(spend * 100) / 100,
        impressions: Number(r[impressionsIdx] || 0),
        clicks: Number(r[clicksIdx] || 0),
      };
    })
    .filter(Boolean);
}

export const meta = {
  platform: "Supermetrics",
  label: "Supermetrics",
  status: "live",
  perWorkspaceAuth: true,
  connectFields: [
    { key: "apiKey", label: "API key", placeholder: "User settings → API Authentication in Supermetrics" },
    { key: "dsId", label: "Data source ID", placeholder: "e.g. GAWA (Google Ads), FACEBOOK, LINKEDIN" },
    { key: "dsAccounts", label: "Account ID (optional)", placeholder: "Leave blank to use every account this key can access" },
  ],
};
