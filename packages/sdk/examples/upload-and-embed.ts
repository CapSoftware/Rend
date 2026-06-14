import { readFile } from "node:fs/promises";
import { RendClient } from "@rend/sdk";

const apiKey = process.env.REND_API_KEY;
if (!apiKey) throw new Error("Set REND_API_KEY");

const apiBaseUrl = process.env.REND_API_BASE_URL ?? "http://127.0.0.1:4000";
const siteBaseUrl = process.env.REND_SITE_BASE_URL ?? "http://127.0.0.1:3000";
const fixturePath = process.env.REND_FIXTURE_PATH ?? "fixtures/media/rend-fixture.mp4";

const client = new RendClient({
  apiKey,
  apiBaseUrl,
  siteBaseUrl,
});

const fixture = await readFile(fixturePath);
const uploaded = await client.uploadAsset(fixture, {
  contentType: "video/mp4",
  contentLength: fixture.byteLength,
});

const asset = await client.waitForPlayableAsset(uploaded.asset_id, {
  timeoutMs: 180_000,
  intervalMs: 1_000,
});

const bootstrap = await client.getPlaybackBootstrap(asset.asset_id);
const playbackPath = bootstrap.manifest_url ?? bootstrap.playback_url ?? bootstrap.opener_url;
const playbackType =
  bootstrap.manifest_content_type ??
  bootstrap.playback_content_type ??
  bootstrap.opener_content_type ??
  "video/mp4";

if (!playbackPath) throw new Error("Playback bootstrap did not return a playable URL");

const playbackUrl = new URL(playbackPath, siteBaseUrl).toString();
const embedHtml = `<video controls playsinline preload="metadata"><source src="${playbackUrl}" type="${playbackType}"></video>`;

console.log(JSON.stringify({ asset_id: asset.asset_id, playable_state: asset.playable_state }, null, 2));
console.log(embedHtml);

await client.deleteAsset(asset.asset_id);
