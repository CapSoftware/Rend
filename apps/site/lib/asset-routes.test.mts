import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/assets/route.ts";
import {
  DASHBOARD_SESSION_COOKIE,
  createDashboardSessionCookieValue,
} from "./dashboard-auth.ts";

const ENV_KEYS = [
  "REND_SITE_MAX_UPLOAD_BYTES",
  "REND_API_BASE_URL",
  "REND_DEV_API_KEY",
  "REND_SITE_OPERATOR_TOKEN",
  "REND_SITE_AUTH_SECRET",
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

async function responseJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function routeEnv(extra: Record<string, string | undefined> = {}) {
  return {
    REND_API_BASE_URL: "http://127.0.0.1:4000",
    REND_DEV_API_KEY: "dev-api-key",
    REND_SITE_OPERATOR_TOKEN: "operator-token",
    REND_SITE_AUTH_SECRET: "auth-secret",
    ...extra,
  };
}

function authenticatedHeaders(headers: HeadersInit = {}) {
  const output = new Headers(headers);
  output.set("cookie", `${DASHBOARD_SESSION_COOKIE}=${createDashboardSessionCookieValue()}`);
  return output;
}

test("asset route requires dashboard auth", async () => {
  await withEnv(routeEnv(), async () => {
    let upstreamCalls = 0;
    await withMockFetch(async () => {
      upstreamCalls += 1;
      return Response.json({ assets: [] });
    }, async () => {
      const response = await GET(new Request("https://rend.example/api/assets"));
      assert.equal(response.status, 401);
      assert.equal(upstreamCalls, 0);
    });
  });
});

test("asset route lists assets with dashboard auth", async () => {
  await withEnv(routeEnv(), async () => {
    await withMockFetch(async () => Response.json({ assets: [] }), async () => {
      const response = await GET(
        new Request("https://rend.example/api/assets", {
          headers: authenticatedHeaders(),
        })
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await responseJson(response), { status: "ok", assets: [] });
    });
  });
});

test("upload route rejects unsupported content types and oversized content-length before upstream", async () => {
  await withEnv(routeEnv({ REND_SITE_MAX_UPLOAD_BYTES: "10" }), async () => {
    let upstreamCalls = 0;
    await withMockFetch(async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 500 });
    }, async () => {
      const unsupported = await POST(
        new Request("https://rend.example/api/assets", {
          method: "POST",
          headers: authenticatedHeaders({
            "content-type": "application/json",
          }),
          body: "{}",
        })
      );
      assert.equal(unsupported.status, 415);

      const tooLarge = await POST(
        new Request("https://rend.example/api/assets", {
          method: "POST",
          headers: authenticatedHeaders({
            "content-length": "11",
            "content-type": "video/mp4",
          }),
          body: "01234567890",
        })
      );
      assert.equal(tooLarge.status, 413);
      assert.equal(upstreamCalls, 0);
    });
  });
});

test("upload route streams to rend-api, preserves content-type, and strips unsafe upstream fields", async () => {
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
      assert.equal(headers.get("authorization"), "Bearer dev-api-key");

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
      const response = await POST(
        new Request("https://rend.example/api/assets", {
          method: "POST",
          headers: authenticatedHeaders({
            "content-length": "3",
            "content-type": "video/mp4",
          }),
          body: "abc",
        })
      );
      const body = await responseJson(response);
      const serialized = JSON.stringify(body);

      assert.equal(response.status, 201);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://127.0.0.1:4000/v1/videos");
      assert.equal(calls[0].contentType, "video/mp4");
      assert.equal(calls[0].bytes, 3);
      assert.equal(serialized.includes("source_object_key"), false);
      assert.equal(serialized.includes("playback_url"), false);
      assert.equal(serialized.includes("token="), false);
      assert.equal(serialized.includes("dev-api-key"), false);
      assert.equal(serialized.includes("Bearer"), false);
    });
  });
});

test("route propagates only redacted safe upstream errors", async () => {
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
      const response = await GET(
        new Request("https://rend.example/api/assets", {
          headers: authenticatedHeaders(),
        })
      );
      const body = await responseJson(response);
      const serialized = JSON.stringify(body);

      assert.equal(response.status, 400);
      assert.equal(serialized.includes("edge.example"), false);
      assert.equal(serialized.includes("token=secret"), false);
      assert.equal(serialized.includes("Bearer abc"), false);
      assert.match(String(body.message), /\[redacted/);
    });
  });
});
