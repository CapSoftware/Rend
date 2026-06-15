import assert from "node:assert/strict";
import test from "node:test";
import {
  AssetApiError,
  fetchAssetDetail,
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
