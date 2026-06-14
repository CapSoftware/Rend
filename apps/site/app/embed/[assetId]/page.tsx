import { RendPlayer } from "@rend/player";
import type { Metadata } from "next";

type EmbedPageProps = {
  params: Promise<{ assetId: string }>;
  searchParams: Promise<{
    autoplay?: string | string[];
    playbackBaseUrl?: string | string[];
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
        />
      </section>
    </main>
  );
}
