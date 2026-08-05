/**
 * /api/analyze.js — Vercel serverless function
 *
 * Proxies to the Anthropic Messages API, keeping the API key server-side (the previous
 * approach called api.anthropic.com directly from the browser with no auth header at all,
 * which cannot work — there's no way to attach a secret key to client-side code and have it
 * stay secret, and the request would be rejected/blocked before ever reaching a model).
 *
 * AUTH (2026-07-29, added per a workspace-siloing review — this endpoint had NO auth check at
 * all before this, meaning anyone who found the URL could spend Mo's Anthropic API budget with
 * zero rate limiting or attribution): requires a valid Supabase Bearer token, same requireAuth
 * check every workspace-scoped PaidHQ route already uses (see lib/auth.js). Deliberately does
 * NOT also require workspace membership the way /api/workspaces/[id]/* does — this route has no
 * workspaceId at all, isn't DB-backed, and is a stateless pass-through (whatever the caller sends
 * is exactly what goes to Anthropic and comes back, nothing is read from or written to any
 * workspace's data here) — so there's no cross-workspace data to leak through this endpoint
 * regardless of who calls it, only cost/abuse to gate. requireAuth alone (any logged-in PaidHQ
 * user, not necessarily a member of any particular workspace) is the right bar for that. Every
 * caller (src/lib/askAI.js's streamAnalyze/askAIBuildView/aiSummarizeBudgetPacing, and the direct
 * fetch("/api/analyze") call sites in PaidHQ.jsx/BudgetManager.jsx for screenshot-to-data and
 * column-mapping/export-suggestion prompts) now forwards the caller's session.access_token as a
 * Bearer header — a request with no/invalid token gets a 401 from requireAuth before this ever
 * reaches Anthropic.
 *
 * Three calling shapes:
 *
 * LEGACY (single free-form text turn) — used by three existing AI-assisted features:
 *   - Budget import column mapping ("Analyze with AI" in BudgetManager's import wizard)
 *   - Export granularity suggestion (BudgetManager's export preview)
 *   - Budget-dimension merge-review matching
 *   POST /api/analyze  Body: { prompt: string, maxTokens?: number }
 *
 * FULL (multi-turn, tool-use, vision) — used by Ask AI's view-builder and AI Summary (and the
 * chat's regular, non-streaming fallback shape if ever needed):
 *   POST /api/analyze  Body: { messages: Array, system?: string|Array, tools?: Array, maxTokens?: number }
 *   `messages` follows the Anthropic Messages API shape directly (role + content, where content
 *   can be a plain string OR an array of blocks — text / image / tool_use / tool_result) so the
 *   caller can run a full tool-use loop or send an image without this proxy needing to know
 *   anything about what's being asked — it's a dumb pass-through that only exists to hide the key.
 *   `system` and each entry in `tools` may likewise be either a plain value or a content-block
 *   object carrying `cache_control` (2026-08-19, per Mo — prompt caching to cut Ask AI's token
 *   cost; see src/lib/askAI.js's withPromptCaching) — this route does zero inspection or
 *   reshaping of either, it just forwards whatever shape the caller sends straight to Anthropic,
 *   same "dumb pipe" principle as everything else here.
 *
 * STREAMING (2026-07-28, per Mo — live token-by-token Ask AI chat) — same body shape as FULL,
 * plus `stream: true`. Response becomes a raw `text/event-stream` pass-through of Anthropic's own
 * SSE stream (message_start/content_block_start/content_block_delta/content_block_stop/
 * message_delta/message_stop events) — this endpoint does zero re-shaping of a streamed response,
 * the caller (src/lib/askAI.js's streamAnalyze) does its own SSE parsing and content-block
 * reconstruction client-side. Kept as a raw byte pass-through rather than parsed-and-re-emitted
 * here for the same "dumb pipe" reason the non-streaming shape is a dumb pass-through — this
 * function doesn't need to understand Anthropic's event format to forward it correctly.
 * NOT YET LIVE-VERIFIED end-to-end on Vercel — the reader/write-chunk-forwarding approach below is
 * the standard pattern for streaming through a Vercel Node serverless function, but this hasn't
 * been smoke-tested against a real deploy yet (same "verify before fully trusting" discipline as
 * this codebase's other unverified-until-proven integrations) — worth confirming chunks actually
 * arrive progressively (not all-at-once when the full response finishes) after this ships.
 *
 * Response (non-streaming shapes): { text, content, stop_reason, usage }
 *   - text: first text block's content (what legacy callers already read data.text from)
 *   - content: the full raw content blocks array (text + tool_use blocks) — new callers need
 *     this to detect and execute tool_use blocks
 *   - stop_reason: "tool_use" means the model wants a tool result before it can continue;
 *     anything else (typically "end_turn") means `text` is the final answer
 *   - usage: Anthropic's own {input_tokens, output_tokens} for this one call — added 2026-07-28
 *     alongside the streaming work so per-message token counts can be shown in the chat regardless
 *     of whether that particular call streamed or not
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 */
import { requireAuth } from "./lib/auth.js";

// Model picker (2026-07-28, per Mo — "can we allow users to switch models from Sonnet to
// Opus, etc.") — allow-listed and validated server-side rather than trusting whatever string
// the client sends, same defensive posture as everything else this proxy exists to protect
// (never let client input reach the Anthropic API unchecked). Mirrored in src/lib/askAI.js'
// ASK_AI_MODELS for the dropdown's labels/hints — the two lists can't literally share a module
// (one runs in the browser bundle, one in this serverless function), so keep them in sync by
// hand if a model is ever added/removed here.
const ALLOWED_MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"];
const DEFAULT_MODEL = "claude-sonnet-5";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Any logged-in PaidHQ user, not necessarily a member of any particular workspace — see the
  // AUTH doc comment at the top of this file for why membership isn't checked here too.
  try {
    await requireAuth(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { prompt, messages, system, tools, maxTokens, model, stream } = req.body || {};
  if (!prompt && !messages) return res.status(400).json({ error: "prompt or messages is required" });

  try {
    const body = {
      model: ALLOWED_MODELS.includes(model) ? model : DEFAULT_MODEL,
      max_tokens: maxTokens || 2000,
      messages: messages || [{ role: "user", content: prompt }],
    };
    if (system) body.system = system;
    if (tools && tools.length) body.tools = tools;
    if (stream) body.stream = true;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      // Anthropic returns a normal (non-SSE) JSON error body for request-level rejections (bad
      // key, bad params, rate limit) even when stream:true was requested — this branch handles
      // both calling shapes identically, only successful streaming responses fork below.
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: data?.error?.message || "Anthropic API error" });
    }

    if (stream) {
      // Raw byte pass-through — see the doc comment atop this file. No res.json() here since we
      // never buffer/parse the body; the reader loop below writes each chunk to the client as it
      // arrives from Anthropic.
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      const reader = r.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (streamErr) {
        console.error("[analyze:stream]", streamErr);
        // Headers are already sent by this point — can't switch to a JSON error response, best
        // effort is just to end the connection so the client's reader loop exits (and its own
        // try/catch surfaces a "stream ended unexpectedly"-type error rather than hanging).
      } finally {
        res.end();
      }
      return;
    }

    const data = await r.json();
    const content = data.content || [];
    // Joins ALL text blocks, not just the first (2026-08-19, web_search — ported from VaultHQ's
    // identical fix in its own api/analyze.js): a web-search-augmented answer routinely comes back
    // as multiple separate text blocks around the server_tool_use/web_search_tool_result pair (a
    // preamble like "I'll search for..." before the search, then the real cited answer after) —
    // every prior caller here only ever produced at most one text block per turn, so grabbing just
    // the first one was harmless until now; with web search it silently returned the throwaway
    // preamble instead of the actual answer.
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return res.status(200).json({ text, content, stop_reason: data.stop_reason, usage: data.usage });
  } catch (err) {
    console.error("[analyze]", err);
    return res.status(500).json({ error: err.message });
  }
}
