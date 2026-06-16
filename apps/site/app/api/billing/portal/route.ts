import { NextResponse } from "next/server";
import {
  BILLING_EXTERNAL_REDIRECT_STATUS,
  billingErrorResponse,
  createPortalRedirect,
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

export async function POST(request: Request) {
  const access = await dashboardAccessFromRequest(request);
  if (!access.ok) return dashboardAccessErrorResponse(access);

  const formData = await request.formData();
  try {
    const redirectUrl = await createPortalRedirect(access.context, {
      returnUrl: formString(formData, "return_url"),
      requestUrl: request.url,
    });
    return NextResponse.redirect(redirectUrl, BILLING_EXTERNAL_REDIRECT_STATUS);
  } catch (error) {
    return billingErrorResponse(error);
  }
}
