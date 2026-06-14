import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  dashboardAccessFromHeaders,
  type DashboardAccessContext,
} from "./dashboard-auth.ts";

export function safeDashboardNextPath(value: string | string[] | undefined) {
  const nextPath = Array.isArray(value) ? value[0] : value;
  if (!nextPath || !nextPath.startsWith("/dashboard/")) return "/dashboard/assets";
  if (nextPath.startsWith("//") || nextPath.includes("\\")) return "/dashboard/assets";
  return nextPath;
}

export async function dashboardSessionIsValid() {
  const access = await dashboardAccessFromHeaders(new Headers(await headers()));
  return access.ok;
}

export async function requireDashboardAccess(nextPath = "/dashboard/assets"): Promise<DashboardAccessContext> {
  const access = await dashboardAccessFromHeaders(new Headers(await headers()));
  if (access.ok) return access.context;
  redirect(`/login?next=${encodeURIComponent(nextPath)}`);
}
