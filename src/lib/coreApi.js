/**
 * Thin client for paidhq-core's workspace/entitlement API — the shared service every PaidHQ
 * product points at for "who am I, which workspaces do I belong to, what am I entitled to."
 * Every call needs the Supabase access token from the current session (paidhq-core verifies it
 * against Supabase's public JWKS — see its api/lib/auth.js). VITE_CORE_API_URL is paidhq-core's
 * deployed origin (e.g. https://paidhq-core.vercel.app) — separate from BudgetHQ's own /api
 * routes since core is a standalone service shared across products, not a BudgetHQ endpoint.
 */
const CORE_API_URL = import.meta.env.VITE_CORE_API_URL;

async function coreFetch(session, path, options = {}) {
  if (!CORE_API_URL) {
    throw new Error("VITE_CORE_API_URL is not set — can't reach paidhq-core.");
  }
  const res = await fetch(`${CORE_API_URL}${path}`, {
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

export function listWorkspaces(session) {
  return coreFetch(session, "/api/workspaces").then((d) => d.workspaces || []);
}

export function createWorkspace(session, { name, kind }) {
  return coreFetch(session, "/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name, kind }),
  }).then((d) => d.workspace);
}

export function grantEntitlement(session, workspaceId, { product, plan = "trial", status = "trialing" }) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/entitlements`, {
    method: "POST",
    body: JSON.stringify({ product, plan, status }),
  });
}

// Owner or admin. Server-side role check lives in paidhq-core's workspaces/[id]/index.js.
export function renameWorkspace(session, workspaceId, name) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  }).then((d) => d.workspace);
}

// Owner only — permanently destroys the workspace and (via FK cascade, entirely server-side)
// every bit of its data across every product's schema. No undo.
export function deleteWorkspace(session, workspaceId) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "DELETE",
  });
}

// Permanently deletes a PaidHQ login (not just this browser's copy of it — see AuthGate.jsx's
// "Sign out" for that). No `targetUserId` deletes the CALLER's own account; passing one only
// works for the two designated PaidHQ admin emails (enforced server-side in api/account/index.js).
export function deleteAccount(session, targetUserId) {
  const qs = targetUserId ? `?userId=${encodeURIComponent(targetUserId)}` : "";
  return coreFetch(session, `/api/account${qs}`, { method: "DELETE" });
}

// ─── Team / access levels ───────────────────────────────────────────────────
// "member" is view-only in BudgetHQ (enforced server-side by every product API route — see
// requireEditAccess in api/lib/auth.js); "admin"/"owner" have full edit access, and only they can
// invite/remove people or change roles (enforced by paidhq-core's own requireRole checks).

export function listMembers(session, workspaceId) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/members`).then((d) => d.members || []);
}

export function updateMemberRole(session, workspaceId, userId, role) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/members`, {
    method: "POST",
    body: JSON.stringify({ userId, role }),
  });
}

export function removeMember(session, workspaceId, userId) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/members?userId=${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export function listInvites(session, workspaceId) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/invites`).then((d) => d.invites || []);
}

// appUrl/appName tell core where the emailed "Accept invite" link should point and what to call
// the product in the email body — core has no frontend of its own (it's a shared backend for the
// whole PaidHQ suite), so the calling product supplies both.
export function inviteMember(session, workspaceId, { email, role }) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
    method: "POST",
    body: JSON.stringify({ email, role, appUrl: window.location.origin, appName: "BudgetHQ" }),
  });
}

export function revokeInvite(session, workspaceId, email) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/invites?email=${encodeURIComponent(email)}`, {
    method: "DELETE",
  });
}

// Called once, right after login, if a pending invite token was captured from the URL — see
// AuthGate.jsx/WorkspaceGate.jsx for where that token is stashed and consumed.
export function acceptInvite(session, token) {
  return coreFetch(session, "/api/invites/accept", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}
