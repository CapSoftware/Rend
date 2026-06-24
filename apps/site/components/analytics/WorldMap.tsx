"use client";

import { geoEqualEarth, geoPath } from "d3-geo";
import { useMemo, useState } from "react";
import { feature } from "topojson-client";
// world-atlas ships ISO-numeric feature ids; see countries.ts for the join.
import worldData from "world-atlas/countries-110m.json";
import type { AnalyticsBreakdownRow } from "../../lib/asset-types.ts";
import { numericForAlpha2 } from "./countries";
import { formatNumber, formatWatchTime } from "./format";

const WIDTH = 800;
const HEIGHT = 415;
const EMPTY_FILL = "#efece4";
const STROKE = "#fcfbf8";
// Light wheat -> brand gold ramp.
const RAMP_FROM = "#f0e0bd";
const RAMP_TO = "#a9781f";

type WorldFeature = {
  id: string | number;
  properties: { name?: string };
};

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ] as const;
}

function mix(from: string, to: string, t: number) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const channel = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

export default function WorldMap({
  rows,
  metric,
}: {
  rows: AnalyticsBreakdownRow[];
  metric: "views" | "watch_time_ms";
}) {
  const [hover, setHover] = useState<{ name: string; flag: string; views: number; watch: number; x: number; y: number } | null>(null);

  const { features, path } = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collection = feature(worldData as any, (worldData as any).objects.countries) as unknown as {
      type: "FeatureCollection";
      features: WorldFeature[];
    };
    const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], collection as never);
    return { features: collection.features, path: geoPath(projection) };
  }, []);

  const byNumeric = useMemo(() => {
    const map = new Map<string, { views: number; watch: number }>();
    for (const row of rows) {
      const numeric = numericForAlpha2(row.value);
      if (!numeric) continue;
      map.set(numeric, { views: row.views, watch: row.watch_time_ms });
    }
    return map;
  }, [rows]);

  const max = useMemo(() => {
    let value = 0;
    for (const row of rows) {
      const metricValue = metric === "views" ? row.views : row.watch_time_ms;
      if (metricValue > value) value = metricValue;
    }
    return value;
  }, [rows, metric]);

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label="Views by country">
        <g>
          {features.map((country, index) => {
            const numeric = country.id == null ? "" : String(country.id).padStart(3, "0");
            const datum = numeric ? byNumeric.get(numeric) : undefined;
            const metricValue = datum ? (metric === "views" ? datum.views : datum.watch) : 0;
            const t = max > 0 && metricValue > 0 ? Math.sqrt(metricValue / max) : 0;
            const fill = metricValue > 0 ? mix(RAMP_FROM, RAMP_TO, 0.15 + t * 0.85) : EMPTY_FILL;
            const d = path(country as never) ?? undefined;
            if (!d) return null;
            return (
              <path
                key={`${country.id ?? "x"}-${index}`}
                d={d}
                fill={fill}
                stroke={STROKE}
                strokeWidth={0.5}
                className="transition-[fill] duration-150"
                onMouseEnter={(event) => {
                  const rect = (event.currentTarget.ownerSVGElement?.parentElement as HTMLElement)?.getBoundingClientRect();
                  setHover({
                    name: country.properties.name ?? "Unknown",
                    flag: "",
                    views: datum?.views ?? 0,
                    watch: datum?.watch ?? 0,
                    x: rect ? event.clientX - rect.left : 0,
                    y: rect ? event.clientY - rect.top : 0,
                  });
                }}
                onMouseMove={(event) => {
                  setHover((current) => {
                    if (!current) return current;
                    const rect = (event.currentTarget.ownerSVGElement?.parentElement as HTMLElement)?.getBoundingClientRect();
                    return { ...current, x: rect ? event.clientX - rect.left : current.x, y: rect ? event.clientY - rect.top : current.y };
                  });
                }}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </g>
      </svg>
      {hover ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] whitespace-nowrap rounded-lg border border-line bg-card px-2.5 py-1.5 text-[12px] shadow-[0_12px_32px_-16px_rgba(22,21,19,0.45)]"
          style={{ left: hover.x, top: hover.y }}
        >
          <span className="font-medium text-ink">{hover.name}</span>
          <span className="ml-2 font-mono tabular-nums text-muted">
            {hover.views > 0 || hover.watch > 0
              ? `${formatNumber(hover.views)} views · ${formatWatchTime(hover.watch)}`
              : "No views"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
