import assert from "node:assert/strict";
import test from "node:test";
import { forwardedHost, isTrustedRendHost, publicRequestHost } from "./player-request-origin.ts";

test("trusted Rend host detection accepts rend.so and subdomains only", () => {
  assert.equal(isTrustedRendHost("rend.so"), true);
  assert.equal(isTrustedRendHost("www.rend.so"), true);
  assert.equal(isTrustedRendHost("ams-1.play.rend.so"), true);
  assert.equal(isTrustedRendHost("rend.so.evil.test"), false);
  assert.equal(isTrustedRendHost("example.com"), false);
});

test("forwarded host parser accepts the first forwarded host without ports", () => {
  const request = new Request("http://127.0.0.1:3001/api/player/asset", {
    headers: {
      "x-forwarded-host": "www.rend.so:443, proxy.internal",
    },
  });

  assert.equal(forwardedHost(request), "www.rend.so");
});

test("public request host prefers actual trusted host over forwarded host", () => {
  const request = new Request("https://www.rend.so/api/player/asset", {
    headers: {
      "x-forwarded-host": "preview.rend.so",
    },
  });

  assert.equal(publicRequestHost(request), "www.rend.so");
});

test("public request host uses trusted forwarded host behind local reverse proxies", () => {
  const request = new Request("http://127.0.0.1:3001/api/player/asset", {
    headers: {
      "x-forwarded-host": "www.rend.so",
    },
  });

  assert.equal(publicRequestHost(request), "www.rend.so");
});

test("public request host ignores untrusted forwarded hosts", () => {
  const request = new Request("http://127.0.0.1:3001/api/player/asset", {
    headers: {
      "x-forwarded-host": "rend.so.evil.test",
    },
  });

  assert.equal(publicRequestHost(request), "127.0.0.1");
});
