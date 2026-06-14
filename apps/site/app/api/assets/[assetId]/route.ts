import {
  assetApiErrorResponse,
  assetJsonResponse,
  deleteAsset,
  fetchAssetDetail,
} from "../../../../lib/asset-api.ts";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
  canDeleteAssets,
  dashboardSuspendedResponse,
  organizationIsSuspended,
} from "../../../../lib/dashboard-auth.ts";

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
    return assetJsonResponse({
      status: "ok",
      asset: await fetchAssetDetail(access.context, assetId),
    });
  } catch (error) {
    return assetApiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ assetId: string }> }
) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);
  if (organizationIsSuspended(access.context)) return dashboardSuspendedResponse(access.context);
  if (!canDeleteAssets(access.context)) {
    return dashboardAccessErrorResponse({ ok: false, reason: "forbidden" });
  }

  const { assetId } = await context.params;
  try {
    return assetJsonResponse(await deleteAsset(access.context, assetId));
  } catch (error) {
    return assetApiErrorResponse(error);
  }
}
