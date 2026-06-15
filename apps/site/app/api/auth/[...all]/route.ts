import { toNextJsHandler } from "better-auth/next-js";
import { ensureLocalAuthSeed } from "../../../../lib/auth-seed.ts";
import { getAuth } from "../../../../lib/auth.ts";
import {
  legalAssentAccepted,
  legalAssentCookieHeader,
  legalAssentRequiredResponse,
} from "../../../../lib/legal-assent.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

function requestWithJsonBody(request: Request, payload: Record<string, unknown>) {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request.url, {
    body: JSON.stringify(payload),
    headers,
    method: request.method,
  });
}

export const GET = authHandlers.GET;

export async function POST(request: Request) {
  if (!isOtpSendRequest(request)) return authHandlers.POST(request);

  const payload = await request.json().catch(() => null);
  if (!isRecord(payload) || !legalAssentAccepted(payload) || typeof payload.email !== "string") {
    return legalAssentRequiredResponse();
  }

  const {
    legal_assent: _legalAssent,
    legal_assent_version: _legalAssentVersion,
    ...authPayload
  } = payload;
  const response = await authHandlers.POST(requestWithJsonBody(request, authPayload));
  if (!response.ok) return response;

  const headers = new Headers(response.headers);
  headers.append("set-cookie", legalAssentCookieHeader(payload.email));
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
