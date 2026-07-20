/**
 * Client for BudgetHQ's own workspace-scoped API routes (/api/workspaces/[id]/...) — same-origin,
 * unlike paidhq-core's coreApi.js which calls a separate deployed service. Every call needs the
 * Supabase access token so the API's requireAuth/requireWorkspaceMember/requireEntitlement chain
 * can verify the request.
 */

// Compresses a JSON-serializable value with gzip before sending. Exists because a whole-dataset
// spend-rows PUT (see putSpendRows below) sends a workspace's ENTIRE spend history on every save —
// for an active multi-platform workspace that JSON can exceed Vercel's hard 4.5MB Serverless
// Function request body limit, which fails with a 413 that the UI never surfaced clearly. Every
// save silently failed, so new spend data never actually reached the server — the real cause
// behind a "my data keeps disappearing on refresh" report that looked like a timing bug but
// wasn't. JSON compresses very well given how repetitive spend rows are (same field names/
// structure every row), so this buys real headroom without redesigning the sync protocol.
// CompressionStream is a standard browser API (Chrome/Edge 80+, Firefox 113+, Safari 16.4+) — the
// `typeof` guard below is just a defensive fallback to uncompressed JSON on the off chance it's
// unavailable, not an expected code path.
async function compressJson(value) {
  const json = JSON.stringify(value);
  if (typeof CompressionStream === "undefined") {
    return { body: json, gzip: false };
  }
  const bytes = new TextEncoder().encode(json);
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  return { body: compressed, gzip: true };
}

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
export async function putWorkspaceConfig(session, workspaceId, config, fetchOpts = {}) {
  const { body, gzip } = await compressJson(config);
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/data`, {
    method: "PUT",
    body,
    headers: gzip ? { "Content-Encoding": "gzip" } : undefined,
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
// See putWorkspaceConfig above for what fetchOpts/keepalive is for, and compressJson above for why
// this is gzipped (this is the endpoint that actually hit the 4.5MB limit in practice).
export async function putSpendRows(session, workspaceId, rows, fetchOpts = {}) {
  const { body, gzip } = await compressJson({ rows });
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/spend-rows`, {
    method: "PUT",
    body,
    headers: gzip ? { "Content-Encoding": "gzip" } : undefined,
    ...fetchOpts,
  });
}
