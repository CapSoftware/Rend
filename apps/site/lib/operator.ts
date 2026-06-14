import { desc } from "drizzle-orm";
import type { DashboardAccessContext } from "./dashboard-auth.ts";
import { localAdminEmail } from "./auth-seed.ts";
import { operatorAuditRecords } from "./db/schema.ts";
import { getSiteDb } from "./server-db.ts";

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

function isoDate(value: Date | string) {
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
    created_at: isoDate(row.created_at),
  }));
}
