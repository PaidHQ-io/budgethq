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
