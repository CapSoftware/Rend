import { siteOrigin } from "./seo.ts";

export const agentResourceLinks = [
  {
    label: "llms.txt",
    href: "/llms.txt",
    description: "Stable index for models",
  },
  {
    label: "Full LLM context",
    href: "/llms-full.txt",
    description: "Plain-text site content",
  },
  {
    label: "OpenAPI",
    href: "/openapi.json",
    description: "Canonical API contract",
  },
  {
    label: "TypeScript SDK",
    href: "https://github.com/CapSoftware/Rend/tree/main/packages/sdk",
    description: "Generated client source",
  },
] as const;

export const AGENT_PROMPT_CODE = `You are integrating Rend into my app.

Use these Rend sources first:
- ${siteOrigin}/llms.txt
- ${siteOrigin}/docs
- ${siteOrigin}/openapi.json
- https://github.com/CapSoftware/Rend/tree/main/packages/sdk

Default hosted bases:
- API: https://api.rend.so
- Site and player: ${siteOrigin}

Build this integration:
1. Add server-side upload with @rend-sdk/client when possible, or use the public API if the app cannot install the SDK.
2. Keep REND_API_KEY only on the server. Do not put it in browser code, mobile clients, logs, or NEXT_PUBLIC_* env vars.
3. Upload the source video, then wait for playable_state to become hls_ready before returning success.
4. Store asset_id in my app database so future requests can fetch playback without reuploading.
5. In browser UI, use ${siteOrigin}/embed/{assetId} for the hosted player, or call ${siteOrigin}/api/player/{assetId} from the site origin and render the returned source.
6. Prefer the hosted Rend player for HLS startup. For a bare video element, prefer manifest_url, then playback_url, then opener_url only for legacy assets and use the matching content type.
7. Handle billing_required, limit_exceeded, unauthorized, not_playable, suspended, deleted, and upload too large states with clear user-facing messages.
8. Add a smoke test or script that uploads a small fixture, waits for playback, prints an embed URL or HTML snippet, reads analytics if available, and deletes the test asset.`;
