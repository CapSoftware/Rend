import type { ReactNode } from "react";
import { cn } from "./cn";

const tones = {
  default: "border-line bg-card text-ink",
  muted: "border-line bg-bg-sunken text-muted",
  outline: "border-line/80 bg-transparent text-muted",
} as const;

export function Badge({
  children,
  tone = "default",
  dot = false,
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof tones;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium leading-none",
        tones[tone],
        className,
      )}
    >
      {dot ? <span className="live-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
