"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { AccountMenu } from "./AccountMenu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

function RendMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 75 135" fill="none" aria-hidden="true" className={className}>
      <path d="M0 27L30.3 44.17V90.64L0 107.8V27Z" fill="var(--color-ink)" />
      <path d="M41.42 48.21L74.75 67.4L41.42 86.6V48.21Z" fill="var(--color-ink)" />
    </svg>
  );
}

/**
 * Full-width global bar above the sidebar + content. Left: Rend mark and the
 * workspace switcher. Right: docs link and the account menu.
 */
export function GlobalTopBar({
  organizationName,
  userEmail,
  role,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1.5 border-b border-line bg-bg px-3 sm:px-4">
      <Link
        href="/dashboard/assets"
        aria-label="Rend dashboard home"
        className="flex shrink-0 items-center rounded-md px-1.5 py-1 transition-opacity hover:opacity-70"
      >
        <RendMark className="h-7 w-auto" />
      </Link>
      <span className="mx-0.5 hidden text-[15px] text-line sm:inline" aria-hidden="true">
        /
      </span>
      <WorkspaceSwitcher organizationName={organizationName} role={role} />

      <div className="ml-auto flex items-center gap-1">
        <a
          href="/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-bg-sunken hover:text-ink"
        >
          Docs
          <ExternalLink className="size-3.5" />
        </a>
        <span className="mx-1.5 h-5 w-px bg-line" aria-hidden="true" />
        <AccountMenu organizationName={organizationName} userEmail={userEmail} role={role} />
      </div>
    </header>
  );
}
