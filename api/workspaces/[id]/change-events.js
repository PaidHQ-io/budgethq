/**
 * /api/workspaces/[id]/change-events
 *
 * Change History (2026-08-19, per Mo — "I made some changes to google budgets and enabling/
 * disabling campaigns and ad groups. I want that context saved in PaidHQ. Can we create a change
 * history section that automatically pulls in non automated and non bulk edit changes from Google,
 * Bing, Meta and LinkedIn and Capterra?"). Scope per Mo's follow-up answers: build for ALL channels
 * (including ones with no automated pull yet, and future ones like Reddit/TikTok/YouTube) via a
 * manual-entry fallback, with a unified filterable feed categorized by change type. New dedicated
 * tab (ChangeHistory.jsx), not folded into an existing tab.
 *
 * A "change event" is either:
 *   - entrySource: "api" — pulled automatically from a platform's own change-history API (Google
 *     Ads' change_event GAQL resource is the first one wired up — see api/connectors/google.js).
 *     Only genuinely human, non-bulk edits are meant to land here (Mo — "non automated and non
 *     bulk edit changes"); each platform's sync job is responsible for filtering out its own
 *     automated/bulk/API/scripted sources before writing (Google's client_type field is the
 *     mechanism — see that connector file). client_type/external_change_id are populated; the
 *     latter makes the pull idempotent across repeat syncs (on conflict do update).
 *   - entrySource: "manual" — logged by a workspace member for a platform with no change-history
 *     API (Bing, LinkedIn — no known public API for this; Capterra isn't an ad-buying platform at
 *     all so "changes" don't really apply there, but the manual path still works if someone wants
 *     to log something) or for anything the automated pull hasn't covered yet. created_by records
 *     who logged it; client_type/external_change_id are always null.
 *
 * platform is free text (not server-validated) — same looseness as reporting_facts' tags — but the
 * UI's dropdown is expected to offer core.js's own PLATFORM_OPTIONS vocabulary (already includes
 * Reddit/TikTok/YouTube placeholders for future platforms, per Mo's "additional channels in the
 * future" ask) so this table never needs its own separate platform list.
 *
 * GET    ?platform=&change_type=&entry_source=&entity_name=&changed_by=&start=&end=&limit=&
 *        afterChangedAt=&afterId= — list events, newest first, optionally filtered. entity_name is
 *        a case-insensitive substring match (campaign/ad-group search), everything else is an exact
 *        match. Keyset-paginated the same way reporting-facts.js's GET is (see that file's doc
 *        comment for why) — a `(changed_at, id)` cursor, DESCENDING here since a feed reads newest-
 *        first, response includes `nextCursor` (null once exhausted).
 * POST   Body: { rows: [{ platform, entityType?, entityName?, changeType, summary, details?,
 *        oldValue?, newValue?, changedBy?, changedAt, entrySource?, clientType?,
 *        externalChangeId? }] } — entrySource defaults to "manual" (created_by = caller) when
 *        omitted. Rows with entrySource "api" + externalChangeId upsert idempotently on
 *        (workspace_id, platform, external_change_id); everything else (manual entries, or any "api"
 *        row missing an externalChangeId) is a plain insert. A manual "+ Log a change" form submits
 *        one row via this same endpoint (rows: [theOneRow]) — no separate manual-entry route.
 * POST   ?sync=<provider> — on-demand pull (2026-08-19, per Mo — "I don't see anything logged from
 *        Google. How do we get it into PaidHQ?"). The automated path (api/cron/sync-connectors.js)
 *        only runs once a day AND only for connections opted into sync_mode='rolling' — this gives
 *        an immediate, error-surfacing way to pull right now regardless of that connection's mode,
 *        same "manual sync now" convention as the Data Sources tab's per-platform sync button (see
 *        src/PaidHQ.jsx's syncPlatform), just persisting server-side here instead of merging client-
 *        side (this route already owns core.change_events directly). Only "google" is wired up today
 *        (400 for anything else — no other platform has an automated pull, see the doc comment
 *        above). Pulls the last 30 days (Google's own change_event retention ceiling — see
 *        google.js's clampChangeEventWindow) and upserts via the same changeEventsStore the cron
 *        uses. No request body. Returns { pulled, inserted, skipped }.
 * DELETE ?id=<uuid> — removes ONE event, manual entries only (entry_source = 'manual'). API-sourced
 *        rows aren't deletable here by design — they're expected to stay in sync with the platform's
 *        own history via the idempotent upsert; deleting one would just have the next sync recreate
 *        it. Returns 403 if the target row exists but is entry_source = 'api'.
 *
 * SCHEMA (needs to be added in paidhq-core, which owns core.* migrations — not in this checkout):
 *   create table if not exists core.change_events (
 *     id uuid primary key default gen_random_uuid(),
 *     workspace_id uuid not null references core.workspaces(id) on delete cascade,
 *     platform text not null,
 *     entity_type text,
 *     entity_name text,
 *     change_type text not null,
 *     summary text not null,
 *     details text,
 *     old_value text,
 *     new_value text,
 *     changed_by text,
 *     changed_at timestamptz not null,
 *     entry_source text not null default 'manual',
 *     client_type text,
 *     external_change_id text,
 *     created_by uuid,
 *     created_at timestamptz not null default now(),
 *     updated_at timestamptz not null default now()
 *   );
 *   create index if not exists idx_change_events_workspace_changed_at
 *     on core.change_events (workspace_id, changed_at desc, id desc);
 *   create index if not exists idx_change_events_workspace_platform
 *     on core.change_events (workspace_id, platform);
 *   create index if not exists idx_change_events_workspace_change_type
 *     on core.change_events (workspace_id, change_type);
 *   create unique index if not exists uq_change_events_external
 *     on core.change_events (workspace_id, platform, external_change_id)
 *     where external_change_id is not null;
 *   Match workspace_id's exact column type to whatever core.reporting_facts already uses for it
 *   (uuid almost certainly — confirm against that table's own migration before running this).
 *   created_by references a workspace member's user id (same type core.workspace_members.user_id
 *   uses) — left un-FK'd here deliberately, same reasoning as most of this app's other "who did it"
 *   columns, so a since-removed member's past manual entries don't get orphaned/deleted.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi, readJsonBody } from "../../lib/http.js";
import { upsertChangeEvents } from "../../lib/changeEventsStore.js";
import { refreshCredentialIfStale } from "../../lib/connectorSync.js";
import { getChangeEvents } from "../../connectors/google.js";

// provider -> its getChangeEvents-shaped puller. Only Google has one today (see this route's own
// doc comment) — deliberately a lookup map, not an if/else on "google" specifically, so wiring up a
// second platform later (if one of Bing/LinkedIn/Meta ever ships a real change-history API) is a
// one-line addition here rather than a new branch.
const CHANGE_EVENT_PULLERS = { google: getChangeEvents };
// Matches google.js's own CHANGE_EVENT_MAX_LOOKBACK_DAYS — duplicated here as a plain constant
// (rather than importing that private value) since it's just how far back this endpoint's manual
// pull requests data for, not a hard cap enforced by google.js's own clampChangeEventWindow (which
// would silently clamp a wider request anyway either way).
const SYNC_LOOKBACK_DAYS = 30;

// Manual body parsing, same convention as reporting-facts.js/spend-rows.js for every bulk-write route.
export const config = { api: { bodyParser: false } };

const DEFAULT_PAGE_LIMIT = 5000;
const MAX_PAGE_LIMIT = 10000;

const toCamel = (r) => ({
  id: r.id,
  platform: r.platform,
  entityType: r.entity_type,
  entityName: r.entity_name,
  changeType: r.change_type,
  summary: r.summary,
  details: r.details,
  oldValue: r.old_value,
  newValue: r.new_value,
  changedBy: r.changed_by,
  changedAt: r.changed_at,
  entrySource: r.entry_source,
  clientType: r.client_type,
  externalChangeId: r.external_change_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    const { platform, change_type, entry_source, entity_name, changed_by, start, end, afterChangedAt, afterId } = req.query;
    const parsedLimit = parseInt(req.query.limit, 10);
    const pageLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;
    // Same "cursor is one thing, not two independent filters" reasoning as reporting-facts.js's GET —
    // descending here (newest-first feed) so the cursor comparison is `<` not `>`.
    const hasCursor = Boolean(afterChangedAt && afterId);
    const rows = await sql`
      select * from core.change_events
      where workspace_id = ${workspaceId}
        and (${platform || null}::text is null or platform = ${platform || null})
        and (${change_type || null}::text is null or change_type = ${change_type || null})
        and (${entry_source || null}::text is null or entry_source = ${entry_source || null})
        and (${entity_name || null}::text is null or entity_name ilike ${entity_name ? `%${entity_name}%` : null})
        and (${changed_by || null}::text is null or changed_by = ${changed_by || null})
        and (${start || null}::timestamptz is null or changed_at >= ${start || null}::timestamptz)
        and (${end || null}::timestamptz is null or changed_at <= ${end || null}::timestamptz)
        and (
          ${hasCursor ? afterChangedAt : null}::timestamptz is null
          or (changed_at, id) < (${hasCursor ? afterChangedAt : null}::timestamptz, ${hasCursor ? afterId : null}::uuid)
        )
      order by changed_at desc, id desc
      limit ${pageLimit}
    `;
    const last = rows.length === pageLimit ? rows[rows.length - 1] : null;
    const nextCursor = last ? { afterChangedAt: last.changed_at, afterId: last.id } : null;
    return res.status(200).json({ rows: rows.map(toCamel), nextCursor });
  }

  if (req.method === "POST" && req.query.sync) {
    requireEditAccess(myRole);
    const provider = String(req.query.sync).toLowerCase();
    const puller = CHANGE_EVENT_PULLERS[provider];
    if (!puller) {
      return res.status(400).json({
        error: `No automated change-history pull is wired up for "${provider}" yet — only Google Ads has one so far. Log changes for other platforms with "+ Log a change" instead.`,
      });
    }
    const credRows = await sql`
      select credential from core.connector_credentials where workspace_id = ${workspaceId} and provider = ${provider}
    `;
    if (!credRows.length) {
      return res.status(400).json({
        error: `This workspace hasn't connected ${provider} yet — connect it from Data Sources first.`,
        code: "not_connected",
      });
    }
    const credential = await refreshCredentialIfStale(workspaceId, provider, credRows[0].credential);
    const end = new Date();
    const endDate = end.toISOString().slice(0, 10);
    const start = new Date(end);
    start.setDate(start.getDate() - (SYNC_LOOKBACK_DAYS - 1));
    const startDate = start.toISOString().slice(0, 10);
    // Let a getChangeEvents failure (missing accessToken/accountId, an unapproved developer token,
    // a GAQL fault, etc.) propagate up to withApi's catch — surfacing the REAL error message here is
    // the whole point of this endpoint (see doc comment: Mo asked "how do we get it into PaidHQ" when
    // nothing showed up, and the honest first answer is often "here's exactly why it's failing").
    const rows = await puller({ startDate, endDate, credential });
    const result = await upsertChangeEvents(workspaceId, rows);
    return res.status(200).json({ pulled: rows.length, inserted: result.inserted, skipped: result.skipped });
  }

  if (req.method === "POST") {
    requireEditAccess(myRole);
    const inputRows = (await readJsonBody(req)).rows;
    if (!Array.isArray(inputRows) || !inputRows.length) {
      return res.status(400).json({ error: "rows must be a non-empty array" });
    }

    // Split into api-sourced (has externalChangeId — upserted idempotently via the shared store, see
    // changeEventsStore.js) vs manual (inserted directly here since only this route has the caller's
    // userId for created_by — see that store's own doc comment for why it doesn't handle these).
    const apiRows = [];
    const manualRows = [];
    const skipped = [];
    for (const row of inputRows) {
      if (!row || !row.platform || !row.changeType || !row.summary || !row.changedAt) {
        skipped.push({ reason: "missing platform/changeType/summary/changedAt", row });
        continue;
      }
      const entrySource = row.entrySource === "api" ? "api" : "manual";
      if (entrySource === "manual" && row.externalChangeId) {
        // Manual entries never carry an external id — see doc comment on why only "api" rows upsert.
        skipped.push({ reason: "manual entries cannot have an externalChangeId", row });
        continue;
      }
      if (entrySource === "api" && row.externalChangeId) apiRows.push(row);
      else manualRows.push(row);
    }

    let inserted = 0;
    if (apiRows.length) {
      const result = await upsertChangeEvents(workspaceId, apiRows);
      inserted += result.inserted;
      skipped.push(...result.skipped);
    }
    for (const row of manualRows) {
      await sql`
        insert into core.change_events
          (workspace_id, platform, entity_type, entity_name, change_type, summary, details,
           old_value, new_value, changed_by, changed_at, entry_source, client_type,
           external_change_id, created_by, updated_at)
        values (
          ${workspaceId}, ${row.platform}, ${row.entityType || null}, ${row.entityName || null},
          ${row.changeType}, ${row.summary}, ${row.details || null}, ${row.oldValue || null},
          ${row.newValue || null}, ${row.changedBy || null}, ${row.changedAt}::timestamptz,
          'manual', null, null, ${userId}, now()
        )
      `;
      inserted++;
    }
    return res.status(201).json({ inserted, skipped });
  }

  if (req.method === "DELETE") {
    requireEditAccess(myRole);
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id is required" });
    const existing = await sql`
      select entry_source from core.change_events where id = ${id} and workspace_id = ${workspaceId}
    `;
    if (!existing.length) return res.status(200).json({ deleted: 0 });
    if (existing[0].entry_source !== "manual") {
      const err = new Error("Only manually-logged entries can be deleted");
      err.status = 403;
      throw err;
    }
    const result = await sql`
      delete from core.change_events where id = ${id} and workspace_id = ${workspaceId}
      returning id
    `;
    return res.status(200).json({ deleted: result.length });
  }

  res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
