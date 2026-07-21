import { eq } from "drizzle-orm";
import { authEmailSummary, authSubjectId, logAuthEvent } from "./auth-events.ts";
import { billingCustomers, organization } from "./db/schema.ts";
import { getSiteDb, getSitePgPool } from "./server-db.ts";
import type { DashboardAccessContext } from "./dashboard-auth.ts";

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com/v1";
const DEFAULT_AUTUMN_API_VERSION = "2.3.0";
const DEFAULT_PAYG_PLAN_ID = "pay_as_you_go";
const AUTUMN_RESPONSE_LIMIT_BYTES = 64 * 1024;
// Hosted payment redirects leave a POST route; 303 makes the browser load Stripe with GET.
export const BILLING_REDIRECT_STATUS = 303;

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

export type BillingPaymentMethod = {
  status: "on_file" | "missing" | "not_required" | "unknown";
  type?: string;
  brand?: string;
  last4?: string;
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
  paymentMethod: BillingPaymentMethod;
  subscriptions: BillingSubscription[];
  balances: BillingBalance[];
  manageBillingEnabled: boolean;
  paymentSetupEnabled: boolean;
  syncedAt?: string;
  error?: string;
};

export type BillingOverviewOptions = {
  cacheTtlMs?: number;
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
    delivery: envString("REND_BILLING_FEATURE_DELIVERY", "delivery_seconds"),
    storage: envString("REND_BILLING_FEATURE_STORAGE", "storage_second_months"),
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

function paymentRedirectCandidate(result: unknown) {
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

function externalPaymentRedirectsEnabled() {
  if (isProductionProfile()) return true;
  return envBoolean("REND_ALLOW_EXTERNAL_TEST_CHECKOUT_REDIRECT");
}

export function paymentRedirectUrlFromAutumnResponse(result: unknown) {
  const redirectUrl = safeUrl(paymentRedirectCandidate(result));
  if (!redirectUrl) return null;

  if (!externalPaymentRedirectsEnabled()) {
    throw new BillingError(
      502,
      "billing_payment_setup_disabled",
      "External payment setup is disabled for this environment."
    );
  }

  const url = new URL(redirectUrl);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") {
    throw new BillingError(502, "billing_invalid_response", "Billing provider returned an unexpected payment URL");
  }

  const mode = stripeCheckoutMode(redirectUrl);
  if (isProductionProfile() && mode === "test") {
    throw new BillingError(
      502,
      "billing_payment_setup_mode_mismatch",
      "Payment setup is not configured for live mode. Contact support."
    );
  }
  if (!isProductionProfile() && mode === "live" && !envBoolean("REND_ALLOW_LIVE_CHECKOUT_REDIRECT")) {
    throw new BillingError(
      502,
      "billing_payment_setup_mode_mismatch",
      "Live payment redirects are disabled outside production."
    );
  }

  return redirectUrl;
}

function paygPlanId() {
  return envString("REND_AUTUMN_PLAN_PAYG_ID", DEFAULT_PAYG_PLAN_ID);
}

export function paymentSetupBody(
  context: DashboardAccessContext,
  returnUrl: string,
  attachPayg = true
): JsonRecord {
  return {
    customer_id: customerId(context),
    success_url: returnUrl,
    ...(attachPayg ? { plan_id: paygPlanId() } : {}),
  };
}

export function automaticPaygAttachBody(context: DashboardAccessContext, returnUrl: string): JsonRecord {
  const body: JsonRecord = {
    customer_id: customerId(context),
    plan_id: paygPlanId(),
    redirect_mode: "if_required",
    success_url: returnUrl,
    checkout_session_params: {
      cancel_url: returnUrl,
    },
  };

  if (!externalPaymentRedirectsEnabled()) {
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

function autumnCustomerSyncBody(context: DashboardAccessContext, expand?: string[]) {
  const body: JsonRecord = {
    customer_id: customerId(context),
    name: customerName(context),
    email: customerEmail(context),
    metadata: {
      rend_organization_slug: context.organizationSlug,
    },
  };
  if (expand?.length) body.expand = expand;
  return body;
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

  logAuthEvent("autumn_customer_sync_started", {
    ...authEmailSummary(context.userEmail),
    organization_id_hash: authSubjectId(context.organizationId),
    billing_mode: mode,
  });

  try {
    await autumnPost("/customers.get_or_create", autumnCustomerSyncBody(context));
    await writeBillingCustomerSync(context.organizationId, {
      mode,
      customerSyncedAt: new Date(),
      customerSyncError: null,
    });
    logAuthEvent("autumn_customer_sync_completed", {
      ...authEmailSummary(context.userEmail),
      organization_id_hash: authSubjectId(context.organizationId),
      billing_mode: mode,
    });
    return { mode, customerId: customerId(context) };
  } catch (error) {
    await writeBillingCustomerSync(context.organizationId, {
      mode,
      customerSyncError: error instanceof Error ? error.message : "Billing customer sync failed",
    }).catch(() => undefined);
    logAuthEvent(
      "autumn_customer_sync_failed",
      {
        ...authEmailSummary(context.userEmail),
        organization_id_hash: authSubjectId(context.organizationId),
        billing_mode: mode,
        error: error instanceof Error ? error.message : String(error),
      },
      "error"
    );
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

export function normalizeBillingPaymentMethod(value: unknown): BillingPaymentMethod {
  if (value === null || value === undefined) return { status: "missing" };
  if (!isRecord(value)) return { status: "unknown" };
  if (Object.keys(value).length === 0) return { status: "missing" };

  const card = isRecord(value.card) ? value.card : value;
  return {
    status: "on_file",
    type: safeString(value.type, 40),
    brand: safeString(card.display_brand ?? card.displayBrand ?? card.brand, 40),
    last4: safeString(card.last4 ?? card.last_four ?? card.lastFour, 4),
  };
}

async function localUsage(context: DashboardAccessContext) {
  const result = await getSitePgPool().query<{ stored_seconds: string | null }>(
    `
      SELECT COALESCE(sum(asset.duration_ms::double precision / 1000.0), 0)::text AS stored_seconds
      FROM rend.assets asset
      WHERE asset.organization_id = $1::uuid
        AND asset.deleted_at IS NULL
        AND asset.duration_ms IS NOT NULL
    `,
    [context.organizationId]
  );
  return Number(result.rows[0]?.stored_seconds ?? 0);
}

async function localBillingOverview(context: DashboardAccessContext): Promise<BillingOverview> {
  const storedSeconds = await localUsage(context).catch(() => 0);
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
    paymentMethod: { status: "not_required" },
    subscriptions: [{ planId: "local", status: "active" }],
    balances: [
      {
        featureId: features.delivery,
        usage: 0,
        unlimited: true,
      },
      {
        featureId: features.storage,
        usage: storedSeconds,
        unlimited: true,
      },
    ],
    manageBillingEnabled: false,
    paymentSetupEnabled: false,
    syncedAt: new Date().toISOString(),
  };
}

type StoredBillingStateRow = {
  billing_state: unknown;
  billing_state_synced_at: Date | string | null;
  billing_state_error: string | null;
};

function billingOverviewFromStoredState(
  context: DashboardAccessContext,
  row: StoredBillingStateRow,
  status: BillingSyncStatus,
  error?: unknown
): BillingOverview {
  const state = isRecord(row.billing_state) ? row.billing_state : {};
  const subscriptions = normalizeSubscriptions(state.subscriptions);
  const balances = Array.isArray(state.balances)
    ? state.balances.flatMap((item) => {
        const balance = normalizeBalance("", item);
        return balance ? [balance] : [];
      })
    : [];
  const mode = billingMode();
  const paymentMethod = Object.hasOwn(state, "paymentMethod")
    ? normalizeBillingPaymentMethod(state.paymentMethod)
    : { status: "unknown" as const };
  return {
    mode,
    customerId: customerId(context),
    status,
    paymentMethod,
    subscriptions,
    balances,
    manageBillingEnabled: status === "ok" && mode === "autumn" && paymentMethod.status === "on_file",
    paymentSetupEnabled: status === "ok" && mode === "autumn",
    syncedAt: isoDate(row.billing_state_synced_at),
    error:
      error instanceof Error
        ? error.message
        : status === "ok"
          ? undefined
          : row.billing_state_error || "Billing state could not be loaded",
  };
}

async function storedBillingStateRow(context: DashboardAccessContext) {
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
  return row ?? null;
}

async function cachedBillingOverview(context: DashboardAccessContext, cacheTtlMs: number) {
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) return null;
  const row = await storedBillingStateRow(context);
  if (!row?.billing_state || !row.billing_state_synced_at) return null;
  const syncedAt = new Date(row.billing_state_synced_at);
  if (Number.isNaN(syncedAt.getTime())) return null;
  if (Date.now() - syncedAt.getTime() > cacheTtlMs) return null;
  return billingOverviewFromStoredState(context, row, "ok");
}

async function autumnBillingOverview(context: DashboardAccessContext): Promise<BillingOverview> {
  logAuthEvent("autumn_customer_sync_started", {
    ...authEmailSummary(context.userEmail),
    organization_id_hash: authSubjectId(context.organizationId),
    billing_mode: "autumn",
  });

  let customer: unknown;
  try {
    customer = await autumnPost(
      "/customers.get_or_create",
      autumnCustomerSyncBody(context, [
        "payment_method",
        "subscriptions.plan",
        "purchases.plan",
        "balances.feature",
      ])
    );
  } catch (error) {
    await writeBillingCustomerSync(context.organizationId, {
      mode: "autumn",
      customerSyncError: error instanceof Error ? error.message : "Billing customer sync failed",
    }).catch(() => undefined);
    logAuthEvent(
      "autumn_customer_sync_failed",
      {
        ...authEmailSummary(context.userEmail),
        organization_id_hash: authSubjectId(context.organizationId),
        billing_mode: "autumn",
        error: error instanceof Error ? error.message : String(error),
      },
      "error"
    );
    throw error;
  }

  const subscriptions = normalizeSubscriptions(isRecord(customer) ? customer.subscriptions : undefined);
  const paymentMethod = normalizeBillingPaymentMethod(
    isRecord(customer) ? customer.paymentMethod ?? customer.payment_method : undefined
  );
  const overview: BillingOverview = {
    mode: "autumn",
    customerId: customerId(context),
    status: "ok",
    paymentMethod,
    subscriptions,
    balances: normalizeBalances(isRecord(customer) ? customer.balances : undefined),
    manageBillingEnabled: paymentMethod.status === "on_file",
    paymentSetupEnabled: true,
    syncedAt: new Date().toISOString(),
  };
  await writeBillingCustomerSync(context.organizationId, {
    mode: "autumn",
    customerSyncedAt: new Date(),
    customerSyncError: null,
    billingState: {
      subscriptions: overview.subscriptions,
      balances: overview.balances,
      paymentMethod: overview.paymentMethod,
    },
    billingStateSyncedAt: new Date(),
    billingStateError: null,
  }).catch(() => undefined);
  logAuthEvent("autumn_customer_sync_completed", {
    ...authEmailSummary(context.userEmail),
    organization_id_hash: authSubjectId(context.organizationId),
    billing_mode: "autumn",
  });
  return overview;
}

async function fallbackBillingOverview(context: DashboardAccessContext, error: unknown): Promise<BillingOverview> {
  const row = await storedBillingStateRow(context);
  if (row?.billing_state) {
    return billingOverviewFromStoredState(context, row, "soft_failed", error);
  }
  return {
    mode: billingMode(),
    customerId: customerId(context),
    status: "not_configured",
    paymentMethod: { status: "unknown" },
    subscriptions: [],
    balances: [],
    manageBillingEnabled: false,
    paymentSetupEnabled: false,
    error: error instanceof Error ? error.message : "Billing state could not be loaded",
  };
}

export async function billingOverview(
  context: DashboardAccessContext,
  options: BillingOverviewOptions = {}
): Promise<BillingOverview> {
  if (billingMode() === "local") return localBillingOverview(context);
  const cached = await cachedBillingOverview(context, options.cacheTtlMs ?? 0);
  if (cached) return cached;
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
  return overview.subscriptions.some((subscription) => subscription.status.toLowerCase() === "active");
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

  if (overview.paymentMethod.status === "unknown") {
    return {
      status: "billing_unavailable",
      code: "billing_unavailable",
      message: "Payment status could not be verified. Try again after billing sync recovers.",
      actionHref: "/dashboard/billing",
      actionLabel: "Review billing",
    };
  }

  if (overview.paymentMethod.status === "missing") {
    return {
      status: "billing_required",
      code: "billing_required",
      message: "Add a payment method before creating API keys or uploading billable media.",
      actionHref: "/dashboard/billing",
      actionLabel: "Add payment method",
    };
  }

  if (!activeBillingRelationship(overview)) {
    return {
      status: "billing_required",
      code: "billing_required",
      message: "Your payment method is saved, but pay-as-you-go billing is not active yet.",
      actionHref: "/dashboard/billing",
      actionLabel: "Finish billing setup",
    };
  }

  const balance = exhaustedBalance(overview);
  if (balance) {
    return {
      status: "plan_limit_exceeded",
      code: "limit_exceeded",
      message: `Billing limit reached for ${balance.featureId}. Update billing before uploading more media.`,
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

export async function createPaymentMethodRedirect(
  context: DashboardAccessContext,
  input: { returnUrl: unknown; requestUrl: string }
) {
  if (billingMode() !== "autumn") {
    throw new BillingError(400, "billing_local_mode", "Payment setup is disabled in local billing mode");
  }
  const requestOrigin = new URL(input.requestUrl).origin;
  const returnUrl = safeReturnUrl(input.returnUrl, requestOrigin);
  const overview = await billingOverview(context);
  if (overview.status !== "ok") {
    throw new BillingError(503, "billing_unavailable", "Billing state could not be verified");
  }

  const hasActiveBilling = activeBillingRelationship(overview);
  if (overview.paymentMethod.status === "on_file") {
    if (hasActiveBilling) return returnUrl;
    const result = await autumnPost("/billing.attach", automaticPaygAttachBody(context, returnUrl));
    return paymentRedirectUrlFromAutumnResponse(result) ?? returnUrl;
  }

  const result = await autumnPost(
    "/billing.setup_payment",
    paymentSetupBody(context, returnUrl, !hasActiveBilling)
  );
  const redirectUrl = paymentRedirectUrlFromAutumnResponse(result);
  if (!redirectUrl) {
    throw new BillingError(502, "billing_invalid_response", "Billing provider did not return a payment URL");
  }
  return redirectUrl;
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
