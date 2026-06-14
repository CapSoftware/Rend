import {
  apiKeyErrorResponse,
  createApiKey,
  listApiKeys,
} from "../../../lib/api-keys.ts";
import {
  canManageApiKeys,
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
} from "../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);
  if (!canManageApiKeys(access.context)) {
    return dashboardAccessErrorResponse({ ok: false, reason: "forbidden" });
  }

  try {
    return Response.json(
      {
        status: "ok",
        api_keys: await listApiKeys(access.context),
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

export async function POST(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);
  if (!canManageApiKeys(access.context)) {
    return dashboardAccessErrorResponse({ ok: false, reason: "forbidden" });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      scopes?: unknown;
    };
    const result = await createApiKey(access.context, {
      name: body.name,
      scopes: body.scopes,
    });
    return Response.json(
      {
        status: "ok",
        api_key: result.apiKey,
        secret: result.secret,
      },
      {
        status: 201,
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
