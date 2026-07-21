/**
 * POST /api/workspaces/[id]/files/[fileId]/copy — body: { targetWorkspaceId }
 *
 * Cross-workspace file sharing, opt-in and explicit: copies one File Store entry from the
 * workspace in the URL (the source) into another workspace the caller ALSO belongs to (the
 * target). This is a real duplicate — a brand-new row with its own id in the target workspace —
 * not a shared reference. Files stay hard-siloed by default (see files.js and the workspace_id
 * foreign keys throughout budgethq.* — this is the one deliberate escape hatch from that, and it's
 * always an explicit action, never automatic).
 *
 * Access: view access (any role) is enough on the SOURCE — copying doesn't change anything there,
 * same as downloading already requires no more than being able to see the File Store panel. The
 * TARGET needs edit access, since this is a write into that workspace's data, same bar as
 * uploading a file there directly.
 */
import { sql } from "../../../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../../../lib/auth.js";
import { withApi } from "../../../../lib/http.js";

export default withApi(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id: sourceWorkspaceId, fileId } = req.query;
  const { userId } = await requireAuth(req);

  await requireWorkspaceMember(sql, sourceWorkspaceId, userId);
  await requireEntitlement(sql, sourceWorkspaceId);

  const { targetWorkspaceId } = req.body || {};
  if (!targetWorkspaceId) return res.status(400).json({ error: "targetWorkspaceId is required" });
  if (targetWorkspaceId === sourceWorkspaceId) {
    return res.status(400).json({ error: "Source and target workspace are the same" });
  }

  const targetRole = await requireWorkspaceMember(sql, targetWorkspaceId, userId);
  requireEditAccess(targetRole);
  await requireEntitlement(sql, targetWorkspaceId);

  const [source] = await sql`
    select name, category, mime_type, size_bytes, data from budgethq.files
    where id = ${fileId} and workspace_id = ${sourceWorkspaceId}
  `;
  if (!source) return res.status(404).json({ error: "File not found" });

  const [copy] = await sql`
    insert into budgethq.files (workspace_id, name, category, mime_type, size_bytes, data)
    values (${targetWorkspaceId}, ${source.name}, ${source.category}, ${source.mime_type}, ${source.size_bytes}, ${source.data})
    returning id, name, category, mime_type, size_bytes, created_at
  `;

  return res.status(201).json({
    id: copy.id, name: copy.name, category: copy.category,
    mimeType: copy.mime_type, size: copy.size_bytes, createdAt: copy.created_at,
  });
});
