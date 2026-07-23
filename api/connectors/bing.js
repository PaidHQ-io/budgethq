/**
 * Microsoft Advertising (Bing Ads) connector — Reporting service (SOAP)
 *
 * PER-WORKSPACE AUTH (2026-07-22): a workspace connects its OWN Microsoft Advertising account via
 * a full OAuth2 flow (api/oauth/bing/{start,callback,accounts}.js) — see lib/bingOAuth.js's doc
 * comment for the two prerequisites this needs (a Developer Token, an Entra ID app registration),
 * both confirmed NOT set up yet as of this writing. No env-var fallback exists for Bing (unlike
 * Capterra/LinkedIn) — there was never a working shared-credential integration to preserve, this
 * connector previously only supported CSV upload.
 *
 * IMPLEMENTATION CONFIDENCE NOTE — read before debugging a sync failure here: Microsoft is
 * mid-migration from this SOAP API to a newer REST one (SOAP feature-frozen Oct 1 2026, fully
 * decommissioned Jan 31 2027). This connector deliberately still targets SOAP because Microsoft's
 * own reference docs for the REST Reporting endpoints (unlike Customer Management's, which DO have
 * a published REST reference — see lib/bingOAuth.js's resolveAccounts) don't yet publish a
 * complete field-by-field REST request/response schema to build against with confidence. The
 * OAuth flow, the general submit/poll/download/CSV-parse shape, and the header names below are all
 * taken directly from Microsoft's own docs. The one piece that has NOT been tested against a live
 * account (Mo doesn't have a Developer Token yet) is the exact element ORDER inside
 * <CampaignPerformanceReportRequest> in buildSubmitReportXml below — WCF/SOAP services are strict
 * about this matching their WSDL sequence. If a real sync fails with a deserialization-style SOAP
 * fault, this is the first place to check — everything needed to fix it is isolated in that one
 * function. Before Jan 2027 this whole connector should be migrated to the REST reporting API once
 * Microsoft's reference for it is complete.
 */

const REPORTING_SVC_URL = "https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc";
const REPORTING_NS = "https://bingads.microsoft.com/Reporting/v13";
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 24; // ~2 minutes — Bing report generation is normally fast for a single account

function soapHeader({ action, accessToken, developerToken, customerId, accountId }) {
  return `
  <s:Header xmlns="${REPORTING_NS}">
    <Action mustUnderstand="1">${action}</Action>
    <AuthenticationToken i:nil="false">${accessToken}</AuthenticationToken>
    <CustomerAccountId i:nil="false">${accountId}</CustomerAccountId>
    <CustomerId i:nil="false">${customerId}</CustomerId>
    <DeveloperToken i:nil="false">${developerToken}</DeveloperToken>
  </s:Header>`;
}

// See the IMPLEMENTATION CONFIDENCE NOTE above — this is the part most likely to need a live fix.
function buildSubmitReportXml({ accessToken, developerToken, customerId, accountId, startDate, endDate }) {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  ${soapHeader({ action: "SubmitGenerateReport", accessToken, developerToken, customerId, accountId })}
  <s:Body>
    <SubmitGenerateReportRequest xmlns="${REPORTING_NS}">
      <ReportRequest i:type="CampaignPerformanceReportRequest">
        <ExcludeColumnHeaders>false</ExcludeColumnHeaders>
        <ExcludeReportFooter>true</ExcludeReportFooter>
        <ExcludeReportHeader>true</ExcludeReportHeader>
        <Format>Csv</Format>
        <FormatVersion>2.0</FormatVersion>
        <ReportName>BudgetHQ Campaign Performance</ReportName>
        <ReturnOnlyCompleteData>false</ReturnOnlyCompleteData>
        <Aggregation>Daily</Aggregation>
        <Columns xmlns:a="https://bingads.microsoft.com/Reporting/v13">
          <a:CampaignPerformanceReportColumn>AccountId</a:CampaignPerformanceReportColumn>
          <a:CampaignPerformanceReportColumn>AccountName</a:CampaignPerformanceReportColumn>
          <a:CampaignPerformanceReportColumn>CampaignId</a:CampaignPerformanceReportColumn>
          <a:CampaignPerformanceReportColumn>CampaignName</a:CampaignPerformanceReportColumn>
          <a:CampaignPerformanceReportColumn>TimePeriod</a:CampaignPerformanceReportColumn>
          <a:CampaignPerformanceReportColumn>Impressions</a:CampaignPerformanceReportColumn>
          <a:CampaignPerformanceReportColumn>Clicks</a:CampaignPerformanceReportColumn>
          <a:CampaignPerformanceReportColumn>Spend</a:CampaignPerformanceReportColumn>
        </Columns>
        <Scope>
          <AccountIds xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
            <a:long>${accountId}</a:long>
          </AccountIds>
        </Scope>
        <Time>
          <CustomDateRangeStart>
            <Day>${sd}</Day>
            <Month>${sm}</Month>
            <Year>${sy}</Year>
          </CustomDateRangeStart>
          <CustomDateRangeEnd>
            <Day>${ed}</Day>
            <Month>${em}</Month>
            <Year>${ey}</Year>
          </CustomDateRangeEnd>
          <ReportTimeZone>GreenwichMeanTimeDublinEdinburghLisbonLondon</ReportTimeZone>
        </Time>
      </ReportRequest>
    </SubmitGenerateReportRequest>
  </s:Body>
</s:Envelope>`;
}

function buildPollReportXml({ accessToken, developerToken, customerId, accountId, reportRequestId }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  ${soapHeader({ action: "PollGenerateReport", accessToken, developerToken, customerId, accountId })}
  <s:Body>
    <PollGenerateReportRequest xmlns="${REPORTING_NS}">
      <ReportRequestId>${reportRequestId}</ReportRequestId>
    </PollGenerateReportRequest>
  </s:Body>
</s:Envelope>`;
}

async function callReportingService(xml) {
  const res = await fetch(REPORTING_SVC_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: xml,
  });
  const text = await res.text();
  if (!res.ok) {
    // SOAP faults come back as XML even on non-2xx — surface the human-readable Faultstring if
    // present rather than the raw envelope.
    const faultMatch = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
    throw new Error(`Bing Ads Reporting API ${res.status}: ${faultMatch ? faultMatch[1] : text.slice(0, 500)}`);
  }
  return text;
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

async function submitReport(auth) {
  const xml = buildSubmitReportXml(auth);
  const respXml = await callReportingService(xml);
  const reportRequestId = extractTag(respXml, "ReportRequestId");
  if (!reportRequestId) throw new Error("Bing Ads SubmitGenerateReport did not return a ReportRequestId");
  return reportRequestId;
}

async function pollUntilDone(auth, reportRequestId) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const xml = buildPollReportXml({ ...auth, reportRequestId });
    const respXml = await callReportingService(xml);
    const status = extractTag(respXml, "Status");
    if (status === "Success") {
      const url = extractTag(respXml, "ReportDownloadUrl");
      if (!url) throw new Error("Bing Ads report completed but returned no download URL");
      return url;
    }
    if (status === "Error") throw new Error("Bing Ads report generation failed (Status=Error)");
    // else "Pending" — keep polling
  }
  throw new Error("Bing Ads report did not complete in time — try syncing a smaller date range");
}

// Downloads the zipped CSV report and parses it into normalized rows. The report file's own
// header/footer metadata lines are excluded at the request level (ExcludeReportHeader/Footer above)
// so the first real line is the column-name row — see the "Reports" guide's documented CSV shape.
async function downloadAndParseReport(url) {
  const [{ default: JSZip }, { default: Papa }] = await Promise.all([import("jszip"), import("papaparse")]);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download Bing Ads report: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = await JSZip.loadAsync(buf);
  const fileNames = Object.keys(zip.files);
  const csvEntry = fileNames.find((n) => n.toLowerCase().endsWith(".csv")) || fileNames[0];
  if (!csvEntry) throw new Error("Bing Ads report zip contained no files");
  const csvText = await zip.files[csvEntry].async("string");
  const { data } = Papa.parse(csvText, { header: true, skipEmptyLines: true });

  return data
    .map((row) => {
      const spend = parseFloat(row.Spend ?? row.spend ?? 0) || 0;
      // TimePeriod is "yyyy-mm-dd" for Daily aggregation with FormatVersion 2.0 (see the "Reports"
      // guide's Time Period Column section).
      const date = row.TimePeriod || null;
      if (!date || spend <= 0) return null;
      return {
        campaign_group_name: row.AccountName || "Bing Ads",
        campaign_name: row.CampaignName || `Campaign ${row.CampaignId || ""}`.trim(),
        campaign_id: String(row.CampaignId || ""),
        platform: "Bing",
        date,
        spend: Math.round(spend * 100) / 100,
        impressions: parseInt(row.Impressions, 10) || 0,
        clicks: parseInt(row.Clicks, 10) || 0,
      };
    })
    .filter(Boolean);
}

export async function getSpend({ startDate, endDate, credential }) {
  const developerToken = process.env.BING_DEVELOPER_TOKEN;
  if (!developerToken) throw new Error("BING_DEVELOPER_TOKEN is not set — see the Bing setup notes.");
  if (!credential?.accessToken) throw new Error("This workspace hasn't connected Microsoft Advertising yet.");
  if (!credential?.accountId || !credential?.customerId) {
    throw new Error("No Microsoft Advertising account selected yet for this workspace — pick one to finish connecting.");
  }

  const auth = {
    accessToken: credential.accessToken,
    developerToken,
    customerId: credential.customerId,
    accountId: credential.accountId,
  };

  const reportRequestId = await submitReport({ ...auth, startDate, endDate });
  const downloadUrl = await pollUntilDone(auth, reportRequestId);
  return downloadAndParseReport(downloadUrl);
}

export const meta = {
  platform: "Bing",
  label: "Microsoft Ads",
  icon: "B",
  status: "live",
  perWorkspaceAuth: true,
  oauth: true, // no connectFields form — frontend renders a "Connect with Microsoft" button instead
  csvInstructions:
    "Download from Microsoft Advertising → Reports → Campaign performance report. " +
    "Aggregate by: Monthly. Include: Campaign name, Spend, Impressions, Clicks.",
  requiredEnvVars: ["BING_DEVELOPER_TOKEN", "BING_CLIENT_ID", "BING_CLIENT_SECRET", "BING_REDIRECT_URI"],
};
