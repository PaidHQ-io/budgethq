/**
 * Client for /api/workspaces/[id]/vault-entries — Vault (Phase 1: storage/resources), per Mo
 * (2026-08-19). See that route's own doc comment for the full scope/data-model decisions.
 *
 * Attachments deliberately do NOT get their own upload/download/delete functions here — they reuse
 * workspaceApi.js's existing uploadFile/downloadFile/deleteFile (uploadFile takes an optional
 * vaultEntryId to link the upload to an entry; downloadFile/deleteFile work on a file id the same
 * way regardless of whether it's vault-linked), since Vault attachments are just core.files rows
 * with a link column, not a separate storage system.
 */
export function authHeader(session) {
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

async function api(session, workspaceId, path, options = {}) {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/vault-entries${path}`, {
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

// filters: { category, tag, search } — list view only, entries come back WITHOUT full content (a
// short excerpt instead) — see vault-entries.js's GET doc comment for why. Call getVaultEntry for
// an entry's full body + attachments.
export async function listVaultEntries(session, workspaceId, filters = {}) {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.search) params.set("search", filters.search);
  const qs = params.toString();
  const d = await api(session, workspaceId, qs ? `?${qs}` : "");
  return d.entries || [];
}

// Returns { entry, files } — entry has full content, files is that entry's attached files' metadata
// (id, name, mimeType, size, createdAt) — pass a file's id to workspaceApi.js's downloadFile to
// actually fetch its bytes.
export async function getVaultEntry(session, workspaceId, entryId) {
  const d = await api(session, workspaceId, `?entryId=${encodeURIComponent(entryId)}`);
  return d;
}

// fields: { title, category?, tags?, content? }
export async function createVaultEntry(session, workspaceId, fields) {
  const d = await api(session, workspaceId, "", { method: "POST", body: JSON.stringify(fields) });
  return d.entry;
}

// updates: { entryId, title?, category?, tags?, content? } — partial, only send what changed.
export async function updateVaultEntry(session, workspaceId, updates) {
  const d = await api(session, workspaceId, "", { method: "PATCH", body: JSON.stringify(updates) });
  return d.entry;
}

// Deletes the entry AND its attachments (cascade via the vault_entry_id FK — see migration).
export function deleteVaultEntry(session, workspaceId, entryId) {
  return api(session, workspaceId, `?entryId=${encodeURIComponent(entryId)}`, { method: "DELETE" });
}
