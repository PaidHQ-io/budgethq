import { useCallback, useEffect, useRef, useState } from "react";
import { Btn, Icon, PixelPanel, SectionLabel, Pill, TagAutocompleteInput } from "./shared.jsx";
import { extractReportingRowsFromImage } from "../lib/reportingAI.js";
import { listReportingFacts, upsertReportingFacts, getDimensionValues } from "../lib/reportingApi.js";
import { PERIOD_TYPES, PERIOD_TYPE_LABELS, normalizePeriodStart, labelForPeriod, defaultPeriodStart } from "../lib/reportingPeriods.js";

// Reporting Analyzer tab (2026-07-30, per Mo — folding ReportingHQ's Dreamdata/PowerBI funnel
// performance reporting into PaidHQ as a tab instead of running it as a separate product).
// Ported from ReportingHQ's DataSources.jsx, with one deliberate omission: that file also rendered
// a ConnectionsPanel for LinkedIn/Bing/Google Ads/Meta/Capterra/Funnel.io/Supermetrics — redundant
// here, since PaidHQ's own Data Sources tab already has the full connector grid natively. This
// tab is entirely about core.reporting_facts: importing Dreamdata/PowerBI screenshots and browsing
// what's already been imported — same relationship to this data that Campaign Tagger has to
// spend_rows (one tab, both the import/tag mechanism and the resulting table).
//
// T is accepted as a prop (not hardcoded locally, unlike the ReportingHQ original) to match every
// other PaidHQ tab's convention — PaidHQ.jsx computes THEME once and threads it down.

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// A handful of headline metrics shown in the review/history tables — the full metrics object
// (every field the extraction captured) still gets stored, this is just what's worth a column at
// a glance. Matches the metric names reportingAI.js's tool schema uses.
const SUMMARY_METRICS = [
  { key: "spend", label: "Spend", money: true },
  { key: "mqls", label: "MQL" },
  { key: "sqls", label: "SQL" },
  { key: "sql_pipeline", label: "SQL Pipeline", money: true },
];

function fmtMetric(v, money) {
  if (v === undefined || v === null || v === "") return "—";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return money ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : n.toLocaleString();
}

// "campaignName" is reporting_facts' one fixed identity field (a raw ad-platform-style label);
// every other field is one of this workspace's CURRENT tag dimension names (Product, Region,
// Funnel, Pillar, Branded Search, Module, Brand, or whatever Campaign Tagger has today — see
// dimension-values.js). Both the review table, the batch-tag bar, and the history table are built
// by iterating this same field list so a workspace's dimensions never have to be hardcoded here.
const CAMPAIGN_FIELD = "campaignName";
const fieldsFor = (tagDims) => [CAMPAIGN_FIELD, ...tagDims];
const fieldLabel = (f) => (f === CAMPAIGN_FIELD ? "Campaign" : f);
const getField = (row, f) => (f === CAMPAIGN_FIELD ? row.campaignName || "" : row.tags?.[f] || "");
const setField = (row, f, v) =>
  f === CAMPAIGN_FIELD ? { ...row, campaignName: v } : { ...row, tags: { ...(row.tags || {}), [f]: v } };
const fieldSuggestions = (dimensionValues, f) =>
  f === CAMPAIGN_FIELD ? dimensionValues?.campaignName || [] : dimensionValues?.values?.[f] || [];

// One extracted row, editable before import. Rows with periodType "unknown" (no date/period
// visible in the source image) get an inline period-assignment control instead of a plain label —
// some exports (e.g. a flat campaign breakdown reflecting whatever the dashboard's date filter
// happened to be) carry no period info at all, so whoever imports has to say what period this
// batch represents.
function ReviewRow({ T, row, onChange, onRemove, dimensionValues, fields }) {
  const isUnknown = !row.periodType || row.periodType === "unknown";
  return (
    <tr style={{ borderBottom: `1px solid ${T.border}` }}>
      <td style={{ padding: "8px 10px", minWidth: 170 }}>
        {isUnknown ? (
          <div style={{ display: "flex", gap: 6 }}>
            <select
              value={row.periodType && row.periodType !== "unknown" ? row.periodType : "month"}
              onChange={(e) => {
                const periodType = e.target.value;
                onChange({ ...row, periodType, periodStart: defaultPeriodStart(periodType) });
              }}
              style={{ fontSize:12*(T.fsScale||1), border: `1px solid ${T.border}`, borderRadius:T.r6, padding: "4px 6px", fontFamily: "'DM Sans',sans-serif" }}
            >
              {PERIOD_TYPES.map((pt) => (
                <option key={pt} value={pt}>{PERIOD_TYPE_LABELS[pt]}</option>
              ))}
            </select>
            <input
              type="date"
              value={row.periodStart || defaultPeriodStart(row.periodType || "month")}
              onChange={(e) => onChange({ ...row, periodStart: normalizePeriodStart(row.periodType || "month", e.target.value) })}
              style={{ fontSize:12*(T.fsScale||1), border: `1px solid ${T.border}`, borderRadius:T.r6, padding: "4px 6px", fontFamily: "'DM Sans',sans-serif" }}
            />
          </div>
        ) : (
          <span style={{ fontSize:12*(T.fsScale||1), color: T.text, fontWeight: 600 }}>
            {labelForPeriod(row.periodType, row.periodStart)}
          </span>
        )}
        {isUnknown && (
          <div style={{ fontSize:10*(T.fsScale||1), color: T.warning, marginTop: 3 }}>No period detected — set one above</div>
        )}
      </td>
      {fields.map((f) => (
        <td key={f} style={{ padding: "8px 10px", minWidth: 130 }}>
          <TagAutocompleteInput
            T={T}
            value={getField(row, f)}
            onChange={(v) => onChange(setField(row, f, v))}
            suggestions={fieldSuggestions(dimensionValues, f)}
            placeholder="—"
            inputStyle={{ fontSize:12*(T.fsScale||1), border: `1px solid ${T.border}`, borderRadius:T.r6, padding: "4px 6px", width: "100%", fontFamily: "'DM Sans',sans-serif" }}
          />
        </td>
      ))}
      {SUMMARY_METRICS.map((m) => (
        <td key={m.key} style={{ padding: "8px 10px", fontSize:12*(T.fsScale||1), color: T.text, textAlign: "right", fontFamily: "'DM Sans',sans-serif" }}>
          {fmtMetric(row.metrics?.[m.key], m.money)}
        </td>
      ))}
      <td style={{ padding: "8px 6px", textAlign: "center" }}>
        <span onClick={onRemove} style={{ cursor: "pointer", color: T.textMuted }} title="Remove this row">
          <Icon name="trash" size={14} />
        </span>
      </td>
    </tr>
  );
}

export default function ReportingAnalyzer({ T, session, workspace }) {
  const [pendingRows, setPendingRows] = useState([]); // extracted, not yet imported
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const [history, setHistory] = useState(null); // null = loading
  const [historyError, setHistoryError] = useState("");

  // This workspace's current tag dimension names (same list Campaign Tagger shows — e.g. Product,
  // Region, Funnel, Pillar, Branded Search, Module, Brand) plus known values for each and known
  // Campaign values — see getDimensionValues. Feeds the autocomplete suggestions AND the extraction
  // prompt (reportingAI.js) so tagging stays the exact same tag dimensions as Campaign Tagger,
  // instead of a separate hardcoded vocabulary.
  const [dimensionValues, setDimensionValues] = useState({ tagDims: [], values: {}, campaignName: [] });
  const fields = fieldsFor(dimensionValues.tagDims || []);
  // One free-text value per field for the "apply to all pending rows" bar below the review table —
  // a whole screenshot/CSV import is usually all one Product/Region etc. even when the AI couldn't
  // detect it per row (e.g. a flat monthly-totals table with no breakdown at all). Keyed by field
  // name directly (campaignName, or a tag dimension name like "Product").
  const [batchTags, setBatchTags] = useState({});

  // Ref to the hidden file input, so the visible "Upload screenshot" button can trigger it directly.
  const fileInputRef = useRef(null);

  const refreshHistory = useCallback(() => {
    listReportingFacts(session, workspace.id)
      .then((rows) => {
        setHistory(rows.slice().sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1)));
        setHistoryError("");
      })
      .catch((err) => setHistoryError(err.message || "Couldn't load imported data."));
  }, [session, workspace.id]);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    getDimensionValues(session, workspace.id)
      .then(setDimensionValues)
      .catch(() => {
        /* non-critical — review table just falls back to a Campaign-only field with no suggestions */
      });
  }, [session, workspace.id]);

  // Fills in a field for every pending row that doesn't already have a value for it — never
  // clobbers a value the AI actually read off the image (e.g. a per-campaign breakdown table),
  // only backfills rows that came back blank.
  const applyBatchTag = (f) => {
    const v = (batchTags[f] || "").trim();
    if (!v) return;
    setPendingRows((prev) => prev.map((r) => (getField(r, f) ? r : setField(r, f, v))));
  };

  // Same backfill logic as applyBatchTag, but computed synchronously against a given rows array
  // instead of going through setState — used right before import so a value typed into the batch
  // bar isn't silently lost if "Apply" (or Enter) was never clicked.
  const mergeBatchTags = (rows) =>
    rows.map((r) => {
      let next = r;
      fields.forEach((f) => {
        const v = (batchTags[f] || "").trim();
        if (v && !getField(next, f)) next = setField(next, f, v);
      });
      return next;
    });

  const handleImage = useCallback(
    async (dataUrl) => {
      setExtracting(true);
      setExtractError("");
      try {
        const rows = await extractReportingRowsFromImage({
          dataUrl,
          token: session?.access_token,
          tagDims: dimensionValues.tagDims || [],
        });
        const normalized = rows.map((r) => ({
          source: "dreamdata_screenshot",
          periodType: r.period_type || "unknown",
          periodStart:
            r.period_type && r.period_type !== "unknown"
              ? normalizePeriodStart(r.period_type, r.period_start) || undefined
              : undefined,
          campaignName: r.campaign_name || "",
          tags: r.tags || {},
          metrics: r.metrics || {},
        }));
        setPendingRows((prev) => [...prev, ...normalized]);
      } catch (err) {
        setExtractError(err.message || "Couldn't read that screenshot.");
      } finally {
        setExtracting(false);
      }
    },
    [session, dimensionValues.tagDims]
  );

  const handleFileInput = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-selecting the same file later
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      handleImage(dataUrl);
    },
    [handleImage]
  );

  const handlePaste = useCallback(
    async (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      handleImage(dataUrl);
    },
    [handleImage]
  );

  const updateRow = (idx, next) => {
    setPendingRows((prev) => prev.map((r, i) => (i === idx ? next : r)));
  };
  const removeRow = (idx) => {
    setPendingRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const hasUnresolved = pendingRows.some((r) => !r.periodType || r.periodType === "unknown" || !r.periodStart);

  const handleImport = async () => {
    if (!pendingRows.length || hasUnresolved) return;
    const rowsToImport = mergeBatchTags(pendingRows);
    setImporting(true);
    setImportResult(null);
    try {
      const result = await upsertReportingFacts(session, workspace.id, rowsToImport);
      setImportResult(result);
      setPendingRows([]);
      refreshHistory();
    } catch (err) {
      setImportResult({ error: err.message || "Import failed." });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div onPaste={handlePaste} style={{ padding: 28, maxWidth: 1100, margin: "0 auto", fontFamily: "'DM Sans',sans-serif", overflow: "auto", height: "100%", boxSizing: "border-box" }}>
      <SectionLabel T={T}>Performance Intelligence</SectionLabel>
      <div style={{ fontSize:16*(T.fsScale||1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Import Dreamdata / PowerBI data</div>
      <div style={{ fontSize:13*(T.fsScale||1), color: T.textSub, lineHeight: 1.6, marginBottom: 20 }}>
        Screenshot a table from your Dreamdata/PowerBI dashboard and drop it below, or paste
        directly (Cmd/Ctrl+V) anywhere on this page. Re-importing a period that's already stored
        overwrites it with the new numbers — nothing is duplicated. Channel spend connections live
        in the Data Sources tab; this is specifically for funnel/pipeline performance data.
      </div>

      <PixelPanel T={T} contentStyle={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileInput} style={{ display: "none" }} />
          <Btn T={T} variant="primary" size="md" onClick={() => fileInputRef.current?.click()}>
            <Icon name="paperclip" size={14} /> Upload screenshot
          </Btn>
          <span style={{ fontSize:12*(T.fsScale||1), color: T.textMuted }}>or paste a screenshot anywhere on this page</span>
          {extracting && (
            <span style={{ fontSize:12*(T.fsScale||1), color: T.accent, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 12, height: 12, border: `2px solid ${T.accentBorder}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} />
              Reading table…
            </span>
          )}
        </div>
        {extractError && (
          <div style={{ marginTop: 12, padding: "9px 12px", background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius:T.r8, fontSize:12*(T.fsScale||1), color: T.danger }}>
            {extractError}
          </div>
        )}
      </PixelPanel>

      {pendingRows.length > 0 && (
        <PixelPanel T={T} contentStyle={{ padding: 20, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize:13*(T.fsScale||1), fontWeight: 700, color: T.text }}>
              {pendingRows.length} row{pendingRows.length === 1 ? "" : "s"} ready to review
            </div>
            {hasUnresolved && <Pill color={T.warning} bg={T.warningBg} border={T.warningBorder}>Assign a period below to continue</Pill>}
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap", marginBottom: 14, padding: "10px 12px", background: T.surfaceEl, border: `1px solid ${T.border}`, borderRadius:T.r8 }}>
            <span style={{ fontSize:11*(T.fsScale||1), color: T.textMuted, marginRight: 2 }}>Tag all rows missing:</span>
            {fields.map((f) => (
              <div key={f} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <TagAutocompleteInput
                  T={T}
                  value={batchTags[f] || ""}
                  onChange={(v) => setBatchTags((prev) => ({ ...prev, [f]: v }))}
                  onEnter={() => applyBatchTag(f)}
                  suggestions={fieldSuggestions(dimensionValues, f)}
                  placeholder={fieldLabel(f)}
                  inputStyle={{ fontSize:12*(T.fsScale||1), border: `1px solid ${T.border}`, borderRadius:T.r6, padding: "5px 8px", width: 130, fontFamily: "'DM Sans',sans-serif" }}
                />
                <Btn T={T} variant="ghost" size="sm" disabled={!batchTags[f]?.trim()} onClick={() => applyBatchTag(f)}>
                  Apply
                </Btn>
              </div>
            ))}
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Period", ...fields.map(fieldLabel), ...SUMMARY_METRICS.map((m) => m.label), ""].map((h, i) => (
                    <th key={i} style={{ padding: "6px 10px", fontSize:10*(T.fsScale||1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: i >= 1 + fields.length && i < 1 + fields.length + SUMMARY_METRICS.length ? "right" : "left" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pendingRows.map((row, idx) => (
                  <ReviewRow key={idx} T={T} row={row} onChange={(next) => updateRow(idx, next)} onRemove={() => removeRow(idx)} dimensionValues={dimensionValues} fields={fields} />
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
            <Btn T={T} variant="primary" size="md" disabled={importing || hasUnresolved} onClick={handleImport}>
              {importing ? "Importing…" : `Import ${pendingRows.length} row${pendingRows.length === 1 ? "" : "s"}`}
            </Btn>
            <Btn T={T} variant="ghost" size="md" onClick={() => setPendingRows([])}>
              Discard
            </Btn>
          </div>
        </PixelPanel>
      )}

      {importResult && (
        <div
          style={{
            marginBottom: 20,
            padding: "10px 14px",
            borderRadius:T.r8,
            fontSize:12*(T.fsScale||1),
            background: importResult.error ? T.dangerBg : T.successBg,
            border: `1px solid ${importResult.error ? T.dangerBorder : T.successBorder}`,
            color: importResult.error ? T.danger : T.success,
          }}
        >
          {importResult.error
            ? importResult.error
            : `Imported ${importResult.upserted} row${importResult.upserted === 1 ? "" : "s"}${importResult.skipped?.length ? ` (${importResult.skipped.length} skipped — missing period)` : ""}.`}
        </div>
      )}

      <SectionLabel T={T}>Stored data</SectionLabel>
      {historyError && (
        <div style={{ padding: "9px 12px", background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius:T.r8, fontSize:12*(T.fsScale||1), color: T.danger, marginBottom: 12 }}>
          {historyError}
        </div>
      )}
      {history === null && !historyError && <div style={{ fontSize:12*(T.fsScale||1), color: T.textMuted }}>Loading…</div>}
      {history && history.length === 0 && (
        <div style={{ fontSize:12*(T.fsScale||1), color: T.textMuted }}>Nothing imported yet for this workspace.</div>
      )}
      {history && history.length > 0 && (
        <PixelPanel T={T} contentStyle={{ padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Period", ...fields.map(fieldLabel), ...SUMMARY_METRICS.map((m) => m.label)].map((h, i) => (
                    <th key={i} style={{ padding: "8px 10px", fontSize:10*(T.fsScale||1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: i >= 1 + fields.length ? "right" : "left" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: "8px 10px", fontSize:12*(T.fsScale||1), color: T.text, fontWeight: 600 }}>{labelForPeriod(row.periodType, row.periodStart)}</td>
                    {fields.map((f) => (
                      <td key={f} style={{ padding: "8px 10px", fontSize:12*(T.fsScale||1), color: T.textSub, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {getField(row, f) || "—"}
                      </td>
                    ))}
                    {SUMMARY_METRICS.map((m) => (
                      <td key={m.key} style={{ padding: "8px 10px", fontSize:12*(T.fsScale||1), color: T.text, textAlign: "right" }}>
                        {fmtMetric(row.metrics?.[m.key], m.money)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PixelPanel>
      )}
    </div>
  );
}
