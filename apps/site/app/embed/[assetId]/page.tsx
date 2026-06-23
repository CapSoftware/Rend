import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { headers } from "next/headers";
import {
  WATCH_BOOTSTRAP_HEADER,
  WATCH_BOOTSTRAP_MS_HEADER,
  decodeWatchBootstrapHeader,
  safeWatchBootstrapMs,
  type WatchPlaybackBootstrapResponse,
} from "../../../lib/watch-bootstrap.ts";
import {
  initialPlaybackState,
  initialSourceSelection,
  instantPlaybackScript,
  playbackStateMessage,
  readyBootstrap,
  type PlaybackEngine,
  type StartupMode,
} from "../../../lib/player-engine.ts";
import { PlayerControls } from "../../../components/player/PlayerControls.tsx";
import { EmbedPlayerClient } from "./EmbedPlayerClient.tsx";

type Query = Record<string, string | string[] | undefined>;

type EmbedPageProps = {
  params: Promise<{ assetId: string }>;
  searchParams: Promise<Query>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Rend player",
  robots: {
    index: false,
    follow: false,
  },
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function flag(value: string | string[] | undefined, fallback: boolean) {
  const requested = firstValue(value);
  if (requested === undefined) return fallback;
  return requested === "1" || requested === "true" || requested === "";
}

function playerBootstrapUrl(assetId: string, playbackBaseUrl: string | string[] | undefined) {
  const url = `/api/player/${encodeURIComponent(assetId)}`;
  const base = firstValue(playbackBaseUrl);
  if (!base) return url;
  return `${url}?playbackBaseUrl=${encodeURIComponent(base)}`;
}

function telemetryAppVersion() {
  return (
    process.env.NEXT_PUBLIC_REND_APP_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
    "0.1.0"
  );
}

function telemetryEnabled(value: string | string[] | undefined) {
  const requested = firstValue(value);
  if (requested === "0") return false;
  if (requested === "1") return true;
  return process.env.NEXT_PUBLIC_REND_PLAYER_TELEMETRY === "1";
}

function playerStartupMode(query: Query): StartupMode {
  const requested = firstValue(query.startupMode) ?? firstValue(query.startup);
  return requested === "opener" ? "opener" : "hls";
}

function playerPlaybackEngine(query: Query): PlaybackEngine {
  const requested = firstValue(query.playbackEngine) ?? firstValue(query.engine);
  return requested === "mse" || requested === "native" ? requested : "auto";
}

function accentColor(value: string | string[] | undefined) {
  const requested = firstValue(value)?.trim().replace(/^#/, "");
  if (!requested) return null;
  if (/^[0-9a-f]{3}$/i.test(requested) || /^[0-9a-f]{6}$/i.test(requested)) {
    return `#${requested.toLowerCase()}`;
  }
  return null;
}

function startTimeSeconds(value: string | string[] | undefined) {
  const requested = firstValue(value);
  if (!requested) return undefined;
  const parsed = Number(requested);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 86_400 ? parsed : undefined;
}

function playbackEdgeHint(bootstrap: WatchPlaybackBootstrapResponse | null) {
  if (bootstrap?.status !== "ready") return null;
  const url = bootstrap.manifest_url ?? bootstrap.playback_url ?? bootstrap.opener_url;
  if (!url) return null;
  try {
    const parsed = new URL(url, "https://rend.local");
    if (parsed.origin === "https://rend.local") return null;
    return { dnsPrefetch: `//${parsed.host}`, origin: parsed.origin };
  } catch {
    return null;
  }
}

export default async function EmbedPage({ params, searchParams }: EmbedPageProps) {
  const [{ assetId }, query, headerStore] = await Promise.all([params, searchParams, headers()]);

  const initialBootstrap = decodeWatchBootstrapHeader(headerStore.get(WATCH_BOOTSTRAP_HEADER));
  const initialBootstrapMs = safeWatchBootstrapMs(headerStore.get(WATCH_BOOTSTRAP_MS_HEADER));

  const autoPlay = flag(query.autoplay, false);
  const muted = firstValue(query.muted) !== undefined ? flag(query.muted, true) : autoPlay;
  const loop = flag(query.loop, false);
  const controls = flag(query.controls, true);
  const accent = accentColor(query.accent ?? query.color);
  const startTime = startTimeSeconds(query.t ?? query.start);
  const startupMode = playerStartupMode(query);
  const playbackEngine = playerPlaybackEngine(query);

  const ready = readyBootstrap(initialBootstrap);
  const selection = initialSourceSelection(initialBootstrap, startupMode);
  const state = initialPlaybackState(initialBootstrap, selection);
  const poster = ready?.poster_url;
  const message = playbackStateMessage(initialBootstrap, state);
  const edgeHint = playbackEdgeHint(initialBootstrap);

  const playerId = `rend-embed-${assetId}`;
  const sectionStyle = accent ? ({ "--rend-accent": accent } as CSSProperties) : undefined;
  const sectionClassName = [
    "rend-player",
    "rend-player--embed",
    controls ? "is-paused" : "rend-player--no-ui",
  ].join(" ");

  return (
    <main className="rend-embed">
      {edgeHint && (
        <>
          <link rel="dns-prefetch" href={edgeHint.dnsPrefetch} />
          <link rel="preconnect" href={edgeHint.origin} crossOrigin="" />
        </>
      )}
      <section
        id={playerId}
        className={sectionClassName}
        style={sectionStyle}
        aria-label="Video player"
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
        data-rend-document-start-ms="0"
        data-rend-bootstrap-ms={initialBootstrapMs}
        data-rend-asset-id={assetId}
      >
        <div className="rend-player__stage">
          <video
            className="rend-player__video"
            autoPlay={autoPlay}
            controls={controls}
            muted={muted}
            loop={loop}
            poster={poster}
            playsInline
            preload={autoPlay ? "auto" : "metadata"}
            src={selection?.url}
            crossOrigin="use-credentials"
            suppressHydrationWarning
          />
          {controls && <PlayerControls />}
          {selection?.url && (
            <script
              dangerouslySetInnerHTML={{
                __html: instantPlaybackScript(playerId, { customControls: controls }),
              }}
              suppressHydrationWarning
            />
          )}
          <div className="rend-player__overlay" data-rend-player-overlay role="status" aria-live="polite">
            <div className="rend-player__spinner" aria-hidden="true">
              <svg viewBox="0 0 50 50" width="44" height="44">
                <circle className="rend-ctrl__spinner-track" cx="25" cy="25" r="20" fill="none" strokeWidth="4" />
                <circle className="rend-ctrl__spinner-head" cx="25" cy="25" r="20" fill="none" strokeWidth="4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="rend-player__message">{message}</div>
          </div>
        </div>
      </section>
      <EmbedPlayerClient
        assetId={assetId}
        autoPlay={autoPlay}
        bootstrapUrl={playerBootstrapUrl(assetId, query.playbackBaseUrl)}
        controls={controls}
        initialBootstrap={initialBootstrap}
        initialBootstrapMs={initialBootstrapMs}
        playbackEngine={playbackEngine}
        playerId={playerId}
        startTime={startTime}
        startupMode={startupMode}
        telemetryAppVersion={telemetryAppVersion()}
        telemetryEnabled={telemetryEnabled(query.telemetry)}
        telemetryUrl="/api/player/telemetry"
      />
    </main>
  );
}
