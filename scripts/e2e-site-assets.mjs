#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(repoRoot, "apps", "site");
const goalDir = path.join(repoRoot, ".rend", "goal31");
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const runDir = path.join(goalDir, `site-assets-${runId}`);
const resultPath = path.join(runDir, "site-assets-e2e.json");
const latestPath = path.join(goalDir, "latest-site-assets-e2e.json");

const apiBaseUrl = trimTrailingSlash(process.env.REND_API_BASE_URL || "http://127.0.0.1:4000");
const edgeBaseUrl = trimTrailingSlash(process.env.REND_EDGE_BASE_URL || "http://127.0.0.1:4100");
const apiKey = process.env.REND_DEV_API_KEY || "dev-api-key";
const siteInternalToken = process.env.REND_SITE_INTERNAL_TOKEN || "local-site-internal-token";
const authEmail = (process.env.REND_LOCAL_ADMIN_EMAIL || "admin@rend.test").trim().toLowerCase();
const localAuthSecret =
  process.env.BETTER_AUTH_SECRET || "local-better-auth-secret-only-for-rend-development";
const localOrgId = "00000000-0000-0000-0000-000000000001";
const localAdminUserId = "00000000-0000-0000-0000-000000000010";
const fixturePath = process.env.REND_SMOKE_FIXTURE || path.join(runDir, "rend-goal31-fixture.mp4");
const siteBaseOverride = process.env.REND_SITE_BASE_URL
  ? trimTrailingSlash(process.env.REND_SITE_BASE_URL)
  : "";

const children = [];
let shuttingDown = false;
const failures = [];
const artifact = {
  run_id: runId,
  status: "running",
  started_at: new Date().toISOString(),
  run_dir: runDir,
  config: {
    api_base_url: apiBaseUrl,
    edge_base_url: edgeBaseUrl,
    site_base_url: siteBaseOverride || null,
    fixture_path: fixturePath,
  },
  local: {},
  checks: [],
  failures,
};

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[goal31] ${message}`);
}

function localBillingProcessEnv(env = process.env) {
  return {
    ...env,
    REND_ENV: "local",
    REND_ENV_PROFILE: "local",
    REND_BILLING_MODE: "local",
    AUTUMN_SECRET_KEY: "",
    AUTUMN_API_URL: "",
    REND_ALLOW_EXTERNAL_TEST_CHECKOUT_REDIRECT: "false",
  };
}

function bindAddrFromBaseUrl(value, fallback) {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return fallback;
  }
}

function backendEnv() {
  const internalToken = process.env.REND_EDGE_INTERNAL_TOKEN || "dev-internal-token";
  return {
    ...localBillingProcessEnv(),
    DATABASE_URL: process.env.DATABASE_URL || "postgres://rend:rend@localhost:5432/rend",
    REND_ENV: process.env.REND_SMOKE_REND_ENV || "local",
    CLICKHOUSE_URL: process.env.CLICKHOUSE_URL || "http://localhost:8123",
    CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE || "rend",
    CLICKHOUSE_USER: process.env.CLICKHOUSE_USER || "rend",
    CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD || "rend",
    OBJECT_STORE_HEALTH_URL:
      process.env.OBJECT_STORE_HEALTH_URL || "http://localhost:9100/minio/health/ready",
    S3_ENDPOINT: process.env.S3_ENDPOINT || "http://localhost:9100",
    S3_REGION: process.env.S3_REGION || "us-east-1",
    S3_BUCKET: process.env.S3_BUCKET || "rend-local",
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "rend_minio",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "rend_minio_password",
    REND_API_BIND_ADDR: process.env.REND_API_BIND_ADDR || bindAddrFromBaseUrl(apiBaseUrl, "127.0.0.1:4000"),
    REND_API_AUTO_MIGRATE: process.env.REND_API_AUTO_MIGRATE || "true",
    REND_DEV_API_KEY: apiKey,
    REND_SITE_INTERNAL_TOKEN: siteInternalToken,
    REND_PLAYBACK_BASE_URL: process.env.REND_PLAYBACK_BASE_URL || edgeBaseUrl,
    REND_EDGE_WARM_URL: process.env.REND_EDGE_WARM_URL || `${edgeBaseUrl}/internal/warm`,
    REND_EDGE_PURGE_URL: process.env.REND_EDGE_PURGE_URL || `${edgeBaseUrl}/internal/purge`,
    REND_INTERNAL_TELEMETRY_TOKEN: process.env.REND_INTERNAL_TELEMETRY_TOKEN || internalToken,
    REND_PLAYBACK_SIGNING_KEY_ID:
      process.env.REND_PLAYBACK_SIGNING_KEY_ID || "local-dev-playback-key",
    REND_PLAYBACK_SIGNING_SECRET:
      process.env.REND_PLAYBACK_SIGNING_SECRET || "local-dev-playback-signing-secret",
    REND_PLAYBACK_TOKEN_TTL_SECS: process.env.REND_PLAYBACK_TOKEN_TTL_SECS || "900",
    REND_HTTP_TIMEOUT_SECS: process.env.REND_HTTP_TIMEOUT_SECS || "120",
    REND_MEDIA_PROCESS_TIMEOUT_SECS: process.env.REND_MEDIA_PROCESS_TIMEOUT_SECS || "60",
    REND_API_INLINE_MEDIA_PROCESSING: process.env.REND_API_INLINE_MEDIA_PROCESSING || "false",
    REND_MEDIA_JOB_MAX_ATTEMPTS: process.env.REND_MEDIA_JOB_MAX_ATTEMPTS || "3",
    REND_MEDIA_WORKER_POLL_INTERVAL_SECS:
      process.env.REND_MEDIA_WORKER_POLL_INTERVAL_SECS || "1",
    REND_MEDIA_JOB_LOCK_TIMEOUT_SECS: process.env.REND_MEDIA_JOB_LOCK_TIMEOUT_SECS || "300",
    REND_FFMPEG_PATH: process.env.REND_FFMPEG_PATH || "ffmpeg",
    REND_FFPROBE_PATH: process.env.REND_FFPROBE_PATH || "ffprobe",
    REND_EDGE_BIND_ADDR:
      process.env.REND_EDGE_BIND_ADDR || bindAddrFromBaseUrl(edgeBaseUrl, "127.0.0.1:4100"),
    REND_EDGE_ID: process.env.REND_EDGE_ID || "local-edge-001",
    REND_EDGE_REGION: process.env.REND_EDGE_REGION || "local",
    REND_EDGE_BASE_URL: process.env.REND_EDGE_BASE_URL || edgeBaseUrl,
    REND_EXPECTED_EDGES:
      process.env.REND_EXPECTED_EDGES ||
      `${process.env.REND_EDGE_ID || "local-edge-001"}=${process.env.REND_EDGE_REGION || "local"}=${edgeBaseUrl}`,
    REND_EDGE_CACHE_DIR: process.env.REND_EDGE_CACHE_DIR || path.join(runDir, "edge-cache"),
    REND_EDGE_ORIGIN_HEALTH_URL:
      process.env.REND_EDGE_ORIGIN_HEALTH_URL || "http://localhost:9100/minio/health/ready",
    REND_EDGE_INTERNAL_TOKEN: internalToken,
    REND_EDGE_TELEMETRY_ENABLED: process.env.REND_EDGE_TELEMETRY_ENABLED || "true",
    REND_EDGE_TELEMETRY_INGEST_URL:
      process.env.REND_EDGE_TELEMETRY_INGEST_URL || `${apiBaseUrl}/internal/telemetry/playback`,
    REND_EDGE_TELEMETRY_QUEUE_CAPACITY: process.env.REND_EDGE_TELEMETRY_QUEUE_CAPACITY || "32",
    REND_EDGE_TELEMETRY_BATCH_SIZE: process.env.REND_EDGE_TELEMETRY_BATCH_SIZE || "10",
    REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS:
      process.env.REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS || "1",
    REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS:
      process.env.REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS || "2",
    REND_EDGE_TELEMETRY_SPOOL_DIR:
      process.env.REND_EDGE_TELEMETRY_SPOOL_DIR || path.join(runDir, "telemetry-spool"),
    REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES:
      process.env.REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES || "10485760",
  };
}

function addCheck(name, ok, details = {}) {
  artifact.checks.push({ name, ok, details });
  if (!ok) failures.push({ name, details });
}

function assertCheck(name, condition, details = {}) {
  addCheck(name, Boolean(condition), details);
  if (!condition) throw new Error(`check failed: ${name}`);
}

async function writeArtifact() {
  artifact.finished_at = new Date().toISOString();
  artifact.status = failures.length > 0 ? "failed" : "passed";
  await mkdir(goalDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeFile(resultPath, json);
  await writeFile(latestPath, json);
}

function runCommand(cmd, args, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const maxCapture = options.maxCapture ?? 20_000;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
          reject(new Error(`${cmd} ${args.join(" ")} timed out`));
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-maxCapture);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-maxCapture);
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      const record = {
        command: `${cmd} ${args.join(" ")}`,
        exit_code: code,
        signal,
        duration_ms: Date.now() - startedAt,
      };
      artifact.local.commands = artifact.local.commands || [];
      artifact.local.commands.push(record);

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${cmd} ${args.join(" ")} exited with ${code ?? signal}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function startLoggedProcess(label, cmd, args, env, logPath) {
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("exit", (code, signal) => {
    if (!shuttingDown && artifact.status === "running") {
      failures.push({ name: `${label} exited`, details: { code, signal, log_path: logPath } });
    }
  });
  return { child, logPath, logStream };
}

async function ensureLocalBackend() {
  const env = backendEnv();
  await runCommand("docker", [
    "compose",
    "up",
    "-d",
    "postgres",
    "clickhouse",
    "minio",
    "minio-init",
    "clickhouse-init",
  ], { timeoutMs: 120_000 });
  await runCommand("docker", ["compose", "stop", "rend-api", "rend-media-worker", "rend-edge"], {
    timeoutMs: 60_000,
  }).catch(() => undefined);

  await waitForHttp(env.OBJECT_STORE_HEALTH_URL, {
    timeoutMs: 120_000,
    accept: (response) => response.status === 200,
  });

  const api = startLoggedProcess(
    "rend-api",
    "cargo",
    ["run", "-p", "rend-api"],
    env,
    path.join(runDir, "rend-api.log")
  );
  await waitForHttp(`${apiBaseUrl}/readyz`, {
    timeoutMs: 180_000,
    accept: (response) => response.status === 200,
  });
  await resetLocalAuthRateLimits();

  const edge = startLoggedProcess(
    "rend-edge",
    "cargo",
    ["run", "-p", "rend-edge"],
    env,
    path.join(runDir, "rend-edge.log")
  );
  await waitForHttp(`${edgeBaseUrl}/readyz`, {
    timeoutMs: 180_000,
    accept: (response) => response.status === 200,
  });

  const worker = startLoggedProcess(
    "rend-media-worker",
    "cargo",
    ["run", "-p", "rend-api", "--", "worker", "media"],
    env,
    path.join(runDir, "rend-media-worker.log")
  );

  await waitForHttp(`${apiBaseUrl}/v1/assets`, {
    timeoutMs: 60_000,
    headers: { authorization: `Bearer ${apiKey}` },
    accept: (response) => response.status === 200,
  });

  artifact.local.backend = {
    api_log: api.logPath,
    edge_log: edge.logPath,
    worker_log: worker.logPath,
    started: true,
  };
}

async function resetLocalAuthRateLimits() {
  await runCommand("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "rend",
    "-d",
    "rend",
    "-c",
    `
      delete from rend_auth.rate_limit where key like '%/email-otp/%' or key like '%/sign-in/email-otp%';
      update rend_auth.organization
         set suspended_at = null,
             suspended_by_user_id = null,
             suspension_reason = null
       where id = '${localOrgId}'::uuid;
      update rend.assets
         set suspended_at = null,
             suspended_by_user_id = null,
             suspension_reason = null
       where organization_id = '${localOrgId}'::uuid;
    `,
  ], { timeoutMs: 30_000 });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function signBetterAuthCookieValue(value) {
  const signature = createHmac("sha256", localAuthSecret).update(value).digest("base64");
  return `${value}.${signature}`;
}

async function createDirectLocalSessionCookie() {
  if (process.env.REND_SITE_E2E_DIRECT_SESSION === "0") return "";

  const token = randomBytes(24).toString("base64url");
  const sessionId = randomUUID();
  const sql = `
    insert into rend_auth."user" (id, name, email, email_verified, created_at, updated_at)
    values (${sqlString(localAdminUserId)}::uuid, 'Rend Local Admin', ${sqlString(authEmail)}, true, now(), now())
    on conflict (id) do update
      set name = excluded.name,
          email = excluded.email,
          email_verified = true,
          updated_at = now();

    insert into rend_auth.organization (
      id,
      name,
      slug,
      metadata,
      suspended_at,
      suspended_by_user_id,
      suspension_reason,
      created_at,
      updated_at
    )
    values (
      ${sqlString(localOrgId)}::uuid,
      'Rend Local',
      'local',
      '{"seeded":"local"}'::jsonb,
      null,
      null,
      null,
      now(),
      now()
    )
    on conflict (id) do update
      set name = excluded.name,
          slug = excluded.slug,
          metadata = excluded.metadata,
          suspended_at = null,
          suspended_by_user_id = null,
          suspension_reason = null,
          updated_at = now();

    insert into rend_auth.member (organization_id, user_id, role, created_at)
    values (${sqlString(localOrgId)}::uuid, ${sqlString(localAdminUserId)}::uuid, 'owner', now())
    on conflict (user_id, organization_id) do update
      set role = 'owner';

    insert into rend_auth.session (
      id,
      expires_at,
      token,
      created_at,
      updated_at,
      user_id,
      active_organization_id
    )
    values (
      ${sqlString(sessionId)}::uuid,
      now() + interval '7 days',
      ${sqlString(token)},
      now(),
      now(),
      ${sqlString(localAdminUserId)}::uuid,
      ${sqlString(localOrgId)}::uuid
    );
  `;

  await runCommand("docker", [
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
    "-c",
    sql,
  ], { timeoutMs: 30_000 });

  return `rend_auth.session_token=${signBetterAuthCookieValue(token)}`;
}

async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  let lastError = "";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store", headers: options.headers });
      if (!options.accept || options.accept(response)) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(options.intervalMs ?? 500);
  }

  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function getFreePort(startAt = 0) {
  if (!startAt) return tryListen(0);

  for (let port = startAt; port < startAt + 100; port += 1) {
    try {
      return await tryListen(port);
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }

  return tryListen(0);
}

async function startSite() {
  if (siteBaseOverride) {
    await waitForHttp(siteBaseOverride, {
      timeoutMs: 30_000,
      accept: (response) => response.status < 500,
    });
    const logPath = process.env.REND_SITE_LOG_PATH || null;
    artifact.local.site = { base_url: siteBaseOverride, started: false, log_path: logPath };
    return { baseUrl: siteBaseOverride, logPath, stop: async () => undefined };
  }

  const port = Number(process.env.REND_SITE_PORT) || (await getFreePort(3000));
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = path.join(runDir, "site.log");
  const logStream = createWriteStream(logPath, { flags: "a" });
  const nextBin = path.join(siteDir, "node_modules", ".bin", "next");
  let expectedExit = false;
  const allowedPlaybackBases = [
    edgeBaseUrl,
    "http://127.0.0.1:4100",
    "http://localhost:4100",
  ];

  const child = spawn(nextBin, ["dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: siteDir,
    env: {
      ...localBillingProcessEnv(),
      REND_API_BASE_URL: apiBaseUrl,
      REND_SITE_INTERNAL_TOKEN: siteInternalToken,
      BETTER_AUTH_SECRET: localAuthSecret,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || baseUrl,
      REND_AUTH_EMAIL_FROM: process.env.REND_AUTH_EMAIL_FROM || "Rend Local <auth@rend.test>",
      REND_LOCAL_ADMIN_EMAIL: authEmail,
      REND_PLAYER_PLAYBACK_BASE_URL: edgeBaseUrl,
      REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS: [...new Set(allowedPlaybackBases)].join(","),
      REND_PLAYER_TELEMETRY_DEBUG: "1",
      REND_PLAYER_TELEMETRY_INGEST: "1",
      REND_OPERATOR_EMAIL_ALLOWLIST: process.env.REND_OPERATOR_EMAIL_ALLOWLIST || authEmail,
      NEXT_PUBLIC_REND_APP_VERSION: `goal31-${runId}`,
      NEXT_PUBLIC_REND_PLAYER_TELEMETRY: "1",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.on("exit", (code, signal) => {
    if (!expectedExit && artifact.status === "running") {
      failures.push({ name: "site dev server exited", details: { code, signal, log_path: logPath } });
    }
  });

  await waitForHttp(`${baseUrl}/login`, {
    timeoutMs: 120_000,
    accept: (response) => response.status === 200,
  });

  artifact.local.site = { base_url: baseUrl, started: true, log_path: logPath };
  return {
    baseUrl,
    logPath,
    stop: async () => {
      expectedExit = true;
      child.kill("SIGTERM");
      await sleep(500);
      if (!child.killed) child.kill("SIGKILL");
      logStream.end();
    },
  };
}

function chromeCandidates() {
  const envPath = process.env.CHROME_PATH;
  return [
    envPath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);
}

function resolveChromePath() {
  for (const candidate of chromeCandidates()) {
    if (candidate.includes(path.sep) && existsSync(candidate)) return candidate;
    if (!candidate.includes(path.sep)) return candidate;
  }
  throw new Error("Chrome/Chromium was not found. Set CHROME_PATH to run this E2E.");
}

async function launchChrome() {
  const port = await getFreePort(9222);
  const chromePath = resolveChromePath();
  const userDataDir = path.join(runDir, "chrome-profile");
  const logPath = path.join(runDir, "chrome.log");
  const logStream = createWriteStream(logPath, { flags: "a" });
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate,OptimizationHints",
    "--disable-sync",
    "--no-default-browser-check",
    "--no-first-run",
  ];
  if (process.platform === "linux") args.push("--no-sandbox");

  const child = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  await waitForHttp(`http://127.0.0.1:${port}/json/version`, {
    timeoutMs: 60_000,
    accept: (response) => response.status === 200,
  });

  artifact.local.chrome = { path: chromePath, debugging_port: port, log_path: logPath };
  return {
    port,
    stop: async () => {
      child.kill("SIGTERM");
      await sleep(500);
      if (!child.killed) child.kill("SIGKILL");
      logStream.end();
    },
  };
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  static connect(wsUrl) {
    const connection = new CdpConnection(wsUrl);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      connection.ws = ws;
      ws.addEventListener("open", () => resolve(connection));
      ws.addEventListener("error", (event) => reject(event.error || new Error("CDP WebSocket error")));
      ws.addEventListener("message", (event) => connection.handleMessage(event.data));
      ws.addEventListener("close", () => {
        for (const { reject: rejectPending } of connection.pending.values()) {
          rejectPending(new Error("CDP connection closed"));
        }
        connection.pending.clear();
      });
    });
  }

  handleMessage(data) {
    const message = JSON.parse(String(data));
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    if (message.method && this.handlers.has(message.method)) {
      for (const handler of this.handlers.get(message.method)) {
        void Promise.resolve(handler(message.params || {})).catch(() => undefined);
      }
    }
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws?.close();
  }
}

async function newPage(chromePort) {
  const targetResponse = await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, {
    method: "PUT",
  });
  const target = await targetResponse.json();
  const page = await CdpConnection.connect(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  return page;
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "browser evaluation failed");
  }
  return result.result?.value;
}

async function navigate(page, url) {
  await page.send("Page.navigate", { url });
  await waitForBrowser(page, "document.readyState !== 'loading'", 60_000);
}

async function waitForBrowser(page, predicateExpression, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(page, `Boolean(${predicateExpression})`)) return true;
    await sleep(250);
  }
  throw new Error(`timed out waiting in browser for: ${predicateExpression}`);
}

function logSize(logPath) {
  if (!logPath || !existsSync(logPath)) return 0;
  return readFileSync(logPath).byteLength;
}

async function waitForLocalOtp(logPath, afterBytes) {
  if (!logPath) {
    throw new Error("local OTP log path is required for the site-assets E2E auth flow");
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const logText = existsSync(logPath) ? readFileSync(logPath).subarray(afterBytes).toString("utf8") : "";
    const matches = Array.from(logText.matchAll(/code:\s*['"]([0-9]{6})['"]/g));
    if (matches.length > 0) return matches.at(-1)[1];
    await sleep(250);
  }
  throw new Error("timed out waiting for local OTP code in site log");
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=)/g).map((cookie) => cookie.trim()).filter(Boolean);
}

function cookieHeaderFromResponse(response) {
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : splitSetCookie(response.headers.get("set-cookie") || "");
  return cookies
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function requestOtp(siteBaseUrl, logPath) {
  const afterBytes = logSize(logPath);
  const response = await fetch(`${siteBaseUrl}/api/auth/email-otp/send-verification-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: authEmail, type: "sign-in" }),
  });
  const bodyText = response.ok ? "" : await response.text().catch(() => "");
  assertCheck("OTP request succeeds", response.status === 200, {
    http_status: response.status,
    body: bodyText.slice(0, 500),
  });
  return waitForLocalOtp(logPath, afterBytes);
}

async function loginThroughApi(siteBaseUrl, logPath) {
  const unauthenticated = await fetch(`${siteBaseUrl}/api/assets`, { cache: "no-store" });
  assertCheck("asset API rejects unauthenticated requests", unauthenticated.status === 401, {
    http_status: unauthenticated.status,
  });

  try {
    const directSessionCookie = await createDirectLocalSessionCookie();
    if (directSessionCookie) {
      const authenticated = await fetch(`${siteBaseUrl}/api/assets`, {
        cache: "no-store",
        headers: { cookie: directSessionCookie },
      });
      artifact.local.direct_session = {
        attempted: true,
        http_status: authenticated.status,
      };
      if (authenticated.status === 200) {
        addCheck("local direct Better Auth session works", true);
        return directSessionCookie;
      }
    }
  } catch (error) {
    artifact.local.direct_session = {
      attempted: true,
      error: error.message,
    };
  }

  const otp = await requestOtp(siteBaseUrl, logPath);
  const response = await fetch(`${siteBaseUrl}/api/auth/sign-in/email-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: authEmail, otp }),
  });
  const body = await response.json().catch(() => ({}));
  const sessionCookie = cookieHeaderFromResponse(response);

  assertCheck("login API sets Better Auth session", response.status === 200 && sessionCookie.length > 0, {
    http_status: response.status,
  });
  assertCheck("login response does not echo OTP", !JSON.stringify(body).includes(otp), {
    response_bytes: JSON.stringify(body).length,
  });

  return sessionCookie;
}

async function loginThroughBrowser(page, siteBaseUrl, sessionCookie) {
  for (const cookie of sessionCookie.split(/;\s*/).filter(Boolean)) {
    const separator = cookie.indexOf("=");
    if (separator <= 0) continue;
    await page.send("Network.setCookie", {
      httpOnly: true,
      name: cookie.slice(0, separator),
      path: "/",
      sameSite: "Lax",
      secure: siteBaseUrl.startsWith("https://"),
      url: siteBaseUrl,
      value: cookie.slice(separator + 1),
    });
  }
  await navigate(page, `${siteBaseUrl}/dashboard/assets`);
  await waitForBrowser(page, `location.pathname === "/dashboard/assets"`, 60_000);
  addCheck("browser session reaches dashboard", true);
}

async function uploadFixtureThroughSite(siteBaseUrl, sessionCookie) {
  await runCommand("scripts/generate-fixture-video.sh", [fixturePath], { timeoutMs: 120_000 });
  const fixtureBytes = await readFile(fixturePath);

  const response = await fetch(`${siteBaseUrl}/api/assets`, {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      "content-type": "video/mp4",
      "content-length": String(fixtureBytes.byteLength),
    },
    body: fixtureBytes,
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  assertCheck("site upload proxy accepted fixture", response.status === 201 && body.asset?.asset_id, {
    http_status: response.status,
    asset_id: body.asset?.asset_id,
  });

  const serialized = JSON.stringify(body);
  assertCheck("site upload response excludes internal fields", !serialized.includes("source_object_key") && !serialized.includes("playback_url") && !serialized.includes("token="), {
    response_bytes: serialized.length,
  });

  return body.asset.asset_id;
}

async function createApiKeyThroughSite(siteBaseUrl, sessionCookie) {
  const response = await fetch(`${siteBaseUrl}/api/api-keys`, {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: `goal32-${runId}`,
      scopes: ["upload", "read", "delete", "analytics"],
    }),
  });
  const body = await response.json().catch(() => ({}));
  assertCheck("site creates API key for suspension checks", response.status === 201 && body.secret, {
    http_status: response.status,
    key_id: body.api_key?.id,
  });
  assertCheck("API key create response does not expose token in persisted fields", !JSON.stringify(body.api_key || {}).includes(body.secret), {
    key_id: body.api_key?.id,
  });
  return body.secret;
}

async function waitForPlayable(siteBaseUrl, sessionCookie, assetId) {
  const startedAt = Date.now();
  let lastAsset = null;
  while (Date.now() - startedAt < 180_000) {
    const response = await fetch(`${siteBaseUrl}/api/assets/${assetId}`, {
      cache: "no-store",
      headers: { cookie: sessionCookie },
    });
    const body = await response.json().catch(() => ({}));
    lastAsset = body.asset || body;
    if (response.ok && ["hls_ready", "opener_ready"].includes(lastAsset.playable_state)) {
      artifact.local.asset = {
        asset_id: assetId,
        playable_state: lastAsset.playable_state,
        source_state: lastAsset.source_state,
        processing_ms: Date.now() - startedAt,
      };
      return lastAsset;
    }
    if (lastAsset.playable_state === "failed") {
      throw new Error(`media processing failed for ${assetId}`);
    }
    await sleep(1_000);
  }

  throw new Error(`timed out waiting for ${assetId} to become playable: ${JSON.stringify(lastAsset)}`);
}

async function verifyDashboardUi(page, siteBaseUrl, assetId) {
  await navigate(page, `${siteBaseUrl}/dashboard/assets/${assetId}`);
  await waitForBrowser(page, `document.body.innerText.includes("${assetId}")`, 60_000);

  const detailText = await evaluate(page, "document.body.innerText");
  assertCheck("dashboard detail page renders asset state", detailText.includes("State") && detailText.includes("Embed") && detailText.includes(assetId), {
    text_length: detailText.length,
    sample: detailText.slice(0, 240),
  });

  await evaluate(
    page,
    `(() => {
      window.__rendCopied = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value) => { window.__rendCopied.push(value); } }
      });
      return true;
    })()`
  );
  await evaluate(
    page,
    `Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Copy embed URL").click()`
  );
  await evaluate(
    page,
    `Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Copy iframe").click()`
  );
  const copied = await evaluate(page, "window.__rendCopied");
  assertCheck("dashboard UI copy actions produce safe embed snippets", copied.length === 2 && copied[0].includes(`/embed/${assetId}`) && copied[1].includes("<iframe") && !JSON.stringify(copied).includes("token="), {
    copied,
  });
}

async function verifyOperatorUi(page, siteBaseUrl) {
  await navigate(page, `${siteBaseUrl}/operator`);
  await waitForBrowser(page, `document.body.innerText.includes("Operator controls")`, 60_000);
  const text = await evaluate(page, "document.body.innerText");
  assertCheck("operator page is reachable only through the signed-in server session", text.includes("Recent audit") && text.includes("Organizations") && text.includes("Assets"), {
    text_length: text.length,
  });
}

async function operatorActionThroughSite(siteBaseUrl, sessionCookie, { action, targetType, targetId, reason }) {
  const response = await fetch(`${siteBaseUrl}/operator/action`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: sessionCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      action,
      target_type: targetType,
      target_id: targetId,
      reason,
    }),
  });
  const location = response.headers.get("location") || "";
  assertCheck(`operator ${action} ${targetType} redirects with success`, [303, 307, 308].includes(response.status) && location.includes("status=ok"), {
    http_status: response.status,
    location,
  });
}

async function verifyOperatorAuditNoLeaks(siteBaseUrl, sessionCookie) {
  const response = await fetch(`${siteBaseUrl}/operator`, {
    cache: "no-store",
    headers: { cookie: sessionCookie },
  });
  const text = await response.text();
  assertCheck("operator audit page loads", response.status === 200, { http_status: response.status });
  assertCheck("operator audit redacts unsafe reason content", text.includes("[redacted") && !text.includes("edge.example") && !text.includes("token=secret") && !text.includes("Bearer abc"), {
    text_length: text.length,
  });
}

async function controlPlaneApiKeyRequest(apiKeySecret, pathName, options = {}) {
  return fetch(`${apiBaseUrl}${pathName}`, {
    method: options.method || "GET",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${apiKeySecret}`,
      "content-type": options.contentType || "application/json",
      ...(options.headers || {}),
    },
    body: options.body,
  });
}

async function verifyAssetSuspensionBlocks(siteBaseUrl, sessionCookie, apiKeySecret, assetId) {
  const detailResponse = await controlPlaneApiKeyRequest(apiKeySecret, `/v1/assets/${assetId}`);
  assertCheck("suspended asset API-key read is blocked", detailResponse.status === 403, {
    http_status: detailResponse.status,
  });

  const listResponse = await controlPlaneApiKeyRequest(apiKeySecret, "/v1/assets");
  const listBody = await listResponse.json().catch(() => ({}));
  assertCheck("suspended asset is omitted from API-key list reads", listResponse.status === 200 && !JSON.stringify(listBody).includes(assetId), {
    http_status: listResponse.status,
  });

  for (const [name, pathName, method] of [
    ["playback", `/v1/assets/${assetId}/playback`, "GET"],
    ["analytics", `/v1/assets/${assetId}/analytics/playback`, "GET"],
    ["delete", `/v1/assets/${assetId}`, "DELETE"],
  ]) {
    const response = await controlPlaneApiKeyRequest(apiKeySecret, pathName, { method });
    assertCheck(`suspended asset API-key ${name} is blocked`, response.status !== 200, {
      http_status: response.status,
    });
  }

  const bootstrap = await fetch(`${siteBaseUrl}/api/player/${assetId}`, { cache: "no-store" });
  const text = await bootstrap.text();
  assertCheck("suspended asset site bootstrap is unavailable", bootstrap.status !== 200 || !text.includes('"status":"ready"'), {
    http_status: bootstrap.status,
    body: text.slice(0, 240),
  });
  assertCheck("suspended asset bootstrap does not expose playable URLs", !text.includes("playback_url") && !text.includes("token="), {
    http_status: bootstrap.status,
  });

  const dashboardResponse = await fetch(`${siteBaseUrl}/dashboard/assets/${assetId}`, {
    cache: "no-store",
    headers: { cookie: sessionCookie },
  });
  const dashboardText = await dashboardResponse.text();
  assertCheck("dashboard shows suspended asset state", dashboardResponse.status === 200 && dashboardText.includes("Asset is suspended"), {
    http_status: dashboardResponse.status,
  });
}

async function verifyOrgSuspensionBlocks(siteBaseUrl, sessionCookie, apiKeySecret, assetId) {
  for (const [name, pathName, method, body] of [
    ["list", "/v1/assets", "GET", undefined],
    ["read", `/v1/assets/${assetId}`, "GET", undefined],
    ["playback", `/v1/assets/${assetId}/playback`, "GET", undefined],
    ["analytics", `/v1/assets/${assetId}/analytics/playback`, "GET", undefined],
    ["delete", `/v1/assets/${assetId}`, "DELETE", undefined],
    ["upload", "/v1/videos", "POST", Buffer.from("blocked")],
  ]) {
    const response = await controlPlaneApiKeyRequest(apiKeySecret, pathName, {
      method,
      body,
      contentType: "video/mp4",
    });
    assertCheck(`suspended org API-key ${name} is blocked`, response.status !== 200 && response.status !== 201, {
      http_status: response.status,
    });
  }

  const siteUpload = await fetch(`${siteBaseUrl}/api/assets`, {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      "content-type": "video/mp4",
      "content-length": "7",
    },
    body: Buffer.from("blocked"),
  });
  const siteUploadText = await siteUpload.text();
  assertCheck("suspended org dashboard upload is blocked", siteUpload.status === 403 && siteUploadText.includes("organization_suspended"), {
    http_status: siteUpload.status,
  });

  const bootstrap = await fetch(`${siteBaseUrl}/api/player/${assetId}`, { cache: "no-store" });
  const bootstrapText = await bootstrap.text();
  assertCheck("suspended org site bootstrap is unavailable", bootstrap.status !== 200 || !bootstrapText.includes('"status":"ready"'), {
    http_status: bootstrap.status,
  });

  const dashboardResponse = await fetch(`${siteBaseUrl}/dashboard/assets/${assetId}`, {
    cache: "no-store",
    headers: { cookie: sessionCookie },
  });
  const dashboardText = await dashboardResponse.text();
  assertCheck("dashboard shows suspended organization state", dashboardResponse.status === 200 && dashboardText.includes("Organization is suspended"), {
    http_status: dashboardResponse.status,
  });
}

async function verifyRestoredPlayback(siteBaseUrl, apiKeySecret, assetId, expectedPlayableState) {
  const detailResponse = await controlPlaneApiKeyRequest(apiKeySecret, `/v1/assets/${assetId}`);
  const detailBody = await detailResponse.json().catch(() => ({}));
  assertCheck("restored API-key asset read succeeds without losing metadata", detailResponse.status === 200 && detailBody.playable_state === expectedPlayableState, {
    http_status: detailResponse.status,
    playable_state: detailBody.playable_state,
  });

  const bootstrap = await fetch(`${siteBaseUrl}/api/player/${assetId}`, { cache: "no-store" });
  const bootstrapText = await bootstrap.text();
  assertCheck("restored asset bootstrap is playable again", bootstrap.status === 200 && bootstrapText.includes('"status":"ready"') && !bootstrapText.includes("token="), {
    http_status: bootstrap.status,
    body: bootstrapText.slice(0, 240),
  });
}

async function playerSnapshot(page) {
  return evaluate(
    page,
    `(() => {
      const root = document.querySelector("[data-rend-player-state]");
      const video = document.querySelector("video");
      return {
        state: root?.getAttribute("data-rend-player-state") || null,
        selected: root?.getAttribute("data-rend-player-selected") || null,
        artifact: root?.getAttribute("data-rend-player-artifact") || null,
        readyState: video?.readyState ?? null,
        currentSrc: video?.currentSrc || null,
        duration: Number.isFinite(video?.duration) ? video.duration : null,
        paused: video?.paused ?? null
      };
    })()`
  );
}

function assertExpectedPlaybackSource(asset, snapshot) {
  if (asset.playable_state === "hls_ready") {
    assertCheck(
      "hls_ready asset plays HLS, not opener fallback",
      ["native_hls", "hls_js"].includes(snapshot.selected) &&
        snapshot.artifact === "hls/master.m3u8" &&
        typeof snapshot.duration === "number" &&
        snapshot.duration > 5.5,
      {
        playable_state: asset.playable_state,
        selected: snapshot.selected,
        artifact: snapshot.artifact,
        duration: snapshot.duration,
      }
    );
    return;
  }

  if (asset.playable_state === "opener_ready") {
    assertCheck(
      "opener_ready asset plays opener fallback",
      snapshot.selected === "opener" && snapshot.artifact === "opener.mp4",
      {
        playable_state: asset.playable_state,
        selected: snapshot.selected,
        artifact: snapshot.artifact,
      }
    );
  }
}

async function verifyPlayback(page, siteBaseUrl, assetId, asset) {
  await navigate(page, `${siteBaseUrl}/watch/${assetId}?autoplay=1`);
  const startedAt = Date.now();
  let snapshot = null;
  while (Date.now() - startedAt < 60_000) {
    snapshot = await playerSnapshot(page);
    if (
      ["canplay", "playing", "ready", "metadata"].includes(snapshot.state) &&
      snapshot.readyState >= 1
    ) {
      artifact.local.playback = snapshot;
      addCheck("watch page reaches playable state", true, snapshot);
      assertExpectedPlaybackSource(asset, snapshot);
      return snapshot;
    }
    await sleep(500);
  }
  assertCheck("watch page reaches playable state", false, snapshot || {});
}

async function waitForPlayerTelemetry(siteBaseUrl, sessionCookie, assetId) {
  const startedAt = Date.now();
  let lastBody = null;
  while (Date.now() - startedAt < 60_000) {
    const response = await fetch(
      `${siteBaseUrl}/api/assets/player-telemetry/recent?assetId=${assetId}&limit=20`,
      {
        cache: "no-store",
        headers: { cookie: sessionCookie },
      }
    );
    lastBody = await response.json().catch(() => ({}));
    const events = Array.isArray(lastBody.events) ? lastBody.events : [];
    if (events.some((event) => ["source_selected", "metadata_loaded", "canplay", "first_frame"].includes(event.phase))) {
      artifact.local.player_telemetry = { count: events.length, phases: events.map((event) => event.phase) };
      return lastBody;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for player startup telemetry: ${JSON.stringify(lastBody)}`);
}

async function waitForAnalytics(siteBaseUrl, sessionCookie, assetId) {
  const startedAt = Date.now();
  let lastBody = null;
  while (Date.now() - startedAt < 90_000) {
    const response = await fetch(`${siteBaseUrl}/api/assets/${assetId}/analytics?windowSeconds=3600`, {
      cache: "no-store",
      headers: { cookie: sessionCookie },
    });
    lastBody = await response.json().catch(() => ({}));
    const requestCount = lastBody.analytics?.request_count || 0;
    if (response.ok && requestCount > 0) {
      artifact.local.analytics = lastBody.analytics;
      return lastBody.analytics;
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for playback analytics: ${JSON.stringify(lastBody)}`);
}

async function deleteThroughUi(page, siteBaseUrl, assetId) {
  await navigate(page, `${siteBaseUrl}/dashboard/assets/${assetId}`);
  await evaluate(page, "window.confirm = () => true");
  await evaluate(
    page,
    `Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Delete").click()`
  );
  await waitForBrowser(
    page,
    `document.body.innerText.includes("Deleted and playback bootstrap no longer returns a playable source.")`,
    90_000
  );
  addCheck("dashboard UI deletes asset and verifies playback unavailable", true);
}

async function verifyNoPlaybackRefill(siteBaseUrl, assetId) {
  const response = await fetch(`${siteBaseUrl}/api/player/${assetId}`, { cache: "no-store" });
  const text = await response.text();
  assertCheck("deleted asset bootstrap is unavailable", response.status !== 200 || !text.includes('"status":"ready"'), {
    http_status: response.status,
    body: text.slice(0, 240),
  });
  assertCheck("deleted asset bootstrap does not refill signed URL", !text.includes("playback_url") && !text.includes("token="), {
    http_status: response.status,
  });
}

function assertNoLeaks(name, text) {
  const needles = [
    ["REND_DEV_API_KEY value", apiKey],
    ["raw edge signed prefix", `${edgeBaseUrl}/v/`],
  ].filter(([, value]) => value);

  for (const [label, value] of needles) {
    assertCheck(`${name} does not leak ${label}`, !text.includes(value), {
      length: text.length,
    });
  }

  assertCheck(
    `${name} does not leak signed URL query strings`,
    !/https?:\/\/[^\s"'<>]+[?&]token=/i.test(text),
    { length: text.length }
  );
}

async function verifyLeakSurfaces(siteBaseUrl, sessionCookie, assetId, telemetryBody, logPath) {
  const htmlResponses = [];
  for (const route of ["/login", "/dashboard/assets", `/dashboard/assets/${assetId}`]) {
    const response = await fetch(`${siteBaseUrl}${route}`, {
      cache: "no-store",
      headers: route === "/login" ? undefined : { cookie: sessionCookie },
    });
    const text = await response.text();
    htmlResponses.push({ route, text });
    assertCheck(`HTML ${route} loads`, response.status === 200, { http_status: response.status });
    assertNoLeaks(`HTML ${route}`, text);
  }

  const bundleUrls = new Set();
  for (const { text } of htmlResponses) {
    for (const match of text.matchAll(/(?:src|href)="([^"]*\/_next\/[^"]+\.js[^"]*)"/g)) {
      bundleUrls.add(new URL(match[1], siteBaseUrl).toString());
    }
  }
  for (const bundleUrl of Array.from(bundleUrls).slice(0, 20)) {
    const response = await fetch(bundleUrl, { cache: "no-store" });
    const text = await response.text();
    assertNoLeaks(`bundle ${bundleUrl}`, text);
  }

  assertNoLeaks("player telemetry response", JSON.stringify(telemetryBody));

  if (logPath && existsSync(logPath)) {
    assertNoLeaks("site logs", readFileSync(logPath, "utf8"));
  }
}

async function main() {
  await mkdir(runDir, { recursive: true });
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });

  log("starting local backend");
  await ensureLocalBackend();

  const site = await startSite();
  const chrome = await launchChrome();
  const page = await newPage(chrome.port);

  try {
    log("signing in to dashboard");
    const sessionCookie = await loginThroughApi(site.baseUrl, site.logPath);
    await loginThroughBrowser(page, site.baseUrl, sessionCookie);

    log("uploading fixture through apps/site");
    const assetId = await uploadFixtureThroughSite(site.baseUrl, sessionCookie);
    const playableAsset = await waitForPlayable(site.baseUrl, sessionCookie, assetId);
    const apiKeySecret = await createApiKeyThroughSite(site.baseUrl, sessionCookie);

    log("verifying dashboard UI");
    await verifyDashboardUi(page, site.baseUrl, assetId);

    log("verifying private operator UI");
    await verifyOperatorUi(page, site.baseUrl);

    log("verifying watch playback");
    await verifyPlayback(page, site.baseUrl, assetId, playableAsset);

    log("waiting for telemetry and analytics");
    const telemetryBody = await waitForPlayerTelemetry(site.baseUrl, sessionCookie, assetId);
    await waitForAnalytics(site.baseUrl, sessionCookie, assetId);

    log("scanning safe surfaces");
    await verifyLeakSurfaces(site.baseUrl, sessionCookie, assetId, telemetryBody, site.logPath);

    log("suspending and restoring asset");
    const unsafeReason = `unsafe playback https://edge.example/v/${assetId}/opener.mp4?token=secret Authorization: Bearer abc`;
    await operatorActionThroughSite(site.baseUrl, sessionCookie, {
      action: "suspend",
      targetType: "asset",
      targetId: assetId,
      reason: unsafeReason,
    });
    await verifyAssetSuspensionBlocks(site.baseUrl, sessionCookie, apiKeySecret, assetId);
    await verifyOperatorAuditNoLeaks(site.baseUrl, sessionCookie);
    await operatorActionThroughSite(site.baseUrl, sessionCookie, {
      action: "restore",
      targetType: "asset",
      targetId: assetId,
      reason: "asset review cleared",
    });
    await verifyRestoredPlayback(site.baseUrl, apiKeySecret, assetId, playableAsset.playable_state);

    log("suspending and restoring organization");
    await operatorActionThroughSite(site.baseUrl, sessionCookie, {
      action: "suspend",
      targetType: "organization",
      targetId: "00000000-0000-0000-0000-000000000001",
      reason: "workspace abuse control",
    });
    await verifyOrgSuspensionBlocks(site.baseUrl, sessionCookie, apiKeySecret, assetId);
    await operatorActionThroughSite(site.baseUrl, sessionCookie, {
      action: "restore",
      targetType: "organization",
      targetId: "00000000-0000-0000-0000-000000000001",
      reason: "workspace review cleared",
    });
    await verifyRestoredPlayback(site.baseUrl, apiKeySecret, assetId, playableAsset.playable_state);

    log("deleting asset through UI");
    await deleteThroughUi(page, site.baseUrl, assetId);
    await verifyNoPlaybackRefill(site.baseUrl, assetId);
  } finally {
    shuttingDown = true;
    page.close();
    await chrome.stop();
    await site.stop();
    for (const child of children) child.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(130);
});

main()
  .then(async () => {
    await writeArtifact();
    if (failures.length > 0) {
      console.error(`[goal31] failed; artifact: ${resultPath}`);
      process.exit(1);
    }
    console.log(`[goal31] passed; artifact: ${resultPath}`);
  })
  .catch(async (error) => {
    failures.push({ name: "unhandled error", details: { message: error.message, stack: error.stack } });
    await writeArtifact();
    shuttingDown = true;
    for (const child of children) child.kill("SIGTERM");
    console.error(error);
    console.error(`[goal31] failed; artifact: ${resultPath}`);
    process.exit(1);
  });
