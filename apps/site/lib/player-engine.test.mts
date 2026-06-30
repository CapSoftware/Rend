import assert from "node:assert/strict";
import test from "node:test";
import {
  initialPlaybackState,
  initialSourceSelection,
  startupPreloadHints,
  watchHeartbeatDelta,
} from "./player-engine.ts";

const READY_BOOTSTRAP = {
  status: "ready" as const,
  asset_id: "00000000-0000-0000-0000-000000000001",
  source_state: "uploaded",
  playable_state: "hls_ready",
  playback_url: "https://ash-1.play.rend.so/v/asset/hls/master.m3u8",
  playback_content_type: "application/vnd.apple.mpegurl",
  playback_token_expires_at: 1_800_000_000,
  ttl_seconds: 900,
  opener_url: "https://ash-1.play.rend.so/v/asset/opener.mp4",
  opener_content_type: "video/mp4",
  manifest_url: "https://ash-1.play.rend.so/v/asset/hls/master.m3u8",
  manifest_content_type: "application/vnd.apple.mpegurl",
  poster_url: "https://ash-1.play.rend.so/v/asset/thumbnail.jpg",
  poster_content_type: "image/jpeg",
  prefetch_hints: [
    {
      artifact_path: "hls/360p/index.m3u8",
      url: "https://ash-1.play.rend.so/v/asset/hls/360p/index.m3u8",
      content_type: "application/vnd.apple.mpegurl",
    },
    {
      artifact_path: "hls/360p/init_360p.mp4",
      url: "https://ash-1.play.rend.so/v/asset/hls/360p/init_360p.mp4",
      content_type: "video/mp4",
    },
    {
      artifact_path: "hls/master.m3u8",
      url: "https://ash-1.play.rend.so/v/asset/hls/master.m3u8",
      content_type: "application/vnd.apple.mpegurl",
    },
  ],
};

test("watch heartbeat waits for a real interval before emitting", () => {
  assert.deepEqual(watchHeartbeatDelta(null, 0), {
    nextPositionMs: 0,
    deltaMs: null,
  });
  assert.deepEqual(watchHeartbeatDelta(0, 9_999), {
    nextPositionMs: 0,
    deltaMs: null,
  });
  assert.deepEqual(watchHeartbeatDelta(0, 10_000), {
    nextPositionMs: 10_000,
    deltaMs: 10_000,
  });
});

test("watch heartbeat flushes partial watch time when forced", () => {
  assert.deepEqual(watchHeartbeatDelta(10_000, 10_500, true), {
    nextPositionMs: 10_000,
    deltaMs: null,
  });
  assert.deepEqual(watchHeartbeatDelta(10_000, 11_250, true), {
    nextPositionMs: 11_250,
    deltaMs: 1_250,
  });
});

test("watch heartbeat clamps large deltas and reseeds after seeks", () => {
  assert.deepEqual(watchHeartbeatDelta(0, 45_000), {
    nextPositionMs: 45_000,
    deltaMs: 30_000,
  });
  assert.deepEqual(watchHeartbeatDelta(45_000, 2_000), {
    nextPositionMs: 2_000,
    deltaMs: null,
  });
});

test("startup preload hints avoid duplicating native HLS startup requests", () => {
  assert.deepEqual(
    startupPreloadHints(READY_BOOTSTRAP, "hls").map((hint) => [
      hint.artifactPath,
      hint.as,
      hint.url,
    ]),
    [["thumbnail.jpg", "image", "https://ash-1.play.rend.so/v/asset/thumbnail.jpg"]]
  );
});

test("startup preload hints include opener first only when requested", () => {
  assert.equal(startupPreloadHints(READY_BOOTSTRAP, "hls")[0]?.artifactPath, "thumbnail.jpg");
  assert.equal(startupPreloadHints(READY_BOOTSTRAP, "opener")[0]?.artifactPath, "opener.mp4");
});

test("explicit MSE playback defers initial HLS assignment to the client", () => {
  const selection = initialSourceSelection(READY_BOOTSTRAP, "hls", "mse");
  assert.equal(selection, null);
  assert.equal(initialPlaybackState(READY_BOOTSTRAP, selection, true), "ready");
});

test("explicit MSE playback still allows opener startup when requested", () => {
  assert.deepEqual(initialSourceSelection(READY_BOOTSTRAP, "opener", "mse"), {
    label: "opener",
    artifactPath: "opener.mp4",
    url: "https://ash-1.play.rend.so/v/asset/opener.mp4",
  });
});
