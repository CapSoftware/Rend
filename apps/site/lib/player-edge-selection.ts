import { geolocation } from "@vercel/functions";
import {
  closestMetalPlaybackRouteDecision,
  type PlaybackRequestLocation,
} from "@rend/playback-routing";

type EnvLike = Record<string, string | undefined>;

function envString(env: EnvLike, name: string, fallback = "") {
  return (env[name] || fallback).trim();
}

export function normalizePlaybackBaseUrl(value: string) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("playback base URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "playback base URL must not include credentials, query, or fragment",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function allowedPlaybackBaseUrls(env: EnvLike) {
  return envString(env, "REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizePlaybackBaseUrl);
}

function selectorKey(value: string | null) {
  const key = (value || "").trim().toUpperCase();
  if (key === "DEFAULT") return key;
  return /^[A-Z0-9-]{2,16}$/.test(key) ? key : "";
}

function headerSelectorKey(headers: Headers, name: string) {
  return selectorKey(headers.get(name));
}

function edgeBaseMap(value: string) {
  const map = new Map<string, string>();
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = selectorKey(entry.slice(0, separator));
    const rawUrl = entry.slice(separator + 1).trim();
    if (!key || !rawUrl) continue;
    map.set(key, normalizePlaybackBaseUrl(rawUrl));
  }
  return map;
}

export function selectedConfiguredEdgePlaybackBaseUrl(
  headers: Headers,
  env: EnvLike = process.env,
) {
  const configured = envString(env, "REND_PLAYER_EDGE_BASE_URLS");
  if (!configured) return null;

  const edges = edgeBaseMap(configured);
  if (!edges.size) return null;

  const country = headerSelectorKey(headers, "x-vercel-ip-country");
  const countryRegion = headerSelectorKey(
    headers,
    "x-vercel-ip-country-region",
  );
  const continent = headerSelectorKey(headers, "x-vercel-ip-continent");
  const candidates = [
    country && countryRegion ? `${country}-${countryRegion}` : "",
    country,
    continent,
    "DEFAULT",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const edge = edges.get(candidate);
    if (edge) return edge;
  }

  return null;
}

function requestLocationFromHeaders(headers: Headers): PlaybackRequestLocation {
  return {
    latitude: headers.get("x-vercel-ip-latitude"),
    longitude: headers.get("x-vercel-ip-longitude"),
    country: headers.get("x-vercel-ip-country"),
    countryRegion: headers.get("x-vercel-ip-country-region"),
    continent: headers.get("x-vercel-ip-continent"),
  };
}

function requestLocation(request: Request): PlaybackRequestLocation {
  const geo = geolocation(request);
  return {
    latitude: geo.latitude || request.headers.get("x-vercel-ip-latitude"),
    longitude: geo.longitude || request.headers.get("x-vercel-ip-longitude"),
    country: geo.country || request.headers.get("x-vercel-ip-country"),
    countryRegion:
      geo.countryRegion || request.headers.get("x-vercel-ip-country-region"),
    continent: request.headers.get("x-vercel-ip-continent"),
  };
}

export function selectedEdgePlaybackBaseUrl(headers: Headers) {
  return selectedMetalPlaybackRouteDecision(headers)?.playbackBaseUrl || null;
}

export function selectedMetalPlaybackRouteDecision(headers: Headers) {
  return selectedMetalPlaybackRouteDecisionFromLocation(
    requestLocationFromHeaders(headers),
  );
}

export function selectedMetalPlaybackRouteDecisionFromLocation(
  location: PlaybackRequestLocation,
) {
  const decision = closestMetalPlaybackRouteDecision(location);
  if (!decision) return null;
  return {
    playbackBaseUrl: decision.route.publicBaseUrl,
    routeId: decision.route.id,
    routeRegion: decision.route.region,
    selectionReason: decision.source,
    matchedCode: decision.matchedCode,
    distanceKm: decision.distanceKm,
  };
}

function envUsesConfiguredEdgeOverride(env: EnvLike) {
  const mode = envString(env, "REND_PLAYER_EDGE_BASE_URLS_MODE").toLowerCase();
  const profile = envString(env, "REND_ENV_PROFILE").toLowerCase();
  return mode === "override" || (profile && profile !== "production");
}

function playbackMode(env: EnvLike) {
  const mode = envString(env, "REND_PLAYBACK_MODE", "tigris").toLowerCase();
  return mode === "edge" ? "edge" : "tigris";
}

function envEnabled(env: EnvLike, name: string, fallback = true) {
  const value = envString(env, name).toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

function isProductionLike(env: EnvLike) {
  const profile = (
    envString(env, "REND_ENV_PROFILE") ||
    envString(env, "REND_ENV") ||
    envString(env, "NODE_ENV")
  ).toLowerCase();
  return profile === "production" || profile === "prod";
}

function tigrisPlaybackBaseUrlForRequest(request: Request, env: EnvLike) {
  const configured =
    envString(env, "REND_TIGRIS_PLAYBACK_BASE_URL") ||
    envString(env, "REND_PUBLIC_API_BASE_URL") ||
    envString(env, "REND_API_BASE_URL");
  if (configured) return normalizePlaybackBaseUrl(configured);

  const host = new URL(request.url).hostname.toLowerCase();
  if (host === "rend.so" || host === "www.rend.so" || isProductionLike(env)) {
    return "https://api.rend.so";
  }

  return "http://127.0.0.1:4000";
}

export type PlaybackBaseUrlDecision = {
  playbackBaseUrl: string | null;
  source:
    | "manual_override"
    | "tigris_direct"
    | "tigris_origin_proxy"
    | "configured_edge"
    | "shared_metal"
    | "configured_edge_fallback"
    | "configured_fallback"
    | "none";
  routeId?: string;
  routeRegion?: string;
  selectionReason?: string;
  matchedCode?: string;
  distanceKm?: number;
};

export function playbackBaseUrlDecisionForRequest(
  request: Request,
  env: EnvLike = process.env,
): PlaybackBaseUrlDecision {
  const requestUrl = new URL(request.url);
  const requested = requestUrl.searchParams.get("playbackBaseUrl");
  if (requested) {
    const normalized = normalizePlaybackBaseUrl(requested);
    if (!allowedPlaybackBaseUrls(env).includes(normalized)) {
      throw new Error("playbackBaseUrl is not allowed");
    }
    return { playbackBaseUrl: normalized, source: "manual_override" };
  }

  const configuredEdge = selectedConfiguredEdgePlaybackBaseUrl(
    request.headers,
    env,
  );
  if (playbackMode(env) !== "edge") {
    if (!envEnabled(env, "REND_PLAYER_TIGRIS_DIRECT", true)) {
      return { playbackBaseUrl: null, source: "tigris_origin_proxy" };
    }
    return {
      playbackBaseUrl: tigrisPlaybackBaseUrlForRequest(request, env),
      source: "tigris_direct",
    };
  }

  if (configuredEdge && envUsesConfiguredEdgeOverride(env)) {
    return { playbackBaseUrl: configuredEdge, source: "configured_edge" };
  }

  const selectedEdge = selectedMetalPlaybackRouteDecisionFromLocation(
    requestLocation(request),
  );
  if (selectedEdge) {
    return {
      playbackBaseUrl: normalizePlaybackBaseUrl(selectedEdge.playbackBaseUrl),
      source: "shared_metal",
      routeId: selectedEdge.routeId,
      routeRegion: selectedEdge.routeRegion,
      selectionReason: selectedEdge.selectionReason,
      matchedCode: selectedEdge.matchedCode,
      distanceKm: selectedEdge.distanceKm,
    };
  }

  if (configuredEdge)
    return {
      playbackBaseUrl: configuredEdge,
      source: "configured_edge_fallback",
    };

  const configured = envString(env, "REND_PLAYER_PLAYBACK_BASE_URL");
  return configured
    ? {
        playbackBaseUrl: normalizePlaybackBaseUrl(configured),
        source: "configured_fallback",
      }
    : { playbackBaseUrl: null, source: "none" };
}

export function playbackBaseUrlForRequest(
  request: Request,
  env: EnvLike = process.env,
) {
  return playbackBaseUrlDecisionForRequest(request, env).playbackBaseUrl;
}
