import { Component, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  listAccountPlans, getAccountPlan, createAccountPlan, updateAccountPlan, deleteAccountPlan,
} from "../lib/accountPlanningApi.js";
import {
  listTargetingLibraryItems, createTargetingLibraryItem, deleteTargetingLibraryItem,
} from "../lib/targetingLibraryApi.js";
import { listReportingFacts } from "../lib/reportingApi.js";
import { getReachMetrics } from "../lib/coreApi.js";
import {
  buildAuditGroups, scoreAuditGroups, levelLabel, computeBudgetRollup, channelCode, platformFamily,
  DEFAULT_TAXONOMY_DIMENSIONS, buildDefaultNameTemplates, generateName, validateName, templateTokens,
  LINKEDIN_COMPANY_SIZE_RANGES, PLATFORM_CODES, computeFlightDays, computeDailyBudget, computeFlightTotalBudget,
  computeDimensionBudgetComparison, humanizeObjective,
} from "../lib/accountPlanning.js";
import { SearchableSelect } from "./ui/searchable-select.jsx";
import { fmtFull, campaignKey, adKey, splitFilterTerms, matchesTerms, localISODate } from "../lib/core.js";
import { DonutChart, BarList } from "@tremor/react";
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  Plus, Trash2, ChevronLeft, Compass, Search, Tags, Target as TargetIcon, ListChecks, X, Moon, Sun,
  Users, Ban, Repeat, GripVertical, Megaphone, Layers, Image as ImageIcon, LayoutGrid, Table2, ChevronDown,
  Info, DollarSign,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card.jsx";
import { Badge } from "./ui/badge.jsx";
import { Input } from "./ui/input.jsx";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select.jsx";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table.jsx";
import { Separator } from "./ui/separator.jsx";
import { cn } from "../lib/utils.js";

// src/components/AccountPlanning.jsx — Account Planning (2026-08-06, per Mo — "I need a way of
// figuring out how to restructure and rebuild an account that already has existing ads and
// campaigns... looking at what's working and then porting that over to a new structure that
// follows best practices... world class, bespoke, purpose-built for performance." Confirmed via
// AskUserQuestion: audit + taxonomy designer + targeting (job title/function, lists, exclusions,
// remarketing) + old->new mapping, as a named step-by-step project.
//
// UI REBUILD (2026-08-06, per Mo — "let's rebuild with tailwind + shadcn/tremor now," confirmed via
// AskUserQuestion): this is the FIRST tab rebuilt on the new Tailwind/shadcn/Tremor stack, and the
// template the rest of PaidHQ will be migrated to incrementally, tab by tab, per Mo's call. Notable
// departures from every other (not-yet-migrated) tab in this codebase:
//   - No `T` theme prop, no shared.jsx primitives (PixelPanel/Pill/Btn/SectionLabel/Icon) — those
//     belong to the old inline-style/multi-theme system being retired as tabs migrate, per Mo's call
//     to consolidate to one design instead of carrying Classic/Midnight/Aida through the rebuild.
//   - Styling is Tailwind utility classes; components are the new src/components/ui/* shadcn
//     primitives plus @tremor/react for the two genuine data-viz spots (tier distribution donut,
//     budget rollup bar lists) — see tailwind.config.js's own doc comment for the stack decisions
//     (Tailwind v3 not v4, preflight off, fresh palette) and package.json for why @tremor/react
//     needed --legacy-peer-deps (built for React 18, project is on 19; works fine in practice).
//   - The underlying data model and engine (accountPlanning.js, accountPlanningApi.js,
//     targetingLibraryApi.js) are COMPLETELY UNCHANGED — this is a presentation-layer rewrite only.
//
// A "plan" is a resumable project (list view below) that walks six steps:
//   1. Context    — products/regions/personas/segments/ad formats/objectives, free-form tag-list
//                   inputs that seed step 3 and step 4.
//   2. Audit      — "what's working" now, computed LIVE every time (see accountPlanning.js's own
//                   doc comment for why numbers are never frozen), with a persisted decision layer.
//   3. Taxonomy   — target naming convention across Campaign/Ad Group(Set)/Ad, generated live.
//   4. Budget     — the plan's monthly total + per-dimension $/% allocation (2026-08-07, per Mo —
//                   "There should be a net new tab just for setting budgets and allocating budgets
//                   per segment... nor do I think any budget allocation should be set in context...
//                   we should toggle between real dollar amounts and percentages"). Split out of
//                   Context (which previously held a free-form itemized budget list) and Taxonomy
//                   (which previously held the per-dimension allocation cards) into its own step —
//                   lives after Taxonomy because allocating "per segment" needs that dimension's
//                   value list to already exist.
//   5. Targeting  — shared library (lists/exclusions/remarketing) + reusable Targeting Profiles.
//   6. Mapping    — old campaign/ad -> new generated name, the actual execution checklist.
//
// mergedNormRows/combineGoogleChannels come from PaidHQ.jsx's central workspace-data load, same
// props DataAudit.jsx receives — reporting_facts isn't part of that central load, so this component
// fetches it independently, same pattern DataAudit.jsx's own reportingFacts effect uses.

const STEPS = [
  { key: "context", label: "Context", Icon: TargetIcon },
  { key: "audit", label: "Audit", Icon: Search },
  { key: "taxonomy", label: "Taxonomy", Icon: Tags },
  { key: "budget", label: "Budget", Icon: DollarSign },
  { key: "targeting", label: "Targeting", Icon: Compass },
  { key: "mapping", label: "Mapping", Icon: ListChecks },
];

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
const STATUS_META = {
  draft: { badge: "secondary", label: "Draft" },
  in_progress: { badge: "warning", label: "In progress" },
  complete: { badge: "success", label: "Complete" },
};
const DONUT_COLORS = ["emerald", "amber", "rose", "slate"];
const TIER_DOT = { keep: "bg-success", review: "bg-warning", consolidate: "bg-destructive", "insufficient-data": "bg-muted-foreground" };

// ─── SMALL SHARED PIECES ───────────────────────────────────────────────────────────────────────

function SectionLabel({ children, className }) {
  return <h4 className={cn("mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground", className)}>{children}</h4>;
}

function ChipList({ items, onAdd, onRemove, placeholder, canEdit }) {
  const [val, setVal] = useState("");
  const add = () => { const v = val.trim(); if (!v || items.includes(v)) { setVal(""); return; } onAdd(v); setVal(""); };
  return (
    <div>
      <div className={cn("flex flex-wrap gap-1.5", canEdit ? "mb-2" : "")}>
        {items.map((it, i) => (
          <Badge key={i} variant="secondary" className="gap-1 pr-1.5">
            {it}
            {canEdit && <X className="h-3 w-3 cursor-pointer opacity-60 hover:opacity-100" onClick={() => onRemove(i)} />}
          </Badge>
        ))}
        {items.length === 0 && <span className="text-xs text-muted-foreground">None yet</span>}
      </div>
      {canEdit && (
        <div className="flex gap-1.5">
          <Input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            placeholder={placeholder} className="h-8 flex-1 text-xs" />
          <Button size="sm" variant="secondary" className="h-8" onClick={add}>Add</Button>
        </div>
      )}
    </div>
  );
}

function SavedIndicator({ saving, savedAt }) {
  if (saving) return <span className="text-xs text-muted-foreground">Saving…</span>;
  if (savedAt) return <span className="text-xs text-muted-foreground">Saved</span>;
  return null;
}

// Dark mode toggle (2026-08-06, per Mo's "world class" push — "possible dark mode" was part of the
// approved plan). Lives here rather than in shared.jsx on purpose: this is the new Tailwind/shadcn
// design system's own control, not something the old T-theme system (Classic/Midnight/Aida) should
// pick up mid-retirement.
function ThemeToggle({ dark, onToggle }) {
  return (
    <button type="button" onClick={onToggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-0 bg-secondary text-muted-foreground transition-all hover:bg-accent hover:text-accent-foreground active:scale-90">
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

// ─── LIST VIEW ──────────────────────────────────────────────────────────────────────────────────

function PlanList({ plans, loading, canEdit, onOpen, onCreate, onDelete, dark, onToggleDark }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const submit = () => { const n = name.trim(); if (!n) return; onCreate(n); setName(""); setCreating(false); };
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground">Account Planning</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Audit what's working in an existing account, design a purpose-built taxonomy, and map the old structure onto the new one — one project per rebuild, saved and resumable.
          </p>
        </div>
        <ThemeToggle dark={dark} onToggle={onToggleDark} />
      </div>

      {canEdit && (
        <div className="mb-5">
          {!creating ? (
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New plan</Button>
          ) : (
            <Card>
              <CardContent className="flex gap-2 p-3">
                <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setCreating(false); }}
                  placeholder="e.g. Q4 InsightSoftware Rebuild" className="flex-1" />
                <Button onClick={submit}>Create</Button>
                <Button variant="ghost" onClick={() => { setCreating(false); setName(""); }}>Cancel</Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : plans.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <div className="mb-1 text-sm font-semibold text-foreground">No plans yet</div>
            <div className="text-sm text-muted-foreground">Start a new plan to audit an account and design its rebuild.</div>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {plans.map((p, i) => {
            const status = STATUS_META[p.status || "draft"];
            return (
              <Card key={p.id} onClick={() => onOpen(p.id)}
                style={{ animationDelay: `${Math.min(i, 8) * 40}ms`, animationFillMode: "backwards" }}
                className="animate-in fade-in slide-in-from-bottom-1 cursor-pointer duration-300 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg">
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 truncate text-sm font-semibold text-foreground">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Updated {new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · Step: {STEPS.find((s) => s.key === p.activeStep)?.label || "Context"}
                    </div>
                  </div>
                  <Badge variant={status.badge}>{status.label}</Badge>
                  {canEdit && (
                    <button type="button" onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${p.name}"? This can't be undone.`)) onDelete(p.id); }}
                      className="flex border-0 bg-transparent p-1 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── STEP 1: CONTEXT ────────────────────────────────────────────────────────────────────────────

// DEFAULT_SEGMENTS (2026-08-07, per Mo — "we're missing company size segments of SMB, MM and
// Enterprise in this screen"): seeds the new Company Size Segments card below with the same
// three values Taxonomy's fixed "segment" dimension already uses everywhere else in this app (see
// DEFAULT_TAXONOMY_DIMENSIONS in accountPlanning.js), spelled out in full rather than the ENT
// shorthand since this card is a free-text ChipList like Products/Regions/Personas, not the
// enum-constrained taxonomy dimension. Only used as a fallback when a plan hasn't saved its own
// segments list yet — editing/removing a chip persists context.segments like any other field here.
const DEFAULT_SEGMENTS = ["SMB", "MM", "Enterprise"];

// DEFAULT_AD_FORMATS / DEFAULT_AD_SET_OBJECTIVES (2026-08-07, per Mo — "we need to add a segment for
// ad format... and ad set objective... in the context tab"): same seeded-ChipList pattern as
// DEFAULT_SEGMENTS above — free-text tag lists a plan can trim/extend, not enum-constrained taxonomy
// dimensions. Seeded with the exact values Mo listed. Deliberately independent of the real
// LinkedIn/Meta objective and ad_format values the Audit table now surfaces from actual connector
// data (buildAuditGroups' g.objective/g.adFormat, see accountPlanning.js) — those describe what's
// ACTUALLY running on the audited account; these describe what this plan intends to use, which can
// legitimately differ (e.g. planning to add Conversation Ads that don't exist yet in the account).
const DEFAULT_AD_FORMATS = ["Single Image", "Video", "CTV", "In Message", "Text", "Conversation", "Document", "Spotlight"];
const DEFAULT_AD_SET_OBJECTIVES = ["Conversions", "Brand Awareness", "Website Traffic", "Lead Generation", "Engagement"];

// DEFAULT_FUNNEL_STAGES (2026-08-07, per Mo — "let's add the funnel options for TOFU, MOFU, BOFU
// (Remarketing)"): same seeded-ChipList pattern as the cards above. BOFU is labeled "BOFU
// (Remarketing)" rather than a separate 4th chip, matching how Mo phrased the request — this is a
// free-text tag, not the enum-constrained Taxonomy "funnel" dimension (DEFAULT_TAXONOMY_DIMENSIONS'
// funnel values stay the plain TOFU/MOFU/BOFU codes it puts into generated names).
const DEFAULT_FUNNEL_STAGES = ["TOFU", "MOFU", "BOFU (Remarketing)"];

function ContextStep({ context, setContext, canEdit }) {
  const products = context.products || [];
  const regions = context.regions || [];
  const personas = context.personas || [];
  const segments = context.segments && context.segments.length ? context.segments : DEFAULT_SEGMENTS;
  const adFormats = context.adFormats && context.adFormats.length ? context.adFormats : DEFAULT_AD_FORMATS;
  const objectives = context.objectives && context.objectives.length ? context.objectives : DEFAULT_AD_SET_OBJECTIVES;
  const funnelStages = context.funnelStages && context.funnelStages.length ? context.funnelStages : DEFAULT_FUNNEL_STAGES;
  return (
    <div className="flex flex-col gap-4">
      {/* Walkthrough (2026-08-07, per Mo — "I also need an explanation or walk through of what to
          do in this screen for the benefit of the user"): this is the FIRST step of the 6-step
          Account Planning flow (Context -> Audit -> Taxonomy -> Budget -> Targeting -> Mapping), and
          it's all freeform inputs with no validation, so a first-time user has no signal for what
          "done" looks like here or why it matters. Explains each field in the order it appears below
          and how it feeds later steps, so the panel and the grid stay in sync if fields are
          reordered. Budgets USED to live on this screen as a free-form itemized list — moved out
          entirely into their own Budget step (2026-08-07, per Mo — "nor do I think any budget
          allocation should be set in context... There should be a net new tab just for setting
          budgets and allocating budgets per segment") since setting a total and allocating it per
          segment/dimension is a different kind of task than the tag-list scoping fields below, and
          deserved its own dedicated screen rather than competing for space here. */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="flex gap-3 pt-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="text-sm text-muted-foreground">
            <p className="mb-1.5 font-medium text-foreground">What to do on this screen</p>
            <p>
              Set up the scope for this account plan before moving into Audit. <span className="font-medium text-foreground">Products</span>, <span className="font-medium text-foreground">Regions</span>, <span className="font-medium text-foreground">Audiences / Personas</span>, <span className="font-medium text-foreground">Company Size Segments</span>, <span className="font-medium text-foreground">Ad Format</span>, <span className="font-medium text-foreground">Ad Set Objective</span>, and <span className="font-medium text-foreground">Funnel Stage</span> are all simple tag lists — type a value and hit Add or Enter, click the × on a chip to remove it. These describe what this plan covers and carry through as reference context in later steps (Taxonomy, Targeting, Mapping); Ad Format and Ad Set Objective in particular are what you intend to use, which is worth keeping distinct from what's actually running today (that's what the Audit step's own Ad Format/Objective columns show, pulled live from the connected accounts). None of this is required to move on to Audit, but the more filled in here, the more useful the later steps will be. Setting the actual budget — total and per-segment breakdown — happens in its own Budget step, once these fields (and Taxonomy's dimensions) exist to allocate against.
            </p>
          </div>
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle>Products</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={products} canEdit={canEdit} placeholder="Add a product…"
              onAdd={(v) => setContext({ ...context, products: [...products, v] })}
              onRemove={(i) => setContext({ ...context, products: products.filter((_, x) => x !== i) })} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle>Regions</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={regions} canEdit={canEdit} placeholder="Add a region…"
              onAdd={(v) => setContext({ ...context, regions: [...regions, v] })}
              onRemove={(i) => setContext({ ...context, regions: regions.filter((_, x) => x !== i) })} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle>Audiences / Personas</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={personas} canEdit={canEdit} placeholder="Add an audience or persona…"
              onAdd={(v) => setContext({ ...context, personas: [...personas, v] })}
              onRemove={(i) => setContext({ ...context, personas: personas.filter((_, x) => x !== i) })} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle>Company Size Segments</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={segments} canEdit={canEdit} placeholder="Add a segment…"
              onAdd={(v) => setContext({ ...context, segments: [...segments, v] })}
              onRemove={(i) => setContext({ ...context, segments: segments.filter((_, x) => x !== i) })} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle>Ad Format</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={adFormats} canEdit={canEdit} placeholder="Add an ad format…"
              onAdd={(v) => setContext({ ...context, adFormats: [...adFormats, v] })}
              onRemove={(i) => setContext({ ...context, adFormats: adFormats.filter((_, x) => x !== i) })} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle>Ad Set Objective</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={objectives} canEdit={canEdit} placeholder="Add an objective…"
              onAdd={(v) => setContext({ ...context, objectives: [...objectives, v] })}
              onRemove={(i) => setContext({ ...context, objectives: objectives.filter((_, x) => x !== i) })} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle>Funnel Stage</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={funnelStages} canEdit={canEdit} placeholder="Add a funnel stage…"
              onAdd={(v) => setContext({ ...context, funnelStages: [...funnelStages, v] })}
              onRemove={(i) => setContext({ ...context, funnelStages: funnelStages.filter((_, x) => x !== i) })} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── STEP 2: AUDIT ──────────────────────────────────────────────────────────────────────────────

// Date-range presets for the Audit table (2026-08-07, per Mo — "a time frame filter so I can choose
// custom dates and also the typical last 7 days, last 30 days, last 90 days, last month, this
// month"). Mirrors the "recommended presets relative to today, custom falls back to fixed inputs"
// shape PaidHQ.jsx's own SYNC_RANGE_PRESETS uses for the sync date picker, extended with calendar-
// month presets since Mo asked for those specifically here. buildAuditGroups() already accepted
// dateFrom/dateTo params (built for a future need) — this is the first UI to actually pass them.
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
// group's tags are its explicit adTags entry layered over its parent campaign's tags entry (falls
// back cleanly to just the campaign's tags for campaign-level groups, since adKey lookups will
// simply miss). This is what lets "filter by tags/dimensions" here reuse the SAME tag data Campaign
// Tagger/Ad Tagger already produced elsewhere in the app, rather than inventing a second tagging
// system scoped to Account Planning alone.
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

// Looks up a group's live-fetched reach/frequency by platform + adId — see coreApi.js's
// getReachMetrics doc comment for the shape of reachData. Only ad-level LinkedIn/Meta groups can
// ever have reach data (search platforms and campaign-level rows never will) — everything else
// quietly returns null, which the table renders as "—".
function reachForGroup(g, reachData) {
  if (!reachData || g.level !== "ad" || !g.adId) return null;
  const platformKey = g.platform === "LinkedIn" ? "linkedin" : g.platform === "Meta" ? "meta" : null;
  if (!platformKey) return null;
  const data = reachData[platformKey];
  return data ? data[g.adId] || null : null;
}

function AuditStep({ session, workspace, mergedNormRows, combineGoogleChannels, tags = {}, tagDims = [], adTags = {}, auditDecisions, setAuditDecisions, mapping, setMapping, canEdit }) {
  const [reportingFacts, setReportingFacts] = useState(null);
  const [minSpend, setMinSpend] = useState(100);
  const [tierFilter, setTierFilter] = useState("all");
  const [fTag, setFTag] = useState("");
  // Defaults to "last30" (2026-08-07, per Mo — "Let's make the audit tab default to the last 30
  // days"), was "all". Still fully overridable via the Time frame select right below.
  const [datePreset, setDatePreset] = useState("last30");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  useEffect(() => {
    if (!workspace?.id || !session) return;
    listReportingFacts(session, workspace.id).then(setReportingFacts).catch(() => setReportingFacts([]));
  }, [session, workspace?.id]);

  const { dateFrom, dateTo } = useMemo(() => computeAuditDateRange(datePreset, customStart, customEnd), [datePreset, customStart, customEnd]);

  // Reach/frequency (2026-08-07, per Mo — "we need reach and frequency"): a LIVE, on-demand fetch
  // scoped to the exact selected window, NOT part of the regular synced spend data — see
  // coreApi.js's getReachMetrics doc comment for why (reach is deduplicated/non-additive across
  // days, so it can't be summed the way spend/impressions/clicks are). REACH_MAX_DAYS mirrors
  // LinkedIn's own hard cap on this query (92 days) — Meta doesn't share that specific limit, but
  // capping both platforms to the same window keeps the UI's behavior simple and predictable rather
  // than reach silently working for one platform and not the other on the same selection.
  const [reachData, setReachData] = useState(null); // { linkedin, meta, errors } | null — null also reads as "loading" (see below), same convention AdTagger.jsx's own load effect uses for `rows`
  const reachRequestRef = useRef(0); // guards against an older, slower request overwriting a newer one's result — see effect below
  const reachWindowDays = dateFrom && dateTo ? Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400000) + 1 : null;
  const reachWindowTooWide = reachWindowDays == null || reachWindowDays > REACH_MAX_DAYS;
  const reachLoading = !reachWindowTooWide && reachData === null;
  useEffect(() => {
    // No synchronous setState in the effect body itself (react-hooks/set-state-in-effect) — when
    // the window is too wide (or workspace/session isn't ready), this just skips fetching entirely
    // rather than resetting reachData to null here; groupsWithReach below already ignores any stale
    // reachData once reachWindowTooWide flips true, so there's nothing to clean up. setReachData is
    // only ever called inside the promise callbacks below, same "reset only inside a promise
    // callback" posture AdTagger.jsx's own load effect uses. reachRequestRef (a ref, not state) is
    // fine to mutate synchronously here — it just tags this fetch so a slower, superseded request
    // can't clobber a newer one's result if the date range changes again before it resolves.
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

  const addToMapping = (g) => {
    if (mapping.some((m) => m.oldKey === g.key)) return;
    setMapping([...mapping, {
      oldKey: g.key, oldName: g.level === "ad" ? (g.adLabel || g.campaignName) : g.campaignName,
      oldCampaignGroup: g.campaignGroupName, platform: g.platform,
      level: g.level === "ad" ? "ad" : "campaign", action: g.tier === "consolidate" ? "kill" : "rename",
      manualName: "", dimValues: {}, status: "planned", parentKey: "", flightType: "evergreen", startDate: "", endDate: "",
    }]);
  };
  const setDecision = (key, patch) => setAuditDecisions({ ...auditDecisions, [key]: { ...(auditDecisions[key] || {}), ...patch } });

  if (reportingFacts === null) return <div className="text-sm text-muted-foreground">Loading account data…</div>;
  if (groups.length === 0) return <div className="text-sm text-muted-foreground">No spend data to audit yet — bring in data via Data Sources first.</div>;

  return (
    <div className="flex flex-col gap-5">
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
              <TableHead>Decision</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.slice(0, 250).map((g, i) => {
              const dec = auditDecisions[g.key] || {};
              const inMapping = mapping.some((m) => m.oldKey === g.key);
              return (
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
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant={TIER_META[g.tier].badge}>{TIER_META[g.tier].label}</Badge>
                      {canEdit && (
                        <Select value={dec.decision || "__tier__"} onValueChange={(v) => setDecision(g.key, { decision: v === "__tier__" ? "" : v })}>
                          <SelectTrigger className="h-7 w-[112px] text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__tier__">Use tier</SelectItem>
                            <SelectItem value="keep">Keep</SelectItem>
                            <SelectItem value="consolidate">Consolidate</SelectItem>
                            <SelectItem value="kill">Kill</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {canEdit && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={inMapping} onClick={() => addToMapping(g)}>
                        {inMapping ? "In mapping" : "+ Mapping"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      {visible.length > 250 && <div className="text-xs text-muted-foreground">Showing first 250 of {visible.length} — narrow the filter above to see more.</div>}
    </div>
  );
}

// ─── STEP 3: TAXONOMY ───────────────────────────────────────────────────────────────────────────

function TaxonomyStep({ taxonomy, setTaxonomy, context, canEdit }) {
  const dimensions = taxonomy.dimensions && taxonomy.dimensions.length ? taxonomy.dimensions : DEFAULT_TAXONOMY_DIMENSIONS;
  const templates = taxonomy.nameTemplates || buildDefaultNameTemplates();
  const family = taxonomy.family || "search";

  useEffect(() => {
    // One-time seed: if the product/region dimensions are still empty and Context has values, pull
    // them in automatically rather than making the user retype what they already entered in Step 1.
    if (!canEdit) return;
    const prod = dimensions.find((d) => d.key === "product");
    const reg = dimensions.find((d) => d.key === "region");
    const needsProd = prod && prod.values.length === 0 && (context.products || []).length > 0;
    const needsReg = reg && reg.values.length === 0 && (context.regions || []).length > 0;
    if (needsProd || needsReg) {
      const next = dimensions.map((d) => {
        if (needsProd && d.key === "product") return { ...d, values: [...context.products] };
        if (needsReg && d.key === "region") return { ...d, values: [...context.regions] };
        return d;
      });
      setTaxonomy({ ...taxonomy, dimensions: next, nameTemplates: templates, family });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateDim = (key, patch) => setTaxonomy({ ...taxonomy, dimensions: dimensions.map((d) => (d.key === key ? { ...d, ...patch } : d)), nameTemplates: templates, family });
  const addDimValue = (key, v) => { const d = dimensions.find((x) => x.key === key); if (!v || d.values.includes(v)) return; updateDim(key, { values: [...d.values, v] }); };
  const removeDimValue = (key, i) => { const d = dimensions.find((x) => x.key === key); updateDim(key, { values: d.values.filter((_, x) => x !== i) }); };
  const addDimension = () => {
    const key = `custom_${Date.now()}`;
    setTaxonomy({ ...taxonomy, dimensions: [...dimensions, { key, label: "New Dimension", values: [] }], nameTemplates: templates, family });
  };
  const removeDimension = (key) => setTaxonomy({ ...taxonomy, dimensions: dimensions.filter((d) => d.key !== key), nameTemplates: templates, family });
  const setTemplate = (levelKey, v) => setTaxonomy({ ...taxonomy, dimensions, nameTemplates: { ...templates, [levelKey]: v }, family });

  const availableTokens = ["platform", ...dimensions.map((d) => d.key)];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel className="mb-0">Dimensions</SectionLabel>
          {canEdit && <Button size="sm" variant="secondary" onClick={addDimension}><Plus className="h-3.5 w-3.5" />Add dimension</Button>}
        </div>
        <div className="flex flex-col gap-2.5">
          {dimensions.map((d) => (
            <Card key={d.key}>
              <CardContent className="p-4">
                <div className="mb-2 flex items-center gap-2">
                  {canEdit ? (
                    <Input value={d.label} onChange={(e) => updateDim(d.key, { label: e.target.value })} className="h-8 w-full max-w-xs flex-1 font-semibold" />
                  ) : (
                    <span className="font-semibold text-foreground">{d.label}</span>
                  )}
                  <code className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">{`{${d.key}}`}</code>
                  {canEdit && d.key.startsWith("custom_") && <X className="ml-auto h-3.5 w-3.5 cursor-pointer text-muted-foreground hover:text-destructive" onClick={() => removeDimension(d.key)} />}
                </div>
                <ChipList items={d.values} canEdit={canEdit} placeholder="Add a value…" onAdd={(v) => addDimValue(d.key, v)} onRemove={(i) => removeDimValue(d.key, i)} />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Naming</SectionLabel>
        {canEdit && (
          <div className="mb-3 flex gap-1.5">
            {["search", "social"].map((f) => (
              <Badge key={f} variant={family === f ? "default" : "outline"} className="cursor-pointer select-none"
                onClick={() => setTaxonomy({ ...taxonomy, dimensions, nameTemplates: templates, family: f })}>
                {f === "search" ? "Paid search style (Ad Group)" : "Paid social style (Ad Set)"}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-3">
          {["campaign", "adgroup", "ad"].map((levelKey) => {
            const template = templates[levelKey] || "";
            const exampleValues = {};
            dimensions.forEach((d) => { exampleValues[d.key] = d.values[0] || ""; });
            exampleValues.platform = channelCode(family === "social" ? "LinkedIn" : "Google Search");
            const example = generateName(template, exampleValues);
            return (
              <Card key={levelKey}>
                <CardContent className="p-4">
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{levelLabel(levelKey, family)}</div>
                  {canEdit ? (
                    <Input value={template} onChange={(e) => setTemplate(levelKey, e.target.value)} className="font-mono" />
                  ) : (
                    <div className="font-mono text-sm text-foreground">{template}</div>
                  )}
                  <div className="mt-1.5 text-xs text-muted-foreground">Example: <strong className="font-semibold text-foreground">{example || "—"}</strong></div>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">Available tokens: {availableTokens.map((t) => `{${t}}`).join(", ")}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {"{platform}"} always fills with a channel code (LIN/FB/BIN/SEA/GDN/DEM/PMX/YT) instead of the full platform name, and every value has spaces/punctuation stripped before joining — the only "_" or "-" in a generated name is the separator between segments.
        </div>
      </div>
    </div>
  );
}

// ─── STEP 4: BUDGET ─────────────────────────────────────────────────────────────────────────────
// (2026-08-07, per Mo — "I don't think the budget allocation should live in taxonomy, nor do I
// think any budget allocation should be set in context except maybe for the whole monthly budget.
// There should be a net new tab just for setting budgets and allocating budgets per segment. We
// should toggle between real dollar amounts and percentages." Replaces TWO earlier homes for budget
// data: Context's Step 1 used to have a free-form itemized "Budgets" list (label + $ per line,
// summed for a total); Taxonomy used to have this same BudgetAllocation card at the bottom of its
// own step. Both are gone now — this is the one place a plan's money lives.)
//
// budgetTotal lives on taxonomy.budgetTotal (a plain number) rather than a new top-level column —
// same jsonb-bucket-inside-an-existing-field trick as everything else in this plan, so no DB
// migration was needed. Kept on taxonomy (not context) specifically because BudgetAllocation below
// needs to read it in the same object it reads dimensions from, and because per-dimension targets
// (dim.budgets) already lived there. NOT auto-seeded from the old Context budgets list on plans that
// had one (2026-08-07, per Mo — "those shouldn't be totalled. those are overlapping segments"): that
// list mixed products/regions/personas/etc. with no guarantee any two lines were mutually exclusive
// (a campaign counted under "US" could be the SAME spend already counted under "Marketing"), so
// summing it was never a valid total — just a plausible-looking wrong number. Starts genuinely
// empty; the user types the real figure.
function BudgetStep({ taxonomy, setTaxonomy, canEdit }) {
  const dimensions = taxonomy.dimensions && taxonomy.dimensions.length ? taxonomy.dimensions : DEFAULT_TAXONOMY_DIMENSIONS;
  const templates = taxonomy.nameTemplates || buildDefaultNameTemplates();
  const family = taxonomy.family || "search";
  const budgetTotal = Number(taxonomy.budgetTotal) || 0;
  const setBudgetTotal = (v) => setTaxonomy({ ...taxonomy, dimensions, nameTemplates: templates, family, budgetTotal: v === "" ? "" : Number(v) });
  const updateDim = (key, patch) => setTaxonomy({ ...taxonomy, dimensions: dimensions.map((d) => (d.key === key ? { ...d, ...patch } : d)), nameTemplates: templates, family, budgetTotal: taxonomy.budgetTotal });

  return (
    <div className="flex flex-col gap-5">
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="flex gap-3 pt-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="text-sm text-muted-foreground">
            <p className="mb-1.5 font-medium text-foreground">What to do on this screen</p>
            <p>
              Set the plan's overall <span className="font-medium text-foreground">Monthly Budget</span> below, then break it down per value of any Taxonomy dimension (segment, region, product, or a custom one) in <span className="font-medium text-foreground">Budget Allocation</span>. Each card has its own <span className="font-medium text-foreground">$ / %</span> toggle — enter real dollar amounts, or flip to percent and let this page do the math for you (a "Split evenly" shortcut divides 100% across a dimension's values in one click). Targets you set here get compared against what's actually mapped once you reach the Mapping step.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle>Monthly Budget</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <span className="text-lg text-muted-foreground">$</span>
            {canEdit ? (
              <input type="number" value={taxonomy.budgetTotal ?? ""} onChange={(e) => setBudgetTotal(e.target.value)}
                placeholder="0" className="h-10 w-full max-w-xs border-0 bg-transparent font-display text-2xl font-semibold text-foreground outline-none" />
            ) : (
              <span className="font-display text-2xl font-semibold text-foreground">{fmtFull(budgetTotal)}</span>
            )}
            <span className="text-sm text-muted-foreground">/mo</span>
          </div>
        </CardContent>
      </Card>

      <BudgetAllocation dimensions={dimensions} updateDim={updateDim} canEdit={canEdit} budgetTotal={budgetTotal} />
    </div>
  );
}

// Per-dimension budget targets (2026-08-06, per Mo — "I need to be able to set budgets for each
// segment separately. That means MM/SMB/ENT and also by persona and by region and by product and
// also by other custom segments or dimensions I create in the process"). Targets live ON the
// dimension itself (dim.budgets = { [value]: amount }) rather than a separate top-level structure —
// same jsonb-bucket-inside-an-existing-field trick as everything else in this plan, so no DB
// migration is needed (taxonomy is already a flexible jsonb column). Set here, in the Budget step
// (2026-08-07 — moved out of Taxonomy, see that step's own doc comment above), because that's where
// budgetTotal lives and dim.budgets needs it for the % math below; compared against ACTUAL Mapping
// budgets on the Mapping step's own Budget rollup card (computeDimensionBudgetComparison, same
// engine function feeds both). dim.budgetMode ("dollar" | "percent") and dim.budgetPercents (2026-08-07,
// per Mo — "set percentages for each segment instead of actual dollar values"): percent is purely an
// input convenience — dim.budgets always holds the real dollar amount (derived from
// budgetTotal * pct/100 whenever a percent changes), so nothing downstream needs to know this mode
// exists.
//
// Capped at dimensions with 1-15 values — Industry alone has 421 possible values, and a per-value $
// input list at that size would be unusable busywork, not a real feature. A dimension can still be
// used for naming/targeting at any size; it just doesn't get a budget-allocation card here.
const MAX_BUDGET_ALLOCATION_VALUES = 15;

// PCT_TOLERANCE (2026-08-07, per Mo — "give the user the ability to set a monthly budget amount and
// then just set percentages for each segment instead of actual dollar values... each bucket should
// add up to 100%"): percentages a user types by hand (33.3/33.3/33.4) essentially never sum to
// exactly 100.0 due to normal float/rounding slop, so "fully allocated" is judged within a small
// epsilon rather than requiring bit-exact 100 — same reasoning as the dollar-mode remaining check
// right below it, just applied to percent instead of dollars.
const PCT_TOLERANCE = 0.05;

function BudgetAllocation({ dimensions, updateDim, canEdit, budgetTotal }) {
  const eligible = dimensions.filter((d) => d.values.length > 0 && d.values.length <= MAX_BUDGET_ALLOCATION_VALUES);
  return (
    <div>
      <SectionLabel>Budget Allocation</SectionLabel>
      <div className="mb-2.5 text-xs text-muted-foreground">
        Optional target $/mo per value, for any dimension with a manageable value list — compared against actual Mapping budgets on the Mapping step.
        {budgetTotal > 0 && ` Your Monthly Budget totals ${fmtFull(budgetTotal)}/mo — each card below shows how its own breakdown compares to that same total.`}
      </div>
      {eligible.length === 0 ? (
        <div className="text-xs text-muted-foreground">Add values to a dimension in Taxonomy (segment, region, product, or a custom one) to set budget targets for it.</div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {eligible.map((d) => {
            const budgets = d.budgets || {};
            // budgetMode/budgetPercents (2026-08-07, per Mo's percent-split ask): budgets (dollar
            // amounts) stays the single source of truth every downstream consumer already reads
            // (Mapping's computeDimensionBudgetComparison, this same card's dollar-mode math) — %
            // mode is purely an alternate INPUT method that computes and writes the dollar amount
            // back into budgets on every keystroke, so nothing downstream has to know this mode
            // exists. budgetPercents just remembers what the user actually typed, so switching back
            // to % mode (or the Monthly Budget total changing later) doesn't lose/misrepresent their
            // split.
            const mode = d.budgetMode === "percent" ? "percent" : "dollar";
            const percents = d.budgetPercents || {};
            const total = Object.values(budgets).reduce((s, v) => s + (Number(v) || 0), 0);
            const pctTotal = Object.values(percents).reduce((s, v) => s + (Number(v) || 0), 0);
            const setValueBudget = (value, amount) => updateDim(d.key, { budgets: { ...budgets, [value]: amount } });
            const setValuePercent = (value, pct) => {
              const nextPercents = { ...percents, [value]: pct };
              const dollarAmount = budgetTotal > 0 ? Math.round(budgetTotal * (Number(pct) || 0)) / 100 : "";
              updateDim(d.key, { budgetPercents: nextPercents, budgets: { ...budgets, [value]: dollarAmount } });
            };
            const setMode = (nextMode) => {
              if (nextMode === "percent" && budgetTotal > 0) {
                // Seed percents from whatever dollar amounts already exist, so toggling to % for the
                // first time on an already-filled-in card doesn't blank everything out.
                const seeded = { ...percents };
                d.values.forEach((v) => { if (seeded[v] == null && budgets[v]) seeded[v] = Math.round((Number(budgets[v]) / budgetTotal) * 1000) / 10; });
                updateDim(d.key, { budgetMode: nextMode, budgetPercents: seeded });
              } else {
                updateDim(d.key, { budgetMode: nextMode });
              }
            };
            // Split evenly (2026-08-07, per Mo's own example — "33.3% in MM, 33.3% in SMB and 33.4%
            // in ENT"): last value absorbs the rounding remainder so the split always sums to exactly
            // 100.0, never 99.9 or 100.1 from naive equal division.
            const splitEvenly = () => {
              const n = d.values.length;
              if (n === 0) return;
              const even = Math.round((100 / n) * 10) / 10;
              const nextPercents = {};
              d.values.forEach((v, i) => { nextPercents[v] = i === n - 1 ? Math.round((100 - even * (n - 1)) * 10) / 10 : even; });
              const nextBudgets = { ...budgets };
              d.values.forEach((v) => { nextBudgets[v] = budgetTotal > 0 ? Math.round(budgetTotal * (nextPercents[v] || 0)) / 100 : ""; });
              updateDim(d.key, { budgetPercents: nextPercents, budgets: nextBudgets });
            };
            const remaining = budgetTotal > 0 ? budgetTotal - total : null;
            const remainingPct = 100 - pctTotal;
            return (
              <Card key={d.key}>
                <CardContent className="p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{d.label}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      {total > 0 && (
                        <span className="text-xs font-medium text-primary">
                          {fmtFull(total)}/mo{budgetTotal > 0 && <span className="font-normal text-muted-foreground"> / {fmtFull(budgetTotal)}</span>}
                        </span>
                      )}
                      {canEdit && (
                        <div className="flex items-center gap-0.5 rounded-md border border-border bg-secondary/40 p-0.5">
                          <button type="button" onClick={() => setMode("dollar")}
                            className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium transition-all", mode === "dollar" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>$</button>
                          <button type="button" onClick={() => setMode("percent")} disabled={!(budgetTotal > 0)}
                            title={budgetTotal > 0 ? "" : "Set your Monthly Budget total first"}
                            className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium transition-all", mode === "percent" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground", !(budgetTotal > 0) && "cursor-not-allowed opacity-40")}>%</button>
                        </div>
                      )}
                    </div>
                  </div>
                  {mode === "percent" && canEdit && (
                    <button type="button" onClick={splitEvenly} className="mb-1.5 text-[11px] font-medium text-primary hover:underline">Split evenly</button>
                  )}
                  <div className="flex flex-col gap-1.5">
                    {d.values.map((v) => (
                      <div key={v} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{v}</span>
                        {mode === "percent" ? (
                          <>
                            <div className="flex h-7 w-20 shrink-0 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs">
                              <input type="number" disabled={!canEdit} value={percents[v] ?? ""} onChange={(e) => setValuePercent(v, e.target.value)}
                                placeholder="0" step="0.1" className="w-full bg-transparent outline-none" />
                              <span className="text-muted-foreground">%</span>
                            </div>
                            <span className="w-20 shrink-0 truncate text-right text-[11px] text-muted-foreground">{budgetTotal > 0 ? fmtFull(budgets[v] || 0) : "—"}</span>
                          </>
                        ) : (
                          <Input type="number" disabled={!canEdit} value={budgets[v] || ""} onChange={(e) => setValueBudget(v, e.target.value)}
                            placeholder="$/mo" className="h-7 w-28 shrink-0 text-xs" />
                        )}
                      </div>
                    ))}
                  </div>
                  {mode === "percent" ? (
                    <div className={cn("mt-2 border-t border-border/60 pt-1.5 text-[11px]", remainingPct < -PCT_TOLERANCE ? "text-destructive" : remainingPct > PCT_TOLERANCE ? "text-warning" : "text-success")}>
                      {pctTotal === 0 ? "0% allocated" : remainingPct < -PCT_TOLERANCE ? `${Math.abs(remainingPct).toFixed(1)}% over 100%` : remainingPct > PCT_TOLERANCE ? `${pctTotal.toFixed(1)}% allocated — ${remainingPct.toFixed(1)}% left` : `100% allocated${budgetTotal > 0 ? ` (${fmtFull(total)}/mo)` : ""}`}
                    </div>
                  ) : (
                    remaining != null && total > 0 && (
                      <div className={cn("mt-2 border-t border-border/60 pt-1.5 text-[11px]", remaining < 0 ? "text-destructive" : remaining > 0 ? "text-warning" : "text-success")}>
                        {remaining < 0 ? `${fmtFull(Math.abs(remaining))} over your Monthly Budget` : remaining > 0 ? `${fmtFull(remaining)} of Monthly Budget not yet allocated here` : "Fully allocated"}
                      </div>
                    )
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── STEP 5: TARGETING ──────────────────────────────────────────────────────────────────────────
// (2026-08-06, per Mo — "we need to determine if we're going to use job titles OR job function +
// seniorities... layer on contact or company lists, whether we're going to remarket, what
// exclusions..." — confirmed via AskUserQuestion as its own step, with the reusable
// lists/exclusions/remarketing pools shared across every plan in the workspace.)

function MultiToggle({ options, selected, onChange, canEdit }) {
  const toggle = (v) => (selected.includes(v) ? onChange(selected.filter((x) => x !== v)) : onChange([...selected, v]));
  if (options.length === 0) return <span className="text-xs text-muted-foreground">No values defined in Taxonomy yet</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((v) => (
        <Badge key={v} variant={selected.includes(v) ? "default" : "outline"} className={cn("select-none", canEdit && "cursor-pointer", !selected.includes(v) && "opacity-60")}
          onClick={() => canEdit && toggle(v)}>{v}</Badge>
      ))}
    </div>
  );
}

// Reveal-on-click add form (2026-08-06, per Mo — "the open text fields... look terrible"): the
// original recipe kept a Name + Description input pair permanently visible per column, so an empty
// library rendered as nine bare, always-empty form fields side by side — the single ugliest part of
// the Targeting step. Now it matches PlanList's own "+ New plan" pattern: a compact button until
// the user actually wants to add something. Items also get a type-colored left accent + icon so the
// three columns read as distinct categories at a glance instead of three identical gray boxes.
function LibrarySection({ label, type, items, onAdd, onRemove, canEdit, icon: SectionIcon, dotClass, borderClass }) {
  const filtered = items.filter((it) => it.type === type);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(""); const [desc, setDesc] = useState("");
  const add = () => { if (!name.trim()) return; onAdd({ type, name: name.trim(), description: desc.trim() }); setName(""); setDesc(""); setAdding(false); };
  const cancel = () => { setAdding(false); setName(""); setDesc(""); };
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        <SectionIcon className={cn("h-3.5 w-3.5", dotClass)} />
        <SectionLabel className="mb-0">{label}</SectionLabel>
      </div>
      <div className={cn("flex flex-col gap-1.5", filtered.length > 0 ? "mb-2" : "")}>
        {filtered.map((it) => (
          <div key={it.id} className={cn("flex items-center gap-2 rounded-md border-l-2 bg-secondary/50 px-2.5 py-1.5 text-sm", borderClass)}>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-foreground">{it.name}</div>
              {it.description && <div className="text-[11px] text-muted-foreground">{it.description}</div>}
            </div>
            {canEdit && <X className="h-3.5 w-3.5 shrink-0 cursor-pointer opacity-60 hover:opacity-100" onClick={() => onRemove(it.id)} />}
          </div>
        ))}
        {filtered.length === 0 && !adding && <span className="text-xs text-muted-foreground">None yet</span>}
      </div>
      {canEdit && (adding ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2 shadow-sm animate-in fade-in slide-in-from-top-1 duration-150">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") cancel(); }}
            placeholder="Name…" className="h-8 text-xs" />
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" className="h-8 text-xs" />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-7 flex-1" onClick={add}>Add</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="h-7 w-full text-xs text-muted-foreground" onClick={() => setAdding(true)}>
          <Plus className="h-3 w-3" />Add {label.toLowerCase()}
        </Button>
      ))}
    </div>
  );
}

function TargetingStep({ session, workspace, taxonomy, targeting, setTargeting, canEdit }) {
  const [library, setLibrary] = useState(null);
  useEffect(() => {
    if (!workspace?.id || !session) return;
    listTargetingLibraryItems(session, workspace.id).then(setLibrary).catch(() => setLibrary([]));
  }, [session, workspace?.id]);

  const addLibraryItem = (fields) => createTargetingLibraryItem(session, workspace.id, fields).then(setLibrary);
  const removeLibraryItem = (id) => deleteTargetingLibraryItem(session, workspace.id, id).then(setLibrary);

  const dimensions = taxonomy.dimensions && taxonomy.dimensions.length ? taxonomy.dimensions : DEFAULT_TAXONOMY_DIMENSIONS;
  const companySizeValues = dimensions.find((d) => d.key === "segment")?.values || [];
  const industryValues = dimensions.find((d) => d.key === "industry")?.values || [];

  const profiles = targeting || [];
  const updateProfile = (id, patch) => setTargeting(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const removeProfile = (id) => setTargeting(profiles.filter((p) => p.id !== id));
  const addProfile = () => setTargeting([...profiles, {
    id: `tp_${Date.now()}`, name: "New Profile", method: "job_function_seniority",
    titles: [], functions: [], seniorities: [], companySizes: [], companySizeRanges: [], industries: [],
    listAttachments: [], exclusionAttachments: [], remarketing: { enabled: false, poolItemId: "", windowDays: 30 },
  }]);

  if (library === null) return <div className="text-sm text-muted-foreground">Loading targeting library…</div>;
  const listItems = library.filter((it) => it.type === "list");
  const exclusionItems = library.filter((it) => it.type === "exclusion");
  const remarketingItems = library.filter((it) => it.type === "remarketing");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Shared Targeting Library</CardTitle>
          <CardDescription>Reused across every Account Planning project for this workspace — define once, attach to any profile below.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <LibrarySection label="Contact / Company Lists" type="list" items={library} canEdit={canEdit} onAdd={addLibraryItem} onRemove={removeLibraryItem} icon={Users} dotClass="text-primary" borderClass="border-primary" />
            <LibrarySection label="Exclusion Lists" type="exclusion" items={library} canEdit={canEdit} onAdd={addLibraryItem} onRemove={removeLibraryItem} icon={Ban} dotClass="text-destructive" borderClass="border-destructive" />
            <LibrarySection label="Remarketing Pools" type="remarketing" items={library} canEdit={canEdit} onAdd={addLibraryItem} onRemove={removeLibraryItem} icon={Repeat} dotClass="text-success" borderClass="border-success" />
          </div>
        </CardContent>
      </Card>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel className="mb-0">Targeting Profiles</SectionLabel>
          {canEdit && <Button size="sm" variant="secondary" onClick={addProfile}><Plus className="h-3.5 w-3.5" />Add profile</Button>}
        </div>
        {profiles.length === 0 && (
          <div className="mb-2 rounded-lg border border-dashed border-border p-5 text-center">
            <TargetIcon className="mx-auto mb-2 h-5 w-5 text-muted-foreground/60" />
            <div className="mx-auto max-w-sm text-sm text-muted-foreground">
              Each profile is a reusable audience definition (e.g. "Enterprise IT Buyers") — assign one to any ad set in Mapping instead of re-specifying targeting from scratch every time.
            </div>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {profiles.map((p) => (
            <Card key={p.id}>
              <CardContent className="p-5">
                <div className="mb-2.5 flex items-center gap-2">
                  {canEdit ? (
                    <Input value={p.name} onChange={(e) => updateProfile(p.id, { name: e.target.value })} className="h-8 max-w-[260px] flex-1 font-semibold" />
                  ) : (
                    <span className="font-semibold text-foreground">{p.name}</span>
                  )}
                  {canEdit && <X className="ml-auto h-3.5 w-3.5 cursor-pointer text-muted-foreground hover:text-destructive" onClick={() => removeProfile(p.id)} />}
                </div>

                <div className="mb-2.5 flex gap-1.5">
                  {[["job_title", "Job Titles"], ["job_function_seniority", "Function + Seniority"]].map(([k, l]) => (
                    <Badge key={k} variant={p.method === k ? "default" : "outline"} className={cn("select-none", canEdit && "cursor-pointer", p.method !== k && "opacity-60")}
                      onClick={() => canEdit && updateProfile(p.id, { method: k })}>{l}</Badge>
                  ))}
                </div>

                {p.method === "job_title" ? (
                  <div className="mb-2.5">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Job Titles</div>
                    <ChipList items={p.titles} canEdit={canEdit} placeholder="Add a job title…" onAdd={(v) => updateProfile(p.id, { titles: [...p.titles, v] })} onRemove={(i) => updateProfile(p.id, { titles: p.titles.filter((_, x) => x !== i) })} />
                  </div>
                ) : (
                  <div className="mb-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Job Functions</div>
                      <ChipList items={p.functions} canEdit={canEdit} placeholder="Add a function…" onAdd={(v) => updateProfile(p.id, { functions: [...p.functions, v] })} onRemove={(i) => updateProfile(p.id, { functions: p.functions.filter((_, x) => x !== i) })} />
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Seniorities</div>
                      <ChipList items={p.seniorities} canEdit={canEdit} placeholder="Add a seniority…" onAdd={(v) => updateProfile(p.id, { seniorities: [...p.seniorities, v] })} onRemove={(i) => updateProfile(p.id, { seniorities: p.seniorities.filter((_, x) => x !== i) })} />
                    </div>
                  </div>
                )}

                <div className="mb-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Company Size Segment</div>
                    <MultiToggle options={companySizeValues} selected={p.companySizes} canEdit={canEdit} onChange={(v) => updateProfile(p.id, { companySizes: v })} />
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      LinkedIn Company Size (targeting range)
                    </div>
                    <MultiToggle options={LINKEDIN_COMPANY_SIZE_RANGES} selected={p.companySizeRanges || []} canEdit={canEdit} onChange={(v) => updateProfile(p.id, { companySizeRanges: v })} />
                  </div>
                </div>

                <div className="mb-2.5">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Industry ({industryValues.length} available)</div>
                  <SearchableSelect options={industryValues} value={p.industries} onChange={(v) => updateProfile(p.id, { industries: v })} multiple
                    disabled={!canEdit} placeholder="Search LinkedIn industries…" className="max-w-md" />
                </div>

                <div className="mb-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lists to layer on</div>
                    {listItems.length === 0 ? <span className="text-xs text-muted-foreground">Add lists to the library above first</span> : (
                      <div className="flex flex-wrap gap-1.5">
                        {listItems.map((it) => {
                          const attached = p.listAttachments.find((a) => a.itemId === it.id);
                          return (
                            <Badge key={it.id} variant={attached ? "default" : "outline"} className={cn("cursor-pointer select-none", !attached && "opacity-60")}
                              onClick={() => { if (!canEdit) return; const next = attached ? p.listAttachments.filter((a) => a.itemId !== it.id) : [...p.listAttachments, { itemId: it.id, direction: "include" }]; updateProfile(p.id, { listAttachments: next }); }}>
                              {it.name}
                            </Badge>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Exclusions</div>
                    {exclusionItems.length === 0 ? <span className="text-xs text-muted-foreground">Add exclusion lists to the library above first</span> : (
                      <div className="flex flex-wrap gap-1.5">
                        {exclusionItems.map((it) => {
                          const attached = p.exclusionAttachments.find((a) => a.itemId === it.id);
                          return (
                            <Badge key={it.id} variant={attached ? "destructive" : "outline"} className={cn("cursor-pointer select-none", !attached && "opacity-60")}
                              onClick={() => { if (!canEdit) return; const next = attached ? p.exclusionAttachments.filter((a) => a.itemId !== it.id) : [...p.exclusionAttachments, { itemId: it.id }]; updateProfile(p.id, { exclusionAttachments: next }); }}>
                              {it.name}
                            </Badge>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <label className={cn("flex items-center gap-1.5 text-sm text-foreground", canEdit && "cursor-pointer")}>
                    <input type="checkbox" disabled={!canEdit} checked={!!p.remarketing?.enabled} onChange={(e) => updateProfile(p.id, { remarketing: { ...p.remarketing, enabled: e.target.checked } })} className="h-3.5 w-3.5 accent-primary" />
                    Remarketing
                  </label>
                  {p.remarketing?.enabled && (
                    <>
                      <Select disabled={!canEdit} value={p.remarketing.poolItemId || "__none__"} onValueChange={(v) => updateProfile(p.id, { remarketing: { ...p.remarketing, poolItemId: v === "__none__" ? "" : v } })}>
                        <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue placeholder="Pool…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Pool…</SelectItem>
                          {remarketingItems.map((it) => <SelectItem key={it.id} value={it.id}>{it.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <div className="flex items-center gap-1.5">
                        <Input type="number" disabled={!canEdit} value={p.remarketing.windowDays || 30} onChange={(e) => updateProfile(p.id, { remarketing: { ...p.remarketing, windowDays: Number(e.target.value) } })} className="h-8 w-16 text-xs" />
                        <span className="text-xs text-muted-foreground">days</span>
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── STEP 6: MAPPING ────────────────────────────────────────────────────────────────────────────
// Two views share one `mapping` array (2026-08-06, per Mo — "a drag and drop builder that looks
// beautiful and has beautiful UX"): the original table (unchanged, still fully functional) and a
// new hierarchical Builder canvas, default view. Builder introduces a `parentKey` field on mapping
// rows (references another row's oldKey — jsonb, no DB migration; existing plans just don't have it
// set yet, and any row whose parentKey is empty/unresolvable renders in "Unassigned" instead of
// disappearing). See MappingBuilder's own doc comment below for the scope decisions on what this
// first pass does and doesn't do.

const ACTION_LABELS = { rename: "Rename", split: "Split", merge: "Merge into", kill: "Kill", keep: "Keep as-is" };
const STATUS_LABELS = { planned: "Planned", in_progress: "In progress", live: "Live" };
const LEVEL_LABELS = { campaign: "Campaign", adgroup: "Ad Group / Ad Set", ad: "Ad" };

// Hoisted out of MappingBuilder (2026-08-06) — the react-hooks/purity lint rule flags Date.now()/
// Math.random() reachable from a component's render body, even when only actually invoked inside an
// event handler; defining the impure part as its own module-level function (not itself a component
// or hook) sidesteps that check entirely, same effect as the existing `manual_${Date.now()}` /
// `custom_${Date.now()}` id patterns elsewhere in this file, just written to satisfy the newer rule.
function newMappingKey() {
  return `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function MappingStep({ mapping, setMapping, taxonomy, targeting, canEdit }) {
  const dimensions = taxonomy.dimensions && taxonomy.dimensions.length ? taxonomy.dimensions : DEFAULT_TAXONOMY_DIMENSIONS;
  const templates = taxonomy.nameTemplates || buildDefaultNameTemplates();
  const dimByKey = useMemo(() => Object.fromEntries(dimensions.map((d) => [d.key, d])), [dimensions]);
  const profiles = targeting || [];
  const [view, setView] = useState("builder");

  const rowValues = (row) => ({ platform: channelCode(row.platform) || row.platform || "", ...row.dimValues });
  const rowTemplate = (row) => templates[row.level] || templates.campaign || "";
  const generatedName = (row) => generateName(rowTemplate(row), rowValues(row));
  const finalName = (row) => (row.manualName && row.manualName.trim()) || generatedName(row);

  const addRow = () => setMapping([...mapping, { oldKey: `manual_${Date.now()}`, oldName: "", oldCampaignGroup: "", platform: "", level: "campaign", parentKey: "", action: "rename", manualName: "", dimValues: {}, status: "planned", targetingProfileId: "", budget: "", flightType: "evergreen", startDate: "", endDate: "" }]);

  // Budget rollups — grouped from each row's own `budget` (the only place budget is entered, per
  // Mo's call), never a separately-typed number per level, so these can never silently stop adding
  // up. Platform isn't a taxonomy dimension (it's derived from the audit/channel, not something with
  // user-set values), so it stays its own plain actual-only rollup; every taxonomy dimension gets a
  // target-vs-actual comparison instead (computeDimensionBudgetComparison), shown for any dimension
  // that has either a target (set in the Budget step's Budget Allocation) or actual spend against it — see
  // that section's own doc comment for why targets live on the dimension.
  const rollupsByPlatform = useMemo(() => computeBudgetRollup(mapping, (r) => r.platform), [mapping]);
  const dimensionComparisons = useMemo(
    () => dimensions.map((d) => ({ dim: d, rows: computeDimensionBudgetComparison(mapping, d) })).filter((x) => x.rows.length > 0),
    [dimensions, mapping]
  );
  const totalBudget = mapping.reduce((s, r) => s + (Number(r.budget) || 0), 0);
  const asBarList = (rows) => rows.map((r) => ({ name: r.label, value: r.amount }));

  if (mapping.length === 0) {
    return (
      <div>
        <div className="mb-3 text-sm text-muted-foreground">No mapping rows yet — add campaigns/ads from the Audit step, or add a campaign below to start building from scratch.</div>
        {canEdit && <Button variant="secondary" onClick={addRow}><Plus className="h-4 w-4" />Add campaign</Button>}
      </div>
    );
  }

  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit };

  return (
    <div>
      {totalBudget > 0 && (
        <Card className="mb-4">
          <CardHeader className="pb-2"><CardTitle>Budget rollup</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total</div>
                <div className="font-display text-2xl font-bold text-primary">{fmtFull(totalBudget)}</div>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By platform</div>
                {rollupsByPlatform.length ? <BarList data={asBarList(rollupsByPlatform)} valueFormatter={fmtFull} className="text-xs" /> : <span className="text-xs text-muted-foreground">—</span>}
              </div>
            </div>
            {dimensionComparisons.length > 0 && (
              <div className="grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-2">
                {dimensionComparisons.map(({ dim, rows }) => <DimensionBudgetBlock key={dim.key} dim={dim} rows={rows} />)}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-0.5">
          <button type="button" onClick={() => setView("builder")}
            className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all", view === "builder" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            <LayoutGrid className="h-3.5 w-3.5" />Builder
          </button>
          <button type="button" onClick={() => setView("table")}
            className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all", view === "table" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            <Table2 className="h-3.5 w-3.5" />Table
          </button>
        </div>
        {canEdit && view === "table" && <Button size="sm" variant="secondary" onClick={addRow}><Plus className="h-3.5 w-3.5" />Add row</Button>}
      </div>

      {view === "builder" ? (
        <MappingBuilder mapping={mapping} setMapping={setMapping} {...helpers} />
      ) : (
        <MappingTable mapping={mapping} setMapping={setMapping} {...helpers} />
      )}
    </div>
  );
}

// Evergreen vs. flighted toggle (2026-08-06, per Mo — after flagging the Mapping budget field is
// monthly but LinkedIn itself runs on daily/lifetime budgets: "we should add a toggle for evergreen
// or campaign with a specific flight date"). Shared between the Table and Builder views. The daily
// or total figure shown is always COMPUTED from the entered monthly budget + dates, never a second
// typed number — see computeDailyBudget/computeFlightTotalBudget's own doc comment in
// accountPlanning.js for why (evergreen -> daily budget field, flighted -> total/lifetime budget
// field, matching what LinkedIn Campaign Manager actually asks for in each case).
function FlightFields({ row, onChange, canEdit, compact }) {
  const flightType = row.flightType || "evergreen";
  const daily = computeDailyBudget(row.budget);
  const total = computeFlightTotalBudget(row.budget, row.startDate, row.endDate);
  const days = computeFlightDays(row.startDate, row.endDate);
  const inputH = compact ? "h-7" : "h-8";
  const labelCls = compact ? "text-[10px]" : "text-xs";
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn("font-semibold uppercase tracking-wide text-muted-foreground", labelCls)}>Flighting</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {[["evergreen", "Evergreen"], ["flighted", "Flight dates"]].map(([k, l]) => (
          <Badge key={k} variant={flightType === k ? "default" : "outline"} className={cn("select-none", canEdit && "cursor-pointer", flightType !== k && "opacity-60")}
            onClick={() => canEdit && onChange({ flightType: k })}>{l}</Badge>
        ))}
        {flightType === "flighted" ? (
          <>
            <Input type="date" disabled={!canEdit} value={row.startDate || ""} onChange={(e) => onChange({ startDate: e.target.value })} className={cn(inputH, "w-[138px] text-xs")} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" disabled={!canEdit} value={row.endDate || ""} onChange={(e) => onChange({ endDate: e.target.value })} className={cn(inputH, "w-[138px] text-xs")} />
            {days && total != null ? (
              <span className="text-[11px] text-muted-foreground">{days}d · ≈{fmtFull(total)} total budget</span>
            ) : row.startDate && row.endDate ? (
              <span className="text-[11px] text-warning">End date must be on/after start date</span>
            ) : null}
          </>
        ) : (
          daily != null && <span className="text-[11px] text-muted-foreground">≈ {fmtFull(daily)}/day</span>
        )}
      </div>
    </div>
  );
}

// Target-vs-actual display for one taxonomy dimension in Mapping's Budget rollup card (2026-08-06,
// per Mo — budget-by-segment/persona/region/product/custom dimensions). Rows come from
// computeDimensionBudgetComparison — a value can have a target with no actual spend yet (still
// early in Mapping), actual spend with no target set (nobody bothered setting one for that
// dimension — matches the old rollup's behavior exactly), or both, in which case going over target
// is called out in the destructive color rather than silently shown as just a bigger number.
function DimensionBudgetBlock({ dim, rows }) {
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">By {dim.label}</div>
        {totalTarget > 0 && (
          <div className={cn("text-[11px]", totalActual > totalTarget ? "text-destructive" : "text-muted-foreground")}>
            {fmtFull(totalActual)} / {fmtFull(totalTarget)} target
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((r) => {
          const over = r.target > 0 && r.actual > r.target;
          return (
            <div key={r.value} className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 px-2.5 py-1.5 text-xs">
              <span className="truncate text-foreground">{r.value}</span>
              <span className={cn("shrink-0 font-medium", over ? "text-destructive" : "text-foreground")}>
                {fmtFull(r.actual)}
                {r.target > 0 && <span className="font-normal text-muted-foreground"> / {fmtFull(r.target)}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── MAPPING: TABLE VIEW (original recipe, unchanged behavior) ────────────────────────────────────
// One addition (2026-08-06): a Channel select on campaign-level rows — manually-added rows had no
// way to ever set platform before (only audit-derived rows had it, from the audit group), which
// meant a manually-built campaign's {platform} token — now mandatory in every default template per
// Mo's naming rules — would silently render blank. Real bug, not just a Builder-view nicety, so
// it's fixed here too, not only in the new Builder cards.
function MappingTable({ mapping, setMapping, dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit }) {
  const updateRow = (i, patch) => setMapping(mapping.map((r, x) => (x === i ? { ...r, ...patch } : r)));
  const removeRow = (i) => setMapping(mapping.filter((_, x) => x !== i));

  return (
    <div className="flex flex-col gap-2.5">
      {mapping.map((row, i) => {
        const template = rowTemplate(row);
        const tokens = templateTokens(template).filter((t) => t !== "platform");
        const validation = validateName(finalName(row), template);
        return (
          <Card key={row.oldKey}>
            <CardContent className="p-5">
              <div className="flex flex-wrap items-start gap-2.5">
                <div className="min-w-[160px]">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Old</div>
                  {row.oldName ? (
                    <div className="text-sm font-semibold text-foreground">{row.oldName}</div>
                  ) : (
                    <Input value={row.oldName} onChange={(e) => updateRow(i, { oldName: e.target.value })} placeholder="Old name (optional)" disabled={!canEdit} className="h-8 w-40 text-xs" />
                  )}
                  {row.oldCampaignGroup && <div className="text-[11px] text-muted-foreground">{row.oldCampaignGroup}</div>}
                </div>

                {row.level === "campaign" && (
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</div>
                    <Select disabled={!canEdit} value={row.platform || "__none__"} onValueChange={(v) => updateRow(i, { platform: v === "__none__" ? "" : v })}>
                      <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue placeholder="Channel…" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Channel…</SelectItem>
                        {Object.keys(PLATFORM_CODES).map((p) => <SelectItem key={p} value={p}>{p} ({PLATFORM_CODES[p]})</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Level</div>
                  <Select disabled={!canEdit} value={row.level} onValueChange={(v) => updateRow(i, { level: v })}>
                    <SelectTrigger className="h-8 w-[170px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(LEVEL_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                </div>

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action</div>
                  <Select disabled={!canEdit} value={row.action} onValueChange={(v) => updateRow(i, { action: v })}>
                    <SelectTrigger className="h-8 w-[132px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(ACTION_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                </div>

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</div>
                  <Select disabled={!canEdit} value={row.status} onValueChange={(v) => updateRow(i, { status: v })}>
                    <SelectTrigger className="h-8 w-[132px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(STATUS_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                </div>

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Targeting</div>
                  <Select disabled={!canEdit} value={row.targetingProfileId || "__none__"} onValueChange={(v) => updateRow(i, { targetingProfileId: v === "__none__" ? "" : v })}>
                    <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Budget</div>
                  <Input type="number" disabled={!canEdit} value={row.budget || ""} onChange={(e) => updateRow(i, { budget: e.target.value })} placeholder="$/mo" className="h-8 w-24 text-xs" />
                </div>

                {canEdit && (
                  <button type="button" onClick={() => removeRow(i)} className="ml-auto self-start border-0 bg-transparent p-1 text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="mt-2.5">
                <FlightFields row={row} onChange={(patch) => updateRow(i, patch)} canEdit={canEdit} />
              </div>

              <Separator className="my-3" />

              <div className="mb-2 flex flex-wrap gap-1.5">
                {tokens.map((tok) => {
                  const dim = dimByKey[tok];
                  const val = row.dimValues?.[tok] || "";
                  if (dim && dim.values.length > 0) {
                    // Large value lists (Industry: ~300 LinkedIn values) get the searchable
                    // combobox instead of a plain Select — a Radix Select's Viewport scrolls but
                    // has no filtering, unusable at that size (2026-08-06, per Mo).
                    if (dim.values.length > 12) {
                      return (
                        <SearchableSelect key={tok} options={dim.values} value={val}
                          onChange={(v) => updateRow(i, { dimValues: { ...row.dimValues, [tok]: v } })}
                          disabled={!canEdit} placeholder={`${dim.label}…`} className="w-40" />
                      );
                    }
                    return (
                      <Select key={tok} disabled={!canEdit} value={val || "__none__"} onValueChange={(v) => updateRow(i, { dimValues: { ...row.dimValues, [tok]: v === "__none__" ? "" : v } })}>
                        <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue placeholder={`${dim.label}…`} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{dim.label}…</SelectItem>
                          {dim.values.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    );
                  }
                  return (
                    <Input key={tok} disabled={!canEdit} value={val} onChange={(e) => updateRow(i, { dimValues: { ...row.dimValues, [tok]: e.target.value } })}
                      placeholder={dim ? dim.label : tok} className="h-8 w-32 text-xs" />
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">New</div>
                <Input disabled={!canEdit} value={row.manualName} onChange={(e) => updateRow(i, { manualName: e.target.value })}
                  placeholder={generatedName(row) || "Generated from taxonomy…"} className="h-8 flex-1 font-mono text-xs font-semibold" />
              </div>
              {finalName(row) && !validation.valid && (
                <div className="mt-1.5 text-xs text-warning">{validation.issues.join(" · ")}</div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ─── MAPPING: BUILDER VIEW (drag-and-drop) ─────────────────────────────────────────────────────────
// Visual Campaign -> Ad Set/Ad Group -> Ad canvas (2026-08-06, per Mo — "a drag and drop builder
// that looks beautiful and has beautiful UX"), built on @dnd-kit (no drag-and-drop library existed
// in this codebase before this). Scope decisions, made explicit since this is genuinely new surface
// and easy to over-build:
//   - Reparenting (dragging an ad set onto a different campaign's drop zone, or an ad onto a
//     different ad set's) is the core interaction and the only thing drag actually does. Fine-
//     grained reordering WITHIN one container isn't implemented yet (items render in array/creation
//     order) — reparenting was the higher-value interaction to ship first.
//   - Top-level campaigns aren't drag-reorderable in this pass, only creatable/deletable/editable —
//     same reasoning.
//   - Deleting a campaign or ad set does NOT cascade-delete its children — they drop into
//     "Unassigned" instead (removeRow clears the dangling parentKey), so a misclick can never
//     silently destroy child rows.
//   - Ad-level nesting only renders under ad sets whose platform is LinkedIn/Meta (platformFamily
//     "social") — search-family platforms (Google/Bing/etc.) don't carry ad-level identity in this
//     app's data model (see accountPlanning.js's platformFamily doc comment), so an "Ads" drop zone
//     there would just be dead UI with nothing to ever contain.
//   - A campaign's Channel select doesn't cascade to ad sets/ads created before the change — each
//     row's platform is copied at creation time, not live-linked to its parent. Noted here rather
//     than solved: realistically a channel gets decided before building out a campaign, not changed
//     mid-build, and live-linking adds real complexity for an edge case.
//   - No "drag straight from the Audit step" palette yet — audit groups still get pulled in via the
//     existing "+ Mapping" button on the Audit step (unchanged); the Builder's job here is arranging
//     what's already in `mapping`, not re-implementing that intake step.

function MappingBuilder({ mapping, setMapping, dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit }) {
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const campaigns = useMemo(() => mapping.filter((r) => r.level === "campaign"), [mapping]);
  const childrenOf = useMemo(() => {
    const map = new Map();
    for (const r of mapping) {
      if (r.level === "campaign") continue;
      const key = r.parentKey || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    return map;
  }, [mapping]);
  const validKeys = useMemo(() => new Set(mapping.map((r) => r.oldKey)), [mapping]);
  const unassigned = useMemo(
    () => mapping.filter((r) => r.level !== "campaign" && (!r.parentKey || !validKeys.has(r.parentKey))),
    [mapping, validKeys]
  );

  const updateRow = (oldKey, patch) => setMapping(mapping.map((r) => (r.oldKey === oldKey ? { ...r, ...patch } : r)));
  const removeRow = (oldKey) => setMapping(
    mapping.filter((r) => r.oldKey !== oldKey).map((r) => (r.parentKey === oldKey ? { ...r, parentKey: "" } : r))
  );
  const blankRow = (extra) => ({
    oldKey: newMappingKey(), oldName: "", oldCampaignGroup: "", platform: "", level: "campaign", parentKey: "",
    action: "rename", manualName: "", dimValues: {}, status: "planned", targetingProfileId: "", budget: "",
    flightType: "evergreen", startDate: "", endDate: "", ...extra,
  });
  const addCampaign = () => setMapping([...mapping, blankRow({})]);
  const addChild = (parentKey, level, platform) => setMapping([...mapping, blankRow({ level, parentKey, platform })]);

  const activeRow = activeId ? mapping.find((r) => r.oldKey === activeId) : null;

  const onDragEnd = ({ active, over }) => {
    setActiveId(null);
    if (!over || !canEdit) return;
    const row = mapping.find((r) => r.oldKey === active.id);
    if (!row) return;
    const zone = String(over.id);
    if (zone === "unassigned") {
      if (row.parentKey) updateRow(row.oldKey, { parentKey: "" });
      return;
    }
    if (zone.startsWith("campaign:")) {
      const parentKey = zone.slice("campaign:".length);
      if (parentKey === row.oldKey || row.level === "campaign") return;
      if (row.level === "adgroup" && row.parentKey === parentKey) return;
      const parent = mapping.find((r) => r.oldKey === parentKey);
      updateRow(row.oldKey, { level: "adgroup", parentKey, platform: row.platform || parent?.platform || "" });
      return;
    }
    if (zone.startsWith("adset:")) {
      const parentKey = zone.slice("adset:".length);
      if (parentKey === row.oldKey || row.level === "campaign") return;
      if (row.level === "ad" && row.parentKey === parentKey) return;
      const parent = mapping.find((r) => r.oldKey === parentKey);
      updateRow(row.oldKey, { level: "ad", parentKey, platform: row.platform || parent?.platform || "" });
    }
  };

  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, updateRow, removeRow };

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setActiveId(e.active.id)} onDragEnd={onDragEnd}>
      <div className="flex flex-col gap-4">
        {campaigns.map((c) => (
          <CampaignNode key={c.oldKey} row={c} childRows={childrenOf.get(c.oldKey) || []} childrenOf={childrenOf}
            onAddAdSet={() => addChild(c.oldKey, "adgroup", c.platform)} {...helpers} />
        ))}
        {canEdit && (
          <button type="button" onClick={addCampaign}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-3 text-sm font-medium text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-primary">
            <Plus className="h-4 w-4" />Add campaign
          </button>
        )}
        <UnassignedZone items={unassigned} childrenOf={childrenOf} {...helpers} />
      </div>
      <DragOverlay dropAnimation={{ duration: 150 }}>
        {activeRow ? (
          <div className="w-64 rounded-lg border border-primary bg-card px-3 py-2 shadow-lg">
            <div className="truncate font-mono text-xs font-semibold text-primary">{finalName(activeRow) || "Untitled"}</div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function CampaignNode({ row, childRows, childrenOf, onAddAdSet, dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, updateRow, removeRow }) {
  const { setNodeRef, isOver } = useDroppable({ id: `campaign:${row.oldKey}` });
  const family = platformFamily(row.platform);
  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, updateRow, removeRow };
  return (
    <Card className={cn("border-l-4 border-l-primary transition-colors", isOver && "ring-2 ring-primary/40")}>
      <CardContent className="p-4">
        <NodeHeader row={row} icon={Megaphone} nodeLabel="campaign" showPlatform {...helpers} />
        <div ref={setNodeRef} className={cn("mt-3 flex flex-col gap-2 rounded-lg border border-dashed border-border/70 p-2.5 transition-colors", isOver && "border-primary bg-primary/5")}>
          {childRows.length === 0 && <div className="py-2 text-center text-xs text-muted-foreground">Drop an ad set here, or add one below</div>}
          {childRows.map((child) => (
            <AdSetNode key={child.oldKey} row={child} childRows={childrenOf.get(child.oldKey) || []} campaignPlatform={row.platform} {...helpers} />
          ))}
          {canEdit && (
            <button type="button" onClick={onAddAdSet}
              className="flex items-center justify-center gap-1.5 rounded-md border-0 bg-transparent py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
              <Plus className="h-3 w-3" />Add {family === "social" ? "ad set" : "ad group"}
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AdSetNode({ row, childRows, campaignPlatform, dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, updateRow, removeRow }) {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({ id: row.oldKey });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `adset:${row.oldKey}` });
  const family = platformFamily(row.platform || campaignPlatform);
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30, position: "relative" } : undefined;
  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, updateRow, removeRow };
  return (
    <div ref={setDragRef} style={style} className={cn(isDragging && "opacity-40")}>
      <Card className="border-l-4 border-l-secondary-foreground/20 bg-secondary/30">
        <CardContent className="p-3">
          <NodeHeader row={row} icon={Layers} nodeLabel="ad set" dragHandleProps={{ ...attributes, ...listeners }} compact {...helpers} />
          {family === "social" && (
            <div ref={setDropRef} className={cn("mt-2 flex flex-col gap-1.5 rounded-md border border-dashed border-border/60 p-2 transition-colors", isOver && "border-primary bg-primary/5")}>
              {childRows.length === 0 && <div className="py-1 text-center text-[11px] text-muted-foreground">Drop an ad here</div>}
              {childRows.map((ad) => <AdNode key={ad.oldKey} row={ad} {...helpers} />)}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AdNode({ row, dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, updateRow, removeRow }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: row.oldKey });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30, position: "relative" } : undefined;
  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
      <Card className="border-l-4 border-l-muted-foreground/20">
        <CardContent className="p-2.5">
          <NodeHeader row={row} icon={ImageIcon} nodeLabel="ad" dragHandleProps={{ ...attributes, ...listeners }} compact
            dimByKey={dimByKey} profiles={profiles} rowTemplate={rowTemplate} generatedName={generatedName} finalName={finalName}
            canEdit={canEdit} updateRow={updateRow} removeRow={removeRow} />
        </CardContent>
      </Card>
    </div>
  );
}

function UnassignedZone({ items, childrenOf, dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, updateRow, removeRow }) {
  const { setNodeRef, isOver } = useDroppable({ id: "unassigned" });
  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, updateRow, removeRow };
  return (
    <div ref={setNodeRef} className={cn("flex flex-col gap-2 rounded-lg border border-dashed p-3 transition-colors", items.length > 0 ? "border-warning/50 bg-warning/5" : "border-border/60", isOver && "border-warning bg-warning/10")}>
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Layers className="h-3.5 w-3.5" />Unassigned {items.length > 0 && `(${items.length})`}
      </div>
      {items.length === 0 ? (
        <div className="py-1 text-[11px] text-muted-foreground">Nothing unassigned — drop something here to detach it from its campaign or ad set.</div>
      ) : (
        <>
          <div className="text-[11px] text-muted-foreground">Not nested under a campaign yet — drag onto a campaign or ad set above.</div>
          {items.map((row) => row.level === "adgroup" ? (
            <AdSetNode key={row.oldKey} row={row} childRows={childrenOf.get(row.oldKey) || []} campaignPlatform="" {...helpers} />
          ) : (
            <AdNode key={row.oldKey} row={row} {...helpers} />
          ))}
        </>
      )}
    </div>
  );
}

// Shared collapsed/expandable header used by every Builder node (Campaign/AdSet/Ad) — collapsed
// shows the generated name + status/action/budget at a glance; expanded reveals the same field set
// the Table view edits (Action/Status/Targeting/Budget/name tokens/manual override), so nothing is
// Builder-only or Table-only in terms of what's editable, just how it's arranged.
function NodeHeader({ row, icon: Icon, nodeLabel, dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, updateRow, removeRow, dragHandleProps, showPlatform, compact }) {
  const [expanded, setExpanded] = useState(false);
  const template = rowTemplate(row);
  const tokens = templateTokens(template).filter((t) => t !== "platform");
  const validation = validateName(finalName(row), template);
  const statusMeta = STATUS_META[row.status] || STATUS_META.planned;
  return (
    <div>
      <div className="flex items-start gap-2">
        {dragHandleProps && (
          <button type="button" {...dragHandleProps}
            className="mt-0.5 flex h-6 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded border-0 bg-transparent text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing">
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", compact ? "text-muted-foreground" : "text-primary")} />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => setExpanded((e) => !e)} className="flex w-full items-center gap-1.5 border-0 bg-transparent p-0 text-left">
            <span className={cn("truncate font-mono font-semibold text-foreground", compact ? "text-xs" : "text-sm")}>{finalName(row) || `Untitled ${nodeLabel}`}</span>
            <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {row.oldName && <span className="truncate text-[11px] text-muted-foreground">was &quot;{row.oldName}&quot;</span>}
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{ACTION_LABELS[row.action] || row.action}</Badge>
            <Badge variant={statusMeta.badge} className="h-4 px-1.5 text-[10px]">{statusMeta.label}</Badge>
            {row.budget ? <span className="text-[11px] font-medium text-foreground">{fmtFull(Number(row.budget))}</span> : null}
            {!validation.valid && finalName(row) && <span className="text-[11px] text-warning">⚠ {validation.issues[0]}</span>}
          </div>
        </div>
        {canEdit && (
          <button type="button" onClick={() => removeRow(row.oldKey)} className="shrink-0 border-0 bg-transparent p-1 text-muted-foreground/60 hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-2.5 flex flex-col gap-2.5 border-t border-border/60 pt-2.5">
          {showPlatform && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Channel</div>
              <Select disabled={!canEdit} value={row.platform || "__none__"} onValueChange={(v) => updateRow(row.oldKey, { platform: v === "__none__" ? "" : v })}>
                <SelectTrigger className="h-7 w-[160px] text-xs"><SelectValue placeholder="Channel…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Channel…</SelectItem>
                  {Object.keys(PLATFORM_CODES).map((p) => <SelectItem key={p} value={p}>{p} ({PLATFORM_CODES[p]})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Action</div>
              <Select disabled={!canEdit} value={row.action} onValueChange={(v) => updateRow(row.oldKey, { action: v })}>
                <SelectTrigger className="h-7 w-[120px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(ACTION_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Status</div>
              <Select disabled={!canEdit} value={row.status} onValueChange={(v) => updateRow(row.oldKey, { status: v })}>
                <SelectTrigger className="h-7 w-[120px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(STATUS_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Targeting</div>
              <Select disabled={!canEdit} value={row.targetingProfileId || "__none__"} onValueChange={(v) => updateRow(row.oldKey, { targetingProfileId: v === "__none__" ? "" : v })}>
                <SelectTrigger className="h-7 w-[140px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Budget</div>
              <Input type="number" disabled={!canEdit} value={row.budget || ""} onChange={(e) => updateRow(row.oldKey, { budget: e.target.value })} placeholder="$/mo" className="h-7 w-24 text-xs" />
            </div>
          </div>
          <FlightFields row={row} onChange={(patch) => updateRow(row.oldKey, patch)} canEdit={canEdit} compact />
          {tokens.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Name tokens</div>
              <div className="flex flex-wrap gap-1.5">
                {tokens.map((tok) => {
                  const dim = dimByKey[tok];
                  const val = row.dimValues?.[tok] || "";
                  if (dim && dim.values.length > 0) {
                    if (dim.values.length > 12) {
                      return (
                        <SearchableSelect key={tok} options={dim.values} value={val}
                          onChange={(v) => updateRow(row.oldKey, { dimValues: { ...row.dimValues, [tok]: v } })}
                          disabled={!canEdit} placeholder={`${dim.label}…`} className="w-40" />
                      );
                    }
                    return (
                      <Select key={tok} disabled={!canEdit} value={val || "__none__"} onValueChange={(v) => updateRow(row.oldKey, { dimValues: { ...row.dimValues, [tok]: v === "__none__" ? "" : v } })}>
                        <SelectTrigger className="h-7 w-[120px] text-xs"><SelectValue placeholder={`${dim.label}…`} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{dim.label}…</SelectItem>
                          {dim.values.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    );
                  }
                  return (
                    <Input key={tok} disabled={!canEdit} value={val} onChange={(e) => updateRow(row.oldKey, { dimValues: { ...row.dimValues, [tok]: e.target.value } })}
                      placeholder={dim ? dim.label : tok} className="h-7 w-28 text-xs" />
                  );
                })}
              </div>
            </div>
          )}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Manual name override</div>
            <Input disabled={!canEdit} value={row.manualName} onChange={(e) => updateRow(row.oldKey, { manualName: e.target.value })}
              placeholder={generatedName(row) || "Generated from taxonomy…"} className="h-7 font-mono text-xs" />
          </div>
          {!row.oldName && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Old name (optional)</div>
              <Input disabled={!canEdit} value={row.oldName} onChange={(e) => updateRow(row.oldKey, { oldName: e.target.value })} placeholder="e.g. existing campaign this replaces" className="h-7 text-xs" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// This whole app has no error boundary anywhere (2026-08-07, found debugging Mo's report — "the
// mapping tab is empty, i'm taken to a white screen each time I go to it"), which means an uncaught
// render error in ANY step blanks the entire page with zero diagnostic info, in the browser or in
// Vercel's logs (a client-side render crash never touches a serverless function, so it's invisible
// to get_runtime_errors/get_runtime_logs too). Scoped to just the active step's content rather than
// the whole AccountPlanning tree, so a bug in one step can't take out the plan list/step nav around
// it, and keyed by activeStep (below) so switching tabs away from a broken step and back always
// gets a fresh mount instead of staying stuck showing the old error. Surfaces the real error message
// so the next report is actually actionable instead of just "it's blank."
class StepErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[AccountPlanning] step render error:", error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="text-sm font-semibold text-destructive">Something went wrong rendering this step.</div>
          <div className="mt-1.5 font-mono text-xs text-muted-foreground">{this.state.error.message || String(this.state.error)}</div>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => this.setState({ error: null })}>Try again</Button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────────────────────────

export default function AccountPlanning({ session, workspace, mergedNormRows, combineGoogleChannels = {}, tags = {}, tagDims = [], adTags = {}, canEdit, sidebarEl }) {
  const [plans, setPlans] = useState([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [plan, setPlan] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  // Dark mode (2026-08-06, per Mo's "world class" push) — initial value read once via useState's
  // own initializer (never set synchronously in an effect body, per this file's established
  // set-state-in-effect pattern): explicit saved choice wins, otherwise fall back to the OS-level
  // preference. The effect below only performs DOM/localStorage side effects, not setState, so it's
  // exempt from that lint rule entirely.
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return false;
    const saved = window.localStorage.getItem("paidhq-theme");
    if (saved) return saved === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches || false;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    window.localStorage.setItem("paidhq-theme", dark ? "dark" : "light");
  }, [dark]);
  const toggleDark = () => setDark((d) => !d);

  // Mount-only fetch — all setState happens inside the promise callbacks (async-external-system
  // pattern), never synchronously in the effect body itself. plansLoading starts true via its own
  // useState initializer above, so there's no need to set it true again here.
  useEffect(() => {
    if (!workspace?.id || !session) return;
    let cancelled = false;
    listAccountPlans(session, workspace.id)
      .then((p) => { if (!cancelled) { setPlans(p); setPlansLoading(false); } })
      .catch(() => { if (!cancelled) setPlansLoading(false); });
    return () => { cancelled = true; };
  }, [workspace?.id, session]);

  // selectedId->plan fetch — resetting `plan` to null when switching plans happens in the click
  // handlers below (openPlan/backToList), not here, so this effect never calls setState
  // synchronously in its own body, only inside the fetch's .then/.catch.
  useEffect(() => {
    if (!selectedId) return;
    getAccountPlan(session, workspace.id, selectedId).then(setPlan).catch(() => setPlan(null));
  }, [selectedId, session, workspace?.id]);

  // Debounced autosave — see updateAccountPlan's own call below for the field list; setSaving(true)
  // fires inside the timeout callback (not synchronously in the effect body) per React's
  // set-state-in-effect rule.
  useEffect(() => {
    if (!plan || !canEdit) return;
    const t = setTimeout(() => {
      setSaving(true);
      updateAccountPlan(session, workspace.id, {
        planId: plan.id, name: plan.name, status: plan.status, activeStep: plan.activeStep,
        context: plan.context, taxonomy: plan.taxonomy, auditDecisions: plan.auditDecisions,
        targeting: plan.targeting, mapping: plan.mapping,
      }).then(() => { setSaving(false); setSavedAt(Date.now()); }).catch(() => setSaving(false));
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const openPlan = (id) => { setPlan(null); setSelectedId(id); };
  const backToList = () => { setSelectedId(null); setPlan(null); };
  const createPlan = (name) => {
    createAccountPlan(session, workspace.id, name).then((p) => { setPlans([{ ...p }, ...plans]); openPlan(p.id); });
  };
  const removePlan = (id) => {
    deleteAccountPlan(session, workspace.id, id).then(() => setPlans(plans.filter((p) => p.id !== id)));
  };

  if (!selectedId || !plan) {
    return (
      <div className="flex-1 overflow-auto bg-muted p-6 sm:p-10">
        <PlanList plans={plans} loading={plansLoading} canEdit={canEdit} onOpen={openPlan} onCreate={createPlan} onDelete={removePlan} dark={dark} onToggleDark={toggleDark} />
      </div>
    );
  }

  const activeStep = plan.activeStep || "context";
  const setStepField = (field, value) => setPlan({ ...plan, [field]: value });

  // Step nav lives in the app's shared sidebar rail now (2026-08-07, per Mo — "make it the width of
  // campaign tagger and include the second vertical column, just like the campaign tagger"), the
  // same portal-into-a-ref pattern every other Tailwind-and-legacy-tab-alike uses (ChangeHistory.jsx,
  // Vault.jsx, PipelineTagger.jsx, ...) — see PaidHQ.jsx's STATS SIDEBAR block for the ref/aside this
  // portals into. Previously this rendered as an inline 190px-wide column INSIDE a max-w-5xl-capped
  // page, which is what was actually squeezing the Audit/Mapping tables so hard — moving it out and
  // dropping that width cap (see the wrapper below) are the same fix, not two unrelated changes.
  const sidebarPortal = sidebarEl && createPortal(
    <div className="bhq-scroll flex h-full flex-col gap-1 overflow-auto">
      <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Steps</div>
      {STEPS.map((s, i) => {
        const active = activeStep === s.key;
        const StepIcon = s.Icon;
        return (
          <button type="button" key={s.key} onClick={() => setStepField("activeStep", s.key)}
            className={cn("flex items-center gap-2 whitespace-nowrap rounded-lg border-0 px-3 py-2 text-left transition-all active:scale-[0.97]", active ? "bg-accent" : "bg-transparent hover:bg-secondary")}>
            <span className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors", active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>
              {i + 1}
            </span>
            <StepIcon className={cn("h-3.5 w-3.5", active ? "text-primary" : "text-muted-foreground")} />
            <span className={cn("text-sm", active ? "font-semibold text-primary" : "font-medium text-muted-foreground")}>{s.label}</span>
          </button>
        );
      })}
    </div>,
    sidebarEl
  );

  return (
    <div className="flex-1 overflow-auto bg-muted p-6 sm:p-10">
      {sidebarPortal}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <button type="button" onClick={backToList} className="mb-2 flex items-center gap-1 border-0 bg-transparent p-0 text-xs text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-3.5 w-3.5" /> All plans
          </button>
          <div className="flex flex-wrap items-center gap-2.5">
            {canEdit ? (
              <input value={plan.name} onChange={(e) => setStepField("name", e.target.value)}
                className="font-display min-w-[200px] border-none bg-transparent p-0 text-2xl font-semibold text-foreground outline-none" />
            ) : (
              <h2 className="font-display text-2xl font-semibold text-foreground">{plan.name}</h2>
            )}
            {canEdit && (
              <Select value={plan.status || "draft"} onValueChange={(v) => setStepField("status", v)}>
                <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="in_progress">In progress</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                </SelectContent>
              </Select>
            )}
            <SavedIndicator saving={saving} savedAt={savedAt} />
          </div>
        </div>
        <ThemeToggle dark={dark} onToggle={toggleDark} />
      </div>

      {/* Small-screen fallback — PaidHQ.jsx hides the whole sidebar rail below its own isMobile
          cutoff (width<768, i.e. Tailwind's md breakpoint), so the step nav needs an inline copy
          there or narrow windows lose it entirely. md:hidden here matches that exact cutoff so it
          never renders twice alongside the portalled sidebar copy above. */}
      <div className="mb-4 flex flex-row gap-1 overflow-x-auto md:hidden">
        {STEPS.map((s, i) => {
          const active = activeStep === s.key;
          const StepIcon = s.Icon;
          return (
            <button type="button" key={s.key} onClick={() => setStepField("activeStep", s.key)}
              className={cn("flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border-0 px-3 py-2 text-left transition-all active:scale-[0.97]", active ? "bg-accent" : "bg-transparent hover:bg-secondary")}>
              <span className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors", active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>
                {i + 1}
              </span>
              <StepIcon className={cn("h-3.5 w-3.5", active ? "text-primary" : "text-muted-foreground")} />
              <span className={cn("text-sm", active ? "font-semibold text-primary" : "font-medium text-muted-foreground")}>{s.label}</span>
            </button>
          );
        })}
      </div>

      <div key={activeStep} className="min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <StepErrorBoundary key={activeStep}>
          {activeStep === "context" && <ContextStep context={plan.context || {}} setContext={(v) => setStepField("context", v)} canEdit={canEdit} />}
          {activeStep === "audit" && (
            <AuditStep session={session} workspace={workspace} mergedNormRows={mergedNormRows} combineGoogleChannels={combineGoogleChannels}
              tags={tags} tagDims={tagDims} adTags={adTags}
              auditDecisions={plan.auditDecisions || {}} setAuditDecisions={(v) => setStepField("auditDecisions", v)}
              mapping={plan.mapping || []} setMapping={(v) => setStepField("mapping", v)} canEdit={canEdit} />
          )}
          {activeStep === "taxonomy" && <TaxonomyStep taxonomy={plan.taxonomy || {}} setTaxonomy={(v) => setStepField("taxonomy", v)} context={plan.context || {}} canEdit={canEdit} />}
          {activeStep === "budget" && <BudgetStep taxonomy={plan.taxonomy || {}} setTaxonomy={(v) => setStepField("taxonomy", v)} canEdit={canEdit} />}
          {activeStep === "targeting" && (
            <TargetingStep session={session} workspace={workspace} taxonomy={plan.taxonomy || {}} targeting={plan.targeting || []} setTargeting={(v) => setStepField("targeting", v)} canEdit={canEdit} />
          )}
          {activeStep === "mapping" && (
            <MappingStep mapping={plan.mapping || []} setMapping={(v) => setStepField("mapping", v)} taxonomy={plan.taxonomy || {}} targeting={plan.targeting || []} canEdit={canEdit} />
          )}
        </StepErrorBoundary>
      </div>
    </div>
  );
}
