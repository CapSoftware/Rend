#!/usr/bin/env node

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiBase = requiredUrl("REND_API_BASE_URL");
const playbackBase = requiredUrl("REND_PLAYBACK_BASE_URL");
const apiKey = required("REND_READINESS_API_KEY");
const fixturePath = path.resolve(
  process.env.REND_SMOKE_FIXTURE || path.join(root, "fixtures/media/rend-benchmark-small.mp4"),
);
const timeoutMs = positiveInteger("REND_SMOKE_TIMEOUT_MS", 10 * 60_000);
const deleteTimeoutMs = positiveInteger("REND_SMOKE_DELETE_TIMEOUT_MS", 5 * 60_000);
const fixture = await readFile(fixturePath);
const checksum = crypto.createHash("sha256").update(fixture).digest("base64");
const idempotencyKey = `aws-smoke-${crypto.randomUUID()}`;
let assetId = "";
let deleted = false;

function required(name) {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredUrl(name) {
  const value = new URL(required(name));
  if (value.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  value.pathname = value.pathname.replace(/\/+$/, "");
  value.search = "";
  value.hash = "";
  return value.toString().replace(/\/$/, "");
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiUrl(route) {
  return `${apiBase}${route}`;
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${apiKey}`, ...extra };
}

async function jsonResponse(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned HTTP ${response.status} with a non-JSON body`);
  }
  if (!response.ok) {
    const code = typeof body?.error === "string" ? ` (${body.error})` : "";
    throw new Error(`${label} returned HTTP ${response.status}${code}`);
  }
  return body;
}

async function apiJson(route, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(apiUrl(route), {
    method,
    headers: authHeaders(body === undefined ? headers : { "content-type": "application/json", ...headers }),
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  return { response, body: await jsonResponse(response, `${method} ${route}`) };
}

function responseCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie") || "";
  return combined ? combined.split(/,(?=\s*[^;,=]+=[^;,]+)/) : [];
}

function cookieHeader(cookies) {
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function assetArtifactUrl(reference, base, label) {
  const value = new URL(reference, base);
  const expectedPrefix = `${playbackBase}/v/${assetId}/`;
  if (!value.toString().startsWith(expectedPrefix)) {
    throw new Error(`${label} escaped the expected CloudFront asset path`);
  }
  if (value.search || value.hash) {
    throw new Error(`${label} exposed query credentials`);
  }
  return value.toString();
}

async function signedArtifact(url, cookies, label, headers = {}) {
  const response = await fetch(url, {
    headers: { cookie: cookieHeader(cookies), ...headers },
    redirect: "error",
  });
  const body = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const detail = new TextDecoder()
      .decode(body.slice(0, 512))
      .replace(/\s+/g, " ")
      .trim();
    const cache = response.headers.get("x-cache") || "missing";
    const contentType = response.headers.get("content-type") || "missing";
    throw new Error(
      `${label} (${new URL(url).pathname}) returned HTTP ${response.status}; ` +
        `x-cache=${cache}; content-type=${contentType}; body=${detail || "empty"}`,
    );
  }
  if (body.byteLength === 0) throw new Error(`${label} returned an empty body`);
  return { response, body };
}

function manifestReference(body, label, predicate) {
  const reference = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && predicate(line));
  if (!reference) throw new Error(`${label} omitted the expected artifact reference`);
  return reference;
}

async function waitFor(label, timeout, operation) {
  const deadline = Date.now() + timeout;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result?.done) return result.value;
      last = result?.detail || "condition not met";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(2_000);
  }
  throw new Error(`${label} timed out: ${last}`);
}

async function cleanup() {
  if (!assetId || deleted) return;
  try {
    const response = await fetch(apiUrl(`/v1/assets/${encodeURIComponent(assetId)}`), {
      method: "DELETE",
      headers: authHeaders(),
    });
    deleted = response.ok || response.status === 404;
  } catch {
    // The primary error remains more useful than cleanup noise.
  }
}

try {
  const anonymous = await fetch(
    `${playbackBase}/v/00000000-0000-0000-0000-000000000000/opener.mp4`,
    { redirect: "manual" },
  );
  if (anonymous.status !== 403) {
    throw new Error(`anonymous CloudFront playback expected HTTP 403, got ${anonymous.status}`);
  }

  const created = await apiJson("/v1/uploads", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: {
      content_type: "video/mp4",
      content_length: fixture.byteLength,
      filename: path.basename(fixturePath),
    },
  });
  assetId = created.body.asset_id;
  const uploadId = created.body.upload_id;
  if (!assetId || !uploadId || created.body.part_count !== 1) {
    throw new Error("multipart create returned an invalid single-part session");
  }

  const signed = await apiJson(`/v1/uploads/${encodeURIComponent(uploadId)}/parts`, {
    method: "POST",
    body: { parts: [{ part_number: 1, checksum_sha256: checksum }] },
  });
  const part = signed.body.parts?.[0];
  if (!part?.url || part.method !== "PUT") throw new Error("multipart signing omitted the upload part");
  const signedUrl = new URL(part.url);
  if (signedUrl.protocol !== "https:") throw new Error("multipart part URL must use HTTPS");

  const uploaded = await fetch(signedUrl, {
    method: "PUT",
    headers: part.headers,
    body: fixture,
    redirect: "error",
  });
  if (!uploaded.ok) throw new Error(`direct multipart PUT returned HTTP ${uploaded.status}`);
  const etag = uploaded.headers.get("etag");
  if (!etag) throw new Error("direct multipart PUT omitted ETag");

  await apiJson(`/v1/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: "POST",
    body: { parts: [{ part_number: 1, etag, checksum_sha256: checksum }] },
  });

  await waitFor("HLS processing", timeoutMs, async () => {
    const { body } = await apiJson(`/v1/assets/${encodeURIComponent(assetId)}`);
    return {
      done: body.playable_state === "hls_ready",
      value: body,
      detail: `playable_state=${body.playable_state}`,
    };
  });

  const bootstrapResponse = await fetch(apiUrl(`/v1/assets/${encodeURIComponent(assetId)}/playback`), {
    headers: authHeaders(),
    redirect: "error",
  });
  const bootstrap = await jsonResponse(bootstrapResponse, "playback bootstrap");
  if (typeof bootstrap.manifest_url !== "string") {
    throw new Error("playback bootstrap did not return the expected CloudFront asset URL");
  }
  const manifestUrl = assetArtifactUrl(bootstrap.manifest_url, playbackBase, "playback manifest URL");

  const cookies = responseCookies(bootstrapResponse.headers);
  for (const requiredCookie of ["CloudFront-Policy", "CloudFront-Signature", "CloudFront-Key-Pair-Id"])
    if (!cookies.some((cookie) => cookie.startsWith(`${requiredCookie}=`))) {
      throw new Error(`playback bootstrap omitted ${requiredCookie}`);
    }

  const openerUrl = assetArtifactUrl(
    `${playbackBase}/v/${assetId}/opener.mp4`,
    playbackBase,
    "opener URL",
  );
  await signedArtifact(openerUrl, cookies, "signed CloudFront opener", {
    range: "bytes=0-65535",
  });

  const manifest = await signedArtifact(manifestUrl, cookies, "signed CloudFront master manifest");
  const manifestBody = new TextDecoder().decode(manifest.body);
  if (!manifestBody.startsWith("#EXTM3U")) {
    throw new Error("signed CloudFront master manifest was not HLS");
  }

  const renditionReference = manifestReference(
    manifestBody,
    "signed CloudFront master manifest",
    (line) => line.endsWith(".m3u8"),
  );
  const renditionUrl = assetArtifactUrl(
    renditionReference,
    manifestUrl,
    "rendition playlist URL",
  );
  const rendition = await signedArtifact(
    renditionUrl,
    cookies,
    "signed CloudFront rendition playlist",
  );
  const renditionBody = new TextDecoder().decode(rendition.body);
  if (!renditionBody.startsWith("#EXTM3U")) {
    throw new Error("signed CloudFront rendition playlist was not HLS");
  }

  const initReference = renditionBody.match(/^#EXT-X-MAP:URI="([^"]+)"/m)?.[1];
  if (!initReference) throw new Error("signed CloudFront rendition playlist omitted its init file");
  const initUrl = assetArtifactUrl(initReference, renditionUrl, "HLS init URL");
  await signedArtifact(initUrl, cookies, "signed CloudFront HLS init file");

  const segmentReference = manifestReference(
    renditionBody,
    "signed CloudFront rendition playlist",
    (line) => line.endsWith(".m4s") || line.endsWith(".ts"),
  );
  const segmentUrl = assetArtifactUrl(segmentReference, renditionUrl, "HLS segment URL");
  await signedArtifact(segmentUrl, cookies, "signed CloudFront HLS media segment");

  const artifactUrls = [openerUrl, manifestUrl, renditionUrl, initUrl, segmentUrl];

  await waitFor("playback analytics", 90_000, async () => {
    const { body } = await apiJson(`/v1/assets/${encodeURIComponent(assetId)}/analytics/playback`);
    return {
      done: Number(body.request_count) > 0 && Number(body.bytes_served) > 0,
      value: body,
      detail: `request_count=${body.request_count} bytes_served=${body.bytes_served}`,
    };
  });

  await apiJson(`/v1/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
  deleted = true;

  await waitFor("post-delete control plane denial", 30_000, async () => {
    const response = await fetch(apiUrl(`/v1/assets/${encodeURIComponent(assetId)}/playback`), {
      headers: authHeaders(),
      redirect: "error",
    });
    return { done: response.status === 404, detail: `HTTP ${response.status}` };
  });

  await waitFor("CloudFront deletion invalidation", deleteTimeoutMs, async () => {
    const responses = await Promise.all(
      artifactUrls.map((url) =>
        fetch(url, {
          headers: { cookie: cookieHeader(cookies) },
          redirect: "manual",
        }),
      ),
    );
    const statuses = responses.map((response) => response.status);
    return {
      done: statuses.every((status) => status === 403 || status === 404),
      detail: `artifact HTTP statuses=${statuses.join(",")}`,
    };
  });

  console.log(`AWS public smoke passed for asset ${assetId}`);
} catch (error) {
  await cleanup();
  throw error;
}
