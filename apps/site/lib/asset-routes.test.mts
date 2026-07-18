import assert from "node:assert/strict";
import test from "node:test";
import {
  AssetApiError,
  emptyAnalyticsLive,
  emptyAnalyticsOverview,
  fetchAnalyticsOverview,
  fetchAssetDetail,
  fetchAssetPlayerTelemetry,
  fetchAssetThumbnail,
  isAnalyticsTemporarilyUnavailable,
  listAssets,
  uploadAsset,
} from "./asset-api.ts";

const AUTH_CONTEXT = {
  organizationId: "00000000-0000-0000-0000-000000000001",
};

const ENV_KEYS = [
  "REND_SITE_MAX_UPLOAD_BYTES",
  "REND_API_BASE_URL",
  "REND_SITE_INTERNAL_TOKEN",
  "REND_ENV",
  "REND_ENV_PROFILE",
];

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);

  try {
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withMockFetch<T>(
  handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
  run: () => Promise<T>
) {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function routeEnv(extra: Record<string, string | undefined> = {}) {
  return {
    REND_ENV: "local",
    REND_API_BASE_URL: "http://127.0.0.1:4000",
    REND_SITE_INTERNAL_TOKEN: "site-internal-token",
    ...extra,
  };
}

test("asset client sends site internal auth headers and never bearer dev auth", async () => {
  await withEnv(routeEnv(), async () => {
    await withMockFetch(async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-rend-site-token"), "site-internal-token");
      assert.equal(headers.get("x-rend-organization-id"), AUTH_CONTEXT.organizationId);
      assert.equal(headers.get("authorization"), null);
      return Response.json({ assets: [] });
    }, async () => {
      assert.deepEqual(await listAssets(AUTH_CONTEXT), { status: "ok", assets: [] });
    });
  });
});

test("asset client preserves list asset duration metadata", async () => {
  await withEnv(routeEnv(), async () => {
    await withMockFetch(async () => {
      return Response.json({
        assets: [
          {
            asset_id: "00000000-0000-0000-0000-000000000001",
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
    }, async () => {
      assert.deepEqual(await listAssets(AUTH_CONTEXT), {
        status: "ok",
        assets: [
          {
            asset_id: "00000000-0000-0000-0000-000000000001",
            source_state: "uploaded",
            playable_state: "hls_ready",
            created_at: "2026-06-14T10:00:00.000Z",
            updated_at: "2026-06-14T10:01:00.000Z",
            source_byte_size: 428815,
            duration_ms: 12000,
            has_thumbnail: true,
            artifact_count: 4,
            suspended_at: undefined,
            suspension_reason: undefined,
            organization_suspended_at: undefined,
            organization_suspension_reason: undefined,
          },
        ],
      });
    });
  });
});

test("asset thumbnail client streams binary thumbnail responses without playback bootstrap", async () => {
  await withEnv(routeEnv(), async () => {
    const calls: Array<{ url: string; accept: string | null }> = [];
    await withMockFetch(async (url, init) => {
      calls.push({
        url: String(url),
        accept: new Headers(init?.headers).get("accept"),
      });
      return new Response("jpeg", {
        status: 200,
        headers: {
          "cache-control": "private, max-age=31536000, immutable",
          "content-length": "4",
          "content-type": "image/jpeg",
        },
      });
    }, async () => {
      const response = await fetchAssetThumbnail(
        AUTH_CONTEXT,
        "00000000-0000-0000-0000-000000000001"
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://127.0.0.1:4000/v1/site/assets/00000000-0000-0000-0000-000000000001/thumbnail");
      assert.equal(calls[0].accept, "image/jpeg,image/*;q=0.8,*/*;q=0.5");
      assert.equal(response.headers.get("content-type"), "image/jpeg");
      assert.equal(response.headers.get("cache-control"), "private, max-age=31536000, immutable");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(await response.text(), "jpeg");
    });
  });
});

test("asset player telemetry client reads durable events and strips invalid rows", async () => {
  await withEnv(routeEnv(), async () => {
    const assetId = "00000000-0000-0000-0000-000000000001";
    await withMockFetch(async (url, init) => {
      assert.equal(
        String(url),
        `http://127.0.0.1:4000/v1/site/assets/${assetId}/player-events?limit=20`
      );
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-rend-site-token"), "site-internal-token");
      assert.equal(headers.get("x-rend-organization-id"), AUTH_CONTEXT.organizationId);
      return Response.json({
        asset_id: assetId,
        events: [
          {
            event_id: "player-event-1",
            playback_session_id: "session-1",
            asset_id: assetId,
            phase: "first_frame",
            event_time_ms: 1_765_000_000_000,
            received_at_ms: 1_765_000_000_100,
            selected_playback_mode: "primary",
            selected_artifact_path: "hls/360p/segment_00000.m4s",
            first_frame_ms: 1133,
            browser_name: "Chrome",
          },
          {
            playback_session_id: "invalid session with spaces",
            asset_id: assetId,
            phase: "first_frame",
            event_time_ms: 1,
            received_at_ms: 2,
          },
        ],
      });
    }, async () => {
      assert.deepEqual(await fetchAssetPlayerTelemetry(AUTH_CONTEXT, assetId), [
        {
          event_id: "player-event-1",
          playback_session_id: "session-1",
          asset_id: assetId,
          phase: "first_frame",
          event_time_ms: 1_765_000_000_000,
          received_at_ms: 1_765_000_000_100,
          selected_playback_mode: "primary",
          selected_artifact_path: "hls/360p/segment_00000.m4s",
          first_frame_ms: 1133,
          bootstrap_duration_ms: undefined,
          bootstrap_http_status: undefined,
          stall_duration_ms: undefined,
          watch_delta_ms: undefined,
          playback_failure_code: undefined,
          browser_name: "Chrome",
          browser_version: undefined,
          os_name: undefined,
          os_version: undefined,
          device_type: undefined,
        },
      ]);
    });
  });
});

test("upload client rejects unsupported content types and oversized content-length before upstream", async () => {
  await withEnv(routeEnv({ REND_SITE_MAX_UPLOAD_BYTES: "10" }), async () => {
    let upstreamCalls = 0;
    await withMockFetch(async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 500 });
    }, async () => {
      await assert.rejects(
        uploadAsset(
          AUTH_CONTEXT,
          new Request("https://rend.example/api/assets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ),
        (error) => error instanceof AssetApiError && error.status === 415
      );

      await assert.rejects(
        uploadAsset(
          AUTH_CONTEXT,
          new Request("https://rend.example/api/assets", {
            method: "POST",
            headers: {
              "content-length": "11",
              "content-type": "video/mp4",
            },
            body: "01234567890",
          })
        ),
        (error) => error instanceof AssetApiError && error.status === 413
      );

      assert.equal(upstreamCalls, 0);
    });
  });
});

test("upload client streams to rend-api and strips unsafe upstream fields", async () => {
  await withEnv(routeEnv({ REND_SITE_MAX_UPLOAD_BYTES: "100" }), async () => {
    const calls: Array<{ url: string; contentType: string; bytes: number }> = [];
    await withMockFetch(async (url, init) => {
      const headers = new Headers(init?.headers);
      const body = init?.body ? await new Response(init.body as BodyInit).arrayBuffer() : new ArrayBuffer(0);
      calls.push({
        url: String(url),
        contentType: headers.get("content-type") || "",
        bytes: body.byteLength,
      });
      assert.equal(headers.get("x-rend-site-token"), "site-internal-token");
      assert.equal(headers.get("authorization"), null);

      return Response.json(
        {
          asset_id: "00000000-0000-0000-0000-000000000001",
          source_state: "uploaded",
          playable_state: "not_playable",
          source_artifact_id: "internal-artifact",
          source_object_key: "videos/00000000-0000-0000-0000-000000000001/source",
          byte_size: body.byteLength,
          playback_url: "https://edge.example/v/00000000-0000-0000-0000-000000000001/opener.mp4?token=secret",
        },
        { status: 201 }
      );
    }, async () => {
      const body = await uploadAsset(
        AUTH_CONTEXT,
        new Request("https://rend.example/api/assets", {
          method: "POST",
          headers: {
            "content-length": "3",
            "content-type": "video/mp4",
          },
          body: "abc",
        })
      );
      const serialized = JSON.stringify(body);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://127.0.0.1:4000/v1/videos");
      assert.equal(calls[0].contentType, "video/mp4");
      assert.equal(calls[0].bytes, 3);
      assert.equal(serialized.includes("source_object_key"), false);
      assert.equal(serialized.includes("playback_url"), false);
      assert.equal(serialized.includes("token="), false);
      assert.equal(serialized.includes("site-internal-token"), false);
    });
  });
});

test("asset client propagates only redacted safe upstream errors", async () => {
  await withEnv(routeEnv(), async () => {
    await withMockFetch(async () => {
      return Response.json(
        {
          message:
            "bad upstream https://edge.example/v/asset/opener.mp4?token=secret Authorization: Bearer abc",
        },
        { status: 400 }
      );
    }, async () => {
      await assert.rejects(
        fetchAssetDetail(AUTH_CONTEXT, "00000000-0000-0000-0000-000000000001"),
        (error) => {
          assert.equal(error instanceof AssetApiError, true);
          const serialized = JSON.stringify((error as AssetApiError).body);
          assert.equal((error as AssetApiError).status, 400);
          assert.equal(serialized.includes("edge.example"), false);
          assert.equal(serialized.includes("token=secret"), false);
          assert.equal(serialized.includes("Bearer abc"), false);
          assert.match(String((error as AssetApiError).body.message), /\[redacted/);
          return true;
        }
      );
    });
  });
});

test("analytics overview 404 does not use asset not-found copy", async () => {
  await withEnv(routeEnv(), async () => {
    let calls = 0;
    await withMockFetch(async (url) => {
      calls += 1;
      assert.equal(
        String(url),
        "http://127.0.0.1:4000/v1/analytics/overview?window_seconds=86400"
      );
      return calls === 1
        ? new Response("", { status: 404 })
        : Response.json({ message: "Asset was not found" }, { status: 404 });
    }, async () => {
      await assert.rejects(
        fetchAnalyticsOverview(AUTH_CONTEXT),
        (error) => {
          assert.equal(error instanceof AssetApiError, true);
          assert.equal((error as AssetApiError).status, 404);
          assert.equal((error as AssetApiError).body.message, "Analytics overview is unavailable");
          return true;
        }
      );
      await assert.rejects(
        fetchAnalyticsOverview(AUTH_CONTEXT),
        (error) => {
          assert.equal(error instanceof AssetApiError, true);
          assert.equal((error as AssetApiError).status, 404);
          assert.equal((error as AssetApiError).body.message, "Analytics overview is unavailable");
          return true;
        }
      );
    });
  });
});

test("analytics empty fallbacks preserve bounded zero-state shapes", () => {
  const now = new Date("2026-07-03T00:00:00.000Z");
  const overview = emptyAnalyticsOverview(60 * 60, now);
  assert.equal(overview.window_started_at, "2026-07-02T23:00:00.000Z");
  assert.equal(overview.window_ended_at, "2026-07-03T00:00:00.000Z");
  assert.equal(overview.views, 0);
  assert.equal(overview.unique_viewers, 0);
  assert.equal(overview.sessions, 0);
  assert.equal(overview.watch_time_ms, 0);
  assert.equal(overview.request_count, 0);
  assert.equal(overview.bytes_served, 0);
  assert.deepEqual(overview.timeseries, []);
  assert.deepEqual(overview.top_assets, []);
  assert.deepEqual(overview.breakdowns, []);

  const live = emptyAnalyticsLive(24 * 60 * 60, now);
  assert.equal(live.window_started_at, "2026-07-02T23:00:00.000Z");
  assert.equal(live.window_ended_at, "2026-07-03T00:00:00.000Z");
  assert.equal(live.fetched_at, "2026-07-03T00:00:00.000Z");
  assert.equal(live.views, 0);
  assert.equal(live.watch_time_ms, 0);
  assert.equal(live.unique_viewers, 0);
  assert.equal(live.active_sessions, 0);
  assert.equal(live.views_last_minute, 0);
  assert.deepEqual(live.timeseries, []);
  assert.deepEqual(live.recent_assets, []);
  assert.equal(live.resolution, "hourly");
});

test("analytics temporary outage classifier only matches upstream 502 and 503", () => {
  const body = {
    status: "error" as const,
    error: "rend_api_unavailable" as const,
    message: "Rend API request failed",
  };

  assert.equal(isAnalyticsTemporarilyUnavailable(new AssetApiError(502, body)), true);
  assert.equal(isAnalyticsTemporarilyUnavailable(new AssetApiError(503, body)), true);
  assert.equal(isAnalyticsTemporarilyUnavailable(new AssetApiError(404, body)), false);
  assert.equal(isAnalyticsTemporarilyUnavailable(new AssetApiError(403, body)), false);
  assert.equal(isAnalyticsTemporarilyUnavailable(new Error("network")), false);
});

test("asset client preserves documented billing limit errors", async () => {
  await withEnv(routeEnv(), async () => {
    await withMockFetch(async () => {
      return Response.json({ error: "limit_exceeded" }, { status: 403 });
    }, async () => {
      await assert.rejects(
        uploadAsset(
          AUTH_CONTEXT,
          new Request("https://rend.example/api/assets", {
            method: "POST",
            headers: {
              "content-length": "3",
              "content-type": "video/mp4",
            },
            body: "abc",
          })
        ),
        (error) => {
          assert.equal(error instanceof AssetApiError, true);
          assert.equal((error as AssetApiError).status, 403);
          assert.equal((error as AssetApiError).body.error, "limit_exceeded");
          return true;
        }
      );
    });
  });
});
