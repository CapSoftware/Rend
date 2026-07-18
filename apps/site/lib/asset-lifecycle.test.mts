import assert from "node:assert/strict";
import test from "node:test";
import {
  isAssetPlayable,
  isAssetProcessingComplete,
  shouldRefreshAssetLifecycle,
} from "./asset-lifecycle.ts";

test("opener_ready is playable but continues processing", () => {
  assert.equal(isAssetPlayable("opener_ready"), true);
  assert.equal(isAssetProcessingComplete("opener_ready"), false);
  assert.equal(shouldRefreshAssetLifecycle({ playable_state: "opener_ready" }), true);
});

test("hls_ready is playable and complete", () => {
  assert.equal(isAssetPlayable("hls_ready"), true);
  assert.equal(isAssetProcessingComplete("hls_ready"), true);
  assert.equal(shouldRefreshAssetLifecycle({ playable_state: "hls_ready" }), false);
});

test("terminal and suspended assets do not keep polling", () => {
  for (const playable_state of ["failed", "deleted"]) {
    assert.equal(shouldRefreshAssetLifecycle({ playable_state }), false);
  }
  assert.equal(
    shouldRefreshAssetLifecycle({
      playable_state: "opener_ready",
      suspended_at: "2026-07-18T00:00:00Z",
    }),
    false,
  );
  assert.equal(
    shouldRefreshAssetLifecycle({
      playable_state: "not_playable",
      organization_suspended_at: "2026-07-18T00:00:00Z",
    }),
    false,
  );
});
