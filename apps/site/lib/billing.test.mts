import assert from "node:assert/strict";
import test from "node:test";
import {
  BillingError,
  billingReadinessFromOverview,
  checkoutAttachBody,
  checkoutRedirectUrlFromAutumnResponse,
  type BillingOverview,
} from "./billing.ts";

const ENV_KEYS = [
  "REND_ENV",
  "REND_ENV_PROFILE",
  "NODE_ENV",
  "REND_BILLING_MODE",
  "REND_ALLOW_EXTERNAL_TEST_CHECKOUT_REDIRECT",
  "REND_ALLOW_LIVE_CHECKOUT_REDIRECT",
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

const dashboardContext = {
  userId: "00000000-0000-0000-0000-000000000010",
  userEmail: "admin@rend.test",
  organizationId: "00000000-0000-0000-0000-000000000001",
  organizationName: "Rend Local",
  organizationSlug: "local",
  role: "owner" as const,
};

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

test("local Autumn attach activates plans without external Checkout by default", async () => {
  await withEnv({ REND_ENV: "local", REND_BILLING_MODE: "autumn" }, () => {
    const returnUrl = "http://127.0.0.1:3000/dashboard/billing";
    const body = checkoutAttachBody(dashboardContext, "builder", returnUrl);

    assert.equal(body.customer_id, dashboardContext.organizationId);
    assert.equal(body.plan_id, "builder");
    assert.equal(body.redirect_mode, "never");
    assert.equal(body.no_billing_changes, true);
    assert.equal(body.enable_plan_immediately, true);
    assert.deepEqual(body.checkout_session_params, { cancel_url: returnUrl });
  });
});

test("production Autumn attach can redirect when Checkout is required", async () => {
  await withEnv({ REND_ENV: "production", REND_BILLING_MODE: "autumn" }, () => {
    const returnUrl = "https://rend.so/dashboard/billing";
    const body = checkoutAttachBody(dashboardContext, "builder", returnUrl);

    assert.equal(body.redirect_mode, "if_required");
    assert.equal("no_billing_changes" in body, false);
    assert.equal("enable_plan_immediately" in body, false);
    assert.deepEqual(body.checkout_session_params, { cancel_url: returnUrl });
  });
});

test("checkout redirect guard rejects local test checkout URLs by default", async () => {
  await withEnv({ REND_ENV: "local" }, () => {
    assert.throws(
      () =>
        checkoutRedirectUrlFromAutumnResponse({
          payment_url: "https://checkout.stripe.com/c/pay/cs_test_123#fid",
        }),
      (error) => error instanceof BillingError && error.code === "billing_checkout_disabled"
    );
  });
});

test("checkout redirect guard can opt into local test checkout URLs", async () => {
  await withEnv({ REND_ENV: "local", REND_ALLOW_EXTERNAL_TEST_CHECKOUT_REDIRECT: "true" }, () => {
    assert.equal(
      checkoutRedirectUrlFromAutumnResponse({
        payment_url: "https://checkout.stripe.com/c/pay/cs_test_123#fid",
      }),
      "https://checkout.stripe.com/c/pay/cs_test_123#fid"
    );
  });
});

test("checkout redirect guard rejects test checkout URLs in production", async () => {
  await withEnv({ REND_ENV: "production" }, () => {
    assert.throws(
      () =>
        checkoutRedirectUrlFromAutumnResponse({
          payment_url: "https://checkout.stripe.com/c/pay/cs_test_123#fid",
        }),
      (error) => error instanceof BillingError && error.code === "billing_checkout_mode_mismatch"
    );
  });
});

test("checkout redirect guard rejects live checkout URLs outside production by default", async () => {
  await withEnv({ REND_ENV: "local" }, () => {
    assert.throws(
      () =>
        checkoutRedirectUrlFromAutumnResponse({
          payment_url: "https://checkout.stripe.com/c/pay/cs_live_123#fid",
        }),
      (error) => error instanceof BillingError && error.code === "billing_checkout_disabled"
    );
  });
});

test("checkout redirect guard treats null payment URL as no redirect required", async () => {
  await withEnv({ REND_ENV: "production" }, () => {
    assert.equal(checkoutRedirectUrlFromAutumnResponse({ payment_url: null }), null);
  });
});
