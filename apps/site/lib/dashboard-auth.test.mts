import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_SESSION_COOKIE,
  createDashboardSessionCookieValue,
  dashboardAccessFromCookieValue,
  dashboardAccessFromRequest,
  dashboardAuthConfigured,
  operatorTokenMatches,
} from "./dashboard-auth.ts";

const AUTH_ENV = {
  REND_SITE_OPERATOR_TOKEN: "operator-token",
  REND_SITE_AUTH_SECRET: "auth-secret",
};

test("dashboard auth requires an operator token", () => {
  assert.equal(dashboardAuthConfigured({}), false);
  assert.equal(dashboardAuthConfigured(AUTH_ENV), true);
  assert.equal(operatorTokenMatches("operator-token", AUTH_ENV), true);
  assert.equal(operatorTokenMatches("wrong-token", AUTH_ENV), false);
});

test("dashboard session cookies are signed and expire", () => {
  const now = Date.now();
  const cookie = createDashboardSessionCookieValue(now, AUTH_ENV);

  assert.deepEqual(dashboardAccessFromCookieValue(cookie, now + 1000, AUTH_ENV), { ok: true });
  assert.deepEqual(dashboardAccessFromCookieValue(`${cookie}x`, now + 1000, AUTH_ENV), {
    ok: false,
    reason: "unauthorized",
  });
  assert.deepEqual(dashboardAccessFromCookieValue(cookie, now + 8 * 24 * 60 * 60 * 1000, AUTH_ENV), {
    ok: false,
    reason: "expired",
  });
});

test("dashboard request auth accepts signed cookie or bearer token", () => {
  const cookie = createDashboardSessionCookieValue(Date.now(), AUTH_ENV);
  assert.deepEqual(
    dashboardAccessFromRequest(
      new Request("https://rend.example/api/assets", {
        headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=${cookie}` },
      }),
      AUTH_ENV
    ),
    { ok: true }
  );

  assert.deepEqual(
    dashboardAccessFromRequest(
      new Request("https://rend.example/api/assets", {
        headers: { authorization: "Bearer operator-token" },
      }),
      AUTH_ENV
    ),
    { ok: true }
  );

  assert.deepEqual(
    dashboardAccessFromRequest(new Request("https://rend.example/api/assets"), AUTH_ENV),
    { ok: false, reason: "unauthorized" }
  );
});
