/**
 * /api/workspaces/[id]/ai-chats
 *
 * Server-side counterpart to the Ask AI chat history that previously lived in a single
 * `localStorage["paidhq_ask_chats"]` key — per-browser, and shared across every workspace opened
 * in that browser (no workspace scoping at all). Now scoped per (workspace, user): each person's
 * chat history is their own, matching the old per-browser behavior, but correctly siloed per
 * workspace and durable across devices/logins instead of stuck in one browser.
 *
 * GET /ai-chats — returns the CALLER's own { chats, projects } for this workspace (never anyone
 *   else's). `projects` (2026-07-21) is the folder/project list chats can be filed under, alongside
 *   pinning and free-text labels stored directly on each chat record — see AskAI in BudgetHQ.jsx.
 * PUT /ai-chats — upserts the CALLER's own { chats, projects }.
 *
 * STORAGE NOTE: the underlying `chats` jsonb column's stored VALUE changed shape from a bare
 * ChatRecord[] array to { chats: ChatRecord[], projects: Project[] } — no DB migration needed since
 * jsonb doesn't enforce a shape, but GET has to handle rows written before this change, where the
 * stored value IS still the bare array.
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
    const stored = rows.length ? rows[0].chats : null;
    if (!stored) return res.status(200).json({ chats: [], projects: [] });
    // Pre-2026-07-21 rows: stored value is the bare chats array itself.
    if (Array.isArray(stored)) return res.status(200).json({ chats: stored, projects: [] });
    return res.status(200).json({ chats: stored.chats || [], projects: stored.projects || [] });
  }

  if (req.method === "PUT") {
    const { chats, projects } = req.body || {};
    const value = { chats: chats ?? [], projects: projects ?? [] };
    await sql`
      insert into budgethq.ai_chats (workspace_id, user_id, chats, updated_at)
      values (${workspaceId}, ${userId}, ${JSON.stringify(value)}, now())
      on conflict (workspace_id, user_id) do update set
        chats = excluded.chats,
        updated_at = now()
    `;
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, PUT, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
