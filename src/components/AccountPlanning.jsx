import { Component, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  listAccountPlans, getAccountPlan, createAccountPlan, updateAccountPlan, deleteAccountPlan,
} from "../lib/accountPlanningApi.js";
import {
  listTargetingLibraryItems, createTargetingLibraryItem, deleteTargetingLibraryItem,
} from "../lib/targetingLibraryApi.js";
import {
  levelLabel, computeBudgetRollup, channelCode, platformFamily,
  DEFAULT_TAXONOMY_DIMENSIONS, buildDefaultNameTemplates, generateName, validateName, templateTokens,
  LINKEDIN_COMPANY_SIZE_RANGES, PLATFORM_CODES, CHANNEL_FAMILY_GROUPS, computeFlightDays, computeDailyBudget, computeFlightTotalBudget,
  computeDimensionBudgetComparison, computeChannelBudgetComparison,
} from "../lib/accountPlanning.js";
import { SearchableSelect } from "./ui/searchable-select.jsx";
import { fmtFull } from "../lib/core.js";
import { BarList } from "@tremor/react";
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  Plus, Trash2, ChevronLeft, Compass, Tags, Target as TargetIcon, ListChecks, X, Moon, Sun,
  Users, Ban, Repeat, GripVertical, Megaphone, Layers, Image as ImageIcon, LayoutGrid, Table2, ChevronDown,
  Info, DollarSign, CalendarClock,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card.jsx";
import { Badge } from "./ui/badge.jsx";
import { Input } from "./ui/input.jsx";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select.jsx";
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

// Order (2026-08-07, per Mo — "I don't understand what to do here... let's figure out the flow of
// this workflow": channel selection first, then flighting, then budget-by-channel, THEN the old
// context fields, then taxonomy/targeting/mapping as before). Audit is REMOVED from this array
// entirely — per Mo, "let's get rid of that altogether... it shouldn't live under campaign
// planning" — it's now its own standalone top-level tab, see CampaignAudit.jsx.
const STEPS = [
  { key: "channelStrategy", label: "Channel Strategy", Icon: Compass },
  { key: "flightingStrategy", label: "Flighting Strategy", Icon: CalendarClock },
  { key: "budget", label: "Budget", Icon: DollarSign },
  { key: "context", label: "Context", Icon: TargetIcon },
  { key: "taxonomy", label: "Taxonomy", Icon: Tags },
  { key: "targeting", label: "Targeting", Icon: Users },
  { key: "mapping", label: "Mapping", Icon: ListChecks },
];

// TIER_META/SIGNAL_LABELS/DONUT_COLORS/TIER_DOT moved to CampaignAudit.jsx (2026-08-07, per Mo —
// Audit is no longer part of this wizard) along with the rest of the Audit step. STATUS_META below
// is unrelated (a mapping ROW's planned/in_progress/live status, and this plan's own draft/in_
// progress/complete status) and stays here — it's genuinely shared, not audit-specific.
const STATUS_META = {
  draft: { badge: "secondary", label: "Draft" },
  in_progress: { badge: "warning", label: "In progress" },
  complete: { badge: "success", label: "Complete" },
};

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

// ─── STEP 1: CHANNEL STRATEGY ───────────────────────────────────────────────────────────────────
// New, first step in the flow (2026-08-07, per Mo — "I don't understand what to do here... we need
// to figure out the context first... [the user] needs to decide if this is multi channel, and if
// so, is it both search and social or just search or just social... if it's social, is it just
// linkedin or just meta or just reddit or just youtube or just tiktok or is it a combination... if
// it's search, is it just google or is it just bing or is it both"). This is the very first
// decision a plan makes, before any of the old Context fields — everything downstream (Budget's
// channel split, Mapping's channel tabs) reads context.channelStrategy.channels, so an empty
// selection here just means those later steps fall back to showing every PLATFORM_CODES platform
// (same backward-compatible behavior as a plan created before this step existed).
// Persisted as context.channelStrategy = { channels: string[] } — a flat list of PLATFORM_CODES
// keys, not a nested { social: [...], search: [...] } shape, even though the UI below groups them
// into Social/Search sections for clarity. Flat storage means every other step that reads "which
// channels is this plan building for" (Budget, Mapping) only has to look in one place, not two.
// Google's 4 sub-products (Search/Display/Demand Gen/Performance Max) are each their own checkbox
// in the Search section per Mo's explicit answer ("pick Google products up front") rather than one
// "Google" checkbox — that answer also means there's no single "Google" toggle to special-case here,
// each product is picked (or not) independently, same granularity Mapping's channel tabs already use.
function ChannelStrategyStep({ context, setContext, canEdit }) {
  const channels = context.channelStrategy?.channels || [];
  const toggle = (platform) => {
    if (!canEdit) return;
    const next = channels.includes(platform) ? channels.filter((p) => p !== platform) : [...channels, platform];
    setContext({ ...context, channelStrategy: { ...(context.channelStrategy || {}), channels: next } });
  };
  const renderGroup = (title, platforms) => (
    <Card>
      <CardHeader className="pb-2"><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1.5">
          {platforms.map((p) => (
            <Badge key={p} variant={channels.includes(p) ? "default" : "outline"}
              className={cn("select-none", canEdit && "cursor-pointer", !channels.includes(p) && "opacity-60")}
              onClick={() => toggle(p)}>
              {p} <span className="ml-1 font-normal opacity-70">({PLATFORM_CODES[p]})</span>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
  return (
    <div className="flex flex-col gap-4">
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="flex gap-3 pt-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="text-sm text-muted-foreground">
            <p className="mb-1.5 font-medium text-foreground">What to do on this screen</p>
            <p>
              Decide WHERE this plan is building campaigns before anything else — everything after
              this (Budget, Context, Taxonomy, Targeting, Mapping) works off the channels picked
              here. Click a channel to select or deselect it; select as many or as few as this plan
              actually covers. <span className="font-medium text-foreground">Social</span> and{" "}
              <span className="font-medium text-foreground">Search</span> are separate groups so you
              can build a search-only plan, a social-only plan, or a true multi-channel plan without
              the two ever being conflated — Budget's channel split and Mapping's channel tabs will
              only offer the channels selected here.
            </p>
          </div>
        </CardContent>
      </Card>
      {renderGroup("Social", CHANNEL_FAMILY_GROUPS.social)}
      {renderGroup("Search", CHANNEL_FAMILY_GROUPS.search)}
    </div>
  );
}

// ─── STEP 2: FLIGHTING STRATEGY ─────────────────────────────────────────────────────────────────
// New second step (2026-08-07, same approval as Channel Strategy above — "From there, they should
// decide on whether this is an evergreen campaign/set of campaigns or if this is time-based or maybe
// they have a mix of evergreen and time based"). Purely a stated INTENT for the plan as a whole —
// it doesn't set anything on individual Mapping rows. Each row's actual evergreen/flighted choice
// (and, if flighted, its real start/end dates) still gets set per-row in Mapping's own FlightFields,
// unchanged; "mix" here just means the user expects to use both, which FlightFields already supports
// row-by-row. Persisted as context.flightingStrategy = { type: "evergreen" | "flighted" | "mix" }.
const FLIGHTING_STRATEGY_OPTIONS = [
  { key: "evergreen", label: "Evergreen", desc: "Every campaign in this plan runs continuously, no end date." },
  { key: "flighted", label: "Time-based", desc: "Every campaign in this plan runs on a specific start/end window." },
  { key: "mix", label: "Mix of both", desc: "This plan combines evergreen and time-based campaigns — common for a new or revised account structure." },
];
function FlightingStrategyStep({ context, setContext, canEdit }) {
  const type = context.flightingStrategy?.type || "";
  const setType = (t) => canEdit && setContext({ ...context, flightingStrategy: { ...(context.flightingStrategy || {}), type: t } });
  return (
    <div className="flex flex-col gap-4">
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="flex gap-3 pt-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="text-sm text-muted-foreground">
            <p className="mb-1.5 font-medium text-foreground">What to do on this screen</p>
            <p>
              Set the overall flighting posture for this plan — evergreen, time-based, or a mix of
              both. This is a stated intent, not a hard constraint: each campaign's own evergreen/
              flight-date choice still gets made individually in Mapping, this just sets expectations
              up front (and matters most when picking a budget cadence next).
            </p>
          </div>
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {FLIGHTING_STRATEGY_OPTIONS.map((o) => (
          <Card key={o.key} onClick={() => setType(o.key)}
            className={cn("transition-colors", canEdit && "cursor-pointer", type === o.key ? "border-primary ring-1 ring-primary/40" : "hover:border-primary/30")}>
            <CardHeader className="pb-2">
              <CardTitle className={cn("text-sm", type === o.key && "text-primary")}>{o.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">{o.desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── STEP: CONTEXT ──────────────────────────────────────────────────────────────────────────────

// DEFAULT_SEGMENTS (2026-08-07, per Mo — "we're missing company size segments of SMB, MM and
// Enterprise in this screen"): seeds the new Company Size Segments card below with the same
// three values Taxonomy's fixed "segment" dimension already uses everywhere else in this app (see
// DEFAULT_TAXONOMY_DIMENSIONS in accountPlanning.js), spelled out in full rather than the ENT
// shorthand since this card is a free-text ChipList like Products/Regions/Personas, not the
// enum-constrained taxonomy dimension. Only used as a fallback when a plan hasn't saved its own
// segments list yet — editing/removing a chip persists context.segments like any other field here.
const DEFAULT_SEGMENTS = ["SMB", "MM", "Enterprise"];

// The original DEFAULT_AD_FORMATS/DEFAULT_AD_SET_OBJECTIVES flat-list constants (2026-08-07, per
// Mo — "we need to add a segment for ad format... and ad set objective... in the context tab") were
// removed 2026-08-07 (per Mo — "I think we need to start actually at the channel selection as the
// first part of the campaign builder") in favor of the per-platform versions below, once it became
// clear a single flat list can't hold LinkedIn-only formats (CTV, Spotlight, In Message) alongside
// Google/Meta/Bing formats without every platform seeing every other platform's options.
// context.adFormats/context.objectives (old plans' saved flat data) are LEGACY — never read by
// ContextStep anymore, left as-is on old rows rather than migrated/deleted, matching the same
// "don't carry old data forward as a default, don't delete it either" posture as context.budgets
// (see account-plans.js's schema doc comment).

// DEFAULT_AD_FORMATS_BY_PLATFORM / DEFAULT_AD_SET_OBJECTIVES_BY_PLATFORM (2026-08-07, per Mo's
// approval "let's try it as is" of the channel-first Mapping proposal, which included "Ad Format and
// Ad Set Objective move from one flat list each to per-platform lists on Context"): keyed by the same
// 9 PLATFORM_CODES keys used everywhere else (accountPlanning.js). LinkedIn keeps Mo's original,
// verified values from the DEFAULT_AD_FORMATS/DEFAULT_AD_SET_OBJECTIVES request above unchanged. The
// other 8 platforms are MY best-guess seed data, not confirmed by Mo — flagged here the same way the
// channel-first proposal flagged them, so this comment is the one place to check/correct if any of
// these turn out wrong for how Mo's clients actually run these channels. Like every other seeded
// ChipList default in this file, these are just a starting point a plan can freely trim/extend/replace.
const DEFAULT_AD_FORMATS_BY_PLATFORM = {
  LinkedIn: ["Single Image", "Video", "CTV", "In Message", "Text", "Conversation", "Document", "Spotlight"],
  Meta: ["Single Image", "Video", "Carousel", "Collection", "Stories", "Reels", "Instant Experience"], // best guess, unverified
  Bing: ["Responsive Search Ad", "Expanded Text Ad", "Product (Shopping) Ad", "Audience Ad", "Dynamic Search Ad"], // best guess, unverified
  "Google Search": ["Responsive Search Ad", "Expanded Text Ad", "Call-Only Ad", "Dynamic Search Ad"], // best guess, unverified
  "Google Display": ["Responsive Display Ad", "Image Ad", "HTML5 Ad", "Native Ad"], // best guess, unverified
  "Demand Gen": ["Single Image", "Carousel", "Video"], // best guess, unverified
  "Performance Max": ["Responsive Ad", "Image", "Video", "Text", "Product Feed"], // best guess, unverified
  YouTube: ["Skippable In-Stream", "Non-Skippable In-Stream", "Bumper", "In-Feed Video", "Shorts", "Masthead"], // best guess, unverified
  Reddit: ["Single Image", "Video", "Carousel", "Text Post", "Community Takeover"], // best guess, unverified
  TikTok: ["In-Feed Video", "Spark Ad", "TopView", "Branded Effect", "Collection"], // best guess, unverified
  Capterra: ["Sponsored Listing", "Category Leader", "Display Ad"], // best guess, unverified
};
const DEFAULT_AD_SET_OBJECTIVES_BY_PLATFORM = {
  LinkedIn: ["Conversions", "Brand Awareness", "Website Traffic", "Lead Generation", "Engagement"],
  Meta: ["Conversions", "Brand Awareness", "Traffic", "Engagement", "Leads", "App Promotion", "Sales"], // best guess, unverified
  Bing: ["Website Traffic", "Conversions", "Brand Awareness", "Lead Generation"], // best guess, unverified
  "Google Search": ["Conversions", "Website Traffic", "Leads", "Sales", "Calls"], // best guess, unverified
  "Google Display": ["Brand Awareness", "Website Traffic", "Conversions", "Remarketing"], // best guess, unverified
  "Demand Gen": ["Conversions", "Website Traffic", "Brand Awareness"], // best guess, unverified
  "Performance Max": ["Sales", "Leads", "Website Traffic", "Store Visits"], // best guess, unverified
  YouTube: ["Brand Awareness", "Video Views", "Consideration", "Conversions"], // best guess, unverified
  Reddit: ["Brand Awareness", "Traffic", "Conversions", "Lead Generation", "App Installs"], // best guess, unverified
  TikTok: ["Brand Awareness", "Traffic", "Conversions", "App Installs", "Lead Generation", "Community Interaction"], // best guess, unverified
  Capterra: ["Lead Generation", "Website Traffic"], // best guess, unverified
};

// adFormatOptionsFor / objectiveOptionsFor (2026-08-07): the one shared lookup both ContextStep
// (editing the list) and Mapping's Ad-level nodes (picking FROM the list, per Mo's "let's try it as
// is" approval — "Ad Format/Objective selects at Ad level... sourced from
// context.adFormatsByPlatform[row.platform]/objectivesByPlatform[row.platform]") use to resolve a
// platform's options — a saved plan-level list if one exists, else the seeded
// DEFAULT_*_BY_PLATFORM default, else empty (a platform with no seed data, e.g. a future addition to
// PLATFORM_CODES, just shows no options rather than throwing).
function adFormatOptionsFor(context, platform) {
  const list = (context?.adFormatsByPlatform || {})[platform];
  return list && list.length ? list : (DEFAULT_AD_FORMATS_BY_PLATFORM[platform] || []);
}
function adObjectiveOptionsFor(context, platform) {
  const list = (context?.objectivesByPlatform || {})[platform];
  return list && list.length ? list : (DEFAULT_AD_SET_OBJECTIVES_BY_PLATFORM[platform] || []);
}

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
  const funnelStages = context.funnelStages && context.funnelStages.length ? context.funnelStages : DEFAULT_FUNNEL_STAGES;

  // Ad Format / Ad Set Objective (2026-08-07, per Mo's "let's try it as is" approval — see
  // DEFAULT_AD_FORMATS_BY_PLATFORM's doc comment above): each card now scopes to ONE platform at a
  // time via its own picker, reading/writing context.adFormatsByPlatform[platform] /
  // context.objectivesByPlatform[platform] instead of the old flat context.adFormats/objectives.
  // Defaults to LinkedIn since that's the one platform whose seed values are Mo-verified rather than
  // a best guess.
  const [formatPlatform, setFormatPlatform] = useState("LinkedIn");
  const [objectivePlatform, setObjectivePlatform] = useState("LinkedIn");
  const adFormatsByPlatform = context.adFormatsByPlatform || {};
  const objectivesByPlatform = context.objectivesByPlatform || {};
  const adFormats = adFormatOptionsFor(context, formatPlatform);
  const objectives = adObjectiveOptionsFor(context, objectivePlatform);
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
              Set up the scope for this account plan before moving into Audit. <span className="font-medium text-foreground">Products</span>, <span className="font-medium text-foreground">Regions</span>, <span className="font-medium text-foreground">Audiences / Personas</span>, <span className="font-medium text-foreground">Company Size Segments</span>, and <span className="font-medium text-foreground">Funnel Stage</span> are simple tag lists — type a value and hit Add or Enter, click the × on a chip to remove it. <span className="font-medium text-foreground">Ad Format</span> and <span className="font-medium text-foreground">Ad Set Objective</span> work the same way but are scoped per platform — pick a platform from the dropdown on each card first, then add the formats/objectives you intend to use on that platform, since what's available on LinkedIn (Document, Spotlight, In Message…) doesn't line up with Google or Meta. These describe what this plan intends to use, which is worth keeping distinct from what's actually running today (that's what the Audit step's own Ad Format/Objective columns show, pulled live from the connected accounts). None of this is required to move on to Audit, but the more filled in here, the more useful the later steps will be — Mapping's Ad-level rows will offer the Ad Format/Objective options you set here for that ad's platform. Setting the actual budget — total and per-segment breakdown — happens in its own Budget step, once these fields (and Taxonomy's dimensions) exist to allocate against.
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
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
            <CardTitle>Ad Format</CardTitle>
            <Select value={formatPlatform} onValueChange={setFormatPlatform}>
              <SelectTrigger className="h-7 w-[150px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.keys(PLATFORM_CODES).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            <ChipList items={adFormats} canEdit={canEdit} placeholder="Add an ad format…"
              onAdd={(v) => setContext({ ...context, adFormatsByPlatform: { ...adFormatsByPlatform, [formatPlatform]: [...adFormats, v] } })}
              onRemove={(i) => setContext({ ...context, adFormatsByPlatform: { ...adFormatsByPlatform, [formatPlatform]: adFormats.filter((_, x) => x !== i) } })} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
            <CardTitle>Ad Set Objective</CardTitle>
            <Select value={objectivePlatform} onValueChange={setObjectivePlatform}>
              <SelectTrigger className="h-7 w-[150px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.keys(PLATFORM_CODES).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            <ChipList items={objectives} canEdit={canEdit} placeholder="Add an objective…"
              onAdd={(v) => setContext({ ...context, objectivesByPlatform: { ...objectivesByPlatform, [objectivePlatform]: [...objectives, v] } })}
              onRemove={(i) => setContext({ ...context, objectivesByPlatform: { ...objectivesByPlatform, [objectivePlatform]: objectives.filter((_, x) => x !== i) } })} />
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
const BUDGET_CADENCE_OPTIONS = [
  { key: "monthly", label: "Monthly", desc: "Budget is entered and paced as a recurring monthly figure." },
  { key: "quarterly", label: "Quarterly", desc: "Budget is entered and paced per quarter." },
  { key: "custom", label: "Time-bound", desc: "Budget covers one specific window with its own start/end dates." },
];

function BudgetStep({ taxonomy, setTaxonomy, context, canEdit }) {
  const dimensions = taxonomy.dimensions && taxonomy.dimensions.length ? taxonomy.dimensions : DEFAULT_TAXONOMY_DIMENSIONS;
  const templates = taxonomy.nameTemplates || buildDefaultNameTemplates();
  const family = taxonomy.family || "search";
  const budgetTotal = Number(taxonomy.budgetTotal) || 0;
  const channels = context?.channelStrategy?.channels || [];
  const cadence = taxonomy.budgetCadence || { type: "monthly" };
  const channelBudget = taxonomy.channelBudget || {};
  const setBudgetTotal = (v) => setTaxonomy({ ...taxonomy, dimensions, nameTemplates: templates, family, budgetTotal: v === "" ? "" : Number(v) });
  const updateDim = (key, patch) => setTaxonomy({ ...taxonomy, dimensions: dimensions.map((d) => (d.key === key ? { ...d, ...patch } : d)), nameTemplates: templates, family, budgetTotal: taxonomy.budgetTotal });
  const setCadence = (patch) => setTaxonomy({ ...taxonomy, budgetCadence: { ...cadence, ...patch } });
  const updateChannelBudget = (patch) => setTaxonomy({ ...taxonomy, channelBudget: { ...channelBudget, ...patch } });

  return (
    <div className="flex flex-col gap-5">
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="flex gap-3 pt-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="text-sm text-muted-foreground">
            <p className="mb-1.5 font-medium text-foreground">What to do on this screen</p>
            <p>
              Set the plan's overall budget, pick a <span className="font-medium text-foreground">Cadence</span> for it, then split it two ways: first across the <span className="font-medium text-foreground">channels</span> picked in Channel Strategy, then (optionally) per value of any Taxonomy dimension — segment, region, product, or a custom one — in <span className="font-medium text-foreground">Budget Allocation</span>. Every split shares the same <span className="font-medium text-foreground">$ / %</span> toggle — enter real dollar amounts, or flip to percent and let this page do the math for you (a "Split evenly" shortcut divides 100% across a card's rows in one click). Targets you set here get compared against what's actually mapped once you reach the Mapping step.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle>Budget</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span className="text-lg text-muted-foreground">$</span>
              {canEdit ? (
                <input type="number" value={taxonomy.budgetTotal ?? ""} onChange={(e) => setBudgetTotal(e.target.value)}
                  placeholder="0" className="h-10 w-full max-w-xs border-0 bg-transparent font-display text-2xl font-semibold text-foreground outline-none" />
              ) : (
                <span className="font-display text-2xl font-semibold text-foreground">{fmtFull(budgetTotal)}</span>
              )}
              <span className="text-sm text-muted-foreground">/{cadence.type === "monthly" ? "mo" : cadence.type === "quarterly" ? "qtr" : "window"}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle>Cadence</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {BUDGET_CADENCE_OPTIONS.map((o) => (
                <Badge key={o.key} variant={cadence.type === o.key ? "default" : "outline"}
                  className={cn("select-none", canEdit && "cursor-pointer", cadence.type !== o.key && "opacity-60")}
                  title={o.desc} onClick={() => canEdit && setCadence({ type: o.key })}>
                  {o.label}
                </Badge>
              ))}
            </div>
            {cadence.type === "custom" && (
              <div className="mt-2.5 flex items-center gap-1.5">
                <Input type="date" disabled={!canEdit} value={cadence.startDate || ""} onChange={(e) => setCadence({ startDate: e.target.value })} className="h-8 w-[140px] text-xs" />
                <span className="text-xs text-muted-foreground">to</span>
                <Input type="date" disabled={!canEdit} value={cadence.endDate || ""} onChange={(e) => setCadence({ endDate: e.target.value })} className="h-8 w-[140px] text-xs" />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <SectionLabel>Budget by Channel</SectionLabel>
        {channels.length === 0 ? (
          <div className="text-xs text-muted-foreground">No channels selected yet — pick at least one in Channel Strategy to split budget across channels here.</div>
        ) : (
          <div className="max-w-md">
            <BudgetSplitCard label="Channel" values={channels} budgets={channelBudget.budgets || {}}
              budgetMode={channelBudget.budgetMode} budgetPercents={channelBudget.budgetPercents || {}}
              budgetTotal={budgetTotal} canEdit={canEdit} onUpdate={updateChannelBudget} />
          </div>
        )}
      </div>

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

// BudgetSplitCard (2026-08-07, factored out of BudgetAllocation's per-dimension map body when the
// Budget step gained a second, non-taxonomy split — Channel): the exact same $/%-toggle,
// split-evenly, target-vs-remaining card either caller needs, generalized to take a plain `values`
// list and a `budgets`/`budgetMode`/`budgetPercents` bag instead of a taxonomy dimension object
// directly. BudgetAllocation below (per-dimension split) and BudgetStep's new Channel split both
// render one of these; onUpdate(patch) is however the caller wants to persist the merged patch
// (updateDim(key, patch) for a dimension, a plain setChannelBudget merge for Channel).
function BudgetSplitCard({ label, values, budgets, budgetMode, budgetPercents, budgetTotal, canEdit, onUpdate }) {
  const mode = budgetMode === "percent" ? "percent" : "dollar";
  const percents = budgetPercents || {};
  const total = Object.values(budgets).reduce((s, v) => s + (Number(v) || 0), 0);
  const pctTotal = Object.values(percents).reduce((s, v) => s + (Number(v) || 0), 0);
  const setValueBudget = (value, amount) => onUpdate({ budgets: { ...budgets, [value]: amount } });
  const setValuePercent = (value, pct) => {
    const nextPercents = { ...percents, [value]: pct };
    const dollarAmount = budgetTotal > 0 ? Math.round(budgetTotal * (Number(pct) || 0)) / 100 : "";
    onUpdate({ budgetPercents: nextPercents, budgets: { ...budgets, [value]: dollarAmount } });
  };
  const setMode = (nextMode) => {
    if (nextMode === "percent" && budgetTotal > 0) {
      // Seed percents from whatever dollar amounts already exist, so toggling to % for the
      // first time on an already-filled-in card doesn't blank everything out.
      const seeded = { ...percents };
      values.forEach((v) => { if (seeded[v] == null && budgets[v]) seeded[v] = Math.round((Number(budgets[v]) / budgetTotal) * 1000) / 10; });
      onUpdate({ budgetMode: nextMode, budgetPercents: seeded });
    } else {
      onUpdate({ budgetMode: nextMode });
    }
  };
  // Split evenly (2026-08-07, per Mo's own example — "33.3% in MM, 33.3% in SMB and 33.4%
  // in ENT"): last value absorbs the rounding remainder so the split always sums to exactly
  // 100.0, never 99.9 or 100.1 from naive equal division.
  const splitEvenly = () => {
    const n = values.length;
    if (n === 0) return;
    const even = Math.round((100 / n) * 10) / 10;
    const nextPercents = {};
    values.forEach((v, i) => { nextPercents[v] = i === n - 1 ? Math.round((100 - even * (n - 1)) * 10) / 10 : even; });
    const nextBudgets = { ...budgets };
    values.forEach((v) => { nextBudgets[v] = budgetTotal > 0 ? Math.round(budgetTotal * (nextPercents[v] || 0)) / 100 : ""; });
    onUpdate({ budgetPercents: nextPercents, budgets: nextBudgets });
  };
  const remaining = budgetTotal > 0 ? budgetTotal - total : null;
  const remainingPct = 100 - pctTotal;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-foreground">{label}</span>
          <div className="flex shrink-0 items-center gap-2">
            {total > 0 && (
              <span className="text-xs font-medium text-primary">
                {fmtFull(total)}{budgetTotal > 0 && <span className="font-normal text-muted-foreground"> / {fmtFull(budgetTotal)}</span>}
              </span>
            )}
            {canEdit && (
              <div className="flex items-center gap-0.5 rounded-md border border-border bg-secondary/40 p-0.5">
                <button type="button" onClick={() => setMode("dollar")}
                  className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium transition-all", mode === "dollar" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>$</button>
                <button type="button" onClick={() => setMode("percent")} disabled={!(budgetTotal > 0)}
                  title={budgetTotal > 0 ? "" : "Set your Budget total first"}
                  className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium transition-all", mode === "percent" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground", !(budgetTotal > 0) && "cursor-not-allowed opacity-40")}>%</button>
              </div>
            )}
          </div>
        </div>
        {mode === "percent" && canEdit && (
          <button type="button" onClick={splitEvenly} className="mb-1.5 text-[11px] font-medium text-primary hover:underline">Split evenly</button>
        )}
        <div className="flex flex-col gap-1.5">
          {values.map((v) => (
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
                  placeholder="$" className="h-7 w-28 shrink-0 text-xs" />
              )}
            </div>
          ))}
        </div>
        {mode === "percent" ? (
          <div className={cn("mt-2 border-t border-border/60 pt-1.5 text-[11px]", remainingPct < -PCT_TOLERANCE ? "text-destructive" : remainingPct > PCT_TOLERANCE ? "text-warning" : "text-success")}>
            {pctTotal === 0 ? "0% allocated" : remainingPct < -PCT_TOLERANCE ? `${Math.abs(remainingPct).toFixed(1)}% over 100%` : remainingPct > PCT_TOLERANCE ? `${pctTotal.toFixed(1)}% allocated — ${remainingPct.toFixed(1)}% left` : `100% allocated${budgetTotal > 0 ? ` (${fmtFull(total)})` : ""}`}
          </div>
        ) : (
          remaining != null && total > 0 && (
            <div className={cn("mt-2 border-t border-border/60 pt-1.5 text-[11px]", remaining < 0 ? "text-destructive" : remaining > 0 ? "text-warning" : "text-success")}>
              {remaining < 0 ? `${fmtFull(Math.abs(remaining))} over your Budget` : remaining > 0 ? `${fmtFull(remaining)} of Budget not yet allocated here` : "Fully allocated"}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

function BudgetAllocation({ dimensions, updateDim, canEdit, budgetTotal }) {
  const eligible = dimensions.filter((d) => d.values.length > 0 && d.values.length <= MAX_BUDGET_ALLOCATION_VALUES);
  return (
    <div>
      <SectionLabel>Budget Allocation</SectionLabel>
      <div className="mb-2.5 text-xs text-muted-foreground">
        Optional target $ per value, for any dimension with a manageable value list — compared against actual Mapping budgets on the Mapping step.
        {budgetTotal > 0 && ` Your Budget totals ${fmtFull(budgetTotal)} — each card below shows how its own breakdown compares to that same total.`}
      </div>
      {eligible.length === 0 ? (
        <div className="text-xs text-muted-foreground">Add values to a dimension in Taxonomy (segment, region, product, or a custom one) to set budget targets for it.</div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {eligible.map((d) => (
            <BudgetSplitCard key={d.key} label={d.label} values={d.values} budgets={d.budgets || {}}
              budgetMode={d.budgetMode} budgetPercents={d.budgetPercents || {}} budgetTotal={budgetTotal}
              canEdit={canEdit} onUpdate={(patch) => updateDim(d.key, patch)} />
          ))}
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
// ROW_STATUS_META (2026-08-07, bug fix found while removing Audit — a mapping ROW's status
// (planned/in_progress/live, STATUS_LABELS above) and a PLAN's own status (draft/in_progress/
// complete, STATUS_META near the top of this file) are two different vocabularies that only overlap
// on "in_progress". NodeHeader below was reading row status out of the PLAN's STATUS_META, which has
// no "planned" entry at all — every freshly-created mapping row (status defaults to "planned") would
// have thrown rendering its badge. Split into its own lookup so the two never collide again.
const ROW_STATUS_META = { planned: { badge: "secondary", label: "Planned" }, in_progress: { badge: "warning", label: "In progress" }, live: { badge: "success", label: "Live" } };
const LEVEL_LABELS = { campaign: "Campaign", adgroup: "Ad Group / Ad Set", ad: "Ad" };

// Hoisted out of MappingBuilder (2026-08-06) — the react-hooks/purity lint rule flags Date.now()/
// Math.random() reachable from a component's render body, even when only actually invoked inside an
// event handler; defining the impure part as its own module-level function (not itself a component
// or hook) sidesteps that check entirely, same effect as the existing `manual_${Date.now()}` /
// `custom_${Date.now()}` id patterns elsewhere in this file, just written to satisfy the newer rule.
function newMappingKey() {
  return `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// blankMappingRow (2026-08-07, factored out of the old inline addRow literal when channel locking
// was added) — the one shared shape for a brand-new mapping row, always created WITH its platform
// already set (see channel-first tabs below): there's no longer a path that creates a row with
// platform: "" except pre-existing legacy data saved before this change.
function blankMappingRow(platform, extra) {
  return {
    oldKey: newMappingKey(), oldName: "", oldCampaignGroup: "", platform, level: "campaign", parentKey: "",
    action: "rename", manualName: "", dimValues: {}, status: "planned", targetingProfileId: "", budget: "",
    flightType: "evergreen", startDate: "", endDate: "", adFormat: "", objective: "", ...extra,
  };
}

// Channel-first Mapping (2026-08-07, per Mo — "I think we need to start actually at the channel
// selection as the first part of the campaign builder... nail that down first so we're not going
// back and forth trying to patch", approved as-is): the channel/platform is now chosen ONCE, before
// any campaign structure exists for it, via the tab bar below — not a per-row Select edited after
// the fact (that's what CampaignNode/NodeHeader's old Channel Select and MappingTable's old Channel
// Select both did, and both are now gone). Each tab scopes both Builder and Table views to just that
// channel's rows; a new campaign/ad set/ad created while a tab is active always inherits that tab's
// platform and can never be re-pointed at a different one afterward — "locked after creation" per
// Mo's explicit choice among the 4 options I asked about. Tab order follows PLATFORM_CODES' key
// order (LinkedIn first) rather than creation order, so the bar doesn't reshuffle as channels are
// added. Rows saved before this change with platform: "" (the old blank "Add row"/"Add campaign"
// buttons never required a channel) surface under a fallback "Unspecified" tab rather than being
// hidden — same "don't silently drop old data" posture used throughout this file.
function MappingStep({ mapping, setMapping, taxonomy, targeting, context, canEdit }) {
  const dimensions = taxonomy.dimensions && taxonomy.dimensions.length ? taxonomy.dimensions : DEFAULT_TAXONOMY_DIMENSIONS;
  const templates = taxonomy.nameTemplates || buildDefaultNameTemplates();
  const dimByKey = useMemo(() => Object.fromEntries(dimensions.map((d) => [d.key, d])), [dimensions]);
  const profiles = targeting || [];
  const [view, setView] = useState("builder");

  const rowValues = (row) => ({ platform: channelCode(row.platform) || row.platform || "", ...row.dimValues });
  const rowTemplate = (row) => templates[row.level] || templates.campaign || "";
  const generatedName = (row) => generateName(rowTemplate(row), rowValues(row));
  const finalName = (row) => (row.manualName && row.manualName.trim()) || generatedName(row);

  const channelsPresent = useMemo(() => {
    const present = new Set(mapping.map((r) => r.platform || ""));
    const ordered = Object.keys(PLATFORM_CODES).filter((p) => present.has(p));
    if (present.has("")) ordered.push(""); // legacy rows saved before channel locking
    return ordered;
  }, [mapping]);
  // channelChoices (2026-08-07, per Mo's Channel Strategy step): what's OFFERED for "+Channel"/the
  // empty-state picker is the plan's own channelStrategy.channels selection, not every PLATFORM_CODES
  // platform — the whole point of deciding channels up front is that Mapping shouldn't re-litigate
  // it. Falls back to every platform when channelStrategy is unset (a plan created before this step
  // existed, or one where nothing was picked there yet), same backward-compatible posture as
  // channelsPresent's own "Unspecified" fallback above.
  const plannedChannels = context?.channelStrategy?.channels;
  const channelChoices = plannedChannels && plannedChannels.length
    ? Object.keys(PLATFORM_CODES).filter((p) => plannedChannels.includes(p))
    : Object.keys(PLATFORM_CODES);
  const availableToAdd = channelChoices.filter((p) => !channelsPresent.includes(p));

  // Derived, not effect-synced (2026-08-07) — selectedChannel just remembers the last tab the user
  // clicked; activeChannel falls back to the first available channel whenever that selection isn't
  // (or is no longer, e.g. its last row got deleted) a valid tab. Computing this at render time
  // avoids a setState-in-effect (flagged by this repo's react-hooks/set-state-in-effect lint rule)
  // for what's really just a plain derived value.
  const [selectedChannel, setSelectedChannel] = useState(null);
  const activeChannel = selectedChannel !== null && channelsPresent.includes(selectedChannel) ? selectedChannel : (channelsPresent[0] ?? null);
  const setActiveChannel = setSelectedChannel;

  const addCampaignForChannel = (platform) => {
    setMapping([...mapping, blankMappingRow(platform, {})]);
    setActiveChannel(platform);
  };
  const addRow = () => setMapping([...mapping, blankMappingRow(activeChannel || "", {})]);

  // Budget rollups — grouped from each row's own `budget` (the only place budget is entered, per
  // Mo's call), never a separately-typed number per level, so these can never silently stop adding
  // up. Platform isn't a taxonomy dimension (it's derived from the audit/channel, not something with
  // user-set values), so it stays its own plain actual-only rollup; every taxonomy dimension gets a
  // target-vs-actual comparison instead (computeDimensionBudgetComparison), shown for any dimension
  // that has either a target (set in the Budget step's Budget Allocation) or actual spend against it — see
  // that section's own doc comment for why targets live on the dimension. Rollups stay scoped to the
  // WHOLE plan (all channels), not just the active tab — this card is a plan-level summary, the tabs
  // below it are purely for building/editing structure.
  const rollupsByPlatform = useMemo(() => computeBudgetRollup(mapping, (r) => r.platform), [mapping]);
  // Channel target-vs-actual (2026-08-07, per Mo's Budget-step redesign — "how does the budget map
  // to the channel as a first step"): same DimensionBudgetBlock display dimensionComparisons below
  // already uses, fed by computeChannelBudgetComparison instead (keyed off row.platform, not a
  // taxonomy dimension — see that function's own doc comment in accountPlanning.js). Only shows once
  // a target's actually been set in the Budget step's Budget by Channel card; an empty
  // taxonomy.channelBudget.budgets just yields an empty rows array here, same "shown for any
  // dimension that has either a target or actual spend" rule dimensionComparisons follows.
  const channelComparison = useMemo(
    () => computeChannelBudgetComparison(mapping, taxonomy.channelBudget?.budgets || {}),
    [mapping, taxonomy.channelBudget]
  );
  const dimensionComparisons = useMemo(
    () => dimensions.map((d) => ({ dim: d, rows: computeDimensionBudgetComparison(mapping, d) })).filter((x) => x.rows.length > 0),
    [dimensions, mapping]
  );
  const totalBudget = mapping.reduce((s, r) => s + (Number(r.budget) || 0), 0);
  const asBarList = (rows) => rows.map((r) => ({ name: r.label, value: r.amount }));

  if (mapping.length === 0) {
    return (
      <div>
        <div className="mb-3 text-sm text-muted-foreground">
          No mapping rows yet — pick a channel below to start building a campaign structure from scratch.
          {(!plannedChannels || !plannedChannels.length) && " (Set Channel Strategy first to narrow this list to just the channels this plan covers.)"}
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {channelChoices.map((p) => (
              <button key={p} type="button" onClick={() => addCampaignForChannel(p)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-primary">
                <Plus className="h-3.5 w-3.5" />{p} <span className="text-xs text-muted-foreground">({PLATFORM_CODES[p]})</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, canEdit, context };

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
            {(channelComparison.length > 0 || dimensionComparisons.length > 0) && (
              <div className="grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-2">
                {channelComparison.length > 0 && <DimensionBudgetBlock dim={{ key: "channel", label: "Channel" }} rows={channelComparison} />}
                {dimensionComparisons.map(({ dim, rows }) => <DimensionBudgetBlock key={dim.key} dim={dim} rows={rows} />)}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5 border-b border-border pb-2">
        {channelsPresent.map((p) => (
          <button key={p || "__unspecified__"} type="button" onClick={() => setActiveChannel(p)}
            className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all",
              activeChannel === p ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
            {p ? `${p} (${PLATFORM_CODES[p]})` : "Unspecified"}
          </button>
        ))}
        {canEdit && availableToAdd.length > 0 && (
          <Select value="__add__" onValueChange={(v) => v !== "__add__" && addCampaignForChannel(v)}>
            <SelectTrigger className="h-7 w-[110px] border-dashed text-xs"><SelectValue placeholder="+ Channel" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__add__" disabled>+ Channel</SelectItem>
              {availableToAdd.map((p) => <SelectItem key={p} value={p}>{p} ({PLATFORM_CODES[p]})</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

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
        <MappingBuilder mapping={mapping} setMapping={setMapping} activeChannel={activeChannel} {...helpers} />
      ) : (
        <MappingTable mapping={mapping} setMapping={setMapping} activeChannel={activeChannel} {...helpers} />
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

// ─── MAPPING: TABLE VIEW (original recipe, mostly unchanged behavior) ─────────────────────────────
// Scoped to one channel at a time (2026-08-07, per Mo's channel-first approval) via `activeChannel` —
// rows are filtered here, but updateRow/removeRow still act against the FULL mapping array (by
// oldKey, not array index) so operating on the filtered subset can never desync from the real
// indices of other channels' rows. Channel itself is no longer editable per-row here — it's chosen
// once via MappingStep's tab bar and locked at creation (see MappingStep's own doc comment); the
// Channel Select this view used to have on campaign-level rows is gone, replaced by a plain read-
// only badge.
function MappingTable({ mapping, setMapping, activeChannel, dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit }) {
  const updateRow = (oldKey, patch) => setMapping(mapping.map((r) => (r.oldKey === oldKey ? { ...r, ...patch } : r)));
  const removeRow = (oldKey) => setMapping(mapping.filter((r) => r.oldKey !== oldKey));
  const rows = mapping.filter((r) => (r.platform || "") === (activeChannel || ""));

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row) => {
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
                    <Input value={row.oldName} onChange={(e) => updateRow(row.oldKey, { oldName: e.target.value })} placeholder="Old name (optional)" disabled={!canEdit} className="h-8 w-40 text-xs" />
                  )}
                  {row.oldCampaignGroup && <div className="text-[11px] text-muted-foreground">{row.oldCampaignGroup}</div>}
                </div>

                {row.level === "campaign" && (
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</div>
                    <Badge variant="outline" className="h-8 px-2.5 text-xs font-medium">
                      {row.platform ? `${row.platform} (${PLATFORM_CODES[row.platform] || channelCode(row.platform)})` : "No channel set"}
                    </Badge>
                  </div>
                )}

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Level</div>
                  <Select disabled={!canEdit} value={row.level} onValueChange={(v) => updateRow(row.oldKey, { level: v })}>
                    <SelectTrigger className="h-8 w-[170px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(LEVEL_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                </div>

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action</div>
                  <Select disabled={!canEdit} value={row.action} onValueChange={(v) => updateRow(row.oldKey, { action: v })}>
                    <SelectTrigger className="h-8 w-[132px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(ACTION_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                </div>

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</div>
                  <Select disabled={!canEdit} value={row.status} onValueChange={(v) => updateRow(row.oldKey, { status: v })}>
                    <SelectTrigger className="h-8 w-[132px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(STATUS_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                </div>

                {platformFamily(row.platform) === "social" && (
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Targeting</div>
                    <Select disabled={!canEdit} value={row.targetingProfileId || "__none__"} onValueChange={(v) => updateRow(row.oldKey, { targetingProfileId: v === "__none__" ? "" : v })}>
                      <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {row.level === "ad" && (
                  <>
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ad Format</div>
                      <Select disabled={!canEdit} value={row.adFormat || "__none__"} onValueChange={(v) => updateRow(row.oldKey, { adFormat: v === "__none__" ? "" : v })}>
                        <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Format…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {adFormatOptionsFor(context, row.platform).map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Objective</div>
                      <Select disabled={!canEdit} value={row.objective || "__none__"} onValueChange={(v) => updateRow(row.oldKey, { objective: v === "__none__" ? "" : v })}>
                        <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue placeholder="Objective…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {adObjectiveOptionsFor(context, row.platform).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Budget</div>
                  <Input type="number" disabled={!canEdit} value={row.budget || ""} onChange={(e) => updateRow(row.oldKey, { budget: e.target.value })} placeholder="$/mo" className="h-8 w-24 text-xs" />
                </div>

                {canEdit && (
                  <button type="button" onClick={() => removeRow(row.oldKey)} className="ml-auto self-start border-0 bg-transparent p-1 text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="mt-2.5">
                <FlightFields row={row} onChange={(patch) => updateRow(row.oldKey, patch)} canEdit={canEdit} />
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
                          onChange={(v) => updateRow(row.oldKey, { dimValues: { ...row.dimValues, [tok]: v } })}
                          disabled={!canEdit} placeholder={`${dim.label}…`} className="w-40" />
                      );
                    }
                    return (
                      <Select key={tok} disabled={!canEdit} value={val || "__none__"} onValueChange={(v) => updateRow(row.oldKey, { dimValues: { ...row.dimValues, [tok]: v === "__none__" ? "" : v } })}>
                        <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue placeholder={`${dim.label}…`} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{dim.label}…</SelectItem>
                          {dim.values.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    );
                  }
                  return (
                    <Input key={tok} disabled={!canEdit} value={val} onChange={(e) => updateRow(row.oldKey, { dimValues: { ...row.dimValues, [tok]: e.target.value } })}
                      placeholder={dim ? dim.label : tok} className="h-8 w-32 text-xs" />
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">New</div>
                <Input disabled={!canEdit} value={row.manualName} onChange={(e) => updateRow(row.oldKey, { manualName: e.target.value })}
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
//   - Channel is locked, not a per-row Select (2026-08-07, per Mo's channel-first approval): the
//     whole Builder is scoped to one `activeChannel` at a time (passed down from MappingStep's tab
//     bar), campaigns created here always inherit it, and ad sets/ads always inherit their parent's
//     platform at creation. There is no path to change a row's platform after it's created anymore.
//   - No "drag straight from the Audit step" palette yet — audit groups still get pulled in via the
//     existing "+ Mapping" button on the Audit step (unchanged); the Builder's job here is arranging
//     what's already in `mapping`, not re-implementing that intake step.

function MappingBuilder({ mapping, setMapping, activeChannel, dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit }) {
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const campaigns = useMemo(
    () => mapping.filter((r) => r.level === "campaign" && (r.platform || "") === (activeChannel || "")),
    [mapping, activeChannel]
  );
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
    () => mapping.filter((r) => r.level !== "campaign" && (r.platform || "") === (activeChannel || "") && (!r.parentKey || !validKeys.has(r.parentKey))),
    [mapping, validKeys, activeChannel]
  );

  const updateRow = (oldKey, patch) => setMapping(mapping.map((r) => (r.oldKey === oldKey ? { ...r, ...patch } : r)));
  const removeRow = (oldKey) => setMapping(
    mapping.filter((r) => r.oldKey !== oldKey).map((r) => (r.parentKey === oldKey ? { ...r, parentKey: "" } : r))
  );
  const addCampaign = () => setMapping([...mapping, blankMappingRow(activeChannel || "", {})]);
  const addChild = (parentKey, level, platform) => setMapping([...mapping, blankMappingRow(platform, { level, parentKey })]);

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

  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit, updateRow, removeRow };

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

function CampaignNode({ row, childRows, childrenOf, onAddAdSet, dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit, updateRow, removeRow }) {
  const { setNodeRef, isOver } = useDroppable({ id: `campaign:${row.oldKey}` });
  const family = platformFamily(row.platform);
  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit, updateRow, removeRow };
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

function AdSetNode({ row, childRows, campaignPlatform, dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit, updateRow, removeRow }) {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({ id: row.oldKey });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `adset:${row.oldKey}` });
  const family = platformFamily(row.platform || campaignPlatform);
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30, position: "relative" } : undefined;
  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit, updateRow, removeRow };
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

function AdNode({ row, dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit, updateRow, removeRow }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: row.oldKey });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30, position: "relative" } : undefined;
  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
      <Card className="border-l-4 border-l-muted-foreground/20">
        <CardContent className="p-2.5">
          <NodeHeader row={row} icon={ImageIcon} nodeLabel="ad" dragHandleProps={{ ...attributes, ...listeners }} compact
            dimByKey={dimByKey} profiles={profiles} rowTemplate={rowTemplate} generatedName={generatedName} finalName={finalName}
            context={context} canEdit={canEdit} updateRow={updateRow} removeRow={removeRow} />
        </CardContent>
      </Card>
    </div>
  );
}

function UnassignedZone({ items, childrenOf, dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit, updateRow, removeRow }) {
  const { setNodeRef, isOver } = useDroppable({ id: "unassigned" });
  const helpers = { dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit, updateRow, removeRow };
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
function NodeHeader({ row, icon: Icon, nodeLabel, dimByKey, profiles, rowTemplate, generatedName, finalName, context, canEdit, updateRow, removeRow, dragHandleProps, showPlatform, compact }) {
  const [expanded, setExpanded] = useState(false);
  const template = rowTemplate(row);
  const tokens = templateTokens(template).filter((t) => t !== "platform");
  const validation = validateName(finalName(row), template);
  const statusMeta = ROW_STATUS_META[row.status] || ROW_STATUS_META.planned;
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
              <Badge variant="outline" className="h-6 px-2 text-xs font-medium">
                {row.platform ? `${row.platform} (${PLATFORM_CODES[row.platform] || channelCode(row.platform)})` : "No channel set"}
              </Badge>
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
            {platformFamily(row.platform) === "social" && (
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
            )}
            {row.level === "ad" && (
              <>
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Ad Format</div>
                  <Select disabled={!canEdit} value={row.adFormat || "__none__"} onValueChange={(v) => updateRow(row.oldKey, { adFormat: v === "__none__" ? "" : v })}>
                    <SelectTrigger className="h-7 w-[130px] text-xs"><SelectValue placeholder="Format…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {adFormatOptionsFor(context, row.platform).map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Objective</div>
                  <Select disabled={!canEdit} value={row.objective || "__none__"} onValueChange={(v) => updateRow(row.oldKey, { objective: v === "__none__" ? "" : v })}>
                    <SelectTrigger className="h-7 w-[140px] text-xs"><SelectValue placeholder="Objective…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {adObjectiveOptionsFor(context, row.platform).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
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

export default function AccountPlanning({ session, workspace, canEdit, sidebarEl }) {
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
          {activeStep === "channelStrategy" && <ChannelStrategyStep context={plan.context || {}} setContext={(v) => setStepField("context", v)} canEdit={canEdit} />}
          {activeStep === "flightingStrategy" && <FlightingStrategyStep context={plan.context || {}} setContext={(v) => setStepField("context", v)} canEdit={canEdit} />}
          {activeStep === "context" && <ContextStep context={plan.context || {}} setContext={(v) => setStepField("context", v)} canEdit={canEdit} />}
          {activeStep === "taxonomy" && <TaxonomyStep taxonomy={plan.taxonomy || {}} setTaxonomy={(v) => setStepField("taxonomy", v)} context={plan.context || {}} canEdit={canEdit} />}
          {activeStep === "budget" && <BudgetStep taxonomy={plan.taxonomy || {}} setTaxonomy={(v) => setStepField("taxonomy", v)} context={plan.context || {}} canEdit={canEdit} />}
          {activeStep === "targeting" && (
            <TargetingStep session={session} workspace={workspace} taxonomy={plan.taxonomy || {}} targeting={plan.targeting || []} setTargeting={(v) => setStepField("targeting", v)} canEdit={canEdit} />
          )}
          {activeStep === "mapping" && (
            <MappingStep mapping={plan.mapping || []} setMapping={(v) => setStepField("mapping", v)} taxonomy={plan.taxonomy || {}} targeting={plan.targeting || []} context={plan.context || {}} canEdit={canEdit} />
          )}
        </StepErrorBoundary>
      </div>
    </div>
  );
}
