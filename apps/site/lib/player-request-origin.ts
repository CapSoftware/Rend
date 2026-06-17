export function isTrustedRendHost(host: string) {
  const normalized = host.trim().toLowerCase();
  return normalized === "rend.so" || normalized.endsWith(".rend.so");
}

export function forwardedHost(request: Request) {
  const rawHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  if (!rawHost) return undefined;
  try {
    return new URL(`https://${rawHost}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function publicRequestHost(request: Request) {
  const requestHost = new URL(request.url).hostname.toLowerCase();
  if (isTrustedRendHost(requestHost)) return requestHost;

  const host = forwardedHost(request);
  return host && isTrustedRendHost(host) ? host : requestHost;
}
