export const WATCH_BOOTSTRAP_HEADER = "x-rend-watch-bootstrap";
export const WATCH_BOOTSTRAP_MS_HEADER = "x-rend-watch-bootstrap-ms";

export type WatchPlaybackPrefetchHint = {
  artifact_path: string;
  url: string;
  content_type: string;
};

export type WatchPlaybackBootstrapReady = {
  status: "ready";
  asset_id: string;
  organization_id?: string;
  source_state: string;
  playable_state: "opener_ready" | "hls_ready" | string;
  playback_url?: string;
  playback_content_type?: string;
  playback_credential_mode?: "include" | "omit";
  playback_token_expires_at: number;
  ttl_seconds: number;
  opener_url?: string;
  opener_content_type?: string;
  manifest_url?: string;
  manifest_content_type?: string;
  poster_url?: string;
  poster_content_type?: string;
  prefetch_hints: WatchPlaybackPrefetchHint[];
};

export type WatchPlaybackBootstrapResponse =
  | WatchPlaybackBootstrapReady
  | {
      status: "not_playable";
      asset_id: string;
      source_state?: string;
      playable_state?: string;
      message: string;
    }
  | {
      status: "unavailable";
      asset_id: string;
      message: string;
    }
  | {
      status: "error";
      asset_id: string;
      message: string;
    };

const MAX_BOOTSTRAP_HEADER_BYTES = 12_000;
const MAX_PREFETCH_HINTS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeString(value: unknown, maxLength = 512) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function safeState(value: unknown) {
  const state = safeString(value, 96);
  return state && /^[a-z0-9_:-]+$/i.test(state) ? state : undefined;
}

function safeAssetId(value: unknown) {
  const assetId = safeString(value, 64)?.toLowerCase();
  return assetId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(assetId)
    ? assetId
    : undefined;
}

function safeUuid(value: unknown) {
  const id = safeString(value, 64)?.toLowerCase();
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ? id
    : undefined;
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function serializedBootstrapLooksSafe(value: unknown) {
  const serialized = JSON.stringify(value);
  return (
    serialized.length <= MAX_BOOTSTRAP_HEADER_BYTES &&
    !/"playback_token"\s*:/i.test(serialized) &&
    !/\b(set-cookie|authorization)\b/i.test(serialized) &&
    !/\bbearer\s+[a-z0-9._~+/=-]{12,}/i.test(serialized) &&
    !/[?&](?:token|signature|secret|api[_-]?key)=/i.test(serialized)
  );
}

function safePlaybackUrl(value: unknown) {
  const url = safeString(value, 4096);
  if (!url) return undefined;
  try {
    const parsed = new URL(url, "https://rend.local");
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    if (parsed.username || parsed.password || parsed.hash) return undefined;
    if (/[?&](?:token|signature|secret|api[_-]?key)=/i.test(parsed.search)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function safePrefetchHints(value: unknown): WatchPlaybackPrefetchHint[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PREFETCH_HINTS).flatMap((hint) => {
    if (!isRecord(hint)) return [];
    const artifactPath = safeString(hint.artifact_path, 128);
    const contentType = safeString(hint.content_type, 128);
    const url = safePlaybackUrl(hint.url);
    if (!artifactPath || !contentType || !url) return [];
    return [
      {
        artifact_path: artifactPath,
        content_type: contentType,
        url,
      },
    ];
  });
}

export function safeWatchBootstrap(value: unknown): WatchPlaybackBootstrapResponse | null {
  if (!isRecord(value) || !serializedBootstrapLooksSafe(value)) return null;

  const status = safeState(value.status);
  const assetId = safeAssetId(value.asset_id);
  if (!status || !assetId) return null;

  if (status === "ready") {
    const playbackTokenExpiresAt = safeNumber(value.playback_token_expires_at);
    const ttlSeconds = safeNumber(value.ttl_seconds);
    const playbackUrl = safePlaybackUrl(value.playback_url);
    const openerUrl = safePlaybackUrl(value.opener_url);
    const manifestUrl = safePlaybackUrl(value.manifest_url);
    const posterUrl = safePlaybackUrl(value.poster_url);

    if (!playbackTokenExpiresAt || !ttlSeconds || (!playbackUrl && !openerUrl && !manifestUrl)) {
      return null;
    }

    return {
      status,
      asset_id: assetId,
      organization_id: safeUuid(value.organization_id),
      source_state: safeState(value.source_state) ?? "unknown",
      playable_state: safeState(value.playable_state) ?? "unknown",
      playback_url: playbackUrl,
      playback_content_type: safeString(value.playback_content_type, 128),
      playback_credential_mode: value.playback_credential_mode === "omit" ? "omit" : "include",
      playback_token_expires_at: playbackTokenExpiresAt,
      ttl_seconds: ttlSeconds,
      opener_url: openerUrl,
      opener_content_type: safeString(value.opener_content_type, 128),
      manifest_url: manifestUrl,
      manifest_content_type: safeString(value.manifest_content_type, 128),
      poster_url: posterUrl,
      poster_content_type: safeString(value.poster_content_type, 128),
      prefetch_hints: safePrefetchHints(value.prefetch_hints),
    };
  }

  if (status === "not_playable") {
    return {
      status,
      asset_id: assetId,
      source_state: safeState(value.source_state),
      playable_state: safeState(value.playable_state),
      message: safeString(value.message, 512) ?? "Asset is not playable yet",
    };
  }

  if (status === "unavailable" || status === "error") {
    return {
      status,
      asset_id: assetId,
      message: safeString(value.message, 512) ?? "Playback is unavailable",
    };
  }

  return null;
}

export function encodeWatchBootstrapHeader(value: unknown) {
  const safe = safeWatchBootstrap(value);
  if (!safe) return null;
  return encodeURIComponent(JSON.stringify(safe));
}

export function decodeWatchBootstrapHeader(value: string | null) {
  if (!value) return null;
  try {
    return safeWatchBootstrap(JSON.parse(decodeURIComponent(value)));
  } catch {
    return null;
  }
}

export function safeWatchBootstrapMs(value: string | null) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 60_000 ? Math.round(parsed) : undefined;
}
