import { NextResponse } from "next/server";
import {
  dashboardAccessFromRequest,
  dashboardAccessErrorResponse,
} from "../../../lib/dashboard-auth.ts";
import {
  canUseOperatorSurface,
  operatorDeniedMessage,
  performOperatorAction,
  type OperatorAction,
  type OperatorTargetType,
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

function safeAction(value: string): OperatorAction | null {
  return value === "suspend" || value === "restore" ? value : null;
}

function safeTargetType(value: string): OperatorTargetType | null {
  return value === "organization" || value === "asset" ? value : null;
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
  const action = safeAction(formString(formData, "action"));
  const targetType = safeTargetType(formString(formData, "target_type"));
  const targetId = formString(formData, "target_id").toLowerCase();
  const reason = formString(formData, "reason");

  if (!action || !targetType || !targetId || !reason) {
    return redirectWith(request, {
      status: "error",
      message: "Action, target, and reason are required.",
    });
  }

  try {
    const result = await performOperatorAction(access.context, {
      action,
      targetType,
      targetId,
      reason,
    });
    return redirectWith(request, {
      status: "ok",
      message: `${result.action} ${result.target_type} ${result.target_id}`,
      purge: result.purge_attempted ? "1" : "0",
    });
  } catch (error) {
    return redirectWith(request, {
      status: "error",
      message: error instanceof Error ? error.message : "Operator action failed.",
    });
  }
}
