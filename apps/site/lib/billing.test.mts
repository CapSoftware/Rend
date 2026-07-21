import assert from "node:assert/strict";
import test from "node:test";
import {
  BILLING_REDIRECT_STATUS,
  BillingError,
  automaticPaygAttachBody,
  billingReadinessFromOverview,
  normalizeBillingPaymentMethod,
  paymentRedirectUrlFromAutumnResponse,
  paymentSetupBody,
  type BillingOverview,
} from "./billing.ts";

const ENV_KEYS = [
  "REND_ENV",
  "REND_ENV_PROFILE",
  "NODE_ENV",
  "REND_BILLING_MODE",
  "REND_AUTUMN_PLAN_PAYG_ID",
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
    paymentMethod: { status: "missing" },
    subscriptions: [],
    balances: [],
    manageBillingEnabled: false,
    paymentSetupEnabled: true,
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

test("billing readiness requires a payment method in Autumn mode", () => {
  const readiness = billingReadinessFromOverview(overview());

  assert.equal(readiness.status, "billing_required");
  assert.equal(readiness.code, "billing_required");
  assert.equal(readiness.actionLabel, "Add payment method");
});

test("billing readiness allows an active PAYG subscription with a card on file", () => {
  const readiness = billingReadinessFromOverview(
    overview({
      paymentMethod: { status: "on_file", brand: "visa", last4: "4242" },
      subscriptions: [{ planId: "pay_as_you_go", status: "active" }],
    })
  );

  assert.equal(readiness.status, "ready");
});

test("billing readiness asks to finish setup when the card exists but PAYG is not active", () => {
  const readiness = billingReadinessFromOverview(
    overview({
      paymentMethod: { status: "on_file", brand: "visa", last4: "4242" },
    })
  );

  assert.equal(readiness.status, "billing_required");
  assert.equal(readiness.actionLabel, "Finish billing setup");
});

test("billing readiness blocks exhausted balances", () => {
  const readiness = billingReadinessFromOverview(
    overview({
      paymentMethod: { status: "on_file" },
      subscriptions: [{ planId: "pay_as_you_go", status: "active" }],
      balances: [{ featureId: "delivery_seconds", remaining: 0 }],
    })
  );

  assert.equal(readiness.status, "plan_limit_exceeded");
  assert.equal(readiness.code, "limit_exceeded");
});

test("local billing is always ready", () => {
  const readiness = billingReadinessFromOverview(
    overview({
      mode: "local",
      paymentMethod: { status: "not_required" },
      subscriptions: [{ planId: "local", status: "active" }],
      manageBillingEnabled: false,
      paymentSetupEnabled: false,
    })
  );

  assert.equal(readiness.status, "ready");
});

test("payment setup automatically includes PAYG", async () => {
  await withEnv({ REND_AUTUMN_PLAN_PAYG_ID: undefined }, () => {
    const returnUrl = "https://rend.so/dashboard/billing";
    const body = paymentSetupBody(dashboardContext, returnUrl);

    assert.deepEqual(body, {
      customer_id: dashboardContext.organizationId,
      plan_id: "pay_as_you_go",
      success_url: returnUrl,
    });
  });
});

test("payment setup can update a card without reattaching PAYG", () => {
  const returnUrl = "https://rend.so/dashboard/billing";
  const body = paymentSetupBody(dashboardContext, returnUrl, false);

  assert.deepEqual(body, {
    customer_id: dashboardContext.organizationId,
    success_url: returnUrl,
  });
});

test("local automatic PAYG attach avoids external payment redirects by default", async () => {
  await withEnv({ REND_ENV: "local", REND_BILLING_MODE: "autumn" }, () => {
    const returnUrl = "http://127.0.0.1:3000/dashboard/billing";
    const body = automaticPaygAttachBody(dashboardContext, returnUrl);

    assert.equal(body.customer_id, dashboardContext.organizationId);
    assert.equal(body.plan_id, "pay_as_you_go");
    assert.equal(body.redirect_mode, "never");
    assert.equal(body.success_url, returnUrl);
    assert.equal(body.no_billing_changes, true);
    assert.equal(body.enable_plan_immediately, true);
    assert.deepEqual(body.checkout_session_params, { cancel_url: returnUrl });
  });
});

test("production automatic PAYG attach can redirect when payment action is required", async () => {
  await withEnv({ REND_ENV: "production", REND_BILLING_MODE: "autumn" }, () => {
    const returnUrl = "https://rend.so/dashboard/billing";
    const body = automaticPaygAttachBody(dashboardContext, returnUrl);

    assert.equal(body.redirect_mode, "if_required");
    assert.equal(body.success_url, returnUrl);
    assert.equal("no_billing_changes" in body, false);
    assert.equal("enable_plan_immediately" in body, false);
    assert.deepEqual(body.checkout_session_params, { cancel_url: returnUrl });
  });
});

test("hosted payment redirects use See Other so Stripe receives GET after form POST", () => {
  assert.equal(BILLING_REDIRECT_STATUS, 303);
});

test("payment method normalization distinguishes missing and card-on-file states", () => {
  assert.deepEqual(normalizeBillingPaymentMethod(null), { status: "missing" });
  assert.deepEqual(normalizeBillingPaymentMethod({}), { status: "missing" });
  assert.deepEqual(
    normalizeBillingPaymentMethod({
      type: "card",
      card: { display_brand: "visa", last4: "4242" },
    }),
    { status: "on_file", type: "card", brand: "visa", last4: "4242" }
  );
});

test("payment redirect guard rejects local test URLs by default", async () => {
  await withEnv({ REND_ENV: "local" }, () => {
    assert.throws(
      () =>
        paymentRedirectUrlFromAutumnResponse({
          payment_url: "https://checkout.stripe.com/c/pay/cs_test_123#fid",
        }),
      (error) => error instanceof BillingError && error.code === "billing_payment_setup_disabled"
    );
  });
});

test("payment redirect guard can opt into local test URLs", async () => {
  await withEnv({ REND_ENV: "local", REND_ALLOW_EXTERNAL_TEST_CHECKOUT_REDIRECT: "true" }, () => {
    assert.equal(
      paymentRedirectUrlFromAutumnResponse({
        payment_url: "https://checkout.stripe.com/c/pay/cs_test_123#fid",
      }),
      "https://checkout.stripe.com/c/pay/cs_test_123#fid"
    );
  });
});

test("payment redirect guard allows live URLs in production", async () => {
  await withEnv({ REND_ENV: "production" }, () => {
    assert.equal(
      paymentRedirectUrlFromAutumnResponse({
        payment_url: "https://checkout.stripe.com/c/pay/cs_live_123#fid",
      }),
      "https://checkout.stripe.com/c/pay/cs_live_123#fid"
    );
  });
});

test("payment redirect guard rejects test URLs in production", async () => {
  await withEnv({ REND_ENV: "production" }, () => {
    assert.throws(
      () =>
        paymentRedirectUrlFromAutumnResponse({
          payment_url: "https://checkout.stripe.com/c/pay/cs_test_123#fid",
        }),
      (error) => error instanceof BillingError && error.code === "billing_payment_setup_mode_mismatch"
    );
  });
});

test("payment redirect guard rejects live URLs outside production by default", async () => {
  await withEnv({ REND_ENV: "local" }, () => {
    assert.throws(
      () =>
        paymentRedirectUrlFromAutumnResponse({
          payment_url: "https://checkout.stripe.com/c/pay/cs_live_123#fid",
        }),
      (error) => error instanceof BillingError && error.code === "billing_payment_setup_disabled"
    );
  });
});

test("payment redirect guard treats a null URL as no redirect required", async () => {
  await withEnv({ REND_ENV: "production" }, () => {
    assert.equal(paymentRedirectUrlFromAutumnResponse({ payment_url: null }), null);
  });
});
