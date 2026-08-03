/**
 * GET /api/cron/sync-connectors — Vercel Cron entrypoint (see vercel.json's `crons` array), runs
 * once a day.
 *
 * AUTH: not reachable by a normal user session at all — no workspaceId, no Authorization JWT from
 * a browser. Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` when IT invokes this
 * path (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs); this handler checks
 * that header against the CRON_SECRET env var and 401s anything else. Mo needs to add CRON_SECRET
 * (any random 16+ char string) to the Vercel project's env vars for this to actually authorize —
 * without it, every invocation 401s and no rolling connection ever syncs. There's no per-workspace
 * user check here the way every other route has one: this job is authorized as a whole to touch
 * every workspace that's opted a connection into rolling sync (sync_mode = 'rolling'), same as any
 * background job in a multi-tenant product.
 *
 * WHY ONE DAILY HEARTBEAT COVERS BOTH "daily" AND "weekly" FREQUENCIES: Vercel Hobby projects can
 * only run a cron job once per day — a more frequent expression fails deployment outright (see
 * https://vercel.com/docs/cron-jobs/manage-cron-jobs#cron-jobs-accuracy). Rather than needing an
 * hourly heartbeat (Pro-only) to approximate arbitrary per-workspace times of day, this runs once
 * daily and decides per-connection whether it's actually due: 'daily' connections are due every
 * run; 'weekly' ones are due once last_auto_sync_at is >= 7 days old (or has never run). This also
 * means Settings' schedule picker isn't promising an exact custom time-of-day the way Funnel.io's
 * does — see that UI's copy for how that's set as an expectation instead of implied.
 *
 * IDEMPOTENCY: Vercel's own cron docs call out that cron delivery is best-effort and can
 * occasionally skip or double-invoke a scheduled run, so this needs to be safe either way. Each
 * connection's sync is a delete-then-insert for an exact, deterministic date window (today back
 * `rolling_window_days` days) via lib/spendRowsStore.js's replaceWindow — running it twice in a row
 * produces the same end state as once, so a duplicate invocation is harmless. A missed invocation
 * just means that connection's data is one day less fresh until the next run, still bounded by the
 * configured window, not silently lost.
 */
import { sql } from "../lib/db.js";
import { runConnectorSync, refreshCredentialIfStale } from "../lib/connectorSync.js";
import { replaceWindow } from "../lib/spendRowsStore.js";
import { upsertChangeEvents } from "../lib/changeEventsStore.js";
import { getChangeEvents } from "../connectors/google.js";

const DEFAULT_WINDOW_DAYS = 14;
// Google's change_event resource only retains 30 days of history regardless of what window a
// connection's spend sync is configured for (see google.js's clampChangeEventWindow) — capped
// separately here so a workspace with e.g. rolling_window_days=90 for spend doesn't request a wider
// range than Google can ever answer.
const CHANGE_EVENT_WINDOW_DAYS = 30;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Filtering 'weekly' connections down to just the ones actually due happens right here in SQL —
  // every rolling connection gets pulled if it's 'daily', but a 'weekly' one only comes back once
  // its last_auto_sync_at is a week old or null (never run yet). paused = false excludes anything
  // the Data Sources tab's "Pause import" action has flagged — see schema.sql's doc comment on
  // that column; a paused connection stays sync_mode='rolling' underneath (so resuming doesn't
  // need the schedule re-entered) but is simply never selected here while paused is true.
  const due = await sql`
    select workspace_id, provider, credential, rolling_window_days
    from core.connector_credentials
    where sync_mode = 'rolling'
      and paused = false
      and (
        sync_frequency = 'daily'
        or last_auto_sync_at is null
        or last_auto_sync_at <= now() - interval '7 days'
      )
  `;

  const todayStr = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const row of due) {
    const workspaceId = row.workspace_id;
    const provider = row.provider;
    const days = row.rolling_window_days && row.rolling_window_days > 0 ? row.rolling_window_days : DEFAULT_WINDOW_DAYS;
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    const startDate = start.toISOString().slice(0, 10);

    try {
      const { rows } = await runConnectorSync({ workspaceId, provider, startDate, endDate: todayStr, credential: row.credential });
      const { inserted, skipped } = await replaceWindow(workspaceId, provider, startDate, todayStr, rows);
      await sql`
        update core.connector_credentials
        set last_auto_sync_at = now(), last_auto_sync_status = 'success', last_auto_sync_error = null
        where workspace_id = ${workspaceId} and provider = ${provider}
      `;
      results.push({ workspaceId, provider, status: "success", pulled: rows.length, inserted, skipped });
    } catch (err) {
      console.error(`[cron/sync-connectors] ${provider} failed for workspace ${workspaceId}:`, err);
      await sql`
        update core.connector_credentials
        set last_auto_sync_at = now(), last_auto_sync_status = 'error', last_auto_sync_error = ${String(err?.message || err).slice(0, 500)}
        where workspace_id = ${workspaceId} and provider = ${provider}
      `;
      results.push({ workspaceId, provider, status: "error", error: err?.message || String(err) });
    }
  }

  // Google Ads change_event automated pull (2026-08-19, per Mo — Change History's automated side;
  // see google.js's getChangeEvents doc comment for why Google is the only one of the five platforms
  // Mo named with a documented public change-history API). A second pass over the SAME `due` rows,
  // scoped to provider==='google' — deliberately separate from the spend loop above rather than
  // folded into runConnectorSync, since this writes to a different table (core.change_events, not
  // core.spend_rows) via a completely different upsert (upsertChangeEvents, not replaceWindow) and
  // doesn't share getSpend's row shape at all. refreshCredentialIfStale is called again here rather
  // than reusing whatever the spend loop refreshed — cheap (a no-op unless the token's actually
  // stale) and keeps this pass independently correct even if the spend loop's due-list filtering
  // ever diverges from this one's.
  for (const row of due) {
    if (row.provider !== "google") continue;
    const workspaceId = row.workspace_id;
    try {
      const cred = await refreshCredentialIfStale(workspaceId, "google", row.credential);
      const days = Math.min(
        row.rolling_window_days && row.rolling_window_days > 0 ? row.rolling_window_days : DEFAULT_WINDOW_DAYS,
        CHANGE_EVENT_WINDOW_DAYS
      );
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      const startDate = start.toISOString().slice(0, 10);
      const changeRows = await getChangeEvents({ startDate, endDate: todayStr, credential: cred });
      const { inserted, skipped } = await upsertChangeEvents(workspaceId, changeRows);
      results.push({ workspaceId, provider: "google-change-events", status: "success", pulled: changeRows.length, inserted, skipped: skipped.length });
    } catch (err) {
      console.error(`[cron/sync-connectors] google change-events failed for workspace ${workspaceId}:`, err);
      results.push({ workspaceId, provider: "google-change-events", status: "error", error: err?.message || String(err) });
    }
  }

  return res.status(200).json({ checked: due.length, results });
}
