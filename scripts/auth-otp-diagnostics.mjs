#!/usr/bin/env node

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  loadProfileEnv,
  repoRoot,
  validateEnvironment,
} from "./env-policy.mjs";

const requireFromSite = createRequire(path.join(repoRoot, "apps", "site", "package.json"));
const LAUNCH_DIR = path.join(repoRoot, ".rend", "launch");
const LEGAL_ASSENT_VERSION = "2026-06-15";
const DEFAULT_TIMEOUT_MS = 20_000;
const LOCAL_AUTH_SECRET = "local-better-auth-secret-only-for-rend-development";

function usage() {
  return `Usage: node scripts/auth-otp-diagnostics.mjs [options]

Runs safe production self-serve email OTP diagnostics and writes a redacted
artifact. The default mode is non-mutating. Passing --probe-email sends one real
OTP request through the configured public auth route to that test inbox.

Options:
  --env-file FILE
      Production env file. Defaults to .env.production.local when present.
  --artifact FILE
      Write the artifact to FILE. Defaults under .rend/launch/.
  --site-base-url URL
      Public site URL used for the optional route probe. Defaults to
      REND_PUBLIC_SITE_BASE_URL, BETTER_AUTH_URL, REND_AUTH_BASE_URL, or https://rend.so.
  --probe-email EMAIL
      Explicitly send one OTP request to this test email through /api/auth.
      Can also be set with REND_AUTH_OTP_PROBE_EMAIL.
  --require-probe
      Fail if no probe email is configured or if the probe is not accepted.
  --timeout-ms NUMBER
      HTTP and database diagnostic timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --allow-placeholders
      Permit placeholder values in env validation. Use only for examples.
  -h, --help
      Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    envFile: process.env.REND_AUTH_OTP_DIAGNOSTICS_ENV_FILE || "",
    artifact: process.env.REND_AUTH_OTP_DIAGNOSTICS_ARTIFACT || "",
    siteBaseUrl: process.env.REND_AUTH_OTP_DIAGNOSTICS_SITE_BASE_URL || "",
    probeEmail: process.env.REND_AUTH_OTP_PROBE_EMAIL || "",
    requireProbe: truthy(process.env.REND_AUTH_OTP_REQUIRE_PROBE),
    timeoutMs: positiveInteger(process.env.REND_AUTH_OTP_DIAGNOSTICS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    allowPlaceholders: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--env-file") args.envFile = next();
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice("--env-file=".length);
    else if (arg === "--artifact") args.artifact = next();
    else if (arg.startsWith("--artifact=")) args.artifact = arg.slice("--artifact=".length);
    else if (arg === "--site-base-url") args.siteBaseUrl = next();
    else if (arg.startsWith("--site-base-url=")) args.siteBaseUrl = arg.slice("--site-base-url=".length);
    else if (arg === "--probe-email") args.probeEmail = next();
    else if (arg.startsWith("--probe-email=")) args.probeEmail = arg.slice("--probe-email=".length);
    else if (arg === "--require-probe") args.requireProbe = true;
    else if (arg === "--timeout-ms") args.timeoutMs = positiveInteger(next(), DEFAULT_TIMEOUT_MS);
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), DEFAULT_TIMEOUT_MS);
    else if (arg === "--allow-placeholders") args.allowPlaceholders = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.envFile && existsSync(path.join(repoRoot, ".env.production.local"))) {
    args.envFile = ".env.production.local";
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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function emailSummary(value) {
  const email = normalizeEmail(value);
  if (!email) return { email_present: false };
  const at = email.lastIndexOf("@");
  return {
    email_present: true,
    email_domain: at >= 0 ? email.slice(at + 1) : "invalid",
    email_hash: crypto.createHash("sha256").update(email, "utf8").digest("hex").slice(0, 16),
  };
}

function redactUnsafeText(value) {
  return String(value ?? "")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]")
    .replace(/\bre_[A-Za-z0-9_=-]{8,}/g, "[redacted-resend-key]")
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted-stripe-key]")
    .replace(/\bwhsec_[A-Za-z0-9_]+/g, "[redacted-stripe-webhook-secret]")
    .replace(/\bam_sk(?:_(?:live|test))?_[A-Za-z0-9_]+/g, "[redacted-autumn-key]")
    .replace(/\brend_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted-rend-api-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [redacted]")
    .replace(/((?:^|\n)\s*(?:cookie|set-cookie|authorization):\s*)[^\n\r]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|signature|sig|secret|session|client_secret|code|otp)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/"otp"\s*:\s*"[^"]+"/gi, '"otp":"[redacted]"')
    .replace(/"code"\s*:\s*"[^"]+"/gi, '"code":"[redacted]"')
    .slice(0, 2000);
}

function sanitizeArtifactData(value) {
  if (typeof value === "string") return redactUnsafeText(value);
  if (Array.isArray(value)) return value.map(sanitizeArtifactData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeArtifactData(entry)]));
}

function responseSummary(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload;
  return {
    message: typeof record.message === "string" ? record.message : null,
    error: typeof record.error === "string" ? record.error : null,
    status: typeof record.status === "string" ? record.status : null,
  };
}

function outputArtifactPath(args, id) {
  if (args.artifact) return resolvePath(args.artifact);
  return path.join(LAUNCH_DIR, `auth-otp-diagnostics-${id}.json`);
}

async function writeArtifact(file, document) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  await mkdir(LAUNCH_DIR, { recursive: true });
  const latest = path.join(LAUNCH_DIR, "auth-otp-diagnostics-latest.json");
  await copyFile(file, latest).catch(() => undefined);
  const localLatest = path.join(path.dirname(file), "auth-otp-diagnostics-latest.json");
  if (localLatest !== latest) await copyFile(file, localLatest).catch(() => undefined);
  return { outputPath: file, latestPath: latest };
}

function step(id, title, status, summary, data = {}) {
  return { id, title, status, summary, data: sanitizeArtifactData(data) };
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

function urlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function isLocalUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "0.0.0.0" || host === "::1" || host.startsWith("127.");
  } catch {
    return true;
  }
}

function configuredTrustedOrigins(env, authBaseUrl, siteBaseUrl) {
  const origins = new Set(
    envString(env, "REND_AUTH_TRUSTED_ORIGINS")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const authOrigin = urlOrigin(authBaseUrl);
  const siteOrigin = urlOrigin(siteBaseUrl);
  if (authOrigin) origins.add(authOrigin);
  if (siteOrigin) origins.add(siteOrigin);
  return [...origins];
}

async function configStep(args, loaded) {
  const env = loaded.env;
  const errors = [];
  const warnings = [];
  const envResult = validateEnvironment({
    profile: "production",
    env,
    files: args.envFile
      ? [resolvePath(args.envFile)]
      : [path.join(repoRoot, ".env.production"), path.join(repoRoot, ".env.production.local")],
    allowPlaceholders: args.allowPlaceholders,
  });
  errors.push(...envResult.errors);

  const authBaseUrl = envString(env, "BETTER_AUTH_URL") || envString(env, "REND_AUTH_BASE_URL");
  const siteBaseUrl = args.siteBaseUrl || envString(env, "REND_PUBLIC_SITE_BASE_URL") || authBaseUrl || "https://rend.so";
  const authOrigin = urlOrigin(authBaseUrl);
  const siteOrigin = urlOrigin(siteBaseUrl);
  const trustedOrigins = configuredTrustedOrigins(env, authBaseUrl, siteBaseUrl);

  if (!authBaseUrl) errors.push("BETTER_AUTH_URL or REND_AUTH_BASE_URL is required");
  if (authBaseUrl && isLocalUrl(authBaseUrl)) errors.push("auth base URL must not be local in production");
  if (authBaseUrl && !authBaseUrl.startsWith("https://")) errors.push("auth base URL must use https");
  if (authOrigin && !trustedOrigins.includes(authOrigin)) errors.push("trusted origins must include auth base origin");
  if (siteOrigin && !trustedOrigins.includes(siteOrigin)) errors.push("trusted origins must include public site origin");

  const secret = envString(env, "BETTER_AUTH_SECRET") || envString(env, "AUTH_SECRET");
  if (!secret || secret === LOCAL_AUTH_SECRET) errors.push("production Better Auth secret is missing or local-only");
  if (!envString(env, "RESEND_API_KEY")) errors.push("RESEND_API_KEY is required");
  if (!envString(env, "REND_AUTH_EMAIL_FROM")) errors.push("REND_AUTH_EMAIL_FROM is required");
  if (truthy(envString(env, "REND_AUTH_EMAIL_DISABLED"))) errors.push("REND_AUTH_EMAIL_DISABLED must be false");
  if (!truthy(envString(env, "REND_SELF_SERVE_SIGNUP_ENABLED"))) {
    errors.push("REND_SELF_SERVE_SIGNUP_ENABLED must be true");
  }
  if (!envString(env, "REND_AUTH_TRUSTED_ORIGINS")) {
    warnings.push("REND_AUTH_TRUSTED_ORIGINS is not set; app runtime will add auth/public site origins automatically");
  }

  return step(
    "otp-config",
    "production OTP auth configuration",
    errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
    errors.length > 0
      ? `${errors.length} config error(s)`
      : warnings.length > 0
        ? `${warnings.length} config warning(s)`
        : "production OTP auth configuration passed",
    {
      env_file: args.envFile ? displayPath(resolvePath(args.envFile)) : null,
      loaded_files: loaded.loadedFiles.map(displayPath),
      auth_base_host: authBaseUrl ? new URL(authBaseUrl).host : null,
      public_site_host: siteBaseUrl ? new URL(siteBaseUrl).host : null,
      checks: {
        self_serve_signup_enabled: truthy(envString(env, "REND_SELF_SERVE_SIGNUP_ENABLED")),
        auth_email_enabled: !truthy(envString(env, "REND_AUTH_EMAIL_DISABLED")),
        better_auth_secret_configured: Boolean(secret && secret !== LOCAL_AUTH_SECRET),
        resend_configured: Boolean(envString(env, "RESEND_API_KEY") && envString(env, "REND_AUTH_EMAIL_FROM")),
        auth_base_url_https: Boolean(authBaseUrl && authBaseUrl.startsWith("https://") && !isLocalUrl(authBaseUrl)),
        trusted_origin_count: trustedOrigins.length,
      },
      errors,
      warnings,
    },
  );
}

async function dbStep(args, env) {
  const databaseUrl = envString(env, "DATABASE_URL");
  if (!databaseUrl) {
    return step("otp-db", "auth database tables", "fail", "DATABASE_URL is required", {
      checked: false,
      errors: ["DATABASE_URL is required"],
    });
  }

  const { Client } = requireFromSite("pg");
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: args.timeoutMs,
    query_timeout: args.timeoutMs,
  });
  try {
    await client.connect();
    const result = await client.query(`
SELECT json_build_object(
  'user', to_regclass('rend_auth."user"') IS NOT NULL,
  'session', to_regclass('rend_auth.session') IS NOT NULL,
  'verification', to_regclass('rend_auth.verification') IS NOT NULL,
  'rate_limit', to_regclass('rend_auth.rate_limit') IS NOT NULL,
  'organization', to_regclass('rend_auth.organization') IS NOT NULL,
  'member', to_regclass('rend_auth.member') IS NOT NULL,
  'session_token_index', EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'rend_auth' AND indexname = 'session_token_uidx'
  ),
  'verification_identifier_index', EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'rend_auth' AND indexname = 'verification_identifier_idx'
  ),
  'verification_expires_index', EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'rend_auth' AND indexname = 'verification_expires_at_idx'
  )
)::text AS checks;
`);
    const checks = JSON.parse(result.rows[0]?.checks || "{}");
    const errors = Object.entries(checks)
      .filter(([, present]) => present !== true)
      .map(([name]) => `${name} missing`);
    return step(
      "otp-db",
      "auth database tables",
      errors.length > 0 ? "fail" : "pass",
      errors.length > 0 ? `${errors.length} DB auth table/index error(s)` : "auth DB tables and indexes passed",
      { checks, errors },
    );
  } catch (error) {
    return step("otp-db", "auth database tables", "fail", "auth DB diagnostics failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  return fetch(url, { ...init, cache: "no-store", signal });
}

async function otpProbeStep(args, env) {
  const probeEmail = normalizeEmail(args.probeEmail);
  if (!probeEmail) {
    return step(
      "otp-send-probe",
      "explicit OTP send probe",
      args.requireProbe ? "fail" : "pass",
      args.requireProbe
        ? "REND_AUTH_OTP_PROBE_EMAIL or --probe-email is required"
        : "probe email not configured; send probe skipped",
      { required: args.requireProbe, skipped: true },
    );
  }

  const siteBaseUrl = normalizeBaseUrl(
    args.siteBaseUrl || envString(env, "REND_PUBLIC_SITE_BASE_URL") || envString(env, "BETTER_AUTH_URL") || envString(env, "REND_AUTH_BASE_URL"),
    "https://rend.so",
  );
  const url = new URL("/api/auth/email-otp/send-verification-otp", siteBaseUrl);
  const startedMs = Date.now();
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: new URL(siteBaseUrl).origin,
        },
        body: JSON.stringify({
          email: probeEmail,
          legal_assent: "accepted",
          legal_assent_version: LEGAL_ASSENT_VERSION,
          type: "sign-in",
        }),
      },
      args.timeoutMs,
    );
    const text = await response.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { body: text.slice(0, 240) };
    }
    const accepted = response.ok;
    return step(
      "otp-send-probe",
      "explicit OTP send probe",
      accepted ? "pass" : "fail",
      accepted ? "OTP send probe accepted by auth route" : `OTP send probe returned HTTP ${response.status}`,
      {
        required: args.requireProbe,
        accepted,
        status: response.status,
        duration_ms: Date.now() - startedMs,
        site_host: new URL(siteBaseUrl).host,
        probe_email: emailSummary(probeEmail),
        response: responseSummary(payload),
      },
    );
  } catch (error) {
    return step("otp-send-probe", "explicit OTP send probe", "fail", "OTP send probe failed", {
      required: args.requireProbe,
      duration_ms: Date.now() - startedMs,
      site_host: new URL(siteBaseUrl).host,
      probe_email: emailSummary(probeEmail),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function overallStatus(steps) {
  return steps.some((entry) => entry.status === "fail")
    ? "fail"
    : steps.some((entry) => entry.status === "warn")
      ? "warn"
      : "pass";
}

function artifactPolicy() {
  return {
    redacted: true,
    secrets: false,
    otps: false,
    api_keys: false,
    cookies: false,
    auth_headers: false,
    internal_tokens: false,
  };
}

function scanRedactionLeaks(text, file) {
  const findings = [];
  const patterns = [
    ["resend key", /\bre_[A-Za-z0-9_=-]{8,}/],
    ["rend api key", /\brend_(?:live|test)_[A-Za-z0-9_-]+/],
    ["stripe secret key", /\bsk_(?:live|test)_[A-Za-z0-9_]+/],
    ["autumn secret key", /\bam_sk(?:_(?:live|test))?_[A-Za-z0-9_]+/],
    ["authorization bearer", /\bauthorization:\s*Bearer\s+(?!\[redacted\])/i],
    ["cookie header", /(?:^|\n)\s*(?:cookie|set-cookie):\s*(?!\[redacted\])/i],
    ["otp value", /"(?:otp|code)"\s*:\s*"(?!\[redacted\])[^"]+"/i],
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  const id = runId();
  const startedAt = isoNow();
  const loaded = loadProfileEnv({
    profile: "production",
    envFile: args.envFile,
    appRoot: repoRoot,
    cwd: repoRoot,
  });
  const steps = [
    await configStep(args, loaded),
    await dbStep(args, loaded.env),
    await otpProbeStep(args, loaded.env),
  ];
  let status = overallStatus(steps);
  const output = outputArtifactPath(args, id);
  const document = sanitizeArtifactData({
    schema_version: 1,
    kind: "rend-auth-otp-diagnostics",
    run_id: id,
    status,
    started_at: startedAt,
    ended_at: isoNow(),
    env_file: args.envFile ? displayPath(resolvePath(args.envFile)) : null,
    otp_probe: {
      required: args.requireProbe,
      configured: Boolean(normalizeEmail(args.probeEmail)),
      accepted: steps.find((entry) => entry.id === "otp-send-probe")?.data?.accepted === true,
    },
    artifact_policy: artifactPolicy(),
    steps,
  });
  const written = await writeArtifact(output, document);
  const leaks = await scanArtifactForLeaks(written.outputPath);
  if (leaks.length > 0) {
    status = "fail";
    document.status = "fail";
    document.steps.push(
      step("artifact-leak-scan", "artifact leak scan", "fail", `${leaks.length} leak pattern(s) found`, {
        failures: leaks,
      }),
    );
    await writeArtifact(output, document);
  } else {
    document.steps.push(
      step("artifact-leak-scan", "artifact leak scan", "pass", "artifact leak scan passed", {
        scanned: displayPath(written.outputPath),
        failures: [],
      }),
    );
    await writeArtifact(output, document);
  }

  console.log(`Auth OTP diagnostics ${status.toUpperCase()}`);
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
