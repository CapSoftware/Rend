#!/usr/bin/env node

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com/v1";
const DEFAULT_AUTUMN_API_VERSION = "2.3.0";
const DEFAULT_DELIVERY_PRICE_PER_MINUTE = 0.001;
const DEFAULT_STORAGE_PRICE_PER_MINUTE_MONTH = 0.003;
const SECONDS_PER_MINUTE = 60;
const RATE_SOURCE = "https://www.mux.com/pricing";

const featureSpecs = [
  {
    env: "REND_BILLING_FEATURE_DELIVERY",
    id: "delivery_seconds",
    name: "Delivery second",
    singular: "delivery second",
    plural: "delivery seconds",
  },
  {
    env: "REND_BILLING_FEATURE_STORAGE",
    id: "storage_second_months",
    name: "Storage second-month",
    singular: "storage second-month",
    plural: "storage second-months",
  },
];

function usage() {
  return `Usage: node scripts/setup-autumn-billing.mjs [--features-only] [--plans] [--clean-slate] [--mux-basic-rates] [--allow-production-mutation] [--verify-customer] [--verify-attach] [--verify-portal]

Upserts Rend's two public usage meters in Autumn. --plans also creates or
updates the pay-as-you-go plan at $0.001 per delivered minute and $0.003 per
stored minute-month. Rend tracks precise seconds; Autumn prices every 60
tracked units as one minute.

--mux-basic-rates remains as an explicit acknowledgement that the two flat
rates use Mux's current 1080p Basic baseline from ${RATE_SOURCE}.

Production/live keys require --allow-production-mutation.
--clean-slate deletes every Autumn customer, plan, and feature in the selected
environment before creating Rend's two features and pay-as-you-go plan.
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
    cleanSlate: false,
  };
  for (const arg of argv) {
    if (arg === "--features-only") args.featuresOnly = true;
    else if (arg === "--plans") args.plans = true;
    else if (arg === "--verify-customer") args.verifyCustomer = true;
    else if (arg === "--verify-attach") args.verifyAttach = true;
    else if (arg === "--verify-portal") args.verifyPortal = true;
    else if (arg === "--mux-basic-rates") args.muxBasicRates = true;
    else if (arg === "--allow-production-mutation") args.allowProductionMutation = true;
    else if (arg === "--clean-slate") args.cleanSlate = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.featuresOnly && args.plans) {
    throw new Error("--features-only cannot be combined with plan setup flags");
  }
  if (args.cleanSlate && !args.plans) {
    throw new Error("--clean-slate must be combined with --plans");
  }
  return args;
}

function autumnConfig() {
  const secretKey = envString("AUTUMN_SECRET_KEY");
  if (!secretKey) throw new Error("AUTUMN_SECRET_KEY is required");
  return {
    apiUrl: envString("AUTUMN_API_URL", DEFAULT_AUTUMN_API_URL).replace(/\/+$/, ""),
    apiVersion: envString("AUTUMN_API_VERSION", DEFAULT_AUTUMN_API_VERSION),
    secretKey,
  };
}

function classifyAutumnKey(secretKey) {
  if (/^am_sk_live_/i.test(secretKey) || /(?:^|[_-])live(?:[_-])/i.test(secretKey)) return "live";
  if (/^am_sk_test_/i.test(secretKey) || /(?:^|[_-])(test|sandbox)(?:[_-])/i.test(secretKey)) return "sandbox";
  return "unknown";
}

function isProductionProfile() {
  const profile = envString("REND_ENV_PROFILE") || envString("REND_ENV") || process.env.NODE_ENV || "";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function enforceMutationSafety(config, args) {
  const keyMode = classifyAutumnKey(config.secretKey);
  if ((isProductionProfile() || keyMode === "live") && !args.allowProductionMutation) {
    throw new Error("refusing production/live Autumn mutation without --allow-production-mutation");
  }
  if (isProductionProfile() && keyMode !== "live") {
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
    throw error;
  }
  return data;
}

async function listAll(config, path) {
  const items = [];
  let startCursor = "";
  for (;;) {
    const page = await autumnPost(config, path, {
      limit: 1_000,
      ...(startCursor ? { start_cursor: startCursor } : {}),
    });
    items.push(...(Array.isArray(page.list) ? page.list : []));
    if (!page.has_more) return items;
    startCursor = String(page.next_cursor || "");
    if (!startCursor) throw new Error(`${path} returned has_more without next_cursor`);
  }
}

async function resetCatalog(config) {
  const customers = await listAll(config, "customers.list");
  for (const customer of customers) {
    const customerId = String(customer.id || customer.customer_id || "").trim();
    if (!customerId) continue;
    await autumnPost(config, "customers.delete", {
      customer_id: customerId,
      delete_in_stripe: false,
    });
  }

  const plans = await listAll(config, "plans.list");
  for (const plan of plans) {
    const planId = String(plan.id || plan.plan_id || "").trim();
    if (!planId) continue;
    await autumnPost(config, "plans.delete", { plan_id: planId, all_versions: true });
  }

  const features = await listAll(config, "features.list");
  let pendingFeatures = features
    .map((feature) => String(feature.id || feature.feature_id || "").trim())
    .filter(Boolean);
  while (pendingFeatures.length > 0) {
    const retry = [];
    const failures = [];
    let deleted = 0;
    for (const id of pendingFeatures) {
      try {
        await autumnPost(config, "features.delete", { feature_id: id });
        deleted += 1;
      } catch (error) {
        retry.push(id);
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (retry.length === 0) break;
    if (deleted === 0) {
      throw new Error(
        `unable to delete ${retry.length} Autumn feature(s): ${failures.join("; ")}`,
      );
    }
    pendingFeatures = retry;
  }

  console.log(
    `clean slate removed ${customers.length} customer(s), ${plans.length} plan(s), and ${features.length} feature(s)`,
  );
}

function isMissing(error) {
  return error && (error.status === 404 || /not[ _-]?found|does not exist/i.test(error.message));
}

function featureId(spec) {
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
    const id = featureId(spec);
    const action = await upsertFeature(config, {
      feature_id: id,
      name: spec.name,
      type: "metered",
      consumable: true,
      display: { singular: spec.singular, plural: spec.plural },
    });
    console.log(`${action} feature ${id}`);
  }
}

function positiveRate(name, fallback) {
  const value = Number(envString(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function minuteRates(args) {
  const rates = {
    delivery: positiveRate("REND_AUTUMN_PRICE_DELIVERY_PER_MINUTE", DEFAULT_DELIVERY_PRICE_PER_MINUTE),
    storage: positiveRate(
      "REND_AUTUMN_PRICE_STORAGE_PER_MINUTE_MONTH",
      DEFAULT_STORAGE_PRICE_PER_MINUTE_MONTH,
    ),
  };
  if (args.muxBasicRates) console.log(`using Mux 1080p Basic baseline from ${RATE_SOURCE}`);
  return rates;
}

function usagePrice(amount) {
  return {
    amount,
    interval: "month",
    billing_units: SECONDS_PER_MINUTE,
    billing_method: "usage_based",
  };
}

function paygPlanBody(rates) {
  return {
    plan_id: envString("REND_AUTUMN_PLAN_PAYG_ID", "pay_as_you_go"),
    name: "Pay as you go",
    description: "No monthly fee. Delivery and storage are billed directly by the minute.",
    group: envString("REND_AUTUMN_PLAN_GROUP", "rend_v2"),
    items: [
      {
        feature_id: featureId(featureSpecs[0]),
        included: 0,
        reset: { interval: "month" },
        price: usagePrice(rates.delivery),
      },
      {
        feature_id: featureId(featureSpecs[1]),
        included: 0,
        reset: { interval: "month" },
        price: usagePrice(rates.storage),
      },
    ],
    config: { ignore_past_due: false },
    create_in_stripe: true,
  };
}

async function verifyCustomer(config) {
  const customerId = envString("REND_AUTUMN_VERIFY_CUSTOMER_ID");
  if (!customerId) throw new Error("REND_AUTUMN_VERIFY_CUSTOMER_ID is required for --verify-customer");
  await autumnPost(config, "customers.get_or_create", {
    customer_id: customerId,
    name: envString("REND_AUTUMN_VERIFY_CUSTOMER_NAME", "Rend billing verification"),
    email: envString("REND_AUTUMN_VERIFY_CUSTOMER_EMAIL") || undefined,
    metadata: { source: "rend-autumn-setup" },
  });
  console.log(`verified customer ${customerId}`);
}

async function verifyAttach(config) {
  const customerId = envString("REND_AUTUMN_VERIFY_CUSTOMER_ID");
  const planId = envString("REND_AUTUMN_VERIFY_PLAN_ID", envString("REND_AUTUMN_PLAN_PAYG_ID", "pay_as_you_go"));
  if (!customerId) throw new Error("REND_AUTUMN_VERIFY_CUSTOMER_ID is required for --verify-attach");
  const result = await autumnPost(config, "billing.attach", {
    customer_id: customerId,
    plan_id: planId,
    redirect_mode: "never",
    no_billing_changes: true,
    enable_plan_immediately: true,
  });
  const hasCheckoutUrl = Boolean(result.payment_url || result.checkout_url || result.url);
  console.log(`verified attach ${customerId} ${planId}${hasCheckoutUrl ? " checkout_url=true" : ""}`);
}

async function verifyPortal(config) {
  const customerId = envString("REND_AUTUMN_VERIFY_CUSTOMER_ID");
  if (!customerId) throw new Error("REND_AUTUMN_VERIFY_CUSTOMER_ID is required for --verify-portal");
  const result = await autumnPost(config, `customers/${encodeURIComponent(customerId)}/billing_portal`, {
    return_url: envString("REND_AUTUMN_VERIFY_RETURN_URL", "http://localhost:3000/dashboard/billing"),
  });
  if (!(result.url || result.portal_url || result.portalUrl)) throw new Error("billing portal URL was not returned");
  console.log(`verified portal ${customerId} portal_url=true`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = autumnConfig();
  enforceMutationSafety(config, args);
  if (args.cleanSlate) await resetCatalog(config);
  await upsertMeterFeatures(config);

  if (args.plans) {
    const body = paygPlanBody(minuteRates(args));
    console.log(`${await upsertPlan(config, body)} plan ${body.plan_id}`);
  } else if (!args.featuresOnly) {
    console.log("skipped PAYG plan; pass --plans to upsert the two direct minute rates");
  }

  if (args.verifyCustomer) await verifyCustomer(config);
  if (args.verifyAttach) await verifyAttach(config);
  if (args.verifyPortal) await verifyPortal(config);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
