import { createHmac } from "node:crypto";
import type { DashboardAccessContext } from "./dashboard-auth.ts";
import {
  AssetApiError,
  assetMaxUploadBytes,
  assetSiteInternalToken,
  publicAssetApiBaseUrl,
  supportedUploadContentType,
} from "./asset-api.ts";

const DASHBOARD_UPLOAD_TOKEN_PREFIX = "rend_upload_";
const DASHBOARD_UPLOAD_TOKEN_TTL_SECONDS = 10 * 60;

type UploadTokenClaims = {
  v: 1;
  org_id: string;
  exp: number;
  content_type: string;
  content_length?: number;
};

export type DashboardUploadIntentResponse = {
  status: "ok";
  upload_url: string;
  token: string;
  expires_at: string;
  content_type: string;
  max_upload_bytes: number;
};

function normalizedUploadContentType(value: unknown) {
  const contentType = typeof value === "string" && value.trim() ? value : "application/octet-stream";
  return contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function normalizedContentLength(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return undefined;
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signUploadClaims(claims: UploadTokenClaims, secret: string) {
  const payload = base64UrlJson(claims);
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${DASHBOARD_UPLOAD_TOKEN_PREFIX}${payload}.${signature}`;
}

export function createDashboardUploadIntent(
  context: DashboardAccessContext,
  input: { contentType?: unknown; contentLength?: unknown }
): DashboardUploadIntentResponse {
  const contentType = normalizedUploadContentType(input.contentType);
  if (!supportedUploadContentType(contentType)) {
    throw new AssetApiError(415, {
      status: "error",
      error: "unsupported_content_type",
      message: "Upload content type must be video/* or application/octet-stream",
    });
  }

  const contentLength = normalizedContentLength(input.contentLength);
  if (contentLength !== undefined && (!Number.isInteger(contentLength) || contentLength < 0)) {
    throw new AssetApiError(400, {
      status: "error",
      error: "invalid_content_length",
      message: "Invalid content-length",
    });
  }

  const maxBytes = assetMaxUploadBytes();
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw new AssetApiError(413, {
      status: "error",
      error: "upload_too_large",
      message: `Upload exceeds ${maxBytes} bytes`,
    });
  }

  const secret = assetSiteInternalToken();
  if (!secret) {
    throw new AssetApiError(500, {
      status: "error",
      error: "rend_api_not_configured",
      message: "Rend API is not configured",
    });
  }

  const expiresAtSeconds = Math.floor(Date.now() / 1000) + DASHBOARD_UPLOAD_TOKEN_TTL_SECONDS;
  const claims: UploadTokenClaims = {
    v: 1,
    org_id: context.organizationId,
    exp: expiresAtSeconds,
    content_type: contentType,
    ...(contentLength !== undefined ? { content_length: contentLength } : {}),
  };

  return {
    status: "ok",
    upload_url: `${publicAssetApiBaseUrl()}/v1/videos`,
    token: signUploadClaims(claims, secret),
    expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
    content_type: contentType,
    max_upload_bytes: maxBytes,
  };
}
