/**
 * /api/email.js — Vercel serverless function
 *
 * Sends a BudgetHQ export as an email attachment via Resend's HTTP API, keeping the API key
 * server-side (same reasoning as /api/analyze.js — a secret key can never live in client code).
 *
 * Used by the "Email a copy" action in the ··· menu (Dashboard / Campaign Tagger / Budget Panel /
 * Reporting & Pacing). The file itself (CSV/XLSX/PDF/HTML) is generated client-side — this endpoint
 * only has to take the already-built base64 payload and hand it to Resend as an attachment.
 *
 * POST /api/email
 *   Body: { to, subject, note?, reportTitle, reportSubtitle, filename, mime, base64 }
 *   Returns: { id } (Resend's message id) on success
 *
 * Env vars required:
 *   RESEND_API_KEY
 * Env vars optional:
 *   RESEND_FROM_EMAIL — defaults to "BudgetHQ <onboarding@resend.dev>", which works without any
 *   domain setup but (per Resend's test-mode restriction) can only deliver to the email address
 *   the Resend account itself is registered under. Once paidhq.io is verified as a sending domain
 *   in Resend, set this to something like "BudgetHQ <reports@paidhq.io>" to send to anyone.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "RESEND_API_KEY not set" });

  const { to, subject, note, reportTitle, reportSubtitle, filename, mime, base64 } = req.body || {};
  if (!to || !EMAIL_RE.test(to)) return res.status(400).json({ error: "A valid recipient email is required" });
  if (!filename || !base64) return res.status(400).json({ error: "filename and base64 are required" });

  const from = process.env.RESEND_FROM_EMAIL || "BudgetHQ <onboarding@resend.dev>";

  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
    <div style="font-family:-apple-system,Inter,sans-serif;background:#FFFFFF;padding:32px;">
      <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:8px;padding:28px 32px;border:1px solid #E9E9E7;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;">
          <span style="width:20px;height:20px;border-radius:6px;background:#2383E2;display:inline-block;"></span>
          <span style="font-size:14px;font-weight:700;color:#37352F;">BudgetHQ</span>
        </div>
        <h1 style="font-size:18px;font-weight:700;color:#37352F;margin:0 0 4px;">${esc(reportTitle) || "Your export"}</h1>
        <p style="font-size:12px;color:#9B9A97;margin:0 0 16px;">${esc(reportSubtitle) || ""}</p>
        ${note ? `<p style="font-size:13px;color:#37352F;white-space:pre-wrap;margin:0 0 16px;">${esc(note)}</p>` : ""}
        <p style="font-size:12px;color:#787774;margin:0;">Attached: ${esc(filename)}</p>
      </div>
    </div>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: subject || reportTitle || "Your BudgetHQ export",
        html,
        attachments: [{ filename, content: base64 }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || "Resend API error" });
    }
    return res.status(200).json({ id: data.id });
  } catch (err) {
    console.error("[email]", err);
    return res.status(500).json({ error: err.message });
  }
}
