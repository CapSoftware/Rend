export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { and, eq, isNull } from "drizzle-orm";
import { geolocation } from "@vercel/functions";
import { assets, organization } from "../../../../lib/db/schema.ts";
import {
  safePlaybackBootstrapResponse,
  type UpstreamPlaybackResponse,
} from "../../../../lib/player-bootstrap.ts";
import {
  cachedBootstrapResponse,
  cacheKeyForPlaybackBootstrap,
  rememberBootstrapResponse,
} from "../../../../lib/player-bootstrap-cache.ts";
import {
  playbackCookieFromSetCookieHeaders,
  playbackDirectCookieHeader,
  playbackProxyCookieHeader,
} from "../../../../lib/player-artifact-proxy.ts";
import {
  playbackBaseUrlDecisionForRequest,
  type PlaybackBaseUrlDecision,
} from "../../../../lib/player-edge-selection.ts";
import {
  isTrustedRendHost,
  publicRequestHost,
} from "../../../../lib/player-request-origin.ts";
import { getSiteDb } from "../../../../lib/server-db.ts";

type UpstreamAssetResponse = {
  asset_id?: unknown;
  source_state?: unknown;
  playable_state?: unknown;
};

const DEFAULT_API_BASE_URL = "http://127.0.0.1:4000";
const LOCAL_SITE_INTERNAL_TOKEN = "local-site-internal-token";

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function isProductionProfile() {
  const profile =
    envString("REND_ENV_PROFILE") ||
    envString("REND_ENV") ||
    process.env.NODE_ENV ||
    "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

function siteInternalToken() {
  const configured = envString("REND_SITE_INTERNAL_TOKEN");
  if (configured) return configured;
  return isProductionProfile() ? "" : LOCAL_SITE_INTERNAL_TOKEN;
}

function controlPlaneUrl(path: string) {
  const baseUrl = envString("REND_API_BASE_URL", DEFAULT_API_BASE_URL).replace(
    /\/+$/,
    "",
  );
  return `${baseUrl}${path}`;
}

function safeString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function safeHeaderLabel(value: string | null, maxLength = 96) {
  if (!value) return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return /^[a-zA-Z0-9._:,-]+$/.test(normalized) ? normalized : undefined;
}

function safeGeoCode(value: string | null) {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9-]{2,16}$/.test(normalized) ? normalized : undefined;
}

function validCoordinateHeader(value: string | null, min: number, max: number) {
  if (!value) return false;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

function playbackHost(playbackBaseUrl: string | null) {
  if (!playbackBaseUrl) return undefined;
  try {
    return safeHeaderLabel(new URL(playbackBaseUrl).host);
  } catch {
    return undefined;
  }
}

function logPlaybackEdgeDecision(
  request: Request,
  decision: PlaybackBaseUrlDecision,
) {
  const headers = request.headers;
  const geo = geolocation(request);
  const hasCoordinates =
    validCoordinateHeader(
      geo.latitude || headers.get("x-vercel-ip-latitude"),
      -90,
      90,
    ) &&
    validCoordinateHeader(
      geo.longitude || headers.get("x-vercel-ip-longitude"),
      -180,
      180,
    );
  const distanceKm =
    decision.distanceKm !== undefined && Number.isFinite(decision.distanceKm)
      ? Math.round(decision.distanceKm)
      : undefined;

  console.info(
    JSON.stringify({
      level: "info",
      event: "rend_player_playback_selected",
      route: "/api/player/[assetId]",
      request_id: safeHeaderLabel(headers.get("x-vercel-id"), 128),
      vercel_edge_region: safeHeaderLabel(geo.region || null, 24),
      geo_country: safeGeoCode(
        geo.country || headers.get("x-vercel-ip-country"),
      ),
      geo_country_region: safeGeoCode(
        geo.countryRegion || headers.get("x-vercel-ip-country-region"),
      ),
      geo_continent: safeGeoCode(headers.get("x-vercel-ip-continent")),
      geo_has_coordinates: hasCoordinates,
      selection_source: decision.source,
      selection_reason: safeHeaderLabel(decision.selectionReason || null, 32),
      matched_code: safeGeoCode(decision.matchedCode || null),
      metal_route_id: safeHeaderLabel(decision.routeId || null, 48),
      metal_route_region: safeHeaderLabel(decision.routeRegion || null, 48),
      playback_host: playbackHost(decision.playbackBaseUrl),
      distance_km: distanceKm,
    }),
  );
}

function normalizeCookieDomain(value: string) {
  const domain = value.trim().toLowerCase().replace(/^\.+/, "");
  if (
    !domain ||
    domain.length > 253 ||
    domain.includes("..") ||
    domain.startsWith("-") ||
    domain.endsWith("-") ||
    !/^[a-z0-9.-]+$/.test(domain)
  ) {
    return undefined;
  }
  return domain;
}

function hostMatchesCookieDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function directPlaybackCookieDomain(
  request: Request,
  playbackBaseUrl: string | null,
) {
  if (!playbackBaseUrl) return undefined;
  const requestHost = publicRequestHost(request);
  const playbackHost = new URL(playbackBaseUrl).hostname.toLowerCase();
  const configured =
    envString("REND_PLAYER_PLAYBACK_COOKIE_DOMAIN") ||
    envString("REND_PLAYBACK_COOKIE_DOMAIN");

  if (configured) {
    const domain = normalizeCookieDomain(configured);
    if (
      domain &&
      hostMatchesCookieDomain(requestHost, domain) &&
      hostMatchesCookieDomain(playbackHost, domain)
    ) {
      return domain;
    }
    return undefined;
  }

  return isTrustedRendHost(requestHost) && isTrustedRendHost(playbackHost)
    ? "rend.so"
    : undefined;
}

function canUseDirectPlaybackCookie(
  request: Request,
  playbackBaseUrl: string | null,
  cookieDomain: string | undefined,
) {
  if (!playbackBaseUrl) return false;
  if (cookieDomain) return true;

  const requestHost = publicRequestHost(request);
  const playbackHost = new URL(playbackBaseUrl).hostname.toLowerCase();
  return requestHost === playbackHost;
}

function setPlaybackCookieHeader(
  headers: Headers,
  request: Request,
  assetId: string,
  playbackToken: unknown,
  ttlSeconds: unknown,
  playbackBaseUrl: string | null,
  directPlaybackEnabled: boolean,
  directCookieDomain: string | undefined,
  playbackCredentialMode: "include" | "omit",
) {
  if (playbackCredentialMode === "omit") return;
  const playbackCookie =
    directPlaybackEnabled && playbackBaseUrl
      ? playbackDirectCookieHeader(
          request.url,
          assetId,
          playbackToken,
          ttlSeconds,
          playbackBaseUrl,
          directCookieDomain,
        )
      : playbackProxyCookieHeader(
          request.url,
          assetId,
          playbackToken,
          ttlSeconds,
        );
  if (playbackCookie) headers.append("set-cookie", playbackCookie);
}

function normalizeAssetId(value: string) {
  const assetId = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    assetId,
  )
    ? assetId
    : null;
}

async function assetOrganizationId(assetId: string) {
  const [row] = await getSiteDb()
    .select({ organizationId: assets.organization_id })
    .from(assets)
    .innerJoin(organization, eq(organization.id, assets.organization_id))
    .where(
      and(
        eq(assets.id, assetId),
        isNull(assets.deleted_at),
        isNull(assets.suspended_at),
        isNull(organization.suspended_at),
      ),
    )
    .limit(1);
  return row?.organizationId ?? null;
}

async function fetchControlPlane(
  path: string,
  organizationId: string,
  internalToken: string,
) {
  return fetch(controlPlaneUrl(path), {
    cache: "no-store",
    headers: {
      "x-rend-site-token": internalToken,
      "x-rend-organization-id": organizationId,
      accept: "application/json",
    },
  });
}

async function notPlayableOrUnavailable(
  assetId: string,
  organizationId: string,
  internalToken: string,
) {
  const assetResponse = await fetchControlPlane(
    `/v1/assets/${encodeURIComponent(assetId)}`,
    organizationId,
    internalToken,
  ).catch(() => null);

  if (!assetResponse?.ok) {
    return jsonResponse(
      {
        status: "unavailable",
        asset_id: assetId,
        message: "Asset is unavailable",
      },
      { status: 404 },
    );
  }

  const asset = (await assetResponse
    .json()
    .catch(() => ({}))) as UpstreamAssetResponse;
  return jsonResponse(
    {
      status: "not_playable",
      asset_id: safeString(asset.asset_id) ?? assetId,
      source_state: safeString(asset.source_state),
      playable_state: safeString(asset.playable_state),
      message: "Asset is not playable yet",
    },
    { status: 409 },
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await context.params;
  const normalizedAssetId = normalizeAssetId(assetId || "");
  if (!normalizedAssetId) {
    return jsonResponse(
      {
        status: "unavailable",
        asset_id: assetId || "",
        message: "Asset is unavailable",
      },
      { status: 404 },
    );
  }

  const internalToken = siteInternalToken();
  if (!internalToken) {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback is not configured",
      },
      { status: 500 },
    );
  }

  let playbackDecision: PlaybackBaseUrlDecision;
  try {
    playbackDecision = playbackBaseUrlDecisionForRequest(request);
  } catch {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback edge is not configured",
      },
      { status: 400 },
    );
  }
  const playbackBaseUrl = playbackDecision.playbackBaseUrl;
  logPlaybackEdgeDecision(request, playbackDecision);
  const publicPlaybackEnabled = playbackDecision.credentialMode === "omit";
  const directCookieDomain = directPlaybackCookieDomain(
    request,
    playbackBaseUrl,
  );
  const directCookieEnabled = canUseDirectPlaybackCookie(
    request,
    playbackBaseUrl,
    directCookieDomain,
  );
  const directPlaybackEnabled =
    Boolean(playbackBaseUrl) && (publicPlaybackEnabled || directCookieEnabled);
  const cacheKey = cacheKeyForPlaybackBootstrap(
    normalizedAssetId,
    playbackBaseUrl,
    directPlaybackEnabled,
    directCookieDomain,
    request,
  );
  const cached = cachedBootstrapResponse(cacheKey);
  if (cached) {
    const headers = new Headers();
    setPlaybackCookieHeader(
      headers,
      request,
      normalizedAssetId,
      cached.playbackToken,
      cached.safeResponse.ttl_seconds,
      cached.playbackBaseUrl,
      cached.directPlaybackEnabled,
      cached.directCookieDomain,
      cached.safeResponse.playback_credential_mode ?? "include",
    );
    return jsonResponse(cached.safeResponse, { headers });
  }

  const organizationId = await assetOrganizationId(normalizedAssetId).catch(
    () => null,
  );
  if (!organizationId) {
    return jsonResponse(
      {
        status: "unavailable",
        asset_id: normalizedAssetId,
        message: "Asset is unavailable",
      },
      { status: 404 },
    );
  }

  const upstream = await fetchControlPlane(
    `/v1/assets/${encodeURIComponent(normalizedAssetId)}/playback`,
    organizationId,
    internalToken,
  ).catch(() => null);

  if (!upstream) {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback bootstrap failed",
      },
      { status: 502 },
    );
  }

  if (upstream.status === 404) {
    return notPlayableOrUnavailable(
      normalizedAssetId,
      organizationId,
      internalToken,
    );
  }

  if (!upstream.ok) {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback bootstrap failed",
      },
      { status: 502 },
    );
  }

  const data = (await upstream
    .json()
    .catch(() => null)) as UpstreamPlaybackResponse | null;
  const responsePlaybackBaseUrl = directPlaybackEnabled
    ? playbackBaseUrl
    : null;
  const safeResponse = data
    ? safePlaybackBootstrapResponse(
        normalizedAssetId,
        data,
        responsePlaybackBaseUrl,
        organizationId,
        publicPlaybackEnabled ? "omit" : "include",
      )
    : null;

  if (!safeResponse) {
    return jsonResponse(
      {
        status: "error",
        asset_id: normalizedAssetId,
        message: "Playback bootstrap failed",
      },
      { status: 502 },
    );
  }

  const headers = new Headers();
  const upstreamPlaybackCookie = playbackCookieFromSetCookieHeaders(
    upstream.headers,
  );
  const playbackToken = upstreamPlaybackCookie ?? data?.playback_token;
  setPlaybackCookieHeader(
    headers,
    request,
    normalizedAssetId,
    playbackToken,
    safeResponse.ttl_seconds,
    playbackBaseUrl,
    directPlaybackEnabled,
    directCookieDomain,
    safeResponse.playback_credential_mode ?? "include",
  );
  if (typeof playbackToken === "string") {
    rememberBootstrapResponse(cacheKey, {
      assetId: normalizedAssetId,
      cachedAtMs: Date.now(),
      directCookieDomain,
      directPlaybackEnabled,
      organizationId,
      playbackBaseUrl,
      playbackToken,
      requestOrigin: new URL(request.url).origin.toLowerCase(),
      safeResponse,
      upstreamResponse: data ?? undefined,
    });
  }

  return jsonResponse(safeResponse, { headers });
}
