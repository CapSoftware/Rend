import assert from "node:assert/strict";
import test from "node:test";
import { canUseOperatorSurface } from "./operator.ts";
import type { DashboardAccessContext } from "./dashboard-auth.ts";

function access(extra: Partial<DashboardAccessContext> = {}): DashboardAccessContext {
  return {
    userId: "00000000-0000-0000-0000-000000000010",
    userEmail: "admin@rend.test",
    organizationId: "00000000-0000-0000-0000-000000000001",
    organizationName: "Rend Local",
    organizationSlug: "local",
    role: "owner",
    ...extra,
  };
}

test("operator surface allows local seeded admin without an allowlist", () => {
  assert.equal(canUseOperatorSurface(access(), { REND_ENV: "local" }), true);
  assert.equal(
    canUseOperatorSurface(access({ role: "member" }), { REND_ENV: "local" }),
    false
  );
});

test("operator surface requires allowlisted operators in production", () => {
  assert.equal(canUseOperatorSurface(access(), { REND_ENV: "production" }), false);
  assert.equal(
    canUseOperatorSurface(access(), {
      REND_ENV: "production",
      REND_OPERATOR_EMAIL_ALLOWLIST: "admin@rend.test",
    }),
    true
  );
  assert.equal(
    canUseOperatorSurface(access({ userEmail: "other@rend.test" }), {
      REND_ENV: "production",
      REND_OPERATOR_EMAIL_ALLOWLIST: "admin@rend.test",
    }),
    false
  );
});
