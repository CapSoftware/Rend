import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * Padded, max-width content column that sits below a page sub-header inside the
 * SidebarInset. Sub-headers render edge-to-edge; everything else lives here.
 */
export function DashboardContent({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[1240px] flex-1 px-5 py-7 sm:px-7 lg:px-8", className)}>
      {children}
    </div>
  );
}
