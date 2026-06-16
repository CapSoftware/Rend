export type PlaybackRequestLocation = {
  latitude?: number | string | null;
  longitude?: number | string | null;
  country?: string | null;
  countryRegion?: string | null;
  continent?: string | null;
};

export type MetalPlaybackRoute = {
  id: string;
  region: string;
  publicBaseUrl: string;
  latitude: number;
  longitude: number;
  countryCodes: readonly string[];
  continentCodes: readonly string[];
  priority: number;
};

export type MetalPlaybackRouteDecisionSource = "coordinates" | "country" | "continent" | "default";

export type MetalPlaybackRouteDecision = {
  route: MetalPlaybackRoute;
  source: MetalPlaybackRouteDecisionSource;
  distanceKm?: number;
  matchedCode?: string;
};

export const REND_DEFAULT_METAL_PLAYBACK_ROUTE_ID = "ash-1";

export const REND_METAL_PLAYBACK_ROUTES = [
  {
    id: "ash-1",
    region: "us-east",
    publicBaseUrl: "https://ash-1.play.rend.so",
    latitude: 39.0438,
    longitude: -77.4874,
    countryCodes: ["US", "CA", "MX", "BR", "AR", "CL", "CO", "PE"],
    continentCodes: ["NA", "SA", "OC"],
    priority: 10,
  },
  {
    id: "ams-1",
    region: "amsterdam",
    publicBaseUrl: "https://ams-1.play.rend.so",
    latitude: 52.3676,
    longitude: 4.9041,
    countryCodes: [
      "GB",
      "IE",
      "NL",
      "DE",
      "FR",
      "ES",
      "PT",
      "IT",
      "SE",
      "NO",
      "DK",
      "FI",
      "PL",
      "BE",
      "CH",
      "AT",
    ],
    continentCodes: ["EU", "AF", "AS"],
    priority: 20,
  },
] as const satisfies readonly MetalPlaybackRoute[];

const EARTH_RADIUS_KM = 6371;

function normalizeRouteCode(value: string | null | undefined) {
  const normalized = (value || "").trim().toUpperCase();
  return /^[A-Z0-9-]{2,16}$/.test(normalized) ? normalized : "";
}

function coordinate(value: PlaybackRequestLocation["latitude"], min: number, max: number) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

export function playbackRouteDistanceKm(
  location: { latitude: number; longitude: number },
  route: Pick<MetalPlaybackRoute, "latitude" | "longitude">
) {
  const deltaLat = toRadians(route.latitude - location.latitude);
  const deltaLon = toRadians(route.longitude - location.longitude);
  const lat1 = toRadians(location.latitude);
  const lat2 = toRadians(route.latitude);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routePriority(route: MetalPlaybackRoute) {
  return Number.isFinite(route.priority) ? route.priority : Number.MAX_SAFE_INTEGER;
}

function defaultMetalPlaybackRoute(routes: readonly MetalPlaybackRoute[]) {
  return (
    routes.find((route) => route.id === REND_DEFAULT_METAL_PLAYBACK_ROUTE_ID) ||
    routes.slice().sort((a, b) => routePriority(a) - routePriority(b) || a.id.localeCompare(b.id))[0] ||
    null
  );
}

function routeForLocationCodeDecision(
  routes: readonly MetalPlaybackRoute[],
  location: PlaybackRequestLocation
): MetalPlaybackRouteDecision | null {
  const country = normalizeRouteCode(location.country);
  const countryRegion = normalizeRouteCode(location.countryRegion);
  const continent = normalizeRouteCode(location.continent);
  const candidates = [
    { code: country && countryRegion ? `${country}-${countryRegion}` : "", source: "country" },
    { code: country, source: "country" },
    { code: continent, source: "continent" },
  ].filter((candidate) => candidate.code) as Array<{
    code: string;
    source: Extract<MetalPlaybackRouteDecisionSource, "country" | "continent">;
  }>;

  for (const candidate of candidates) {
    const route = routes
      .filter(
        (entry) =>
          entry.countryCodes.includes(candidate.code) ||
          entry.continentCodes.includes(candidate.code)
      )
      .sort((a, b) => routePriority(a) - routePriority(b) || a.id.localeCompare(b.id))[0];
    if (route) return { route, source: candidate.source, matchedCode: candidate.code };
  }

  return null;
}

export function closestMetalPlaybackRouteDecision(
  location: PlaybackRequestLocation,
  routes: readonly MetalPlaybackRoute[] = REND_METAL_PLAYBACK_ROUTES
): MetalPlaybackRouteDecision | null {
  const latitude = coordinate(location.latitude, -90, 90);
  const longitude = coordinate(location.longitude, -180, 180);
  if (latitude !== null && longitude !== null) {
    const nearest = routes
      .map((route) => ({
        route,
        distanceKm: playbackRouteDistanceKm({ latitude, longitude }, route),
      }))
      .sort(
        (a, b) =>
          a.distanceKm - b.distanceKm ||
          routePriority(a.route) - routePriority(b.route) ||
          a.route.id.localeCompare(b.route.id)
      )[0];
    return nearest
      ? { route: nearest.route, source: "coordinates" as const, distanceKm: nearest.distanceKm }
      : null;
  }

  const codeDecision = routeForLocationCodeDecision(routes, location);
  if (codeDecision) return codeDecision;

  const route = defaultMetalPlaybackRoute(routes);
  return route ? { route, source: "default" as const } : null;
}

export function closestMetalPlaybackRoute(
  location: PlaybackRequestLocation,
  routes: readonly MetalPlaybackRoute[] = REND_METAL_PLAYBACK_ROUTES
) {
  return closestMetalPlaybackRouteDecision(location, routes)?.route || null;
}
