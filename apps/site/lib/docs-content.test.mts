import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AGENT_PROMPT_CODE,
  AUTH_HEADER_CODE,
  CURL_UPLOAD_CODE,
  LOCAL_DOCKER_CODE,
  PLAYBACK_BOOTSTRAP_CODE,
  QUICKSTART_SDK_CODE,
  SDK_GUIDE_CODE,
  docsCommandItems,
  docsNavItems,
} from "../app/docs/docs-content.ts";

const DOCS_PAGE_PATH = fileURLToPath(new URL("../app/docs/page.tsx", import.meta.url));
const LLMS_ROUTE_PATH = fileURLToPath(new URL("../app/llms.txt/route.ts", import.meta.url));
const SDK_README_PATH = fileURLToPath(new URL("../../../packages/sdk/README.md", import.meta.url));

test("docs navigation uses stable unique anchors", () => {
  const anchors = docsNavItems.map((item) => item.href);
  assert.equal(new Set(anchors).size, anchors.length);
  for (const href of anchors) {
    assert.match(href, /^#[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});

test("command palette targets docs and reference routes", () => {
  assert.ok(docsCommandItems.some((item) => item.href === "/docs#quickstart"));
  assert.ok(docsCommandItems.some((item) => item.href === "/docs#agent-setup"));
  assert.ok(docsCommandItems.some((item) => item.href === "/openapi.json"));
  assert.ok(docsCommandItems.some((item) => item.href === "/llms.txt"));
  assert.ok(docsCommandItems.some((item) => item.href === "/llms-full.txt"));
  assert.ok(
    docsCommandItems.every((item) => item.title && item.description && item.keywords)
  );
});

test("docs examples match the public API and SDK surface", () => {
  assert.match(QUICKSTART_SDK_CODE, /new RendClient/);
  assert.match(QUICKSTART_SDK_CODE, /uploadAsset/);
  assert.match(QUICKSTART_SDK_CODE, /waitForPlayableAsset/);
  assert.match(QUICKSTART_SDK_CODE, /getPlaybackBootstrap/);
  assert.match(QUICKSTART_SDK_CODE, /deleteAsset/);

  assert.match(SDK_GUIDE_CODE, /getPlaybackAnalytics/);
  assert.match(CURL_UPLOAD_CODE, /\/v1\/videos/);
  assert.match(CURL_UPLOAD_CODE, /\/v1\/assets\/\$ASSET_ID\/analytics\/playback/);
  assert.match(CURL_UPLOAD_CODE, /\/api\/player\/\$ASSET_ID/);
  assert.match(AUTH_HEADER_CODE, /^Authorization: Bearer \$REND_API_KEY$/);
  assert.match(PLAYBACK_BOOTSTRAP_CODE, /https:\/\/ash-1\.play\.rend\.so\/v\/018f52b2-5401-7f3b-ae2e-4923f4d62120\/hls\/master\.m3u8/);
  assert.match(LOCAL_DOCKER_CODE, /bun run sdk:integration-smoke/);
  assert.match(AGENT_PROMPT_CODE, /\/llms\.txt/);
  assert.match(AGENT_PROMPT_CODE, /\/openapi\.json/);
  assert.match(AGENT_PROMPT_CODE, /@rend-sdk\/client/);
  assert.match(AGENT_PROMPT_CODE, /REND_API_KEY only on the server/);
});

test("public docs-facing files do not expose internal or secret-bearing guidance", async () => {
  const text = [
    await readFile(DOCS_PAGE_PATH, "utf8"),
    await readFile(LLMS_ROUTE_PATH, "utf8"),
    await readFile(SDK_README_PATH, "utf8"),
    QUICKSTART_SDK_CODE,
    AGENT_PROMPT_CODE,
    SDK_GUIDE_CODE,
    CURL_UPLOAD_CODE,
    PLAYBACK_BOOTSTRAP_CODE,
    LOCAL_DOCKER_CODE,
  ].join("\n");

  const forbiddenSubstrings = [
    "/internal/",
    "/operator",
    "x-rend-site-token",
    "x-rend-internal-token",
    "source_object_key",
    "source_artifact_id",
    "?token=",
    "REND_DEV_API_KEY",
    "dev-api-key",
    "local-site-internal-token",
  ];

  for (const forbidden of forbiddenSubstrings) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.equal(/"playback_token"\s*:/.test(text), false);
});
