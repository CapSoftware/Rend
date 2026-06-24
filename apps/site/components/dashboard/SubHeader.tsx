"use client";

import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { DocsPill } from "./DocsPill";

/**
 * Per-page sub-header inside the content column: sidebar collapse toggle, page
 * title (serif), a docs pill, and an optional right-aligned actions slot.
 */
export function SubHeader({
  title,
  docsHref,
  docsLabel,
  leading,
  actions,
  className,
}: {
  title: ReactNode;
  docsHref?: string;
  docsLabel?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line bg-bg/90 px-5 backdrop-blur-md sm:px-7 lg:px-8",
        className,
      )}
    >
      <SidebarTrigger className="-ml-1.5 shrink-0" />
      <div className="hidden h-5 w-px shrink-0 bg-line sm:block" aria-hidden="true" />
      {leading}
      <h1 className="min-w-0 truncate font-head text-[18px] leading-none text-ink">{title}</h1>
      {docsHref ? <DocsPill href={docsHref} label={docsLabel} className="hidden sm:inline-flex" /> : null}
      {actions ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
