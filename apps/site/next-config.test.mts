import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "./next.config.ts";

test("normal embed route is served by the fast embed shell", async () => {
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
