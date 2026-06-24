import assert from "node:assert/strict";
import test from "node:test";
import { watchHeartbeatDelta } from "./player-engine.ts";

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
