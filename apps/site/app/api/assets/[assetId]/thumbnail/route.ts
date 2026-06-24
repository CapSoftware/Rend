import {
  assetApiErrorResponse,
  fetchAssetThumbnail,
} from "../../../../../lib/asset-api.ts";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
} from "../../../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> }
) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  const { assetId } = await context.params;
  try {
    return await fetchAssetThumbnail(access.context, assetId);
  } catch (error) {
    return assetApiErrorResponse(error);
  }
}
