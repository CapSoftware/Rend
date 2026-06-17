import type { WatchPlaybackBootstrapResponse } from "../../../lib/watch-bootstrap.ts";
import { WatchPlayerEnhancer } from "./WatchPlayerEnhancer";

type PlaybackMode = "native_hls" | "hls_js" | "opener" | "primary";
type PlaybackEngine = "auto" | "native" | "mse";
type StartupMode = "hls" | "opener";

type SourceSelection = {
  label: PlaybackMode;
  artifactPath: string;
  url: string;
};

type WatchInstantPlayerProps = {
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
};

function readyBootstrap(data: WatchPlaybackBootstrapResponse | null) {
  return data?.status === "ready" ? data : null;
}

function initialSourceSelection(
  data: WatchPlaybackBootstrapResponse | null,
  startupMode: StartupMode
): SourceSelection | null {
  const ready = readyBootstrap(data);
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

function initialState(data: WatchPlaybackBootstrapResponse | null, selection: SourceSelection | null) {
  if (!data) return "loading";
  if (data.status === "ready") return selection ? "ready" : "not_playable";
  if (data.status === "not_playable") return "not_playable";
  if (data.status === "unavailable") return "unavailable";
  return "bootstrap_failure";
}

function stateMessage(data: WatchPlaybackBootstrapResponse | null, state: string) {
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

function instantPlaybackScript(playerId: string) {
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

export function WatchInstantPlayer({
  assetId,
  autoPlay,
  bootstrapUrl,
  initialBootstrap,
  initialBootstrapMs,
  playbackEngine,
  startupMode,
  telemetryAppVersion,
  telemetryEnabled,
  telemetryUrl,
}: WatchInstantPlayerProps) {
  const playerId = `rend-watch-${assetId}`;
  const ready = readyBootstrap(initialBootstrap);
  const selection = initialSourceSelection(initialBootstrap, startupMode);
  const state = initialState(initialBootstrap, selection);
  const poster = ready?.poster_url;
  const message = stateMessage(initialBootstrap, state);

  return (
    <>
      <section
        id={playerId}
        className="rend-player rend-player--instant"
        data-rend-player-state={state}
        data-rend-player-selected={selection?.label ?? ""}
        data-rend-player-artifact={selection?.artifactPath ?? ""}
        data-rend-ready-status={ready?.status ?? initialBootstrap?.status ?? state}
        data-rend-source-state={ready?.source_state}
        data-rend-playable-state={ready?.playable_state}
        data-rend-manifest-content-type={ready?.manifest_content_type}
        data-rend-opener-content-type={ready?.opener_content_type}
        data-rend-poster={poster ?? ""}
        data-rend-prefetch-hint-count={ready?.prefetch_hints.length ?? 0}
        data-rend-document-start-ms="0"
        data-rend-bootstrap-ms={initialBootstrapMs}
        data-rend-asset-id={assetId}
      >
        <div className="rend-player__stage">
          <video
            className="rend-player__video"
            autoPlay={autoPlay}
            controls
            muted
            poster={poster}
            playsInline
            preload="auto"
            src={selection?.url}
            crossOrigin="use-credentials"
          />
          {selection?.url && (
            <script
              dangerouslySetInnerHTML={{ __html: instantPlaybackScript(playerId) }}
              suppressHydrationWarning
            />
          )}
          {state !== "ready" && (
            <div className="rend-player__overlay" data-rend-player-overlay role="status" aria-live="polite">
              <div className="rend-player__status">{message}</div>
            </div>
          )}
        </div>
      </section>
      <WatchPlayerEnhancer
        assetId={assetId}
        autoPlay={autoPlay}
        bootstrapUrl={bootstrapUrl}
        initialBootstrap={initialBootstrap}
        initialBootstrapMs={initialBootstrapMs}
        playbackEngine={playbackEngine}
        playerId={playerId}
        startupMode={startupMode}
        telemetryAppVersion={telemetryAppVersion}
        telemetryEnabled={telemetryEnabled}
        telemetryUrl={telemetryUrl}
      />
    </>
  );
}
