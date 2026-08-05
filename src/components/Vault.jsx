import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Btn, Icon, IconField, SectionLabel, Divider, StatRow } from "./shared.jsx";
import { listVaultEntries, getVaultEntry, createVaultEntry, updateVaultEntry, deleteVaultEntry } from "../lib/vaultApi.js";
import { uploadFileViaBlob, downloadFile, deleteFile } from "../lib/workspaceApi.js";
import { listMembers } from "../lib/coreApi.js";
import { splitFilterTerms, matchesTerms } from "../lib/core.js";
import { usePersistentState } from "../lib/persist.js";
import { exportEntryAsPdf, exportEntryAsPptx, exportEntryAsXlsx, copyEntryForNotion } from "../lib/vaultExport.js";

/**
 * Vault (Phase 2: UI, per Mo — folding VaultHQ's document/resource storage into PaidHQ). Phase 1
 * (schema + api/workspaces/[id]/vault-entries.js + src/lib/vaultApi.js) already shipped — see those
 * files' own doc comments for the full scope decisions (Project == workspace 1:1, storage only this
 * phase, attachments reuse the existing core.files table rather than a second storage backend).
 *
 * Deliberately NOT included yet (VaultHQ has these, this port doesn't): the chat/tool-use loop,
 * web search, TTS/STT, create_asset (chat-drafts-a-file), and PDF/PPTX/XLSX export — Ask AI
 * grounding is an explicitly separate later phase per Mo, and asset export is its own follow-up
 * phase (needs pptxgenjs/mammoth added to package.json, not yet done). This phase is: browse/filter
 * entries, create/edit an entry's title/category/tags/markdown content, attach/download/remove
 * files. Structurally closest to ChangeHistory.jsx (filter bar + feed + one add/edit modal) since
 * an entry, like a change event, is a single record being edited as a whole — not a metric row
 * needing Campaign Tagger's grouping/bulk-tag-apply machinery.
 *
 * ATTACHMENTS ON A BRAND-NEW ENTRY: uploading a file needs a real entryId to link it to (see
 * files.js's vaultEntryId param), which doesn't exist until the entry's first save. Rather than a
 * two-step "create, then reopen to attach" flow, submitEntry keeps the modal open after a create
 * and switches it into edit mode using the newly-returned id — the attachments panel (hidden for a
 * brand-new, unsaved entry) then becomes available immediately without closing anything.
 */

const CATEGORY_SUGGESTIONS = ["General", "Campaign Brief", "Strategy", "Sales Asset", "Audit", "Research"];

const emptyEntry = () => ({ id: null, title: "", category: "General", tags: [], content: "" });

const fIn = { background: "transparent", border: "none", outline: "none", width: "100%" };

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Deterministic string -> T.badgeColors index (2026-08-19, per Mo's Notion Document Hub reference
// screenshot — colored category pills + per-person avatar circles, same color every time for the
// same category/person rather than random-per-render). Simple additive char-code hash, not
// cryptographic — collisions are fine here (a shared color between two categories/people is a
// cosmetic non-issue, not a correctness one).
function hashColor(str, colors) {
  let h = 0;
  for (let i = 0; i < String(str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function Vault({ T, session, workspace, canEdit, sidebarEl }) {
  const k = (suffix) => `paidhq_vault_${suffix}`;
  const [rows, setRows] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [notif, setNotif] = useState(null);

  const [filtersOpen, setFiltersOpen] = usePersistentState(k("filtersOpen"), true);
  const [fCategory, setFCategory] = usePersistentState(k("fCategory"), "");
  const [fTag, setFTag] = usePersistentState(k("fTag"), "");
  const [fSearch, setFSearch] = usePersistentState(k("fSearch"), "");
  // "all" | "mine" — the reference screenshot's "All Docs"/"My Docs" tabs, filtering on createdBy.
  const [docsScope, setDocsScope] = usePersistentState(k("docsScope"), "all");

  // Workspace members, fetched here rather than threaded down from PaidHQ.jsx (2026-08-19, per
  // Mo's Notion table redesign — Created by / Last edited by columns need to resolve a userId to
  // an email) — PaidHQ.jsx only loads its own team list when the Settings view is active, so
  // reaching Vault directly (its own nav tab) would otherwise see an empty list. Self-contained,
  // matches how this component already independently owns its session/workspace-scoped fetches.
  const [members, setMembers] = useState([]);
  useEffect(() => {
    if (!workspace?.id || !session) return;
    listMembers(session, workspace.id).then(setMembers).catch(() => {});
  }, [workspace?.id, session]);
  const memberByUserId = useMemo(() => Object.fromEntries(members.map((m) => [m.userId, m])), [members]);
  // Falls back to the signed-in user's own session email if the membership list hasn't loaded yet
  // and the row happens to be theirs — avoids a flash of "—" for your own just-created entries.
  const personLabel = useCallback(
    (userId) => memberByUserId[userId]?.email || (userId && userId === session?.user?.id ? session?.user?.email : null) || null,
    [memberByUserId, session?.user?.id, session?.user?.email]
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [entry, setEntry] = useState(emptyEntry);
  const [tagsInput, setTagsInput] = useState(""); // comma-separated, synced from entry.tags when the modal opens
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState([]); // attachments of the entry currently open in the modal
  // Staged File objects for a brand-new, not-yet-saved entry (2026-08-19, per Mo — "make sure we
  // can attach on the first dialogue, no need for two popups"). Files picked before the entry is
  // saved can't be uploaded yet (files.js's vaultEntryId needs a real entryId — see this file's top
  // doc comment), so they're held here and uploaded automatically right after creation succeeds, in
  // the same submitEntry() call the user already triggered by clicking "Create entry" — one action,
  // not a separate save-then-attach round trip.
  const [pendingFiles, setPendingFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [entryLoading, setEntryLoading] = useState(false);

  const showNotif = (msg, type = "success") => {
    setNotif({ msg, type });
    setTimeout(() => setNotif(null), type === "error" ? 7000 : 3000);
  };

  const refresh = useCallback(() => {
    listVaultEntries(session, workspace.id)
      .then((r) => { setRows(r); setLoadError(""); })
      .catch((err) => setLoadError(err.message || "Couldn't load the Vault."));
  }, [session, workspace.id]);
  useEffect(() => { refresh(); }, [refresh]);

  const distinctCategories = useMemo(() => {
    const fromRows = new Set((rows || []).map((r) => r.category).filter(Boolean));
    CATEGORY_SUGGESTIONS.forEach((c) => fromRows.add(c));
    return Array.from(fromRows).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return (rows || []).filter((r) => {
      if (docsScope === "mine" && r.createdBy !== session?.user?.id) return false;
      if (fCategory && r.category !== fCategory) return false;
      if (fTag) {
        const terms = splitFilterTerms(fTag);
        const hay = (r.tags || []).join(" ").toLowerCase();
        if (terms.length && !matchesTerms(hay, terms, "or")) return false;
      }
      if (fSearch) {
        const terms = splitFilterTerms(fSearch);
        const hay = `${r.title || ""} ${r.excerpt || ""}`.toLowerCase();
        if (terms.length && !matchesTerms(hay, terms, "or")) return false;
      }
      return true;
    });
  }, [rows, docsScope, session?.user?.id, fCategory, fTag, fSearch]);

  const hasF = fCategory || fTag || fSearch;
  const clearF = () => { setFCategory(""); setFTag(""); setFSearch(""); };

  const openNew = () => {
    setEntry(emptyEntry());
    setTagsInput("");
    setFiles([]);
    setPendingFiles([]);
    setModalOpen(true);
  };

  const openEdit = async (row) => {
    setModalOpen(true);
    setEntryLoading(true);
    setEntry({ id: row.id, title: row.title, category: row.category, tags: row.tags || [], content: "" });
    setTagsInput((row.tags || []).join(", "));
    setFiles([]);
    setPendingFiles([]);
    try {
      const { entry: full, files: attached } = await getVaultEntry(session, workspace.id, row.id);
      setEntry({ id: full.id, title: full.title, category: full.category, tags: full.tags || [], content: full.content || "" });
      setTagsInput((full.tags || []).join(", "));
      setFiles(attached || []);
    } catch (err) {
      showNotif(err.message || "Couldn't load this entry", "error");
    } finally {
      setEntryLoading(false);
    }
  };

  const closeModal = () => { if (!saving && !uploading) setModalOpen(false); };

  // Shared by attachFiles (existing entry, uploads immediately) and submitEntry's create branch
  // (new entry, uploads whatever was staged in pendingFiles right after the entry itself is
  // created) — see pendingFiles' own doc comment above for why a new entry needs this split.
  const uploadFilesToEntry = async (entryId, fileList) => {
    const uploaded = [];
    for (const f of fileList) {
      const u = await uploadFileViaBlob(session, workspace.id, f, { category: "Vault attachment", vaultEntryId: entryId });
      uploaded.push({ id: u.id, name: u.name, mimeType: u.mimeType, size: u.size, createdAt: u.createdAt });
    }
    return uploaded;
  };

  const submitEntry = async () => {
    if (!canEdit || !entry.title.trim()) return;
    setSaving(true);
    const tags = splitFilterTerms(tagsInput).length ? tagsInput.split(",").map((t) => t.trim()).filter(Boolean) : [];
    try {
      if (entry.id) {
        const updated = await updateVaultEntry(session, workspace.id, { entryId: entry.id, title: entry.title.trim(), category: entry.category, tags, content: entry.content });
        setEntry((e) => ({ ...e, ...updated }));
        showNotif("Entry saved");
      } else {
        // See this file's top doc comment — keep the modal open and switch into edit mode using the
        // new id, so attachments become available immediately instead of a close/reopen round trip.
        const created = await createVaultEntry(session, workspace.id, { title: entry.title.trim(), category: entry.category, tags, content: entry.content });
        setEntry((e) => ({ ...e, id: created.id }));
        if (pendingFiles.length) {
          setUploading(true);
          try {
            const uploaded = await uploadFilesToEntry(created.id, pendingFiles);
            setFiles(uploaded);
            setPendingFiles([]);
            showNotif(`Entry created with ${uploaded.length} attachment${uploaded.length === 1 ? "" : "s"}`);
          } catch (err) {
            // The entry itself saved fine — only the attachment step failed. Surfacing that
            // distinction matters: this is NOT "your entry didn't save," just "attach again below."
            showNotif(`Entry created, but attaching files failed: ${err.message || "unknown error"}`, "error");
          } finally {
            setUploading(false);
          }
        } else {
          showNotif("Entry created");
        }
      }
      refresh();
    } catch (err) {
      showNotif(err.message || "Failed to save entry", "error");
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = async (row) => {
    if (!canEdit) return;
    if (!window.confirm(`Delete "${row.title}"? This also removes its attachments. This cannot be undone.`)) return;
    try {
      await deleteVaultEntry(session, workspace.id, row.id);
      setRows((prev) => (prev || []).filter((x) => x.id !== row.id));
      showNotif("Deleted");
    } catch (err) {
      showNotif(err.message || "Delete failed", "error");
    }
  };

  const attachFiles = async (fileList) => {
    if (!canEdit || !fileList?.length) return;
    if (!entry.id) {
      // No real entryId yet — stage locally instead of uploading now (see pendingFiles' doc
      // comment above). The exact same "Attach files" control is shown either way, so from the
      // user's side picking files works identically whether the entry is new or already saved.
      setPendingFiles((prev) => [...prev, ...Array.from(fileList)]);
      return;
    }
    setUploading(true);
    try {
      // Always goes straight to Vercel Blob rather than base64-through-the-function (2026-08-19,
      // per Mo — a >10MB attachment upload was failing with a generic "request failed", really
      // Vercel's hard 4.5MB serverless body limit — see blob-upload-token.js's doc comment).
      // Attachments here are real documents (PDFs, decks, briefs), not small system-generated
      // files, so unlike archiveFile's size-threshold split in PaidHQ.jsx there's no small-file
      // fast path worth keeping — one upload method, no size guessing.
      const uploaded = await uploadFilesToEntry(entry.id, fileList);
      setFiles((prev) => [...uploaded, ...prev]);
      showNotif(`Attached ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}`);
    } catch (err) {
      showNotif(err.message || "Attach failed", "error");
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = async (f) => {
    if (!canEdit) return;
    if (!window.confirm(`Remove "${f.name}"?`)) return;
    try {
      await deleteFile(session, workspace.id, f.id);
      setFiles((prev) => prev.filter((x) => x.id !== f.id));
      showNotif("Attachment removed");
    } catch (err) {
      showNotif(err.message || "Remove failed", "error");
    }
  };

  // Removes a staged (not-yet-uploaded) file by index — no API call needed, it was never sent
  // anywhere yet.
  const removePendingFile = (idx) => setPendingFiles((prev) => prev.filter((_, i) => i !== idx));

  // Asset export (Phase 3) — operates on whatever's currently in the modal, including an unsaved
  // draft's title/content (unlike attachments, which genuinely need a persisted entryId, there's no
  // reason to block a read-only export of a draft that hasn't been saved yet).
  const [exportingPptx, setExportingPptx] = useState(false);
  const doExportPdf = () => {
    try { exportEntryAsPdf(entry); } catch (err) { showNotif(err.message || "PDF export failed", "error"); }
  };
  const doExportPptx = async () => {
    setExportingPptx(true);
    try { await exportEntryAsPptx(entry); } catch (err) { showNotif(err.message || "PPTX export failed", "error"); } finally { setExportingPptx(false); }
  };
  const doExportXlsx = () => {
    try { exportEntryAsXlsx(entry); } catch (err) { showNotif(err.message || "XLSX export failed", "error"); }
  };
  const doCopyNotion = async () => {
    try { await copyEntryForNotion(entry); showNotif("Copied — paste into Notion or Docs"); } catch (err) { showNotif(err.message || "Copy failed", "error"); }
  };

  const sidebarPortal = sidebarEl && createPortal(
    <div className="bhq-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <SectionLabel T={T} style={{ marginBottom: 8, fontSize: 11 * (T.fsScale || 1) }}>Vault</SectionLabel>
      <div style={{ padding: "12px 0" }}>
        <SectionLabel T={T} style={{ fontSize: 11 * (T.fsScale || 1) }}>Overview</SectionLabel>
        <StatRow T={T} size={11} label="Total entries" value={(rows || []).length.toLocaleString()} />
        <StatRow T={T} size={11} label="Showing" value={filtered.length.toLocaleString()} />
      </div>
      {distinctCategories.length > 0 && (
        <>
          <Divider T={T} />
          <div style={{ padding: "0 0 12px" }}>
            <SectionLabel T={T} style={{ fontSize: 11 * (T.fsScale || 1) }}>Categories</SectionLabel>
            <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6 }}>{distinctCategories.join(", ")}</div>
          </div>
        </>
      )}
    </div>,
    sidebarEl
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, fontFamily: T.font }}>
      {sidebarPortal}

      <div style={{ padding: "20px 28px 0", flexShrink: 0 }}>
        <SectionLabel T={T}>Resources</SectionLabel>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 16 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>Vault</div>
          {canEdit && <Btn onClick={openNew} variant="primary" size="sm" T={T}><Icon name="plus" size={13} color={T.onAccent} />New entry</Btn>}
        </div>
        <div style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub, lineHeight: 1.6, marginBottom: 16, maxWidth: 720 }}>
          A reusable store of documents and resources for this workspace — briefs, strategy notes, audit findings, sales assets — with file attachments alongside each entry.
        </div>
      </div>

      {loadError && <div style={{ margin: "0 28px 12px", padding: "9px 14px", borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, color: T.danger }}>{loadError}</div>}
      {notif && <div style={{ margin: "0 28px 12px", padding: "9px 14px", borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), background: notif.type === "error" ? T.dangerBg : T.successBg, border: `1px solid ${notif.type === "error" ? T.dangerBorder : T.successBorder}`, color: notif.type === "error" ? T.danger : T.success }}>{notif.msg}</div>}

      <div style={{ borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, background: T.surfaceEl, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", flexWrap: "wrap" }}>
          {/* All Docs / My Docs (2026-08-19, per Mo's Notion Document Hub reference screenshot) —
              filters on createdBy rather than a real ownership concept, since every entry is
              already shared workspace-wide either way; "mine" just means "created by me". */}
          <div style={{ display: "flex", gap: 4 }}>
            {[{ key: "all", label: "All Docs" }, { key: "mine", label: "My Docs" }].map((opt) => (
              <button key={opt.key} onClick={() => setDocsScope(opt.key)}
                style={{ display: "flex", alignItems: "center", gap: 5, background: docsScope === opt.key ? T.surface : "transparent", border: `1px solid ${docsScope === opt.key ? T.border : "transparent"}`, borderRadius: T.r20, padding: "3px 10px", cursor: "pointer", fontFamily: T.font, fontSize: 11 * (T.fsScale || 1), fontWeight: 600, color: docsScope === opt.key ? T.text : T.textMuted, outline: "none" }}>
                {opt.label}
              </button>
            ))}
          </div>
          <div style={{ width: 1, alignSelf: "stretch", background: T.border, margin: "2px 2px" }} />
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
            <IconField icon="tag" color={T.textMuted} style={{ width: 170 }}>
              <select value={fCategory} onChange={(e) => setFCategory(e.target.value)}
                style={{ width: "100%", cursor: "pointer", border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "6px 9px 6px 26px", fontSize: 12 * (T.fsScale || 1), background: T.inputBg, color: T.text, fontFamily: T.font }}>
                <option value="">All categories</option>
                {distinctCategories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </IconField>
            <IconField icon="search" color={T.textMuted} style={{ width: 190 }}>
              <input value={fTag} onChange={(e) => setFTag(e.target.value)} placeholder="Tag…"
                style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "6px 9px 6px 26px", background: T.inputBg, color: T.text, fontFamily: T.font, fontSize: 12 * (T.fsScale || 1) }} />
            </IconField>
            <IconField icon="search" color={T.textMuted} style={{ width: 220 }}>
              <input value={fSearch} onChange={(e) => setFSearch(e.target.value)} placeholder="Search title / content…"
                style={{ ...fIn, paddingLeft: 26, border: `1px solid ${T.border}`, borderRadius: T.r6, padding: "6px 9px 6px 26px", background: T.inputBg, color: T.text, fontFamily: T.font, fontSize: 12 * (T.fsScale || 1) }} />
            </IconField>
            {hasF && <Btn onClick={clearF} variant="ghost" size="sm" T={T}>Clear</Btn>}
          </div>
        )}
      </div>

      {/* Table (2026-08-19, per Mo's Notion Document Hub reference screenshot) — replaces the
          original card list. Doc name / Category / Created by / Created time / Last edited by /
          Last updated time columns, matching the reference exactly; tags and the content excerpt
          that used to show under the title in the old card layout are dropped from this row (still
          editable inside the entry modal, just not part of this table's columns, same as the
          reference doesn't show them either). "Last edited by" intentionally shows the SAME person
          as "Created by" — see vault-entries.js's toListItem doc comment for why (no updated_by
          tracking, this was Mo's own call rather than adding it). */}
      <div className="bhq-scroll" style={{ flex: 1, overflow: "auto", padding: "0 28px 28px" }}>
        {rows === null && !loadError && <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading…</div>}
        {rows !== null && filtered.length === 0 && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>
            {rows.length === 0 ? "Nothing in the Vault yet — add a brief, strategy note, or sales asset above." : "No entries match the current filters."}
          </div>
        )}
        {rows !== null && filtered.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.font }}>
            <thead>
              <tr>
                {["Doc name", "Category", "Created by", "Created time", "Last edited by", "Last updated time"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "10px 12px", fontSize: 11 * (T.fsScale || 1), fontWeight: 600, color: T.textMuted, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap", position: "sticky", top: 0, background: T.surface }}>
                    {h}
                  </th>
                ))}
                {canEdit && <th style={{ borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, background: T.surface, width: 32 }} />}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const catColor = hashColor(r.category || "General", T.badgeColors);
                const label = personLabel(r.createdBy);
                const personColor = hashColor(label || r.createdBy || "?", T.badgeColors);
                const avatar = (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", background: personColor, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: "#FFFFFF" }}>
                      {(label || "?")[0].toUpperCase()}
                    </div>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 * (T.fsScale || 1), color: T.textSub }}>{label || "Unknown"}</span>
                  </div>
                );
                return (
                  <tr key={r.id} onClick={() => openEdit(r)} className="bhq-row"
                    style={{ cursor: "pointer", borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px", fontSize: 13 * (T.fsScale || 1), fontWeight: 600, color: T.text, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Icon name="file" size={14} color={T.textMuted} />
                        {r.title}
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{ display: "inline-block", fontSize: 11 * (T.fsScale || 1), fontWeight: 600, padding: "2px 9px", borderRadius: T.r20, background: catColor + "14", color: catColor, border: `1px solid ${catColor}55` }}>{r.category}</span>
                    </td>
                    <td style={{ padding: "10px 12px" }}>{avatar}</td>
                    <td style={{ padding: "10px 12px", fontSize: 12 * (T.fsScale || 1), color: T.textSub, whiteSpace: "nowrap" }}>{fmtDate(r.createdAt)}</td>
                    <td style={{ padding: "10px 12px" }}>{avatar}</td>
                    <td style={{ padding: "10px 12px", fontSize: 12 * (T.fsScale || 1), color: T.textSub, whiteSpace: "nowrap" }}>{fmtDate(r.updatedAt)}</td>
                    {canEdit && (
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>
                        <button onClick={(e) => { e.stopPropagation(); removeEntry(r); }} title="Delete this entry"
                          style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }}>
                          <Icon name="trash" size={13} color={T.textMuted} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {canEdit && (
                <tr onClick={openNew} className="bhq-row" style={{ cursor: "pointer" }}>
                  <td colSpan={6} style={{ padding: "10px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 * (T.fsScale || 1), color: T.textMuted }}>
                      <Icon name="plus" size={13} color={T.textMuted} />
                      New doc
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {modalOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={closeModal}>
          <div style={{ width: 720, maxWidth: "100%", maxHeight: "90vh", overflow: "auto", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r8, boxShadow: T.shadowMd, fontFamily: T.font }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.border}`, fontSize: 15 * (T.fsScale || 1), fontWeight: 700, color: T.text }}>{entry.id ? "Edit entry" : "New entry"}</div>
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              {entryLoading ? (
                <div style={{ padding: 20, textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading…</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 10 }}>
                    <div style={{ flex: 2 }}>
                      <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Title *</div>
                      <input autoFocus value={entry.title} onChange={(e) => setEntry((s) => ({ ...s, title: e.target.value }))} placeholder="e.g. Q3 Paid Social Strategy"
                        style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Category</div>
                      <input list="vault-category-suggestions" value={entry.category} onChange={(e) => setEntry((s) => ({ ...s, category: e.target.value }))}
                        style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
                      <datalist id="vault-category-suggestions">{CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c} />)}</datalist>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Tags (comma-separated)</div>
                    <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="e.g. q3, brand, competitive"
                      style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "6px 10px", fontSize: 12 * (T.fsScale || 1), outline: "none", fontFamily: T.font }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Content</div>
                    <textarea value={entry.content} onChange={(e) => setEntry((s) => ({ ...s, content: e.target.value }))} rows={12} placeholder="Markdown — ## headings, pipe tables, - bullets, **bold**…"
                      style={{ width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text, padding: "10px", fontSize: 12.5 * (T.fsScale || 1), outline: "none", fontFamily: "ui-monospace,monospace", resize: "vertical", lineHeight: 1.6 }} />
                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      <Btn onClick={doExportPdf} disabled={!entry.content.trim()} variant="ghost" size="sm" T={T}>Export PDF</Btn>
                      <Btn onClick={doExportPptx} disabled={!entry.content.trim() || exportingPptx} variant="ghost" size="sm" T={T}>{exportingPptx ? "Exporting…" : "Export PPTX"}</Btn>
                      <Btn onClick={doExportXlsx} disabled={!entry.content.trim()} variant="ghost" size="sm" T={T}>Export XLSX</Btn>
                      <Btn onClick={doCopyNotion} disabled={!entry.content.trim()} variant="ghost" size="sm" T={T}>Copy for Notion/Docs</Btn>
                    </div>
                  </div>

                  {/* Attachments (2026-08-19, per Mo — "make sure we can attach on the first
                      dialogue, no need for two popups") — the same control now works for a
                      brand-new, not-yet-saved entry too: picking files here stages them in
                      pendingFiles rather than uploading immediately (see attachFiles' own branch
                      for why), and they upload automatically the moment submitEntry() creates the
                      entry. No separate "save first, then come back and attach" step anymore. */}
                  <div>
                    <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 6, fontWeight: 600 }}>Attachments</div>
                    {files.length === 0 && pendingFiles.length === 0 && <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, marginBottom: 8 }}>No files attached yet.</div>}
                    {files.map((f) => (
                      <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
                        <Icon name="file" size={13} color={T.textMuted} />
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12 * (T.fsScale || 1), color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                        <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, flexShrink: 0 }}>{fmtSize(f.size)}</span>
                        <button onClick={() => downloadFile(session, workspace.id, f.id, f.name)} title="Download" style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }}><Icon name="download" size={13} color={T.textMuted} /></button>
                        {canEdit && <button onClick={() => removeAttachment(f)} title="Remove" style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }}><Icon name="trash" size={13} color={T.textMuted} /></button>}
                      </div>
                    ))}
                    {pendingFiles.map((f, i) => (
                      <div key={`pending-${i}-${f.name}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
                        <Icon name="paperclip" size={13} color={T.textMuted} />
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12 * (T.fsScale || 1), color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                        <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, flexShrink: 0 }}>{fmtSize(f.size)} · will attach on save</span>
                        {canEdit && <button onClick={() => removePendingFile(i)} title="Remove" style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }}><Icon name="trash" size={13} color={T.textMuted} /></button>}
                      </div>
                    ))}
                    {canEdit && (
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, padding: "6px 12px", border: `1px solid ${T.border}`, borderRadius: T.r6, cursor: uploading ? "not-allowed" : "pointer", fontSize: 12 * (T.fsScale || 1), color: T.text, opacity: uploading ? 0.6 : 1 }}>
                        <Icon name="paperclip" size={13} color={T.text} />
                        {uploading ? "Uploading…" : "Attach files"}
                        <input type="file" multiple disabled={uploading} style={{ display: "none" }} onChange={(e) => { attachFiles(e.target.files); e.target.value = ""; }} />
                      </label>
                    )}
                  </div>
                </>
              )}
            </div>
            <div style={{ padding: "14px 20px", borderTop: `1px solid ${T.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={closeModal} variant="ghost" T={T} disabled={saving || uploading}>{entry.id ? "Close" : "Cancel"}</Btn>
              {canEdit && <Btn onClick={submitEntry} variant="primary" T={T} disabled={saving || uploading || entryLoading || !entry.title.trim()}>{saving ? "Saving…" : entry.id ? "Save changes" : "Create entry"}</Btn>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
