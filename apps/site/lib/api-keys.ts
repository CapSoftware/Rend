import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { apiKeys } from "./db/schema.ts";
import { getSiteDb } from "./server-db.ts";
import type { DashboardAccessContext } from "./dashboard-auth.ts";
import { API_KEY_SCOPES, type ApiKeyRecord, type ApiKeyScope } from "./api-key-types.ts";

export class ApiKeyError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiKeyError";
    this.status = status;
    this.code = code;
  }
}

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function isProductionProfile() {
  const profile = envString("REND_ENV_PROFILE") || envString("REND_ENV") || process.env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function keyPrefix() {
  return isProductionProfile() ? "rend_live_" : "rend_test_";
}

export function hashApiKey(rawKey: string) {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function generateApiKey() {
  const rawKey = `${keyPrefix()}${randomBytes(32).toString("base64url")}`;
  return {
    rawKey,
    prefix: rawKey.slice(0, 18),
    keyHash: hashApiKey(rawKey),
  };
}

function normalizeName(value: unknown) {
  if (typeof value !== "string") {
    throw new ApiKeyError(400, "invalid_name", "API key name is required");
  }
  const name = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) {
    throw new ApiKeyError(400, "invalid_name", "API key name must be 1-80 characters");
  }
  return name;
}

export function normalizeApiKeyScopes(value: unknown): ApiKeyScope[] {
  if (!Array.isArray(value)) {
    throw new ApiKeyError(400, "invalid_scopes", "API key scopes are required");
  }
  const scopes = [...new Set(value)].filter((scope): scope is ApiKeyScope =>
    API_KEY_SCOPES.includes(scope as ApiKeyScope)
  );
  if (scopes.length === 0 || scopes.length !== value.length) {
    throw new ApiKeyError(400, "invalid_scopes", "API key scopes are invalid");
  }
  return scopes;
}

function isoDate(value: Date | string | null) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function serializeApiKey(row: {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: Date | string;
  revoked_at: Date | string | null;
  last_used_at: Date | string | null;
}): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: normalizeApiKeyScopes(row.scopes),
    created_at: isoDate(row.created_at) ?? new Date().toISOString(),
    revoked_at: isoDate(row.revoked_at),
    last_used_at: isoDate(row.last_used_at),
  };
}

export async function listApiKeys(context: DashboardAccessContext) {
  const rows = await getSiteDb()
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      created_at: apiKeys.created_at,
      revoked_at: apiKeys.revoked_at,
      last_used_at: apiKeys.last_used_at,
    })
    .from(apiKeys)
    .where(eq(apiKeys.organization_id, context.organizationId))
    .orderBy(desc(apiKeys.created_at))
    .limit(100);

  return rows.map(serializeApiKey);
}

export async function createApiKey(
  context: DashboardAccessContext,
  input: { name: unknown; scopes: unknown }
) {
  const name = normalizeName(input.name);
  const scopes = normalizeApiKeyScopes(input.scopes);
  const generated = generateApiKey();
  const [row] = await getSiteDb()
    .insert(apiKeys)
    .values({
      organization_id: context.organizationId,
      created_by_user_id: context.userId,
      name,
      prefix: generated.prefix,
      key_hash: generated.keyHash,
      scopes,
    })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      created_at: apiKeys.created_at,
      revoked_at: apiKeys.revoked_at,
      last_used_at: apiKeys.last_used_at,
    });

  if (!row) throw new ApiKeyError(500, "create_failed", "API key could not be created");
  return {
    apiKey: serializeApiKey(row),
    secret: generated.rawKey,
  };
}

export async function revokeApiKey(context: DashboardAccessContext, keyId: string) {
  const [row] = await getSiteDb()
    .update(apiKeys)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.organization_id, context.organizationId),
        isNull(apiKeys.revoked_at)
      )
    )
    .returning({ id: apiKeys.id });

  return Boolean(row);
}

export function apiKeyErrorResponse(error: unknown) {
  if (error instanceof ApiKeyError) {
    return Response.json(
      {
        status: "error",
        error: error.code,
        message: error.message,
      },
      {
        status: error.status,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      }
    );
  }

  return Response.json(
    {
      status: "error",
      error: "api_key_request_failed",
      message: "API key request failed",
    },
    {
      status: 500,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    }
  );
}
