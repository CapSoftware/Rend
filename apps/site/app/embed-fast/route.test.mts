import assert from "node:assert/strict";
import test from "node:test";
import {
  GET as getFastEmbed,
  renderFastEmbedHtml,
} from "./[assetId]/route.ts";
import type { WatchPlaybackBootstrapResponse } from "../../lib/watch-bootstrap.ts";

const ASSET_ID = "00000000-0000-0000-0000-000000000001";

function readyBootstrap(): WatchPlaybackBootstrapResponse {
  return {
    status: "ready",
    asset_id: ASSET_ID,
    organization_id: "00000000-0000-0000-0000-000000000002",
    source_state: "uploaded",
    playable_state: "hls_ready",
    playback_url: "https://api.rend.so/v/00000000-0000-0000-0000-000000000001/hls/master.m3u8",
    playback_content_type: "application/vnd.apple.mpegurl",
    playback_token_expires_at: Date.now() + 60_000,
    ttl_seconds: 60,
    opener_url: "https://api.rend.so/v/00000000-0000-0000-0000-000000000001/opener.mp4",
    opener_content_type: "video/mp4",
    manifest_url: "https://api.rend.so/v/00000000-0000-0000-0000-000000000001/hls/master.m3u8",
    manifest_content_type: "application/vnd.apple.mpegurl",
    poster_url: "https://api.rend.so/v/00000000-0000-0000-0000-000000000001/thumbnail.jpg",
    poster_content_type: "image/jpeg",
    prefetch_hints: [
      {
        artifact_path: "hls/360p/init_360p.mp4",
        content_type: "video/mp4",
        url: "https://api.rend.so/v/00000000-0000-0000-0000-000000000001/hls/360p/init_360p.mp4",
      },
      {
        artifact_path: "hls/360p/segment_00000.m4s",
        content_type: "video/mp4",
        url: "https://api.rend.so/v/00000000-0000-0000-0000-000000000001/hls/360p/segment_00000.m4s",
      },
    ],
  };
}

test("fast embed renders a direct native HLS video without exposing playback secrets", () => {
  const html = renderFastEmbedHtml({
    assetId: ASSET_ID,
    autoPlay: true,
    bootstrap: readyBootstrap(),
    bootstrapMs: 42,
    controls: false,
    muted: true,
    startupMode: "hls",
  });

  assert.match(html, /<video class="rend-fast__video"/);
  assert.match(html, /src="https:\/\/api\.rend\.so\/v\/00000000-0000-0000-0000-000000000001\/hls\/master\.m3u8"/);
  assert.match(html, /data-rend-player-selected="native_hls"/);
  assert.match(html, /data-rend-player-artifact="hls\/master\.m3u8"/);
  assert.match(html, /data-rend-bootstrap-ms="42"/);
  assert.match(html, /rel="preconnect" href="https:\/\/api\.rend\.so" crossorigin/);
  assert.doesNotMatch(html, /playback_token|set-cookie|authorization/i);
});

test("fast embed defaults to progressive fMP4 when startup hints support it", () => {
  const html = renderFastEmbedHtml({
    assetId: ASSET_ID,
    autoPlay: true,
    bootstrap: readyBootstrap(),
    bootstrapMs: 42,
    controls: false,
    muted: true,
    startupMode: "progressive",
  });

  assert.match(html, /src="https:\/\/api\.rend\.so\/v\/00000000-0000-0000-0000-000000000001\/hls\/360p\/progressive\.mp4"/);
  assert.match(html, /rel="preload" as="video" href="https:\/\/api\.rend\.so\/v\/00000000-0000-0000-0000-000000000001\/hls\/360p\/progressive\.mp4" type="video\/mp4" crossorigin="use-credentials" fetchpriority="high"/);
  assert.match(html, /data-rend-player-selected="progressive_mp4"/);
  assert.match(html, /data-rend-player-artifact="hls\/360p\/progressive\.mp4"/);
  assert.doesNotMatch(html, /playback_token|set-cookie|authorization/i);
});

test("fast embed route forwards bootstrap cookies to the document response", async () => {
  const originalFetch = globalThis.fetch;
  const fetches: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetches.push({
      url: String(url),
      headers: new Headers(init?.headers),
    });
    return Response.json(readyBootstrap(), {
      headers: {
        "set-cookie": "__rend_playback=v1.claims.signature; Path=/; HttpOnly; Secure; SameSite=None",
      },
    });
  }) as typeof fetch;

  try {
    const response = await getFastEmbed(
      new Request(
        `https://www.rend.so/embed-fast/${ASSET_ID}?autoplay=1&controls=0`,
        {
          headers: {
            "x-vercel-ip-country": "GB",
          },
        },
      ),
      { params: Promise.resolve({ assetId: ASSET_ID }) },
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-rend-fast-embed"), "1");
    assert.match(response.headers.get("link") ?? "", /rel=preconnect/);
    assert.match(response.headers.get("link") ?? "", /hls\/360p\/progressive\.mp4/);
    assert.match(response.headers.get("link") ?? "", /rel=preload; as=video/);
    assert.match(response.headers.get("set-cookie") ?? "", /__rend_playback=/);
    assert.equal(
      fetches[0]?.url,
      `https://www.rend.so/api/player/${ASSET_ID}`,
    );
    assert.equal(fetches[0]?.headers.get("x-vercel-ip-country"), "GB");
    assert.match(body, /autoplay/);
    assert.doesNotMatch(body, /controls/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
