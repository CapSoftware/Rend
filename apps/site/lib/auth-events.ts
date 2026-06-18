import { createHash } from "node:crypto";

export type AuthEventLevel = "info" | "warn" | "error";

export type AuthEventName =
  | "otp_requested"
  | "otp_request_rejected"
  | "otp_send_attempted"
  | "otp_send_accepted"
  | "otp_send_failed"
  | "otp_verification_attempted"
  | "otp_verification_failed"
  | "auth_request_failed"
  | "auth_route_timed_out"
  | "session_created"
  | "org_provisioning_started"
  | "org_provisioning_completed"
  | "org_provisioning_failed"
  | "onboarding_completed"
  | "onboarding_failed"
  | "autumn_customer_sync_started"
  | "autumn_customer_sync_completed"
  | "autumn_customer_sync_failed";

type JsonLike =
  | null
  | string
  | number
  | boolean
  | JsonLike[]
  | { [key: string]: JsonLike | undefined };

const SENSITIVE_KEY_PATTERN =
  /(?:otp|code|secret|token|cookie|authorization|password|credential|api[_-]?key|session[_-]?token|header|body)/i;

export function normalizeAuthEmail(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

export function authEmailSummary(value: unknown) {
  const email = normalizeAuthEmail(value);
  if (!email) {
    return {
      email_present: false,
    };
  }
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1) : "";
  return {
    email_present: true,
    email_domain: domain || "invalid",
    email_hash: createHash("sha256").update(email, "utf8").digest("hex").slice(0, 16),
  };
}

export function authSubjectId(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return createHash("sha256").update(value.trim(), "utf8").digest("hex").slice(0, 16);
}

export function redactAuthText(value: unknown) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bre_[A-Za-z0-9_=-]{8,}/g, "[redacted-resend-key]")
    .replace(/\brend_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted-rend-api-key]")
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted-stripe-key]")
    .replace(/\bam_sk(?:_(?:live|test))?_[A-Za-z0-9_]+/g, "[redacted-autumn-key]")
    .replace(/\bwhsec_[A-Za-z0-9_]+/g, "[redacted-stripe-webhook-secret]")
    .replace(/((?:^|\n)\s*(?:cookie|set-cookie|authorization):\s*)[^\n\r]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|signature|sig|secret|session|client_secret|code|otp)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\b\d{6}\b/g, "[redacted-code]")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function sanitizeAuthEventData(value: unknown): JsonLike | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return redactAuthText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAuthEventData(entry)).filter((entry) => entry !== undefined) as JsonLike[];
  }
  if (typeof value !== "object") return redactAuthText(value);

  const output: Record<string, JsonLike> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    const sanitized = sanitizeAuthEventData(entry);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function authEnvironment() {
  const profile =
    process.env.REND_ENV_PROFILE || process.env.REND_ENV || process.env.NODE_ENV || "local";
  return String(profile).trim().toLowerCase() || "local";
}

export function logAuthEvent(
  event: AuthEventName,
  data: Record<string, unknown> = {},
  level: AuthEventLevel = "info"
) {
  const payload = sanitizeAuthEventData({
    service: "rend-site",
    component: "auth",
    event,
    level,
    at: new Date().toISOString(),
    environment: authEnvironment(),
    ...data,
  });
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error("[rend-auth-event]", line);
  } else if (level === "warn") {
    console.warn("[rend-auth-event]", line);
  } else {
    console.info("[rend-auth-event]", line);
  }
}
