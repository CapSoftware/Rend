"use client";

import {
  Bot,
  ExternalLink,
  Flag,
  Globe,
  HelpCircle,
  Mail,
  MapPin,
  Megaphone,
  Monitor,
  Play,
  Search,
  Share2,
  Smartphone,
  Tablet,
  Tag,
  Tv,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import type { AnalyticsBreakdownRow } from "../../lib/asset-types.ts";
import { cn } from "@/components/ui/cn";
import { channelLabel, faviconUrl, formatNumber, formatWatchTime, monogram, titleCase } from "./format";
import { countryName, flagEmoji } from "./countries";

const WorldMap = dynamic(() => import("./WorldMap"), {
  ssr: false,
  loading: () => <div className="h-[280px] w-full animate-pulse rounded-lg bg-bg-sunken/60" />,
});

export type BreakdownKind =
  | "favicon"
  | "channel"
  | "flag"
  | "geo"
  | "browser"
  | "os"
  | "device"
  | "asset"
  | "plain";

export type BreakdownTabConfig = {
  key: string;
  label: string;
  kind: BreakdownKind;
  rows: AnalyticsBreakdownRow[];
  map?: boolean;
  assetHref?: (value: string) => string;
};

type Metric = "views" | "watch_time_ms";

const CHANNEL_ICONS: Record<string, LucideIcon> = {
  direct: Globe,
  referral: ExternalLink,
  organic_search: Search,
  social: Share2,
  email: Mail,
  paid: Megaphone,
  campaign: Flag,
};

const DEVICE_ICONS: Record<string, LucideIcon> = {
  desktop: Monitor,
  mobile: Smartphone,
  tablet: Tablet,
  tv: Tv,
  bot: Bot,
  unknown: HelpCircle,
};

function Monogram({ value, tone = "default" }: { value: string; tone?: "default" | "brand" }) {
  return (
    <span
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold",
        tone === "brand" ? "bg-accent/15 text-accent" : "bg-bg-sunken text-muted"
      )}
    >
      {monogram(value)}
    </span>
  );
}

function Favicon({ host }: { host: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !host) return <Monogram value={host || "?"} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={faviconUrl(host)}
      alt=""
      width={18}
      height={18}
      loading="lazy"
      className="size-[18px] shrink-0 rounded-[4px]"
      onError={() => setFailed(true)}
    />
  );
}

function IconBadge({ Icon, tone = "muted" }: { Icon: LucideIcon; tone?: "muted" | "brand" }) {
  return (
    <span
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-[5px]",
        tone === "brand" ? "bg-accent/12 text-accent" : "bg-bg-sunken text-muted"
      )}
    >
      <Icon className="size-3" />
    </span>
  );
}

function rowIcon(kind: BreakdownKind, value: string) {
  switch (kind) {
    case "favicon":
      return <Favicon host={value} />;
    case "channel":
      return <IconBadge Icon={CHANNEL_ICONS[value] ?? Globe} tone="brand" />;
    case "flag":
      return <span className="w-[18px] shrink-0 text-center text-[14px] leading-none">{flagEmoji(value)}</span>;
    case "geo":
      return <IconBadge Icon={MapPin} />;
    case "device":
      return <IconBadge Icon={DEVICE_ICONS[value] ?? HelpCircle} />;
    case "browser":
      return <Monogram value={value} tone="brand" />;
    case "os":
      return <Monogram value={value} />;
    case "asset":
      return <IconBadge Icon={Play} tone="brand" />;
    default:
      return <IconBadge Icon={Tag} />;
  }
}

function rowLabel(kind: BreakdownKind, value: string) {
  if (kind === "channel") return channelLabel(value);
  if (kind === "flag") return countryName(value);
  if (kind === "device" || kind === "os") return titleCase(value);
  return value;
}

export default function BreakdownPanel({
  title,
  tabs,
}: {
  title: string;
  tabs: BreakdownTabConfig[];
}) {
  const [activeKey, setActiveKey] = useState(tabs[0]?.key ?? "");
  const [metric, setMetric] = useState<Metric>("views");
  const active = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];

  const sortedRows = useMemo(() => {
    if (!active) return [];
    const rows = [...active.rows];
    rows.sort((a, b) =>
      metric === "views" ? b.views - a.views : b.watch_time_ms - a.watch_time_ms
    );
    return rows;
  }, [active, metric]);

  const max = useMemo(
    () =>
      sortedRows.reduce(
        (peak, row) => Math.max(peak, metric === "views" ? row.views : row.watch_time_ms),
        0
      ),
    [sortedRows, metric]
  );

  if (!active) return null;

  const metricValue = (row: AnalyticsBreakdownRow) =>
    metric === "views" ? row.views : row.watch_time_ms;
  const formatValue = (row: AnalyticsBreakdownRow) =>
    metric === "views" ? formatNumber(row.views) : formatWatchTime(row.watch_time_ms);

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveKey(tab.key)}
              className={cn(
                "shrink-0 whitespace-nowrap text-[12.5px] font-medium transition-colors",
                tab.key === active.key ? "text-ink" : "text-faint hover:text-muted"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center rounded-md border border-line bg-bg-sunken/60 p-0.5">
          {(["views", "watch_time_ms"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMetric(option)}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                metric === option ? "bg-card text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted hover:text-ink"
              )}
            >
              {option === "views" ? "Views" : "Watch"}
            </button>
          ))}
        </div>
      </div>

      {active.map ? (
        <div className="p-3">
          <WorldMap rows={active.rows} metric={metric} />
        </div>
      ) : sortedRows.length === 0 ? (
        <div className="flex h-[260px] items-center justify-center px-4">
          <p className="text-[13px] text-faint">No {title.toLowerCase()} data yet.</p>
        </div>
      ) : (
        <div className="flex flex-col px-1.5 py-1.5">
          {sortedRows.slice(0, 8).map((row) => {
            const pct = max > 0 ? Math.max(2, Math.round((metricValue(row) / max) * 100)) : 0;
            const label = rowLabel(active.kind, row.value);
            const content = (
              <>
                <div
                  className="absolute inset-y-1 left-1 rounded-md bg-accent/10"
                  style={{ width: `calc(${pct}% - 0.25rem)` }}
                  aria-hidden
                />
                <div className="relative z-10 flex min-w-0 items-center gap-2.5">
                  {rowIcon(active.kind, row.value)}
                  <span
                    className={cn(
                      "truncate text-[12.5px] text-ink-soft",
                      active.kind === "asset" && "font-mono text-[11.5px]"
                    )}
                  >
                    {label}
                  </span>
                </div>
                <span className="relative z-10 shrink-0 font-mono text-[12px] tabular-nums text-muted">
                  {formatValue(row)}
                </span>
              </>
            );
            const rowClass =
              "relative flex items-center justify-between gap-3 rounded-md px-2.5 py-2 transition-colors hover:bg-bg-sunken/40";
            return active.kind === "asset" && active.assetHref ? (
              <Link key={row.value} href={active.assetHref(row.value)} className={rowClass}>
                {content}
              </Link>
            ) : (
              <div key={row.value} className={rowClass}>
                {content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
