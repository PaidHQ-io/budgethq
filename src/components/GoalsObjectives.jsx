import { useState } from "react";
import { SectionLabel } from "./shared.jsx";
import ReportingFactsTagger from "./ReportingFactsTagger.jsx";
import GoalsImportWizard from "./GoalsImportWizard.jsx";
import { isGoalsSource } from "../lib/pipelineColumnMapping.js";

// Goals & Objectives tab (REBUILT AGAIN 2026-08-19, per Mo — "no this is not working at all. there's
// no need to choose the channel or the month. I want you to complete start fresh and duplicate the
// process of importing a budget file. Take the same popup and UX and just change it slightly for
// goals.") The PREVIOUS version of this file embedded PipelineColumnMapper.jsx directly (reused
// unchanged from pipeline import, just with different metric options) — Mo's real file kept hitting
// that flow's assumptions (a forced Channel section, a forced fallback Month/Quarter picker even when
// the file's own headers already stated the period) and he asked for a genuinely different process
// modeled on Budget import instead, not another patch on top of the pipeline one.
//
// ARCHITECTURE: all of the import UX now lives in GoalsImportWizard.jsx, a direct port of
// BudgetManager.jsx's own Import modal (upload -> click-to-pick header row -> map -> preview) — see
// that file's own top doc comment for exactly what's reused vs. what had to differ (multiple named
// metrics per row instead of Budget's single $ amount; writes to core.reporting_facts via
// upsertReportingFacts instead of the local budgets state; position-indexed column handling so two
// identically-named header blocks, e.g. "January" appearing twice for two different metrics, don't
// collide). This file is now just the tab shell: intro copy, the import wizard (which owns its own
// modal + a sidebar-portaled "↑ Import CSV / Excel" trigger, exactly like Budget's), and the
// goals-scoped browse/tag grid.
//
// sourceLabel="goals_csv_mapped" (written by GoalsImportWizard on every normalized row) +
// sourceFilter={isGoalsSource} on the embedded ReportingFactsTagger together scope this tab to
// goals-prefixed reporting_facts rows only — the mirror image of ReportingAnalyzer.jsx's own
// sourceFilter={isPipelineSource} — so switching between the two tabs never shows the other's data.
// Goals and pipeline still share the exact same core.reporting_facts table; no new table/migration.
//
// DROPPED from the previous version, deliberately, matching Budget import's own (simpler) pattern:
// File Store "Apply" replay no longer pre-fills a saved column mapping — re-running an import via
// Apply just reopens this same wizard fresh, same as Budget's own applyStoredFile branch. PDF goals
// imports still route through ReportingAnalyzer's own AI-extraction flow (unchanged, out of scope
// here) — a PDF goals import still lands correctly in reporting_facts, it just needs this tab opened
// afterward to see it (this grid is goals-only; ReportingAnalyzer's is pipeline-only).
export default function GoalsObjectives({
  T, session, workspace, tagDims, canEdit, sidebarEl, promptAndArchiveFile,
  initialImportFile, onConsumeInitialImportFile,
}) {
  // Bumped after a successful import to tell the embedded ReportingFactsTagger to re-fetch — it owns
  // its own `rows` state fetched internally, same reasoning as ReportingAnalyzer's identical signal.
  const [taggerRefreshSignal, setTaggerRefreshSignal] = useState(0);
  const [importResult, setImportResult] = useState(null);

  const handleImported = (result) => {
    setImportResult(result);
    setTaggerRefreshSignal((n) => n + 1);
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ padding: "20px 28px 0", flexShrink: 0 }}>
        <SectionLabel T={T}>Reporting</SectionLabel>
        <div style={{ fontSize: 16 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Goals & Objectives</div>
        <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6, marginBottom: 16, maxWidth: 720 }}>
          Targets, budget goals, and attainment/forecast data — imported and tagged separately from Pipeline Performance.
          Use "↑ Import CSV / Excel" in the sidebar, or upload a goals/targets file from Data Sources.
        </div>

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

      <GoalsImportWizard
        T={T}
        session={session}
        workspace={workspace}
        tagDims={tagDims}
        canEdit={canEdit}
        sidebarEl={sidebarEl}
        promptAndArchiveFile={promptAndArchiveFile}
        initialImportFile={initialImportFile}
        onConsumeInitialImportFile={onConsumeInitialImportFile}
        onImported={handleImported}
      />

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
