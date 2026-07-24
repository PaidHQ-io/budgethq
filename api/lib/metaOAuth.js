/**
 * Shared helpers for Meta's (Facebook/Instagram Ads) OAuth2 flow (api/oauth/meta/{start,callback,
 * accounts}.js) and for keeping a stored per-workspace credential fresh (used from api/spend.js
 * before calling connectors/meta.js's getSpend).
 *
 * SETUP REQUIRED before this works at all (none of this is code — see ROADMAP.md's "Pending
 * setup" section for the full checklist):
 *   1. A Meta App (developers.facebook.com) with the "Marketing API" product added.
 *      META_CLIENT_ID/META_CLIENT_SECRET come from that app's Basic Settings.
 *   2. META_REDIRECT_URI (e.g. https://budget.paidhq.io/api/oauth/meta/callback) added to the
 *      app's Valid OAuth Redirect URIs (Facebook Login product settings).
 *   3. While the app is in Development mode, the OAuth flow only works for people added as an
 *      Admin/Developer/Tester on the app in the Meta App Dashboard — this is enough to connect
 *      Mo's own ad account today. Any OTHER workspace's user hitting the consent screen will be
 *      rejected by Meta itself until the app goes through App Review for the `ads_read`
 *      permission and is switched to Live mode — same "Testing mode" caveat already documented
 *      for Facebook login and Google Sheets export above. Nothing on the BudgetHQ side changes
 *      when that happens; Meta just starts letting more people through the same consent screen.
 *
 * TOKEN MODEL — genuinely different from LinkedIn/Bing, worth reading before touching this file:
 * Meta has no refresh_token grant at all. The code exchange returns a SHORT-LIVED user access
 * token (~1-2 hours). That's immediately exchanged for a LONG-LIVED token (~60 days) via a second
 * call to the same /oauth/access_token endpoint with grant_type=fb_exchange_token, passing the
 * short-lived token itself as the thing being exchanged. To renew before the 60 days is up, the
 * SAME fb_exchange_token call is repeated using the current (still-valid) long-lived token as
 * input — there's no separate refresh_token to store or rotate. If the long-lived token has
 * already fully expired, there is nothing left to exchange — Meta requires a real reconnect
 * (full consent screen again) at that point. See refreshAccessToken below.
 *
 * OAuth2 flow:
 *   1. Browser -> AUTH_URL (Meta's own consent screen)
 *   2. Meta redirects back to our callback with ?code=...&state=...
 *   3. Server exchanges code for a short-lived token, then immediately extends it to long-lived
 *   4. Re-extend (same endpoint) before the long-lived token expires
 *
 * STATE: see lib/oauthState.js (shared with LinkedIn/Bing's OAuth flows) for how `state` carries
 * the workspaceId/userId across the redirect hop, since Meta's redirect back to our callback
 * carries no Authorization header at all.
 *
 * API version is pinned below (GRAPH_VERSION) rather than left to float — Meta deprecates old
 * Graph API versions on a schedule (roughly every 2 years per version), so this will need bumping
 * periodically; picking a fixed version avoids silently riding whatever "latest" happens to mean
 * on a given day.
 */
import { randomUUID } from "crypto";
import { signState, verifyState as verifyStateShared } from "./oauthState.js";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const AUTH_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
// Token endpoint is called via graphGet("/oauth/access_token", ...) below (relative to GRAPH_BASE)
// rather than a separate constant — no other caller needs the full URL on its own.
// ads_read is enough for pulling spend/insights — no write scope (ads_management) requested since
// BudgetHQ only ever reads spend data, never modifies campaigns/budgets on the platform side.
const SCOPES = ["ads_read"];

export function verifyState(state) {
  return verifyStateShared(state, "meta");
}

function getRedirectUri() {
  const uri = process.env.META_REDIRECT_URI;
  if (!uri) throw new Error("META_REDIRECT_URI is not set");
  return uri;
}

function getClientCreds() {
  const clientId = process.env.META_CLIENT_ID;
  const clientSecret = process.env.META_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("META_CLIENT_ID/META_CLIENT_SECRET are not set");
  return { clientId, clientSecret };
}

export function buildAuthorizeUrl({ workspaceId, userId }) {
  const { clientId } = getClientCreds();
  const state = signState({ workspaceId, userId, provider: "meta", nonce: randomUUID(), exp: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    state,
    scope: SCOPES.join(","),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function graphGet(path, params) {
  const url = `${GRAPH_BASE}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    const err = data?.error || {};
    // Code 190 = expired/invalid access token — the one case spend.js/connectorSync.js should
    // treat as "needs reconnect" rather than a generic API error. Surfaced via a distinguishable
    // message rather than a custom error field, matching how the other connectors' getSpend()
    // already throws plain Error()s that spend.js just passes through as-is.
    throw new Error(err.code === 190
      ? "Meta access token is invalid or expired — reconnect this workspace's Meta account."
      : `Meta API error (${err.code ?? res.status}): ${err.message || "unknown error"}`);
  }
  return data;
}

function tokenResponseToCredential(data, previous = {}) {
  return {
    accessToken: data.access_token,
    // expires_in is present on both the short-lived exchange and the long-lived extension —
    // this always reflects whatever token is currently stored (long-lived, once extendToken runs).
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : previous.expiresAt || null,
    reconnectRequired: false,
  };
}

// Step 2 of the flow described in the file doc comment — exchanges whatever token is passed in
// (short-lived right after the initial code exchange, or the current long-lived one when renewing)
// for a fresh long-lived token. Both exchangeCodeForToken and refreshAccessToken funnel through
// this, since it's the same Graph call either way — only which token gets passed in differs.
async function extendToken(currentAccessToken, previous = {}) {
  const { clientId, clientSecret } = getClientCreds();
  const data = await graphGet("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: currentAccessToken,
  });
  return tokenResponseToCredential(data, previous);
}

export async function exchangeCodeForToken(code) {
  const { clientId, clientSecret } = getClientCreds();
  const shortLived = await graphGet("/oauth/access_token", {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getRedirectUri(),
    code,
  });
  if (!shortLived.access_token) throw new Error("Meta didn't return an access token for that code.");
  return extendToken(shortLived.access_token);
}

// See the file doc comment's TOKEN MODEL note — this is a re-extension of the current long-lived
// token, not a refresh_token grant. If the stored token has already fully expired there's nothing
// valid left to extend; Meta requires a real reconnect (full consent screen) at that point, same
// as isCredentialStale/needsReconnectSoon below are meant to catch before it gets that far.
export async function refreshAccessToken(credential) {
  if (!credential?.accessToken) throw new Error("No Meta access token stored — reconnect this workspace's Meta account.");
  return extendToken(credential.accessToken, credential);
}

// Whether refreshAccessToken above has anything to work with — see linkedinOAuth.js's identical
// helper. Unlike LinkedIn/Bing, Meta refreshes by re-extending the current accessToken itself (no
// separate refreshToken field exists here at all — see this file's TOKEN MODEL note), so this
// checks accessToken instead.
export function canAttemptRefresh(credential) {
  return !!credential?.accessToken;
}

// Meta's long-lived tokens run ~60 days — refresh well before that (7-day buffer, more generous
// than LinkedIn/Bing's since there's no separate refresh_token to fall back on if this is cut too
// close and the token actually expires before the next sync attempt).
export function isCredentialStale(credential) {
  if (!credential?.expiresAt) return true;
  return Date.now() > credential.expiresAt - 7 * 24 * 60 * 60 * 1000;
}

// Surfaced to the frontend (see connections.js's GET) so a workspace gets a reconnect nudge before
// its Meta sync actually breaks — same reconnectRequired-flag pattern as Bing, set by spend.js/
// connectorSync.js when an extend attempt actually fails rather than guessed from a calendar date.
export function needsReconnectSoon(credential) {
  return !!credential?.reconnectRequired;
}

// Ad accounts the given access token can see — used to auto-pick when there's exactly one, or to
// populate the "which account?" dropdown when there's more than one. Meta account IDs come back
// prefixed "act_..." and MUST be kept in that form — that's the exact string the Insights endpoint
// (connectors/meta.js) expects as a path segment, not the bare numeric id.
export async function listAdAccounts(accessToken) {
  const data = await graphGet("/me/adaccounts", {
    access_token: accessToken,
    fields: "id,name,account_status",
    limit: "200",
  });
  // account_status 1 = ACTIVE. Others (2=disabled, 3=unsettled, etc.) can't return insights anyway
  // — same "only offer accounts that can actually sync" filtering LinkedIn's connector does.
  return (data.data || [])
    .filter((a) => a.account_status === 1)
    .map((a) => ({ id: a.id, name: a.name || a.id }));
}
