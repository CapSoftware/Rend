use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use aws_sdk_s3::{
    Client as S3Client,
    config::{BehaviorVersion, Credentials, Region, RequestChecksumCalculation},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rend_config::{
    ExpectedEdges, RendEnv, env_bool, env_duration_secs, env_path, env_socket_addr, env_string,
    env_u64, env_usize, load_dotenv, optional_env_url,
    validate_edge_base_url as validate_config_edge_base_url, validate_required_secret,
    validate_required_url,
};
use rend_playback_auth::{
    SingleKeyring, current_unix_timestamp, is_valid_hls_segment_name, validate_playback_token,
};
use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt, net::TcpListener, sync::Notify};
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

mod telemetry;

const DEFAULT_WARM_MAX_ARTIFACTS: usize = 4;
const HARD_WARM_MAX_ARTIFACTS: usize = 16;
const DEFAULT_MAX_IN_FLIGHT_FILLS: usize = 64;
const HARD_MAX_IN_FLIGHT_FILLS: usize = 1024;
const INTERNAL_REQUEST_BODY_LIMIT_BYTES: usize = 16 * 1024;
const MAX_ASSET_ID_LEN: usize = 128;
const DEFAULT_CONTROL_PLANE_HEARTBEAT_INTERVAL_SECS: u64 = 15;
const DEFAULT_MAX_ORIGIN_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_CACHE_MIN_FREE_BYTES: u64 = 64 * 1024 * 1024;

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
        validate_required_url(
            rend_env,
            "S3_ENDPOINT",
            &env_string("S3_ENDPOINT", "http://localhost:9100"),
        )?;
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
            s3_endpoint: env_string("S3_ENDPOINT", "http://localhost:9100"),
            s3_region: env_string("S3_REGION", "us-east-1"),
            s3_bucket: env_string("S3_BUCKET", "rend-local"),
            aws_access_key_id: env_string("AWS_ACCESS_KEY_ID", "rend_minio"),
            aws_secret_access_key: env_string("AWS_SECRET_ACCESS_KEY", "rend_minio_password"),
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
        })
    }
}

#[derive(Clone)]
struct AppState {
    config: EdgeConfig,
    http: reqwest::Client,
    s3: S3Client,
    in_flight_fills: Arc<FillRegistry>,
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

#[derive(Debug, PartialEq, Eq)]
struct PlaybackArtifact {
    object_key: String,
    cache_key: String,
    content_type: &'static str,
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
struct EdgeMetrics {
    cache_hit: std::sync::atomic::AtomicU64,
    cache_miss: std::sync::atomic::AtomicU64,
    cache_coalesced: std::sync::atomic::AtomicU64,
    cache_error: std::sync::atomic::AtomicU64,
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

#[tokio::main]
async fn main() -> Result<()> {
    install_rustls_crypto_provider();
    load_dotenv();
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

fn build_app(state: Arc<AppState>, request_timeout: Duration) -> Router {
    let internal_routes = Router::new()
        .route("/warm", post(warm))
        .route("/purge", post(purge))
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
        .route("/v/{asset_id}/{*artifact_path}", get(playback))
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
         # HELP rend_edge_telemetry_events_total Playback telemetry events by pipeline state.\n\
         # TYPE rend_edge_telemetry_events_total counter\n\
         rend_edge_telemetry_events_total{{edge_id=\"{}\",region=\"{}\",state=\"queued\"}} {}\n\
         rend_edge_telemetry_events_total{{edge_id=\"{}\",region=\"{}\",state=\"sent\"}} {}\n\
         rend_edge_telemetry_events_total{{edge_id=\"{}\",region=\"{}\",state=\"spooled\"}} {}\n\
         rend_edge_telemetry_events_total{{edge_id=\"{}\",region=\"{}\",state=\"dropped\"}} {}\n\
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
) -> Response {
    let started = Instant::now();
    let asset_id = path.asset_id.clone();
    let artifact_path = path.artifact_path.clone();
    let result = playback_inner(state.clone(), path, query.token.as_deref()).await;
    let (response, error_code) = match result {
        Ok(response) => (response, None),
        Err(error) => {
            let error_code = error.telemetry_error_code();
            (error.into_response(), Some(error_code))
        }
    };

    record_playback_telemetry(
        &state,
        &asset_id,
        &artifact_path,
        &response,
        started.elapsed(),
        error_code,
    );
    record_cache_metrics(&state, &response);
    response
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
) -> std::result::Result<Response, PlaybackError> {
    let now = current_unix_timestamp().map_err(|error| PlaybackError::Io(error.to_string()))?;
    validate_playback_request(
        &state.config.playback_keyring,
        &path.asset_id,
        &path.artifact_path,
        token,
        now,
    )?;

    let artifact = map_playback_artifact(&path.asset_id, &path.artifact_path)?;
    let cache_path = state.config.cache_dir.join(&artifact.cache_key);

    if let Some(bytes) = read_cache_file(&cache_path).await? {
        return Ok(artifact_bytes_response(&artifact, "HIT", bytes));
    }

    match state
        .in_flight_fills
        .acquire(&artifact.cache_key, state.config.max_in_flight_fills)?
    {
        FillSlot::Leader(leader) => {
            let result = fill_cache_from_origin(&state, &artifact, &cache_path).await;
            let outcome = match &result {
                Ok(_) => FillOutcome::Succeeded,
                Err(error) => FillOutcome::Failed(error.clone()),
            };
            leader.complete(outcome);

            result?;
            let bytes = read_filled_cache_file(&cache_path).await?;
            Ok(artifact_bytes_response(&artifact, "MISS", bytes))
        }
        FillSlot::Waiter(fill) => {
            wait_for_coalesced_fill(fill).await?;
            let bytes = read_filled_cache_file(&cache_path).await?;
            Ok(artifact_bytes_response(&artifact, "COALESCED", bytes))
        }
    }
}

fn record_playback_telemetry(
    state: &AppState,
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
            asset_id,
            artifact_path,
            edge_id: &state.config.edge_id,
            region: &state.config.region,
            cache_status,
            status_code: response.status().as_u16(),
            bytes_served,
            content_type,
            duration_ms,
            error_code,
        });
}

async fn read_cache_file(path: &FsPath) -> std::result::Result<Option<Vec<u8>>, PlaybackError> {
    match fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(PlaybackError::Io(format!(
            "failed to read cached artifact {}: {error}",
            path.display()
        ))),
    }
}

async fn read_filled_cache_file(path: &FsPath) -> std::result::Result<Vec<u8>, PlaybackError> {
    read_cache_file(path).await?.ok_or_else(|| {
        PlaybackError::Io(format!(
            "filled cache artifact {} was missing before it could be served",
            path.display()
        ))
    })
}

async fn fill_cache_from_origin(
    state: &AppState,
    artifact: &PlaybackArtifact,
    cache_path: &FsPath,
) -> std::result::Result<(), PlaybackError> {
    let bytes = fetch_origin_artifact(state, artifact).await?;
    write_cache_file(state, cache_path, &bytes).await
}

async fn wait_for_coalesced_fill(
    fill: Arc<InFlightFill>,
) -> std::result::Result<(), PlaybackError> {
    match fill.wait().await {
        FillOutcome::Succeeded => Ok(()),
        FillOutcome::Failed(error) => Err(error),
    }
}

fn artifact_bytes_response(
    artifact: &PlaybackArtifact,
    cache_status: &'static str,
    bytes: Vec<u8>,
) -> Response {
    let content_length = u64::try_from(bytes.len()).ok();
    artifact_response(
        artifact.content_type,
        cache_status,
        Body::from(bytes),
        content_length,
    )
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
        Ok(()) => response.purged.push(PurgeEntryResponse {
            artifact_path,
            cache_key: artifact.cache_key,
        }),
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
) -> std::result::Result<(), PlaybackError> {
    let token = token.ok_or(PlaybackError::Unauthorized)?;
    validate_playback_token(token, asset_id, artifact_path, now, keyring)
        .map(|_| ())
        .map_err(|_| PlaybackError::Unauthorized)
}

fn artifact_response(
    content_type: &'static str,
    cache_status: &'static str,
    body: Body,
    content_length: Option<u64>,
) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header("x-rend-cache", cache_status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "content-length, content-type, x-rend-cache",
        );

    if let Some(content_length) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, content_length.to_string());
    }

    builder
        .body(body)
        .expect("artifact response headers are static and valid")
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
        .map_err(|error| {
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
        })?;
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
    ensure_cache_write_allowed(state, bytes.len()).await?;
    let parent = path
        .parent()
        .ok_or_else(|| PlaybackError::Io(format!("cache path {} has no parent", path.display())))?;
    fs::create_dir_all(parent).await.map_err(|error| {
        PlaybackError::Io(format!(
            "failed to create cache directory {}: {error}",
            parent.display()
        ))
    })?;

    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|file_name| file_name.to_str())
            .unwrap_or("artifact"),
        temp_file_suffix()
    ));

    let write_result = async {
        let mut file = fs::File::create(&temp_path).await?;
        file.write_all(bytes).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(&temp_path, path).await?;
        Ok::<_, std::io::Error>(())
    }
    .await;

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path).await;
        return Err(PlaybackError::Io(format!(
            "failed to write cache file {}: {error}",
            path.display()
        )));
    }

    Ok(())
}

async fn ensure_cache_write_allowed(
    state: &AppState,
    byte_len: usize,
) -> std::result::Result<(), PlaybackError> {
    let byte_len = u64::try_from(byte_len).unwrap_or(u64::MAX);
    fs::create_dir_all(&state.config.cache_dir)
        .await
        .map_err(|error| {
            PlaybackError::Io(format!(
                "failed to create cache directory {}: {error}",
                state.config.cache_dir.display()
            ))
        })?;

    if let Some(max_bytes) = state.config.cache_max_bytes {
        let current_size = cache_dir_size_bytes(state.config.cache_dir.clone()).await?;
        if current_size.saturating_add(byte_len) > max_bytes {
            return Err(PlaybackError::Overloaded(format!(
                "edge cache size guard refused write: current {current_size} bytes + artifact {byte_len} bytes exceeds REND_EDGE_CACHE_MAX_BYTES ({max_bytes})"
            )));
        }
    }

    let cache_dir = state.config.cache_dir.clone();
    let min_free_bytes = state.config.cache_min_free_bytes;
    let available = tokio::task::spawn_blocking(move || fs2::available_space(cache_dir))
        .await
        .map_err(|error| PlaybackError::Io(format!("failed to join free-space check: {error}")))?
        .map_err(|error| {
            PlaybackError::Io(format!("failed to inspect cache free space: {error}"))
        })?;
    if available < byte_len.saturating_add(min_free_bytes) {
        return Err(PlaybackError::Overloaded(format!(
            "edge cache free-space guard refused write: available {available} bytes, artifact {byte_len} bytes, reserve {min_free_bytes} bytes"
        )));
    }

    Ok(())
}

async fn cache_dir_size_bytes(cache_dir: PathBuf) -> std::result::Result<u64, PlaybackError> {
    let display_path = cache_dir.display().to_string();
    tokio::task::spawn_blocking(move || dir_size_bytes(&cache_dir))
        .await
        .map_err(|error| PlaybackError::Io(format!("failed to join cache size check: {error}")))?
        .map_err(|error| {
            PlaybackError::Io(format!(
                "failed to inspect cache directory size {display_path}: {error}"
            ))
        })
}

fn dir_size_bytes(path: &FsPath) -> std::io::Result<u64> {
    let mut total = 0u64;
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };

    for entry in entries {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            total = total.saturating_add(dir_size_bytes(&entry.path())?);
        } else if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        }
    }

    Ok(total)
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
            "video/mp2t",
        )),
        _ => Err(PlaybackError::NotFound(
            "unsupported playback path".to_owned(),
        )),
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

#[cfg(test)]
mod tests;
