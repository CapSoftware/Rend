"use client";

export type RendPlayerPlaybackMode = "native_hls" | "hls_js" | "opener" | "primary";

export type RendPlayerTelemetryPhase =
  | "player_load"
  | "bootstrap_complete"
  | "source_selected"
  | "metadata_loaded"
  | "canplay"
  | "first_frame"
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
};

export type RendPlayerTelemetryInput = Omit<
  RendPlayerTelemetryEvent,
  "playback_session_id" | "asset_id" | "event_time_ms" | "player_version"
>;

export const REND_PLAYER_VERSION = "0.1.0";

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

export function sendPlayerTelemetryEvent(
  telemetryUrl: string,
  event: RendPlayerTelemetryEvent
) {
  const payload = JSON.stringify({ events: [event] });

  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
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
