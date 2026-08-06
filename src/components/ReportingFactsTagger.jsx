import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Btn, Icon, Pill, Sel, TagAutocompleteInput, MatchModeToggle, IconField, SectionLabel, Divider, StatRow, PixelPanel } from "./shared.jsx";
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
//
// PARAMETERIZED BY metricOptions (2026-08-19 bugfix — found investigating "MQLs coming in blank" for
// Goals & Objectives): this used to be a MODULE-LEVEL constant built off PIPELINE_METRIC_MAP_OPTIONS
// unconditionally — fine for the pipeline instance, but GoalsObjectives.jsx's rows are written by
// GoalsImportWizard.jsx under GOAL_METRIC_MAP_OPTIONS' "_goal"-suffixed keys (mqls_goal, spend_goal,
// ...), deliberately never plain "mqls"/"spend" (see that constant's own doc comment — keeps a goal
// number from ever colliding with real pipeline performance data). A goals import was landing real
// data in the database the whole time; this component was just never told to look for the "_goal"
// keys the rows actually used, so every metric column read as blank for every row. Now a function of
// the metricOptions prop (still defaults to PIPELINE_METRIC_MAP_OPTIONS — every existing pipeline call
// site unaffected), computed once per render inside the component below.
function buildColumns(metricOptions) {
  const metricColumns = (metricOptions || PIPELINE_METRIC_MAP_OPTIONS).map((m) => ({ key: m.key, label: m.label, type: "metric", money: isMoneyMetric(m.key) }));
  const allColumns = [
    { key: "campaignName", label: "Campaign Name", type: "text", required: true },
    { key: "adGroup", label: "Ad Group/Ad Set Name", type: "text" },
    { key: "channel", label: "Channel", type: "channel" },
    ...metricColumns,
  ];
  return { allColumns, defaultColumns: allColumns.map((c) => c.key) };
}

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

// --- Merge Campaign Names: fuzzy-matching helpers ------------------------------------------------
// (2026-08-05, per Mo — Google/Bing import the same real campaign under two different naming
// conventions: ad-platform-native rows ("BIN-...") carry spend/leads, UTM-based rows ("SEA-...")
// carry MQLs/SQLs/pipeline, so they never land on the same aggregated campaign_name and cost-per-
// lead / pipeline-per-dollar can't be computed. There's no stable campaign ID anywhere in this
// schema (see this file's top doc comment) — campaign_name is plain text, so the only fix is
// renaming one side's campaign_name to match the other. Per Mo, confirmed via direct question: the
// remainder after stripping each name's own prefix is "mostly [identical], with some variation", so
// suggestions need fuzzy/approximate matching rather than an exact-string match — and per the
// codebase's standing rule ("a false positive is worse than asking"), suggestions are NEVER
// auto-applied; every group requires an explicit human "keep this name" choice before Apply does
// anything (see the modal below).

// Classic iterative Levenshtein edit distance (single-row DP, O(min(len)) memory footprint).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

// 0..1 similarity (1 = identical, 0 = completely different), normalized by the longer string's
// length so e.g. "brand-search" vs "brand-search-2026" doesn't get unfairly punished for length.
function nameSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Strips a leading "PREFIX-" / "PREFIX_" / "PREFIX " token (the ad-platform-vs-UTM naming-convention
// prefix, e.g. "BIN-" / "SEA-") so two names that only differ by that prefix compare as near-
// identical. Falls back to the full (lowercased, trimmed) name if there's no separator to split on.
function splitCampaignName(name) {
  const s = (name || "").trim();
  const m = s.match(/^([^-_\s]+)[-_\s]+(.+)$/);
  return { prefix: m ? m[1] : "", remainder: (m ? m[2] : s).toLowerCase().trim() };
}

// Similarity floor for auto-suggesting two names as "probably the same real campaign" — high enough
// to avoid false positives (see this section's doc comment) while tolerating the "some variation"
// Mo confirmed exists between the two naming conventions in practice.
const MERGE_SIMILARITY_THRESHOLD = 0.72;

// Clusters distinct campaign names whose PREFIX differs but whose REMAINDER (everything after the
// first prefix separator) is a close match — the auto-suggestion engine behind the Merge Campaign
// Names modal. Only compares names with DIFFERENT prefixes (two names sharing one prefix already
// aggregate together fine via buildGroups above) and clusters against a single anchor name per group
// — deliberately simple (no real clustering library), which is plenty at the scale of one
// workspace's distinct campaign-name list, and every cluster is still just a SUGGESTION the user
// reviews/edits before anything is renamed.
function suggestCampaignNameGroups(distinctNames) {
  const parsed = distinctNames.map((name) => ({ name, ...splitCampaignName(name) }));
  const used = new Set();
  const groups = [];
  for (let i = 0; i < parsed.length; i++) {
    if (used.has(parsed[i].name)) continue;
    const cluster = [parsed[i]];
    for (let j = i + 1; j < parsed.length; j++) {
      if (used.has(parsed[j].name)) continue;
      if (parsed[i].prefix && parsed[i].prefix === parsed[j].prefix) continue; // already aggregates together
      if (nameSimilarity(parsed[i].remainder, parsed[j].remainder) >= MERGE_SIMILARITY_THRESHOLD) cluster.push(parsed[j]);
    }
    if (cluster.length > 1) {
      cluster.forEach((c) => used.add(c.name));
      groups.push(cluster.map((c) => c.name));
    }
  }
  return groups;
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
//
// FIXED, NON-SHRINKING widths (2026-08-04, per Mo — "there's not much room ... everything is cut
// off, all of the rows are basically too small ... increase the sizes and make them relative to the
// content ... allow the user to scroll to the right as much as what's needed"): every column used to
// carry a shrink factor (flex:"1.6 1 170px" etc.) so the whole row would compress to fit whatever
// width the pane happened to have — fine with 2-3 columns visible, unreadable once most of
// ALL_COLUMNS were toggled on. flexShrink:0 here means a column can never compress below its own
// number; once the row's total width exceeds the pane, the wrapping scroll region below (see this
// file's own "share ONE horizontally-scrollable region" comment) scrolls horizontally instead of
// squeezing every cell. Widths themselves are sized per column TYPE rather than one flat number —
// money metrics get more room than plain counts (bigger numbers, "$" + thousands separators), and
// Campaign/Ad Group/Channel get enough room to show a realistic label without truncating immediately.
function colBoxStyle(col) {
  if (col.key === "campaignName") return { width: 260, flexShrink: 0 };
  if (col.key === "adGroup") return { width: 200, flexShrink: 0 };
  if (col.key === "channel") return { width: 150, flexShrink: 0 };
  return { width: col.money ? 130 : 110, flexShrink: 0 }; // metric columns
}
// Tags is the one column allowed to GROW (flex-grow:1) past its own minimum — when every other
// column's fixed widths don't already fill the pane, Tags absorbs the leftover space instead of
// leaving a dead gap; flexShrink stays 0 so it never gets crushed below a usable width either.
const TAGS_BOX_STYLE = { flex: "1 0 260px", minWidth: 260 };

const fIn = { background: "transparent", border: "none", outline: "none", width: "100%" };

// GENERALIZED FOR GOALS & OBJECTIVES (2026-08-19, per Mo — "build the goals & objectives import
// like we've done with campaign spend and pipeline import... tag them with similar dimensions and
// tags"): this component used to be pipeline-only (implicitly, by never filtering source at all —
// it read and displayed EVERY core.reporting_facts row, goals-sourced or not, undifferentiated).
// Now takes three optional params so GoalsObjectives.jsx can reuse this exact grid/tagging engine
// scoped to just its own rows, instead of either mixing goals into Pipeline Tagger's view or forking
// a second ~700-line copy of this file:
//   - sourceFilter(source): predicate applied to each row's `source` field at fetch time. Undefined
//     (every existing pipeline call site) means no filtering — unchanged behavior. GoalsObjectives
//     passes one that matches its own "goals"-prefixed sources; a generalized ReportingAnalyzer (see
//     that file's own doc note) passes the inverse so Pipeline's browse grid stops showing goals rows
//     now that goals import is a real, populated flow rather than a rare edge case.
//   - datasetLabel: the sidebar title text (defaults to "Pipeline Tagger", the original hardcoded
//     string) — "Goals & Objectives" for the goals instance.
//   - storageKeyPrefix: every usePersistentState key below (columns/filters/sort) is now built via
//     the local k() helper off this prefix (defaults to "paidhq_pipeline_tagger_", preserving every
//     existing pipeline user's already-saved localStorage prefs verbatim) — WITHOUT this, a goals
//     instance and the pipeline instance would silently share the same column/filter/sort state,
//     since both would otherwise read/write the exact same localStorage keys. GoalsObjectives passes
//     "paidhq_goals_tagger_" so the two tabs' UI preferences stay fully independent.
export default function ReportingFactsTagger({ T, session, workspace, tagDims, canEdit, refreshSignal, onBackToDataSources, sidebarEl, sourceFilter, datasetLabel = "Pipeline Tagger", storageKeyPrefix = "paidhq_pipeline_tagger_", metricOptions = PIPELINE_METRIC_MAP_OPTIONS }) {
  const k = (suffix) => `${storageKeyPrefix}${suffix}`;
  // See buildColumns's own doc comment above for why this is a function of metricOptions rather than
  // the module-level constant it used to be.
  const { allColumns: ALL_COLUMNS, defaultColumns: DEFAULT_COLUMNS } = useMemo(() => buildColumns(metricOptions), [metricOptions]);
  const [rows, setRows] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [dimensionValues, setDimensionValues] = useState({ tagDims: [], values: {}, campaignName: [] });
  const [notif, setNotif] = useState(null); // {msg,type}
  const [applying, setApplying] = useState(false);
  const [undoStack, setUndoStack] = useState([]); // array of batches; each batch = [{id,tags}] pre-change snapshot

  const [columns, setColumns] = usePersistentState(k("columns"), DEFAULT_COLUMNS);
  const [filtersOpen, setFiltersOpen] = usePersistentState(k("filtersOpen"), true);
  const [sortCol, setSortCol] = usePersistentState(k("sortCol"), "campaignName");
  const [sortDir, setSortDir] = usePersistentState(k("sortDir"), "asc");

  const [fCampaignName, setFCampaignName] = usePersistentState(k("fCampaignName"), "");
  const [fCampaignNameExclude, setFCampaignNameExclude] = usePersistentState(k("fCampaignNameExclude"), "");
  const [fCampaignNameInclMode, setFCampaignNameInclMode] = usePersistentState(k("fCampaignNameInclMode"), "or");
  const [fCampaignNameExclMode, setFCampaignNameExclMode] = usePersistentState(k("fCampaignNameExclMode"), "or");
  const [fAdGroup, setFAdGroup] = usePersistentState(k("fAdGroup"), "");
  const [fAdGroupExclude, setFAdGroupExclude] = usePersistentState(k("fAdGroupExclude"), "");
  const [fAdGroupInclMode, setFAdGroupInclMode] = usePersistentState(k("fAdGroupInclMode"), "or");
  const [fAdGroupExclMode, setFAdGroupExclMode] = usePersistentState(k("fAdGroupExclMode"), "or");
  const [fChannel, setFChannel] = usePersistentState(k("fChannel"), "");
  const [fTag, setFTag] = usePersistentState(k("fTag"), "");
  const [fTagExclude, setFTagExclude] = usePersistentState(k("fTagExclude"), "");
  const [fTagInclMode, setFTagInclMode] = usePersistentState(k("fTagInclMode"), "or");
  const [fTagExclMode, setFTagExclMode] = usePersistentState(k("fTagExclMode"), "or");
  const [fStatus, setFStatus] = usePersistentState(k("fStatus"), "all");

  const [selected, setSelected] = useState(new Set()); // Set of group keys
  const [applyDim, setApplyDim] = useState("");
  const [applyVal, setApplyVal] = useState("");
  const [editingTag, setEditingTag] = useState(null); // {key, dim}
  const [editVal, setEditVal] = useState("");
  const [editingChannel, setEditingChannel] = useState(null); // group key

  // Merge Campaign Names modal state (2026-08-05, per Mo — see the fuzzy-matching helpers above).
  // mergeGroups: [{ id, names: [campaignName,...], canonical: "" | campaignName }] — canonical starts
  // BLANK even for auto-suggested groups (no auto-default — every group needs an explicit human
  // "keep this name" choice, per the "false positive is worse than asking" rule).
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeGroups, setMergeGroups] = useState([]);
  const [mergeAddSel, setMergeAddSel] = useState({}); // {[groupId]: pending value of that group's "+ add name" select}

  const showNotif = (msg, type = "success") => {
    setNotif({ msg, type });
    setTimeout(() => setNotif(null), type === "error" ? 6000 : 3000);
  };

  const refresh = useCallback(() => {
    listReportingFacts(session, workspace.id)
      .then((r) => {
        setRows(sourceFilter ? r.filter((row) => sourceFilter(row.source || "")) : r);
        setLoadError("");
      })
      .catch((err) => setLoadError(err.message || `Couldn't load ${datasetLabel.toLowerCase()} data.`));
  }, [session, workspace.id, sourceFilter, datasetLabel]);

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
  // The `columns.includes(c.key.replace(...))` fallback (2026-08-19, alongside the metricOptions fix
  // above) is backward compat for anyone who already toggled metric columns on in the Goals instance
  // before this fix shipped — their persisted `columns` array holds the OLD plain keys ("mqls"), which
  // no longer match ALL_COLUMNS' now-correct "_goal"-suffixed keys ("mqls_goal"). Without this, every
  // metric column they'd already selected would silently vanish from view instead of just starting to
  // show real data. Harmless no-op for the pipeline instance, where keys were never suffixed to begin
  // with (the replace is a no-op there).
  const visibleCols = useMemo(
    () => ALL_COLUMNS.filter((c) => c.required || columns.includes(c.key) || columns.includes(c.key.replace(/_goal$/, ""))),
    [ALL_COLUMNS, columns]
  );
  const showAdGroup = visibleCols.some((c) => c.key === "adGroup");
  const showChannel = visibleCols.some((c) => c.key === "channel");
  const distinctChannels = useMemo(() => Array.from(new Set(groups.map((g) => g.channel).filter(Boolean))).sort(), [groups]);
  const taggedCount = useMemo(() => groups.filter((g) => Object.keys(g.tags).length > 0).length, [groups]);
  const untaggedCount = groups.length - taggedCount;

  // Every distinct campaign_name in the raw (ungrouped) dataset, with its row count — the universe
  // Merge Campaign Names' suggestion engine and manual group builder both draw from. Deliberately
  // built from `rows` rather than `groups` (which are keyed by Campaign+Ad Group) since a rename here
  // targets campaign_name alone, regardless of how many distinct ad groups ride under it.
  const distinctCampaignNames = useMemo(() => {
    const counts = new Map();
    (rows || []).forEach((r) => {
      const name = (r.campaignName || "").trim();
      if (!name) return;
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    return Array.from(counts.entries()).map(([name, rowCount]) => ({ name, rowCount })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const mergeUsedNames = useMemo(() => new Set(mergeGroups.flatMap((g) => g.names)), [mergeGroups]);

  const openMergeModal = () => {
    const suggested = suggestCampaignNameGroups(distinctCampaignNames.map((d) => d.name));
    setMergeGroups(suggested.map((names, i) => ({ id: `sugg-${i}`, names, canonical: "" })));
    setMergeAddSel({});
    setMergeModalOpen(true);
  };

  const addManualMergeGroup = () => setMergeGroups((g) => [...g, { id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, names: [], canonical: "" }]);
  const removeMergeGroup = (id) => setMergeGroups((g) => g.filter((grp) => grp.id !== id));
  const addNameToMergeGroup = (id, name) => {
    if (!name) return;
    setMergeGroups((g) => g.map((grp) => (grp.id === id && !grp.names.includes(name) ? { ...grp, names: [...grp.names, name] } : grp)));
    setMergeAddSel((s) => ({ ...s, [id]: "" }));
  };
  const removeNameFromMergeGroup = (id, name) => setMergeGroups((g) => g.map((grp) => (grp.id === id ? { ...grp, names: grp.names.filter((n) => n !== name), canonical: grp.canonical === name ? "" : grp.canonical } : grp)));
  const setMergeGroupCanonical = (id, name) => setMergeGroups((g) => g.map((grp) => (grp.id === id ? { ...grp, canonical: name } : grp)));

  const mergeApplicableGroups = mergeGroups.filter((g) => g.names.length >= 2 && g.canonical && g.names.includes(g.canonical));
  const mergeIncompleteCount = mergeGroups.filter((g) => g.names.length >= 2 && !g.canonical).length;

  // Applies every completed group (>=2 names AND an explicit canonical choice) — groups still missing
  // a canonical choice are silently left out of this batch (their note in the modal explains why) so
  // Apply never renames anything the user hasn't explicitly confirmed. Reuses patchRows so undo,
  // notification, and local-state sync all get the same treatment as every other mutation in this file.
  const applyMerge = () => {
    if (!canEdit || !mergeApplicableGroups.length) return;
    const updates = [];
    mergeApplicableGroups.forEach((g) => {
      const losing = new Set(g.names.filter((n) => n !== g.canonical));
      (rows || []).forEach((r) => {
        if (losing.has((r.campaignName || "").trim())) updates.push({ id: r.id, campaignName: g.canonical });
      });
    });
    if (!updates.length) return;
    const n = mergeApplicableGroups.length;
    patchRows(updates, (result) => `Merged ${n} campaign name group${n === 1 ? "" : "s"} (${result.updated} row${result.updated === 1 ? "" : "s"} renamed)`);
    setMergeModalOpen(false);
  };

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
  // remove, and now Merge Campaign Names' renames) funnels through here so undo/notif/local-state-
  // sync stays in exactly one place. Each update may carry `tags` and/or `campaignName` (2026-08-05,
  // per Mo's "Merge Campaign Names" — see the fuzzy-matching helpers above); undo snapshots and the
  // local-state merge only touch whichever field(s) a given update actually set, so tag-only and
  // rename-only updates (and the existing tag-only call sites below) keep working unchanged.
  const patchRows = useCallback(
    async (updates, successMsg) => {
      if (!updates.length) return;
      const undoBatch = updates.map((u) => {
        const prev = rowsById.get(u.id) || {};
        const snap = { id: u.id };
        if (u.tags !== undefined) snap.tags = prev.tags || {};
        if (u.campaignName !== undefined) snap.campaignName = prev.campaignName || "";
        return snap;
      });
      setApplying(true);
      try {
        const result = await patchReportingFactsTags(session, workspace.id, updates);
        const byId = new Map(updates.map((u) => [u.id, u]));
        setRows((prev) => prev.map((r) => {
          const u = byId.get(r.id);
          if (!u) return r;
          return { ...r, ...(u.tags !== undefined ? { tags: u.tags } : {}), ...(u.campaignName !== undefined ? { campaignName: u.campaignName } : {}) };
        }));
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
      const byId = new Map(batch.map((u) => [u.id, u]));
      setRows((prev) => prev.map((r) => {
        const u = byId.get(r.id);
        if (!u) return r;
        return { ...r, ...(u.tags !== undefined ? { tags: u.tags } : {}), ...(u.campaignName !== undefined ? { campaignName: u.campaignName } : {}) };
      }));
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

  // Left-column overview (2026-08-03, per Mo — "use the left vertical column better ... give us an
  // overview of the data being tagged and filtered", replacing PaidHQ.jsx's generic ad-spend
  // "Total spend/Campaigns/Tagged/Needs review" default block, which never applied to this data).
  // Portaled in via sidebarEl the same way BudgetManager/PacingDashboard/AskAI populate their own
  // dedicated slice of the shared stats <aside> (see PaidHQ.jsx's own view==="reportingAnalyzer"
  // branch) — this component owns `groups`/`filtered`, so the overview lives here rather than being
  // recomputed a second time in the parent. Mirrors Campaign Tagger's own inline sidebar "Overview"
  // section (PaidHQ.jsx's view==="tagger" branch) — same StatRow list shape, same tagged-% bar.
  const sidebarPortal = sidebarEl && createPortal(
    <div className="bhq-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <SectionLabel T={T} style={{ marginBottom: 8, fontSize: 11 * (T.fsScale || 1) }}>{datasetLabel}</SectionLabel>
      <div style={{ padding: "12px 0" }}>
        <SectionLabel T={T} style={{ fontSize: 11 * (T.fsScale || 1) }}>Overview</SectionLabel>
        <StatRow T={T} size={11} label="Rows imported" value={(rows || []).length.toLocaleString()} />
        <StatRow T={T} size={11} label="Campaigns" value={groups.length.toLocaleString()} />
        <StatRow T={T} size={11} label="Showing" value={filtered.length.toLocaleString()} />
        <StatRow T={T} size={11} label="Tagged" value={taggedCount.toLocaleString()} color={T.success} />
        <StatRow T={T} size={11} label="Needs review" value={untaggedCount.toLocaleString()} color={untaggedCount > 0 ? T.warning : T.success} />
        <div style={{ marginTop: 10, height: 3, background: T.border, borderRadius: T.r2, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${groups.length ? (taggedCount / groups.length) * 100 : 0}%`, background: T.accent, transition: "width 0.4s", borderRadius: T.r2 }} />
        </div>
        <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginTop: 4 }}>{groups.length ? Math.round((taggedCount / groups.length) * 100) : 0}% tagged</div>
      </div>
      {distinctChannels.length > 0 && (
        <>
          <Divider T={T} />
          <div style={{ padding: "0 0 12px" }}>
            <SectionLabel T={T} style={{ fontSize: 11 * (T.fsScale || 1) }}>Channels</SectionLabel>
            <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6 }}>{distinctChannels.join(", ")}</div>
          </div>
        </>
      )}
    </div>,
    sidebarEl
  );

  if (rows === null && !loadError) {
    return (
      <>
        {sidebarPortal}
        <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading…</div>
      </>
    );
  }

  if (groups.length === 0 && !loadError) {
    return (
      <>
        {sidebarPortal}
        <div style={{ padding: "40px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>
          Nothing imported yet — bring in a file above first.
        </div>
      </>
    );
  }

  return (
    <>
      {sidebarPortal}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      {loadError && (
        <div style={{ padding: "9px 16px", background: T.dangerBg, borderBottom: `1px solid ${T.dangerBorder}`, fontSize: 12 * (T.fsScale || 1), color: T.danger, flexShrink: 0 }}>{loadError}</div>
      )}
      {notif && (
        <div style={{ padding: "9px 16px", borderBottom: `1px solid ${T.border}`, fontSize: 12 * (T.fsScale || 1), background: notif.type === "error" ? T.dangerBg : T.successBg, color: notif.type === "error" ? T.danger : T.success, flexShrink: 0 }}>{notif.msg}</div>
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
          {canEdit && (
            <>
              <div style={{ width: 1, height: 16, background: T.border }} />
              <Btn onClick={openMergeModal} variant="ghost" size="sm" T={T} title="Reconcile campaign names imported under two different naming conventions (e.g. ad-platform 'BIN-...' vs UTM 'SEA-...') so their metrics land on the same row">⇄ Merge campaign names</Btn>
            </>
          )}
          <div style={{ marginLeft: "auto" }}>
            {onBackToDataSources && <Btn onClick={onBackToDataSources} variant="ghost" size="sm" T={T}>← Back to Data Sources</Btn>}
          </div>
        </div>
      </div>

      {/* Column-header row, filter-inputs row, and every data row below share ONE horizontally-
          scrollable region (2026-08-04, per Mo — "increase the sizes and make them relative to the
          content ... allow the user to scroll to the right as much as what's needed"). colBoxStyle
          now gives every column a fixed, non-shrinking width (flexShrink:0 — see that function) sized
          to comfortably fit its content instead of the old flex-shrink-to-fit-the-viewport behavior
          that was crushing every column once more than a couple were selected. The inner div's
          width:"max-content" (floored at minWidth:"100%" so it never looks narrower than the pane)
          is what makes this row-stack size itself to the widest row's natural content width instead
          of the viewport — once that exceeds the outer pane's width, the browser scrolls this one
          region horizontally, carrying the sticky header+filter rows along with the data rows so
          columns never lose alignment. */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{ minWidth: "100%", width: "max-content" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 2, background: T.surfaceEl, borderBottom: `1px solid ${T.border}` }}>
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
                    const dimColors = T.tagDimColors || TAG_DIM_COLORS;
                    const dc = dimColors[(dimIdx >= 0 ? dimIdx : 0) % dimColors.length];
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
      </div>
      {mergeModalOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <PixelPanel T={T} style={{ width: "100%", maxWidth: 640, maxHeight: "85vh" }} contentStyle={{ background: T.surface, padding: 0, maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "16px 22px", borderBottom: `1px solid ${T.border}`, fontSize: 15 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>Merge campaign names</div>
            <div style={{ padding: "10px 22px 0", fontSize: 12 * (T.fsScale || 1), color: T.textMuted, lineHeight: 1.5 }}>
              For campaigns imported under two different naming conventions (e.g. ad-platform "BIN-..." carrying spend/leads vs UTM "SEA-..." carrying MQLs/SQLs/pipeline), pick which names refer to the same real campaign and which name to keep — every matching row gets renamed to it so its metrics land on one row. Nothing is renamed until you choose a name for a group and click Apply.
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
              {mergeGroups.length === 0 && (
                <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, textAlign: "center", padding: "20px 0" }}>No likely matches auto-detected. Add a group manually below if you know which names belong together.</div>
              )}
              {mergeGroups.map((g) => {
                const availableToAdd = distinctCampaignNames.filter((d) => !mergeUsedNames.has(d.name) || g.names.includes(d.name)).filter((d) => !g.names.includes(d.name));
                const complete = g.names.length >= 2 && !!g.canonical;
                return (
                  <div key={g.id} style={{ border: `1px solid ${complete ? T.accentBorder : T.border}`, borderRadius: T.r7, padding: 12, background: T.surfaceEl }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 11 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted }}>
                        {g.id.startsWith("sugg-") ? "Suggested match" : "Manual group"}
                      </span>
                      <button onClick={() => removeMergeGroup(g.id)} title="Remove this group" style={{ background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 13 * (T.fsScale || 1), padding: 0 }}>✕</button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                      {g.names.length === 0 && <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted }}>No names yet — add at least two below.</div>}
                      {g.names.map((name) => {
                        const stat = distinctCampaignNames.find((d) => d.name === name);
                        return (
                          <label key={name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 * (T.fsScale || 1), color: T.text, cursor: "pointer" }}>
                            <input type="radio" name={`merge-canonical-${g.id}`} checked={g.canonical === name} onChange={() => setMergeGroupCanonical(g.id, name)} style={{ cursor: "pointer", accentColor: T.accent }} />
                            <span style={{ flex: 1 }}>{name}</span>
                            <Pill color={T.textMuted} bg={T.surface} border={T.border}>{(stat?.rowCount || 0).toLocaleString()} row{stat?.rowCount === 1 ? "" : "s"}</Pill>
                            <span onClick={() => removeNameFromMergeGroup(g.id, name)} title="Remove from group" style={{ color: T.textMuted, cursor: "pointer", fontSize: 13 * (T.fsScale || 1), padding: "0 2px" }}>×</span>
                          </label>
                        );
                      })}
                    </div>
                    {g.names.length >= 1 && !g.canonical && <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.warning, marginBottom: 8 }}>Choose which name to keep — this group won't be applied until you do.</div>}
                    <Sel value={mergeAddSel[g.id] || ""} onChange={(v) => addNameToMergeGroup(g.id, v)} T={T} style={{ fontSize: 12 * (T.fsScale || 1) }}>
                      <option value="">+ Add a campaign name to this group…</option>
                      {availableToAdd.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.rowCount})</option>)}
                    </Sel>
                  </div>
                );
              })}
              <Btn onClick={addManualMergeGroup} variant="ghost" size="sm" T={T}>+ Add manual group</Btn>
            </div>
            <div style={{ padding: "14px 22px", borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>
                {mergeApplicableGroups.length > 0 ? `${mergeApplicableGroups.length} group${mergeApplicableGroups.length === 1 ? "" : "s"} ready to apply` : "No groups ready yet"}
                {mergeIncompleteCount > 0 ? ` · ${mergeIncompleteCount} need${mergeIncompleteCount === 1 ? "s" : ""} a name choice` : ""}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn onClick={() => setMergeModalOpen(false)} variant="ghost" T={T}>Cancel</Btn>
                <Btn onClick={applyMerge} disabled={!mergeApplicableGroups.length || applying} variant="primary" T={T}>Apply{mergeApplicableGroups.length > 1 ? ` (${mergeApplicableGroups.length})` : ""}</Btn>
              </div>
            </div>
          </PixelPanel>
        </div>
      )}
    </>
  );
}
