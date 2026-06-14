#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadOpenApiSpec, validateSchema, dereference } from "./openapi/schema-validator.mjs";

const FORBIDDEN_TEXT = [
  "/internal/",
  "/internal",
  "/operator",
  "x-rend-site-token",
  "x-rend-internal-token",
  "x-rend-telemetry-token",
  "REND_SITE_INTERNAL_TOKEN",
  "REND_EDGE_INTERNAL_TOKEN",
  "local-site-internal-token",
  "dev-internal-token",
  "?token=",
  "source_object_key",
  "source_artifact_id"
];

const FORBIDDEN_REGEX = [
  /"playback_token"\s*:/,
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)/i
];

const spec = await loadOpenApiSpec();

assert.equal(spec.openapi, "3.1.0", "OpenAPI version must be 3.1.0");
assert.ok(spec.info?.title, "info.title is required");
assert.ok(spec.info?.version, "info.version is required");
assert.ok(spec.paths && typeof spec.paths === "object", "paths are required");

const serialized = JSON.stringify(spec);
for (const value of FORBIDDEN_TEXT) {
  assert.equal(serialized.includes(value), false, `public OpenAPI spec contains forbidden text: ${value}`);
}
for (const pattern of FORBIDDEN_REGEX) {
  assert.equal(pattern.test(serialized), false, `public OpenAPI spec matches forbidden pattern: ${pattern}`);
}

const operationIds = new Set();
for (const [pathName, pathItem] of Object.entries(spec.paths)) {
  assert.equal(pathName.includes("/internal"), false, `internal path must not be public: ${pathName}`);
  assert.equal(pathName.includes("/operator"), false, `operator path must not be public: ${pathName}`);

  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const operation = pathItem?.[method];
    if (!operation) continue;

    assert.ok(operation.operationId, `${method.toUpperCase()} ${pathName} needs operationId`);
    assert.equal(
      operationIds.has(operation.operationId),
      false,
      `duplicate operationId: ${operation.operationId}`
    );
    operationIds.add(operation.operationId);

    assert.ok(Array.isArray(operation.tags) && operation.tags.length > 0, `${operation.operationId} needs tags`);
    assert.ok(operation.responses && typeof operation.responses === "object", `${operation.operationId} needs responses`);

    const server = operation["x-rend-server"];
    assert.ok(server === "api" || server === "site", `${operation.operationId} needs x-rend-server api/site`);
    if (server === "api") {
      assert.deepEqual(operation.security, [{ RendApiKey: [] }], `${operation.operationId} must use API-key auth`);
    }
    if (server === "site") {
      assert.deepEqual(operation.security, [], `${operation.operationId} must be anonymous site playback surface`);
    }

    for (const [status, rawResponse] of Object.entries(operation.responses)) {
      const response = dereference(spec, rawResponse);
      assert.ok(response.description, `${operation.operationId} ${status} response needs description`);
      for (const [contentType, media] of Object.entries(response.content ?? {})) {
        assert.ok(media.schema, `${operation.operationId} ${status} ${contentType} needs schema`);
        for (const [exampleName, example] of Object.entries(media.examples ?? {})) {
          const errors = validateSchema(spec, media.schema, example.value);
          assert.deepEqual(
            errors,
            [],
            `${operation.operationId} ${status} example ${exampleName} must match schema`
          );
        }
      }
    }
  }
}

const requiredOperations = [
  "uploadAsset",
  "listAssets",
  "getAsset",
  "deleteAsset",
  "listAssetEvents",
  "streamAssetEvents",
  "getPlaybackBootstrap",
  "recordPlayerTelemetry",
  "getPlaybackAnalytics"
];

for (const operationId of requiredOperations) {
  assert.equal(operationIds.has(operationId), true, `missing required operationId: ${operationId}`);
}

console.log(`OpenAPI lint passed for ${operationIds.size} operations.`);
