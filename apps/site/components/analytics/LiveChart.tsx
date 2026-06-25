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
import { formatCompact, formatNumber, formatWatchTime } from "./format";

export type LiveChartPoint = {
  key: string;
  label: string;
  views: number;
  watch_time_ms: number;
};

const VIEWS_COLOR = "#14b8a6";
const WATCH_COLOR = "#6366f1";

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: LiveChartPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2 shadow-[0_12px_32px_-16px_rgba(22,21,19,0.45)]">
      <p className="mb-1.5 text-[12px] font-medium text-ink">{point.label}</p>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-6 text-[12px]">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="size-2 rounded-full" style={{ background: VIEWS_COLOR }} />
            Views
          </span>
          <span className="font-mono tabular-nums text-ink-soft">{formatNumber(point.views)}</span>
        </div>
        <div className="flex items-center justify-between gap-6 text-[12px]">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="size-2 rounded-[3px]" style={{ background: WATCH_COLOR }} />
            Watch time
          </span>
          <span className="font-mono tabular-nums text-ink-soft">{formatWatchTime(point.watch_time_ms)}</span>
        </div>
      </div>
    </div>
  );
}

export default function LiveChart({ data }: { data: LiveChartPoint[] }) {
  const maxViews = Math.max(1, ...data.map((point) => point.views));
  const chartData = data.map((point) => ({
    ...point,
    watch_minutes: Math.round(point.watch_time_ms / 60_000),
    pulse: point.views / maxViews,
  }));

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={chartData} margin={{ top: 12, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
          <defs>
            <linearGradient id="rend-live-views-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={VIEWS_COLOR} stopOpacity={0.35} />
              <stop offset="100%" stopColor={VIEWS_COLOR} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="rend-live-glow" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={VIEWS_COLOR} stopOpacity={0} />
              <stop offset="50%" stopColor={VIEWS_COLOR} stopOpacity={0.15} />
              <stop offset="100%" stopColor={VIEWS_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" strokeDasharray="0" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: "rgba(255,255,255,0.35)" }}
            minTickGap={32}
            dy={8}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="left"
            width={36}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: "rgba(255,255,255,0.35)" }}
            tickFormatter={(value: number) => (value === 0 ? "0" : formatCompact(value))}
            allowDecimals={false}
          />
          <YAxis yAxisId="right" orientation="right" width={0} hide />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
          <Bar
            yAxisId="right"
            dataKey="watch_minutes"
            fill={WATCH_COLOR}
            radius={[2, 2, 0, 0]}
            maxBarSize={8}
            opacity={0.55}
            isAnimationActive={false}
          />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="views"
            stroke={VIEWS_COLOR}
            strokeWidth={2}
            fill="url(#rend-live-views-fill)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0, fill: VIEWS_COLOR }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-3 flex h-8 items-end gap-[2px] px-1">
        {chartData.map((point) => (
          <div
            key={point.key}
            className="min-w-0 flex-1 rounded-sm bg-[#14b8a6]/20 transition-[height,background-color] duration-500 ease-out"
            style={{
              height: `${Math.max(8, point.pulse * 100)}%`,
              backgroundColor: point.views > 0 ? `rgba(20, 184, 166, ${0.25 + point.pulse * 0.55})` : undefined,
            }}
            title={`${point.label}: ${formatNumber(point.views)} views`}
          />
        ))}
      </div>
    </div>
  );
}
