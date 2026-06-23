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

export function readyBootstrap(data: WatchPlaybackBootstrapResponse | null | undefined) {
  return data?.status === "ready" ? data : null;
}

export function isNativeHlsSupported(video: HTMLVideoElement) {
  return Boolean(
    video.canPlayType("application/vnd.apple.mpegurl") ||
      video.canPlayType("application/x-mpegURL")
  );
}

export function initialSourceSelection(
  data: WatchPlaybackBootstrapResponse | null,
  startupMode: StartupMode
): SourceSelection | null {
  const ready = readyBootstrap(data);
  if (!ready) return null;

  if (startupMode === "opener" && ready.opener_url) {
    return { label: "opener", artifactPath: "opener.mp4", url: ready.opener_url };
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
  selection: SourceSelection | null
) {
  if (!data) return "loading";
  if (data.status === "ready") return selection ? "ready" : "not_playable";
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

function playbackSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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
  const base = {
    playback_session_id: sessionId,
    asset_id: options.assetId,
    event_time_ms: eventTime,
    player_version: "0.1.0",
    app_version: options.telemetryAppVersion,
    selected_playback_mode: selection?.label,
    selected_artifact_path: selection?.artifactPath,
    selected_width: numberAttribute(player, "data-rend-selected-width"),
    selected_height: numberAttribute(player, "data-rend-selected-height"),
  };
  const events = [
    {
      ...base,
      phase: "bootstrap_complete",
      bootstrap_start_ms: 0,
      bootstrap_end_ms: options.initialBootstrapMs,
      bootstrap_duration_ms: options.initialBootstrapMs,
      bootstrap_http_status: options.initialBootstrapMs === undefined ? undefined : 200,
    },
    {
      ...base,
      phase: "source_selected",
    },
    {
      ...base,
      phase: "first_frame",
      first_frame_ms: numberAttribute(player, "data-rend-first-frame-ms"),
    },
  ];

  try {
    void fetch(options.telemetryUrl, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    }).catch(() => undefined);
  } catch {
    // Telemetry must not interfere with playback.
  }
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

  const perfNow = () => Math.max(0, Math.round(performance.now()));
  const send = (phase: string, fields: Record<string, unknown>) => {
    const event = {
      playback_session_id: sessionId,
      asset_id: options.assetId,
      phase,
      event_time_ms: Date.now(),
      player_version: "0.1.0",
      app_version: options.telemetryAppVersion,
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

  let lastSelection: SourceSelection | null = null;
  let sourceSent = false;
  let metadataSent = false;
  let canplaySent = false;
  let firstFrameSent = false;

  const selectionFields = () =>
    lastSelection
      ? {
          selected_playback_mode: lastSelection.label,
          selected_artifact_path: lastSelection.artifactPath,
        }
      : {};

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
    send("first_frame", {
      first_frame_ms: numberAttribute(player, "data-rend-first-frame-ms") ?? perfNow(),
      ...selectionFields(),
    });
  };

  const onMeta = () => emitMetadata();
  const onCan = () => emitCanplay();
  const onPlaying = () => emitFirstFrame();
  video.addEventListener("loadedmetadata", onMeta);
  video.addEventListener("canplay", onCan);
  video.addEventListener("playing", onPlaying);
  if (video.readyState >= 1) emitMetadata();
  if (video.readyState >= 3) emitCanplay();
  if (numberAttribute(player, "data-rend-first-frame-ms") !== undefined) emitFirstFrame();

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
      if (sourceSent) return;
      sourceSent = true;
      send("source_selected", {
        selected_playback_mode: selection.label,
        selected_artifact_path: selection.artifactPath,
      });
    },
    dispose: () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("canplay", onCan);
      video.removeEventListener("playing", onPlaying);
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
