import Papa from "papaparse";
import * as XLSX from "xlsx";
import { stepPeriodStart, normalizePeriodStart } from "./reportingPeriods.js";

// src/lib/core.js — pure data/pacing logic extracted from the monolithic PaidHQ.jsx
// (2026-07-25 split, per Mo). No React, no JSX — every export here is a plain function or
// constant, safe to import from lib code, tab components, or the root app equally. Combines
// what were three conceptual layers in the original file (CSV/column-detection constants +
// general data utilities, spend-row merge/dedupe + budget-segment helpers, and the pacing/
// forecasting engine) into one module rather than three, since splitting them further would
// have meant several small cross-file imports for no real isolation benefit — nothing here
// depends on anything outside this file.

// Vercel-matched palette (redesign, July 2026) — monochrome black/white/gray surfaces like the
// Vercel dashboard, with a black primary accent instead of a colored one. Lives here (not
// components/shared.jsx) so lib/reports.js can use it directly too — report builders run outside
// the React render tree and need a fixed T to pass into pacingStatusMeta, not a live prop.
//
// Line/background retune (2026-07-26, per Mo — modeled on zams.com's grid/table sections, e.g.
// its "[03] Integrations" grid). bg/surface were already an exact match for zams' own #FAFAFA
// page background + #FFFFFF card fill (measured by sampling their screenshot's pixels directly —
// pure coincidence, not tuned for this). What was actually different, and what reads as
// "Vercel-flat" vs zams' "structured graph-paper grid", is border/borderStrong: Vercel's hairlines
// (#EAEAEA/#D4D4D4) are barely-there by design, while zams' cell dividers are a real, deliberate
// warm gray-mauve line — confirmed via the same pixel sample: a 1px solid rgb(165,159,167). Kept
// exactly that value for borderStrong (used for the more emphatic dividers/table frames) and a
// lighter tint of the same hue for the everyday border token, since PaidHQ has far more
// bordered elements per screen (every input/table cell/card) than zams' generously-spaced promo
// grid — using the full-strength line everywhere would read as busy rather than structured.
// textMuted nudged toward the same warm-gray hue too, since SectionLabel (fontSize 10, bold,
// uppercase, 0.08em tracking) already IS PaidHQ's version of zams' "[0X] SECTION NAME" eyebrow
// label — same role, just needed the color to actually match. Accent blue is untouched, per Mo.
// Radius scale (2026-07-31, per Mo — added alongside the Aida theme below). Keyed by each
// value's CURRENT literal pixel size across the app (r6, r8, r10, ...) rather than a semantic
// name like "sm"/"md" — this is what let the whole app's ~287 scattered `borderRadius:N` inline
// literals get swapped to token references mechanically (grep+sed on the exact number) instead
// of hand-judging which semantic tier each one of 287 call sites "should" be. THEME_CLASSIC's
// values below are identical to the numbers they replace, so switching back to Classic is
// pixel-identical to how the app looked before this existed. r20/r22 are left alone in both
// themes (not blown out to a pill radius) — every call site using them is a fixed-size circular
// avatar/icon button where the radius already equals exactly half the element's own
// width/height, so they're already perfect circles; the visual "pill-ness" Aida wants instead
// comes from ordinary buttons/inputs/cards moving from r6-r10 up into genuinely pill territory.
// rCard (2026-08-01, per Mo's Aida-vs-reference comparison) is a dedicated radius for top-level
// content cards (PixelPanel), kept separate from r10 rather than bumping r10 itself — r10 is
// shared with plenty of small elements (badges, 40px icon buttons, dropzones) that the reference
// doesn't round nearly this far (its own small stat pills use rounded-xl/16px, not rounded-3xl).
// Classic/Midnight keep rCard equal to their existing r10 (10px) — no visual change intended for
// either, since Mo's complaint was specifically about Aida's fidelity to the purchased mockup.
// Aida's rCard is tuned to the mockup's own main-card class (`rounded-3xl` = 2rem = 32px, sampled
// directly from its Tailwind markup — the outer app frame and every primary content card use it).
const RADIUS_CLASSIC = {r0:0,r2:2,r3:3,r4:4,r5:5,r6:6,r7:7,r8:8,r9:9,r10:10,r12:12,r14:14,r20:20,r22:22,rCard:10};
const RADIUS_AIDA = {r0:0,r2:6,r3:8,r4:10,r5:12,r6:14,r7:16,r8:18,r9:20,r10:22,r12:26,r14:30,r20:20,r22:22,rCard:32};

// Type-scale tokens (2026-08-01, per Mo's font-sizing pass on the Aida reference). Reference's
// own scale (Tailwind classes sampled directly from its markup): card/section titles are
// `text-lg font-medium` (18px/500); a compact page-title-with-icon element (its logo mark, the
// closest analog to PaidHQ's own icon+title header pattern) is `text-2xl font-bold` (24px/700).
// Classic/Midnight keep these equal to their prior hardcoded literals (15px/700 card titles,
// 20px/800 page titles) — no visual change intended for either. Scoped to just these two
// highest-leverage, most directly comparable elements for now (Dashboard's card titles and its
// compact page header) rather than every hardcoded fontSize in the app — see the call sites in
// Dashboard.jsx for where these are actually used.
const TYPE_CLASSIC = {fsCardTitle:15,fsCardTitleWeight:700,fsPageTitle:20,fsPageTitleWeight:800,fsScale:1};
// fsScale (2026-08-01, per Mo — "fix the font and font sizing across the whole site") is a
// uniform multiplier applied to every fontSize literal app-wide (see the `fontSize:Math.round(N*
// (T.fsScale||1))` pattern used throughout the components), rather than hand-picking a size for
// every single label individually — the reference reads larger/roomier everywhere, not just on
// the two elements fsCardTitle/fsPageTitle above target specifically, and a flat ratio keeps
// existing relative hierarchy (small labels stay smaller than big numbers) intact instead of
// distorting it. 1.15 is a modest, conservative bump chosen to track the ~1.2x ratio observed
// directly from the reference (card titles 15->18px, page titles 20->24px) while leaving some
// headroom against overflow in tighter containers (data grids, dense sidebars) that the reference
// itself has no equivalent of to sample from. Classic/Midnight are 1 (exact no-op, verified by
// construction: N*1===N for every call site).
const TYPE_AIDA = {fsCardTitle:18,fsCardTitleWeight:500,fsPageTitle:24,fsPageTitleWeight:700,fsScale:1.15};

// Notion theme radius/type (2026-08-19, per Mo's BudgetHQ-Notion-Redesign-Prompt.md — matching
// VaultHQ's own Notion-inspired look, added as a switchable 4th theme rather than replacing
// Classic outright; see THEME_NOTION's own doc comment below for the full reasoning). The doc's
// radius asks (buttons/inputs 6px, cards 8px, pills 20px) land exactly on Classic's existing
// r6/r8/r20 scale, so this reuses RADIUS_CLASSIC wholesale except rCard, which the doc pins to
// cards' own 8px rather than Classic's 10px. The doc didn't specify a type scale (its component
// rules are about button/input font-size, not the fsCardTitle/fsPageTitle/fsScale knobs Aida
// introduced), so TYPE_NOTION is a straight copy of TYPE_CLASSIC — a deliberate "no opinion yet"
// default, adjustable once Phase 2's layout pass is underway and there's something live to compare
// against a real Notion page.
const RADIUS_NOTION = {...RADIUS_CLASSIC, rCard:8};
const TYPE_NOTION = {...TYPE_CLASSIC};

export const THEME_CLASSIC = {
  font:"'DM Sans',sans-serif",
  ...RADIUS_CLASSIC,
  ...TYPE_CLASSIC,
  bg:"#FAFAFA",surface:"#FFFFFF",surfaceEl:"#FAFAFA",surfaceHover:"#F2F2F2",
  border:"#C9C3C7",borderStrong:"#A59FA7",borderCard:"#C9C3C7",
  text:"#171717",textSub:"#666666",textMuted:"#96909A",textDim:"#E5E5E5",
  accent:"#006CFF",accentHover:"#0052CC",onAccent:"#F9FAFF",
  accentBg:"#E6F0FF",accentBorder:"rgba(0,108,255,0.3)",accentText:"#006CFF",
  accentSoft:"#4D94FF",
  success:"#0C7A43",successBg:"rgba(12,122,67,0.08)",successBorder:"rgba(12,122,67,0.24)",
  warning:"#B25E09",warningBg:"rgba(178,94,9,0.08)",warningBorder:"rgba(178,94,9,0.24)",
  danger:"#E5484D",dangerBg:"rgba(229,72,77,0.08)",dangerBorder:"rgba(229,72,77,0.24)",
  rowHover:"#FAFAFA",rowSelected:"rgba(0,108,255,0.08)",
  inputBg:"#FFFFFF",headerBg:"#FFFFFF",sidebarBg:"#FAFAFA",topbarBg:"#FFFFFF",
  pill:"#F2F2F2",pillBorder:"#C9C3C7",
  // Diagonal hatch texture (2026-07-26, per Mo — another zams.com element, the 45deg hairline
  // hatch it fills empty/placeholder cells with, e.g. behind its dashed-outline "add more" grid
  // slots). Measured the same way as border/borderStrong above: sampled a screenshot crop of it
  // directly — stripes repeat every ~9-11px, in the same warm gray-mauve line color as
  // borderStrong (rgb 165,159,167) but much lower opacity so it reads as a subtle woven texture,
  // not a solid tint. Meant to be layered as backgroundImage over a plain backgroundColor (usually
  // T.surfaceEl), same way zams uses it — a CSS background-image value, not a color, so it needs
  // to be paired with one rather than dropped straight into a `background` shorthand alone.
  hatchBg:"repeating-linear-gradient(45deg, rgba(165,159,167,0.28) 0px, rgba(165,159,167,0.28) 1.5px, transparent 1.5px, transparent 9px)",
  badgeColors:["#36565F","#5F8190","#141414","#4A7080","#23414A","#7A9CAA","#0A2226"],
  // tagDimColors (2026-08-04, per Mo — "the colours of the tag pills in the classic theme... some
  // of them are hard to read and need more contrast"): Campaign Tagger/Pipeline Tagger's tag pills
  // render this text directly on a near-white pill background (see TAG_DIM_COLORS' own doc comment
  // in this file — background:dc+"14", color:dc), so unlike badgeColors above (small decorative
  // dots, where a pale color barely matters) every one of these needs real text contrast against
  // white. TAG_DIM_COLORS (this file, below) was a single set shared across all three themes and
  // never actually contrast-checked for a LIGHT background specifically — two of its entries
  // (#7A9CAA, #8FB0BC) measure under 3:1 against white (WCAG AA needs 4.5:1 for normal text), and a
  // third (#5F8190) was a marginal 4.18:1. This is Classic's own dedicated override (computed via
  // the standard WCAG relative-luminance formula against #FFFFFF): the failing two are replaced with
  // a dark wine (#7A3B42, 8.3:1) and an olive-bronze (#6B5A23, 6.7:1) — different hues on purpose, so
  // tag pills stay visually distinguishable from the teal family rather than just another shade of
  // it — and the marginal one is darkened in place (#5F8190 -> #4C676F, 6.0:1). The other five
  // (#36565F, #141414, #4A7080, #23414A, #0A2226) already cleared 4.5:1 and are unchanged. Aida/
  // Midnight have no tagDimColors of their own yet (not reported as a problem) — both call sites
  // fall back to the shared TAG_DIM_COLORS constant below when a theme doesn't define this, so this
  // is Classic-only and doesn't touch how tag pills look anywhere else.
  tagDimColors:["#36565F","#4C676F","#141414","#4A7080","#23414A","#7A3B42","#0A2226","#6B5A23"],
  shadow:"none",
  shadowMd:"0 8px 24px rgba(0,0,0,0.08),0 2px 6px rgba(0,0,0,0.04)",
  // shadowCard: PixelPanel's dedicated card shadow (see its doc comment in shared.jsx and the
  // Aida block below for why this is separate from shadowMd) — "none" here, same as Classic's
  // existing flat-card look, so the 2026-08-01 card-shadow fix stays Aida-only.
  shadowCard:"none",
  shadowLg:"0 20px 48px rgba(0,0,0,0.12),0 6px 16px rgba(0,0,0,0.06)",
};

// Aida theme (2026-07-31, per Mo — bought this palette/type/shape language as a Tailwind mockup
// and asked for it as a switchable second theme, not a replacement). Palette pulled directly from
// the purchased template's own Tailwind config (background/panel/textMain/textMuted/accent/
// cardBg/tealAccent/tealDark) plus colors sampled straight out of its markup (the lime highlight
// bg on tooltips/active chart bars, the donut-chart teals, the mint "VISA card" green). Two
// judgment calls beyond a literal copy: (1) T.accent (this app's workhorse color — primary
// buttons, active/selected states, progress fills) maps to the template's own near-black
// `primary` (#1A1D1F), not its pale mint `accent` (#C4F0A9) — in the template itself, the dark
// tone is what actually drives its primary CTAs (the "Dashboard" nav pill, the round + buttons),
// while the mint is a sparse highlight color (badges, one highlighted chart bar), so accentSoft
// carries the mint instead of accent itself; a full-size button filled with pale mint would read
// washed out and wouldn't match how the template actually uses either color. (2) badgeColors
// swapped to a set built from the template's own teal/mint family so per-platform badges (Tagger,
// Reporting) stay in the same palette instead of keeping Classic's blue-gray set.
export const THEME_AIDA = {
  font:"'Poppins',sans-serif",
  ...RADIUS_AIDA,
  ...TYPE_AIDA,
  bg:"#F5F6F8",surface:"#FFFFFF",surfaceEl:"#F0F2F4",surfaceHover:"#E9EBEE",
  // borderCard (2026-08-01, per Mo's side-by-side screenshot comparison) — the reference's own
  // main-card class is `border border-gray-100` (Tailwind gray-100 = #F3F4F6), a near-invisible
  // hairline against its white cards; card edges there are really defined by the shadow, not the
  // border. The general-purpose `border` token below (#E3E6E9) is reused everywhere else in the
  // app — inputs, dividers, table rules — where it needs to actually read as a line, so it's
  // measurably darker than gray-100 and was wrongly making PixelPanel's cards look outlined
  // instead of just shadow-edged. borderCard is Aida-only for now (Classic/Midnight keep it equal
  // to their existing border, no visual change).
  border:"#E3E6E9",borderStrong:"#C9CDD2",borderCard:"#F3F4F6",
  text:"#1A1D1F",textSub:"#4A4F54",textMuted:"#6F767E",textDim:"#D8DBDE",
  accent:"#1A1D1F",accentHover:"#000000",onAccent:"#FFFFFF",
  accentBg:"#EDEDED",accentBorder:"rgba(26,29,31,0.25)",accentText:"#1A1D1F",
  accentSoft:"#C4F0A9",
  success:"#3F9142",successBg:"rgba(63,145,66,0.10)",successBorder:"rgba(63,145,66,0.28)",
  // warning (2026-08-01 fix, per Mo — pixel-scanned the actual reference screenshot and confirmed
  // there is NO orange/amber anywhere in it; the app's inherited amber `warning` (#C2790A, shared
  // with Classic/Midnight) was never actually re-tuned for Aida's palette. The reference only ever
  // uses red and green for status, so per Mo's choice this is now a lighter/desaturated variant of
  // the danger red below (same hue, ~55% of its saturation, ~18% lighter) — reads as "attention"
  // without introducing a color family the reference doesn't have, while staying visually distinct
  // from full danger red. Aida-only; Classic/Midnight keep the original amber.
  warning:"#C98C8F",warningBg:"rgba(201,140,143,0.10)",warningBorder:"rgba(201,140,143,0.28)",
  danger:"#D8494E",dangerBg:"rgba(216,73,78,0.10)",dangerBorder:"rgba(216,73,78,0.28)",
  rowHover:"#F5F6F8",rowSelected:"rgba(196,240,169,0.35)",
  inputBg:"#FFFFFF",headerBg:"#FFFFFF",sidebarBg:"#F5F6F8",topbarBg:"#FFFFFF",
  pill:"#F0F2F4",pillBorder:"#E3E6E9",
  hatchBg:"repeating-linear-gradient(45deg, rgba(111,118,126,0.16) 0px, rgba(111,118,126,0.16) 1.5px, transparent 1.5px, transparent 9px)",
  badgeColors:["#60C2B9","#B5E4DF","#1A1D1F","#80D2CA","#4A7068","#C4F0A9","#3E5F58"],
  // shadow is the mockup's own custom `shadow-soft` value (its Tailwind config literally defines
  // 'soft':'0 4px 20px rgba(0,0,0,0.03)') — used on the outer app frame (see PaidHQ.jsx's PAGE
  // wrapper), not on individual cards.
  shadow:"0 4px 20px rgba(0,0,0,0.03)",
  // shadowMd stays the app's general-purpose "elevated surface" shadow — dropdowns, modals,
  // toasts — unrelated to the card-shadow fix below, left as originally tuned.
  shadowMd:"0 8px 24px rgba(0,0,0,0.06),0 2px 8px rgba(0,0,0,0.04)",
  // shadowCard (2026-08-01 fix, per Mo's screenshot comparison) — a dedicated card-only shadow,
  // separate from shadowMd above. Every card in the reference mockup
  // (`bg-white rounded-3xl p-6 shadow-md border border-gray-100`) uses Tailwind's own *stock*
  // `shadow-md` utility, which is a distinctly tighter, more visible drop shadow than either
  // `shadow`/`shadow-soft` (the outer-frame shadow) or this theme's existing shadowMd (tuned as a
  // softer, more diffuse "floating" shadow for dropdowns/modals). PixelPanel (see shared.jsx) uses
  // this token specifically so fixing card shadows doesn't also change every dropdown/modal's
  // shadow along with it. Value is Tailwind's real shadow-md formula, sampled from its source.
  shadowCard:"0 4px 6px -1px rgba(0,0,0,0.1),0 2px 4px -2px rgba(0,0,0,0.1)",
  shadowLg:"0 20px 48px rgba(0,0,0,0.10),0 6px 16px rgba(0,0,0,0.05)",
  // wideLayout (2026-08-01, per Mo — "add breadcrumb and big page-title header") gates the
  // breadcrumb-trail + bare 36px/600 h1 treatment on Dashboard/Data Audit/Settings, replacing
  // their compact icon+title header. Originally also drove those same views' content maxWidth
  // (full-bleed vs. capped at 1040/760), but Mo asked for that part reverted while keeping the
  // breadcrumb/title change — so maxWidth is back to its original fixed per-view value on every
  // theme now, and this flag only affects the header treatment. Undefined (falsy) on
  // Classic/Midnight — every call site branches on this with a plain `T.wideLayout ? ... : ...`,
  // so those two keep their exact prior compact header untouched.
  wideLayout:true,
  // cardBgFeatured (2026-08-01, per Mo — "vary card backgrounds with featured/accent variants")
  // is PixelPanel's optional `variant="featured"` background (see shared.jsx) — a soft gradient
  // panel, sampled directly from the reference's "Pro Version" card
  // (`bg-gradient-to-b from-[#EDF2F6] to-[#E3E9EE]`). variant="accent" reuses the existing
  // accentSoft token above (the reference's own mint highlight color) rather than adding a
  // second new token for it. Undefined on Classic/Midnight — PixelPanel falls back to the normal
  // T.surface background for both variants there, so this is a no-op on those two themes.
  cardBgFeatured:"linear-gradient(180deg, #EDF2F6 0%, #E3E9EE 100%)",
  // cardBgAccent2 / pillHighlight (2026-08-01, per Mo's pixel-scan of the reference) — the
  // reference actually has a SECOND distinct card treatment beyond cardBgFeatured's blue-grey
  // gradient: a solid sage-mint card (`bg-[#BCE3CF]`, used for its VISA/credit-card widget) plus a
  // brighter chartreuse highlight pill (`bg-[#E2F87A]`, its "16:30h"/tooltip callout). Confirmed via
  // direct pixel sampling of the reference screenshot, not guessed. PaidHQ has no card that maps
  // cleanly to a credit-card-style widget yet, so these are added as available tokens without being
  // wired into any component — apply cardBgAccent2 as a PixelPanel variant or pillHighlight as a
  // callout/tooltip background once there's an actual UI element that calls for it, rather than
  // forcing them onto an existing card just to use the color. Aida-only; undefined on Classic/
  // Midnight (no-op).
  cardBgAccent2:"#BCE3CF",
  pillHighlight:"#E2F87A",
  // cardPad (2026-08-01, per Mo — measured live against the reference and found every PaidHQ card
  // uses 12-18px internal padding while the reference's standard card class is `p-6` (24px),
  // consistently, everywhere — 13 separate uses of the exact same p-6 in its source, not a
  // one-off. That's the real reason cards read as cramped rather than spacious; not a color gap.
  // Every PixelPanel call site that opts into this keeps writing its own original literal as the
  // `T.cardPad||"…"` fallback, so this is a no-op on Classic/Midnight (cardPad is undefined there)
  // and unifies every participating Aida card to the reference's actual 24px standard.
  cardPad:"24px",
};

// Midnight theme (2026-07-31, per Mo — dark mode). Deliberately a dark variant of Classic's own
// shapes rather than Aida's: same font, same radius scale, same signature accent blue, just
// inverted for a dark surface. Kept as its own theme rather than a CSS-level "invert Classic"
// trick since several values genuinely need retuning, not just flipping — shadows barely read on
// a near-black background (dropped to almost nothing here, relying on the surface/surfaceEl/
// surfaceHover step-up instead for a sense of elevation), and the semantic colors
// (success/warning/danger) and badgeColors both need brighter, more saturated versions than
// Classic's — the muted tones tuned for a white background read muddy/low-contrast on near-black.
// Classic's badgeColors array even has a literal near-black swatch in it (#141414) that would
// have vanished into a dark background entirely if reused as-is.
export const THEME_MIDNIGHT = {
  font:THEME_CLASSIC.font,
  ...RADIUS_CLASSIC,
  ...TYPE_CLASSIC,
  bg:"#0A0A0A",surface:"#141414",surfaceEl:"#1C1C1C",surfaceHover:"#242424",
  border:"#2A2A2A",borderStrong:"#3A3A3A",borderCard:"#2A2A2A",
  text:"#F2F2F2",textSub:"#A3A3A3",textMuted:"#6E6E6E",textDim:"#3A3A3A",
  accent:"#006CFF",accentHover:"#3B8EFF",onAccent:"#FFFFFF",
  accentBg:"rgba(0,108,255,0.16)",accentBorder:"rgba(0,108,255,0.4)",accentText:"#4D94FF",
  accentSoft:"#4D94FF",
  success:"#3DDC84",successBg:"rgba(61,220,132,0.12)",successBorder:"rgba(61,220,132,0.32)",
  warning:"#FBBF24",warningBg:"rgba(251,191,36,0.12)",warningBorder:"rgba(251,191,36,0.32)",
  danger:"#FF6B6B",dangerBg:"rgba(255,107,107,0.12)",dangerBorder:"rgba(255,107,107,0.32)",
  rowHover:"#1C1C1C",rowSelected:"rgba(0,108,255,0.14)",
  inputBg:"#1C1C1C",headerBg:"#141414",sidebarBg:"#0A0A0A",topbarBg:"#141414",
  pill:"#1C1C1C",pillBorder:"#2A2A2A",
  hatchBg:"repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 1.5px, transparent 1.5px, transparent 9px)",
  badgeColors:["#5DA9B5","#8FC4CC","#E8EDF0","#6FA8C0","#3D6B78","#A8D4DC","#2A4550"],
  shadow:"none",
  shadowMd:"0 4px 16px rgba(0,0,0,0.5)",
  // shadowCard: see the Aida block's doc comment — "none" here, same as Classic, keeps the
  // 2026-08-01 card-shadow fix Aida-only.
  shadowCard:"none",
  shadowLg:"0 20px 40px rgba(0,0,0,0.6)",
};

// Notion theme (2026-08-19, per Mo's BudgetHQ-Notion-Redesign-Prompt.md — matching the light,
// Notion-inspired look built for VaultHQ, added as a switchable 4th theme same as Aida/Midnight
// were, NOT a replacement of Classic. The prompt doc itself assumed BudgetHQ was still on an old
// dark "Obsidian" theme with a binary light/dark toggle to be torn out and asked for a full
// rip-and-replace — stale by the time this was actually built: the app already has this
// Classic/Aida/Midnight switcher, and Classic is already light/flat/blue-accented itself. Adding
// Notion as a peer option instead gets the same practical result (pick it in Settings, the whole
// app reskins, since every component already reads its colors off T.*) without deleting anything
// or risking the other three themes. Flagged to Mo rather than silently deciding either way.
//
// PHASE 1 SCOPE (this commit): color/radius/font tokens only, straight from the doc's own `T`
// object. The doc's "component rules" section also asks for actual LAYOUT changes beyond
// recoloring — tabs underlining the active one instead of a filled pill, detail/document views
// losing their card wrapper entirely ("page"-style, not "dashboard widget"-style), exact 48px
// topbar/220px sidebar sizing — none of that happens automatically just by swapping this token
// object in, the same way Aida's own `wideLayout` breadcrumb/header treatment needed its own
// explicit `T.wideLayout?...:...` branches at each call site, not just a palette. That's Phase 2,
// deliberately deferred until Phase 1 is live and there's a real page to compare against the
// actual Notion doc/app reference rather than guessing every layout nuance blind up front — same
// reasoning Aida's rCard/cardPad/wideLayout fixes above were each added only after a concrete
// "per Mo's screenshot comparison," not preemptively.
//
// Tokens the doc didn't specify, filled in as judgment calls (flag if any read wrong once live):
// - onAccent: "#FFFFFF" — doc's own primary-button rule says `color: "#FFFFFF"` on the accent fill.
// - accentSoft: a lighter tint of accent, same relationship Classic's accentSoft (#4D94FF) has to
//   its own accent (#006CFF) — used for the Settings theme-swatch preview dot and any lighter-fill
//   accent moments other themes have one for.
// - borderCard: same as border (doc's own card rule is just "1px solid T.border", no separate
//   card-specific hairline the way Aida's borderCard diverges from its general border).
// - tagDimColors: left undefined — falls back to the shared TAG_DIM_COLORS constant below, same as
//   Aida/Midnight do ("no tagDimColors of their own yet, not reported as a problem").
// - hatchBg: generated with the same formula every other theme uses (borderStrong's own color, low
//   opacity, repeating 45deg stripes) rather than inventing a new formula.
// - shadowCard: "none" — doc is explicit ("Cards ... no box-shadow"), matches Classic/Midnight.
// - shadowLg: not specified; scaled up from shadowMd using the same ratio Classic/Midnight use
//   between their own shadowMd/shadowLg pairs.
// - wideLayout/cardBgFeatured/cardBgAccent2/pillHighlight/cardPad: Aida-only decorative extras the
//   doc never asked for — left undefined (no-op), same as they already are on Classic/Midnight.
export const THEME_NOTION = {
  font:"'Inter',sans-serif",
  ...RADIUS_NOTION,
  ...TYPE_NOTION,
  bg:"#FFFFFF",surface:"#FFFFFF",surfaceEl:"#F7F7F5",surfaceHover:"#EFEFED",
  border:"#E9E9E7",borderStrong:"#D8D8D5",borderCard:"#E9E9E7",
  text:"#37352F",textSub:"#787774",textMuted:"#9B9A97",textDim:"#E3E2E0",
  accent:"#2383E2",accentHover:"#1A73CE",onAccent:"#FFFFFF",
  accentBg:"rgba(35,131,226,0.1)",accentBorder:"rgba(35,131,226,0.3)",accentText:"#0B6BC2",
  accentSoft:"#5CA6EC",
  success:"#2F9E44",successBg:"rgba(47,158,68,0.1)",successBorder:"rgba(47,158,68,0.25)",
  warning:"#D9730D",warningBg:"rgba(217,115,13,0.1)",warningBorder:"rgba(217,115,13,0.25)",
  danger:"#E03E3E",dangerBg:"rgba(224,62,62,0.1)",dangerBorder:"rgba(224,62,62,0.25)",
  rowHover:"#F1F1EF",rowSelected:"rgba(35,131,226,0.08)",
  inputBg:"#FFFFFF",headerBg:"#FFFFFF",sidebarBg:"#FBFBFA",topbarBg:"#FFFFFF",
  pill:"#F1F1EF",pillBorder:"#EDEDEB",
  hatchBg:"repeating-linear-gradient(45deg, rgba(216,216,213,0.5) 0px, rgba(216,216,213,0.5) 1.5px, transparent 1.5px, transparent 9px)",
  badgeColors:["#E03E3E","#9065B0","#2383E2","#2F9E44","#D9730D","#787774","#0F7B6C"],
  shadow:"none",
  shadowMd:"0 9px 24px rgba(15,15,15,0.12),0 2px 6px rgba(15,15,15,0.06)",
  shadowCard:"none",
  shadowLg:"0 22px 48px rgba(15,15,15,0.16),0 6px 14px rgba(15,15,15,0.08)",
};

// Kept as a plain alias (not a live binding) so any existing `import { THEME }` call site — and
// non-component code like lib/reports.js, which builds report output outside the React render
// tree and has no access to whichever theme is active in a browser tab — keeps working exactly
// as before, unaffected by the Settings toggle below.
export const THEME = THEME_CLASSIC;

export const MONTHS=[{key:"01",label:"Jan"},{key:"02",label:"Feb"},{key:"03",label:"Mar"},{key:"04",label:"Apr"},{key:"05",label:"May"},{key:"06",label:"Jun"},{key:"07",label:"Jul"},{key:"08",label:"Aug"},{key:"09",label:"Sep"},{key:"10",label:"Oct"},{key:"11",label:"Nov"},{key:"12",label:"Dec"}];
export const QUARTERS=[{key:"Q1",months:["01","02","03"],label:"Q1 Cap"},{key:"Q2",months:["04","05","06"],label:"Q2 Cap"},{key:"Q3",months:["07","08","09"],label:"Q3 Cap"},{key:"Q4",months:["10","11","12"],label:"Q4 Cap"}];
// Forecast-model options for a budget segment (see budgetRowMeta[segKey]._forecastModel and
// computePacing/projectPlatformSegment for the math each one drives).
//
// Redesigned 2026-07-25 per Mo, replacing the original 7-option list (full-period/committed/
// trailing1/3/7/14/30) — that list required understanding what a "trailing window" even was and
// picking a number with no real guidance, for a payoff (more reactive pacing) most people didn't
// actually need most of the time. Down to three real choices now:
//   "auto"      — the new default (see computePacing's fallback chain below). Adaptive: blends
//                 the full-period rate with a short recent one, see computeAutoBlendWeight/
//                 projectPlatformSegment. Right for almost every segment, no tuning required.
//   "committed" — unchanged: a known lump sum, skips run-rate projection entirely.
//   "manual"    — replaces the old fixed trailing1/3/7/14/30 presets with one free-form
//                 "trailing N days" number the user picks themselves. Stored the same way the
//                 presets always were internally (the literal string "trailingN", parsed by
//                 projectPlatformSegment's trailingMatch regex) — "manual" only exists as a UI-
//                 level grouping label; there is no separate stored "manual" value.
// The legacy literal "full-period" string is still recognized by projectPlatformSegment (for
// configs saved before this redesign) but is no longer offered as a choice anywhere in the UI —
// it behaves as a distinct always-cumulative mode, deliberately not folded into "auto", so existing
// saved data doesn't silently change behavior underneath anyone.
export const FORECAST_MODELS=[
  {value:"auto",label:"Auto",hint:"Adaptive — blends the full-period rate with the last 7 days, leaning on whichever is more trustworthy as they diverge. The right choice for almost every segment."},
  {value:"committed",label:"Committed spend",hint:"A known lump sum/prepaid amount — skips run-rate projection entirely."},
];
// Default trailing window (in days) prefilled for a segment/workspace switching into Manual mode
// for the first time — matches the old "trailing7" preset, the most commonly used one.
export const DEFAULT_MANUAL_TRAILING_DAYS=7;
// Human label for ANY forecastModel value actually seen in the wild — "auto"/"committed" (current),
// "trailingN" for any N (Manual, or a legacy preset), and the legacy literal "full-period". Used
// anywhere a value needs to be displayed (tooltips, row-level select, reports) instead of a raw
// FORECAST_MODELS.find(), since Manual's N is free-form and can't be enumerated in that list.
export function forecastModelLabel(value){
  if(!value||value==="auto")return "Auto";
  if(value==="committed")return "Committed spend";
  if(value==="full-period")return "Full period (legacy)";
  const m=/^trailing(\d+)$/.exec(value);
  if(m)return `Manual (trailing ${m[1]}d)`;
  return value;
}
// Row-level picker sentinel — "inherit the workspace's global default" is stored as simply having
// NO _forecastModel key at all (see setForecastModel below), same as before global defaults
// existed. This constant is just the <select>'s value for that state; never itself persisted.
export const FORECAST_MODEL_INHERIT="";
export const MONTH_MAP={jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",january:"01",february:"02",march:"03",april:"04",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"};
// Two-level campaign hierarchy: "campaign_group_name" is the top level (LinkedIn's own
// "Campaign Group"; what Meta/Google/Bing/Reddit simply call "Campaign"). "campaign_name" is
// the leaf level actually being tagged (LinkedIn's own "Campaign" object; Meta/Reddit's
// "Ad Set"; Google/Bing's "Ad Group"). Only campaign_group_name is required — campaign_name
// falls back to it for platforms/exports that don't have a second level of breakdown, so
// nothing breaks for data that predates this two-level model.
export const REQUIRED_COLS=["campaign_group_name","spend","date"];
// ad_name (2026-08-19, per Mo — Reddit/6sense report ad-level spend only via CSV/manual export,
// unlike LinkedIn/Meta which now pull it live — see linkedin.js/meta.js): optional, same "leave
// unmapped if this file doesn't have it" treatment as every other optional column. Column position
// (last) mirrors OPTIONAL_COLS' existing "least universally present first-class field" ordering.
export const OPTIONAL_COLS=["campaign_name","platform","campaign_type","impressions","clicks","campaign_id","adset_id","ad_name"];
// campaign_type: the platform's own authoritative type field (Google Ads' "Campaign type" column
// — Search/Display/Demand Gen/Performance Max/Video) when the export has one. This is trusted
// over name-based guessing in derivePlatform() below, since naming conventions are ambiguous —
// e.g. Google's Demand Gen campaigns are frequently still named with a legacy "GDN-" prefix
// (carried over from before Display/Discovery rolled into Demand Gen) with no text in the name
// that distinguishes them from real Display campaigns.
// Negative lookaheads on campaign_group_name/campaign_name guard against "status" columns —
// Google's "Ad group status" otherwise matches the bare /ad.?group/i pattern just as eagerly as
// the real "Ad group" column, and since autoDetect() takes the first match per header order, a
// "status" column earlier in the file silently wins and the real name column never gets mapped.
// date matches "Month" too — Google/Bing's manual exports report one row per ad group PER MONTH,
// with a column literally named "Month" (not "Date"/"Day"), which the old pattern never caught.
// date also matches "reporting start" (2026-07-28, per Mo — hit this live on the same Meta ad-set
// export as the spend fix below): Meta's own per-ad-set export names its date column "Reporting
// starts"/"Reporting ends", not "Date"/"Day"/"Month" — the old anchored-exact pattern never matched
// either one, so Date (a required field) came back unmapped on every Meta export of this shape.
// Matches "start" specifically rather than "end" since that's the more standard anchor date across
// platforms, and Meta's own two columns are equal for a daily-grain file anyway.
// impressions matches "Impr."/"Imp." (Google/Bing's actual abbreviated header) in addition to the
// full word "impression" — anchored so it doesn't also grab "Impr. (Top) %" or similar columns
// that start the same way but aren't the impressions count itself.
// spend excludes any header containing "per" (2026-07-28, per Mo — hit this live on a Meta ad-set
// export): "cost|spend|amount" alone also matches "Cost per results", "Cost per link click",
// "Cost per 1,000 impressions (CPM)", etc. — per-unit efficiency metrics, not total spend — and
// since autoDetect() below takes the FIRST header that matches in file order, whichever "cost per
// X" column Meta happens to export first was silently winning the Spend/Cost slot over the real
// "Amount spent" column, with no visible error (the dropdown just showed something, so it looked
// mapped) even though every downstream report would then be built on the wrong number entirely.
// clicks now also matches "Link clicks" (Meta's own name for this column — the old exact-match
// /^clicks?$/i never caught it), plus any other "___ clicks" variant (e.g. "Unique clicks"), while
// still excluding "per"/"rate" so "Cost per link click" and "Click-through rate (CTR)" — a cost
// metric and a percentage, not a click count — can never win this slot.
export const COL_PATTERNS={campaign_group_name:/^(?!.*status)campaign.?group/i,campaign_name:/^(?!.*status)(ad.?set|ad.?group)/i,spend:/(?!.*\bper\b)(cost|spend|amount)/i,date:/^date$|^day$|^month$|reporting\s*start/i,platform:/platform|traffic.source|channel|source/i,campaign_type:/campaign.?type/i,impressions:/^impr?\.?$|impression/i,clicks:/(?!.*\bper\b)(?!.*\brate\b)\bclicks?\b/i,campaign_id:/campaign.*id/i,adset_id:/ad.?set.*id|ad.?group.*id/i,ad_name:/ad.?name|creative.?name/i};
export const COL_LABELS={campaign_group_name:"Campaign Group Name",campaign_name:"Campaign Name (Ad Set / Ad Group)",spend:"Spend / Cost",date:"Date",platform:"Platform / Traffic Source",campaign_type:"Campaign Type (Search/Display/Demand Gen)",impressions:"Impressions",clicks:"Clicks",campaign_id:"Campaign ID",adset_id:"Ad Set ID",ad_name:"Ad Name (Ad / Creative)"};
// Composite identity key — ad set / ad group names often repeat across different campaigns
// (e.g. two campaigns both have a "Retargeting" ad set), so tagging and dedup identity must
// combine both levels, not just the leaf name alone.
export const campaignKey=(groupName,name)=>`${groupName||name||""}||${name||groupName||""}`;
// Ad-level identity (2026-08-19, per Mo — "tag Ads by tags and dimension" for paid social
// channels: LinkedIn/Meta/Reddit/6sense). Deliberately a SEPARATE key builder rather than adding a
// third parameter to campaignKey itself — campaignKey is used in ~15 places across this file and
// PaidHQ.jsx (Budget Panel, Pacing, exports, Ask AI, Data Audit, budget-dim resolution...) that
// have no reason to know about ads, so extending it in place would mean touching all of that
// surface area for no benefit to it. adKey just layers ad_name on top of the existing two-level
// identity, so Ads-mode tagging (AdTagger.jsx) is additive/independent — its own tags storage
// (workspace_config.adTags), never mixed with the existing campaign-level `tags` object.
export const adKey=(groupName,name,adName)=>`${campaignKey(groupName,name)}||${(adName||"").trim()}`;
// Splits a campaignKey string back into its two source values — powers the "Campaign"/"Ad Group"
// pseudo-dimensions (added 2026-07-28, per Mo: native campaign/ad-group-level reporting and
// budgeting with zero manual tagging, same idea as "Platform" below but simpler — Platform has to
// be derived from a full spend row via derivePlatform() and indexed per campaign
// (buildCampaignPlatformIndex), but Campaign ("campaign_group_name") and Ad Group
// ("campaign_name") are already losslessly encoded in the key itself, so no row-scan or index is
// needed — just decode the key.
export const campaignKeyParts=key=>{const i=(key||"").indexOf("||");return i===-1?{group:key||"",name:key||""}:{group:key.slice(0,i),name:key.slice(i+2)};};
// Every pseudo-dimension that's derived from spend data rather than a real manual tag — shared by
// every UI list that needs to render these as non-editable/auto-detected (Budget By / View by /
// Break down by pickers, the "not a real tag, don't let someone rename it" guards, etc.).
export const DERIVED_DIMS=["Platform","Campaign","Ad Group"];
// Used by the debounced-save empty-write guard (see the big comment near hadRealConfigRef in the
// main PaidHQ component) — "empty" means nothing worth protecting, i.e. no tags, no budgets, and
// no budget dimension setup either (tagDims/budgetRowMeta/budgetImportMeta are metadata that only
// matter alongside actual tags/budgets, so they're deliberately not checked here).
// adTags included (2026-08-19) — otherwise a workspace whose only config data is Ads-mode tagging
// (no campaign tags, no budgets yet) would have every save rejected by the empty-payload backstop
// in PaidHQ.jsx's save effect as a false "this looks like data loss."
export const isEmptyConfig=c=>!Object.keys(c?.tags||{}).length&&!Object.keys(c?.budgets||{}).length&&!Object.keys(c?.adTags||{}).length;
// Comma-separated multi-term filter matching, used by the Tagger's Group/Campaign/Tag filters —
// both the "contains" and "excludes" side of each. Terms are OR'd together: "google,bing" as an
// include filter matches anything containing EITHER term; as an exclude filter, it drops anything
// containing EITHER term. Empty/whitespace-only terms from stray commas are dropped.
export const splitFilterTerms=s=>(s||"").split(",").map(t=>t.trim().toLowerCase()).filter(Boolean);
// mode "or" = matches/excludes if ANY term is present; "and" = only if ALL terms are present.
export const matchesTerms=(haystackLower,terms,mode)=>mode==="and"?terms.every(t=>haystackLower.includes(t)):terms.some(t=>haystackLower.includes(t));
// Distinct value already used per budget dimension, across every year — feeds the Tagger's
// autocomplete so typing a tag value can suggest e.g. "EPM Suite" for Pillar instead of risking a
// typo that creates an orphaned segment. Segment keys are dims.join("|"), so splitting one back
// apart and zipping against budgetDims recovers each dimension's actual value for that segment.
export function getBudgetDimValues(budgets,budgetDims){
  const map={};
  (budgetDims||[]).forEach(d=>map[d]=new Set());
  Object.values(budgets||{}).forEach(yearBudgets=>{
    Object.keys(yearBudgets||{}).forEach(segKey=>{
      const vals=segKey.split("|");
      (budgetDims||[]).forEach((d,i)=>{if(vals[i])map[d].add(vals[i]);});
    });
  });
  const result={};
  (budgetDims||[]).forEach(d=>result[d]=[...map[d]].sort((a,b)=>a.localeCompare(b)));
  return result;
}
export const DEFAULT_DIMS=["Product","Region","Funnel","Pillar"];
// Pre-auth localStorage keys — see the "one-time import of pre-auth localStorage data" block in
// PaidHQ() for what reads/clears these.
export const LEGACY_LOCAL_KEYS=["paidhq_tags","paidhq_dims","paidhq_budgets","paidhq_budget_dims","paidhq_budget_meta","paidhq_budget_meta_dims","paidhq_budget_import_meta","paidhq_rows"];
export const PLATFORM_COLORS={LinkedIn:"#0a66c2","Google Search":"#4285f4","Google Display":"#34a853","Demand Gen":"#f59e0b","Performance Max":"#ef4444",Meta:"#0082FB",Bing:"#00809d",YouTube:"#ff0000",Capterra:"#ff6d2d",Unknown:"#9B9A92"};
// Manual platform-override dropdown options — Campaign Tagger's own Platform column editor, and now
// (2026-08-03, per Mo's "make the pipeline tagger... identical to the campaign tagger") Pipeline
// Tagger's Channel column editor too. Moved here from a local PaidHQ.jsx const so both surfaces share
// exactly one list instead of two copies that could drift ("auto" excluded by both callers — it's
// PaidHQ.jsx's own derivePlatform() sentinel for "not yet resolved," never a real value to pick).
export const PLATFORM_OPTIONS=["auto","Google","Meta","LinkedIn","Bing","Capterra","Reddit","6sense","Pinterest","TikTok","YouTube","Other"];
// Applied-tag pill colors in the Tagger — a plain white/grey pill read as too flat to spot at a
// glance, so pills use a tinted "selected chip" treatment (light background + colored border/text)
// instead of a flat outline, with a distinct color PER TAG DIMENSION (Product/Module/Brand/etc. each
// get their own hue) so the Tags column reads at a glance without having to read every label.
// Pulled straight from Mo's brand palette (2026-07-21) — Deep Slate/Ocean Steel/Jet Black are the
// only three colors in the new slate palette dark enough to read as distinct pill colors (Cloud
// Mist and Pure White are too light for text-on-tint contrast), so the remaining entries are
// lighter/darker tints of those same three hues rather than off-palette colors, keeping every
// dimension's pill "on brand" instead of reaching for an arbitrary rainbow.
export const TAG_DIM_COLORS=["#36565F","#5F8190","#141414","#4A7080","#23414A","#7A9CAA","#0A2226","#8FB0BC"];
// "pacing" relabeled from "Reporting & Pacing" to "Budget Pacing" (2026-07-30, per Mo — folding
// ReportingHQ's performance-reporting work into PaidHQ instead of running it as a separate
// product) since "Reporting" now means something different: the new "reportingAnalyzer" tab covers
// Dreamdata/PowerBI funnel/pipeline performance data, while this tab is specifically about
// spend-vs-budget pacing — same component (PacingDashboard.jsx), same `key:"pacing"` (so every
// existing view==="pacing" check elsewhere keeps working unchanged), just a clearer label now that
// there are two "reporting"-adjacent tabs instead of one.
// NOTE (2026-07-30, per Mo): the "reportingAnalyzer" key/route is unchanged (matches the tab's
// component/file name, PaidHQ.jsx's view-state, and API doc-comments) — only the user-facing
// label was renamed, from "Reporting Analyzer" to "Performance Intelligence".
// Renamed 2026-08-02, per Mo: "reportingAnalyzer" (import + review, now ALSO the full tagging UI —
// see ReportingAnalyzer.jsx) is the one users actually import and tag pipeline data in day to day,
// so it takes the "Pipeline Tagger" name. "pipelineTagger" (the old tagging-only tab) becomes
// "Reporting Intelligence" — its tagging job is now redundant, so its content is being repurposed
// into the first pass of the deferred breakdown/analysis tab (see PipelineTagger.jsx's own doc
// comment). Route keys (reportingAnalyzer/pipelineTagger) are UNCHANGED — only the labels swapped —
// so this is a display-only rename, not a URL/state-shape change.
// Relabeled again 2026-08-06, per Mo: "pipelineTagger"'s "Reporting Intelligence" label becomes
// "Performance Intelligence" — same route key, same component (PipelineTagger.jsx), display-only.
// "changeHistory" (2026-08-19, per Mo — "create a change history section that automatically pulls
// in non automated and non bulk edit changes from Google, Bing, Meta and LinkedIn and Capterra" —
// confirmed via AskUserQuestion as its own dedicated tab rather than folded into an existing one)
// added at the end, right before Ask AI — see ChangeHistory.jsx.
// "vault" (2026-08-19, per Mo — folding VaultHQ's document/resource storage into PaidHQ as a
// "Vault" tab, Phase 1/2 of a larger migration; Ask AI grounding in vault entries is a later,
// explicitly deferred phase) added right before Ask AI, same placement reasoning as changeHistory
// above — see Vault.jsx.
export const NAV=[{key:"dashboard",label:"Dashboard",icon:"bolt"},{key:"data",label:"Data Sources",icon:"download"},{key:"dataAudit",label:"Data Audit",icon:"check"},{key:"tagger",label:"Campaign Tagger",icon:"tag"},{key:"budget",label:"Budget Panel",icon:"wallet"},{key:"pacing",label:"Budget Pacing",icon:"chart"},{key:"reportingAnalyzer",label:"Pipeline Tagger",icon:"tag"},{key:"pipelineTagger",label:"Performance Intelligence",icon:"search"},{key:"goalsObjectives",label:"Goals & Objectives",icon:"target"},{key:"changeHistory",label:"Change History",icon:"history"},{key:"vault",label:"Vault",icon:"lock"},{key:"ask",label:"Ask AI",icon:"sparkle"}];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
export function autoDetect(h){
  const m={};
  h.forEach(c=>{for(const[f,p]of Object.entries(COL_PATTERNS)){if(!m[f]&&p.test(c.trim()))m[f]=c;}});
  // A bare "Campaign" header is ambiguous: for Meta/Google/Bing/Reddit it IS the campaign group
  // (handled by the fallback below), but when a dedicated "Campaign Group" column was already
  // found above (LinkedIn's export shape), "Campaign" is LinkedIn's own Campaign object — i.e.
  // our leaf-level campaign_name — not the group.
  if(!m.campaign_name){const c=h.find(c=>/^campaign$/i.test(c.trim()));if(c&&m.campaign_group_name)m.campaign_name=c;}
  if(!m.campaign_group_name){const c=h.find(c=>/campaign/i.test(c)&&!/id|group|type/i.test(c));if(c)m.campaign_group_name=c;}
  // Same "per" exclusion as COL_PATTERNS.spend above — this fallback only runs when nothing
  // matched there, so without it a file with only "cost per X" columns and no true spend column
  // would fall right back into the same silent-wrong-number trap.
  if(!m.spend){const c=h.find(c=>/cost|spend/i.test(c)&&!/\bper\b/i.test(c));if(c)m.spend=c;}
  if(!m.date){const c=h.find(c=>/date|day|month/i.test(c));if(c)m.date=c;}
  return m;
}
// Infers a specific platform label (Google Search vs Google Display vs Demand Gen vs YouTube,
// etc.). Trusts an explicit campaign_type value first — Google Ads' own "Campaign type" API/export
// field (Search/Display/Demand Gen/Performance Max/Video) — since that's ground truth and naming
// conventions are genuinely ambiguous (Google has been rolling Display into Demand Gen, so a
// legacy "GDN-" prefixed campaign may really be Demand Gen with no text distinguishing it from
// real Display). Only falls back to naming-convention prefixes when campaign_type isn't mapped —
// e.g. platforms without a type field, or older exports. Checks the CAMPAIGN GROUP name before
// the leaf (ad set/ad group) name — in every real export seen so far (Google Ads, LinkedIn), the
// SEA-/GDN-/YT-/LIN-/FB-/BIN- prefix convention lives on the campaign, not the ad group.
export function derivePlatform(groupName,name,pv,campaignType){
  const ct=(campaignType||"").trim().toLowerCase();
  if(ct==="search")return"Google Search";
  if(ct==="display")return"Google Display";
  if(ct==="demand gen"||ct==="demandgen")return"Demand Gen";
  if(ct==="performance max"||ct==="performancemax"||ct==="pmax")return"Performance Max";
  if(ct==="video")return"YouTube";

  const p=(pv||"").toLowerCase();
  for(const raw of [groupName,name]){
    const u=(raw||"").toUpperCase();
    if(!u)continue;
    if(/^LIN[-|]/.test(u))return"LinkedIn";
    if(/^FB[-|]/.test(u))return"Meta";
    if(/^BIN[-|]/.test(u))return"Bing";
    if(/^YT[-|]/.test(u))return"YouTube";
    if(/demand.?gen|discovery/i.test(u))return"Demand Gen";
    if(/^SEA[-|]/.test(u))return"Google Search";
    if(/^GDN[-|]/.test(u))return"Google Display";
    if(/pmax|performance.max/i.test(u))return"Performance Max";
  }
  if(p.includes("linkedin"))return"LinkedIn";
  if(p.includes("facebook")||p.includes("meta"))return"Meta";
  if(p.includes("bing"))return"Bing";
  if(p.includes("youtube"))return"YouTube";
  if(p==="search")return"Google Search";
  if(p==="display")return"Google Display";
  if(p==="demand gen")return"Demand Gen";
  if(p.includes("google"))return"Google Search";
  if(p.includes("capterra"))return"Capterra";
  return pv||"Unknown";
}
// "Platform" as a BUDGETING dimension (Budget By / Pacing segment matching, not just Reporting
// breakdowns) — added 2026-07 so someone can budget/forecast purely by channel with zero manual
// tagging, same as Reporting's breakdown/AskAI views already allow via resolveDimValue. Unlike a
// real tag dimension, "Platform" is never stored in campaignTags — there's nothing to look up by
// campaign key alone, so any code matching campaigns against a segment that includes "Platform"
// needs a campaignKey -> derived-platform lookup built from actual spend rows. Built once per
// mergedNormRows change and threaded through to every function below that used to read
// tags[key][dim] directly for budgetDims.
export function buildCampaignPlatformIndex(mergedNormRows){
  const idx={};
  (mergedNormRows||[]).forEach(row=>{
    const key=campaignKey(row.campaign_group_name,row.campaign_name);
    if(!idx[key])idx[key]=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
  });
  return idx;
}
// Resolves ONE budgetDim's value for a campaign, given only its campaignKey + tag object — the
// shared shape untagSegmentCampaigns/countSegmentCampaigns (and BudgetManager's segment builder)
// all match/count campaigns against a segment with. "Platform" needs the row-scan-built
// platformIndex; "Campaign"/"Ad Group" decode straight off the key (see campaignKeyParts); any
// other dim is a real manual tag, read off `t` exactly as before.
export function resolveBudgetDimValue(dim,key,t,platformIndex){
  if(dim==="Platform")return platformIndex?.[key]||"";
  if(dim==="Campaign")return campaignKeyParts(key).group;
  if(dim==="Ad Group")return campaignKeyParts(key).name;
  return t[dim];
}
// Formats a Date's LOCAL calendar day as YYYY-MM-DD — deliberately NOT d.toISOString().slice(0,10),
// which reads UTC fields. That distinction only bites when a Date was built from local y/m/d
// components (e.g. new Date(year,0,1) for "start of this year"): toISOString() on that value walks
// it back to UTC first, so anyone west of Greenwich (all of the US) gets Dec 31 instead of Jan 1 —
// caught live 2026-07-24 via the sync range picker's "This year" preset (and the picker's own
// this-quarter default) reporting an import start one day earlier than the date actually picked.
// d.getFullYear()/getMonth()/getDate() below read the same LOCAL fields the Date was constructed
// from, so this round-trips exactly instead of drifting across the UTC boundary.
export const localISODate=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
// Global, in-memory mirror of the "Number formatting" Settings choice (2026-08-06, per Mo —
// "give users the ability to increase or decrease the decimal of any numbered/dollar value
// field"). Every shared formatter that displays a $ or plain number (fmt$/fmtFull here,
// reportingMetrics.js's fmtMetric) reads this directly instead of taking it as a parameter —
// threading an explicit decimals argument through every one of the hundreds of existing fmt$/
// fmtFull/fmtMetric call sites across every tab would have been a huge, invasive refactor for what
// is fundamentally one shared display preference. PaidHQ.jsx keeps this in sync with the real,
// persisted, workspace-shared `decimalAdjust` config value via setDecimalAdjust — called once when
// that config loads and again every time the Settings stepper changes it (see PaidHQ.jsx's own
// decimalAdjust state/effect for exactly where). Clamped to 0-6: money/plain-number formatting
// never had a NEGATIVE decimal count to begin with (their baseline is 0 decimals), so "decrease"
// simply has no effect once already at the floor, matching Excel's own decrease-decimal behavior
// at 0 rather than going negative.
let _decimalAdjust=0;
export function setDecimalAdjust(n){_decimalAdjust=Number.isFinite(Number(n))?Math.max(0,Math.min(6,Math.round(Number(n)))):0;}
export function getDecimalAdjust(){return _decimalAdjust;}

export const parseMoney=v=>{if(v===""||v==null)return null;const n=parseFloat(String(v).replace(/[$,\s%]/g,""));return isNaN(n)?null:n;};
export const fmt$=n=>{if(!n)return"";return"$"+n.toLocaleString(undefined,{minimumFractionDigits:_decimalAdjust,maximumFractionDigits:_decimalAdjust});};
export const fmtFull=n=>n?"$"+n.toLocaleString(undefined,{minimumFractionDigits:_decimalAdjust,maximumFractionDigits:_decimalAdjust}):"—";
export const isMonthHdr=c=>{const x=c.trim().toLowerCase().replace(/\s+\d{4}$/,"");return!!MONTH_MAP[x];};
export const getMonthKey=c=>{const x=c.trim().toLowerCase().replace(/\s+\d{4}$/,"");return MONTH_MAP[x]||null;};
// Detects a single flat recurring-monthly amount column (e.g. "Monthly Budget", "Monthly Spend")
// — distinct from a genuine period/date column. Tables that have this AND no named-month columns
// AND no parseable period column are a 4th import shape ("flat"): one row per segment, no
// per-month breakdown at all, just a monthly run-rate figure to replicate across every month.
export const findFlatMonthlyCol=headers=>headers.find(h=>/monthly/i.test(h)&&/budget|amount|spend|cost/i.test(h));
export function parsePeriod(val){if(!val)return null;const s=String(val).trim();let m=s.match(/^(\d{4})-(\d{2})$/);if(m)return m[2];m=s.match(/^(\d{1,2})\/(\d{4})$/);if(m)return String(m[1]).padStart(2,"0");const l=s.toLowerCase().replace(/[,\s]+/g," ");for(const[n,k]of Object.entries(MONTH_MAP)){if(l.startsWith(n))return k;}return null;}

// Parse any file (CSV or Excel) to array of arrays
export function parseFileToRows(file,callback){
  const ext=file.name.split(".").pop().toLowerCase();
  if(ext==="csv"){
    Papa.parse(file,{header:false,skipEmptyLines:false,complete:r=>callback(r.data.map(row=>row.map(v=>String(v??""))))});
  } else {
    const reader=new FileReader();
    reader.onload=e=>{
      const wb=XLSX.read(new Uint8Array(e.target.result),{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:"",raw:false});
      callback(rows.map(row=>row.map(v=>String(v??""))));;
    };
    reader.readAsArrayBuffer(file);
  }
}

// Forward-fill empty cells in a row (for merged-cell group headers in CSV)
export function forwardFillGroups(row){
  let last="";
  return row.map(v=>{const s=String(v||"").trim();if(s&&!/^(channel|group|category|platform)$/i.test(s))last=s;return last;});
}

// Download helper
export function downloadCSV(rows, filename){
  const csv=rows.map(r=>r.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob=new Blob(["\uFEFF"+csv,],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}

// \u2500\u2500\u2500 VERSION HISTORY (IndexedDB) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Full-app snapshots (Tagger + Budget data together, since they're interdependent \u2014 e.g. a
// budget-import merge also retags campaigns, so restoring one without the other could leave
// spend attribution broken) stored via IndexedDB rather than localStorage: a handful of
// snapshots of budgets+tags+spend rows can easily exceed localStorage's ~5-10MB ceiling, while
// IndexedDB has effectively no practical limit for data this size. A new version is saved
// automatically after major actions (imports, clears, merge resolutions) \u2014 not on every
// keystroke \u2014 plus on demand via "Name current version\u2026", mirroring Google Sheets' model of
// checkpointing meaningful moments rather than every edit.
// Version history and File Store are now server-backed (see listVersions/saveVersion/
// deleteVersion and listFiles/uploadFile/deleteFile/downloadFile imported above from
// workspaceApi.js), workspace-scoped instead of living in one fixed-name IndexedDB database
// shared across every workspace ever opened in this browser. The load/save call sites live
// further down inside the PaidHQ component, where session/workspace are in scope.

// Groups version records into "Today" / "Yesterday" / weekday-or-date buckets, same convention
// Google Sheets' version history panel uses, so the list reads as a scannable timeline instead
// of a flat log of timestamps.
export function groupVersionsByDay(versions){
  const now=new Date();
  const startOfDay=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
  const today=startOfDay(now);
  const yesterday=today-86400000;
  const groups=[];
  versions.forEach(v=>{
    const day=startOfDay(new Date(v.timestamp));
    const label=day===today?"Today":day===yesterday?"Yesterday":new Date(v.timestamp).toLocaleDateString(undefined,{weekday:"long",month:"short",day:"numeric"});
    let g=groups.find(g=>g.label===label);
    if(!g){g={label,items:[]};groups.push(g);}
    g.items.push(v);
  });
  return groups;
}

// ─── FILE STORE (server-backed, workspace-scoped) ──────────────────────────────
// Archive of raw uploaded/exported files (tagging CSVs, channel spend import CSVs, PDFs, etc.).
// Auto-captured at the CSV import/export call sites (see handleFile, exportTags,
// importTagsFromCSV) plus a manual "Add file" upload for anything else (PDFs, insertion orders,
// etc.) the app never parses itself. archiveFile itself is defined inside the PaidHQ component
// (needs session/workspace in scope to call the API) — see the "archiveFile" useCallback below.

export const fmtFileSize=n=>{
  if(!n)return"0 KB";
  if(n<1024*1024)return`${Math.max(1,Math.round(n/1024))} KB`;
  return`${(n/(1024*1024)).toFixed(1)} MB`;
};

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────

export function normalizeRows(rows,colMap){
  return rows.map(row=>{
    const groupName=(row[colMap.campaign_group_name]||"").trim();
    const leafName=(row[colMap.campaign_name]||"").trim()||groupName;
    return{
      campaign_group_name:groupName,
      campaign_name:leafName,
      spend:parseFloat(String(row[colMap.spend]||"0").replace(/[$, ]/g,""))||0,
      platform:(row[colMap.platform]||"").trim()||"Unknown",
      campaign_type:(row[colMap.campaign_type]||"").trim(),
      date:String(row[colMap.date]||"").trim(),
      impressions:parseInt(String(row[colMap.impressions]||"0").replace(/,/g,""))||0,
      clicks:parseInt(String(row[colMap.clicks]||"0").replace(/,/g,""))||0,
      // ad_name (2026-08-19): optional, left "" when this file has no ad-level column — matches
      // spendRowKey's own "empty string when absent" convention so pre-existing non-ad-level
      // imports keep byte-identical dedup keys.
      ad_name:(row[colMap.ad_name]||"").trim(),
    };
  }).filter(r=>r.campaign_group_name&&r.spend>0);
}

// Merge normalized rows — deduplicate by campaign group + campaign + CALENDAR DAY (not the raw
// date string), new data wins.
//
// FIX (2026-07-21): the identity key used to join on r.date as a raw string. That meant the exact
// same real day could hash to two different keys across two pulls/uploads that happen to format
// dates differently -- a live API returning "2026-07-21T00:00:00.000Z" one time and
// "2026-07-21" the next, or re-exporting "the same" CSV from a spreadsheet that serializes dates
// differently on a second export -- and instead of overwriting, that silently ADDED a second row
// for the same real day, doubling its spend. This was the actual reported bug: syncing a channel
// twice, or uploading nominally the same CSV twice/three times, added spend instead of deduping.
// Keying on parseSpendDate's already-parsed calendar day collapses every date format this app
// already treats as equivalent everywhere else (pacing math, trend charts) down to one identity,
// so re-pulling/re-uploading the same data now always overwrites. Campaign identity is trimmed for
// the same reason -- stray leading/trailing whitespace from a spreadsheet shouldn't be enough to
// make "Retargeting" and "Retargeting " look like two different ad sets.
// ad_name suffix (2026-08-19, per Mo's ad-level tagging request): without this, two different ads
// running under the same ad group on the same day would collide onto the SAME spendRowKey once
// ad-level data starts flowing in (from a future LinkedIn pivot=CREATIVE / Meta level=ad pull, or
// a CSV import with an Ad column) — mergeRows below is last-write-wins per key, so that collision
// would silently DROP every ad but the last one merged for that ad group/day, not just fail loudly.
// Appending ad_name (trimmed, empty string when absent) fixes this while staying 100% backward
// compatible: every row that predates ad-level data has no ad_name, so its key is byte-identical
// to before this change — only rows that actually carry an ad_name get a new, more specific key.
export function spendRowKey(r){
  const d=parseSpendDate(r.date);
  const dateKey=d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`:String(r.date||"").trim();
  return `${campaignKey((r.campaign_group_name||"").trim(),(r.campaign_name||"").trim())}||${dateKey}||${(r.ad_name||"").trim()}`;
}
export function mergeRows(existing,incoming){
  const map=new Map(existing.map(r=>[spendRowKey(r),r]));
  incoming.forEach(r=>map.set(spendRowKey(r),r));
  return Array.from(map.values());
}

// Flags manually-imported rows (CSV/screenshot/Google Sheets) that share identity with an
// already-LIVE-SYNCED row (same campaign group + campaign + calendar day, via spendRowKey) but
// disagree on spend — added 2026-07-24 per Mo, since mergeRows above is silent last-write-wins
// with no platform check in its identity key at all. Without this, a manual import whose campaign
// naming happens to line up with a synced platform's row would silently overwrite real platform
// data with no warning; naming that DOESN'T line up exactly would instead double-count as a
// separate row. This only catches the first case (the identity match) — it can't detect the
// second (naming mismatch) since there's nothing to key on; that's a naming/mapping problem, not
// a value conflict, and is out of scope here.
// Only compares against rows whose source is a real platform sync (source starts with "sync:") —
// two manual imports disagreeing with each other is just an ordinary re-import (expected,
// last-write-wins), not "wrong compared to synced platform spend."
// Threshold is intentionally loose (>$1 or >1% of the synced value, whichever is larger) so this
// doesn't nag about floating-point/rounding noise between two exports of what's really the same
// number.
export function detectSpendConflicts(existingRows,incomingRows){
  const syncedByKey=new Map();
  existingRows.forEach(r=>{if((r.source||"").startsWith("sync:"))syncedByKey.set(spendRowKey(r),r);});
  const conflicts=[];
  incomingRows.forEach(r=>{
    const synced=syncedByKey.get(spendRowKey(r));
    if(!synced)return;
    const diff=Math.abs((r.spend||0)-(synced.spend||0));
    if(diff>Math.max(1,synced.spend*0.01)){
      conflicts.push({
        key:spendRowKey(r),
        campaignGroupName:r.campaign_group_name,
        campaignName:r.campaign_name,
        date:r.date,
        syncedSpend:synced.spend,
        syncedPlatform:synced.source.replace(/^sync:/,""),
        importedSpend:r.spend,
      });
    }
  });
  return conflicts;
}

export const MONTH_ABBR={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

// ─── PACING ENGINE ────────────────────────────────────────────────────────────
// Robust date parser — handles "YYYY-MM-DD", "M/D/YYYY", "MM/DD/YY", month-label formats
// (see below), "YYYY-MM", and falls back to native Date parsing for anything else.
//
// MONTH-LABEL FIX (2026-07): Google/Bing's manual monthly exports report one row per month, with
// values like "Jul-26" (Google) or "2026-07-01" (Bing) rather than a real per-day date — both mean
// "the whole month," not a specific day. "2026-07-01" was already handled fine by the YYYY-MM-DD
// case above. "Jul-26" was NOT — it fell through to native `new Date("Jul-26")`, which (confirmed
// directly) parses it as day=26 of a fixed default year (2001), not July 2026. That's a real bug:
// silently sending a date decades in the past into every downstream calculation, which either drops
// the row from every period entirely (date never falls in range) or, combined with the per-platform
// freshness projection, feeds garbage into the pacing math. Handled explicitly now instead of
// trusting native parsing for this ambiguous shape. Represented as the 1st of that month, same
// convention as the existing YYYY-MM-DD handling of Bing's format.
export function parseSpendDate(v){
  if(!v)return null;
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m)return new Date(+m[1],+m[2]-1,+m[3]);
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if(m){let y=+m[3];if(y<100)y+=2000;return new Date(y,+m[1]-1,+m[2]);}
  // "Jul-26", "Jul 2026", "July-2026", "Jul/26" — month name/abbreviation + 2-or-4-digit year
  m=s.match(/^([A-Za-z]{3,9})[\s\-/]+(\d{2,4})$/);
  if(m){
    const mon=MONTH_ABBR[m[1].slice(0,3).toLowerCase()];
    if(mon!=null){let y=+m[2];if(y<100)y+=2000;return new Date(y,mon,1);}
  }
  // "2026-07" — year-month, no day
  m=s.match(/^(\d{4})-(\d{1,2})$/);
  if(m)return new Date(+m[1],+m[2]-1,1);
  const d=new Date(s);
  return isNaN(d.getTime())?null:d;
}

// Resolve a period type + selectors into a date range and the set of month-keys it covers
export function getPeriodRange(periodType,year,month,quarter){
  const y=Number(year);
  if(periodType==="monthly"){
    const m=Number(month);
    return{start:new Date(y,m-1,1),end:new Date(y,m,0),months:[month]};
  }
  if(periodType==="quarterly"){
    const qd=QUARTERS.find(q=>q.key===quarter)||QUARTERS[0];
    const qi=Number(quarter.replace("Q",""));
    return{start:new Date(y,(qi-1)*3,1),end:new Date(y,qi*3,0),months:qd.months};
  }
  return{start:new Date(y,0,1),end:new Date(y,11,31),months:MONTHS.map(m=>m.key)};
}

// Renames every occurrence of a dimension value (e.g. Product "PowerON" -> "Power On") across:
// budgets (every year, any segKey with this dim's value at the matching position),
// budgetRowMeta (same segKey remapping), and campaign tags (every campaign tagged with the old
// value for this dimension). This is what makes an inline edit actually reconnect Pacing —
// renaming just the budget row's label alone wouldn't retag campaigns, so spend would still
// never match. If the renamed key collides with an already-existing segment, monthly budget
// amounts are summed rather than overwritten so no data is silently lost.
export function renameDimensionValue({budgets,budgetRowMeta,tags,budgetDims,dim,oldVal,newVal}){
  const dimIdx=budgetDims.indexOf(dim);
  if(dimIdx===-1||oldVal===newVal)return{budgets,budgetRowMeta,tags};

  const remapKey=oldKey=>{
    const parts=oldKey.split("|");
    if(parts.length!==budgetDims.length||parts[dimIdx]!==oldVal)return null;
    const newParts=[...parts];newParts[dimIdx]=newVal;
    return newParts.join("|");
  };

  const newBudgets=JSON.parse(JSON.stringify(budgets||{}));
  Object.keys(newBudgets).forEach(yr=>{
    const yearObj=newBudgets[yr];
    Object.keys(yearObj).forEach(oldKey=>{
      const newKey=remapKey(oldKey);
      if(!newKey||newKey===oldKey)return;
      const oldEntry=yearObj[oldKey];
      if(yearObj[newKey]){
        const merged={...yearObj[newKey]};
        merged.monthly={...(yearObj[newKey].monthly||{})};
        Object.entries(oldEntry.monthly||{}).forEach(([mk,amt])=>{merged.monthly[mk]=(merged.monthly[mk]||0)+(amt||0);});
        if(oldEntry.quarterly||yearObj[newKey].quarterly)merged.quarterly={...(oldEntry.quarterly||{}),...(yearObj[newKey].quarterly||{})};
        if(oldEntry.annual!=null&&merged.annual==null)merged.annual=oldEntry.annual;
        yearObj[newKey]=merged;
      }else{
        yearObj[newKey]=oldEntry;
      }
      delete yearObj[oldKey];
    });
  });

  const newBudgetRowMeta={...(budgetRowMeta||{})};
  Object.keys(budgetRowMeta||{}).forEach(oldKey=>{
    const newKey=remapKey(oldKey);
    if(!newKey||newKey===oldKey)return;
    if(!newBudgetRowMeta[newKey])newBudgetRowMeta[newKey]=newBudgetRowMeta[oldKey];
    delete newBudgetRowMeta[oldKey];
  });

  const newTags={...(tags||{})};
  Object.entries(tags||{}).forEach(([campaign,t])=>{
    if(t[dim]===oldVal)newTags[campaign]={...t,[dim]:newVal};
  });

  return{budgets:newBudgets,budgetRowMeta:newBudgetRowMeta,tags:newTags};
}

// Collapses budget segKeys that differ only by leading/trailing whitespace in one or more
// dimension values (e.g. "APAC|Search" and "APAC |Search" from two exports of "the same" budget
// file, or a spreadsheet that trims inconsistently) down to one, summing monthly amounts on
// collision -- same merge semantics as the intentional rename-merge in renameDimensionValue above,
// since a whitespace-only difference is never a genuinely different segment. Without this,
// re-importing a budget file whose values pick up stray whitespace on a later export creates a
// second, phantom segKey that coexists with the original instead of overwriting it -- both then
// count toward totals.budget in computePacing, silently doubling that segment's budgeted amount.
// Run once on load (see the workspace-data load effect) so any duplication already sitting in a
// workspace's stored data self-heals the next time it's opened, not just going forward.
export function consolidateBudgetSegKeys(budgets,budgetRowMeta){
  let changed=false;
  const newBudgets=JSON.parse(JSON.stringify(budgets||{}));
  const newBudgetRowMeta={...(budgetRowMeta||{})};
  Object.keys(newBudgets).forEach(yr=>{
    const yearObj=newBudgets[yr];
    const output={};
    Object.keys(yearObj).forEach(oldKey=>{
      const trimmedKey=oldKey.split("|").map(s=>s.trim()).join("|");
      const entry=yearObj[oldKey];
      if(trimmedKey!==oldKey){
        changed=true;
        if(newBudgetRowMeta[oldKey]&&!newBudgetRowMeta[trimmedKey]){newBudgetRowMeta[trimmedKey]=newBudgetRowMeta[oldKey];delete newBudgetRowMeta[oldKey];}
      }
      if(output[trimmedKey]){
        changed=true;
        const merged={...output[trimmedKey]};
        merged.monthly={...(output[trimmedKey].monthly||{})};
        Object.entries(entry.monthly||{}).forEach(([mk,amt])=>{merged.monthly[mk]=(merged.monthly[mk]||0)+(amt||0);});
        if(entry.quarterly||output[trimmedKey].quarterly)merged.quarterly={...(entry.quarterly||{}),...(output[trimmedKey].quarterly||{})};
        if(entry.annual!=null&&merged.annual==null)merged.annual=entry.annual;
        output[trimmedKey]=merged;
      }else{
        output[trimmedKey]=entry;
      }
    });
    newBudgets[yr]=output;
  });
  return{budgets:newBudgets,budgetRowMeta:newBudgetRowMeta,changed};
}

// Removes just the budgetDims tag values (not the whole campaign) from every campaign that
// matches this segment's exact dimension combo — used when deleting a budget row, so a deleted
// segment doesn't leave campaigns still carrying a tag combination with no budget behind it.
// Spend data itself is untouched; matching campaigns simply lose these specific tags and fall
// back to "needs review" in the Tagger. "Platform" is never actually stored as a tag (see
// buildCampaignPlatformIndex) so there's nothing to delete for it specifically — matching still
// needs platformIndex to know which campaigns it applies to, but the delete step itself just
// skips over it.
export function untagSegmentCampaigns(tags,budgetDims,segKey,platformIndex){
  const vals=segKey.split("|");
  if(vals.length!==budgetDims.length)return tags;
  const newTags={...(tags||{})};
  Object.entries(tags||{}).forEach(([campaign,t])=>{
    const matches=budgetDims.every((d,i)=>resolveBudgetDimValue(d,campaign,t,platformIndex)===vals[i]);
    if(!matches)return;
    const nt={...t};
    budgetDims.forEach(d=>{if(!DERIVED_DIMS.includes(d))delete nt[d];});
    newTags[campaign]=nt;
  });
  return newTags;
}
// Campaigns matching a segment aren't limited to ones already present in `tags` once "Platform"
// is one of the budgetDims — a campaign with zero manual tags can still match a Platform-only (or
// Platform + already-tagged) segment. Unions tag-known campaign keys with platform-known ones so
// both are considered; platformIndex is only needed (and only non-empty) when budgetDims actually
// includes "Platform" — every other caller passes it as undefined and gets the old behavior.
export function countSegmentCampaigns(tags,budgetDims,segKey,platformIndex){
  const vals=segKey.split("|");
  if(vals.length!==budgetDims.length)return 0;
  const allKeys=new Set([...Object.keys(tags||{}),...(platformIndex?Object.keys(platformIndex):[])]);
  let count=0;
  allKeys.forEach(key=>{
    const t=(tags||{})[key]||{};
    const matches=budgetDims.every((d,i)=>resolveBudgetDimValue(d,key,t,platformIndex)===vals[i]);
    if(matches)count++;
  });
  return count;
}

// Reporting drill-down: sums spend for a segment (matched by budgetDims/segKey, within a date
// range) grouped by ONE secondary dimension — independent of budgets entirely, so it works
// whether or not a formal budget exists at that level. "Platform" is a synthetic option derived
// per-row (same logic the rest of the app uses for platform badges), since it isn't a manual tag.
//
// Daily Burn/Projected (2026-08-01, per Mo — expanding a segment to break it down by Campaign/
// Ad Group/Region/Funnel/Pillar/etc. only ever showed Spend on the drill-down rows, even though
// the parent row right above it always shows Daily Burn and Projected too). Mirrors computePacing's
// own platformSpendMap→projectPlatformSegment approach exactly, just keyed by breakdown value
// instead of by segKey — each breakdown value gets its own per-platform run-rate projection so a
// "Campaign A" row that's mostly Meta and "Campaign B" that's mostly Google each get projected off
// their own platform's freshness/seasonality, not one blended rate for the whole segment. Callers
// that don't pass `today` (nothing currently doesn't) will simply get dailyRate/projected back as
// 0/null for every row, same failure mode as omitting `today` from computePacing.
export function computeSpendBreakdown({mergedNormRows,tags,budgetDims,segKey,breakdownDim,start,end,today,forecastModel,combineGoogleChannels=false}){
  const vals=segKey.split("|");
  const totalDays=Math.round((end-start)/86400000)+1;
  const platformFreshness=computePlatformFreshness(mergedNormRows);
  const platformDowIndex=computePlatformDayOfWeekIndex(mergedNormRows);
  const map={};
  const platformSpendMap={};
  mergedNormRows.forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d||d<start||d>end)return;
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    if(!budgetDims.every((dim,i)=>resolveDimValue(row,rowTags,dim,combineGoogleChannels)===vals[i]))return;
    const bval=resolveDimValue(row,rowTags,breakdownDim,combineGoogleChannels)||"Untagged";
    map[bval]=(map[bval]||0)+row.spend;
    // Intentionally keyed by real platform regardless of combineGoogleChannels — same reasoning as
    // computePacing's identical platformSpendMap loop.
    const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
    if(!platformSpendMap[bval])platformSpendMap[bval]={};
    if(!platformSpendMap[bval][platform])platformSpendMap[bval][platform]={total:0,byDate:{}};
    platformSpendMap[bval][platform].total+=row.spend;
    const dateKey=localISODate(d);
    platformSpendMap[bval][platform].byDate[dateKey]=(platformSpendMap[bval][platform].byDate[dateKey]||0)+row.spend;
  });
  const total=Object.values(map).reduce((s,v)=>s+v,0);
  const elapsedDays=today==null?0:today<start?0:today>end?totalDays:Math.floor((today-start)/86400000)+1;
  return Object.entries(map).map(([value,spend])=>{
    const{projectedSum,dailyRate,lowConfidencePlatforms}=projectPlatformSegment(platformSpendMap[value],platformFreshness,{start,end,today,totalDays,forecastModel,platformDowIndex});
    const projected=elapsedDays>0?projectedSum:null;
    return{value,spend,pct:total>0?spend/total:0,dailyRate,projected,lowConfidencePlatforms};
  }).sort((a,b)=>b.spend-a.spend);
}

// ─── NUMERIC THRESHOLD FILTERS (2026-07-28, per Mo) ────────────────────────────
// Shared {field,operator,value} filter shape — powers Reporting & Pacing's numeric filter chips
// (PacingDashboard's numericFilters state) AND Ask AI's query_pacing/query_spend/query_budget
// "having" param and apply_view's numeric_filters param, so a filter built by a person clicking
// through the UI and a filter the model constructs from a plain-English question behave
// identically (both end up calling matchesNumericFilters against the exact same segment/breakdown
// objects). `field` is the raw property name on a computePacing/computeCustomGrouping segment (or
// a query_spend/query_budget breakdown entry) — see NUMERIC_FIELDS below for the full list and
// their user-facing labels/units, not raw property names, which is what a UI dropdown or a tool
// description should show instead of these.
//
// "actualPct" (Pacing %) is stored as a plain fraction (1===100%, matching how the rest of the app
// already computes/displays it — see computePacing), so a value of "50" typed for a 50% threshold
// must be divided by 100 BEFORE it reaches matchesNumericFilter — every caller that accepts a
// human-typed percent value is responsible for that conversion (see PacingDashboard's filter-chip
// form and askAI.js's having-filter handling), not this function, since by the time a filter object
// exists here it should already be apples-to-apples with the field it's being compared against.
export const NUMERIC_OPERATORS=[">","<",">=","<=","="];
export const NUMERIC_FIELDS={
  spend:{label:"Spend PTD",unit:"$",modes:["budget","custom"]},
  budget:{label:"Budget",unit:"$",modes:["budget"]},
  actualPct:{label:"Pacing",unit:"%",modes:["budget"],isPct:true},
  dailyRate:{label:"Daily Burn",unit:"$",modes:["budget","custom"]},
  projected:{label:"Projected",unit:"$",modes:["budget","custom"]},
  projectedVariance:{label:"Variance",unit:"$",modes:["budget"]},
};
export function matchesNumericFilter(actual,operator,value){
  if(actual==null||typeof actual!=="number"||Number.isNaN(actual))return false;
  switch(operator){
    case ">":return actual>value;
    case "<":return actual<value;
    case ">=":return actual>=value;
    case "<=":return actual<=value;
    case "=":return Math.abs(actual-value)<0.005; // cent-level tolerance — these are $ and % comparisons, not exact integers
    default:return false;
  }
}
// obj is whatever the filter's `field` should be read off — a full computePacing/
// computeCustomGrouping segment, or a lighter aggregate object (e.g. an Ask AI breakdown group)
// that only has some of NUMERIC_FIELDS' keys. A filter naming a field the object doesn't have
// simply never matches (matchesNumericFilter's typeof guard), rather than throwing.
export function matchesNumericFilters(obj,filters){
  return (filters||[]).every(f=>matchesNumericFilter(obj?.[f.field],f.operator,f.value));
}

// ─── ASK AI ───────────────────────────────────────────────────────────────────
// Grounded query tools + tool-use loop backing the "Ask AI" chat. Rather than dumping raw
// spend rows into a prompt and hoping the model's arithmetic is right, Claude is given a small
// set of tools that run REAL JS aggregation (the same kind of filter+sum used by Pacing's
// breakdown above) and can only answer from what those tools actually return — the model does
// the natural-language understanding (parsing "January vs March", matching "EMEA" to a Region
// tag) but never invents a number itself.

// Tool schemas in Anthropic's tool-use format.
//
// EXPANDED 2026-07-21: originally spend-only (query_spend) — Ask AI had no way to answer anything
// about budgets (what was ALLOCATED) or pacing (allocated vs actual together), and no way to
// isolate tagged vs. untagged spend specifically, even though those are exactly the three lenses
// the rest of the app is built around (Budget Panel = allocation, Tagger = tagged/untagged spend,
// Reporting & Pacing = both together). Added query_budget (budget data alone), query_pacing
// (budget + spend together, mirroring computePacing's own status/variance logic so Ask AI's
// answers can't drift from what the Reporting tab itself shows), and a tagged_status filter on
// query_spend (spend data alone, sliced by whether a campaign carries every Budget By tag or not).

export function computeActualsByMonth({mergedNormRows,tags,budgetDims,year,combineGoogleChannels=false}){
  const map={};
  if(!budgetDims.length)return map;
  mergedNormRows.forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d||d.getFullYear()!==Number(year))return;
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    const vals=budgetDims.map(dim=>resolveDimValue(row,rowTags,dim,combineGoogleChannels));
    if(vals.some(v=>!v))return;
    const sk=vals.join("|");
    const mk=String(d.getMonth()+1).padStart(2,"0");
    if(!map[sk])map[sk]={};
    map[sk][mk]=(map[sk][mk]||0)+row.spend;
  });
  return map;
}

// For each derived platform, the most recent date we actually have spend data for — global,
// not scoped to any one period. This is what "last updated" means per source: live-synced
// platforms (LinkedIn, Capterra) are current as of the last sync, but manually-uploaded ones
// (Google, Bing CSVs) are only as fresh as the last time someone re-uploaded a file, which is
// often days behind "today". Used both to drive the corrected pacing projection below and to
// show a per-platform freshness indicator in the Pacing UI.
export function computePlatformFreshness(mergedNormRows){
  const map={};
  (mergedNormRows||[]).forEach(row=>{
    // as_of_date (set at upload time via the "Data accurate through" override) takes priority
    // over the row's own Date column — needed for range-exported platforms (Google/Bing) where
    // Date often reflects the range's START rather than the as-of/end date the spend is actually
    // current through. See uploadAsOf state comment in the map step for the full explanation.
    const d=row.as_of_date?parseSpendDate(row.as_of_date):parseSpendDate(row.date);
    if(!d)return;
    const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
    if(!map[platform]||d>map[platform])map[platform]=d;
  });
  return map;
}

// Per-platform day-of-week spend index — e.g. index[3]===1.4 means Wednesdays for this platform run
// ~40% above that platform's typical day, index[0]===0.3 means Sundays run ~70% below. Computed
// from ALL of a workspace's spend history (not scoped to any one period, same as
// computePlatformFreshness above), since a segment newly created this quarter won't have enough of
// its own history yet to learn a weekly shape from.
//
// WHY THIS MATTERS (added 2026-07-25, per Mo): projectPlatformSegment's trailing-N-day models
// (especially trailing1/trailing3) previously treated every day as interchangeable — a Sunday's
// naturally-quieter $50 spend read as "the daily rate crashed to $50," not "this is a normal
// Sunday." That's real noise in the projection, not signal. This index lets the projection
// deseasonalize each known day (actual ÷ that weekday's index = a "typical-day-equivalent" amount)
// before averaging, then reseasonalize when projecting forward (typical-day rate × each future
// day's own index) — see projectPlatformSegment for the actual math. With every index at the
// neutral default of 1 (below), this reduces to exactly the old flat-average behavior, so this is
// a strict accuracy improvement, not a new mode to pick.
//
// Platform-level, not per-segment: most individual segments won't have enough history yet to
// reliably learn their own weekly shape (a brand-new campaign has zero), while a platform's overall
// shape (aggregated across every campaign on it) has much more data to work with sooner. A
// reasonable simplification — revisit if a specific segment's real pattern turns out to diverge
// meaningfully from its platform's overall shape (e.g. a B2B-only campaign on a platform whose
// other campaigns skew consumer/weekend-heavy).
//
// EXCLUDES is_monthly rows entirely (2026-07-30, per Mo — the "DOW-seasonality contamination"
// gap): a monthly-grain CSV/screenshot upload lands as ONE row dated to the 1st of that month,
// holding the FULL MONTH's spend — nothing spreads/prorates it across real days. Counting that row
// into a single weekday's bucket the way a real day's row is counted would make "$50k really spent
// across 30 days" look like "$50k spent on one Wednesday," badly inflating whichever weekday that
// row's date happens to fall on. This matters most for a platform that's mixed-history — some
// months manually uploaded before it was ever connected, then live-synced (real daily rows) after
// — since the index is computed from ALL history, not scoped to one period, so old monthly-grain
// rows would otherwise permanently skew that platform's learned weekly shape even long after
// real daily data starts flowing in. A platform with ONLY monthly-grain rows (no real daily data
// at all) simply won't accumulate any trusted weekday samples here — it falls back to the neutral
// default (1 for every day) below, which is the correct, safe behavior for that case too.
export const DOW_MIN_SAMPLES=3; // need at least this many distinct historical occurrences of a weekday
                          // before trusting an index computed from it — otherwise neutral (1).
export const DOW_INDEX_CLAMP=[0.25,3]; // one outlier historical day can't swing the index past this range
export function computePlatformDayOfWeekIndex(mergedNormRows){
  const sums={}; // {platform: [{total,days:Set<dateStr>} x7]}, index 0=Sunday..6=Saturday (Date#getDay)
  (mergedNormRows||[]).forEach(row=>{
    if(row.is_monthly)return; // see EXCLUDES doc comment above
    const d=parseSpendDate(row.date);
    if(!d)return;
    const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
    if(!sums[platform])sums[platform]=Array.from({length:7},()=>({total:0,days:new Set()}));
    const bucket=sums[platform][d.getDay()];
    bucket.total+=row.spend||0;
    bucket.days.add(localISODate(d));
  });
  const index={};
  Object.entries(sums).forEach(([platform,byDow])=>{
    const dailyAvgs=byDow.map(b=>b.days.size?b.total/b.days.size:null);
    const trustedAvgs=dailyAvgs.filter((v,i)=>v!=null&&byDow[i].days.size>=DOW_MIN_SAMPLES);
    const overallAvg=trustedAvgs.length?trustedAvgs.reduce((s,v)=>s+v,0)/trustedAvgs.length:null;
    index[platform]=dailyAvgs.map((v,i)=>{
      if(v==null||byDow[i].days.size<DOW_MIN_SAMPLES||!overallAvg||overallAvg<=0)return 1;
      return Math.min(DOW_INDEX_CLAMP[1],Math.max(DOW_INDEX_CLAMP[0],v/overallAvg));
    });
  });
  return index; // {platform: [sunIdx,monIdx,tueIdx,wedIdx,thuIdx,friIdx,satIdx]}
}
export const DEFAULT_DOW_INDEX=[1,1,1,1,1,1,1];

// Full min/max date range of spend data actually present in PaidHQ for each platform, regardless
// of how it got there (live sync, Google Sheets pull, CSV/screenshot upload). Distinct from
// computePlatformFreshness above, which is specifically "as of what date is this platform's
// spend current" for pacing/projection math (as_of_date-aware, always the max). This is the
// simpler, source-agnostic question "what date range of data do we actually have for this
// platform" — uses each row's own Date column directly (not as_of_date, which describes when
// a range-exported upload was accurate through, not what calendar days its rows represent).
export function computePlatformDateRange(mergedNormRows){
  const map={};
  (mergedNormRows||[]).forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d)return;
    const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
    if(!map[platform])map[platform]={min:d,max:d};
    else{
      if(d<map[platform].min)map[platform].min=d;
      if(d>map[platform].max)map[platform].max=d;
    }
  });
  return map;
}

// Core pacing calculation: aggregates spend into budget segments for a period and compares
// actual spend-to-date against time-elapsed expectation.
//
// PROJECTION NOTE (fixed 2026-07): the naive version of this divided a segment's TOTAL blended
// spend (across every platform) by ONE shared "days elapsed since period start" figure based on
// calendar "today". That's wrong whenever platforms don't all report in real time — e.g. Google/
// Bing here are manually re-uploaded roughly weekly, so their spend total is frozen as of the
// last upload while "days elapsed" keeps climbing every calendar day regardless. That understated
// their daily rate more and more between uploads, then jumped all at once when fresh data landed.
// LinkedIn/Capterra are live-synced and always current, so they didn't have this problem — but
// blending them together with the stale platforms let the stale ones drag the whole segment's
// projection down.
//
// Fix: each platform's rate is computed against ITS OWN as-of date (computePlatformFreshness,
// clamped to the period and to today), then each platform's projection is summed per segment —
// instead of blending raw spend first and dividing by one shared calendar-elapsed-days number.
//
// Shared by both computePacing (budget segments) and computeCustomGrouping (arbitrary dimension
// view) — the per-platform projection math doesn't care what a segment IS, only how much each
// platform spent within it and how fresh that platform's data is.
//
// forecastModel (optional, computePacing only — computeCustomGrouping never passes one, which
// now means it gets Auto below, same as any segment that hasn't set anything explicitly):
//   - "auto" (or unset/unrecognized) — see computeAutoBlendWeight and the isAuto branch below.
//   - "trailingN" (Manual) — a single flat N-day window, no blending. N is parsed straight out of
//     the model string rather than hardcoded per value.
//   - "full-period" (legacy only, no longer offered in the UI) — a single flat window of every
//     elapsed day, exactly the pre-2026-07-25 default behavior.
//   - "committed" — reaches this function too (harmless; computePacing ignores its projectedSum
//     and uses the committed amount directly instead), takes the full-period branch.
//
// platformDowIndex (optional — see computePlatformDayOfWeekIndex; omitted/missing entries fall
// back to DEFAULT_DOW_INDEX, i.e. neutral/no adjustment) deseasonalizes every known day in each
// estimation window before averaging (actual ÷ that weekday's index), then reseasonalizes when
// projecting across the full period (typical-day rate × each individual day's own index, summed —
// not a flat totalDays count, since a period ending on a weekend has a different weekday mix than
// one ending mid-week). This is what fixes a short window's biggest weakness: without it, a quiet
// Sunday reads as "spend crashed," not "this is a normal Sunday."
//
// Shared by both computePacing (budget segments) and computeCustomGrouping (arbitrary dimension
// view) — the per-platform projection math doesn't care what a segment IS, only how much each
// platform spent within it, how fresh that platform's data is, and (now) that platform's weekly
// shape. requires platformSpendMap's per-platform entries to carry a `byDate` breakdown (see
// computePacing's aggregation loop) — computeCustomGrouping's entries have one too for this reason.

// Shared by both branches below — averages a platform's deseasonalized daily spend (actual ÷ that
// weekday's index) over the `windowDays` immediately before and including `asOf`. A flat window,
// same math either way; what differs between Auto and Manual/full-period is which window(s) get
// computed and how they're combined, not how any single window itself is averaged.
function deseasonalizedRate(byDate,dowIdx,asOf,windowDays){
  if(!windowDays)return 0;
  let sum=0;
  for(let i=0;i<windowDays;i++){
    const d=new Date(asOf.getTime()-i*86400000);
    sum+=(byDate[localISODate(d)]||0)/(dowIdx[d.getDay()]||1);
  }
  return sum/windowDays;
}
// Auto's tuning knobs. Below AUTO_DIVERGENCE_LOW relative difference between the long-run and
// short-run rate, they're close enough that the long-run (more stable, less noisy) rate is used
// outright. Above AUTO_DIVERGENCE_HIGH, they've diverged enough that something real clearly
// changed recently (a budget shift, a platform coming online, a pause), so the short-run rate is
// trusted outright instead. In between, a linear ramp blends the two — no hard cutoff, so a
// borderline segment doesn't flip its whole projection based on one extra dollar of spend.
export const AUTO_SHORT_WINDOW=7;
export const AUTO_DIVERGENCE_LOW=0.15;
export const AUTO_DIVERGENCE_HIGH=0.50;
// Returns the WEIGHT ON THE SHORT RATE, 0 (ignore it, pure long-run) to 1 (pure short-run). Only
// exported for testability/reuse — projectPlatformSegment is the only real caller.
export function computeAutoBlendWeight(longRate,shortRate){
  if(!(longRate>0))return shortRate>0?1:0; // nothing to compare against yet — trust whatever exists
  const divergence=Math.abs(shortRate-longRate)/longRate;
  if(divergence<=AUTO_DIVERGENCE_LOW)return 0;
  if(divergence>=AUTO_DIVERGENCE_HIGH)return 1;
  return(divergence-AUTO_DIVERGENCE_LOW)/(AUTO_DIVERGENCE_HIGH-AUTO_DIVERGENCE_LOW);
}
export function projectPlatformSegment(platformSpendMap,platformFreshness,{start,end,today,totalDays,forecastModel,platformDowIndex}){
  let platformProjectedSum=0;
  // See PROJECTION NOTE above — platforms whose projection here was extrapolated from a single
  // day of data across a multi-day period get flagged so the UI can warn instead of silently
  // trusting a wildly inflated number.
  const lowConfidencePlatforms=[];
  const trailingMatch=/^trailing(\d+)$/.exec(forecastModel||"");
  const trailingDays=trailingMatch?parseInt(trailingMatch[1],10):null;
  // Anything that isn't a recognized Manual (trailingN), the legacy "full-period" literal, or
  // "committed" gets Auto — which includes the explicit "auto" string, undefined (every
  // computeCustomGrouping call), and any unrecognized future value, so this fails toward the
  // better default rather than silently reverting to flat full-period math.
  const isAuto=!trailingDays&&forecastModel!=="full-period"&&forecastModel!=="committed";
  Object.entries(platformSpendMap||{}).forEach(([platform,pData])=>{
    const byDate=pData?.byDate||{};
    const dowIdx=platformDowIndex?.[platform]||DEFAULT_DOW_INDEX;
    const freshest=platformFreshness[platform];
    let asOf=freshest&&freshest<today?freshest:today;
    if(asOf>end)asOf=end;
    const pElapsedDays=asOf<start?0:Math.min(totalDays,Math.floor((asOf-start)/86400000)+1);
    // Actual dollars this platform has already spent within the period, straight off the segment
    // aggregation this got built from (computePacing/computeCustomGrouping's platformSpendMap
    // loop) — see the REMAINING-DAYS fix below for why the projection adds to this instead of
    // trying to re-derive it.
    const periodTotal=pData?.total||0;
    if(pElapsedDays>0){
      let typicalDayRate;
      if(isAuto){
        // Blend the full-period ("long-run") deseasonalized rate with a short recent window,
        // weighted by how much they've diverged (computeAutoBlendWeight). Barely any history yet
        // (pElapsedDays<=AUTO_SHORT_WINDOW) skips the blend entirely — a "recent window" isn't
        // meaningfully different from "everything so far" yet, so there's nothing to weigh.
        const longRate=deseasonalizedRate(byDate,dowIdx,asOf,pElapsedDays);
        if(pElapsedDays>AUTO_SHORT_WINDOW){
          const shortRate=deseasonalizedRate(byDate,dowIdx,asOf,AUTO_SHORT_WINDOW);
          const weight=computeAutoBlendWeight(longRate,shortRate);
          typicalDayRate=longRate+(shortRate-longRate)*weight;
        }else{
          typicalDayRate=longRate;
        }
      }else{
        // Manual (trailingN) or legacy full-period — one flat window, no blending. Window is
        // clamped to min(trailingDays,pElapsedDays) so a segment only a few days into its period
        // ramps up gracefully instead of needing N full days of history before producing a number.
        const window=trailingDays?Math.min(trailingDays,pElapsedDays):pElapsedDays;
        typicalDayRate=deseasonalizedRate(byDate,dowIdx,asOf,window);
      }
      // REMAINING-DAYS FIX (2026-07-28, per Mo — projected was coming back LOWER than actual
      // period-to-date spend whenever the recent rate diverged from the rate earlier in the
      // period, e.g. a segment that spent heavily in week 1 then slowed down in week 4). The old
      // math threw away the platform's real accumulated spend and re-derived a total for the
      // ENTIRE period — elapsed days included — from whichever rate it just computed, so a lower
      // recent rate could project a full-period total smaller than what had already actually
      // landed. Fixed by adding the real period-to-date total directly, then only extrapolating
      // the REMAINING days (the day after asOf through end) at the computed rate — a projection
      // can now never fall below money that's already been spent, and the rate only has to
      // explain what happens next, not re-explain what already happened.
      let periodDowSum=0;
      for(let d=new Date(asOf.getTime()+86400000);d<=end;d=new Date(d.getTime()+86400000)){
        periodDowSum+=dowIdx[d.getDay()]||1;
      }
      platformProjectedSum+=periodTotal+typicalDayRate*periodDowSum;
    }else{
      platformProjectedSum+=periodTotal;
    }
    if(pElapsedDays===1&&totalDays>1)lowConfidencePlatforms.push(platform);
  });
  return{projectedSum:platformProjectedSum,dailyRate:totalDays?platformProjectedSum/totalDays:0,lowConfidencePlatforms};
}

// Every Google-family sub-channel derivePlatform() can produce — the full menu a workspace can
// choose to fold into a combined "Google" line, one channel at a time (2026-07-31, per Mo).
// Exported so both the Settings UI's per-channel checkboxes and the one-time budget-row migration
// (see renameDimensionValue call sites in PaidHQ.jsx) iterate this exact same list instead of a
// second, easily-drifting copy of "which values count as Google."
//
// WIDENED (2026-07-31) from a fixed 3-item list (Search/Display/Demand Gen) that used to be
// hardcoded into a single all-or-nothing toggle — Performance Max and YouTube were deliberately
// left out of THAT version since it was all-or-nothing and lumping every Google product together
// wasn't what was asked for. Now that combining is opt-in PER channel (see combineGoogleChannels'
// new shape below), there's no reason not to offer every channel — a workspace that wants Search
// and YouTube kept separate but everything else combined just leaves those two unchecked.
export const GOOGLE_SUBCHANNELS=["Google Search","Google Display","Demand Gen","Performance Max","YouTube"];
// combineGoogleChannels (2026-07-30, per Mo; reshaped 2026-07-31) used to be a single boolean —
// Search/Display/Demand Gen either ALL combined into "Google" or all separate, no in-between. Per
// Mo: "they need to have the flexibility to combine or separate whatever they want, not just a
// toggle on or off" — e.g. combine everything except YouTube, or keep only Search separate. It's
// now an object, {channelName: true} meaning "fold this one into Google" — any channel absent or
// false stays under its own real label. Every caller across the codebase (PaidHQ.jsx,
// PacingDashboard.jsx, BudgetManager.jsx, AskAI.jsx, Dashboard.jsx, askAI.js, reports.js) just
// threads this value through by the same prop name without interpreting it themselves, so none of
// them needed to change — only groupGooglePlatform (the one place that actually reads it) did.
// A plain `false` (every existing default={false} prop across those files) still behaves exactly
// like "nothing combined" below, so nothing broke by leaving those defaults alone.
//
// Collapses a derived platform label to "Google" when it's one of GOOGLE_SUBCHANNELS AND this
// workspace has that specific channel checked (combine[platform] is truthy). Pure display/grouping
// mapping only — derivePlatform() itself is untouched, so computePlatformFreshness/
// computePlatformDayOfWeekIndex/platformSpendMap (the actual forecasting engine) keep tracking every
// sub-channel separately regardless of this setting, each with its own accurate freshness and
// day-of-week seasonality — see projectPlatformSegment, which already sums every platform within a
// segment together. Combining only changes which BUDGET SEGMENT/BREAKDOWN ROW a campaign's spend
// counts toward, never how accurately any individual platform's own spend is forecast.
//
// `combine` accepts the per-channel object described above, or a plain falsy value (the default
// used across every caller) meaning "nothing combined." Exported (2026-07-31) — Campaign Tagger and
// the Data Sources "Spend by platform" widget call this directly (not through resolveDimValue,
// which needs a rowTags object they don't have handy) so the SAME grouping choice is visible
// everywhere Platform shows up, not just Budget Panel/Pacing/Ask AI.
export function groupGooglePlatform(platform,combine){
  return combine&&combine[platform]?"Google":platform;
}
// One-time shape migration for a workspace's saved combineGoogleChannels, run on every config load
// (2026-07-31, per Mo's reshape from boolean to per-channel object — see the doc comment above
// GOOGLE_SUBCHANNELS). Three cases:
//   - already the new {channel:bool} shape → keep every existing choice, just fill in any channel
//     added to GOOGLE_SUBCHANNELS since this workspace last saved (Performance Max/YouTube, both
//     brand new) as false/separate, since that's what "not chosen yet" should mean, not silently
//     opting a workspace into combining a channel it never asked about.
//   - legacy `true` (the old all-or-nothing toggle, ON) → preserves EXACTLY what was already
//     combined under the old rules: Search/Display/Demand Gen (the old hardcoded 3), nothing else —
//     a workspace that had this on yesterday sees the identical grouping today, just now editable
//     per channel instead of all-or-nothing.
//   - legacy `false`/missing/anything else → nothing combined, same as a brand new workspace.
export function migrateGoogleChannelGrouping(saved){
  const base=Object.fromEntries(GOOGLE_SUBCHANNELS.map(c=>[c,false]));
  if(saved&&typeof saved==="object")return{...base,...saved};
  if(saved===true)return{...base,"Google Search":true,"Google Display":true,"Demand Gen":true};
  return base;
}
// Resolves a single dimension's value for a spend row — "Platform"/"Campaign"/"Ad Group" (see
// DERIVED_DIMS) are all derived straight from the row itself (not a manual tag): Platform via
// derivePlatform(), Campaign from campaign_group_name, Ad Group from campaign_name — everything
// else comes from that campaign's tags. Shared by computePacing, computeCustomGrouping,
// computeSpendBreakdown, and their breakdown counterparts so these pseudo-dimensions behave
// identically wherever they're used as a grouping or breakdown dimension.
//
// combineGoogleChannels (optional, default false) only affects the "Platform" branch — see
// groupGooglePlatform above.
export function resolveDimValue(row,rowTags,dim,combineGoogleChannels=false){
  if(dim==="Platform")return groupGooglePlatform(derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type),combineGoogleChannels);
  if(dim==="Campaign")return row.campaign_group_name||"";
  if(dim==="Ad Group")return row.campaign_name||"";
  return rowTags[dim]||"";
}

// Capacity-vs-budget signal (added 2026-07-25, per Mo — the other half of "why is this segment
// behind pace," alongside the day-of-week work above). Nothing before this distinguished "behind
// pace because nobody raised the budget/bids" from "behind pace because the campaign(s)
// structurally can't spend more" (audience size, frequency cap, or the ad platform's own bid/
// approval limits capping delivery) — a budget-headroom number alone can't tell those apart, but
// `spend_rows`' impressions column (already collected, never used until now) can: if a segment's
// impressions have been flat for a couple weeks despite real budget headroom, more budget alone
// won't fix it, because delivery has hit some ceiling that has nothing to do with the dollar
// amount. Requires BOTH spend AND impressions to be flat — impressions flat while spend keeps
// climbing (or vice versa) usually just means costs changed (CPM/CPC drift, bid strategy), not a
// delivery ceiling, so this only ever looks at impressions, not spend, to make that call.
//
// Heuristic, not a hard verdict — returns:
//   "constrained" — genuinely behind pace, has budget headroom, AND impressions haven't grown
//                   meaningfully over the last two comparable windows. Worth a human look.
//   "growing"     — behind pace with headroom, but impressions ARE still climbing — give it time,
//                   don't necessarily push more budget/bids at it yet.
//   null          — not enough signal either way: not behind pace, no headroom, or too little
//                   impressions history yet to compare two windows.
//
// Known limitation: only counts CALENDAR DAYS THAT HAVE AT LEAST ONE ROW as part of the window, so
// a campaign paused for a few days (zero rows, not zero-valued rows) silently shrinks the window
// rather than counting as a real dip — reasonable for a v1 heuristic, not a claim of precision.
export const CAPACITY_MIN_DAYS=10; // need at least this many distinct days of impressions history total
export const CAPACITY_WINDOW=7; // compare the last N days against the N days before that
export const CAPACITY_GROWTH_THRESHOLD=0.15; // impressions must grow at least 15% to count as "still growing"
export function detectCapacitySignal(dailyMap,{expectedPct,actualPct,budget,spend}){
  if(!(budget>0)||spend>=budget)return null; // no headroom left to even ask the question
  if(actualPct==null)return null;
  // Mirrors computePacing's own "behind" threshold (delta<-0.1) — only worth asking this question
  // when the segment is actually reading as behind pace, not just slightly under expected.
  if(actualPct-expectedPct>=-0.1)return null;
  const dates=Object.keys(dailyMap||{}).sort();
  if(dates.length<CAPACITY_MIN_DAYS)return null;
  const recent=dates.slice(-CAPACITY_WINDOW);
  const prior=dates.slice(-CAPACITY_WINDOW*2,-CAPACITY_WINDOW);
  if(prior.length<Math.floor(CAPACITY_WINDOW/2))return null; // not enough of a "before" window to compare against
  const avgImpr=days=>days.length?days.reduce((s,d)=>s+(dailyMap[d].impressions||0),0)/days.length:0;
  const recentImpr=avgImpr(recent);
  const priorImpr=avgImpr(prior);
  if(priorImpr<=0)return null; // can't compute meaningful growth off a zero base
  return(recentImpr-priorImpr)/priorImpr<CAPACITY_GROWTH_THRESHOLD?"constrained":"growing";
}

// defaultForecastModel (optional, 2026-07-25) — the workspace-wide fallback set via
// PacingDashboard's global model selector (see PaidHQ's own defaultForecastModel state/prop
// threading). A row's own budgetRowMeta[sk]._forecastModel, when present, always wins over this —
// see the fallback chain below, same priority order as the legacy _committed key. Every caller
// that doesn't have this value handy (report builders, AI tools called from contexts that never
// threaded it through) can simply omit it; it defaults to "auto" (2026-07-25, was "full-period"
// before the Auto/Manual/Committed redesign — see FORECAST_MODELS above), so an un-updated caller
// now gets the better adaptive default instead of the old always-cumulative one.
export function computePacing({mergedNormRows,tags,budgetDims,budgets,year,periodType,month,quarter,today,budgetRowMeta,defaultForecastModel,combineGoogleChannels=false}){
  const{start,end,months}=getPeriodRange(periodType,year,month,quarter);
  const totalDays=Math.round((end-start)/86400000)+1;
  let elapsedDays;
  if(today<start)elapsedDays=0;
  else if(today>end)elapsedDays=totalDays;
  else elapsedDays=Math.floor((today-start)/86400000)+1;
  const daysRemaining=Math.max(0,totalDays-elapsedDays);
  const expectedPct=totalDays?elapsedDays/totalDays:0;
  const platformFreshness=computePlatformFreshness(mergedNormRows);
  const platformDowIndex=computePlatformDayOfWeekIndex(mergedNormRows);

  const spendMap={};
  // {segKey: {platform: {total, byDate: {"YYYY-MM-DD": spend}}}} — feeds the per-platform
  // projection. byDate exists so projectPlatformSegment can compute a trailing-window average
  // (not just the full-period-to-date one) when a segment's forecastModel asks for it — see that
  // function's doc comment.
  const platformSpendMap={};
  // {segKey: {"YYYY-MM-DD": {spend, impressions}}} — segment-level (summed across every platform,
  // unlike platformSpendMap above which stays split by platform), used only by
  // detectCapacitySignal below to compare recent-vs-prior spend/impressions trends. Capacity is a
  // read on "can this segment's total delivery grow at all," not a per-platform question, so it
  // doesn't need platformSpendMap's per-platform split.
  const segDailyMap={};
  // Independent of the period/date range — how many campaigns exist for each segment at all. If
  // this is 0 for a segment that has a budget, spend will NEVER show up for it no matter what
  // period you're looking at — it's a tagging/dimension mismatch, not "no spend yet".
  const campaignCountMap={};
  if(budgetDims.length){
    // Every campaign that's ever had spend data, not just ones with an entry in `tags` — a
    // budgetDims of just ["Platform"] resolves entirely from derived data (resolveDimValue),
    // needing zero manual tagging, so membership can't depend on the campaign already existing
    // as a tags key the way pure tag-dimension budgeting implicitly could.
    const seenCampaigns=new Set();
    mergedNormRows.forEach(row=>{
      const key=campaignKey(row.campaign_group_name,row.campaign_name);
      if(seenCampaigns.has(key))return;
      seenCampaigns.add(key);
      const rowTags=tags[key]||{};
      const vals=budgetDims.map(dim=>resolveDimValue(row,rowTags,dim,combineGoogleChannels));
      if(vals.some(v=>!v))return;
      const sk=vals.join("|");
      campaignCountMap[sk]=(campaignCountMap[sk]||0)+1;
    });
    mergedNormRows.forEach(row=>{
      const d=parseSpendDate(row.date);
      if(!d||d<start||d>end)return;
      const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
      const vals=budgetDims.map(dim=>resolveDimValue(row,rowTags,dim,combineGoogleChannels));
      if(vals.some(v=>!v))return;
      const sk=vals.join("|");
      spendMap[sk]=(spendMap[sk]||0)+row.spend;
      // Intentionally NOT grouped by combineGoogleChannels — platformSpendMap stays keyed by the
      // real granular platform even when its parent segment (sk, above) is combined into "Google",
      // so projectPlatformSegment (which sums every platform within a segment together) still runs
      // each real sub-channel's own accurate freshness/day-of-week seasonality. See
      // groupGooglePlatform's doc comment.
      const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
      if(!platformSpendMap[sk])platformSpendMap[sk]={};
      if(!platformSpendMap[sk][platform])platformSpendMap[sk][platform]={total:0,byDate:{}};
      platformSpendMap[sk][platform].total+=row.spend;
      const dateKey=localISODate(d);
      platformSpendMap[sk][platform].byDate[dateKey]=(platformSpendMap[sk][platform].byDate[dateKey]||0)+row.spend;
      if(!segDailyMap[sk])segDailyMap[sk]={};
      if(!segDailyMap[sk][dateKey])segDailyMap[sk][dateKey]={spend:0,impressions:0};
      segDailyMap[sk][dateKey].spend+=row.spend;
      segDailyMap[sk][dateKey].impressions+=row.impressions||0;
    });
  }

  const yearBudgets=budgets[year]||{};
  const segKeys=new Set([...Object.keys(yearBudgets),...Object.keys(spendMap)]);

  const segments=[...segKeys].map(sk=>{
    const monthly=yearBudgets[sk]?.monthly||{};
    const budget=months.reduce((s,mk)=>s+(monthly[mk]||0),0);
    const spend=spendMap[sk]||0;
    const dims=sk.split("|");
    // Whether ANY spend row actually matched this segment in this period — distinct from spend===0,
    // which is also true for a segment nobody's synced data for yet. Without this, a never-synced
    // segment's actualPct computes as a real 0%, which then reads as a genuine "behind pace" delta.
    const hasData=!!platformSpendMap[sk];
    const actualPct=budget>0&&hasData?spend/budget:null;
    // Per-segment forecast model (Auto, Committed lump-sum, or Manual trailing-N-day average) —
    // flagged per budget line (same _-prefixed-key-in-budgetRowMeta pattern as _notBudgeted, set
    // via PacingDashboard's per-row model picker) rather than inferred from spend shape, since
    // "this is a lump sum" / "I want a specific window" is knowledge the user has that the data
    // itself can't reveal. Priority: an explicit per-row override always wins, then the legacy
    // `_committed` boolean (segments toggled on before multi-model shipped), then the workspace's
    // global default (see defaultForecastModel above), then "auto" as the last-resort default if
    // nothing is set anywhere. See item 45 in ROADMAP.md.
    const rowMeta=budgetRowMeta?.[sk]||{};
    const forecastModel=rowMeta._forecastModel||(rowMeta._committed?"committed":(defaultForecastModel||"auto"));
    const committed=forecastModel==="committed";

    // Sum each platform's own projection rather than one blended rate — see PROJECTION NOTE.
    const{projectedSum,dailyRate,lowConfidencePlatforms}=projectPlatformSegment(platformSpendMap[sk],platformFreshness,{start,end,today,totalDays,forecastModel,platformDowIndex});
    // Committed rows skip the run-rate extrapolation entirely — projected is just the committed
    // amount (budget), or actual spend if that's already higher (an overspend is still real even
    // on a committed line). Everything else (full-period or trailing-N) uses whatever daily rate
    // projectPlatformSegment computed for that model.
    const projected=committed?Math.max(spend,budget):(elapsedDays>0&&hasData?projectedSum:null);
    const projectedVariance=budget>0&&projected!=null?projected-budget:null;
    let status="no-budget";
    if(budget>0){
      if(spend>budget)status="over";
      else if(committed)status="committed";
      else if(!hasData)status="no-data";
      // ahead/behind/on-track (2026-08-01 fix, per Mo — Q3 selected, "Lease" and "Spreadsheet
      // Server" were both clearly trending over budget in the Projected column [116%/122% of
      // budget] but the Status pill said "On track") — this used to compare actualPct (spend so
      // far ÷ budget) against expectedPct (days elapsed ÷ total days), a PURELY LINEAR read that's
      // blind to both the forecast model and, in effect, the period shape: it assumes every day
      // spends the same amount. `projected` above already gets this right (it's projectPlatformSegment
      // reading each platform's actual recent run-rate under whichever forecastModel — auto,
      // trailing-N, full-period — applies to THIS segment, over the exact start/end this period
      // resolved to), so a segment that spent slowly early on and is now ramping hard shows an
      // accurate forward-looking overage there well before the linear actualPct/expectedPct delta
      // would ever notice. Status now reads off that same projected number instead of duplicating
      // a cruder version of the same math — "ahead"/"behind"/"on-track" describe where you're
      // headed by period end, not just where you happen to sit today. Same ±10%-of-budget band as
      // every other pace threshold in the app (see e.g. Dashboard's own paceDelta>0.1 check).
      else if(projected!=null){
        const projDelta=(projected-budget)/budget;
        if(projDelta>0.1)status="ahead";
        else if(projDelta<-0.1)status="behind";
        else status="on-track";
      }else{
        // No usable projection yet (period hasn't started, or elapsedDays is 0) — fall back to the
        // old linear delta rather than leaving status stuck on a stale/undefined read.
        const delta=(actualPct??0)-expectedPct;
        if(delta>0.1)status="ahead";
        else if(delta<-0.1)status="behind";
        else status="on-track";
      }
    }
    // See detectCapacitySignal's doc comment — only meaningful (non-null) when the segment is
    // actually behind pace with real budget headroom left; committed rows never get flagged since
    // they don't pace against a daily rate at all.
    const capacitySignal=committed?null:detectCapacitySignal(segDailyMap[sk],{expectedPct,actualPct,budget,spend});
    return{segKey:sk,dims,budget,spend,actualPct,dailyRate:hasData?dailyRate:null,projected,projectedVariance,status,matchCount:campaignCountMap[sk]||0,lowConfidencePlatforms,hasData,committed,forecastModel,capacitySignal};
  }).filter(s=>s.budget>0||s.spend>0).sort((a,b)=>b.spend-a.spend);

  const totals=segments.reduce((acc,s)=>({budget:acc.budget+s.budget,spend:acc.spend+s.spend}),{budget:0,spend:0});
  return{segments,totals,totalDays,elapsedDays,daysRemaining,expectedPct,start,end,platformFreshness};
}

// Steps a {periodType,year,month,quarter} tuple back exactly one period of that same granularity —
// e.g. monthly Jan'26 → Dec'25, quarterly Q1'26 → Q4'25, annual 2026 → 2025. Shared by the
// Dashboard's period-over-period comparison (one step back) and its trend chart (repeated stepping
// to build a trailing window) — both need the exact same "what's the previous period" logic, and
// getting the year-rollover cases right in two places would be an easy way to drift out of sync.
export function stepPeriodBack({periodType,year,month,quarter}){
  if(periodType==="monthly"){
    let y=parseInt(year,10),m=parseInt(month,10)-1;
    if(m<1){m=12;y-=1;}
    return{year:String(y),month:String(m).padStart(2,"0"),quarter:null};
  }
  if(periodType==="quarterly"){
    let y=parseInt(year,10),qn=parseInt(quarter.slice(1),10)-1;
    if(qn<1){qn=4;y-=1;}
    return{year:String(y),month:null,quarter:`Q${qn}`};
  }
  return{year:String(parseInt(year,10)-1),month:null,quarter:null};
}

// "View by" alternate to computePacing — groups spend by an arbitrary, user-chosen combination of
// dimensions (any tag dimension, plus the derived "Platform" pseudo-dimension) instead of the
// fixed budgetDims combo Budget Panel happens to be set up with. No Budget/Pacing/Status here —
// budgets in this app are only ever entered against a budgetDims combo, so there's nothing to
// compare an arbitrary grouping like "just Platform" against; this returns Spend/Daily Burn/
// Projected only, using the exact same per-platform freshness projection as computePacing.
export function computeCustomGrouping({mergedNormRows,tags,dims,year,periodType,month,quarter,today,combineGoogleChannels=false}){
  const{start,end}=getPeriodRange(periodType,year,month,quarter);
  const totalDays=Math.round((end-start)/86400000)+1;
  let elapsedDays;
  if(today<start)elapsedDays=0;
  else if(today>end)elapsedDays=totalDays;
  else elapsedDays=Math.floor((today-start)/86400000)+1;
  const daysRemaining=Math.max(0,totalDays-elapsedDays);
  const expectedPct=totalDays?elapsedDays/totalDays:0;
  const platformFreshness=computePlatformFreshness(mergedNormRows);
  const platformDowIndex=computePlatformDayOfWeekIndex(mergedNormRows);

  const spendMap={};
  const platformSpendMap={};
  const campaignSetMap={};
  if(dims.length){
    mergedNormRows.forEach(row=>{
      const d=parseSpendDate(row.date);
      if(!d||d<start||d>end)return;
      const ck=campaignKey(row.campaign_group_name,row.campaign_name);
      const rowTags=tags[ck]||{};
      const vals=dims.map(dim=>resolveDimValue(row,rowTags,dim,combineGoogleChannels));
      if(vals.some(v=>!v))return; // same convention as budget segments — every chosen dim must be present
      const sk=vals.join("|");
      spendMap[sk]=(spendMap[sk]||0)+row.spend;
      // See computePacing's identical comment — platformSpendMap intentionally stays keyed by the
      // real granular platform regardless of combineGoogleChannels.
      const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
      if(!platformSpendMap[sk])platformSpendMap[sk]={};
      if(!platformSpendMap[sk][platform])platformSpendMap[sk][platform]={total:0,byDate:{}};
      platformSpendMap[sk][platform].total+=row.spend;
      const dateKey=localISODate(d);
      platformSpendMap[sk][platform].byDate[dateKey]=(platformSpendMap[sk][platform].byDate[dateKey]||0)+row.spend;
      if(!campaignSetMap[sk])campaignSetMap[sk]=new Set();
      campaignSetMap[sk].add(ck);
    });
  }

  const segments=Object.keys(spendMap).map(sk=>{
    const spend=spendMap[sk];
    const{projectedSum,dailyRate,lowConfidencePlatforms}=projectPlatformSegment(platformSpendMap[sk],platformFreshness,{start,end,today,totalDays,platformDowIndex});
    const projected=elapsedDays>0?projectedSum:null;
    return{segKey:sk,dims:sk.split("|"),spend,dailyRate,projected,lowConfidencePlatforms,campaignCount:campaignSetMap[sk]?.size||0};
  }).sort((a,b)=>b.spend-a.spend);

  const totals=segments.reduce((acc,s)=>({spend:acc.spend+s.spend}),{spend:0});
  return{segments,totals,totalDays,elapsedDays,daysRemaining,expectedPct,start,end,platformFreshness,dims};
}

// Expand-row breakdown for computeCustomGrouping, mirroring computeSpendBreakdown but matching
// against an arbitrary dims array (via resolveDimValue) instead of the fixed budgetDims. Same
// Daily Burn/Projected addition (2026-08-01, per Mo) as computeSpendBreakdown above — no
// forecastModel param here since computeCustomGrouping never has one either (custom groupings
// aren't tied to a budget row, so there's nowhere for a per-row override to live; projectPlatformSegment
// falls back to Auto whenever forecastModel is undefined).
export function computeCustomBreakdown({mergedNormRows,tags,dims,segKey,breakdownDim,start,end,today,combineGoogleChannels=false}){
  const vals=segKey.split("|");
  const totalDays=Math.round((end-start)/86400000)+1;
  const platformFreshness=computePlatformFreshness(mergedNormRows);
  const platformDowIndex=computePlatformDayOfWeekIndex(mergedNormRows);
  const map={};
  const platformSpendMap={};
  mergedNormRows.forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d||d<start||d>end)return;
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    if(!dims.every((dim,i)=>resolveDimValue(row,rowTags,dim,combineGoogleChannels)===vals[i]))return;
    const bval=resolveDimValue(row,rowTags,breakdownDim,combineGoogleChannels)||"Untagged";
    map[bval]=(map[bval]||0)+row.spend;
    const platform=derivePlatform(row.campaign_group_name,row.campaign_name,row.platform,row.campaign_type);
    if(!platformSpendMap[bval])platformSpendMap[bval]={};
    if(!platformSpendMap[bval][platform])platformSpendMap[bval][platform]={total:0,byDate:{}};
    platformSpendMap[bval][platform].total+=row.spend;
    const dateKey=localISODate(d);
    platformSpendMap[bval][platform].byDate[dateKey]=(platformSpendMap[bval][platform].byDate[dateKey]||0)+row.spend;
  });
  const total=Object.values(map).reduce((s,v)=>s+v,0);
  const elapsedDays=today==null?0:today<start?0:today>end?totalDays:Math.floor((today-start)/86400000)+1;
  return Object.entries(map).map(([value,spend])=>{
    const{projectedSum,dailyRate,lowConfidencePlatforms}=projectPlatformSegment(platformSpendMap[value],platformFreshness,{start,end,today,totalDays,platformDowIndex});
    const projected=elapsedDays>0?projectedSum:null;
    return{value,spend,pct:total>0?spend/total:0,dailyRate,projected,lowConfidencePlatforms};
  }).sort((a,b)=>b.spend-a.spend);
}

// Powers Reporting & Pacing's "Trend" view — the one gap computePacing/computeCustomGrouping
// don't cover: both of those answer "how much for ONE period", never "how did this change over
// several months." Buckets spend into calendar months across [start,end], optionally narrowed to
// rows whose `filterDim` value contains `filterValue` (a plain substring match, same convention
// as every other filter input in this table — e.g. filterDim="Tag: Segment", filterValue="ISW
// Branded Search"), then splits each month's total into a series per `seriesDim` value (typically
// "Platform", to get one line per channel). seriesDim is optional — pass "" to get one combined
// "Spend" series with no split.
// Trend grain helpers (2026-07-30, per Mo — "since we're largely synced with the ad channels" he
// wanted Day/Week grain alongside the original Month/Quarter/Year, not just month buckets).
// trendBucketKey assigns any date to its bucket under a given grain; trendBucketLabel renders that
// bucket's key for display. Both are pure functions of (grain, date) so the row-assignment loop
// and the budget-proration loop in computeSpendTrend below always agree on identical bucket
// boundaries — two independently-drifting bucketing rules would be very easy to get subtly wrong.
function trendBucketKey(grain,d){
  const y=d.getFullYear(),m=d.getMonth()+1;
  if(grain==="day")return localISODate(d);
  if(grain==="week"){
    // Monday-start week, same convention as ReportingHQ's normalizePeriodStart used for
    // reporting_facts — one "week" definition across the whole app.
    const dow=d.getDay(); // 0=Sun..6=Sat
    const back=dow===0?6:dow-1;
    return localISODate(new Date(d.getFullYear(),d.getMonth(),d.getDate()-back));
  }
  if(grain==="quarter")return `${y}-Q${Math.floor((m-1)/3)+1}`;
  if(grain==="year")return `${y}`;
  return `${y}-${String(m).padStart(2,"0")}`; // month (default)
}
function trendBucketLabel(grain,key){
  if(grain==="day")return new Date(key+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"});
  if(grain==="week")return `Wk of ${new Date(key+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"})}`;
  if(grain==="quarter"){const[y,q]=key.split("-");return `${q} ${y}`;}
  if(grain==="year")return key;
  const[y,m]=key.split("-");
  return new Date(Number(y),Number(m)-1,1).toLocaleDateString("en-US",{month:"short",year:"2-digit"});
}
// Walks one calendar day at a time from start to end (cheap even at 24 months' worth of days —
// a few hundred iterations) collecting each day's bucket the first time it's seen, so bucket order
// always matches chronological order regardless of grain.
function buildTrendPeriods(grain,start,end){
  const periods=[];
  const seen=new Set();
  let cur=new Date(start.getFullYear(),start.getMonth(),start.getDate());
  const last=new Date(end.getFullYear(),end.getMonth(),end.getDate());
  while(cur<=last){
    const key=trendBucketKey(grain,cur);
    if(!seen.has(key)){seen.add(key);periods.push({key,label:trendBucketLabel(grain,key)});}
    cur=new Date(cur.getFullYear(),cur.getMonth(),cur.getDate()+1);
  }
  return periods;
}

// grain: "day"|"week"|"month"(default)|"quarter"|"year". budgets/budgetDims are optional — pass
// both to get a budgetValues series alongside spend; omit either to get spend-only (budgetValues
// comes back null), same as the old computeMonthlyTrend this replaces.
//
// Budget only genuinely exists at MONTHLY grain (see computePacing's yearBudgets[sk].monthly) —
// there's no such thing as a real stored daily or weekly budget number. At month/quarter/year
// grain the budget series below is exact (the real stored monthly figures, summed). At day/week
// grain it's PRORATED — each month's budget divided evenly across its calendar days — a reasonable
// pace reference, but deliberately not held out as real day-level budget data.
//
// Budget figures can only be restricted by trendFilterDim/trendFilterValue when that filter
// dimension is actually one of this workspace's budgetDims (budget segments aren't keyed by every
// possible campaign dimension, only by whichever ones make up a budget row) — filtering by
// something else (e.g. a tag dimension that isn't part of the budget structure) falls back to an
// unfiltered total budget, flagged via the returned budgetFilterNote so the UI can say so instead
// of silently showing a number that doesn't match the spend filter.
//
// SPEND PRORATION at day/week grain (2026-07-30, per Mo): a row flagged is_monthly (see
// core.spend_rows' doc comment) holds a WHOLE MONTH's total dated to the 1st of that month — with
// no spreading, it showed up as a single spike on one day/week and zero everywhere else in that
// month, a misleading sawtooth rather than a trend. Below, any is_monthly row is spread evenly
// across every real calendar day of its month for DISPLAY here only (the stored row itself is
// untouched, and this has no effect at month/quarter/year grain, where the row's real total already
// lands in the correct single bucket with no approximation needed). Same "prorate, but be honest
// about it" approach already used for budgetValues just below — surfaced via the returned
// spendProrationNote so the UI can label the day/week chart as approximate for affected platforms
// instead of presenting it as real per-day data. Forcing users to always have real daily-grain
// source data isn't realistic (many manual exports and dashboard screenshots are monthly rollups by
// nature, not by choice), so this is the trade-off: an honestly-labeled approximation instead of
// either a misleading spike or refusing to show a trend at all.
export function computeSpendTrend({mergedNormRows,tags,filterDim,filterValue,seriesDim,start,end,grain="month",budgets,budgetDims,combineGoogleChannels=false}){
  const periods=buildTrendPeriods(grain,start,end);
  const periodIndex=Object.fromEntries(periods.map((p,i)=>[p.key,i]));
  const seriesMap={};
  const fv=(filterValue||"").trim().toLowerCase();
  const prorateMonthly=grain==="day"||grain==="week";
  let hasProratedRows=false;
  (mergedNormRows||[]).forEach(row=>{
    const d=parseSpendDate(row.date);
    if(!d)return;
    const rowTags=tags[campaignKey(row.campaign_group_name,row.campaign_name)]||{};
    if(filterDim&&fv){
      const val=(resolveDimValue(row,rowTags,filterDim,combineGoogleChannels)||"").toLowerCase();
      if(!val.includes(fv))return;
    }
    const bval=seriesDim?(resolveDimValue(row,rowTags,seriesDim,combineGoogleChannels)||"Untagged"):"Spend";
    if(!seriesMap[bval])seriesMap[bval]=new Array(periods.length).fill(0);
    if(prorateMonthly&&row.is_monthly){
      // Spread across the month's real days rather than gating on the row's OWN date being inside
      // [start,end] (a monthly row dated to the 1st can still have days later in its month fall
      // inside a window that starts mid-month) — each individual day is checked against the range
      // instead.
      const y=d.getFullYear(),m=d.getMonth();
      const daysInMonth=new Date(y,m+1,0).getDate();
      const perDay=(row.spend||0)/daysInMonth;
      let touchedAny=false;
      for(let day=1;day<=daysInMonth;day++){
        const dd=new Date(y,m,day);
        if(dd<start||dd>end)continue;
        const pi=periodIndex[trendBucketKey(grain,dd)];
        if(pi==null)continue;
        seriesMap[bval][pi]+=perDay;
        touchedAny=true;
      }
      if(touchedAny)hasProratedRows=true;
    }else{
      if(d<start||d>end)return;
      const pi=periodIndex[trendBucketKey(grain,d)];
      if(pi==null)return; // outside the selected range
      seriesMap[bval][pi]+=row.spend||0;
    }
  });
  const series=Object.entries(seriesMap)
    .map(([label,values])=>({label,values,total:values.reduce((s,v)=>s+v,0)}))
    .sort((a,b)=>b.total-a.total);
  const periodTotals=periods.map((_,i)=>series.reduce((s,ser)=>s+ser.values[i],0));
  const spendProrationNote=hasProratedRows
    ?"Some platforms here only report monthly totals, not real per-day numbers. At Day/Week grain, those are spread evenly across each month's real days for this chart — an approximation, not real daily data."
    :null;

  let budgetValues=null;
  let budgetFilterNote=null;
  if(budgetDims?.length&&budgets){
    const filterIdx=filterDim?budgetDims.indexOf(filterDim):-1;
    if(filterDim&&fv&&filterIdx===-1){
      budgetFilterNote=`Budget shown unfiltered — "${filterDim}" isn't one of this workspace's budget dimensions (${budgetDims.join(", ")}).`;
    }
    const matchesFilter=sk=>{
      if(!filterDim||!fv||filterIdx===-1)return true;
      const dims=sk.split("|");
      return(dims[filterIdx]||"").toLowerCase().includes(fv);
    };
    // Real monthly budget total (summed across every matching segKey) for each (year,month)
    // touched by the range — same monthly[monthKey] shape computePacing reads.
    const monthBudgetTotal={};
    for(let y=start.getFullYear();y<=end.getFullYear();y++){
      Object.entries(budgets[y]||{}).forEach(([sk,seg])=>{
        if(!matchesFilter(sk))return;
        Object.entries(seg?.monthly||{}).forEach(([mk,amt])=>{
          const k=`${y}-${mk}`;
          monthBudgetTotal[k]=(monthBudgetTotal[k]||0)+(amt||0);
        });
      });
    }
    budgetValues=new Array(periods.length).fill(0);
    if(grain==="day"||grain==="week"){
      let cur=new Date(start.getFullYear(),start.getMonth(),start.getDate());
      const last=new Date(end.getFullYear(),end.getMonth(),end.getDate());
      while(cur<=last){
        const y=cur.getFullYear(),m=cur.getMonth()+1;
        const monthTotal=monthBudgetTotal[`${y}-${String(m).padStart(2,"0")}`]||0;
        const daysInMonth=new Date(y,m,0).getDate();
        const pi=periodIndex[trendBucketKey(grain,cur)];
        if(pi!=null)budgetValues[pi]+=monthTotal/daysInMonth;
        cur=new Date(cur.getFullYear(),cur.getMonth(),cur.getDate()+1);
      }
    }else{
      // month/quarter/year — exact, no proration: each period's own key tells us which month(s)
      // it spans.
      periods.forEach((p,i)=>{
        if(grain==="month"){
          budgetValues[i]=monthBudgetTotal[p.key]||0;
        }else if(grain==="quarter"){
          const[y,q]=p.key.split("-Q");
          const qi=Number(q);
          budgetValues[i]=[qi*3-2,qi*3-1,qi*3]
            .map(mn=>String(mn).padStart(2,"0"))
            .reduce((s,mk)=>s+(monthBudgetTotal[`${y}-${mk}`]||0),0);
        }else if(grain==="year"){
          budgetValues[i]=Object.entries(monthBudgetTotal).filter(([k])=>k.startsWith(`${p.key}-`)).reduce((s,[,v])=>s+v,0);
        }
      });
    }
  }

  return{periods,series,periodTotals,budgetValues,budgetFilterNote,spendProrationNote,grandTotal:periodTotals.reduce((s,v)=>s+v,0)};
}

export function pacingStatusMeta(status,T){
  switch(status){
    case"over":return{label:"Over budget",color:T.danger,bg:T.dangerBg,border:T.dangerBorder};
    case"ahead":return{label:"Ahead of pace",color:T.warning,bg:T.warningBg,border:T.warningBorder};
    case"behind":return{label:"Behind pace",color:T.accent,bg:T.accentBg,border:T.accentBorder};
    case"on-track":return{label:"On track",color:T.success,bg:T.successBg,border:T.successBorder};
    // Committed (lump-sum/prepaid) budget lines are deliberately excluded from pace comparisons —
    // see computePacing's `committed` handling — so this reads as a neutral "known, accounted for"
    // state rather than a pace verdict, distinct from both the warning colors above and the flatter
    // "no-data"/"no-budget" gray below (this segment DOES have a budget and a real reason not to
    // pace it, not an absence of information).
    case"committed":return{label:"Committed spend",color:T.textSub,bg:T.surfaceEl,border:T.border};
    // Distinct from "behind" on purpose — zero spend rows matched for this segment/period isn't the
    // same signal as "we have real spend data and it's genuinely trailing plan." Blending the two
    // made every never-synced segment look like an active problem (see 2026-07-19 UX review).
    case"no-data":return{label:"No data yet",color:T.textMuted,bg:T.surfaceEl,border:T.border};
    default:return{label:"No budget set",color:T.textMuted,bg:T.surfaceEl,border:T.border};
  }
}

// ─── DATA AUDIT (2026-07-31, per Mo) ───────────────────────────────────────────────────────────
// "I need a new tab where I can review in detail what data has been brought into PaidHQ and from
// where... gaps in dates... overlap... conflicts... whether manual or synced." Scoped to spend/
// dates only for now — channel-specific metrics beyond spend, PowerBI, and CRM data are explicitly
// future work per Mo, not part of this function.
//
// IMPORTANT LIMITATION, worth understanding up front because it shapes what this can honestly
// report: mergeRows() (see its own doc comment above) is last-write-wins, keyed by campaign +
// calendar day — the moment two sources both have a row for the same campaign on the same day,
// only the most-recently-merged one survives in mergedNormRows. That means by the time this
// function runs, there is no way to detect a VALUE disagreement between two sources for a day that
// already got merged — the losing value isn't stored anywhere anymore. (detectSpendConflicts, run
// at CSV/screenshot import review time, is the only place that can still see both sides — but only
// in the moment, before the merge commits, which is also why it isn't reused here.)
//
// What CAN be honestly reconstructed after the fact is RANGE overlap: which sources, for a given
// platform, claim date ranges that intersect. That doesn't prove the numbers ever disagreed, but it
// does say exactly where a silent last-write-wins resolution COULD have happened — worth knowing
// even without the specific numbers behind it. See byPlatform[].overlapRanges below.
export function computeDataAudit({mergedNormRows,combineGoogleChannels=false}){
  const rows=mergedNormRows||[];
  const dayKey=d=>d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`:null;

  const bySourceMap={};
  const byPlatformMap={};
  let totalSpend=0,earliest=null,latest=null,unparseableDates=0;
  const allCampaigns=new Set();

  rows.forEach(r=>{
    const d=parseSpendDate(r.date);
    const dk=dayKey(d);
    // A row whose date can't be placed on a calendar at all can't participate in range/gap/overlap
    // math — counted separately (unparseableDates) rather than silently dropped, so a workspace
    // with a lot of these has a visible signal that something upstream is producing bad dates,
    // instead of those rows just quietly vanishing from every stat below.
    if(!dk){unparseableDates++;return;}
    const sourceKey=r.source||"manual";
    const platform=groupGooglePlatform(derivePlatform(r.campaign_group_name,r.campaign_name,r.platform,r.campaign_type),combineGoogleChannels);
    const spend=r.spend||0;
    const campKey=campaignKey(r.campaign_group_name,r.campaign_name);

    totalSpend+=spend;
    if(!earliest||dk<earliest)earliest=dk;
    if(!latest||dk>latest)latest=dk;
    allCampaigns.add(campKey);

    if(!bySourceMap[sourceKey])bySourceMap[sourceKey]={sourceKey,rows:0,spend:0,start:dk,end:dk,campaigns:new Set(),platforms:new Set()};
    const sAgg=bySourceMap[sourceKey];
    sAgg.rows++;sAgg.spend+=spend;sAgg.campaigns.add(campKey);sAgg.platforms.add(platform);
    if(dk<sAgg.start)sAgg.start=dk;
    if(dk>sAgg.end)sAgg.end=dk;

    if(!byPlatformMap[platform])byPlatformMap[platform]={platform,rows:0,spend:0,start:dk,end:dk,campaigns:new Set(),days:new Set(),sources:{}};
    const pAgg=byPlatformMap[platform];
    pAgg.rows++;pAgg.spend+=spend;pAgg.campaigns.add(campKey);pAgg.days.add(dk);
    if(dk<pAgg.start)pAgg.start=dk;
    if(dk>pAgg.end)pAgg.end=dk;
    if(!pAgg.sources[sourceKey])pAgg.sources[sourceKey]={sourceKey,rows:0,spend:0,start:dk,end:dk};
    const psAgg=pAgg.sources[sourceKey];
    psAgg.rows++;psAgg.spend+=spend;
    if(dk<psAgg.start)psAgg.start=dk;
    if(dk>psAgg.end)psAgg.end=dk;
  });

  // Walks a [start,end] calendar span (inclusive) day by day and collapses consecutive days NOT in
  // presentSet into ranges — e.g. missing Mar 5/6/7 becomes one {start:"...-03-05",end:"...-03-07",
  // days:3} entry instead of three separate ones. "T00:00:00" (no Z) keeps every date parsed/
  // compared in local time throughout, matching dayKey's own local getFullYear/Month/Date — mixing
  // local and UTC here would risk an off-by-one at the range's edges.
  const collapseMissing=(start,end,presentSet)=>{
    if(!start||!end)return[];
    const ranges=[];
    let cur=null;
    const d=new Date(`${start}T00:00:00`);
    const endD=new Date(`${end}T00:00:00`);
    while(d<=endD){
      const k=dayKey(d);
      if(!presentSet.has(k)){
        if(cur){cur.end=k;cur.days++;}
        else cur={start:k,end:k,days:1};
      }else if(cur){
        ranges.push(cur);cur=null;
      }
      d.setDate(d.getDate()+1);
    }
    if(cur)ranges.push(cur);
    return ranges;
  };

  const bySource=Object.values(bySourceMap).map(s=>({
    sourceKey:s.sourceKey,rows:s.rows,spend:s.spend,start:s.start,end:s.end,
    campaigns:s.campaigns.size,platforms:Array.from(s.platforms).sort(),
  })).sort((a,b)=>b.spend-a.spend);

  const byPlatform=Object.values(byPlatformMap).map(p=>{
    const sources=Object.values(p.sources).map(s=>({sourceKey:s.sourceKey,rows:s.rows,spend:s.spend,start:s.start,end:s.end}))
      .sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:0);
    const gapRanges=collapseMissing(p.start,p.end,p.days);
    const gapDayCount=gapRanges.reduce((s,r)=>s+r.days,0);
    // Pairwise range-overlap across this platform's contributing sources — see this function's own
    // top-of-file doc comment for exactly what an entry here can and can't prove. O(n²) in source
    // count, which is fine since a single platform realistically has a handful of sources at most
    // (a connector or two, maybe a CSV backfill), never dozens.
    const overlapRanges=[];
    for(let i=0;i<sources.length;i++){
      for(let j=i+1;j<sources.length;j++){
        const a=sources[i],b=sources[j];
        const start=a.start>b.start?a.start:b.start;
        const end=a.end<b.end?a.end:b.end;
        if(start<=end){
          const days=Math.round((new Date(`${end}T00:00:00`)-new Date(`${start}T00:00:00`))/86400000)+1;
          overlapRanges.push({sourceA:a.sourceKey,sourceB:b.sourceKey,start,end,days});
        }
      }
    }
    return{
      platform:p.platform,rows:p.rows,spend:p.spend,start:p.start,end:p.end,campaigns:p.campaigns.size,
      sources,gapRanges,gapDayCount,overlapRanges,
    };
  }).sort((a,b)=>b.spend-a.spend);

  return{
    overview:{
      totalRows:rows.length,totalSpend,earliest,latest,unparseableDates,
      sourceCount:bySource.length,platformCount:byPlatform.length,campaignCount:allCampaigns.size,
    },
    bySource,byPlatform,
  };
}

// ─── REPORTING AUDIT (2026-08-01, per Mo — "let's add the powerBI data to it") ─────────────────
// Same spirit as computeDataAudit above, but for core.reporting_facts (Dreamdata/PowerBI funnel/
// pipeline data, imported via the Reporting Analyzer tab) instead of spend_rows — a SEPARATE
// function rather than folded into computeDataAudit, because the two tables don't share a shape:
//   - reporting_facts mixes MULTIPLE period grains (day/week/month/quarter/year) for the same
//     workspace, rather than being uniformly daily like spend_rows — so gaps are walked in units of
//     each grain's own period (via stepPeriodStart), bucketed by periodType instead of by platform
//     (there's no ad-platform dimension on funnel data).
//   - There's no overlapRanges here the way computeDataAudit has for spend, and that's not an
//     oversight: reporting_facts can't go stale via a silent last-write-wins merge the way spend
//     can. Its dedup key (workspace_id, period_type, period_start, campaign_name, tags) plus its
//     upsert-merge write path (see reporting-facts.js's POST doc comment — metrics are merged with
//     jsonb `||`, not replaced wholesale) means two imports for the same period+campaign+tags
//     combine their metrics rather than one silently overwriting the other. There's structurally
//     nothing for an overlap check to catch.
//   - What IS worth surfacing instead: tag completeness. tags is this data's only way of attaching a
//     row to a Product/Region/Funnel/etc. segment, and an incomplete tag isn't a date problem, but
//     it's exactly the kind of "do I actually understand this data" gap Mo's original ask (a tab to
//     fully understand what's been brought in) was about.
export function computeReportingAudit({reportingFacts,tagDims=[]}){
  const rows=reportingFacts||[];
  const bySourceMap={};
  const byPeriodTypeMap={};
  let earliest=null,latest=null,lastImportedAt=null;
  const allCampaigns=new Set();
  const tagMissingCounts={};
  tagDims.forEach(d=>{tagMissingCounts[d]=0;});

  rows.forEach(r=>{
    const pt=r.periodType;
    // Fixed 2026-08-17 (per Mo — Data Audit showed 30 of 31 months "missing" for a Bing/Google
    // import Mo confirmed was done correctly): period_start comes back from the API as whatever the
    // Postgres driver serializes a `date` column to, which can be a full ISO timestamp like
    // "2024-02-01T00:00:00.000Z" rather than a bare "YYYY-MM-DD" — using that raw value as this
    // grain's "present periods" Set key, while collapseMissingPeriods below walks the span with
    // stepPeriodStart (which always returns a BARE date), meant almost every real period silently
    // failed the presentSet.has(k) check below and got misreported as missing — only the very first
    // period (started from p.start, itself raw) ever happened to match. Same root cause (and same
    // fix) as the Q1-2001 grain-rollup bug and the "Invalid Date" display bug fixed earlier this
    // session — normalize once via normalizePeriodStart right where periodStart enters this
    // function, so every Set/comparison below is built from a consistent bare-date string.
    const ps=normalizePeriodStart(pt,r.periodStart)||r.periodStart;
    // Every row that's actually made it through the Reporting Analyzer's import review has both
    // (the review step requires a resolved period before Import is even clickable) — this guard is
    // just so one somehow-malformed row can't throw off every stat below.
    if(!ps||!pt)return;
    const sourceKey=r.source||"manual";
    const campKey=r.campaignName||"(none)";

    if(!earliest||ps<earliest)earliest=ps;
    if(!latest||ps>latest)latest=ps;
    if(r.importedAt&&(!lastImportedAt||r.importedAt>lastImportedAt))lastImportedAt=r.importedAt;
    allCampaigns.add(campKey);

    tagDims.forEach(d=>{if(!r.tags||!r.tags[d])tagMissingCounts[d]++;});

    if(!bySourceMap[sourceKey])bySourceMap[sourceKey]={sourceKey,rows:0,campaigns:new Set(),start:ps,end:ps};
    const sAgg=bySourceMap[sourceKey];
    sAgg.rows++;sAgg.campaigns.add(campKey);
    if(ps<sAgg.start)sAgg.start=ps;
    if(ps>sAgg.end)sAgg.end=ps;

    if(!byPeriodTypeMap[pt])byPeriodTypeMap[pt]={periodType:pt,rows:0,campaigns:new Set(),start:ps,end:ps,periods:new Set()};
    const pAgg=byPeriodTypeMap[pt];
    pAgg.rows++;pAgg.campaigns.add(campKey);pAgg.periods.add(ps);
    if(ps<pAgg.start)pAgg.start=ps;
    if(ps>pAgg.end)pAgg.end=ps;
  });

  // Walks a period grain's own span one PERIOD at a time (stepPeriodStart, not calendar days) and
  // collapses consecutive missing periods into ranges — same collapsing idea as computeDataAudit's
  // collapseMissing above, just moving in units of that grain instead of always one day. Guarded at
  // 20,000 steps (covers a multi-decade DAILY span with wide margin, the slowest-moving grain here)
  // so a future bug in stepPeriodStart can't spin this into an infinite loop.
  const collapseMissingPeriods=(periodType,start,end,presentSet)=>{
    if(!start||!end)return[];
    const ranges=[];
    let cur=null,k=start,guard=0;
    while(k&&k<=end&&guard<20000){
      guard++;
      if(!presentSet.has(k)){
        if(cur){cur.end=k;cur.periods++;}
        else cur={start:k,end:k,periods:1};
      }else if(cur){
        ranges.push(cur);cur=null;
      }
      k=stepPeriodStart(periodType,k);
    }
    if(cur)ranges.push(cur);
    return ranges;
  };

  const bySource=Object.values(bySourceMap).map(s=>({
    sourceKey:s.sourceKey,rows:s.rows,campaigns:s.campaigns.size,start:s.start,end:s.end,
  })).sort((a,b)=>b.rows-a.rows);

  const byPeriodType=Object.values(byPeriodTypeMap).map(p=>{
    const gapRanges=collapseMissingPeriods(p.periodType,p.start,p.end,p.periods);
    const gapPeriodCount=gapRanges.reduce((s,r)=>s+r.periods,0);
    return{
      periodType:p.periodType,rows:p.rows,campaigns:p.campaigns.size,start:p.start,end:p.end,
      gapRanges,gapPeriodCount,
    };
  }).sort((a,b)=>b.rows-a.rows);

  const tagCompleteness=tagDims.map(d=>({
    dimension:d,
    missing:tagMissingCounts[d]||0,
    missingPct:rows.length?Math.round(((tagMissingCounts[d]||0)/rows.length)*100):0,
  }));

  // DUPLICATE-IMPORT DETECTION (2026-08-17, per Mo — "I just added all Bing PowerBI pipeline
  // reports from Jan 2024 to July 2026. I'd like a way to audit the data to make sure I didn't
  // import the same report twice or other potential mistakes"). core.reporting_facts' own unique
  // key is (workspace_id, period_type, period_start, campaign_name, tags) — see
  // api/workspaces/[id]/reporting-facts.js's POST doc comment — so re-importing the EXACT same
  // campaign_name for a period-that-already-exists safely MERGES into the same row rather than
  // creating a literal duplicate. The two ways a duplicate import actually slips through instead:
  //
  //   1. POSSIBLE DUPLICATES — the re-import (or a second file covering overlapping months) used a
  //      campaign_name string that differs only in whitespace/case from one already stored for the
  //      exact same period+grain (a trailing space, a capitalization difference in a PowerBI
  //      re-export, etc.) — that's enough to dodge the unique key and land as a SECOND row, silently
  //      double-counting that period's totals every time they're summed. Detected by grouping rows
  //      within the same (periodType, periodStart) by a normalized (trim+lowercase+collapsed-
  //      whitespace) campaign name and flagging any group backed by more than one distinct RAW name.
  //   2. MIXED-GRAIN OVERLAP — the same campaign has rows at two different period grains (e.g. a
  //      monthly row for March 2024 AND a quarterly row for Q1 2024) whose calendar spans intersect.
  //      Each grain's own row is legitimate on its own, but Reporting Intelligence's "All" grain view
  //      (see PipelineTagger.jsx) sums every row regardless of periodType, so this combination
  //      double- (or triple-) counts that overlapping stretch — the Qtr/Yr grain-rollup logic added
  //      earlier only DEDUPES this correctly once a specific grain is selected, "All" has no such
  //      guard. Detected by converting every row's periodStart to a [start,end) calendar range (via
  //      stepPeriodStart) and checking, per normalized campaign name, every pair of rows on
  //      DIFFERENT grains for range intersection. Same-grain overlap can't happen (the unique key
  //      already prevents two rows for one campaign at one exact period+grain).
  //
  // Both are O(rows) / O(rows-per-campaign²) respectively — reporting_facts is one row per
  // campaign per PERIOD (not per day), so even a multi-year, many-campaign workspace stays small
  // enough for the per-campaign pairwise check to be cheap.
  // Both blocks below normalize periodStart the same way the main loop above now does (see that
  // loop's 2026-08-17 doc comment) — mixing a raw (possibly full-timestamp) periodStart against a
  // bare-date value from stepPeriodStart in the same string comparison is exactly the fragile
  // pattern that caused the gap-detection bug, so this normalizes once up front rather than risk
  // the same class of mistake in the overlap range check below.
  const normCampaign=name=>(name||"").trim().toLowerCase().replace(/\s+/g," ");
  const normRow=r=>({...r,periodStart:normalizePeriodStart(r.periodType,r.periodStart)||r.periodStart});
  const dupGroups={};
  rows.forEach(raw=>{
    if(!raw.periodStart||!raw.periodType)return;
    const r=normRow(raw);
    const key=`${r.periodType}|${r.periodStart}|${normCampaign(r.campaignName)}`;
    if(!dupGroups[key])dupGroups[key]={periodType:r.periodType,periodStart:r.periodStart,names:new Map()};
    const g=dupGroups[key];
    const name=r.campaignName||"(none)";
    if(!g.names.has(name))g.names.set(name,{campaignName:name,rows:0});
    g.names.get(name).rows++;
  });
  const possibleDuplicates=Object.values(dupGroups)
    .filter(g=>g.names.size>1)
    .map(g=>({periodType:g.periodType,periodStart:g.periodStart,variants:Array.from(g.names.values()).sort((a,b)=>b.rows-a.rows)}))
    .sort((a,b)=>(a.periodStart<b.periodStart?-1:a.periodStart>b.periodStart?1:0));

  const byCampaignForOverlap={};
  rows.forEach(raw=>{
    if(!raw.periodStart||!raw.periodType)return;
    const r=normRow(raw);
    const norm=normCampaign(r.campaignName)||"(none)";
    if(!byCampaignForOverlap[norm])byCampaignForOverlap[norm]=[];
    byCampaignForOverlap[norm].push(r);
  });
  const mixedGrainOverlaps=[];
  Object.values(byCampaignForOverlap).forEach(campRows=>{
    if(new Set(campRows.map(r=>r.periodType)).size<2)return; // single grain — nothing to cross-check
    const ranged=campRows
      .map(r=>({periodType:r.periodType,periodStart:r.periodStart,campaignName:r.campaignName,rangeEnd:stepPeriodStart(r.periodType,r.periodStart)}))
      .filter(r=>r.rangeEnd);
    for(let i=0;i<ranged.length;i++){
      for(let j=i+1;j<ranged.length;j++){
        const a=ranged[i],b=ranged[j];
        if(a.periodType===b.periodType)continue; // same-grain dupes can't exist — see doc comment above
        if(a.periodStart<b.rangeEnd&&b.periodStart<a.rangeEnd){
          mixedGrainOverlaps.push({
            campaignName:a.campaignName||b.campaignName||"(none)",
            a:{periodType:a.periodType,periodStart:a.periodStart},
            b:{periodType:b.periodType,periodStart:b.periodStart},
          });
        }
      }
    }
  });

  return{
    overview:{
      totalRows:rows.length,sourceCount:bySource.length,periodTypeCount:byPeriodType.length,
      campaignCount:allCampaigns.size,earliest,latest,lastImportedAt,
    },
    bySource,byPeriodType,tagCompleteness,possibleDuplicates,mixedGrainOverlaps,
  };
}

export const fmtSigned=n=>n==null?"—":(n>0?"+":n<0?"−":"")+"$"+Math.round(Math.abs(n)).toLocaleString();
