#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootUrl = (process.env.REND_SELFHOST_URL ?? "http://localhost:8080").replace(/\/$/, "");
const envFile = process.env.REND_SELFHOST_ENV_FILE ?? ".env.docker";
const processingDeadlineMs = Number(process.env.REND_SELFHOST_SMOKE_TIMEOUT_MS ?? 180_000);
const keepAsset = process.env.REND_SELFHOST_SMOKE_KEEP_ASSET === "1";
const suppliedFixture = process.env.REND_SELFHOST_SMOKE_FIXTURE;

function parseEnv(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

async function responseBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 1_000);
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${rootUrl}${path}`, options);
  const body = await responseBody(response);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return { response, body };
}

function createFixture(path) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=48000",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-y",
      path,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`failed to create smoke video with ffmpeg: ${result.stderr.slice(0, 1_000)}`);
  }
}

async function uploadParts(uploadId, session, source, authorization) {
  const partSize = Number(session.part_size);
  const parts = [];
  for (let offset = 0, partNumber = 1; offset < source.byteLength; offset += partSize, partNumber += 1) {
    const bytes = source.subarray(offset, Math.min(offset + partSize, source.byteLength));
    parts.push({
      part_number: partNumber,
      checksum_sha256: createHash("sha256").update(bytes).digest("base64"),
      bytes,
    });
  }
  assert.equal(parts.length, Number(session.part_count));

  const signedParts = [];
  for (let offset = 0; offset < parts.length; offset += 10) {
    const batch = parts.slice(offset, offset + 10);
    const { body } = await requestJson(`/v1/uploads/${uploadId}/parts`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        parts: batch.map(({ part_number, checksum_sha256 }) => ({
          part_number,
          checksum_sha256,
        })),
      }),
    });
    signedParts.push(...body.parts);
  }

  const completed = [];
  for (let offset = 0; offset < parts.length; offset += Number(session.max_parallel_parts)) {
    const batch = parts.slice(offset, offset + Number(session.max_parallel_parts));
    const uploaded = await Promise.all(
      batch.map(async (part) => {
        const signed = signedParts.find((candidate) => candidate.part_number === part.part_number);
        assert.ok(signed, `missing signed request for part ${part.part_number}`);
        const response = await fetch(signed.url, {
          method: signed.method,
          headers: signed.headers,
          body: part.bytes,
        });
        if (!response.ok) {
          throw new Error(`direct part ${part.part_number} upload returned ${response.status}`);
        }
        const etag = response.headers.get("etag");
        assert.ok(etag, `direct part ${part.part_number} upload omitted ETag`);
        return {
          part_number: part.part_number,
          etag,
          checksum_sha256: part.checksum_sha256,
        };
      }),
    );
    completed.push(...uploaded);
  }
  return completed.sort((left, right) => left.part_number - right.part_number);
}

async function main() {
  const environment = parseEnv(await readFile(envFile, "utf8"));
  const apiKey = process.env.REND_API_KEY ?? environment.REND_DEV_API_KEY;
  assert.ok(apiKey, `REND_DEV_API_KEY is missing from ${envFile}`);
  const authorization = `Bearer ${apiKey}`;
  const directory = await mkdtemp(join(tmpdir(), "rend-selfhost-smoke-"));
  const fixture = suppliedFixture ?? join(directory, "fixture.mp4");
  let assetId;

  try {
    if (!suppliedFixture) createFixture(fixture);
    const source = await readFile(fixture);
    const { body: session } = await requestJson("/v1/uploads", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": `selfhost-smoke-${randomUUID()}`,
      },
      body: JSON.stringify({
        content_type: "video/mp4",
        content_length: source.byteLength,
        filename: "selfhost-smoke.mp4",
      }),
    });
    assetId = session.asset_id;
    const completedParts = await uploadParts(session.upload_id, session, source, authorization);
    await requestJson(`/v1/uploads/${session.upload_id}/complete`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ parts: completedParts }),
    });

    const deadline = Date.now() + processingDeadlineMs;
    let asset;
    while (Date.now() < deadline) {
      ({ body: asset } = await requestJson(`/v1/assets/${assetId}`, {
        headers: { authorization },
      }));
      if (asset.playable_state === "hls_ready") break;
      if (asset.playable_state === "failed") {
        throw new Error(`media processing failed for ${assetId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(asset?.playable_state, "hls_ready", "asset did not become HLS-playable before timeout");

    const bootstrapResponse = await fetch(`${rootUrl}/api/player/${assetId}`);
    const bootstrap = await responseBody(bootstrapResponse);
    assert.equal(bootstrapResponse.status, 200, JSON.stringify(bootstrap));
    assert.equal(bootstrap.playable_state, "hls_ready");
    assert.ok(bootstrap.playback_url);
    const setCookie = bootstrapResponse.headers.get("set-cookie");
    assert.ok(setCookie, "playback bootstrap omitted its authenticated playback cookie");
    const cookie = setCookie.split(";", 1)[0];
    const playbackUrl = new URL(bootstrap.playback_url, rootUrl);
    const playbackResponse = await fetch(playbackUrl, { headers: { cookie } });
    const playbackBytes = Buffer.from(await playbackResponse.arrayBuffer());
    assert.equal(
      playbackResponse.status,
      200,
      `${playbackUrl} returned ${playbackResponse.status}: ${playbackBytes.toString("utf8", 0, 1_000)}`,
    );
    assert.match(playbackResponse.headers.get("content-type") ?? "", /mpegurl|video\/mp4/);
    assert.ok(playbackBytes.byteLength > 0);

    const telemetry = await requestJson("/api/player/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            playback_session_id: `selfhost-smoke-${randomUUID()}`,
            asset_id: assetId,
            phase: "source_selected",
            event_time_ms: Date.now(),
            selected_playback_mode: "native_hls",
            selected_artifact_path: "hls/master.m3u8",
          },
        ],
      }),
    });
    assert.equal(telemetry.body.accepted, 1);

    if (keepAsset) {
      console.log(`Self-host public smoke playback asset: ${assetId}`);
      assetId = undefined;
      return;
    }

    const deletion = await requestJson(`/v1/assets/${assetId}`, {
      method: "DELETE",
      headers: { authorization },
    });
    assert.equal(deletion.body.deleted, true);
    assetId = undefined;

    const deletedPlayback = await fetch(playbackUrl, { headers: { cookie } });
    assert.notEqual(deletedPlayback.status, 200, "deleted media remained accessible through playback");
    console.log("Self-host public smoke passed: direct multipart upload, HLS processing, authenticated playback, telemetry, and deletion.");
  } finally {
    if (assetId) {
      await fetch(`${rootUrl}/v1/assets/${assetId}`, {
        method: "DELETE",
        headers: { authorization },
      }).catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
