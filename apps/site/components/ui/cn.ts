import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type { ClassValue };

/**
 * Merge class names: resolves conditional values (clsx) and dedupes conflicting
 * Tailwind utilities so a later class wins over an earlier one (tailwind-merge).
 */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
