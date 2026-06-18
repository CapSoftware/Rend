import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { billingOverview } from "../../lib/billing.ts";
import { requireDashboardAccess } from "../../lib/dashboard-auth-next.ts";
import { LEGAL_ASSENT_VERSION } from "../../lib/legal-assent-constants.ts";
import { organizationOnboardingComplete } from "../../lib/onboarding.ts";
import OnboardingClient from "@/components/OnboardingClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Welcome to Rend",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function OnboardingPage() {
  const access = await requireDashboardAccess();
  if (await organizationOnboardingComplete(access.organizationId)) {
    redirect("/dashboard/assets");
  }

  const billing = await billingOverview(access);

  return (
    <OnboardingClient
      userEmail={access.userEmail}
      plans={billing.plans}
      checkoutEnabled={billing.checkoutEnabled}
      legalAssentVersion={LEGAL_ASSENT_VERSION}
    />
  );
}
