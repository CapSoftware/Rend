import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DELIVERY_PRICE_PER_MINUTE,
  DEFAULT_STORAGE_PRICE_PER_MINUTE_MONTH,
  formatUsd,
  pricingFromPlan,
} from "./pricing.ts";

test("PAYG pricing converts Autumn second units into minute rates", () => {
  const pricing = pricingFromPlan({
    id: "pay_as_you_go",
    name: "Pay as you go",
    items: [
      {
        feature_id: "delivery_seconds",
        price: { amount: 0.001, billing_units: 60, billing_method: "usage_based", interval: "month" },
      },
      {
        feature_id: "storage_second_months",
        price: { amount: 0.003, billing_units: 60, billing_method: "usage_based", interval: "month" },
      },
    ],
  });

  assert.equal(pricing?.deliveryPerMinute, DEFAULT_DELIVERY_PRICE_PER_MINUTE);
  assert.equal(pricing?.storagePerMinuteMonth, DEFAULT_STORAGE_PRICE_PER_MINUTE_MONTH);
  assert.equal(pricing?.plan.name, "Pay as you go");
});

test("pricing rejects plans missing either public meter", () => {
  assert.equal(
    pricingFromPlan({
      items: [{ feature_id: "delivery_seconds", price: { amount: 0.001, billing_units: 60 } }],
    }),
    null,
  );
});

test("pricing accepts a wrapped Autumn plan response", () => {
  const pricing = pricingFromPlan({
    data: {
      plan: {
        id: "pay_as_you_go",
        items: [
          {
            feature_id: "delivery_seconds",
            price: { amount: 0.001, billing_units: 60 },
          },
          {
            feature_id: "storage_second_months",
            price: { amount: 0.003, billing_units: 60 },
          },
        ],
      },
    },
  });

  assert.equal(pricing?.deliveryPerMinute, DEFAULT_DELIVERY_PRICE_PER_MINUTE);
  assert.equal(pricing?.storagePerMinuteMonth, DEFAULT_STORAGE_PRICE_PER_MINUTE_MONTH);
});

test("small minute prices stay readable", () => {
  assert.equal(formatUsd(0.001), "$0.001");
  assert.equal(formatUsd(0.003), "$0.003");
});
