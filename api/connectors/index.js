/**
 * Connector registry
 * 
 * To add a new platform integration:
 *   1. Create /api/connectors/{platform}.js with getSpend() and meta exports
 *   2. Import and register it here
 *   3. Add env vars to Vercel dashboard and .env.example
 *   4. Set meta.status = "live"
 * 
 * The frontend reads CONNECTOR_REGISTRY to know which platforms are live vs CSV.
 * No other changes needed.
 */

import { getSpend as linkedinSpend, meta as linkedinMeta } from "./linkedin.js";
import { getSpend as googleSpend, meta as googleMeta }     from "./google.js";
import { getSpend as metaSpend,   meta as metaMeta }       from "./meta.js";
import { getSpend as bingSpend,   meta as bingMeta }       from "./bing.js";
import { getSpend as capterraSpend, meta as capterraMeta } from "./capterra.js";
import { getSpend as funnelSpend, meta as funnelMeta }     from "./funnel.js";
import { getSpend as supermetricsSpend, meta as supermetricsMeta } from "./supermetrics.js";
import { getSpend as googlesheetsSpend, meta as googlesheetsMeta } from "./googlesheets.js";

export const CONNECTORS = {
  linkedin: { getSpend: linkedinSpend, ...linkedinMeta },
  google:   { getSpend: googleSpend,   ...googleMeta   },
  meta:     { getSpend: metaSpend,     ...metaMeta     },
  bing:     { getSpend: bingSpend,     ...bingMeta     },
  capterra: { getSpend: capterraSpend, ...capterraMeta },
  // Every connector here is `perWorkspaceAuth: true` (see each one's meta export, as of
  // google.js's 2026-07-25 per-workspace OAuth) — /api/spend.js looks up a credential from
  // core.connector_credentials for the calling workspace instead of reading a shared
  // process.env var, and confirms the caller actually belongs to that workspace first. This used
  // to only be true of funnel/supermetrics, hence the naming below, but it's now every connector.
  // googlesheets additionally has no OAuth concept at all (see its own doc comment) — the
  // "credential" is just a public sheet URL, no token to refresh or expire.
  funnel:       { getSpend: funnelSpend,       ...funnelMeta       },
  supermetrics: { getSpend: supermetricsSpend, ...supermetricsMeta },
  googlesheets: { getSpend: googlesheetsSpend, ...googlesheetsMeta },
};

/**
 * Safe registry for the frontend (no functions, just metadata)
 * Sent as JSON in /api/spend?action=registry
 */
export const CONNECTOR_REGISTRY = Object.fromEntries(
  Object.entries(CONNECTORS).map(([key, { getSpend: _fn, ...rest }]) => [key, rest])
);
