import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Btn, Icon, PixelPanel, SectionLabel, Pill, TagAutocompleteInput } from "./shared.jsx";
import ReportingFactsTagger from "./ReportingFactsTagger.jsx";
import PipelineColumnMapper from "./PipelineColumnMapper.jsx";
import { extractReportingRowsFromImage } from "../lib/reportingAI.js";
import { upsertReportingFacts, getDimensionValues } from "../lib/reportingApi.js";
import { PERIOD_TYPES, PERIOD_TYPE_LABELS, normalizePeriodStart, labelForPeriod, defaultPeriodStart } from "../lib/reportingPeriods.js";
import { deriveMetricColumns, fmtMetric } from "../lib/reportingMetrics.js";

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

// Headline metrics shown as columns in the pending-rows review table — the full metrics object
// (every field extraction captured) still gets stored either way, this is just what's worth a
// column at a glance while reviewing a fresh extraction before import. Used to be a fixed list
// matching reportingAI.js's old closed metric enum; now that that schema is open (2026-08-02, see
// reportingAI.js's OPEN METRICS SCHEMA doc comment — different clients' exports use entirely
// different column names, e.g. Salesforce/HockeyStack vs. Dreamdata/PowerBI), the columns shown
// here are derived (via reportingMetrics.js's deriveMetricColumns, shared with the Reporting
// Intelligence breakdown view) from whatever keys actually show up in the rows being reviewed, so
// this table adapts to whatever source produced them instead of only ever showing insightsoftware's
// own metric names. excludeRates isn't needed here — this table shows one row's own values as-is,
// never a cross-row sum, so a rate/cost-per column is still meaningful.
const deriveSummaryMetrics = (rows) => deriveMetricColumns(rows, { excludeRates: false });

// "campaignName" is reporting_facts' one fixed identity field (a raw ad-platform-style label);
// every other field is one of this workspace's CURRENT tag dimension names (Product, Region,
// Funnel, Pillar, Branded Search, Module, Brand, or whatever Campaign Tagger has today — see
// dimension-values.js). Both the review table and the batch-tag bar are built by iterating this
// same field list so a workspace's dimensions never have to be hardcoded here.
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
function ReviewRow({ T, row, onChange, onRemove, dimensionValues, fields, summaryMetrics }) {
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
      {summaryMetrics.map((m) => (
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

export default function ReportingAnalyzer({ T, session, workspace, initialPendingRows, onConsumeInitialPendingRows, initialRawPipelineImport, onConsumeInitialRawPipelineImport, campaignTags, tagDims, canEdit, onBackToDataSources }) {
  // initialPendingRows seeds via a lazy initializer rather than an effect + setState — correct
  // here (not just convenient) because PaidHQ.jsx never sets pendingReportingRows and switches to
  // this tab except together (see confirmUnifiedUpload), and this tab is conditionally mounted
  // (unmounts on every tab switch away, unlike BudgetManager's kept-mounted trick) — so this
  // always freshly mounts at the exact moment of handoff, the same reasoning AskAI's
  // initialQuestion uses for its own one-shot relay.
  const [pendingRows, setPendingRows] = useState(() => initialPendingRows || []); // extracted, not yet imported
  // Same one-shot relay pattern, for a raw (un-mapped) pipeline CSV/XLSX handoff instead of already-
  // normalized rows (2026-08-02, per Mo's column-mapping request — see PipelineColumnMapper.jsx and
  // pipelineColumnMapping.js). Rendered as its own step ABOVE the pendingRows review table; confirming
  // it there appends normalized rows into pendingRows above, same as every other import path.
  const [rawPipelineImport, setRawPipelineImport] = useState(() => initialRawPipelineImport || null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  // CSV/XLSX pipeline imports (2026-08-03, per Mo — "all of the data should be imported into the
  // pipeline tagger, just like the campaign tagger") no longer stage into pendingRows for a second
  // manual "Import" click — PipelineColumnMapper's confirm already carries a resolved mapping AND a
  // resolved period (see that component), so there's nothing left to review before writing straight
  // to reporting_facts. The AI-extraction path (screenshots) still uses pendingRows below, since an
  // AI read genuinely benefits from a human glance before it's trusted.
  const [mappingImporting, setMappingImporting] = useState(false);
  // Bumped after a successful import to tell the embedded ReportingFactsTagger below to re-fetch —
  // it owns its own `rows` state (fetched via listReportingFacts internally), so a fresh import up
  // here wouldn't otherwise show up there until something remounts it. See that component's own
  // refreshSignal doc comment.
  const [taggerRefreshSignal, setTaggerRefreshSignal] = useState(0);

  // This workspace's current tag dimension names (same list Campaign Tagger shows — e.g. Product,
  // Region, Funnel, Pillar, Branded Search, Module, Brand) plus known values for each and known
  // Campaign values — see getDimensionValues. Feeds the autocomplete suggestions AND the extraction
  // prompt (reportingAI.js) so tagging stays the exact same tag dimensions as Campaign Tagger,
  // instead of a separate hardcoded vocabulary.
  const [dimensionValues, setDimensionValues] = useState({ tagDims: [], values: {}, campaignName: [] });
  const fields = fieldsFor(dimensionValues.tagDims || []);
  // Derived (see deriveSummaryMetrics doc comment above) rather than a fixed list, so the review
  // table's columns reflect whatever metric keys THIS batch of extracted rows actually has —
  // different sources (Salesforce vs. Dreamdata, say) can produce entirely different columns.
  const summaryMetrics = useMemo(() => deriveSummaryMetrics(pendingRows), [pendingRows]);
  // One free-text value per field for the "apply to all pending rows" bar below the review table —
  // a whole screenshot/CSV import is usually all one Product/Region etc. even when the AI couldn't
  // detect it per row (e.g. a flat monthly-totals table with no breakdown at all). Keyed by field
  // name directly (campaignName, or a tag dimension name like "Product").
  const [batchTags, setBatchTags] = useState({});

  // Ref to the hidden screenshot file input, so the visible "Upload screenshot" button can trigger
  // it directly. CSV/XLSX/PDF uploads (campaign-level exports, Goals & Pacing PDFs) moved to the
  // unified "Spend, Budget or Performance file" card in Data Sources (2026-08-01, per Mo — one
  // upload surface, route by content) — this tab now only receives that data via
  // initialPendingRows, it doesn't trigger its own extraction for those file types anymore.
  const fileInputRef = useRef(null); // screenshot (AI-vision)

  // Acknowledge the handoff (clear it on the parent side) once mounted — the rows themselves were
  // already consumed above via the lazy initializer, so this only calls the parent's setter, no
  // local setState here (same split AskAI's initialQuestion effect uses).
  useEffect(() => {
    if (initialPendingRows && initialPendingRows.length) onConsumeInitialPendingRows?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialRawPipelineImport) onConsumeInitialRawPipelineImport?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // PipelineColumnMapper's confirm handler — writes straight to reporting_facts, no staging step.
  // See mappingImporting's doc comment above for why this is a separate path from handleImport.
  const handleMappedImport = async (normalizedRows) => {
    setRawPipelineImport(null);
    setMappingImporting(true);
    setImportResult(null);
    try {
      const result = await upsertReportingFacts(session, workspace.id, normalizedRows);
      setImportResult(result);
      setTaggerRefreshSignal((n) => n + 1);
    } catch (err) {
      setImportResult({ error: err.message || "Import failed." });
    } finally {
      setMappingImporting(false);
    }
  };

  const handleImport = async () => {
    if (!pendingRows.length || hasUnresolved) return;
    const rowsToImport = mergeBatchTags(pendingRows);
    setImporting(true);
    setImportResult(null);
    try {
      const result = await upsertReportingFacts(session, workspace.id, rowsToImport);
      setImportResult(result);
      setPendingRows([]);
      setTaggerRefreshSignal((n) => n + 1);
    } catch (err) {
      setImportResult({ error: err.message || "Import failed." });
    } finally {
      setImporting(false);
    }
  };

  return (
    // Full width (2026-08-03, per Mo — "make the pipeline tagger full width like the campaign
    // tagger"): a flex column filling <main>'s remaining height, same top-level shape every other
    // tab's root uses (see e.g. PaidHQ.jsx's own step==="tag"&&view==="tagger" block) instead of the
    // old centered maxWidth:1100 page. The upload/mapping panels above the table incidentally go
    // full width too now — a reasonable side effect, not something worth special-casing back to a
    // narrower column just for those.
    <div onPaste={handlePaste} style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ padding: "28px 28px 0", flexShrink: 0 }}>
        <SectionLabel T={T}>Pipeline Tagger</SectionLabel>
        <div style={{ fontSize:16*(T.fsScale||1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Import Dreamdata / PowerBI data</div>
        <div style={{ fontSize:13*(T.fsScale||1), color: T.textSub, lineHeight: 1.6, marginBottom: 20 }}>
          Screenshot a table from your Dreamdata/PowerBI dashboard and drop it below, or paste
          directly (Cmd/Ctrl+V) anywhere on this page. Pipeline/funnel CSV or Excel exports (PowerBI,
          Salesforce, or anything else) and Goals &amp; Pacing PDFs now upload from the "Spend, Budget
          or Performance file" card in Data Sources — they land here automatically. CSV/Excel gets a
          column-mapping + period step first (every row comes in regardless of that source's own
          column names) and then lands straight in the table below, tag-ready — no separate review
          click. Re-importing a period that's already stored overwrites it with the new numbers —
          nothing is duplicated. Channel spend connections live in the Data Sources tab; this is
          specifically for funnel/pipeline performance data.
        </div>
      </div>

      <div style={{ padding: "0 28px", flexShrink: 0 }}>
        <PixelPanel T={T} contentStyle={{ padding: 20, marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileInput} style={{ display: "none" }} />
            <Btn T={T} variant="primary" size="md" onClick={() => fileInputRef.current?.click()}>
              <Icon name="paperclip" size={14} /> Upload screenshot
            </Btn>
            <span style={{ fontSize:12*(T.fsScale||1), color: T.textMuted }}>
              or paste a screenshot anywhere on this page — campaign-level and Goals &amp; Pacing files now upload from
              the "Spend, Budget or Performance file" card in Data Sources
            </span>
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

        {rawPipelineImport && (
          <PipelineColumnMapper
            T={T}
            headers={rawPipelineImport.headers}
            rows={rawPipelineImport.rows}
            tagDims={dimensionValues.tagDims || []}
            sourceLabel={rawPipelineImport.sourceLabel}
            onConfirm={handleMappedImport}
            onDiscard={() => setRawPipelineImport(null)}
          />
        )}
        {mappingImporting && (
          <div style={{ marginBottom: 20, padding: "9px 12px", background: T.accentBg, border: `1px solid ${T.accentBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 12, height: 12, border: `2px solid ${T.accentBorder}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} />
            Importing rows…
          </div>
        )}

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
                    {["Period", ...fields.map(fieldLabel), ...summaryMetrics.map((m) => m.label), ""].map((h, i) => (
                      <th key={i} style={{ padding: "6px 10px", fontSize:10*(T.fsScale||1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: i >= 1 + fields.length && i < 1 + fields.length + summaryMetrics.length ? "right" : "left" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pendingRows.map((row, idx) => (
                    <ReviewRow key={idx} T={T} row={row} onChange={(next) => updateRow(idx, next)} onRemove={() => removeRow(idx)} dimensionValues={dimensionValues} fields={fields} summaryMetrics={summaryMetrics} />
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
      </div>

      <ReportingFactsTagger
        T={T}
        session={session}
        workspace={workspace}
        campaignTags={campaignTags}
        tagDims={tagDims}
        canEdit={canEdit}
        refreshSignal={taggerRefreshSignal}
        onBackToDataSources={onBackToDataSources}
      />
    </div>
  );
}
