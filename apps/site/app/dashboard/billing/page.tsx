import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, CreditCard, ListTree, Wallet } from "lucide-react";
import {
  billingFeatureIds,
  billingOverview,
  billingReadinessFromOverview,
  type BillingBalance,
  type BillingOverview,
} from "../../../lib/billing.ts";
import {
  BILLING_USAGE_RANGE_OPTIONS,
  billingUsageDetails,
  billingUsageFeatureInfo,
  normalizeBillingUsageRange,
  type BillingUsageDetails,
  type BillingUsageKind,
  type BillingUsageRange,
} from "../../../lib/billing-usage.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-auth-next.ts";
import { dashboardStateFromBilling } from "../../../lib/dashboard-state.ts";
import { LEGAL_ASSENT_VERSION } from "../../../lib/legal-assent-constants.ts";
import BillingPlansClient from "@/components/BillingPlansClient";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  Callout,
  DashboardContent,
  Panel,
  Stat,
  StatGrid,
  StatusBadge,
  SubHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Billing",
  robots: {
    index: false,
    follow: false,
  },
};

const USAGE_CREDITS_FEATURE_ID = (process.env.REND_BILLING_FEATURE_USAGE_CREDITS || "rend_usage_credits").trim();
const BILLING_OVERVIEW_CACHE_TTL_MS = 60_000;

type BillingPageProps = {
  searchParams?: Promise<{
    billing_error?: string | string[];
    range?: string | string[];
    tab?: string | string[];
  }>;
};

type BillingTab = "overview" | "usage" | "plans";

type UsageRow = {
  featureId: string;
  tierLabel: string;
  kind: BillingUsageKind;
  balance: BillingBalance;
};

const BILLING_TABS: { value: BillingTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "usage", label: "Usage" },
  { value: "plans", label: "Plans" },
];

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeBillingTab(value: string | string[] | undefined): BillingTab {
  const tab = firstParam(value);
  return tab === "usage" || tab === "plans" ? tab : "overview";
}

function billingTabHref(tab: BillingTab, range: BillingUsageRange) {
  if (tab === "overview") return "/dashboard/billing";
  const params = new URLSearchParams({ tab });
  if (tab === "usage") params.set("range", range);
  return `/dashboard/billing?${params.toString()}`;
}

function billingRangeHref(range: BillingUsageRange) {
  return `/dashboard/billing?${new URLSearchParams({ tab: "usage", range }).toString()}`;
}

function formatNumber(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatPreciseNumber(value: number | undefined, maximumFractionDigits = 3) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(value);
}

function formatBalanceQuantity(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  const maximumFractionDigits = Number.isInteger(value) ? 0 : Math.abs(value) < 1 ? 6 : 3;
  return formatPreciseNumber(value, maximumFractionDigits);
}

function formatUsageValue(value: number | undefined, kind: BillingUsageKind) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  if (kind === "delivery") return `${formatPreciseNumber(value, 3)} s`;
  if (kind === "storage") return `${formatPreciseNumber(value, 6)} second-mo`;
  return `${formatPreciseNumber(value, 3)} units`;
}

function formatDate(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatTimestamp(value: string | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function shortId(value: string | undefined) {
  return value ? value.slice(0, 8) : "-";
}

function balanceLabel(featureId: string) {
  return billingUsageFeatureInfo(featureId).tierLabel;
}

function groupUsage(balances: BillingBalance[]) {
  const features = billingFeatureIds();
  const order: [string, "delivery" | "storage"][] = [
    [features.delivery720p, "delivery"],
    [features.delivery1080p, "delivery"],
    [features.delivery2k, "delivery"],
    [features.delivery4k, "delivery"],
    [features.storage720p, "storage"],
    [features.storage1080p, "storage"],
    [features.storage2k, "storage"],
    [features.storage4k, "storage"],
  ];
  const byId = new Map(balances.map((balance) => [balance.featureId, balance]));
  const used = new Set<string>();
  const delivery: UsageRow[] = [];
  const storage: UsageRow[] = [];
  for (const [id, kind] of order) {
    const balance = byId.get(id);
    if (!balance) continue;
    used.add(id);
    const info = billingUsageFeatureInfo(id);
    (kind === "delivery" ? delivery : storage).push({
      featureId: id,
      tierLabel: info.tierLabel,
      kind,
      balance,
    });
  }
  const other: UsageRow[] = balances
    .filter((balance) => !used.has(balance.featureId))
    .map((balance) => {
      const info = billingUsageFeatureInfo(balance.featureId);
      return {
        featureId: balance.featureId,
        tierLabel: balanceLabel(balance.featureId),
        kind: info.kind,
        balance,
      };
    });
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
    if (balance.granted <= 0 && balance.overageAllowed) {
      const used = usedValue(balance);
      return used !== undefined && used > 0
        ? `${formatBalanceQuantity(used)} used beyond included credits`
        : "Pay-as-you-go with no included credit balance";
    }
    return `${formatBalanceQuantity(balance.remaining)} left of ${formatBalanceQuantity(balance.granted)}`;
  }
  const used = usedValue(balance);
  if (balance.unlimited) {
    return used !== undefined && used > 0 ? `${formatBalanceQuantity(used)} used` : "Unlimited";
  }
  return used === undefined ? "-" : `${formatBalanceQuantity(used)} used`;
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

function UsageRowLine({ row, exact = false }: { row: UsageRow; exact?: boolean }) {
  const { exhausted } = meterFor(row.balance);
  const used = usedValue(row.balance);
  const value = exact ? formatUsageValue(used, row.kind) : displayBalanceValue(row.balance);
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

function UsageGroup({
  title,
  caption,
  rows,
  exact = false,
  className,
  info,
  infoId,
}: {
  title: string;
  caption: string;
  rows: UsageRow[];
  exact?: boolean;
  className?: string;
  info?: ReactNode;
  infoId?: string;
}) {
  return (
    <div className={className}>
      <h3 className="font-head text-[17px] leading-none text-ink">
        <UsageLabel info={info} infoId={infoId} infoLabel={`Explain ${title} usage`}>
          {title}
        </UsageLabel>
      </h3>
      <p className="mt-1.5 text-[12.5px] text-muted">{caption}</p>
      <div className="mt-4 flex flex-col">
        {rows.map((row) => (
          <UsageRowLine key={row.featureId} row={row} exact={exact} />
        ))}
      </div>
    </div>
  );
}

function BillingTabs({ activeTab, range }: { activeTab: BillingTab; range: BillingUsageRange }) {
  return (
    <nav
      aria-label="Billing sections"
      role="tablist"
      className="mb-6 flex items-stretch gap-6 overflow-x-auto border-b border-line"
    >
      {BILLING_TABS.map((tab) => {
        const active = tab.value === activeTab;
        return (
          <Link
            key={tab.value}
            href={billingTabHref(tab.value, range)}
            role="tab"
            aria-selected={active}
            className={cn(
              "-mb-px inline-flex h-10 shrink-0 items-center whitespace-nowrap border-b-2 text-[13.5px] font-medium transition-colors focus-visible:outline-none focus-visible:text-ink",
              active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink-soft",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

function UsageRangeLinks({ activeRange }: { activeRange: BillingUsageRange }) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-line bg-bg-sunken/50 p-1">
      {BILLING_USAGE_RANGE_OPTIONS.map((option) => {
        const active = option.value === activeRange;
        return (
          <Link
            key={option.value}
            href={billingRangeHref(option.value)}
            className={cn(
              "inline-flex h-8 items-center rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
              active ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink-soft",
            )}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
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

function CurrentPlanPanel({
  billing,
  credits,
  healthy,
  statusLabel,
}: {
  billing: BillingOverview;
  credits?: BillingBalance;
  healthy: boolean;
  statusLabel: string;
}) {
  const activePlan = billing.plans.find((plan) => plan.relationshipStatus === "active");
  const currentPlanName = activePlan?.name ?? billing.currentPlanLabel;
  const creditUsed = credits ? usedValue(credits) : undefined;
  const payAsYouGoCredits = Boolean(
    credits && !credits.unlimited && credits.overageAllowed && (credits.granted ?? 0) <= 0,
  );

  return (
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
  );
}

function OverviewTab({
  billing,
  credits,
  usage,
  hasBreakdown,
  healthy,
  statusLabel,
}: {
  billing: BillingOverview;
  credits?: BillingBalance;
  usage: ReturnType<typeof groupUsage>;
  hasBreakdown: boolean;
  healthy: boolean;
  statusLabel: string;
}) {
  return (
    <div className="flex flex-col gap-7">
      <CurrentPlanPanel billing={billing} credits={credits} healthy={healthy} statusLabel={statusLabel} />

      {hasBreakdown ? (
        <Panel
          title="Usage at a glance"
          description="Current provider balances by configured resolution meter."
          bodyClassName="p-6 sm:p-7"
        >
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
        </Panel>
      ) : null}
    </div>
  );
}

function UsageStatus({ status, billable }: { status: string; billable: boolean }) {
  const normalized = status.toLowerCase();
  const tone =
    normalized === "failed"
      ? "danger"
      : normalized === "pending"
        ? "progress"
        : billable
          ? "success"
          : "neutral";
  return <StatusBadge tone={tone}>{status}</StatusBadge>;
}

function UsageTab({
  details,
  usage,
  hasBreakdown,
  range,
}: {
  details: BillingUsageDetails;
  usage: ReturnType<typeof groupUsage>;
  hasBreakdown: boolean;
  range: BillingUsageRange;
}) {
  const ledgerDescription = [
    `Grouped billing events for ${details.rangeLabel.toLowerCase()}.`,
    "Upload checks are shown separately from billable aggregation rows.",
  ].join(" ");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="font-head text-[20px] leading-none text-ink">Usage</h2>
          <p className="mt-2 text-[13px] text-muted">Billable aggregation rows and provider balances, grouped by meter.</p>
        </div>
        <UsageRangeLinks activeRange={range} />
      </div>

      <StatGrid>
        <Stat
          label="Delivery"
          value={formatUsageValue(details.totals.billableDeliverySeconds, "delivery")}
          hint={details.rangeLabel}
          icon={BarChart3}
        />
        <Stat
          label="Storage"
          value={formatUsageValue(details.totals.billableStorageSecondMonths, "storage")}
          hint={details.rangeLabel}
          icon={CreditCard}
        />
        <Stat
          label="Events"
          value={formatNumber(details.totals.billableEvents)}
          hint="Tracked rows"
          icon={ListTree}
        />
        <Stat
          label="Latest"
          value={formatTimestamp(details.totals.latestBillableAt)}
          hint="Billable event"
          icon={Wallet}
        />
      </StatGrid>

      <Panel
        title="Current billing balance"
        description="Exact usage currently reported by the billing provider for each configured meter."
        bodyClassName="p-6 sm:p-7"
      >
        {hasBreakdown ? (
          <>
            {usage.delivery.length > 0 || usage.storage.length > 0 ? (
              <div className="grid gap-8 sm:grid-cols-2 sm:gap-12">
                {usage.delivery.length > 0 ? (
                  <UsageGroup title="Delivery" caption="Seconds delivered this billing period" rows={usage.delivery} exact />
                ) : null}
                {usage.storage.length > 0 ? (
                  <UsageGroup
                    title="Storage"
                    caption="Second-months stored this billing period"
                    rows={usage.storage}
                    exact
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
                exact
                className={usage.delivery.length > 0 || usage.storage.length > 0 ? "mt-8 border-t border-line-soft pt-8" : undefined}
              />
            ) : null}
          </>
        ) : (
          <p className="py-5 text-center text-[13.5px] text-muted">No metered balances are available yet.</p>
        )}
      </Panel>

      <Panel
        title="Usage ledger"
        description={ledgerDescription}
        flush
      >
        {details.aggregates.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13.5px] text-muted">No usage events found for this range.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Meter</TH>
                <TH>Source</TH>
                <TH>Status</TH>
                <TH className="text-right">Events</TH>
                <TH className="text-right">Assets</TH>
                <TH className="text-right">Usage</TH>
                <TH>Latest</TH>
              </TR>
            </THead>
            <TBody>
              {details.aggregates.map((row) => (
                <TR key={`${row.featureId}:${row.source}:${row.status}`}>
                  <TD>
                    <div className="font-medium text-ink">{row.label}</div>
                    <div className="mt-0.5 font-mono text-[11.5px] text-faint">{row.featureId}</div>
                  </TD>
                  <TD>{row.sourceLabel}</TD>
                  <TD>
                    <UsageStatus status={row.statusLabel} billable={row.billable} />
                  </TD>
                  <TD className="text-right font-mono tabular-nums">{formatNumber(row.eventCount)}</TD>
                  <TD className="text-right font-mono tabular-nums">{formatNumber(row.assetCount)}</TD>
                  <TD className="text-right font-mono tabular-nums">{formatUsageValue(row.value, row.kind)}</TD>
                  <TD className="font-mono text-[12px] tabular-nums">{formatTimestamp(row.lastEventAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>

      <Panel title="Recent events" description={`Latest ${details.recentEvents.length || 0} rows in the selected range.`} flush>
        {details.recentEvents.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13.5px] text-muted">No recent usage rows found.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Time</TH>
                <TH>Meter</TH>
                <TH>Source</TH>
                <TH>Status</TH>
                <TH className="text-right">Usage</TH>
                <TH>Asset</TH>
              </TR>
            </THead>
            <TBody>
              {details.recentEvents.map((event) => (
                <TR key={event.id}>
                  <TD className="font-mono text-[12px] tabular-nums">{formatTimestamp(event.createdAt)}</TD>
                  <TD>
                    <div className="font-medium text-ink">{event.label}</div>
                    <div className="mt-0.5 text-[11.5px] text-faint">{event.tierLabel}</div>
                  </TD>
                  <TD>{event.sourceLabel}</TD>
                  <TD>
                    <UsageStatus status={event.statusLabel} billable={event.billable} />
                  </TD>
                  <TD className="text-right font-mono tabular-nums">{formatUsageValue(event.value, event.kind)}</TD>
                  <TD className="font-mono text-[12px] text-faint">{shortId(event.assetId)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

function PlansTab({ billing, returnUrl }: { billing: BillingOverview; returnUrl: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
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
    </div>
  );
}

export default async function BillingPage({ searchParams }: BillingPageProps) {
  const access = await requireDashboardAccess("/dashboard/billing");
  const params = searchParams ? await searchParams : {};
  const activeTab = normalizeBillingTab(params.tab);
  const range = normalizeBillingUsageRange(params.range);
  const billingActionError = billingActionErrorMessage(firstParam(params.billing_error));
  const [billing, usageDetails] = await Promise.all([
    billingOverview(access, {
      cacheTtlMs: activeTab === "usage" ? BILLING_OVERVIEW_CACHE_TTL_MS : 0,
    }),
    activeTab === "usage" ? billingUsageDetails(access, range) : Promise.resolve(null),
  ]);
  const dashboardState = dashboardStateFromBilling(billingReadinessFromOverview(billing));
  const returnUrl = billingTabHref(activeTab, range);

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

        <BillingTabs activeTab={activeTab} range={range} />

        {activeTab === "overview" ? (
          <OverviewTab
            billing={billing}
            credits={credits}
            usage={usage}
            hasBreakdown={hasBreakdown}
            healthy={healthy}
            statusLabel={statusLabel}
          />
        ) : null}

        {activeTab === "usage" && usageDetails ? (
          <UsageTab details={usageDetails} usage={usage} hasBreakdown={hasBreakdown} range={range} />
        ) : null}

        {activeTab === "plans" ? <PlansTab billing={billing} returnUrl={returnUrl} /> : null}
      </DashboardContent>
    </>
  );
}
