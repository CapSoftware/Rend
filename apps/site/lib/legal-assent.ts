import { createHmac, timingSafeEqual } from "node:crypto";
import {
  LEGAL_ASSENT_COOKIE,
  LEGAL_ASSENT_VERSION,
} from "./legal-assent-constants.ts";

const LOCAL_AUTH_SECRET = "local-better-auth-secret-only-for-rend-development";
const COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

type Env = Record<string, string | undefined>;

export type LegalAssent = {
  acceptedAt: string;
  email: string;
  version: typeof LEGAL_ASSENT_VERSION;
};

function envString(name: string, env: Env = process.env) {
  return (env[name] || "").trim();
}

function isProductionProfile(env: Env = process.env) {
  const profile = envString("REND_ENV_PROFILE", env) || envString("REND_ENV", env) || env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function assentSecret(env: Env = process.env) {
  return envString("BETTER_AUTH_SECRET", env) || envString("AUTH_SECRET", env) || LOCAL_AUTH_SECRET;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string, env?: Env) {
  return createHmac("sha256", assentSecret(env)).update(value).digest("base64url");
}

function signatureMatches(value: string, signature: string, env?: Env) {
  const expected = sign(value, env);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function cookieValue(header: string, name: string) {
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function legalAssentAccepted(input: Record<string, unknown>) {
  return input.legal_assent === "accepted" && input.legal_assent_version === LEGAL_ASSENT_VERSION;
}

export function legalAssentRequiredResponse() {
  return Response.json(
    {
      status: "error",
      error: "legal_assent_required",
      message: "Review and accept the Rend Terms and Privacy Notice before continuing.",
    },
    {
      status: 400,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    }
  );
}

export function legalAssentCookieHeader(email: string, acceptedAt = new Date(), env?: Env) {
  const payload = base64UrlEncode(
    JSON.stringify({
      at: acceptedAt.toISOString(),
      email: normalizeEmail(email),
      version: LEGAL_ASSENT_VERSION,
    })
  );
  const parts = [
    `${LEGAL_ASSENT_COOKIE}=${payload}.${sign(payload, env)}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isProductionProfile(env)) parts.push("Secure");
  return parts.join("; ");
}

export function legalAssentFromHeaders(headers: Headers, email: string, env?: Env): LegalAssent | null {
  const raw = cookieValue(headers.get("cookie") || "", LEGAL_ASSENT_COOKIE);
  const [payload, signature] = raw.split(".");
  if (!payload || !signature || !signatureMatches(payload, signature, env)) return null;

  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(payload));
    if (!isRecord(parsed)) return null;
    if (parsed.version !== LEGAL_ASSENT_VERSION) return null;
    if (typeof parsed.email !== "string" || normalizeEmail(parsed.email) !== normalizeEmail(email)) return null;
    if (typeof parsed.at !== "string") return null;

    const acceptedAt = new Date(parsed.at);
    if (Number.isNaN(acceptedAt.getTime())) return null;
    if (Date.now() - acceptedAt.getTime() > COOKIE_MAX_AGE_SECONDS * 1000) return null;

    return {
      acceptedAt: acceptedAt.toISOString(),
      email: normalizeEmail(email),
      version: LEGAL_ASSENT_VERSION,
    };
  } catch {
    return null;
  }
}
