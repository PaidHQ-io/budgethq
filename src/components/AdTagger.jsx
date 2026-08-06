import { useEffect, useMemo, useState } from "react";
import { Btn, Icon, Pill, Sel, TagAutocompleteInput, MatchModeToggle, IconField } from "./shared.jsx";
import { getSpendRowsAggregate } from "../lib/workspaceApi.js";
import { adKey, campaignKey, splitFilterTerms, matchesTerms, downloadCSV, fmt$ } from "../lib/core.js";
import { usePersistentState } from "../lib/persist.js";

/**
 * Campaign Tagger's Ads mode (2026-08-19, per Mo — "bring in the Ad name/column into our campaign
 * tagger so we can tag Ads by tags and dimension" for paid social channels: LinkedIn, Meta, Reddit,
 * 6sense). Deliberately a SEPARATE component from Campaign Tagger's own inline Campaigns table in
 * PaidHQ.jsx rather than more inline code piled into that already-huge file, and a SEPARATE data
 * path/identity from it too:
 *
 * IDENTITY: uses adKey(campaignGroupName, campaignName, adName) from core.js — an ADDITIVE layer on
 * top of the existing campaignKey identity, not a third parameter folded into campaignKey itself.
 * campaignKey is used in ~15 places across PaidHQ.jsx/core.js (Budget Panel, Pacing, exports, Ask
 * AI, Data Audit, budget-dim resolution...) that have no reason to know about ads — extending it in
 * place would mean touching all of that surface for no benefit to it. This mode's own tags live in
 * workspace_config.adTags (a parallel key to the existing `tags` object — see workspaceApi.js's
 * config-shape doc comment), passed down from PaidHQ.jsx as adTags/setAdTags props, same ownership
 * pattern as `tags`/`setTags` for Campaigns mode.
 *
 * DATA SOURCE: fetches core.spend_rows via the new GET ?aggregate=identity endpoint (spend-rows.js)
 * instead of reusing Campaigns mode's mergedNormRows (every raw row, already loaded into memory) —
 * see that endpoint's own doc comment for why: reducing every raw row down to a small identity
 * table is pushed into Postgres (a GROUP BY) instead of downloaded-then-reduced in the browser, so
 * this stays fast even once ad-level data pushes a workspace's raw row count to several times its
 * campaign-level volume. This does mean Ads mode has its own fetch (not reactive to Campaigns mode's
 * in-memory edits) — a Refresh button covers "I just synced/imported new ad-level data."
 *
 * SCOPE (v1, per this session's build plan): filter, bulk-select, apply/remove a tag dimension,
 * export CSV, undo. Deliberately NOT included yet (Campaigns mode has these, Ads mode doesn't):
 * per-row delete-from-dataset, screenshot/CSV tag import, cross-match suggestions, merge-names. Can
 * be added later the same way Campaigns mode's own toolbar grew over time.
 *
 * TAG INHERITANCE (2026-08-05, per Mo — tagging every ad from scratch with no visibility into what
 * its parent campaign already carries was pure duplicate work for dimensions like Product/Region
 * that don't vary within a campaign): an ad's EFFECTIVE tag for a dimension is its own explicit
 * adTags entry if it has one, else falls back to its parent campaign's tags entry (looked up via
 * campaignKey(groupName, name) — the same identity Campaigns mode itself tags against). This is
 * computed fresh in the `ads`/`filtered` memos below (effectiveTagsFor), NOT written back into
 * adTags — a campaign's tag changing later still flows through to every ad that hasn't been
 * explicitly overridden. Tagged/untagged stats, the tag filter, and CSV export all use the
 * effective set; bulk-apply/remove/the per-tag × button still only ever touch adTags (the explicit
 * ad-level override) — they never write to or delete from the campaign's own tags. An inherited tag
 * renders visually distinct (dashed border, no × — there's nothing at the ad level to remove) from
 * an explicit one; bulk-removing an explicit override just reveals the inherited value again
 * underneath, which is deliberate. NOT supported yet: explicitly overriding an inherited tag to
 * "blank" (opting one ad out of a campaign-wide tag) — no UI for that edge case in this pass.
 */

function SH({ T, col, label, sortCol, sortDir, onSort, align }) {
  return (
    <span onClick={() => onSort(col)} title="Click to sort"
      style={{ fontFamily: T.font, fontSize: 11 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: sortCol === col ? T.text : T.textMuted, textDecoration: sortCol === col ? "underline" : "none", textUnderlineOffset: 2, cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 3, ...(align === "right" ? { justifyContent: "flex-end", width: "100%" } : {}) }}>
      {label}
      <span style={{ opacity: 0.7, fontSize: 9 * (T.fsScale || 1) }}>{sortCol === col ? (sortDir === "desc" ? "▾" : "▴") : "⇅"}</span>
    </span>
  );
}

const fIn = { background: "transparent", border: "none", outline: "none", width: "100%" };
const colBox = { campaign: { width: 200, flexShrink: 0 }, group: { width: 180, flexShrink: 0 }, ad: { width: 220, flexShrink: 0 }, spend: { width: 110, flexShrink: 0 }, platform: { width: 110, flexShrink: 0 } };
const TAGS_BOX_STYLE = { flex: "1 0 220px", minWidth: 220 };

export default function AdTagger({ T, session, workspace, canEdit, tagDims, tags, adTags, setAdTags }) {
  const [rows, setRows] = useState(null); // raw aggregate rows from the server, null = loading
  const [loadError, setLoadError] = useState("");
  const [notif, setNotif] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [applyDim, setApplyDim] = useState("");
  const [applyVal, setApplyVal] = useState("");
  const [undoStack, setUndoStack] = useState([]); // array of prior adTags snapshots, max 50

  const [filtersOpen, setFiltersOpen] = usePersistentState("paidhq_adtagger_filtersOpen", true);
  const [sortCol, setSortCol] = usePersistentState("paidhq_adtagger_sortCol", "spend");
  const [sortDir, setSortDir] = usePersistentState("paidhq_adtagger_sortDir", "desc");
  const [fCamp, setFCamp] = usePersistentState("paidhq_adtagger_fCamp", "");
  const [fCampExclude, setFCampExclude] = usePersistentState("paidhq_adtagger_fCampExclude", "");
  const [fCampInclMode, setFCampInclMode] = usePersistentState("paidhq_adtagger_fCampInclMode", "or");
  const [fCampExclMode, setFCampExclMode] = usePersistentState("paidhq_adtagger_fCampExclMode", "or");
  const [fGroup, setFGroup] = usePersistentState("paidhq_adtagger_fGroup", "");
  const [fGroupExclude, setFGroupExclude] = usePersistentState("paidhq_adtagger_fGroupExclude", "");
  const [fGroupInclMode, setFGroupInclMode] = usePersistentState("paidhq_adtagger_fGroupInclMode", "or");
  const [fGroupExclMode, setFGroupExclMode] = usePersistentState("paidhq_adtagger_fGroupExclMode", "or");
  const [fAd, setFAd] = usePersistentState("paidhq_adtagger_fAd", "");
  const [fAdExclude, setFAdExclude] = usePersistentState("paidhq_adtagger_fAdExclude", "");
  const [fAdInclMode, setFAdInclMode] = usePersistentState("paidhq_adtagger_fAdInclMode", "or");
  const [fAdExclMode, setFAdExclMode] = usePersistentState("paidhq_adtagger_fAdExclMode", "or");
  const [fPlat, setFPlat] = usePersistentState("paidhq_adtagger_fPlat", "");
  const [fTag, setFTag] = usePersistentState("paidhq_adtagger_fTag", "");
  const [fTagExclude, setFTagExclude] = usePersistentState("paidhq_adtagger_fTagExclude", "");
  const [fTagInclMode, setFTagInclMode] = usePersistentState("paidhq_adtagger_fTagInclMode", "or");
  const [fTagExclMode, setFTagExclMode] = usePersistentState("paidhq_adtagger_fTagExclMode", "or");
  const [fStatus, setFStatus] = usePersistentState("paidhq_adtagger_fStatus", "all");

  const showNotif = (msg, type = "success") => { setNotif({ msg, type }); setTimeout(() => setNotif(null), type === "error" ? 6000 : 3000); };

  // No synchronous setState in the effect body itself (react-hooks/set-state-in-effect) — the reset
  // to a "loading" state only happens inside the promise callback, same shape as e.g.
  // PipelineTagger.jsx's own config-load effect. `rows` starts as null (see useState above), which
  // already reads as "loading" on first mount without needing a synchronous reset here.
  useEffect(() => {
    if (!workspace?.id || !session) return;
    getSpendRowsAggregate(session, workspace.id)
      .then(setRows)
      .catch((e) => { setLoadError(e.message || "Failed to load ad data"); setRows([]); });
  }, [session, workspace?.id]);
  // Refresh button — triggered from a click handler, not an effect, so synchronously resetting to
  // the loading state here is fine (this is exactly the pattern the effect above avoids).
  const load = () => {
    if (!workspace?.id || !session) return;
    setRows(null); setLoadError("");
    getSpendRowsAggregate(session, workspace.id)
      .then(setRows)
      .catch((e) => { setLoadError(e.message || "Failed to load ad data"); setRows([]); });
  };

  // Only rows that actually carry an ad_name belong in an ads table — a non-ad-level aggregate row
  // (adName null, everything else about that ad group with no ad breakdown) isn't an ad.
  // campKey (2026-08-05): the same campaignKey identity Campaigns mode tags against — this is what
  // lets each ad look up its parent campaign's existing tags for inheritance (see this file's top
  // doc comment).
  const ads = useMemo(() => (rows || [])
    .filter((r) => r.adName)
    .map((r) => ({
      key: adKey(r.campaignGroupName, r.campaignName, r.adName),
      campKey: campaignKey(r.campaignGroupName, r.campaignName),
      groupName: r.campaignGroupName || r.campaignName || "",
      name: r.campaignName || "",
      adName: r.adName,
      platform: r.platform || "Unknown",
      spend: r.spend || 0,
      impressions: r.impressions || 0,
      clicks: r.clicks || 0,
    })), [rows]);

  // Effective tags for an ad = its own explicit adTags entry, falling back to its parent campaign's
  // tags entry per-dimension — see this file's top doc comment. Deliberately a plain function (not
  // memoized per-key) since it's cheap object-spread work called from within memos that already
  // iterate every ad once.
  const effectiveTagsFor = (a) => ({ ...(tags?.[a.campKey] || {}), ...(adTags[a.key] || {}) });

  const allPlats = useMemo(() => [...new Set(ads.map((a) => a.platform))].sort(), [ads]);
  const hasF = !!(fCamp || fCampExclude || fGroup || fGroupExclude || fAd || fAdExclude || fPlat || fTag || fTagExclude || fStatus !== "all");
  const clearF = () => { setFCamp(""); setFCampExclude(""); setFGroup(""); setFGroupExclude(""); setFAd(""); setFAdExclude(""); setFPlat(""); setFTag(""); setFTagExclude(""); setFStatus("all"); };

  const filtered = useMemo(() => {
    let r = ads.filter((a) => {
      if (fCamp) { const terms = splitFilterTerms(fCamp); if (terms.length && !matchesTerms(a.groupName.toLowerCase(), terms, fCampInclMode)) return false; }
      if (fCampExclude) { const terms = splitFilterTerms(fCampExclude); if (terms.length && matchesTerms(a.groupName.toLowerCase(), terms, fCampExclMode)) return false; }
      if (fGroup) { const terms = splitFilterTerms(fGroup); if (terms.length && !matchesTerms(a.name.toLowerCase(), terms, fGroupInclMode)) return false; }
      if (fGroupExclude) { const terms = splitFilterTerms(fGroupExclude); if (terms.length && matchesTerms(a.name.toLowerCase(), terms, fGroupExclMode)) return false; }
      if (fAd) { const terms = splitFilterTerms(fAd); if (terms.length && !matchesTerms(a.adName.toLowerCase(), terms, fAdInclMode)) return false; }
      if (fAdExclude) { const terms = splitFilterTerms(fAdExclude); if (terms.length && matchesTerms(a.adName.toLowerCase(), terms, fAdExclMode)) return false; }
      if (fPlat && a.platform !== fPlat) return false;
      // fTag/fTagExclude/fStatus all read the EFFECTIVE tag set (own + inherited from the parent
      // campaign) — see effectiveTagsFor's doc comment. An ad that's never been explicitly tagged
      // but whose campaign has been should show up under "Tagged" and match a tag-content filter,
      // same as one tagged directly.
      if (fTag) { const ts = effectiveTagsFor(a); const s = Object.entries(ts).map(([d, v]) => `${d}:${v}`).join(" ").toLowerCase(); const terms = splitFilterTerms(fTag); if (terms.length && !matchesTerms(s, terms, fTagInclMode)) return false; }
      if (fTagExclude) { const ts = effectiveTagsFor(a); const s = Object.entries(ts).map(([d, v]) => `${d}:${v}`).join(" ").toLowerCase(); const terms = splitFilterTerms(fTagExclude); if (terms.length && matchesTerms(s, terms, fTagExclMode)) return false; }
      // Selected rows stay visible through a tagged/untagged status flip mid-session, same reasoning
      // as Campaigns mode's own filtered useMemo (bulk-tagging a batch across several dimensions).
      if (!selected.has(a.key)) {
        const tc = Object.keys(effectiveTagsFor(a)).length;
        if (fStatus === "tagged" && tc === 0) return false;
        if (fStatus === "untagged" && tc > 0) return false;
      }
      return true;
    });
    return [...r].sort((x, y) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortCol === "spend") return dir * (x.spend - y.spend);
      if (sortCol === "ad") return dir * x.adName.localeCompare(y.adName);
      if (sortCol === "group") return dir * x.name.localeCompare(y.name);
      if (sortCol === "campaign") return dir * x.groupName.localeCompare(y.groupName);
      if (sortCol === "platform") return dir * x.platform.localeCompare(y.platform);
      const at = Object.keys(effectiveTagsFor(x)).length, bt = Object.keys(effectiveTagsFor(y)).length;
      return dir * (at - bt);
    });
  }, [ads, fCamp, fCampExclude, fCampInclMode, fCampExclMode, fGroup, fGroupExclude, fGroupInclMode, fGroupExclMode, fAd, fAdExclude, fAdInclMode, fAdExclMode, fPlat, fTag, fTagExclude, fTagInclMode, fTagExclMode, fStatus, sortCol, sortDir, adTags, tags, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const tagged = ads.filter((a) => Object.keys(effectiveTagsFor(a)).length > 0).length;
    return { total: ads.length, tagged, untagged: ads.length - tagged, totalSpend: ads.reduce((s, a) => s + a.spend, 0) };
  }, [ads, adTags, tags]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSel = (key) => setSelected((p) => { const nx = new Set(p); nx.has(key) ? nx.delete(key) : nx.add(key); return nx; });
  const selAll = () => setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map((a) => a.key)));
  const pushUndo = () => setUndoStack((s) => [...s.slice(-49), adTags]);
  const undo = () => { if (!undoStack.length) return; setAdTags(undoStack[undoStack.length - 1]); setUndoStack((s) => s.slice(0, -1)); };

  const applyTags = () => {
    if (!canEdit || !applyDim || !applyVal.trim() || !selected.size) return;
    pushUndo();
    const val = applyVal.trim();
    setAdTags((p) => { const nx = { ...p }; selected.forEach((k) => { nx[k] = { ...(nx[k] || {}), [applyDim]: val }; }); return nx; });
    showNotif(`Applied ${applyDim}: ${val} to ${selected.size} ad${selected.size === 1 ? "" : "s"}`);
    setApplyVal("");
  };
  const bulkRemoveTag = (dim) => {
    if (!canEdit || !dim || !selected.size) return;
    pushUndo();
    setAdTags((p) => { const nx = { ...p }; selected.forEach((k) => { if (nx[k]) { const ts = { ...nx[k] }; delete ts[dim]; nx[k] = ts; } }); return nx; });
    showNotif(`Removed ${dim} tag from ${selected.size} ad${selected.size === 1 ? "" : "s"}`);
    setSelected(new Set());
  };
  const removeTag = (key, dim) => {
    if (!canEdit) return;
    pushUndo();
    setAdTags((p) => { const ts = { ...(p[key] || {}) }; delete ts[dim]; return { ...p, [key]: ts }; });
  };

  const exportCsv = () => {
    const header = ["Campaign", "Ad Group/Ad Set", "Ad", "Platform", "Spend", ...tagDims];
    // Effective values (own tag, else inherited from the campaign) — an export should reflect what
    // the ad is actually tagged as, not just what was explicitly set at the ad level.
    const csvRows = [header, ...filtered.map((a) => [a.groupName, a.name, a.adName, a.platform, a.spend.toFixed(2), ...tagDims.map((d) => effectiveTagsFor(a)[d] || "")])];
    downloadCSV(csvRows, "paidhq-ad-tags.csv");
    showNotif("Ad tags exported");
  };

  const doSort = (col) => { if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc")); else { setSortCol(col); setSortDir("desc"); } };

  if (rows === null) {
    return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading ads…</div>;
  }

  if (!ads.length) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: T.textMuted, fontSize: 13 * (T.fsScale || 1), textAlign: "center", padding: 24 }}>
        {loadError ? (
          <div style={{ color: T.danger }}>{loadError}</div>
        ) : (
          <>
            <div>No ad-level data yet.</div>
            <div style={{ fontSize: 12 * (T.fsScale || 1), maxWidth: 420 }}>Ad Name gets populated once a connector or import reports at the ad/creative level (LinkedIn, Meta, and CSV/manual imports for Reddit and 6sense). Campaign- and ad-group-level data keeps showing up in Campaigns mode as usual.</div>
          </>
        )}
        <Btn onClick={load} variant="ghost" size="sm" T={T}>↻ Refresh</Btn>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      {loadError && <div style={{ padding: "9px 16px", background: T.dangerBg, borderBottom: `1px solid ${T.dangerBorder}`, fontSize: 12 * (T.fsScale || 1), color: T.danger, flexShrink: 0 }}>{loadError}</div>}
      {notif && <div style={{ padding: "9px 16px", borderBottom: `1px solid ${T.border}`, fontSize: 12 * (T.fsScale || 1), background: notif.type === "error" ? T.dangerBg : T.successBg, color: notif.type === "error" ? T.danger : T.success, flexShrink: 0 }}>{notif.msg}</div>}

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
              <TagAutocompleteInput T={T} value={applyVal} onChange={setApplyVal} suggestions={[]} onEnter={applyTags} placeholder="Tag value…" style={{ width: 130 }}
                inputStyle={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r7, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
              <Btn onClick={applyTags} disabled={!applyDim || !applyVal.trim()} variant="primary" size="sm" T={T}>Apply</Btn>
              <Btn onClick={() => bulkRemoveTag(applyDim)} disabled={!applyDim} variant="danger" size="sm" T={T}>Remove</Btn>
              <div style={{ width: 1, height: 16, background: T.border }} />
              <Btn onClick={exportCsv} variant="ghost" size="sm" T={T}>Export CSV</Btn>
            </>
          )}
          <Btn onClick={() => setSelected(new Set())} variant="ghost" size="sm" T={T}>Clear</Btn>
          <div style={{ marginLeft: "auto" }}>
            <Btn onClick={undo} disabled={!undoStack.length} variant="ghost" size="sm" T={T} title="Undo last tag action">↩ Undo {undoStack.length > 0 && `(${undoStack.length})`}</Btn>
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
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>{stats.total.toLocaleString()} ads · {stats.tagged.toLocaleString()} tagged · {fmt$(stats.totalSpend)} total spend</span>
            <Btn onClick={load} variant="ghost" size="sm" T={T} title="Reload from the server"><Icon name="refresh" size={12} color={T.text} /></Btn>
            {selected.size === 0 && <Btn onClick={exportCsv} variant="ghost" size="sm" T={T}>Export CSV</Btn>}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{ minWidth: "100%", width: "max-content" }}>
          <div style={{ position: "sticky", top: 0, zIndex: 2, background: T.surfaceEl, borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: "flex", padding: "11px 16px 5px", alignItems: "end", gap: 8, background: T.headerBg }}>
              {/* Row number column (2026-08-19, per Mo — "add a row number to the campaign tagger
                  and pipeline tagger"). Reflects the table's current sort/filter position, not a
                  stable per-ad id. */}
              <div style={{ width: 22, flexShrink: 0, fontSize: 11 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted, textAlign: "right" }}>#</div>
              <div style={{ width: 22, flexShrink: 0 }}>
                <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={selAll} style={{ cursor: "pointer", accentColor: T.accent, width: 14, height: 14 }} />
              </div>
              <div style={colBox.campaign}><SH T={T} col="campaign" label="Campaign" sortCol={sortCol} sortDir={sortDir} onSort={doSort} /></div>
              <div style={colBox.group}><SH T={T} col="group" label="Ad Group/Ad Set" sortCol={sortCol} sortDir={sortDir} onSort={doSort} /></div>
              <div style={colBox.ad}><SH T={T} col="ad" label="Ad" sortCol={sortCol} sortDir={sortDir} onSort={doSort} /></div>
              <div style={colBox.spend}><SH T={T} col="spend" label="Spend" sortCol={sortCol} sortDir={sortDir} onSort={doSort} align="right" /></div>
              <div style={colBox.platform}><SH T={T} col="platform" label="Platform" sortCol={sortCol} sortDir={sortDir} onSort={doSort} /></div>
              <div style={{ ...TAGS_BOX_STYLE }}><SH T={T} col="tags" label="Tags" sortCol={sortCol} sortDir={sortDir} onSort={doSort} /></div>
            </div>

            {filtersOpen && (
              <div style={{ display: "flex", padding: "3px 16px 10px", gap: 8, alignItems: "start", flexWrap: "wrap" }}>
                <div style={{ width: 22, flexShrink: 0 }} />
                <div style={{ width: 22, flexShrink: 0 }} />
                <div style={{ ...colBox.campaign, display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", gap: 3 }}>
                    <IconField icon="search" color={T.textMuted}>
                      <input value={fCamp} onChange={(e) => setFCamp(e.target.value)} placeholder="Campaign contains… (a, b)" style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px 6px 26px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                    </IconField>
                    <MatchModeToggle mode={fCampInclMode} onChange={setFCampInclMode} T={T} />
                  </div>
                  <div style={{ display: "flex", gap: 3 }}>
                    <input value={fCampExclude} onChange={(e) => setFCampExclude(e.target.value)} placeholder="≠ excludes… (a, b)" style={{ ...fIn, flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                    <MatchModeToggle mode={fCampExclMode} onChange={setFCampExclMode} T={T} />
                  </div>
                </div>
                <div style={{ ...colBox.group, display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", gap: 3 }}>
                    <IconField icon="search" color={T.textMuted}>
                      <input value={fGroup} onChange={(e) => setFGroup(e.target.value)} placeholder="Ad Group contains… (a, b)" style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px 6px 26px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                    </IconField>
                    <MatchModeToggle mode={fGroupInclMode} onChange={setFGroupInclMode} T={T} />
                  </div>
                  <div style={{ display: "flex", gap: 3 }}>
                    <input value={fGroupExclude} onChange={(e) => setFGroupExclude(e.target.value)} placeholder="≠ excludes… (a, b)" style={{ ...fIn, flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                    <MatchModeToggle mode={fGroupExclMode} onChange={setFGroupExclMode} T={T} />
                  </div>
                </div>
                <div style={{ ...colBox.ad, display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", gap: 3 }}>
                    <IconField icon="search" color={T.textMuted}>
                      <input value={fAd} onChange={(e) => setFAd(e.target.value)} placeholder="Ad contains… (a, b)" style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px 6px 26px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                    </IconField>
                    <MatchModeToggle mode={fAdInclMode} onChange={setFAdInclMode} T={T} />
                  </div>
                  <div style={{ display: "flex", gap: 3 }}>
                    <input value={fAdExclude} onChange={(e) => setFAdExclude(e.target.value)} placeholder="≠ excludes… (a, b)" style={{ ...fIn, flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text }} />
                    <MatchModeToggle mode={fAdExclMode} onChange={setFAdExclMode} T={T} />
                  </div>
                </div>
                <div style={colBox.spend} />
                <div style={colBox.platform}>
                  <select value={fPlat} onChange={(e) => setFPlat(e.target.value)} style={{ width: "100%", cursor: "pointer", border: `1px solid ${T.border}`, borderRadius: T.r8, padding: "6px 9px", fontSize: 11 * (T.fsScale || 1), background: T.surface, color: T.text, fontFamily: T.font }}>
                    <option value="">All platforms</option>
                    {allPlats.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
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
              </div>
            )}
          </div>

          {filtered.map((a, ai) => {
            const ts = adTags[a.key] || {}; // explicit, ad-level only — drives the × remove control
            const inherited = tags?.[a.campKey] || {}; // this ad's parent campaign's own tags
            const eff = { ...inherited, ...ts }; // effective = own value if set, else inherited
            const tc = Object.keys(eff).length;
            const isSel = selected.has(a.key);
            const orderedDims = [...(tagDims || []).filter((d) => Object.prototype.hasOwnProperty.call(eff, d)), ...Object.keys(eff).filter((d) => !(tagDims || []).includes(d))];
            return (
              <div key={a.key} className={isSel ? undefined : "bhq-row"} onClick={() => toggleSel(a.key)}
                style={{ display: "flex", padding: "11px 16px", borderBottom: `1px solid ${T.border}`, alignItems: "center", cursor: "pointer", background: isSel ? T.rowSelected : T.surface, transition: "background 0.1s", gap: 8 }}>
                <div style={{ width: 22, flexShrink: 0, fontSize: 12 * (T.fsScale || 1), color: T.textMuted, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ai + 1}</div>
                <div style={{ width: 22, flexShrink: 0 }}>
                  <input type="checkbox" checked={isSel} onChange={() => toggleSel(a.key)} onClick={(e) => e.stopPropagation()} style={{ cursor: "pointer", accentColor: T.accent, width: 14, height: 14 }} />
                </div>
                <div style={{ ...colBox.campaign, display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span title={tc > 0 ? "Tagged" : "Needs review"} style={{ width: 9, height: 9, borderRadius: "50%", background: tc > 0 ? T.accent : "#A1A1AA", flexShrink: 0 }} />
                  <span title={a.groupName} style={{ minWidth: 0, fontSize: 13 * (T.fsScale || 1), fontFamily: T.font, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.groupName || "(no campaign)"}</span>
                </div>
                <div title={a.name} style={{ ...colBox.group, fontSize: 13 * (T.fsScale || 1), fontFamily: T.font, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name || "—"}</div>
                <div title={a.adName} style={{ ...colBox.ad, fontSize: 13 * (T.fsScale || 1), fontFamily: T.font, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.adName}</div>
                <div style={{ ...colBox.spend, textAlign: "right", fontSize: 13 * (T.fsScale || 1), fontFamily: T.font, color: T.text, fontVariantNumeric: "tabular-nums" }}>{fmt$(a.spend)}</div>
                <div style={{ ...colBox.platform, fontSize: 13 * (T.fsScale || 1), fontFamily: T.font, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.platform}</div>
                <div style={{ ...TAGS_BOX_STYLE, display: "flex", flexWrap: "wrap", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  {orderedDims.map((dim) => {
                    // Own explicit value wins; a dim only present via the campaign renders as
                    // inherited (dashed border, no × — there's nothing at the ad level to remove,
                    // see this file's top doc comment).
                    const isOwn = Object.prototype.hasOwnProperty.call(ts, dim);
                    return (
                      <span key={dim} title={isOwn ? undefined : `Inherited from campaign "${a.groupName}"`}
                        style={{ display: "inline-flex", alignItems: "center", fontSize: 12 * (T.fsScale || 1), padding: "2px 4px 2px 8px", borderRadius: T.r6, background: isOwn ? T.accentBg : "transparent", color: isOwn ? T.text : T.textMuted, border: `1px ${isOwn ? "solid" : "dashed"} ${isOwn ? T.accentBorder : T.border}`, gap: 2, fontFamily: T.font }}>
                        <span style={{ opacity: 0.75, marginRight: 1 }}>{dim}:</span>{eff[dim]}
                        {canEdit && isOwn && <span onClick={() => removeTag(a.key, dim)} style={{ color: T.textMuted, cursor: "pointer", fontSize: 13 * (T.fsScale || 1), lineHeight: 1, marginLeft: 1, padding: "0 2px" }}>×</span>}
                      </span>
                    );
                  })}
                  {tc === 0 && <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted }}>—</span>}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: "40px 20px 52px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>
              No ads match your filters.{hasF && <span onClick={clearF} style={{ color: T.text, cursor: "pointer", marginLeft: 6, fontWeight: 400, textDecoration: "underline" }}>Clear filters</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
