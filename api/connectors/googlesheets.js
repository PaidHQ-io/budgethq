/**
 * Google Sheets connector — Google Ads brand-verification workaround (2026-07-31, per Mo)
 *
 * Google's own Google Ads connector (google.js) needs OAuth access to the Google Ads API's
 * restricted scope, which requires Google's full app-verification/brand-verification review before
 * it can be used by anyone outside a handful of test users — a slow, multi-week process. This
 * connector sidesteps that entirely: instead of BudgetHQ talking to Google Ads directly, the
 * workspace points some OTHER tool (Google Ads' own "Export to Sheets" scheduled report, a Sheets
 * add-on, Supermetrics, Funnel.io, an Apps Script, etc. — anything capable of landing spend data
 * into a Sheet on its own schedule) at a Google Sheet, and BudgetHQ just reads that Sheet daily like
 * any other live connector. No OAuth, no Google review, no restricted scope — the sheet only needs
 * to be link-shared ("Anyone with the link can view"), and this fetches it via Google's public
 * `/export?format=csv` endpoint the same way a browser would download it.
 *
 * NOT Google-Ads-specific despite the name of the problem it solves — the credential is just a
 * sheet URL, so a workspace could equally point this at a hand-maintained Sheet for any platform
 * that doesn't have a native connector at all. `platform` defaults to "Google" only because that's
 * the workaround this was built for; a sheet with its own Platform column overrides that per-row.
 *
 * SHEET FORMAT: same column vocabulary as the CSV upload flow (see core.js's REQUIRED_COLS/
 * OPTIONAL_COLS on the frontend) — Campaign Group Name/Spend/Date required, Campaign Name/Platform/
 * Campaign Type/Impressions/Clicks/Campaign ID/Ad Set ID optional. Headers are matched the same
 * fuzzy way the CSV upload's autoDetect() does (see COL_PATTERNS below — deliberately kept in sync
 * with core.js's copy of the same patterns) rather than requiring exact snake_case column names,
 * since there's no interactive mapping step possible for an unattended daily sync — whatever's
 * auto-detected on day 1 is what gets used every day after, so the fuzzy matching has to be good
 * enough to work unattended.
 *
 * DATE FILTERING: unlike every other connector here, Sheets has no native date-range query — the
 * whole sheet comes back every time, so getSpend filters rows to [startDate, endDate] itself.
 *
 * NOTE: this is BudgetHQ's own rollback-safety-net copy — the actual live sync path runs through
 * paidhq-core's identical copy of this file (spend syncs moved there 2026-07-30, see
 * api/spend.js's deprecation comment). Keep both in sync.
 */

const REQUIRED_COLS = ["campaign_group_name", "spend", "date"];

// Kept in sync with src/lib/core.js's COL_PATTERNS — see that file's autoDetect() for the canonical
// version this was copied from (not imported directly since this runs server-side, separate from
// the frontend bundle).
const COL_PATTERNS = {
  campaign_group_name: /^(?!.*status)campaign.?group/i,
  campaign_name: /^(?!.*status)(ad.?set|ad.?group)/i,
  spend: /(?!.*\bper\b)(cost|spend|amount)/i,
  date: /^date$|^day$|^month$|reporting\s*start/i,
  platform: /platform|traffic.source|channel|source/i,
  campaign_type: /campaign.?type/i,
  impressions: /^impr?\.?$|impression/i,
  clicks: /(?!.*\bper\b)(?!.*\brate\b)\bclicks?\b/i,
  campaign_id: /campaign.*id/i,
  adset_id: /ad.?set.*id|ad.?group.*id/i,
};

function autoDetectColumns(headers) {
  const m = {};
  headers.forEach((h) => {
    for (const [f, p] of Object.entries(COL_PATTERNS)) {
      if (!m[f] && p.test(h.trim())) m[f] = h;
    }
  });
  // Same disambiguation fallbacks as core.js's autoDetect() — a bare "Campaign" header only means
  // campaign_name once a distinct "Campaign Group" column was already found; otherwise it's the
  // group itself.
  if (!m.campaign_name) {
    const c = headers.find((h) => /^campaign$/i.test(h.trim()));
    if (c && m.campaign_group_name) m.campaign_name = c;
  }
  if (!m.campaign_group_name) {
    const c = headers.find((h) => /campaign/i.test(h) && !/id|group|type/i.test(h));
    if (c) m.campaign_group_name = c;
  }
  if (!m.spend) {
    const c = headers.find((h) => /cost|spend/i.test(h) && !/\bper\b/i.test(h));
    if (c) m.spend = c;
  }
  if (!m.date) {
    const c = headers.find((h) => /date|day|month/i.test(h));
    if (c) m.date = c;
  }
  return m;
}

// Accepts any normal Google Sheets share/edit link (docs.google.com/spreadsheets/d/{id}/edit#gid=X)
// as well as an already-built export or publish-to-web link, and always returns the plain CSV
// export URL — the one form that works unauthenticated against a link-shared ("Anyone with the
// link can view") sheet. gid defaults to 0 (the first tab) when the pasted link doesn't carry one,
// which is the common case for a link copied while sitting on the first/only tab.
function toCsvExportUrl(rawUrl) {
  const idMatch = String(rawUrl || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) {
    throw new Error(
      "Couldn't find a Google Sheet ID in that URL — paste the sheet's normal share link (looks like https://docs.google.com/spreadsheets/d/.../edit)."
    );
  }
  const sheetId = idMatch[1];
  const gidMatch = String(rawUrl).match(/[?#&]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

async function fetchSheetCsv(sheetUrl) {
  const exportUrl = toCsvExportUrl(sheetUrl);
  const res = await fetch(exportUrl, { redirect: "follow" });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Couldn\'t read this Google Sheet — make sure sharing is set to "Anyone with the link can view" (File > Share in Google Sheets), then try again.'
      );
    }
    throw new Error(`Couldn't download the Google Sheet (HTTP ${res.status}). Double check the link is correct.`);
  }
  const text = await res.text();
  // A private/unshared sheet still responds 200 here, but with Google's HTML sign-in page instead
  // of a real CSV — sniff for that instead of trusting the status code alone.
  if (/^\s*<(!doctype html|html)/i.test(text.slice(0, 200))) {
    throw new Error(
      'This Google Sheet isn\'t publicly viewable yet — set sharing to "Anyone with the link can view" (File > Share in Google Sheets), then try again.'
    );
  }
  return text;
}

export async function getSpend({ startDate, endDate, credential }) {
  const sheetUrl = credential?.sheetUrl;
  if (!sheetUrl) {
    throw new Error("This workspace hasn't connected a Google Sheet yet — reconnect this workspace's Google Sheets data source.");
  }

  const { default: Papa } = await import("papaparse");
  const csvText = await fetchSheetCsv(sheetUrl);
  const parsed = Papa.parse(csvText, { header: false, skipEmptyLines: true });
  const allRows = parsed.data || [];
  if (!allRows.length) throw new Error("The Google Sheet appears to be empty.");

  const headers = allRows[0].map((h) => String(h || "").trim());
  const colMap = autoDetectColumns(headers);
  const missing = REQUIRED_COLS.filter((f) => !colMap[f]);
  if (missing.length) {
    throw new Error(
      `Couldn't find a column for ${missing.join(", ")} in the Google Sheet. Expected headers like "Campaign Group Name", "Spend", and "Date" — same columns as BudgetHQ's CSV upload.`
    );
  }
  const colIndex = {};
  Object.entries(colMap).forEach(([field, header]) => {
    colIndex[field] = headers.indexOf(header);
  });
  const get = (row, field) => {
    const i = colIndex[field];
    return i != null && i >= 0 ? row[i] : undefined;
  };

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const rows = [];
  for (let i = 1; i < allRows.length; i++) {
    const r = allRows[i];
    if (!r || !r.length) continue;

    const rawDate = get(r, "date");
    if (!rawDate) continue;
    const d = new Date(rawDate);
    if (Number.isNaN(d.getTime())) continue;
    if (d < start || d > end) continue;

    const group = String(get(r, "campaign_group_name") || "").trim();
    if (!group) continue;

    const spend = parseFloat(String(get(r, "spend") || "0").replace(/[^0-9.-]/g, "")) || 0;

    rows.push({
      campaign_group_name: group,
      campaign_name: String(get(r, "campaign_name") || "").trim() || null,
      campaign_id: String(get(r, "campaign_id") || "").trim() || null,
      adset_id: String(get(r, "adset_id") || "").trim() || null,
      // Defaults to "Google" (not a specific sub-channel) since this connector exists to work
      // around Google Ads OAuth verification — a sheet without its own Campaign Type column just
      // reports as generic Google spend rather than split into Search/Display/Demand Gen/PMax.
      platform: String(get(r, "platform") || "").trim() || "Google",
      campaign_type: String(get(r, "campaign_type") || "").trim() || null,
      date: d.toISOString().slice(0, 10),
      spend: Math.round(spend * 100) / 100,
      impressions: parseInt(get(r, "impressions"), 10) || 0,
      clicks: parseInt(get(r, "clicks"), 10) || 0,
    });
  }

  return rows;
}

export const meta = {
  platform: "Google Sheets",
  label: "Google Sheets",
  icon: "GS",
  status: "live",
  perWorkspaceAuth: true,
  connectFields: [
    {
      key: "sheetUrl",
      label: "Google Sheet URL",
      placeholder: "https://docs.google.com/spreadsheets/d/.../edit#gid=0",
    },
  ],
};
