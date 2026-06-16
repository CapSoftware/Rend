import { Pool, type PoolConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "./db/schema.ts";

const DEFAULT_DATABASE_URL = "postgres://rend:rend@localhost:5432/rend";
const DEFAULT_POOL_MAX = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;

let sitePool: Pool | null = null;
let siteDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function envPositiveInteger(name: string, fallback: number, min: number, max: number) {
  const value = Number(envString(name));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sitePoolConfig(): PoolConfig {
  const queryTimeoutMs = envPositiveInteger(
    "REND_SITE_DB_QUERY_TIMEOUT_MS",
    DEFAULT_QUERY_TIMEOUT_MS,
    1_000,
    60_000
  );
  return {
    connectionString: envString("DATABASE_URL", DEFAULT_DATABASE_URL),
    max: envPositiveInteger("REND_SITE_DB_POOL_MAX", DEFAULT_POOL_MAX, 1, 20),
    connectionTimeoutMillis: envPositiveInteger(
      "REND_SITE_DB_CONNECT_TIMEOUT_MS",
      DEFAULT_CONNECT_TIMEOUT_MS,
      500,
      30_000
    ),
    query_timeout: queryTimeoutMs,
  };
}

export function getSiteDb() {
  if (!sitePool) {
    sitePool = new Pool(sitePoolConfig());
  }
  if (!siteDb) {
    siteDb = drizzle({ client: sitePool, schema });
  }
  return siteDb;
}

export function getSitePgPool() {
  if (!sitePool) {
    sitePool = new Pool(sitePoolConfig());
  }
  return sitePool;
}
