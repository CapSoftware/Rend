import type { BillingReadiness } from "./billing.ts";

export type DashboardState = {
  status:
    | "org_setup"
    | "billing_required"
    | "ready_to_upload"
    | "plan_limit_exceeded"
    | "billing_unavailable";
  title: string;
  message: string;
  actionHref?: string;
  actionLabel?: string;
  blocksUpload?: boolean;
};

export function dashboardStateFromBilling(readiness: BillingReadiness): DashboardState {
  if (readiness.status === "ready") {
    return {
      status: "ready_to_upload",
      title: "Ready to upload",
      message: readiness.message,
    };
  }

  return {
    status: readiness.status,
    title:
      readiness.status === "billing_required"
        ? "Billing required"
        : readiness.status === "plan_limit_exceeded"
          ? "Plan limit exceeded"
          : "Billing unavailable",
    message: readiness.message,
    actionHref: readiness.actionHref,
    actionLabel: readiness.actionLabel,
    blocksUpload: true,
  };
}

export function orgSetupState(): DashboardState {
  return {
    status: "org_setup",
    title: "Workspace setup",
    message: "Your workspace is created automatically after email verification.",
  };
}
