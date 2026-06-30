import assert from "node:assert/strict";
import test from "node:test";
import {
  playbackBaseUrlDecisionForRequest,
  playbackBaseUrlForRequest,
  selectedConfiguredEdgePlaybackBaseUrl,
  selectedEdgePlaybackBaseUrl,
  selectedMetalPlaybackRouteDecision,
} from "./player-edge-selection.ts";

const EDGE_ENV = {
  REND_PLAYER_EDGE_BASE_URLS:
    "DEFAULT=https://ash-1.play.rend.so,NA=https://ash-1.play.rend.so,EU=https://ams-1.play.rend.so,US-CA=https://lax-1.play.rend.so",
};

function headers(values: Record<string, string>) {
  return new Headers(values);
}

test("edge selection selects the closest code-owned metal route from request coordinates", () => {
  const selected = selectedEdgePlaybackBaseUrl(
    headers({
      "x-vercel-ip-latitude": "51.5072",
      "x-vercel-ip-longitude": "-0.1276",
      "x-vercel-ip-continent": "EU",
    }),
  );

  assert.equal(selected, "https://ams-1.play.rend.so");
  assert.deepEqual(
    {
      routeId: selectedMetalPlaybackRouteDecision(
        headers({
          "x-vercel-ip-latitude": "51.5072",
          "x-vercel-ip-longitude": "-0.1276",
          "x-vercel-ip-continent": "EU",
        }),
      )?.routeId,
      selectionReason: selectedMetalPlaybackRouteDecision(
        headers({
          "x-vercel-ip-latitude": "51.5072",
          "x-vercel-ip-longitude": "-0.1276",
          "x-vercel-ip-continent": "EU",
        }),
      )?.selectionReason,
    },
    { routeId: "ams-1", selectionReason: "coordinates" },
  );
});

test("edge selection falls back through location codes, then default", () => {
  assert.equal(
    selectedEdgePlaybackBaseUrl(headers({ "x-vercel-ip-country": "US" })),
    "https://ash-1.play.rend.so",
  );
  assert.equal(
    selectedEdgePlaybackBaseUrl(headers({ "x-vercel-ip-continent": "EU" })),
    "https://ams-1.play.rend.so",
  );
  assert.equal(
    selectedEdgePlaybackBaseUrl(headers({ "x-vercel-ip-country": "ZZ" })),
    "https://ash-1.play.rend.so",
  );
});

test("configured edge map remains available for local and explicit overrides", () => {
  assert.equal(
    selectedConfiguredEdgePlaybackBaseUrl(
      headers({ "x-vercel-ip-continent": "EU" }),
      EDGE_ENV,
    ),
    "https://ams-1.play.rend.so",
  );
});

test("playback base URL defaults to direct Tigris origin in production", () => {
  const request = new Request("https://www.rend.so/api/player/asset", {
    headers: {
      "x-vercel-ip-latitude": "51.5072",
      "x-vercel-ip-longitude": "-0.1276",
      "x-vercel-ip-continent": "EU",
    },
  });

  assert.equal(
    playbackBaseUrlForRequest(request, {
      REND_ENV_PROFILE: "production",
      REND_API_BASE_URL: "https://api.rend.so",
      REND_PLAYER_EDGE_BASE_URLS:
        "DEFAULT=https://wrong-edge.rend.so,EU=https://wrong-edge.rend.so",
    }),
    "https://api.rend.so",
  );
  assert.equal(
    playbackBaseUrlDecisionForRequest(request, {
      REND_ENV_PROFILE: "production",
      REND_API_BASE_URL: "https://api.rend.so",
      REND_PLAYER_EDGE_BASE_URLS:
        "DEFAULT=https://wrong-edge.rend.so,EU=https://wrong-edge.rend.so",
    }).source,
    "tigris_direct",
  );
});

test("playback base URL can temporarily fall back to the Tigris origin proxy", () => {
  const request = new Request("https://www.rend.so/api/player/asset");

  assert.equal(
    playbackBaseUrlForRequest(request, {
      REND_ENV_PROFILE: "production",
      REND_API_BASE_URL: "https://api.rend.so",
      REND_PLAYER_TIGRIS_DIRECT: "0",
    }),
    null,
  );
  assert.equal(
    playbackBaseUrlDecisionForRequest(request, {
      REND_ENV_PROFILE: "production",
      REND_API_BASE_URL: "https://api.rend.so",
      REND_PLAYER_TIGRIS_DIRECT: "0",
    }).source,
    "tigris_origin_proxy",
  );
});

test("playback base URL uses the shared metal table only in edge mode", () => {
  const request = new Request("https://www.rend.so/api/player/asset", {
    headers: {
      "x-vercel-ip-latitude": "51.5072",
      "x-vercel-ip-longitude": "-0.1276",
      "x-vercel-ip-continent": "EU",
    },
  });

  assert.equal(
    playbackBaseUrlForRequest(request, {
      REND_ENV_PROFILE: "production",
      REND_PLAYBACK_MODE: "edge",
      REND_PLAYER_EDGE_BASE_URLS:
        "DEFAULT=https://wrong-edge.rend.so,EU=https://wrong-edge.rend.so",
    }),
    "https://ams-1.play.rend.so",
  );
  assert.equal(
    playbackBaseUrlDecisionForRequest(request, {
      REND_ENV_PROFILE: "production",
      REND_PLAYBACK_MODE: "edge",
      REND_PLAYER_EDGE_BASE_URLS:
        "DEFAULT=https://wrong-edge.rend.so,EU=https://wrong-edge.rend.so",
    }).source,
    "shared_metal",
  );
});

test("playback base URL can use the configured edge map as an explicit override", () => {
  const request = new Request("https://www.rend.so/api/player/asset", {
    headers: {
      "x-vercel-ip-latitude": "51.5072",
      "x-vercel-ip-longitude": "-0.1276",
      "x-vercel-ip-continent": "EU",
    },
  });

  assert.equal(
    playbackBaseUrlForRequest(request, {
      REND_PLAYBACK_MODE: "edge",
      REND_ENV_PROFILE: "production",
      REND_PLAYER_EDGE_BASE_URLS_MODE: "override",
      REND_PLAYER_EDGE_BASE_URLS:
        "DEFAULT=https://ash-1.play.rend.so,EU=https://override-eu.play.rend.so",
    }),
    "https://override-eu.play.rend.so",
  );
});

test("playback base URL supports allowlisted manual override before geo selection", () => {
  const request = new Request(
    "https://www.rend.so/api/player/asset?playbackBaseUrl=https%3A%2F%2Ftest-edge.rend.so",
    { headers: { "x-vercel-ip-continent": "EU" } },
  );

  assert.equal(
    playbackBaseUrlForRequest(request, {
      ...EDGE_ENV,
      REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS: "https://test-edge.rend.so",
    }),
    "https://test-edge.rend.so",
  );
});

test("playback base URL uses the default shared metal route without geo headers in edge mode", () => {
  const request = new Request("https://www.rend.so/api/player/asset");

  assert.equal(
    playbackBaseUrlForRequest(request, {
      REND_PLAYBACK_MODE: "edge",
      REND_PLAYER_PLAYBACK_BASE_URL: "https://media.rend.so",
      REND_PLAYER_EDGE_BASE_URLS: "",
    }),
    "https://ash-1.play.rend.so",
  );
});

test("playback base URL uses configured edge map in non-production profiles only in edge mode", () => {
  const request = new Request("https://localhost:3000/api/player/asset", {
    headers: { "x-vercel-ip-continent": "EU" },
  });

  assert.equal(
    playbackBaseUrlForRequest(request, {
      ...EDGE_ENV,
      REND_PLAYBACK_MODE: "edge",
      REND_ENV_PROFILE: "local",
      REND_PLAYER_PLAYBACK_BASE_URL: "http://localhost:4100",
    }),
    "https://ams-1.play.rend.so",
  );
});
