"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  generatePlaybackSessionId,
  readableTelemetryHeaders,
  REND_PLAYER_VERSION,
  sendPlayerTelemetryEvent,
  telemetryLabelsFromHeaders,
} from "./telemetry";
import {
  hlsSource,
  openerSource,
  selectedSource,
  type SourceSelection,
} from "./source-selection";
import type {
  RendPlayerPlaybackMode,
  RendPlayerTelemetryEvent,
  RendPlayerTelemetryInput,
} from "./telemetry";

export type PlaybackPrefetchHint = {
  artifact_path: string;
  url: string;
  content_type: string;
};

export type PlaybackBootstrapReady = {
  status: "ready";
  asset_id: string;
  source_state: string;
  playable_state: "opener_ready" | "hls_ready" | string;
  playback_url?: string;
  playback_content_type?: string;
  playback_token_expires_at: number;
  ttl_seconds: number;
  opener_url?: string;
  opener_content_type?: string;
  manifest_url?: string;
  manifest_content_type?: string;
  prefetch_hints: PlaybackPrefetchHint[];
};

export type PlaybackBootstrapResponse =
  | PlaybackBootstrapReady
  | {
      status: "not_playable";
      asset_id: string;
      source_state?: string;
      playable_state?: string;
      message: string;
    }
  | {
      status: "unavailable";
      asset_id: string;
      message: string;
    }
  | {
      status: "error";
      asset_id: string;
      message: string;
    };

export type RendPlayerState =
  | "idle"
  | "loading"
  | "ready"
  | "metadata"
  | "canplay"
  | "playing"
  | "not_playable"
  | "unavailable"
  | "token_expired"
  | "playback_failure"
  | "bootstrap_failure";

export type RendPlayerTimings = {
  bootstrapMs?: number;
  metadataMs?: number;
  canplayMs?: number;
  firstFrameMs?: number;
};

export type RendPlayerProps = {
  assetId: string;
  bootstrapUrl?: string;
  autoPlay?: boolean;
  muted?: boolean;
  controls?: boolean;
  poster?: string;
  preload?: "auto" | "metadata" | "none";
  className?: string;
  maxPrefetchHints?: number;
  telemetryEnabled?: boolean;
  telemetryUrl?: string;
  telemetryAppVersion?: string;
  onTelemetryEvent?: (event: RendPlayerTelemetryEvent) => void;
  onStateChange?: (state: RendPlayerState) => void;
  onTimingsChange?: (timings: RendPlayerTimings) => void;
};

type HlsInstance = {
  autoLevelEnabled?: boolean;
  currentLevel?: number;
  levels?: HlsLevel[];
  loadSource(source: string): void;
  attachMedia(media: HTMLMediaElement): void;
  startLoad(startPosition?: number): void;
  destroy(): void;
  on(
    event: string,
    callback: (
      _event: string,
      data: HlsEventData
    ) => void
  ): void;
};

type HlsConstructor = {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
  Events: {
    ERROR: string;
    FRAG_LOADED: string;
    LEVEL_SWITCHED: string;
    MANIFEST_PARSED: string;
  };
};

type HlsLevel = {
  bitrate?: number;
  height?: number;
  width?: number;
};

type HlsEventData = {
  details?: string;
  fatal?: boolean;
  frag?: {
    duration?: number;
    sn?: number | string;
    stats?: HlsFragmentStats;
  };
  level?: number;
  levels?: HlsLevel[];
  response?: { code?: number };
  stats?: HlsFragmentStats;
  type?: string;
};

type HlsFragmentStats = {
  loaded?: number;
  loading?: {
    end?: number;
    first?: number;
    start?: number;
  };
  tload?: number;
  trequest?: number;
};

type PreparedHlsSource = ManifestObjectUrlResult & {
  hls?: HlsInstance;
  objectUrl?: string;
  selection: SourceSelection;
};

type HlsStats = {
  bitrate?: number;
  height?: number;
  level?: number;
  width?: number;
};

type ManifestObjectUrlResult = {
  sourceUrl: string;
  cacheHeaders?: Record<string, string>;
  edgeLabel?: string;
  httpStatus: number;
  regionLabel?: string;
};

class PlaybackLoadError extends Error {
  cacheHeaders?: Record<string, string>;
  code: string;
  edgeLabel?: string;
  httpStatus?: number;
  regionLabel?: string;

  constructor(
    code: string,
    message: string,
    options: {
      cacheHeaders?: Record<string, string>;
      edgeLabel?: string;
      httpStatus?: number;
      regionLabel?: string;
    } = {}
  ) {
    super(message);
    this.name = "PlaybackLoadError";
    this.code = code;
    this.cacheHeaders = options.cacheHeaders;
    this.edgeLabel = options.edgeLabel;
    this.httpStatus = options.httpStatus;
    this.regionLabel = options.regionLabel;
  }
}

const DEFAULT_MAX_PREFETCH_HINTS = 2;
const HLS_HANDOFF_MIN_PLAYED_SECONDS = 0.75;
const HLS_HANDOFF_NEAR_OPENER_END_SECONDS = 1.25;

const HLS_STARTUP_CONFIG = {
  abrEwmaDefaultEstimate: 1_200_000,
  capLevelOnFPSDrop: true,
  capLevelToPlayerSize: true,
  maxBufferLength: 12,
  maxMaxBufferLength: 30,
  startFragPrefetch: true,
  startLevel: -1,
  testBandwidth: true,
};

function isNativeHlsSupported(video: HTMLVideoElement) {
  return Boolean(
    video.canPlayType("application/vnd.apple.mpegurl") ||
      video.canPlayType("application/x-mpegURL")
  );
}

function isTokenExpired(data: PlaybackBootstrapReady | null) {
  if (!data?.playback_token_expires_at) return false;
  return Math.floor(Date.now() / 1000) >= data.playback_token_expires_at;
}

function signedHlsLine(line: string, baseUrl: URL, token: string | null) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return line;

  const segmentUrl = new URL(trimmed, baseUrl);
  if (token && !segmentUrl.searchParams.has("token")) {
    segmentUrl.searchParams.set("token", token);
  }
  return segmentUrl.toString();
}

async function signedHlsManifestObjectUrl(manifestUrl: string, signal?: AbortSignal) {
  const parsedManifestUrl = new URL(manifestUrl, window.location.href);
  const token = parsedManifestUrl.searchParams.get("token");
  const response = await fetch(parsedManifestUrl.toString(), { signal });
  const cacheHeaders = readableTelemetryHeaders(response.headers);
  const labels = telemetryLabelsFromHeaders(response.headers);

  if (!response.ok) {
    throw new PlaybackLoadError(
      "hls_manifest_http_error",
      `HLS manifest failed with HTTP ${response.status}`,
      {
        cacheHeaders,
        edgeLabel: labels.edge_label,
        httpStatus: response.status,
        regionLabel: labels.region_label,
      }
    );
  }

  const manifest = await response.text();
  const signedManifest = manifest
    .split(/\r?\n/)
    .map((line) => signedHlsLine(line, parsedManifestUrl, token))
    .join("\n");

  return {
    sourceUrl: URL.createObjectURL(
      new Blob([signedManifest], { type: "application/vnd.apple.mpegurl" })
    ),
    cacheHeaders,
    edgeLabel: labels.edge_label,
    httpStatus: response.status,
    regionLabel: labels.region_label,
  } satisfies ManifestObjectUrlResult;
}

function stateLabel(state: RendPlayerState) {
  switch (state) {
    case "loading":
      return "Loading";
    case "ready":
      return "Ready";
    case "metadata":
      return "Metadata loaded";
    case "canplay":
      return "Can play";
    case "playing":
      return "Playing";
    case "not_playable":
      return "Not playable yet";
    case "unavailable":
      return "Unavailable";
    case "token_expired":
      return "Token expired";
    case "playback_failure":
      return "Playback failed";
    case "bootstrap_failure":
      return "Could not load playback";
    default:
      return "Idle";
  }
}

function isUnavailableState(state: RendPlayerState) {
  return (
    state === "not_playable" ||
    state === "unavailable" ||
    state === "token_expired" ||
    state === "playback_failure" ||
    state === "bootstrap_failure"
  );
}

function playbackLoadErrorFields(error: unknown, fallbackCode: string, fallbackReason: string) {
  if (error instanceof PlaybackLoadError) {
    return {
      cache_headers: error.cacheHeaders,
      edge_label: error.edgeLabel,
      playback_failure_code: error.code,
      playback_failure_reason: error.message,
      region_label: error.regionLabel,
    };
  }

  return {
    playback_failure_code: fallbackCode,
    playback_failure_reason: fallbackReason,
  };
}

function selectionTelemetryFields(selection: SourceSelection | null) {
  if (!selection) return {};
  return {
    selected_artifact_path: selection.artifactPath,
    selected_playback_mode: selection.label,
  };
}

function hlsFailureReason(errorData: { details?: string; response?: { code?: number }; type?: string }) {
  const parts = [errorData.type, errorData.details].filter(Boolean);
  if (errorData.response?.code) parts.push(`HTTP ${errorData.response.code}`);
  return parts.length > 0 ? parts.join(": ") : "Fatal hls.js playback error";
}

function roundedMs(value: number) {
  return Math.max(0, Math.round(value));
}

function hlsLevelStats(hls: HlsInstance | null | undefined, levelIndex: number | undefined) {
  if (!hls || levelIndex === undefined || levelIndex < 0) return {};
  const level = hls.levels?.[levelIndex];
  if (!level) return {};
  return {
    hls_level_index: levelIndex,
    selected_bitrate: level.bitrate,
    selected_height: level.height,
    selected_width: level.width,
  };
}

function hlsStatsFromVideo(video: HTMLVideoElement | null): HlsStats {
  if (!video) return {};
  return {
    height: video.videoHeight || undefined,
    width: video.videoWidth || undefined,
  };
}

function hlsStatsTelemetryFields(stats: HlsStats) {
  return {
    hls_level_index: stats.level,
    selected_bitrate: stats.bitrate,
    selected_height: stats.height,
    selected_width: stats.width,
  };
}

function hlsFragmentLoadMs(stats: HlsFragmentStats | undefined) {
  if (!stats) return undefined;
  if (typeof stats.loading?.start === "number" && typeof stats.loading?.end === "number") {
    return roundedMs(stats.loading.end - stats.loading.start);
  }
  if (typeof stats.trequest === "number" && typeof stats.tload === "number") {
    return roundedMs(stats.tload - stats.trequest);
  }
  return undefined;
}

export function RendPlayer({
  assetId,
  bootstrapUrl,
  autoPlay = false,
  muted = true,
  controls = true,
  poster,
  preload = "auto",
  className,
  maxPrefetchHints = DEFAULT_MAX_PREFETCH_HINTS,
  telemetryEnabled,
  telemetryUrl,
  telemetryAppVersion,
  onTelemetryEvent,
  onStateChange,
  onTimingsChange,
}: RendPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const manifestObjectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadStartedAtRef = useRef<number>(0);
  const loadGenerationRef = useRef(0);
  const timingsRef = useRef<RendPlayerTimings>({});
  const triedOpenerFallbackRef = useRef(false);
  const hlsPreparationRef = useRef<Promise<PreparedHlsSource | null> | null>(null);
  const hlsHandoffStartedRef = useRef(false);
  const selectionRef = useRef<SourceSelection | null>(null);
  const hlsStatsRef = useRef<HlsStats>({});
  const activeStallRef = useRef<{ reason: string; startMs: number } | null>(null);
  const [state, setState] = useState<RendPlayerState>("idle");
  const [message, setMessage] = useState("Loading playback");
  const [bootstrap, setBootstrap] = useState<PlaybackBootstrapResponse | null>(null);
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [hlsStats, setHlsStats] = useState<HlsStats>({});
  const [timings, setTimings] = useState<RendPlayerTimings>({});
  const [playbackSessionId] = useState(generatePlaybackSessionId);
  const telemetryActive = telemetryEnabled ?? Boolean(telemetryUrl || onTelemetryEvent);

  const resolvedBootstrapUrl = useMemo(
    () => bootstrapUrl ?? `/api/player/${encodeURIComponent(assetId)}`,
    [assetId, bootstrapUrl]
  );

  const emitTelemetry = useCallback(
    (input: RendPlayerTelemetryInput) => {
      if (!telemetryActive || !playbackSessionId) return;

      const event: RendPlayerTelemetryEvent = {
        playback_session_id: playbackSessionId,
        asset_id: assetId,
        event_time_ms: Date.now(),
        player_version: REND_PLAYER_VERSION,
        app_version: telemetryAppVersion,
        ...input,
      };

      try {
        onTelemetryEvent?.(event);
      } catch {
        // Telemetry callbacks must not interfere with playback.
      }

      if (telemetryUrl) sendPlayerTelemetryEvent(telemetryUrl, event);
    },
    [
      assetId,
      onTelemetryEvent,
      playbackSessionId,
      telemetryActive,
      telemetryAppVersion,
      telemetryUrl,
    ]
  );

  const setPlayerState = useCallback(
    (nextState: RendPlayerState, nextMessage = stateLabel(nextState)) => {
      setState(nextState);
      setMessage(nextMessage);
      onStateChange?.(nextState);
    },
    [onStateChange]
  );

  const setActiveSelection = useCallback((nextSelection: SourceSelection | null) => {
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
  }, []);

  const setObservedHlsStats = useCallback((nextStats: HlsStats) => {
    hlsStatsRef.current = nextStats;
  }, []);

  const mergeObservedHlsStats = useCallback((nextStats: HlsStats) => {
    const mergedStats = {
      ...hlsStatsRef.current,
      ...nextStats,
    };
    hlsStatsRef.current = mergedStats;
    setHlsStats(mergedStats);
  }, []);

  const recordTiming = useCallback(
    (key: keyof RendPlayerTimings) => {
      const startedAt = loadStartedAtRef.current;
      if (!startedAt || timingsRef.current[key] !== undefined) return undefined;

      const value = Date.now() - startedAt;
      const next = {
        ...timingsRef.current,
        [key]: value,
      };
      timingsRef.current = next;
      setTimings(next);
      onTimingsChange?.(next);

      return value;
    },
    [onTimingsChange]
  );

  const destroyHls = useCallback(() => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
  }, []);

  const revokeManifestObjectUrl = useCallback(() => {
    if (manifestObjectUrlRef.current) {
      URL.revokeObjectURL(manifestObjectUrlRef.current);
      manifestObjectUrlRef.current = null;
    }
  }, []);

  const loadProgressiveSource = useCallback(
    (
      nextSelection: SourceSelection,
      options: { destroyExistingHls?: boolean } = {}
    ) => {
      const video = videoRef.current;
      if (!video) return;

      if (options.destroyExistingHls ?? true) {
        destroyHls();
        revokeManifestObjectUrl();
        hlsPreparationRef.current = null;
        hlsHandoffStartedRef.current = false;
      }
      video.removeAttribute("src");
      video.load();

      setActiveSelection(nextSelection);
      setPlayerState("ready");
      setObservedHlsStats({});

      emitTelemetry({
        phase: "source_selected",
        ...selectionTelemetryFields(nextSelection),
      });

      video.src = nextSelection.url;
      video.load();
    },
    [
      destroyHls,
      emitTelemetry,
      revokeManifestObjectUrl,
      setActiveSelection,
      setObservedHlsStats,
      setPlayerState,
    ]
  );

  const prepareHlsSource = useCallback(
    async (
      data: PlaybackBootstrapReady,
      nextSelection: SourceSelection,
      Hls: HlsConstructor | null,
      signal: AbortSignal
    ): Promise<PreparedHlsSource | null> => {
      if (nextSelection.artifactPath !== "hls/master.m3u8") return null;

      const manifest = await signedHlsManifestObjectUrl(nextSelection.url, signal);
      if (signal.aborted) return null;

      const prepared: PreparedHlsSource = {
        ...manifest,
        objectUrl: manifest.sourceUrl,
        selection: nextSelection,
      };

      if (nextSelection.label !== "hls_js" || !Hls) {
        URL.revokeObjectURL(manifest.sourceUrl);
        prepared.objectUrl = undefined;
        prepared.sourceUrl = nextSelection.url;
        emitTelemetry({
          phase: "hls_ready",
          ...selectionTelemetryFields(nextSelection),
          cache_headers: manifest.cacheHeaders,
          edge_label: manifest.edgeLabel,
          region_label: manifest.regionLabel,
        });
        return prepared;
      }

      const hls = new Hls(HLS_STARTUP_CONFIG);
      prepared.hls = hls;
      hlsRef.current = hls;

      let manifestParsed = false;
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        manifestParsed = true;
        const firstLevel = data.levels?.[0] ?? hls.levels?.[0];
        const nextStats: HlsStats = {
          bitrate: firstLevel?.bitrate,
          height: firstLevel?.height,
          level: hls.currentLevel,
          width: firstLevel?.width,
        };
        setObservedHlsStats(nextStats);
        emitTelemetry({
          phase: "hls_ready",
          ...selectionTelemetryFields(nextSelection),
          ...hlsStatsTelemetryFields(nextStats),
          cache_headers: manifest.cacheHeaders,
          edge_label: manifest.edgeLabel,
          region_label: manifest.regionLabel,
        });
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const level = typeof data.level === "number" ? data.level : hls.currentLevel;
        const nextLevel = hls.levels?.[level ?? -1];
        const nextStats: HlsStats = {
          bitrate: nextLevel?.bitrate,
          height: nextLevel?.height,
          level,
          width: nextLevel?.width,
        };
        setObservedHlsStats(nextStats);
        emitTelemetry({
          phase: "hls_level_switch",
          ...selectionTelemetryFields(nextSelection),
          ...hlsStatsTelemetryFields(nextStats),
        });
      });

      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        const stats = data.frag?.stats ?? data.stats;
        emitTelemetry({
          phase: "hls_fragment_loaded",
          ...selectionTelemetryFields(nextSelection),
          hls_fragment_duration_ms:
            typeof data.frag?.duration === "number"
              ? roundedMs(data.frag.duration * 1000)
              : undefined,
          hls_fragment_index:
            typeof data.frag?.sn === "number" ? data.frag.sn : undefined,
          hls_fragment_load_ms: hlsFragmentLoadMs(stats),
          ...hlsLevelStats(hls, hls.currentLevel),
        });
      });

      hls.on(Hls.Events.ERROR, (_event, errorData) => {
        if (!errorData.fatal) return;

        emitTelemetry({
          phase: "playback_failure",
          playback_failure_code: "hls_js_fatal",
          playback_failure_reason: hlsFailureReason(errorData),
          ...selectionTelemetryFields(nextSelection),
        });

        const currentSelection = selectionRef.current;
        if (currentSelection?.artifactPath === "hls/master.m3u8") {
          const opener = openerSource(data);
          if (opener && !triedOpenerFallbackRef.current) {
            triedOpenerFallbackRef.current = true;
            loadProgressiveSource(opener);
            return;
          }
          setPlayerState(isTokenExpired(data) ? "token_expired" : "playback_failure");
        }
      });

      hls.loadSource(manifest.sourceUrl);

      await new Promise<void>((resolve) => {
        const startedAt = Date.now();
        const timer = window.setInterval(() => {
          if (signal.aborted || manifestParsed || Date.now() - startedAt > 2_500) {
            window.clearInterval(timer);
            resolve();
          }
        }, 50);
      });

      return prepared;
    },
    [emitTelemetry, loadProgressiveSource, setObservedHlsStats, setPlayerState]
  );

  const attachPreparedHls = useCallback(
    (
      data: PlaybackBootstrapReady,
      prepared: PreparedHlsSource,
      previousSelection: SourceSelection | null,
      options: { preservePlayState?: boolean } = {}
    ) => {
      const video = videoRef.current;
      if (!video) return;
      if (
        hlsHandoffStartedRef.current &&
        selectionRef.current?.artifactPath === prepared.selection.artifactPath
      ) {
        return;
      }

      const resumeAt = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
      const shouldPlay = options.preservePlayState ? !video.paused || autoPlay : autoPlay;

      hlsHandoffStartedRef.current = true;
      const objectUrl = prepared.objectUrl;
      if (manifestObjectUrlRef.current && manifestObjectUrlRef.current !== objectUrl) {
        revokeManifestObjectUrl();
      }
      manifestObjectUrlRef.current = objectUrl ?? null;

      setActiveSelection(prepared.selection);
      setPlayerState("ready");

      emitTelemetry({
        phase: previousSelection ? "source_handoff" : "source_selected",
        previous_artifact_path: previousSelection?.artifactPath,
        previous_playback_mode: previousSelection?.label,
        ...selectionTelemetryFields(prepared.selection),
        ...hlsStatsTelemetryFields(hlsStatsRef.current),
        cache_headers: prepared.cacheHeaders,
        edge_label: prepared.edgeLabel,
        region_label: prepared.regionLabel,
      });

      video.removeAttribute("src");
      video.load();

      const seekAfterMetadata = () => {
        if (resumeAt <= 0) return;
        try {
          const duration = Number.isFinite(video.duration) ? video.duration : resumeAt;
          video.currentTime = Math.min(resumeAt, Math.max(0, duration - 0.25));
        } catch {
          // Some native HLS implementations reject early seeks until metadata is available.
        }
      };

      video.addEventListener("loadedmetadata", seekAfterMetadata, { once: true });

      if (prepared.selection.label === "hls_js" && prepared.hls) {
        hlsRef.current = prepared.hls;
        prepared.hls.attachMedia(video);
        prepared.hls.startLoad(resumeAt);
      } else {
        video.src = prepared.sourceUrl;
        video.load();
      }

      if (shouldPlay) {
        void video.play().catch(() => undefined);
      }

      if (isTokenExpired(data)) {
        setPlayerState("token_expired");
      }
    },
    [
      autoPlay,
      emitTelemetry,
      revokeManifestObjectUrl,
      setActiveSelection,
      setPlayerState,
    ]
  );

  const handoffFromOpenerWhenReady = useCallback(
    async (
      data: PlaybackBootstrapReady,
      preparedPromise: Promise<PreparedHlsSource | null>,
      loadGeneration: number
    ) => {
      const prepared = await preparedPromise.catch((error) => {
        if ((error as Error).name !== "AbortError") {
          emitTelemetry({
            phase: "playback_failure",
            ...playbackLoadErrorFields(
              error,
              "hls_prepare_failed",
              "HLS failed to prepare while opener played"
            ),
          });
        }
        return null;
      });
      if (!prepared || loadGenerationRef.current !== loadGeneration) return;

      for (;;) {
        const video = videoRef.current;
        const currentSelection = selectionRef.current;
        if (!video || currentSelection?.label !== "opener") return;

        const duration = Number.isFinite(video.duration) ? video.duration : null;
        const remaining = duration == null ? null : duration - video.currentTime;
        const playedEnough = video.currentTime >= HLS_HANDOFF_MIN_PLAYED_SECONDS;
        const nearEnd =
          remaining != null && remaining <= HLS_HANDOFF_NEAR_OPENER_END_SECONDS;

        if (playedEnough || nearEnd || video.ended) {
          attachPreparedHls(data, prepared, currentSelection, {
            preservePlayState: true,
          });
          return;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 100));
        if (loadGenerationRef.current !== loadGeneration) return;
      }
    },
    [attachPreparedHls, emitTelemetry]
  );

  const loadPlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    triedOpenerFallbackRef.current = false;
    abortRef.current?.abort();
    const loadGeneration = loadGenerationRef.current + 1;
    loadGenerationRef.current = loadGeneration;
    loadStartedAtRef.current = Date.now();
    activeStallRef.current = null;
    destroyHls();
    revokeManifestObjectUrl();
    hlsPreparationRef.current = null;
    hlsHandoffStartedRef.current = false;
    setActiveSelection(null);
    setObservedHlsStats({});
    setBootstrap(null);
    timingsRef.current = {};
    setTimings({});
    setPlayerState("loading");
    emitTelemetry({
      phase: "player_load",
      bootstrap_start_ms: 0,
    });

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch(resolvedBootstrapUrl, {
        cache: "no-store",
        signal: abortController.signal,
      });
      const data = (await response.json().catch(() => ({
        status: "error",
        asset_id: assetId,
        message: `HTTP ${response.status}`,
      }))) as PlaybackBootstrapResponse;
      const bootstrapMs = recordTiming("bootstrapMs") ?? Date.now() - loadStartedAtRef.current;
      const cacheHeaders = readableTelemetryHeaders(response.headers);
      const labels = telemetryLabelsFromHeaders(response.headers);

      setBootstrap(data);
      emitTelemetry({
        phase: "bootstrap_complete",
        bootstrap_start_ms: 0,
        bootstrap_end_ms: bootstrapMs,
        bootstrap_duration_ms: bootstrapMs,
        bootstrap_http_status: response.status,
        cache_headers: cacheHeaders,
        edge_label: labels.edge_label,
        region_label: labels.region_label,
      });

      if (!response.ok || data.status !== "ready") {
        const nextState =
          data.status === "not_playable"
            ? "not_playable"
            : data.status === "unavailable"
              ? "unavailable"
            : "bootstrap_failure";
        const nextMessage =
          data.status === "ready" ? `HTTP ${response.status}` : data.message;
        emitTelemetry({
          phase: "bootstrap_failure",
          bootstrap_start_ms: 0,
          bootstrap_end_ms: bootstrapMs,
          bootstrap_duration_ms: bootstrapMs,
          bootstrap_http_status: response.status,
          playback_failure_code: nextState,
          playback_failure_reason: nextMessage,
          cache_headers: cacheHeaders,
          edge_label: labels.edge_label,
          region_label: labels.region_label,
        });
        setPlayerState(nextState, nextMessage);
        return;
      }

      const usesNativeHls = data.manifest_url ? isNativeHlsSupported(video) : false;
      let Hls: HlsConstructor | null = null;
      if (data.manifest_url && !usesNativeHls) {
        try {
          const hlsModule = await import("hls.js");
          Hls = hlsModule.default as HlsConstructor;
        } catch {
          Hls = null;
        }
      }

      const hlsSupport = {
        nativeHls: usesNativeHls,
        hlsJs: Boolean(Hls?.isSupported()),
      };
      const hlsSelection = hlsSource(data, hlsSupport);
      const nextSelection = selectedSource(data, hlsSupport);
      if (!nextSelection) {
        emitTelemetry({
          phase: "playback_failure",
          playback_failure_code: "no_playable_artifact",
          playback_failure_reason: "No playable artifact is available",
        });
        setPlayerState("not_playable", "No playable artifact is available");
        return;
      }

      const preparedHls =
        hlsSelection && hlsSelection.artifactPath === "hls/master.m3u8"
          ? prepareHlsSource(data, hlsSelection, Hls, abortController.signal)
          : null;
      hlsPreparationRef.current = preparedHls;

      if (nextSelection.label === "opener") {
        loadProgressiveSource(nextSelection, { destroyExistingHls: false });
        if (preparedHls) {
          void handoffFromOpenerWhenReady(data, preparedHls, loadGeneration);
        }
        return;
      }

      if (preparedHls && nextSelection.artifactPath === "hls/master.m3u8") {
        const prepared = await preparedHls;
        if (prepared && loadGenerationRef.current === loadGeneration) {
          attachPreparedHls(data, prepared, null);
          return;
        }
      }

      loadProgressiveSource(nextSelection);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setBootstrap({
        status: "error",
        asset_id: assetId,
        message: "Playback bootstrap failed",
      });
      emitTelemetry({
        phase: "bootstrap_failure",
        bootstrap_start_ms: 0,
        bootstrap_end_ms: loadStartedAtRef.current
          ? Date.now() - loadStartedAtRef.current
          : undefined,
        bootstrap_duration_ms: loadStartedAtRef.current
          ? Date.now() - loadStartedAtRef.current
          : undefined,
        playback_failure_code: "bootstrap_fetch_failed",
        playback_failure_reason: "Playback bootstrap failed",
      });
      setPlayerState("bootstrap_failure", "Playback bootstrap failed");
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
    }
  }, [
    assetId,
    attachPreparedHls,
    destroyHls,
    emitTelemetry,
    handoffFromOpenerWhenReady,
    loadProgressiveSource,
    prepareHlsSource,
    recordTiming,
    revokeManifestObjectUrl,
    resolvedBootstrapUrl,
    setActiveSelection,
    setObservedHlsStats,
    setPlayerState,
  ]);

  useEffect(() => {
    void loadPlayback();
    return () => {
      loadGenerationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      destroyHls();
      revokeManifestObjectUrl();
    };
  }, [destroyHls, loadPlayback, playbackSessionId, revokeManifestObjectUrl]);

  const updateObservedVideoStats = useCallback(() => {
    const currentSelection = selectionRef.current;
    if (!currentSelection || currentSelection.artifactPath !== "hls/master.m3u8") return;
    mergeObservedHlsStats(hlsStatsFromVideo(videoRef.current));
  }, [mergeObservedHlsStats]);

  const startStall = useCallback(
    (reason: string) => {
      if (activeStallRef.current || !loadStartedAtRef.current) return;
      if (timingsRef.current.firstFrameMs === undefined) return;

      const startMs = Date.now() - loadStartedAtRef.current;
      activeStallRef.current = { reason, startMs };
      emitTelemetry({
        phase: "stall_start",
        stall_reason: reason,
        stall_start_ms: roundedMs(startMs),
        ...selectionTelemetryFields(selectionRef.current),
        ...hlsStatsTelemetryFields(hlsStatsRef.current),
      });
    },
    [emitTelemetry]
  );

  const endStall = useCallback(
    (endedBy: string) => {
      const active = activeStallRef.current;
      if (!active || !loadStartedAtRef.current) return;

      const endMs = Date.now() - loadStartedAtRef.current;
      activeStallRef.current = null;
      emitTelemetry({
        phase: "stall_end",
        stall_reason: endedBy,
        stall_start_ms: roundedMs(active.startMs),
        stall_end_ms: roundedMs(endMs),
        stall_duration_ms: roundedMs(endMs - active.startMs),
        ...selectionTelemetryFields(selectionRef.current),
        ...hlsStatsTelemetryFields(hlsStatsRef.current),
      });
    },
    [emitTelemetry]
  );

  useEffect(() => {
    if (!bootstrap || bootstrap.status !== "ready") return;
    const hints: PlaybackPrefetchHint[] = [];
    if (bootstrap.opener_url) {
      hints.push({
        artifact_path: "opener.mp4",
        content_type: bootstrap.opener_content_type ?? "video/mp4",
        url: bootstrap.opener_url,
      });
    }
    if (bootstrap.manifest_url) {
      hints.push({
        artifact_path: "hls/master.m3u8",
        content_type:
          bootstrap.manifest_content_type ?? "application/vnd.apple.mpegurl",
        url: bootstrap.manifest_url,
      });
    }
    hints.push(...bootstrap.prefetch_hints.slice(0, Math.max(0, maxPrefetchHints)));

    const links = hints.map((hint, index) => {
      const link = document.createElement("link");
      link.rel = index === 0 && hint.artifact_path === "opener.mp4" ? "preload" : "prefetch";
      link.as = hint.artifact_path === "opener.mp4" ? "video" : "fetch";
      link.href = hint.url;
      link.crossOrigin = "anonymous";
      link.dataset.rendPrefetch = hint.artifact_path;
      document.head.appendChild(link);
      return link;
    });

    return () => {
      for (const link of links) link.remove();
    };
  }, [bootstrap, maxPrefetchHints]);

  const readyBootstrap = bootstrap?.status === "ready" ? bootstrap : null;
  const unavailable = isUnavailableState(state);

  return (
    <section
      className={["rend-player", className].filter(Boolean).join(" ")}
      data-rend-player-state={state}
      data-rend-player-selected={selection?.label ?? ""}
      data-rend-player-artifact={selection?.artifactPath ?? ""}
      data-rend-bootstrap-ms={timings.bootstrapMs}
      data-rend-metadata-ms={timings.metadataMs}
      data-rend-canplay-ms={timings.canplayMs}
      data-rend-first-frame-ms={timings.firstFrameMs}
      data-rend-selected-bitrate={hlsStats.bitrate}
      data-rend-selected-height={hlsStats.height}
      data-rend-selected-level={hlsStats.level}
      data-rend-selected-width={hlsStats.width}
      data-rend-asset-id={assetId}
      data-rend-playback-session-id={playbackSessionId}
    >
      <div className="rend-player__stage">
        <video
          ref={videoRef}
          className="rend-player__video"
          controls={controls}
          muted={muted}
          autoPlay={autoPlay}
          poster={poster}
          playsInline
          preload={preload}
          crossOrigin="anonymous"
          onLoadedMetadata={() => {
            updateObservedVideoStats();
            const metadataMs = recordTiming("metadataMs");
            if (metadataMs !== undefined) {
              emitTelemetry({
                phase: "metadata_loaded",
                metadata_loaded_ms: metadataMs,
                ...selectionTelemetryFields(selectionRef.current),
                ...hlsStatsTelemetryFields(hlsStatsRef.current),
              });
            }
            setPlayerState("metadata");
          }}
          onCanPlay={() => {
            endStall("canplay");
            updateObservedVideoStats();
            const canplayMs = recordTiming("canplayMs");
            if (canplayMs !== undefined) {
              emitTelemetry({
                phase: "canplay",
                canplay_ms: canplayMs,
                ...selectionTelemetryFields(selectionRef.current),
                ...hlsStatsTelemetryFields(hlsStatsRef.current),
              });
            }
            setPlayerState("canplay");
          }}
          onPlaying={() => {
            endStall("playing");
            updateObservedVideoStats();
            const firstFrameMs = recordTiming("firstFrameMs");
            if (firstFrameMs !== undefined) {
              emitTelemetry({
                phase: "first_frame",
                first_frame_ms: firstFrameMs,
                ...selectionTelemetryFields(selectionRef.current),
                ...hlsStatsTelemetryFields(hlsStatsRef.current),
              });
            }
            setPlayerState("playing");
          }}
          onTimeUpdate={() => {
            endStall("timeupdate");
            updateObservedVideoStats();
          }}
          onWaiting={() => startStall("waiting")}
          onStalled={() => startStall("stalled")}
          onCanPlayThrough={() => endStall("canplaythrough")}
          onResize={updateObservedVideoStats}
          onError={() => {
            const data = readyBootstrap;
            const opener = data ? openerSource(data) : null;
            const mediaError = videoRef.current?.error;
            const tokenExpired = isTokenExpired(data);
            const emitMediaFailure = () => {
              emitTelemetry({
                phase: "playback_failure",
                playback_failure_code: tokenExpired
                  ? "token_expired"
                  : mediaError
                    ? `media_error_${mediaError.code}`
                    : "media_error",
                playback_failure_reason: tokenExpired
                  ? "Playback token expired"
                  : mediaError
                    ? `HTMLMediaElement error ${mediaError.code}`
                    : "Media playback failed",
                ...selectionTelemetryFields(selectionRef.current),
              });
              setPlayerState(
                tokenExpired ? "token_expired" : "playback_failure"
              );
            };
            const hlsPreparation = hlsPreparationRef.current;
            if (data && selectionRef.current?.label === "opener" && hlsPreparation) {
              void hlsPreparation
                .then((prepared) => {
                  if (prepared) attachPreparedHls(data, prepared, selectionRef.current);
                  else emitMediaFailure();
                })
                .catch(() => emitMediaFailure());
              return;
            }
            if (
              data &&
              opener &&
              selectionRef.current?.label !== "opener" &&
              !triedOpenerFallbackRef.current
            ) {
              triedOpenerFallbackRef.current = true;
              loadProgressiveSource(opener);
              return;
            }

            emitMediaFailure();
          }}
        />
        {(state === "loading" || unavailable) && (
          <div className="rend-player__overlay" role="status" aria-live="polite">
            <div className="rend-player__status">{stateLabel(state)}</div>
            <div className="rend-player__message">{message}</div>
            {unavailable && (
              <button
                className="rend-player__retry"
                type="button"
                onClick={() => void loadPlayback()}
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      <div className="rend-player__meta" aria-label="Playback state">
        <span>{readyBootstrap?.playable_state ?? bootstrap?.status ?? "loading"}</span>
        <span>{selection?.artifactPath ?? "no artifact selected"}</span>
        {readyBootstrap?.playback_token_expires_at && (
          <span>
            token expires{" "}
            {new Date(readyBootstrap.playback_token_expires_at * 1000).toISOString()}
          </span>
        )}
      </div>
    </section>
  );
}
