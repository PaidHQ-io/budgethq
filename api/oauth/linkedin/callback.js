/**
 * GET /api/oauth/linkedin/callback
 *
 * LinkedIn redirects the browser here directly after the user approves (or denies) the consent
 * screen — no Authorization header, no fetch, a real top-level navigation. See start.js and
 * lib/linkedinOAuth.js for how the signed `state` param carries the workspaceId/userId across
 * that hop in place of the Bearer-token auth every other route uses.
 *
 * Deliberately NOT wrapped in withApi (see lib/http.js) — that wrapper turns thrown errors into a
 * raw JSON response, which would leave the user staring at `{"error":"..."}` in their browser
 * instead of landing back in the app. Every failure path here redirects back to BudgetHQ with an
 * error flag the SPA can show as a normal notification instead.
 *
 * On success: exchanges the code for tokens, looks up which ad accounts that token can see, saves
 * the credential (auto-picking the account if there's exactly one), then redirects back to the app
 * with a query flag the SPA reads on load to refresh its connected-providers list and show a
 * confirmation (or, if more than one ad account is available, prompt the user to pick which one —
 * see accounts.js).
 */
import { sql } from "../../lib/db.js";
import { exchangeCodeForToken, verifyState, listAdAccounts } from "../../lib/linkedinOAuth.js";

function appUrl(path) {
  const base = process.env.APP_URL || "https://budget.paidhq.io";
  return `${base}${path}`;
}

export default async function handler(req, res) {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.redirect(302, appUrl(`/?linkedin_oauth=error&message=${encodeURIComponent(errorDescription || String(error))}`));
  }

  let payload;
  try {
    payload = verifyState(state);
  } catch (e) {
    return res.redirect(302, appUrl(`/?linkedin_oauth=error&message=${encodeURIComponent(e.message)}`));
  }

  try {
    const tokenCredential = await exchangeCodeForToken(code);

    let accounts = [];
    try {
      accounts = await listAdAccounts(tokenCredential.accessToken);
    } catch {
      // Non-fatal — the token is still valid and saved below; the account picker will just come
      // up empty and the user can select an account later once resolved (see accounts.js).
      accounts = [];
    }

    const credential = { ...tokenCredential, accountId: accounts.length === 1 ? accounts[0].id : null };

    await sql`
      insert into budgethq.connector_credentials (workspace_id, provider, credential, connected_by)
      values (${payload.workspaceId}, 'linkedin', ${JSON.stringify(credential)}, ${payload.userId})
      on conflict (workspace_id, provider)
      do update set credential = excluded.credential, connected_by = excluded.connected_by, connected_at = now()
    `;

    if (accounts.length > 1) {
      return res.redirect(302, appUrl(`/?linkedin_oauth=select_account&workspaceId=${encodeURIComponent(payload.workspaceId)}`));
    }
    return res.redirect(302, appUrl(`/?linkedin_oauth=success&workspaceId=${encodeURIComponent(payload.workspaceId)}`));
  } catch (e) {
    return res.redirect(302, appUrl(`/?linkedin_oauth=error&message=${encodeURIComponent(e.message)}`));
  }
}
