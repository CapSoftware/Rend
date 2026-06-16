import assert from "node:assert/strict";
import test from "node:test";
import {
  fallbackPrimarySource,
  hlsSource,
  openerSource,
  selectedSource,
} from "./source-selection.ts";

const DATA = {
  manifest_url: "/api/player/asset/artifact/hls/master.m3u8",
  opener_url: "/api/player/asset/artifact/opener.mp4",
  playback_url: "/api/player/asset/artifact/hls/master.m3u8",
  playable_state: "hls_ready",
};

test("selectedSource prefers opener before native or hls.js HLS", () => {
  assert.deepEqual(selectedSource(DATA, { nativeHls: true, hlsJs: true }), {
    label: "opener",
    artifactPath: "opener.mp4",
    url: DATA.opener_url,
  });
});

test("hlsSource preserves native HLS before hls.js when the browser supports it", () => {
  assert.deepEqual(hlsSource(DATA, { nativeHls: true, hlsJs: true }), {
    label: "native_hls",
    artifactPath: "hls/master.m3u8",
    url: DATA.manifest_url,
  });
});

test("hlsSource uses hls.js only when native HLS is unavailable", () => {
  assert.deepEqual(hlsSource(DATA, { nativeHls: false, hlsJs: true }), {
    label: "hls_js",
    artifactPath: "hls/master.m3u8",
    url: DATA.manifest_url,
  });
});

test("selectedSource falls back to HLS and then primary when opener is unavailable", () => {
  const withoutOpener = { ...DATA, opener_url: undefined };

  assert.equal(selectedSource(withoutOpener, { nativeHls: false, hlsJs: true })?.label, "hls_js");
  assert.equal(selectedSource(withoutOpener, { nativeHls: false, hlsJs: false })?.label, "primary");
});

test("source helpers map artifact paths consistently", () => {
  assert.equal(openerSource(DATA)?.artifactPath, "opener.mp4");
  assert.equal(fallbackPrimarySource(DATA)?.artifactPath, "hls/master.m3u8");
  assert.equal(fallbackPrimarySource({ playback_url: "/opener.mp4" })?.artifactPath, "opener.mp4");
});
