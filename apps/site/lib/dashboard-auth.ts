import { and, asc, eq } from "drizzle-orm";
import { ensureLocalAuthSeed } from "./auth-seed.ts";
import { getAuth } from "./auth.ts";
import { ensureBillingCustomerSoft } from "./billing.ts";
import { member, organization } from "./db/schema.ts";
import {
  legalAssentFromHeaders,
  type LegalAssent,
} from "./legal-assent.ts";
import { getSiteDb } from "./server-db.ts";

const LOCAL_AUTH_SECRET = "local-better-auth-secret-only-for-rend-development";
const LOCAL_AUTH_URL = "http://localhost:3000";

type Env = Record<string, string | undefined>;

export type DashboardRole = "owner" | "admin" | "member";

export type DashboardAccessContext = {
  userId: string;
  userEmail: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: DashboardRole;
  organizationSuspendedAt?: string;
  organizationSuspensionReason?: string;
};

export type DashboardAccessResult =
  | { ok: true; context: DashboardAccessContext }
  | { ok: false; reason: "not_configured" | "unauthorized" | "forbidden" };

type BetterAuthSessionResult = {
  user?: {
    id?: unknown;
    email?: unknown;
  };
  session?: {
    activeOrganizationId?: unknown;
    active_organization_id?: unknown;
  };
};

function envString(name: string, env: Env = process.env) {
  return (env[name] || "").trim();
}

function envBoolean(name: string, env: Env = process.env) {
  const value = envString(name, env).toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function isProductionProfile(env: Env = process.env) {
  const profile = envString("REND_ENV_PROFILE", env) || envString("REND_ENV", env) || env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function isLocalUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "0.0.0.0" || host === "::1" || host.startsWith("127.");
  } catch {
    return true;
  }
}

export function selfServeSignupEnabled(env: Env = process.env) {
  const configured = envString("REND_SELF_SERVE_SIGNUP_ENABLED", env);
  if (!isProductionProfile(env)) return configured ? envBoolean("REND_SELF_SERVE_SIGNUP_ENABLED", env) : true;
  return envBoolean("REND_SELF_SERVE_SIGNUP_ENABLED", env);
}

export function dashboardAuthConfigured(env: Env = process.env) {
  if (!isProductionProfile(env)) return true;

  const secret = envString("BETTER_AUTH_SECRET", env) || envString("AUTH_SECRET", env);
  const baseUrl = envString("BETTER_AUTH_URL", env) || envString("REND_AUTH_BASE_URL", env);
  if (!selfServeSignupEnabled(env)) return false;
  if (!secret || secret === LOCAL_AUTH_SECRET) return false;
  if (!baseUrl || baseUrl === LOCAL_AUTH_URL || isLocalUrl(baseUrl)) return false;
  if (envBoolean("REND_AUTH_EMAIL_DISABLED", env)) return false;
  if (!envString("RESEND_API_KEY", env) || !envString("REND_AUTH_EMAIL_FROM", env)) {
    return false;
  }
  return true;
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function activeOrganizationId(session: BetterAuthSessionResult["session"]) {
  return safeString(session?.activeOrganizationId) ?? safeString(session?.active_organization_id);
}

function normalizeRole(value: string): DashboardRole {
  return value === "owner" || value === "admin" || value === "member" ? value : "member";
}

function isoDate(value: Date | string | null) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function defaultOrganizationSlug(userId: string) {
  return `user-${userId.replace(/-/g, "").slice(0, 16)}`;
}

function defaultOrganizationName(email: string) {
  const localPart = email.split("@")[0]?.trim() || "Rend";
  return `${localPart} workspace`;
}

async function provisionDefaultOrganization(userId: string, userEmail: string, legalAssent: LegalAssent) {
  const db = getSiteDb();
  const now = new Date();
  const slug = defaultOrganizationSlug(userId);
  const name = defaultOrganizationName(userEmail);

  const [insertedOrg] = await db
    .insert(organization)
    .values({
      name,
      slug,
      metadata: {
        legal_assent: {
          accepted_at: legalAssent.acceptedAt,
          privacy_version: legalAssent.version,
          source: "login_email_otp",
          terms_version: legalAssent.version,
          user_email: userEmail,
          user_id: userId,
        },
        provisioned: "email-otp-signup",
      },
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing({ target: organization.slug })
    .returning({
      organizationId: organization.id,
      organizationName: organization.name,
      organizationSlug: organization.slug,
    });

  const [existingOrg] = insertedOrg
    ? [insertedOrg]
    : await db
        .select({
          organizationId: organization.id,
          organizationName: organization.name,
          organizationSlug: organization.slug,
        })
        .from(organization)
        .where(eq(organization.slug, slug))
        .limit(1);

  if (!existingOrg) return null;

  await db
    .insert(member)
    .values({
      organization_id: existingOrg.organizationId,
      user_id: userId,
      role: "owner",
      created_at: now,
    })
    .onConflictDoUpdate({
      target: [member.user_id, member.organization_id],
      set: { role: "owner" },
    });

  return {
    ...existingOrg,
    role: "owner" as const,
  };
}

export function canManageApiKeys(context: DashboardAccessContext) {
  return !organizationIsSuspended(context) && (context.role === "owner" || context.role === "admin");
}

export function canDeleteAssets(context: DashboardAccessContext) {
  return !organizationIsSuspended(context) && (context.role === "owner" || context.role === "admin");
}

export function canUploadAssets(context: DashboardAccessContext) {
  return !organizationIsSuspended(context) && (context.role === "owner" || context.role === "admin");
}

export function organizationIsSuspended(context: DashboardAccessContext) {
  return Boolean(context.organizationSuspendedAt);
}

export function organizationSuspendedMessage(context: DashboardAccessContext) {
  return context.organizationSuspensionReason
    ? `Organization is suspended: ${context.organizationSuspensionReason}`
    : "Organization is suspended. This workspace is read-only.";
}

export async function dashboardAccessFromHeaders(headers: Headers): Promise<DashboardAccessResult> {
  if (!dashboardAuthConfigured()) return { ok: false, reason: "not_configured" };

  await ensureLocalAuthSeed();

  const auth = getAuth() as {
    api: { getSession: (input: { headers: Headers }) => Promise<unknown> };
  };
  const sessionResult = (await auth.api.getSession({ headers })) as BetterAuthSessionResult | null;
  const userId = safeString(sessionResult?.user?.id);
  const userEmail = safeString(sessionResult?.user?.email);
  if (!userId || !userEmail) return { ok: false, reason: "unauthorized" };

  const selectedOrgId = activeOrganizationId(sessionResult?.session);
  const db = getSiteDb();
  const where = selectedOrgId
    ? and(eq(member.user_id, userId), eq(member.organization_id, selectedOrgId))
    : eq(member.user_id, userId);

  const [row] = await db
    .select({
      organizationId: organization.id,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      organizationSuspendedAt: organization.suspended_at,
      organizationSuspensionReason: organization.suspension_reason,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organization_id, organization.id))
    .where(where)
    .orderBy(asc(member.created_at))
    .limit(1);

  if (!row) {
    if (selectedOrgId) return { ok: false, reason: "forbidden" };

    const legalAssent = legalAssentFromHeaders(headers, userEmail);
    if (!legalAssent) return { ok: false, reason: "unauthorized" };

    const provisioned = await provisionDefaultOrganization(userId, userEmail, legalAssent);
    if (!provisioned) return { ok: false, reason: "unauthorized" };

    const context: DashboardAccessContext = {
      userId,
      userEmail,
      organizationId: provisioned.organizationId,
      organizationName: provisioned.organizationName,
      organizationSlug: provisioned.organizationSlug,
      role: provisioned.role,
    };
    await ensureBillingCustomerSoft(context);

    return {
      ok: true,
      context,
    };
  }

  const context: DashboardAccessContext = {
    userId,
    userEmail,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationSlug: row.organizationSlug,
    role: normalizeRole(row.role),
    organizationSuspendedAt: isoDate(row.organizationSuspendedAt),
    organizationSuspensionReason: row.organizationSuspensionReason ?? undefined,
  };
  await ensureBillingCustomerSoft(context);

  return {
    ok: true,
    context,
  };
}

export function dashboardAccessFromRequest(request: Request) {
  return dashboardAccessFromHeaders(request.headers);
}

export function dashboardSuspendedResponse(context: DashboardAccessContext) {
  return Response.json(
    {
      status: "error",
      error: "organization_suspended",
      message: organizationSuspendedMessage(context),
    },
    {
      status: 403,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    }
  );
}

export function dashboardAccessErrorResponse(access: Exclude<DashboardAccessResult, { ok: true }>) {
  const status =
    access.reason === "not_configured" ? 503 : access.reason === "forbidden" ? 403 : 401;
  const error =
    access.reason === "not_configured"
      ? "dashboard_auth_not_configured"
      : access.reason === "forbidden"
        ? "forbidden"
        : "unauthorized";
  const message =
    access.reason === "not_configured"
      ? "Dashboard authentication is not configured"
      : access.reason === "forbidden"
        ? "Insufficient organization permissions"
        : "Authentication required";

  return Response.json(
    {
      status: "error",
      error,
      message,
    },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    }
  );
}
