/**
 * Verifies a Supabase-issued JWT from the Authorization header, without an extra network round
 * trip to Supabase's auth server. Verification uses Supabase's public JWKS endpoint (asymmetric
 * ECC signing keys — Supabase's current default for new projects) rather than a shared HS256
 * secret. Nothing secret is needed here at all: SUPABASE_URL (the project's
 * https://<ref>.supabase.co URL, same value as the frontend's VITE_SUPABASE_URL) is enough to
 * fetch the public signing keys and verify tokens. `jose`'s createRemoteJWKSet caches the fetched
 * keys and re-fetches automatically if an incoming token's key ID isn't in its cache (e.g. right
 * after a key rotation).
 */
import { jwtVerify, createRemoteJWKSet } from "jose";

let cachedJwks = null;
function getJwks() {
  if (!cachedJwks) {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error("SUPABASE_URL is not set");
    cachedJwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  }
  return cachedJwks;
}

// Throws on missing/invalid/expired token. Returns { userId, email } on success.
export async function requireAuth(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    const err = new Error("Missing Authorization header");
    err.status = 401;
    throw err;
  }
  try {
    const { payload } = await jwtVerify(token, getJwks());
    return { userId: payload.sub, email: payload.email || null };
  } catch (e) {
    const err = new Error("Invalid or expired session");
    err.status = 401;
    err.cause = e;
    throw err;
  }
}

// Confirms the authenticated user is a member of the given workspace (any role) before letting a
// request through. Every workspace-scoped route calls this after requireAuth — this is the one
// place that actually enforces the tenant isolation the whole schema is built around.
//
// Queries core.workspace_members — membership itself is owned by the shared paidhq-core service,
// not BudgetHQ. This works as a plain schema-qualified query (not an HTTP call to core) because
// BudgetHQ and paidhq-core share one Postgres database, just separated by schema. See
// db/schema.sql's header comment.
export async function requireWorkspaceMember(sql, workspaceId, userId) {
  const rows = await sql`
    select role from core.workspace_members
    where workspace_id = ${workspaceId} and user_id = ${userId}
  `;
  if (!rows.length) {
    const err = new Error("Not a member of this workspace");
    err.status = 403;
    throw err;
  }
  return rows[0].role;
}

// "member" is a view-only role — every state-changing request (any POST/PUT/DELETE that touches
// workspace data) requires "owner" or "admin". Call this in addition to requireWorkspaceMember,
// after you have the role, inside each write-method branch (GET stays open to any member — view
// access is the whole point of the "member" role existing at all, not a bug to route around).
export function requireEditAccess(role) {
  if (role === "member") {
    const err = new Error("Your role only has view access to this workspace — ask an owner or admin to make this change.");
    err.status = 403;
    throw err;
  }
}

// Confirms the workspace has an active (or trialing) BudgetHQ entitlement — i.e. someone's
// actually paying for/trialing BudgetHQ specifically for this workspace, not just any PaidHQ
// product. Being a workspace member (requireWorkspaceMember) is necessary but not sufficient: an
// agency could have a workspace for a client that only has VaultHQ, not BudgetHQ, and members of
// that workspace shouldn't be able to pull BudgetHQ data for it.
export async function requireEntitlement(sql, workspaceId) {
  const rows = await sql`
    select status from core.entitlements
    where workspace_id = ${workspaceId} and product = 'budgethq' and status in ('active','trialing')
  `;
  if (!rows.length) {
    const err = new Error("This workspace doesn't have an active BudgetHQ subscription");
    err.status = 402; // Payment Required
    throw err;
  }
}
