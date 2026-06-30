use std::{
    collections::{HashMap, HashSet},
    io::SeekFrom,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{HeaderMap, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, options, post},
};
use bytes::Bytes;
use futures_util::stream;
use rend_config::{
    ExpectedEdges, RendEnv, env_bool, env_duration_secs, env_path, env_socket_addr, env_string,
    env_u64, env_usize, load_dotenv, optional_env_url,
    validate_edge_base_url as validate_config_edge_base_url, validate_required_secret,
    validate_required_url,
};
use rend_playback_auth::{
    PlaybackClaims, SingleKeyring, current_unix_timestamp,
    is_valid_hls_init_segment_name_for_rendition, is_valid_hls_rendition_name,
    is_valid_hls_segment_name, validate_playback_token,
};
use serde::{Deserialize, Serialize};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Notify, mpsc},
};
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

mod telemetry;

const DEFAULT_WARM_MAX_ARTIFACTS: usize = 16;
const HARD_WARM_MAX_ARTIFACTS: usize = 16;
const DEFAULT_MAX_IN_FLIGHT_FILLS: usize = 64;
const HARD_MAX_IN_FLIGHT_FILLS: usize = 1024;
const INTERNAL_REQUEST_BODY_LIMIT_BYTES: usize = 16 * 1024;
const MAX_ASSET_ID_LEN: usize = 128;
const DEFAULT_CONTROL_PLANE_HEARTBEAT_INTERVAL_SECS: u64 = 15;
const DEFAULT_MAX_ORIGIN_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_CACHE_MIN_FREE_BYTES: u64 = 64 * 1024 * 1024;
const PLAYBACK_COOKIE_NAME: &str = "__rend_playback";
const PLAYBACK_TIMING_ALLOW_ORIGIN: &str = "https://www.rend.so";
const CACHE_METADATA_DIR_NAME: &str = ".rend-edge-cache-meta";
const CACHE_METADATA_VERSION: u8 = 1;
const FIRST_SEGMENT_KEEP_COUNT: u32 = 2;

#[derive(Clone)]
struct EdgeConfig {
    bind_addr: SocketAddr,
    edge_id: String,
    region: String,
    cache_dir: PathBuf,
    origin_health_url: String,
    s3_endpoint: String,
    s3_region: String,
    s3_bucket: String,
    aws_access_key_id: String,
    aws_secret_access_key: String,
    internal_token: String,
    playback_telemetry: telemetry::TelemetryConfig,
    playback_keyring: SingleKeyring,
    warm_max_artifacts: usize,
    max_in_flight_fills: usize,
    cache_max_bytes: Option<u64>,
    max_origin_artifact_bytes: u64,
    cache_min_free_bytes: u64,
    control_plane: Option<ControlPlaneConfig>,
    request_timeout: Duration,
    cors_allowed_origins: Vec<String>,
}

#[derive(Clone)]
struct ControlPlaneConfig {
    url: String,
    edge_base_url: String,
    cache_max_bytes: Option<i64>,
    heartbeat_interval: Duration,
}

impl EdgeConfig {
    fn from_env() -> Result<Self> {
        let rend_env = RendEnv::from_env()?;
        let allow_insecure_edge_urls = env_bool("REND_ALLOW_INSECURE_EDGE_URLS", false)?;
        let edge_id = env_string("REND_EDGE_ID", "local-edge-001");
        let region = env_string("REND_EDGE_REGION", "local");
        let s3_endpoint = env_string("S3_ENDPOINT", "http://localhost:9100");
        let aws_access_key_id = env_string("AWS_ACCESS_KEY_ID", "rend_minio");
        let aws_secret_access_key = env_string("AWS_SECRET_ACCESS_KEY", "rend_minio_password");
        let playback_signing_key_id =
            env_string("REND_PLAYBACK_SIGNING_KEY_ID", "local-dev-playback-key");
        let playback_signing_secret = env_string(
            "REND_PLAYBACK_SIGNING_SECRET",
            "local-dev-playback-signing-secret",
        );
        let warm_max_artifacts =
            env_usize("REND_EDGE_WARM_MAX_ARTIFACTS", DEFAULT_WARM_MAX_ARTIFACTS)?;
        anyhow::ensure!(
            (1..=HARD_WARM_MAX_ARTIFACTS).contains(&warm_max_artifacts),
            "REND_EDGE_WARM_MAX_ARTIFACTS must be between 1 and {HARD_WARM_MAX_ARTIFACTS}"
        );
        let max_in_flight_fills =
            env_usize("REND_EDGE_MAX_IN_FLIGHT_FILLS", DEFAULT_MAX_IN_FLIGHT_FILLS)?;
        anyhow::ensure!(
            (1..=HARD_MAX_IN_FLIGHT_FILLS).contains(&max_in_flight_fills),
            "REND_EDGE_MAX_IN_FLIGHT_FILLS must be between 1 and {HARD_MAX_IN_FLIGHT_FILLS}"
        );

        let edge_internal_token = env_string("REND_EDGE_INTERNAL_TOKEN", "dev-internal-token");
        validate_required_secret(rend_env, "AWS_ACCESS_KEY_ID", &aws_access_key_id)?;
        validate_required_secret(rend_env, "AWS_SECRET_ACCESS_KEY", &aws_secret_access_key)?;
        validate_required_secret(rend_env, "REND_EDGE_INTERNAL_TOKEN", &edge_internal_token)?;
        validate_required_secret(
            rend_env,
            "REND_PLAYBACK_SIGNING_KEY_ID",
            &playback_signing_key_id,
        )?;
        validate_required_secret(
            rend_env,
            "REND_PLAYBACK_SIGNING_SECRET",
            &playback_signing_secret,
        )?;
        let playback_keyring = SingleKeyring::new(
            playback_signing_key_id,
            playback_signing_secret.into_bytes(),
        )?;
        let internal_telemetry_token = env_string("REND_INTERNAL_TELEMETRY_TOKEN", "");
        let playback_telemetry = telemetry::TelemetryConfig::from_env(&edge_internal_token)?;
        let telemetry_secret_for_validation = if rend_env.is_strict() {
            internal_telemetry_token.as_str()
        } else {
            playback_telemetry.internal_token.as_str()
        };
        validate_required_secret(
            rend_env,
            "REND_INTERNAL_TELEMETRY_TOKEN",
            telemetry_secret_for_validation,
        )?;
        let bind_addr = env_socket_addr("REND_EDGE_BIND_ADDR", "127.0.0.1:4100")?;
        let control_plane_url = optional_env_url("REND_CONTROL_PLANE_URL");
        let edge_base_url = optional_env_url("REND_EDGE_BASE_URL")
            .unwrap_or_else(|| format!("http://127.0.0.1:{}", bind_addr.port()));
        let expected_edges =
            ExpectedEdges::from_env("REND_EXPECTED_EDGES", rend_env, allow_insecure_edge_urls)?;
        validate_config_edge_base_url(
            rend_env,
            "REND_EDGE_BASE_URL",
            &edge_base_url,
            allow_insecure_edge_urls,
        )?;
        validate_required_url(
            rend_env,
            "REND_EDGE_ORIGIN_HEALTH_URL",
            &env_string(
                "REND_EDGE_ORIGIN_HEALTH_URL",
                "http://localhost:9100/minio/health/ready",
            ),
        )?;
        validate_required_url(rend_env, "S3_ENDPOINT", &s3_endpoint)?;
        if let Some(control_plane_url) = control_plane_url.as_deref() {
            validate_required_url(rend_env, "REND_CONTROL_PLANE_URL", control_plane_url)?;
        }
        if let Some(ingest_url) = playback_telemetry.ingest_url.as_deref() {
            validate_required_url(rend_env, "REND_EDGE_TELEMETRY_INGEST_URL", ingest_url)?;
        }
        if !expected_edges.is_empty()
            && !expected_edges.contains_match(&edge_id, &region, &edge_base_url)
        {
            anyhow::bail!(
                "REND_EDGE_ID/REND_EDGE_REGION/REND_EDGE_BASE_URL must match REND_EXPECTED_EDGES"
            );
        }
        let cache_max_bytes_i64 = optional_i64_env("REND_EDGE_CACHE_MAX_BYTES")?;
        let cache_max_bytes = cache_max_bytes_i64.and_then(|value| u64::try_from(value).ok());
        let max_origin_artifact_bytes = env_u64(
            "REND_EDGE_MAX_ORIGIN_ARTIFACT_BYTES",
            DEFAULT_MAX_ORIGIN_ARTIFACT_BYTES,
        )?;
        anyhow::ensure!(
            max_origin_artifact_bytes > 0,
            "REND_EDGE_MAX_ORIGIN_ARTIFACT_BYTES must be greater than 0"
        );
        let cache_min_free_bytes = env_u64(
            "REND_EDGE_CACHE_MIN_FREE_BYTES",
            DEFAULT_CACHE_MIN_FREE_BYTES,
        )?;
        let cors_allowed_origins = cors_allowed_origins_from_env(rend_env)?;
        let heartbeat_interval = env_duration_secs(
            "REND_EDGE_HEARTBEAT_INTERVAL_SECS",
            DEFAULT_CONTROL_PLANE_HEARTBEAT_INTERVAL_SECS,
        )?;
        let control_plane = control_plane_url.map(|url| ControlPlaneConfig {
            url,
            edge_base_url,
            cache_max_bytes: cache_max_bytes_i64,
            heartbeat_interval,
        });

        Ok(Self {
            bind_addr,
            edge_id,
            region,
            cache_dir: env_path("REND_EDGE_CACHE_DIR", ".rend/cache"),
            origin_health_url: env_string(
                "REND_EDGE_ORIGIN_HEALTH_URL",
                "http://localhost:9100/minio/health/ready",
            ),
            s3_endpoint,
            s3_region: env_string("S3_REGION", "us-east-1"),
            s3_bucket: env_string("S3_BUCKET", "rend-local"),
            aws_access_key_id,
            aws_secret_access_key,
            internal_token: edge_internal_token,
            playback_telemetry,
            playback_keyring,
            warm_max_artifacts,
            max_in_flight_fills,
            cache_max_bytes,
            max_origin_artifact_bytes,
            cache_min_free_bytes,
            control_plane,
            request_timeout: env_duration_secs("REND_HTTP_TIMEOUT_SECS", 10)?,
            cors_allowed_origins,
        })
    }
}

#[derive(Clone)]
struct AppState {
    config: EdgeConfig,
    http: reqwest::Client,
    s3: S3Client,
    in_flight_fills: Arc<FillRegistry>,
    active_streams: Arc<ActiveStreamRegistry>,
    cache_maintenance: Arc<tokio::sync::Mutex<()>>,
    metrics: Arc<EdgeMetrics>,
    telemetry: telemetry::TelemetryHandle,
    started_at: Instant,
}

#[derive(Serialize)]
struct HealthResponse<'a> {
    service: String,
    status: &'a str,
    version: &'a str,
    package_version: &'a str,
    git_sha: String,
    build_time: String,
    edge_id: String,
    region: String,
    uptime_ms: u128,
}

#[derive(Serialize)]
struct ReadyResponse<'a> {
    service: &'a str,
    status: &'a str,
    edge_id: String,
    region: String,
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
struct ControlPlaneRegistrationRequest<'a> {
    edge_id: &'a str,
    region: &'a str,
    base_url: &'a str,
    status: &'a str,
    cache_max_bytes: Option<i64>,
}

#[derive(Serialize)]
struct ControlPlaneHeartbeatRequest<'a> {
    edge_id: &'a str,
    status: &'a str,
    cache_max_bytes: Option<i64>,
}

#[derive(Serialize)]
struct PlaceholderResponse<'a> {
    status: &'a str,
    message: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WarmRequest {
    asset_id: String,
    artifact_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PurgeRequest {
    asset_id: String,
    artifact_paths: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct CacheInspectQuery {
    asset_id: String,
    artifact_path: String,
}

#[derive(Serialize)]
struct WarmResponse {
    asset_id: String,
    results: Vec<WarmEntryResponse>,
    summary: WarmSummary,
}

#[derive(Serialize)]
struct WarmEntryResponse {
    artifact_path: String,
    object_key: String,
    cache_key: String,
    status: WarmEntryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    byte_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum WarmEntryStatus {
    Warmed,
    AlreadyWarm,
    NotFound,
    Failed,
}

#[derive(Default, Serialize)]
struct WarmSummary {
    total: usize,
    warmed: usize,
    already_warm: usize,
    not_found: usize,
    failed: usize,
}

#[derive(Serialize)]
struct PurgeResponse {
    asset_id: String,
    purged: Vec<PurgeEntryResponse>,
    missing: Vec<PurgeEntryResponse>,
    rejected: Vec<PurgeRejectedResponse>,
    errors: Vec<PurgeErrorResponse>,
}

#[derive(Serialize)]
struct PurgeEntryResponse {
    artifact_path: String,
    cache_key: String,
}

#[derive(Serialize)]
struct PurgeRejectedResponse {
    artifact_path: String,
    reason: String,
}

#[derive(Serialize)]
struct PurgeErrorResponse {
    artifact_path: String,
    cache_key: String,
    error: String,
}

#[derive(Serialize)]
struct CacheInspectResponse {
    artifact_path: String,
    exists_in_local_cache: bool,
    byte_size: Option<u64>,
    edge_id: String,
    region: String,
    cache_dir_mount_target: Option<String>,
    cache_dir_mount_source: Option<String>,
    cache_dir_fstype: Option<String>,
    block_device_name: Option<String>,
    rotational: Option<bool>,
    inferred_storage_tier: InferredStorageTier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum InferredStorageTier {
    Nvme,
    Ssd,
    Unknown,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Deserialize)]
struct PlaybackPath {
    asset_id: String,
    artifact_path: String,
}

#[derive(Deserialize)]
struct PlaybackQuery {
    token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlaybackArtifact {
    object_key: String,
    cache_key: String,
    content_type: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

impl ByteRange {
    fn len(self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }

    fn content_range(self, content_length: u64) -> String {
        format!("bytes {}-{}/{}", self.start, self.end, content_length)
    }
}

#[derive(Debug, Clone)]
enum PlaybackError {
    Unauthorized,
    NotFound(String),
    OriginNotFound(String),
    Origin(String),
    Io(String),
    Overloaded(String),
}

#[derive(Default)]
struct FillRegistry {
    fills: std::sync::Mutex<HashMap<String, Arc<InFlightFill>>>,
}

#[derive(Default)]
struct ActiveStreamRegistry {
    streams: std::sync::Mutex<HashMap<String, ActiveStreamEntry>>,
}

#[derive(Default)]
struct ActiveStreamEntry {
    count: u64,
    reserved_bytes: u64,
}

#[derive(Default)]
struct EdgeMetrics {
    cache_hit: std::sync::atomic::AtomicU64,
    cache_miss: std::sync::atomic::AtomicU64,
    cache_coalesced: std::sync::atomic::AtomicU64,
    cache_error: std::sync::atomic::AtomicU64,
    cache_evictions: std::sync::atomic::AtomicU64,
    cache_evicted_bytes: std::sync::atomic::AtomicU64,
    cache_eviction_errors: std::sync::atomic::AtomicU64,
}

struct InFlightFill {
    notify: Notify,
    outcome: std::sync::Mutex<Option<FillOutcome>>,
}

#[derive(Clone)]
enum FillOutcome {
    Succeeded,
    Failed(PlaybackError),
}

enum FillSlot {
    Leader(FillLeaderGuard),
    Waiter(Arc<InFlightFill>),
}

struct FillLeaderGuard {
    registry: Arc<FillRegistry>,
    cache_key: String,
    fill: Arc<InFlightFill>,
    completed: bool,
}

struct ActiveStreamGuard {
    registry: Arc<ActiveStreamRegistry>,
    cache_key: String,
    reserved_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CacheArtifactType {
    Opener,
    Manifest,
    Segment,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheObjectMetadata {
    version: u8,
    cache_key: String,
    size_bytes: u64,
    last_access_unix_ms: u64,
    artifact_type: CacheArtifactType,
    priority: u16,
    segment_index: Option<u32>,
}

#[derive(Debug, Clone)]
struct CacheEvictionCandidate {
    cache_key: String,
    path: PathBuf,
    metadata_path: PathBuf,
    size_bytes: u64,
    last_access_unix_ms: u64,
    priority: u16,
    segment_index: Option<u32>,
}

struct PreparedCacheWrite {
    cache_path: PathBuf,
    temp_path: PathBuf,
    file: fs::File,
    reserved_bytes: u64,
    active_guard: Option<ActiveStreamGuard>,
}

struct OriginCacheStream {
    body: ByteStream,
    content_length: Option<u64>,
    cache_write: PreparedCacheWrite,
}

impl FillRegistry {
    fn acquire(
        self: &Arc<Self>,
        cache_key: &str,
        max_in_flight_fills: usize,
    ) -> std::result::Result<FillSlot, PlaybackError> {
        let mut fills = lock_mutex(&self.fills);
        if let Some(fill) = fills.get(cache_key) {
            return Ok(FillSlot::Waiter(fill.clone()));
        }

        if fills.len() >= max_in_flight_fills {
            return Err(PlaybackError::Overloaded(format!(
                "too many in-flight edge cache fills; limit is {max_in_flight_fills}"
            )));
        }

        let fill = Arc::new(InFlightFill::new());
        fills.insert(cache_key.to_owned(), fill.clone());
        Ok(FillSlot::Leader(FillLeaderGuard {
            registry: self.clone(),
            cache_key: cache_key.to_owned(),
            fill,
            completed: false,
        }))
    }

    fn complete(&self, cache_key: &str, fill: &Arc<InFlightFill>, outcome: FillOutcome) {
        {
            let mut fills = lock_mutex(&self.fills);
            if fills
                .get(cache_key)
                .is_some_and(|current| Arc::ptr_eq(current, fill))
            {
                fills.remove(cache_key);
            }
        }

        fill.complete(outcome);
    }

    fn len(&self) -> usize {
        lock_mutex(&self.fills).len()
    }
}

impl ActiveStreamRegistry {
    fn begin(self: &Arc<Self>, cache_key: &str, reserved_bytes: u64) -> ActiveStreamGuard {
        let mut streams = lock_mutex(&self.streams);
        let entry = streams.entry(cache_key.to_owned()).or_default();
        entry.count = entry.count.saturating_add(1);
        entry.reserved_bytes = entry.reserved_bytes.saturating_add(reserved_bytes);

        ActiveStreamGuard {
            registry: self.clone(),
            cache_key: cache_key.to_owned(),
            reserved_bytes,
        }
    }

    fn end(&self, cache_key: &str, reserved_bytes: u64) {
        let mut streams = lock_mutex(&self.streams);
        let Some(entry) = streams.get_mut(cache_key) else {
            return;
        };
        entry.count = entry.count.saturating_sub(1);
        entry.reserved_bytes = entry.reserved_bytes.saturating_sub(reserved_bytes);
        if entry.count == 0 {
            streams.remove(cache_key);
        }
    }

    fn keys(&self) -> HashSet<String> {
        lock_mutex(&self.streams).keys().cloned().collect()
    }

    fn len(&self) -> usize {
        lock_mutex(&self.streams)
            .values()
            .map(|entry| usize::try_from(entry.count).unwrap_or(usize::MAX))
            .sum()
    }

    fn reserved_bytes(&self) -> u64 {
        lock_mutex(&self.streams)
            .values()
            .fold(0u64, |total, entry| {
                total.saturating_add(entry.reserved_bytes)
            })
    }
}

impl InFlightFill {
    fn new() -> Self {
        Self {
            notify: Notify::new(),
            outcome: std::sync::Mutex::new(None),
        }
    }

    fn complete(&self, outcome: FillOutcome) {
        *lock_mutex(&self.outcome) = Some(outcome);
        self.notify.notify_waiters();
    }

    async fn wait(&self) -> FillOutcome {
        loop {
            let notified = self.notify.notified();
            if let Some(outcome) = lock_mutex(&self.outcome).clone() {
                return outcome;
            }
            notified.await;
        }
    }
}

impl FillLeaderGuard {
    fn complete(mut self, outcome: FillOutcome) {
        self.registry.complete(&self.cache_key, &self.fill, outcome);
        self.completed = true;
    }
}

impl Drop for FillLeaderGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.registry.complete(
                &self.cache_key,
                &self.fill,
                FillOutcome::Failed(PlaybackError::Origin(
                    "edge cache fill was cancelled".to_owned(),
                )),
            );
        }
    }
}

impl Drop for ActiveStreamGuard {
    fn drop(&mut self) {
        self.registry.end(&self.cache_key, self.reserved_bytes);
    }
}

fn lock_mutex<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug)]
enum WarmRequestError {
    BadRequest(String),
}

#[derive(Debug)]
enum PurgeRequestError {
    BadRequest(String),
}

#[derive(Debug)]
enum CacheInspectRequestError {
    BadRequest(String),
    Internal(String),
}

#[tokio::main]
async fn main() -> Result<()> {
    install_rustls_crypto_provider();
    load_dotenv()?;
    init_tracing();

    let config = EdgeConfig::from_env()?;
    fs::create_dir_all(&config.cache_dir)
        .await
        .with_context(|| format!("failed to create cache dir {}", config.cache_dir.display()))?;

    let request_timeout = config.request_timeout;
    let s3 = build_s3_client(&config);
    let http = reqwest::Client::new();
    let telemetry =
        telemetry::TelemetryHandle::start(config.playback_telemetry.clone(), http.clone());
    let state = Arc::new(AppState {
        config,
        http,
        s3,
        in_flight_fills: Arc::new(FillRegistry::default()),
        active_streams: Arc::new(ActiveStreamRegistry::default()),
        cache_maintenance: Arc::new(tokio::sync::Mutex::new(())),
        metrics: Arc::new(EdgeMetrics::default()),
        telemetry,
        started_at: Instant::now(),
    });
    let app = build_app(state.clone(), request_timeout);

    let listener = TcpListener::bind(state.config.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", state.config.bind_addr))?;

    tracing::info!(
        addr = %state.config.bind_addr,
        edge_id = %state.config.edge_id,
        region = %state.config.region,
        "rend-edge listening",
    );

    spawn_control_plane_client(state.clone());

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("rend-edge server failed")
}

fn install_rustls_crypto_provider() {
    // Keep rustls provider selection deterministic when transitive dependencies
    // enable both ring and aws-lc-rs.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn build_s3_client(config: &EdgeConfig) -> S3Client {
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

fn optional_i64_env(key: &str) -> Result<Option<i64>> {
    let value = env_string(key, "");
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }

    let parsed = value
        .parse::<i64>()
        .with_context(|| format!("{key} must be an integer"))?;
    anyhow::ensure!(parsed >= 0, "{key} must be non-negative");

    Ok(Some(parsed))
}

fn cors_allowed_origins_from_env(rend_env: RendEnv) -> Result<Vec<String>> {
    let configured = env_string("REND_EDGE_CORS_ALLOWED_ORIGINS", "");
    let default_origins = if rend_env.is_strict() {
        "https://rend.so,https://www.rend.so"
    } else {
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001"
    };
    let raw_origins = if configured.trim().is_empty() {
        default_origins
    } else {
        configured.as_str()
    };

    raw_origins
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_cors_origin)
        .collect()
}

fn normalize_cors_origin(value: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(value)
        .with_context(|| format!("REND_EDGE_CORS_ALLOWED_ORIGINS contains invalid URL: {value}"))?;
    anyhow::ensure!(
        matches!(parsed.scheme(), "http" | "https"),
        "REND_EDGE_CORS_ALLOWED_ORIGINS entries must use http or https"
    );
    anyhow::ensure!(
        parsed.username().is_empty() && parsed.password().is_none(),
        "REND_EDGE_CORS_ALLOWED_ORIGINS entries must not include credentials"
    );
    anyhow::ensure!(
        (parsed.path().is_empty() || parsed.path() == "/")
            && parsed.query().is_none()
            && parsed.fragment().is_none(),
        "REND_EDGE_CORS_ALLOWED_ORIGINS entries must be origins only"
    );
    let host = parsed
        .host_str()
        .context("REND_EDGE_CORS_ALLOWED_ORIGINS entries must include a host")?;
    let mut origin = format!("{}://{}", parsed.scheme(), host);
    if let Some(port) = parsed.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

fn build_app(state: Arc<AppState>, request_timeout: Duration) -> Router {
    let internal_routes = Router::new()
        .route("/warm", post(warm))
        .route("/purge", post(purge))
        .route("/cache/inspect", get(inspect_cache))
        .route("/reload-config", post(internal_placeholder))
        .route_layer(DefaultBodyLimit::max(INTERNAL_REQUEST_BODY_LIMIT_BYTES))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_internal_token,
        ));

    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route(
            "/metrics",
            get(metrics).route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_internal_token,
            )),
        )
        .nest("/internal", internal_routes)
        .route(
            "/v/{asset_id}/{*artifact_path}",
            get(playback).route_layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/v/{asset_id}/{*artifact_path}",
            options(playback_preflight).route_layer(DefaultBodyLimit::disable()),
        )
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

fn release_env(name: &str, fallback: &str) -> String {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

async fn healthz(State(state): State<Arc<AppState>>) -> Json<HealthResponse<'static>> {
    Json(HealthResponse {
        service: release_env("REND_SERVICE_NAME", "rend-edge"),
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        package_version: env!("CARGO_PKG_VERSION"),
        git_sha: release_env("REND_GIT_SHA", "unknown"),
        build_time: release_env("REND_BUILD_TIME", "unknown"),
        edge_id: state.config.edge_id.clone(),
        region: state.config.region.clone(),
        uptime_ms: state.started_at.elapsed().as_millis(),
    })
}

async fn readyz(State(state): State<Arc<AppState>>) -> Response {
    let checks = vec![check_cache_dir(&state).await, check_origin(&state).await];
    let ready = checks.iter().all(|check| check.status == "ok");
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let body = ReadyResponse {
        service: "rend-edge",
        status: if ready { "ready" } else { "not_ready" },
        edge_id: state.config.edge_id.clone(),
        region: state.config.region.clone(),
        checks,
    };

    (status, Json(body)).into_response()
}

fn spawn_control_plane_client(state: Arc<AppState>) {
    if state.config.control_plane.is_none() {
        return;
    }

    tokio::spawn(async move {
        run_control_plane_client(state).await;
    });
}

async fn run_control_plane_client(state: Arc<AppState>) {
    let Some(config) = state.config.control_plane.clone() else {
        return;
    };
    let mut registered = false;

    loop {
        let status = current_control_plane_status(&state).await;
        let result = if registered {
            post_control_plane_heartbeat(&state, &config, status).await
        } else {
            post_control_plane_registration(&state, &config, status).await
        };

        match result {
            Ok(()) => {
                if !registered {
                    tracing::info!(
                        edge_id = %state.config.edge_id,
                        region = %state.config.region,
                        "registered edge with control plane",
                    );
                }
                registered = true;
            }
            Err(error) => {
                tracing::warn!(
                    edge_id = %state.config.edge_id,
                    region = %state.config.region,
                    error = %error,
                    "edge control-plane request failed",
                );
                registered = false;
            }
        }

        tokio::time::sleep(config.heartbeat_interval).await;
    }
}

async fn current_control_plane_status(state: &AppState) -> &'static str {
    let cache = check_cache_dir(state).await;
    let origin = check_origin(state).await;
    if cache.status == "ok" && origin.status == "ok" {
        "healthy"
    } else {
        "unhealthy"
    }
}

async fn post_control_plane_registration(
    state: &AppState,
    config: &ControlPlaneConfig,
    status: &str,
) -> Result<()> {
    let url = format!("{}/internal/edges/register", config.url);
    let request = ControlPlaneRegistrationRequest {
        edge_id: &state.config.edge_id,
        region: &state.config.region,
        base_url: &config.edge_base_url,
        status,
        cache_max_bytes: config.cache_max_bytes,
    };

    state
        .http
        .post(url)
        .header("x-rend-internal-token", &state.config.internal_token)
        .json(&request)
        .send()
        .await
        .context("failed to send edge registration")?
        .error_for_status()
        .context("edge registration returned an error status")?;

    Ok(())
}

async fn post_control_plane_heartbeat(
    state: &AppState,
    config: &ControlPlaneConfig,
    status: &str,
) -> Result<()> {
    let url = format!("{}/internal/edges/heartbeat", config.url);
    let request = ControlPlaneHeartbeatRequest {
        edge_id: &state.config.edge_id,
        status,
        cache_max_bytes: config.cache_max_bytes,
    };

    state
        .http
        .post(url)
        .header("x-rend-internal-token", &state.config.internal_token)
        .json(&request)
        .send()
        .await
        .context("failed to send edge heartbeat")?
        .error_for_status()
        .context("edge heartbeat returned an error status")?;

    Ok(())
}

async fn metrics(State(state): State<Arc<AppState>>) -> Response {
    let ready =
        check_cache_dir(&state).await.status == "ok" && check_origin(&state).await.status == "ok";
    let telemetry_counters = state.telemetry.counters();
    let telemetry_spool_bytes = state.telemetry.spool_bytes().await;
    let edge_id = prometheus_label_value(&state.config.edge_id);
    let region = prometheus_label_value(&state.config.region);
    let body = format!(
        "# HELP rend_edge_up Edge process liveness.\n\
         # TYPE rend_edge_up gauge\n\
         rend_edge_up{{edge_id=\"{}\",region=\"{}\"}} 1\n\
         # HELP rend_edge_ready Edge readiness.\n\
         # TYPE rend_edge_ready gauge\n\
         rend_edge_ready{{edge_id=\"{}\",region=\"{}\"}} {}\n\
         # HELP rend_edge_cache_requests_total Playback cache responses by cache status.\n\
         # TYPE rend_edge_cache_requests_total counter\n\
         rend_edge_cache_requests_total{{edge_id=\"{}\",region=\"{}\",cache_status=\"HIT\"}} {}\n\
         rend_edge_cache_requests_total{{edge_id=\"{}\",region=\"{}\",cache_status=\"MISS\"}} {}\n\
         rend_edge_cache_requests_total{{edge_id=\"{}\",region=\"{}\",cache_status=\"COALESCED\"}} {}\n\
         rend_edge_cache_requests_total{{edge_id=\"{}\",region=\"{}\",cache_status=\"error\"}} {}\n\
         # HELP rend_edge_in_flight_fills Current in-flight origin cache fills.\n\
         # TYPE rend_edge_in_flight_fills gauge\n\
         rend_edge_in_flight_fills{{edge_id=\"{}\",region=\"{}\"}} {}\n\
         # HELP rend_edge_active_streamed_fills Current cold MISS fills streaming origin bytes to viewers while writing cache.\n\
         # TYPE rend_edge_active_streamed_fills gauge\n\
         rend_edge_active_streamed_fills{{edge_id=\"{}\",region=\"{}\"}} {}\n\
         # HELP rend_edge_cache_evictions_total Cache objects evicted to enforce edge disk limits.\n\
         # TYPE rend_edge_cache_evictions_total counter\n\
         rend_edge_cache_evictions_total{{edge_id=\"{}\",region=\"{}\"}} {}\n\
         # HELP rend_edge_cache_evicted_bytes_total Cache bytes evicted to enforce edge disk limits.\n\
         # TYPE rend_edge_cache_evicted_bytes_total counter\n\
         rend_edge_cache_evicted_bytes_total{{edge_id=\"{}\",region=\"{}\"}} {}\n\
         # HELP rend_edge_cache_eviction_errors_total Cache eviction attempts that failed.\n\
         # TYPE rend_edge_cache_eviction_errors_total counter\n\
         rend_edge_cache_eviction_errors_total{{edge_id=\"{}\",region=\"{}\"}} {}\n\
         # HELP rend_edge_telemetry_events_total Playback telemetry events by pipeline state.\n\
         # TYPE rend_edge_telemetry_events_total counter\n\
         rend_edge_telemetry_events_total{{edge_id=\"{}\",region=\"{}\",state=\"queued\"}} {}\n\
         rend_edge_telemetry_events_total{{edge_id=\"{}\",region=\"{}\",state=\"sent\"}} {}\n\
         rend_edge_telemetry_events_total{{edge_id=\"{}\",region=\"{}\",state=\"spooled\"}} {}\n\
         rend_edge_telemetry_events_total{{edge_id=\"{}\",region=\"{}\",state=\"dropped\"}} {}\n\
         # HELP rend_edge_telemetry_queue_depth Current playback telemetry events queued locally before send or spool.\n\
         # TYPE rend_edge_telemetry_queue_depth gauge\n\
         rend_edge_telemetry_queue_depth{{edge_id=\"{}\",region=\"{}\"}} {}\n\
         # HELP rend_edge_telemetry_spool_bytes Current local telemetry spool file size.\n\
         # TYPE rend_edge_telemetry_spool_bytes gauge\n\
         rend_edge_telemetry_spool_bytes{{edge_id=\"{}\",region=\"{}\"}} {}\n",
        edge_id,
        region,
        edge_id,
        region,
        if ready { 1 } else { 0 },
        edge_id,
        region,
        state.metrics.cache_hit.load(Ordering::Relaxed),
        edge_id,
        region,
        state.metrics.cache_miss.load(Ordering::Relaxed),
        edge_id,
        region,
        state.metrics.cache_coalesced.load(Ordering::Relaxed),
        edge_id,
        region,
        state.metrics.cache_error.load(Ordering::Relaxed),
        edge_id,
        region,
        state.in_flight_fills.len(),
        edge_id,
        region,
        state.active_streams.len(),
        edge_id,
        region,
        state.metrics.cache_evictions.load(Ordering::Relaxed),
        edge_id,
        region,
        state.metrics.cache_evicted_bytes.load(Ordering::Relaxed),
        edge_id,
        region,
        state.metrics.cache_eviction_errors.load(Ordering::Relaxed),
        edge_id,
        region,
        telemetry_counters.queued,
        edge_id,
        region,
        telemetry_counters.sent,
        edge_id,
        region,
        telemetry_counters.spooled,
        edge_id,
        region,
        telemetry_counters.dropped,
        edge_id,
        region,
        telemetry_counters.queue_depth,
        edge_id,
        region,
        telemetry_spool_bytes,
    );

    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response()
}

fn prometheus_label_value(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| match ch {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            ch => vec![ch],
        })
        .collect()
}

async fn playback(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<PlaybackPath>,
    Query(query): Query<PlaybackQuery>,
    headers: HeaderMap,
) -> Response {
    let started = Instant::now();
    let asset_id = path.asset_id.clone();
    let artifact_path = path.artifact_path.clone();
    let cors_origin = playback_cors_origin(&state.config, &headers).map(str::to_owned);
    let cookie_token = playback_token_cookie(&headers);
    let token = query.token.as_deref().or(cookie_token.as_deref());
    let range_header = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(normalize_single_byte_range_header);
    let result = playback_inner(
        state.clone(),
        path,
        token,
        cors_origin.as_deref(),
        range_header.as_deref(),
    )
    .await;
    let (response, error_code, organization_id) = match result {
        Ok(outcome) => (outcome.response, None, outcome.organization_id),
        Err(error) => {
            let error_code = error.telemetry_error_code();
            (error.into_response(), Some(error_code), None)
        }
    };

    record_playback_telemetry(
        &state,
        organization_id.as_deref(),
        &asset_id,
        &artifact_path,
        &response,
        started.elapsed(),
        error_code,
    );
    record_cache_metrics(&state, &response);
    response
}

async fn playback_preflight(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<PlaybackPath>,
    headers: HeaderMap,
) -> Response {
    if map_playback_artifact(&path.asset_id, &path.artifact_path).is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let Some(origin) = playback_cors_origin(&state.config, &headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };

    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .header(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, "true")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, Method::GET.as_str())
        .header(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "accept, content-type, range",
        )
        .header(header::ACCESS_CONTROL_MAX_AGE, "600")
        .header(header::VARY, "Origin")
        .body(Body::empty())
        .expect("preflight response headers are static and valid")
}

fn record_cache_metrics(state: &AppState, response: &Response) {
    match response
        .headers()
        .get("x-rend-cache")
        .and_then(|value| value.to_str().ok())
    {
        Some("HIT") => {
            state.metrics.cache_hit.fetch_add(1, Ordering::Relaxed);
        }
        Some("MISS") => {
            state.metrics.cache_miss.fetch_add(1, Ordering::Relaxed);
        }
        Some("COALESCED") => {
            state
                .metrics
                .cache_coalesced
                .fetch_add(1, Ordering::Relaxed);
        }
        _ => {
            state.metrics.cache_error.fetch_add(1, Ordering::Relaxed);
        }
    };
}

async fn playback_inner(
    state: Arc<AppState>,
    path: PlaybackPath,
    token: Option<&str>,
    cors_origin: Option<&str>,
    range_header: Option<&str>,
) -> std::result::Result<PlaybackOutcome, PlaybackError> {
    let now = current_unix_timestamp().map_err(|error| PlaybackError::Io(error.to_string()))?;
    let claims = validate_playback_request(
        &state.config.playback_keyring,
        &path.asset_id,
        &path.artifact_path,
        token,
        now,
    )?;
    let organization_id = claims.organization_id;

    let artifact = map_playback_artifact(&path.asset_id, &path.artifact_path)?;
    let cache_path = state.config.cache_dir.join(&artifact.cache_key);

    if let Some(response) = cached_artifact_response(
        &state,
        &artifact,
        &cache_path,
        "HIT",
        cors_origin,
        range_header,
    )
    .await?
    {
        return Ok(PlaybackOutcome {
            response,
            organization_id,
        });
    }

    if let Some(range_header) = range_header.filter(|_| is_range_media_content_type(&artifact)) {
        let response =
            stream_origin_range_response(state, artifact, range_header, cors_origin).await?;
        return Ok(PlaybackOutcome {
            response,
            organization_id,
        });
    }

    let response = match state
        .in_flight_fills
        .acquire(&artifact.cache_key, state.config.max_in_flight_fills)?
    {
        FillSlot::Leader(leader) => {
            stream_origin_artifact_response(
                state.clone(),
                artifact,
                cache_path,
                leader,
                cors_origin,
            )
            .await
        }
        FillSlot::Waiter(fill) => {
            wait_for_coalesced_fill(fill).await?;
            cached_artifact_response(
                &state,
                &artifact,
                &cache_path,
                "COALESCED",
                cors_origin,
                None,
            )
            .await?
            .ok_or_else(|| {
                PlaybackError::Io(format!(
                    "filled cache artifact {} was missing before it could be served",
                    cache_path.display()
                ))
            })
        }
    }?;

    Ok(PlaybackOutcome {
        response,
        organization_id,
    })
}

struct PlaybackOutcome {
    response: Response,
    organization_id: Option<String>,
}

async fn cached_artifact_response(
    state: &AppState,
    artifact: &PlaybackArtifact,
    path: &FsPath,
    cache_status: &'static str,
    cors_origin: Option<&str>,
    range_header: Option<&str>,
) -> std::result::Result<Option<Response>, PlaybackError> {
    let mut file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(PlaybackError::Io(format!(
                "failed to open cached artifact {}: {error}",
                path.display()
            )));
        }
    };
    let metadata = file.metadata().await.map_err(|error| {
        PlaybackError::Io(format!(
            "failed to inspect cached artifact {}: {error}",
            path.display()
        ))
    })?;
    let content_length = metadata.len();

    if let Err(error) = touch_cache_metadata(state, &artifact.cache_key, content_length).await {
        tracing::warn!(
            cache_key = %artifact.cache_key,
            error = %error.log_message(),
            "failed to update edge cache metadata after hit",
        );
    }

    if let Some(range_header) = range_header.filter(|_| is_range_media_content_type(artifact)) {
        return match parse_byte_range(range_header, content_length) {
            Ok(Some(byte_range)) => {
                file.seek(SeekFrom::Start(byte_range.start))
                    .await
                    .map_err(|error| {
                        PlaybackError::Io(format!(
                            "failed to seek cached artifact {}: {error}",
                            path.display()
                        ))
                    })?;
                Ok(Some(artifact_response_with_status(
                    &state.config,
                    artifact,
                    cache_status,
                    StatusCode::PARTIAL_CONTENT,
                    file_body(file, byte_range.len()),
                    Some(byte_range.len()),
                    Some(&byte_range.content_range(content_length)),
                    cors_origin,
                )))
            }
            Ok(None) => Ok(Some(artifact_response(
                &state.config,
                artifact,
                cache_status,
                file_body(file, content_length),
                Some(content_length),
                cors_origin,
            ))),
            Err(()) => Ok(Some(range_not_satisfiable_response(
                &state.config,
                artifact,
                cache_status,
                content_length,
                cors_origin,
            ))),
        };
    }

    Ok(Some(artifact_response(
        &state.config,
        artifact,
        cache_status,
        file_body(file, content_length),
        Some(content_length),
        cors_origin,
    )))
}

fn file_body(file: fs::File, remaining: u64) -> Body {
    let body_stream = stream::try_unfold((file, remaining), |(mut file, remaining)| async move {
        if remaining == 0 {
            return Ok(None);
        }

        let chunk_len = usize::try_from(remaining.min(64 * 1024)).unwrap_or(64 * 1024);
        let mut buffer = vec![0; chunk_len];
        let bytes_read = file.read(&mut buffer).await?;
        if bytes_read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "cached artifact ended before advertised content length",
            ));
        }
        buffer.truncate(bytes_read);
        let remaining = remaining.saturating_sub(u64::try_from(bytes_read).unwrap_or(0));

        Ok(Some((Bytes::from(buffer), (file, remaining))))
    });

    Body::from_stream(body_stream)
}

fn is_range_media_content_type(artifact: &PlaybackArtifact) -> bool {
    matches!(artifact.content_type, "video/mp2t")
        || (artifact.content_type == "video/mp4" && artifact.cache_key.contains("/hls/"))
}

fn normalize_single_byte_range_header(value: &str) -> Option<String> {
    let value = value.trim();
    let range_spec = value.strip_prefix("bytes=")?.trim();
    if range_spec.is_empty() || range_spec.contains(',') {
        return None;
    }

    let (start, end) = range_spec.split_once('-')?;
    let start = start.trim();
    let end = end.trim();
    if start.is_empty() && end.is_empty() {
        return None;
    }
    let parsed_start = if start.is_empty() {
        None
    } else {
        Some(start.parse::<u64>().ok()?)
    };
    let parsed_end = if end.is_empty() {
        None
    } else {
        Some(end.parse::<u64>().ok()?)
    };
    if let (Some(start), Some(end)) = (parsed_start, parsed_end)
        && start > end
    {
        return None;
    }
    if parsed_start.is_none() && parsed_end == Some(0) {
        return None;
    }

    Some(match (parsed_start, parsed_end) {
        (Some(start), Some(end)) => format!("bytes={start}-{end}"),
        (Some(start), None) => format!("bytes={start}-"),
        (None, Some(suffix_length)) => format!("bytes=-{suffix_length}"),
        (None, None) => return None,
    })
}

fn parse_byte_range(
    value: &str,
    content_length: u64,
) -> std::result::Result<Option<ByteRange>, ()> {
    let Some(normalized) = normalize_single_byte_range_header(value) else {
        return Ok(None);
    };
    let range_spec = normalized
        .strip_prefix("bytes=")
        .expect("normalized byte ranges include bytes= prefix");
    let (start, end) = range_spec.split_once('-').ok_or(())?;
    let parsed_start = if start.is_empty() {
        None
    } else {
        Some(start.parse::<u64>().map_err(|_| ())?)
    };
    let parsed_end = if end.is_empty() {
        None
    } else {
        Some(end.parse::<u64>().map_err(|_| ())?)
    };

    if content_length == 0 {
        return Err(());
    }

    match (parsed_start, parsed_end) {
        (Some(start), Some(end)) if start < content_length && start <= end => Ok(Some(ByteRange {
            start,
            end: end.min(content_length - 1),
        })),
        (Some(start), None) if start < content_length => Ok(Some(ByteRange {
            start,
            end: content_length - 1,
        })),
        (None, Some(suffix_length)) if suffix_length > 0 => {
            let start = content_length.saturating_sub(suffix_length);
            Ok(Some(ByteRange {
                start,
                end: content_length - 1,
            }))
        }
        _ => Err(()),
    }
}

async fn stream_origin_range_response(
    state: Arc<AppState>,
    artifact: PlaybackArtifact,
    range_header: &str,
    cors_origin: Option<&str>,
) -> std::result::Result<Response, PlaybackError> {
    let object = state
        .s3
        .get_object()
        .bucket(&state.config.s3_bucket)
        .key(&artifact.object_key)
        .range(range_header.to_owned())
        .send()
        .await
        .map_err(|error| origin_get_error(&artifact, error))?;
    let content_length = object
        .content_length()
        .map(|value| u64::try_from(value).unwrap_or(u64::MAX));
    if let Some(content_length) = content_length {
        ensure_origin_artifact_size_allowed(&state, &artifact.object_key, content_length)?;
    }
    let content_range = object.content_range().map(str::to_owned);
    let status = if content_range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let object_key = artifact.object_key.clone();
    let body_stream = byte_stream_body(object.body, object_key);

    Ok(artifact_response_with_status(
        &state.config,
        &artifact,
        "MISS",
        status,
        Body::from_stream(body_stream),
        content_length,
        content_range.as_deref(),
        cors_origin,
    ))
}

fn byte_stream_body(
    body: ByteStream,
    object_key: String,
) -> impl futures_util::Stream<Item = std::result::Result<Bytes, std::io::Error>> {
    stream::try_unfold((body, object_key), |(mut body, object_key)| async move {
        match body.try_next().await {
            Ok(Some(chunk)) => Ok(Some((chunk, (body, object_key)))),
            Ok(None) => Ok(None),
            Err(error) => Err(std::io::Error::other(format!(
                "failed to read artifact {object_key} from origin: {error}"
            ))),
        }
    })
}

fn record_playback_telemetry(
    state: &AppState,
    organization_id: Option<&str>,
    asset_id: &str,
    artifact_path: &str,
    response: &Response,
    elapsed: Duration,
    error_code: Option<&'static str>,
) {
    let cache_status = response
        .headers()
        .get("x-rend-cache")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("ERROR");
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json");
    let bytes_served = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let duration_ms = u32::try_from(elapsed.as_millis()).unwrap_or(u32::MAX);

    state
        .telemetry
        .record_playback(telemetry::PlaybackTelemetryInput {
            organization_id,
            asset_id,
            artifact_path,
            edge_id: &state.config.edge_id,
            region: &state.config.region,
            cache_status,
            status_code: response.status().as_u16(),
            bytes_served,
            content_type,
            duration_ms,
            resolution_tier: resolution_tier_from_artifact_path(artifact_path),
            error_code,
        });
}

fn resolution_tier_from_artifact_path(artifact_path: &str) -> Option<&str> {
    match artifact_path.split('/').collect::<Vec<_>>().as_slice() {
        ["hls", rendition_name, "index.m3u8"] | ["hls", rendition_name, _]
            if matches!(*rendition_name, "360p" | "480p" | "720p") =>
        {
            Some("720p")
        }
        ["hls", rendition_name, "index.m3u8"] | ["hls", rendition_name, _]
            if matches!(*rendition_name, "1080p" | "2k" | "4k") =>
        {
            Some(*rendition_name)
        }
        _ => None,
    }
}

async fn wait_for_coalesced_fill(
    fill: Arc<InFlightFill>,
) -> std::result::Result<(), PlaybackError> {
    match fill.wait().await {
        FillOutcome::Succeeded => Ok(()),
        FillOutcome::Failed(error) => Err(error),
    }
}

async fn stream_origin_artifact_response(
    state: Arc<AppState>,
    artifact: PlaybackArtifact,
    cache_path: PathBuf,
    leader: FillLeaderGuard,
    cors_origin: Option<&str>,
) -> std::result::Result<Response, PlaybackError> {
    let stream = match prepare_streamed_origin_fill(&state, &artifact, cache_path).await {
        Ok(stream) => stream,
        Err(error) => {
            leader.complete(FillOutcome::Failed(error.clone()));
            return Err(error);
        }
    };

    let content_length = stream.content_length;
    let (sender, receiver) = mpsc::channel::<std::result::Result<Bytes, std::io::Error>>(8);
    tokio::spawn(run_streamed_cache_fill(
        state.clone(),
        artifact.clone(),
        stream,
        sender,
        leader,
    ));
    let body_stream = stream::unfold(receiver, |mut receiver| async {
        receiver.recv().await.map(|item| (item, receiver))
    });

    Ok(artifact_response(
        &state.config,
        &artifact,
        "MISS",
        Body::from_stream(body_stream),
        content_length,
        cors_origin,
    ))
}

async fn prepare_streamed_origin_fill(
    state: &Arc<AppState>,
    artifact: &PlaybackArtifact,
    cache_path: PathBuf,
) -> std::result::Result<OriginCacheStream, PlaybackError> {
    let object = state
        .s3
        .get_object()
        .bucket(&state.config.s3_bucket)
        .key(&artifact.object_key)
        .send()
        .await
        .map_err(|error| origin_get_error(artifact, error))?;
    let content_length = object
        .content_length()
        .map(|value| u64::try_from(value).unwrap_or(u64::MAX));
    if let Some(content_length) = content_length {
        ensure_origin_artifact_size_allowed(state, &artifact.object_key, content_length)?;
        ensure_cache_object_size_allowed(state, content_length)?;
    }

    let active_guard = state
        .active_streams
        .begin(&artifact.cache_key, content_length.unwrap_or(0));
    let _maintenance = state.cache_maintenance.lock().await;
    let cache_write = match prepare_cache_write(
        state,
        &artifact.cache_key,
        cache_path,
        0,
        content_length.unwrap_or(0),
        Some(active_guard),
    )
    .await
    {
        Ok(cache_write) => cache_write,
        Err(error) => return Err(error),
    };

    Ok(OriginCacheStream {
        body: object.body,
        content_length,
        cache_write,
    })
}

async fn run_streamed_cache_fill(
    state: Arc<AppState>,
    artifact: PlaybackArtifact,
    stream: OriginCacheStream,
    sender: mpsc::Sender<std::result::Result<Bytes, std::io::Error>>,
    leader: FillLeaderGuard,
) {
    let result = write_streamed_origin_to_cache(&state, &artifact, stream, &sender).await;
    if let Err(error) = &result {
        let _ = sender
            .send(Err(std::io::Error::other(error.log_message())))
            .await;
    }

    let outcome = match result {
        Ok(()) => FillOutcome::Succeeded,
        Err(error) => FillOutcome::Failed(error),
    };
    leader.complete(outcome);
}

async fn write_streamed_origin_to_cache(
    state: &AppState,
    artifact: &PlaybackArtifact,
    mut stream: OriginCacheStream,
    sender: &mpsc::Sender<std::result::Result<Bytes, std::io::Error>>,
) -> std::result::Result<(), PlaybackError> {
    let mut bytes_written = 0u64;
    loop {
        let chunk = match stream.body.try_next().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                let playback_error = PlaybackError::Origin(format!(
                    "failed to read artifact {} from origin: {error}",
                    artifact.object_key
                ));
                cleanup_prepared_cache_write(stream.cache_write).await;
                return Err(playback_error);
            }
        };
        let chunk_len = u64::try_from(chunk.len()).unwrap_or(u64::MAX);
        let next_size = bytes_written.saturating_add(chunk_len);
        if let Err(error) =
            ensure_origin_artifact_size_allowed(state, &artifact.object_key, next_size)
        {
            cleanup_prepared_cache_write(stream.cache_write).await;
            return Err(error);
        }
        if let Err(error) =
            ensure_streamed_cache_size_allowed(state, &stream.cache_write, next_size).await
        {
            cleanup_prepared_cache_write(stream.cache_write).await;
            return Err(error);
        }

        let _ = sender.send(Ok(chunk.clone())).await;
        if let Err(error) = stream.cache_write.file.write_all(&chunk).await {
            let playback_error = PlaybackError::Io(format!(
                "failed to write cache file {}: {error}",
                stream.cache_write.cache_path.display()
            ));
            cleanup_prepared_cache_write(stream.cache_write).await;
            return Err(playback_error);
        }
        bytes_written = next_size;
    }

    if let Some(expected) = stream.content_length
        && bytes_written != expected
    {
        let playback_error = PlaybackError::Origin(format!(
            "artifact {} ended after {bytes_written} bytes, expected {expected}",
            artifact.object_key
        ));
        cleanup_prepared_cache_write(stream.cache_write).await;
        return Err(playback_error);
    }

    commit_prepared_cache_write(
        state,
        &artifact.cache_key,
        stream.cache_write,
        bytes_written,
    )
    .await
}

async fn warm(State(state): State<Arc<AppState>>, Json(request): Json<WarmRequest>) -> Response {
    match warm_inner(state, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn warm_inner(
    state: Arc<AppState>,
    request: WarmRequest,
) -> std::result::Result<WarmResponse, WarmRequestError> {
    let entries = validate_warm_request(&request, state.config.warm_max_artifacts)?;
    let mut results = Vec::with_capacity(entries.len());

    for (artifact_path, artifact) in entries {
        results.push(warm_artifact(&state, artifact_path, artifact).await);
    }

    let mut summary = WarmSummary {
        total: results.len(),
        ..WarmSummary::default()
    };
    for result in &results {
        match result.status {
            WarmEntryStatus::Warmed => summary.warmed += 1,
            WarmEntryStatus::AlreadyWarm => summary.already_warm += 1,
            WarmEntryStatus::NotFound => summary.not_found += 1,
            WarmEntryStatus::Failed => summary.failed += 1,
        }
    }

    Ok(WarmResponse {
        asset_id: request.asset_id,
        results,
        summary,
    })
}

async fn purge(State(state): State<Arc<AppState>>, Json(request): Json<PurgeRequest>) -> Response {
    match purge_inner(state, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn purge_inner(
    state: Arc<AppState>,
    request: PurgeRequest,
) -> std::result::Result<PurgeResponse, PurgeRequestError> {
    if !is_safe_asset_id(&request.asset_id) {
        return Err(PurgeRequestError::BadRequest(
            "asset_id must use the playback asset id character set".to_owned(),
        ));
    }

    let mut response = PurgeResponse {
        asset_id: request.asset_id.clone(),
        purged: Vec::new(),
        missing: Vec::new(),
        rejected: Vec::new(),
        errors: Vec::new(),
    };
    let entries = purge_entries(&state, &request, &mut response).await;

    for (artifact_path, artifact) in entries {
        purge_artifact(&state, artifact_path, artifact, &mut response).await;
    }

    remove_empty_asset_cache_dirs(&state.config.cache_dir, &request.asset_id).await;
    Ok(response)
}

async fn inspect_cache(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CacheInspectQuery>,
) -> Response {
    match inspect_cache_inner(&state, query).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn inspect_cache_inner(
    state: &AppState,
    query: CacheInspectQuery,
) -> std::result::Result<CacheInspectResponse, CacheInspectRequestError> {
    let artifact = map_playback_artifact(&query.asset_id, &query.artifact_path).map_err(|_| {
        CacheInspectRequestError::BadRequest("unsupported playback artifact path".to_owned())
    })?;
    let cache_path = state.config.cache_dir.join(&artifact.cache_key);
    let (exists_in_local_cache, byte_size) =
        inspect_cache_file(&cache_path).await.map_err(|error| {
            tracing::warn!(
                asset_id = %query.asset_id,
                artifact_path = %query.artifact_path,
                error = %error,
                "failed to inspect edge cache artifact",
            );
            CacheInspectRequestError::Internal("failed to inspect edge cache artifact".to_owned())
        })?;
    let storage = inspect_cache_storage(&state.config.cache_dir);

    Ok(CacheInspectResponse {
        artifact_path: query.artifact_path,
        exists_in_local_cache,
        byte_size,
        edge_id: state.config.edge_id.clone(),
        region: state.config.region.clone(),
        cache_dir_mount_target: storage.mount_target,
        cache_dir_mount_source: storage.mount_source,
        cache_dir_fstype: storage.fstype,
        block_device_name: storage.block_device_name,
        rotational: storage.rotational,
        inferred_storage_tier: storage.inferred_storage_tier,
    })
}

async fn inspect_cache_file(path: &FsPath) -> std::io::Result<(bool, Option<u64>)> {
    match fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok((true, Some(metadata.len()))),
        Ok(_) => Ok((false, None)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((false, None)),
        Err(error) => Err(error),
    }
}

async fn purge_entries(
    state: &AppState,
    request: &PurgeRequest,
    response: &mut PurgeResponse,
) -> Vec<(String, PlaybackArtifact)> {
    match request.artifact_paths.as_deref() {
        Some(artifact_paths) if !artifact_paths.is_empty() => explicit_purge_entries(
            &request.asset_id,
            artifact_paths,
            state.config.warm_max_artifacts,
            response,
        ),
        _ => discover_cached_playback_entries(state, &request.asset_id, response).await,
    }
}

fn explicit_purge_entries(
    asset_id: &str,
    artifact_paths: &[String],
    max_artifacts: usize,
    response: &mut PurgeResponse,
) -> Vec<(String, PlaybackArtifact)> {
    let mut entries = Vec::new();
    for (index, artifact_path) in artifact_paths.iter().enumerate() {
        if index >= max_artifacts {
            response.rejected.push(PurgeRejectedResponse {
                artifact_path: artifact_path.clone(),
                reason: format!("artifact_paths must include at most {max_artifacts} entries"),
            });
            continue;
        }

        match map_playback_artifact(asset_id, artifact_path) {
            Ok(artifact) => entries.push((artifact_path.clone(), artifact)),
            Err(_) => response.rejected.push(PurgeRejectedResponse {
                artifact_path: artifact_path.clone(),
                reason: "unsupported playback artifact path".to_owned(),
            }),
        }
    }
    entries
}

async fn discover_cached_playback_entries(
    state: &AppState,
    asset_id: &str,
    response: &mut PurgeResponse,
) -> Vec<(String, PlaybackArtifact)> {
    let asset_cache_dir = state.config.cache_dir.join("videos").join(asset_id);
    let mut entries = Vec::new();
    let mut pending_dirs = vec![asset_cache_dir.clone()];

    while let Some(dir) = pending_dirs.pop() {
        let mut read_dir = match fs::read_dir(&dir).await {
            Ok(read_dir) => read_dir,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                response.errors.push(PurgeErrorResponse {
                    artifact_path: path_relative_to_asset(&asset_cache_dir, &dir),
                    cache_key: path_relative_to_cache(&state.config.cache_dir, &dir),
                    error: format!("failed to read cache directory: {error}"),
                });
                continue;
            }
        };

        loop {
            let entry = match read_dir.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(error) => {
                    response.errors.push(PurgeErrorResponse {
                        artifact_path: path_relative_to_asset(&asset_cache_dir, &dir),
                        cache_key: path_relative_to_cache(&state.config.cache_dir, &dir),
                        error: format!("failed to scan cache directory: {error}"),
                    });
                    break;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type().await {
                Ok(file_type) => file_type,
                Err(error) => {
                    response.errors.push(PurgeErrorResponse {
                        artifact_path: path_relative_to_asset(&asset_cache_dir, &path),
                        cache_key: path_relative_to_cache(&state.config.cache_dir, &path),
                        error: format!("failed to inspect cache entry: {error}"),
                    });
                    continue;
                }
            };

            if file_type.is_dir() {
                pending_dirs.push(path);
                continue;
            }

            let artifact_path = path_relative_to_asset(&asset_cache_dir, &path);
            if !file_type.is_file() {
                response.rejected.push(PurgeRejectedResponse {
                    artifact_path,
                    reason: "cache entry is not a regular file".to_owned(),
                });
                continue;
            }

            match map_playback_artifact(asset_id, &artifact_path) {
                Ok(artifact) => entries.push((artifact_path, artifact)),
                Err(_) => response.rejected.push(PurgeRejectedResponse {
                    artifact_path,
                    reason: "unsupported playback artifact path".to_owned(),
                }),
            }
        }
    }

    entries
}

async fn purge_artifact(
    state: &AppState,
    artifact_path: String,
    artifact: PlaybackArtifact,
    response: &mut PurgeResponse,
) {
    let cache_path = state.config.cache_dir.join(&artifact.cache_key);
    match fs::remove_file(&cache_path).await {
        Ok(()) => {
            let _ = fs::remove_file(cache_metadata_path(
                &state.config.cache_dir,
                &artifact.cache_key,
            ))
            .await;
            response.purged.push(PurgeEntryResponse {
                artifact_path,
                cache_key: artifact.cache_key,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            response.missing.push(PurgeEntryResponse {
                artifact_path,
                cache_key: artifact.cache_key,
            });
        }
        Err(error) => response.errors.push(PurgeErrorResponse {
            artifact_path,
            cache_key: artifact.cache_key,
            error: format!("failed to remove cache file: {error}"),
        }),
    }
}

async fn remove_empty_asset_cache_dirs(cache_dir: &FsPath, asset_id: &str) {
    let asset_cache_dir = cache_dir.join("videos").join(asset_id);
    let hls_dir = asset_cache_dir.join("hls");
    let videos_dir = cache_dir.join("videos");
    let _ = fs::remove_dir(&hls_dir).await;
    let _ = fs::remove_dir(&asset_cache_dir).await;
    let _ = fs::remove_dir(&videos_dir).await;
}

fn path_relative_to_asset(asset_cache_dir: &FsPath, path: &FsPath) -> String {
    path.strip_prefix(asset_cache_dir)
        .ok()
        .and_then(path_to_slash_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

fn path_relative_to_cache(cache_dir: &FsPath, path: &FsPath) -> String {
    path.strip_prefix(cache_dir)
        .ok()
        .and_then(path_to_slash_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

fn path_to_slash_string(path: &FsPath) -> Option<String> {
    let parts = path
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<Vec<_>>>()?;
    Some(parts.join("/"))
}

#[derive(Debug, Clone)]
struct CacheStorageInspection {
    mount_target: Option<String>,
    mount_source: Option<String>,
    fstype: Option<String>,
    block_device_name: Option<String>,
    rotational: Option<bool>,
    inferred_storage_tier: InferredStorageTier,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MountInfoEntry {
    target: String,
    source: String,
    fstype: String,
}

fn inspect_cache_storage(cache_dir: &FsPath) -> CacheStorageInspection {
    let mount = cache_dir_mount(cache_dir);
    let block_device_name = mount
        .as_ref()
        .and_then(|entry| block_device_name_from_mount_source(&entry.source));
    let rotational = block_device_name
        .as_deref()
        .and_then(rotational_flag_for_block_device);
    let inferred_storage_tier = infer_storage_tier(block_device_name.as_deref(), rotational);

    CacheStorageInspection {
        mount_target: mount
            .as_ref()
            .map(|entry| safe_operational_value(&entry.target)),
        mount_source: mount
            .as_ref()
            .map(|entry| redacted_mount_source(&entry.source)),
        fstype: mount
            .as_ref()
            .map(|entry| safe_operational_value(&entry.fstype)),
        block_device_name,
        rotational,
        inferred_storage_tier,
    }
}

fn cache_dir_mount(cache_dir: &FsPath) -> Option<MountInfoEntry> {
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
    let cache_dir = resolve_cache_dir_for_mount(cache_dir);
    parse_mountinfo(&mountinfo)
        .into_iter()
        .filter(|entry| cache_dir.starts_with(FsPath::new(&entry.target)))
        .max_by_key(|entry| FsPath::new(&entry.target).components().count())
}

fn resolve_cache_dir_for_mount(cache_dir: &FsPath) -> PathBuf {
    let absolute = if cache_dir.is_absolute() {
        cache_dir.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(cache_dir)
    };

    let mut cursor = absolute.as_path();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(cursor) {
            return canonical;
        }
        let Some(parent) = cursor.parent() else {
            return absolute;
        };
        cursor = parent;
    }
}

fn parse_mountinfo(contents: &str) -> Vec<MountInfoEntry> {
    contents.lines().filter_map(parse_mountinfo_line).collect()
}

fn parse_mountinfo_line(line: &str) -> Option<MountInfoEntry> {
    let (left, right) = line.split_once(" - ")?;
    let left_fields = left.split_whitespace().collect::<Vec<_>>();
    if left_fields.len() < 5 {
        return None;
    }
    let mut right_fields = right.split_whitespace();
    let fstype = right_fields.next()?;
    let source = right_fields.next().unwrap_or("");

    Some(MountInfoEntry {
        target: mountinfo_unescape(left_fields[4]),
        source: mountinfo_unescape(source),
        fstype: mountinfo_unescape(fstype),
    })
}

fn mountinfo_unescape(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'\\'
            && index + 3 < bytes.len()
            && bytes[index + 1..=index + 3]
                .iter()
                .all(|byte| byte.is_ascii_digit())
        {
            let octal = &value[index + 1..=index + 3];
            if let Ok(byte) = u8::from_str_radix(octal, 8) {
                output.push(char::from(byte));
                index += 4;
                continue;
            }
        }

        output.push(char::from(bytes[index]));
        index += 1;
    }

    output
}

fn redacted_mount_source(source: &str) -> String {
    if source.starts_with("/dev/") {
        return safe_operational_value(source);
    }
    if source.starts_with('/') {
        return "path-redacted".to_owned();
    }
    safe_operational_value(source)
}

fn safe_operational_value(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(160)
        .collect()
}

fn block_device_name_from_mount_source(source: &str) -> Option<String> {
    if !source.starts_with("/dev/") {
        return None;
    }

    let device_path = std::fs::canonicalize(source).unwrap_or_else(|_| PathBuf::from(source));
    let device_name = device_path.file_name()?.to_str()?;
    let base_name = base_block_device_name(device_name);
    let candidate = if FsPath::new("/sys/block").join(&base_name).exists() {
        base_name
    } else {
        device_name.to_owned()
    };

    is_safe_block_device_name(&candidate).then_some(candidate)
}

fn base_block_device_name(device_name: &str) -> String {
    if device_name.starts_with("nvme") || device_name.starts_with("mmcblk") {
        if let Some(index) = device_name.rfind('p') {
            let suffix = &device_name[index + 1..];
            if !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()) {
                return device_name[..index].to_owned();
            }
        }
    }

    if device_name.starts_with("sd")
        || device_name.starts_with("vd")
        || device_name.starts_with("xvd")
        || device_name.starts_with("hd")
    {
        let trimmed = device_name.trim_end_matches(|ch: char| ch.is_ascii_digit());
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }

    device_name.to_owned()
}

fn is_safe_block_device_name(device_name: &str) -> bool {
    !device_name.is_empty()
        && device_name.len() <= 80
        && device_name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.'
        })
}

fn rotational_flag_for_block_device(device_name: &str) -> Option<bool> {
    for path in [
        PathBuf::from(format!("/sys/block/{device_name}/queue/rotational")),
        PathBuf::from(format!("/sys/class/block/{device_name}/queue/rotational")),
    ] {
        if let Ok(value) = std::fs::read_to_string(path) {
            match value.trim() {
                "0" => return Some(false),
                "1" => return Some(true),
                _ => {}
            }
        }
    }

    None
}

fn infer_storage_tier(
    block_device_name: Option<&str>,
    rotational: Option<bool>,
) -> InferredStorageTier {
    if block_device_name.is_some_and(|device| device.starts_with("nvme")) {
        return InferredStorageTier::Nvme;
    }

    if rotational == Some(false) {
        return InferredStorageTier::Ssd;
    }

    InferredStorageTier::Unknown
}

fn validate_warm_request(
    request: &WarmRequest,
    max_artifacts: usize,
) -> std::result::Result<Vec<(String, PlaybackArtifact)>, WarmRequestError> {
    if !is_safe_asset_id(&request.asset_id) {
        return Err(WarmRequestError::BadRequest(
            "asset_id must use the playback asset id character set".to_owned(),
        ));
    }

    if request.artifact_paths.is_empty() {
        return Err(WarmRequestError::BadRequest(
            "artifact_paths must include at least one playback artifact".to_owned(),
        ));
    }

    if request.artifact_paths.len() > max_artifacts {
        return Err(WarmRequestError::BadRequest(format!(
            "artifact_paths must include at most {max_artifacts} entries"
        )));
    }

    let mut entries = Vec::with_capacity(request.artifact_paths.len());
    for artifact_path in &request.artifact_paths {
        let artifact = map_playback_artifact(&request.asset_id, artifact_path).map_err(|_| {
            WarmRequestError::BadRequest(format!(
                "unsupported playback artifact path: {artifact_path}"
            ))
        })?;
        entries.push((artifact_path.clone(), artifact));
    }

    Ok(entries)
}

async fn warm_artifact(
    state: &AppState,
    artifact_path: String,
    artifact: PlaybackArtifact,
) -> WarmEntryResponse {
    let cache_path = state.config.cache_dir.join(&artifact.cache_key);

    match valid_cache_file_size(&cache_path).await {
        Ok(Some(byte_size)) => {
            return warm_entry(
                artifact_path,
                artifact,
                WarmEntryStatus::AlreadyWarm,
                Some(byte_size),
                None,
            );
        }
        Ok(None) => {}
        Err(message) => {
            tracing::warn!(
                artifact_path,
                object_key = %artifact.object_key,
                error = %message,
                "failed to inspect edge cache before warming",
            );
            return warm_entry(
                artifact_path,
                artifact,
                WarmEntryStatus::Failed,
                None,
                Some(message),
            );
        }
    }

    let bytes = match fetch_origin_artifact(state, &artifact).await {
        Ok(bytes) => bytes,
        Err(PlaybackError::OriginNotFound(message)) => {
            return warm_entry(
                artifact_path,
                artifact,
                WarmEntryStatus::NotFound,
                None,
                Some(message),
            );
        }
        Err(error) => {
            let message = error.log_message();
            tracing::warn!(
                artifact_path,
                object_key = %artifact.object_key,
                error = %message,
                "failed to fetch origin artifact for warming",
            );
            return warm_entry(
                artifact_path,
                artifact,
                WarmEntryStatus::Failed,
                None,
                Some(message),
            );
        }
    };

    let byte_size = u64::try_from(bytes.len()).ok();
    if let Err(error) = write_cache_file(state, &cache_path, &bytes).await {
        let message = error.log_message();
        tracing::warn!(
            artifact_path,
            object_key = %artifact.object_key,
            error = %message,
            "failed to write warmed artifact into edge cache",
        );
        return warm_entry(
            artifact_path,
            artifact,
            WarmEntryStatus::Failed,
            byte_size,
            Some(message),
        );
    }

    warm_entry(
        artifact_path,
        artifact,
        WarmEntryStatus::Warmed,
        byte_size,
        None,
    )
}

async fn valid_cache_file_size(path: &FsPath) -> std::result::Result<Option<u64>, String> {
    match fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => Ok(Some(metadata.len())),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "failed to inspect cache file {}: {error}",
            path.display()
        )),
    }
}

fn warm_entry(
    artifact_path: String,
    artifact: PlaybackArtifact,
    status: WarmEntryStatus,
    byte_size: Option<u64>,
    message: Option<String>,
) -> WarmEntryResponse {
    WarmEntryResponse {
        artifact_path,
        object_key: artifact.object_key,
        cache_key: artifact.cache_key,
        status,
        byte_size,
        message,
    }
}

fn validate_playback_request(
    keyring: &SingleKeyring,
    asset_id: &str,
    artifact_path: &str,
    token: Option<&str>,
    now: u64,
) -> std::result::Result<PlaybackClaims, PlaybackError> {
    let token = token.ok_or(PlaybackError::Unauthorized)?;
    validate_playback_token(token, asset_id, artifact_path, now, keyring)
        .map_err(|_| PlaybackError::Unauthorized)
}

fn playback_token_cookie(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        let value = value.trim();
        (name.trim() == PLAYBACK_COOKIE_NAME && !value.is_empty() && value.len() <= 4096)
            .then(|| value.to_owned())
    })
}

fn playback_cors_origin<'a>(config: &EdgeConfig, headers: &'a HeaderMap) -> Option<&'a str> {
    let origin = headers.get(header::ORIGIN)?.to_str().ok()?;
    let is_configured_origin = config
        .cors_allowed_origins
        .iter()
        .any(|allowed| allowed.as_str() == origin);
    (is_configured_origin || is_trusted_rend_cors_origin(origin)).then_some(origin)
}

fn is_trusted_rend_cors_origin(origin: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(origin) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.path() != "" && parsed.path() != "/")
    {
        return false;
    }
    let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    host == "rend.so" || host.ends_with(".rend.so")
}

fn playback_timing_allow_origin(
    cors_origin: Option<&str>,
    artifact: &PlaybackArtifact,
) -> Option<&'static str> {
    let is_hls_timing_resource = matches!(
        artifact.content_type,
        "application/vnd.apple.mpegurl" | "video/mp2t"
    ) || is_range_media_content_type(artifact);
    (is_hls_timing_resource && cors_origin == Some(PLAYBACK_TIMING_ALLOW_ORIGIN))
        .then_some(PLAYBACK_TIMING_ALLOW_ORIGIN)
}

fn artifact_response(
    config: &EdgeConfig,
    artifact: &PlaybackArtifact,
    cache_status: &'static str,
    body: Body,
    content_length: Option<u64>,
    cors_origin: Option<&str>,
) -> Response {
    artifact_response_with_status(
        config,
        artifact,
        cache_status,
        StatusCode::OK,
        body,
        content_length,
        None,
        cors_origin,
    )
}

fn artifact_response_with_status(
    config: &EdgeConfig,
    artifact: &PlaybackArtifact,
    cache_status: &'static str,
    status: StatusCode,
    body: Body,
    content_length: Option<u64>,
    content_range: Option<&str>,
    cors_origin: Option<&str>,
) -> Response {
    let content_type = artifact.content_type;
    let is_range_media = is_range_media_content_type(artifact);
    let expose_headers = if is_range_media {
        "accept-ranges, cache-control, content-length, content-range, content-type, x-rend-cache, x-rend-edge-id, x-rend-region"
    } else {
        "cache-control, content-length, content-type, x-rend-cache, x-rend-edge-id, x-rend-region"
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CACHE_CONTROL,
            playback_artifact_cache_control(content_type),
        )
        .header("x-rend-cache", cache_status)
        .header("x-rend-edge-id", &config.edge_id)
        .header("x-rend-region", &config.region)
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, expose_headers);

    if is_range_media {
        builder = builder.header(header::ACCEPT_RANGES, "bytes");
    }

    if let Some(origin) = cors_origin {
        builder = builder
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, "true")
            .header(header::VARY, "Origin");
    }
    if let Some(origin) = playback_timing_allow_origin(cors_origin, artifact) {
        builder = builder.header("timing-allow-origin", origin);
    }

    if let Some(content_length) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, content_length.to_string());
    }
    if let Some(content_range) = content_range {
        builder = builder.header(header::CONTENT_RANGE, content_range);
    }

    builder
        .body(body)
        .expect("artifact response headers are static and valid")
}

fn range_not_satisfiable_response(
    config: &EdgeConfig,
    artifact: &PlaybackArtifact,
    cache_status: &'static str,
    content_length: u64,
    cors_origin: Option<&str>,
) -> Response {
    artifact_response_with_status(
        config,
        artifact,
        cache_status,
        StatusCode::RANGE_NOT_SATISFIABLE,
        Body::empty(),
        Some(0),
        Some(&format!("bytes */{content_length}")),
        cors_origin,
    )
}

fn playback_artifact_cache_control(content_type: &str) -> &'static str {
    match content_type {
        "application/vnd.apple.mpegurl" => "private, max-age=60, stale-while-revalidate=300",
        "video/mp4" | "video/mp2t" => "private, max-age=31536000, immutable",
        _ => "no-store",
    }
}

async fn fetch_origin_artifact(
    state: &AppState,
    artifact: &PlaybackArtifact,
) -> std::result::Result<Vec<u8>, PlaybackError> {
    let object = state
        .s3
        .get_object()
        .bucket(&state.config.s3_bucket)
        .key(&artifact.object_key)
        .send()
        .await
        .map_err(|error| origin_get_error(artifact, error))?;
    if let Some(content_length) = object.content_length() {
        ensure_origin_artifact_size_allowed(
            state,
            &artifact.object_key,
            u64::try_from(content_length).unwrap_or(u64::MAX),
        )?;
    }

    let bytes = object.body.collect().await.map_err(|error| {
        PlaybackError::Origin(format!(
            "failed to read artifact {} from origin: {error}",
            artifact.object_key
        ))
    })?;
    let bytes = bytes.into_bytes();
    ensure_origin_artifact_size_allowed(
        state,
        &artifact.object_key,
        u64::try_from(bytes.len()).unwrap_or(u64::MAX),
    )?;

    Ok(bytes.to_vec())
}

fn origin_get_error<R>(
    artifact: &PlaybackArtifact,
    error: aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::get_object::GetObjectError, R>,
) -> PlaybackError {
    if error
        .as_service_error()
        .is_some_and(|service_error| service_error.is_no_such_key())
    {
        PlaybackError::OriginNotFound(format!(
            "artifact {} was not found in origin",
            artifact.object_key
        ))
    } else {
        PlaybackError::Origin(format!(
            "failed to fetch artifact {} from origin: {error}",
            artifact.object_key
        ))
    }
}

fn ensure_origin_artifact_size_allowed(
    state: &AppState,
    object_key: &str,
    byte_size: u64,
) -> std::result::Result<(), PlaybackError> {
    if byte_size > state.config.max_origin_artifact_bytes {
        return Err(PlaybackError::Origin(format!(
            "origin artifact {object_key} is {byte_size} bytes, exceeding REND_EDGE_MAX_ORIGIN_ARTIFACT_BYTES ({})",
            state.config.max_origin_artifact_bytes
        )));
    }

    Ok(())
}

async fn write_cache_file(
    state: &AppState,
    path: &FsPath,
    bytes: &[u8],
) -> std::result::Result<(), PlaybackError> {
    let byte_len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    ensure_cache_object_size_allowed(state, byte_len)?;
    let _maintenance = state.cache_maintenance.lock().await;
    let mut prepared = prepare_cache_write(
        state,
        &path_relative_to_cache(&state.config.cache_dir, path),
        path.to_path_buf(),
        byte_len,
        byte_len,
        None,
    )
    .await?;
    let write_result = async {
        prepared.file.write_all(bytes).await?;
        Ok::<_, std::io::Error>(())
    }
    .await;

    if let Err(error) = write_result {
        let display_path = prepared.cache_path.display().to_string();
        cleanup_prepared_cache_write(prepared).await;
        return Err(PlaybackError::Io(format!(
            "failed to write cache file {display_path}: {error}"
        )));
    }

    let cache_key = path_relative_to_cache(&state.config.cache_dir, path);
    commit_prepared_cache_write(state, &cache_key, prepared, byte_len).await
}

fn ensure_cache_object_size_allowed(
    state: &AppState,
    byte_len: u64,
) -> std::result::Result<(), PlaybackError> {
    if let Some(max_bytes) = state.config.cache_max_bytes
        && byte_len > max_bytes
    {
        return Err(PlaybackError::Overloaded(format!(
            "edge cache size guard refused write: artifact {byte_len} bytes exceeds REND_EDGE_CACHE_MAX_BYTES ({max_bytes})"
        )));
    }

    Ok(())
}

async fn prepare_cache_write(
    state: &AppState,
    cache_key: &str,
    cache_path: PathBuf,
    additional_bytes: u64,
    reserved_bytes: u64,
    active_guard: Option<ActiveStreamGuard>,
) -> std::result::Result<PreparedCacheWrite, PlaybackError> {
    fs::create_dir_all(&state.config.cache_dir)
        .await
        .map_err(|error| {
            PlaybackError::Io(format!(
                "failed to create cache directory {}: {error}",
                state.config.cache_dir.display()
            ))
        })?;
    evict_for_cache_write(state, additional_bytes).await?;

    let parent = cache_path.parent().ok_or_else(|| {
        PlaybackError::Io(format!("cache path {} has no parent", cache_path.display()))
    })?;
    fs::create_dir_all(parent).await.map_err(|error| {
        PlaybackError::Io(format!(
            "failed to create cache directory {}: {error}",
            parent.display()
        ))
    })?;

    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        cache_path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .unwrap_or("artifact"),
        temp_file_suffix()
    ));
    let file = fs::File::create(&temp_path).await.map_err(|error| {
        PlaybackError::Io(format!(
            "failed to create cache temp file {} for {}: {error}",
            temp_path.display(),
            cache_key
        ))
    })?;

    Ok(PreparedCacheWrite {
        cache_path,
        temp_path,
        file,
        reserved_bytes,
        active_guard,
    })
}

async fn ensure_streamed_cache_size_allowed(
    state: &AppState,
    prepared: &PreparedCacheWrite,
    bytes_written: u64,
) -> std::result::Result<(), PlaybackError> {
    if prepared.reserved_bytes == 0 {
        ensure_cache_object_size_allowed(state, bytes_written)?;
        let _maintenance = state.cache_maintenance.lock().await;
        evict_for_cache_write(state, bytes_written).await?;
    }

    Ok(())
}

async fn cleanup_prepared_cache_write(prepared: PreparedCacheWrite) {
    let PreparedCacheWrite {
        temp_path,
        file,
        active_guard: _active_guard,
        ..
    } = prepared;
    drop(file);
    let _ = fs::remove_file(temp_path).await;
}

async fn commit_prepared_cache_write(
    state: &AppState,
    cache_key: &str,
    prepared: PreparedCacheWrite,
    byte_len: u64,
) -> std::result::Result<(), PlaybackError> {
    let PreparedCacheWrite {
        cache_path,
        temp_path,
        mut file,
        active_guard: _active_guard,
        ..
    } = prepared;

    let commit_result = async {
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(&temp_path, &cache_path).await?;
        Ok::<_, std::io::Error>(())
    }
    .await;

    if let Err(error) = commit_result {
        let _ = fs::remove_file(&temp_path).await;
        return Err(PlaybackError::Io(format!(
            "failed to write cache file {}: {error}",
            cache_path.display()
        )));
    }

    if let Err(error) = write_cache_metadata(state, cache_key, byte_len, now_unix_ms()).await {
        let _ = fs::remove_file(&cache_path).await;
        return Err(error);
    }

    Ok(())
}

async fn evict_for_cache_write(
    state: &AppState,
    additional_bytes: u64,
) -> std::result::Result<(), PlaybackError> {
    let protected_keys = state.active_streams.keys();
    let mut current_size = cache_dir_size_bytes(state.config.cache_dir.clone()).await?;
    let mut available = cache_available_space(&state.config.cache_dir).await?;
    let future_bytes = state
        .active_streams
        .reserved_bytes()
        .saturating_add(additional_bytes);
    let mut candidates =
        collect_cache_eviction_candidates(state.config.cache_dir.clone(), protected_keys).await?;
    candidates.sort_by(compare_eviction_candidates);

    for candidate in candidates {
        let projected_size = current_size.saturating_add(future_bytes);
        let needs_size_eviction = state
            .config
            .cache_max_bytes
            .is_some_and(|max_bytes| projected_size > max_bytes);
        let needs_free_eviction =
            available < future_bytes.saturating_add(state.config.cache_min_free_bytes);
        if !needs_size_eviction && !needs_free_eviction {
            break;
        }

        match remove_cache_candidate(state, &candidate).await {
            Ok(true) => {
                current_size = current_size.saturating_sub(candidate.size_bytes);
                available = available.saturating_add(candidate.size_bytes);
            }
            Ok(false) => {}
            Err(error) => return Err(error),
        }
    }

    if let Some(max_bytes) = state.config.cache_max_bytes {
        let projected_size = current_size.saturating_add(future_bytes);
        if projected_size > max_bytes {
            return Err(PlaybackError::Overloaded(format!(
                "edge cache size guard refused write: current {current_size} bytes + reserved {future_bytes} bytes exceeds REND_EDGE_CACHE_MAX_BYTES ({max_bytes})"
            )));
        }
    }

    let required_available = future_bytes.saturating_add(state.config.cache_min_free_bytes);
    if available < required_available {
        return Err(PlaybackError::Overloaded(format!(
            "edge cache free-space guard refused write: available {available} bytes, required {future_bytes} bytes, reserve {} bytes",
            state.config.cache_min_free_bytes
        )));
    }

    Ok(())
}

async fn remove_cache_candidate(
    state: &AppState,
    candidate: &CacheEvictionCandidate,
) -> std::result::Result<bool, PlaybackError> {
    match fs::remove_file(&candidate.path).await {
        Ok(()) => {
            let _ = fs::remove_file(&candidate.metadata_path).await;
            state
                .metrics
                .cache_evictions
                .fetch_add(1, Ordering::Relaxed);
            state
                .metrics
                .cache_evicted_bytes
                .fetch_add(candidate.size_bytes, Ordering::Relaxed);
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => {
            state
                .metrics
                .cache_eviction_errors
                .fetch_add(1, Ordering::Relaxed);
            Err(PlaybackError::Io(format!(
                "failed to evict cache file {}: {error}",
                candidate.path.display()
            )))
        }
    }
}

fn compare_eviction_candidates(
    left: &CacheEvictionCandidate,
    right: &CacheEvictionCandidate,
) -> std::cmp::Ordering {
    left.priority
        .cmp(&right.priority)
        .then_with(|| left.last_access_unix_ms.cmp(&right.last_access_unix_ms))
        .then_with(|| {
            right
                .segment_index
                .unwrap_or(0)
                .cmp(&left.segment_index.unwrap_or(0))
        })
        .then_with(|| left.cache_key.cmp(&right.cache_key))
}

async fn cache_dir_size_bytes(cache_dir: PathBuf) -> std::result::Result<u64, PlaybackError> {
    let display_path = cache_dir.display().to_string();
    tokio::task::spawn_blocking(move || dir_size_bytes(&cache_dir, &cache_dir))
        .await
        .map_err(|error| PlaybackError::Io(format!("failed to join cache size check: {error}")))?
        .map_err(|error| {
            PlaybackError::Io(format!(
                "failed to inspect cache directory size {display_path}: {error}"
            ))
        })
}

async fn cache_available_space(cache_dir: &FsPath) -> std::result::Result<u64, PlaybackError> {
    let cache_dir = cache_dir.to_path_buf();
    tokio::task::spawn_blocking(move || fs2::available_space(cache_dir))
        .await
        .map_err(|error| PlaybackError::Io(format!("failed to join free-space check: {error}")))?
        .map_err(|error| PlaybackError::Io(format!("failed to inspect cache free space: {error}")))
}

async fn collect_cache_eviction_candidates(
    cache_dir: PathBuf,
    protected_keys: HashSet<String>,
) -> std::result::Result<Vec<CacheEvictionCandidate>, PlaybackError> {
    let display_path = cache_dir.display().to_string();
    tokio::task::spawn_blocking(move || {
        let mut candidates = Vec::new();
        collect_cache_eviction_candidates_sync(
            &cache_dir,
            &cache_dir,
            &protected_keys,
            &mut candidates,
        )?;
        Ok::<_, std::io::Error>(candidates)
    })
    .await
    .map_err(|error| PlaybackError::Io(format!("failed to join cache eviction scan: {error}")))?
    .map_err(|error| {
        PlaybackError::Io(format!(
            "failed to inspect cache directory {display_path}: {error}"
        ))
    })
}

fn dir_size_bytes(cache_dir: &FsPath, path: &FsPath) -> std::io::Result<u64> {
    let mut total = 0u64;
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            if is_cache_metadata_path(cache_dir, &path) {
                continue;
            }
            total = total.saturating_add(dir_size_bytes(cache_dir, &path)?);
        } else if metadata.is_file() && should_count_cache_file(cache_dir, &path) {
            total = total.saturating_add(metadata.len());
        }
    }

    Ok(total)
}

fn collect_cache_eviction_candidates_sync(
    cache_dir: &FsPath,
    path: &FsPath,
    protected_keys: &HashSet<String>,
    candidates: &mut Vec<CacheEvictionCandidate>,
) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            if !is_cache_metadata_path(cache_dir, &path) {
                collect_cache_eviction_candidates_sync(
                    cache_dir,
                    &path,
                    protected_keys,
                    candidates,
                )?;
            }
            continue;
        }

        if !metadata.is_file() || !should_count_cache_file(cache_dir, &path) {
            continue;
        }

        let Some(cache_key) = path
            .strip_prefix(cache_dir)
            .ok()
            .and_then(path_to_slash_string)
        else {
            continue;
        };
        if protected_keys.contains(&cache_key) {
            continue;
        }

        let metadata_path = cache_metadata_path(cache_dir, &cache_key);
        let last_access_unix_ms = file_modified_unix_ms(&metadata).unwrap_or_default();
        let cache_metadata =
            read_cache_metadata_sync(&metadata_path, &cache_key).unwrap_or_else(|| {
                derive_cache_metadata(&cache_key, metadata.len(), last_access_unix_ms)
            });
        candidates.push(CacheEvictionCandidate {
            cache_key,
            path,
            metadata_path,
            size_bytes: metadata.len(),
            last_access_unix_ms: cache_metadata.last_access_unix_ms,
            priority: cache_metadata.priority,
            segment_index: cache_metadata.segment_index,
        });
    }

    Ok(())
}

fn is_cache_metadata_path(cache_dir: &FsPath, path: &FsPath) -> bool {
    path.starts_with(cache_metadata_root(cache_dir))
}

fn should_count_cache_file(cache_dir: &FsPath, path: &FsPath) -> bool {
    !is_cache_metadata_path(cache_dir, path) && !is_hidden_cache_file(path)
}

fn is_hidden_cache_file(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|file_name| file_name.to_str())
        .is_some_and(|file_name| file_name.starts_with('.'))
}

fn cache_metadata_root(cache_dir: &FsPath) -> PathBuf {
    cache_dir.join(CACHE_METADATA_DIR_NAME)
}

fn cache_metadata_path(cache_dir: &FsPath, cache_key: &str) -> PathBuf {
    cache_metadata_root(cache_dir).join(format!("{cache_key}.json"))
}

fn read_cache_metadata_sync(path: &FsPath, cache_key: &str) -> Option<CacheObjectMetadata> {
    let bytes = std::fs::read(path).ok()?;
    let metadata = serde_json::from_slice::<CacheObjectMetadata>(&bytes).ok()?;
    (metadata.version == CACHE_METADATA_VERSION && metadata.cache_key == cache_key)
        .then_some(metadata)
}

async fn touch_cache_metadata(
    state: &AppState,
    cache_key: &str,
    size_bytes: u64,
) -> std::result::Result<(), PlaybackError> {
    write_cache_metadata(state, cache_key, size_bytes, now_unix_ms()).await
}

async fn write_cache_metadata(
    state: &AppState,
    cache_key: &str,
    size_bytes: u64,
    last_access_unix_ms: u64,
) -> std::result::Result<(), PlaybackError> {
    let metadata = derive_cache_metadata(cache_key, size_bytes, last_access_unix_ms);
    let metadata_path = cache_metadata_path(&state.config.cache_dir, cache_key);
    let parent = metadata_path.parent().ok_or_else(|| {
        PlaybackError::Io(format!(
            "cache metadata path {} has no parent",
            metadata_path.display()
        ))
    })?;
    fs::create_dir_all(parent).await.map_err(|error| {
        PlaybackError::Io(format!(
            "failed to create cache metadata directory {}: {error}",
            parent.display()
        ))
    })?;
    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        metadata_path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .unwrap_or("metadata"),
        temp_file_suffix()
    ));
    let bytes = serde_json::to_vec(&metadata).map_err(|error| {
        PlaybackError::Io(format!("failed to serialize cache metadata: {error}"))
    })?;

    let write_result = async {
        let mut file = fs::File::create(&temp_path).await?;
        file.write_all(&bytes).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(&temp_path, &metadata_path).await?;
        Ok::<_, std::io::Error>(())
    }
    .await;

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path).await;
        return Err(PlaybackError::Io(format!(
            "failed to write cache metadata {}: {error}",
            metadata_path.display()
        )));
    }

    Ok(())
}

fn derive_cache_metadata(
    cache_key: &str,
    size_bytes: u64,
    last_access_unix_ms: u64,
) -> CacheObjectMetadata {
    let (artifact_type, segment_index) = cache_artifact_type(cache_key);
    CacheObjectMetadata {
        version: CACHE_METADATA_VERSION,
        cache_key: cache_key.to_owned(),
        size_bytes,
        last_access_unix_ms,
        artifact_type,
        priority: cache_artifact_priority(artifact_type, segment_index),
        segment_index,
    }
}

fn cache_artifact_type(cache_key: &str) -> (CacheArtifactType, Option<u32>) {
    match cache_key.split('/').collect::<Vec<_>>().as_slice() {
        ["videos", asset_id, "opener.mp4"] if is_safe_asset_id(asset_id) => {
            (CacheArtifactType::Opener, None)
        }
        ["videos", asset_id, "hls", "master.m3u8"] if is_safe_asset_id(asset_id) => {
            (CacheArtifactType::Manifest, None)
        }
        ["videos", asset_id, "hls", segment_name]
            if is_safe_asset_id(asset_id) && is_valid_hls_segment_name(segment_name) =>
        {
            (
                CacheArtifactType::Segment,
                segment_index_from_name(segment_name),
            )
        }
        ["videos", asset_id, "hls", rendition_name, init_name]
            if is_safe_asset_id(asset_id)
                && is_valid_hls_rendition_name(rendition_name)
                && is_valid_hls_init_segment_name_for_rendition(init_name, rendition_name) =>
        {
            (CacheArtifactType::Segment, None)
        }
        ["videos", asset_id, "hls", rendition_name, "index.m3u8"]
            if is_safe_asset_id(asset_id) && is_valid_hls_rendition_name(rendition_name) =>
        {
            (CacheArtifactType::Manifest, None)
        }
        ["videos", asset_id, "hls", rendition_name, segment_name]
            if is_safe_asset_id(asset_id)
                && is_valid_hls_rendition_name(rendition_name)
                && is_valid_hls_segment_name(segment_name) =>
        {
            (
                CacheArtifactType::Segment,
                segment_index_from_name(segment_name),
            )
        }
        _ => (CacheArtifactType::Unknown, None),
    }
}

fn cache_artifact_priority(artifact_type: CacheArtifactType, segment_index: Option<u32>) -> u16 {
    match artifact_type {
        CacheArtifactType::Manifest => 1000,
        CacheArtifactType::Segment
            if segment_index.is_some_and(|index| index < FIRST_SEGMENT_KEEP_COUNT) =>
        {
            900
        }
        CacheArtifactType::Opener => 500,
        CacheArtifactType::Segment => 400,
        CacheArtifactType::Unknown => 0,
    }
}

fn segment_index_from_name(segment_name: &str) -> Option<u32> {
    let name = segment_name.strip_prefix("segment_")?;
    name.strip_suffix(".ts")
        .or_else(|| name.strip_suffix(".m4s"))?
        .parse::<u32>()
        .ok()
}

fn file_modified_unix_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn temp_file_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}.{nanos}", std::process::id())
}

fn map_playback_artifact(
    asset_id: &str,
    artifact_path: &str,
) -> std::result::Result<PlaybackArtifact, PlaybackError> {
    if !is_safe_asset_id(asset_id) {
        return Err(PlaybackError::NotFound(
            "unsupported playback path".to_owned(),
        ));
    }

    match artifact_path.split('/').collect::<Vec<_>>().as_slice() {
        ["opener.mp4"] => Ok(playback_artifact(asset_id, "opener.mp4", "video/mp4")),
        ["hls", "master.m3u8"] => Ok(playback_artifact(
            asset_id,
            "hls/master.m3u8",
            "application/vnd.apple.mpegurl",
        )),
        ["hls", segment_name] if is_valid_hls_segment_name(segment_name) => Ok(playback_artifact(
            asset_id,
            &format!("hls/{segment_name}"),
            hls_segment_content_type(segment_name),
        )),
        ["hls", rendition_name, "index.m3u8"] if is_valid_hls_rendition_name(rendition_name) => {
            Ok(playback_artifact(
                asset_id,
                &format!("hls/{rendition_name}/index.m3u8"),
                "application/vnd.apple.mpegurl",
            ))
        }
        ["hls", rendition_name, segment_name]
            if is_valid_hls_rendition_name(rendition_name)
                && is_valid_hls_segment_name(segment_name) =>
        {
            Ok(playback_artifact(
                asset_id,
                &format!("hls/{rendition_name}/{segment_name}"),
                hls_segment_content_type(segment_name),
            ))
        }
        ["hls", rendition_name, init_name]
            if is_valid_hls_rendition_name(rendition_name)
                && is_valid_hls_init_segment_name_for_rendition(init_name, rendition_name) =>
        {
            Ok(playback_artifact(
                asset_id,
                &format!("hls/{rendition_name}/{init_name}"),
                "video/mp4",
            ))
        }
        _ => Err(PlaybackError::NotFound(
            "unsupported playback path".to_owned(),
        )),
    }
}

fn hls_segment_content_type(segment_name: &str) -> &'static str {
    if segment_name.ends_with(".m4s") {
        "video/mp4"
    } else {
        "video/mp2t"
    }
}

fn playback_artifact(
    asset_id: &str,
    artifact_path: &str,
    content_type: &'static str,
) -> PlaybackArtifact {
    let object_key = format!("videos/{asset_id}/{artifact_path}");
    PlaybackArtifact {
        cache_key: object_key.clone(),
        object_key,
        content_type,
    }
}

fn is_safe_asset_id(asset_id: &str) -> bool {
    !asset_id.is_empty()
        && asset_id.len() <= MAX_ASSET_ID_LEN
        && asset_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

async fn internal_placeholder() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(PlaceholderResponse {
            status: "not_implemented",
            message: "Internal edge operations are placeholders in the foundation slice.",
        }),
    )
        .into_response()
}

async fn require_internal_token(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get("x-rend-internal-token")
        .and_then(|value| value.to_str().ok());

    if provided == Some(state.config.internal_token.as_str()) {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "status": "unauthorized",
                "message": "internal edge endpoint requires x-rend-internal-token"
            })),
        )
            .into_response()
    }
}

async fn check_cache_dir(state: &AppState) -> DependencyCheck {
    let started = Instant::now();
    let probe_path = state.config.cache_dir.join(".readyz");
    let result = async {
        fs::create_dir_all(&state.config.cache_dir).await?;
        fs::write(&probe_path, b"ok").await?;
        let _ = fs::remove_file(&probe_path).await;
        Ok::<_, anyhow::Error>(())
    }
    .await;

    match result {
        Ok(()) => ok_check("cache_dir", started),
        Err(error) => failed_check("cache_dir", started, error),
    }
}

async fn check_origin(state: &AppState) -> DependencyCheck {
    let started = Instant::now();
    let result = state
        .http
        .get(&state.config.origin_health_url)
        .send()
        .await
        .and_then(|response| response.error_for_status());

    match result {
        Ok(_) => ok_check("origin", started),
        Err(error) => failed_check("origin", started, error),
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
        .unwrap_or_else(|_| EnvFilter::new("rend_edge=info,tower_http=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

impl IntoResponse for PlaybackError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            PlaybackError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized playback token".to_owned(),
            ),
            PlaybackError::NotFound(message) | PlaybackError::OriginNotFound(message) => {
                (StatusCode::NOT_FOUND, message)
            }
            PlaybackError::Origin(message) => {
                tracing::warn!(error = %message, "origin artifact fetch failed");
                (
                    StatusCode::BAD_GATEWAY,
                    "failed to fetch artifact from origin".to_owned(),
                )
            }
            PlaybackError::Io(message) => {
                tracing::error!(error = %message, "edge cache operation failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "edge cache operation failed".to_owned(),
                )
            }
            PlaybackError::Overloaded(message) => {
                tracing::warn!(error = %message, "edge cache fill registry is full");
                (StatusCode::SERVICE_UNAVAILABLE, message)
            }
        };

        (status, Json(ErrorResponse { error: message })).into_response()
    }
}

impl PlaybackError {
    fn log_message(&self) -> String {
        match self {
            PlaybackError::Unauthorized => "unauthorized playback token".to_owned(),
            PlaybackError::NotFound(message)
            | PlaybackError::OriginNotFound(message)
            | PlaybackError::Origin(message)
            | PlaybackError::Io(message)
            | PlaybackError::Overloaded(message) => message.to_owned(),
        }
    }

    fn telemetry_error_code(&self) -> &'static str {
        match self {
            PlaybackError::Unauthorized => "unauthorized",
            PlaybackError::NotFound(_) => "not_found",
            PlaybackError::OriginNotFound(_) => "origin_not_found",
            PlaybackError::Origin(_) => "origin",
            PlaybackError::Io(_) => "cache_io",
            PlaybackError::Overloaded(_) => "overloaded",
        }
    }
}

impl IntoResponse for WarmRequestError {
    fn into_response(self) -> Response {
        match self {
            WarmRequestError::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse { error: message }),
            )
                .into_response(),
        }
    }
}

impl IntoResponse for PurgeRequestError {
    fn into_response(self) -> Response {
        match self {
            PurgeRequestError::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse { error: message }),
            )
                .into_response(),
        }
    }
}

impl IntoResponse for CacheInspectRequestError {
    fn into_response(self) -> Response {
        match self {
            CacheInspectRequestError::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse { error: message }),
            )
                .into_response(),
            CacheInspectRequestError::Internal(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: message }),
            )
                .into_response(),
        }
    }
}

#[cfg(test)]
mod tests;
