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
  const manifestUrl = bootstrap.manifest_url;
  if (typeof manifestUrl !== "string" || !manifestUrl.startsWith(`${playbackBase}/v/${assetId}/`)) {
    throw new Error("playback bootstrap did not return the expected CloudFront asset URL");
  }
  const parsedManifestUrl = new URL(manifestUrl);
  if (parsedManifestUrl.search || parsedManifestUrl.hash) {
    throw new Error("playback URL exposed query credentials");
  }

  const cookies = responseCookies(bootstrapResponse.headers);
  for (const requiredCookie of ["CloudFront-Policy", "CloudFront-Signature", "CloudFront-Key-Pair-Id"])
    if (!cookies.some((cookie) => cookie.startsWith(`${requiredCookie}=`))) {
      throw new Error(`playback bootstrap omitted ${requiredCookie}`);
    }

  const manifest = await fetch(manifestUrl, {
    headers: { cookie: cookieHeader(cookies) },
    redirect: "error",
  });
  if (!manifest.ok) throw new Error(`signed CloudFront manifest returned HTTP ${manifest.status}`);
  if (!(await manifest.text()).startsWith("#EXTM3U")) {
    throw new Error("signed CloudFront manifest was not HLS");
  }

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
    const response = await fetch(manifestUrl, {
      headers: { cookie: cookieHeader(cookies) },
      redirect: "manual",
    });
    return { done: response.status === 403 || response.status === 404, detail: `HTTP ${response.status}` };
  });

  console.log(`AWS public smoke passed for asset ${assetId}`);
} catch (error) {
  await cleanup();
  throw error;
}
