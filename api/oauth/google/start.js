/**
 * GET /api/oauth/google/start?workspaceId=...
 *
 * Called via an authenticated fetch (Bearer header) from the SPA's Connect panel — NOT a raw
 * browser navigation, since we need to verify the caller actually belongs to (and can edit) the
 * workspace they're connecting BEFORE handing back a Google consent URL. The frontend then does
 * `window.location.href = url` itself to hand the browser off to Google for the actual consent
 * screen — that hop can't carry our Bearer header (it's a real top-level navigation), which is
 * exactly why workspaceId+userId get baked into the signed `state` param instead (see
 * lib/googleAdsOAuth.js's doc comment, and callback.js). Mirrors api/oauth/meta/start.js exactly,
 * swapped to Google's OAuth helpers.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";
import { buildAuthorizeUrl } from "../../lib/googleAdsOAuth.js";

export default withApi(async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });

  const { userId } = await requireAuth(req);
  const role = await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);
  requireEditAccess(role);

  const url = buildAuthorizeUrl({ workspaceId, userId });
  return res.status(200).json({ url });
});
