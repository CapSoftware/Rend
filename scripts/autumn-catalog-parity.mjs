#!/usr/bin/env node

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { parseEnvFile, repoRoot } from "./env-policy.mjs";

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com/v1";
const DEFAULT_AUTUMN_API_VERSION = "2.3.0";
const DEFAULT_TIMEOUT_MS = 30_000;

const requiredMeterFeatures = [
  {
    key: "delivery_720p",
    env: "REND_BILLING_FEATURE_DELIVERY_720P",
    id: "delivery_720p_seconds",
    type: "delivery",
    singular: "delivery 720p second",
    plural: "delivery 720p seconds",
  },
  {
    key: "delivery_1080p",
    env: "REND_BILLING_FEATURE_DELIVERY_1080P",
    id: "delivery_1080p_seconds",
    type: "delivery",
    singular: "delivery 1080p second",
    plural: "delivery 1080p seconds",
  },
  {
    key: "delivery_2k",
    env: "REND_BILLING_FEATURE_DELIVERY_2K",
    id: "delivery_2k_seconds",
    type: "delivery",
    singular: "delivery 2K second",
    plural: "delivery 2K seconds",
  },
  {
    key: "delivery_4k",
    env: "REND_BILLING_FEATURE_DELIVERY_4K",
    id: "delivery_4k_seconds",
    type: "delivery",
    singular: "Delivery 4K second",
    plural: "Delivery 4K seconds",
  },
  {
    key: "storage_720p",
    env: "REND_BILLING_FEATURE_STORAGE_720P",
    id: "storage_720p_second_months",
    type: "storage",
    singular: "storage 720p second-month",
    plural: "storage 720p second-months",
  },
  {
    key: "storage_1080p",
    env: "REND_BILLING_FEATURE_STORAGE_1080P",
    id: "storage_1080p_second_months",
    type: "storage",
    singular: "storage 1080p second-month",
    plural: "storage 1080p second-months",
  },
  {
    key: "storage_2k",
    env: "REND_BILLING_FEATURE_STORAGE_2K",
    id: "storage_2k_second_months",
    type: "storage",
    singular: "storage 2k second-month",
    plural: "storage 2k second-months",
  },
  {
    key: "storage_4k",
    env: "REND_BILLING_FEATURE_STORAGE_4K",
    id: "storage_4k_second_months",
    type: "storage",
    singular: "Storage 4K second-month",
    plural: "Storage 4K second-months",
  },
];

const requiredPlans = [
  {
    key: "payg",
    env: "REND_AUTUMN_PLAN_PAYG_ID",
    id: "pay_as_you_go",
    includedCredit: 0,
    basePrice: null,
  },
  {
    key: "builder",
    env: "REND_AUTUMN_PLAN_BUILDER_ID",
    id: "builder",
    includedCredit: 100,
    basePrice: 19,
  },
  {
    key: "scale",
    env: "REND_AUTUMN_PLAN_SCALE_ID",
    id: "scale",
    includedCredit: 1000,
    basePrice: 450,
  },
  {
    key: "enterprise",
    env: "REND_AUTUMN_PLAN_ENTERPRISE_ID",
    id: "enterprise",
    includedCredit: 10000,
    basePrice: 4500,
  },
];

const usageCreditFeature = {
  env: "REND_AUTUMN_USAGE_CREDIT_FEATURE_ID",
  id: "rend_usage_credits",
  singular: "rend usage credit",
  plural: "rend usage credits",
};

function usage() {
  return `Usage: node scripts/autumn-catalog-parity.mjs [options]

Compares the Autumn sandbox catalog against the Autumn production catalog using
separate env files. The command is read-only.

Options:
  --sandbox-env-file FILE
      Env file containing the Autumn sandbox key. Defaults to .env.local.
      Env: REND_AUTUMN_SANDBOX_ENV_FILE.
  --production-env-file FILE
      Env file containing the Autumn live key. Defaults to .env.production.local.
      Env: REND_AUTUMN_PRODUCTION_ENV_FILE.
  --allow-production-env-file-override
      Permit a production env filename other than .env.production.local.
  --artifact FILE
      Write the parity artifact to FILE. Defaults under .rend/launch/.
  --timeout-ms NUMBER
      HTTP timeout per Autumn call. Defaults to ${DEFAULT_TIMEOUT_MS}.
  -h, --help
      Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    sandboxEnvFile: process.env.REND_AUTUMN_SANDBOX_ENV_FILE || ".env.local",
    productionEnvFile:
      process.env.REND_AUTUMN_PRODUCTION_ENV_FILE || ".env.production.local",
    allowProductionEnvFileOverride: false,
    artifact: process.env.REND_AUTUMN_PARITY_ARTIFACT || "",
    timeoutMs: positiveInteger(process.env.REND_AUTUMN_PARITY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--sandbox-env-file") args.sandboxEnvFile = next();
    else if (arg.startsWith("--sandbox-env-file=")) {
      args.sandboxEnvFile = arg.slice("--sandbox-env-file=".length);
    } else if (arg === "--production-env-file") args.productionEnvFile = next();
    else if (arg.startsWith("--production-env-file=")) {
      args.productionEnvFile = arg.slice("--production-env-file=".length);
    } else if (arg === "--allow-production-env-file-override") {
      args.allowProductionEnvFileOverride = true;
    } else if (arg === "--artifact") args.artifact = next();
    else if (arg.startsWith("--artifact=")) args.artifact = arg.slice("--artifact=".length);
    else if (arg === "--timeout-ms") args.timeoutMs = positiveInteger(next(), DEFAULT_TIMEOUT_MS);
    else if (arg.startsWith("--timeout-ms=")) {
      args.timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), DEFAULT_TIMEOUT_MS);
    } else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function isoNow() {
  return new Date().toISOString();
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function resolvePath(file) {
  if (!file) return "";
  return path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
}

function displayPath(file) {
  const relative = path.relative(repoRoot, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replaceAll(path.sep, "/")
    : file;
}

function envString(env, key, fallback = "") {
  return String(env[key] ?? fallback).trim();
}

function keyFingerprint(secretKey) {
  return crypto.createHash("sha256").update(secretKey, "utf8").digest("hex").slice(0, 16);
}

function classifyAutumnKey(secretKey) {
  if (/^am_sk_live_/i.test(secretKey) || /(?:^|[_-])live(?:[_-])/i.test(secretKey)) {
    return "live";
  }
  if (
    /^am_sk_test_/i.test(secretKey) ||
    /(?:^|[_-])test(?:[_-])/i.test(secretKey) ||
    /(?:^|[_-])sandbox(?:[_-])/i.test(secretKey)
  ) {
    return "sandbox";
  }
  return "unknown";
}

function configuredFeatureIds(env) {
  return Object.fromEntries(
    requiredMeterFeatures.map((spec) => [spec.key, envString(env, spec.env, spec.id)]),
  );
}

function configuredPlanIds(env) {
  return Object.fromEntries(requiredPlans.map((spec) => [spec.key, envString(env, spec.env, spec.id)]));
}

function loadAutumnEnv(label, file) {
  const resolved = resolvePath(file);
  const errors = [];
  if (!existsSync(resolved)) {
    errors.push(`${label} env file does not exist: ${displayPath(resolved)}`);
    return { label, file: resolved, errors };
  }

  const env = parseEnvFile(resolved);
  const secretKey = envString(env, "AUTUMN_SECRET_KEY");
  const apiUrl = envString(env, "AUTUMN_API_URL", DEFAULT_AUTUMN_API_URL).replace(/\/+$/, "");
  const apiVersion = envString(env, "AUTUMN_API_VERSION", DEFAULT_AUTUMN_API_VERSION);
  if (!secretKey) errors.push(`${label} env file is missing AUTUMN_SECRET_KEY`);
  if (!apiUrl.startsWith("https://")) errors.push(`${label} AUTUMN_API_URL must use https`);

  return {
    label,
    file: resolved,
    env,
    errors,
    secretKey,
    apiUrl,
    apiVersion,
    keyMode: secretKey ? classifyAutumnKey(secretKey) : "missing",
    keyFingerprint: secretKey ? keyFingerprint(secretKey) : null,
    featureIds: configuredFeatureIds(env),
    usageCreditFeatureId: envString(env, usageCreditFeature.env, usageCreditFeature.id),
    planIds: configuredPlanIds(env),
  };
}

function validateConfig({ sandbox, production, args }) {
  const errors = [...(sandbox.errors || []), ...(production.errors || [])];
  const warnings = [];

  if (
    !args.allowProductionEnvFileOverride &&
    path.basename(production.file || "") !== ".env.production.local"
  ) {
    errors.push("production Autumn parity must load AUTUMN_SECRET_KEY from .env.production.local");
  }

  if (sandbox.secretKey && production.secretKey && sandbox.secretKey === production.secretKey) {
    errors.push("sandbox and production Autumn keys must be different");
  }
  if (sandbox.keyMode === "live") {
    errors.push("sandbox Autumn key is a live key");
  } else if (sandbox.keyMode === "unknown") {
    errors.push("sandbox Autumn key must be visibly marked as test/sandbox");
  }
  if (production.keyMode !== "live") {
    errors.push("production Autumn key must be visibly marked as live");
  }

  for (const spec of requiredMeterFeatures) {
    if (sandbox.featureIds?.[spec.key] !== spec.id) {
      errors.push(`sandbox feature ${spec.key} must be ${spec.id}`);
    }
    if (production.featureIds?.[spec.key] !== spec.id) {
      errors.push(`production feature ${spec.key} must be ${spec.id}`);
    }
  }
  if (sandbox.usageCreditFeatureId !== usageCreditFeature.id) {
    errors.push(`sandbox usage credit feature must be ${usageCreditFeature.id}`);
  }
  if (production.usageCreditFeatureId !== usageCreditFeature.id) {
    errors.push(`production usage credit feature must be ${usageCreditFeature.id}`);
  }
  for (const spec of requiredPlans) {
    if (sandbox.planIds?.[spec.key] !== spec.id) {
      errors.push(`sandbox plan ${spec.key} must be ${spec.id}`);
    }
    if (production.planIds?.[spec.key] !== spec.id) {
      errors.push(`production plan ${spec.key} must be ${spec.id}`);
    }
  }

  return { errors, warnings };
}

async function autumnPost(config, routePath, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.apiUrl}/${routePath}`, {
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
      const message = String(data.message || data.error || `HTTP ${response.status}`).slice(0, 240);
      const error = new Error(`Autumn ${routePath} failed: ${message}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCatalog(config) {
  const featureIds = [
    ...requiredMeterFeatures.map((spec) => config.featureIds[spec.key]),
    config.usageCreditFeatureId,
  ];
  const planIds = requiredPlans.map((spec) => config.planIds[spec.key]);
  const features = {};
  const plans = {};
  const errors = [];

  for (const featureId of featureIds) {
    try {
      features[featureId] = await autumnPost(config, "features.get", { feature_id: featureId });
    } catch (error) {
      errors.push(`${config.label} missing feature ${featureId}: ${error.message}`);
    }
  }
  for (const planId of planIds) {
    try {
      plans[planId] = await autumnPost(config, "plans.get", { plan_id: planId });
    } catch (error) {
      errors.push(`${config.label} missing plan ${planId}: ${error.message}`);
    }
  }

  return { features, plans, errors };
}

function comparableCatalog(catalog) {
  return {
    features: Object.fromEntries(
      Object.entries(catalog.features || {}).map(([id, value]) => [id, normalizeComparable(value)]),
    ),
    plans: Object.fromEntries(
      Object.entries(catalog.plans || {}).map(([id, value]) => [id, normalizeComparable(value)]),
    ),
  };
}

function isIgnoredComparableKey(key) {
  return (
    /^(id|env|display|created_at|updated_at|deleted_at|archived_at|last_synced_at)$/i.test(key) ||
    /^(createdAt|updatedAt|deletedAt|archivedAt)$/i.test(key) ||
    /^stripe_/i.test(key) ||
    /stripe/i.test(key) ||
    /^(product_id|price_id|internal_id|external_id|object_id)$/i.test(key) ||
    /^(productId|priceId|internalId|externalId|objectId)$/i.test(key)
  );
}

function normalizeComparable(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeComparable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, entry] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (isIgnoredComparableKey(key)) continue;
    const normalized = normalizeComparable(entry);
    if (normalized === undefined) continue;
    output[key] = normalized;
  }
  return output;
}

function diffValues(expected, actual, pointer = "", output = []) {
  if (output.length >= 100) return output;
  if (Object.is(expected, actual)) return output;

  const expectedArray = Array.isArray(expected);
  const actualArray = Array.isArray(actual);
  if (expectedArray || actualArray) {
    if (!expectedArray || !actualArray) {
      output.push({ path: pointer || "/", sandbox: expected, production: actual });
      return output;
    }
    if (expected.length !== actual.length) {
      output.push({ path: `${pointer || "/"}/length`, sandbox: expected.length, production: actual.length });
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      diffValues(expected[index], actual[index], `${pointer}/${index}`, output);
    }
    return output;
  }

  const expectedObject = expected && typeof expected === "object";
  const actualObject = actual && typeof actual === "object";
  if (expectedObject || actualObject) {
    if (!expectedObject || !actualObject) {
      output.push({ path: pointer || "/", sandbox: expected, production: actual });
      return output;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      if (!Object.prototype.hasOwnProperty.call(expected, key)) {
        output.push({ path: `${pointer}/${key}`, sandbox: undefined, production: actual[key] });
      } else if (!Object.prototype.hasOwnProperty.call(actual, key)) {
        output.push({ path: `${pointer}/${key}`, sandbox: expected[key], production: undefined });
      } else {
        diffValues(expected[key], actual[key], `${pointer}/${key}`, output);
      }
      if (output.length >= 100) break;
    }
    return output;
  }

  output.push({ path: pointer || "/", sandbox: expected, production: actual });
  return output;
}

function firstStringForKey(value, targetKey) {
  if (!value || typeof value !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(value, targetKey) && typeof value[targetKey] === "string") {
    return value[targetKey].trim();
  }
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        const found = firstStringForKey(item, targetKey);
        if (found) return found;
      }
    } else if (entry && typeof entry === "object") {
      const found = firstStringForKey(entry, targetKey);
      if (found) return found;
    }
  }
  return "";
}

function firstNumberForKey(value, targetKey) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(value, targetKey)) {
    const number = Number(value[targetKey]);
    if (Number.isFinite(number)) return number;
  }
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        const found = firstNumberForKey(item, targetKey);
        if (found !== undefined) return found;
      }
    } else if (entry && typeof entry === "object") {
      const found = firstNumberForKey(entry, targetKey);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function objectsContainingString(value, target) {
  const matches = [];
  function visit(entry) {
    if (!entry || typeof entry !== "object") return;
    if (
      !Array.isArray(entry) &&
      Object.values(entry).some((candidate) => typeof candidate === "string" && candidate === target)
    ) {
      matches.push(entry);
    }
    for (const child of Array.isArray(entry) ? entry : Object.values(entry)) {
      if (child && typeof child === "object") visit(child);
    }
  }
  visit(value);
  return matches;
}

function validateCatalogShape(label, catalog) {
  const errors = [];
  const warnings = [];
  const creditFeatureId = usageCreditFeature.id;

  for (const spec of requiredMeterFeatures) {
    const feature = catalog.features?.[spec.id];
    if (!feature) {
      errors.push(`${label} feature ${spec.id} was not returned`);
      continue;
    }
    const featureId = firstStringForKey(feature, "feature_id") || firstStringForKey(feature, "id");
    if (featureId && featureId !== spec.id) errors.push(`${label} feature ${spec.id} returned id ${featureId}`);
    const featureType = firstStringForKey(feature, "type");
    if (featureType !== "metered") errors.push(`${label} feature ${spec.id} must be type metered`);
    const displayText = [
      firstStringForKey(feature, "singular"),
      firstStringForKey(feature, "plural"),
    ]
      .join(" ")
      .toLowerCase();
    const tier = spec.id
      .replace(/^delivery_/, "")
      .replace(/^storage_/, "")
      .replace(/_seconds$/, "")
      .replace(/_second_months$/, "")
      .replaceAll("_", "");
    const expectedUnit = spec.type === "delivery" ? "second" : "second-month";
    if (!displayText.includes(spec.type) || !displayText.includes(tier) || !displayText.includes(expectedUnit)) {
      errors.push(`${label} feature ${spec.id} display units must include ${spec.type}, ${tier}, and ${expectedUnit}`);
    }
  }

  const creditFeature = catalog.features?.[creditFeatureId];
  if (!creditFeature) {
    errors.push(`${label} usage credit feature ${creditFeatureId} was not returned`);
  } else {
    const creditType = firstStringForKey(creditFeature, "type");
    if (creditType !== "credit_system") {
      errors.push(`${label} usage credit feature ${creditFeatureId} must be type credit_system`);
    }
    const creditDisplayText = [
      firstStringForKey(creditFeature, "singular"),
      firstStringForKey(creditFeature, "plural"),
    ]
      .join(" ")
      .toLowerCase();
    for (const token of ["rend", "usage", "credit"]) {
      if (!creditDisplayText.includes(token)) {
        errors.push(`${label} usage credit feature display units must include ${token}`);
        break;
      }
    }
    for (const spec of requiredMeterFeatures) {
      const creditRows = objectsContainingString(creditFeature, spec.id);
      if (creditRows.length === 0) {
        errors.push(`${label} usage credit feature missing credit schema row for ${spec.id}`);
        continue;
      }
      const creditCost = creditRows
        .map((row) => firstNumberForKey(row, "credit_cost"))
        .find((value) => value !== undefined);
      if (creditCost === undefined || creditCost < 0) {
        errors.push(`${label} usage credit feature ${spec.id} credit_cost must be non-negative`);
      }
    }
  }

  for (const spec of requiredPlans) {
    const plan = catalog.plans?.[spec.id];
    if (!plan) {
      errors.push(`${label} plan ${spec.id} was not returned`);
      continue;
    }
    const planId = firstStringForKey(plan, "plan_id") || firstStringForKey(plan, "id");
    if (planId && planId !== spec.id) errors.push(`${label} plan ${spec.id} returned id ${planId}`);
    const creditItems = objectsContainingString(plan, creditFeatureId);
    if (creditItems.length === 0) {
      errors.push(`${label} plan ${spec.id} is not attached to ${creditFeatureId}`);
      continue;
    }
    const included = creditItems
      .map((item) => firstNumberForKey(item, "included"))
      .find((value) => value !== undefined);
    if (included !== spec.includedCredit) {
      errors.push(`${label} plan ${spec.id} included usage credit must be ${spec.includedCredit}`);
    }
    const usagePriceItem = creditItems.find((item) => JSON.stringify(item).includes("usage_based"));
    if (!usagePriceItem) {
      errors.push(`${label} plan ${spec.id} must have usage-based overage pricing for ${creditFeatureId}`);
    }
  }

  return { errors, warnings };
}

function compareCatalogs(sandboxComparable, productionComparable) {
  const comparisons = { features: {}, plans: {} };
  const errors = [];

  for (const spec of [...requiredMeterFeatures, { id: usageCreditFeature.id }]) {
    const sandboxValue = sandboxComparable.features[spec.id];
    const productionValue = productionComparable.features[spec.id];
    const diffs = diffValues(sandboxValue, productionValue);
    comparisons.features[spec.id] = {
      status: diffs.length > 0 ? "fail" : "pass",
      diff_count: diffs.length,
      diffs,
    };
    if (diffs.length > 0) errors.push(`feature ${spec.id} differs between sandbox and production`);
  }

  for (const spec of requiredPlans) {
    const sandboxValue = sandboxComparable.plans[spec.id];
    const productionValue = productionComparable.plans[spec.id];
    const diffs = diffValues(sandboxValue, productionValue);
    comparisons.plans[spec.id] = {
      status: diffs.length > 0 ? "fail" : "pass",
      diff_count: diffs.length,
      diffs,
    };
    if (diffs.length > 0) errors.push(`plan ${spec.id} differs between sandbox and production`);
  }

  return { comparisons, errors };
}

function artifactPath(args, id) {
  if (args.artifact) return resolvePath(args.artifact);
  return path.join(repoRoot, ".rend", "launch", `autumn-catalog-parity-${id}.json`);
}

async function writeArtifact(file, document) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  const latest = path.join(path.dirname(file), "autumn-catalog-parity-latest.json");
  await copyFile(file, latest).catch(() => undefined);
  return { outputPath: file, latestPath: latest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  const id = runId();
  const startedAt = isoNow();
  const sandbox = loadAutumnEnv("sandbox", args.sandboxEnvFile);
  const production = loadAutumnEnv("production", args.productionEnvFile);
  const configValidation = validateConfig({ sandbox, production, args });
  const errors = [...configValidation.errors];
  const warnings = [...configValidation.warnings];
  let sandboxCatalog = { features: {}, plans: {}, errors: [] };
  let productionCatalog = { features: {}, plans: {}, errors: [] };
  let comparisons = { features: {}, plans: {} };

  if (errors.length === 0) {
    sandboxCatalog = await fetchCatalog({ ...sandbox, timeoutMs: args.timeoutMs });
    productionCatalog = await fetchCatalog({ ...production, timeoutMs: args.timeoutMs });
    errors.push(...sandboxCatalog.errors, ...productionCatalog.errors);
  }

  if (errors.length === 0) {
    const sandboxShape = validateCatalogShape("sandbox", sandboxCatalog);
    const productionShape = validateCatalogShape("production", productionCatalog);
    errors.push(...sandboxShape.errors, ...productionShape.errors);
    warnings.push(...sandboxShape.warnings, ...productionShape.warnings);

    const compared = compareCatalogs(comparableCatalog(sandboxCatalog), comparableCatalog(productionCatalog));
    comparisons = compared.comparisons;
    errors.push(...compared.errors);
  }

  const status = errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass";
  const document = {
    schema_version: 1,
    kind: "rend-autumn-catalog-parity",
    run_id: id,
    status,
    started_at: startedAt,
    ended_at: isoNow(),
    read_only: true,
    required: {
      plan_ids: requiredPlans.map((spec) => spec.id),
      meter_feature_ids: requiredMeterFeatures.map((spec) => spec.id),
      usage_credit_feature_id: usageCreditFeature.id,
    },
    sandbox: {
      env_file: sandbox.file ? displayPath(sandbox.file) : null,
      api_url: sandbox.apiUrl || null,
      api_version: sandbox.apiVersion || null,
      key_mode: sandbox.keyMode,
      key_fingerprint: sandbox.keyFingerprint,
      feature_ids: sandbox.featureIds || {},
      usage_credit_feature_id: sandbox.usageCreditFeatureId || null,
      plan_ids: sandbox.planIds || {},
      features_verified: Object.keys(sandboxCatalog.features || {}).length,
      plans_verified: Object.keys(sandboxCatalog.plans || {}).length,
    },
    production: {
      env_file: production.file ? displayPath(production.file) : null,
      api_url: production.apiUrl || null,
      api_version: production.apiVersion || null,
      key_mode: production.keyMode,
      key_fingerprint: production.keyFingerprint,
      feature_ids: production.featureIds || {},
      usage_credit_feature_id: production.usageCreditFeatureId || null,
      plan_ids: production.planIds || {},
      features_verified: Object.keys(productionCatalog.features || {}).length,
      plans_verified: Object.keys(productionCatalog.plans || {}).length,
    },
    comparisons,
    errors,
    warnings,
  };

  const output = artifactPath(args, id);
  const written = await writeArtifact(output, document);
  console.log(`Autumn catalog parity ${status.toUpperCase()}`);
  console.log(`Artifact: ${displayPath(written.outputPath)}`);
  console.log(`Latest: ${displayPath(written.latestPath)}`);
  if (errors.length > 0) {
    for (const error of errors.slice(0, 12)) console.error(`[autumn-parity] ${error}`);
  }
  return status === "fail" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
