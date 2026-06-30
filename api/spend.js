/**
 * /api/spend.js — Vercel serverless function
 *
 * GET  /api/spend?action=registry
 *   Returns connector metadata (which platforms are live vs CSV)
 *
 * POST /api/spend
 *   Body: { platform, startDate, endDate }
 *   Returns: { rows: [...normalized spend rows] }
 *
 * Normalized row shape (same for all platforms):
 *   { campaign_name, campaign_id, platform, date, spend, impressions, clicks }
 */

import { CONNECTORS, CONNECTOR_REGISTRY } from "./connectors/index.js";

export default async function handler(req, res) {
  // CORS — allow requests from the BudgetHQ frontend
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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

  const { platform, startDate, endDate } = req.body || {};

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
    const rows = await connector.getSpend({ startDate, endDate });
    return res.status(200).json({
      platform: connector.platform,
      startDate,
      endDate,
      count: rows.length,
      rows,
    });
  } catch (err) {
    console.error(`[spend/${platform}]`, err);
    return res.status(500).json({ error: err.message });
  }
}
