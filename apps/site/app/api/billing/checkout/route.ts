import { NextResponse } from "next/server";
import {
  BillingError,
  createCheckoutRedirect,
} from "../../../../lib/billing.ts";
import {
  dashboardAccessErrorResponse,
  dashboardAccessFromRequest,
} from "../../../../lib/dashboard-auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formString(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function billingErrorRedirect(requestUrl: string, error: unknown) {
  const code =
    error instanceof BillingError && error.code
      ? error.code
      : "billing_request_failed";
  const url = new URL("/dashboard/billing", requestUrl);
  url.searchParams.set("billing_error", code);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  const formData = await request.formData();
  try {
    const redirectUrl = await createCheckoutRedirect(access.context, {
      planId: formString(formData, "plan_id"),
      returnUrl: formString(formData, "return_url"),
      requestUrl: request.url,
    });
    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    return billingErrorRedirect(request.url, error);
  }
}
