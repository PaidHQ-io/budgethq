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
import { needsReconnectSoon as linkedinNeedsReconnectSoon } from "../../lib/linkedinOAuth.js";
import { needsReconnectSoon as bingNeedsReconnectSoon } from "../../lib/bingOAuth.js";

// Per-provider reconnect check — see each lib's needsReconnectSoon doc comment. LinkedIn's is
// time-based (no refresh token available at all yet); Bing's is failure-based (refresh tokens are
// undated, so a failed refresh attempt — tracked as credential.reconnectRequired — is the only
// honest signal). Every other provider is a plain API key with no expiry, so always false.
const RECONNECT_CHECKS = {
  linkedin: linkedinNeedsReconnectSoon,
  bing: bingNeedsReconnectSoon,
};

// Distinct from RECONNECT_CHECKS above: a token can be perfectly valid but still missing the ad
// account it should sync from — e.g. the token exchange succeeded but the account-picker step
// (api/oauth/{provider}/accounts.js) never got a selection saved. Both LinkedIn and Bing's
// connectors hard-require credential.accountId to call getSpend at all; Bing additionally needs
// credential.customerId (see api/connectors/bing.js). Surfacing this separately from
// needsReconnect matters because the fix is different — reopen the account picker with the
// EXISTING token (no need to redo the consent screen), not send the user through OAuth again.
const ACCOUNT_INCOMPLETE_CHECKS = {
  linkedin: (credential) => !!credential?.accessToken && !credential?.accountId,
  bing: (credential) => !!credential?.accessToken && (!credential?.accountId || !credential?.customerId),
};

const VALID_PROVIDERS = ["funnel", "supermetrics", "capterra", "linkedin", "bing"];

// Settings' connections-management table needs SOMETHING to show per provider beyond just
// "connected" — but the credential itself must never reach the client (see GET's doc comment
// above). Each extractor below picks out only the fields that are safe to show (account names/
// IDs, data-source IDs) and leaves out anything that's actually a secret (API tokens/keys, OAuth
// access/refresh tokens). Capterra's apiKeys is a {productName: key} map — only the product names
// (the object's keys) are safe to show, never the values.
const SAFE_SUMMARY = {
  linkedin: (c) => ({ accountId: c?.accountId || null, accountName: c?.accountName || null }),
  bing: (c) => ({ accountId: c?.accountId || null, accountName: c?.accountName || null, customerId: c?.customerId || null }),
  funnel: (c) => ({ accountId: c?.accountId || null, projectId: c?.projectId || null }),
  supermetrics: (c) => ({ dsId: c?.dsId || null, dsAccounts: c?.dsAccounts || null }),
  capterra: (c) => ({ products: c?.apiKeys ? Object.keys(c.apiKeys) : [] }),
};

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  if (req.method === "GET") {
    // credential is selected here only to derive needsReconnect/summary below — never sent to the
    // client itself (see the map() below, which drops it before building the response).
    // connected_by is a bare uuid (see db/schema.sql) — the frontend resolves it to an email by
    // matching against the workspace's own member list (already fetched for the Team panel via
    // paidhq-core's /members endpoint) rather than this route trying to join a users table it
    // doesn't own.
    const rows = await sql`
      select provider, connected_at, connected_by, credential from budgethq.connector_credentials
      where workspace_id = ${workspaceId}
    `;
    return res.status(200).json({
      connections: rows.map((r) => ({
        provider: r.provider,
        connectedAt: r.connected_at,
        connectedBy: r.connected_by,
        needsReconnect: RECONNECT_CHECKS[r.provider] ? RECONNECT_CHECKS[r.provider](r.credential) : false,
        needsAccountSelection: ACCOUNT_INCOMPLETE_CHECKS[r.provider] ? ACCOUNT_INCOMPLETE_CHECKS[r.provider](r.credential) : false,
        summary: SAFE_SUMMARY[r.provider] ? SAFE_SUMMARY[r.provider](r.credential) : {},
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
