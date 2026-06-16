"use client";

import type { CSSProperties, ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { DashboardSidebar } from "./DashboardSidebar";
import { GlobalTopBar } from "./GlobalTopBar";

/**
 * Two-tier dashboard chrome: a full-width global bar on top, then a flex row of
 * the collapsible sidebar and the content inset. The sidebar is offset to start
 * below the global bar via the `--sidebar-top` custom property.
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
    <div className="flex min-h-svh flex-col bg-bg">
      <GlobalTopBar organizationName={organizationName} userEmail={userEmail} role={role} />
      <SidebarProvider
        defaultOpen={defaultOpen}
        className="min-h-0 flex-1"
        style={{ "--sidebar-top": "3.5rem" } as CSSProperties}
      >
        <DashboardSidebar />
        <SidebarInset className="min-h-[calc(100svh-3.5rem)]">{children}</SidebarInset>
      </SidebarProvider>
    </div>
  );
}
