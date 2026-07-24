/**
 * Date-normalization + row->column transposition for budgethq.spend_rows bulk writes — factored out
 * of api/workspaces/[id]/spend-rows.js (2026-07-23) so api/cron/sync-connectors.js's rolling-sync
 * writes go through the EXACT same date handling as a manual save, instead of a second, easily
 * drifting reimplementation. See spend-rows.js's own top-of-file doc comment for the full history of
 * why this normalization exists at all (a single unparseable date used to fail — and, worse, wipe —
 * an entire workspace's save).
 */

// Row dates aren't always real per-day dates by the time they reach this API — CSV imports (esp.
// the "flat"/recurring-monthly format) can carry values like "February 2026" or "Jul-26" straight
// through from the source file. The frontend's own parseSpendDate() (BudgetHQ.jsx) already treats
// these as valid, meaningful values everywhere else (pacing math, trend charts), but the RAW string
// is what gets sent here — and Postgres's date parser has no idea what "February 2026" means, so it
// throws (`invalid input syntax for type date`). Normalizing here (same rules as parseSpendDate,
// ported to run server-side) means every format the app already treats as valid elsewhere is also
// valid here, and unparseable rows get dropped individually (see toColumns) instead of taking the
// whole save down with them.
const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const pad = (n) => String(n).padStart(2, "0");
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(m[1])}-${pad(m[2])}`; }
  // "Jul-26", "Jul 2026", "July-2026", "Jul/26" — month name/abbreviation + 2-or-4-digit year
  m = s.match(/^([A-Za-z]{3,9})[\s\-/]+(\d{2,4})$/);
  if (m) {
    const mon = MONTH_ABBR[m[1].slice(0, 3).toLowerCase()];
    if (mon != null) { let y = +m[2]; if (y < 100) y += 2000; return `${y}-${pad(mon + 1)}-01`; }
  }
  // "2026-07" — year-month, no day
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-01`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Transposes an array of row objects into parallel column arrays for a single unnest()-based bulk
// insert — one round trip for the whole batch instead of one INSERT per row. Rows whose date can't
// be normalized to a real date are dropped (spend_rows.date is NOT NULL) rather than allowed to fail
// the whole batch.
export function toColumns(rows) {
  const withDates = rows.map((r) => ({ ...r, _date: normalizeDate(r.date) }));
  const valid = withDates.filter((r) => r._date);
  const skipped = rows.length - valid.length;
  if (skipped > 0) {
    console.error(
      `[spend-rows] Dropped ${skipped} row(s) with an unparseable date (examples: ${withDates
        .filter((r) => !r._date)
        .slice(0, 5)
        .map((r) => JSON.stringify(r.date))
        .join(", ")}) — these were excluded from the save instead of failing the whole batch.`
    );
  }
  return {
    skipped,
    campaign_group_name: valid.map((r) => r.campaign_group_name || ""),
    campaign_name: valid.map((r) => r.campaign_name || ""),
    campaign_id: valid.map((r) => r.campaign_id || null),
    platform: valid.map((r) => r.platform || null),
    campaign_type: valid.map((r) => r.campaign_type || null),
    date: valid.map((r) => r._date),
    as_of_date: valid.map((r) => normalizeDate(r.as_of_date)),
    spend: valid.map((r) => r.spend || 0),
    impressions: valid.map((r) => r.impressions || 0),
    clicks: valid.map((r) => r.clicks || 0),
    source: valid.map((r) => r.source || null),
  };
}
