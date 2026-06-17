import assert from "node:assert/strict";
import test from "node:test";
import {
  cachedBootstrapResponse,
  cacheKeyForPlaybackBootstrap,
  clearPlaybackBootstrapCache,
  rememberBootstrapResponse,
  type SafePlaybackBootstrapResponse,
} from "./player-bootstrap-cache.ts";

const ASSET_ID = "00000000-0000-0000-0000-000000000001";

function safeResponse(expiresAt: number, ttlSeconds: number): SafePlaybackBootstrapResponse {
  return {
    status: "ready",
    asset_id: ASSET_ID,
    source_state: "uploaded",
    playable_state: "hls_ready",
    playback_url: "https://ams-1.play.rend.so/v/00000000-0000-0000-0000-000000000001/hls/master.m3u8",
    playback_content_type: "application/vnd.apple.mpegurl",
    playback_token_expires_at: expiresAt,
    ttl_seconds: ttlSeconds,
    opener_url: undefined,
    opener_content_type: undefined,
    manifest_url: "https://ams-1.play.rend.so/v/00000000-0000-0000-0000-000000000001/hls/master.m3u8",
    manifest_content_type: "application/vnd.apple.mpegurl",
    poster_url: undefined,
    poster_content_type: undefined,
    prefetch_hints: [],
  };
}

test("playback bootstrap cache keys isolate proxy origins but reuse direct edge playback", () => {
  const edgeBaseUrl = "https://ams-1.play.rend.so";
  const wwwDirect = cacheKeyForPlaybackBootstrap(
    ASSET_ID,
    edgeBaseUrl,
    true,
    "rend.so",
    new Request(`https://www.rend.so/api/player/${ASSET_ID}`)
  );
  const previewDirect = cacheKeyForPlaybackBootstrap(
    ASSET_ID,
    edgeBaseUrl,
    true,
    "rend.so",
    new Request(`https://preview.rend.so/api/player/${ASSET_ID}`)
  );
  const localhostProxy = cacheKeyForPlaybackBootstrap(
    ASSET_ID,
    edgeBaseUrl,
    false,
    undefined,
    new Request(`http://127.0.0.1:3000/api/player/${ASSET_ID}`)
  );
  const siteProxy = cacheKeyForPlaybackBootstrap(
    ASSET_ID,
    edgeBaseUrl,
    false,
    undefined,
    new Request(`https://www.rend.so/api/player/${ASSET_ID}`)
  );

  assert.equal(wwwDirect, previewDirect);
  assert.notEqual(localhostProxy, siteProxy);
  assert.notEqual(wwwDirect, siteProxy);
});

test("playback bootstrap cache shortens returned ttl and expires near token expiry", () => {
  clearPlaybackBootstrapCache();
  const cacheKey = "asset|edge|direct|rend.so|";
  rememberBootstrapResponse(cacheKey, {
    cachedAtMs: 10_000,
    directCookieDomain: "rend.so",
    directPlaybackEnabled: true,
    playbackBaseUrl: "https://ams-1.play.rend.so",
    playbackToken: "v1.claims.signature",
    safeResponse: safeResponse(31, 60),
  });

  const hit = cachedBootstrapResponse(cacheKey, 20_000);
  assert.equal(hit?.safeResponse.ttl_seconds, 11);
  assert.equal(hit?.playbackToken, "v1.claims.signature");

  assert.equal(cachedBootstrapResponse(cacheKey, 26_000), null);
});

test("playback bootstrap cache drops entries after the short cache window", () => {
  clearPlaybackBootstrapCache();
  const cacheKey = "asset|edge|direct|rend.so|";
  rememberBootstrapResponse(cacheKey, {
    cachedAtMs: 1_000,
    directPlaybackEnabled: true,
    playbackBaseUrl: "https://ams-1.play.rend.so",
    playbackToken: "v1.claims.signature",
    safeResponse: safeResponse(120, 60),
  });

  assert.equal(cachedBootstrapResponse(cacheKey, 17_000), null);
});
