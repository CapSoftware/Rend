"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  className?: string;
  maxPrefetchHints?: number;
  onStateChange?: (state: RendPlayerState) => void;
  onTimingsChange?: (timings: RendPlayerTimings) => void;
};

type HlsInstance = {
  loadSource(source: string): void;
  attachMedia(media: HTMLMediaElement): void;
  destroy(): void;
  on(event: string, callback: (_event: string, data: { fatal?: boolean }) => void): void;
};

type HlsConstructor = {
  new (): HlsInstance;
  isSupported(): boolean;
  Events: {
    ERROR: string;
  };
};

type SourceSelection = {
  label: "manifest" | "hls.js" | "opener" | "primary";
  artifactPath: string;
  url: string;
};

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
      label: "manifest",
      artifactPath: "hls/master.m3u8",
      url: data.manifest_url,
    };
  }

  if (data.manifest_url && hlsSupported) {
    return {
      label: "hls.js",
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
  const parsedManifestUrl = new URL(manifestUrl);
  const token = parsedManifestUrl.searchParams.get("token");
  const response = await fetch(parsedManifestUrl.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HLS manifest failed with HTTP ${response.status}`);
  }

  const manifest = await response.text();
  const signedManifest = manifest
    .split(/\r?\n/)
    .map((line) => signedHlsLine(line, parsedManifestUrl, token))
    .join("\n");

  return URL.createObjectURL(
    new Blob([signedManifest], { type: "application/vnd.apple.mpegurl" })
  );
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

export function RendPlayer({
  assetId,
  bootstrapUrl,
  autoPlay = false,
  muted = true,
  controls = true,
  className,
  maxPrefetchHints = DEFAULT_MAX_PREFETCH_HINTS,
  onStateChange,
  onTimingsChange,
}: RendPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const manifestObjectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadStartedAtRef = useRef<number>(0);
  const triedOpenerFallbackRef = useRef(false);
  const [state, setState] = useState<RendPlayerState>("idle");
  const [message, setMessage] = useState("Loading playback");
  const [bootstrap, setBootstrap] = useState<PlaybackBootstrapResponse | null>(null);
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [timings, setTimings] = useState<RendPlayerTimings>({});

  const resolvedBootstrapUrl = useMemo(
    () => bootstrapUrl ?? `/api/player/${encodeURIComponent(assetId)}`,
    [assetId, bootstrapUrl]
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
      if (!startedAt) return;

      setTimings((current) => {
        if (current[key] !== undefined) return current;
        const next = {
          ...current,
          [key]: Date.now() - startedAt,
        };
        onTimingsChange?.(next);
        return next;
      });
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
        const sourceUrl =
          nextSelection.artifactPath === "hls/master.m3u8"
            ? await signedHlsManifestObjectUrl(nextSelection.url)
            : nextSelection.url;
        if (sourceUrl !== nextSelection.url) {
          manifestObjectUrlRef.current = sourceUrl;
        }

        if (nextSelection.label === "hls.js" && Hls) {
          const hls = new Hls();
          hlsRef.current = hls;
          hls.on(Hls.Events.ERROR, (_event, errorData) => {
            if (!errorData.fatal) return;

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
      } catch {
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
    [destroyHls, revokeManifestObjectUrl, setPlayerState]
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
    setTimings({});
    setPlayerState("loading");

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

      setBootstrap(data);
      recordTiming("bootstrapMs");

      if (!response.ok || data.status !== "ready") {
        const nextState =
          data.status === "not_playable"
            ? "not_playable"
            : data.status === "unavailable"
              ? "unavailable"
              : "bootstrap_failure";
        const nextMessage =
          data.status === "ready" ? `HTTP ${response.status}` : data.message;
        setPlayerState(nextState, nextMessage);
        return;
      }

      let Hls: HlsConstructor | null = null;
      try {
        const hlsModule = await import("hls.js");
        Hls = hlsModule.default as HlsConstructor;
      } catch {
        Hls = null;
      }

      const nextSelection = selectedSource(data, video, Boolean(Hls?.isSupported()));
      if (!nextSelection) {
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
      setPlayerState("bootstrap_failure", "Playback bootstrap failed");
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
    }
  }, [
    assetId,
    destroyHls,
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
  }, [destroyHls, loadPlayback, revokeManifestObjectUrl]);

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
    >
      <div className="rend-player__stage">
        <video
          ref={videoRef}
          className="rend-player__video"
          controls={controls}
          muted={muted}
          autoPlay={autoPlay}
          playsInline
          preload="metadata"
          crossOrigin="anonymous"
          onLoadedMetadata={() => {
            recordTiming("metadataMs");
            setPlayerState("metadata");
          }}
          onCanPlay={() => {
            recordTiming("canplayMs");
            setPlayerState("canplay");
          }}
          onPlaying={() => {
            recordTiming("firstFrameMs");
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

            setPlayerState(
              isTokenExpired(data) ? "token_expired" : "playback_failure"
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
