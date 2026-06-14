import type { Metadata } from "next";
import AssetsClient from "../../../components/AssetsClient";
import { AssetApiError, listAssets } from "../../../lib/asset-api.ts";
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
  await requireDashboardAccess("/dashboard/assets");

  try {
    const { assets } = await listAssets();
    return <AssetsClient initialAssets={assets} />;
  } catch (error) {
    const message =
      error instanceof AssetApiError
        ? error.body.message
        : "Rend API request failed";
    return <AssetsClient initialAssets={[]} initialError={message} />;
  }
}
