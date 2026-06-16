import type { Metadata } from "next";
import { Wallet } from "lucide-react";
import Link from "next/link";
import {
  billingFeatureIds,
  billingOverview,
  billingReadinessFromOverview,
  type BillingBalance,
} from "../../../lib/billing.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-auth-next.ts";
import { dashboardStateFromBilling } from "../../../lib/dashboard-state.ts";
import { LEGAL_ASSENT_VERSION } from "../../../lib/legal-assent-constants.ts";
import { Button } from "@/components/ui/Button";
import {
  Callout,
  DashboardContent,
  Panel,
  StatusBadge,
  SubHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Billing",
  robots: {
    index: false,
    follow: false,
  },
};

type BillingPageProps = {
  searchParams?: Promise<{ billing_error?: string | string[] }>;
};

function formatNumber(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTimestamp(value: string | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function displayBalanceValue(balance: BillingBalance) {
  if (balance.unlimited) return "Unlimited";
  if (balance.remaining !== undefined && balance.granted !== undefined) {
    return `${formatNumber(balance.remaining)} / ${formatNumber(balance.granted)}`;
  }
  if (balance.usage !== undefined) return formatNumber(balance.usage);
  return "-";
}

function balanceLabel(featureId: string) {
  const features = billingFeatureIds();
  if (featureId === features.delivery720p) return "Delivery 720p seconds";
  if (featureId === features.delivery1080p) return "Delivery 1080p seconds";
  if (featureId === features.delivery2k) return "Delivery 2K seconds";
  if (featureId === features.delivery4k) return "Delivery 4K seconds";
  if (featureId === features.storage720p) return "Storage 720p second-months";
  if (featureId === features.storage1080p) return "Storage 1080p second-months";
  if (featureId === features.storage2k) return "Storage 2K second-months";
  if (featureId === features.storage4k) return "Storage 4K second-months";
  return featureId;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function billingActionErrorMessage(code: string | undefined) {
  if (!code) return "";
  if (code === "billing_checkout_mode_mismatch") {
    return "Checkout is not configured for this environment. Check the Autumn and Stripe mode, then try again.";
  }
  if (code === "billing_checkout_disabled") {
    return "External checkout is disabled for this environment. Local plan activation should complete without Stripe.";
  }
  if (code === "billing_invalid_response") {
    return "Billing returned an unexpected checkout response. Check the Autumn checkout configuration.";
  }
  if (code === "billing_provider_rejected_request") {
    return "Billing rejected the plan activation request. Check the plan configuration in Autumn.";
  }
  if (code === "legal_assent_required") {
    return "Review and accept the Rend Terms and Privacy Notice before choosing a plan.";
  }
  if (code === "invalid_plan") {
    return "The selected plan is not available.";
  }
  return "Plan activation could not be started. Check billing configuration and try again.";
}

export default async function BillingPage({ searchParams }: BillingPageProps) {
  const access = await requireDashboardAccess("/dashboard/billing");
  const params = searchParams ? await searchParams : {};
  const billingActionError = billingActionErrorMessage(firstParam(params.billing_error));
  const billing = await billingOverview(access);
  const dashboardState = dashboardStateFromBilling(billingReadinessFromOverview(billing));
  const returnUrl = "/dashboard/billing";

  return (
    <>
      <SubHeader
        title="Billing"
        docsHref="/docs#billing-usage"
        actions={
          <form action="/api/billing/portal" method="post">
            <input name="return_url" type="hidden" value={returnUrl} />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              className="rounded-md"
              disabled={!billing.manageBillingEnabled}
            >
              <Wallet className="size-4" />
              <span className="hidden sm:inline">Manage billing</span>
              <span className="sm:hidden">Manage</span>
            </Button>
          </form>
        }
      />

      <DashboardContent>
      <div className="mb-5 flex flex-col gap-3 empty:hidden">
        {billing.error ? <Callout tone="danger">{billing.error}</Callout> : null}
        {billingActionError ? <Callout tone="danger">{billingActionError}</Callout> : null}
        {dashboardState.status !== "ready_to_upload" ? (
          <Callout
            tone={dashboardState.status === "billing_unavailable" ? "danger" : "warn"}
            title={dashboardState.title}
          >
            {dashboardState.message}
          </Callout>
        ) : null}
      </div>

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Panel
          title="Plan"
          actions={
            <StatusBadge tone={billing.status === "ok" ? "success" : "danger"}>
              {billing.mode.charAt(0).toUpperCase() + billing.mode.slice(1)}
            </StatusBadge>
          }
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            <div className="col-span-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">Customer</dt>
              <dd className="mt-1.5 break-all font-mono text-[12.5px] text-ink-soft">{billing.customerId}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">Current plan</dt>
              <dd className="mt-1.5 text-[13.5px] font-medium text-ink">{billing.currentPlanLabel}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">Billing sync</dt>
              <dd className="mt-1.5 text-[13.5px] text-ink-soft">{billing.status}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">Last sync</dt>
              <dd className="mt-1.5 font-mono text-[12.5px] text-ink-soft">{formatTimestamp(billing.syncedAt)}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Usage" flush={billing.balances.length > 0} bodyClassName={billing.balances.length > 0 ? undefined : "p-4 sm:p-5"}>
          {billing.balances.length === 0 ? (
            <p className="text-[13.5px] text-muted">No billing balances are available.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Feature</TH>
                  <TH className="text-right">Balance</TH>
                  <TH className="text-right">Usage</TH>
                  <TH className="hidden text-right sm:table-cell">Reset</TH>
                </TR>
              </THead>
              <TBody>
                {billing.balances.map((balance) => (
                  <TR key={balance.featureId}>
                    <TD className="text-ink">{balanceLabel(balance.featureId)}</TD>
                    <TD className="text-right font-mono text-[12px] tabular-nums text-ink-soft">
                      {displayBalanceValue(balance)}
                    </TD>
                    <TD className="text-right font-mono text-[12px] tabular-nums text-muted">
                      {formatNumber(balance.usage)}
                    </TD>
                    <TD className="hidden text-right font-mono text-[12px] text-muted sm:table-cell">
                      {formatTimestamp(balance.nextResetAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Panel>
      </div>

      <Panel title="Plans">
        {billing.plans.length === 0 ? (
          <p className="text-[13.5px] text-muted">No plans are available.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {billing.plans.map((plan) => {
              const actionDisabled =
                !billing.checkoutEnabled ||
                plan.attachAction === "none" ||
                plan.relationshipStatus === "active";
              const assentId = `billing-assent-${plan.id}`;
              const isCurrent = plan.relationshipStatus === "active";

              return (
                <article
                  key={plan.id}
                  className="flex flex-col gap-4 rounded-xl border border-line bg-card p-5"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-head text-[17px] leading-tight text-ink">{plan.name}</h3>
                      {isCurrent ? <StatusBadge tone="success">Current</StatusBadge> : null}
                    </div>
                    {plan.description ? (
                      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{plan.description}</p>
                    ) : null}
                  </div>

                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[22px] font-medium text-ink">
                      {plan.priceLabel ?? plan.id}
                    </span>
                    {plan.intervalLabel ? (
                      <span className="text-[12px] text-muted">{plan.intervalLabel}</span>
                    ) : null}
                  </div>

                  <form action="/api/billing/checkout" method="post" className="mt-auto flex flex-col gap-3">
                    <input name="plan_id" type="hidden" value={plan.id} />
                    <input name="return_url" type="hidden" value={returnUrl} />
                    <input name="legal_assent_version" type="hidden" value={LEGAL_ASSENT_VERSION} />
                    <label
                      htmlFor={assentId}
                      className="flex items-start gap-2.5 rounded-md border border-line bg-bg-sunken/50 p-2.5 text-[12px] leading-relaxed text-muted"
                    >
                      <input
                        aria-describedby={`${assentId}-copy`}
                        disabled={actionDisabled}
                        id={assentId}
                        name="legal_assent"
                        required
                        type="checkbox"
                        value="accepted"
                        className="mt-0.5 size-3.5 shrink-0 accent-ink"
                      />
                      <span id={`${assentId}-copy`}>
                        I agree to the{" "}
                        <Link href="/terms" target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
                          Terms
                        </Link>{" "}
                        and{" "}
                        <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
                          Privacy Notice
                        </Link>
                        , including renewal, usage, and overage charges for this plan.
                      </span>
                    </label>
                    <Button type="submit" className="w-full rounded-md" disabled={actionDisabled}>
                      {isCurrent ? "Current plan" : plan.attachAction ?? "Choose plan"}
                    </Button>
                  </form>
                </article>
              );
            })}
          </div>
        )}
      </Panel>
      </DashboardContent>
    </>
  );
}
