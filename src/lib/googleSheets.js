/**
 * "Export to Google Sheets" — client-side only, no server-side OAuth/token storage. Exporting is
 * a one-shot action (create a new spreadsheet, write the data, done), not an ongoing sync, so
 * there's no need to persist a refresh token anywhere: Google Identity Services' token client
 * gets a short-lived access token in the browser, it's used once, and it's discarded.
 *
 * Reuses the SAME Google OAuth Client ID already created for "Sign in with Google"
 * (VITE_GOOGLE_CLIENT_ID) — Client IDs aren't secret (Google documents them as safe to ship in
 * frontend code); only that OAuth client's Client Secret is sensitive, and it's never used here
 * (it lives solely in Supabase's server-side login flow).
 *
 * Requires two one-time setup steps in the Google Cloud project this Client ID belongs to:
 *   1. Enable the "Google Sheets API" (APIs & Services -> Library).
 *   2. Add the https://www.googleapis.com/auth/spreadsheets scope on the OAuth consent screen
 *      (Google Auth Platform -> Audience/Data Access -> Add or remove scopes).
 * While that consent screen is in "Testing" mode, only test users explicitly added in Google
 * Cloud Console can use this — publishing it for arbitrary users requires Google's verification
 * review, since spreadsheets access is a "sensitive" scope. Same caveat as the Facebook login
 * provider: fine for you today, needs a review pass before opening up to real customers.
 */
const GIS_SRC = "https://accounts.google.com/gsi/client";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

let gisLoadPromise = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Couldn't load Google's sign-in library."));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

let tokenClient = null;
let cachedToken = null; // { accessToken, expiresAt }
let hasPromptedOnce = false;

async function getAccessToken() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("Google Sheets export isn't configured yet — VITE_GOOGLE_CLIENT_ID is missing.");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.accessToken;
  }
  await loadGis();
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SHEETS_SCOPE,
        callback: () => {}, // replaced per-request just below
      });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      cachedToken = {
        accessToken: resp.access_token,
        expiresAt: Date.now() + (resp.expires_in || 3600) * 1000,
      };
      hasPromptedOnce = true;
      resolve(resp.access_token);
    };
    // First grant in this page session shows the consent popup; later refreshes try silently
    // first (falls back to a popup on its own if Google decides silent reauth isn't possible).
    tokenClient.requestAccessToken({ prompt: hasPromptedOnce ? "" : "consent" });
  });
}

async function sheetsFetch(accessToken, path, options = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error?.message || `Google Sheets API error (${res.status})`);
  }
  return body;
}

// Sheet tab titles can't contain []*?:/\ and have a length cap — same characters
// buildReportBlob's XLSX path already strips for the same reason, kept consistent here.
function safeSheetTitle(title, index) {
  const clean = (title || `Sheet${index + 1}`).replace(/[\\/*?:[\]]/g, "").slice(0, 95);
  return clean || `Sheet${index + 1}`;
}

// Exports a `report` object ({title, subtitle, sections:[{heading,headers,rows}]}) — the exact
// same shape every existing CSV/XLSX/PDF/HTML export already builds — as a brand-new Google
// Sheet, one tab per section, and returns its URL. Every call creates a fresh spreadsheet, same
// as clicking "Download" produces a fresh file rather than updating a previous one.
export async function exportReportToGoogleSheets(report) {
  const accessToken = await getAccessToken();

  const sheetTitles = report.sections.map((sec, i) => safeSheetTitle(sec.heading, i));
  const created = await sheetsFetch(accessToken, "", {
    method: "POST",
    body: JSON.stringify({
      properties: { title: report.title },
      sheets: sheetTitles.map((title) => ({ properties: { title } })),
    }),
  });

  const data = created.sheets.map((sheet, i) => {
    const sec = report.sections[i];
    const values = [[sec.heading], sec.headers, ...(sec.rows.length ? sec.rows : [["No data"]])];
    const escapedTitle = sheet.properties.title.replace(/'/g, "''");
    return { range: `'${escapedTitle}'!A1`, values };
  });

  await sheetsFetch(accessToken, `/${created.spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });

  return created.spreadsheetUrl;
}

/**
 * "Connect a Google Sheet" — manual pull, same client-only pattern as export above (reuses the
 * same access token/scope, so there's no second consent prompt and no extra Google Cloud setup).
 * This is deliberately the lightweight half of the live-connection feature: the user pastes a
 * link, clicks a button, and the sheet's raw grid is fetched once and fed into the same
 * header-row-picker / column-mapping pipeline a CSV upload or screenshot import already goes
 * through. Nothing is stored — no refresh token, no server round-trip — so this can't run in the
 * background or auto-refresh on its own; that's the separate, heavier piece (server-side OAuth
 * authorization-code flow + stored refresh token + a sync schedule) planned as a follow-up.
 */

// Accepts either a full Sheets URL or a bare spreadsheet ID typed/pasted directly.
export function parseSpreadsheetId(input) {
  const s = (input || "").trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s; // looks like a bare ID
  return null;
}

// Returns [{ sheetId, title }] for every tab in the spreadsheet, so the caller can ask the user
// to pick one when there's more than one.
export async function listSheetTabs(spreadsheetId) {
  const accessToken = await getAccessToken();
  const data = await sheetsFetch(
    accessToken,
    `/${spreadsheetId}?fields=properties.title,sheets.properties`,
    {}
  );
  return {
    title: data.properties?.title || "",
    tabs: (data.sheets || []).map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
    })),
  };
}

// Fetches one tab's full used range as a raw 2D array of strings — the exact same shape
// ingestRawRows()/applyTagRowsFromRecords() already expect from a parsed CSV/XLSX file or a
// vision-transcribed screenshot.
export async function fetchSheetGrid(spreadsheetId, sheetTitle) {
  const accessToken = await getAccessToken();
  const escapedTitle = sheetTitle.replace(/'/g, "''");
  const range = encodeURIComponent(`'${escapedTitle}'`);
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${range}`, {});
  const values = data.values || [];
  const width = values.reduce((w, row) => Math.max(w, row.length), 0);
  return values.map((row) => {
    const padded = row.map((v) => String(v ?? ""));
    while (padded.length < width) padded.push("");
    return padded;
  });
}
