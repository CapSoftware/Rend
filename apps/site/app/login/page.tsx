import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LoginForm from "../../components/LoginForm";
import { dashboardAuthConfigured } from "../../lib/dashboard-auth.ts";
import {
  dashboardSessionIsValid,
  safeDashboardNextPath,
} from "../../lib/dashboard-auth-next.ts";

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Login",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const nextPath = safeDashboardNextPath(params.next);
  if (await dashboardSessionIsValid()) redirect(nextPath);

  return <LoginForm configured={dashboardAuthConfigured()} nextPath={nextPath} />;
}
