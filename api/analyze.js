/**
 * /api/analyze.js — Vercel serverless function
 *
 * Proxies to the Anthropic Messages API, keeping the API key server-side (the previous
 * approach called api.anthropic.com directly from the browser with no auth header at all,
 * which cannot work — there's no way to attach a secret key to client-side code and have it
 * stay secret, and the request would be rejected/blocked before ever reaching a model).
 *
 * Two calling shapes, both supported:
 *
 * LEGACY (single free-form text turn) — used by three existing AI-assisted features:
 *   - Budget import column mapping ("Analyze with AI" in BudgetManager's import wizard)
 *   - Export granularity suggestion (BudgetManager's export preview)
 *   - Budget-dimension merge-review matching
 *   POST /api/analyze  Body: { prompt: string, maxTokens?: number }
 *
 * FULL (multi-turn, tool-use, vision) — used by the Ask AI chat and screenshot-to-data import:
 *   POST /api/analyze  Body: { messages: Array, system?: string, tools?: Array, maxTokens?: number }
 *   `messages` follows the Anthropic Messages API shape directly (role + content, where content
 *   can be a plain string OR an array of blocks — text / image / tool_use / tool_result) so the
 *   caller can run a full tool-use loop or send an image without this proxy needing to know
 *   anything about what's being asked — it's a dumb pass-through that only exists to hide the key.
 *
 * Response (both shapes): { text, content, stop_reason }
 *   - text: first text block's content (what legacy callers already read data.text from)
 *   - content: the full raw content blocks array (text + tool_use blocks) — new callers need
 *     this to detect and execute tool_use blocks
 *   - stop_reason: "tool_use" means the model wants a tool result before it can continue;
 *     anything else (typically "end_turn") means `text` is the final answer
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { prompt, messages, system, tools, maxTokens } = req.body || {};
  if (!prompt && !messages) return res.status(400).json({ error: "prompt or messages is required" });

  try {
    const body = {
      model: "claude-sonnet-5",
      max_tokens: maxTokens || 2000,
      messages: messages || [{ role: "user", content: prompt }],
    };
    if (system) body.system = system;
    if (tools && tools.length) body.tools = tools;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "Anthropic API error" });
    }
    const content = data.content || [];
    const text = content.find((b) => b.type === "text")?.text || "";
    return res.status(200).json({ text, content, stop_reason: data.stop_reason });
  } catch (err) {
    console.error("[analyze]", err);
    return res.status(500).json({ error: err.message });
  }
}
