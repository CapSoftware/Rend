import type { ElementType, ReactNode } from "react";
import { cn } from "./cn";

export function Card({
  as: Tag = "div",
  interactive = false,
  className,
  children,
}: {
  as?: ElementType;
  interactive?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={cn(
        "rounded-[18px] border border-line bg-card",
        interactive &&
          "transition duration-300 ease-out will-change-transform hover:-translate-y-[3px] hover:shadow-[0_20px_44px_-26px_rgba(22,21,19,0.32)]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
