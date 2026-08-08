// src/components/ui/button.jsx — standard shadcn/ui Button recipe (Radix Slot + class-variance-
// authority), hand-authored rather than pulled via the shadcn CLI (2026-08-06) — this sandbox can't
// drive the CLI's interactive prompts, and the recipe itself is the well-documented public shadcn/
// ui pattern (MIT), not proprietary code.
import { forwardRef } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  // active:scale + transition-transform added 2026-08-06 (per Mo's "world class... dynamic with
  // dynamic elements" ask) — a small press-down on click reads as tactile/responsive instead of
  // static; kept tiny (2%) so it doesn't feel gimmicky.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline: "border border-input bg-background shadow-sm hover:bg-secondary hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-secondary hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export const Button = forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = "Button";

// See badge.jsx's identical comment on this same disable — buttonVariants is exported so callers
// (e.g. an <a> styled like a button) can compose the same classes without rendering a real <Button>.
// eslint-disable-next-line react-refresh/only-export-components
export { buttonVariants };
