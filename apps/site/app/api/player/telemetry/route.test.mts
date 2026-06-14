import assert from "node:assert/strict";
import test from "node:test";
import { clearPlayerTelemetryEventsForTests } from "../../../../lib/player-telemetry.ts";
import { POST } from "./route.ts";
import { GET } from "./recent/route.ts";

const EVENT_TIME_MS = 1_781_398_686_000;

function telemetryRequest(body: unknown, init: RequestInit = {}) {
  return new Request("http://127.0.0.1:3000/api/player/telemetry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function responseJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

test("POST accepts sanitized player telemetry and recent endpoint returns it", async () => {
  clearPlayerTelemetryEventsForTests();

  const response = await POST(
    telemetryRequest({
      events: [
        {
          playback_session_id: "route-session-1",
          asset_id: "asset-123",
          phase: "source_selected",
          event_time_ms: EVENT_TIME_MS,
          selected_playback_mode: "hls_js",
          selected_artifact_path: "hls/master.m3u8",
          cache_headers: {
            "x-rend-cache": "HIT",
            authorization: "Bearer should-not-store",
          },
          raw_url: "https://edge.example/v/asset-123/hls/master.m3u8?token=secret",
        },
      ],
    })
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), { status: "ok", accepted: 1 });

  const recent = await GET(
    new Request(
      "http://127.0.0.1:3000/api/player/telemetry/recent?playbackSessionId=route-session-1"
    )
  );
  const recentBody = await responseJson(recent);
  const events = recentBody.events as Array<Record<string, unknown>>;
  const serialized = JSON.stringify(recentBody);

  assert.equal(recent.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].selected_artifact_path, "hls/master.m3u8");
  assert.equal(serialized.includes("token="), false);
  assert.equal(serialized.includes("edge.example"), false);
  assert.equal(serialized.includes("authorization"), false);
});

test("POST rejects non-json and malformed JSON bodies", async () => {
  const wrongContentType = await POST(
    new Request("http://127.0.0.1:3000/api/player/telemetry", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    })
  );
  assert.equal(wrongContentType.status, 415);
  assert.equal((await responseJson(wrongContentType)).error, "content_type_must_be_application_json");

  const malformed = await POST(telemetryRequest("{"));
  assert.equal(malformed.status, 400);
  assert.equal((await responseJson(malformed)).error, "invalid_json");
});

test("POST rejects bounded body and event-count violations", async () => {
  const tooLargeByHeader = await POST(
    telemetryRequest("{}", {
      headers: {
        "content-length": String(24 * 1024 + 1),
        "content-type": "application/json",
      },
    })
  );
  assert.equal(tooLargeByHeader.status, 413);
  assert.equal((await responseJson(tooLargeByHeader)).error, "body_too_large");

  const event = {
    playback_session_id: "route-session-2",
    asset_id: "asset-123",
    phase: "player_load",
    event_time_ms: EVENT_TIME_MS,
  };
  const tooManyEvents = await POST(
    telemetryRequest({ events: Array.from({ length: 17 }, () => event) })
  );
  assert.equal(tooManyEvents.status, 413);
  assert.equal((await responseJson(tooManyEvents)).error, "event_batch_too_large");
});

test("recent endpoint is production-disabled unless telemetry debug is enabled", async () => {
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDebug = process.env.REND_PLAYER_TELEMETRY_DEBUG;

  try {
    env.NODE_ENV = "production";
    delete env.REND_PLAYER_TELEMETRY_DEBUG;

    const disabled = await GET(
      new Request("https://rend.example/api/player/telemetry/recent")
    );
    assert.equal(disabled.status, 404);
    assert.equal((await responseJson(disabled)).status, "disabled");

    env.REND_PLAYER_TELEMETRY_DEBUG = "1";
    const enabled = await GET(
      new Request("https://rend.example/api/player/telemetry/recent?limit=1")
    );
    assert.equal(enabled.status, 200);
    assert.equal((await responseJson(enabled)).status, "ok");
  } finally {
    if (previousNodeEnv === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = previousNodeEnv;
    }

    if (previousDebug === undefined) {
      delete env.REND_PLAYER_TELEMETRY_DEBUG;
    } else {
      env.REND_PLAYER_TELEMETRY_DEBUG = previousDebug;
    }
  }
});
