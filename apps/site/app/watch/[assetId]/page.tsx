import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  WATCH_BOOTSTRAP_HEADER,
  WATCH_BOOTSTRAP_MS_HEADER,
  decodeWatchBootstrapHeader,
  safeWatchBootstrapMs,
  type WatchPlaybackBootstrapResponse,
} from "../../../lib/watch-bootstrap.ts";
import { WatchInstantPlayer } from "./WatchInstantPlayer";

type WatchPageProps = {
  params: Promise<{ assetId: string }>;
  searchParams: Promise<{
    autoplay?: string | string[];
    engine?: string | string[];
    playbackBaseUrl?: string | string[];
    playbackEngine?: string | string[];
    startup?: string | string[];
    startupMode?: string | string[];
    telemetry?: string | string[];
  }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Rend player",
  robots: {
    index: false,
    follow: false,
  },
};

function playerBootstrapUrl(assetId: string, playbackBaseUrl: string | string[] | undefined) {
  const url = `/api/player/${encodeURIComponent(assetId)}`;
  if (typeof playbackBaseUrl !== "string" || !playbackBaseUrl) return url;
  return `${url}?playbackBaseUrl=${encodeURIComponent(playbackBaseUrl)}`;
}

function telemetryAppVersion() {
  return (
    process.env.NEXT_PUBLIC_REND_APP_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
    "0.1.0"
  );
}

function telemetryDefaultEnabled() {
  const configured = process.env.NEXT_PUBLIC_REND_PLAYER_TELEMETRY?.trim().toLowerCase();
  if (configured) return ["1", "true", "yes", "on"].includes(configured);
  const profile = (process.env.REND_ENV_PROFILE || process.env.REND_ENV || process.env.NODE_ENV || "local").toLowerCase();
  return profile === "production" || profile === "prod";
}

function telemetryEnabled(value: string | string[] | undefined) {
  const requested = Array.isArray(value) ? value[0] : value;
  if (requested === "0") return false;
  if (requested === "1") return true;
  return telemetryDefaultEnabled();
}

function playerStartupMode(
  startupMode: string | string[] | undefined,
  startup: string | string[] | undefined
) {
  const requested = Array.isArray(startupMode)
    ? startupMode[0]
    : startupMode ?? (Array.isArray(startup) ? startup[0] : startup);
  return requested === "opener" ? "opener" : "hls";
}

function playerPlaybackEngine(
  playbackEngine: string | string[] | undefined,
  engine: string | string[] | undefined
) {
  const requested = Array.isArray(playbackEngine)
    ? playbackEngine[0]
    : playbackEngine ?? (Array.isArray(engine) ? engine[0] : engine);
  return requested === "mse" || requested === "native" ? requested : "auto";
}

function autoplayEnabled(value: string | string[] | undefined) {
  const requested = Array.isArray(value) ? value[0] : value;
  return requested !== "0";
}

function playbackEdgeHint(bootstrap: WatchPlaybackBootstrapResponse | null) {
  if (bootstrap?.status !== "ready") return null;
  const url = bootstrap.manifest_url ?? bootstrap.playback_url ?? bootstrap.opener_url;
  if (!url) return null;

  try {
    const parsed = new URL(url, "https://rend.local");
    if (parsed.origin === "https://rend.local") return null;
    return {
      dnsPrefetch: `//${parsed.host}`,
      origin: parsed.origin,
    };
  } catch {
    return null;
  }
}

export default async function WatchPage({ params, searchParams }: WatchPageProps) {
  const [{ assetId }, query, headerStore] = await Promise.all([params, searchParams, headers()]);
  const initialBootstrap = decodeWatchBootstrapHeader(headerStore.get(WATCH_BOOTSTRAP_HEADER));
  const initialBootstrapMs = safeWatchBootstrapMs(headerStore.get(WATCH_BOOTSTRAP_MS_HEADER));
  const edgeHint = playbackEdgeHint(initialBootstrap);

  return (
    <main className="rend-embed-page">
      {edgeHint && (
        <>
          <link rel="dns-prefetch" href={edgeHint.dnsPrefetch} />
          <link rel="preconnect" href={edgeHint.origin} crossOrigin="" />
        </>
      )}
      <section className="rend-embed-shell" aria-label="Rend video player">
        <WatchInstantPlayer
          assetId={assetId}
          autoPlay={autoplayEnabled(query.autoplay)}
          bootstrapUrl={playerBootstrapUrl(assetId, query.playbackBaseUrl)}
          initialBootstrap={initialBootstrap}
          initialBootstrapMs={initialBootstrapMs}
          playbackEngine={playerPlaybackEngine(query.playbackEngine, query.engine)}
          startupMode={playerStartupMode(query.startupMode, query.startup)}
          telemetryAppVersion={telemetryAppVersion()}
          telemetryEnabled={telemetryEnabled(query.telemetry)}
          telemetryOrganizationId={
            initialBootstrap?.status === "ready" ? initialBootstrap.organization_id : undefined
          }
          telemetryPageType="watch"
          telemetryUrl="/api/player/telemetry"
        />
      </section>
    </main>
  );
}
