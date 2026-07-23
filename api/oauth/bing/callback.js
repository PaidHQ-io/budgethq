/**
 * GET /api/oauth/bing/callback
 *
 * Microsoft redirects the browser here directly after the user approves (or denies) the consent
 * screen — no Authorization header, no fetch, a real top-level navigation. See start.js and
 * lib/bingOAuth.js/lib/oauthState.js for how the signed `state` param carries the workspaceId/
 * userId across that hop in place of the Bearer-token auth every other route uses.
 *
 * Deliberately NOT wrapped in withApi (see lib/http.js) — that wrapper turns thrown errors into a
 * raw JSON response, which would leave the user staring at `{"error":"..."}` in their browser
 * instead of landing back in the app. Every failure path here redirects back to BudgetHQ with an
 * error flag the SPA can show as a normal notification instead.
 *
 * On success: exchanges the code for tokens, looks up which Microsoft Advertising accounts that
 * token can see (needs BING_DEVELOPER_TOKEN — see lib/bingOAuth.js's resolveAccounts), saves the
 * credential (auto-picking the account if there's exactly one), then redirects back to the app
 * with a query flag the SPA reads on load — success/select_account/error — mirroring LinkedIn's
 * callback (see api/oauth/linkedin/callback.js).
 */
import { sql } from "../../lib/db.js";
import { exchangeCodeForToken, verifyState, resolveAccounts } from "../../lib/bingOAuth.js";

function appUrl(path) {
  const base = process.env.APP_URL || "https://budget.paidhq.io";
  return `${base}${path}`;
}

export default async function handler(req, res) {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.redirect(302, appUrl(`/?bing_oauth=error&message=${encodeURIComponent(errorDescription || String(error))}`));
  }

  let payload;
  try {
    payload = verifyState(state);
  } catch (e) {
    return res.redirect(302, appUrl(`/?bing_oauth=error&message=${encodeURIComponent(e.message)}`));
  }

  try {
    const tokenCredential = await exchangeCodeForToken(code);

    const developerToken = process.env.BING_DEVELOPER_TOKEN;
    let accounts = [];
    if (developerToken) {
      try {
        accounts = await resolveAccounts(tokenCredential.accessToken, developerToken);
      } catch (resolveErr) {
        // Non-fatal — the token is still valid and saved below; the account picker will just come
        // up empty and the user can select an account later once resolved (see accounts.js). Still
        // logged (rather than silently swallowed) since an empty result here is otherwise
        // indistinguishable from "this Microsoft login genuinely has no ad accounts" — worth
        // knowing which one it was next time this misfires.
        console.error("[bing oauth callback] resolveAccounts failed:", resolveErr.message);
        accounts = [];
      }
    }

    const credential = {
      ...tokenCredential,
      accountId: accounts.length === 1 ? accounts[0].id : null,
      customerId: accounts.length === 1 ? accounts[0].customerId : null,
    };

    await sql`
      insert into budgethq.connector_credentials (workspace_id, provider, credential, connected_by)
      values (${payload.workspaceId}, 'bing', ${JSON.stringify(credential)}, ${payload.userId})
      on conflict (workspace_id, provider)
      do update set credential = excluded.credential, connected_by = excluded.connected_by, connected_at = now()
    `;

    // Anything other than exactly one resolved account needs a picker — zero accounts isn't a
    // "success" just because the token exchange worked (that used to be reported as bing_oauth=
    // success, which left the workspace silently "connected" with no accountId/customerId set at
    // all, and the account picker never got a chance to run — see accounts.js's empty-state UI for
    // what the zero-accounts case actually shows the user instead).
    if (accounts.length !== 1) {
      return res.redirect(302, appUrl(`/?bing_oauth=select_account&workspaceId=${encodeURIComponent(payload.workspaceId)}`));
    }
    return res.redirect(302, appUrl(`/?bing_oauth=success&workspaceId=${encodeURIComponent(payload.workspaceId)}`));
  } catch (e) {
    return res.redirect(302, appUrl(`/?bing_oauth=error&message=${encodeURIComponent(e.message)}`));
  }
}
