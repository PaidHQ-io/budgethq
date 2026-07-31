import { useState, useCallback } from "react";

// src/lib/persist.js — usePersistentState: device-local (localStorage) persisted useState
// (2026-07-30, per Mo: "any tab I've selected" should keep its filters/view settings across a
// browser refresh, not just which tab is active). Mirrors the existing hand-rolled localStorage
// try/catch pattern already used in PaidHQ.jsx for
// paidhq_last_view/paidhq_sidebar_width/paidhq_tagger_filters_open — deliberately unscoped by
// workspace, same as those, since this is a device/browser preference, not workspace data synced
// with the server (switching workspaces keeps your last filter shape, same as switching
// workspaces already keeps your last active tab).
//
// Lives in its own file (not shared.jsx) because shared.jsx only exports components — mixing in a
// hook there breaks Vite's fast-refresh boundary (react-refresh/only-export-components).
//
// JSON-serialized, so this is for plain strings/numbers/booleans/arrays/plain-objects only — NOT
// Sets/Maps. Transient UI state (selection sets, expanded rows, open modals, editing-in-place
// state) is deliberately kept on plain useState and left OUT of persistence — restoring "what row
// you had mid-edit" on a page that's since reloaded fresh data is confusing, not helpful.
export function usePersistentState(key, defaultValue) {
  // defaultValue may be a plain value OR a lazy initializer function, same convention as
  // useState's own lazy-init form — only invoked on first mount when nothing's stored yet.
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw);
    } catch {
      /* fall through to default below */
    }
    return typeof defaultValue === "function" ? defaultValue() : defaultValue;
  });
  const setPersisted = useCallback(
    (v) => {
      setValue((prev) => {
        const next = typeof v === "function" ? v(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* localStorage unavailable/full — state still updates in-memory */
        }
        return next;
      });
    },
    [key]
  );
  return [value, setPersisted];
}
