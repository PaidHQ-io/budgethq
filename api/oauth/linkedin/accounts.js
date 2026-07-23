/**
 * /api/oauth/linkedin/accounts?workspaceId=...
 *
 * Only relevant when a workspace's LinkedIn token can see more than one ad account — callback.js
 * leaves `credential.accountId` as null in that case and redirects back with
 * ?linkedin_oauth=select_account instead of guessing. This route lets the SPA show a dropdown to
 * finish the connection.
 *
 * GET  — list the ad accounts the workspace's stored LinkedIn token can see.
 * POST Body: { accountId, accountName } — save which one to actually sync spend from. accountName
 *      is stored purely for display (Settings' connections table) — listAdAccounts() already
 *      returns it, so this just persists what the picker showed.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";
import { listAdAccounts } from "../../lib/linkedinOAuth.js";

async function getStoredCredential(workspaceId) {
  const rows = await sql`
    select credential from budgethq.connector_credentials
    where workspace_id = ${workspaceId} and provider = 'linkedin'
  `;
  if (!rows.length) {
    const err = new Error("This workspace hasn't connected LinkedIn yet.");
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
    const accounts = await listAdAccounts(credential.accessToken);
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
      where workspace_id = ${workspaceId} and provider = 'linkedin'
    `;
    return res.status(200).json({ ok: true, accountId: String(accountId) });
  }

  res.setHeader("Allow", "GET, POST, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
