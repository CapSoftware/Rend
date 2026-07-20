import { AGENT_PROMPT_CODE } from "../../lib/agent-readiness.ts";

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
    description:
      "Sign up, choose a plan, create a key, upload, embed, and delete.",
  },
  {
    href: "#agent-setup",
    title: "Agent setup",
    description:
      "Give an agent the docs, API contract, safe key rules, and smoke test path.",
  },
  {
    href: "#mcp-server",
    title: "MCP server",
    description:
      "Install Rend tools in Cursor or any MCP client with one click or copyable config.",
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
    href: "#resumable-uploads",
    title: "Resumable uploads",
    description: "Upload parts directly to storage with checksums, retries, and resume support.",
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
    description:
      "Delivered watch minutes and stored video minutes.",
  },
  {
    href: "#error-states",
    title: "Error states",
    description:
      "not_playable, suspended, unauthorized, upload too large, and deleted.",
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
    href: "https://github.com/CapSoftware/Rend/tree/main/packages/mcp",
    title: "MCP package",
    description: "Rend MCP server for compatible agent clients.",
    group: "Reference",
    keywords: "mcp package agent tools claude codex model context protocol",
  },
  {
    href: "/llms.txt",
    title: "llms.txt",
    description: "Agent index for the public docs.",
    group: "Reference",
    keywords: "llms agent index docs ai",
  },
  {
    href: "/llms-full.txt",
    title: "llms-full.txt",
    description:
      "Plain-text marketing content for larger model context windows.",
    group: "Reference",
    keywords: "llms full plain text marketing faqs context",
  },
];

export { AGENT_PROMPT_CODE };

export const QUICKSTART_SDK_CODE = `import { readFile } from "node:fs/promises";
import { RendClient } from "@rend-sdk/client";

// 1. Sign in at https://rend.so/login with an email code.
// 2. Choose a plan in the dashboard.
// 3. Create an API key with upload, read, delete, and analytics scopes.
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

export const SDK_GUIDE_CODE = `import { RendClient, RendApiError } from "@rend-sdk/client";

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

export const MCP_CLIENT_CONFIG_CODE = `{
  "mcpServers": {
    "rend": {
      "command": "npx",
      "args": ["-y", "@rend-sdk/mcp"],
      "env": {
        "REND_API_KEY": "rend_live_...",
        "REND_API_BASE_URL": "https://api.rend.so",
        "REND_SITE_BASE_URL": "https://rend.so"
      }
    }
  }
}`;

export const MCP_INSTALL_COMMAND_CODE = `npx -y @rend-sdk/mcp`;

export const MCP_CURSOR_INSTALL_URL =
  "cursor://anysphere.cursor-deeplink/mcp/install?name=rend&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkByZW5kLXNkay9tY3AiXSwiZW52Ijp7IlJFTkRfQVBJX0tFWSI6InJlbmRfbGl2ZV8uLi4iLCJSRU5EX0FQSV9CQVNFX1VSTCI6Imh0dHBzOi8vYXBpLnJlbmQuc28iLCJSRU5EX1NJVEVfQkFTRV9VUkwiOiJodHRwczovL3JlbmQuc28ifX0%3D";

export const MCP_LOCAL_CONFIG_CODE = `{
  "mcpServers": {
    "rend-local": {
      "command": "node",
      "args": ["packages/mcp/dist/bin/rend-mcp.js"],
      "env": {
        "REND_API_KEY": "rend_test_...",
        "REND_API_BASE_URL": "http://127.0.0.1:4000",
        "REND_SITE_BASE_URL": "http://127.0.0.1:3000"
      }
    }
  }
}`;

export const MCP_SMOKE_CODE = `bun install
bun run mcp:smoke`;

export const CURL_UPLOAD_CODE = `export REND_API_KEY="rend_live_..."
export REND_API_BASE_URL="https://api.rend.so"
export REND_SITE_BASE_URL="https://rend.so"

# First: sign in at https://rend.so/login, choose a plan, and create an API key.
# Compatibility: one-shot raw uploads remain supported at /v1/videos.

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

export const RESUMABLE_UPLOAD_FLOW_CODE = `POST /v1/uploads
Authorization: Bearer $REND_API_KEY
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "content_type": "video/mp4",
  "content_length": 42881500,
  "filename": "video.mp4"
}

# Split the file into the returned 16 MiB part_size.
# For batches of at most 10 parts, compute each base64 SHA-256 digest:
POST /v1/uploads/{uploadId}/parts
{
  "parts": [{ "part_number": 1, "checksum_sha256": "base64-sha256=" }]
}

# PUT each part directly to its returned URL with the returned headers.
# Keep the ETag, then resume safely by reading provider-confirmed parts:
GET /v1/uploads/{uploadId}

POST /v1/uploads/{uploadId}/complete
{
  "parts": [{
    "part_number": 1,
    "etag": "returned-etag",
    "checksum_sha256": "base64-sha256="
  }]
}

# Cancel an unfinished session and release its reserved storage:
DELETE /v1/uploads/{uploadId}`;

export const AUTH_HEADER_CODE = `Authorization: Bearer $REND_API_KEY`;

export const PLAYBACK_BOOTSTRAP_CODE = `GET https://rend.so/api/player/018f52b2-5401-7f3b-ae2e-4923f4d62120

{
  "status": "ready",
  "asset_id": "018f52b2-5401-7f3b-ae2e-4923f4d62120",
  "source_state": "uploaded",
  "playable_state": "hls_ready",
  "playback_url": "/api/player/018f52b2-5401-7f3b-ae2e-4923f4d62120/artifact/hls/master.m3u8",
  "playback_content_type": "application/vnd.apple.mpegurl",
  "manifest_url": "/api/player/018f52b2-5401-7f3b-ae2e-4923f4d62120/artifact/hls/master.m3u8",
  "manifest_content_type": "application/vnd.apple.mpegurl",
  "playback_token_expires_at": 1781432100,
  "ttl_seconds": 900,
  "prefetch_hints": [
    {
      "artifact_path": "hls/360p/init_360p.mp4",
      "url": "/api/player/018f52b2-5401-7f3b-ae2e-4923f4d62120/artifact/hls/360p/init_360p.mp4",
      "content_type": "video/mp4"
    }
  ]
}`;

export const LOCAL_DOCKER_CODE = `bun install
cp .env.local.example .env.local
bun run backend:docker:build
bun run backend:docker:up
bun run dev:site
bun run sdk:integration-smoke`;
