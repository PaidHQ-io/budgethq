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
 * POST /files                 — upload. Body: { name, category, mimeType, dataBase64, vaultEntryId? }
 *                                OR { name, category, mimeType, blobUrl, size, vaultEntryId? }.
 *                                vaultEntryId (2026-08-19, Vault Phase 1) links this file as a Vault
 *                                entry's attachment rather than a general File Store upload — see
 *                                vault-entries.js's own doc comment. Omitted/null for every existing
 *                                caller, unaffected.
 *                                blobUrl (2026-08-19, blob upload) — an alternative to dataBase64
 *                                for files already uploaded straight to Vercel Blob storage from
 *                                the browser (see blob-upload-token.js's doc comment for why: the
 *                                4.5MB Vercel serverless function body limit makes dataBase64
 *                                unworkable past a few MB). When present, no binary ever passes
 *                                through this function — the row just records the blob's URL and
 *                                the client-reported size instead of bytea. Mutually exclusive with
 *                                dataBase64 in practice (uploadFileViaBlob only sends blobUrl).
 * PATCH /files                — rename one file. Body: { fileId, name }. Deliberately a body field
 *                                (not a query param) — no [id]-collision risk there either way (see
 *                                DELETE's own doc comment below for why query params need care on
 *                                this route), this just mirrors DELETE's fileId naming for
 *                                consistency. Renames only — category/mimeType/data are untouched.
 * DELETE /files?id=<id>       — remove one file.
 *
 * Storing binary data directly in Postgres (bytea) was a fine simplification for the CSV/PDF sizes
 * this app dealt with early on, but it hits Vercel's hard 4.5MB serverless function body limit for
 * anything much bigger — see blob-upload-token.js's doc comment. As of 2026-08-19, larger files
 * (Vault attachments especially) instead upload straight to Vercel Blob from the browser and this
 * table just stores the resulting URL in blob_url. Both storage paths coexist: small files still
 * go through dataBase64->bytea below, since it's one request instead of two and plenty fast enough
 * at that size.
 */
import { sql } from "../../lib/db.js";
import { del as deleteBlob } from "@vercel/blob";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

export default withApi(async (req, res) => {
  const { id: workspaceId, download } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET" && download) {
    const rows = await sql`
      select name, mime_type, data, blob_url from core.files
      where id = ${download} and workspace_id = ${workspaceId}
    `;
    if (!rows.length) return res.status(404).json({ error: "File not found" });
    const file = rows[0];
    // Blob-backed row: redirect to the blob URL rather than proxying the bytes ourselves.
    // downloadFile/fetchFileBlob in workspaceApi.js both use plain fetch(), which follows
    // redirects transparently, so no client-side change was needed for this branch.
    if (file.blob_url) return res.redirect(302, file.blob_url);
    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name.replace(/"/g, "")}"`);
    return res.status(200).send(Buffer.from(file.data));
  }

  if (req.method === "GET") {
    // vault_entry_id is null (2026-08-19, Vault Phase 1) — a file attached to a Vault entry is
    // "owned" by that entry now and shown via vault-entries.js's own GET ?entryId= attachment list
    // instead, so it doesn't ALSO clutter this general File Store listing as a duplicate-looking
    // entry. Downloading a specific known id (the `download` branch above) is unrestricted either
    // way — Vault's own UI reuses that same download endpoint for its attachments.
    const rows = await sql`
      select id, name, category, mime_type, size_bytes, created_at from core.files
      where workspace_id = ${workspaceId} and vault_entry_id is null
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
    const { name, category, mimeType, dataBase64, blobUrl, size, vaultEntryId } = req.body || {};
    if (!name || (!dataBase64 && !blobUrl)) {
      return res.status(400).json({ error: "name and either dataBase64 or blobUrl are required" });
    }
    let row;
    if (blobUrl) {
      [row] = await sql`
        insert into core.files (workspace_id, name, category, mime_type, size_bytes, blob_url, vault_entry_id)
        values (${workspaceId}, ${name}, ${category || "Manual upload"}, ${mimeType || null}, ${size || 0}, ${blobUrl}, ${vaultEntryId || null})
        returning id, name, category, mime_type, size_bytes, created_at
      `;
    } else {
      const buf = Buffer.from(dataBase64, "base64");
      [row] = await sql`
        insert into core.files (workspace_id, name, category, mime_type, size_bytes, data, vault_entry_id)
        values (${workspaceId}, ${name}, ${category || "Manual upload"}, ${mimeType || null}, ${buf.length}, ${buf}, ${vaultEntryId || null})
        returning id, name, category, mime_type, size_bytes, created_at
      `;
    }
    return res.status(201).json({
      id: row.id, name: row.name, category: row.category,
      mimeType: row.mime_type, size: row.size_bytes, createdAt: row.created_at,
    });
  }

  if (req.method === "PATCH") {
    requireEditAccess(myRole);
    const { fileId, name } = req.body || {};
    if (!fileId || !name || !name.trim()) {
      return res.status(400).json({ error: "fileId and a non-empty name are required" });
    }
    const [row] = await sql`
      update core.files set name = ${name.trim()}
      where id = ${fileId} and workspace_id = ${workspaceId}
      returning id, name, category, mime_type, size_bytes, created_at
    `;
    if (!row) return res.status(404).json({ error: "File not found" });
    return res.status(200).json({
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
      delete from core.files where id = ${fileId} and workspace_id = ${workspaceId} returning id, blob_url
    `;
    if (!result.length) return res.status(404).json({ error: "File not found" });
    // Clean up the underlying Blob storage too when this row was blob-backed — otherwise every
    // deleted large attachment leaves an orphaned, unbilled-for-nothing blob behind forever. Best
    // effort: a failure here shouldn't turn a successful row delete into an error response, since
    // the file is already gone from the user's point of view either way.
    if (result[0].blob_url) {
      try { await deleteBlob(result[0].blob_url); } catch (e) { console.error("[files] blob cleanup failed", e); }
    }
    return res.status(200).json({ deleted: true });
  }

  res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
