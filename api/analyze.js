/**
 * /api/analyze.js — Vercel serverless function
 *
 * Proxies a single free-form prompt to the Anthropic Messages API, keeping the API key
 * server-side (the previous approach called api.anthropic.com directly from the browser
 * with no auth header at all, which cannot work — there's no way to attach a secret key
 * to client-side code and have it stay secret, and the request would be rejected/blocked
 * before ever reaching a model).
 *
 * Used by two AI-assisted features in the app:
 *   - Budget import column mapping ("Analyze with AI" in BudgetManager's import wizard)
 *   - Export granularity suggestion (BudgetManager's export preview)
 *
 * POST /api/analyze
 *   Body: { prompt: string, maxTokens?: number }
 *   Returns: { text }  — the model's raw text response; caller parses/cleans JSON themselves
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

  const { prompt, maxTokens } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens || 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "Anthropic API error" });
    }
    const text = (data.content || []).find((b) => b.type === "text")?.text || "";
    return res.status(200).json({ text });
  } catch (err) {
    console.error("[analyze]", err);
    return res.status(500).json({ error: err.message });
  }
}
