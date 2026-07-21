/**
 * /api/workspaces/[id]/files — server-side counterpart to the File Store built earlier this
 * session (previously IndexedDB-only, per-browser). Same purpose: archived copies of imported/
 * exported CSVs plus anything manually added (PDFs, etc.), now workspace-scoped and durable
 * across devices/logins instead of living in one browser's IndexedDB.
 *
 * GET  /files                 — list metadata only (id, name, category, size, mime, created_at) —
 *                                deliberately excludes the binary `data` column so listing stays
 *                                cheap even with many/large files.
 * GET  /files?download=<id>   — streams the raw file back with a Content-Disposition header, for
 *                                an actual download rather than a base64 JSON blob.
 * POST /files                 — upload. Body: { name, category, mimeType, dataBase64 }.
 * DELETE /files?id=<id>       — remove one file.
 *
 * Storing binary data directly in Postgres (bytea) rather than a dedicated blob store (S3/Vercel
 * Blob) is a Phase 1 simplification — fine for the CSV/PDF sizes this app deals with. Worth
 * revisiting if workspaces start archiving much larger files.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

export default withApi(async (req, res) => {
  const { id: workspaceId, download } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET" && download) {
    const rows = await sql`
      select name, mime_type, data from budgethq.files
      where id = ${download} and workspace_id = ${workspaceId}
    `;
    if (!rows.length) return res.status(404).json({ error: "File not found" });
    const file = rows[0];
    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name.replace(/"/g, "")}"`);
    return res.status(200).send(Buffer.from(file.data));
  }

  if (req.method === "GET") {
    const rows = await sql`
      select id, name, category, mime_type, size_bytes, created_at from budgethq.files
      where workspace_id = ${workspaceId}
      order by created_at desc
    `;
    return res.status(200).json({
      files: rows.map((r) => ({
        id: r.id, name: r.name, category: r.category,
        mimeType: r.mime_type, size: r.size_bytes, createdAt: r.created_at,
      })),
    });
  }

  if (req.method === "POST") {
    requireEditAccess(myRole);
    const { name, category, mimeType, dataBase64 } = req.body || {};
    if (!name || !dataBase64) {
      return res.status(400).json({ error: "name and dataBase64 are required" });
    }
    const buf = Buffer.from(dataBase64, "base64");
    const [row] = await sql`
      insert into budgethq.files (workspace_id, name, category, mime_type, size_bytes, data)
      values (${workspaceId}, ${name}, ${category || "Manual upload"}, ${mimeType || null}, ${buf.length}, ${buf})
      returning id, name, category, mime_type, size_bytes, created_at
    `;
    return res.status(201).json({
      id: row.id, name: row.name, category: row.category,
      mimeType: row.mime_type, size: row.size_bytes, createdAt: row.created_at,
    });
  }

  if (req.method === "DELETE") {
    requireEditAccess(myRole);
    // Deliberately NOT named `id` -- this route lives at /api/workspaces/[id]/files, so a query
    // string param also named `id` collides with the dynamic route segment: Vercel merges both
    // into the same req.query.id, silently clobbering the file id with the workspace id (or vice
    // versa) and making every delete miss. `download` above avoids this the same way. This was the
    // actual reason the delete button never worked, in every deployment before this fix.
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: "fileId is required" });
    const result = await sql`
      delete from budgethq.files where id = ${fileId} and workspace_id = ${workspaceId} returning id
    `;
    if (!result.length) return res.status(404).json({ error: "File not found" });
    return res.status(200).json({ deleted: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
