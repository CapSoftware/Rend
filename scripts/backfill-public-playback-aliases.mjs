#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultProdEnvPath = "/Users/richie/.rend/production/rend-api.env";
const emptyPayloadHash = sha256Hex(Buffer.alloc(0));
const allowedAcls = new Set(["public-read", "inherit"]);

let redactionValues = [];

function printHelp() {
  console.log(`Backfill public playback alias objects for existing Rend assets.

Usage:
  node scripts/backfill-public-playback-aliases.mjs --asset-id c12881f9-8b01-4675-b66c-c4f25de3b702 --dry-run
  node scripts/backfill-public-playback-aliases.mjs --asset-id c12881f9-8b01-4675-b66c-c4f25de3b702 --public-base-url https://media.rend.so

Options:
  --asset-id ID              Asset id to backfill. Can be passed more than once.
  --target-bucket BUCKET     Optional public alias bucket. Defaults to REND_PUBLIC_PLAYBACK_ALIAS_BUCKET or S3_BUCKET.
  --create-target-bucket     Create the target bucket as public-read before copying.
  --prefix PREFIX            Public alias prefix. Defaults to REND_PUBLIC_PLAYBACK_ALIAS_PREFIX or v.
  --acl public-read|inherit  Alias object ACL. Defaults to REND_PUBLIC_PLAYBACK_ALIAS_ACL or public-read.
  --public-base-url URL      Optional unauthenticated GET verification base URL.
  --env-file PATH            Load storage credentials from a specific env file.
  --dry-run                  List counts without writing aliases.
`);
}

function parseArgs(argv) {
  const options = {
    assetIds: [],
    targetBucket: "",
    createTargetBucket: false,
    prefix: process.env.REND_PUBLIC_PLAYBACK_ALIAS_PREFIX || "v",
    acl: process.env.REND_PUBLIC_PLAYBACK_ALIAS_ACL || "public-read",
    publicBaseUrl: "",
    envFile: "",
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--asset-id") {
      options.assetIds.push(String(next || ""));
      index += 1;
      continue;
    }
    if (arg === "--prefix") {
      options.prefix = String(next || "");
      index += 1;
      continue;
    }
    if (arg === "--target-bucket") {
      options.targetBucket = String(next || "");
      index += 1;
      continue;
    }
    if (arg === "--create-target-bucket") {
      options.createTargetBucket = true;
      continue;
    }
    if (arg === "--acl") {
      options.acl = String(next || "");
      index += 1;
      continue;
    }
    if (arg === "--public-base-url") {
      options.publicBaseUrl = String(next || "");
      index += 1;
      continue;
    }
    if (arg === "--env-file") {
      options.envFile = String(next || "");
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  options.assetIds = options.assetIds.map(normalizeAssetId);
  if (!options.assetIds.length) {
    throw new Error("--asset-id is required");
  }
  options.prefix = normalizeAliasPrefix(options.prefix);
  options.acl = String(options.acl || "public-read")
    .trim()
    .toLowerCase();
  if (options.acl === "none" || options.acl === "") {
    options.acl = "inherit";
  }
  if (!allowedAcls.has(options.acl)) {
    throw new Error("--acl must be public-read or inherit");
  }
  if (options.publicBaseUrl) {
    options.publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl);
  }
  return options;
}

function normalizeAssetId(value) {
  const assetId = String(value || "")
    .trim()
    .toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      assetId,
    )
  ) {
    throw new Error(`Invalid asset id: ${value}`);
  }
  return assetId;
}

function normalizeAliasPrefix(value) {
  const prefix = String(value || "v")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("alias prefix must not be empty");
  if (prefix.length > 128) throw new Error("alias prefix is too long");
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix)) {
    throw new Error("alias prefix contains unsafe characters");
  }
  for (const segment of prefix.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error("alias prefix contains unsafe path segments");
    }
  }
  return prefix;
}

function normalizeBucketName(value) {
  const bucket = String(value || "").trim();
  if (
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(bucket)
  ) {
    throw new Error("target bucket must be a safe Tigris bucket name");
  }
  return bucket;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("--public-base-url must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "--public-base-url must not include credentials, query, or fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
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
  if (!filePath || !existsSync(filePath)) return {};
  return parseEnvFile(await readFile(filePath, "utf8"));
}

async function loadEnv(options) {
  const candidates = options.envFile
    ? [path.resolve(process.cwd(), options.envFile)]
    : [
        path.join(repoRoot, ".env.production"),
        path.join(repoRoot, ".env.production.local"),
        path.join(repoRoot, ".env.local"),
        defaultProdEnvPath,
      ];
  const env = {};
  for (const filePath of candidates) {
    Object.assign(env, await maybeReadEnvFile(filePath));
  }
  Object.assign(env, process.env);
  redactionValues = [
    env.AWS_ACCESS_KEY_ID,
    env.AWS_SECRET_ACCESS_KEY,
    env.AWS_SESSION_TOKEN,
  ].filter(Boolean);
  return env;
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !String(env[name] || "").trim());
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

function redactText(value) {
  let text = String(value || "");
  for (const secret of redactionValues) {
    if (secret) text = text.split(secret).join("<redacted>");
  }
  return text
    .replace(/([?&]X-Amz-Signature=)[a-f0-9]+/gi, "$1<redacted>")
    .replace(/([?&]X-Amz-Credential=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/([?&]X-Amz-Security-Token=)[^&\s"']+/gi, "$1<redacted>")
    .replace(
      /\bBearer\s+[a-z0-9._~+/=-]{12,}/gi,
      "Bearer <redacted>",
    );
}

function log(message) {
  console.log(`[public-playback-aliases] ${redactText(message)}`);
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectUrl(env, key = "", bucketName = env.S3_BUCKET) {
  const endpoint = normalizeBaseUrl(env.S3_ENDPOINT);
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  const bucket = awsEncode(bucketName);
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
  { method, key = "", query = {}, headers = {}, body, bucket = env.S3_BUCKET },
) {
  const url = objectUrl(env, key, bucket);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(name, String(value));
    }
  }

  const { amzDate, dateStamp } = amzDates();
  const payloadHash = body ? sha256Hex(body) : emptyPayloadHash;
  const requestHeaders = new Headers(headers);
  requestHeaders.set("host", url.host);
  requestHeaders.set("x-amz-content-sha256", payloadHash);
  requestHeaders.set("x-amz-date", amzDate);
  if (env.AWS_SESSION_TOKEN) {
    requestHeaders.set("x-amz-security-token", env.AWS_SESSION_TOKEN);
  }

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
    const error = new Error(
      `S3 ${method} failed with HTTP ${response.status}: ${text}`,
    );
    error.status = response.status;
    throw error;
  }
  return response;
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

async function listObjectKeys(env, prefix, bucket = env.S3_BUCKET) {
  const keys = [];
  let continuationToken = "";
  do {
    const response = await s3Fetch(env, {
      method: "GET",
      bucket,
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

function playbackArtifactKeysForAsset(allKeys, assetId) {
  const prefix = `videos/${assetId}/`;
  return allKeys
    .filter((key) => key.startsWith(prefix))
    .filter((key) => {
      const relative = key.slice(prefix.length);
      if (relative === "thumbnail.jpg" || relative === "opener.mp4") {
        return true;
      }
      if (!relative.startsWith("hls/")) return false;
      return (
        relative.endsWith(".m3u8") ||
        relative.endsWith(".m4s") ||
        relative.endsWith(".ts") ||
        /\/init_[A-Za-z0-9_-]+\.mp4$/.test(relative)
      );
    })
    .sort();
}

function aliasKeyForObject(assetId, objectKey, aliasPrefix) {
  const sourcePrefix = `videos/${assetId}/`;
  if (!objectKey.startsWith(sourcePrefix)) return null;
  return `${aliasPrefix}/${assetId}/${objectKey.slice(sourcePrefix.length)}`;
}

function contentTypeForKey(key, fallback = "application/octet-stream") {
  if (key.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (key.endsWith(".mp4") || key.endsWith(".m4s")) return "video/mp4";
  if (key.endsWith(".ts")) return "video/mp2t";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".png")) return "image/png";
  return fallback;
}

function cacheControlForKey(key) {
  if (key.endsWith(".m3u8")) {
    return "public, max-age=300, stale-while-revalidate=86400";
  }
  return "public, max-age=31536000, immutable";
}

async function mapLimit(items, limit, mapper) {
  let nextIndex = 0;
  const results = [];
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function putAlias(env, options, objectKey, aliasKey) {
  const sourceResponse = await s3Fetch(env, {
    method: "GET",
    key: objectKey,
    bucket: env.S3_BUCKET,
  });
  const body = new Uint8Array(await sourceResponse.arrayBuffer());
  const contentType = contentTypeForKey(
    objectKey,
    sourceResponse.headers.get("content-type") || undefined,
  );
  const headers = {
    "cache-control": cacheControlForKey(objectKey),
    "content-type": contentType,
  };
  if (options.acl === "public-read") {
    headers["x-amz-acl"] = "public-read";
  }
  await s3Fetch(env, {
    method: "PUT",
    key: aliasKey,
    bucket: options.targetBucket,
    headers,
    body,
  });
  return body.byteLength;
}

function publicUrlForAlias(publicBaseUrl, aliasKey) {
  const url = new URL(`${publicBaseUrl}/`);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${aliasKey
    .split("/")
    .map(awsEncode)
    .join("/")}`;
  return url;
}

async function verifyPublicGet(options, assetId) {
  if (!options.publicBaseUrl) return;
  const aliasKey = `${options.prefix}/${assetId}/hls/master.m3u8`;
  const url = publicUrlForAlias(options.publicBaseUrl, aliasKey);
  const response = await fetch(url, {
    headers: { accept: "application/vnd.apple.mpegurl,text/plain,*/*" },
  });
  if (!response.ok) {
    throw new Error(
      `public alias GET failed with HTTP ${response.status} for hls/master.m3u8`,
    );
  }
  const body = await response.text();
  if (!body.includes("#EXTM3U")) {
    throw new Error("public alias GET did not return an HLS manifest");
  }
  log(`asset=${assetId} public GET verification passed`);
}

async function backfillAsset(env, options, assetId) {
  const sourcePrefix = `videos/${assetId}/`;
  const allKeys = await listObjectKeys(env, sourcePrefix, env.S3_BUCKET);
  const artifactKeys = playbackArtifactKeysForAsset(allKeys, assetId);
  if (!artifactKeys.some((key) => key.endsWith("/hls/master.m3u8"))) {
    throw new Error(`asset=${assetId} has no hls/master.m3u8 object`);
  }

  const planned = artifactKeys.map((objectKey) => ({
    objectKey,
    aliasKey: aliasKeyForObject(assetId, objectKey, options.prefix),
  }));
  if (planned.some((entry) => !entry.aliasKey)) {
    throw new Error(`asset=${assetId} produced an invalid alias plan`);
  }

  log(
    `asset=${assetId} playback_artifacts=${planned.length} target_bucket=${options.targetBucket === env.S3_BUCKET ? "source" : "separate"} prefix=${options.prefix} acl=${options.acl} dry_run=${options.dryRun}`,
  );
  if (options.dryRun) return;

  let copiedBytes = 0;
  await mapLimit(planned, 6, async ({ objectKey, aliasKey }) => {
    copiedBytes += await putAlias(env, options, objectKey, aliasKey);
  });
  log(
    `asset=${assetId} aliases_written=${planned.length} bytes=${copiedBytes}`,
  );
  await verifyPublicGet(options, assetId);
}

async function createTargetBucket(env, options) {
  if (!options.createTargetBucket) return;
  if (options.dryRun) {
    log("target bucket creation skipped for dry-run");
    return;
  }
  if (options.targetBucket === env.S3_BUCKET) {
    throw new Error("--create-target-bucket requires a separate target bucket");
  }
  try {
    await s3Fetch(env, {
      method: "PUT",
      bucket: options.targetBucket,
      headers: { "x-amz-acl": "public-read" },
    });
    log("target bucket created as public-read");
  } catch (error) {
    if (error.status === 409) {
      log("target bucket already exists; continuing");
      return;
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = await loadEnv(options);
  requireEnv(env, [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]);
  options.targetBucket = normalizeBucketName(
    options.targetBucket || env.REND_PUBLIC_PLAYBACK_ALIAS_BUCKET || env.S3_BUCKET,
  );
  redactionValues.push(env.S3_BUCKET, options.targetBucket);

  await createTargetBucket(env, options);

  for (const assetId of options.assetIds) {
    await backfillAsset(env, options, assetId);
  }
}

main().catch((error) => {
  console.error(
    `[public-playback-aliases] ${redactText(error?.stack || error?.message || error)}`,
  );
  process.exit(1);
});
