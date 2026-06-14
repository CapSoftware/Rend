import {
  DASHBOARD_SESSION_COOKIE,
  createDashboardSessionCookieValue,
  dashboardAuthConfigured,
  dashboardSessionCookieAttributes,
  expiredDashboardSessionCookieAttributes,
  operatorTokenMatches,
} from "../../../lib/dashboard-auth.ts";
import { assetErrorResponse, assetJsonResponse } from "../../../lib/asset-api.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readBoundedJson(request: Request) {
  const text = await request.text();
  if (text.length > 4096) return { ok: false as const, status: 413, message: "Request body is too large" };
  try {
    return { ok: true as const, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false as const, status: 400, message: "Request body must be JSON" };
  }
}

export async function POST(request: Request) {
  if (!dashboardAuthConfigured()) {
    return assetErrorResponse(503, "dashboard_auth_not_configured", "Dashboard authentication is not configured");
  }

  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return assetErrorResponse(parsed.status, "invalid_login_request", parsed.message);

  const token = isRecord(parsed.value) && typeof parsed.value.token === "string" ? parsed.value.token : "";
  if (!operatorTokenMatches(token)) {
    return assetErrorResponse(401, "unauthorized", "Authentication failed");
  }

  const headers = new Headers();
  headers.set(
    "set-cookie",
    `${DASHBOARD_SESSION_COOKIE}=${createDashboardSessionCookieValue()}; ${dashboardSessionCookieAttributes()}`
  );
  return assetJsonResponse({ status: "ok" }, { headers });
}

export async function DELETE() {
  const headers = new Headers();
  headers.set("set-cookie", `${DASHBOARD_SESSION_COOKIE}=; ${expiredDashboardSessionCookieAttributes()}`);
  return assetJsonResponse({ status: "ok" }, { headers });
}
