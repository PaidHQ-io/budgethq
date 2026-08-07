/**
 * /api/workspaces/[id]/account-plans — Account Planning (2026-08-06, per Mo — "I need a way of
 * figuring out how to restructure and rebuild an account that already has existing ads and
 * campaigns... looking at what's working and porting that over to a new structure"). A named,
 * resumable project that walks Context -> Audit -> Taxonomy -> Mapping (see
 * src/components/AccountPlanning.jsx for the wizard UI and src/lib/accountPlanning.js for the
 * scoring/naming engine).
 *
 * Deliberately does NOT persist audit numbers (spend/CPL/pipeline scores) — those are always
 * recomputed live from core.spend_rows/core.reporting_facts when a plan is opened, same reasoning
 * as DataAudit.jsx never freezing its own numbers: a stale "what's working" snapshot from a plan
 * opened three weeks ago would be actively misleading. What DOES persist is the human judgment on
 * top of those numbers (auditDecisions: keep/consolidate/kill per campaign, with a note) plus every
 * other step's own input (context, taxonomy, mapping) — none of that is re-derivable from spend
 * data, so it has to be saved. Same "flexible bucket" jsonb-per-section convention as
 * vault_entries/ai_chats/reporting_column_views (see this codebase's other SCHEMA doc comments) —
 * each step's shape is still being figured out in practice, and jsonb means that never needs a
 * migration to evolve.
 *
 * SCHEMA (paidhq-core, not in this checkout):
 *   create table if not exists core.account_plans (
 *     id uuid primary key default gen_random_uuid(),
 *     workspace_id uuid not null references core.workspaces(id) on delete cascade,
 *     name text not null,
 *     status text not null default 'draft',              -- draft | in_progress | complete
 *     active_step text not null default 'context',        -- context | audit | taxonomy | mapping
 *     context jsonb not null default '{}'::jsonb,          -- { products, regions, personas, budgets }
 *     taxonomy jsonb not null default '{}'::jsonb,          -- { dimensions, nameTemplates, utmNotes }
 *     audit_decisions jsonb not null default '{}'::jsonb,  -- { [groupKey]: { decision, note } }
 *     mapping jsonb not null default '[]'::jsonb,           -- [{ oldKey, oldName, newName, level, action, status }]
 *     created_by uuid,
 *     created_at timestamptz not null default now(),
 *     updated_at timestamptz not null default now()
 *   );
 *   create index if not exists idx_account_plans_workspace on core.account_plans(workspace_id);
 *
 * GET    /account-plans                 — list, metadata only (no context/taxonomy/audit_decisions/
 *        mapping bodies — same "cheap list, full fetch on demand" shape as vault-entries.js's GET).
 * GET    /account-plans?planId=<id>     — one plan, full body.
 * POST   /account-plans                 — create. Body: { name }. Everything else starts empty.
 * PATCH  /account-plans                 — update. Body: { planId, name?, status?, activeStep?,
 *        context?, taxonomy?, auditDecisions?, mapping? } — partial, COALESCE'd, only send what
 *        changed (mirrors vault-entries.js PATCH).
 * DELETE /account-plans?planId=<id>     — delete a plan.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

const toListItem = (r) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  activeStep: r.active_step,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toFull = (r) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  activeStep: r.active_step,
  context: r.context || {},
  taxonomy: r.taxonomy || {},
  auditDecisions: r.audit_decisions || {},
  mapping: r.mapping || [],
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export default withApi(async (req, res) => {
  const { id: workspaceId, planId } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET" && planId) {
    const rows = await sql`select * from core.account_plans where id = ${planId} and workspace_id = ${workspaceId}`;
    if (!rows.length) return res.status(404).json({ error: "Account plan not found" });
    return res.status(200).json({ plan: toFull(rows[0]) });
  }

  if (req.method === "GET") {
    const rows = await sql`
      select * from core.account_plans
      where workspace_id = ${workspaceId}
      order by updated_at desc
    `;
    return res.status(200).json({ plans: rows.map(toListItem) });
  }

  if (req.method === "POST") {
    requireEditAccess(myRole);
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
    const [row] = await sql`
      insert into core.account_plans (workspace_id, name, created_by)
      values (${workspaceId}, ${name.trim()}, ${userId})
      returning *
    `;
    return res.status(201).json({ plan: toFull(row) });
  }

  if (req.method === "PATCH") {
    requireEditAccess(myRole);
    const {
      planId: bodyPlanId, name, status, activeStep, context, taxonomy, auditDecisions, mapping,
    } = req.body || {};
    if (!bodyPlanId) return res.status(400).json({ error: "planId is required" });
    const [row] = await sql`
      update core.account_plans set
        name = coalesce(${name != null ? name.trim() : null}, name),
        status = coalesce(${status ?? null}, status),
        active_step = coalesce(${activeStep ?? null}, active_step),
        context = coalesce(${context != null ? JSON.stringify(context) : null}::jsonb, context),
        taxonomy = coalesce(${taxonomy != null ? JSON.stringify(taxonomy) : null}::jsonb, taxonomy),
        audit_decisions = coalesce(${auditDecisions != null ? JSON.stringify(auditDecisions) : null}::jsonb, audit_decisions),
        mapping = coalesce(${mapping != null ? JSON.stringify(mapping) : null}::jsonb, mapping),
        updated_at = now()
      where id = ${bodyPlanId} and workspace_id = ${workspaceId}
      returning *
    `;
    if (!row) return res.status(404).json({ error: "Account plan not found" });
    return res.status(200).json({ plan: toFull(row) });
  }

  if (req.method === "DELETE") {
    requireEditAccess(myRole);
    if (!planId) return res.status(400).json({ error: "planId is required" });
    const result = await sql`delete from core.account_plans where id = ${planId} and workspace_id = ${workspaceId} returning id`;
    if (!result.length) return res.status(404).json({ error: "Account plan not found" });
    return res.status(200).json({ deleted: true });
  }

  res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
