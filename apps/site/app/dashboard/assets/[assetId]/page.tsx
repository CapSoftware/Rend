import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AssetDetailClient from "../../../../components/AssetDetailClient";
import {
  AssetApiError,
  fetchAssetDetail,
  fetchAssetPlaybackAnalytics,
  fetchAssetPlayerTelemetry,
  normalizeAssetId,
} from "../../../../lib/asset-api.ts";
import {
  organizationIsSuspended,
  organizationSuspendedMessage,
} from "../../../../lib/dashboard-auth.ts";
import { requireDashboardAccess } from "../../../../lib/dashboard-auth-next.ts";

type AssetTab = "overview" | "artifacts" | "analytics" | "embed";

type AssetPageProps = {
  params: Promise<{ assetId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
};

export const dynamic = "force-dynamic";

function normalizeAssetTab(value: string | string[] | undefined): AssetTab {
  const tab = Array.isArray(value) ? value[0] : value;
  return tab === "artifacts" || tab === "analytics" || tab === "embed" ? tab : "overview";
}

export const metadata: Metadata = {
  title: "Asset",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AssetPage({ params, searchParams }: AssetPageProps) {
  const [{ assetId: rawAssetId }, query] = await Promise.all([params, searchParams]);
  const assetId = normalizeAssetId(rawAssetId);
  if (!assetId) notFound();
  const initialTab = normalizeAssetTab(query.tab);
  const access = await requireDashboardAccess(`/dashboard/assets/${assetId}`);
  const readOnlyReason = organizationIsSuspended(access)
    ? organizationSuspendedMessage(access)
    : undefined;

  let asset;
  try {
    asset = await fetchAssetDetail(access, assetId);
  } catch (error) {
    if (error instanceof AssetApiError && [400, 404].includes(error.status)) notFound();
    throw error;
  }

  const [analytics, telemetry] = await Promise.all([
    fetchAssetPlaybackAnalytics(access, assetId).catch(() => null),
    fetchAssetPlayerTelemetry(access, assetId, { limit: 20 }).catch(() => []),
  ]);

  return (
    <AssetDetailClient
      initialAnalytics={analytics}
      initialAsset={asset}
      initialTab={initialTab}
      initialTelemetry={telemetry}
      readOnlyReason={readOnlyReason}
    />
  );
}
