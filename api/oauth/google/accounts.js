/**
 * /api/oauth/google/accounts?workspaceId=...
 *
 * Only relevant when a workspace's Google token can see more than one Ads account — callback.js
 * leaves `credential.accountId` as null in that case and redirects back with
 * ?google_oauth=select_account instead of guessing. This route lets the SPA show a dropdown to
 * finish the connection. Mirrors api/oauth/meta/accounts.js exactly.
 *
 * GET  — list the Google Ads accounts the workspace's stored token can see.
 * POST Body: { accountId, accountName } — save which one to actually sync spend from. accountId is
 *      the bare numeric Google Ads customer ID (see lib/googleAdsOAuth.js's listAccessibleAccounts)
 *      — stored and later passed straight through to connectors/google.js's search calls as-is.
 *      accountName is stored purely for display (Settings' connections table).
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";
import { listAccessibleAccounts } from "../../lib/googleAdsOAuth.js";

async function getStoredCredential(workspaceId) {
  const rows = await sql`
    select credential from budgethq.connector_credentials
    where workspace_id = ${workspaceId} and provider = 'google'
  `;
  if (!rows.length) {
    const err = new Error("This workspace hasn't connected Google Ads yet.");
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
    const accounts = await listAccessibleAccounts(credential.accessToken);
    return res.status(200).json({ accounts, selectedAccountId: credential.accountId || null });
  }

  if (req.method === "POST") {
    requireEditAccess(role);
    const { accountId, accountName } = req.body || {};
    if (!accountId) return res.status(400).json({ error: "accountId is required" });
    const credential = await getStoredCredential(workspaceId);
    const updated = { ...credential, accountId: String(accountId), accountName: accountName ? String(accountName) : credential.accountName || null };
    await sql`
      update budgethq.connector_credentials
      set credential = ${JSON.stringify(updated)}
      where workspace_id = ${workspaceId} and provider = 'google'
    `;
    return res.status(200).json({ ok: true, accountId: String(accountId) });
  }

  res.setHeader("Allow", "GET, POST, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
