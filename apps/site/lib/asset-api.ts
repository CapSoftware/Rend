import type {
  AnalyticsAssetSummary,
  AnalyticsOverview,
  AssetArtifact,
  AssetDetail,
  AssetListResponse,
  AssetSummary,
  AssetDeleteResponse,
  AssetErrorResponse,
  AssetPlaybackAnalytics,
  AssetUploadResponse,
  AnalyticsTimeSeriesPoint,
} from "./asset-types.ts";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:4000";
const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const LOCAL_SITE_INTERNAL_TOKEN = "local-site-internal-token";

type JsonRecord = Record<string, unknown>;
type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

export type AssetApiAuthContext = {
  organizationId: string;
};

export class AssetApiError extends Error {
  status: number;
  body: AssetErrorResponse;

  constructor(status: number, body: AssetErrorResponse) {
    super(body.error);
    this.name = "AssetApiError";
    this.status = status;
    this.body = body;
  }
}

export class UploadTooLargeError extends Error {
  maxBytes: number;

  constructor(maxBytes: number) {
    super("upload_too_large");
    this.name = "UploadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function envNumber(name: string, fallback: number) {
  const value = Number(envString(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function assetMaxUploadBytes() {
  return envNumber("REND_SITE_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES);
}

function controlPlaneUrl(path: string) {
  const baseUrl = envString("REND_API_BASE_URL", DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  return `${baseUrl}${path}`;
}

function isProductionProfile() {
  const profile = envString("REND_ENV_PROFILE") || envString("REND_ENV") || process.env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function siteInternalToken() {
  const configured = envString("REND_SITE_INTERNAL_TOKEN");
  if (configured) return configured;
  return isProductionProfile() ? "" : LOCAL_SITE_INTERNAL_TOKEN;
}

export function assetSiteInternalToken() {
  return siteInternalToken();
}

export function publicAssetApiBaseUrl() {
  const configured = envString("REND_PUBLIC_API_BASE_URL") || envString("REND_API_BASE_URL", DEFAULT_API_BASE_URL);
  return configured.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeString(value: unknown, maxLength = 256) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function safeState(value: unknown) {
  const state = safeString(value, 64);
  return state && /^[a-z0-9_:-]+$/i.test(state) ? state : undefined;
}

function safeAssetId(value: unknown) {
  const assetId = safeString(value, 64);
  return assetId && normalizeAssetId(assetId) ? assetId.toLowerCase() : undefined;
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeInteger(value: unknown) {
  const number = safeNumber(value);
  return number !== undefined ? Math.trunc(number) : undefined;
}

function safeOptionalPositiveInteger(value: unknown) {
  const number = safeInteger(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function safeTimestamp(value: unknown) {
  const timestamp = safeString(value, 64);
  if (!timestamp || /[?#]/.test(timestamp) || /https?:\/\//i.test(timestamp)) return undefined;
  return timestamp;
}

function redactUnsafeText(value: string, maxLength = 240) {
  return value
    .replace(/https?:\/\/[^\s"',;)]+/gi, "[redacted-url]")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer|basic)?\s*[^\s"',;)]+/gi, "[redacted-auth]")
    .replace(/\b(set-cookie|cookie)\s*[:=][^\r\n;]+/gi, "[redacted-cookie]")
    .replace(
      /\b(token|signature|secret|api[_-]?key|authorization|cookie)\b\s*[:=]\s*[^\s"',;)]+/gi,
      "$1=[redacted]"
    )
    .replace(
      /([?&](?:token|signature|secret|api[_-]?key|authorization|cookie)=)[^\s"',;)]+/gi,
      "$1[redacted]"
    )
    .slice(0, maxLength);
}

function safeErrorMessage(value: unknown, fallback: string) {
  const message = safeString(value, 512);
  return message ? redactUnsafeText(message) : fallback;
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json");
  return Response.json(body, { ...init, headers });
}

export function assetJsonResponse(body: unknown, init?: ResponseInit) {
  return jsonResponse(body, init);
}

export function assetErrorResponse(
  status: number,
  error: AssetErrorResponse["error"],
  message: string
) {
  return jsonResponse(
    {
      status: "error",
      error,
      message,
    } satisfies AssetErrorResponse,
    { status }
  );
}

export function assetApiErrorResponse(error: unknown) {
  if (error instanceof AssetApiError) {
    return jsonResponse(error.body, { status: error.status });
  }

  return assetErrorResponse(502, "rend_api_unavailable", "Rend API request failed");
}

export function normalizeAssetId(value: string) {
  const assetId = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(assetId)
    ? assetId
    : null;
}

function unsupportedUpstreamStatus(status: number) {
  return ![400, 403, 404, 409, 413, 415].includes(status);
}

async function upstreamError(upstream: Response): Promise<AssetApiError> {
  const publicStatus = unsupportedUpstreamStatus(upstream.status) ? 502 : upstream.status;
  const fallback =
    publicStatus === 413
      ? "Upload is too large"
      : publicStatus === 404
        ? "Asset was not found"
        : "Rend API request failed";

  let message = fallback;
  let upstreamCode: string | undefined;
  try {
    const text = (await upstream.text()).slice(0, MAX_ERROR_BODY_BYTES);
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      upstreamCode = safeState(parsed.error);
      message = safeErrorMessage(parsed.message ?? parsed.error, fallback);
    }
  } catch {
    message = fallback;
  }

  const publicError =
    publicStatus === 413
      ? "upload_too_large"
      : publicStatus === 403 && upstreamCode === "limit_exceeded"
        ? "limit_exceeded"
        : "rend_api_rejected_request";

  return new AssetApiError(publicStatus, {
    status: "error",
    error: publicError,
    message,
  });
}

async function readUpstreamJson(upstream: Response) {
  if (!upstream.ok) throw await upstreamError(upstream);

  try {
    return (await upstream.json()) as unknown;
  } catch {
    throw new AssetApiError(502, {
      status: "error",
      error: "rend_api_invalid_response",
      message: "Rend API returned an invalid response",
    });
  }
}

async function controlPlaneFetch(
  auth: AssetApiAuthContext,
  path: string,
  init: RequestInitWithDuplex = {}
) {
  const internalToken = siteInternalToken();
  if (!internalToken) {
    throw new AssetApiError(500, {
      status: "error",
      error: "rend_api_not_configured",
      message: "Rend API is not configured",
    });
  }

  const headers = new Headers(init.headers);
  headers.set("x-rend-site-token", internalToken);
  headers.set("x-rend-organization-id", auth.organizationId);
  headers.set("accept", "application/json");

  let upstream: Response;
  try {
    upstream = await fetch(controlPlaneUrl(path), {
      ...init,
      cache: "no-store",
      headers,
    });
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      throw new AssetApiError(413, {
        status: "error",
        error: "upload_too_large",
        message: `Upload exceeds ${assetMaxUploadBytes()} bytes`,
      });
    }

    throw new AssetApiError(502, {
      status: "error",
      error: "rend_api_unavailable",
      message: "Rend API request failed",
    });
  }

  return upstream;
}

export function supportedUploadContentType(contentType: string | null) {
  const mediaType = (contentType || "").split(";")[0]?.trim().toLowerCase();
  return Boolean(mediaType && (mediaType.startsWith("video/") || mediaType === "application/octet-stream"));
}

export function requestContentLengthWithinLimit(
  contentLength: string | null,
  maxBytes = assetMaxUploadBytes()
):
  | { ok: true; bytes?: number }
  | { ok: false; status: 400 | 413; error: "invalid_content_length" | "upload_too_large" } {
  if (!contentLength) return { ok: true };

  const bytes = Number(contentLength);
  if (!Number.isInteger(bytes) || bytes < 0) {
    return { ok: false, status: 400, error: "invalid_content_length" };
  }
  if (bytes > maxBytes) {
    return { ok: false, status: 413, error: "upload_too_large" };
  }

  return { ok: true, bytes };
}

export function limitedRequestBody(body: ReadableStream<Uint8Array>, maxBytes = assetMaxUploadBytes()) {
  const reader = body.getReader();
  let bytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }

      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        controller.error(new UploadTooLargeError(maxBytes));
        return;
      }

      controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function sanitizeAssetSummary(value: unknown): AssetSummary | null {
  if (!isRecord(value)) return null;

  const assetId = safeAssetId(value.asset_id);
  const sourceState = safeState(value.source_state);
  const playableState = safeState(value.playable_state);
  const createdAt = safeTimestamp(value.created_at);
  const updatedAt = safeTimestamp(value.updated_at);
  const artifactCount = safeOptionalPositiveInteger(value.artifact_count);

  if (!assetId || !sourceState || !playableState || !createdAt || !updatedAt) return null;

  return {
    asset_id: assetId,
    source_state: sourceState,
    playable_state: playableState,
    created_at: createdAt,
    updated_at: updatedAt,
    source_byte_size: safeOptionalPositiveInteger(value.source_byte_size),
    duration_ms: safeOptionalPositiveInteger(value.duration_ms),
    artifact_count: artifactCount ?? 0,
    suspended_at: safeTimestamp(value.suspended_at),
    suspension_reason: safeString(value.suspension_reason, 1000),
    organization_suspended_at: safeTimestamp(value.organization_suspended_at),
    organization_suspension_reason: safeString(value.organization_suspension_reason, 1000),
  };
}

function sanitizeUploadResponse(value: unknown): AssetUploadResponse | null {
  if (!isRecord(value)) return null;

  const assetId = safeAssetId(value.asset_id);
  const sourceState = safeState(value.source_state);
  const playableState = safeState(value.playable_state);
  if (!assetId || !sourceState || !playableState) return null;

  const now = new Date().toISOString();
  return {
    status: "ok",
    asset: {
      asset_id: assetId,
      source_state: sourceState,
      playable_state: playableState,
      created_at: now,
      updated_at: now,
      source_byte_size: safeOptionalPositiveInteger(value.byte_size),
      artifact_count: 1,
    },
  };
}

function sanitizeArtifact(value: unknown): AssetArtifact | null {
  if (!isRecord(value)) return null;

  const kind = safeState(value.kind);
  const contentType = safeString(value.content_type, 128);
  if (!kind || !contentType || /https?:\/\//i.test(contentType) || /[?#]/.test(contentType)) {
    return null;
  }

  return {
    kind,
    content_type: contentType,
    byte_size: safeOptionalPositiveInteger(value.byte_size),
  };
}

function sanitizeAssetDetail(value: unknown): AssetDetail | null {
  const summary = sanitizeAssetSummary({
    ...(isRecord(value) ? value : {}),
    artifact_count: isRecord(value) && Array.isArray(value.artifacts) ? value.artifacts.length : 0,
  });
  if (!summary || !isRecord(value)) return null;

  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.flatMap((artifact) => {
        const safeArtifact = sanitizeArtifact(artifact);
        return safeArtifact ? [safeArtifact] : [];
      })
    : [];

  return {
    ...summary,
    artifact_count: artifacts.length,
    artifacts,
  };
}

function sanitizeDeleteResponse(value: unknown): AssetDeleteResponse | null {
  if (!isRecord(value)) return null;

  const assetId = safeAssetId(value.asset_id);
  if (!assetId || value.deleted !== true) return null;

  return {
    status: "ok",
    asset_id: assetId,
    deleted: true,
    already_deleted: value.already_deleted === true,
    origin_objects_deleted: safeOptionalPositiveInteger(value.origin_objects_deleted) ?? 0,
    purge_attempted: value.purge_attempted === true,
  };
}

function sanitizeCountMap(value: unknown) {
  if (!isRecord(value)) return {};

  const output: Record<string, number> = {};
  for (const [key, rawCount] of Object.entries(value)) {
    const safeKey = safeState(key);
    const count = safeOptionalPositiveInteger(rawCount);
    if (safeKey && count !== undefined) output[safeKey] = count;
  }

  return output;
}

function sanitizeAnalytics(value: unknown): AssetPlaybackAnalytics | null {
  if (!isRecord(value)) return null;

  const assetId = safeAssetId(value.asset_id);
  const windowStartedAt = safeTimestamp(value.window_started_at);
  const windowEndedAt = safeTimestamp(value.window_ended_at);
  const requestCount = safeOptionalPositiveInteger(value.request_count);
  const bytesServed = safeOptionalPositiveInteger(value.bytes_served);
  if (!assetId || !windowStartedAt || !windowEndedAt || requestCount === undefined || bytesServed === undefined) {
    return null;
  }

  return {
    asset_id: assetId,
    window_started_at: windowStartedAt,
    window_ended_at: windowEndedAt,
    request_count: requestCount,
    bytes_served: bytesServed,
    cache_status_counts: sanitizeCountMap(value.cache_status_counts),
    status_code_counts: sanitizeCountMap(value.status_code_counts),
    first_seen: safeTimestamp(value.first_seen),
    last_seen: safeTimestamp(value.last_seen),
  };
}

function safeOptionalRatio(value: unknown) {
  const number = safeNumber(value);
  if (number === undefined || number < 0 || number > 1) return undefined;
  return number;
}

function safeOptionalMetric(value: unknown) {
  const number = safeNumber(value);
  if (number === undefined || number < 0) return undefined;
  return number;
}

function sanitizeTimeSeriesPoint(value: unknown): AnalyticsTimeSeriesPoint | null {
  if (!isRecord(value)) return null;
  const bucketStart = safeTimestamp(value.bucket_start);
  const views = safeOptionalPositiveInteger(value.views);
  const watchTimeMs = safeOptionalPositiveInteger(value.watch_time_ms);
  const requestCount = safeOptionalPositiveInteger(value.request_count);
  const bytesServed = safeOptionalPositiveInteger(value.bytes_served);
  if (
    !bucketStart ||
    views === undefined ||
    watchTimeMs === undefined ||
    requestCount === undefined ||
    bytesServed === undefined
  ) {
    return null;
  }
  return {
    bucket_start: bucketStart,
    views,
    watch_time_ms: watchTimeMs,
    request_count: requestCount,
    bytes_served: bytesServed,
  };
}

function sanitizeAnalyticsAsset(value: unknown): AnalyticsAssetSummary | null {
  if (!isRecord(value)) return null;
  const assetId = safeAssetId(value.asset_id);
  const views = safeOptionalPositiveInteger(value.views);
  const watchTimeMs = safeOptionalPositiveInteger(value.watch_time_ms);
  const requestCount = safeOptionalPositiveInteger(value.request_count);
  const bytesServed = safeOptionalPositiveInteger(value.bytes_served);
  if (
    !assetId ||
    views === undefined ||
    watchTimeMs === undefined ||
    requestCount === undefined ||
    bytesServed === undefined
  ) {
    return null;
  }
  return {
    asset_id: assetId,
    views,
    watch_time_ms: watchTimeMs,
    request_count: requestCount,
    bytes_served: bytesServed,
  };
}

function sanitizeAnalyticsOverview(value: unknown): AnalyticsOverview | null {
  if (!isRecord(value)) return null;
  const windowStartedAt = safeTimestamp(value.window_started_at);
  const windowEndedAt = safeTimestamp(value.window_ended_at);
  const views = safeOptionalPositiveInteger(value.views);
  const sessions = safeOptionalPositiveInteger(value.sessions);
  const watchTimeMs = safeOptionalPositiveInteger(value.watch_time_ms);
  const startupSuccessRate = safeOptionalRatio(value.startup_success_rate);
  const rebufferRatio = safeOptionalRatio(value.rebuffer_ratio);
  const stalledSessions = safeOptionalPositiveInteger(value.stalled_sessions);
  const stallCount = safeOptionalPositiveInteger(value.stall_count);
  const stallDurationMs = safeOptionalPositiveInteger(value.stall_duration_ms);
  const playbackFailures = safeOptionalPositiveInteger(value.playback_failures);
  const requestCount = safeOptionalPositiveInteger(value.request_count);
  const bytesServed = safeOptionalPositiveInteger(value.bytes_served);
  const cacheHitRate = safeOptionalRatio(value.cache_hit_rate);
  const errorRate = safeOptionalRatio(value.error_rate);
  if (
    !windowStartedAt ||
    !windowEndedAt ||
    views === undefined ||
    sessions === undefined ||
    watchTimeMs === undefined ||
    startupSuccessRate === undefined ||
    rebufferRatio === undefined ||
    stalledSessions === undefined ||
    stallCount === undefined ||
    stallDurationMs === undefined ||
    playbackFailures === undefined ||
    requestCount === undefined ||
    bytesServed === undefined ||
    cacheHitRate === undefined ||
    errorRate === undefined
  ) {
    return null;
  }

  return {
    window_started_at: windowStartedAt,
    window_ended_at: windowEndedAt,
    views,
    sessions,
    watch_time_ms: watchTimeMs,
    startup_success_rate: startupSuccessRate,
    startup_p50_ms: safeOptionalMetric(value.startup_p50_ms),
    startup_p95_ms: safeOptionalMetric(value.startup_p95_ms),
    rebuffer_ratio: rebufferRatio,
    stalled_sessions: stalledSessions,
    stall_count: stallCount,
    stall_duration_ms: stallDurationMs,
    playback_failures: playbackFailures,
    request_count: requestCount,
    bytes_served: bytesServed,
    cache_hit_rate: cacheHitRate,
    error_rate: errorRate,
    request_p50_ms: safeOptionalMetric(value.request_p50_ms),
    request_p95_ms: safeOptionalMetric(value.request_p95_ms),
    timeseries: Array.isArray(value.timeseries)
      ? value.timeseries.flatMap((point) => {
          const safePoint = sanitizeTimeSeriesPoint(point);
          return safePoint ? [safePoint] : [];
        })
      : [],
    top_assets: Array.isArray(value.top_assets)
      ? value.top_assets.flatMap((asset) => {
          const safeAsset = sanitizeAnalyticsAsset(asset);
          return safeAsset ? [safeAsset] : [];
        })
      : [],
  };
}

export async function listAssets(
  auth: AssetApiAuthContext,
  limit = 50
): Promise<AssetListResponse> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 100);
  const upstream = await controlPlaneFetch(auth, `/v1/assets?limit=${boundedLimit}`);
  const data = await readUpstreamJson(upstream);
  const assets = isRecord(data) && Array.isArray(data.assets)
    ? data.assets.flatMap((asset) => {
        const safeAsset = sanitizeAssetSummary(asset);
        return safeAsset ? [safeAsset] : [];
      })
    : [];

  return { status: "ok", assets };
}

export async function fetchAssetDetail(
  auth: AssetApiAuthContext,
  assetId: string
): Promise<AssetDetail> {
  const normalizedAssetId = normalizeAssetId(assetId);
  if (!normalizedAssetId) {
    throw new AssetApiError(400, {
      status: "error",
      error: "invalid_asset_id",
      message: "Asset id is invalid",
    });
  }

  const upstream = await controlPlaneFetch(auth, `/v1/assets/${encodeURIComponent(normalizedAssetId)}`);
  const data = await readUpstreamJson(upstream);
  const asset = sanitizeAssetDetail(data);
  if (!asset) {
    throw new AssetApiError(502, {
      status: "error",
      error: "rend_api_invalid_response",
      message: "Rend API returned an invalid asset",
    });
  }

  return asset;
}

export async function deleteAsset(
  auth: AssetApiAuthContext,
  assetId: string
): Promise<AssetDeleteResponse> {
  const normalizedAssetId = normalizeAssetId(assetId);
  if (!normalizedAssetId) {
    throw new AssetApiError(400, {
      status: "error",
      error: "invalid_asset_id",
      message: "Asset id is invalid",
    });
  }

  const upstream = await controlPlaneFetch(auth, `/v1/assets/${encodeURIComponent(normalizedAssetId)}`, {
    method: "DELETE",
  });
  const data = await readUpstreamJson(upstream);
  const response = sanitizeDeleteResponse(data);
  if (!response) {
    throw new AssetApiError(502, {
      status: "error",
      error: "rend_api_invalid_response",
      message: "Rend API returned an invalid delete response",
    });
  }

  return response;
}

export async function fetchAssetPlaybackAnalytics(
  auth: AssetApiAuthContext,
  assetId: string,
  windowSeconds = 3600
): Promise<AssetPlaybackAnalytics> {
  const normalizedAssetId = normalizeAssetId(assetId);
  if (!normalizedAssetId) {
    throw new AssetApiError(400, {
      status: "error",
      error: "invalid_asset_id",
      message: "Asset id is invalid",
    });
  }

  const boundedWindow = Math.min(Math.max(Math.trunc(windowSeconds) || 3600, 60), 7 * 24 * 60 * 60);
  const upstream = await controlPlaneFetch(
    auth,
    `/v1/assets/${encodeURIComponent(normalizedAssetId)}/analytics/playback?window_seconds=${boundedWindow}`
  );
  const data = await readUpstreamJson(upstream);
  const analytics = sanitizeAnalytics(data);
  if (!analytics) {
    throw new AssetApiError(502, {
      status: "error",
      error: "rend_api_invalid_response",
      message: "Rend API returned invalid analytics",
    });
  }

  return analytics;
}

export async function fetchAnalyticsOverview(
  auth: AssetApiAuthContext,
  windowSeconds = 24 * 60 * 60
): Promise<AnalyticsOverview> {
  const boundedWindow = Math.min(Math.max(Math.trunc(windowSeconds) || 24 * 60 * 60, 60), 90 * 24 * 60 * 60);
  const upstream = await controlPlaneFetch(
    auth,
    `/v1/analytics/overview?window_seconds=${boundedWindow}`
  );
  const data = await readUpstreamJson(upstream);
  const analytics = sanitizeAnalyticsOverview(data);
  if (!analytics) {
    throw new AssetApiError(502, {
      status: "error",
      error: "rend_api_invalid_response",
      message: "Rend API returned invalid analytics",
    });
  }

  return analytics;
}

export async function uploadAsset(
  auth: AssetApiAuthContext,
  request: Request
): Promise<AssetUploadResponse> {
  const contentType = request.headers.get("content-type");
  if (!supportedUploadContentType(contentType)) {
    throw new AssetApiError(415, {
      status: "error",
      error: "unsupported_content_type",
      message: "Upload content type must be video/* or application/octet-stream",
    });
  }

  const maxBytes = assetMaxUploadBytes();
  const length = requestContentLengthWithinLimit(request.headers.get("content-length"), maxBytes);
  if (!length.ok) {
    throw new AssetApiError(length.status, {
      status: "error",
      error: length.error,
      message: length.error === "upload_too_large" ? `Upload exceeds ${maxBytes} bytes` : "Invalid content-length",
    });
  }

  if (!request.body) {
    throw new AssetApiError(400, {
      status: "error",
      error: "missing_upload_body",
      message: "Upload body is required",
    });
  }

  const headers = new Headers();
  headers.set("content-type", contentType || "application/octet-stream");
  if (length.bytes !== undefined) headers.set("content-length", String(length.bytes));

  const upstream = await controlPlaneFetch(auth, "/v1/videos", {
    method: "POST",
    headers,
    body: limitedRequestBody(request.body, maxBytes),
    duplex: "half",
  });
  const data = await readUpstreamJson(upstream);
  const response = sanitizeUploadResponse(data);
  if (!response) {
    throw new AssetApiError(502, {
      status: "error",
      error: "rend_api_invalid_response",
      message: "Rend API returned an invalid upload response",
    });
  }

  return response;
}
