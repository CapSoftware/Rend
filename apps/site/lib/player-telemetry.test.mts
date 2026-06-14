import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPlayerTelemetryEventsForTests,
  recordPlayerTelemetryEvents,
  recentPlayerTelemetryEvents,
  sanitizePlayerTelemetryPayload,
} from "./player-telemetry.ts";

const RECEIVED_AT_MS = 1_781_398_686_000;

test("accepts safe player telemetry and stores only allowlisted fields", () => {
  const result = sanitizePlayerTelemetryPayload(
    {
      events: [
        {
          playback_session_id: "session-1",
          asset_id: "asset-123",
          phase: "bootstrap_complete",
          event_time_ms: RECEIVED_AT_MS - 10,
          bootstrap_start_ms: 0,
          bootstrap_end_ms: 42.4,
          bootstrap_duration_ms: 42.4,
          bootstrap_http_status: 200,
          cache_headers: {
            "cache-control": "public, max-age=60",
            authorization: "Bearer should-not-store",
            "x-rend-region": "london",
          },
          raw_url: "https://edge.example/v/asset-123/hls/master.m3u8?token=secret",
        },
      ],
    },
    RECEIVED_AT_MS
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].bootstrap_end_ms, 42);
  assert.equal(result.events[0].cache_headers?.["cache-control"], "public, max-age=60");
  assert.equal(result.events[0].cache_headers?.["x-rend-region"], "london");
  assert.equal("raw_url" in result.events[0], false);
  assert.equal(result.events[0].cache_headers?.authorization, undefined);
});

test("rejects signed URLs where only artifact paths are allowed", () => {
  const result = sanitizePlayerTelemetryPayload(
    {
      playback_session_id: "session-2",
      asset_id: "asset-123",
      phase: "source_selected",
      event_time_ms: RECEIVED_AT_MS,
      selected_playback_mode: "hls_js",
      selected_artifact_path:
        "https://edge.example/v/asset-123/hls/master.m3u8?token=secret",
    },
    RECEIVED_AT_MS
  );

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: "invalid_selected_artifact_path",
  });
});

test("redacts URLs, tokens, cookies, and Authorization-shaped text", () => {
  const result = sanitizePlayerTelemetryPayload(
    {
      playback_session_id: "session-3",
      asset_id: "asset-123",
      phase: "playback_failure",
      event_time_ms: RECEIVED_AT_MS,
      playback_failure_code: "media_error_4",
      playback_failure_reason:
        "failed https://edge.example/v/asset-123?token=secret Authorization: Bearer abc123 cookie: sid=secret",
      cache_headers: {
        "server-timing": 'edge;desc="https://edge.example/v/a?token=secret"',
        "set-cookie": "sid=secret",
      },
    },
    RECEIVED_AT_MS
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const serialized = JSON.stringify(result.events[0]);
  assert.equal(serialized.includes("edge.example"), false);
  assert.equal(serialized.includes("abc123"), false);
  assert.equal(serialized.includes("sid=secret"), false);
  assert.equal(result.events[0].cache_headers?.["set-cookie"], undefined);
  assert.match(result.events[0].playback_failure_reason ?? "", /\[redacted/);
  assert.match(result.events[0].cache_headers?.["server-timing"] ?? "", /\[redacted-url\]/);
});

test("rejects oversized event batches", () => {
  const event = {
    playback_session_id: "session-4",
    asset_id: "asset-123",
    phase: "player_load",
    event_time_ms: RECEIVED_AT_MS,
  };
  const result = sanitizePlayerTelemetryPayload(
    { events: Array.from({ length: 17 }, () => event) },
    RECEIVED_AT_MS
  );

  assert.deepEqual(result, {
    ok: false,
    status: 413,
    error: "event_batch_too_large",
  });
});

test("keeps recent sanitized events filterable by asset and session", () => {
  clearPlayerTelemetryEventsForTests();
  const result = sanitizePlayerTelemetryPayload(
    [
      {
        playback_session_id: "session-5",
        asset_id: "asset-123",
        phase: "player_load",
        event_time_ms: RECEIVED_AT_MS,
      },
      {
        playback_session_id: "session-6",
        asset_id: "asset-456",
        phase: "player_load",
        event_time_ms: RECEIVED_AT_MS,
      },
    ],
    RECEIVED_AT_MS
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  recordPlayerTelemetryEvents(result.events);
  assert.equal(recentPlayerTelemetryEvents({ assetId: "asset-123" }).length, 1);
  assert.equal(
    recentPlayerTelemetryEvents({ playbackSessionId: "session-6" })[0]
      .playback_session_id,
    "session-6"
  );
});
