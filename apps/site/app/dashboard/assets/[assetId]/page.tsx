import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AssetDetailClient from "../../../../components/AssetDetailClient";
import {
  AssetApiError,
  fetchAssetDetail,
  fetchAssetPlaybackAnalytics,
  normalizeAssetId,
} from "../../../../lib/asset-api.ts";
import {
  organizationIsSuspended,
  organizationSuspendedMessage,
} from "../../../../lib/dashboard-auth.ts";
import { requireDashboardAccess } from "../../../../lib/dashboard-auth-next.ts";
import { recentPlayerTelemetryEvents } from "../../../../lib/player-telemetry.ts";

type AssetPageProps = {
  params: Promise<{ assetId: string }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Asset",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AssetPage({ params }: AssetPageProps) {
  const { assetId: rawAssetId } = await params;
  const assetId = normalizeAssetId(rawAssetId);
  if (!assetId) notFound();
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

  const analytics = await fetchAssetPlaybackAnalytics(access, assetId).catch(() => null);
  const telemetry = recentPlayerTelemetryEvents({ assetId, limit: 20 });

  return (
    <AssetDetailClient
      initialAnalytics={analytics}
      initialAsset={asset}
      initialTelemetry={telemetry}
      readOnlyReason={readOnlyReason}
    />
  );
}
