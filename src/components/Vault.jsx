import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Btn, Icon, Pill, IconField, SectionLabel, Divider, StatRow, PixelPanel } from "./shared.jsx";
import { listVaultEntries, getVaultEntry, createVaultEntry, updateVaultEntry, deleteVaultEntry } from "../lib/vaultApi.js";
import { uploadFile, downloadFile, deleteFile, fileToBase64 } from "../lib/workspaceApi.js";
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

export default function Vault({ T, session, workspace, canEdit, sidebarEl }) {
  const k = (suffix) => `paidhq_vault_${suffix}`;
  const [rows, setRows] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [notif, setNotif] = useState(null);

  const [filtersOpen, setFiltersOpen] = usePersistentState(k("filtersOpen"), true);
  const [fCategory, setFCategory] = usePersistentState(k("fCategory"), "");
  const [fTag, setFTag] = usePersistentState(k("fTag"), "");
  const [fSearch, setFSearch] = usePersistentState(k("fSearch"), "");

  const [modalOpen, setModalOpen] = useState(false);
  const [entry, setEntry] = useState(emptyEntry);
  const [tagsInput, setTagsInput] = useState(""); // comma-separated, synced from entry.tags when the modal opens
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState([]); // attachments of the entry currently open in the modal
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
  }, [rows, fCategory, fTag, fSearch]);

  const hasF = fCategory || fTag || fSearch;
  const clearF = () => { setFCategory(""); setFTag(""); setFSearch(""); };

  const openNew = () => {
    setEntry(emptyEntry());
    setTagsInput("");
    setFiles([]);
    setModalOpen(true);
  };

  const openEdit = async (row) => {
    setModalOpen(true);
    setEntryLoading(true);
    setEntry({ id: row.id, title: row.title, category: row.category, tags: row.tags || [], content: "" });
    setTagsInput((row.tags || []).join(", "));
    setFiles([]);
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
        showNotif("Entry created — you can now attach files below");
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
    if (!canEdit || !entry.id || !fileList?.length) return;
    setUploading(true);
    try {
      for (const f of fileList) {
        const dataBase64 = await fileToBase64(f);
        const uploaded = await uploadFile(session, workspace.id, { name: f.name, category: "Vault attachment", mimeType: f.type || "", dataBase64, vaultEntryId: entry.id });
        setFiles((prev) => [{ id: uploaded.id, name: uploaded.name, mimeType: uploaded.mimeType, size: uploaded.size, createdAt: uploaded.createdAt }, ...prev]);
      }
      showNotif(`Attached ${fileList.length} file${fileList.length === 1 ? "" : "s"}`);
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
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, fontFamily: "'DM Sans',sans-serif" }}>
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

      <div className="bhq-scroll" style={{ flex: 1, overflow: "auto", padding: "16px 28px 28px" }}>
        {rows === null && !loadError && <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>Loading…</div>}
        {rows !== null && filtered.length === 0 && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 * (T.fsScale || 1) }}>
            {rows.length === 0 ? "Nothing in the Vault yet — add a brief, strategy note, or sales asset above." : "No entries match the current filters."}
          </div>
        )}
        {filtered.map((r) => (
          <PixelPanel key={r.id} T={T} style={{ marginBottom: 8, padding: "12px 14px", cursor: "pointer" }} onClick={() => openEdit(r)}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <Pill color={T.textSub} bg={T.surfaceEl} border={T.border}>{r.category}</Pill>
                  <span style={{ fontSize: 13 * (T.fsScale || 1), fontWeight: 600, color: T.text }}>{r.title}</span>
                </div>
                {r.excerpt && <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, lineHeight: 1.5, marginBottom: (r.tags || []).length ? 6 : 0 }}>{r.excerpt}{r.excerpt.length >= 240 ? "…" : ""}</div>}
                {(r.tags || []).length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
                    {r.tags.map((t) => <span key={t} style={{ fontSize: 11 * (T.fsScale || 1), padding: "2px 8px", borderRadius: T.r14, background: T.accentBg, color: T.text, border: `1px solid ${T.accentBorder}` }}>{t}</span>)}
                  </div>
                )}
                <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginTop: 6 }}>Updated {new Date(r.updatedAt).toLocaleString()}</div>
              </div>
              {canEdit && (
                <button onClick={(e) => { e.stopPropagation(); removeEntry(r); }} title="Delete this entry"
                  style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4, flexShrink: 0 }}>
                  <Icon name="trash" size={14} color={T.textMuted} />
                </button>
              )}
            </div>
          </PixelPanel>
        ))}
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

                  {entry.id ? (
                    <div>
                      <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, marginBottom: 6, fontWeight: 600 }}>Attachments</div>
                      {files.length === 0 && <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, marginBottom: 8 }}>No files attached yet.</div>}
                      {files.map((f) => (
                        <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
                          <Icon name="file" size={13} color={T.textMuted} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12 * (T.fsScale || 1), color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                          <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, flexShrink: 0 }}>{fmtSize(f.size)}</span>
                          <button onClick={() => downloadFile(session, workspace.id, f.id, f.name)} title="Download" style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }}><Icon name="download" size={13} color={T.textMuted} /></button>
                          {canEdit && <button onClick={() => removeAttachment(f)} title="Remove" style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }}><Icon name="trash" size={13} color={T.textMuted} /></button>}
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
                  ) : (
                    <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, fontStyle: "italic" }}>Save this entry first to attach files.</div>
                  )}
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
