"use client";

import { Building2, Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Global-bar workspace switcher. Rend has a single organization per session, so
 * this lists the active workspace and the viewer's role (no invented orgs).
 */
export function WorkspaceSwitcher({
  organizationName,
  role,
}: {
  organizationName: string;
  role: string;
}) {
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const initial = (organizationName.trim()[0] ?? "R").toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="group inline-flex max-w-[40vw] items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-bg-sunken focus-visible:ring-2 focus-visible:ring-ink/25 data-[state=open]:bg-bg-sunken sm:max-w-[260px]"
        aria-label="Switch workspace"
      >
        <span className="grid size-5 shrink-0 place-items-center rounded bg-bg-sunken text-faint">
          <Building2 className="size-3.5" />
        </span>
        <span className="truncate text-[13.5px] font-medium text-ink">{organizationName}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
          Workspace
        </DropdownMenuLabel>
        <DropdownMenuItem className="gap-2.5" aria-current="true">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-ink text-[12px] font-semibold text-bg">
            {initial}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium text-ink">{organizationName}</span>
            <span className="truncate text-[12px] text-muted">{roleLabel}</span>
          </span>
          <Check className="size-4 shrink-0 text-ink" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
