"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AnalyticsBreakdownRow,
  AnalyticsOverview,
  AnalyticsOverviewResponse,
  AnalyticsTimeSeriesPoint,
} from "../lib/asset-types.ts";
import { Button } from "@/components/ui/Button";
import {
  Callout,
  DashboardContent,
  Panel,
  Stat,
  StatGrid,
  SubHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/dashboard";
import { cn } from "@/components/ui/cn";
import { StatStrip, type StatItem } from "./analytics/StatStrip";
import BreakdownPanel, { type BreakdownTabConfig } from "./analytics/BreakdownPanel";
import type { OverviewChartPoint } from "./analytics/OverviewChart";
import {
  computeDelta,
  formatBytes,
  formatCompact,
  formatMs,
  formatNumber,
  formatPercent,
  formatWatchTime,
  titleCase,
} from "./analytics/format";

const OverviewChart = dynamic(() => import("./analytics/OverviewChart"), {
  ssr: false,
  loading: () => <div className="h-[300px] w-full animate-pulse rounded-lg bg-bg-sunken/40" />,
});

type WindowOption = { label: string; seconds: number };
const WINDOW_OPTIONS: WindowOption[] = [
  { label: "24h", seconds: 24 * 60 * 60 },
  { label: "7d", seconds: 7 * 24 * 60 * 60 },
  { label: "30d", seconds: 30 * 24 * 60 * 60 },
];

type Granularity = "hourly" | "daily";

const hourFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });
const dayFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function defaultGranularity(windowSeconds: number): Granularity {
  return windowSeconds <= 2 * 24 * 60 * 60 ? "hourly" : "daily";
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function prepareSeries(points: AnalyticsTimeSeriesPoint[], granularity: Granularity): OverviewChartPoint[] {
  if (granularity === "hourly") {
    return points.map((point) => {
      const date = new Date(point.bucket_start);
      return {
        key: point.bucket_start,
        label: hourFormatter.format(date),
        views: point.views,
        watch_time_ms: point.watch_time_ms,
        request_count: point.request_count,
        bytes_served: point.bytes_served,
      };
    });
  }

  const grouped = new Map<string, OverviewChartPoint>();
  for (const point of points) {
    const date = new Date(point.bucket_start);
    const key = dayKey(date);
    const existing =
      grouped.get(key) ??
      {
        key,
        label: dayFormatter.format(date),
        views: 0,
        watch_time_ms: 0,
        request_count: 0,
        bytes_served: 0,
      };
    existing.views += point.views;
    existing.watch_time_ms += point.watch_time_ms;
    existing.request_count += point.request_count;
    existing.bytes_served += point.bytes_served;
    grouped.set(key, existing);
  }
  return [...grouped.values()];
}

export default function AnalyticsClient({
  initialAnalytics,
  initialError = "",
}: {
  initialAnalytics: AnalyticsOverview | null;
  initialError?: string;
}) {
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const [windowSeconds, setWindowSeconds] = useState(WINDOW_OPTIONS[0].seconds);
  const [granularity, setGranularity] = useState<Granularity>(defaultGranularity(WINDOW_OPTIONS[0].seconds));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);

  const refresh = useCallback(async (nextWindowSeconds: number) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/analytics/overview?windowSeconds=${nextWindowSeconds}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as AnalyticsOverviewResponse | { message?: string };
      if (!response.ok || !("analytics" in body)) {
        throw new Error("message" in body && body.message ? body.message : "Analytics refresh failed");
      }
      setAnalytics(body.analytics);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Analytics refresh failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshCurrentWindow = useCallback(() => {
    void refresh(windowSeconds);
  }, [refresh, windowSeconds]);

  useEffect(() => {
    const onFocus = () => refreshCurrentWindow();
    const onVisibilityChange = () => {
      if (!document.hidden) refreshCurrentWindow();
    };
    const interval = window.setInterval(refreshCurrentWindow, 30_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshCurrentWindow]);

  function selectWindow(nextWindowSeconds: number) {
    setWindowSeconds(nextWindowSeconds);
    setGranularity(defaultGranularity(nextWindowSeconds));
    void refresh(nextWindowSeconds);
  }

  const byDimension = useMemo(() => {
    const map = new Map<string, AnalyticsBreakdownRow[]>();
    for (const breakdown of analytics?.breakdowns ?? []) map.set(breakdown.dimension, breakdown.rows);
    return map;
  }, [analytics?.breakdowns]);

  const series = useMemo(
    () => prepareSeries(analytics?.timeseries ?? [], granularity),
    [analytics?.timeseries, granularity]
  );

  const rowsFor = useCallback(
    (dimension: string) => byDimension.get(dimension) ?? [],
    [byDimension]
  );

  const actions = (
    <>
      <div className="hidden items-center gap-1 rounded-lg border border-line bg-card p-1 sm:flex">
        {WINDOW_OPTIONS.map((option) => (
          <button
            key={option.seconds}
            type="button"
            onClick={() => selectWindow(option.seconds)}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
              windowSeconds === option.seconds
                ? "bg-ink text-bg"
                : "text-muted hover:bg-bg-sunken hover:text-ink"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <Button variant="secondary" size="sm" className="rounded-md" onClick={refreshCurrentWindow} disabled={loading}>
        <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        {loading ? "Refreshing" : "Refresh"}
      </Button>
    </>
  );

  const statItems: StatItem[] = useMemo(() => {
    if (!analytics) return [];
    const prev = analytics.previous;
    const avgWatch = analytics.views > 0 ? analytics.watch_time_ms / analytics.views : 0;
    const prevAvgWatch = prev && prev.views > 0 ? prev.watch_time_ms / prev.views : undefined;
    const completionRate = analytics.views > 0 ? analytics.completions / analytics.views : 0;
    const prevCompletionRate = prev && prev.views > 0 ? prev.completions / prev.views : undefined;
    return [
      { label: "Views", value: formatNumber(analytics.views), delta: computeDelta(analytics.views, prev?.views) },
      {
        label: "Unique viewers",
        value: formatNumber(analytics.unique_viewers),
        delta: computeDelta(analytics.unique_viewers, prev?.unique_viewers),
      },
      {
        label: "Watch time",
        value: formatWatchTime(analytics.watch_time_ms),
        delta: computeDelta(analytics.watch_time_ms, prev?.watch_time_ms),
      },
      {
        label: "Avg watch",
        value: analytics.views > 0 ? formatWatchTime(avgWatch) : "-",
        delta: computeDelta(avgWatch, prevAvgWatch),
      },
      {
        label: "Completion",
        value: formatPercent(completionRate),
        delta: computeDelta(completionRate, prevCompletionRate),
      },
      {
        label: "Startup",
        value: formatPercent(analytics.startup_success_rate),
        delta: computeDelta(analytics.startup_success_rate, prev?.startup_success_rate),
      },
      {
        label: "Rebuffer",
        value: formatPercent(analytics.rebuffer_ratio),
        invertDelta: true,
        delta: computeDelta(analytics.rebuffer_ratio, prev?.rebuffer_ratio),
      },
    ];
  }, [analytics]);

  const sourceTabs: BreakdownTabConfig[] = [
    { key: "channel", label: "Channel", kind: "channel", rows: rowsFor("channel") },
    { key: "referrer", label: "Referrer", kind: "favicon", rows: rowsFor("referrer") },
    { key: "campaign", label: "Campaign", kind: "plain", rows: rowsFor("campaign") },
    { key: "keyword", label: "Keyword", kind: "plain", rows: rowsFor("keyword") },
  ];

  const locationTabs: BreakdownTabConfig[] = [
    { key: "map", label: "Map", kind: "flag", rows: rowsFor("country"), map: true },
    { key: "country", label: "Country", kind: "flag", rows: rowsFor("country") },
    { key: "region", label: "Region", kind: "geo", rows: rowsFor("region") },
    { key: "city", label: "City", kind: "geo", rows: rowsFor("city") },
  ];

  const assetRows: AnalyticsBreakdownRow[] = (analytics?.top_assets ?? []).map((asset) => ({
    value: asset.asset_id,
    views: asset.views,
    unique_viewers: 0,
    watch_time_ms: asset.watch_time_ms,
    request_count: asset.request_count,
    bytes_served: asset.bytes_served,
  }));

  const contentTabs: BreakdownTabConfig[] = [
    {
      key: "video",
      label: "Video",
      kind: "asset",
      rows: assetRows,
      assetHref: (value) => `/dashboard/assets/${value}`,
    },
    {
      key: "page_type",
      label: "Page type",
      kind: "plain",
      rows: rowsFor("page_type").map((row) => ({ ...row, value: titleCase(row.value) })),
    },
    { key: "hostname", label: "Hostname", kind: "favicon", rows: rowsFor("hostname") },
  ];

  const techTabs: BreakdownTabConfig[] = [
    { key: "browser", label: "Browser", kind: "browser", rows: rowsFor("browser") },
    { key: "os", label: "OS", kind: "os", rows: rowsFor("os") },
    { key: "device", label: "Device", kind: "device", rows: rowsFor("device") },
  ];

  return (
    <>
      <SubHeader title="Analytics" docsHref="/docs" docsLabel="Analytics API" actions={actions} />
      <DashboardContent>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {!analytics && !error ? (
          <Panel>
            <p className="text-[13.5px] text-muted">No analytics available yet.</p>
          </Panel>
        ) : null}

        {analytics ? (
          <div className="flex flex-col gap-4">
            <StatStrip items={statItems} />

            <div className="overflow-hidden rounded-xl border border-line bg-card">
              <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
                    <span className="size-2 rounded-full bg-[#2f6fed]" />
                    Views
                  </span>
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
                    <span className="size-2 rounded-[3px] bg-[#e08a5e]" />
                    Watch time
                  </span>
                </div>
                <div className="flex items-center rounded-md border border-line bg-bg-sunken/60 p-0.5">
                  {(["daily", "hourly"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setGranularity(option)}
                      className={cn(
                        "rounded px-2.5 py-1 text-[11.5px] font-medium capitalize transition-colors",
                        granularity === option
                          ? "bg-card text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                          : "text-muted hover:text-ink"
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
              <div className="px-2 py-3 sm:px-3">
                {series.length === 0 ? (
                  <div className="flex h-[300px] items-center justify-center">
                    <p className="text-[13px] text-faint">No traffic in this window yet.</p>
                  </div>
                ) : (
                  <OverviewChart data={series} />
                )}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <BreakdownPanel title="Sources" tabs={sourceTabs} />
              <BreakdownPanel title="Locations" tabs={locationTabs} />
              <BreakdownPanel title="Content" tabs={contentTabs} />
              <BreakdownPanel title="Tech" tabs={techTabs} />
            </div>

            <Panel title="Top videos" flush={assetRows.length > 0}>
              {assetRows.length === 0 ? (
                <p className="text-[13.5px] text-muted">No viewed videos yet.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Video</TH>
                      <TH className="text-right">Views</TH>
                      <TH className="text-right">Watch time</TH>
                      <TH className="hidden text-right sm:table-cell">Avg / view</TH>
                      <TH className="hidden text-right md:table-cell">Requests</TH>
                      <TH className="hidden text-right md:table-cell">Delivered</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {assetRows.map((asset) => (
                      <TR key={asset.value}>
                        <TD>
                          <Link
                            href={`/dashboard/assets/${asset.value}`}
                            className="font-mono text-[12px] text-ink underline-offset-2 hover:underline"
                          >
                            {asset.value}
                          </Link>
                        </TD>
                        <TD className="text-right font-mono text-[12px] tabular-nums text-ink-soft">
                          {formatNumber(asset.views)}
                        </TD>
                        <TD className="text-right font-mono text-[12px] tabular-nums text-ink-soft">
                          {formatWatchTime(asset.watch_time_ms)}
                        </TD>
                        <TD className="hidden text-right font-mono text-[12px] tabular-nums text-muted sm:table-cell">
                          {asset.views > 0 ? formatWatchTime(asset.watch_time_ms / asset.views) : "-"}
                        </TD>
                        <TD className="hidden text-right font-mono text-[12px] tabular-nums text-muted md:table-cell">
                          {formatNumber(asset.request_count)}
                        </TD>
                        <TD className="hidden text-right font-mono text-[12px] tabular-nums text-muted md:table-cell">
                          {formatBytes(asset.bytes_served)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Panel>

            <StatGrid>
              <Stat label="Requests" value={formatCompact(analytics.request_count)} hint="Edge artifact requests" />
              <Stat label="Cache hit" value={formatPercent(analytics.cache_hit_rate)} hint="Edge request rollup" />
              <Stat
                label="Errors"
                value={formatPercent(analytics.error_rate)}
                hint={`${formatNumber(analytics.playback_failures)} player failures`}
              />
              <Stat
                label="Edge latency"
                value={formatMs(analytics.request_p95_ms)}
                hint={`p50 ${formatMs(analytics.request_p50_ms)}`}
              />
              <Stat
                label="Startup p95"
                value={formatMs(analytics.startup_p95_ms)}
                hint={`p50 ${formatMs(analytics.startup_p50_ms)}`}
              />
              <Stat label="Delivered" value={formatBytes(analytics.bytes_served)} hint="Total bytes served" />
            </StatGrid>
          </div>
        ) : null}
      </DashboardContent>
    </>
  );
}
