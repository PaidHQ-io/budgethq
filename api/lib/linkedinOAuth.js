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
 * Bearer-token auth every other BudgetHQ route relies on is available. Instead, start.js signs
 * {workspaceId, userId, nonce, exp} into an HMAC-signed `state` string using OAUTH_STATE_SECRET (a
 * server-only secret, never exposed to the client except as this opaque signed blob), and the
 * callback verifies + decodes it. That's what proves the person completing LinkedIn's consent
 * screen is the same authenticated user who clicked "Connect" for that specific workspace, without
 * needing a session cookie (which this app's Supabase-Bearer-token auth model doesn't use).
 */
import { createHmac, randomUUID } from "crypto";

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
// r_ads: read campaigns/campaign groups/ad accounts metadata (needed to resolve names and list
// accounts). r_ads_reporting: read campaign analytics. No write scopes requested.
const SCOPES = ["r_ads", "r_ads_reporting"];

function getStateSecret() {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error("OAUTH_STATE_SECRET is not set — required to sign LinkedIn OAuth state");
  return secret;
}

export function signState(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getStateSecret()).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

export function verifyState(state) {
  if (!state || typeof state !== "string" || !state.includes(".")) {
    throw new Error("Invalid or missing state parameter");
  }
  const [b64, sig] = state.split(".");
  const expectedSig = createHmac("sha256", getStateSecret()).update(b64).digest("base64url");
  if (sig !== expectedSig) throw new Error("State signature mismatch — possible tampering, try connecting again");
  const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  if (!payload.exp || Date.now() > payload.exp) throw new Error("This connect link expired — try connecting again");
  return payload;
}

function getRedirectUri() {
  const uri = process.env.LINKEDIN_REDIRECT_URI;
  if (!uri) throw new Error("LINKEDIN_REDIRECT_URI is not set");
  return uri;
}

export function buildAuthorizeUrl({ workspaceId, userId }) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) throw new Error("LINKEDIN_CLIENT_ID is not set");
  const state = signState({ workspaceId, userId, nonce: randomUUID(), exp: Date.now() + 10 * 60 * 1000 });
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
