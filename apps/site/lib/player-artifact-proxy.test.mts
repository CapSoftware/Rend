import assert from "node:assert/strict";
import test from "node:test";
import {
  playbackCookieFromHeaders,
  playbackArtifactFetchHeaders,
  playbackArtifactResponseHeaders,
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
  const body = "#EXTM3U\n/api/player/asset/artifact/hls/segment_00000.ts\n";

  const headers = playbackArtifactResponseHeaders(upstream, {
    contentType: "application/vnd.apple.mpegurl",
    rewrittenBody: body,
  });

  assert.equal(headers.get("content-length"), String(new TextEncoder().encode(body).byteLength));
  assert.equal(headers.get("content-type"), "application/vnd.apple.mpegurl");
  assert.equal(headers.get("x-rend-cache"), "HIT");
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

  assert.equal(headers.get("content-length"), "1234");
  assert.equal(headers.get("content-range"), "bytes 0-1233/1234");
  assert.equal(headers.get("content-type"), "video/mp2t");
  assert.equal(headers.get("x-rend-cache"), "MISS");
});

test("manifest fetches do not forward range requests because the body is rewritten", () => {
  const headers = playbackArtifactFetchHeaders(
    new Headers({ range: "bytes=0-99" }),
    "cookie-value",
    "hls/master.m3u8"
  );

  assert.equal(headers.get("range"), null);
  assert.equal(headers.get("cookie"), "__rend_playback=cookie-value");
});

test("binary artifact fetches preserve range requests", () => {
  const headers = playbackArtifactFetchHeaders(
    new Headers({ range: "bytes=0-99" }),
    "cookie-value",
    "hls/segment_00000.ts"
  );

  assert.equal(headers.get("range"), "bytes=0-99");
  assert.equal(headers.get("cookie"), "__rend_playback=cookie-value");
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
