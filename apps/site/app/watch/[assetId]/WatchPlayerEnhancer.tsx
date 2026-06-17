"use client";

import { useEffect } from "react";
import type {
  WatchPlaybackBootstrapReady,
  WatchPlaybackBootstrapResponse,
} from "../../../lib/watch-bootstrap.ts";

type PlaybackMode = "native_hls" | "hls_js" | "opener" | "primary";
type PlaybackEngine = "auto" | "native" | "mse";
type StartupMode = "hls" | "opener";

type SourceSelection = {
  label: PlaybackMode;
  artifactPath: string;
  url: string;
};

type WatchPlayerEnhancerProps = {
  assetId: string;
  autoPlay: boolean;
  bootstrapUrl: string;
  initialBootstrap: WatchPlaybackBootstrapResponse | null;
  initialBootstrapMs?: number;
  playbackEngine: PlaybackEngine;
  playerId: string;
  startupMode: StartupMode;
  telemetryAppVersion: string;
  telemetryEnabled: boolean;
  telemetryUrl: string;
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

function asReady(data: WatchPlaybackBootstrapResponse | null | undefined) {
  return data?.status === "ready" ? data : null;
}

function isNativeHlsSupported(video: HTMLVideoElement) {
  return Boolean(
    video.canPlayType("application/vnd.apple.mpegurl") ||
      video.canPlayType("application/x-mpegURL")
  );
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

function fallbackPrimarySource(data: WatchPlaybackBootstrapReady): SourceSelection | null {
  if (!data.playback_url) return null;
  return {
    label: "primary",
    artifactPath: data.playable_state === "hls_ready" ? "hls/master.m3u8" : "opener.mp4",
    url: data.playback_url,
  };
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
  props: WatchPlayerEnhancerProps,
  selection: SourceSelection | null
) {
  if (!props.telemetryEnabled || !props.telemetryUrl) return;
  if (player.dataset.rendTelemetrySent === "1") return;
  player.dataset.rendTelemetrySent = "1";

  const sessionId = playbackSessionId();
  setAttribute(player, "data-rend-playback-session-id", sessionId);
  const eventTime = Date.now();
  const base = {
    playback_session_id: sessionId,
    asset_id: props.assetId,
    event_time_ms: eventTime,
    player_version: "0.1.0",
    app_version: props.telemetryAppVersion,
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
      bootstrap_end_ms: props.initialBootstrapMs,
      bootstrap_duration_ms: props.initialBootstrapMs,
      bootstrap_http_status: props.initialBootstrapMs === undefined ? undefined : 200,
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
    void fetch(props.telemetryUrl, {
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
  return hlsModule.default as HlsConstructor;
}

export function WatchPlayerEnhancer(props: WatchPlayerEnhancerProps) {
  useEffect(() => {
    const player = document.getElementById(props.playerId);
    const video = player?.querySelector("video");
    if (!(player instanceof HTMLElement) || !(video instanceof HTMLVideoElement)) return;

    let cancelled = false;
    let hls: HlsInstance | null = null;
    let currentSelection: SourceSelection | null = null;
    const cleanupAfterFirstFrame = afterFirstFrame(video, () => {
      emitDeferredTelemetry(player, props, currentSelection);
    });
    const ready = asReady(props.initialBootstrap);

    const applyProgressiveSource = (selection: SourceSelection) => {
      currentSelection = selection;
      setSelection(player, selection);
      setState(player, "ready");
      if (video.currentSrc !== selection.url && video.getAttribute("src") !== selection.url) {
        video.src = selection.url;
        setAttribute(player, "data-rend-src-assigned-ms", Math.max(0, Math.round(performance.now())));
        video.load();
      }
      if (props.autoPlay) void video.play().catch(() => undefined);
    };

    const enhance = async (data: WatchPlaybackBootstrapReady) => {
      const nativeHls = props.playbackEngine !== "mse" && data.manifest_url
        ? isNativeHlsSupported(video)
        : false;
      if (nativeHls && props.startupMode !== "opener") {
        const selection: SourceSelection = {
          label: "native_hls",
          artifactPath: "hls/master.m3u8",
          url: data.manifest_url ?? "",
        };
        currentSelection = selection;
        setSelection(player, selection);
        setState(player, "ready");
        if (!video.currentSrc && !video.getAttribute("src")) {
          video.src = selection.url;
          setAttribute(player, "data-rend-src-assigned-ms", Math.max(0, Math.round(performance.now())));
          video.load();
        }
        if (props.autoPlay) void video.play().catch(() => undefined);
        return;
      }

      let Hls: HlsConstructor | null = null;
      if (data.manifest_url && (props.playbackEngine === "mse" || !nativeHls)) {
        try {
          Hls = await loadHlsConstructor();
        } catch {
          Hls = null;
        }
      }
      if (cancelled) return;

      const support = { nativeHls, hlsJs: Boolean(Hls?.isSupported()) };
      const selection = selectedSource(data, support, props.playbackEngine, props.startupMode);
      if (!selection) {
        setState(player, "not_playable");
        return;
      }

      if (selection.label !== "hls_js" || !Hls) {
        applyProgressiveSource(selection);
        return;
      }

      currentSelection = selection;
      setSelection(player, selection);
      setState(player, "ready");
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
      if (props.autoPlay) void video.play().catch(() => undefined);
    };

    if (ready) {
      void enhance(ready);
    } else if (!props.initialBootstrap) {
      void fetch(props.bootstrapUrl, { cache: "no-store" })
        .then((response) => response.json())
        .then((data: WatchPlaybackBootstrapResponse) => {
          const fetchedReady = asReady(data);
          if (fetchedReady && !cancelled) return enhance(fetchedReady);
          if (!cancelled) setState(player, data.status === "not_playable" ? "not_playable" : "unavailable");
        })
        .catch(() => {
          if (!cancelled) setState(player, "bootstrap_failure");
        });
    }

    return () => {
      cancelled = true;
      cleanupAfterFirstFrame();
      hls?.destroy();
    };
  }, [props]);

  return null;
}
