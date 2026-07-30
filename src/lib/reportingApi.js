/**
 * Client for BudgetHQ's own /api/workspaces/[id]/reporting-facts route (not paidhq-core — same
 * split as spend-rows.js/workspaceApi.js: paidhq-core owns auth/workspace/entitlement, this
 * product's own /api routes query the shared core.* tables directly via a schema-qualified query,
 * same physical database). Ported from ReportingHQ (2026-07-30, per Mo — folding ReportingHQ into
 * BudgetHQ as a "Reporting Analyzer" tab), unchanged apart from this doc comment.
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

// filters: { periodType, start, end, campaignName, tags } — tags is a plain object, e.g.
// { Product: "Spreadsheet Server" }, matched by containment (rows whose tags include at least
// these key/values), not full equality.
export function listReportingFacts(session, workspaceId, filters = {}) {
  const qs = new URLSearchParams();
  if (filters.periodType) qs.set("period_type", filters.periodType);
  if (filters.start) qs.set("start", filters.start);
  if (filters.end) qs.set("end", filters.end);
  if (filters.campaignName) qs.set("campaign_name", filters.campaignName);
  if (filters.tags && Object.keys(filters.tags).length) qs.set("tags", JSON.stringify(filters.tags));
  const q = qs.toString();
  return api(session, workspaceId, q ? `?${q}` : "").then((d) => d.rows || []);
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

// This workspace's current tag dimension NAMES (same list as Campaign Tagger — e.g. Product,
// Region, Funnel, Pillar, Branded Search, Module, Brand, user-editable per workspace) plus known
// VALUES for each, and known Campaign values — pulled from this workspace's own reporting_facts
// history plus Campaign Tagger's tags and spend_rows, so the Reporting Analyzer's import review
// table offers the same vocabulary already used elsewhere in BudgetHQ. See
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
