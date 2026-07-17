import assert from "node:assert/strict";
import test from "node:test";
import { RendClient } from "./index.ts";

const ASSET_ID = "00000000-0000-0000-0000-000000000001";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("generated client uploads, polls playable state, fetches bootstrap, and deletes", async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null; contentType: string | null }> = [];
  const responses = [
    jsonResponse(
      {
        asset_id: ASSET_ID,
        source_state: "uploaded",
        playable_state: "not_playable",
        byte_size: 7,
      },
      201
    ),
    jsonResponse({
      asset_id: ASSET_ID,
      source_state: "uploaded",
      playable_state: "not_playable",
      created_at: "2026-06-14T10:00:00.000Z",
      updated_at: "2026-06-14T10:00:00.000Z",
      artifacts: [{ kind: "source", content_type: "video/mp4", byte_size: 7 }],
    }),
    jsonResponse({
      asset_id: ASSET_ID,
      source_state: "uploaded",
      playable_state: "hls_ready",
      created_at: "2026-06-14T10:00:00.000Z",
      updated_at: "2026-06-14T10:00:05.000Z",
      artifacts: [
        { kind: "opener", content_type: "video/mp4", byte_size: 1024 },
        { kind: "manifest", content_type: "application/vnd.apple.mpegurl", byte_size: 512 },
      ],
    }),
    jsonResponse({
      status: "ready",
      asset_id: ASSET_ID,
      source_state: "uploaded",
      playable_state: "hls_ready",
      playback_url: `/api/player/${ASSET_ID}/artifact/hls/master.m3u8`,
      playback_content_type: "application/vnd.apple.mpegurl",
      playback_token_expires_at: 1_781_432_100,
      ttl_seconds: 900,
      manifest_url: `/api/player/${ASSET_ID}/artifact/hls/master.m3u8`,
      manifest_content_type: "application/vnd.apple.mpegurl",
      prefetch_hints: [],
    }),
    jsonResponse({
      asset_id: ASSET_ID,
      deleted: true,
      already_deleted: false,
      origin_objects_deleted: 3,
      purge_attempted: true,
    }),
  ];

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
    });
    const response = responses.shift();
    if (!response) throw new Error(`unexpected fetch call to ${String(input)}`);
    return response;
  };

  const client = new RendClient({
    apiKey: "rend_test_local",
    apiBaseUrl: "http://api.rend.test",
    siteBaseUrl: "http://site.rend.test",
    fetch: fetchImpl as typeof fetch,
  });

  const uploaded = await client.uploadAsset(new Blob(["fixture"]), {
    contentType: "video/mp4",
    contentLength: 7,
  });
  const playable = await client.waitForPlayableAsset(uploaded.asset_id, {
    intervalMs: 0,
    timeoutMs: 1000,
  });
  const bootstrap = await client.getPlaybackBootstrap(playable.asset_id);
  const deleted = await client.deleteAsset(playable.asset_id);

  assert.equal(uploaded.asset_id, ASSET_ID);
  assert.equal(playable.playable_state, "hls_ready");
  assert.equal(bootstrap.status, "ready");
  assert.equal(deleted.deleted, true);
  assert.equal(responses.length, 0);

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    "POST /v1/videos",
    "GET /v1/assets/00000000-0000-0000-0000-000000000001",
    "GET /v1/assets/00000000-0000-0000-0000-000000000001",
    "GET /api/player/00000000-0000-0000-0000-000000000001",
    "DELETE /v1/assets/00000000-0000-0000-0000-000000000001",
  ]);
  assert.equal(calls[0].authorization, "Bearer rend_test_local");
  assert.equal(calls[0].contentType, "video/mp4");
  assert.equal(calls[3].authorization, null);
});

test("generated client manages resumable multipart upload sessions", async () => {
  const uploadId = "00000000-0000-0000-0000-000000000002";
  const checksum = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const uploading = {
    asset_id: ASSET_ID,
    upload_id: uploadId,
    part_size: 16 * 1024 * 1024,
    part_count: 1,
    max_parallel_parts: 6,
    expires_at: "2026-07-18T10:00:00.000Z",
    status: "uploading",
    uploaded_parts: [],
  };
  const calls: Array<{ url: string; method: string; idempotencyKey: string | null; body: unknown }> = [];
  const responses = [
    jsonResponse(uploading, 201),
    jsonResponse(uploading),
    jsonResponse({
      upload_id: uploadId,
      parts: [
        {
          part_number: 1,
          url: "https://objects.example.test/source?signature=redacted",
          method: "PUT",
          headers: { "x-amz-checksum-sha256": checksum },
        },
      ],
    }),
    jsonResponse({ ...uploading, status: "completed" }),
    new Response(null, { status: 204 }),
  ];
  const client = new RendClient({
    apiKey: "rend_test_local",
    apiBaseUrl: "http://api.rend.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        idempotencyKey: headers.get("idempotency-key"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const response = responses.shift();
      if (!response) throw new Error(`unexpected fetch call to ${String(input)}`);
      return response;
    }) as typeof fetch,
  });

  await client.createMultipartUpload(
    { content_type: "video/mp4", content_length: 7, filename: "fixture.mp4" },
    { idempotencyKey: "sdk-upload-1" }
  );
  await client.getMultipartUpload(uploadId);
  await client.signMultipartUploadParts(uploadId, {
    parts: [{ part_number: 1, checksum_sha256: checksum }],
  });
  await client.completeMultipartUpload(uploadId, {
    parts: [{ part_number: 1, etag: "etag-1", checksum_sha256: checksum }],
  });
  await client.abortMultipartUpload(uploadId);

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    "POST /v1/uploads",
    `GET /v1/uploads/${uploadId}`,
    `POST /v1/uploads/${uploadId}/parts`,
    `POST /v1/uploads/${uploadId}/complete`,
    `DELETE /v1/uploads/${uploadId}`,
  ]);
  assert.equal(calls[0].idempotencyKey, "sdk-upload-1");
  assert.deepEqual(calls[2].body, {
    parts: [{ part_number: 1, checksum_sha256: checksum }],
  });
  assert.equal(responses.length, 0);
});
