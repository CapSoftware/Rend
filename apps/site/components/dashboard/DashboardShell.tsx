"use client";

import type { ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { DashboardSidebar } from "./DashboardSidebar";

/**
 * Dashboard chrome built around the shadcn sidebar shell.
 */
export function DashboardShell({
  organizationName,
  userEmail,
  role,
  defaultOpen = true,
  children,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <DashboardSidebar organizationName={organizationName} userEmail={userEmail} role={role} />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
