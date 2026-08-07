// src/components/ui/avatar.jsx — new primitive (2026-08-07, Venture CRM retheme). Wraps
// @radix-ui/react-avatar (installed for this) for its built-in image-load-failure -> Fallback
// behavior, matching Venture's Small Components > Avatar frame's own "Pictures" vs "Placeholder"
// Type variants (get_design_context on the 40px/None/None/Pictures symbol, node 67:8766): a plain
// fully-round (rounded-full) image. AvatarFallback renders initials on a muted background for the
// Placeholder case, since Venture's own Placeholder symbols are icon-only glyphs this pass didn't
// fetch pixel-for-pixel — a text-initials fallback is the standard, accessible equivalent and is
// easy to swap for the exact glyph later.
import { forwardRef } from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "../../lib/utils.js";

export const Avatar = forwardRef(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root ref={ref} className={cn("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full", className)} {...props} />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

export const AvatarImage = forwardRef(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image ref={ref} className={cn("aspect-square h-full w-full object-cover", className)} {...props} />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

export const AvatarFallback = forwardRef(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn("flex h-full w-full items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground", className)}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;
