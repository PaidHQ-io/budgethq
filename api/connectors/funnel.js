/**
 * Funnel.io connector
 * Status: live, but per-workspace credentialed — unlike linkedin/bing/capterra (one shared
 * process.env token for the whole app), this connector authenticates with the CALLING
 * WORKSPACE's own stored Funnel.io credential (see api/workspaces/[id]/connections.js), since
 * Funnel.io accounts are the kind of thing each BudgetHQ customer has their own separate one of.
 *
 * API: Funnel's Account Export API — https://api.funnel.io/api/account/v1/$ACCOUNT_ID/project/$PROJECT_ID
 *   ?group_by=campaign_day&start_day=YYYY-MM-DD&end_day=YYYY-MM-DD&apiToken=$API_TOKEN
 * group_by=campaign_day is the most granular grouping Funnel offers (channel + campaign + day),
 * which is what BudgetHQ's per-campaign, per-day row shape needs.
 *
 * Credential shape (stored in budgethq.connector_credentials.credential):
 *   { apiToken, accountId, projectId }
 * All three come from the customer's own Funnel.io account — Account Settings -> API for the
 * token, and the account/project IDs are visible in the Funnel app URL when a project is open
 * (https://app.funnel.io/a/$ACCOUNT_ID/p/$PROJECT_ID/...).
 *
 * NOT tested against a live Funnel.io account (no credentials available while building this) —
 * built directly off Funnel's documented Account Export API request/response shape. The most
 * likely thing to need adjusting once someone actually connects an account is the exact field
 * names Funnel returns per row (channel/campaign/date/cost labels below are best-effort based on
 * their docs, not confirmed against a real response).
 */

const BASE = "https://api.funnel.io/api/account/v1";

export async function getSpend({ startDate, endDate, credential }) {
  const { apiToken, accountId, projectId } = credential || {};
  if (!apiToken) throw new Error("Funnel.io API token is missing — reconnect this workspace's Funnel.io account.");
  if (!accountId) throw new Error("Funnel.io account ID is missing — reconnect this workspace's Funnel.io account.");
  if (!projectId) throw new Error("Funnel.io project ID is missing — reconnect this workspace's Funnel.io account.");

  const url = `${BASE}/${encodeURIComponent(accountId)}/project/${encodeURIComponent(projectId)}` +
    `?group_by=campaign_day&start_day=${startDate}&end_day=${endDate}&apiToken=${encodeURIComponent(apiToken)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Funnel.io API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data.data || data.rows || []);

  return rows
    .map((r) => {
      const spend = Number(r.cost ?? r.spend ?? r["Cost"] ?? 0);
      const date = r.date || r.day || r["Date"];
      if (!date || !spend) return null;
      const campaign = r.campaign || r["Campaign"] || "Unknown campaign";
      const channel = r.channel || r["Channel"] || "Funnel.io";
      return {
        campaign_group_name: channel,
        campaign_name: campaign,
        campaign_id: r.campaign_id || r["Campaign ID"] || null,
        platform: channel,
        date,
        spend: Math.round(spend * 100) / 100,
        impressions: Number(r.impressions ?? r["Impressions"] ?? 0),
        clicks: Number(r.clicks ?? r["Clicks"] ?? 0),
      };
    })
    .filter(Boolean);
}

export const meta = {
  platform: "Funnel.io",
  label: "Funnel.io",
  status: "live",
  perWorkspaceAuth: true, // needs a stored budgethq.connector_credentials row, not a shared env var
  connectFields: [
    { key: "apiToken", label: "API token", placeholder: "Account Settings → API in Funnel.io" },
    { key: "accountId", label: "Account ID", placeholder: "From your Funnel.io app URL" },
    { key: "projectId", label: "Project ID", placeholder: "From your Funnel.io app URL" },
  ],
};
