// src/components/ui/tag.jsx — new primitive (2026-08-07, Venture CRM retheme). Distinct from
// badge.jsx on purpose: Venture's Small Components frame has both a Badge (Contained/Outlined,
// rounded-4px, semantic-color-coded) AND a separate Tag component (pill-shaped, neutral gray,
// meant for user-entered/removable values like chips) with different anatomy — collapsing them
// into one component would lose that distinction.
//
// Matches the kit's Tag/Removable Tag frame (get_design_context on node 67:7768): pill
// (border-radius/100-px), bg Action/Secondary/Base 2 (#f2f2f2, our --secondary), gap-6, px-8 py-4,
// Body/Small/Medium (12px) text in Content/Dark/Primary (black), with an optional leading icon slot.
// The sampled instance's default trailing icon was a PushPin glyph — that reads as this specific
// style-guide example's content (a "pinned tag"), not the generic remove affordance implied by the
// symbol's own name ("Removable Tag") — so this component takes an `onRemove` handler and renders a
// Phosphor X icon for that case instead of copying the pin literally, which is the more faithful
// interpretation of the component's actual purpose. Flag if you'd rather match the pin exactly.
import { forwardRef } from "react";
import { X } from "@phosphor-icons/react";
import { cn } from "../../lib/utils.js";

export const Tag = forwardRef(({ className, icon, children, onRemove, removeLabel = "Remove", ...props }, ref) => (
  <div
    ref={ref}
    className={cn("inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground", className)}
    {...props}
  >
    {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
    <span className="[word-break:break-word]">{children}</span>
    {onRemove && (
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X weight="bold" className="h-3 w-3" />
      </button>
    )}
  </div>
));
Tag.displayName = "Tag";
