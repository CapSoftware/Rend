import { recentPlayerTelemetryEvents } from "@/lib/player-telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function envFlag(name: string) {
  return ["1", "true", "yes", "on"].includes((process.env[name] || "").toLowerCase());
}

function isLocalRequest(requestUrl: URL) {
  return ["127.0.0.1", "::1", "localhost"].includes(requestUrl.hostname);
}

function debugEndpointEnabled(requestUrl: URL) {
  return (
    envFlag("REND_PLAYER_TELEMETRY_DEBUG") ||
    process.env.NODE_ENV !== "production" ||
    isLocalRequest(requestUrl)
  );
}

function numericLimit(value: string | null) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  if (!debugEndpointEnabled(requestUrl)) {
    return jsonResponse(
      {
        status: "disabled",
      },
      { status: 404 }
    );
  }

  const assetId = requestUrl.searchParams.get("assetId");
  const playbackSessionId = requestUrl.searchParams.get("playbackSessionId");
  const limit = numericLimit(requestUrl.searchParams.get("limit"));

  return jsonResponse({
    status: "ok",
    events: recentPlayerTelemetryEvents({
      assetId,
      playbackSessionId,
      limit,
    }),
  });
}
