"use client";

import { Activity, Clock, Database, Eye, Gauge, RefreshCw, Signal } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
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

type WindowOption = {
  label: string;
  seconds: number;
};

const WINDOW_OPTIONS: WindowOption[] = [
  { label: "24h", seconds: 24 * 60 * 60 },
  { label: "7d", seconds: 7 * 24 * 60 * 60 },
  { label: "30d", seconds: 30 * 24 * 60 * 60 },
];

const numberFormatter = new Intl.NumberFormat("en-US");
const compactFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

function formatNumber(value: number) {
  return numberFormatter.format(value);
}

function formatCompact(value: number) {
  return compactFormatter.format(value);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function formatMs(value: number | undefined) {
  if (value === undefined) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(value >= 0.995 || value === 0 ? 0 : 1)}%`;
}

function formatWatchTime(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${formatNumber(minutes)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(hours >= 10 ? 1 : 2)}h`;
}

function formatBucket(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
  }).format(date);
}

function maxSeriesValue(points: AnalyticsTimeSeriesPoint[]) {
  return Math.max(1, ...points.map((point) => Math.max(point.views, point.request_count)));
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);
  const seriesMax = useMemo(
    () => maxSeriesValue(analytics?.timeseries ?? []),
    [analytics?.timeseries]
  );

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
    void refresh(nextWindowSeconds);
  }

  const actions = (
    <>
      <div className="hidden items-center gap-1 rounded-lg border border-line bg-card p-1 sm:flex">
        {WINDOW_OPTIONS.map((option) => (
          <button
            key={option.seconds}
            type="button"
            onClick={() => selectWindow(option.seconds)}
            className={`rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
              windowSeconds === option.seconds
                ? "bg-ink text-bg"
                : "text-muted hover:bg-bg-sunken hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="rounded-md"
        onClick={refreshCurrentWindow}
        disabled={loading}
      >
        <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        {loading ? "Refreshing" : "Refresh"}
      </Button>
    </>
  );

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
          <div className="flex flex-col gap-5">
            <StatGrid>
              <Stat label="Views" value={formatNumber(analytics.views)} hint="Sessions with first frame" icon={Eye} />
              <Stat label="Watch time" value={formatWatchTime(analytics.watch_time_ms)} hint="Player heartbeat estimate" icon={Clock} />
              <Stat label="Startup" value={formatPercent(analytics.startup_success_rate)} hint={`p95 ${formatMs(analytics.startup_p95_ms)}`} icon={Gauge} />
              <Stat label="Rebuffer" value={formatPercent(analytics.rebuffer_ratio)} hint={`${formatNumber(analytics.stalled_sessions)} stalled sessions`} icon={Activity} />
            </StatGrid>

            <StatGrid>
              <Stat label="Requests" value={formatCompact(analytics.request_count)} hint={`${formatBytes(analytics.bytes_served)} served`} icon={Database} />
              <Stat label="Cache hit" value={formatPercent(analytics.cache_hit_rate)} hint="Edge request rollup" icon={Signal} />
              <Stat label="Errors" value={formatPercent(analytics.error_rate)} hint={`${formatNumber(analytics.playback_failures)} player failures`} icon={Activity} />
              <Stat label="Edge latency" value={formatMs(analytics.request_p95_ms)} hint={`p50 ${formatMs(analytics.request_p50_ms)}`} icon={Gauge} />
            </StatGrid>

            <Panel title="Hourly trend" description="Rollup buckets for the selected window">
              {analytics.timeseries.length === 0 ? (
                <p className="text-[13.5px] text-muted">No hourly analytics yet.</p>
              ) : (
                <div className="flex h-40 items-end gap-1.5">
                  {analytics.timeseries.slice(-48).map((point) => {
                    const height = Math.max(4, Math.round((Math.max(point.views, point.request_count) / seriesMax) * 100));
                    return (
                      <div key={point.bucket_start} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                        <div className="flex h-28 w-full items-end rounded bg-bg-sunken px-1">
                          <div
                            className="w-full rounded-t bg-ink/80"
                            style={{ height: `${height}%` }}
                            title={`${formatBucket(point.bucket_start)}: ${formatNumber(point.views)} views, ${formatNumber(point.request_count)} requests`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>

            <Panel title="Top assets" flush={analytics.top_assets.length > 0}>
              {analytics.top_assets.length === 0 ? (
                <p className="text-[13.5px] text-muted">No viewed assets yet.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Asset</TH>
                      <TH className="text-right">Views</TH>
                      <TH className="text-right">Watch time</TH>
                      <TH className="hidden text-right md:table-cell">Requests</TH>
                      <TH className="hidden text-right md:table-cell">Served</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {analytics.top_assets.map((asset) => (
                      <TR key={asset.asset_id}>
                        <TD>
                          <Link
                            href={`/dashboard/assets/${asset.asset_id}`}
                            className="font-mono text-[12px] text-ink underline-offset-2 hover:underline"
                          >
                            {asset.asset_id}
                          </Link>
                        </TD>
                        <TD className="text-right font-mono text-[12px] tabular-nums text-ink-soft">
                          {formatNumber(asset.views)}
                        </TD>
                        <TD className="text-right font-mono text-[12px] tabular-nums text-ink-soft">
                          {formatWatchTime(asset.watch_time_ms)}
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
          </div>
        ) : null}
      </DashboardContent>
    </>
  );
}
