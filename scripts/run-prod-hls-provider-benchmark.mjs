#!/usr/bin/env node

import { Daytona } from "@daytona/sdk";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const requireFromSite = createRequire(
  path.join(repoRoot, "apps", "site", "package.json"),
);
const runId = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "Z");
const localOutDir = path.join(
  repoRoot,
  ".rend",
  "benchmarks",
  "providers",
  `prod-hls-providers-${runId}`,
);
const publicOutDir = path.join(
  repoRoot,
  "apps",
  "site",
  "public",
  "benchmarks",
  "providers",
);
const defaultVideoPath = "/Users/richie/Downloads/mezzanine.mp4";
const defaultMuxUrl =
  "https://player.mux.com/A6oZoUWVZjOIVZB6XnBMLagYnXE6xhDhp8Hcyky018hk";
const defaultProdEnvPath = "/Users/richie/.rend/production/rend-api.env";
const defaultAutumnApiUrl = "https://api.useautumn.com/v1";
const defaultAutumnApiVersion = "2.3.0";
const defaultBillingPlanId = "pay_as_you_go";
const emptyPayloadHash = sha256Hex(Buffer.alloc(0));

let redactionValues = [];

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function printHelp() {
  console.log(`Run a production Daytona HLS benchmark comparing Rend, Mux, and Rend-generated HLS served directly from Tigris.

Usage:
  node scripts/run-prod-hls-provider-benchmark.mjs --video /Users/richie/Downloads/mezzanine.mp4
  node scripts/run-prod-hls-provider-benchmark.mjs --samples 5

Defaults:
  Rend baseline: source uploaded through Rend production, waited until hls_ready, then played through /watch/{asset_id}?autoplay=1.
  Rend Tigris-only baseline: the same Rend-generated HLS master, variant playlists, and segments served directly from Tigris object storage.
  Mux baseline: the benchmark-page Mux player URL unless --mux-url overrides it.
  Cleanup: deletes the production test Rend asset after the run.

Options:
  --video PATH                 Video file to upload. Defaults to ${defaultVideoPath}
  --mux-url URL                Mux player URL. Defaults to ${defaultMuxUrl}
  --samples N                  Samples per provider. Defaults to 5.
  --watch-ms N                 Watch window per sample. Defaults to 30000.
  --delay-ms N                 Delay between samples. Defaults to 3000.
  --startup-timeout-ms N       Startup timeout per sample. Defaults to 45000.
  --target-candidates CSV      Daytona targets to try. Defaults to us.
  --api-base-url URL           Override Rend API base URL. Defaults to https://api.rend.so.
  --plan-id ID                 Autumn plan for auto-provisioned benchmark orgs. Defaults to ${defaultInternalTestPlanId}.
  --keep-asset                 Do not delete the production Rend test asset after the run.
  --public-copy                Also update apps/site/public/benchmarks/providers/latest*.json.
  --dry-run                    Validate env/options without uploading, creating a sandbox, or writing benchmark artifacts.
`);
}

function parseArgs(argv) {
  const keepAsset = envValue(
    "REND_HLS_PROVIDER_KEEP_ASSET",
    "REND_TIGRIS_EDGE_KEEP_ASSET",
  );
  const publicCopy = envValue(
    "REND_HLS_PROVIDER_PUBLIC_COPY",
    "REND_TIGRIS_EDGE_PUBLIC_COPY",
  );
  const options = {
    videoPath:
      envValue("REND_HLS_PROVIDER_VIDEO", "REND_TIGRIS_EDGE_VIDEO") ||
      defaultVideoPath,
    muxUrl:
      envValue(
        "REND_HLS_PROVIDER_MUX_URL",
        "REND_TIGRIS_EDGE_MUX_URL",
        "BENCHMARK_MUX_URL",
      ) || defaultMuxUrl,
    samples: Number(
      envValue("REND_HLS_PROVIDER_SAMPLES", "REND_TIGRIS_EDGE_SAMPLES") || 5,
    ),
    watchMs: Number(
      envValue("REND_HLS_PROVIDER_WATCH_MS", "REND_TIGRIS_EDGE_WATCH_MS") ||
        30_000,
    ),
    delayMs: Number(
      envValue("REND_HLS_PROVIDER_DELAY_MS", "REND_TIGRIS_EDGE_DELAY_MS") ||
        3_000,
    ),
    startupTimeoutMs: Number(
      envValue(
        "REND_HLS_PROVIDER_STARTUP_TIMEOUT_MS",
        "REND_TIGRIS_EDGE_STARTUP_TIMEOUT_MS",
      ) || 45_000,
    ),
    targetCandidates: (process.env.DAYTONA_TARGET_CANDIDATES || "us")
      .split(",")
      .map((target) => target.trim())
      .filter(Boolean),
    apiBaseUrl: process.env.REND_PROD_API_BASE_URL || "https://api.rend.so",
    siteBaseUrl: process.env.REND_PROD_SITE_BASE_URL || "https://www.rend.so",
    planId:
      envValue(
        "REND_HLS_PROVIDER_AUTUMN_PLAN_ID",
        "REND_TIGRIS_EDGE_AUTUMN_PLAN_ID",
      ) ||
      defaultBillingPlanId,
    cleanupAsset: keepAsset !== "1",
    publicCopy: publicCopy === "1",
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--video") {
      options.videoPath = next;
      index += 1;
      continue;
    }
    if (arg === "--mux-url") {
      options.muxUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--samples") {
      options.samples = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--watch-ms") {
      options.watchMs = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--delay-ms") {
      options.delayMs = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--startup-timeout-ms") {
      options.startupTimeoutMs = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--target-candidates") {
      options.targetCandidates = String(next || "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (arg === "--api-base-url") {
      options.apiBaseUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--site-base-url") {
      options.siteBaseUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--plan-id") {
      options.planId = next;
      index += 1;
      continue;
    }
    if (arg === "--keep-asset") {
      options.cleanupAsset = false;
      continue;
    }
    if (arg === "--public-copy") {
      options.publicCopy = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  validateOptions(options);
  options.videoPath = path.resolve(options.videoPath);
  options.muxUrl = normalizeBaseUrl(options.muxUrl);
  options.apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl);
  options.siteBaseUrl = normalizeBaseUrl(options.siteBaseUrl);
  return options;
}

function validateOptions(options) {
  if (
    !Number.isFinite(options.samples) ||
    options.samples < 1 ||
    options.samples > 50
  ) {
    throw new Error("--samples must be between 1 and 50");
  }
  if (
    !Number.isFinite(options.watchMs) ||
    options.watchMs < 1_000 ||
    options.watchMs > 120_000
  ) {
    throw new Error("--watch-ms must be between 1000 and 120000");
  }
  if (
    !Number.isFinite(options.delayMs) ||
    options.delayMs < 0 ||
    options.delayMs > 60_000
  ) {
    throw new Error("--delay-ms must be between 0 and 60000");
  }
  if (
    !Number.isFinite(options.startupTimeoutMs) ||
    options.startupTimeoutMs < 1_000 ||
    options.startupTimeoutMs > 120_000
  ) {
    throw new Error("--startup-timeout-ms must be between 1000 and 120000");
  }
  if (!options.targetCandidates.length)
    throw new Error("at least one Daytona target candidate is required");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(options.planId || ""))) {
    throw new Error("--plan-id must be a safe Autumn plan id");
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function log(message) {
  console.log(`[prod-hls-providers] ${message}`);
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

async function maybeReadEnvFile(filePath) {
  try {
    return parseEnvFile(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function loadBenchmarkEnv() {
  const candidates = [
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env.production.local"),
    defaultProdEnvPath,
  ];
  const env = {};
  for (const filePath of candidates) {
    Object.assign(env, await maybeReadEnvFile(filePath));
  }
  Object.assign(env, process.env);
  redactionValues = [
    env.REND_API_KEY,
    env.REND_READINESS_API_KEY,
    env.REND_DEV_API_KEY,
    env.AUTUMN_SECRET_KEY,
    env.DAYTONA_API_KEY,
    env.DAYTONA_EU_API_KEY,
    env.AWS_ACCESS_KEY_ID,
    env.AWS_SECRET_ACCESS_KEY,
  ].filter(Boolean);
  return env;
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !String(env[name] || "").trim());
  if (missing.length)
    throw new Error(`Missing required env: ${missing.join(", ")}`);
}

function redactText(value) {
  let text = String(value || "");
  for (const secret of redactionValues) {
    if (secret) text = text.split(secret).join("<redacted>");
  }
  return text
    .replace(/\bBearer\s+[a-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>")
    .replace(/([?&]X-Amz-Signature=)[a-f0-9]+/gi, "$1<redacted>")
    .replace(/([?&]X-Amz-Credential=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/([?&]X-Amz-Security-Token=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/(token=)[a-z0-9._~-]{12,}/gi, "$1<redacted>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<asset-id>",
    );
}

async function checkedExec(sandbox, command, cwd, env, timeoutSeconds) {
  log(`exec: ${command.replaceAll(/\s+/g, " ").slice(0, 180)}`);
  const result = await sandbox.process.executeCommand(
    command,
    cwd,
    env,
    timeoutSeconds,
  );
  const output = redactText(
    result.result || result.artifacts?.stdout || "",
  ).trim();
  if (output) {
    const clipped =
      output.length > 5000
        ? `${output.slice(-5000)}\n[output clipped]`
        : output;
    console.log(clipped);
  }
  if (result.exitCode && result.exitCode !== 0) {
    throw new Error(
      `remote command exited ${result.exitCode}: ${command}\n${output}`,
    );
  }
  return result;
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectUrl(env, key = "") {
  const endpoint = normalizeBaseUrl(env.S3_ENDPOINT);
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  const bucket = awsEncode(env.S3_BUCKET);
  const encodedKey = key
    ? key
        .split("/")
        .filter((part, index, parts) => part || index < parts.length - 1)
        .map(awsEncode)
        .join("/")
    : "";
  url.pathname = `${basePath}/${bucket}${encodedKey ? `/${encodedKey}` : ""}`;
  url.search = "";
  url.hash = "";
  return url;
}

function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalHeaders(headers) {
  const entries = [...headers.entries()]
    .map(([key, value]) => [
      key.toLowerCase(),
      String(value).trim().replace(/\s+/g, " "),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    block: entries.map(([key, value]) => `${key}:${value}\n`).join(""),
    signedHeaders: entries.map(([key]) => key).join(";"),
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function signingKey(secret, dateStamp, region) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function amzDates(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function credentialScope(dateStamp, region) {
  return `${dateStamp}/${region}/s3/aws4_request`;
}

async function s3Fetch(
  env,
  { method, key = "", query = {}, headers = {}, body },
) {
  const url = objectUrl(env, key);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null)
      url.searchParams.set(name, String(value));
  }

  const { amzDate, dateStamp } = amzDates();
  const payloadHash = body ? sha256Hex(body) : emptyPayloadHash;
  const requestHeaders = new Headers(headers);
  requestHeaders.set("host", url.host);
  requestHeaders.set("x-amz-content-sha256", payloadHash);
  requestHeaders.set("x-amz-date", amzDate);
  if (env.AWS_SESSION_TOKEN)
    requestHeaders.set("x-amz-security-token", env.AWS_SESSION_TOKEN);

  const canonical = canonicalHeaders(requestHeaders);
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(url.searchParams),
    canonical.block,
    canonical.signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = credentialScope(dateStamp, env.S3_REGION);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmac(
    signingKey(env.AWS_SECRET_ACCESS_KEY, dateStamp, env.S3_REGION),
    stringToSign,
    "hex",
  );
  requestHeaders.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
  );

  const fetchHeaders = new Headers(requestHeaders);
  fetchHeaders.delete("host");
  const response = await fetch(url, { method, headers: fetchHeaders, body });
  if (!response.ok) {
    const text = redactText((await response.text()).slice(0, 1000));
    throw new Error(
      `S3 ${method} failed with HTTP ${response.status}: ${text}`,
    );
  }
  return response;
}

function presignedGetObjectUrl(env, key, expiresSeconds = 7200) {
  const url = objectUrl(env, key);
  const { amzDate, dateStamp } = amzDates();
  const scope = credentialScope(dateStamp, env.S3_REGION);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${env.AWS_ACCESS_KEY_ID}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set(
    "X-Amz-Expires",
    String(Math.max(60, Math.min(604800, Math.floor(expiresSeconds)))),
  );
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  if (env.AWS_SESSION_TOKEN)
    url.searchParams.set("X-Amz-Security-Token", env.AWS_SESSION_TOKEN);

  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmac(
    signingKey(env.AWS_SECRET_ACCESS_KEY, dateStamp, env.S3_REGION),
    stringToSign,
    "hex",
  );
  url.searchParams.set("X-Amz-Signature", signature);
  return url.toString();
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseXmlTag(text, tagName) {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`).exec(text);
  return match ? decodeXmlText(match[1]) : "";
}

function parseListObjectKeys(text) {
  return [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
    decodeXmlText(match[1]),
  );
}

async function listObjectKeys(env, prefix) {
  const keys = [];
  let continuationToken = "";
  do {
    const response = await s3Fetch(env, {
      method: "GET",
      query: {
        "list-type": "2",
        prefix,
        ...(continuationToken
          ? { "continuation-token": continuationToken }
          : {}),
      },
    });
    const text = await response.text();
    keys.push(...parseListObjectKeys(text));
    continuationToken = parseXmlTag(text, "NextContinuationToken");
  } while (continuationToken);
  return keys;
}

async function rendApiJson(env, options, requestPath, init = {}) {
  const url = new URL(requestPath, options.apiBaseUrl);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${activeRendApiKey(env)}`);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const response = await httpRequestText(url, {
    method: init.method || "GET",
    headers,
    body: init.body,
  }).catch((error) => {
    throw new Error(
      `Rend API request ${requestPath} failed: ${fetchErrorMessage(error)}`,
    );
  });
  const text = response.text;
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(
      `Rend API ${requestPath} failed with HTTP ${response.status}: ${redactText(text.slice(0, 1000))}`,
    );
  }
  if (init.returnHeaders) return { body, headers: response.headers };
  return body;
}

function activeRendApiKey(env) {
  return (
    env.__BENCHMARK_REND_API_KEY ||
    env.REND_API_KEY ||
    env.REND_READINESS_API_KEY ||
    ""
  );
}

async function createDbClient(databaseUrl) {
  const { Client } = requireFromSite("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

async function provisionBenchmarkApiKey(env, options) {
  const db = await createDbClient(env.DATABASE_URL);
  const userId = randomUUID();
  const organizationId = randomUUID();
  const rawKey = `rend_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = sha256Hex(rawKey);
  const prefix = rawKey.slice(0, 18);
  const slug =
    `prod-hls-providers-${runId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(
      0,
      80,
    );
  const email = `${slug}@internal.rend.so`;
  const name = `Prod HLS Provider Benchmark ${runId}`;

  try {
    await db.query("BEGIN");
    const userResult = await db.query(
      `
INSERT INTO rend_auth."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ($1::uuid, $2, $3, true, now(), now())
ON CONFLICT (email) DO UPDATE
SET email_verified = true,
    updated_at = now()
RETURNING id::text
`,
      [userId, "Rend Benchmark", email],
    );
    const resolvedUserId = userResult.rows[0]?.id;
    if (!resolvedUserId)
      throw new Error("benchmark user provisioning did not return an id");

    await db.query(
      `
INSERT INTO rend_auth.organization (id, name, slug, metadata, created_at, updated_at)
VALUES ($1::uuid, $2, $3, $4::jsonb, now(), now())
ON CONFLICT (slug) DO UPDATE
SET updated_at = now()
`,
      [
        organizationId,
        name,
        slug,
        JSON.stringify({
          provisioned: "prod-hls-provider-benchmark",
          run_id: runId,
        }),
      ],
    );
    await db.query(
      `
INSERT INTO rend_auth.member (organization_id, user_id, role, created_at)
VALUES ($1::uuid, $2::uuid, 'owner', now())
ON CONFLICT (user_id, organization_id) DO UPDATE
SET role = 'owner'
`,
      [organizationId, resolvedUserId],
    );
    await db.query(
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
    const keyResult = await db.query(
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
RETURNING id::text, prefix
`,
      [organizationId, resolvedUserId, name, prefix, keyHash],
    );
    const apiKeyId = keyResult.rows[0]?.id;
    if (!apiKeyId)
      throw new Error("benchmark API key provisioning did not return an id");
    await db.query("COMMIT");

    try {
      await attachBenchmarkAutumnPlan(env, options, {
        organizationId,
        organizationName: name,
        userEmail: email,
      });
    } catch (error) {
      await db
        .query(
          "UPDATE rend.api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1::uuid",
          [apiKeyId],
        )
        .catch(() => undefined);
      await db.end().catch(() => undefined);
      throw error;
    }

    redactionValues.push(rawKey);
    env.__BENCHMARK_REND_API_KEY = rawKey;
    log("created temporary production benchmark API key");
    return {
      db,
      apiKeyId,
      userId: resolvedUserId,
      userEmail: email,
      organizationId,
      rawKey,
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end().catch(() => undefined);
    throw error;
  }
}

async function attachBenchmarkAutumnPlan(env, options, account) {
  if (!env.AUTUMN_SECRET_KEY) {
    throw new Error(
      "AUTUMN_SECRET_KEY is required to auto-provision a benchmark API key",
    );
  }
  await autumnPost(env, "/customers.get_or_create", {
    customer_id: account.organizationId,
    name: account.organizationName,
    email: account.userEmail,
    metadata: {
      source: "rend-prod-hls-provider-benchmark",
      run_id: runId,
    },
  });
  await autumnAttachPlan(env, account.organizationId, options.planId);
  log("attached Autumn benchmark plan");
}

async function autumnAttachPlan(env, customerId, planId) {
  try {
    return await autumnPost(env, "/billing.attach", {
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

async function autumnPost(env, routePath, body) {
  const apiUrl = normalizeBaseUrl(env.AUTUMN_API_URL || defaultAutumnApiUrl);
  const response = await fetch(`${apiUrl}${routePath}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.AUTUMN_SECRET_KEY}`,
      "content-type": "application/json",
      "x-api-version": env.AUTUMN_API_VERSION || defaultAutumnApiVersion,
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
    const message = redactText(
      data.message || data.error || `HTTP ${response.status}`,
    );
    throw new Error(`Autumn ${routePath} failed: ${message}`);
  }
  return data;
}

async function cleanupBenchmarkCredential(credential) {
  if (!credential) return;
  try {
    await credential.db.query(
      `
WITH revoked AS (
  UPDATE rend.api_keys
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE id = $1::uuid
  RETURNING id
),
sessions_deleted AS (
  DELETE FROM rend_auth.session
  WHERE user_id = $2::uuid
  RETURNING id
),
verifications_deleted AS (
  DELETE FROM rend_auth.verification
  WHERE identifier LIKE '%' || $3
  RETURNING id
)
SELECT 1
`,
      [credential.apiKeyId, credential.userId, credential.userEmail],
    );
    log("revoked temporary production benchmark API key");
  } catch (error) {
    log(
      `failed to revoke temporary benchmark API key: ${redactText(error?.message || error).slice(0, 300)}`,
    );
  } finally {
    await credential.db.end().catch(() => undefined);
  }
}

async function uploadRendAsset(env, options, videoBuffer, videoStats) {
  const response = await rendApiJson(env, options, "/v1/videos", {
    method: "POST",
    body: videoBuffer,
    headers: {
      "content-length": String(videoStats.size),
      "content-type": "video/mp4",
    },
  });
  if (!response?.asset_id)
    throw new Error("Rend upload response did not include asset_id");
  return response.asset_id;
}

function fetchErrorMessage(error) {
  const parts = [error?.name, error?.message].filter(Boolean);
  if (error?.cause) {
    parts.push(error.cause.code, error.cause.message);
  }
  return redactText(parts.filter(Boolean).join(" "));
}

function httpRequestText(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "http:" ? http : https;
    const requestHeaders = Object.fromEntries(headers.entries());
    const request = client.request(
      url,
      {
        method,
        headers: requestHeaders,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            headers: response.headers,
            text,
          });
        });
      },
    );
    request.setTimeout(600_000, () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", reject);
    if (body) {
      request.end(body);
    } else {
      request.end();
    }
  });
}

async function waitForHlsReady(env, options, assetId) {
  const timeoutMs = Number(
    envValue(
      "REND_HLS_PROVIDER_READY_TIMEOUT_MS",
      "REND_TIGRIS_EDGE_READY_TIMEOUT_MS",
    ) || 600_000,
  );
  const intervalMs = Number(
    envValue(
      "REND_HLS_PROVIDER_READY_INTERVAL_MS",
      "REND_TIGRIS_EDGE_READY_INTERVAL_MS",
    ) || 2_000,
  );
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await rendApiJson(
      env,
      options,
      `/v1/assets/${encodeURIComponent(assetId)}`,
    );
    if (last?.playable_state === "hls_ready") return last;
    if (
      last?.playable_state === "failed" ||
      last?.playable_state === "deleted"
    ) {
      throw new Error(
        `asset reached terminal playable_state ${last.playable_state}`,
      );
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out waiting for hls_ready; last playable_state=${last?.playable_state || "unknown"}`,
  );
}

async function deleteRendAsset(env, options, assetId) {
  await rendApiJson(env, options, `/v1/assets/${encodeURIComponent(assetId)}`, {
    method: "DELETE",
  });
}

function createHlsPage({
  title,
  manifestUrl,
  playbackToken = "",
  signedUrlByPath = {},
  selectedMode,
  artifact = "hls/master.m3u8",
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
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
      data-rend-player-selected="${escapeHtml(selectedMode)}"
      data-rend-player-artifact="${escapeHtml(artifact)}"
      data-rend-bootstrap-ms="0"
      data-rend-metadata-ms=""
      data-rend-loadeddata-ms=""
      data-rend-canplay-ms=""
      data-rend-first-frame-ms=""
      data-rend-selected-bitrate=""
      data-rend-selected-height=""
      data-rend-selected-level=""
      data-rend-selected-width=""
    >
      <video id="video" autoplay muted playsinline controls preload="auto"></video>
    </div>
    <script src="../vendor/hls.min.js"></script>
    <script>
      ${commonPlayerProbeScript()}
      const manifestUrl = ${JSON.stringify(manifestUrl)};
      const playbackToken = ${JSON.stringify(playbackToken)};
      const signedUrlByPath = ${JSON.stringify(signedUrlByPath)};
      const manifestOrigin = new URL(manifestUrl).origin;

      function appendToken(rawUrl) {
        if (!playbackToken) return rawUrl;
        const next = new URL(rawUrl, manifestUrl);
        if (next.origin === manifestOrigin && !next.searchParams.has("token")) {
          next.searchParams.set("token", playbackToken);
        }
        return next.toString();
      }

      function artifactPathFromUrl(rawUrl) {
        try {
          const next = new URL(rawUrl, manifestUrl);
          const marker = "/videos/";
          const markerIndex = next.pathname.indexOf(marker);
          if (markerIndex >= 0) {
            const parts = next.pathname.slice(markerIndex + marker.length).split("/");
            return decodeURIComponent(parts.slice(1).join("/"));
          }
          const edgeMarker = "/v/";
          const edgeIndex = next.pathname.indexOf(edgeMarker);
          if (edgeIndex >= 0) {
            const parts = next.pathname.slice(edgeIndex + edgeMarker.length).split("/");
            return decodeURIComponent(parts.slice(1).join("/"));
          }
          const hlsIndex = next.pathname.indexOf("/hls/");
          if (hlsIndex >= 0) return decodeURIComponent(next.pathname.slice(hlsIndex + 1));
        } catch {}
        return "";
      }

      function rewriteUrl(rawUrl) {
        const path = artifactPathFromUrl(rawUrl);
        if (path && signedUrlByPath[path]) return signedUrlByPath[path];
        return appendToken(rawUrl);
      }

      if (!window.Hls || !window.Hls.isSupported()) {
        setState("playback_failure");
      } else {
        const BaseLoader = window.Hls.DefaultConfig.loader;
        class RewriteLoader extends BaseLoader {
          load(context, config, callbacks) {
            context.url = rewriteUrl(context.url);
            super.load(context, config, callbacks);
          }
        }
        const hls = new window.Hls({
          abrEwmaDefaultEstimate: 1200000,
          capLevelOnFPSDrop: true,
          capLevelToPlayerSize: true,
          loader: RewriteLoader,
          maxBufferLength: 12,
          maxMaxBufferLength: 30,
          startFragPrefetch: true,
          startLevel: -1,
          testBandwidth: true,
          xhrSetup: (xhr) => {
            xhr.withCredentials = Boolean(playbackToken);
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
        hls.loadSource(rewriteUrl(manifestUrl));
        hls.attachMedia(video);
        hls.startLoad();
      }
    </script>
  </body>
</html>
`;
}

function commonPlayerProbeScript() {
  return `
      const player = document.getElementById("player");
      const video = document.getElementById("video");
      const startedAt = performance.now();

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
      video.addEventListener("loadeddata", () => {
        setTiming("data-rend-loadeddata-ms");
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
`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function resolveHlsMinScript() {
  const candidates = [
    path.join(
      repoRoot,
      "node_modules",
      ".bun",
      "hls.js@1.6.16",
      "node_modules",
      "hls.js",
      "dist",
      "hls.min.js",
    ),
    path.join(repoRoot, "node_modules", "hls.js", "dist", "hls.min.js"),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("Could not find hls.min.js under node_modules");
}

function benchmarkRegionForTarget(target) {
  const normalized = String(target || "").toLowerCase();
  if (normalized.startsWith("eu")) return "daytona-eu";
  if (normalized.startsWith("us")) return "daytona-us";
  return `daytona-${normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown"}`;
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

async function createSandbox(env, options) {
  const errors = [];
  for (const target of options.targetCandidates) {
    const apiKey = daytonaApiKeyForTarget(env, target);
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
            purpose: "prod-hls-provider-benchmark",
            runId,
          },
        },
        { timeout: 420 },
      );
      log(`created sandbox id=${sandbox.id} actualTarget=${sandbox.target}`);
      return { daytona, sandbox, requestedTarget: target };
    } catch (error) {
      const message = redactText(error?.message || error);
      errors.push({ target, message });
      log(`target ${target} failed: ${message.slice(0, 400)}`);
    }
  }
  throw new Error(
    `Could not create Daytona sandbox in any target: ${JSON.stringify(errors, null, 2)}`,
  );
}

async function runDaytonaBenchmark(env, options, pages) {
  const benchmarkScript = await readFile(
    path.join(repoRoot, "scripts", "benchmark-providers.mjs"),
  );
  const hlsMinScript = await resolveHlsMinScript();
  let sandbox;
  let daytona;
  let requestedTarget;

  try {
    const created = await createSandbox(env, options);
    sandbox = created.sandbox;
    daytona = created.daytona;
    requestedTarget = created.requestedTarget;

    const workDir =
      (await sandbox.getWorkDir()) ||
      (await sandbox.getUserHomeDir()) ||
      "/home/daytona";
    const remoteRoot = path.posix.join(
      workDir,
      "rend-prod-hls-provider-benchmark",
    );
    const remoteScript = path.posix.join(
      remoteRoot,
      "scripts",
      "benchmark-providers.mjs",
    );
    const remoteStaticRoot = path.posix.join(remoteRoot, "static");
    log(`remoteRoot=${remoteRoot}`);

    await checkedExec(
      sandbox,
      `mkdir -p ${remoteRoot}/scripts ${remoteStaticRoot}/vendor ${remoteStaticRoot}/rend-tigris-hls`,
      workDir,
      undefined,
      30,
    );
    await sandbox.fs.uploadFile(Buffer.from(benchmarkScript), remoteScript);
    await sandbox.fs.uploadFile(
      Buffer.from(hlsMinScript),
      path.posix.join(remoteStaticRoot, "vendor", "hls.min.js"),
    );
    await sandbox.fs.uploadFile(
      Buffer.from(pages.rendTigrisHls),
      path.posix.join(remoteStaticRoot, "rend-tigris-hls", "index.html"),
    );

    await checkedExec(
      sandbox,
      "node --version && npm --version && npm init -y >/dev/null && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright@1.61.0 --no-audit --no-fund",
      remoteRoot,
      undefined,
      300,
    );
    await checkedExec(
      sandbox,
      `python3 -m http.server 8125 --bind 127.0.0.1 --directory ${remoteStaticRoot} > ${remoteStaticRoot}/server.log 2>&1 & echo $! > ${remoteStaticRoot}/server.pid`,
      remoteRoot,
      undefined,
      30,
    );
    await checkedExec(
      sandbox,
      "node -e \"fetch('http://127.0.0.1:8125/rend-tigris-hls/index.html').then(r=>{if(!r.ok)process.exit(1); console.log('static server ready')})\"",
      remoteRoot,
      undefined,
      30,
    );

    const providers = ["rend", "mux", "rend_tigris_hls"];
    const benchmarkEnv = {
      BENCHMARK_PROVIDERS: providers.join(","),
      BENCHMARK_REND_URL: pages.rendWatchUrl,
      BENCHMARK_MUX_URL: pages.muxUrl,
      BENCHMARK_REND_TIGRIS_HLS_URL:
        "http://127.0.0.1:8125/rend-tigris-hls/index.html",
      BENCHMARK_REGION: benchmarkRegionForTarget(
        sandbox.target || requestedTarget,
      ),
      BENCHMARK_REGION_LABEL: `Daytona ${sandbox.target} (${requestedTarget} requested)`,
      BENCHMARK_RUNNER_KIND: "daytona",
      BENCHMARK_RUNNER_LABEL: sandbox.id,
      BENCHMARK_BROWSER_CHANNEL: "",
      BENCHMARK_ALLOW_BUNDLED_CHROMIUM: "1",
      BENCHMARK_PUBLIC_COPY: "0",
    };
    const timeoutSeconds = Number(
      envValue(
        "REND_HLS_PROVIDER_REMOTE_TIMEOUT_SECS",
        "REND_TIGRIS_EDGE_REMOTE_TIMEOUT_SECS",
      ) ||
        Math.max(
          180,
          Math.ceil(
            (options.samples *
              providers.length *
              (options.watchMs + options.delayMs + options.startupTimeoutMs)) /
              1000,
          ) + 60,
        ),
    );
    const benchmarkCommand = `timeout ${Math.max(30, timeoutSeconds - 5)}s node scripts/benchmark-providers.mjs --samples ${Math.floor(options.samples)} --watch-ms ${Math.floor(options.watchMs)} --delay-ms ${Math.floor(options.delayMs)} --startup-timeout-ms ${Math.floor(options.startupTimeoutMs)}`;
    await checkedExec(
      sandbox,
      `${benchmarkCommand}; status=$?; if [ "$status" -eq 124 ] && [ -f .rend/benchmarks/providers/latest.json ]; then echo '[benchmark] process timed out after writing artifacts; continuing'; exit 0; fi; exit "$status"`,
      remoteRoot,
      benchmarkEnv,
      timeoutSeconds,
    );

    const remoteSummary = path.posix.join(
      remoteRoot,
      ".rend",
      "benchmarks",
      "providers",
      "latest.json",
    );
    const remoteSamples = path.posix.join(
      remoteRoot,
      ".rend",
      "benchmarks",
      "providers",
      "latest.samples.json",
    );
    const [summaryBytes, sampleBytes] = await Promise.all([
      sandbox.fs.downloadFile(remoteSummary, 120),
      sandbox.fs.downloadFile(remoteSamples, 120),
    ]);

    await mkdir(localOutDir, { recursive: true });
    await writeFile(path.join(localOutDir, "latest.json"), summaryBytes);
    await writeFile(path.join(localOutDir, "latest.samples.json"), sampleBytes);
    if (options.publicCopy) {
      await mkdir(publicOutDir, { recursive: true });
      await writeFile(path.join(publicOutDir, "latest.json"), summaryBytes);
      await writeFile(
        path.join(publicOutDir, "latest.samples.json"),
        sampleBytes,
      );
    }

    const summary = JSON.parse(summaryBytes.toString("utf8"));
    log(
      `downloaded artifacts run=${summary.run.id} region=${summary.run.regionLabel} minSamples=${summary.summary.minSamplesPerProvider} redaction=${summary.redaction?.status}`,
    );
    log(`local artifacts: ${localOutDir}`);
    if (!options.publicCopy)
      log(
        "public artifact copy skipped; pass --public-copy to update site benchmark JSON",
      );
    return summary;
  } finally {
    if (sandbox) {
      try {
        log(`deleting sandbox id=${sandbox.id}`);
        await sandbox.delete(180);
      } catch (error) {
        log(
          `sandbox delete failed; trying stop: ${redactText(error?.message || error).slice(0, 300)}`,
        );
        try {
          await sandbox.stop(120, true);
        } catch (stopError) {
          log(
            `sandbox stop failed: ${redactText(stopError?.message || stopError).slice(0, 300)}`,
          );
        }
      }
    }
    if (daytona?.[Symbol.asyncDispose]) {
      await daytona[Symbol.asyncDispose]();
    }
  }
}

async function preparePages(env, options, assetId) {
  const prefix = `videos/${assetId}/hls/`;
  const keys = (await listObjectKeys(env, prefix)).filter(
    (key) =>
      key.endsWith(".m3u8") ||
      key.endsWith(".ts") ||
      key.endsWith(".m4s") ||
      /\/init_(360p|480p|720p|1080p|2k|4k)\.mp4$/.test(key),
  );
  if (!keys.some((key) => key.endsWith("/master.m3u8"))) {
    throw new Error(
      "Tigris HLS object listing did not include hls/master.m3u8",
    );
  }
  const signedUrlByPath = Object.fromEntries(
    keys.map((key) => [
      key.slice(`videos/${assetId}/`.length),
      presignedGetObjectUrl(env, key),
    ]),
  );

  return {
    rendWatchUrl: new URL(
      `/watch/${encodeURIComponent(assetId)}?autoplay=1`,
      options.siteBaseUrl,
    ).toString(),
    muxUrl: options.muxUrl,
    rendTigrisHls: createHlsPage({
      title: "Rend HLS direct from Tigris benchmark",
      manifestUrl: signedUrlByPath["hls/master.m3u8"],
      signedUrlByPath,
      selectedMode: "rend_tigris_hls_js",
    }),
  };
}

function summarizeResult(summary) {
  const providers = summary?.summary?.providers || {};
  const lines = [];
  for (const [id, provider] of Object.entries(providers)) {
    lines.push(
      `${id}: firstFrame median=${provider.metrics?.timeToFirstFrameMs?.median ?? "n/a"}ms, loadedData median=${provider.metrics?.timeToLoadedDataMs?.median ?? "n/a"}ms, canplay median=${provider.metrics?.timeToCanplayMs?.median ?? "n/a"}ms, success=${provider.successfulSamples}/${provider.sampleCount}`,
    );
  }
  return lines.join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = await loadBenchmarkEnv();
  requireEnv(env, [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]);
  if (!activeRendApiKey(env) && !env.DATABASE_URL) {
    throw new Error(
      "REND_API_KEY or REND_READINESS_API_KEY is required unless DATABASE_URL is available to create a temporary benchmark key",
    );
  }
  if (!activeRendApiKey(env) && !env.AUTUMN_SECRET_KEY) {
    throw new Error(
      "AUTUMN_SECRET_KEY is required when creating a temporary benchmark key",
    );
  }

  if (!existsSync(options.videoPath))
    throw new Error(`video does not exist: ${options.videoPath}`);
  const videoStats = await stat(options.videoPath);
  log(
    `video=${options.videoPath} size=${Math.round(videoStats.size / 1024 / 1024)}MiB`,
  );
  log(
    `samples=${options.samples} watchMs=${options.watchMs} providers=rend,mux,rend_tigris_hls`,
  );

  if (options.dryRun) {
    log("dry run passed; no production upload or sandbox was created");
    return;
  }

  const videoBuffer = await readFile(options.videoPath);
  let assetId = "";
  let summary = null;
  let benchmarkCredential = null;

  try {
    if (!activeRendApiKey(env)) {
      benchmarkCredential = await provisionBenchmarkApiKey(env, options);
    }

    log("uploading source through Rend production API");
    assetId = await uploadRendAsset(env, options, videoBuffer, videoStats);
    log("waiting for production Rend asset to reach hls_ready");
    await waitForHlsReady(env, options, assetId);

    log("preparing redacted HLS benchmark page");
    const pages = await preparePages(env, options, assetId);
    await mkdir(localOutDir, { recursive: true });
    await writeFile(
      path.join(localOutDir, "run-metadata.redacted.json"),
      `${JSON.stringify(
        {
          schemaVersion: "rend.prod-hls-provider-benchmark.metadata.v1",
          runId,
          generatedAt: new Date().toISOString(),
          video: {
            basename: path.basename(options.videoPath),
            byteSize: videoStats.size,
          },
          providers: ["rend", "mux", "rend_tigris_hls"],
          cleanup: {
            rendAsset: options.cleanupAsset,
          },
        },
        null,
        2,
      )}\n`,
    );

    summary = await runDaytonaBenchmark(env, options, pages);
    console.log(summarizeResult(summary));
  } finally {
    if (options.cleanupAsset && assetId) {
      try {
        log("deleting production Rend test asset");
        await deleteRendAsset(env, options, assetId);
      } catch (error) {
        log(
          `failed to delete production Rend test asset: ${redactText(error?.message || error).slice(0, 300)}`,
        );
      }
    } else if (assetId) {
      log("keeping production Rend test asset because --keep-asset was set");
    }

    await cleanupBenchmarkCredential(benchmarkCredential);
  }
}

main().catch((error) => {
  console.error(
    `[prod-hls-providers] ${redactText(error.stack || error.message)}`,
  );
  process.exitCode = 1;
});
