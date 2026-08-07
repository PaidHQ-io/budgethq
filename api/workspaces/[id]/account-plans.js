/**
 * /api/workspaces/[id]/account-plans — Account Planning (2026-08-06, per Mo — "I need a way of
 * figuring out how to restructure and rebuild an account that already has existing ads and
 * campaigns... looking at what's working and porting that over to a new structure"). A named,
 * resumable project that walks Channel & Flighting Strategy -> Context -> Budget -> Taxonomy ->
 * Targeting -> Mapping (see src/components/AccountPlanning.jsx for the wizard UI and
 * src/lib/accountPlanning.js for the naming/budget engine).
 *
 * REORDERED (twice) + AUDIT REMOVED (2026-08-07, per Mo, in stages):
 *   1. First pass ("I don't understand what to do here... let's figure out the flow of this
 *      workflow"): Channel Strategy and Flighting Strategy added as two new steps at the very
 *      front, Budget rebuilt with a channel split, Audit removed from the wizard entirely
 *      ("the audit section, let's get rid of that altogether... it shouldn't live under campaign
 *      planning") — it's now CampaignAudit.jsx, a standalone top-level PaidHQ tab with no plan
 *      association. audit_decisions below is LEGACY as a result: still a real column (no migration
 *      to drop it), but nothing reads or writes it anymore, including this API's request/response
 *      shape (auditDecisions is unchanged in the PATCH/toFull code below, just never sent by the
 *      client anymore — see that section's own note).
 *   2. Second pass ("let's combine the channel and flight strategy in one, then move the context
 *      screen before the budget"): Channel Strategy + Flighting Strategy merged into one "strategy"
 *      step, and Context moved ahead of Budget — Budget's new per-Context-field allocation cards
 *      (Budget by Segment, and the Ad Set Budget Allocation table under it) need Context's
 *      products/regions/personas/segments to already have real values by the time the user reaches
 *      Budget, not empty lists.
 *
 * Deliberately does NOT persist any spend/performance numbers — those were always (when Audit still
 * lived here) recomputed live from core.spend_rows/core.reporting_facts, same reasoning as
 * DataAudit.jsx/CampaignAudit.jsx never freezing their own numbers: a stale "what's working"
 * snapshot would be actively misleading. What persists here is every OTHER step's own input
 * (context, taxonomy, targeting, mapping) — none of that is re-derivable from spend data, so it has
 * to be saved. Same "flexible bucket" jsonb-per-section convention as vault_entries/ai_chats/
 * reporting_column_views (see this codebase's other SCHEMA doc comments) — each step's shape is
 * still being figured out in practice, and jsonb means that never needs a migration to evolve.
 *
 * SCHEMA (paidhq-core, not in this checkout):
 *   create table if not exists core.account_plans (
 *     id uuid primary key default gen_random_uuid(),
 *     workspace_id uuid not null references core.workspaces(id) on delete cascade,
 *     name text not null,
 *     status text not null default 'draft',              -- draft | in_progress | complete
 *     active_step text not null default 'strategy',        -- strategy | context | budget | taxonomy | targeting | mapping
 *       -- "audit", "channelStrategy", and "flightingStrategy" were all valid active_step values at
 *       -- one point (audit between context and taxonomy; channelStrategy/flightingStrategy as two
 *       -- separate steps before context moved) — none written by this wizard anymore. A plan saved
 *       -- mid one of those old steps just won't match any current step-switch case the next time
 *       -- STEPS is walked; the step nav itself still renders fine (AccountPlanning.jsx needs no
 *       -- special handling here — same graceful-fallback behavior as any other stale value).
 *     context jsonb not null default '{}'::jsonb,          -- { channelStrategy, flightingStrategy, products, regions, personas, segments, adFormatsByPlatform, objectivesByPlatform, funnelStages, adFormats?, objectives?, budgets? }
 *       -- channelStrategy (2026-08-07, per Mo — the new first step: "he needs to decide if this is
 *       -- multi channel, and if so, is it both search and social or just search or just social...").
 *       -- { channels: string[] } — a flat list of PLATFORM_CODES platform names (LinkedIn/Meta/
 *       -- Reddit/YouTube/TikTok for social, Bing/Google Search/Google Display/Demand Gen/
 *       -- Performance Max for search — see CHANNEL_FAMILY_GROUPS in accountPlanning.js), picked via
 *       -- ChannelStrategyStep's Social/Search checkbox groups. Read by BudgetStep (what to offer in
 *       -- the Budget by Channel split) and MappingStep (what to offer in the "+Channel"/empty-state
 *       -- channel picker) — both fall back to every PLATFORM_CODES platform when this is unset,
 *       -- same backward-compatible posture as every other new-field addition in this schema.
 *       -- flightingStrategy (2026-08-07, same approval): { type: "evergreen" | "flighted" | "mix" }.
 *       -- Purely a stated plan-level intent — Mapping's own per-row FlightFields (flightType/
 *       -- startDate/endDate on each mapping row, unchanged) is still where the real, enforced
 *       -- flighting choice gets made for each campaign.
 *       -- segments / regions / funnelStages (2026-08-07, per Mo — "we need some of the data to be
 *       -- consistent as a pick list"): PLAIN STRING ARRAYS, unchanged shape, but as of this pass
 *       -- the CLIENT UI no longer free-types into them — Context's Company Size Segment/Region/
 *       -- Funnel Stage cards are now PickList components (AccountPlanning.jsx) that toggle values
 *       -- on/off from a fixed catalog (SEGMENT_OPTIONS = SMB/MM/ENT, REGION_OPTIONS = 13
 *       -- alphabetized region codes from US to LATAM, FUNNEL_STAGE_OPTIONS = TOFU/MOFU/BOFU/
 *       -- Remarketing) plus a "+ Custom" escape hatch that appends any value not already on the
 *       -- list. The stored array can still contain values outside the fixed catalog (either from
 *       -- Custom entries or from rows saved before this change) — PickList renders those as
 *       -- removable "extra" chips rather than dropping them, so nothing written under the old
 *       -- free-text ChipList regime is lost or hidden. No default backfill on empty/unset (the old
 *       -- DEFAULT_SEGMENTS/DEFAULT_FUNNEL_STAGES client-side fallback constants that used to live in
 *       -- AccountPlanning.jsx have been deleted) — an empty array now just means nothing's picked
 *       -- yet, same as products/personas always worked.
 *       -- adFormatsByPlatform / objectivesByPlatform (2026-08-07, per Mo — "add a segment for ad
 *       -- format... and ad set objective... in the context tab", then "Ad format, make it a
 *       -- picklist... Ad Set Objectives - take all of the ad set objectives from linkedin ads and
 *       -- meta ads and put them as a pick list"): { [platform]: string[] }, keyed by the same
 *       -- PLATFORM_CODES platform names used in Mapping (LinkedIn/Meta/Bing/Google Search/Google
 *       -- Display/Demand Gen/Performance Max/YouTube/Capterra) — this per-platform SELECTION shape
 *       -- is unchanged. What changed is the CATALOG each platform's card picks from: previously a
 *       -- distinct best-guessed list per platform (DEFAULT_AD_FORMATS_BY_PLATFORM/
 *       -- DEFAULT_AD_SET_OBJECTIVES_BY_PLATFORM, both now deleted), now ONE shared fixed catalog for
 *       -- every platform — AD_FORMAT_OPTIONS (Video/Image/Static/GIF/Banner/Text/Spotlight/
 *       -- InMessage/Conversation/Document/Event/Carousel) and AD_SET_OBJECTIVE_OPTIONS (LinkedIn's
 *       -- Brand Awareness/Website Visits/Engagement/Video Views/Lead Generation/Website Conversions/
 *       -- Job Applicants plus Meta ODAX's Awareness/Traffic/Leads/App Promotion/Sales, "Engagement"
 *       -- deduped across the two), each with its own "+ Custom" escape hatch. What this PLAN
 *       -- intends to use per platform, deliberately separate from the Audit step's (now
 *       -- CampaignAudit.jsx, standalone) live objective/ad_format columns which reflect what's
 *       -- actually running on the connected account today. Mapping's Ad-level rows (see mapping
 *       -- shape below) source their Ad Format/Objective select options from
 *       -- context.adFormatsByPlatform[row.platform]/objectivesByPlatform[row.platform], via
 *       -- adFormatOptionsFor/adObjectiveOptionsFor which now fall back to the shared
 *       -- AD_FORMAT_OPTIONS/AD_SET_OBJECTIVE_OPTIONS catalog (not a per-platform default) when a
 *       -- platform has nothing picked yet.
 *       -- adFormats / objectives (LEGACY, 2026-08-07): the original flat, non-platform-scoped lists
 *       -- from the first version of this request. No longer read anywhere client-side (a single
 *       -- flat list can't hold LinkedIn-only formats like CTV/Spotlight alongside Google/Meta/Bing
 *       -- formats without them all bleeding across platforms) — left as-is on old rows rather than
 *       -- migrated/deleted, same posture as the budgets key below.
 *       -- budgets (LEGACY, 2026-08-07 — per Mo, "nor do I think any budget allocation should be set
 *       -- in context"): the old itemized label+$ list this UI no longer shows or writes to. Left
 *       -- as-is on old rows rather than migrated/deleted, but NOT summed into a default for the new
 *       -- Budget step's budgetTotal either (tried that briefly; per Mo, "those shouldn't be
 *       -- totalled, those are overlapping segments" — the old list mixed products/regions/personas
 *       -- with no guarantee any two lines were mutually exclusive spend, so summing it produced a
 *       -- plausible-looking but wrong number). budgetTotal just starts empty on these plans.
 *     taxonomy jsonb not null default '{}'::jsonb,          -- { dimensions, nameTemplates, utmNotes, budgetTotal, budgetCadence, channelBudget, contextBudgets, adSetBudgets }
 *       -- budgetTotal (2026-08-07, per Mo — "a net new tab just for setting budgets and allocating
 *       -- budgets per segment... we should toggle between real dollar amounts and percentages"): the
 *       -- plan's overall budget, set on the Budget step. dimensions[i].budgets/budgetMode/
 *       -- budgetPercents (per-value $ targets, unchanged since 2026-08-06/07) also live here, edited
 *       -- from the Budget step's Budget Allocation section — see
 *       -- src/components/AccountPlanning.jsx's BudgetStep/BudgetAllocation doc comments.
 *       -- budgetCadence (2026-08-07, per Mo — "are they going to be time-bound, are they going to
 *       -- be monthly, are they going to be quarterly"): { type: "monthly" | "quarterly" | "custom",
 *       -- startDate?, endDate? } — startDate/endDate only meaningful when type is "custom" (a
 *       -- specific time-bound window). Purely descriptive of how budgetTotal should be read (per
 *       -- month, per quarter, or for one fixed window) — doesn't change how any $ figure elsewhere
 *       -- in this schema is stored or computed.
 *       -- channelBudget (2026-08-07, same approval — "how does the budget map to the channel as a
 *       -- first step"): { budgets: { [platform]: amount }, budgetMode, budgetPercents } — the SAME
 *       -- $/%-toggle shape a taxonomy dimension's budgets/budgetMode/budgetPercents already use (see
 *       -- BudgetSplitCard in AccountPlanning.jsx, the shared component both now render through),
 *       -- just keyed by platform name instead of a dimension value. Compared against actual Mapping
 *       -- spend on the Mapping step's Budget rollup card via computeChannelBudgetComparison
 *       -- (accountPlanning.js) — same target-vs-actual pattern dimensions[i].budgets already had,
 *       -- extended to channel since channel isn't a taxonomy dimension.
 *       -- contextBudgets (2026-08-07, per Mo — "make sure that whatever is selected in the context
 *       -- is reflected so all of the products, personas, regions, etc.... should have a budget
 *       -- input section"): { [field]: { budgets: { [value]: amount }, budgetMode, budgetPercents } },
 *       -- field is one of "product" | "region" | "persona" | "segment" (CONTEXT_BUDGET_FIELDS,
 *       -- AccountPlanning.jsx) — the SAME $/%-toggle shape as channelBudget/dimensions[i].budgets
 *       -- above, just keyed by a Context ChipList value instead of a platform or taxonomy-dimension
 *       -- value. Reads its VALUE LIST straight from context.products/regions/personas/segments
 *       -- (segment applies the same DEFAULT_SEGMENTS fallback ContextStep itself uses) rather than
 *       -- from taxonomy.dimensions, specifically so a plan never has to keep two separate lists (one
 *       -- on Context, one on Taxonomy) in sync by hand. This is also the data adSetBudgets below
 *       -- pulls its automated per-ad-set budgets from.
 *       -- adSetBudgets (2026-08-07, same approval — "have a section for ad set budget allocation at
 *       -- the bottom... the Ad sets should be permutations of the context segments above"):
 *       -- { [comboKey]: { audienceSize?, objective?, adFormat?, budgetOverride?, deleted? } },
 *       -- comboKey is a "::"-joined persona/segment/region/product value string, one entry PER
 *       -- Cartesian-product row buildAdSetCombos (accountPlanning.js) generates from whichever of
 *       -- those four Context fields have values — confirmed via AskUserQuestion that EVERY field
 *       -- with values multiplies in, not just the three (persona/segment/region) in Mo's own
 *       -- example. The row list itself is never stored — it's rebuilt live from context + this
 *       -- object every render, so it can never drift from what Context actually says; this object
 *       -- only holds the per-row OVERRIDES (deleted is a soft-delete flag — a removed row stays
 *       -- recorded here so it doesn't silently reappear if the same Context values regenerate the
 *       -- same comboKey later). Each row's automated 30-day budget (not stored — always computed
 *       -- live via computeAdSetAutoBudget, accountPlanning.js) is planBudgetTotal times the PRODUCT
 *       -- of each active field's percentage share from contextBudgets above for that row's specific
 *       -- value in that field — confirmed via AskUserQuestion ("look at what was allocated for each
 *       -- segment, company size, region, persona, product... and build an ad set budget that
 *       -- reflects the allocation for each of those"); budgetOverride, when set, wins over that
 *       -- computed figure. Daily budget is always the effective (override-or-automated) 30-day
 *       -- figure divided by 30, never separately stored.
 *     audit_decisions jsonb not null default '{}'::jsonb,  -- LEGACY (2026-08-07) — { [groupKey]: { decision, note } }.
 *       -- Real column, still readable/writable via this API's PATCH/GET (auditDecisions, unchanged
 *       -- below) — deliberately NOT removed from the API surface, just from the wizard: Audit moved
 *       -- out of AccountPlanning.jsx entirely (see this file's top doc comment) to CampaignAudit.jsx,
 *       -- which has no plan association and never calls this endpoint with auditDecisions anymore.
 *       -- A plan saved before this change keeps whatever it already had in this column; nothing new
 *       -- will ever be written to it client-side, but the column/API path stay intact rather than
 *       -- being ripped out for a value nobody currently sends.
 *     targeting jsonb not null default '[]'::jsonb,         -- [{ id, name, method, titles, functions,
 *                                                            --   seniorities, companySizes, industries,
 *                                                            --   listAttachments, exclusionAttachments,
 *                                                            --   remarketing, notes }] — plan-scoped
 *                                                            --   Targeting Profiles; see
 *                                                            --   src/lib/accountPlanning.js and
 *                                                            --   targeting-library.js's own doc
 *                                                            --   comment for the workspace-shared
 *                                                            --   list/exclusion/remarketing items
 *                                                            --   these attachments reference by id.
 *     mapping jsonb not null default '[]'::jsonb,           -- [{ oldKey, oldName, oldCampaignGroup, platform,
 *                                                            --   level, parentKey, action, manualName, dimValues,
 *                                                            --   status, targetingProfileId, budget, flightType,
 *                                                            --   startDate, endDate, adFormat, objective }]
 *       -- platform (2026-08-07, per Mo — "I think we need to start actually at the channel
 *       -- selection as the first part of the campaign builder"): chosen ONCE per campaign, via
 *       -- Mapping's channel tab bar, and locked — every ad set/ad created under that campaign
 *       -- inherits it at creation time and there's no UI to change a row's platform afterward. Old
 *       -- rows saved before this change may still have platform: "" (the old per-row Channel
 *       -- Select let a plan skip setting one) — Mapping still shows these under a fallback
 *       -- "Unspecified" tab rather than hiding them.
 *       -- adFormat / objective (2026-08-07, same approval): only meaningful on level: "ad" rows.
 *       -- Options offered in the UI come from context.adFormatsByPlatform[platform]/
 *       -- objectivesByPlatform[platform] (see context's own doc comment above) — free text
 *       -- underneath, not enum-constrained, same as everywhere else in this schema.
 *     created_by uuid,
 *     created_at timestamptz not null default now(),
 *     updated_at timestamptz not null default now()
 *   );
 *   create index if not exists idx_account_plans_workspace on core.account_plans(workspace_id);
 *
 *   -- Migrating an existing account_plans table (2026-08-06, adding Targeting):
 *   alter table core.account_plans add column if not exists targeting jsonb not null default '[]'::jsonb;
 *
 * GET    /account-plans                 — list, metadata only (no context/taxonomy/audit_decisions/
 *        targeting/mapping bodies — same "cheap list, full fetch on demand" shape as
 *        vault-entries.js's GET).
 * GET    /account-plans?planId=<id>     — one plan, full body.
 * POST   /account-plans                 — create. Body: { name }. Everything else starts empty.
 * PATCH  /account-plans                 — update. Body: { planId, name?, status?, activeStep?,
 *        context?, taxonomy?, auditDecisions?, targeting?, mapping? } — partial, COALESCE'd, only
 *        send what changed (mirrors vault-entries.js PATCH).
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
  targeting: r.targeting || [],
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
      planId: bodyPlanId, name, status, activeStep, context, taxonomy, auditDecisions, targeting, mapping,
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
        targeting = coalesce(${targeting != null ? JSON.stringify(targeting) : null}::jsonb, targeting),
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
