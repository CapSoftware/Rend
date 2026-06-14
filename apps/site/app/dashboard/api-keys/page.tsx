import type { Metadata } from "next";
import ApiKeysClient from "../../../components/ApiKeysClient";
import { listApiKeys } from "../../../lib/api-keys.ts";
import { canManageApiKeys } from "../../../lib/dashboard-auth.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-auth-next.ts";

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
  if (!canManageApiKeys(access)) {
    return <ApiKeysClient initialKeys={[]} initialError="Insufficient organization permissions" />;
  }

  try {
    return <ApiKeysClient initialKeys={await listApiKeys(access)} />;
  } catch {
    return <ApiKeysClient initialKeys={[]} initialError="API keys could not be loaded" />;
  }
}
