import { desc, eq } from "drizzle-orm";
import type { DashboardAccessContext } from "./dashboard-auth.ts";
import { localAdminEmail } from "./auth-seed.ts";
import { billingCustomers, operatorAuditRecords, organization } from "./db/schema.ts";
import { getSiteDb, getSitePgPool } from "./server-db.ts";
import { billingOverview } from "./billing.ts";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:4000";
const LOCAL_SITE_INTERNAL_TOKEN = "local-site-internal-token";

type Env = Record<string, string | undefined>;

export type OperatorAction = "suspend" | "restore";
export type OperatorTargetType = "organization" | "asset";

export type OperatorActionInput = {
  action: OperatorAction;
  targetType: OperatorTargetType;
  targetId: string;
  reason: string;
};

export type OperatorActionResult = {
  status: "ok";
  action: OperatorAction;
  target_type: OperatorTargetType;
  target_id: string;
  audit_id: string;
  purge_attempted: boolean;
  suspended_at?: string;
};

export type OperatorAuditRecord = {
  id: string;
  operator_email: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  created_at: string;
};

export type BillingSyncRecord = {
  organization_id: string;
  organization_name: string;
  billing_mode: string;
  customer_synced_at?: string;
  customer_sync_error?: string;
  billing_state_synced_at?: string;
  billing_state_error?: string;
  delivery_usage_cursor_at?: string;
  delivery_usage_synced_at?: string;
  delivery_usage_error?: string;
  storage_usage_cursor_at?: string;
  storage_usage_synced_at?: string;
  storage_usage_error?: string;
};

export class OperatorActionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OperatorActionError";
    this.status = status;
  }
}

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function isProductionProfile(env: Env = process.env) {
  const profile = env.REND_ENV_PROFILE || env.REND_ENV || env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function siteInternalToken() {
  const configured = envString("REND_SITE_INTERNAL_TOKEN");
  if (configured) return configured;
  return isProductionProfile() ? "" : LOCAL_SITE_INTERNAL_TOKEN;
}

function controlPlaneUrl(path: string) {
  const baseUrl = envString("REND_API_BASE_URL", DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  return `${baseUrl}${path}`;
}

function operatorAllowlist(env: Env = process.env) {
  return new Set(
    (env.REND_OPERATOR_EMAIL_ALLOWLIST || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function roleCanOperate(context: DashboardAccessContext) {
  return context.role === "owner" || context.role === "admin";
}

export function canUseOperatorSurface(context: DashboardAccessContext, env: Env = process.env) {
  if (!roleCanOperate(context)) return false;
  const email = context.userEmail.toLowerCase();
  const allowlist = operatorAllowlist(env);
  if (allowlist.size > 0) return allowlist.has(email);
  return !isProductionProfile(env) && email === localAdminEmail();
}

export function operatorDeniedMessage(env: Env = process.env) {
  return operatorAllowlist(env).size > 0
    ? "Operator access is restricted to the configured allowlist."
    : "Operator access is not configured.";
}

function operatorPath(input: OperatorActionInput) {
  const target = input.targetType === "organization" ? "organizations" : "assets";
  return `/internal/operator/${target}/${encodeURIComponent(input.targetId)}/${input.action}`;
}

function safeReason(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function safeUuid(value: string) {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

export async function performOperatorAction(
  context: DashboardAccessContext,
  input: OperatorActionInput
): Promise<OperatorActionResult> {
  if (!canUseOperatorSurface(context)) {
    throw new OperatorActionError(403, operatorDeniedMessage());
  }

  const reason = safeReason(input.reason);
  if (!reason) {
    throw new OperatorActionError(400, "A reason is required.");
  }

  const internalToken = siteInternalToken();
  if (!internalToken) {
    throw new OperatorActionError(500, "Operator control plane is not configured.");
  }

  const response = await fetch(controlPlaneUrl(operatorPath(input)), {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      "x-rend-site-token": internalToken,
      "x-rend-operator-user-id": context.userId,
      "x-rend-operator-email": context.userEmail,
    },
    body: JSON.stringify({ reason }),
  }).catch(() => null);

  if (!response) {
    throw new OperatorActionError(502, "Operator control plane request failed.");
  }

  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new OperatorActionError(
      response.status,
      typeof body.error === "string" ? body.error : body.message || "Operator action failed."
    );
  }

  return body as OperatorActionResult;
}

function isoDate(value: Date | string | null | undefined) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export async function recentOperatorAuditRecords(limit = 20): Promise<OperatorAuditRecord[]> {
  const rows = await getSiteDb()
    .select({
      id: operatorAuditRecords.id,
      operator_email: operatorAuditRecords.operator_email,
      action: operatorAuditRecords.action,
      target_type: operatorAuditRecords.target_type,
      target_id: operatorAuditRecords.target_id,
      reason: operatorAuditRecords.reason,
      created_at: operatorAuditRecords.created_at,
    })
    .from(operatorAuditRecords)
    .orderBy(desc(operatorAuditRecords.created_at))
    .limit(Math.min(Math.max(Math.trunc(limit) || 20, 1), 50));

  return rows.map((row) => ({
    ...row,
    created_at: isoDate(row.created_at) ?? new Date().toISOString(),
  }));
}

export async function recentBillingSyncRecords(limit = 20): Promise<BillingSyncRecord[]> {
  const rows = await getSiteDb()
    .select({
      organization_id: billingCustomers.organization_id,
      organization_name: organization.name,
      billing_mode: billingCustomers.billing_mode,
      customer_synced_at: billingCustomers.customer_synced_at,
      customer_sync_error: billingCustomers.customer_sync_error,
      billing_state_synced_at: billingCustomers.billing_state_synced_at,
      billing_state_error: billingCustomers.billing_state_error,
      delivery_usage_cursor_at: billingCustomers.delivery_usage_cursor_at,
      delivery_usage_synced_at: billingCustomers.delivery_usage_synced_at,
      delivery_usage_error: billingCustomers.delivery_usage_error,
      storage_usage_cursor_at: billingCustomers.storage_usage_cursor_at,
      storage_usage_synced_at: billingCustomers.storage_usage_synced_at,
      storage_usage_error: billingCustomers.storage_usage_error,
    })
    .from(billingCustomers)
    .innerJoin(organization, eq(organization.id, billingCustomers.organization_id))
    .orderBy(desc(billingCustomers.updated_at))
    .limit(Math.min(Math.max(Math.trunc(limit) || 20, 1), 50));

  return rows.map((row) => ({
    organization_id: row.organization_id,
    organization_name: row.organization_name,
    billing_mode: row.billing_mode,
    customer_synced_at: isoDate(row.customer_synced_at ?? undefined),
    customer_sync_error: row.customer_sync_error ?? undefined,
    billing_state_synced_at: isoDate(row.billing_state_synced_at ?? undefined),
    billing_state_error: row.billing_state_error ?? undefined,
    delivery_usage_cursor_at: isoDate(row.delivery_usage_cursor_at ?? undefined),
    delivery_usage_synced_at: isoDate(row.delivery_usage_synced_at ?? undefined),
    delivery_usage_error: row.delivery_usage_error ?? undefined,
    storage_usage_cursor_at: isoDate(row.storage_usage_cursor_at ?? undefined),
    storage_usage_synced_at: isoDate(row.storage_usage_synced_at ?? undefined),
    storage_usage_error: row.storage_usage_error ?? undefined,
  }));
}

export async function performBillingCustomerResync(
  context: DashboardAccessContext,
  organizationId: string
) {
  if (!canUseOperatorSurface(context)) {
    throw new OperatorActionError(403, operatorDeniedMessage());
  }
  const normalizedOrgId = safeUuid(organizationId);
  if (!normalizedOrgId) {
    throw new OperatorActionError(400, "Organization ID must be a UUID.");
  }

  const result = await getSitePgPool().query<{
    organization_id: string;
    organization_name: string;
    organization_slug: string;
    owner_email: string | null;
  }>(
    `
      SELECT org.id::text AS organization_id,
             org.name AS organization_name,
             org.slug AS organization_slug,
             min(owner_user.email) AS owner_email
      FROM rend_auth.organization org
      LEFT JOIN rend_auth.member owner_member
        ON owner_member.organization_id = org.id
       AND owner_member.role = 'owner'
      LEFT JOIN rend_auth."user" owner_user
        ON owner_user.id = owner_member.user_id
      WHERE org.id = $1::uuid
      GROUP BY org.id
    `,
    [normalizedOrgId]
  );
  const row = result.rows[0];
  if (!row) throw new OperatorActionError(404, "Organization was not found.");

  const syncContext: DashboardAccessContext = {
    userId: context.userId,
    userEmail: row.owner_email || context.userEmail,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    role: "owner",
  };
  return billingOverview(syncContext);
}
