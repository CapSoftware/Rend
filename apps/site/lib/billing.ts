import { eq } from "drizzle-orm";
import { billingCustomers, organization } from "./db/schema.ts";
import { getSiteDb, getSitePgPool } from "./server-db.ts";
import type { DashboardAccessContext } from "./dashboard-auth.ts";

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com/v1";
const DEFAULT_AUTUMN_API_VERSION = "2.3.0";
const AUTUMN_RESPONSE_LIMIT_BYTES = 64 * 1024;

type JsonRecord = Record<string, unknown>;
type BillingMode = "local" | "autumn";
type BillingSyncStatus = "ok" | "soft_failed" | "not_configured";
export type BillingReadinessStatus =
  | "ready"
  | "billing_required"
  | "plan_limit_exceeded"
  | "billing_unavailable";

export type BillingBalance = {
  featureId: string;
  granted?: number;
  usage?: number;
  remaining?: number;
  unlimited?: boolean;
  overageAllowed?: boolean;
  nextResetAt?: string;
};

export type BillingPlan = {
  id: string;
  name: string;
  description?: string;
  priceLabel?: string;
  intervalLabel?: string;
  attachAction?: string;
  relationshipStatus?: string;
};

export type BillingSubscription = {
  planId: string;
  status: string;
  currentPeriodEnd?: string;
  canceledAt?: string;
  trialEndsAt?: string;
};

export type BillingOverview = {
  mode: BillingMode;
  customerId: string;
  status: BillingSyncStatus;
  currentPlanLabel: string;
  subscriptions: BillingSubscription[];
  balances: BillingBalance[];
  plans: BillingPlan[];
  manageBillingEnabled: boolean;
  checkoutEnabled: boolean;
  syncedAt?: string;
  error?: string;
};

export type BillingReadiness = {
  status: BillingReadinessStatus;
  code: "ready" | "billing_required" | "limit_exceeded" | "billing_unavailable";
  message: string;
  actionHref?: string;
  actionLabel?: string;
};

export class BillingError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function isProductionProfile() {
  const profile = envString("REND_ENV_PROFILE") || envString("REND_ENV") || process.env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

export function billingMode(): BillingMode {
  const configured = envString("REND_BILLING_MODE").toLowerCase();
  if (configured === "autumn" || configured === "local") return configured;
  return isProductionProfile() ? "autumn" : "local";
}

export function billingFeatureIds() {
  return {
    delivery720p: envString("REND_BILLING_FEATURE_DELIVERY_720P", "delivery_720p_seconds"),
    delivery1080p: envString("REND_BILLING_FEATURE_DELIVERY_1080P", "delivery_1080p_seconds"),
    delivery2k: envString("REND_BILLING_FEATURE_DELIVERY_2K", "delivery_2k_seconds"),
    delivery4k: envString("REND_BILLING_FEATURE_DELIVERY_4K", "delivery_4k_seconds"),
    storage720p: envString("REND_BILLING_FEATURE_STORAGE_720P", "storage_720p_second_months"),
    storage1080p: envString("REND_BILLING_FEATURE_STORAGE_1080P", "storage_1080p_second_months"),
    storage2k: envString("REND_BILLING_FEATURE_STORAGE_2K", "storage_2k_second_months"),
    storage4k: envString("REND_BILLING_FEATURE_STORAGE_4K", "storage_4k_second_months"),
  };
}

function autumnSecretKey() {
  return envString("AUTUMN_SECRET_KEY");
}

function autumnApiUrl() {
  return envString("AUTUMN_API_URL", DEFAULT_AUTUMN_API_URL).replace(/\/+$/, "");
}

function autumnApiVersion() {
  return envString("AUTUMN_API_VERSION", DEFAULT_AUTUMN_API_VERSION);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeString(value: unknown, maxLength = 256) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeTimestampFromMs(value: unknown) {
  const ms = safeNumber(value);
  if (ms === undefined || ms < 0) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isoDate(value: Date | string | null | undefined) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeUrl(value: unknown) {
  const url = safeString(value, 2048);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || (!isProductionProfile() && parsed.protocol === "http:")
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function envBoolean(name: string) {
  const value = envString(name).toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function checkoutUrlCandidate(result: unknown) {
  if (!isRecord(result)) return undefined;
  return (
    safeString(result.payment_url, 2048) ??
    safeString(result.paymentUrl, 2048) ??
    safeString(result.checkout_url, 2048) ??
    safeString(result.checkoutUrl, 2048) ??
    safeString(result.url, 2048)
  );
}

function stripeCheckoutMode(url: string) {
  const match = url.match(/\bcs_(test|live)_[A-Za-z0-9]+/);
  return match?.[1] as "test" | "live" | undefined;
}

function externalCheckoutRedirectsEnabled() {
  if (isProductionProfile()) return true;
  return envBoolean("REND_ALLOW_EXTERNAL_TEST_CHECKOUT_REDIRECT");
}

export function checkoutRedirectUrlFromAutumnResponse(result: unknown) {
  const redirectUrl = safeUrl(checkoutUrlCandidate(result));
  if (!redirectUrl) return null;

  if (!externalCheckoutRedirectsEnabled()) {
    throw new BillingError(
      502,
      "billing_checkout_disabled",
      "External checkout redirects are disabled for this environment."
    );
  }

  const url = new URL(redirectUrl);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") {
    throw new BillingError(502, "billing_invalid_response", "Billing provider returned an unexpected checkout URL");
  }

  const mode = stripeCheckoutMode(redirectUrl);
  if (isProductionProfile() && mode === "test") {
    throw new BillingError(
      502,
      "billing_checkout_mode_mismatch",
      "Billing checkout is not configured for live mode. Contact support."
    );
  }
  if (!isProductionProfile() && mode === "live" && !envBoolean("REND_ALLOW_LIVE_CHECKOUT_REDIRECT")) {
    throw new BillingError(
      502,
      "billing_checkout_mode_mismatch",
      "Live checkout redirects are disabled outside production."
    );
  }

  return redirectUrl;
}

function checkoutAttachBody(context: DashboardAccessContext, planId: string, returnUrl: string): JsonRecord {
  const body: JsonRecord = {
    customer_id: customerId(context),
    plan_id: planId,
    redirect_mode: "if_required",
    success_url: returnUrl,
    checkout_session_params: {
      cancel_url: returnUrl,
    },
  };

  if (!externalCheckoutRedirectsEnabled()) {
    body.redirect_mode = "never";
    body.no_billing_changes = true;
    body.enable_plan_immediately = true;
  }

  return body;
}

function autumnPath(path: string) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${autumnApiUrl()}${normalized}`;
}

async function readAutumnJson(response: Response) {
  const text = (await response.text()).slice(0, AUTUMN_RESPONSE_LIMIT_BYTES);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BillingError(502, "billing_invalid_response", "Billing provider returned an invalid response");
  }
}

async function autumnPost(path: string, body: JsonRecord) {
  const secretKey = autumnSecretKey();
  if (!secretKey) {
    throw new BillingError(503, "billing_not_configured", "Billing is not configured");
  }

  let response: Response;
  try {
    response = await fetch(autumnPath(path), {
      method: "POST",
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
        "x-api-version": autumnApiVersion(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new BillingError(503, "billing_unavailable", "Billing provider is unavailable");
  }

  const data = await readAutumnJson(response);
  if (!response.ok) {
    throw new BillingError(
      response.status >= 500 ? 503 : response.status,
      "billing_provider_rejected_request",
      safeString(isRecord(data) ? data.message ?? data.error : undefined, 240) || "Billing provider rejected the request"
    );
  }
  return data;
}

function customerId(context: Pick<DashboardAccessContext, "organizationId">) {
  return context.organizationId;
}

function customerName(context: Pick<DashboardAccessContext, "organizationName">) {
  return context.organizationName;
}

function customerEmail(context: Pick<DashboardAccessContext, "userEmail">) {
  return context.userEmail;
}

async function writeBillingCustomerSync(
  organizationId: string,
  input: {
    mode: BillingMode;
    customerSyncedAt?: Date;
    customerSyncError?: string | null;
    billingState?: unknown;
    billingStateSyncedAt?: Date;
    billingStateError?: string | null;
  }
) {
  await getSiteDb()
    .insert(billingCustomers)
    .values({
      organization_id: organizationId,
      autumn_customer_id: organizationId,
      billing_mode: input.mode,
      customer_synced_at: input.customerSyncedAt,
      customer_sync_error: input.customerSyncError,
      billing_state: input.billingState,
      billing_state_synced_at: input.billingStateSyncedAt,
      billing_state_error: input.billingStateError,
    })
    .onConflictDoUpdate({
      target: billingCustomers.organization_id,
      set: {
        autumn_customer_id: organizationId,
        billing_mode: input.mode,
        customer_synced_at: input.customerSyncedAt,
        customer_sync_error: input.customerSyncError,
        billing_state: input.billingState,
        billing_state_synced_at: input.billingStateSyncedAt,
        billing_state_error: input.billingStateError,
      },
    });
}

export async function ensureBillingCustomer(context: DashboardAccessContext) {
  const mode = billingMode();
  if (mode === "local") {
    await writeBillingCustomerSync(context.organizationId, {
      mode,
      customerSyncedAt: new Date(),
      customerSyncError: null,
    });
    return { mode, customerId: customerId(context) };
  }

  try {
    await autumnPost("/customers.get_or_create", {
      customer_id: customerId(context),
      name: customerName(context),
      email: customerEmail(context),
      metadata: {
        rend_organization_slug: context.organizationSlug,
      },
    });
    await writeBillingCustomerSync(context.organizationId, {
      mode,
      customerSyncedAt: new Date(),
      customerSyncError: null,
    });
    return { mode, customerId: customerId(context) };
  } catch (error) {
    await writeBillingCustomerSync(context.organizationId, {
      mode,
      customerSyncError: error instanceof Error ? error.message : "Billing customer sync failed",
    }).catch(() => undefined);
    throw error;
  }
}

export async function ensureBillingCustomerSoft(context: DashboardAccessContext) {
  try {
    await ensureBillingCustomer(context);
  } catch {
    return false;
  }
  return true;
}

function normalizeBalance(featureId: string, raw: unknown): BillingBalance | null {
  if (!isRecord(raw)) return null;
  const id =
    safeString(raw.featureId) ??
    safeString(raw.feature_id) ??
    safeString(featureId);
  if (!id) return null;
  return {
    featureId: id,
    granted: safeNumber(raw.granted),
    usage: safeNumber(raw.usage),
    remaining: safeNumber(raw.remaining),
    unlimited: raw.unlimited === true,
    overageAllowed: raw.overageAllowed === true || raw.overage_allowed === true,
    nextResetAt: safeTimestampFromMs(raw.nextResetAt ?? raw.next_reset_at),
  };
}

function normalizeBalances(value: unknown) {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([featureId, balance]) => {
    const normalized = normalizeBalance(featureId, balance);
    return normalized ? [normalized] : [];
  });
}

function normalizeSubscription(raw: unknown): BillingSubscription | null {
  if (!isRecord(raw)) return null;
  const planId = safeString(raw.planId ?? raw.plan_id);
  const status = safeString(raw.status, 80);
  if (!planId || !status) return null;
  return {
    planId,
    status,
    currentPeriodEnd: safeTimestampFromMs(raw.currentPeriodEnd ?? raw.current_period_end),
    canceledAt: safeTimestampFromMs(raw.canceledAt ?? raw.canceled_at),
    trialEndsAt: safeTimestampFromMs(raw.trialEndsAt ?? raw.trial_ends_at),
  };
}

function normalizeSubscriptions(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const subscription = normalizeSubscription(item);
        return subscription ? [subscription] : [];
      })
    : [];
}

function planPriceLabels(raw: JsonRecord) {
  const price = raw.price;
  if (!isRecord(price)) return {};
  const display = price.display;
  const primary = isRecord(display) ? safeString(display.primaryText ?? display.primary_text, 80) : undefined;
  const secondary = isRecord(display) ? safeString(display.secondaryText ?? display.secondary_text, 80) : undefined;
  return {
    priceLabel: primary,
    intervalLabel: secondary,
  };
}

function normalizePlan(raw: unknown): BillingPlan | null {
  if (!isRecord(raw)) return null;
  const id = safeString(raw.id);
  const name = safeString(raw.name);
  if (!id || !name) return null;
  const eligibility = raw.customerEligibility ?? raw.customer_eligibility;
  const price = planPriceLabels(raw);
  return {
    id,
    name,
    description: safeString(raw.description, 240),
    priceLabel: price.priceLabel,
    intervalLabel: price.intervalLabel,
    attachAction: isRecord(eligibility) ? safeString(eligibility.attachAction ?? eligibility.attach_action, 40) : undefined,
    relationshipStatus: isRecord(eligibility) ? safeString(eligibility.status, 40) : undefined,
  };
}

function normalizePlans(value: unknown) {
  const list = isRecord(value) && Array.isArray(value.list) ? value.list : Array.isArray(value) ? value : [];
  return list.flatMap((item) => {
    const plan = normalizePlan(item);
    return plan ? [plan] : [];
  });
}

async function localUsage(context: DashboardAccessContext) {
  const result = await getSitePgPool().query<{
    resolution_tier: string;
    stored_seconds: string | null;
  }>(
    `
      SELECT asset.max_resolution_tier AS resolution_tier,
             COALESCE(sum(asset.duration_ms::double precision / 1000.0), 0)::text AS stored_seconds
      FROM rend.assets asset
      WHERE asset.organization_id = $1::uuid
        AND asset.deleted_at IS NULL
        AND asset.duration_ms IS NOT NULL
        AND asset.max_resolution_tier IN ('720p', '1080p', '2k', '4k')
      GROUP BY asset.max_resolution_tier
    `,
    [context.organizationId]
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.resolution_tier, Number(row.stored_seconds ?? 0)])
  ) as Record<string, number>;
}

async function localBillingOverview(context: DashboardAccessContext): Promise<BillingOverview> {
  const usage = await localUsage(context).catch(() => ({} as Record<string, number>));
  const features = billingFeatureIds();
  await writeBillingCustomerSync(context.organizationId, {
    mode: "local",
    customerSyncedAt: new Date(),
    customerSyncError: null,
  }).catch(() => undefined);

  return {
    mode: "local",
    customerId: customerId(context),
    status: "ok",
    currentPlanLabel: "Local development",
    subscriptions: [{ planId: "local", status: "active" }],
    balances: [
      {
        featureId: features.delivery720p,
        usage: 0,
        unlimited: true,
      },
      {
        featureId: features.delivery1080p,
        usage: 0,
        unlimited: true,
      },
      {
        featureId: features.delivery2k,
        usage: 0,
        unlimited: true,
      },
      {
        featureId: features.delivery4k,
        usage: 0,
        unlimited: true,
      },
      {
        featureId: features.storage720p,
        usage: usage["720p"] ?? 0,
        unlimited: true,
      },
      {
        featureId: features.storage1080p,
        usage: usage["1080p"] ?? 0,
        unlimited: true,
      },
      {
        featureId: features.storage2k,
        usage: usage["2k"] ?? 0,
        unlimited: true,
      },
      {
        featureId: features.storage4k,
        usage: usage["4k"] ?? 0,
        unlimited: true,
      },
    ],
    plans: [
      {
        id: "local",
        name: "Local development",
        description: "Autumn is disabled for this local profile.",
        relationshipStatus: "active",
      },
    ],
    manageBillingEnabled: false,
    checkoutEnabled: false,
    syncedAt: new Date().toISOString(),
  };
}

function currentPlanLabel(subscriptions: BillingSubscription[]) {
  const active = subscriptions.find((subscription) => subscription.status === "active") ?? subscriptions[0];
  return active?.planId ?? "No active plan";
}

async function autumnBillingOverview(context: DashboardAccessContext): Promise<BillingOverview> {
  await ensureBillingCustomer(context);
  const customer = await autumnPost("/customers.get_or_create", {
    customer_id: customerId(context),
    name: customerName(context),
    email: customerEmail(context),
    expand: ["subscriptions.plan", "purchases.plan", "balances.feature"],
  });
  const plans = await autumnPost("/plans.list", {
    customer_id: customerId(context),
  }).catch(() => ({ list: [] }));

  const subscriptions = normalizeSubscriptions(isRecord(customer) ? customer.subscriptions : undefined);
  const overview: BillingOverview = {
    mode: "autumn",
    customerId: customerId(context),
    status: "ok",
    currentPlanLabel: currentPlanLabel(subscriptions),
    subscriptions,
    balances: normalizeBalances(isRecord(customer) ? customer.balances : undefined),
    plans: normalizePlans(plans),
    manageBillingEnabled: true,
    checkoutEnabled: true,
    syncedAt: new Date().toISOString(),
  };
  await writeBillingCustomerSync(context.organizationId, {
    mode: "autumn",
    customerSyncedAt: new Date(),
    customerSyncError: null,
    billingState: {
      subscriptions: overview.subscriptions,
      balances: overview.balances,
      plans: overview.plans,
    },
    billingStateSyncedAt: new Date(),
    billingStateError: null,
  }).catch(() => undefined);
  return overview;
}

async function fallbackBillingOverview(context: DashboardAccessContext, error: unknown): Promise<BillingOverview> {
  const [row] = await getSiteDb()
    .select({
      billing_state: billingCustomers.billing_state,
      billing_state_synced_at: billingCustomers.billing_state_synced_at,
      billing_state_error: billingCustomers.billing_state_error,
    })
    .from(billingCustomers)
    .where(eq(billingCustomers.organization_id, context.organizationId))
    .limit(1)
    .catch(() => []);

  const state = isRecord(row?.billing_state) ? row.billing_state : {};
  const subscriptions = normalizeSubscriptions(state.subscriptions);
  const balances = Array.isArray(state.balances)
    ? state.balances.flatMap((item) => {
        const balance = normalizeBalance("", item);
        return balance ? [balance] : [];
      })
    : [];
  const plans = normalizePlans(Array.isArray(state.plans) ? state.plans : []);
  return {
    mode: billingMode(),
    customerId: customerId(context),
    status: row?.billing_state ? "soft_failed" : "not_configured",
    currentPlanLabel: currentPlanLabel(subscriptions),
    subscriptions,
    balances,
    plans,
    manageBillingEnabled: false,
    checkoutEnabled: false,
    syncedAt: isoDate(row?.billing_state_synced_at),
    error: error instanceof Error ? error.message : row?.billing_state_error || "Billing state could not be loaded",
  };
}

export async function billingOverview(context: DashboardAccessContext): Promise<BillingOverview> {
  if (billingMode() === "local") return localBillingOverview(context);
  try {
    return await autumnBillingOverview(context);
  } catch (error) {
    await writeBillingCustomerSync(context.organizationId, {
      mode: "autumn",
      billingStateError: error instanceof Error ? error.message : "Billing state could not be loaded",
    }).catch(() => undefined);
    return fallbackBillingOverview(context, error);
  }
}

function activeBillingRelationship(overview: BillingOverview) {
  if (overview.mode === "local") return true;
  if (overview.subscriptions.some((subscription) => subscription.status.toLowerCase() === "active")) {
    return true;
  }
  return overview.plans.some((plan) => plan.relationshipStatus?.toLowerCase() === "active");
}

function exhaustedBalance(overview: BillingOverview) {
  return overview.balances.find((balance) => {
    if (balance.unlimited || balance.overageAllowed) return false;
    return balance.remaining !== undefined && balance.remaining <= 0;
  });
}

export function billingReadinessFromOverview(overview: BillingOverview): BillingReadiness {
  if (overview.mode === "local") {
    return {
      status: "ready",
      code: "ready",
      message: "Local billing is ready for uploads and API keys.",
    };
  }

  if (overview.status !== "ok") {
    return {
      status: "billing_unavailable",
      code: "billing_unavailable",
      message: overview.error || "Billing state could not be verified. Try again after billing sync recovers.",
      actionHref: "/dashboard/billing",
      actionLabel: "Review billing",
    };
  }

  if (!activeBillingRelationship(overview)) {
    return {
      status: "billing_required",
      code: "billing_required",
      message: "Choose a plan before creating API keys or uploading billable media.",
      actionHref: "/dashboard/billing",
      actionLabel: "Choose a plan",
    };
  }

  const balance = exhaustedBalance(overview);
  if (balance) {
    return {
      status: "plan_limit_exceeded",
      code: "limit_exceeded",
      message: `Plan limit exceeded for ${balance.featureId}. Update billing before uploading more media.`,
      actionHref: "/dashboard/billing",
      actionLabel: "Update billing",
    };
  }

  return {
    status: "ready",
    code: "ready",
    message: "Billing is ready. You can create API keys and upload video.",
  };
}

export async function requireBillingReady(context: DashboardAccessContext) {
  const overview = await billingOverview(context);
  const readiness = billingReadinessFromOverview(overview);
  if (readiness.status !== "ready") {
    throw new BillingError(
      readiness.status === "billing_required" ? 402 : readiness.status === "plan_limit_exceeded" ? 403 : 503,
      readiness.code,
      readiness.message
    );
  }
  return { overview, readiness };
}

function safePlanId(value: unknown) {
  const planId = safeString(value, 128);
  return planId && /^[A-Za-z0-9_.:-]+$/.test(planId) ? planId : null;
}

function safeReturnUrl(value: unknown, fallbackOrigin: string) {
  const fallback = new URL("/dashboard/billing", fallbackOrigin);
  const raw = safeString(value, 2048);
  if (!raw) return fallback.toString();
  try {
    const url = new URL(raw, fallbackOrigin);
    if (url.origin !== fallback.origin) return fallback.toString();
    return url.toString();
  } catch {
    return fallback.toString();
  }
}

export async function createCheckoutRedirect(
  context: DashboardAccessContext,
  input: { planId: unknown; returnUrl: unknown; requestUrl: string }
) {
  if (billingMode() !== "autumn") {
    throw new BillingError(400, "billing_local_mode", "Checkout is disabled in local billing mode");
  }
  const planId = safePlanId(input.planId);
  if (!planId) throw new BillingError(400, "invalid_plan", "Plan is invalid");
  await ensureBillingCustomer(context);
  const requestOrigin = new URL(input.requestUrl).origin;
  const returnUrl = safeReturnUrl(input.returnUrl, requestOrigin);
  const result = await autumnPost("/billing.attach", checkoutAttachBody(context, planId, returnUrl));
  return checkoutRedirectUrlFromAutumnResponse(result) ?? returnUrl;
}

export async function createPortalRedirect(
  context: DashboardAccessContext,
  input: { returnUrl: unknown; requestUrl: string }
) {
  if (billingMode() !== "autumn") {
    throw new BillingError(400, "billing_local_mode", "Billing portal is disabled in local billing mode");
  }
  await ensureBillingCustomer(context);
  const requestOrigin = new URL(input.requestUrl).origin;
  const returnUrl = safeReturnUrl(input.returnUrl, requestOrigin);
  const result = await autumnPost(`/customers/${encodeURIComponent(customerId(context))}/billing_portal`, {
    return_url: returnUrl,
  });
  const redirectUrl = safeUrl(isRecord(result) ? result.url : undefined);
  if (!redirectUrl) throw new BillingError(502, "billing_invalid_response", "Billing portal URL was not returned");
  return redirectUrl;
}

export function billingErrorResponse(error: unknown) {
  const billingError =
    error instanceof BillingError
      ? error
      : new BillingError(500, "billing_request_failed", "Billing request failed");
  return Response.json(
    {
      status: "error",
      error: billingError.code,
      message: billingError.message,
    },
    {
      status: billingError.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    }
  );
}
