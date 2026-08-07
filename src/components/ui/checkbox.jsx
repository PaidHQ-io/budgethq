// src/components/ui/checkbox.jsx — new primitive (2026-08-07, Venture CRM retheme, per Mo's "100%
// adoption" directive). Didn't exist in ui/ before this — pages built pre-rebuild used plain
// <input type="checkbox"> with inline T-theme styles. Wraps @radix-ui/react-checkbox (installed
// for this) for accessible keyboard/ARIA behavior, same pattern as select.jsx/tabs.jsx wrapping
// their own Radix primitives.
//
// Matches Venture's Small Components > Checkbox frame exactly (get_design_context on the Checked/
// Default symbol, node 67:8622): 20x20px box, rounded-4px (our flattened --radius, not a pill),
// checked state = solid Action/Primary/Base (black) fill with a white check glyph. Unchecked/
// indeterminate states weren't individually re-fetched (Figma rate limit was still recovering) —
// inferred from the same border convention Text Field uses (Interaction/Outline/Base, --input) and
// Venture's own visual consistency (every other unfilled control in this kit uses that border
// color), flagged here so it's easy to correct against the real symbols later if it's off.
import { forwardRef } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "@phosphor-icons/react";
import { cn } from "../../lib/utils.js";

export const Checkbox = forwardRef(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-5 w-5 shrink-0 rounded-sm border border-input bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:border-transparent data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      "data-[state=indeterminate]:border-transparent data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn("flex items-center justify-center text-current")}>
      {props.checked === "indeterminate" ? <Minus weight="bold" className="h-3.5 w-3.5" /> : <Check weight="bold" className="h-3.5 w-3.5" />}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
