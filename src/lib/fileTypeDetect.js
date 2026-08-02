/**
 * Classifies an uploaded file (CSV/XLSX/PDF) into one of PaidHQ's four import destinations
 * (2026-08-01, per Mo — "one upload surface in Data Sources, route by file content" instead of a
 * separate upload button per destination):
 *
 *   spend    -> ad-platform spend export -> Campaign Tagger (spend_rows)
 *   budget   -> budget spreadsheet       -> hands off to the Budget Panel's existing import wizard
 *   pipeline -> PowerBI/Dreamdata/CRM funnel performance export -> Pipeline Tagger (reporting_facts)
 *   goals    -> a goals/targets-only export -> the Goals & Objectives tab (reporting_facts, tagged
 *               distinctly — see GoalsObjectives.jsx)
 *
 * CSV/XLSX: a cheap deterministic keyword classifier runs first against the header row — no AI
 * call for the common case. Falls back to a lightweight AI classification call (headers + a few
 * sample rows, NOT the whole file) only when the deterministic check is inconclusive.
 *
 * PDF: always AI, but NOT via this module's own classify-only call — reportingAI.js's
 * classifyAndExtractPdf both classifies AND extracts in one request (2026-08-01, added after Mo
 * asked why PDF uploads were slow: classifying and then, once confirmed, extracting was two full
 * reads of the same PDF — Claude reading a document block is the slow part of either call, so
 * doing it twice roughly doubled the wait). classifyImportFile's PDF branch calls that combined
 * function and returns its `rows` alongside the classification, so a caller that gets back a
 * "pipeline"/"goals" result already has the extraction too — see PaidHQ.jsx's confirmUnifiedUpload,
 * which skips a second network call entirely when the confirmed type matches what came back here.
 *
 * This module only classifies for CSV/XLSX; it doesn't parse/extract that data (callers route to
 * handleFile/applySpendGrid for spend, BudgetManager's ingestRawRows for budget, or
 * reportingImport.js for pipeline/goals). PDFs are the one case where classification and
 * extraction are already fused, per the paragraph above.
 */
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { classifyAndExtractPdf } from "./reportingAI.js";

// ---- deterministic keyword classifier (CSV/XLSX header row only) ----

const PIPELINE_RE = /\b(mqls?|sqls?|pipeline|inquir\w*)\b/i;
const GOAL_RE = /\b(goal|target|quota|attainment)/i;
const BUDGET_RE = /\b(budget|quarterly cap|annual cap|monthly cap)/i;
const MONTH_NAME_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const SPEND_RE = /\b(spend|impressions|clicks|cost|platform|channel)\b/i;
const DATE_RE = /\b(date|day)\b/i;

// Returns { type, confidence } or null if the header row doesn't clearly match any known shape —
// callers fall back to AI classification in that case rather than guessing.
function classifyHeadersDeterministic(headers) {
  const joined = (headers || []).map((h) => String(h || "")).join(" ").toLowerCase();
  if (PIPELINE_RE.test(joined)) return { type: "pipeline", confidence: "high" };

  const monthCols = (headers || []).filter((h) => MONTH_NAME_RE.test(String(h || "").trim())).length;
  const hasGoal = GOAL_RE.test(joined);
  const hasBudget = BUDGET_RE.test(joined) || monthCols >= 3;
  const hasSpend = SPEND_RE.test(joined);
  const hasDate = DATE_RE.test(joined);

  if (hasGoal && !hasSpend && !hasDate) return { type: "goals", confidence: "medium" };
  if (hasBudget && !hasDate) return { type: "budget", confidence: "high" };
  if (hasSpend || hasDate) return { type: "spend", confidence: "high" };
  return null;
}

// Reads just the header row + a handful of sample rows — cheap, no full-file parse. CSV via
// Papa.parse's `preview` option (stops after N rows); XLSX via a normal read (files are small
// enough that reading the whole sheet to grab 6 rows isn't worth a second code path).
function readHeaderPreview(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "csv") {
      Papa.parse(file, {
        header: false,
        skipEmptyLines: true,
        preview: 6,
        complete: (r) => resolve({ headers: r.data[0] || [], sampleRows: r.data.slice(1) }),
        error: reject,
      });
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
          resolve({ headers: rows[0] || [], sampleRows: rows.slice(1, 6) });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    }
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---- AI fallback for inconclusive CSV/XLSX headers (PDFs go through reportingAI.js's
// classifyAndExtractPdf instead — see this file's top doc comment) ----

function buildClassifyTool() {
  return {
    name: "classify_import_file",
    description: "Classifies what kind of PaidHQ import file this is.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["spend", "budget", "pipeline", "goals"] },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        reasoning: { type: "string", description: "One short sentence explaining the call." },
      },
      required: ["type", "confidence"],
    },
  };
}

const CLASSIFY_SYSTEM_PROMPT = `
You classify a file being uploaded into a marketing budget/reporting tool into exactly one of four
types, recorded via the classify_import_file tool:

- "spend": an ad-platform spend export (Google Ads, LinkedIn, Meta, Bing, etc.) — spend/cost by
  campaign/platform/channel, usually with a date or daily breakdown.
- "budget": a budget spreadsheet — planned/allocated dollar amounts by segment and period (often a
  month-by-month grid, or quarterly/annual caps), NOT actual results.
- "pipeline": a PowerBI/Dreamdata/CRM funnel performance export — MQLs, SQLs, pipeline $,
  inquiries, or similar down-funnel actuals, usually by campaign or product.
- "goals": a goals/targets export — sets targets/quotas/goals for a metric, without much or any
  actual performance data alongside them (if actuals AND goals both appear together, prefer
  "pipeline" — that's a performance report that happens to also show targets).

Base your answer only on the column headers and sample values you can actually see — do not guess
beyond what's shown, and use "low" confidence rather than inventing certainty.
`.trim();

async function classifyWithAI({ headers, sampleRows, token }) {
  const preview = [
    (headers || []).join(", "),
    ...(sampleRows || []).slice(0, 5).map((r) => (r || []).join(", ")),
  ].join("\n");
  const content = [
    {
      type: "text",
      text: `Header row and a few sample rows:\n\n${preview}\n\nClassify this file using the classify_import_file tool.`,
    },
  ];

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      system: CLASSIFY_SYSTEM_PROMPT,
      tools: [buildClassifyTool()],
      maxTokens: 300,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Classification failed (${res.status})`);
  const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "classify_import_file");
  if (!toolUse) throw new Error("Couldn't tell what kind of file that is — pick the type manually below.");
  return { type: toolUse.input.type, confidence: toolUse.input.confidence, reasoning: toolUse.input.reasoning || "" };
}

// file: a File from an <input type="file"> or drop handler. token: session.access_token, forwarded
// to /api/analyze when an AI classification call is needed (see reportingAI.js's AUTH doc comment
// for why — any logged-in PaidHQ user, no workspace check needed for this stateless proxy).
// tagDims: only used for the PDF path — forwarded to classifyAndExtractPdf so a PDF that turns out
// to be pipeline/goals content is fully extracted (not just classified) in this same call.
// Resolves to { type, confidence, reasoning?, headers?, rows? } — `type` is always one of
// "spend"/"budget"/"pipeline"/"goals"; `rows` is only present for PDFs (see this file's top doc
// comment for why). Never throws for "we're not sure" — that's what "low" confidence is for; only
// throws for a genuinely unreadable file.
export async function classifyImportFile({ file, token, tagDims = [] }) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    const dataUrl = await fileToDataUrl(file);
    const result = await classifyAndExtractPdf({ dataUrl, token, tagDims });
    return { type: result.type, confidence: result.confidence, rows: result.rows };
  }
  const { headers, sampleRows } = await readHeaderPreview(file);
  if (!headers.length) throw new Error("Couldn't read any columns from that file.");
  const det = classifyHeadersDeterministic(headers);
  if (det) return { ...det, headers };
  const ai = await classifyWithAI({ headers, sampleRows, token });
  return { ...ai, headers };
}

export const IMPORT_TYPE_LABELS = {
  spend: "Spend",
  budget: "Budget",
  pipeline: "Pipeline Performance",
  goals: "Goals",
};
