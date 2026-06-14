#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const curlTimingFormat =
  "http_code=%{http_code}\\ntime_connect=%{time_connect}\\ntime_starttransfer=%{time_starttransfer}\\ntime_total=%{time_total}\\nsize_download=%{size_download}\\nsize_upload=%{size_upload}\\n";

const defaultThresholds = {
  upload_response_ms: { warn: 5_000, fail: 15_000 },
  upload_to_opener_playable_ms: { warn: 60_000, fail: 180_000 },
  upload_to_hls_ready_ms: { warn: 90_000, fail: 240_000 },
  playback_bootstrap_response_ms: { warn: 1_000, fail: 3_000 },
  edge_ttfb_miss_ms: { warn: 2_000, fail: 6_000 },
  edge_ttfb_hit_ms: { warn: 300, fail: 1_000 },
  edge_ttfb_warmed_hit_ms: { warn: 300, fail: 1_000 },
  telemetry_visibility_ms: { warn: 10_000, fail: 60_000 },
};

const thresholdEnv = {
  upload_response_ms: ["REND_READINESS_WARN_UPLOAD_RESPONSE_MS", "REND_READINESS_FAIL_UPLOAD_RESPONSE_MS"],
  upload_to_opener_playable_ms: [
    "REND_READINESS_WARN_UPLOAD_TO_OPENER_PLAYABLE_MS",
    "REND_READINESS_FAIL_UPLOAD_TO_OPENER_PLAYABLE_MS",
  ],
  upload_to_hls_ready_ms: [
    "REND_READINESS_WARN_UPLOAD_TO_HLS_READY_MS",
    "REND_READINESS_FAIL_UPLOAD_TO_HLS_READY_MS",
  ],
  playback_bootstrap_response_ms: [
    "REND_READINESS_WARN_PLAYBACK_BOOTSTRAP_MS",
    "REND_READINESS_FAIL_PLAYBACK_BOOTSTRAP_MS",
  ],
  edge_ttfb_miss_ms: [
    "REND_READINESS_WARN_EDGE_TTFB_MISS_MS",
    "REND_READINESS_FAIL_EDGE_TTFB_MISS_MS",
  ],
  edge_ttfb_hit_ms: [
    "REND_READINESS_WARN_EDGE_TTFB_HIT_MS",
    "REND_READINESS_FAIL_EDGE_TTFB_HIT_MS",
  ],
  edge_ttfb_warmed_hit_ms: [
    "REND_READINESS_WARN_EDGE_TTFB_WARMED_HIT_MS",
    "REND_READINESS_FAIL_EDGE_TTFB_WARMED_HIT_MS",
  ],
  telemetry_visibility_ms: [
    "REND_READINESS_WARN_TELEMETRY_VISIBILITY_MS",
    "REND_READINESS_FAIL_TELEMETRY_VISIBILITY_MS",
  ],
};

class SafeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SafeError";
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = { edges: [], fixtures: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new SafeError(`missing value for ${arg}`);
      return argv[index];
    };
    switch (arg) {
      case "--target":
        args.target = next();
        break;
      case "--api-base":
        args.apiBase = next();
        break;
      case "--api-key":
        args.apiKey = next();
        break;
      case "--edge-internal-token":
        args.edgeInternalToken = next();
        break;
      case "--edge":
        args.edges.push(next());
        break;
      case "--fixture":
        args.fixtures.push(next());
        break;
      case "--output":
        args.output = next();
        break;
      case "--latest-output":
        args.latestOutput = next();
        break;
      case "--config":
        args.config = next();
        break;
      case "--skip-local-stack":
        args.skipLocalStack = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new SafeError(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage: scripts/playback-readiness-gate.mjs [options]

Runs the production playback readiness gate with synthetic fixture media.

Options:
  --target local-two-edge|configured
      local-two-edge starts/checks the local Docker two-edge profile. configured
      uses only the supplied API and edge env/config.
  --edge edge_id=region=public_base[=private_base]
      Edge to verify. May be repeated. REND_READINESS_EDGES accepts the same
      comma-separated shape.
  --api-base URL
      API base URL. Env: REND_API_BASE_URL.
  --api-key KEY
      Bearer API key with upload, read, delete, and analytics scopes. Env:
      REND_READINESS_API_KEY, REND_API_KEY, or REND_DEV_API_KEY.
  --edge-internal-token TOKEN
      Token for private edge warm, purge, and metrics endpoints. Env:
      REND_EDGE_INTERNAL_TOKEN.
  --fixture small|medium
      Synthetic fixture size. May be repeated. Env: REND_READINESS_FIXTURES.
  --output PATH
      Run artifact path. Env: REND_READINESS_OUTPUT.
  --latest-output PATH
      Latest artifact path for the operator UI. Env: REND_READINESS_LATEST_OUTPUT.
  --config PATH
      Optional JSON config. CLI and env values override config values.
  --skip-local-stack
      Do not start Docker even when target is local-two-edge.
`;
}

function envString(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function trimBaseUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

function absolutePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

async function loadConfig(args) {
  if (!args.config) return {};
  const raw = await readFile(absolutePath(args.config), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SafeError("readiness config must be a JSON object");
  }
  return parsed;
}

function parseList(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseEdges(rawEdges, target) {
  const localDefaults = [
    "rend-edge-us-east=us-east=http://127.0.0.1:4101=http://127.0.0.1:4101",
    "rend-edge-london=london=http://127.0.0.1:4102=http://127.0.0.1:4102",
  ];
  const source = rawEdges.length > 0 ? rawEdges : target === "local-two-edge" ? localDefaults : [];
  if (source.length === 0) {
    throw new SafeError("at least one readiness edge is required");
  }

  return source.map((entry, index) => {
    const parts = entry.split("=");
    if (parts.length < 3 || parts.length > 4) {
      throw new SafeError("edge entries must use edge_id=region=public_base[=private_base]");
    }
    const [edgeId, region, publicBase, privateBase = publicBase] = parts.map((part) => part.trim());
    if (!edgeId || !region || !publicBase) {
      throw new SafeError("edge entries require edge id, region, and public base URL");
    }
    return {
      edge_id: edgeId,
      region,
      label: edgeId || `edge-${index + 1}`,
      public_base: trimBaseUrl(publicBase),
      private_base: trimBaseUrl(privateBase),
    };
  });
}

function parseExpectedEdges(value) {
  return parseList(value).map((entry) => {
    const parts = entry.split("=");
    if (parts.length !== 3) return "";
    return `${parts[0]}=${parts[1]}=${parts[2]}`;
  }).filter(Boolean);
}

function numberFromEnv(name, fallback) {
  const value = envString(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new SafeError(`${name} must be a non-negative number`);
  }
  return parsed;
}

function buildThresholds(config) {
  const thresholds = {};
  const configured = config.thresholds && typeof config.thresholds === "object" ? config.thresholds : {};
  for (const [key, defaults] of Object.entries(defaultThresholds)) {
    const configThreshold = configured[key] && typeof configured[key] === "object" ? configured[key] : {};
    const [warnEnv, failEnv] = thresholdEnv[key];
    const warn = numberFromEnv(warnEnv, Number(configThreshold.warn ?? defaults.warn));
    const fail = numberFromEnv(failEnv, Number(configThreshold.fail ?? defaults.fail));
    if (fail < warn) {
      throw new SafeError(`${failEnv} must be greater than or equal to ${warnEnv}`);
    }
    thresholds[key] = { warn, fail };
  }
  return thresholds;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: options.env || process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!options.inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", (error) => {
      reject(new SafeError(`${command} failed to start`, { command, cause: error.message }));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new SafeError(`${options.label || command} exited with status ${code}`, { command, code }));
      }
    });
  });
}

async function requireCommand(command) {
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  try {
      if (checker === "command") {
      await runCommand("sh", ["-lc", `command -v ${command}`], { label: `check ${command}` });
    } else {
      await runCommand(checker, args, { label: `check ${command}` });
    }
  } catch {
    throw new SafeError(`${command} is required for playback readiness`);
  }
}

async function ensureLocalStack(config) {
  if (config.skipLocalStack || config.target !== "local-two-edge") return;
  await requireCommand("docker");
  await runCommand("docker", ["compose", "up", "-d"], {
    label: "docker compose default stack",
    inherit: true,
  });
  await runCommand("docker", ["compose", "--profile", "two-edge", "up", "-d", "rend-edge-us-east", "rend-edge-london"], {
    label: "docker compose two-edge profile",
    inherit: true,
  });
}

async function waitForHttp(url, label, timeoutMs) {
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    try {
      const response = await curlRequest({
        method: "GET",
        url,
        label,
        timeoutSecs: 10,
      });
      if (response.http_code >= 200 && response.http_code < 300) return;
    } catch {
      // Keep polling until the deadline.
    }
    await sleep(1_000);
  }
  throw new SafeError(`${label} did not become ready before timeout`);
}

function parseTiming(stdout) {
  const timing = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes("=")) continue;
    const [key, value] = line.split("=", 2);
    timing[key] = value;
  }
  return {
    http_code: Number(timing.http_code || 0),
    time_connect_ms: Number(timing.time_connect || 0) * 1000,
    time_starttransfer_ms: Number(timing.time_starttransfer || 0) * 1000,
    time_total_ms: Number(timing.time_total || 0) * 1000,
    size_download: Number(timing.size_download || 0),
    size_upload: Number(timing.size_upload || 0),
  };
}

function parseHeaders(raw) {
  const headers = new Map();
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index <= 0) continue;
      headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
    }
  }
  return headers;
}

async function curlRequest(options) {
  const headersPath = path.join(options.tmpDir || os.tmpdir(), `rend-readiness-${crypto.randomUUID()}.headers`);
  const bodyPath = path.join(options.tmpDir || os.tmpdir(), `rend-readiness-${crypto.randomUUID()}.body`);
  const args = [
    "-sS",
    "--max-time",
    String(options.timeoutSecs || 120),
    "-D",
    headersPath,
    "-o",
    bodyPath,
    "-w",
    curlTimingFormat,
  ];

  if (options.method && options.method !== "GET") args.push("-X", options.method);
  if (options.cookieJarRead) args.push("-b", options.cookieJarRead);
  if (options.cookieJarWrite) args.push("-c", options.cookieJarWrite);
  for (const header of options.headers || []) args.push("-H", header);
  if (options.data !== undefined) args.push("--data", options.data);
  if (options.dataBinaryFile) args.push("--data-binary", `@${options.dataBinaryFile}`);
  args.push(options.url);

  let result;
  try {
    result = await runCommand("curl", args, { label: options.label || "curl request" });
  } catch (error) {
    await rm(headersPath, { force: true }).catch(() => {});
    await rm(bodyPath, { force: true }).catch(() => {});
    throw error;
  }
  const timing = parseTiming(result.stdout);
  const headers = parseHeaders(await readFile(headersPath, "latin1").catch(() => ""));
  const bodyBuffer = await readFile(bodyPath).catch(() => Buffer.alloc(0));
  await rm(headersPath, { force: true }).catch(() => {});
  await rm(bodyPath, { force: true }).catch(() => {});

  return {
    ...timing,
    headers,
    body: bodyBuffer,
    text: bodyBuffer.toString("utf8"),
    json() {
      return JSON.parse(bodyBuffer.toString("utf8"));
    },
  };
}

function authHeaders(config) {
  return [`authorization: Bearer ${config.apiKey}`];
}

function edgeHeaders(config) {
  return [`x-rend-internal-token: ${config.edgeInternalToken}`];
}

async function generateFixture(name, outputPath) {
  const presets = {
    small: { size: "320x180", duration: 4, tone: 660 },
    medium: { size: "640x360", duration: 8, tone: 880 },
  };
  const preset = presets[name];
  if (!preset) throw new SafeError(`unknown readiness fixture '${name}'`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${preset.size}:rate=24:duration=${preset.duration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${preset.tone}:sample_rate=48000:duration=${preset.duration}`,
      "-shortest",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { label: `generate ${name} readiness fixture` }
  );
}

async function probeFixture(fixturePath) {
  const result = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_type,width,height",
      "-show_entries",
      "format=duration,size",
      "-of",
      "json",
      fixturePath,
    ],
    { label: "ffprobe readiness fixture" }
  );
  const data = JSON.parse(result.stdout);
  const video = (data.streams || []).find((stream) => stream.codec_type === "video") || {};
  const format = data.format || {};
  const fileStat = await stat(fixturePath);
  return {
    byte_size: fileStat.size,
    duration_seconds: Number(format.duration || 0),
    width: video.width || null,
    height: video.height || null,
  };
}

async function uploadFixture(config, fixturePath, startedMs) {
  const response = await curlRequest({
    method: "POST",
    url: `${config.apiBase}/v1/videos`,
    headers: [...authHeaders(config), "content-type: video/mp4"],
    dataBinaryFile: fixturePath,
    label: "upload synthetic readiness fixture",
    timeoutSecs: config.curlTimeoutSecs,
    tmpDir: config.tmpDir,
  });
  if (response.http_code !== 201) {
    throw new SafeError(`synthetic fixture upload expected HTTP 201, got ${response.http_code}`);
  }
  const body = response.json();
  if (!body.asset_id || body.source_state !== "uploaded") {
    throw new SafeError("synthetic fixture upload response did not include an uploaded asset");
  }
  if (body.playback_url || JSON.stringify(body).includes("token=")) {
    throw new SafeError("synthetic fixture upload response exposed playback details");
  }
  return {
    assetId: body.asset_id,
    metric: {
      name: "upload_response_ms",
      value_ms: roundMs(response.time_total_ms),
      http_status: response.http_code,
      wall_time_ms: nowMs() - startedMs,
    },
  };
}

async function getAsset(config, assetId) {
  const response = await curlRequest({
    method: "GET",
    url: `${config.apiBase}/v1/assets/${encodeURIComponent(assetId)}`,
    headers: authHeaders(config),
    label: "fetch synthetic asset state",
    timeoutSecs: config.curlTimeoutSecs,
    tmpDir: config.tmpDir,
  });
  if (response.http_code !== 200) {
    throw new SafeError(`asset state expected HTTP 200, got ${response.http_code}`);
  }
  return response.json();
}

async function waitForAssetReadiness(config, assetId, uploadStartedMs) {
  const deadline = nowMs() + config.pollTimeoutMs;
  let openerReadyMs = null;
  let hlsReadyMs = null;
  let lastState = null;
  while (nowMs() < deadline) {
    const asset = await getAsset(config, assetId);
    lastState = asset.playable_state;
    const artifacts = Array.isArray(asset.artifacts) ? asset.artifacts : [];
    if (openerReadyMs === null && artifacts.some((artifact) => artifact.kind === "opener")) {
      openerReadyMs = nowMs() - uploadStartedMs;
    }
    if (asset.playable_state === "failed") {
      throw new SafeError("media processing marked the synthetic readiness asset failed");
    }
    if (asset.playable_state === "hls_ready") {
      hlsReadyMs = nowMs() - uploadStartedMs;
      if (openerReadyMs === null) openerReadyMs = hlsReadyMs;
      return { openerReadyMs, hlsReadyMs };
    }
    await sleep(config.pollIntervalMs);
  }
  throw new SafeError(`timed out waiting for synthetic asset readiness; last state ${lastState || "unknown"}`);
}

async function fetchPlaybackBootstrap(config, assetId, uploadStartedMs, cookieJar) {
  const deadline = nowMs() + config.pollTimeoutMs;
  while (nowMs() < deadline) {
    const response = await curlRequest({
      method: "GET",
      url: `${config.apiBase}/v1/assets/${encodeURIComponent(assetId)}/playback`,
      headers: authHeaders(config),
      cookieJarWrite: cookieJar,
      label: "fetch playback bootstrap",
      timeoutSecs: config.curlTimeoutSecs,
      tmpDir: config.tmpDir,
    });
    if (response.http_code === 200) {
      const cookieText = await readFile(cookieJar, "utf8").catch(() => "");
      if (!cookieText.includes("__rend_playback")) {
        throw new SafeError("playback bootstrap did not set the playback cookie");
      }
      return {
        body: response.json(),
        uploadToBootstrapReadyMs: nowMs() - uploadStartedMs,
        responseMs: response.time_total_ms,
        httpStatus: response.http_code,
      };
    }
    await sleep(config.pollIntervalMs);
  }
  throw new SafeError("timed out waiting for playback bootstrap readiness");
}

function artifactPathFromUrl(urlValue, assetId) {
  const parsed = new URL(urlValue);
  if (parsed.search || parsed.hash) {
    throw new SafeError("playback bootstrap returned a URL with query or fragment data");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "v" || parts[1] !== assetId) {
    throw new SafeError("playback bootstrap returned an unexpected artifact URL shape");
  }
  return parts.slice(2).join("/");
}

function extractBootstrapArtifacts(bootstrap, assetId) {
  const hints = Array.isArray(bootstrap.prefetch_hints) ? bootstrap.prefetch_hints : [];
  const firstSegment = hints.find((hint) => typeof hint.artifact_path === "string" && hint.artifact_path.endsWith(".ts"));
  if (!bootstrap.opener_url || !bootstrap.manifest_url || !firstSegment?.url) {
    throw new SafeError("playback bootstrap did not include opener, manifest, and first segment hints");
  }
  const artifacts = [
    {
      label: "opener",
      artifact_path: artifactPathFromUrl(bootstrap.opener_url, assetId),
      content_type: bootstrap.opener_content_type || "video/mp4",
    },
    {
      label: "manifest",
      artifact_path: artifactPathFromUrl(bootstrap.manifest_url, assetId),
      content_type: bootstrap.manifest_content_type || "application/vnd.apple.mpegurl",
    },
    {
      label: "segment",
      artifact_path: artifactPathFromUrl(firstSegment.url, assetId),
      content_type: firstSegment.content_type || "video/mp2t",
    },
  ];
  if (artifacts[0].artifact_path !== "opener.mp4") {
    throw new SafeError("playback bootstrap opener did not use opener.mp4");
  }
  if (artifacts[1].artifact_path !== "hls/master.m3u8") {
    throw new SafeError("playback bootstrap manifest did not use hls/master.m3u8");
  }
  return artifacts;
}

function playbackUrl(edge, assetId, artifactPath) {
  return `${edge.public_base}/v/${encodeURIComponent(assetId)}/${artifactPath.split("/").map(encodeURIComponent).join("/")}`;
}

async function purgeEdge(config, edge, assetId, artifactPaths = null) {
  const payload = artifactPaths && artifactPaths.length > 0
    ? { asset_id: assetId, artifact_paths: artifactPaths }
    : { asset_id: assetId };
  const response = await curlRequest({
    method: "POST",
    url: `${edge.private_base}/internal/purge`,
    headers: [...edgeHeaders(config), "content-type: application/json"],
    data: JSON.stringify(payload),
    label: `purge ${edge.edge_id}`,
    timeoutSecs: config.curlTimeoutSecs,
    tmpDir: config.tmpDir,
  });
  if (response.http_code !== 200) {
    throw new SafeError(`${edge.edge_id} purge expected HTTP 200, got ${response.http_code}`);
  }
  const body = response.json();
  if ((body.rejected || []).length > 0 || (body.errors || []).length > 0) {
    throw new SafeError(`${edge.edge_id} purge returned rejected or errored entries`);
  }
  return {
    purged: (body.purged || []).length,
    missing: (body.missing || []).length,
    rejected: (body.rejected || []).length,
    errors: (body.errors || []).length,
  };
}

async function warmEdge(config, edge, assetId, artifactPath) {
  const response = await curlRequest({
    method: "POST",
    url: `${edge.private_base}/internal/warm`,
    headers: [...edgeHeaders(config), "content-type: application/json"],
    data: JSON.stringify({ asset_id: assetId, artifact_paths: [artifactPath] }),
    label: `warm ${edge.edge_id}`,
    timeoutSecs: config.curlTimeoutSecs,
    tmpDir: config.tmpDir,
  });
  if (response.http_code !== 200) {
    throw new SafeError(`${edge.edge_id} warm expected HTTP 200, got ${response.http_code}`);
  }
  const body = response.json();
  const summary = body.summary || {};
  if (Number(summary.failed || 0) > 0 || Number(summary.not_found || 0) > 0) {
    throw new SafeError(`${edge.edge_id} warm did not complete for ${artifactPath}`);
  }
  return {
    total: Number(summary.total || 0),
    warmed: Number(summary.warmed || 0),
    already_warm: Number(summary.already_warm || 0),
    failed: Number(summary.failed || 0),
    not_found: Number(summary.not_found || 0),
  };
}

async function measurePlayback(config, edge, assetId, artifact, expectedCache, phase, cookieJar) {
  const response = await curlRequest({
    method: "GET",
    url: playbackUrl(edge, assetId, artifact.artifact_path),
    cookieJarRead: cookieJar,
    label: `${edge.edge_id} ${phase} ${artifact.label}`,
    timeoutSecs: config.curlTimeoutSecs,
    tmpDir: config.tmpDir,
  });
  if (response.http_code !== 200) {
    throw new SafeError(`${edge.edge_id} ${artifact.label} expected HTTP 200, got ${response.http_code}`);
  }
  const cache = response.headers.get("x-rend-cache") || "";
  if (cache !== expectedCache) {
    throw new SafeError(`${edge.edge_id} ${artifact.label} expected X-Rend-Cache ${expectedCache}, got ${cache || "missing"}`);
  }
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0];
  if (contentType !== artifact.content_type) {
    throw new SafeError(`${edge.edge_id} ${artifact.label} expected content type ${artifact.content_type}, got ${contentType || "missing"}`);
  }
  if (response.body.length <= 0) {
    throw new SafeError(`${edge.edge_id} ${artifact.label} returned an empty body`);
  }
  return {
    edge_id: edge.edge_id,
    region: edge.region,
    artifact: artifact.label,
    artifact_path: artifact.artifact_path,
    phase,
    cache_status: cache,
    http_status: response.http_code,
    content_type: contentType,
    ttfb_ms: roundMs(response.time_starttransfer_ms),
    total_ms: roundMs(response.time_total_ms),
    byte_size: response.body.length,
  };
}

async function fetchEdgeMetrics(config, edge) {
  const response = await curlRequest({
    method: "GET",
    url: `${edge.private_base}/metrics`,
    headers: edgeHeaders(config),
    label: `${edge.edge_id} metrics`,
    timeoutSecs: 10,
    tmpDir: config.tmpDir,
  });
  if (response.http_code !== 200) {
    throw new SafeError(`${edge.edge_id} metrics expected HTTP 200, got ${response.http_code}`);
  }
  return parseEdgeMetrics(response.text);
}

function parseLabelSet(raw) {
  const labels = {};
  if (!raw) return labels;
  for (const part of raw.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    labels[part.slice(0, index)] = part.slice(index + 1).replace(/^"|"$/g, "");
  }
  return labels;
}

function parseEdgeMetrics(text) {
  const result = {
    cache: { HIT: 0, MISS: 0, COALESCED: 0, error: 0 },
    telemetry: { queued: 0, sent: 0, spooled: 0, dropped: 0 },
    spool_bytes: 0,
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?[0-9]+(?:\.[0-9]+)?)/);
    if (!match) continue;
    const [, name, rawLabels, rawValue] = match;
    const value = Number(rawValue);
    const labels = parseLabelSet(rawLabels || "");
    if (name === "rend_edge_cache_requests_total" && labels.cache_status in result.cache) {
      result.cache[labels.cache_status] = value;
    }
    if (name === "rend_edge_telemetry_events_total" && labels.state in result.telemetry) {
      result.telemetry[labels.state] = value;
    }
    if (name === "rend_edge_telemetry_spool_bytes") {
      result.spool_bytes = value;
    }
  }
  return result;
}

function metricDelta(before, after) {
  return {
    cache: {
      HIT: Math.max(0, after.cache.HIT - before.cache.HIT),
      MISS: Math.max(0, after.cache.MISS - before.cache.MISS),
      COALESCED: Math.max(0, after.cache.COALESCED - before.cache.COALESCED),
      error: Math.max(0, after.cache.error - before.cache.error),
    },
    telemetry: {
      queued: Math.max(0, after.telemetry.queued - before.telemetry.queued),
      sent: Math.max(0, after.telemetry.sent - before.telemetry.sent),
      spooled: Math.max(0, after.telemetry.spooled - before.telemetry.spooled),
      dropped: Math.max(0, after.telemetry.dropped - before.telemetry.dropped),
    },
    spool_bytes_before: before.spool_bytes,
    spool_bytes_after: after.spool_bytes,
  };
}

async function waitForTelemetryClean(config, edge, beforeMetrics) {
  const deadline = nowMs() + config.pollTimeoutMs;
  let lastMetrics = beforeMetrics;
  while (nowMs() < deadline) {
    lastMetrics = await fetchEdgeMetrics(config, edge);
    const delta = metricDelta(beforeMetrics, lastMetrics);
    if (lastMetrics.spool_bytes === 0 && delta.telemetry.dropped === 0) {
      return { metrics: lastMetrics, delta };
    }
    await sleep(1_000);
  }
  const delta = metricDelta(beforeMetrics, lastMetrics);
  throw new SafeError(`${edge.edge_id} telemetry was not clean after readiness playback`, {
    dropped_delta: delta.telemetry.dropped,
    spool_bytes: lastMetrics.spool_bytes,
  });
}

async function getAnalytics(config, assetId) {
  const response = await curlRequest({
    method: "GET",
    url: `${config.apiBase}/v1/assets/${encodeURIComponent(assetId)}/analytics/playback?window_seconds=3600`,
    headers: authHeaders(config),
    label: "fetch playback analytics",
    timeoutSecs: config.curlTimeoutSecs,
    tmpDir: config.tmpDir,
  });
  if (response.http_code !== 200) {
    throw new SafeError(`playback analytics expected HTTP 200, got ${response.http_code}`);
  }
  return response.json();
}

async function waitForTelemetryVisibility(config, assetId, expectedMinCount, startedMs) {
  const deadline = nowMs() + config.pollTimeoutMs;
  let last = null;
  while (nowMs() < deadline) {
    last = await getAnalytics(config, assetId);
    const cache = last.cache_status_counts || {};
    const requestCount = Number(last.request_count || 0);
    if (requestCount >= expectedMinCount && Number(last.bytes_served || 0) > 0 && Number(cache.MISS || 0) >= 1 && Number(cache.HIT || 0) >= 1) {
      return {
        visibility_ms: nowMs() - startedMs,
        request_count: requestCount,
        bytes_served: Number(last.bytes_served || 0),
        cache_status_counts: {
          HIT: Number(cache.HIT || 0),
          MISS: Number(cache.MISS || 0),
          COALESCED: Number(cache.COALESCED || 0),
          error: Number(cache.error || 0),
        },
      };
    }
    await sleep(config.pollIntervalMs);
  }
  throw new SafeError("playback telemetry did not become visible in analytics", {
    expected_min_request_count: expectedMinCount,
    last_request_count: Number(last?.request_count || 0),
  });
}

async function deleteSyntheticAsset(config, assetId) {
  const response = await curlRequest({
    method: "DELETE",
    url: `${config.apiBase}/v1/assets/${encodeURIComponent(assetId)}`,
    headers: authHeaders(config),
    label: "delete synthetic readiness asset",
    timeoutSecs: config.curlTimeoutSecs,
    tmpDir: config.tmpDir,
  });
  if (response.http_code !== 200) {
    throw new SafeError(`synthetic asset delete expected HTTP 200, got ${response.http_code}`);
  }
  const body = response.json();
  return {
    api_delete: "ok",
    origin_objects_deleted: Number(body.origin_objects_deleted || 0),
    purge_attempted: Boolean(body.purge_attempted),
  };
}

async function cleanupSyntheticAsset(config, assetId, assetRef, cleanupRecords) {
  const cleanupRecord = cleanupRecords.find((record) => record.synthetic_asset_ref === assetRef);
  if (!cleanupRecord || cleanupRecord.status === "cleaned") return;

  const deleted = await deleteSyntheticAsset(config, assetId);
  const edgePurge = [];
  for (const edge of config.edges) {
    edgePurge.push({
      edge_id: edge.edge_id,
      ...(await purgeEdge(config, edge, assetId, null)),
    });
  }
  Object.assign(cleanupRecord, {
    status: "cleaned",
    ...deleted,
    edge_purge: edgePurge,
  });
}

function roundMs(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function fixtureRef(assetId) {
  return crypto.createHash("sha256").update(assetId).digest("hex").slice(0, 12);
}

function evaluateMetric(metric, thresholdKey, thresholds, warnings, failures) {
  const threshold = thresholds[thresholdKey];
  if (!threshold || metric.value_ms == null) return "pass";
  if (metric.value_ms > threshold.fail) {
    metric.status = "fail";
    failures.push({
      type: "performance",
      metric: metric.name,
      threshold: thresholdKey,
      value_ms: metric.value_ms,
      fail_ms: threshold.fail,
      edge_id: metric.edge_id,
      fixture: metric.fixture,
      artifact: metric.artifact,
    });
    return "fail";
  }
  if (metric.value_ms > threshold.warn) {
    metric.status = "warn";
    warnings.push({
      type: "performance",
      metric: metric.name,
      threshold: thresholdKey,
      value_ms: metric.value_ms,
      warn_ms: threshold.warn,
      edge_id: metric.edge_id,
      fixture: metric.fixture,
      artifact: metric.artifact,
    });
    return "warn";
  }
  metric.status = "pass";
  return "pass";
}

function sanitizeString(value, secrets) {
  let out = value
    .replace(/https?:\/\/[^\s"',)]+/gi, "[redacted-url]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/token=[^&\s"']+/gi, "token=[redacted]")
    .replace(/__rend_playback=[^;\s"']+/gi, "__rend_playback=[redacted]");
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted-secret]");
  }
  return out;
}

function sanitizeForArtifact(value, secrets) {
  if (typeof value === "string") return sanitizeString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeForArtifact(item, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = sanitizeForArtifact(item, secrets);
    }
    return out;
  }
  return value;
}

function assertRedactedArtifact(document, secrets) {
  const serialized = JSON.stringify(document);
  const checks = [
    [/https?:\/\//i, "full URL"],
    [/__rend_playback/i, "playback cookie"],
    [/\bauthorization\b/i, "authorization header"],
    [/\bbearer\b/i, "bearer token"],
    [/token=/i, "signed token query"],
  ];
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && serialized.includes(secret)) {
      throw new SafeError("readiness artifact redaction failed for a secret value");
    }
  }
  for (const [pattern, label] of checks) {
    if (pattern.test(serialized)) {
      throw new SafeError(`readiness artifact redaction failed for ${label}`);
    }
  }
}

function aggregateCacheMix(edgeResults) {
  const mix = { HIT: 0, MISS: 0, COALESCED: 0, error: 0 };
  for (const result of edgeResults) {
    if (result.cache_status in mix) mix[result.cache_status] += 1;
  }
  return mix;
}

function bytesPerDeliveredMinute(edgeResults, durationSeconds) {
  const totalBytes = edgeResults.reduce((sum, result) => sum + result.byte_size, 0);
  const sampledViews = edgeResults.filter((result) => result.artifact === "segment").length || 1;
  const deliveredMinutes = Math.max(0.001, (durationSeconds / 60) * sampledViews);
  return {
    sampled_views: sampledViews,
    delivered_bytes: totalBytes,
    fixture_duration_seconds: durationSeconds,
    bytes_per_delivered_minute: Math.round(totalBytes / deliveredMinutes),
  };
}

async function runFixture(config, fixtureName, thresholds, warnings, failures, cleanupRecords) {
  const fixturePath = path.join(config.fixtureDir, `rend-readiness-${fixtureName}-${config.runId}.mp4`);
  await generateFixture(fixtureName, fixturePath);
  const fixtureProbe = await probeFixture(fixturePath);

  const uploadStartedMs = nowMs();
  const upload = await uploadFixture(config, fixturePath, uploadStartedMs);
  const assetId = upload.assetId;
  const assetRef = fixtureRef(assetId);
  cleanupRecords.push({ synthetic_asset_ref: assetRef, status: "pending" });

  try {
    const metrics = [
      {
        fixture: fixtureName,
        name: "upload_response_ms",
        value_ms: upload.metric.value_ms,
        http_status: upload.metric.http_status,
        wall_time_ms: upload.metric.wall_time_ms,
      },
    ];
    evaluateMetric(metrics[0], "upload_response_ms", thresholds, warnings, failures);

    const readiness = await waitForAssetReadiness(config, assetId, uploadStartedMs);
    metrics.push({
      fixture: fixtureName,
      name: "upload_to_opener_playable_ms",
      value_ms: readiness.openerReadyMs,
    });
    evaluateMetric(metrics[metrics.length - 1], "upload_to_opener_playable_ms", thresholds, warnings, failures);
    metrics.push({
      fixture: fixtureName,
      name: "upload_to_hls_ready_ms",
      value_ms: readiness.hlsReadyMs,
    });
    evaluateMetric(metrics[metrics.length - 1], "upload_to_hls_ready_ms", thresholds, warnings, failures);

    const cookieJar = path.join(config.tmpDir, `${fixtureName}-${assetRef}.cookies`);
    const bootstrap = await fetchPlaybackBootstrap(config, assetId, uploadStartedMs, cookieJar);
    metrics.push({
      fixture: fixtureName,
      name: "playback_bootstrap_response_ms",
      value_ms: roundMs(bootstrap.responseMs),
      http_status: bootstrap.httpStatus,
      upload_to_bootstrap_ready_ms: bootstrap.uploadToBootstrapReadyMs,
    });
    evaluateMetric(metrics[metrics.length - 1], "playback_bootstrap_response_ms", thresholds, warnings, failures);

    const artifacts = extractBootstrapArtifacts(bootstrap.body, assetId);
    const edgeSummaries = [];
    const allEdgeResults = [];
    let expectedTelemetryEvents = 0;

    for (const edge of config.edges) {
      const beforeMetrics = await fetchEdgeMetrics(config, edge);
      const edgeResults = [];
      const warmSummaries = [];
      const purgeSummaries = [];
      for (const artifact of artifacts) {
        purgeSummaries.push(await purgeEdge(config, edge, assetId, [artifact.artifact_path]));
        const miss = await measurePlayback(config, edge, assetId, artifact, "MISS", "cold_miss", cookieJar);
        miss.fixture = fixtureName;
        edgeResults.push(miss);
        expectedTelemetryEvents += 1;
        metrics.push({
          fixture: fixtureName,
          edge_id: edge.edge_id,
          region: edge.region,
          artifact: artifact.label,
          name: "edge_ttfb_miss_ms",
          value_ms: miss.ttfb_ms,
          total_ms: miss.total_ms,
          byte_size: miss.byte_size,
          first_byte_before_complete: miss.ttfb_ms < miss.total_ms,
          first_byte_to_complete_ms: roundMs(Math.max(0, miss.total_ms - miss.ttfb_ms)),
          cache_status: miss.cache_status,
        });
        evaluateMetric(metrics[metrics.length - 1], "edge_ttfb_miss_ms", thresholds, warnings, failures);

        const hit = await measurePlayback(config, edge, assetId, artifact, "HIT", "second_view_hit", cookieJar);
        hit.fixture = fixtureName;
        edgeResults.push(hit);
        expectedTelemetryEvents += 1;
        metrics.push({
          fixture: fixtureName,
          edge_id: edge.edge_id,
          region: edge.region,
          artifact: artifact.label,
          name: "edge_ttfb_hit_ms",
          value_ms: hit.ttfb_ms,
          cache_status: hit.cache_status,
        });
        evaluateMetric(metrics[metrics.length - 1], "edge_ttfb_hit_ms", thresholds, warnings, failures);

        purgeSummaries.push(await purgeEdge(config, edge, assetId, [artifact.artifact_path]));
        warmSummaries.push(await warmEdge(config, edge, assetId, artifact.artifact_path));
        const warmed = await measurePlayback(config, edge, assetId, artifact, "HIT", "warmed_hit", cookieJar);
        warmed.fixture = fixtureName;
        edgeResults.push(warmed);
        expectedTelemetryEvents += 1;
        metrics.push({
          fixture: fixtureName,
          edge_id: edge.edge_id,
          region: edge.region,
          artifact: artifact.label,
          name: "edge_ttfb_warmed_hit_ms",
          value_ms: warmed.ttfb_ms,
          cache_status: warmed.cache_status,
        });
        evaluateMetric(metrics[metrics.length - 1], "edge_ttfb_warmed_hit_ms", thresholds, warnings, failures);

        if (artifact.label === "opener") {
          const second = await measurePlayback(config, edge, assetId, artifact, "HIT", "post_warm_second_view_hit", cookieJar);
          second.fixture = fixtureName;
          edgeResults.push(second);
          expectedTelemetryEvents += 1;
        }
      }

      const clean = await waitForTelemetryClean(config, edge, beforeMetrics);
      if (clean.delta.telemetry.dropped > 0 || clean.metrics.spool_bytes !== 0) {
        failures.push({
          type: "correctness",
          edge_id: edge.edge_id,
          message: "telemetry dropped events increased or spool bytes remained nonzero",
        });
      }
      const byteProxy = bytesPerDeliveredMinute(edgeResults, fixtureProbe.duration_seconds);
      edgeSummaries.push({
        edge_id: edge.edge_id,
        region: edge.region,
        timings: {
          opener: summarizeArtifactTimings(edgeResults, "opener"),
          manifest: summarizeArtifactTimings(edgeResults, "manifest"),
          segment: summarizeArtifactTimings(edgeResults, "segment"),
        },
        cache_mix: aggregateCacheMix(edgeResults),
        telemetry: {
          queued_delta: clean.delta.telemetry.queued,
          sent_delta: clean.delta.telemetry.sent,
          spooled_delta: clean.delta.telemetry.spooled,
          dropped_delta: clean.delta.telemetry.dropped,
          spool_bytes_after: clean.metrics.spool_bytes,
        },
        bytes_per_delivered_minute_proxy: byteProxy,
        warm: summarizeWarm(warmSummaries),
        purge: summarizePurge(purgeSummaries),
      });
      allEdgeResults.push(...edgeResults);
    }

    const telemetryStartedMs = nowMs();
    const telemetry = await waitForTelemetryVisibility(config, assetId, expectedTelemetryEvents, telemetryStartedMs);
    const telemetryMetric = {
      fixture: fixtureName,
      name: "telemetry_visibility_ms",
      value_ms: telemetry.visibility_ms,
      expected_min_request_count: expectedTelemetryEvents,
      observed_request_count: telemetry.request_count,
    };
    metrics.push(telemetryMetric);
    evaluateMetric(telemetryMetric, "telemetry_visibility_ms", thresholds, warnings, failures);

    try {
      await cleanupSyntheticAsset(config, assetId, assetRef, cleanupRecords);
    } catch (error) {
      const cleanupRecord = cleanupRecords.find((record) => record.synthetic_asset_ref === assetRef);
      Object.assign(cleanupRecord, {
        status: "failed",
        message: error instanceof Error ? error.message : "cleanup failed",
      });
      failures.push({
        type: "correctness",
        fixture: fixtureName,
        message: "synthetic asset cleanup failed",
      });
    }

    return {
      name: fixtureName,
      synthetic: true,
      synthetic_asset_ref: assetRef,
      fixture: fixtureProbe,
      artifact_paths_verified: artifacts.map((artifact) => ({
        label: artifact.label,
        artifact_path: artifact.artifact_path,
        content_type: artifact.content_type,
      })),
      metrics,
      edges: edgeSummaries,
      telemetry_visibility: telemetry,
      cache_mix: aggregateCacheMix(allEdgeResults),
    };
  } catch (error) {
    const cleanupRecord = cleanupRecords.find((record) => record.synthetic_asset_ref === assetRef);
    if (cleanupRecord && cleanupRecord.status !== "cleaned") {
      try {
        await cleanupSyntheticAsset(config, assetId, assetRef, cleanupRecords);
      } catch (cleanupError) {
        Object.assign(cleanupRecord, {
          status: "failed",
          message: cleanupError instanceof Error ? cleanupError.message : "cleanup failed",
        });
        failures.push({
          type: "correctness",
          fixture: fixtureName,
          message: "synthetic asset cleanup failed after readiness error",
        });
      }
    }
    throw error;
  }
}

function summarizeArtifactTimings(results, artifact) {
  const summary = {};
  for (const result of results.filter((entry) => entry.artifact === artifact)) {
    summary[result.phase] = {
      ttfb_ms: result.ttfb_ms,
      total_ms: result.total_ms,
      cache_status: result.cache_status,
      byte_size: result.byte_size,
    };
  }
  return summary;
}

function summarizeWarm(summaries) {
  return summaries.reduce(
    (acc, summary) => ({
      total: acc.total + summary.total,
      warmed: acc.warmed + summary.warmed,
      already_warm: acc.already_warm + summary.already_warm,
      failed: acc.failed + summary.failed,
      not_found: acc.not_found + summary.not_found,
    }),
    { total: 0, warmed: 0, already_warm: 0, failed: 0, not_found: 0 }
  );
}

function summarizePurge(summaries) {
  return summaries.reduce(
    (acc, summary) => ({
      purged: acc.purged + summary.purged,
      missing: acc.missing + summary.missing,
      rejected: acc.rejected + summary.rejected,
      errors: acc.errors + summary.errors,
    }),
    { purged: 0, missing: 0, rejected: 0, errors: 0 }
  );
}

function overallStatus(warnings, failures) {
  if (failures.length > 0) return "fail";
  if (warnings.length > 0) return "warn";
  return "pass";
}

async function writeArtifact(config, document) {
  const secrets = [config.apiKey, config.edgeInternalToken].filter(Boolean);
  const sanitized = sanitizeForArtifact(document, secrets);
  assertRedactedArtifact(sanitized, secrets);
  await mkdir(path.dirname(config.outputPath), { recursive: true });
  await mkdir(path.dirname(config.latestOutputPath), { recursive: true });
  await writeFile(config.outputPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  if (config.latestOutputPath !== config.outputPath) {
    await copyFile(config.outputPath, config.latestOutputPath);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  const configFile = await loadConfig(args);
  const target = args.target || envString("REND_READINESS_TARGET", configFile.target || "local-two-edge");
  if (!["local-two-edge", "configured"].includes(target)) {
    throw new SafeError("--target must be local-two-edge or configured");
  }
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${crypto.randomUUID().slice(0, 8)}`;
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "rend-readiness-"));
  const outputDefault = `.rend/readiness/playback-readiness-${runId}.json`;
  const latestDefault = ".rend/readiness/playback-readiness-latest.json";
  const rawEdgeEntries = [
    ...parseList(envString("REND_READINESS_EDGES", "")),
    ...(args.edges || []),
  ];
  if (rawEdgeEntries.length === 0 && target === "configured" && envString("REND_EXPECTED_EDGES")) {
    rawEdgeEntries.push(...parseExpectedEdges(envString("REND_EXPECTED_EDGES")));
  }
  const fixtureNames = args.fixtures.length > 0
    ? args.fixtures
    : parseList(envString("REND_READINESS_FIXTURES", Array.isArray(configFile.fixtures) ? configFile.fixtures.join(",") : "small"));
  const config = {
    target,
    runId,
    tmpDir,
    skipLocalStack: Boolean(args.skipLocalStack || envString("REND_READINESS_SKIP_LOCAL_STACK", configFile.skipLocalStack ? "1" : "")),
    apiBase: trimBaseUrl(args.apiBase || envString("REND_API_BASE_URL", configFile.apiBase || "http://127.0.0.1:4000")),
    apiKey: args.apiKey || envString("REND_READINESS_API_KEY", envString("REND_API_KEY", envString("REND_DEV_API_KEY", configFile.apiKey || (target === "local-two-edge" ? "dev-api-key" : "")))),
    edgeInternalToken: args.edgeInternalToken || envString("REND_EDGE_INTERNAL_TOKEN", configFile.edgeInternalToken || (target === "local-two-edge" ? "dev-internal-token" : "")),
    edges: parseEdges(rawEdgeEntries.length > 0 ? rawEdgeEntries : Array.isArray(configFile.edges) ? configFile.edges : [], target),
    fixtureNames,
    fixtureDir: absolutePath(envString("REND_READINESS_FIXTURE_DIR", configFile.fixtureDir || ".rend/readiness-fixtures")),
    outputPath: absolutePath(args.output || envString("REND_READINESS_OUTPUT", configFile.output || outputDefault)),
    latestOutputPath: absolutePath(args.latestOutput || envString("REND_READINESS_LATEST_OUTPUT", configFile.latestOutput || latestDefault)),
    pollIntervalMs: numberFromEnv("REND_READINESS_POLL_INTERVAL_MS", Number(configFile.pollIntervalMs || 1_000)),
    pollTimeoutMs: numberFromEnv("REND_READINESS_TIMEOUT_MS", Number(configFile.pollTimeoutMs || 180_000)),
    curlTimeoutSecs: numberFromEnv("REND_READINESS_CURL_TIMEOUT_SECS", Number(configFile.curlTimeoutSecs || 120)),
  };

  if (!config.apiKey) throw new SafeError("REND_READINESS_API_KEY or --api-key is required");
  if (!config.edgeInternalToken) {
    throw new SafeError("REND_EDGE_INTERNAL_TOKEN or --edge-internal-token is required");
  }
  if (config.fixtureNames.length === 0) throw new SafeError("at least one readiness fixture is required");

  const startedAt = isoNow();
  const thresholds = buildThresholds(configFile);
  const warnings = [];
  const failures = [];
  const cleanupRecords = [];
  const fixtureResults = [];

  try {
    await requireCommand("curl");
    await requireCommand("ffmpeg");
    await requireCommand("ffprobe");
    await ensureLocalStack(config);
    await waitForHttp(`${config.apiBase}/readyz`, "api /readyz", config.pollTimeoutMs);
    for (const edge of config.edges) {
      await waitForHttp(`${edge.private_base}/readyz`, `${edge.edge_id} /readyz`, config.pollTimeoutMs);
    }

    for (const fixtureName of config.fixtureNames) {
      fixtureResults.push(await runFixture(config, fixtureName, thresholds, warnings, failures, cleanupRecords));
    }
  } catch (error) {
    failures.push({
      type: "correctness",
      message: error instanceof Error ? error.message : "readiness gate failed",
      details: error instanceof SafeError ? error.details : undefined,
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const endedAt = isoNow();
  const status = overallStatus(warnings, failures);
  const document = {
    schema_version: 1,
    gate: "rend-playback-production-readiness",
    run_id: runId,
    status,
    started_at: startedAt,
    ended_at: endedAt,
    target,
    synthetic_only: true,
    edges: config.edges.map((edge) => ({
      edge_id: edge.edge_id,
      region: edge.region,
    })),
    thresholds,
    fixtures: fixtureResults,
    cache_mix: fixtureResults.reduce(
      (acc, fixture) => ({
        HIT: acc.HIT + fixture.cache_mix.HIT,
        MISS: acc.MISS + fixture.cache_mix.MISS,
        COALESCED: acc.COALESCED + fixture.cache_mix.COALESCED,
        error: acc.error + fixture.cache_mix.error,
      }),
      { HIT: 0, MISS: 0, COALESCED: 0, error: 0 }
    ),
    telemetry_health: summarizeTelemetry(fixtureResults),
    cleanup: {
      status: cleanupRecords.every((record) => record.status === "cleaned") ? "cleaned" : "attention_required",
      records: cleanupRecords,
    },
    warnings,
    failures,
    artifact_policy: {
      redacted: true,
      full_urls: false,
      auth_headers: false,
      cookies: false,
      signed_urls: false,
      client_ips: false,
    },
  };

  await writeArtifact(config, document);
  printSummary(config, document);
  return status === "fail" ? 1 : 0;
}

function summarizeTelemetry(fixtureResults) {
  const summary = {
    visibility_ms_max: 0,
    request_count: 0,
    bytes_served: 0,
    edge_queued_delta: 0,
    edge_sent_delta: 0,
    edge_spooled_delta: 0,
    edge_dropped_delta: 0,
    edge_spool_bytes_after: 0,
  };
  for (const fixture of fixtureResults) {
    summary.visibility_ms_max = Math.max(summary.visibility_ms_max, fixture.telemetry_visibility.visibility_ms);
    summary.request_count += fixture.telemetry_visibility.request_count;
    summary.bytes_served += fixture.telemetry_visibility.bytes_served;
    for (const edge of fixture.edges) {
      summary.edge_queued_delta += edge.telemetry.queued_delta;
      summary.edge_sent_delta += edge.telemetry.sent_delta;
      summary.edge_spooled_delta += edge.telemetry.spooled_delta;
      summary.edge_dropped_delta += edge.telemetry.dropped_delta;
      summary.edge_spool_bytes_after += edge.telemetry.spool_bytes_after;
    }
  }
  return summary;
}

function printSummary(config, document) {
  console.log(`Playback readiness ${document.status.toUpperCase()}`);
  console.log(`Artifact: ${config.outputPath}`);
  console.log(`Latest: ${config.latestOutputPath}`);
  console.log(`Edges: ${document.edges.map((edge) => `${edge.edge_id}/${edge.region}`).join(", ")}`);
  console.log(`Cache mix: HIT=${document.cache_mix.HIT} MISS=${document.cache_mix.MISS} COALESCED=${document.cache_mix.COALESCED}`);
  console.log(`Telemetry: requests=${document.telemetry_health.request_count} dropped_delta=${document.telemetry_health.edge_dropped_delta} spool_bytes=${document.telemetry_health.edge_spool_bytes_after}`);
  console.log(`Cleanup: ${document.cleanup.status}`);
  if (document.warnings.length > 0) console.log(`Warnings: ${document.warnings.length}`);
  if (document.failures.length > 0) console.log(`Failures: ${document.failures.length}`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
