import {
  assetApiErrorResponse,
  assetJsonResponse,
  fetchAnalyticsLive,
} from "../../../../lib/asset-api.ts";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
} from "../../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function numericWindow(value: string | null) {
  if (!value) return undefined;
  const windowSeconds = Number(value);
  return Number.isFinite(windowSeconds) ? windowSeconds : undefined;
}

export async function GET(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  const url = new URL(request.url);
  try {
    return assetJsonResponse({
      status: "ok",
      live: await fetchAnalyticsLive(access.context, numericWindow(url.searchParams.get("windowSeconds"))),
    });
  } catch (error) {
    return assetApiErrorResponse(error);
  }
}
