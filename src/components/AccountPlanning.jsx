import { useEffect, useMemo, useState } from "react";
import {
  listAccountPlans, getAccountPlan, createAccountPlan, updateAccountPlan, deleteAccountPlan,
} from "../lib/accountPlanningApi.js";
import {
  listTargetingLibraryItems, createTargetingLibraryItem, deleteTargetingLibraryItem,
} from "../lib/targetingLibraryApi.js";
import { listReportingFacts } from "../lib/reportingApi.js";
import {
  buildAuditGroups, scoreAuditGroups, levelLabel, computeBudgetRollup,
  DEFAULT_TAXONOMY_DIMENSIONS, buildDefaultNameTemplates, generateName, validateName, templateTokens,
} from "../lib/accountPlanning.js";
import { fmtFull } from "../lib/core.js";
import { DonutChart, BarList } from "@tremor/react";
import {
  Plus, Trash2, ChevronLeft, Compass, Search, Tags, Target as TargetIcon, ListChecks, X, Moon, Sun,
  Users, Ban, Repeat,
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
// A "plan" is a resumable project (list view below) that walks five steps:
//   1. Context    — products/regions/personas + budgets, free-form inputs that seed step 3.
//   2. Audit      — "what's working" now, computed LIVE every time (see accountPlanning.js's own
//                   doc comment for why numbers are never frozen), with a persisted decision layer.
//   3. Taxonomy   — target naming convention across Campaign/Ad Group(Set)/Ad, generated live.
//   4. Targeting  — shared library (lists/exclusions/remarketing) + reusable Targeting Profiles.
//   5. Mapping    — old campaign/ad -> new generated name, the actual execution checklist.
//
// mergedNormRows/combineGoogleChannels come from PaidHQ.jsx's central workspace-data load, same
// props DataAudit.jsx receives — reporting_facts isn't part of that central load, so this component
// fetches it independently, same pattern DataAudit.jsx's own reportingFacts effect uses.

const STEPS = [
  { key: "context", label: "Context", Icon: TargetIcon },
  { key: "audit", label: "Audit", Icon: Search },
  { key: "taxonomy", label: "Taxonomy", Icon: Tags },
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

function ContextStep({ context, setContext, canEdit }) {
  const products = context.products || [];
  const regions = context.regions || [];
  const personas = context.personas || [];
  const budgets = context.budgets || [];
  const [bLabel, setBLabel] = useState(""); const [bAmount, setBAmount] = useState("");
  const addBudget = () => { const l = bLabel.trim(); const a = Number(bAmount); if (!l || !a) return; setContext({ ...context, budgets: [...budgets, { label: l, amount: a }] }); setBLabel(""); setBAmount(""); };
  return (
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
        <CardHeader className="pb-2"><CardTitle>Budgets</CardTitle></CardHeader>
        <CardContent>
          <div className={cn("flex flex-col gap-1.5", canEdit ? "mb-2" : "")}>
            {budgets.map((b, i) => (
              <div key={i} className="flex items-center gap-2.5 rounded-md bg-secondary px-3 py-2 text-sm">
                <span className="flex-1 text-foreground">{b.label}</span>
                <span className="font-semibold text-foreground">{fmtFull(b.amount)}</span>
                {canEdit && <X className="h-3.5 w-3.5 cursor-pointer opacity-60 hover:opacity-100" onClick={() => setContext({ ...context, budgets: budgets.filter((_, x) => x !== i) })} />}
              </div>
            ))}
            {budgets.length === 0 && <span className="text-xs text-muted-foreground">None yet</span>}
          </div>
          {canEdit && (
            <div className="flex gap-1.5">
              <Input value={bLabel} onChange={(e) => setBLabel(e.target.value)} placeholder="e.g. Insight — Q4" className="h-8 flex-1 text-xs" />
              <Input value={bAmount} onChange={(e) => setBAmount(e.target.value)} placeholder="Amount" type="number" className="h-8 w-28 text-xs" />
              <Button size="sm" variant="secondary" className="h-8" onClick={addBudget}>Add</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── STEP 2: AUDIT ──────────────────────────────────────────────────────────────────────────────

function AuditStep({ session, workspace, mergedNormRows, combineGoogleChannels, auditDecisions, setAuditDecisions, mapping, setMapping, canEdit }) {
  const [reportingFacts, setReportingFacts] = useState(null);
  const [minSpend, setMinSpend] = useState(100);
  const [tierFilter, setTierFilter] = useState("all");
  useEffect(() => {
    if (!workspace?.id || !session) return;
    listReportingFacts(session, workspace.id).then(setReportingFacts).catch(() => setReportingFacts([]));
  }, [session, workspace?.id]);

  const groups = useMemo(() => {
    if (reportingFacts === null) return [];
    const built = buildAuditGroups({ mergedNormRows: mergedNormRows || [], reportingFacts, combineGoogleChannels });
    return scoreAuditGroups(built, { minSpend: Number(minSpend) || 0 });
  }, [mergedNormRows, reportingFacts, combineGoogleChannels, minSpend]);

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

  const visible = tierFilter === "all" ? groups : groups.filter((g) => g.tier === tierFilter);

  const addToMapping = (g) => {
    if (mapping.some((m) => m.oldKey === g.key)) return;
    setMapping([...mapping, {
      oldKey: g.key, oldName: g.level === "ad" ? (g.adLabel || g.campaignName) : g.campaignName,
      oldCampaignGroup: g.campaignGroupName, platform: g.platform,
      level: g.level === "ad" ? "ad" : "campaign", action: g.tier === "consolidate" ? "kill" : "rename",
      manualName: "", dimValues: {}, status: "planned",
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

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Min spend to score</span>
          <Input type="number" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} className="h-8 w-24 text-xs" />
        </div>
        <div className="flex flex-wrap gap-1.5">
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
              <TableHead>Campaign / Ad</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Spend</TableHead>
              <TableHead>Signal</TableHead>
              <TableHead>Cost/unit</TableHead>
              <TableHead>Decision</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.slice(0, 250).map((g) => {
              const dec = auditDecisions[g.key] || {};
              const inMapping = mapping.some((m) => m.oldKey === g.key);
              return (
                <TableRow key={g.key}>
                  <TableCell className="max-w-[220px]">
                    <div className="truncate text-sm font-medium text-foreground">{g.level === "ad" ? (g.adLabel || g.campaignName) : g.campaignName}</div>
                    {g.level === "ad" && <div className="truncate text-xs text-muted-foreground">{g.campaignName}</div>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{g.platform}</TableCell>
                  <TableCell className="text-sm">{fmtFull(g.spend)}</TableCell>
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
            exampleValues.platform = family === "social" ? "LinkedIn" : "Google Search";
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
      </div>
    </div>
  );
}

// ─── STEP 4: TARGETING ──────────────────────────────────────────────────────────────────────────
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
    titles: [], functions: [], seniorities: [], companySizes: [], industries: [],
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
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Company Size</div>
                    <MultiToggle options={companySizeValues} selected={p.companySizes} canEdit={canEdit} onChange={(v) => updateProfile(p.id, { companySizes: v })} />
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Industry</div>
                    <MultiToggle options={industryValues} selected={p.industries} canEdit={canEdit} onChange={(v) => updateProfile(p.id, { industries: v })} />
                  </div>
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

// ─── STEP 5: MAPPING ────────────────────────────────────────────────────────────────────────────

function MappingStep({ mapping, setMapping, taxonomy, targeting, canEdit }) {
  const dimensions = taxonomy.dimensions && taxonomy.dimensions.length ? taxonomy.dimensions : DEFAULT_TAXONOMY_DIMENSIONS;
  const templates = taxonomy.nameTemplates || buildDefaultNameTemplates();
  const dimByKey = useMemo(() => Object.fromEntries(dimensions.map((d) => [d.key, d])), [dimensions]);
  const profiles = targeting || [];

  const updateRow = (i, patch) => setMapping(mapping.map((r, x) => (x === i ? { ...r, ...patch } : r)));
  const removeRow = (i) => setMapping(mapping.filter((_, x) => x !== i));
  const addRow = () => setMapping([...mapping, { oldKey: `manual_${Date.now()}`, oldName: "", oldCampaignGroup: "", platform: "", level: "campaign", action: "rename", manualName: "", dimValues: {}, status: "planned", targetingProfileId: "", budget: "" }]);

  const rowValues = (row) => ({ platform: row.platform || "", ...row.dimValues });
  const rowTemplate = (row) => templates[row.level] || templates.campaign || "";
  const generatedName = (row) => generateName(rowTemplate(row), rowValues(row));
  const finalName = (row) => (row.manualName && row.manualName.trim()) || generatedName(row);

  const ACTION_LABELS = { rename: "Rename", split: "Split", merge: "Merge into", kill: "Kill", keep: "Keep as-is" };
  const STATUS_LABELS = { planned: "Planned", in_progress: "In progress", live: "Live" };
  const LEVEL_LABELS = { campaign: "Campaign", adgroup: "Ad Group / Ad Set", ad: "Ad" };

  // Budget rollups — grouped from each row's own `budget` (the only place budget is entered, per
  // Mo's call), never a separately-typed number per level, so these can never silently stop adding
  // up.
  const rollupsByProduct = useMemo(() => computeBudgetRollup(mapping, (r) => r.dimValues?.product), [mapping]);
  const rollupsBySegment = useMemo(() => computeBudgetRollup(mapping, (r) => r.dimValues?.segment), [mapping]);
  const rollupsByPlatform = useMemo(() => computeBudgetRollup(mapping, (r) => r.platform), [mapping]);
  const totalBudget = mapping.reduce((s, r) => s + (Number(r.budget) || 0), 0);
  const asBarList = (rows) => rows.map((r) => ({ name: r.label, value: r.amount }));

  if (mapping.length === 0) {
    return (
      <div>
        <div className="mb-3 text-sm text-muted-foreground">No mapping rows yet — add campaigns/ads from the Audit step, or add a row manually for something entirely new.</div>
        {canEdit && <Button variant="secondary" onClick={addRow}><Plus className="h-4 w-4" />Add row</Button>}
      </div>
    );
  }

  return (
    <div>
      {totalBudget > 0 && (
        <Card className="mb-4">
          <CardHeader className="pb-2"><CardTitle>Budget rollup</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total</div>
                <div className="font-display text-2xl font-bold text-primary">{fmtFull(totalBudget)}</div>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By product</div>
                {rollupsByProduct.length ? <BarList data={asBarList(rollupsByProduct)} valueFormatter={fmtFull} className="text-xs" /> : <span className="text-xs text-muted-foreground">—</span>}
              </div>
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By segment</div>
                {rollupsBySegment.length ? <BarList data={asBarList(rollupsBySegment)} valueFormatter={fmtFull} className="text-xs" /> : <span className="text-xs text-muted-foreground">—</span>}
              </div>
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By platform</div>
                {rollupsByPlatform.length ? <BarList data={asBarList(rollupsByPlatform)} valueFormatter={fmtFull} className="text-xs" /> : <span className="text-xs text-muted-foreground">—</span>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {canEdit && <div className="mb-3"><Button size="sm" variant="secondary" onClick={addRow}><Plus className="h-3.5 w-3.5" />Add row</Button></div>}
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

                <Separator className="my-3" />

                <div className="mb-2 flex flex-wrap gap-1.5">
                  {tokens.map((tok) => {
                    const dim = dimByKey[tok];
                    const val = row.dimValues?.[tok] || "";
                    if (dim && dim.values.length > 0) {
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
    </div>
  );
}

// ─── MAIN ───────────────────────────────────────────────────────────────────────────────────────

export default function AccountPlanning({ session, workspace, mergedNormRows, combineGoogleChannels = {}, canEdit }) {
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

  return (
    <div className="flex-1 overflow-auto bg-muted p-6 sm:p-10">
      <div className="mx-auto max-w-5xl">
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

        <div className="flex flex-col items-start gap-5 lg:flex-row">
          <div className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto lg:w-[190px] lg:flex-col lg:overflow-visible">
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
          </div>

          <div key={activeStep} className="min-w-0 flex-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
            {activeStep === "context" && <ContextStep context={plan.context || {}} setContext={(v) => setStepField("context", v)} canEdit={canEdit} />}
            {activeStep === "audit" && (
              <AuditStep session={session} workspace={workspace} mergedNormRows={mergedNormRows} combineGoogleChannels={combineGoogleChannels}
                auditDecisions={plan.auditDecisions || {}} setAuditDecisions={(v) => setStepField("auditDecisions", v)}
                mapping={plan.mapping || []} setMapping={(v) => setStepField("mapping", v)} canEdit={canEdit} />
            )}
            {activeStep === "taxonomy" && <TaxonomyStep taxonomy={plan.taxonomy || {}} setTaxonomy={(v) => setStepField("taxonomy", v)} context={plan.context || {}} canEdit={canEdit} />}
            {activeStep === "targeting" && (
              <TargetingStep session={session} workspace={workspace} taxonomy={plan.taxonomy || {}} targeting={plan.targeting || []} setTargeting={(v) => setStepField("targeting", v)} canEdit={canEdit} />
            )}
            {activeStep === "mapping" && (
              <MappingStep mapping={plan.mapping || []} setMapping={(v) => setStepField("mapping", v)} taxonomy={plan.taxonomy || {}} targeting={plan.targeting || []} canEdit={canEdit} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
