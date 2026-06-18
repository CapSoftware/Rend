import type { Metadata } from "next";
import { Wallet } from "lucide-react";
import {
  billingFeatureIds,
  billingOverview,
  billingReadinessFromOverview,
  type BillingBalance,
  type BillingOverview,
} from "../../../lib/billing.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-auth-next.ts";
import { dashboardStateFromBilling } from "../../../lib/dashboard-state.ts";
import { LEGAL_ASSENT_VERSION } from "../../../lib/legal-assent-constants.ts";
import BillingPlansClient from "@/components/BillingPlansClient";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Callout, DashboardContent, SubHeader } from "@/components/dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Billing",
  robots: {
    index: false,
    follow: false,
  },
};

const USAGE_CREDITS_FEATURE_ID = (process.env.REND_BILLING_FEATURE_USAGE_CREDITS || "rend_usage_credits").trim();

type BillingPageProps = {
  searchParams?: Promise<{ billing_error?: string | string[] }>;
};

type UsageRow = {
  featureId: string;
  tierLabel: string;
  balance: BillingBalance;
};

function formatNumber(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatDate(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function humanizeFeature(featureId: string) {
  const base = featureId.replace(/^rend[_-]/i, "").replace(/[_-]+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : featureId;
}

function balanceLabel(featureId: string) {
  const features = billingFeatureIds();
  if (featureId === features.delivery720p) return "720p";
  if (featureId === features.delivery1080p) return "1080p";
  if (featureId === features.delivery2k) return "2K";
  if (featureId === features.delivery4k) return "4K";
  if (featureId === features.storage720p) return "720p";
  if (featureId === features.storage1080p) return "1080p";
  if (featureId === features.storage2k) return "2K";
  if (featureId === features.storage4k) return "4K";
  return humanizeFeature(featureId);
}

function groupUsage(balances: BillingBalance[]) {
  const features = billingFeatureIds();
  const order: [string, "delivery" | "storage", string][] = [
    [features.delivery720p, "delivery", "720p"],
    [features.delivery1080p, "delivery", "1080p"],
    [features.delivery2k, "delivery", "2K"],
    [features.delivery4k, "delivery", "4K"],
    [features.storage720p, "storage", "720p"],
    [features.storage1080p, "storage", "1080p"],
    [features.storage2k, "storage", "2K"],
    [features.storage4k, "storage", "4K"],
  ];
  const byId = new Map(balances.map((balance) => [balance.featureId, balance]));
  const used = new Set<string>();
  const delivery: UsageRow[] = [];
  const storage: UsageRow[] = [];
  for (const [id, kind, tierLabel] of order) {
    const balance = byId.get(id);
    if (!balance) continue;
    used.add(id);
    (kind === "delivery" ? delivery : storage).push({ featureId: id, tierLabel, balance });
  }
  const other: UsageRow[] = balances
    .filter((balance) => !used.has(balance.featureId))
    .map((balance) => ({ featureId: balance.featureId, tierLabel: balanceLabel(balance.featureId), balance }));
  return { delivery, storage, other };
}

function usedValue(balance: BillingBalance) {
  if (balance.usage !== undefined) return balance.usage;
  if (balance.granted !== undefined && balance.remaining !== undefined) {
    return Math.max(0, balance.granted - balance.remaining);
  }
  return undefined;
}

function displayBalanceValue(balance: BillingBalance) {
  if (balance.remaining !== undefined && balance.granted !== undefined && !balance.unlimited) {
    return `${formatNumber(balance.remaining)} left of ${formatNumber(balance.granted)}`;
  }
  const used = usedValue(balance);
  if (balance.unlimited) {
    return used !== undefined && used > 0 ? `${formatNumber(used)} used` : "Unlimited";
  }
  return used === undefined ? "-" : `${formatNumber(used)} used`;
}

function meterFor(balance: BillingBalance) {
  const granted = balance.granted;
  const hasMeter = !balance.unlimited && granted !== undefined && granted > 0;
  const used = usedValue(balance) ?? 0;
  const pct = hasMeter ? Math.min(100, Math.max(0, (used / granted) * 100)) : 0;
  const exhausted = balance.remaining !== undefined && balance.remaining <= 0 && !balance.unlimited;
  const barColor = exhausted ? "bg-[#b54033]" : pct >= 85 ? "bg-[#c79a2e]" : "bg-ink";
  return { hasMeter, pct, exhausted, barColor };
}

function Meter({ balance, className }: { balance: BillingBalance; className?: string }) {
  const { hasMeter, pct, barColor } = meterFor(balance);
  if (!hasMeter) return null;
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-bg-sunken", className)}>
      <div className={cn("h-full rounded-full", barColor)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function UsageRowLine({ row }: { row: UsageRow }) {
  const { exhausted } = meterFor(row.balance);
  const value = displayBalanceValue(row.balance);
  const reset = formatDate(row.balance.nextResetAt);
  return (
    <div className="border-b border-line-soft py-3 first:pt-0 last:border-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13.5px] text-ink">{row.tierLabel}</span>
        <span
          className={cn(
            "font-mono text-[12px] tabular-nums",
            value === "Unlimited" ? "text-faint" : exhausted ? "text-[#9a2b22]" : "text-ink-soft",
          )}
        >
          {value}
        </span>
      </div>
      <Meter balance={row.balance} className="mt-2" />
      {reset ? <p className="mt-1.5 text-[11px] text-faint">Resets {reset}</p> : null}
    </div>
  );
}

function UsageGroup({ title, caption, rows, className }: { title: string; caption: string; rows: UsageRow[]; className?: string }) {
  return (
    <div className={className}>
      <h3 className="font-head text-[17px] leading-none text-ink">{title}</h3>
      <p className="mt-1.5 text-[12.5px] text-muted">{caption}</p>
      <div className="mt-4 flex flex-col">
        {rows.map((row) => (
          <UsageRowLine key={row.featureId} row={row} />
        ))}
      </div>
    </div>
  );
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

function planNote(billing: BillingOverview) {
  if (billing.status !== "ok") {
    return "Showing your last saved billing state while sync catches up.";
  }
  if (billing.mode === "local") {
    return "Local mode is on, so uploads and API keys work without a paid plan.";
  }
  const active = billing.subscriptions.find((subscription) => subscription.status.toLowerCase() === "active");
  const renews = formatDate(active?.currentPeriodEnd);
  if (renews) return `Renews on ${renews}. You only pay for what you deliver and store.`;
  return "You only pay for what you deliver and store, with no lock-in.";
}

export default async function BillingPage({ searchParams }: BillingPageProps) {
  const access = await requireDashboardAccess("/dashboard/billing");
  const params = searchParams ? await searchParams : {};
  const billingActionError = billingActionErrorMessage(firstParam(params.billing_error));
  const billing = await billingOverview(access);
  const dashboardState = dashboardStateFromBilling(billingReadinessFromOverview(billing));
  const returnUrl = "/dashboard/billing";

  const activePlan = billing.plans.find((plan) => plan.relationshipStatus === "active");
  const currentPlanName = activePlan?.name ?? billing.currentPlanLabel;
  const credits = billing.balances.find((balance) => balance.featureId === USAGE_CREDITS_FEATURE_ID);
  const usage = groupUsage(billing.balances.filter((balance) => balance.featureId !== USAGE_CREDITS_FEATURE_ID));
  const hasBreakdown = usage.delivery.length > 0 || usage.storage.length > 0 || usage.other.length > 0;
  const healthy = billing.status === "ok";
  const statusLabel = !healthy ? "Sync issue" : billing.mode === "local" ? "Local mode" : "Active";

  return (
    <>
      <SubHeader
        title="Billing"
        docsHref="/docs#billing-usage"
        actions={
          <form action="/api/billing/portal" method="post">
            <input name="return_url" type="hidden" value={returnUrl} />
            <Button type="submit" variant="secondary" size="sm" disabled={!billing.manageBillingEnabled}>
              <Wallet className="size-4" />
              <span className="hidden sm:inline">Manage billing</span>
              <span className="sm:hidden">Manage</span>
            </Button>
          </form>
        }
      />

      <DashboardContent>
        <div className="mb-6 flex flex-col gap-3 empty:hidden">
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

        {/* Current plan */}
        <section className="animate-rise rounded-[18px] border border-line bg-card p-6 sm:p-7">
          <div className="flex flex-col gap-7 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="text-[13px] text-muted">Your plan</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <h2 className="font-head text-[clamp(26px,4vw,32px)] leading-none text-ink">{currentPlanName}</h2>
                <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
                  <span className={cn("size-1.5 rounded-full", healthy ? "bg-live" : "bg-[#c79a2e]")} />
                  {statusLabel}
                </span>
              </div>
              <p className="mt-3 max-w-[460px] text-[13.5px] leading-[1.55] text-muted">{planNote(billing)}</p>
            </div>

            {credits ? (
              <div className="rounded-2xl border border-line-soft bg-bg-sunken/40 p-5 md:w-[300px] md:shrink-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-ink">Usage credits</span>
                  <span className="font-head text-[18px] leading-none text-ink">
                    {credits.unlimited ? "Unlimited" : formatNumber(credits.remaining ?? usedValue(credits))}
                  </span>
                </div>
                <Meter balance={credits} className="mt-3.5" />
                <p className="mt-3 text-[12px] text-muted">{displayBalanceValue(credits)}</p>
              </div>
            ) : null}
          </div>
        </section>

        {/* Usage */}
        {hasBreakdown ? (
          <>
            <div className="mb-4 mt-9">
              <h2 className="font-head text-[20px] leading-none text-ink">Usage</h2>
              <p className="mt-2 text-[13px] text-muted">What you have delivered and stored this period, by resolution.</p>
            </div>
            <div className="rounded-[18px] border border-line bg-card p-6 sm:p-7">
              {usage.delivery.length > 0 || usage.storage.length > 0 ? (
                <div className="grid gap-8 sm:grid-cols-2 sm:gap-12">
                  {usage.delivery.length > 0 ? (
                    <UsageGroup title="Delivery" caption="Seconds delivered to viewers" rows={usage.delivery} />
                  ) : null}
                  {usage.storage.length > 0 ? (
                    <UsageGroup
                      title="Storage"
                      caption="Second-months kept in your library"
                      rows={usage.storage}
                      className="sm:border-l sm:border-line-soft sm:pl-12"
                    />
                  ) : null}
                </div>
              ) : null}
              {usage.other.length > 0 ? (
                <UsageGroup
                  title="Other"
                  caption="Other metered features on your plan"
                  rows={usage.other}
                  className={usage.delivery.length > 0 || usage.storage.length > 0 ? "mt-8 border-t border-line-soft pt-8" : undefined}
                />
              ) : null}
            </div>
          </>
        ) : null}

        {/* Plans */}
        <div className="mb-4 mt-9">
          <h2 className="font-head text-[20px] leading-none text-ink">Plans</h2>
          <p className="mt-2 text-[13px] text-muted">
            Start on pay as you go, or pick a plan with monthly credits included. Move between plans whenever you like, with no lock-in.
          </p>
        </div>
        {billing.plans.length === 0 ? (
          <div className="rounded-[18px] border border-line bg-card p-7 text-[13.5px] text-muted">
            No plans are available.
          </div>
        ) : (
          <BillingPlansClient
            plans={billing.plans}
            checkoutEnabled={billing.checkoutEnabled}
            returnUrl={returnUrl}
            legalAssentVersion={LEGAL_ASSENT_VERSION}
          />
        )}
      </DashboardContent>
    </>
  );
}
