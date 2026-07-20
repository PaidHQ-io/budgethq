/**
 * /api/workspaces/[id]/spend-rows
 *
 * GET    ?start=YYYY-MM-DD&end=YYYY-MM-DD&platform=Google — list rows, optionally filtered.
 *        No filters returns everything for the workspace (fine at current data volumes; add
 *        pagination if a workspace's history grows large enough for this to matter).
 * POST   Body: { rows: [...] } — bulk insert. Pure append, no merge/de-dupe server-side.
 * PUT    Body: { rows: [...] } — whole-dataset replace (delete everything for this workspace,
 *        then bulk insert the given array), run as one transaction so a mid-insert failure can't
 *        leave the workspace with zero rows. This is what the data-layer migration decided:
 *        mergeRows() (matching on campaign identity + date, preferring the most complete row)
 *        stays the client-side source of truth for what "duplicate" means — the frontend already
 *        holds the fully-merged mergedNormRows array in memory after every upload/sync, so
 *        treating spend_rows as a mirror of that (replace-all) avoids needing to reimplement the
 *        same merge/dedupe logic server-side. Fine at current data volumes; would need to become
 *        incremental if a workspace's row count grows large enough for whole-table replace on
 *        every change to matter.
 * DELETE ?platform=Google&start=...&end=... — mirrors the existing "Clear Tagger data by
 *        channel" / "by date range" Settings panels. At least one filter is required; DELETE with
 *        no filters at all is rejected to avoid an accidental full wipe via a malformed request.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement } from "../../lib/auth.js";
import { withApi, readJsonBody } from "../../lib/http.js";

// Body parsing is manual (readJsonBody) instead of Vercel's automatic JSON parser — see
// readJsonBody's doc comment in lib/http.js. PUT here sends a workspace's ENTIRE spend-rows
// history on every save (see the PUT doc comment below), which for an active multi-platform
// workspace routinely exceeds the automatic parser's assumptions once gzip-compressed on the
// client — this route needs the raw compressed bytes, not Vercel's already-decoded req.body.
export const config = { api: { bodyParser: false } };

const toCamel = (r) => ({
  id: r.id,
  campaign_group_name: r.campaign_group_name,
  campaign_name: r.campaign_name,
  campaign_id: r.campaign_id,
  platform: r.platform,
  campaign_type: r.campaign_type,
  date: r.date,
  as_of_date: r.as_of_date,
  spend: Number(r.spend),
  impressions: Number(r.impressions),
  clicks: Number(r.clicks),
  source: r.source,
});

// Transposes an array of row objects into parallel column arrays for a single unnest()-based bulk
// insert — see the comment above the PUT handler for why this replaced one-INSERT-per-row.
const toColumns = (rows) => ({
  campaign_group_name: rows.map((r) => r.campaign_group_name || ""),
  campaign_name: rows.map((r) => r.campaign_name || ""),
  campaign_id: rows.map((r) => r.campaign_id || null),
  platform: rows.map((r) => r.platform || null),
  campaign_type: rows.map((r) => r.campaign_type || null),
  date: rows.map((r) => r.date),
  as_of_date: rows.map((r) => r.as_of_date || null),
  spend: rows.map((r) => r.spend || 0),
  impressions: rows.map((r) => r.impressions || 0),
  clicks: rows.map((r) => r.clicks || 0),
  source: rows.map((r) => r.source || null),
});

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    const { start, end, platform } = req.query;
    const rows = await sql`
      select * from budgethq.spend_rows
      where workspace_id = ${workspaceId}
        and (${start || null}::date is null or date >= ${start || null}::date)
        and (${end || null}::date is null or date <= ${end || null}::date)
        and (${platform || null}::text is null or platform = ${platform || null})
      order by date asc
    `;
    return res.status(200).json({ rows: rows.map(toCamel) });
  }

  if (req.method === "POST") {
    const inputRows = (await readJsonBody(req)).rows;
    if (!Array.isArray(inputRows) || !inputRows.length) {
      return res.status(400).json({ error: "rows must be a non-empty array" });
    }
    // Bulk insert via unnest() — one round trip for the whole batch instead of one INSERT
    // statement per row. See the PUT handler below for why this matters.
    const c = toColumns(inputRows);
    await sql`
      insert into budgethq.spend_rows
        (workspace_id, campaign_group_name, campaign_name, campaign_id, platform, campaign_type,
         date, as_of_date, spend, impressions, clicks, source)
      select ${workspaceId}, * from unnest(
        ${c.campaign_group_name}::text[], ${c.campaign_name}::text[], ${c.campaign_id}::text[],
        ${c.platform}::text[], ${c.campaign_type}::text[], ${c.date}::date[], ${c.as_of_date}::date[],
        ${c.spend}::numeric[], ${c.impressions}::numeric[], ${c.clicks}::numeric[], ${c.source}::text[]
      )
    `;
    return res.status(201).json({ inserted: inputRows.length });
  }

  if (req.method === "PUT") {
    const inputRows = (await readJsonBody(req)).rows;
    if (!Array.isArray(inputRows)) {
      return res.status(400).json({ error: "rows must be an array" });
    }
    // PUT sends this workspace's ENTIRE spend history on every save (see the doc comment up top),
    // so this used to run as one INSERT statement PER ROW inside a transaction (via Promise.all in
    // sql.transaction) — that's thousands of sequential round trips for an active workspace, which
    // could take many seconds to tens of seconds. A save that slow routinely lost the race against
    // the user refreshing or navigating away shortly after an edit: the request would still be
    // in-flight (visible in DevTools as Network status "(pending)") when the tab unloaded, so the
    // browser killed it before it ever reached the server response — the edit was never persisted,
    // which looked exactly like "data disappears on refresh" even though the request itself never
    // errored. Rewritten to use a single unnest()-based bulk insert: the whole batch goes in ONE
    // statement instead of N, cutting a multi-thousand-row save from many seconds down to
    // near-instant.
    const c = toColumns(inputRows);
    await sql.transaction((tx) => [
      tx`delete from budgethq.spend_rows where workspace_id = ${workspaceId}`,
      ...(inputRows.length
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
    return res.status(200).json({ replaced: inputRows.length });
  }

  if (req.method === "DELETE") {
    const { platform, start, end } = req.query;
    if (!platform && !start && !end) {
      return res.status(400).json({ error: "At least one of platform/start/end is required" });
    }
    const result = await sql`
      delete from budgethq.spend_rows
      where workspace_id = ${workspaceId}
        and (${platform || null}::text is null or platform = ${platform || null})
        and (${start || null}::date is null or date >= ${start || null}::date)
        and (${end || null}::date is null or date <= ${end || null}::date)
      returning id
    `;
    return res.status(200).json({ deleted: result.length });
  }

  res.setHeader("Allow", "GET, POST, PUT, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
