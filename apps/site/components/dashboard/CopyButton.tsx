"use client";

import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/components/ui/cn";

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  iconOnly = false,
  disabled = false,
  className,
  onCopied,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  iconOnly?: boolean;
  disabled?: boolean;
  className?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied?.();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* clipboard unavailable: silently no-op */
    }
  }

  const Icon = copied ? Check : Copy;

  return (
    <button
      type="button"
      onClick={copy}
      disabled={disabled}
      aria-label={iconOnly ? label : undefined}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-card text-[12.5px] font-medium text-ink-soft transition-colors hover:border-ink/25 hover:bg-bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 disabled:pointer-events-none disabled:opacity-50",
        iconOnly ? "w-8" : "px-2.5",
        copied && "text-[#2f6b46]",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {iconOnly ? null : copied ? copiedLabel : label}
    </button>
  );
}
