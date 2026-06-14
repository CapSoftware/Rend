"use client";

import { useState } from "react";

export default function DocsCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button
      aria-label="Copy code"
      className="docs-copy-button"
      onClick={copy}
      type="button"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
