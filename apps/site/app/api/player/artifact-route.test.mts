import assert from "node:assert/strict";
import test from "node:test";
import { GET as getPlaybackArtifact } from "./[assetId]/artifact/[...artifactPath]/route.ts";

const ASSET_ID = "00000000-0000-0000-0000-000000000001";

test("artifact route uses playback cookie fast path when the edge base is known", async () => {
  const originalFetch = globalThis.fetch;
  const originalPlaybackBaseUrl = process.env.REND_PLAYER_PLAYBACK_BASE_URL;
  const fetches: Array<{ url: string; headers: Headers }> = [];
  process.env.REND_PLAYER_PLAYBACK_BASE_URL = "https://edge.rend.so";

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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
      new Request(`https://rend.so/api/player/${ASSET_ID}/artifact/opener.mp4`, {
        headers: {
          cookie: "__rend_playback=v1.claims.signature",
        },
      }),
      {
        params: Promise.resolve({
          assetId: ASSET_ID,
          artifactPath: ["opener.mp4"],
        }),
      }
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "opener");
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0]?.url, `https://edge.rend.so/v/${ASSET_ID}/opener.mp4`);
    assert.equal(fetches[0]?.headers.get("cookie"), "__rend_playback=v1.claims.signature");
    assert.equal(response.headers.get("x-rend-cache"), "HIT");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPlaybackBaseUrl === undefined) {
      delete process.env.REND_PLAYER_PLAYBACK_BASE_URL;
    } else {
      process.env.REND_PLAYER_PLAYBACK_BASE_URL = originalPlaybackBaseUrl;
    }
  }
});

test("artifact route rewrites variant playlist segment URLs", async () => {
  const originalFetch = globalThis.fetch;
  const originalPlaybackBaseUrl = process.env.REND_PLAYER_PLAYBACK_BASE_URL;
  const fetches: Array<{ url: string; headers: Headers }> = [];
  process.env.REND_PLAYER_PLAYBACK_BASE_URL = "https://edge.rend.so";

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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
      new Request(`https://rend.so/api/player/${ASSET_ID}/artifact/hls/720p/index.m3u8`, {
        headers: {
          cookie: "__rend_playback=v1.claims.signature",
        },
      }),
      {
        params: Promise.resolve({
          assetId: ASSET_ID,
          artifactPath: ["hls", "720p", "index.m3u8"],
        }),
      }
    );

    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(fetches[0]?.url, `https://edge.rend.so/v/${ASSET_ID}/hls/720p/index.m3u8`);
    assert.match(
      body,
      new RegExp(`/api/player/${ASSET_ID}/artifact/hls/720p/segment_00000\\.ts\\?playbackBaseUrl=`)
    );
    assert.equal(response.headers.get("content-type"), "application/vnd.apple.mpegurl");
    assert.equal(response.headers.get("cache-control"), "private, max-age=60, stale-while-revalidate=300");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPlaybackBaseUrl === undefined) {
      delete process.env.REND_PLAYER_PLAYBACK_BASE_URL;
    } else {
      process.env.REND_PLAYER_PLAYBACK_BASE_URL = originalPlaybackBaseUrl;
    }
  }
});
