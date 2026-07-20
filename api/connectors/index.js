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

export const CONNECTORS = {
  linkedin: { getSpend: linkedinSpend, ...linkedinMeta },
  google:   { getSpend: googleSpend,   ...googleMeta   },
  meta:     { getSpend: metaSpend,     ...metaMeta     },
  bing:     { getSpend: bingSpend,     ...bingMeta     },
  capterra: { getSpend: capterraSpend, ...capterraMeta },
  // funnel/supermetrics differ from every connector above: `perWorkspaceAuth: true` (see their
  // meta exports) means /api/spend.js looks up a credential from budgethq.connector_credentials
  // for the calling workspace instead of reading a shared process.env var — see spend.js.
  funnel:       { getSpend: funnelSpend,       ...funnelMeta       },
  supermetrics: { getSpend: supermetricsSpend, ...supermetricsMeta },
};

/**
 * Safe registry for the frontend (no functions, just metadata)
 * Sent as JSON in /api/spend?action=registry
 */
export const CONNECTOR_REGISTRY = Object.fromEntries(
  Object.entries(CONNECTORS).map(([key, { getSpend: _fn, ...rest }]) => [key, rest])
);
