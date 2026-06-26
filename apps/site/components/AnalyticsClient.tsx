"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnalyticsBreakdownRow,
  AnalyticsLive,
  AnalyticsLiveResponse,
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
  LIVE_WINDOW_SECONDS,
  formatLiveActivityLabel,
  liveMetaFromAnalytics,
  overviewFromLiveAnalytics,
  type LiveAnalyticsMeta,
} from "./analytics/live-overview";
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

type ViewMode = "overview" | "live";
const LIVE_POLL_MS = 5_000;
const OVERVIEW_POLL_MS = 30_000;
const ANALYTICS_VIEW_STORAGE_KEY = "rend.analytics.view";

type StoredAnalyticsView =
  | { mode: "live" }
  | { mode: "overview"; windowSeconds: number };

type WindowOption = { label: string; seconds: number };
const WINDOW_OPTIONS: WindowOption[] = [
  { label: "24h", seconds: 24 * 60 * 60 },
  { label: "7d", seconds: 7 * 24 * 60 * 60 },
  { label: "30d", seconds: 30 * 24 * 60 * 60 },
];

type Granularity = "minute" | "hourly" | "daily";

const minuteFormatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const hourFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });
const dayFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function defaultGranularity(windowSeconds: number): Granularity {
  return windowSeconds <= 2 * 24 * 60 * 60 ? "hourly" : "daily";
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function prepareSeries(points: AnalyticsTimeSeriesPoint[], granularity: Granularity): OverviewChartPoint[] {
  if (granularity === "minute" || granularity === "hourly") {
    const formatter = granularity === "minute" ? minuteFormatter : hourFormatter;
    return points.map((point) => {
      const date = new Date(point.bucket_start);
      return {
        key: point.bucket_start,
        label: formatter.format(date),
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

function readStoredAnalyticsView(): StoredAnalyticsView | null {
  try {
    const raw = localStorage.getItem(ANALYTICS_VIEW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAnalyticsView>;
    if (parsed.mode === "live") return { mode: "live" };
    if (parsed.mode === "overview" && typeof parsed.windowSeconds === "number") {
      const valid = WINDOW_OPTIONS.some((option) => option.seconds === parsed.windowSeconds);
      if (valid) return { mode: "overview", windowSeconds: parsed.windowSeconds };
    }
  } catch {
    return null;
  }
  return null;
}

function writeStoredAnalyticsView(view: StoredAnalyticsView) {
  try {
    localStorage.setItem(ANALYTICS_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    return;
  }
}

async function requestOverview(windowSeconds: number): Promise<AnalyticsOverview> {
  const response = await fetch(`/api/analytics/overview?windowSeconds=${windowSeconds}`, {
    cache: "no-store",
  });
  const body = (await response.json()) as AnalyticsOverviewResponse | { message?: string };
  if (!response.ok || !("analytics" in body)) {
    throw new Error("message" in body && body.message ? body.message : "Analytics refresh failed");
  }
  return body.analytics;
}

async function requestLive(): Promise<AnalyticsLive> {
  const response = await fetch(`/api/analytics/live?windowSeconds=${LIVE_WINDOW_SECONDS}`, {
    cache: "no-store",
  });
  const body = (await response.json()) as AnalyticsLiveResponse | { message?: string };
  if (!response.ok || !("live" in body)) {
    throw new Error("message" in body && body.message ? body.message : "Live analytics refresh failed");
  }
  return body.live;
}

export default function AnalyticsClient({
  initialAnalytics,
  initialError = "",
}: {
  initialAnalytics: AnalyticsOverview | null;
  initialError?: string;
}) {
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const [liveAnalytics, setLiveAnalytics] = useState<AnalyticsOverview | null>(null);
  const [liveMeta, setLiveMeta] = useState<LiveAnalyticsMeta | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const [windowSeconds, setWindowSeconds] = useState(WINDOW_OPTIONS[0].seconds);
  const [granularity, setGranularity] = useState<Granularity>(defaultGranularity(WINDOW_OPTIONS[0].seconds));
  const [loading, setLoading] = useState(false);
  const [liveLoading, setLiveLoading] = useState(false);
  const [error, setError] = useState(initialError);
  const liveAnalyticsRef = useRef(liveAnalytics);
  const analyticsRef = useRef(analytics);
  const restoredViewRef = useRef(false);

  useEffect(() => {
    liveAnalyticsRef.current = liveAnalytics;
  }, [liveAnalytics]);

  useEffect(() => {
    analyticsRef.current = analytics;
  }, [analytics]);

  const refresh = useCallback(async (nextWindowSeconds: number, { background = false }: { background?: boolean } = {}) => {
    if (!background) setLoading(true);
    if (!background || !analyticsRef.current) setError("");
    try {
      setAnalytics(await requestOverview(nextWindowSeconds));
    } catch (refreshError) {
      if (!background || !analyticsRef.current) {
        setError(refreshError instanceof Error ? refreshError.message : "Analytics refresh failed");
      }
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  const refreshCurrentWindow = useCallback(
    ({ background = false }: { background?: boolean } = {}) => {
      void refresh(windowSeconds, { background });
    },
    [refresh, windowSeconds]
  );

  const refreshLive = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (!background) setLiveLoading(true);
    if (!background || !liveAnalyticsRef.current) setError("");
    try {
      const [liveResult, overviewResult] = await Promise.allSettled([
        requestLive(),
        requestOverview(LIVE_WINDOW_SECONDS),
      ]);
      const overview = overviewResult.status === "fulfilled" ? overviewResult.value : null;

      if (liveResult.status === "fulfilled") {
        const live = liveResult.value;
        setLiveAnalytics(overviewFromLiveAnalytics(live, overview ?? liveAnalyticsRef.current));
        setLiveMeta(liveMetaFromAnalytics(live));
        setError("");
        return;
      }

      if (overview) {
        setLiveAnalytics(overview);
        setLiveMeta({
          activeSessions: 0,
          fetchedAt: new Date().toISOString(),
          resolution: "hourly",
          viewsLastMinute: 0,
        });
        setError("");
        return;
      }

      throw liveResult.reason;
    } catch (refreshError) {
      if (!background || !liveAnalyticsRef.current) {
        setError(refreshError instanceof Error ? refreshError.message : "Live analytics refresh failed");
      }
    } finally {
      if (!background) setLiveLoading(false);
    }
  }, []);

  useEffect(() => {
    if (restoredViewRef.current) return;
    restoredViewRef.current = true;
    const stored = readStoredAnalyticsView();
    if (!stored) return;
    if (stored.mode === "live") {
      setViewMode("live");
      return;
    }
    if (stored.windowSeconds !== WINDOW_OPTIONS[0].seconds) {
      setWindowSeconds(stored.windowSeconds);
      setGranularity(defaultGranularity(stored.windowSeconds));
      void refresh(stored.windowSeconds, { background: Boolean(analyticsRef.current) });
    }
  }, [refresh]);

  useEffect(() => {
    writeStoredAnalyticsView(
      viewMode === "live" ? { mode: "live" } : { mode: "overview", windowSeconds }
    );
  }, [viewMode, windowSeconds]);

  useEffect(() => {
    if (viewMode !== "overview") return;
    const refreshOnReturn = () => refreshCurrentWindow({ background: Boolean(analyticsRef.current) });
    const onFocus = () => refreshOnReturn();
    const onVisibilityChange = () => {
      if (!document.hidden) refreshOnReturn();
    };
    const interval = window.setInterval(refreshOnReturn, OVERVIEW_POLL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshCurrentWindow, viewMode]);

  useEffect(() => {
    if (viewMode !== "live") return;
    void refreshLive({ background: Boolean(liveAnalyticsRef.current) });
    const onFocus = () => refreshLive({ background: true });
    const onVisibilityChange = () => {
      if (!document.hidden) refreshLive({ background: true });
    };
    const interval = window.setInterval(() => {
      if (!document.hidden) refreshLive({ background: true });
    }, LIVE_POLL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshLive, viewMode]);

  function selectViewMode(nextMode: ViewMode) {
    setViewMode(nextMode);
    setError("");
    if (nextMode === "live" && viewMode === "live") void refreshLive();
  }

  function selectWindow(nextWindowSeconds: number) {
    setViewMode("overview");
    setWindowSeconds(nextWindowSeconds);
    setGranularity(defaultGranularity(nextWindowSeconds));
    void refresh(nextWindowSeconds, { background: Boolean(analyticsRef.current) });
  }

  const visibleAnalytics = viewMode === "live" ? liveAnalytics : analytics;
  const effectiveGranularity =
    viewMode === "live" ? (liveMeta?.resolution === "hourly" ? "hourly" : "minute") : granularity;
  const showInitialSkeleton =
    viewMode === "live" ? liveLoading && !liveAnalytics : loading && !analytics;
  const isRefreshing = viewMode === "live" ? liveLoading : loading;

  const byDimension = useMemo(() => {
    const map = new Map<string, AnalyticsBreakdownRow[]>();
    for (const breakdown of visibleAnalytics?.breakdowns ?? []) map.set(breakdown.dimension, breakdown.rows);
    return map;
  }, [visibleAnalytics?.breakdowns]);

  const series = useMemo(
    () => prepareSeries(visibleAnalytics?.timeseries ?? [], effectiveGranularity),
    [visibleAnalytics?.timeseries, effectiveGranularity]
  );

  const rowsFor = useCallback(
    (dimension: string) => byDimension.get(dimension) ?? [],
    [byDimension]
  );

  const actions = (
    <>
      <div className="hidden items-center gap-1 rounded-lg border border-line bg-card p-1 sm:flex">
        <button
          type="button"
          onClick={() => selectViewMode("live")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
            viewMode === "live"
              ? "bg-ink text-bg"
              : "text-muted hover:bg-bg-sunken hover:text-ink"
          )}
        >
          <span className="relative flex size-1.5">
            {viewMode === "live" ? (
              <>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#14b8a6] opacity-50 motion-reduce:animate-none" />
                <span className="relative inline-flex size-1.5 rounded-full bg-[#14b8a6]" />
              </>
            ) : (
              <span className="inline-flex size-1.5 rounded-full bg-[#14b8a6]/70" />
            )}
          </span>
          Live
        </button>
        {WINDOW_OPTIONS.map((option) => (
          <button
            key={option.seconds}
            type="button"
            onClick={() => selectWindow(option.seconds)}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
              viewMode === "overview" && windowSeconds === option.seconds
                ? "bg-ink text-bg"
                : "text-muted hover:bg-bg-sunken hover:text-ink"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="rounded-md"
        onClick={viewMode === "live" ? () => refreshLive() : () => refreshCurrentWindow()}
        disabled={isRefreshing}
      >
        <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
        {isRefreshing ? "Refreshing" : "Refresh"}
      </Button>
    </>
  );

  const statItems: StatItem[] = useMemo(() => {
    if (!visibleAnalytics) return [];
    const prev = visibleAnalytics.previous;
    const avgWatch = visibleAnalytics.views > 0 ? visibleAnalytics.watch_time_ms / visibleAnalytics.views : 0;
    const prevAvgWatch = prev && prev.views > 0 ? prev.watch_time_ms / prev.views : undefined;
    const completionRate = visibleAnalytics.views > 0 ? visibleAnalytics.completions / visibleAnalytics.views : 0;
    const prevCompletionRate = prev && prev.views > 0 ? prev.completions / prev.views : undefined;
    return [
      { label: "Views", value: formatNumber(visibleAnalytics.views), delta: computeDelta(visibleAnalytics.views, prev?.views) },
      {
        label: "Unique viewers",
        value: formatNumber(visibleAnalytics.unique_viewers),
        delta: computeDelta(visibleAnalytics.unique_viewers, prev?.unique_viewers),
        hint: viewMode === "live" && liveMeta ? `${formatNumber(liveMeta.activeSessions)} watching now` : undefined,
      },
      {
        label: "Watch time",
        value: formatWatchTime(visibleAnalytics.watch_time_ms),
        delta: computeDelta(visibleAnalytics.watch_time_ms, prev?.watch_time_ms),
      },
      {
        label: "Avg watch",
        value: visibleAnalytics.views > 0 ? formatWatchTime(avgWatch) : "-",
        delta: computeDelta(avgWatch, prevAvgWatch),
      },
      {
        label: "Completion",
        value: formatPercent(completionRate),
        delta: computeDelta(completionRate, prevCompletionRate),
      },
      {
        label: "Startup",
        value: formatPercent(visibleAnalytics.startup_success_rate),
        delta: computeDelta(visibleAnalytics.startup_success_rate, prev?.startup_success_rate),
      },
      {
        label: "Rebuffer",
        value: formatPercent(visibleAnalytics.rebuffer_ratio),
        invertDelta: true,
        delta: computeDelta(visibleAnalytics.rebuffer_ratio, prev?.rebuffer_ratio),
      },
    ];
  }, [liveMeta, viewMode, visibleAnalytics]);

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

  const assetRows: AnalyticsBreakdownRow[] = (visibleAnalytics?.top_assets ?? []).map((asset) => ({
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

        {showInitialSkeleton ? (
          <div className="h-[480px] animate-pulse rounded-xl bg-bg-sunken/40" />
        ) : !visibleAnalytics && !error ? (
          <Panel>
            <p className="text-[13.5px] text-muted">
              {viewMode === "live" ? "No live analytics available yet." : "No analytics available yet."}
            </p>
          </Panel>
        ) : null}

        {visibleAnalytics ? (
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
                <div className="flex min-h-8 min-w-[168px] shrink-0 items-center justify-end">
                {viewMode === "live" ? (
                  <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted">
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-live/50 motion-reduce:animate-none" />
                      <span className="relative inline-flex size-2 rounded-full bg-live" />
                    </span>
                    <span>Live</span>
                    {liveMeta ? (
                      <span className="text-faint">
                        {formatLiveActivityLabel(liveMeta, visibleAnalytics.timeseries)}
                      </span>
                    ) : null}
                  </div>
                ) : (
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
                )}
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
              <Stat label="Requests" value={formatCompact(visibleAnalytics.request_count)} hint="Edge artifact requests" />
              <Stat label="Cache hit" value={formatPercent(visibleAnalytics.cache_hit_rate)} hint="Edge request rollup" />
              <Stat
                label="Errors"
                value={formatPercent(visibleAnalytics.error_rate)}
                hint={`${formatNumber(visibleAnalytics.playback_failures)} player failures`}
              />
              <Stat
                label="Edge latency"
                value={formatMs(visibleAnalytics.request_p95_ms)}
                hint={`p50 ${formatMs(visibleAnalytics.request_p50_ms)}`}
              />
              <Stat
                label="Startup p95"
                value={formatMs(visibleAnalytics.startup_p95_ms)}
                hint={`p50 ${formatMs(visibleAnalytics.startup_p50_ms)}`}
              />
              <Stat label="Delivered" value={formatBytes(visibleAnalytics.bytes_served)} hint="Total bytes served" />
            </StatGrid>
          </div>
        ) : null}
      </DashboardContent>
    </>
  );
}
