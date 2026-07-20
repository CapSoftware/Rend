#!/usr/bin/env node

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnvFile, repoRoot } from "./env-policy.mjs";

const DEFAULT_API_URL = "https://api.useautumn.com/v1";
const DEFAULT_API_VERSION = "2.3.0";
const DEFAULT_TIMEOUT_MS = 30_000;
const DELIVERY_ID = "delivery_seconds";
const STORAGE_ID = "storage_second_months";
const PAYG_ID = "pay_as_you_go";
const DELIVERY_RATE = 0.001;
const STORAGE_RATE = 0.003;
const BILLING_UNITS = 60;

function usage() {
  return `Usage: node scripts/autumn-catalog-parity.mjs [options]

Read-only comparison of Rend's two-meter Autumn sandbox and production catalog.

Options:
  --sandbox-env-file FILE       Defaults to .env.local
  --production-env-file FILE    Defaults to .env.production.local
  --allow-production-env-file-override
  --artifact FILE
  --timeout-ms NUMBER
  -h, --help
`;
}

function envString(env, key, fallback = "") {
  return String(env[key] ?? fallback).trim();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseArgs(argv) {
  const args = {
    sandboxEnvFile: process.env.REND_AUTUMN_SANDBOX_ENV_FILE || ".env.local",
    productionEnvFile: process.env.REND_AUTUMN_PRODUCTION_ENV_FILE || ".env.production.local",
    allowProductionEnvFileOverride: false,
    artifact: process.env.REND_AUTUMN_PARITY_ARTIFACT || "",
    timeoutMs: positiveNumber(process.env.REND_AUTUMN_PARITY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--sandbox-env-file") args.sandboxEnvFile = next();
    else if (arg.startsWith("--sandbox-env-file=")) args.sandboxEnvFile = arg.split("=", 2)[1];
    else if (arg === "--production-env-file") args.productionEnvFile = next();
    else if (arg.startsWith("--production-env-file=")) args.productionEnvFile = arg.split("=", 2)[1];
    else if (arg === "--allow-production-env-file-override") args.allowProductionEnvFileOverride = true;
    else if (arg === "--artifact") args.artifact = next();
    else if (arg.startsWith("--artifact=")) args.artifact = arg.split("=", 2)[1];
    else if (arg === "--timeout-ms") args.timeoutMs = positiveNumber(next(), DEFAULT_TIMEOUT_MS);
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = positiveNumber(arg.split("=", 2)[1], DEFAULT_TIMEOUT_MS);
    else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function resolveFile(file) {
  return path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
}

function classifyKey(key) {
  if (/^am_sk_live_/i.test(key) || /(?:^|[_-])live(?:[_-])/i.test(key)) return "live";
  if (/^am_sk_test_/i.test(key) || /(?:^|[_-])(test|sandbox)(?:[_-])/i.test(key)) return "sandbox";
  return "unknown";
}

function loadConfig(label, file, timeoutMs) {
  const resolved = resolveFile(file);
  if (!existsSync(resolved)) throw new Error(`${label} env file does not exist: ${file}`);
  const env = parseEnvFile(resolved);
  const secretKey = envString(env, "AUTUMN_SECRET_KEY");
  if (!secretKey) throw new Error(`${label} env is missing AUTUMN_SECRET_KEY`);
  return {
    label,
    file: resolved,
    secretKey,
    keyMode: classifyKey(secretKey),
    keyFingerprint: crypto.createHash("sha256").update(secretKey).digest("hex").slice(0, 16),
    apiUrl: envString(env, "AUTUMN_API_URL", DEFAULT_API_URL).replace(/\/+$/, ""),
    apiVersion: envString(env, "AUTUMN_API_VERSION", DEFAULT_API_VERSION),
    timeoutMs,
    featureIds: {
      delivery: envString(env, "REND_BILLING_FEATURE_DELIVERY", DELIVERY_ID),
      storage: envString(env, "REND_BILLING_FEATURE_STORAGE", STORAGE_ID),
    },
    planId: envString(env, "REND_AUTUMN_PLAN_PAYG_ID", PAYG_ID),
    rates: {
      delivery: positiveNumber(env.REND_AUTUMN_PRICE_DELIVERY_PER_MINUTE, DELIVERY_RATE),
      storage: positiveNumber(env.REND_AUTUMN_PRICE_STORAGE_PER_MINUTE_MONTH, STORAGE_RATE),
    },
  };
}

function validateConfig(args, sandbox, production) {
  const errors = [];
  if (!args.allowProductionEnvFileOverride && path.basename(production.file) !== ".env.production.local") {
    errors.push("production Autumn parity must load .env.production.local");
  }
  if (sandbox.secretKey === production.secretKey) errors.push("sandbox and production Autumn keys must differ");
  if (sandbox.keyMode !== "sandbox") errors.push("sandbox Autumn key must be visibly marked test/sandbox");
  if (production.keyMode !== "live") errors.push("production Autumn key must be visibly marked live");
  for (const config of [sandbox, production]) {
    if (config.featureIds.delivery !== DELIVERY_ID) errors.push(`${config.label} delivery feature must be ${DELIVERY_ID}`);
    if (config.featureIds.storage !== STORAGE_ID) errors.push(`${config.label} storage feature must be ${STORAGE_ID}`);
    if (config.planId !== PAYG_ID) errors.push(`${config.label} plan must be ${PAYG_ID}`);
    if (config.rates.delivery !== DELIVERY_RATE) errors.push(`${config.label} delivery rate must be ${DELIVERY_RATE}`);
    if (config.rates.storage !== STORAGE_RATE) errors.push(`${config.label} storage rate must be ${STORAGE_RATE}`);
  }
  return errors;
}

async function autumnPost(config, route, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.apiUrl}/${route}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.secretKey}`,
        "content-type": "application/json",
        "x-api-version": config.apiVersion,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text.slice(0, 240) };
    }
    if (!response.ok) {
      throw new Error(`${config.label} ${route} failed: ${String(data.message || data.error || `HTTP ${response.status}`).slice(0, 240)}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function listAll(config, route) {
  const items = [];
  let startCursor = "";
  for (;;) {
    const page = await autumnPost(config, route, {
      limit: 1_000,
      ...(startCursor ? { start_cursor: startCursor } : {}),
    });
    items.push(...(Array.isArray(page.list) ? page.list : []));
    if (!page.has_more) return items;
    startCursor = String(page.next_cursor || "");
    if (!startCursor) throw new Error(`${route} returned has_more without next_cursor`);
  }
}

function firstObjectWith(value, key, expected) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value) && (value[key] === expected || value[key.replace("_", "")] === expected)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = firstObjectWith(child, key, expected);
    if (found) return found;
  }
  return null;
}

function readNumber(value, ...keys) {
  for (const key of keys) {
    const number = Number(value?.[key]);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizeFeature(id, raw) {
  const feature = firstObjectWith(raw, "id", id) || firstObjectWith(raw, "feature_id", id) || raw;
  const display = feature.display || {};
  return {
    id: feature.id || feature.feature_id || id,
    type: feature.type || null,
    consumable: feature.consumable ?? null,
    singular: display.singular || feature.singular || null,
    plural: display.plural || feature.plural || null,
  };
}

function normalizePlan(raw) {
  const result = { id: raw.id || raw.plan_id || PAYG_ID, items: {} };
  for (const [key, featureId] of Object.entries({ delivery: DELIVERY_ID, storage: STORAGE_ID })) {
    const item = firstObjectWith(raw, "feature_id", featureId) || firstObjectWith(raw, "featureId", featureId);
    const price = item?.price || {};
    result.items[key] = {
      featureId: item?.feature_id || item?.featureId || null,
      included: readNumber(item, "included", "included_usage"),
      amount: readNumber(price, "amount"),
      billingUnits: readNumber(price, "billing_units", "billingUnits"),
      billingMethod: price.billing_method || price.billingMethod || null,
      interval: price.interval || null,
    };
  }
  return result;
}

async function fetchCatalog(config) {
  const [delivery, storage, plan, featureList, planList] = await Promise.all([
    autumnPost(config, "features.get", { feature_id: DELIVERY_ID }),
    autumnPost(config, "features.get", { feature_id: STORAGE_ID }),
    autumnPost(config, "plans.get", { plan_id: PAYG_ID }),
    listAll(config, "features.list"),
    listAll(config, "plans.list"),
  ]);
  return {
    featureIds: featureList
      .map((feature) => String(feature.id || feature.feature_id || "").trim())
      .filter(Boolean)
      .sort(),
    planIds: planList
      .map((listedPlan) => String(listedPlan.id || listedPlan.plan_id || "").trim())
      .filter(Boolean)
      .sort(),
    features: {
      delivery: normalizeFeature(DELIVERY_ID, delivery),
      storage: normalizeFeature(STORAGE_ID, storage),
    },
    plan: normalizePlan(plan),
  };
}

function expectedCatalog() {
  return {
    featureIds: [DELIVERY_ID, STORAGE_ID].sort(),
    planIds: [PAYG_ID],
    features: {
      delivery: { id: DELIVERY_ID, type: "metered", consumable: true, singular: "delivery second", plural: "delivery seconds" },
      storage: { id: STORAGE_ID, type: "metered", consumable: true, singular: "storage second-month", plural: "storage second-months" },
    },
    plan: {
      id: PAYG_ID,
      items: {
        delivery: { featureId: DELIVERY_ID, included: 0, amount: DELIVERY_RATE, billingUnits: BILLING_UNITS, billingMethod: "usage_based", interval: "month" },
        storage: { featureId: STORAGE_ID, included: 0, amount: STORAGE_RATE, billingUnits: BILLING_UNITS, billingMethod: "usage_based", interval: "month" },
      },
    },
  };
}

function differences(expected, actual, pointer = "", output = []) {
  if (Object.is(expected, actual)) return output;
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") {
    output.push({ path: pointer || "/", expected, actual });
    return output;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) differences(expected[key], actual[key], `${pointer}/${key}`, output);
  return output;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sandbox = loadConfig("sandbox", args.sandboxEnvFile, args.timeoutMs);
  const production = loadConfig("production", args.productionEnvFile, args.timeoutMs);
  const configErrors = validateConfig(args, sandbox, production);
  let sandboxCatalog = null;
  let productionCatalog = null;
  const errors = [...configErrors];

  if (errors.length === 0) {
    [sandboxCatalog, productionCatalog] = await Promise.all([fetchCatalog(sandbox), fetchCatalog(production)]);
    const expected = expectedCatalog();
    const sandboxDiff = differences(expected, sandboxCatalog);
    const productionDiff = differences(expected, productionCatalog);
    const parityDiff = differences(sandboxCatalog, productionCatalog);
    if (sandboxDiff.length) errors.push(`sandbox catalog differs from required model at ${sandboxDiff.map((entry) => entry.path).join(", ")}`);
    if (productionDiff.length) errors.push(`production catalog differs from required model at ${productionDiff.map((entry) => entry.path).join(", ")}`);
    if (parityDiff.length) errors.push(`sandbox and production differ at ${parityDiff.map((entry) => entry.path).join(", ")}`);
  }

  const artifactPath = resolveFile(args.artifact || `.rend/launch/autumn-catalog-parity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const artifact = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    status: errors.length ? "fail" : "pass",
    expected: expectedCatalog(),
    sandbox: { env_file: path.relative(repoRoot, sandbox.file), key_fingerprint: sandbox.keyFingerprint, catalog: sandboxCatalog },
    production: { env_file: path.relative(repoRoot, production.file), key_fingerprint: production.keyFingerprint, catalog: productionCatalog },
    errors,
  };
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: artifact.status, artifact: path.relative(repoRoot, artifactPath), errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
