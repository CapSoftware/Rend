"use client";

import { useState } from "react";
import { copyText } from "./copy-text";

export default function DocsCopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  failedLabel = "Failed",
  ariaLabel = "Copy code",
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  failedLabel?: string;
  ariaLabel?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    const ok = await copyText(value);
    setStatus(ok ? "copied" : "failed");
    window.setTimeout(() => setStatus("idle"), 1400);
  }

  return (
    <button
      aria-label={ariaLabel}
      className="inline-flex min-h-8 shrink-0 items-center justify-center border border-line bg-bg px-2.5 text-[12px] font-medium leading-none text-ink transition hover:border-ink/40 hover:bg-bg-sunken/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      onClick={copy}
      type="button"
    >
      {status === "copied" ? copiedLabel : status === "failed" ? failedLabel : label}
    </button>
  );
}
