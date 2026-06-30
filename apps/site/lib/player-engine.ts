import type {
  WatchPlaybackBootstrapReady,
  WatchPlaybackBootstrapResponse,
} from "./watch-bootstrap.ts";

export type PlaybackMode = "native_hls" | "hls_js" | "opener" | "primary";
export type PlaybackEngine = "auto" | "native" | "mse";
export type StartupMode = "hls" | "opener";

export type SourceSelection = {
  label: PlaybackMode;
  artifactPath: string;
  url: string;
};

export type StartupPreloadHint = {
  artifactPath: string;
  as: "fetch" | "image" | "video";
  contentType?: string;
  url: string;
};

export type AttachPlaybackOptions = {
  assetId: string;
  autoPlay: boolean;
  bootstrapUrl: string;
  initialBootstrap: WatchPlaybackBootstrapResponse | null;
  initialBootstrapMs?: number;
  playbackEngine: PlaybackEngine;
  startupMode: StartupMode;
  telemetryAppVersion: string;
  telemetryEnabled: boolean;
  telemetryOrganizationId?: string;
  telemetryPageType?: "watch" | "embed" | "direct" | "custom";
  telemetryUrl: string;
  richTelemetry?: boolean;
};

type HlsInstance = {
  attachMedia(media: HTMLMediaElement): void;
  destroy(): void;
  loadSource(source: string): void;
  on(event: string, callback: (_event: string, data: HlsEventData) => void): void;
  startLoad(startPosition?: number): void;
  currentLevel?: number;
  levels?: HlsLevel[];
};

type HlsConstructor = {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
  Events: {
    ERROR: string;
    LEVEL_SWITCHED: string;
    MANIFEST_PARSED: string;
  };
};

type HlsEventData = {
  fatal?: boolean;
  level?: number;
  levels?: HlsLevel[];
};

type HlsLevel = {
  bitrate?: number;
  height?: number;
  width?: number;
};

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

const WATCH_HEARTBEAT_INTERVAL_MS = 10_000;
const WATCH_HEARTBEAT_MAX_DELTA_MS = 30_000;
const WATCH_HEARTBEAT_MIN_FORCED_DELTA_MS = 1_000;
const MAX_STARTUP_PRELOAD_HINTS = 10;

export function watchHeartbeatDelta(
  previousPositionMs: number | null,
  currentPositionMs: number,
  force = false
) {
  const current = Math.max(0, Math.round(currentPositionMs));
  if (previousPositionMs === null || current < previousPositionMs) {
    return { nextPositionMs: current, deltaMs: null };
  }

  const deltaMs = Math.min(
    WATCH_HEARTBEAT_MAX_DELTA_MS,
    Math.max(0, current - previousPositionMs)
  );
  const minimumDeltaMs = force ? WATCH_HEARTBEAT_MIN_FORCED_DELTA_MS : WATCH_HEARTBEAT_INTERVAL_MS;
  if (deltaMs < minimumDeltaMs) {
    return { nextPositionMs: previousPositionMs, deltaMs: null };
  }

  return { nextPositionMs: current, deltaMs };
}

export function readyBootstrap(data: WatchPlaybackBootstrapResponse | null | undefined) {
  return data?.status === "ready" ? data : null;
}

export function playbackEngineForUserAgent(
  userAgent: string | null | undefined
): PlaybackEngine {
  const ua = userAgent ?? "";
  if (!ua) return "auto";

  const isIos = /\b(iPhone|iPad|iPod)\b/i.test(ua);
  const isIpadDesktopMode = /\bMacintosh\b/i.test(ua) && /\bMobile\//i.test(ua);
  if (isIos || isIpadDesktopMode) return "auto";

  const isSafari =
    /\bSafari\//i.test(ua) &&
    !/\b(Chrome|Chromium|CriOS|FxiOS|Edg|OPR|SamsungBrowser)\//i.test(ua) &&
    !/\bAndroid\b/i.test(ua);
  if (isSafari) return "auto";

  if (
    /\b(Chrome|Chromium|Edg|Firefox|OPR|SamsungBrowser)\//i.test(ua) ||
    /\bAndroid\b/i.test(ua)
  ) {
    return "mse";
  }

  return "auto";
}

export function isNativeHlsSupported(video: HTMLVideoElement) {
  return Boolean(
    video.canPlayType("application/vnd.apple.mpegurl") ||
      video.canPlayType("application/x-mpegURL")
  );
}

export function initialSourceSelection(
  data: WatchPlaybackBootstrapResponse | null,
  startupMode: StartupMode,
  playbackEngine: PlaybackEngine = "auto"
): SourceSelection | null {
  const ready = readyBootstrap(data);
  if (!ready) return null;

  if (startupMode === "opener" && ready.opener_url) {
    return { label: "opener", artifactPath: "opener.mp4", url: ready.opener_url };
  }

  if (playbackEngine === "mse" && ready.playable_state === "hls_ready" && ready.manifest_url) {
    return null;
  }

  if (ready.playable_state === "hls_ready" && ready.manifest_url) {
    return { label: "native_hls", artifactPath: "hls/master.m3u8", url: ready.manifest_url };
  }

  if (ready.opener_url) {
    return { label: "opener", artifactPath: "opener.mp4", url: ready.opener_url };
  }

  if (ready.manifest_url) {
    return { label: "native_hls", artifactPath: "hls/master.m3u8", url: ready.manifest_url };
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

export function initialPlaybackState(
  data: WatchPlaybackBootstrapResponse | null,
  selection: SourceSelection | null,
  clientPlaybackPending = false
) {
  if (!data) return "loading";
  if (data.status === "ready") return selection || clientPlaybackPending ? "ready" : "not_playable";
  if (data.status === "not_playable") return "not_playable";
  if (data.status === "unavailable") return "unavailable";
  return "bootstrap_failure";
}

export function playbackStateMessage(data: WatchPlaybackBootstrapResponse | null, state: string) {
  if (!data) return "Loading playback";
  if (data.status !== "ready") return data.message;
  switch (state) {
    case "ready":
      return "Ready";
    case "not_playable":
      return "Not playable yet";
    default:
      return "Playback is unavailable";
  }
}

export function startupPreloadHints(
  data: WatchPlaybackBootstrapResponse | null,
  startupMode: StartupMode
): StartupPreloadHint[] {
  const ready = readyBootstrap(data);
  if (!ready) return [];

  const seen = new Set<string>();
  const hints: StartupPreloadHint[] = [];
  const push = (hint: StartupPreloadHint) => {
    if (!hint.url || seen.has(hint.url) || hints.length >= MAX_STARTUP_PRELOAD_HINTS) return;
    seen.add(hint.url);
    hints.push(hint);
  };

  if (startupMode === "opener" && ready.opener_url) {
    push({
      artifactPath: "opener.mp4",
      as: "video",
      contentType: ready.opener_content_type ?? "video/mp4",
      url: ready.opener_url,
    });
  }

  if (ready.poster_url) {
    push({
      artifactPath: "thumbnail.jpg",
      as: "image",
      contentType: ready.poster_content_type,
      url: ready.poster_url,
    });
  }

  return hints;
}

function hlsSource(
  data: WatchPlaybackBootstrapReady,
  support: { nativeHls: boolean; hlsJs: boolean },
  playbackEngine: PlaybackEngine
): SourceSelection | null {
  if (!data.manifest_url) return null;
  if (playbackEngine === "mse" && support.hlsJs) {
    return { label: "hls_js", artifactPath: "hls/master.m3u8", url: data.manifest_url };
  }
  if (support.nativeHls) {
    return { label: "native_hls", artifactPath: "hls/master.m3u8", url: data.manifest_url };
  }
  if (support.hlsJs) {
    return { label: "hls_js", artifactPath: "hls/master.m3u8", url: data.manifest_url };
  }
  return null;
}

function fallbackPrimarySource(data: WatchPlaybackBootstrapReady): SourceSelection | null {
  if (!data.playback_url) return null;
  return {
    label: "primary",
    artifactPath: data.playable_state === "hls_ready" ? "hls/master.m3u8" : "opener.mp4",
    url: data.playback_url,
  };
}

function selectedSource(
  data: WatchPlaybackBootstrapReady,
  support: { nativeHls: boolean; hlsJs: boolean },
  playbackEngine: PlaybackEngine,
  startupMode: StartupMode
): SourceSelection | null {
  const hls = hlsSource(data, support, playbackEngine);
  const opener = data.opener_url
    ? { label: "opener" as const, artifactPath: "opener.mp4", url: data.opener_url }
    : null;

  if (startupMode === "opener") return opener ?? hls ?? fallbackPrimarySource(data);
  if (data.playable_state === "hls_ready" && hls) return hls;
  return opener ?? hls ?? fallbackPrimarySource(data);
}

function setAttribute(player: HTMLElement, name: string, value: unknown) {
  if (value !== undefined && value !== null && value !== "") {
    player.setAttribute(name, String(value));
  }
}

function setState(player: HTMLElement, state: string) {
  setAttribute(player, "data-rend-player-state", state);
}

function setSelection(player: HTMLElement, selection: SourceSelection) {
  setAttribute(player, "data-rend-player-selected", selection.label);
  setAttribute(player, "data-rend-player-artifact", selection.artifactPath);
}

function setVideoStats(player: HTMLElement, video: HTMLVideoElement, level?: HlsLevel, levelIndex?: number) {
  setAttribute(player, "data-rend-selected-width", level?.width ?? video.videoWidth);
  setAttribute(player, "data-rend-selected-height", level?.height ?? video.videoHeight);
  setAttribute(player, "data-rend-selected-bitrate", level?.bitrate);
  setAttribute(player, "data-rend-selected-level", levelIndex);
}

function numberAttribute(player: HTMLElement, name: string) {
  const value = player.getAttribute(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function selectionFromAttributes(player: HTMLElement, video: HTMLVideoElement): SourceSelection | null {
  const label = player.getAttribute("data-rend-player-selected");
  const artifactPath = player.getAttribute("data-rend-player-artifact");
  if (
    label !== "native_hls" &&
    label !== "hls_js" &&
    label !== "opener" &&
    label !== "primary"
  ) {
    return null;
  }
  if (!artifactPath) return null;
  return {
    label,
    artifactPath,
    url: video.currentSrc || video.getAttribute("src") || "",
  };
}

function playbackSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function telemetryEventId() {
  return `evt-${playbackSessionId()}`;
}

const VIEWER_ID_STORAGE_KEY = "rend.viewer.v1";

function stableViewerId() {
  const existing = window.localStorage.getItem(VIEWER_ID_STORAGE_KEY);
  if (existing && /^[a-zA-Z0-9._:-]{8,160}$/.test(existing)) return existing;
  const next = playbackSessionId();
  window.localStorage.setItem(VIEWER_ID_STORAGE_KEY, next);
  return next;
}

function safeTelemetryHost(value: string) {
  try {
    const host = new URL(value).host.toLowerCase();
    return /^[a-z0-9._:-]{1,160}$/.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function browserNames(userAgent: string) {
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

function osName(userAgent: string) {
  if (/iPhone|iPad|iPod/.test(userAgent)) return { os_name: "iOS" };
  if (/Android/.test(userAgent)) return { os_name: "Android" };
  if (/Mac OS X/.test(userAgent)) return { os_name: "macOS" };
  if (/Windows NT/.test(userAgent)) return { os_name: "Windows" };
  if (/Linux/.test(userAgent)) return { os_name: "Linux" };
  return {};
}

function deviceType(userAgent: string) {
  if (/bot|crawler|spider|preview/i.test(userAgent)) return "bot";
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(userAgent)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(userAgent)) return "mobile";
  if (/TV|SmartTV|AppleTV/i.test(userAgent)) return "tv";
  return "desktop";
}

async function browserTelemetryContext() {
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
    ...browserNames(userAgent),
    ...osName(userAgent),
    device_type: deviceType(userAgent),
  };
}

function emitDeferredTelemetry(
  player: HTMLElement,
  options: AttachPlaybackOptions,
  selection: SourceSelection | null
) {
  if (!options.telemetryEnabled || !options.telemetryUrl) return;
  if (player.dataset.rendTelemetrySent === "1") return;
  player.dataset.rendTelemetrySent = "1";

  const sessionId = playbackSessionId();
  setAttribute(player, "data-rend-playback-session-id", sessionId);
  const eventTime = Date.now();
  void browserTelemetryContext()
    .then((context) => {
      const base = {
        ...context,
        organization_id: options.telemetryOrganizationId,
        playback_session_id: sessionId,
        asset_id: options.assetId,
        page_type: options.telemetryPageType ?? "custom",
        player_name: "rend-player",
        event_time_ms: eventTime,
        player_version: "0.1.0",
        app_version: options.telemetryAppVersion,
        autoplay: options.autoPlay,
        muted: true,
        preload: options.autoPlay ? "auto" : "metadata",
        startup_mode: options.startupMode,
        selected_playback_mode: selection?.label,
        selected_artifact_path: selection?.artifactPath,
        selected_width: numberAttribute(player, "data-rend-selected-width"),
        selected_height: numberAttribute(player, "data-rend-selected-height"),
      };
      const events = [
        {
          ...base,
          event_id: telemetryEventId(),
          phase: "bootstrap_complete",
          bootstrap_start_ms: 0,
          bootstrap_end_ms: options.initialBootstrapMs,
          bootstrap_duration_ms: options.initialBootstrapMs,
          bootstrap_http_status: options.initialBootstrapMs === undefined ? undefined : 200,
        },
        {
          ...base,
          event_id: telemetryEventId(),
          phase: "source_selected",
        },
        {
          ...base,
          event_id: telemetryEventId(),
          phase: "first_frame",
          first_frame_ms: numberAttribute(player, "data-rend-first-frame-ms"),
        },
      ];

      return fetch(options.telemetryUrl, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      });
    })
    .catch(() => undefined);
}

type RichTelemetry = {
  playerLoad: () => void;
  bootstrapComplete: (durationMs: number | undefined, httpStatus: number) => void;
  bootstrapFailure: (
    code: string,
    reason: string,
    durationMs?: number,
    httpStatus?: number
  ) => void;
  sourceSelected: (selection: SourceSelection) => void;
  dispose: () => void;
};

function createRichTelemetry(
  player: HTMLElement,
  video: HTMLVideoElement,
  options: AttachPlaybackOptions
): RichTelemetry {
  const sessionId = playbackSessionId();
  setAttribute(player, "data-rend-playback-session-id", sessionId);
  let context: Record<string, unknown> = {};
  void browserTelemetryContext()
    .then((nextContext) => {
      context = nextContext;
    })
    .catch(() => undefined);

  const perfNow = () => Math.max(0, Math.round(performance.now()));
  const send = (phase: string, fields: Record<string, unknown>) => {
    const event = {
      ...context,
      event_id: telemetryEventId(),
      organization_id: options.telemetryOrganizationId,
      playback_session_id: sessionId,
      asset_id: options.assetId,
      page_type: options.telemetryPageType ?? "custom",
      player_name: "rend-player",
      phase,
      event_time_ms: Date.now(),
      player_version: "0.1.0",
      app_version: options.telemetryAppVersion,
      autoplay: options.autoPlay,
      muted: true,
      preload: options.autoPlay ? "auto" : "metadata",
      startup_mode: options.startupMode,
      ...fields,
    };
    try {
      void fetch(options.telemetryUrl, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [event] }),
      }).catch(() => undefined);
    } catch {
      // Telemetry must not interfere with playback.
    }
  };

  let lastSelection: SourceSelection | null = selectionFromAttributes(player, video);
  let sourceSent = false;
  let metadataSent = false;
  let canplaySent = false;
  let firstFrameSent = false;
  let lastWatchHeartbeatPositionMs: number | null = null;

  const selectionFields = () =>
    lastSelection
      ? {
          selected_playback_mode: lastSelection.label,
          selected_artifact_path: lastSelection.artifactPath,
        }
      : {};

  const currentVideoPositionMs = () => Math.max(0, Math.round(video.currentTime * 1000));
  const seedWatchHeartbeatPosition = () => {
    if (lastWatchHeartbeatPositionMs !== null) return;
    lastWatchHeartbeatPositionMs = currentVideoPositionMs();
  };
  const emitWatchHeartbeat = (force = false) => {
    if (!firstFrameSent) return;
    if (!force && (video.paused || video.ended)) return;

    const result = watchHeartbeatDelta(
      lastWatchHeartbeatPositionMs,
      currentVideoPositionMs(),
      force
    );
    lastWatchHeartbeatPositionMs = result.nextPositionMs;
    if (result.deltaMs === null) return;

    send("watch_heartbeat", {
      watch_delta_ms: result.deltaMs,
      ...selectionFields(),
    });
  };

  const emitMetadata = () => {
    if (metadataSent) return;
    metadataSent = true;
    send("metadata_loaded", {
      metadata_loaded_ms: numberAttribute(player, "data-rend-metadata-ms") ?? perfNow(),
      ...selectionFields(),
    });
  };
  const emitCanplay = () => {
    if (canplaySent) return;
    canplaySent = true;
    send("canplay", {
      canplay_ms: numberAttribute(player, "data-rend-canplay-ms") ?? perfNow(),
      ...selectionFields(),
    });
  };
  const emitFirstFrame = () => {
    if (firstFrameSent) return;
    firstFrameSent = true;
    seedWatchHeartbeatPosition();
    send("first_frame", {
      first_frame_ms: numberAttribute(player, "data-rend-first-frame-ms") ?? perfNow(),
      ...selectionFields(),
    });
  };
  const emitAvailableStartupEvents = () => {
    if (
      video.readyState >= 1 ||
      numberAttribute(player, "data-rend-metadata-ms") !== undefined
    ) {
      emitMetadata();
    }
    if (video.readyState >= 3 || numberAttribute(player, "data-rend-canplay-ms") !== undefined) {
      emitCanplay();
    }
    if (numberAttribute(player, "data-rend-first-frame-ms") !== undefined) {
      emitFirstFrame();
    }
  };

  const onMeta = () => emitMetadata();
  const onCan = () => emitCanplay();
  const onPlaying = () => emitFirstFrame();
  const onTimeUpdate = () => emitWatchHeartbeat();
  const onPause = () => emitWatchHeartbeat(true);
  const onEnded = () => {
    emitWatchHeartbeat(true);
    send("playback_ended", {
      ...selectionFields(),
    });
  };
  const onPageHide = () => emitWatchHeartbeat(true);
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") emitWatchHeartbeat(true);
  };
  video.addEventListener("loadedmetadata", onMeta);
  video.addEventListener("canplay", onCan);
  video.addEventListener("playing", onPlaying);
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("pause", onPause);
  video.addEventListener("ended", onEnded);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibilityChange);
  emitAvailableStartupEvents();

  return {
    playerLoad: () => send("player_load", { bootstrap_start_ms: 0 }),
    bootstrapComplete: (durationMs, httpStatus) => {
      const end = durationMs ?? perfNow();
      send("bootstrap_complete", {
        bootstrap_start_ms: 0,
        bootstrap_end_ms: end,
        bootstrap_duration_ms: end,
        bootstrap_http_status: httpStatus,
      });
    },
    bootstrapFailure: (code, reason, durationMs, httpStatus) => {
      send("bootstrap_failure", {
        bootstrap_start_ms: 0,
        bootstrap_end_ms: durationMs,
        bootstrap_duration_ms: durationMs,
        bootstrap_http_status: httpStatus,
        playback_failure_code: code,
        playback_failure_reason: reason,
      });
    },
    sourceSelected: (selection) => {
      lastSelection = selection;
      if (!sourceSent) {
        sourceSent = true;
        send("source_selected", {
          selected_playback_mode: selection.label,
          selected_artifact_path: selection.artifactPath,
        });
      }
      emitAvailableStartupEvents();
    },
    dispose: () => {
      emitWatchHeartbeat(true);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("canplay", onCan);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}

function afterFirstFrame(video: HTMLVideoElement, callback: () => void) {
  let called = false;
  const run = () => {
    if (called) return;
    called = true;
    window.setTimeout(callback, 0);
  };

  if (video.readyState >= 3 && !video.paused) {
    run();
    return () => undefined;
  }

  video.addEventListener("playing", run, { once: true });
  if ("requestVideoFrameCallback" in video) {
    video.requestVideoFrameCallback(run);
  }

  return () => {
    video.removeEventListener("playing", run);
  };
}

async function loadHlsConstructor() {
  const hlsModule = await import("hls.js");
  return hlsModule.default as unknown as HlsConstructor;
}

export function attachPlayback(
  player: HTMLElement,
  video: HTMLVideoElement,
  options: AttachPlaybackOptions
): () => void {
  let cancelled = false;
  let hls: HlsInstance | null = null;
  let currentSelection: SourceSelection | null = null;
  const useRich = Boolean(
    options.richTelemetry && options.telemetryEnabled && options.telemetryUrl
  );
  const telemetry = useRich ? createRichTelemetry(player, video, options) : null;
  const cleanupAfterFirstFrame = useRich
    ? () => undefined
    : afterFirstFrame(video, () => {
        emitDeferredTelemetry(player, options, currentSelection);
      });
  const ready = readyBootstrap(options.initialBootstrap);
  telemetry?.playerLoad();

  const applyProgressiveSource = (selection: SourceSelection) => {
    currentSelection = selection;
    setSelection(player, selection);
    setState(player, "ready");
    telemetry?.sourceSelected(selection);
    if (video.currentSrc !== selection.url && video.getAttribute("src") !== selection.url) {
      video.src = selection.url;
      setAttribute(player, "data-rend-src-assigned-ms", Math.max(0, Math.round(performance.now())));
      video.load();
    }
    if (options.autoPlay) void video.play().catch(() => undefined);
  };

  const enhance = async (data: WatchPlaybackBootstrapReady) => {
    const nativeHls =
      options.playbackEngine !== "mse" && data.manifest_url ? isNativeHlsSupported(video) : false;
    if (nativeHls && options.startupMode !== "opener") {
      const selection: SourceSelection = {
        label: "native_hls",
        artifactPath: "hls/master.m3u8",
        url: data.manifest_url ?? "",
      };
      currentSelection = selection;
      setSelection(player, selection);
      setState(player, "ready");
      telemetry?.sourceSelected(selection);
      if (!video.currentSrc && !video.getAttribute("src")) {
        video.src = selection.url;
        setAttribute(player, "data-rend-src-assigned-ms", Math.max(0, Math.round(performance.now())));
        video.load();
      }
      if (options.autoPlay) void video.play().catch(() => undefined);
      return;
    }

    let Hls: HlsConstructor | null = null;
    if (data.manifest_url && (options.playbackEngine === "mse" || !nativeHls)) {
      try {
        Hls = await loadHlsConstructor();
      } catch {
        Hls = null;
      }
    }
    if (cancelled) return;

    const support = { nativeHls, hlsJs: Boolean(Hls?.isSupported()) };
    const selection = selectedSource(data, support, options.playbackEngine, options.startupMode);
    if (!selection) {
      setState(player, "not_playable");
      telemetry?.bootstrapFailure("no_playable_artifact", "No playable artifact is available");
      return;
    }

    if (selection.label !== "hls_js" || !Hls) {
      applyProgressiveSource(selection);
      return;
    }

    currentSelection = selection;
    setSelection(player, selection);
    setState(player, "ready");
    telemetry?.sourceSelected(selection);
    video.removeAttribute("src");
    video.load();
    hls = new Hls(HLS_STARTUP_CONFIG);
    hls.on(Hls.Events.MANIFEST_PARSED, (_event, eventData) => {
      const level = eventData.levels?.[0] ?? hls?.levels?.[0];
      setVideoStats(player, video, level, hls?.currentLevel);
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, eventData) => {
      const levelIndex = typeof eventData.level === "number" ? eventData.level : hls?.currentLevel;
      const level = hls?.levels?.[levelIndex ?? -1];
      setVideoStats(player, video, level, levelIndex);
    });
    hls.on(Hls.Events.ERROR, (_event, eventData) => {
      if (!eventData.fatal) return;
      hls?.destroy();
      hls = null;
      if (data.opener_url) {
        applyProgressiveSource({
          label: "opener",
          artifactPath: "opener.mp4",
          url: data.opener_url,
        });
        return;
      }
      setState(player, "playback_failure");
    });
    hls.loadSource(selection.url);
    hls.attachMedia(video);
    hls.startLoad();
    if (options.autoPlay) void video.play().catch(() => undefined);
  };

  const failureMessage = (data: WatchPlaybackBootstrapResponse) =>
    "message" in data && typeof data.message === "string" ? data.message : "Playback is unavailable";

  if (ready) {
    telemetry?.bootstrapComplete(options.initialBootstrapMs, 200);
    void enhance(ready);
  } else if (!options.initialBootstrap) {
    const startedAt = performance.now();
    void fetch(options.bootstrapUrl, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({
          status: "error",
          asset_id: options.assetId,
          message: `HTTP ${response.status}`,
        }))) as WatchPlaybackBootstrapResponse;
        return { data, status: response.status };
      })
      .then(({ data, status }) => {
        if (cancelled) return undefined;
        const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        const fetchedReady = readyBootstrap(data);
        if (fetchedReady) {
          telemetry?.bootstrapComplete(durationMs, status);
          return enhance(fetchedReady);
        }
        telemetry?.bootstrapComplete(durationMs, status);
        const nextState = data.status === "not_playable" ? "not_playable" : "unavailable";
        setState(player, nextState);
        telemetry?.bootstrapFailure(nextState, failureMessage(data), durationMs, status);
        return undefined;
      })
      .catch(() => {
        if (cancelled) return;
        const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        setState(player, "bootstrap_failure");
        telemetry?.bootstrapFailure("bootstrap_fetch_failed", "Playback bootstrap failed", durationMs);
      });
  } else {
    telemetry?.bootstrapComplete(options.initialBootstrapMs, 200);
    const nextState =
      options.initialBootstrap.status === "not_playable" ? "not_playable" : "unavailable";
    telemetry?.bootstrapFailure(
      nextState,
      failureMessage(options.initialBootstrap),
      options.initialBootstrapMs,
      200
    );
  }

  return () => {
    cancelled = true;
    cleanupAfterFirstFrame();
    telemetry?.dispose();
    hls?.destroy();
  };
}

export function instantPlaybackScript(playerId: string, options: { customControls?: boolean } = {}) {
  const customControls = options.customControls ? "1" : "";
  return `
(() => {
  const player = document.getElementById(${JSON.stringify(playerId)});
  if (!player || player.dataset.rendInstantBound === "1") return;
  const video = player.querySelector("video");
  if (!video) return;
  player.dataset.rendInstantBound = "1";
  const now = () => Math.max(0, Math.round(performance.now()));
  const setAttr = (name, value) => {
    if (value !== undefined && value !== null && value !== "") player.setAttribute(name, String(value));
  };
  const setOnce = (name, value) => {
    if (!player.getAttribute(name)) setAttr(name, value);
  };
  const setState = (state) => setAttr("data-rend-player-state", state);
  const setVideoStats = () => {
    if (video.videoWidth) setAttr("data-rend-selected-width", video.videoWidth);
    if (video.videoHeight) setAttr("data-rend-selected-height", video.videoHeight);
  };
  const markMetadata = () => {
    setOnce("data-rend-metadata-ms", now());
    setState("metadata");
    setVideoStats();
  };
  const markCanplay = () => {
    setOnce("data-rend-canplay-ms", now());
    setState("canplay");
    setVideoStats();
  };
  const markFirstFrame = () => {
    setOnce("data-rend-first-frame-ms", now());
    setState("playing");
    setVideoStats();
  };
  if (${JSON.stringify(customControls)}) {
    try {
      video.removeAttribute("controls");
      player.classList.add("rend-player--ui");
      const reflect = () => {
        player.classList.toggle("is-paused", video.paused);
        player.classList.toggle("is-playing", !video.paused);
        player.classList.toggle("is-muted", video.muted || video.volume === 0);
      };
      reflect();
      video.addEventListener("play", reflect);
      video.addEventListener("pause", reflect);
      video.addEventListener("volumechange", reflect);
    } catch (error) {
      video.setAttribute("controls", "");
    }
  }
  setOnce("data-rend-document-start-ms", "0");
  setOnce("data-rend-video-created-ms", now());
  if (video.currentSrc || video.getAttribute("src")) {
    setOnce("data-rend-src-assigned-ms", now());
  }
  if (video.readyState >= 1) markMetadata();
  if (video.readyState >= 3) markCanplay();
  video.addEventListener("loadedmetadata", markMetadata);
  video.addEventListener("canplay", markCanplay);
  video.addEventListener("playing", markFirstFrame);
  video.addEventListener("resize", setVideoStats);
  video.addEventListener("error", () => setState("playback_failure"));
  if ("requestVideoFrameCallback" in video) {
    video.requestVideoFrameCallback(markFirstFrame);
  }
  if (video.autoplay) video.play().catch(() => {});
})();
`;
}
