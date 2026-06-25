"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalyticsLive } from "../../lib/asset-types.ts";
import { cn } from "@/components/ui/cn";
import { formatNumber, formatWatchTime } from "./format";
import type { LiveChartPoint } from "./LiveChart";

const LiveChart = dynamic(() => import("./LiveChart"), {
  ssr: false,
  loading: () => <div className="h-[320px] w-full animate-pulse rounded-lg bg-white/[0.04]" />,
});

const minuteFormatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function formatUpdatedAgo(fetchedAt: string) {
  const deltaMs = Date.now() - new Date(fetchedAt).getTime();
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function AnimatedNumber({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const displayRef = useRef(display);
  displayRef.current = display;

  useEffect(() => {
    const start = displayRef.current;
    if (start === value) return;
    const delta = value - start;
    const started = performance.now();
    const duration = 420;

    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(Math.round(start + delta * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{formatNumber(display)}</>;
}

function LiveMetric({
  label,
  value,
  suffix,
  accent,
  large,
}: {
  label: string;
  value: number | string;
  suffix?: string;
  accent?: boolean;
  large?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3.5 backdrop-blur-sm">
      <div
        className={cn(
          "pointer-events-none absolute -right-6 -top-6 size-24 rounded-full blur-2xl",
          accent ? "bg-[#14b8a6]/20" : "bg-white/[0.04]"
        )}
      />
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/45">{label}</p>
      <p
        className={cn(
          "mt-2 font-semibold tabular-nums tracking-tight text-white",
          large ? "text-[32px] leading-none sm:text-[38px]" : "text-[22px] leading-none"
        )}
      >
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
        {suffix ? <span className="ml-1 text-[0.55em] font-medium text-white/50">{suffix}</span> : null}
      </p>
    </div>
  );
}

export default function LiveView({
  live,
  loading,
}: {
  live: AnalyticsLive;
  loading: boolean;
}) {
  const [, tick] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const chartData = useMemo((): LiveChartPoint[] => {
    return live.timeseries.map((point) => {
      const date = new Date(point.bucket_start);
      return {
        key: point.bucket_start,
        label: minuteFormatter.format(date),
        views: point.views,
        watch_time_ms: point.watch_time_ms,
      };
    });
  }, [live.timeseries]);

  const hasTraffic = live.views > 0 || live.active_sessions > 0;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-[#0c1117] text-white shadow-[0_24px_80px_-32px_rgba(0,0,0,0.55)]">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(ellipse_80%_60%_at_50%_-20%,rgba(20,184,166,0.18),transparent)]"
        aria-hidden
      />
      <div className="relative border-b border-white/[0.06] px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#14b8a6] opacity-40 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2.5 rounded-full bg-[#14b8a6] shadow-[0_0_12px_rgba(20,184,166,0.8)]" />
            </span>
            <div>
              <p className="text-[13px] font-semibold tracking-wide text-white">Live</p>
              <p className="text-[11.5px] text-white/45">Last 60 minutes, minute buckets</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11.5px] text-white/40">
            <span className={cn("size-1.5 rounded-full", loading ? "bg-amber-400" : "bg-[#14b8a6]")} />
            Updated {formatUpdatedAgo(live.fetched_at)}
            {loading ? " · syncing" : null}
          </div>
        </div>
      </div>

      <div className="relative grid gap-3 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
        <LiveMetric label="Watching now" value={live.active_sessions} accent large />
        <LiveMetric label="Views this minute" value={live.views_last_minute} />
        <LiveMetric label="Views last hour" value={live.views} />
        <LiveMetric label="Watch time last hour" value={formatWatchTime(live.watch_time_ms)} />
      </div>

      <div className="relative border-t border-white/[0.06] px-2 py-4 sm:px-4">
        {!hasTraffic ? (
          <div className="flex h-[320px] flex-col items-center justify-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.03]">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/30 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-white/50" />
              </span>
            </div>
            <p className="text-[13.5px] font-medium text-white/70">Waiting for viewers</p>
            <p className="max-w-sm text-[12.5px] text-white/40">
              Playback will show up here within a minute of the first view. This panel polls lightly every 20 seconds.
            </p>
          </div>
        ) : (
          <LiveChart data={chartData} />
        )}
      </div>

      {live.recent_assets.length > 0 ? (
        <div className="border-t border-white/[0.06] px-4 py-4 sm:px-5">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-white/40">Trending now</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {live.recent_assets.map((asset, index) => (
              <Link
                key={asset.asset_id}
                href={`/dashboard/assets/${asset.asset_id}`}
                className="group flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-[#14b8a6]/30 hover:bg-[#14b8a6]/[0.06]"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-white/[0.06] font-mono text-[10px] tabular-nums text-white/50">
                    {index + 1}
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-white/75 group-hover:text-white">
                    {asset.asset_id}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-[#14b8a6]">
                  {formatNumber(asset.views)} views
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="border-t border-white/[0.06] px-4 py-2.5 sm:px-5">
        <p className="text-[11px] text-white/30">
          {formatNumber(live.unique_viewers)} unique viewers in the last hour · lightweight poll, one query per refresh
        </p>
      </div>
    </div>
  );
}
