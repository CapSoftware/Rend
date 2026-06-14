import { apiKeyErrorResponse, revokeApiKey } from "../../../../lib/api-keys.ts";
import {
  canManageApiKeys,
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
  dashboardSuspendedResponse,
  organizationIsSuspended,
} from "../../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeKeyId(value: string) {
  const keyId = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(keyId)
    ? keyId
    : null;
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ keyId: string }> }
) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);
  if (organizationIsSuspended(access.context)) return dashboardSuspendedResponse(access.context);
  if (!canManageApiKeys(access.context)) {
    return dashboardAccessErrorResponse({ ok: false, reason: "forbidden" });
  }

  const { keyId: rawKeyId } = await context.params;
  const keyId = safeKeyId(rawKeyId);
  if (!keyId) {
    return Response.json(
      {
        status: "error",
        error: "invalid_key_id",
        message: "API key id is invalid",
      },
      {
        status: 400,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      }
    );
  }

  try {
    const revoked = await revokeApiKey(access.context, keyId);
    return Response.json(
      {
        status: "ok",
        revoked,
      },
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      }
    );
  } catch (error) {
    return apiKeyErrorResponse(error);
  }
}
