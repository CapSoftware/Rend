/**
 * Public pricing for the dashboard, /pricing, and /api/pricing.
 *
 * Rend sends precise seconds to Autumn, while the PAYG plan prices each group
 * of 60 seconds as one customer-facing minute. That keeps tracking accurate
 * while keeping the customer-facing model in minutes.
 */

export const DELIVERY_UNIT = "per delivered minute";
export const STORAGE_UNIT = "per stored minute, per month";
export const DEFAULT_DELIVERY_PRICE_PER_MINUTE = 0.001;
export const DEFAULT_STORAGE_PRICE_PER_MINUTE_MONTH = 0.003;
export const PRICING_REVALIDATE_SECONDS = 3600;

const SECONDS_PER_MINUTE = 60;
const AUTUMN_API_URL = (process.env.AUTUMN_API_URL || "https://api.useautumn.com/v1").replace(/\/+$/, "");
const AUTUMN_API_VERSION = process.env.AUTUMN_API_VERSION || "2.3.0";
const AUTUMN_SECRET_KEY = (process.env.AUTUMN_SECRET_KEY || "").trim();
const PAYG_PLAN_ID = (process.env.REND_AUTUMN_PLAN_PAYG_ID || "pay_as_you_go").trim();
const DELIVERY_FEATURE_ID = (process.env.REND_BILLING_FEATURE_DELIVERY || "delivery_seconds").trim();
const STORAGE_FEATURE_ID = (process.env.REND_BILLING_FEATURE_STORAGE || "storage_second_months").trim();

type Json = Record<string, unknown>;

export type PublicMeterRate = {
  featureId: string;
  label: string;
  description: string;
  pricePerMinute: number;
  priceLabel: string;
  unitLabel: string;
};

export type PricePlanCard = {
  name: string;
  priceLabel: string;
  priceCaption: string;
  includedLabel: string;
};

export type PricingCalculatorModel = {
  deliveryPerMinute: number;
  storagePerMinuteMonth: number;
};

export type PublicPricing = {
  source: "autumn" | "fallback";
  delivery: PublicMeterRate;
  storage: PublicMeterRate;
  plan: PricePlanCard;
  calculator: PricingCalculatorModel;
};

function rec(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value >= 1) {
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function perMinutePrice(plan: Json, featureId: string) {
  for (const itemValue of arr(plan.items)) {
    const item = rec(itemValue);
    if (!item || (item.feature_id ?? item.featureId) !== featureId) continue;
    const price = rec(item.price);
    const amount = num(price?.amount);
    const billingUnits = num(price?.billing_units ?? price?.billingUnits);
    if (amount === undefined || billingUnits === undefined || billingUnits <= 0) return undefined;
    return (amount / billingUnits) * SECONDS_PER_MINUTE;
  }
  return undefined;
}

export function pricingFromPlan(value: unknown) {
  const root = rec(value);
  const data = rec(root?.data);
  const plan = rec(root?.plan) ?? rec(data?.plan) ?? data ?? root;
  if (!plan) return null;
  const deliveryPerMinute = perMinutePrice(plan, DELIVERY_FEATURE_ID);
  const storagePerMinuteMonth = perMinutePrice(plan, STORAGE_FEATURE_ID);
  if (deliveryPerMinute === undefined || storagePerMinuteMonth === undefined) return null;

  const name = str(plan.name, 80) ?? "Pay as you go";
  const price = rec(plan.price);
  const display = rec(price?.display);
  const monthly = num(price?.amount) ?? 0;

  return {
    deliveryPerMinute,
    storagePerMinuteMonth,
    plan: {
      name,
      priceLabel:
        str(display?.primaryText ?? display?.primary_text, 40) ?? (monthly > 0 ? formatUsd(monthly) : "$0"),
      priceCaption:
        str(display?.secondaryText ?? display?.secondary_text, 60) ??
        (monthly > 0 ? "per month" : "no monthly fee"),
      includedLabel: "Pay only for delivered and stored minutes",
    } satisfies PricePlanCard,
  };
}

async function autumnPlan(): Promise<Json | null> {
  if (!AUTUMN_SECRET_KEY) return null;
  try {
    const response = await fetch(`${AUTUMN_API_URL}/plans.get`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${AUTUMN_SECRET_KEY}`,
        "content-type": "application/json",
        "x-api-version": AUTUMN_API_VERSION,
      },
      body: JSON.stringify({ plan_id: PAYG_PLAN_ID }),
      next: { revalidate: PRICING_REVALIDATE_SECONDS, tags: ["pricing"] },
    });
    if (!response.ok) return null;
    return rec(await response.json()) ?? null;
  } catch {
    return null;
  }
}

function meterRates(deliveryPerMinute: number, storagePerMinuteMonth: number) {
  return {
    delivery: {
      featureId: DELIVERY_FEATURE_ID,
      label: "Delivery",
      description: "Viewer watch time delivered by Rend.",
      pricePerMinute: deliveryPerMinute,
      priceLabel: formatUsd(deliveryPerMinute),
      unitLabel: DELIVERY_UNIT,
    } satisfies PublicMeterRate,
    storage: {
      featureId: STORAGE_FEATURE_ID,
      label: "Storage",
      description: "Video duration kept in your library, prorated by time stored.",
      pricePerMinute: storagePerMinuteMonth,
      priceLabel: formatUsd(storagePerMinuteMonth),
      unitLabel: STORAGE_UNIT,
    } satisfies PublicMeterRate,
  };
}

export async function getPublicPricing(): Promise<PublicPricing> {
  const live = pricingFromPlan(await autumnPlan());
  const deliveryPerMinute = live?.deliveryPerMinute ?? DEFAULT_DELIVERY_PRICE_PER_MINUTE;
  const storagePerMinuteMonth = live?.storagePerMinuteMonth ?? DEFAULT_STORAGE_PRICE_PER_MINUTE_MONTH;
  const rates = meterRates(deliveryPerMinute, storagePerMinuteMonth);

  return {
    source: live ? "autumn" : "fallback",
    ...rates,
    plan:
      live?.plan ??
      ({
        name: "Pay as you go",
        priceLabel: "$0",
        priceCaption: "no monthly fee",
        includedLabel: "Pay only for delivered and stored minutes",
      } satisfies PricePlanCard),
    calculator: {
      deliveryPerMinute,
      storagePerMinuteMonth,
    },
  };
}
