import assert from "node:assert/strict";
import test from "node:test";
import { sendAuthOtpEmail } from "./auth.ts";
import { authFailureMessage, authRequestTimedOutMessage } from "./auth-errors.ts";
import { redactAuthText } from "./auth-events.ts";
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
  "REND_AUTH_EMAIL_SEND_TIMEOUT_MS",
  "REND_AUTH_EMAIL_SEND_RETRIES",
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

async function captureConsole<T>(run: () => Promise<T>) {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const calls: string[] = [];
  const serialize = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value);
  console.info = (...args: unknown[]) => {
    calls.push(args.map(serialize).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    calls.push(args.map(serialize).join(" "));
  };
  console.error = (...args: unknown[]) => {
    calls.push(args.map(serialize).join(" "));
  };
  try {
    const result = await run();
    return { result, calls };
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

test("local OTP email logs the code only when Resend is not configured", async () => {
  await withEnv({ REND_ENV: "local", RESEND_API_KEY: undefined }, async () => {
    const { calls } = await captureConsole(async () => {
      await sendAuthOtpEmail({
        email: "admin@rend.test",
        otp: "123456",
        type: "sign-in",
      });
    });

    const localOtpLog = calls.find((call) => call.includes("[rend-auth] local email OTP"));
    assert.ok(localOtpLog);
    assert.equal(localOtpLog.includes("123456"), true);
  });
});

test("OTP email uses Resend when configured without logging the code", async () => {
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
        const { calls } = await captureConsole(async () => sendAuthOtpEmail({
          email: "admin@example.com",
          otp: "654321",
          type: "sign-in",
        }));
        assert.equal(calls.join("\n").includes("654321"), false);
        assert.equal(calls.join("\n").includes("re_test_key"), false);
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

test("OTP email reports Resend provider rejection and redacts logs", async () => {
  await withEnv(
    {
      REND_ENV: "production",
      RESEND_API_KEY: "re_rejected_secret",
      REND_AUTH_EMAIL_FROM: "Rend <auth@example.com>",
      REND_AUTH_EMAIL_SEND_RETRIES: "0",
    },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        Response.json(
          {
            name: "invalid_api_key",
            message: "Invalid API key re_rejected_secret for code 222333",
            statusCode: 401,
          },
          { status: 401 }
        )) as typeof fetch;
      try {
        const { calls } = await captureConsole(async () => {
          await assert.rejects(
            sendAuthOtpEmail({
              email: "admin@example.com",
              otp: "222333",
              type: "sign-in",
            }),
            /Email provider rejected/
          );
        });
        const serialized = calls.join("\n");
        assert.equal(serialized.includes("222333"), false);
        assert.equal(serialized.includes("re_rejected_secret"), false);
        assert.equal(serialized.includes("[redacted-code]"), false);
        assert.match(serialized, /otp_send_failed/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test("OTP email returns within configured timeout when provider hangs", async () => {
  await withEnv(
    {
      REND_ENV: "production",
      RESEND_API_KEY: "re_timeout_secret",
      REND_AUTH_EMAIL_FROM: "Rend <auth@example.com>",
      REND_AUTH_EMAIL_SEND_TIMEOUT_MS: "20",
      REND_AUTH_EMAIL_SEND_RETRIES: "0",
    },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
      try {
        await assert.rejects(
          sendAuthOtpEmail({
            email: "admin@example.com",
            otp: "998877",
            type: "sign-in",
          }),
          /timed out/
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
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

test("auth text redaction removes OTPs, provider keys, bearer tokens, and cookies", () => {
  const redacted = redactAuthText(
    'otp "123456" re_secret123456789 authorization: Bearer abcdefghijklmnop\ncookie: session=abc'
  );
  assert.equal(redacted.includes("123456"), false);
  assert.equal(redacted.includes("re_secret123456789"), false);
  assert.equal(redacted.includes("abcdefghijklmnop"), false);
  assert.equal(redacted.includes("session=abc"), false);
});

test("auth failure messages are actionable for timeouts, rate limits, and invalid codes", () => {
  assert.match(authRequestTimedOutMessage("otp_request"), /could not confirm email delivery/i);
  assert.match(
    authFailureMessage({
      status: 429,
      fallback: "fallback",
      context: "otp_request",
    }),
    /Too many sign-in attempts/
  );
  assert.match(
    authFailureMessage({
      status: 400,
      payload: { message: "bad" },
      fallback: "fallback",
      context: "otp_verification",
    }),
    /Invalid or expired/
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
