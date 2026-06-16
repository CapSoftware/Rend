#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseEnvFile, repoRoot } from "./env-policy.mjs";

const requireFromSite = createRequire(path.join(repoRoot, "apps", "site", "package.json"));

const PACKAGE_NAME = "@rend-sdk/client";
const NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com/v1";
const DEFAULT_AUTUMN_API_VERSION = "2.3.0";
const DEFAULT_PUBLIC_API_BASE_URL = "https://api.rend.so";
const DEFAULT_PUBLIC_SITE_BASE_URL = "https://rend.so";
const DEFAULT_INTERNAL_TEST_PLAN_ID = "internal_production_dry_run";
const DEFAULT_FIXTURE_PATH = ".rend/launch/fixtures/production-sdk-e2e.mp4";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_USAGE_TIMEOUT_MS = 240_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_EMAIL_DOMAIN = "rend.so";
const SYNTHETIC_USER_NAME = "Rend Production SDK E2E";
const LEGAL_ASSENT_COOKIE = "rend_legal_assent";
const LEGAL_ASSENT_VERSION = "2026-06-15";
const SECONDS_PER_BILLING_MONTH = 30 * 24 * 60 * 60;
const LAUNCH_DIR = path.join(repoRoot, ".rend", "launch");

function usage() {
  return `Usage: node scripts/production-sdk-e2e.mjs --allow-production-mutation --acknowledge-real-billing [options]

Installs the published ${PACKAGE_NAME} package from the npm registry into a
fresh temp consumer project outside this monorepo, typechecks a TypeScript
consumer, and runs that published SDK end to end against Rend production.

Options:
  --allow-production-mutation
      Required for all live production mutations.
  --acknowledge-real-billing
      Required because live Autumn usage can create chargeable billing artifacts.
  --env-file FILE
      Production env file. Defaults to .env.production.local and must be that
      file name for live runs.
  --api-base-url URL
      Public Rend API URL. Defaults to REND_PUBLIC_API_BASE_URL or https://api.rend.so.
  --site-base-url URL
      Public Rend site URL. Defaults to REND_PUBLIC_SITE_BASE_URL, BETTER_AUTH_URL,
      or https://rend.so.
  --plan-id PLAN
      Autumn internal test plan to attach. Defaults to
      REND_AUTUMN_INTERNAL_SDK_E2E_PLAN_ID, REND_AUTUMN_INTERNAL_DRY_RUN_PLAN_ID,
      or ${DEFAULT_INTERNAL_TEST_PLAN_ID}.
  --fixture FILE
      Small synthetic fixture path. Generated when missing.
  --email-domain DOMAIN
      Domain for the synthetic self-serve user. Defaults to
      REND_PRODUCTION_SDK_E2E_EMAIL_DOMAIN or ${DEFAULT_EMAIL_DOMAIN}.
  --otp-command COMMAND
      Command that prints the six-digit OTP from the test inbox after this
      script requests it. Output is parsed and never written to artifacts.
  --otp-code CODE
      Six-digit OTP already received out of band. Must be paired with
      --skip-otp-request so this run does not request a newer code.
  --skip-otp-request
      Use an existing self-serve OTP instead of requesting a new one in this run.
  --timeout-ms NUMBER
      Asset playable and browser timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --usage-timeout-ms NUMBER
      Billing usage verification timeout. Defaults to ${DEFAULT_USAGE_TIMEOUT_MS}.
  --artifact FILE
      Write the redacted artifact to FILE. Defaults under .rend/launch/.
  --keep-temp
      Keep the external temp consumer project for inspection. Never keeps secrets
      in files created by this script.
  -h, --help
      Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    allowProductionMutation: false,
    acknowledgeRealBilling: false,
    envFile: process.env.REND_PRODUCTION_SDK_E2E_ENV_FILE || ".env.production.local",
    apiBaseUrl: process.env.REND_PUBLIC_API_BASE_URL || process.env.REND_PRODUCTION_SDK_E2E_API_BASE_URL || "",
    siteBaseUrl: process.env.REND_PUBLIC_SITE_BASE_URL || process.env.REND_PRODUCTION_SDK_E2E_SITE_BASE_URL || "",
    planId: process.env.REND_AUTUMN_INTERNAL_SDK_E2E_PLAN_ID || process.env.REND_AUTUMN_INTERNAL_DRY_RUN_PLAN_ID || DEFAULT_INTERNAL_TEST_PLAN_ID,
    fixture: process.env.REND_PRODUCTION_SDK_E2E_FIXTURE || DEFAULT_FIXTURE_PATH,
    emailDomain: process.env.REND_PRODUCTION_SDK_E2E_EMAIL_DOMAIN || DEFAULT_EMAIL_DOMAIN,
    otpCommand: process.env.REND_PRODUCTION_SDK_E2E_OTP_COMMAND || "",
    otpCode: process.env.REND_PRODUCTION_SDK_E2E_OTP_CODE || "",
    skipOtpRequest: truthy(process.env.REND_PRODUCTION_SDK_E2E_SKIP_OTP_REQUEST),
    artifact: process.env.REND_PRODUCTION_SDK_E2E_ARTIFACT || "",
    timeoutMs: positiveInteger(process.env.REND_PRODUCTION_SDK_E2E_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    intervalMs: positiveInteger(process.env.REND_PRODUCTION_SDK_E2E_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    usageTimeoutMs: positiveInteger(process.env.REND_PRODUCTION_SDK_E2E_USAGE_TIMEOUT_MS, DEFAULT_USAGE_TIMEOUT_MS),
    keepTemp: truthy(process.env.REND_PRODUCTION_SDK_E2E_KEEP_TEMP),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--allow-production-mutation") args.allowProductionMutation = true;
    else if (arg === "--acknowledge-real-billing") args.acknowledgeRealBilling = true;
    else if (arg === "--env-file") args.envFile = next();
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice("--env-file=".length);
    else if (arg === "--api-base-url") args.apiBaseUrl = next();
    else if (arg.startsWith("--api-base-url=")) args.apiBaseUrl = arg.slice("--api-base-url=".length);
    else if (arg === "--site-base-url") args.siteBaseUrl = next();
    else if (arg.startsWith("--site-base-url=")) args.siteBaseUrl = arg.slice("--site-base-url=".length);
    else if (arg === "--plan-id") args.planId = next();
    else if (arg.startsWith("--plan-id=")) args.planId = arg.slice("--plan-id=".length);
    else if (arg === "--fixture") args.fixture = next();
    else if (arg.startsWith("--fixture=")) args.fixture = arg.slice("--fixture=".length);
    else if (arg === "--email-domain") args.emailDomain = next();
    else if (arg.startsWith("--email-domain=")) args.emailDomain = arg.slice("--email-domain=".length);
    else if (arg === "--otp-command") args.otpCommand = next();
    else if (arg.startsWith("--otp-command=")) args.otpCommand = arg.slice("--otp-command=".length);
    else if (arg === "--otp-code") args.otpCode = next();
    else if (arg.startsWith("--otp-code=")) args.otpCode = arg.slice("--otp-code=".length);
    else if (arg === "--skip-otp-request") args.skipOtpRequest = true;
    else if (arg === "--artifact") args.artifact = next();
    else if (arg.startsWith("--artifact=")) args.artifact = arg.slice("--artifact=".length);
    else if (arg === "--timeout-ms") args.timeoutMs = positiveInteger(next(), DEFAULT_TIMEOUT_MS);
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), DEFAULT_TIMEOUT_MS);
    else if (arg === "--usage-timeout-ms") args.usageTimeoutMs = positiveInteger(next(), DEFAULT_USAGE_TIMEOUT_MS);
    else if (arg.startsWith("--usage-timeout-ms=")) args.usageTimeoutMs = positiveInteger(arg.slice("--usage-timeout-ms=".length), DEFAULT_USAGE_TIMEOUT_MS);
    else if (arg === "--keep-temp") args.keepTemp = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function truthy(value) {
  return ["1", "true", "yes", "on", "y"].includes(String(value || "").trim().toLowerCase());
}

function isoNow() {
  return new Date().toISOString();
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function resolvePath(file) {
  if (!file) return "";
  return path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
}

function displayPath(file) {
  const relative = path.relative(repoRoot, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replaceAll(path.sep, "/")
    : file;
}

function envString(env, key, fallback = "") {
  return String(env[key] ?? fallback).trim();
}

function normalizeBaseUrl(value, fallback) {
  const raw = String(value || fallback).trim();
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error(`${raw} must use https`);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
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

function keyFingerprint(secretKey) {
  return crypto.createHash("sha256").update(secretKey, "utf8").digest("hex").slice(0, 16);
}

function redactUnsafeText(value) {
  return String(value ?? "")
    .replace(/\bproduction-sdk-e2e\+[a-z0-9-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "[redacted-synthetic-email]")
    .replace(/\bproduction-dry-run\+[a-z0-9-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "[redacted-synthetic-email]")
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted-stripe-key]")
    .replace(/\bwhsec_[A-Za-z0-9_]+/g, "[redacted-stripe-webhook-secret]")
    .replace(/\bam_sk(?:_(?:live|test))?_[A-Za-z0-9_]+/g, "[redacted-autumn-key]")
    .replace(/\brend_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted-rend-api-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/g, "Bearer [redacted]")
    .replace(/((?:^|\n)\s*(?:cookie|set-cookie):\s*)[^\n\r]+/gi, "$1[redacted]")
    .replace(/(\b__rend_playback=)[^;\s]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|signature|sig|secret|session|client_secret|checkout_session_id)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/"otp"\s*:\s*"[^"]+"/gi, '"otp":"[redacted]"')
    .replace(/"code"\s*:\s*"[^"]+"/gi, '"code":"[redacted]"')
    .replace(/\b\d{6}\b/g, "[redacted-code]")
    .replace(
      /\bhttps?:\/\/(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[?::1\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[A-Za-z0-9.-]+\.internal)(?::\d+)?[^\s"'<>)]*/gi,
      "[redacted-internal-url]",
    )
    .slice(0, 2_000);
}

function sanitizeArtifactData(value) {
  if (typeof value === "string") return redactUnsafeText(value);
  if (Array.isArray(value)) return value.map(sanitizeArtifactData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeArtifactData(entry)]));
}

function loadProductionEnv(file) {
  const resolved = resolvePath(file);
  if (!existsSync(resolved)) throw new Error(`production env file does not exist: ${displayPath(resolved)}`);
  const parsed = parseEnvFile(resolved);
  return {
    file: resolved,
    env: {
      ...parsed,
      REND_ENV_PROFILE: "production",
    },
  };
}

function validateSafety(args, env) {
  const errors = [];
  if (!args.allowProductionMutation) {
    errors.push("refusing to mutate production without --allow-production-mutation");
  }
  if (!args.acknowledgeRealBilling) {
    errors.push("--acknowledge-real-billing is required because live Autumn usage can create billing artifacts");
  }
  if (path.basename(resolvePath(args.envFile)) !== ".env.production.local") {
    errors.push("production SDK E2E must load live production env from .env.production.local");
  }
  if (envString(env, "REND_ENV").toLowerCase() !== "production") {
    errors.push("production SDK E2E requires REND_ENV=production");
  }
  if (envString(env, "REND_BILLING_MODE").toLowerCase() !== "autumn") {
    errors.push("production SDK E2E requires REND_BILLING_MODE=autumn");
  }
  if (!truthy(envString(env, "REND_SELF_SERVE_SIGNUP_ENABLED"))) {
    errors.push("production SDK E2E requires REND_SELF_SERVE_SIGNUP_ENABLED=true");
  }
  if (truthy(envString(env, "REND_AUTH_EMAIL_DISABLED"))) {
    errors.push("production SDK E2E requires REND_AUTH_EMAIL_DISABLED=false");
  }
  if (!envString(env, "BETTER_AUTH_SECRET") && !envString(env, "AUTH_SECRET")) {
    errors.push("BETTER_AUTH_SECRET or AUTH_SECRET is required");
  }
  if (!envString(env, "BETTER_AUTH_URL") && !envString(env, "REND_AUTH_BASE_URL")) {
    errors.push("BETTER_AUTH_URL or REND_AUTH_BASE_URL is required");
  }
  if (!envString(env, "RESEND_API_KEY") || !envString(env, "REND_AUTH_EMAIL_FROM")) {
    errors.push("RESEND_API_KEY and REND_AUTH_EMAIL_FROM are required");
  }
  if (!envString(env, "DATABASE_URL")) errors.push("DATABASE_URL is required");
  if (!envString(env, "CLICKHOUSE_URL")) errors.push("CLICKHOUSE_URL is required");
  if (!envString(env, "CLICKHOUSE_DATABASE")) errors.push("CLICKHOUSE_DATABASE is required");
  if (!envString(env, "CLICKHOUSE_USER")) errors.push("CLICKHOUSE_USER is required");
  if (!envString(env, "CLICKHOUSE_PASSWORD")) errors.push("CLICKHOUSE_PASSWORD is required");
  if (!envString(env, "REND_SITE_INTERNAL_TOKEN")) errors.push("REND_SITE_INTERNAL_TOKEN is required");
  const autumnKey = envString(env, "AUTUMN_SECRET_KEY");
  if (!autumnKey) errors.push("AUTUMN_SECRET_KEY is required");
  if (autumnKey && classifyAutumnKey(autumnKey) !== "live") {
    errors.push("AUTUMN_SECRET_KEY must be visibly marked as a live key");
  }
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(args.emailDomain || "").trim())) {
    errors.push("--email-domain must be a DNS domain");
  }
  const otpCodeConfigured = Boolean(String(args.otpCode || "").trim());
  const otpCommandConfigured = Boolean(String(args.otpCommand || "").trim());
  if (!otpCommandConfigured && !otpCodeConfigured) {
    errors.push("production SDK E2E requires --otp-command or --otp-code for the true self-serve OTP path");
  }
  if (otpCodeConfigured && !args.skipOtpRequest) {
    errors.push("--otp-code must be paired with --skip-otp-request to avoid requesting a newer code");
  }
  if (otpCodeConfigured && !/^\d{6}$/.test(String(args.otpCode).trim())) {
    errors.push("--otp-code must be exactly six digits");
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(args.planId || ""))) {
    errors.push("--plan-id must be a safe Autumn plan id");
  }
  return errors;
}

function outputArtifactPath(args, id) {
  if (args.artifact) return resolvePath(args.artifact);
  return path.join(LAUNCH_DIR, `production-sdk-e2e-${id}.json`);
}

async function writeArtifact(file, document) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  const launchLatest = path.join(LAUNCH_DIR, "production-sdk-e2e-latest.json");
  await mkdir(LAUNCH_DIR, { recursive: true });
  await copyFile(file, launchLatest).catch(() => undefined);
  const localLatest = path.join(path.dirname(file), "production-sdk-e2e-latest.json");
  if (localLatest !== launchLatest) await copyFile(file, localLatest).catch(() => undefined);
  return { outputPath: file, latestPath: launchLatest };
}

async function runStep(context, id, title, handler) {
  const startedAt = isoNow();
  const startedMs = Date.now();
  try {
    const data = await handler();
    const step = {
      id,
      title,
      status: "pass",
      started_at: startedAt,
      ended_at: isoNow(),
      duration_ms: Date.now() - startedMs,
      data: sanitizeArtifactData(data),
    };
    context.steps.push(step);
    console.log(`PASS ${id}`);
    return data;
  } catch (error) {
    const step = {
      id,
      title,
      status: "fail",
      started_at: startedAt,
      ended_at: isoNow(),
      duration_ms: Date.now() - startedMs,
      error: redactUnsafeText(error instanceof Error ? error.message : String(error)),
    };
    context.steps.push(step);
    console.error(`FAIL ${id}: ${step.error}`);
    throw error;
  }
}

async function runAttemptStep(context, id, title, handler) {
  const startedAt = isoNow();
  const startedMs = Date.now();
  try {
    const data = await handler();
    const step = {
      id,
      title,
      status: "pass",
      started_at: startedAt,
      ended_at: isoNow(),
      duration_ms: Date.now() - startedMs,
      data: sanitizeArtifactData(data),
    };
    context.steps.push(step);
    console.log(`PASS ${id}`);
    return { ok: true, data };
  } catch (error) {
    const message = redactUnsafeText(error instanceof Error ? error.message : String(error));
    const step = {
      id,
      title,
      status: "warn",
      started_at: startedAt,
      ended_at: isoNow(),
      duration_ms: Date.now() - startedMs,
      error: message,
    };
    context.steps.push(step);
    console.warn(`WARN ${id}: ${message}`);
    return { ok: false, error: message };
  }
}

async function createDbClient(databaseUrl) {
  const { Client } = requireFromSite("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

async function dbJson(context, sql, params = []) {
  const result = await context.db.query(sql, params);
  const row = result.rows[0];
  if (!row) throw new Error("database query did not return JSON");
  const value = Object.values(row)[0];
  if (typeof value === "string") return JSON.parse(value);
  if (value && typeof value === "object") return value;
  throw new Error("database query returned invalid JSON");
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function syntheticUserEmail(context) {
  const safeRunId = context.runId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `production-sdk-e2e+${safeRunId}@${context.args.emailDomain}`;
}

function setCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const combined = response.headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function rememberCookieHeader(context, header) {
  const [pair] = String(header || "").split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (name && value) context.cookieJar.set(name, value);
}

function rememberCookies(context, response) {
  for (const header of setCookieHeaders(response)) {
    rememberCookieHeader(context, header);
  }
}

function cookieHeader(context) {
  return [...context.cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function dashboardHeaders(context, extra = {}) {
  const cookie = cookieHeader(context);
  return {
    accept: "application/json",
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

async function fetchJson(url, init = {}) {
  const response = await fetchWithTimeout(url, init);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { body: text.slice(0, 240) };
  }
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${redactUnsafeText(JSON.stringify(data).slice(0, 500))}`);
  }
  return { response, data };
}

async function fetchOk(url, init = {}) {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${redactUnsafeText(body.slice(0, 500))}`);
  }
  return response;
}

async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...fetchInit } = init;
  const signal =
    fetchInit.signal ||
    (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined);
  try {
    return await fetch(url, { ...fetchInit, cache: "no-store", signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${new URL(url).pathname} request failed: ${redactUnsafeText(message)}`);
  }
}

async function requestSelfServeOtp(context, email) {
  let result = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await fetchJson(new URL("/api/auth/email-otp/send-verification-otp", context.siteBaseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: new URL(context.siteBaseUrl).origin,
        },
        body: JSON.stringify({
          email,
          legal_assent: "accepted",
          legal_assent_version: LEGAL_ASSENT_VERSION,
          type: "sign-in",
        }),
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/HTTP 429/.test(message) || attempt === 2) throw error;
      await sleep(65_000);
    }
  }
  if (!result) throw new Error("OTP request did not return a response");
  rememberCookies(context, result.response);
  return {
    user_email: email,
    accepted: true,
    cookie_count: context.cookieJar.size,
  };
}

function otpFromText(value) {
  const match = String(value || "").match(/\b(\d{6})\b/);
  return match ? match[1] : "";
}

function otpCodeFromArgs(context) {
  const code = String(context.args.otpCode || "").trim();
  return /^\d{6}$/.test(code) ? code : "";
}

function runOtpCommand(context, email) {
  const command = String(context.args.otpCommand || "").trim();
  if (!command) return "";
  const result = spawnSync(command, {
    cwd: repoRoot,
    encoding: "utf8",
    env: cleanCommandEnv({
      REND_PRODUCTION_SDK_E2E_EMAIL: email,
      REND_PRODUCTION_SDK_E2E_RUN_ID: context.runId,
      REND_PRODUCTION_SDK_E2E_REQUESTED_AT: new Date().toISOString(),
    }),
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.min(context.args.timeoutMs, 120_000),
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`OTP command failed: ${redactUnsafeText(result.error.message)}`);
  if (result.status !== 0) {
    throw new Error(`OTP command exited with ${result.status ?? result.signal ?? "unknown"}`);
  }
  const code = otpFromText(result.stdout);
  if (!code) throw new Error("OTP command did not print a six-digit code");
  return code;
}

function obtainSelfServeOtp(context, email) {
  const argumentCode = otpCodeFromArgs(context);
  if (argumentCode) {
    context.otpCode = argumentCode;
    return { source: "provided_code", obtained: true };
  }
  const commandCode = runOtpCommand(context, email);
  if (!commandCode) throw new Error("self-serve OTP code was not available");
  context.otpCode = commandCode;
  return { source: "otp_command", obtained: true };
}

async function signInWithOtp(context, email, otp) {
  let result = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await fetchJson(new URL("/api/auth/sign-in/email-otp", context.siteBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email, otp, name: SYNTHETIC_USER_NAME }),
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/HTTP 429/.test(message) || attempt === 2) throw error;
      await sleep(65_000);
    }
  }
  if (!result) throw new Error("OTP sign-in did not return a response");
  const { response, data } = result;
  rememberCookies(context, response);
  rememberCookieHeader(context, legalAssentCookieHeader(email, context.env));
  const userId = data?.user?.id;
  if (typeof userId !== "string" || !userId) throw new Error("OTP sign-in did not return a user id");
  context.userId = userId;
  return {
    user_id: userId,
    user_email: email,
    cookie_count: context.cookieJar.size,
  };
}

function legalAssentCookieHeader(email, env) {
  const payload = Buffer.from(
    JSON.stringify({
      at: new Date().toISOString(),
      email: String(email).trim().toLowerCase(),
      version: LEGAL_ASSENT_VERSION,
    }),
    "utf8",
  ).toString("base64url");
  const secret = envString(env, "BETTER_AUTH_SECRET") || envString(env, "AUTH_SECRET");
  if (!secret) throw new Error("BETTER_AUTH_SECRET or AUTH_SECRET is required for legal assent");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${LEGAL_ASSENT_COOKIE}=${payload}.${signature}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax; Secure`;
}

async function assertDashboardSession(context, pathName) {
  const response = await fetchOk(new URL(pathName, context.siteBaseUrl), {
    headers: dashboardHeaders(context, { accept: "text/html" }),
  });
  const finalPath = new URL(response.url).pathname;
  if (finalPath === "/login") throw new Error(`dashboard session redirected to login for ${pathName}`);
  return {
    path: pathName,
    final_path: finalPath,
    status: response.status,
  };
}

function selfServeProvisioningSql() {
  return `
SELECT json_build_object(
  'user_id', user_row.id::text,
  'user_email', user_row.email,
  'email_verified', user_row.email_verified,
  'organization_id', org.id::text,
  'organization_name', org.name,
  'organization_slug', org.slug,
  'member_count', (
    SELECT count(*)::int
    FROM rend_auth.member member_count
    WHERE member_count.user_id = user_row.id
  ),
  'billing_customer_count', (
    SELECT count(*)::int
    FROM rend.billing_customers billing_count
    WHERE billing_count.organization_id = org.id
  ),
  'billing_mode', billing.billing_mode,
  'customer_synced_at', billing.customer_synced_at::text,
  'customer_sync_error', billing.customer_sync_error
)::text
FROM rend_auth."user" user_row
JOIN rend_auth.member member_row ON member_row.user_id = user_row.id
JOIN rend_auth.organization org ON org.id = member_row.organization_id
LEFT JOIN rend.billing_customers billing ON billing.organization_id = org.id
WHERE user_row.email = $1
ORDER BY member_row.created_at ASC
LIMIT 1;
`;
}

async function createApiKeyThroughDashboard(context) {
  const { data } = await fetchJson(new URL("/api/api-keys", context.siteBaseUrl), {
    method: "POST",
    headers: dashboardHeaders(context, { "content-type": "application/json" }),
    body: JSON.stringify({
      name: `Production SDK E2E ${context.runId}`,
      scopes: ["upload", "read", "delete", "analytics"],
    }),
  });
  const rawKey = data?.secret;
  const apiKey = data?.api_key;
  if (typeof rawKey !== "string" || !rawKey.startsWith("rend_live_")) {
    throw new Error("dashboard API key creation did not return a live key");
  }
  if (!apiKey || typeof apiKey.id !== "string") {
    throw new Error("dashboard API key creation did not return an API key record");
  }
  context.rawApiKey = rawKey;
  context.apiKeyId = apiKey.id;
  return {
    api_key_id: apiKey.id,
    api_key_prefix: apiKey.prefix,
    scopes: apiKey.scopes,
  };
}

async function provisionOperatorSafeAccount(context, reason) {
  const email = context.userEmail || syntheticUserEmail(context);
  const fallbackUserId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const slug = `production-sdk-e2e-${context.runId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 80);
  const name = `Production SDK E2E ${context.runId}`;
  const userResult = await context.db.query(
    `
INSERT INTO rend_auth."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ($1::uuid, $2, $3, true, now(), now())
ON CONFLICT (email) DO UPDATE
SET email_verified = true,
    updated_at = now()
RETURNING id::text, email
`,
    [fallbackUserId, SYNTHETIC_USER_NAME, email],
  );
  const userId = userResult.rows[0]?.id;
  if (!userId) throw new Error("operator-safe account provisioning did not return a user id");
  await context.db.query(
    `
INSERT INTO rend_auth.organization (id, name, slug, metadata, created_at, updated_at)
VALUES (
  $1::uuid,
  $2,
  $3,
  $4::jsonb,
  now(),
  now()
)
ON CONFLICT (slug) DO UPDATE
SET updated_at = now()
`,
    [
      organizationId,
      name,
      slug,
      JSON.stringify({
        provisioned: "production-sdk-e2e-operator-safe",
        source: "production-sdk-e2e",
        run_id: context.runId,
        self_serve_fallback_reason: reason,
      }),
    ],
  );
  await context.db.query(
    `
INSERT INTO rend_auth.member (organization_id, user_id, role, created_at)
VALUES ($1::uuid, $2::uuid, 'owner', now())
ON CONFLICT (user_id, organization_id) DO UPDATE
SET role = 'owner'
`,
    [organizationId, userId],
  );
  await context.db.query(
    `
INSERT INTO rend.billing_customers (
  organization_id,
  autumn_customer_id,
  billing_mode,
  customer_synced_at,
  created_at,
  updated_at
)
VALUES ($1::uuid, $1, 'autumn', now(), now(), now())
ON CONFLICT (organization_id) DO UPDATE
SET autumn_customer_id = EXCLUDED.autumn_customer_id,
    billing_mode = 'autumn',
    customer_sync_error = NULL,
    updated_at = now()
`,
    [organizationId],
  );
  context.userId = userId;
  context.userEmail = email;
  context.organizationId = organizationId;
  context.organizationName = name;
  context.organizationSlug = slug;
  context.operatorSafeProvisioning = true;
  return {
    path: "operator_safe_db_fallback",
    fallback_reason: reason,
    user_id: userId,
    user_email: email,
    organization_id: organizationId,
    organization_name: name,
    organization_slug: slug,
  };
}

async function createApiKeyOperatorSafe(context) {
  const rawKey = `rend_live_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
  const prefix = rawKey.slice(0, 18);
  const result = await context.db.query(
    `
INSERT INTO rend.api_keys (organization_id, created_by_user_id, name, prefix, key_hash, scopes)
VALUES (
  $1::uuid,
  $2::uuid,
  $3,
  $4,
  $5,
  ARRAY['upload', 'read', 'delete', 'analytics']::text[]
)
RETURNING id::text, prefix, scopes
`,
    [
      context.organizationId,
      context.userId,
      `Production SDK E2E ${context.runId}`,
      prefix,
      keyHash,
    ],
  );
  const row = result.rows[0];
  if (!row?.id) throw new Error("operator-safe API key creation did not return an id");
  context.rawApiKey = rawKey;
  context.apiKeyId = row.id;
  return {
    path: "operator_safe_db_fallback",
    api_key_id: row.id,
    api_key_prefix: row.prefix,
    scopes: row.scopes,
  };
}

async function revokeApiKeyThroughDashboard(context) {
  if (!context.apiKeyId) return { attempted: false, revoked: false };
  const { data } = await fetchJson(new URL(`/api/api-keys/${context.apiKeyId}`, context.siteBaseUrl), {
    method: "DELETE",
    headers: dashboardHeaders(context),
  });
  return {
    attempted: true,
    revoked: data?.revoked === true || data?.status === "ok",
    response_status: data?.status || null,
  };
}

async function fallbackRevokeApiKeyInDb(context) {
  if (!context.apiKeyId) return { attempted: false, revoked: false };
  const result = await context.db.query(
    `
UPDATE rend.api_keys
SET revoked_at = COALESCE(revoked_at, now())
WHERE id = $1::uuid
RETURNING id
`,
    [context.apiKeyId],
  );
  return {
    attempted: true,
    revoked: result.rowCount > 0,
  };
}

async function autumnPost(context, routePath, body) {
  const response = await fetch(`${context.autumn.apiUrl}/${routePath}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${context.autumn.secretKey}`,
      "content-type": "application/json",
      "x-api-version": context.autumn.apiVersion,
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
    const message = redactUnsafeText(data.message || data.error || `HTTP ${response.status}`);
    throw new Error(`Autumn ${routePath} failed: ${message}`);
  }
  return data;
}

async function autumnAttachPlan(context, customerId, planId) {
  try {
    return await autumnPost(context, "billing.attach", {
      customer_id: customerId,
      plan_id: planId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/same as the product being attached/i.test(message)) {
      return { already_attached: true };
    }
    throw error;
  }
}

function summarizedUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return {
      protocol: url.protocol,
      host: url.host,
      path_present: Boolean(url.pathname && url.pathname !== "/"),
      query_redacted: Boolean(url.search),
    };
  } catch {
    return null;
  }
}

function firstUrlSummary(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["payment_url", "checkout_url", "url", "portal_url", "portalUrl"]) {
    const summary = summarizedUrl(value[key]);
    if (summary) return summary;
  }
  return null;
}

function tierFeatureIds(env, prefix) {
  return {
    "720p": envString(env, `REND_BILLING_FEATURE_${prefix}_720P`, `${prefix.toLowerCase()}_720p_seconds`),
    "1080p": envString(env, `REND_BILLING_FEATURE_${prefix}_1080P`, `${prefix.toLowerCase()}_1080p_seconds`),
    "2k": envString(env, `REND_BILLING_FEATURE_${prefix}_2K`, `${prefix.toLowerCase()}_2k_seconds`),
    "4k": envString(env, `REND_BILLING_FEATURE_${prefix}_4K`, `${prefix.toLowerCase()}_4k_seconds`),
  };
}

function storageTierFeatureIds(env) {
  return {
    "720p": envString(env, "REND_BILLING_FEATURE_STORAGE_720P", "storage_720p_second_months"),
    "1080p": envString(env, "REND_BILLING_FEATURE_STORAGE_1080P", "storage_1080p_second_months"),
    "2k": envString(env, "REND_BILLING_FEATURE_STORAGE_2K", "storage_2k_second_months"),
    "4k": envString(env, "REND_BILLING_FEATURE_STORAGE_4K", "storage_4k_second_months"),
  };
}

function apiHeaders(apiKey, extra = {}) {
  return {
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
    ...extra,
  };
}

async function ensureFixture(fixturePath) {
  if (existsSync(fixturePath)) {
    const fixtureStat = await stat(fixturePath);
    return { fixture_path: displayPath(fixturePath), generated: false, byte_size: fixtureStat.size };
  }
  await mkdir(path.dirname(fixturePath), { recursive: true });
  const result = spawnSync("scripts/generate-fixture-video.sh", [fixturePath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: cleanCommandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(redactUnsafeText(result.stderr || result.stdout || "fixture generation failed"));
  }
  const fixtureStat = await stat(fixturePath);
  return { fixture_path: displayPath(fixturePath), generated: true, byte_size: fixtureStat.size };
}

async function publicApiHealth(context) {
  const { data } = await fetchJson(new URL("/v1/healthz", context.apiBaseUrl));
  return {
    service: data.service || null,
    status: data.status || null,
    version: data.version || null,
    package_version: data.package_version || null,
    git_sha: data.git_sha || null,
    build_time: data.build_time || null,
    uptime_ms: data.uptime_ms ?? null,
  };
}

async function operatorBillingSync(context) {
  const url = new URL("/internal/operator/billing/delivery-sync", context.controlPlaneBaseUrl);
  const { data } = await fetchJson(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-rend-site-token": context.siteInternalToken,
      "x-rend-operator-user-id": context.userId,
      "x-rend-operator-email": context.userEmail,
    },
    body: "{}",
  });
  return data;
}

async function clickhousePost(context, query) {
  const url = new URL(context.clickhouse.url);
  url.searchParams.set("database", context.clickhouse.database);
  url.searchParams.set("query", query);
  url.searchParams.set("date_time_input_format", "best_effort");
  url.searchParams.set("output_format_json_quote_64bit_integers", "0");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${context.clickhouse.user}:${context.clickhouse.password}`).toString("base64")}`,
      "content-length": "0",
    },
    body: "",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ClickHouse returned HTTP ${response.status}: ${redactUnsafeText(text.slice(0, 500))}`);
  }
  return text;
}

function clickhouseDeliveryQuery({ organizationId, assetId, startMs, endMs }) {
  return `
SELECT
  tier AS resolution_tier,
  sum(delivered_duration_ms_value) / 1000.0 AS value
FROM (
  SELECT
    event_id,
    any(resolution_tier) AS tier,
    any(delivered_duration_ms) AS delivered_duration_ms_value
  FROM playback_events
  WHERE organization_id = toUUID('${organizationId}')
    AND asset_id = toUUID('${assetId}')
    AND observed_at >= fromUnixTimestamp64Milli(${startMs})
    AND observed_at < fromUnixTimestamp64Milli(${endMs})
    AND status_code >= 200
    AND status_code < 500
    AND delivered_duration_ms > 0
    AND resolution_tier IN ('720p', '1080p', '2k', '4k')
  GROUP BY event_id
)
GROUP BY tier
FORMAT JSONEachRow`;
}

async function deliveryUsageRows(context, assetId, startMs, endMs) {
  const text = await clickhousePost(
    context,
    clickhouseDeliveryQuery({
      organizationId: context.organizationId,
      assetId,
      startMs,
      endMs,
    }),
  );
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.resolution_tier && Number(row.value) > 0)
    .map((row) => ({
      tier: String(row.resolution_tier).toLowerCase(),
      value: Number(row.value),
    }));
}

function storageUsageSql() {
  return `
WITH bounds AS (
  SELECT $2::timestamptz AS start_at,
         $3::timestamptz AS end_at
),
usage_spans AS (
  SELECT span.organization_id,
         span.asset_id,
         span.duration_ms,
         span.resolution_tier,
         span.started_at,
         span.ended_at
  FROM rend.billing_storage_spans span
  WHERE span.organization_id = $1::uuid
    AND span.asset_id = $5::uuid

  UNION ALL

  SELECT asset.organization_id,
         asset.id AS asset_id,
         asset.duration_ms,
         asset.max_resolution_tier AS resolution_tier,
         asset.created_at AS started_at,
         asset.deleted_at AS ended_at
  FROM rend.assets asset
  WHERE asset.organization_id = $1::uuid
    AND asset.id = $5::uuid
    AND asset.duration_ms IS NOT NULL
    AND asset.duration_ms > 0
    AND asset.max_resolution_tier IN ('720p', '1080p', '2k', '4k')
    AND asset.playable_state IN ('opener_ready', 'hls_ready', 'deleted')
    AND NOT EXISTS (
      SELECT 1
      FROM rend.billing_storage_spans existing_span
      WHERE existing_span.asset_id = asset.id
    )
)
SELECT usage_spans.resolution_tier,
       COALESCE(
         SUM(
           (usage_spans.duration_ms::double precision / 1000.0)
           * GREATEST(
               0,
               EXTRACT(EPOCH FROM (
                 LEAST(COALESCE(usage_spans.ended_at, bounds.end_at), bounds.end_at)
                 - GREATEST(usage_spans.started_at, bounds.start_at)
               ))
             )
           / $4::double precision
         ),
         0
       ) AS value
FROM usage_spans
CROSS JOIN bounds
WHERE usage_spans.started_at < bounds.end_at
  AND COALESCE(usage_spans.ended_at, bounds.end_at) > bounds.start_at
GROUP BY usage_spans.resolution_tier
`;
}

async function storageUsageRows(context, assetId, startIso, endIso) {
  const result = await context.db.query(storageUsageSql(), [
    context.organizationId,
    startIso,
    endIso,
    SECONDS_PER_BILLING_MONTH,
    assetId,
  ]);
  return result.rows
    .filter((row) => row.resolution_tier && Number(row.value) > 0)
    .map((row) => ({
      tier: String(row.resolution_tier).toLowerCase(),
      value: Number(row.value),
    }));
}

async function insertUsageEvent(context, { assetId, idempotencyKey, featureId, value, source }) {
  const result = await context.db.query(
    `
INSERT INTO rend.billing_usage_events (
  organization_id,
  asset_id,
  idempotency_key,
  feature_id,
  value,
  source
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id::text
`,
    [context.organizationId, assetId, idempotencyKey, featureId, value, source],
  );
  if (result.rowCount > 0) return "inserted";
  const existing = await context.db.query("SELECT status FROM rend.billing_usage_events WHERE idempotency_key = $1", [idempotencyKey]);
  const status = existing.rows[0]?.status;
  if (status === "tracked" || status === "skipped") return "already_finalized";
  throw new Error(`billing usage event ${idempotencyKey} is already ${status || "missing"}`);
}

async function markUsageEvent(context, idempotencyKey, status, error = null) {
  await context.db.query(
    `
UPDATE rend.billing_usage_events
SET status = $2,
    error = $3,
    tracked_at = CASE WHEN $2 IN ('tracked', 'skipped') THEN now() ELSE tracked_at END
WHERE idempotency_key = $1
`,
    [idempotencyKey, status, error ? redactUnsafeText(error) : null],
  );
}

async function trackAggregatedUsage(context, usage) {
  const insertStatus = await insertUsageEvent(context, usage);
  if (insertStatus === "already_finalized") return { ...usage, status: "already_finalized" };
  try {
    await autumnPost(context, "balances.track", {
      customer_id: context.organizationId,
      feature_id: usage.featureId,
      value: usage.value,
      idempotency_key: usage.idempotencyKey,
      properties: {
        source: usage.source,
        asset_id: usage.assetId,
      },
    });
    await markUsageEvent(context, usage.idempotencyKey, "tracked");
    return { ...usage, status: "tracked" };
  } catch (error) {
    await markUsageEvent(context, usage.idempotencyKey, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function updateBillingCursor(context, kind, endIso) {
  const cursorColumn = kind === "delivery" ? "delivery_usage_cursor_at" : "storage_usage_cursor_at";
  const syncedColumn = kind === "delivery" ? "delivery_usage_synced_at" : "storage_usage_synced_at";
  const errorColumn = kind === "delivery" ? "delivery_usage_error" : "storage_usage_error";
  await context.db.query(
    `
UPDATE rend.billing_customers
SET ${cursorColumn} = GREATEST(COALESCE(${cursorColumn}, '-infinity'::timestamptz), $2::timestamptz),
    ${syncedColumn} = now(),
    ${errorColumn} = NULL
WHERE organization_id = $1::uuid
`,
    [context.organizationId, endIso],
  );
}

async function dryRunAggregatedBillingSync(context, assetId) {
  const start = new Date(context.startedAt);
  const end = new Date(Date.now() + 1_000);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const tracked = [];

  const deliveryRows = await deliveryUsageRows(context, assetId, startMs, endMs);
  for (const row of deliveryRows) {
    const featureId = context.deliveryFeatureIds[row.tier];
    if (!featureId) continue;
    tracked.push(
      await trackAggregatedUsage(context, {
        assetId,
        idempotencyKey: `production-sdk-e2e:delivery:${assetId}:${row.tier}`,
        featureId,
        value: row.value,
        source: "delivery_aggregation",
      }),
    );
  }
  if (deliveryRows.length > 0) await updateBillingCursor(context, "delivery", endIso);

  const storageRows = await storageUsageRows(context, assetId, startIso, endIso);
  for (const row of storageRows) {
    const featureId = context.storageFeatureIds[row.tier];
    if (!featureId) continue;
    tracked.push(
      await trackAggregatedUsage(context, {
        assetId,
        idempotencyKey: `production-sdk-e2e:storage:${assetId}:${row.tier}`,
        featureId,
        value: row.value,
        source: "storage_aggregation",
      }),
    );
  }
  if (storageRows.length > 0) await updateBillingCursor(context, "storage", endIso);

  return {
    mode: "sdk_e2e_aggregation_fallback",
    window: { start_at: startIso, end_at: endIso },
    tracked: tracked.map((entry) => ({
      source: entry.source,
      feature_id: entry.featureId,
      value: entry.value,
      status: entry.status,
    })),
  };
}

function usageQuery(context, assetId) {
  return `
SELECT COALESCE(json_agg(row_to_json(row_data) ORDER BY row_data.created_at DESC), '[]'::json)::text
FROM (
  SELECT source,
         feature_id,
         status,
         value,
         created_at::text,
         tracked_at::text,
         error
  FROM rend.billing_usage_events
  WHERE organization_id = ${sqlLiteral(context.organizationId)}::uuid
    AND (asset_id = ${sqlLiteral(assetId)}::uuid OR source IN ('delivery_aggregation', 'storage_aggregation'))
    AND created_at >= now() - interval '2 hours'
  ORDER BY created_at DESC
  LIMIT 100
) row_data;
`;
}

function hasTrackedUsage(events, source, positiveValue) {
  return events.some((event) => {
    if (event.source !== source || event.status !== "tracked") return false;
    return positiveValue ? Number(event.value) > 0 : Number(event.value) >= 0;
  });
}

async function waitForBillingUsage(context, assetId) {
  const deadline = Date.now() + context.args.usageTimeoutMs;
  let lastSync = null;
  let events = [];
  while (Date.now() < deadline) {
    try {
      lastSync = await operatorBillingSync(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/HTTP 404/.test(message)) throw error;
      lastSync = {
        mode: "operator_unavailable",
        error: redactUnsafeText(message),
        fallback: await dryRunAggregatedBillingSync(context, assetId),
      };
    }
    events = await dbJson(context, usageQuery(context, assetId));
    if (
      hasTrackedUsage(events, "upload_gate", false) &&
      hasTrackedUsage(events, "delivery_aggregation", true) &&
      hasTrackedUsage(events, "storage_aggregation", true)
    ) {
      return { sync: lastSync, events };
    }
    await sleep(15_000);
  }
  throw new Error(
    `billing usage did not include tracked upload_gate, delivery_aggregation, and storage_aggregation within timeout; last sync ${JSON.stringify(lastSync)}`,
  );
}

async function cleanupSessionsAndVerifications(context) {
  if (!context.userId || !context.userEmail || !context.organizationId) {
    return { attempted: false };
  }
  return dbJson(
    context,
    `
WITH sessions_deleted AS (
  DELETE FROM rend_auth.session
  WHERE user_id = ${sqlLiteral(context.userId)}::uuid
  RETURNING id
),
verifications_deleted AS (
  DELETE FROM rend_auth.verification
  WHERE identifier LIKE '%' || ${sqlLiteral(context.userEmail)}
  RETURNING id
),
asset_rows AS (
  SELECT count(*)::int AS count
  FROM rend.assets
  WHERE organization_id = ${sqlLiteral(context.organizationId)}::uuid
)
SELECT json_build_object(
  'attempted', true,
  'sessions_deleted', (SELECT count(*) FROM sessions_deleted),
  'verifications_deleted', (SELECT count(*) FROM verifications_deleted),
  'synthetic_user_retained', true,
  'synthetic_org_retained', true,
  'synthetic_customer_retained', true,
  'retention_reason', CASE
    WHEN (SELECT count FROM asset_rows) > 0 THEN 'asset history retained'
    ELSE 'safe hard-delete is intentionally manual'
  END
)::text;
`,
  );
}

function cleanCommandEnv(extra = {}) {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SHELL",
    "SystemRoot",
    "ComSpec",
    "LOCALAPPDATA",
    "APPDATA",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  const env = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || cleanCommandEnv(),
    encoding: "utf8",
    timeout: options.timeoutMs || 600_000,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(redactUnsafeText(result.error.message));
  }
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(redactUnsafeText(output || `${command} ${args.join(" ")} failed with exit ${result.status}`));
  }
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function runJsonCommand(command, args, options = {}) {
  const result = runCommand(command, args, options);
  const text = result.stdout.trim();
  if (!text) throw new Error(`${command} did not return JSON`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`failed to parse JSON from ${command}: ${redactUnsafeText(text.slice(0, 500))}`);
  }
}

async function createConsumerProject(context) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rend-production-sdk-e2e-"));
  assertOutsideRepo(tempDir);
  context.tempProjectDir = tempDir;
  const fixturePath = resolvePath(context.args.fixture);
  const tempFixturePath = path.join(tempDir, "fixture.mp4");
  await copyFile(fixturePath, tempFixturePath);

  await writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(
      {
        name: "rend-production-sdk-e2e-consumer",
        private: true,
        type: "module",
        scripts: {
          typecheck: "tsc -p tsconfig.json",
          "sdk-flow": "node dist/production-sdk-consumer.js",
          "browser-check": "node browser-check.mjs",
        },
        dependencies: {
          [PACKAGE_NAME]: "latest",
        },
        devDependencies: {
          "@types/node": "^20",
          playwright: "^1.57.0",
          typescript: "^5",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(tempDir, "tsconfig.json"), `${JSON.stringify(tsconfig(), null, 2)}\n`);
  await writeFile(path.join(tempDir, "production-sdk-consumer.ts"), consumerTsSource());
  await writeFile(path.join(tempDir, "browser-check.mjs"), browserCheckSource());

  return {
    temp_project_dir: tempDir,
    outside_monorepo: true,
    fixture_path: "fixture.mp4",
  };
}

function assertOutsideRepo(dir) {
  const relative = path.relative(repoRoot, dir);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error(`temp consumer project must be outside the monorepo: ${displayPath(dir)}`);
  }
}

function tsconfig() {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      outDir: "dist",
      skipLibCheck: false,
      forceConsistentCasingInFileNames: true,
    },
    include: ["production-sdk-consumer.ts"],
  };
}

async function installPublishedSdk(context) {
  runCommand(
    "npm",
    ["install", "--registry", NPM_REGISTRY, "--audit=false", "--fund=false"],
    {
      cwd: context.tempProjectDir,
      env: cleanCommandEnv({ npm_config_registry: NPM_REGISTRY }),
      timeoutMs: 600_000,
    },
  );
  const packageInfo = await installedPackageInfo(context.tempProjectDir);
  assertRegistryPackage(packageInfo);
  return packageInfo;
}

async function installedPackageInfo(projectDir) {
  const lock = JSON.parse(await readFile(path.join(projectDir, "package-lock.json"), "utf8"));
  const entry = lock.packages?.[`node_modules/${PACKAGE_NAME}`] || {};
  const pkg = JSON.parse(await readFile(path.join(projectDir, "node_modules", "@rend-sdk", "client", "package.json"), "utf8"));
  return {
    package_name: pkg.name,
    package_version: pkg.version,
    lockfile_version: lock.lockfileVersion,
    resolved: entry.resolved || null,
    integrity: entry.integrity || null,
    registry: NPM_REGISTRY,
    link: entry.link === true,
    installed_from_workspace: false,
  };
}

function assertRegistryPackage(packageInfo) {
  if (packageInfo.package_name !== PACKAGE_NAME) {
    throw new Error(`installed package name mismatch: ${packageInfo.package_name}`);
  }
  if (packageInfo.link) throw new Error(`${PACKAGE_NAME} was installed as a link`);
  const resolved = String(packageInfo.resolved || "");
  if (!resolved.startsWith(`${NPM_REGISTRY}/`)) {
    throw new Error(`${PACKAGE_NAME} was not resolved from ${NPM_REGISTRY}`);
  }
  if (/^(file:|link:|workspace:)/i.test(resolved)) {
    throw new Error(`${PACKAGE_NAME} resolved to a local path`);
  }
}

async function typecheckConsumer(context) {
  runCommand("npm", ["run", "typecheck", "--silent"], {
    cwd: context.tempProjectDir,
    env: cleanCommandEnv(),
    timeoutMs: 180_000,
  });
  return {
    command: "npm run typecheck --silent",
    source: "production-sdk-consumer.ts",
    output: "dist/production-sdk-consumer.js",
  };
}

async function installBrowser(context) {
  runCommand("npm", ["exec", "--", "playwright", "install", "chromium"], {
    cwd: context.tempProjectDir,
    env: cleanCommandEnv(),
    timeoutMs: 600_000,
  });
  return {
    command: "npm exec -- playwright install chromium",
    browser: "chromium",
  };
}

function consumerEnv(context, extra = {}) {
  return cleanCommandEnv({
    REND_API_KEY: context.rawApiKey,
    REND_API_BASE_URL: context.apiBaseUrl,
    REND_SITE_BASE_URL: context.siteBaseUrl,
    REND_FIXTURE_PATH: path.join(context.tempProjectDir, "fixture.mp4"),
    REND_SDK_E2E_TIMEOUT_MS: String(context.args.timeoutMs),
    REND_SDK_E2E_INTERVAL_MS: String(context.args.intervalMs),
    REND_SDK_E2E_ANALYTICS_TIMEOUT_MS: String(Math.min(context.args.usageTimeoutMs, 180_000)),
    REND_SDK_E2E_STATE_PATH: path.join(context.tempProjectDir, "sdk-state.json"),
    ...extra,
  });
}

async function runSdkConsumerPhase(context, phase, extraArgs = [], extraEnv = {}) {
  return runJsonCommand(
    "node",
    ["dist/production-sdk-consumer.js", "--phase", phase, ...extraArgs],
    {
      cwd: context.tempProjectDir,
      env: consumerEnv(context, extraEnv),
      timeoutMs: phase === "exercise" ? context.args.timeoutMs + 180_000 : 180_000,
    },
  );
}

async function runBrowserPlaybackCheck(context) {
  return runJsonCommand(
    "node",
    ["browser-check.mjs", "--asset-id", context.assetId, "--site-base-url", context.siteBaseUrl, "--timeout-ms", String(context.args.timeoutMs)],
    {
      cwd: context.tempProjectDir,
      env: cleanCommandEnv(),
      timeoutMs: context.args.timeoutMs + 60_000,
    },
  );
}

async function readConsumerStateAssetId(context) {
  if (!context.tempProjectDir) return "";
  const statePath = path.join(context.tempProjectDir, "sdk-state.json");
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return typeof state.asset_id === "string" ? state.asset_id : "";
  } catch {
    return "";
  }
}

function remainingResources(context) {
  const resources = {};
  if (context.assetId && !context.deleted) resources.asset_id = context.assetId;
  if (context.apiKeyId && !context.apiKeyRevoked) resources.api_key_id = context.apiKeyId;
  if (context.userId) resources.synthetic_user_id = context.userId;
  if (context.organizationId) {
    resources.synthetic_organization_id = context.organizationId;
    resources.autumn_customer_id = context.organizationId;
  }
  if (Object.keys(resources).length === 0) return null;
  return {
    ...resources,
    note: "synthetic user/org/customer are retained unless manual hard-delete is explicitly approved; active asset and API key entries indicate cleanup failure",
  };
}

function scanRedactionLeaks(text, file) {
  const findings = [];
  const patterns = [
    ["rend api key", /\brend_(?:live|test)_[A-Za-z0-9_-]+/],
    ["stripe secret key", /\bsk_(?:live|test)_[A-Za-z0-9_]+/],
    ["stripe webhook secret", /\bwhsec_[A-Za-z0-9_]+/],
    ["autumn secret key", /\bam_sk(?:_(?:live|test))?_[A-Za-z0-9_]+/],
    ["authorization bearer", /\bauthorization:\s*Bearer\s+(?!\[redacted\])/i],
    ["cookie header", /(?:^|\n)\s*(?:cookie|set-cookie):\s*(?!\[redacted\])/i],
    ["signed URL parameter", /[?&](?:token|signature|sig|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=[^&\s"']+/i],
    ["checkout or payment URL", /\bhttps:\/\/[^\s"']*(?:checkout|billing|payment|stripe)[^\s"']*[?&][^\s"']+/i],
    ["internal token header", /\bx-rend-(?:site|internal)-token\b/i],
    ["otp or code value", /"(?:otp|code)"\s*:\s*"(?!\[redacted\])[^"]+"/i],
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) findings.push({ file, pattern: name });
  }
  return findings;
}

async function scanArtifactForLeaks(file) {
  const text = await readFile(file, "utf8");
  return scanRedactionLeaks(text, displayPath(file));
}

function artifactPolicy() {
  return {
    redacted: true,
    npm_registry_metadata_safe: true,
    api_keys: false,
    autumn_keys: false,
    stripe_keys: false,
    cookies: false,
    otps: false,
    signed_playback_urls: false,
    internal_tokens: false,
    payment_urls: false,
  };
}

function consumerTsSource() {
  return `"use strict";

import { readFile, writeFile } from "node:fs/promises";
import { RendApiError, RendClient } from "@rend-sdk/client";
import type {
  AssetDetail,
  PlaybackAnalyticsResponse,
  PlaybackBootstrapResponse,
} from "@rend-sdk/client";

type Args = {
  assetId: string;
  phase: "exercise" | "analytics" | "cleanup";
};

function parseArgs(argv: string[]): Args {
  const args: Args = { assetId: "", phase: "exercise" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error("missing value for " + arg);
      return argv[index] || "";
    };
    if (arg === "--asset-id") args.assetId = next();
    else if (arg.startsWith("--asset-id=")) args.assetId = arg.slice("--asset-id=".length);
    else if (arg === "--phase") args.phase = next() as Args["phase"];
    else if (arg.startsWith("--phase=")) args.phase = arg.slice("--phase=".length) as Args["phase"];
    else throw new Error("unknown argument: " + arg);
  }
  if (!["exercise", "analytics", "cleanup"].includes(args.phase)) {
    throw new Error("--phase must be exercise, analytics, or cleanup");
  }
  return args;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function fail(message: string): never {
  throw new Error(message);
}

async function expectOk(url: URL, label: string) {
  const response = await fetch(url, { cache: "no-store", headers: { accept: "*/*" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    fail(label + " returned HTTP " + response.status + (body ? ": " + body.slice(0, 240) : ""));
  }
  return response;
}

function assertNoPlaybackLeaks(value: unknown) {
  const serialized = JSON.stringify(value);
  const forbidden = ["/internal/", "/operator", "x-rend-site-token", "x-rend-internal-token", "?token="];
  for (const pattern of forbidden) {
    if (serialized.includes(pattern)) fail("playback bootstrap leaked forbidden pattern: " + pattern);
  }
  if (/"playback_token"\\s*:/.test(serialized)) fail("playback bootstrap leaked playback_token");
}

function playbackSource(bootstrap: PlaybackBootstrapResponse) {
  return bootstrap.manifest_url || bootstrap.playback_url || bootstrap.opener_url || "";
}

function safePath(value: string) {
  try {
    const parsed = new URL(value, "https://rend.example");
    return parsed.pathname;
  } catch {
    return value.split("?")[0] || "";
  }
}

function summarizeAsset(asset: AssetDetail) {
  return {
    asset_id: asset.asset_id,
    source_state: asset.source_state,
    playable_state: asset.playable_state,
    artifact_count: asset.artifacts.length,
    artifacts: asset.artifacts.map((artifact) => ({
      kind: artifact.kind,
      content_type: artifact.content_type,
      byte_size: artifact.byte_size ?? null,
    })),
  };
}

async function rememberAssetId(assetId: string) {
  const statePath = process.env.REND_SDK_E2E_STATE_PATH;
  if (!statePath) return;
  await writeFile(statePath, JSON.stringify({ asset_id: assetId }, null, 2) + "\\n").catch(() => undefined);
}

async function waitForAnalytics(client: RendClient, assetId: string, timeoutMs: number, intervalMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: PlaybackAnalyticsResponse | null = null;
  while (Date.now() < deadline) {
    last = await client.getPlaybackAnalytics(assetId, { windowSeconds: 3600 });
    if (Number(last.request_count) >= 1) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail("playback analytics did not record any requests; last request_count=" + (last?.request_count ?? "missing"));
}

async function expectDeletedPlaybackUnavailable(client: RendClient, assetId: string) {
  try {
    await client.getPlaybackBootstrap(assetId);
  } catch (error) {
    if (error instanceof RendApiError && error.status === 404) return { unavailable: true, status: 404 };
    throw error;
  }
  fail("playback bootstrap still succeeded after delete");
}

async function exercise(client: RendClient) {
  const apiBaseUrl = requiredEnv("REND_API_BASE_URL");
  const siteBaseUrl = requiredEnv("REND_SITE_BASE_URL");
  const fixturePath = requiredEnv("REND_FIXTURE_PATH");
  const timeoutMs = numberEnv("REND_SDK_E2E_TIMEOUT_MS", 180_000);
  const intervalMs = numberEnv("REND_SDK_E2E_INTERVAL_MS", 2_000);
  const analyticsTimeoutMs = numberEnv("REND_SDK_E2E_ANALYTICS_TIMEOUT_MS", 120_000);
  const fixture = await readFile(fixturePath);

  const upload = await client.uploadAsset(fixture, {
    contentType: "video/mp4",
    contentLength: fixture.byteLength,
  });
  const assetId = upload.asset_id;
  if (!assetId) fail("upload response did not include asset_id");
  await rememberAssetId(assetId);

  const playable = await client.waitForPlayableAsset(assetId, { timeoutMs, intervalMs });
  const detail = await client.getAsset(assetId);
  const bootstrap = await client.getPlaybackBootstrap(assetId);
  assertNoPlaybackLeaks(bootstrap);
  const source = playbackSource(bootstrap);
  if (!source) fail("playback bootstrap did not return a source");
  const expectedPrefix = "/api/player/" + assetId + "/artifact/";
  if (!source.startsWith(expectedPrefix)) {
    fail("playback source is not a same-origin artifact path: " + safePath(source));
  }

  const artifactResponse = await expectOk(new URL(source, siteBaseUrl), "playback artifact");
  const billablePath = "/api/player/" + assetId + "/artifact/opener.mp4";
  const billableResponse = await expectOk(new URL(billablePath, siteBaseUrl), "billable opener artifact");
  const embedResponse = await expectOk(new URL("/embed/" + assetId, siteBaseUrl), "embed page");
  const watchResponse = await expectOk(new URL("/watch/" + assetId, siteBaseUrl), "watch page");
  const embedHtml = await embedResponse.text();
  if (!embedHtml.includes(assetId)) fail("embed page did not include the asset id");

  await client.recordPlayerTelemetry({
    events: [
      {
        playback_session_id: "published-sdk-e2e-" + assetId,
        asset_id: assetId,
        phase: "bootstrap_complete",
        event_time_ms: Date.now(),
        bootstrap_http_status: 200,
        selected_playback_mode: "primary",
        selected_artifact_path: "opener.mp4",
        app_version: "production-sdk-e2e",
      },
    ],
  });

  const analytics = await waitForAnalytics(client, assetId, analyticsTimeoutMs, Math.max(intervalMs, 5_000));
  return {
    status: "ok",
    phase: "exercise",
    package_runtime: "@rend-sdk/client",
    api_base_host: new URL(apiBaseUrl).host,
    site_base_host: new URL(siteBaseUrl).host,
    asset_id: assetId,
    upload: {
      byte_size: fixture.byteLength,
      source_state: upload.source_state,
      playable_state: upload.playable_state,
    },
    playable: {
      source_state: playable.source_state,
      playable_state: playable.playable_state,
    },
    detail: summarizeAsset(detail),
    playback: {
      status: bootstrap.status,
      source_path: safePath(source),
      ttl_seconds: bootstrap.ttl_seconds,
      prefetch_hint_count: bootstrap.prefetch_hints.length,
    },
    public_urls: {
      embed_status: embedResponse.status,
      watch_status: watchResponse.status,
    },
    artifact: {
      status: artifactResponse.status,
      content_type: artifactResponse.headers.get("content-type"),
      cache: artifactResponse.headers.get("x-rend-cache"),
      edge: artifactResponse.headers.get("x-rend-edge"),
    },
    billable_artifact: {
      path: billablePath,
      status: billableResponse.status,
      content_type: billableResponse.headers.get("content-type"),
      cache: billableResponse.headers.get("x-rend-cache"),
      edge: billableResponse.headers.get("x-rend-edge"),
    },
    analytics: {
      asset_id: analytics.asset_id,
      request_count: analytics.request_count,
      bytes_served: analytics.bytes_served,
      cache_status_counts: analytics.cache_status_counts,
      status_code_counts: analytics.status_code_counts,
    },
  };
}

async function analytics(client: RendClient, assetId: string) {
  if (!assetId) fail("--asset-id is required for analytics");
  const timeoutMs = numberEnv("REND_SDK_E2E_ANALYTICS_TIMEOUT_MS", 120_000);
  const intervalMs = Math.max(numberEnv("REND_SDK_E2E_INTERVAL_MS", 2_000), 5_000);
  const data = await waitForAnalytics(client, assetId, timeoutMs, intervalMs);
  return {
    status: "ok",
    phase: "analytics",
    asset_id: data.asset_id,
    request_count: data.request_count,
    bytes_served: data.bytes_served,
    cache_status_counts: data.cache_status_counts,
    status_code_counts: data.status_code_counts,
  };
}

async function cleanup(client: RendClient, assetId: string) {
  if (!assetId) fail("--asset-id is required for cleanup");
  let deleteResult;
  try {
    deleteResult = await client.deleteAsset(assetId);
  } catch (error) {
    if (error instanceof RendApiError && error.status === 404) {
      deleteResult = {
        asset_id: assetId,
        deleted: true,
        already_deleted: true,
        origin_objects_deleted: 0,
        purge_attempted: false,
      };
    } else {
      throw error;
    }
  }
  const unavailable = await expectDeletedPlaybackUnavailable(client, assetId);
  return {
    status: "ok",
    phase: "cleanup",
    asset_id: assetId,
    delete_result: deleteResult,
    playback_unavailable_after_delete: unavailable,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new RendClient({
    apiKey: requiredEnv("REND_API_KEY"),
    apiBaseUrl: requiredEnv("REND_API_BASE_URL"),
    siteBaseUrl: requiredEnv("REND_SITE_BASE_URL"),
  });
  const result =
    args.phase === "exercise"
      ? await exercise(client)
      : args.phase === "analytics"
        ? await analytics(client, args.assetId)
        : await cleanup(client, args.assetId);
  process.stdout.write(JSON.stringify(result, null, 2) + "\\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
`;
}

function browserCheckSource() {
  return `import { chromium } from "playwright";

function parseArgs(argv) {
  const args = {
    assetId: "",
    siteBaseUrl: "",
    timeoutMs: 180000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error("missing value for " + arg);
      return argv[index];
    };
    if (arg === "--asset-id") args.assetId = next();
    else if (arg.startsWith("--asset-id=")) args.assetId = arg.slice("--asset-id=".length);
    else if (arg === "--site-base-url") args.siteBaseUrl = next();
    else if (arg.startsWith("--site-base-url=")) args.siteBaseUrl = arg.slice("--site-base-url=".length);
    else if (arg === "--timeout-ms") args.timeoutMs = positiveInteger(next(), args.timeoutMs);
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), args.timeoutMs);
    else throw new Error("unknown argument: " + arg);
  }
  if (!args.assetId) throw new Error("--asset-id is required");
  if (!args.siteBaseUrl) throw new Error("--site-base-url is required");
  return args;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function safeResponse(response) {
  const url = new URL(response.url());
  return {
    status: response.status(),
    path: url.pathname,
    content_type: response.headers()["content-type"] || null,
    cache: response.headers()["x-rend-cache"] || null,
    edge: response.headers()["x-rend-edge"] || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = new URL("/embed/" + encodeURIComponent(args.assetId) + "?autoplay=1", args.siteBaseUrl).toString();
  const browser = await chromium.launch({ headless: true });
  const artifactResponses = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("response", (response) => {
      try {
        const url = new URL(response.url());
        if (url.pathname.includes("/api/player/" + args.assetId + "/artifact/")) {
          artifactResponses.push(safeResponse(response));
        }
      } catch {
        // Ignore non-URL responses.
      }
    });
    const artifactResponsePromise = page
      .waitForResponse(
        (response) => {
          try {
            const url = new URL(response.url());
            return url.pathname.includes("/api/player/" + args.assetId + "/artifact/") && response.status() < 500;
          } catch {
            return false;
          }
        },
        { timeout: args.timeoutMs },
      )
      .catch(() => null);

    await page.goto(target, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await page.waitForSelector('[data-rend-asset-id="' + args.assetId + '"]', { timeout: args.timeoutMs });
    await page.locator("video").evaluate((video) => video.play().catch(() => undefined)).catch(() => undefined);
    const artifactResponse = await artifactResponsePromise;
    if (!artifactResponse) throw new Error("browser did not fetch a playback artifact");
    await page.waitForFunction(
      (assetId) => {
        const root = document.querySelector('[data-rend-asset-id="' + assetId + '"]');
        const state = root?.getAttribute("data-rend-player-state") || "";
        const video = root?.querySelector("video");
        return ["ready", "metadata", "canplay", "playing"].includes(state) || Boolean(video && video.readyState >= 1);
      },
      args.assetId,
      { timeout: args.timeoutMs },
    );
    let state = await page.locator('[data-rend-asset-id="' + args.assetId + '"]').evaluate((root) => ({
      player_state: root.getAttribute("data-rend-player-state"),
      selected: root.getAttribute("data-rend-player-selected"),
      artifact: root.getAttribute("data-rend-player-artifact"),
      bootstrap_ms: root.getAttribute("data-rend-bootstrap-ms"),
      metadata_ms: root.getAttribute("data-rend-metadata-ms"),
      canplay_ms: root.getAttribute("data-rend-canplay-ms"),
      first_frame_ms: root.getAttribute("data-rend-first-frame-ms"),
      video_ready_state: root.querySelector("video")?.readyState ?? 0,
    }));
    let openerResponse = null;
    if (state.video_ready_state < 1) {
      const openerPath = "/api/player/" + args.assetId + "/artifact/opener.mp4";
      const openerResponsePromise = page
        .waitForResponse(
          (response) => {
            try {
              const url = new URL(response.url());
              return url.pathname === openerPath && response.status() < 500;
            } catch {
              return false;
            }
          },
          { timeout: args.timeoutMs },
        )
        .catch(() => null);
      await page.locator("video").evaluate(
        (video, input) =>
          new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => {
              cleanup();
              reject(new Error("timed out waiting for opener metadata"));
            }, input.timeoutMs);
            const cleanup = () => {
              window.clearTimeout(timeout);
              video.removeEventListener("loadedmetadata", onLoadedMetadata);
              video.removeEventListener("error", onError);
            };
            const onLoadedMetadata = () => {
              cleanup();
              resolve(true);
            };
            const onError = () => {
              cleanup();
              reject(new Error("opener video failed to load"));
            };
            video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
            video.addEventListener("error", onError, { once: true });
            video.src = input.src;
            video.load();
            video.play().catch(() => undefined);
          }),
        { src: openerPath, timeoutMs: args.timeoutMs },
      );
      const response = await openerResponsePromise;
      if (!response) throw new Error("browser did not fetch opener playback artifact");
      openerResponse = safeResponse(response);
      state = await page.locator('[data-rend-asset-id="' + args.assetId + '"]').evaluate((root) => ({
        player_state: root.getAttribute("data-rend-player-state"),
        selected: root.getAttribute("data-rend-player-selected"),
        artifact: root.getAttribute("data-rend-player-artifact"),
        bootstrap_ms: root.getAttribute("data-rend-bootstrap-ms"),
        metadata_ms: root.getAttribute("data-rend-metadata-ms"),
        canplay_ms: root.getAttribute("data-rend-canplay-ms"),
        first_frame_ms: root.getAttribute("data-rend-first-frame-ms"),
        video_ready_state: root.querySelector("video")?.readyState ?? 0,
      }));
    }
    if (state.video_ready_state < 1) throw new Error("browser video element did not load playback metadata");
    process.stdout.write(
      JSON.stringify(
        {
          status: "ok",
          browser: "chromium",
          target_path: new URL(target).pathname,
          artifact_response: safeResponse(artifactResponse),
          opener_response: openerResponse,
          artifact_response_count: artifactResponses.length,
          player: state,
        },
        null,
        2,
      ) + "\\n",
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  const id = runId();
  const startedAt = isoNow();
  const { env, file } = loadProductionEnv(args.envFile);
  const safetyErrors = validateSafety(args, env);
  const context = {
    args,
    runId: id,
    startedAt,
    steps: [],
    env,
    envFile: file,
    db: null,
    autumn: {
      secretKey: envString(env, "AUTUMN_SECRET_KEY"),
      apiUrl: envString(env, "AUTUMN_API_URL", DEFAULT_AUTUMN_API_URL).replace(/\/+$/, ""),
      apiVersion: envString(env, "AUTUMN_API_VERSION", DEFAULT_AUTUMN_API_VERSION),
    },
    apiBaseUrl: "",
    siteBaseUrl: "",
    controlPlaneBaseUrl: "",
    siteInternalToken: envString(env, "REND_SITE_INTERNAL_TOKEN"),
    clickhouse: {
      url: envString(env, "CLICKHOUSE_URL"),
      database: envString(env, "CLICKHOUSE_DATABASE", "rend"),
      user: envString(env, "CLICKHOUSE_USER", "rend"),
      password: envString(env, "CLICKHOUSE_PASSWORD"),
    },
    deliveryFeatureIds: tierFeatureIds(env, "DELIVERY"),
    storageFeatureIds: storageTierFeatureIds(env),
    rawApiKey: "",
    apiKeyId: "",
    apiKeyRevoked: false,
    cookieJar: new Map(),
    userId: "",
    userEmail: "",
    otpCode: "",
    organizationId: "",
    organizationName: "",
    organizationSlug: "",
    assetId: "",
    deleted: false,
    tempProjectDir: "",
    packageInfo: null,
    apiHealth: null,
    cleanup: {},
    operatorSafeProvisioning: false,
  };

  let status = "fail";
  let failure = null;
  if (safetyErrors.length > 0) {
    failure = safetyErrors.join("; ");
  } else {
    context.db = await createDbClient(envString(env, "DATABASE_URL"));
    context.apiBaseUrl = normalizeBaseUrl(
      args.apiBaseUrl || envString(env, "REND_PUBLIC_API_BASE_URL"),
      DEFAULT_PUBLIC_API_BASE_URL,
    );
    context.siteBaseUrl = normalizeBaseUrl(
      args.siteBaseUrl || envString(env, "REND_PUBLIC_SITE_BASE_URL") || envString(env, "BETTER_AUTH_URL"),
      DEFAULT_PUBLIC_SITE_BASE_URL,
    );
    context.controlPlaneBaseUrl = normalizeBaseUrl(
      envString(env, "REND_API_BASE_URL") || context.apiBaseUrl,
      context.apiBaseUrl,
    );
  }

  try {
    if (failure) throw new Error(failure);

    await runStep(context, "production-safety", "production safety checks", async () => ({
      env_file: displayPath(file),
      package_name: PACKAGE_NAME,
      registry: NPM_REGISTRY,
      mutation_allowed: args.allowProductionMutation,
      real_billing_acknowledged: args.acknowledgeRealBilling,
      autumn_key_mode: classifyAutumnKey(context.autumn.secretKey),
      autumn_key_fingerprint: keyFingerprint(context.autumn.secretKey),
      internal_test_plan_id: args.planId,
    }));

    await runStep(context, "public-api-health", "public API release health", async () => {
      context.apiHealth = await publicApiHealth(context);
      return context.apiHealth;
    });

    await runStep(context, "fixture", "small synthetic fixture", async () => ensureFixture(resolvePath(args.fixture)));

    await runStep(context, "consumer-project", "fresh external consumer project", async () => createConsumerProject(context));

    await runStep(context, "npm-install", "install published npm SDK", async () => {
      context.packageInfo = await installPublishedSdk(context);
      return context.packageInfo;
    });

    await runStep(context, "typescript-consumer", "TypeScript consumer compiles against published types", async () => typecheckConsumer(context));

    await runStep(context, "browser-install", "install browser runtime", async () => installBrowser(context));

    await runStep(context, "self-serve-account-email", "synthetic self-serve email", async () => {
      context.userEmail = syntheticUserEmail(context);
      return {
        user_email: context.userEmail,
        email_domain: context.args.emailDomain,
      };
    });

    if (!args.skipOtpRequest) {
      await runStep(context, "self-serve-otp-request", "public self-serve OTP request", async () =>
        requestSelfServeOtp(context, context.userEmail),
      );
    } else {
      await runStep(context, "self-serve-otp-request", "public self-serve OTP request", async () => ({
        skipped: true,
        reason: "existing OTP code supplied with --skip-otp-request",
      }));
    }

    await runStep(context, "self-serve-otp-code-source", "self-serve OTP code retrieval", async () => {
      return obtainSelfServeOtp(context, context.userEmail);
    });

    await runStep(context, "self-serve-otp-sign-in", "public email OTP sign-in", async () => {
      const result = await signInWithOtp(context, context.userEmail, context.otpCode);
      delete context.otpCode;
      return result;
    });

    await runStep(context, "self-serve-org-provision", "dashboard workspace auto-creation", async () => {
      await assertDashboardSession(context, "/dashboard/assets");
      const result = await dbJson(context, selfServeProvisioningSql(), [context.userEmail]);
      if (!result.email_verified) throw new Error("self-serve user email was not verified");
      if (result.member_count !== 1) throw new Error(`expected exactly one membership, found ${result.member_count}`);
      if (result.billing_customer_count !== 1) {
        throw new Error(`expected exactly one billing customer row, found ${result.billing_customer_count}`);
      }
      context.organizationId = result.organization_id;
      context.organizationName = result.organization_name;
      context.organizationSlug = result.organization_slug;
      return result;
    });

    await runStep(context, "autumn-customer-plan", "Autumn internal test customer and plan", async () => {
      await autumnPost(context, "customers.get_or_create", {
        customer_id: context.organizationId,
        name: context.organizationName,
        email: context.userEmail,
        metadata: { source: "rend-production-sdk-e2e", run_id: id },
      });
      const attach = await autumnAttachPlan(context, context.organizationId, args.planId);
      return {
        customer_id: context.organizationId,
        plan_id: args.planId,
        attach_url: firstUrlSummary(attach),
      };
    });

    await runStep(context, "production-api-key", "production API key creation", async () => {
      await assertDashboardSession(context, "/dashboard/billing");
      return createApiKeyThroughDashboard(context);
    });

    await runStep(context, "published-sdk-flow", "published SDK upload/read/playback/analytics", async () => {
      const result = await runSdkConsumerPhase(context, "exercise");
      context.assetId = result.asset_id;
      if (!context.assetId) throw new Error("published SDK flow did not return asset_id");
      return result;
    });

    await runStep(context, "browser-playback", "browser playback through production public edge", async () => runBrowserPlaybackCheck(context));

    await runStep(context, "published-sdk-analytics-after-browser", "published SDK analytics after browser playback", async () =>
      runSdkConsumerPhase(context, "analytics", ["--asset-id", context.assetId]),
    );

    await runStep(context, "autumn-usage", "Autumn upload/storage/delivery usage tracking", async () => waitForBillingUsage(context, context.assetId));

    await runStep(context, "published-sdk-delete", "published SDK delete and post-delete bootstrap verification", async () => {
      const result = await runSdkConsumerPhase(context, "cleanup", ["--asset-id", context.assetId]);
      context.deleted = true;
      return result;
    });

    status = "pass";
  } catch (error) {
    status = "fail";
    failure = redactUnsafeText(error instanceof Error ? error.message : String(error));
  } finally {
    delete context.otpCode;
    if (!context.assetId && context.tempProjectDir) {
      context.assetId = await readConsumerStateAssetId(context);
    }
    if (context.assetId && !context.deleted && context.rawApiKey && context.tempProjectDir) {
      const startedAtCleanup = isoNow();
      const startedMsCleanup = Date.now();
      try {
        const result = await runSdkConsumerPhase(context, "cleanup", ["--asset-id", context.assetId]);
        context.deleted = true;
        context.steps.push({
          id: "asset-cleanup",
          title: "asset cleanup through published SDK",
          status: "pass",
          started_at: startedAtCleanup,
          ended_at: isoNow(),
          duration_ms: Date.now() - startedMsCleanup,
          data: sanitizeArtifactData(result),
        });
      } catch (error) {
        context.steps.push({
          id: "asset-cleanup",
          title: "asset cleanup through published SDK",
          status: "fail",
          started_at: startedAtCleanup,
          ended_at: isoNow(),
          duration_ms: Date.now() - startedMsCleanup,
          error: redactUnsafeText(error instanceof Error ? error.message : String(error)),
        });
        status = "fail";
      }
    }

    if (context.db && context.apiKeyId) {
      try {
        const dashboard = await revokeApiKeyThroughDashboard(context);
        context.apiKeyRevoked = Boolean(dashboard.revoked);
        context.cleanup.api_key = { method: "dashboard", ...dashboard };
      } catch (error) {
        try {
          const fallback = await fallbackRevokeApiKeyInDb(context);
          context.apiKeyRevoked = Boolean(fallback.revoked);
          context.cleanup.api_key = {
            method: "db_fallback",
            dashboard_error: redactUnsafeText(error instanceof Error ? error.message : String(error)),
            ...fallback,
          };
        } catch (fallbackError) {
          context.cleanup.api_key = {
            method: "failed",
            error: redactUnsafeText(fallbackError instanceof Error ? fallbackError.message : String(fallbackError)),
          };
          status = "fail";
        }
      }
    }

    if (context.db) {
      try {
        context.cleanup.self_serve = await cleanupSessionsAndVerifications(context);
      } catch (error) {
        context.cleanup.self_serve = {
          attempted: true,
          error: redactUnsafeText(error instanceof Error ? error.message : String(error)),
        };
        status = "fail";
      }
    }

    if (context.db) await context.db.end().catch(() => undefined);
    if (context.tempProjectDir && !args.keepTemp) {
      await rm(context.tempProjectDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const output = outputArtifactPath(args, id);
  const remaining = remainingResources(context);
  const document = sanitizeArtifactData({
    schema_version: 1,
    kind: "rend-production-sdk-e2e",
    run_id: id,
    status,
    started_at: startedAt,
    ended_at: isoNow(),
    production_mutation_allowed: args.allowProductionMutation,
    real_billing_acknowledged: args.acknowledgeRealBilling,
    env_file: displayPath(file),
    public_api_base_url: context.apiBaseUrl || null,
    public_api_health: context.apiHealth,
    public_site_base_url: context.siteBaseUrl || null,
    control_plane_base_url: context.controlPlaneBaseUrl ? "[redacted-internal-url]" : null,
    npm_package: context.packageInfo,
    temp_project: {
      created_outside_monorepo: Boolean(context.tempProjectDir),
      retained: args.keepTemp,
      path: args.keepTemp && context.tempProjectDir ? context.tempProjectDir : null,
    },
    autumn: {
      api_url: context.autumn.apiUrl,
      api_version: context.autumn.apiVersion,
      key_mode: context.autumn.secretKey ? classifyAutumnKey(context.autumn.secretKey) : "missing",
      key_fingerprint: context.autumn.secretKey ? keyFingerprint(context.autumn.secretKey) : null,
    },
    self_serve_account: {
      user_id: context.userId || null,
      user_email: context.userEmail || null,
      organization_id: context.organizationId || null,
      organization_name: context.organizationName || null,
      organization_slug: context.organizationSlug || null,
      plan_id: args.planId,
      internal_test_customer: true,
      true_self_serve_otp: true,
      operator_fallback_disabled: true,
      operator_safe_fallback: context.operatorSafeProvisioning,
    },
    asset_id: context.assetId || null,
    cleanup: {
      asset_deleted: context.deleted,
      api_key_revoked: context.apiKeyRevoked,
      self_serve: context.cleanup.self_serve || null,
      api_key: context.cleanup.api_key || null,
      remaining_production_resources: remaining,
    },
    artifact_policy: artifactPolicy(),
    steps: context.steps,
    failure,
  });
  const written = await writeArtifact(output, document);
  const leaks = await scanArtifactForLeaks(written.outputPath);
  if (leaks.length > 0) {
    document.status = "fail";
    document.steps.push({
      id: "artifact-leak-scan",
      title: "artifact leak scan",
      status: "fail",
      started_at: isoNow(),
      ended_at: isoNow(),
      duration_ms: 0,
      error: `${leaks.length} leak pattern(s) found`,
      data: leaks,
    });
    await writeArtifact(output, document);
    status = "fail";
  } else {
    document.steps.push({
      id: "artifact-leak-scan",
      title: "artifact leak scan",
      status: "pass",
      started_at: isoNow(),
      ended_at: isoNow(),
      duration_ms: 0,
      data: { scanned: displayPath(written.outputPath), failures: [] },
    });
    await writeArtifact(output, document);
  }

  console.log(`Production SDK E2E ${status.toUpperCase()}`);
  console.log(`Artifact: ${displayPath(written.outputPath)}`);
  console.log(`Latest: ${displayPath(written.latestPath)}`);
  return status === "pass" ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(redactUnsafeText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
