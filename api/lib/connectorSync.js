/**
 * Shared connector-sync core (2026-07-23) — the actual "refresh this workspace's stored OAuth
 * credential if it's gone stale, then call the connector's getSpend" logic, factored out of
 * api/spend.js's POST handler so api/cron/sync-connectors.js (which has no user session and no
 * per-request auth — see that file's doc comment) runs EXACTLY the same steps a manual Sync click
 * does, instead of a second copy of this logic slowly drifting out of sync with the first one.
 *
 * Auth/entitlement checks are deliberately NOT done in here — api/spend.js still does
 * requireAuth/requireWorkspaceMember/requireEntitlement itself before calling in, since a real
 * person is asking on their own behalf. The cron job is authorized as a whole (its own CRON_SECRET
 * check) to sync every workspace that's opted a connection into rolling sync, so per-call user auth
 * doesn't apply there the same way.
 */
import { CONNECTORS } from "../connectors/index.js";
import { sql } from "./db.js";
import * as linkedinOAuth from "./linkedinOAuth.js";
import * as bingOAuth from "./bingOAuth.js";

// Same map as spend.js used inline before this got factored out — see each lib's doc comments for
// why LinkedIn and Bing refresh differently (LinkedIn: no refresh tokens issued yet at all, so this
// never actually fires for it today; Bing: short-lived access tokens, fires on nearly every sync).
const OAUTH_REFRESH = { linkedin: linkedinOAuth, bing: bingOAuth };

// Refreshes an OAuth credential if stale, persisting either the refreshed tokens or a
// reconnectRequired flag back to the same row — identical behavior to what used to live inline in
// spend.js. Returns the credential unchanged for providers with no refresh concept (funnel/
// supermetrics/capterra are plain API keys with no expiry) or one that isn't stale yet.
export async function refreshCredentialIfStale(workspaceId, provider, credential) {
  const oauth = OAUTH_REFRESH[provider];
  if (!oauth || !credential?.refreshToken || !oauth.isCredentialStale(credential)) return credential;
  try {
    const refreshed = await oauth.refreshAccessToken(credential);
    const updated = { ...credential, ...refreshed };
    await sql`
      update budgethq.connector_credentials set credential = ${JSON.stringify(updated)}
      where workspace_id = ${workspaceId} and provider = ${provider}
    `;
    return updated;
  } catch (refreshErr) {
    // A refresh that actually fails (revoked, password changed, etc.) — mark reconnectRequired so
    // connections.js's GET (and the cron job's own error surfacing) can nudge a reconnect, then
    // still let the original error propagate to the caller.
    const updated = { ...credential, reconnectRequired: true };
    await sql`
      update budgethq.connector_credentials set credential = ${JSON.stringify(updated)}
      where workspace_id = ${workspaceId} and provider = ${provider}
    `;
    throw refreshErr;
  }
}

// Refreshes (if needed) then calls the connector's getSpend. Does NOT touch budgethq.spend_rows —
// callers decide how to persist: spend.js hands rows straight back to the requesting browser tab;
// the cron job DELETE+POSTs them into spend_rows for the synced window (see that file).
export async function runConnectorSync({ workspaceId, provider, startDate, endDate, credential }) {
  const connector = CONNECTORS[provider];
  if (!connector) throw new Error(`Unknown connector: ${provider}`);
  const cred = connector.perWorkspaceAuth
    ? await refreshCredentialIfStale(workspaceId, provider, credential)
    : credential;
  const rows = await connector.getSpend({ startDate, endDate, credential: cred });
  return { rows, credential: cred };
}
