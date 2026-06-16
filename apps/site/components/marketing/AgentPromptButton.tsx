"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { copyText } from "@/components/copy-text";

type ResourceLink = { label: string; href: string; description: string };

/**
 * Low-key "copy prompt for your agent" control. Reads as a single quiet button
 * that copies the integration brief, with a plus toggle to expand and read the
 * full prompt plus the agent-facing resource links.
 */
export function AgentPromptButton({
  promptCode,
  resources,
  leadingLabel,
  size = "md",
}: {
  promptCode: string;
  resources: readonly ResourceLink[];
  leadingLabel?: string;
  size?: "sm" | "md";
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [open, setOpen] = useState(false);
  const panelId = useId();

  async function copy() {
    const ok = await copyText(promptCode);
    setStatus(ok ? "copied" : "failed");
    window.setTimeout(() => setStatus("idle"), 1600);
  }

  const copied = status === "copied";
  const s =
    size === "sm"
      ? { copy: "gap-1.5 px-2.5 py-1.5 text-[12px]", toggle: "w-8", lead: "h-[31px]", icon: 13 }
      : { copy: "gap-2 px-3.5 py-2.5 text-[13.5px]", toggle: "w-10", lead: "h-[42px]", icon: 15 };

  return (
    <div className="flex max-w-[560px] items-start gap-2.5">
      {leadingLabel ? (
        <span className={`flex ${s.lead} shrink-0 items-center text-[13.5px] text-faint`}>
          {leadingLabel}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="inline-flex items-stretch border border-line bg-card">
          <button
            type="button"
            onClick={copy}
            className={`inline-flex items-center ${s.copy} font-medium text-ink transition-colors hover:bg-bg-sunken/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 focus-visible:ring-inset`}
          >
            <svg width={s.icon} height={s.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-muted">
              {copied ? (
                <path d="M5 12.5l4 4 10-10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <>
                  <rect x="9" y="9" width="11" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M5 15.5V5.6A1.6 1.6 0 0 1 6.6 4h9.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </>
              )}
            </svg>
            {copied ? "Copied to clipboard" : status === "failed" ? "Copy failed, try again" : "Copy prompt for your agent"}
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? "Hide the prompt" : "Read the prompt"}
            className={`grid ${s.toggle} place-items-center border-l border-line text-muted transition-colors hover:bg-bg-sunken/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 focus-visible:ring-inset`}
          >
            <svg
              width={s.icon}
              height={s.icon}
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className={`transition-transform duration-200 ${open ? "rotate-45" : ""}`}
            >
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {open ? (
          <div id={panelId} className="mt-3 overflow-hidden border border-line bg-card">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3.5 py-2">
            <span className="font-mono text-[11.5px] font-medium text-muted">rend-agent-prompt.txt</span>
            <span className="text-[11.5px] text-faint">Paste into Claude Code, Cursor, or any coding agent</span>
          </div>
          <pre
            tabIndex={0}
            className="max-h-[300px] overflow-auto bg-[#11100e] px-4 py-4 font-mono text-[12px] leading-[1.7] text-[#f7f2e8] outline-none focus-visible:ring-2 focus-visible:ring-ink/40 focus-visible:ring-inset"
          >
            <code>{promptCode}</code>
          </pre>
          <div className="grid gap-px border-t border-line bg-line sm:grid-cols-2">
            {resources.map((resource) => {
              const isExternal = resource.href.startsWith("http");
              const className =
                "bg-card px-3.5 py-2.5 text-left transition-colors hover:bg-bg-sunken/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 focus-visible:ring-inset";
              const content = (
                <>
                  <span className="block text-[12.5px] font-medium leading-tight text-ink">
                    {resource.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-tight text-muted">
                    {resource.description}
                  </span>
                </>
              );

              return isExternal ? (
                <a
                  className={className}
                  href={resource.href}
                  key={resource.href}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {content}
                </a>
              ) : (
                <Link className={className} href={resource.href} key={resource.href}>
                  {content}
                </Link>
              );
            })}
          </div>
        </div>
        ) : null}
      </div>
    </div>
  );
}
