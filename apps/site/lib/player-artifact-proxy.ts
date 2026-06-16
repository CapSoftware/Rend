const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "x-rend-cache",
  "x-rend-edge",
  "x-rend-edge-id",
  "x-rend-region",
] as const;

export const PLAYBACK_COOKIE_NAME = "__rend_playback";

type ArtifactResponseHeaderOptions = {
  artifactPath?: string;
  cacheable?: boolean;
  contentType?: string;
  rewrittenBody?: string;
};

const PRIVATE_IMMUTABLE_MEDIA_CACHE_CONTROL = "private, max-age=31536000, immutable";
const PRIVATE_MANIFEST_CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=300";
const HLS_VARIANT_MANIFEST_PATH_RE = /^hls\/(?:720p|1080p|2k|4k)\/index\.m3u8$/;

export function isHlsManifestArtifactPath(artifactPath: string | undefined) {
  return artifactPath === "hls/master.m3u8" || HLS_VARIANT_MANIFEST_PATH_RE.test(artifactPath ?? "");
}

function safeCookieValue(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  return /^[a-zA-Z0-9._~-]+$/.test(value) ? value : undefined;
}

export function playbackCookieFromHeaders(requestHeaders: Headers) {
  const cookieHeader = requestHeaders.get("cookie");
  if (!cookieHeader) return undefined;

  for (const cookie of cookieHeader.split(";")) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex === -1) continue;
    const name = cookie.slice(0, separatorIndex).trim();
    if (name !== PLAYBACK_COOKIE_NAME) continue;
    return safeCookieValue(cookie.slice(separatorIndex + 1).trim());
  }

  return undefined;
}

export function playbackCookieFromSetCookieHeader(setCookieHeader: string | null | undefined) {
  if (!setCookieHeader) return undefined;
  const match = setCookieHeader.match(new RegExp(`(?:^|,\\s*)${PLAYBACK_COOKIE_NAME}=([^;,\\s]+)`));
  return safeCookieValue(match?.[1]);
}

export function playbackCookieFromSetCookieHeaders(headers: Headers) {
  const values =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [
      headers.get("set-cookie"),
    ];

  for (const value of values) {
    const cookie = playbackCookieFromSetCookieHeader(value);
    if (cookie) return cookie;
  }

  return undefined;
}

export function playbackProxyCookieHeader(
  requestUrl: string,
  assetId: string,
  playbackToken: unknown,
  ttlSeconds: unknown
) {
  const token = safeCookieValue(playbackToken);
  const maxAge = typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds)
    ? Math.max(0, Math.floor(ttlSeconds))
    : 0;
  if (!token || maxAge <= 0) return undefined;

  const url = new URL(requestUrl);
  const isSecure = url.protocol === "https:";
  const path = `/api/player/${encodeURIComponent(assetId)}/artifact/`;
  const parts = [
    `${PLAYBACK_COOKIE_NAME}=${token}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    `SameSite=${isSecure ? "None" : "Lax"}`,
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

export function playbackDirectCookieHeader(
  requestUrl: string,
  assetId: string,
  playbackToken: unknown,
  ttlSeconds: unknown,
  playbackBaseUrl: string,
  cookieDomain?: string
) {
  const token = safeCookieValue(playbackToken);
  const maxAge = typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds)
    ? Math.max(0, Math.floor(ttlSeconds))
    : 0;
  if (!token || maxAge <= 0) return undefined;

  const request = new URL(requestUrl);
  const playbackBase = new URL(playbackBaseUrl);
  const isSecure = request.protocol === "https:" || playbackBase.protocol === "https:";
  const path = `/v/${encodeURIComponent(assetId)}/`;
  const parts = [
    `${PLAYBACK_COOKIE_NAME}=${token}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    `SameSite=${isSecure ? "None" : "Lax"}`,
  ];
  if (cookieDomain) parts.push(`Domain=${cookieDomain}`);
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

export function playbackArtifactFetchHeaders(
  requestHeaders: Headers,
  cookie: string | undefined,
  artifactPath: string
) {
  const headers = new Headers();
  const range = requestHeaders.get("range");
  if (range && !isHlsManifestArtifactPath(artifactPath)) headers.set("range", range);
  if (cookie) headers.set("cookie", `${PLAYBACK_COOKIE_NAME}=${cookie}`);
  return headers;
}

export function playbackArtifactResponseHeaders(source: Headers, options: ArtifactResponseHeaderOptions = {}) {
  const headers = new Headers();
  headers.set("cache-control", playbackArtifactCacheControl(options.artifactPath, options.cacheable));

  const isRewrittenBody = options.rewrittenBody !== undefined;
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    if (isRewrittenBody && (name === "accept-ranges" || name === "content-length" || name === "content-range")) {
      continue;
    }

    const value = source.get(name);
    if (value) headers.set(name, value);
  }

  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.rewrittenBody !== undefined) {
    headers.set("content-length", String(new TextEncoder().encode(options.rewrittenBody).byteLength));
  }

  return headers;
}

export function playbackArtifactCacheControl(artifactPath: string | undefined, cacheable = true) {
  if (!cacheable) return "no-store";
  if (artifactPath === "opener.mp4") return PRIVATE_IMMUTABLE_MEDIA_CACHE_CONTROL;
  if (isHlsManifestArtifactPath(artifactPath)) return PRIVATE_MANIFEST_CACHE_CONTROL;
  if (artifactPath?.startsWith("hls/")) return PRIVATE_IMMUTABLE_MEDIA_CACHE_CONTROL;
  return "no-store";
}
