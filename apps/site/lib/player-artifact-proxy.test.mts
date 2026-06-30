import assert from "node:assert/strict";
import test from "node:test";
import {
  isHlsManifestArtifactPath,
  playbackCookieFromHeaders,
  playbackCookieFromSetCookieHeader,
  playbackCookieFromSetCookieHeaders,
  playbackArtifactFetchHeaders,
  playbackArtifactResponseHeaders,
  playbackDirectCookieHeader,
  playbackProxyCookieHeader,
} from "./player-artifact-proxy.ts";

test("rewritten manifest headers use transformed body length and drop range metadata", () => {
  const upstream = new Headers({
    "accept-ranges": "bytes",
    "content-length": "42",
    "content-range": "bytes 0-41/42",
    "content-type": "application/vnd.apple.mpegurl",
    "x-rend-cache": "HIT",
  });
  const body = "#EXTM3U\n/api/player/asset/artifact/hls/360p/segment_00000.m4s\n";

  const headers = playbackArtifactResponseHeaders(upstream, {
    artifactPath: "hls/master.m3u8",
    contentType: "application/vnd.apple.mpegurl",
    rewrittenBody: body,
  });

  assert.equal(headers.get("content-length"), String(new TextEncoder().encode(body).byteLength));
  assert.equal(headers.get("cache-control"), "private, max-age=60, stale-while-revalidate=300");
  assert.equal(headers.get("content-type"), "application/vnd.apple.mpegurl");
  assert.equal(headers.get("x-rend-cache"), "HIT");
  assert.equal(headers.get("timing-allow-origin"), "https://www.rend.so");
  assert.equal(headers.get("accept-ranges"), null);
  assert.equal(headers.get("content-range"), null);
});

test("streamed artifact headers preserve upstream length and range metadata", () => {
  const upstream = new Headers({
    "accept-ranges": "bytes",
    "content-length": "1234",
    "content-range": "bytes 0-1233/1234",
    "content-type": "video/mp2t",
    "x-rend-cache": "MISS",
  });

  const headers = playbackArtifactResponseHeaders(upstream);

  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("content-length"), "1234");
  assert.equal(headers.get("content-range"), "bytes 0-1233/1234");
  assert.equal(headers.get("content-type"), "video/mp2t");
  assert.equal(headers.get("x-rend-cache"), "MISS");
  assert.equal(headers.get("timing-allow-origin"), null);
});

test("versioned public playback artifacts use private immutable browser caching", () => {
  const upstream = new Headers({
    "content-length": "1234",
    "content-type": "video/mp4",
  });

  const openerHeaders = playbackArtifactResponseHeaders(upstream, {
    artifactPath: "opener.mp4",
  });
  const segmentHeaders = playbackArtifactResponseHeaders(upstream, {
    artifactPath: "hls/360p/segment_00000.m4s",
  });
  const initHeaders = playbackArtifactResponseHeaders(upstream, {
    artifactPath: "hls/360p/init_360p.mp4",
  });
  const thumbnailHeaders = playbackArtifactResponseHeaders(upstream, {
    artifactPath: "thumbnail.jpg",
  });
  const variantSegmentHeaders = playbackArtifactResponseHeaders(upstream, {
    artifactPath: "hls/720p/segment_00000.ts",
  });
  const failedHeaders = playbackArtifactResponseHeaders(upstream, {
    artifactPath: "opener.mp4",
    cacheable: false,
  });

  assert.equal(openerHeaders.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(thumbnailHeaders.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(segmentHeaders.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(initHeaders.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(variantSegmentHeaders.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(failedHeaders.get("cache-control"), "no-store");
  assert.equal(segmentHeaders.get("timing-allow-origin"), "https://www.rend.so");
  assert.equal(initHeaders.get("timing-allow-origin"), "https://www.rend.so");
  assert.equal(variantSegmentHeaders.get("timing-allow-origin"), "https://www.rend.so");
  assert.equal(openerHeaders.get("timing-allow-origin"), null);
  assert.equal(thumbnailHeaders.get("timing-allow-origin"), null);
});

test("manifest fetches do not forward range requests because the body is rewritten", () => {
  for (const artifactPath of ["hls/master.m3u8", "hls/720p/index.m3u8"]) {
    const headers = playbackArtifactFetchHeaders(
      new Headers({ range: "bytes=0-99" }),
      "cookie-value",
      artifactPath
    );

    assert.equal(headers.get("range"), null);
    assert.equal(headers.get("cookie"), "__rend_playback=cookie-value");
  }
});

test("binary artifact fetches preserve range requests", () => {
  const headers = playbackArtifactFetchHeaders(
    new Headers({ range: "bytes=0-99" }),
    "cookie-value",
    "hls/360p/segment_00000.m4s"
  );

  assert.equal(headers.get("range"), "bytes=0-99");
  assert.equal(headers.get("cookie"), "__rend_playback=cookie-value");
});

test("manifest path helper recognizes master and variant playlists only", () => {
  assert.equal(isHlsManifestArtifactPath("hls/master.m3u8"), true);
  assert.equal(isHlsManifestArtifactPath("hls/360p/index.m3u8"), true);
  assert.equal(isHlsManifestArtifactPath("hls/720p/index.m3u8"), true);
  assert.equal(isHlsManifestArtifactPath("hls/360p/init_360p.mp4"), false);
  assert.equal(isHlsManifestArtifactPath("hls/720p/segment_00000.ts"), false);
  assert.equal(isHlsManifestArtifactPath("hls/240p/index.m3u8"), false);
});

test("proxy playback cookie is scoped to one asset artifact path", () => {
  const header = playbackProxyCookieHeader(
    "https://rend.so/api/player/00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000001",
    "v1.claims.signature",
    900
  );

  assert.match(header ?? "", /^__rend_playback=v1\.claims\.signature;/);
  assert.match(header ?? "", /Path=\/api\/player\/00000000-0000-0000-0000-000000000001\/artifact\//);
  assert.match(header ?? "", /Max-Age=900/);
  assert.match(header ?? "", /HttpOnly/);
  assert.match(header ?? "", /SameSite=None/);
  assert.match(header ?? "", /Secure/);
});

test("proxy playback cookie uses local-safe attributes on http", () => {
  const header = playbackProxyCookieHeader(
    "http://127.0.0.1:3000/api/player/00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000001",
    "v1.claims.signature",
    900
  );

  assert.match(header ?? "", /SameSite=Lax/);
  assert.doesNotMatch(header ?? "", /Secure/);
});

test("direct playback cookie is scoped to the edge asset path and optional rend domain", () => {
  const header = playbackDirectCookieHeader(
    "https://www.rend.so/api/player/00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000001",
    "v1.claims.signature",
    900,
    "https://media.rend.so",
    "rend.so"
  );

  assert.match(header ?? "", /^__rend_playback=v1\.claims\.signature;/);
  assert.match(header ?? "", /Path=\/v\/00000000-0000-0000-0000-000000000001\//);
  assert.match(header ?? "", /Domain=rend\.so/);
  assert.match(header ?? "", /Max-Age=900/);
  assert.match(header ?? "", /HttpOnly/);
  assert.match(header ?? "", /SameSite=None/);
  assert.match(header ?? "", /Secure/);
});

test("playback cookie can be extracted from upstream set-cookie headers", () => {
  assert.equal(
    playbackCookieFromSetCookieHeader(
      "__rend_playback=v1.claims.signature; Path=/v/; Max-Age=900; HttpOnly; SameSite=Lax"
    ),
    "v1.claims.signature"
  );
  assert.equal(
    playbackCookieFromSetCookieHeader(
      "session=ignored; Path=/, __rend_playback=v1.claims.signature; Path=/v/; Max-Age=900"
    ),
    "v1.claims.signature"
  );
  assert.equal(playbackCookieFromSetCookieHeader("__rend_playback=bad$value; Path=/v/"), undefined);

  const headers = new Headers({
    "set-cookie": "__rend_playback=v1.claims.signature; Path=/v/",
  });
  assert.equal(playbackCookieFromSetCookieHeaders(headers), "v1.claims.signature");
});

test("playback cookie parser returns only safe cookie values", () => {
  assert.equal(
    playbackCookieFromHeaders(new Headers({ cookie: "theme=dark; __rend_playback=v1.claims.signature" })),
    "v1.claims.signature"
  );
  assert.equal(
    playbackCookieFromHeaders(new Headers({ cookie: "__rend_playback=bad;value" })),
    "bad"
  );
  assert.equal(
    playbackCookieFromHeaders(new Headers({ cookie: "__rend_playback=bad value" })),
    undefined
  );
});
