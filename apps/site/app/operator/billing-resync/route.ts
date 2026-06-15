import { NextResponse } from "next/server";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
} from "../../../lib/dashboard-auth.ts";
import {
  canUseOperatorSurface,
  operatorDeniedMessage,
  performBillingCustomerResync,
} from "../../../lib/operator.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formString(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function redirectWith(request: Request, params: Record<string, string>) {
  const url = new URL("/operator", request.url);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}

export async function POST(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);
  if (!canUseOperatorSurface(access.context)) {
    return redirectWith(request, {
      status: "error",
      message: operatorDeniedMessage(),
    });
  }

  const formData = await request.formData();
  const organizationId = formString(formData, "organization_id").toLowerCase();
  if (!organizationId) {
    return redirectWith(request, {
      status: "error",
      message: "Organization ID is required.",
    });
  }

  try {
    const result = await performBillingCustomerResync(access.context, organizationId);
    return redirectWith(request, {
      status: "ok",
      message: `billing resynced for ${result.customerId}`,
    });
  } catch (error) {
    return redirectWith(request, {
      status: "error",
      message: error instanceof Error ? error.message : "Billing resync failed.",
    });
  }
}
