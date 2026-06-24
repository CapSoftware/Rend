"use client";

import { BarChart3, BookOpen, CreditCard, Film, KeyRound, Mail, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { AccountMenu } from "./AccountMenu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

type NavItem = { label: string; href: string; icon: LucideIcon; external?: boolean };

const workspaceNav: NavItem[] = [
  { label: "Assets", href: "/dashboard/assets", icon: Film },
  { label: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { label: "API keys", href: "/dashboard/api-keys", icon: KeyRound },
  { label: "Billing", href: "/dashboard/billing", icon: CreditCard },
];

const supportNav: NavItem[] = [
  { label: "Documentation", href: "/docs", icon: BookOpen, external: true },
  { label: "Contact", href: "mailto:hello@rend.so", icon: Mail },
];

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function RendMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 75 135" fill="none" aria-hidden="true" className={className}>
      <path d="M0 27L30.3 44.17V90.64L0 107.8V27Z" fill="currentColor" />
      <path d="M41.42 48.21L74.75 67.4L41.42 86.6V48.21Z" fill="currentColor" />
    </svg>
  );
}

export function DashboardSidebar({
  organizationName,
  userEmail,
  role,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
}) {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Rend dashboard">
              <Link href="/dashboard/assets">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-accent text-sidebar-primary">
                  <RendMark className="h-6 w-auto" />
                </span>
                <span className="grid min-w-0 flex-1">
                  <span className="truncate font-head text-[15px] leading-tight text-ink">Rend</span>
                  <span className="truncate text-[12px] leading-tight text-muted">Dashboard</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="px-1 group-data-[collapsible=icon]:hidden">
          <WorkspaceSwitcher
            organizationName={organizationName}
            role={role}
            className="h-9 w-full max-w-none justify-start bg-sidebar-accent/60 px-2 hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent"
          />
        </div>
      </SidebarHeader>

      <SidebarContent className="py-3">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {workspaceNav.map((item) => {
                const active = isActivePath(pathname, item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                      <Link href={item.href}>
                        <item.icon className={cn(active ? "text-ink" : "text-faint")} />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              {supportNav.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild tooltip={item.label} className="h-8 text-[13px] text-muted">
                    <a
                      href={item.href}
                      target={item.external ? "_blank" : undefined}
                      rel={item.external ? "noopener noreferrer" : undefined}
                    >
                      <item.icon className="text-faint" />
                      <span>{item.label}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-3 border-t border-sidebar-border p-2">
        <AccountMenu organizationName={organizationName} userEmail={userEmail} role={role} variant="sidebar" />

        <div className="flex items-center gap-2 px-2 text-[11px] text-faint group-data-[collapsible=icon]:hidden">
          <Link href="/privacy" className="transition-colors hover:text-muted">
            Privacy
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/terms" className="transition-colors hover:text-muted">
            Terms
          </Link>
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
