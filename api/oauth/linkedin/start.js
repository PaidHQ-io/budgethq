/**
 * GET /api/oauth/linkedin/start?workspaceId=...
 *
 * Called via an authenticated fetch (Bearer header, same as every other BudgetHQ API route) from
 * the SPA's Connect panel — NOT a raw browser navigation, since we need to verify the caller
 * actually belongs to (and can edit) the workspace they're connecting BEFORE handing back a
 * LinkedIn consent URL. The frontend then does `window.location.href = url` itself to hand the
 * browser off to LinkedIn for the actual consent screen — that hop can't carry our Bearer header
 * (it's a real top-level navigation), which is exactly why workspaceId+userId get baked into the
 * signed `state` param instead (see lib/linkedinOAuth.js's doc comment, and callback.js).
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";
import { buildAuthorizeUrl } from "../../lib/linkedinOAuth.js";

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
