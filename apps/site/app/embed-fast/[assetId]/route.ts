export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import {
  safeWatchBootstrap,
  type WatchPlaybackBootstrapReady,
  type WatchPlaybackBootstrapResponse,
} from "../../../lib/watch-bootstrap.ts";

type FastEmbedRenderOptions = {
  assetId: string;
  autoPlay: boolean;
  bootstrap: WatchPlaybackBootstrapResponse | null;
  bootstrapHttpStatus?: number;
  bootstrapUrl: string;
  bootstrapMs?: number;
  controls: boolean;
  inlineStartup?: FastEmbedInlineStartup | null;
  muted: boolean;
  playbackOriginHint?: { dnsPrefetch: string; origin: string } | null;
  startupMode: "hls" | "opener" | "progressive";
};

type FastEmbedInlineStartup = {
  artifactPath: string;
  mimeType: string;
  startupB64: string;
  segmentUrls: string[];
};

const GEO_HEADER_NAMES = [
  "x-vercel-id",
  "x-vercel-ip-country",
  "x-vercel-ip-country-region",
  "x-vercel-ip-continent",
  "x-vercel-ip-latitude",
  "x-vercel-ip-longitude",
];
const FORWARDED_CONTEXT_HEADER_NAMES = [
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
];
const BOOTSTRAP_TIMEOUT_MS = 1500;
const INLINE_STARTUP_TIMEOUT_MS = 900;
const INLINE_STARTUP_MAX_BYTES = 512 * 1024;
const PLAYBACK_COOKIE_NAME = "__rend_playback";
const CLOUDFRONT_COOKIE_NAMES = [
  "CloudFront-Policy",
  "CloudFront-Signature",
  "CloudFront-Key-Pair-Id",
] as const;

function normalizeAssetId(value: string) {
  const assetId = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    assetId,
  )
    ? assetId
    : null;
}

function firstQueryValue(value: string | null) {
  return value && value.trim() ? value.trim() : null;
}

function flag(value: string | null, fallback: boolean) {
  if (value === null) return fallback;
  return value === "" || value === "1" || value === "true";
}

function startupMode(value: string | null) {
  if (value === "opener") return "opener";
  if (value === "hls" || value === "native") return "hls";
  return "progressive";
}

function bootstrapMode(value: string | null) {
  return value === "client" ? "client" : "server";
}

function bootstrapUrlForRequest(request: Request, assetId: string) {
  const requestUrl = new URL(request.url);
  const bootstrapUrl = new URL(
    `/api/player/${encodeURIComponent(assetId)}`,
    requestUrl.origin,
  );
  const playbackBaseUrl = firstQueryValue(
    requestUrl.searchParams.get("playbackBaseUrl"),
  );
  if (playbackBaseUrl) {
    bootstrapUrl.searchParams.set("playbackBaseUrl", playbackBaseUrl);
  }
  return bootstrapUrl;
}

function clientBootstrapUrlForRequest(request: Request, assetId: string) {
  const bootstrapUrl = bootstrapUrlForRequest(request, assetId);
  return `${bootstrapUrl.pathname}${bootstrapUrl.search}`;
}

function forwardedBootstrapHeaders(request: Request) {
  const headers = new Headers({
    accept: "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
  });

  for (const name of GEO_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const name of FORWARDED_CONTEXT_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  return headers;
}

function setCookieHeaders(headers: Headers) {
  const values = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie?.();
  if (values?.length) return values;

  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function safeCookieValue(value: string | undefined) {
  if (!value || value.length > 4096) return undefined;
  return /^[a-zA-Z0-9._~-]+$/.test(value) ? value : undefined;
}

function playbackAuthorizationCookieHeader(headers: Headers) {
  const allowedNames = [PLAYBACK_COOKIE_NAME, ...CLOUDFRONT_COOKIE_NAMES];
  const cookies = new Map<string, string>();
  for (const header of setCookieHeaders(headers)) {
    for (const name of allowedNames) {
      const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;,\\s]+)`));
      const value = safeCookieValue(match?.[1]);
      if (value) cookies.set(name, value);
    }
  }
  const playbackCookie = cookies.get(PLAYBACK_COOKIE_NAME);
  if (!playbackCookie) return undefined;
  const cloudFrontCount = CLOUDFRONT_COOKIE_NAMES.filter((name) => cookies.has(name)).length;
  if (cloudFrontCount !== 0 && cloudFrontCount !== CLOUDFRONT_COOKIE_NAMES.length) {
    return undefined;
  }
  return allowedNames
    .flatMap((name) => {
      const value = cookies.get(name);
      return value ? [`${name}=${value}`] : [];
    })
    .join("; ");
}

function html(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function linkHeaderValue(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function jsString(value: string) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function scriptJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function playbackSelection(
  bootstrap: WatchPlaybackBootstrapResponse | null,
  mode: "hls" | "opener" | "progressive",
) {
  if (bootstrap?.status !== "ready") return null;

  if (mode === "opener" && bootstrap.opener_url) {
    return {
      artifactPath: "opener.mp4",
      contentType: bootstrap.opener_content_type ?? "video/mp4",
      label: "opener",
      url: bootstrap.opener_url,
    };
  }

  if (mode === "progressive") {
    const progressiveUrl = progressivePlaybackUrl(bootstrap);
    if (progressiveUrl) {
      return {
        artifactPath: progressiveUrl.artifactPath,
        contentType: "video/mp4",
        label: "progressive_mp4",
        url: progressiveUrl.url,
      };
    }
  }

  if (bootstrap.playable_state === "hls_ready" && bootstrap.manifest_url) {
    return {
      artifactPath: "hls/master.m3u8",
      contentType:
        bootstrap.manifest_content_type ?? "application/vnd.apple.mpegurl",
      label: "native_hls",
      url: bootstrap.manifest_url,
    };
  }

  if (bootstrap.opener_url) {
    return {
      artifactPath: "opener.mp4",
      contentType: bootstrap.opener_content_type ?? "video/mp4",
      label: "opener",
      url: bootstrap.opener_url,
    };
  }

  if (bootstrap.playback_url) {
    return {
      artifactPath:
        bootstrap.playable_state === "hls_ready"
          ? "hls/master.m3u8"
          : "opener.mp4",
      contentType: bootstrap.playback_content_type,
      label: "primary",
      url: bootstrap.playback_url,
    };
  }

  return null;
}

function playbackCrossOrigin(bootstrap: WatchPlaybackBootstrapResponse | null) {
  return bootstrap?.status === "ready" && bootstrap.playback_credential_mode === "omit"
    ? "anonymous"
    : undefined;
}

function progressivePlaybackUrl(bootstrap: WatchPlaybackBootstrapReady) {
  if (bootstrap.playable_state !== "hls_ready" || !bootstrap.manifest_url) {
    return null;
  }
  const rendition = progressiveStartupRendition(bootstrap);
  if (!rendition) return null;

  try {
    const parsed = new URL(bootstrap.manifest_url);
    const prefix = `/v/${bootstrap.asset_id}/`;
    if (!parsed.pathname.startsWith(prefix)) return null;
    const artifactPath = `hls/${rendition}/progressive.mp4`;
    parsed.pathname = `${prefix}${artifactPath}`;
    parsed.search = "";
    parsed.hash = "";
    return { artifactPath, url: parsed.toString() };
  } catch {
    return null;
  }
}

function nativeFallbackSelection(
  bootstrap: WatchPlaybackBootstrapResponse | null,
  selection: ReturnType<typeof playbackSelection>,
  inlineStartup: FastEmbedInlineStartup | null | undefined,
) {
  if (inlineStartup || selection?.label !== "progressive_mp4") {
    return selection;
  }

  return playbackSelection(bootstrap, "opener") ?? selection;
}

function progressiveStartupRendition(bootstrap: WatchPlaybackBootstrapReady) {
  const byRendition = new Map<string, { init: boolean; segment: boolean }>();
  for (const hint of bootstrap.prefetch_hints) {
    const match = /^hls\/([^/]+)\/([^/]+)$/.exec(hint.artifact_path);
    if (!match) continue;
    const [, rendition, name] = match;
    const state = byRendition.get(rendition) ?? { init: false, segment: false };
    state.init ||= name === `init_${rendition}.mp4`;
    state.segment ||= name === "segment_00000.m4s";
    byRendition.set(rendition, state);
  }
  for (const rendition of ["360p", "480p", "720p", "1080p", "2k", "4k"]) {
    const state = byRendition.get(rendition);
    if (state?.init && state.segment) return rendition;
  }
  return null;
}

function playbackHint(
  bootstrap: WatchPlaybackBootstrapReady,
  artifactPath: string,
) {
  return bootstrap.prefetch_hints.find(
    (hint) => hint.artifact_path === artifactPath,
  );
}

function playlistUrlForRendition(
  bootstrap: WatchPlaybackBootstrapReady,
  rendition: string,
) {
  const hint = playbackHint(bootstrap, `hls/${rendition}/index.m3u8`);
  if (hint?.url) return hint.url;
  if (!bootstrap.manifest_url) return null;
  try {
    const parsed = new URL(bootstrap.manifest_url);
    parsed.pathname = `/v/${bootstrap.asset_id}/hls/${rendition}/index.m3u8`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function segmentNamesFromPlaylist(playlist: string) {
  return playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || line.startsWith("#")) return false;
      if (line.includes("/") || line.includes("\\") || line.includes("..")) {
        return false;
      }
      return /^segment_[0-9]+\.m4s$/.test(line);
    });
}

function codecsForRendition(master: string, rendition: string) {
  const renditionPath = `${rendition}/index.m3u8`;
  let pendingCodecs: string | null = null;
  for (const line of master.split(/\r?\n/).map((value) => value.trim())) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingCodecs = line.match(/(?:^|,)CODECS="([^"]+)"/)?.[1] ?? null;
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    if (line === renditionPath || line.endsWith(`/${renditionPath}`)) {
      return pendingCodecs;
    }
    pendingCodecs = null;
  }
  return null;
}

function absoluteSegmentUrls(playlistUrl: string, segmentNames: string[]) {
  return segmentNames.flatMap((segment) => {
    try {
      return [new URL(segment, playlistUrl).toString()];
    } catch {
      return [];
    }
  });
}

async function fetchText(url: string, cookieHeader: string | undefined) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/vnd.apple.mpegurl,text/plain,*/*",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    signal: AbortSignal.timeout(INLINE_STARTUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("startup playlist fetch failed");
  return response.text();
}

async function fetchBytes(url: string, cookieHeader: string | undefined) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "video/mp4,*/*",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    signal: AbortSignal.timeout(INLINE_STARTUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("startup media fetch failed");
  return new Uint8Array(await response.arrayBuffer());
}

async function inlineStartupForSelection(
  bootstrap: WatchPlaybackBootstrapResponse | null,
  selection: ReturnType<typeof playbackSelection>,
  bootstrapResponse: Response | null,
) {
  if (
    bootstrap?.status !== "ready" ||
    !selection ||
    selection.label !== "progressive_mp4" ||
    bootstrap.playback_credential_mode !== "omit"
  ) {
    return null;
  }
  const rendition = progressiveStartupRendition(bootstrap);
  if (!rendition || !bootstrap.manifest_url) return null;

  const playlistUrl = playlistUrlForRendition(bootstrap, rendition);
  const initUrl = playbackHint(bootstrap, `hls/${rendition}/init_${rendition}.mp4`)?.url;
  const firstSegmentUrl = playbackHint(bootstrap, `hls/${rendition}/segment_00000.m4s`)?.url;
  const cookieHeader = bootstrapResponse
    ? playbackAuthorizationCookieHeader(bootstrapResponse.headers)
    : undefined;
  if (!playlistUrl || !initUrl || !firstSegmentUrl || !cookieHeader) return null;

  try {
    const [master, playlist, initBytes, firstSegmentBytes] = await Promise.all([
      fetchText(bootstrap.manifest_url, cookieHeader),
      fetchText(playlistUrl, cookieHeader),
      fetchBytes(initUrl, cookieHeader),
      fetchBytes(firstSegmentUrl, cookieHeader),
    ]);
    const startupBytes = initBytes.byteLength + firstSegmentBytes.byteLength;
    if (startupBytes <= 0 || startupBytes > INLINE_STARTUP_MAX_BYTES) {
      return null;
    }
    const startup = new Uint8Array(startupBytes);
    startup.set(initBytes, 0);
    startup.set(firstSegmentBytes, initBytes.byteLength);
    const segmentUrls = absoluteSegmentUrls(
      playlistUrl,
      segmentNamesFromPlaylist(playlist).slice(1),
    );
    const codecs = codecsForRendition(master, rendition);

    return {
      artifactPath: `hls/${rendition}/init_${rendition}.mp4+hls/${rendition}/segment_00000.m4s`,
      mimeType: codecs ? `video/mp4; codecs="${codecs}"` : "video/mp4",
      startupB64: Buffer.from(startup).toString("base64"),
      segmentUrls,
    } satisfies FastEmbedInlineStartup;
  } catch {
    return null;
  }
}

function playbackOrigin(bootstrap: WatchPlaybackBootstrapReady | null) {
  const url =
    bootstrap?.manifest_url ?? bootstrap?.playback_url ?? bootstrap?.opener_url;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return { dnsPrefetch: `//${parsed.host}`, origin: parsed.origin };
  } catch {
    return null;
  }
}

function defaultPlaybackOriginHint() {
  return { dnsPrefetch: "//api.rend.so", origin: "https://api.rend.so" };
}

function preloadablePlaybackSelection(
  selection: ReturnType<typeof playbackSelection>,
) {
  if (!selection?.url || selection.contentType !== "video/mp4") return null;
  return selection;
}

function appendStartupLinkHeaders(
  headers: Headers,
  edge: ReturnType<typeof playbackOrigin>,
  selection: ReturnType<typeof playbackSelection>,
  inlineStartup: FastEmbedInlineStartup | null | undefined,
  crossOrigin: "anonymous" | undefined,
) {
  if (edge) {
    headers.append(
      "link",
      `<${linkHeaderValue(edge.origin)}>; rel=preconnect; crossorigin`,
    );
  }

  if (inlineStartup) {
    const nextSegment = inlineStartup.segmentUrls[0];
    if (nextSegment) {
      headers.append(
        "link",
        `<${linkHeaderValue(nextSegment)}>; rel=preload; as=fetch; type="video/mp4"${crossOrigin ? `; crossorigin="${crossOrigin}"` : ""}; fetchpriority=high`,
      );
    }
    return;
  }

  const preload = preloadablePlaybackSelection(selection);
  if (!preload) return;
  const preloadContentType = preload.contentType ?? "video/mp4";
  headers.append(
    "link",
    `<${linkHeaderValue(preload.url)}>; rel=preload; as=video; type="${linkHeaderValue(preloadContentType)}"${crossOrigin ? `; crossorigin="${crossOrigin}"` : ""}; fetchpriority=high`,
  );
}

function playerMessage(
  bootstrap: WatchPlaybackBootstrapResponse | null,
  selection: ReturnType<typeof playbackSelection>,
) {
  if (!bootstrap) return "Loading playback";
  if (bootstrap.status !== "ready") return bootstrap.message;
  return selection ? "Ready" : "Not playable yet";
}

const FAST_EMBED_TELEMETRY_SCRIPT = String.raw`
(() => {
  const root = document.querySelector("[data-rend-player-state]");
  const video = document.querySelector("video");
  if (!root || !video) return;

  const telemetryUrl = "/api/player/telemetry";
  const randomId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 14);
  };
  const playbackSessionId = randomId();
  root.setAttribute("data-rend-playback-session-id", playbackSessionId);

  const numberAttribute = (name) => {
    const rawValue = root.getAttribute(name);
    if (rawValue === null || rawValue.trim() === "") return undefined;
    const value = Number(rawValue);
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  };
  const selectedFields = () => {
    const rawMode = root.getAttribute("data-rend-player-selected") || "";
    const allowedModes = ["native_hls", "hls_js", "opener", "primary"];
    const selectedMode = allowedModes.includes(rawMode)
      ? rawMode
      : rawMode
        ? "primary"
        : undefined;
    const rawArtifact = root.getAttribute("data-rend-player-artifact") || "";
    const selectedArtifact = rawArtifact.includes("+")
      ? rawArtifact.split("+").at(-1)
      : rawArtifact || undefined;
    return {
      selected_playback_mode: selectedMode,
      selected_artifact_path: selectedArtifact,
      selected_width: numberAttribute("data-rend-selected-width"),
      selected_height: numberAttribute("data-rend-selected-height"),
    };
  };
  const safeReferrerHost = () => {
    if (!document.referrer) return undefined;
    try {
      return new URL(document.referrer).host;
    } catch {
      return undefined;
    }
  };
  const browserContext = async () => {
    const userAgent = navigator.userAgent || "";
    const browserMatch = userAgent.match(/Edg\/([0-9.]+)/)
      || userAgent.match(/Chrome\/([0-9.]+)/)
      || userAgent.match(/Firefox\/([0-9.]+)/)
      || userAgent.match(/Version\/([0-9.]+).*Safari/);
    const browserName = /Edg\//.test(userAgent)
      ? "Edge"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Firefox\//.test(userAgent)
          ? "Firefox"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "unknown";
    const osName = /Windows NT/.test(userAgent)
      ? "Windows"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad|iPod/.test(userAgent)
          ? "iOS"
          : /Mac OS X/.test(userAgent)
            ? "macOS"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "unknown";
    const deviceType = /iPad|Tablet|Android(?!.*Mobile)/i.test(userAgent)
      ? "tablet"
      : /Mobi|iPhone|Android/i.test(userAgent)
        ? "mobile"
        : /TV|SmartTV|AppleTV/i.test(userAgent)
          ? "tv"
          : "desktop";
    let viewerId = playbackSessionId;
    try {
      const key = "rend:viewer-id:v1";
      viewerId = localStorage.getItem(key) || randomId();
      localStorage.setItem(key, viewerId);
    } catch {}
    let viewerHash;
    try {
      if (globalThis.crypto?.subtle) {
        const digest = await globalThis.crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(viewerId),
        );
        viewerHash = "sha256:" + Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      }
    } catch {}
    return {
      viewer_id_hash: viewerHash,
      page_host: location.host,
      referrer_host: safeReferrerHost(),
      browser_name: browserName,
      browser_version: browserMatch?.[1],
      os_name: osName,
      device_type: deviceType,
    };
  };

  let resolvedContext = {};
  void browserContext().then((context) => {
    resolvedContext = context;
  }).catch(() => {});
  let queue = [];
  let flushTimer;
  const flush = (preferBeacon = false) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (queue.length === 0) return;
    const events = queue.splice(0, 16).map((event) => ({ ...resolvedContext, ...event }));
    const body = JSON.stringify({ events });
    try {
      if (preferBeacon && navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(telemetryUrl, blob)) return;
      }
      void fetch(telemetryUrl, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body,
      }).catch(() => {});
    } catch {}
    if (queue.length > 0 && !flushTimer) {
      flushTimer = setTimeout(() => flush(), 0);
    }
  };
  const send = (phase, fields = {}) => {
    queue.push({
      event_id: "evt-" + randomId(),
      organization_id: root.getAttribute("data-rend-organization-id") || undefined,
      playback_session_id: playbackSessionId,
      asset_id: root.getAttribute("data-rend-asset-id") || "",
      page_type: "embed",
      player_name: "rend-fast",
      phase,
      event_time_ms: Date.now(),
      player_version: "0.1.0",
      autoplay: root.getAttribute("data-rend-autoplay") === "true",
      muted: video.muted,
      preload: video.preload,
      startup_mode: root.getAttribute("data-rend-startup-mode") || undefined,
      ...fields,
    });
    if (!flushTimer) flushTimer = setTimeout(() => flush(), 250);
  };

  let bootstrapSent = false;
  let sourceKey = "";
  let metadataSent = false;
  let canplaySent = false;
  let firstFrameSent = false;
  let bootstrapFailureSent = false;
  let failureSent = false;
  let endedSent = false;
  let stallStartedAt = null;
  let lastWatchPositionMs = null;

  const emitBootstrap = () => {
    if (bootstrapSent || root.getAttribute("data-rend-ready-status") !== "ready") return;
    const duration = numberAttribute("data-rend-bootstrap-ms");
    if (duration === undefined) return;
    bootstrapSent = true;
    send("bootstrap_complete", {
      bootstrap_start_ms: 0,
      bootstrap_end_ms: duration,
      bootstrap_duration_ms: duration,
      bootstrap_http_status: numberAttribute("data-rend-bootstrap-status") || 200,
    });
  };
  const emitSource = () => {
    const fields = selectedFields();
    if (!fields.selected_playback_mode || !fields.selected_artifact_path) return;
    const key = fields.selected_playback_mode + ":" + fields.selected_artifact_path;
    if (sourceKey === key) return;
    sourceKey = key;
    send("source_selected", fields);
  };
  const emitMetadata = () => {
    if (metadataSent) return;
    const duration = numberAttribute("data-rend-metadata-ms");
    if (duration === undefined && video.readyState < 1) return;
    metadataSent = true;
    send("metadata_loaded", {
      metadata_loaded_ms: duration ?? Math.max(0, Math.round(performance.now())),
      ...selectedFields(),
    });
  };
  const emitCanplay = () => {
    if (canplaySent) return;
    const duration = numberAttribute("data-rend-canplay-ms");
    if (duration === undefined && video.readyState < 3) return;
    canplaySent = true;
    send("canplay", {
      canplay_ms: duration ?? Math.max(0, Math.round(performance.now())),
      ...selectedFields(),
    });
  };
  const emitFirstFrame = () => {
    if (firstFrameSent) return;
    const duration = numberAttribute("data-rend-first-frame-ms");
    if (duration === undefined) return;
    firstFrameSent = true;
    lastWatchPositionMs = Math.max(0, Math.round(video.currentTime * 1000));
    send("first_frame", { first_frame_ms: duration, ...selectedFields() });
  };
  const emitWatchHeartbeat = (force = false) => {
    if (!firstFrameSent || (!force && (video.paused || video.ended))) return;
    const currentPositionMs = Math.max(0, Math.round(video.currentTime * 1000));
    if (lastWatchPositionMs === null) {
      lastWatchPositionMs = currentPositionMs;
      return;
    }
    const deltaMs = Math.max(0, currentPositionMs - lastWatchPositionMs);
    lastWatchPositionMs = currentPositionMs;
    if (deltaMs < (force ? 1000 : 250)) return;
    send("watch_heartbeat", { watch_delta_ms: deltaMs, ...selectedFields() });
  };
  const emitFailure = (code, reason) => {
    if (failureSent) return;
    failureSent = true;
    send("playback_failure", {
      playback_failure_code: code,
      playback_failure_reason: reason,
      ...selectedFields(),
    });
  };
  const emitCurrentState = () => {
    emitBootstrap();
    emitSource();
    emitMetadata();
    emitCanplay();
    emitFirstFrame();
    if (root.getAttribute("data-rend-player-state") === "playback_failure") {
      if (!bootstrapSent && !bootstrapFailureSent) {
        bootstrapFailureSent = true;
        send("bootstrap_failure", {
          playback_failure_code: "fast_embed_bootstrap_failure",
          playback_failure_reason: "Playback bootstrap failed",
        });
      }
      emitFailure("fast_embed_playback_failure", "Playback could not start");
    }
  };

  send("player_load");
  const observer = new MutationObserver(emitCurrentState);
  observer.observe(root, { attributes: true });
  video.addEventListener("loadedmetadata", emitMetadata);
  video.addEventListener("canplay", emitCanplay);
  video.addEventListener("playing", () => {
    emitCurrentState();
    if (stallStartedAt !== null) {
      const stallEnd = Math.max(0, Math.round(performance.now()));
      send("stall_end", {
        stall_start_ms: stallStartedAt,
        stall_end_ms: stallEnd,
        stall_duration_ms: Math.max(0, stallEnd - stallStartedAt),
        ...selectedFields(),
      });
      stallStartedAt = null;
    }
  });
  video.addEventListener("waiting", () => {
    if (!firstFrameSent || video.paused || stallStartedAt !== null) return;
    stallStartedAt = Math.max(0, Math.round(performance.now()));
    send("stall_start", { stall_start_ms: stallStartedAt, ...selectedFields() });
  });
  video.addEventListener("pause", () => emitWatchHeartbeat(true));
  video.addEventListener("error", () => {
    const code = video.error?.code ? "media_error_" + video.error.code : "media_error";
    emitFailure(code, "The browser reported a media playback error");
  });
  video.addEventListener("ended", () => {
    emitWatchHeartbeat(true);
    if (!endedSent) {
      endedSent = true;
      send("playback_ended", selectedFields());
    }
  });
  if ("requestVideoFrameCallback" in video) {
    video.requestVideoFrameCallback(() => {
      if (!root.getAttribute("data-rend-first-frame-ms")) {
        root.setAttribute("data-rend-first-frame-ms", String(Math.round(performance.now())));
      }
      emitFirstFrame();
    });
  } else {
    video.addEventListener("playing", () => {
      if (!root.getAttribute("data-rend-first-frame-ms")) {
        root.setAttribute("data-rend-first-frame-ms", String(Math.round(performance.now())));
      }
      emitFirstFrame();
    }, { once: true });
  }
  const heartbeatTimer = setInterval(() => emitWatchHeartbeat(), 10000);
  const flushOnExit = () => {
    emitWatchHeartbeat(true);
    flush(true);
  };
  window.addEventListener("pagehide", flushOnExit, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnExit();
  });
  window.addEventListener("unload", () => {
    clearInterval(heartbeatTimer);
    observer.disconnect();
  }, { once: true });
  emitCurrentState();
})();`;

export function renderFastEmbedHtml(options: FastEmbedRenderOptions) {
  const ready = options.bootstrap?.status === "ready" ? options.bootstrap : null;
  const preferredSelection = playbackSelection(
    options.bootstrap,
    options.startupMode,
  );
  const inlineStartup = options.inlineStartup ?? null;
  const selection = nativeFallbackSelection(
    options.bootstrap,
    preferredSelection,
    inlineStartup,
  );
  const edge = playbackOrigin(ready) ?? options.playbackOriginHint ?? null;
  const state = selection ? "ready" : options.bootstrap ? options.bootstrap.status : "loading";
  const message = playerMessage(options.bootstrap, selection);
  const autoPlay = options.autoPlay ? " autoplay" : "";
  const controls = options.controls ? " controls" : "";
  const muted = options.muted ? " muted" : "";
  const poster = ready?.poster_url ? ` poster="${html(ready.poster_url)}"` : "";
  const selectedLabel = inlineStartup ? "mse_inline" : selection?.label ?? "";
  const selectedArtifact = inlineStartup
    ? inlineStartup.artifactPath
    : selection?.artifactPath ?? "";
  const playbackEngine = inlineStartup ? "mse-inline" : "native";
  const source =
    selection?.url && !inlineStartup ? ` src="${html(selection.url)}"` : "";
  const contentType = selection?.contentType
    ? ` type="${html(selection.contentType)}"`
    : "";
  const preload = inlineStartup ? null : preloadablePlaybackSelection(selection);
  const preloadContentType = preload?.contentType ?? "video/mp4";
  const crossOrigin = playbackCrossOrigin(options.bootstrap);
  const crossOriginAttribute = crossOrigin
    ? ` crossorigin="${html(crossOrigin)}"`
    : "";
  const bootstrapMs =
    typeof options.bootstrapMs === "number"
      ? ` data-rend-bootstrap-ms="${Math.max(0, Math.round(options.bootstrapMs))}"`
      : "";
  const bootstrapHttpStatus =
    typeof options.bootstrapHttpStatus === "number"
      ? ` data-rend-bootstrap-status="${Math.max(100, Math.round(options.bootstrapHttpStatus))}"`
      : "";
  const preferredStartup =
    !inlineStartup && options.startupMode === "progressive"
      ? "opener"
      : options.startupMode;
  const inlineStartupJson = scriptJson(
    inlineStartup
      ? {
          artifactPath: inlineStartup.artifactPath,
          mimeType: inlineStartup.mimeType,
          startup: inlineStartup.startupB64,
          segmentUrls: inlineStartup.segmentUrls,
        }
      : null,
  );
  const fallbackJson = scriptJson(
    selection
      ? {
          artifactPath: selection.artifactPath,
          contentType: selection.contentType,
          label: selection.label,
          url: selection.url,
        }
      : null,
  );
  const fetchCredentials =
    options.bootstrap?.status === "ready" &&
    options.bootstrap.playback_credential_mode === "omit"
      ? "omit"
      : "include";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Rend player</title>
${edge ? `<link rel="dns-prefetch" href="${html(edge.dnsPrefetch)}">` : ""}
${edge ? `<link rel="preconnect" href="${html(edge.origin)}" crossorigin>` : ""}
${preload ? `<link rel="preload" as="video" href="${html(preload.url)}" type="${html(preloadContentType)}"${crossOriginAttribute} fetchpriority="high">` : ""}
<style>
html,body{margin:0;width:100%;height:100%;background:#050505;color:#f7f7f7}
body{overflow:hidden}
.rend-fast{position:fixed;inset:0;display:grid;place-items:center;background:#050505;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.rend-fast__video{width:100%;height:100%;display:block;object-fit:contain;background:#000}
.rend-fast__message{position:absolute;left:16px;bottom:14px;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.64);font-size:13px;line-height:1.2;color:#fff}
.rend-fast[data-rend-player-state="ready"] .rend-fast__message{display:none}
</style>
</head>
<body>
<main class="rend-fast" aria-label="Video player" data-rend-player-state="${html(state)}" data-rend-player-selected="${html(selectedLabel)}" data-rend-player-artifact="${html(selectedArtifact)}" data-rend-ready-status="${html(ready?.status ?? options.bootstrap?.status ?? state)}" data-rend-source-state="${html(ready?.source_state ?? "")}" data-rend-playable-state="${html(ready?.playable_state ?? "")}" data-rend-manifest-content-type="${html(ready?.manifest_content_type ?? "")}" data-rend-opener-content-type="${html(ready?.opener_content_type ?? "")}" data-rend-poster="${html(ready?.poster_url ?? "")}" data-rend-prefetch-hint-count="${html(ready?.prefetch_hints.length ?? 0)}" data-rend-playback-engine="${html(playbackEngine)}" data-rend-document-start-ms="0"${bootstrapMs}${bootstrapHttpStatus} data-rend-asset-id="${html(options.assetId)}" data-rend-organization-id="${html(ready?.organization_id ?? "")}" data-rend-autoplay="${options.autoPlay ? "true" : "false"}" data-rend-muted="${options.muted ? "true" : "false"}" data-rend-startup-mode="${html(options.startupMode)}">
<video class="rend-fast__video"${source}${contentType}${poster}${autoPlay}${controls}${muted} playsinline preload="auto"${crossOriginAttribute}></video>
<div class="rend-fast__message" role="status" aria-live="polite">${html(message)}</div>
</main>
<script>
	(()=>{const root=document.querySelector("[data-rend-player-state]");const video=document.querySelector("video");if(!root||!video)return;const assetId=${jsString(options.assetId)};const preferredStartup=${jsString(preferredStartup)};const bootstrapUrl=${jsString(options.bootstrapUrl)};const inlineStartup=${inlineStartupJson};const fallback=${fallbackJson};const autoPlay=${options.autoPlay ? "true" : "false"};const fetchCredentials=${jsString(fetchCredentials)};const bootstrapStarted=performance.now();const mark=(name)=>{if(!root.getAttribute(name))root.setAttribute(name,String(Math.round(performance.now())))};const dims=()=>{if(video.videoWidth)root.setAttribute("data-rend-selected-width",String(video.videoWidth));if(video.videoHeight)root.setAttribute("data-rend-selected-height",String(video.videoHeight))};const play=()=>{if(autoPlay)video.play().catch(()=>{})};const setSelection=(label,artifactPath,engine)=>{root.setAttribute("data-rend-player-state","ready");root.setAttribute("data-rend-player-selected",label||"");root.setAttribute("data-rend-player-artifact",artifactPath||"");root.setAttribute("data-rend-playback-engine",engine||"native")};const applyCrossOrigin=(data)=>{if(data&&data.playback_credential_mode==="omit")video.crossOrigin="anonymous";else video.removeAttribute("crossorigin")};const progressive=(data)=>{if(data.playable_state!=="hls_ready"||!data.manifest_url)return null;const byRendition=new Map();for(const hint of Array.isArray(data.prefetch_hints)?data.prefetch_hints:[]){const match=/^hls\\/([^/]+)\\/([^/]+)$/.exec(String(hint.artifact_path||""));if(!match)continue;const state=byRendition.get(match[1])||{init:false,segment:false};state.init=state.init||match[2]===\`init_\${match[1]}.mp4\`;state.segment=state.segment||match[2]==="segment_00000.m4s";byRendition.set(match[1],state)}let rendition="";for(const candidate of ["360p","480p","720p","1080p","2k","4k"]){const state=byRendition.get(candidate);if(state&&state.init&&state.segment){rendition=candidate;break}}if(!rendition)return null;try{const parsed=new URL(data.manifest_url);const prefix="/v/"+assetId+"/";if(!parsed.pathname.startsWith(prefix))return null;const artifactPath="hls/"+rendition+"/progressive.mp4";parsed.pathname=prefix+artifactPath;parsed.search="";parsed.hash="";return{artifactPath,contentType:"video/mp4",label:"progressive_mp4",url:parsed.toString()}}catch{return null}};const select=(data)=>{if(!data||data.status!=="ready")return null;if(preferredStartup==="opener"&&data.opener_url)return{artifactPath:"opener.mp4",contentType:data.opener_content_type||"video/mp4",label:"opener",url:data.opener_url};if(preferredStartup==="progressive"){const selected=progressive(data);if(selected)return selected}if(data.playback_credential_mode!=="omit"&&data.opener_url)return{artifactPath:"opener.mp4",contentType:data.opener_content_type||"video/mp4",label:"opener",url:data.opener_url};if(data.playable_state==="hls_ready"&&data.manifest_url)return{artifactPath:"hls/master.m3u8",contentType:data.manifest_content_type||"application/vnd.apple.mpegurl",label:"native_hls",url:data.manifest_url};if(data.opener_url)return{artifactPath:"opener.mp4",contentType:data.opener_content_type||"video/mp4",label:"opener",url:data.opener_url};if(data.playback_url)return{artifactPath:data.playable_state==="hls_ready"?"hls/master.m3u8":"opener.mp4",contentType:data.playback_content_type||"",label:"primary",url:data.playback_url};return null};const bytes=(value)=>{const binary=atob(value);const output=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)output[index]=binary.charCodeAt(index);return output};const append=(buffer,data)=>new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve()};const fail=()=>{cleanup();reject(new Error("append failed"))};const cleanup=()=>{buffer.removeEventListener("updateend",done);buffer.removeEventListener("error",fail)};buffer.addEventListener("updateend",done);buffer.addEventListener("error",fail);buffer.appendBuffer(data)});const sourceOpen=(mediaSource)=>new Promise((resolve,reject)=>{if(mediaSource.readyState==="open"){resolve();return}const done=()=>{cleanup();resolve()};const fail=()=>{cleanup();reject(new Error("source open failed"))};const cleanup=()=>{mediaSource.removeEventListener("sourceopen",done);mediaSource.removeEventListener("sourceclose",fail);mediaSource.removeEventListener("sourceended",fail)};mediaSource.addEventListener("sourceopen",done,{once:true});mediaSource.addEventListener("sourceclose",fail,{once:true});mediaSource.addEventListener("sourceended",fail,{once:true})});const fetchSegment=(url)=>fetch(url,{credentials:fetchCredentials}).then(response=>{if(!response.ok)throw new Error("segment fetch failed");return response.arrayBuffer()}).then(buffer=>new Uint8Array(buffer));const bufferedAhead=()=>{try{for(let index=0;index<video.buffered.length;index++){const start=video.buffered.start(index);const end=video.buffered.end(index);if(start<=video.currentTime&&end>video.currentTime)return end-video.currentTime}}catch{}return 0};const waitForBufferRoom=()=>new Promise(resolve=>{if(bufferedAhead()<8){resolve();return}const cleanup=()=>{video.removeEventListener("timeupdate",tick);video.removeEventListener("playing",tick);clearTimeout(timeout)};const tick=()=>{if(bufferedAhead()<5){cleanup();resolve()}};const timeout=setTimeout(()=>{cleanup();resolve()},1000);video.addEventListener("timeupdate",tick);video.addEventListener("playing",tick)});const startNative=(selected=fallback)=>{if(!selected)return false;setSelection(selected.label,selected.artifactPath,"native");if(selected.url&&video.getAttribute("src")!==selected.url){video.src=selected.url;video.load()}play();return true};const startInline=async()=>{if(!inlineStartup||!("MediaSource"in window)||!MediaSource.isTypeSupported(inlineStartup.mimeType))return false;setSelection("mse_inline",inlineStartup.artifactPath,"mse-inline");const mediaSource=new MediaSource();const objectUrl=URL.createObjectURL(mediaSource);video.removeAttribute("src");video.src=objectUrl;video.load();await sourceOpen(mediaSource);const sourceBuffer=mediaSource.addSourceBuffer(inlineStartup.mimeType);await append(sourceBuffer,bytes(inlineStartup.startup));play();(async()=>{for(const url of inlineStartup.segmentUrls){await waitForBufferRoom();await append(sourceBuffer,await fetchSegment(url))}if(mediaSource.readyState==="open")mediaSource.endOfStream()})().catch(()=>{});return true};video.addEventListener("loadedmetadata",()=>{dims();mark("data-rend-metadata-ms")},{once:true});video.addEventListener("canplay",()=>{dims();mark("data-rend-canplay-ms")},{once:true});video.addEventListener("playing",()=>{root.setAttribute("data-rend-player-state","playing");dims()});if("requestVideoFrameCallback"in video){video.requestVideoFrameCallback(()=>{dims();mark("data-rend-first-frame-ms")})}else{video.addEventListener("playing",()=>mark("data-rend-first-frame-ms"),{once:true})}if(inlineStartup){startInline().then(started=>{if(!started&&!startNative())root.setAttribute("data-rend-player-state","playback_failure")}).catch(()=>{if(!startNative())root.setAttribute("data-rend-player-state","playback_failure")});return}if(video.currentSrc||video.getAttribute("src")){play();return}if(fallback){startNative();return}fetch(bootstrapUrl,{credentials:"same-origin",headers:{accept:"application/json"}}).then(r=>{root.setAttribute("data-rend-bootstrap-status",String(r.status));return r.ok?r.json():null}).then(data=>{root.setAttribute("data-rend-bootstrap-ms",String(Math.round(performance.now()-bootstrapStarted)));if(data&&data.organization_id)root.setAttribute("data-rend-organization-id",data.organization_id);const selected=select(data);if(!selected)return;applyCrossOrigin(data);if(data.poster_url){root.setAttribute("data-rend-poster",data.poster_url);video.poster=data.poster_url}root.setAttribute("data-rend-ready-status",data.status||"ready");root.setAttribute("data-rend-source-state",data.source_state||"");root.setAttribute("data-rend-playable-state",data.playable_state||"");startNative(selected)}).catch(()=>{root.setAttribute("data-rend-player-state","playback_failure")})})();
</script>
<script>${FAST_EMBED_TELEMETRY_SCRIPT}</script>
</body>
</html>`;
}

async function fetchBootstrap(request: Request, assetId: string) {
  const startedAt = Date.now();
  const response = await fetch(bootstrapUrlForRequest(request, assetId), {
    cache: "no-store",
    headers: forwardedBootstrapHeaders(request),
    signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
  }).catch(() => null);
  const data = response ? await response.json().catch(() => null) : null;

  return {
    bootstrap: safeWatchBootstrap(data),
    elapsedMs: Math.max(0, Date.now() - startedAt),
    response,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await context.params;
  const normalizedAssetId = normalizeAssetId(assetId || "");
  if (!normalizedAssetId) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const requestUrl = new URL(request.url);
  const autoPlay = flag(requestUrl.searchParams.get("autoplay"), false);
  const muted = requestUrl.searchParams.has("muted")
    ? flag(requestUrl.searchParams.get("muted"), true)
    : autoPlay;
  const controls = flag(requestUrl.searchParams.get("controls"), true);
  const startup = startupMode(
    requestUrl.searchParams.get("startupMode") ??
      requestUrl.searchParams.get("startup"),
  );
  const bootstrapStrategy = bootstrapMode(requestUrl.searchParams.get("bootstrap"));
  const shouldServerBootstrap = bootstrapStrategy === "server";
  const bootstrapResult = shouldServerBootstrap
    ? await fetchBootstrap(request, normalizedAssetId)
    : { bootstrap: null, elapsedMs: 0, response: null };
  const { bootstrap, elapsedMs, response } = bootstrapResult;
  const ready = bootstrap?.status === "ready" ? bootstrap : null;
  const preferredSelection = playbackSelection(bootstrap, startup);
  const inlineStartup = shouldServerBootstrap
    ? await inlineStartupForSelection(bootstrap, preferredSelection, response)
    : null;
  const selection = nativeFallbackSelection(
    bootstrap,
    preferredSelection,
    inlineStartup,
  );
  const edge = playbackOrigin(ready) ?? defaultPlaybackOriginHint();
  const crossOrigin = playbackCrossOrigin(bootstrap);
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "server-timing": `rendfastbootstrap;dur=${elapsedMs}`,
    "x-rend-fast-embed": "1",
  });

  if (response) {
    for (const setCookie of setCookieHeaders(response.headers)) {
      headers.append("set-cookie", setCookie);
    }
  }
  appendStartupLinkHeaders(headers, edge, selection, inlineStartup, crossOrigin);

  return new Response(
    renderFastEmbedHtml({
      assetId: normalizedAssetId,
      autoPlay,
      bootstrap,
      bootstrapHttpStatus: response?.status,
      bootstrapUrl: clientBootstrapUrlForRequest(request, normalizedAssetId),
      bootstrapMs: elapsedMs,
      controls,
      inlineStartup,
      muted,
      playbackOriginHint: edge,
      startupMode: startup,
    }),
    { headers },
  );
}
