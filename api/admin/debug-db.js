/**
 * ONE-TIME diagnostic: confirms whether BudgetHQ's own DATABASE_URL is actually pointing at the
 * same Postgres database as paidhq-core's. Built to debug a specific symptom: paidhq-core's
 * /api/workspaces correctly shows a workspace with a trialing budgethq entitlement, but BudgetHQ's
 * own requireEntitlement check (which queries core.entitlements through BudgetHQ's OWN db.js
 * connection, not core's) returns 402 for that same workspace. If BudgetHQ's connection string
 * points at a different database/branch than core's, this is exactly the symptom you'd see — this
 * endpoint proves or disproves that directly instead of guessing from masked Vercel env vars.
 * GET only. Gated to Mo's accounts. Delete once the mismatch is diagnosed/fixed.
 */
import { sql } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { withApi } from "../lib/http.js";

const ADMIN_EMAILS = ["fractionalpaidmedia@gmail.com", "mo@refinelabs.com"];

export default withApi(async (req, res) => {
  const { email } = await requireAuth(req);
  if (!ADMIN_EMAILS.includes((email || "").toLowerCase())) {
    return res.status(403).json({ error: "Not authorized" });
  }

  const { workspaceId } = req.query;

  const [info] = await sql`
    select current_database() as database, inet_server_addr()::text as server_addr, now() as db_time
  `;
  const [coreCounts] = await sql`
    select
      (select count(*)::int from core.workspaces) as workspaces,
      (select count(*)::int from core.entitlements) as entitlements,
      (select count(*)::int from core.entitlements where product = 'budgethq' and status in ('active','trialing')) as active_budgethq_entitlements
  `;

  let thisWorkspace = null;
  if (workspaceId) {
    thisWorkspace = await sql`
      select workspace_id, product, plan, status from core.entitlements where workspace_id = ${workspaceId}
    `;
  }

  return res.status(200).json({ ...info, ...coreCounts, thisWorkspace });
});
