"use client";

import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export type TabItem = { value: string; label: ReactNode };

/**
 * Underline tabs (PlanetScale density): active row gets ink text and a 2px ink
 * underline sitting on the row's bottom border; inactive rows stay muted.
 */
export function Tabs({
  items,
  value,
  onValueChange,
  ariaLabel,
  className,
}: {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("flex items-stretch gap-6 overflow-x-auto border-b border-line", className)}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "-mb-px inline-flex h-10 shrink-0 items-center whitespace-nowrap border-b-2 text-[13.5px] font-medium transition-colors focus-visible:outline-none focus-visible:text-ink",
              active
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink-soft",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
