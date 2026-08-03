import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Btn, Icon, Pill, Sel, IconField, SectionLabel, Divider, StatRow, PixelPanel } from "./shared.jsx";
import {
  listChangeEvents, logManualChangeEvent, deleteChangeEvent, syncChangeEventsNow,
  CHANGE_TYPE_OPTIONS, CHANGE_TYPE_LABELS, ENTITY_TYPE_OPTIONS, ENTITY_TYPE_LABELS,
} from "../lib/changeEventsApi.js";
import { PLATFORM_OPTIONS, PLATFORM_COLORS, splitFilterTerms, matchesTerms } from "../lib/core.js";
import { usePersistentState } from "../lib/persist.js";

// Change History (2026-08-19, per Mo — "I made some changes to google budgets and enabling/disabling
// campaigns and ad groups. I want that context saved in PaidHQ. Can we create a change history
// section that automatically pulls in non automated and non bulk edit changes from Google, Bing,
// Meta and LinkedIn and Capterra?"). New dedicated tab (confirmed via AskUserQuestion — Mo picked
// "New dedicated tab" over folding this into an existing one). Scope, also confirmed via
// AskUserQuestion: "Build in all channels (as well as additional channels in the future, like
// Reddit, TikTok, Youtube, etc.) but include a section for manual changes for those changes that I
// can't pull in through API yet ... Those changes will need to be filterable ... and categorized by
// the type change."
//
// Reads/writes core.change_events via api/workspaces/[id]/change-events.js — see that file's doc
// comment for the full schema/upsert/idempotency reasoning. This tab is a filterable feed + a
// manual-entry form + (2026-08-19, per Mo — "I don't see anything logged from Google. How do we get
// it into PaidHQ?") a "Sync Google now" button. The automated cron pull (api/cron/sync-connectors.js)
// only runs once a day AND only for connections opted into rolling sync, so a workspace's first-ever
// look at this tab would otherwise show nothing until both of those line up — Sync Google now calls
// the same pull immediately and surfaces whatever error actually blocked it (not connected yet,
// developer token not live, etc.) instead of a silent, confusing wait. This UI only ever creates
// entrySource:"manual" rows directly — API-sourced rows come from syncChangeEventsNow/the cron
// calling api/connectors/google.js's getChangeEvents server-side — and can only delete manual ones
// (API-sourced rows stay in sync via upsert; deleting one here would just have the next sync/click
// recreate it — see change-events.js's DELETE doc comment).
//
// Deliberately simpler than ReportingFactsTagger.jsx (no grouping/aggregation/undo/bulk-tag apply —
// a change event is a single, already-complete fact, not a metric row that gets progressively
// tagged) — closer in shape to a plain audit log: filter bar + sorted feed + one add-entry modal.

const PAGE_SIZE_DISPLAY = 500; // soft cap on rendered rows at once — a growing audit log has no natural upper bound the way a campaign list does

const emptyEntry = () => ({
  platform: "Google", entityType: "campaign", entityName: "", changeType: "budget",
  summary: "", details: "", oldValue: "", newValue: "", changedBy: "",
  changedAt: new Date().toISOString().slice(0, 16), // yyyy-MM-ddTHH:mm, for <input type="datetime-local">
});

const fIn = { background: "transparent", border: "none", outline: "none", width: "100%" };

export default function ChangeHistory({ T, session, workspace, canEdit, sidebarEl }) {
  const k = (suffix) => `paidhq_change_history_${suffix}`;
  const [rows, setRows] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [notif, setNotif] = useState(null);
  const [busy, setBusy] = useState(false);

  const [filtersOpen, setFiltersOpen] = usePersistentState(k("filtersOpen"), true);
  const [fPlatform, setFPlatform] = usePersistentState(k("fPlatform"), "");
  const [fChangeType, setFChangeType] = usePersistentState(k("fChangeType"), "");
  const [fEntrySource, setFEntrySource] = usePersistentState(k("fEntrySource"), "");
  const [fEntity, setFEntity] = usePersistentState(k("fEntity"), "");
  const [fChangedBy, setFChangedBy] = usePersistentState(k("fChangedBy"), "");
  const [fStart, setFStart] = usePersistentState(k("fStart"), "");
  const [fEnd, setFEnd] = usePersistentState(k("fEnd"), "");

  const [addOpen, setAddOpen] = useState(false);
  const [entry, setEntry] = useState(emptyEntry);
  const [saving, setSaving] = useState(false);
  const [syncingGoogle, setSyncingGoogle] = useState(false);

  const showNotif = (msg, type = "success") => {
    setNotif({ msg, type });
    // Errors get more time on screen than a plain success toast — sync errors in particular (see
    // syncGoogleNow below) can be a real, sometimes-longish diagnostic message ("This workspace
    // hasn't connected google yet" / a raw GAQL fault) that's worth actually reading, not glancing at.
    setTimeout(() => setNotif(null), type === "error" ? 9000 : 3000);
  };

  // "Sync Google now" (2026-08-19, per Mo — "I don't see anything logged from Google. How do we get
  // it into PaidHQ?"). See this file's top doc comment for why the automated cron pull alone isn't
  // enough to explain "nothing showed up yet" — this hits the same pull immediately and surfaces
  // whichever real error blocked it (not connected, stale/invalid credential, developer token not
  // live, a GAQL fault, etc.) directly in the notif banner rather than a generic failure.
  const syncGoogleNow = async () => {
    if (!canEdit || syncingGoogle) return;
    setSyncingGoogle(true);
    try {
      const result = await syncChangeEventsNow(session, workspace.id, "google");
      showNotif(
        result.pulled === 0
          ? "Synced Google — no changes found in the last 30 days (or none that passed the automated/bulk-edit filter)."
          : `Synced Google — pulled ${result.pulled}, ${result.inserted} new/updated${result.skipped?.length ? `, ${result.skipped.length} skipped` : ""}.`
      );
      refresh();
    } catch (err) {
      showNotif(err.message || "Google sync failed", "error");
    } finally {
      setSyncingGoogle(false);
    }
  };

  // Date-range filters run server-side (see listChangeEvents) since they can meaningfully cut down
  // what's fetched; platform/changeType/entrySource/entity/changedBy are applied client-side below
  // so toggling them doesn't refire a network round-trip on every keystroke.
  const refresh = useCallback(() => {
    const serverFilters = {};
    if (fStart) serverFilters.start = new Date(fStart).toISOString();
    if (fEnd) serverFilters.end = new Date(fEnd).toISOString();
    listChangeEvents(session, workspace.id, serverFilters)
      .then((r) => { setRows(r); setLoadError(""); })
      .catch((err) => setLoadError(err.message || "Couldn't load change history."));
  }, [session, workspace.id, fStart, fEnd]);

  useEffect(() => { refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    return (rows || []).filter((r) => {
      if (fPlatform && r.platform !== fPlatform) return false;
      if (fChangeType && r.changeType !== fChangeType) return false;
      if (fEntrySource && r.entrySource !== fEntrySource) return false;
      if (fEntity) {
        const terms = splitFilterTerms(fEntity);
        const hay = `${r.entityName || ""} ${r.summary || ""}`.toLowerCase();
        if (terms.length && !matchesTerms(hay, terms, "or")) return false;
      }
      if (fChangedBy) {
        const terms = splitFilterTerms(fChangedBy);
        if (terms.length && !matchesTerms((r.changedBy || "").toLowerCase(), terms, "or")) return false;
      }
      return true;
    });
  }, [rows, fPlatform, fChangeType, fEntrySource, fEntity, fChangedBy]);

  const distinctPlatforms = useMemo(() => Array.from(new Set((rows || []).map((r) => r.platform).filter(Boolean))).sort(), [rows]);
  const apiCount = useMemo(() => (rows || []).filter((r) => r.entrySource === "api").length, [rows]);
  const manualCount = (rows || []).length - apiCount;

  const hasF = fPlatform || fChangeType || fEntrySource || fEntity || fChangedBy || fStart || fEnd;
  const clearF = () => {
    setFPlatform(""); setFChangeType(""); setFEntrySource("");
    setFEntity(""); setFChangedBy(""); setFStart(""); setFEnd("");
  };

  const openAdd = () => {
    setEntry({ ...emptyEntry(), changedBy: session?.user?.email || "" });
    setAddOpen(true);
  };

  const submitAdd = async () => {
    if (!canEdit || !entry.platform || !entry.changeType || !entry.summary.trim() || !entry.changedAt) return;
    setSaving(true);
    try {
      await logManualChangeEvent(session, workspace.id, {
        platform: entry.platform,
        entityType: entry.entityType || null,
        entityName: entry.entityName.trim() || null,
        changeType: entry.changeType,
        summary: entry.summary.trim(),
        details: entry.details.trim() || null,
        oldValue: entry.oldValue.trim() || null,
        newValue: entry.newValue.trim() || null,
        changedBy: entry.changedBy.trim() || null,
        changedAt: new Date(entry.changedAt).toISOString(),
      });
      setAddOpen(false);
      showNotif("Change logged");
      refresh();
    } catch (err) {
      showNotif(err.message || "Failed to log change", "error");
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = async (r) => {
    if (!canEdit || r.entrySource !== "manual") return;
    if (!window.confirm(`Delete this logged change ("${r.summary}")? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await deleteChangeEvent(session, workspace.id, r.id);
      setRows((prev) => prev.filter((x) => x.id !== r.id));
      showNotif("Deleted");
    } catch (err) {
      showNotif(err.message || "Delete failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const sidebarPortal = sidebarEl && createPortal(
    <div className="bhq-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <SectionLabel T={T} style={{ marginBottom: 8, fontSize: 11 * (T.fsScale || 1) }}>Change History</SectionLabel>
      <div style={{ padding: "12px 0" }}>
        <SectionLabel T={T} style={{ fontSize: 11 * (T.fsScale || 1) }}>Overview</SectionLabel>
        <StatRow T={T} size={11} label="Total events" value={(rows || []).length.toLocaleString()} />
        <StatRow T={T} size={11} label="Showing" value={filtered.length.toLocaleString()} />
        <StatRow T={T} size={11} label="From API" value={apiCount.toLocaleString()} />
        <StatRow T={T} size={11} label="Logged manually" value={manualCount.toLocaleString()} />
      </div>
      {distinctPlatforms.length > 0 && (
        <>
          <Divider T={T} />
          <div style={{ padding: "0 0 12px" }}>
            <SectionLabel T={T} style={{ fontSize: 11 * (T.fsScale || 1) }}>Platforms</SectionLabel>
            <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6 }}>{distinctPlatforms.join(", ")}</div>
          </div>
        </>
      )}
    </div>,
    sidebarEl
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, fontFamily: "'DM Sans',sans-serif" }}>
      {sidebarPortal}

      <div style={{ padding: "20px 28px 0", flexShrink: 0 }}>
        <SectionLabel T={T}>Reporting</SectionLabel>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 16 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>Change History</div>
          {canEdit && (
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={syncGoogleNow} disabled={syncingGoogle} variant="ghost" size="sm" T={T} title="Pull the last 30 days of Google Ads changes right now, instead of waiting for tomorrow's automated sync">
                <Icon name="refresh" size={13} color={T.text} />{syncingGoogle ? "Syncing Google…" : "Sync Google now"}
              </Btn>
              <Btn onClick={openAdd} variant="primary" size="sm" T={T}><Icon name="plus" size={13} color={T.onAccent} />Log a change</Btn>
            </div>
          )}
        </div>
        <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6, marginBottom: 16, maxWidth: 720 }}>
          A running log of campaign/ad-group/budget changes across every channel — automatically pulled in where a
          platform's API supports it (Google Ads today), and logged manually everywhere else (Bing, LinkedIn,
          Capterra, and anything not yet automated).
        </div>
      </div>

      {loadError && (
        <div style={{ margin: "0 28px 12px", padding: "9px 14px", borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, color: T.danger }}>{loadError}</div>
      )}
      {notif && (
        <div style={{ margin: "0 28px 12px", padding: "9px 14px", borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), background: notif.type === "error" ? T.dangerBg : T.successBg, border: `1px solid ${notif.type === "error" ? T.dangerBorder : T.successBorder}`, color: notif.type === "error" ? T.danger : T.success }}>{notif.msg}</div>
      )}

      <div style={{ borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, background: T.surfaceEl, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", flexWrap: "wrap" }}>
          <button onClick={() => setFiltersOpen((o) => !o)} title={filtersOpen ? "Hide filters" : "Show filters"}
            style={{ display: "flex", alignItems: "center", gap: 5, background: filtersOpen ? T.surfaceHover : "transparent", border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "3px 8px", cursor: "pointer", fontFamily: T.font, fontSize: 11 * (T.fsScale || 1), fontWeight: 600, color: T.text, outline: "none" }}>
            <Icon name="filter" size={12} color={T.text} />
            Filters
            {hasF && <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.accent, flexShrink: 0 }} />}
          </button>
          {!filtersOpen && hasF && <button onClick={clearF} style={{ background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 11 * (T.fsScale || 1), fontFamily: T.font, textDecoration: "underline", padding: 0, outline: "none" }}>Clear filters</button>}
        </div>
        {filtersOpen && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 16px 12px", flexWrap: "wrap" }}>
            <IconField icon="tag" color={T.textMuted} style={{ width: 150 }}>
              <Sel value={fPlatform} onChange={setFPlatform} T={T} style={{ paddingLeft: 26, fontSize: 12 * (T.fsScale || 1) }}>
                <option value="">All platforms</option>
                {PLATFORM_OPTIONS.filter((p) => p !== "auto").map((p) => <option key={p} value={p}>{p}</option>)}
              </Sel>
            </IconField>
            <IconField icon="bolt" color={T.textMuted} style={{ width: 160 }}>
              <Sel value={fChangeType} onChange={setFChangeType} T={T} style={{ paddingLeft: 26, fontSize: 12 * (T.fsScale || 1) }}>
                <option value="">All change types</option>
                {CHANGE_TYPE_OPTIONS.map((c) => <option key={c} value={c}>{CHANGE_TYPE_LABELS[c]}</option>)}
              </Sel>
            </IconField>
            <IconField icon="download" color={T.textMuted} style={{ width: 140 }}>
              <Sel value={fEntrySource} onChange={setFEntrySource} T={T} style={{ paddingLeft: 26, fontSize: 12 * (T.fsScale || 1) }}>
                <option value="">API + manual</option>
                <option value="api">API only</option>
                <option value="manual">Manual only</option>
              </Sel>
            </IconField>
            <IconField icon="search" color={T.textMuted} style={{ width: 190 }}>
              <input value={fEntity} onChange={(e) => setFEntity(e.target.value)} placeholder="Campaign / ad group / summary…"
                style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "6px 9px 6px 26px", background: T.inputBg, color: T.text, fontFamily: T.font, fontSize: 12 * (T.fsScale || 1) }} />
            </IconField>
            <IconField icon="mail" color={T.textMuted} style={{ width: 150 }}>
              <input value={fChangedBy} onChange={(e) => setFChangedBy(e.target.value)} placeholder="Changed by…"
                style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "6px 9px 6px 26px", background: T.inputBg, color: T.text, fontFamily: T.font, fontSize: 12 * (T.fsScale || 1) }} />
            </IconField>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>From</span>
              <input type="date" value={fStart} onChange={(e) => setFStart(e.target.value)}
                style={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "5px 8px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
              <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>to</span>
              <input type="date" value={fEnd} onChange={(e) => setFEnd(e.target.value)}
                style={{ background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "5px 8px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
            </div>
            {hasF && <Btn onClick={clearF} variant="ghost" size="sm" T={T}>Clear</Btn>}
          </div>
        )}
      </div>

      <div className="bhq-scroll" style={{ flex: 1, overflow: "auto", padding: "16px 28px 28px" }}>
        {rows === null && !loadError && (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading…</div>
        )}
        {rows !== null && filtered.length === 0 && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>
            {rows.length === 0 ? "No changes logged yet — connect a platform's automated pull or log one manually above." : "No changes match the current filters."}
          </div>
        )}
        {filtered.slice(0, PAGE_SIZE_DISPLAY).map((r) => (
          <PixelPanel key={r.id} T={T} style={{ marginBottom: 8, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <Pill color={PLATFORM_COLORS[r.platform] || T.textSub} bg="transparent" border={PLATFORM_COLORS[r.platform] || T.border}>{r.platform}</Pill>
                  <Pill color={T.textSub} bg={T.surfaceEl} border={T.border}>{CHANGE_TYPE_LABELS[r.changeType] || r.changeType}</Pill>
                  {r.entityType && <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted }}>{ENTITY_TYPE_LABELS[r.entityType] || r.entityType}</span>}
                  {r.entityName && <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.text, fontWeight: 600 }}>{r.entityName}</span>}
                </div>
                <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.text, marginBottom: r.details || r.oldValue || r.newValue ? 4 : 0 }}>{r.summary}</div>
                {(r.oldValue || r.newValue) && (
                  <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textSub, marginBottom: r.details ? 4 : 0 }}>
                    {r.oldValue && <span style={{ textDecoration: "line-through", opacity: 0.7 }}>{r.oldValue}</span>}
                    {r.oldValue && r.newValue && " → "}
                    {r.newValue && <span style={{ color: T.text, fontWeight: 600 }}>{r.newValue}</span>}
                  </div>
                )}
                {r.details && <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, lineHeight: 1.5 }}>{r.details}</div>}
                <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginTop: 6 }}>
                  {new Date(r.changedAt).toLocaleString()}
                  {r.changedBy ? ` · ${r.changedBy}` : ""}
                  {" · "}
                  <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>{r.entrySource === "api" ? "Automated" : "Manual"}</span>
                </div>
              </div>
              {canEdit && r.entrySource === "manual" && (
                <button onClick={() => removeEntry(r)} disabled={busy} title="Delete this logged change"
                  style={{ background: "transparent", border: "none", cursor: busy ? "not-allowed" : "pointer", padding: 4, flexShrink: 0, opacity: busy ? 0.5 : 1 }}>
                  <Icon name="trash" size={14} color={T.textMuted} />
                </button>
              )}
            </div>
          </PixelPanel>
        ))}
        {filtered.length > PAGE_SIZE_DISPLAY && (
          <div style={{ textAlign: "center", fontSize: 11 * (T.fsScale || 1), color: T.textMuted, padding: "10px 0" }}>
            Showing the {PAGE_SIZE_DISPLAY.toLocaleString()} most recent of {filtered.length.toLocaleString()} matching events — narrow the filters to see more.
          </div>
        )}
      </div>

      {addOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={() => !saving && setAddOpen(false)}>
          <div style={{ width: 480, maxWidth: "100%", maxHeight: "88vh", overflow: "auto", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r8, boxShadow: T.shadowMd, fontFamily: T.font }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.border}`, fontSize: 15 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>Log a change</div>
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Platform</div>
                  <Sel value={entry.platform} onChange={(v) => setEntry((e) => ({ ...e, platform: v }))} T={T}>
                    {PLATFORM_OPTIONS.filter((p) => p !== "auto").map((p) => <option key={p} value={p}>{p}</option>)}
                  </Sel>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Change type</div>
                  <Sel value={entry.changeType} onChange={(v) => setEntry((e) => ({ ...e, changeType: v }))} T={T}>
                    {CHANGE_TYPE_OPTIONS.map((c) => <option key={c} value={c}>{CHANGE_TYPE_LABELS[c]}</option>)}
                  </Sel>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Entity type</div>
                  <Sel value={entry.entityType} onChange={(v) => setEntry((e) => ({ ...e, entityType: v }))} T={T}>
                    {ENTITY_TYPE_OPTIONS.map((c) => <option key={c} value={c}>{ENTITY_TYPE_LABELS[c]}</option>)}
                  </Sel>
                </div>
                <div style={{ flex: 2 }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Campaign / ad group name</div>
                  <input value={entry.entityName} onChange={(e) => setEntry((s) => ({ ...s, entityName: e.target.value }))}
                    style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Summary *</div>
                <input autoFocus value={entry.summary} onChange={(e) => setEntry((s) => ({ ...s, summary: e.target.value }))}
                  placeholder="e.g. Increased daily budget on Brand Search"
                  style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Old value</div>
                  <input value={entry.oldValue} onChange={(e) => setEntry((s) => ({ ...s, oldValue: e.target.value }))}
                    style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>New value</div>
                  <input value={entry.newValue} onChange={(e) => setEntry((s) => ({ ...s, newValue: e.target.value }))}
                    style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Details</div>
                <textarea value={entry.details} onChange={(e) => setEntry((s) => ({ ...s, details: e.target.value }))} rows={3}
                  style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font, resize: "vertical" }} />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Changed by</div>
                  <input value={entry.changedBy} onChange={(e) => setEntry((s) => ({ ...s, changedBy: e.target.value }))}
                    style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>When *</div>
                  <input type="datetime-local" value={entry.changedAt} onChange={(e) => setEntry((s) => ({ ...s, changedAt: e.target.value }))}
                    style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
                </div>
              </div>
            </div>
            <div style={{ padding: "14px 20px", borderTop: `1px solid ${T.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={() => setAddOpen(false)} variant="ghost" T={T} disabled={saving}>Cancel</Btn>
              <Btn onClick={submitAdd} variant="primary" T={T} disabled={saving || !entry.summary.trim() || !entry.changedAt}>{saving ? "Saving…" : "Log change"}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
