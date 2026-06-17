import type { safePlaybackBootstrapResponse } from "./player-bootstrap.ts";

export const PLAYBACK_BOOTSTRAP_CACHE_TTL_MS = 15_000;
export const PLAYBACK_BOOTSTRAP_CACHE_MAX_ENTRIES = 256;

export type SafePlaybackBootstrapResponse = NonNullable<ReturnType<typeof safePlaybackBootstrapResponse>>;

export type CachedPlaybackBootstrap = {
  cachedAtMs: number;
  directCookieDomain?: string;
  directPlaybackEnabled: boolean;
  playbackBaseUrl: string | null;
  playbackToken: string;
  safeResponse: SafePlaybackBootstrapResponse;
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

  const remainingTtl = Math.floor(cached.safeResponse.playback_token_expires_at - nowMs / 1000);
  if (nowMs - cached.cachedAtMs > PLAYBACK_BOOTSTRAP_CACHE_TTL_MS || remainingTtl <= 5) {
    playbackBootstrapCache.delete(cacheKey);
    return null;
  }

  return {
    ...cached,
    safeResponse: {
      ...cached.safeResponse,
      ttl_seconds: Math.min(cached.safeResponse.ttl_seconds, remainingTtl),
    },
  };
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
