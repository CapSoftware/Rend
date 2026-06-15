#!/usr/bin/env node

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com/v1";
const DEFAULT_AUTUMN_API_VERSION = "2.3.0";
const USAGE_CREDIT_FEATURE_ID = "rend_usage_credits";
const INTERNAL_DRY_RUN_PLAN_ID = "internal_production_dry_run";
const MUX_BASIC_RATE_SOURCE = "https://www.mux.com/pricing";

const featureSpecs = [
  {
    key: "DELIVERY_720P",
    env: "REND_BILLING_FEATURE_DELIVERY_720P",
    costEnv: "REND_AUTUMN_UNIT_COST_DELIVERY_720P",
    id: "delivery_720p_seconds",
    name: "Delivery 720p seconds",
    singular: "delivery 720p second",
    plural: "delivery 720p seconds",
  },
  {
    key: "DELIVERY_1080P",
    env: "REND_BILLING_FEATURE_DELIVERY_1080P",
    costEnv: "REND_AUTUMN_UNIT_COST_DELIVERY_1080P",
    id: "delivery_1080p_seconds",
    name: "Delivery 1080p seconds",
    singular: "delivery 1080p second",
    plural: "delivery 1080p seconds",
  },
  {
    key: "DELIVERY_2K",
    env: "REND_BILLING_FEATURE_DELIVERY_2K",
    costEnv: "REND_AUTUMN_UNIT_COST_DELIVERY_2K",
    id: "delivery_2k_seconds",
    name: "Delivery 2K seconds",
    singular: "delivery 2K second",
    plural: "delivery 2K seconds",
  },
  {
    key: "DELIVERY_4K",
    env: "REND_BILLING_FEATURE_DELIVERY_4K",
    costEnv: "REND_AUTUMN_UNIT_COST_DELIVERY_4K",
    id: "delivery_4k_seconds",
    name: "Delivery 4K seconds",
    singular: "Delivery 4K second",
    plural: "Delivery 4K seconds",
  },
  {
    key: "STORAGE_720P",
    env: "REND_BILLING_FEATURE_STORAGE_720P",
    costEnv: "REND_AUTUMN_UNIT_COST_STORAGE_720P",
    id: "storage_720p_second_months",
    name: "Storage 720p second-months",
    singular: "storage 720p second-month",
    plural: "storage 720p second-months",
  },
  {
    key: "STORAGE_1080P",
    env: "REND_BILLING_FEATURE_STORAGE_1080P",
    costEnv: "REND_AUTUMN_UNIT_COST_STORAGE_1080P",
    id: "storage_1080p_second_months",
    name: "Storage 1080p second-months",
    singular: "storage 1080p second-month",
    plural: "storage 1080p second-months",
  },
  {
    key: "STORAGE_2K",
    env: "REND_BILLING_FEATURE_STORAGE_2K",
    costEnv: "REND_AUTUMN_UNIT_COST_STORAGE_2K",
    id: "storage_2k_second_months",
    name: "Storage 2K second-months",
    singular: "storage 2k second-month",
    plural: "storage 2k second-months",
  },
  {
    key: "STORAGE_4K",
    env: "REND_BILLING_FEATURE_STORAGE_4K",
    costEnv: "REND_AUTUMN_UNIT_COST_STORAGE_4K",
    id: "storage_4k_second_months",
    name: "Storage 4K second-months",
    singular: "Storage 4K second-month",
    plural: "Storage 4K second-months",
  },
];

const planSpecs = [
  {
    env: "REND_AUTUMN_PLAN_PAYG_ID",
    id: "pay_as_you_go",
    name: "Pay as you go",
    description: "Card required. Metered delivery and storage with no included usage credit.",
    basePrice: null,
    includedCredit: 0,
  },
  {
    env: "REND_AUTUMN_PLAN_BUILDER_ID",
    id: "builder",
    name: "Builder",
    description: "$19/mo with $100 included usage credit.",
    basePrice: 19,
    includedCredit: 100,
  },
  {
    env: "REND_AUTUMN_PLAN_SCALE_ID",
    id: "scale",
    name: "Scale",
    description: "$450/mo with $1,000 included usage credit.",
    basePrice: 450,
    includedCredit: 1000,
  },
  {
    env: "REND_AUTUMN_PLAN_ENTERPRISE_ID",
    id: "enterprise",
    name: "Enterprise",
    description: "$4,500/mo with $10,000 included usage credit.",
    basePrice: 4500,
    includedCredit: 10000,
  },
];

const internalDryRunPlanSpec = {
  env: "REND_AUTUMN_INTERNAL_DRY_RUN_PLAN_ID",
  id: INTERNAL_DRY_RUN_PLAN_ID,
  name: "Internal Production Dry Run",
  description: "Internal-only plan for controlled Rend production billing dry runs.",
  includedCredit: 10,
};

const muxBasicUnitCosts = new Map([
  ["REND_AUTUMN_UNIT_COST_DELIVERY_720P", 0.0008 / 60],
  ["REND_AUTUMN_UNIT_COST_DELIVERY_1080P", 0.001 / 60],
  ["REND_AUTUMN_UNIT_COST_DELIVERY_2K", 0.0016 / 60],
  ["REND_AUTUMN_UNIT_COST_DELIVERY_4K", 0.0032 / 60],
  ["REND_AUTUMN_UNIT_COST_STORAGE_720P", 0.0024 / 60],
  ["REND_AUTUMN_UNIT_COST_STORAGE_1080P", 0.003 / 60],
  ["REND_AUTUMN_UNIT_COST_STORAGE_2K", 0.0048 / 60],
  ["REND_AUTUMN_UNIT_COST_STORAGE_4K", 0.0096 / 60],
]);

function usage() {
  return `Usage: node scripts/setup-autumn-billing.mjs [--features-only] [--plans] [--internal-dry-run-plan] [--mux-basic-rates] [--allow-production-mutation] [--verify-customer] [--verify-attach] [--verify-portal]

Upserts the Rend V1 Autumn catalog using AUTUMN_SECRET_KEY and AUTUMN_API_URL.

By default this upserts only the eight required meter features. Passing --plans
also upserts the usage-credit feature and the PAYG/Builder/Scale/Enterprise
plans, but requires all REND_AUTUMN_UNIT_COST_* env vars to be set.
Passing --internal-dry-run-plan upserts an internal-only, non-Stripe dry-run
plan with included usage credits for controlled production verification.
Pass --mux-basic-rates to fill those costs from Mux Basic public pricing.
Production/live keys require --allow-production-mutation.

Verification flags:
  --verify-customer  calls customers.get_or_create for REND_AUTUMN_VERIFY_CUSTOMER_ID
  --verify-attach    calls billing.attach for REND_AUTUMN_VERIFY_CUSTOMER_ID and REND_AUTUMN_VERIFY_PLAN_ID
  --verify-portal    calls customer billing portal for REND_AUTUMN_VERIFY_CUSTOMER_ID
`;
}

function envString(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function parseArgs(argv) {
  const args = {
    featuresOnly: false,
    plans: false,
    verifyCustomer: false,
    verifyAttach: false,
    verifyPortal: false,
    muxBasicRates: false,
    allowProductionMutation: false,
    internalDryRunPlan: false,
  };
  for (const arg of argv) {
    if (arg === "--features-only") args.featuresOnly = true;
    else if (arg === "--plans") args.plans = true;
    else if (arg === "--verify-customer") args.verifyCustomer = true;
    else if (arg === "--verify-attach") args.verifyAttach = true;
    else if (arg === "--verify-portal") args.verifyPortal = true;
    else if (arg === "--mux-basic-rates") args.muxBasicRates = true;
    else if (arg === "--allow-production-mutation") args.allowProductionMutation = true;
    else if (arg === "--internal-dry-run-plan") args.internalDryRunPlan = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.featuresOnly && (args.plans || args.internalDryRunPlan)) {
    throw new Error("--features-only cannot be combined with plan setup flags");
  }
  return args;
}

function autumnConfig() {
  const secretKey = envString("AUTUMN_SECRET_KEY");
  if (!secretKey) {
    throw new Error("AUTUMN_SECRET_KEY is required");
  }
  return {
    apiUrl: envString("AUTUMN_API_URL", DEFAULT_AUTUMN_API_URL).replace(/\/+$/, ""),
    apiVersion: envString("AUTUMN_API_VERSION", DEFAULT_AUTUMN_API_VERSION),
    secretKey,
  };
}

function classifyAutumnKey(secretKey) {
  if (/^am_sk_live_/i.test(secretKey) || /(?:^|[_-])live(?:[_-])/i.test(secretKey)) return "live";
  if (
    /^am_sk_test_/i.test(secretKey) ||
    /(?:^|[_-])test(?:[_-])/i.test(secretKey) ||
    /(?:^|[_-])sandbox(?:[_-])/i.test(secretKey)
  ) {
    return "sandbox";
  }
  return "unknown";
}

function isProductionProfile() {
  const profile = envString("REND_ENV_PROFILE") || envString("REND_ENV") || process.env.NODE_ENV || "";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function enforceMutationSafety(config, args) {
  const liveKey = classifyAutumnKey(config.secretKey) === "live";
  if ((isProductionProfile() || liveKey) && !args.allowProductionMutation) {
    throw new Error("refusing production/live Autumn mutation without --allow-production-mutation");
  }
  if (isProductionProfile() && classifyAutumnKey(config.secretKey) !== "live") {
    throw new Error("production Autumn setup requires a visibly live AUTUMN_SECRET_KEY");
  }
}

async function autumnPost(config, path, body) {
  const response = await fetch(`${config.apiUrl}/${path}`, {
    method: "POST",
    headers: {
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
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function isMissing(error) {
  return error && (error.status === 404 || /not[ _-]?found|does not exist/i.test(error.message));
}

function displayFeatureId(spec) {
  return envString(spec.env, spec.id);
}

async function upsertFeature(config, body) {
  try {
    await autumnPost(config, "features.get", { feature_id: body.feature_id });
    await autumnPost(config, "features.update", body);
    return "updated";
  } catch (error) {
    if (!isMissing(error)) throw error;
    await autumnPost(config, "features.create", body);
    return "created";
  }
}

async function upsertPlan(config, body) {
  try {
    await autumnPost(config, "plans.get", { plan_id: body.plan_id });
    await autumnPost(config, "plans.update", { ...body, disable_version: false });
    return "updated";
  } catch (error) {
    if (!isMissing(error)) throw error;
    await autumnPost(config, "plans.create", body);
    return "created";
  }
}

async function upsertMeterFeatures(config) {
  for (const spec of featureSpecs) {
    const featureId = displayFeatureId(spec);
    const action = await upsertFeature(config, {
      feature_id: featureId,
      name: spec.name,
      type: "metered",
      consumable: true,
      display: {
        singular: spec.singular,
        plural: spec.plural,
      },
    });
    console.log(`${action} feature ${featureId}`);
  }
}

function parseUnitCosts({ muxBasicRates }) {
  const missing = [];
  const costs = new Map();
  for (const spec of featureSpecs) {
    const raw = envString(spec.costEnv) || (muxBasicRates ? String(muxBasicUnitCosts.get(spec.costEnv) ?? "") : "");
    if (!raw) {
      missing.push(spec.costEnv);
      continue;
    }
    const cost = Number(raw);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error(`${spec.costEnv} must be a non-negative number`);
    }
    costs.set(displayFeatureId(spec), cost);
  }
  if (missing.length > 0) {
    throw new Error(
      [
        "Plan setup requires explicit unit costs; refusing to create plans with invented pricing.",
        `Missing: ${missing.join(", ")}`,
      ].join("\n")
    );
  }
  if (muxBasicRates) {
    console.log(`using Mux Basic public rates from ${MUX_BASIC_RATE_SOURCE}`);
  }
  return costs;
}

async function upsertUsageCreditFeature(config, costs) {
  const featureId = envString("REND_AUTUMN_USAGE_CREDIT_FEATURE_ID", USAGE_CREDIT_FEATURE_ID);
  const creditSchema = [...costs.entries()].map(([meteredFeatureId, creditCost]) => ({
    metered_feature_id: meteredFeatureId,
    credit_cost: creditCost,
  }));
  const action = await upsertFeature(config, {
    feature_id: featureId,
    name: "Rend usage credits",
    type: "credit_system",
    consumable: true,
    credit_schema: creditSchema,
    display: {
      singular: "rend usage credit",
      plural: "rend usage credits",
    },
  });
  console.log(`${action} feature ${featureId}`);
  return featureId;
}

function planBody(spec, creditFeatureId) {
  const planId = envString(spec.env, spec.id);
  const body = {
    plan_id: planId,
    name: spec.name,
    description: spec.description,
    group: envString("REND_AUTUMN_PLAN_GROUP", "rend_v1"),
    items: [
      {
        feature_id: creditFeatureId,
        included: spec.includedCredit,
        reset: { interval: "month" },
        price: {
          amount: 1,
          interval: "month",
          billing_units: 1,
          billing_method: "usage_based",
        },
      },
    ],
    config: {
      ignore_past_due: false,
    },
    create_in_stripe: true,
  };
  if (spec.basePrice !== null) {
    body.price = { amount: spec.basePrice, interval: "month" };
  }
  return body;
}

async function upsertPlans(config, creditFeatureId) {
  for (const spec of planSpecs) {
    const body = planBody(spec, creditFeatureId);
    const action = await upsertPlan(config, body);
    console.log(`${action} plan ${body.plan_id}`);
  }
}

function internalDryRunPlanBody(creditFeatureId) {
  const included = Number(
    envString("REND_AUTUMN_INTERNAL_DRY_RUN_INCLUDED_CREDIT", String(internalDryRunPlanSpec.includedCredit)),
  );
  if (!Number.isFinite(included) || included <= 0) {
    throw new Error("REND_AUTUMN_INTERNAL_DRY_RUN_INCLUDED_CREDIT must be a positive number");
  }
  return {
    plan_id: envString(internalDryRunPlanSpec.env, internalDryRunPlanSpec.id),
    name: internalDryRunPlanSpec.name,
    description: internalDryRunPlanSpec.description,
    group: envString("REND_AUTUMN_PLAN_GROUP", "rend_v1"),
    items: [
      {
        feature_id: creditFeatureId,
        included,
        reset: { interval: "month" },
      },
    ],
    config: {
      ignore_past_due: true,
    },
    create_in_stripe: false,
  };
}

async function upsertInternalDryRunPlan(config, creditFeatureId) {
  const body = internalDryRunPlanBody(creditFeatureId);
  const action = await upsertPlan(config, body);
  console.log(`${action} plan ${body.plan_id}`);
}

async function verifyCustomer(config) {
  const customerId = envString("REND_AUTUMN_VERIFY_CUSTOMER_ID");
  if (!customerId) {
    throw new Error("REND_AUTUMN_VERIFY_CUSTOMER_ID is required for --verify-customer");
  }
  await autumnPost(config, "customers.get_or_create", {
    customer_id: customerId,
    name: envString("REND_AUTUMN_VERIFY_CUSTOMER_NAME", "Rend billing verification"),
    email: envString("REND_AUTUMN_VERIFY_CUSTOMER_EMAIL") || undefined,
    metadata: {
      source: "rend-autumn-setup",
    },
  });
  console.log(`verified customer ${customerId}`);
}

async function verifyAttach(config) {
  const customerId = envString("REND_AUTUMN_VERIFY_CUSTOMER_ID");
  const planId = envString("REND_AUTUMN_VERIFY_PLAN_ID", envString("REND_AUTUMN_PLAN_PAYG_ID", "pay_as_you_go"));
  if (!customerId) {
    throw new Error("REND_AUTUMN_VERIFY_CUSTOMER_ID is required for --verify-attach");
  }
  const result = await autumnPost(config, "billing.attach", {
    customer_id: customerId,
    plan_id: planId,
  });
  const hasCheckoutUrl = Boolean(result.payment_url || result.checkout_url || result.url);
  console.log(`verified attach ${customerId} ${planId}${hasCheckoutUrl ? " checkout_url=true" : ""}`);
}

async function verifyPortal(config) {
  const customerId = envString("REND_AUTUMN_VERIFY_CUSTOMER_ID");
  if (!customerId) {
    throw new Error("REND_AUTUMN_VERIFY_CUSTOMER_ID is required for --verify-portal");
  }
  const result = await autumnPost(config, `customers/${encodeURIComponent(customerId)}/billing_portal`, {
    return_url: envString("REND_AUTUMN_VERIFY_RETURN_URL", "http://localhost:3000/dashboard/billing"),
  });
  const hasPortalUrl = Boolean(result.url || result.portal_url || result.portalUrl);
  if (!hasPortalUrl) {
    throw new Error("billing portal URL was not returned");
  }
  console.log(`verified portal ${customerId} portal_url=true`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = autumnConfig();
  enforceMutationSafety(config, args);
  await upsertMeterFeatures(config);

  if (args.plans || args.internalDryRunPlan) {
    const costs = parseUnitCosts({ muxBasicRates: args.muxBasicRates });
    const creditFeatureId = await upsertUsageCreditFeature(config, costs);
    if (args.plans) {
      await upsertPlans(config, creditFeatureId);
    }
    if (args.internalDryRunPlan) {
      await upsertInternalDryRunPlan(config, creditFeatureId);
    }
  } else if (!args.featuresOnly) {
    console.log("skipped plans; pass --plans with explicit REND_AUTUMN_UNIT_COST_* env vars");
  }

  if (args.verifyCustomer) {
    await verifyCustomer(config);
  }
  if (args.verifyAttach) {
    await verifyAttach(config);
  }
  if (args.verifyPortal) {
    await verifyPortal(config);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
