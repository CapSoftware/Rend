#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { legalAssentCookieHeader } from "../apps/site/lib/legal-assent.ts";
import { parseEnvFile, repoRoot } from "./env-policy.mjs";

const requireFromSite = createRequire(path.join(repoRoot, "apps", "site", "package.json"));

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com/v1";
const DEFAULT_AUTUMN_API_VERSION = "2.3.0";
const DEFAULT_PUBLIC_API_BASE_URL = "https://api.rend.so";
const DEFAULT_PUBLIC_SITE_BASE_URL = "https://www.rend.so";
const DEFAULT_PLAN_ID = "pay_as_you_go";
const DEFAULT_FIXTURE_PATH = ".rend/launch/fixtures/production-dry-run.mp4";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_USAGE_TIMEOUT_MS = 240_000;
const DEFAULT_DRY_RUN_EMAIL_DOMAIN = "rend.so";
const SYNTHETIC_USER_NAME = "Rend Production Dry Run";

function usage() {
  return `Usage: bun scripts/production-dry-run.mjs --allow-production-mutation [options]

Runs the controlled public-V1 self-serve production dry run. This command
creates a fresh email-OTP user, lets the dashboard auto-create a workspace,
mutates live Rend, Autumn, and Stripe objects through Autumn, and refuses to run
without --allow-production-mutation.

Options:
  --allow-production-mutation
      Required for all live mutations.
  --acknowledge-real-charge
      Required because live Autumn usage can create chargeable billing artifacts.
  --env-file FILE
      Production env file. Defaults to .env.production.local.
  --api-base-url URL
      Public Rend API URL. Defaults to REND_PUBLIC_API_BASE_URL or https://api.rend.so.
  --site-base-url URL
      Public Rend site URL. Defaults to REND_PUBLIC_SITE_BASE_URL, BETTER_AUTH_URL, or https://www.rend.so.
  --plan-id PLAN
      Autumn plan to attach. Defaults to pay_as_you_go. The dry run enables it
      without creating billing changes.
  --fixture FILE
      Synthetic fixture path. Generated when missing.
  --email-domain DOMAIN
      Domain for the synthetic self-serve user. Defaults to
      REND_PRODUCTION_DRY_RUN_EMAIL_DOMAIN or ${DEFAULT_DRY_RUN_EMAIL_DOMAIN}.
  --timeout-ms NUMBER
      Asset playable timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --usage-timeout-ms NUMBER
      Billing usage verification timeout after playback. Defaults to ${DEFAULT_USAGE_TIMEOUT_MS}.
  --artifact FILE
      Write the dry-run artifact to FILE. Defaults under .rend/launch/.
  -h, --help
      Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    allowProductionMutation: false,
    acknowledgeRealCharge: false,
    envFile: process.env.REND_PRODUCTION_DRY_RUN_ENV_FILE || ".env.production.local",
    apiBaseUrl: process.env.REND_PUBLIC_API_BASE_URL || process.env.REND_PRODUCTION_DRY_RUN_API_BASE_URL || "",
    siteBaseUrl: process.env.REND_PUBLIC_SITE_BASE_URL || process.env.REND_PRODUCTION_DRY_RUN_SITE_BASE_URL || "",
    planId: process.env.REND_PRODUCTION_DRY_RUN_PLAN_ID || DEFAULT_PLAN_ID,
    fixture: process.env.REND_PRODUCTION_DRY_RUN_FIXTURE || DEFAULT_FIXTURE_PATH,
    emailDomain: process.env.REND_PRODUCTION_DRY_RUN_EMAIL_DOMAIN || DEFAULT_DRY_RUN_EMAIL_DOMAIN,
    artifact: process.env.REND_PRODUCTION_DRY_RUN_ARTIFACT || "",
    timeoutMs: positiveInteger(process.env.REND_PRODUCTION_DRY_RUN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    intervalMs: positiveInteger(process.env.REND_PRODUCTION_DRY_RUN_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    usageTimeoutMs: positiveInteger(process.env.REND_PRODUCTION_DRY_RUN_USAGE_TIMEOUT_MS, DEFAULT_USAGE_TIMEOUT_MS),
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
    else if (arg === "--acknowledge-real-charge") args.acknowledgeRealCharge = true;
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
    else if (arg === "--artifact") args.artifact = next();
    else if (arg.startsWith("--artifact=")) args.artifact = arg.slice("--artifact=".length);
    else if (arg === "--timeout-ms") args.timeoutMs = positiveInteger(next(), DEFAULT_TIMEOUT_MS);
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), DEFAULT_TIMEOUT_MS);
    else if (arg === "--usage-timeout-ms") args.usageTimeoutMs = positiveInteger(next(), DEFAULT_USAGE_TIMEOUT_MS);
    else if (arg.startsWith("--usage-timeout-ms=")) {
      args.usageTimeoutMs = positiveInteger(arg.slice("--usage-timeout-ms=".length), DEFAULT_USAGE_TIMEOUT_MS);
    } else if (arg === "-h" || arg === "--help") args.help = true;
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
    .replace(/\bproduction-dry-run\+[a-z0-9-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "[redacted-synthetic-email]")
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted-stripe-key]")
    .replace(/\bam_sk(?:_(?:live|test))?_[A-Za-z0-9_]+/g, "[redacted-autumn-key]")
    .replace(/\brend_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted-rend-api-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/g, "Bearer [redacted]")
    .replace(/([?&](?:token|signature|sig|secret|session|client_secret)=)[^&\s"']+/gi, "$1[redacted]")
    .slice(0, 1000);
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
  if (path.basename(resolvePath(args.envFile)) !== ".env.production.local") {
    errors.push("production dry run must load its live key from .env.production.local");
  }
  if (envString(env, "REND_ENV").toLowerCase() !== "production") {
    errors.push("production dry run requires REND_ENV=production");
  }
  if (envString(env, "REND_BILLING_MODE").toLowerCase() !== "autumn") {
    errors.push("production dry run requires REND_BILLING_MODE=autumn");
  }
  if (!truthy(envString(env, "REND_SELF_SERVE_SIGNUP_ENABLED"))) {
    errors.push("production dry run requires REND_SELF_SERVE_SIGNUP_ENABLED=true");
  }
  if (truthy(envString(env, "REND_AUTH_EMAIL_DISABLED"))) {
    errors.push("production dry run requires REND_AUTH_EMAIL_DISABLED=false");
  }
  if (!envString(env, "BETTER_AUTH_SECRET") && !envString(env, "AUTH_SECRET")) {
    errors.push("BETTER_AUTH_SECRET is required");
  }
  if (!envString(env, "BETTER_AUTH_URL") && !envString(env, "REND_AUTH_BASE_URL")) {
    errors.push("BETTER_AUTH_URL or REND_AUTH_BASE_URL is required");
  }
  if (!envString(env, "RESEND_API_KEY") || !envString(env, "REND_AUTH_EMAIL_FROM")) {
    errors.push("RESEND_API_KEY and REND_AUTH_EMAIL_FROM are required");
  }
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(args.emailDomain || "").trim())) {
    errors.push("--email-domain must be a DNS domain");
  }
  const autumnKey = envString(env, "AUTUMN_SECRET_KEY");
  if (!autumnKey) errors.push("AUTUMN_SECRET_KEY is required");
  if (autumnKey && classifyAutumnKey(autumnKey) !== "live") {
    errors.push("AUTUMN_SECRET_KEY must be visibly marked as a live key");
  }
  if (!envString(env, "DATABASE_URL")) errors.push("DATABASE_URL is required");
  if (!envString(env, "REND_SITE_INTERNAL_TOKEN")) errors.push("REND_SITE_INTERNAL_TOKEN is required");
  if (!args.acknowledgeRealCharge) {
    errors.push("--acknowledge-real-charge is required because the production dry run can create live billing artifacts");
  }
  return errors;
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

function normalizePublicSiteBaseUrl(value) {
  const normalized = normalizeBaseUrl(value, DEFAULT_PUBLIC_SITE_BASE_URL);
  const parsed = new URL(normalized);
  if (parsed.hostname === "rend.so") parsed.hostname = "www.rend.so";
  return parsed.toString().replace(/\/+$/, "");
}

function artifactPath(args, id) {
  if (args.artifact) return resolvePath(args.artifact);
  return path.join(repoRoot, ".rend", "launch", `production-dry-run-${id}.json`);
}

async function writeArtifact(file, document) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  const latest = path.join(path.dirname(file), "production-dry-run-latest.json");
  await copyFile(file, latest).catch(() => undefined);
  return { outputPath: file, latestPath: latest };
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

function sanitizeArtifactData(value) {
  if (typeof value === "string") return redactUnsafeText(value);
  if (Array.isArray(value)) return value.map(sanitizeArtifactData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeArtifactData(entry)]));
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
  return `production-dry-run+${safeRunId}@${context.args.emailDomain}`;
}

async function createServerSideOtp(context, email) {
  const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const identifier = `sign-in-otp-${email.toLowerCase()}`;
  const storedOtp = crypto.createHash("sha256").update(otp, "utf8").digest("base64url");
  await context.db.query("DELETE FROM rend_auth.verification WHERE identifier = $1", [identifier]);
  await context.db.query(
    `
INSERT INTO rend_auth.verification (identifier, value, expires_at, created_at, updated_at)
VALUES ($1, $2, now() + interval '5 minutes', now(), now())
`,
    [identifier, `${storedOtp}:0`],
  );
  return otp;
}

function setCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const combined = response.headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function rememberCookie(context, header) {
  const [pair] = header.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (name && value) context.cookieJar.set(name, value);
}

function rememberCookies(context, response) {
  for (const header of setCookieHeaders(response)) rememberCookie(context, header);
}

function cookieHeader(context) {
  return [...context.cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function responseCookieHeader(response) {
  return setCookieHeaders(response)
    .map((header) => header.split(";", 1)[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

function dashboardHeaders(context, extra = {}) {
  const cookie = cookieHeader(context);
  return {
    accept: "application/json",
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

async function signInWithOtp(context, email, otp) {
  const { response, data } = await fetchJson(new URL("/api/auth/sign-in/email-otp", context.siteBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, otp, name: SYNTHETIC_USER_NAME }),
  });
  rememberCookies(context, response);
  // The dry run creates its OTP server-side so it must reproduce the signed
  // legal-assent cookie that the public OTP request route normally sets.
  rememberCookie(context, legalAssentCookieHeader(email, new Date(), context.env));
  const userId = data?.user?.id;
  if (typeof userId !== "string" || !userId) throw new Error("OTP sign-in did not return a user id");
  context.userId = userId;
  return {
    user_id: userId,
    user_email: email,
    cookie_count: context.cookieJar.size,
  };
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
      name: `Production dry run ${context.runId}`,
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
      redirect_mode: "never",
      no_billing_changes: true,
      enable_plan_immediately: true,
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

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, cache: "no-store" });
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
  const response = await fetch(url, { ...init, cache: "no-store" });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${redactUnsafeText(body.slice(0, 500))}`);
  }
  return response;
}

function apiHeaders(apiKey, extra = {}) {
  return {
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
    ...extra,
  };
}

function multipartFixtureParts(fixture, partSize, partCount) {
  const parts = [];
  for (let offset = 0, partNumber = 1; offset < fixture.byteLength; offset += partSize, partNumber += 1) {
    const bytes = fixture.subarray(offset, Math.min(offset + partSize, fixture.byteLength));
    parts.push({
      part_number: partNumber,
      checksum_sha256: crypto.createHash("sha256").update(bytes).digest("base64"),
      bytes,
    });
  }
  if (parts.length !== partCount) {
    throw new Error(`multipart upload expected ${partCount} parts, calculated ${parts.length}`);
  }
  return parts;
}

async function uploadMultipartFixture(context, fixture, filename) {
  const { data: session } = await fetchJson(new URL("/v1/uploads", context.apiBaseUrl), {
    method: "POST",
    headers: apiHeaders(context.rawApiKey, {
      "content-type": "application/json",
      "idempotency-key": `production-dry-run:${context.runId}`,
    }),
    body: JSON.stringify({
      content_type: "video/mp4",
      content_length: fixture.byteLength,
      filename,
    }),
  });
  context.assetId = session.asset_id;
  const uploadId = session.upload_id;
  const partSize = Number(session.part_size);
  const partCount = Number(session.part_count);
  const maxParallelParts = Number(session.max_parallel_parts);
  if (
    !context.assetId ||
    !uploadId ||
    !Number.isSafeInteger(partSize) ||
    partSize <= 0 ||
    !Number.isSafeInteger(partCount) ||
    partCount <= 0 ||
    !Number.isSafeInteger(maxParallelParts) ||
    maxParallelParts <= 0
  ) {
    throw new Error("multipart create returned an invalid upload session");
  }
  const parts = multipartFixtureParts(fixture, partSize, partCount);
  const signedParts = [];
  for (let offset = 0; offset < parts.length; offset += 10) {
    const batch = parts.slice(offset, offset + 10);
    const { data } = await fetchJson(new URL(`/v1/uploads/${encodeURIComponent(uploadId)}/parts`, context.apiBaseUrl), {
      method: "POST",
      headers: apiHeaders(context.rawApiKey, { "content-type": "application/json" }),
      body: JSON.stringify({
        parts: batch.map(({ part_number, checksum_sha256 }) => ({ part_number, checksum_sha256 })),
      }),
    });
    signedParts.push(...(Array.isArray(data.parts) ? data.parts : []));
  }
  const signedByNumber = new Map(signedParts.map((part) => [part.part_number, part]));
  const completedParts = [];
  for (let offset = 0; offset < parts.length; offset += maxParallelParts) {
    const batch = parts.slice(offset, offset + maxParallelParts);
    const uploaded = await Promise.all(
      batch.map(async (part) => {
        const signed = signedByNumber.get(part.part_number);
        if (!signed?.url || signed.method !== "PUT") {
          throw new Error(`multipart signing omitted part ${part.part_number}`);
        }
        const response = await fetchOk(new URL(signed.url), {
          method: "PUT",
          headers: signed.headers,
          body: part.bytes,
          redirect: "error",
        });
        const etag = response.headers.get("etag");
        if (!etag) throw new Error(`multipart part ${part.part_number} omitted ETag`);
        return { part_number: part.part_number, etag, checksum_sha256: part.checksum_sha256 };
      }),
    );
    completedParts.push(...uploaded);
  }
  const { data: completed } = await fetchJson(
    new URL(`/v1/uploads/${encodeURIComponent(uploadId)}/complete`, context.apiBaseUrl),
    {
      method: "POST",
      headers: apiHeaders(context.rawApiKey, { "content-type": "application/json" }),
      body: JSON.stringify({
        parts: completedParts.sort((left, right) => left.part_number - right.part_number),
      }),
    },
  );
  return completed;
}

async function ensureFixture(fixturePath) {
  if (existsSync(fixturePath)) return { fixture_path: displayPath(fixturePath), generated: false };
  const result = spawnSync("scripts/generate-fixture-video.sh", [fixturePath], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(redactUnsafeText(result.stderr || result.stdout || "fixture generation failed"));
  }
  return { fixture_path: displayPath(fixturePath), generated: true };
}

async function waitForPlayable(context, assetId) {
  const deadline = Date.now() + context.args.timeoutMs;
  let lastState = "";
  while (Date.now() < deadline) {
    const { data } = await fetchJson(new URL(`/v1/assets/${assetId}`, context.apiBaseUrl), {
      headers: apiHeaders(context.rawApiKey),
    });
    lastState = String(data.playable_state || "");
    if (lastState === "opener_ready" || lastState === "hls_ready") return data;
    if (lastState === "failed" || lastState === "deleted") {
      throw new Error(`asset reached terminal state ${lastState}`);
    }
    await sleep(context.args.intervalMs);
  }
  throw new Error(`timed out waiting for playable asset; last state ${lastState || "unknown"}`);
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

function playbackSource(bootstrap) {
  return bootstrap.manifest_url || bootstrap.playback_url || bootstrap.opener_url;
}

function isPlaybackArtifactUrl(value, assetId, siteBaseUrl) {
  let url;
  try {
    url = new URL(value, siteBaseUrl);
  } catch {
    return false;
  }
  const site = new URL(siteBaseUrl);
  if (url.origin === site.origin && url.pathname.startsWith(`/api/player/${assetId}/artifact/`)) {
    return true;
  }
  const host = url.hostname.toLowerCase();
  return (
    (host === "rend.so" || host.endsWith(".rend.so") || host === "localhost" || host === "127.0.0.1") &&
    url.pathname.startsWith(`/v/${assetId}/`)
  );
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
      if (!/HTTP (?:403|404)/.test(message)) throw error;
      lastSync = {
        mode: "event_driven",
        error: redactUnsafeText(message),
      };
    }
    events = await dbJson(context, usageQuery(context, assetId));
    if (
      hasTrackedUsage(events, "delivery_aggregation", true) &&
      hasTrackedUsage(events, "storage_aggregation", true)
    ) {
      return { sync: lastSync, events };
    }
    await sleep(15_000);
  }
  throw new Error(
    `billing usage did not include tracked delivery_aggregation and storage_aggregation within timeout; last sync ${JSON.stringify(lastSync)}`,
  );
}

function cleanupQueries({ apiKeyId, userId, userEmail, organizationId }) {
  return `
WITH revoked AS (
  UPDATE rend.api_keys
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE id = ${sqlLiteral(apiKeyId)}::uuid
  RETURNING id
),
sessions_deleted AS (
  DELETE FROM rend_auth.session
  WHERE user_id = ${sqlLiteral(userId)}::uuid
  RETURNING id
),
verifications_deleted AS (
  DELETE FROM rend_auth.verification
  WHERE identifier LIKE '%' || ${sqlLiteral(userEmail)}
  RETURNING id
),
asset_rows AS (
  SELECT count(*)::int AS count
  FROM rend.assets
  WHERE organization_id = ${sqlLiteral(organizationId)}::uuid
)
SELECT json_build_object(
  'api_key_revoked', EXISTS (SELECT 1 FROM revoked),
  'sessions_deleted', (SELECT count(*) FROM sessions_deleted),
  'verifications_deleted', (SELECT count(*) FROM verifications_deleted),
  'synthetic_user_retained', true,
  'synthetic_org_retained', true,
  'retention_reason', CASE
    WHEN (SELECT count FROM asset_rows) > 0 THEN 'asset history retained'
    ELSE 'safe hard-delete is intentionally manual'
  END
)::text;
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
    storageFeatureId: envString(env, "REND_BILLING_FEATURE_STORAGE", "storage_second_months"),
    rawApiKey: "",
    apiKeyId: "",
    cookieJar: new Map(),
    userId: "",
    userEmail: "",
    organizationId: "",
    organizationName: "",
    organizationSlug: "",
    assetId: "",
    deleted: false,
    apiHealth: null,
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
    context.siteBaseUrl = normalizePublicSiteBaseUrl(
      args.siteBaseUrl || envString(env, "REND_PUBLIC_SITE_BASE_URL") || envString(env, "BETTER_AUTH_URL"),
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
      autumn_key_mode: classifyAutumnKey(context.autumn.secretKey),
      autumn_key_fingerprint: keyFingerprint(context.autumn.secretKey),
      plan_id: args.planId,
      simulated_billing: true,
      real_charge_acknowledged: args.acknowledgeRealCharge,
    }));

    await runStep(context, "public-api-health", "public API release health", async () => {
      context.apiHealth = await publicApiHealth(context);
      return context.apiHealth;
    });

    await runStep(context, "fixture", "synthetic fixture", async () => {
      const fixturePath = resolvePath(args.fixture);
      return ensureFixture(fixturePath);
    });

    await runStep(context, "self-serve-otp-create", "server-side OTP for self-serve sign-in", async () => {
      context.userEmail = syntheticUserEmail(context);
      context.otp = await createServerSideOtp(context, context.userEmail);
      return {
        user_email: context.userEmail,
        otp_created: true,
      };
    });

    await runStep(context, "self-serve-otp-sign-in", "public email OTP sign-in", async () => {
      const result = await signInWithOtp(context, context.userEmail, context.otp);
      delete context.otp;
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

    await runStep(context, "autumn-customer-plan", "Autumn customer and plan attach", async () => {
      await autumnPost(context, "customers.get_or_create", {
        customer_id: context.organizationId,
        name: context.organizationName,
        email: context.userEmail,
        metadata: { source: "rend-production-dry-run", run_id: id },
      });
      const attach = await autumnAttachPlan(context, context.organizationId, args.planId);
      return {
        customer_id: context.organizationId,
        plan_id: args.planId,
        checkout_portal_applicable: false,
        simulated_billing: true,
        checkout_url: firstUrlSummary(attach),
        portal_url: null,
      };
    });

    await runStep(context, "dashboard-api-key", "dashboard API key creation after billing readiness", async () => {
      await assertDashboardSession(context, "/dashboard/billing");
      return createApiKeyThroughDashboard(context);
    });

    await runStep(context, "upload", "public multipart API upload", async () => {
      const fixture = await readFile(resolvePath(args.fixture));
      const data = await uploadMultipartFixture(context, fixture, path.basename(resolvePath(args.fixture)));
      if (!context.assetId) throw new Error("upload response did not include asset_id");
      return {
        asset_id: context.assetId,
        byte_size: fixture.byteLength,
        upload_transport: "direct_multipart",
        source_state: data.source_state,
        playable_state: data.playable_state,
      };
    });

    await runStep(context, "upload-billing-check", "Autumn storage balance check", async () => {
      const data = await autumnPost(context, "balances.check", {
        customer_id: context.organizationId,
        feature_id: context.storageFeatureId,
        required_balance: 0,
        send_event: false,
        properties: { source: "production_dry_run", asset_id: context.assetId },
      });
      if (data.allowed !== true) throw new Error("Autumn storage balance check was not allowed");
      return { allowed: true, feature_id: context.storageFeatureId };
    });

    await runStep(context, "playable", "wait for playable asset", async () => {
      const asset = await waitForPlayable(context, context.assetId);
      return {
        asset_id: asset.asset_id,
        source_state: asset.source_state,
        playable_state: asset.playable_state,
        artifact_count: Array.isArray(asset.artifacts) ? asset.artifacts.length : undefined,
      };
    });

    await runStep(context, "public-playback", "public embed/watch playback through edge", async () => {
      const { response: bootstrapResponse, data: bootstrap } = await fetchJson(
        new URL(`/api/player/${context.assetId}`, context.siteBaseUrl),
      );
      const source = playbackSource(bootstrap);
      if (!source || typeof source !== "string" || !isPlaybackArtifactUrl(source, context.assetId, context.siteBaseUrl)) {
        throw new Error("player bootstrap did not return a safe artifact source");
      }
      const playbackCookie = responseCookieHeader(bootstrapResponse);
      if (!playbackCookie) throw new Error("player bootstrap did not return a playback cookie");
      const artifact = await fetchOk(new URL(source, context.siteBaseUrl), {
        headers: { accept: "*/*", cookie: playbackCookie },
      });
      const billableArtifactPath = source;
      const billableArtifact = artifact;
      const embed = await fetchOk(new URL(`/embed/${context.assetId}`, context.siteBaseUrl));
      const watch = await fetchOk(new URL(`/watch/${context.assetId}`, context.siteBaseUrl));
      return {
        bootstrap_status: bootstrap.status,
        playback_source_path: new URL(source, context.siteBaseUrl).pathname,
        artifact_status: artifact.status,
        artifact_content_type: artifact.headers.get("content-type"),
        artifact_cache: artifact.headers.get("x-rend-cache"),
        artifact_edge: artifact.headers.get("x-rend-edge"),
        billable_artifact_path: billableArtifactPath,
        billable_artifact_status: billableArtifact.status,
        billable_artifact_content_type: billableArtifact.headers.get("content-type"),
        billable_artifact_cache: billableArtifact.headers.get("x-rend-cache"),
        billable_artifact_edge: billableArtifact.headers.get("x-rend-edge"),
        embed_status: embed.status,
        watch_status: watch.status,
      };
    });

    await runStep(context, "player-telemetry", "player telemetry endpoint", async () => {
      const playbackSessionId = `prod-dry-run-${id}`;
      const { data } = await fetchJson(new URL("/api/player/telemetry", context.siteBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          events: [
            {
              event_id: `prod-dry-run-bootstrap-${id}`,
              organization_id: context.organizationId,
              playback_session_id: playbackSessionId,
              asset_id: context.assetId,
              phase: "bootstrap_complete",
              event_time_ms: Date.now(),
              bootstrap_http_status: 200,
              selected_playback_mode: "primary",
              selected_artifact_path: "opener.mp4",
              selected_width: 640,
              selected_height: 360,
              app_version: "production-dry-run",
            },
            {
              event_id: `prod-dry-run-watch-${id}`,
              organization_id: context.organizationId,
              playback_session_id: playbackSessionId,
              asset_id: context.assetId,
              phase: "watch_heartbeat",
              event_time_ms: Date.now(),
              watch_delta_ms: 4_000,
              selected_playback_mode: "primary",
              selected_artifact_path: "opener.mp4",
              selected_width: 640,
              selected_height: 360,
              app_version: "production-dry-run",
            },
          ],
        }),
      });
      return data;
    });

    await runStep(context, "billing-usage-track", "Autumn storage and delivery usage track verification", async () => {
      return waitForBillingUsage(context, context.assetId);
    });

    await runStep(context, "playback-analytics", "durable player analytics", async () => {
      const { data } = await fetchJson(new URL("/v1/analytics/overview?window_seconds=3600", context.apiBaseUrl), {
        headers: apiHeaders(context.rawApiKey),
      });
      const watchTimeMs = Number(data.watch_time_ms);
      const asset = Array.isArray(data.top_assets)
        ? data.top_assets.find((entry) => entry?.asset_id === context.assetId)
        : null;
      if (watchTimeMs < 4_000 || Number(asset?.watch_time_ms) < 4_000) {
        throw new Error("player analytics did not record the synthetic watch time");
      }
      return {
        asset_id: context.assetId,
        views: data.views,
        sessions: data.sessions,
        watch_time_ms: data.watch_time_ms,
        asset_watch_time_ms: asset.watch_time_ms,
        request_count: data.request_count,
        bytes_served: data.bytes_served,
      };
    });

    await runStep(context, "delete", "delete synthetic asset", async () => {
      const { data } = await fetchJson(new URL(`/v1/assets/${context.assetId}`, context.apiBaseUrl), {
        method: "DELETE",
        headers: apiHeaders(context.rawApiKey),
      });
      if (!data.deleted) throw new Error("delete response did not confirm deletion");
      context.deleted = true;
      return data;
    });

    await runStep(context, "cleanup-verification", "cleanup verification", async () => {
      let apiDeleted = false;
      try {
        await fetchJson(new URL(`/v1/assets/${context.assetId}`, context.apiBaseUrl), {
          headers: apiHeaders(context.rawApiKey),
        });
      } catch {
        apiDeleted = true;
      }
      let playbackDeleted = false;
      try {
        await fetchJson(new URL(`/api/player/${context.assetId}`, context.siteBaseUrl));
      } catch {
        playbackDeleted = true;
      }
      if (!apiDeleted || !playbackDeleted) throw new Error("asset remained visible after delete");
      return { api_deleted: apiDeleted, playback_deleted: playbackDeleted };
    });

    status = "pass";
  } catch (error) {
    status = "fail";
    failure = redactUnsafeText(error instanceof Error ? error.message : String(error));
  } finally {
    if (context.assetId && !context.deleted && context.rawApiKey) {
      const startedAtCleanup = isoNow();
      const startedMsCleanup = Date.now();
      try {
        const { data } = await fetchJson(new URL(`/v1/assets/${context.assetId}`, context.apiBaseUrl), {
          method: "DELETE",
          headers: apiHeaders(context.rawApiKey),
        });
        context.deleted = Boolean(data.deleted);
        context.steps.push({
          id: "asset-cleanup",
          title: "asset cleanup",
          status: "pass",
          started_at: startedAtCleanup,
          ended_at: isoNow(),
          duration_ms: Date.now() - startedMsCleanup,
          data: { asset_id: context.assetId, deleted: context.deleted },
        });
      } catch (error) {
        context.steps.push({
          id: "asset-cleanup",
          title: "asset cleanup",
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
        const cleanup = await dbJson(
          context,
          cleanupQueries({
            apiKeyId: context.apiKeyId,
            userId: context.userId,
            userEmail: context.userEmail,
            organizationId: context.organizationId,
          }),
        );
        context.steps.push({
          id: "self-serve-cleanup",
          title: "self-serve cleanup",
          status: "pass",
          started_at: isoNow(),
          ended_at: isoNow(),
          duration_ms: 0,
          data: cleanup,
        });
      } catch (error) {
        context.steps.push({
          id: "self-serve-cleanup",
          title: "self-serve cleanup",
          status: "fail",
          started_at: isoNow(),
          ended_at: isoNow(),
          duration_ms: 0,
          error: redactUnsafeText(error instanceof Error ? error.message : String(error)),
        });
        status = "fail";
      }
    }
    if (context.db) {
      await context.db.end().catch(() => undefined);
    }
  }

  const output = artifactPath(args, id);
  const document = sanitizeArtifactData({
    schema_version: 1,
    kind: "rend-production-dry-run",
    run_id: id,
    status,
    started_at: startedAt,
    ended_at: isoNow(),
    production_mutation_allowed: args.allowProductionMutation,
    real_charge_acknowledged: args.acknowledgeRealCharge,
    env_file: displayPath(file),
    public_api_base_url: context.apiBaseUrl || null,
    public_api_health: context.apiHealth,
    public_site_base_url: context.siteBaseUrl || null,
    control_plane_base_url: context.controlPlaneBaseUrl ? "[redacted-internal-url]" : null,
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
      simulated_billing: true,
    },
    asset_id: context.assetId || null,
    artifact_policy: {
      redacted: true,
      autumn_keys: false,
      stripe_keys: false,
      api_keys: false,
      otps: false,
      synthetic_emails: false,
      checkout_session_secrets: false,
      cookies: false,
      signed_playback_urls: false,
      internal_tokens: false,
    },
    steps: context.steps,
    failure,
  });
  const written = await writeArtifact(output, document);
  console.log(`Production dry run ${status.toUpperCase()}`);
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
