import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRendToolHandlers } from "../dist/tools.js";

const ASSET_ID = "00000000-0000-0000-0000-000000000001";

function config(overrides = {}) {
  return {
    apiKey: "rend_test_unit",
    apiBaseUrl: "https://api.rend.so/",
    siteBaseUrl: "https://rend.so/",
    maxUploadBytes: 1024,
    ...overrides,
  };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async uploadAsset(_body, options) {
        calls.push({ method: "uploadAsset", options });
        return {
          asset_id: ASSET_ID,
          source_state: "uploaded",
          playable_state: "not_playable",
          byte_size: options.contentLength,
          source_object_key: "must-not-leak",
        };
      },
      async waitForPlayableAsset(assetId) {
        calls.push({ method: "waitForPlayableAsset", assetId });
        return {
          asset_id: assetId,
          source_state: "uploaded",
          playable_state: "hls_ready",
          created_at: "2026-06-14T10:00:00.000Z",
          updated_at: "2026-06-14T10:00:01.000Z",
          artifacts: [{ kind: "manifest", content_type: "application/vnd.apple.mpegurl", byte_size: 12 }],
        };
      },
      async getAsset(assetId) {
        calls.push({ method: "getAsset", assetId });
        return {
          asset_id: assetId,
          source_state: "uploaded",
          playable_state: "hls_ready",
          created_at: "2026-06-14T10:00:00.000Z",
          updated_at: "2026-06-14T10:00:01.000Z",
          artifacts: [{ kind: "opener", content_type: "video/mp4", byte_size: 7 }],
        };
      },
      async listAssets() {
        calls.push({ method: "listAssets" });
        return {
          assets: [
            {
              asset_id: ASSET_ID,
              source_state: "uploaded",
              playable_state: "hls_ready",
              created_at: "2026-06-14T10:00:00.000Z",
              updated_at: "2026-06-14T10:00:01.000Z",
              artifact_count: 2,
            },
          ],
        };
      },
      async getPlaybackBootstrap(assetId) {
        calls.push({ method: "getPlaybackBootstrap", assetId });
        return {
          status: "ready",
          asset_id: assetId,
          source_state: "uploaded",
          playable_state: "hls_ready",
          playback_url: `https://ash-1.play.rend.so/v/${assetId}/hls/master.m3u8?token=secret`,
          playback_content_type: "application/vnd.apple.mpegurl",
          playback_token: "secret",
          playback_token_expires_at: 1781432100,
          ttl_seconds: 900,
          opener_url: `https://ash-1.play.rend.so/v/${assetId}/opener.mp4`,
          opener_content_type: "video/mp4",
          manifest_url: `https://ash-1.play.rend.so/v/${assetId}/hls/master.m3u8`,
          manifest_content_type: "application/vnd.apple.mpegurl",
          prefetch_hints: [
            {
              artifact_path: "hls/720p/index.m3u8",
              url: "http://rend-edge:4100/internal/cache/inspect?token=secret",
              content_type: "application/vnd.apple.mpegurl",
            },
            {
              artifact_path: "hls/720p/segment_00000.ts",
              url: `https://ash-1.play.rend.so/v/${assetId}/hls/720p/segment_00000.ts`,
              content_type: "video/mp2t",
            },
          ],
        };
      },
      async deleteAsset(assetId) {
        calls.push({ method: "deleteAsset", assetId });
        return {
          asset_id: assetId,
          deleted: true,
          already_deleted: false,
          origin_objects_deleted: 3,
          purge_attempted: true,
        };
      },
      async getPlaybackAnalytics(assetId) {
        calls.push({ method: "getPlaybackAnalytics", assetId });
        return {
          asset_id: assetId,
          window_started_at: "2026-06-14T09:00:00.000Z",
          window_ended_at: "2026-06-14T10:00:00.000Z",
          request_count: 1,
          bytes_served: 7,
          cache_status_counts: { HIT: 1 },
          status_code_counts: { 200: 1 },
        };
      },
      ...overrides,
    },
  };
}

async function withTempFile(name, bytes, fn) {
  const dir = await mkdtemp(join(tmpdir(), "rend-mcp-"));
  try {
    const filePath = join(dir, name);
    await writeFile(filePath, bytes);
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("upload validates size and content type before calling Rend", async () => {
  const { client, calls } = fakeClient();
  const tools = createRendToolHandlers(client, config({ maxUploadBytes: 8 }));

  await withTempFile("fixture.mp4", Buffer.from("not a video but over limit"), async (filePath) => {
    const result = await tools.rend_upload_video({ file_path: filePath, content_type: "video/mp4" });
    const body = parse(result);
    assert.equal(result.isError, true);
    assert.equal(body.error.code, "limit_exceeded");
    assert.equal(calls.length, 0);
  });
});

test("upload rejects detectable non-video content", async () => {
  const { client, calls } = fakeClient();
  const tools = createRendToolHandlers(client, config());

  await withTempFile("image.mp4", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), async (filePath) => {
    const result = await tools.rend_upload_video({ file_path: filePath, content_type: "video/mp4" });
    const body = parse(result);
    assert.equal(result.isError, true);
    assert.equal(body.error.code, "unsupported_media_type");
    assert.equal(calls.length, 0);
  });
});

test("upload returns stable public fields and embed links", async () => {
  const { client } = fakeClient();
  const tools = createRendToolHandlers(client, config());
  const mp4Head = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

  await withTempFile("fixture.mp4", mp4Head, async (filePath) => {
    const result = await tools.rend_upload_video({
      file_path: filePath,
      wait_for_playable: true,
    });
    const body = parse(result);
    const serialized = JSON.stringify(body);
    assert.equal(body.status, "ok");
    assert.equal(body.asset_id, ASSET_ID);
    assert.equal(body.playable_state, "hls_ready");
    assert.equal(body.embed_url, `https://rend.so/embed/${ASSET_ID}`);
    assert.equal(serialized.includes("source_object_key"), false);
    assert.equal(serialized.includes("rend_test_unit"), false);
  });
});

test("playback output redacts tokens and internal URLs", async () => {
  const { client } = fakeClient();
  const tools = createRendToolHandlers(client, config());
  const result = await tools.rend_get_playback({ asset_id: ASSET_ID });
  const body = parse(result);
  const serialized = JSON.stringify(body);

  assert.equal(body.status, "ok");
  assert.equal(body.source_url, `https://ash-1.play.rend.so/v/${ASSET_ID}/hls/master.m3u8`);
  assert.equal(/"playback_token"\s*:/.test(serialized), false);
  assert.equal(serialized.includes("?token="), false);
  assert.equal(serialized.includes("/internal/"), false);
  assert.equal(body.playback.prefetch_hints.length, 1);
});

test("API errors map to stable MCP error codes", async () => {
  const cases = [
    [{ status: 401, body: { error: "unauthorized" } }, "unauthorized"],
    [{ status: 403, body: { error: "organization is suspended" } }, "suspended"],
    [{ status: 403, body: { error: "limit_exceeded" } }, "limit_exceeded"],
    [{ status: 404, body: { error: "asset not found" } }, "deleted"],
    [{ status: 409, body: { status: "not_playable", message: "Asset is not playable yet" } }, "not_playable"],
  ];

  for (const [error, code] of cases) {
    const { client } = fakeClient({
      async getAsset() {
        throw error;
      },
    });
    const tools = createRendToolHandlers(client, config());
    const result = await tools.rend_get_asset({ asset_id: ASSET_ID });
    const body = parse(result);
    assert.equal(result.isError, true);
    assert.equal(body.error.code, code);
  }
});
