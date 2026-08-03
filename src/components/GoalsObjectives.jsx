import { useEffect, useState } from "react";
import { SectionLabel } from "./shared.jsx";
import ReportingFactsTagger from "./ReportingFactsTagger.jsx";
import PipelineColumnMapper from "./PipelineColumnMapper.jsx";
import { upsertReportingFacts } from "../lib/reportingApi.js";
import { isGoalsSource } from "../lib/pipelineColumnMapping.js";

// Goals & Objectives tab (REBUILT 2026-08-19, per Mo — "let's build the goals & objectives import
// like we've done with the campaign spend and pipeline import. we'll need to save and be able to
// rename the files and also be able to tag them with similar dimensions and tags"). This used to be
// a deliberately minimal, read-only list ("minimal capture now, full tab later" — see this file's
// prior version's own doc comment) with no tagging UI at all; this IS that deferred follow-up.
//
// ARCHITECTURE: rather than fork a second copy of ReportingAnalyzer.jsx/ReportingFactsTagger.jsx's
// ~700+ lines of column-mapping + grid/tagging logic, this reuses BOTH components directly, scoped
// to goals data via two things:
//   - sourceLabel="goals_csv_mapped" on the raw-import handoff (set by PaidHQ.jsx's
//     confirmUnifiedUpload/applyStoredFile — see those for the live-import and File-Store-"Apply"-
//     replay paths respectively) — PipelineColumnMapper writes this straight through as every
//     normalized row's `source` field (see buildNormalizedPipelineRows), so it MUST start with
//     "goals" (isGoalsSource's prefix) or rows would silently vanish from this tab's own filter.
//   - sourceFilter={isGoalsSource} on the embedded ReportingFactsTagger, so this tab's browse/tag
//     grid only ever shows goals-prefixed rows — the mirror image of ReportingAnalyzer.jsx's own
//     sourceFilter={isPipelineSource}, so switching between the two tabs never shows the other's data.
//
// STORAGE: goals data still lives in the exact same core.reporting_facts table pipeline performance
// data does (see isGoalsSource's own doc note in pipelineColumnMapping.js) — no new table/migration.
//
// NOT carried over from this file's prior version: PDF goals imports still route through
// ReportingAnalyzer's own AI-extraction review flow (PaidHQ.jsx's confirmUnifiedUpload — out of
// scope for this pass, which per Mo's own choice only switched the CSV/XLSX path to open mapping,
// matching exactly how pipeline CSV/XLSX vs. PDF are already split there). A PDF goals import still
// succeeds and lands in reporting_facts correctly; it just won't show up in ReportingAnalyzer's own
// grid afterward (that grid is now pipeline-only) — the user needs to switch to this tab to see it.
export default function GoalsObjectives({
  T, session, workspace, tagDims, canEdit, sidebarEl, archiveImportConfig,
  initialRawGoalsImport, onConsumeInitialRawGoalsImport,
}) {
  // Same one-shot relay pattern as ReportingAnalyzer.jsx's initialRawPipelineImport — this tab is
  // conditionally mounted (unmounts on every tab switch away), so a lazy initializer is correct here,
  // not just convenient: PaidHQ.jsx never sets pendingGoalsRawImport and switches to this view except
  // together (see confirmUnifiedUpload/applyStoredFile), so this always freshly mounts at exactly the
  // moment of handoff.
  const [rawGoalsImport, setRawGoalsImport] = useState(() => initialRawGoalsImport || null);
  const [mappingImporting, setMappingImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  // Bumped after a successful import to tell the embedded ReportingFactsTagger to re-fetch — it owns
  // its own `rows` state fetched internally, same reasoning as ReportingAnalyzer's identical signal.
  const [taggerRefreshSignal, setTaggerRefreshSignal] = useState(0);

  useEffect(() => {
    if (initialRawGoalsImport) onConsumeInitialRawGoalsImport?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirrors ReportingAnalyzer.jsx's handleMappedImport — see that function's own doc comment for why
  // the archivedFileId capture happens before clearing rawGoalsImport, and why the sidecar write is
  // fire-and-forget.
  const handleMappedImport = async (normalizedRows, mappingMeta) => {
    const archivedFileId = rawGoalsImport?.archivedFileId;
    setRawGoalsImport(null);
    setMappingImporting(true);
    setImportResult(null);
    try {
      const result = await upsertReportingFacts(session, workspace.id, normalizedRows);
      if (archivedFileId && mappingMeta) archiveImportConfig?.(archivedFileId, { kind: "goals", ...mappingMeta });
      setImportResult(result);
      setTaggerRefreshSignal((n) => n + 1);
    } catch (err) {
      setImportResult({ error: err.message || "Import failed." });
    } finally {
      setMappingImporting(false);
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ padding: "20px 28px 0", flexShrink: 0 }}>
        <SectionLabel T={T}>Reporting</SectionLabel>
        <div style={{ fontSize: 16 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Goals & Objectives</div>
        <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6, marginBottom: 16, maxWidth: 720 }}>
          Targets, budget goals, and attainment/forecast data — imported and tagged the same way as Pipeline Performance,
          kept separate from it here. Upload a goals/targets file from Data Sources; files classified as "Goals" land here.
        </div>

        {rawGoalsImport && (
          <PipelineColumnMapper
            T={T}
            headers={rawGoalsImport.headers}
            rows={rawGoalsImport.rows}
            tagDims={tagDims}
            sourceLabel={rawGoalsImport.sourceLabel}
            onConfirm={handleMappedImport}
            onDiscard={() => setRawGoalsImport(null)}
            initialMapping={rawGoalsImport.initialMapping}
            initialPeriodMode={rawGoalsImport.initialPeriodMode}
            initialYear={rawGoalsImport.initialYear}
            initialMonth={rawGoalsImport.initialMonth}
            initialQuarter={rawGoalsImport.initialQuarter}
            initialHardcodedChannel={rawGoalsImport.initialHardcodedChannel}
          />
        )}
        {mappingImporting && (
          <div style={{ marginBottom: 20, padding: "9px 12px", background: T.accentBg, border: `1px solid ${T.accentBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 12, height: 12, border: `2px solid ${T.accentBorder}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} />
            Importing rows…
          </div>
        )}
        {importResult && (
          <div
            style={{
              marginBottom: 20,
              padding: "10px 14px",
              borderRadius: T.r8,
              fontSize: 12 * (T.fsScale || 1),
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
        tagDims={tagDims}
        canEdit={canEdit}
        refreshSignal={taggerRefreshSignal}
        sidebarEl={sidebarEl}
        sourceFilter={isGoalsSource}
        datasetLabel="Goals & Objectives"
        storageKeyPrefix="paidhq_goals_tagger_"
      />
    </div>
  );
}
