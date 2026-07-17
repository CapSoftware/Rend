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
    bootstrapUrl: `/api/player/${ASSET_ID}`,
    bootstrapMs: 42,
    controls: false,
    muted: true,
    playbackOriginHint: null,
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
    bootstrapUrl: `/api/player/${ASSET_ID}`,
    bootstrapMs: 42,
    controls: false,
    muted: true,
    playbackOriginHint: null,
    startupMode: "progressive",
  });

  assert.match(html, /src="https:\/\/api\.rend\.so\/v\/00000000-0000-0000-0000-000000000001\/hls\/360p\/progressive\.mp4"/);
  assert.match(html, /rel="preload" as="video" href="https:\/\/api\.rend\.so\/v\/00000000-0000-0000-0000-000000000001\/hls\/360p\/progressive\.mp4" type="video\/mp4" crossorigin="use-credentials" fetchpriority="high"/);
  assert.match(html, /data-rend-player-selected="progressive_mp4"/);
  assert.match(html, /data-rend-player-artifact="hls\/360p\/progressive\.mp4"/);
  assert.doesNotMatch(html, /playback_token|set-cookie|authorization/i);
});

test("fast embed uses anonymous progressive MP4 for public playback", () => {
  const base = readyBootstrap();
  if (base.status !== "ready") throw new Error("expected ready bootstrap");
  const bootstrap = {
    ...base,
    playback_credential_mode: "omit" as const,
    playback_url: `https://media.rend.so/v/${ASSET_ID}/hls/master.m3u8`,
    opener_url: `https://media.rend.so/v/${ASSET_ID}/opener.mp4`,
    manifest_url: `https://media.rend.so/v/${ASSET_ID}/hls/master.m3u8`,
    poster_url: `https://media.rend.so/v/${ASSET_ID}/thumbnail.jpg`,
    prefetch_hints: [
      {
        artifact_path: "hls/360p/init_360p.mp4",
        content_type: "video/mp4",
        url: `https://media.rend.so/v/${ASSET_ID}/hls/360p/init_360p.mp4`,
      },
      {
        artifact_path: "hls/360p/segment_00000.m4s",
        content_type: "video/mp4",
        url: `https://media.rend.so/v/${ASSET_ID}/hls/360p/segment_00000.m4s`,
      },
    ],
  } satisfies Extract<WatchPlaybackBootstrapResponse, { status: "ready" }>;
  const html = renderFastEmbedHtml({
    assetId: ASSET_ID,
    autoPlay: true,
    bootstrap,
    bootstrapUrl: `/api/player/${ASSET_ID}`,
    bootstrapMs: 42,
    controls: false,
    muted: true,
    playbackOriginHint: null,
    startupMode: "progressive",
  });

  assert.match(html, /src="https:\/\/media\.rend\.so\/v\/00000000-0000-0000-0000-000000000001\/hls\/360p\/progressive\.mp4"/);
  assert.match(html, /crossorigin="anonymous"/);
  assert.match(html, /data-rend-player-selected="progressive_mp4"/);
  assert.match(html, /rel="preload" as="video" href="https:\/\/media\.rend\.so\/v\/00000000-0000-0000-0000-000000000001\/hls\/360p\/progressive\.mp4" type="video\/mp4" crossorigin="anonymous" fetchpriority="high"/);
  assert.doesNotMatch(html, /crossorigin="use-credentials"/);
});

test("fast embed route supports client bootstrap for immediate document response", async () => {
  const originalFetch = globalThis.fetch;
  const fetches: string[] = [];

  globalThis.fetch = (async (url: string | URL | Request) => {
    fetches.push(String(url));
    return Response.json(readyBootstrap());
  }) as typeof fetch;

  try {
    const response = await getFastEmbed(
      new Request(
        `https://www.rend.so/embed-fast/${ASSET_ID}?autoplay=1&controls=0&bootstrap=client`,
      ),
      { params: Promise.resolve({ assetId: ASSET_ID }) },
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(fetches.length, 0);
    assert.equal(response.headers.get("x-rend-fast-embed"), "1");
    assert.match(response.headers.get("link") ?? "", /rel=preconnect/);
    assert.doesNotMatch(response.headers.get("link") ?? "", /rel=preload; as=video/);
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /__rend_playback=/);
    assert.match(body, /data-rend-player-state="loading"/);
    assert.doesNotMatch(body, /<video[^>]+src=/);
    assert.match(body, /progressive_mp4/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fast embed route forwards bootstrap cookies to the document response by default", async () => {
  const originalFetch = globalThis.fetch;
  const fetches: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const stringUrl = String(url);
    fetches.push({
      url: stringUrl,
      headers: new Headers(init?.headers),
    });
    if (stringUrl.endsWith("/hls/master.m3u8")) {
      return new Response(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2"\n360p/index.m3u8\n',
        { headers: { "content-type": "application/vnd.apple.mpegurl" } },
      );
    }
    if (stringUrl.endsWith("/hls/360p/index.m3u8")) {
      return new Response(
        "#EXTM3U\n#EXTINF:1.0,\nsegment_00000.m4s\n#EXTINF:1.0,\nsegment_00001.m4s\n",
        { headers: { "content-type": "application/vnd.apple.mpegurl" } },
      );
    }
    if (
      stringUrl.endsWith("/hls/360p/init_360p.mp4") ||
      stringUrl.endsWith("/hls/360p/segment_00000.m4s")
    ) {
      return new Response(new Uint8Array([0, 1, 2, 3]), {
        headers: { "content-type": "video/mp4" },
      });
    }
    const response = Response.json(readyBootstrap());
    for (const cookie of [
      "__rend_playback=v1.claims.signature; Path=/; HttpOnly; Secure; SameSite=None",
      "CloudFront-Policy=policy_value; Path=/; HttpOnly; Secure; SameSite=None",
      "CloudFront-Signature=signature_value; Path=/; HttpOnly; Secure; SameSite=None",
      "CloudFront-Key-Pair-Id=key_pair; Path=/; HttpOnly; Secure; SameSite=None",
    ]) {
      response.headers.append("set-cookie", cookie);
    }
    return response;
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
    assert.match(response.headers.get("link") ?? "", /hls\/360p\/segment_00001\.m4s/);
    assert.match(response.headers.get("link") ?? "", /rel=preload; as=fetch/);
    assert.match(response.headers.get("set-cookie") ?? "", /__rend_playback=/);
    assert.equal(
      fetches[0]?.url,
      `https://www.rend.so/api/player/${ASSET_ID}`,
    );
    assert.equal(fetches[0]?.headers.get("x-vercel-ip-country"), "GB");
    assert.match(fetches[1]?.headers.get("cookie") ?? "", /__rend_playback=/);
    assert.match(fetches[1]?.headers.get("cookie") ?? "", /CloudFront-Policy=policy_value/);
    assert.match(fetches[1]?.headers.get("cookie") ?? "", /CloudFront-Signature=signature_value/);
    assert.match(fetches[1]?.headers.get("cookie") ?? "", /CloudFront-Key-Pair-Id=key_pair/);
    assert.match(body, /autoplay/);
    assert.doesNotMatch(body, /controls/);
    assert.match(body, /mse_inline/);
    assert.doesNotMatch(body, /playback_token|authorization/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
