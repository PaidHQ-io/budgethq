/**
 * Shared HMAC-signed `state` param helper for BudgetHQ's OAuth2 connect flows (LinkedIn, Bing —
 * see lib/linkedinOAuth.js and lib/bingOAuth.js). Both providers redirect the browser away to a
 * third-party consent screen and back to a callback route with NO Authorization header at all
 * (it's a real top-level navigation, not a fetch this app controls), so neither callback can rely
 * on the normal Bearer-token auth every other BudgetHQ route uses.
 *
 * Instead, each provider's `start` route signs {workspaceId, userId, provider, nonce, exp} into an
 * opaque `state` string using OAUTH_STATE_SECRET (a server-only secret, never exposed to the
 * client except as this signed blob), and the callback verifies + decodes it. That's what proves
 * the person completing the consent screen is the same authenticated user who clicked "Connect"
 * for that specific workspace — the `provider` field is included so a state token signed for one
 * provider's flow can't be replayed against another's callback.
 */
import { createHmac } from "crypto";

function getStateSecret() {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error("OAUTH_STATE_SECRET is not set — required to sign OAuth state");
  return secret;
}

export function signState(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getStateSecret()).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

// `expectedProvider` is optional but recommended — if passed, throws unless the decoded payload's
// `provider` field matches, preventing a state signed for one provider's flow from being replayed
// against another provider's callback.
export function verifyState(state, expectedProvider) {
  if (!state || typeof state !== "string" || !state.includes(".")) {
    throw new Error("Invalid or missing state parameter");
  }
  const [b64, sig] = state.split(".");
  const expectedSig = createHmac("sha256", getStateSecret()).update(b64).digest("base64url");
  if (sig !== expectedSig) throw new Error("State signature mismatch — possible tampering, try connecting again");
  const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  if (!payload.exp || Date.now() > payload.exp) throw new Error("This connect link expired — try connecting again");
  if (expectedProvider && payload.provider !== expectedProvider) {
    throw new Error("State was issued for a different provider");
  }
  return payload;
}
