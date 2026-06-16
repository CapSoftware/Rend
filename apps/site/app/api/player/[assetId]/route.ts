export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { and, eq, isNull } from "drizzle-orm";
import { assets, organization } from "../../../../lib/db/schema.ts";
import {
  safePlaybackBootstrapResponse,
  type UpstreamPlaybackResponse,
} from "../../../../lib/player-bootstrap.ts";
import { playbackProxyCookieHeader } from "../../../../lib/player-artifact-proxy.ts";
import { getSiteDb } from "../../../../lib/server-db.ts";

type UpstreamAssetResponse = {
  asset_id?: unknown;
  source_state?: unknown;
  playable_state?: unknown;
};

const DEFAULT_API_BASE_URL = "http://127.0.0.1:4000";
const LOCAL_SITE_INTERNAL_TOKEN = "local-site-internal-token";

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function isProductionProfile() {
  const profile = envString("REND_ENV_PROFILE") || envString("REND_ENV") || process.env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function siteInternalToken() {
  const configured = envString("REND_SITE_INTERNAL_TOKEN");
  if (configured) return configured;
  return isProductionProfile() ? "" : LOCAL_SITE_INTERNAL_TOKEN;
}

function controlPlaneUrl(path: string) {
  const baseUrl = envString("REND_API_BASE_URL", DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  return `${baseUrl}${path}`;
}

function safeString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function normalizePlaybackBaseUrl(value: string) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("playback base URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("playback base URL must not include credentials, query, or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function allowedPlaybackBaseUrls() {
  return envString("REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizePlaybackBaseUrl);
}

function playbackBaseOverride(request: Request) {
  const requestUrl = new URL(request.url);
  const requested = requestUrl.searchParams.get("playbackBaseUrl");
  if (requested) {
    const normalized = normalizePlaybackBaseUrl(requested);
    if (!allowedPlaybackBaseUrls().includes(normalized)) {
      throw new Error("playbackBaseUrl is not allowed");
    }
    return normalized;
  }

  const configured = envString("REND_PLAYER_PLAYBACK_BASE_URL");
  return configured ? normalizePlaybackBaseUrl(configured) : null;
}

function normalizeAssetId(value: string) {
  const assetId = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(assetId)
    ? assetId
    : null;
}

async function assetOrganizationId(assetId: string) {
  const [row] = await getSiteDb()
    .select({ organizationId: assets.organization_id })
    .from(assets)
    .innerJoin(organization, eq(organization.id, assets.organization_id))
    .where(
      and(
        eq(assets.id, assetId),
        isNull(assets.deleted_at),
        isNull(assets.suspended_at),
        isNull(organization.suspended_at)
      )
    )
    .limit(1);
  return row?.organizationId ?? null;
}

async function fetchControlPlane(path: string, organizationId: string, internalToken: string) {
  return fetch(controlPlaneUrl(path), {
    cache: "no-store",
    headers: {
      "x-rend-site-token": internalToken,
      "x-rend-organization-id": organizationId,
      accept: "application/json",
    },
  });
}

async function notPlayableOrUnavailable(assetId: string, organizationId: string, internalToken: string) {
  const assetResponse = await fetchControlPlane(
    `/v1/assets/${encodeURIComponent(assetId)}`,
    organizationId,
    internalToken
  ).catch(() => null);

  if (!assetResponse?.ok) {
    return jsonResponse(
      {
        status: "unavailable",
        asset_id: assetId,
        message: "Asset is unavailable",
      },
      { status: 404 }
    );
  }

  const asset = (await assetResponse.json().catch(() => ({}))) as UpstreamAssetResponse;
  return jsonResponse(
    {
      status: "not_playable",
      asset_id: safeString(asset.asset_id) ?? assetId,
      source_state: safeString(asset.source_state),
      playable_state: safeString(asset.playable_state),
      message: "Asset is not playable yet",
    },
    { status: 409 }
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await context.params;
  const normalizedAssetId = normalizeAssetId(assetId || "");
  if (!normalizedAssetId) {
    return jsonResponse(
      {
        status: "unavailable",
        asset_id: assetId || "",
        message: "Asset is unavailable",
      },
      { status: 404 }
    );
  }

  const internalToken = siteInternalToken();
  if (!internalToken) {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback is not configured",
      },
      { status: 500 }
    );
  }

  const organizationId = await assetOrganizationId(normalizedAssetId).catch(() => null);
  if (!organizationId) {
    return jsonResponse(
      {
        status: "unavailable",
        asset_id: normalizedAssetId,
        message: "Asset is unavailable",
      },
      { status: 404 }
    );
  }

  let playbackBaseUrl: string | null;
  try {
    playbackBaseUrl = playbackBaseOverride(request);
  } catch {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback edge is not configured",
      },
      { status: 400 }
    );
  }

  const upstream = await fetchControlPlane(
    `/v1/assets/${encodeURIComponent(normalizedAssetId)}/playback`,
    organizationId,
    internalToken
  ).catch(() => null);

  if (!upstream) {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback bootstrap failed",
      },
      { status: 502 }
    );
  }

  if (upstream.status === 404) {
    return notPlayableOrUnavailable(normalizedAssetId, organizationId, internalToken);
  }

  if (!upstream.ok) {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback bootstrap failed",
      },
      { status: 502 }
    );
  }

  const data = (await upstream.json().catch(() => null)) as UpstreamPlaybackResponse | null;
  const safeResponse = data ? safePlaybackBootstrapResponse(normalizedAssetId, data, playbackBaseUrl) : null;

  if (!safeResponse) {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback bootstrap failed",
      },
      { status: 502 }
    );
  }

  const headers = new Headers();
  const playbackCookie = playbackProxyCookieHeader(
    request.url,
    normalizedAssetId,
    data?.playback_token,
    safeResponse.ttl_seconds
  );
  if (playbackCookie) headers.append("set-cookie", playbackCookie);

  return jsonResponse(safeResponse, { headers });
}
