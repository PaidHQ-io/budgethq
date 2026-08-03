/**
 * Shared core.change_events upsert logic (2026-08-19) — factored out so api/workspaces/[id]/
 * change-events.js's POST (a real person, or a future "sync now" button, triggering an API-sourced
 * write with a user session) and api/cron/sync-connectors.js's automated daily pull (no user
 * session — see that file's own doc comment) both write through EXACTLY the same upsert, instead of
 * two copies slowly drifting apart. Same reasoning as connectorSync.js existing for the identical
 * purpose on the spend-rows side.
 *
 * Only handles entrySource:"api" rows (always carry an externalChangeId, upserted idempotently on
 * the partial unique index (workspace_id, platform, external_change_id) — see change-events.js's
 * schema doc comment). Manual entries still insert directly inside change-events.js's POST handler,
 * not here — they need the caller's userId for created_by, which this store has no access to (the
 * cron job never creates manual entries).
 */
import { sql } from "./db.js";

// rows: [{ platform, entityType?, entityName?, changeType, summary, details?, oldValue?, newValue?,
// changedBy?, changedAt, clientType?, externalChangeId }] — externalChangeId is REQUIRED here (every
// caller of this helper is an automated platform pull; a manual entry never has one — see doc
// comment above). Rows missing a required field are skipped rather than throwing, same "one bad row
// doesn't fail the batch" rule reporting-facts.js's POST uses.
export async function upsertChangeEvents(workspaceId, rows) {
  let inserted = 0;
  const skipped = [];
  for (const row of rows || []) {
    if (!row || !row.platform || !row.changeType || !row.summary || !row.changedAt || !row.externalChangeId) {
      skipped.push({ reason: "missing platform/changeType/summary/changedAt/externalChangeId", row });
      continue;
    }
    await sql`
      insert into core.change_events
        (workspace_id, platform, entity_type, entity_name, change_type, summary, details,
         old_value, new_value, changed_by, changed_at, entry_source, client_type,
         external_change_id, created_by, updated_at)
      values (
        ${workspaceId}, ${row.platform}, ${row.entityType || null}, ${row.entityName || null},
        ${row.changeType}, ${row.summary}, ${row.details || null}, ${row.oldValue || null},
        ${row.newValue || null}, ${row.changedBy || null}, ${row.changedAt}::timestamptz,
        'api', ${row.clientType || null}, ${row.externalChangeId}, null, now()
      )
      on conflict (workspace_id, platform, external_change_id) where external_change_id is not null
      do update set
        entity_type = excluded.entity_type,
        entity_name = excluded.entity_name,
        change_type = excluded.change_type,
        summary = excluded.summary,
        details = excluded.details,
        old_value = excluded.old_value,
        new_value = excluded.new_value,
        changed_by = excluded.changed_by,
        changed_at = excluded.changed_at,
        client_type = excluded.client_type,
        updated_at = now()
    `;
    inserted++;
  }
  return { inserted, skipped };
}
