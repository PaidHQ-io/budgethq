/**
 * /api/workspaces/[id]/versions — server-side counterpart to BudgetHQ's existing IndexedDB
 * version-history feature (checkpoint snapshots of tags/budgets/spend after major actions, plus
 * on-demand named saves). Same shape as before (id, timestamp, label, trigger, snapshot), now
 * workspace-scoped and durable.
 *
 * GET    /versions          — list all versions, newest first (metadata + snapshot — snapshots
 *                              are the same size class as workspace_config, not spend_rows, so
 *                              unlike files there's no metadata/data split needed here).
 * POST   /versions          — create one. Body: { label, trigger, snapshot }.
 * DELETE /versions?id=<id>  — remove one.
 *
 * No MAX_VERSIONS pruning here yet (the IndexedDB version capped at 40) — worth adding once real
 * usage shows how fast these accumulate per workspace.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

const toCamel = (r) => ({
  id: r.id, label: r.label, trigger: r.trigger, snapshot: r.snapshot,
  timestamp: new Date(r.created_at).getTime(),
});

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    const rows = await sql`
      select * from budgethq.versions where workspace_id = ${workspaceId} order by created_at desc
    `;
    return res.status(200).json({ versions: rows.map(toCamel) });
  }

  if (req.method === "POST") {
    const { label, trigger, snapshot } = req.body || {};
    if (!snapshot) return res.status(400).json({ error: "snapshot is required" });
    const [row] = await sql`
      insert into budgethq.versions (workspace_id, label, trigger, snapshot)
      values (${workspaceId}, ${label || null}, ${trigger || "auto"}, ${JSON.stringify(snapshot)})
      returning *
    `;
    return res.status(201).json(toCamel(row));
  }

  if (req.method === "DELETE") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id is required" });
    const result = await sql`
      delete from budgethq.versions where id = ${id} and workspace_id = ${workspaceId} returning id
    `;
    if (!result.length) return res.status(404).json({ error: "Version not found" });
    return res.status(200).json({ deleted: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
