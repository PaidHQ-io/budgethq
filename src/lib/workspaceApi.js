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

// Standalone Bearer-header builder (2026-07-29, per a workspace-siloing review) — same shape
// apiFetch builds internally below, exposed for call sites that don't go through apiFetch's own
// JSON-envelope handling: BudgetHQ.jsx's and BudgetManager.jsx's direct fetch("/api/analyze")
// calls (screenshot-to-data, column-mapping/export-suggestion prompts), now that that endpoint
// requires a valid Supabase Bearer token (see api/analyze.js's AUTH doc comment). src/lib/askAI.js
// takes a plain `token` string instead of a session object (it has no other dependency on the
// Supabase session shape), so its callers pass session?.access_token directly rather than using
// this helper.
export function authHeader(session) {
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
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

// { tags, tagDims, budgets, budgetDims, budgetRowMeta, budgetMetaDims, budgetImportMeta, savedViews, defaultForecastModel, updatedAt }
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

// Page size for the loop below — matches the server's own DEFAULT_PAGE_LIMIT (spend-rows.js), kept
// as a separate constant here rather than imported since this is a client bundle and that file is
// server-only; not load-bearing that the two numbers match exactly, just keeps request counts sane.
const SPEND_ROWS_PAGE_SIZE = 10000;

// Loops the paginated GET (see spend-rows.js's GET doc comment for the 507 incident this fixes —
// an unfiltered fetch of a large workspace's full history used to exceed Neon's ~64MiB HTTP
// response cap and take the ENTIRE app down on load, not just this one fetch) until the server
// reports no `nextCursor`, concatenating every page. Callers still see one flat array, same
// contract as before — this is the only call site (BudgetHQ.jsx's initial workspace-data load), so
// no other code needed to change.
export async function getSpendRows(session, workspaceId) {
  let rows = [];
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams({ limit: String(SPEND_ROWS_PAGE_SIZE) });
    if (cursor) {
      params.set("afterDate", cursor.afterDate);
      params.set("afterId", cursor.afterId);
    }
    const d = await apiFetch(
      session,
      `/api/workspaces/${encodeURIComponent(workspaceId)}/spend-rows?${params.toString()}`
    );
    rows = rows.concat(d.rows || []);
    if (!d.nextCursor) break;
    cursor = d.nextCursor;
  }
  return rows;
}

// Leaves real headroom below Vercel's hard 4.5MB Serverless Function request body limit — not
// pushed right up against it, since compression ratio can vary a little chunk to chunk and this
// needs to stay safely under the cap even in the worst case, not just on average.
const MAX_SPEND_ROWS_BODY_BYTES = 3.5 * 1024 * 1024;

function bodyByteLength(body) {
  return typeof body === "string" ? new TextEncoder().encode(body).length : body.byteLength;
}

// Whole-dataset replace — see spend-rows.js's PUT handler doc comment for why this is the
// migration's chosen sync model instead of trying to move mergeRows()'s dedupe logic server-side.
// See putWorkspaceConfig above for what fetchOpts/keepalive is for, and compressJson above for why
// this is gzipped (this is the endpoint that actually hit the 4.5MB limit in practice).
//
// CHUNKING (2026-07-27, per Mo — a large, active workspace's whole-history payload started 413'ing
// again even gzip-compressed, once its row count grew past what compression alone could keep under
// Vercel's request-size ceiling): compresses the full payload once to see if it fits in one
// request — true for the overwhelming majority of workspaces, so nothing changes for them. Only
// when it doesn't fit does this fall back to splitting `rows` into several smaller requests, sent
// SEQUENTIALLY (not in parallel — see spend-rows.js's `append` doc comment for why order matters):
// the first chunk goes through as a normal replace (clears the table, same as a single-request
// save always did), every chunk after that sets append:true so it adds to what the earlier chunks
// in this same save just wrote instead of wiping them out. A failure partway through a chunked save
// leaves SOME of the new data persisted rather than none — worse than full atomicity, but strictly
// better than the previous behavior (the whole save silently failing and nothing reaching the
// server at all). The row array itself is only ever compressed in whichever pieces actually get
// sent — the single upfront "does it fit" compress on the full array is the only unavoidable extra
// work for a workspace big enough to need chunking at all.
export async function putSpendRows(session, workspaceId, rows, fetchOpts = {}) {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/spend-rows`;
  const full = await compressJson({ rows });
  if (bodyByteLength(full.body) <= MAX_SPEND_ROWS_BODY_BYTES) {
    return apiFetch(session, path, {
      method: "PUT",
      body: full.body,
      headers: full.gzip ? { "Content-Encoding": "gzip" } : undefined,
      ...fetchOpts,
    });
  }

  // Doesn't fit in one request — estimate a chunk count from the compression ratio just measured
  // (this data compresses very uniformly given how repetitive spend rows are — same field names/
  // structure every row — so the whole array's ratio is a reliable stand-in for any slice of it),
  // then split rows into that many roughly-equal pieces and send them one at a time.
  const chunkCount = Math.max(2, Math.ceil(bodyByteLength(full.body) / MAX_SPEND_ROWS_BODY_BYTES));
  const chunkSize = Math.ceil(rows.length / chunkCount);
  let replaced = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { body, gzip } = await compressJson({ rows: chunk, append: i > 0 });
    const result = await apiFetch(session, path, {
      method: "PUT",
      body,
      headers: gzip ? { "Content-Encoding": "gzip" } : undefined,
      ...fetchOpts,
    });
    replaced += result.replaced || 0;
    skipped += result.skipped || 0;
  }
  return { replaced, skipped };
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
