import { useEffect, useMemo, useRef, useState } from "react";
import { listReportingFacts } from "../lib/reportingApi.js";
import { getReachMetrics } from "../lib/coreApi.js";
import { buildAuditGroups, scoreAuditGroups, humanizeObjective } from "../lib/accountPlanning.js";
import { fmtFull, campaignKey, adKey, splitFilterTerms, matchesTerms, localISODate } from "../lib/core.js";
import { DonutChart } from "@tremor/react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.jsx";
import { Badge } from "./ui/badge.jsx";
import { Input } from "./ui/input.jsx";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select.jsx";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table.jsx";
import { cn } from "../lib/utils.js";

// src/components/CampaignAudit.jsx — Campaign Audit (2026-08-07, per Mo — "the audit section, let's
// get rid of that altogether [from Account Planning]... I don't see the need to run an audit every
// time someone wants to restructure an account or create a set of campaigns. We can move the audit
// to another section of PaidHQ but it shouldn't live under campaign planning.").
//
// This is the SAME keep/consolidate/kill campaign-performance tiering that used to be Account
// Planning's Audit step — buildAuditGroups/scoreAuditGroups (accountPlanning.js) are completely
// unchanged, only the UI moved. What's different, per Mo's follow-up answer ("fully standalone... no
// auditDecisions, no Add-to-Mapping button... you'd reference it while building Mapping manually"):
// this view is now plan-agnostic and read-only. It no longer writes auditDecisions (the old manual
// keep/consolidate/kill override) and has no "+ Mapping" action — those both required a specific
// Account Plan to attach to, which is exactly the coupling Mo wants gone. If a real need for a
// standing per-campaign decision record (independent of any plan) comes up later, that's new scope,
// not a restoration of the old plan-scoped behavior.
//
// Distinct from DataAudit.jsx ("Data Audit" tab) despite the similar name — that tab answers "is my
// DATA complete" (coverage/gaps/overlaps across imports); this one answers "what's actually WORKING"
// (spend-weighted performance tiering). Two different questions, two different tabs — see core.js's
// NAV array doc comment for the placement reasoning.

const TIER_META = {
  keep: { badge: "success", label: "Keep" },
  review: { badge: "warning", label: "Review" },
  consolidate: { badge: "destructive", label: "Consolidate/Kill" },
  "insufficient-data": { badge: "secondary", label: "Insufficient data" },
};
const SIGNAL_LABELS = {
  pipeline: "Pipeline/funnel",
  "platform-conversions": "Platform conversions",
  "platform-engagement": "Platform (CPC)",
  "insufficient-volume": "Not enough spend",
};
const DONUT_COLORS = ["emerald", "amber", "rose", "slate"];
const TIER_DOT = { keep: "bg-success", review: "bg-warning", consolidate: "bg-destructive", "insufficient-data": "bg-muted-foreground" };

// Date-range presets (2026-08-07, per Mo — "a time frame filter so I can choose custom dates and
// also the typical last 7 days, last 30 days, last 90 days, last month, this month"). Mirrors the
// "recommended presets relative to today, custom falls back to fixed inputs" shape PaidHQ.jsx's own
// SYNC_RANGE_PRESETS uses for the sync date picker.
const AUDIT_DATE_PRESETS = [
  { key: "all", label: "All time" },
  { key: "last7", label: "Last 7 days" },
  { key: "last30", label: "Last 30 days" },
  { key: "last90", label: "Last 90 days" },
  { key: "thisMonth", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "custom", label: "Custom" },
];
function computeAuditDateRange(preset, customStart, customEnd) {
  const now = new Date();
  if (preset === "all") return { dateFrom: null, dateTo: null };
  if (preset === "custom") return { dateFrom: customStart || null, dateTo: customEnd || null };
  if (preset === "thisMonth") return { dateFrom: localISODate(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: localISODate(now) };
  if (preset === "lastMonth") {
    return {
      dateFrom: localISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      dateTo: localISODate(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  const days = { last7: 7, last30: 30, last90: 90 }[preset] || 30;
  const s = new Date(now);
  s.setDate(s.getDate() - (days - 1));
  return { dateFrom: localISODate(s), dateTo: localISODate(now) };
}

// Effective tags for an Audit group, mirroring AdTagger.jsx's own effectiveTagsFor: an ad-level
// group's tags are its explicit adTags entry layered over its parent campaign's tags entry.
function effectiveAuditTags(g, tags, adTags) {
  const campTags = tags[campaignKey(g.campaignGroupName, g.campaignName)] || {};
  if (g.level !== "ad") return campTags;
  const key = adKey(g.campaignGroupName, g.campaignName, g.adLabel || "");
  return { ...campTags, ...(adTags[key] || {}) };
}

// LinkedIn's own hard cap on the reach query — see paidhq-core's connectors/linkedin.js
// getReachMetrics doc comment. Applied to both platforms for one predictable rule rather than reach
// working for Meta but not LinkedIn on the same wide date selection.
const REACH_MAX_DAYS = 92;

// Looks up a group's live-fetched reach/frequency by platform + adId. Only ad-level LinkedIn/Meta
// groups can ever have reach data (search platforms and campaign-level rows never will) — everything
// else quietly returns null, which the table renders as "—".
function reachForGroup(g, reachData) {
  if (!reachData || g.level !== "ad" || !g.adId) return null;
  const platformKey = g.platform === "LinkedIn" ? "linkedin" : g.platform === "Meta" ? "meta" : null;
  if (!platformKey) return null;
  const data = reachData[platformKey];
  return data ? data[g.adId] || null : null;
}

export default function CampaignAudit({ session, workspace, mergedNormRows, combineGoogleChannels, tags = {}, tagDims = [], adTags = {} }) {
  const [reportingFacts, setReportingFacts] = useState(null);
  const [minSpend, setMinSpend] = useState(100);
  const [tierFilter, setTierFilter] = useState("all");
  const [fTag, setFTag] = useState("");
  const [datePreset, setDatePreset] = useState("last30");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  useEffect(() => {
    if (!workspace?.id || !session) return;
    listReportingFacts(session, workspace.id).then(setReportingFacts).catch(() => setReportingFacts([]));
  }, [session, workspace?.id]);

  const { dateFrom, dateTo } = useMemo(() => computeAuditDateRange(datePreset, customStart, customEnd), [datePreset, customStart, customEnd]);

  const [reachData, setReachData] = useState(null);
  const reachRequestRef = useRef(0);
  const reachWindowDays = dateFrom && dateTo ? Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400000) + 1 : null;
  const reachWindowTooWide = reachWindowDays == null || reachWindowDays > REACH_MAX_DAYS;
  const reachLoading = !reachWindowTooWide && reachData === null;
  useEffect(() => {
    if (!workspace?.id || !session || reachWindowTooWide) return;
    const requestId = ++reachRequestRef.current;
    getReachMetrics(session, workspace.id, { startDate: dateFrom, endDate: dateTo })
      .then((data) => { if (reachRequestRef.current === requestId) setReachData(data); })
      .catch((e) => { if (reachRequestRef.current === requestId) setReachData({ errors: { _general: e.message } }); });
  }, [session, workspace?.id, dateFrom, dateTo, reachWindowTooWide]);

  const groups = useMemo(() => {
    if (reportingFacts === null) return [];
    const built = buildAuditGroups({ mergedNormRows: mergedNormRows || [], reportingFacts, combineGoogleChannels, dateFrom, dateTo });
    return scoreAuditGroups(built, { minSpend: Number(minSpend) || 0 });
  }, [mergedNormRows, reportingFacts, combineGoogleChannels, minSpend, dateFrom, dateTo]);

  const counts = useMemo(() => {
    const c = { keep: 0, review: 0, consolidate: 0, "insufficient-data": 0, totalSpend: 0 };
    groups.forEach((g) => { c[g.tier] = (c[g.tier] || 0) + 1; c.totalSpend += g.spend; });
    return c;
  }, [groups]);

  const donutData = useMemo(() => (
    ["keep", "review", "consolidate", "insufficient-data"]
      .map((t) => ({ name: TIER_META[t].label, value: counts[t] || 0 }))
      .filter((d) => d.value > 0)
  ), [counts]);

  const groupsWithReach = useMemo(
    () => groups.map((g) => ({ ...g, reachMetrics: reachWindowTooWide ? null : reachForGroup(g, reachData) })),
    [groups, reachData, reachWindowTooWide]
  );

  const tierFiltered = tierFilter === "all" ? groupsWithReach : groupsWithReach.filter((g) => g.tier === tierFilter);
  const tagTerms = splitFilterTerms(fTag);
  const visible = tagTerms.length === 0 ? tierFiltered : tierFiltered.filter((g) => {
    const eff = effectiveAuditTags(g, tags, adTags);
    const s = Object.entries(eff).map(([d, v]) => `${d}:${v}`).join(" ").toLowerCase();
    return matchesTerms(s, tagTerms, "or");
  });

  if (reportingFacts === null) return <div className="p-6 text-sm text-muted-foreground">Loading account data…</div>;

  return (
    <div className="flex flex-col gap-5 p-6">
      <div>
        <h1 className="font-display text-xl font-bold text-foreground">Campaign Audit</h1>
        <p className="mt-1 text-sm text-muted-foreground">What's actually working right now, scored live from your connected accounts — keep, review, or consolidate/kill. Reference this while building an Account Plan's Mapping step by hand.</p>
      </div>

      {groups.length === 0 ? (
        <div className="text-sm text-muted-foreground">No spend data to audit yet — bring in data via Data Sources first.</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle>Scope</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <div className="text-xs font-medium text-muted-foreground">In scope</div>
                    <div className="font-display text-xl font-bold text-primary">{fmtFull(counts.totalSpend)}</div>
                  </div>
                  {["keep", "review", "consolidate", "insufficient-data"].map((t) => (
                    <div key={t} className="rounded-lg border border-border bg-secondary/40 p-3">
                      <div className="mb-1 flex items-center gap-1.5">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TIER_DOT[t])} />
                        <span className="truncate text-xs font-medium text-muted-foreground">{TIER_META[t].label}</span>
                      </div>
                      <div className="font-display text-xl font-bold text-foreground">{counts[t] || 0}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle>Tier distribution</CardTitle></CardHeader>
              <CardContent>
                {donutData.length > 0 ? (
                  <DonutChart data={donutData} category="value" index="name" colors={DONUT_COLORS} className="h-32" showAnimation={false} showLabel />
                ) : (
                  <div className="text-xs text-muted-foreground">No scored groups yet</div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Min spend to score</span>
              <Input type="number" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} className="h-8 w-24 text-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Filter by tag/dimension{tagDims.length > 0 && <> — {tagDims.slice(0, 4).join(", ")}</>}
              </span>
              <Input value={fTag} onChange={(e) => setFTag(e.target.value)}
                placeholder={`e.g. ${(tagDims[0] || "product").toLowerCase()}:value, comma-separated`}
                className="h-8 w-64 text-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Time frame</span>
              <div className="flex items-center gap-1.5">
                <Select value={datePreset} onValueChange={setDatePreset}>
                  <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AUDIT_DATE_PRESETS.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {datePreset === "custom" && (
                  <>
                    <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="h-8 w-[136px] text-xs" />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="h-8 w-[136px] text-xs" />
                  </>
                )}
              </div>
              {reachWindowTooWide && (
                <div className="text-[11px] text-muted-foreground/80">Reach/Frequency need a range of {REACH_MAX_DAYS} days or less to show.</div>
              )}
              {!reachWindowTooWide && reachLoading && (
                <div className="text-[11px] text-muted-foreground/80">Loading reach/frequency…</div>
              )}
              {!reachWindowTooWide && !reachLoading && reachData?.errors && Object.keys(reachData.errors).length > 0 && (
                <div className="text-[11px] text-warning">
                  {Object.entries(reachData.errors).map(([k, v]) => `${k === "_general" ? "Reach" : k}: ${v}`).join(" · ")}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5 pb-1.5">
              {["all", "keep", "review", "consolidate", "insufficient-data"].map((t) => (
                <Badge key={t} variant={t === "all" ? "outline" : tierFilter === t ? TIER_META[t].badge : "outline"}
                  className={cn("cursor-pointer select-none", tierFilter !== t && "opacity-60")} onClick={() => setTierFilter(t)}>
                  {t === "all" ? "All" : TIER_META[t].label} {t !== "all" && `(${counts[t] || 0})`}
                </Badge>
              ))}
            </div>
          </div>

          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Campaign Group</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Ad</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Spend</TableHead>
                  <TableHead>Impressions</TableHead>
                  <TableHead>Clicks</TableHead>
                  <TableHead>Reach</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Objective</TableHead>
                  <TableHead>Ad Format</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead>Cost/unit</TableHead>
                  <TableHead>Tier</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.slice(0, 250).map((g, i) => (
                  <TableRow key={g.key}>
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="max-w-[180px]"><div className="truncate text-sm text-foreground">{g.campaignGroupName}</div></TableCell>
                    <TableCell className="max-w-[200px]"><div className="truncate text-sm font-medium text-foreground">{g.campaignName}</div></TableCell>
                    <TableCell className="max-w-[180px]"><div className="truncate text-sm text-foreground">{g.level === "ad" ? (g.adLabel || "—") : "—"}</div></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{g.platform}</TableCell>
                    <TableCell className="text-sm">{fmtFull(g.spend)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(g.impressions || 0).toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(g.clicks || 0).toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{g.reachMetrics?.reach != null ? g.reachMetrics.reach.toLocaleString() : "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{g.reachMetrics?.frequency != null ? g.reachMetrics.frequency.toFixed(2) : "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{humanizeObjective(g.objective) || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{humanizeObjective(g.adFormat) || "—"}</TableCell>
                    <TableCell>
                      <div className="text-xs text-muted-foreground">{SIGNAL_LABELS[g.signalType]}</div>
                      {g.primaryMetricKey && <div className="text-[11px] text-muted-foreground/70">{g.primaryMetricKey}</div>}
                    </TableCell>
                    <TableCell className="text-sm">{g.costPerUnit != null ? `$${g.costPerUnit.toFixed(2)}` : "—"}</TableCell>
                    <TableCell><Badge variant={TIER_META[g.tier].badge}>{TIER_META[g.tier].label}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          {visible.length > 250 && <div className="text-xs text-muted-foreground">Showing first 250 of {visible.length} — narrow the filter above to see more.</div>}
        </>
      )}
    </div>
  );
}
