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
export async function replaceWindow(workspaceId, platform, startDate, endDate, rows) {
  const c = toColumns(rows.map((r) => ({ ...r, platform: r.platform || platform, source: r.source || `sync:${platform}` })));
  const insertedCount = c.date.length;
  await sql.transaction((tx) => [
    tx`
      delete from budgethq.spend_rows
      where workspace_id = ${workspaceId} and platform = ${platform}
        and date >= ${startDate}::date and date <= ${endDate}::date
    `,
    ...(insertedCount > 0
      ? [tx`
          insert into budgethq.spend_rows
            (workspace_id, campaign_group_name, campaign_name, campaign_id, platform, campaign_type,
             date, as_of_date, spend, impressions, clicks, source)
          select ${workspaceId}, * from unnest(
            ${c.campaign_group_name}::text[], ${c.campaign_name}::text[], ${c.campaign_id}::text[],
            ${c.platform}::text[], ${c.campaign_type}::text[], ${c.date}::date[], ${c.as_of_date}::date[],
            ${c.spend}::numeric[], ${c.impressions}::numeric[], ${c.clicks}::numeric[], ${c.source}::text[]
          )
        `]
      : []),
  ]);
  return { inserted: insertedCount, skipped: c.skipped };
}
