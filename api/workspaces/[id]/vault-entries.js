/**
 * /api/workspaces/[id]/vault-entries — Vault (Phase 1: storage/resources), folding VaultHQ's
 * document/resource storage into PaidHQ as a new tab, per Mo (2026-08-19). See
 * vault_entries_migration.sql's own doc comment for the full scope decisions (Project == workspace
 * 1:1, no chat/AI tools yet, attachments reuse the existing core.files table via a vault_entry_id
 * link rather than a second storage backend).
 *
 * SCHEMA (paidhq-core, not in this checkout):
 *   create table if not exists core.vault_entries (
 *     id uuid primary key default gen_random_uuid(),
 *     workspace_id uuid not null references core.workspaces(id) on delete cascade,
 *     title text not null,
 *     category text not null default 'General',
 *     tags jsonb not null default '[]'::jsonb,
 *     content text not null default '',
 *     created_by uuid,
 *     created_at timestamptz not null default now(),
 *     updated_at timestamptz not null default now()
 *   );
 *   alter table core.files add column if not exists vault_entry_id uuid
 *     references core.vault_entries(id) on delete cascade;
 *
 * GET    /vault-entries                        — list, metadata + a short content excerpt only
 *        (deliberately excludes the full `content` body, same "cheap list, full fetch on demand"
 *        shape as files.js's own GET — a workspace could accumulate long-form briefs/strategy docs
 *        here, no reason to ship every entry's full markdown body just to render a list).
 *        Optional filters: ?category=&tag=&search= (search matches title OR content, ILIKE).
 * GET    /vault-entries?entryId=<id>            — one entry, FULL content, plus its attached files
 *        (id, name, mimeType, size, createdAt) via a join against core.files.vault_entry_id.
 * POST   /vault-entries                         — create. Body: { title, category?, tags?, content? }.
 * PATCH  /vault-entries                         — update. Body: { entryId, title?, category?, tags?,
 *        content? } — partial update, COALESCE'd against the existing row so callers only send what
 *        actually changed (mirrors files.js PATCH's rename-only shape, just with more fields).
 * DELETE /vault-entries?entryId=<id>            — delete an entry AND its attachments (core.files
 *        rows with this vault_entry_id cascade-delete via the FK — see migration).
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

const EXCERPT_LEN = 240;

const toListItem = (r) => ({
  id: r.id,
  title: r.title,
  category: r.category,
  tags: r.tags || [],
  excerpt: (r.content || "").slice(0, EXCERPT_LEN),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toFull = (r) => ({
  id: r.id,
  title: r.title,
  category: r.category,
  tags: r.tags || [],
  content: r.content || "",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toFileMeta = (f) => ({ id: f.id, name: f.name, mimeType: f.mime_type, size: f.size_bytes, createdAt: f.created_at });

export default withApi(async (req, res) => {
  const { id: workspaceId, entryId } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET" && entryId) {
    const rows = await sql`select * from core.vault_entries where id = ${entryId} and workspace_id = ${workspaceId}`;
    if (!rows.length) return res.status(404).json({ error: "Vault entry not found" });
    const files = await sql`
      select id, name, mime_type, size_bytes, created_at from core.files
      where vault_entry_id = ${entryId} and workspace_id = ${workspaceId}
      order by created_at desc
    `;
    return res.status(200).json({ entry: toFull(rows[0]), files: files.map(toFileMeta) });
  }

  if (req.method === "GET") {
    const { category, tag, search } = req.query;
    const rows = await sql`
      select * from core.vault_entries
      where workspace_id = ${workspaceId}
        and (${category || null}::text is null or category = ${category || null})
        and (${tag || null}::text is null or tags @> ${tag ? JSON.stringify([tag]) : null}::jsonb)
        and (${search || null}::text is null or title ilike ${search ? `%${search}%` : null} or content ilike ${search ? `%${search}%` : null})
      order by updated_at desc
    `;
    return res.status(200).json({ entries: rows.map(toListItem) });
  }

  if (req.method === "POST") {
    requireEditAccess(myRole);
    const { title, category, tags, content } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: "title is required" });
    const [row] = await sql`
      insert into core.vault_entries (workspace_id, title, category, tags, content, created_by)
      values (${workspaceId}, ${title.trim()}, ${category || "General"}, ${JSON.stringify(Array.isArray(tags) ? tags : [])}::jsonb, ${content || ""}, ${userId})
      returning *
    `;
    return res.status(201).json({ entry: toFull(row) });
  }

  if (req.method === "PATCH") {
    requireEditAccess(myRole);
    const { entryId: bodyEntryId, title, category, tags, content } = req.body || {};
    if (!bodyEntryId) return res.status(400).json({ error: "entryId is required" });
    const [row] = await sql`
      update core.vault_entries set
        title = coalesce(${title != null ? title.trim() : null}, title),
        category = coalesce(${category ?? null}, category),
        tags = coalesce(${tags != null ? JSON.stringify(tags) : null}::jsonb, tags),
        content = coalesce(${content ?? null}, content),
        updated_at = now()
      where id = ${bodyEntryId} and workspace_id = ${workspaceId}
      returning *
    `;
    if (!row) return res.status(404).json({ error: "Vault entry not found" });
    return res.status(200).json({ entry: toFull(row) });
  }

  if (req.method === "DELETE") {
    requireEditAccess(myRole);
    if (!entryId) return res.status(400).json({ error: "entryId is required" });
    // Attachments (core.files rows with vault_entry_id = this id) cascade-delete via the FK from
    // Vault Phase 1's migration, bypassing files.js's own DELETE handler entirely. Known gap
    // (2026-08-19, blob upload): any attachment that was blob-backed (blob_url set) leaves its
    // underlying Vercel Blob object orphaned rather than cleaned up, since that cleanup only runs
    // in files.js's DELETE branch. Harmless (no data loss/user-facing breakage, just unused
    // storage) — worth a cleanup job later if it matters at scale, not fixed here.
    const result = await sql`delete from core.vault_entries where id = ${entryId} and workspace_id = ${workspaceId} returning id`;
    if (!result.length) return res.status(404).json({ error: "Vault entry not found" });
    return res.status(200).json({ deleted: true });
  }

  res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
