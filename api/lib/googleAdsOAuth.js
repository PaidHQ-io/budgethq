/**
 * Shared helpers for Google Ads' OAuth2 flow (api/oauth/google/{start,callback,accounts}.js) and
 * for keeping a stored per-workspace credential fresh (used from api/spend.js before calling
 * connectors/google.js's getSpend).
 *
 * SETUP REQUIRED before this works at all — see ROADMAP.md's "Pending setup" section for the full
 * checklist, but the short version:
 *   1. A Developer Token (GOOGLE_ADS_DEVELOPER_TOKEN) — requested from inside a Google Ads MANAGER
 *      account (Tools & Settings -> Setup -> API Center), NOT self-serve like Bing's. Google's
 *      review queue for "Basic access" (enough to pull real advertiser accounts' data, capped at
 *      15,000 operations/day — plenty for PaidHQ's read-only daily spend pulls) has historically
 *      taken anywhere from a couple days to a couple weeks; there's no way to speed this up other
 *      than filling out the use-case questionnaire clearly. This has to be applied for by Mo
 *      personally (tied to his own Google Ads manager account) — not something buildable ahead of
 *      time from here. Nothing else in this file works without it: every API call below sends it
 *      as the `developer-token` header, and Google rejects the call entirely without one.
 *   2. A Google Cloud project with the Google Ads API enabled, plus an OAuth 2.0 Client ID (Web
 *      application type) — GOOGLE_ADS_CLIENT_ID/GOOGLE_ADS_CLIENT_SECRET. Can reuse the same
 *      "PaidHQ" Google Cloud project already set up for Google Sheets export (see ROADMAP.md) if
 *      convenient, but needs its OWN OAuth client (Sheets' VITE_GOOGLE_CLIENT_ID is a client-side,
 *      implicit-flow credential with a `spreadsheets` scope — this needs a server-side client with
 *      a client_secret and the `adwords` scope, same shape as Bing/LinkedIn/Meta's server-side
 *      OAuth clients, not something that can share the Sheets credential).
 *   3. GOOGLE_ADS_REDIRECT_URI (e.g. https://budget.paidhq.io/api/oauth/google/callback) added to
 *      that OAuth client's Authorized redirect URIs.
 *   4. Until the Google Cloud project's OAuth consent screen passes verification, it's capped at
 *      100 test users (added by email in the consent screen config) — same "Testing mode" caveat
 *      already documented for Facebook login/Google Sheets/Meta above. Enough to connect Mo's own
 *      account; any other workspace's user hits a warning screen until verification completes.
 *
 * IMPLEMENTATION CONFIDENCE NOTE — read before debugging a sync failure here: this connector was
 * built entirely from Google's published REST reference docs, NOT verified against a live account,
 * because the developer token application above hasn't been submitted yet as of this writing
 * (2026-07-25) — there is currently no way to get a real developer-token to test with. Follow the
 * same "assume nothing, diff against the docs" discipline the Bing connector's own doc comment
 * describes once a real sync is attempted for the first time; treat every request/response shape
 * below as unverified until then.
 *
 * TOKEN MODEL: standard Google OAuth2 authorization-code flow, same shape as Bing's — access_token
 * (short-lived, ~1hr) + refresh_token (long-lived, effectively undated same as Bing's — Google's
 * own docs describe refresh tokens as not expiring on a fixed schedule barring revocation/7-day
 * inactivity for apps still in Testing mode). access_type=offline + prompt=consent are BOTH
 * required at the /authorize step to actually get a refresh_token back — Google only issues one on
 * the FIRST consent for a given user+app combination unless prompt=consent forces the consent
 * screen (and thus a fresh refresh_token) every time, which matters here since a workspace
 * reconnecting after a revoke needs a new one, not silently getting none back.
 *
 * OAuth2 flow:
 *   1. Browser -> AUTH_URL (Google's own consent screen)
 *   2. Google redirects back to our callback with ?code=...&state=...
 *   3. Server exchanges code for {access_token, refresh_token, expires_in} via POST to TOKEN_URL
 *   4. Refresh (same endpoint, grant_type=refresh_token) before the access token expires
 *
 * STATE: see lib/oauthState.js (shared with LinkedIn/Bing/Meta's OAuth flows) for how `state`
 * carries the workspaceId/userId across the redirect hop, since Google's redirect back to our
 * callback carries no Authorization header at all.
 */
import { randomUUID } from "crypto";
import { signState, verifyState as verifyStateShared } from "./oauthState.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Pinned rather than left to float — Google Ads API versions sunset roughly a year after launch
// (see the Google Ads Developer Blog's own sunset-reminder posts) and moved to a MONTHLY release
// cadence starting January 2026, so this needs periodic bumping same as Meta's GRAPH_VERSION.
// v25 confirmed current as of 2026-07 (announced 2026-07-22) — if every call below starts failing
// with a version-related error, check developers.google.com/google-ads/api/docs/sunset-dates first.
const API_VERSION = "v25";
const API_BASE = `https://googleads.googleapis.com/${API_VERSION}`;
const SCOPES = ["https://www.googleapis.com/auth/adwords"];

export function verifyState(state) {
  return verifyStateShared(state, "google");
}

function getRedirectUri() {
  const uri = process.env.GOOGLE_ADS_REDIRECT_URI;
  if (!uri) throw new Error("GOOGLE_ADS_REDIRECT_URI is not set");
  return uri;
}

function getClientCreds() {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_ADS_CLIENT_ID/GOOGLE_ADS_CLIENT_SECRET are not set");
  return { clientId, clientSecret };
}

function getDeveloperToken() {
  const token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!token) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is not set — see the Google Ads setup notes.");
  return token;
}

export function buildAuthorizeUrl({ workspaceId, userId }) {
  const { clientId } = getClientCreds();
  const state = signState({ workspaceId, userId, provider: "google", nonce: randomUUID(), exp: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    scope: SCOPES.join(" "),
    state,
    // access_type=offline+prompt=consent required to actually get a refresh_token back — see this
    // file's TOKEN MODEL note. select_account added 2026-07-26 per Mo — without it, Google skips
    // straight to consent using whichever Google account is already signed into the browser,
    // with no way to pick a different one; this forces the account-chooser screen to show first
    // every time, same as clicking "Use another account" manually.
    access_type: "offline",
    prompt: "select_account consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body) {
  const { clientId, clientSecret } = getClientCreds();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Google token endpoint ${res.status}: ${data?.error_description || data?.error || "unknown error"}`);
  }
  return data;
}

function tokenResponseToCredential(data, previous = {}) {
  return {
    accessToken: data.access_token,
    // Google only returns refresh_token on a consent that actually produces one (see TOKEN MODEL
    // note above on access_type=offline+prompt=consent) — a refresh call itself never returns a
    // new one, so always fall back to whatever's already stored rather than overwriting with
    // undefined.
    refreshToken: data.refresh_token || previous.refreshToken || null,
    expiresAt: Date.now() + (data.expires_in || 0) * 1000,
    reconnectRequired: false,
  };
}

export async function exchangeCodeForToken(code) {
  const data = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: getRedirectUri() });
  if (!data.refresh_token) {
    // Shouldn't happen given access_type=offline+prompt=consent above, but if Google ever silently
    // omits it (e.g. a re-consent edge case), fail loudly here rather than saving a credential that
    // can only ever be refreshed once (until the short-lived access_token itself expires) with no
    // way to renew after that — better to force a clean reconnect than a silent future outage.
    throw new Error("Google didn't return a refresh token for that consent — try connecting again.");
  }
  return tokenResponseToCredential(data);
}

export async function refreshAccessToken(credential) {
  if (!credential?.refreshToken) throw new Error("No refresh token stored — reconnect this workspace's Google Ads account.");
  const data = await tokenRequest({ grant_type: "refresh_token", refresh_token: credential.refreshToken });
  return tokenResponseToCredential(data, credential);
}

// Whether refreshAccessToken above has anything to work with — see linkedinOAuth.js's identical
// helper for why connectorSync.js checks this before attempting a refresh at all.
export function canAttemptRefresh(credential) {
  return !!credential?.refreshToken;
}

// Google access tokens run ~1hr — refresh with a comfortable buffer, same order of magnitude as
// Bing's short-lived tokens (10 min buffer there; a bit more headroom here since Google's tokens
// live somewhat longer).
export function isCredentialStale(credential) {
  if (!credential?.expiresAt) return true;
  return Date.now() > credential.expiresAt - 10 * 60 * 1000;
}

// Surfaced to the frontend (see connections.js's GET) — same failure-based signal as Bing/Meta,
// since Google's refresh tokens don't have a predictable calendar expiry either (barring 7-day
// inactivity revocation while the OAuth consent screen is still in Testing mode — see this file's
// SETUP REQUIRED note #4 — which would also only be caught this way, as an actual failed refresh).
export function needsReconnectSoon(credential) {
  return !!credential?.reconnectRequired;
}

async function adsApiGet(path, accessToken) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": getDeveloperToken(),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error || {};
    throw new Error(`Google Ads API error (${err.status || res.status}): ${err.message || JSON.stringify(data) || "unknown error"}`);
  }
  return data;
}

// Single page of a GAQL search (customers/{id}/googleAds:search) — exported so
// connectors/google.js can reuse it for the actual spend query, not just this file's own
// account-listing lookup below. `pageToken` is optional (omit for the first page).
export async function adsApiSearch(customerId, query, { accessToken, loginCustomerId, pageToken } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "developer-token": getDeveloperToken(),
  };
  // Only required when authenticating on behalf of a manager (MCC) account rather than a directly-
  // accessible customer — see listAccessibleAccounts' KNOWN LIMITATION note below for why this
  // isn't populated by anything in this file yet.
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
  const body = { query, pageSize: 10000 };
  if (pageToken) body.pageToken = pageToken;
  const res = await fetch(`${API_BASE}/customers/${customerId}/googleAds:search`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error || {};
    throw new Error(`Google Ads API error (${err.status || res.status}) for customer ${customerId}: ${err.message || JSON.stringify(data) || "unknown error"}`);
  }
  return data;
}

// Pages through every result of a GAQL search, following nextPageToken until it's exhausted.
// Capped at 50 pages (500,000 rows at pageSize 10000) as a runaway guard, same reasoning/limit as
// Meta connector's fetchAllInsights — a real account pulling that much daily ad-group-level data in
// one sync window would need windowing at the call-site anyway.
export async function adsApiSearchAll(customerId, query, auth) {
  const rows = [];
  let pageToken;
  let pages = 0;
  do {
    const data = await adsApiSearch(customerId, query, { ...auth, pageToken });
    rows.push(...(data.results || []));
    pageToken = data.nextPageToken || null;
    pages++;
  } while (pageToken && pages < 50);
  return rows;
}

// Ad accounts the given access token can see — used to auto-pick when there's exactly one, or to
// populate the "which account?" dropdown when there's more than one, same pattern as Meta's
// listAdAccounts/Bing's resolveAccounts.
//
// KNOWN LIMITATION (v1, 2026-07-25): listAccessibleCustomers only returns customer IDs directly
// accessible to the authenticated Google user — an agency/user who ONLY has access via a manager
// (MCC) account, with no directly-listed child accounts, will see an empty list here even though
// they can see real ad accounts inside the Google Ads UI. Fixing that needs a manager-account
// hierarchy browser (GoogleAdsService.search against the manager customer with
// customer_client.manager=false, sending the manager's ID as login-customer-id) — not built yet
// since it adds real complexity for a case that may not apply to PaidHQ's actual early users.
// If Mo's own account (or an early customer's) turns out to need this, that's the fix.
export async function listAccessibleAccounts(accessToken) {
  const listResp = await adsApiGet("/customers:listAccessibleCustomers", accessToken);
  const customerIds = (listResp.resourceNames || []).map((n) => n.replace("customers/", ""));

  const accounts = [];
  for (const customerId of customerIds) {
    try {
      const searchResp = await adsApiSearch(
        customerId,
        "SELECT customer.id, customer.descriptive_name, customer.manager, customer.test_account FROM customer LIMIT 1",
        { accessToken }
      );
      const row = searchResp.results?.[0]?.customer;
      if (!row) continue;
      // Manager (MCC) accounts don't hold campaigns/spend themselves — same "only offer accounts
      // that can actually sync" filtering as Meta's account_status check. Test accounts can't hold
      // real spend either.
      if (row.manager || row.testAccount) continue;
      accounts.push({ id: customerId, name: row.descriptiveName || `Account ${customerId}` });
    } catch {
      // Non-fatal, same reasoning as Meta's listAdAccounts — a token that can technically see a
      // customer ID but fails to query it (e.g. it genuinely needs login-customer-id, see the
      // KNOWN LIMITATION note above) shouldn't take down the whole picker; it just won't appear.
    }
  }
  return accounts;
}
