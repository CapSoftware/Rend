import {
  assetApiErrorResponse,
  assetJsonResponse,
  listAssets,
  uploadAsset,
} from "../../../lib/asset-api.ts";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
} from "../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function numericLimit(value: string | null) {
  if (!value) return undefined;
  const limit = Number(value);
  return Number.isFinite(limit) ? limit : undefined;
}

export async function GET(request: Request) {
  const access = dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  try {
    const url = new URL(request.url);
    return assetJsonResponse(await listAssets(numericLimit(url.searchParams.get("limit"))));
  } catch (error) {
    return assetApiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const access = dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  try {
    return assetJsonResponse(await uploadAsset(request), { status: 201 });
  } catch (error) {
    return assetApiErrorResponse(error);
  }
}
