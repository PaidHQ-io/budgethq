/**
 * Server-side (no user session) spend_rows writer for api/cron/sync-connectors.js. The existing
 * api/workspaces/[id]/spend-rows.js HTTP route can't be reused directly here — its DELETE/POST both
 * require a real user's Authorization header (requireAuth/requireWorkspaceMember/requireEntitlement/
 * requireEditAccess), and the cron job has no user session at all (see that file's own doc comment
 * for why it's authorized as a whole via CRON_SECRET instead). This exports the same underlying
 * "delete this window, then bulk-insert fresh rows" operation as a plain function, sharing
 * toColumns/normalizeDate from lib/spendRowsColumns.js so the date handling is identical either way.
 */
import { sql } from "./db.js";
import { toColumns } from "./spendRowsColumns.js";

// Replaces spend_rows for one workspace+platform within [startDate, endDate] (inclusive) with the
// given rows — used for a rolling-sync's re-pulled window. Deterministic: running this twice with
// the same inputs produces the same end state, which is what makes it safe against Vercel Cron's
// best-effort delivery (occasional duplicate invocations) — see sync-connectors.js's doc comment.
// BUGFIX (2026-08-19, per Mo — "linkedin is showing higher spend again," found investigating
// alongside core.js's spendRowKey and spendRowsColumns.js's dedupeByIdentity fixes): this insert
// statement was missing ad_name/ad_id from BOTH its column list and its unnest() array list, even
// though toColumns (called right above) already computes c.ad_name/c.ad_id correctly — every row
// this function ever wrote silently lost its ad-level identity on the way into the database,
// regardless of what the connector itself resolved. That's a real gap on its own (no ad-level
// tagging possible for anything written through this path), and it's also exactly the kind of thing
// that can make a duplicate-spend problem look "fixed then un-fixed": a manual Full resync (which
// goes through the OTHER write path — api/workspaces/[id]/spend-rows.js's upsert, which DOES include
// ad_name/ad_id in its conflict identity) can correctly write ad-level rows once, but if this
// function's caller ever runs again for the same window afterward, it deletes those correctly-
// identified rows and reinserts them with ad_name/ad_id both null — collapsing what should still be
// distinct per-ad rows down to ambiguous ones, and reopening the door for the NEXT upsert to fail to
// match them by identity and insert fresh duplicates instead of updating in place. Fixed here for
// correctness/consistency with the shared toColumns/dedupeByIdentity contract (this file mirrors
// paidhq-core's copy of the same module, per this codebase's established "mirror X into paidhq-core"
// pattern) — this specific file has no caller in THIS checkout (the live cron lives in paidhq-core,
// a separate repo), so if paidhq-core's own copy of this function has the identical gap, that's the
// one actually responsible for a recurring duplicate and needs the same fix applied there directly.
export async function replaceWindow(workspaceId, platform, startDate, endDate, rows) {
  const c = toColumns(rows.map((r) => ({ ...r, platform: r.platform || platform, source: r.source || `sync:${platform}` })));
  const insertedCount = c.date.length;
  await sql.transaction((tx) => [
    tx`
      delete from core.spend_rows
      where workspace_id = ${workspaceId} and platform = ${platform}
        and date >= ${startDate}::date and date <= ${endDate}::date
    `,
    ...(insertedCount > 0
      ? [tx`
          insert into core.spend_rows
            (workspace_id, campaign_group_name, campaign_name, campaign_id, ad_name, ad_id, platform,
             campaign_type, date, as_of_date, spend, impressions, clicks, source, extra_metrics)
          select ${workspaceId}, * from unnest(
            ${c.campaign_group_name}::text[], ${c.campaign_name}::text[], ${c.campaign_id}::text[],
            ${c.ad_name}::text[], ${c.ad_id}::text[],
            ${c.platform}::text[], ${c.campaign_type}::text[], ${c.date}::date[], ${c.as_of_date}::date[],
            ${c.spend}::numeric[], ${c.impressions}::numeric[], ${c.clicks}::numeric[], ${c.source}::text[],
            ${c.extra_metrics}::jsonb[]
          )
        `]
      : []),
  ]);
  return { inserted: insertedCount, skipped: c.skipped };
}
