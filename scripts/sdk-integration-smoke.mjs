#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RendApiError, RendClient } from "../packages/sdk/src/index.ts";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_ORG_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:4000";
const DEFAULT_SITE_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_FIXTURE_PATH = "fixtures/media/rend-fixture.mp4";

function envString(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function numericEnv(name, fallback) {
  const value = Number(envString(name));
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function log(message) {
  console.log(`[sdk-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(output || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function localApiKeySql(rawKey) {
  const keyHash = createHash("sha256").update(rawKey, "utf8").digest("hex");
  const prefix = rawKey.slice(0, 18);
  const name = `SDK integration smoke ${new Date().toISOString()}`;
  return `
INSERT INTO rend_auth.organization (id, name, slug, metadata)
VALUES (${sqlLiteral(LOCAL_ORG_ID)}, 'Rend Local', 'local', '{"seeded":"local"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rend.api_keys (organization_id, name, prefix, key_hash, scopes)
VALUES (
  ${sqlLiteral(LOCAL_ORG_ID)},
  ${sqlLiteral(name)},
  ${sqlLiteral(prefix)},
  ${sqlLiteral(keyHash)},
  ARRAY['upload', 'read', 'delete', 'analytics']::text[]
)
ON CONFLICT (key_hash) DO UPDATE
SET revoked_at = NULL,
    scopes = EXCLUDED.scopes,
    last_used_update_after = NULL;
`;
}

function createLocalApiKey() {
  const rawKey = `rend_test_${randomBytes(32).toString("base64url")}`;
  const sql = localApiKeySql(rawKey);
  const errors = [];
  const databaseUrl = envString("DATABASE_URL");

  if (databaseUrl && commandExists("psql")) {
    try {
      run("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql]);
      return rawKey;
    } catch (error) {
      errors.push(`psql: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (commandExists("docker")) {
    try {
      run("docker", [
        "compose",
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "rend",
        "-d",
        "rend",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "-c",
        sql,
      ]);
      return rawKey;
    } catch (error) {
      errors.push(`docker compose postgres: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  fail(
    [
      "Could not create a local Rend API key.",
      "Start the local Docker stack with `bun run backend:docker:up`, or set REND_API_KEY.",
      ...errors,
    ].join("\n")
  );
}

function smokeApiKey() {
  const provided = envString("REND_API_KEY");
  if (provided) {
    log("using REND_API_KEY");
    return provided;
  }

  log("creating local scoped API key");
  return createLocalApiKey();
}

function ensureFixture(fixturePath) {
  if (existsSync(fixturePath)) return;
  log(`fixture missing; generating ${fixturePath}`);
  run("scripts/generate-fixture-video.sh", [fixturePath], { stdio: "inherit" });
}

async function expectOk(url, label) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    fail(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    fail(`${label} returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  return response;
}

function assertNoPlaybackLeaks(value) {
  const serialized = JSON.stringify(value);
  const forbidden = [
    "/internal/",
    "/operator",
    "x-rend-site-token",
    "x-rend-internal-token",
    "?token=",
  ];
  for (const pattern of forbidden) {
    if (serialized.includes(pattern)) {
      fail(`playback bootstrap leaked forbidden pattern: ${pattern}`);
    }
  }
  if (/"playback_token"\s*:/.test(serialized)) {
    fail("playback bootstrap leaked playback_token");
  }
}

function playbackSource(bootstrap) {
  return bootstrap.manifest_url ?? bootstrap.playback_url ?? bootstrap.opener_url;
}

async function expectDeletedPlaybackUnavailable(client, assetId) {
  try {
    await client.getPlaybackBootstrap(assetId);
  } catch (error) {
    if (error instanceof RendApiError && error.status === 404) return;
    throw error;
  }
  fail("playback bootstrap still succeeded after delete");
}

async function main() {
  const started = Date.now();
  const apiBaseUrl = envString("REND_API_BASE_URL", DEFAULT_API_BASE_URL);
  const siteBaseUrl = envString("REND_SITE_BASE_URL", envString("BETTER_AUTH_URL", DEFAULT_SITE_BASE_URL));
  const fixturePath = envString("REND_FIXTURE_PATH", DEFAULT_FIXTURE_PATH);
  const timeoutMs = numericEnv("REND_SMOKE_TIMEOUT_MS", 180_000);
  const intervalMs = numericEnv("REND_SMOKE_INTERVAL_MS", 1_000);
  const apiKey = smokeApiKey();

  ensureFixture(fixturePath);

  log(`checking API readiness at ${apiBaseUrl}`);
  await expectOk(new URL("/readyz", apiBaseUrl), "API readiness");
  log(`checking site at ${siteBaseUrl}`);
  await expectOk(new URL("/", siteBaseUrl), "site");

  const client = new RendClient({ apiKey, apiBaseUrl, siteBaseUrl });
  const fixture = await readFile(fixturePath);
  let assetId = "";
  let deleted = false;

  try {
    log(`uploading ${fixturePath}`);
    const upload = await client.uploadAsset(fixture, {
      contentType: "video/mp4",
      contentLength: fixture.byteLength,
    });
    assetId = upload.asset_id;

    log(`waiting for playable asset ${assetId}`);
    const asset = await client.waitForPlayableAsset(assetId, { timeoutMs, intervalMs });
    if (!["opener_ready", "hls_ready"].includes(asset.playable_state)) {
      fail(`unexpected playable_state ${asset.playable_state}`);
    }

    log("checking playback bootstrap");
    const bootstrap = await client.getPlaybackBootstrap(assetId);
    assertNoPlaybackLeaks(bootstrap);
    const source = playbackSource(bootstrap);
    if (!source) fail("playback bootstrap did not return a source path");
    const expectedPrefix = `/api/player/${assetId}/artifact/`;
    if (!source.startsWith(expectedPrefix)) {
      fail(`playback source is not a same-origin artifact path: ${source}`);
    }

    log("checking artifact path");
    const artifactResponse = await expectOk(new URL(source, siteBaseUrl), "playback artifact");
    const artifactContentType = artifactResponse.headers.get("content-type") ?? "";
    if (!/(mpegurl|video|octet-stream)/i.test(artifactContentType)) {
      fail(`unexpected artifact content-type: ${artifactContentType || "(missing)"}`);
    }

    log("checking embed page");
    const embedResponse = await expectOk(new URL(`/embed/${assetId}`, siteBaseUrl), "embed page");
    const embedHtml = await embedResponse.text();
    if (!embedHtml.includes(assetId)) {
      fail("embed page did not include the asset id");
    }

    log("fetching playback analytics");
    const analytics = await client.getPlaybackAnalytics(assetId, { windowSeconds: 3600 });
    if (analytics.asset_id !== assetId) {
      fail(`analytics asset_id mismatch: ${analytics.asset_id}`);
    }

    log("deleting asset");
    const deleteResult = await client.deleteAsset(assetId);
    deleted = true;
    if (!deleteResult.deleted) fail("delete response did not confirm deletion");

    log("checking playback after delete");
    await expectDeletedPlaybackUnavailable(client, assetId);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          asset_id: assetId,
          playable_state: asset.playable_state,
          artifact_content_type: artifactContentType,
          analytics_request_count: analytics.request_count,
          elapsed_ms: Date.now() - started,
        },
        null,
        2
      )
    );
  } finally {
    if (assetId && !deleted) {
      await client.deleteAsset(assetId).catch((error) => {
        log(`cleanup delete failed for ${assetId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
