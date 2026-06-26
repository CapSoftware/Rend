#!/usr/bin/env node

import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(repoRoot, ".rend", "benchmarks", "providers");
const publicRoot = path.join(repoRoot, "apps", "site", "public", "benchmarks", "providers");

const defaultProviderUrls = {
  rend: "https://www.rend.so/embed/83971e6c-4fb1-4620-9bfd-6fe71b8b672f",
  mux: "https://player.mux.com/A6oZoUWVZjOIVZB6XnBMLagYnXE6xhDhp8Hcyky018hk",
  cloudfront: "https://v.cap.so/mezzanine.mp4",
  rend_edge_static: "http://127.0.0.1:8125/index.html",
  rend_prod_embed: "https://www.rend.so/embed/83971e6c-4fb1-4620-9bfd-6fe71b8b672f",
  tigris_direct_mp4: "http://127.0.0.1:8125/tigris-direct-mp4/index.html",
  tigris_direct_hls: "http://127.0.0.1:8125/tigris-direct-hls/index.html",
};

function providerUrl(providerId) {
  return process.env[`BENCHMARK_${providerId.toUpperCase()}_URL`] || defaultProviderUrls[providerId];
}

function providerHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

const providerCatalog = {
  rend: {
    id: "rend",
    name: "Rend",
    url: providerUrl("rend"),
    playerHost: providerHost(providerUrl("rend")),
  },
  mux: {
    id: "mux",
    name: "Mux",
    url: providerUrl("mux"),
    playerHost: providerHost(providerUrl("mux")),
  },
  cloudfront: {
    id: "cloudfront",
    name: "CloudFront MP4",
    url: providerUrl("cloudfront"),
    playerHost: providerHost(providerUrl("cloudfront")),
  },
  rend_edge_static: {
    id: "rend_edge_static",
    name: "Rend edge static HLS",
    preflightUrl: process.env.BENCHMARK_REND_EDGE_STATIC_BOOTSTRAP_URL || null,
    url: providerUrl("rend_edge_static"),
    playerHost: providerHost(providerUrl("rend_edge_static")),
  },
  rend_prod_embed: {
    id: "rend_prod_embed",
    name: "Rend prod embed",
    url: providerUrl("rend_prod_embed"),
    playerHost: providerHost(providerUrl("rend_prod_embed")),
  },
  tigris_direct_mp4: {
    id: "tigris_direct_mp4",
    name: "Tigris direct MP4",
    url: providerUrl("tigris_direct_mp4"),
    playerHost: providerHost(providerUrl("tigris_direct_mp4")),
  },
  tigris_direct_hls: {
    id: "tigris_direct_hls",
    name: "Tigris direct HLS",
    url: providerUrl("tigris_direct_hls"),
    playerHost: providerHost(providerUrl("tigris_direct_hls")),
  },
};

const metricLabels = {
  timeToPlayerReadyMs: "Navigation to player ready",
  timeToMetadataMs: "Time to metadata",
  timeToLoadedDataMs: "Time to first loaded frame",
  timeToCanplayMs: "Time to canplay",
  timeToFirstFrameMs: "Time to first frame",
  totalDurationMs: "Total test duration",
  stallCount: "Stall count",
  stallDurationMs: "Stall duration",
};

const caveats = [
  "CDN state cannot be fully controlled from this harness.",
  "Provider encoders, packaging, and player implementations differ.",
  "One video does not represent every workload, codec ladder, region, or viewer device.",
  "The harness does not purge or manipulate Mux CDN caches.",
  "The harness does not warm only Rend during direct comparisons.",
  "Selected resolutions and rendition ladders may differ; current Rend media generation emits an ABR ladder using the supported 720p/1080p/2k/4k billing tiers.",
  "Resource timing is summarized only as aggregate counts because detailed URLs can expose provider internals.",
];

const fairnessRules = [
  "The same Playwright-controlled Chromium/Chrome browser, viewport, device profile, host network, and runner are used for every provider in a comparison.",
  "Every sample uses a clean browser context with no stored cookies, storage, or cache state.",
  "Browser cache is disabled per sample by enabling Playwright request routing and sending no-store request headers.",
  "Provider order is randomized inside each round before samples run.",
  "Runs are rate-limited by default and are not load tests.",
  "Raw samples are redacted before disk and public copies are written.",
];

const sensitivePatterns = [
  { name: "authorization header", pattern: /"authorization"\s*:/i },
  { name: "cookie header", pattern: /"cookie"\s*:/i },
  { name: "set-cookie header", pattern: /set-cookie/i },
  { name: "bearer token", pattern: /bearer\s+[a-z0-9._~+/=-]{12,}/i },
  { name: "basic auth token", pattern: /basic\s+[a-z0-9+/=-]{12,}/i },
  { name: "aws signed query", pattern: /[?&](x-amz-|awsaccesskeyid|signature=|x-amz-signature)/i },
  { name: "generic secret key", pattern: /"(api[_-]?key|secret|private[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:/i },
  { name: "url credentials", pattern: /https?:\/\/[^/\s"']+:[^@\s"']+@/i },
];

function parseArgs(argv) {
  const options = {
    samples: Number(process.env.BENCHMARK_PROVIDER_SAMPLES || 5),
    watchMs: Number(process.env.BENCHMARK_WATCH_MS || 30_000),
    delayMs: Number(process.env.BENCHMARK_SAMPLE_DELAY_MS || 3_000),
    startupTimeoutMs: Number(process.env.BENCHMARK_STARTUP_TIMEOUT_MS || 45_000),
    navigationTimeoutMs: Number(process.env.BENCHMARK_NAVIGATION_TIMEOUT_MS || 45_000),
    videoTimeoutMs: Number(process.env.BENCHMARK_VIDEO_TIMEOUT_MS || 20_000),
    providers: (process.env.BENCHMARK_PROVIDERS || "rend,mux")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    region: process.env.BENCHMARK_REGION || "local",
    regionLabel: process.env.BENCHMARK_REGION_LABEL || "Local machine",
    runnerKind: process.env.BENCHMARK_RUNNER_KIND || "local",
    runnerLabel: process.env.BENCHMARK_RUNNER_LABEL || os.hostname(),
    browserChannel: process.env.BENCHMARK_BROWSER_CHANNEL || "chrome",
    allowBundledChromium: process.env.BENCHMARK_ALLOW_BUNDLED_CHROMIUM === "1",
    publicCopy: process.env.BENCHMARK_PUBLIC_COPY !== "0",
    viewport: parseViewport(process.env.BENCHMARK_VIEWPORT || "1280x720"),
    deviceScaleFactor: Number(process.env.BENCHMARK_DEVICE_SCALE_FACTOR || 1),
    userAgent: process.env.BENCHMARK_USER_AGENT || "",
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-public-copy") {
      options.publicCopy = false;
      continue;
    }
    if (arg === "--allow-bundled-chromium") {
      options.allowBundledChromium = true;
      continue;
    }
    if (arg === "--samples") {
      options.samples = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--watch-ms") {
      options.watchMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--delay-ms") {
      options.delayMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--startup-timeout-ms") {
      options.startupTimeoutMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--navigation-timeout-ms") {
      options.navigationTimeoutMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--providers") {
      options.providers = next.split(",").map((id) => id.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--region") {
      options.region = next;
      i += 1;
      continue;
    }
    if (arg === "--region-label") {
      options.regionLabel = next;
      i += 1;
      continue;
    }
    if (arg === "--runner-kind") {
      options.runnerKind = next;
      i += 1;
      continue;
    }
    if (arg === "--runner-label") {
      options.runnerLabel = next;
      i += 1;
      continue;
    }
    if (arg === "--browser-channel") {
      options.browserChannel = next;
      i += 1;
      continue;
    }
    if (arg === "--viewport") {
      options.viewport = parseViewport(next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  validateOptions(options);
  return options;
}

function printHelp() {
  console.log(`Rend provider benchmark harness

Usage:
  bun run benchmark:providers
  bun run benchmark:providers -- --samples 7 --region london --region-label "London probe"
  bun run benchmark:providers -- --samples 1 --watch-ms 5000 --no-public-copy

Environment:
  BENCHMARK_REGION=london                    Label runs from remote/probe runners.
  BENCHMARK_RUNNER_KIND=github-actions       Records runner kind in the artifact.
  BENCHMARK_BROWSER_CHANNEL=chrome           Playwright browser channel. Defaults to Chrome.
  BENCHMARK_ALLOW_BUNDLED_CHROMIUM=1         Fall back to Playwright Chromium if Chrome is unavailable.
  BENCHMARK_PUBLIC_COPY=0                    Skip apps/site/public/benchmarks/providers writes.
`);
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error(`Viewport must look like 1280x720, got ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function validateOptions(options) {
  if (!Number.isFinite(options.samples) || options.samples < 1 || options.samples > 50) {
    throw new Error("--samples must be between 1 and 50");
  }
  if (!Number.isFinite(options.watchMs) || options.watchMs < 1_000 || options.watchMs > 120_000) {
    throw new Error("--watch-ms must be between 1000 and 120000");
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0 || options.delayMs > 60_000) {
    throw new Error("--delay-ms must be between 0 and 60000");
  }
  for (const provider of options.providers) {
    if (!providerCatalog[provider]) {
      throw new Error(`Unknown provider "${provider}". Known providers: ${Object.keys(providerCatalog).join(", ")}`);
    }
  }
  if (options.providers.length < 1) throw new Error("At least one provider is required");
}

function isoRunId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function stats(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) {
    return { count: 0, min: null, median: null, p75: null, p95: null, max: null };
  }
  return {
    count: finite.length,
    min: roundMs(finite[0]),
    median: roundMs(percentile(finite, 0.5)),
    p75: roundMs(percentile(finite, 0.75)),
    p95: roundMs(percentile(finite, 0.95)),
    max: roundMs(finite[finite.length - 1]),
  };
}

function roundMs(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function sanitizeUrl(value) {
  if (!value || typeof value !== "string") return null;
  if (value.startsWith("blob:")) return "blob:redacted";
  if (value.startsWith("data:")) return "data:redacted";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.slice(0, 180);
  }
}

function sanitizeError(error) {
  if (!error) return null;
  return String(error.message || error).replaceAll(process.cwd(), "<cwd>").slice(0, 500);
}

function inferPlaybackMode(metadata, resourceSummary) {
  const src = metadata?.currentSrc || "";
  if (src === "blob:redacted" && resourceSummary?.byExtension?.m3u8) return "hls-via-mse";
  if (src === "blob:redacted" && (resourceSummary?.byExtension?.m4s || resourceSummary?.byExtension?.mpd)) {
    return "dash-or-cmaf-via-mse";
  }
  if (src === "blob:redacted") return "mse-or-blob";
  if (/\.m3u8($|\?)/i.test(src)) return "hls";
  if (/\.(mp4|m4v)($|\?)/i.test(src)) return "progressive-mp4";
  if (resourceSummary?.byExtension?.m3u8) return "hls";
  if (resourceSummary?.byExtension?.m4s || resourceSummary?.byExtension?.mpd) return "dash-or-cmaf";
  if (resourceSummary?.byExtension?.mp4) return "mp4-resource-observed";
  return "unknown";
}

function redactSample(sample) {
  const copy = structuredClone(sample);
  if (copy.video?.currentSrc) copy.video.currentSrc = sanitizeUrl(copy.video.currentSrc);
  if (copy.network?.errors) {
    copy.network.errors = copy.network.errors.map((error) => ({
      ...error,
      url: sanitizeUrl(error.url),
      message: error.message ? String(error.message).slice(0, 300) : undefined,
    }));
  }
  if (copy.navigation?.finalUrl) copy.navigation.finalUrl = sanitizeUrl(copy.navigation.finalUrl);
  return copy;
}

function leakScan(...objects) {
  const text = objects.map((object) => JSON.stringify(object)).join("\n");
  const findings = [];
  for (const { name, pattern } of sensitivePatterns) {
    if (pattern.test(text)) findings.push({ name });
  }
  return {
    status: findings.length === 0 ? "passed" : "failed",
    checkedAt: new Date().toISOString(),
    patternsVersion: 1,
    findings,
  };
}

async function launchBenchmarkBrowser(chromium, options) {
  const launchOptions = {
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  };
  if (process.platform === "linux") launchOptions.args.push("--no-sandbox");

  if (options.browserChannel) {
    try {
      return await chromium.launch({ ...launchOptions, channel: options.browserChannel });
    } catch (error) {
      if (!options.allowBundledChromium) {
        throw new Error(
          `Failed to launch Playwright browser channel "${options.browserChannel}". Set BENCHMARK_BROWSER_CHANNEL to an installed channel or BENCHMARK_ALLOW_BUNDLED_CHROMIUM=1. ${error.message}`,
        );
      }
      console.warn(`[benchmark] Chrome channel unavailable, falling back to bundled Chromium: ${error.message}`);
    }
  }

  return chromium.launch(launchOptions);
}

async function createContext(browser, options) {
  const contextOptions = {
    viewport: options.viewport,
    deviceScaleFactor: options.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
    javaScriptEnabled: true,
    colorScheme: "light",
    locale: "en-US",
    extraHTTPHeaders: {
      "cache-control": "no-cache, no-store, max-age=0",
      pragma: "no-cache",
    },
  };
  if (options.userAgent) contextOptions.userAgent = options.userAgent;

  const context = await browser.newContext(contextOptions);
  await context.route("**/*", async (route) => {
    await route.continue();
  });
  return context;
}

async function runProviderSample({ browser, provider, options, roundIndex, providerOrder }) {
  const context = await createContext(browser, options);
  const page = await context.newPage();
  page.setDefaultTimeout(Math.max(options.startupTimeoutMs, options.videoTimeoutMs));

  const networkErrors = [];
  page.on("requestfailed", (request) => {
    networkErrors.push({
      kind: "requestfailed",
      url: sanitizeUrl(request.url()),
      resourceType: request.resourceType(),
      message: request.failure()?.errorText || "unknown request failure",
    });
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      networkErrors.push({
        kind: "response",
        url: sanitizeUrl(response.url()),
        resourceType: response.request().resourceType(),
        status,
      });
    }
  });

  await page.addInitScript(browserProbeSource);

  let sampleStarted = performance.now();
  let responseStatus = null;
  let failure = null;
  let snapshot = null;
  let browserUserAgent = null;

  try {
    if (provider.preflightUrl) {
      const preflight = await page.goto(provider.preflightUrl, {
        waitUntil: "domcontentloaded",
        timeout: options.navigationTimeoutMs,
      });
      if (!preflight?.ok()) {
        throw new Error(`preflight failed with HTTP ${preflight?.status() ?? "unknown"}`);
      }
    }

    sampleStarted = performance.now();
    const response = await page.goto(provider.url, {
      waitUntil: "domcontentloaded",
      timeout: options.navigationTimeoutMs,
    });
    responseStatus = response?.status() ?? null;

    await page.waitForFunction(() => Boolean(window.__rendProviderBenchmark?.videoSeen), null, {
      timeout: options.videoTimeoutMs,
    });

    await page.evaluate(() => window.__rendProviderBenchmark?.startPlayback?.());

    try {
      await page.waitForFunction(
        () => {
          const state = window.__rendProviderBenchmark?.snapshot?.();
          return Boolean(state?.events?.firstFrameMs || state?.events?.playingMs);
        },
        null,
        { timeout: options.startupTimeoutMs },
      );
    } catch (error) {
      failure = `startup timeout: ${error.message}`;
    }

    await page.waitForTimeout(options.watchMs);
    snapshot = await page.evaluate(() => window.__rendProviderBenchmark?.snapshot?.());
    browserUserAgent = await page.evaluate(() => navigator.userAgent);
  } catch (error) {
    failure = sanitizeError(error);
    try {
      snapshot = await page.evaluate(() => window.__rendProviderBenchmark?.snapshot?.());
      browserUserAgent = await page.evaluate(() => navigator.userAgent);
    } catch {
      snapshot = null;
    }
  } finally {
    await context.close().catch(() => {});
  }

  const sampleEnded = performance.now();
  const eventMetrics = snapshot?.events || {};
  const resourceSummary = snapshot?.resources || null;
  const video = {
    durationSeconds: finiteOrNull(snapshot?.video?.duration),
    naturalWidth: finiteOrNull(snapshot?.video?.videoWidth),
    naturalHeight: finiteOrNull(snapshot?.video?.videoHeight),
    renderedWidth: finiteOrNull(snapshot?.video?.renderedWidth),
    renderedHeight: finiteOrNull(snapshot?.video?.renderedHeight),
    readyState: snapshot?.video?.readyState ?? null,
    networkState: snapshot?.video?.networkState ?? null,
    currentSrc: sanitizeUrl(snapshot?.video?.currentSrc),
    playbackMode: inferPlaybackMode({ currentSrc: sanitizeUrl(snapshot?.video?.currentSrc) }, resourceSummary),
  };
  const timeToFirstFrameMs = finiteOrNull(eventMetrics.firstFrameMs ?? eventMetrics.playingMs);
  const timeToPlayerReadyMs = finiteOrNull(
    eventMetrics.firstFrameMs ?? eventMetrics.playingMs ?? eventMetrics.canplayMs ?? eventMetrics.loadedmetadataMs,
  );
  const sample = redactSample({
    id: randomUUID(),
    providerId: provider.id,
    providerName: provider.name,
    region: options.region,
    runnerLabel: options.runnerLabel,
    roundIndex,
    providerOrder,
    startedAt: new Date(Date.now() - (sampleEnded - sampleStarted)).toISOString(),
    finishedAt: new Date().toISOString(),
    navigation: {
      url: provider.url,
      finalUrl: sanitizeUrl(snapshot?.page?.href || provider.url),
      responseStatus,
    },
    metrics: {
      timeToPlayerReadyMs,
      timeToMetadataMs: finiteOrNull(eventMetrics.loadedmetadataMs),
      timeToCanplayMs: finiteOrNull(eventMetrics.canplayMs),
      timeToFirstFrameMs,
      totalDurationMs: roundMs(sampleEnded - sampleStarted),
      stallCount: snapshot?.stalls?.length ?? 0,
      stallDurationMs: roundMs(
        (snapshot?.stalls || []).reduce((sum, stall) => sum + Math.max(0, Number(stall.durationMs) || 0), 0),
      ),
    },
    success: !failure && Number.isFinite(timeToFirstFrameMs),
    failure,
    video,
    player: {
      title: snapshot?.page?.title || null,
      observableElements: snapshot?.player?.observableElements || [],
      attributes: snapshot?.player?.attributes || {},
      rend: snapshot?.player?.rend || {},
    },
    playback: {
      stalls: snapshot?.stalls || [],
      playErrors: snapshot?.playErrors || [],
    },
    browser: {
      userAgent: browserUserAgent,
      viewport: options.viewport,
      deviceScaleFactor: options.deviceScaleFactor,
      cache: "clean context plus Playwright routing per sample",
    },
    network: {
      errors: networkErrors,
      resourceSummary,
    },
  });

  sample.video.playbackMode = inferPlaybackMode(sample.video, resourceSummary);
  return sample;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : null;
}

function buildProviderSummary(samples, providerId) {
  const providerSamples = samples.filter((sample) => sample.providerId === providerId);
  const successful = providerSamples.filter((sample) => sample.success);
  const metricStats = {};
  for (const metric of Object.keys(metricLabels)) {
    metricStats[metric] = stats(providerSamples.map((sample) => sample.metrics?.[metric]));
  }

  const observedDurations = successful.map((sample) => sample.video?.durationSeconds).filter((value) => Number.isFinite(value));
  const observedResolutions = successful
    .map((sample) => {
      const width = sample.video?.naturalWidth;
      const height = sample.video?.naturalHeight;
      return Number.isFinite(width) && Number.isFinite(height) ? `${width}x${height}` : null;
    })
    .filter(Boolean);
  const renderedResolutions = successful
    .map((sample) => {
      const width = sample.video?.renderedWidth;
      const height = sample.video?.renderedHeight;
      return Number.isFinite(width) && Number.isFinite(height) ? `${Math.round(width)}x${Math.round(height)}` : null;
    })
    .filter(Boolean);
  const playbackModes = successful.map((sample) => sample.video?.playbackMode).filter(Boolean);
  const selectedRenditions = successful
    .map((sample) => {
      const width = Number(sample.player?.rend?.selectedWidth);
      const height = Number(sample.player?.rend?.selectedHeight);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return `${width}x${height}`;
      }
      return null;
    })
    .filter(Boolean);

  return {
    sampleCount: providerSamples.length,
    successfulSamples: successful.length,
    failedSamples: providerSamples.length - successful.length,
    startupFailureRate: providerSamples.length
      ? Math.round(((providerSamples.length - successful.length) / providerSamples.length) * 10_000) / 100
      : null,
    metrics: metricStats,
    observed: {
      durationSeconds: stats(observedDurations),
      naturalResolution: mostCommon(observedResolutions),
      renderedResolution: mostCommon(renderedResolutions),
      playbackMode: mostCommon(playbackModes),
      selectedRendition: mostCommon(selectedRenditions) || mostCommon(observedResolutions) || "not observable",
    },
    browserNetworkErrors: providerSamples.reduce((sum, sample) => sum + (sample.network?.errors?.length || 0), 0),
  };
}

function mostCommon(values) {
  if (values.length === 0) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0][0];
}

function buildSourceVerification(providerSummaries) {
  const ids = Object.keys(providerSummaries);
  const observed = {};
  for (const id of ids) {
    observed[id] = {
      durationMedianSeconds: providerSummaries[id].observed.durationSeconds.median,
      naturalResolution: providerSummaries[id].observed.naturalResolution,
      playbackMode: providerSummaries[id].observed.playbackMode,
    };
  }

  let metadataLooksConsistent = false;
  if (ids.length >= 2) {
    const durations = ids.map((id) => providerSummaries[id].observed.durationSeconds.median).filter(Number.isFinite);
    const resolutions = ids.map((id) => providerSummaries[id].observed.naturalResolution).filter(Boolean);
    metadataLooksConsistent =
      durations.length === ids.length &&
      Math.max(...durations) - Math.min(...durations) <= 0.75 &&
      resolutions.length === ids.length &&
      new Set(resolutions).size === 1;
  }

  return {
    status: "not_independently_verified",
    metadataLooksConsistent,
    statement:
      "The harness can observe public player metadata such as duration and resolution, but neither public player exposes an original source checksum or object identity. Source-file identity was not independently verified.",
    observed,
  };
}

function buildArtifact({ runId, startedAt, finishedAt, samples, providerOrderByRound, options, browserVersion }) {
  const providers = options.providers.map((id) => providerCatalog[id]);
  const providerSummaries = Object.fromEntries(providers.map((provider) => [provider.id, buildProviderSummary(samples, provider.id)]));
  const minSamplesPerProvider = Math.min(...Object.values(providerSummaries).map((summary) => summary.sampleCount));
  const minSuccessfulSamplesPerProvider = Math.min(
    ...Object.values(providerSummaries).map((summary) => summary.successfulSamples),
  );
  const sufficientForPublication = minSamplesPerProvider >= 5 && minSuccessfulSamplesPerProvider >= 5;
  const sourceVerification = buildSourceVerification(providerSummaries);

  return {
    schemaVersion: "rend.provider-benchmark.v1",
    generatedAt: new Date().toISOString(),
    run: {
      id: runId,
      status: "completed",
      startedAt,
      finishedAt,
      region: options.region,
      regionLabel: options.regionLabel,
      runnerKind: options.runnerKind,
      runnerLabel: options.runnerLabel,
      sampleCountTarget: options.samples,
      watchWindowMs: options.watchMs,
      delayMs: options.delayMs,
      providerOrderRandomized: true,
      providerOrderByRound,
    },
    source: {
      urls: Object.fromEntries(providers.map((provider) => [provider.id, provider.url])),
      verification: sourceVerification,
    },
    fairness: {
      rules: fairnessRules,
      caveats,
    },
    environment: {
      browser: {
        automation: "Playwright Chromium",
        requestedChannel: options.browserChannel || null,
        version: browserVersion,
      },
      device: {
        viewport: options.viewport,
        deviceScaleFactor: options.deviceScaleFactor,
        isMobile: false,
        hasTouch: false,
      },
      network: {
        environment: "host network",
        throttling: "none",
        cache: "disabled per sample with clean browser contexts",
      },
      runner: {
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        node: process.version,
        bun: process.versions.bun || null,
      },
    },
    providers,
    regions: [{ id: options.region, label: options.regionLabel, runnerKind: options.runnerKind }],
    summary: {
      result: sufficientForPublication
        ? "benchmark_samples_available_no_universal_claim"
        : "insufficient_samples_for_public_claim",
      minSamplesPerProvider,
      minSuccessfulSamplesPerProvider,
      sufficientForPublication,
      requiredSamplesPerProvider: 5,
      metricLabels,
      providers: providerSummaries,
    },
    artifacts: {
      machineReadableUrl: "/benchmarks/providers/latest.json",
      rawSamplesUrl: "/benchmarks/providers/latest.samples.json",
    },
  };
}

async function writeArtifacts({ runId, artifact, samples, redaction, options }) {
  const runDir = path.join(artifactRoot, runId);
  const sampleDocument = {
    schemaVersion: "rend.provider-benchmark-samples.v1",
    runId,
    generatedAt: artifact.generatedAt,
    redaction,
    samples,
  };
  const summaryDocument = { ...artifact, redaction };

  await mkdir(runDir, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });

  const files = [
    [path.join(runDir, "summary.json"), summaryDocument],
    [path.join(runDir, "samples.redacted.json"), sampleDocument],
    [path.join(runDir, "redaction-report.json"), redaction],
    [path.join(artifactRoot, "latest.json"), summaryDocument],
    [path.join(artifactRoot, "latest.samples.json"), sampleDocument],
  ];

  if (options.publicCopy) {
    await mkdir(publicRoot, { recursive: true });
    files.push(
      [path.join(publicRoot, "latest.json"), summaryDocument],
      [path.join(publicRoot, "latest.samples.json"), sampleDocument],
    );
  }

  for (const [file, object] of files) {
    await writeFile(file, `${JSON.stringify(object, null, 2)}\n`);
  }

  return {
    runDir,
    latestPath: path.join(artifactRoot, "latest.json"),
    publicLatestPath: options.publicCopy ? path.join(publicRoot, "latest.json") : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = isoRunId();
  const startedAt = new Date().toISOString();
  const providers = options.providers.map((id) => providerCatalog[id]);
  const providerOrderByRound = [];
  const samples = [];

  console.log(
    `[benchmark] run=${runId} providers=${providers.map((provider) => provider.id).join(",")} samples=${options.samples} watchMs=${options.watchMs} region=${options.region}`,
  );

  if (options.dryRun) {
    console.log("[benchmark] dry run only; no browser launched");
    return;
  }

  const { chromium } = await import("playwright");
  const browser = await launchBenchmarkBrowser(chromium, options);
  const browserVersion = browser.version();

  try {
    for (let round = 0; round < options.samples; round += 1) {
      const order = shuffle(providers);
      providerOrderByRound.push(order.map((provider) => provider.id));
      for (const provider of order) {
        const sampleNumber = samples.filter((sample) => sample.providerId === provider.id).length + 1;
        console.log(`[benchmark] round=${round + 1}/${options.samples} provider=${provider.id} sample=${sampleNumber}`);
        const sample = await runProviderSample({
          browser,
          provider,
          options,
          roundIndex: round,
          providerOrder: order.map((item) => item.id),
        });
        samples.push(sample);
        const ready = sample.metrics.timeToPlayerReadyMs == null ? "n/a" : `${sample.metrics.timeToPlayerReadyMs}ms`;
        console.log(
          `[benchmark] provider=${provider.id} success=${sample.success} ready=${ready} stalls=${sample.metrics.stallCount}`,
        );
        if (options.delayMs > 0) await sleep(options.delayMs);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const finishedAt = new Date().toISOString();
  const artifact = buildArtifact({
    runId,
    startedAt,
    finishedAt,
    samples,
    providerOrderByRound,
    options,
    browserVersion,
  });
  const redaction = leakScan(artifact, samples);
  if (redaction.status !== "passed") {
    const reportDir = path.join(artifactRoot, runId);
    await mkdir(reportDir, { recursive: true });
    await writeFile(path.join(reportDir, "redaction-report.json"), `${JSON.stringify(redaction, null, 2)}\n`);
    throw new Error(`Redaction scan failed: ${redaction.findings.map((finding) => finding.name).join(", ")}`);
  }

  const paths = await writeArtifacts({ runId, artifact, samples, redaction, options });
  console.log(`[benchmark] wrote ${paths.latestPath}`);
  if (paths.publicLatestPath) console.log(`[benchmark] wrote ${paths.publicLatestPath}`);
}

const browserProbeSource = String.raw`
(() => {
  const HAVE_FUTURE_DATA = 3;
  const state = {
    installedAtMs: performance.now(),
    videoSeen: false,
    events: {},
    stalls: [],
    activeStall: null,
    lastCurrentTime: null,
    video: {},
    player: {},
    page: {},
    resources: {},
    playErrors: [],
  };

  function now() {
    return performance.now();
  }

  function mark(name) {
    if (state.events[name] == null) state.events[name] = Math.round(now() * 10) / 10;
  }

  function walk(root, out = []) {
    if (!root) return out;
    const children = root.children || [];
    for (const node of children) {
      out.push(node);
      if (node.shadowRoot) walk(node.shadowRoot, out);
      walk(node, out);
    }
    return out;
  }

  function findVideo() {
    const nodes = walk(document.documentElement);
    const videos = nodes.filter((node) => node && node.tagName === "VIDEO");
    if (videos.length === 0) return null;
    return videos
      .map((video) => ({ video, rect: video.getBoundingClientRect() }))
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0].video;
  }

  function endStall(reason) {
    if (!state.activeStall) return;
    const endedAtMs = now();
    state.stalls.push({
      reason: state.activeStall.reason,
      startMs: Math.round(state.activeStall.startMs * 10) / 10,
      endMs: Math.round(endedAtMs * 10) / 10,
      durationMs: Math.round((endedAtMs - state.activeStall.startMs) * 10) / 10,
      endedBy: reason,
    });
    state.activeStall = null;
  }

  function startStall(reason, video) {
    if (state.events.playingMs == null && state.events.firstFrameMs == null) return;
    if (state.activeStall) return;
    if (reason === "stalled" && video && video.readyState >= HAVE_FUTURE_DATA) return;
    state.activeStall = { reason, startMs: now() };
  }

  function summarizeResources() {
    const entries = performance.getEntriesByType("resource") || [];
    const byInitiatorType = {};
    const byOrigin = {};
    const byExtension = {};
    for (const entry of entries) {
      byInitiatorType[entry.initiatorType || "unknown"] = (byInitiatorType[entry.initiatorType || "unknown"] || 0) + 1;
      try {
        const url = new URL(entry.name);
        byOrigin[url.origin] = (byOrigin[url.origin] || 0) + 1;
        const extMatch = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url.pathname);
        const ext = extMatch ? extMatch[1].toLowerCase() : "none";
        byExtension[ext] = (byExtension[ext] || 0) + 1;
      } catch {
        byOrigin.unknown = (byOrigin.unknown || 0) + 1;
      }
    }
    return { count: entries.length, byInitiatorType, byOrigin, byExtension };
  }

  function observablePlayerElements() {
    const elements = walk(document.documentElement)
      .filter((node) => {
        const tag = node.tagName ? node.tagName.toLowerCase() : "";
        return tag.includes("mux") || tag.includes("rend") || tag === "video";
      })
      .slice(0, 12);
    return elements.map((node) => node.tagName.toLowerCase());
  }

  function playerAttributes() {
    const nodes = walk(document.documentElement);
    const candidate = nodes.find((node) => {
      const tag = node.tagName ? node.tagName.toLowerCase() : "";
      return tag.includes("mux") || tag.includes("rend");
    });
    if (!candidate) return {};
    const attrs = {};
    for (const attr of Array.from(candidate.attributes || [])) {
      if (/token|secret|key|signature|cookie|authorization/i.test(attr.name)) continue;
      if (/token|secret|key|signature|cookie|authorization/i.test(attr.value)) continue;
      attrs[attr.name] = String(attr.value).slice(0, 120);
    }
    return attrs;
  }

  function rendPlayerAttributes() {
    const nodes = walk(document.documentElement);
    const candidate = nodes.find((node) => node.getAttribute && node.getAttribute("data-rend-player-state") != null);
    if (!candidate) return {};
    const numericAttribute = (name) => {
      const raw = candidate.getAttribute(name);
      if (raw == null || raw === "") return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    return {
      state: candidate.getAttribute("data-rend-player-state") || null,
      selectedMode: candidate.getAttribute("data-rend-player-selected") || null,
      artifact: candidate.getAttribute("data-rend-player-artifact") || null,
      selectedWidth: numericAttribute("data-rend-selected-width"),
      selectedHeight: numericAttribute("data-rend-selected-height"),
      selectedBitrate: numericAttribute("data-rend-selected-bitrate"),
      selectedLevel: numericAttribute("data-rend-selected-level"),
      bootstrapMs: numericAttribute("data-rend-bootstrap-ms"),
      metadataMs: numericAttribute("data-rend-metadata-ms"),
      canplayMs: numericAttribute("data-rend-canplay-ms"),
      firstFrameMs: numericAttribute("data-rend-first-frame-ms"),
    };
  }

  function captureVideo(video) {
    if (!video) return;
    const rect = video.getBoundingClientRect();
    const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    if (
      state.activeStall &&
      state.lastCurrentTime != null &&
      currentTime > state.lastCurrentTime + 0.05
    ) {
      endStall("currenttime");
    }
    state.lastCurrentTime = currentTime;
    state.video = {
      duration: Number.isFinite(video.duration) ? video.duration : null,
      videoWidth: video.videoWidth || null,
      videoHeight: video.videoHeight || null,
      renderedWidth: rect.width || null,
      renderedHeight: rect.height || null,
      currentTime,
      currentSrc: video.currentSrc || video.src || null,
      readyState: video.readyState,
      networkState: video.networkState,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
    };
  }

  function attach(video) {
    if (!video || video.__rendProviderBenchmarkAttached) return;
    video.__rendProviderBenchmarkAttached = true;
    state.videoSeen = true;
    captureVideo(video);

    if (video.readyState >= 1) mark("loadedmetadataMs");
    if (video.readyState >= 3) mark("canplayMs");

    video.addEventListener("loadedmetadata", () => {
      mark("loadedmetadataMs");
      captureVideo(video);
    });
    video.addEventListener("loadeddata", () => {
      mark("loadeddataMs");
      captureVideo(video);
    });
    video.addEventListener("canplay", () => {
      mark("canplayMs");
      captureVideo(video);
    });
    video.addEventListener("playing", () => {
      mark("playingMs");
      if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) mark("firstFrameMs");
      endStall("playing");
      captureVideo(video);
    });
    video.addEventListener("waiting", () => startStall("waiting", video));
    video.addEventListener("stalled", () => startStall("stalled", video));
    video.addEventListener("canplaythrough", () => endStall("canplaythrough"));
    video.addEventListener("timeupdate", () => {
      if (video.readyState >= 3) endStall("timeupdate");
      captureVideo(video);
    });
    video.addEventListener("resize", () => captureVideo(video));
    video.addEventListener("error", () => {
      state.playErrors.push(video.error ? String(video.error.code) + ":" + (video.error.message || "media error") : "media error");
    });

    if ("requestVideoFrameCallback" in video) {
      const requestFrame = () => {
        video.requestVideoFrameCallback(() => {
          mark("firstFrameMs");
          captureVideo(video);
        });
      };
      requestFrame();
    }
  }

  const poll = window.setInterval(() => {
    const video = findVideo();
    if (video) attach(video);
    captureVideo(video);
    state.player = {
      observableElements: observablePlayerElements(),
      attributes: playerAttributes(),
      rend: rendPlayerAttributes(),
    };
    state.page = {
      href: location.href,
      title: document.title,
    };
    state.resources = summarizeResources();
  }, 50);

  window.__rendProviderBenchmark = {
    get videoSeen() {
      return state.videoSeen;
    },
    async startPlayback() {
      const video = findVideo();
      if (!video) return { ok: false, error: "no video element found" };
      attach(video);
      video.muted = true;
      video.playsInline = true;
      try {
        await video.play();
        return { ok: true };
      } catch (error) {
        state.playErrors.push(String(error && error.message ? error.message : error).slice(0, 200));
        return { ok: false, error: String(error && error.message ? error.message : error).slice(0, 200) };
      }
    },
    snapshot() {
      const video = findVideo();
      if (video) attach(video);
      captureVideo(video);
      state.resources = summarizeResources();
      state.page = { href: location.href, title: document.title };
      state.player = {
        observableElements: observablePlayerElements(),
        attributes: playerAttributes(),
        rend: rendPlayerAttributes(),
      };
      if (state.activeStall) {
        const activeDuration = now() - state.activeStall.startMs;
        state.activeStall.durationMs = Math.round(activeDuration * 10) / 10;
      }
      return {
        installedAtMs: state.installedAtMs,
        videoSeen: state.videoSeen,
        events: state.events,
        stalls: state.activeStall ? [...state.stalls, {
          reason: state.activeStall.reason,
          startMs: Math.round(state.activeStall.startMs * 10) / 10,
          endMs: null,
          durationMs: state.activeStall.durationMs || 0,
          endedBy: null,
        }] : state.stalls,
        video: state.video,
        player: state.player,
        page: state.page,
        resources: state.resources,
        playErrors: state.playErrors,
      };
    },
    stop() {
      clearInterval(poll);
    },
  };
})();
`;

main().catch((error) => {
  console.error(`[benchmark] ${error.stack || error.message}`);
  process.exitCode = 1;
});
