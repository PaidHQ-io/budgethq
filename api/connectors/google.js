/**
 * Google Ads connector
 * Status: CSV fallback — native API coming soon
 *
 * When ready to implement natively:
 *   Env vars: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID,
 *             GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,
 *             GOOGLE_ADS_CUSTOMER_ID
 *   API: Google Ads API v17+ via reports/search
 *   Docs: https://developers.google.com/google-ads/api/docs/reporting/overview
 */

export async function getSpend({ startDate, endDate }) {
  throw new Error(
    "Google Ads native integration not yet available. " +
    "Upload a Google Ads CSV export from the Tagger instead."
  );
}

export const meta = {
  platform: "Google",
  label: "Google Ads",
  icon: "G",
  status: "csv",           // "live" | "csv" | "coming_soon"
  csvInstructions:
    "Download from Google Ads → Reports → Predefined reports → " +
    "Time → Month. Include: Campaign, Cost, Impressions, Clicks.",
  requiredEnvVars: [
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID",
  ],
};
