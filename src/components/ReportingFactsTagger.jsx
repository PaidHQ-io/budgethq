import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Icon, Pill, Sel, TagAutocompleteInput, MatchModeToggle, IconField } from "./shared.jsx";
import { listReportingFacts, patchReportingFactsTags, deleteReportingFacts, getDimensionValues } from "../lib/reportingApi.js";
import { TAG_DIM_COLORS, PLATFORM_OPTIONS, PLATFORM_COLORS, campaignKey, splitFilterTerms, matchesTerms } from "../lib/core.js";
import { usePersistentState } from "../lib/persist.js";
import { AD_GROUP_TAG_KEY, CHANNEL_TAG_KEY, PIPELINE_METRIC_MAP_OPTIONS } from "../lib/pipelineColumnMapping.js";
import { fmtMetric, isMoneyMetric } from "../lib/reportingMetrics.js";

// REBUILT 2026-08-03 (per Mo — "make the pipeline tagger full width like the campaign tagger...
// UX and UI to be identical to the campaign tagger"): this used to be a simpler Campaign-Tagger-
// STYLED tagging table (filter bar, checkbox+identity column, tags column, bulk-apply, undo,
// cross-match suggestions); it's now a much closer structural clone — full-width grid rows (not a
// <table>), sortable column headers, persistent filters/sort/column-selection, per-row delete, and
// selectable columns — while still operating on core.reporting_facts instead of spend_rows. See
// this file's own git history for the prior, simpler version.
//
// IDENTITY: Campaign Tagger has two REAL columns (campaign_group_name, campaign_name). reporting_
// facts only has one (`campaign_name`) — no schema migration was in scope here (that table is owned
// by a separate shared repo, not this one — see pipelineColumnMapping.js's top doc comment), so "Ad
// Group / Ad Set Name" and "Channel" are stored as two RESERVED keys inside the existing `tags`
// jsonb blob instead (AD_GROUP_TAG_KEY/CHANNEL_TAG_KEY) — never shown as regular tag pills, never
// offered in the tag-dimension apply dropdown, and (per dimension-values.js's tagDims list being
// seeded only from workspace_config.tag_dims) never leak into the regular tag-dimension UI either.
//
// GROUPING (per Mo, confirmed via a direct question — "aggregate & sum, matches Campaign Tagger"):
// one row here represents one Campaign + Ad Group combo, with every metric SUMMED across every
// period imported for it — exactly Campaign Tagger's own Spend-summed-per-campaign model, just
// applied to an open metrics schema instead of one fixed `spend` field. The grouping KEY reuses
// core.js's own campaignKey(groupName,name) helper verbatim (same "||"-joined identity Campaign
// Tagger already uses for spend rows) so nothing new has to be invented for it.
//
// DELETE (per Mo, confirmed via a direct question — "permanently delete from the database"):
// Campaign Tagger's own "x" only removes a campaign from the local in-memory spend dataset, which
// hasn't been synced yet at that point. reporting_facts rows are already live in the database the
// moment they're imported, so this hits the real DELETE /reporting-facts endpoint (see
// deleteReportingFacts) rather than just filtering local state.
//
// KNOWN EDGE CASE: deleting a group with a blank Ad Group/Ad Set (the common case — most CSV
// exports don't have one, per Mo's own point 3) filters the DELETE by campaign_name alone, since
// jsonb containment can't express "tags does NOT have this key." If the SAME campaign_name is later
// re-imported WITH a real ad group value under a different row, deleting the blank-ad-group group
// would also catch rows that share that campaign_name but do have an ad group set. Accepted as rare
// in practice rather than adding a "tags NOT ? key" query param for a one-in-a-thousand collision.

// The reserved structural tag keys ride in the same jsonb blob as real tag dimensions but are never
// treated as one — filtered out of every "regular tags" computation below.
const RESERVED_TAG_KEYS = new Set([AD_GROUP_TAG_KEY, CHANNEL_TAG_KEY]);

// Selectable/orderable column definitions (2026-08-03, per Mo's point 5 — "the fields/columns will
// be selectable"). Campaign Name is the one column that can't be turned off — it's this table's
// primary identity, same role Campaign Tagger's own (non-optional) Campaign column plays.
const METRIC_COLUMNS = PIPELINE_METRIC_MAP_OPTIONS.map((m) => ({ key: m.key, label: m.label, type: "metric", money: isMoneyMetric(m.key) }));
const ALL_COLUMNS = [
  { key: "campaignName", label: "Campaign Name", type: "text", required: true },
  { key: "adGroup", label: "Ad Group/Ad Set Name", type: "text" },
  { key: "channel", label: "Channel", type: "channel" },
  ...METRIC_COLUMNS,
];
const DEFAULT_COLUMNS = ALL_COLUMNS.map((c) => c.key);

const CAMPAIGN_TAG_ROW_LIMIT = 20000; // sanity cap so a runaway import can't hang this component's group-by

// Groups raw reporting_facts rows into one entry per Campaign + Ad Group combo (see this file's top
// doc comment), summing every metric key present across that group's rows and majority-voting every
// OTHER tag dimension (same conflict-flagging approach the prior version of this file used) plus
// Channel specifically (its own majority vote, surfaced separately from the regular tags object).
function buildGroups(rows) {
  const map = new Map();
  (rows || []).slice(0, CAMPAIGN_TAG_ROW_LIMIT).forEach((r) => {
    const campaignName = (r.campaignName || "").trim();
    const adGroup = ((r.tags || {})[AD_GROUP_TAG_KEY] || "").trim();
    const key = campaignKey(campaignName, adGroup);
    if (!map.has(key)) map.set(key, { key, campaignName, adGroup, rows: [], sources: new Set(), metrics: {} });
    const g = map.get(key);
    g.rows.push(r);
    if (r.source) g.sources.add(r.source);
    Object.entries(r.metrics || {}).forEach(([k, v]) => {
      const n = Number(v);
      if (isNaN(n)) return;
      g.metrics[k] = (g.metrics[k] || 0) + n;
    });
  });
  return Array.from(map.values()).map((g) => {
    const dimCounts = {};
    const chanCounts = {};
    g.rows.forEach((r) => {
      Object.entries(r.tags || {}).forEach(([dim, val]) => {
        if (!val || dim === AD_GROUP_TAG_KEY) return;
        if (dim === CHANNEL_TAG_KEY) {
          chanCounts[val] = (chanCounts[val] || 0) + 1;
          return;
        }
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
    const channelEntries = Object.entries(chanCounts).sort((a, b) => b[1] - a[1]);
    return { ...g, tags, conflicts, channel: channelEntries[0]?.[0] || "", periodCount: g.rows.length };
  });
}

// Sortable column header — same visual treatment as PaidHQ.jsx's own SH (Campaign Tagger's sortable
// headers): active column underlined, ▾/▴/⇅ indicator, no color change on active (per Mo's 2026-07-24
// note in that file — headers stay T.text regardless of sort state, the underline alone shows it).
function SH({ T, col, label, sortCol, sortDir, onSort, align }) {
  return (
    <span
      onClick={() => onSort(col)}
      style={{ fontFamily: T.font, fontSize: 11 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textDecoration: sortCol === col ? "underline" : "none", textUnderlineOffset: 2, cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 3, ...(align === "right" ? { justifyContent: "flex-end", width: "100%" } : {}) }}
    >
      {label}
      <span style={{ opacity: 0.7, fontSize: 9 * (T.fsScale || 1) }}>{sortCol === col ? (sortDir === "desc" ? "▾" : "▴") : "⇅"}</span>
    </span>
  );
}

// Cell width/flex per column type — used for BOTH the header row and every data row so the two stay
// aligned without a hand-maintained grid-template-columns string (which would need to change every
// time the column selection changes).
function colBoxStyle(col) {
  if (col.key === "campaignName") return { flex: "1.6 1 170px", minWidth: 150 };
  if (col.key === "adGroup") return { flex: "1.3 1 150px", minWidth: 130 };
  if (col.key === "channel") return { width: 140, flexShrink: 0 };
  return { width: 100, flexShrink: 0 }; // metric columns
}
const TAGS_BOX_STYLE = { flex: "1.8 1 200px", minWidth: 180 };

const fIn = { background: "transparent", border: "none", outline: "none", width: "100%" };

export default function ReportingFactsTagger({ T, session, workspace, campaignTags, tagDims, canEdit, refreshSignal, onBackToDataSources }) {
  const [rows, setRows] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [dimensionValues, setDimensionValues] = useState({ tagDims: [], values: {}, campaignName: [] });
  const [notif, setNotif] = useState(null); // {msg,type}
  const [applying, setApplying] = useState(false);
  const [undoStack, setUndoStack] = useState([]); // array of batches; each batch = [{id,tags}] pre-change snapshot

  const [columns, setColumns] = usePersistentState("paidhq_pipeline_tagger_columns", DEFAULT_COLUMNS);
  const [filtersOpen, setFiltersOpen] = usePersistentState("paidhq_pipeline_tagger_filtersOpen", true);
  const [sortCol, setSortCol] = usePersistentState("paidhq_pipeline_tagger_sortCol", "campaignName");
  const [sortDir, setSortDir] = usePersistentState("paidhq_pipeline_tagger_sortDir", "asc");

  const [fCampaignName, setFCampaignName] = usePersistentState("paidhq_pipeline_tagger_fCampaignName", "");
  const [fCampaignNameExclude, setFCampaignNameExclude] = usePersistentState("paidhq_pipeline_tagger_fCampaignNameExclude", "");
  const [fCampaignNameInclMode, setFCampaignNameInclMode] = usePersistentState("paidhq_pipeline_tagger_fCampaignNameInclMode", "or");
  const [fCampaignNameExclMode, setFCampaignNameExclMode] = usePersistentState("paidhq_pipeline_tagger_fCampaignNameExclMode", "or");
  const [fAdGroup, setFAdGroup] = usePersistentState("paidhq_pipeline_tagger_fAdGroup", "");
  const [fAdGroupExclude, setFAdGroupExclude] = usePersistentState("paidhq_pipeline_tagger_fAdGroupExclude", "");
  const [fAdGroupInclMode, setFAdGroupInclMode] = usePersistentState("paidhq_pipeline_tagger_fAdGroupInclMode", "or");
  const [fAdGroupExclMode, setFAdGroupExclMode] = usePersistentState("paidhq_pipeline_tagger_fAdGroupExclMode", "or");
  const [fChannel, setFChannel] = usePersistentState("paidhq_pipeline_tagger_fChannel", "");
  const [fTag, setFTag] = usePersistentState("paidhq_pipeline_tagger_fTag", "");
  const [fTagExclude, setFTagExclude] = usePersistentState("paidhq_pipeline_tagger_fTagExclude", "");
  const [fTagInclMode, setFTagInclMode] = usePersistentState("paidhq_pipeline_tagger_fTagInclMode", "or");
  const [fTagExclMode, setFTagExclMode] = usePersistentState("paidhq_pipeline_tagger_fTagExclMode", "or");
  const [fStatus, setFStatus] = usePersistentState("paidhq_pipeline_tagger_fStatus", "all");

  const [selected, setSelected] = useState(new Set()); // Set of group keys
  const [applyDim, setApplyDim] = useState("");
  const [applyVal, setApplyVal] = useState("");
  const [editingTag, setEditingTag] = useState(null); // {key, dim}
  const [editVal, setEditVal] = useState("");
  const [editingChannel, setEditingChannel] = useState(null); // group key
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

  const groups = useMemo(() => buildGroups(rows || []), [rows]);
  const rowsById = useMemo(() => new Map((rows || []).map((r) => [r.id, r])), [rows]);
  const visibleCols = useMemo(() => ALL_COLUMNS.filter((c) => c.required || columns.includes(c.key)), [columns]);
  const showAdGroup = visibleCols.some((c) => c.key === "adGroup");
  const showChannel = visibleCols.some((c) => c.key === "channel");
  const distinctChannels = useMemo(() => Array.from(new Set(groups.map((g) => g.channel).filter(Boolean))).sort(), [groups]);

  const doSort = (col) => {
    setSortDir(sortCol === col && sortDir === "desc" ? "asc" : "desc");
    setSortCol(col);
  };

  const filtered = useMemo(() => {
    const r = groups.filter((g) => {
      if (fCampaignName) {
        const terms = splitFilterTerms(fCampaignName);
        if (terms.length && !matchesTerms(g.campaignName.toLowerCase(), terms, fCampaignNameInclMode)) return false;
      }
      if (fCampaignNameExclude) {
        const terms = splitFilterTerms(fCampaignNameExclude);
        if (terms.length && matchesTerms(g.campaignName.toLowerCase(), terms, fCampaignNameExclMode)) return false;
      }
      if (showAdGroup) {
        if (fAdGroup) {
          const terms = splitFilterTerms(fAdGroup);
          if (terms.length && !matchesTerms(g.adGroup.toLowerCase(), terms, fAdGroupInclMode)) return false;
        }
        if (fAdGroupExclude) {
          const terms = splitFilterTerms(fAdGroupExclude);
          if (terms.length && matchesTerms(g.adGroup.toLowerCase(), terms, fAdGroupExclMode)) return false;
        }
      }
      if (showChannel && fChannel && g.channel !== fChannel) return false;
      if (fTag) {
        const s = Object.entries(g.tags).map(([d, v]) => `${d}:${v}`).join(" ").toLowerCase();
        const terms = splitFilterTerms(fTag);
        if (terms.length && !matchesTerms(s, terms, fTagInclMode)) return false;
      }
      if (fTagExclude) {
        const s = Object.entries(g.tags).map(([d, v]) => `${d}:${v}`).join(" ").toLowerCase();
        const terms = splitFilterTerms(fTagExclude);
        if (terms.length && matchesTerms(s, terms, fTagExclMode)) return false;
      }
      // Selected groups exempt from the tagged/untagged status filter mid multi-dimension tagging —
      // same reasoning as Campaign Tagger's own filtered memo (see its doc comment).
      if (!selected.has(g.key)) {
        const tagged = Object.keys(g.tags).length > 0;
        if (fStatus === "tagged" && !tagged) return false;
        if (fStatus === "untagged" && tagged) return false;
      }
      return true;
    });
    return [...r].sort((a, b) => {
      let av, bv;
      if (sortCol === "campaignName") { av = a.campaignName; bv = b.campaignName; }
      else if (sortCol === "adGroup") { av = a.adGroup; bv = b.adGroup; }
      else if (sortCol === "channel") { av = a.channel; bv = b.channel; }
      else if (sortCol === "tags") { av = Object.keys(a.tags).length; bv = Object.keys(b.tags).length; return sortDir === "asc" ? av - bv : bv - av; }
      else { av = a.metrics[sortCol] || 0; bv = b.metrics[sortCol] || 0; return sortDir === "asc" ? av - bv : bv - av; }
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [groups, fCampaignName, fCampaignNameExclude, fCampaignNameInclMode, fCampaignNameExclMode, fAdGroup, fAdGroupExclude, fAdGroupInclMode, fAdGroupExclMode, showAdGroup, fChannel, showChannel, fTag, fTagExclude, fTagInclMode, fTagExclMode, fStatus, selected, sortCol, sortDir]);

  const hasF = fCampaignName || fCampaignNameExclude || fAdGroup || fAdGroupExclude || fChannel || fTag || fTagExclude || fStatus !== "all";
  const clearF = () => {
    setFCampaignName(""); setFCampaignNameExclude("");
    setFAdGroup(""); setFAdGroupExclude("");
    setFChannel("");
    setFTag(""); setFTagExclude("");
    setFStatus("all");
  };

  const toggleSel = (key) => setSelected((p) => { const nx = new Set(p); nx.has(key) ? nx.delete(key) : nx.add(key); return nx; });
  const selAll = () => setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map((g) => g.key)));
  const toggleColumn = (key) => setColumns((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  // Shared apply path — every mutation (bulk apply, suggestion accept, inline edit, channel edit,
  // remove) funnels through here so undo/notif/local-state-sync stays in exactly one place.
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

  const applyDimToGroups = (dim, val, keys) => {
    if (!canEdit || !dim || !val || !keys.length) return;
    const updates = [];
    groups.filter((g) => keys.includes(g.key)).forEach((g) =>
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

  const bulkRemoveTag = (dim) => {
    if (!canEdit || !dim) return;
    const updates = [];
    groups.filter((g) => selected.has(g.key)).forEach((g) =>
      g.rows.forEach((r) => {
        if (!(r.tags || {})[dim]) return;
        const next = { ...r.tags };
        delete next[dim];
        updates.push({ id: r.id, tags: next });
      })
    );
    patchRows(updates, (result) => `Removed ${dim} from ${result.updated} row${result.updated === 1 ? "" : "s"}`);
  };

  const applyChannelToGroup = (group, value) => {
    if (!canEdit) return;
    const updates = group.rows
      .filter((r) => (r.tags || {})[CHANNEL_TAG_KEY] !== value)
      .map((r) => ({ id: r.id, tags: { ...(r.tags || {}), [CHANNEL_TAG_KEY]: value } }));
    patchRows(updates, (result) => `Set Channel: ${value} on ${result.updated} row${result.updated === 1 ? "" : "s"}`);
  };

  const saveInlineEdit = () => {
    if (!editingTag) return;
    const { key, dim } = editingTag;
    const v = editVal.trim();
    setEditingTag(null);
    setEditVal("");
    if (!v) return;
    applyDimToGroups(dim, v, [key]);
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

  // Permanently deletes a group's underlying reporting_facts rows — see this file's top doc comment
  // (DELETE section) for the confirmed "hits the real database" behavior and its one known edge case.
  const deleteGroup = async (group) => {
    if (!canEdit) return;
    const label = group.campaignName || group.adGroup || "this row";
    if (!window.confirm(`Permanently delete "${label}" (${group.rows.length} period${group.rows.length === 1 ? "" : "s"}) from the database?\n\nThis cannot be undone — you'd need to re-import to restore it.`)) return;
    setApplying(true);
    try {
      const filters = { campaignName: group.campaignName };
      if (group.adGroup) filters.tags = { [AD_GROUP_TAG_KEY]: group.adGroup };
      const result = await deleteReportingFacts(session, workspace.id, filters);
      const deletedIds = new Set(group.rows.map((r) => r.id));
      setRows((prev) => prev.filter((r) => !deletedIds.has(r.id)));
      setSelected((prev) => { const nx = new Set(prev); nx.delete(group.key); return nx; });
      showNotif(`Deleted ${result.deleted} row${result.deleted === 1 ? "" : "s"}`);
    } catch (err) {
      showNotif(err.message || "Delete failed", "error");
    } finally {
      setApplying(false);
    }
  };

  const bulkDeleteGroups = async () => {
    if (!canEdit || !selected.size) return;
    const targets = groups.filter((g) => selected.has(g.key));
    if (!window.confirm(`Permanently delete ${targets.length} row${targets.length === 1 ? "" : "s"} (${targets.reduce((s, g) => s + g.rows.length, 0)} total period${targets.reduce((s, g) => s + g.rows.length, 0) === 1 ? "" : "s"}) from the database?\n\nThis cannot be undone.`)) return;
    setApplying(true);
    try {
      let deleted = 0;
      for (const g of targets) {
        const filters = { campaignName: g.campaignName };
        if (g.adGroup) filters.tags = { [AD_GROUP_TAG_KEY]: g.adGroup };
        const result = await deleteReportingFacts(session, workspace.id, filters);
        deleted += result.deleted;
      }
      const deletedIds = new Set(targets.flatMap((g) => g.rows.map((r) => r.id)));
      setRows((prev) => prev.filter((r) => !deletedIds.has(r.id)));
      setSelected(new Set());
      showNotif(`Deleted ${deleted} row${deleted === 1 ? "" : "s"}`);
    } catch (err) {
      showNotif(err.message || "Delete failed", "error");
    } finally {
      setApplying(false);
    }
  };

  // Cross-match against Campaign Tagger's own tags (same tagging effort shouldn't have to happen
  // twice for a campaign you've already tagged for ad spend). Exact, case-insensitive match only,
  // against either half of a campaignKey — checked against BOTH this group's Campaign Name and its
  // Ad Group/Ad Set Name (spend rows' own two-level identity), never fuzzy/substring.
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
      if (dismissedSuggestions.has(group.key)) return null;
      const match = campaignTagLookup.get(group.campaignName.trim().toLowerCase()) || campaignTagLookup.get(group.adGroup.trim().toLowerCase());
      if (!match) return null;
      const missing = Object.entries(match.tags).filter(([dim, val]) => val && !group.tags[dim]);
      if (!missing.length) return null;
      return { ...match, missing };
    },
    [campaignTagLookup, dismissedSuggestions]
  );

  const suggestions = useMemo(
    () => filtered.map((g) => ({ group: g, s: suggestFor(g) })).filter((x) => x.s).slice(0, 6),
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
        if (!merged[dim]) { merged[dim] = val; changed = true; }
      });
      if (changed) updates.push({ id: r.id, tags: merged });
    });
    patchRows(updates, (result) => `Applied ${s.missing.length} tag${s.missing.length === 1 ? "" : "s"} from "${group.campaignName || group.adGroup}"'s matched ad campaign to ${result.updated} row${result.updated === 1 ? "" : "s"}`);
    setDismissedSuggestions((p) => new Set(p).add(group.key));
  };

  if (rows === null && !loadError) {
    return <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading…</div>;
  }

  if (groups.length === 0 && !loadError) {
    return (
      <div style={{ padding: "40px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>
        Nothing imported yet — bring in a file above first.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      {loadError && (
        <div style={{ padding: "9px 16px", background: T.dangerBg, borderBottom: `1px solid ${T.dangerBorder}`, fontSize: 12 * (T.fsScale || 1), color: T.danger, flexShrink: 0 }}>{loadError}</div>
      )}
      {notif && (
        <div style={{ padding: "9px 16px", borderBottom: `1px solid ${T.border}`, fontSize: 12 * (T.fsScale || 1), background: notif.type === "error" ? T.dangerBg : T.successBg, color: notif.type === "error" ? T.danger : T.success, flexShrink: 0 }}>{notif.msg}</div>
      )}

      {suggestions.length > 0 && (
        <div style={{ padding: "7px 16px", background: T.accentBg, borderBottom: `1px solid ${T.border}`, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>
          <span style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: T.text }}>Suggest</span>
          {suggestions.map(({ group, s }) => (
            <button key={group.key} onClick={() => applySuggestion(group)} disabled={!canEdit || applying}
              style={{ fontSize: 12 * (T.fsScale || 1), background: T.surface, border: `1px solid ${T.border}`, color: T.text, borderRadius: T.r14, padding: "3px 10px", cursor: canEdit ? "pointer" : "default", fontFamily: T.font, fontWeight: 500 }}>
              "{group.campaignName || group.adGroup}" matches a tagged ad campaign — apply {s.missing.length} tag{s.missing.length === 1 ? "" : "s"}
            </button>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div style={{ padding: "8px 16px", background: T.surface, borderBottom: `1px solid ${T.border}`, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>
          <Pill color={T.text} bg={T.accent} border={T.text}>{selected.size} selected</Pill>
          {canEdit && (
            <>
              <span style={{ color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>→</span>
              <Sel value={applyDim} onChange={setApplyDim} T={T} style={{ width: 130, fontSize: 12 * (T.fsScale || 1) }}>
                <option value="">Dimension…</option>
                {(tagDims || []).map((d) => <option key={d} value={d}>{d}</option>)}
              </Sel>
              <TagAutocompleteInput T={T} value={applyVal} onChange={setApplyVal} suggestions={dimensionValues.values?.[applyDim] || []}
                onEnter={() => { applyDimToGroups(applyDim, applyVal.trim(), Array.from(selected)); setApplyVal(""); }}
                placeholder="Tag value…" style={{ width: 130 }}
                inputStyle={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r7, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
              <Btn onClick={() => { applyDimToGroups(applyDim, applyVal.trim(), Array.from(selected)); setApplyVal(""); }} disabled={!applyDim || !applyVal.trim()} variant="primary" size="sm" T={T}>Apply</Btn>
              <Btn onClick={() => bulkRemoveTag(applyDim)} disabled={!applyDim} variant="danger" size="sm" T={T}>Remove</Btn>
              <div style={{ width: 1, height: 16, background: T.border }} />
              <Btn onClick={bulkDeleteGroups} variant="danger" size="sm" T={T} title="Permanently delete these rows from the database">Delete from database</Btn>
            </>
          )}
          <Btn onClick={() => setSelected(new Set())} variant="ghost" size="sm" T={T}>Clear</Btn>
          <div style={{ marginLeft: "auto" }}>
            <Btn onClick={undoLast} disabled={!undoStack.length} variant="ghost" size="sm" T={T} title="Undo last tag action">↩ Undo {undoStack.length > 0 && `(${undoStack.length})`}</Btn>
          </div>
        </div>
      )}

      <div style={{ borderBottom: `1px solid ${T.border}`, background: T.surfaceEl, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px 0", flexWrap: "wrap" }}>
          <button onClick={() => setFiltersOpen((o) => !o)} title={filtersOpen ? "Hide filters" : "Show filters"}
            style={{ display: "flex", alignItems: "center", gap: 5, background: filtersOpen ? T.surfaceHover : "transparent", border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "3px 8px", cursor: "pointer", fontFamily: T.font, fontSize: 11 * (T.fsScale || 1), fontWeight: 600, color: T.text, outline: "none" }}>
            <Icon name="filter" size={12} color={T.text} />
            Filters
            {hasF && <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.accent, flexShrink: 0 }} />}
          </button>
          {!filtersOpen && hasF && <button onClick={clearF} style={{ background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, textDecoration: "underline", padding: 0, outline: "none" }}>Clear filters</button>}
          <div style={{ width: 1, height: 16, background: T.border }} />
          <span style={{ fontSize: 10 * (T.fsScale || 1), color: T.textMuted, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>Columns:</span>
          {ALL_COLUMNS.filter((c) => !c.required).map((c) => {
            const on = columns.includes(c.key);
            return (
              <button key={c.key} onClick={() => toggleColumn(c.key)}
                style={{ fontSize: 11 * (T.fsScale || 1), background: on ? T.accentBg : "transparent", border: `1px solid ${on ? T.accentBorder : T.border}`, color: on ? T.text : T.textMuted, borderRadius: T.r14, padding: "2px 9px", cursor: "pointer", fontFamily: T.font, fontWeight: 500 }}>
                {c.label}
              </button>
            );
          })}
          <div style={{ marginLeft: "auto" }}>
            {onBackToDataSources && <Btn onClick={onBackToDataSources} variant="ghost" size="sm" T={T}>← Back to Data Sources</Btn>}
          </div>
        </div>

        <div style={{ display: "flex", padding: "11px 16px 5px", alignItems: "end", gap: 8, background: T.headerBg }}>
          <div style={{ width: 22, flexShrink: 0 }}>
            <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={selAll} style={{ cursor: "pointer", accentColor: T.accent, width: 14, height: 14 }} />
          </div>
          {visibleCols.map((c) => (
            <div key={c.key} style={colBoxStyle(c)}>
              <SH T={T} col={c.key} label={c.label} sortCol={sortCol} sortDir={sortDir} onSort={doSort} align={c.type === "metric" ? "right" : undefined} />
            </div>
          ))}
          <div style={{ ...TAGS_BOX_STYLE, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <SH T={T} col="tags" label="Tags" sortCol={sortCol} sortDir={sortDir} onSort={doSort} />
          </div>
          <div style={{ width: 22, flexShrink: 0 }} />
        </div>

        {filtersOpen && (
          <div style={{ display: "flex", padding: "3px 16px 10px", gap: 8, alignItems: "start", flexWrap: "wrap" }}>
            <div style={{ width: 22, flexShrink: 0 }} />
            {visibleCols.map((c) => {
              if (c.key === "campaignName") {
                return (
                  <div key={c.key} style={{ ...colBoxStyle(c), display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", gap: 3 }}>
                      <IconField icon="search" color={T.textMuted}>
                        <input value={fCampaignName} onChange={(e) => setFCampaignName(e.target.value)} placeholder="Campaign contains… (a, b)" style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px 6px 26px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      </IconField>
                      <MatchModeToggle mode={fCampaignNameInclMode} onChange={setFCampaignNameInclMode} T={T} />
                    </div>
                    <div style={{ display: "flex", gap: 3 }}>
                      <input value={fCampaignNameExclude} onChange={(e) => setFCampaignNameExclude(e.target.value)} placeholder="≠ excludes… (a, b)" style={{ ...fIn, flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      <MatchModeToggle mode={fCampaignNameExclMode} onChange={setFCampaignNameExclMode} T={T} />
                    </div>
                  </div>
                );
              }
              if (c.key === "adGroup") {
                return (
                  <div key={c.key} style={{ ...colBoxStyle(c), display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", gap: 3 }}>
                      <IconField icon="search" color={T.textMuted}>
                        <input value={fAdGroup} onChange={(e) => setFAdGroup(e.target.value)} placeholder="Ad Group contains… (a, b)" style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px 6px 26px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      </IconField>
                      <MatchModeToggle mode={fAdGroupInclMode} onChange={setFAdGroupInclMode} T={T} />
                    </div>
                    <div style={{ display: "flex", gap: 3 }}>
                      <input value={fAdGroupExclude} onChange={(e) => setFAdGroupExclude(e.target.value)} placeholder="≠ excludes… (a, b)" style={{ ...fIn, flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                      <MatchModeToggle mode={fAdGroupExclMode} onChange={setFAdGroupExclMode} T={T} />
                    </div>
                  </div>
                );
              }
              if (c.key === "channel") {
                return (
                  <div key={c.key} style={colBoxStyle(c)}>
                    <select value={fChannel} onChange={(e) => setFChannel(e.target.value)} style={{ width: "100%", cursor: "pointer", border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text, fontFamily: T.font }}>
                      <option value="">All channels</option>
                      {distinctChannels.map((ch) => <option key={ch} value={ch}>{ch}</option>)}
                    </select>
                  </div>
                );
              }
              return <div key={c.key} style={colBoxStyle(c)} />; // metric columns — sortable only, no filter UI
            })}
            <div style={{ ...TAGS_BOX_STYLE, display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", gap: 4 }}>
                <IconField icon="search" color={T.textMuted}>
                  <input value={fTag} onChange={(e) => setFTag(e.target.value)} placeholder="Tag contains… (a, b)" style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px 6px 26px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                </IconField>
                <MatchModeToggle mode={fTagInclMode} onChange={setFTagInclMode} T={T} />
                <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} style={{ width: 120, cursor: "pointer", border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text, fontFamily: T.font }}>
                  <option value="all">All</option>
                  <option value="tagged">Tagged</option>
                  <option value="untagged">Needs review</option>
                </select>
                {hasF && <button onClick={clearF} style={{ background: T.dangerBg, border: `1px solid ${T.danger}`, color: T.danger, borderRadius: T.r6, padding: "0 8px", cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, whiteSpace: "nowrap" }}>Clear ×</button>}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <input value={fTagExclude} onChange={(e) => setFTagExclude(e.target.value)} placeholder="≠ tag excludes… (a, b)" style={{ ...fIn, flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                <MatchModeToggle mode={fTagExclMode} onChange={setFTagExclMode} T={T} />
              </div>
            </div>
            <div style={{ width: 22, flexShrink: 0 }} />
          </div>
        )}
      </div>

      <div style={{ overflow: "auto", flex: 1 }}>
        {filtered.map((g) => {
          const isSel = selected.has(g.key);
          const tc = Object.keys(g.tags).length;
          const orderedDims = [...(tagDims || []).filter((d) => Object.prototype.hasOwnProperty.call(g.tags, d)), ...Object.keys(g.tags).filter((d) => !(tagDims || []).includes(d) && !RESERVED_TAG_KEYS.has(d))];
          const chanColor = PLATFORM_COLORS[g.channel] || T.textMuted;
          return (
            <div key={g.key} className={isSel ? undefined : "bhq-row"} onClick={() => toggleSel(g.key)}
              style={{ display: "flex", padding: "11px 16px", borderBottom: `1px solid ${T.border}`, alignItems: "center", cursor: "pointer", background: isSel ? T.rowSelected : T.surface, transition: "background 0.1s", gap: 8 }}>
              <div style={{ width: 22, flexShrink: 0 }}>
                <input type="checkbox" checked={isSel} onChange={() => toggleSel(g.key)} onClick={(e) => e.stopPropagation()} style={{ cursor: "pointer", accentColor: T.accent, width: 14, height: 14 }} />
              </div>
              {visibleCols.map((c) => {
                if (c.key === "campaignName") {
                  return (
                    <div key={c.key} style={{ ...colBoxStyle(c), display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <span title={tc > 0 ? "Tagged" : "Needs review"} style={{ width: 9, height: 9, borderRadius: "50%", background: tc > 0 ? T.accent : "#A1A1AA", flexShrink: 0 }} />
                      <span title={g.campaignName} style={{ minWidth: 0, fontSize: 13 * (T.fsScale || 1), fontWeight: 400, fontFamily: T.font, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {g.campaignName || "(no campaign)"}
                      </span>
                    </div>
                  );
                }
                if (c.key === "adGroup") {
                  return (
                    <div key={c.key} title={g.adGroup} style={{ ...colBoxStyle(c), fontSize: 13 * (T.fsScale || 1), fontWeight: 400, fontFamily: T.font, color: g.adGroup ? T.text : T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.adGroup || "—"}
                    </div>
                  );
                }
                if (c.key === "channel") {
                  return (
                    <div key={c.key} style={colBoxStyle(c)} onClick={(e) => e.stopPropagation()}>
                      {editingChannel === g.key ? (
                        <select autoFocus value={g.channel} onChange={(e) => { if (!canEdit) return; applyChannelToGroup(g, e.target.value); setEditingChannel(null); }} onBlur={() => setEditingChannel(null)}
                          style={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r5, color: T.text, fontSize: 13 * (T.fsScale || 1), padding: "2px 6px", outline: "none", fontFamily: T.font, cursor: "pointer" }}>
                          <option value="">—</option>
                          {PLATFORM_OPTIONS.filter((p) => p !== "auto").map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      ) : g.channel ? (
                        <span onClick={() => canEdit && setEditingChannel(g.key)} title={canEdit ? "Click to change channel" : "View-only access"}
                          style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13 * (T.fsScale || 1), fontWeight: 400, padding: "3px 8px", borderRadius: T.r6, background: chanColor + "14", color: chanColor, border: `1px solid ${chanColor}55`, whiteSpace: "nowrap", cursor: canEdit ? "pointer" : "default" }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: chanColor, flexShrink: 0 }} />
                          {g.channel}
                        </span>
                      ) : (
                        <span onClick={() => canEdit && setEditingChannel(g.key)} style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, cursor: canEdit ? "pointer" : "default" }}>— set channel</span>
                      )}
                    </div>
                  );
                }
                // Metric column — summed value, right-aligned, matching this key's money formatting.
                return (
                  <div key={c.key} style={{ ...colBoxStyle(c), textAlign: "right", fontSize: 13 * (T.fsScale || 1), fontFamily: T.font, fontWeight: 400, color: T.text }}>
                    {fmtMetric(g.metrics[c.key], c.money)}
                  </div>
                );
              })}
              <div style={{ ...TAGS_BOX_STYLE, display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                {tc === 0 ? (
                  <Pill color={T.text} bg={T.surfaceEl} border={T.border} style={{ fontFamily: T.font, fontSize: 13 * (T.fsScale || 1), fontWeight: 400, borderRadius: T.r6 }}>needs review</Pill>
                ) : (
                  orderedDims.map((dim) => {
                    const val = g.tags[dim];
                    const dimIdx = (tagDims || []).indexOf(dim);
                    const dc = TAG_DIM_COLORS[(dimIdx >= 0 ? dimIdx : 0) % TAG_DIM_COLORS.length];
                    const conflicted = g.conflicts.has(dim);
                    return (
                      <span key={dim} style={{ display: "inline-flex", alignItems: "center", fontSize: 13 * (T.fsScale || 1), fontWeight: 400, padding: "2px 4px 2px 8px", borderRadius: T.r6, background: dc + "14", color: dc, border: `1px solid ${dc}40`, gap: 2, fontFamily: T.font }}>
                        <span style={{ opacity: 0.75, marginRight: 1 }}>{dim}:</span>
                        {editingTag?.key === g.key && editingTag?.dim === dim ? (
                          <TagAutocompleteInput T={T} autoFocus value={editVal} onChange={setEditVal} suggestions={dimensionValues.values?.[dim] || []}
                            onEnter={saveInlineEdit} onEscape={() => { setEditingTag(null); setEditVal(""); }} onBlur={saveInlineEdit}
                            style={{ width: Math.max(60, editVal.length * 7 + 20) + "px" }}
                            inputStyle={{ background: "transparent", border: "none", outline: "none", color: T.text, fontSize: 13 * (T.fsScale || 1), fontWeight: 400, width: "100%", fontFamily: T.font, padding: 0 }} />
                        ) : (
                          <span onClick={(e) => { e.stopPropagation(); if (!canEdit) return; setEditingTag({ key: g.key, dim }); setEditVal(val); }} title={conflicted ? "This campaign's stored periods don't all agree on this dimension — click to set one value for all of them." : undefined} style={{ cursor: canEdit ? "text" : "default", fontWeight: 400 }}>{val}</span>
                        )}
                        {canEdit && <span onClick={(e) => { e.stopPropagation(); removeDimFromGroup(g, dim); }} style={{ color: T.textMuted, cursor: "pointer", fontSize: 13 * (T.fsScale || 1), lineHeight: 1, marginLeft: 1, padding: "0 2px" }}>×</span>}
                      </span>
                    );
                  })
                )}
              </div>
              <div style={{ width: 22, flexShrink: 0, display: "flex", justifyContent: "center" }}>
                {canEdit && (
                  <button onClick={(e) => { e.stopPropagation(); deleteGroup(g); }} disabled={applying} title="Permanently delete this row from the database"
                    style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "1px solid transparent", borderRadius: T.r5, color: T.textMuted, cursor: "pointer", fontSize: 12 * (T.fsScale || 1), lineHeight: 1, padding: 0, opacity: 0.4, transition: "all 0.1s" }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; e.currentTarget.style.border = `1px solid ${T.danger}`; e.currentTarget.style.color = T.danger; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = 0.4; e.currentTarget.style.border = "1px solid transparent"; e.currentTarget.style.color = T.textMuted; }}>✕</button>
                )}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: "40px 20px 52px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>
            No rows match your filters. {hasF && <span onClick={clearF} style={{ color: T.text, cursor: "pointer", marginLeft: 6, fontWeight: 400, textDecoration: "underline" }}>Clear filters</span>}
          </div>
        )}
      </div>
    </div>
  );
}
