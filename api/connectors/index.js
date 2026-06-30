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

export const CONNECTORS = {
  linkedin: { getSpend: linkedinSpend, ...linkedinMeta },
  google:   { getSpend: googleSpend,   ...googleMeta   },
  meta:     { getSpend: metaSpend,     ...metaMeta     },
  bing:     { getSpend: bingSpend,     ...bingMeta     },
  capterra: { getSpend: capterraSpend, ...capterraMeta },
};

/**
 * Safe registry for the frontend (no functions, just metadata)
 * Sent as JSON in /api/spend?action=registry
 */
export const CONNECTOR_REGISTRY = Object.fromEntries(
  Object.entries(CONNECTORS).map(([key, { getSpend: _fn, ...rest }]) => [key, rest])
);
