// src/components/ui/table.jsx — Venture CRM retheme, 2026-08-07 (per Mo's "100% adoption"
// directive, Table explicitly named). Matches the kit's Table > Base > Header cell
// (get_design_context, node 471:23930: p-3, 14px regular text in Content/Dark/Tertiary #afafaf —
// a lighter gray than --muted-foreground, which is Content/Dark/Secondary #727272; no separate
// token for this exists yet, so it's applied as a direct arbitrary value here rather than adding a
// third muted-foreground tier for one usage) and List row cell (node 471:24047: px-3 py-2.5,
// gap-3, 14px regular Content/Dark/Primary/black text). Dropped the previous stock-shadcn
// uppercase/tracking-wide/text-xs header treatment — Venture's own "NAME" example is literal typed
// content, not a text-transform; the kit's real header style is plain 14px regular.
import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

export const Table = forwardRef(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto">
    <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
  </div>
));
Table.displayName = "Table";

export const TableHeader = forwardRef(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

export const TableBody = forwardRef(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

export const TableFooter = forwardRef(({ className, ...props }, ref) => (
  <tfoot ref={ref} className={cn("border-t border-border bg-muted/50 font-medium", className)} {...props} />
));
TableFooter.displayName = "TableFooter";

// Row hover/selected use --secondary (Interaction/Secondary/Hover #f2f2f2), not --muted (Background/
// Secondary #f9f9f9) — matching the same hover treatment Venture uses consistently elsewhere
// (Selector's Menu Item hover, nav item hover), rather than the stock shadcn muted/50 default.
export const TableRow = forwardRef(({ className, ...props }, ref) => (
  <tr ref={ref} className={cn("border-b border-border transition-colors hover:bg-secondary/60 data-[state=selected]:bg-secondary", className)} {...props} />
));
TableRow.displayName = "TableRow";

export const TableHead = forwardRef(({ className, ...props }, ref) => (
  <th ref={ref} className={cn("h-11 p-3 text-left align-middle text-sm font-normal text-[#afafaf] [&:has([role=checkbox])]:pr-0", className)} {...props} />
));
TableHead.displayName = "TableHead";

export const TableCell = forwardRef(({ className, ...props }, ref) => (
  <td ref={ref} className={cn("px-3 py-2.5 align-middle text-sm text-foreground [&:has([role=checkbox])]:pr-0", className)} {...props} />
));
TableCell.displayName = "TableCell";

export const TableCaption = forwardRef(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
));
TableCaption.displayName = "TableCaption";
