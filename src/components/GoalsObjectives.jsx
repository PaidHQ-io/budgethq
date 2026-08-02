import { useCallback, useEffect, useState } from "react";
import { PixelPanel, SectionLabel } from "./shared.jsx";
import { listReportingFacts } from "../lib/reportingApi.js";
import { labelForPeriod } from "../lib/reportingPeriods.js";

// Goals & Objectives tab (2026-08-01, per Mo — "minimal capture now, full tab later": the unified
// Data Sources uploader can now classify a file as "goals" and route it here so nothing gets lost
// or misrouted, but the real experience — attainment tracking, whatever Mo wants this to show — is
// a deliberately deferred follow-up. This is intentionally the simplest possible read-only view:
// no tagging UI, no editing, just "here's what's been captured as goals data so far."
//
// STORAGE: goals data lives in the exact same core.reporting_facts table pipeline performance data
// does — no new table/migration for this minimal pass. The only thing distinguishing a "goals" row
// is its `source` value (goals_pdf / goals_campaign_export, set at import time in PaidHQ.jsx's
// confirmUnifiedUpload — see fileTypeDetect.js's classification), filtered for client-side here.
// If/when this becomes a real tab with its own structure, these rows can be migrated then; nothing
// about this minimal view forecloses that.
const GOALS_SOURCE_PREFIX = "goals";

// Goal-flavored metrics worth a column at a glance — a fixed list on purpose (unlike
// ReportingAnalyzer.jsx/PipelineTagger.jsx, which derive their columns dynamically via
// reportingMetrics.js's deriveMetricColumns now that the metrics schema is open, 2026-08-02) since
// this tab is specifically about the goal/attainment fields reportingAI.js's schema documents, not
// an arbitrary client's own metric names.
const GOAL_METRICS = [
  { key: "budget_goal", label: "Budget Goal", money: true },
  { key: "spend_pacing_pct", label: "Spend Pacing %" },
  { key: "mql_goal", label: "MQL Goal" },
  { key: "mql_attainment_pct", label: "MQL Attainment %" },
  { key: "mkt_pipeline_goal", label: "Pipeline Goal", money: true },
  { key: "mkt_pipeline_attainment_pct", label: "Pipeline Attainment %" },
];

function fmtMetric(v, money) {
  if (v === undefined || v === null || v === "") return "—";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return money ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : n.toLocaleString();
}

function rowLabel(row) {
  const campaignName = (row.campaignName || "").trim();
  if (campaignName) return campaignName;
  const tags = row.tags || {};
  const label = Object.keys(tags).sort().map((d) => tags[d]).filter(Boolean).join(" / ");
  return label || "(untagged)";
}

export default function GoalsObjectives({ T, session, workspace }) {
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    listReportingFacts(session, workspace.id)
      .then((r) => {
        setRows(r.filter((row) => (row.source || "").startsWith(GOALS_SOURCE_PREFIX)));
        setError("");
      })
      .catch((err) => setError(err.message || "Couldn't load goals data."));
  }, [session, workspace.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const sorted = (rows || []).slice().sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));

  return (
    <div style={{ padding: 28, maxWidth: 1200, margin: "0 auto", fontFamily: T.font, overflow: "auto", height: "100%", boxSizing: "border-box" }}>
      <SectionLabel T={T}>Reporting</SectionLabel>
      <div style={{ fontSize: 16 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Goals & Objectives</div>
      <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6, marginBottom: 20 }}>
        Targets, budget goals, and attainment/forecast data captured from files uploaded as "Goals" in Data Sources.
        This is a first pass — a simple read-only list of what's been imported so far, not yet the full goals-tracking
        experience.
      </div>

      {error && (
        <div style={{ padding: "9px 12px", background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.danger, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {rows === null && !error && <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted }}>Loading…</div>}

      {rows !== null && sorted.length === 0 && !error && (
        <PixelPanel T={T} contentStyle={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 15 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Nothing here yet</div>
          <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub }}>
            Upload a goals/targets file from the "Spend, Budget or Performance file" card in Data Sources — files
            classified as "Goals" land here automatically.
          </div>
        </PixelPanel>
      )}

      {sorted.length > 0 && (
        <PixelPanel T={T} contentStyle={{ padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Period", "Segment", ...GOAL_METRICS.map((m) => m.label)].map((h, i) => (
                    <th key={i} style={{ padding: "8px 10px", fontSize: 10 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: i >= 2 ? "right" : "left" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr key={row.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: "8px 10px", fontSize: 12 * (T.fsScale || 1), color: T.text, fontWeight: 600 }}>{labelForPeriod(row.periodType, row.periodStart)}</td>
                    <td style={{ padding: "8px 10px", fontSize: 12 * (T.fsScale || 1), color: T.textSub, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rowLabel(row)}</td>
                    {GOAL_METRICS.map((m) => (
                      <td key={m.key} style={{ padding: "8px 10px", fontSize: 12 * (T.fsScale || 1), color: T.text, textAlign: "right" }}>
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
