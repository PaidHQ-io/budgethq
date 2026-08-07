// src/components/ui/badge.jsx — standard shadcn/ui Badge recipe, extended with success/warning
// variants (2026-08-06) since Account Planning's tier/status pills need those semantic colors and
// stock shadcn only ships default/secondary/destructive/outline.
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive/10 text-destructive",
        success: "border-transparent bg-success/10 text-success",
        warning: "border-transparent bg-warning/10 text-warning",
        outline: "text-foreground",
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
