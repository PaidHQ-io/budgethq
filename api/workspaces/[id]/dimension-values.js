/**
 * /api/workspaces/[id]/dimension-values — GET only.
 *
 * Ported from ReportingHQ (2026-07-30, per Mo — folding ReportingHQ into PaidHQ as a "Reporting
 * Analyzer" tab). Returns the workspace's actual tag DIMENSION NAMES plus known VALUES for each, so
 * the Reporting Analyzer's import review UI tags with the exact same dimensions as Campaign
 * Tagger — not a separate hardcoded vocabulary. tag_dims are themselves user-editable per workspace
 * (e.g. today: Product, Region, Funnel, Pillar, Branded Search, Module, Brand — could gain/lose
 * entries any time via Campaign Tagger's "+ New dimension"), so this can't be a fixed list baked
 * into code; it has to be read live from core.workspace_config.tag_dims every time.
 *
 * Response shape:
 *   { tagDims: string[], values: { [dimensionName]: string[] }, campaignName: string[] }
 *
 * Sources merged per field:
 * - tagDims: core.workspace_config.tag_dims verbatim (this workspace's current dimension list).
 * - values[dim]: every value ever assigned to that dimension name in Campaign Tagger's
 *   workspace_config.tags blob ({ [campaignKey]: { [dim]: value } }), PLUS every value already
 *   used for that same dimension name in this workspace's own core.reporting_facts.tags.
 * - campaignName: distinct campaign_name already used in core.reporting_facts for this workspace,
 *   plus core.spend_rows' campaign_group_name and campaign_name — best-effort autocomplete, not an
 *   authoritative join key, since spend rows and reporting facts don't share one identical
 *   campaign-naming convention.
 */
import { sql } from "../../lib/db.js";
import { requireAuth, requireWorkspaceMember, requireEntitlement } from "../../lib/auth.js";
import { withApi } from "../../lib/http.js";

function dedupeSorted(values) {
  return Array.from(new Set(values.filter((v) => v && String(v).trim()))).sort((a, b) => a.localeCompare(b));
}

export default withApi(async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id: workspaceId } = req.query;
  const { userId } = await requireAuth(req);
  await requireWorkspaceMember(sql, workspaceId, userId);
  await requireEntitlement(sql, workspaceId);

  const [factsRows, configRows, spendRows] = await Promise.all([
    sql`select campaign_name, tags from core.reporting_facts where workspace_id = ${workspaceId}`,
    sql`select tags, tag_dims from core.workspace_config where workspace_id = ${workspaceId}`,
    sql`select distinct campaign_group_name, campaign_name from core.spend_rows where workspace_id = ${workspaceId}`,
  ]);

  const tagDims = Array.isArray(configRows[0]?.tag_dims) ? configRows[0].tag_dims : [];
  const values = {};
  const ensure = (dim) => (values[dim] = values[dim] || []);

  // Seed every current dimension so the response always has an (possibly empty) array for it,
  // even if nothing's been tagged with it yet.
  tagDims.forEach((dim) => ensure(dim));

  // Campaign Tagger's values — { [campaignKey]: { [dimName]: value } }.
  const tags = configRows[0]?.tags || {};
  Object.values(tags).forEach((dimValues) => {
    Object.entries(dimValues || {}).forEach(([dimName, value]) => {
      ensure(dimName).push(value);
    });
  });

  // Reporting Analyzer's own past imports — core.reporting_facts.tags, same { [dimName]: value } shape.
  factsRows.forEach((r) => {
    Object.entries(r.tags || {}).forEach(([dimName, value]) => {
      ensure(dimName).push(value);
    });
  });

  Object.keys(values).forEach((dim) => {
    values[dim] = dedupeSorted(values[dim]);
  });

  const campaignName = dedupeSorted([
    ...factsRows.map((r) => r.campaign_name),
    ...spendRows.map((r) => r.campaign_group_name),
    ...spendRows.map((r) => r.campaign_name),
  ]);

  return res.status(200).json({ tagDims, values, campaignName });
});
