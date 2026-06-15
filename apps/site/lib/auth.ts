import { randomInt } from "node:crypto";
import { betterAuth } from "better-auth";
import { emailOTP, organization } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { Resend } from "resend";
import { authSchema } from "./db/schema.ts";
import { getSiteDb } from "./server-db.ts";

const LOCAL_AUTH_SECRET = "local-better-auth-secret-only-for-rend-development";
const LOCAL_AUTH_URL = "http://localhost:3000";

type AuthInstance = ReturnType<typeof betterAuth>;

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

function trustedOrigins() {
  return envString("REND_AUTH_TRUSTED_ORIGINS")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
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

export async function sendAuthOtpEmail({
  email,
  otp,
  type,
}: {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}) {
  const resend = getResend();
  const from = envString("REND_AUTH_EMAIL_FROM");
  if (resend) {
    if (!from) throw new Error("REND_AUTH_EMAIL_FROM is required when RESEND_API_KEY is set");
    await resend.emails.send({
      from,
      to: email,
      subject: "Your Rend sign-in code",
      text: `Your Rend sign-in code is ${otp}. It expires in 5 minutes.`,
    });
    return;
  }

  if (!isProductionProfile()) {
    console.info("[rend-auth] local email OTP", { email, type, code: otp });
    return;
  }

  if (envBoolean("REND_AUTH_EMAIL_DISABLED")) {
    throw new Error("Rend auth email is disabled");
  }
  throw new Error("RESEND_API_KEY and REND_AUTH_EMAIL_FROM are required in production");
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
