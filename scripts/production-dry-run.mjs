#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnvFile, repoRoot } from "./env-policy.mjs";

const requireFromSite = createRequire(path.join(repoRoot, "apps", "site", "package.json"));

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com/v1";
const DEFAULT_AUTUMN_API_VERSION = "2.3.0";
const DEFAULT_PUBLIC_API_BASE_URL = "https://api.rend.so";
const DEFAULT_PUBLIC_SITE_BASE_URL = "https://rend.so";
const DEFAULT_PLAN_ID = "pay_as_you_go";
const DEFAULT_INTERNAL_TEST_PLAN_ID = "internal_production_dry_run";
const DEFAULT_FIXTURE_PATH = ".rend/launch/fixtures/production-dry-run.mp4";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_USAGE_TIMEOUT_MS = 240_000;
const INTERNAL_ORG_ID = "00000000-0000-4000-8000-000000000039";
const INTERNAL_USER_ID = "00000000-0000-4000-8000-000000000040";
const INTERNAL_ORG_NAME = "Rend Internal Production Dry Run";
const INTERNAL_ORG_SLUG = "rend-internal-production-dry-run";
const INTERNAL_USER_EMAIL = "internal-production-dry-run@rend.so";
const INTERNAL_USER_NAME = "Rend Production Dry Run";
const SECONDS_PER_BILLING_MONTH = 30 * 24 * 60 * 60;

function usage() {
  return `Usage: bun scripts/production-dry-run.mjs --allow-production-mutation [options]

Runs the controlled public-V1 production dry run. This command mutates live
Rend, Autumn, and Stripe objects through Autumn, so it refuses to run without
--allow-production-mutation.

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
      Public Rend site URL. Defaults to REND_PUBLIC_SITE_BASE_URL, BETTER_AUTH_URL, or https://rend.so.
  --plan-id PLAN
      Autumn plan to attach. Defaults to pay_as_you_go. For no-checkout
      verification, use the explicit internal test plan ${DEFAULT_INTERNAL_TEST_PLAN_ID}.
  --fixture FILE
      Synthetic fixture path. Generated when missing.
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
  const autumnKey = envString(env, "AUTUMN_SECRET_KEY");
  if (!autumnKey) errors.push("AUTUMN_SECRET_KEY is required");
  if (autumnKey && classifyAutumnKey(autumnKey) !== "live") {
    errors.push("AUTUMN_SECRET_KEY must be visibly marked as a live key");
  }
  if (!envString(env, "DATABASE_URL")) errors.push("DATABASE_URL is required");
  if (!envString(env, "CLICKHOUSE_URL")) errors.push("CLICKHOUSE_URL is required");
  if (!envString(env, "CLICKHOUSE_DATABASE")) errors.push("CLICKHOUSE_DATABASE is required");
  if (!envString(env, "CLICKHOUSE_USER")) errors.push("CLICKHOUSE_USER is required");
  if (!envString(env, "CLICKHOUSE_PASSWORD")) errors.push("CLICKHOUSE_PASSWORD is required");
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

async function dbJson(context, sql) {
  const result = await context.db.query(sql);
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

function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function generateApiKey() {
  return `rend_live_${crypto.randomBytes(32).toString("base64url")}`;
}

function seedSql({ apiKeyHash, apiKeyPrefix, runIdValue }) {
  return `
WITH upsert_user AS (
  INSERT INTO rend_auth."user" (id, name, email, email_verified, created_at, updated_at)
  VALUES (
    ${sqlLiteral(INTERNAL_USER_ID)}::uuid,
    ${sqlLiteral(INTERNAL_USER_NAME)},
    ${sqlLiteral(INTERNAL_USER_EMAIL)},
    true,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      email = EXCLUDED.email,
      email_verified = true,
      updated_at = now()
  RETURNING id
),
upsert_org AS (
  INSERT INTO rend_auth.organization (id, name, slug, metadata, created_at, updated_at)
  VALUES (
    ${sqlLiteral(INTERNAL_ORG_ID)}::uuid,
    ${sqlLiteral(INTERNAL_ORG_NAME)},
    ${sqlLiteral(INTERNAL_ORG_SLUG)},
    jsonb_build_object('source', 'rend-production-dry-run', 'run_id', ${sqlLiteral(runIdValue)}),
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      metadata = EXCLUDED.metadata,
      updated_at = now()
  RETURNING id
),
upsert_member AS (
  INSERT INTO rend_auth.member (organization_id, user_id, role, created_at)
  VALUES (${sqlLiteral(INTERNAL_ORG_ID)}::uuid, ${sqlLiteral(INTERNAL_USER_ID)}::uuid, 'owner', now())
  ON CONFLICT (user_id, organization_id) DO UPDATE
  SET role = 'owner'
  RETURNING id
),
upsert_billing AS (
  INSERT INTO rend.billing_customers (
    organization_id,
    autumn_customer_id,
    billing_mode,
    customer_synced_at,
    customer_sync_error
  )
  VALUES (${sqlLiteral(INTERNAL_ORG_ID)}::uuid, ${sqlLiteral(INTERNAL_ORG_ID)}, 'autumn', now(), NULL)
  ON CONFLICT (organization_id) DO UPDATE
  SET autumn_customer_id = EXCLUDED.autumn_customer_id,
      billing_mode = 'autumn',
      customer_synced_at = now(),
      customer_sync_error = NULL
  RETURNING organization_id
),
api_key AS (
  INSERT INTO rend.api_keys (organization_id, created_by_user_id, name, prefix, key_hash, scopes)
  VALUES (
    ${sqlLiteral(INTERNAL_ORG_ID)}::uuid,
    ${sqlLiteral(INTERNAL_USER_ID)}::uuid,
    ${sqlLiteral(`Production dry run ${runIdValue}`)},
    ${sqlLiteral(apiKeyPrefix)},
    ${sqlLiteral(apiKeyHash)},
    ARRAY['upload', 'read', 'delete', 'analytics']::text[]
  )
  ON CONFLICT (key_hash) DO UPDATE
  SET revoked_at = NULL,
      scopes = EXCLUDED.scopes,
      last_used_update_after = NULL
  RETURNING id, prefix
)
SELECT json_build_object(
  'organization_id', ${sqlLiteral(INTERNAL_ORG_ID)},
  'organization_name', ${sqlLiteral(INTERNAL_ORG_NAME)},
  'user_id', ${sqlLiteral(INTERNAL_USER_ID)},
  'user_email', ${sqlLiteral(INTERNAL_USER_EMAIL)},
  'api_key_id', (SELECT id::text FROM api_key),
  'api_key_prefix', (SELECT prefix FROM api_key)
)::text;
`;
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

function isInternalTestPlan(context) {
  return context.args.planId === context.internalTestPlanId;
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

async function operatorBillingSync(context) {
  const url = new URL("/internal/operator/billing/delivery-sync", context.controlPlaneBaseUrl);
  const { data } = await fetchJson(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-rend-site-token": context.siteInternalToken,
      "x-rend-operator-user-id": INTERNAL_USER_ID,
      "x-rend-operator-email": INTERNAL_USER_EMAIL,
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
      organizationId: INTERNAL_ORG_ID,
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
    INTERNAL_ORG_ID,
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
    [INTERNAL_ORG_ID, assetId, idempotencyKey, featureId, value, source],
  );
  if (result.rowCount > 0) return "inserted";
  const existing = await context.db.query(
    "SELECT status FROM rend.billing_usage_events WHERE idempotency_key = $1",
    [idempotencyKey],
  );
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
      customer_id: INTERNAL_ORG_ID,
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
    [INTERNAL_ORG_ID, endIso],
  );
}

async function dryRunAggregatedBillingSync(context, assetId) {
  const start = new Date(context.startedAt);
  const end = new Date(Date.now() + 1000);
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
        idempotencyKey: `production-dry-run:delivery:${assetId}:${row.tier}`,
        featureId,
        value: row.value,
        source: "delivery_aggregation",
      }),
    );
  }
  if (deliveryRows.length > 0) {
    await updateBillingCursor(context, "delivery", endIso);
  }

  const storageRows = await storageUsageRows(context, assetId, startIso, endIso);
  for (const row of storageRows) {
    const featureId = context.storageFeatureIds[row.tier];
    if (!featureId) continue;
    tracked.push(
      await trackAggregatedUsage(context, {
        assetId,
        idempotencyKey: `production-dry-run:storage:${assetId}:${row.tier}`,
        featureId,
        value: row.value,
        source: "storage_aggregation",
      }),
    );
  }
  if (storageRows.length > 0) {
    await updateBillingCursor(context, "storage", endIso);
  }

  return {
    mode: "dry_run_aggregation_fallback",
    window: { start_at: startIso, end_at: endIso },
    tracked: tracked.map((entry) => ({
      source: entry.source,
      feature_id: entry.featureId,
      value: entry.value,
      status: entry.status,
    })),
  };
}

function usageQuery(assetId) {
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
  WHERE organization_id = ${sqlLiteral(INTERNAL_ORG_ID)}::uuid
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
    events = await dbJson(context, usageQuery(assetId));
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

function cleanupQueries({ apiKeyId }) {
  return `
WITH revoked AS (
  UPDATE rend.api_keys
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE id = ${sqlLiteral(apiKeyId)}::uuid
  RETURNING id
)
SELECT json_build_object('api_key_revoked', EXISTS (SELECT 1 FROM revoked))::text;
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
    internalTestPlanId: envString(env, "REND_AUTUMN_INTERNAL_DRY_RUN_PLAN_ID", DEFAULT_INTERNAL_TEST_PLAN_ID),
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
      autumn_key_mode: classifyAutumnKey(context.autumn.secretKey),
      autumn_key_fingerprint: keyFingerprint(context.autumn.secretKey),
      plan_id: args.planId,
      internal_test_plan: isInternalTestPlan(context),
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

    const seeded = await runStep(context, "rend-customer-api-key", "internal Rend org and API key", async () => {
      context.rawApiKey = generateApiKey();
      const result = await dbJson(
        context,
        seedSql({
          apiKeyHash: hashApiKey(context.rawApiKey),
          apiKeyPrefix: context.rawApiKey.slice(0, 18),
          runIdValue: id,
        }),
      );
      context.apiKeyId = result.api_key_id;
      return result;
    });

    await runStep(context, "autumn-customer-plan", "Autumn customer and plan attach", async () => {
      await autumnPost(context, "customers.get_or_create", {
        customer_id: INTERNAL_ORG_ID,
        name: INTERNAL_ORG_NAME,
        email: INTERNAL_USER_EMAIL,
        metadata: { source: "rend-production-dry-run", run_id: id },
      });
      const attach = await autumnAttachPlan(context, INTERNAL_ORG_ID, args.planId);
      const portal = isInternalTestPlan(context)
        ? null
        : await autumnPost(context, `customers/${encodeURIComponent(INTERNAL_ORG_ID)}/billing_portal`, {
            return_url: `${context.siteBaseUrl}/dashboard/billing`,
          });
      return {
        customer_id: INTERNAL_ORG_ID,
        plan_id: args.planId,
        checkout_portal_applicable: !isInternalTestPlan(context),
        checkout_url: firstUrlSummary(attach),
        portal_url: firstUrlSummary(portal),
      };
    });

    await runStep(context, "upload", "public API upload", async () => {
      const fixture = await readFile(resolvePath(args.fixture));
      const { data } = await fetchJson(new URL("/v1/videos", context.apiBaseUrl), {
        method: "POST",
        headers: apiHeaders(context.rawApiKey, {
          "content-type": "video/mp4",
          "content-length": String(fixture.byteLength),
        }),
        body: fixture,
      });
      context.assetId = data.asset_id;
      if (!context.assetId) throw new Error("upload response did not include asset_id");
      return {
        asset_id: context.assetId,
        byte_size: fixture.byteLength,
        source_state: data.source_state,
        playable_state: data.playable_state,
      };
    });

    await runStep(context, "upload-billing-check", "Autumn upload check verification", async () => {
      const events = await dbJson(context, usageQuery(context.assetId));
      if (!hasTrackedUsage(events, "upload_gate", false)) {
        throw new Error("upload_gate billing check was not tracked");
      }
      return { billing_usage_events: events.filter((event) => event.source === "upload_gate") };
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
      const { data: bootstrap } = await fetchJson(new URL(`/api/player/${context.assetId}`, context.siteBaseUrl));
      const source = playbackSource(bootstrap);
      if (!source || typeof source !== "string" || !source.startsWith(`/api/player/${context.assetId}/artifact/`)) {
        throw new Error("player bootstrap did not return a same-origin artifact source");
      }
      const artifact = await fetchOk(new URL(source, context.siteBaseUrl), {
        headers: { accept: "*/*" },
      });
      const billableArtifactPath = `/api/player/${context.assetId}/artifact/opener.mp4`;
      const billableArtifact = await fetchOk(new URL(billableArtifactPath, context.siteBaseUrl), {
        headers: { accept: "*/*" },
      });
      const embed = await fetchOk(new URL(`/embed/${context.assetId}`, context.siteBaseUrl));
      const watch = await fetchOk(new URL(`/watch/${context.assetId}`, context.siteBaseUrl));
      return {
        bootstrap_status: bootstrap.status,
        playback_source_path: source.split("?")[0],
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
              playback_session_id: playbackSessionId,
              asset_id: context.assetId,
              phase: "bootstrap_complete",
              event_time_ms: Date.now(),
              bootstrap_http_status: 200,
              selected_playback_mode: "primary",
              selected_artifact_path: "opener.mp4",
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

    await runStep(context, "playback-analytics", "public playback analytics", async () => {
      const { data } = await fetchJson(new URL(`/v1/assets/${context.assetId}/analytics/playback?window_seconds=3600`, context.apiBaseUrl), {
        headers: apiHeaders(context.rawApiKey),
      });
      if (Number(data.request_count) < 1) throw new Error("playback analytics did not record any requests");
      return {
        asset_id: data.asset_id,
        request_count: data.request_count,
        bytes_served: data.bytes_served,
        cache_status_counts: data.cache_status_counts,
        status_code_counts: data.status_code_counts,
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
        const cleanup = await dbJson(context, cleanupQueries({ apiKeyId: context.apiKeyId }));
        context.steps.push({
          id: "api-key-cleanup",
          title: "API key cleanup",
          status: "pass",
          started_at: isoNow(),
          ended_at: isoNow(),
          duration_ms: 0,
          data: cleanup,
        });
      } catch (error) {
        context.steps.push({
          id: "api-key-cleanup",
          title: "API key cleanup",
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
    internal_customer: {
      organization_id: INTERNAL_ORG_ID,
      organization_name: INTERNAL_ORG_NAME,
      user_email: INTERNAL_USER_EMAIL,
      plan_id: args.planId,
      internal_test_plan: args.planId === context.internalTestPlanId,
    },
    asset_id: context.assetId || null,
    artifact_policy: {
      redacted: true,
      autumn_keys: false,
      stripe_keys: false,
      api_keys: false,
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
