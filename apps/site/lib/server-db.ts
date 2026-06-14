import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "./db/schema.ts";

const DEFAULT_DATABASE_URL = "postgres://rend:rend@localhost:5432/rend";

let sitePool: Pool | null = null;
let siteDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

export function getSiteDb() {
  if (!sitePool) {
    sitePool = new Pool({
      connectionString: envString("DATABASE_URL", DEFAULT_DATABASE_URL),
      max: 5,
    });
  }
  if (!siteDb) {
    siteDb = drizzle({ client: sitePool, schema });
  }
  return siteDb;
}

export function getSitePgPool() {
  if (!sitePool) {
    sitePool = new Pool({
      connectionString: envString("DATABASE_URL", DEFAULT_DATABASE_URL),
      max: 5,
    });
  }
  return sitePool;
}
