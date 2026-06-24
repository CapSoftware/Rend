import {
  PLAYER_TELEMETRY_MAX_BODY_BYTES,
  recordPlayerTelemetryEvents,
  sanitizePlayerTelemetryPayload,
  type SanitizedPlayerTelemetryEvent,
} from "../../../../lib/player-telemetry.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOCAL_SITE_INTERNAL_TOKEN = "local-site-internal-token";

function envBooleanOverride(name: string) {
  const value = (process.env[name] || "").trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function productionProfile() {
  const profile = envString("REND_ENV_PROFILE") || envString("REND_ENV") || process.env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function telemetryIngestEnabled() {
  const ingestOverride = envBooleanOverride("REND_PLAYER_TELEMETRY_INGEST");
  if (ingestOverride !== undefined) return ingestOverride;
  const publicOverride = envBooleanOverride("NEXT_PUBLIC_REND_PLAYER_TELEMETRY");
  if (publicOverride !== undefined) return publicOverride;
  return productionProfile();
}

function controlPlaneUrl(path: string) {
  const baseUrl = envString("REND_API_BASE_URL", "http://127.0.0.1:4000").replace(/\/+$/, "");
  return `${baseUrl}${path}`;
}

function siteInternalToken() {
  const configured = envString("REND_SITE_INTERNAL_TOKEN");
  if (configured) return configured;
  return productionProfile() ? "" : LOCAL_SITE_INTERNAL_TOKEN;
}

function telemetryInternalToken() {
  const configured =
    envString("REND_INTERNAL_TELEMETRY_TOKEN") || envString("REND_EDGE_INTERNAL_TOKEN");
  if (configured) return configured;
  return productionProfile() ? "" : "dev-internal-token";
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function disabledIngestResponse() {
  return jsonResponse({
    status: "ok",
    accepted: 0,
  });
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

async function forwardDurablePlayerTelemetry(events: SanitizedPlayerTelemetryEvent[]) {
  if (events.length === 0) return;

  const body = JSON.stringify({ events });
  const siteToken = siteInternalToken();
  if (siteToken) {
    const response = await fetch(controlPlaneUrl("/v1/site/player-telemetry"), {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
      headers: {
        "content-type": "application/json",
        "x-rend-site-token": siteToken,
      },
      body,
    });
    if (response.ok) return;
  }

  const token = telemetryInternalToken();
  if (!token) return;

  await fetch(controlPlaneUrl("/internal/telemetry/player"), {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(1500),
    headers: {
      "content-type": "application/json",
      "x-rend-internal-token": token,
    },
    body,
  });
}

export async function POST(request: Request) {
  if (!telemetryIngestEnabled()) return disabledIngestResponse();

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
  await forwardDurablePlayerTelemetry(result.events).catch(() => undefined);

  return jsonResponse({
    status: "ok",
    accepted: result.events.length,
  });
}
