import assert from "node:assert/strict";
import test from "node:test";
import {
  playbackArtifactFetchHeaders,
  playbackArtifactResponseHeaders,
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
