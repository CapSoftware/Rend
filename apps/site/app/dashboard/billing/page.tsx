import type { Metadata } from "next";
import Link from "next/link";
import {
  billingFeatureIds,
  billingOverview,
  billingReadinessFromOverview,
  type BillingBalance,
} from "../../../lib/billing.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-auth-next.ts";
import { dashboardStateFromBilling } from "../../../lib/dashboard-state.ts";

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
    <div className="app-shell">
      <header className="app-topbar">
        <a href="/" aria-label="Rend home">
          <img src="/rend-logo.svg" alt="Rend" className="app-logo" />
        </a>
        <nav>
          <Link href="/dashboard/assets">Assets</Link>
          <Link href="/dashboard/api-keys">API keys</Link>
          <Link href="/dashboard/billing">Billing</Link>
        </nav>
      </header>

      <main className="app-main">
        <section className="app-page-head">
          <div>
            <p className="app-kicker">Rend app</p>
            <h1>Billing</h1>
          </div>
          <form action="/api/billing/portal" method="post">
            <input name="return_url" type="hidden" value={returnUrl} />
            <button disabled={!billing.manageBillingEnabled} type="submit">
              Manage billing
            </button>
          </form>
        </section>

        {billing.error ? (
          <section className="app-callout app-callout-error">
            <span>{billing.error}</span>
          </section>
        ) : null}

        {billingActionError ? (
          <section className="app-callout app-callout-error">
            <span>{billingActionError}</span>
          </section>
        ) : null}

        <section
          className={`app-callout ${
            dashboardState.status === "ready_to_upload" ? "app-callout-done" : "app-callout-error"
          }`}
        >
          <div>
            <strong>{dashboardState.title}</strong>
            <span>{dashboardState.message}</span>
          </div>
        </section>

        <section className="app-panel">
          <div className="app-panel-title-row">
            <div>
              <h2>Plan</h2>
              <p className="app-muted app-mono">{billing.customerId}</p>
            </div>
            <span className={`app-pill app-state-${billing.status === "ok" ? "ready" : "failed"}`}>
              {billing.mode}
            </span>
          </div>

          <dl className="app-stats">
            <div>
              <dt>Current plan</dt>
              <dd>{billing.currentPlanLabel}</dd>
            </div>
            <div>
              <dt>Billing sync</dt>
              <dd>{billing.status}</dd>
            </div>
            <div>
              <dt>Last sync</dt>
              <dd>{formatTimestamp(billing.syncedAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="app-panel">
          <div className="app-panel-title-row">
            <h2>Usage</h2>
          </div>
          {billing.balances.length === 0 ? (
            <div className="app-empty">No billing balances are available.</div>
          ) : (
            <div className="app-table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>Balance</th>
                    <th>Usage</th>
                    <th>Reset</th>
                  </tr>
                </thead>
                <tbody>
                  {billing.balances.map((balance) => (
                    <tr key={balance.featureId}>
                      <td>{balanceLabel(balance.featureId)}</td>
                      <td>{displayBalanceValue(balance)}</td>
                      <td>{formatNumber(balance.usage)}</td>
                      <td>{formatTimestamp(balance.nextResetAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="app-panel">
          <div className="app-panel-title-row">
            <h2>Plans</h2>
          </div>
          {billing.plans.length === 0 ? (
            <div className="app-empty">No plans are available.</div>
          ) : (
            <div className="app-plan-grid">
              {billing.plans.map((plan) => (
                <article className="app-plan-card" key={plan.id}>
                  <div>
                    <h3>{plan.name}</h3>
                    {plan.description ? <p className="app-muted">{plan.description}</p> : null}
                  </div>
                  <div className="app-plan-price">
                    <strong>{plan.priceLabel ?? plan.id}</strong>
                    {plan.intervalLabel ? <span>{plan.intervalLabel}</span> : null}
                  </div>
                  <form action="/api/billing/checkout" method="post">
                    <input name="plan_id" type="hidden" value={plan.id} />
                    <input name="return_url" type="hidden" value={returnUrl} />
                    <button
                      disabled={
                        !billing.checkoutEnabled ||
                        plan.attachAction === "none" ||
                        plan.relationshipStatus === "active"
                      }
                      type="submit"
                    >
                      {plan.relationshipStatus === "active" ? "Current plan" : plan.attachAction ?? "Choose plan"}
                    </button>
                  </form>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
