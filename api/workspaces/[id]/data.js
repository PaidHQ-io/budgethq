/**
 * /api/workspaces/[id]/data
 *
 * GET — returns the budgethq.workspace_config JSONB blob: tags, tagDims, budgets, budgetDims,
 *       budgetRowMeta, budgetMetaDims, budgetImportMeta. Field names match BudgetHQ.jsx's
 *       existing in-memory state variables exactly, so the frontend can drop this straight into
 *       useState() without any reshaping. Returns an empty default (not 404) if this workspace
 *       hasn't been touched yet — workspace creation now happens in paidhq-core, which knows
 *       nothing about BudgetHQ's own config table, so there's no guarantee a row exists on first
 *       access.
 * PUT  — upserts the whole blob. The frontend already holds the full current state client-side
 *        (it's a small, infrequently-changing object compared to spend_rows), so whole-document
 *        replace is simpler and safer than patching individual keys — no risk of a partial update
 *        landing out of order relative to another tab/device.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi, readJsonBody } from "../../lib/http.js";

// Manual body parsing (readJsonBody) instead of Vercel's automatic JSON parser — see readJsonBody
// in lib/http.js. This config's payload is normally small, but the client compresses it the same
// way as spend-rows for consistency, so this route needs raw bytes too.
export const config = { api: { bodyParser: false } };

const EMPTY_CONFIG = {
  tags: {}, tagDims: [], budgets: {}, budgetDims: [],
  budgetRowMeta: {}, budgetMetaDims: [], budgetImportMeta: {}, updatedAt: null,
};

const toCamel = (row) => ({
  tags: row.tags,
  tagDims: row.tag_dims,
  budgets: row.budgets,
  budgetDims: row.budget_dims,
  budgetRowMeta: row.budget_row_meta,
  budgetMetaDims: row.budget_meta_dims,
  budgetImportMeta: row.budget_import_meta,
  updatedAt: row.updated_at,
});

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    const rows = await sql`select * from budgethq.workspace_config where workspace_id = ${workspaceId}`;
    if (!rows.length) return res.status(200).json(EMPTY_CONFIG);
    return res.status(200).json(toCamel(rows[0]));
  }

  if (req.method === "PUT") {
    requireEditAccess(myRole);
    const b = await readJsonBody(req);
    const [row] = await sql`
      insert into budgethq.workspace_config
        (workspace_id, tags, tag_dims, budgets, budget_dims, budget_row_meta, budget_meta_dims, budget_import_meta, updated_at)
      values
        (${workspaceId}, ${JSON.stringify(b.tags ?? {})}, ${JSON.stringify(b.tagDims ?? [])},
         ${JSON.stringify(b.budgets ?? {})}, ${JSON.stringify(b.budgetDims ?? [])},
         ${JSON.stringify(b.budgetRowMeta ?? {})}, ${JSON.stringify(b.budgetMetaDims ?? [])},
         ${JSON.stringify(b.budgetImportMeta ?? {})}, now())
      on conflict (workspace_id) do update set
        tags = excluded.tags,
        tag_dims = excluded.tag_dims,
        budgets = excluded.budgets,
        budget_dims = excluded.budget_dims,
        budget_row_meta = excluded.budget_row_meta,
        budget_meta_dims = excluded.budget_meta_dims,
        budget_import_meta = excluded.budget_import_meta,
        updated_at = now()
      returning *
    `;
    return res.status(200).json(toCamel(row));
  }

  res.setHeader("Allow", "GET, PUT, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
