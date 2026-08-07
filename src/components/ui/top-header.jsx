// src/components/ui/top-header.jsx — new primitive (2026-08-07, Venture CRM retheme). Matches
// Venture's Navigation > Header / Top Header frame exactly (get_design_context, node 335:86648):
// h-[72px], bg-background, border-b border-border, px-8 justify-between. Left slot: a search input
// styled like Venture's own Search Bar instance (border-input, rounded-sm, MagnifyingGlass icon,
// trailing ⌘-shortcut hint chips — kept as a decorative default that consumers can override via
// the searchShortcut prop, since the exact key varies by page). Right slot: gap-8, a "Help Center"-
// style nav-item button, and a profile cluster (avatar, name, CaretDown).
//
// This is a REUSABLE PRIMITIVE only — see nav-item.jsx's sibling comment on why it isn't wired into
// PaidHQ.jsx's actual app shell yet.
import { MagnifyingGlass, Question, CaretDown } from "@phosphor-icons/react";
import { Avatar, AvatarImage, AvatarFallback } from "./avatar.jsx";
import { cn } from "../../lib/utils.js";

export function TopHeader({
  className,
  searchPlaceholder = "Search",
  searchShortcut = null,
  onSearchClick,
  userName,
  userImageSrc,
  onHelpClick,
  onProfileClick,
  rightSlot,
}) {
  return (
    <header className={cn("flex h-[72px] w-full items-center justify-between border-b border-border bg-background px-8", className)}>
      <button
        type="button"
        onClick={onSearchClick}
        className="flex w-[360px] items-center justify-between rounded-sm border border-input px-3 py-2.5 text-left"
      >
        <span className="flex items-center gap-3">
          <MagnifyingGlass className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{searchPlaceholder}</span>
        </span>
        {searchShortcut && (
          <span className="flex items-center gap-2">
            {searchShortcut.split("").map((key, i) => (
              <span key={i} className="flex h-5 w-5 items-center justify-center rounded-[2px] bg-muted text-xs font-medium text-muted-foreground">
                {key}
              </span>
            ))}
          </span>
        )}
      </button>
      <div className="flex items-center gap-8">
        {rightSlot}
        {onHelpClick && (
          <button type="button" onClick={onHelpClick} className="flex items-center gap-3 rounded-sm p-2 text-sm font-medium text-muted-foreground hover:bg-secondary/60">
            <Question className="h-5 w-5" />
            Help Center
          </button>
        )}
        {userName && (
          <button type="button" onClick={onProfileClick} className="flex items-center gap-3">
            <Avatar className="h-8 w-8">
              {userImageSrc && <AvatarImage src={userImageSrc} alt={userName} />}
              <AvatarFallback>{userName.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium text-foreground">{userName}</span>
            <CaretDown className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
      </div>
    </header>
  );
}
