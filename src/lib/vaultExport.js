/**
 * Vault (Phase 3: asset export, per Mo — 2026-08-19) — turns a Vault entry's markdown content into
 * a real downloadable PDF/PPTX/XLSX, or a clipboard copy suited for pasting into Notion/Docs.
 * Ported from VaultHQ's own markdown dialect (## headings, pipe tables, - bullets, **bold**) and
 * its "one slide per ## section" / "one sheet per markdown table" export shape — VaultHQ's actual
 * source wasn't available to copy from directly (private repo, no local clone — see this session's
 * earlier chat-summary hand-off), so parseMarkdownBlocks below is a fresh implementation built to
 * that same documented dialect and export shape, not a byte-for-byte port.
 *
 * SCOPE NOTE: VaultHQ's file-ingestion side (DOCX via `mammoth`, native PDF via Anthropic's document
 * blocks, PPTX slide-text via `jszip`) is NOT part of this — that's for reading an uploaded file
 * INTO chat context, which Vault Phase 1/2 already deferred (no chat this phase). This file is the
 * other direction only: entry content OUT as a real file. `mammoth` was deliberately not added to
 * package.json for that reason — flagged to Mo rather than silently skipped.
 *
 * MARKDOWN DIALECT (matches VaultHQ's documented one): `## Heading` (2-6 #'s), pipe tables
 * (`| a | b |` rows, a `|---|---|` separator row is recognized and dropped, not rendered), `- ` or
 * `* ` bullet lines, and `**bold**` inline (stripped to plain text in generated files — PDF/PPTX/
 * XLSX cell-level bold-run formatting is a real feature gap, not attempted here; Copy-for-Notion
 * keeps the raw ** markers since Notion parses them natively on paste).
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";

// ─── PARSER ───────────────────────────────────────────────────────────────────────────────────
// Returns an array of blocks: {type:"heading",text} | {type:"paragraph",text} |
// {type:"bullets",items:[...]} | {type:"table",headers:[...],rows:[[...]]}
export function parseMarkdownBlocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length) { blocks.push({ type: "paragraph", text: paraBuf.join(" ").trim() }); paraBuf = []; }
  };

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    const heading = trimmed.match(/^#{2,6}\s+(.*)$/);
    if (heading) { flushPara(); blocks.push({ type: "heading", text: heading[1].trim() }); i++; continue; }

    if (/^\|.*\|$/.test(trimmed)) {
      flushPara();
      const tableLines = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { tableLines.push(lines[i].trim()); i++; }
      const parsedRows = tableLines
        .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()))
        .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c))); // drop the |---|---| separator row
      if (parsedRows.length) {
        const [headers, ...rows] = parsedRows;
        blocks.push({ type: "table", headers, rows });
      }
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*]\s+/, "")); i++; }
      blocks.push({ type: "bullets", items });
      continue;
    }

    if (!trimmed) { flushPara(); i++; continue; }

    paraBuf.push(trimmed);
    i++;
  }
  flushPara();
  return blocks;
}

// Groups parsed blocks into sections split at each heading — the shape PPTX (one slide/section) and
// the fallback XLSX content sheet both need. Anything before the first heading becomes a titleless
// leading section rather than being dropped.
function toSections(blocks) {
  const sections = [];
  let current = { heading: null, blocks: [] };
  blocks.forEach((b) => {
    if (b.type === "heading") {
      if (current.heading !== null || current.blocks.length) sections.push(current);
      current = { heading: b.text, blocks: [] };
    } else {
      current.blocks.push(b);
    }
  });
  if (current.heading !== null || current.blocks.length) sections.push(current);
  return sections;
}

export const stripInlineMarkdown = (s) => String(s || "").replace(/\*\*(.*?)\*\*/g, "$1").replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── PDF (jsPDF + jspdf-autotable, same convention as reports.js's buildReportPDFDoc) ───────────
export function exportEntryAsPdf(entry) {
  const blocks = parseMarkdownBlocks(entry.content);
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const marginX = 40, pageBottom = 740;
  let y = 50;
  const ensureRoom = (needed) => { if (y + needed > pageBottom) { doc.addPage(); y = 50; } };

  doc.setFontSize(18); doc.setTextColor(23, 23, 23); doc.setFont(undefined, "bold");
  doc.text(entry.title || "Untitled", marginX, y);
  y += 18;
  doc.setFont(undefined, "normal"); doc.setFontSize(9); doc.setTextColor(143, 143, 143);
  doc.text(`${entry.category || "General"} · ${new Date().toLocaleDateString()}`, marginX, y);
  y += 24;

  blocks.forEach((b) => {
    if (b.type === "heading") {
      ensureRoom(24);
      doc.setFontSize(13); doc.setTextColor(23, 23, 23); doc.setFont(undefined, "bold");
      doc.text(stripInlineMarkdown(b.text), marginX, y);
      y += 20;
    } else if (b.type === "paragraph") {
      doc.setFontSize(10.5); doc.setTextColor(60, 60, 60); doc.setFont(undefined, "normal");
      const lines = doc.splitTextToSize(stripInlineMarkdown(b.text), 515);
      lines.forEach((line) => { ensureRoom(14); doc.text(line, marginX, y); y += 14; });
      y += 6;
    } else if (b.type === "bullets") {
      doc.setFontSize(10.5); doc.setTextColor(60, 60, 60); doc.setFont(undefined, "normal");
      b.items.forEach((item) => {
        const lines = doc.splitTextToSize(stripInlineMarkdown(item), 495);
        lines.forEach((line, idx) => { ensureRoom(14); doc.text(idx === 0 ? `•  ${line}` : `    ${line}`, marginX, y); y += 14; });
      });
      y += 6;
    } else if (b.type === "table") {
      ensureRoom(30);
      autoTable(doc, {
        startY: y,
        margin: { left: marginX, right: marginX },
        head: [b.headers.map(stripInlineMarkdown)],
        body: b.rows.map((r) => r.map(stripInlineMarkdown)),
        styles: { fontSize: 8.5, cellPadding: 5, textColor: [23, 23, 23] },
        headStyles: { fillColor: [250, 250, 250], textColor: [102, 102, 102], fontStyle: "bold", lineWidth: 0.5, lineColor: [212, 212, 212] },
        alternateRowStyles: { fillColor: [250, 250, 250] },
        theme: "grid",
      });
      y = doc.lastAutoTable.finalY + 16;
    }
  });

  doc.save(`${(entry.title || "vault-entry").replace(/[\\/:*?"<>|]/g, "")}.pdf`);
}

// ─── PPTX (pptxgenjs) — one slide per ## section, matching VaultHQ's own shape ──────────────────
export async function exportEntryAsPptx(entry) {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const sections = toSections(parseMarkdownBlocks(entry.content));

  const titleSlide = pptx.addSlide();
  titleSlide.addText(entry.title || "Untitled", { x: 0.5, y: 1.8, w: 9, h: 1, fontSize: 32, bold: true, color: "171717" });
  titleSlide.addText(entry.category || "General", { x: 0.5, y: 2.7, w: 9, h: 0.5, fontSize: 14, color: "8F8F8F" });

  (sections.length ? sections : [{ heading: null, blocks: [] }]).forEach((sec) => {
    const slide = pptx.addSlide();
    let y = 0.4;
    if (sec.heading) {
      slide.addText(stripInlineMarkdown(sec.heading), { x: 0.5, y, w: 9, h: 0.6, fontSize: 22, bold: true, color: "171717" });
      y += 0.8;
    }
    sec.blocks.forEach((b) => {
      if (b.type === "paragraph") {
        slide.addText(stripInlineMarkdown(b.text), { x: 0.5, y, w: 9, h: 1, fontSize: 13, color: "3C3C3C" });
        y += 1;
      } else if (b.type === "bullets") {
        slide.addText(b.items.map((item) => ({ text: stripInlineMarkdown(item), options: { bullet: true, breakLine: true } })), { x: 0.5, y, w: 9, h: Math.min(4, 0.35 * b.items.length + 0.3), fontSize: 13, color: "3C3C3C" });
        y += Math.min(4, 0.35 * b.items.length + 0.3);
      } else if (b.type === "table") {
        const rows = [b.headers.map((h) => ({ text: stripInlineMarkdown(h), options: { bold: true, fill: { color: "FAFAFA" } } })), ...b.rows.map((r) => r.map((c) => ({ text: stripInlineMarkdown(c) })))];
        slide.addTable(rows, { x: 0.5, y, w: 9, fontSize: 10, border: { type: "solid", color: "D4D4D4", pt: 0.5 } });
        y += 0.4 * rows.length;
      }
    });
  });

  await pptx.writeFile({ fileName: `${(entry.title || "vault-entry").replace(/[\\/:*?"<>|]/g, "")}.pptx` });
}

// ─── XLSX (SheetJS, same convention as reports.js's buildReportBlob) — one sheet per table found,
// plus a leading "Content" sheet with everything else so a table-less entry still exports something
// useful instead of an empty workbook. ─────────────────────────────────────────────────────────
export function exportEntryAsXlsx(entry) {
  const blocks = parseMarkdownBlocks(entry.content);
  const wb = XLSX.utils.book_new();

  const contentRows = [[entry.title || "Untitled"], [entry.category || "General"], []];
  let tableCount = 0;
  blocks.forEach((b) => {
    if (b.type === "heading") contentRows.push([stripInlineMarkdown(b.text)]);
    else if (b.type === "paragraph") contentRows.push([stripInlineMarkdown(b.text)]);
    else if (b.type === "bullets") b.items.forEach((item) => contentRows.push([`• ${stripInlineMarkdown(item)}`]));
    else if (b.type === "table") contentRows.push([`[Table ${++tableCount} — see its own sheet]`]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(contentRows), "Content");

  let n = 0;
  blocks.filter((b) => b.type === "table").forEach((b) => {
    n++;
    const aoa = [b.headers.map(stripInlineMarkdown), ...b.rows.map((r) => r.map(stripInlineMarkdown))];
    const name = `Table ${n}`.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  });

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  triggerDownload(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${(entry.title || "vault-entry").replace(/[\\/:*?"<>|]/g, "")}.xlsx`);
}

// ─── Copy for Notion/Docs — plain clipboard copy, raw markdown kept intact (Notion parses ##/**/-
// on paste natively; Google Docs treats it as plain text but at least preserves line breaks/
// structure) — unlike the three generators above, this does NOT strip ** or re-parse into blocks. ─
export async function copyEntryForNotion(entry) {
  const text = `${entry.title || "Untitled"}\n\n${entry.content || ""}`;
  await navigator.clipboard.writeText(text);
}
