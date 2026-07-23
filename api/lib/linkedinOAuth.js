/**
 * Shared helpers for LinkedIn's OAuth2 flow (api/oauth/linkedin/start.js, callback.js,
 * accounts.js) and for keeping a stored per-workspace credential's access token fresh (used from
 * api/spend.js before calling connectors/linkedin.js's getSpend).
 *
 * LinkedIn's Marketing Developer Platform issues a short-lived access token (~60 days) plus a
 * longer-lived refresh token (~365 days) — the refresh token is only issued if the LinkedIn
 * Developer app has "Programmatic Refresh Tokens" turned on (a one-time setting in the LinkedIn
 * Developer Portal, not something this code can enable — see the setup note this shipped with).
 * Standard OAuth2 authorization-code flow:
 *   1. Browser -> AUTH_URL (LinkedIn's own consent screen)
 *   2. LinkedIn redirects back to our callback with ?code=...&state=...
 *   3. Server exchanges code for {access_token, refresh_token, expires_in} via a POST to TOKEN_URL
 *   4. Refresh (same endpoint, grant_type=refresh_token) before the access token expires
 *
 * STATE: LinkedIn's redirect lands on the callback with no Authorization header at all — the
 * browser navigated there directly, this isn't a fetch we control, so none of the normal
 * Bearer-token auth every other BudgetHQ route relies on is available. See lib/oauthState.js
 * (shared with Bing's OAuth flow) for how `state` carries the workspaceId/userId across that hop
 * instead — that's what proves the person completing LinkedIn's consent screen is the same
 * authenticated user who clicked "Connect" for that specific workspace, without needing a session
 * cookie (which this app's Supabase-Bearer-token auth model doesn't use).
 */
import { randomUUID } from "crypto";
import { signState, verifyState as verifyStateShared } from "./oauthState.js";

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
// r_ads: read campaigns/campaign groups/ad accounts metadata (needed to resolve names and list
// accounts). r_ads_reporting: read campaign analytics. No write scopes requested.
const SCOPES = ["r_ads", "r_ads_reporting"];

export function verifyState(state) {
  return verifyStateShared(state, "linkedin");
}

function getRedirectUri() {
  const uri = process.env.LINKEDIN_REDIRECT_URI;
  if (!uri) throw new Error("LINKEDIN_REDIRECT_URI is not set");
  return uri;
}

export function buildAuthorizeUrl({ workspaceId, userId }) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) throw new Error("LINKEDIN_CLIENT_ID is not set");
  const state = signState({ workspaceId, userId, provider: "linkedin", nonce: randomUUID(), exp: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    state,
    scope: SCOPES.join(" "),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET are not set");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`LinkedIn token endpoint ${res.status}: ${data?.error_description || data?.error || "unknown error"}`);
  }
  return data;
}

function tokenResponseToCredential(data, previous = {}) {
  const now = Date.now();
  return {
    accessToken: data.access_token,
    // LinkedIn only returns a new refresh_token sometimes on refresh — keep the previous one if
    // this response didn't include a fresh one, rather than losing it.
    refreshToken: data.refresh_token || previous.refreshToken || null,
    expiresAt: now + (data.expires_in || 0) * 1000,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : previous.refreshTokenExpiresAt || null,
  };
}

export async function exchangeCodeForToken(code) {
  const data = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: getRedirectUri() });
  return tokenResponseToCredential(data);
}

export async function refreshAccessToken(credential) {
  if (!credential?.refreshToken) throw new Error("No refresh token stored — reconnect this workspace's LinkedIn account.");
  const data = await tokenRequest({ grant_type: "refresh_token", refresh_token: credential.refreshToken });
  return tokenResponseToCredential(data, credential);
}

// Ad accounts the given access token can see — used to auto-pick when there's exactly one, or to
// populate the "which account?" dropdown when there's more than one. Restricted to ACTIVE accounts
// since a paused/cancelled account can't return analytics anyway.
export async function listAdAccounts(accessToken) {
  const res = await fetch(
    "https://api.linkedin.com/v2/adAccountsV2?q=search&search.status.values[0]=ACTIVE",
    { headers: { Authorization: `Bearer ${accessToken}`, "X-Restli-Protocol-Version": "2.0.0" } }
  );
  if (!res.ok) throw new Error(`LinkedIn adAccountsV2 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.elements || []).map((a) => ({ id: String(a.id), name: a.name || `Account ${a.id}` }));
}

// True once the stored credential is within 1 day of expiring (or already expired) — refreshed
// proactively from spend.js rather than waiting for a live sync to fail mid-request.
export function isCredentialStale(credential) {
  if (!credential?.expiresAt) return true;
  return Date.now() > credential.expiresAt - 24 * 60 * 60 * 1000;
}

// Surfaced to the frontend (see connections.js's GET) so a workspace gets a "reconnect" nudge
// before its LinkedIn sync actually breaks. Mo's app doesn't have LinkedIn's "programmatic refresh
// tokens" feature approved yet (that's a separate Marketing Developer Platform partner approval on
// top of plain Advertising API access — see the chat writeup this shipped with), so a connected
// credential with no refreshToken will NOT silently renew itself: once the 60-day access token
// expires, syncing that workspace's LinkedIn data fails until the member reconnects. If/when that
// approval comes through, newly-issued credentials will carry a refreshToken and this will simply
// stop firing for them (see the `!credential.refreshToken` short-circuit below) — nothing else
// needs to change to retire this nudge.
export function needsReconnectSoon(credential, daysAhead = 7) {
  if (!credential) return false;
  if (credential.refreshToken) return false; // auto-refreshes silently — see spend.js
  if (!credential.expiresAt) return true; // no expiry on record — safest to prompt
  return Date.now() > credential.expiresAt - daysAhead * 24 * 60 * 60 * 1000;
}
