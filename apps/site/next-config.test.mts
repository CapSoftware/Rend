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

test("production edge playback keeps the embed shell on the site", async () => {
  const originalRedirectOrigin =
    process.env.REND_SITE_FAST_EMBED_REDIRECT_ORIGIN;
  const originalPlaybackMode = process.env.REND_PLAYBACK_MODE;
  const originalVercelEnv = process.env.VERCEL_ENV;
  delete process.env.REND_SITE_FAST_EMBED_REDIRECT_ORIGIN;
  process.env.REND_PLAYBACK_MODE = "edge";
  process.env.VERCEL_ENV = "production";
  const { default: productionEdgeConfig } = await import(
    `./next.config.ts?edge=${Date.now()}`
  );

  try {
    const redirectsFn = productionEdgeConfig.redirects;
    if (typeof redirectsFn !== "function") {
      throw new Error("nextConfig.redirects must be a function");
    }
    assert.deepEqual(await redirectsFn(), []);
  } finally {
    if (originalRedirectOrigin === undefined) {
      delete process.env.REND_SITE_FAST_EMBED_REDIRECT_ORIGIN;
    } else {
      process.env.REND_SITE_FAST_EMBED_REDIRECT_ORIGIN = originalRedirectOrigin;
    }
    if (originalPlaybackMode === undefined) {
      delete process.env.REND_PLAYBACK_MODE;
    } else {
      process.env.REND_PLAYBACK_MODE = originalPlaybackMode;
    }
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
  }
});

test("embed route redirects only when an external fast embed origin is configured", async () => {
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
