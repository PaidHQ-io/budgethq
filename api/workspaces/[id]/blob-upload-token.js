/**
 * /api/workspaces/[id]/blob-upload-token — mints a short-lived Vercel Blob client-upload token so
 * the browser can upload a file straight to Blob storage, bypassing Vercel's hard 4.5MB serverless
 * function request-body limit entirely (2026-08-19, per Mo — a >10MB Vault attachment upload was
 * failing with a generic "request failed", which turned out to be a 413 from that platform limit,
 * not a bug in our code — see the same limit's earlier fix note in api/lib/http.js's readJsonBody).
 *
 * Used by workspaceApi.js's uploadFileViaBlob(), which calls @vercel/blob/client's upload() with
 * this route as handleUploadUrl, then POSTs the resulting blob URL (not file bytes) to files.js —
 * see that route's own doc comment for the blob_url storage path.
 *
 * Auth: same as every other route here — a Bearer token in the Authorization header, read via
 * requireAuth(req). The Blob client SDK's upload() supports an explicit `headers` option for
 * exactly this (it does NOT forward the browser's normal request headers automatically), so
 * uploadFileViaBlob() passes the session token that way rather than needing a workaround.
 *
 * No onUploadCompleted here: that's an optional webhook Vercel calls back after the upload
 * finishes, meant for writing to your DB without trusting the client. We skip it and let the
 * client itself POST the metadata to files.js right after upload() resolves instead — simpler, no
 * public-webhook-reachability requirement, and the worst case of a dropped client (tab closed
 * mid-flow) is just an orphaned blob, not lost data.
 */
import { handleUpload } from "@vercel/blob/client";
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement, requireEditAccess } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

export default withApi(async (req, res) => {
  const { id: workspaceId } = req.query;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const jsonResponse = await handleUpload({
    body: req.body,
    request: req,
    onBeforeGenerateToken: async () => {
      const { userId } = await requireAuth(req);
      const myRole = await requireWorkspaceMember(sql, workspaceId, userId);
      await requireEntitlement(sql, workspaceId);
      requireEditAccess(myRole);
      return {
        access: "public",
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ userId, workspaceId }),
      };
    },
  });

  return res.status(200).json(jsonResponse);
});
