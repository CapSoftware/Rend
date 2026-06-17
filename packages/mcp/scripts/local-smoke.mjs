#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_ORG_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:4000";
const DEFAULT_SITE_BASE_URL = "http://127.0.0.1:3310";
const DEFAULT_FIXTURE_PATH = "fixtures/media/rend-fixture.mp4";

function envString(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function numericEnv(name, fallback) {
  const value = Number(envString(name));
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function log(message) {
  console.log(`[mcp-smoke] ${message}`);
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
  const name = `MCP local smoke ${new Date().toISOString()}`;
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

  throw new Error(
    [
      "Could not create a local Rend API key.",
      "Start the local Docker stack or set REND_API_KEY.",
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
    throw new Error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  return response;
}

async function waitForOk(url, label, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      return await expectOk(url, label);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError ?? new Error(`${label} was not ready`);
}

function startSiteIfNeeded(siteBaseUrl) {
  if (envString("REND_MCP_SMOKE_SKIP_SITE_START") === "1") return undefined;
  const check = spawnSync("node", ["-e", `fetch(${JSON.stringify(siteBaseUrl)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`], {
    cwd: rootDir,
    stdio: "ignore",
  });
  if (check.status === 0) return undefined;

  log("starting local site dev server");
  const siteUrl = new URL(siteBaseUrl);
  const child = spawn("bun", ["run", "--cwd", "apps/site", "dev"], {
    cwd: rootDir,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      BETTER_AUTH_URL: siteBaseUrl,
      PORT: siteUrl.port || (siteUrl.protocol === "https:" ? "443" : "80"),
      REND_ENV_PROFILE: "local",
      REND_SITE_BASE_URL: siteBaseUrl,
    },
    stdio: "ignore",
  });
  return child;
}

function parseToolResult(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text content");
  return JSON.parse(text);
}

function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signalChild(child, "SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function signalChild(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child below.
    }
  }
  child.kill(signal);
}

function assertNoLeaks(value) {
  const serialized = JSON.stringify(value);
  const forbidden = [
    "/internal/",
    "/operator",
    "x-rend-site-token",
    "x-rend-internal-token",
    "?token=",
    "rend_test_",
    "rend_live_",
    "__rend_playback=",
  ];
  for (const pattern of forbidden) {
    if (serialized.includes(pattern)) throw new Error(`MCP output leaked ${pattern}`);
  }
  if (/"playback_token"\s*:/.test(serialized)) throw new Error("MCP output leaked playback_token");
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const body = parseToolResult(result);
  assertNoLeaks(body);
  if (result.isError || body.status === "error") {
    throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const started = Date.now();
  const apiBaseUrl = envString("REND_API_BASE_URL", DEFAULT_API_BASE_URL);
  const siteBaseUrl = envString("REND_SITE_BASE_URL", DEFAULT_SITE_BASE_URL);
  const fixturePath = resolve(rootDir, envString("REND_FIXTURE_PATH", DEFAULT_FIXTURE_PATH));
  const timeoutMs = numericEnv("REND_SMOKE_TIMEOUT_MS", 180_000);
  const intervalMs = numericEnv("REND_SMOKE_INTERVAL_MS", 1_000);

  ensureFixture(fixturePath);

  if (envString("REND_MCP_SMOKE_SKIP_BACKEND_UP") !== "1") {
    log("starting local Docker backend");
    run("bun", ["run", "backend:docker:up"], { stdio: "inherit" });
  }

  const siteProcess = startSiteIfNeeded(siteBaseUrl);
  try {
    log(`checking API readiness at ${apiBaseUrl}`);
    await waitForOk(new URL("/readyz", apiBaseUrl), "API readiness");
    log(`checking site at ${siteBaseUrl}`);
    await waitForOk(new URL("/", siteBaseUrl), "site");

    const apiKey = smokeApiKey();
    const serverPath = fileURLToPath(new URL("../dist/bin/rend-mcp.js", import.meta.url));
    if (!existsSync(serverPath)) {
      throw new Error("MCP server dist is missing. Run `bun run --cwd packages/mcp build` first.");
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: {
        ...process.env,
        REND_MCP_API_KEY: apiKey,
        REND_API_BASE_URL: apiBaseUrl,
        REND_SITE_BASE_URL: siteBaseUrl,
      },
      cwd: packageDir,
    });
    const client = new Client({ name: "rend-mcp-smoke", version: "0.1.0" });
    await client.connect(transport);

    let assetId = "";
    try {
      log(`uploading ${fixturePath} through MCP`);
      const upload = await call(client, "rend_upload_video", {
        file_path: fixturePath,
        content_type: "video/mp4",
        wait_for_playable: true,
        timeout_ms: timeoutMs,
        interval_ms: intervalMs,
      });
      assetId = upload.asset_id;

      log("fetching playback through MCP");
      const playback = await call(client, "rend_get_playback", { asset_id: assetId });
      if (!playback.source_url) throw new Error("rend_get_playback did not return source_url");
      if (!playback.embed_url || !playback.watch_url) throw new Error("rend_get_playback did not return embed/watch URLs");

      log("fetching analytics through MCP");
      const analytics = await call(client, "rend_get_analytics", {
        asset_id: assetId,
        window_seconds: 3600,
      });
      if (analytics.analytics.asset_id !== assetId) throw new Error("analytics asset_id mismatch");

      log("deleting asset through MCP");
      const deleted = await call(client, "rend_delete_asset", { asset_id: assetId });
      if (!deleted.delete.deleted) throw new Error("delete response did not confirm deletion");

      console.log(
        JSON.stringify(
          {
            status: "ok",
            asset_id: assetId,
            playable_state: upload.playable_state,
            analytics_request_count: analytics.analytics.request_count,
            elapsed_ms: Date.now() - started,
          },
          null,
          2
        )
      );
    } finally {
      if (assetId) {
        await client.callTool({ name: "rend_delete_asset", arguments: { asset_id: assetId } }).catch(() => undefined);
      }
      await client.close();
    }
  } finally {
    if (siteProcess) {
      signalChild(siteProcess, "SIGTERM");
      await waitForChildExit(siteProcess);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
