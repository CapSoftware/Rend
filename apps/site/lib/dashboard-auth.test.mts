import assert from "node:assert/strict";
import test from "node:test";
import {
  canDeleteAssets,
  canManageApiKeys,
  canUploadAssets,
  dashboardAuthConfigured,
  type DashboardAccessContext,
} from "./dashboard-auth.ts";

function access(
  role: DashboardAccessContext["role"],
  extra: Partial<DashboardAccessContext> = {}
): DashboardAccessContext {
  return {
    userId: "00000000-0000-0000-0000-000000000010",
    userEmail: "admin@rend.test",
    organizationId: "00000000-0000-0000-0000-000000000001",
    organizationName: "Rend Local",
    organizationSlug: "local",
    role,
    ...extra,
  };
}

test("dashboard auth is configured by default in local profile", () => {
  assert.equal(dashboardAuthConfigured({ REND_ENV: "local" }), true);
});

test("dashboard auth requires secure Better Auth and email config in production", () => {
  assert.equal(dashboardAuthConfigured({ REND_ENV: "production" }), false);
  assert.equal(
    dashboardAuthConfigured({
      REND_ENV: "production",
      BETTER_AUTH_SECRET: "local-better-auth-secret-only-for-rend-development",
      BETTER_AUTH_URL: "http://localhost:3000",
      RESEND_API_KEY: "resend",
      REND_AUTH_EMAIL_FROM: "Rend <auth@example.com>",
    }),
    false
  );
  assert.equal(
    dashboardAuthConfigured({
      REND_ENV: "production",
      BETTER_AUTH_SECRET: "prod-secret-with-at-least-some-length",
      BETTER_AUTH_URL: "https://app.example.com",
      RESEND_API_KEY: "resend",
      REND_AUTH_EMAIL_FROM: "Rend <auth@example.com>",
    }),
    true
  );
});

test("production auth can explicitly disable outbound auth email", () => {
  assert.equal(
    dashboardAuthConfigured({
      REND_ENV: "production",
      BETTER_AUTH_SECRET: "prod-secret-with-at-least-some-length",
      BETTER_AUTH_URL: "https://app.example.com",
      REND_AUTH_EMAIL_DISABLED: "true",
    }),
    true
  );
});

test("dashboard roles gate mutating actions", () => {
  for (const role of ["owner", "admin"] as const) {
    assert.equal(canManageApiKeys(access(role)), true);
    assert.equal(canDeleteAssets(access(role)), true);
    assert.equal(canUploadAssets(access(role)), true);
  }

  assert.equal(canManageApiKeys(access("member")), false);
  assert.equal(canDeleteAssets(access("member")), false);
  assert.equal(canUploadAssets(access("member")), false);
});

test("suspended organizations are read-only in the dashboard", () => {
  const suspended = access("owner", {
    organizationSuspendedAt: "2026-06-14T10:00:00.000Z",
    organizationSuspensionReason: "abuse report",
  });

  assert.equal(canManageApiKeys(suspended), false);
  assert.equal(canDeleteAssets(suspended), false);
  assert.equal(canUploadAssets(suspended), false);
});
