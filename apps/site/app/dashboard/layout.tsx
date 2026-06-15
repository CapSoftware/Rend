import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireDashboardAccess } from "../../lib/dashboard-auth-next.ts";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await requireDashboardAccess();
  return children;
}
