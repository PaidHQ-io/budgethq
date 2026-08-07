// src/components/ui/badge.jsx — Venture CRM retheme (2026-08-07, per Mo — "100% adoption" of the
// Venture CRM Figma kit). Rebuilt from the kit's Small Components > Badge frame (Contained type,
// confirmed via get_design_context on the Blue/Contained/Small symbol: bg Background/Blue tint,
// text Interaction/Blue/Base, px-6 py-4, gap-8, rounded-4px, Body/Small/Medium 12px text) rather
// than the previous shadcn-stock pill shape (rounded-full, bg-x/10 opacity tint, px-2.5 py-0.5).
// Kept the SAME variant names (default/secondary/destructive/success/warning/outline) rather than
// renaming to Venture's own color vocabulary (Blue/Green/Red/Orange/Purple/Yellow/Grey) — this
// component has ~20 existing call sites across AccountPlanning.jsx/CampaignAudit.jsx/
// searchable-select.jsx keying off these exact variant names (often via a status/tier lookup table
// like STATUS_META/TIER_META), and remapping the vocabulary would mean hunting down and editing
// every one of those call sites for zero visual difference. Only the CLASSES each variant resolves
// to changed, to Venture's actual anatomy and the real Background/X tint tokens (--destructive-bg
// etc. in index.css) instead of an opacity trick on the base color.
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center gap-2 rounded-sm border border-transparent px-1.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        // default: kept as a solid Action/Primary/Base (black) fill — used across the app as a
        // "selected" toggle-chip state (PickList/ChipList active items), not as one of Venture's 7
        // literal badge colors. Matches the same solid-black treatment Venture's own Primary button
        // uses for an affirmatively-selected/active state.
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive-bg text-destructive",
        success: "bg-success-bg text-success",
        warning: "bg-warning-bg text-warning",
        outline: "border-border bg-transparent text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// badgeVariants is exported alongside the Badge component itself so callers can compose the same
// variant classes onto a non-<Badge> element (standard shadcn pattern) — this trips react-refresh's
// "only export components" rule since it can't statically tell cva()'s return value isn't a
// component, but this file isn't a hot-editing target (a stable UI primitive, not app logic), so a
// slightly less granular Fast Refresh boundary here is a non-issue in practice.
// eslint-disable-next-line react-refresh/only-export-components
export { badgeVariants };
