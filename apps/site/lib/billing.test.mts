import assert from "node:assert/strict";
import test from "node:test";
import { billingReadinessFromOverview, type BillingOverview } from "./billing.ts";

function overview(extra: Partial<BillingOverview> = {}): BillingOverview {
  return {
    mode: "autumn",
    customerId: "00000000-0000-0000-0000-000000000001",
    status: "ok",
    currentPlanLabel: "No active plan",
    subscriptions: [],
    balances: [],
    plans: [],
    manageBillingEnabled: true,
    checkoutEnabled: true,
    ...extra,
  };
}

test("billing readiness requires an active billing relationship in Autumn mode", () => {
  const readiness = billingReadinessFromOverview(overview());

  assert.equal(readiness.status, "billing_required");
  assert.equal(readiness.code, "billing_required");
});

test("billing readiness allows active subscriptions", () => {
  const readiness = billingReadinessFromOverview(
    overview({
      subscriptions: [{ planId: "pay_as_you_go", status: "active" }],
    })
  );

  assert.equal(readiness.status, "ready");
});

test("billing readiness blocks exhausted balances", () => {
  const readiness = billingReadinessFromOverview(
    overview({
      plans: [{ id: "pay_as_you_go", name: "Pay as you go", relationshipStatus: "active" }],
      balances: [{ featureId: "delivery_720p_seconds", remaining: 0 }],
    })
  );

  assert.equal(readiness.status, "plan_limit_exceeded");
  assert.equal(readiness.code, "limit_exceeded");
});

test("local billing is always ready", () => {
  const readiness = billingReadinessFromOverview(
    overview({
      mode: "local",
      currentPlanLabel: "Local development",
      subscriptions: [{ planId: "local", status: "active" }],
      manageBillingEnabled: false,
      checkoutEnabled: false,
    })
  );

  assert.equal(readiness.status, "ready");
});
