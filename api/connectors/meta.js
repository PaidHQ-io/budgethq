/**
 * Meta Ads connector
 * Status: CSV fallback — native API coming soon
 *
 * When ready to implement natively:
 *   Env vars: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID
 *   API: Meta Marketing API /insights endpoint
 *   Docs: https://developers.facebook.com/docs/marketing-api/insights
 */

export async function getSpend({ startDate, endDate }) {
  throw new Error(
    "Meta Ads native integration not yet available. " +
    "Upload a Meta Ads CSV export from the Tagger instead."
  );
}

export const meta = {
  platform: "Meta",
  label: "Meta Ads",
  icon: "M",
  status: "csv",
  csvInstructions:
    "Download from Meta Ads Manager → Reports → Export. " +
    "Breakdown by: Campaign, Month. Include: Amount spent, Impressions, Clicks.",
  requiredEnvVars: [
    "META_ACCESS_TOKEN",
    "META_AD_ACCOUNT_ID",
  ],
};
