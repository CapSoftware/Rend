import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard";
import { requireDashboardAccess } from "@/lib/dashboard-auth-next.ts";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const access = await requireDashboardAccess();
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <DashboardShell
      organizationName={access.organizationName}
      userEmail={access.userEmail}
      role={access.role}
      defaultOpen={defaultOpen}
    >
      {children}
    </DashboardShell>
  );
}
