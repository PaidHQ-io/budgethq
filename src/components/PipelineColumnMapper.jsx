import { useMemo, useState } from "react";
import { Btn, PixelPanel, Sel } from "./shared.jsx";
import { guessColumnMapping, findDuplicateMappingTargets, buildNormalizedPipelineRows, PIPELINE_METRIC_MAP_OPTIONS } from "../lib/pipelineColumnMapping.js";

// Column-mapping step for a raw pipeline CSV/XLSX (2026-08-02, per Mo — see
// pipelineColumnMapping.js's top doc comment for the full "why"). Sits between the raw file (every
// row/column read untouched) and ReportingAnalyzer's existing pendingRows review table: every raw
// header shows up here as its own column with a dropdown, defaulted to a best-guess target but fully
// overridable, and a live preview of that column's actual values so a wrong guess is obvious before
// anything is normalized. Confirming builds the normalized rows and hands them to the parent, which
// merges them into the same review/import flow every other source already uses — this component
// itself never calls the import API.
const PREVIEW_ROWS = 6;

function targetLabel(target) {
  if (!target || target === "ignore") return "Ignore";
  if (target === "campaign") return "Campaign Name";
  if (target.startsWith("tag::")) return target.slice(5);
  if (target.startsWith("metric::")) {
    const key = target.slice(8);
    return PIPELINE_METRIC_MAP_OPTIONS.find((m) => m.key === key)?.label || key;
  }
  return target;
}

export default function PipelineColumnMapper({ T, headers, rows, tagDims, sourceLabel, onConfirm, onDiscard }) {
  // Lazy init so re-renders (e.g. from the parent's other state changing) don't re-run the guess and
  // clobber anything the user already overrode.
  const [mapping, setMapping] = useState(() =>
    Object.fromEntries(guessColumnMapping(headers, tagDims).map((t, i) => [i, t]))
  );

  const setColumnTarget = (i, target) => setMapping((prev) => ({ ...prev, [i]: target }));

  const dupeTargets = useMemo(() => findDuplicateMappingTargets(mapping), [mapping]);
  const mappedCount = useMemo(() => Object.values(mapping).filter((t) => t && t !== "ignore").length, [mapping]);

  const handleConfirm = () => {
    if (dupeTargets.length) return;
    const normalized = buildNormalizedPipelineRows({ headers, rows }, mapping, sourceLabel);
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
                    <option value="campaign">Campaign Name</option>
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

      <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
        <Btn T={T} variant="primary" size="md" disabled={dupeTargets.length > 0} onClick={handleConfirm}>
          Bring in {rows.length} row{rows.length === 1 ? "" : "s"}
        </Btn>
        <Btn T={T} variant="ghost" size="md" onClick={onDiscard}>
          Discard
        </Btn>
      </div>
    </PixelPanel>
  );
}
