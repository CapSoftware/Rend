import type {
  RendPlayerPlaybackMode,
  RendPlayerTelemetryEvent,
  RendPlayerTelemetryPhase,
} from "@rend/player";

export const PLAYER_TELEMETRY_MAX_BODY_BYTES = 24 * 1024;
export const PLAYER_TELEMETRY_MAX_EVENTS = 16;
export const PLAYER_TELEMETRY_RING_SIZE = 256;

const MAX_TEXT_LENGTH = 180;
const MAX_LABEL_LENGTH = 80;
const MAX_ID_LENGTH = 160;
const MAX_ARTIFACT_PATH_LENGTH = 180;
const MAX_TIMING_MS = 24 * 60 * 60 * 1000;

const PHASES = new Set<RendPlayerTelemetryPhase>([
  "player_load",
  "bootstrap_complete",
  "source_selected",
  "metadata_loaded",
  "canplay",
  "first_frame",
  "bootstrap_failure",
  "playback_failure",
]);

const PLAYBACK_MODES = new Set<RendPlayerPlaybackMode>([
  "native_hls",
  "hls_js",
  "opener",
  "primary",
]);

const CACHE_HEADER_NAMES = new Set([
  "age",
  "cache-control",
  "cf-cache-status",
  "server-timing",
  "x-cache",
  "x-rend-cache",
  "x-rend-cache-status",
  "x-rend-edge-id",
  "x-rend-region",
]);

type RawRecord = Record<string, unknown>;

export type SanitizedPlayerTelemetryEvent = RendPlayerTelemetryEvent & {
  received_at_ms: number;
};

export type PlayerTelemetryValidationResult =
  | { ok: true; events: SanitizedPlayerTelemetryEvent[] }
  | { ok: false; status: number; error: string };

const telemetryRing: SanitizedPlayerTelemetryEvent[] = [];

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function redactUnsafeText(value: string, maxLength = MAX_TEXT_LENGTH) {
  return value
    .replace(/https?:\/\/[^\s"',;)]+/gi, "[redacted-url]")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer|basic)?\s*[^\s"',;)]+/gi, "[redacted-auth]")
    .replace(/\bset-cookie\s*[:=][^\r\n;]+/gi, "[redacted-cookie]")
    .replace(/\bcookie\s*[:=][^\r\n;]+/gi, "[redacted-cookie]")
    .replace(
      /\b(token|signature|secret|api[_-]?key|authorization|cookie)\b\s*[:=]\s*[^\s"',;)]+/gi,
      "$1=[redacted]"
    )
    .replace(
      /([?&](?:token|signature|secret|api[_-]?key|authorization|cookie)=)[^\s"',;)]+/gi,
      "$1[redacted]"
    )
    .slice(0, maxLength);
}

function containsUnsafeUrlOrSecret(value: string) {
  return (
    /https?:\/\//i.test(value) ||
    /[?#]/.test(value) ||
    /\bauthorization\b/i.test(value) ||
    /\b(set-cookie|cookie)\b/i.test(value) ||
    /\b(token|signature|secret|api[_-]?key)\b\s*[:=]/i.test(value)
  );
}

function safeId(value: unknown) {
  const id = stringValue(value, MAX_ID_LENGTH);
  if (!id || containsUnsafeUrlOrSecret(id)) return undefined;
  return /^[a-zA-Z0-9._:-]+$/.test(id) ? id : undefined;
}

function safeLabel(value: unknown) {
  const label = stringValue(value, MAX_LABEL_LENGTH);
  if (!label || containsUnsafeUrlOrSecret(label)) return undefined;
  return /^[a-zA-Z0-9._:-]+$/.test(label) ? label : undefined;
}

function safeVersion(value: unknown) {
  const version = stringValue(value, 64);
  if (!version || containsUnsafeUrlOrSecret(version)) return undefined;
  return /^[a-zA-Z0-9._:+-]+$/.test(version) ? version : undefined;
}

function safeArtifactPath(value: unknown) {
  const artifactPath = stringValue(value, MAX_ARTIFACT_PATH_LENGTH);
  if (!artifactPath || containsUnsafeUrlOrSecret(artifactPath)) return undefined;
  if (artifactPath.startsWith("/") || artifactPath.includes("\\") || artifactPath.includes("..")) {
    return undefined;
  }
  return /^[a-zA-Z0-9._/-]+$/.test(artifactPath) ? artifactPath : undefined;
}

function safeTiming(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > MAX_TIMING_MS) return undefined;
  return Math.round(value);
}

function safeHttpStatus(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 100 && value <= 599 ? value : undefined;
}

function safeEventTime(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 1_000_000_000_000 || value > 10_000_000_000_000) return undefined;
  return Math.round(value);
}

function safeFailureText(value: unknown) {
  const text = stringValue(value, MAX_TEXT_LENGTH);
  return text ? redactUnsafeText(text) : undefined;
}

function safeCacheHeaders(value: unknown) {
  if (!isRecord(value)) return undefined;

  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!CACHE_HEADER_NAMES.has(name)) continue;

    const headerValue = stringValue(rawValue, MAX_TEXT_LENGTH);
    if (!headerValue) continue;
    headers[name] = redactUnsafeText(headerValue);
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function addOptional(target: object, key: string, value: unknown) {
  if (value !== undefined) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function sanitizeEvent(
  value: unknown,
  receivedAtMs: number
): SanitizedPlayerTelemetryEvent | { error: string } {
  if (!isRecord(value)) return { error: "event_must_be_object" };

  const playbackSessionId = safeId(value.playback_session_id);
  const assetId = safeId(value.asset_id);
  const phase = typeof value.phase === "string" && PHASES.has(value.phase as RendPlayerTelemetryPhase)
    ? (value.phase as RendPlayerTelemetryPhase)
    : undefined;

  if (!playbackSessionId) return { error: "invalid_playback_session_id" };
  if (!assetId) return { error: "invalid_asset_id" };
  if (!phase) return { error: "invalid_phase" };

  const event: SanitizedPlayerTelemetryEvent = {
    playback_session_id: playbackSessionId,
    asset_id: assetId,
    phase,
    event_time_ms: safeEventTime(value.event_time_ms) ?? receivedAtMs,
    received_at_ms: receivedAtMs,
  };

  addOptional(event, "bootstrap_start_ms", safeTiming(value.bootstrap_start_ms));
  addOptional(event, "bootstrap_end_ms", safeTiming(value.bootstrap_end_ms));
  addOptional(event, "bootstrap_duration_ms", safeTiming(value.bootstrap_duration_ms));
  addOptional(event, "bootstrap_http_status", safeHttpStatus(value.bootstrap_http_status));

  const playbackMode =
    typeof value.selected_playback_mode === "string" &&
    PLAYBACK_MODES.has(value.selected_playback_mode as RendPlayerPlaybackMode)
      ? (value.selected_playback_mode as RendPlayerPlaybackMode)
      : undefined;
  addOptional(event, "selected_playback_mode", playbackMode);

  if (value.selected_artifact_path !== undefined) {
    const artifactPath = safeArtifactPath(value.selected_artifact_path);
    if (!artifactPath) return { error: "invalid_selected_artifact_path" };
    event.selected_artifact_path = artifactPath;
  }

  addOptional(event, "metadata_loaded_ms", safeTiming(value.metadata_loaded_ms));
  addOptional(event, "canplay_ms", safeTiming(value.canplay_ms));
  addOptional(event, "first_frame_ms", safeTiming(value.first_frame_ms));
  addOptional(event, "playback_failure_reason", safeFailureText(value.playback_failure_reason));
  addOptional(event, "playback_failure_code", safeLabel(value.playback_failure_code));
  addOptional(event, "cache_headers", safeCacheHeaders(value.cache_headers));
  addOptional(event, "edge_label", safeLabel(value.edge_label));
  addOptional(event, "region_label", safeLabel(value.region_label));
  addOptional(event, "player_version", safeVersion(value.player_version));
  addOptional(event, "app_version", safeVersion(value.app_version));

  return event;
}

export function sanitizePlayerTelemetryPayload(
  value: unknown,
  receivedAtMs = Date.now()
): PlayerTelemetryValidationResult {
  const eventsValue =
    isRecord(value) && Array.isArray(value.events)
      ? value.events
      : Array.isArray(value)
        ? value
        : [value];

  if (eventsValue.length < 1) {
    return { ok: false, status: 400, error: "empty_event_batch" };
  }

  if (eventsValue.length > PLAYER_TELEMETRY_MAX_EVENTS) {
    return { ok: false, status: 413, error: "event_batch_too_large" };
  }

  const events: SanitizedPlayerTelemetryEvent[] = [];
  for (const eventValue of eventsValue) {
    const event = sanitizeEvent(eventValue, receivedAtMs);
    if ("error" in event) return { ok: false, status: 400, error: event.error };
    events.push(event);
  }

  return { ok: true, events };
}

export function recordPlayerTelemetryEvents(events: SanitizedPlayerTelemetryEvent[]) {
  for (const event of events) {
    telemetryRing.push(event);
    if (telemetryRing.length > PLAYER_TELEMETRY_RING_SIZE) telemetryRing.shift();
  }
}

export function recentPlayerTelemetryEvents({
  assetId,
  limit = 50,
  playbackSessionId,
}: {
  assetId?: string | null;
  limit?: number;
  playbackSessionId?: string | null;
} = {}) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 100);
  const events = telemetryRing
    .filter((event) => {
      if (assetId && event.asset_id !== assetId) return false;
      if (playbackSessionId && event.playback_session_id !== playbackSessionId) return false;
      return true;
    })
    .slice(-safeLimit)
    .reverse();

  return events;
}

export function clearPlayerTelemetryEventsForTests() {
  telemetryRing.length = 0;
}
