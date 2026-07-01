import type { WatchPlaybackBootstrapResponse } from "../../../lib/watch-bootstrap.ts";
import {
  initialPlaybackState,
  initialSourceSelection,
  instantPlaybackScript,
  playbackCrossOrigin,
  playbackStateMessage,
  readyBootstrap,
  type PlaybackEngine,
  type StartupMode,
} from "../../../lib/player-engine.ts";
import { WatchPlayerEnhancer } from "./WatchPlayerEnhancer";

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
  telemetryOrganizationId?: string;
  telemetryPageType: "watch" | "embed" | "direct" | "custom";
  telemetryUrl: string;
};

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
  telemetryOrganizationId,
  telemetryPageType,
  telemetryUrl,
}: WatchInstantPlayerProps) {
  const playerId = `rend-watch-${assetId}`;
  const ready = readyBootstrap(initialBootstrap);
  const selection = initialSourceSelection(initialBootstrap, startupMode, playbackEngine);
  const state = initialPlaybackState(
    initialBootstrap,
    selection,
    playbackEngine === "mse" && Boolean(ready?.manifest_url)
  );
  const poster = ready?.poster_url;
  const message = playbackStateMessage(initialBootstrap, state);
  const crossOrigin = playbackCrossOrigin(initialBootstrap);

  return (
    <>
      <section
        id={playerId}
        className="rend-player rend-player--instant"
        suppressHydrationWarning
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
        data-rend-playback-engine={playbackEngine}
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
            preload={autoPlay ? "auto" : "metadata"}
            src={selection?.url}
            crossOrigin={crossOrigin}
            suppressHydrationWarning
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
        telemetryOrganizationId={telemetryOrganizationId}
        telemetryPageType={telemetryPageType}
        telemetryUrl={telemetryUrl}
        richTelemetry
      />
    </>
  );
}
