// src/components/ui/select.jsx — Radix Select primitive, restyled 2026-08-07 for the Venture CRM
// retheme (per Mo's "100% adoption" directive, Selector explicitly named). Matches the kit's
// Selector > Combo Box frame (get_design_context on the Default symbol, node 67:2601: bg
// Interaction/Secondary/Base white, border Interaction/Outline/Base — our --input, px-12 py-10,
// gap-12, rounded-4px, Icon/CaretDown) for the trigger, and its Menu / Option > Menu Item frame
// (Default node 724:19162: bg white, px-12 py-6, 14px regular text; Hover node 724:19318: bg
// Interaction/Secondary/Hover #f2f2f2 — our --secondary) for each item. Swapped lucide-react's
// ChevronDown/ChevronUp/Check for the exact Phosphor equivalents (CaretDown/CaretUp/Check) — see
// badge.jsx's sibling comment on why Phosphor is the icon source for anything newly matched to
// this kit.
import { forwardRef } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, CaretDown, CaretUp } from "@phosphor-icons/react";
import { cn } from "../../lib/utils.js";

// Direct re-exports of Radix primitives — see tabs.jsx's identical comment on the same disable.
/* eslint-disable react-refresh/only-export-components */
export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;
/* eslint-enable react-refresh/only-export-components */

export const SelectTrigger = forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-10 w-full items-center justify-between gap-3 whitespace-nowrap rounded-sm border border-input bg-background px-3 py-2.5 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <CaretDown className="h-5 w-5 shrink-0 opacity-60" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton ref={ref} className={cn("flex cursor-default items-center justify-center py-1", className)} {...props}>
    <CaretUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton ref={ref} className={cn("flex cursor-default items-center justify-center py-1", className)} {...props}>
    <CaretDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

export const SelectContent = forwardRef(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      className={cn(
        "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-sm border border-border bg-background text-foreground shadow-card data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
        className
      )}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport className={cn("p-0", position === "popper" && "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]")}>
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

export const SelectLabel = forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Label ref={ref} className={cn("px-3 py-1.5 text-xs font-semibold text-muted-foreground", className)} {...props} />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

// SelectItem: matches Menu Item's exact anatomy — bg-background px-3 py-1.5 (Venture's px-12/py-6
// scaled to Tailwind's 4px units) text-sm, hover/focus -> bg-secondary (Interaction/Secondary/Hover
// #f2f2f2), selected check rendered inline at the trailing edge (Menu Item's own
// showSelected/Icon-Check slot sits after the label, not before it like stock shadcn) rather than
// as an absolutely-positioned leading icon.
export const SelectItem = forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center justify-between gap-2 px-3 py-1.5 text-sm text-foreground outline-none focus:bg-secondary data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="flex h-4 w-4 shrink-0 items-center justify-center">
      <Check weight="bold" className="h-4 w-4" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export const SelectSeparator = forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;
