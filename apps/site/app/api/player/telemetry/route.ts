import {
  PLAYER_TELEMETRY_MAX_BODY_BYTES,
  recordPlayerTelemetryEvents,
  sanitizePlayerTelemetryPayload,
} from "@/lib/player-telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function contentLengthTooLarge(request: Request) {
  const value = request.headers.get("content-length");
  if (!value) return false;
  const length = Number(value);
  return Number.isFinite(length) && length > PLAYER_TELEMETRY_MAX_BODY_BYTES;
}

async function readBoundedBody(request: Request) {
  if (contentLengthTooLarge(request)) {
    return { ok: false as const, status: 413, error: "body_too_large" };
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > PLAYER_TELEMETRY_MAX_BODY_BYTES) {
    return { ok: false as const, status: 413, error: "body_too_large" };
  }

  return { ok: true as const, body };
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse(
      {
        status: "error",
        error: "content_type_must_be_application_json",
      },
      { status: 415 }
    );
  }

  const body = await readBoundedBody(request);
  if (!body.ok) {
    return jsonResponse(
      {
        status: "error",
        error: body.error,
      },
      { status: body.status }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.body);
  } catch {
    return jsonResponse(
      {
        status: "error",
        error: "invalid_json",
      },
      { status: 400 }
    );
  }

  const result = sanitizePlayerTelemetryPayload(payload);
  if (!result.ok) {
    return jsonResponse(
      {
        status: "error",
        error: result.error,
      },
      { status: result.status }
    );
  }

  recordPlayerTelemetryEvents(result.events);

  return jsonResponse({
    status: "ok",
    accepted: result.events.length,
  });
}
