// src/components/ui/dialog.jsx — new primitive (2026-08-07, Venture CRM retheme). Didn't exist in
// ui/ before this — modal/overlay UI across the app is still ad-hoc per-page (fixed-position divs
// with inline styles). Wraps @radix-ui/react-dialog (installed for this) for focus-trap/ESC/
// overlay-click-to-close behavior, same pattern as every other Radix-backed primitive in this
// folder.
//
// Matches Venture's Modals > Task frame's "New Task (V2)" instance (get_design_context, node
// 755:80150) for the generic modal CHROME (this pass builds the reusable shell, not that specific
// task-creation form): bg-background, border border-border, rounded-[8px] — a deliberate exception
// to the flat 4px radius used everywhere else in this kit (same category of exception as the pill
// Toggle/Tag), confirmed directly on this component's own rendered CSS — and an unusual upward-
// facing drop shadow (0px -4px 18px rgba(150,150,150,0.16)) rather than a standard downward one.
// p-6 gap-6 (24px) between title row / separator / content / footer. Title row is flex-justify-
// between with an Icon/X close button (Phosphor's X here) rather than shadcn's stock absolutely-
// positioned corner X.
import { forwardRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";
import { cn } from "../../lib/utils.js";

/* eslint-disable react-refresh/only-export-components */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;
/* eslint-enable react-refresh/only-export-components */

export const DialogOverlay = forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-foreground/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = forwardRef(({ className, children, showClose = true, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-6 rounded-[8px] border border-border bg-background p-6 shadow-[0px_-4px_18px_rgba(150,150,150,0.16)] duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className
      )}
      {...props}
    >
      {children}
      {showClose && (
        <DialogPrimitive.Close className="absolute right-6 top-6 flex h-5 w-5 items-center justify-center text-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none">
          <X className="h-5 w-5" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

// DialogHeader: title row (justify-between, room for the close button) + the full-width Separator
// Venture places directly under it — kept as a real border rather than an <hr>, matching the kit's
// own Vector-based divider.
export function DialogHeader({ className, ...props }) {
  return <div className={cn("flex flex-col gap-6 border-b border-border pb-6 pr-6", className)} {...props} />;
}

export const DialogTitle = forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-medium text-foreground", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

// DialogFooter: Venture's own sampled instance shows a single full-width Primary button (single
// primary CTA, no Cancel), but that's this ONE instance's content, not the general footer anatomy —
// a Cancel/Confirm pair is the standard modal footer pattern and composes cleanly from the existing
// Button primitive (variant="ghost"/"outline" + variant="default"), so this stays a plain flex
// container rather than hardcoding a single-button layout.
export function DialogFooter({ className, ...props }) {
  return <div className={cn("flex items-center justify-end gap-3", className)} {...props} />;
}
