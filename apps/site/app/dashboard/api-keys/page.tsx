import type { Metadata } from "next";
import ApiKeysClient from "../../../components/ApiKeysClient";
import { listApiKeys } from "../../../lib/api-keys.ts";
import { billingOverview, billingReadinessFromOverview } from "../../../lib/billing.ts";
import {
  organizationIsSuspended,
  organizationSuspendedMessage,
} from "../../../lib/dashboard-auth.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-auth-next.ts";
import { dashboardStateFromBilling } from "../../../lib/dashboard-state.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "API Keys",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function ApiKeysPage() {
  const access = await requireDashboardAccess("/dashboard/api-keys");
  const readOnlyReason = organizationIsSuspended(access)
    ? organizationSuspendedMessage(access)
    : undefined;
  const dashboardState = dashboardStateFromBilling(
    billingReadinessFromOverview(await billingOverview(access))
  );
  if (access.role !== "owner" && access.role !== "admin") {
    return (
      <ApiKeysClient
        dashboardState={dashboardState}
        initialKeys={[]}
        initialError={readOnlyReason ?? "Insufficient organization permissions"}
        readOnlyReason={readOnlyReason}
      />
    );
  }

  try {
    return (
      <ApiKeysClient
        dashboardState={dashboardState}
        initialKeys={await listApiKeys(access)}
        readOnlyReason={readOnlyReason}
      />
    );
  } catch {
    return (
      <ApiKeysClient
        dashboardState={dashboardState}
        initialKeys={[]}
        initialError="API keys could not be loaded"
        readOnlyReason={readOnlyReason}
      />
    );
  }
}
