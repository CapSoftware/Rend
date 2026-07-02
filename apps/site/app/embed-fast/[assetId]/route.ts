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

function playbackCookieFromSetCookieHeaders(headers: Headers) {
  for (const value of setCookieHeaders(headers)) {
    const match = value.match(
      new RegExp(`(?:^|,\\s*)${PLAYBACK_COOKIE_NAME}=([^;,\\s]+)`),
    );
    const cookie = safeCookieValue(match?.[1]);
    if (cookie) return cookie;
  }
  return undefined;
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

  if (mode === "progressive" && bootstrap.playback_credential_mode !== "omit") {
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
    : "use-credentials";
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

async function fetchText(url: string, cookie: string | undefined) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/vnd.apple.mpegurl,text/plain,*/*",
      ...(cookie ? { cookie: `${PLAYBACK_COOKIE_NAME}=${cookie}` } : {}),
    },
    signal: AbortSignal.timeout(INLINE_STARTUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("startup playlist fetch failed");
  return response.text();
}

async function fetchBytes(url: string, cookie: string | undefined) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "video/mp4,*/*",
      ...(cookie ? { cookie: `${PLAYBACK_COOKIE_NAME}=${cookie}` } : {}),
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
    bootstrap.playback_credential_mode === "omit"
  ) {
    return null;
  }
  const rendition = progressiveStartupRendition(bootstrap);
  if (!rendition || !bootstrap.manifest_url) return null;

  const playlistUrl = playlistUrlForRendition(bootstrap, rendition);
  const initUrl = playbackHint(bootstrap, `hls/${rendition}/init_${rendition}.mp4`)?.url;
  const firstSegmentUrl = playbackHint(bootstrap, `hls/${rendition}/segment_00000.m4s`)?.url;
  const cookie = bootstrapResponse
    ? playbackCookieFromSetCookieHeaders(bootstrapResponse.headers)
    : undefined;
  if (!playlistUrl || !initUrl || !firstSegmentUrl || !cookie) return null;

  try {
    const [master, playlist, initBytes, firstSegmentBytes] = await Promise.all([
      fetchText(bootstrap.manifest_url, cookie),
      fetchText(playlistUrl, cookie),
      fetchBytes(initUrl, cookie),
      fetchBytes(firstSegmentUrl, cookie),
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
  crossOrigin: "anonymous" | "use-credentials",
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
        `<${linkHeaderValue(nextSegment)}>; rel=preload; as=fetch; type="video/mp4"; crossorigin="${crossOrigin}"; fetchpriority=high`,
      );
    }
    return;
  }

  const preload = preloadablePlaybackSelection(selection);
  if (!preload) return;
  const preloadContentType = preload.contentType ?? "video/mp4";
  headers.append(
    "link",
    `<${linkHeaderValue(preload.url)}>; rel=preload; as=video; type="${linkHeaderValue(preloadContentType)}"; crossorigin="${crossOrigin}"; fetchpriority=high`,
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
  const inlineStartup = options.inlineStartup ?? null;
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
  const bootstrapMs =
    typeof options.bootstrapMs === "number"
      ? ` data-rend-bootstrap-ms="${Math.max(0, Math.round(options.bootstrapMs))}"`
      : "";
  const preferredStartup = options.startupMode;
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
${preload ? `<link rel="preload" as="video" href="${html(preload.url)}" type="${html(preloadContentType)}" crossorigin="${html(crossOrigin)}" fetchpriority="high">` : ""}
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
<main class="rend-fast" aria-label="Video player" data-rend-player-state="${html(state)}" data-rend-player-selected="${html(selectedLabel)}" data-rend-player-artifact="${html(selectedArtifact)}" data-rend-ready-status="${html(ready?.status ?? options.bootstrap?.status ?? state)}" data-rend-source-state="${html(ready?.source_state ?? "")}" data-rend-playable-state="${html(ready?.playable_state ?? "")}" data-rend-manifest-content-type="${html(ready?.manifest_content_type ?? "")}" data-rend-opener-content-type="${html(ready?.opener_content_type ?? "")}" data-rend-poster="${html(ready?.poster_url ?? "")}" data-rend-prefetch-hint-count="${html(ready?.prefetch_hints.length ?? 0)}" data-rend-playback-engine="${html(playbackEngine)}" data-rend-document-start-ms="0"${bootstrapMs} data-rend-asset-id="${html(options.assetId)}">
<video class="rend-fast__video"${source}${contentType}${poster}${autoPlay}${controls}${muted} playsinline preload="auto" crossorigin="${html(crossOrigin)}"></video>
<div class="rend-fast__message" role="status" aria-live="polite">${html(message)}</div>
</main>
<script>
(()=>{const root=document.querySelector("[data-rend-player-state]");const video=document.querySelector("video");if(!root||!video)return;const assetId=${jsString(options.assetId)};const preferredStartup=${jsString(preferredStartup)};const bootstrapUrl=${jsString(options.bootstrapUrl)};const inlineStartup=${inlineStartupJson};const fallback=${fallbackJson};const autoPlay=${options.autoPlay ? "true" : "false"};const fetchCredentials=${jsString(fetchCredentials)};const bootstrapStarted=performance.now();const mark=(name)=>{if(!root.getAttribute(name))root.setAttribute(name,String(Math.round(performance.now())))};const dims=()=>{if(video.videoWidth)root.setAttribute("data-rend-selected-width",String(video.videoWidth));if(video.videoHeight)root.setAttribute("data-rend-selected-height",String(video.videoHeight))};const play=()=>{if(autoPlay)video.play().catch(()=>{})};const setSelection=(label,artifactPath,engine)=>{root.setAttribute("data-rend-player-state","ready");root.setAttribute("data-rend-player-selected",label||"");root.setAttribute("data-rend-player-artifact",artifactPath||"");root.setAttribute("data-rend-playback-engine",engine||"native")};const crossOrigin=(data)=>data&&data.playback_credential_mode==="omit"?"anonymous":"use-credentials";const progressive=(data)=>{if(data.playback_credential_mode==="omit"||data.playable_state!=="hls_ready"||!data.manifest_url)return null;const byRendition=new Map();for(const hint of Array.isArray(data.prefetch_hints)?data.prefetch_hints:[]){const match=/^hls\\/([^/]+)\\/([^/]+)$/.exec(String(hint.artifact_path||""));if(!match)continue;const state=byRendition.get(match[1])||{init:false,segment:false};state.init=state.init||match[2]===\`init_\${match[1]}.mp4\`;state.segment=state.segment||match[2]==="segment_00000.m4s";byRendition.set(match[1],state)}let rendition="";for(const candidate of ["360p","480p","720p","1080p","2k","4k"]){const state=byRendition.get(candidate);if(state&&state.init&&state.segment){rendition=candidate;break}}if(!rendition)return null;try{const parsed=new URL(data.manifest_url);const prefix="/v/"+assetId+"/";if(!parsed.pathname.startsWith(prefix))return null;const artifactPath="hls/"+rendition+"/progressive.mp4";parsed.pathname=prefix+artifactPath;parsed.search="";parsed.hash="";return{artifactPath,contentType:"video/mp4",label:"progressive_mp4",url:parsed.toString()}}catch{return null}};const select=(data)=>{if(!data||data.status!=="ready")return null;if(preferredStartup==="opener"&&data.opener_url)return{artifactPath:"opener.mp4",contentType:data.opener_content_type||"video/mp4",label:"opener",url:data.opener_url};if(preferredStartup==="progressive"){const selected=progressive(data);if(selected)return selected}if(data.playable_state==="hls_ready"&&data.manifest_url)return{artifactPath:"hls/master.m3u8",contentType:data.manifest_content_type||"application/vnd.apple.mpegurl",label:"native_hls",url:data.manifest_url};if(data.opener_url)return{artifactPath:"opener.mp4",contentType:data.opener_content_type||"video/mp4",label:"opener",url:data.opener_url};if(data.playback_url)return{artifactPath:data.playable_state==="hls_ready"?"hls/master.m3u8":"opener.mp4",contentType:data.playback_content_type||"",label:"primary",url:data.playback_url};return null};const bytes=(value)=>{const binary=atob(value);const output=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)output[index]=binary.charCodeAt(index);return output};const append=(buffer,data)=>new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve()};const fail=()=>{cleanup();reject(new Error("append failed"))};const cleanup=()=>{buffer.removeEventListener("updateend",done);buffer.removeEventListener("error",fail)};buffer.addEventListener("updateend",done);buffer.addEventListener("error",fail);buffer.appendBuffer(data)});const sourceOpen=(mediaSource)=>new Promise((resolve,reject)=>{if(mediaSource.readyState==="open"){resolve();return}const done=()=>{cleanup();resolve()};const fail=()=>{cleanup();reject(new Error("source open failed"))};const cleanup=()=>{mediaSource.removeEventListener("sourceopen",done);mediaSource.removeEventListener("sourceclose",fail);mediaSource.removeEventListener("sourceended",fail)};mediaSource.addEventListener("sourceopen",done,{once:true});mediaSource.addEventListener("sourceclose",fail,{once:true});mediaSource.addEventListener("sourceended",fail,{once:true})});const fetchSegment=(url)=>fetch(url,{credentials:fetchCredentials}).then(response=>{if(!response.ok)throw new Error("segment fetch failed");return response.arrayBuffer()}).then(buffer=>new Uint8Array(buffer));const startNative=(selected=fallback)=>{if(!selected)return false;setSelection(selected.label,selected.artifactPath,"native");if(selected.url&&video.getAttribute("src")!==selected.url){video.src=selected.url;video.load()}play();return true};const startInline=async()=>{if(!inlineStartup||!("MediaSource"in window)||!MediaSource.isTypeSupported(inlineStartup.mimeType))return false;const pending=[];let nextSegment=0;const pump=()=>{while(pending.length<4&&nextSegment<inlineStartup.segmentUrls.length)pending.push(fetchSegment(inlineStartup.segmentUrls[nextSegment++]))};pump();setSelection("mse_inline",inlineStartup.artifactPath,"mse-inline");const mediaSource=new MediaSource();const objectUrl=URL.createObjectURL(mediaSource);video.removeAttribute("src");video.src=objectUrl;video.load();await sourceOpen(mediaSource);const sourceBuffer=mediaSource.addSourceBuffer(inlineStartup.mimeType);await append(sourceBuffer,bytes(inlineStartup.startup));play();(async()=>{while(pending.length){const data=await pending.shift();pump();await append(sourceBuffer,data)}if(mediaSource.readyState==="open")mediaSource.endOfStream()})().catch(()=>{});return true};video.addEventListener("loadedmetadata",()=>{dims();mark("data-rend-metadata-ms")},{once:true});video.addEventListener("canplay",()=>{dims();mark("data-rend-canplay-ms")},{once:true});video.addEventListener("playing",()=>{root.setAttribute("data-rend-player-state","playing");dims()});if("requestVideoFrameCallback"in video){video.requestVideoFrameCallback(()=>{dims();mark("data-rend-first-frame-ms")})}else{video.addEventListener("playing",()=>mark("data-rend-first-frame-ms"),{once:true})}if(inlineStartup){startInline().then(started=>{if(!started&&!startNative())root.setAttribute("data-rend-player-state","playback_failure")}).catch(()=>{if(!startNative())root.setAttribute("data-rend-player-state","playback_failure")});return}if(video.currentSrc||video.getAttribute("src")){play();return}if(fallback){startNative();return}fetch(bootstrapUrl,{credentials:"same-origin",headers:{accept:"application/json"}}).then(r=>r.ok?r.json():null).then(data=>{root.setAttribute("data-rend-bootstrap-ms",String(Math.round(performance.now()-bootstrapStarted)));const selected=select(data);if(!selected)return;video.crossOrigin=crossOrigin(data);if(data.poster_url){root.setAttribute("data-rend-poster",data.poster_url);video.poster=data.poster_url}root.setAttribute("data-rend-ready-status",data.status||"ready");root.setAttribute("data-rend-source-state",data.source_state||"");root.setAttribute("data-rend-playable-state",data.playable_state||"");startNative(selected)}).catch(()=>{root.setAttribute("data-rend-player-state","playback_failure")})})();
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
  const inlineStartup = shouldServerBootstrap
    ? await inlineStartupForSelection(bootstrap, selection, response)
    : null;
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
