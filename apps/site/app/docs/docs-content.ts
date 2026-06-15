export type DocsNavItem = {
  href: string;
  title: string;
  description: string;
};

export type DocsCommandItem = DocsNavItem & {
  group: "Docs" | "Reference";
  keywords: string;
};

export const docsNavItems: DocsNavItem[] = [
  {
    href: "#quickstart",
    title: "Quickstart",
    description: "Create a key, upload, wait for playable, embed, and delete.",
  },
  {
    href: "#sdk-guide",
    title: "SDK guide",
    description: "Use the generated TypeScript SDK from packages/sdk.",
  },
  {
    href: "#curl-guide",
    title: "curl guide",
    description: "Use the public API with bearer auth and documented paths.",
  },
  {
    href: "#auth-api-keys",
    title: "Auth and API keys",
    description: "Scopes, headers, and key handling.",
  },
  {
    href: "#playback-embed",
    title: "Playback and embed",
    description: "Tokenless same-origin bootstrap and artifact paths.",
  },
  {
    href: "#billing-usage",
    title: "Billing and usage",
    description: "Autumn limits, tiered delivery seconds, and storage second-months.",
  },
  {
    href: "#error-states",
    title: "Error states",
    description: "not_playable, suspended, unauthorized, upload too large, and deleted.",
  },
  {
    href: "#local-docker",
    title: "Local Docker",
    description: "Run the local stack and integration smoke.",
  },
  {
    href: "#production-notes",
    title: "Production notes",
    description: "Only the env and profile notes needed for public API use.",
  },
  {
    href: "#reference",
    title: "Reference",
    description: "OpenAPI and SDK source links.",
  },
];

export const docsCommandItems: DocsCommandItem[] = [
  ...docsNavItems.map((item) => ({
    ...item,
    href: `/docs${item.href}`,
    group: "Docs" as const,
    keywords: `${item.title} ${item.description}`.toLowerCase(),
  })),
  {
    href: "/openapi.json",
    title: "OpenAPI JSON",
    description: "Canonical Rend public API contract.",
    group: "Reference",
    keywords: "openapi json api schema contract spec",
  },
  {
    href: "https://github.com/CapSoftware/Rend/tree/main/packages/sdk",
    title: "SDK package",
    description: "Generated TypeScript SDK source.",
    group: "Reference",
    keywords: "sdk package generated typescript client github packages sdk",
  },
  {
    href: "/llms.txt",
    title: "llms.txt",
    description: "Agent index for the public docs.",
    group: "Reference",
    keywords: "llms agent index docs ai",
  },
];

export const QUICKSTART_SDK_CODE = `import { readFile } from "node:fs/promises";
import { RendClient } from "@rend/sdk";

const client = new RendClient({
  apiKey: process.env.REND_API_KEY,
});

const file = await readFile("video.mp4");
const upload = await client.uploadAsset(file, {
  contentType: "video/mp4",
  contentLength: file.byteLength,
});

const asset = await client.waitForPlayableAsset(upload.asset_id, {
  timeoutMs: 180_000,
  intervalMs: 1_000,
});

const bootstrap = await client.getPlaybackBootstrap(asset.asset_id);
const source =
  bootstrap.manifest_url ?? bootstrap.playback_url ?? bootstrap.opener_url;
const contentType =
  bootstrap.manifest_content_type ??
  bootstrap.playback_content_type ??
  bootstrap.opener_content_type ??
  "video/mp4";

if (!source) throw new Error("No playable source returned");

const playbackUrl = new URL(source, "https://rend.so").toString();
const embedHtml =
  '<video controls playsinline preload="metadata">' +
  \`<source src="\${playbackUrl}" type="\${contentType}">\` +
  "</video>";

console.log(embedHtml);

await client.deleteAsset(asset.asset_id);`;

export const SDK_GUIDE_CODE = `import { RendClient, RendApiError } from "@rend/sdk";

const rend = new RendClient({
  apiKey: process.env.REND_API_KEY,
  apiBaseUrl: process.env.REND_API_BASE_URL,
  siteBaseUrl: process.env.REND_SITE_BASE_URL,
});

try {
  const assets = await rend.listAssets({ limit: 10 });
  const analytics = await rend.getPlaybackAnalytics(assets.assets[0].asset_id, {
    windowSeconds: 3600,
  });
  console.log(analytics.request_count);
} catch (error) {
  if (error instanceof RendApiError) {
    console.error(error.status, error.body);
  }
  throw error;
}`;

export const CURL_UPLOAD_CODE = `export REND_API_KEY="rend_live_..."
export REND_API_BASE_URL="https://api.rend.so"
export REND_SITE_BASE_URL="https://rend.so"

curl -fsS -X POST "$REND_API_BASE_URL/v1/videos" \\
  -H "authorization: Bearer $REND_API_KEY" \\
  -H "content-type: video/mp4" \\
  --data-binary @video.mp4 > upload.json

ASSET_ID="$(jq -r '.asset_id' upload.json)"

until curl -fsS "$REND_API_BASE_URL/v1/assets/$ASSET_ID" \\
  -H "authorization: Bearer $REND_API_KEY" > asset.json &&
  [ "$(jq -r '.playable_state' asset.json)" = "hls_ready" ]; do
  sleep 1
done

curl -fsS "$REND_SITE_BASE_URL/api/player/$ASSET_ID" > playback.json

curl -fsS "$REND_API_BASE_URL/v1/assets/$ASSET_ID/analytics/playback?window_seconds=3600" \\
  -H "authorization: Bearer $REND_API_KEY" > analytics.json

curl -fsS -X DELETE "$REND_API_BASE_URL/v1/assets/$ASSET_ID" \\
  -H "authorization: Bearer $REND_API_KEY"`;

export const AUTH_HEADER_CODE = `Authorization: Bearer $REND_API_KEY`;

export const PLAYBACK_BOOTSTRAP_CODE = `GET https://rend.so/api/player/018f52b2-5401-7f3b-ae2e-4923f4d62120

{
  "status": "ready",
  "asset_id": "018f52b2-5401-7f3b-ae2e-4923f4d62120",
  "source_state": "uploaded",
  "playable_state": "hls_ready",
  "manifest_url": "/api/player/018f52b2-5401-7f3b-ae2e-4923f4d62120/artifact/hls/master.m3u8",
  "manifest_content_type": "application/vnd.apple.mpegurl",
  "opener_url": "/api/player/018f52b2-5401-7f3b-ae2e-4923f4d62120/artifact/opener.mp4",
  "opener_content_type": "video/mp4",
  "ttl_seconds": 900,
  "prefetch_hints": []
}`;

export const LOCAL_DOCKER_CODE = `bun install
cp .env.local.example .env.local
bun run backend:docker:build
bun run backend:docker:up
bun run dev:site
bun run sdk:integration-smoke`;
