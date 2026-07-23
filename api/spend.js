/**
 * /api/spend.js — Vercel serverless function
 *
 * GET  /api/spend?action=registry
 *   Returns connector metadata (which platforms are live vs CSV)
 *
 * POST /api/spend
 *   Body: { platform, startDate, endDate, workspaceId? }
 *   Returns: { rows: [...normalized spend rows] }
 *
 *   workspaceId + a valid Authorization header are only required for connectors flagged
 *   `perWorkspaceAuth: true` in their meta export (funnel, supermetrics, capterra, linkedin, bing)
 *   — those pull the calling workspace's OWN stored credential from budgethq.connector_credentials
 *   rather than a shared process.env var, so this route needs to know which workspace is asking
 *   and confirm the caller actually belongs to it before handing back that workspace's data.
 *   google/meta are unaffected — they keep working exactly as before, no auth required, since
 *   they're still one shared account for the whole app.
 *
 *   `envVarFallback: true` in a connector's meta (capterra, linkedin) means a workspace with no
 *   stored per-workspace credential yet doesn't get hard-blocked with "not_connected" — instead
 *   getWorkspaceCredential returns null and the connector's own getSpend falls back to its legacy
 *   shared process.env credential. This is what keeps Mo's own pre-existing InsightSoftware
 *   workspace syncing without any migration step, while any OTHER workspace (no env var to fall
 *   back to) still gets a clear "connect your account" error from the connector itself. Funnel.io
 *   and Supermetrics have no such flag/fallback — they never had a shared env var credential, so
 *   their original hard "not_connected" behavior is untouched.
 *
 * Normalized row shape (same for all platforms):
 *   { campaign_name, campaign_id, platform, date, spend, impressions, clicks }
 */

import { CONNECTORS, CONNECTOR_REGISTRY } from "./connectors/index.js";
import { sql } from "./lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement } from "./lib/auth.js";
import * as linkedinOAuth from "./lib/linkedinOAuth.js";
import * as bingOAuth from "./lib/bingOAuth.js";

// Per-provider OAuth token refresh — both LinkedIn and Bing are perWorkspaceAuth connectors whose
// credential can go stale and needs refreshing before a sync call, but the two behave differently
// enough (see each lib's doc comments) that it's not worth forcing them into one shared shape:
//   - LinkedIn: refresh tokens aren't available yet at all (see linkedinOAuth.js) — this only ever
//     fires once Mo's app gets Marketing Developer Platform approval.
//   - Bing: refresh tokens are standard, but short access-token lifetimes (~60-90 min) mean this
//     fires on nearly every sync. A refresh that actually fails marks reconnectRequired on the
//     stored credential (surfaced via connections.js's GET) rather than guessing a stale-by date.
const OAUTH_REFRESH = {
  linkedin: linkedinOAuth,
  bing: bingOAuth,
};

// Looks up a workspace's stored credential for a perWorkspaceAuth connector. Throws a 400 with a
// `code: "not_connected"` the frontend can branch on (show a Connect flow) rather than a generic
// error, distinct from a real auth/permission failure (401/403) or a downstream API error (500) —
// UNLESS `optional` is set (see envVarFallback doc comment above the imports), in which case a
// missing row returns null instead of throwing, leaving the fallback decision to the connector.
async function getWorkspaceCredential(req, workspaceId, provider, { optional = false } = {}) {
  if (!workspaceId) {
    const err = new Error(`workspaceId is required to sync ${provider}`);
    err.status = 400;
    throw err;
  }
  const { userId } = await requireAuth(req);
  await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);
  const rows = await sql`
    select credential from budgethq.connector_credentials
    where workspace_id = ${workspaceId} and provider = ${provider}
  `;
  if (!rows.length) {
    if (optional) return null;
    const err = new Error(`This workspace hasn't connected ${provider} yet.`);
    err.status = 400;
    err.code = "not_connected";
    throw err;
  }
  return rows[0].credential;
}

export default async function handler(req, res) {
  // CORS — allow requests from the BudgetHQ frontend. Authorization is only actually sent for
  // perWorkspaceAuth connectors (funnel/supermetrics) — everything else still works unauthenticated.
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  // GET: return registry so frontend knows which platforms are live
  if (req.method === "GET") {
    const { action } = req.query;
    if (action === "registry") {
      return res.status(200).json({ connectors: CONNECTOR_REGISTRY });
    }
    return res.status(400).json({ error: "Use ?action=registry or POST with body" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { platform, startDate, endDate, workspaceId } = req.body || {};

  if (!platform) return res.status(400).json({ error: "platform is required" });
  if (!startDate) return res.status(400).json({ error: "startDate is required (YYYY-MM-DD)" });
  if (!endDate)   return res.status(400).json({ error: "endDate is required (YYYY-MM-DD)" });

  const connector = CONNECTORS[platform.toLowerCase()];
  if (!connector) {
    return res.status(404).json({
      error: `Unknown platform: ${platform}`,
      available: Object.keys(CONNECTORS),
    });
  }

  if (connector.status !== "live") {
    return res.status(400).json({
      error: `${connector.label} is not yet available via API.`,
      status: connector.status,
      instructions: connector.csvInstructions || null,
    });
  }

  try {
    // perWorkspaceAuth connectors need that workspace's own stored credential looked up (and the
    // caller verified as a member of it) before we can call getSpend at all — everything else
    // keeps calling getSpend exactly as before, with no credential argument, reading its shared
    // process.env var same as always.
    let credential = connector.perWorkspaceAuth
      ? await getWorkspaceCredential(req, workspaceId, platform.toLowerCase(), { optional: !!connector.envVarFallback })
      : undefined;

    // OAuth access token refresh — see OAUTH_REFRESH's doc comment above. Runs here (the one place
    // that already has this workspace's stored credential in hand) rather than letting a sync fail
    // mid-request, then persists the result back so next time doesn't need to redo the work.
    const oauth = OAUTH_REFRESH[platform.toLowerCase()];
    if (oauth && credential?.refreshToken && oauth.isCredentialStale(credential)) {
      try {
        const refreshed = await oauth.refreshAccessToken(credential);
        credential = { ...credential, ...refreshed };
      } catch (refreshErr) {
        // A refresh that actually fails (revoked, password changed, etc.) is the only honest
        // signal for providers like Bing whose refresh tokens don't have a predictable expiry to
        // count down to instead — mark it so connections.js's GET can nudge the workspace to
        // reconnect, then still let the original error surface below.
        credential = { ...credential, reconnectRequired: true };
        await sql`
          update budgethq.connector_credentials
          set credential = ${JSON.stringify(credential)}
          where workspace_id = ${workspaceId} and provider = ${platform.toLowerCase()}
        `;
        throw refreshErr;
      }
      await sql`
        update budgethq.connector_credentials
        set credential = ${JSON.stringify(credential)}
        where workspace_id = ${workspaceId} and provider = ${platform.toLowerCase()}
      `;
    }

    const rows = await connector.getSpend({ startDate, endDate, credential });
    return res.status(200).json({
      platform: connector.platform,
      startDate,
      endDate,
      count: rows.length,
      rows,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`[spend/${platform}]`, err);
    return res.status(status).json({ error: err.message, code: err.code || undefined });
  }
}
