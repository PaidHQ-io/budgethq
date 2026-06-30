/**
 * Capterra connector
 * Status: CSV fallback — native API coming soon
 *
 * When ready to implement natively:
 *   Env vars: CAPTERRA_API_KEY, CAPTERRA_ACCOUNT_ID
 *   API: Capterra Advertising API (if/when available)
 *   Note: Capterra doesn't have a public reporting API yet.
 *         Integration will likely rely on a direct data export or
 *         a Gartner Digital Markets API if one becomes available.
 */

export async function getSpend({ startDate, endDate }) {
  throw new Error(
    "Capterra native integration not yet available. " +
    "Upload a Capterra CSV export from the Tagger instead."
  );
}

export const meta = {
  platform: "Capterra",
  label: "Capterra",
  icon: "C",
  status: "csv",
  csvInstructions:
    "Download from Capterra dashboard → Reports → Campaign report. " +
    "Include: Campaign, Month, Total spend, Clicks.",
  requiredEnvVars: [
    "CAPTERRA_API_KEY",
    "CAPTERRA_ACCOUNT_ID",
  ],
};
