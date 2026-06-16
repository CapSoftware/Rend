export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { and, eq, isNull } from "drizzle-orm";
import { assets, organization } from "../../../../../../lib/db/schema.ts";
import {
  PLAYBACK_COOKIE_NAME,
  playbackCookieFromHeaders,
  playbackArtifactFetchHeaders,
  playbackArtifactResponseHeaders,
  playbackProxyCookieHeader,
} from "../../../../../../lib/player-artifact-proxy.ts";
import { getSiteDb } from "../../../../../../lib/server-db.ts";

type UpstreamPlaybackResponse = {
  playback_url?: unknown;
  opener_url?: unknown;
  manifest_url?: unknown;
  prefetch_hints?: unknown;
  playback_token?: unknown;
  ttl_seconds?: unknown;
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

function normalizeAssetId(value: string) {
  const assetId = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(assetId)
    ? assetId
    : null;
}

function safeArtifactPath(value: string | undefined) {
  if (!value || value.includes("\\") || value.includes("..")) return undefined;
  if (value === "opener.mp4" || value === "hls/master.m3u8") return value;
  const segment = value.startsWith("hls/") ? value.slice("hls/".length) : "";
  return /^segment_[0-9]+\.ts$/.test(segment) ? value : undefined;
}

function artifactPathFromParams(value: string[] | undefined) {
  return safeArtifactPath((value ?? []).join("/"));
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

function encodeArtifactPath(artifactPath: string) {
  return artifactPath.split("/").map(encodeURIComponent).join("/");
}

function proxiedArtifactUrl(assetId: string, artifactPath: string, playbackBaseUrl: string | null) {
  const path = `/api/player/${encodeURIComponent(assetId)}/artifact/${encodeArtifactPath(artifactPath)}`;
  return playbackBaseUrl ? `${path}?playbackBaseUrl=${encodeURIComponent(playbackBaseUrl)}` : path;
}

function playbackCookie(setCookie: string | null) {
  const match = setCookie?.match(new RegExp(`(?:^|,\\s*)${PLAYBACK_COOKIE_NAME}=([^;,\\s]+)`));
  return match?.[1];
}

function safePlaybackUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function artifactPathFromEdgeUrl(value: URL, assetId: string) {
  const prefix = `/v/${assetId}/`;
  if (!value.pathname.startsWith(prefix)) return undefined;
  return safeArtifactPath(value.pathname.slice(prefix.length));
}

function rewritePlaybackBase(value: URL, playbackBaseUrl: string | null) {
  if (!playbackBaseUrl) return value.toString();
  const base = new URL(playbackBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}${value.pathname}`;
  base.search = value.search;
  base.hash = "";
  return base.toString();
}

function directArtifactUrl(assetId: string, artifactPath: string, playbackBaseUrl: string) {
  const base = new URL(playbackBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}/v/${encodeURIComponent(assetId)}/${encodeArtifactPath(artifactPath)}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function targetUrlForArtifact(
  data: UpstreamPlaybackResponse,
  assetId: string,
  artifactPath: string,
  playbackBaseUrl: string | null
) {
  const candidates = [data.playback_url, data.opener_url, data.manifest_url].flatMap((value) => {
    const url = safePlaybackUrl(value);
    return url ? [url] : [];
  });

  for (const candidate of candidates) {
    if (artifactPathFromEdgeUrl(candidate, assetId) === artifactPath) {
      return rewritePlaybackBase(candidate, playbackBaseUrl);
    }
  }

  for (const hint of Array.isArray(data.prefetch_hints) ? data.prefetch_hints : []) {
    if (!hint || typeof hint !== "object") continue;
    const record = hint as Record<string, unknown>;
    if (safeArtifactPath(typeof record.artifact_path === "string" ? record.artifact_path : undefined) !== artifactPath) {
      continue;
    }
    const url = safePlaybackUrl(record.url);
    if (url && artifactPathFromEdgeUrl(url, assetId) === artifactPath) {
      return rewritePlaybackBase(url, playbackBaseUrl);
    }
  }

  const manifest = candidates.find((candidate) => artifactPathFromEdgeUrl(candidate, assetId) === "hls/master.m3u8");
  if (!manifest || !artifactPath.startsWith("hls/")) return undefined;
  manifest.pathname = `/v/${assetId}/${artifactPath}`;
  return rewritePlaybackBase(manifest, playbackBaseUrl);
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

async function fetchPlaybackBootstrap(assetId: string, organizationId: string, internalToken: string) {
  const response = await fetch(controlPlaneUrl(`/v1/assets/${encodeURIComponent(assetId)}/playback`), {
    cache: "no-store",
    headers: {
      "x-rend-site-token": internalToken,
      "x-rend-organization-id": organizationId,
      accept: "application/json",
    },
  });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as UpstreamPlaybackResponse | null;
  if (!data || typeof data !== "object") return null;
  return {
    cookie: playbackCookie(response.headers.get("set-cookie")),
    data,
  };
}

function rewriteManifest(manifest: string, assetId: string, manifestUrl: string, playbackBaseUrl: string | null) {
  const baseUrl = new URL(manifestUrl);
  return manifest
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      try {
        const artifactUrl = new URL(trimmed, baseUrl);
        const artifactPath = artifactPathFromEdgeUrl(artifactUrl, assetId);
        return artifactPath ? proxiedArtifactUrl(assetId, artifactPath, playbackBaseUrl) : line;
      } catch {
        return line;
      }
    })
    .join("\n");
}

async function artifactResponseFromEdge(
  edgeResponse: Response,
  assetId: string,
  artifactPath: string,
  targetUrl: string,
  playbackBaseUrl: string | null,
  setCookie?: string
) {
  if (artifactPath === "hls/master.m3u8" && edgeResponse.ok) {
    const manifest = await edgeResponse.text().catch(() => "");
    const rewrittenManifest = rewriteManifest(manifest, assetId, targetUrl, playbackBaseUrl);
    const headers = playbackArtifactResponseHeaders(edgeResponse.headers, {
      contentType: "application/vnd.apple.mpegurl",
      rewrittenBody: rewrittenManifest,
    });
    if (setCookie) headers.append("set-cookie", setCookie);
    return new Response(rewrittenManifest, {
      status: edgeResponse.status,
      headers,
    });
  }

  const headers = playbackArtifactResponseHeaders(edgeResponse.headers);
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(edgeResponse.body, {
    status: edgeResponse.status,
    headers,
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string; artifactPath?: string[] }> }
) {
  const { assetId, artifactPath } = await context.params;
  const normalizedAssetId = normalizeAssetId(assetId || "");
  const normalizedArtifactPath = artifactPathFromParams(artifactPath);
  if (!normalizedAssetId || !normalizedArtifactPath) {
    return jsonResponse({ status: "unavailable", message: "Artifact is unavailable" }, { status: 404 });
  }

  let playbackBaseUrl: string | null;
  try {
    playbackBaseUrl = playbackBaseOverride(request);
  } catch {
    return jsonResponse({ status: "error", message: "Playback edge is not configured" }, { status: 400 });
  }

  const playbackCookie = playbackCookieFromHeaders(request.headers);
  if (playbackCookie && playbackBaseUrl) {
    const targetUrl = directArtifactUrl(normalizedAssetId, normalizedArtifactPath, playbackBaseUrl);
    const edgeResponse = await fetch(targetUrl, {
      cache: "no-store",
      headers: playbackArtifactFetchHeaders(request.headers, playbackCookie, normalizedArtifactPath),
    }).catch(() => null);

    if (edgeResponse && edgeResponse.status !== 401 && edgeResponse.status !== 403) {
      return artifactResponseFromEdge(
        edgeResponse,
        normalizedAssetId,
        normalizedArtifactPath,
        targetUrl,
        playbackBaseUrl
      );
    }
  }

  const internalToken = siteInternalToken();
  if (!internalToken) {
    return jsonResponse({ status: "error", message: "Playback is not configured" }, { status: 500 });
  }

  const organizationId = await assetOrganizationId(normalizedAssetId).catch(() => null);
  if (!organizationId) {
    return jsonResponse({ status: "unavailable", message: "Artifact is unavailable" }, { status: 404 });
  }

  const bootstrap = await fetchPlaybackBootstrap(normalizedAssetId, organizationId, internalToken).catch(() => null);
  const targetUrl = bootstrap
    ? targetUrlForArtifact(bootstrap.data, normalizedAssetId, normalizedArtifactPath, playbackBaseUrl)
    : undefined;
  if (!bootstrap || !targetUrl) {
    return jsonResponse({ status: "unavailable", message: "Artifact is unavailable" }, { status: 404 });
  }

  const edgeResponse = await fetch(targetUrl, {
    cache: "no-store",
    headers: playbackArtifactFetchHeaders(request.headers, bootstrap.cookie, normalizedArtifactPath),
  }).catch(() => null);
  if (!edgeResponse) {
    return jsonResponse({ status: "error", message: "Artifact fetch failed" }, { status: 502 });
  }

  return artifactResponseFromEdge(
    edgeResponse,
    normalizedAssetId,
    normalizedArtifactPath,
    targetUrl,
    playbackBaseUrl,
    playbackProxyCookieHeader(
      request.url,
      normalizedAssetId,
      bootstrap.data.playback_token,
      bootstrap.data.ttl_seconds
    )
  );
}
