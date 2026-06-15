#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_ORG_ID = "00000000-0000-0000-0000-000000000001";
const apiBind = process.env.REND_BILLING_DENIAL_API_BIND || "127.0.0.1:4200";
const apiBase = `http://${apiBind}`;
const children = [];

function log(message) {
  console.log(`[billing-denial] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(output || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createApiKey() {
  const rawKey = `rend_test_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey, "utf8").digest("hex");
  const prefix = rawKey.slice(0, 18);
  const sql = `
INSERT INTO rend_auth.organization (id, name, slug, metadata)
VALUES (${sqlLiteral(LOCAL_ORG_ID)}, 'Rend Local', 'local', '{"seeded":"billing-denial"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rend.api_keys (organization_id, name, prefix, key_hash, scopes)
VALUES (
  ${sqlLiteral(LOCAL_ORG_ID)},
  'Billing denial smoke',
  ${sqlLiteral(prefix)},
  ${sqlLiteral(keyHash)},
  ARRAY['upload', 'read', 'delete', 'analytics']::text[]
)
ON CONFLICT (key_hash) DO UPDATE
SET revoked_at = NULL,
    scopes = EXCLUDED.scopes,
    last_used_update_after = NULL;
`;
  run("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "rend",
    "-d",
    "rend",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    "-c",
    sql,
  ]);
  return rawKey;
}

function startAutumnDenyStub() {
  let checkRequests = 0;
  let customerRequests = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/customers.get_or_create") {
      customerRequests += 1;
      const parsed = body ? JSON.parse(body) : {};
      response.end(JSON.stringify({ id: parsed.customer_id, customer_id: parsed.customer_id }));
      return;
    }
    if (url.pathname === "/v1/balances.check") {
      checkRequests += 1;
      response.end(JSON.stringify({ allowed: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Autumn stub did not bind to a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
          new Promise((closeResolve) => {
            let resolved = false;
            const done = () => {
              if (resolved) return;
              resolved = true;
              closeResolve();
            };
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
            server.close(done);
            setTimeout(done, 1_000).unref();
          }),
        counts: () => ({ checkRequests, customerRequests }),
      });
    });
  });
}

function startApi(autumnUrl) {
  const child = spawn("cargo", ["run", "-p", "rend-api"], {
    cwd: rootDir,
    env: {
      ...process.env,
      REND_ENV: "local",
      REND_API_BIND_ADDR: apiBind,
      REND_API_AUTO_MIGRATE: "true",
      REND_BILLING_MODE: "autumn",
      AUTUMN_API_URL: autumnUrl,
      AUTUMN_SECRET_KEY: "local-billing-denial-secret",
      AUTUMN_API_VERSION: process.env.AUTUMN_API_VERSION || "2.3.0",
      REND_BILLING_ENTITLEMENT_FAILURE_POLICY: "fail_closed",
      REND_REDIS_URL: process.env.REND_REDIS_URL || "redis://localhost:6379",
      CLICKHOUSE_URL: process.env.CLICKHOUSE_URL || "http://localhost:8123",
      CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE || "rend",
      CLICKHOUSE_USER: process.env.CLICKHOUSE_USER || "rend",
      CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD || "rend",
      OBJECT_STORE_HEALTH_URL: process.env.OBJECT_STORE_HEALTH_URL || "http://localhost:9100/minio/health/ready",
      S3_ENDPOINT: process.env.S3_ENDPOINT || "http://localhost:9100",
      S3_REGION: process.env.S3_REGION || "us-east-1",
      S3_BUCKET: process.env.S3_BUCKET || "rend-local",
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "rend_minio",
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "rend_minio_password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const remember = (current, chunk) => `${current}${chunk}`.slice(-8_000);
  children.push(child);
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout = remember(stdout, text);
    if (text.includes("rend-api listening")) log("API listening");
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr = remember(stderr, text);
    if (/error|panicked/i.test(text)) process.stderr.write(text);
  });
  child.output = () => [stdout, stderr].filter(Boolean).join("\n").trim();
  return child;
}

async function waitForReady(api) {
  const deadline = Date.now() + 120_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (api.exitCode !== null) {
      const output = typeof api.output === "function" ? api.output() : "";
      throw new Error(`API exited before readiness with code ${api.exitCode}${output ? `:\n${output}` : ""}`);
    }
    try {
      const response = await fetch(`${apiBase}/readyz`, { cache: "no-store" });
      if (response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for API readiness: ${lastError}`);
}

async function main() {
  log("starting local Docker dependencies");
  run("docker", ["compose", "up", "-d", "postgres", "redis", "clickhouse", "minio", "minio-init", "clickhouse-init"], {
    stdio: "inherit",
  });
  run("docker", ["compose", "up", "-d", "--wait", "postgres", "redis", "clickhouse", "minio"], {
    stdio: "inherit",
  });

  const apiKey = createApiKey();
  const autumn = await startAutumnDenyStub();
  try {
    log("starting API with Autumn denial stub");
    const api = startApi(autumn.url);
    await waitForReady(api);

    const response = await fetch(`${apiBase}/v1/videos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "video/mp4",
        "content-length": "4",
      },
      body: Buffer.from("deny"),
    });
    const body = await response.json().catch(() => ({}));
    const counts = autumn.counts();

    if (response.status !== 403 || body.error !== "limit_exceeded") {
      throw new Error(`expected 403 limit_exceeded, got HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    if (counts.customerRequests < 1 || counts.checkRequests < 1) {
      throw new Error(`expected customer and balance check calls, got ${JSON.stringify(counts)}`);
    }
    log("passed");
    api.kill("SIGTERM");
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await autumn.close();
  }
}

main().catch((error) => {
  for (const child of children) child.kill("SIGTERM");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
