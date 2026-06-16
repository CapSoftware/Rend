import { RendPlayer } from "@rend/player";
import type { Metadata } from "next";

type EmbedPageProps = {
  params: Promise<{ assetId: string }>;
  searchParams: Promise<{
    autoplay?: string | string[];
    playbackBaseUrl?: string | string[];
    telemetry?: string | string[];
  }>;
};

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

function telemetryEnabled(value: string | string[] | undefined) {
  const requested = Array.isArray(value) ? value[0] : value;
  if (requested === "0") return false;
  if (requested === "1") return true;
  return process.env.NEXT_PUBLIC_REND_PLAYER_TELEMETRY === "1";
}

export default async function EmbedPage({ params, searchParams }: EmbedPageProps) {
  const [{ assetId }, query] = await Promise.all([params, searchParams]);

  return (
    <main className="rend-embed-page">
      <section className="rend-embed-shell" aria-label="Rend video player">
        <header className="rend-embed-header">
          <img src="/rend-logo.svg" alt="Rend" className="rend-embed-logo" />
          <span className="rend-embed-asset">{assetId}</span>
        </header>
        <RendPlayer
          assetId={assetId}
          autoPlay={query.autoplay === "1"}
          bootstrapUrl={playerBootstrapUrl(assetId, query.playbackBaseUrl)}
          maxPrefetchHints={2}
          telemetryAppVersion={telemetryAppVersion()}
          telemetryEnabled={telemetryEnabled(query.telemetry)}
          telemetryUrl="/api/player/telemetry"
        />
      </section>
    </main>
  );
}
