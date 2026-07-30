/**
 * Screenshot-to-rows extraction for the Reporting Analyzer tab's Dreamdata/PowerBI import. Ported
 * from ReportingHQ (2026-07-30, per Mo — folding ReportingHQ into BudgetHQ instead of running it
 * as a separate product), unchanged — sends a screenshot to Claude via /api/analyze, the same
 * proxy BudgetHQ's own screenshot-to-spend and column-mapping features already use to keep the
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
 */
const REPORTING_METRICS_HELP = `
Known metrics (use these exact keys in the "metrics" object; omit any not shown in this image — do
not invent numbers). Strip "$", ",", and "%" — store as plain numbers (percentages as e.g. 0.7 for
0.7%, i.e. the number as shown, not divided by 100 unless the source itself is a plain fraction):
spend, impressions, clicks, ctr, cpc, all_conversions, cp_all_conv, cvr, inquiries, cp_inquiry,
cvr_inquiry, leads, cp_lead, mqls, cp_mql, sqls, sql_pipeline, all_conv_to_mql_rate, mql_to_sql_rate
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
              metrics: {
                type: "object",
                properties: {
                  spend: { type: "number" },
                  impressions: { type: "number" },
                  clicks: { type: "number" },
                  ctr: { type: "number" },
                  cpc: { type: "number" },
                  all_conversions: { type: "number" },
                  cp_all_conv: { type: "number" },
                  cvr: { type: "number" },
                  inquiries: { type: "number" },
                  cp_inquiry: { type: "number" },
                  cvr_inquiry: { type: "number" },
                  leads: { type: "number" },
                  cp_lead: { type: "number" },
                  mqls: { type: "number" },
                  cp_mql: { type: "number" },
                  sqls: { type: "number" },
                  sql_pipeline: { type: "number" },
                  all_conv_to_mql_rate: { type: "number" },
                  mql_to_sql_rate: { type: "number" },
                },
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

// dataUrl: "data:image/png;base64,...." (or jpeg) — whatever the browser's FileReader/paste
// handler produced. token: session.access_token, forwarded as a Bearer header (see api/analyze.js
// AUTH doc comment — any logged-in PaidHQ user, no workspace check needed for this stateless proxy).
// tagDims: this workspace's current tag dimension names (from dimension-values.js's `tagDims`) —
// used to build the extraction prompt/schema so the model tags with the right vocabulary.
export async function extractReportingRowsFromImage({ dataUrl, token, tagDims = [] }) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Expected a base64 image data URL");
  const [, mediaType, base64] = match;

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      system: buildSystemPrompt(tagDims),
      tools: [buildRecordTool(tagDims)],
      maxTokens: 4000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: "Extract every reporting row from this screenshot using the record_reporting_rows tool." },
          ],
        },
      ],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Extraction failed (${res.status})`);

  const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "record_reporting_rows");
  if (!toolUse) {
    throw new Error("Couldn't read a structured table from that image — try a clearer screenshot of just the table.");
  }
  return toolUse.input?.rows || [];
}
