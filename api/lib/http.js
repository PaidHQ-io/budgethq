import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);

// Reads and parses a JSON request body, transparently gunzipping first if the client sent
// Content-Encoding: gzip. Exists because a plain (uncompressed) whole-dataset spend-rows PUT for
// an active workspace can exceed Vercel's hard 4.5MB Serverless Function request body limit —
// every save silently failed with 413 once a workspace's history got big enough, so new spend
// data never actually reached the server (see workspaceApi.js's compressJson for the client side
// of this fix). JSON compresses very well given the repeated field names/structure of spend rows,
// so this buys real headroom without a bigger sync-protocol redesign.
//
// Any route calling this MUST export `config = { api: { bodyParser: false } }` — otherwise Vercel
// pre-parses the body as JSON before the handler runs, which fails/mangles compressed bytes since
// they aren't valid JSON text on the wire.
export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  if (!buf.length) return {};
  const encoding = (req.headers["content-encoding"] || "").toLowerCase();
  const text = encoding.includes("gzip") ? (await gunzipAsync(buf)).toString("utf8") : buf.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Shared request/response helpers for the workspace API routes — same CORS convention already
// used in api/spend.js, plus a common error responder so requireAuth/requireWorkspaceMember's
// thrown errors (with a .status) map to the right HTTP status consistently across every route.
export function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Wraps a route handler: sets CORS, short-circuits OPTIONS preflight, and turns thrown errors
// (including the ones requireAuth/requireWorkspaceMember throw with a .status) into JSON
// responses instead of an unhandled 500 with a stack trace leaking to the client.
export function withApi(handler) {
  return async (req, res) => {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();
    try {
      await handler(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error("[api]", err);
      res.status(status).json({ error: err.message || "Internal error" });
    }
  };
}
