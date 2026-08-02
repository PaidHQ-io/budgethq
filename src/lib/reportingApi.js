/**
 * Client for PaidHQ's own /api/workspaces/[id]/reporting-facts route (not paidhq-core — same
 * split as spend-rows.js/workspaceApi.js: paidhq-core owns auth/workspace/entitlement, this
 * product's own /api routes query the shared core.* tables directly via a schema-qualified query,
 * same physical database). Ported from ReportingHQ (2026-07-30, per Mo — folding ReportingHQ into
 * PaidHQ as a "Reporting Analyzer" tab), unchanged apart from this doc comment.
 */
export function authHeader(session) {
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

async function api(session, workspaceId, path, options = {}) {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/reporting-facts${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeader(session),
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Page size for the loop below — mirrors workspaceApi.js's getSpendRows fix (see spend-rows.js's
// GET doc comment for the 507 incident that pattern exists to prevent). reporting-facts.js's GET
// paginates server-side regardless of whether a caller asks for it, so this loop is what makes that
// invisible to every existing caller (ReportingAnalyzer's refreshHistory, and Data Audit's fetch
// below) — neither needed any changes to pick up the fix.
const REPORTING_FACTS_PAGE_SIZE = 5000;

// filters: { periodType, start, end, campaignName, tags } — tags is a plain object, e.g.
// { Product: "Spreadsheet Server" }, matched by containment (rows whose tags include at least
// these key/values), not full equality.
export async function listReportingFacts(session, workspaceId, filters = {}) {
  const baseParams = new URLSearchParams();
  if (filters.periodType) baseParams.set("period_type", filters.periodType);
  if (filters.start) baseParams.set("start", filters.start);
  if (filters.end) baseParams.set("end", filters.end);
  if (filters.campaignName) baseParams.set("campaign_name", filters.campaignName);
  if (filters.tags && Object.keys(filters.tags).length) baseParams.set("tags", JSON.stringify(filters.tags));
  baseParams.set("limit", String(REPORTING_FACTS_PAGE_SIZE));

  let rows = [];
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams(baseParams);
    if (cursor) {
      params.set("afterPeriodStart", cursor.afterPeriodStart);
      params.set("afterId", cursor.afterId);
    }
    const d = await api(session, workspaceId, `?${params.toString()}`);
    rows = rows.concat(d.rows || []);
    if (!d.nextCursor) break;
    cursor = d.nextCursor;
  }
  return rows;
}

// rows: [{ source, periodType, periodStart, campaignName?, tags?, metrics }] — tags is an
// arbitrary { [dimensionName]: value } object, not a fixed set of fields (see
// api/workspaces/[id]/reporting-facts.js and dimension-values.js for why).
export function upsertReportingFacts(session, workspaceId, rows) {
  return api(session, workspaceId, "", {
    method: "POST",
    body: JSON.stringify({ rows }),
  });
}

// updates: [{ id, tags }] — tags fully REPLACES that row's tags object (send the merged
// {...oldTags,...newValue}, same convention Campaign Tagger's own tag-apply uses). Returns
// { updated, skipped: [{id,reason}] } — see reporting-facts.js's PATCH doc comment for why a
// per-row collision doesn't fail the whole batch.
export function patchReportingFactsTags(session, workspaceId, updates) {
  return api(session, workspaceId, "", {
    method: "PATCH",
    body: JSON.stringify({ updates }),
  });
}

// filters: { campaignName?, tags? } (periodType/start/end also accepted, unused by Pipeline
// Tagger's own caller today) — permanently deletes every matching reporting_facts row. Used by
// Pipeline Tagger's per-row/bulk "delete from dataset" (2026-08-03, per Mo — unlike Campaign
// Tagger's own delete, which only drops a campaign from the local in-memory spend dataset,
// reporting_facts is already live in the database the moment it's imported, so this hits the real
// DELETE endpoint rather than just filtering local state). The route requires at least one filter
// (guards against an accidental full wipe — see reporting-facts.js's DELETE doc comment) and returns
// { deleted: <count> }.
export function deleteReportingFacts(session, workspaceId, filters = {}) {
  const params = new URLSearchParams();
  if (filters.periodType) params.set("period_type", filters.periodType);
  if (filters.start) params.set("start", filters.start);
  if (filters.end) params.set("end", filters.end);
  if (filters.campaignName) params.set("campaign_name", filters.campaignName);
  if (filters.tags && Object.keys(filters.tags).length) params.set("tags", JSON.stringify(filters.tags));
  return api(session, workspaceId, `?${params.toString()}`, { method: "DELETE" });
}

// This workspace's current tag dimension NAMES (same list as Campaign Tagger — e.g. Product,
// Region, Funnel, Pillar, Branded Search, Module, Brand, user-editable per workspace) plus known
// VALUES for each, and known Campaign values — pulled from this workspace's own reporting_facts
// history plus Campaign Tagger's tags and spend_rows, so the Reporting Analyzer's import review
// table offers the same vocabulary already used elsewhere in PaidHQ. See
// api/workspaces/[id]/dimension-values.js for the merge logic.
// Returns { tagDims: string[], values: { [dimensionName]: string[] }, campaignName: string[] }.
export async function getDimensionValues(session, workspaceId) {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/dimension-values`, {
    headers: { ...authHeader(session) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}
