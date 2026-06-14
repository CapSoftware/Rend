const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "x-rend-cache",
  "x-rend-edge",
  "x-rend-region",
] as const;

type ArtifactResponseHeaderOptions = {
  contentType?: string;
  rewrittenBody?: string;
};

export function playbackArtifactFetchHeaders(
  requestHeaders: Headers,
  cookie: string | undefined,
  artifactPath: string
) {
  const headers = new Headers();
  const range = requestHeaders.get("range");
  if (range && artifactPath !== "hls/master.m3u8") headers.set("range", range);
  if (cookie) headers.set("cookie", `__rend_playback=${cookie}`);
  return headers;
}

export function playbackArtifactResponseHeaders(source: Headers, options: ArtifactResponseHeaderOptions = {}) {
  const headers = new Headers();
  headers.set("cache-control", "no-store");

  const isRewrittenBody = options.rewrittenBody !== undefined;
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    if (isRewrittenBody && (name === "accept-ranges" || name === "content-length" || name === "content-range")) {
      continue;
    }

    const value = source.get(name);
    if (value) headers.set(name, value);
  }

  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.rewrittenBody !== undefined) {
    headers.set("content-length", String(new TextEncoder().encode(options.rewrittenBody).byteLength));
  }

  return headers;
}
