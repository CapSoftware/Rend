use std::{
    cmp::Ordering as CmpOrdering,
    collections::BTreeSet,
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
    extract::{DefaultBodyLimit, Extension, Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use http_body::{Body as HttpBody, Frame};
use rend_config::{
    ExpectedEdges, RendEnv, env_bool, env_duration_secs, env_socket_addr, env_string, env_u64,
    env_usize, load_dotenv, optional_env_url,
    validate_edge_base_url as validate_config_edge_base_url, validate_optional_url,
    validate_required_secret, validate_required_service_url, validate_required_url,
};
use rend_playback_auth::{
    PlaybackAuthError, PlaybackTokenIssuer, SigningKey, current_unix_timestamp,
    is_asset_playback_path,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction, migrate::Migrator, postgres::PgPoolOptions};
use tokio::{net::TcpListener, sync::mpsc};
use tower_http::cors::CorsLayer;
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

mod billing;
mod events;
mod jobs;
mod media;
mod telemetry;

type HmacSha256 = Hmac<Sha256>;

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

const DEFAULT_EDGE_WARM_MAX_ARTIFACTS: usize = 16;
const HARD_EDGE_WARM_MAX_ARTIFACTS: usize = 16;
const EDGE_WARM_LOG_BODY_LIMIT_BYTES: usize = 1024;
const DEFAULT_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS: usize = 2;
const HARD_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS: usize = 8;
const HLS_STARTUP_SEGMENTS_PER_RENDITION: usize = 2;
const HLS_RENDITION_ORDER: [&str; 4] = ["720p", "1080p", "2k", "4k"];
const HLS_STARTUP_RENDITION_ORDER: [&str; 4] = ["720p", "1080p", "2k", "4k"];
const DEFAULT_ASSET_LIST_LIMIT: usize = 50;
const MAX_ASSET_LIST_LIMIT: usize = 100;
const DEFAULT_ASSET_EVENTS_LIMIT: usize = 50;
const MAX_ASSET_EVENTS_LIMIT: usize = 100;
const DEFAULT_EVENT_STREAM_BATCH_LIMIT: usize = 100;
const EVENT_STREAM_CHANNEL_CAPACITY: usize = 16;
const EVENT_STREAM_POLL_INTERVAL: Duration = Duration::from_millis(250);
const EVENT_STREAM_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const DEFAULT_MEDIA_JOB_MAX_ATTEMPTS: usize = 3;
const HARD_MEDIA_JOB_MAX_ATTEMPTS: usize = 25;
const MEDIA_JOB_LAST_ERROR_LIMIT_BYTES: usize = 4 * 1024;
const INTERNAL_EDGE_REQUEST_BODY_LIMIT_BYTES: usize = 16 * 1024;
const DEFAULT_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS: u64 = 120;
const DEFAULT_MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
const DASHBOARD_UPLOAD_TOKEN_PREFIX: &str = "rend_upload_";
const PLAYER_HARNESS_HTML: &str = include_str!("player_harness.html");
const LOCAL_ORG_ID: &str = "00000000-0000-0000-0000-000000000001";
const LOCAL_SITE_INTERNAL_TOKEN: &str = "local-site-internal-token";
const PLAYBACK_COOKIE_NAME: &str = "__rend_playback";

#[derive(Clone)]
struct ApiConfig {
    bind_addr: SocketAddr,
    database_url: String,
    redis_url: String,
    object_store_health_url: String,
    dev_api_key: String,
    site_internal_token: String,
    s3_endpoint: String,
    s3_region: String,
    s3_bucket: String,
    aws_access_key_id: String,
    aws_secret_access_key: String,
    playback_base_url: String,
    playback_cookie_domain: Option<String>,
    playback_token_issuer: PlaybackTokenIssuer,
    playback_bootstrap_prefetch_segments: usize,
    edge_registry: EdgeRegistryConfig,
    edge_warm: EdgeWarmConfig,
    edge_purge: EdgePurgeConfig,
    playback_telemetry: telemetry::TelemetryConfig,
    billing: billing::BillingConfig,
    media_processing: media::MediaProcessingConfig,
    media_job_max_attempts: i32,
    inline_media_processing: bool,
    media_worker: MediaWorkerConfig,
    auto_migrate: bool,
    request_timeout: Duration,
    max_upload_bytes: u64,
    cors_allowed_origins: Vec<HeaderValue>,
}

#[derive(Clone)]
struct EdgeRegistryConfig {
    internal_token: String,
    active_heartbeat_window: Duration,
    expected_edges: ExpectedEdges,
    rend_env: RendEnv,
    allow_insecure_edge_urls: bool,
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
        let rend_env = RendEnv::from_env()?;
        let allow_insecure_edge_urls = env_bool("REND_ALLOW_INSECURE_EDGE_URLS", false)?;
        let database_url = env_string("DATABASE_URL", "postgres://rend:rend@localhost:5432/rend");
        let redis_url = env_string("REND_REDIS_URL", "redis://localhost:6379");
        let clickhouse_url = env_string("CLICKHOUSE_URL", "http://localhost:8123");
        let object_store_health_url = env_string(
            "OBJECT_STORE_HEALTH_URL",
            "http://localhost:9100/minio/health/ready",
        );
        let dev_api_key = if rend_env.is_strict() {
            env_string("REND_DEV_API_KEY", "")
        } else {
            env_string("REND_DEV_API_KEY", "dev-api-key")
        };
        let site_internal_token = env_string("REND_SITE_INTERNAL_TOKEN", LOCAL_SITE_INTERNAL_TOKEN);
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
        let playback_base_url = env_string("REND_PLAYBACK_BASE_URL", "http://127.0.0.1:4100");
        let playback_cookie_domain = optional_cookie_domain("REND_PLAYBACK_COOKIE_DOMAIN")?;
        let playback_token_ttl = env_duration_secs("REND_PLAYBACK_TOKEN_TTL_SECS", 900)?;
        let max_upload_bytes = env_u64("REND_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES)?;
        anyhow::ensure!(
            max_upload_bytes > 0,
            "REND_MAX_UPLOAD_BYTES must be greater than 0"
        );
        let cors_allowed_origins = cors_allowed_origins_from_env(rend_env)?;
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
        let expected_edges =
            ExpectedEdges::from_env("REND_EXPECTED_EDGES", rend_env, allow_insecure_edge_urls)?;
        let edge_warm_max_artifacts = env_usize(
            "REND_EDGE_WARM_MAX_ARTIFACTS",
            DEFAULT_EDGE_WARM_MAX_ARTIFACTS,
        )?;
        anyhow::ensure!(
            (1..=HARD_EDGE_WARM_MAX_ARTIFACTS).contains(&edge_warm_max_artifacts),
            "REND_EDGE_WARM_MAX_ARTIFACTS must be between 1 and {HARD_EDGE_WARM_MAX_ARTIFACTS}"
        );
        anyhow::ensure!(
            !edge_internal_token.trim().is_empty(),
            "REND_EDGE_INTERNAL_TOKEN must not be empty"
        );
        let edge_active_heartbeat_window = env_duration_secs(
            "REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS",
            DEFAULT_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS,
        )?;
        let internal_telemetry_token = env_string("REND_INTERNAL_TELEMETRY_TOKEN", "");
        let playback_telemetry = telemetry::TelemetryConfig::from_env(&edge_internal_token)?;
        let billing = billing::BillingConfig::from_env(rend_env)?;

        for (key, value) in [
            ("DATABASE_URL", &database_url),
            ("REND_REDIS_URL", &redis_url),
            ("CLICKHOUSE_URL", &clickhouse_url),
            ("OBJECT_STORE_HEALTH_URL", &object_store_health_url),
            ("S3_ENDPOINT", &s3_endpoint),
            ("S3_REGION", &s3_region),
            ("S3_BUCKET", &s3_bucket),
            ("AWS_ACCESS_KEY_ID", &aws_access_key_id),
            ("AWS_SECRET_ACCESS_KEY", &aws_secret_access_key),
            ("REND_SITE_INTERNAL_TOKEN", &site_internal_token),
        ] {
            anyhow::ensure!(!value.trim().is_empty(), "{key} must not be empty");
        }
        if rend_env.is_strict() {
            anyhow::ensure!(
                dev_api_key.trim().is_empty(),
                "REND_DEV_API_KEY is local/dev only and must not be set in production"
            );
        } else {
            anyhow::ensure!(
                !dev_api_key.trim().is_empty(),
                "REND_DEV_API_KEY must not be empty in local profile"
            );
        }
        validate_required_secret(rend_env, "AWS_ACCESS_KEY_ID", &aws_access_key_id)?;
        validate_required_secret(rend_env, "AWS_SECRET_ACCESS_KEY", &aws_secret_access_key)?;
        validate_required_secret(rend_env, "REND_EDGE_INTERNAL_TOKEN", &edge_internal_token)?;
        validate_required_secret(rend_env, "REND_SITE_INTERNAL_TOKEN", &site_internal_token)?;
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
        validate_required_service_url(rend_env, "DATABASE_URL", &database_url)?;
        validate_required_service_url(rend_env, "REND_REDIS_URL", &redis_url)?;
        validate_required_url(rend_env, "CLICKHOUSE_URL", &clickhouse_url)?;
        validate_required_url(
            rend_env,
            "OBJECT_STORE_HEALTH_URL",
            &object_store_health_url,
        )?;
        validate_required_url(rend_env, "S3_ENDPOINT", &s3_endpoint)?;
        validate_config_edge_base_url(
            rend_env,
            "REND_PLAYBACK_BASE_URL",
            &playback_base_url,
            allow_insecure_edge_urls,
        )?;
        validate_optional_url(rend_env, "REND_EDGE_WARM_URL", edge_warm_url.as_deref())?;
        validate_optional_url(rend_env, "REND_EDGE_PURGE_URL", edge_purge_url.as_deref())?;

        let playback_token_issuer = PlaybackTokenIssuer::new(
            SigningKey::new(
                playback_signing_key_id,
                playback_signing_secret.into_bytes(),
            )?,
            playback_token_ttl,
        )?;

        Ok(Self {
            bind_addr: env_socket_addr("REND_API_BIND_ADDR", "127.0.0.1:4000")?,
            database_url,
            redis_url,
            object_store_health_url,
            dev_api_key,
            site_internal_token,
            s3_endpoint,
            s3_region,
            s3_bucket,
            aws_access_key_id,
            aws_secret_access_key,
            playback_base_url,
            playback_cookie_domain,
            playback_token_issuer,
            playback_bootstrap_prefetch_segments,
            edge_registry: EdgeRegistryConfig {
                internal_token: edge_internal_token.clone(),
                active_heartbeat_window: edge_active_heartbeat_window,
                expected_edges,
                rend_env,
                allow_insecure_edge_urls,
            },
            edge_warm: EdgeWarmConfig {
                url: edge_warm_url,
                internal_token: edge_internal_token.clone(),
                max_artifacts: edge_warm_max_artifacts,
            },
            edge_purge: EdgePurgeConfig {
                url: edge_purge_url,
                internal_token: edge_internal_token,
            },
            playback_telemetry,
            billing,
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
            max_upload_bytes,
            cors_allowed_origins,
        })
    }
}

fn cors_allowed_origins_from_env(rend_env: RendEnv) -> Result<Vec<HeaderValue>> {
    let configured = env_string("REND_API_CORS_ALLOWED_ORIGINS", "");
    let origins = if configured.trim().is_empty() {
        if rend_env.is_strict() {
            "https://rend.so,https://www.rend.so".to_owned()
        } else {
            "http://localhost:3000,http://127.0.0.1:3000".to_owned()
        }
    } else {
        configured
    };

    origins
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .map(|origin| {
            HeaderValue::from_str(origin).with_context(|| {
                format!("REND_API_CORS_ALLOWED_ORIGINS contains invalid origin {origin}")
            })
        })
        .collect()
}

fn cors_layer(allowed_origins: &[HeaderValue]) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(allowed_origins.to_vec())
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

#[derive(Clone)]
struct AppState {
    config: ApiConfig,
    db: PgPool,
    http: reqwest::Client,
    s3: S3Client,
    started_at: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum ApiScope {
    Upload,
    Read,
    Delete,
    Analytics,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RequestCredential {
    ApiKey,
    DevKey,
    DashboardUploadToken,
    SiteInternal,
}

#[derive(Clone, Debug)]
struct RequestAuth {
    organization_id: String,
    scopes: BTreeSet<ApiScope>,
    credential: RequestCredential,
}

#[derive(Debug, Deserialize, Serialize)]
struct DashboardUploadTokenClaims {
    v: u8,
    org_id: String,
    exp: u64,
    content_type: String,
    content_length: Option<u64>,
}

impl RequestAuth {
    fn all(organization_id: impl Into<String>, credential: RequestCredential) -> Self {
        Self {
            organization_id: organization_id.into(),
            scopes: [
                ApiScope::Upload,
                ApiScope::Read,
                ApiScope::Delete,
                ApiScope::Analytics,
            ]
            .into_iter()
            .collect(),
            credential,
        }
    }

    fn has_scope(&self, scope: ApiScope) -> bool {
        self.scopes.contains(&scope)
    }

    fn allows_suspended_reads(&self) -> bool {
        self.credential == RequestCredential::SiteInternal
    }
}

#[derive(Serialize)]
struct HealthResponse<'a> {
    service: String,
    status: &'a str,
    version: &'a str,
    package_version: &'a str,
    git_sha: String,
    build_time: String,
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
struct AssetListResponse {
    assets: Vec<AssetListItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct AssetListItem {
    asset_id: String,
    source_state: String,
    playable_state: String,
    created_at: String,
    updated_at: String,
    source_byte_size: Option<i64>,
    artifact_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    suspended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    suspension_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    organization_suspended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    organization_suspension_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AssetListQuery {
    limit: Option<usize>,
}

#[derive(Serialize)]
struct AssetCurrentResponse {
    asset_id: String,
    source_state: String,
    playable_state: String,
    created_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    suspended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    suspension_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    organization_suspended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    organization_suspension_reason: Option<String>,
    artifacts: Vec<AssetArtifactSummary>,
}

#[derive(Serialize)]
struct DeleteAssetResponse {
    asset_id: String,
    deleted: bool,
    already_deleted: bool,
    origin_objects_deleted: usize,
    purge_attempted: bool,
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
    #[serde(skip)]
    playback_token: String,
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
    suspended_at: Option<String>,
    suspension_reason: Option<String>,
    organization_suspended_at: Option<String>,
    organization_suspension_reason: Option<String>,
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

#[derive(Clone, Debug, Serialize)]
struct EdgePurgeRequest {
    asset_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact_paths: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct EdgePurgeResponse {
    purged: Vec<Value>,
    missing: Vec<Value>,
    rejected: Vec<Value>,
    errors: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EdgeRegistrationRequest {
    edge_id: String,
    region: String,
    base_url: String,
    status: Option<String>,
    cache_max_bytes: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EdgeHeartbeatRequest {
    edge_id: String,
    status: Option<String>,
    cache_max_bytes: Option<i64>,
}

#[derive(Serialize)]
struct EdgeNodeEnvelope {
    edge: EdgeNodeResponse,
}

#[derive(Clone, Debug, Serialize)]
struct EdgeNodeResponse {
    edge_id: String,
    region: String,
    base_url: Option<String>,
    status: String,
    cache_max_bytes: Option<i64>,
    last_heartbeat_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RegisteredEdgeNode {
    edge_id: String,
    region: String,
    base_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct EdgeFanoutTarget {
    edge_id: String,
    region: Option<String>,
    action_url: String,
    source: &'static str,
}

#[derive(Clone, Debug, Serialize)]
struct EdgeFanoutAttempt {
    edge_id: String,
    region: Option<String>,
    source: &'static str,
}

#[derive(Clone, Debug, Serialize)]
struct EdgeFanoutResult {
    edge_id: String,
    region: Option<String>,
    source: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warm_summary: Option<EdgeWarmResponseSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    purge_summary: Option<EdgePurgeResponseSummary>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct EdgeWarmResponse {
    #[serde(default)]
    summary: EdgeWarmResponseSummary,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct EdgeWarmResponseSummary {
    total: usize,
    warmed: usize,
    already_warm: usize,
    not_found: usize,
    failed: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
struct EdgePurgeResponseSummary {
    purged: usize,
    missing: usize,
    rejected: usize,
    errors: usize,
}

#[derive(Clone, Debug)]
struct OperatorIdentity {
    user_id: String,
    email: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperatorActionRequest {
    reason: String,
}

#[derive(Serialize)]
struct OperatorActionResponse {
    status: &'static str,
    action: &'static str,
    target_type: &'static str,
    target_id: String,
    audit_id: String,
    purge_attempted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    suspended_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SuspensionStateRecord {
    target_id: String,
    suspended_at: Option<String>,
    suspension_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct EdgeWarmFailure {
    reason: &'static str,
    status: Option<u16>,
    detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct EdgePurgeFailure {
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
    max_bytes: u64,
}

struct EventStreamBody {
    receiver: mpsc::Receiver<Bytes>,
}

#[tokio::main]
async fn main() -> Result<()> {
    install_rustls_crypto_provider();
    load_dotenv()?;
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

fn install_rustls_crypto_provider() {
    // Redis TLS does not select a provider when both ring and aws-lc-rs are
    // enabled transitively through the workspace dependency graph.
    let _ = rustls::crypto::ring::default_provider().install_default();
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
        .route("/v1/assets", get(list_assets))
        .route(
            "/v1/assets/{asset_id}",
            get(get_asset_current).delete(delete_asset),
        )
        .route("/v1/assets/{asset_id}/events", get(get_asset_events))
        .route("/v1/assets/{asset_id}/playback", get(get_asset_playback))
        .route(
            "/v1/assets/{asset_id}/analytics/playback",
            get(telemetry::get_playback_analytics),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_api_auth,
        ));
    let telemetry_routes = Router::new()
        .route("/playback", post(telemetry::post_playback_telemetry))
        .route_layer(DefaultBodyLimit::max(
            state.config.playback_telemetry.max_body_bytes,
        ))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            telemetry::require_internal_telemetry_token,
        ));
    let edge_routes = Router::new()
        .route("/register", post(register_edge))
        .route("/heartbeat", post(heartbeat_edge))
        .route_layer(DefaultBodyLimit::max(
            INTERNAL_EDGE_REQUEST_BODY_LIMIT_BYTES,
        ))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_internal_edge_token,
        ));
    let operator_routes = Router::new()
        .route(
            "/organizations/{organization_id}/suspend",
            post(suspend_organization),
        )
        .route(
            "/organizations/{organization_id}/restore",
            post(restore_organization),
        )
        .route("/assets/{asset_id}/suspend", post(suspend_asset))
        .route("/assets/{asset_id}/restore", post(restore_asset))
        .route(
            "/billing/delivery-sync",
            post(billing::sync_delivery_usage_handler),
        )
        .route_layer(DefaultBodyLimit::max(8 * 1024))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_operator_internal_auth,
        ));

    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/healthz", get(healthz))
        .route("/v1/readyz", get(readyz))
        .route("/player", get(player_harness))
        .merge(authenticated_routes)
        .nest("/internal/edges", edge_routes)
        .nest("/internal/operator", operator_routes)
        .nest("/internal/telemetry", telemetry_routes)
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
        .layer(cors_layer(&state.config.cors_allowed_origins))
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

async fn register_edge_inner(
    registry: &EdgeRegistryConfig,
    db: &PgPool,
    request: EdgeRegistrationRequest,
) -> Result<EdgeNodeResponse, AppError> {
    let edge_id = normalize_edge_name("edge_id", &request.edge_id)?;
    let region = normalize_edge_name("region", &request.region)?;
    let base_url = normalize_edge_base_url(registry, &request.base_url)?;
    validate_expected_edge_registration(registry, &edge_id, &region, &base_url)?;
    let status = normalize_edge_status(request.status.as_deref(), "healthy")?;
    let cache_max_bytes = normalize_cache_max_bytes(request.cache_max_bytes)?;

    let row: (String, String, Option<String>, String, Option<i64>, Option<String>) =
        sqlx::query_as(
            "
            INSERT INTO rend.edge_nodes (
              edge_id,
              region,
              base_url,
              cache_max_bytes,
              status,
              last_heartbeat_at
            )
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT (edge_id) DO UPDATE
            SET region = EXCLUDED.region,
                base_url = EXCLUDED.base_url,
                cache_max_bytes = EXCLUDED.cache_max_bytes,
                status = EXCLUDED.status,
                last_heartbeat_at = now()
            RETURNING edge_id,
                      region,
                      base_url,
                      status,
                      cache_max_bytes,
                      to_char(last_heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
            ",
        )
        .bind(edge_id)
        .bind(region)
        .bind(base_url)
        .bind(cache_max_bytes)
        .bind(status)
        .fetch_one(db)
        .await
        .map_err(AppError::internal)?;

    Ok(edge_node_response(row))
}

async fn heartbeat_edge_inner(
    db: &PgPool,
    request: EdgeHeartbeatRequest,
) -> Result<EdgeNodeResponse, AppError> {
    let edge_id = normalize_edge_name("edge_id", &request.edge_id)?;
    let status = normalize_edge_status(request.status.as_deref(), "healthy")?;
    let cache_max_bytes = normalize_cache_max_bytes(request.cache_max_bytes)?;

    let row: Option<(String, String, Option<String>, String, Option<i64>, Option<String>)> =
        sqlx::query_as(
            "
            UPDATE rend.edge_nodes
            SET status = $2,
                cache_max_bytes = COALESCE($3, cache_max_bytes),
                last_heartbeat_at = now()
            WHERE edge_id = $1
              AND status <> 'removed'
            RETURNING edge_id,
                      region,
                      base_url,
                      status,
                      cache_max_bytes,
                      to_char(last_heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
            ",
        )
        .bind(edge_id)
        .bind(status)
        .bind(cache_max_bytes)
        .fetch_optional(db)
        .await
        .map_err(AppError::internal)?;

    row.map(edge_node_response)
        .ok_or_else(|| AppError::not_found("edge node not registered"))
}

fn edge_node_response(
    row: (
        String,
        String,
        Option<String>,
        String,
        Option<i64>,
        Option<String>,
    ),
) -> EdgeNodeResponse {
    let (edge_id, region, base_url, status, cache_max_bytes, last_heartbeat_at) = row;
    EdgeNodeResponse {
        edge_id,
        region,
        base_url,
        status,
        cache_max_bytes,
        last_heartbeat_at,
    }
}

fn normalize_edge_name(field: &str, value: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(AppError::bad_request(format!(
            "{field} must be 1-128 characters and contain only letters, numbers, '-', '_', or '.'"
        )));
    }

    Ok(value.to_owned())
}

fn normalize_edge_base_url(
    registry: &EdgeRegistryConfig,
    base_url: &str,
) -> Result<String, AppError> {
    rend_config::normalize_edge_base_url(
        base_url,
        registry.rend_env,
        registry.allow_insecure_edge_urls,
    )
    .map_err(|error| AppError::bad_request(error.to_string()))
}

fn validate_expected_edge_registration(
    registry: &EdgeRegistryConfig,
    edge_id: &str,
    region: &str,
    base_url: &str,
) -> Result<(), AppError> {
    if registry.expected_edges.is_empty() {
        return Ok(());
    }

    let Some(expected) = registry.expected_edges.get(edge_id) else {
        return Err(AppError::bad_request(format!(
            "edge_id {edge_id} is not configured in REND_EXPECTED_EDGES"
        )));
    };
    if expected.region != region {
        return Err(AppError::bad_request(format!(
            "edge_id {edge_id} registered unexpected region {region}"
        )));
    }
    if expected.base_url != base_url {
        return Err(AppError::bad_request(format!(
            "edge_id {edge_id} registered unexpected base_url"
        )));
    }

    Ok(())
}

fn normalize_edge_status(status: Option<&str>, default: &str) -> Result<String, AppError> {
    let status = status.unwrap_or(default).trim().to_ascii_lowercase();
    if matches!(
        status.as_str(),
        "registered" | "healthy" | "draining" | "unhealthy" | "removed"
    ) {
        Ok(status)
    } else {
        Err(AppError::bad_request("unsupported edge status"))
    }
}

fn normalize_cache_max_bytes(cache_max_bytes: Option<i64>) -> Result<Option<i64>, AppError> {
    if matches!(cache_max_bytes, Some(bytes) if bytes < 0) {
        return Err(AppError::bad_request(
            "cache_max_bytes must be non-negative",
        ));
    }

    Ok(cache_max_bytes)
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

fn release_env(name: &str, fallback: &str) -> String {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

async fn healthz(State(state): State<Arc<AppState>>) -> Json<HealthResponse<'static>> {
    Json(HealthResponse {
        service: release_env("REND_SERVICE_NAME", "rend-api"),
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        package_version: env!("CARGO_PKG_VERSION"),
        git_sha: release_env("REND_GIT_SHA", "unknown"),
        build_time: release_env("REND_BUILD_TIME", "unknown"),
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

async fn register_edge(
    State(state): State<Arc<AppState>>,
    Json(request): Json<EdgeRegistrationRequest>,
) -> Response {
    match register_edge_inner(&state.config.edge_registry, &state.db, request).await {
        Ok(edge) => (StatusCode::OK, Json(EdgeNodeEnvelope { edge })).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn heartbeat_edge(
    State(state): State<Arc<AppState>>,
    Json(request): Json<EdgeHeartbeatRequest>,
) -> Response {
    match heartbeat_edge_inner(&state.db, request).await {
        Ok(edge) => (StatusCode::OK, Json(EdgeNodeEnvelope { edge })).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn create_video(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    match create_video_inner(state, auth, headers, body).await {
        Ok(response) => (StatusCode::CREATED, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn suspend_organization(
    State(state): State<Arc<AppState>>,
    Extension(operator): Extension<OperatorIdentity>,
    AxumPath(organization_id): AxumPath<String>,
    Json(request): Json<OperatorActionRequest>,
) -> Response {
    match suspend_organization_inner(state, operator, organization_id, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn restore_organization(
    State(state): State<Arc<AppState>>,
    Extension(operator): Extension<OperatorIdentity>,
    AxumPath(organization_id): AxumPath<String>,
    Json(request): Json<OperatorActionRequest>,
) -> Response {
    match restore_organization_inner(state, operator, organization_id, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn suspend_asset(
    State(state): State<Arc<AppState>>,
    Extension(operator): Extension<OperatorIdentity>,
    AxumPath(asset_id): AxumPath<String>,
    Json(request): Json<OperatorActionRequest>,
) -> Response {
    match suspend_asset_inner(state, operator, asset_id, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn restore_asset(
    State(state): State<Arc<AppState>>,
    Extension(operator): Extension<OperatorIdentity>,
    AxumPath(asset_id): AxumPath<String>,
    Json(request): Json<OperatorActionRequest>,
) -> Response {
    match restore_asset_inner(state, operator, asset_id, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn list_assets(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    Query(query): Query<AssetListQuery>,
) -> Response {
    match list_assets_inner(state, auth, query).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn list_assets_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    query: AssetListQuery,
) -> Result<AssetListResponse, AppError> {
    require_scope(&auth, ApiScope::Read)?;
    let limit = normalize_asset_list_limit(query.limit);
    let assets = fetch_asset_list_items(
        &state.db,
        &auth.organization_id,
        limit,
        auth.allows_suspended_reads(),
    )
    .await?;

    Ok(AssetListResponse { assets })
}

async fn get_asset_current(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(asset_id): AxumPath<String>,
) -> Response {
    match get_asset_current_inner(state, auth, asset_id).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn get_asset_current_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    asset_id: String,
) -> Result<AssetCurrentResponse, AppError> {
    require_scope(&auth, ApiScope::Read)?;
    let asset = fetch_asset_state_record(&state.db, &auth.organization_id, &asset_id).await?;
    if !auth.allows_suspended_reads() {
        ensure_asset_state_record_not_suspended(asset.as_ref())?;
    }
    let artifacts = if asset.is_some() {
        fetch_asset_artifact_summaries(&state.db, &auth.organization_id, &asset_id).await?
    } else {
        Vec::new()
    };

    asset_current_response(asset, artifacts)
}

async fn delete_asset(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(asset_id): AxumPath<String>,
) -> Response {
    match delete_asset_inner(state, auth, asset_id).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn delete_asset_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    asset_id: String,
) -> Result<DeleteAssetResponse, AppError> {
    require_scope(&auth, ApiScope::Delete)?;
    let asset_id = normalize_asset_id(&asset_id)?;
    ensure_asset_not_suspended(&state.db, &auth.organization_id, &asset_id).await?;
    let already_deleted = mark_asset_deleted(&state.db, &auth.organization_id, &asset_id).await?;
    if !already_deleted {
        billing::track_asset_delete(&state, &auth.organization_id, &asset_id).await;
    }
    let origin_object_keys =
        list_asset_origin_object_keys(&state.s3, &state.config.s3_bucket, &asset_id).await?;
    let origin_objects_deleted = delete_asset_origin_objects(
        &state.s3,
        &state.config.s3_bucket,
        &asset_id,
        &origin_object_keys,
    )
    .await;
    let purge_attempted = maybe_purge_edge(
        &state.db,
        &state.http,
        &state.config.edge_registry,
        &state.config.edge_purge,
        &asset_id,
        None,
    )
    .await;
    let origin_objects_deleted = origin_objects_deleted?;

    Ok(DeleteAssetResponse {
        asset_id,
        deleted: true,
        already_deleted,
        origin_objects_deleted,
        purge_attempted,
    })
}

async fn suspend_organization_inner(
    state: Arc<AppState>,
    operator: OperatorIdentity,
    organization_id: String,
    request: OperatorActionRequest,
) -> Result<OperatorActionResponse, AppError> {
    let organization_id = normalize_org_id(&organization_id)?;
    let reason = normalize_operator_reason(&request.reason)?;
    let mut tx = state.db.begin().await.map_err(AppError::internal)?;
    let before = fetch_organization_suspension_state_for_update(&mut tx, &organization_id).await?;

    sqlx::query(
        "
        UPDATE rend_auth.organization
        SET suspended_at = COALESCE(suspended_at, now()),
            suspended_by_user_id = $2::uuid,
            suspension_reason = $3
        WHERE id = $1::uuid
        ",
    )
    .bind(&organization_id)
    .bind(&operator.user_id)
    .bind(&reason)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;

    let after = fetch_organization_suspension_state_for_update(&mut tx, &organization_id).await?;
    let audit_id = insert_operator_audit_record(
        &mut tx,
        &operator,
        "suspend",
        "organization",
        &organization_id,
        &reason,
        suspension_state_json(&before),
        suspension_state_json(&after),
    )
    .await?;
    tx.commit().await.map_err(AppError::internal)?;

    let asset_ids = fetch_active_asset_ids_for_org(&state.db, &organization_id).await?;
    let mut purge_attempted = false;
    for asset_id in asset_ids {
        purge_attempted |= maybe_purge_edge(
            &state.db,
            &state.http,
            &state.config.edge_registry,
            &state.config.edge_purge,
            &asset_id,
            None,
        )
        .await;
    }

    Ok(OperatorActionResponse {
        status: "ok",
        action: "suspend",
        target_type: "organization",
        target_id: organization_id,
        audit_id,
        purge_attempted,
        suspended_at: after.suspended_at,
    })
}

async fn restore_organization_inner(
    state: Arc<AppState>,
    operator: OperatorIdentity,
    organization_id: String,
    request: OperatorActionRequest,
) -> Result<OperatorActionResponse, AppError> {
    let organization_id = normalize_org_id(&organization_id)?;
    let reason = normalize_operator_reason(&request.reason)?;
    let mut tx = state.db.begin().await.map_err(AppError::internal)?;
    let before = fetch_organization_suspension_state_for_update(&mut tx, &organization_id).await?;

    sqlx::query(
        "
        UPDATE rend_auth.organization
        SET suspended_at = NULL,
            suspended_by_user_id = NULL,
            suspension_reason = NULL
        WHERE id = $1::uuid
        ",
    )
    .bind(&organization_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;

    let after = fetch_organization_suspension_state_for_update(&mut tx, &organization_id).await?;
    let audit_id = insert_operator_audit_record(
        &mut tx,
        &operator,
        "restore",
        "organization",
        &organization_id,
        &reason,
        suspension_state_json(&before),
        suspension_state_json(&after),
    )
    .await?;
    tx.commit().await.map_err(AppError::internal)?;

    Ok(OperatorActionResponse {
        status: "ok",
        action: "restore",
        target_type: "organization",
        target_id: organization_id,
        audit_id,
        purge_attempted: false,
        suspended_at: after.suspended_at,
    })
}

async fn suspend_asset_inner(
    state: Arc<AppState>,
    operator: OperatorIdentity,
    asset_id: String,
    request: OperatorActionRequest,
) -> Result<OperatorActionResponse, AppError> {
    let asset_id = normalize_asset_id(&asset_id)?;
    let reason = normalize_operator_reason(&request.reason)?;
    let mut tx = state.db.begin().await.map_err(AppError::internal)?;
    let before = fetch_asset_suspension_state_for_update(&mut tx, &asset_id).await?;

    sqlx::query(
        "
        UPDATE rend.assets
        SET suspended_at = COALESCE(suspended_at, now()),
            suspended_by_user_id = $2::uuid,
            suspension_reason = $3
        WHERE id = $1::uuid
          AND deleted_at IS NULL
        ",
    )
    .bind(&asset_id)
    .bind(&operator.user_id)
    .bind(&reason)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;

    let after = fetch_asset_suspension_state_for_update(&mut tx, &asset_id).await?;
    let audit_id = insert_operator_audit_record(
        &mut tx,
        &operator,
        "suspend",
        "asset",
        &asset_id,
        &reason,
        suspension_state_json(&before),
        suspension_state_json(&after),
    )
    .await?;
    tx.commit().await.map_err(AppError::internal)?;

    let purge_attempted = maybe_purge_edge(
        &state.db,
        &state.http,
        &state.config.edge_registry,
        &state.config.edge_purge,
        &asset_id,
        None,
    )
    .await;

    Ok(OperatorActionResponse {
        status: "ok",
        action: "suspend",
        target_type: "asset",
        target_id: asset_id,
        audit_id,
        purge_attempted,
        suspended_at: after.suspended_at,
    })
}

async fn restore_asset_inner(
    state: Arc<AppState>,
    operator: OperatorIdentity,
    asset_id: String,
    request: OperatorActionRequest,
) -> Result<OperatorActionResponse, AppError> {
    let asset_id = normalize_asset_id(&asset_id)?;
    let reason = normalize_operator_reason(&request.reason)?;
    let mut tx = state.db.begin().await.map_err(AppError::internal)?;
    let before = fetch_asset_suspension_state_for_update(&mut tx, &asset_id).await?;

    sqlx::query(
        "
        UPDATE rend.assets
        SET suspended_at = NULL,
            suspended_by_user_id = NULL,
            suspension_reason = NULL
        WHERE id = $1::uuid
          AND deleted_at IS NULL
        ",
    )
    .bind(&asset_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;

    let after = fetch_asset_suspension_state_for_update(&mut tx, &asset_id).await?;
    let audit_id = insert_operator_audit_record(
        &mut tx,
        &operator,
        "restore",
        "asset",
        &asset_id,
        &reason,
        suspension_state_json(&before),
        suspension_state_json(&after),
    )
    .await?;
    tx.commit().await.map_err(AppError::internal)?;

    Ok(OperatorActionResponse {
        status: "ok",
        action: "restore",
        target_type: "asset",
        target_id: asset_id,
        audit_id,
        purge_attempted: false,
        suspended_at: after.suspended_at,
    })
}

async fn get_asset_events(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(asset_id): AxumPath<String>,
    Query(query): Query<AssetEventsQuery>,
) -> Response {
    match get_asset_events_inner(state, auth, asset_id, query).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn get_asset_events_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    asset_id: String,
    query: AssetEventsQuery,
) -> Result<AssetEventsResponse, AppError> {
    require_scope(&auth, ApiScope::Read)?;
    if !auth.allows_suspended_reads() {
        ensure_asset_events_readable(&state.db, &auth.organization_id, &asset_id).await?;
    }
    let asset_exists = asset_row_exists(&state.db, &auth.organization_id, &asset_id).await?;
    let query = normalize_asset_events_query(query);
    let events = if asset_exists {
        fetch_asset_events(
            &state.db,
            &auth.organization_id,
            &asset_id,
            query.after_sequence,
            query.limit,
        )
        .await?
    } else {
        Vec::new()
    };

    asset_events_response(asset_exists, asset_id, events)
}

async fn get_event_stream(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    headers: HeaderMap,
    Query(query): Query<EventStreamQuery>,
) -> Response {
    if let Err(error) = require_scope(&auth, ApiScope::Read) {
        return error.into_response();
    }
    match normalize_event_stream_query(&headers, query) {
        Ok(query) => {
            if !auth.allows_suspended_reads() {
                if let Some(asset_id) = query.asset_id.as_deref() {
                    if let Err(error) =
                        ensure_asset_not_suspended(&state.db, &auth.organization_id, asset_id).await
                    {
                        return error.into_response();
                    }
                }
            }
            event_stream_response(state, auth, query)
        }
        Err(error) => error.into_response(),
    }
}

async fn get_asset_playback(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(asset_id): AxumPath<String>,
) -> Response {
    match get_asset_playback_inner(state.clone(), auth, asset_id).await {
        Ok(response) => {
            let mut headers = HeaderMap::new();
            if let Ok(cookie) = playback_cookie_header(
                &response.playback_token,
                response.ttl_seconds,
                &state.config.playback_base_url,
                state.config.playback_cookie_domain.as_deref(),
            )
            .parse()
            {
                headers.insert(header::SET_COOKIE, cookie);
            }
            (StatusCode::OK, headers, Json(response)).into_response()
        }
        Err(error) => error.into_response(),
    }
}

async fn get_asset_playback_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    asset_id: String,
) -> Result<PlaybackBootstrapResponse, AppError> {
    require_scope(&auth, ApiScope::Read)?;
    let asset = fetch_asset_playback_record(&state.db, &auth.organization_id, &asset_id).await?;
    let artifacts = if asset.is_some() {
        fetch_playback_artifacts(&state.db, &auth.organization_id, &asset_id).await?
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
    organization_id: &str,
    asset_id: &str,
) -> Result<Option<AssetStateRecord>, AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let organization_id = normalize_org_id(organization_id)?;
    let row: Option<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "
        SELECT asset.id::text,
               asset.source_state,
               asset.playable_state,
               to_char(asset.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               to_char(asset.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               to_char(asset.suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               asset.suspension_reason,
               to_char(org.suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               org.suspension_reason
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
          AND asset.organization_id = $2::uuid
          AND asset.deleted_at IS NULL
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    Ok(row.map(
        |(
            asset_id,
            source_state,
            playable_state,
            created_at,
            updated_at,
            suspended_at,
            suspension_reason,
            organization_suspended_at,
            organization_suspension_reason,
        )| AssetStateRecord {
            asset_id,
            source_state,
            playable_state,
            created_at,
            updated_at,
            suspended_at,
            suspension_reason,
            organization_suspended_at,
            organization_suspension_reason,
        },
    ))
}

async fn fetch_asset_list_items(
    db: &PgPool,
    organization_id: &str,
    limit: usize,
    include_suspended: bool,
) -> Result<Vec<AssetListItem>, AppError> {
    let organization_id = normalize_org_id(organization_id)?;
    let limit = i64::try_from(limit).map_err(AppError::internal)?;
    let rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<i64>,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "
        SELECT asset.id::text,
               asset.source_state,
               asset.playable_state,
               to_char(asset.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               to_char(asset.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               max(artifact.byte_size) FILTER (WHERE artifact.kind = 'source') AS source_byte_size,
               count(artifact.id)::bigint AS artifact_count,
               to_char(asset.suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               asset.suspension_reason,
               to_char(org.suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               org.suspension_reason
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        LEFT JOIN rend.artifacts artifact ON artifact.asset_id = asset.id
        WHERE asset.organization_id = $1::uuid
          AND asset.deleted_at IS NULL
          AND ($3::boolean OR asset.suspended_at IS NULL)
          AND ($3::boolean OR org.suspended_at IS NULL)
        GROUP BY asset.id
               , org.suspended_at
               , org.suspension_reason
        ORDER BY asset.created_at DESC, asset.id DESC
        LIMIT $2
        ",
    )
    .bind(organization_id)
    .bind(limit)
    .bind(include_suspended)
    .fetch_all(db)
    .await
    .map_err(AppError::internal)?;

    Ok(rows
        .into_iter()
        .map(
            |(
                asset_id,
                source_state,
                playable_state,
                created_at,
                updated_at,
                source_byte_size,
                artifact_count,
                suspended_at,
                suspension_reason,
                organization_suspended_at,
                organization_suspension_reason,
            )| AssetListItem {
                asset_id,
                source_state,
                playable_state,
                created_at,
                updated_at,
                source_byte_size,
                artifact_count,
                suspended_at,
                suspension_reason,
                organization_suspended_at,
                organization_suspension_reason,
            },
        )
        .collect())
}

async fn fetch_asset_artifact_summaries(
    db: &PgPool,
    organization_id: &str,
    asset_id: &str,
) -> Result<Vec<AssetArtifactSummary>, AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let organization_id = normalize_org_id(organization_id)?;
    let rows: Vec<(String, String, Option<i64>)> = sqlx::query_as(
        "
        SELECT artifact.kind, artifact.content_type, artifact.byte_size
        FROM rend.artifacts artifact
        INNER JOIN rend.assets asset ON asset.id = artifact.asset_id
        WHERE artifact.asset_id = $1::uuid
          AND asset.organization_id = $2::uuid
        ORDER BY artifact.kind, artifact.object_key
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
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

async fn mark_asset_deleted(
    db: &PgPool,
    organization_id: &str,
    asset_id: &str,
) -> Result<bool, AppError> {
    let organization_id = normalize_org_id(organization_id)?;
    let mut tx = db.begin().await.map_err(AppError::internal)?;
    let row: Option<(String, String, bool)> = sqlx::query_as(
        "
        SELECT source_state, playable_state, deleted_at IS NOT NULL
        FROM rend.assets
        WHERE id = $1::uuid
          AND organization_id = $2::uuid
        FOR UPDATE
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
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

    billing::close_asset_storage_span(&mut tx, asset_id)
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

async fn list_asset_origin_object_keys(
    s3: &S3Client,
    bucket: &str,
    asset_id: &str,
) -> Result<Vec<String>, AppError> {
    let prefix = format!("videos/{asset_id}/");
    let mut continuation_token = None;
    let mut object_keys = BTreeSet::new();

    loop {
        let mut request = s3.list_objects_v2().bucket(bucket).prefix(&prefix);
        if let Some(token) = continuation_token.as_deref() {
            request = request.continuation_token(token);
        }

        let response = request
            .send()
            .await
            .with_context(|| format!("failed to list origin objects with prefix {prefix}"))
            .map_err(AppError::internal)?;

        for object in response.contents() {
            if let Some(object_key) = object.key()
                && is_rend_owned_asset_object_key(asset_id, object_key)
            {
                object_keys.insert(object_key.to_owned());
            }
        }

        if response.is_truncated().unwrap_or(false) {
            continuation_token = response.next_continuation_token().map(str::to_owned);
            if continuation_token.is_none() {
                break;
            }
        } else {
            break;
        }
    }

    Ok(object_keys.into_iter().collect())
}

fn is_rend_owned_asset_object_key(asset_id: &str, object_key: &str) -> bool {
    object_key.starts_with(&format!("videos/{asset_id}/"))
        && !object_key.contains("/../")
        && !object_key.contains("/./")
}

async fn delete_asset_origin_objects(
    s3: &S3Client,
    bucket: &str,
    asset_id: &str,
    object_keys: &[String],
) -> Result<usize, AppError> {
    let mut deleted = 0;
    for object_key in object_keys {
        s3.delete_object()
            .bucket(bucket)
            .key(object_key)
            .send()
            .await
            .with_context(|| format!("failed to delete origin object {object_key}"))
            .map_err(AppError::internal)?;
        deleted += 1;
    }
    tracing::info!(
        asset_id,
        origin_objects_deleted = deleted,
        "deleted Rend-owned asset origin objects",
    );
    Ok(deleted)
}

async fn asset_row_exists(
    db: &PgPool,
    organization_id: &str,
    asset_id: &str,
) -> Result<bool, AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let organization_id = normalize_org_id(organization_id)?;
    let exists: bool = sqlx::query_scalar(
        "
        SELECT EXISTS (
          SELECT 1
          FROM rend.assets
          WHERE id = $1::uuid
            AND organization_id = $2::uuid
        )
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
    .fetch_one(db)
    .await
    .map_err(AppError::internal)?;

    Ok(exists)
}

async fn ensure_org_not_suspended(db: &PgPool, organization_id: &str) -> Result<(), AppError> {
    let organization_id = normalize_org_id(organization_id)?;
    let suspended: Option<bool> = sqlx::query_scalar(
        "
        SELECT suspended_at IS NOT NULL
        FROM rend_auth.organization
        WHERE id = $1::uuid
        ",
    )
    .bind(organization_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    match suspended {
        Some(false) => Ok(()),
        Some(true) => Err(AppError::forbidden("organization is suspended")),
        None => Err(AppError::not_found("organization not found")),
    }
}

pub(crate) async fn ensure_asset_not_suspended(
    db: &PgPool,
    organization_id: &str,
    asset_id: &str,
) -> Result<(), AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let organization_id = normalize_org_id(organization_id)?;
    let row: Option<(bool, bool, bool)> = sqlx::query_as(
        "
        SELECT asset.deleted_at IS NOT NULL,
               asset.suspended_at IS NOT NULL,
               org.suspended_at IS NOT NULL
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
          AND asset.organization_id = $2::uuid
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    match row {
        Some((false, false, false)) => Ok(()),
        Some((true, _, _)) | None => Err(AppError::not_found("asset not found")),
        Some((_, _, true)) => Err(AppError::forbidden("organization is suspended")),
        Some((_, true, _)) => Err(AppError::forbidden("asset is suspended")),
    }
}

async fn ensure_asset_events_readable(
    db: &PgPool,
    organization_id: &str,
    asset_id: &str,
) -> Result<(), AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let organization_id = normalize_org_id(organization_id)?;
    let row: Option<(bool, bool)> = sqlx::query_as(
        "
        SELECT asset.suspended_at IS NOT NULL,
               org.suspended_at IS NOT NULL
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
          AND asset.organization_id = $2::uuid
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    match row {
        Some((false, false)) => Ok(()),
        None => Err(AppError::not_found("asset not found")),
        Some((_, true)) => Err(AppError::forbidden("organization is suspended")),
        Some((true, _)) => Err(AppError::forbidden("asset is suspended")),
    }
}

fn ensure_asset_state_record_not_suspended(
    asset: Option<&AssetStateRecord>,
) -> Result<(), AppError> {
    let Some(asset) = asset else {
        return Ok(());
    };
    if asset.organization_suspended_at.is_some() {
        return Err(AppError::forbidden("organization is suspended"));
    }
    if asset.suspended_at.is_some() {
        return Err(AppError::forbidden("asset is suspended"));
    }
    Ok(())
}

async fn fetch_asset_events(
    db: &PgPool,
    organization_id: &str,
    asset_id: &str,
    after_sequence: i64,
    limit: usize,
) -> Result<Vec<AssetEventRecord>, AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let organization_id = normalize_org_id(organization_id)?;
    let limit = i64::try_from(limit).map_err(AppError::internal)?;
    let rows: Vec<(String, String, i64, String, String, String)> = sqlx::query_as(
        "
        SELECT event.id::text,
               event.asset_id::text,
               event.sequence,
               event.event_type,
               to_char(event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               event.metadata::text
        FROM rend.asset_events event
        INNER JOIN rend.assets asset ON asset.id = event.asset_id
        WHERE event.asset_id = $1::uuid
          AND asset.organization_id = $2::uuid
          AND event.sequence > $3
        ORDER BY event.sequence
        LIMIT $4
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
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
    organization_id: &str,
    asset_id: Option<&str>,
    after_sequence: i64,
) -> Result<Vec<AssetEventRecord>, AppError> {
    let organization_id = normalize_org_id(organization_id)?;
    let limit = i64::try_from(DEFAULT_EVENT_STREAM_BATCH_LIMIT).map_err(AppError::internal)?;
    let rows: Vec<(String, String, i64, String, String, String)> = if let Some(asset_id) = asset_id
    {
        let asset_id = normalize_asset_id(asset_id)?;
        sqlx::query_as(
            "
            SELECT event.id::text,
                   event.asset_id::text,
                   event.sequence,
                   event.event_type,
                   to_char(event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                   event.metadata::text
            FROM rend.asset_events event
            INNER JOIN rend.assets asset ON asset.id = event.asset_id
            WHERE event.asset_id = $1::uuid
              AND asset.organization_id = $2::uuid
              AND event.sequence > $3
            ORDER BY event.sequence
            LIMIT $4
            ",
        )
        .bind(asset_id)
        .bind(&organization_id)
        .bind(after_sequence)
        .bind(limit)
        .fetch_all(db)
        .await
        .map_err(AppError::internal)?
    } else {
        sqlx::query_as(
            "
            SELECT event.id::text,
                   event.asset_id::text,
                   event.sequence,
                   event.event_type,
                   to_char(event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                   event.metadata::text
            FROM rend.asset_events event
            INNER JOIN rend.assets asset ON asset.id = event.asset_id
            WHERE asset.organization_id = $1::uuid
              AND event.sequence > $2
            ORDER BY event.sequence
            LIMIT $3
            ",
        )
        .bind(&organization_id)
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
    organization_id: &str,
    asset_id: &str,
) -> Result<Option<AssetPlaybackRecord>, AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let organization_id = normalize_org_id(organization_id)?;
    let row: Option<(String, String, String)> = sqlx::query_as(
        "
        SELECT asset.id::text, asset.source_state, asset.playable_state
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
          AND asset.organization_id = $2::uuid
          AND asset.deleted_at IS NULL
          AND asset.suspended_at IS NULL
          AND org.suspended_at IS NULL
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
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
    organization_id: &str,
    asset_id: &str,
) -> Result<Vec<PlaybackArtifactRecord>, AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let organization_id = normalize_org_id(organization_id)?;
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "
        SELECT artifact.kind, artifact.object_key, artifact.content_type
        FROM rend.artifacts artifact
        INNER JOIN rend.assets asset ON asset.id = artifact.asset_id
        WHERE artifact.asset_id = $1::uuid
          AND asset.organization_id = $2::uuid
          AND artifact.kind IN ('opener', 'manifest', 'segment')
        ORDER BY artifact.kind, artifact.object_key
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
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
        suspended_at: asset.suspended_at,
        suspension_reason: asset.suspension_reason,
        organization_suspended_at: asset.organization_suspended_at,
        organization_suspension_reason: asset.organization_suspension_reason,
        artifacts,
    })
}

fn normalize_asset_list_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_ASSET_LIST_LIMIT)
        .clamp(1, MAX_ASSET_LIST_LIMIT)
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

fn event_stream_response(
    state: Arc<AppState>,
    auth: RequestAuth,
    query: NormalizedEventStreamQuery,
) -> Response {
    let (sender, receiver) = mpsc::channel(EVENT_STREAM_CHANNEL_CAPACITY);
    let db = state.db.clone();
    let organization_id = auth.organization_id;
    tokio::spawn(async move {
        stream_event_lifecycle(db, organization_id, query, sender).await;
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
    organization_id: String,
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
        match fetch_event_stream_batch(&db, &organization_id, query.asset_id.as_deref(), cursor)
            .await
        {
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
    let (playback_url, playback_content_type) =
        artifact_fields(playback_base_url, &asset.asset_id, primary_artifact);
    let (opener_url, opener_content_type) =
        artifact_fields(playback_base_url, &asset.asset_id, opener_artifact.as_ref());
    let (manifest_url, manifest_content_type) = artifact_fields(
        playback_base_url,
        &asset.asset_id,
        manifest_artifact.as_ref(),
    );
    let prefetch_hints = if asset.playable_state == "hls_ready" {
        first_segment_prefetch_hints(
            playback_base_url,
            &asset.asset_id,
            &playback_artifacts,
            prefetch_segment_limit,
        )
    } else {
        Vec::new()
    };

    Ok(PlaybackBootstrapResponse {
        asset_id: asset.asset_id,
        source_state: asset.source_state,
        playable_state: asset.playable_state,
        playback_token: token.token,
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
    artifacts.sort_by(|left, right| {
        compare_hls_startup_paths(&left.artifact_path, &right.artifact_path)
    });
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
        "manifest" => is_hls_manifest_artifact_path(artifact_path),
        "segment" => is_hls_segment_artifact_path(artifact_path),
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

fn artifact_fields(
    playback_base_url: &str,
    asset_id: &str,
    artifact: Option<&PlaybackArtifact>,
) -> (Option<String>, Option<String>) {
    let Some(artifact) = artifact else {
        return (None, None);
    };

    (
        Some(artifact_url(
            playback_base_url,
            asset_id,
            &artifact.artifact_path,
        )),
        Some(artifact.content_type.clone()),
    )
}

fn first_segment_prefetch_hints(
    playback_base_url: &str,
    asset_id: &str,
    artifacts: &[PlaybackArtifact],
    limit: usize,
) -> Vec<PlaybackPrefetchHint> {
    hls_startup_prefetch_paths(artifacts, limit)
        .iter()
        .map(|artifact| PlaybackPrefetchHint {
            artifact_path: artifact.artifact_path.clone(),
            url: artifact_url(playback_base_url, asset_id, &artifact.artifact_path),
            content_type: artifact.content_type.clone(),
        })
        .collect()
}

fn hls_startup_prefetch_paths<'a>(
    artifacts: &'a [PlaybackArtifact],
    limit: usize,
) -> Vec<&'a PlaybackArtifact> {
    if limit == 0 {
        return Vec::new();
    }

    let mut hints = Vec::new();
    let tiers = hls_startup_renditions_present(
        artifacts
            .iter()
            .map(|artifact| artifact.artifact_path.as_str()),
    );
    if !tiers.is_empty() {
        let tier_segments = tiers
            .iter()
            .map(|tier| (*tier, hls_startup_segments_for_tier(artifacts, tier)))
            .collect::<Vec<_>>();

        for (tier, segments) in &tier_segments {
            let playlist_path = format!("hls/{tier}/index.m3u8");
            if let Some(playlist) = artifacts
                .iter()
                .find(|artifact| artifact.artifact_path == playlist_path)
            {
                if push_prefetch_hint(&mut hints, limit, playlist) {
                    return hints;
                }
            }

            if let Some(segment) = segments.first() {
                if push_prefetch_hint(&mut hints, limit, segment) {
                    return hints;
                }
            }
        }

        for segment_offset in 1..HLS_STARTUP_SEGMENTS_PER_RENDITION {
            for (_, segments) in &tier_segments {
                if let Some(segment) = segments.get(segment_offset) {
                    if push_prefetch_hint(&mut hints, limit, segment) {
                        return hints;
                    }
                }
            }
        }

        return hints;
    }

    let mut legacy_segments = artifacts
        .iter()
        .filter(|artifact| is_hls_segment_artifact_path(&artifact.artifact_path))
        .collect::<Vec<_>>();
    legacy_segments.sort_by(|left, right| {
        compare_hls_startup_paths(&left.artifact_path, &right.artifact_path)
    });
    legacy_segments.truncate(limit);
    legacy_segments
}

fn hls_startup_segments_for_tier<'a>(
    artifacts: &'a [PlaybackArtifact],
    tier: &str,
) -> Vec<&'a PlaybackArtifact> {
    let mut segments = artifacts
        .iter()
        .filter(|artifact| hls_rendition_name(&artifact.artifact_path) == Some(tier))
        .filter(|artifact| is_hls_segment_artifact_path(&artifact.artifact_path))
        .collect::<Vec<_>>();
    segments.sort_by(|left, right| {
        compare_hls_startup_paths(&left.artifact_path, &right.artifact_path)
    });
    segments.truncate(HLS_STARTUP_SEGMENTS_PER_RENDITION);
    segments
}

fn push_prefetch_hint<'a>(
    hints: &mut Vec<&'a PlaybackArtifact>,
    limit: usize,
    artifact: &'a PlaybackArtifact,
) -> bool {
    if hints.len() >= limit {
        return true;
    }
    if !hints
        .iter()
        .any(|existing| existing.artifact_path == artifact.artifact_path)
    {
        hints.push(artifact);
    }
    hints.len() >= limit
}

fn compare_hls_startup_paths(left: &str, right: &str) -> CmpOrdering {
    hls_startup_sort_key(left)
        .cmp(&hls_startup_sort_key(right))
        .then_with(|| left.cmp(right))
}

fn hls_startup_sort_key(path: &str) -> (u8, u8, u32) {
    if path == "hls/master.m3u8" {
        return (0, 0, 0);
    }
    if path == "opener.mp4" {
        return (4, 0, 0);
    }
    if is_hls_manifest_artifact_path(path) {
        return (
            1,
            hls_rendition_rank(hls_rendition_name(path).unwrap_or_default()),
            0,
        );
    }
    if is_hls_segment_artifact_path(path) {
        return (
            2,
            hls_rendition_rank(hls_rendition_name(path).unwrap_or("720p")),
            hls_segment_index(path).unwrap_or(u32::MAX),
        );
    }
    (5, u8::MAX, u32::MAX)
}

fn hls_startup_renditions_present<'a>(paths: impl Iterator<Item = &'a str>) -> Vec<&'static str> {
    hls_renditions_present_in_order(paths, &HLS_STARTUP_RENDITION_ORDER)
}

fn hls_renditions_present_in_order<'a>(
    paths: impl Iterator<Item = &'a str>,
    order: &[&'static str],
) -> Vec<&'static str> {
    let paths = paths.collect::<Vec<_>>();
    order
        .iter()
        .copied()
        .filter(|tier| {
            let prefix = format!("hls/{tier}/");
            paths.iter().any(|path| path.starts_with(&prefix))
        })
        .collect()
}

fn hls_rendition_name(path: &str) -> Option<&str> {
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["hls", tier, _] if HLS_RENDITION_ORDER.contains(tier) => Some(tier),
        _ => None,
    }
}

fn hls_rendition_rank(tier: &str) -> u8 {
    HLS_RENDITION_ORDER
        .iter()
        .position(|candidate| *candidate == tier)
        .and_then(|index| u8::try_from(index).ok())
        .unwrap_or(u8::MAX)
}

fn is_hls_manifest_artifact_path(path: &str) -> bool {
    path == "hls/master.m3u8"
        || (path.starts_with("hls/")
            && path.ends_with("/index.m3u8")
            && is_asset_playback_path(path))
}

fn is_hls_segment_artifact_path(path: &str) -> bool {
    path.starts_with("hls/") && path.ends_with(".ts") && is_asset_playback_path(path)
}

fn hls_segment_index(path: &str) -> Option<u32> {
    path.split('/')
        .next_back()?
        .strip_prefix("segment_")?
        .strip_suffix(".ts")?
        .parse::<u32>()
        .ok()
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

fn playback_cookie_header(
    token: &str,
    ttl_seconds: u64,
    playback_base_url: &str,
    cookie_domain: Option<&str>,
) -> String {
    let mut parts = vec![
        format!("{PLAYBACK_COOKIE_NAME}={token}"),
        "Path=/v/".to_owned(),
        format!("Max-Age={ttl_seconds}"),
        "HttpOnly".to_owned(),
        "SameSite=Lax".to_owned(),
    ];
    if let Some(domain) = cookie_domain {
        parts.push(format!("Domain={domain}"));
    }
    if playback_base_url.starts_with("https://") {
        parts.push("Secure".to_owned());
    }
    parts.join("; ")
}

fn optional_cookie_domain(key: &str) -> Result<Option<String>> {
    let value = env_string(key, "");
    let value = value.trim().trim_start_matches('.').to_owned();
    if value.is_empty() {
        return Ok(None);
    }
    anyhow::ensure!(
        !value.contains('/')
            && !value.contains(':')
            && !value.chars().any(char::is_whitespace)
            && value.contains('.'),
        "{key} must be a cookie domain such as rend.so"
    );
    Ok(Some(value))
}

fn artifact_url(base_url: &str, asset_id: &str, artifact_path: &str) -> String {
    format!(
        "{}/v/{asset_id}/{artifact_path}",
        base_url.trim_end_matches('/')
    )
}

async fn create_video_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    headers: HeaderMap,
    body: Body,
) -> Result<CreateVideoResponse, AppError> {
    require_scope(&auth, ApiScope::Upload)?;
    let content_type = request_content_type(&headers);
    let content_length = request_content_length(&headers, state.config.max_upload_bytes)?;
    let billing_content_length = content_length
        .map(u64::try_from)
        .transpose()
        .map_err(AppError::internal)?;
    ensure_org_not_suspended(&state.db, &auth.organization_id).await?;
    let asset_id: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&state.db)
        .await
        .map_err(AppError::internal)?;
    let billing_reservation = billing::reserve_upload(
        &state,
        &auth.organization_id,
        &asset_id,
        billing_content_length,
    )
    .await?;
    let create_asset_result = async {
        let mut tx = state.db.begin().await.map_err(AppError::internal)?;
        sqlx::query(
            "
            INSERT INTO rend.assets (id, organization_id, source_state, playable_state)
            VALUES ($1::uuid, $2::uuid, 'uploading', 'not_playable')
            ",
        )
        .bind(&asset_id)
        .bind(&auth.organization_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "failed to insert uploading asset");
            AppError::internal("failed to insert uploading asset")
        })?;
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
        Ok::<(), AppError>(())
    }
    .await;
    if let Err(error) = create_asset_result {
        billing::refund_upload_reservation(&state, &billing_reservation).await;
        return Err(error);
    }

    let source_object_key = source_object_key(&asset_id);
    let byte_count = Arc::new(AtomicU64::new(0));
    let upload_body = counted_body_stream(body, byte_count.clone(), state.config.max_upload_bytes);
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
        billing::refund_upload_reservation(&state, &billing_reservation).await;
        if byte_count.load(Ordering::Relaxed) > state.config.max_upload_bytes
            || upload_error_is_payload_too_large(&error)
        {
            return Err(AppError::payload_too_large(format!(
                "request body exceeds REND_MAX_UPLOAD_BYTES ({})",
                state.config.max_upload_bytes
            )));
        }
        return Err(AppError::storage(error));
    }

    let byte_size = i64::try_from(byte_count.load(Ordering::Relaxed)).map_err(|_| AppError {
        status: StatusCode::PAYLOAD_TOO_LARGE,
        message: "uploaded body is too large".to_owned(),
    })?;

    let persist_upload_result = async {
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
        }

        tx.commit().await.map_err(AppError::internal)?;
        Ok::<(String, bool), AppError>((source_artifact_id, !state.config.inline_media_processing))
    }
    .await;
    let (source_artifact_id, queued_for_async_processing) = match persist_upload_result {
        Ok(value) => value,
        Err(error) => {
            mark_asset_failed(&state, &asset_id).await;
            billing::refund_upload_reservation(&state, &billing_reservation).await;
            return Err(error);
        }
    };
    if queued_for_async_processing {
        billing::reconcile_upload_reservation(&state, &billing_reservation, byte_size as u64).await;

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
        &state.config.edge_registry,
        &state.config.edge_warm,
        &asset_id,
        &playable_state,
        &media_outcome.playback_artifact_paths,
    )
    .await;
    billing::schedule_delivery_usage_sync(state.clone());

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

    billing::reconcile_upload_reservation(&state, &billing_reservation, byte_size as u64).await;

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
    if asset_is_unavailable_for_media_processing(&state.db, &job.asset_id).await? {
        tracing::info!(
            job_id = %job.id,
            asset_id = %job.asset_id,
            "media job asset is deleted, suspended, or missing",
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

    if !mark_asset_media_processing_started(&state.db, &job.asset_id)
        .await
        .context("failed to mark asset media processing started")?
    {
        tracing::info!(
            job_id = %job.id,
            asset_id = %job.asset_id,
            "media job skipped because asset was deleted or suspended before processing started",
        );
        return Ok(());
    }

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
        &state.config.edge_registry,
        &state.config.edge_warm,
        &job.asset_id,
        &outcome.playable_state,
        &outcome.playback_artifact_paths,
    )
    .await;
    billing::schedule_delivery_usage_sync(Arc::new(state.clone()));

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

async fn asset_is_unavailable_for_media_processing(db: &PgPool, asset_id: &str) -> Result<bool> {
    let unavailable: Option<bool> = sqlx::query_scalar(
        "
        SELECT asset.deleted_at IS NOT NULL
            OR asset.suspended_at IS NOT NULL
            OR org.suspended_at IS NOT NULL
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
        ",
    )
    .bind(asset_id)
    .fetch_optional(db)
    .await?;

    Ok(unavailable.unwrap_or(true))
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
    let row: Option<(String, bool, bool, bool)> = sqlx::query_as(
        "
        SELECT asset.playable_state,
               asset.deleted_at IS NOT NULL,
               asset.suspended_at IS NOT NULL,
               org.suspended_at IS NOT NULL
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
        FOR UPDATE
        ",
    )
    .bind(asset_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((playable_state, deleted, asset_suspended, org_suspended)) = row else {
        tx.commit().await?;
        return Ok(false);
    };

    if deleted || asset_suspended || org_suspended {
        tx.commit().await?;
        return Ok(false);
    }

    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'processing'
        WHERE id = $1::uuid
          AND deleted_at IS NULL
          AND suspended_at IS NULL
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
          AND suspended_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM rend_auth.organization org
            WHERE org.id = rend.assets.organization_id
              AND org.suspended_at IS NOT NULL
          )
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

fn counted_body_stream(body: Body, byte_count: Arc<AtomicU64>, max_bytes: u64) -> ByteStream {
    ByteStream::from_body_1_x(CountedRequestBody {
        body: Mutex::new(Box::pin(body)),
        byte_count,
        max_bytes,
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

fn request_content_length(
    headers: &HeaderMap,
    max_upload_bytes: u64,
) -> Result<Option<i64>, AppError> {
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
    if u64::try_from(size).unwrap_or(u64::MAX) > max_upload_bytes {
        return Err(AppError::payload_too_large(format!(
            "content-length exceeds REND_MAX_UPLOAD_BYTES ({max_upload_bytes})"
        )));
    }

    Ok(Some(size))
}

fn upload_error_is_payload_too_large(error: impl std::fmt::Display) -> bool {
    let message = error.to_string();
    message.contains("REND_MAX_UPLOAD_BYTES") || message.contains("request body exceeds")
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
    let _token = issue_playback_token(issuer, asset_id, now)?;

    Ok(Some(artifact_url(base_url, asset_id, artifact_path)))
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
    registry: &EdgeRegistryConfig,
    config: &EdgeWarmConfig,
    asset_id: &str,
    playable_state: &str,
    generated_artifact_paths: &[String],
) {
    let Some(request) = edge_warm_request(
        asset_id,
        playable_state,
        generated_artifact_paths,
        config.max_artifacts,
    ) else {
        return;
    };
    let targets = edge_warm_fanout_targets(db, registry, config).await;
    if targets.is_empty() {
        return;
    }

    if let Some(db) = db {
        record_edge_warm_event(
            db,
            asset_id,
            events::EVENT_EDGE_WARMING_ATTEMPTED,
            events::edge_warming_metadata(
                &request.artifact_paths,
                edge_fanout_attempts_value(&targets),
            ),
        )
        .await;
    }

    let results = fanout_edge_warm_requests(http, &config.internal_token, &targets, &request).await;
    let success_count = results
        .iter()
        .filter(|result| result.status == "succeeded")
        .count();

    if let Some(db) = db {
        let event_type = if success_count > 0 {
            events::EVENT_EDGE_WARMING_SUCCEEDED
        } else {
            events::EVENT_EDGE_WARMING_FAILED
        };
        record_edge_warm_event(
            db,
            asset_id,
            event_type,
            events::edge_warming_metadata(
                &request.artifact_paths,
                edge_fanout_results_value(&results),
            ),
        )
        .await;
    }

    for result in results.iter().filter(|result| result.status == "failed") {
        tracing::warn!(
            asset_id,
            edge_id = %result.edge_id,
            region = result.region.as_deref(),
            source = result.source,
            reason = result.reason.unwrap_or("unknown"),
            status = result.http_status,
            "edge warm fanout failed; upload remains playable",
        );
    }
}

async fn fanout_edge_warm_requests(
    http: &reqwest::Client,
    internal_token: &str,
    targets: &[EdgeFanoutTarget],
    request: &EdgeWarmRequest,
) -> Vec<EdgeFanoutResult> {
    let mut results = Vec::with_capacity(targets.len());
    for target in targets {
        match send_edge_warm_request(http, internal_token, &target.action_url, request).await {
            Ok(response) => results.push(EdgeFanoutResult {
                edge_id: target.edge_id.clone(),
                region: target.region.clone(),
                source: target.source,
                status: "succeeded",
                http_status: None,
                reason: None,
                warm_summary: Some(response.summary),
                purge_summary: None,
            }),
            Err(error) => {
                tracing::warn!(
                    edge_id = %target.edge_id,
                    region = target.region.as_deref(),
                    source = target.source,
                    error = %error,
                    "edge warm request failed",
                );
                results.push(EdgeFanoutResult {
                    edge_id: target.edge_id.clone(),
                    region: target.region.clone(),
                    source: target.source,
                    status: "failed",
                    http_status: error.status,
                    reason: Some(error.reason),
                    warm_summary: None,
                    purge_summary: None,
                });
            }
        }
    }

    results
}

async fn edge_warm_fanout_targets(
    db: Option<&PgPool>,
    registry: &EdgeRegistryConfig,
    config: &EdgeWarmConfig,
) -> Vec<EdgeFanoutTarget> {
    let mut targets = registered_edge_fanout_targets(db, registry, "warm").await;
    if !targets.is_empty() {
        return targets;
    }

    if let Some(url) = config.url.as_deref() {
        targets.push(EdgeFanoutTarget {
            edge_id: "single-edge-env-fallback".to_owned(),
            region: None,
            action_url: url.to_owned(),
            source: "env_fallback",
        });
    }

    targets
}

async fn registered_edge_fanout_targets(
    db: Option<&PgPool>,
    registry: &EdgeRegistryConfig,
    action: &str,
) -> Vec<EdgeFanoutTarget> {
    let Some(db) = db else {
        return Vec::new();
    };

    let edges = match fetch_active_edge_nodes(db, registry.active_heartbeat_window).await {
        Ok(edges) => edges,
        Err(error) => {
            tracing::warn!(
                error = %error,
                "failed to fetch registered edge nodes; using edge env fallback if configured",
            );
            Vec::new()
        }
    };

    edges
        .into_iter()
        .filter(|edge| registered_edge_is_trusted(registry, edge))
        .map(|edge| EdgeFanoutTarget {
            action_url: edge_action_url(&edge.base_url, action),
            edge_id: edge.edge_id,
            region: Some(edge.region),
            source: "registry",
        })
        .collect()
}

fn registered_edge_is_trusted(registry: &EdgeRegistryConfig, edge: &RegisteredEdgeNode) -> bool {
    if registry.expected_edges.is_empty() {
        return true;
    }

    let trusted =
        registry
            .expected_edges
            .contains_match(&edge.edge_id, &edge.region, &edge.base_url);
    if !trusted {
        tracing::warn!(
            edge_id = %edge.edge_id,
            region = %edge.region,
            base_url = %edge.base_url,
            "skipping untrusted edge registry row for fanout",
        );
    }
    trusted
}

async fn fetch_active_edge_nodes(
    db: &PgPool,
    active_heartbeat_window: Duration,
) -> sqlx::Result<Vec<RegisteredEdgeNode>> {
    let active_after_secs = i64::try_from(active_heartbeat_window.as_secs()).unwrap_or(i64::MAX);
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "
        SELECT edge_id, region, base_url
        FROM rend.edge_nodes
        WHERE status = 'healthy'
          AND base_url IS NOT NULL
          AND btrim(base_url) <> ''
          AND last_heartbeat_at IS NOT NULL
          AND last_heartbeat_at >= now() - ($1::double precision * interval '1 second')
        ORDER BY region, edge_id
        ",
    )
    .bind(active_after_secs)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(edge_id, region, base_url)| RegisteredEdgeNode {
            edge_id,
            region,
            base_url: base_url.trim_end_matches('/').to_owned(),
        })
        .collect())
}

fn edge_action_url(base_url: &str, action: &str) -> String {
    format!("{}/internal/{action}", base_url.trim_end_matches('/'))
}

fn edge_fanout_attempts_value(targets: &[EdgeFanoutTarget]) -> Value {
    let attempts = targets
        .iter()
        .map(|target| EdgeFanoutAttempt {
            edge_id: target.edge_id.clone(),
            region: target.region.clone(),
            source: target.source,
        })
        .collect::<Vec<_>>();
    serde_json::to_value(attempts).unwrap_or_else(|_| Value::Array(Vec::new()))
}

fn edge_fanout_results_value(results: &[EdgeFanoutResult]) -> Value {
    serde_json::to_value(results).unwrap_or_else(|_| Value::Array(Vec::new()))
}

fn edge_warm_request(
    asset_id: &str,
    playable_state: &str,
    generated_artifact_paths: &[String],
    max_artifacts: usize,
) -> Option<EdgeWarmRequest> {
    let artifact_paths =
        edge_warm_artifact_paths(playable_state, generated_artifact_paths, max_artifacts);
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
            if contains_artifact_path(generated_artifact_paths, "opener.mp4") {
                push_unique_artifact_path(&mut artifact_paths, "opener.mp4");
            }
        }
        "hls_ready" => {
            if contains_artifact_path(generated_artifact_paths, "hls/master.m3u8") {
                if push_limited_unique_artifact_path(
                    &mut artifact_paths,
                    max_artifacts,
                    "hls/master.m3u8",
                ) {
                    return artifact_paths;
                }
            }

            let tiers =
                hls_startup_renditions_present(generated_artifact_paths.iter().map(String::as_str));
            if !tiers.is_empty() {
                let tier_segments = tiers
                    .iter()
                    .map(|tier| {
                        (
                            *tier,
                            hls_startup_segment_paths_for_tier(generated_artifact_paths, tier),
                        )
                    })
                    .collect::<Vec<_>>();

                for (tier, segments) in &tier_segments {
                    let playlist_path = format!("hls/{tier}/index.m3u8");
                    if contains_artifact_path(generated_artifact_paths, &playlist_path) {
                        if push_limited_unique_artifact_path(
                            &mut artifact_paths,
                            max_artifacts,
                            &playlist_path,
                        ) {
                            return artifact_paths;
                        }
                    }

                    if let Some(segment) = segments.first() {
                        if push_limited_unique_artifact_path(
                            &mut artifact_paths,
                            max_artifacts,
                            segment,
                        ) {
                            return artifact_paths;
                        }
                    }
                }

                for segment_offset in 1..HLS_STARTUP_SEGMENTS_PER_RENDITION {
                    for (_, segments) in &tier_segments {
                        if let Some(segment) = segments.get(segment_offset) {
                            if push_limited_unique_artifact_path(
                                &mut artifact_paths,
                                max_artifacts,
                                segment,
                            ) {
                                return artifact_paths;
                            }
                        }
                    }
                }
            } else {
                let mut segments = generated_artifact_paths
                    .iter()
                    .filter(|path| is_hls_segment_artifact_path(path))
                    .cloned()
                    .collect::<Vec<_>>();
                segments.sort_by(|left, right| compare_hls_startup_paths(left, right));
                for segment in segments {
                    if push_limited_unique_artifact_path(
                        &mut artifact_paths,
                        max_artifacts,
                        &segment,
                    ) {
                        return artifact_paths;
                    }
                }
            }

            let mut remaining_hls_paths = generated_artifact_paths
                .iter()
                .filter(|path| path.starts_with("hls/"))
                .filter(|path| path.as_str() != "hls/master.m3u8")
                .cloned()
                .collect::<Vec<_>>();
            remaining_hls_paths.sort_by(|left, right| compare_hls_startup_paths(left, right));
            for path in remaining_hls_paths {
                if push_limited_unique_artifact_path(&mut artifact_paths, max_artifacts, &path) {
                    return artifact_paths;
                }
            }

            if contains_artifact_path(generated_artifact_paths, "opener.mp4") {
                push_limited_unique_artifact_path(&mut artifact_paths, max_artifacts, "opener.mp4");
            }
        }
        _ => {}
    }

    artifact_paths.truncate(max_artifacts);
    artifact_paths
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

fn push_unique_artifact_path(paths: &mut Vec<String>, path: &str) {
    if !paths.iter().any(|existing| existing == path) {
        paths.push(path.to_owned());
    }
}

fn push_limited_unique_artifact_path(
    paths: &mut Vec<String>,
    max_artifacts: usize,
    path: &str,
) -> bool {
    if paths.len() >= max_artifacts {
        return true;
    }
    push_unique_artifact_path(paths, path);
    paths.len() >= max_artifacts
}

fn hls_startup_segment_paths_for_tier(paths: &[String], tier: &str) -> Vec<String> {
    let mut segments = paths
        .iter()
        .filter(|path| hls_rendition_name(path) == Some(tier))
        .filter(|path| is_hls_segment_artifact_path(path))
        .cloned()
        .collect::<Vec<_>>();
    segments.sort_by(|left, right| compare_hls_startup_paths(left, right));
    segments.truncate(HLS_STARTUP_SEGMENTS_PER_RENDITION);
    segments
}

fn contains_artifact_path(paths: &[String], path: &str) -> bool {
    paths.iter().any(|candidate| candidate == path)
}

async fn send_edge_warm_request(
    http: &reqwest::Client,
    internal_token: &str,
    url: &str,
    request: &EdgeWarmRequest,
) -> std::result::Result<EdgeWarmResponse, EdgeWarmFailure> {
    let response = http
        .post(url)
        .header("x-rend-internal-token", internal_token)
        .json(request)
        .send()
        .await
        .map_err(|error| EdgeWarmFailure::request(error.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return response
            .json::<EdgeWarmResponse>()
            .await
            .map_err(|error| EdgeWarmFailure::request(error.to_string()));
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
    registry: &EdgeRegistryConfig,
    config: &EdgePurgeConfig,
    asset_id: &str,
    artifact_paths: Option<Vec<String>>,
) -> bool {
    let targets = edge_purge_fanout_targets(db, registry, config).await;
    if targets.is_empty() {
        return false;
    }

    let request = EdgePurgeRequest {
        asset_id: asset_id.to_owned(),
        artifact_paths,
    };
    let artifact_paths = request.artifact_paths.as_deref();

    record_edge_purge_event(
        db,
        asset_id,
        events::EVENT_EDGE_PURGE_ATTEMPTED,
        events::edge_purge_metadata(artifact_paths, edge_fanout_attempts_value(&targets)),
    )
    .await;

    let results =
        fanout_edge_purge_requests(http, &config.internal_token, &targets, &request).await;
    let success_count = results
        .iter()
        .filter(|result| result.status == "succeeded")
        .count();
    let event_type = if success_count > 0 {
        events::EVENT_EDGE_PURGE_SUCCEEDED
    } else {
        events::EVENT_EDGE_PURGE_FAILED
    };
    record_edge_purge_event(
        db,
        asset_id,
        event_type,
        events::edge_purge_metadata(artifact_paths, edge_fanout_results_value(&results)),
    )
    .await;

    for result in results.iter().filter(|result| result.status == "failed") {
        tracing::warn!(
            asset_id,
            edge_id = %result.edge_id,
            region = result.region.as_deref(),
            source = result.source,
            reason = result.reason.unwrap_or("unknown"),
            status = result.http_status,
            "edge purge fanout failed; asset deletion remains committed",
        );
    }

    true
}

async fn fanout_edge_purge_requests(
    http: &reqwest::Client,
    internal_token: &str,
    targets: &[EdgeFanoutTarget],
    request: &EdgePurgeRequest,
) -> Vec<EdgeFanoutResult> {
    let mut results = Vec::with_capacity(targets.len());
    for target in targets {
        match send_edge_purge_request(http, internal_token, &target.action_url, request).await {
            Ok(response) => results.push(EdgeFanoutResult {
                edge_id: target.edge_id.clone(),
                region: target.region.clone(),
                source: target.source,
                status: "succeeded",
                http_status: None,
                reason: None,
                warm_summary: None,
                purge_summary: Some(EdgePurgeResponseSummary {
                    purged: response.purged.len(),
                    missing: response.missing.len(),
                    rejected: response.rejected.len(),
                    errors: response.errors.len(),
                }),
            }),
            Err(error) => {
                tracing::warn!(
                    edge_id = %target.edge_id,
                    region = target.region.as_deref(),
                    source = target.source,
                    error = %error,
                    "edge purge request failed",
                );
                results.push(EdgeFanoutResult {
                    edge_id: target.edge_id.clone(),
                    region: target.region.clone(),
                    source: target.source,
                    status: "failed",
                    http_status: error.status,
                    reason: Some(error.reason),
                    warm_summary: None,
                    purge_summary: None,
                });
            }
        }
    }

    results
}

async fn edge_purge_fanout_targets(
    db: &PgPool,
    registry: &EdgeRegistryConfig,
    config: &EdgePurgeConfig,
) -> Vec<EdgeFanoutTarget> {
    let mut targets = registered_edge_fanout_targets(Some(db), registry, "purge").await;
    if !targets.is_empty() {
        return targets;
    }

    if let Some(url) = config.url.as_deref() {
        targets.push(EdgeFanoutTarget {
            edge_id: "single-edge-env-fallback".to_owned(),
            region: None,
            action_url: url.to_owned(),
            source: "env_fallback",
        });
    }

    targets
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
    internal_token: &str,
    url: &str,
    request: &EdgePurgeRequest,
) -> std::result::Result<EdgePurgeResponse, EdgePurgeFailure> {
    let response = http
        .post(url)
        .header("x-rend-internal-token", internal_token)
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
          AND deleted_at IS NULL
          AND suspended_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM rend_auth.organization org
            WHERE org.id = rend.assets.organization_id
              AND org.suspended_at IS NOT NULL
          )
        ",
    )
    .bind(asset_id)
    .execute(&state.db)
    .await
    {
        tracing::warn!(asset_id, error = %error, "failed to mark asset upload as failed");
    }
}

async fn require_api_auth(
    State(state): State<Arc<AppState>>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    match authenticate_request(&state, request.headers()).await {
        Ok(Some(auth)) => {
            request.extensions_mut().insert(auth);
            next.run(request).await
        }
        Ok(None) => unauthorized_response(),
        Err(error) => error.into_response(),
    }
}

async fn authenticate_request(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<RequestAuth>, AppError> {
    if let Some(provided) = header_string(headers, "x-rend-site-token") {
        if !secret_matches(provided, &state.config.site_internal_token) {
            return Ok(None);
        }
        let Some(organization_id) = header_string(headers, "x-rend-organization-id") else {
            return Ok(None);
        };
        let organization_id = normalize_org_id(organization_id)?;
        return Ok(Some(RequestAuth::all(
            organization_id,
            RequestCredential::SiteInternal,
        )));
    }

    let Some(token) = bearer_token(headers) else {
        return Ok(None);
    };

    if !state.config.dev_api_key.is_empty()
        && secret_matches(token, state.config.dev_api_key.as_str())
    {
        return Ok(Some(RequestAuth::all(
            LOCAL_ORG_ID,
            RequestCredential::DevKey,
        )));
    }

    if token.starts_with(DASHBOARD_UPLOAD_TOKEN_PREFIX) {
        return dashboard_upload_token_auth(state, token, headers);
    }

    if !looks_like_api_key(token) {
        return Ok(None);
    }

    lookup_api_key_auth(&state.db, token).await
}

fn dashboard_upload_token_auth(
    state: &AppState,
    token: &str,
    headers: &HeaderMap,
) -> Result<Option<RequestAuth>, AppError> {
    let Some(claims) = verify_dashboard_upload_token(&state.config.site_internal_token, token)
    else {
        return Ok(None);
    };

    if claims.v != 1 {
        return Ok(None);
    }
    if claims.exp < current_unix_timestamp().map_err(AppError::internal)? {
        return Ok(None);
    }

    let organization_id = normalize_org_id(&claims.org_id)?;
    let content_type = request_content_type(headers);
    if content_type != claims.content_type {
        return Err(AppError::forbidden(
            "upload token does not match content-type",
        ));
    }

    let content_length = request_content_length(headers, state.config.max_upload_bytes)?;
    match (claims.content_length, content_length) {
        (Some(expected), Some(actual)) if i64::try_from(expected).ok() == Some(actual) => {}
        (Some(_), _) => {
            return Err(AppError::forbidden(
                "upload token does not match content-length",
            ));
        }
        (None, _) => {}
    }

    Ok(Some(RequestAuth {
        organization_id,
        scopes: [ApiScope::Upload].into_iter().collect(),
        credential: RequestCredential::DashboardUploadToken,
    }))
}

fn verify_dashboard_upload_token(secret: &str, token: &str) -> Option<DashboardUploadTokenClaims> {
    if secret.trim().is_empty() {
        return None;
    }

    let token = token.strip_prefix(DASHBOARD_UPLOAD_TOKEN_PREFIX)?;
    let (payload, signature) = token.split_once('.')?;
    if payload.is_empty() || signature.is_empty() {
        return None;
    }

    let signature = URL_SAFE_NO_PAD.decode(signature.as_bytes()).ok()?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature).ok()?;

    let payload = URL_SAFE_NO_PAD.decode(payload.as_bytes()).ok()?;
    serde_json::from_slice(&payload).ok()
}

#[cfg(test)]
fn encode_dashboard_upload_token(secret: &str, claims: &DashboardUploadTokenClaims) -> String {
    let payload = serde_json::to_vec(claims).unwrap();
    let payload = URL_SAFE_NO_PAD.encode(payload);
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{DASHBOARD_UPLOAD_TOKEN_PREFIX}{payload}.{signature}")
}

async fn lookup_api_key_auth(db: &PgPool, token: &str) -> Result<Option<RequestAuth>, AppError> {
    let key_hash = hash_api_key(token);
    let row: Option<(String, Vec<String>, bool, bool)> = sqlx::query_as(
        "
        SELECT key.organization_id::text,
               key.scopes,
               (key.last_used_update_after IS NULL OR key.last_used_update_after <= now()),
               org.suspended_at IS NOT NULL
        FROM rend.api_keys key
        INNER JOIN rend_auth.organization org ON org.id = key.organization_id
        WHERE key.key_hash = $1
          AND key.revoked_at IS NULL
        ",
    )
    .bind(&key_hash)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    let Some((organization_id, scope_values, should_update_last_used, organization_suspended)) =
        row
    else {
        return Ok(None);
    };

    if organization_suspended {
        return Err(AppError::forbidden("organization is suspended"));
    }

    if should_update_last_used {
        schedule_api_key_last_used_update(db.clone(), key_hash);
    }

    Ok(Some(RequestAuth {
        organization_id,
        scopes: parse_api_scopes(scope_values)?,
        credential: RequestCredential::ApiKey,
    }))
}

fn parse_api_scopes(values: Vec<String>) -> Result<BTreeSet<ApiScope>, AppError> {
    let mut scopes = BTreeSet::new();
    for value in values {
        let scope = match value.as_str() {
            "upload" => ApiScope::Upload,
            "read" => ApiScope::Read,
            "delete" => ApiScope::Delete,
            "analytics" => ApiScope::Analytics,
            _ => return Err(AppError::internal("invalid API key scope in database")),
        };
        scopes.insert(scope);
    }
    if scopes.is_empty() {
        return Err(AppError::internal("API key has no scopes"));
    }
    Ok(scopes)
}

fn schedule_api_key_last_used_update(db: PgPool, key_hash: String) {
    tokio::spawn(async move {
        if let Err(error) = sqlx::query(
            "
            UPDATE rend.api_keys
            SET last_used_at = now(),
                last_used_update_after = now() + interval '5 minutes'
            WHERE key_hash = $1
              AND revoked_at IS NULL
              AND (last_used_update_after IS NULL OR last_used_update_after <= now())
            ",
        )
        .bind(key_hash)
        .execute(&db)
        .await
        {
            tracing::warn!(error = %error, "failed to update API key last-used timestamp");
        }
    });
}

fn require_scope(auth: &RequestAuth, scope: ApiScope) -> Result<(), AppError> {
    if auth.has_scope(scope) {
        Ok(())
    } else {
        Err(AppError::forbidden("insufficient API key scope"))
    }
}

async fn require_internal_edge_token(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get("x-rend-internal-token")
        .and_then(|value| value.to_str().ok());

    if provided == Some(state.config.edge_registry.internal_token.as_str()) {
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

async fn require_operator_internal_auth(
    State(state): State<Arc<AppState>>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get("x-rend-site-token")
        .and_then(|value| value.to_str().ok());
    if !provided.is_some_and(|token| secret_matches(token, &state.config.site_internal_token)) {
        return unauthorized_response();
    }

    match operator_identity_from_headers(request.headers()) {
        Ok(operator) => {
            request.extensions_mut().insert(operator);
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
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

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorResponse {
            error: "unauthorized".to_owned(),
        }),
    )
        .into_response()
}

fn header_string<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn normalize_org_id(organization_id: &str) -> Result<String, AppError> {
    let organization_id = organization_id.trim();
    if !is_canonical_uuid(organization_id) {
        return Err(AppError::bad_request("malformed organization_id"));
    }
    Ok(organization_id.to_ascii_lowercase())
}

fn operator_identity_from_headers(headers: &HeaderMap) -> Result<OperatorIdentity, AppError> {
    let user_id = header_string(headers, "x-rend-operator-user-id")
        .ok_or_else(|| AppError::bad_request("missing operator user id"))
        .and_then(normalize_operator_user_id)?;
    let email = header_string(headers, "x-rend-operator-email")
        .ok_or_else(|| AppError::bad_request("missing operator email"))
        .and_then(normalize_operator_email)?;

    Ok(OperatorIdentity { user_id, email })
}

fn normalize_operator_user_id(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    if !is_canonical_uuid(value) {
        return Err(AppError::bad_request("operator user id must be a UUID"));
    }
    Ok(value.to_ascii_lowercase())
}

fn normalize_operator_email(value: &str) -> Result<String, AppError> {
    let email = value.trim().to_ascii_lowercase();
    if email.len() < 3
        || email.len() > 320
        || !email.contains('@')
        || email.contains("://")
        || email.contains('?')
        || email.contains('#')
        || email.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(AppError::bad_request("operator email is invalid"));
    }
    Ok(email)
}

fn normalize_operator_reason(value: &str) -> Result<String, AppError> {
    let normalized = value
        .chars()
        .map(|character| {
            if matches!(character, '\r' | '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let redacted = redact_operator_text(&normalized);
    if redacted.is_empty() || redacted.len() > 1000 {
        return Err(AppError::bad_request(
            "operator reason must be between 1 and 1000 bytes",
        ));
    }
    Ok(redacted)
}

fn redact_operator_text(value: &str) -> String {
    let mut output = Vec::new();
    let mut skip_next = false;
    for part in value.split_whitespace() {
        if skip_next {
            skip_next = false;
            output.push("[redacted]".to_owned());
            continue;
        }

        let lower = part.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            output.push("[redacted-url]".to_owned());
            continue;
        }
        if lower == "bearer" || lower == "basic" {
            output.push("[redacted-auth]".to_owned());
            skip_next = true;
            continue;
        }
        if lower.contains("authorization")
            || lower.contains("cookie")
            || lower.contains("token=")
            || lower.contains("signature=")
            || lower.contains("secret=")
            || lower.contains("api_key=")
            || lower.contains("apikey=")
            || lower.contains("api-key=")
        {
            output.push("[redacted-secret]".to_owned());
            if lower.ends_with(':') || lower.ends_with('=') {
                skip_next = true;
            }
            continue;
        }

        output.push(part.to_owned());
    }

    output.join(" ")
}

async fn fetch_organization_suspension_state_for_update(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
) -> Result<SuspensionStateRecord, AppError> {
    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "
        SELECT id::text,
               to_char(suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               suspension_reason
        FROM rend_auth.organization
        WHERE id = $1::uuid
        FOR UPDATE
        ",
    )
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(AppError::internal)?;

    row.map(
        |(target_id, suspended_at, suspension_reason)| SuspensionStateRecord {
            target_id,
            suspended_at,
            suspension_reason,
        },
    )
    .ok_or_else(|| AppError::not_found("organization not found"))
}

async fn fetch_asset_suspension_state_for_update(
    tx: &mut Transaction<'_, Postgres>,
    asset_id: &str,
) -> Result<SuspensionStateRecord, AppError> {
    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "
        SELECT id::text,
               to_char(suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               suspension_reason
        FROM rend.assets
        WHERE id = $1::uuid
          AND deleted_at IS NULL
        FOR UPDATE
        ",
    )
    .bind(asset_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(AppError::internal)?;

    row.map(
        |(target_id, suspended_at, suspension_reason)| SuspensionStateRecord {
            target_id,
            suspended_at,
            suspension_reason,
        },
    )
    .ok_or_else(|| AppError::not_found("asset not found"))
}

fn suspension_state_json(state: &SuspensionStateRecord) -> Value {
    serde_json::json!({
        "target_id": state.target_id,
        "suspended": state.suspended_at.is_some(),
        "suspended_at": state.suspended_at,
        "suspension_reason": state.suspension_reason,
    })
}

async fn insert_operator_audit_record(
    tx: &mut Transaction<'_, Postgres>,
    operator: &OperatorIdentity,
    action: &'static str,
    target_type: &'static str,
    target_id: &str,
    reason: &str,
    before_state: Value,
    after_state: Value,
) -> Result<String, AppError> {
    sqlx::query_scalar(
        "
        INSERT INTO rend.operator_audit_records (
          operator_user_id,
          operator_email,
          action,
          target_type,
          target_id,
          reason,
          before_state,
          after_state
        )
        VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7::jsonb, $8::jsonb)
        RETURNING id::text
        ",
    )
    .bind(&operator.user_id)
    .bind(&operator.email)
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(reason)
    .bind(before_state.to_string())
    .bind(after_state.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(AppError::internal)
}

async fn fetch_active_asset_ids_for_org(
    db: &PgPool,
    organization_id: &str,
) -> Result<Vec<String>, AppError> {
    let organization_id = normalize_org_id(organization_id)?;
    let rows: Vec<String> = sqlx::query_scalar(
        "
        SELECT id::text
        FROM rend.assets
        WHERE organization_id = $1::uuid
          AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        ",
    )
    .bind(organization_id)
    .fetch_all(db)
    .await
    .map_err(AppError::internal)?;

    Ok(rows)
}

fn secret_matches(provided: &str, expected: &str) -> bool {
    if expected.is_empty() || provided.is_empty() {
        return false;
    }
    let left = Sha256::digest(provided.as_bytes());
    let right = Sha256::digest(expected.as_bytes());
    let mut diff = 0;
    for (left_byte, right_byte) in left.iter().zip(right.iter()) {
        diff |= left_byte ^ right_byte;
    }
    diff == 0
}

fn hash_api_key(raw_key: &str) -> String {
    format!("{:x}", Sha256::digest(raw_key.as_bytes()))
}

fn looks_like_api_key(token: &str) -> bool {
    token.starts_with("rend_live_") || token.starts_with("rend_test_")
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

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    fn limit_exceeded() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: "limit_exceeded".to_owned(),
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

    fn payload_too_large(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: message.into(),
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

impl EdgePurgeFailure {
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

impl std::fmt::Display for EdgePurgeFailure {
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
                    let len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
                    let previous = this.byte_count.fetch_add(len, Ordering::Relaxed);
                    if previous.saturating_add(len) > this.max_bytes {
                        return Poll::Ready(Some(Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!(
                                "request body exceeds REND_MAX_UPLOAD_BYTES ({})",
                                this.max_bytes
                            ),
                        ))));
                    }
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
mod tests;
