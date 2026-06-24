"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  generateTelemetryEventId,
  generatePlaybackSessionId,
  readableTelemetryHeaders,
  REND_PLAYER_NAME,
  REND_PLAYER_VERSION,
  sendPlayerTelemetryEvent,
  telemetryLabelsFromHeaders,
} from "./telemetry";
import {
  hlsSource,
  openerSource,
  selectedSource,
  type RendPlayerPlaybackEngine,
  type RendPlayerStartupMode,
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
  poster_url?: string;
  poster_content_type?: string;
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
  documentStartMs?: number;
  srcAssignedMs?: number;
  videoCreatedMs?: number;
  metadataMs?: number;
  canplayMs?: number;
  firstFrameMs?: number;
};

export type { RendPlayerPlaybackEngine, RendPlayerStartupMode } from "./source-selection";

export type RendPlayerProps = {
  assetId: string;
  bootstrapUrl?: string;
  autoPlay?: boolean;
  muted?: boolean;
  controls?: boolean;
  poster?: string;
  initialBootstrap?: PlaybackBootstrapResponse | null;
  initialBootstrapMs?: number;
  preload?: "auto" | "metadata" | "none";
  playbackEngine?: RendPlayerPlaybackEngine;
  startupMode?: RendPlayerStartupMode;
  className?: string;
  maxPrefetchHints?: number;
  telemetryEnabled?: boolean;
  telemetryUrl?: string;
  telemetryAppVersion?: string;
  telemetryOrganizationId?: string;
  telemetryPageType?: "watch" | "embed" | "direct" | "custom";
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
  httpStatus?: number;
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
const HAVE_FUTURE_DATA = 3;
const WATCH_HEARTBEAT_INTERVAL_MS = 10_000;
const WATCH_HEARTBEAT_MAX_DELTA_MS = 30_000;
const WATCH_HEARTBEAT_MIN_FORCED_DELTA_MS = 1_000;
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
  xhrSetup: (xhr: XMLHttpRequest) => {
    xhr.withCredentials = true;
  },
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
  const response = await fetch(parsedManifestUrl.toString(), { credentials: "include", signal });
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

function asReadyBootstrap(data: PlaybackBootstrapResponse | null | undefined) {
  return data?.status === "ready" ? data : null;
}

function initialStateFromBootstrap(
  data: PlaybackBootstrapResponse | null | undefined,
  initialSelection: SourceSelection | null
): RendPlayerState {
  if (!data) return "idle";
  if (data.status === "ready") return initialSelection ? "ready" : "not_playable";
  if (data.status === "not_playable") return "not_playable";
  if (data.status === "unavailable") return "unavailable";
  return "bootstrap_failure";
}

function initialMessageFromBootstrap(
  data: PlaybackBootstrapResponse | null | undefined,
  state: RendPlayerState
) {
  if (!data) return "Loading playback";
  if (data.status === "ready") return stateLabel(state);
  return data.message;
}

function initialSourceSelection(
  data: PlaybackBootstrapResponse | null | undefined,
  startupMode: RendPlayerStartupMode
): SourceSelection | null {
  const ready = asReadyBootstrap(data);
  if (!ready) return null;

  if (startupMode === "opener" && ready.opener_url) {
    return {
      label: "opener",
      artifactPath: "opener.mp4",
      url: ready.opener_url,
    };
  }

  if (ready.playable_state === "hls_ready" && ready.manifest_url) {
    return {
      label: "native_hls",
      artifactPath: "hls/master.m3u8",
      url: ready.manifest_url,
    };
  }

  if (ready.opener_url) {
    return {
      label: "opener",
      artifactPath: "opener.mp4",
      url: ready.opener_url,
    };
  }

  if (ready.manifest_url) {
    return {
      label: "native_hls",
      artifactPath: "hls/master.m3u8",
      url: ready.manifest_url,
    };
  }

  if (ready.playback_url) {
    return {
      label: "primary",
      artifactPath: ready.playable_state === "hls_ready" ? "hls/master.m3u8" : "opener.mp4",
      url: ready.playback_url,
    };
  }

  return null;
}

function initialTimingState(initialBootstrapMs: number | undefined): RendPlayerTimings {
  const timings: RendPlayerTimings = {
    documentStartMs: 0,
  };
  if (typeof initialBootstrapMs === "number" && Number.isFinite(initialBootstrapMs)) {
    timings.bootstrapMs = Math.max(0, Math.round(initialBootstrapMs));
  }
  return timings;
}

type BrowserTelemetryContext = Pick<
  RendPlayerTelemetryEvent,
  | "viewer_id_hash"
  | "page_host"
  | "referrer_host"
  | "browser_name"
  | "browser_version"
  | "os_name"
  | "device_type"
>;

const VIEWER_ID_STORAGE_KEY = "rend.viewer.v1";

function safeTelemetryHost(value: string) {
  try {
    const host = new URL(value).host.toLowerCase();
    return /^[a-z0-9._:-]{1,160}$/.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

function inferBrowser(userAgent: string) {
  for (const [browser_name, pattern] of [
    ["Edge", /Edg\/([0-9.]+)/],
    ["Chrome", /Chrome\/([0-9.]+)/],
    ["Firefox", /Firefox\/([0-9.]+)/],
    ["Safari", /Version\/([0-9.]+).*Safari/],
  ] as const) {
    const match = userAgent.match(pattern);
    if (match?.[1]) return { browser_name, browser_version: match[1] };
  }
  return {};
}

function inferOs(userAgent: string) {
  if (/iPhone|iPad|iPod/.test(userAgent)) return { os_name: "iOS" };
  if (/Android/.test(userAgent)) return { os_name: "Android" };
  if (/Mac OS X/.test(userAgent)) return { os_name: "macOS" };
  if (/Windows NT/.test(userAgent)) return { os_name: "Windows" };
  if (/Linux/.test(userAgent)) return { os_name: "Linux" };
  return {};
}

function inferDeviceType(userAgent: string): BrowserTelemetryContext["device_type"] {
  if (/bot|crawler|spider|preview/i.test(userAgent)) return "bot";
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(userAgent)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(userAgent)) return "mobile";
  if (/TV|SmartTV|AppleTV/i.test(userAgent)) return "tv";
  return "desktop";
}

function stableViewerId() {
  const existing = window.localStorage.getItem(VIEWER_ID_STORAGE_KEY);
  if (existing && /^[a-zA-Z0-9._:-]{8,160}$/.test(existing)) return existing;
  const next = generatePlaybackSessionId();
  window.localStorage.setItem(VIEWER_ID_STORAGE_KEY, next);
  return next;
}

async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function browserTelemetryContext(): Promise<BrowserTelemetryContext> {
  if (typeof window === "undefined") return {};
  const userAgent = navigator.userAgent || "";
  let viewer_id_hash: string | undefined;
  try {
    viewer_id_hash = `sha256:${await sha256Hex(stableViewerId())}`;
  } catch {
    viewer_id_hash = undefined;
  }

  return {
    viewer_id_hash,
    page_host: safeTelemetryHost(window.location.href),
    referrer_host: document.referrer ? safeTelemetryHost(document.referrer) : undefined,
    ...inferBrowser(userAgent),
    ...inferOs(userAgent),
    device_type: inferDeviceType(userAgent),
  };
}

function documentStartedAtEpochMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return Date.now() - performance.now();
  }
  return Date.now();
}

function roundedPerformanceNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return roundedMs(performance.now());
  }
  return undefined;
}

function numberFromDataAttribute(value: string | undefined) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
}

function instantPlaybackScript(playerId: string) {
  return `
(() => {
  const player = document.getElementById(${JSON.stringify(playerId)});
  if (!player || player.dataset.rendInstantBound === "1") return;
  const video = player.querySelector("video");
  if (!video) return;
  player.dataset.rendInstantBound = "1";
  const now = () => Math.max(0, Math.round(performance.now()));
  const setOnce = (name, value) => {
    if (!player.getAttribute(name)) player.setAttribute(name, String(value));
  };
  const setState = (state) => {
    player.setAttribute("data-rend-player-state", state);
  };
  const setVideoStats = () => {
    if (video.videoWidth) player.setAttribute("data-rend-selected-width", String(video.videoWidth));
    if (video.videoHeight) player.setAttribute("data-rend-selected-height", String(video.videoHeight));
  };
  setOnce("data-rend-document-start-ms", "0");
  setOnce("data-rend-video-created-ms", now());
  if (video.currentSrc || video.getAttribute("src")) {
    setOnce("data-rend-src-assigned-ms", now());
  }
  video.addEventListener("loadedmetadata", () => {
    setOnce("data-rend-metadata-ms", now());
    setState("metadata");
    setVideoStats();
  });
  video.addEventListener("canplay", () => {
    setOnce("data-rend-canplay-ms", now());
    setState("canplay");
    setVideoStats();
  });
  video.addEventListener("playing", () => {
    setOnce("data-rend-first-frame-ms", now());
    setState("playing");
    setVideoStats();
  });
  video.addEventListener("resize", setVideoStats);
  video.addEventListener("error", () => setState("playback_failure"));
  if (video.autoplay) video.play().catch(() => {});
})();
`;
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

function shouldStartStall(reason: string, video: HTMLVideoElement | null) {
  if (!video) return true;
  if (reason === "stalled" && video.readyState >= HAVE_FUTURE_DATA) {
    return false;
  }
  return true;
}

export function RendPlayer({
  assetId,
  bootstrapUrl,
  autoPlay = false,
  muted = true,
  controls = true,
  poster,
  initialBootstrap,
  initialBootstrapMs,
  preload = "auto",
  playbackEngine = "auto",
  startupMode = "hls",
  className,
  maxPrefetchHints = DEFAULT_MAX_PREFETCH_HINTS,
  telemetryEnabled,
  telemetryUrl,
  telemetryAppVersion,
  telemetryOrganizationId,
  telemetryPageType = "custom",
  onTelemetryEvent,
  onStateChange,
  onTimingsChange,
}: RendPlayerProps) {
  const playerDomId = useId();
  const initialReadyBootstrap = useMemo(
    () => asReadyBootstrap(initialBootstrap),
    [initialBootstrap]
  );
  const initialSelection = useMemo(
    () => initialSourceSelection(initialBootstrap, startupMode),
    [initialBootstrap, startupMode]
  );
  const initialState = useMemo(
    () => initialStateFromBootstrap(initialBootstrap, initialSelection),
    [initialBootstrap, initialSelection]
  );
  const initialTimings = useMemo(
    () => initialTimingState(initialBootstrapMs),
    [initialBootstrapMs]
  );
  const initialVideoSrc = initialSelection?.url;
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const manifestObjectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadStartedAtRef = useRef<number>(documentStartedAtEpochMs());
  const loadGenerationRef = useRef(0);
  const timingsRef = useRef<RendPlayerTimings>(initialTimings);
  const triedOpenerFallbackRef = useRef(false);
  const hlsPreparationRef = useRef<Promise<PreparedHlsSource | null> | null>(null);
  const hlsHandoffStartedRef = useRef(false);
  const hlsUpgradePendingRef = useRef(false);
  const selectionRef = useRef<SourceSelection | null>(initialSelection);
  const hlsStatsRef = useRef<HlsStats>({});
  const activeStallRef = useRef<{ reason: string; startMs: number } | null>(null);
  const lastWatchHeartbeatAtRef = useRef(0);
  const lastWatchHeartbeatPositionMsRef = useRef<number | null>(null);
  const initialLoadHandledRef = useRef(false);
  const [state, setState] = useState<RendPlayerState>(initialState);
  const [message, setMessage] = useState(initialMessageFromBootstrap(initialBootstrap, initialState));
  const [bootstrap, setBootstrap] = useState<PlaybackBootstrapResponse | null>(initialBootstrap ?? null);
  const [selection, setSelection] = useState<SourceSelection | null>(initialSelection);
  const [hlsStats, setHlsStats] = useState<HlsStats>({});
  const [timings, setTimings] = useState<RendPlayerTimings>(initialTimings);
  const [videoSrcAttr, setVideoSrcAttr] = useState<string | undefined>(initialVideoSrc);
  const [browserContext, setBrowserContext] = useState<BrowserTelemetryContext>({});
  const playbackSessionIdRef = useRef("");
  const [playbackSessionId, setPlaybackSessionId] = useState("");
  const telemetryActive = telemetryEnabled ?? Boolean(telemetryUrl || onTelemetryEvent);

  useEffect(() => {
    let cancelled = false;
    void browserTelemetryContext().then((context) => {
      if (!cancelled) setBrowserContext(context);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const resolvedBootstrapUrl = useMemo(
    () => bootstrapUrl ?? `/api/player/${encodeURIComponent(assetId)}`,
    [assetId, bootstrapUrl]
  );

  const ensurePlaybackSessionId = useCallback(() => {
    if (playbackSessionIdRef.current) return playbackSessionIdRef.current;
    const nextSessionId = generatePlaybackSessionId();
    playbackSessionIdRef.current = nextSessionId;
    setPlaybackSessionId(nextSessionId);
    return nextSessionId;
  }, []);

  const emitTelemetry = useCallback(
    (input: RendPlayerTelemetryInput) => {
      if (!telemetryActive) return;
      const sessionId = ensurePlaybackSessionId();

      const event: RendPlayerTelemetryEvent = {
        event_id: generateTelemetryEventId(),
        organization_id: telemetryOrganizationId,
        playback_session_id: sessionId,
        asset_id: assetId,
        ...browserContext,
        page_type: telemetryPageType,
        player_name: REND_PLAYER_NAME,
        event_time_ms: Date.now(),
        player_version: REND_PLAYER_VERSION,
        app_version: telemetryAppVersion,
        autoplay: autoPlay,
        muted,
        preload,
        startup_mode: startupMode,
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
      autoPlay,
      browserContext,
      ensurePlaybackSessionId,
      muted,
      onTelemetryEvent,
      preload,
      startupMode,
      telemetryActive,
      telemetryAppVersion,
      telemetryOrganizationId,
      telemetryPageType,
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
    setHlsStats(nextStats);
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

  const syncInstantDomTimings = useCallback(() => {
    const player = sectionRef.current;
    if (!player) return timingsRef.current;

    const next = {
      ...timingsRef.current,
      documentStartMs:
        timingsRef.current.documentStartMs ??
        numberFromDataAttribute(player.dataset.rendDocumentStartMs),
      videoCreatedMs:
        timingsRef.current.videoCreatedMs ??
        numberFromDataAttribute(player.dataset.rendVideoCreatedMs),
      srcAssignedMs:
        timingsRef.current.srcAssignedMs ??
        numberFromDataAttribute(player.dataset.rendSrcAssignedMs),
      metadataMs:
        timingsRef.current.metadataMs ??
        numberFromDataAttribute(player.dataset.rendMetadataMs),
      canplayMs:
        timingsRef.current.canplayMs ??
        numberFromDataAttribute(player.dataset.rendCanplayMs),
      firstFrameMs:
        timingsRef.current.firstFrameMs ??
        numberFromDataAttribute(player.dataset.rendFirstFrameMs),
    };

    const changed = (Object.keys(next) as Array<keyof RendPlayerTimings>).some(
      (key) => next[key] !== timingsRef.current[key]
    );
    if (!changed) return timingsRef.current;

    timingsRef.current = next;
    setTimings(next);
    onTimingsChange?.(next);
    return next;
  }, [onTimingsChange]);

  const emitSrcAssigned = useCallback(
    (nextSelection: SourceSelection) => {
      const srcAssignedMs =
        recordTiming("srcAssignedMs") ??
        timingsRef.current.srcAssignedMs ??
        roundedPerformanceNow();

      emitTelemetry({
        phase: "src_assigned",
        src_assigned_ms: srcAssignedMs,
        ...selectionTelemetryFields(nextSelection),
      });
    },
    [emitTelemetry, recordTiming]
  );

  const emitObservedTimingTelemetry = useCallback(
    (observedTimings: RendPlayerTimings, nextSelection: SourceSelection | null) => {
      if (observedTimings.metadataMs !== undefined) {
        emitTelemetry({
          phase: "metadata_loaded",
          metadata_loaded_ms: observedTimings.metadataMs,
          ...selectionTelemetryFields(nextSelection),
          ...hlsStatsTelemetryFields(hlsStatsRef.current),
        });
      }

      if (observedTimings.canplayMs !== undefined) {
        emitTelemetry({
          phase: "canplay",
          canplay_ms: observedTimings.canplayMs,
          ...selectionTelemetryFields(nextSelection),
          ...hlsStatsTelemetryFields(hlsStatsRef.current),
        });
      }

      if (observedTimings.firstFrameMs !== undefined) {
        const video = videoRef.current;
        if (video && lastWatchHeartbeatPositionMsRef.current === null) {
          lastWatchHeartbeatPositionMsRef.current = roundedMs(video.currentTime * 1000);
          lastWatchHeartbeatAtRef.current = Date.now();
        }
        emitTelemetry({
          phase: "first_frame",
          first_frame_ms: observedTimings.firstFrameMs,
          ...selectionTelemetryFields(nextSelection),
          ...hlsStatsTelemetryFields(hlsStatsRef.current),
        });
      }
    },
    [emitTelemetry]
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
      hlsUpgradePendingRef.current = false;
      setVideoSrcAttr(undefined);
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
      emitSrcAssigned(nextSelection);
      video.load();
      if (autoPlay) {
        void video.play().catch(() => undefined);
      }
    },
    [
      autoPlay,
      destroyHls,
      emitSrcAssigned,
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

      if (nextSelection.label !== "hls_js" || !Hls) {
        emitTelemetry({
          phase: "hls_ready",
          ...selectionTelemetryFields(nextSelection),
        });
        return {
          sourceUrl: nextSelection.url,
          selection: nextSelection,
        };
      }

      const manifest = await signedHlsManifestObjectUrl(nextSelection.url, signal);
      if (signal.aborted) return null;

      const prepared: PreparedHlsSource = {
        ...manifest,
        objectUrl: manifest.sourceUrl,
        selection: nextSelection,
      };

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

      setVideoSrcAttr(undefined);
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
        emitSrcAssigned(prepared.selection);
        prepared.hls.startLoad(resumeAt);
      } else {
        video.src = prepared.sourceUrl;
        emitSrcAssigned(prepared.selection);
        video.load();
      }
      hlsUpgradePendingRef.current = false;

      if (shouldPlay) {
        void video.play().catch(() => undefined);
      }

      if (isTokenExpired(data)) {
        setPlayerState("token_expired");
      }
    },
    [
      autoPlay,
      emitSrcAssigned,
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

  const loadPlayback = useCallback(async (options: { timingOrigin?: "document" | "now" } = {}) => {
    const video = videoRef.current;
    if (!video) return;

    triedOpenerFallbackRef.current = false;
    abortRef.current?.abort();
    const loadGeneration = loadGenerationRef.current + 1;
    loadGenerationRef.current = loadGeneration;
    loadStartedAtRef.current =
      options.timingOrigin === "now" ? Date.now() : documentStartedAtEpochMs();
    activeStallRef.current = null;
    destroyHls();
    revokeManifestObjectUrl();
    setVideoSrcAttr(undefined);
    hlsPreparationRef.current = null;
    hlsHandoffStartedRef.current = false;
    hlsUpgradePendingRef.current = false;
    setActiveSelection(null);
    setObservedHlsStats({});
    setBootstrap(null);
    const resetTimings: RendPlayerTimings =
      options.timingOrigin === "now"
        ? {}
        : {
            documentStartMs: 0,
            videoCreatedMs: roundedPerformanceNow(),
          };
    timingsRef.current = resetTimings;
    setTimings(resetTimings);
    setPlayerState("loading");
    if (options.timingOrigin !== "now") {
      emitTelemetry({
        phase: "document_start",
        document_start_ms: 0,
      });
    }
    emitTelemetry({
      phase: "video_created",
      video_created_ms: resetTimings.videoCreatedMs ?? roundedPerformanceNow(),
    });
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
      if (data.manifest_url && (playbackEngine === "mse" || !usesNativeHls)) {
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
      const sourceOptions = { playbackEngine, startupMode };
      const hlsSelection = hlsSource(data, hlsSupport, sourceOptions);
      const nextSelection = selectedSource(data, hlsSupport, sourceOptions);
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
    playbackEngine,
    prepareHlsSource,
    recordTiming,
    revokeManifestObjectUrl,
    resolvedBootstrapUrl,
    setActiveSelection,
    setObservedHlsStats,
    setPlayerState,
    startupMode,
  ]);

  useLayoutEffect(() => {
    syncInstantDomTimings();
  }, [syncInstantDomTimings]);

  const hydrateInitialPlayback = useCallback(async () => {
    if (!initialBootstrap || initialLoadHandledRef.current) return false;
    initialLoadHandledRef.current = true;

    const video = videoRef.current;
    const loadGeneration = loadGenerationRef.current + 1;
    loadGenerationRef.current = loadGeneration;
    loadStartedAtRef.current = documentStartedAtEpochMs();
    activeStallRef.current = null;
    triedOpenerFallbackRef.current = false;
    hlsHandoffStartedRef.current = false;
    setBootstrap(initialBootstrap);

    const observedTimings = syncInstantDomTimings();
    emitTelemetry({
      phase: "document_start",
      document_start_ms: 0,
    });
    emitTelemetry({
      phase: "video_created",
      video_created_ms: observedTimings.videoCreatedMs ?? roundedPerformanceNow(),
    });
    emitTelemetry({
      phase: "player_load",
      bootstrap_start_ms: 0,
    });

    if (initialBootstrapMs !== undefined) {
      emitTelemetry({
        phase: "bootstrap_complete",
        bootstrap_start_ms: 0,
        bootstrap_end_ms: initialBootstrapMs,
        bootstrap_duration_ms: initialBootstrapMs,
        bootstrap_http_status: 200,
      });
    }

    if (initialBootstrap.status !== "ready") {
      const nextState = initialStateFromBootstrap(initialBootstrap, null);
      setPlayerState(nextState, initialBootstrap.message);
      if (initialBootstrap.status === "error") {
        emitTelemetry({
          phase: "bootstrap_failure",
          bootstrap_start_ms: 0,
          bootstrap_end_ms: initialBootstrapMs,
          bootstrap_duration_ms: initialBootstrapMs,
          playback_failure_code: nextState,
          playback_failure_reason: initialBootstrap.message,
        });
      }
      return true;
    }

    if (!video) return true;

    const data = initialBootstrap;
    const usesNativeHls = data.manifest_url ? isNativeHlsSupported(video) : false;
    let Hls: HlsConstructor | null = null;
    if (data.manifest_url && (playbackEngine === "mse" || !usesNativeHls)) {
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
    hlsUpgradePendingRef.current = Boolean(
      initialSelection?.label === "native_hls" &&
        data.manifest_url &&
        !usesNativeHls &&
        hlsSupport.hlsJs
    );
    const sourceOptions = { playbackEngine, startupMode };
    const hlsSelection = hlsSource(data, hlsSupport, sourceOptions);
    const nextSelection = selectedSource(data, hlsSupport, sourceOptions);

    if (!nextSelection) {
      emitTelemetry({
        phase: "playback_failure",
        playback_failure_code: "no_playable_artifact",
        playback_failure_reason: "No playable artifact is available",
      });
      setPlayerState("not_playable", "No playable artifact is available");
      return true;
    }

    let initialAbortController: AbortController | null = null;
    const prepareInitialHls = () => {
      if (!hlsSelection || hlsSelection.artifactPath !== "hls/master.m3u8") return null;
      if (!initialAbortController) {
        initialAbortController = new AbortController();
        abortRef.current = initialAbortController;
      }
      return prepareHlsSource(data, hlsSelection, Hls, initialAbortController.signal);
    };

    const canKeepInitialSource =
      initialSelection?.url === nextSelection.url &&
      initialSelection?.label === nextSelection.label &&
      nextSelection.label !== "hls_js" &&
      !(nextSelection.artifactPath === "hls/master.m3u8" && !usesNativeHls) &&
      playbackEngine !== "mse";

    if (canKeepInitialSource) {
      setActiveSelection(nextSelection);
      setPlayerState(
        observedTimings.firstFrameMs !== undefined
          ? "playing"
          : observedTimings.canplayMs !== undefined
            ? "canplay"
            : observedTimings.metadataMs !== undefined
              ? "metadata"
              : "ready"
      );
      setObservedHlsStats(hlsStatsFromVideo(video));
      emitTelemetry({
        phase: "source_selected",
        ...selectionTelemetryFields(nextSelection),
        ...hlsStatsTelemetryFields(hlsStatsFromVideo(video)),
      });
      if (nextSelection.artifactPath === "hls/master.m3u8") {
        emitTelemetry({
          phase: "hls_ready",
          ...selectionTelemetryFields(nextSelection),
          ...hlsStatsTelemetryFields(hlsStatsFromVideo(video)),
        });
      }
      emitSrcAssigned(nextSelection);
      emitObservedTimingTelemetry(syncInstantDomTimings(), nextSelection);

      if (autoPlay) {
        void video.play().catch(() => undefined);
      }
      const preparedHls = nextSelection.label === "opener" ? prepareInitialHls() : null;
      hlsPreparationRef.current = preparedHls;
      if (preparedHls) {
        void handoffFromOpenerWhenReady(data, preparedHls, loadGeneration);
      }
      if (isTokenExpired(data)) setPlayerState("token_expired");
      return true;
    }

    setVideoSrcAttr(undefined);
    video.removeAttribute("src");
    video.load();

    const preparedHls = prepareInitialHls();
    hlsPreparationRef.current = preparedHls;

    if (nextSelection.label === "opener") {
      hlsUpgradePendingRef.current = false;
      loadProgressiveSource(nextSelection, { destroyExistingHls: false });
      if (preparedHls) {
        void handoffFromOpenerWhenReady(data, preparedHls, loadGeneration);
      }
      return true;
    }

    if (preparedHls && nextSelection.artifactPath === "hls/master.m3u8") {
      const prepared = await preparedHls;
      if (prepared && loadGenerationRef.current === loadGeneration) {
        attachPreparedHls(data, prepared, null);
        return true;
      }
    }

    loadProgressiveSource(nextSelection);
    hlsUpgradePendingRef.current = false;
    return true;
  }, [
    attachPreparedHls,
    autoPlay,
    emitObservedTimingTelemetry,
    emitSrcAssigned,
    emitTelemetry,
    handoffFromOpenerWhenReady,
    initialBootstrap,
    initialBootstrapMs,
    initialSelection,
    loadProgressiveSource,
    playbackEngine,
    prepareHlsSource,
    setActiveSelection,
    setObservedHlsStats,
    setPlayerState,
    startupMode,
    syncInstantDomTimings,
  ]);

  useEffect(() => {
    void hydrateInitialPlayback().then((handled) => {
      if (!handled) void loadPlayback({ timingOrigin: "document" });
    });
    return () => {
      loadGenerationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      destroyHls();
      revokeManifestObjectUrl();
    };
  }, [destroyHls, hydrateInitialPlayback, loadPlayback, revokeManifestObjectUrl]);

  const updateObservedVideoStats = useCallback(() => {
    const currentSelection = selectionRef.current;
    if (!currentSelection || currentSelection.artifactPath !== "hls/master.m3u8") return;
    mergeObservedHlsStats(hlsStatsFromVideo(videoRef.current));
  }, [mergeObservedHlsStats]);

  const startStall = useCallback(
    (reason: string) => {
      if (activeStallRef.current || !loadStartedAtRef.current) return;
      if (timingsRef.current.firstFrameMs === undefined) return;
      if (!shouldStartStall(reason, videoRef.current)) return;

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

  const emitWatchHeartbeat = useCallback((force = false) => {
    const video = videoRef.current;
    if (!video) return;
    if (!force && (video.paused || video.ended)) return;
    if (timingsRef.current.firstFrameMs === undefined) return;

    const now = Date.now();
    const positionMs = roundedMs(video.currentTime * 1000);
    const previousPositionMs = lastWatchHeartbeatPositionMsRef.current;
    if (previousPositionMs === null || positionMs < previousPositionMs) {
      lastWatchHeartbeatAtRef.current = now;
      lastWatchHeartbeatPositionMsRef.current = positionMs;
      return;
    }

    const minimumDeltaMs = force ? WATCH_HEARTBEAT_MIN_FORCED_DELTA_MS : WATCH_HEARTBEAT_INTERVAL_MS;
    const deltaMs = Math.min(
      WATCH_HEARTBEAT_MAX_DELTA_MS,
      Math.max(0, positionMs - previousPositionMs)
    );
    if (deltaMs < minimumDeltaMs) return;

    lastWatchHeartbeatAtRef.current = now;
    lastWatchHeartbeatPositionMsRef.current = positionMs;

    emitTelemetry({
      phase: "watch_heartbeat",
      watch_delta_ms: deltaMs,
      ...selectionTelemetryFields(selectionRef.current),
      ...hlsStatsTelemetryFields(hlsStatsRef.current),
    });
  }, [emitTelemetry]);

  useEffect(() => {
    if (!telemetryActive) return;
    const flush = () => emitWatchHeartbeat(true);
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [emitWatchHeartbeat, telemetryActive]);

  useEffect(() => {
    if (!bootstrap || bootstrap.status !== "ready") return;
    const hints: PlaybackPrefetchHint[] = [];
    const seenHints = new Set<string>();
    const pushHint = (hint: PlaybackPrefetchHint) => {
      if (seenHints.has(hint.artifact_path)) return;
      seenHints.add(hint.artifact_path);
      hints.push(hint);
    };
    const openerHint = bootstrap.opener_url
      ? {
          artifact_path: "opener.mp4",
          content_type: bootstrap.opener_content_type ?? "video/mp4",
          url: bootstrap.opener_url,
        }
      : null;
    const manifestHint = bootstrap.manifest_url
      ? {
          artifact_path: "hls/master.m3u8",
          content_type:
            bootstrap.manifest_content_type ?? "application/vnd.apple.mpegurl",
          url: bootstrap.manifest_url,
        }
      : null;

    if (bootstrap.playable_state === "hls_ready") {
      if (startupMode === "opener" && openerHint) pushHint(openerHint);
      if (manifestHint) pushHint(manifestHint);
      for (const hint of bootstrap.prefetch_hints.slice(0, Math.max(0, maxPrefetchHints))) {
        pushHint(hint);
      }
    } else {
      if (openerHint) pushHint(openerHint);
      if (manifestHint) pushHint(manifestHint);
      for (const hint of bootstrap.prefetch_hints.slice(0, Math.max(0, maxPrefetchHints))) {
        pushHint(hint);
      }
    }

    const links = hints.map((hint, index) => {
      const link = document.createElement("link");
      link.rel = index === 0 && hint.artifact_path === "opener.mp4" ? "preload" : "prefetch";
      link.as = hint.artifact_path === "opener.mp4" ? "video" : "fetch";
      link.href = hint.url;
      link.crossOrigin = "use-credentials";
      link.dataset.rendPrefetch = hint.artifact_path;
      document.head.appendChild(link);
      return link;
    });

    return () => {
      for (const link of links) link.remove();
    };
  }, [bootstrap, maxPrefetchHints, startupMode]);

  const readyBootstrap = bootstrap?.status === "ready" ? bootstrap : null;
  const unavailable = isUnavailableState(state);
  const resolvedPoster = poster ?? readyBootstrap?.poster_url;

  return (
    <section
      id={playerDomId}
      ref={sectionRef}
      className={["rend-player", className].filter(Boolean).join(" ")}
      data-rend-player-state={state}
      data-rend-player-selected={selection?.label ?? ""}
      data-rend-player-artifact={selection?.artifactPath ?? ""}
      data-rend-ready-status={readyBootstrap?.status ?? bootstrap?.status ?? state}
      data-rend-source-state={readyBootstrap?.source_state}
      data-rend-playable-state={readyBootstrap?.playable_state}
      data-rend-manifest-content-type={readyBootstrap?.manifest_content_type}
      data-rend-opener-content-type={readyBootstrap?.opener_content_type}
      data-rend-poster={resolvedPoster ?? ""}
      data-rend-prefetch-hint-count={readyBootstrap?.prefetch_hints.length}
      data-rend-document-start-ms={timings.documentStartMs}
      data-rend-video-created-ms={timings.videoCreatedMs}
      data-rend-src-assigned-ms={timings.srcAssignedMs}
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
          autoPlay={autoPlay}
          controls={controls}
          muted={muted}
          poster={resolvedPoster}
          playsInline
          preload={preload}
          src={videoSrcAttr}
          crossOrigin="use-credentials"
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
              const video = videoRef.current;
              if (video && lastWatchHeartbeatPositionMsRef.current === null) {
                lastWatchHeartbeatPositionMsRef.current = roundedMs(video.currentTime * 1000);
                lastWatchHeartbeatAtRef.current = Date.now();
              }
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
            emitWatchHeartbeat();
          }}
          onPause={() => emitWatchHeartbeat(true)}
          onProgress={() => {
            if ((videoRef.current?.readyState ?? 0) >= HAVE_FUTURE_DATA) {
              endStall("progress");
            }
          }}
          onWaiting={() => startStall("waiting")}
          onStalled={() => startStall("stalled")}
          onCanPlayThrough={() => endStall("canplaythrough")}
          onEnded={() => {
            endStall("ended");
            emitWatchHeartbeat(true);
            emitTelemetry({
              phase: "playback_ended",
              ...selectionTelemetryFields(selectionRef.current),
              ...hlsStatsTelemetryFields(hlsStatsRef.current),
            });
          }}
          onResize={updateObservedVideoStats}
          onError={() => {
            const data = readyBootstrap;
            const opener = data ? openerSource(data) : null;
            const mediaError = videoRef.current?.error;
            const tokenExpired = isTokenExpired(data);
            if (
              data?.manifest_url &&
              selectionRef.current?.label === "native_hls" &&
              hlsUpgradePendingRef.current
            ) {
              return;
            }
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
        {initialReadyBootstrap && initialVideoSrc && (
          <script
            dangerouslySetInnerHTML={{ __html: instantPlaybackScript(playerDomId) }}
            suppressHydrationWarning
          />
        )}
        {(state === "loading" || unavailable) && (
          <div className="rend-player__overlay" role="status" aria-live="polite">
            <div className="rend-player__status">{stateLabel(state)}</div>
            <div className="rend-player__message">{message}</div>
            {unavailable && (
              <button
                className="rend-player__retry"
                type="button"
                onClick={() => void loadPlayback({ timingOrigin: "now" })}
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
