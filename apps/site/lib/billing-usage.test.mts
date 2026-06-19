import assert from "node:assert/strict";
import test from "node:test";
import {
  billingUsageFeatureInfo,
  billingUsageSourceLabel,
  isBillableUsage,
  normalizeBillingUsageRange,
} from "./billing-usage.ts";

const ENV_KEYS = [
  "REND_BILLING_FEATURE_DELIVERY_720P",
  "REND_BILLING_FEATURE_STORAGE_4K",
];

async function withEnv<T>(values: Record<string, string | undefined>, run: () => T | Promise<T>) {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);
  try {
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("billing usage range defaults to a bounded window", () => {
  assert.equal(normalizeBillingUsageRange(undefined), "30d");
  assert.equal(normalizeBillingUsageRange("invalid"), "30d");
  assert.equal(normalizeBillingUsageRange(["90d", "7d"]), "90d");
  assert.equal(normalizeBillingUsageRange("all"), "all");
});

test("billing usage classification follows configured feature ids", async () => {
  await withEnv(
    {
      REND_BILLING_FEATURE_DELIVERY_720P: "custom_delivery_720_seconds",
      REND_BILLING_FEATURE_STORAGE_4K: "custom_storage_4k_second_months",
    },
    () => {
      assert.deepEqual(billingUsageFeatureInfo("custom_delivery_720_seconds"), {
        kind: "delivery",
        label: "Delivery 720p",
        tierLabel: "720p",
        sort: 10,
      });
      assert.deepEqual(billingUsageFeatureInfo("custom_storage_4k_second_months"), {
        kind: "storage",
        label: "Storage 4K",
        tierLabel: "4K",
        sort: 140,
      });
    }
  );
});

test("billing usage only treats final aggregation rows as billable", () => {
  assert.equal(isBillableUsage("delivery_aggregation", "tracked"), true);
  assert.equal(isBillableUsage("storage_aggregation", "skipped"), true);
  assert.equal(isBillableUsage("upload_gate", "tracked"), false);
  assert.equal(isBillableUsage("delivery_aggregation", "failed"), false);
  assert.equal(billingUsageSourceLabel("upload_gate"), "Upload check");
});
