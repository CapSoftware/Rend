import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertMatchesResponseSchema,
  loadOpenApiSpec,
} from "../../../scripts/openapi/schema-validator.mjs";
import { safePlaybackBootstrapResponse } from "./player-bootstrap.ts";
import { POST as postPlayerTelemetry } from "../app/api/player/telemetry/route.ts";
import { GET as getPlaybackBootstrap } from "../app/api/player/[assetId]/route.ts";

const SPEC_PATH = fileURLToPath(
  new URL("../../../docs/openapi/rend-public-api.openapi.json", import.meta.url)
);
const SDK_PATH = fileURLToPath(new URL("../../../packages/sdk/src/index.ts", import.meta.url));
const ASSET_ID = "00000000-0000-0000-0000-000000000001";
const EVENT_ID = "00000000-0000-0000-0000-000000000101";
const EVENT_TIME_MS = 1_781_398_686_000;

const spec = await loadOpenApiSpec(SPEC_PATH);

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function responseJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function telemetryRequest(body: unknown, init: RequestInit = {}) {
  return new Request("https://rend.example/api/player/telemetry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function withTelemetryIngestEnabled(callback: () => Promise<void>) {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.REND_PLAYER_TELEMETRY_INGEST;
  env.REND_PLAYER_TELEMETRY_INGEST = "1";

  try {
    await callback();
  } finally {
    if (previous === undefined) {
      delete env.REND_PLAYER_TELEMETRY_INGEST;
    } else {
      env.REND_PLAYER_TELEMETRY_INGEST = previous;
    }
  }
}

test("control-plane success response bodies match the public OpenAPI schemas", () => {
  assertMatchesResponseSchema(spec, "/v1/videos", "post", 201, {
    asset_id: ASSET_ID,
    source_state: "uploaded",
    playable_state: "not_playable",
    source_artifact_id: "internal-artifact-id-is-ignored",
    source_object_key: `videos/${ASSET_ID}/source`,
    byte_size: 428815,
  });

  assertMatchesResponseSchema(spec, "/v1/assets", "get", 200, {
    assets: [
      {
        asset_id: ASSET_ID,
        source_state: "uploaded",
        playable_state: "hls_ready",
        created_at: "2026-06-14T10:00:00.000Z",
        updated_at: "2026-06-14T10:01:00.000Z",
        source_byte_size: 428815,
        duration_ms: 12000,
        has_thumbnail: true,
        artifact_count: 4,
      },
    ],
  });

  assertMatchesResponseSchema(spec, "/v1/assets/{assetId}", "get", 200, {
    asset_id: ASSET_ID,
    source_state: "uploaded",
    playable_state: "hls_ready",
    created_at: "2026-06-14T10:00:00.000Z",
    updated_at: "2026-06-14T10:01:00.000Z",
    artifacts: [
      { kind: "opener", content_type: "video/mp4", byte_size: 1024 },
      { kind: "manifest", content_type: "application/vnd.apple.mpegurl", byte_size: 512 },
    ],
  });

  assertMatchesResponseSchema(spec, "/v1/assets/{assetId}", "delete", 200, {
    asset_id: ASSET_ID,
    deleted: true,
    already_deleted: false,
    origin_objects_deleted: 4,
    purge_attempted: true,
  });

  assertMatchesResponseSchema(spec, "/v1/assets/{assetId}/events", "get", 200, {
    asset_id: ASSET_ID,
    events: [
      {
        id: EVENT_ID,
        asset_id: ASSET_ID,
        sequence: 1,
        event_type: "source.uploaded",
        created_at: "2026-06-14T10:00:00.000Z",
        metadata: { source_state: "uploaded", playable_state: "not_playable" },
      },
    ],
    next_after_sequence: 1,
  });

  assertMatchesResponseSchema(spec, "/v1/assets/{assetId}/analytics/playback", "get", 200, {
    asset_id: ASSET_ID,
    window_started_at: "2026-06-14T09:00:00.000Z",
    window_ended_at: "2026-06-14T10:00:00.000Z",
    request_count: 3,
    bytes_served: 1048576,
    cache_status_counts: { HIT: 2, MISS: 1 },
    status_code_counts: { "200": 3 },
    first_seen: "2026-06-14T09:10:00.000Z",
    last_seen: "2026-06-14T09:20:00.000Z",
  });
});

test("common control-plane errors match the public OpenAPI schemas", () => {
  assertMatchesResponseSchema(spec, "/v1/assets", "get", 401, { error: "unauthorized" });
  assertMatchesResponseSchema(spec, "/v1/assets/{assetId}", "delete", 403, {
    error: "organization is suspended",
  });
  assertMatchesResponseSchema(spec, "/v1/videos", "post", 403, {
    error: "limit_exceeded",
  });
  assertMatchesResponseSchema(spec, "/v1/assets/{assetId}", "get", 404, {
    error: "asset not found",
  });
  assertMatchesResponseSchema(spec, "/v1/assets/{assetId}", "get", 400, {
    error: "malformed asset_id",
  });
});

test("site playback bootstrap response is tokenless and matches the OpenAPI schema", () => {
  const upstreamPlayback = {
    asset_id: ASSET_ID,
    source_state: "uploaded",
    playable_state: "hls_ready",
    playback_url: `https://edge.rend.so/v/${ASSET_ID}/hls/master.m3u8`,
    playback_content_type: "application/vnd.apple.mpegurl",
    playback_token_expires_at: 1_781_432_100,
    ttl_seconds: 900,
    manifest_url: `https://edge.rend.so/v/${ASSET_ID}/hls/master.m3u8`,
    manifest_content_type: "application/vnd.apple.mpegurl",
    playback_token: "must-not-appear",
    prefetch_hints: [
      {
        artifact_path: "hls/360p/index.m3u8",
        url: `https://edge.rend.so/v/${ASSET_ID}/hls/360p/index.m3u8`,
        content_type: "application/vnd.apple.mpegurl",
      },
      {
        artifact_path: "hls/360p/init_360p.mp4",
        url: `https://edge.rend.so/v/${ASSET_ID}/hls/360p/init_360p.mp4`,
        content_type: "video/mp4",
      },
    ],
  } as Parameters<typeof safePlaybackBootstrapResponse>[1] & { playback_token: string };

  const response = jsonRoundTrip(
    safePlaybackBootstrapResponse(
      ASSET_ID,
      upstreamPlayback,
      null
    )
  );

  assertMatchesResponseSchema(spec, "/api/player/{assetId}", "get", 200, response);
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes("edge.rend.so"), false);
  assert.equal(serialized.includes("must-not-appear"), false);
  assert.equal(serialized.includes("?token="), false);
  assert.equal(/"playback_token"\s*:/.test(serialized), false);
});

test("site playback bootstrap can emit direct Tigris URLs without token leakage", () => {
  const upstreamPlayback = {
    asset_id: ASSET_ID,
    source_state: "uploaded",
    playable_state: "hls_ready",
    playback_url: `https://api.rend.so/v/${ASSET_ID}/hls/master.m3u8`,
    playback_content_type: "application/vnd.apple.mpegurl",
    playback_token_expires_at: 1_781_432_100,
    ttl_seconds: 900,
    manifest_url: `https://api.rend.so/v/${ASSET_ID}/hls/master.m3u8`,
    manifest_content_type: "application/vnd.apple.mpegurl",
    playback_token: "must-not-appear",
    prefetch_hints: [
      {
        artifact_path: "hls/480p/index.m3u8",
        url: `https://api.rend.so/v/${ASSET_ID}/hls/480p/index.m3u8`,
        content_type: "application/vnd.apple.mpegurl",
      },
      {
        artifact_path: "hls/480p/segment_00000.m4s",
        url: `https://api.rend.so/v/${ASSET_ID}/hls/480p/segment_00000.m4s`,
        content_type: "video/mp4",
      },
    ],
  } as Parameters<typeof safePlaybackBootstrapResponse>[1] & { playback_token: string };

  const response = jsonRoundTrip(
    safePlaybackBootstrapResponse(ASSET_ID, upstreamPlayback, "https://api.rend.so", null, "omit")
  );

  assertMatchesResponseSchema(spec, "/api/player/{assetId}", "get", 200, response);
  const serialized = JSON.stringify(response);
  assert.equal(response?.playback_url, `https://api.rend.so/v/${ASSET_ID}/hls/master.m3u8`);
  assert.equal(response?.playback_credential_mode, "omit");
  assert.equal(response?.prefetch_hints[0]?.url, `https://api.rend.so/v/${ASSET_ID}/hls/480p/index.m3u8`);
  assert.equal(serialized.includes("/api/player/"), false);
  assert.equal(serialized.includes("must-not-appear"), false);
  assert.equal(serialized.includes("?token="), false);
  assert.equal(/"playback_token"\s*:/.test(serialized), false);
});

test("site playback route not-found response matches the OpenAPI schema", async () => {
  const response = await getPlaybackBootstrap(
    new Request("https://rend.example/api/player/not-a-uuid"),
    { params: Promise.resolve({ assetId: "not-a-uuid" }) }
  );
  const body = await responseJson(response);

  assert.equal(response.status, 404);
  assertMatchesResponseSchema(spec, "/api/player/{assetId}", "get", 404, body);
});

test("site not-playable response shape matches the OpenAPI schema", () => {
  assertMatchesResponseSchema(spec, "/api/player/{assetId}", "get", 409, {
    status: "not_playable",
    asset_id: ASSET_ID,
    source_state: "uploaded",
    playable_state: "not_playable",
    message: "Asset is not playable yet",
  });
});

test("player telemetry route responses match the OpenAPI schemas", async () => {
  await withTelemetryIngestEnabled(async () => {
    const accepted = await postPlayerTelemetry(
      telemetryRequest({
        events: [
          {
            playback_session_id: "contract-session-1",
            asset_id: ASSET_ID,
            phase: "source_selected",
            event_time_ms: EVENT_TIME_MS,
            selected_playback_mode: "hls_js",
            selected_artifact_path: "hls/master.m3u8",
          },
        ],
      })
    );
    assert.equal(accepted.status, 200);
    assertMatchesResponseSchema(
      spec,
      "/api/player/telemetry",
      "post",
      200,
      await responseJson(accepted)
    );

    const malformed = await postPlayerTelemetry(telemetryRequest("{"));
    assert.equal(malformed.status, 400);
    assertMatchesResponseSchema(
      spec,
      "/api/player/telemetry",
      "post",
      400,
      await responseJson(malformed)
    );

    const tooManyEvents = await postPlayerTelemetry(
      telemetryRequest({
        events: Array.from({ length: 17 }, () => ({
          playback_session_id: "contract-session-2",
          asset_id: ASSET_ID,
          phase: "player_load",
          event_time_ms: EVENT_TIME_MS,
        })),
      })
    );
    assert.equal(tooManyEvents.status, 413);
    assertMatchesResponseSchema(
      spec,
      "/api/player/telemetry",
      "post",
      413,
      await responseJson(tooManyEvents)
    );

    const wrongContentType = await postPlayerTelemetry(
      new Request("https://rend.example/api/player/telemetry", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      })
    );
    assert.equal(wrongContentType.status, 415);
    assertMatchesResponseSchema(
      spec,
      "/api/player/telemetry",
      "post",
      415,
      await responseJson(wrongContentType)
    );
  });
});

test("public spec and generated client do not expose internal surfaces or signed playback tokens", async () => {
  const specText = await readFile(SPEC_PATH, "utf8");
  const clientText = await readFile(SDK_PATH, "utf8");

  for (const text of [specText, clientText]) {
    assert.equal(text.includes("/internal/"), false);
    assert.equal(text.includes("/operator"), false);
    assert.equal(text.includes("x-rend-site-token"), false);
    assert.equal(text.includes("x-rend-internal-token"), false);
    assert.equal(text.includes("source_object_key"), false);
    assert.equal(text.includes("source_artifact_id"), false);
    assert.equal(text.includes("?token="), false);
    assert.equal(/"playback_token"\s*:/.test(text), false);
  }
});
