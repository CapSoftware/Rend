/**
 * Pricing data for the /pricing page, the cost calculator, and /api/pricing.
 *
 * The real numbers live in Autumn. Rend bills a single credit system,
 * `rend_usage_credits`, at a price per credit (currently $1). Delivery and
 * storage are metered features, and the credit system's credit_schema says how
 * many credits each one costs per unit, by resolution. So the true dollar rate
 * for a resolution is credit_cost * credit_price.
 *
 * getPublicPricing() reads the Autumn plan catalogue and feature schema, turns
 * the per-second credit costs into per-hour dollar rates (numeric, for the
 * calculator, and formatted, for the table), and builds the public plan cards
 * (skipping internal and archived plans). It is cached hourly and falls back to
 * the last-known real numbers if Autumn is unreachable, so the page and the
 * calculator always work and we never show an invented number.
 */

export const DELIVERY_UNIT = "per hour streamed";
export const STORAGE_UNIT = "per stored hour, per month";

export const PRICING_REVALIDATE_SECONDS = 3600;

const SECONDS_PER_HOUR = 3600;

const AUTUMN_API_URL = (process.env.AUTUMN_API_URL || "https://api.useautumn.com/v1").replace(/\/+$/, "");
const AUTUMN_API_VERSION = process.env.AUTUMN_API_VERSION || "2.3.0";
const AUTUMN_SECRET_KEY = (process.env.AUTUMN_SECRET_KEY || "").trim();
const CREDIT_FEATURE_ID = (process.env.REND_BILLING_FEATURE_USAGE_CREDITS || "rend_usage_credits").trim();

function featureId(envName: string, fallback: string) {
  return (process.env[envName] || fallback).trim();
}

/** The four resolution tiers, their feature ids, and last-known per-hour rates. */
const RESOLUTIONS = [
  {
    label: "720p",
    blurb: "Standard web playback",
    delivery: featureId("REND_BILLING_FEATURE_DELIVERY_720P", "delivery_720p_seconds"),
    storage: featureId("REND_BILLING_FEATURE_STORAGE_720P", "storage_720p_second_months"),
    fallbackDelivery: 0.048,
    fallbackStorage: 0.144,
  },
  {
    label: "1080p",
    blurb: "Sharp on most screens",
    delivery: featureId("REND_BILLING_FEATURE_DELIVERY_1080P", "delivery_1080p_seconds"),
    storage: featureId("REND_BILLING_FEATURE_STORAGE_1080P", "storage_1080p_second_months"),
    fallbackDelivery: 0.06,
    fallbackStorage: 0.18,
  },
  {
    label: "2K",
    blurb: "Crisp on large displays",
    delivery: featureId("REND_BILLING_FEATURE_DELIVERY_2K", "delivery_2k_seconds"),
    storage: featureId("REND_BILLING_FEATURE_STORAGE_2K", "storage_2k_second_months"),
    fallbackDelivery: 0.096,
    fallbackStorage: 0.288,
  },
  {
    label: "4K",
    blurb: "Maximum detail",
    delivery: featureId("REND_BILLING_FEATURE_DELIVERY_4K", "delivery_4k_seconds"),
    storage: featureId("REND_BILLING_FEATURE_STORAGE_4K", "storage_4k_second_months"),
    fallbackDelivery: 0.192,
    fallbackStorage: 0.576,
  },
] as const;

/** Last-known real plan numbers, used only when Autumn is unreachable. */
const FALLBACK_PLAN_RATES: PricingPlanRate[] = [
  { name: "Pay as you go", monthly: 0, includedCredits: 0 },
  { name: "Builder", monthly: 19, includedCredits: 100, highlighted: true },
  { name: "Scale", monthly: 450, includedCredits: 1000 },
  { name: "Enterprise", monthly: 4500, includedCredits: 10000 },
];

export type PriceResolutionRow = {
  label: string;
  blurb: string;
  delivery: string;
  storage: string;
};

export type PricePlanCard = {
  name: string;
  priceLabel: string;
  priceCaption: string;
  includedLabel: string;
  highlighted?: boolean;
};

/** Numeric model the interactive calculator computes against. */
export type PricingPlanRate = {
  name: string;
  /** Monthly plan fee in dollars (0 for pay as you go). */
  monthly: number;
  /** Dollar value of credits included each month. */
  includedCredits: number;
  highlighted?: boolean;
};

export type PricingCalculatorModel = {
  resolutions: { label: string; deliveryPerHour: number; storagePerHourMonth: number }[];
  plans: PricingPlanRate[];
};

export type PublicPricing = {
  /** "autumn" when live data was read, "fallback" otherwise. */
  source: "autumn" | "fallback";
  /** Explanatory line about the credit price, when known. */
  creditNote: string | null;
  resolution: PriceResolutionRow[];
  plans: PricePlanCard[];
  calculator: PricingCalculatorModel;
};

type Json = Record<string, unknown>;

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

/** Format a dollar amount, trimming trailing zeros but keeping it readable. */
export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n >= 1) {
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }
  const trimmed = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${trimmed}`;
}

async function autumnPost(path: string, body: Json): Promise<Json | null> {
  if (!AUTUMN_SECRET_KEY) return null;
  try {
    const response = await fetch(`${AUTUMN_API_URL}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${AUTUMN_SECRET_KEY}`,
        "content-type": "application/json",
        "x-api-version": AUTUMN_API_VERSION,
      },
      body: JSON.stringify(body),
      next: { revalidate: PRICING_REVALIDATE_SECONDS, tags: ["pricing"] },
    });
    if (!response.ok) return null;
    return rec(await response.json()) ?? null;
  } catch {
    return null;
  }
}

/** Dollars per credit, read from the credit system's usage price on any plan. */
function creditPriceFromPlans(plans: unknown[]): number | undefined {
  for (const planValue of plans) {
    const plan = rec(planValue);
    for (const itemValue of arr(plan?.items)) {
      const item = rec(itemValue);
      if (!item || (item.feature_id ?? item.featureId) !== CREDIT_FEATURE_ID) continue;
      const price = rec(item.price);
      const amount = num(price?.amount);
      const units = num(price?.billing_units ?? price?.billingUnits) ?? 1;
      if (amount !== undefined && units > 0) return amount / units;
    }
  }
  return undefined;
}

/** Map of metered feature id -> credits charged per unit. */
function creditSchemaFromFeatures(features: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  const credits = features.map(rec).find((f) => f?.id === CREDIT_FEATURE_ID);
  for (const entryValue of arr(credits?.credit_schema ?? credits?.creditSchema)) {
    const entry = rec(entryValue);
    const fid = str(entry?.metered_feature_id ?? entry?.meteredFeatureId, 120);
    const cost = num(entry?.credit_cost ?? entry?.creditCost);
    if (fid && cost !== undefined) map.set(fid, cost);
  }
  return map;
}

function isPublicPlan(plan: Json): boolean {
  if (plan.archived === true || plan.add_on === true) return false;
  const id = `${str(plan.id) ?? ""} ${str(plan.name) ?? ""}`.toLowerCase();
  return !/internal|dry.?run|\btest\b|sandbox/.test(id);
}

function includedCreditValue(plan: Json, creditPrice: number): number {
  for (const itemValue of arr(plan.items)) {
    const item = rec(itemValue);
    if (item && (item.feature_id ?? item.featureId) === CREDIT_FEATURE_ID) {
      const included = num(item.included);
      if (included !== undefined) return included * creditPrice;
    }
  }
  return 0;
}

function publicPlans(plansData: Json | null, creditPrice: number | undefined) {
  const plans = arr(plansData?.list)
    .map(rec)
    .filter((p): p is Json => Boolean(p) && isPublicPlan(p as Json))
    .sort((a, b) => (num(rec(a.price)?.amount) ?? 0) - (num(rec(b.price)?.amount) ?? 0));

  if (plans.length === 0 || creditPrice === undefined) {
    return {
      cards: FALLBACK_PLAN_RATES.map(fallbackCard),
      rates: FALLBACK_PLAN_RATES,
    };
  }

  const cards: PricePlanCard[] = [];
  const rates: PricingPlanRate[] = [];
  for (const plan of plans) {
    const name = str(plan.name, 80);
    if (!name) continue;
    const price = rec(plan.price);
    const display = rec(price?.display);
    const monthly = num(price?.amount) ?? 0;
    const included = includedCreditValue(plan, creditPrice);
    const highlighted = /builder/i.test(name);
    const priceLabel = str(display?.primaryText ?? display?.primary_text, 40) ?? (monthly > 0 ? formatUsd(monthly) : "$0");
    const priceCaption = str(display?.secondaryText ?? display?.secondary_text, 60) ?? (monthly > 0 ? "per month" : "no monthly fee");
    const includedLabel = included > 0 ? `${formatUsd(included)} in monthly credits` : "Pay only for what you use";
    cards.push({ name, priceLabel, priceCaption, includedLabel, highlighted });
    rates.push({ name, monthly, includedCredits: included, highlighted });
  }
  return { cards, rates };
}

function fallbackCard(rate: PricingPlanRate): PricePlanCard {
  return {
    name: rate.name,
    priceLabel: rate.monthly > 0 ? formatUsd(rate.monthly) : "$0",
    priceCaption: rate.monthly > 0 ? "per month" : "no monthly fee",
    includedLabel: rate.includedCredits > 0 ? `${formatUsd(rate.includedCredits)} in monthly credits` : "Pay only for what you use",
    highlighted: rate.highlighted,
  };
}

export async function getPublicPricing(): Promise<PublicPricing> {
  const [plansData, featuresData] = await Promise.all([
    autumnPost("/plans.list", {}),
    autumnPost("/features.list", {}),
  ]);

  const reachedAutumn = Boolean(plansData || featuresData);
  const creditPrice = creditPriceFromPlans(arr(plansData?.list));
  const creditCosts = creditSchemaFromFeatures(arr(featuresData?.list));

  const liveRate = (fid: string): number | undefined => {
    const cost = creditCosts.get(fid);
    if (cost === undefined || creditPrice === undefined) return undefined;
    return cost * creditPrice * SECONDS_PER_HOUR;
  };

  const resolutionNumbers = RESOLUTIONS.map((r) => ({
    label: r.label,
    blurb: r.blurb,
    deliveryPerHour: liveRate(r.delivery) ?? r.fallbackDelivery,
    storagePerHourMonth: liveRate(r.storage) ?? r.fallbackStorage,
  }));

  const { cards, rates } = publicPlans(plansData, creditPrice);

  const resolution: PriceResolutionRow[] = resolutionNumbers.map((r) => ({
    label: r.label,
    blurb: r.blurb,
    delivery: formatUsd(r.deliveryPerHour),
    storage: formatUsd(r.storagePerHourMonth),
  }));

  const usedLiveRates = RESOLUTIONS.some((r) => liveRate(r.delivery) !== undefined);
  const source: PublicPricing["source"] = reachedAutumn && (usedLiveRates || rates !== FALLBACK_PLAN_RATES) ? "autumn" : "fallback";

  const creditNote =
    creditPrice !== undefined
      ? `Usage is metered by the second and billed in credits at ${formatUsd(creditPrice)} each. The rates above show that as dollars per hour of video.`
      : null;

  return {
    source,
    creditNote,
    resolution,
    plans: cards,
    calculator: {
      resolutions: resolutionNumbers.map((r) => ({
        label: r.label,
        deliveryPerHour: r.deliveryPerHour,
        storagePerHourMonth: r.storagePerHourMonth,
      })),
      plans: rates,
    },
  };
}
