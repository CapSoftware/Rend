"use client";

import { BookOpen, CreditCard, LogOut } from "lucide-react";
import Link from "next/link";
import { signOutOfDashboard } from "@/lib/auth-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Global-bar account menu (moved here from the sidebar footer). */
export function AccountMenu({
  organizationName,
  userEmail,
  role,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
}) {
  const initial = (userEmail.trim()[0] ?? "R").toUpperCase();
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-[12.5px] font-semibold text-bg outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-bg data-[state=open]:ring-2 data-[state=open]:ring-ink/30 data-[state=open]:ring-offset-2 data-[state=open]:ring-offset-bg"
        aria-label="Account menu"
      >
        {initial}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
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
