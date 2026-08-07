// src/components/ui/switch.jsx — new primitive (2026-08-07, Venture CRM retheme). Wraps
// @radix-ui/react-switch (installed for this), same pattern as checkbox.jsx.
//
// Matches Venture's Small Components > Toggle frame (get_design_context on the State=ON symbol,
// node 67:8674): pill shape (border-radius/100-px, a full rounded-full — this is genuinely a
// graduated-radius exception to the flat-4px system used everywhere else in the kit, confirmed
// directly on this component's rendered CSS), ON = solid Action/Primary/Base (black) fill with a
// 1px Interaction/Outline/Base border and a small check glyph on the thumb; OFF state wasn't
// re-fetched (rate limit) — inferred as the track using --secondary (light gray) with a plain white
// thumb, the standard toggle-off convention, flagged for correction if it doesn't match the real
// Default-state symbol.
import { forwardRef } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../../lib/utils.js";

export const Switch = forwardRef(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-input p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:border-transparent data-[state=checked]:bg-primary data-[state=unchecked]:bg-secondary",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform",
        "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;
