import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  DASHBOARD_SESSION_COOKIE,
  dashboardAccessFromCookieValue,
} from "./dashboard-auth.ts";

export function safeDashboardNextPath(value: string | string[] | undefined) {
  const nextPath = Array.isArray(value) ? value[0] : value;
  if (!nextPath || !nextPath.startsWith("/dashboard/")) return "/dashboard/assets";
  if (nextPath.startsWith("//") || nextPath.includes("\\")) return "/dashboard/assets";
  return nextPath;
}

export async function dashboardSessionIsValid() {
  const cookieStore = await cookies();
  return dashboardAccessFromCookieValue(cookieStore.get(DASHBOARD_SESSION_COOKIE)?.value).ok;
}

export async function requireDashboardAccess(nextPath = "/dashboard/assets") {
  if (await dashboardSessionIsValid()) return;
  redirect(`/login?next=${encodeURIComponent(nextPath)}`);
}
