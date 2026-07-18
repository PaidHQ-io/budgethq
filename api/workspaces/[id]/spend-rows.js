/**
 * /api/workspaces/[id]/spend-rows
 *
 * GET    ?start=YYYY-MM-DD&end=YYYY-MM-DD&platform=Google — list rows, optionally filtered.
 *        No filters returns everything for the workspace (fine at current data volumes; add
 *        pagination if a workspace's history grows large enough for this to matter).
 * POST   Body: { rows: [...] } — bulk insert. Pure append, no merge/de-dupe server-side — the
 *        existing client-side mergeRows() logic (matching on campaign identity + date, preferring
 *        the most complete row) stays the source of truth for what "duplicate" means, at least
 *        until the data-layer migration step decides whether that logic moves server-side too.
 * DELETE ?platform=Google&start=...&end=... — mirrors the existing "Clear Tagger data by
 *        channel" / "by date range" Settings panels. At least one filter is required; DELETE with
 *        no filters at all is rejected to avoid an accidental full wipe via a malformed request.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

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
    const inputRows = (req.body || {}).rows;
    if (!Array.isArray(inputRows) || !inputRows.length) {
      return res.status(400).json({ error: "rows must be a non-empty array" });
    }
    // Neon's serverless driver doesn't support a multi-row VALUES bind in one tagged-template
    // call, so insert in a batch via Promise.all rather than N sequential round trips.
    const inserted = await Promise.all(inputRows.map((r) => sql`
      insert into budgethq.spend_rows
        (workspace_id, campaign_group_name, campaign_name, campaign_id, platform, campaign_type,
         date, as_of_date, spend, impressions, clicks, source)
      values
        (${workspaceId}, ${r.campaign_group_name || ""}, ${r.campaign_name || ""}, ${r.campaign_id || null},
         ${r.platform || null}, ${r.campaign_type || null}, ${r.date}, ${r.as_of_date || null},
         ${r.spend || 0}, ${r.impressions || 0}, ${r.clicks || 0}, ${r.source || null})
      returning id
    `));
    return res.status(201).json({ inserted: inserted.length });
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

  res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
