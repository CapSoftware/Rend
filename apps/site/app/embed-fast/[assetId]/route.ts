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
  bootstrapUrl: string;
  bootstrapMs?: number;
  controls: boolean;
  muted: boolean;
  playbackOriginHint?: { dnsPrefetch: string; origin: string } | null;
  startupMode: "hls" | "opener" | "progressive";
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
) {
  if (edge) {
    headers.append(
      "link",
      `<${linkHeaderValue(edge.origin)}>; rel=preconnect; crossorigin`,
    );
  }

  const preload = preloadablePlaybackSelection(selection);
  if (!preload) return;
  const preloadContentType = preload.contentType ?? "video/mp4";
  headers.append(
    "link",
    `<${linkHeaderValue(preload.url)}>; rel=preload; as=video; type="${linkHeaderValue(preloadContentType)}"; crossorigin="use-credentials"; fetchpriority=high`,
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

export function renderFastEmbedHtml(options: FastEmbedRenderOptions) {
  const ready = options.bootstrap?.status === "ready" ? options.bootstrap : null;
  const selection = playbackSelection(options.bootstrap, options.startupMode);
  const edge = playbackOrigin(ready) ?? options.playbackOriginHint ?? null;
  const state = selection ? "ready" : options.bootstrap ? options.bootstrap.status : "loading";
  const message = playerMessage(options.bootstrap, selection);
  const autoPlay = options.autoPlay ? " autoplay" : "";
  const controls = options.controls ? " controls" : "";
  const muted = options.muted ? " muted" : "";
  const poster = ready?.poster_url ? ` poster="${html(ready.poster_url)}"` : "";
  const source = selection?.url ? ` src="${html(selection.url)}"` : "";
  const contentType = selection?.contentType
    ? ` type="${html(selection.contentType)}"`
    : "";
  const preload = preloadablePlaybackSelection(selection);
  const preloadContentType = preload?.contentType ?? "video/mp4";
  const bootstrapMs =
    typeof options.bootstrapMs === "number"
      ? ` data-rend-bootstrap-ms="${Math.max(0, Math.round(options.bootstrapMs))}"`
      : "";
  const preferredStartup = options.startupMode;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Rend player</title>
${edge ? `<link rel="dns-prefetch" href="${html(edge.dnsPrefetch)}">` : ""}
${edge ? `<link rel="preconnect" href="${html(edge.origin)}" crossorigin>` : ""}
${preload ? `<link rel="preload" as="video" href="${html(preload.url)}" type="${html(preloadContentType)}" crossorigin="use-credentials" fetchpriority="high">` : ""}
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
<main class="rend-fast" aria-label="Video player" data-rend-player-state="${html(state)}" data-rend-player-selected="${html(selection?.label ?? "")}" data-rend-player-artifact="${html(selection?.artifactPath ?? "")}" data-rend-ready-status="${html(ready?.status ?? options.bootstrap?.status ?? state)}" data-rend-source-state="${html(ready?.source_state ?? "")}" data-rend-playable-state="${html(ready?.playable_state ?? "")}" data-rend-manifest-content-type="${html(ready?.manifest_content_type ?? "")}" data-rend-opener-content-type="${html(ready?.opener_content_type ?? "")}" data-rend-poster="${html(ready?.poster_url ?? "")}" data-rend-prefetch-hint-count="${html(ready?.prefetch_hints.length ?? 0)}" data-rend-playback-engine="native" data-rend-document-start-ms="0"${bootstrapMs} data-rend-asset-id="${html(options.assetId)}">
<video class="rend-fast__video"${source}${contentType}${poster}${autoPlay}${controls}${muted} playsinline preload="auto" crossorigin="use-credentials"></video>
<div class="rend-fast__message" role="status" aria-live="polite">${html(message)}</div>
</main>
<script>
(()=>{const root=document.querySelector("[data-rend-player-state]");const video=document.querySelector("video");if(!root||!video)return;const assetId=${jsString(options.assetId)};const preferredStartup=${jsString(preferredStartup)};const bootstrapUrl=${jsString(options.bootstrapUrl)};const autoPlay=${options.autoPlay ? "true" : "false"};const bootstrapStarted=performance.now();const mark=(name)=>{if(!root.getAttribute(name))root.setAttribute(name,String(Math.round(performance.now())))};const dims=()=>{if(video.videoWidth)root.setAttribute("data-rend-selected-width",String(video.videoWidth));if(video.videoHeight)root.setAttribute("data-rend-selected-height",String(video.videoHeight))};const play=()=>{if(autoPlay)video.play().catch(()=>{})};const progressive=(data)=>{if(data.playable_state!=="hls_ready"||!data.manifest_url)return null;const byRendition=new Map();for(const hint of Array.isArray(data.prefetch_hints)?data.prefetch_hints:[]){const match=/^hls\\/([^/]+)\\/([^/]+)$/.exec(String(hint.artifact_path||""));if(!match)continue;const state=byRendition.get(match[1])||{init:false,segment:false};state.init=state.init||match[2]===\`init_\${match[1]}.mp4\`;state.segment=state.segment||match[2]==="segment_00000.m4s";byRendition.set(match[1],state)}let rendition="";for(const candidate of ["360p","480p","720p","1080p","2k","4k"]){const state=byRendition.get(candidate);if(state&&state.init&&state.segment){rendition=candidate;break}}if(!rendition)return null;try{const parsed=new URL(data.manifest_url);const prefix="/v/"+assetId+"/";if(!parsed.pathname.startsWith(prefix))return null;const artifactPath="hls/"+rendition+"/progressive.mp4";parsed.pathname=prefix+artifactPath;parsed.search="";parsed.hash="";return{artifactPath,contentType:"video/mp4",label:"progressive_mp4",url:parsed.toString()}}catch{return null}};const select=(data)=>{if(!data||data.status!=="ready")return null;if(preferredStartup==="opener"&&data.opener_url)return{artifactPath:"opener.mp4",contentType:data.opener_content_type||"video/mp4",label:"opener",url:data.opener_url};if(preferredStartup==="progressive"){const selected=progressive(data);if(selected)return selected}if(data.playable_state==="hls_ready"&&data.manifest_url)return{artifactPath:"hls/master.m3u8",contentType:data.manifest_content_type||"application/vnd.apple.mpegurl",label:"native_hls",url:data.manifest_url};if(data.opener_url)return{artifactPath:"opener.mp4",contentType:data.opener_content_type||"video/mp4",label:"opener",url:data.opener_url};if(data.playback_url)return{artifactPath:data.playable_state==="hls_ready"?"hls/master.m3u8":"opener.mp4",contentType:data.playback_content_type||"",label:"primary",url:data.playback_url};return null};video.addEventListener("loadedmetadata",()=>{dims();mark("data-rend-metadata-ms")},{once:true});video.addEventListener("canplay",()=>{dims();mark("data-rend-canplay-ms")},{once:true});video.addEventListener("playing",()=>{root.setAttribute("data-rend-player-state","playing");dims()});if("requestVideoFrameCallback"in video){video.requestVideoFrameCallback(()=>{dims();mark("data-rend-first-frame-ms")})}else{video.addEventListener("playing",()=>mark("data-rend-first-frame-ms"),{once:true})}if(!video.currentSrc&&!video.getAttribute("src")){fetch(bootstrapUrl,{credentials:"same-origin",headers:{accept:"application/json"}}).then(r=>r.ok?r.json():null).then(data=>{root.setAttribute("data-rend-bootstrap-ms",String(Math.round(performance.now()-bootstrapStarted)));const selected=select(data);if(!selected)return;root.setAttribute("data-rend-player-state","ready");root.setAttribute("data-rend-player-selected",selected.label);root.setAttribute("data-rend-player-artifact",selected.artifactPath);if(data.poster_url){root.setAttribute("data-rend-poster",data.poster_url);video.poster=data.poster_url}root.setAttribute("data-rend-ready-status",data.status||"ready");root.setAttribute("data-rend-source-state",data.source_state||"");root.setAttribute("data-rend-playable-state",data.playable_state||"");video.src=selected.url;video.load();play()}).catch(()=>{root.setAttribute("data-rend-player-state","playback_failure")})}else{play()}})();
</script>
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
  const selection = playbackSelection(bootstrap, startup);
  const edge = playbackOrigin(ready) ?? defaultPlaybackOriginHint();
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
  appendStartupLinkHeaders(headers, edge, selection);

  return new Response(
    renderFastEmbedHtml({
      assetId: normalizedAssetId,
      autoPlay,
      bootstrap,
      bootstrapUrl: clientBootstrapUrlForRequest(request, normalizedAssetId),
      bootstrapMs: elapsedMs,
      controls,
      muted,
      playbackOriginHint: edge,
      startupMode: startup,
    }),
    { headers },
  );
}
