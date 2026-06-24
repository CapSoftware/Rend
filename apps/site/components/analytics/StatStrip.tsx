"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { Delta } from "./format";

export type StatItem = {
  label: string;
  value: string;
  hint?: string;
  delta?: Delta;
  /** When true, a downward move is "good" (e.g. rebuffer, errors). */
  invertDelta?: boolean;
};

function deltaTone(delta: NonNullable<Delta>, invert?: boolean) {
  if (delta.direction === "flat") return "text-faint";
  const good = invert ? delta.direction === "down" : delta.direction === "up";
  return good ? "text-[#3f8f5b]" : "text-[#c0492f]";
}

export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <div className="flex divide-x divide-line overflow-x-auto rounded-xl border border-line bg-card">
      {items.map((item) => (
        <div key={item.label} className="min-w-[124px] flex-1 px-4 py-3">
          <p className="text-[12px] font-medium text-faint">{item.label}</p>
          <p className="mt-1.5 text-[21px] font-semibold leading-none tracking-tight tabular-nums text-ink">
            {item.value}
          </p>
          <div className="mt-1.5 flex h-[15px] items-center gap-1">
            {item.delta ? (
              <span className={cn("flex items-center gap-0.5 text-[11.5px] font-medium", deltaTone(item.delta, item.invertDelta))}>
                {item.delta.direction === "up" ? (
                  <ArrowUpRight className="size-3" />
                ) : item.delta.direction === "down" ? (
                  <ArrowDownRight className="size-3" />
                ) : null}
                {item.delta.label}
              </span>
            ) : item.hint ? (
              <span className="truncate text-[11.5px] text-muted">{item.hint}</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
