import type { ElementType, ReactNode } from "react";
import { cn } from "./cn";

const widths = {
  narrow: "max-w-[720px]",
  prose: "max-w-[920px]",
  default: "max-w-[1080px]",
  wide: "max-w-[1200px]",
} as const;

export type ContainerSize = keyof typeof widths;

export function Container({
  as: Tag = "div",
  size = "default",
  className,
  children,
}: {
  as?: ElementType;
  size?: ContainerSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={cn("mx-auto w-full px-5 sm:px-8", widths[size], className)}>
      {children}
    </Tag>
  );
}
