import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  latestPlaybackReadinessResult,
  playbackReadinessArtifactPath,
} from "./readiness.ts";

test("readiness artifact path uses configured path", () => {
  assert.equal(
    playbackReadinessArtifactPath({ REND_READINESS_ARTIFACT_PATH: "/tmp/rend-readiness.json" }),
    "/tmp/rend-readiness.json"
  );
});

test("latest readiness returns missing when artifact is absent", async () => {
  const result = await latestPlaybackReadinessResult({
    REND_READINESS_ARTIFACT_PATH: "/tmp/rend-readiness-not-present.json",
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "missing");
});

test("latest readiness parses a valid redacted artifact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rend-readiness-test-"));
  const artifactPath = path.join(dir, "latest.json");
  await writeFile(
    artifactPath,
    JSON.stringify({
      schema_version: 1,
      gate: "rend-playback-production-readiness",
      run_id: "run-1",
      status: "pass",
      started_at: "2026-06-14T00:00:00.000Z",
      ended_at: "2026-06-14T00:00:05.000Z",
      target: "configured",
      synthetic_only: true,
      edges: [{ edge_id: "edge-a", region: "local" }],
      fixtures: [],
    })
  );

  const result = await latestPlaybackReadinessResult({
    REND_READINESS_ARTIFACT_PATH: artifactPath,
  });
  assert.equal(result.available, true);
  assert.equal(result.result.status, "pass");
  assert.equal(result.result.edges[0]?.edge_id, "edge-a");
});

test("latest readiness rejects invalid artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rend-readiness-test-"));
  const artifactPath = path.join(dir, "latest.json");
  await writeFile(artifactPath, JSON.stringify({ status: "pass" }));

  const result = await latestPlaybackReadinessResult({
    REND_READINESS_ARTIFACT_PATH: artifactPath,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "invalid");
});
