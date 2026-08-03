/**
 * Client for /api/workspaces/[id]/change-events (see that file's doc comment for the full shape/
 * reasoning). Same request/pagination/error conventions as reportingApi.js.
 */
import { authHeader } from "./reportingApi.js";

async function api(session, workspaceId, path, options = {}) {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/change-events${path}`, {
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

const PAGE_SIZE = 5000;

// filters: { platform, changeType, entrySource, entityName, changedBy, start, end } — entityName is
// a substring match, everything else exact. Loops the server's keyset cursor to return every
// matching row, newest-first (mirrors listReportingFacts's pagination loop).
export async function listChangeEvents(session, workspaceId, filters = {}) {
  const baseParams = new URLSearchParams();
  if (filters.platform) baseParams.set("platform", filters.platform);
  if (filters.changeType) baseParams.set("change_type", filters.changeType);
  if (filters.entrySource) baseParams.set("entry_source", filters.entrySource);
  if (filters.entityName) baseParams.set("entity_name", filters.entityName);
  if (filters.changedBy) baseParams.set("changed_by", filters.changedBy);
  if (filters.start) baseParams.set("start", filters.start);
  if (filters.end) baseParams.set("end", filters.end);
  baseParams.set("limit", String(PAGE_SIZE));

  let rows = [];
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams(baseParams);
    if (cursor) {
      params.set("afterChangedAt", cursor.afterChangedAt);
      params.set("afterId", cursor.afterId);
    }
    const d = await api(session, workspaceId, `?${params.toString()}`);
    rows = rows.concat(d.rows || []);
    if (!d.nextCursor) break;
    cursor = d.nextCursor;
  }
  return rows;
}

// rows: [{ platform, entityType?, entityName?, changeType, summary, details?, oldValue?, newValue?,
// changedBy?, changedAt, entrySource?, clientType?, externalChangeId? }]. A manual "+ Log a change"
// form just calls this with a single-row array; entrySource defaults server-side to "manual".
export function createChangeEvents(session, workspaceId, rows) {
  return api(session, workspaceId, "", {
    method: "POST",
    body: JSON.stringify({ rows }),
  });
}

// Convenience wrapper for the common single-manual-entry case.
export function logManualChangeEvent(session, workspaceId, entry) {
  return createChangeEvents(session, workspaceId, [{ ...entry, entrySource: "manual" }]);
}

// Manual entries only — see change-events.js's DELETE doc comment for why API-sourced rows 403.
export function deleteChangeEvent(session, workspaceId, id) {
  return api(session, workspaceId, `?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

// UI-facing vocabulary for the change-type dropdown/filter — not server-validated (same looseness
// as tags), just the suggested/default set so entries stay consistent across users.
export const CHANGE_TYPE_OPTIONS = [
  "budget", "status", "bid_strategy", "targeting", "creative", "keyword", "audience", "other",
];
export const CHANGE_TYPE_LABELS = {
  budget: "Budget", status: "Status (enable/pause)", bid_strategy: "Bid strategy",
  targeting: "Targeting", creative: "Creative", keyword: "Keyword", audience: "Audience", other: "Other",
};

export const ENTITY_TYPE_OPTIONS = ["campaign", "ad_group", "ad", "keyword", "audience", "account", "other"];
export const ENTITY_TYPE_LABELS = {
  campaign: "Campaign", ad_group: "Ad group", ad: "Ad", keyword: "Keyword",
  audience: "Audience", account: "Account", other: "Other",
};
