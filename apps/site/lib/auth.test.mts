import assert from "node:assert/strict";
import test from "node:test";
import { sendAuthOtpEmail } from "./auth.ts";
import {
  legalAssentAccepted,
  legalAssentCookieHeader,
  legalAssentFromHeaders,
} from "./legal-assent.ts";
import { LEGAL_ASSENT_VERSION } from "./legal-assent-constants.ts";

const ENV_KEYS = [
  "REND_ENV",
  "REND_ENV_PROFILE",
  "RESEND_API_KEY",
  "REND_AUTH_EMAIL_FROM",
  "REND_AUTH_EMAIL_DISABLED",
];

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);

  try {
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("local OTP email logs the code only when Resend is not configured", async () => {
  await withEnv({ REND_ENV: "local", RESEND_API_KEY: undefined }, async () => {
    const originalInfo = console.info;
    const calls: unknown[][] = [];
    console.info = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      await sendAuthOtpEmail({
        email: "admin@rend.test",
        otp: "123456",
        type: "sign-in",
      });
    } finally {
      console.info = originalInfo;
    }

    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(calls[0]).includes("123456"), true);
  });
});

test("OTP email uses Resend when configured", async () => {
  await withEnv(
    {
      REND_ENV: "production",
      RESEND_API_KEY: "re_test_key",
      REND_AUTH_EMAIL_FROM: "Rend <auth@example.com>",
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ url: string; body: string }> = [];
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: typeof init?.body === "string" ? init.body : "",
        });
        return Response.json({ id: "email_test" });
      }) as typeof fetch;
      try {
        await sendAuthOtpEmail({
          email: "admin@example.com",
          otp: "654321",
          type: "sign-in",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url.includes("resend.com"), true);
      assert.equal(calls[0].body.includes("654321"), true);
      assert.equal(calls[0].body.includes("Rend <auth@example.com>"), true);
    }
  );
});

test("production OTP email fails when Resend is required but missing", async () => {
  await withEnv(
    {
      REND_ENV: "production",
      RESEND_API_KEY: undefined,
      REND_AUTH_EMAIL_FROM: undefined,
      REND_AUTH_EMAIL_DISABLED: undefined,
    },
    async () => {
      await assert.rejects(
        sendAuthOtpEmail({
          email: "admin@example.com",
          otp: "123456",
          type: "sign-in",
        }),
        /RESEND_API_KEY/
      );
    }
  );
});

test("legal assent accepts only the current version", () => {
  assert.equal(
    legalAssentAccepted({
      legal_assent: "accepted",
      legal_assent_version: LEGAL_ASSENT_VERSION,
    }),
    true
  );
  assert.equal(
    legalAssentAccepted({
      legal_assent: "accepted",
      legal_assent_version: "2025-01-01",
    }),
    false
  );
});

test("legal assent cookie is signed and email scoped", () => {
  const env = { AUTH_SECRET: "test-legal-assent-secret" };
  const cookie = legalAssentCookieHeader("Admin@Rend.test", new Date(), env).split(";")[0];
  const headers = new Headers({ cookie });

  assert.deepEqual(legalAssentFromHeaders(headers, "admin@rend.test", env), {
    acceptedAt: legalAssentFromHeaders(headers, "admin@rend.test", env)?.acceptedAt,
    email: "admin@rend.test",
    version: LEGAL_ASSENT_VERSION,
  });
  assert.equal(legalAssentFromHeaders(headers, "other@rend.test", env), null);
  assert.equal(legalAssentFromHeaders(new Headers({ cookie: `${cookie}tampered` }), "admin@rend.test", env), null);
});
