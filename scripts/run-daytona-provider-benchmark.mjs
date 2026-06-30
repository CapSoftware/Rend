#!/usr/bin/env node

import { Daytona } from "@daytona/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const targetCandidates = (process.env.DAYTONA_TARGET_CANDIDATES || "us-west,us-west-2,us")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const samples = Number(process.env.DAYTONA_BENCHMARK_SAMPLES || 5);
const watchMs = Number(process.env.DAYTONA_BENCHMARK_WATCH_MS || 30_000);
const delayMs = Number(process.env.DAYTONA_BENCHMARK_DELAY_MS || 3_000);
const startupTimeoutMs = Number(process.env.DAYTONA_BENCHMARK_STARTUP_TIMEOUT_MS || 45_000);
const publicCopy = process.env.DAYTONA_BENCHMARK_PUBLIC_COPY !== "0";
const defaultRendBenchmarkUrl =
  "https://www.rend.so/embed/c12881f9-8b01-4675-b66c-c4f25de3b702";
const localOutDir = path.join(repoRoot, ".rend", "benchmarks", "providers", `daytona-${runId}`);
const publicOutDir = path.join(repoRoot, "apps", "site", "public", "benchmarks", "providers");
const redactionSecrets = new Set();

function benchmarkRegionForTarget(target) {
  const normalized = String(target || "").toLowerCase();
  if (normalized.startsWith("eu")) return "daytona-eu";
  if (normalized.startsWith("us")) return "daytona-us";
  return `daytona-${normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown"}`;
}

const rendEdgeStaticPageScript = `
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const assetId = process.env.REND_EDGE_STATIC_ASSET_ID;
const outputDir = process.env.REND_EDGE_STATIC_DIR;
const bootstrapUrl =
  process.env.REND_EDGE_STATIC_BOOTSTRAP_URL ||
  (assetId ? "https://www.rend.so/api/player/" + encodeURIComponent(assetId) : "");

if (!assetId) throw new Error("REND_EDGE_STATIC_ASSET_ID is required");
if (!outputDir) throw new Error("REND_EDGE_STATIC_DIR is required");
if (!bootstrapUrl) throw new Error("Rend static edge bootstrap URL is required");

const response = await fetch(bootstrapUrl, {
  headers: {
    accept: "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
  },
});

if (!response.ok) {
  throw new Error("Rend bootstrap failed with HTTP " + response.status);
}

const data = await response.json();
if (data?.status !== "ready") {
  throw new Error("Rend bootstrap returned non-ready status " + (data?.status || "unknown"));
}

const manifestUrl = data.manifest_url || data.playback_url;
if (!manifestUrl || !String(manifestUrl).includes("/hls/master.m3u8")) {
  throw new Error("Rend bootstrap did not return an HLS master manifest URL");
}

const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rend edge static HLS benchmark</title>
    <style>
      html, body { background: #000; height: 100%; margin: 0; }
      #player, video { height: 100%; width: 100%; }
      video { background: #000; display: block; object-fit: contain; }
    </style>
  </head>
  <body>
    <div
      id="player"
      data-rend-player-state="loading"
      data-rend-player-selected=""
      data-rend-player-artifact="hls/master.m3u8"
      data-rend-bootstrap-ms="0"
      data-rend-metadata-ms=""
      data-rend-canplay-ms=""
      data-rend-first-frame-ms=""
      data-rend-selected-bitrate=""
      data-rend-selected-height=""
      data-rend-selected-level=""
      data-rend-selected-width=""
      data-rend-asset-id="\${assetId}"
    >
      <video id="video" autoplay muted playsinline controls preload="auto"></video>
    </div>
    <script src="./vendor/hls.min.js"></script>
    <script>
      const manifestUrl = \${JSON.stringify(manifestUrl)};
      const manifestOrigin = new URL(manifestUrl).origin;
      const manifestToken = new URL(manifestUrl).searchParams.get("token");
      const assetPathPrefix = "/v/\${assetId}/";
      const player = document.getElementById("player");
      const video = document.getElementById("video");
      const startedAt = performance.now();

      function withPlaybackToken(rawUrl) {
        const next = new URL(rawUrl, manifestUrl);
        if (
          manifestToken &&
          next.origin === manifestOrigin &&
          next.pathname.startsWith(assetPathPrefix) &&
          !next.searchParams.has("token")
        ) {
          next.searchParams.set("token", manifestToken);
        }
        return next.toString();
      }

      function elapsed() {
        return Math.max(0, Math.round(performance.now() - startedAt));
      }

      function setData(name, value) {
        player.setAttribute(name, value == null ? "" : String(value));
      }

      function setState(state) {
        setData("data-rend-player-state", state);
      }

      function setTiming(name) {
        if (!player.getAttribute(name)) setData(name, elapsed());
      }

      function setSelected(stats = {}) {
        setData("data-rend-selected-width", stats.width || video.videoWidth || "");
        setData("data-rend-selected-height", stats.height || video.videoHeight || "");
        setData("data-rend-selected-bitrate", stats.bitrate || "");
        setData("data-rend-selected-level", stats.level ?? "");
      }

      function play() {
        video.play().catch(() => undefined);
      }

      video.addEventListener("loadedmetadata", () => {
        setTiming("data-rend-metadata-ms");
        setState("metadata");
        setSelected();
      });
      video.addEventListener("canplay", () => {
        setTiming("data-rend-canplay-ms");
        setState("canplay");
        setSelected();
        play();
      });
      video.addEventListener("playing", () => {
        setTiming("data-rend-first-frame-ms");
        setState("playing");
        setSelected();
      });
      video.addEventListener("resize", () => setSelected());
      video.addEventListener("error", () => setState("playback_failure"));

      if (video.canPlayType("application/vnd.apple.mpegurl") || video.canPlayType("application/x-mpegURL")) {
        setData("data-rend-player-selected", "native_hls");
        video.src = manifestUrl;
        video.load();
        play();
      } else if (window.Hls && window.Hls.isSupported()) {
        setData("data-rend-player-selected", "hls_js");
        const BaseLoader = window.Hls.DefaultConfig.loader;
        class TokenLoader extends BaseLoader {
          load(context, config, callbacks) {
            context.url = withPlaybackToken(context.url);
            super.load(context, config, callbacks);
          }
        }
        const hls = new window.Hls({
          abrEwmaDefaultEstimate: 1200000,
          capLevelOnFPSDrop: true,
          capLevelToPlayerSize: true,
          loader: TokenLoader,
          maxBufferLength: 12,
          maxMaxBufferLength: 30,
          startFragPrefetch: true,
          startLevel: -1,
          testBandwidth: true,
          xhrSetup: (xhr) => {
            xhr.withCredentials = true;
          },
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          setState("ready");
          play();
        });
        hls.on(window.Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          const levelIndex = data.level;
          const level = hls.levels && hls.levels[levelIndex];
          setSelected({
            bitrate: level && level.bitrate,
            height: level && level.height,
            level: levelIndex,
            width: level && level.width,
          });
        });
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data && data.fatal) setState("playback_failure");
        });
        hls.loadSource(manifestUrl);
        hls.attachMedia(video);
        hls.startLoad();
      } else {
        setState("playback_failure");
      }
    </script>
  </body>
</html>\`;

await mkdir(path.join(outputDir, "vendor"), { recursive: true });
await writeFile(path.join(outputDir, "index.html"), html);
console.log("Rend edge static page ready");
`;

function log(message) {
  console.log(`[daytona-benchmark] ${message}`);
}

function redactText(value, apiKey) {
  let text = String(value || "");
  for (const secret of [apiKey, ...redactionSecrets]) {
    if (secret) text = text.split(secret).join("<redacted-daytona-api-key>");
  }
  return text
    .replace(/DAYTONA_API_KEY\s*=\s*[^\s"',;)]+/gi, "DAYTONA_API_KEY=<redacted>")
    .replace(/DAYTONA_EU_API_KEY\s*=\s*[^\s"',;)]+/gi, "DAYTONA_EU_API_KEY=<redacted>")
    .replace(/\bBearer\s+[a-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>");
}

function addRedactionSecret(value) {
  if (value) redactionSecrets.add(value);
}

function parseEnvFile(text) {
  const parsed = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

async function loadDaytonaEnv() {
  const values = {};
  for (const envPath of [".env.local", ".env.production.local", ".env.production"]) {
    try {
      const parsed = parseEnvFile(await readFile(path.join(repoRoot, envPath), "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (values[key] === undefined) values[key] = value;
      }
    } catch {
      // Missing env files are fine.
    }
  }

  for (const key of ["DAYTONA_API_KEY", "DAYTONA_EU_API_KEY"]) {
    if (process.env[key]) values[key] = process.env[key];
    addRedactionSecret(values[key]);
  }

  if (!values.DAYTONA_API_KEY && !values.DAYTONA_EU_API_KEY) {
    throw new Error("DAYTONA_API_KEY was not found in process env or local env files");
  }

  return values;
}

function daytonaApiKeyForTarget(env, target) {
  if (
    String(target || "")
      .toLowerCase()
      .startsWith("eu") &&
    env.DAYTONA_EU_API_KEY
  ) {
    return env.DAYTONA_EU_API_KEY;
  }
  return env.DAYTONA_API_KEY || env.DAYTONA_EU_API_KEY || "";
}

function rendAssetIdFromUrl(rawUrl) {
  try {
    const pathParts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    if (pathParts[0] !== "embed" || !pathParts[1]) return "";
    return decodeURIComponent(pathParts[1]);
  } catch {
    return "";
  }
}

async function assertRendProductionTigrisPreflight() {
  if (process.env.DAYTONA_BENCHMARK_SKIP_REND_PREFLIGHT === "1") return;

  const rendUrl = process.env.DAYTONA_BENCHMARK_REND_URL || defaultRendBenchmarkUrl;
  const assetId = rendAssetIdFromUrl(rendUrl);
  if (!assetId) return;

  const embedOrigin = new URL(rendUrl).origin;
  const bootstrapUrl = new URL(`/api/player/${encodeURIComponent(assetId)}`, embedOrigin);
  const bootstrap = await fetch(bootstrapUrl, {
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
    },
  });
  const playbackCookie = (bootstrap.headers.get("set-cookie") || "").split(";")[0];
  if (!bootstrap.ok) {
    throw new Error(`Rend benchmark preflight failed with HTTP ${bootstrap.status}`);
  }

  const data = await bootstrap.json();
  const manifest = data.manifest_url || data.playback_url;
  if (!manifest) throw new Error("Rend benchmark preflight did not return a manifest URL");

  const manifestUrl = new URL(manifest, bootstrapUrl);
  if (
    process.env.DAYTONA_BENCHMARK_ALLOW_REND_EDGE !== "1" &&
    manifestUrl.hostname.endsWith(".play.rend.so")
  ) {
    throw new Error(`Rend benchmark preflight expected Tigris playback, got edge host ${manifestUrl.hostname}`);
  }

  const manifestResponse = await fetch(manifestUrl, {
    headers: {
      accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
      ...(playbackCookie ? { cookie: playbackCookie } : {}),
      "cache-control": "no-cache",
    },
  });
  if (!manifestResponse.ok) {
    throw new Error(`Rend benchmark manifest preflight failed with HTTP ${manifestResponse.status}`);
  }

  const origin = manifestResponse.headers.get("x-rend-origin");
  if (
    process.env.DAYTONA_BENCHMARK_ALLOW_REND_EDGE !== "1" &&
    origin &&
    origin !== "tigris"
  ) {
    throw new Error(`Rend benchmark preflight expected x-rend-origin=tigris, got ${origin}`);
  }

  log(
    `rend preflight: asset=${assetId} manifestHost=${manifestUrl.host} origin=${origin || "unknown"}`,
  );
}

function safeShellNumber(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 120_000) {
    throw new Error(`${name} is outside the supported range`);
  }
  return Math.floor(value);
}

async function checkedExec(sandbox, command, cwd, env, timeout, apiKey) {
  log(`exec: ${command.replaceAll(/\s+/g, " ").slice(0, 180)}`);
  const result = await sandbox.process.executeCommand(command, cwd, env, timeout);
  const output = redactText(result.result || result.artifacts?.stdout || "", apiKey).trim();
  if (output) {
    const clipped = output.length > 5000 ? `${output.slice(-5000)}\n[output clipped]` : output;
    console.log(clipped);
  }
  if (result.exitCode && result.exitCode !== 0) {
    throw new Error(`remote command exited ${result.exitCode}: ${command}\n${output}`);
  }
  return result;
}

async function createSandbox(daytonaEnv) {
  const errors = [];
  for (const target of targetCandidates) {
    const apiKey = daytonaApiKeyForTarget(daytonaEnv, target);
    if (!apiKey) {
      errors.push({ target, message: "missing Daytona API key for target" });
      continue;
    }
    try {
      log(`creating sandbox target=${target}`);
      const daytona = new Daytona({ apiKey, target });
      const sandbox = await daytona.create(
        {
          image: "mcr.microsoft.com/playwright:v1.61.0-noble",
          resources: { cpu: 2, memory: 4, disk: 8 },
          ephemeral: true,
          autoStopInterval: 15,
          networkBlockAll: false,
          labels: {
            app: "rend",
            purpose: "provider-benchmark",
            requestedRegion: "oregon-us-west",
            runId,
          },
        },
        { timeout: 420 },
      );
      log(`created sandbox id=${sandbox.id} actualTarget=${sandbox.target}`);
      return { daytona, sandbox, requestedTarget: target, apiKey };
    } catch (error) {
      const message = redactText(error?.message || error, apiKey);
      errors.push({ target, message });
      log(`target ${target} failed: ${message.slice(0, 400)}`);
    }
  }
  throw new Error(`Could not create Daytona sandbox in any target: ${JSON.stringify(errors, null, 2)}`);
}

async function main() {
  const daytonaEnv = await loadDaytonaEnv();
  await assertRendProductionTigrisPreflight();
  const benchmarkScript = await readFile(path.join(repoRoot, "scripts", "benchmark-providers.mjs"));
  const hlsMinScript = await readFile(
    path.join(repoRoot, "node_modules", ".bun", "hls.js@1.6.16", "node_modules", "hls.js", "dist", "hls.min.js"),
  );
  let sandbox;
  let daytona;
  let requestedTarget;
  let apiKey = "";
  try {
    const created = await createSandbox(daytonaEnv);
    sandbox = created.sandbox;
    daytona = created.daytona;
    requestedTarget = created.requestedTarget;
    apiKey = created.apiKey;

    const workDir = (await sandbox.getWorkDir()) || (await sandbox.getUserHomeDir()) || "/home/daytona";
    const remoteRoot = path.posix.join(workDir, "rend-provider-benchmark");
    const remoteScript = path.posix.join(remoteRoot, "scripts", "benchmark-providers.mjs");
    const remoteStaticRoot = path.posix.join(remoteRoot, "static-rend-edge");
    const remoteStaticPageScript = path.posix.join(remoteRoot, "scripts", "create-rend-edge-static-page.mjs");
    log(`remoteRoot=${remoteRoot}`);

    await checkedExec(sandbox, `mkdir -p ${remoteRoot}/scripts ${remoteStaticRoot}/vendor`, workDir, undefined, 30, apiKey);
    await sandbox.fs.uploadFile(Buffer.from(benchmarkScript), remoteScript);
    await sandbox.fs.uploadFile(Buffer.from(rendEdgeStaticPageScript), remoteStaticPageScript);
    await sandbox.fs.uploadFile(Buffer.from(hlsMinScript), path.posix.join(remoteStaticRoot, "vendor", "hls.min.js"));
    await checkedExec(
      sandbox,
      "node --version && npm --version && npm init -y >/dev/null && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright@1.61.0 --no-audit --no-fund",
      remoteRoot,
      undefined,
      300,
      apiKey,
    );
    await checkedExec(
      sandbox,
      "node -e \"console.log(require.resolve('playwright'))\"",
      remoteRoot,
      undefined,
      30,
      apiKey,
    );

    const env = {
      BENCHMARK_REGION: benchmarkRegionForTarget(sandbox.target || requestedTarget),
      BENCHMARK_REGION_LABEL: `Daytona ${sandbox.target} (${requestedTarget} requested)`,
      BENCHMARK_RUNNER_KIND: "daytona",
      BENCHMARK_RUNNER_LABEL: sandbox.id,
      BENCHMARK_BROWSER_CHANNEL: "",
      BENCHMARK_ALLOW_BUNDLED_CHROMIUM: "1",
      BENCHMARK_PUBLIC_COPY: "0",
    };
    if (process.env.DAYTONA_BENCHMARK_PROVIDERS) {
      env.BENCHMARK_PROVIDERS = process.env.DAYTONA_BENCHMARK_PROVIDERS;
    }
    if (process.env.DAYTONA_BENCHMARK_REND_URL) {
      env.BENCHMARK_REND_URL = process.env.DAYTONA_BENCHMARK_REND_URL;
    }
    if (process.env.DAYTONA_BENCHMARK_MUX_URL) {
      env.BENCHMARK_MUX_URL = process.env.DAYTONA_BENCHMARK_MUX_URL;
    }
    if (process.env.DAYTONA_BENCHMARK_CLOUDFRONT_URL) {
      env.BENCHMARK_CLOUDFRONT_URL = process.env.DAYTONA_BENCHMARK_CLOUDFRONT_URL;
    }
    if (process.env.DAYTONA_BENCHMARK_REND_EDGE_STATIC_URL) {
      env.BENCHMARK_REND_EDGE_STATIC_URL = process.env.DAYTONA_BENCHMARK_REND_EDGE_STATIC_URL;
    }
    const rendEdgeStaticAssetId = process.env.DAYTONA_BENCHMARK_REND_EDGE_STATIC_ASSET_ID || "";
    const rendEdgeStaticBootstrapUrl =
      process.env.DAYTONA_BENCHMARK_REND_EDGE_STATIC_BOOTSTRAP_URL ||
      (rendEdgeStaticAssetId
        ? `https://www.rend.so/api/player/${encodeURIComponent(rendEdgeStaticAssetId)}`
        : "");
    if (rendEdgeStaticAssetId) {
      await checkedExec(
        sandbox,
        "node scripts/create-rend-edge-static-page.mjs",
        remoteRoot,
        {
          REND_EDGE_STATIC_ASSET_ID: rendEdgeStaticAssetId,
          REND_EDGE_STATIC_BOOTSTRAP_URL: rendEdgeStaticBootstrapUrl,
          REND_EDGE_STATIC_DIR: remoteStaticRoot,
        },
        60,
        apiKey,
      );
      await checkedExec(
        sandbox,
        `python3 -m http.server 8125 --bind 127.0.0.1 --directory ${remoteStaticRoot} > ${remoteStaticRoot}/server.log 2>&1 & echo $! > ${remoteStaticRoot}/server.pid`,
        remoteRoot,
        undefined,
        30,
        apiKey,
      );
      await checkedExec(
        sandbox,
        "node -e \"fetch('http://127.0.0.1:8125/index.html').then(r=>{if(!r.ok)process.exit(1); console.log('static server ready')})\"",
        remoteRoot,
        undefined,
        30,
        apiKey,
      );
      env.BENCHMARK_REND_EDGE_STATIC_URL = "http://127.0.0.1:8125/index.html";
      env.BENCHMARK_REND_EDGE_STATIC_BOOTSTRAP_URL = rendEdgeStaticBootstrapUrl;
    }

    const sampleCount = safeShellNumber(samples, "DAYTONA_BENCHMARK_SAMPLES");
    const watchWindow = safeShellNumber(watchMs, "DAYTONA_BENCHMARK_WATCH_MS");
    const delay = safeShellNumber(delayMs, "DAYTONA_BENCHMARK_DELAY_MS");
    const startupTimeout = safeShellNumber(startupTimeoutMs, "DAYTONA_BENCHMARK_STARTUP_TIMEOUT_MS");
    await checkedExec(
      sandbox,
      `node scripts/benchmark-providers.mjs --samples ${sampleCount} --watch-ms ${watchWindow} --delay-ms ${delay} --startup-timeout-ms ${startupTimeout}`,
      remoteRoot,
      env,
      Math.max(900, Math.ceil((sampleCount * 2 * (watchWindow + delay + startupTimeout)) / 1000)),
      apiKey,
    );

    const remoteSummary = path.posix.join(remoteRoot, ".rend", "benchmarks", "providers", "latest.json");
    const remoteSamples = path.posix.join(remoteRoot, ".rend", "benchmarks", "providers", "latest.samples.json");
    const [summaryBytes, sampleBytes] = await Promise.all([
      sandbox.fs.downloadFile(remoteSummary, 120),
      sandbox.fs.downloadFile(remoteSamples, 120),
    ]);

    await mkdir(localOutDir, { recursive: true });
    await writeFile(path.join(localOutDir, "latest.json"), summaryBytes);
    await writeFile(path.join(localOutDir, "latest.samples.json"), sampleBytes);
    if (publicCopy) {
      await mkdir(publicOutDir, { recursive: true });
      await writeFile(path.join(publicOutDir, "latest.json"), summaryBytes);
      await writeFile(path.join(publicOutDir, "latest.samples.json"), sampleBytes);
    }

    const summary = JSON.parse(summaryBytes.toString("utf8"));
    log(
      `downloaded artifacts run=${summary.run.id} region=${summary.run.regionLabel} minSamples=${summary.summary.minSamplesPerProvider} redaction=${summary.redaction?.status}`,
    );
    log(`local artifacts: ${localOutDir}`);
    if (!publicCopy) log("public artifact copy skipped by DAYTONA_BENCHMARK_PUBLIC_COPY=0");
  } finally {
    if (sandbox) {
      try {
        log(`deleting sandbox id=${sandbox.id}`);
        await sandbox.delete(180);
      } catch (error) {
        log(`sandbox delete failed; trying stop: ${String(error?.message || error).slice(0, 300)}`);
        try {
          await sandbox.stop(120, true);
        } catch (stopError) {
          log(`sandbox stop failed: ${String(stopError?.message || stopError).slice(0, 300)}`);
        }
      }
    }
    if (daytona?.[Symbol.asyncDispose]) {
      await daytona[Symbol.asyncDispose]();
    }
  }
}

main().catch((error) => {
  console.error(`[daytona-benchmark] ${redactText(error.stack || error.message)}`);
  process.exitCode = 1;
});
