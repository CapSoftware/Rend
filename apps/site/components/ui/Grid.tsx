import type { ElementType, ReactNode } from "react";
import { cn } from "./cn";

// Static class strings so Tailwind can detect them at build time.
const colMap = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
} as const;

const gapMap = {
  sm: "gap-3",
  md: "gap-4",
  lg: "gap-6",
  xl: "gap-6 md:gap-8",
} as const;

export function Grid({
  as: Tag = "div",
  cols = 3,
  gap = "md",
  className,
  children,
}: {
  as?: ElementType;
  cols?: keyof typeof colMap;
  gap?: keyof typeof gapMap;
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={cn("grid", colMap[cols], gapMap[gap], className)}>{children}</Tag>;
}
