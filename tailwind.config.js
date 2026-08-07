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
  // Tremor color safelist (2026-08-06, per Mo — "the pie chart" looking wrong/monochrome in
  // production): @tremor/react's chart components (DonutChart, BarList, etc.) build their color
  // classes at runtime via string concatenation (e.g. `fill-${color}-500`), not as literal strings
  // in their source — Tailwind's content scanner can only ever find literal class-name strings, so
  // it was purging every one of these as unused and the donut/bar charts fell back to no fill at
  // all (rendering as flat black/grey). This is Tremor's own documented fix: safelist the color x
  // shade matrix their components can generate. Scoped to just the colors this app actually passes
  // to Tremor (DONUT_COLORS in AccountPlanning.jsx, plus Tremor's own default brand blue) rather
  // than every Tailwind color — the full 21-color matrix works too but roughly triples index.css's
  // output size for shades this app will never reference.
  safelist: [
    { pattern: /^(bg|text|border|ring|stroke|fill)-(emerald|amber|rose|slate|blue)-(300|400|500|600|700)$/ },
  ],
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
        // Flattened 2026-08-07 (per Mo — Venture CRM retheme, "implement it exactly as it is"):
        // the kit uses one flat radius everywhere (buttons/cards/inputs all sampled at the same
        // border-radius/4-px token), not a graduated scale. lg/md/sm all just equal --radius now —
        // no more calc() subtraction, which would have made `rounded-sm` literally 0px once
        // --radius dropped from 0.75rem to 0.25rem.
        lg: "var(--radius)",
        md: "var(--radius)",
        sm: "var(--radius)",
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        // display (2026-08-07, per Mo — Venture CRM retheme): Venture's Style Guide uses Inter for
        // headings too, no separate display face — Space Grotesk retired (see index.css's @import
        // comment). Pointed at the same stack as `sans` rather than deleting the `display` key
        // outright, so the ~9 existing font-display usages across AccountPlanning.jsx/
        // CampaignAudit.jsx don't need to be hunted down and edited — they just render in Inter now.
        display: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
      // Heading scale (2026-08-07, added for the Venture CRM retheme): Venture's Typography frame
      // names these Heading/Desktop/H2-H6, all Inter Medium (500), 1.2 line-height. Tailwind's
      // default text-4xl/3xl/etc. don't line up with the kit's actual px sizes (48/32/28/24/20), so
      // these are new named sizes (text-h2..text-h6) rather than a remap of Tailwind's built-ins.
      // Venture's Body scale (12/14/16/18) already matches Tailwind's default text-xs/sm/base/lg
      // almost exactly, so body text needed no changes — just use the existing text-sm/text-base/etc.
      fontSize: {
        h2: ["48px", { lineHeight: "1.2", fontWeight: "500" }],
        h3: ["32px", { lineHeight: "1.2", fontWeight: "500" }],
        h4: ["28px", { lineHeight: "1.2", fontWeight: "500" }],
        h5: ["24px", { lineHeight: "1.2", fontWeight: "500" }],
        h6: ["20px", { lineHeight: "1.2", fontWeight: "500" }],
      },
      boxShadow: {
        // Changed to `none` 2026-08-07 (per Mo — Venture CRM retheme, "implement it exactly as it
        // is"): every card sampled from the kit (Cards frame's Integrations/Contact/Task cards) uses
        // a 1px Border/Primary border with NO drop shadow — a flatter, more minimal look than the
        // 2026-08-06 "world class" pass's raised-card treatment. Safe to zero out rather than delete
        // the `shadow-card` class entirely: ui/card.jsx already pairs it with `border border-border`
        // (see that file), so cards keep their visual definition from the border alone.
        card: "none",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
