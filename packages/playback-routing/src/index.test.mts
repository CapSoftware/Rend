import assert from "node:assert/strict";
import test from "node:test";
import {
  closestMetalPlaybackRoute,
  closestMetalPlaybackRouteDecision,
  playbackRouteDistanceKm,
  REND_METAL_PLAYBACK_ROUTES,
} from "./index.ts";

test("closestMetalPlaybackRoute selects the nearest metal route from coordinates", () => {
  assert.equal(
    closestMetalPlaybackRoute({ latitude: "38.9047", longitude: "-77.0164" })?.id,
    "ash-1"
  );
  assert.equal(
    closestMetalPlaybackRoute({ latitude: "51.5072", longitude: "-0.1276" })?.id,
    "ams-1"
  );
});

test("closestMetalPlaybackRoute falls back through country, continent, and default", () => {
  assert.equal(closestMetalPlaybackRoute({ country: "US" })?.id, "ash-1");
  assert.equal(closestMetalPlaybackRoute({ continent: "EU" })?.id, "ams-1");
  assert.equal(closestMetalPlaybackRoute({ country: "ZZ" })?.id, "ash-1");
});

test("closestMetalPlaybackRouteDecision explains the selected route source", () => {
  assert.deepEqual(
    {
      id: closestMetalPlaybackRouteDecision({
        latitude: "51.5072",
        longitude: "-0.1276",
      })?.route.id,
      source: closestMetalPlaybackRouteDecision({
        latitude: "51.5072",
        longitude: "-0.1276",
      })?.source,
    },
    { id: "ams-1", source: "coordinates" }
  );
  assert.deepEqual(
    {
      id: closestMetalPlaybackRouteDecision({ continent: "EU" })?.route.id,
      source: closestMetalPlaybackRouteDecision({ continent: "EU" })?.source,
      matchedCode: closestMetalPlaybackRouteDecision({ continent: "EU" })?.matchedCode,
    },
    { id: "ams-1", source: "continent", matchedCode: "EU" }
  );
});

test("closestMetalPlaybackRoute ignores invalid coordinates before code fallback", () => {
  assert.equal(
    closestMetalPlaybackRoute({
      latitude: "200",
      longitude: "-181",
      continent: "EU",
    })?.id,
    "ams-1"
  );
});

test("playbackRouteDistanceKm returns finite distances for configured routes", () => {
  for (const route of REND_METAL_PLAYBACK_ROUTES) {
    const distance = playbackRouteDistanceKm({ latitude: 40.7128, longitude: -74.006 }, route);
    assert.ok(Number.isFinite(distance));
    assert.ok(distance > 0);
  }
});
