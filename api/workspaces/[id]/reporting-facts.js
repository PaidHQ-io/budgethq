/**
 * /api/workspaces/[id]/reporting-facts
 *
 * Ported from ReportingHQ (2026-07-30, per Mo — folding ReportingHQ's performance-reporting work
 * into BudgetHQ as a "Reporting Analyzer" tab instead of running it as a separate product). Reads/
 * writes core.reporting_facts — same shared table, unchanged shape, so any workspace's data
 * imported while ReportingHQ still existed as its own app is already here with nothing to migrate.
 * Gated by BudgetHQ's own requireEntitlement (product = 'budgethq') now, not a separate
 * 'reportinghq' entitlement — this is just another BudgetHQ tab.
 *
 * GET    ?period_type=month&start=YYYY-MM-DD&end=YYYY-MM-DD&campaign_name=...&tags={"Product":
 *        "Spreadsheet Server"} — list facts, optionally filtered. No filters returns everything
 *        for the workspace. `tags` filters by exact-match containment (rows whose tags include at
 *        least the given key/value pairs), not full equality — a URL-encoded JSON object.
 * POST   Body: { rows: [{ source, periodType, periodStart, campaignName?, tags?, metrics }] } —
 *        upserts each row against core.reporting_facts's dedup key (workspace_id, period_type,
 *        period_start, campaign_name, tags). Re-importing an already-stored slice MERGES its
 *        metrics rather than replacing them wholesale (jsonb `||`, shallow merge: any metric key
 *        present in the new import overwrites that key's old value — per Mo, SQL/pipeline numbers
 *        keep changing for weeks after a period closes, so the latest import should win on
 *        anything it actually reports — but a metric key the new import DOESN'T mention is left
 *        untouched rather than deleted. This matters because different sources report different
 *        subsets of the metrics: a Dreamdata screenshot might show CTR/CPC/Leads that a raw CSV
 *        export omits, or vice versa — neither source should be able to silently erase fields the
 *        other already captured for the same period+tags. A genuinely new slice (new period, or a
 *        new tag combination) just inserts. See paidhq-core's db/schema.sql core.reporting_facts
 *        doc comment for the full reasoning.
 *
 *        `tags` is an arbitrary { [dimensionName]: value } object — NOT a fixed set of columns.
 *        Uses "the exact same tag dimensions" as Campaign Tagger (core.workspace_config.tag_dims —
 *        e.g. Product, Region, Funnel, Pillar, Branded Search, Module, Brand — itself user-editable
 *        per workspace), not a separate hardcoded vocabulary. This route doesn't validate tag keys
 *        against tag_dims — that's a UI-layer suggestion/consistency aid (see dimension-values.js),
 *        not a hard constraint, so tagging isn't blocked if a dimension gets renamed/removed later.
 * DELETE ?period_type=...&start=...&end=...&campaign_name=...&tags={...} — corrections/undo. At
 *        least one filter required (mirrors spend-rows.js's DELETE guard against an accidental
 *        full wipe).
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi, readJsonBody } from "../../lib/http.js";

// Manual body parsing, same reason as spend-rows.js: a workspace's screenshot/CSV imports won't
// usually be huge, but keeping this consistent with every other bulk-write route means one fewer
// thing to remember when payloads do grow.
export const config = { api: { bodyParser: false } };

const PERIOD_TYPES = ["day", "week", "month", "quarter", "year"];

function parseTagsFilter(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const toCamel = (r) => ({
  id: r.id,
  source: r.source,
  periodType: r.period_type,
  periodStart: r.period_start,
  campaignName: r.campaign_name,
  tags: r.tags,
  metrics: r.metrics,
  importedAt: r.imported_at,
  updatedAt: r.updated_at,
});

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    const { period_type, start, end, campaign_name, tags } = req.query;
    const tagsFilter = parseTagsFilter(tags);
    const rows = await sql`
      select * from core.reporting_facts
      where workspace_id = ${workspaceId}
        and (${period_type || null}::text is null or period_type = ${period_type || null})
        and (${start || null}::date is null or period_start >= ${start || null}::date)
        and (${end || null}::date is null or period_start <= ${end || null}::date)
        and (${campaign_name || null}::text is null or campaign_name = ${campaign_name || null})
        and (${tagsFilter ? JSON.stringify(tagsFilter) : null}::jsonb is null or tags @> ${tagsFilter ? JSON.stringify(tagsFilter) : null}::jsonb)
      order by period_start asc
    `;
    return res.status(200).json({ rows: rows.map(toCamel) });
  }

  if (req.method === "POST") {
    requireEditAccess(myRole);
    const inputRows = (await readJsonBody(req)).rows;
    if (!Array.isArray(inputRows) || !inputRows.length) {
      return res.status(400).json({ error: "rows must be a non-empty array" });
    }

    let upserted = 0;
    const skipped = [];
    for (const row of inputRows) {
      const periodType = row.periodType;
      const periodStart = row.periodStart;
      if (!PERIOD_TYPES.includes(periodType) || !periodStart) {
        skipped.push(row);
        continue;
      }
      await sql`
        insert into core.reporting_facts
          (workspace_id, source, period_type, period_start, campaign_name, tags, metrics, imported_at)
        values (
          ${workspaceId},
          ${row.source || ""},
          ${periodType},
          ${periodStart}::date,
          ${row.campaignName || ""},
          ${JSON.stringify(row.tags || {})}::jsonb,
          ${JSON.stringify(row.metrics || {})}::jsonb,
          now()
        )
        on conflict (workspace_id, period_type, period_start, campaign_name, tags)
        do update set
          metrics = reporting_facts.metrics || excluded.metrics,
          source = excluded.source,
          imported_at = excluded.imported_at,
          updated_at = now()
      `;
      upserted++;
    }
    return res.status(201).json({ upserted, skipped });
  }

  if (req.method === "DELETE") {
    requireEditAccess(myRole);
    const { period_type, start, end, campaign_name, tags } = req.query;
    const tagsFilter = parseTagsFilter(tags);
    if (!period_type && !start && !end && !campaign_name && !tagsFilter) {
      return res.status(400).json({ error: "At least one filter is required" });
    }
    const result = await sql`
      delete from core.reporting_facts
      where workspace_id = ${workspaceId}
        and (${period_type || null}::text is null or period_type = ${period_type || null})
        and (${start || null}::date is null or period_start >= ${start || null}::date)
        and (${end || null}::date is null or period_start <= ${end || null}::date)
        and (${campaign_name || null}::text is null or campaign_name = ${campaign_name || null})
        and (${tagsFilter ? JSON.stringify(tagsFilter) : null}::jsonb is null or tags @> ${tagsFilter ? JSON.stringify(tagsFilter) : null}::jsonb)
      returning id
    `;
    return res.status(200).json({ deleted: result.length });
  }

  res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
