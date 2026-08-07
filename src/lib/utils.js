// src/lib/utils.js — the standard shadcn/ui `cn()` helper (clsx + tailwind-merge): lets a
// component accept a `className` override prop and merge it with its own default classes without
// Tailwind's conflicting-utility ambiguity (e.g. a caller passing "p-2" to override a component's
// own "p-4" — plain string concatenation would ship both classes and let CSS source order decide
// the winner unpredictably; twMerge resolves same-property conflicts deterministically).
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
