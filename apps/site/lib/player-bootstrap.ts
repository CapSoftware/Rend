export type UpstreamPlaybackResponse = {
  asset_id?: unknown;
  source_state?: unknown;
  playable_state?: unknown;
  playback_url?: unknown;
  playback_content_type?: unknown;
  playback_token_expires_at?: unknown;
  playback_token?: unknown;
  ttl_seconds?: unknown;
  opener_url?: unknown;
  opener_content_type?: unknown;
  manifest_url?: unknown;
  manifest_content_type?: unknown;
  prefetch_hints?: unknown;
};

const MAX_PREFETCH_HINTS = 4;
const HLS_RENDITION_NAMES = new Set(["720p", "1080p", "2k", "4k"]);

function safeString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeArtifactPath(value: string | undefined) {
  if (!value || value.includes("\\") || value.includes("..")) return undefined;
  if (value === "opener.mp4" || value === "hls/master.m3u8") return value;
  const parts = value.split("/");
  if (parts.length === 2 && parts[0] === "hls" && /^segment_[0-9]+\.ts$/.test(parts[1] ?? "")) {
    return value;
  }
  if (parts.length === 3 && parts[0] === "hls" && HLS_RENDITION_NAMES.has(parts[1] ?? "")) {
    if (parts[2] === "index.m3u8" || /^segment_[0-9]+\.ts$/.test(parts[2] ?? "")) return value;
  }
  return undefined;
}

function artifactPathFromPlaybackUrl(value: unknown, assetId: string) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
  if (parsed.username || parsed.password) return undefined;
  const prefix = `/v/${assetId}/`;
  if (!parsed.pathname.startsWith(prefix)) return undefined;
  const artifactPath = parsed.pathname.slice(prefix.length);
  return safeArtifactPath(artifactPath);
}

function encodeArtifactPath(artifactPath: string) {
  return artifactPath.split("/").map(encodeURIComponent).join("/");
}

function proxiedArtifactUrl(assetId: string, artifactPath: string, playbackBaseUrl: string | null) {
  const path = `/api/player/${encodeURIComponent(assetId)}/artifact/${encodeArtifactPath(artifactPath)}`;
  return playbackBaseUrl ? `${path}?playbackBaseUrl=${encodeURIComponent(playbackBaseUrl)}` : path;
}

export function safePlaybackBootstrapResponse(
  assetId: string,
  data: UpstreamPlaybackResponse,
  playbackBaseUrl: string | null
) {
  const playbackPath = artifactPathFromPlaybackUrl(data.playback_url, assetId);
  const openerPath = artifactPathFromPlaybackUrl(data.opener_url, assetId);
  const manifestPath = artifactPathFromPlaybackUrl(data.manifest_url, assetId);
  const playbackUrl = playbackPath ? proxiedArtifactUrl(assetId, playbackPath, playbackBaseUrl) : undefined;
  const openerUrl = openerPath ? proxiedArtifactUrl(assetId, openerPath, playbackBaseUrl) : undefined;
  const manifestUrl = manifestPath ? proxiedArtifactUrl(assetId, manifestPath, playbackBaseUrl) : undefined;
  const expiresAt = safeNumber(data.playback_token_expires_at);
  const ttlSeconds = safeNumber(data.ttl_seconds);

  if (!expiresAt || !ttlSeconds || (!playbackUrl && !openerUrl && !manifestUrl)) {
    return null;
  }

  const hints = Array.isArray(data.prefetch_hints)
    ? data.prefetch_hints.slice(0, MAX_PREFETCH_HINTS).flatMap((hint) => {
        if (!hint || typeof hint !== "object") return [];
        const record = hint as Record<string, unknown>;
        const artifactPath = safeArtifactPath(safeString(record.artifact_path));
        const contentType = safeString(record.content_type);
        if (!artifactPath || !contentType) return [];
        return [
          {
            artifact_path: artifactPath,
            url: proxiedArtifactUrl(assetId, artifactPath, playbackBaseUrl),
            content_type: contentType,
          },
        ];
      })
    : [];

  return {
    status: "ready",
    asset_id: safeString(data.asset_id) ?? assetId,
    source_state: safeString(data.source_state) ?? "unknown",
    playable_state: safeString(data.playable_state) ?? "unknown",
    playback_url: playbackUrl,
    playback_content_type: safeString(data.playback_content_type),
    playback_token_expires_at: expiresAt,
    ttl_seconds: ttlSeconds,
    opener_url: openerUrl,
    opener_content_type: safeString(data.opener_content_type),
    manifest_url: manifestUrl,
    manifest_content_type: safeString(data.manifest_content_type),
    prefetch_hints: hints,
  };
}
