use std::{
    convert::Infallible,
    net::SocketAddr,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context as TaskContext, Poll},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use aws_sdk_s3::{
    Client as S3Client,
    config::{BehaviorVersion, Credentials, Region, RequestChecksumCalculation},
    primitives::ByteStream,
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, Request, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use bytes::Bytes;
use http_body::{Body as HttpBody, Frame};
use rend_config::{
    env_bool, env_duration_secs, env_socket_addr, env_string, env_usize, load_dotenv,
};
use rend_playback_auth::{
    PlaybackAuthError, PlaybackTokenIssuer, SigningKey, current_unix_timestamp,
    is_valid_hls_segment_name,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, migrate::Migrator, postgres::PgPoolOptions};
use tokio::{net::TcpListener, sync::mpsc};
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

mod events;
mod jobs;
mod media;

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

const DEFAULT_EDGE_WARM_MAX_ARTIFACTS: usize = 4;
const HARD_EDGE_WARM_MAX_ARTIFACTS: usize = 16;
const EDGE_WARM_LOG_BODY_LIMIT_BYTES: usize = 1024;
const DEFAULT_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS: usize = 2;
const HARD_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS: usize = 8;
const DEFAULT_ASSET_EVENTS_LIMIT: usize = 50;
const MAX_ASSET_EVENTS_LIMIT: usize = 100;
const DEFAULT_EVENT_STREAM_BATCH_LIMIT: usize = 100;
const EVENT_STREAM_CHANNEL_CAPACITY: usize = 16;
const EVENT_STREAM_POLL_INTERVAL: Duration = Duration::from_millis(250);
const EVENT_STREAM_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const DEFAULT_MEDIA_JOB_MAX_ATTEMPTS: usize = 3;
const HARD_MEDIA_JOB_MAX_ATTEMPTS: usize = 25;
const MEDIA_JOB_LAST_ERROR_LIMIT_BYTES: usize = 4 * 1024;
const PLAYER_HARNESS_HTML: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rend local playback</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --ink: #101418;
      --muted: #5f6b7a;
      --line: #d8dee7;
      --accent: #1266f1;
      --ok: #087443;
      --warn: #986300;
      --bad: #b42318;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
      letter-spacing: 0;
    }

    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 32px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 680;
      letter-spacing: 0;
    }

    .status {
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 10px;
      background: var(--panel);
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .status.ok { color: var(--ok); border-color: #a8d9c1; }
    .status.warn { color: var(--warn); border-color: #f0cf8a; }
    .status.bad { color: var(--bad); border-color: #f0aaa3; }

    form {
      display: grid;
      grid-template-columns: minmax(220px, 1.4fr) minmax(180px, 0.8fr) auto;
      gap: 10px;
      align-items: end;
      margin-bottom: 16px;
    }

    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 620;
      text-transform: uppercase;
    }

    input {
      min-width: 0;
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      background: var(--panel);
      color: var(--ink);
      font: inherit;
    }

    button {
      height: 38px;
      border: 1px solid #0f57d6;
      border-radius: 6px;
      padding: 0 14px;
      background: var(--accent);
      color: white;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }

    button:disabled { cursor: wait; opacity: 0.65; }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.7fr);
      gap: 16px;
      align-items: start;
    }

    section {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }

    section > h2 {
      margin: 0;
      border-bottom: 1px solid var(--line);
      padding: 11px 14px;
      font-size: 13px;
      font-weight: 720;
      letter-spacing: 0;
    }

    .video-wrap {
      background: #0d1117;
      aspect-ratio: 16 / 9;
      display: grid;
      place-items: center;
    }

    video {
      width: 100%;
      height: 100%;
      display: block;
      background: #0d1117;
    }

    .meta {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1px;
      background: var(--line);
      border-top: 1px solid var(--line);
    }

    .meta div {
      min-width: 0;
      background: var(--panel);
      padding: 10px 12px;
    }

    .meta span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
    }

    .meta strong {
      display: block;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 13px;
    }

    th,
    td {
      border-bottom: 1px solid var(--line);
      padding: 9px 10px;
      text-align: left;
      vertical-align: middle;
    }

    th {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    td {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    td:first-child { width: 96px; font-weight: 650; }
    td:nth-child(2) { width: 145px; color: var(--muted); }

    a {
      color: var(--accent);
      text-decoration: none;
    }

    a:hover { text-decoration: underline; }

    pre {
      margin: 0;
      max-height: 520px;
      overflow: auto;
      padding: 12px 14px;
      color: #dbe7ff;
      background: #111827;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .empty {
      padding: 14px;
      color: var(--muted);
    }

    @media (max-width: 820px) {
      main { width: min(100vw - 20px, 1180px); padding-top: 14px; }
      header { align-items: flex-start; flex-direction: column; }
      form { grid-template-columns: 1fr; }
      button { width: 100%; }
      .grid { grid-template-columns: 1fr; }
      .meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Rend local playback</h1>
      <div id="status" class="status">Idle</div>
    </header>

    <form id="controls">
      <label>
        Asset ID
        <input id="asset-id" name="asset_id" autocomplete="off" spellcheck="false">
      </label>
      <label>
        Dev API key
        <input id="api-key" name="api_key" type="password" autocomplete="off">
      </label>
      <button id="load" type="submit">Load</button>
    </form>

    <div class="grid">
      <section>
        <h2>Player</h2>
        <div class="video-wrap">
          <video id="video" controls playsinline preload="metadata"></video>
        </div>
        <div class="meta">
          <div><span>Asset</span><strong id="meta-asset">-</strong></div>
          <div><span>Source</span><strong id="meta-source">-</strong></div>
          <div><span>Playable</span><strong id="meta-playable">-</strong></div>
          <div><span>Selected</span><strong id="meta-selected">-</strong></div>
        </div>
      </section>

      <section>
        <h2>Bootstrap</h2>
        <pre id="json">{}</pre>
      </section>

      <section>
        <h2>Artifacts</h2>
        <div id="artifacts" class="empty">No asset loaded</div>
      </section>
    </div>
  </main>

  <script>
    const statusEl = document.getElementById("status");
    const form = document.getElementById("controls");
    const assetInput = document.getElementById("asset-id");
    const apiKeyInput = document.getElementById("api-key");
    const loadButton = document.getElementById("load");
    const video = document.getElementById("video");
    const jsonEl = document.getElementById("json");
    const artifactsEl = document.getElementById("artifacts");
    const metaAsset = document.getElementById("meta-asset");
    const metaSource = document.getElementById("meta-source");
    const metaPlayable = document.getElementById("meta-playable");
    const metaSelected = document.getElementById("meta-selected");
    let currentData = null;
    let currentSelection = null;
    let triedOpenerFallback = false;

    const params = new URLSearchParams(window.location.search);
    assetInput.value = params.get("asset_id") || "";
    apiKeyInput.value = window.localStorage.getItem("rend-dev-api-key") || "dev-api-key";

    function setStatus(message, kind = "") {
      statusEl.textContent = message;
      statusEl.className = ["status", kind].filter(Boolean).join(" ");
    }

    function setMeta(data, selectedLabel) {
      metaAsset.textContent = data?.asset_id || "-";
      metaSource.textContent = data?.source_state || "-";
      metaPlayable.textContent = data?.playable_state || "-";
      metaSelected.textContent = selectedLabel || "-";
    }

    function nativeHlsSupported() {
      return Boolean(
        video.canPlayType("application/vnd.apple.mpegurl") ||
          video.canPlayType("application/x-mpegURL")
      );
    }

    function selectedPlayback(data) {
      if (data.manifest_url && nativeHlsSupported()) {
        return { label: "manifest", url: data.manifest_url };
      }
      if (data.opener_url) {
        return { label: "opener", url: data.opener_url };
      }
      if (data.playback_url) {
        return { label: "primary", url: data.playback_url };
      }
      return null;
    }

    function artifactRows(data) {
      const rows = [];
      if (data.playback_url) {
        rows.push({
          label: "primary",
          contentType: data.playback_content_type || "",
          url: data.playback_url,
        });
      }
      if (data.opener_url) {
        rows.push({
          label: "opener",
          contentType: data.opener_content_type || "",
          url: data.opener_url,
        });
      }
      if (data.manifest_url) {
        rows.push({
          label: "manifest",
          contentType: data.manifest_content_type || "",
          url: data.manifest_url,
        });
      }
      for (const hint of data.prefetch_hints || []) {
        rows.push({
          label: hint.artifact_path,
          contentType: hint.content_type || "",
          url: hint.url,
        });
      }
      return rows;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function renderArtifacts(data) {
      const rows = artifactRows(data);
      if (!rows.length) {
        artifactsEl.className = "empty";
        artifactsEl.textContent = "No playback artifacts";
        return;
      }

      artifactsEl.className = "";
      artifactsEl.innerHTML = `
        <table>
          <thead>
            <tr><th>Artifact</th><th>Type</th><th>URL</th></tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => {
                  const label = escapeHtml(row.label);
                  const contentType = escapeHtml(row.contentType);
                  const url = escapeHtml(row.url);
                  return `
                  <tr>
                    <td title="${label}">${label}</td>
                    <td title="${contentType}">${contentType}</td>
                    <td title="${url}"><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></td>
                  </tr>
                `;
                }
              )
              .join("")}
          </tbody>
        </table>
      `;
    }

    async function loadPlayback() {
      const assetId = assetInput.value.trim();
      const apiKey = apiKeyInput.value;
      if (!assetId) {
        setStatus("Asset ID required", "warn");
        assetInput.focus();
        return;
      }
      window.localStorage.setItem("rend-dev-api-key", apiKey);
      loadButton.disabled = true;
      setStatus("Loading");

      try {
        const response = await fetch(`/v1/assets/${encodeURIComponent(assetId)}/playback`, {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text || `HTTP ${response.status}` };
        }

        if (!response.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }

        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("asset_id", assetId);
        window.history.replaceState({}, "", nextUrl);

        jsonEl.textContent = JSON.stringify(data, null, 2);
        renderArtifacts(data);

        const selected = selectedPlayback(data);
        currentData = data;
        currentSelection = selected;
        triedOpenerFallback = false;
        video.removeAttribute("src");
        video.load();
        if (selected) {
          video.src = selected.url;
          video.load();
        }

        setMeta(data, selected?.label || "");
        setStatus(selected ? "Ready" : "No playable artifact", selected ? "ok" : "warn");
      } catch (error) {
        currentData = null;
        currentSelection = null;
        triedOpenerFallback = false;
        video.removeAttribute("src");
        video.load();
        jsonEl.textContent = JSON.stringify({ error: error.message }, null, 2);
        artifactsEl.className = "empty";
        artifactsEl.textContent = "No artifact data";
        setMeta(null, "");
        setStatus(error.message || "Failed", "bad");
      } finally {
        loadButton.disabled = false;
      }
    }

    video.addEventListener("loadedmetadata", () => setStatus("Playable", "ok"));
    video.addEventListener("error", () => {
      if (
        currentSelection?.label === "manifest" &&
        currentData?.opener_url &&
        !triedOpenerFallback
      ) {
        triedOpenerFallback = true;
        currentSelection = { label: "opener", url: currentData.opener_url };
        video.src = currentData.opener_url;
        video.load();
        setMeta(currentData, "opener");
        setStatus("Using opener", "warn");
        return;
      }

      setStatus("Video load failed", "bad");
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void loadPlayback();
    });

    if (assetInput.value) {
      void loadPlayback();
    }
  </script>
</body>
</html>
"##;

#[derive(Clone)]
struct ApiConfig {
    bind_addr: SocketAddr,
    database_url: String,
    redis_url: String,
    object_store_health_url: String,
    dev_api_key: String,
    s3_endpoint: String,
    s3_region: String,
    s3_bucket: String,
    aws_access_key_id: String,
    aws_secret_access_key: String,
    playback_base_url: String,
    playback_token_issuer: PlaybackTokenIssuer,
    playback_bootstrap_prefetch_segments: usize,
    edge_warm: EdgeWarmConfig,
    edge_purge: EdgePurgeConfig,
    media_processing: media::MediaProcessingConfig,
    media_job_max_attempts: i32,
    inline_media_processing: bool,
    media_worker: MediaWorkerConfig,
    auto_migrate: bool,
    request_timeout: Duration,
}

#[derive(Clone)]
struct EdgeWarmConfig {
    url: Option<String>,
    internal_token: String,
    max_artifacts: usize,
}

#[derive(Clone)]
struct EdgePurgeConfig {
    url: Option<String>,
    internal_token: String,
}

#[derive(Clone)]
struct MediaWorkerConfig {
    worker_id: String,
    poll_interval: Duration,
    lock_timeout: Duration,
}

impl ApiConfig {
    fn from_env() -> Result<Self> {
        let dev_api_key = env_string("REND_DEV_API_KEY", "dev-api-key");
        let s3_endpoint = env_string("S3_ENDPOINT", "http://localhost:9100");
        let s3_region = env_string("S3_REGION", "us-east-1");
        let s3_bucket = env_string("S3_BUCKET", "rend-local");
        let aws_access_key_id = env_string("AWS_ACCESS_KEY_ID", "rend_minio");
        let aws_secret_access_key = env_string("AWS_SECRET_ACCESS_KEY", "rend_minio_password");
        let playback_signing_key_id =
            env_string("REND_PLAYBACK_SIGNING_KEY_ID", "local-dev-playback-key");
        let playback_signing_secret = env_string(
            "REND_PLAYBACK_SIGNING_SECRET",
            "local-dev-playback-signing-secret",
        );
        let playback_token_ttl = env_duration_secs("REND_PLAYBACK_TOKEN_TTL_SECS", 900)?;
        let inline_media_processing = env_bool("REND_API_INLINE_MEDIA_PROCESSING", false)?;
        let media_job_max_attempts = env_usize(
            "REND_MEDIA_JOB_MAX_ATTEMPTS",
            DEFAULT_MEDIA_JOB_MAX_ATTEMPTS,
        )?;
        anyhow::ensure!(
            (1..=HARD_MEDIA_JOB_MAX_ATTEMPTS).contains(&media_job_max_attempts),
            "REND_MEDIA_JOB_MAX_ATTEMPTS must be between 1 and {HARD_MEDIA_JOB_MAX_ATTEMPTS}"
        );
        let playback_bootstrap_prefetch_segments = env_usize(
            "REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS",
            DEFAULT_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS,
        )?;
        anyhow::ensure!(
            playback_bootstrap_prefetch_segments <= HARD_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS,
            "REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS must be at most {HARD_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS}"
        );
        let edge_warm_url = optional_env_url("REND_EDGE_WARM_URL");
        let edge_purge_url = optional_env_url("REND_EDGE_PURGE_URL");
        let edge_internal_token = env_string("REND_EDGE_INTERNAL_TOKEN", "dev-internal-token");
        let edge_warm_max_artifacts = env_usize(
            "REND_EDGE_WARM_MAX_ARTIFACTS",
            DEFAULT_EDGE_WARM_MAX_ARTIFACTS,
        )?;
        anyhow::ensure!(
            (1..=HARD_EDGE_WARM_MAX_ARTIFACTS).contains(&edge_warm_max_artifacts),
            "REND_EDGE_WARM_MAX_ARTIFACTS must be between 1 and {HARD_EDGE_WARM_MAX_ARTIFACTS}"
        );
        if edge_warm_url.is_some() || edge_purge_url.is_some() {
            anyhow::ensure!(
                !edge_internal_token.trim().is_empty(),
                "REND_EDGE_INTERNAL_TOKEN must not be empty when an internal edge URL is configured"
            );
        }

        for (key, value) in [
            ("REND_DEV_API_KEY", &dev_api_key),
            ("S3_ENDPOINT", &s3_endpoint),
            ("S3_REGION", &s3_region),
            ("S3_BUCKET", &s3_bucket),
            ("AWS_ACCESS_KEY_ID", &aws_access_key_id),
            ("AWS_SECRET_ACCESS_KEY", &aws_secret_access_key),
        ] {
            anyhow::ensure!(!value.trim().is_empty(), "{key} must not be empty");
        }

        let playback_token_issuer = PlaybackTokenIssuer::new(
            SigningKey::new(
                playback_signing_key_id,
                playback_signing_secret.into_bytes(),
            )?,
            playback_token_ttl,
        )?;

        Ok(Self {
            bind_addr: env_socket_addr("REND_API_BIND_ADDR", "127.0.0.1:4000")?,
            database_url: env_string("DATABASE_URL", "postgres://rend:rend@localhost:5432/rend"),
            redis_url: env_string("REND_REDIS_URL", "redis://localhost:6379"),
            object_store_health_url: env_string(
                "OBJECT_STORE_HEALTH_URL",
                "http://localhost:9100/minio/health/ready",
            ),
            dev_api_key,
            s3_endpoint,
            s3_region,
            s3_bucket,
            aws_access_key_id,
            aws_secret_access_key,
            playback_base_url: env_string("REND_PLAYBACK_BASE_URL", "http://127.0.0.1:4100"),
            playback_token_issuer,
            playback_bootstrap_prefetch_segments,
            edge_warm: EdgeWarmConfig {
                url: edge_warm_url,
                internal_token: edge_internal_token.clone(),
                max_artifacts: edge_warm_max_artifacts,
            },
            edge_purge: EdgePurgeConfig {
                url: edge_purge_url,
                internal_token: edge_internal_token,
            },
            media_processing: media::MediaProcessingConfig {
                ffmpeg_path: env_string("REND_FFMPEG_PATH", "ffmpeg"),
                ffprobe_path: env_string("REND_FFPROBE_PATH", "ffprobe"),
                process_timeout: env_duration_secs("REND_MEDIA_PROCESS_TIMEOUT_SECS", 60)?,
            },
            media_job_max_attempts: i32::try_from(media_job_max_attempts)
                .context("REND_MEDIA_JOB_MAX_ATTEMPTS is too large")?,
            inline_media_processing,
            media_worker: MediaWorkerConfig {
                worker_id: media_worker_id(),
                poll_interval: env_duration_secs("REND_MEDIA_WORKER_POLL_INTERVAL_SECS", 1)?,
                lock_timeout: env_duration_secs("REND_MEDIA_JOB_LOCK_TIMEOUT_SECS", 300)?,
            },
            auto_migrate: env_bool("REND_API_AUTO_MIGRATE", true)?,
            request_timeout: env_duration_secs("REND_HTTP_TIMEOUT_SECS", 120)?,
        })
    }
}

#[derive(Clone)]
struct AppState {
    config: ApiConfig,
    db: PgPool,
    http: reqwest::Client,
    s3: S3Client,
    started_at: Instant,
}

#[derive(Serialize)]
struct HealthResponse<'a> {
    service: &'a str,
    status: &'a str,
    version: &'a str,
    uptime_ms: u128,
}

#[derive(Serialize)]
struct ReadyResponse<'a> {
    service: &'a str,
    status: &'a str,
    checks: Vec<DependencyCheck>,
}

#[derive(Serialize)]
struct DependencyCheck {
    name: &'static str,
    status: &'static str,
    latency_ms: u128,
    message: Option<String>,
}

#[derive(Serialize)]
struct CreateVideoResponse {
    asset_id: String,
    source_state: String,
    playable_state: String,
    source_artifact_id: String,
    source_object_key: String,
    byte_size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    playback_url: Option<String>,
}

#[derive(Serialize)]
struct AssetCurrentResponse {
    asset_id: String,
    source_state: String,
    playable_state: String,
    created_at: String,
    updated_at: String,
    artifacts: Vec<AssetArtifactSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct AssetArtifactSummary {
    kind: String,
    content_type: String,
    byte_size: Option<i64>,
}

#[derive(Serialize)]
struct AssetEventsResponse {
    asset_id: String,
    events: Vec<AssetEventResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_after_sequence: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct AssetEventResponse {
    id: String,
    asset_id: String,
    sequence: i64,
    event_type: String,
    created_at: String,
    metadata: Value,
}

#[derive(Debug, Deserialize)]
struct AssetEventsQuery {
    after_sequence: Option<i64>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct EventStreamQuery {
    asset_id: Option<String>,
    after_sequence: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NormalizedAssetEventsQuery {
    after_sequence: i64,
    limit: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NormalizedEventStreamQuery {
    asset_id: Option<String>,
    after_sequence: i64,
}

#[derive(Serialize)]
struct PlaybackBootstrapResponse {
    asset_id: String,
    source_state: String,
    playable_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    playback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    playback_content_type: Option<String>,
    playback_token_expires_at: u64,
    ttl_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    opener_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    opener_content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest_content_type: Option<String>,
    prefetch_hints: Vec<PlaybackPrefetchHint>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct PlaybackPrefetchHint {
    artifact_path: String,
    url: String,
    content_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AssetPlaybackRecord {
    asset_id: String,
    source_state: String,
    playable_state: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AssetStateRecord {
    asset_id: String,
    source_state: String,
    playable_state: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PlaybackArtifactRecord {
    kind: String,
    object_key: String,
    content_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AssetEventRecord {
    id: String,
    asset_id: String,
    sequence: i64,
    event_type: String,
    created_at: String,
    metadata_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PlaybackArtifact {
    artifact_path: String,
    content_type: String,
}

struct IssuedPlaybackToken {
    token: String,
    expires_at: u64,
    ttl_seconds: u64,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct EdgeWarmRequest {
    asset_id: String,
    artifact_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct EdgeWarmFailure {
    reason: &'static str,
    status: Option<u16>,
    detail: String,
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

struct CountedRequestBody {
    body: Mutex<Pin<Box<Body>>>,
    byte_count: Arc<AtomicU64>,
}

struct EventStreamBody {
    receiver: mpsc::Receiver<Bytes>,
}

#[tokio::main]
async fn main() -> Result<()> {
    load_dotenv();
    init_tracing();
    let command = std::env::args().skip(1).collect::<Vec<_>>();

    let config = ApiConfig::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await
        .context("failed to connect to Postgres")?;

    if config.auto_migrate {
        MIGRATOR
            .run(&db)
            .await
            .context("failed to apply database migrations")?;
    }

    let request_timeout = config.request_timeout;
    let s3 = build_s3_client(&config);
    let state = Arc::new(AppState {
        config,
        db,
        http: reqwest::Client::new(),
        s3,
        started_at: Instant::now(),
    });

    match command.as_slice() {
        [] => {}
        [command, subcommand] if command == "worker" && subcommand == "media" => {
            return run_media_worker(state).await;
        }
        _ => anyhow::bail!("usage: rend-api [worker media]"),
    }

    let app = build_app(state.clone(), request_timeout);

    let listener = TcpListener::bind(state.config.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", state.config.bind_addr))?;

    tracing::info!(addr = %state.config.bind_addr, "rend-api listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("rend-api server failed")
}

async fn run_media_worker(state: Arc<AppState>) -> Result<()> {
    tracing::info!(
        worker_id = %state.config.media_worker.worker_id,
        poll_interval_ms = state.config.media_worker.poll_interval.as_millis(),
        "rend-api media worker listening for queued jobs",
    );

    let mut shutdown = Box::pin(shutdown_signal());
    loop {
        tokio::select! {
            _ = &mut shutdown => {
                tracing::info!(
                    worker_id = %state.config.media_worker.worker_id,
                    "rend-api media worker shutting down",
                );
                break;
            }
            result = process_next_media_job(state.clone()) => {
                match result {
                    Ok(true) => {}
                    Ok(false) => {
                        tokio::select! {
                            _ = &mut shutdown => break,
                            _ = tokio::time::sleep(state.config.media_worker.poll_interval) => {}
                        }
                    }
                    Err(error) => {
                        tracing::error!(
                            worker_id = %state.config.media_worker.worker_id,
                            error = %error,
                            "media worker loop failed",
                        );
                        tokio::select! {
                            _ = &mut shutdown => break,
                            _ = tokio::time::sleep(state.config.media_worker.poll_interval) => {}
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

fn build_app(state: Arc<AppState>, request_timeout: Duration) -> Router {
    let authenticated_routes = Router::new()
        .route("/v1/videos", post(create_video))
        .route("/v1/events", get(get_event_stream))
        .route("/v1/assets/{asset_id}", get(get_asset_current))
        .route("/v1/assets/{asset_id}/events", get(get_asset_events))
        .route("/v1/assets/{asset_id}/playback", get(get_asset_playback))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_dev_api_key,
        ));

    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/healthz", get(healthz))
        .route("/v1/readyz", get(readyz))
        .route("/player", get(player_harness))
        .merge(authenticated_routes)
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &Request<_>| {
                tracing::info_span!(
                    "request",
                    method = %request.method(),
                    path = %request.uri().path()
                )
            }),
        )
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            request_timeout,
        ))
        .with_state(state)
}

fn build_s3_client(config: &ApiConfig) -> S3Client {
    let credentials = Credentials::new(
        config.aws_access_key_id.clone(),
        config.aws_secret_access_key.clone(),
        None,
        None,
        "rend-env",
    );
    let s3_config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(config.s3_region.clone()))
        .credentials_provider(credentials)
        .endpoint_url(config.s3_endpoint.clone())
        .force_path_style(true)
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .build();

    S3Client::from_conf(s3_config)
}

fn optional_env_url(key: &str) -> Option<String> {
    let value = env_string(key, "");
    let value = value.trim().trim_end_matches('/').to_owned();
    (!value.is_empty()).then_some(value)
}

fn media_worker_id() -> String {
    let configured = env_string("REND_MEDIA_WORKER_ID", "");
    let configured = configured.trim();
    if configured.is_empty() {
        format!("rend-api-media-worker-{}", std::process::id())
    } else {
        configured.to_owned()
    }
}

async fn healthz(State(state): State<Arc<AppState>>) -> Json<HealthResponse<'static>> {
    Json(HealthResponse {
        service: "rend-api",
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        uptime_ms: state.started_at.elapsed().as_millis(),
    })
}

async fn player_harness() -> Html<&'static str> {
    Html(PLAYER_HARNESS_HTML)
}

async fn readyz(State(state): State<Arc<AppState>>) -> Response {
    let checks = vec![
        check_postgres(&state).await,
        check_redis(&state).await,
        check_object_store(&state).await,
    ];
    let ready = checks.iter().all(|check| check.status == "ok");
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let body = ReadyResponse {
        service: "rend-api",
        status: if ready { "ready" } else { "not_ready" },
        checks,
    };

    (status, Json(body)).into_response()
}

async fn create_video(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    match create_video_inner(state, headers, body).await {
        Ok(response) => (StatusCode::CREATED, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn get_asset_current(
    State(state): State<Arc<AppState>>,
    AxumPath(asset_id): AxumPath<String>,
) -> Response {
    match get_asset_current_inner(state, asset_id).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn get_asset_current_inner(
    state: Arc<AppState>,
    asset_id: String,
) -> Result<AssetCurrentResponse, AppError> {
    let asset = fetch_asset_state_record(&state.db, &asset_id).await?;
    let artifacts = if asset.is_some() {
        fetch_asset_artifact_summaries(&state.db, &asset_id).await?
    } else {
        Vec::new()
    };

    asset_current_response(asset, artifacts)
}

async fn get_asset_events(
    State(state): State<Arc<AppState>>,
    AxumPath(asset_id): AxumPath<String>,
    Query(query): Query<AssetEventsQuery>,
) -> Response {
    match get_asset_events_inner(state, asset_id, query).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn get_asset_events_inner(
    state: Arc<AppState>,
    asset_id: String,
    query: AssetEventsQuery,
) -> Result<AssetEventsResponse, AppError> {
    let asset_exists = asset_row_exists(&state.db, &asset_id).await?;
    let query = normalize_asset_events_query(query);
    let events = if asset_exists {
        fetch_asset_events(&state.db, &asset_id, query.after_sequence, query.limit).await?
    } else {
        Vec::new()
    };

    asset_events_response(asset_exists, asset_id, events)
}

async fn get_event_stream(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<EventStreamQuery>,
) -> Response {
    match normalize_event_stream_query(&headers, query) {
        Ok(query) => event_stream_response(state, query),
        Err(error) => error.into_response(),
    }
}

async fn get_asset_playback(
    State(state): State<Arc<AppState>>,
    AxumPath(asset_id): AxumPath<String>,
) -> Response {
    match get_asset_playback_inner(state, asset_id).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn get_asset_playback_inner(
    state: Arc<AppState>,
    asset_id: String,
) -> Result<PlaybackBootstrapResponse, AppError> {
    let asset = fetch_asset_playback_record(&state.db, &asset_id).await?;
    let artifacts = if asset.is_some() {
        fetch_playback_artifacts(&state.db, &asset_id).await?
    } else {
        Vec::new()
    };
    let now = current_unix_timestamp().map_err(AppError::internal)?;

    playback_bootstrap_response(
        asset,
        &artifacts,
        &state.config.playback_base_url,
        &state.config.playback_token_issuer,
        state.config.playback_bootstrap_prefetch_segments,
        now,
    )
}

async fn fetch_asset_state_record(
    db: &PgPool,
    asset_id: &str,
) -> Result<Option<AssetStateRecord>, AppError> {
    let row: Option<(String, String, String, String, String)> = sqlx::query_as(
        "
        SELECT id::text,
               source_state,
               playable_state,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
        FROM rend.assets
        WHERE id::text = $1
          AND deleted_at IS NULL
        ",
    )
    .bind(asset_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    Ok(row.map(
        |(asset_id, source_state, playable_state, created_at, updated_at)| AssetStateRecord {
            asset_id,
            source_state,
            playable_state,
            created_at,
            updated_at,
        },
    ))
}

async fn fetch_asset_artifact_summaries(
    db: &PgPool,
    asset_id: &str,
) -> Result<Vec<AssetArtifactSummary>, AppError> {
    let rows: Vec<(String, String, Option<i64>)> = sqlx::query_as(
        "
        SELECT kind, content_type, byte_size
        FROM rend.artifacts
        WHERE asset_id::text = $1
        ORDER BY kind, object_key
        ",
    )
    .bind(asset_id)
    .fetch_all(db)
    .await
    .map_err(AppError::internal)?;

    Ok(rows
        .into_iter()
        .map(|(kind, content_type, byte_size)| AssetArtifactSummary {
            kind,
            content_type,
            byte_size,
        })
        .collect())
}

fn normalize_asset_id(asset_id: &str) -> Result<String, AppError> {
    let asset_id = asset_id.trim();
    if !is_canonical_uuid(asset_id) {
        return Err(AppError::bad_request("malformed asset_id"));
    }

    Ok(asset_id.to_ascii_lowercase())
}

async fn mark_asset_deleted(db: &PgPool, asset_id: &str) -> Result<bool, AppError> {
    let mut tx = db.begin().await.map_err(AppError::internal)?;
    let row: Option<(String, String, bool)> = sqlx::query_as(
        "
        SELECT source_state, playable_state, deleted_at IS NOT NULL
        FROM rend.assets
        WHERE id = $1::uuid
        FOR UPDATE
        ",
    )
    .bind(asset_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::internal)?;

    let Some((source_state, playable_state, already_deleted)) = row else {
        return Err(AppError::not_found("asset not found"));
    };

    if already_deleted {
        tx.commit().await.map_err(AppError::internal)?;
        return Ok(true);
    }

    events::insert_asset_event(
        &mut tx,
        asset_id,
        events::EVENT_ASSET_DELETION_REQUESTED,
        events::asset_deletion_requested_metadata(&source_state, &playable_state),
    )
    .await
    .map_err(AppError::internal)?;

    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'deleted',
            playable_state = 'deleted',
            current_opener_artifact_id = NULL,
            deleted_at = now()
        WHERE id = $1::uuid
        ",
    )
    .bind(asset_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;

    events::insert_asset_event(
        &mut tx,
        asset_id,
        events::EVENT_ASSET_DELETED,
        events::asset_deleted_metadata(&source_state, &playable_state),
    )
    .await
    .map_err(AppError::internal)?;

    tx.commit().await.map_err(AppError::internal)?;
    Ok(false)
}

async fn asset_row_exists(db: &PgPool, asset_id: &str) -> Result<bool, AppError> {
    let exists: bool = sqlx::query_scalar(
        "
        SELECT EXISTS (
          SELECT 1
          FROM rend.assets
          WHERE id::text = $1
        )
        ",
    )
    .bind(asset_id)
    .fetch_one(db)
    .await
    .map_err(AppError::internal)?;

    Ok(exists)
}

async fn fetch_asset_events(
    db: &PgPool,
    asset_id: &str,
    after_sequence: i64,
    limit: usize,
) -> Result<Vec<AssetEventRecord>, AppError> {
    let limit = i64::try_from(limit).map_err(AppError::internal)?;
    let rows: Vec<(String, String, i64, String, String, String)> = sqlx::query_as(
        "
        SELECT id::text,
               asset_id::text,
               sequence,
               event_type,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               metadata::text
        FROM rend.asset_events
        WHERE asset_id::text = $1
          AND sequence > $2
        ORDER BY sequence
        LIMIT $3
        ",
    )
    .bind(asset_id)
    .bind(after_sequence)
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(AppError::internal)?;

    Ok(rows
        .into_iter()
        .map(
            |(id, asset_id, sequence, event_type, created_at, metadata_json)| AssetEventRecord {
                id,
                asset_id,
                sequence,
                event_type,
                created_at,
                metadata_json,
            },
        )
        .collect())
}

async fn fetch_event_stream_batch(
    db: &PgPool,
    asset_id: Option<&str>,
    after_sequence: i64,
) -> Result<Vec<AssetEventRecord>, AppError> {
    let limit = i64::try_from(DEFAULT_EVENT_STREAM_BATCH_LIMIT).map_err(AppError::internal)?;
    let rows: Vec<(String, String, i64, String, String, String)> = if let Some(asset_id) = asset_id
    {
        sqlx::query_as(
            "
            SELECT id::text,
                   asset_id::text,
                   sequence,
                   event_type,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                   metadata::text
            FROM rend.asset_events
            WHERE asset_id::text = $1
              AND sequence > $2
            ORDER BY sequence
            LIMIT $3
            ",
        )
        .bind(asset_id)
        .bind(after_sequence)
        .bind(limit)
        .fetch_all(db)
        .await
        .map_err(AppError::internal)?
    } else {
        sqlx::query_as(
            "
            SELECT id::text,
                   asset_id::text,
                   sequence,
                   event_type,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                   metadata::text
            FROM rend.asset_events
            WHERE sequence > $1
            ORDER BY sequence
            LIMIT $2
            ",
        )
        .bind(after_sequence)
        .bind(limit)
        .fetch_all(db)
        .await
        .map_err(AppError::internal)?
    };

    let query = NormalizedEventStreamQuery {
        asset_id: asset_id.map(str::to_owned),
        after_sequence,
    };

    Ok(rows
        .into_iter()
        .map(
            |(id, asset_id, sequence, event_type, created_at, metadata_json)| AssetEventRecord {
                id,
                asset_id,
                sequence,
                event_type,
                created_at,
                metadata_json,
            },
        )
        .filter(|record| event_stream_record_matches(record, &query))
        .collect())
}

async fn fetch_asset_playback_record(
    db: &PgPool,
    asset_id: &str,
) -> Result<Option<AssetPlaybackRecord>, AppError> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "
        SELECT id::text, source_state, playable_state
        FROM rend.assets
        WHERE id::text = $1
          AND deleted_at IS NULL
        ",
    )
    .bind(asset_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    Ok(row.map(
        |(asset_id, source_state, playable_state)| AssetPlaybackRecord {
            asset_id,
            source_state,
            playable_state,
        },
    ))
}

async fn fetch_playback_artifacts(
    db: &PgPool,
    asset_id: &str,
) -> Result<Vec<PlaybackArtifactRecord>, AppError> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "
        SELECT kind, object_key, content_type
        FROM rend.artifacts
        WHERE asset_id::text = $1
          AND kind IN ('opener', 'manifest', 'segment')
        ORDER BY kind, object_key
        ",
    )
    .bind(asset_id)
    .fetch_all(db)
    .await
    .map_err(AppError::internal)?;

    Ok(rows
        .into_iter()
        .map(|(kind, object_key, content_type)| PlaybackArtifactRecord {
            kind,
            object_key,
            content_type,
        })
        .collect())
}

fn asset_current_response(
    asset: Option<AssetStateRecord>,
    artifacts: Vec<AssetArtifactSummary>,
) -> Result<AssetCurrentResponse, AppError> {
    let asset = asset.ok_or_else(|| AppError::not_found("asset not found"))?;

    Ok(AssetCurrentResponse {
        asset_id: asset.asset_id,
        source_state: asset.source_state,
        playable_state: asset.playable_state,
        created_at: asset.created_at,
        updated_at: asset.updated_at,
        artifacts,
    })
}

fn normalize_asset_events_query(query: AssetEventsQuery) -> NormalizedAssetEventsQuery {
    NormalizedAssetEventsQuery {
        after_sequence: query.after_sequence.unwrap_or(0).max(0),
        limit: query
            .limit
            .unwrap_or(DEFAULT_ASSET_EVENTS_LIMIT)
            .clamp(1, MAX_ASSET_EVENTS_LIMIT),
    }
}

fn normalize_event_stream_query(
    headers: &HeaderMap,
    query: EventStreamQuery,
) -> Result<NormalizedEventStreamQuery, AppError> {
    let asset_id = match query.asset_id {
        Some(asset_id) => {
            let asset_id = asset_id.trim();
            if !is_canonical_uuid(asset_id) {
                return Err(AppError::bad_request("malformed asset_id"));
            }
            Some(asset_id.to_ascii_lowercase())
        }
        None => None,
    };

    let after_sequence = match headers.get("last-event-id") {
        Some(value) => {
            let value = value.to_str().map_err(|_| AppError {
                status: StatusCode::BAD_REQUEST,
                message: "invalid Last-Event-ID".to_owned(),
            })?;
            parse_event_stream_cursor(value, "Last-Event-ID")?
        }
        None => match query.after_sequence {
            Some(value) => parse_event_stream_cursor(&value, "after_sequence")?,
            None => 0,
        },
    };

    Ok(NormalizedEventStreamQuery {
        asset_id,
        after_sequence,
    })
}

fn parse_event_stream_cursor(value: &str, field: &str) -> Result<i64, AppError> {
    let cursor = value.trim().parse::<i64>().map_err(|_| AppError {
        status: StatusCode::BAD_REQUEST,
        message: format!("invalid {field}"),
    })?;
    if cursor < 0 {
        return Err(AppError {
            status: StatusCode::BAD_REQUEST,
            message: format!("invalid {field}"),
        });
    }

    Ok(cursor)
}

fn is_canonical_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }

    value.bytes().enumerate().all(|(index, byte)| {
        matches!(index, 8 | 13 | 18 | 23) && byte == b'-'
            || !matches!(index, 8 | 13 | 18 | 23) && byte.is_ascii_hexdigit()
    })
}

fn asset_events_response(
    asset_exists: bool,
    asset_id: String,
    mut records: Vec<AssetEventRecord>,
) -> Result<AssetEventsResponse, AppError> {
    if !asset_exists {
        return Err(AppError::not_found("asset not found"));
    }

    records.sort_by_key(|record| record.sequence);
    let mut events = Vec::with_capacity(records.len());
    for record in records {
        let metadata = serde_json::from_str(&record.metadata_json).map_err(AppError::internal)?;
        events.push(AssetEventResponse {
            id: record.id,
            asset_id: record.asset_id,
            sequence: record.sequence,
            event_type: record.event_type,
            created_at: record.created_at,
            metadata,
        });
    }
    let next_after_sequence = events.last().map(|event| event.sequence);

    Ok(AssetEventsResponse {
        asset_id,
        events,
        next_after_sequence,
    })
}

fn event_stream_response(state: Arc<AppState>, query: NormalizedEventStreamQuery) -> Response {
    let (sender, receiver) = mpsc::channel(EVENT_STREAM_CHANNEL_CAPACITY);
    let db = state.db.clone();
    tokio::spawn(async move {
        stream_event_lifecycle(db, query, sender).await;
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header(header::CONNECTION, "keep-alive")
        .header("x-accel-buffering", "no")
        .body(Body::new(EventStreamBody { receiver }))
        .expect("SSE response builder should be valid")
}

async fn stream_event_lifecycle(
    db: PgPool,
    query: NormalizedEventStreamQuery,
    sender: mpsc::Sender<Bytes>,
) {
    let mut cursor = query.after_sequence;
    let mut last_heartbeat = Instant::now();

    if sender
        .send(Bytes::from_static(b": connected\n\n"))
        .await
        .is_err()
    {
        return;
    }

    loop {
        match fetch_event_stream_batch(&db, query.asset_id.as_deref(), cursor).await {
            Ok(records) if !records.is_empty() => {
                for record in records {
                    cursor = record.sequence;
                    match sse_frame(&record) {
                        Ok(frame) => {
                            if sender.send(frame).await.is_err() {
                                return;
                            }
                        }
                        Err(error) => {
                            tracing::warn!(
                                event_id = %record.id,
                                sequence = record.sequence,
                                error = %error.message,
                                "failed to serialize lifecycle SSE event",
                            );
                        }
                    }
                }
                continue;
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(
                    asset_id = query.asset_id.as_deref().unwrap_or("*"),
                    after_sequence = cursor,
                    error = %error.message,
                    "failed to fetch lifecycle SSE events",
                );
            }
        }

        if last_heartbeat.elapsed() >= EVENT_STREAM_HEARTBEAT_INTERVAL {
            if sender
                .send(Bytes::from_static(b": heartbeat\n\n"))
                .await
                .is_err()
            {
                return;
            }
            last_heartbeat = Instant::now();
        }

        tokio::time::sleep(EVENT_STREAM_POLL_INTERVAL).await;
    }
}

fn event_stream_record_matches(
    record: &AssetEventRecord,
    query: &NormalizedEventStreamQuery,
) -> bool {
    record.sequence > query.after_sequence
        && query
            .asset_id
            .as_deref()
            .is_none_or(|asset_id| record.asset_id == asset_id)
}

fn sse_frame(record: &AssetEventRecord) -> Result<Bytes, AppError> {
    let payload = external_safe_asset_event_response(record)?;
    let data = serde_json::to_string(&payload).map_err(AppError::internal)?;

    Ok(Bytes::from(format!(
        "id: {}\nevent: {}\ndata: {}\n\n",
        record.sequence, record.event_type, data
    )))
}

fn external_safe_asset_event_response(
    record: &AssetEventRecord,
) -> Result<AssetEventResponse, AppError> {
    let metadata = serde_json::from_str(&record.metadata_json).map_err(AppError::internal)?;

    Ok(AssetEventResponse {
        id: record.id.clone(),
        asset_id: record.asset_id.clone(),
        sequence: record.sequence,
        event_type: record.event_type.clone(),
        created_at: record.created_at.clone(),
        metadata: external_safe_metadata(metadata),
    })
}

fn external_safe_metadata(metadata: Value) -> Value {
    match metadata {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .filter_map(|(key, value)| {
                    is_external_safe_key(&key).then(|| (key, external_safe_metadata(value)))
                })
                .collect(),
        ),
        Value::Array(values) => {
            Value::Array(values.into_iter().map(external_safe_metadata).collect())
        }
        Value::String(value) => {
            if is_external_safe_string(&value) {
                Value::String(value)
            } else {
                Value::String("[redacted]".to_owned())
            }
        }
        value => value,
    }
}

fn is_external_safe_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ![
        "token",
        "secret",
        "credential",
        "authorization",
        "playback_url",
        "signed_url",
    ]
    .iter()
    .any(|fragment| key.contains(fragment))
}

fn is_external_safe_string(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    ![
        "?token=",
        "bearer ",
        "secret",
        "credential",
        "authorization",
    ]
    .iter()
    .any(|fragment| value.contains(fragment))
}

fn playback_bootstrap_response(
    asset: Option<AssetPlaybackRecord>,
    artifacts: &[PlaybackArtifactRecord],
    playback_base_url: &str,
    issuer: &PlaybackTokenIssuer,
    prefetch_segment_limit: usize,
    now: u64,
) -> Result<PlaybackBootstrapResponse, AppError> {
    let asset = asset.ok_or_else(|| AppError::not_found("asset not found"))?;
    if !matches!(asset.playable_state.as_str(), "opener_ready" | "hls_ready") {
        return Err(AppError::not_found("asset is not playable yet"));
    }

    let playback_artifacts = playback_artifacts(&asset.asset_id, artifacts);
    let opener_artifact = find_playback_artifact(&playback_artifacts, "opener.mp4").cloned();
    let manifest_artifact = (asset.playable_state == "hls_ready")
        .then(|| find_playback_artifact(&playback_artifacts, "hls/master.m3u8").cloned())
        .flatten();
    let primary_artifact = primary_playback_artifact(
        &asset.playable_state,
        opener_artifact.as_ref(),
        manifest_artifact.as_ref(),
    );
    if primary_artifact.is_none() {
        return Err(AppError::not_found("asset is not playable yet"));
    }

    let token = issue_playback_token(issuer, &asset.asset_id, now).map_err(AppError::internal)?;
    let (playback_url, playback_content_type) = signed_artifact_fields(
        playback_base_url,
        &asset.asset_id,
        primary_artifact,
        &token.token,
    );
    let (opener_url, opener_content_type) = signed_artifact_fields(
        playback_base_url,
        &asset.asset_id,
        opener_artifact.as_ref(),
        &token.token,
    );
    let (manifest_url, manifest_content_type) = signed_artifact_fields(
        playback_base_url,
        &asset.asset_id,
        manifest_artifact.as_ref(),
        &token.token,
    );
    let prefetch_hints = if asset.playable_state == "hls_ready" {
        first_segment_prefetch_hints(
            playback_base_url,
            &asset.asset_id,
            &playback_artifacts,
            &token.token,
            prefetch_segment_limit,
        )
    } else {
        Vec::new()
    };

    Ok(PlaybackBootstrapResponse {
        asset_id: asset.asset_id,
        source_state: asset.source_state,
        playable_state: asset.playable_state,
        playback_url,
        playback_content_type,
        playback_token_expires_at: token.expires_at,
        ttl_seconds: token.ttl_seconds,
        opener_url,
        opener_content_type,
        manifest_url,
        manifest_content_type,
        prefetch_hints,
    })
}

fn playback_artifacts(asset_id: &str, records: &[PlaybackArtifactRecord]) -> Vec<PlaybackArtifact> {
    let mut artifacts = records
        .iter()
        .filter_map(|record| playback_artifact_from_record(asset_id, record))
        .collect::<Vec<_>>();
    artifacts.sort_by(|left, right| left.artifact_path.cmp(&right.artifact_path));
    artifacts
}

fn playback_artifact_from_record(
    asset_id: &str,
    record: &PlaybackArtifactRecord,
) -> Option<PlaybackArtifact> {
    let object_prefix = format!("videos/{asset_id}/");
    let artifact_path = record.object_key.strip_prefix(&object_prefix)?;

    let is_supported = match record.kind.as_str() {
        "opener" => artifact_path == "opener.mp4",
        "manifest" => artifact_path == "hls/master.m3u8",
        "segment" => artifact_path
            .strip_prefix("hls/")
            .is_some_and(is_valid_hls_segment_name),
        _ => false,
    };

    is_supported.then(|| PlaybackArtifact {
        artifact_path: artifact_path.to_owned(),
        content_type: record.content_type.clone(),
    })
}

fn find_playback_artifact<'a>(
    artifacts: &'a [PlaybackArtifact],
    artifact_path: &str,
) -> Option<&'a PlaybackArtifact> {
    artifacts
        .iter()
        .find(|artifact| artifact.artifact_path == artifact_path)
}

fn primary_playback_artifact<'a>(
    playable_state: &str,
    opener_artifact: Option<&'a PlaybackArtifact>,
    manifest_artifact: Option<&'a PlaybackArtifact>,
) -> Option<&'a PlaybackArtifact> {
    match playable_state {
        "hls_ready" => manifest_artifact.or(opener_artifact),
        "opener_ready" => opener_artifact,
        _ => None,
    }
}

fn signed_artifact_fields(
    playback_base_url: &str,
    asset_id: &str,
    artifact: Option<&PlaybackArtifact>,
    token: &str,
) -> (Option<String>, Option<String>) {
    let Some(artifact) = artifact else {
        return (None, None);
    };

    (
        Some(signed_artifact_url(
            playback_base_url,
            asset_id,
            &artifact.artifact_path,
            token,
        )),
        Some(artifact.content_type.clone()),
    )
}

fn first_segment_prefetch_hints(
    playback_base_url: &str,
    asset_id: &str,
    artifacts: &[PlaybackArtifact],
    token: &str,
    limit: usize,
) -> Vec<PlaybackPrefetchHint> {
    artifacts
        .iter()
        .filter(|artifact| is_hls_segment_artifact_path(&artifact.artifact_path))
        .take(limit)
        .map(|artifact| PlaybackPrefetchHint {
            artifact_path: artifact.artifact_path.clone(),
            url: signed_artifact_url(playback_base_url, asset_id, &artifact.artifact_path, token),
            content_type: artifact.content_type.clone(),
        })
        .collect()
}

fn issue_playback_token(
    issuer: &PlaybackTokenIssuer,
    asset_id: &str,
    now: u64,
) -> Result<IssuedPlaybackToken, PlaybackAuthError> {
    let ttl_seconds = issuer.ttl().as_secs();
    let expires_at = now
        .checked_add(ttl_seconds)
        .ok_or(PlaybackAuthError::InvalidTtl)?;
    let token = issuer.issue_asset_playback_token(asset_id, now)?;

    Ok(IssuedPlaybackToken {
        token,
        expires_at,
        ttl_seconds,
    })
}

fn signed_artifact_url(base_url: &str, asset_id: &str, artifact_path: &str, token: &str) -> String {
    format!(
        "{}/v/{asset_id}/{artifact_path}?token={token}",
        base_url.trim_end_matches('/')
    )
}

async fn create_video_inner(
    state: Arc<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Result<CreateVideoResponse, AppError> {
    let content_type = request_content_type(&headers);
    let content_length = request_content_length(&headers)?;
    let mut tx = state.db.begin().await.map_err(AppError::internal)?;
    let asset_id: String = sqlx::query_scalar(
        "
        INSERT INTO rend.assets (source_state, playable_state)
        VALUES ('uploading', 'not_playable')
        RETURNING id::text
        ",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    events::insert_asset_event(
        &mut tx,
        &asset_id,
        events::EVENT_ASSET_CREATED,
        events::asset_created_metadata("uploading", "not_playable"),
    )
    .await
    .map_err(AppError::internal)?;
    events::insert_asset_event(
        &mut tx,
        &asset_id,
        events::EVENT_SOURCE_UPLOAD_STARTED,
        events::source_upload_started_metadata(&content_type, content_length),
    )
    .await
    .map_err(AppError::internal)?;
    tx.commit().await.map_err(AppError::internal)?;

    let source_object_key = source_object_key(&asset_id);
    let byte_count = Arc::new(AtomicU64::new(0));
    let upload_body = counted_body_stream(body, byte_count.clone());
    let mut put_object = state
        .s3
        .put_object()
        .bucket(&state.config.s3_bucket)
        .key(&source_object_key)
        .content_type(content_type.clone())
        .body(upload_body);

    if let Some(content_length) = content_length {
        put_object = put_object.content_length(content_length);
    }

    if let Err(error) = put_object.send().await {
        mark_asset_failed(&state, &asset_id).await;
        return Err(AppError::storage(error));
    }

    let byte_size = i64::try_from(byte_count.load(Ordering::Relaxed)).map_err(|_| AppError {
        status: StatusCode::PAYLOAD_TOO_LARGE,
        message: "uploaded body is too large".to_owned(),
    })?;

    let mut tx = state.db.begin().await.map_err(AppError::internal)?;
    let source_artifact_id: String = sqlx::query_scalar(
        "
        INSERT INTO rend.artifacts (asset_id, kind, object_key, content_type, byte_size)
        VALUES ($1::uuid, 'source', $2, $3, $4)
        RETURNING id::text
        ",
    )
    .bind(&asset_id)
    .bind(&source_object_key)
    .bind(&content_type)
    .bind(byte_size)
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::internal)?;

    events::insert_asset_event(
        &mut tx,
        &asset_id,
        events::EVENT_SOURCE_UPLOADED,
        events::source_uploaded_metadata(&content_type, byte_size),
    )
    .await
    .map_err(AppError::internal)?;

    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'uploaded', playable_state = 'not_playable'
        WHERE id = $1::uuid
        ",
    )
    .bind(&asset_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;

    if !state.config.inline_media_processing {
        let media_job_id = jobs::enqueue_media_processing_job(
            &mut tx,
            &asset_id,
            state.config.media_job_max_attempts,
        )
        .await
        .map_err(AppError::internal)?;
        events::insert_asset_event(
            &mut tx,
            &asset_id,
            events::EVENT_MEDIA_PROCESSING_QUEUED,
            events::media_processing_queued_metadata(
                &media_job_id,
                state.config.media_job_max_attempts,
            ),
        )
        .await
        .map_err(AppError::internal)?;
        events::insert_asset_event(
            &mut tx,
            &asset_id,
            events::EVENT_UPLOAD_RESPONSE_READY,
            events::upload_response_ready_metadata("uploaded", "not_playable", byte_size),
        )
        .await
        .map_err(AppError::internal)?;
        tx.commit().await.map_err(AppError::internal)?;

        return Ok(CreateVideoResponse {
            asset_id,
            source_state: "uploaded".to_owned(),
            playable_state: "not_playable".to_owned(),
            source_artifact_id,
            source_object_key,
            byte_size,
            playback_url: None,
        });
    }

    tx.commit().await.map_err(AppError::internal)?;

    events::insert_asset_event_pool(
        &state.db,
        &asset_id,
        events::EVENT_MEDIA_PROCESSING_STARTED,
        events::media_processing_started_metadata("uploaded", "not_playable"),
    )
    .await
    .map_err(AppError::internal)?;

    let media_outcome = media::process_uploaded_source(media::ProcessMediaRequest {
        asset_id: asset_id.clone(),
        source_object_key: source_object_key.clone(),
        s3_bucket: state.config.s3_bucket.clone(),
        s3: state.s3.clone(),
        db: state.db.clone(),
        config: state.config.media_processing.clone(),
    })
    .await
    .map_err(AppError::internal)?;

    let (source_state, playable_state): (String, String) = sqlx::query_as(
        "
        SELECT source_state, playable_state
        FROM rend.assets
        WHERE id = $1::uuid
        ",
    )
    .bind(&asset_id)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::internal)?;

    if playable_state != media_outcome.playable_state {
        tracing::warn!(
            asset_id,
            expected_playable_state = %media_outcome.playable_state,
            actual_playable_state = %playable_state,
            "asset playable state differed after media processing",
        );
    }

    maybe_warm_edge(
        Some(&state.db),
        &state.http,
        &state.config.edge_warm,
        &asset_id,
        &playable_state,
        &media_outcome.playback_artifact_paths,
    )
    .await;

    let now = current_unix_timestamp().map_err(AppError::internal)?;
    let playback_url = playback_url(
        &state.config.playback_base_url,
        &asset_id,
        &playable_state,
        &state.config.playback_token_issuer,
        now,
    )
    .map_err(AppError::internal)?;

    events::insert_asset_event_pool(
        &state.db,
        &asset_id,
        events::EVENT_UPLOAD_RESPONSE_READY,
        events::upload_response_ready_metadata(&source_state, &playable_state, byte_size),
    )
    .await
    .map_err(AppError::internal)?;

    Ok(CreateVideoResponse {
        asset_id: asset_id.clone(),
        source_state,
        playable_state,
        source_artifact_id,
        source_object_key,
        byte_size,
        playback_url,
    })
}

async fn process_next_media_job(state: Arc<AppState>) -> Result<bool> {
    let Some(job) = jobs::claim_next_media_job(
        &state.db,
        &state.config.media_worker.worker_id,
        state.config.media_worker.lock_timeout,
    )
    .await
    .context("failed to claim media job")?
    else {
        return Ok(false);
    };

    process_media_job(&state, job).await;
    Ok(true)
}

async fn process_media_job(state: &AppState, job: jobs::MediaJob) {
    tracing::info!(
        job_id = %job.id,
        asset_id = %job.asset_id,
        attempt = job.attempts,
        max_attempts = job.max_attempts,
        worker_id = %state.config.media_worker.worker_id,
        "media worker claimed job",
    );

    match process_media_job_inner(state, &job).await {
        Ok(()) => {
            if let Err(error) = jobs::mark_media_job_succeeded(&state.db, &job.id).await {
                tracing::error!(
                    job_id = %job.id,
                    asset_id = %job.asset_id,
                    error = %error,
                    "failed to mark media job succeeded",
                );
            }
        }
        Err(error) => {
            handle_media_job_failure(state, &job, error).await;
        }
    }
}

async fn process_media_job_inner(state: &AppState, job: &jobs::MediaJob) -> Result<()> {
    if asset_is_deleted_or_missing(&state.db, &job.asset_id).await? {
        tracing::info!(
            job_id = %job.id,
            asset_id = %job.asset_id,
            "media job asset is deleted or missing",
        );
        return Ok(());
    }

    if asset_is_already_playable(&state.db, &job.asset_id).await? {
        tracing::info!(
            job_id = %job.id,
            asset_id = %job.asset_id,
            "media job asset is already playable",
        );
        return Ok(());
    }

    mark_asset_media_processing_started(&state.db, &job.asset_id)
        .await
        .context("failed to mark asset media processing started")?;
    let source_object_key = fetch_source_object_key(&state.db, &job.asset_id)
        .await
        .context("failed to fetch source artifact for media job")?;
    let outcome = media::try_process_uploaded_source(&media::ProcessMediaRequest {
        asset_id: job.asset_id.clone(),
        source_object_key,
        s3_bucket: state.config.s3_bucket.clone(),
        s3: state.s3.clone(),
        db: state.db.clone(),
        config: state.config.media_processing.clone(),
    })
    .await?;

    maybe_warm_edge(
        Some(&state.db),
        &state.http,
        &state.config.edge_warm,
        &job.asset_id,
        &outcome.playable_state,
        &outcome.playback_artifact_paths,
    )
    .await;

    Ok(())
}

async fn handle_media_job_failure(state: &AppState, job: &jobs::MediaJob, error: anyhow::Error) {
    let last_error = bounded_error_message(&error);
    let final_attempt = jobs::is_final_attempt(job.attempts, job.max_attempts);
    record_media_processing_failed_event(
        &state.db,
        &job.asset_id,
        job.attempts,
        job.max_attempts,
        final_attempt,
        &last_error,
    )
    .await;

    if final_attempt {
        if let Err(error) = media::set_asset_media_failed(&state.db, &job.asset_id).await {
            tracing::error!(
                job_id = %job.id,
                asset_id = %job.asset_id,
                error = %error,
                "failed to mark asset media processing failed",
            );
        }
        if let Err(error) = jobs::mark_media_job_failed(&state.db, &job.id, &last_error).await {
            tracing::error!(
                job_id = %job.id,
                asset_id = %job.asset_id,
                error = %error,
                "failed to mark media job failed",
            );
        }
        return;
    }

    if let Err(error) = mark_asset_media_processing_retryable(&state.db, &job.asset_id).await {
        tracing::warn!(
            job_id = %job.id,
            asset_id = %job.asset_id,
            error = %error,
            "failed to reset asset state before media retry",
        );
    }
    if let Err(error) = jobs::mark_media_job_retryable(
        &state.db,
        &job.id,
        &last_error,
        jobs::retry_backoff(job.attempts),
    )
    .await
    {
        tracing::error!(
            job_id = %job.id,
            asset_id = %job.asset_id,
            error = %error,
            "failed to requeue media job",
        );
    }
}

async fn asset_is_already_playable(db: &PgPool, asset_id: &str) -> Result<bool> {
    let playable_state: Option<String> = sqlx::query_scalar(
        "
        SELECT playable_state
        FROM rend.assets
        WHERE id = $1::uuid
          AND deleted_at IS NULL
        ",
    )
    .bind(asset_id)
    .fetch_optional(db)
    .await?;

    Ok(matches!(
        playable_state.as_deref(),
        Some("opener_ready" | "hls_ready")
    ))
}

async fn fetch_source_object_key(db: &PgPool, asset_id: &str) -> Result<String> {
    let object_key: Option<String> = sqlx::query_scalar(
        "
        SELECT object_key
        FROM rend.artifacts
        WHERE asset_id = $1::uuid
          AND kind = 'source'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        ",
    )
    .bind(asset_id)
    .fetch_optional(db)
    .await?;

    object_key.ok_or_else(|| anyhow::anyhow!("source artifact is missing"))
}

async fn mark_asset_media_processing_started(db: &PgPool, asset_id: &str) -> Result<bool> {
    let mut tx = db.begin().await?;
    let row: Option<(String, bool)> = sqlx::query_as(
        "
        SELECT playable_state, deleted_at IS NOT NULL
        FROM rend.assets
        WHERE id = $1::uuid
        FOR UPDATE
        ",
    )
    .bind(asset_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((playable_state, deleted)) = row else {
        tx.commit().await?;
        return Ok(false);
    };

    if deleted {
        tx.commit().await?;
        return Ok(false);
    }

    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'processing'
        WHERE id = $1::uuid
          AND deleted_at IS NULL
        ",
    )
    .bind(asset_id)
    .execute(&mut *tx)
    .await?;

    events::insert_asset_event(
        &mut tx,
        asset_id,
        events::EVENT_MEDIA_PROCESSING_STARTED,
        events::media_processing_started_metadata("processing", &playable_state),
    )
    .await?;

    tx.commit().await?;
    Ok(true)
}

async fn mark_asset_media_processing_retryable(db: &PgPool, asset_id: &str) -> Result<()> {
    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'uploaded',
            playable_state = 'not_playable'
        WHERE id = $1::uuid
          AND playable_state = 'not_playable'
          AND deleted_at IS NULL
        ",
    )
    .bind(asset_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn record_media_processing_failed_event(
    db: &PgPool,
    asset_id: &str,
    attempt: i32,
    max_attempts: i32,
    final_attempt: bool,
    reason: &str,
) {
    if let Err(error) = events::insert_asset_event_pool(
        db,
        asset_id,
        events::EVENT_MEDIA_PROCESSING_FAILED,
        events::media_processing_failed_metadata(attempt, max_attempts, final_attempt, reason),
    )
    .await
    {
        tracing::warn!(
            asset_id,
            error = %error,
            "failed to record media processing failure event",
        );
    }
}

fn counted_body_stream(body: Body, byte_count: Arc<AtomicU64>) -> ByteStream {
    ByteStream::from_body_1_x(CountedRequestBody {
        body: Mutex::new(Box::pin(body)),
        byte_count,
    })
}

fn request_content_type(headers: &HeaderMap) -> String {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("application/octet-stream")
        .to_owned()
}

fn request_content_length(headers: &HeaderMap) -> Result<Option<i64>, AppError> {
    let Some(value) = headers.get(header::CONTENT_LENGTH) else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|_| AppError {
        status: StatusCode::BAD_REQUEST,
        message: "invalid content-length".to_owned(),
    })?;
    let size = value.parse::<u64>().map_err(|_| AppError {
        status: StatusCode::BAD_REQUEST,
        message: "invalid content-length".to_owned(),
    })?;
    let size = i64::try_from(size).map_err(|_| AppError {
        status: StatusCode::PAYLOAD_TOO_LARGE,
        message: "request body is too large".to_owned(),
    })?;

    Ok(Some(size))
}

fn source_object_key(asset_id: &str) -> String {
    format!("videos/{asset_id}/source")
}

fn playback_url(
    base_url: &str,
    asset_id: &str,
    playable_state: &str,
    issuer: &PlaybackTokenIssuer,
    now: u64,
) -> Result<Option<String>, PlaybackAuthError> {
    let Some(artifact_path) = playback_artifact_path(playable_state) else {
        return Ok(None);
    };
    let token = issue_playback_token(issuer, asset_id, now)?;

    Ok(Some(signed_artifact_url(
        base_url,
        asset_id,
        artifact_path,
        &token.token,
    )))
}

fn playback_artifact_path(playable_state: &str) -> Option<&'static str> {
    match playable_state {
        "hls_ready" => Some("hls/master.m3u8"),
        "opener_ready" => Some("opener.mp4"),
        _ => None,
    }
}

async fn maybe_warm_edge(
    db: Option<&PgPool>,
    http: &reqwest::Client,
    config: &EdgeWarmConfig,
    asset_id: &str,
    playable_state: &str,
    generated_artifact_paths: &[String],
) {
    let Some(request) =
        edge_warm_request(config, asset_id, playable_state, generated_artifact_paths)
    else {
        return;
    };

    if let Some(db) = db {
        record_edge_warm_event(
            db,
            asset_id,
            events::EVENT_EDGE_WARMING_ATTEMPTED,
            events::edge_warming_metadata(&request.artifact_paths),
        )
        .await;
    }

    match send_edge_warm_request(http, config, &request).await {
        Ok(()) => {
            if let Some(db) = db {
                record_edge_warm_event(
                    db,
                    asset_id,
                    events::EVENT_EDGE_WARMING_SUCCEEDED,
                    events::edge_warming_metadata(&request.artifact_paths),
                )
                .await;
            }
        }
        Err(error) => {
            if let Some(db) = db {
                record_edge_warm_event(
                    db,
                    asset_id,
                    events::EVENT_EDGE_WARMING_FAILED,
                    events::edge_warming_failed_metadata(
                        &request.artifact_paths,
                        error.reason,
                        error.status,
                    ),
                )
                .await;
            }
            tracing::warn!(
                asset_id,
                error = %error,
                "edge warm request failed; upload remains playable",
            );
        }
    }
}

async fn record_edge_warm_event(db: &PgPool, asset_id: &str, event_type: &str, metadata: Value) {
    if let Err(error) = events::insert_asset_event_pool(db, asset_id, event_type, metadata).await {
        tracing::warn!(
            asset_id,
            event_type,
            error = %error,
            "failed to record edge warm lifecycle event",
        );
    }
}

fn edge_warm_request(
    config: &EdgeWarmConfig,
    asset_id: &str,
    playable_state: &str,
    generated_artifact_paths: &[String],
) -> Option<EdgeWarmRequest> {
    config.url.as_ref()?;
    let artifact_paths = edge_warm_artifact_paths(
        playable_state,
        generated_artifact_paths,
        config.max_artifacts,
    );
    (!artifact_paths.is_empty()).then(|| EdgeWarmRequest {
        asset_id: asset_id.to_owned(),
        artifact_paths,
    })
}

fn edge_warm_artifact_paths(
    playable_state: &str,
    generated_artifact_paths: &[String],
    max_artifacts: usize,
) -> Vec<String> {
    if max_artifacts == 0 {
        return Vec::new();
    }

    let mut artifact_paths = Vec::new();
    match playable_state {
        "opener_ready" => {
            push_unique_artifact_path(&mut artifact_paths, "opener.mp4");
        }
        "hls_ready" => {
            push_unique_artifact_path(&mut artifact_paths, "opener.mp4");
            push_unique_artifact_path(&mut artifact_paths, "hls/master.m3u8");

            let mut segments = generated_artifact_paths
                .iter()
                .filter(|path| is_hls_segment_artifact_path(path))
                .cloned()
                .collect::<Vec<_>>();
            segments.sort();
            for segment in segments {
                push_unique_artifact_path(&mut artifact_paths, &segment);
                if artifact_paths.len() >= max_artifacts {
                    break;
                }
            }
        }
        _ => {}
    }

    artifact_paths.truncate(max_artifacts);
    artifact_paths
}

fn push_unique_artifact_path(paths: &mut Vec<String>, path: &str) {
    if !paths.iter().any(|existing| existing == path) {
        paths.push(path.to_owned());
    }
}

fn is_hls_segment_artifact_path(path: &str) -> bool {
    path.strip_prefix("hls/")
        .is_some_and(is_valid_hls_segment_name)
}

async fn send_edge_warm_request(
    http: &reqwest::Client,
    config: &EdgeWarmConfig,
    request: &EdgeWarmRequest,
) -> std::result::Result<(), EdgeWarmFailure> {
    let Some(url) = config.url.as_deref() else {
        return Ok(());
    };

    let response = http
        .post(url)
        .header("x-rend-internal-token", &config.internal_token)
        .json(request)
        .send()
        .await
        .map_err(|error| EdgeWarmFailure::request(error.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }

    let body = response
        .text()
        .await
        .unwrap_or_else(|error| format!("failed to read warm response body: {error}"));

    Err(EdgeWarmFailure::status(
        status.as_u16(),
        format!(
            "edge warm endpoint returned {status}: {}",
            limit_log_body(&body)
        ),
    ))
}

async fn maybe_purge_edge(
    db: &PgPool,
    http: &reqwest::Client,
    config: &EdgePurgeConfig,
    asset_id: &str,
    artifact_paths: Option<Vec<String>>,
) -> bool {
    let Some(_url) = config.url.as_deref() else {
        return false;
    };

    let request = EdgePurgeRequest {
        asset_id: asset_id.to_owned(),
        artifact_paths,
    };
    let artifact_paths = request.artifact_paths.as_deref();

    record_edge_purge_event(
        db,
        asset_id,
        events::EVENT_EDGE_PURGE_ATTEMPTED,
        events::edge_purge_attempted_metadata(artifact_paths),
    )
    .await;

    match send_edge_purge_request(http, config, &request).await {
        Ok(response) => {
            record_edge_purge_event(
                db,
                asset_id,
                events::EVENT_EDGE_PURGE_SUCCEEDED,
                events::edge_purge_succeeded_metadata(
                    artifact_paths,
                    response.purged.len(),
                    response.missing.len(),
                    response.rejected.len(),
                    response.errors.len(),
                ),
            )
            .await;
        }
        Err(error) => {
            record_edge_purge_event(
                db,
                asset_id,
                events::EVENT_EDGE_PURGE_FAILED,
                events::edge_purge_failed_metadata(artifact_paths, error.reason, error.status),
            )
            .await;
            tracing::warn!(
                asset_id,
                error = %error,
                "edge purge request failed; asset deletion remains committed",
            );
        }
    }

    true
}

async fn record_edge_purge_event(db: &PgPool, asset_id: &str, event_type: &str, metadata: Value) {
    if let Err(error) = events::insert_asset_event_pool(db, asset_id, event_type, metadata).await {
        tracing::warn!(
            asset_id,
            event_type,
            error = %error,
            "failed to record edge purge lifecycle event",
        );
    }
}

async fn send_edge_purge_request(
    http: &reqwest::Client,
    config: &EdgePurgeConfig,
    request: &EdgePurgeRequest,
) -> std::result::Result<EdgePurgeResponse, EdgePurgeFailure> {
    let Some(url) = config.url.as_deref() else {
        return Ok(EdgePurgeResponse::default());
    };

    let response = http
        .post(url)
        .header("x-rend-internal-token", &config.internal_token)
        .json(request)
        .send()
        .await
        .map_err(|error| EdgePurgeFailure::request(error.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return response
            .json::<EdgePurgeResponse>()
            .await
            .map_err(|error| EdgePurgeFailure::request(error.to_string()));
    }

    let body = response
        .text()
        .await
        .unwrap_or_else(|error| format!("failed to read purge response body: {error}"));

    Err(EdgePurgeFailure::status(
        status.as_u16(),
        format!(
            "edge purge endpoint returned {status}: {}",
            limit_log_body(&body)
        ),
    ))
}

fn limit_log_body(body: &str) -> String {
    if body.len() > EDGE_WARM_LOG_BODY_LIMIT_BYTES {
        let mut end = EDGE_WARM_LOG_BODY_LIMIT_BYTES;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...[truncated]", &body[..end])
    } else {
        body.to_owned()
    }
}

fn bounded_error_message(error: &anyhow::Error) -> String {
    let message = format!("{error:#}");
    if message.len() > MEDIA_JOB_LAST_ERROR_LIMIT_BYTES {
        let mut end = MEDIA_JOB_LAST_ERROR_LIMIT_BYTES;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...[truncated]", &message[..end])
    } else {
        message
    }
}

async fn mark_asset_failed(state: &AppState, asset_id: &str) {
    if let Err(error) = sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'failed', playable_state = 'not_playable'
        WHERE id = $1::uuid
        ",
    )
    .bind(asset_id)
    .execute(&state.db)
    .await
    {
        tracing::warn!(asset_id, error = %error, "failed to mark asset upload as failed");
    }
}

async fn require_dev_api_key(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if is_authorized(request.headers(), &state.config.dev_api_key) {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "unauthorized".to_owned(),
            }),
        )
            .into_response()
    }
}

fn is_authorized(headers: &HeaderMap, api_key: &str) -> bool {
    if api_key.is_empty() {
        return false;
    }

    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == api_key)
}

async fn check_postgres(state: &AppState) -> DependencyCheck {
    let started = Instant::now();
    match sqlx::query("select 1").execute(&state.db).await {
        Ok(_) => ok_check("postgres", started),
        Err(error) => failed_check("postgres", started, error),
    }
}

async fn check_redis(state: &AppState) -> DependencyCheck {
    let started = Instant::now();
    let result = async {
        let client = redis::Client::open(state.config.redis_url.as_str())?;
        let mut connection = client.get_multiplexed_async_connection().await?;
        let pong: String = redis::cmd("PING").query_async(&mut connection).await?;
        anyhow::ensure!(pong == "PONG", "unexpected Redis response: {pong}");
        Ok::<_, anyhow::Error>(())
    }
    .await;

    match result {
        Ok(()) => ok_check("redis", started),
        Err(error) => failed_check("redis", started, error),
    }
}

async fn check_object_store(state: &AppState) -> DependencyCheck {
    let started = Instant::now();
    let result = state
        .http
        .get(&state.config.object_store_health_url)
        .send()
        .await
        .and_then(|response| response.error_for_status());

    match result {
        Ok(_) => ok_check("object_store", started),
        Err(error) => failed_check("object_store", started, error),
    }
}

fn ok_check(name: &'static str, started: Instant) -> DependencyCheck {
    DependencyCheck {
        name,
        status: "ok",
        latency_ms: started.elapsed().as_millis(),
        message: None,
    }
}

fn failed_check(
    name: &'static str,
    started: Instant,
    error: impl std::fmt::Display,
) -> DependencyCheck {
    DependencyCheck {
        name,
        status: "error",
        latency_ms: started.elapsed().as_millis(),
        message: Some(error.to_string()),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("rend_api=info,tower_http=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "rend-api request failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "internal server error".to_owned(),
        }
    }

    fn storage(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "failed to store source object");
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: "failed to store source object".to_owned(),
        }
    }
}

impl EdgeWarmFailure {
    fn request(detail: String) -> Self {
        Self {
            reason: "request_failed",
            status: None,
            detail,
        }
    }

    fn status(status: u16, detail: String) -> Self {
        Self {
            reason: "status_error",
            status: Some(status),
            detail,
        }
    }
}

impl std::fmt::Display for EdgeWarmFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.detail.fmt(formatter)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: self.message,
            }),
        )
            .into_response()
    }
}

impl HttpBody for CountedRequestBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        let Ok(mut body) = this.body.lock() else {
            return Poll::Ready(Some(Err(std::io::Error::other(
                "request body lock poisoned",
            ))));
        };

        match body.as_mut().poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(bytes) = frame.data_ref() {
                    this.byte_count
                        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(error))) => {
                Poll::Ready(Some(Err(std::io::Error::other(error.to_string()))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl HttpBody for EventStreamBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        match Pin::new(&mut this.receiver).poll_recv(cx) {
            Poll::Ready(Some(bytes)) => Poll::Ready(Some(Ok(Frame::data(bytes)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::HeaderValue};
    use rend_playback_auth::{POLICY_ASSET_PLAYBACK_V1, decode_unverified_claims};
    use std::sync::atomic::AtomicUsize;
    use tower::ServiceExt;

    const NOW: u64 = 1_800_000_000;

    #[derive(Clone)]
    struct WarmRecorder {
        count: Arc<AtomicUsize>,
        last_token: Arc<Mutex<Option<String>>>,
        last_request: Arc<Mutex<Option<EdgeWarmRequest>>>,
        status: StatusCode,
    }

    async fn record_warm(
        State(recorder): State<WarmRecorder>,
        headers: HeaderMap,
        Json(request): Json<EdgeWarmRequest>,
    ) -> Response {
        recorder.count.fetch_add(1, Ordering::SeqCst);
        let token = headers
            .get("x-rend-internal-token")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        *recorder.last_token.lock().unwrap() = token;
        *recorder.last_request.lock().unwrap() = Some(request);

        recorder.status.into_response()
    }

    async fn spawn_warm_recorder(status: StatusCode) -> (String, WarmRecorder) {
        let recorder = WarmRecorder {
            count: Arc::new(AtomicUsize::new(0)),
            last_token: Arc::new(Mutex::new(None)),
            last_request: Arc::new(Mutex::new(None)),
            status,
        };
        let app = Router::new()
            .route("/internal/warm", post(record_warm))
            .with_state(recorder.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        (format!("http://{addr}/internal/warm"), recorder)
    }

    fn test_issuer() -> PlaybackTokenIssuer {
        PlaybackTokenIssuer::new(
            SigningKey::new("kid-a", b"test-playback-secret".to_vec()).unwrap(),
            Duration::from_secs(600),
        )
        .unwrap()
    }

    fn test_config() -> ApiConfig {
        ApiConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            database_url: "postgres://rend:rend@localhost:5432/rend".to_owned(),
            redis_url: "redis://localhost:6379".to_owned(),
            object_store_health_url: "http://localhost:9100/minio/health/ready".to_owned(),
            dev_api_key: "dev-secret".to_owned(),
            s3_endpoint: "http://localhost:9100".to_owned(),
            s3_region: "us-east-1".to_owned(),
            s3_bucket: "rend-local".to_owned(),
            aws_access_key_id: "test".to_owned(),
            aws_secret_access_key: "test".to_owned(),
            playback_base_url: "http://127.0.0.1:4100".to_owned(),
            playback_token_issuer: test_issuer(),
            playback_bootstrap_prefetch_segments: DEFAULT_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS,
            edge_warm: EdgeWarmConfig {
                url: None,
                internal_token: "internal".to_owned(),
                max_artifacts: DEFAULT_EDGE_WARM_MAX_ARTIFACTS,
            },
            media_processing: media::MediaProcessingConfig {
                ffmpeg_path: "ffmpeg".to_owned(),
                ffprobe_path: "ffprobe".to_owned(),
                process_timeout: Duration::from_secs(60),
            },
            media_job_max_attempts: 3,
            inline_media_processing: false,
            media_worker: MediaWorkerConfig {
                worker_id: "test-worker".to_owned(),
                poll_interval: Duration::from_secs(1),
                lock_timeout: Duration::from_secs(300),
            },
            auto_migrate: false,
            request_timeout: Duration::from_secs(10),
        }
    }

    fn test_state() -> Arc<AppState> {
        let config = test_config();
        let db = PgPoolOptions::new()
            .connect_lazy(&config.database_url)
            .unwrap();
        let s3 = build_s3_client(&config);

        Arc::new(AppState {
            config,
            db,
            http: reqwest::Client::new(),
            s3,
            started_at: Instant::now(),
        })
    }

    fn asset_record(playable_state: &str) -> AssetPlaybackRecord {
        AssetPlaybackRecord {
            asset_id: "asset-123".to_owned(),
            source_state: "uploaded".to_owned(),
            playable_state: playable_state.to_owned(),
        }
    }

    fn asset_state_record(playable_state: &str) -> AssetStateRecord {
        AssetStateRecord {
            asset_id: "asset-123".to_owned(),
            source_state: "uploaded".to_owned(),
            playable_state: playable_state.to_owned(),
            created_at: "2026-06-13T12:00:00.000Z".to_owned(),
            updated_at: "2026-06-13T12:01:00.000Z".to_owned(),
        }
    }

    fn artifact_record(
        kind: impl Into<String>,
        object_key: impl Into<String>,
        content_type: impl Into<String>,
    ) -> PlaybackArtifactRecord {
        PlaybackArtifactRecord {
            kind: kind.into(),
            object_key: object_key.into(),
            content_type: content_type.into(),
        }
    }

    fn event_record(sequence: i64, event_type: &str) -> AssetEventRecord {
        event_record_for_asset("asset-123", sequence, event_type)
    }

    fn event_record_for_asset(asset_id: &str, sequence: i64, event_type: &str) -> AssetEventRecord {
        AssetEventRecord {
            id: format!("event-{sequence}"),
            asset_id: asset_id.to_owned(),
            sequence,
            event_type: event_type.to_owned(),
            created_at: "2026-06-13T12:00:00.000Z".to_owned(),
            metadata_json: r#"{"ok":true}"#.to_owned(),
        }
    }

    fn hls_artifact_records() -> Vec<PlaybackArtifactRecord> {
        vec![
            artifact_record("opener", "videos/asset-123/opener.mp4", "video/mp4"),
            artifact_record(
                "manifest",
                "videos/asset-123/hls/master.m3u8",
                "application/vnd.apple.mpegurl",
            ),
            artifact_record(
                "segment",
                "videos/asset-123/hls/segment_00002.ts",
                "video/mp2t",
            ),
            artifact_record(
                "segment",
                "videos/asset-123/hls/segment_00000.ts",
                "video/mp2t",
            ),
            artifact_record(
                "segment",
                "videos/asset-123/hls/segment_00001.ts",
                "video/mp2t",
            ),
        ]
    }

    async fn route_response(app: Router, path: &str, auth: Option<&str>) -> Response {
        let mut builder = Request::builder().method("GET").uri(path);
        if let Some(auth) = auth {
            builder = builder.header(header::AUTHORIZATION, auth);
        }

        app.oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[test]
    fn bearer_authorization_accepts_matching_dev_key() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer dev-secret"),
        );

        assert!(is_authorized(&headers, "dev-secret"));
    }

    #[test]
    fn bearer_authorization_rejects_missing_or_wrong_key() {
        assert!(!is_authorized(&HeaderMap::new(), "dev-secret"));

        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer wrong-secret"),
        );

        assert!(!is_authorized(&headers, "dev-secret"));
    }

    #[tokio::test]
    async fn playback_bootstrap_endpoint_requires_dev_api_key() {
        let app = build_app(test_state(), Duration::from_secs(10));

        let response = route_response(app.clone(), "/v1/assets/asset-123/playback", None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = route_response(
            app,
            "/v1/assets/asset-123/playback",
            Some("Bearer wrong-secret"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn current_asset_endpoint_requires_dev_api_key() {
        let app = build_app(test_state(), Duration::from_secs(10));

        let response = route_response(app.clone(), "/v1/assets/asset-123", None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response =
            route_response(app, "/v1/assets/asset-123", Some("Bearer wrong-secret")).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn asset_events_endpoint_requires_dev_api_key() {
        let app = build_app(test_state(), Duration::from_secs(10));

        let response = route_response(app.clone(), "/v1/assets/asset-123/events", None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = route_response(
            app,
            "/v1/assets/asset-123/events",
            Some("Bearer wrong-secret"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn event_stream_endpoint_requires_dev_api_key() {
        let app = build_app(test_state(), Duration::from_secs(10));

        let response = route_response(app.clone(), "/v1/events", None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = route_response(app, "/v1/events", Some("Bearer wrong-secret")).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn current_asset_unknown_asset_returns_404() {
        let Err(error) = asset_current_response(None, Vec::new()) else {
            panic!("unknown asset unexpectedly returned current state JSON");
        };

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.message, "asset not found");
    }

    #[test]
    fn current_asset_returns_artifact_summary() {
        let response = asset_current_response(
            Some(asset_state_record("hls_ready")),
            vec![
                AssetArtifactSummary {
                    kind: "opener".to_owned(),
                    content_type: "video/mp4".to_owned(),
                    byte_size: Some(123),
                },
                AssetArtifactSummary {
                    kind: "manifest".to_owned(),
                    content_type: "application/vnd.apple.mpegurl".to_owned(),
                    byte_size: Some(456),
                },
            ],
        )
        .unwrap();

        assert_eq!(response.asset_id, "asset-123");
        assert_eq!(response.source_state, "uploaded");
        assert_eq!(response.playable_state, "hls_ready");
        assert_eq!(response.artifacts.len(), 2);
        assert_eq!(response.artifacts[0].kind, "opener");
        assert_eq!(response.artifacts[0].content_type, "video/mp4");
        assert_eq!(response.artifacts[0].byte_size, Some(123));
    }

    #[test]
    fn delete_asset_normalizes_uuid_and_rejects_malformed_id() {
        assert_eq!(
            normalize_asset_id("00000000-0000-0000-0000-000000000ABC").unwrap(),
            "00000000-0000-0000-0000-000000000abc"
        );

        let Err(error) = normalize_asset_id("not-a-uuid") else {
            panic!("malformed asset id unexpectedly normalized");
        };
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.message, "malformed asset_id");
    }

    #[test]
    fn asset_events_unknown_asset_returns_404() {
        let Err(error) = asset_events_response(false, "asset-123".to_owned(), Vec::new()) else {
            panic!("unknown asset unexpectedly returned lifecycle events");
        };

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.message, "asset not found");
    }

    #[test]
    fn asset_events_response_orders_by_sequence() {
        let response = asset_events_response(
            true,
            "asset-123".to_owned(),
            vec![
                event_record(3, events::EVENT_SOURCE_UPLOADED),
                event_record(1, events::EVENT_ASSET_CREATED),
                event_record(2, events::EVENT_SOURCE_UPLOAD_STARTED),
            ],
        )
        .unwrap();

        let sequences = response
            .events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>();
        assert_eq!(sequences, vec![1, 2, 3]);
        assert_eq!(response.next_after_sequence, Some(3));
    }

    #[test]
    fn asset_events_query_clamps_after_sequence_and_limit() {
        assert_eq!(
            normalize_asset_events_query(AssetEventsQuery {
                after_sequence: Some(-10),
                limit: Some(0),
            }),
            NormalizedAssetEventsQuery {
                after_sequence: 0,
                limit: 1,
            }
        );
        assert_eq!(
            normalize_asset_events_query(AssetEventsQuery {
                after_sequence: Some(12),
                limit: Some(MAX_ASSET_EVENTS_LIMIT + 500),
            }),
            NormalizedAssetEventsQuery {
                after_sequence: 12,
                limit: MAX_ASSET_EVENTS_LIMIT,
            }
        );
    }

    #[test]
    fn event_stream_query_uses_after_sequence() {
        let query = normalize_event_stream_query(
            &HeaderMap::new(),
            EventStreamQuery {
                asset_id: None,
                after_sequence: Some("12".to_owned()),
            },
        )
        .unwrap();

        assert_eq!(query.after_sequence, 12);
        assert_eq!(query.asset_id, None);
    }

    #[test]
    fn event_stream_last_event_id_takes_precedence() {
        let mut headers = HeaderMap::new();
        headers.insert("last-event-id", HeaderValue::from_static("20"));

        let query = normalize_event_stream_query(
            &headers,
            EventStreamQuery {
                asset_id: None,
                after_sequence: Some("12".to_owned()),
            },
        )
        .unwrap();

        assert_eq!(query.after_sequence, 20);
    }

    #[test]
    fn event_stream_rejects_invalid_cursor_and_asset_id() {
        let Err(error) = normalize_event_stream_query(
            &HeaderMap::new(),
            EventStreamQuery {
                asset_id: None,
                after_sequence: Some("not-a-sequence".to_owned()),
            },
        ) else {
            panic!("invalid cursor unexpectedly parsed");
        };
        assert_eq!(error.status, StatusCode::BAD_REQUEST);

        let Err(error) = normalize_event_stream_query(
            &HeaderMap::new(),
            EventStreamQuery {
                asset_id: Some("not-a-uuid".to_owned()),
                after_sequence: None,
            },
        ) else {
            panic!("invalid asset_id unexpectedly parsed");
        };
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn event_stream_sse_frame_uses_sequence_id_and_event_type_name() {
        let record = event_record(42, events::EVENT_SOURCE_UPLOADED);
        let frame = sse_frame(&record).unwrap();
        let frame = std::str::from_utf8(&frame).unwrap();

        assert!(frame.starts_with("id: 42\nevent: source.uploaded\ndata: "));
        assert!(frame.ends_with("\n\n"));

        let data = frame
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let payload: Value = serde_json::from_str(data).unwrap();
        assert_eq!(payload["id"], "event-42");
        assert_eq!(payload["asset_id"], "asset-123");
        assert_eq!(payload["sequence"], 42);
        assert_eq!(payload["event_type"], events::EVENT_SOURCE_UPLOADED);
        assert_eq!(payload["created_at"], "2026-06-13T12:00:00.000Z");
        assert_eq!(payload["metadata"], serde_json::json!({"ok": true}));
    }

    #[test]
    fn event_stream_after_sequence_and_asset_id_filter_exclude_records() {
        let query = NormalizedEventStreamQuery {
            asset_id: Some("asset-123".to_owned()),
            after_sequence: 10,
        };

        assert!(event_stream_record_matches(
            &event_record_for_asset("asset-123", 11, events::EVENT_SOURCE_UPLOADED),
            &query
        ));
        assert!(!event_stream_record_matches(
            &event_record_for_asset("asset-123", 10, events::EVENT_SOURCE_UPLOADED),
            &query
        ));
        assert!(!event_stream_record_matches(
            &event_record_for_asset(
                "00000000-0000-0000-0000-000000000000",
                11,
                events::EVENT_SOURCE_UPLOADED,
            ),
            &query
        ));
    }

    #[test]
    fn event_stream_metadata_is_external_safe() {
        let mut record = event_record(7, events::EVENT_ARTIFACT_GENERATED);
        record.metadata_json = serde_json::json!({
            "kind": "opener",
            "artifact_path": "opener.mp4",
            "playback_url": "http://edge.local/v/asset/opener.mp4?token=abc",
            "nested": {
                "authorization": "Bearer abc",
                "reason": "safe failure reason",
                "credential_hint": "do not leak",
            },
            "messages": [
                "plain",
                "signed url had ?token=abc"
            ]
        })
        .to_string();

        let frame = sse_frame(&record).unwrap();
        let frame = std::str::from_utf8(&frame).unwrap();
        let data = frame
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let encoded = data.to_ascii_lowercase();

        for forbidden in [
            "playback_url",
            "?token=",
            "bearer ",
            "authorization",
            "credential",
        ] {
            assert!(!encoded.contains(forbidden), "{forbidden}");
        }
        assert!(encoded.contains("opener.mp4"));
        assert!(encoded.contains("[redacted]"));
    }

    #[test]
    fn upload_media_flow_records_required_lifecycle_event_types() {
        let artifacts = vec![
            events::ArtifactEventInput {
                kind: "opener",
                object_key: "videos/asset-123/opener.mp4",
                content_type: "video/mp4",
                byte_size: 100,
            },
            events::ArtifactEventInput {
                kind: "manifest",
                object_key: "videos/asset-123/hls/master.m3u8",
                content_type: "application/vnd.apple.mpegurl",
                byte_size: 50,
            },
            events::ArtifactEventInput {
                kind: "segment",
                object_key: "videos/asset-123/hls/segment_00000.ts",
                content_type: "video/mp2t",
                byte_size: 25,
            },
        ];
        let artifact_events = events::artifact_generated_events("asset-123", &artifacts);
        let mut event_types = vec![
            events::EVENT_ASSET_CREATED,
            events::EVENT_SOURCE_UPLOAD_STARTED,
            events::EVENT_SOURCE_UPLOADED,
            events::EVENT_MEDIA_PROCESSING_QUEUED,
            events::EVENT_UPLOAD_RESPONSE_READY,
            events::EVENT_MEDIA_PROCESSING_STARTED,
        ];
        event_types.extend(artifact_events.iter().map(|event| event.event_type));
        event_types.extend([
            events::EVENT_PLAYABLE_STATE_CHANGED,
            events::EVENT_EDGE_WARMING_ATTEMPTED,
            events::EVENT_EDGE_WARMING_SUCCEEDED,
            events::EVENT_UPLOAD_RESPONSE_READY,
            events::EVENT_ASSET_DELETION_REQUESTED,
            events::EVENT_ASSET_DELETED,
            events::EVENT_EDGE_PURGE_ATTEMPTED,
            events::EVENT_EDGE_PURGE_SUCCEEDED,
        ]);

        for required in [
            events::EVENT_ASSET_CREATED,
            events::EVENT_SOURCE_UPLOAD_STARTED,
            events::EVENT_SOURCE_UPLOADED,
            events::EVENT_MEDIA_PROCESSING_QUEUED,
            events::EVENT_UPLOAD_RESPONSE_READY,
            events::EVENT_MEDIA_PROCESSING_STARTED,
            events::EVENT_ARTIFACT_GENERATED,
            events::EVENT_PLAYABLE_STATE_CHANGED,
            events::EVENT_EDGE_WARMING_ATTEMPTED,
            events::EVENT_EDGE_WARMING_SUCCEEDED,
            events::EVENT_ASSET_DELETION_REQUESTED,
            events::EVENT_ASSET_DELETED,
            events::EVENT_EDGE_PURGE_ATTEMPTED,
            events::EVENT_EDGE_PURGE_SUCCEEDED,
        ] {
            assert!(event_types.contains(&required), "{required}");
        }
    }

    #[test]
    fn playback_bootstrap_unknown_asset_returns_404() {
        let result =
            playback_bootstrap_response(None, &[], "http://127.0.0.1:4100", &test_issuer(), 2, NOW);
        let Err(error) = result else {
            panic!("unknown asset unexpectedly returned bootstrap JSON");
        };

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.message, "asset not found");
    }

    #[test]
    fn playback_bootstrap_not_playable_asset_returns_404() {
        let result = playback_bootstrap_response(
            Some(asset_record("not_playable")),
            &[],
            "http://127.0.0.1:4100",
            &test_issuer(),
            2,
            NOW,
        );
        let Err(error) = result else {
            panic!("not playable asset unexpectedly returned bootstrap JSON");
        };

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.message, "asset is not playable yet");
    }

    #[test]
    fn playback_bootstrap_ready_asset_without_artifact_returns_404() {
        let result = playback_bootstrap_response(
            Some(asset_record("opener_ready")),
            &[],
            "http://127.0.0.1:4100",
            &test_issuer(),
            2,
            NOW,
        );
        let Err(error) = result else {
            panic!("ready asset without artifacts unexpectedly returned bootstrap JSON");
        };

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.message, "asset is not playable yet");
    }

    #[test]
    fn playback_bootstrap_hls_ready_returns_manifest_opener_and_segment_hints() {
        let response = playback_bootstrap_response(
            Some(asset_record("hls_ready")),
            &hls_artifact_records(),
            "http://127.0.0.1:4100/",
            &test_issuer(),
            2,
            NOW,
        )
        .unwrap();

        assert_eq!(response.asset_id, "asset-123");
        assert_eq!(response.source_state, "uploaded");
        assert_eq!(response.playable_state, "hls_ready");
        assert_eq!(response.ttl_seconds, 600);
        assert_eq!(response.playback_token_expires_at, NOW + 600);
        assert_eq!(response.playback_url, response.manifest_url);
        assert_eq!(
            response.playback_content_type.as_deref(),
            Some("application/vnd.apple.mpegurl")
        );
        assert_eq!(
            response.opener_url.as_deref().map(url_without_token),
            Some("http://127.0.0.1:4100/v/asset-123/opener.mp4".to_owned())
        );
        assert_eq!(response.opener_content_type.as_deref(), Some("video/mp4"));
        assert_eq!(
            response.manifest_url.as_deref().map(url_without_token),
            Some("http://127.0.0.1:4100/v/asset-123/hls/master.m3u8".to_owned())
        );
        assert_eq!(response.prefetch_hints.len(), 2);
        assert_eq!(
            response.prefetch_hints[0].artifact_path,
            "hls/segment_00000.ts"
        );
        assert_eq!(response.prefetch_hints[0].content_type, "video/mp2t");
        assert_eq!(
            response.prefetch_hints[1].artifact_path,
            "hls/segment_00001.ts"
        );
    }

    #[test]
    fn playback_bootstrap_opener_ready_returns_opener_primary_without_manifest() {
        let response = playback_bootstrap_response(
            Some(asset_record("opener_ready")),
            &hls_artifact_records(),
            "http://127.0.0.1:4100",
            &test_issuer(),
            2,
            NOW,
        )
        .unwrap();

        assert_eq!(
            response.playback_url.as_deref().map(url_without_token),
            Some("http://127.0.0.1:4100/v/asset-123/opener.mp4".to_owned())
        );
        assert_eq!(response.playback_content_type.as_deref(), Some("video/mp4"));
        assert!(response.manifest_url.is_none());
        assert!(response.manifest_content_type.is_none());
        assert!(response.prefetch_hints.is_empty());
    }

    #[test]
    fn playback_bootstrap_urls_use_signed_edge_playback_shape() {
        let response = playback_bootstrap_response(
            Some(asset_record("hls_ready")),
            &hls_artifact_records(),
            "http://edge.local",
            &test_issuer(),
            1,
            NOW,
        )
        .unwrap();
        let playback_url = response.playback_url.as_deref().unwrap();
        let (path, token) = playback_url.split_once("?token=").unwrap();
        let claims = decode_unverified_claims(token).unwrap();

        assert_eq!(path, "http://edge.local/v/asset-123/hls/master.m3u8");
        assert_eq!(claims.asset_id, "asset-123");
        assert_eq!(claims.exp, NOW + 600);
        assert_eq!(claims.kid, "kid-a");
        assert_eq!(claims.policy, POLICY_ASSET_PLAYBACK_V1);
    }

    #[test]
    fn playback_bootstrap_prefetch_hints_are_bounded() {
        let response = playback_bootstrap_response(
            Some(asset_record("hls_ready")),
            &hls_artifact_records(),
            "http://edge.local",
            &test_issuer(),
            1,
            NOW,
        )
        .unwrap();

        assert_eq!(response.prefetch_hints.len(), 1);
        assert_eq!(
            response.prefetch_hints[0].artifact_path,
            "hls/segment_00000.ts"
        );
    }

    #[test]
    fn source_object_key_is_deterministic_and_internal() {
        assert_eq!(
            source_object_key("asset-123"),
            "videos/asset-123/source".to_owned()
        );
    }

    #[test]
    fn playback_url_uses_signed_hls_edge_shape() {
        let issuer = PlaybackTokenIssuer::new(
            SigningKey::new("kid-a", b"test-playback-secret".to_vec()).unwrap(),
            Duration::from_secs(600),
        )
        .unwrap();
        let url = playback_url(
            "http://127.0.0.1:4100/",
            "asset-123",
            "hls_ready",
            &issuer,
            1_800_000_000,
        )
        .unwrap()
        .unwrap();
        let (path, token) = url.split_once("?token=").unwrap();
        let claims = decode_unverified_claims(token).unwrap();

        assert_eq!(path, "http://127.0.0.1:4100/v/asset-123/hls/master.m3u8");
        assert_eq!(claims.asset_id, "asset-123");
        assert_eq!(claims.exp, 1_800_000_600);
        assert_eq!(claims.kid, "kid-a");
        assert_eq!(claims.policy, POLICY_ASSET_PLAYBACK_V1);
    }

    #[test]
    fn playback_url_is_absent_until_playable() {
        let issuer = PlaybackTokenIssuer::new(
            SigningKey::new("kid-a", b"test-playback-secret".to_vec()).unwrap(),
            Duration::from_secs(600),
        )
        .unwrap();
        let url = playback_url(
            "http://127.0.0.1:4100/",
            "asset-123",
            "not_playable",
            &issuer,
            1_800_000_000,
        )
        .unwrap();

        assert_eq!(url, None);
    }

    #[test]
    fn edge_warm_request_is_absent_when_warm_url_is_unconfigured() {
        let config = EdgeWarmConfig {
            url: None,
            internal_token: "internal".to_owned(),
            max_artifacts: 4,
        };
        let generated = vec!["hls/segment_00000.ts".to_owned()];

        assert!(edge_warm_request(&config, "asset-123", "hls_ready", &generated).is_none());
    }

    #[test]
    fn edge_warm_artifact_paths_select_opener_manifest_and_first_segments() {
        let generated = vec![
            "hls/segment_00002.ts".to_owned(),
            "hls/segment_00000.ts".to_owned(),
            "thumbnail.jpg".to_owned(),
            "hls/segment_00001.ts".to_owned(),
        ];

        assert_eq!(
            edge_warm_artifact_paths("hls_ready", &generated, 4),
            vec![
                "opener.mp4".to_owned(),
                "hls/master.m3u8".to_owned(),
                "hls/segment_00000.ts".to_owned(),
                "hls/segment_00001.ts".to_owned(),
            ]
        );
    }

    #[test]
    fn edge_warm_artifact_paths_skip_unplayable_states() {
        assert!(edge_warm_artifact_paths("failed", &[], 4).is_empty());
        assert!(edge_warm_artifact_paths("not_playable", &[], 4).is_empty());
    }

    #[tokio::test]
    async fn maybe_warm_edge_posts_when_configured_and_uses_internal_token() {
        let (url, recorder) = spawn_warm_recorder(StatusCode::OK).await;
        let config = EdgeWarmConfig {
            url: Some(url),
            internal_token: "warm-secret".to_owned(),
            max_artifacts: 3,
        };
        let generated = vec![
            "hls/segment_00001.ts".to_owned(),
            "hls/segment_00000.ts".to_owned(),
        ];

        maybe_warm_edge(
            None,
            &reqwest::Client::new(),
            &config,
            "asset-123",
            "hls_ready",
            &generated,
        )
        .await;

        assert_eq!(recorder.count.load(Ordering::SeqCst), 1);
        assert_eq!(
            recorder.last_token.lock().unwrap().as_deref(),
            Some("warm-secret")
        );
        let request = recorder.last_request.lock().unwrap().clone().unwrap();
        assert_eq!(request.asset_id, "asset-123");
        assert_eq!(
            request.artifact_paths,
            vec![
                "opener.mp4".to_owned(),
                "hls/master.m3u8".to_owned(),
                "hls/segment_00000.ts".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn maybe_warm_edge_swallows_warm_endpoint_failure() {
        let (url, recorder) = spawn_warm_recorder(StatusCode::INTERNAL_SERVER_ERROR).await;
        let config = EdgeWarmConfig {
            url: Some(url),
            internal_token: "warm-secret".to_owned(),
            max_artifacts: 4,
        };

        maybe_warm_edge(
            None,
            &reqwest::Client::new(),
            &config,
            "asset-123",
            "opener_ready",
            &["opener.mp4".to_owned()],
        )
        .await;

        assert_eq!(recorder.count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn content_type_defaults_to_octet_stream() {
        assert_eq!(
            request_content_type(&HeaderMap::new()),
            "application/octet-stream".to_owned()
        );
    }

    #[tokio::test]
    async fn player_harness_route_loads_without_auth() {
        let app = build_app(test_state(), Duration::from_secs(10));
        let response = route_response(app, "/player", None).await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("<title>Rend local playback</title>"));
    }

    fn url_without_token(url: &str) -> String {
        url.split_once("?token=")
            .map(|(path, _token)| path)
            .unwrap_or(url)
            .to_owned()
    }
}
