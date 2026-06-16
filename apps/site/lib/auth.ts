import { randomInt, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { emailOTP, organization } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { Resend } from "resend";
import {
  authEmailSummary,
  authSubjectId,
  logAuthEvent,
  normalizeAuthEmail,
  redactAuthText,
} from "./auth-events.ts";
import { authSchema } from "./db/schema.ts";
import { getSiteDb, getSitePgPool } from "./server-db.ts";

const LOCAL_AUTH_SECRET = "local-better-auth-secret-only-for-rend-development";
const LOCAL_AUTH_URL = "http://localhost:3000";

type AuthInstance = ReturnType<typeof betterAuth>;
type AuthOtpEmailType = "sign-in" | "email-verification" | "forget-password" | "change-email";
type AuthRateLimitRule = { window: number; max: number };
type AuthRateLimitValue = { key: string; count: number; lastRequest: number };

let authInstance: unknown = null;
let resendClient: Resend | null = null;

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function envBoolean(name: string, fallback = false) {
  const value = envString(name).toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function envPositiveInteger(name: string, fallback: number, min: number, max: number) {
  const value = Number(envString(name));
  if (!Number.isFinite(value) || (value <= 0 && min > 0) || value < 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isProductionProfile() {
  const profile = envString("REND_ENV_PROFILE") || envString("REND_ENV") || process.env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function selfServeSignupEnabled() {
  const configured = envString("REND_SELF_SERVE_SIGNUP_ENABLED");
  if (!isProductionProfile()) return configured ? envBoolean("REND_SELF_SERVE_SIGNUP_ENABLED") : true;
  return envBoolean("REND_SELF_SERVE_SIGNUP_ENABLED");
}

function authBaseUrl() {
  const configured = envString("BETTER_AUTH_URL") || envString("REND_AUTH_BASE_URL");
  if (configured) return configured;
  if (isProductionProfile()) {
    throw new Error("BETTER_AUTH_URL or REND_AUTH_BASE_URL is required in production");
  }
  return LOCAL_AUTH_URL;
}

function authSecret() {
  const configured = envString("BETTER_AUTH_SECRET") || envString("AUTH_SECRET");
  if (configured) return configured;
  if (isProductionProfile()) {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }
  return LOCAL_AUTH_SECRET;
}

function addOrigin(origins: Set<string>, value: string) {
  if (!value) return;
  try {
    origins.add(new URL(value).origin);
  } catch {
    // Invalid URLs are rejected elsewhere by production diagnostics/env checks.
  }
}

function trustedOrigins() {
  const origins = new Set(
    envString("REND_AUTH_TRUSTED_ORIGINS")
    .split(",")
    .map((origin) => origin.trim())
      .filter(Boolean)
  );
  addOrigin(origins, authBaseUrl());
  addOrigin(origins, envString("REND_PUBLIC_SITE_BASE_URL"));
  return [...origins];
}

function getResend() {
  const apiKey = envString("RESEND_API_KEY");
  if (!apiKey) return null;
  if (!resendClient) resendClient = new Resend(apiKey);
  return resendClient;
}

function generateNumericOtp() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function rateLimitRetryAfterSeconds(lastRequest: number, windowSeconds: number) {
  const retryAfterMs = lastRequest + windowSeconds * 1_000 - Date.now();
  return Math.max(1, Math.ceil(retryAfterMs / 1_000));
}

function authRateLimitStorage() {
  return {
    async get(key: string) {
      const result = await getSitePgPool().query(
        "select key, count, last_request from rend_auth.rate_limit where key = $1 limit 1",
        [key]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        key: row.key,
        count: Number(row.count),
        lastRequest: Number(row.last_request),
      };
    },
    async set(key: string, value: AuthRateLimitValue, update?: boolean) {
      if (update) {
        await getSitePgPool().query(
          "update rend_auth.rate_limit set count = $2, last_request = $3 where key = $1",
          [key, value.count, value.lastRequest]
        );
        return;
      }
      await getSitePgPool().query(
        `insert into rend_auth.rate_limit (key, count, last_request)
         values ($1, $2, $3)
         on conflict (key) do update set
           count = excluded.count,
           last_request = excluded.last_request`,
        [key, value.count, value.lastRequest]
      );
    },
    async consume(key: string, rule: AuthRateLimitRule) {
      const now = Date.now();
      const windowMs = rule.window * 1_000;
      const result = await getSitePgPool().query(
        `with consumed as (
           insert into rend_auth.rate_limit (key, count, last_request)
           values ($1, 1, $2)
           on conflict (key) do update set
             count = case
               when $2 - rend_auth.rate_limit.last_request > $3 then 1
               else rend_auth.rate_limit.count + 1
             end,
             last_request = $2
           where
             $2 - rend_auth.rate_limit.last_request > $3
             or rend_auth.rate_limit.count < $4
           returning count, last_request, true as allowed
         ),
         current as (
           select count, last_request, false as allowed
           from rend_auth.rate_limit
           where key = $1 and not exists (select 1 from consumed)
         )
         select count, last_request, allowed from consumed
         union all
         select count, last_request, allowed from current
         limit 1`,
        [key, now, windowMs, rule.max]
      );
      const row = result.rows[0];
      if (!row || row.allowed) return { allowed: true, retryAfter: null };
      return {
        allowed: false,
        retryAfter: rateLimitRetryAfterSeconds(Number(row.last_request), rule.window),
      };
    },
  };
}

export class AuthEmailDeliveryError extends Error {
  code: string;
  providerStatus?: number;
  providerCode?: string;

  constructor(
    code: string,
    message: string,
    options: { providerStatus?: number; providerCode?: string; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AuthEmailDeliveryError";
    this.code = code;
    this.providerStatus = options.providerStatus;
    this.providerCode = options.providerCode;
  }
}

function authEmailSendTimeoutMs() {
  return envPositiveInteger("REND_AUTH_EMAIL_SEND_TIMEOUT_MS", 10_000, 1_000, 30_000);
}

function authEmailSendRetries() {
  return envPositiveInteger("REND_AUTH_EMAIL_SEND_RETRIES", 1, 0, 3);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new AuthEmailDeliveryError(
              "auth_email_provider_timeout",
              "Email provider timed out before accepting the sign-in code"
            )
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function resendSignal(timeoutMs: number) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function isRetryableResendFailure(error: AuthEmailDeliveryError) {
  return (
    error.code === "auth_email_provider_timeout" ||
    error.providerStatus === undefined ||
    error.providerStatus === 429 ||
    error.providerStatus >= 500
  );
}

function authEmailErrorFromResend(error: {
  name?: unknown;
  message?: unknown;
  statusCode?: unknown;
}) {
  const providerStatus = typeof error.statusCode === "number" ? error.statusCode : undefined;
  const providerCode = typeof error.name === "string" ? error.name : "application_error";
  const providerMessage = redactAuthText(error.message);
  const message =
    providerStatus === 429
      ? "Email provider rate limit was reached while sending the sign-in code"
      : providerStatus && providerStatus < 500
        ? "Email provider rejected the sign-in code request"
        : "Email provider could not accept the sign-in code request";
  return new AuthEmailDeliveryError("auth_email_provider_rejected", message, {
    providerStatus,
    providerCode,
    cause: providerMessage,
  });
}

async function sendAuthOtpEmailWithResend(input: {
  email: string;
  from: string;
  otp: string;
  type: AuthOtpEmailType;
}) {
  const resend = getResend();
  if (!resend) throw new AuthEmailDeliveryError("auth_email_not_configured", "Resend is not configured");

  const timeoutMs = authEmailSendTimeoutMs();
  const retries = authEmailSendRetries();
  const idempotencyKey = `rend-auth-otp-${randomUUID()}`;
  let lastError: AuthEmailDeliveryError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const started = Date.now();
    logAuthEvent("otp_send_attempted", {
      ...authEmailSummary(input.email),
      provider: "resend",
      type: input.type,
      attempt: attempt + 1,
      timeout_ms: timeoutMs,
    });

    try {
      const result = await withTimeout(
        resend.emails.send(
          {
            from: input.from,
            to: input.email,
            subject: "Your Rend sign-in code",
            text: `Your Rend sign-in code is ${input.otp}. It expires in 5 minutes.`,
          },
          {
            idempotencyKey,
            signal: resendSignal(timeoutMs),
          } as Parameters<typeof resend.emails.send>[1] & { signal?: AbortSignal }
        ),
        timeoutMs
      );

      if (result.error) throw authEmailErrorFromResend(result.error);
      if (!result.data?.id) {
        throw new AuthEmailDeliveryError(
          "auth_email_provider_invalid_response",
          "Email provider accepted the request without a message id"
        );
      }

      logAuthEvent("otp_send_accepted", {
        ...authEmailSummary(input.email),
        provider: "resend",
        type: input.type,
        attempt: attempt + 1,
        duration_ms: Date.now() - started,
        resend_message_id_hash: authSubjectId(result.data.id),
      });
      return;
    } catch (error) {
      lastError =
        error instanceof AuthEmailDeliveryError
          ? error
          : new AuthEmailDeliveryError(
              "auth_email_provider_failed",
              "Email provider request failed",
              { cause: error instanceof Error ? error.message : String(error) }
            );

      logAuthEvent(
        "otp_send_failed",
        {
          ...authEmailSummary(input.email),
          provider: "resend",
          type: input.type,
          attempt: attempt + 1,
          duration_ms: Date.now() - started,
          error: lastError.code,
          provider_status: lastError.providerStatus,
          provider_code: lastError.providerCode,
          retrying: attempt < retries && isRetryableResendFailure(lastError),
        },
        attempt < retries && isRetryableResendFailure(lastError) ? "warn" : "error"
      );

      if (attempt >= retries || !isRetryableResendFailure(lastError)) break;
      await sleep(250 * (attempt + 1));
    }
  }

  throw lastError ?? new AuthEmailDeliveryError("auth_email_send_failed", "Sign-in email could not be sent");
}

export async function sendAuthOtpEmail({
  email,
  otp,
  type,
}: {
  email: string;
  otp: string;
  type: AuthOtpEmailType;
}) {
  const normalizedEmail = normalizeAuthEmail(email);
  const resend = getResend();
  const from = envString("REND_AUTH_EMAIL_FROM");
  if (isProductionProfile() && envBoolean("REND_AUTH_EMAIL_DISABLED")) {
    logAuthEvent(
      "otp_send_failed",
      {
        ...authEmailSummary(normalizedEmail),
        provider: "disabled",
        type,
        error: "auth_email_disabled",
      },
      "error"
    );
    throw new AuthEmailDeliveryError("auth_email_disabled", "Rend auth email is disabled");
  }

  if (resend) {
    if (!from) {
      logAuthEvent(
        "otp_send_failed",
        {
          ...authEmailSummary(normalizedEmail),
          provider: "resend",
          type,
          error: "auth_email_from_missing",
        },
        "error"
      );
      throw new AuthEmailDeliveryError(
        "auth_email_from_missing",
        "REND_AUTH_EMAIL_FROM is required when RESEND_API_KEY is set"
      );
    }
    await sendAuthOtpEmailWithResend({ email: normalizedEmail, from, otp, type });
    return;
  }

  if (!isProductionProfile()) {
    logAuthEvent("otp_send_attempted", {
      ...authEmailSummary(normalizedEmail),
      provider: "local-console",
      type,
    });
    console.info("[rend-auth] local email OTP", { email: normalizedEmail, type, code: otp });
    return;
  }

  logAuthEvent(
    "otp_send_failed",
    {
      ...authEmailSummary(normalizedEmail),
      provider: "missing",
      type,
      error: "auth_email_not_configured",
    },
    "error"
  );
  throw new AuthEmailDeliveryError(
    "auth_email_not_configured",
    "RESEND_API_KEY and REND_AUTH_EMAIL_FROM are required in production"
  );
}

export function getAuth(): AuthInstance {
  if (!authInstance) {
    authInstance = betterAuth({
      appName: "Rend",
      basePath: "/api/auth",
      baseURL: authBaseUrl(),
      secret: authSecret(),
      trustedOrigins: trustedOrigins(),
      user: {
        fields: {
          emailVerified: "email_verified",
          createdAt: "created_at",
          updatedAt: "updated_at",
        },
      },
      session: {
        fields: {
          expiresAt: "expires_at",
          createdAt: "created_at",
          updatedAt: "updated_at",
          ipAddress: "ip_address",
          userAgent: "user_agent",
          userId: "user_id",
        },
        expiresIn: 7 * 24 * 60 * 60,
        updateAge: 24 * 60 * 60,
        deferSessionRefresh: true,
      },
      account: {
        fields: {
          accountId: "account_id",
          providerId: "provider_id",
          userId: "user_id",
          accessToken: "access_token",
          refreshToken: "refresh_token",
          idToken: "id_token",
          accessTokenExpiresAt: "access_token_expires_at",
          refreshTokenExpiresAt: "refresh_token_expires_at",
          createdAt: "created_at",
          updatedAt: "updated_at",
        },
      },
      verification: {
        fields: {
          expiresAt: "expires_at",
          createdAt: "created_at",
          updatedAt: "updated_at",
        },
        storeIdentifier: "hashed",
      },
      database: drizzleAdapter(getSiteDb(), {
        provider: "pg",
        schema: authSchema,
        transaction: true,
      }),
      advanced: {
        cookiePrefix: "rend_auth",
        database: {
          generateId: "uuid",
        },
        useSecureCookies: isProductionProfile(),
      },
      rateLimit: {
        enabled: true,
        storage: isProductionProfile() ? "database" : "memory",
        customStorage: isProductionProfile() ? authRateLimitStorage() : undefined,
        modelName: "rateLimit",
        fields: {
          lastRequest: "last_request",
        },
        window: 60,
        max: 100,
        customRules: {
          "/email-otp/send-verification-otp": { window: 60, max: 3 },
          "/sign-in/email-otp": { window: 60, max: 5 },
          "/email-otp/check-verification-otp": { window: 60, max: 5 },
        },
      },
      experimental: {
        joins: true,
      },
      emailAndPassword: {
        enabled: false,
      },
      plugins: [
        organization({
          allowUserToCreateOrganization: false,
          creatorRole: "owner",
          membershipLimit: 100,
          teams: { enabled: false },
          schema: {
            organization: {
              fields: {
                createdAt: "created_at",
              },
            },
            member: {
              fields: {
                organizationId: "organization_id",
                userId: "user_id",
                createdAt: "created_at",
              },
            },
            invitation: {
              fields: {
                organizationId: "organization_id",
                teamId: "team_id",
                expiresAt: "expires_at",
                createdAt: "created_at",
                inviterId: "inviter_id",
              },
            },
            session: {
              fields: {
                activeOrganizationId: "active_organization_id",
              },
            },
          },
          sendInvitationEmail: async () => {},
        }),
        emailOTP({
          otpLength: 6,
          expiresIn: 300,
          allowedAttempts: 3,
          disableSignUp: !selfServeSignupEnabled(),
          generateOTP: generateNumericOtp,
          storeOTP: "hashed",
          rateLimit: {
            window: 60,
            max: 3,
          },
          async sendVerificationOTP(data) {
            await sendAuthOtpEmail(data);
          },
        }),
      ],
    });
  }
  return authInstance as AuthInstance;
}

export const auth = getAuth;
