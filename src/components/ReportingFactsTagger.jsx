import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, PixelPanel, SectionLabel, Pill, Sel, TagAutocompleteInput, WarnTip } from "./shared.jsx";
import { listReportingFacts, patchReportingFactsTags, getDimensionValues } from "../lib/reportingApi.js";
import { TAG_DIM_COLORS } from "../lib/core.js";
import { usePersistentState } from "../lib/persist.js";

// Extracted 2026-08-02 (per Mo — "duplicate the campaign tagger... within the updated Pipeline
// Tagger tab") out of what was originally PipelineTagger.jsx's own inline JSX, into a standalone,
// reusable component. Mirrors Campaign Tagger's UX — filter bar up top, checkbox+identity column on
// the left, a tags column on the right, bulk-select, apply-a-tag-dimension-to-selected, undo — but
// operates on core.reporting_facts (Dreamdata/PowerBI/eventually HubSpot/Salesforce import data)
// instead of spend_rows, using the exact same tag_dims vocabulary (Product/Region/Funnel/Pillar/
// etc., whatever this workspace has configured) so a segment means the same thing whether you're
// looking at ad spend or pipeline.
//
// WHY A SEPARATE FILE (not just moved inline into ReportingAnalyzer.jsx): the same tagging UI is
// used from two places during the tab restructure — ReportingAnalyzer.jsx (the tab now labeled
// "Pipeline Tagger" in NAV, its primary home going forward) AND, for now, PipelineTagger.jsx (the
// tab now labeled "Reporting Intelligence", which still renders this unchanged while its own
// content is slated to become a first-pass breakdown/analysis view instead — see that file's own
// doc comment). Keeping exactly one copy of this ~450-line implementation means task #163 (repurpose
// PipelineTagger.jsx) only has to swap what it renders, not untangle a duplicated copy of this logic.
//
// `variant`: "page" renders the full standalone page header (SectionLabel/title/description) for
// when this is a tab's entire content (PipelineTagger.jsx's current usage). "embedded" skips that
// and renders a compact SectionLabel instead, for use as a section within a larger page that already
// has its own page-level heading (ReportingAnalyzer.jsx's usage, directly below the import/review
// UI).
//
// Deliberately does NOT touch platform spend/budget in any way — per Mo, PowerBI's own spend
// number (joined to MQL/SQL/pipeline by the client's own IT team, already accurate ~98% of the
// time) stays exactly as imported. This component's only job is getting every reporting_facts row
// tagged with the same dimensions Campaign Tagger uses, so a later analysis view can slice pipeline
// performance by Product/Region/Funnel/etc. entirely on its own — no join back to spend_rows.
//
// IDENTITY: reporting_facts has one flat `campaign_name` field (not the group+name pair spend_rows
// uses), and MULTIPLE rows can share one campaign_name — one row per period this campaign has
// data for. Tagging here works at the campaign_name level (same mental model as Campaign Tagger:
// "tag this campaign," not "tag this one data point") — applying a dimension value to a campaign
// writes it to every one of that campaign's stored rows via a single batched PATCH.
//
// STORAGE GOTCHA: reporting_facts' unique key is (workspace_id, period_type, period_start,
// campaign_name, tags) — tags is PART of the row's identity, not a plain mutable column. That's why
// retagging goes through reporting-facts.js's dedicated PATCH-by-id route (updates a row in place)
// rather than the POST upsert route ReportingAnalyzer's import uses — upserting a new tags value
// would just insert a second, duplicate-looking row instead of correcting the existing one.

const CAMPAIGN_TAG_ROW_LIMIT = 20000; // sanity cap so a runaway import can't hang this component's group-by

// Rows with no campaign_name (Source A's daily-by-product export and Source C's Goals & Pacing PDF
// both have no per-row campaign identity, only tag columns like Business Unit/Pillar/Product Line)
// used to all collapse into one meaningless "(untitled)" group here, hiding every distinct
// product/pillar combination behind a single bucket. Fall back to a readable label built from the
// row's own tag values instead, so e.g. "EPM / Reporting / Spreadsheet Server" and "D&A / Tools /
// Jet Reports" group and tag separately. Only a row with no campaign_name AND no tags at all
// (shouldn't normally happen) still falls into "(untitled)".
// Known tradeoff: since the label is derived from CURRENT tags, applying a new dimension to a
// group (e.g. adding Region) changes every affected row's label together on the next refresh — the
// rows stay correctly merged as one group, but `selected`/dismissed-suggestion state (keyed by this
// label) can reset for that group, same as reselecting after any rename would.
function campaignGroupLabel(r) {
  const campaignName = (r.campaignName || "").trim();
  if (campaignName) return campaignName;
  const tags = r.tags || {};
  const label = Object.keys(tags).sort().map((d) => tags[d]).filter(Boolean).join(" / ");
  return label || "(untitled)";
}

function groupByCampaign(rows) {
  const map = new Map();
  (rows || []).slice(0, CAMPAIGN_TAG_ROW_LIMIT).forEach((r) => {
    const key = campaignGroupLabel(r);
    if (!map.has(key)) map.set(key, { campaignName: key, rows: [], sources: new Set() });
    const g = map.get(key);
    g.rows.push(r);
    if (r.source) g.sources.add(r.source);
  });
  return Array.from(map.values())
    .map((g) => {
      // Merged tag view: the most common non-empty value per dimension across this campaign's
      // rows. Rows CAN disagree (e.g. a few periods got tagged before the rest, or two imports of
      // the same campaign name landed with slightly different tags) — flagged as a conflict rather
      // than silently picked, so the count-based majority still displays something instead of the
      // row blocking, but the UI can warn.
      const dimCounts = {};
      g.rows.forEach((r) => {
        Object.entries(r.tags || {}).forEach(([dim, val]) => {
          if (!val) return;
          dimCounts[dim] = dimCounts[dim] || {};
          dimCounts[dim][val] = (dimCounts[dim][val] || 0) + 1;
        });
      });
      const tags = {};
      const conflicts = new Set();
      Object.entries(dimCounts).forEach(([dim, counts]) => {
        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        tags[dim] = entries[0][0];
        if (entries.length > 1) conflicts.add(dim);
      });
      return { ...g, tags, conflicts, periodCount: g.rows.length };
    })
    .sort((a, b) => a.campaignName.localeCompare(b.campaignName));
}

export default function ReportingFactsTagger({ T, session, workspace, campaignTags, tagDims, canEdit, variant = "page", refreshSignal }) {
  const [rows, setRows] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [dimensionValues, setDimensionValues] = useState({ tagDims: [], values: {}, campaignName: [] });
  const [notif, setNotif] = useState(null); // {msg,type}
  const [applying, setApplying] = useState(false);
  const [undoStack, setUndoStack] = useState([]); // array of batches; each batch = [{id,tags}] pre-change snapshot

  const [fCampaign, setFCampaign] = usePersistentState("paidhq_pipeline_tagger_fCampaign", "");
  const [fSource, setFSource] = usePersistentState("paidhq_pipeline_tagger_fSource", "");
  const [fTag, setFTag] = usePersistentState("paidhq_pipeline_tagger_fTag", "");
  const [fStatus, setFStatus] = usePersistentState("paidhq_pipeline_tagger_fStatus", "all");

  const [selected, setSelected] = useState(new Set()); // Set of campaignName
  const [applyDim, setApplyDim] = useState("");
  const [applyVal, setApplyVal] = useState("");
  const [editingTag, setEditingTag] = useState(null); // {campaignName, dim}
  const [editVal, setEditVal] = useState("");
  const [dismissedSuggestions, setDismissedSuggestions] = useState(new Set());

  const showNotif = (msg, type = "success") => {
    setNotif({ msg, type });
    setTimeout(() => setNotif(null), type === "error" ? 6000 : 3000);
  };

  const refresh = useCallback(() => {
    listReportingFacts(session, workspace.id)
      .then((r) => {
        setRows(r);
        setLoadError("");
      })
      .catch((err) => setLoadError(err.message || "Couldn't load pipeline data."));
  }, [session, workspace.id]);

  // refreshSignal: an arbitrary changing value a parent can bump (e.g. ReportingAnalyzer.jsx's
  // "Pipeline Tagger" tab, after a fresh import above this component) to force a re-fetch without
  // this component needing to expose an imperative handle — this component owns its own `rows`
  // state, so a sibling import panel writing new reporting_facts rows wouldn't otherwise be
  // reflected here until something remounts it.
  useEffect(() => {
    refresh();
  }, [refresh, refreshSignal]);

  useEffect(() => {
    getDimensionValues(session, workspace.id)
      .then(setDimensionValues)
      .catch(() => {
        /* non-critical — apply-value input just falls back to no suggestions */
      });
  }, [session, workspace.id]);

  const groups = useMemo(() => groupByCampaign(rows || []), [rows]);
  const rowsById = useMemo(() => new Map((rows || []).map((r) => [r.id, r])), [rows]);
  const allSources = useMemo(
    () => Array.from(new Set((rows || []).map((r) => r.source).filter(Boolean))).sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const fc = fCampaign.trim().toLowerCase();
    const ft = fTag.trim().toLowerCase();
    return groups.filter((g) => {
      if (fc && !g.campaignName.toLowerCase().includes(fc)) return false;
      if (fSource && !g.sources.has(fSource)) return false;
      // Selected groups are exempt from the tagged/untagged status filter (same fix as Campaign
      // Tagger's own filtered memo): applying a dimension to a selected "needs review" group moves
      // it into "tagged," which would otherwise yank it off screen — and out of the selection —
      // mid multi-dimension tagging session, right when you still need it there to apply the next
      // dimension.
      if (!selected.has(g.campaignName)) {
        const tagged = Object.keys(g.tags).length > 0;
        if (fStatus === "tagged" && !tagged) return false;
        if (fStatus === "untagged" && tagged) return false;
      }
      if (ft && !Object.values(g.tags).some((v) => String(v).toLowerCase().includes(ft))) return false;
      return true;
    });
  }, [groups, fCampaign, fSource, fStatus, fTag, selected]);

  const hasF = fCampaign || fSource || fTag || fStatus !== "all";
  const clearF = () => {
    setFCampaign("");
    setFSource("");
    setFTag("");
    setFStatus("all");
  };

  const toggleSel = (name) =>
    setSelected((p) => {
      const nx = new Set(p);
      nx.has(name) ? nx.delete(name) : nx.add(name);
      return nx;
    });
  const selAll = () => setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map((g) => g.campaignName)));

  // Shared apply path — every mutation (bulk apply, suggestion accept, inline edit, remove) funnels
  // through here so undo/notif/local-state-sync stays in exactly one place. `updates` is
  // [{id, tags}] with tags already being the FULL post-change object for that row (PATCH replaces,
  // it doesn't merge server-side — see reporting-facts.js's PATCH doc comment).
  const patchRows = useCallback(
    async (updates, successMsg) => {
      if (!updates.length) return;
      const undoBatch = updates.map((u) => ({ id: u.id, tags: rowsById.get(u.id)?.tags || {} }));
      setApplying(true);
      try {
        const result = await patchReportingFactsTags(session, workspace.id, updates);
        const byId = new Map(updates.map((u) => [u.id, u.tags]));
        setRows((prev) => prev.map((r) => (byId.has(r.id) ? { ...r, tags: byId.get(r.id) } : r)));
        setUndoStack((h) => [...h.slice(-19), undoBatch]);
        showNotif(successMsg(result));
      } catch (err) {
        showNotif(err.message || "Failed to update tags", "error");
      } finally {
        setApplying(false);
      }
    },
    [session, workspace.id, rowsById]
  );

  const applyDimToGroups = (dim, val, campaignNames) => {
    if (!canEdit || !dim || !val || !campaignNames.length) return;
    const updates = [];
    groups
      .filter((g) => campaignNames.includes(g.campaignName))
      .forEach((g) =>
        g.rows.forEach((r) => {
          if ((r.tags || {})[dim] === val) return;
          updates.push({ id: r.id, tags: { ...(r.tags || {}), [dim]: val } });
        })
      );
    patchRows(updates, (result) => `Applied ${dim}: ${val} to ${result.updated} row${result.updated === 1 ? "" : "s"}${result.skipped?.length ? ` (${result.skipped.length} skipped)` : ""}`);
  };

  const removeDimFromGroup = (group, dim) => {
    if (!canEdit) return;
    const updates = [];
    group.rows.forEach((r) => {
      if (!(r.tags || {})[dim]) return;
      const next = { ...r.tags };
      delete next[dim];
      updates.push({ id: r.id, tags: next });
    });
    patchRows(updates, (result) => `Removed ${dim} from ${result.updated} row${result.updated === 1 ? "" : "s"}`);
  };

  const saveInlineEdit = () => {
    if (!editingTag) return;
    const { campaignName, dim } = editingTag;
    const v = editVal.trim();
    setEditingTag(null);
    setEditVal("");
    if (!v) return;
    applyDimToGroups(dim, v, [campaignName]);
  };

  const undoLast = async () => {
    const batch = undoStack[undoStack.length - 1];
    if (!batch || !batch.length) return;
    setApplying(true);
    try {
      const result = await patchReportingFactsTags(session, workspace.id, batch);
      const byId = new Map(batch.map((u) => [u.id, u.tags]));
      setRows((prev) => prev.map((r) => (byId.has(r.id) ? { ...r, tags: byId.get(r.id) } : r)));
      setUndoStack((h) => h.slice(0, -1));
      showNotif(`Undone (${result.updated} row${result.updated === 1 ? "" : "s"})`);
    } catch (err) {
      showNotif(err.message || "Undo failed", "error");
    } finally {
      setApplying(false);
    }
  };

  // Cross-match against Campaign Tagger's own tags (same tagging effort shouldn't have to happen
  // twice for a campaign you've already tagged for ad spend). Exact, case-insensitive match only,
  // against either half of a campaignKey (group name or ad/campaign name) — deliberately NOT
  // fuzzy/substring, since a false-positive tag applied to the wrong pipeline campaign is worse
  // than making the user tag it manually. One click applies every dimension the matched ad campaign
  // already has that this pipeline campaign is still missing — never overwrites a dimension this
  // campaign already has a value for.
  const campaignTagLookup = useMemo(() => {
    const lookup = new Map();
    Object.entries(campaignTags || {}).forEach(([key, t]) => {
      if (!t || !Object.keys(t).length) return;
      const [groupName, name] = key.split("||");
      [groupName, name].forEach((n) => {
        const norm = (n || "").trim().toLowerCase();
        if (norm && !lookup.has(norm)) lookup.set(norm, { key, tags: t });
      });
    });
    return lookup;
  }, [campaignTags]);

  const suggestFor = useCallback(
    (group) => {
      if (dismissedSuggestions.has(group.campaignName)) return null;
      const match = campaignTagLookup.get(group.campaignName.trim().toLowerCase());
      if (!match) return null;
      const missing = Object.entries(match.tags).filter(([dim, val]) => val && !group.tags[dim]);
      if (!missing.length) return null;
      return { ...match, missing };
    },
    [campaignTagLookup, dismissedSuggestions]
  );

  const suggestions = useMemo(
    () =>
      filtered
        .map((g) => ({ group: g, s: suggestFor(g) }))
        .filter((x) => x.s)
        .slice(0, 6),
    [filtered, suggestFor]
  );

  const applySuggestion = (group) => {
    if (!canEdit) return;
    const s = suggestFor(group);
    if (!s) return;
    const updates = [];
    group.rows.forEach((r) => {
      const merged = { ...(r.tags || {}) };
      let changed = false;
      s.missing.forEach(([dim, val]) => {
        if (!merged[dim]) {
          merged[dim] = val;
          changed = true;
        }
      });
      if (changed) updates.push({ id: r.id, tags: merged });
    });
    patchRows(updates, (result) => `Applied ${s.missing.length} tag${s.missing.length === 1 ? "" : "s"} from "${group.campaignName}"'s matched ad campaign to ${result.updated} row${result.updated === 1 ? "" : "s"}`);
    setDismissedSuggestions((p) => new Set(p).add(group.campaignName));
  };

  if (rows === null && !loadError) {
    return (
      <div style={{ padding: variant === "page" ? 40 : 20, textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading…</div>
    );
  }

  return (
    <div>
      {variant === "page" ? (
        <>
          <SectionLabel T={T}>Reporting Intelligence</SectionLabel>
          <div style={{ fontSize: 16 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Tag pipeline performance data</div>
          <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6, marginBottom: 20 }}>
            Tags every imported PowerBI/Dreamdata (and eventually HubSpot/Salesforce) row with the same dimensions Campaign
            Tagger uses — Product, Region, Funnel, and whatever else this workspace has configured — so pipeline performance
            can be sliced the same way ad spend already is. This never touches platform spend or budgets; it only tags rows
            already imported in Pipeline Tagger.
          </div>
        </>
      ) : (
        <SectionLabel T={T}>Tag &amp; review</SectionLabel>
      )}

      {loadError && (
        <div style={{ padding: "9px 12px", background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), color: T.danger, marginBottom: 16 }}>
          {loadError}
        </div>
      )}

      {notif && (
        <div style={{ padding: "9px 12px", marginBottom: 16, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), background: notif.type === "error" ? T.dangerBg : T.successBg, border: `1px solid ${notif.type === "error" ? T.dangerBorder : T.successBorder}`, color: notif.type === "error" ? T.danger : T.success }}>
          {notif.msg}
        </div>
      )}

      {groups.length === 0 && !loadError ? (
        <PixelPanel T={T} contentStyle={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 15 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6 }}>Nothing to tag yet</div>
          <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub }}>Import a screenshot or file above first.</div>
        </PixelPanel>
      ) : (
        <>
          {suggestions.length > 0 && (
            <div style={{ padding: "8px 12px", marginBottom: 14, background: T.accentBg, border: `1px solid ${T.accentBorder}`, borderRadius: T.r8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: T.text }}>Suggest</span>
              {suggestions.map(({ group, s }) => (
                <button
                  key={group.campaignName}
                  onClick={() => applySuggestion(group)}
                  disabled={!canEdit || applying}
                  style={{ fontSize: 12 * (T.fsScale || 1), background: T.surface, border: `1px solid ${T.border}`, color: T.text, borderRadius: T.r14, padding: "3px 10px", cursor: canEdit ? "pointer" : "default", fontFamily: T.font, fontWeight: 500 }}
                >
                  "{group.campaignName}" matches a tagged ad campaign — apply {s.missing.length} tag{s.missing.length === 1 ? "" : "s"}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <input
              value={fCampaign}
              onChange={(e) => setFCampaign(e.target.value)}
              placeholder="Campaign contains…"
              style={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font, width: 200 }}
            />
            <Sel value={fSource} onChange={setFSource} T={T} style={{ width: 170 }}>
              <option value="">All sources</option>
              {allSources.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Sel>
            <input
              value={fTag}
              onChange={(e) => setFTag(e.target.value)}
              placeholder="Tag value contains…"
              style={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font, width: 170 }}
            />
            <Sel value={fStatus} onChange={setFStatus} T={T} style={{ width: 150 }}>
              <option value="all">All statuses</option>
              <option value="tagged">Tagged</option>
              <option value="untagged">Needs review</option>
            </Sel>
            {hasF && <Btn onClick={clearF} variant="ghost" size="sm" T={T}>Clear filters</Btn>}
            {undoStack.length > 0 && (
              <Btn onClick={undoLast} disabled={applying} variant="ghost" size="sm" T={T}>↩ Undo ({undoStack.length})</Btn>
            )}
            <span style={{ marginLeft: "auto", fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>
              {filtered.length} of {groups.length} campaigns
            </span>
          </div>

          {selected.size > 0 && canEdit && (
            <div style={{ padding: "8px 12px", marginBottom: 12, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Pill color={T.text} bg={T.accent} border={T.text}>{selected.size} selected</Pill>
              <span style={{ color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>→</span>
              <Sel value={applyDim} onChange={setApplyDim} T={T} style={{ width: 140, fontSize: 12 * (T.fsScale || 1) }}>
                <option value="">Dimension…</option>
                {(tagDims || []).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Sel>
              <TagAutocompleteInput
                T={T}
                value={applyVal}
                onChange={setApplyVal}
                suggestions={dimensionValues.values?.[applyDim] || []}
                onEnter={() => {
                  applyDimToGroups(applyDim, applyVal.trim(), Array.from(selected));
                  setApplyVal("");
                }}
                placeholder="Tag value…"
                style={{ width: 140 }}
                inputStyle={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r7, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }}
              />
              <Btn
                onClick={() => {
                  applyDimToGroups(applyDim, applyVal.trim(), Array.from(selected));
                  setApplyVal("");
                }}
                disabled={!applyDim || !applyVal.trim() || applying}
                variant="primary"
                size="sm"
                T={T}
              >
                Apply
              </Btn>
              <Btn onClick={() => setSelected(new Set())} variant="ghost" size="sm" T={T}>Clear</Btn>
            </div>
          )}

          <PixelPanel T={T} contentStyle={{ padding: 0 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 * (T.fsScale || 1) }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                    <th style={{ padding: "8px 10px", width: 32 }}>
                      <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={selAll} style={{ cursor: "pointer", accentColor: T.accent, width: 13, height: 13 }} />
                    </th>
                    {["Campaign", "Source", "Periods", "Tags", "Status"].map((h) => (
                      <th key={h} style={{ padding: "8px 10px", fontSize: 10 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: "left" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: "32px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>
                        No campaigns match your filters. {hasF && <span onClick={clearF} style={{ color: T.accent, cursor: "pointer", fontWeight: 400 }}>Clear filters</span>}
                      </td>
                    </tr>
                  )}
                  {filtered.map((g) => {
                    const isSel = selected.has(g.campaignName);
                    const tc = Object.keys(g.tags).length;
                    const orderedDims = [...(tagDims || []).filter((d) => Object.prototype.hasOwnProperty.call(g.tags, d)), ...Object.keys(g.tags).filter((d) => !(tagDims || []).includes(d))];
                    return (
                      <tr key={g.campaignName} className={isSel ? undefined : "bhq-row"} style={{ borderBottom: `1px solid ${T.border}`, background: isSel ? T.rowSelected : "transparent" }}>
                        <td style={{ padding: "8px 10px" }}>
                          <input type="checkbox" checked={isSel} onChange={() => toggleSel(g.campaignName)} style={{ cursor: "pointer", accentColor: T.accent, width: 13, height: 13 }} />
                        </td>
                        <td style={{ padding: "8px 10px", fontWeight: 600, color: T.text, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={g.campaignName}>
                          {g.campaignName}
                        </td>
                        <td style={{ padding: "8px 10px", color: T.textSub, fontSize: 12 * (T.fsScale || 1) }}>{Array.from(g.sources).join(", ") || "—"}</td>
                        <td style={{ padding: "8px 10px", color: T.textSub, fontSize: 12 * (T.fsScale || 1) }}>{g.periodCount}</td>
                        <td style={{ padding: "8px 10px" }}>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                            {tc === 0 ? (
                              <Pill color={T.text} bg={T.surfaceEl} border={T.border} style={{ fontFamily: T.font, fontWeight: 400, borderRadius: T.r6 }}>needs review</Pill>
                            ) : (
                              orderedDims.map((dim) => {
                                const val = g.tags[dim];
                                const dimIdx = (tagDims || []).indexOf(dim);
                                const dc = TAG_DIM_COLORS[(dimIdx >= 0 ? dimIdx : 0) % TAG_DIM_COLORS.length];
                                const conflicted = g.conflicts.has(dim);
                                return (
                                  <span key={dim} style={{ display: "inline-flex", alignItems: "center", fontSize: 13 * (T.fsScale || 1), fontWeight: 400, padding: "2px 4px 2px 8px", borderRadius: T.r6, background: dc + "14", color: dc, border: `1px solid ${dc}40`, gap: 2, fontFamily: T.font }}>
                                    <span style={{ opacity: 0.75, marginRight: 1 }}>{dim}:</span>
                                    {editingTag?.campaignName === g.campaignName && editingTag?.dim === dim ? (
                                      <TagAutocompleteInput
                                        T={T}
                                        autoFocus
                                        value={editVal}
                                        onChange={setEditVal}
                                        suggestions={dimensionValues.values?.[dim] || []}
                                        onEnter={saveInlineEdit}
                                        onEscape={() => { setEditingTag(null); setEditVal(""); }}
                                        onBlur={saveInlineEdit}
                                        style={{ width: Math.max(60, editVal.length * 7 + 20) + "px" }}
                                        inputStyle={{ background: "transparent", border: "none", outline: "none", color: T.text, fontSize: 13 * (T.fsScale || 1), fontWeight: 400, width: "100%", fontFamily: T.font, padding: 0 }}
                                      />
                                    ) : (
                                      <span
                                        onClick={() => { if (!canEdit) return; setEditingTag({ campaignName: g.campaignName, dim }); setEditVal(val); }}
                                        style={{ cursor: canEdit ? "text" : "default", fontWeight: 400 }}
                                        title={conflicted ? "Rows for this campaign disagree on this dimension — showing the most common value" : undefined}
                                      >
                                        {val}
                                      </span>
                                    )}
                                    {conflicted && <WarnTip T={T} size={11} text="This campaign's stored periods don't all agree on this dimension's value — click to set one value for all of them." />}
                                    {canEdit && (
                                      <span onClick={() => removeDimFromGroup(g, dim)} style={{ color: T.textMuted, cursor: "pointer", fontSize: 13 * (T.fsScale || 1), lineHeight: 1, marginLeft: 1, padding: "0 2px" }}>×</span>
                                    )}
                                  </span>
                                );
                              })
                            )}
                          </div>
                        </td>
                        <td style={{ padding: "8px 10px" }}>
                          <Pill color={tc > 0 ? T.success : T.textMuted} bg={tc > 0 ? T.successBg : T.surfaceEl} border={tc > 0 ? T.successBorder : T.border}>
                            {tc > 0 ? "Tagged" : "Needs review"}
                          </Pill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </PixelPanel>
        </>
      )}
    </div>
  );
}
