/**
 * Client for /api/workspaces/[id]/account-plans — Account Planning, per Mo (2026-08-06). See that
 * route's own doc comment for the full data-model reasoning (why audit numbers never persist, only
 * the decisions layered on top of them do).
 */
export function authHeader(session) {
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

async function api(session, workspaceId, path, options = {}) {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/account-plans${path}`, {
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

// List view only — metadata (name/status/activeStep), no context/taxonomy/auditDecisions/mapping
// bodies. Call getAccountPlan for a plan's full contents.
export async function listAccountPlans(session, workspaceId) {
  const d = await api(session, workspaceId, "");
  return d.plans || [];
}

export async function getAccountPlan(session, workspaceId, planId) {
  const d = await api(session, workspaceId, `?planId=${encodeURIComponent(planId)}`);
  return d.plan;
}

export async function createAccountPlan(session, workspaceId, name) {
  const d = await api(session, workspaceId, "", { method: "POST", body: JSON.stringify({ name }) });
  return d.plan;
}

// updates: { planId, name?, status?, activeStep?, context?, taxonomy?, auditDecisions?, mapping? }
// — partial, only send what changed.
export async function updateAccountPlan(session, workspaceId, updates) {
  const d = await api(session, workspaceId, "", { method: "PATCH", body: JSON.stringify(updates) });
  return d.plan;
}

export function deleteAccountPlan(session, workspaceId, planId) {
  return api(session, workspaceId, `?planId=${encodeURIComponent(planId)}`, { method: "DELETE" });
}
