import { NextResponse, type NextRequest } from "next/server";
import {
  clearDashboardAuthHintCookieHeader,
  dashboardAuthHintCookieHeader,
  hasDashboardAuthHint,
  hasDashboardSessionCookie,
  requestUsesSecureCookies,
} from "./lib/dashboard-auth-hint.ts";
import {
  WATCH_BOOTSTRAP_HEADER,
  WATCH_BOOTSTRAP_MS_HEADER,
  encodeWatchBootstrapHeader,
} from "./lib/watch-bootstrap.ts";

const GEO_HEADER_NAMES = [
  "x-vercel-id",
  "x-vercel-ip-country",
  "x-vercel-ip-country-region",
  "x-vercel-ip-continent",
  "x-vercel-ip-latitude",
  "x-vercel-ip-longitude",
];
const FORWARDED_CONTEXT_HEADER_NAMES = [
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
];

function playerAssetId(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || (parts[0] !== "watch" && parts[0] !== "embed")) return null;
  const assetId = parts[1]?.trim().toLowerCase();
  return assetId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(assetId)
    ? assetId
    : null;
}

function forwardedBootstrapHeaders(request: NextRequest) {
  const headers = new Headers({
    accept: "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
  });

  for (const name of GEO_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const name of FORWARDED_CONTEXT_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  return headers;
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 1500;

function envString(name: string) {
  return (process.env[name] || "").trim();
}

function bootstrapTimeoutMs() {
  const raw = Number(envString("REND_WATCH_BOOTSTRAP_TIMEOUT_MS"));
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 3_000);
  return DEFAULT_BOOTSTRAP_TIMEOUT_MS;
}

function internalBootstrapOrigin(request: NextRequest) {
  const configured = envString("REND_WATCH_BOOTSTRAP_ORIGIN");
  if (!configured) return request.url;

  try {
    const parsed = new URL(configured);
    if (!["http:", "https:"].includes(parsed.protocol)) return request.url;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return request.url;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return request.url;
  }
}

function setCookieHeaders(headers: Headers) {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (values?.length) return values;

  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function dashboardAuthHintSetCookie(request: NextRequest) {
  const cookieHeader = request.headers.get("cookie");
  const hasHint = hasDashboardAuthHint(cookieHeader);
  const hasSessionCookie = hasDashboardSessionCookie(cookieHeader);
  const secure = requestUsesSecureCookies(request);

  if (hasSessionCookie && !hasHint) return dashboardAuthHintCookieHeader({ secure });
  if (!hasSessionCookie && hasHint) return clearDashboardAuthHintCookieHeader({ secure });
  return null;
}

export async function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  const dashboardSetCookie = dashboardAuthHintSetCookie(request);

  const assetId = playerAssetId(request.nextUrl.pathname);
  if (!assetId) {
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    if (dashboardSetCookie) response.headers.append("set-cookie", dashboardSetCookie);
    return response;
  }

  const startedAt = Date.now();
  const bootstrapUrl = new URL(`/api/player/${encodeURIComponent(assetId)}`, internalBootstrapOrigin(request));
  const playbackBaseUrl = request.nextUrl.searchParams.get("playbackBaseUrl");
  if (playbackBaseUrl) bootstrapUrl.searchParams.set("playbackBaseUrl", playbackBaseUrl);

  const bootstrapResponse = await fetch(bootstrapUrl, {
    cache: "no-store",
    headers: forwardedBootstrapHeaders(request),
    signal: AbortSignal.timeout(bootstrapTimeoutMs()),
  }).catch(() => null);

  const responseHeaders = new Headers();
  if (dashboardSetCookie) responseHeaders.append("set-cookie", dashboardSetCookie);
  if (!bootstrapResponse) {
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
      headers: responseHeaders,
    });
    response.headers.set("cache-control", "no-store");
    return response;
  }

  for (const setCookie of setCookieHeaders(bootstrapResponse.headers)) {
    responseHeaders.append("set-cookie", setCookie);
  }

  const data = await bootstrapResponse.json().catch(() => null);
  const encoded = encodeWatchBootstrapHeader(data);
  if (encoded) {
    requestHeaders.set(WATCH_BOOTSTRAP_HEADER, encoded);
    requestHeaders.set(WATCH_BOOTSTRAP_MS_HEADER, String(Math.max(0, Date.now() - startedAt)));
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
    headers: responseHeaders,
  });
  response.headers.set("cache-control", "no-store");
  response.headers.append("server-timing", `rendwatchbootstrap;dur=${Math.max(0, Date.now() - startedAt)}`);
  return response;
}

export const config = {
  matcher: [
    "/watch/:path*",
    "/embed/:path*",
    "/((?!api|dashboard|operator|watch|embed|_next/static|_next/image|.*\\..*).*)",
  ],
};
