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
const localOutDir = path.join(repoRoot, ".rend", "benchmarks", "providers", `daytona-${runId}`);
const publicOutDir = path.join(repoRoot, "apps", "site", "public", "benchmarks", "providers");
let redactionApiKey = "";

function log(message) {
  console.log(`[daytona-benchmark] ${message}`);
}

function redactText(value, apiKey) {
  let text = String(value || "");
  if (apiKey) text = text.split(apiKey).join("<redacted-daytona-api-key>");
  return text
    .replace(/DAYTONA_API_KEY\s*=\s*[^\s"',;)]+/gi, "DAYTONA_API_KEY=<redacted>")
    .replace(/\bBearer\s+[a-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>");
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

async function loadDaytonaApiKey() {
  if (process.env.DAYTONA_API_KEY) {
    redactionApiKey = process.env.DAYTONA_API_KEY;
    return process.env.DAYTONA_API_KEY;
  }
  for (const envPath of [".env.local", ".env.production.local", ".env.production"]) {
    try {
      const values = parseEnvFile(await readFile(path.join(repoRoot, envPath), "utf8"));
      if (values.DAYTONA_API_KEY) {
        redactionApiKey = values.DAYTONA_API_KEY;
        return values.DAYTONA_API_KEY;
      }
    } catch {
      // Missing env files are fine.
    }
  }
  throw new Error("DAYTONA_API_KEY was not found in process env or local env files");
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

async function createSandbox(apiKey) {
  const errors = [];
  for (const target of targetCandidates) {
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
      return { daytona, sandbox, requestedTarget: target };
    } catch (error) {
      const message = redactText(error?.message || error, apiKey);
      errors.push({ target, message });
      log(`target ${target} failed: ${message.slice(0, 400)}`);
    }
  }
  throw new Error(`Could not create Daytona sandbox in any target: ${JSON.stringify(errors, null, 2)}`);
}

async function main() {
  const apiKey = await loadDaytonaApiKey();
  const benchmarkScript = await readFile(path.join(repoRoot, "scripts", "benchmark-providers.mjs"));
  let sandbox;
  let daytona;
  let requestedTarget;
  try {
    const created = await createSandbox(apiKey);
    sandbox = created.sandbox;
    daytona = created.daytona;
    requestedTarget = created.requestedTarget;

    const workDir = (await sandbox.getWorkDir()) || (await sandbox.getUserHomeDir()) || "/home/daytona";
    const remoteRoot = path.posix.join(workDir, "rend-provider-benchmark");
    const remoteScript = path.posix.join(remoteRoot, "scripts", "benchmark-providers.mjs");
    log(`remoteRoot=${remoteRoot}`);

    await checkedExec(sandbox, `mkdir -p ${remoteRoot}/scripts`, workDir, undefined, 30, apiKey);
    await sandbox.fs.uploadFile(Buffer.from(benchmarkScript), remoteScript);
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
      BENCHMARK_REGION: "daytona-us",
      BENCHMARK_REGION_LABEL: `Daytona ${sandbox.target} (${requestedTarget} requested)`,
      BENCHMARK_RUNNER_KIND: "daytona",
      BENCHMARK_RUNNER_LABEL: sandbox.id,
      BENCHMARK_BROWSER_CHANNEL: "",
      BENCHMARK_ALLOW_BUNDLED_CHROMIUM: "1",
      BENCHMARK_PUBLIC_COPY: "0",
    };
    if (process.env.DAYTONA_BENCHMARK_REND_URL) {
      env.BENCHMARK_REND_URL = process.env.DAYTONA_BENCHMARK_REND_URL;
    }
    if (process.env.DAYTONA_BENCHMARK_MUX_URL) {
      env.BENCHMARK_MUX_URL = process.env.DAYTONA_BENCHMARK_MUX_URL;
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
    await mkdir(publicOutDir, { recursive: true });
    await writeFile(path.join(localOutDir, "latest.json"), summaryBytes);
    await writeFile(path.join(localOutDir, "latest.samples.json"), sampleBytes);
    await writeFile(path.join(publicOutDir, "latest.json"), summaryBytes);
    await writeFile(path.join(publicOutDir, "latest.samples.json"), sampleBytes);

    const summary = JSON.parse(summaryBytes.toString("utf8"));
    log(
      `downloaded artifacts run=${summary.run.id} region=${summary.run.regionLabel} minSamples=${summary.summary.minSamplesPerProvider} redaction=${summary.redaction?.status}`,
    );
    log(`local artifacts: ${localOutDir}`);
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
  console.error(`[daytona-benchmark] ${redactText(error.stack || error.message, redactionApiKey)}`);
  process.exitCode = 1;
});
