import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DASHBOARD_SESSION_COOKIE = "rend_dashboard_session";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

type Env = Record<string, string | undefined>;

export type DashboardAccessResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "unauthorized" | "expired" };

function envString(name: string, env: Env = process.env) {
  return (env[name] || "").trim();
}

function operatorToken(env: Env = process.env) {
  return envString("REND_SITE_OPERATOR_TOKEN", env);
}

function signingSecret(env: Env = process.env) {
  return envString("REND_SITE_AUTH_SECRET", env) || operatorToken(env);
}

function constantTimeEqual(left: string, right: string) {
  const key = "rend-dashboard-compare";
  const leftDigest = createHmac("sha256", key).update(left).digest();
  const rightDigest = createHmac("sha256", key).update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function sessionSignature(payload: string, env: Env = process.env) {
  return createHmac("sha256", signingSecret(env)).update(payload).digest("base64url");
}

function cookieValue(cookieHeader: string, name: string) {
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return null;
}

export function dashboardAuthConfigured(env: Env = process.env) {
  return Boolean(operatorToken(env));
}

export function operatorTokenMatches(provided: string | null | undefined, env: Env = process.env) {
  const expected = operatorToken(env);
  const candidate = (provided || "").trim();
  return Boolean(expected && candidate && constantTimeEqual(candidate, expected));
}

export function createDashboardSessionCookieValue(nowMs = Date.now(), env: Env = process.env) {
  if (!dashboardAuthConfigured(env)) throw new Error("dashboard_auth_not_configured");

  const expiresAtMs = nowMs + SESSION_MAX_AGE_MS;
  const payload = `${expiresAtMs}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${sessionSignature(payload, env)}`;
}

export function dashboardSessionCookieAttributes(env: Env = process.env) {
  const secure = envString("NODE_ENV", env) === "production" ? "; Secure" : "";
  return `Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

export function expiredDashboardSessionCookieAttributes(env: Env = process.env) {
  const secure = envString("NODE_ENV", env) === "production" ? "; Secure" : "";
  return `Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

export function dashboardAccessFromCookieValue(
  rawCookieValue: string | null | undefined,
  nowMs = Date.now(),
  env: Env = process.env
): DashboardAccessResult {
  if (!dashboardAuthConfigured(env)) return { ok: false, reason: "not_configured" };
  if (!rawCookieValue) return { ok: false, reason: "unauthorized" };

  const parts = rawCookieValue.split(".");
  if (parts.length !== 3) return { ok: false, reason: "unauthorized" };

  const [rawExpiresAtMs, nonce, signature] = parts;
  const expiresAtMs = Number(rawExpiresAtMs);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0 || !nonce || !signature) {
    return { ok: false, reason: "unauthorized" };
  }
  if (expiresAtMs <= nowMs) return { ok: false, reason: "expired" };

  const payload = `${rawExpiresAtMs}.${nonce}`;
  return constantTimeEqual(signature, sessionSignature(payload, env))
    ? { ok: true }
    : { ok: false, reason: "unauthorized" };
}

export function dashboardAccessFromRequest(
  request: Request,
  env: Env = process.env
): DashboardAccessResult {
  if (!dashboardAuthConfigured(env)) return { ok: false, reason: "not_configured" };

  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (operatorTokenMatches(bearer, env)) return { ok: true };

  return dashboardAccessFromCookieValue(
    cookieValue(request.headers.get("cookie") || "", DASHBOARD_SESSION_COOKIE),
    Date.now(),
    env
  );
}

export function dashboardAccessErrorResponse(access: Exclude<DashboardAccessResult, { ok: true }>) {
  const isNotConfigured = access.reason === "not_configured";
  return Response.json(
    {
      status: "error",
      error: isNotConfigured ? "dashboard_auth_not_configured" : "unauthorized",
      message: isNotConfigured ? "Dashboard authentication is not configured" : "Authentication required",
    },
    {
      status: isNotConfigured ? 503 : 401,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    }
  );
}
