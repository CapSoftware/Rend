export const DASHBOARD_AUTH_HINT_COOKIE = "rend_dashboard_signed_in";
export const DASHBOARD_AUTH_HINT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const DASHBOARD_HOME_HREF = "/dashboard/assets";
export const DASHBOARD_START_HREF = "/login?next=%2Fdashboard%2Fassets";

const DASHBOARD_AUTH_HINT_VALUE = "1";
const DASHBOARD_SESSION_COOKIE_NAMES = [
  "rend_auth.session_token",
  "__Secure-rend_auth.session_token",
  "rend_auth-session_token",
  "__Secure-rend_auth-session_token",
];

function cookieValue(header: string, name: string) {
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return "";
}

export function hasDashboardAuthHint(cookieHeader: string | null | undefined) {
  if (!cookieHeader) return false;
  return cookieValue(cookieHeader, DASHBOARD_AUTH_HINT_COOKIE) === DASHBOARD_AUTH_HINT_VALUE;
}

export function hasDashboardSessionCookie(cookieHeader: string | null | undefined) {
  if (!cookieHeader) return false;
  return DASHBOARD_SESSION_COOKIE_NAMES.some((name) => Boolean(cookieValue(cookieHeader, name)));
}

function cookieSecureAttribute(secure: boolean | undefined) {
  return secure ? ["Secure"] : [];
}

export function dashboardAuthHintCookieHeader({ secure = false } = {}) {
  return [
    `${DASHBOARD_AUTH_HINT_COOKIE}=${DASHBOARD_AUTH_HINT_VALUE}`,
    "Path=/",
    `Max-Age=${DASHBOARD_AUTH_HINT_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...cookieSecureAttribute(secure),
  ].join("; ");
}

export function clearDashboardAuthHintCookieHeader({ secure = false } = {}) {
  return [
    `${DASHBOARD_AUTH_HINT_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
    ...cookieSecureAttribute(secure),
  ].join("; ");
}

export function requestUsesSecureCookies(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto === "https") return true;
  return new URL(request.url).protocol === "https:";
}
