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

// Ask AI chat history — scoped to the CALLER's own account within this workspace (see
// api/workspaces/[id]/ai-chats.js's doc comment for why this isn't shared workspace-wide like
// tags/budgets are). Replaces the old single global `localStorage["paidhq_ask_chats"]` key, which
// had no workspace scoping at all.
//
// Returns/accepts { chats, projects } as of 2026-07-21 — projects are the folder-like grouping
// chats can be filed under (pinning and labels live directly on each chat record instead, no
// separate table needed for those). See ai-chats.js for the storage-shape migration note.
export function getAskAIData(session, workspaceId) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/ai-chats`).then(
    (d) => ({ chats: d.chats || [], projects: d.projects || [] })
  );
}

export function putAskAIData(session, workspaceId, { chats, projects }) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/ai-chats`, {
    method: "PUT",
    body: JSON.stringify({ chats, projects }),
  });
}

// Version History — scoped per workspace (see api/workspaces/[id]/versions.js). Replaces the old
// IndexedDB-based store, which used one fixed database name shared across every workspace opened
// in this browser.
export function listVersions(session, workspaceId) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/versions`).then(
    (d) => d.versions || []
  );
}

export function saveVersion(session, workspaceId, { label, trigger, snapshot }) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/versions`, {
    method: "POST",
    body: JSON.stringify({ label, trigger, snapshot }),
  });
}

export function deleteVersion(session, workspaceId, id) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/versions?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// File Store — scoped per workspace (see api/workspaces/[id]/files.js). Replaces the old
// IndexedDB-based store, same fixed-database-name problem as Version History above.
export function listFiles(session, workspaceId) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/files`).then(
    (d) => d.files || []
  );
}

export function uploadFile(session, workspaceId, { name, category, mimeType, dataBase64 }) {
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/files`, {
    method: "POST",
    body: JSON.stringify({ name, category, mimeType, dataBase64 }),
  });
}

export function deleteFile(session, workspaceId, id) {
  // Query param is named fileId, not id -- see files.js's DELETE handler doc comment: `id` collides
  // with this route's own [id] (workspace) dynamic segment and silently breaks the delete.
  return apiFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/files?fileId=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// Cross-workspace file sharing (opt-in, explicit) — copies one file into another workspace the
// caller also belongs to. See api/workspaces/[id]/files/[fileId]/copy.js for the access rules
// (view access on the source, edit access on the target).
export function copyFileToWorkspace(session, sourceWorkspaceId, fileId, targetWorkspaceId) {
  return apiFetch(
    session,
    `/api/workspaces/${encodeURIComponent(sourceWorkspaceId)}/files/${encodeURIComponent(fileId)}/copy`,
    { method: "POST", body: JSON.stringify({ targetWorkspaceId }) }
  );
}

// Downloads still go through a plain (non-JSON) fetch since the response is the raw file bytes,
// not a JSON envelope — apiFetch always tries to parse JSON, which would break on binary content.
export async function downloadFile(session, workspaceId, id, filename) {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?download=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Converts a File/Blob to a base64 string for the files.js POST body — the server expects
// dataBase64 (JSON-safe), not raw binary, since this route uses Vercel's default JSON body parser
// rather than the gzip-raw-bytes path putSpendRows/putWorkspaceConfig use.
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
