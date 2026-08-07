/**
 * Tailwind config (2026-08-06, per Mo — rebuilding PaidHQ's UI on Tailwind + shadcn/ui + Tremor,
 * starting with Account Planning and rolling out tab by tab from there).
 *
 * Tailwind v3, not v4: @tremor/react's own setup (its content path + `tremor-*` color plugin) is
 * built for v3's JS-config/plugin model. v4's CSS-first config still supports old plugins via an
 * `@config` escape hatch, but combining a v3-oriented third-party package with v4's newer model is
 * an extra axis of integration risk for zero visible benefit right now — v3 is still fully
 * supported and every piece here (shadcn, Tremor, this app) is proven to work together on it.
 * Worth revisiting once Tremor's own docs standardize on v4.
 *
 * preflight: false — PaidHQ's existing index.css already has its own global reset (box-sizing:
 * border-box, margin/padding:0), and every legacy (non-Tailwind) tab is styled with fully-specified
 * inline style objects that don't lean on browser default element styling. Turning Tailwind's own
 * preflight on would be redundant at best; leaving it off means this migration can proceed
 * incrementally (per Mo's call) without risking a global CSS reset subtly shifting the look of every
 * tab that hasn't been rebuilt yet. New shadcn/Tremor-based components carry their own explicit
 * utility classes, so they don't depend on preflight to look right.
 *
 * Color system: a fresh palette (per Mo's call, not a port of the old T-theme colors) — neutral
 * slate surfaces + an indigo primary, defined as HSL CSS variables in src/index.css so every
 * shadcn-style component (which reads `hsl(var(--primary))` etc.) and any future dark-mode pass
 * share one source of truth.
 */
import tailwindcssAnimate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
    // @tremor/react ships its own component classes that Tailwind needs to scan to generate —
    // without this, Tremor's charts/cards render with zero styling in production (dev mode can
    // mask this since nothing is purged there). See Tremor's own installation docs.
    "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}",
  ],
  corePlugins: { preflight: false },
  theme: {
    transparent: "transparent",
    current: "currentColor",
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        success: { DEFAULT: "hsl(var(--success))", foreground: "hsl(var(--success-foreground))" },
        warning: { DEFAULT: "hsl(var(--warning))", foreground: "hsl(var(--warning-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        // tremor-* aliases (2026-08-06) — @tremor/react components read colors under this
        // namespace (e.g. bg-tremor-brand, text-tremor-content); pointed at the same CSS variables
        // as the shadcn tokens above so Tremor's charts/KPI cards inherit the same fresh palette
        // instead of shipping their own default blue.
        tremor: {
          brand: {
            faint: "hsl(var(--primary) / 0.08)",
            muted: "hsl(var(--primary) / 0.35)",
            subtle: "hsl(var(--primary) / 0.6)",
            DEFAULT: "hsl(var(--primary))",
            emphasis: "hsl(var(--primary))",
            inverted: "hsl(var(--primary-foreground))",
          },
          background: { muted: "hsl(var(--muted))", subtle: "hsl(var(--secondary))", DEFAULT: "hsl(var(--background))", emphasis: "hsl(var(--foreground))" },
          border: { DEFAULT: "hsl(var(--border))" },
          ring: { DEFAULT: "hsl(var(--ring))" },
          content: {
            subtle: "hsl(var(--muted-foreground) / 0.7)",
            DEFAULT: "hsl(var(--muted-foreground))",
            emphasis: "hsl(var(--foreground) / 0.85)",
            strong: "hsl(var(--foreground))",
            inverted: "hsl(var(--background))",
          },
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        // Display face (2026-08-06, per Mo's "beautiful typography" ask) — Space Grotesk for
        // headings/big KPI numbers only, loaded via @import in index.css. Kept separate from
        // `sans` on purpose: a geometric display face reads as confident at large sizes but hurts
        // legibility in dense tables/forms, so body/UI text stays on Inter.
        display: ["Space Grotesk", "Inter", "-apple-system", "sans-serif"],
      },
      boxShadow: {
        // Bumped 2026-08-06 (per Mo — "it really doesn't look very good") — the original values
        // were nearly invisible against a white page background, which combined with a raw
        // white-on-white page (see the p-4/p-7 wrapper divs in AccountPlanning.jsx, now bg-muted/40
        // instead of bg-background) made every card read as flat/undesigned rather than a raised
        // surface. Still subtle, just no longer imperceptible.
        card: "0 1px 3px 0 rgb(0 0 0 / 0.07), 0 1px 2px -1px rgb(0 0 0 / 0.08)",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
