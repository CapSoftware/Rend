"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  generatePlaybackSessionId,
  readableTelemetryHeaders,
  REND_PLAYER_VERSION,
  sendPlayerTelemetryEvent,
  telemetryLabelsFromHeaders,
} from "./telemetry";
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
  loadSource(source: string): void;
  attachMedia(media: HTMLMediaElement): void;
  destroy(): void;
  on(
    event: string,
    callback: (
      _event: string,
      data: {
        details?: string;
        fatal?: boolean;
        response?: { code?: number };
        type?: string;
      }
    ) => void
  ): void;
};

type HlsConstructor = {
  new (): HlsInstance;
  isSupported(): boolean;
  Events: {
    ERROR: string;
  };
};

type SourceSelection = {
  label: RendPlayerPlaybackMode;
  artifactPath: string;
  url: string;
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

function selectedSource(
  data: PlaybackBootstrapReady,
  video: HTMLVideoElement,
  hlsSupported: boolean
): SourceSelection | null {
  if (data.manifest_url && isNativeHlsSupported(video)) {
    return {
      label: "native_hls",
      artifactPath: "hls/master.m3u8",
      url: data.manifest_url,
    };
  }

  if (data.manifest_url && hlsSupported) {
    return {
      label: "hls_js",
      artifactPath: "hls/master.m3u8",
      url: data.manifest_url,
    };
  }

  if (data.opener_url) {
    return {
      label: "opener",
      artifactPath: "opener.mp4",
      url: data.opener_url,
    };
  }

  if (data.playback_url) {
    return {
      label: "primary",
      artifactPath: data.playable_state === "hls_ready" ? "hls/master.m3u8" : "opener.mp4",
      url: data.playback_url,
    };
  }

  return null;
}

function openerSource(data: PlaybackBootstrapReady): SourceSelection | null {
  if (!data.opener_url) return null;
  return {
    label: "opener",
    artifactPath: "opener.mp4",
    url: data.opener_url,
  };
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

async function signedHlsManifestObjectUrl(manifestUrl: string) {
  const parsedManifestUrl = new URL(manifestUrl, window.location.href);
  const token = parsedManifestUrl.searchParams.get("token");
  const response = await fetch(parsedManifestUrl.toString(), { cache: "no-store" });
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

export function RendPlayer({
  assetId,
  bootstrapUrl,
  autoPlay = false,
  muted = true,
  controls = true,
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
  const timingsRef = useRef<RendPlayerTimings>({});
  const triedOpenerFallbackRef = useRef(false);
  const [state, setState] = useState<RendPlayerState>("idle");
  const [message, setMessage] = useState("Loading playback");
  const [bootstrap, setBootstrap] = useState<PlaybackBootstrapResponse | null>(null);
  const [selection, setSelection] = useState<SourceSelection | null>(null);
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

  const loadSource = useCallback(
    async (
      data: PlaybackBootstrapReady,
      nextSelection: SourceSelection,
      Hls: HlsConstructor | null
    ) => {
      const video = videoRef.current;
      if (!video) return;

      destroyHls();
      revokeManifestObjectUrl();
      video.removeAttribute("src");
      video.load();

      setSelection(nextSelection);
      setPlayerState("ready");

      try {
        let sourceUrl = nextSelection.url;
        let sourceTelemetry: Pick<
          RendPlayerTelemetryEvent,
          "cache_headers" | "edge_label" | "region_label"
        > = {};

        if (nextSelection.artifactPath === "hls/master.m3u8") {
          const manifest = await signedHlsManifestObjectUrl(nextSelection.url);
          sourceUrl = manifest.sourceUrl;
          sourceTelemetry = {
            cache_headers: manifest.cacheHeaders,
            edge_label: manifest.edgeLabel,
            region_label: manifest.regionLabel,
          };
        }

        if (sourceUrl !== nextSelection.url) {
          manifestObjectUrlRef.current = sourceUrl;
        }

        emitTelemetry({
          phase: "source_selected",
          ...selectionTelemetryFields(nextSelection),
          ...sourceTelemetry,
        });

        if (nextSelection.label === "hls_js" && Hls) {
          const hls = new Hls();
          hlsRef.current = hls;
          hls.on(Hls.Events.ERROR, (_event, errorData) => {
            if (!errorData.fatal) return;

            emitTelemetry({
              phase: "playback_failure",
              playback_failure_code: "hls_js_fatal",
              playback_failure_reason: hlsFailureReason(errorData),
              ...selectionTelemetryFields(nextSelection),
            });

            const opener = openerSource(data);
            if (!triedOpenerFallbackRef.current && opener) {
              triedOpenerFallbackRef.current = true;
              void loadSource(data, opener, null);
              return;
            }

            setPlayerState(
              isTokenExpired(data) ? "token_expired" : "playback_failure"
            );
          });
          hls.loadSource(sourceUrl);
          hls.attachMedia(video);
          return;
        }

        video.src = sourceUrl;
        video.load();
      } catch (error) {
        emitTelemetry({
          phase: "playback_failure",
          ...selectionTelemetryFields(nextSelection),
          ...playbackLoadErrorFields(
            error,
            nextSelection.artifactPath === "hls/master.m3u8"
              ? "hls_manifest_load_failed"
              : "source_load_failed",
            "Playback source failed to load"
          ),
        });

        const opener = openerSource(data);
        if (
          nextSelection.artifactPath === "hls/master.m3u8" &&
          !triedOpenerFallbackRef.current &&
          opener
        ) {
          triedOpenerFallbackRef.current = true;
          await loadSource(data, opener, null);
          return;
        }

        setPlayerState(isTokenExpired(data) ? "token_expired" : "playback_failure");
      }
    },
    [destroyHls, emitTelemetry, revokeManifestObjectUrl, setPlayerState]
  );

  const loadPlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    triedOpenerFallbackRef.current = false;
    abortRef.current?.abort();
    loadStartedAtRef.current = Date.now();
    destroyHls();
    setSelection(null);
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

      const nextSelection = selectedSource(data, video, Boolean(Hls?.isSupported()));
      if (!nextSelection) {
        emitTelemetry({
          phase: "playback_failure",
          playback_failure_code: "no_playable_artifact",
          playback_failure_reason: "No playable artifact is available",
        });
        setPlayerState("not_playable", "No playable artifact is available");
        return;
      }

      await loadSource(data, nextSelection, Hls);
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
    destroyHls,
    emitTelemetry,
    loadSource,
    recordTiming,
    resolvedBootstrapUrl,
    setPlayerState,
  ]);

  useEffect(() => {
    void loadPlayback();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      destroyHls();
      revokeManifestObjectUrl();
    };
  }, [destroyHls, loadPlayback, playbackSessionId, revokeManifestObjectUrl]);

  useEffect(() => {
    if (!bootstrap || bootstrap.status !== "ready") return;
    const hints = bootstrap.prefetch_hints.slice(
      0,
      Math.max(0, maxPrefetchHints)
    );
    const links = hints.map((hint) => {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.as = "fetch";
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
          playsInline
          preload={preload}
          crossOrigin="anonymous"
          onLoadedMetadata={() => {
            const metadataMs = recordTiming("metadataMs");
            if (metadataMs !== undefined) {
              emitTelemetry({
                phase: "metadata_loaded",
                metadata_loaded_ms: metadataMs,
                ...selectionTelemetryFields(selection),
              });
            }
            setPlayerState("metadata");
          }}
          onCanPlay={() => {
            const canplayMs = recordTiming("canplayMs");
            if (canplayMs !== undefined) {
              emitTelemetry({
                phase: "canplay",
                canplay_ms: canplayMs,
                ...selectionTelemetryFields(selection),
              });
            }
            setPlayerState("canplay");
          }}
          onPlaying={() => {
            const firstFrameMs = recordTiming("firstFrameMs");
            if (firstFrameMs !== undefined) {
              emitTelemetry({
                phase: "first_frame",
                first_frame_ms: firstFrameMs,
                ...selectionTelemetryFields(selection),
              });
            }
            setPlayerState("playing");
          }}
          onError={() => {
            const data = readyBootstrap;
            const opener = data ? openerSource(data) : null;
            if (
              data &&
              opener &&
              selection?.label !== "opener" &&
              !triedOpenerFallbackRef.current
            ) {
              triedOpenerFallbackRef.current = true;
              void loadSource(data, opener, null);
              return;
            }

            const mediaError = videoRef.current?.error;
            const tokenExpired = isTokenExpired(data);
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
              ...selectionTelemetryFields(selection),
            });
            setPlayerState(
              tokenExpired ? "token_expired" : "playback_failure"
            );
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
