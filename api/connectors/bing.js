/**
 * Microsoft Advertising (Bing Ads) connector
 * Status: CSV fallback — native API coming soon
 *
 * When ready to implement natively:
 *   Env vars: BING_DEVELOPER_TOKEN, BING_CLIENT_ID, BING_CLIENT_SECRET,
 *             BING_REFRESH_TOKEN, BING_ACCOUNT_ID, BING_CUSTOMER_ID
 *   API: Bing Ads API v13 Reporting service
 *   Docs: https://learn.microsoft.com/en-us/advertising/reporting-service
 */

export async function getSpend({ startDate, endDate }) {
  throw new Error(
    "Microsoft Advertising native integration not yet available. " +
    "Upload a Bing Ads CSV export from the Tagger instead."
  );
}

export const meta = {
  platform: "Bing",
  label: "Microsoft Ads",
  icon: "B",
  status: "csv",
  csvInstructions:
    "Download from Microsoft Advertising → Reports → Campaign performance report. " +
    "Aggregate by: Monthly. Include: Campaign name, Spend, Impressions, Clicks.",
  requiredEnvVars: [
    "BING_DEVELOPER_TOKEN",
    "BING_CLIENT_ID",
    "BING_CLIENT_SECRET",
    "BING_REFRESH_TOKEN",
    "BING_ACCOUNT_ID",
    "BING_CUSTOMER_ID",
  ],
};
