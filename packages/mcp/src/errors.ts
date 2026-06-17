import { redactSecrets } from "./redaction.js";

export type RendMcpErrorCode =
  | "deleted"
  | "invalid_request"
  | "limit_exceeded"
  | "not_playable"
  | "request_failed"
  | "suspended"
  | "unauthorized"
  | "unsupported_media_type";

export type SafeErrorOutput = {
  status: "error";
  error: {
    code: RendMcpErrorCode;
    message: string;
    http_status?: number;
    asset_id?: string;
    details?: unknown;
  };
};

export class RendMcpError extends Error {
  readonly code: RendMcpErrorCode;
  readonly httpStatus?: number;
  readonly assetId?: string;
  readonly details?: unknown;

  constructor(
    code: RendMcpErrorCode,
    message: string,
    options: { httpStatus?: number; assetId?: string; details?: unknown } = {}
  ) {
    super(message);
    this.name = "RendMcpError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.assetId = options.assetId;
    this.details = options.details;
  }
}

export function safeErrorOutput(error: unknown, context: { assetId?: string } = {}): SafeErrorOutput {
  const normalized = normalizeError(error, context);
  return {
    status: "error",
    error: removeUndefined({
      code: normalized.code,
      message: normalized.message,
      http_status: normalized.httpStatus,
      asset_id: normalized.assetId,
      details: redactSecrets(normalized.details),
    }),
  };
}

export function normalizeError(error: unknown, context: { assetId?: string } = {}): RendMcpError {
  if (error instanceof RendMcpError) return error;

  if (isApiErrorLike(error)) {
    const bodyText = bodyMessage(error.body);
    const code = codeFromHttpError(error.status, error.body, bodyText);
    return new RendMcpError(code, messageForCode(code, bodyText), {
      httpStatus: error.status,
      assetId: context.assetId ?? bodyAssetId(error.body),
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new RendMcpError("request_failed", redactText(message || "Rend request failed"), {
    assetId: context.assetId,
  });
}

export function redactText(value: string) {
  return value
    .replace(/Authorization:\s*Bearer\s+[^\s"']+/gi, "Authorization: Bearer [redacted]")
    .replace(/\brend_(live|test)_[A-Za-z0-9._-]+/g, "rend_$1_[redacted]")
    .replace(/([?&])(?:token|playback_token|signature)=[^&\s"']+/gi, "$1redacted=1")
    .replace(/(__rend_playback=)[^;\s"']+/gi, "$1[redacted]");
}

function codeFromHttpError(status: number, body: unknown, bodyText: string): RendMcpErrorCode {
  const lower = bodyText.toLowerCase();
  const bodyStatus = recordString(body, "status");
  const bodyError = recordString(body, "error");

  if (status === 401) return "unauthorized";
  if (status === 409 || bodyStatus === "not_playable") return "not_playable";
  if (status === 413 || bodyError === "limit_exceeded" || lower.includes("limit_exceeded")) {
    return "limit_exceeded";
  }
  if (status === 415) return "unsupported_media_type";
  if (status === 404) return "deleted";
  if (status === 403 && lower.includes("suspended")) return "suspended";
  if (status === 403 && lower.includes("limit")) return "limit_exceeded";
  if (status === 403) return "unauthorized";
  return "request_failed";
}

function messageForCode(code: RendMcpErrorCode, bodyText: string) {
  if (code === "deleted") return "Asset is deleted or unavailable.";
  if (code === "not_playable") return bodyText || "Asset is not playable yet.";
  if (code === "limit_exceeded") return bodyText || "Upload or account limit exceeded.";
  if (code === "unauthorized") return bodyText || "Rend API key is missing, invalid, revoked, or lacks scope.";
  if (code === "suspended") return bodyText || "Asset or organization is suspended.";
  if (code === "unsupported_media_type") return bodyText || "Upload content type is not supported.";
  return bodyText || "Rend request failed.";
}

function bodyMessage(body: unknown) {
  if (isRecord(body)) {
    const message = body.message ?? body.error;
    if (typeof message === "string") return redactText(message);
  }
  if (typeof body === "string") return redactText(body);
  return "";
}

function bodyAssetId(body: unknown) {
  return recordString(body, "asset_id");
}

function recordString(value: unknown, key: string) {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function isApiErrorLike(value: unknown): value is { status: number; body: unknown } {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function removeUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
