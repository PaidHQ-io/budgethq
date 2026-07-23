/**
 * /api/workspaces/[id]/connections
 *
 * Per-workspace third-party connector credentials — Funnel.io/Supermetrics/Capterra API keys and
 * LinkedIn's OAuth tokens, as opposed to the single shared process.env credential the bing/google/
 * meta connectors use (one account for the whole app). This is what lets each workspace connect
 * ITS OWN account.
 *
 * GET    — list which providers this workspace has connected. Never returns the stored
 *          credential itself, just { provider, connectedAt } per row — the credential only ever
 *          flows one direction (client -> this route -> database), never back out.
 * POST   Body: { provider, credential } — save/replace a workspace's credential for a provider.
 *        `credential` shape is provider-specific (see connectors/funnel.js, supermetrics.js and
 *        capterra.js for what each expects) — validated loosely here (must be a non-empty
 *        object), the connector itself is the source of truth for what fields it needs. LinkedIn
 *        is the one exception — its credential is written server-side by
 *        api/oauth/linkedin/callback.js after the OAuth exchange, never POSTed here directly from
 *        the client (there's no raw token/secret for the user to paste).
 * DELETE ?provider=funnel — disconnect, removing the stored credential entirely.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";
import { needsReconnectSoon } from "../../lib/linkedinOAuth.js";

const VALID_PROVIDERS = ["funnel", "supermetrics", "capterra", "linkedin"];

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    // credential is selected here only to derive needsReconnect below — never sent to the client
    // (see the map() below, which drops it before building the response).
    const rows = await sql`
      select provider, connected_at, credential from budgethq.connector_credentials
      where workspace_id = ${workspaceId}
    `;
    return res.status(200).json({
      connections: rows.map((r) => ({
        provider: r.provider,
        connectedAt: r.connected_at,
        // Only meaningful for linkedin today — its credential can go stale with no way to
        // silently refresh (see needsReconnectSoon's doc comment). Every other provider is a
        // plain API key with no expiry, so this is always false for them.
        needsReconnect: r.provider === "linkedin" ? needsReconnectSoon(r.credential) : false,
      })),
    });
  }

  if (req.method === "POST") {
    requireEditAccess(myRole);
    const { provider, credential } = req.body || {};
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
    }
    if (!credential || typeof credential !== "object" || Array.isArray(credential) || !Object.keys(credential).length) {
      return res.status(400).json({ error: "credential must be a non-empty object" });
    }
    await sql`
      insert into budgethq.connector_credentials (workspace_id, provider, credential, connected_by)
      values (${workspaceId}, ${provider}, ${JSON.stringify(credential)}, ${userId})
      on conflict (workspace_id, provider)
      do update set credential = excluded.credential, connected_by = excluded.connected_by, connected_at = now()
    `;
    return res.status(200).json({ provider, connected: true });
  }

  if (req.method === "DELETE") {
    requireEditAccess(myRole);
    const { provider } = req.query;
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
    }
    const result = await sql`
      delete from budgethq.connector_credentials
      where workspace_id = ${workspaceId} and provider = ${provider}
      returning provider
    `;
    return res.status(200).json({ disconnected: result.length > 0 });
  }

  res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
});
