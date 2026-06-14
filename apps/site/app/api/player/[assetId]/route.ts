export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { and, eq, isNull } from "drizzle-orm";
import { assets } from "../../../../lib/db/schema.ts";
import { getSiteDb } from "../../../../lib/server-db.ts";

type UpstreamPlaybackResponse = {
  asset_id?: unknown;
  source_state?: unknown;
  playable_state?: unknown;
  playback_url?: unknown;
  playback_content_type?: unknown;
  playback_token_expires_at?: unknown;
  ttl_seconds?: unknown;
  opener_url?: unknown;
  opener_content_type?: unknown;
  manifest_url?: unknown;
  manifest_content_type?: unknown;
  prefetch_hints?: unknown;
};

type UpstreamAssetResponse = {
  asset_id?: unknown;
  source_state?: unknown;
  playable_state?: unknown;
};

const DEFAULT_API_BASE_URL = "http://127.0.0.1:4000";
const LOCAL_SITE_INTERNAL_TOKEN = "local-site-internal-token";
const MAX_PREFETCH_HINTS = 4;

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

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeArtifactPath(value: string | undefined) {
  if (!value || value.includes("\\") || value.includes("..")) return undefined;
  if (value === "opener.mp4" || value === "hls/master.m3u8") return value;
  const segment = value.startsWith("hls/") ? value.slice("hls/".length) : "";
  return /^segment_[0-9]+\.ts$/.test(segment) ? value : undefined;
}

function artifactPathFromPlaybackUrl(value: unknown, assetId: string) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
  if (parsed.username || parsed.password) return undefined;
  const prefix = `/v/${assetId}/`;
  if (!parsed.pathname.startsWith(prefix)) return undefined;
  const artifactPath = parsed.pathname.slice(prefix.length);
  return safeArtifactPath(artifactPath);
}

function encodeArtifactPath(artifactPath: string) {
  return artifactPath.split("/").map(encodeURIComponent).join("/");
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

function proxiedArtifactUrl(assetId: string, artifactPath: string, playbackBaseUrl: string | null) {
  const path = `/api/player/${encodeURIComponent(assetId)}/artifact/${encodeArtifactPath(artifactPath)}`;
  return playbackBaseUrl ? `${path}?playbackBaseUrl=${encodeURIComponent(playbackBaseUrl)}` : path;
}

function safePlaybackResponse(
  assetId: string,
  data: UpstreamPlaybackResponse,
  playbackBaseUrl: string | null
) {
  const playbackPath = artifactPathFromPlaybackUrl(data.playback_url, assetId);
  const openerPath = artifactPathFromPlaybackUrl(data.opener_url, assetId);
  const manifestPath = artifactPathFromPlaybackUrl(data.manifest_url, assetId);
  const playbackUrl = playbackPath ? proxiedArtifactUrl(assetId, playbackPath, playbackBaseUrl) : undefined;
  const openerUrl = openerPath ? proxiedArtifactUrl(assetId, openerPath, playbackBaseUrl) : undefined;
  const manifestUrl = manifestPath ? proxiedArtifactUrl(assetId, manifestPath, playbackBaseUrl) : undefined;
  const expiresAt = safeNumber(data.playback_token_expires_at);
  const ttlSeconds = safeNumber(data.ttl_seconds);

  if (!expiresAt || !ttlSeconds || (!playbackUrl && !openerUrl && !manifestUrl)) {
    return null;
  }

  const hints = Array.isArray(data.prefetch_hints)
    ? data.prefetch_hints.slice(0, MAX_PREFETCH_HINTS).flatMap((hint) => {
        if (!hint || typeof hint !== "object") return [];
        const record = hint as Record<string, unknown>;
        const artifactPath = safeArtifactPath(safeString(record.artifact_path));
        const contentType = safeString(record.content_type);
        if (!artifactPath || !contentType) return [];
        return [
          {
            artifact_path: artifactPath,
            url: proxiedArtifactUrl(assetId, artifactPath, playbackBaseUrl),
            content_type: contentType,
          },
        ];
      })
    : [];

  return {
    status: "ready",
    asset_id: safeString(data.asset_id) ?? assetId,
    source_state: safeString(data.source_state) ?? "unknown",
    playable_state: safeString(data.playable_state) ?? "unknown",
    playback_url: playbackUrl,
    playback_content_type: safeString(data.playback_content_type),
    playback_token_expires_at: expiresAt,
    ttl_seconds: ttlSeconds,
    opener_url: openerUrl,
    opener_content_type: safeString(data.opener_content_type),
    manifest_url: manifestUrl,
    manifest_content_type: safeString(data.manifest_content_type),
    prefetch_hints: hints,
  };
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
    .where(and(eq(assets.id, assetId), isNull(assets.deleted_at)))
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
  const safeResponse = data ? safePlaybackResponse(normalizedAssetId, data, playbackBaseUrl) : null;

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

  return jsonResponse(safeResponse);
}
