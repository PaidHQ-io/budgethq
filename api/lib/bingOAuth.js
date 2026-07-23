/**
 * Shared helpers for Microsoft Advertising's (Bing Ads) OAuth2 flow (api/oauth/bing/{start,
 * callback,accounts}.js) and for keeping a stored per-workspace credential fresh (used from
 * api/spend.js before calling connectors/bing.js's getSpend).
 *
 * Unlike LinkedIn, Microsoft's identity platform issues refresh tokens to ANY registered app —
 * there's no separate partner-approval gate for that part. Two things ARE still required before
 * this can go live, both confirmed NOT yet done for BudgetHQ as of 2026-07-22 (see the chat
 * writeup this shipped with):
 *   1. A Developer Token (BING_DEVELOPER_TOKEN) — a Microsoft Advertising account-level key,
 *      requested self-serve from Microsoft Advertising's own Developer Center (Account settings ->
 *      Developer Settings -> Request Token). Usually instant for first-party use, but BudgetHQ
 *      pulling data on behalf of many different customer accounts is exactly the "tool provider"
 *      scenario Microsoft's docs say can take up to ~5 business days for review.
 *   2. An Entra ID (Azure AD) app registration (BING_CLIENT_ID/BING_CLIENT_SECRET) — created in
 *      the Azure Portal, unrelated to Microsoft Advertising's own UI. Self-serve, no approval wait.
 *
 * OAuth2 authorization-code flow (verified against Microsoft's own docs, 2026-07):
 *   1. Browser -> AUTH_URL (Microsoft's consent screen, tenant=common so both personal Microsoft
 *      accounts and work/school accounts can sign in)
 *   2. Microsoft redirects back to our callback with ?code=...&state=...
 *   3. Server exchanges code for {access_token, refresh_token, expires_in} via POST to TOKEN_URL
 *   4. Refresh (same endpoint, grant_type=refresh_token) before the access token expires — Bing
 *      access tokens are short-lived (on the order of ~60-90 minutes, MUCH shorter than LinkedIn's
 *      ~60 days), so this needs to happen far more aggressively; see isCredentialStale's buffer.
 *
 * Microsoft's docs describe refresh tokens here as effectively undated ("do not have specified
 * lifetimes... typically long") rather than expiring on a fixed schedule like LinkedIn's — the
 * only real signal that a stored credential has gone stale is a refresh attempt actually failing
 * with invalid_grant (revoked, password changed, etc.), not a calendar buffer. See spend.js and
 * needsReconnectSoon below for how that's surfaced to the frontend instead of guessing a date.
 *
 * STATE: see lib/oauthState.js (shared with LinkedIn's OAuth flow) for how `state` carries the
 * workspaceId/userId across the redirect hop, since Microsoft's redirect back to our callback
 * carries no Authorization header at all.
 */
import { randomUUID } from "crypto";
import { signState, verifyState as verifyStateShared } from "./oauthState.js";

const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
// Scope requested at the /authorize step — offline_access is what makes a refresh_token come back
// in the token exchange response. Confirmed against Microsoft's own OAuth walkthrough.
const AUTHORIZE_SCOPE = "openid profile https://ads.microsoft.com/msads.manage offline_access";
// The /token step's scope param, both for the initial code exchange and every refresh — per
// Microsoft's docs this should NOT repeat offline_access/openid/profile here, only the resource
// scope itself.
const TOKEN_SCOPE = "https://ads.microsoft.com/msads.manage";

const CUSTOMER_MGMT_BASE = "https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13";

export function verifyState(state) {
  return verifyStateShared(state, "bing");
}

function getRedirectUri() {
  const uri = process.env.BING_REDIRECT_URI;
  if (!uri) throw new Error("BING_REDIRECT_URI is not set");
  return uri;
}

export function buildAuthorizeUrl({ workspaceId, userId }) {
  const clientId = process.env.BING_CLIENT_ID;
  if (!clientId) throw new Error("BING_CLIENT_ID is not set");
  const state = signState({ workspaceId, userId, provider: "bing", nonce: randomUUID(), exp: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    scope: AUTHORIZE_SCOPE,
    state,
    // Microsoft accounts are frequently shared/switched on a single browser (unlike LinkedIn) —
    // select_account avoids silently reusing whichever Microsoft account happens to be signed in.
    prompt: "select_account",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body) {
  const clientId = process.env.BING_CLIENT_ID;
  const clientSecret = process.env.BING_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("BING_CLIENT_ID/BING_CLIENT_SECRET are not set");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: clientId, client_secret: clientSecret, scope: TOKEN_SCOPE }).toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Microsoft token endpoint ${res.status}: ${data?.error_description || data?.error || "unknown error"}`);
  }
  return data;
}

function tokenResponseToCredential(data, previous = {}) {
  return {
    accessToken: data.access_token,
    // Microsoft doesn't always return a new refresh_token on refresh — keep the previous one if
    // this response omitted it, per the OAuth spec note in their own docs.
    refreshToken: data.refresh_token || previous.refreshToken || null,
    expiresAt: Date.now() + (data.expires_in || 0) * 1000,
    // Cleared on every successful token response — see needsReconnectSoon below.
    reconnectRequired: false,
  };
}

export async function exchangeCodeForToken(code) {
  const data = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: getRedirectUri() });
  return tokenResponseToCredential(data);
}

export async function refreshAccessToken(credential) {
  if (!credential?.refreshToken) throw new Error("No refresh token stored — reconnect this workspace's Microsoft Advertising account.");
  const data = await tokenRequest({ grant_type: "refresh_token", refresh_token: credential.refreshToken });
  return tokenResponseToCredential(data, credential);
}

// Bing access tokens are short-lived (~60-90 min) — refresh well before expiry rather than
// LinkedIn's 1-day buffer, since a sync could otherwise start with a token that expires mid-run.
export function isCredentialStale(credential) {
  if (!credential?.expiresAt) return true;
  return Date.now() > credential.expiresAt - 10 * 60 * 1000;
}

// Surfaced to the frontend (see connections.js's GET) — unlike LinkedIn's time-based nudge, Bing's
// refresh tokens don't have a predictable expiry to count down to, so the only honest signal that
// a workspace needs to reconnect is an actual refresh attempt having failed (see spend.js, which
// sets credential.reconnectRequired=true on an invalid_grant-style failure and persists it).
export function needsReconnectSoon(credential) {
  return !!credential?.reconnectRequired;
}

async function customerManagementRequest(path, body, { accessToken, developerToken }) {
  const res = await fetch(`${CUSTOMER_MGMT_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      DeveloperToken: developerToken,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Microsoft Advertising Customer Management ${path} ${res.status}: ${data?.Errors?.[0]?.Message || data?.error_description || JSON.stringify(data)}`);
  }
  return data;
}

// Resolves which ad accounts the just-authenticated Microsoft user can access — mirrors LinkedIn's
// listAdAccounts, used both to auto-pick when there's exactly one account and to populate the
// "which account?" picker when there's more than one. Two calls, same shape as every other
// Microsoft Advertising client library:
//   1. GetUser (UserId omitted -> defaults to the authenticated caller) to get the user's own
//      UserId and primary CustomerId.
//   2. SearchAccounts filtered to that UserId, to list every AdvertiserAccount they can access
//      (which can span more than one manager/customer account).
// Endpoints, headers and JSON body shapes below are taken directly from Microsoft's own REST
// reference for these two operations (not guessed) — see GetUser/SearchAccounts docs under
// learn.microsoft.com/en-us/advertising/customer-management-service/.
export async function resolveAccounts(accessToken, developerToken) {
  const userResp = await customerManagementRequest("/User/Query", { UserId: null }, { accessToken, developerToken });
  const userId = userResp?.User?.Id;
  if (!userId) throw new Error("Couldn't resolve the Microsoft Advertising user for this token.");

  const searchResp = await customerManagementRequest(
    "/Accounts/Search",
    {
      Predicates: [{ Field: "UserId", Operator: "Equals", Value: String(userId) }],
      Ordering: null,
      PageInfo: { Index: 0, Size: 1000 },
      ReturnAdditionalFields: null,
    },
    { accessToken, developerToken }
  );

  const accounts = (searchResp?.Accounts || []).map((a) => ({
    id: String(a.Id),
    name: a.Name || `Account ${a.Id}`,
    customerId: String(a.ParentCustomerId ?? userResp?.User?.CustomerId ?? ""),
  }));
  return accounts;
}
