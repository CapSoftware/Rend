import {
  assetApiErrorResponse,
  assetJsonResponse,
  fetchAssetPlaybackAnalytics,
} from "../../../../../lib/asset-api.ts";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
} from "../../../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function numericWindow(value: string | null) {
  if (!value) return undefined;
  const windowSeconds = Number(value);
  return Number.isFinite(windowSeconds) ? windowSeconds : undefined;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> }
) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  const { assetId } = await context.params;
  const url = new URL(request.url);
  try {
    return assetJsonResponse({
      status: "ok",
      analytics: await fetchAssetPlaybackAnalytics(
        access.context,
        assetId,
        numericWindow(url.searchParams.get("windowSeconds"))
      ),
    });
  } catch (error) {
    return assetApiErrorResponse(error);
  }
}
