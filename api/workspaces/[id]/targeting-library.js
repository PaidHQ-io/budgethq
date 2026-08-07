/**
 * /api/workspaces/[id]/targeting-library — Account Planning's shared targeting library (2026-08-06,
 * per Mo — "we need to figure out if we're going to layer on contact or company lists, whether
 * we're going to remarket, what exclusions we're going to apply"). Deliberately WORKSPACE-scoped
 * rather than per-plan (per Mo, confirmed via AskUserQuestion): "exclude current customers" or an
 * ABM account list gets defined once for an account and reused across every future rebuild plan for
 * that same workspace, instead of being redefined from scratch each time — see
 * src/lib/accountPlanning.js's own doc notes for how a plan's Targeting Profiles (stored on
 * core.account_plans.targeting, plan-scoped) reference these items by id.
 *
 * One row per workspace holding a flat jsonb array of items rather than a normalized table — same
 * "flexible bucket" reasoning as vault_entries/account_plans (this list's item shape will keep
 * evolving as real usage surfaces gaps, e.g. per-platform list IDs once someone actually syncs a
 * LinkedIn Matched Audience), and the expected item count for one workspace (dozens, not thousands)
 * makes read-modify-write on a single jsonb array perfectly fine — no pagination/indexing need.
 *
 * SCHEMA (paidhq-core, not in this checkout):
 *   create table if not exists core.targeting_libraries (
 *     id uuid primary key default gen_random_uuid(),
 *     workspace_id uuid not null unique references core.workspaces(id) on delete cascade,
 *     items jsonb not null default '[]'::jsonb,
 *       -- [{ id, type: "list" | "exclusion" | "remarketing", name, description,
 *       --   meta: { source?, windowDays? } }]
 *     created_at timestamptz not null default now(),
 *     updated_at timestamptz not null default now()
 *   );
 *
 * GET    /targeting-library              — { items } for this workspace (auto-empty if no row yet,
 *        no row is created until the first write — same "don't create empty rows on read" as most
 *        of this codebase's singleton-per-workspace tables).
 * POST   /targeting-library              — add one item. Body: { type, name, description?, meta? }.
 *        Creates the workspace's row on first write.
 * PATCH  /targeting-library              — update one item. Body: { itemId, name?, description?,
 *        meta? } — partial, only send what changed.
 * DELETE /targeting-library?itemId=<id>  — remove one item.
 */
import { randomUUID } from "crypto";
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

async function loadItems(workspaceId) {
  const rows = await sql`select items from core.targeting_libraries where workspace_id = ${workspaceId}`;
  return rows.length ? rows[0].items || [] : [];
}
async function saveItems(workspaceId, items) {
  await sql`
    insert into core.targeting_libraries (workspace_id, items)
    values (${workspaceId}, ${JSON.stringify(items)}::jsonb)
    on conflict (workspace_id) do update set items = excluded.items, updated_at = now()
  `;
}

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    const items = await loadItems(workspaceId);
    return res.status(200).json({ items });
  }

  if (req.method === "POST") {
    requireEditAccess(myRole);
    const { type, name, description, meta } = req.body || {};
    if (!type || !["list", "exclusion", "remarketing"].includes(type)) return res.status(400).json({ error: "type must be list, exclusion, or remarketing" });
    if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
    const items = await loadItems(workspaceId);
    const item = { id: randomUUID(), type, name: name.trim(), description: description || "", meta: meta || {} };
    items.push(item);
    await saveItems(workspaceId, items);
    return res.status(201).json({ item, items });
  }

  if (req.method === "PATCH") {
    requireEditAccess(myRole);
    const { itemId, name, description, meta } = req.body || {};
    if (!itemId) return res.status(400).json({ error: "itemId is required" });
    const items = await loadItems(workspaceId);
    const idx = items.findIndex((it) => it.id === itemId);
    if (idx === -1) return res.status(404).json({ error: "Item not found" });
    items[idx] = {
      ...items[idx],
      name: name != null ? name.trim() : items[idx].name,
      description: description != null ? description : items[idx].description,
      meta: meta != null ? { ...items[idx].meta, ...meta } : items[idx].meta,
    };
    await saveItems(workspaceId, items);
    return res.status(200).json({ item: items[idx], items });
  }

  if (req.method === "DELETE") {
    requireEditAccess(myRole);
    const { itemId } = req.query;
    if (!itemId) return res.status(400).json({ error: "itemId is required" });
    const items = await loadItems(workspaceId);
    const next = items.filter((it) => it.id !== itemId);
    await saveItems(workspaceId, next);
    return res.status(200).json({ items: next });
  }

  res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
