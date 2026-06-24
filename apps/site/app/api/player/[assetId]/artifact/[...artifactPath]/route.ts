export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { cachedBootstrapForArtifactRequest } from "../../../../../../lib/player-bootstrap-cache.ts";
import {
  isHlsManifestArtifactPath,
  playbackCookieFromHeaders,
  playbackArtifactFetchHeaders,
  playbackArtifactResponseHeaders,
  playbackProxyCookieHeader,
} from "../../../../../../lib/player-artifact-proxy.ts";

type UpstreamPlaybackResponse = {
  playback_url?: unknown;
  opener_url?: unknown;
  manifest_url?: unknown;
  poster_url?: unknown;
  thumbnail_url?: unknown;
  prefetch_hints?: unknown;
  playback_token?: unknown;
  ttl_seconds?: unknown;
};

type PlaybackBaseDecision = {
  linkPlaybackBaseUrl: string | null;
  playbackBaseUrl: string | null;
};

const HLS_RENDITION_NAMES = new Set(["720p", "1080p", "2k", "4k"]);

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function normalizeAssetId(value: string) {
  const assetId = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(assetId)
    ? assetId
    : null;
}

function safeArtifactPath(value: string | undefined) {
  if (!value || value.includes("\\") || value.includes("..")) return undefined;
  if (value === "opener.mp4" || value === "thumbnail.jpg" || value === "hls/master.m3u8") return value;
  const parts = value.split("/");
  if (parts.length === 2 && parts[0] === "hls" && /^segment_[0-9]+\.ts$/.test(parts[1] ?? "")) {
    return value;
  }
  if (parts.length === 3 && parts[0] === "hls" && HLS_RENDITION_NAMES.has(parts[1] ?? "")) {
    if (parts[2] === "index.m3u8" || /^segment_[0-9]+\.ts$/.test(parts[2] ?? "")) return value;
  }
  return undefined;
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

function playbackBaseDecision(request: Request): PlaybackBaseDecision {
  const requestUrl = new URL(request.url);
  const requested = requestUrl.searchParams.get("playbackBaseUrl");
  if (requested) {
    const normalized = normalizePlaybackBaseUrl(requested);
    if (!allowedPlaybackBaseUrls().includes(normalized)) {
      throw new Error("playbackBaseUrl is not allowed");
    }
    return {
      linkPlaybackBaseUrl: normalized,
      playbackBaseUrl: normalized,
    };
  }

  const configured = envString("REND_PLAYER_PLAYBACK_BASE_URL");
  return {
    linkPlaybackBaseUrl: null,
    playbackBaseUrl: configured ? normalizePlaybackBaseUrl(configured) : null,
  };
}

function encodeArtifactPath(artifactPath: string) {
  return artifactPath.split("/").map(encodeURIComponent).join("/");
}

function proxiedArtifactUrl(assetId: string, artifactPath: string, playbackBaseUrl: string | null) {
  const path = `/api/player/${encodeURIComponent(assetId)}/artifact/${encodeArtifactPath(artifactPath)}`;
  return playbackBaseUrl ? `${path}?playbackBaseUrl=${encodeURIComponent(playbackBaseUrl)}` : path;
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
  const candidates = [
    data.playback_url,
    data.opener_url,
    data.manifest_url,
    data.poster_url,
    data.thumbnail_url,
  ].flatMap((value) => {
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
  if (isHlsManifestArtifactPath(artifactPath) && edgeResponse.ok) {
    const manifest = await edgeResponse.text().catch(() => "");
    const rewrittenManifest = rewriteManifest(manifest, assetId, targetUrl, playbackBaseUrl);
    const headers = playbackArtifactResponseHeaders(edgeResponse.headers, {
      artifactPath,
      cacheable: edgeResponse.ok,
      contentType: "application/vnd.apple.mpegurl",
      rewrittenBody: rewrittenManifest,
    });
    if (setCookie) headers.append("set-cookie", setCookie);
    return new Response(rewrittenManifest, {
      status: edgeResponse.status,
      headers,
    });
  }

  const headers = playbackArtifactResponseHeaders(edgeResponse.headers, {
    artifactPath,
    cacheable: edgeResponse.ok,
  });
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

  let linkPlaybackBaseUrl: string | null;
  let playbackBaseUrl: string | null;
  try {
    const decision = playbackBaseDecision(request);
    linkPlaybackBaseUrl = decision.linkPlaybackBaseUrl;
    playbackBaseUrl = decision.playbackBaseUrl;
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
        linkPlaybackBaseUrl
      );
    }
  }

  const bootstrap = cachedBootstrapForArtifactRequest(normalizedAssetId, request);
  const targetUrl = bootstrap
    ? targetUrlForArtifact(bootstrap.upstreamResponse, normalizedAssetId, normalizedArtifactPath, playbackBaseUrl)
    : undefined;
  if (!bootstrap || !targetUrl) {
    return jsonResponse({ status: "unavailable", message: "Artifact is unavailable" }, { status: 404 });
  }

  const edgeResponse = await fetch(targetUrl, {
    cache: "no-store",
    headers: playbackArtifactFetchHeaders(request.headers, bootstrap.playbackToken, normalizedArtifactPath),
  }).catch(() => null);
  if (!edgeResponse) {
    return jsonResponse({ status: "error", message: "Artifact fetch failed" }, { status: 502 });
  }

  return artifactResponseFromEdge(
    edgeResponse,
    normalizedAssetId,
    normalizedArtifactPath,
    targetUrl,
    linkPlaybackBaseUrl,
    playbackProxyCookieHeader(
      request.url,
      normalizedAssetId,
      bootstrap.playbackToken,
      bootstrap.safeResponse.ttl_seconds
    )
  );
}
