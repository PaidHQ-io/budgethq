/**
 * Client for BudgetHQ's own workspace-scoped API routes (/api/workspaces/[id]/...) — same-origin,
 * unlike paidhq-core's coreApi.js which calls a separate deployed service. Every call needs the
 * Supabase access token so the API's requireAuth/requireWorkspaceMember/requireEntitlement chain
 * can verify the request.
 */
async function apiFetch(session, path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
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

// { tags, tagDims, budgets, budgetDims, budgetRowMeta, budgetMetaDims, budgetImportMeta, updatedAt }
export function getWorkspaceConfig(session, workspaceId) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/data`);
}

// fetchOpts is normally omitted — it exists so the beforeunload/visibilitychange flush in
// BudgetHQ.jsx can pass `{keepalive:true}`. A plain fetch gets silently aborted the instant the
// page starts navigating away/closing; `keepalive` is the one browser mechanism that lets a fetch
// started right before unload actually finish (same purpose as navigator.sendBeacon, but usable
// here since sendBeacon can't send a custom Authorization header the way fetch can).
export function putWorkspaceConfig(session, workspaceId, config, fetchOpts = {}) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/data`, {
    method: "PUT",
    body: JSON.stringify(config),
    ...fetchOpts,
  });
}

export function getSpendRows(session, workspaceId) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/spend-rows`).then(
    (d) => d.rows || []
  );
}

// Whole-dataset replace — see spend-rows.js's PUT handler doc comment for why this is the
// migration's chosen sync model instead of trying to move mergeRows()'s dedupe logic server-side.
// See putWorkspaceConfig above for what fetchOpts/keepalive is for.
export function putSpendRows(session, workspaceId, rows, fetchOpts = {}) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/spend-rows`, {
    method: "PUT",
    body: JSON.stringify({ rows }),
    ...fetchOpts,
  });
}
