/**
 * /api/oauth/bing/accounts?workspaceId=...
 *
 * Only relevant when a workspace's Microsoft token can see more than one Advertising account —
 * callback.js leaves credential.accountId null in that case and redirects back with
 * ?bing_oauth=select_account instead of guessing. Mirrors api/oauth/linkedin/accounts.js.
 *
 * GET  — list the accounts the workspace's stored Microsoft token can see.
 * POST Body: { accountId, customerId } — save which one to actually sync spend from.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";
import { resolveAccounts } from "../../lib/bingOAuth.js";

async function getStoredCredential(workspaceId) {
  const rows = await sql`
    select credential from budgethq.connector_credentials
    where workspace_id = ${workspaceId} and provider = 'bing'
  `;
  if (!rows.length) {
    const err = new Error("This workspace hasn't connected Microsoft Advertising yet.");
    err.status = 400;
    throw err;
  }
  return rows[0].credential;
}

export default withApi(async (req, res) => {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });

  const { userId } = await requireAuth(req);
  const role = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    const credential = await getStoredCredential(workspaceId);
    const developerToken = process.env.BING_DEVELOPER_TOKEN;
    if (!developerToken) return res.status(400).json({ error: "BING_DEVELOPER_TOKEN is not set" });
    const accounts = await resolveAccounts(credential.accessToken, developerToken);
    return res.status(200).json({ accounts, selectedAccountId: credential.accountId || null });
  }

  if (req.method === "POST") {
    requireEditAccess(role);
    const { accountId, customerId } = req.body || {};
    if (!accountId) return res.status(400).json({ error: "accountId is required" });
    const credential = await getStoredCredential(workspaceId);
    const updated = { ...credential, accountId: String(accountId), customerId: customerId ? String(customerId) : credential.customerId || null };
    await sql`
      update budgethq.connector_credentials
      set credential = ${JSON.stringify(updated)}
      where workspace_id = ${workspaceId} and provider = 'bing'
    `;
    return res.status(200).json({ ok: true, accountId: String(accountId) });
  }

  res.setHeader("Allow", "GET, POST, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
