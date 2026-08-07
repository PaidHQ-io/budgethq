/**
 * Account Planning engine (2026-08-06, per Mo — restructuring/rebuilding an account's campaign
 * structure: "looking at what's working and then porting that over to a new structure... world
 * class, bespoke, purpose-built for performance"). Pure functions, no fetching/React — the wizard
 * UI (AccountPlanning.jsx) supplies mergedNormRows/reportingFacts it's already loaded and calls in.
 *
 * Two independent halves:
 *   1. AUDIT — buildAuditGroups + scoreAuditGroups: "what's working" in the CURRENT structure.
 *   2. TAXONOMY — generateName/validateName: what the NEW structure's names should look like.
 * The Mapping step (old -> new) is just a plain array the UI manages directly against these two;
 * it doesn't need its own engine functions here.
 */
import { isPipelineSource } from "./pipelineColumnMapping.js";
import { derivePlatform, groupGooglePlatform, parseSpendDate } from "./core.js";

// ─── AUDIT ──────────────────────────────────────────────────────────────────────────────────────

// Priority order for picking ONE "primary" funnel metric per campaign when reporting_facts data
// exists for it — favors metrics closest to revenue (more trustworthy signal of "what's working"
// for a B2B demand-gen account) over top-of-funnel volume metrics. The first key in this list with
// a nonzero summed value for a given campaign becomes that campaign's primaryMetricKey; every ad
// under it (if ad-level) inherits the SAME metric, so scores stay comparable within one campaign.
export const PIPELINE_METRIC_PRIORITY = [
  "pipeline_value", "revenue", "closed_won", "sqls", "mqls", "sals",
  "meetings_booked", "demos", "pqls", "handraisers", "mqas", "leads",
];

const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

// Platform "family" — determines which naming vocabulary (Ad Set vs Ad Group) and which spend rows
// carry real ad-level identity (only LinkedIn/Meta connectors populate ad_id/ad_name today — see
// spendRowsColumns.js's own doc comment). Everything else (Google, Bing, Demand Gen, Performance
// Max, YouTube) is "search" family and campaign/ad-group level only in this app right now.
export function platformFamily(platform) {
  return platform === "LinkedIn" || platform === "Meta" ? "social" : "search";
}

// Groups mergedNormRows by the same identity spendRowKey uses (platform/campaign group/campaign/ad),
// summing spend/impressions/clicks/extra conversions, then allocates each matched campaign's
// reporting_facts funnel totals across its ad-level groups proportional to spend share (campaign-
// level groups get a direct 1:1 match, no allocation needed). Campaign <-> reporting_facts matching
// is by normalized campaign name string — there's no hard FK between spend_rows and reporting_facts
// anywhere in this app (see computeReportingAudit's own doc comment for the same convention).
export function buildAuditGroups({ mergedNormRows = [], reportingFacts = [], combineGoogleChannels = {}, dateFrom, dateTo } = {}) {
  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;
  const inRange = (d) => (!d ? false : (!from || d >= from) && (!to || d <= to));

  const groupMap = new Map();
  const campaignSpendTotals = new Map(); // normalized campaign name -> total spend (for proportional allocation)

  for (const r of mergedNormRows) {
    const d = parseSpendDate(r.date);
    if ((dateFrom || dateTo) && !inRange(d)) continue;
    const platform = groupGooglePlatform(
      derivePlatform(r.campaign_group_name, r.campaign_name, r.platform, r.campaign_type),
      combineGoogleChannels
    );
    const hasAdIdentity = (r.ad_id != null && String(r.ad_id).trim()) || (r.ad_name || "").trim();
    const adLabel = (r.ad_id != null && String(r.ad_id).trim()) ? (r.ad_name || `Ad ${r.ad_id}`) : (r.ad_name || "");
    const level = hasAdIdentity ? "ad" : "campaign";
    const key = [platform, r.campaign_group_name || "", r.campaign_name || "", hasAdIdentity ? (r.ad_id || r.ad_name || "") : ""].join("||");
    const campaignNameKey = norm(r.campaign_name || r.campaign_group_name);

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key, level, platform,
        campaignGroupName: r.campaign_group_name || "",
        campaignName: r.campaign_name || "",
        adLabel,
        campaignNameKey,
        spend: 0, impressions: 0, clicks: 0, conversions: 0,
      });
    }
    const g = groupMap.get(key);
    g.spend += r.spend || 0;
    g.impressions += r.impressions || 0;
    g.clicks += r.clicks || 0;
    const em = r.extra_metrics || {};
    g.conversions += Number(em.conversions ?? em.all_conversions ?? 0) || 0;

    campaignSpendTotals.set(campaignNameKey, (campaignSpendTotals.get(campaignNameKey) || 0) + (r.spend || 0));
  }

  // Sum reporting_facts (pipeline-source only — goals rows excluded, same fix as PipelineTagger.jsx)
  // per normalized campaign name, across every funnel metric key at once.
  const factsByCampaign = new Map();
  for (const row of reportingFacts) {
    if (!isPipelineSource(row.source || "")) continue;
    const d = row.periodStart ? new Date(String(row.periodStart).slice(0, 10)) : null;
    if ((dateFrom || dateTo) && !inRange(d)) continue;
    const key = norm(row.campaignName);
    if (!key) continue;
    if (!factsByCampaign.has(key)) factsByCampaign.set(key, {});
    const totals = factsByCampaign.get(key);
    for (const [mKey, mVal] of Object.entries(row.metrics || {})) {
      if (mKey.endsWith("_goal")) continue; // goal numbers, not actuals — never mix into audit scoring
      totals[mKey] = (totals[mKey] || 0) + (Number(mVal) || 0);
    }
  }

  // Pick each campaign's single primary metric (first nonzero in priority order), then allocate to
  // every group under that campaign name, proportional to the group's share of the campaign's total
  // spend (falls back to an even split if the campaign somehow has zero recorded spend).
  const groups = [...groupMap.values()];
  for (const g of groups) {
    const facts = factsByCampaign.get(g.campaignNameKey);
    if (!facts) { g.primaryMetricKey = null; g.primaryMetricValue = 0; continue; }
    const primaryKey = PIPELINE_METRIC_PRIORITY.find((k) => (facts[k] || 0) > 0) || null;
    g.primaryMetricKey = primaryKey;
    if (!primaryKey) { g.primaryMetricValue = 0; continue; }
    const campaignTotalSpend = campaignSpendTotals.get(g.campaignNameKey) || 0;
    const share = campaignTotalSpend > 0 ? g.spend / campaignTotalSpend : 1 / groups.filter((x) => x.campaignNameKey === g.campaignNameKey).length;
    g.primaryMetricValue = (facts[primaryKey] || 0) * share;
  }
  return groups;
}

// Annotates each group with a signalType ("pipeline" | "platform-conversions" | "platform-engagement"
// | "insufficient-volume") and a tier ("keep" | "review" | "consolidate" | "insufficient-data"),
// ranked ONLY against other groups sharing the same signalType — a $/MQL number is not comparable to
// a CPC number, so mixing them into one ranking would be a false precision the demo can't afford.
// minSpend: groups below this total spend don't have enough volume to trust a tier judgment either
// way, regardless of which signal they'd otherwise use.
export function scoreAuditGroups(groups, { minSpend = 100 } = {}) {
  const cohorts = { pipeline: [], "platform-conversions": [], "platform-engagement": [] };
  const scored = groups.map((g) => {
    const base = { ...g };
    if (g.spend < minSpend) {
      base.signalType = "insufficient-volume";
      base.tier = "insufficient-data";
      return base;
    }
    if (g.primaryMetricKey && g.primaryMetricValue > 0) {
      base.signalType = "pipeline";
      base.costPerUnit = g.spend / g.primaryMetricValue;
      cohorts.pipeline.push(base);
    } else if (g.conversions > 0) {
      base.signalType = "platform-conversions";
      base.costPerUnit = g.spend / g.conversions;
      cohorts["platform-conversions"].push(base);
    } else if (g.clicks > 0) {
      base.signalType = "platform-engagement";
      base.costPerUnit = g.spend / g.clicks; // CPC
      base.ctr = g.impressions > 0 ? g.clicks / g.impressions : null;
      cohorts["platform-engagement"].push(base);
    } else {
      base.signalType = "insufficient-volume";
      base.tier = "insufficient-data";
    }
    return base;
  });

  for (const list of Object.values(cohorts)) {
    list.sort((a, b) => a.costPerUnit - b.costPerUnit); // lower cost-per-outcome = better
    const n = list.length;
    list.forEach((g, i) => {
      const pct = n <= 1 ? 0 : i / (n - 1);
      g.tier = pct <= 0.25 ? "keep" : pct >= 0.75 ? "consolidate" : "review";
      g.rank = i + 1;
      g.cohortSize = n;
    });
  }
  return scored;
}

// ─── TAXONOMY ───────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_TAXONOMY_DIMENSIONS = [
  { key: "product", label: "Product", values: [] },
  { key: "region", label: "Region", values: [] },
  { key: "funnel", label: "Funnel Stage", values: ["TOFU", "MOFU", "BOFU"] },
  { key: "audience", label: "Audience", values: [] },
  { key: "buytype", label: "Buy Type", values: ["Prospecting", "Retargeting", "ABM"] },
];

// Level labels per platform family, per Mo's call: "Campaign, Ad set/Ad group and Ad naming (for
// paid social)" — search-family platforms use "Ad Group" (Google/Bing/YouTube/Demand Gen/Performance
// Max), social-family (LinkedIn/Meta) use "Ad Set". "campaign" and "ad" labels are shared.
export const LEVEL_DEFS = [
  { key: "campaign", label: { search: "Campaign", social: "Campaign" } },
  { key: "adgroup", label: { search: "Ad Group", social: "Ad Set" } },
  { key: "ad", label: { search: "Ad / Keyword", social: "Ad" } },
];
export function levelLabel(levelKey, family) {
  return LEVEL_DEFS.find((l) => l.key === levelKey)?.label[family] || levelKey;
}

const defaultTemplateForLevel = {
  campaign: "{platform}_{buytype}_{product}_{region}_{funnel}",
  adgroup: "{audience}_{funnel}",
  ad: "{product}_{funnel}_{format}",
};
export function buildDefaultNameTemplates() {
  return { ...defaultTemplateForLevel };
}

// Fills a "{token}_{token}" template from a values map, dropping any token with no value instead of
// leaving a literal "{key}" or a blank segment behind, and collapsing the separator so a dropped
// token doesn't leave a double-underscore. Separator is auto-detected from the template (whatever
// non-alnum/non-brace character sits between the first two tokens) so a taxonomy that prefers "-"
// over "_" works unchanged.
export function generateName(template, values = {}) {
  if (!template) return "";
  const sepMatch = template.match(/}([^{a-zA-Z0-9])\{/);
  const sep = sepMatch ? sepMatch[1] : "_";
  const parts = template.split(/\{([a-zA-Z0-9_]+)\}/g);
  // split() with a capturing group alternates [literal, token, literal, token, ...literal]
  const filled = [];
  for (let i = 1; i < parts.length; i += 2) {
    const token = parts[i];
    const v = (values[token] || "").toString().trim();
    if (v) filled.push(v);
  }
  return filled.join(sep);
}

export function templateTokens(template) {
  if (!template) return [];
  return [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
}

// Lightweight validation, not a strict parser: checks the name has roughly the expected number of
// segments for the template's separator and that every segment is non-empty. Good enough to catch
// "someone typed a raw campaign name with no structure at all" or "missing a segment" without
// pretending to fully reverse-engineer an arbitrary existing name back into dimension values.
export function validateName(name, template) {
  const issues = [];
  if (!name || !name.trim()) return { valid: false, issues: ["Name is empty"] };
  const sepMatch = (template || "").match(/}([^{a-zA-Z0-9])\{/);
  const sep = sepMatch ? sepMatch[1] : "_";
  const expectedSegments = templateTokens(template).length;
  const actualSegments = name.split(sep).filter((s) => s.length > 0);
  if (expectedSegments && actualSegments.length < expectedSegments) {
    issues.push(`Expected ${expectedSegments} segment(s) separated by "${sep}", found ${actualSegments.length}`);
  }
  if (/\{[a-zA-Z0-9_]+\}/.test(name)) issues.push("Contains an unfilled {token} placeholder");
  if (/\s{2,}/.test(name)) issues.push("Contains double spaces");
  return { valid: issues.length === 0, issues };
}
