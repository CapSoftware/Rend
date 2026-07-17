import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { AssetApiError } from "./asset-api.ts";
import { createDashboardUploadIntent } from "./dashboard-upload-token.ts";
import type { DashboardAccessContext } from "./dashboard-auth.ts";

const ENV_KEYS = [
  "REND_API_BASE_URL",
  "REND_PUBLIC_API_BASE_URL",
  "REND_SITE_INTERNAL_TOKEN",
  "REND_SITE_MAX_UPLOAD_BYTES",
  "REND_ENV",
  "REND_ENV_PROFILE",
];

const CONTEXT: DashboardAccessContext = {
  userId: "00000000-0000-0000-0000-000000000010",
  userEmail: "owner@rend.test",
  organizationId: "00000000-0000-0000-0000-000000000001",
  organizationName: "Test workspace",
  organizationSlug: "test-workspace",
  role: "owner",
};

async function withEnv<T>(values: Record<string, string | undefined>, run: () => T | Promise<T>) {
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

function tokenParts(token: string) {
  assert.match(token, /^rend_upload_/);
  const stripped = token.replace(/^rend_upload_/, "");
  const [payload, signature] = stripped.split(".");
  assert.ok(payload);
  assert.ok(signature);
  return { payload, signature };
}

test("dashboard upload intent returns a scoped signed token for the public API", async () => {
  await withEnv(
    {
      REND_ENV: "production",
      REND_PUBLIC_API_BASE_URL: "https://api.rend.so",
      REND_SITE_INTERNAL_TOKEN: "site-internal-token",
      REND_SITE_MAX_UPLOAD_BYTES: "100",
    },
    () => {
      const intent = createDashboardUploadIntent(CONTEXT, {
        contentLength: 3,
        contentType: "video/mp4",
      });
      const { payload, signature } = tokenParts(intent.token);
      const expectedSignature = createHmac("sha256", "site-internal-token").update(payload).digest("base64url");
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;

      assert.equal(intent.upload_url, "https://api.rend.so/v1/uploads");
      assert.equal(intent.content_type, "video/mp4");
      assert.equal(signature, expectedSignature);
      assert.equal(claims.v, 2);
      assert.equal(claims.purpose, "multipart_upload");
      assert.equal(claims.org_id, CONTEXT.organizationId);
      assert.equal(claims.content_type, "video/mp4");
      assert.equal(claims.content_length, 3);
      assert.equal(JSON.stringify(intent).includes("site-internal-token"), false);
    }
  );
});

test("dashboard upload intent rejects unsupported or oversized files before token issue", async () => {
  await withEnv(
    {
      REND_ENV: "local",
      REND_SITE_INTERNAL_TOKEN: "site-internal-token",
      REND_SITE_MAX_UPLOAD_BYTES: "2",
    },
    () => {
      assert.throws(
        () => createDashboardUploadIntent(CONTEXT, { contentLength: 1, contentType: "application/json" }),
        (error) => error instanceof AssetApiError && error.status === 415
      );
      assert.throws(
        () => createDashboardUploadIntent(CONTEXT, { contentLength: 3, contentType: "video/mp4" }),
        (error) => error instanceof AssetApiError && error.status === 413
      );
      assert.throws(
        () => createDashboardUploadIntent(CONTEXT, { contentLength: 0, contentType: "video/mp4" }),
        (error) => error instanceof AssetApiError && error.status === 400
      );
      assert.throws(
        () => createDashboardUploadIntent(CONTEXT, { contentType: "video/mp4" }),
        (error) => error instanceof AssetApiError && error.status === 400
      );
    }
  );
});
