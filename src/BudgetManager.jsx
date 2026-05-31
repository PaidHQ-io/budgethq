import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import Papa from "papaparse";

const MONTHS = [
  { key: "01", label: "Jan" }, { key: "02", label: "Feb" }, { key: "03", label: "Mar" },
  { key: "04", label: "Apr" }, { key: "05", label: "May" }, { key: "06", label: "Jun" },
  { key: "07", label: "Jul" }, { key: "08", label: "Aug" }, { key: "09", label: "Sep" },
  { key: "10", label: "Oct" }, { key: "11", label: "Nov" }, { key: "12", label: "Dec" },
];

const QUARTERS = [
  { key: "Q1", months: ["01","02","03"], label: "Q1 Cap" },
  { key: "Q2", months: ["04","05","06"], label: "Q2 Cap" },
  { key: "Q3", months: ["07","08","09"], label: "Q3 Cap" },
  { key: "Q4", months: ["10","11","12"], label: "Q4 Cap" },
];

const MONTH_NAME_MAP = {
  jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06",
  jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12",
  january:"01", february:"02", march:"03", april:"04", june:"06",
  july:"07", august:"08", september:"09", october:"10", november:"11", december:"12",
};

function parseMoney(val) {
  if (val === "" || val === undefined || val === null) return null;
  const n = parseFloat(String(val).replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : n;
}

function fmt$(n) {
  if (!n) return "";
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + Math.round(n).toLocaleString();
}

function fmtFull(n) {
  if (!n) return "—";
  return "$" + Math.round(n).toLocaleString();
}

function detectMonthCol(col) {
  const c = col.trim().toLowerCase();
  if (MONTH_NAME_MAP[c]) return MONTH_NAME_MAP[c];
  const m = c.match(/^(\d{1,2})[\/-](\d{2,4})$/) || c.match(/^(\d{4})[\/-](\d{2})$/);
  if (m) return null; // date column, not a month header
  return null;
}

function isMonthHeader(col) {
  const c = col.trim().toLowerCase().replace(/\s+\d{4}$/, ""); // strip year suffix
  return !!MONTH_NAME_MAP[c];
}

function getMonthKeyFromHeader(col) {
  const c = col.trim().toLowerCase().replace(/\s+\d{4}$/, "");
  return MONTH_NAME_MAP[c] || null;
}

function parseMonthFromPeriod(val) {
  if (!val) return null;
  const s = String(val).trim();
  // 2026-01 or 01/2026
  let m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) return m[2];
  m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return String(m[1]).padStart(2, "0");
  // Jan 2026 or January 2026
  const lower = s.toLowerCase().replace(/[,\s]+/g, " ");
  for (const [name, key] of Object.entries(MONTH_NAME_MAP)) {
    if (lower.startsWith(name)) return key;
  }
  return null;
}

export default function BudgetManager({ campaignTags, tagDimensions, T }) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear.toString());
  const [budgetDims, setBudgetDims] = useState([]);
  const [showQuarterly, setShowQuarterly] = useState(false);
  const [showAnnual, setShowAnnual] = useState(false);
  const [budgets, setBudgets] = useState({});
  const [importOpen, setImportOpen] = useState(false);
  const [notification, setNotification] = useState(null);

  // Import state
  const [importStep, setImportStep] = useState("upload"); // upload | map | preview
  const [importYear, setImportYear] = useState(currentYear.toString());
  const [importFile, setImportFile] = useState(null);
  const [importRows, setImportRows] = useState([]);
  const [importHeaders, setImportHeaders] = useState([]);
  const [importFormat, setImportFormat] = useState("wide"); // wide | long
  const [dimMapping, setDimMapping] = useState({}); // tagDim -> csvCol
  const [periodCol, setPeriodCol] = useState("");
  const [amountCol, setAmountCol] = useState("");
  const [importPreview, setImportPreview] = useState([]);
  const fileRef = useRef();

  useEffect(() => {
    try {
      const b = localStorage.getItem("paidhq_budgets"); if (b) setBudgets(JSON.parse(b));
      const d = localStorage.getItem("paidhq_budget_dims"); if (d) setBudgetDims(JSON.parse(d));
      const sq = localStorage.getItem("paidhq_show_quarterly"); if (sq) setShowQuarterly(JSON.parse(sq));
      const sa = localStorage.getItem("paidhq_show_annual"); if (sa) setShowAnnual(JSON.parse(sa));
    } catch (e) {}
  }, []);

  useEffect(() => { localStorage.setItem("paidhq_budgets", JSON.stringify(budgets)); }, [budgets]);
  useEffect(() => { localStorage.setItem("paidhq_budget_dims", JSON.stringify(budgetDims)); }, [budgetDims]);
  useEffect(() => { localStorage.setItem("paidhq_show_quarterly", JSON.stringify(showQuarterly)); }, [showQuarterly]);
  useEffect(() => { localStorage.setItem("paidhq_show_annual", JSON.stringify(showAnnual)); }, [showAnnual]);

  const showNotif = (msg) => { setNotification(msg); setTimeout(() => setNotification(null), 3000); };

  const segmentCombinations = useMemo(() => {
    if (!budgetDims.length) return [];
    const seen = new Set();
    const combos = [];
    Object.entries(campaignTags).forEach(([, tags]) => {
      const vals = budgetDims.map(dim => tags[dim]);
      if (vals.some(v => !v)) return;
      const key = vals.join("|");
      if (!seen.has(key)) {
        seen.add(key);
        const combo = { key };
        budgetDims.forEach((dim, i) => { combo[dim] = vals[i]; });
        combos.push(combo);
      }
    });
    return combos.sort((a, b) => a.key.localeCompare(b.key));
  }, [budgetDims, campaignTags]);

  const getMonthVal = useCallback((segKey, monthKey) => budgets[year]?.[segKey]?.monthly?.[monthKey] ?? "", [budgets, year]);
  const getQuarterCap = useCallback((segKey, qKey) => budgets[year]?.[segKey]?.quarterly?.[qKey] ?? "", [budgets, year]);
  const getAnnualCap = useCallback((segKey) => budgets[year]?.[segKey]?.annual ?? "", [budgets, year]);

  const setMonthVal = useCallback((segKey, monthKey, value) => {
    const n = parseMoney(value);
    setBudgets(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (!next[year]) next[year] = {};
      if (!next[year][segKey]) next[year][segKey] = {};
      if (!next[year][segKey].monthly) next[year][segKey].monthly = {};
      if (n === null) delete next[year][segKey].monthly[monthKey];
      else next[year][segKey].monthly[monthKey] = n;
      return next;
    });
  }, [year]);

  const setQuarterCap = useCallback((segKey, qKey, value) => {
    const n = parseMoney(value);
    setBudgets(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (!next[year]) next[year] = {};
      if (!next[year][segKey]) next[year][segKey] = {};
      if (!next[year][segKey].quarterly) next[year][segKey].quarterly = {};
      if (n === null) delete next[year][segKey].quarterly[qKey];
      else next[year][segKey].quarterly[qKey] = n;
      return next;
    });
  }, [year]);

  const setAnnualCap = useCallback((segKey, value) => {
    const n = parseMoney(value);
    setBudgets(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (!next[year]) next[year] = {};
      if (!next[year][segKey]) next[year][segKey] = {};
      if (n === null) delete next[year][segKey].annual;
      else next[year][segKey].annual = n;
      return next;
    });
  }, [year]);

  const getRowTotal = useCallback((segKey) => {
    const monthly = budgets[year]?.[segKey]?.monthly || {};
    return Object.values(monthly).reduce((s, v) => s + (v || 0), 0);
  }, [budgets, year]);

  const getQuarterTotal = useCallback((segKey, q) => {
    return q.months.reduce((s, m) => s + (budgets[year]?.[segKey]?.monthly?.[m] || 0), 0);
  }, [budgets, year]);

  const isQuarterOver = useCallback((segKey, q) => {
    const cap = parseMoney(getQuarterCap(segKey, q.key));
    if (cap === null) return false;
    return getQuarterTotal(segKey, q) > cap;
  }, [getQuarterCap, getQuarterTotal]);

  const isAnnualOver = useCallback((segKey) => {
    const cap = parseMoney(getAnnualCap(segKey));
    if (cap === null) return false;
    return getRowTotal(segKey) > cap;
  }, [getAnnualCap, getRowTotal]);

  const toggleDim = (dim) => setBudgetDims(prev => prev.includes(dim) ? prev.filter(d => d !== dim) : [...prev, dim]);
  const years = [(currentYear - 1).toString(), currentYear.toString(), (currentYear + 1).toString()];

  const totalBudgetForYear = useMemo(() => {
    return segmentCombinations.reduce((s, seg) => s + getRowTotal(seg.key), 0);
  }, [segmentCombinations, getRowTotal]);

  const dimUniqueCount = (dim) => [...new Set(Object.values(campaignTags).map(t => t[dim]).filter(Boolean))].length;

  // ── IMPORT LOGIC ──

  const handleImportFile = (file) => {
    if (!file) return;
    setImportFile(file);
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (result) => {
        const hdrs = result.meta.fields || [];
        setImportHeaders(hdrs);
        setImportRows(result.data);
        // Auto-detect format
        const monthCols = hdrs.filter(h => isMonthHeader(h));
        const isWide = monthCols.length >= 3;
        setImportFormat(isWide ? "wide" : "long");
        // Auto-map dimensions
        const autoMap = {};
        tagDimensions.forEach(dim => {
          const match = hdrs.find(h => h.toLowerCase() === dim.toLowerCase() || h.toLowerCase().includes(dim.toLowerCase()));
          if (match) autoMap[dim] = match;
        });
        setDimMapping(autoMap);
        // Auto-detect period + amount for long format
        if (!isWide) {
          const periodGuess = hdrs.find(h => /month|period|date/i.test(h)) || "";
          const amountGuess = hdrs.find(h => /budget|amount|spend|cost/i.test(h)) || "";
          setPeriodCol(periodGuess);
          setAmountCol(amountGuess);
        }
        setImportStep("map");
      }
    });
  };

  const buildPreview = useCallback(() => {
    const entries = [];
    if (importFormat === "wide") {
      const monthCols = importHeaders.filter(h => isMonthHeader(h));
      importRows.forEach(row => {
        const segParts = tagDimensions.filter(d => dimMapping[d]).map(d => ({ dim: d, val: row[dimMapping[d]] }));
        if (segParts.some(p => !p.val)) return;
        const segKey = segParts.map(p => p.val).join("|");
        monthCols.forEach(col => {
          const monthKey = getMonthKeyFromHeader(col);
          const amount = parseMoney(row[col]);
          if (monthKey && amount !== null && amount > 0) {
            entries.push({ segKey, dims: Object.fromEntries(segParts.map(p => [p.dim, p.val])), monthKey, amount });
          }
        });
      });
    } else {
      importRows.forEach(row => {
        const segParts = tagDimensions.filter(d => dimMapping[d]).map(d => ({ dim: d, val: row[dimMapping[d]] }));
        if (segParts.some(p => !p.val)) return;
        const segKey = segParts.map(p => p.val).join("|");
        const monthKey = parseMonthFromPeriod(row[periodCol]);
        const amount = parseMoney(row[amountCol]);
        if (monthKey && amount !== null && amount > 0) {
          entries.push({ segKey, dims: Object.fromEntries(segParts.map(p => [p.dim, p.val])), monthKey, amount });
        }
      });
    }
    return entries;
  }, [importFormat, importHeaders, importRows, tagDimensions, dimMapping, periodCol, amountCol]);

  const goToPreview = () => {
    const preview = buildPreview();
    setImportPreview(preview);
    setImportStep("preview");
  };

  const confirmImport = () => {
    setBudgets(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (!next[importYear]) next[importYear] = {};
      importPreview.forEach(({ segKey, monthKey, amount }) => {
        if (!next[importYear][segKey]) next[importYear][segKey] = {};
        if (!next[importYear][segKey].monthly) next[importYear][segKey].monthly = {};
        next[importYear][segKey].monthly[monthKey] = amount;
      });
      return next;
    });
    // Also set year to imported year
    setYear(importYear);
    // Add any new dims if needed
    const dimsUsed = tagDimensions.filter(d => dimMapping[d]);
    setBudgetDims(prev => {
      const next = new Set(prev);
      dimsUsed.forEach(d => next.add(d));
      return [...next];
    });
    setImportOpen(false);
    resetImport();
    showNotif(`Imported ${importPreview.length} budget entries for ${importYear}`);
  };

  const resetImport = () => {
    setImportStep("upload"); setImportFile(null); setImportRows([]);
    setImportHeaders([]); setDimMapping({}); setPeriodCol(""); setAmountCol("");
    setImportPreview([]);
  };

  const closeImport = () => { setImportOpen(false); resetImport(); };

  // Group preview by segment for display
  const previewGrouped = useMemo(() => {
    const map = {};
    importPreview.forEach(e => {
      if (!map[e.segKey]) map[e.segKey] = { dims: e.dims, months: {} };
      map[e.segKey].months[e.monthKey] = e.amount;
    });
    return Object.values(map).sort((a, b) => Object.values(a.dims).join("|").localeCompare(Object.values(b.dims).join("|")));
  }, [importPreview]);

  const dimCols = tagDimensions.filter(d => dimMapping[d]);
  const dimColWidth = 130;

  const cellInput = (val, onChange, isOver = false, isCap = false) => (
    <input type="text"
      value={val === "" ? "" : (typeof val === "number" ? val.toLocaleString() : val)}
      onChange={e => onChange(e.target.value)}
      placeholder="—"
      style={{
        background: isCap ? (isOver ? T.dangerBg : T.warningBg) : (isOver ? T.dangerBg : T.inputBg),
        border: `1px solid ${isOver ? T.danger : isCap ? T.warningBorder : T.border}`,
        borderRadius: 4, color: isOver ? T.danger : isCap ? T.warning : T.text,
        padding: "4px 5px", fontSize: 11, width: isCap ? 82 : 72,
        fontFamily: "DM Mono, monospace", textAlign: "right", outline: "none", display: "block",
      }}
    />
  );

  const thBase = { fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.8, padding: "8px 6px", borderBottom: `2px solid ${T.border}`, background: T.headerBg, whiteSpace: "nowrap", textAlign: "right" };
  const modalInput = { background: T.inputBg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, padding: "7px 10px", fontSize: 13, width: "100%", outline: "none", fontFamily: "inherit" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", height: "calc(100vh - 96px)", background: T.bg, position: "relative" }}>

      {/* Sidebar */}
      <div style={{ borderRight: `1px solid ${T.border}`, background: T.surface, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Import button */}
        <button onClick={() => setImportOpen(true)}
          style={{ width: "100%", padding: "9px 0", background: T.accentBg, border: `1px solid ${T.accentBorder}`, borderRadius: 8, color: T.accent, cursor: "pointer", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          ↑ Import CSV
        </button>

        {/* Year */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Budget Year</div>
          <div style={{ display: "flex", gap: 4 }}>
            {years.map(y => (
              <button key={y} onClick={() => setYear(y)}
                style={{ flex: 1, padding: "7px 0", borderRadius: 6, border: `1px solid ${year === y ? T.accent : T.borderSub}`, background: year === y ? T.accentBg : "transparent", color: year === y ? T.accent : T.textMuted, cursor: "pointer", fontSize: 12, fontWeight: year === y ? 700 : 400 }}>
                {y}
              </button>
            ))}
          </div>
        </div>

        {/* Budget dimensions */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Budget By</div>
          {tagDimensions.map(dim => {
            const active = budgetDims.includes(dim);
            return (
              <div key={dim} onClick={() => toggleDim(dim)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 6, marginBottom: 2, cursor: "pointer", background: active ? T.accentBg : "transparent" }}>
                <div style={{ width: 15, height: 15, borderRadius: 3, border: `2px solid ${active ? T.accent : T.borderSub}`, background: active ? T.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {active && <span style={{ color: "#fff", fontSize: 9, lineHeight: 1 }}>✓</span>}
                </div>
                <span style={{ fontSize: 13, color: active ? T.accent : T.text }}>{dim}</span>
                <span style={{ fontSize: 11, color: T.textMuted, marginLeft: "auto", fontFamily: "DM Mono, monospace" }}>{dimUniqueCount(dim)}</span>
              </div>
            );
          })}
        </div>

        {/* Optional caps */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Optional Caps</div>
          {[{ label: "Quarterly caps", val: showQuarterly, set: setShowQuarterly }, { label: "Annual cap", val: showAnnual, set: setShowAnnual }].map(({ label, val, set }) => (
            <div key={label} onClick={() => set(v => !v)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 6, marginBottom: 2, cursor: "pointer" }}>
              <div style={{ width: 30, height: 17, borderRadius: 8, background: val ? T.accent : T.borderSub, position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                <div style={{ position: "absolute", top: 2, left: val ? 15 : 2, width: 13, height: 13, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
              </div>
              <span style={{ fontSize: 13, color: T.text }}>{label}</span>
            </div>
          ))}
        </div>

        {/* Summary */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>Summary</div>
          {[
            { label: "Segments", value: segmentCombinations.length.toString() },
            { label: `Total ${year}`, value: totalBudgetForYear > 0 ? fmtFull(totalBudgetForYear) : "$0", color: T.accent },
          ].map(s => (
            <div key={s.label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: T.textMuted }}>{s.label}</span>
              <span style={{ fontSize: 12, color: s.color || T.text, fontFamily: "DM Mono, monospace", fontWeight: 600 }}>{s.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Main table */}
      <div style={{ overflow: "auto" }}>
        {!budgetDims.length ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: T.textMuted, textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 44, marginBottom: 16 }}>💰</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: T.text, marginBottom: 8 }}>Set up your budget structure</div>
            <div style={{ fontSize: 13, maxWidth: 360, lineHeight: 1.7, marginBottom: 24 }}>Select which dimensions to budget by in the left panel, or import an existing budget CSV to get started instantly.</div>
            <button onClick={() => setImportOpen(true)}
              style={{ padding: "10px 24px", background: T.accentBg, border: `1px solid ${T.accentBorder}`, borderRadius: 8, color: T.accent, cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
              ↑ Import CSV
            </button>
          </div>
        ) : segmentCombinations.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: T.textMuted, textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 44, marginBottom: 16 }}>🏷️</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: T.text, marginBottom: 8 }}>No tagged segments found</div>
            <div style={{ fontSize: 13, maxWidth: 360, lineHeight: 1.7 }}>Make sure campaigns are tagged with <strong style={{ color: T.text }}>{budgetDims.join(" and ")}</strong>. Switch to the Tagger to complete your tags.</div>
          </div>
        ) : (
          <table style={{ borderCollapse: "collapse", minWidth: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {budgetDims.map((dim, i) => (
                  <th key={dim} style={{ ...thBase, textAlign: "left", padding: "8px 12px", minWidth: dimColWidth, position: "sticky", left: i * dimColWidth, zIndex: 3, background: T.headerBg }}>
                    {dim}
                  </th>
                ))}
                {MONTHS.map(m => <th key={m.key} style={{ ...thBase, minWidth: 80 }}>{m.label}</th>)}
                <th style={{ ...thBase, color: T.accent, minWidth: 100 }}>Total</th>
                {showQuarterly && QUARTERS.map(q => <th key={q.key} style={{ ...thBase, color: T.warning, minWidth: 96 }}>{q.label}</th>)}
                {showAnnual && <th style={{ ...thBase, color: T.warning, minWidth: 96 }}>Annual Cap</th>}
              </tr>
            </thead>
            <tbody>
              {segmentCombinations.map((seg, rowIdx) => {
                const rowTotal = getRowTotal(seg.key);
                const annualOver = isAnnualOver(seg.key);
                const rowBg = rowIdx % 2 === 0 ? T.bg : (T.bg === "#0d1117" ? "#111620" : "#f0f3f6");
                return (
                  <tr key={seg.key}>
                    {budgetDims.map((dim, i) => (
                      <td key={dim} style={{ padding: "6px 12px", borderBottom: `1px solid ${T.border}`, position: "sticky", left: i * dimColWidth, background: rowBg, zIndex: 1, whiteSpace: "nowrap" }}>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: T.accentBg, color: T.accent, border: `1px solid ${T.accentBorder}`, fontWeight: 500 }}>{seg[dim]}</span>
                      </td>
                    ))}
                    {MONTHS.map(m => {
                      const q = QUARTERS.find(q => q.months.includes(m.key));
                      const qOver = showQuarterly && q && isQuarterOver(seg.key, q);
                      return (
                        <td key={m.key} style={{ padding: "4px 4px", borderBottom: `1px solid ${T.border}`, background: rowBg }}>
                          {cellInput(getMonthVal(seg.key, m.key), v => setMonthVal(seg.key, m.key, v), qOver, false)}
                        </td>
                      );
                    })}
                    <td style={{ padding: "4px 10px", borderBottom: `1px solid ${T.border}`, textAlign: "right", fontFamily: "DM Mono, monospace", fontWeight: 700, color: annualOver ? T.danger : T.accent, whiteSpace: "nowrap", background: rowBg }}>
                      {rowTotal > 0 ? fmtFull(rowTotal) : "—"}
                      {annualOver && <span title="Exceeds annual cap" style={{ marginLeft: 4 }}>⚠️</span>}
                    </td>
                    {showQuarterly && QUARTERS.map(q => {
                      const qOver = isQuarterOver(seg.key, q);
                      const qTotal = getQuarterTotal(seg.key, q);
                      return (
                        <td key={q.key} style={{ padding: "4px 4px", borderBottom: `1px solid ${T.border}`, background: rowBg }}>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                            {cellInput(getQuarterCap(seg.key, q.key), v => setQuarterCap(seg.key, q.key, v), qOver, true)}
                            {qTotal > 0 && <span style={{ fontSize: 10, color: qOver ? T.danger : T.textMuted, fontFamily: "DM Mono, monospace" }}>{fmt$(qTotal)} used{qOver ? " ⚠️" : ""}</span>}
                          </div>
                        </td>
                      );
                    })}
                    {showAnnual && (
                      <td style={{ padding: "4px 4px", borderBottom: `1px solid ${T.border}`, background: rowBg }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                          {cellInput(getAnnualCap(seg.key), v => setAnnualCap(seg.key, v), annualOver, true)}
                          {rowTotal > 0 && <span style={{ fontSize: 10, color: annualOver ? T.danger : T.textMuted, fontFamily: "DM Mono, monospace" }}>{fmt$(rowTotal)} used{annualOver ? " ⚠️" : ""}</span>}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              <tr style={{ borderTop: `2px solid ${T.border}` }}>
                {budgetDims.map((dim, i) => (
                  <td key={dim} style={{ padding: "10px 12px", position: "sticky", left: i * dimColWidth, background: T.surface, zIndex: 1 }}>
                    {i === 0 && <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Totals</span>}
                  </td>
                ))}
                {MONTHS.map(m => {
                  const total = segmentCombinations.reduce((s, seg) => s + (budgets[year]?.[seg.key]?.monthly?.[m.key] || 0), 0);
                  return (
                    <td key={m.key} style={{ padding: "10px 6px", textAlign: "right", fontFamily: "DM Mono, monospace", fontSize: 11, fontWeight: 700, color: T.text, background: T.surface }}>
                      {total > 0 ? fmt$(total) : "—"}
                    </td>
                  );
                })}
                <td style={{ padding: "10px 10px", textAlign: "right", fontFamily: "DM Mono, monospace", fontSize: 13, fontWeight: 700, color: T.accent, background: T.surface }}>
                  {totalBudgetForYear > 0 ? fmtFull(totalBudgetForYear) : "—"}
                </td>
                {showQuarterly && QUARTERS.map(q => <td key={q.key} style={{ background: T.surface }} />)}
                {showAnnual && <td style={{ background: T.surface }} />}
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {notification && (
        <div style={{ position: "fixed", top: 68, right: 20, background: "#238636", color: "#fff", padding: "10px 16px", borderRadius: 8, fontSize: 13, zIndex: 200, boxShadow: "0 4px 16px rgba(0,0,0,0.3)" }}>
          {notification}
        </div>
      )}

      {/* ── IMPORT MODAL ── */}
      {importOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 150, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, width: "100%", maxWidth: 680, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>

            {/* Modal header */}
            <div style={{ padding: "16px 24px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Import Budget CSV</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                  {importStep === "upload" && "Upload your budget spreadsheet export"}
                  {importStep === "map" && "Map your columns to tag dimensions"}
                  {importStep === "preview" && `${importPreview.length} budget entries ready to import`}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {/* Step indicator */}
                {["upload","map","preview"].map((s, i) => (
                  <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {i > 0 && <span style={{ color: T.borderSub }}>›</span>}
                    <span style={{ fontSize: 12, color: importStep === s ? T.accent : ["upload","map","preview"].indexOf(importStep) > i ? T.success : T.textMuted, fontWeight: importStep === s ? 600 : 400 }}>
                      {["upload","map","preview"].indexOf(importStep) > i ? "✓ " : ""}{["Upload","Map","Preview"][i]}
                    </span>
                  </div>
                ))}
                <button onClick={closeImport} style={{ background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 20, lineHeight: 1, marginLeft: 8 }}>×</button>
              </div>
            </div>

            {/* Modal body */}
            <div style={{ flex: 1, overflow: "auto", padding: 24 }}>

              {/* STEP 1: Upload + Year */}
              {importStep === "upload" && (
                <div>
                  {/* Year selector — prominent, first thing */}
                  <div style={{ marginBottom: 28 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 4 }}>Which year do these budgets apply to?</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>This applies to all entries in the file, even if the year isn't mentioned in the CSV.</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {[(currentYear - 1).toString(), currentYear.toString(), (currentYear + 1).toString()].map(y => (
                        <button key={y} onClick={() => setImportYear(y)}
                          style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: `2px solid ${importYear === y ? T.accent : T.borderSub}`, background: importYear === y ? T.accentBg : "transparent", color: importYear === y ? T.accent : T.textMuted, cursor: "pointer", fontSize: 15, fontWeight: importYear === y ? 700 : 400, transition: "all 0.15s" }}>
                          {y}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* File drop zone */}
                  <div
                    onClick={() => fileRef.current?.click()}
                    style={{ border: `2px dashed ${T.borderSub}`, borderRadius: 10, padding: "40px 24px", textAlign: "center", cursor: "pointer", background: T.bg }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 6 }}>Drop your budget CSV here</div>
                    <div style={{ fontSize: 12, color: T.textMuted }}>or click to browse · wide format (month columns) or long format (month + amount columns)</div>
                    <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={e => handleImportFile(e.target.files[0])} />
                  </div>

                  <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    {[
                      { label: "Wide format", example: "Product | Platform | Jan | Feb | Mar..." },
                      { label: "Long format", example: "Product | Platform | Month | Budget" },
                    ].map(f => (
                      <div key={f.label} style={{ padding: "12px 14px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 4 }}>{f.label}</div>
                        <div style={{ fontSize: 11, color: T.textMuted, fontFamily: "DM Mono, monospace" }}>{f.example}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* STEP 2: Map columns */}
              {importStep === "map" && (
                <div>
                  {/* Year confirmation */}
                  <div style={{ padding: "10px 14px", background: T.accentBg, border: `1px solid ${T.accentBorder}`, borderRadius: 8, marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, color: T.accent }}>Importing as year: <strong>{importYear}</strong></span>
                    <div style={{ display: "flex", gap: 4 }}>
                      {[(currentYear - 1).toString(), currentYear.toString(), (currentYear + 1).toString()].map(y => (
                        <button key={y} onClick={() => setImportYear(y)}
                          style={{ padding: "3px 10px", borderRadius: 4, border: `1px solid ${importYear === y ? T.accent : T.borderSub}`, background: importYear === y ? T.accentBg : "transparent", color: importYear === y ? T.accent : T.textMuted, cursor: "pointer", fontSize: 12, fontWeight: importYear === y ? 700 : 400 }}>
                          {y}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Format detected */}
                  <div style={{ padding: "8px 14px", background: T.successBg, border: `1px solid ${T.successBorder}`, borderRadius: 8, marginBottom: 20, fontSize: 12, color: T.success }}>
                    ✓ Detected <strong>{importFormat === "wide" ? "wide format" : "long format"}</strong> · {importRows.length} rows · {importHeaders.length} columns
                  </div>

                  {/* Dimension mapping */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10 }}>Map CSV columns to your tag dimensions</div>
                    {tagDimensions.map(dim => (
                      <div key={dim} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10, alignItems: "center" }}>
                        <div>
                          <span style={{ fontSize: 13, fontWeight: 500, color: T.text }}>{dim}</span>
                          <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 8 }}>{dimUniqueCount(dim)} values</span>
                        </div>
                        <select value={dimMapping[dim] || ""} onChange={e => setDimMapping(prev => ({ ...prev, [dim]: e.target.value || undefined }))}
                          style={{ ...modalInput, fontFamily: "DM Mono, monospace" }}>
                          <option value="">— skip this dimension —</option>
                          {importHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>

                  {/* Long format extra mapping */}
                  {importFormat === "long" && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 }}>Long format columns</div>
                      {[
                        { label: "Period / Month column", val: periodCol, set: setPeriodCol, hint: "e.g. 2026-01, Jan 2026, January" },
                        { label: "Budget amount column", val: amountCol, set: setAmountCol, hint: "e.g. Budget, Amount, Monthly Budget" },
                      ].map(({ label, val, set, hint }) => (
                        <div key={label} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10, alignItems: "center" }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: T.text }}>{label}</div>
                            <div style={{ fontSize: 11, color: T.textMuted }}>{hint}</div>
                          </div>
                          <select value={val} onChange={e => set(e.target.value)} style={{ ...modalInput, fontFamily: "DM Mono, monospace" }}>
                            <option value="">— select column —</option>
                            {importHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* STEP 3: Preview */}
              {importStep === "preview" && (
                <div>
                  <div style={{ padding: "10px 14px", background: T.successBg, border: `1px solid ${T.successBorder}`, borderRadius: 8, marginBottom: 20, fontSize: 13, color: T.success }}>
                    ✓ <strong>{importPreview.length} budget entries</strong> across <strong>{previewGrouped.length} segments</strong> ready to import into <strong>{importYear}</strong>
                  </div>
                  <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
                      <thead>
                        <tr>
                          {dimCols.map(d => <th key={d} style={{ padding: "8px 12px", textAlign: "left", background: T.headerBg, borderBottom: `1px solid ${T.border}`, fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{d}</th>)}
                          {MONTHS.filter(m => importPreview.some(e => e.monthKey === m.key)).map(m => (
                            <th key={m.key} style={{ padding: "8px 6px", textAlign: "right", background: T.headerBg, borderBottom: `1px solid ${T.border}`, fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase" }}>{m.label}</th>
                          ))}
                          <th style={{ padding: "8px 10px", textAlign: "right", background: T.headerBg, borderBottom: `1px solid ${T.border}`, fontSize: 10, fontWeight: 700, color: T.accent, textTransform: "uppercase" }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewGrouped.map((seg, i) => {
                          const rowTotal = Object.values(seg.months).reduce((s, v) => s + v, 0);
                          return (
                            <tr key={i}>
                              {dimCols.map(d => <td key={d} style={{ padding: "7px 12px", borderBottom: `1px solid ${T.border}`, color: T.text }}>{seg.dims[d] || "—"}</td>)}
                              {MONTHS.filter(m => importPreview.some(e => e.monthKey === m.key)).map(m => (
                                <td key={m.key} style={{ padding: "7px 6px", borderBottom: `1px solid ${T.border}`, textAlign: "right", fontFamily: "DM Mono, monospace", color: seg.months[m.key] ? T.text : T.textDim }}>
                                  {seg.months[m.key] ? fmt$(seg.months[m.key]) : "—"}
                                </td>
                              ))}
                              <td style={{ padding: "7px 10px", borderBottom: `1px solid ${T.border}`, textAlign: "right", fontFamily: "DM Mono, monospace", fontWeight: 700, color: T.accent }}>
                                {fmt$(rowTotal)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div style={{ padding: "14px 24px", borderTop: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button onClick={() => { if (importStep === "map") setImportStep("upload"); else if (importStep === "preview") setImportStep("map"); else closeImport(); }}
                style={{ background: "transparent", border: `1px solid ${T.borderSub}`, color: T.textMuted, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
                {importStep === "upload" ? "Cancel" : "← Back"}
              </button>
              {importStep === "map" && (
                <button onClick={goToPreview}
                  disabled={tagDimensions.filter(d => dimMapping[d]).length === 0 || (importFormat === "long" && (!periodCol || !amountCol))}
                  style={{ background: T.accent, border: "none", color: "#fff", padding: "8px 20px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, opacity: (tagDimensions.filter(d => dimMapping[d]).length === 0 || (importFormat === "long" && (!periodCol || !amountCol))) ? 0.4 : 1 }}>
                  Preview import →
                </button>
              )}
              {importStep === "preview" && (
                <button onClick={confirmImport}
                  style={{ background: "#238636", border: "none", color: "#fff", padding: "8px 20px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  ✓ Import {importPreview.length} entries into {importYear}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
