import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_AUTH_HINT_COOKIE,
  clearDashboardAuthHintCookieHeader,
  dashboardAuthHintCookieHeader,
  hasDashboardAuthHint,
  hasDashboardSessionCookie,
  requestUsesSecureCookies,
} from "./dashboard-auth-hint.ts";

test("dashboard auth hint is detected from a cookie header", () => {
  assert.equal(hasDashboardAuthHint(`${DASHBOARD_AUTH_HINT_COOKIE}=1`), true);
  assert.equal(hasDashboardAuthHint(`theme=light; ${DASHBOARD_AUTH_HINT_COOKIE}=1; other=value`), true);
  assert.equal(hasDashboardAuthHint(`${DASHBOARD_AUTH_HINT_COOKIE}=0`), false);
  assert.equal(hasDashboardAuthHint("theme=light"), false);
  assert.equal(hasDashboardAuthHint(""), false);
});

test("dashboard auth hint set cookie is client-readable and path scoped", () => {
  const cookie = dashboardAuthHintCookieHeader();
  assert.match(cookie, new RegExp(`^${DASHBOARD_AUTH_HINT_COOKIE}=1;`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=604800/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /HttpOnly/);
});

test("dashboard session cookie detection supports Better Auth local and secure names", () => {
  assert.equal(hasDashboardSessionCookie("rend_auth.session_token=signed-token"), true);
  assert.equal(hasDashboardSessionCookie("__Secure-rend_auth.session_token=signed-token"), true);
  assert.equal(hasDashboardSessionCookie("rend_auth-session_token=signed-token"), true);
  assert.equal(hasDashboardSessionCookie("__Secure-rend_auth-session_token=signed-token"), true);
  assert.equal(hasDashboardSessionCookie("rend_auth.session_data=cached-session"), false);
  assert.equal(hasDashboardSessionCookie("rend_auth.session_token="), false);
});

test("dashboard auth hint clear cookie expires the hint", () => {
  const cookie = clearDashboardAuthHintCookieHeader({ secure: true });
  assert.match(cookie, new RegExp(`^${DASHBOARD_AUTH_HINT_COOKIE}=;`));
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /Secure/);
});

test("dashboard auth hint secure mode follows forwarded protocol or request url", () => {
  assert.equal(
    requestUsesSecureCookies(new Request("http://internal.test", { headers: { "x-forwarded-proto": "https" } })),
    true
  );
  assert.equal(requestUsesSecureCookies(new Request("https://rend.so")), true);
  assert.equal(requestUsesSecureCookies(new Request("http://localhost:3000")), false);
});
