import {
  assetApiErrorResponse,
  assetErrorResponse,
  assetJsonResponse,
  listAssets,
  uploadAsset,
} from "../../../lib/asset-api.ts";
import { BillingError, requireBillingReady } from "../../../lib/billing.ts";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
  canUploadAssets,
  dashboardSuspendedResponse,
  organizationIsSuspended,
} from "../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function numericLimit(value: string | null) {
  if (!value) return undefined;
  const limit = Number(value);
  return Number.isFinite(limit) ? limit : undefined;
}

export async function GET(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  try {
    const url = new URL(request.url);
    return assetJsonResponse(
      await listAssets(access.context, numericLimit(url.searchParams.get("limit")))
    );
  } catch (error) {
    return assetApiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);
  if (organizationIsSuspended(access.context)) return dashboardSuspendedResponse(access.context);
  if (!canUploadAssets(access.context)) {
    return dashboardAccessErrorResponse({ ok: false, reason: "forbidden" });
  }

  try {
    await requireBillingReady(access.context);
    return assetJsonResponse(await uploadAsset(access.context, request), { status: 201 });
  } catch (error) {
    if (error instanceof BillingError) {
      return assetErrorResponse(
        error.status === 402 ? 403 : error.status,
        error.code === "billing_required" ? "limit_exceeded" : error.code,
        error.message
      );
    }
    return assetApiErrorResponse(error);
  }
}
