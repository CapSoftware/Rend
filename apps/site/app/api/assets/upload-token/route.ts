import { assetApiErrorResponse, assetErrorResponse, assetJsonResponse } from "../../../../lib/asset-api.ts";
import { BillingError, requireBillingReady } from "../../../../lib/billing.ts";
import { createDashboardUploadIntent } from "../../../../lib/dashboard-upload-token.ts";
import {
  canUploadAssets,
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
  dashboardSuspendedResponse,
  organizationIsSuspended,
} from "../../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);
  if (organizationIsSuspended(access.context)) return dashboardSuspendedResponse(access.context);
  if (!canUploadAssets(access.context)) {
    return dashboardAccessErrorResponse({ ok: false, reason: "forbidden" });
  }

  try {
    await requireBillingReady(access.context);
    const body = (await request.json().catch(() => ({}))) as {
      contentType?: unknown;
      contentLength?: unknown;
    };
    return assetJsonResponse(createDashboardUploadIntent(access.context, body));
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
