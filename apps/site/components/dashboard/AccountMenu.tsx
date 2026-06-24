"use client";

import { BookOpen, ChevronsUpDown, CreditCard, LogOut } from "lucide-react";
import Link from "next/link";
import { signOutOfDashboard } from "@/lib/auth-client";
import { cn } from "@/components/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Account menu used in the dashboard chrome. */
export function AccountMenu({
  organizationName,
  userEmail,
  role,
  variant = "avatar",
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  variant?: "avatar" | "sidebar";
}) {
  const initial = (userEmail.trim()[0] ?? "R").toUpperCase();
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const sidebarTrigger = variant === "sidebar";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          sidebarTrigger
            ? "flex h-10 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
            : "grid size-8 shrink-0 place-items-center rounded-full bg-ink text-[12.5px] font-semibold text-bg outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-bg data-[state=open]:ring-2 data-[state=open]:ring-ink/30 data-[state=open]:ring-offset-2 data-[state=open]:ring-offset-bg",
        )}
        aria-label="Account menu"
      >
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-full bg-ink text-[12.5px] font-semibold text-bg",
            sidebarTrigger ? "size-7" : "size-8",
          )}
        >
          {initial}
        </span>
        {sidebarTrigger ? (
          <>
            <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
              <span className="block truncate text-[13px] font-medium text-ink">{userEmail}</span>
              <span className="block truncate text-[12px] text-muted">{roleLabel}</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-faint group-data-[collapsible=icon]:hidden" />
          </>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={sidebarTrigger ? "start" : "end"}
        side={sidebarTrigger ? "right" : "bottom"}
        className="min-w-60"
      >
        <DropdownMenuLabel className="flex flex-col gap-1">
          <span className="truncate text-[13px] font-medium text-ink">{organizationName}</span>
          <span className="truncate text-[12px] font-normal text-muted">{userEmail}</span>
          <span className="mt-0.5 inline-flex w-fit items-center rounded border border-line bg-bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-muted">
            {roleLabel}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard/billing">
            <CreditCard />
            Billing
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="/docs" target="_blank" rel="noopener noreferrer">
            <BookOpen />
            Documentation
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            void signOutOfDashboard();
          }}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
