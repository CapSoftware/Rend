"use client";

export type RendPlayerPlaybackMode = "native_hls" | "hls_js" | "opener" | "primary";

export type RendPlayerTelemetryPhase =
  | "document_start"
  | "player_load"
  | "bootstrap_complete"
  | "video_created"
  | "src_assigned"
  | "source_selected"
  | "source_handoff"
  | "hls_ready"
  | "hls_level_switch"
  | "hls_fragment_loaded"
  | "metadata_loaded"
  | "canplay"
  | "first_frame"
  | "stall_start"
  | "stall_end"
  | "bootstrap_failure"
  | "playback_failure";

export type RendPlayerTelemetryEvent = {
  playback_session_id: string;
  asset_id: string;
  phase: RendPlayerTelemetryPhase;
  event_time_ms: number;
  bootstrap_start_ms?: number;
  bootstrap_end_ms?: number;
  bootstrap_duration_ms?: number;
  bootstrap_http_status?: number;
  selected_playback_mode?: RendPlayerPlaybackMode;
  selected_artifact_path?: string;
  previous_playback_mode?: RendPlayerPlaybackMode;
  previous_artifact_path?: string;
  selected_width?: number;
  selected_height?: number;
  selected_bitrate?: number;
  hls_level_index?: number;
  hls_fragment_index?: number;
  hls_fragment_duration_ms?: number;
  hls_fragment_load_ms?: number;
  stall_reason?: string;
  stall_start_ms?: number;
  stall_end_ms?: number;
  stall_duration_ms?: number;
  metadata_loaded_ms?: number;
  canplay_ms?: number;
  first_frame_ms?: number;
  playback_failure_reason?: string;
  playback_failure_code?: string;
  cache_headers?: Record<string, string>;
  edge_label?: string;
  region_label?: string;
  player_version?: string;
  app_version?: string;
  document_start_ms?: number;
  video_created_ms?: number;
  src_assigned_ms?: number;
};

export type RendPlayerTelemetryInput = Omit<
  RendPlayerTelemetryEvent,
  "playback_session_id" | "asset_id" | "event_time_ms" | "player_version"
>;

export const REND_PLAYER_VERSION = "0.1.0";
const TELEMETRY_SESSION_WINDOW_MS = 60_000;
const TELEMETRY_MAX_EVENTS_PER_SESSION_WINDOW = 80;
const TELEMETRY_BATCH_DELAY_MS = 1_000;
const TELEMETRY_MAX_BATCH_EVENTS = 16;
const TELEMETRY_DEDUPE_WINDOW_MS = 2_000;

const TELEMETRY_HEADER_NAMES = [
  "age",
  "cache-control",
  "cf-cache-status",
  "server-timing",
  "x-cache",
  "x-rend-cache",
  "x-rend-cache-status",
  "x-rend-edge-id",
  "x-rend-region",
];

const EDGE_HEADER_NAMES = ["x-rend-edge-id"];
const REGION_HEADER_NAMES = ["x-rend-region"];
const telemetrySessionWindows = new Map<
  string,
  { count: number; windowStartedAtMs: number }
>();
const telemetryQueues = new Map<
  string,
  { events: RendPlayerTelemetryEvent[]; timer: number | null }
>();
const telemetryDedupeWindows = new Map<string, number>();
let telemetryLifecycleFlushInstalled = false;

export function generatePlaybackSessionId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function safeHeaderValue(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function safeLabel(value: string | null) {
  if (!value) return undefined;
  const normalized = value.trim().slice(0, 80);
  return /^[a-zA-Z0-9._:-]+$/.test(normalized) ? normalized : undefined;
}

export function readableTelemetryHeaders(headers: Headers) {
  const samples: Record<string, string> = {};

  for (const name of TELEMETRY_HEADER_NAMES) {
    const value = headers.get(name);
    if (!value) continue;
    samples[name] = safeHeaderValue(value);
  }

  return Object.keys(samples).length > 0 ? samples : undefined;
}

function firstSafeHeaderLabel(headers: Headers, names: string[]) {
  for (const name of names) {
    const label = safeLabel(headers.get(name));
    if (label) return label;
  }
  return undefined;
}

export function telemetryLabelsFromHeaders(headers: Headers) {
  return {
    edge_label: firstSafeHeaderLabel(headers, EDGE_HEADER_NAMES),
    region_label: firstSafeHeaderLabel(headers, REGION_HEADER_NAMES),
  };
}

function telemetryWithinSessionLimit(event: RendPlayerTelemetryEvent) {
  const now = Date.now();
  const current = telemetrySessionWindows.get(event.playback_session_id);
  if (!current || now - current.windowStartedAtMs > TELEMETRY_SESSION_WINDOW_MS) {
    telemetrySessionWindows.set(event.playback_session_id, {
      count: 1,
      windowStartedAtMs: now,
    });
    return true;
  }

  if (current.count >= TELEMETRY_MAX_EVENTS_PER_SESSION_WINDOW) return false;
  current.count += 1;

  if (telemetrySessionWindows.size > 256) {
    for (const [sessionId, window] of telemetrySessionWindows) {
      if (now - window.windowStartedAtMs > TELEMETRY_SESSION_WINDOW_MS) {
        telemetrySessionWindows.delete(sessionId);
      }
    }
  }

  return true;
}

function telemetryDedupeKey(event: RendPlayerTelemetryEvent) {
  const oncePhases = new Set<RendPlayerTelemetryPhase>([
    "document_start",
    "player_load",
    "bootstrap_complete",
    "video_created",
    "src_assigned",
    "source_selected",
    "hls_ready",
    "metadata_loaded",
    "canplay",
    "first_frame",
    "bootstrap_failure",
    "playback_failure",
  ]);

  if (!oncePhases.has(event.phase) && event.phase !== "stall_start" && event.phase !== "stall_end") {
    return null;
  }

  return [
    event.playback_session_id,
    event.phase,
    event.selected_playback_mode,
    event.selected_artifact_path,
    event.stall_reason,
    event.playback_failure_code,
  ]
    .filter(Boolean)
    .join(":");
}

function telemetryWithinDedupeWindow(event: RendPlayerTelemetryEvent) {
  const key = telemetryDedupeKey(event);
  if (!key) return true;

  const now = Date.now();
  const previous = telemetryDedupeWindows.get(key);
  const windowMs =
    event.phase === "stall_start" || event.phase === "stall_end"
      ? TELEMETRY_DEDUPE_WINDOW_MS
      : TELEMETRY_SESSION_WINDOW_MS;
  if (previous !== undefined && now - previous < windowMs) return false;

  telemetryDedupeWindows.set(key, now);
  if (telemetryDedupeWindows.size > 1024) {
    for (const [entryKey, seenAt] of telemetryDedupeWindows) {
      if (now - seenAt > TELEMETRY_SESSION_WINDOW_MS) telemetryDedupeWindows.delete(entryKey);
    }
  }

  return true;
}

function postTelemetryBatch(telemetryUrl: string, events: RendPlayerTelemetryEvent[], preferBeacon = false) {
  if (!events.length) return;
  const payload = JSON.stringify({ events });

  try {
    if (
      preferBeacon &&
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(telemetryUrl, blob)) return;
    }
  } catch {
    // Telemetry must never interfere with playback.
  }

  try {
    void fetch(telemetryUrl, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      keepalive: payload.length < 60_000,
      headers: {
        "content-type": "application/json",
      },
      body: payload,
    }).catch(() => undefined);
  } catch {
    // Telemetry must never interfere with playback.
  }
}

function flushTelemetryQueue(telemetryUrl: string, preferBeacon = false) {
  const queue = telemetryQueues.get(telemetryUrl);
  if (!queue) return;
  if (queue.timer) window.clearTimeout(queue.timer);
  queue.timer = null;

  const events = queue.events.splice(0, TELEMETRY_MAX_BATCH_EVENTS);
  postTelemetryBatch(telemetryUrl, events, preferBeacon);

  if (queue.events.length > 0) {
    queue.timer = window.setTimeout(
      () => flushTelemetryQueue(telemetryUrl),
      TELEMETRY_BATCH_DELAY_MS
    );
  }
}

function installTelemetryLifecycleFlush() {
  if (telemetryLifecycleFlushInstalled || typeof window === "undefined") return;
  telemetryLifecycleFlushInstalled = true;

  const flushAll = () => {
    for (const telemetryUrl of telemetryQueues.keys()) {
      flushTelemetryQueue(telemetryUrl, true);
    }
  };

  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });
}

export function sendPlayerTelemetryEvent(
  telemetryUrl: string,
  event: RendPlayerTelemetryEvent
) {
  if (!telemetryWithinSessionLimit(event)) return;
  if (!telemetryWithinDedupeWindow(event)) return;

  if (typeof window === "undefined") return;
  installTelemetryLifecycleFlush();

  const queue =
    telemetryQueues.get(telemetryUrl) ??
    {
      events: [],
      timer: null,
    };
  telemetryQueues.set(telemetryUrl, queue);
  queue.events.push(event);

  if (!queue.timer) {
    queue.timer = window.setTimeout(
      () => flushTelemetryQueue(telemetryUrl),
      TELEMETRY_BATCH_DELAY_MS
    );
  }
}
