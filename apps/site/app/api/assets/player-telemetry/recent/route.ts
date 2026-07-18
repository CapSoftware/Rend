import {
  assetApiErrorResponse,
  assetErrorResponse,
  assetJsonResponse,
  fetchAssetPlayerTelemetry,
} from "../../../../../lib/asset-api.ts";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
} from "../../../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeTelemetryId(value: string | null) {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) return null;
  return /^[a-zA-Z0-9._:-]+$/.test(normalized) ? normalized : null;
}

function numericLimit(value: string | null) {
  if (!value) return undefined;
  const limit = Number(value);
  return Number.isFinite(limit) ? limit : undefined;
}

export async function GET(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  const url = new URL(request.url);
  const assetId = safeTelemetryId(url.searchParams.get("assetId"));
  const playbackSessionId = safeTelemetryId(url.searchParams.get("playbackSessionId"));
  if (assetId === null || playbackSessionId === null) {
    return assetErrorResponse(400, "invalid_query", "Telemetry query contains an invalid id");
  }
  if (!assetId) {
    return assetErrorResponse(400, "invalid_query", "Telemetry query requires an asset id");
  }

  try {
    return assetJsonResponse({
      status: "ok",
      events: await fetchAssetPlayerTelemetry(access.context, assetId, {
        playbackSessionId,
        limit: numericLimit(url.searchParams.get("limit")),
      }),
    });
  } catch (error) {
    return assetApiErrorResponse(error);
  }
}
