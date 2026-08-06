import { useMemo, useState } from "react";
import { Btn, PixelPanel, Sel } from "./shared.jsx";
import {
  guessColumnMapping,
  findDuplicateMappingTargets,
  buildNormalizedPipelineRows,
  detectImportPeriod,
  detectDayColumn,
  detectMonthColumn,
  detectQuarterColumn,
  isTotalRow,
  PIPELINE_METRIC_MAP_OPTIONS,
  PIPELINE_STRUCTURAL_FIELD_OPTIONS,
} from "../lib/pipelineColumnMapping.js";
import { normalizePeriodStart, labelForPeriod } from "../lib/reportingPeriods.js";
import { PLATFORM_OPTIONS } from "../lib/core.js";
import { usePersistentState } from "../lib/persist.js";

// Column-mapping + period step for a raw pipeline CSV/XLSX (2026-08-02/03, per Mo — see
// pipelineColumnMapping.js's top doc comment for the full "why"). Sits between the raw file (every
// row/column read untouched) and the Pipeline Tagger table: every raw header shows up here as its
// own column with a dropdown, defaulted to a best-guess target but fully overridable, with a live
// preview of that column's actual values so a wrong guess is obvious before anything is normalized.
// Below that, a period control resolves the ONE month/quarter this whole file represents — either
// auto-detected or picked manually — since per Mo, an imported pipeline file carries a single
// reporting period for every row, not a per-row date. Confirming builds the normalized rows (already
// dated) and hands them straight to the parent for import — this component never calls the import
// API itself.
const PREVIEW_ROWS = 6;

function targetLabel(target, metricOptions, structuralFieldOptions) {
  if (!target || target === "ignore") return "Ignore";
  const structural = (structuralFieldOptions || PIPELINE_STRUCTURAL_FIELD_OPTIONS).find((f) => f.value === target);
  if (structural) return structural.label;
  if (target.startsWith("tag::")) return target.slice(5);
  if (target.startsWith("metric::")) {
    const key = target.slice(8);
    return metricOptions.find((m) => m.key === key)?.label || key;
  }
  return target;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// A generous-enough range for "which year is this export for" without an unbounded free-text
// field — 6 years back covers a multi-year historical pipeline dump, 1 year forward covers a
// forward-looking goals-style import.
function yearOptions() {
  const y = new Date().getFullYear();
  const out = [];
  for (let i = y + 1; i >= y - 6; i--) out.push(i);
  return out;
}

const selStyle = { padding: "5px 8px", fontSize: 12 };

// initialMapping/initialPeriodMode/initialYear/initialMonth/initialQuarter/initialHardcodedChannel
// (2026-08-06, per Mo — "save the files I upload... with one click apply them/import them into
// PaidHQ"): when File Store's "Apply" replays a previously-imported pipeline file, these seed every
// piece of state below with the EXACT mapping/period/channel choices confirmed the first time this
// file was imported (captured via this component's own onConfirm below, persisted by
// ReportingAnalyzer.jsx's handleMappedImport as a linked File Store sidecar) — the review screen
// still shows for a final glance/edit (per Mo's own choice when this was scoped — "re-open the
// review screen, pre-filled" over a fully silent replay), it just starts from the prior answer
// instead of a fresh guess. All are simply undefined for every live/first-time import, in which case
// this component behaves exactly as it did before this feature existed.
// metricOptions/metricKeySuffix (2026-08-19, per Mo's goals-import metric-vocabulary fix — see
// pipelineColumnMapping.js's GOAL_METRIC_MAP_OPTIONS doc note): which metric list this mapping step
// offers as targets. Defaults to PIPELINE_METRIC_MAP_OPTIONS/"" — unchanged behavior for every
// existing (pipeline) call site. GoalsObjectives.jsx passes GOAL_METRIC_MAP_OPTIONS/"_goal" so a
// goal number always lands under a distinctly-suffixed key, never the same key real pipeline
// performance data uses for the same underlying concept.
// structuralFieldOptions/showChannelSection/title/description (2026-08-19, per Mo — "once the user
// selects 'goals' as the import type, it should be a different import UX and process than the
// pipeline performance import"): everything pipeline-specific about this screen — Ad Group/Channel as
// mapping targets, the Channel section, the pipeline-flavored copy — is now prop-driven rather than
// hardcoded, so GoalsObjectives.jsx can offer a visibly different screen (GOALS_STRUCTURAL_FIELD_
// OPTIONS, no Channel section, goals-flavored copy) from the SAME component instead of forking a
// second one. Every default here reproduces pipeline import's exact prior behavior unchanged.
export default function PipelineColumnMapper({
  T, headers, rows, tagDims, sourceLabel, onConfirm, onDiscard,
  initialMapping, initialPeriodMode, initialYear, initialMonth, initialQuarter, initialHardcodedChannel,
  metricOptions = PIPELINE_METRIC_MAP_OPTIONS, metricKeySuffix = "",
  structuralFieldOptions = PIPELINE_STRUCTURAL_FIELD_OPTIONS, showChannelSection = true,
  title = "Map your columns",
  description = "Every column from your file is listed below with a best guess at what it is — change any of them, or leave a column on \"Ignore\" if it doesn't matter. Cost-per and conversion-rate columns aren't mapping targets here; PaidHQ computes those from the absolute numbers you map (Spend, Leads, MQLs, etc.) once these rows are tagged. Every row in the file comes in regardless of what's mapped — nothing gets filtered out.",
}) {
  const structuralFieldValues = useMemo(() => structuralFieldOptions.map((f) => f.value), [structuralFieldOptions]);
  // Lazy init so re-renders (e.g. from the parent's other state changing) don't re-run the guess and
  // clobber anything the user already overrode.
  const [mapping, setMapping] = useState(() =>
    initialMapping || Object.fromEntries(guessColumnMapping(headers, tagDims, metricKeySuffix, structuralFieldValues).map((t, i) => [i, t]))
  );

  const setColumnTarget = (i, target) => setMapping((prev) => ({ ...prev, [i]: target }));

  const dupeTargets = useMemo(() => findDuplicateMappingTargets(mapping), [mapping]);
  const mappedCount = useMemo(() => Object.values(mapping).filter((t) => t && t !== "ignore").length, [mapping]);
  // Which of the 9 canonical metrics (PIPELINE_METRIC_MAP_OPTIONS) DIDN'T get mapped to any column
  // (2026-08-05, per Mo — "pipeline value still isn't coming in ... blank everywhere"). The alias
  // guesser only exact-matches a header against a known list (see pipelineColumnMapping.js's own
  // doc comment on why that's deliberate) — a header spelled slightly differently than expected
  // (or genuinely absent from this file) silently leaves that metric on "Ignore," which used to be
  // invisible until someone noticed the resulting column was empty everywhere downstream. This is
  // purely informational, not a blocker (a file legitimately might not report every metric — Closed
  // Lost especially), but it puts every miss in front of the person confirming the import instead of
  // depending on them to notice one bad dropdown among many.
  const mappedMetricKeys = useMemo(
    () => new Set(Object.values(mapping).filter((t) => t?.startsWith("metric::")).map((t) => t.slice(8))),
    [mapping]
  );
  const unmappedMetrics = useMemo(
    () => metricOptions.filter((m) => !mappedMetricKeys.has(m.key)),
    [mappedMetricKeys, metricOptions]
  );

  // LAST-USED PERIOD/CHANNEL (2026-08-08, per Mo — "let's keep the same reporting period and the
  // channel that was previously selected" — a fresh, non-replay import used to always reset the
  // period to "now" and the channel to "Don't set," forcing a full re-pick on every single-platform
  // file even though Mo's own workflow, per the CHANNEL AT IMPORT doc comment above, is importing
  // one platform's file at a time — the same channel and (often) the same reporting month/quarter as
  // the last file. Device-local (usePersistentState/localStorage, same as every other UI preference
  // in this app) rather than server-side — this is "what did I pick last time on THIS browser," not
  // workspace data. Deliberately separate from initialMapping/initialPeriodMode/etc above: those come
  // from a SPECIFIC file's own saved config (File Store "Apply" replay) and still win outright when
  // present — this is only the fallback for a genuinely fresh import that has no per-file config of
  // its own yet.
  const [lastPeriodMode, setLastPeriodMode] = usePersistentState("paidhq_pipeline_import_last_periodMode", "month");
  const [lastYear, setLastYear] = usePersistentState("paidhq_pipeline_import_last_year", () => new Date().getFullYear());
  const [lastMonth, setLastMonth] = usePersistentState("paidhq_pipeline_import_last_month", () => new Date().getMonth() + 1);
  const [lastQuarter, setLastQuarter] = usePersistentState("paidhq_pipeline_import_last_quarter", () => Math.floor(new Date().getMonth() / 3) + 1);
  const [lastHardcodedChannel, setLastHardcodedChannel] = usePersistentState("paidhq_pipeline_import_last_channel", "");

  // PERIOD: detected once per file (headers/rows never change under this component), then the user
  // can either accept it or switch to picking one manually — see detectImportPeriod's doc comment
  // for exactly what "detected" means (every row's period column collapsing to the same single
  // month or quarter). `periodMode` "detected" is only ever the initial value when detection
  // actually succeeded; once the user switches away from it there's no way back except re-uploading,
  // which is fine since overriding a real detection should be rare. Priority when nothing's been
  // manually touched yet: a file-specific replay config, then this file's OWN real detection (a
  // stronger signal than a remembered preference), then last time's preference, then today.
  const detected = useMemo(() => detectImportPeriod(headers, rows), [headers, rows]);
  const [periodModeRaw, setPeriodModeRaw] = useState(() => initialPeriodMode || (detected ? "detected" : lastPeriodMode));
  const [yearRaw, setYearRaw] = useState(() => initialYear || lastYear);
  const [monthRaw, setMonthRaw] = useState(() => initialMonth || lastMonth); // 1-12
  const [quarterRaw, setQuarterRaw] = useState(() => initialQuarter || lastQuarter); // 1-4
  // Wrapped setters also remember the choice for next time — "detected" itself is never persisted
  // (it's meaningless without THIS file's own detection result), every other value is.
  const periodMode = periodModeRaw;
  const setPeriodMode = (v) => { setPeriodModeRaw(v); if (v !== "detected") setLastPeriodMode(v); };
  const year = yearRaw;
  const setYear = (v) => { setYearRaw(v); setLastYear(v); };
  const month = monthRaw;
  const setMonth = (v) => { setMonthRaw(v); setLastMonth(v); };
  const quarter = quarterRaw;
  const setQuarter = (v) => { setQuarterRaw(v); setLastQuarter(v); };

  const resolvedPeriod = useMemo(() => {
    if (periodMode === "detected") return detected;
    if (periodMode === "month") {
      return { periodType: "month", periodStart: normalizePeriodStart("month", `${year}-${String(month).padStart(2, "0")}-01`) };
    }
    if (periodMode === "quarter") {
      const qStartMonth = (quarter - 1) * 3 + 1;
      return { periodType: "quarter", periodStart: normalizePeriodStart("quarter", `${year}-${String(qStartMonth).padStart(2, "0")}-01`) };
    }
    return null;
  }, [periodMode, detected, year, month, quarter]);

  // WIDE/MONTH-OR-QUARTER-COLUMN FILES (2026-08-19, per Mo — a goals file with one row per Product
  // and 12 separate month columns per metric, e.g. "January"/"February"/... twice over for two
  // different goal metrics, plus Q1-Q4/grand-total columns that must NOT also be treated as periods —
  // see detectMonthColumn/detectQuarterColumn's own doc comments for why only bare month/quarter
  // labels match, and "month and/or quarter headers" — a file might use quarter columns instead of
  // month columns, with no month columns at all). Any header that resolves to a month OR bare quarter
  // number gets its own {periodType,periodStart} entry here, keyed by header index, using `year` from
  // the Reporting period section below as the year to pair every detected column with (the single most
  // sensible reuse of that control — the file itself never states a year on a bare month/quarter
  // header, so someone has to pick one, and periodMode's own year field is already exactly that "which
  // year is this file for" input). buildNormalizedPipelineRows uses this to fan a single source row
  // out into one row per distinct period for any metric column mapped under such a header, while every
  // metric column NOT in a detected header still falls back to the single resolvedPeriod (or a mapped
  // "period" column's own per-row value — see rowPeriodYear below), unaffected — so a normal (non-wide)
  // file produces columnPeriods={} and behaves exactly as before this feature existed.
  const columnPeriods = useMemo(() => {
    const out = {};
    (headers || []).forEach((h, i) => {
      // Day checked first (2026-08-06, per Mo's Dreamdata daily-MQL export) — a full calendar-date
      // header already carries its own year, no need for the `year` picker below at all, and it's
      // strictly more specific than a month/quarter match so it should win if a header somehow could
      // satisfy more than one (in practice it can't — see each detector's own regex).
      const day = detectDayColumn(h);
      if (day) { out[i] = { periodType: "day", periodStart: day }; return; }
      const m = detectMonthColumn(h);
      if (m) { out[i] = { periodType: "month", periodStart: normalizePeriodStart("month", `${year}-${String(m).padStart(2, "0")}-01`) }; return; }
      const q = detectQuarterColumn(h);
      if (q) out[i] = { periodType: "quarter", periodStart: normalizePeriodStart("quarter", `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`) };
    });
    return out;
  }, [headers, year]);
  const hasWideColumns = Object.keys(columnPeriods).length > 0;

  // VERTICAL PERIOD COLUMN (2026-08-19, per Mo — "month and/or quarter headers ... could be
  // horizontal or vertical"): when the user maps a column to "period" (only offered when the caller's
  // structuralFieldOptions includes it — currently just GoalsObjectives.jsx), buildNormalizedPipelineRows
  // dates each row from THAT row's own cell instead of the single whole-file resolvedPeriod.
  // rowPeriodYear is passed through as the fallback year for a bare month/quarter cell with no year of
  // its own (e.g. a "Month" column just containing "January") — same `year` control as columnPeriods
  // above.
  const periodColumnMapped = useMemo(() => Object.values(mapping).includes("period"), [mapping]);

  // TOTAL/SUMMARY ROWS (2026-08-19, per Mo — "we need to ignore total rows or columns"): computed here
  // purely so the user can SEE, before confirming, how many rows will be silently skipped — the actual
  // skip happens inside buildNormalizedPipelineRows using the identical isTotalRow rule.
  const totalRowCount = useMemo(() => (rows || []).filter((r) => isTotalRow(headers, r, mapping)).length, [headers, rows, mapping]);

  // CHANNEL AT IMPORT (2026-08-05, per Mo — "I'm going to start bringing the data in channel by
  // channel ... there are many cases where the channel is Bing but the campaign starts with SEA-
  // ... I would like a hard coded channel field that is hard coded when the data is imported"):
  // a "channel" column mapping (guessed or manual) still works as before, but Mo's own point is that
  // for HIS data neither the campaign name nor a Channel-looking column in the source export can be
  // trusted — he knows which platform a given file came from because he's importing it one platform
  // at a time. hardcodedChannel, when set, overrides whatever any mapped "channel" column would have
  // produced (see buildNormalizedPipelineRows's own doc comment) — left on "Don't set" this behaves
  // exactly as it did before this feature existed.
  const channelColumnMapped = useMemo(() => Object.values(mapping).includes("channel"), [mapping]);
  // initialHardcodedChannel !== undefined (not ||) — a replay config that explicitly saved "Don't
  // set" (empty string) must stay empty, not fall through to whatever channel was last picked for a
  // DIFFERENT file.
  const [hardcodedChannelRaw, setHardcodedChannelRaw] = useState(() => (initialHardcodedChannel !== undefined ? initialHardcodedChannel : lastHardcodedChannel));
  const hardcodedChannel = hardcodedChannelRaw;
  const setHardcodedChannel = (v) => { setHardcodedChannelRaw(v); setLastHardcodedChannel(v); };

  const canConfirm = dupeTargets.length === 0 && Boolean(resolvedPeriod?.periodStart);

  // Second argument (2026-08-06, per Mo's save-and-one-click-reapply request) hands the caller
  // exactly what was just confirmed — mapping/periodMode+year/month/quarter/hardcodedChannel — so
  // ReportingAnalyzer.jsx's handleMappedImport can persist it as this file's linked config for next
  // time. Every existing caller before this feature only used the first argument; this is purely
  // additive.
  const handleConfirm = () => {
    if (!canConfirm) return;
    const normalized = buildNormalizedPipelineRows({ headers, rows }, mapping, sourceLabel, resolvedPeriod, hardcodedChannel, columnPeriods, year);
    onConfirm(normalized, { mapping, periodMode, year, month, quarter, hardcodedChannel });
  };

  return (
    <PixelPanel T={T} contentStyle={{ padding: 20, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 4 }}>
            {title} — {rows.length} row{rows.length === 1 ? "" : "s"} detected
          </div>
          <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6, maxWidth: 640 }}>
            {description}
          </div>
        </div>
        {mappedCount === 0 && (
          <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.warning, whiteSpace: "nowrap" }}>No columns mapped yet</span>
        )}
      </div>

      {dupeTargets.length > 0 && (
        <div style={{ marginBottom: 12, padding: "9px 12px", background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.danger }}>
          More than one column is mapped to {dupeTargets.map((t) => `"${targetLabel(t, metricOptions, structuralFieldOptions)}"`).join(", ")} — each
          target can only be used once. Change one of them to continue.
        </div>
      )}

      {unmappedMetrics.length > 0 && (
        <div style={{ marginBottom: 12, padding: "9px 12px", background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.warning }}>
          Not mapped to any column: {unmappedMetrics.map((m) => `"${m.label}"`).join(", ")}. If your file has this
          data under a header the guess above didn't catch, find that column and set it to the matching Metric in
          its dropdown — otherwise this is expected and fine to ignore.
        </div>
      )}

      {totalRowCount > 0 && (
        <div style={{ marginBottom: 12, padding: "9px 12px", background: T.accentBg, border: `1px solid ${T.accentBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.text }}>
          {totalRowCount} row{totalRowCount === 1 ? "" : "s"} look{totalRowCount === 1 ? "s" : ""} like a Total/Summary row
          (e.g. a "Grand Total" line) and will be skipped automatically — they're never counted as real data.
        </div>
      )}

      <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: T.r8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              {headers.map((h, i) => (
                <th key={i} style={{ padding: "8px 10px", minWidth: 150, verticalAlign: "top", background: T.surfaceEl }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: columnPeriods[i] ? 2 : 6, maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h}>
                    {h}
                  </div>
                  {columnPeriods[i] && (
                    <div style={{ fontSize: 10 * (T.fsScale || 1), color: T.accent, marginBottom: 6 }}>
                      → {labelForPeriod(columnPeriods[i].periodType, columnPeriods[i].periodStart)}
                    </div>
                  )}
                  <Sel T={T} value={mapping[i] || "ignore"} onChange={(v) => setColumnTarget(i, v)} style={{ fontSize: 12 * (T.fsScale || 1), padding: "4px 6px" }}>
                    <option value="ignore">Ignore</option>
                    {structuralFieldOptions.map((f) => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                    {(tagDims || []).length > 0 && (
                      <optgroup label="Tag dimension">
                        {tagDims.map((d) => (
                          <option key={d} value={`tag::${d}`}>{d}</option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Metric">
                      {metricOptions.map((m) => (
                        <option key={m.key} value={`metric::${m.key}`}>{m.label}</option>
                      ))}
                    </optgroup>
                  </Sel>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, PREVIEW_ROWS).map((r, ri) => (
              <tr key={ri} style={{ borderBottom: `1px solid ${T.border}` }}>
                {headers.map((_, ci) => (
                  <td key={ci} style={{ padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), color: T.textSub, maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={String(r[ci] ?? "")}>
                    {String(r[ci] ?? "") || "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_ROWS && (
        <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginTop: 6 }}>
          + {rows.length - PREVIEW_ROWS} more row{rows.length - PREVIEW_ROWS === 1 ? "" : "s"} not shown here — all of them come in once you confirm.
        </div>
      )}

      <div style={{ marginTop: 16, padding: "12px 14px", background: T.surfaceEl, border: `1px solid ${T.border}`, borderRadius: T.r8 }}>
        <div style={{ fontSize: 11 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, marginBottom: 8 }}>
          Reporting period
        </div>
        {hasWideColumns && (
          <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.5, marginBottom: 8 }}>
            {Object.keys(columnPeriods).length} column{Object.keys(columnPeriods).length === 1 ? "" : "s"} above were recognized as
            individual days, months, or quarters (marked with <span style={{ color: T.accent }}>→</span>) — each becomes its own
            dated row (a full-date column already carries its own year; a bare month/quarter column uses the year picked below).
            The period below only applies to any OTHER mapped metric column that isn't one of those.
          </div>
        )}
        {periodColumnMapped && (
          <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.5, marginBottom: 8 }}>
            A column is mapped to "Month / Quarter (varies per row)" — each row will be dated from its own value in that
            column (falling back to the year picked below if that row's value is a bare month/quarter with no year). The
            period below only applies to any row whose own period cell doesn't parse.
          </div>
        )}
        {periodMode === "detected" && detected ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13 * (T.fsScale || 1), color: T.text }}>
              Detected: <strong>{labelForPeriod(detected.periodType, detected.periodStart)}</strong> — every row will use this period.
            </span>
            <Btn T={T} variant="ghost" size="sm" onClick={() => setPeriodMode("month")}>Use a different period</Btn>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub }}>
              {detected ? "This file has no single detected period." : "Couldn't auto-detect a period from this file."} Every row will be dated as:
            </span>
            <Sel T={T} value={periodMode} onChange={setPeriodMode} style={{ ...selStyle, width: 110 }}>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
            </Sel>
            <Sel T={T} value={String(year)} onChange={(v) => setYear(Number(v))} style={{ ...selStyle, width: 90 }}>
              {yearOptions().map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Sel>
            {periodMode === "month" ? (
              <Sel T={T} value={String(month)} onChange={(v) => setMonth(Number(v))} style={{ ...selStyle, width: 130 }}>
                {MONTH_NAMES.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </Sel>
            ) : (
              <Sel T={T} value={String(quarter)} onChange={(v) => setQuarter(Number(v))} style={{ ...selStyle, width: 90 }}>
                {[1, 2, 3, 4].map((q) => (
                  <option key={q} value={q}>Q{q}</option>
                ))}
              </Sel>
            )}
          </div>
        )}
      </div>

      {showChannelSection && (
        <div style={{ marginTop: 12, padding: "12px 14px", background: T.surfaceEl, border: `1px solid ${T.border}`, borderRadius: T.r8 }}>
          <div style={{ fontSize: 11 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, marginBottom: 8 }}>
            Channel
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, maxWidth: 420, lineHeight: 1.5 }}>
              {channelColumnMapped
                ? "A column is already mapped to Channel above. To force every row in this file to one channel instead (e.g. a campaign-naming quirk makes the source column unreliable), pick it here — it overrides the mapped column."
                : "No Channel column mapped above. If this whole file is one platform, set it here so every row is tagged with it:"}
            </span>
            <Sel value={hardcodedChannel} onChange={setHardcodedChannel} T={T} style={{ width: 160 }}>
              <option value="">Don't set</option>
              {PLATFORM_OPTIONS.filter((p) => p !== "auto").map((p) => <option key={p} value={p}>{p}</option>)}
            </Sel>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
        <Btn T={T} variant="primary" size="md" disabled={!canConfirm} onClick={handleConfirm}>
          Bring in {rows.length - totalRowCount} row{rows.length - totalRowCount === 1 ? "" : "s"}
        </Btn>
        <Btn T={T} variant="ghost" size="md" onClick={onDiscard}>
          Discard
        </Btn>
      </div>
    </PixelPanel>
  );
}
