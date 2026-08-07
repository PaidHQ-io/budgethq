/**
 * Client for /api/workspaces/[id]/targeting-library — Account Planning's shared (workspace-scoped,
 * not per-plan) exclusion lists / contact-company lists / remarketing pools. See that route's own
 * doc comment for the full scope reasoning.
 */
export function authHeader(session) {
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

async function api(session, workspaceId, path, options = {}) {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/targeting-library${path}`, {
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

export async function listTargetingLibraryItems(session, workspaceId) {
  const d = await api(session, workspaceId, "");
  return d.items || [];
}

// fields: { type: "list"|"exclusion"|"remarketing", name, description?, meta? }
export async function createTargetingLibraryItem(session, workspaceId, fields) {
  const d = await api(session, workspaceId, "", { method: "POST", body: JSON.stringify(fields) });
  return d.items || [];
}

// updates: { itemId, name?, description?, meta? }
export async function updateTargetingLibraryItem(session, workspaceId, updates) {
  const d = await api(session, workspaceId, "", { method: "PATCH", body: JSON.stringify(updates) });
  return d.items || [];
}

export async function deleteTargetingLibraryItem(session, workspaceId, itemId) {
  const d = await api(session, workspaceId, `?itemId=${encodeURIComponent(itemId)}`, { method: "DELETE" });
  return d.items || [];
}
