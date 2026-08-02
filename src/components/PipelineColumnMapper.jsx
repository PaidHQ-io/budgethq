import { useMemo, useState } from "react";
import { Btn, PixelPanel, Sel } from "./shared.jsx";
import {
  guessColumnMapping,
  findDuplicateMappingTargets,
  buildNormalizedPipelineRows,
  detectImportPeriod,
  PIPELINE_METRIC_MAP_OPTIONS,
  PIPELINE_STRUCTURAL_FIELD_OPTIONS,
} from "../lib/pipelineColumnMapping.js";
import { normalizePeriodStart, labelForPeriod } from "../lib/reportingPeriods.js";

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

function targetLabel(target) {
  if (!target || target === "ignore") return "Ignore";
  const structural = PIPELINE_STRUCTURAL_FIELD_OPTIONS.find((f) => f.value === target);
  if (structural) return structural.label;
  if (target.startsWith("tag::")) return target.slice(5);
  if (target.startsWith("metric::")) {
    const key = target.slice(8);
    return PIPELINE_METRIC_MAP_OPTIONS.find((m) => m.key === key)?.label || key;
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

export default function PipelineColumnMapper({ T, headers, rows, tagDims, sourceLabel, onConfirm, onDiscard }) {
  // Lazy init so re-renders (e.g. from the parent's other state changing) don't re-run the guess and
  // clobber anything the user already overrode.
  const [mapping, setMapping] = useState(() =>
    Object.fromEntries(guessColumnMapping(headers, tagDims).map((t, i) => [i, t]))
  );

  const setColumnTarget = (i, target) => setMapping((prev) => ({ ...prev, [i]: target }));

  const dupeTargets = useMemo(() => findDuplicateMappingTargets(mapping), [mapping]);
  const mappedCount = useMemo(() => Object.values(mapping).filter((t) => t && t !== "ignore").length, [mapping]);

  // PERIOD: detected once per file (headers/rows never change under this component), then the user
  // can either accept it or switch to picking one manually — see detectImportPeriod's doc comment
  // for exactly what "detected" means (every row's period column collapsing to the same single
  // month or quarter). `periodMode` "detected" is only ever the initial value when detection
  // actually succeeded; once the user switches away from it there's no way back except re-uploading,
  // which is fine since overriding a real detection should be rare.
  const detected = useMemo(() => detectImportPeriod(headers, rows), [headers, rows]);
  const [periodMode, setPeriodMode] = useState(() => (detected ? "detected" : "month"));
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1); // 1-4

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

  const canConfirm = dupeTargets.length === 0 && Boolean(resolvedPeriod?.periodStart);

  const handleConfirm = () => {
    if (!canConfirm) return;
    const normalized = buildNormalizedPipelineRows({ headers, rows }, mapping, sourceLabel, resolvedPeriod);
    onConfirm(normalized);
  };

  return (
    <PixelPanel T={T} contentStyle={{ padding: 20, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 4 }}>
            Map your columns — {rows.length} row{rows.length === 1 ? "" : "s"} detected
          </div>
          <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6, maxWidth: 640 }}>
            Every column from your file is listed below with a best guess at what it is — change any of them, or leave a
            column on "Ignore" if it doesn't matter. Cost-per and conversion-rate columns aren't mapping targets here;
            PaidHQ computes those from the absolute numbers you map (Spend, Leads, MQLs, etc.) once these rows are
            tagged. Every row in the file comes in regardless of what's mapped — nothing gets filtered out.
          </div>
        </div>
        {mappedCount === 0 && (
          <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.warning, whiteSpace: "nowrap" }}>No columns mapped yet</span>
        )}
      </div>

      {dupeTargets.length > 0 && (
        <div style={{ marginBottom: 12, padding: "9px 12px", background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.danger }}>
          More than one column is mapped to {dupeTargets.map((t) => `"${targetLabel(t)}"`).join(", ")} — each
          target can only be used once. Change one of them to continue.
        </div>
      )}

      <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: T.r8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              {headers.map((h, i) => (
                <th key={i} style={{ padding: "8px 10px", minWidth: 150, verticalAlign: "top", background: T.surfaceEl }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6, maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h}>
                    {h}
                  </div>
                  <Sel T={T} value={mapping[i] || "ignore"} onChange={(v) => setColumnTarget(i, v)} style={{ fontSize: 12 * (T.fsScale || 1), padding: "4px 6px" }}>
                    <option value="ignore">Ignore</option>
                    {PIPELINE_STRUCTURAL_FIELD_OPTIONS.map((f) => (
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
                      {PIPELINE_METRIC_MAP_OPTIONS.map((m) => (
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

      <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
        <Btn T={T} variant="primary" size="md" disabled={!canConfirm} onClick={handleConfirm}>
          Bring in {rows.length} row{rows.length === 1 ? "" : "s"}
        </Btn>
        <Btn T={T} variant="ghost" size="md" onClick={onDiscard}>
          Discard
        </Btn>
      </div>
    </PixelPanel>
  );
}
