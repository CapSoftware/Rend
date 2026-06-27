import assert from "node:assert/strict";
import test from "node:test";
import { GET as getPlaybackArtifact } from "./[assetId]/artifact/[...artifactPath]/route.ts";
import {
  clearPlaybackBootstrapCache,
  rememberBootstrapResponse,
  type SafePlaybackBootstrapResponse,
} from "../../../lib/player-bootstrap-cache.ts";

const ASSET_ID = "00000000-0000-0000-0000-000000000001";
const ORG_ID = "00000000-0000-0000-0000-000000000002";

function cachedSafeResponse(
  expiresAt: number,
  ttlSeconds: number,
): SafePlaybackBootstrapResponse {
  return {
    status: "ready",
    asset_id: ASSET_ID,
    organization_id: ORG_ID,
    source_state: "uploaded",
    playable_state: "hls_ready",
    playback_url:
      "/api/player/00000000-0000-0000-0000-000000000001/artifact/opener.mp4",
    playback_content_type: "video/mp4",
    playback_token_expires_at: expiresAt,
    ttl_seconds: ttlSeconds,
    opener_url:
      "/api/player/00000000-0000-0000-0000-000000000001/artifact/opener.mp4",
    opener_content_type: "video/mp4",
    manifest_url: undefined,
    manifest_content_type: undefined,
    poster_url: undefined,
    poster_content_type: undefined,
    prefetch_hints: [],
  };
}

test("artifact route uses playback cookie fast path when the edge base is known", async () => {
  const originalFetch = globalThis.fetch;
  const originalPlaybackMode = process.env.REND_PLAYBACK_MODE;
  const originalPlaybackBaseUrl = process.env.REND_PLAYER_PLAYBACK_BASE_URL;
  const fetches: Array<{ url: string; headers: Headers }> = [];
  process.env.REND_PLAYBACK_MODE = "edge";
  process.env.REND_PLAYER_PLAYBACK_BASE_URL = "https://edge.rend.so";

  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetches.push({
      url: String(url),
      headers: new Headers(init?.headers),
    });
    return new Response("opener", {
      status: 200,
      headers: {
        "content-length": "6",
        "content-type": "video/mp4",
        "x-rend-cache": "HIT",
      },
    });
  }) as typeof fetch;

  try {
    const response = await getPlaybackArtifact(
      new Request(
        `https://rend.so/api/player/${ASSET_ID}/artifact/opener.mp4`,
        {
          headers: {
            cookie: "__rend_playback=v1.claims.signature",
          },
        },
      ),
      {
        params: Promise.resolve({
          assetId: ASSET_ID,
          artifactPath: ["opener.mp4"],
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "opener");
    assert.equal(fetches.length, 1);
    assert.equal(
      fetches[0]?.url,
      `https://edge.rend.so/v/${ASSET_ID}/opener.mp4`,
    );
    assert.equal(
      fetches[0]?.headers.get("cookie"),
      "__rend_playback=v1.claims.signature",
    );
    assert.equal(response.headers.get("x-rend-cache"), "HIT");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPlaybackMode === undefined) {
      delete process.env.REND_PLAYBACK_MODE;
    } else {
      process.env.REND_PLAYBACK_MODE = originalPlaybackMode;
    }
    if (originalPlaybackBaseUrl === undefined) {
      delete process.env.REND_PLAYER_PLAYBACK_BASE_URL;
    } else {
      process.env.REND_PLAYER_PLAYBACK_BASE_URL = originalPlaybackBaseUrl;
    }
  }
});

test("artifact route rewrites variant playlist segment URLs", async () => {
  const originalFetch = globalThis.fetch;
  const originalPlaybackMode = process.env.REND_PLAYBACK_MODE;
  const originalPlaybackBaseUrl = process.env.REND_PLAYER_PLAYBACK_BASE_URL;
  const fetches: Array<{ url: string; headers: Headers }> = [];
  process.env.REND_PLAYBACK_MODE = "edge";
  process.env.REND_PLAYER_PLAYBACK_BASE_URL = "https://edge.rend.so";

  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetches.push({
      url: String(url),
      headers: new Headers(init?.headers),
    });
    return new Response("#EXTM3U\n#EXTINF:2.000000,\nsegment_00000.ts\n", {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl",
        "x-rend-cache": "HIT",
      },
    });
  }) as typeof fetch;

  try {
    const response = await getPlaybackArtifact(
      new Request(
        `https://rend.so/api/player/${ASSET_ID}/artifact/hls/720p/index.m3u8`,
        {
          headers: {
            cookie: "__rend_playback=v1.claims.signature",
          },
        },
      ),
      {
        params: Promise.resolve({
          assetId: ASSET_ID,
          artifactPath: ["hls", "720p", "index.m3u8"],
        }),
      },
    );

    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(
      fetches[0]?.url,
      `https://edge.rend.so/v/${ASSET_ID}/hls/720p/index.m3u8`,
    );
    assert.match(
      body,
      new RegExp(
        `/api/player/${ASSET_ID}/artifact/hls/720p/segment_00000\\.ts`,
      ),
    );
    assert.doesNotMatch(body, /playbackBaseUrl=/);
    assert.equal(
      response.headers.get("content-type"),
      "application/vnd.apple.mpegurl",
    );
    assert.equal(
      response.headers.get("cache-control"),
      "private, max-age=60, stale-while-revalidate=300",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPlaybackMode === undefined) {
      delete process.env.REND_PLAYBACK_MODE;
    } else {
      process.env.REND_PLAYBACK_MODE = originalPlaybackMode;
    }
    if (originalPlaybackBaseUrl === undefined) {
      delete process.env.REND_PLAYER_PLAYBACK_BASE_URL;
    } else {
      process.env.REND_PLAYER_PLAYBACK_BASE_URL = originalPlaybackBaseUrl;
    }
  }
});

test("artifact route uses Tigris origin with playback cookie when bootstrap cache is cold", async () => {
  const originalFetch = globalThis.fetch;
  const originalPlaybackMode = process.env.REND_PLAYBACK_MODE;
  const originalApiBaseUrl = process.env.REND_API_BASE_URL;
  const originalTigrisPlaybackBaseUrl =
    process.env.REND_TIGRIS_PLAYBACK_BASE_URL;
  const fetches: Array<{ url: string; headers: Headers }> = [];
  clearPlaybackBootstrapCache();
  process.env.REND_PLAYBACK_MODE = "tigris";
  process.env.REND_API_BASE_URL = "https://api.rend.so";
  delete process.env.REND_TIGRIS_PLAYBACK_BASE_URL;

  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetches.push({
      url: String(url),
      headers: new Headers(init?.headers),
    });
    return new Response("#EXTM3U\n#EXTINF:2.000000,\nsegment_00000.ts\n", {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl",
        "x-rend-origin": "tigris",
      },
    });
  }) as typeof fetch;

  try {
    const response = await getPlaybackArtifact(
      new Request(
        `https://www.rend.so/api/player/${ASSET_ID}/artifact/hls/720p/index.m3u8`,
        {
          headers: {
            cookie: "__rend_playback=v1.claims.signature",
          },
        },
      ),
      {
        params: Promise.resolve({
          assetId: ASSET_ID,
          artifactPath: ["hls", "720p", "index.m3u8"],
        }),
      },
    );

    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(fetches.length, 1);
    assert.equal(
      fetches[0]?.url,
      `https://api.rend.so/v/${ASSET_ID}/hls/720p/index.m3u8`,
    );
    assert.equal(
      fetches[0]?.headers.get("cookie"),
      "__rend_playback=v1.claims.signature",
    );
    assert.match(
      body,
      new RegExp(
        `/api/player/${ASSET_ID}/artifact/hls/720p/segment_00000\\.ts`,
      ),
    );
    assert.doesNotMatch(body, /playbackBaseUrl=/);
    assert.equal(response.headers.get("x-rend-origin"), "tigris");
  } finally {
    globalThis.fetch = originalFetch;
    clearPlaybackBootstrapCache();
    if (originalPlaybackMode === undefined) {
      delete process.env.REND_PLAYBACK_MODE;
    } else {
      process.env.REND_PLAYBACK_MODE = originalPlaybackMode;
    }
    if (originalApiBaseUrl === undefined) {
      delete process.env.REND_API_BASE_URL;
    } else {
      process.env.REND_API_BASE_URL = originalApiBaseUrl;
    }
    if (originalTigrisPlaybackBaseUrl === undefined) {
      delete process.env.REND_TIGRIS_PLAYBACK_BASE_URL;
    } else {
      process.env.REND_TIGRIS_PLAYBACK_BASE_URL =
        originalTigrisPlaybackBaseUrl;
    }
  }
});

test("artifact route keeps playback base query for explicit allowlisted overrides", async () => {
  const originalFetch = globalThis.fetch;
  const originalPlaybackBaseUrl = process.env.REND_PLAYER_PLAYBACK_BASE_URL;
  const originalAllowedPlaybackBaseUrls =
    process.env.REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS;
  const fetches: Array<{ url: string; headers: Headers }> = [];
  delete process.env.REND_PLAYER_PLAYBACK_BASE_URL;
  process.env.REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS = "https://edge.rend.so";

  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetches.push({
      url: String(url),
      headers: new Headers(init?.headers),
    });
    return new Response("#EXTM3U\n#EXTINF:2.000000,\nsegment_00000.ts\n", {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl",
        "x-rend-cache": "HIT",
      },
    });
  }) as typeof fetch;

  try {
    const response = await getPlaybackArtifact(
      new Request(
        `https://rend.so/api/player/${ASSET_ID}/artifact/hls/720p/index.m3u8?playbackBaseUrl=https%3A%2F%2Fedge.rend.so`,
        {
          headers: {
            cookie: "__rend_playback=v1.claims.signature",
          },
        },
      ),
      {
        params: Promise.resolve({
          assetId: ASSET_ID,
          artifactPath: ["hls", "720p", "index.m3u8"],
        }),
      },
    );

    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(
      fetches[0]?.url,
      `https://edge.rend.so/v/${ASSET_ID}/hls/720p/index.m3u8`,
    );
    assert.match(
      body,
      new RegExp(
        `/api/player/${ASSET_ID}/artifact/hls/720p/segment_00000\\.ts\\?playbackBaseUrl=`,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPlaybackBaseUrl === undefined) {
      delete process.env.REND_PLAYER_PLAYBACK_BASE_URL;
    } else {
      process.env.REND_PLAYER_PLAYBACK_BASE_URL = originalPlaybackBaseUrl;
    }
    if (originalAllowedPlaybackBaseUrls === undefined) {
      delete process.env.REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS;
    } else {
      process.env.REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS =
        originalAllowedPlaybackBaseUrls;
    }
  }
});

test("artifact route uses cached bootstrap context without database fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalPlaybackBaseUrl = process.env.REND_PLAYER_PLAYBACK_BASE_URL;
  const originalAllowedPlaybackBaseUrls =
    process.env.REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS;
  const fetches: Array<{ url: string; headers: Headers }> = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  clearPlaybackBootstrapCache();
  delete process.env.REND_PLAYER_PLAYBACK_BASE_URL;
  delete process.env.REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS;

  rememberBootstrapResponse("artifact-fallback", {
    assetId: ASSET_ID,
    cachedAtMs: Date.now() - 1000,
    directPlaybackEnabled: false,
    organizationId: ORG_ID,
    playbackBaseUrl: null,
    playbackToken: "v1.claims.signature",
    requestOrigin: "https://rend.so",
    safeResponse: cachedSafeResponse(nowSeconds + 600, 600),
    upstreamResponse: {
      asset_id: ASSET_ID,
      source_state: "uploaded",
      playable_state: "hls_ready",
      playback_url:
        "https://api.rend.so/v/00000000-0000-0000-0000-000000000001/opener.mp4",
      playback_content_type: "video/mp4",
      playback_token_expires_at: nowSeconds + 600,
      playback_token: "v1.claims.signature",
      ttl_seconds: 600,
      opener_url:
        "https://api.rend.so/v/00000000-0000-0000-0000-000000000001/opener.mp4",
      opener_content_type: "video/mp4",
      prefetch_hints: [],
    },
  });

  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetches.push({
      url: String(url),
      headers: new Headers(init?.headers),
    });
    return new Response("opener", {
      status: 200,
      headers: {
        "content-length": "6",
        "content-type": "video/mp4",
        "x-rend-cache": "MISS",
      },
    });
  }) as typeof fetch;

  try {
    const response = await getPlaybackArtifact(
      new Request(`https://rend.so/api/player/${ASSET_ID}/artifact/opener.mp4`),
      {
        params: Promise.resolve({
          assetId: ASSET_ID,
          artifactPath: ["opener.mp4"],
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "opener");
    assert.equal(fetches.length, 1);
    assert.equal(
      fetches[0]?.url,
      `https://api.rend.so/v/${ASSET_ID}/opener.mp4`,
    );
    assert.equal(
      fetches[0]?.headers.get("cookie"),
      "__rend_playback=v1.claims.signature",
    );
    assert.match(
      response.headers.get("set-cookie") ?? "",
      /^__rend_playback=v1\.claims\.signature;/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearPlaybackBootstrapCache();
    if (originalPlaybackBaseUrl === undefined) {
      delete process.env.REND_PLAYER_PLAYBACK_BASE_URL;
    } else {
      process.env.REND_PLAYER_PLAYBACK_BASE_URL = originalPlaybackBaseUrl;
    }
    if (originalAllowedPlaybackBaseUrls === undefined) {
      delete process.env.REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS;
    } else {
      process.env.REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS =
        originalAllowedPlaybackBaseUrls;
    }
  }
});
