#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(repoRoot, "apps", "site");
const goalDir = path.join(repoRoot, ".rend", "goal28");
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const runDir = path.join(goalDir, `local-player-telemetry-${runId}`);
const resultPath = path.join(runDir, "player-telemetry-e2e.json");
const latestPath = path.join(goalDir, "latest-local-player-telemetry-e2e.json");

const apiBaseUrl = trimTrailingSlash(process.env.REND_API_BASE_URL || "http://127.0.0.1:4000");
const edgeBaseUrl = trimTrailingSlash(process.env.REND_EDGE_BASE_URL || "http://127.0.0.1:4100");
const apiKey = process.env.REND_DEV_API_KEY || "dev-api-key";
const fixturePath = process.env.REND_SMOKE_FIXTURE || path.join(runDir, "rend-goal28-fixture.mp4");
const siteBaseOverride = process.env.REND_SITE_BASE_URL
  ? trimTrailingSlash(process.env.REND_SITE_BASE_URL)
  : "";

const children = [];
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
  console.log(`[goal28] ${message}`);
}

function addCheck(name, ok, details = {}) {
  artifact.checks.push({ name, ok, details });
  if (!ok) failures.push({ name, details });
}

function assertCheck(name, condition, details = {}) {
  addCheck(name, Boolean(condition), details);
  if (!condition) {
    throw new Error(`check failed: ${name}`);
  }
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

function redactedCommand(cmd, args) {
  return [cmd, ...args].join(" ");
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
          reject(new Error(`${redactedCommand(cmd, args)} timed out`));
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
        command: redactedCommand(cmd, args),
        exit_code: code,
        signal,
        duration_ms: Date.now() - startedAt,
      };
      artifact.local.commands = artifact.local.commands || [];
      artifact.local.commands.push(record);

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${redactedCommand(cmd, args)} exited with ${code ?? signal}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  let lastError = "";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
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

async function uploadFixture() {
  await runCommand("scripts/generate-fixture-video.sh", [fixturePath], { timeoutMs: 120_000 });
  const fixtureBytes = await readFile(fixturePath);

  const response = await fetch(`${apiBaseUrl}/v1/videos`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "video/mp4",
      "content-length": String(fixtureBytes.byteLength),
    },
    body: fixtureBytes,
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  assertCheck("fresh fixture upload accepted", response.status === 201 && body.asset_id, {
    http_status: response.status,
    asset_id: body.asset_id,
  });

  const assetId = body.asset_id;
  const startedAt = Date.now();
  let lastAsset = body;
  while (Date.now() - startedAt < 180_000) {
    const assetResponse = await fetch(`${apiBaseUrl}/v1/assets/${encodeURIComponent(assetId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    lastAsset = await assetResponse.json().catch(() => ({}));
    if (assetResponse.ok && lastAsset.playable_state === "hls_ready") {
      artifact.local.asset = {
        asset_id: assetId,
        playable_state: lastAsset.playable_state,
        source_state: lastAsset.source_state,
        processing_ms: Date.now() - startedAt,
      };
      return assetId;
    }
    if (lastAsset.playable_state === "failed") {
      throw new Error(`media processing failed for ${assetId}`);
    }
    await sleep(1_000);
  }

  throw new Error(`timed out waiting for ${assetId} to become hls_ready`);
}

async function startSite() {
  if (siteBaseOverride) {
    await waitForHttp(siteBaseOverride, {
      timeoutMs: 30_000,
      accept: (response) => response.status < 500,
    });
    artifact.local.site = { base_url: siteBaseOverride, started: false };
    return { baseUrl: siteBaseOverride, stop: async () => undefined };
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
      ...process.env,
      REND_API_BASE_URL: apiBaseUrl,
      REND_DEV_API_KEY: apiKey,
      REND_PLAYER_PLAYBACK_BASE_URL: edgeBaseUrl,
      REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS: [...new Set(allowedPlaybackBases)].join(","),
      REND_PLAYER_TELEMETRY_DEBUG: "1",
      REND_PLAYER_TELEMETRY_INGEST: "1",
      NEXT_PUBLIC_REND_APP_VERSION: `goal28-${runId}`,
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

  await waitForHttp(`${baseUrl}/api/player/telemetry/recent`, {
    timeoutMs: 120_000,
    accept: (response) => response.status === 200,
  });

  artifact.local.site = { base_url: baseUrl, started: true, log_path: logPath };
  return {
    baseUrl,
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
  await page.send("Network.enable", {
    maxTotalBufferSize: 20_000_000,
    maxResourceBufferSize: 10_000_000,
  });
  return page;
}

function attachNetworkCapture(page) {
  const requests = new Map();

  page.on("Network.requestWillBeSent", (params) => {
    requests.set(params.requestId, {
      request_id: params.requestId,
      url: params.request.url,
      method: params.request.method,
      resource_type: params.type,
      post_data: params.request.postData,
      request_headers: params.request.headers || {},
    });
  });

  page.on("Network.responseReceived", (params) => {
    const record = requests.get(params.requestId);
    if (!record) return;
    record.status = params.response.status;
    record.mime_type = params.response.mimeType;
    record.response_headers = params.response.headers || {};
  });

  page.on("Network.loadingFinished", (params) => {
    const record = requests.get(params.requestId);
    if (!record) return;
    record.encoded_data_length = params.encodedDataLength;
    record.finished = true;
  });

  page.on("Network.loadingFailed", (params) => {
    const record = requests.get(params.requestId);
    if (!record) return;
    record.failed = true;
    record.error_text = params.errorText;
    record.blocked_reason = params.blockedReason;
  });

  return {
    all() {
      return Array.from(requests.values());
    },
    telemetryPosts(siteBaseUrl) {
      const prefix = `${siteBaseUrl}/api/player/telemetry`;
      return Array.from(requests.values()).filter(
        (request) => request.method === "POST" && request.url.startsWith(prefix)
      );
    },
  };
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
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await evaluate(page, `Boolean(${predicateExpression})`);
    if (lastValue) return true;
    await sleep(250);
  }
  throw new Error(`timed out waiting in browser for: ${predicateExpression}`);
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
        bootstrapMs: Number(root?.getAttribute("data-rend-bootstrap-ms") || 0) || null,
        metadataMs: Number(root?.getAttribute("data-rend-metadata-ms") || 0) || null,
        canplayMs: Number(root?.getAttribute("data-rend-canplay-ms") || 0) || null,
        firstFrameMs: Number(root?.getAttribute("data-rend-first-frame-ms") || 0) || null,
        assetId: root?.getAttribute("data-rend-asset-id") || null,
        playbackSessionId: root?.getAttribute("data-rend-playback-session-id") || null,
        readyState: video?.readyState ?? null,
        currentTime: video?.currentTime ?? null,
        paused: video?.paused ?? null,
        videoWidth: video?.videoWidth ?? null,
        videoHeight: video?.videoHeight ?? null,
        errorCode: video?.error?.code ?? null,
      };
    })()`
  );
}

async function waitForPlayback(page) {
  await waitForBrowser(page, `document.querySelector("[data-rend-player-state]")`, 60_000);

  let snapshot = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 90_000) {
    await evaluate(
      page,
      `(async () => {
        const video = document.querySelector("video");
        if (video && video.paused) {
          await video.play().catch(() => undefined);
        }
        return true;
      })()`
    );
    snapshot = await playerSnapshot(page);
    if (
      snapshot.readyState >= 2 &&
      snapshot.currentTime > 0.1 &&
      ["canplay", "playing"].includes(snapshot.state)
    ) {
      await sleep(1_000);
      const later = await playerSnapshot(page);
      if (later.currentTime > snapshot.currentTime) return later;
    }
    await sleep(500);
  }

  throw new Error(`video playback did not advance; last snapshot: ${JSON.stringify(snapshot)}`);
}

async function waitForUnavailable(page) {
  await waitForBrowser(page, `document.querySelector("[data-rend-player-state]")`, 60_000);
  const startedAt = Date.now();
  let snapshot = null;
  while (Date.now() - startedAt < 45_000) {
    snapshot = await playerSnapshot(page);
    if (["unavailable", "not_playable", "bootstrap_failure"].includes(snapshot.state)) {
      return snapshot;
    }
    await sleep(500);
  }
  throw new Error(`unavailable asset did not reach failure state; last snapshot: ${JSON.stringify(snapshot)}`);
}

async function waitForRecentEvents(siteBaseUrl, assetId, playbackSessionId, requiredPhases) {
  const url = `${siteBaseUrl}/api/player/telemetry/recent?assetId=${encodeURIComponent(
    assetId
  )}&playbackSessionId=${encodeURIComponent(playbackSessionId)}&limit=100`;
  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt < 60_000) {
    const response = await fetch(url, { cache: "no-store" });
    last = await response.json().catch(() => ({}));
    const events = Array.isArray(last.events) ? last.events : [];
    const phases = new Set(events.map((event) => event.phase));
    if (response.ok && requiredPhases.every((phase) => phases.has(phase))) {
      return { url, events };
    }
    await sleep(500);
  }

  throw new Error(`recent telemetry did not contain phases ${requiredPhases.join(", ")}: ${JSON.stringify(last)}`);
}

function leakHits(value, options = {}) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const edgeHost = new URL(edgeBaseUrl).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    ["signed_token_query", /[?&](token|signature|secret|api[_-]?key|authorization|cookie)=/i],
    ["full_edge_url", new RegExp(`https?://${edgeHost}/v/`, "i")],
  ];
  if (options.includeAuth !== false) {
    patterns.push(["authorization_header", /\bauthorization\s*[:=]\s*(bearer|basic)\s+\S+/i]);
  }
  if (options.includeCookie !== false) {
    patterns.push(["cookie_header", /\b(?:set-cookie|cookie)\s*[:=]\s*(?:[a-z0-9_.-]+=|[^;"'\s,}]{12,})/i]);
  }
  if (options.noUrls) patterns.push(["absolute_url", /https?:\/\//i]);
  return patterns
    .filter(([, pattern]) => pattern.test(serialized))
    .map(([name]) => name);
}

function eventSummary(events) {
  return events.map((event) => ({
    phase: event.phase,
    page_type: event.page_type,
    playback_session_id: event.playback_session_id,
    bootstrap_duration_ms: event.bootstrap_duration_ms,
    bootstrap_http_status: event.bootstrap_http_status,
    selected_playback_mode: event.selected_playback_mode,
    selected_artifact_path: event.selected_artifact_path,
    metadata_loaded_ms: event.metadata_loaded_ms,
    canplay_ms: event.canplay_ms,
    first_frame_ms: event.first_frame_ms,
    playback_failure_code: event.playback_failure_code,
    playback_failure_reason: event.playback_failure_reason,
    edge_label: event.edge_label,
    region_label: event.region_label,
  }));
}

async function scanPageAndBundles(siteBaseUrl, embedUrl) {
  const html = await fetch(embedUrl, { cache: "no-store" }).then((response) => response.text());
  const scriptSources = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g)).map((match) => match[1]);
  const bundleResults = [];

  for (const src of scriptSources.filter((value) => value.includes("/_next/")).slice(0, 20)) {
    const url = src.startsWith("http") ? src : `${siteBaseUrl}${src}`;
    const text = await fetch(url, { cache: "no-store" }).then((response) => response.text()).catch(() => "");
    const urlPath = new URL(url).pathname;
    const frameworkChunk =
      /\/_next\/static\/chunks\/(?:[^/]+_next_dist_|%5Bturbopack%5D)/.test(urlPath);
    bundleResults.push({
      url_path: urlPath,
      byte_length: text.length,
      cookie_scan: frameworkChunk ? "skipped_next_framework_chunk" : "checked",
      leak_hits: leakHits(text, { includeCookie: !frameworkChunk }),
    });
  }

  return {
    html: {
      byte_length: html.length,
      leak_hits: leakHits(html),
    },
    bundles: bundleResults,
  };
}

async function configureTelemetryBlock(page, siteBaseUrl) {
  await page.send("Fetch.enable", {
    patterns: [{ urlPattern: `${siteBaseUrl}/api/player/telemetry*`, requestStage: "Request" }],
  });
  let blockedCount = 0;
  page.on("Fetch.requestPaused", async (params) => {
    if (params.request?.method === "POST" && params.request.url.startsWith(`${siteBaseUrl}/api/player/telemetry`)) {
      blockedCount += 1;
      await page.send("Fetch.failRequest", {
        requestId: params.requestId,
        errorReason: "Failed",
      });
      return;
    }
    await page.send("Fetch.continueRequest", { requestId: params.requestId });
  });
  return () => blockedCount;
}

function validatePlaybackEvents(events) {
  const byPhase = new Map(events.map((event) => [event.phase, event]));
  const bootstrap = byPhase.get("bootstrap_complete");
  const source = byPhase.get("source_selected");
  const metadata = byPhase.get("metadata_loaded");
  const canplay = byPhase.get("canplay");
  const firstFrame = byPhase.get("first_frame");

  return {
    bootstrap_timing: Boolean(
      bootstrap &&
        bootstrap.bootstrap_http_status === 200 &&
        Number.isFinite(bootstrap.bootstrap_duration_ms) &&
        Number.isFinite(bootstrap.bootstrap_end_ms)
    ),
    source_selection: Boolean(source?.selected_playback_mode && source?.selected_artifact_path),
    metadata_timing: Number.isFinite(metadata?.metadata_loaded_ms),
    canplay_timing: Number.isFinite(canplay?.canplay_ms),
    first_frame_timing: Number.isFinite(firstFrame?.first_frame_ms),
  };
}

function validatePageType(events, pageType) {
  return events
    .filter((event) => event.phase !== "player_load")
    .every((event) => event.page_type === pageType);
}

async function runPlaybackScenario({
  chromePort,
  siteBaseUrl,
  assetId,
  name,
  route = "embed",
  blockTelemetry = false,
}) {
  const page = await newPage(chromePort);
  const capture = attachNetworkCapture(page);
  const blockedTelemetryCount = blockTelemetry ? await configureTelemetryBlock(page, siteBaseUrl) : () => 0;
  const playbackUrl = `${siteBaseUrl}/${route}/${encodeURIComponent(assetId)}?autoplay=1&playbackBaseUrl=${encodeURIComponent(edgeBaseUrl)}`;

  await navigate(page, playbackUrl);
  const playback = await waitForPlayback(page);
  const telemetryPosts = capture.telemetryPosts(siteBaseUrl);
  page.close();

  return {
    name,
    route,
    url: playbackUrl,
    playback,
    telemetry_posts: telemetryPosts.map((request) => ({
      url_path: new URL(request.url).pathname,
      status: request.status ?? null,
      failed: Boolean(request.failed),
      error_text: request.error_text,
      post_data_bytes: request.post_data ? Buffer.byteLength(request.post_data) : null,
    })),
    blocked_telemetry_count: blockedTelemetryCount(),
  };
}

async function runUnavailableScenario({ chromePort, siteBaseUrl }) {
  const page = await newPage(chromePort);
  const capture = attachNetworkCapture(page);
  const missingAssetId = `missing-${randomUUID()}`;
  const embedUrl = `${siteBaseUrl}/embed/${encodeURIComponent(missingAssetId)}?autoplay=1&playbackBaseUrl=${encodeURIComponent(edgeBaseUrl)}`;

  await navigate(page, embedUrl);
  const snapshot = await waitForUnavailable(page);
  const recent = await waitForRecentEvents(siteBaseUrl, missingAssetId, snapshot.playbackSessionId, [
    "bootstrap_complete",
    "bootstrap_failure",
  ]);
  const telemetryPosts = capture.telemetryPosts(siteBaseUrl);
  page.close();

  return {
    asset_id: missingAssetId,
    url: embedUrl,
    snapshot,
    telemetry_posts: telemetryPosts.map((request) => ({
      url_path: new URL(request.url).pathname,
      status: request.status ?? null,
      failed: Boolean(request.failed),
      post_data_bytes: request.post_data ? Buffer.byteLength(request.post_data) : null,
    })),
    recent_url: recent.url,
    events: recent.events,
    event_summary: eventSummary(recent.events),
  };
}

async function checkLogLeaks() {
  const results = [];
  for (const logPath of [artifact.local.site?.log_path, artifact.local.chrome?.log_path].filter(Boolean)) {
    const text = await readFile(logPath, "utf8").catch(() => "");
    results.push({
      path: logPath,
      byte_length: text.length,
      leak_hits: leakHits(text),
    });
  }
  return results;
}

async function cleanupChildren(extraStops = []) {
  for (const stop of extraStops) {
    await stop().catch(() => undefined);
  }
  for (const child of children.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  await sleep(500);
  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }
  await rm(path.join(runDir, "chrome-profile"), { recursive: true, force: true }).catch(() => undefined);
}

async function main() {
  await mkdir(runDir, { recursive: true });

  log("starting Docker services");
  await runCommand("docker", ["compose", "up", "-d", "--wait"], { timeoutMs: 240_000 });
  await waitForHttp(`${apiBaseUrl}/readyz`, { timeoutMs: 60_000, accept: (response) => response.ok });
  await waitForHttp(`${edgeBaseUrl}/readyz`, { timeoutMs: 60_000, accept: (response) => response.ok });

  log("uploading and processing a fresh fixture");
  const assetId = await uploadFixture();
  log(`fresh asset is hls_ready: ${assetId}`);

  const site = await startSite();
  const chrome = await launchChrome();
  const stops = [site.stop, chrome.stop];

  try {
    log("driving browser playback through /embed");
    const embedPlayback = await runPlaybackScenario({
      chromePort: chrome.port,
      siteBaseUrl: site.baseUrl,
      assetId,
      name: "local_embed_playback",
      route: "embed",
    });
    artifact.local.embed_playback = embedPlayback;

    assertCheck("embed video reached readyState and advanced", embedPlayback.playback.readyState >= 2 && embedPlayback.playback.currentTime > 0.1, embedPlayback.playback);
    assertCheck("embed telemetry POST reached site endpoint", embedPlayback.telemetry_posts.some((post) => post.status === 200), embedPlayback.telemetry_posts);

    const embedRecent = await waitForRecentEvents(site.baseUrl, assetId, embedPlayback.playback.playbackSessionId, [
      "player_load",
      "bootstrap_complete",
      "source_selected",
      "metadata_loaded",
      "canplay",
      "first_frame",
    ]);
    artifact.local.embed_recent = {
      url: embedRecent.url,
      events: embedRecent.events,
      event_summary: eventSummary(embedRecent.events),
    };

    const embedEventQuality = validatePlaybackEvents(embedRecent.events);
    artifact.local.embed_event_quality = embedEventQuality;
    assertCheck("embed telemetry contains same playback_session_id", embedRecent.events.every((event) => event.playback_session_id === embedPlayback.playback.playbackSessionId), {
      playback_session_id: embedPlayback.playback.playbackSessionId,
      count: embedRecent.events.length,
    });
    assertCheck("embed telemetry is labeled with page_type embed", validatePageType(embedRecent.events, "embed"), {
      event_summary: eventSummary(embedRecent.events),
    });
    assertCheck("embed bootstrap timing exists", embedEventQuality.bootstrap_timing, embedEventQuality);
    assertCheck("embed selected playback mode and artifact exist", embedEventQuality.source_selection, embedEventQuality);
    assertCheck("embed metadata/canplay/first-frame timing exists", embedEventQuality.metadata_timing && embedEventQuality.canplay_timing && embedEventQuality.first_frame_timing, embedEventQuality);
    assertCheck("embed stored telemetry is sanitized", leakHits(embedRecent.events, { noUrls: true }).length === 0, {
      leak_hits: leakHits(embedRecent.events, { noUrls: true }),
    });

    log("driving browser playback through /watch");
    const watchPlayback = await runPlaybackScenario({
      chromePort: chrome.port,
      siteBaseUrl: site.baseUrl,
      assetId,
      name: "local_watch_playback",
      route: "watch",
    });
    artifact.local.watch_playback = watchPlayback;

    assertCheck("watch video reached readyState and advanced", watchPlayback.playback.readyState >= 2 && watchPlayback.playback.currentTime > 0.1, watchPlayback.playback);
    assertCheck("watch telemetry POST reached site endpoint", watchPlayback.telemetry_posts.some((post) => post.status === 200), watchPlayback.telemetry_posts);

    const watchRecent = await waitForRecentEvents(site.baseUrl, assetId, watchPlayback.playback.playbackSessionId, [
      "player_load",
      "bootstrap_complete",
      "source_selected",
      "metadata_loaded",
      "canplay",
      "first_frame",
    ]);
    artifact.local.watch_recent = {
      url: watchRecent.url,
      events: watchRecent.events,
      event_summary: eventSummary(watchRecent.events),
    };

    const watchEventQuality = validatePlaybackEvents(watchRecent.events);
    artifact.local.watch_event_quality = watchEventQuality;
    assertCheck("watch telemetry contains same playback_session_id", watchRecent.events.every((event) => event.playback_session_id === watchPlayback.playback.playbackSessionId), {
      playback_session_id: watchPlayback.playback.playbackSessionId,
      count: watchRecent.events.length,
    });
    assertCheck("watch telemetry is labeled with page_type watch", validatePageType(watchRecent.events, "watch"), {
      event_summary: eventSummary(watchRecent.events),
    });
    assertCheck("watch bootstrap timing exists", watchEventQuality.bootstrap_timing, watchEventQuality);
    assertCheck("watch selected playback mode and artifact exist", watchEventQuality.source_selection, watchEventQuality);
    assertCheck("watch metadata/canplay/first-frame timing exists", watchEventQuality.metadata_timing && watchEventQuality.canplay_timing && watchEventQuality.first_frame_timing, watchEventQuality);
    assertCheck("watch stored telemetry is sanitized", leakHits(watchRecent.events, { noUrls: true }).length === 0, {
      leak_hits: leakHits(watchRecent.events, { noUrls: true }),
    });

    log("checking unavailable asset telemetry");
    const unavailable = await runUnavailableScenario({ chromePort: chrome.port, siteBaseUrl: site.baseUrl });
    artifact.local.unavailable = unavailable;
    const failureLeakHits = leakHits(unavailable.events, { noUrls: true });
    const failureEvent = unavailable.events.find((event) => event.phase === "bootstrap_failure");
    assertCheck("unavailable asset emits bounded sanitized failure telemetry", failureEvent && failureLeakHits.length === 0 && (failureEvent.playback_failure_reason || "").length <= 180, {
      state: unavailable.snapshot.state,
      failure_event: failureEvent ? eventSummary([failureEvent])[0] : null,
      leak_hits: failureLeakHits,
    });

    log("blocking telemetry endpoint and verifying playback still advances");
    const blocked = await runPlaybackScenario({
      chromePort: chrome.port,
      siteBaseUrl: site.baseUrl,
      assetId,
      name: "telemetry_blocked_playback",
      blockTelemetry: true,
    });
    artifact.local.telemetry_blocked_playback = blocked;
    assertCheck("telemetry failure does not break playback", blocked.playback.readyState >= 2 && blocked.playback.currentTime > 0.1 && blocked.blocked_telemetry_count > 0, {
      playback: blocked.playback,
      blocked_telemetry_count: blocked.blocked_telemetry_count,
    });

    log("scanning page HTML, client bundles, and local logs for signed URL leaks");
    artifact.local.leak_scan = await scanPageAndBundles(site.baseUrl, `${site.baseUrl}/embed/${encodeURIComponent(assetId)}`);
    artifact.local.log_leak_scan = await checkLogLeaks();
    const bundleLeakHits = artifact.local.leak_scan.bundles.flatMap((bundle) => bundle.leak_hits);
    const logLeakHits = artifact.local.log_leak_scan.flatMap((entry) => entry.leak_hits);
    assertCheck("page HTML has no signed playback leak", artifact.local.leak_scan.html.leak_hits.length === 0, artifact.local.leak_scan.html);
    assertCheck("client bundles have no signed playback leak", bundleLeakHits.length === 0, { leak_hits: bundleLeakHits });
    assertCheck("local site/browser logs have no signed playback leak", logLeakHits.length === 0, { leak_hits: logLeakHits });
  } finally {
    await cleanupChildren(stops);
  }
}

main()
  .catch((error) => {
    failures.push({ name: "script_error", details: { message: error.message, stack: error.stack } });
    process.exitCode = 1;
  })
  .finally(async () => {
    await writeArtifact();
    if (failures.length > 0) {
      console.error(`[goal28] failed; artifact written to ${resultPath}`);
      return;
    }
    console.log(`[goal28] passed; artifact written to ${resultPath}`);
  });
