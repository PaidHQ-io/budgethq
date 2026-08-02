/**
 * Screenshot-to-rows extraction for the Reporting Analyzer tab's Dreamdata/PowerBI import. Ported
 * from ReportingHQ (2026-07-30, per Mo — folding ReportingHQ into PaidHQ instead of running it
 * as a separate product), unchanged — sends a screenshot to Claude via /api/analyze, the same
 * proxy PaidHQ's own screenshot-to-spend and column-mapping features already use to keep the
 * Anthropic key server-side (see api/analyze.js's "FULL" calling shape), with a tool-use prompt
 * that forces structured output — a free-text "read the table and reply with JSON" prompt is one
 * stray sentence away from unparseable output; tool_use makes the model's response conform to a
 * schema we control.
 *
 * Deliberately asks the model to compute period_start itself (it already understands calendars —
 * "Q1 2024" -> 2024-01-01, "January 2024" -> 2024-01-01, etc.) rather than returning a raw label
 * this code would then have to parse for every format Dreamdata/PowerBI might show. See
 * reportingPeriods.js's normalizePeriodStart for the safety net that snaps whatever comes back to
 * the correct start-of-period regardless.
 *
 * Handles both export shapes Mo described: a single table can mix grains (a Year total row with
 * child Quarter rows with child Month rows all in one screenshot) — the model tags each ROW with
 * its own period_type. A flat breakdown table with no date/period column at all (e.g. a
 * campaign-name breakdown reflecting whatever date range the dashboard filter had selected) comes
 * back with periodType "unknown" and no periodStart — the review UI then asks whoever's
 * importing to assign one period to the whole batch.
 *
 * tagDims: dimension tagging uses "the exact same tag dimensions" as Campaign Tagger — which are
 * themselves user-editable per workspace (see core.workspace_config.tag_dims, fetched via
 * dimension-values.js and passed in here as `tagDims`), not a fixed list either tab's code can
 * hardcode. So the tool schema's `tags` property is built per-call from whatever this workspace's
 * current dimension list is, and the model is told to use those exact names when a value for one
 * is visible (e.g. in a filter dropdown shown above the table) — campaign_name stays the one fixed
 * identity field, everything else is arbitrary.
 *
 * PDF EXTRACTION (2026-08-01, per Mo — "Source C", a Goals & Pacing PDF export with no per-row
 * campaign identity, only Business Unit/Product Pillar/Product Line columns): extractReportingRowsFromPdf
 * reuses this exact same system prompt + tool schema, sending Anthropic a native `document` content
 * block instead of an `image` one — /api/analyze is a dumb pass-through (see its own doc comment),
 * so no server change was needed, and Claude reads embedded-text PDFs directly without needing this
 * app to run its own PDF-to-text extraction step. The Business Unit/Product Pillar/Product Line
 * columns get picked up by the existing "a column literally labeled with one of these [dimension]
 * names" instruction below — same mechanism a per-row breakdown column already used for images.
 *
 * classifyAndExtractPdf (2026-08-01, added after Mo asked why PDF uploads felt slow): the unified
 * uploader (PaidHQ.jsx) used to classify a PDF's file type with one AI call (fileTypeDetect.js),
 * then — once the user confirmed — make a SECOND full call here to actually extract the rows. A
 * PDF document block is the slow part of either call (Claude reads it page-by-page), so sending the
 * same PDF twice roughly doubled the wait for no benefit. This does both in one call: the same
 * tool records the extracted rows AND the detected file_type/type_confidence together, so
 * confirming the (correct) detected type doesn't cost a second round-trip — only overriding to
 * "spend"/"budget" (which this schema can't extract — PDF import for those isn't supported) forgoes
 * the already-extracted rows, same as before.
 *
 * OPEN METRICS SCHEMA (2026-08-02, per Mo — the Pipeline Tagger tab needs to work for clients whose
 * exports don't look like insightsoftware's Dreamdata/PowerBI dashboards at all, e.g. a raw
 * Salesforce or HockeyStack pull with entirely different column names). The "metrics" field used to
 * be a closed ~32-key enum — anything outside that list was silently dropped. It's now an open
 * { key: number } object (see buildRecordTool's additionalProperties below): the model extracts
 * EVERY numeric column it sees, not just ones on a known list. REPORTING_METRICS_HELP still lists
 * the common keys this app already knows how to summarize/label nicely (see reportingMetrics.js's
 * deriveMetricColumns/labelForMetricKey, shared by ReportingAnalyzer.jsx's review table and
 * PipelineTagger.jsx's breakdown view) — the model is told to reuse them verbatim when a column
 * clearly matches, and to invent a reasonable snake_case key from the column header otherwise, kept
 * consistent for that same column across every row of one import.
 */
const REPORTING_METRICS_HELP = `
Metrics: extract EVERY numeric column visible for a row into the "metrics" object as
{ key: number } pairs — this is not limited to a fixed list, different sources (Dreamdata, PowerBI,
Salesforce, HockeyStack, etc.) use completely different column names. Strip "$", ",", and "%" —
store as plain numbers (percentages as e.g. 0.7 for 0.7%, i.e. the number as shown, not divided by
100 unless the source itself is a plain fraction). Do not invent a number for a column that isn't
shown.

Key naming: derive a snake_case key from each column's own header text (lowercase; spaces and
punctuation -> underscores; strip $/%/#). Whenever a column clearly matches one of these common
keys, reuse it verbatim instead of inventing a new one — that keeps the same metric on the same key
across imports from different sources:
spend, impressions, clicks, ctr, cpc, all_conversions, cp_all_conv, cvr, inquiries, cp_inquiry,
cvr_inquiry, leads, cp_lead, mqas, handraisers, demos, free_trials, pqls, meetings_booked, mqls,
cp_mql, sals, sqls, sql_pipeline, pipeline_value, revenue, closed_won, closed_lost,
all_conv_to_mql_rate, mql_to_sql_rate, mql_goal, mql_attainment_pct, mql_forecast_pct, budget_goal,
spend_pct_of_budget, spend_pacing_pct, mkt_mql_actuals, mkt_mql_goal, mkt_mql_attainment_pct,
mkt_mql_forecast_pct, mkt_pipeline_actuals, mkt_pipeline_goal, mkt_pipeline_attainment_pct,
mkt_pipeline_forecast_pct
("Total Spend" on a Goals & Pacing report still maps to the plain "spend" key above, not
budget_goal.) pipeline_value is the TOTAL pipeline dollar figure for a row (a column literally
called "Pipeline," "Pipeline Value," "Open Pipeline," or similar) — this is DIFFERENT from
sql_pipeline, which is specifically the pipeline value tied to SQL-stage opportunities only; use
whichever one the column's own label actually indicates rather than defaulting to one over the
other. For a column that doesn't match any of these, make up a clear snake_case key from its header
and use that SAME key for every row where that column appears in this file — consistency within one
import matters more than matching one of the names above.
`.trim();

function buildSystemPrompt(tagDims) {
  const dimsList = tagDims.length ? tagDims.join(", ") : "(none configured for this workspace yet)";
  return `
You extract rows of marketing/funnel reporting data from a screenshot of a Dreamdata/PowerBI
dashboard for the record_reporting_rows tool. Read every row of every table visible in the image.

Dimensions:
- campaign_name: the ad campaign name, if this table is broken out by campaign. Leave "" if this
  table has no per-campaign breakdown (e.g. an aggregate monthly-totals table).
- tags: an object using this workspace's known dimension names — ${dimsList}. Only include a
  dimension if its value is actually visible in the image (e.g. a filter dropdown above the table
  reading "Product: Spreadsheet Server", or a column literally labeled with one of these names).
  Do not guess a value for a dimension that isn't shown. Omit dimensions entirely rather than
  inventing "" placeholders for ones you can't see.

${REPORTING_METRICS_HELP}

Period handling — this is the part to get right:
- If a row/table has a date, month, quarter, or year label (including subtotal/"Total" rows in a
  nested Year > Quarter > Month table — capture EVERY level, not just the leaf rows), set
  period_type to the matching grain ("day","week","month","quarter","year") and period_start to
  the FIRST DAY of that period as an ISO date (YYYY-MM-DD) — e.g. "Q1 2024" -> "2024-01-01",
  "January 2024" -> "2024-01-01", a bare "2024" (year total) -> "2024-01-01", a specific date ->
  that date, a week -> the Monday of that week.
- If a table has NO date/period information at all (e.g. a flat campaign breakdown reflecting
  whatever date range a dashboard filter had selected, with no date column shown), set
  period_type to "unknown" and omit period_start entirely — do not guess a period.

One row per unique combination of period + campaign_name + tags visible. If a screenshot shows a
filter dropdown with a specific value selected (e.g. a "Product" filter showing "Spreadsheet
Server"), apply that value to every row extracted from that image.
`.trim();
}

function buildRecordTool(tagDims) {
  return {
    name: "record_reporting_rows",
    description: "Records the reporting-data rows extracted from the screenshot.",
    input_schema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              period_type: { type: "string", enum: ["day", "week", "month", "quarter", "year", "unknown"] },
              period_start: { type: "string", description: "ISO date (YYYY-MM-DD), first day of the period. Omit if period_type is 'unknown'." },
              campaign_name: { type: "string" },
              tags: {
                type: "object",
                description: "Arbitrary { dimensionName: value } pairs — see the workspace's known dimension names in the system prompt. Only include dimensions actually visible in the image.",
                properties: Object.fromEntries(tagDims.map((d) => [d, { type: "string" }])),
              },
              // Open schema (2026-08-02, see this file's OPEN METRICS SCHEMA doc comment above) —
              // was a closed ~32-key enum that silently dropped anything outside it, which doesn't
              // work for clients whose exports (Salesforce, HockeyStack, etc.) use entirely
              // different column names. additionalProperties lets the model record any numeric
              // column it finds under a key it derives from that column's own header; the common
              // keys are still documented in REPORTING_METRICS_HELP above (sent in the system
              // prompt) so the model reuses them instead of inventing synonyms when they apply.
              metrics: {
                type: "object",
                description:
                  "{ metric_key: number } pairs, one per numeric column visible for this row. Not limited to a fixed list — see the system prompt's key-naming rules.",
                additionalProperties: { type: "number" },
              },
            },
            required: ["period_type", "metrics"],
          },
        },
      },
      required: ["rows"],
    },
  };
}

// Shared by every extraction entry point below — builds the request (a caller-supplied tool
// schema, defaulting to the plain record_reporting_rows one), sends one `sourceBlock` content
// block (an image or a document) plus an instruction text block to /api/analyze, and returns the
// FULL tool_use input object (not just `.rows`) so callers that extended the schema — see
// classifyAndExtractPdf below — can read their extra fields back out too. token:
// session.access_token, forwarded as a Bearer header (see api/analyze.js's AUTH doc comment — any
// logged-in PaidHQ user, no workspace check needed for this stateless proxy). tagDims: this
// workspace's current tag dimension names (from dimension-values.js's `tagDims`) — used to build
// the extraction prompt/schema so the model tags with the right vocabulary.
async function runExtraction({ sourceBlock, instruction, token, tagDims, notFoundMessage, tool }) {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      system: buildSystemPrompt(tagDims),
      tools: [tool || buildRecordTool(tagDims)],
      // 2026-08-02, per Mo hitting "Couldn't read a structured table" on a real Goals & Pacing
      // PDF — 4000 was sized for a handful of screenshot rows, not a ~28-row table with 15+ metric
      // fields each (that alone is roughly 10k+ tokens of JSON once you count period/tags/campaign
      // per row). Once output is cut off mid-tool-call, Anthropic doesn't return a usable tool_use
      // block at all, which is indistinguishable from "the model didn't find a table" without
      // checking stop_reason (added below) — this codebase hit the same class of bug once before
      // with the screenshot budget importer's JSON truncation. 8000 gives real headroom for large
      // exports without meaningfully changing cost/latency for the common small-table case.
      maxTokens: 8000,
      messages: [
        {
          role: "user",
          content: [sourceBlock, { type: "text", text: instruction }],
        },
      ],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Extraction failed (${res.status})`);

  const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "record_reporting_rows");
  if (!toolUse) {
    // A response that got cut off mid-tool-call (ran out of maxTokens before finishing the JSON)
    // looks identical to "the model didn't find a table" unless stop_reason is checked — this is
    // exactly what happened on a real ~28-row Goals & Pacing PDF before the maxTokens bump above,
    // and surfaced as this same generic notFoundMessage with no clue why. Give a distinct, more
    // actionable message for that specific case.
    if (data?.stop_reason === "max_tokens") {
      throw new Error("That table is larger than this can process in one pass right now — try splitting the file or importing fewer rows at a time.");
    }
    throw new Error(notFoundMessage);
  }
  return toolUse.input || {};
}

// dataUrl: "data:image/png;base64,...." (or jpeg) — whatever the browser's FileReader/paste
// handler produced.
export async function extractReportingRowsFromImage({ dataUrl, token, tagDims = [] }) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Expected a base64 image data URL");
  const [, mediaType, base64] = match;
  const result = await runExtraction({
    sourceBlock: { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    instruction: "Extract every reporting row from this screenshot using the record_reporting_rows tool.",
    token,
    tagDims,
    notFoundMessage: "Couldn't read a structured table from that image — try a clearer screenshot of just the table.",
  });
  return result.rows || [];
}

// dataUrl: "data:application/pdf;base64,...." — whatever the browser's FileReader produced for an
// uploaded PDF (e.g. a "Goals & Pacing" export). Sends Anthropic a native `document` content block
// so Claude reads the PDF's own embedded text/tables directly — no client- or server-side PDF text
// extraction step needed, see the PDF EXTRACTION doc comment at the top of this file. Kept as a
// separate export (rather than always going through classifyAndExtractPdf) for callers that already
// know the file's type and just want rows — currently unused by the unified uploader (which uses
// classifyAndExtractPdf instead to save the double round-trip) but kept available.
export async function extractReportingRowsFromPdf({ dataUrl, token, tagDims = [] }) {
  const match = /^data:application\/pdf;base64,(.+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Expected a base64 PDF data URL");
  const [, base64] = match;
  const result = await runExtraction({
    sourceBlock: { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
    instruction: "Extract every reporting row from every table in this PDF using the record_reporting_rows tool.",
    token,
    tagDims,
    notFoundMessage: "Couldn't read a structured table from that PDF.",
  });
  return result.rows || [];
}

// Combined classify+extract for PDFs — see the PDF EXTRACTION / classifyAndExtractPdf doc comment
// at the top of this file for why this exists (avoiding a second full PDF read). Extends the
// normal record_reporting_rows tool with file_type/type_confidence fields, and folds
// fileTypeDetect.js's classification instructions into the same system prompt so one call does
// both jobs. Returns { type, confidence, rows } — `rows` uses the exact same extraction this
// schema always produced, `type`/`confidence` are new. Only meaningful for pipeline/goals content;
// if the model reports "spend" or "budget", treat `rows` as unusable (this schema doesn't fit
// those shapes) — same as the old two-call flow's behavior for those types.
export async function classifyAndExtractPdf({ dataUrl, token, tagDims = [] }) {
  const match = /^data:application\/pdf;base64,(.+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Expected a base64 PDF data URL");
  const [, base64] = match;

  const tool = buildRecordTool(tagDims);
  tool.input_schema.properties.file_type = {
    type: "string",
    enum: ["spend", "budget", "pipeline", "goals"],
    description:
      'What kind of PaidHQ import file this is overall: "spend" = ad-platform spend export; ' +
      '"budget" = planned/allocated $ by segment+period, not actuals; "pipeline" = a funnel ' +
      'performance export (MQLs/SQLs/pipeline $/inquiries); "goals" = a targets/quotas export with ' +
      'little or no actual performance data alongside them. If both goals AND actuals appear ' +
      'together (e.g. a Goals & Pacing report), use "pipeline".',
  };
  tool.input_schema.properties.type_confidence = { type: "string", enum: ["low", "medium", "high"] };
  tool.input_schema.required = [...(tool.input_schema.required || []), "file_type", "type_confidence"];

  const system = `${buildSystemPrompt(tagDims)}

Also classify the file overall by setting file_type and type_confidence on the same tool call, per
their descriptions in the tool schema. IMPORTANT: extracting every row is still the priority — only
leave the rows array empty if file_type is "spend" or "budget" (this tool genuinely can't extract
those shapes). For "pipeline" or "goals" files, extract EVERY row from EVERY table, exactly as
thoroughly as if classification weren't part of this request at all.`;

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      system,
      tools: [tool],
      // See runExtraction's maxTokens doc comment above — same reasoning, this call needs the
      // same headroom (it extracts the exact same rows, plus two small extra fields).
      maxTokens: 8000,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            {
              type: "text",
              text: "Classify this file and extract every reporting row from every table in it, using the record_reporting_rows tool.",
            },
          ],
        },
      ],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Extraction failed (${res.status})`);

  const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "record_reporting_rows");
  if (!toolUse) {
    if (data?.stop_reason === "max_tokens") {
      throw new Error("That file is larger than this can process in one pass right now — try splitting it or importing fewer rows at a time.");
    }
    throw new Error("Couldn't read that PDF.");
  }
  return {
    type: toolUse.input?.file_type || "pipeline",
    confidence: toolUse.input?.type_confidence || "low",
    rows: toolUse.input?.rows || [],
  };
}
