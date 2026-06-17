import { NextResponse, type NextRequest } from "next/server";
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

function watchAssetId(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "watch") return null;
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

  return headers;
}

function setCookieHeaders(headers: Headers) {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (values?.length) return values;

  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

export async function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);

  const assetId = watchAssetId(request.nextUrl.pathname);
  if (!assetId) {
    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
  }

  const startedAt = Date.now();
  const bootstrapUrl = new URL(`/api/player/${encodeURIComponent(assetId)}`, internalBootstrapOrigin(request));
  const playbackBaseUrl = request.nextUrl.searchParams.get("playbackBaseUrl");
  if (playbackBaseUrl) bootstrapUrl.searchParams.set("playbackBaseUrl", playbackBaseUrl);

  const bootstrapResponse = await fetch(bootstrapUrl, {
    cache: "no-store",
    headers: forwardedBootstrapHeaders(request),
  }).catch(() => null);

  const responseHeaders = new Headers();
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
  matcher: ["/watch/:path*"],
};
