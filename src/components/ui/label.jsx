// src/components/ui/label.jsx — standard shadcn/ui Label recipe (Radix Label primitive).
import { forwardRef } from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const labelVariants = cva("text-xs font-semibold uppercase tracking-wide text-muted-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70");

export const Label = forwardRef(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />
));
Label.displayName = LabelPrimitive.Root.displayName;
