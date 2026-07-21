/**
 * /api/workspaces/[id]/ai-chats
 *
 * Server-side counterpart to the Ask AI chat history that previously lived in a single
 * `localStorage["paidhq_ask_chats"]` key — per-browser, and shared across every workspace opened
 * in that browser (no workspace scoping at all). Now scoped per (workspace, user): each person's
 * chat history is their own, matching the old per-browser behavior, but correctly siloed per
 * workspace and durable across devices/logins instead of stuck in one browser.
 *
 * GET /ai-chats — returns the CALLER's own chats for this workspace (never anyone else's).
 * PUT /ai-chats — upserts the CALLER's own chats. Body: { chats }.
 *
 * Deliberately NOT gated by requireEditAccess — a member (view-only) role restricts changes to
 * real shared workspace data (budgets/tags/spend rows), not someone's own AI conversation history,
 * which can't affect anyone else or the underlying dataset.
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
      select chats from budgethq.ai_chats where workspace_id = ${workspaceId} and user_id = ${userId}
    `;
    return res.status(200).json({ chats: rows.length ? rows[0].chats : [] });
  }

  if (req.method === "PUT") {
    const { chats } = req.body || {};
    await sql`
      insert into budgethq.ai_chats (workspace_id, user_id, chats, updated_at)
      values (${workspaceId}, ${userId}, ${JSON.stringify(chats ?? [])}, now())
      on conflict (workspace_id, user_id) do update set
        chats = excluded.chats,
        updated_at = now()
    `;
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, PUT, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
