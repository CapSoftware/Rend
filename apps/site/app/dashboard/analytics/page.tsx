import type { Metadata } from "next";
import AnalyticsClient from "../../../components/AnalyticsClient";
import { AssetApiError, fetchAnalyticsOverview } from "../../../lib/asset-api.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-auth-next.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Analytics",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AnalyticsPage() {
  const access = await requireDashboardAccess("/dashboard/analytics");

  try {
    return <AnalyticsClient initialAnalytics={await fetchAnalyticsOverview(access)} />;
  } catch (error) {
    const message =
      error instanceof AssetApiError ? error.body.message : "Rend API request failed";
    return <AnalyticsClient initialAnalytics={null} initialError={message} />;
  }
}
