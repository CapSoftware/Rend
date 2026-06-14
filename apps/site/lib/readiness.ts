import { readFile } from "node:fs/promises";
import path from "node:path";

type Env = Record<string, string | undefined>;

export type PlaybackReadinessStatus = "pass" | "warn" | "fail";

export type PlaybackReadinessEdge = {
  edge_id: string;
  region: string;
};

export type PlaybackReadinessTiming = {
  ttfb_ms?: number;
  total_ms?: number;
  cache_status?: string;
  byte_size?: number;
};

export type PlaybackReadinessArtifactTimings = {
  cold_miss?: PlaybackReadinessTiming;
  second_view_hit?: PlaybackReadinessTiming;
  warmed_hit?: PlaybackReadinessTiming;
  post_warm_second_view_hit?: PlaybackReadinessTiming;
};

export type PlaybackReadinessEdgeResult = PlaybackReadinessEdge & {
  timings?: {
    opener?: PlaybackReadinessArtifactTimings;
    manifest?: PlaybackReadinessArtifactTimings;
    segment?: PlaybackReadinessArtifactTimings;
  };
  cache_mix?: Record<string, number>;
  telemetry?: {
    queued_delta?: number;
    sent_delta?: number;
    spooled_delta?: number;
    dropped_delta?: number;
    spool_bytes_after?: number;
  };
  bytes_per_delivered_minute_proxy?: {
    bytes_per_delivered_minute?: number;
    sampled_views?: number;
  };
};

export type PlaybackReadinessFixture = {
  name: string;
  synthetic: boolean;
  metrics?: Array<{
    name: string;
    value_ms?: number;
    status?: PlaybackReadinessStatus;
  }>;
  edges?: PlaybackReadinessEdgeResult[];
  telemetry_visibility?: {
    visibility_ms?: number;
    request_count?: number;
    bytes_served?: number;
    cache_status_counts?: Record<string, number>;
  };
};

export type PlaybackReadinessResult = {
  schema_version: number;
  gate: string;
  run_id: string;
  status: PlaybackReadinessStatus;
  started_at: string;
  ended_at: string;
  target: string;
  synthetic_only: boolean;
  edges: PlaybackReadinessEdge[];
  fixtures: PlaybackReadinessFixture[];
  cache_mix?: Record<string, number>;
  telemetry_health?: {
    visibility_ms_max?: number;
    request_count?: number;
    bytes_served?: number;
    edge_spooled_delta?: number;
    edge_dropped_delta?: number;
    edge_spool_bytes_after?: number;
  };
  cleanup?: {
    status?: string;
    records?: Array<{ status?: string }>;
  };
  warnings?: unknown[];
  failures?: unknown[];
};

export type LatestPlaybackReadiness =
  | { available: true; path: string; result: PlaybackReadinessResult }
  | { available: false; path: string; reason: "missing" | "invalid" };

const DEFAULT_READINESS_PATH = ".rend/readiness/playback-readiness-latest.json";

function defaultArtifactPath() {
  const cwd = process.cwd();
  const inSiteApp = path.basename(cwd) === "site" && path.basename(path.dirname(cwd)) === "apps";
  return path.resolve(cwd, inSiteApp ? `../../${DEFAULT_READINESS_PATH}` : DEFAULT_READINESS_PATH);
}

export function playbackReadinessArtifactPath(env: Env = process.env) {
  const configured = (env.REND_READINESS_ARTIFACT_PATH || env.REND_READINESS_LATEST_OUTPUT || "").trim();
  if (!configured) return defaultArtifactPath();
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function isReadinessStatus(value: unknown): value is PlaybackReadinessStatus {
  return value === "pass" || value === "warn" || value === "fail";
}

function parseReadinessResult(raw: string): PlaybackReadinessResult | null {
  const value = JSON.parse(raw) as Partial<PlaybackReadinessResult>;
  if (
    value.schema_version !== 1 ||
    value.gate !== "rend-playback-production-readiness" ||
    typeof value.run_id !== "string" ||
    !isReadinessStatus(value.status) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.fixtures)
  ) {
    return null;
  }
  return value as PlaybackReadinessResult;
}

export async function latestPlaybackReadinessResult(
  env: Env = process.env
): Promise<LatestPlaybackReadiness> {
  const artifactPath = playbackReadinessArtifactPath(env);
  try {
    const raw = await readFile(artifactPath, "utf8");
    const result = parseReadinessResult(raw);
    return result
      ? { available: true, path: artifactPath, result }
      : { available: false, path: artifactPath, reason: "invalid" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { available: false, path: artifactPath, reason: "missing" };
    }
    return { available: false, path: artifactPath, reason: "invalid" };
  }
}
