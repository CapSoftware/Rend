#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProfileEnv,
  parseEnvFile,
  profileEnvFiles,
  repoRoot,
  validateEnvironment,
} from "./env-policy.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const launchDir = path.join(rootDir, ".rend", "launch");
const defaultCommandTimeoutMs = 20 * 60 * 1_000;
const commandOutputLimitBytes = 8 * 1024 * 1024;
const validModes = new Set(["local", "sandbox", "production-check"]);
const validStatuses = new Set(["pass", "warn", "fail"]);

const requiredFeatureEnv = [
  ["delivery", "REND_BILLING_FEATURE_DELIVERY", "delivery_seconds"],
  ["storage", "REND_BILLING_FEATURE_STORAGE", "storage_second_months"],
];

const requiredPlanEnv = [
  ["payg", "REND_AUTUMN_PLAN_PAYG_ID", "pay_as_you_go"],
];

const publicDocsFiles = [
  "apps/site/app/docs/docs-content.ts",
  "apps/site/app/docs/page.tsx",
  "apps/site/app/llms.txt/route.ts",
  "apps/site/app/openapi.json/route.ts",
  "docs/openapi/rend-public-api.openapi.json",
];

const publicStaticDirs = ["apps/site/public"];

function usage() {
  return `Usage: bun run launch:gate -- [options]

Runs the Rend V1 public launch gate and writes redacted JSON artifacts under
.rend/launch/.

Options:
  --mode local|sandbox|production-check
      local runs local billing and local mutating smoke. sandbox uses Autumn
      sandbox config for catalog/customer checks. production-check validates
      production config read-only and skips mutating live smokes by default.
      Env: REND_LAUNCH_GATE_MODE.
  --profile local|production
      Env profile used to load env for built-in checks. Defaults to local for
      local/sandbox and production for production-check.
  --env-file FILE
      Env file for the selected profile. Env: REND_LAUNCH_GATE_ENV_FILE.
  --production-env-file FILE
      Production env file to validate in any mode. Env:
      REND_LAUNCH_PRODUCTION_ENV_FILE.
  --autumn-sandbox-env-file FILE
      Autumn sandbox env file for production catalog parity. Defaults to
      .env.local. Env: REND_AUTUMN_SANDBOX_ENV_FILE.
  --autumn-production-env-file FILE
      Autumn live env file for production catalog parity. Defaults to
      .env.production.local. Env: REND_AUTUMN_PRODUCTION_ENV_FILE.
  --allow-live-billing-mutation
      Permit production-check to call Autumn customers.get_or_create. Without
      this, production-check stays read-only for billing.
  --include-mutating-smoke
      Permit production-check to run local mutating smoke commands. Local and
      sandbox modes run them by default.
  --include-production-sdk-e2e
      Permit production-check to run the published npm SDK E2E against Rend
      production. Also requires --allow-production-mutation and
      --acknowledge-real-billing.
  --allow-production-mutation
      Required with --include-production-sdk-e2e before the SDK E2E can mutate
      production.
  --acknowledge-real-billing
      Required with --include-production-sdk-e2e because live Autumn usage can
      create billing artifacts.
  --release-manifest FILE
      Validate a release image manifest. Env: REND_RELEASE_MANIFEST.
  --release-dry-run
      Run release image local dry-run with --allow-dirty. Env:
      REND_LAUNCH_RELEASE_DRY_RUN=1.
  --timeout-ms NUMBER
      Default timeout per command. Env: REND_LAUNCH_GATE_TIMEOUT_MS.
  -h, --help
      Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    mode: process.env.REND_LAUNCH_GATE_MODE || "local",
    profile: process.env.REND_LAUNCH_GATE_PROFILE || "",
    envFile: process.env.REND_LAUNCH_GATE_ENV_FILE || "",
    productionEnvFile: process.env.REND_LAUNCH_PRODUCTION_ENV_FILE || "",
    autumnSandboxEnvFile: process.env.REND_AUTUMN_SANDBOX_ENV_FILE || "",
    autumnProductionEnvFile: process.env.REND_AUTUMN_PRODUCTION_ENV_FILE || "",
    releaseManifest: process.env.REND_RELEASE_MANIFEST || "",
    releaseDryRun: truthy(process.env.REND_LAUNCH_RELEASE_DRY_RUN),
    allowLiveBillingMutation: truthy(process.env.REND_LAUNCH_ALLOW_LIVE_BILLING_MUTATION),
    includeMutatingSmoke: truthy(process.env.REND_LAUNCH_INCLUDE_MUTATING_SMOKE),
    includeProductionSdkE2e: truthy(process.env.REND_LAUNCH_INCLUDE_PRODUCTION_SDK_E2E),
    allowProductionMutation: truthy(process.env.REND_LAUNCH_ALLOW_PRODUCTION_MUTATION),
    acknowledgeRealBilling: truthy(process.env.REND_LAUNCH_ACKNOWLEDGE_REAL_BILLING),
    timeoutMs: positiveInteger(process.env.REND_LAUNCH_GATE_TIMEOUT_MS, defaultCommandTimeoutMs),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--mode") args.mode = next();
    else if (arg.startsWith("--mode=")) args.mode = arg.slice("--mode=".length);
    else if (arg === "--profile") args.profile = next();
    else if (arg.startsWith("--profile=")) args.profile = arg.slice("--profile=".length);
    else if (arg === "--env-file") args.envFile = next();
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice("--env-file=".length);
    else if (arg === "--production-env-file") args.productionEnvFile = next();
    else if (arg.startsWith("--production-env-file=")) {
      args.productionEnvFile = arg.slice("--production-env-file=".length);
    } else if (arg === "--autumn-sandbox-env-file") args.autumnSandboxEnvFile = next();
    else if (arg.startsWith("--autumn-sandbox-env-file=")) {
      args.autumnSandboxEnvFile = arg.slice("--autumn-sandbox-env-file=".length);
    } else if (arg === "--autumn-production-env-file") args.autumnProductionEnvFile = next();
    else if (arg.startsWith("--autumn-production-env-file=")) {
      args.autumnProductionEnvFile = arg.slice("--autumn-production-env-file=".length);
    } else if (arg === "--release-manifest") args.releaseManifest = next();
    else if (arg.startsWith("--release-manifest=")) {
      args.releaseManifest = arg.slice("--release-manifest=".length);
    } else if (arg === "--release-dry-run") args.releaseDryRun = true;
    else if (arg === "--allow-live-billing-mutation") args.allowLiveBillingMutation = true;
    else if (arg === "--include-mutating-smoke") args.includeMutatingSmoke = true;
    else if (arg === "--include-production-sdk-e2e") args.includeProductionSdkE2e = true;
    else if (arg === "--allow-production-mutation") args.allowProductionMutation = true;
    else if (arg === "--acknowledge-real-billing") args.acknowledgeRealBilling = true;
    else if (arg === "--timeout-ms") args.timeoutMs = positiveInteger(next(), defaultCommandTimeoutMs);
    else if (arg.startsWith("--timeout-ms=")) {
      args.timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), defaultCommandTimeoutMs);
    } else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  args.mode = String(args.mode || "local").trim().toLowerCase();
  if (!validModes.has(args.mode)) {
    throw new Error("--mode must be one of: local, sandbox, production-check");
  }
  args.profile = String(args.profile || (args.mode === "production-check" ? "production" : "local"))
    .trim()
    .toLowerCase();
  if (!["local", "production"].includes(args.profile)) {
    throw new Error("--profile must be local or production");
  }
  return args;
}

function truthy(value) {
  return ["1", "true", "yes", "on", "y"].includes(String(value || "").trim().toLowerCase());
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function isoNow() {
  return new Date().toISOString();
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function seconds(ms) {
  return `${(ms / 1_000).toFixed(1)}s`;
}

function safeRelative(file) {
  const relative = path.relative(rootDir, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

function displayPath(file) {
  return safeRelative(file).replaceAll(path.sep, "/");
}

function resolvePath(value) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function statusRank(status) {
  if (status === "fail") return 2;
  if (status === "warn") return 1;
  return 0;
}

function overallStatus(steps) {
  return steps.reduce((current, step) => {
    return statusRank(step.status) > statusRank(current) ? step.status : current;
  }, "pass");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function redactedCommand(command, args, redactor) {
  return redactor.redact([command, ...args.map(String)].map(shellQuote).join(" "));
}

function createRedactor(env) {
  const exactValues = new Set([
    "dev-api-key",
    "dev-secret",
    "dev-internal-token",
    "local-site-internal-token",
    "local-dev-playback-signing-secret",
    "local-better-auth-secret-only-for-rend-development",
    "rend_minio_password",
  ]);
  for (const [key, rawValue] of Object.entries(env || {})) {
    const value = String(rawValue || "").trim();
    if (!value || value.length < 4) continue;
    if (isLowEntropyRedactionValue(value)) continue;
    if (isSecretLikeKey(key) || isSecretLikeValue(value)) {
      exactValues.add(value);
    }
  }
  const exactPatterns = [...exactValues]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length)
    .map((value) => new RegExp(escapeRegExp(value), "g"));

  function redact(input) {
    let value = String(input ?? "");
    for (const pattern of exactPatterns) {
      value = value.replace(pattern, "[redacted]");
    }
    value = redactKeyValues(value);
    value = redactSignedUrlParams(value);
    value = redactInternalUrls(value);
    value = value
      .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted-stripe-key]")
      .replace(/\bwhsec_[A-Za-z0-9_]+/g, "[redacted-stripe-webhook-secret]")
      .replace(/\bam_sk(?:_(?:live|test))?_[A-Za-z0-9_]+/g, "[redacted-autumn-key]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-access-key]")
      .replace(/\bASIA[0-9A-Z]{16}\b/g, "[redacted-aws-session-key]")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
      .replace(/(authorization:\s*Bearer\s+)[^\s"']+/gi, "$1[redacted]")
      .replace(/(\bBearer\s+)(?:rend_[A-Za-z0-9_=-]+|[A-Za-z0-9._~+/-]{24,})/g, "$1[redacted]")
      .replace(/((?:^|\n)\s*(?:cookie|set-cookie):\s*)[^\n\r]+/gi, "$1[redacted]")
      .replace(/(\b__rend_playback=)[^;\s]+/gi, "$1[redacted]");
    return value;
  }

  return { redact };
}

function isLowEntropyRedactionValue(value) {
  return ["rend", "local", "production", "prod", "true", "false"].includes(value.toLowerCase());
}

function isSecretLikeKey(key) {
  return /(SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY|AUTH_SECRET|SIGNING_SECRET|COOKIE|STRIPE|AUTUMN)/i.test(
    key,
  );
}

function isSecretLikeValue(value) {
  return (
    /^sk_(live|test)_/i.test(value) ||
    /^pk_(live|test)_/i.test(value) ||
    /^rk_(live|test)_/i.test(value) ||
    /^whsec_/i.test(value) ||
    /^am_sk/i.test(value) ||
    /^AKIA[0-9A-Z]{16}$/.test(value) ||
    /^ASIA[0-9A-Z]{16}$/.test(value) ||
    /^eyJ[A-Za-z0-9_-]+\./.test(value)
  );
}

function redactKeyValues(value) {
  return value.replace(
    /(["']?)([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY|AUTH_SECRET|SIGNING_SECRET|COOKIE|STRIPE|AUTUMN)[A-Z0-9_]*)(\1\s*[:=]\s*)(["']?)([^"'\s,;)}\]]+)(\4)/gi,
    (_match, open, key, separator, quoteOpen, raw, quoteClose) => {
      if (!raw || raw === "[redacted]") return `${open}${key}${open}${separator}${quoteOpen}${raw}${quoteClose}`;
      return `${open}${key}${open}${separator}${quoteOpen}[redacted]${quoteClose}`;
    },
  );
}

function redactSignedUrlParams(value) {
  return value.replace(
    /([?&](?:token|signature|sig|expires|policy|key-pair-id|x-amz-algorithm|x-amz-credential|x-amz-date|x-amz-expires|x-amz-security-token|x-amz-signature|x-amz-signedheaders)=)[^&\s"'<>)]*/gi,
    "$1[redacted]",
  );
}

function redactInternalUrls(value) {
  return value.replace(
    /\bhttps?:\/\/(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[?::1\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|(?:postgres|redis|minio|clickhouse|rend-api|rend-edge|rend-edge-us-east|rend-edge-london)(?::|\/|$)|[A-Za-z0-9.-]+\.internal)(?::\d+)?[^\s"'<>)]*/gi,
    "[redacted-internal-url]",
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendLimited(current, chunk) {
  const combined = current + chunk;
  if (Buffer.byteLength(combined) <= commandOutputLimitBytes) return combined;
  return combined.slice(-commandOutputLimitBytes);
}

function createContext(args) {
  const id = runId();
  const outputDir = path.join(launchDir, id);
  const logsDir = path.join(outputDir, "logs");
  const profile = args.profile;
  const loaded = loadProfileEnv({
    profile,
    envFile: args.envFile,
    appRoot: rootDir,
    cwd: rootDir,
  });
  const env = {
    ...loaded.env,
    REND_LAUNCH_GATE_MODE: args.mode,
    REND_LAUNCH_GATE_RUN_ID: id,
  };
  if (args.mode === "local") {
    env.REND_BILLING_MODE = "local";
    env.AUTUMN_SECRET_KEY = "";
    env.AUTUMN_API_URL = "";
  }
  const loadedFileKeys = new Set();
  for (const file of loaded.loadedFiles) {
    for (const key of Object.keys(parseEnvFile(file))) loadedFileKeys.add(key);
  }
  const redactor = createRedactor(env);
  return {
    args,
    runId: id,
    outputDir,
    logsDir,
    env,
    loadedFileKeys,
    loadedFiles: loaded.loadedFiles,
    profile,
    redactor,
    steps: [],
  };
}

async function runCommandStep(context, definition) {
  return runStep(context, definition, async () => {
    const command = definition.command;
    const args = definition.args || [];
    const startedAt = Date.now();
    const logPath = path.join(context.logsDir, `${definition.id}.log`);
    const timeoutMs = definition.timeoutMs || context.args.timeoutMs;
    const env = commandEnv(context, definition);
    const commandText = redactedCommand(command, args, context.redactor);

    await mkdir(path.dirname(logPath), { recursive: true });
    printStart(definition);

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: definition.cwd || rootDir,
        env,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout = appendLimited(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendLimited(stderr, chunk);
      });
      child.on("error", async (error) => {
        clearTimeout(timeout);
        const durationMs = elapsedMs(startedAt);
        const body = logBody({
          definition,
          commandText,
          code: null,
          signal: null,
          durationMs,
          stdout,
          stderr: `${stderr}\n${error.message}`,
          redactor: context.redactor,
          truncated: outputWasTruncated(stdout) || outputWasTruncated(stderr),
        });
        await writeFile(logPath, body);
        resolve({
          status: "fail",
          summary: `${command} failed to start`,
          duration_ms: durationMs,
          command: commandText,
          log_path: displayPath(logPath),
          error: context.redactor.redact(error.message),
        });
      });
      child.on("close", async (code, signal) => {
        clearTimeout(timeout);
        const durationMs = elapsedMs(startedAt);
        const status = code === 0 && !timedOut ? "pass" : "fail";
        const body = logBody({
          definition,
          commandText,
          code,
          signal,
          durationMs,
          stdout,
          stderr,
          redactor: context.redactor,
          truncated: outputWasTruncated(stdout) || outputWasTruncated(stderr),
        });
        await writeFile(logPath, body);
        const reason = timedOut
          ? `timed out after ${seconds(timeoutMs)}`
          : code === 0
            ? `completed in ${seconds(durationMs)}`
            : `exited with ${code ?? signal}`;
        resolve({
          status,
          summary: reason,
          duration_ms: durationMs,
          command: commandText,
          log_path: displayPath(logPath),
          exit_code: code,
          signal,
        });
      });
    });
  });
}

function outputWasTruncated(value) {
  return Buffer.byteLength(value) >= commandOutputLimitBytes;
}

function commandEnv(context, definition = {}) {
  const env = { ...(definition.useLoadedEnv ? context.env : process.env) };
  if (!definition.useLoadedEnv) {
    for (const key of context.loadedFileKeys) {
      delete env[key];
    }
    delete env.REND_ENV_PROFILE;
    delete env.REND_ENV_FILE;
    delete env.REND_LAUNCH_GATE_MODE;
    delete env.REND_LAUNCH_GATE_RUN_ID;
  }
  return {
    ...env,
    ...(definition.env || {}),
  };
}

function logBody({ definition, commandText, code, signal, durationMs, stdout, stderr, redactor, truncated }) {
  const sections = [
    `# ${definition.title || definition.id}`,
    `id: ${definition.id}`,
    `group: ${definition.group}`,
    `command: ${commandText}`,
    `exit_code: ${code ?? ""}`,
    `signal: ${signal ?? ""}`,
    `duration_ms: ${durationMs}`,
    truncated ? "note: output was truncated to the most recent captured bytes" : "",
    "",
    "## stdout",
    redactor.redact(stdout || ""),
    "",
    "## stderr",
    redactor.redact(stderr || ""),
    "",
  ].filter((line) => line !== null);
  return `${sections.join("\n")}\n`;
}

async function runStep(context, definition, handler) {
  const startedAt = Date.now();
  const startedAtIso = isoNow();
  if (!definition.command) printStart(definition);
  let result;
  try {
    result = await handler();
  } catch (error) {
    result = {
      status: "fail",
      summary: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.stack || error.message : String(error),
    };
  }
  const endedAtIso = isoNow();
  const status = validStatuses.has(result.status) ? result.status : "fail";
  const step = sanitizeJson(
    {
      id: definition.id,
      group: definition.group,
      title: definition.title || definition.id,
      status,
      started_at: startedAtIso,
      ended_at: endedAtIso,
      duration_ms: result.duration_ms ?? elapsedMs(startedAt),
      summary: result.summary || status,
      command: result.command,
      log_path: result.log_path,
      artifacts: result.artifacts,
      data: result.data,
      skipped: result.skipped === true,
      error: result.error,
    },
    context.redactor,
  );
  context.steps.push(step);
  printDone(step);
  return step;
}

function sanitizeJson(value, redactor) {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, redactor));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry === "string") return [key, redactor.redact(entry)];
      return [key, sanitizeJson(entry, redactor)];
    }),
  );
}

function printHeader(context) {
  const files = context.loadedFiles.length
    ? context.loadedFiles.map(displayPath).join(", ")
    : "platform environment only";
  console.log(`Rend V1 launch gate`);
  console.log(`Mode: ${context.args.mode}`);
  console.log(`Env profile: ${context.profile} (${files})`);
  console.log(`Run: ${context.runId}`);
  console.log(`Artifacts: ${displayPath(context.outputDir)}`);
}

function printStart(definition) {
  console.log(`\n[${definition.group}] ${definition.title || definition.id}`);
}

function printDone(step) {
  const detail = step.log_path ? ` log=${step.log_path}` : "";
  console.log(`${step.status.toUpperCase()} ${step.id} (${seconds(step.duration_ms)})${detail}`);
  if (step.summary) console.log(`  ${step.summary}`);
}

function command(id, group, title, commandName, args, options = {}) {
  return {
    id,
    group,
    title,
    command: commandName,
    args,
    ...options,
  };
}

function mutatingAllowed(context) {
  return context.args.mode !== "production-check" || context.args.includeMutatingSmoke;
}

function skipStep(context, id, group, title, summary) {
  return runStep(context, { id, group, title }, async () => ({
    status: "pass",
    summary,
    skipped: true,
  }));
}

function localBillingEnv(context) {
  return context.args.mode === "local"
    ? { REND_BILLING_MODE: "local", AUTUMN_SECRET_KEY: "", AUTUMN_API_URL: "" }
    : {};
}

async function validateLoadedLaunchEnv(context) {
  return runStep(
    context,
    {
      id: "launch-mode-policy",
      group: "env",
      title: "launch mode policy",
    },
    async () => {
      const env = context.env;
      const errors = [];
      const warnings = [];
      const mode = context.args.mode;
      const billingMode = envString(env, "REND_BILLING_MODE").toLowerCase() || (mode === "production-check" ? "autumn" : "local");
      const rendEnv = envString(env, "REND_ENV").toLowerCase();

      if (mode === "local" && billingMode !== "local") {
        errors.push("local mode requires REND_BILLING_MODE=local");
      }
      if (mode === "sandbox") {
        if (billingMode !== "autumn") errors.push("sandbox mode requires REND_BILLING_MODE=autumn");
        if (!envString(env, "AUTUMN_SECRET_KEY")) errors.push("sandbox mode requires AUTUMN_SECRET_KEY");
        if (!envString(env, "AUTUMN_API_URL", "https://api.useautumn.com/v1").startsWith("https://")) {
          errors.push("sandbox mode requires AUTUMN_API_URL to use https");
        }
      }
      if (mode === "production-check") {
        if (rendEnv !== "production") errors.push("production-check requires REND_ENV=production");
        if (billingMode !== "autumn") errors.push("production-check requires REND_BILLING_MODE=autumn");
        if (envString(env, "REND_DEV_API_KEY")) errors.push("REND_DEV_API_KEY must not be set in production-check");
        if (envString(env, "REND_API_INLINE_MEDIA_PROCESSING").toLowerCase() === "true") {
          errors.push("REND_API_INLINE_MEDIA_PROCESSING must not be enabled in production-check");
        }
        if (truthy(envString(env, "REND_ALLOW_INSECURE_EDGE_URLS"))) {
          errors.push("REND_ALLOW_INSECURE_EDGE_URLS must not be enabled in production-check");
        }
        if (!dashboardAuthConfigured(env)) {
          errors.push("production dashboard auth is not configured with secure Better Auth settings");
        }
        if (!truthy(envString(env, "REND_SELF_SERVE_SIGNUP_ENABLED"))) {
          errors.push("production-check requires REND_SELF_SERVE_SIGNUP_ENABLED=true");
        }
        if (truthy(envString(env, "REND_AUTH_EMAIL_DISABLED"))) {
          errors.push("production-check requires REND_AUTH_EMAIL_DISABLED=false");
        }
        if (!envString(env, "RESEND_API_KEY") || !envString(env, "REND_AUTH_EMAIL_FROM")) {
          errors.push("production-check requires Resend auth email configuration");
        }
        if (!envString(env, "REND_OPERATOR_EMAIL_ALLOWLIST")) {
          errors.push("production operator access requires REND_OPERATOR_EMAIL_ALLOWLIST");
        }
        if (!envString(env, "REND_SITE_INTERNAL_TOKEN")) {
          errors.push("production operator control-plane actions require REND_SITE_INTERNAL_TOKEN");
        }
        validateProductionAutumnKeySource(context, env, errors);
        if (context.args.includeMutatingSmoke) {
          warnings.push("production-check is running mutating smoke because --include-mutating-smoke was passed");
        }
      }

      return {
        status: errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
        summary:
          errors.length > 0
            ? `${errors.length} policy error(s)`
            : warnings.length > 0
              ? `${warnings.length} policy warning(s)`
              : `${mode} launch mode policy passed`,
        data: {
          mode,
          profile: context.profile,
          billing_mode: billingMode,
          checks: {
            dev_only_auth_disabled_in_production: mode === "production-check" ? !envString(env, "REND_DEV_API_KEY") : true,
            operator_access_gated: mode === "production-check" ? Boolean(envString(env, "REND_OPERATOR_EMAIL_ALLOWLIST")) : true,
            dashboard_auth_configured: mode === "production-check" ? dashboardAuthConfigured(env) : true,
            self_serve_signup_enabled: mode === "production-check" ? truthy(envString(env, "REND_SELF_SERVE_SIGNUP_ENABLED")) : true,
            resend_configured:
              mode === "production-check"
                ? Boolean(envString(env, "RESEND_API_KEY") && envString(env, "REND_AUTH_EMAIL_FROM"))
                : true,
          },
          errors,
          warnings,
        },
      };
    },
  );
}

function envString(env, key, fallback = "") {
  return String(env[key] ?? fallback).trim();
}

function dashboardAuthConfigured(env) {
  const profile = envString(env, "REND_ENV_PROFILE") || envString(env, "REND_ENV") || envString(env, "NODE_ENV") || "local";
  const production = ["production", "prod"].includes(profile.toLowerCase());
  if (!production) return true;
  const secret = envString(env, "BETTER_AUTH_SECRET") || envString(env, "AUTH_SECRET");
  const baseUrl = envString(env, "BETTER_AUTH_URL") || envString(env, "REND_AUTH_BASE_URL");
  if (!truthy(envString(env, "REND_SELF_SERVE_SIGNUP_ENABLED"))) return false;
  if (!secret || secret === "local-better-auth-secret-only-for-rend-development") return false;
  if (!baseUrl || isLocalUrl(baseUrl)) return false;
  if (truthy(envString(env, "REND_AUTH_EMAIL_DISABLED"))) return false;
  if (!envString(env, "RESEND_API_KEY") || !envString(env, "REND_AUTH_EMAIL_FROM")) return false;
  return true;
}

function isLocalUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "0.0.0.0" || host === "::1" || host.startsWith("127.");
  } catch {
    return true;
  }
}

function classifyAutumnKey(secretKey) {
  if (/^am_sk_live_/i.test(secretKey) || /(?:^|[_-])live(?:[_-])/i.test(secretKey)) return "live";
  if (
    /^am_sk_test_/i.test(secretKey) ||
    /(?:^|[_-])test(?:[_-])/i.test(secretKey) ||
    /(?:^|[_-])sandbox(?:[_-])/i.test(secretKey)
  ) {
    return "sandbox";
  }
  return "unknown";
}

function validateProductionAutumnKeySource(context, env, errors) {
  const productionFile = resolvePath(
    context.args.envFile || context.args.autumnProductionEnvFile || ".env.production.local",
  );
  if (!existsSync(productionFile)) {
    errors.push("production-check requires .env.production.local for the live Autumn key");
    return;
  }
  if (path.basename(productionFile) !== ".env.production.local") {
    errors.push("production-check must load AUTUMN_SECRET_KEY from .env.production.local");
    return;
  }

  const fileEnv = parseEnvFile(productionFile);
  const fileKey = envString(fileEnv, "AUTUMN_SECRET_KEY");
  const activeKey = envString(env, "AUTUMN_SECRET_KEY");
  if (!fileKey) {
    errors.push(".env.production.local must contain AUTUMN_SECRET_KEY");
    return;
  }
  if (activeKey !== fileKey) {
    errors.push("production-check AUTUMN_SECRET_KEY must come from .env.production.local; unset inherited AUTUMN_SECRET_KEY");
  }
  if (classifyAutumnKey(fileKey) !== "live") {
    errors.push(".env.production.local AUTUMN_SECRET_KEY must be visibly marked as live");
  }
}

async function validateProductionEnvWhenProvided(context) {
  const envFile = context.args.productionEnvFile;
  if (envFile) {
    return runCommandStep(
      context,
      command(
        "production-env-validation",
        "env",
        "production env validation",
        "node",
        ["scripts/validate-env.mjs", "--profile", "production", "--env-file", envFile],
        { timeoutMs: 90_000 },
      ),
    );
  }
  if (context.args.mode === "production-check") {
    return runCommandStep(
      context,
      command("production-env-validation", "env", "production env validation", "bun", ["run", "env:production"], {
        timeoutMs: 90_000,
      }),
    );
  }
  return skipStep(
    context,
    "production-env-validation",
    "env",
    "production env validation",
    "skipped; pass --production-env-file or use --mode production-check to validate real production env",
  );
}

async function validateCurrentEnvPolicy(context) {
  return runStep(
    context,
    {
      id: "env:loaded-profile",
      group: "env",
      title: "loaded profile env policy",
    },
    async () => {
      const files = profileEnvFiles({
        profile: context.profile,
        envFile: context.args.envFile,
        appRoot: rootDir,
        cwd: rootDir,
      });
      const result = validateEnvironment({
        profile: context.profile,
        env: context.env,
        files,
        allowPlaceholders: false,
      });
      return {
        status: result.errors.length > 0 ? "fail" : result.warnings.length > 0 ? "warn" : "pass",
        summary:
          result.errors.length > 0
            ? `${result.errors.length} env error(s)`
            : result.warnings.length > 0
              ? `${result.warnings.length} env warning(s)`
              : "loaded profile env policy passed",
        data: {
          files: files.map(displayPath),
          loaded_files: context.loadedFiles.map(displayPath),
          errors: result.errors,
          warnings: result.warnings,
        },
      };
    },
  );
}

async function validateAutumnCatalog(context) {
  return runStep(
    context,
    {
      id: "autumn-catalog",
      group: "billing",
      title: "Autumn catalog expectations",
    },
    async () => {
      const env = context.env;
      const featureIds = Object.fromEntries(requiredFeatureEnv.map(([key, envKey, fallback]) => [key, envString(env, envKey, fallback)]));
      const planIds = Object.fromEntries(requiredPlanEnv.map(([key, envKey, fallback]) => [key, envString(env, envKey, fallback)]));
      const errors = [];
      const warnings = [];

      for (const [key, value] of Object.entries({ ...featureIds, ...planIds })) {
        if (!isSafeCatalogId(value)) errors.push(`${key} catalog id is invalid`);
      }

      const billingMode = envString(env, "REND_BILLING_MODE").toLowerCase() || (context.args.mode === "production-check" ? "autumn" : "local");
      const data = {
        billing_mode: billingMode,
        feature_ids: featureIds,
        plan_ids: planIds,
        customer_mapping: {
          source: "rend organization UUID",
          autumn_customer_id: "organization_id",
        },
      };

      if (billingMode === "local") {
        data.catalog_source = "local defaults";
        data.customer_mapping.verified = true;
        data.customer_mapping.mutation = "none";
        return {
          status: errors.length > 0 ? "fail" : "pass",
          summary: errors.length > 0 ? `${errors.length} catalog id error(s)` : "local catalog ids and customer mapping passed",
          data: { ...data, errors, warnings },
        };
      }

      const secretKey = envString(env, "AUTUMN_SECRET_KEY");
      const apiUrl = envString(env, "AUTUMN_API_URL", "https://api.useautumn.com/v1").replace(/\/+$/, "");
      const apiVersion = envString(env, "AUTUMN_API_VERSION", "2.3.0");
      if (!secretKey) errors.push("AUTUMN_SECRET_KEY is required for Autumn catalog verification");
      if (!apiUrl.startsWith("https://")) errors.push("AUTUMN_API_URL must use https for Autumn catalog verification");
      if (errors.length === 0) {
        const config = { apiUrl, apiVersion, secretKey };
        const featureResults = [];
        for (const id of Object.values(featureIds)) {
          featureResults.push(await autumnPost(config, "features.get", { feature_id: id }));
        }
        const planResults = [];
        for (const id of Object.values(planIds)) {
          planResults.push(await autumnPost(config, "plans.get", { plan_id: id }));
        }
        data.catalog_source = "autumn";
        data.features_verified = featureResults.length;
        data.plans_verified = planResults.length;

        if (context.args.mode === "production-check" && !context.args.allowLiveBillingMutation) {
          data.customer_mapping.verified = true;
          data.customer_mapping.mutation = "skipped-read-only-production-check";
        } else {
          const customerId = envString(
            env,
            "REND_AUTUMN_VERIFY_CUSTOMER_ID",
            "00000000-0000-0000-0000-000000000001",
          );
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) {
            errors.push("REND_AUTUMN_VERIFY_CUSTOMER_ID must be a Rend organization UUID");
          } else {
            const customer = await autumnPost(config, "customers.get_or_create", {
              customer_id: customerId,
              name: envString(env, "REND_AUTUMN_VERIFY_CUSTOMER_NAME", "Rend launch gate verification"),
              email: envString(env, "REND_AUTUMN_VERIFY_CUSTOMER_EMAIL") || undefined,
              metadata: { source: "rend-launch-gate" },
            });
            const returnedId = String(customer.customer_id ?? customer.id ?? "");
            if (returnedId && returnedId !== customerId) {
              errors.push("Autumn customer id did not match Rend organization UUID mapping");
            }
            data.customer_mapping.verified = errors.length === 0;
            data.customer_mapping.mutation =
              context.args.mode === "production-check" ? "allowed-production-check" : "sandbox-or-local-autumn";
          }
        }
      }

      return {
        status: errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
        summary:
          errors.length > 0
            ? `${errors.length} Autumn catalog error(s)`
            : warnings.length > 0
              ? `${warnings.length} Autumn catalog warning(s)`
              : "Autumn catalog expectations passed",
        data: { ...data, errors, warnings },
      };
    },
  );
}

async function validateAutumnCatalogParity(context) {
  if (context.args.mode !== "production-check") {
    return skipStep(
      context,
      "autumn-catalog-parity",
      "billing",
      "Autumn sandbox/production catalog parity",
      "skipped outside production-check",
    );
  }

  const artifactPath = path.join(context.outputDir, "autumn-catalog-parity.json");
  const sandboxFile = context.args.autumnSandboxEnvFile || ".env.local";
  const productionFile =
    context.args.autumnProductionEnvFile || context.args.envFile || ".env.production.local";
  const commandArgs = [
    "scripts/autumn-catalog-parity.mjs",
    "--sandbox-env-file",
    sandboxFile,
    "--production-env-file",
    productionFile,
    "--artifact",
    artifactPath,
    "--timeout-ms",
    String(Math.min(context.args.timeoutMs, 120_000)),
  ];
  const step = await runCommandStep(
    context,
    command(
      "autumn-catalog-parity",
      "billing",
      "Autumn sandbox/production catalog parity",
      "node",
      commandArgs,
      { timeoutMs: 180_000 },
    ),
  );
  const recorded = context.steps.at(-1);
  if (recorded?.id === "autumn-catalog-parity") {
    recorded.artifacts = [...(recorded.artifacts || []), displayPath(artifactPath)];
  }
  return step;
}

async function validateSelfServeReadiness(context) {
  if (context.args.mode !== "production-check") {
    return skipStep(
      context,
      "self-serve-readiness",
      "release",
      "public V1 self-serve readiness artifact",
      "skipped outside production-check",
    );
  }

  const artifactPath = path.join(context.outputDir, "self-serve-readiness.json");
  const otpDiagnosticsArtifact = path.join(context.outputDir, "auth-otp-diagnostics.json");
  const commandArgs = [
    "scripts/self-serve-readiness.mjs",
    "--env-file",
    context.args.envFile || ".env.production.local",
    "--otp-diagnostics-artifact",
    otpDiagnosticsArtifact,
    "--require-otp-health",
    "--require-otp-probe",
    "--dry-run-artifact",
    path.join(".rend", "launch", "production-dry-run-latest.json"),
    "--launch-gate-artifact",
    path.join(".rend", "launch", "launch-readiness-latest.json"),
  ];
  const step = await runCommandStep(
    context,
    command(
      "self-serve-readiness",
      "release",
      "public V1 self-serve readiness artifact",
      "node",
      commandArgs,
      { timeoutMs: 120_000 },
    ),
  );
  const latest = path.join(launchDir, "self-serve-readiness-latest.json");
  const recorded = context.steps.at(-1);
  if (recorded?.id === "self-serve-readiness") {
    recorded.artifacts = [
      ...(recorded.artifacts || []),
      displayPath(latest),
      displayPath(artifactPath),
    ];
  }
  if (existsSync(latest)) {
    await copyFile(latest, artifactPath).catch(() => undefined);
  }
  return step;
}

async function validateAuthOtpDiagnostics(context) {
  if (context.args.mode !== "production-check") {
    return skipStep(
      context,
      "auth-otp-diagnostics",
      "auth",
      "production auth OTP diagnostics",
      "skipped outside production-check",
    );
  }

  const artifactPath = path.join(context.outputDir, "auth-otp-diagnostics.json");
  const commandArgs = [
    "scripts/auth-otp-diagnostics.mjs",
    "--env-file",
    context.args.envFile || ".env.production.local",
    "--artifact",
    artifactPath,
    "--require-probe",
    "--timeout-ms",
    String(Math.min(context.args.timeoutMs, 60_000)),
  ];
  const step = await runCommandStep(
    context,
    command(
      "auth-otp-diagnostics",
      "auth",
      "production auth OTP diagnostics",
      "node",
      commandArgs,
      { timeoutMs: 120_000 },
    ),
  );
  const recorded = context.steps.at(-1);
  if (recorded?.id === "auth-otp-diagnostics") {
    recorded.artifacts = [
      ...(recorded.artifacts || []),
      displayPath(artifactPath),
      displayPath(path.join(launchDir, "auth-otp-diagnostics-latest.json")),
    ];
  }
  return step;
}

async function runProductionSdkE2e(context) {
  if (context.args.mode !== "production-check") {
    return skipStep(
      context,
      "production-sdk-e2e",
      "sdk",
      "published npm SDK production E2E",
      "skipped outside production-check",
    );
  }
  if (!context.args.includeProductionSdkE2e) {
    return skipStep(
      context,
      "production-sdk-e2e",
      "sdk",
      "published npm SDK production E2E",
      "skipped; pass --include-production-sdk-e2e with production mutation acknowledgements to run",
    );
  }
  if (!context.args.allowProductionMutation || !context.args.acknowledgeRealBilling) {
    return runStep(
      context,
      {
        id: "production-sdk-e2e",
        group: "sdk",
        title: "published npm SDK production E2E",
      },
      async () => ({
        status: "fail",
        summary: "requires --allow-production-mutation and --acknowledge-real-billing",
        data: {
          include_production_sdk_e2e: context.args.includeProductionSdkE2e,
          allow_production_mutation: context.args.allowProductionMutation,
          acknowledge_real_billing: context.args.acknowledgeRealBilling,
        },
      }),
    );
  }

  const artifactPath = path.join(context.outputDir, "production-sdk-e2e.json");
  const commandArgs = [
    "scripts/production-sdk-e2e.mjs",
    "--allow-production-mutation",
    "--acknowledge-real-billing",
    "--env-file",
    context.args.envFile || ".env.production.local",
    "--artifact",
    artifactPath,
    "--timeout-ms",
    String(Math.min(context.args.timeoutMs, 20 * 60 * 1_000)),
  ];
  const step = await runCommandStep(
    context,
    command(
      "production-sdk-e2e",
      "sdk",
      "published npm SDK production E2E",
      "node",
      commandArgs,
      { timeoutMs: Math.max(context.args.timeoutMs, 20 * 60 * 1_000) },
    ),
  );
  const recorded = context.steps.at(-1);
  if (recorded?.id === "production-sdk-e2e") {
    recorded.artifacts = [
      ...(recorded.artifacts || []),
      displayPath(artifactPath),
      displayPath(path.join(launchDir, "production-sdk-e2e-latest.json")),
    ];
  }
  return step;
}

function isSafeCatalogId(value) {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(String(value || ""));
}

async function autumnPost(config, routePath, body) {
  const response = await fetch(`${config.apiUrl}/${routePath}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.secretKey}`,
      "content-type": "application/json",
      "x-api-version": config.apiVersion,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text.slice(0, 240) };
  }
  if (!response.ok) {
    const message = String(data.message || data.error || `HTTP ${response.status}`).slice(0, 240);
    throw new Error(`Autumn ${routePath} failed: ${message}`);
  }
  return data;
}

async function docsLeakScan(context) {
  return runStep(
    context,
    {
      id: "docs-static-leak-scan",
      group: "docs",
      title: "docs/static leak scan",
    },
    async () => {
      const files = new Set(publicDocsFiles.map((file) => path.join(rootDir, file)));
      for (const dir of publicStaticDirs) {
        await collectFiles(path.join(rootDir, dir), files);
      }
      const failures = [];
      const scanned = [];
      for (const file of [...files].sort()) {
        if (!existsSync(file)) continue;
        const fileStat = await stat(file);
        if (!fileStat.isFile() || fileStat.size > 2 * 1024 * 1024) continue;
        const text = await readFile(file, "utf8").catch(() => "");
        if (!text) continue;
        scanned.push(displayPath(file));
        for (const finding of scanPublicText(text, displayPath(file))) {
          failures.push(finding);
        }
      }
      return {
        status: failures.length > 0 ? "fail" : "pass",
        summary: failures.length > 0 ? `${failures.length} public docs/static leak(s)` : `${scanned.length} public docs/static files passed`,
        data: {
          scanned_files: scanned,
          failures,
        },
      };
    },
  );
}

async function collectFiles(dir, output) {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(fullPath, output);
    else if (entry.isFile()) output.add(fullPath);
  }
}

function scanPublicText(text, file) {
  const forbidden = [
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
    "api-internal.",
  ];
  const findings = [];
  for (const pattern of forbidden) {
    if (text.includes(pattern)) {
      findings.push({ file, pattern });
    }
  }
  const regexes = [
    { name: "stripe secret key", pattern: /\bsk_(?:live|test)_[A-Za-z0-9_]+/ },
    { name: "autumn secret key", pattern: /\bam_sk(?:_(?:live|test))?_[A-Za-z0-9_]+/ },
    { name: "webhook secret", pattern: /\bwhsec_[A-Za-z0-9_]+/ },
    { name: "signed URL parameter", pattern: /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature|token)=/i },
    { name: "internal hostname", pattern: /\bhttps?:\/\/[A-Za-z0-9.-]+\.internal\b/i },
  ];
  for (const { name, pattern } of regexes) {
    if (pattern.test(text)) findings.push({ file, pattern: name });
  }
  return findings;
}

async function releaseImageCheck(context) {
  const manifestPath = resolvePath(context.args.releaseManifest);
  if (manifestPath) {
    return runStep(
      context,
      {
        id: "release-image-manifest",
        group: "release",
        title: "release image manifest validation",
      },
      async () => {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const errors = validateReleaseManifest(manifest);
        return {
          status: errors.length > 0 ? "fail" : "pass",
          summary: errors.length > 0 ? `${errors.length} release manifest error(s)` : "release manifest validation passed",
          artifacts: [displayPath(manifestPath)],
          data: {
            manifest_path: displayPath(manifestPath),
            pushed: manifest.pushed === true,
            services: Object.keys(manifest.services || {}),
            errors,
          },
        };
      },
    );
  }
  if (context.args.releaseDryRun) {
    const tag = `launch-gate-${context.runId}`;
    const outputPath = path.join(context.outputDir, "release-image-dry-run-manifest.json");
    return runCommandStep(
      context,
      command(
        "release-image-dry-run",
        "release",
        "release image dry-run",
        "bun",
        ["run", "release:images", "--", "--tag", tag, "--manifest", outputPath, "--allow-dirty"],
        { timeoutMs: 30 * 60 * 1_000 },
      ),
    );
  }
  return skipStep(
    context,
    "release-image-validation",
    "release",
    "release image dry-run or manifest validation",
    "skipped; set --release-manifest or --release-dry-run to enable",
  );
}

function validateReleaseManifest(manifest) {
  const errors = [];
  const services = manifest?.services && typeof manifest.services === "object" ? manifest.services : {};
  const required = ["rend-api", "rend-media-worker", "rend-edge"];
  if (manifest?.schema_version !== 1) errors.push("schema_version must be 1");
  for (const service of required) {
    const entry = services[service];
    if (!entry) {
      errors.push(`missing service ${service}`);
      continue;
    }
    if (entry.target !== service) errors.push(`${service} target must match service name`);
    if (!entry.image_tag) errors.push(`${service} image_tag is required`);
    if (!entry.digest) errors.push(`${service} digest is required`);
    if (!entry.git_sha || !/^[0-9a-f]{40}$/i.test(entry.git_sha)) errors.push(`${service} git_sha must be a full SHA`);
    if (!entry.build_time || entry.build_time === "unknown") errors.push(`${service} build_time is required`);
    if (!entry.platform || !String(entry.platform).startsWith("linux/")) errors.push(`${service} platform must be linux/*`);
    if (manifest.pushed === true && !entry.image_digest) errors.push(`${service} pushed manifest requires image_digest`);
  }
  return errors;
}

async function startSiteForSmoke(context) {
  if (!mutatingAllowed(context)) {
    return { baseUrl: "", stop: async () => undefined, skipped: true };
  }
  const configured = envString(context.env, "REND_SITE_BASE_URL");
  if (configured) {
    await waitForHttp(configured, 120_000);
    return { baseUrl: configured.replace(/\/+$/, ""), stop: async () => undefined, skipped: false };
  }

  const port = await freePort(3000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = path.join(context.logsDir, "site-dev-server.log");
  const nextBin = path.join(rootDir, "apps", "site", "node_modules", ".bin", "next");
  const detached = process.platform !== "win32";
  const child = spawn("node", ["../../scripts/with-root-env.mjs", "--profile", "local", nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: path.join(rootDir, "apps", "site"),
    env: {
      ...context.env,
      ...localBillingEnv(context),
      REND_SITE_BASE_URL: baseUrl,
      NODE_ENV: "development",
    },
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await mkdir(path.dirname(logPath), { recursive: true });
  const appendRedacted = async (chunk) => appendFile(logPath, context.redactor.redact(chunk.toString()));
  child.stdout.on("data", (chunk) => {
    void appendRedacted(chunk);
  });
  child.stderr.on("data", (chunk) => {
    void appendRedacted(chunk);
  });
  let exitedBeforeReady = null;
  child.on("exit", (code, signal) => {
    exitedBeforeReady = { code, signal };
  });

  try {
    await waitForHttp(baseUrl, 180_000, () => exitedBeforeReady);
  } catch (error) {
    stopChildProcessGroup(child, detached, "SIGTERM");
    throw new Error(`site dev server did not become ready; see ${displayPath(logPath)}: ${error.message}`);
  }

  return {
    baseUrl,
    logPath,
    skipped: false,
    stop: async () => {
      stopChildProcessGroup(child, detached, "SIGTERM");
      await sleep(500);
      if (child.exitCode === null) stopChildProcessGroup(child, detached, "SIGKILL");
    },
  };
}

function stopChildProcessGroup(child, detached, signal) {
  if (!child.pid) return;
  try {
    process.kill(detached ? -child.pid : child.pid, signal);
  } catch {
    // Already exited.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForHttp(url, timeoutMs, exited) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      while (Date.now() < deadline) {
        const exitState = exited?.();
        if (exitState) {
          reject(new Error(`process exited before readiness with ${exitState.code ?? exitState.signal}`));
          return;
        }
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (response.status < 500) {
            resolve(response);
            return;
          }
        } catch {
          // keep polling
        }
        await sleep(500);
      }
      reject(new Error(`timed out waiting for ${url}`));
    };
    void poll();
  });
}

async function freePort(preferred) {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function writeArtifacts(context, startedAtIso) {
  const endedAtIso = isoNow();
  const status = overallStatus(context.steps);
  const outputPath = path.join(launchDir, `launch-readiness-${context.runId}.json`);
  const latestPath = path.join(launchDir, "launch-readiness-latest.json");
  const document = sanitizeJson(
    {
      schema_version: 1,
      gate: "rend-v1-public-launch-gate",
      run_id: context.runId,
      mode: context.args.mode,
      profile: context.profile,
      status,
      started_at: startedAtIso,
      ended_at: endedAtIso,
      output_dir: displayPath(context.outputDir),
      loaded_env_files: context.loadedFiles.map(displayPath),
      summary: {
        pass: context.steps.filter((step) => step.status === "pass").length,
        warn: context.steps.filter((step) => step.status === "warn").length,
        fail: context.steps.filter((step) => step.status === "fail").length,
      },
      artifact_policy: {
        redacted: true,
        secrets: false,
        tokens: false,
        cookies: false,
        signed_urls: false,
        autumn_keys: false,
        stripe_keys: false,
        internal_urls: false,
      },
      steps: context.steps,
    },
    context.redactor,
  );
  await mkdir(launchDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  await copyFile(outputPath, latestPath);
  const redactionFailures = await scanLaunchArtifactsForLeaks(context, [outputPath, latestPath]);
  if (redactionFailures.length > 0) {
    document.status = "fail";
    document.summary.fail += 1;
    document.steps.push({
      id: "launch-artifact-redaction",
      group: "artifacts",
      title: "launch artifact redaction",
      status: "fail",
      started_at: endedAtIso,
      ended_at: isoNow(),
      duration_ms: 0,
      summary: `${redactionFailures.length} redaction leak(s) found`,
      data: { failures: redactionFailures },
    });
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
    await copyFile(outputPath, latestPath);
  }
  return { status: document.status, outputPath, latestPath, document };
}

async function scanLaunchArtifactsForLeaks(context, jsonPaths) {
  const files = new Set(jsonPaths);
  if (existsSync(context.logsDir)) await collectFiles(context.logsDir, files);
  const failures = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const finding of scanRedactionLeaks(text, displayPath(file))) {
      failures.push(finding);
    }
  }
  return failures;
}

function scanRedactionLeaks(text, file) {
  const findings = [];
  const patterns = [
    ["stripe secret key", /\bsk_(?:live|test)_[A-Za-z0-9_]+/],
    ["stripe webhook secret", /\bwhsec_[A-Za-z0-9_]+/],
    ["autumn secret key", /\bam_sk(?:_(?:live|test))?_[A-Za-z0-9_]+/],
    ["authorization bearer", /\bauthorization:\s*Bearer\s+(?!\[redacted\])/i],
    ["cookie header", /(?:^|\n)\s*(?:cookie|set-cookie):\s*(?!\[redacted\])/i],
    ["signed URL parameter", /[?&](?:token|signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=[^&\s"']+/i],
    ["internal URL", /\bhttps?:\/\/(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[?::1\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[A-Za-z0-9.-]+\.internal)\b/i],
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) findings.push({ file, pattern: name });
  }
  return findings;
}

function buildSteps(context) {
  const steps = [
    () => runCommandStep(context, command("env:local", "env", "env:local", "bun", ["run", "env:local"], { timeoutMs: 90_000 })),
    () =>
      runCommandStep(
        context,
        command("env:production:example", "env", "env:production:example", "bun", ["run", "env:production:example"], {
          timeoutMs: 90_000,
        }),
      ),
    () => validateCurrentEnvPolicy(context),
    () => validateProductionEnvWhenProvided(context),
    () => validateLoadedLaunchEnv(context),
    () => validateAuthOtpDiagnostics(context),
    () => validateAutumnCatalog(context),
    () => validateAutumnCatalogParity(context),
    () => validateSelfServeReadiness(context),
    () => runProductionSdkE2e(context),
    () =>
      runCommandStep(context, command("openapi:check", "openapi", "OpenAPI check", "bun", ["run", "openapi:check"], { timeoutMs: 180_000 })),
    () =>
      runCommandStep(
        context,
        command("openapi:contract", "openapi", "OpenAPI contract tests", "bun", ["run", "openapi:contract"], {
          timeoutMs: 180_000,
        }),
      ),
    () =>
      runCommandStep(context, command("sdk:tests", "sdk", "SDK tests", "bun", ["run", "openapi:sdk-test"], { timeoutMs: 180_000 })),
    () =>
      runCommandStep(
        context,
        command("site:tests", "site", "site tests", "bun", ["run", "--cwd", "apps/site", "test"], { timeoutMs: 300_000 }),
      ),
    () =>
      runCommandStep(
        context,
        command("site:typecheck", "site", "site typecheck", "bun", ["run", "--cwd", "apps/site", "typecheck"], {
          timeoutMs: 300_000,
        }),
      ),
    () => runCommandStep(context, command("site:build", "site", "site build", "bun", ["run", "build:site"], { timeoutMs: 900_000 })),
    () =>
      runCommandStep(
        context,
        command("cargo:fmt", "cargo", "cargo fmt", "cargo", ["fmt", "--all", "--", "--check"], { timeoutMs: 180_000 }),
      ),
    () =>
      runCommandStep(context, command("cargo:check", "cargo", "cargo check", "cargo", ["check", "--workspace"], { timeoutMs: 900_000 })),
    () =>
      runCommandStep(context, command("cargo:test", "cargo", "cargo test", "cargo", ["test", "--workspace"], { timeoutMs: 900_000 })),
  ];

  if (mutatingAllowed(context)) {
    steps.push(
      () =>
        runCommandStep(
          context,
          command("docker:build", "docker", "Docker build", "bun", ["run", "backend:docker:build"], {
            timeoutMs: 1_800_000,
          }),
        ),
      () =>
        runCommandStep(
          context,
          command("docker:up", "docker", "Docker up", "bun", ["run", "backend:docker:up"], { timeoutMs: 600_000 }),
        ),
      () =>
        runCommandStep(
          context,
          command("docker:smoke", "docker", "Docker smoke", "bun", ["run", "backend:docker:smoke"], { timeoutMs: 900_000 }),
        ),
      () => runSdkIntegrationSmokeWithSite(context),
      () =>
        runCommandStep(
          context,
          command("playback:readiness", "playback", "playback readiness", "bun", ["run", "playback:readiness"], {
            timeoutMs: 1_200_000,
          }),
        ),
      () =>
        runCommandStep(
          context,
          command("billing:denial-smoke", "billing", "billing denial smoke", "bun", ["run", "backend:smoke:billing-denial"], {
            timeoutMs: 600_000,
          }),
        ),
      () =>
        runCommandStep(
          context,
          command("site:e2e-assets", "site-e2e", "site assets E2E", "bun", ["run", "e2e:site-assets"], {
            timeoutMs: 1_200_000,
            env: localBillingEnv(context),
          }),
        ),
      () =>
        runCommandStep(
          context,
          command("site:e2e-player-telemetry", "site-e2e", "player telemetry E2E", "bun", ["run", "e2e:player-telemetry"], {
            timeoutMs: 1_200_000,
            env: localBillingEnv(context),
          }),
        ),
    );
  } else {
    for (const [id, group, title] of [
      ["docker:build", "docker", "Docker build"],
      ["docker:up", "docker", "Docker up"],
      ["docker:smoke", "docker", "Docker smoke"],
      ["sdk:integration-smoke", "sdk", "SDK integration smoke"],
      ["playback:readiness", "playback", "playback readiness"],
      ["billing:denial-smoke", "billing", "billing denial smoke"],
      ["site:e2e-assets", "site-e2e", "site assets E2E"],
      ["site:e2e-player-telemetry", "site-e2e", "player telemetry E2E"],
    ]) {
      steps.push(() =>
        skipStep(context, id, group, title, "skipped in production-check; pass --include-mutating-smoke to run local mutating smoke"),
      );
    }
  }

  steps.push(() => docsLeakScan(context), () => releaseImageCheck(context));
  return steps;
}

async function runSdkIntegrationSmokeWithSite(context) {
  let site;
  try {
    site = await startSiteForSmoke(context);
  } catch (error) {
    return runStep(
      context,
      {
        id: "sdk:integration-smoke",
        group: "sdk",
        title: "SDK integration smoke",
      },
      async () => {
        throw error;
      },
    );
  }
  try {
    const step = await runCommandStep(
      context,
      command("sdk:integration-smoke", "sdk", "SDK integration smoke", "bun", ["run", "sdk:integration-smoke"], {
        timeoutMs: 600_000,
        env: {
          ...localBillingEnv(context),
          REND_SITE_BASE_URL: site.baseUrl || context.env.REND_SITE_BASE_URL,
        },
      }),
    );
    const recorded = context.steps.at(-1);
    if (recorded?.id === "sdk:integration-smoke") {
      recorded.artifacts = [...(recorded.artifacts || []), ...(site.logPath ? [displayPath(site.logPath)] : [])];
      recorded.data = {
        ...(recorded.data || {}),
        site_base_url: site.baseUrl ? "[redacted-internal-url]" : null,
        site_log_path: site.logPath ? displayPath(site.logPath) : null,
      };
    }
    return step;
  } finally {
    await site.stop().catch(() => undefined);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (repoRoot !== rootDir) {
    throw new Error(`repo root mismatch: ${repoRoot} vs ${rootDir}`);
  }
  const context = createContext(args);
  const startedAtIso = isoNow();
  await mkdir(context.logsDir, { recursive: true });
  printHeader(context);

  for (const step of buildSteps(context)) {
    await step();
  }

  const artifact = await writeArtifacts(context, startedAtIso);
  console.log(`\nLaunch gate ${artifact.status.toUpperCase()}`);
  console.log(`Readiness: ${displayPath(artifact.outputPath)}`);
  console.log(`Latest: ${displayPath(artifact.latestPath)}`);
  console.log(
    `Summary: pass=${artifact.document.summary.pass} warn=${artifact.document.summary.warn} fail=${artifact.document.summary.fail}`,
  );
  return artifact.status === "fail" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
