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
import { Icon, PixelPanel, DashStatTile, Pill, SectionLabel, Breadcrumb, Btn } from "./shared.jsx";

// src/components/AccountPlanning.jsx — Account Planning (2026-08-06, per Mo — "I need a way of
// figuring out how to restructure and rebuild an account that already has existing ads and
// campaigns... looking at what's working and then porting that over to a new structure that
// follows best practices... world class, bespoke, purpose-built for performance." Confirmed via
// AskUserQuestion: audit + taxonomy designer (names, not full UTMs for MVP — "Campaign, Ad set/Ad
// group and Ad naming") + old->new mapping, as a named step-by-step project, MVP scope with
// before/after comparison deferred to a later phase.
//
// A "plan" is a resumable project (list view below, Vault-list pattern) that walks four steps:
//   1. Context   — products/regions/personas + budgets, free-form inputs that seed step 3.
//   2. Audit     — "what's working" now, computed LIVE every time (see accountPlanning.js's own
//                  doc comment for why numbers are never frozen), with a persisted decision layer.
//   3. Taxonomy  — target naming convention across Campaign/Ad Group(Set)/Ad, generated live.
//   4. Mapping   — old campaign/ad -> new generated name, the actual execution checklist.
//
// mergedNormRows/combineGoogleChannels/tagDims come from PaidHQ.jsx's central workspace-data load,
// same props DataAudit.jsx already receives — reporting_facts isn't part of that central load, so
// this component fetches it independently, same pattern DataAudit.jsx's own reportingFacts effect
// uses.

function isMobilePad() { return typeof window !== "undefined" && window.innerWidth < 640; }

const inputStyle = (T) => ({
  background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: T.r6, color: T.text,
  padding: "6px 9px", fontSize: 12 * (T.fsScale || 1), fontFamily: T.font, outline: "none",
});
const selectStyle = (T) => ({ ...inputStyle(T), cursor: "pointer" });

const STEPS = [
  { key: "context", label: "Context", icon: "target" },
  { key: "audit", label: "Audit", icon: "search" },
  { key: "taxonomy", label: "Taxonomy", icon: "tag" },
  { key: "targeting", label: "Targeting", icon: "compass" },
  { key: "mapping", label: "Mapping", icon: "history" },
];

const TIER_COLORS = (T) => ({
  keep: { color: T.success, bg: T.successBg, border: T.successBorder, label: "Keep" },
  review: { color: T.warning, bg: T.warningBg, border: T.warningBorder, label: "Review" },
  consolidate: { color: T.danger, bg: T.dangerBg, border: T.dangerBorder, label: "Consolidate/Kill" },
  "insufficient-data": { color: T.textMuted, bg: T.surfaceHover, border: T.border, label: "Insufficient data" },
});
const SIGNAL_LABELS = {
  pipeline: "Pipeline/funnel",
  "platform-conversions": "Platform conversions",
  "platform-engagement": "Platform (CPC)",
  "insufficient-volume": "Not enough spend",
};

// ─── SMALL SHARED PIECES ───────────────────────────────────────────────────────────────────────

function ChipList({ T, items, onAdd, onRemove, placeholder, canEdit }) {
  const [val, setVal] = useState("");
  const add = () => { const v = val.trim(); if (!v || items.includes(v)) { setVal(""); return; } onAdd(v); setVal(""); };
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: canEdit ? 8 : 0 }}>
        {items.map((it, i) => (
          <Pill key={i} color={T.text} bg={T.surfaceHover} border={T.border}>
            {it}
            {canEdit && <span onClick={() => onRemove(i)} style={{ cursor: "pointer", opacity: 0.55, marginLeft: 6, fontWeight: 700 }}>×</span>}
          </Pill>
        ))}
        {items.length === 0 && <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>None yet</span>}
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 6 }}>
          <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            placeholder={placeholder} style={{ ...inputStyle(T), flex: 1 }} />
          <Btn T={T} size="sm" variant="subtle" onClick={add}>Add</Btn>
        </div>
      )}
    </div>
  );
}

function SavedIndicator({ T, saving, savedAt }) {
  if (saving) return <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Saving…</span>;
  if (savedAt) return <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Saved</span>;
  return null;
}

// ─── LIST VIEW ──────────────────────────────────────────────────────────────────────────────────

function PlanList({ T, plans, loading, canEdit, onOpen, onCreate, onDelete }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const submit = () => { const n = name.trim(); if (!n) return; onCreate(n); setName(""); setCreating(false); };
  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        {T.wideLayout && <Breadcrumb T={T} items={["Home", "Account Planning"]} />}
        <h2 style={{ fontSize: T.wideLayout ? 36 : 20 * (T.fsScale || 1), fontWeight: T.wideLayout ? 600 : 700, color: T.text, letterSpacing: "-0.3px", marginBottom: 4, fontFamily: T.font }}>Account Planning</h2>
        <p style={{ fontSize: 13 * (T.fsScale || 1), color: T.textSub, fontFamily: T.font, maxWidth: 640 }}>
          Audit what's working in an existing account, design a purpose-built taxonomy, and map the old structure onto the new one — one project per rebuild, saved and resumable.
        </p>
      </div>

      {canEdit && (
        <div style={{ marginBottom: 18 }}>
          {!creating ? (
            <Btn T={T} variant="primary" onClick={() => setCreating(true)}><Icon name="plus" size={13} color={T.onAccent} style={{ marginRight: 6 }} />New plan</Btn>
          ) : (
            <PixelPanel T={T} contentStyle={{ padding: 12, display: "flex", gap: 8 }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setCreating(false); }}
                placeholder="e.g. Q4 InsightSoftware Rebuild" style={{ ...inputStyle(T), flex: 1 }} />
              <Btn T={T} variant="primary" onClick={submit}>Create</Btn>
              <Btn T={T} variant="ghost" onClick={() => { setCreating(false); setName(""); }}>Cancel</Btn>
            </PixelPanel>
          )}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Loading…</div>
      ) : plans.length === 0 ? (
        <PixelPanel T={T} contentStyle={{ padding: 28, textAlign: "center" }}>
          <div style={{ fontSize: 14 * (T.fsScale || 1), fontWeight: 700, color: T.text, marginBottom: 6, fontFamily: T.font }}>No plans yet</div>
          <div style={{ fontSize: 12.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Start a new plan to audit an account and design its rebuild.</div>
        </PixelPanel>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {plans.map((p) => {
            const statusPill = { draft: { c: T.textMuted, bg: T.surfaceHover, b: T.border, l: "Draft" }, in_progress: { c: T.warning, bg: T.warningBg, b: T.warningBorder, l: "In progress" }, complete: { c: T.success, bg: T.successBg, b: T.successBorder, l: "Complete" } }[p.status || "draft"];
            return (
              <PixelPanel key={p.id} T={T} onClick={() => onOpen(p.id)} contentStyle={{ padding: "13px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5 * (T.fsScale || 1), fontWeight: 700, color: T.text, fontFamily: T.font, marginBottom: 2 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Updated {new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · Step: {STEPS.find((s) => s.key === p.activeStep)?.label || "Context"}</div>
                </div>
                <Pill color={statusPill.c} bg={statusPill.bg} border={statusPill.b}>{statusPill.l}</Pill>
                {canEdit && (
                  <button onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${p.name}"? This can't be undone.`)) onDelete(p.id); }}
                    style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
                    <Icon name="trash" size={14} color={T.textMuted} />
                  </button>
                )}
              </PixelPanel>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── STEP 1: CONTEXT ────────────────────────────────────────────────────────────────────────────

function ContextStep({ T, context, setContext, canEdit }) {
  const products = context.products || [];
  const regions = context.regions || [];
  const personas = context.personas || [];
  const budgets = context.budgets || [];
  const [bLabel, setBLabel] = useState(""); const [bAmount, setBAmount] = useState("");
  const addBudget = () => { const l = bLabel.trim(); const a = Number(bAmount); if (!l || !a) return; setContext({ ...context, budgets: [...budgets, { label: l, amount: a }] }); setBLabel(""); setBAmount(""); };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <SectionLabel T={T}>Products</SectionLabel>
        <ChipList T={T} items={products} canEdit={canEdit} placeholder="Add a product…"
          onAdd={(v) => setContext({ ...context, products: [...products, v] })}
          onRemove={(i) => setContext({ ...context, products: products.filter((_, x) => x !== i) })} />
      </div>
      <div>
        <SectionLabel T={T}>Regions</SectionLabel>
        <ChipList T={T} items={regions} canEdit={canEdit} placeholder="Add a region…"
          onAdd={(v) => setContext({ ...context, regions: [...regions, v] })}
          onRemove={(i) => setContext({ ...context, regions: regions.filter((_, x) => x !== i) })} />
      </div>
      <div>
        <SectionLabel T={T}>Audiences / Personas</SectionLabel>
        <ChipList T={T} items={personas} canEdit={canEdit} placeholder="Add an audience or persona…"
          onAdd={(v) => setContext({ ...context, personas: [...personas, v] })}
          onRemove={(i) => setContext({ ...context, personas: personas.filter((_, x) => x !== i) })} />
      </div>
      <div>
        <SectionLabel T={T}>Budgets</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: canEdit ? 8 : 0 }}>
          {budgets.map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: T.surfaceHover, borderRadius: T.r8, fontSize: 12.5 * (T.fsScale || 1), fontFamily: T.font }}>
              <span style={{ flex: 1, color: T.text }}>{b.label}</span>
              <span style={{ fontWeight: 700, color: T.text }}>{fmtFull(b.amount)}</span>
              {canEdit && <span onClick={() => setContext({ ...context, budgets: budgets.filter((_, x) => x !== i) })} style={{ cursor: "pointer", opacity: 0.55, fontWeight: 700 }}>×</span>}
            </div>
          ))}
          {budgets.length === 0 && <span style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>None yet</span>}
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 6 }}>
            <input value={bLabel} onChange={(e) => setBLabel(e.target.value)} placeholder="e.g. Insight — Q4" style={{ ...inputStyle(T), flex: 1 }} />
            <input value={bAmount} onChange={(e) => setBAmount(e.target.value)} placeholder="Amount" type="number" style={{ ...inputStyle(T), width: 120 }} />
            <Btn T={T} size="sm" variant="subtle" onClick={addBudget}>Add</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── STEP 2: AUDIT ──────────────────────────────────────────────────────────────────────────────

function AuditStep({ T, session, workspace, mergedNormRows, combineGoogleChannels, auditDecisions, setAuditDecisions, mapping, setMapping, canEdit }) {
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

  const visible = tierFilter === "all" ? groups : groups.filter((g) => g.tier === tierFilter);
  const tierColors = TIER_COLORS(T);

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

  if (reportingFacts === null) return <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Loading account data…</div>;
  if (groups.length === 0) return <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>No spend data to audit yet — bring in data via Data Sources first.</div>;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, marginBottom: 16 }}>
        <DashStatTile T={T} label="In scope" value={fmtFull(counts.totalSpend)} variant="accent" />
        <DashStatTile T={T} label="Keep" value={counts.keep} valueColor={T.success} />
        <DashStatTile T={T} label="Review" value={counts.review} valueColor={T.warning} />
        <DashStatTile T={T} label="Consolidate/Kill" value={counts.consolidate} valueColor={T.danger} />
        <DashStatTile T={T} label="Insufficient data" value={counts["insufficient-data"]} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Min spend to score</span>
          <input type="number" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} style={{ ...inputStyle(T), width: 90 }} />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["all", "keep", "review", "consolidate", "insufficient-data"].map((t) => (
            <Pill key={t} onClick={() => setTierFilter(t)} style={{ cursor: "pointer", opacity: tierFilter === t ? 1 : 0.55 }}
              color={t === "all" ? T.text : tierColors[t].color} bg={t === "all" ? T.surfaceHover : tierColors[t].bg} border={t === "all" ? T.border : tierColors[t].border}>
              {t === "all" ? "All" : tierColors[t].label} {t !== "all" && `(${counts[t] || 0})`}
            </Pill>
          ))}
        </div>
      </div>

      <div style={{ border: `1px solid ${T.border}`, borderRadius: T.r10, overflow: "hidden" }}>
        <div style={{ display: isMobilePad() ? undefined : "grid", gridTemplateColumns: isMobilePad() ? undefined : "1.7fr 0.9fr 0.9fr 1.1fr 0.8fr 1.3fr 0.6fr", gap: 8, padding: "8px 14px", background: T.headerBg, borderBottom: `1px solid ${T.border}`, fontSize: 10 * (T.fsScale || 1), fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.textMuted }}>
          <div>Campaign / Ad</div><div>Platform</div><div>Spend</div><div>Signal</div><div>Cost/unit</div><div>Decision</div><div></div>
        </div>
        {visible.slice(0, 250).map((g) => {
          const dec = auditDecisions[g.key] || {};
          const tc = tierColors[g.tier];
          return (
            <div key={g.key} style={{ display: isMobilePad() ? "flex" : "grid", flexDirection: isMobilePad() ? "column" : undefined, gridTemplateColumns: isMobilePad() ? undefined : "1.7fr 0.9fr 0.9fr 1.1fr 0.8fr 1.3fr 0.6fr", gap: 8, padding: "10px 14px", borderTop: `1px solid ${T.border}`, fontSize: 12 * (T.fsScale || 1), color: T.text, alignItems: "center", fontFamily: T.font }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.level === "ad" ? (g.adLabel || g.campaignName) : g.campaignName}</div>
                {g.level === "ad" && <div style={{ fontSize: 10.5 * (T.fsScale || 1), color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.campaignName}</div>}
              </div>
              <div style={{ color: T.textSub }}>{g.platform}</div>
              <div>{fmtFull(g.spend)}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textSub }}>{SIGNAL_LABELS[g.signalType]}</span>
                {g.primaryMetricKey && <span style={{ fontSize: 10 * (T.fsScale || 1), color: T.textMuted }}>{g.primaryMetricKey}</span>}
              </div>
              <div>{g.costPerUnit != null ? `$${g.costPerUnit.toFixed(2)}` : "—"}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Pill color={tc.color} bg={tc.bg} border={tc.border}>{tc.label}</Pill>
                {canEdit && (
                  <select value={dec.decision || ""} onChange={(e) => setDecision(g.key, { decision: e.target.value })} style={{ ...selectStyle(T), fontSize: 10.5 * (T.fsScale || 1), padding: "3px 5px" }}>
                    <option value="">Use tier</option>
                    <option value="keep">Keep</option>
                    <option value="consolidate">Consolidate</option>
                    <option value="kill">Kill</option>
                  </select>
                )}
              </div>
              <div>
                {canEdit && (
                  <button onClick={() => addToMapping(g)} disabled={mapping.some((m) => m.oldKey === g.key)}
                    style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.r6, cursor: mapping.some((m) => m.oldKey === g.key) ? "default" : "pointer", padding: "4px 8px", fontSize: 10.5 * (T.fsScale || 1), color: mapping.some((m) => m.oldKey === g.key) ? T.textMuted : T.text, fontFamily: T.font }}>
                    {mapping.some((m) => m.oldKey === g.key) ? "In mapping" : "+ Mapping"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {visible.length > 250 && <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font, marginTop: 8 }}>Showing first 250 of {visible.length} — narrow the filter above to see more.</div>}
    </div>
  );
}

// ─── STEP 3: TAXONOMY ───────────────────────────────────────────────────────────────────────────

function TaxonomyStep({ T, taxonomy, setTaxonomy, context, canEdit }) {
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
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <SectionLabel T={T} style={{ marginBottom: 0 }}>Dimensions</SectionLabel>
          {canEdit && <Btn T={T} size="sm" variant="subtle" onClick={addDimension}><Icon name="plus" size={11} color={T.text} style={{ marginRight: 4 }} />Add dimension</Btn>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {dimensions.map((d) => (
            <PixelPanel key={d.key} T={T} contentStyle={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                {canEdit ? (
                  <input value={d.label} onChange={(e) => updateDim(d.key, { label: e.target.value })} style={{ ...inputStyle(T), fontWeight: 700, flex: 1, maxWidth: 220 }} />
                ) : (
                  <span style={{ fontWeight: 700, fontFamily: T.font, color: T.text }}>{d.label}</span>
                )}
                <code style={{ fontSize: 10.5 * (T.fsScale || 1), color: T.textMuted, background: T.surfaceHover, padding: "2px 6px", borderRadius: T.r6 }}>{`{${d.key}}`}</code>
                {canEdit && d.key.startsWith("custom_") && (
                  <span onClick={() => removeDimension(d.key)} style={{ cursor: "pointer", color: T.textMuted, marginLeft: "auto", fontWeight: 700 }}>×</span>
                )}
              </div>
              <ChipList T={T} items={d.values} canEdit={canEdit} placeholder="Add a value…" onAdd={(v) => addDimValue(d.key, v)} onRemove={(i) => removeDimValue(d.key, i)} />
            </PixelPanel>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel T={T}>Naming</SectionLabel>
        {canEdit && (
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {["search", "social"].map((f) => (
              <Pill key={f} onClick={() => setTaxonomy({ ...taxonomy, dimensions, nameTemplates: templates, family: f })} style={{ cursor: "pointer", opacity: family === f ? 1 : 0.5 }}
                color={T.text} bg={family === f ? T.accentBg : T.surfaceHover} border={T.border}>
                {f === "search" ? "Paid search style (Ad Group)" : "Paid social style (Ad Set)"}
              </Pill>
            ))}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {["campaign", "adgroup", "ad"].map((levelKey) => {
            const template = templates[levelKey] || "";
            const exampleValues = {};
            dimensions.forEach((d) => { exampleValues[d.key] = d.values[0] || ""; });
            exampleValues.platform = family === "social" ? "LinkedIn" : "Google Search";
            const example = generateName(template, exampleValues);
            return (
              <PixelPanel key={levelKey} T={T} contentStyle={{ padding: 12 }}>
                <div style={{ fontSize: 11 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, fontFamily: T.font }}>{levelLabel(levelKey, family)}</div>
                {canEdit ? (
                  <input value={template} onChange={(e) => setTemplate(levelKey, e.target.value)} style={{ ...inputStyle(T), width: "100%", fontFamily: "monospace" }} />
                ) : (
                  <div style={{ fontFamily: "monospace", fontSize: 12 * (T.fsScale || 1), color: T.text }}>{template}</div>
                )}
                <div style={{ fontSize: 11.5 * (T.fsScale || 1), color: T.textSub, marginTop: 6, fontFamily: T.font }}>Example: <strong style={{ color: T.text }}>{example || "—"}</strong></div>
              </PixelPanel>
            );
          })}
        </div>
        <div style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font, marginTop: 8 }}>Available tokens: {availableTokens.map((t) => `{${t}}`).join(", ")}</div>
      </div>
    </div>
  );
}

// ─── STEP 4: TARGETING ──────────────────────────────────────────────────────────────────────────
// (2026-08-06, per Mo — "we need to determine if we're going to use job titles OR job function +
// seniorities... layer on contact or company lists, whether we're going to remarket, what
// exclusions..." — confirmed via AskUserQuestion as its own step, with the reusable
// lists/exclusions/remarketing pools shared across every plan in the workspace.) Two halves: the
// shared Library (workspace-scoped, fetched from targeting-library.js) and this plan's Targeting
// Profiles (reusable audience definitions a Mapping row picks from, rather than every ad set
// re-specifying its own targeting from scratch — same reasoning as the taxonomy dimensions
// themselves, applied to targeting logic instead of naming).

function MultiToggle({ T, options, selected, onChange, canEdit }) {
  const toggle = (v) => (selected.includes(v) ? onChange(selected.filter((x) => x !== v)) : onChange([...selected, v]));
  if (options.length === 0) return <span style={{ fontSize: 11.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>No values defined in Taxonomy yet</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {options.map((v) => (
        <Pill key={v} onClick={() => canEdit && toggle(v)} style={{ cursor: canEdit ? "pointer" : "default", opacity: selected.includes(v) ? 1 : 0.5 }}
          color={T.text} bg={selected.includes(v) ? T.accentBg : T.surfaceHover} border={T.border}>{v}</Pill>
      ))}
    </div>
  );
}

function LibrarySection({ T, label, type, items, onAdd, onRemove, canEdit }) {
  const filtered = items.filter((it) => it.type === type);
  const [name, setName] = useState(""); const [desc, setDesc] = useState("");
  const add = () => { if (!name.trim()) return; onAdd({ type, name: name.trim(), description: desc.trim() }); setName(""); setDesc(""); };
  return (
    <div>
      <div style={{ fontSize: 11 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, fontFamily: T.font }}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: canEdit ? 8 : 0 }}>
        {filtered.map((it) => (
          <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", background: T.surfaceHover, borderRadius: T.r8, fontSize: 12 * (T.fsScale || 1), fontFamily: T.font }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: T.text }}>{it.name}</div>
              {it.description && <div style={{ fontSize: 10.5 * (T.fsScale || 1), color: T.textMuted }}>{it.description}</div>}
            </div>
            {canEdit && <span onClick={() => onRemove(it.id)} style={{ cursor: "pointer", opacity: 0.55, fontWeight: 700, flexShrink: 0 }}>×</span>}
          </div>
        ))}
        {filtered.length === 0 && <span style={{ fontSize: 11.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>None yet</span>}
      </div>
      {canEdit && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name…" style={inputStyle(T)} />
          <div style={{ display: "flex", gap: 6 }}>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" style={{ ...inputStyle(T), flex: 1 }} />
            <Btn T={T} size="sm" variant="subtle" onClick={add}>Add</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function TargetingStep({ T, session, workspace, taxonomy, targeting, setTargeting, canEdit }) {
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

  if (library === null) return <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Loading targeting library…</div>;
  const listItems = library.filter((it) => it.type === "list");
  const exclusionItems = library.filter((it) => it.type === "exclusion");
  const remarketingItems = library.filter((it) => it.type === "remarketing");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <PixelPanel T={T} contentStyle={{ padding: 16 }}>
        <SectionLabel T={T}>Shared Targeting Library</SectionLabel>
        <div style={{ fontSize: 11.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font, marginBottom: 12 }}>Reused across every Account Planning project for this workspace — define once, attach to any profile below.</div>
        <div style={{ display: "grid", gridTemplateColumns: isMobilePad() ? "1fr" : "1fr 1fr 1fr", gap: 16 }}>
          <LibrarySection T={T} label="Contact / Company Lists" type="list" items={library} canEdit={canEdit} onAdd={addLibraryItem} onRemove={removeLibraryItem} />
          <LibrarySection T={T} label="Exclusion Lists" type="exclusion" items={library} canEdit={canEdit} onAdd={addLibraryItem} onRemove={removeLibraryItem} />
          <LibrarySection T={T} label="Remarketing Pools" type="remarketing" items={library} canEdit={canEdit} onAdd={addLibraryItem} onRemove={removeLibraryItem} />
        </div>
      </PixelPanel>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <SectionLabel T={T} style={{ marginBottom: 0 }}>Targeting Profiles</SectionLabel>
          {canEdit && <Btn T={T} size="sm" variant="subtle" onClick={addProfile}><Icon name="plus" size={11} color={T.text} style={{ marginRight: 4 }} />Add profile</Btn>}
        </div>
        {profiles.length === 0 && (
          <div style={{ fontSize: 12 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font, marginBottom: 8 }}>
            Each profile is a reusable audience definition (e.g. "Enterprise IT Buyers") — assign one to any ad set in Mapping instead of re-specifying targeting from scratch every time.
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {profiles.map((p) => (
            <PixelPanel key={p.id} T={T} contentStyle={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                {canEdit ? (
                  <input value={p.name} onChange={(e) => updateProfile(p.id, { name: e.target.value })} style={{ ...inputStyle(T), fontWeight: 700, flex: 1, maxWidth: 260 }} />
                ) : (
                  <span style={{ fontWeight: 700, color: T.text, fontFamily: T.font }}>{p.name}</span>
                )}
                {canEdit && <span onClick={() => removeProfile(p.id)} style={{ cursor: "pointer", color: T.textMuted, marginLeft: "auto", fontWeight: 700 }}>×</span>}
              </div>

              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                {[["job_title", "Job Titles"], ["job_function_seniority", "Function + Seniority"]].map(([k, l]) => (
                  <Pill key={k} onClick={() => canEdit && updateProfile(p.id, { method: k })} style={{ cursor: canEdit ? "pointer" : "default", opacity: p.method === k ? 1 : 0.5 }}
                    color={T.text} bg={p.method === k ? T.accentBg : T.surfaceHover} border={T.border}>{l}</Pill>
                ))}
              </div>

              {p.method === "job_title" ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontFamily: T.font }}>Job Titles</div>
                  <ChipList T={T} items={p.titles} canEdit={canEdit} placeholder="Add a job title…" onAdd={(v) => updateProfile(p.id, { titles: [...p.titles, v] })} onRemove={(i) => updateProfile(p.id, { titles: p.titles.filter((_, x) => x !== i) })} />
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: isMobilePad() ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontFamily: T.font }}>Job Functions</div>
                    <ChipList T={T} items={p.functions} canEdit={canEdit} placeholder="Add a function…" onAdd={(v) => updateProfile(p.id, { functions: [...p.functions, v] })} onRemove={(i) => updateProfile(p.id, { functions: p.functions.filter((_, x) => x !== i) })} />
                  </div>
                  <div>
                    <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontFamily: T.font }}>Seniorities</div>
                    <ChipList T={T} items={p.seniorities} canEdit={canEdit} placeholder="Add a seniority…" onAdd={(v) => updateProfile(p.id, { seniorities: [...p.seniorities, v] })} onRemove={(i) => updateProfile(p.id, { seniorities: p.seniorities.filter((_, x) => x !== i) })} />
                  </div>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: isMobilePad() ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontFamily: T.font }}>Company Size</div>
                  <MultiToggle T={T} options={companySizeValues} selected={p.companySizes} canEdit={canEdit} onChange={(v) => updateProfile(p.id, { companySizes: v })} />
                </div>
                <div>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontFamily: T.font }}>Industry</div>
                  <MultiToggle T={T} options={industryValues} selected={p.industries} canEdit={canEdit} onChange={(v) => updateProfile(p.id, { industries: v })} />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: isMobilePad() ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontFamily: T.font }}>Lists to layer on</div>
                  {listItems.length === 0 ? <span style={{ fontSize: 11.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Add lists to the library above first</span> : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {listItems.map((it) => {
                        const attached = p.listAttachments.find((a) => a.itemId === it.id);
                        return (
                          <Pill key={it.id} onClick={() => { if (!canEdit) return; const next = attached ? p.listAttachments.filter((a) => a.itemId !== it.id) : [...p.listAttachments, { itemId: it.id, direction: "include" }]; updateProfile(p.id, { listAttachments: next }); }}
                            style={{ cursor: canEdit ? "pointer" : "default", opacity: attached ? 1 : 0.5 }} color={T.text} bg={attached ? T.accentBg : T.surfaceHover} border={T.border}>{it.name}</Pill>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontFamily: T.font }}>Exclusions</div>
                  {exclusionItems.length === 0 ? <span style={{ fontSize: 11.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>Add exclusion lists to the library above first</span> : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {exclusionItems.map((it) => {
                        const attached = p.exclusionAttachments.find((a) => a.itemId === it.id);
                        return (
                          <Pill key={it.id} onClick={() => { if (!canEdit) return; const next = attached ? p.exclusionAttachments.filter((a) => a.itemId !== it.id) : [...p.exclusionAttachments, { itemId: it.id }]; updateProfile(p.id, { exclusionAttachments: next }); }}
                            style={{ cursor: canEdit ? "pointer" : "default", opacity: attached ? 1 : 0.5 }} color={attached ? T.danger : T.text} bg={attached ? T.dangerBg : T.surfaceHover} border={attached ? T.dangerBorder : T.border}>{it.name}</Pill>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 * (T.fsScale || 1), color: T.text, fontFamily: T.font, cursor: canEdit ? "pointer" : "default" }}>
                  <input type="checkbox" disabled={!canEdit} checked={!!p.remarketing?.enabled} onChange={(e) => updateProfile(p.id, { remarketing: { ...p.remarketing, enabled: e.target.checked } })} style={{ accentColor: T.accent, width: 13, height: 13 }} />
                  Remarketing
                </label>
                {p.remarketing?.enabled && (
                  <>
                    <select disabled={!canEdit} value={p.remarketing.poolItemId || ""} onChange={(e) => updateProfile(p.id, { remarketing: { ...p.remarketing, poolItemId: e.target.value } })} style={selectStyle(T)}>
                      <option value="">Pool…</option>
                      {remarketingItems.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                    </select>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input type="number" disabled={!canEdit} value={p.remarketing.windowDays || 30} onChange={(e) => updateProfile(p.id, { remarketing: { ...p.remarketing, windowDays: Number(e.target.value) } })} style={{ ...inputStyle(T), width: 60 }} />
                      <span style={{ fontSize: 11 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>days</span>
                    </div>
                  </>
                )}
              </div>
            </PixelPanel>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── STEP 4: MAPPING ────────────────────────────────────────────────────────────────────────────

function MappingStep({ T, mapping, setMapping, taxonomy, targeting, canEdit }) {
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

  // Budget rollups — grouped from each row's own `budget` (the only place budget is entered, per
  // Mo's call), never a separately-typed number per level, so these can never silently stop adding
  // up. Groups by whichever taxonomy dimension a row's dimValues actually has a value for, plus
  // platform, so this works whether or not every row has every dimension filled in yet.
  const rollupsByProduct = useMemo(() => computeBudgetRollup(mapping, (r) => r.dimValues?.product), [mapping]);
  const rollupsBySegment = useMemo(() => computeBudgetRollup(mapping, (r) => r.dimValues?.segment), [mapping]);
  const rollupsByPlatform = useMemo(() => computeBudgetRollup(mapping, (r) => r.platform), [mapping]);
  const totalBudget = mapping.reduce((s, r) => s + (Number(r.budget) || 0), 0);

  if (mapping.length === 0) {
    return (
      <div>
        <div style={{ fontSize: 12.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font, marginBottom: 12 }}>No mapping rows yet — add campaigns/ads from the Audit step, or add a row manually for something entirely new.</div>
        {canEdit && <Btn T={T} variant="subtle" onClick={addRow}><Icon name="plus" size={12} color={T.text} style={{ marginRight: 6 }} />Add row</Btn>}
      </div>
    );
  }

  return (
    <div>
      {totalBudget > 0 && (
        <PixelPanel T={T} contentStyle={{ padding: 14, marginBottom: 16 }}>
          <SectionLabel T={T}>Budget rollup</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: isMobilePad() ? "1fr" : "repeat(auto-fit,minmax(180px,1fr))", gap: 16 }}>
            {[["Total", [{ label: "All", amount: totalBudget }]], ["By product", rollupsByProduct], ["By segment", rollupsBySegment], ["By platform", rollupsByPlatform]].map(([label, rows]) => (
              <div key={label}>
                <div style={{ fontSize: 10.5 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5, fontFamily: T.font }}>{label}</div>
                {rows.map((r) => (
                  <div key={r.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 * (T.fsScale || 1), color: T.text, fontFamily: T.font, marginBottom: 2 }}>
                    <span style={{ color: T.textSub }}>{r.label}</span><span style={{ fontWeight: 700 }}>{fmtFull(r.amount)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </PixelPanel>
      )}
      {canEdit && <div style={{ marginBottom: 12 }}><Btn T={T} size="sm" variant="subtle" onClick={addRow}><Icon name="plus" size={11} color={T.text} style={{ marginRight: 4 }} />Add row</Btn></div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {mapping.map((row, i) => {
          const template = rowTemplate(row);
          const tokens = templateTokens(template).filter((t) => t !== "platform");
          const validation = validateName(finalName(row), template);
          return (
            <PixelPanel key={row.oldKey} T={T} contentStyle={{ padding: 14 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>
                <div style={{ minWidth: 160 }}>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3, fontFamily: T.font }}>Old</div>
                  {row.oldName ? (
                    <div style={{ fontSize: 12.5 * (T.fsScale || 1), color: T.text, fontFamily: T.font, fontWeight: 600 }}>{row.oldName}</div>
                  ) : (
                    <input value={row.oldName} onChange={(e) => updateRow(i, { oldName: e.target.value })} placeholder="Old name (optional)" disabled={!canEdit} style={{ ...inputStyle(T), width: 160 }} />
                  )}
                  {row.oldCampaignGroup && <div style={{ fontSize: 10.5 * (T.fsScale || 1), color: T.textMuted, fontFamily: T.font }}>{row.oldCampaignGroup}</div>}
                </div>

                <div>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3, fontFamily: T.font }}>Level</div>
                  <select disabled={!canEdit} value={row.level} onChange={(e) => updateRow(i, { level: e.target.value })} style={selectStyle(T)}>
                    <option value="campaign">Campaign</option>
                    <option value="adgroup">Ad Group / Ad Set</option>
                    <option value="ad">Ad</option>
                  </select>
                </div>

                <div>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3, fontFamily: T.font }}>Action</div>
                  <select disabled={!canEdit} value={row.action} onChange={(e) => updateRow(i, { action: e.target.value })} style={selectStyle(T)}>
                    {Object.entries(ACTION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>

                <div>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3, fontFamily: T.font }}>Status</div>
                  <select disabled={!canEdit} value={row.status} onChange={(e) => updateRow(i, { status: e.target.value })} style={selectStyle(T)}>
                    {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>

                <div>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3, fontFamily: T.font }}>Targeting</div>
                  <select disabled={!canEdit} value={row.targetingProfileId || ""} onChange={(e) => updateRow(i, { targetingProfileId: e.target.value })} style={selectStyle(T)}>
                    <option value="">None</option>
                    {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>

                <div>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3, fontFamily: T.font }}>Budget</div>
                  <input type="number" disabled={!canEdit} value={row.budget || ""} onChange={(e) => updateRow(i, { budget: e.target.value })} placeholder="$/mo" style={{ ...inputStyle(T), width: 90 }} />
                </div>

                {canEdit && (
                  <button onClick={() => removeRow(i)} style={{ marginLeft: "auto", background: "transparent", border: "none", cursor: "pointer", padding: 4, alignSelf: "flex-start" }}>
                    <Icon name="trash" size={13} color={T.textMuted} />
                  </button>
                )}
              </div>

              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                  {tokens.map((tok) => {
                    const dim = dimByKey[tok];
                    const val = row.dimValues?.[tok] || "";
                    if (dim && dim.values.length > 0) {
                      return (
                        <select key={tok} disabled={!canEdit} value={val} onChange={(e) => updateRow(i, { dimValues: { ...row.dimValues, [tok]: e.target.value } })} style={selectStyle(T)}>
                          <option value="">{dim.label}…</option>
                          {dim.values.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      );
                    }
                    return (
                      <input key={tok} disabled={!canEdit} value={val} onChange={(e) => updateRow(i, { dimValues: { ...row.dimValues, [tok]: e.target.value } })}
                        placeholder={dim ? dim.label : tok} style={{ ...inputStyle(T), width: 120 }} />
                    );
                  })}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 10 * (T.fsScale || 1), fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: T.font }}>New</div>
                  <input disabled={!canEdit} value={row.manualName} onChange={(e) => updateRow(i, { manualName: e.target.value })}
                    placeholder={generatedName(row) || "Generated from taxonomy…"} style={{ ...inputStyle(T), flex: 1, fontFamily: "monospace", fontWeight: 600 }} />
                </div>
                {finalName(row) && !validation.valid && (
                  <div style={{ fontSize: 10.5 * (T.fsScale || 1), color: T.warning, marginTop: 4, fontFamily: T.font }}>{validation.issues.join(" · ")}</div>
                )}
              </div>
            </PixelPanel>
          );
        })}
      </div>
    </div>
  );
}

// ─── MAIN ───────────────────────────────────────────────────────────────────────────────────────

export default function AccountPlanning({ T, session, workspace, mergedNormRows, combineGoogleChannels = {}, canEdit }) {
  const [plans, setPlans] = useState([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [plan, setPlan] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

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

  // Debounced autosave — local `plan` state is the source of truth once loaded; every change
  // schedules a PATCH ~900ms after the last edit so rapid typing/chip-adding doesn't fire a request
  // per keystroke, same reasoning as every other autosave debounce already in this codebase.
  // setSaving(true) fires inside the timeout callback (not synchronously in the effect body) so the
  // indicator only lights up once a save is actually about to happen, not on every keystroke.
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
      <div style={{ flex: 1, overflow: "auto", padding: isMobilePad() ? "16px" : "24px 28px" }}>
        <PlanList T={T} plans={plans} loading={plansLoading} canEdit={canEdit} onOpen={openPlan} onCreate={createPlan} onDelete={removePlan} />
      </div>
    );
  }

  const activeStep = plan.activeStep || "context";
  const setStepField = (field, value) => setPlan({ ...plan, [field]: value });

  return (
    <div style={{ flex: 1, overflow: "auto", padding: isMobilePad() ? "16px" : "24px 28px" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        <div style={{ marginBottom: 18 }}>
          {T.wideLayout && <Breadcrumb T={T} items={["Home", "Account Planning", plan.name]} />}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button onClick={backToList} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4, color: T.textMuted, fontSize: 12 * (T.fsScale || 1), fontFamily: T.font }}>
              <Icon name="chevronDown" size={12} color={T.textMuted} style={{ transform: "rotate(90deg)" }} /> All plans
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
            {canEdit ? (
              <input value={plan.name} onChange={(e) => setStepField("name", e.target.value)}
                style={{ fontSize: T.wideLayout ? 28 : 18 * (T.fsScale || 1), fontWeight: 700, color: T.text, fontFamily: T.font, background: "transparent", border: "none", outline: "none", padding: 0, minWidth: 200 }} />
            ) : (
              <h2 style={{ fontSize: T.wideLayout ? 28 : 18 * (T.fsScale || 1), fontWeight: 700, color: T.text, fontFamily: T.font }}>{plan.name}</h2>
            )}
            {canEdit && (
              <select value={plan.status || "draft"} onChange={(e) => setStepField("status", e.target.value)} style={selectStyle(T)}>
                <option value="draft">Draft</option>
                <option value="in_progress">In progress</option>
                <option value="complete">Complete</option>
              </select>
            )}
            <SavedIndicator T={T} saving={saving} savedAt={savedAt} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: isMobilePad() ? "wrap" : "nowrap" }}>
          <div style={{ display: "flex", flexDirection: isMobilePad() ? "row" : "column", gap: 4, flexShrink: 0, width: isMobilePad() ? "100%" : 190, overflowX: isMobilePad() ? "auto" : undefined }}>
            {STEPS.map((s, i) => {
              const active = activeStep === s.key;
              return (
                <button key={s.key} onClick={() => setStepField("activeStep", s.key)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: T.r8, border: "none", background: active ? T.accentBg : "transparent", cursor: "pointer", textAlign: "left", whiteSpace: "nowrap" }}>
                  <span style={{ width: 18, height: 18, borderRadius: "50%", background: active ? T.accent : T.surfaceHover, color: active ? T.onAccent : T.textMuted, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ fontSize: 12.5 * (T.fsScale || 1), fontWeight: active ? 700 : 500, color: active ? T.accent : T.textSub, fontFamily: T.font }}>{s.label}</span>
                </button>
              );
            })}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {activeStep === "context" && <ContextStep T={T} context={plan.context || {}} setContext={(v) => setStepField("context", v)} canEdit={canEdit} />}
            {activeStep === "audit" && (
              <AuditStep T={T} session={session} workspace={workspace} mergedNormRows={mergedNormRows} combineGoogleChannels={combineGoogleChannels}
                auditDecisions={plan.auditDecisions || {}} setAuditDecisions={(v) => setStepField("auditDecisions", v)}
                mapping={plan.mapping || []} setMapping={(v) => setStepField("mapping", v)} canEdit={canEdit} />
            )}
            {activeStep === "taxonomy" && <TaxonomyStep T={T} taxonomy={plan.taxonomy || {}} setTaxonomy={(v) => setStepField("taxonomy", v)} context={plan.context || {}} canEdit={canEdit} />}
            {activeStep === "targeting" && (
              <TargetingStep T={T} session={session} workspace={workspace} taxonomy={plan.taxonomy || {}} targeting={plan.targeting || []} setTargeting={(v) => setStepField("targeting", v)} canEdit={canEdit} />
            )}
            {activeStep === "mapping" && (
              <MappingStep T={T} mapping={plan.mapping || []} setMapping={(v) => setStepField("mapping", v)} taxonomy={plan.taxonomy || {}} targeting={plan.targeting || []} canEdit={canEdit} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
