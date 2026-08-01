/**
 * /api/workspaces/[id]/reporting-facts
 *
 * Ported from ReportingHQ (2026-07-30, per Mo — folding ReportingHQ's performance-reporting work
 * into PaidHQ as a "Reporting Analyzer" tab instead of running it as a separate product). Reads/
 * writes core.reporting_facts — same shared table, unchanged shape, so any workspace's data
 * imported while ReportingHQ still existed as its own app is already here with nothing to migrate.
 * Gated by PaidHQ's own requireEntitlement (product = 'paidhq') now, not a separate
 * 'reportinghq' entitlement — this is just another PaidHQ tab.
 *
 * GET    ?period_type=month&start=YYYY-MM-DD&end=YYYY-MM-DD&campaign_name=...&tags={"Product":
 *        "Spreadsheet Server"} — list facts, optionally filtered. Paginated server-side the same
 *        way spend-rows.js's GET is (see that file's INCIDENT doc comment) — a `(period_start,id)`
 *        keyset cursor via `?limit=&afterPeriodStart=&afterId=`, response includes `nextCursor`
 *        (null once exhausted). reporting_facts rows are far fewer per workspace than spend_rows
 *        today (one row per campaign per PERIOD, not per day), so this hasn't actually hit Neon's
 *        response-size cap yet — added preemptively since it's the exact same unbounded-`select *`
 *        shape that already took the whole app down once, and the Data Audit tab (2026-08-01) is
 *        about to add a second unfiltered caller of this same route. `tags` filters by exact-match
 *        containment (rows whose tags include at least the given key/value pairs), not full
 *        equality — a URL-encoded JSON object.
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
 * PATCH  Body: { updates: [{ id, tags }] } — Pipeline Tagger (2026-08-01, per Mo — a dedicated
 *        tagging tab for reporting_facts, mirroring Campaign Tagger's UX). Retags an ALREADY-STORED
 *        row in place by primary key. Deliberately separate from POST's upsert: `tags` is part of
 *        reporting_facts' own unique key (workspace_id, period_type, period_start, campaign_name,
 *        tags), so changing a row's tags via upsert would just INSERT a second, duplicate-looking
 *        row instead of correcting the existing one — a plain `UPDATE ... WHERE id = ...` is the
 *        only safe way to retag without leaving an orphaned untagged copy behind. Each update fully
 *        REPLACES that row's tags object (the caller is expected to send the merged
 *        {...oldTags,...newValue} object, same convention as Campaign Tagger's own tag-apply
 *        merging) — not a partial patch. If a retag would collide with another existing row's exact
 *        (period_type, period_start, campaign_name, tags) combination, Postgres raises a unique
 *        violation (23505) for that one update; the loop catches it per-row so one collision
 *        doesn't fail the rest of the batch, and the response's `skipped` array reports which ids
 *        failed and why (this is the "two rows for the same period should actually be merged into
 *        one" edge case — not handled automatically in v1, surfaced to the user instead of silently
 *        dropped).
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi, readJsonBody } from "../../lib/http.js";

// Manual body parsing, same reason as spend-rows.js: a workspace's screenshot/CSV imports won't
// usually be huge, but keeping this consistent with every other bulk-write route means one fewer
// thing to remember when payloads do grow.
export const config = { api: { bodyParser: false } };

const PERIOD_TYPES = ["day", "week", "month", "quarter", "year"];

// Same reasoning as spend-rows.js's DEFAULT_PAGE_LIMIT/MAX_PAGE_LIMIT — see that file's doc
// comment. reporting_facts rows carry a jsonb tags blob and a jsonb metrics blob on top of the
// plain columns spend_rows has, so this errs a little smaller per page despite today's much lower
// row counts, to keep the same wide safety margin under Neon's response-size cap.
const DEFAULT_PAGE_LIMIT = 5000;
const MAX_PAGE_LIMIT = 10000;

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
    const { period_type, start, end, campaign_name, tags, afterPeriodStart, afterId } = req.query;
    const tagsFilter = parseTagsFilter(tags);
    const parsedLimit = parseInt(req.query.limit, 10);
    const pageLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;
    // Same "cursor is one thing, not two independent filters" reasoning as spend-rows.js's GET.
    const hasCursor = Boolean(afterPeriodStart && afterId);
    const rows = await sql`
      select * from core.reporting_facts
      where workspace_id = ${workspaceId}
        and (${period_type || null}::text is null or period_type = ${period_type || null})
        and (${start || null}::date is null or period_start >= ${start || null}::date)
        and (${end || null}::date is null or period_start <= ${end || null}::date)
        and (${campaign_name || null}::text is null or campaign_name = ${campaign_name || null})
        and (${tagsFilter ? JSON.stringify(tagsFilter) : null}::jsonb is null or tags @> ${tagsFilter ? JSON.stringify(tagsFilter) : null}::jsonb)
        and (
          ${hasCursor ? afterPeriodStart : null}::date is null
          or (period_start, id) > (${hasCursor ? afterPeriodStart : null}::date, ${hasCursor ? afterId : null}::uuid)
        )
      order by period_start asc, id asc
      limit ${pageLimit}
    `;
    const last = rows.length === pageLimit ? rows[rows.length - 1] : null;
    const nextCursor = last ? { afterPeriodStart: last.period_start, afterId: last.id } : null;
    return res.status(200).json({ rows: rows.map(toCamel), nextCursor });
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

  if (req.method === "PATCH") {
    requireEditAccess(myRole);
    const inputUpdates = (await readJsonBody(req)).updates;
    if (!Array.isArray(inputUpdates) || !inputUpdates.length) {
      return res.status(400).json({ error: "updates must be a non-empty array" });
    }

    let updated = 0;
    const skipped = [];
    for (const u of inputUpdates) {
      if (!u || !u.id || typeof u.tags !== "object" || u.tags === null) {
        skipped.push({ id: u?.id, reason: "invalid" });
        continue;
      }
      try {
        const result = await sql`
          update core.reporting_facts
          set tags = ${JSON.stringify(u.tags)}::jsonb, updated_at = now()
          where id = ${u.id} and workspace_id = ${workspaceId}
          returning id
        `;
        if (result.length) updated++;
        else skipped.push({ id: u.id, reason: "not found" });
      } catch (err) {
        // 23505 = unique_violation — this retag would collide with another row sharing the same
        // (period_type, period_start, campaign_name, tags). See the doc comment above.
        skipped.push({ id: u.id, reason: err?.code === "23505" ? "conflict" : (err?.message || "error") });
      }
    }
    return res.status(200).json({ updated, skipped });
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

  res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
