/**
 * /api/workspaces/[id]/reporting-column-views
 *
 * Per-(workspace, user) storage for Reporting Intelligence's own table column customization
 * (2026-08-17, per Mo — "I need to be able to adjust the columns in these tables... save column
 * views at the user level (so each user can save the view they want)"). Same shape/reasoning as
 * ai-chats.js: each person's column layout is their own, durable across devices/logins, and never
 * visible to or overwritten by anyone else on the same workspace — a column layout is a personal
 * "how I like to look at this" preference, not shared workspace data like tags/budgets.
 *
 * GET /reporting-column-views — returns the CALLER's own `data` blob for this workspace (never
 *   anyone else's). `{}` if this user has never saved anything here yet.
 * PUT /reporting-column-views — upserts the CALLER's own `data` blob (body: { data }). Always a
 *   whole-object replace, same as ai-chats.js's PUT — the client always sends its full current
 *   state, not an incremental patch.
 *
 * `data` shape (opaque to this route — validated/interpreted entirely client-side, same "dumb
 * jsonb bucket" approach ai-chats.js takes with its own chats/projects blob):
 *   {
 *     [tableKey]: {           // tableKey: "periodTable" | "breakdownTable" | "campaignTable"
 *       activeColumns: string[],          // ordered metric keys currently shown in that table
 *       views: [{ id, name, columns: string[], createdAt }],  // named saved column presets
 *       activeViewId: string|null,        // last-applied preset, a display hint only
 *     },
 *     ...
 *   }
 *
 * Deliberately NOT gated by requireEditAccess — same reasoning as ai-chats.js: a personal column
 * layout can't affect anyone else or the underlying dataset, so a view-only member should still be
 * able to customize how THEY look at it.
 *
 * SCHEMA (needs to be added in paidhq-core, which owns core.* migrations — not in this checkout):
 *   create table if not exists core.reporting_column_views (
 *     workspace_id uuid not null,
 *     user_id uuid not null,
 *     data jsonb not null default '{}'::jsonb,
 *     updated_at timestamptz not null default now(),
 *     primary key (workspace_id, user_id)
 *   );
 *   Match workspace_id/user_id's exact column type to whatever core.ai_chats already uses for the
 *   same two columns (uuid almost certainly, but confirm against that table's own migration before
 *   running this) — same per-(workspace,user) shape as that table, just a different payload column.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    const rows = await sql`
      select data from core.reporting_column_views where workspace_id = ${workspaceId} and user_id = ${userId}
    `;
    return res.status(200).json({ data: rows.length ? rows[0].data || {} : {} });
  }

  if (req.method === "PUT") {
    const { data } = req.body || {};
    await sql`
      insert into core.reporting_column_views (workspace_id, user_id, data, updated_at)
      values (${workspaceId}, ${userId}, ${JSON.stringify(data || {})}, now())
      on conflict (workspace_id, user_id) do update set
        data = excluded.data,
        updated_at = now()
    `;
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, PUT, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
