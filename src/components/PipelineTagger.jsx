import { useEffect, useMemo, useState } from "react";
import { PixelPanel, SectionLabel, Sel } from "./shared.jsx";
import { listReportingFacts } from "../lib/reportingApi.js";
import { deriveMetricColumns, fmtMetric, isRateMetric } from "../lib/reportingMetrics.js";
import { usePersistentState } from "../lib/persist.js";

// This file originally shipped as the "Pipeline Tagger" tab (2026-08-01), then briefly as a thin
// wrapper around the extracted tagging UI while the tab restructure was in progress (2026-08-02) —
// see git history / ReportingFactsTagger.jsx's own doc comment for that lineage.
//
// REPURPOSED 2026-08-02 (per Mo, confirmed via a direct question about what this tab should become
// once tagging moved to the new "Pipeline Tagger" tab — ReportingAnalyzer.jsx — which now embeds
// ReportingFactsTagger directly): this file is now "Reporting Intelligence" v1 — a first-pass
// breakdown/analysis view over already-tagged reporting_facts, sliceable by any tag dimension (or
// by Campaign), instead of a second copy of the tagging UI. It reads the exact same
// core.reporting_facts rows Pipeline Tagger writes/tags; it never writes anything itself.
//
// METRIC ROLLUP CORRECTNESS: summing a plain count (spend, mqls, clicks) across rows is always
// correct; summing or averaging a rate/cost-per/percentage metric (ctr, cp_mql, mql_attainment_pct)
// across rows is NOT — the correct value has to be recomputed from the underlying counts, and with
// an open per-client metrics schema (2026-08-02, see reportingAI.js's OPEN METRICS SCHEMA doc
// comment) there's no reliable generic way to know which raw counts a given rate key was derived
// from. So this view's aggregation (see reportingMetrics.js's isRateMetric/deriveMetricColumns)
// deliberately EXCLUDES rate-like metrics from every summed group rather than showing a
// mathematically wrong number — v1 shows accurate summed counts/dollars sliced by dimension, not a
// full rate-recomputation engine (a real "compute ctr from summed clicks/impressions" system would
// need to know which raw pair backs each rate key, which isn't knowable for an arbitrary client's
// export without a per-client mapping step — future work, not v1).
function aggregateByDimension(rows, dimKey) {
  const map = new Map();
  (rows || []).forEach((r) => {
    let label;
    if (!dimKey) label = "All rows";
    else if (dimKey === "campaignName") label = (r.campaignName || "").trim() || "(no campaign)";
    else label = (r.tags || {})[dimKey] || "(untagged)";

    if (!map.has(label)) map.set(label, { key: label, rows: [], metrics: {} });
    const g = map.get(label);
    g.rows.push(r);
    Object.entries(r.metrics || {}).forEach(([k, v]) => {
      if (isRateMetric(k)) return; // see this file's METRIC ROLLUP CORRECTNESS doc comment above
      const n = Number(v);
      if (isNaN(n)) return;
      g.metrics[k] = (g.metrics[k] || 0) + n;
    });
  });
  return Array.from(map.values());
}

export default function PipelineTagger({ T, session, workspace, tagDims }) {
  const [rows, setRows] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");

  const [sliceBy, setSliceBy] = usePersistentState("paidhq_reporting_intel_sliceBy", "campaignName");
  const [fSource, setFSource] = usePersistentState("paidhq_reporting_intel_fSource", "");
  const [fPeriodType, setFPeriodType] = usePersistentState("paidhq_reporting_intel_fPeriodType", "all");
  const [fSearch, setFSearch] = usePersistentState("paidhq_reporting_intel_fSearch", "");

  useEffect(() => {
    listReportingFacts(session, workspace.id)
      .then((r) => {
        setRows(r);
        setLoadError("");
      })
      .catch((err) => setLoadError(err.message || "Couldn't load pipeline data."));
  }, [session, workspace.id]);

  const allSources = useMemo(
    () => Array.from(new Set((rows || []).map((r) => r.source).filter(Boolean))).sort(),
    [rows]
  );

  const filteredRows = useMemo(() => {
    return (rows || []).filter((r) => {
      if (fSource && r.source !== fSource) return false;
      if (fPeriodType !== "all" && r.periodType !== fPeriodType) return false;
      return true;
    });
  }, [rows, fSource, fPeriodType]);

  const groups = useMemo(() => aggregateByDimension(filteredRows, sliceBy || null), [filteredRows, sliceBy]);
  const columns = useMemo(() => deriveMetricColumns(groups, { excludeRates: true }), [groups]);

  const filteredGroups = useMemo(() => {
    const fs = fSearch.trim().toLowerCase();
    const g = fs ? groups.filter((x) => x.key.toLowerCase().includes(fs)) : groups;
    const primaryKey = columns[0]?.key;
    return g.slice().sort((a, b) => {
      const diff = (primaryKey ? b.metrics[primaryKey] || 0 : 0) - (primaryKey ? a.metrics[primaryKey] || 0 : 0);
      return diff !== 0 ? diff : a.key.localeCompare(b.key);
    });
  }, [groups, fSearch, columns]);

  const totals = useMemo(() => {
    const t = {};
    filteredGroups.forEach((g) => {
      columns.forEach((c) => {
        t[c.key] = (t[c.key] || 0) + (g.metrics[c.key] || 0);
      });
    });
    return t;
  }, [filteredGroups, columns]);

  const sliceOptions = [{ value: "campaignName", label: "Campaign" }, ...((tagDims || []).map((d) => ({ value: d, label: d })))];

  if (rows === null && !loadError) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading…</div>
    );
  }

  return (
    <div style={{ padding: 28, maxWidth: 1300, margin: "0 auto", fontFamily: T.font, overflow: "auto", height: "100%", boxSizing: "border-box" }}>
      <SectionLabel T={T}>Reporting Intelligence</SectionLabel>
      <div style={{ fontSize: 16 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Pipeline performance breakdown</div>
      <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6, marginBottom: 20 }}>
        Slices every tagged reporting row by Campaign or any tag dimension this workspace uses, with counts and dollar
        figures summed correctly across periods. Rate/percentage/cost-per metrics (CTR, CP MQL, attainment %, etc.) are
        left out of these sums on purpose — averaging or adding them together across rows produces a number that looks
        precise but is wrong; see this view's per-row detail in Pipeline Tagger for those. Tag more rows there to sharpen
        this breakdown.
      </div>

      {loadError && (
        <div style={{ padding: "9px 12px", background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.danger, marginBottom: 16 }}>
          {loadError}
        </div>
      )}

      {rows.length === 0 && !loadError ? (
        <PixelPanel T={T} contentStyle={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 15 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Nothing imported yet</div>
          <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub }}>Import a screenshot or file in Pipeline Tagger first.</div>
        </PixelPanel>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>Slice by</span>
            <Sel value={sliceBy} onChange={setSliceBy} T={T} style={{ width: 160 }}>
              {sliceOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Sel>
            <Sel value={fSource} onChange={setFSource} T={T} style={{ width: 170 }}>
              <option value="">All sources</option>
              {allSources.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Sel>
            <Sel value={fPeriodType} onChange={setFPeriodType} T={T} style={{ width: 150 }}>
              <option value="all">All grains</option>
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
              <option value="quarter">Quarterly</option>
              <option value="year">Yearly</option>
            </Sel>
            <input
              value={fSearch}
              onChange={(e) => setFSearch(e.target.value)}
              placeholder={`Filter ${sliceOptions.find((o) => o.value === sliceBy)?.label.toLowerCase() || "value"}…`}
              style={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font, width: 190 }}
            />
            <span style={{ marginLeft: "auto", fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>
              {filteredGroups.length} group{filteredGroups.length === 1 ? "" : "s"} · {filteredRows.length} row{filteredRows.length === 1 ? "" : "s"}
            </span>
          </div>

          <PixelPanel T={T} contentStyle={{ padding: 0 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 * (T.fsScale || 1) }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                    {[sliceOptions.find((o) => o.value === sliceBy)?.label || "Slice", "Rows", ...columns.map((c) => c.label)].map((h, i) => (
                      <th key={i} style={{ padding: "8px 10px", fontSize: 10 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: i >= 2 ? "right" : "left" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredGroups.length === 0 && (
                    <tr>
                      <td colSpan={2 + columns.length} style={{ padding: "32px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>
                        No groups match your filters.
                      </td>
                    </tr>
                  )}
                  {filteredGroups.map((g) => (
                    <tr key={g.key} className="bhq-row" style={{ borderBottom: `1px solid ${T.border}` }}>
                      <td style={{ padding: "8px 10px", fontWeight: 600, color: T.text, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={g.key}>
                        {g.key}
                      </td>
                      <td style={{ padding: "8px 10px", color: T.textSub, fontSize: 12 * (T.fsScale || 1) }}>{g.rows.length}</td>
                      {columns.map((c) => (
                        <td key={c.key} style={{ padding: "8px 10px", color: T.text, textAlign: "right" }}>
                          {fmtMetric(g.metrics[c.key], c.money)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {filteredGroups.length > 0 && (
                  <tfoot>
                    <tr style={{ borderTop: `2px solid ${T.border}` }}>
                      <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>Total</td>
                      <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text, fontSize: 12 * (T.fsScale || 1) }}>{filteredRows.length}</td>
                      {columns.map((c) => (
                        <td key={c.key} style={{ padding: "8px 10px", fontWeight: 700, color: T.text, textAlign: "right" }}>
                          {fmtMetric(totals[c.key], c.money)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </PixelPanel>
        </>
      )}
    </div>
  );
}
