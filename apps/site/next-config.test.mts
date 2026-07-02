import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "./next.config.ts";

test("normal embed route is served by the fast embed shell", async () => {
  const redirectsFn = nextConfig.redirects;
  if (typeof redirectsFn !== "function") {
    throw new Error("nextConfig.redirects must be a function");
  }
  const redirects = await redirectsFn();
  assert.deepEqual(redirects, []);

  const rewritesFn = nextConfig.rewrites;
  if (typeof rewritesFn !== "function") {
    throw new Error("nextConfig.rewrites must be a function");
  }
  const rewrites = await rewritesFn();
  assert.deepEqual(rewrites, {
    beforeFiles: [
      {
        source: "/embed/:assetId",
        destination: "/embed-fast/:assetId",
      },
    ],
  });
});

test("production embed route redirects to the API fast embed shell", async () => {
  const original = process.env.REND_SITE_FAST_EMBED_REDIRECT_ORIGIN;
  process.env.REND_SITE_FAST_EMBED_REDIRECT_ORIGIN = "https://api.rend.so/";
  const { default: productionConfig } = await import(
    `./next.config.ts?redirect=${Date.now()}`
  );

  try {
    const redirectsFn = productionConfig.redirects;
    if (typeof redirectsFn !== "function") {
      throw new Error("nextConfig.redirects must be a function");
    }
    const redirects = await redirectsFn();
    assert.deepEqual(redirects, [
      {
        source: "/embed/:assetId",
        destination: "https://api.rend.so/embed-fast/:assetId",
        permanent: false,
      },
    ]);
  } finally {
    if (original === undefined) {
      delete process.env.REND_SITE_FAST_EMBED_REDIRECT_ORIGIN;
    } else {
      process.env.REND_SITE_FAST_EMBED_REDIRECT_ORIGIN = original;
    }
  }
});
