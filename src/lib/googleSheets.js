/**
 * "Export to / connect from Google Sheets" — client-side only, no server-side OAuth/token
 * storage. Both are one-shot actions (create a new spreadsheet and write to it, or pick an
 * existing one and read it), not an ongoing sync, so there's no need to persist a refresh token
 * anywhere: Google Identity Services' token client gets a short-lived access token in the
 * browser, it's used for the one action, and it's discarded.
 *
 * Reuses the SAME Google OAuth Client ID already created for "Sign in with Google"
 * (VITE_GOOGLE_CLIENT_ID) — Client IDs aren't secret (Google documents them as safe to ship in
 * frontend code); only that OAuth client's Client Secret is sensitive, and it's never used here
 * (it lives solely in Supabase's server-side login flow).
 *
 * Scope: https://www.googleapis.com/auth/drive.file — deliberately NOT the full
 * .../auth/spreadsheets scope. drive.file is per-file: it only grants access to (a) files this
 * app creates itself (export — always allowed) and (b) files the user explicitly selects through
 * Google's own Picker widget (connect — see pickSpreadsheet() below). It can never see or touch
 * any other file in the user's Drive. That's what keeps this out of Google's "sensitive scope"
 * bucket, which is what avoids needing a scope justification + demo video for OAuth verification.
 * A "paste any spreadsheet URL" flow would NOT work under drive.file (Google has no way to know
 * the user consented to that specific file) — that's why the connect flow below always routes
 * through the Picker rather than accepting a typed-in link.
 *
 * Requires three one-time setup steps in the Google Cloud project this Client ID belongs to:
 *   1. Enable the "Google Sheets API" AND the "Google Picker API" (APIs & Services -> Library).
 *   2. Add the https://www.googleapis.com/auth/drive.file scope on the OAuth consent screen
 *      (Google Auth Platform -> Audience/Data Access -> Add or remove scopes).
 *   3. Create an API key (APIs & Services -> Credentials -> Create Credentials -> API key),
 *      restrict it to the Google Picker API, and set it as VITE_GOOGLE_PICKER_API_KEY. The
 *      Picker widget needs this in addition to the OAuth access token to render.
 * While that consent screen is in "Testing" mode, only test users explicitly added in Google
 * Cloud Console can use this — publishing it for arbitrary users requires Google's verification
 * review, though drive.file being non-sensitive makes that review much lighter than a sensitive
 * scope like full spreadsheets access would.
 */
const GIS_SRC = "https://accounts.google.com/gsi/client";
const PICKER_SRC = "https://apis.google.com/js/api.js";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/drive.file";

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

// Fetches Google's Identity Services script ahead of time so it's already cached by the time the
// user clicks Export/Connect. This matters because requestAccessToken() opens a real browser
// popup for the consent screen, and browsers only reliably allow popups that open synchronously
// within a click handler — if getAccessToken() has to `await loadGis()` first (a real network
// fetch on the very first use), that async gap can make the browser silently block the popup with
// no error surfaced anywhere, which looks exactly like "I clicked Connect and nothing happened."
// Safe to call speculatively and ignore failures — the real getAccessToken() call will surface a
// proper error if the script truly can't load.
export function preloadGoogleSheetsApi() {
  loadGis().catch(() => {});
}

let pickerLoadPromise = null;
function loadPicker() {
  if (window.google?.picker) return Promise.resolve();
  if (pickerLoadPromise) return pickerLoadPromise;
  pickerLoadPromise = new Promise((resolve, reject) => {
    const finish = () => {
      window.gapi.load("picker", {
        callback: resolve,
        onerror: () => reject(new Error("Couldn't load Google's file picker.")),
      });
    };
    if (window.gapi?.load) { finish(); return; }
    const script = document.createElement("script");
    script.src = PICKER_SRC;
    script.async = true;
    script.defer = true;
    script.onload = finish;
    script.onerror = () => reject(new Error("Couldn't load Google's file picker."));
    document.head.appendChild(script);
  });
  return pickerLoadPromise;
}

// Same rationale as preloadGoogleSheetsApi() above — warms the Picker's script + gapi module
// ahead of the user's first click so opening the picker doesn't stall on a cold network fetch.
export function preloadGoogleSheetsPicker() {
  loadPicker().catch(() => {});
}

let tokenClient = null;
let cachedToken = null; // { accessToken, expiresAt }
let hasPromptedOnce = false;
let forceAccountPickerNext = false;

// The cached token/account is shared across every export and connect call in the page session —
// by design, so a user isn't re-prompted for every single action. But that means once you've
// granted access as Account A, every later call silently reuses Account A even if the sheet you
// actually want lives under Account B, producing a permission error from Google's API rather than
// any obvious "wrong account" signal. Call this before retrying to force Google's account chooser
// on the next request instead of silently reusing whatever's cached.
export function switchGoogleAccount() {
  cachedToken = null;
  forceAccountPickerNext = true;
}

// Requests a token for a given GIS `prompt` value. Split out from getAccessToken so a stalled
// silent attempt can transparently retry once with a visible popup (see the isSilent branch
// below) rather than making the caller wait out the full timeout for something that was never
// going to complete.
function requestToken(prompt, { allowSilentRetry = true } = {}) {
  return new Promise((resolve, reject) => {
    // Silent attempts (`prompt: ""`) don't open any visible window — GIS tries a hidden
    // background refresh instead. Increasingly, Chrome's third-party-cookie/storage restrictions
    // make that hidden refresh just hang forever with no callback ever firing and nothing visible
    // on screen at all — that's the "I clicked Connect and literally nothing happened" report.
    // Google's docs say silent mode "falls back to a popup on its own" when it can't complete
    // silently, but that fallback isn't reliable in practice. So: give a silent attempt a short
    // 4s leash, and if it hasn't resolved by then, explicitly retry once with `prompt: "consent"`
    // to force a real, visible popup instead of continuing to wait on a dead silent request.
    // Explicit prompts (consent / select_account consent) get the full 25s, which comfortably
    // covers an actual pick-account-review-scopes-click-Allow flow.
    const isSilent = prompt === "";
    const budgetMs = isSilent ? 4000 : 25000;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      if (isSilent && allowSilentRetry) {
        settled = true;
        requestToken("consent", { allowSilentRetry: false }).then(resolve, reject);
        return;
      }
      settled = true;
      reject(new Error("Google's sign-in window didn't open or wasn't completed — check if your browser blocked a popup for this site, allow it, and try again."));
    }, budgetMs);
    tokenClient.callback = (resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
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
    tokenClient.requestAccessToken({ prompt });
  });
}

async function getAccessToken() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("Google Sheets export isn't configured yet — VITE_GOOGLE_CLIENT_ID is missing.");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000 && !forceAccountPickerNext) {
    return cachedToken.accessToken;
  }
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SHEETS_SCOPE,
      callback: () => {}, // replaced per-request inside requestToken()
    });
  }
  // First grant in this page session shows the consent popup; later refreshes try silently
  // first (requestToken auto-retries with a visible popup if the silent attempt stalls).
  // switchGoogleAccount() forces Google's account chooser explicitly, overriding both of those.
  const prompt = forceAccountPickerNext ? "select_account consent" : (hasPromptedOnce ? "" : "consent");
  forceAccountPickerNext = false;
  return requestToken(prompt);
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

  // pdfOnly sections (e.g. the redundant segments table when chart data is present) are excluded
  // from Sheets, same as the other tabular exporters — see reports.js tabularSections.
  const sections = report.sections.filter((s) => !s.pdfOnly);
  const sheetTitles = sections.map((sec, i) => safeSheetTitle(sec.heading, i));
  const created = await sheetsFetch(accessToken, "", {
    method: "POST",
    body: JSON.stringify({
      properties: { title: report.title },
      sheets: sheetTitles.map((title) => ({ properties: { title } })),
    }),
  });

  const data = created.sheets.map((sheet, i) => {
    const sec = sections[i];
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
 * This is deliberately the lightweight half of the live-connection feature: the user picks a
 * sheet through Google's Picker widget, and its raw grid is fetched once and fed into the same
 * header-row-picker / column-mapping pipeline a CSV upload or screenshot import already goes
 * through. Nothing is stored — no refresh token, no server round-trip — so this can't run in the
 * background or auto-refresh on its own; that's the separate, heavier piece (server-side OAuth
 * authorization-code flow + stored refresh token + a sync schedule) planned as a follow-up.
 */

// Opens Google's Picker UI filtered to Spreadsheets, and resolves with the chosen file's
// {id, name} — or null if the user closed the picker without selecting anything. Selecting a
// file here is what grants this drive.file-scoped token access to read it; there is no other way
// to hand an existing spreadsheet ID to this app (see the scope note at the top of this file).
export async function pickSpreadsheet() {
  const apiKey = import.meta.env.VITE_GOOGLE_PICKER_API_KEY;
  if (!apiKey) {
    throw new Error("Google Sheets picker isn't configured yet — VITE_GOOGLE_PICKER_API_KEY is missing.");
  }
  const [accessToken] = await Promise.all([getAccessToken(), loadPicker()]);
  return new Promise((resolve, reject) => {
    try {
      const view = new window.google.picker.DocsView(window.google.picker.ViewId.SPREADSHEETS)
        .setMode(window.google.picker.DocsViewMode.LIST);
      const picker = new window.google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        .setCallback((data) => {
          if (data.action === window.google.picker.Action.PICKED) {
            const doc = data.docs[0];
            resolve({ id: doc.id, name: doc.name });
          } else if (data.action === window.google.picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (err) {
      reject(err);
    }
  });
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

// Appends rows to an EXISTING spreadsheet the user picked via pickSpreadsheet() above, instead
// of exportReportToGoogleSheets' always-create-a-new-file behavior (2026-07-31, per Mo — "append
// to an existing sheet on export instead of always creating a new file"). Same drive.file grant
// covers this: picking a file through the Picker widget is itself what authorizes read+write
// access to that specific file, so no extra scope/consent is needed beyond the existing export
// flow's.
//
// Creates the target tab if it doesn't already exist (via a new sheet added to the SAME
// spreadsheet, not a new spreadsheet). Only writes `headerRow` when the target tab is brand new
// or currently empty — appending onto a tab that already has a header + prior rows shouldn't
// re-stamp the header on every append. Uses the Sheets API's values:append with
// insertDataOption=INSERT_ROWS, which finds the end of the existing table itself — no need to
// track/pass a row offset from the caller.
export async function appendRowsToGoogleSheet(spreadsheetId, sheetTitle, headerRow, dataRows) {
  const accessToken = await getAccessToken();
  const { tabs } = await listSheetTabs(spreadsheetId);
  const existing = tabs.find((t) => t.title === sheetTitle);
  let createdTab = false;
  if (!existing) {
    await sheetsFetch(accessToken, `/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetTitle } } }] }),
    });
    createdTab = true;
  }
  let includeHeader = createdTab;
  if (!createdTab) {
    const currentGrid = await fetchSheetGrid(spreadsheetId, sheetTitle);
    includeHeader = currentGrid.length === 0;
  }
  const values = includeHeader ? [headerRow, ...dataRows] : dataRows;
  const escapedTitle = sheetTitle.replace(/'/g, "''");
  const range = encodeURIComponent(`'${escapedTitle}'!A1`);
  await sheetsFetch(accessToken, `/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values }),
  });
  return { url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, createdTab, rowsAdded: values.length };
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
