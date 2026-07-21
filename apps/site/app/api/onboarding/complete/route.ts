import { authEmailSummary, authSubjectId, logAuthEvent } from "../../../../lib/auth-events.ts";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
} from "../../../../lib/dashboard-auth.ts";
import {
  MAX_ONBOARDING_NAME_LENGTH,
  MAX_ONBOARDING_ORGANIZATION_NAME_LENGTH,
  completeOnboarding,
  sanitizeOnboardingText,
} from "../../../../lib/onboarding.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
}

function errorResponse(status: number, error: string, message: string) {
  return jsonResponse(status, { status: "error", error, message });
}

export async function POST(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  const payload = await request.json().catch(() => null);
  if (!isRecord(payload)) {
    return errorResponse(400, "invalid_request", "Onboarding details are required.");
  }

  const name = sanitizeOnboardingText(payload.name, MAX_ONBOARDING_NAME_LENGTH);
  const organizationName = sanitizeOnboardingText(
    payload.organization_name ?? payload.organizationName,
    MAX_ONBOARDING_ORGANIZATION_NAME_LENGTH
  );
  if (!name) return errorResponse(400, "name_required", "Enter your name to continue.");
  if (!organizationName) {
    return errorResponse(400, "organization_name_required", "Enter an organization name to continue.");
  }

  try {
    await completeOnboarding({
      userId: access.context.userId,
      organizationId: access.context.organizationId,
      name,
      organizationName,
    });
  } catch (error) {
    logAuthEvent(
      "onboarding_failed",
      {
        ...authEmailSummary(access.context.userEmail),
        user_id_hash: authSubjectId(access.context.userId),
        organization_id_hash: authSubjectId(access.context.organizationId),
        error: error instanceof Error ? error.message : String(error),
      },
      "error"
    );
    return errorResponse(500, "onboarding_failed", "We could not save your details. Try again.");
  }

  logAuthEvent("onboarding_completed", {
    ...authEmailSummary(access.context.userEmail),
    user_id_hash: authSubjectId(access.context.userId),
    organization_id_hash: authSubjectId(access.context.organizationId),
  });

  return jsonResponse(200, { status: "ok" });
}
