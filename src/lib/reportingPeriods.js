/**
 * Period-grain helpers for core.reporting_facts (period_type + period_start). Ported from
 * ReportingHQ (2026-07-30, per Mo — folding ReportingHQ into PaidHQ as a "Reporting Analyzer"
 * tab), unchanged — entirely product-agnostic date math, nothing ReportingHQ-specific about it.
 *
 * The AI extraction path (reportingAI.js) asks the model to compute period_start itself (it
 * already understands calendars, and this avoids writing a bespoke parser for every label format
 * Dreamdata/PowerBI might show — "Qtr 1 2024", "January 2024", "2024", a raw date, etc.) — these
 * helpers are a lightweight safety net that SNAPS whatever date comes back to the correct
 * start-of-period for its grain, rather than trusting the model got the exact day right, plus a
 * display-label formatter for the import review table.
 */
export const PERIOD_TYPES = ["day", "week", "month", "quarter", "year"];

export const PERIOD_TYPE_LABELS = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};

// Parses a YYYY-MM-DD (or any Date-parseable) string into a UTC-anchored Date, so day-of-month
// math below isn't shifted by the browser's local timezone.
//
// BUG FIX (2026-08-06, found while testing parsePeriodCell for pipelineColumnMapping.js's new
// per-row "period" support): a bare "YYYY-MM" (year-month, no day — e.g. "2026-01") fell through to
// the generic `new Date(s)` branch below. Per spec, a date-only ISO string parses as UTC midnight —
// but the very next lines then read it back with LOCAL getters (d.getFullYear()/getMonth()/getDate()),
// so in any timezone behind UTC that UTC midnight instant reads back as the LAST day of the PRIOR
// month locally, e.g. "2026-01" -> Dec 31 2025 -> normalized to "2025-12-01", one whole month early.
// Same underlying bug class as this session's earlier "Invalid Date"/one-day-early fixes elsewhere in
// the app (see core.js's parseSpendDate doc comment) — handled here the same way, with an explicit
// regex branch instead of trusting native Date parsing for an ambiguous/timezone-sensitive shape.
function parseDateUTC(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const ym = /^(\d{4})-(\d{2})$/.exec(s);
  if (ym) return new Date(Date.UTC(Number(ym[1]), Number(ym[2]) - 1, 1));
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

// Snaps an arbitrary date to the start of the given grain's period. day: unchanged. week: the
// Monday of that week (ISO week start). month: the 1st. quarter: the 1st of Jan/Apr/Jul/Oct.
// year: Jan 1. Returns null for an unparseable input or an unrecognized periodType.
export function normalizePeriodStart(periodType, dateInput) {
  const d = parseDateUTC(dateInput);
  if (!d || !PERIOD_TYPES.includes(periodType)) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-11
  switch (periodType) {
    case "day":
      return toISO(d);
    case "week": {
      // getUTCDay(): 0=Sun..6=Sat. ISO week starts Monday, so shift Sunday back 6 days, others
      // back (day-1) days.
      const dow = d.getUTCDay();
      const back = dow === 0 ? 6 : dow - 1;
      const monday = new Date(d);
      monday.setUTCDate(monday.getUTCDate() - back);
      return toISO(monday);
    }
    case "month":
      return toISO(new Date(Date.UTC(y, m, 1)));
    case "quarter": {
      const qStartMonth = Math.floor(m / 3) * 3;
      return toISO(new Date(Date.UTC(y, qStartMonth, 1)));
    }
    case "year":
      return toISO(new Date(Date.UTC(y, 0, 1)));
    default:
      return null;
  }
}

// Human-readable label for the import review table / any future reporting views. Assumes
// periodStart is already the correct start-of-period (i.e. has been through
// normalizePeriodStart) — doesn't re-derive the grain from the date, just formats it.
export function labelForPeriod(periodType, periodStart) {
  const d = parseDateUTC(periodStart);
  if (!d) return periodStart || "";
  const y = d.getUTCFullYear();
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  switch (periodType) {
    case "day":
      return `${monthNames[d.getUTCMonth()]} ${d.getUTCDate()}, ${y}`;
    case "week":
      return `Week of ${monthNames[d.getUTCMonth()]} ${d.getUTCDate()}, ${y}`;
    case "month":
      return `${monthNames[d.getUTCMonth()]} ${y}`;
    case "quarter":
      return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}`;
    case "year":
      return `${y}`;
    default:
      return periodStart;
  }
}

// Default period_start for "no date info at all" cases (a flat breakdown export with no period
// column) — today's month, so the manual period-picker in the review UI starts somewhere
// reasonable rather than blank.
export function defaultPeriodStart(periodType) {
  return normalizePeriodStart(periodType || "month", new Date().toISOString());
}

// Advances an already-normalized period_start (i.e. already the correct start-of-period for its
// grain — the output of normalizePeriodStart, not an arbitrary date) to the NEXT period's start,
// for the same grain. Used by the Data Audit tab's missing-period walk (computeReportingAudit in
// core.js) — the reporting_facts equivalent of computeDataAudit's day-by-day collapseMissing, just
// stepping by the row's own grain instead of always by one calendar day, since reporting_facts mixes
// day/week/month/quarter/year rows rather than being uniformly daily like spend_rows. Returns null
// for an unparseable input or unrecognized periodType, same failure contract as normalizePeriodStart.
export function stepPeriodStart(periodType, periodStart) {
  const d = parseDateUTC(periodStart);
  if (!d || !PERIOD_TYPES.includes(periodType)) return null;
  switch (periodType) {
    case "day":
      d.setUTCDate(d.getUTCDate() + 1);
      return toISO(d);
    case "week":
      d.setUTCDate(d.getUTCDate() + 7);
      return toISO(d);
    case "month":
      return toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
    case "quarter":
      return toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1)));
    case "year":
      return toISO(new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1)));
    default:
      return null;
  }
}
