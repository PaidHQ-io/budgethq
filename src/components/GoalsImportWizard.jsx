import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { parseFileToRows } from "../lib/core.js";
import { detectMonthColumn, detectQuarterColumn, GOAL_METRIC_MAP_OPTIONS } from "../lib/pipelineColumnMapping.js";
import { labelForPeriod } from "../lib/reportingPeriods.js";
import { upsertReportingFacts } from "../lib/reportingApi.js";
import { SectionLabel, Btn, Sel, Icon, PixelPanel } from "./shared.jsx";
import { isTotalLabel, processRowsPositional, detectFormat, groupLabelsForColumns, buildGoalsPreview } from "../lib/goalsImport.js";

// GoalsImportWizard (2026-08-19, REBUILT from scratch per Mo — "no this is not working at all.
// there's no need to choose the channel or the month. I want you to complete start fresh and
// duplicate the process of importing a budget file. Take the same popup and UX and just change it
// slightly for goals.") This is a direct port of BudgetManager.jsx's own Import modal (importOpen/
// iStep upload->header->map->preview, click-a-row-to-set-it-as-header, "skip rows containing" text
// filter, forwardFillGroups-based group-header-row) — same modal chrome, same step names, same
// interaction model — NOT the earlier PipelineColumnMapper-based approach (which forced a global
// Channel section and a fallback Month/Quarter picker even when the file's own headers already said
// so; both are gone here entirely). Whatever a file's own header row / period column says IS the
// period — there is no separate "pick a channel" step at all, since goals data has no channel
// concept, and no forced month/quarter picker outside of the Year used to pair with a bare month or
// quarter label that has no year of its own (see gYear below).
//
// WHY A SEPARATE COMPONENT rather than reusing BudgetManager itself: Budget's whole data model is
// "one segment x one $ amount x 12 months" (a single budgets[year][segKey].monthly grid) — goals
// need MULTIPLE named metrics per segment/period (MQL Goal, Pipeline Goal, SQL Goal, ...) at once, so
// the "map" step's wide-format extra is genuinely different (a metric-group-row picker mapping group
// labels to GOAL_METRIC_MAP_OPTIONS keys, instead of Budget's Channel/group-row mapping to a plain tag
// dimension) and the output writes normalized rows into core.reporting_facts via upsertReportingFacts
// instead of the local budgets/budgetRowMeta state. Screenshot import and Google Sheets connect
// (Budget has both) are deliberately NOT ported here — out of scope for this pass; a goals file is a
// CSV/XLSX upload only for now.
//
// DUPLICATE HEADER TEXT (why rows are processed by COLUMN INDEX, not header text, unlike Budget's own
// processRows which keys row objects by header string): Mo's real goals file has the SAME header text
// twice — "January".."December" once for an MQL-goal block of columns and again for a Pipeline-goal
// block. Budget never hits this (one metric per import), but keying by header text here would let the
// second block's columns silently overwrite the first's in every row object. Every column reference in
// this component is therefore a column INDEX, and gHeaders may legitimately contain duplicate strings.
const IMPORT_STEPS = ["upload", "header", "map", "preview"];

function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString() : String(n ?? "");
}

// promptAndArchiveFile defaults to a no-op passthrough — same reasoning as BudgetManager's own
// identical default (this component still works if mounted without a real one wired in).
export default function GoalsImportWizard({
  T, session, workspace, tagDims, canEdit = true, sidebarEl,
  initialImportFile, onConsumeInitialImportFile, onImported,
  promptAndArchiveFile = async (file) => ({ name: file?.name, fileId: null }),
}) {
  const yr = new Date().getFullYear();
  const [importOpen, setImportOpen] = useState(false);
  const [gStep, setGStep] = useState("upload");
  const [gYear, setGYear] = useState(yr.toString());
  const [gFileName, setGFileName] = useState("");
  const [gRawRows, setGRawRows] = useState([]); // array of arrays, every row of the file untouched
  const [gHeaderRow, setGHeaderRow] = useState(0);
  const [gSkipStr, setGSkipStr] = useState("total");
  const [gHeaders, setGHeaders] = useState([]); // array of strings, index-aligned — may contain duplicates
  const [gDataRows, setGDataRows] = useState([]); // array of arrays, index-aligned to gHeaders
  const [gFmt, setGFmt] = useState("wide"); // "wide" (month/quarter columns) | "long" (period column + metric columns)
  const [dimMap, setDimMap] = useState({}); // {tagDimName: "colIndex"}
  const [customDims, setCustomDims] = useState([]); // [{name, col:"colIndex"}]
  // WIDE format only
  const [groupHeaderRow, setGroupHeaderRow] = useState(-1); // -1 = none, otherwise a row index above gHeaderRow
  const [groupMetricMap, setGroupMetricMap] = useState({}); // {groupLabel: metricKey}
  const [singleMetric, setSingleMetric] = useState(""); // used when no group header row is set
  // LONG format only
  const [periodColIdx, setPeriodColIdx] = useState("");
  const [metricColMap, setMetricColMap] = useState({}); // {metricKey: "colIndex"}
  const [preview, setPreview] = useState([]); // normalized reporting_facts-shaped rows
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const fileRef = useRef();
  const years = [(yr - 1).toString(), yr.toString(), (yr + 1).toString()];

  const closeImport = () => {
    setImportOpen(false);
    setGStep("upload");
    setGRawRows([]); setGHeaders([]); setGDataRows([]);
    setDimMap({}); setCustomDims([]);
    setGroupHeaderRow(-1); setGroupMetricMap({}); setSingleMetric("");
    setPeriodColIdx(""); setMetricColMap({});
    setPreview([]); setImportError("");
  };

  // Same auto-detect as BudgetManager's ingestRawRows (first row with >2 filled cells, preferring one
  // with recognizable period headers if any candidate has them) — just checks for a month OR quarter
  // header instead of Budget's isMonthHdr alone, since a goals file might be quarter-columned only.
  const ingestRawRows = (fileName, rawRows) => {
    setGFileName(fileName);
    setGRawRows(rawRows);
    let headerIdx = 0;
    const candidates = [];
    for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
      const filled = (rawRows[i] || []).filter((v) => String(v ?? "").trim()).length;
      if (filled > 2) candidates.push(i);
    }
    if (candidates.length) {
      const withPeriods = candidates.find((i) => (rawRows[i] || []).filter((v) => detectMonthColumn(String(v ?? "")) || detectQuarterColumn(String(v ?? ""))).length >= 2);
      headerIdx = withPeriods !== undefined ? withPeriods : candidates[0];
    }
    setGHeaderRow(headerIdx);
    setGStep("header");
  };

  const handleImportFile = (file) => {
    if (!file) return;
    parseFileToRows(file, (rawRows) => ingestRawRows(file.name, rawRows));
  };

  // Handoff from the unified Data Sources uploader / File Store "Apply" — same justified
  // set-state-in-effect exception as BudgetManager's identical initialImportFile effect (external
  // handoff reacting to a prop change on an already-mounted component, not prop-into-state sync).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!initialImportFile) return;
    setImportOpen(true);
    parseFileToRows(initialImportFile, (rawRows) => ingestRawRows(initialImportFile.name, rawRows));
    onConsumeInitialImportFile?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImportFile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Position-indexed row processing / format detection / preview building all live in
  // ../lib/goalsImport.js as plain functions (see this file's top doc comment for why — duplicate
  // header text across two metric blocks must NOT collide the way Budget's header-text-keyed row
  // objects would — and so this logic can be sanity-tested directly outside React).
  const applyHeaderRow = () => {
    const { headers, rows } = processRowsPositional(gRawRows, gHeaderRow, gSkipStr);
    setGHeaders(headers);
    setGDataRows(rows);
    const fmt = detectFormat(headers);
    setGFmt(fmt);
    const am = {};
    (tagDims || []).forEach((d) => {
      const idx = headers.findIndex((h) => h.toLowerCase() === d.toLowerCase() || h.toLowerCase().includes(d.toLowerCase()));
      if (idx !== -1) am[d] = String(idx);
    });
    setDimMap(am);
    if (fmt === "long") {
      const pIdx = headers.findIndex((h) => /month|period|date|quarter/i.test(h));
      setPeriodColIdx(pIdx !== -1 ? String(pIdx) : "");
    }
    setGStep("map");
  };

  const groupLabelsDistinct = useMemo(
    () => groupLabelsForColumns(gHeaders, groupHeaderRow >= 0 ? gRawRows[groupHeaderRow] : null),
    [groupHeaderRow, gRawRows, gHeaders]
  );

  const activeDims = useMemo(() => [
    ...(tagDims || []).filter((d) => dimMap[d] !== undefined && dimMap[d] !== "").map((d) => ({ dim: d, col: Number(dimMap[d]) })),
    ...customDims.filter((c) => c.name && c.col !== "" && c.col !== undefined).map((c) => ({ dim: c.name, col: Number(c.col) })),
  ], [tagDims, dimMap, customDims]);

  const canMap = activeDims.length > 0 && (
    gFmt === "wide"
      ? (groupHeaderRow >= 0 ? Object.values(groupMetricMap).some(Boolean) : Boolean(singleMetric))
      : (periodColIdx !== "" && Object.values(metricColMap).some((v) => v !== "" && v !== undefined))
  );

  const goPreview = () => {
    setPreview(buildGoalsPreview({
      gFmt, headers: gHeaders, dataRows: gDataRows, rawRows: gRawRows,
      groupHeaderRow, groupMetricMap, singleMetric, activeDims,
      periodColIdx, metricColMap, year: gYear,
    }));
    setGStep("preview");
  };

  const beginImport = async () => {
    if (!canEdit || !preview.length) return;
    setImporting(true); setImportError("");
    try {
      const result = await upsertReportingFacts(session, workspace.id, preview);
      onImported?.(result);
      closeImport();
    } catch (err) {
      setImportError(err.message || "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const metricKeysInPreview = useMemo(() => {
    const s = new Set();
    preview.forEach((r) => Object.keys(r.metrics).forEach((k) => s.add(k)));
    return [...s];
  }, [preview]);
  const dimNamesInPreview = useMemo(() => {
    const s = new Set();
    preview.forEach((r) => Object.keys(r.tags).forEach((k) => s.add(k)));
    return [...s];
  }, [preview]);
  const segCount = useMemo(() => new Set(preview.map((r) => r.campaignName)).size, [preview]);
  const totalRowsSkipped = useMemo(() => gDataRows.filter((row) => activeDims.map((d) => String(row[d.col] ?? "").trim()).some((v) => isTotalLabel(v))).length, [gDataRows, activeDims]);

  const selStyle = { background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font, width: "100%" };

  return (
    <>
      {sidebarEl && createPortal(
        <Btn onClick={() => setImportOpen(true)} disabled={!canEdit} title={canEdit ? undefined : "View-only access"} variant="success" size="sm" T={T} style={{ width: "100%", justifyContent: "center", fontFamily: T.font }}>
          ↑ Import CSV / Excel
        </Btn>,
        sidebarEl
      )}

      {importOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <PixelPanel T={T} style={{ width: "100%", maxWidth: 680, maxHeight: "90vh" }} contentStyle={{ background: T.surface, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>

            {/* Modal header */}
            <div style={{ padding: "16px 22px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 15 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>Import Goals File</div>
                <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, marginTop: 2 }}>
                  {gStep === "upload" && "CSV or Excel · any layout"}
                  {gStep === "header" && `${gFileName} · Click the row that contains your column headers`}
                  {gStep === "map" && "Map columns to your dimensions and goal metrics"}
                  {gStep === "preview" && `${preview.length} entries ready to import`}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                {["Upload", "Headers", "Map", "Preview"].map((label, i) => {
                  const sk = IMPORT_STEPS[i]; const idx = IMPORT_STEPS.indexOf(gStep);
                  return <div key={sk} style={{ display: "flex", alignItems: "center", gap: 5 }}>{i > 0 && <span style={{ color: T.textDim, fontSize: 11 * (T.fsScale || 1) }}>›</span>}<span style={{ fontSize: 12 * (T.fsScale || 1), color: gStep === sk ? T.accent : idx > i ? T.success : T.textMuted, fontWeight: gStep === sk ? 600 : 400 }}>{idx > i ? "✓ " : ""}{label}</span></div>;
                })}
                <button onClick={closeImport} style={{ background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 22 * (T.fsScale || 1), lineHeight: 1, marginLeft: 6, fontFamily: T.font }}>×</button>
              </div>
            </div>

            {/* Modal body */}
            <div style={{ flex: 1, overflow: "auto", padding: 22 }}>

              {/* STEP 1: Upload + Year */}
              {gStep === "upload" && (
                <div>
                  <div style={{ marginBottom: 22 }}>
                    <div style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 600, color: T.text, marginBottom: 4 }}>Which year do these goals apply to?</div>
                    <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, marginBottom: 10 }}>Only used to pair a bare month/quarter (e.g. "January", "Q1") that has no year of its own — a column or value that already states its own year/date always wins.</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {years.map((y) => <button key={y} onClick={() => setGYear(y)} style={{ flex: 1, padding: "10px 0", borderRadius: T.r8, border: `1.5px solid ${gYear === y ? T.accent : T.border}`, background: gYear === y ? T.accentBg : "transparent", color: gYear === y ? T.accent : T.textSub, cursor: "pointer", fontSize: 15 * (T.fsScale || 1), fontWeight: gYear === y ? 700 : 400, fontFamily: T.font }}>{y}</button>)}
                    </div>
                  </div>
                  <div onClick={() => fileRef.current?.click()} style={{ border: `1.5px dashed ${T.borderStrong}`, borderRadius: T.r10, padding: "36px 20px", textAlign: "center", cursor: "pointer", background: T.surfaceEl }}>
                    <div style={{ marginBottom: 10, display: "flex", justifyContent: "center" }}><Icon name="export" size={30} color={T.textSub} /></div>
                    <div style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 600, color: T.text, marginBottom: 4 }}>Drop your goals file here or click to browse</div>
                    <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted }}>Supports <strong style={{ color: T.textSub }}>.xlsx</strong> and <strong style={{ color: T.textSub }}>.csv</strong> · any row/column layout</div>
                    <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: "none" }} onChange={(e) => {
                      const f = e.target.files[0]; e.target.value = "";
                      if (!f) return;
                      promptAndArchiveFile(f, "Goals import").then((named) => { if (named) handleImportFile(f); });
                    }} />
                  </div>
                  <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {[{ label: "Wide format", example: "Product | Jan | Feb | Mar..." }, { label: "Long format", example: "Product | Month | MQL Goal" }].map((f) => (
                      <div key={f.label} style={{ padding: "10px 12px", background: T.surfaceEl, border: `1px solid ${T.border}`, borderRadius: T.r8 }}>
                        <div style={{ fontSize: 12 * (T.fsScale || 1), fontWeight: 600, color: T.text, marginBottom: 3 }}>{f.label}</div>
                        <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>{f.example}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* STEP 2: Header row picker */}
              {gStep === "header" && (
                <div>
                  <div style={{ padding: "10px 12px", background: T.accentBg, border: `1px solid ${T.accentBorder}`, borderRadius: T.r8, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.accent, fontWeight: 500 }}>Year: <strong>{gYear}</strong> · Click a row to set it as the header</span>
                    <div style={{ display: "flex", gap: 4 }}>{years.map((y) => <button key={y} onClick={() => setGYear(y)} style={{ padding: "2px 8px", borderRadius: T.r4, border: `1px solid ${gYear === y ? T.accent : T.border}`, background: gYear === y ? T.accentBg : "transparent", color: gYear === y ? T.accent : T.textMuted, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font }}>{y}</button>)}</div>
                  </div>

                  <div style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub }}>
                      Header row: <strong style={{ color: T.text }}>Row {gHeaderRow + 1}</strong>
                      <span style={{ color: T.textMuted, marginLeft: 8 }}>({gRawRows[gHeaderRow]?.filter((v) => String(v ?? "").trim()).length || 0} columns detected)</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                      <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub }}>Skip rows containing:</span>
                      <input value={gSkipStr} onChange={(e) => setGSkipStr(e.target.value)} placeholder="e.g. total" style={{ ...selStyle, width: 120 }} />
                    </div>
                  </div>

                  <div style={{ border: `1px solid ${T.border}`, borderRadius: T.r8, overflow: "auto", maxHeight: 320 }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 * (T.fsScale || 1) }}>
                      <tbody>
                        {gRawRows.slice(0, Math.min(gRawRows.length, 15)).map((row, ri) => {
                          const isHeader = ri === gHeaderRow;
                          const isEmpty = row.every((v) => !String(v ?? "").trim());
                          const isSkip = gSkipStr && row.join(" ").toLowerCase().includes(gSkipStr.toLowerCase());
                          return (
                            <tr key={ri} onClick={() => setGHeaderRow(ri)}
                              style={{ cursor: "pointer", background: isHeader ? T.accentBg : isSkip ? T.dangerBg : isEmpty ? T.surfaceEl : "transparent", borderBottom: `1px solid ${T.border}`, transition: "background 0.1s" }}>
                              <td style={{ padding: "6px 8px", width: 32, textAlign: "center", borderRight: `1px solid ${T.border}`, color: isHeader ? T.accent : T.textMuted, fontSize: 10 * (T.fsScale || 1), fontWeight: isHeader ? 700 : 400 }}>
                                {isHeader ? "→" : ri + 1}
                              </td>
                              {row.slice(0, 8).map((cell, ci) => (
                                <td key={ci} style={{ padding: "6px 10px", color: isHeader ? T.accent : isSkip ? T.danger : isEmpty ? T.textDim : T.text, fontWeight: isHeader ? 600 : 400, fontSize: 11, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {cell || ""}
                                </td>
                              ))}
                              {row.length > 8 && <td style={{ padding: "6px 8px", color: T.textMuted, fontSize: 10 * (T.fsScale || 1) }}>+{row.length - 8} more</td>}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>
                    <span style={{ color: T.accent, fontWeight: 600 }}>→ highlighted row</span> = header &nbsp;·&nbsp;
                    <span style={{ color: T.danger }}>red rows</span> = will be skipped &nbsp;·&nbsp;
                    <span style={{ color: T.textDim }}>dim rows</span> = empty
                  </div>
                </div>
              )}

              {/* STEP 3: Map columns */}
              {gStep === "map" && (
                <div>
                  <div style={{ padding: "9px 12px", background: T.accentBg, border: `1px solid ${T.accentBorder}`, borderRadius: T.r8, marginBottom: 16 }}>
                    <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.accent, fontWeight: 500 }}>
                      Year: <strong>{gYear}</strong> · {gFmt === "wide" ? "Wide (months/quarters as columns)" : "Long (a period column + metric columns)"} · {gDataRows.length} data rows · {gHeaders.length} columns
                    </span>
                  </div>

                  {gFmt === "wide" && (
                    <div style={{ marginBottom: 20 }}>
                      <SectionLabel T={T} style={{ marginBottom: 8 }}>Wide format detected</SectionLabel>
                      <div style={{ padding: "12px 14px", background: T.surfaceEl, border: `1px solid ${T.border}`, borderRadius: T.r8, marginBottom: 14, fontSize: 12 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6 }}>
                        Your file has month or quarter columns. If it reports just <strong style={{ color: T.text }}>one</strong> goal metric, pick which metric below. If it reports <strong style={{ color: T.text }}>several</strong> (e.g. separate blocks of month columns for an MQL Goal and a Pipeline Goal), turn on the group row and tell us which metric each block is.
                      </div>

                      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                          <div>
                            <div style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 500, color: T.text }}>This file reports multiple metrics</div>
                            <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>Optional — use a row above the header that groups month/quarter columns into metrics</div>
                          </div>
                          <button onClick={() => setGroupHeaderRow((p) => (p >= 0 ? -1 : Math.max(0, gHeaderRow - 1)))} style={{ width: 30, height: 17, borderRadius: T.r9, background: groupHeaderRow >= 0 ? T.accent : T.borderStrong, position: "relative", cursor: "pointer", border: "none", flexShrink: 0 }}>
                            <span style={{ position: "absolute", top: 2, left: groupHeaderRow >= 0 ? 15 : 2, width: 13, height: 13, borderRadius: T.r7, background: "#fff", transition: "left 0.18s", boxShadow: "0 1px 3px rgba(0,0,0,0.25)" }} />
                          </button>
                        </div>
                        {groupHeaderRow >= 0 && (
                          <div>
                            <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, marginBottom: 4 }}>Which row contains the metric group labels?</div>
                            <select value={groupHeaderRow} onChange={(e) => setGroupHeaderRow(parseInt(e.target.value, 10))} style={selStyle}>
                              {gRawRows.slice(0, gHeaderRow).map((_, i) => (
                                <option key={i} value={i}>Row {i + 1}: {(gRawRows[i] || []).filter((v) => String(v ?? "").trim()).slice(0, 3).join(" | ")}</option>
                              ))}
                            </select>
                            {groupLabelsDistinct.length > 0 && (
                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, marginBottom: 6 }}>Which goal metric does each label represent?</div>
                                {groupLabelsDistinct.map((label) => (
                                  <div key={label} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 6, alignItems: "center" }}>
                                    <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.text }}>{label}</span>
                                    <Sel value={groupMetricMap[label] || ""} onChange={(v) => setGroupMetricMap((p) => ({ ...p, [label]: v }))} T={T}>
                                      <option value="">— skip —</option>
                                      {GOAL_METRIC_MAP_OPTIONS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                                    </Sel>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {groupHeaderRow < 0 && (
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "center" }}>
                            <span style={{ fontSize: 13 * (T.fsScale || 1), color: T.text, fontWeight: 500 }}>Which goal metric?</span>
                            <Sel value={singleMetric} onChange={setSingleMetric} T={T}>
                              <option value="">— select —</option>
                              {GOAL_METRIC_MAP_OPTIONS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                            </Sel>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div>
                    <SectionLabel T={T} style={{ marginBottom: 10 }}>Map columns to your dimensions</SectionLabel>
                    <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, marginBottom: 10 }}>Product, Region, Module, Brand, BU, or whatever your file breaks goals down by.</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                      {(tagDims || []).map((d) => (
                        <div key={d} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "center" }}>
                          <span style={{ fontSize: 13 * (T.fsScale || 1), color: T.text, fontWeight: 500 }}>{d}</span>
                          <Sel value={dimMap[d] ?? ""} onChange={(v) => setDimMap((p) => ({ ...p, [d]: v === "" ? undefined : v }))} T={T}>
                            <option value="">— skip —</option>
                            {gHeaders.map((h, i) => <option key={i} value={i}>{h}</option>)}
                          </Sel>
                        </div>
                      ))}
                    </div>
                    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16, marginTop: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                        <SectionLabel T={T} style={{ marginBottom: 0 }}>Add custom dimensions</SectionLabel>
                        <Btn onClick={() => setCustomDims((p) => [...p, { name: "", col: "" }])} variant="subtle" size="sm" T={T}>+ Add dimension</Btn>
                      </div>
                      {customDims.length === 0 && <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, padding: "8px 0" }}>Map any additional columns to new tag dimensions not yet in your list.</div>}
                      {customDims.map((cd, i) => (
                        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 28px", gap: 8, marginBottom: 8, alignItems: "center" }}>
                          <input value={cd.name} onChange={(e) => setCustomDims((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Dimension name (e.g. Product)" style={selStyle} />
                          <Sel value={cd.col} onChange={(v) => setCustomDims((p) => p.map((x, j) => (j === i ? { ...x, col: v } : x)))} T={T}>
                            <option value="">— select column —</option>
                            {gHeaders.map((h, hi) => <option key={hi} value={hi}>{h}</option>)}
                          </Sel>
                          <button onClick={() => setCustomDims((p) => p.filter((_, j) => j !== i))} style={{ background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 16 * (T.fsScale || 1), lineHeight: 1, padding: 4, fontFamily: T.font }}>×</button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {gFmt === "long" && (
                    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16, marginTop: 16 }}>
                      <SectionLabel T={T} style={{ marginBottom: 10 }}>Period column</SectionLabel>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16, alignItems: "center" }}>
                        <div><div style={{ fontSize: 13 * (T.fsScale || 1), color: T.text, fontWeight: 500 }}>Month / Quarter</div><div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>The column whose value varies per row — e.g. "January", "Q1 2026", "2026-03"</div></div>
                        <Sel value={periodColIdx} onChange={setPeriodColIdx} T={T}>
                          <option value="">— select —</option>
                          {gHeaders.map((h, i) => <option key={i} value={i}>{h}</option>)}
                        </Sel>
                      </div>
                      <SectionLabel T={T} style={{ marginBottom: 10 }}>Map columns to goal metrics</SectionLabel>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {GOAL_METRIC_MAP_OPTIONS.map((m) => (
                          <div key={m.key} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "center" }}>
                            <span style={{ fontSize: 13 * (T.fsScale || 1), color: T.text, fontWeight: 500 }}>{m.label}</span>
                            <Sel value={metricColMap[m.key] ?? ""} onChange={(v) => setMetricColMap((p) => ({ ...p, [m.key]: v === "" ? undefined : v }))} T={T}>
                              <option value="">— skip —</option>
                              {gHeaders.map((h, i) => <option key={i} value={i}>{h}</option>)}
                            </Sel>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* STEP 4: Preview */}
              {gStep === "preview" && (
                <div>
                  {importError && <div style={{ padding: "9px 12px", background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: T.r8, marginBottom: 14, fontSize: 12 * (T.fsScale || 1), color: T.danger }}>{importError}</div>}
                  <div style={{ padding: "9px 12px", background: T.successBg, border: `1px solid ${T.successBorder}`, borderRadius: T.r8, marginBottom: 14, fontSize: 12 * (T.fsScale || 1), color: T.success, fontWeight: 500 }}>
                    ✓ <strong>{preview.length} entries</strong> across <strong>{segCount} segment{segCount === 1 ? "" : "s"}</strong> ready for <strong>{gYear}</strong>
                    {totalRowsSkipped > 0 && ` — ${totalRowsSkipped} Total/Summary row${totalRowsSkipped === 1 ? "" : "s"} skipped automatically`}
                  </div>
                  {preview.length === 0 ? (
                    <div style={{ padding: "12px 14px", background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.warning }}>
                      No entries matched your mapping — go back and check the dimension/metric columns you picked.
                    </div>
                  ) : (
                    <div style={{ border: `1px solid ${T.border}`, borderRadius: T.r8, overflow: "auto", maxHeight: 360 }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 * (T.fsScale || 1) }}>
                        <thead><tr>
                          {dimNamesInPreview.map((d) => <th key={d} style={{ padding: "8px 10px", textAlign: "left", background: T.headerBg, borderBottom: `1px solid ${T.border}`, fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", position: "sticky", top: 0 }}>{d}</th>)}
                          <th style={{ padding: "8px 10px", textAlign: "left", background: T.headerBg, borderBottom: `1px solid ${T.border}`, fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", position: "sticky", top: 0 }}>Period</th>
                          {metricKeysInPreview.map((mk) => <th key={mk} style={{ padding: "8px 10px", textAlign: "right", background: T.headerBg, borderBottom: `1px solid ${T.border}`, fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.accent, textTransform: "uppercase", position: "sticky", top: 0 }}>{GOAL_METRIC_MAP_OPTIONS.find((m) => m.key === mk)?.label || mk}</th>)}
                        </tr></thead>
                        <tbody>
                          {preview.slice(0, 300).map((r, i) => (
                            <tr key={i}>
                              {dimNamesInPreview.map((d) => <td key={d} style={{ padding: "7px 10px", borderBottom: `1px solid ${T.border}`, color: T.text }}>{r.tags[d] || "—"}</td>)}
                              <td style={{ padding: "7px 10px", borderBottom: `1px solid ${T.border}`, color: T.textSub }}>{labelForPeriod(r.periodType, r.periodStart)}</td>
                              {metricKeysInPreview.map((mk) => <td key={mk} style={{ padding: "7px 10px", borderBottom: `1px solid ${T.border}`, textAlign: "right", fontFamily: T.font, color: r.metrics[mk] !== undefined ? T.text : T.textDim }}>{r.metrics[mk] !== undefined ? fmtNum(r.metrics[mk]) : "—"}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {preview.length > 300 && <div style={{ padding: 8, fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>+ {preview.length - 300} more entries not shown here — all of them come in once you confirm.</div>}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div style={{ padding: "14px 22px", borderTop: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", flexShrink: 0 }}>
              <Btn onClick={() => { if (gStep === "header") setGStep("upload"); else if (gStep === "map") setGStep("header"); else if (gStep === "preview") setGStep("map"); else closeImport(); }} variant="ghost" T={T}>{gStep === "upload" ? "Cancel" : "← Back"}</Btn>
              <div style={{ display: "flex", gap: 8 }}>
                {gStep === "header" && <Btn onClick={applyHeaderRow} variant="primary" T={T}>Confirm headers →</Btn>}
                {gStep === "map" && <Btn onClick={goPreview} disabled={!canMap} variant="primary" T={T}>Preview import →</Btn>}
                {gStep === "preview" && <Btn onClick={beginImport} disabled={importing || !preview.length} variant="primary" T={T} style={{ gap: 6 }}>
                  {importing ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} /> Importing…</span> : <span>✓ Import {preview.length} entries into {gYear}</span>}
                </Btn>}
              </div>
            </div>
          </PixelPanel>
        </div>
      )}
    </>
  );
}
