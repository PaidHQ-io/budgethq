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

// LinkedIn's own Company Size targeting facet (2026-08-06, per Mo — "the ranges in the ad sets in
// linkedin are 1-10, 11-50..."): these are LinkedIn Campaign Manager's literal audience-targeting
// buckets, a DIFFERENT concept from the "segment" dimension below (SMB/MM/ENT is Mo's own naming
// shorthand for a name-friendly bucket; these ranges are what actually gets clicked in LinkedIn's
// targeting UI) — kept as its own list, attached to Targeting Profiles as companySizeRanges, not
// merged into the segment dimension or used in campaign names.
export const LINKEDIN_COMPANY_SIZE_RANGES = ["1-10", "11-50", "51-200", "201-500", "501-1,000", "1,001-5,000", "5,001-10,000", "10,000+"];

// LinkedIn's industry taxonomy (2026-08-06, per Mo — "here's also a list of the linkedin industries
// we can use in a drop down multi selection... make sure its searchable"), transcribed from Mo's own
// paste. A few likely typos were corrected against Mo's OWN second (categorized) list, which agreed
// on the corrected spelling in each case: "Correctional Instituations" -> "Correctional
// Institutions", "Fine Arts School" -> "Fine Arts Schools" (matches the plural pattern of every
// other "...Schools" entry, and the categorized list's own "Fine Arts Schools"). Two entries were
// corrected on general knowledge of LinkedIn's real taxonomy without a second source in Mo's own
// lists to confirm against — "Metal One Mining" -> "Metal Ore Mining" and "Speciality Trade
// Contractors" -> "Specialty Trade Contractors" (American spelling, consistent with every other
// entry in the list) — worth a quick skim given the size of this list and that it was transcribed
// by hand rather than pulled from an API. Everything else is verbatim from Mo's paste, including
// entries that look redundant with a broader sibling (e.g. "Farming" alongside "Farming, Ranching
// and Forestry") — LinkedIn's real taxonomy does carry legacy + consolidated values side by side, so
// these weren't merged.
export const LINKEDIN_INDUSTRIES = [
  "Abrasives and Nonmetallic Minerals Manufacturing", "Accessible Architecture and Design", "Accessible Hardware Manufacturing",
  "Accommodation and Food Services", "Accounting", "Administration of Justice", "Administrative and Support Services",
  "Advertising Services", "Agriculture Chemical Manufacturing", "Agriculture, Construction, Mining Machinery Manufacturing",
  "Air, Water and Waste Program Management", "Airlines and Aviation", "Alternative Dispute Resolution",
  "Alternative Fuel Vehicle Manufacturing", "Alternative Medicine", "Ambulance Services", "Amusement Parks and Arcades",
  "Animal Feed Manufacturing", "Animation and Post-Production", "Apparel Manufacturing",
  "Appliances, Electrical and Electronics Manufacturing", "Architecture and Planning", "Architecture and Structural Metal Manufacturing",
  "Armed Forces", "Artificial Rubber and Synthetic Fiber Manufacturing", "Artists and Writers", "Audio and Video Equipment Manufacturing",
  "Automation Machinery Manufacturing", "Aviation and Aerospace Component Manufacturing", "Baked Goods Manufacturing", "Banking",
  "Bars, Taverns and Nightclubs", "Bed and Breakfast, Hostels and Homestays", "Beverage Manufacturing",
  "Biomass Electric Power Generation", "Biotechnology Research", "Blockchain Services", "Blogs",
  "Boilers, Tanks and Shipping Container Manufacturing", "Book and Periodical Publishing", "Book Publishing", "Breweries",
  "Broadcast Media Production and Distribution", "Building Construction", "Building Equipment Contractors",
  "Building Finishing Contractors", "Building Structure and Exterior Contractors", "Business Consulting and Services",
  "Business Content", "Business Intelligence Platforms", "Cable and Satellite Programming", "Capital Markets", "Caterers",
  "Chemical Manufacturing", "Chemical Raw Materials Manufacturing", "Child Day Care Services", "Chiropractors",
  "Circuses and Magic Shows", "Civic and Social Organizations", "Civil Engineering", "Claims Adjusting, Actuarial Services",
  "Clay and Refractory Products Manufacturing", "Climate Data and Analytics", "Climate Technology Product Manufacturing",
  "Coal Mining", "Collective Agencies", "Commercial and Industrial Equipment Rental", "Commercial and Industrial Machinery Maintenance",
  "Communications Equipment Manufacturing", "Community Development and Urban Planning", "Computer and Network Security",
  "Computer Games", "Computer Hardware Manufacturing", "Computer Networking Products", "Computers and Electronics Manufacturing",
  "Construction", "Construction Hardware Manufacturing", "Consumer Goods Rental", "Consumer Services", "Correctional Institutions",
  "Cosmetology and Barber Schools", "Courts of Law", "Credit Intermediation", "Cutlery and Handtool Manufacturing",
  "Dairy Product Manufacturing", "Dance Companies", "Data Infrastructure and Analytics", "Data Security Software Products",
  "Defense and Space Manufacturing", "Dentists", "Design Services", "Desktop Computing Software Products",
  "Digital Accessibility Services", "Distilleries", "E-Learning Providers", "Economic Programs", "Education",
  "Education Administration Programs", "Electric Lighting Equipment Manufacturing", "Electric Power Generation",
  "Electric Power Transmission, Control and Distribution", "Electrical Equipment Manufacturing",
  "Electronic and Precision Equipment Maintenance", "Embedded Software Products", "Emergency and Relief Services",
  "Engineering Services", "Engines and Power Transmission Equipment Manufacturing", "Entertainment Providers",
  "Environmental Quality Programs", "Environmental Services", "Equipment", "Equipment Rental Services", "Events Services",
  "Executive Offices", "Executive Search Services", "Fabricated Metal Products", "Facilities Services",
  "Family Planning Centers", "Farming", "Farming, Ranching and Forestry", "Fashion Accessories Manufacturing",
  "Financial Services", "Fine Arts Schools", "Fire Protection", "Fisheries", "Flight Training", "Food and Beverage Manufacturing",
  "Food and Beverage Retail", "Food and Beverage Services", "Footwear and Leather Goods Repair", "Footwear Manufacturing",
  "Forestry and Logging", "Fossil Fuel Electric Power Generation", "Freight and Package Transportation",
  "Fruit and Vegetable Preserves Manufacturing", "Fuel Cell Manufacturing", "Fundraising", "Funds and Trusts",
  "Furniture and Home Furnishings Manufacturing", "Gambling Facilities and Casinos", "Geothermal Electric Power Generation",
  "Glass Product Manufacturing", "Glass, Ceramics and Concrete Manufacturing", "Golf Courses and Country Clubs",
  "Government Administration", "Government Relationship Services", "Graphic Design", "Ground Passenger Transportation",
  "Health and Human Services", "Higher Education", "Highway, Street and Bridge Construction", "Historical Sites",
  "Holding Companies", "Home Health Care Services", "Horticulture", "Hospitality", "Hospitals", "Hospitals and Healthcare",
  "Hotels and Motels", "Household Appliance Manufacturing", "Household Institutional Furniture Manufacturing",
  "Household Services", "Housing and Community Development", "Human Resources Services",
  "HVAC and Refrigeration Equipment Manufacturing", "Hydroelectric Power Generation", "Individual and Family Services",
  "Industrial Machinery Manufacturing", "Industry Associates", "Information Services", "Insurance",
  "Insurance Agencies and Brokerages", "Insurance and Employee Benefit Funds", "Insurance Carriers", "Interior Design",
  "International Affairs", "International Trade and Development", "Internet Marketplace Platforms", "Internet News",
  "Internet Publishing", "Interurban and Rural Bus Service", "Investment Advice", "Investment Banking", "Investment Management",
  "IT Services and IT Consulting", "IT System Custom Software Development", "IT System Data Services", "IT System Design Services",
  "IT System Installation and Disposal", "IT System Testing and Evaluation", "IT System Training and Support",
  "IT Systems Operations and Maintenance", "Janitorial Services", "Landscaping Services", "Language Schools",
  "Laundry and Drycleaning Services", "Law Enforcement", "Law Practice", "Leasing Non-Residential Real Estate",
  "Leasing Residential Real Estate", "Leather Product Manufacturing", "Legal Services", "Libraries",
  "Lime and Gypsum Products Manufacturing", "Loan Brokers", "Machinery Manufacturing", "Magnetic and Optical Media Manufacturing",
  "Manufacturing", "Maritime Transportation", "Market Research", "Mattress and Blinds Manufacturing",
  "Measuring and Control Instrument Manufacturing", "Media and Telecommunications", "Media Production",
  "Medical and Diagnostic Laboratories", "Medical Equipment Manufacturing", "Medical Practices", "Mental Health Care",
  "Metal Ore Mining", "Metal Treatments", "Metal Valve, Ball and Roller Manufacturing", "Metal Working Machinery Manufacturing",
  "Military and International Affairs", "Mining", "Mobile Computing Software Products", "Mobile Food Services",
  "Mobile Gaming Apps", "Motor Vehicle Manufacturing", "Motor Vehicle Parts Manufacturing", "Movies and Sound Recording",
  "Movies, Video and Sound", "Museums", "Museums, Historical Sites and Zoos", "Musicians", "Nanotechnology Research",
  "Natural Gas Distribution", "Natural Gas Extraction", "Newspaper Publishing", "Non-Profit Organizations",
  "Nonmetallic Mineral Mining", "Nonresidential Building Construction", "Nuclear Electric Power Generation",
  "Nursing Homes and Residential Care Facilities", "Office Administration", "Office Furniture and Fixtures Manufacturing",
  "Oil and Coal Product Manufacturing", "Oil and Gas", "Oil Extraction", "Oil, Gas and Mining", "Online and Mail Order Retail",
  "Online Audio and Video Media", "Operations Consulting", "Optometrists", "Outpatient Care Centers",
  "Outsourcing and Offshoring Consulting", "Packaging and Containers Manufacturing", "Paint, Coating and Adhesive Manufacturing",
  "Paper and Forest Product Manufacturing", "Pension Funds", "Performing Arts", "Performing Arts and Spectator Sports",
  "Periodical Publishing", "Personal and Laundry Services", "Personal Care Product Manufacturing", "Personal Care Services",
  "Pet Services", "Pharmaceutical Manufacturing", "Philanthropic Fundraising Services", "Photography",
  "Physical, Occupational and Speech Therapists", "Physicians", "Pipeline Transportation",
  "Plastics and Rubber Product Manufacturing", "Plastics Manufacturing", "Political Organizations", "Postal Services",
  "Primary and Secondary Education", "Printing Services", "Professional Organizations", "Professional Services",
  "Professional Training and Coaching", "Public Assistance Programs", "Public Health", "Public Policy Offices",
  "Public Relations and Communications Services", "Public Safety", "Racetracks", "Radio and Television Broadcasting",
  "Rail Transportation", "Railroad Equipment Manufacturing", "Ranching", "Ranching and Fisheries", "Real Estate",
  "Real Estate Agents and Brokers", "Real Estate and Equipment Services", "Recreational Facilities", "Regenerative Design",
  "Religious Institutions", "Renewable Energy Equipment Manufacturing", "Renewable Energy Power Generation",
  "Research Services", "Residential Building Construction", "Retail", "Retail Apparel and Fashion",
  "Retail Appliances, Electrical and Electronic Equipment", "Retail Art Dealers", "Retail Art Supplies",
  "Retail Books and Printed News", "Retail Building Materials and Garden Equipment", "Retail Florists",
  "Retail Furniture and Home Furnishings", "Retail Gasoline", "Retail Groceries", "Retail Health and Personal Care Products",
  "Retail Luxury Goods and Jewelry", "Retail Motor Vehicles", "Retail Musical Instruments", "Retail Office Equipment",
  "Retail Office Supplies and Gifts", "Retail Pharmacies", "Retail Recyclable Materials and Used Merchandise",
  "Reupholstery and Furniture Repair", "Robot Manufacturing", "Robotics Engineering", "Satellite Telecommunications",
  "Savings Institutions", "School and Employee Bus Services", "Secretarial Schools", "Securities and Commodity Exchanges",
  "Security and Investigations", "Security Guards and Patrol Services", "Security System Services", "Semiconductor Manufacturing",
  "Services for Renewable Energy", "Services for the Elderly and Disabled", "Sheet Music Publishing", "Shipbuilding",
  "Shuttles and Special Needs Transportation Services", "Sightseeing Transportation", "Skiing Facilities",
  "Smart Meter Manufacturing", "Soap and Cleaning Product Manufacturing", "Social Networking Platforms",
  "Software Development", "Solar Electric Power Generation", "Sound Recording", "Space Research and Technology",
  "Specialty Trade Contractors", "Spectator Sports", "Sporting Goods Manufacturing", "Sports and Recreation Instruction",
  "Sports Goods Manufacturing", "Sports Teams and Clubs", "Spring and Wire Product Manufacturing", "Staffing and Recruiting",
  "Steam and Air-Conditioning Supply", "Strategic Management Services", "Subdivision of Land",
  "Sugar and Confectionary Product Manufacturing", "Surveying and Mapping Services", "Taxi and Limousine Services",
  "Technical and Vocational Training", "Technology, Information and Internet", "Technology, Information and Media",
  "Telecommunications", "Telecommunications Carriers", "Telephone Call Centers", "Temporary Help Services",
  "Textile Manufacturing", "Theater Companies", "Think Tanks", "Tobacco Manufacturing", "Translation and Localization",
  "Transportation Equipment Manufacturing", "Transportation, Logistics, Supply Chain and Storage", "Travel Arrangements",
  "Truck Transportation", "Trusts and Estates", "Turned Products and Fastener Manufacturing", "Urban Transit Services",
  "Utilities", "Utilities Administration", "Utilities System Construction", "Vehicle Repair and Maintenance",
  "Venture Capital and Private Equity Principals", "Veterinary Services", "Vocational Rehabilitation Services",
  "Warehousing and Storage", "Waste Collection", "Waste Treatment and Disposal", "Water Supply and Irrigation Systems",
  "Water, Waste, Steam and Air Conditioning Services", "Wellness and Fitness Services", "Wholesale Alcoholic Beverages",
  "Wholesale Apparel and Sewing Supplies", "Wholesale Appliances, Electrical and Electronics", "Wholesale Building Materials",
  "Wholesale Chemical and Allied Products", "Wholesale Computer Equipment", "Wholesale Drugs and Sundries",
  "Wholesale Food and Beverage", "Wholesale Footwear", "Wholesale Furniture and Home Furnishings",
  "Wholesale Hardware, Plumbing and Heating Equipment", "Wholesale Import and Export", "Wholesale Luxury Goods and Jewelry",
  "Wholesale Machinery", "Wholesale Metals and Minerals", "Wholesale Motor Vehicles and Parts", "Wholesale Paper Products",
  "Wholesale Petroleum and Petroleum Products", "Wholesale Photography Equipment and Supplies", "Wholesale Raw Farm Products",
  "Wholesale Recyclable Materials", "Wind Electric Power Generation", "Wineries", "Wireless Services",
  "Women's Handbag Manufacturing", "Wood Product Manufacturing", "Writing and Editing", "Zoos and Botanical Gardens",
];

// segment/industry added 2026-08-06 (per Mo — "shouldn't we add company size segments (SMB, MM,
// Enterprise) and industries") as real taxonomy dimensions, not just targeting inputs: they're
// categorical and low-cardinality enough to be worth scanning in a name, AND the Targeting step's
// profiles below pull their companySizes/industries option lists from these SAME dimension value
// lists — one source of truth so a segment code in a campaign name and the same segment in an
// actual LinkedIn targeting spec can never quietly drift apart. Segment values are now the short
// codes (SMB/MM/ENT) rather than full words (2026-08-06, per Mo — "this is basically a consensus
// among marketers") since they're meant to appear directly in campaign/ad-set names, not just as a
// UI label. Industry is pre-seeded with the full LinkedIn taxonomy above so every new plan starts
// with the real option set instead of an empty list the user has to retype from scratch.
export const DEFAULT_TAXONOMY_DIMENSIONS = [
  { key: "product", label: "Product", values: [] },
  // businessType added 2026-08-06 (per Mo — "we need to include NB for new business and/or EB for
  // existing business... part of the flow and part of the taxonomy"): kept separate from buytype
  // below on purpose — NB/EB is a GTM-motion split (whose logo is being pursued), buytype is a
  // funnel-tactic split (how they're being pursued); a real campaign can be any combination of the
  // two (e.g. NB + Prospecting, or EB + Retargeting for an expansion/renewal push), so collapsing
  // them into one dimension would lose information a client will actually want to filter/report on.
  { key: "businessType", label: "New / Existing Business", values: ["NB", "EB"] },
  { key: "region", label: "Region", values: [] },
  { key: "segment", label: "Company Size Segment", values: ["SMB", "MM", "ENT"] },
  { key: "industry", label: "Industry", values: LINKEDIN_INDUSTRIES },
  { key: "funnel", label: "Funnel Stage", values: ["TOFU", "MOFU", "BOFU"] },
  { key: "audience", label: "Audience", values: [] },
  { key: "buytype", label: "Buy Type", values: ["Prospecting", "Retargeting", "ABM"] },
];

// Channel code prefix (2026-08-06, per Mo — "always include the channel name at both levels...
// LIN- or LI-... FB-... BIN-... GOO-"): confirmed via AskUserQuestion to match the SEA-/GDN- split
// (not one shared GOO-) since that's what derivePlatform() in core.js already parses when
// auto-detecting platform from an existing campaign name — using the same codes here means a
// campaign renamed to this taxonomy stays auto-detectable by every audit/reporting feature that
// already reads that prefix convention, instead of introducing a second, incompatible one. Mo's
// own note that "it's going to differ per client" is real — this is a sensible default for now,
// not a hard rule; if a future client needs different codes, this is the one place to add a
// per-workspace override.
export const PLATFORM_CODES = {
  LinkedIn: "LIN",
  Meta: "FB",
  Bing: "BIN",
  "Google Search": "SEA",
  "Google Display": "GDN",
  "Demand Gen": "DEM",
  "Performance Max": "PMX",
  YouTube: "YT",
  Capterra: "CAP",
};
export function channelCode(platform) {
  if (!platform) return "";
  return PLATFORM_CODES[platform] || platform.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 3).toUpperCase();
}

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

// Templates updated 2026-08-06 (per Mo's naming-convention rules, confirmed via AskUserQuestion):
// {platform} leads EVERY level (campaign, adgroup/ad set, and ad) as the channel code — not just
// campaign, per Mo's explicit "always include the channel name at both levels" — and {businessType}
// (NB/EB) sits right after {product}, matching the order Mo described (channel, then product, then
// the rest). {platform} resolves to the abbreviated channelCode() (LIN/FB/BIN/SEA/GDN/...), not the
// full platform name — see channelCode()'s own doc comment above and its call sites in
// AccountPlanning.jsx (MappingStep's rowValues, TaxonomyStep's example preview).
const defaultTemplateForLevel = {
  campaign: "{platform}_{product}_{businessType}_{region}_{segment}_{funnel}",
  adgroup: "{platform}_{businessType}_{audience}_{funnel}",
  ad: "{platform}_{product}_{funnel}_{format}",
};
export function buildDefaultNameTemplates() {
  return { ...defaultTemplateForLevel };
}

// Fills a "{token}_{token}" template from a values map, dropping any token with no value instead of
// leaving a literal "{key}" or a blank segment behind, and collapsing the separator so a dropped
// token doesn't leave a double-underscore. Separator is auto-detected from the template (whatever
// non-alnum/non-brace character sits between the first two tokens) so a taxonomy that prefers "-"
// over "_" works unchanged.
//
// Sanitization added 2026-08-06 (per Mo — "not to use spaces or special characters for campaign, ad
// group/ad set or even ad names. Choose either an underscore or a hyphen in between content"): every
// filled value has non-alphanumeric characters stripped before being joined, so the ONLY underscore
// or hyphen that can ever appear in a generated name is the one separator between segments — a
// dimension value like "Mid-Market" or "North America" (typed with a space) can never leak its own
// internal punctuation/whitespace into the name (becomes "MidMarket", "NorthAmerica"). This runs
// even on the {platform} token, though channelCode()'s output is already alphanumeric-only.
export function generateName(template, values = {}) {
  if (!template) return "";
  const sepMatch = template.match(/}([^{a-zA-Z0-9])\{/);
  const sep = sepMatch ? sepMatch[1] : "_";
  const parts = template.split(/\{([a-zA-Z0-9_]+)\}/g);
  // split() with a capturing group alternates [literal, token, literal, token, ...literal]
  const filled = [];
  for (let i = 1; i < parts.length; i += 2) {
    const token = parts[i];
    const raw = (values[token] || "").toString().trim();
    const v = raw.replace(/[^a-zA-Z0-9]+/g, "");
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
// ─── BUDGET ROLLUP ──────────────────────────────────────────────────────────────────────────────

// Sums Mapping rows' per-ad-set budgets grouped by whatever groupFn returns (a taxonomy dimension
// value, platform, etc.) — deliberately the ONLY place budget gets entered (per ad set, on the
// Mapping row); every other level (product/segment/channel/region) is just this grouped sum rather
// than its own separately-typed number, per Mo — "budget... per segment, per ad set" shouldn't mean
// four numbers that can silently stop adding up to each other.
export function computeBudgetRollup(mappingRows, groupFn) {
  const map = new Map();
  for (const row of mappingRows || []) {
    const amt = Number(row.budget) || 0;
    if (!amt) continue;
    const key = groupFn(row) || "Unassigned";
    map.set(key, (map.get(key) || 0) + amt);
  }
  return [...map.entries()].map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
}

// ─── FLIGHTING ──────────────────────────────────────────────────────────────────────────────────
// (2026-08-06, per Mo — after flagging that the Mapping budget field is monthly but LinkedIn
// Campaign Manager itself runs on daily or lifetime/total budgets: "we should add a toggle for
// evergreen or campaign with a specific flight date.") A Mapping row's `budget` stays the single
// entered number (monthly, per the existing "$/mo" convention, unchanged) — flighting only adds
// `flightType` ("evergreen" | "flighted") and, when flighted, `startDate`/`endDate` (yyyy-mm-dd
// strings, native <input type="date"> format).
//
// The number an ad platform actually wants at setup time is always COMPUTED from budget + flight
// type, never separately typed (same "one number, everything else derived" reasoning as
// computeBudgetRollup above): an EVERGREEN row (no end date — runs continuously) maps to a DAILY
// budget, since that's the only field LinkedIn's own "Run continuously" campaigns take. A FLIGHTED
// row (has a start/end date) maps to a TOTAL/lifetime budget for that window, since that's the field
// LinkedIn's "Set a start and end date" campaigns take and the platform paces spend across it
// automatically — a planner doesn't hand-compute a daily rate for a bounded flight, they hand a
// total. Both are derived from the SAME implied daily rate (monthly / ~30.44 average days/month) so
// the two numbers can never quietly disagree with each other.
const AVG_DAYS_PER_MONTH = 30.44;

export function computeFlightDays(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  return Math.round((end - start) / 86400000) + 1; // inclusive of both the start and end day
}

// Daily rate implied by a monthly budget — what an evergreen campaign's "Daily budget" field wants.
export function computeDailyBudget(monthlyBudget) {
  const amt = Number(monthlyBudget) || 0;
  return amt > 0 ? amt / AVG_DAYS_PER_MONTH : null;
}

// Total spend across a specific flight window, at that same implied daily rate — what a flighted
// campaign's "Total budget" field wants.
export function computeFlightTotalBudget(monthlyBudget, startDate, endDate) {
  const daily = computeDailyBudget(monthlyBudget);
  const days = computeFlightDays(startDate, endDate);
  if (!daily || !days) return null;
  return daily * days;
}

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
