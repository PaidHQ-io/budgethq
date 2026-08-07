/**
 * Thin client for paidhq-core's workspace/entitlement API — the shared service every PaidHQ
 * product points at for "who am I, which workspaces do I belong to, what am I entitled to."
 * Every call needs the Supabase access token from the current session (paidhq-core verifies it
 * against Supabase's public JWKS — see its api/lib/auth.js). VITE_CORE_API_URL is paidhq-core's
 * deployed origin (e.g. https://paidhq-core.vercel.app) — separate from PaidHQ's own /api
 * routes since core is a standalone service shared across products, not a PaidHQ endpoint.
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
// "member" is view-only in PaidHQ (enforced server-side by every product API route — see
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
    body: JSON.stringify({ email, role, appUrl: window.location.origin, appName: "PaidHQ" }),
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

// ─── Connector credentials / OAuth connect flow ─────────────────────────────
// Moved to paidhq-core 2026-07-28, per Mo (full OAuth connect flow, not just the cron sync engine)
// — connection management and every provider's consent-screen round-trip are shared across every
// PaidHQ product now, not PaidHQ-specific. See paidhq-core's api/workspaces/[id]/connections.js
// and api/oauth/*/{start,callback,accounts}.js doc comments for the full story, including why
// requireEntitlement was dropped and how resolveAllowedReturnUrl gets the browser back to the
// right product after the redirect. PaidHQ's own local copies of these same routes still exist
// as a rollback safety net (not yet removed — see ROADMAP) but the frontend calls paidhq-core's
// from here on.
//
// Same response shapes as the old local /api/workspaces/[id]/connections and /api/oauth/* routes
// (paidhq-core's versions are a straight move, not a redesign), so every existing caller in
// PaidHQ.jsx keeps working unchanged apart from swapping which function it calls.

export function listConnections(session, workspaceId) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/connections`).then((d) => d.connections || []);
}

export function saveConnectionCredential(session, workspaceId, provider, credential) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/connections`, {
    method: "POST",
    body: JSON.stringify({ provider, credential }),
  });
}

export function patchConnection(session, workspaceId, provider, body) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/connections?provider=${encodeURIComponent(provider)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteConnection(session, workspaceId, provider) {
  return coreFetch(session, `/api/workspaces/${encodeURIComponent(workspaceId)}/connections?provider=${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
}

// Returns { url } — the caller does window.location.href = url to send the browser into the
// provider's own consent screen (see startOAuth's caller in PaidHQ.jsx). Not a redirect itself;
// this call just asks paidhq-core to sign the state param and hand back where to go.
export function startOAuth(session, workspaceId, provider) {
  return coreFetch(session, `/api/oauth/${provider}/start?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export function getOAuthAccounts(session, workspaceId, provider) {
  return coreFetch(session, `/api/oauth/${provider}/accounts?workspaceId=${encodeURIComponent(workspaceId)}`);
}

// body is { accountId, accountName, customerId?, loginCustomerId? } — see paidhq-core's
// api/oauth/*/accounts.js POST doc comments for which of the optional fields each provider reads.
export function saveOAuthAccount(session, workspaceId, provider, body) {
  return coreFetch(session, `/api/oauth/${provider}/accounts?workspaceId=${encodeURIComponent(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── Spend sync (pull live data from a connected platform into core.spend_rows) ─────────────
// Moved to paidhq-core 2026-07-30, per Mo — "it's important for ReportingHQ users to be able to
// trigger syncs as well." Same reasoning as the OAuth connect flow's move: pulling spend into the
// shared core.spend_rows table is workspace infrastructure, not a PaidHQ-specific action, so any
// product's Sync button calls this exact same endpoint now. PaidHQ's own local /api/spend.js
// still exists as a rollback safety net (not yet removed) but the frontend calls paidhq-core's
// from here on. Same request/response shapes as the old local route — a straight move, not a
// redesign — so every existing caller in PaidHQ.jsx keeps working unchanged apart from swapping
// which function it calls and threading the session through (paidhq-core's version is
// authenticated the same way every other core route is, unlike the old same-origin fetch).

export function getConnectorRegistry(session) {
  return coreFetch(session, "/api/spend?action=registry").then((d) => d.connectors || {});
}

export function syncSpend(session, { platform, startDate, endDate, workspaceId }) {
  return coreFetch(session, "/api/spend", {
    method: "POST",
    body: JSON.stringify({ platform, startDate, endDate, workspaceId }),
  });
}

// Live, on-demand reach + frequency for an exact date window (2026-08-07, per Mo — "we need reach
// and frequency"), for Account Planning's Audit step. Deliberately a separate call from syncSpend —
// see paidhq-core's api/reach-metrics.js doc comment for why this can't just be another synced
// spend_rows field: reach is deduplicated/non-additive across days, so it's always computed fresh
// for the exact window asked about instead of summed from daily rows. Returns
// { linkedin: {[adId]: {reach, frequency}} | null, meta: {...} | null, errors: {...} } — null for a
// platform the workspace hasn't connected, an entry in `errors` for a platform that failed (e.g.
// LinkedIn's 92-day range cap) without blanking the other platform's data.
export function getReachMetrics(session, workspaceId, { startDate, endDate }) {
  const params = new URLSearchParams({ workspaceId, startDate, endDate });
  return coreFetch(session, `/api/reach-metrics?${params.toString()}`);
}

// Preview what a connector sees before (or after) saving a connection — currently only
// googlesheets implements this (see paidhq-core's connectors/googlesheets.js previewSheet). Powers
// the connect panel's "review & adjust mapping" step and the connections table's "Adjust mapping"
// action (2026-07-31, per Mo). `params` is whatever that connector's preview() needs — for
// googlesheets, { sheetUrl }. Returns { headers, colMap, sampleRow, missing, rowCount }.
export function previewConnector(session, platform, params) {
  return coreFetch(session, "/api/spend?action=preview", {
    method: "POST",
    body: JSON.stringify({ platform, ...params }),
  });
}
