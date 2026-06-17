const SENSITIVE_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "cookies",
  "playback_token",
  "secret",
  "set-cookie",
  "signature",
  "token",
]);

const SECRET_TEXT_PATTERNS = [
  /Authorization:\s*Bearer\s+[^\s"']+/gi,
  /\brend_(live|test)_[A-Za-z0-9._-]+/g,
  /__rend_playback=[^;\s"']+/gi,
  /([?&])(?:token|playback_token|signature)=[^&\s"']+/gi,
];

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        SENSITIVE_KEYS.has(normalizeKey(key)) ? "[redacted]" : redactSecrets(field),
      ])
    );
  }
  if (typeof value === "string") return redactSecretText(value);
  return value;
}

export function safePlaybackUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const redacted = redactSecretText(value.trim());
  if (redacted !== value.trim()) return undefined;
  if (/\/(?:internal|operator)(?:\/|$)/i.test(redacted)) return undefined;

  try {
    const url = new URL(redacted, "https://rend.so");
    if (url.searchParams.has("token") || url.searchParams.has("playback_token") || url.searchParams.has("signature")) {
      return undefined;
    }
    if (url.hostname && !isAllowedPlaybackHost(url.hostname)) return undefined;
  } catch {
    return undefined;
  }

  return redacted;
}

export function redactSecretText(value: string) {
  return SECRET_TEXT_PATTERNS.reduce((text, pattern) => {
    if (pattern.source.startsWith("([?&])")) return text.replace(pattern, "$1redacted=1");
    if (pattern.source.includes("rend_")) return text.replace(pattern, "rend_$1_[redacted]");
    if (pattern.source.includes("__rend_playback")) return text.replace(pattern, "__rend_playback=[redacted]");
    return text.replace(pattern, "Authorization: Bearer [redacted]");
  }, value);
}

function isAllowedPlaybackHost(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    host === "rend.so" ||
    host.endsWith(".rend.so") ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1"
  );
}

function normalizeKey(key: string) {
  return key.toLowerCase().replaceAll("-", "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
