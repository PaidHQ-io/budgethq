import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";

const REQUIRED_COLS = ["campaign_name", "spend", "date"];
const OPTIONAL_COLS = ["adset_name", "platform", "impressions", "clicks", "campaign_id", "adset_id"];

const COL_PATTERNS = {
  campaign_name: /^campaign$/i,
  adset_name: /ad.?set|ad.?group/i,
  spend: /cost|spend|amount/i,
  date: /^date$|^day$/i,
  platform: /platform|traffic.source|channel|source/i,
  impressions: /impression/i,
  clicks: /^clicks?$/i,
  campaign_id: /campaign.*id/i,
  adset_id: /ad.?set.*id|ad.?group.*id/i,
};

const COL_LABELS = {
  campaign_name: "Campaign Name",
  adset_name: "Ad Set / Ad Group Name",
  spend: "Spend / Cost",
  date: "Date",
  platform: "Platform / Traffic Source",
  impressions: "Impressions",
  clicks: "Clicks",
  campaign_id: "Campaign ID",
  adset_id: "Ad Set ID",
};

const DEFAULT_DIMENSIONS = ["Product", "Region", "Funnel", "Pillar"];

const PLATFORM_COLORS = {
  LinkedIn: "#0a66c2",
  "Google Search": "#4285f4",
  "Google Display": "#34a853",
  "Demand Gen": "#fbbc04",
  "Performance Max": "#ea4335",
  Meta: "#1877f2",
  Bing: "#00809d",
  YouTube: "#ff0000",
  Capterra: "#ff6d2d",
  Unknown: "#6b7280",
};

function autoDetectColumns(headers) {
  const map = {};
  headers.forEach((h) => {
    for (const [field, pattern] of Object.entries(COL_PATTERNS)) {
      if (!map[field] && pattern.test(h.trim())) map[field] = h;
    }
  });
  // fallback: partial match
  if (!map.campaign_name) {
    const h = headers.find((h) => /campaign/i.test(h) && !/id|group|type/i.test(h));
    if (h) map.campaign_name = h;
  }
  if (!map.spend) {
    const h = headers.find((h) => /cost|spend/i.test(h));
    if (h) map.spend = h;
  }
  if (!map.date) {
    const h = headers.find((h) => /date|day/i.test(h));
    if (h) map.date = h;
  }
  return map;
}

function derivePlatform(name, platformVal) {
  const n = (name || "").toUpperCase();
  const p = (platformVal || "").toLowerCase();
  if (/^LIN[-|]|^LIN\s/.test(n) || p.includes("linkedin")) return "LinkedIn";
  if (/^FB[-|]|^FB\s/.test(n) || p.includes("facebook") || p.includes("meta")) return "Meta";
  if (/^BIN[-|]|^BIN\s/.test(n) || p.includes("bing") || p.includes("microsoft")) return "Bing";
  if (/^YT[-|]|^YT\s/.test(n) || p.includes("youtube")) return "YouTube";
  if (/^SEA[-|]|^SEA\s/.test(n) || p === "search") return "Google Search";
  if (/^GDN[-|]|^GDN\s/.test(n) || p === "display") return "Google Display";
  if (/demand.gen/i.test(n) || p === "demand gen") return "Demand Gen";
  if (/pmax|performance.max/i.test(n) || p === "performance max") return "Performance Max";
  if (p.includes("google")) return "Google Search";
  if (p.includes("capterra")) return "Capterra";
  return platformVal || "Unknown";
}

function parseSpend(val) {
  if (!val) return 0;
  return parseFloat(String(val).replace(/[$,\s]/g, "")) || 0;
}

function fmt$(n) {
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

export default function PaidHQ() {
  const [step, setStep] = useState("upload");
  const [fileName, setFileName] = useState("");
  const [rawRows, setRawRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [columnMap, setColumnMap] = useState({});
  const [tagDimensions, setTagDimensions] = useState(DEFAULT_DIMENSIONS);
  const [campaignTags, setCampaignTags] = useState({});
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [newDimName, setNewDimName] = useState("");
  const [applyDim, setApplyDim] = useState("");
  const [applyVal, setApplyVal] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [notification, setNotification] = useState(null);
  const fileRef = useRef();

  useEffect(() => {
    try {
      const t = localStorage.getItem("paidhq_tags");
      if (t) setCampaignTags(JSON.parse(t));
      const d = localStorage.getItem("paidhq_dims");
      if (d) setTagDimensions(JSON.parse(d));
    } catch (e) {}
  }, []);

  useEffect(() => {
    localStorage.setItem("paidhq_tags", JSON.stringify(campaignTags));
  }, [campaignTags]);

  useEffect(() => {
    localStorage.setItem("paidhq_dims", JSON.stringify(tagDimensions));
  }, [tagDimensions]);

  const handleFile = useCallback((file) => {
    if (!file) return;
    setFileName(file.name);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        setRawRows(result.data);
        setHeaders(result.meta.fields || []);
        setColumnMap(autoDetectColumns(result.meta.fields || []));
        setStep("map");
      },
    });
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const campaigns = useMemo(() => {
    if (!rawRows.length || !columnMap.campaign_name) return [];
    const map = {};
    rawRows.forEach((row) => {
      const name = (row[columnMap.campaign_name] || "").trim();
      if (!name) return;
      const spend = parseSpend(row[columnMap.spend]);
      const platform = derivePlatform(name, columnMap.platform ? row[columnMap.platform] : "");
      if (!map[name]) map[name] = { name, platform, spend: 0, rows: 0, adsets: new Set() };
      map[name].spend += spend;
      map[name].rows++;
      if (columnMap.adset_name && row[columnMap.adset_name])
        map[name].adsets.add(row[columnMap.adset_name]);
    });
    return Object.values(map)
      .map((c) => ({ ...c, adsetCount: c.adsets.size }))
      .sort((a, b) => b.spend - a.spend);
  }, [rawRows, columnMap]);

  const stats = useMemo(() => {
    const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
    const tagged = campaigns.filter((c) => Object.keys(campaignTags[c.name] || {}).length > 0).length;
    const dates = rawRows.map((r) => r[columnMap.date]).filter(Boolean).sort();
    return {
      total: campaigns.length,
      tagged,
      untagged: campaigns.length - tagged,
      totalSpend,
      totalRows: rawRows.length,
      dateRange: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "",
    };
  }, [campaigns, campaignTags, rawRows, columnMap]);

  const filtered = useMemo(() => {
    if (!filter) return campaigns;
    const q = filter.toLowerCase();
    return campaigns.filter((c) => c.name.toLowerCase().includes(q));
  }, [campaigns, filter]);

  const suggestions = useMemo(() => {
    if (!filter || filter.length < 3) return [];
    const term = filter.toLowerCase();
    const seen = new Set();
    const sugg = [];
    tagDimensions.forEach((dim) => {
      Object.entries(campaignTags).forEach(([campName, tags]) => {
        if (tags[dim] && campName.toLowerCase().includes(term)) {
          const key = `${dim}:${tags[dim]}`;
          if (!seen.has(key)) {
            seen.add(key);
            const count = filtered.filter((c) => !(campaignTags[c.name]?.[dim])).length;
            if (count > 0) sugg.push({ key, dim, val: tags[dim], count });
          }
        }
      });
    });
    return sugg.slice(0, 3);
  }, [filter, filtered, campaignTags, tagDimensions]);

  const showNotif = (msg) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  const applyTags = useCallback(() => {
    if (!applyDim || !applyVal || !selected.size) return;
    const updates = {};
    selected.forEach((name) => {
      updates[name] = { ...(campaignTags[name] || {}), [applyDim]: applyVal };
    });
    setCampaignTags((prev) => ({ ...prev, ...updates }));
    showNotif(`Tagged ${selected.size} campaigns — ${applyDim}: ${applyVal}`);
    setSelected(new Set());
    setApplyVal("");
  }, [applyDim, applyVal, selected, campaignTags]);

  const applySuggestion = useCallback(
    (dim, val) => {
      const updates = {};
      filtered.forEach((c) => {
        if (!(campaignTags[c.name]?.[dim]))
          updates[c.name] = { ...(campaignTags[c.name] || {}), [dim]: val };
      });
      setCampaignTags((prev) => ({ ...prev, ...updates }));
      showNotif(`Applied ${dim}: ${val} to ${Object.keys(updates).length} campaigns`);
    },
    [filtered, campaignTags]
  );

  const removeTag = useCallback((campName, dim) => {
    setCampaignTags((prev) => {
      const tags = { ...(prev[campName] || {}) };
      delete tags[dim];
      return { ...prev, [campName]: tags };
    });
  }, []);

  const toggleSelect = (name) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const selectAll = () =>
    setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map((c) => c.name)));

  const addDimension = () => {
    const name = newDimName.trim();
    if (!name || tagDimensions.includes(name)) return;
    setTagDimensions((prev) => [...prev, name]);
    setNewDimName("");
  };

  const canProceed = columnMap.campaign_name && columnMap.spend;

  return (
    <div style={{ minHeight: "100vh", background: "#0d1117", color: "#e6edf3", fontFamily: '"DM Sans", system-ui, sans-serif' }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ borderBottom: "1px solid #21262d", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", background: "#161b22", position: "sticky", top: 0, zIndex: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 17, fontWeight: 700, color: "#58a6ff", letterSpacing: "-0.5px", fontFamily: "DM Mono, monospace" }}>PaidHQ</span>
          <span style={{ fontSize: 11, color: "#8b949e", background: "#21262d", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>budget intelligence</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {["Upload", "Map columns", "Tag campaigns"].map((label, i) => {
            const stepKey = ["upload", "map", "tag"][i];
            const active = step === stepKey;
            const done = ["upload", "map", "tag"].indexOf(step) > i;
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {i > 0 && <span style={{ color: "#30363d", fontSize: 12 }}>›</span>}
                <span style={{ fontSize: 12, fontWeight: active ? 600 : 400, color: done ? "#3fb950" : active ? "#58a6ff" : "#8b949e" }}>
                  {done ? "✓ " : ""}{label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Notification toast */}
      {notification && (
        <div style={{ position: "fixed", top: 68, right: 20, background: "#238636", color: "#fff", padding: "10px 16px", borderRadius: 8, fontSize: 13, zIndex: 100, boxShadow: "0 4px 16px rgba(0,0,0,0.5)", animation: "fadeIn 0.2s ease" }}>
          {notification}
        </div>
      )}

      {/* ── STEP 1: UPLOAD ── */}
      {step === "upload" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 56px)", padding: 24 }}>
          <div style={{ maxWidth: 580, width: "100%" }}>
            <h1 style={{ fontSize: 34, fontWeight: 700, marginBottom: 8, letterSpacing: "-1px" }}>Import your spend data</h1>
            <p style={{ color: "#8b949e", marginBottom: 36, fontSize: 15, lineHeight: 1.6 }}>
              Upload a CSV from any ad platform. We'll auto-detect your columns and help you tag campaigns into segments.
            </p>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
              style={{ border: `2px dashed ${dragOver ? "#58a6ff" : "#30363d"}`, borderRadius: 12, padding: "56px 32px", textAlign: "center", cursor: "pointer", background: dragOver ? "rgba(88,166,255,0.04)" : "#161b22", transition: "all 0.2s ease" }}
            >
              <div style={{ fontSize: 44, marginBottom: 16 }}>📊</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Drop your CSV here</div>
              <div style={{ fontSize: 13, color: "#8b949e" }}>or click to browse</div>
              <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
            </div>
            <div style={{ marginTop: 20, padding: "14px 16px", background: "#161b22", borderRadius: 8, border: "1px solid #21262d" }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>Works with exports from:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {["Google Ads", "LinkedIn Campaign Manager", "Meta Ads", "Microsoft Ads", "Capterra", "Funnel.io"].map((p) => (
                  <span key={p} style={{ fontSize: 11, background: "#21262d", color: "#8b949e", padding: "3px 9px", borderRadius: 4, fontWeight: 500 }}>{p}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 2: MAP COLUMNS ── */}
      {step === "map" && (
        <div style={{ maxWidth: 700, margin: "40px auto", padding: "0 24px" }}>
          <div style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.5px" }}>Map your columns</h2>
            <p style={{ color: "#8b949e", fontSize: 14 }}>
              <strong style={{ color: "#e6edf3" }}>{fileName}</strong> — {rawRows.length.toLocaleString()} rows. We've auto-mapped what we can.
            </p>
          </div>
          <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 10, overflow: "hidden", marginBottom: 24 }}>
            {[...REQUIRED_COLS, ...OPTIONAL_COLS].map((field, i) => (
              <div key={field} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", padding: "12px 20px", borderBottom: i < REQUIRED_COLS.length + OPTIONAL_COLS.length - 1 ? "1px solid #21262d" : "none", alignItems: "center", background: REQUIRED_COLS.includes(field) && !columnMap[field] ? "rgba(248,81,73,0.04)" : "transparent" }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{COL_LABELS[field]}</span>
                  {REQUIRED_COLS.includes(field) && <span style={{ fontSize: 10, color: "#f85149", marginLeft: 6, fontWeight: 600 }}>required</span>}
                  {!REQUIRED_COLS.includes(field) && <span style={{ fontSize: 10, color: "#8b949e", marginLeft: 6 }}>optional</span>}
                </div>
                <select
                  value={columnMap[field] || ""}
                  onChange={(e) => setColumnMap((prev) => ({ ...prev, [field]: e.target.value || undefined }))}
                  style={{ background: "#0d1117", border: `1px solid ${REQUIRED_COLS.includes(field) && !columnMap[field] ? "#f85149" : "#30363d"}`, borderRadius: 6, color: columnMap[field] ? "#e6edf3" : "#8b949e", padding: "7px 10px", fontSize: 13, width: "100%", fontFamily: "DM Mono, monospace" }}
                >
                  <option value="">— not mapped —</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          {canProceed && (
            <div style={{ padding: "12px 16px", background: "rgba(35,134,54,0.1)", border: "1px solid rgba(35,134,54,0.3)", borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#3fb950" }}>
              ✓ Ready — found <strong>{campaigns.length}</strong> unique campaigns across <strong>{fmt$(campaigns.reduce((s, c) => s + c.spend, 0))}</strong> spend
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <button onClick={() => setStep("upload")} style={{ background: "transparent", border: "1px solid #30363d", color: "#8b949e", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
              ← Back
            </button>
            <button
              onClick={() => setStep("tag")}
              disabled={!canProceed}
              style={{ background: canProceed ? "#238636" : "#21262d", border: "none", color: "#fff", padding: "8px 22px", borderRadius: 6, cursor: canProceed ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600, opacity: canProceed ? 1 : 0.5 }}
            >
              Continue to tagging →
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 3: TAG ── */}
      {step === "tag" && (
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", height: "calc(100vh - 56px)" }}>

          {/* Sidebar */}
          <div style={{ borderRight: "1px solid #21262d", background: "#161b22", overflow: "auto", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: 16, borderBottom: "1px solid #21262d" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#8b949e", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>Tag Dimensions</div>
              {tagDimensions.map((dim) => (
                <div
                  key={dim}
                  onClick={() => setApplyDim(dim)}
                  style={{ padding: "7px 10px", borderRadius: 6, marginBottom: 2, background: applyDim === dim ? "rgba(88,166,255,0.1)" : "transparent", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span style={{ fontSize: 13, color: applyDim === dim ? "#58a6ff" : "#e6edf3" }}>{dim}</span>
                  <span style={{ fontSize: 11, color: "#8b949e", fontFamily: "DM Mono, monospace" }}>
                    {Object.values(campaignTags).filter((t) => t[dim]).length}
                  </span>
                </div>
              ))}
              <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                <input
                  value={newDimName}
                  onChange={(e) => setNewDimName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addDimension()}
                  placeholder="New dimension…"
                  style={{ flex: 1, background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, color: "#e6edf3", padding: "6px 8px", fontSize: 12 }}
                />
                <button onClick={addDimension} style={{ background: "#21262d", border: "1px solid #30363d", color: "#8b949e", borderRadius: 6, padding: "0 10px", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>+</button>
              </div>
            </div>
            <div style={{ padding: 16, flex: 1 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#8b949e", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Overview</div>
              {[
                { label: "Campaigns", value: stats.total.toString() },
                { label: "Tagged", value: stats.tagged.toString(), color: "#3fb950" },
                { label: "Needs review", value: stats.untagged.toString(), color: stats.untagged > 0 ? "#d29922" : "#3fb950" },
                { label: "Total spend", value: fmt$(stats.totalSpend) },
                { label: "Data rows", value: stats.totalRows.toLocaleString() },
              ].map((s) => (
                <div key={s.label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#8b949e" }}>{s.label}</span>
                  <span style={{ fontSize: 12, fontFamily: "DM Mono, monospace", color: s.color || "#e6edf3", fontWeight: 600 }}>{s.value}</span>
                </div>
              ))}
              {stats.dateRange && <div style={{ fontSize: 11, color: "#8b949e", marginTop: 10, fontFamily: "DM Mono, monospace", lineHeight: 1.6 }}>{stats.dateRange}</div>}
              <div style={{ marginTop: 16, height: 4, background: "#21262d", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${stats.total ? (stats.tagged / stats.total) * 100 : 0}%`, background: "#238636", transition: "width 0.4s ease", borderRadius: 2 }} />
              </div>
              <div style={{ fontSize: 11, color: "#8b949e", marginTop: 6 }}>
                {stats.total ? Math.round((stats.tagged / stats.total) * 100) : 0}% tagged
              </div>
            </div>
          </div>

          {/* Main panel */}
          <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Toolbar */}
            <div style={{ padding: "12px 20px", borderBottom: "1px solid #21262d", display: "flex", gap: 10, alignItems: "center", background: "#161b22" }}>
              <input
                value={filter}
                onChange={(e) => { setFilter(e.target.value); setSelected(new Set()); }}
                placeholder="Filter by keyword to select and tag campaigns in bulk…"
                style={{ flex: 1, background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, color: "#e6edf3", padding: "8px 12px", fontSize: 13, fontFamily: "DM Mono, monospace" }}
              />
              {filter && (
                <button onClick={() => { setFilter(""); setSelected(new Set()); }} style={{ background: "transparent", border: "none", color: "#8b949e", cursor: "pointer", fontSize: 20, lineHeight: 1 }}>×</button>
              )}
              <span style={{ fontSize: 12, color: "#8b949e", whiteSpace: "nowrap", fontFamily: "DM Mono, monospace" }}>
                {filtered.length} / {campaigns.length}
              </span>
            </div>

            {/* Suggestions bar */}
            {suggestions.length > 0 && (
              <div style={{ padding: "8px 20px", background: "rgba(88,166,255,0.04)", borderBottom: "1px solid #21262d", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#8b949e" }}>Suggest:</span>
                {suggestions.map((s) => (
                  <button key={s.key} onClick={() => applySuggestion(s.dim, s.val)}
                    style={{ fontSize: 12, background: "rgba(88,166,255,0.1)", border: "1px solid rgba(88,166,255,0.3)", color: "#58a6ff", borderRadius: 20, padding: "3px 12px", cursor: "pointer" }}>
                    Apply {s.dim}: {s.val} to {s.count} untagged
                  </button>
                ))}
              </div>
            )}

            {/* Bulk action bar */}
            {selected.size > 0 && (
              <div style={{ padding: "10px 20px", background: "#1c2128", borderBottom: "1px solid #30363d", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>{selected.size} selected</span>
                <span style={{ color: "#8b949e", fontSize: 13 }}>→</span>
                <select value={applyDim} onChange={(e) => setApplyDim(e.target.value)}
                  style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, color: applyDim ? "#e6edf3" : "#8b949e", padding: "6px 10px", fontSize: 13 }}>
                  <option value="">Select dimension</option>
                  {tagDimensions.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <input
                  value={applyVal}
                  onChange={(e) => setApplyVal(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyTags()}
                  placeholder="Tag value…"
                  style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, color: "#e6edf3", padding: "6px 10px", fontSize: 13, width: 160, fontFamily: "DM Mono, monospace" }}
                />
                <button onClick={applyTags} disabled={!applyDim || !applyVal}
                  style={{ background: applyDim && applyVal ? "#238636" : "#21262d", border: "none", color: "#fff", padding: "6px 16px", borderRadius: 6, cursor: applyDim && applyVal ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600, opacity: applyDim && applyVal ? 1 : 0.5 }}>
                  Apply tag
                </button>
                <button onClick={() => setSelected(new Set())} style={{ background: "transparent", border: "none", color: "#8b949e", cursor: "pointer", fontSize: 13 }}>
                  Clear
                </button>
              </div>
            )}

            {/* Column headers */}
            <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 100px 110px 1fr", padding: "8px 20px", borderBottom: "1px solid #21262d", background: "#161b22", position: "sticky", top: 0, zIndex: 10 }}>
              <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={selectAll} style={{ cursor: "pointer", accentColor: "#58a6ff" }} />
              {["Campaign", "Spend", "Platform", "Tags"].map((h) => (
                <span key={h} style={{ fontSize: 10, color: "#8b949e", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8 }}>{h}</span>
              ))}
            </div>

            {/* Campaign rows */}
            <div style={{ overflow: "auto", flex: 1 }}>
              {filtered.map((c) => {
                const tags = campaignTags[c.name] || {};
                const tagCount = Object.keys(tags).length;
                const isSelected = selected.has(c.name);
                const pc = PLATFORM_COLORS[c.platform] || "#6b7280";
                return (
                  <div
                    key={c.name}
                    onClick={() => toggleSelect(c.name)}
                    style={{ display: "grid", gridTemplateColumns: "36px 1fr 100px 110px 1fr", padding: "10px 20px", borderBottom: "1px solid #21262d", alignItems: "center", cursor: "pointer", background: isSelected ? "rgba(88,166,255,0.05)" : "transparent", transition: "background 0.1s" }}
                  >
                    <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(c.name)} onClick={(e) => e.stopPropagation()} style={{ cursor: "pointer", accentColor: "#58a6ff" }} />
                    <div style={{ minWidth: 0, paddingRight: 16 }}>
                      <div style={{ fontSize: 12, fontFamily: "DM Mono, monospace", color: "#e6edf3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                      {c.adsetCount > 0 && <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>{c.adsetCount} ad sets</div>}
                    </div>
                    <div style={{ fontSize: 13, fontFamily: "DM Mono, monospace", fontWeight: 600, color: "#e6edf3" }}>{fmt$(c.spend)}</div>
                    <div>
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: pc + "22", color: pc, border: `1px solid ${pc}44`, fontWeight: 500 }}>{c.platform}</span>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                      {tagCount === 0 ? (
                        <span style={{ fontSize: 11, color: "#d29922", background: "#2d2100", border: "1px solid #6e451e", padding: "2px 8px", borderRadius: 4 }}>needs review</span>
                      ) : (
                        Object.entries(tags).map(([dim, val]) => (
                          <span key={dim} style={{ fontSize: 11, color: "#58a6ff", background: "rgba(88,166,255,0.1)", border: "1px solid rgba(88,166,255,0.25)", padding: "2px 8px", borderRadius: 4, display: "flex", alignItems: "center", gap: 4 }}>
                            {dim}: {val}
                            <span onClick={(e) => { e.stopPropagation(); removeTag(c.name, dim); }} style={{ color: "#8b949e", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>×</span>
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && filter && (
                <div style={{ padding: "56px 20px", textAlign: "center", color: "#8b949e" }}>
                  No campaigns match "<span style={{ fontFamily: "DM Mono, monospace", color: "#e6edf3" }}>{filter}</span>"
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
        select, input, button { font-family: inherit; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
        input[type="checkbox"] { width: 14px; height: 14px; }
      `}</style>
    </div>
  );
}
