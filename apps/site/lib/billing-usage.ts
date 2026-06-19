import { billingFeatureIds } from "./billing.ts";
import type { DashboardAccessContext } from "./dashboard-auth.ts";
import { getSitePgPool } from "./server-db.ts";

export type BillingUsageRange = "7d" | "30d" | "90d" | "all";
export type BillingUsageKind = "delivery" | "storage" | "other";

export const BILLING_USAGE_RANGE_OPTIONS: { value: BillingUsageRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

const RECENT_USAGE_EVENT_LIMIT = 50;
const BILLABLE_USAGE_SOURCES = new Set(["delivery_aggregation", "storage_aggregation"]);
const FINAL_USAGE_STATUSES = new Set(["tracked", "skipped"]);

type FeatureInfo = {
  kind: BillingUsageKind;
  label: string;
  tierLabel: string;
  sort: number;
};

type UsageAggregateRow = {
  feature_id: string;
  source: string;
  status: string;
  event_count: string;
  asset_count: string;
  value: string | null;
  first_event_at: Date | string | null;
  last_event_at: Date | string | null;
};

type RecentUsageEventRow = {
  id: string;
  asset_id: string | null;
  feature_id: string;
  source: string;
  status: string;
  value: string | null;
  created_at: Date | string | null;
  tracked_at: Date | string | null;
};

export type BillingUsageAggregate = {
  featureId: string;
  kind: BillingUsageKind;
  label: string;
  tierLabel: string;
  source: string;
  sourceLabel: string;
  status: string;
  statusLabel: string;
  billable: boolean;
  value: number;
  eventCount: number;
  assetCount: number;
  firstEventAt?: string;
  lastEventAt?: string;
};

export type RecentBillingUsageEvent = {
  id: string;
  assetId?: string;
  featureId: string;
  kind: BillingUsageKind;
  label: string;
  tierLabel: string;
  source: string;
  sourceLabel: string;
  status: string;
  statusLabel: string;
  billable: boolean;
  value: number;
  createdAt?: string;
  trackedAt?: string;
};

export type BillingUsageDetails = {
  range: BillingUsageRange;
  rangeLabel: string;
  startAt?: string;
  generatedAt: string;
  aggregates: BillingUsageAggregate[];
  recentEvents: RecentBillingUsageEvent[];
  totals: {
    billableDeliverySeconds: number;
    billableStorageSecondMonths: number;
    billableOtherUnits: number;
    billableEvents: number;
    latestBillableAt?: string;
  };
};

export function normalizeBillingUsageRange(value: string | string[] | undefined): BillingUsageRange {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "7d" || raw === "30d" || raw === "90d" || raw === "all" ? raw : "30d";
}

export function billingUsageRangeLabel(range: BillingUsageRange) {
  return BILLING_USAGE_RANGE_OPTIONS.find((option) => option.value === range)?.label ?? "30 days";
}

function billingUsageRangeStart(range: BillingUsageRange, now = new Date()) {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function isoDate(value: Date | string | null | undefined) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function numeric(value: string | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function integer(value: string | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function featureInfoMap() {
  const features = billingFeatureIds();
  return new Map<string, FeatureInfo>([
    [features.delivery720p, { kind: "delivery", label: "Delivery 720p", tierLabel: "720p", sort: 10 }],
    [features.delivery1080p, { kind: "delivery", label: "Delivery 1080p", tierLabel: "1080p", sort: 20 }],
    [features.delivery2k, { kind: "delivery", label: "Delivery 2K", tierLabel: "2K", sort: 30 }],
    [features.delivery4k, { kind: "delivery", label: "Delivery 4K", tierLabel: "4K", sort: 40 }],
    [features.storage720p, { kind: "storage", label: "Storage 720p", tierLabel: "720p", sort: 110 }],
    [features.storage1080p, { kind: "storage", label: "Storage 1080p", tierLabel: "1080p", sort: 120 }],
    [features.storage2k, { kind: "storage", label: "Storage 2K", tierLabel: "2K", sort: 130 }],
    [features.storage4k, { kind: "storage", label: "Storage 4K", tierLabel: "4K", sort: 140 }],
  ]);
}

function humanizeFeature(featureId: string) {
  const base = featureId.replace(/^rend[_-]/i, "").replace(/[_-]+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : featureId;
}

export function billingUsageFeatureInfo(featureId: string): FeatureInfo {
  return featureInfoMap().get(featureId) ?? {
    kind: "other",
    label: humanizeFeature(featureId),
    tierLabel: humanizeFeature(featureId),
    sort: 500,
  };
}

export function billingUsageSourceLabel(source: string) {
  if (source === "delivery_aggregation") return "Delivery aggregation";
  if (source === "storage_aggregation") return "Storage aggregation";
  if (source === "upload_gate") return "Upload check";
  if (source === "upload_reservation") return "Upload reservation";
  if (source === "upload_reconcile") return "Upload reconcile";
  if (source === "upload_refund") return "Upload refund";
  if (source === "asset_delete") return "Asset delete";
  if (source === "local_stub") return "Local stub";
  return source.replace(/[_-]+/g, " ");
}

export function billingUsageStatusLabel(status: string) {
  if (status === "tracked") return "Tracked";
  if (status === "skipped") return "Skipped";
  if (status === "pending") return "Pending";
  if (status === "failed") return "Failed";
  return status.replace(/[_-]+/g, " ");
}

export function isBillableUsage(source: string, status: string) {
  return BILLABLE_USAGE_SOURCES.has(source) && FINAL_USAGE_STATUSES.has(status);
}

function compareUsageRows(
  a: Pick<BillingUsageAggregate, "featureId" | "source" | "status">,
  b: Pick<BillingUsageAggregate, "featureId" | "source" | "status">
) {
  const aInfo = billingUsageFeatureInfo(a.featureId);
  const bInfo = billingUsageFeatureInfo(b.featureId);
  return aInfo.sort - bInfo.sort || a.source.localeCompare(b.source) || a.status.localeCompare(b.status);
}

function normalizeAggregate(row: UsageAggregateRow): BillingUsageAggregate {
  const info = billingUsageFeatureInfo(row.feature_id);
  const billable = isBillableUsage(row.source, row.status);
  return {
    featureId: row.feature_id,
    kind: info.kind,
    label: info.label,
    tierLabel: info.tierLabel,
    source: row.source,
    sourceLabel: billingUsageSourceLabel(row.source),
    status: row.status,
    statusLabel: billingUsageStatusLabel(row.status),
    billable,
    value: numeric(row.value),
    eventCount: integer(row.event_count),
    assetCount: integer(row.asset_count),
    firstEventAt: isoDate(row.first_event_at),
    lastEventAt: isoDate(row.last_event_at),
  };
}

function normalizeRecentEvent(row: RecentUsageEventRow): RecentBillingUsageEvent {
  const info = billingUsageFeatureInfo(row.feature_id);
  const billable = isBillableUsage(row.source, row.status);
  return {
    id: row.id,
    assetId: row.asset_id ?? undefined,
    featureId: row.feature_id,
    kind: info.kind,
    label: info.label,
    tierLabel: info.tierLabel,
    source: row.source,
    sourceLabel: billingUsageSourceLabel(row.source),
    status: row.status,
    statusLabel: billingUsageStatusLabel(row.status),
    billable,
    value: numeric(row.value),
    createdAt: isoDate(row.created_at),
    trackedAt: isoDate(row.tracked_at),
  };
}

export async function billingUsageDetails(
  context: Pick<DashboardAccessContext, "organizationId">,
  range: BillingUsageRange
): Promise<BillingUsageDetails> {
  const start = billingUsageRangeStart(range);
  const pool = getSitePgPool();
  const [aggregateResult, recentResult] = await Promise.all([
    pool.query<UsageAggregateRow>(
      `
        SELECT feature_id,
               source,
               status,
               count(*)::text AS event_count,
               count(DISTINCT asset_id) FILTER (WHERE asset_id IS NOT NULL)::text AS asset_count,
               COALESCE(sum(value), 0)::text AS value,
               min(created_at) AS first_event_at,
               max(COALESCE(tracked_at, updated_at, created_at)) AS last_event_at
        FROM rend.billing_usage_events
        WHERE organization_id = $1::uuid
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        GROUP BY feature_id, source, status
      `,
      [context.organizationId, start]
    ),
    pool.query<RecentUsageEventRow>(
      `
        SELECT id::text,
               asset_id::text,
               feature_id,
               source,
               status,
               value::text,
               created_at,
               tracked_at
        FROM rend.billing_usage_events
        WHERE organization_id = $1::uuid
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        ORDER BY created_at DESC
        LIMIT $3
      `,
      [context.organizationId, start, RECENT_USAGE_EVENT_LIMIT]
    ),
  ]);

  const aggregates = aggregateResult.rows.map(normalizeAggregate).sort(compareUsageRows);
  const totals = {
    billableDeliverySeconds: 0,
    billableStorageSecondMonths: 0,
    billableOtherUnits: 0,
    billableEvents: 0,
    latestBillableAt: undefined as string | undefined,
  };

  for (const aggregate of aggregates) {
    if (!aggregate.billable) continue;
    if (aggregate.kind === "delivery") totals.billableDeliverySeconds += aggregate.value;
    if (aggregate.kind === "storage") totals.billableStorageSecondMonths += aggregate.value;
    if (aggregate.kind === "other") totals.billableOtherUnits += aggregate.value;
    totals.billableEvents += aggregate.eventCount;
    if (aggregate.lastEventAt && (!totals.latestBillableAt || aggregate.lastEventAt > totals.latestBillableAt)) {
      totals.latestBillableAt = aggregate.lastEventAt;
    }
  }

  return {
    range,
    rangeLabel: billingUsageRangeLabel(range),
    startAt: isoDate(start),
    generatedAt: new Date().toISOString(),
    aggregates,
    recentEvents: recentResult.rows.map(normalizeRecentEvent),
    totals,
  };
}
