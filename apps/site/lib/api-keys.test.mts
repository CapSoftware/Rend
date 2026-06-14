import assert from "node:assert/strict";
import test from "node:test";
import { hashApiKey, normalizeApiKeyScopes } from "./api-keys.ts";

test("API key scope normalization accepts only supported scopes", () => {
  assert.deepEqual(normalizeApiKeyScopes(["read", "upload"]), ["read", "upload"]);
  assert.throws(() => normalizeApiKeyScopes([]), /invalid/i);
  assert.throws(() => normalizeApiKeyScopes(["read", "unknown"]), /invalid/i);
  assert.throws(() => normalizeApiKeyScopes(["read", "read"]), /invalid/i);
});

test("API key hashing is deterministic and does not return the raw key", () => {
  const rawKey = "rend_test_example-secret";
  const hash = hashApiKey(rawKey);

  assert.equal(hash, hashApiKey(rawKey));
  assert.equal(hash.length, 64);
  assert.equal(hash.includes(rawKey), false);
});
