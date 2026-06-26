import type {
  AnalyticsAssetSummary,
  AnalyticsLive,
  AnalyticsOverview,
  AnalyticsTimeSeriesPoint,
} from "../../lib/asset-types.ts";

export const LIVE_WINDOW_SECONDS = 60 * 60;

export type LiveAnalyticsMeta = {
  activeSessions: number;
  fetchedAt: string;
  resolution: NonNullable<AnalyticsLive["resolution"]>;
  viewsLastMinute: number;
};

function pointMillis(point: { bucket_start: string }) {
  const millis = Date.parse(point.bucket_start);
  return Number.isFinite(millis) ? millis : null;
}

function baselinePointByBucket(baseline?: AnalyticsOverview) {
  const map = new Map<number, AnalyticsTimeSeriesPoint>();
  for (const point of baseline?.timeseries ?? []) {
    const millis = pointMillis(point);
    if (millis !== null) map.set(millis, point);
  }
  return map;
}

function baselineAssetById(baseline?: AnalyticsOverview) {
  const map = new Map<string, AnalyticsAssetSummary>();
  for (const asset of baseline?.top_assets ?? []) map.set(asset.asset_id, asset);
  return map;
}

function liveTimeseries(live: AnalyticsLive, baseline?: AnalyticsOverview): AnalyticsTimeSeriesPoint[] {
  const baselineByBucket = baselinePointByBucket(baseline);
  return live.timeseries.map((point) => {
    const millis = pointMillis(point);
    const baselinePoint = millis === null ? undefined : baselineByBucket.get(millis);
    return {
      bucket_start: point.bucket_start,
      views: point.views,
      watch_time_ms: point.watch_time_ms,
      request_count: baselinePoint?.request_count ?? 0,
      bytes_served: baselinePoint?.bytes_served ?? 0,
    };
  });
}

function liveTopAssets(live: AnalyticsLive, baseline?: AnalyticsOverview): AnalyticsAssetSummary[] {
  const baselineByAsset = baselineAssetById(baseline);
  if (live.recent_assets.length === 0) return baseline?.top_assets ?? [];

  return live.recent_assets.map((asset) => {
    const baselineAsset = baselineByAsset.get(asset.asset_id);
    return {
      asset_id: asset.asset_id,
      views: asset.views,
      watch_time_ms: baselineAsset?.watch_time_ms ?? 0,
      request_count: baselineAsset?.request_count ?? 0,
      bytes_served: baselineAsset?.bytes_served ?? 0,
    };
  });
}

export function overviewFromLiveAnalytics(
  live: AnalyticsLive,
  baseline?: AnalyticsOverview | null
): AnalyticsOverview {
  const baselineAnalytics = baseline ?? undefined;
  const timeseries = liveTimeseries(live, baselineAnalytics);
  const startupAttempts =
    (baselineAnalytics?.views ?? live.views) + (baselineAnalytics?.playback_failures ?? 0);

  return {
    window_started_at: live.window_started_at,
    window_ended_at: live.window_ended_at,
    views: live.views,
    unique_viewers: live.unique_viewers,
    sessions: Math.max(live.active_sessions, baselineAnalytics?.sessions ?? live.unique_viewers),
    watch_time_ms: live.watch_time_ms,
    startup_success_rate:
      baselineAnalytics?.startup_success_rate ?? (startupAttempts > 0 ? live.views / startupAttempts : 0),
    startup_p50_ms: baselineAnalytics?.startup_p50_ms,
    startup_p95_ms: baselineAnalytics?.startup_p95_ms,
    rebuffer_ratio: baselineAnalytics?.rebuffer_ratio ?? 0,
    stalled_sessions: baselineAnalytics?.stalled_sessions ?? 0,
    stall_count: baselineAnalytics?.stall_count ?? 0,
    stall_duration_ms: baselineAnalytics?.stall_duration_ms ?? 0,
    playback_failures: baselineAnalytics?.playback_failures ?? 0,
    exits_before_start: baselineAnalytics?.exits_before_start ?? 0,
    completions: baselineAnalytics?.completions ?? 0,
    request_count: baselineAnalytics?.request_count ?? 0,
    bytes_served: baselineAnalytics?.bytes_served ?? 0,
    cache_hit_rate: baselineAnalytics?.cache_hit_rate ?? 0,
    error_rate: baselineAnalytics?.error_rate ?? 0,
    request_p50_ms: baselineAnalytics?.request_p50_ms,
    request_p95_ms: baselineAnalytics?.request_p95_ms,
    timeseries: timeseries.length > 0 ? timeseries : baselineAnalytics?.timeseries ?? [],
    top_assets: liveTopAssets(live, baselineAnalytics),
    breakdowns: baselineAnalytics?.breakdowns ?? [],
    previous: baselineAnalytics?.previous,
  };
}

export function liveMetaFromAnalytics(live: AnalyticsLive): LiveAnalyticsMeta {
  return {
    activeSessions: live.active_sessions,
    fetchedAt: live.fetched_at,
    resolution: live.resolution ?? "minute",
    viewsLastMinute: live.views_last_minute,
  };
}

export function viewsInLastMinutes(
  timeseries: AnalyticsTimeSeriesPoint[],
  minutes: number,
  nowMs = Date.now()
) {
  const cutoff = nowMs - minutes * 60_000;
  let views = 0;
  for (const point of timeseries) {
    const bucketMs = pointMillis(point);
    if (bucketMs !== null && bucketMs >= cutoff) views += point.views;
  }
  return views;
}

export function formatLiveActivityLabel(
  meta: LiveAnalyticsMeta,
  timeseries: AnalyticsTimeSeriesPoint[],
  nowMs = Date.now()
) {
  const recentViews = viewsInLastMinutes(timeseries, 2, nowMs);
  if (recentViews > 0) {
    return `${recentViews.toLocaleString()} ${recentViews === 1 ? "view" : "views"} in the last 2 min`;
  }
  if (meta.activeSessions > 0) {
    return `${meta.activeSessions.toLocaleString()} watching now`;
  }
  return "Quiet in the last 2 min";
}
