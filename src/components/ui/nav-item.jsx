// src/components/ui/nav-item.jsx — new primitive (2026-08-07, Venture CRM retheme). Matches
// Venture's Navigation > Menu > Navigation/Sidebar/Menu frame exactly (get_design_context on
// Active=Yes/Dropdown=No, node 291:6715, and Active=No/Dropdown=No, node 291:6716): h-9, p-2,
// gap-3, rounded-sm, active = bg-secondary (Action/Secondary/Selected #f2f2f2) + black Medium text,
// inactive = transparent + Content/Dark/Secondary (#727272, our --muted-foreground) text. Optional
// trailing count badge (bg-muted pill) and trailing icon (dropdown-chevron use case) both present in
// the kit's own prop set.
//
// This is a REUSABLE PRIMITIVE only — it is not yet wired into PaidHQ.jsx's actual sidebar (that
// file's nav is still the pre-rebuild inline-style shell driving real view-switching/workspace-
// switcher logic; swapping the app's live root shell is its own migration task, tracked separately
// from building the matching visual primitive here).
import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

// collapsed (2026-08-07, per Mo) — icon-only rail mode: the button shrinks to a centered 36px
// square showing just the icon, and the native title tooltip surfaces the label (which is otherwise
// hidden). Backward compatible: default false keeps the full label+badge row.
export const NavItem = forwardRef(({ className, active = false, icon, badge, trailingIcon, collapsed = false, children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    title={collapsed && typeof children === "string" ? children : undefined}
    className={cn(
      "flex h-9 items-center rounded-sm text-sm font-medium transition-colors",
      collapsed ? "w-9 justify-center p-0" : "w-full justify-between gap-2 p-2 text-left",
      active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      className
    )}
    {...props}
  >
    {collapsed ? (
      icon && <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
    ) : (
      <>
        <span className="flex min-w-0 flex-1 items-center gap-3">
          {icon && <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>}
          <span className="truncate">{children}</span>
        </span>
        {badge != null && (
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-1 text-xs font-medium text-foreground">{badge}</span>
        )}
        {trailingIcon && <span className="flex h-4 w-4 shrink-0 items-center justify-center">{trailingIcon}</span>}
      </>
    )}
  </button>
));
NavItem.displayName = "NavItem";
