"use client";

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatBytes, formatCompact, formatNumber, formatWatchTime, watchHours } from "./format";

export type OverviewChartPoint = {
  key: string;
  label: string;
  views: number;
  watch_time_ms: number;
  request_count: number;
  bytes_served: number;
};

const VIEWS_COLOR = "#2f6fed";
const WATCH_COLOR = "#e08a5e";

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: OverviewChartPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const rows: Array<{ label: string; value: string; color?: string }> = [
    { label: "Views", value: formatNumber(point.views), color: VIEWS_COLOR },
    { label: "Watch time", value: formatWatchTime(point.watch_time_ms), color: WATCH_COLOR },
    { label: "Requests", value: formatNumber(point.request_count) },
    { label: "Delivered", value: formatBytes(point.bytes_served) },
  ];
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2 shadow-[0_12px_32px_-16px_rgba(22,21,19,0.45)]">
      <p className="mb-1.5 text-[12px] font-medium text-ink">{point.label}</p>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-6 text-[12px]">
            <span className="flex items-center gap-1.5 text-muted">
              <span
                className="size-2 rounded-[3px]"
                style={{ background: row.color ?? "transparent", outline: row.color ? "none" : "1px solid var(--color-line)" }}
              />
              {row.label}
            </span>
            <span className="font-mono tabular-nums text-ink-soft">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function OverviewChart({ data }: { data: OverviewChartPoint[] }) {
  const chartData = data.map((point) => ({ ...point, watch_hours: watchHours(point.watch_time_ms) }));
  const hasWatch = chartData.some((point) => point.watch_hours > 0);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
        <defs>
          <linearGradient id="rend-views-fill" x1="0" y1="0" x2="0" y2="1">
            <stop key="a" offset="0%" stopColor={VIEWS_COLOR} stopOpacity={0.2} />
            <stop key="b" offset="100%" stopColor={VIEWS_COLOR} stopOpacity={0.015} />
          </linearGradient>
        </defs>
        <CartesianGrid key="grid" vertical={false} stroke="var(--color-line-soft)" strokeDasharray="0" />
        <XAxis
          key="x"
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "var(--color-faint)" }}
          minTickGap={28}
          dy={8}
        />
        <YAxis
          key="y-left"
          yAxisId="left"
          width={44}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "var(--color-faint)" }}
          tickFormatter={(value: number) => (value === 0 ? "0" : formatCompact(value))}
          allowDecimals={false}
        />
        <YAxis
          key="y-right"
          yAxisId="right"
          orientation="right"
          width={hasWatch ? 44 : 0}
          hide={!hasWatch}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "var(--color-faint)" }}
          tickFormatter={(value: number) => (value === 0 ? "" : `${formatCompact(value)}h`)}
        />
        <Tooltip
          key="tooltip"
          content={<ChartTooltip />}
          cursor={{ fill: "var(--color-bg-sunken)", opacity: 0.6 }}
        />
        <Bar
          key="bar"
          yAxisId="right"
          dataKey="watch_hours"
          fill={WATCH_COLOR}
          radius={[3, 3, 0, 0]}
          maxBarSize={26}
          isAnimationActive={false}
        />
        <Area
          key="area"
          yAxisId="left"
          type="monotone"
          dataKey="views"
          stroke={VIEWS_COLOR}
          strokeWidth={2}
          fill="url(#rend-views-fill)"
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0, fill: VIEWS_COLOR }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
