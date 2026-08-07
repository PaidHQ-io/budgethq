// src/components/ui/searchable-select.jsx — lightweight searchable select / multi-select combobox.
// Built by hand (2026-08-06, per Mo — LinkedIn's ~300-item industry taxonomy needs to be "searchable
// drop down"; a plain shadcn/Radix Select has a scrollable list but no built-in filtering, which is
// unusable at that size) rather than pulling in cmdk/Radix Popover: neither is an existing
// dependency in this project yet, and a self-contained click-outside + filtered-list combobox covers
// everything needed here without a new package to vet and deploy. Supports single-select
// (value: string, onChange(nextValue)) and multi-select (value: string[], onChange(nextArray),
// multiple) off one component so Mapping's per-row token picker and Targeting's Industry field can
// share the same behavior instead of two bespoke implementations.
// Icon swap 2026-08-07 (Venture CRM retheme): lucide-react -> @phosphor-icons/react, matching every
// other newly-touched component this pass (see badge.jsx/select.jsx's sibling comments). Full
// visual rebuild against Venture's own Menu Item "Search Result" variant deferred to whichever page
// migration first uses this component (Targeting Library / Mapping) — this component's radius/
// accent colors already inherit the new tokens automatically via rounded-md/bg-accent/bg-secondary,
// since those Tailwind classes now resolve through the retheme'd CSS variables.
import { useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlass, X, Check, CaretDown } from "@phosphor-icons/react";
import { cn } from "../../lib/utils.js";
import { Badge } from "./badge.jsx";

export function SearchableSelect({
  options, value, onChange, multiple = false, placeholder = "Search…", disabled = false, className, emptyLabel = "None",
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setQuery(""); }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selected = multiple ? (value || []) : (value ? [value] : []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return list.slice(0, 200);
  }, [options, query]);

  const toggle = (opt) => {
    if (multiple) {
      onChange(selected.includes(opt) ? selected.filter((v) => v !== opt) : [...selected, opt]);
    } else {
      onChange(opt);
      setOpen(false);
      setQuery("");
    }
  };
  const removeChip = (opt) => onChange(selected.filter((v) => v !== opt));

  if (disabled) {
    return multiple ? (
      <div className="flex flex-wrap gap-1.5">
        {selected.length === 0 ? <span className="text-xs text-muted-foreground">{emptyLabel}</span> : selected.map((v) => <Badge key={v} variant="secondary">{v}</Badge>)}
      </div>
    ) : (
      <span className="text-sm text-foreground">{value || <span className="text-muted-foreground">{emptyLabel}</span>}</span>
    );
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {multiple && selected.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {selected.map((v) => (
            <Badge key={v} variant="secondary" className="gap-1 pr-1.5">
              {v}
              <X className="h-3 w-3 cursor-pointer opacity-60 hover:opacity-100" onClick={() => removeChip(v)} />
            </Badge>
          ))}
        </div>
      )}
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60">
        <span className="flex items-center gap-1.5 truncate">
          <MagnifyingGlass className="h-3 w-3 shrink-0" />
          {multiple ? (selected.length ? `${selected.length} selected — search to add more…` : placeholder) : (value || placeholder)}
        </span>
        <CaretDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-md border border-border bg-white shadow-md animate-in fade-in zoom-in-95 duration-100">
          <div className="border-b border-border p-1.5">
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type to search…"
              className="h-7 w-full rounded border-0 bg-secondary px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground" />
          </div>
          <div className="max-h-56 overflow-auto py-1">
            {filtered.length === 0 && <div className="px-2.5 py-2 text-xs text-muted-foreground">No matches</div>}
            {filtered.map((opt) => {
              const isSel = selected.includes(opt);
              return (
                <div key={opt} onClick={() => toggle(opt)}
                  className={cn("flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground", isSel && "bg-accent/60 font-medium text-accent-foreground")}>
                  <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border", isSel ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
                    {isSel && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="truncate">{opt}</span>
                </div>
              );
            })}
            {filtered.length === 200 && options.length > 200 && (
              <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">Showing first 200 — keep typing to narrow further</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
