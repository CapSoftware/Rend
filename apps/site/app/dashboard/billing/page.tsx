import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { BarChart3, CreditCard, Info, ListTree, Wallet } from "lucide-react";
import {
  billingFeatureIds,
  billingOverview,
  billingReadinessFromOverview,
  type BillingBalance,
  type BillingOverview,
  type BillingPaymentMethod,
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
import { getPublicPricing, type PublicPricing } from "../../../lib/pricing.ts";
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

const BILLING_OVERVIEW_CACHE_TTL_MS = 60_000;
const DELIVERY_USAGE_HELP =
  "Delivery is viewer watch time. Usage is measured precisely, then shown and billed in minutes.";
const STORAGE_USAGE_HELP =
  "Storage is video duration prorated by time stored. Sixty minutes kept for half a month counts as 30 stored minutes.";

type BillingPageProps = {
  searchParams?: Promise<{
    billing_error?: string | string[];
    range?: string | string[];
    tab?: string | string[];
  }>;
};

type BillingTab = "overview" | "usage";

type UsageRow = {
  featureId: string;
  tierLabel: string;
  kind: BillingUsageKind;
  balance: BillingBalance;
};

const BILLING_TABS: { value: BillingTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "usage", label: "Usage" },
];

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeBillingTab(value: string | string[] | undefined): BillingTab {
  const tab = firstParam(value);
  return tab === "usage" ? tab : "overview";
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

function formatUsageValue(value: number | undefined, kind: BillingUsageKind) {
  if (value === undefined || !Number.isFinite(value)) return "-";
  if (kind === "delivery") return `${formatPreciseNumber(value / 60, 2)} min`;
  if (kind === "storage") return `${formatPreciseNumber(value / 60, 2)} stored min`;
  return `${formatPreciseNumber(value, 3)} units`;
}

function formatUsageExplanation(value: number | undefined, kind: "delivery" | "storage") {
  if (value === undefined || !Number.isFinite(value)) {
    return kind === "delivery" ? DELIVERY_USAGE_HELP : STORAGE_USAGE_HELP;
  }
  if (kind === "delivery") {
    return `${DELIVERY_USAGE_HELP} This total is ${formatPreciseNumber(value / 60, 2)} delivered minutes.`;
  }
  return `${STORAGE_USAGE_HELP} This total is ${formatPreciseNumber(value / 60, 2)} stored minutes after proration.`;
}

function formatEstimatedCost(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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

function UnitInfoButton({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        className="inline-flex size-5 items-center justify-center rounded-full border border-line-soft text-faint transition-colors hover:border-line hover:text-ink focus-visible:border-ink focus-visible:text-ink focus-visible:outline-none"
      >
        <Info className="size-3" aria-hidden="true" />
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-[min(260px,calc(100vw-48px))] -translate-x-1/2 rounded-lg border border-line bg-ink px-3 py-2 text-left text-[12px] font-normal leading-[1.45] text-bg opacity-0 shadow-[0_18px_40px_-24px_rgba(22,21,19,0.55)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {children}
      </span>
    </span>
  );
}

function UsageLabel({
  children,
  info,
  infoId,
  infoLabel,
}: {
  children: ReactNode;
  info?: ReactNode;
  infoId?: string;
  infoLabel?: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span>{children}</span>
      {info && infoId ? (
        <UnitInfoButton id={infoId} label={infoLabel ?? "Explain usage"}>
          {info}
        </UnitInfoButton>
      ) : null}
    </span>
  );
}

function groupUsage(balances: BillingBalance[]) {
  const features = billingFeatureIds();
  const order: [string, "delivery" | "storage"][] = [
    [features.delivery, "delivery"],
    [features.storage, "storage"],
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
  const used = usedValue(row.balance);
  const value = formatUsageValue(used, row.kind);
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
  className,
  info,
  infoId,
}: {
  title: string;
  caption: string;
  rows: UsageRow[];
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
          <UsageRowLine key={row.featureId} row={row} />
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
  if (code === "billing_payment_setup_mode_mismatch") {
    return "Payment setup is not configured for this environment. Check the Autumn and Stripe mode, then try again.";
  }
  if (code === "billing_payment_setup_disabled") {
    return "External payment setup is disabled for this environment.";
  }
  if (code === "billing_invalid_response") {
    return "Billing returned an unexpected payment response. Check the Autumn payment configuration.";
  }
  if (code === "billing_provider_rejected_request") {
    return "Billing rejected the payment setup request. Check the billing configuration in Autumn.";
  }
  if (code === "legal_assent_required") {
    return "Review and accept the Rend Terms and Privacy Notice before adding a payment method.";
  }
  return "Payment setup could not be started. Check billing configuration and try again.";
}

function paymentMethodTitle(billing: BillingOverview) {
  if (billing.status !== "ok" || billing.paymentMethod.status === "unknown") {
    return "Payment status unavailable";
  }
  if (billing.paymentMethod.status === "not_required") return "Not required locally";
  return billing.paymentMethod.status === "on_file" ? "Card on file" : "No card on file";
}

function paymentMethodDetails(paymentMethod: BillingPaymentMethod) {
  if (paymentMethod.status !== "on_file") return null;
  const brand = paymentMethod.brand
    ? paymentMethod.brand.charAt(0).toUpperCase() + paymentMethod.brand.slice(1)
    : paymentMethod.type === "card"
      ? "Card"
      : "Payment method";
  return paymentMethod.last4 ? `${brand} ending in ${paymentMethod.last4}` : brand;
}

function paymentMethodNote(billing: BillingOverview, pricing: PublicPricing) {
  if (billing.status !== "ok") {
    return "Showing your last saved billing state while sync catches up.";
  }
  if (billing.mode === "local") {
    return "Local mode is on, so uploads and API keys work without a payment method.";
  }
  const details = paymentMethodDetails(billing.paymentMethod);
  if (details) return `${details}. You are billed only for delivered and stored minutes.`;
  return `Add a card to use Rend. There is no monthly fee. Delivery is ${pricing.delivery.priceLabel} per minute and storage is ${pricing.storage.priceLabel} per stored minute per month.`;
}

function BillingSummaryPanel({
  billing,
  usage,
  pricing,
  returnUrl,
}: {
  billing: BillingOverview;
  usage: ReturnType<typeof groupUsage>;
  pricing: PublicPricing;
  returnUrl: string;
}) {
  const deliverySeconds = usage.delivery.reduce((total, row) => total + (usedValue(row.balance) ?? 0), 0);
  const storageSecondMonths = usage.storage.reduce((total, row) => total + (usedValue(row.balance) ?? 0), 0);
  const deliveryMinutes = deliverySeconds / 60;
  const storageMinutes = storageSecondMonths / 60;
  const estimatedCost =
    deliveryMinutes * pricing.calculator.deliveryPerMinute +
    storageMinutes * pricing.calculator.storagePerMinuteMonth;
  const activeBilling = billing.subscriptions.some(
    (subscription) => subscription.status.toLowerCase() === "active"
  );
  const needsSetup =
    billing.paymentMethod.status === "missing" ||
    (billing.paymentMethod.status === "on_file" && !activeBilling);
  const setupLabel = billing.paymentMethod.status === "on_file" ? "Finish billing setup" : "Add payment method";

  return (
    <section className="animate-rise rounded-[18px] border border-line bg-card p-6 sm:p-7">
      <div className="flex flex-col gap-7 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-[13px] text-muted">Payment method</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="font-head text-[clamp(26px,4vw,32px)] leading-none text-ink">
              {paymentMethodTitle(billing)}
            </h2>
            <StatusBadge tone={billing.paymentMethod.status === "on_file" ? "success" : "neutral"}>
              Pay as you go
            </StatusBadge>
          </div>
          <p className="mt-3 max-w-[520px] text-[13.5px] leading-[1.55] text-muted">
            {paymentMethodNote(billing, pricing)}
          </p>

          {needsSetup && billing.paymentSetupEnabled ? (
            <div className="mt-5">
              <form action="/api/billing/payment-method" method="post">
                <input name="return_url" type="hidden" value={returnUrl} />
                <input name="legal_assent_version" type="hidden" value={LEGAL_ASSENT_VERSION} />
                <input name="legal_assent" type="hidden" value="accepted" />
                <Button type="submit" size="md">
                  <CreditCard className="size-4" />
                  {setupLabel}
                </Button>
              </form>
              <p className="mt-2.5 max-w-[520px] text-[11.5px] leading-[1.5] text-faint">
                By continuing you agree to the{" "}
                <Link href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  Terms
                </Link>{" "}
                and{" "}
                <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  Privacy Notice
                </Link>
                , including usage charges for delivered and stored minutes.
              </p>
            </div>
          ) : null}

          {billing.manageBillingEnabled && activeBilling ? (
            <form action="/api/billing/portal" method="post" className="mt-5">
              <input name="return_url" type="hidden" value={returnUrl} />
              <Button type="submit" variant="secondary" size="md">
                Manage payment method
              </Button>
            </form>
          ) : null}
        </div>

        <div className="rounded-2xl border border-line-soft bg-bg-sunken/40 p-5 md:w-[320px] md:shrink-0">
          <p className="text-[13px] text-muted">Estimated this cycle</p>
          <p className="mt-2 font-head text-[30px] leading-none text-ink tabular-nums">
            {formatEstimatedCost(estimatedCost)}
          </p>
          <p className="mt-3 text-[12px] leading-[1.5] text-muted">
            {formatPreciseNumber(deliveryMinutes, 2)} delivered min + {formatPreciseNumber(storageMinutes, 2)} stored min
          </p>
        </div>
      </div>
    </section>
  );
}

function OverviewTab({
  billing,
  usage,
  pricing,
  hasBreakdown,
  returnUrl,
}: {
  billing: BillingOverview;
  usage: ReturnType<typeof groupUsage>;
  pricing: PublicPricing;
  hasBreakdown: boolean;
  returnUrl: string;
}) {
  return (
    <div className="flex flex-col gap-7">
      <BillingSummaryPanel billing={billing} usage={usage} pricing={pricing} returnUrl={returnUrl} />

      {hasBreakdown ? (
        <Panel
          title="Usage at a glance"
          description="Current delivered and stored minutes reported by the billing provider."
          bodyClassName="p-6 sm:p-7"
        >
          {usage.delivery.length > 0 || usage.storage.length > 0 ? (
            <div className="grid gap-8 sm:grid-cols-2 sm:gap-12">
              {usage.delivery.length > 0 ? (
                <UsageGroup
                  title="Delivery"
                  caption="Minutes delivered to viewers"
                  rows={usage.delivery}
                  info={DELIVERY_USAGE_HELP}
                  infoId="overview-delivery-usage-info"
                />
              ) : null}
              {usage.storage.length > 0 ? (
                <UsageGroup
                  title="Storage"
                  caption="Prorated minutes kept in your library"
                  rows={usage.storage}
                  info={STORAGE_USAGE_HELP}
                  infoId="overview-storage-usage-info"
                  className="sm:border-l sm:border-line-soft sm:pl-12"
                />
              ) : null}
            </div>
          ) : null}
          {usage.other.length > 0 ? (
            <UsageGroup
              title="Other"
              caption="Other metered features on your billing account"
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

function ProviderBalanceEmptyState() {
  return (
    <div className="rounded-xl border border-line-soft bg-bg-sunken/40 p-5">
      <p className="text-[13.5px] leading-[1.55] text-ink">
        The billing provider has not returned delivery or storage usage for this account yet.
      </p>
      <p className="mt-2 text-[13px] leading-[1.55] text-muted">
        New usage appears here after the next billing sync. The detailed Rend ledger remains available below.
      </p>
    </div>
  );
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
          <p className="mt-2 text-[13px] text-muted">
            Billable aggregation rows grouped by meter, with provider balances when available.
          </p>
        </div>
        <UsageRangeLinks activeRange={range} />
      </div>

      <StatGrid>
        <Stat
          label={
            <UsageLabel
              info={formatUsageExplanation(details.totals.billableDeliverySeconds, "delivery")}
              infoId="delivery-total-info"
              infoLabel="Explain delivery usage"
            >
              Delivery
            </UsageLabel>
          }
          value={formatUsageValue(details.totals.billableDeliverySeconds, "delivery")}
          hint={details.rangeLabel}
          icon={BarChart3}
        />
        <Stat
          label={
            <UsageLabel
              info={formatUsageExplanation(details.totals.billableStorageSecondMonths, "storage")}
              infoId="storage-total-info"
              infoLabel="Explain storage usage"
            >
              Storage
            </UsageLabel>
          }
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
        description="Meter-level usage currently reported by the billing provider, when the provider exposes those balances."
        bodyClassName="p-6 sm:p-7"
      >
        {hasBreakdown ? (
          <>
            {usage.delivery.length > 0 || usage.storage.length > 0 ? (
              <div className="grid gap-8 sm:grid-cols-2 sm:gap-12">
                {usage.delivery.length > 0 ? (
                  <UsageGroup
                    title="Delivery"
                    caption="Minutes delivered this billing period"
                    rows={usage.delivery}
                    info={DELIVERY_USAGE_HELP}
                    infoId="provider-delivery-usage-info"
                  />
                ) : null}
                {usage.storage.length > 0 ? (
                  <UsageGroup
                    title="Storage"
                    caption="Prorated stored minutes this billing period"
                    rows={usage.storage}
                    info={STORAGE_USAGE_HELP}
                    infoId="provider-storage-usage-info"
                    className="sm:border-l sm:border-line-soft sm:pl-12"
                  />
                ) : null}
              </div>
            ) : null}
            {usage.other.length > 0 ? (
              <UsageGroup
                title="Other"
                caption="Other metered features on your billing account"
                rows={usage.other}
                className={usage.delivery.length > 0 || usage.storage.length > 0 ? "mt-8 border-t border-line-soft pt-8" : undefined}
              />
            ) : null}
          </>
        ) : (
          <ProviderBalanceEmptyState />
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

export default async function BillingPage({ searchParams }: BillingPageProps) {
  const access = await requireDashboardAccess("/dashboard/billing");
  const params = searchParams ? await searchParams : {};
  const activeTab = normalizeBillingTab(params.tab);
  const range = normalizeBillingUsageRange(params.range);
  const billingActionError = billingActionErrorMessage(firstParam(params.billing_error));
  const [billing, usageDetails, pricing] = await Promise.all([
    billingOverview(access, {
      cacheTtlMs: activeTab === "usage" ? BILLING_OVERVIEW_CACHE_TTL_MS : 0,
    }),
    activeTab === "usage" ? billingUsageDetails(access, range) : Promise.resolve(null),
    getPublicPricing(),
  ]);
  const dashboardState = dashboardStateFromBilling(billingReadinessFromOverview(billing));
  const returnUrl = billingTabHref(activeTab, range);

  const usage = groupUsage(billing.balances);
  const hasBreakdown = usage.delivery.length > 0 || usage.storage.length > 0 || usage.other.length > 0;

  return (
    <>
      <SubHeader title="Billing" docsHref="/docs#billing-usage" />

      <DashboardContent>
        <div className="mb-6 flex flex-col gap-3 empty:hidden">
          {billing.error ? <Callout tone="danger">{billing.error}</Callout> : null}
          {billingActionError ? <Callout tone="danger">{billingActionError}</Callout> : null}
          {dashboardState.status !== "ready_to_upload" && dashboardState.status !== "billing_required" ? (
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
            usage={usage}
            pricing={pricing}
            hasBreakdown={hasBreakdown}
            returnUrl={returnUrl}
          />
        ) : null}

        {activeTab === "usage" && usageDetails ? (
          <UsageTab details={usageDetails} usage={usage} hasBreakdown={hasBreakdown} range={range} />
        ) : null}
      </DashboardContent>
    </>
  );
}
