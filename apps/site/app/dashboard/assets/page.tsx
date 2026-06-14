import type { Metadata } from "next";
import AssetsClient from "../../../components/AssetsClient";
import { AssetApiError, listAssets } from "../../../lib/asset-api.ts";
import {
  organizationIsSuspended,
  organizationSuspendedMessage,
} from "../../../lib/dashboard-auth.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-auth-next.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Assets",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AssetsPage() {
  const access = await requireDashboardAccess("/dashboard/assets");
  const readOnlyReason = organizationIsSuspended(access)
    ? organizationSuspendedMessage(access)
    : undefined;

  try {
    const { assets } = await listAssets(access);
    return <AssetsClient initialAssets={assets} readOnlyReason={readOnlyReason} />;
  } catch (error) {
    const message =
      error instanceof AssetApiError
        ? error.body.message
        : "Rend API request failed";
    return <AssetsClient initialAssets={[]} initialError={message} readOnlyReason={readOnlyReason} />;
  }
}
