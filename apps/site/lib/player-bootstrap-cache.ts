import type { safePlaybackBootstrapResponse, UpstreamPlaybackResponse } from "./player-bootstrap.ts";
import type { CloudFrontAuthorizationCookies } from "./player-artifact-proxy.ts";

export const PLAYBACK_BOOTSTRAP_CACHE_TTL_MS = 15_000;
export const PLAYBACK_ARTIFACT_CONTEXT_TTL_MS = 15 * 60_000;
export const PLAYBACK_BOOTSTRAP_CACHE_MAX_ENTRIES = 256;

export type SafePlaybackBootstrapResponse = NonNullable<ReturnType<typeof safePlaybackBootstrapResponse>>;

export type CachedPlaybackBootstrap = {
  assetId?: string;
  cachedAtMs: number;
  cloudFrontAuthorizationCookies?: CloudFrontAuthorizationCookies;
  directCookieDomain?: string;
  directPlaybackEnabled: boolean;
  organizationId?: string;
  playbackBaseUrl: string | null;
  playbackToken: string;
  requestOrigin?: string;
  safeResponse: SafePlaybackBootstrapResponse;
  upstreamResponse?: UpstreamPlaybackResponse;
};

const playbackBootstrapCache = new Map<string, CachedPlaybackBootstrap>();

export function cacheKeyForPlaybackBootstrap(
  assetId: string,
  playbackBaseUrl: string | null,
  directPlaybackEnabled: boolean,
  directCookieDomain: string | undefined,
  request: Request
) {
  const requestOrigin = new URL(request.url).origin.toLowerCase();
  return [
    assetId,
    playbackBaseUrl ?? "proxy",
    directPlaybackEnabled ? "direct" : "proxy",
    directCookieDomain ?? "",
    directPlaybackEnabled ? "" : requestOrigin,
  ].join("|");
}

export function cachedBootstrapResponse(cacheKey: string, nowMs = Date.now()) {
  const cached = playbackBootstrapCache.get(cacheKey);
  if (!cached) return null;

  if (nowMs - cached.cachedAtMs > PLAYBACK_BOOTSTRAP_CACHE_TTL_MS) {
    playbackBootstrapCache.delete(cacheKey);
    return null;
  }

  const fresh = cachedWithAdjustedTtl(cached, nowMs);
  if (!fresh) playbackBootstrapCache.delete(cacheKey);
  return fresh;
}

function cachedWithAdjustedTtl(cached: CachedPlaybackBootstrap, nowMs: number) {
  const remainingTtl = Math.floor(cached.safeResponse.playback_token_expires_at - nowMs / 1000);
  if (remainingTtl <= 5) return null;

  return {
    ...cached,
    safeResponse: {
      ...cached.safeResponse,
      ttl_seconds: Math.min(cached.safeResponse.ttl_seconds, remainingTtl),
    },
  };
}

export function cachedBootstrapForArtifactRequest(assetId: string, request: Request, nowMs = Date.now()) {
  const requestOrigin = new URL(request.url).origin.toLowerCase();

  for (const [cacheKey, cached] of playbackBootstrapCache.entries()) {
    const cachedAssetId = cached.assetId ?? cached.safeResponse.asset_id;
    if (cachedAssetId !== assetId || !cached.upstreamResponse) continue;
    if (!cached.directPlaybackEnabled && cached.requestOrigin && cached.requestOrigin !== requestOrigin) {
      continue;
    }
    if (nowMs - cached.cachedAtMs > PLAYBACK_ARTIFACT_CONTEXT_TTL_MS) {
      playbackBootstrapCache.delete(cacheKey);
      continue;
    }

    const fresh = cachedWithAdjustedTtl(cached, nowMs);
    if (!fresh) {
      playbackBootstrapCache.delete(cacheKey);
      continue;
    }

    return {
      ...fresh,
      upstreamResponse: cached.upstreamResponse,
    };
  }

  return null;
}

export function rememberBootstrapResponse(cacheKey: string, value: CachedPlaybackBootstrap) {
  playbackBootstrapCache.set(cacheKey, value);
  if (playbackBootstrapCache.size <= PLAYBACK_BOOTSTRAP_CACHE_MAX_ENTRIES) return;

  const oldest = playbackBootstrapCache.keys().next().value;
  if (oldest) playbackBootstrapCache.delete(oldest);
}

export function clearPlaybackBootstrapCache() {
  playbackBootstrapCache.clear();
}
