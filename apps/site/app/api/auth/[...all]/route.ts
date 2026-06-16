import { toNextJsHandler } from "better-auth/next-js";
import { authFailureMessage, type AuthErrorContext } from "../../../../lib/auth-errors.ts";
import {
  authEmailSummary,
  logAuthEvent,
  normalizeAuthEmail,
  redactAuthText,
} from "../../../../lib/auth-events.ts";
import { ensureLocalAuthSeed } from "../../../../lib/auth-seed.ts";
import { getAuth } from "../../../../lib/auth.ts";
import {
  legalAssentAccepted,
  legalAssentCookieHeader,
  legalAssentRequiredResponse,
} from "../../../../lib/legal-assent.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_AUTH_ROUTE_TIMEOUT_MS = 20_000;

async function handler(request: Request) {
  await ensureLocalAuthSeed();
  const auth = getAuth() as { handler: (request: Request) => Response | Promise<Response> };
  return auth.handler(request);
}

const authHandlers = toNextJsHandler(handler);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isOtpSendRequest(request: Request) {
  return new URL(request.url).pathname.endsWith("/email-otp/send-verification-otp");
}

function isOtpVerificationRequest(request: Request) {
  const pathname = new URL(request.url).pathname;
  return (
    pathname.endsWith("/sign-in/email-otp") ||
    pathname.endsWith("/email-otp/check-verification-otp")
  );
}

function authRouteTimeoutMs() {
  const configured = Number(process.env.REND_AUTH_ROUTE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_AUTH_ROUTE_TIMEOUT_MS;
  return Math.min(60_000, Math.max(1_000, Math.trunc(configured)));
}

function requestWithJsonBody(request: Request, payload: Record<string, unknown>) {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request.url, {
    body: JSON.stringify(payload),
    headers,
    method: request.method,
  });
}

function requestContext(request: Request): AuthErrorContext {
  if (isOtpSendRequest(request)) return "otp_request";
  if (isOtpVerificationRequest(request)) return "otp_verification";
  return "auth";
}

function failureFallback(context: AuthErrorContext) {
  if (context === "otp_request") return "Unable to send sign-in code";
  if (context === "otp_verification") return "Invalid or expired sign-in code";
  return "Authentication request failed";
}

async function responsePayload(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { body: redactAuthText(text) };
  }
}

async function normalizeFailureResponse(response: Response, context: AuthErrorContext) {
  if (response.ok) return response;
  const payload = await responsePayload(response.clone());
  const message = authFailureMessage({
    status: response.status,
    payload,
    fallback: failureFallback(context),
    context,
  });
  return Response.json(
    {
      status: "error",
      error:
        isRecord(payload) && typeof payload.error === "string"
          ? redactAuthText(payload.error)
          : response.status === 429
            ? "rate_limited"
            : "auth_request_failed",
      message,
    },
    {
      status: response.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    }
  );
}

async function callAuthPost(request: Request, context: AuthErrorContext) {
  const timeoutMs = authRouteTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      authHandlers.POST(request),
      new Promise<Response>((resolve) => {
        timeout = setTimeout(() => {
          logAuthEvent(
            "auth_route_timed_out",
            {
              path: new URL(request.url).pathname,
              timeout_ms: timeoutMs,
              context,
            },
            "error"
          );
          resolve(
            Response.json(
              {
                status: "error",
                error: "auth_request_timed_out",
                message: authFailureMessage({
                  status: 504,
                  fallback: failureFallback(context),
                  context,
                }),
              },
              {
                status: 504,
                headers: {
                  "cache-control": "no-store",
                  "content-type": "application/json",
                },
              }
            )
          );
        }, timeoutMs);
      }),
    ]);
    return normalizeFailureResponse(response, context);
  } catch (error) {
    logAuthEvent(
      context === "otp_request"
        ? "otp_send_failed"
        : context === "otp_verification"
          ? "otp_verification_failed"
          : "auth_request_failed",
      {
        path: new URL(request.url).pathname,
        context,
        error: error instanceof Error ? error.message : String(error),
      },
      "error"
    );
    return Response.json(
      {
        status: "error",
        error: "auth_request_failed",
        message: authFailureMessage({
          status: 500,
          fallback: failureFallback(context),
          context,
        }),
      },
      {
        status: 500,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      }
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function parseAuthJson(request: Request) {
  const payload = await request.json().catch(() => null);
  return isRecord(payload) ? payload : null;
}

export const GET = authHandlers.GET;

export async function POST(request: Request) {
  if (isOtpVerificationRequest(request)) {
    const payload = await parseAuthJson(request);
    if (!payload || typeof payload.email !== "string") {
      return Response.json(
        {
          status: "error",
          error: "invalid_auth_request",
          message: "Email and sign-in code are required.",
        },
        { status: 400, headers: { "cache-control": "no-store" } }
      );
    }

    const normalizedEmail = normalizeAuthEmail(payload.email);
    logAuthEvent("otp_verification_attempted", {
      ...authEmailSummary(normalizedEmail),
      path: new URL(request.url).pathname,
    });
    const response = await callAuthPost(
      requestWithJsonBody(request, { ...payload, email: normalizedEmail }),
      "otp_verification"
    );
    if (response.ok) {
      logAuthEvent("session_created", {
        ...authEmailSummary(normalizedEmail),
        path: new URL(request.url).pathname,
      });
    } else {
      logAuthEvent(
        "otp_verification_failed",
        {
          ...authEmailSummary(normalizedEmail),
          path: new URL(request.url).pathname,
          status: response.status,
        },
        response.status >= 500 ? "error" : "warn"
      );
    }
    return response;
  }

  if (!isOtpSendRequest(request)) return callAuthPost(request, requestContext(request));

  const payload = await parseAuthJson(request);
  if (!isRecord(payload) || !legalAssentAccepted(payload) || typeof payload.email !== "string") {
    logAuthEvent("otp_request_rejected", {
      path: new URL(request.url).pathname,
      reason: "legal_assent_required",
    }, "warn");
    return legalAssentRequiredResponse();
  }

  const normalizedEmail = normalizeAuthEmail(payload.email);
  logAuthEvent("otp_requested", {
    ...authEmailSummary(normalizedEmail),
    path: new URL(request.url).pathname,
  });

  const {
    legal_assent: _legalAssent,
    legal_assent_version: _legalAssentVersion,
    ...authPayload
  } = payload;
  const response = await callAuthPost(
    requestWithJsonBody(request, { ...authPayload, email: normalizedEmail }),
    "otp_request"
  );
  if (!response.ok) return response;

  const headers = new Headers(response.headers);
  headers.append("set-cookie", legalAssentCookieHeader(normalizedEmail));
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
