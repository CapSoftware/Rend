import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeWatchBootstrapHeader,
  encodeWatchBootstrapHeader,
  safeWatchBootstrap,
  safeWatchBootstrapMs,
} from "./watch-bootstrap.ts";

const ASSET_ID = "00000000-0000-0000-0000-000000000001";

test("watch bootstrap header round-trips safe playback metadata", () => {
  const encoded = encodeWatchBootstrapHeader({
    status: "ready",
    asset_id: ASSET_ID,
    source_state: "uploaded",
    playable_state: "hls_ready",
    playback_url: `https://ash-1.play.rend.so/v/${ASSET_ID}/hls/master.m3u8`,
    playback_content_type: "application/vnd.apple.mpegurl",
    playback_credential_mode: "omit",
    playback_token_expires_at: 1_800_000_000,
    ttl_seconds: 900,
    opener_url: `https://ash-1.play.rend.so/v/${ASSET_ID}/opener.mp4`,
    opener_content_type: "video/mp4",
    manifest_url: `https://ash-1.play.rend.so/v/${ASSET_ID}/hls/master.m3u8`,
    manifest_content_type: "application/vnd.apple.mpegurl",
    poster_url: `https://ash-1.play.rend.so/v/${ASSET_ID}/thumbnail.jpg`,
    poster_content_type: "image/jpeg",
    prefetch_hints: [
      {
        artifact_path: "hls/1080p/index.m3u8",
        url: `https://ash-1.play.rend.so/v/${ASSET_ID}/hls/1080p/index.m3u8`,
        content_type: "application/vnd.apple.mpegurl",
      },
    ],
  });

  assert.ok(encoded);
  const decoded = decodeWatchBootstrapHeader(encoded);
  assert.equal(decoded?.status, "ready");
  assert.equal(decoded?.asset_id, ASSET_ID);
  assert.equal(decoded?.status === "ready" ? decoded.playback_credential_mode : "", "omit");
  assert.equal(decoded?.status === "ready" ? decoded.manifest_url : "", `https://ash-1.play.rend.so/v/${ASSET_ID}/hls/master.m3u8`);
  assert.equal(decoded?.status === "ready" ? decoded.poster_url : "", `https://ash-1.play.rend.so/v/${ASSET_ID}/thumbnail.jpg`);
});

test("watch bootstrap rejects token and credential material", () => {
  assert.equal(
    safeWatchBootstrap({
      status: "ready",
      asset_id: ASSET_ID,
      source_state: "uploaded",
      playable_state: "hls_ready",
      playback_url: `https://ash-1.play.rend.so/v/${ASSET_ID}/hls/master.m3u8?token=secret`,
      playback_token: "v1.claims.signature",
      playback_token_expires_at: 1_800_000_000,
      ttl_seconds: 900,
      prefetch_hints: [],
    }),
    null
  );

  assert.equal(
    encodeWatchBootstrapHeader({
      status: "ready",
      asset_id: ASSET_ID,
      source_state: "uploaded",
      playable_state: "hls_ready",
      playback_url: `https://user:pass@ash-1.play.rend.so/v/${ASSET_ID}/hls/master.m3u8`,
      playback_token_expires_at: 1_800_000_000,
      ttl_seconds: 900,
      prefetch_hints: [],
    }),
    null
  );
});

test("watch bootstrap timing accepts only bounded non-negative values", () => {
  assert.equal(safeWatchBootstrapMs("12.8"), 13);
  assert.equal(safeWatchBootstrapMs("-1"), undefined);
  assert.equal(safeWatchBootstrapMs("60000"), undefined);
  assert.equal(safeWatchBootstrapMs("not-a-number"), undefined);
});
