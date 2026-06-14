export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type UpstreamPlaybackResponse = {
  asset_id?: unknown;
  source_state?: unknown;
  playable_state?: unknown;
  playback_url?: unknown;
  playback_content_type?: unknown;
  playback_token_expires_at?: unknown;
  ttl_seconds?: unknown;
  opener_url?: unknown;
  opener_content_type?: unknown;
  manifest_url?: unknown;
  manifest_content_type?: unknown;
  prefetch_hints?: unknown;
};

type UpstreamAssetResponse = {
  asset_id?: unknown;
  source_state?: unknown;
  playable_state?: unknown;
};

const DEFAULT_API_BASE_URL = "http://127.0.0.1:4000";
const MAX_PREFETCH_HINTS = 4;

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function controlPlaneUrl(path: string) {
  const baseUrl = envString("REND_API_BASE_URL", DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  return `${baseUrl}${path}`;
}

function safeString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeSignedUrl(value: unknown, playbackBaseUrl: string | null) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
  if (parsed.username || parsed.password) return undefined;

  if (!playbackBaseUrl) return parsed.toString();
  return rewriteSignedPlaybackUrl(parsed, playbackBaseUrl);
}

function normalizePlaybackBaseUrl(value: string) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("playback base URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("playback base URL must not include credentials, query, or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function rewriteSignedPlaybackUrl(signedUrl: URL, playbackBaseUrl: string) {
  const base = new URL(playbackBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}${signedUrl.pathname}`;
  base.search = signedUrl.search;
  base.hash = "";
  return base.toString();
}

function allowedPlaybackBaseUrls() {
  return envString("REND_PLAYER_ALLOWED_PLAYBACK_BASE_URLS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizePlaybackBaseUrl);
}

function playbackBaseOverride(request: Request) {
  const requestUrl = new URL(request.url);
  const requested = requestUrl.searchParams.get("playbackBaseUrl");
  if (requested) {
    const normalized = normalizePlaybackBaseUrl(requested);
    if (!allowedPlaybackBaseUrls().includes(normalized)) {
      throw new Error("playbackBaseUrl is not allowed");
    }
    return normalized;
  }

  const configured = envString("REND_PLAYER_PLAYBACK_BASE_URL");
  return configured ? normalizePlaybackBaseUrl(configured) : null;
}

function safePlaybackResponse(
  assetId: string,
  data: UpstreamPlaybackResponse,
  playbackBaseUrl: string | null
) {
  const playbackUrl = safeSignedUrl(data.playback_url, playbackBaseUrl);
  const openerUrl = safeSignedUrl(data.opener_url, playbackBaseUrl);
  const manifestUrl = safeSignedUrl(data.manifest_url, playbackBaseUrl);
  const expiresAt = safeNumber(data.playback_token_expires_at);
  const ttlSeconds = safeNumber(data.ttl_seconds);

  if (!expiresAt || !ttlSeconds || (!playbackUrl && !openerUrl && !manifestUrl)) {
    return null;
  }

  const hints = Array.isArray(data.prefetch_hints)
    ? data.prefetch_hints.slice(0, MAX_PREFETCH_HINTS).flatMap((hint) => {
        if (!hint || typeof hint !== "object") return [];
        const record = hint as Record<string, unknown>;
        const artifactPath = safeString(record.artifact_path);
        const url = safeSignedUrl(record.url, playbackBaseUrl);
        const contentType = safeString(record.content_type);
        if (!artifactPath || !url || !contentType) return [];
        return [
          {
            artifact_path: artifactPath,
            url,
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

async function fetchControlPlane(path: string, apiKey: string) {
  return fetch(controlPlaneUrl(path), {
    cache: "no-store",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  });
}

async function notPlayableOrUnavailable(assetId: string, apiKey: string) {
  const assetResponse = await fetchControlPlane(
    `/v1/assets/${encodeURIComponent(assetId)}`,
    apiKey
  ).catch(() => null);

  if (!assetResponse?.ok) {
    return jsonResponse(
      {
        status: "unavailable",
        asset_id: assetId,
        message: "Asset is unavailable",
      },
      { status: 404 }
    );
  }

  const asset = (await assetResponse.json().catch(() => ({}))) as UpstreamAssetResponse;
  return jsonResponse(
    {
      status: "not_playable",
      asset_id: safeString(asset.asset_id) ?? assetId,
      source_state: safeString(asset.source_state),
      playable_state: safeString(asset.playable_state),
      message: "Asset is not playable yet",
    },
    { status: 409 }
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await context.params;
  if (!assetId || assetId.length > 160) {
    return jsonResponse(
      {
        status: "unavailable",
        asset_id: assetId || "",
        message: "Asset is unavailable",
      },
      { status: 404 }
    );
  }

  const apiKey = envString("REND_DEV_API_KEY");
  if (!apiKey) {
    return jsonResponse(
      {
        status: "error",
        asset_id: assetId,
        message: "Playback is not configured",
      },
      { status: 500 }
    );
  }

  let playbackBaseUrl: string | null;
  try {
    playbackBaseUrl = playbackBaseOverride(request);
  } catch {
    return jsonResponse(
      {
        status: "error",
        asset_id: assetId,
        message: "Playback edge is not configured",
      },
      { status: 400 }
    );
  }

  const upstream = await fetchControlPlane(
    `/v1/assets/${encodeURIComponent(assetId)}/playback`,
    apiKey
  ).catch(() => null);

  if (!upstream) {
    return jsonResponse(
      {
        status: "error",
        asset_id: assetId,
        message: "Playback bootstrap failed",
      },
      { status: 502 }
    );
  }

  if (upstream.status === 404) {
    return notPlayableOrUnavailable(assetId, apiKey);
  }

  if (!upstream.ok) {
    return jsonResponse(
      {
        status: "error",
        asset_id: assetId,
        message: "Playback bootstrap failed",
      },
      { status: 502 }
    );
  }

  const data = (await upstream.json().catch(() => null)) as UpstreamPlaybackResponse | null;
  const safeResponse = data ? safePlaybackResponse(assetId, data, playbackBaseUrl) : null;

  if (!safeResponse) {
    return jsonResponse(
      {
        status: "error",
        asset_id: assetId,
        message: "Playback bootstrap failed",
      },
      { status: 502 }
    );
  }

  return jsonResponse(safeResponse);
}
