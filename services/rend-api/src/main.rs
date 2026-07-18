use std::{
    cmp::Ordering as CmpOrdering,
    collections::{BTreeSet, HashMap},
    convert::Infallible,
    net::SocketAddr,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context as TaskContext, Poll},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use aws_sdk_cloudfront::Client as CloudFrontClient;
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
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
};
use bytes::Bytes;
use futures_util::stream;
use hmac::{Hmac, Mac};
use http_body::{Body as HttpBody, Frame};
use rend_config::{
    ExpectedEdges, RendEnv, env_bool, env_duration_secs, env_socket_addr, env_string, env_u64,
    env_usize, load_dotenv, optional_env_url,
    validate_edge_base_url as validate_config_edge_base_url, validate_optional_url,
    validate_required_secret, validate_required_service_url, validate_required_url,
};
use rend_playback_auth::{
    PlaybackAuthError, PlaybackTokenIssuer, SigningKey, SingleKeyring, current_unix_timestamp,
    is_asset_playback_path, validate_playback_token,
};
use rsa::{
    RsaPrivateKey,
    pkcs1::DecodeRsaPrivateKey,
    pkcs1v15::SigningKey as RsaSigningKey,
    pkcs8::DecodePrivateKey,
    signature::{SignatureEncoding, Signer},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction, migrate::Migrator, postgres::PgPoolOptions};
use tokio::{
    io::AsyncReadExt,
    net::TcpListener,
    sync::{mpsc, watch},
};
use tower_http::cors::CorsLayer;
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

mod billing;
mod budget;
mod cloudfront_invalidations;
mod events;
mod jobs;
mod media;
mod origin_cleanup;
mod telemetry;
mod uploads;

type HmacSha256 = Hmac<Sha256>;

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

const DEFAULT_EDGE_WARM_MAX_ARTIFACTS: usize = 16;
const HARD_EDGE_WARM_MAX_ARTIFACTS: usize = 16;
const EDGE_WARM_LOG_BODY_LIMIT_BYTES: usize = 1024;
const DEFAULT_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS: usize = 8;
const HARD_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS: usize = 8;
const HLS_STARTUP_SEGMENTS_PER_RENDITION: usize = 2;
const HLS_RENDITION_ORDER: [&str; 6] = ["360p", "480p", "720p", "1080p", "2k", "4k"];
const HLS_STARTUP_RENDITION_ORDER: [&str; 6] = ["360p", "480p", "720p", "1080p", "2k", "4k"];
const DEFAULT_ASSET_LIST_LIMIT: usize = 50;
const MAX_ASSET_LIST_LIMIT: usize = 100;
const DEFAULT_ASSET_EVENTS_LIMIT: usize = 50;
const MAX_ASSET_EVENTS_LIMIT: usize = 100;
const MAX_THUMBNAIL_BYTES: usize = 5 * 1024 * 1024;
const DEFAULT_EVENT_STREAM_BATCH_LIMIT: usize = 100;
const EVENT_STREAM_CHANNEL_CAPACITY: usize = 16;
const EVENT_STREAM_POLL_INTERVAL: Duration = Duration::from_millis(250);
const EVENT_STREAM_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const DEFAULT_MEDIA_JOB_MAX_ATTEMPTS: usize = 3;
const CLOUDFRONT_INVALIDATION_PATH_LIMIT: usize = 1_000;
const HARD_MEDIA_JOB_MAX_ATTEMPTS: usize = 25;
const MEDIA_JOB_LAST_ERROR_LIMIT_BYTES: usize = 4 * 1024;
const INTERNAL_EDGE_REQUEST_BODY_LIMIT_BYTES: usize = 16 * 1024;
const DEFAULT_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS: u64 = 120;
const DEFAULT_MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_ORGANIZATION_STORAGE_BYTES: u64 = 250 * 1024 * 1024 * 1024;
const DEFAULT_PLATFORM_STORAGE_BYTES: u64 = 5 * 1024 * 1024 * 1024 * 1024;
const DEFAULT_ORGANIZATION_VIDEO_LIMIT: usize = 50;
const DEFAULT_OPEN_UPLOAD_SESSIONS_PER_ORGANIZATION: usize = 10;
const DEFAULT_ACTIVE_MEDIA_JOBS_PER_ORGANIZATION: usize = 2;
const DASHBOARD_UPLOAD_TOKEN_PREFIX: &str = "rend_upload_";
const PLAYER_HARNESS_HTML: &str = include_str!("player_harness.html");
const LOCAL_ORG_ID: &str = "00000000-0000-0000-0000-000000000001";
const LOCAL_SITE_INTERNAL_TOKEN: &str = "local-site-internal-token";
const PLAYBACK_COOKIE_NAME: &str = "__rend_playback";
const ORIGIN_PLAYBACK_CACHE_MAX_ENTRIES: usize = 512;
const ORIGIN_PLAYBACK_CACHE_MAX_OBJECT_BYTES: usize = 8 * 1024 * 1024;
const ORIGIN_PLAYBACK_CACHE_MEDIA_TTL: Duration = Duration::from_secs(10 * 60);
const ORIGIN_PLAYBACK_CACHE_MANIFEST_TTL: Duration = Duration::from_secs(60);
const FAST_EMBED_INLINE_STARTUP_MAX_BYTES: usize = 512 * 1024;

#[derive(Clone)]
struct ApiConfig {
    bind_addr: SocketAddr,
    database_url: String,
    object_store_health_url: String,
    dev_api_key: String,
    site_internal_token: String,
    s3_endpoint: String,
    s3_presign_endpoint: String,
    s3_region: String,
    s3_bucket: String,
    source_bucket: String,
    aws_access_key_id: String,
    aws_secret_access_key: String,
    playback_mode: PlaybackMode,
    playback_base_url: String,
    fast_embed_playback_base_urls: Vec<String>,
    public_playback_enabled: bool,
    public_playback_alias: Option<media::PublicPlaybackAliasConfig>,
    playback_cookie_domain: Option<String>,
    cloudfront_cookie_signer: Option<CloudFrontCookieSigner>,
    cloudfront_distribution_id: Option<String>,
    playback_token_issuer: PlaybackTokenIssuer,
    playback_keyring: SingleKeyring,
    playback_bootstrap_prefetch_segments: usize,
    edge_registry: EdgeRegistryConfig,
    edge_warm: EdgeWarmConfig,
    edge_purge: EdgePurgeConfig,
    playback_telemetry: telemetry::TelemetryConfig,
    billing: billing::BillingConfig,
    media_processing: media::MediaProcessingConfig,
    upload_limits: uploads::UploadLimits,
    compute_budget: budget::ComputeBudgetConfig,
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
    enabled: bool,
    url: Option<String>,
    internal_token: String,
    max_artifacts: usize,
}

#[derive(Clone)]
struct EdgePurgeConfig {
    enabled: bool,
    url: Option<String>,
    internal_token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlaybackMode {
    Tigris,
    Edge,
}

#[derive(Clone)]
struct MediaWorkerConfig {
    worker_id: String,
    poll_interval: Duration,
    lease_duration: Duration,
    heartbeat_interval: Duration,
    shutdown_grace: Duration,
    max_active_jobs_per_organization: i32,
}

#[derive(Clone)]
struct CloudFrontCookieSigner {
    key_pair_id: String,
    private_key: RsaPrivateKey,
}

enum MediaJobDisposition {
    Completed(i64),
    Deferred,
    DeferredUnavailable,
    Rejected(String),
}

impl PlaybackMode {
    fn from_env() -> Result<Self> {
        match env_string("REND_PLAYBACK_MODE", "tigris")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "tigris" => Ok(Self::Tigris),
            "edge" => Ok(Self::Edge),
            _ => anyhow::bail!("REND_PLAYBACK_MODE must be either tigris or edge"),
        }
    }

    fn is_edge(self) -> bool {
        matches!(self, Self::Edge)
    }
}

impl ApiConfig {
    fn from_env() -> Result<Self> {
        let rend_env = RendEnv::from_env()?;
        let allow_insecure_edge_urls = env_bool("REND_ALLOW_INSECURE_EDGE_URLS", false)?;
        let database_url = env_string("DATABASE_URL", "postgres://rend:rend@localhost:5432/rend");
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
        let s3_presign_endpoint = env_string("S3_PRESIGN_ENDPOINT", &s3_endpoint);
        let s3_region = env_string("S3_REGION", "us-east-1");
        let s3_bucket = env_string("S3_BUCKET", "rend-local");
        let source_bucket = env_string("S3_SOURCE_BUCKET", &s3_bucket);
        let aws_access_key_id = env_string(
            "S3_ACCESS_KEY_ID",
            &env_string("AWS_ACCESS_KEY_ID", "rend_minio"),
        );
        let aws_secret_access_key = env_string(
            "S3_SECRET_ACCESS_KEY",
            &env_string("AWS_SECRET_ACCESS_KEY", "rend_minio_password"),
        );
        let playback_signing_key_id =
            env_string("REND_PLAYBACK_SIGNING_KEY_ID", "local-dev-playback-key");
        let playback_signing_secret = env_string(
            "REND_PLAYBACK_SIGNING_SECRET",
            "local-dev-playback-signing-secret",
        );
        let playback_mode = PlaybackMode::from_env()?;
        let playback_base_url = playback_base_url_for_mode(playback_mode, rend_env);
        let fast_embed_playback_base_urls =
            fast_embed_playback_base_urls_from_env(rend_env, allow_insecure_edge_urls)?;
        let public_playback_enabled = env_bool("REND_PUBLIC_PLAYBACK_ENABLED", false)?;
        let public_playback_alias = public_playback_alias_config_from_env(public_playback_enabled)?;
        let playback_cookie_domain = optional_cookie_domain("REND_PLAYBACK_COOKIE_DOMAIN")?;
        let cloudfront_cookie_signer = cloudfront_cookie_signer_from_env()?;
        let cloudfront_distribution_id = env_string("REND_CLOUDFRONT_DISTRIBUTION_ID", "");
        let cloudfront_distribution_id = (!cloudfront_distribution_id.trim().is_empty())
            .then(|| cloudfront_distribution_id.trim().to_owned());
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
        let organization_storage_bytes = env_u64(
            "REND_ORGANIZATION_STORAGE_BYTES",
            DEFAULT_ORGANIZATION_STORAGE_BYTES,
        )?;
        let platform_storage_bytes = env_u64(
            "REND_PLATFORM_STORAGE_BYTES",
            DEFAULT_PLATFORM_STORAGE_BYTES,
        )?;
        let organization_video_limit = env_usize(
            "REND_ORGANIZATION_VIDEO_LIMIT",
            DEFAULT_ORGANIZATION_VIDEO_LIMIT,
        )?;
        let open_upload_sessions = env_usize(
            "REND_OPEN_UPLOAD_SESSIONS_PER_ORGANIZATION",
            DEFAULT_OPEN_UPLOAD_SESSIONS_PER_ORGANIZATION,
        )?;
        let max_active_media_jobs = env_usize(
            "REND_ACTIVE_MEDIA_JOBS_PER_ORGANIZATION",
            DEFAULT_ACTIVE_MEDIA_JOBS_PER_ORGANIZATION,
        )?;
        anyhow::ensure!(
            organization_video_limit > 0,
            "REND_ORGANIZATION_VIDEO_LIMIT must be positive"
        );
        anyhow::ensure!(
            open_upload_sessions > 0,
            "REND_OPEN_UPLOAD_SESSIONS_PER_ORGANIZATION must be positive"
        );
        anyhow::ensure!(
            max_active_media_jobs > 0,
            "REND_ACTIVE_MEDIA_JOBS_PER_ORGANIZATION must be positive"
        );

        for (key, value) in [
            ("DATABASE_URL", &database_url),
            ("CLICKHOUSE_URL", &clickhouse_url),
            ("OBJECT_STORE_HEALTH_URL", &object_store_health_url),
            ("S3_ENDPOINT", &s3_endpoint),
            ("S3_PRESIGN_ENDPOINT", &s3_presign_endpoint),
            ("S3_REGION", &s3_region),
            ("S3_BUCKET", &s3_bucket),
            ("S3_SOURCE_BUCKET", &source_bucket),
            (
                "S3_ACCESS_KEY_ID (or AWS_ACCESS_KEY_ID)",
                &aws_access_key_id,
            ),
            (
                "S3_SECRET_ACCESS_KEY (or AWS_SECRET_ACCESS_KEY)",
                &aws_secret_access_key,
            ),
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
        validate_required_secret(rend_env, "S3_ACCESS_KEY_ID", &aws_access_key_id)?;
        validate_required_secret(rend_env, "S3_SECRET_ACCESS_KEY", &aws_secret_access_key)?;
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
        validate_required_url(rend_env, "CLICKHOUSE_URL", &clickhouse_url)?;
        validate_required_url(
            rend_env,
            "OBJECT_STORE_HEALTH_URL",
            &object_store_health_url,
        )?;
        validate_required_url(rend_env, "S3_ENDPOINT", &s3_endpoint)?;
        validate_required_url(rend_env, "S3_PRESIGN_ENDPOINT", &s3_presign_endpoint)?;
        match playback_mode {
            PlaybackMode::Tigris => validate_required_url(
                rend_env,
                "REND_TIGRIS_PLAYBACK_BASE_URL",
                &playback_base_url,
            )?,
            PlaybackMode::Edge => validate_config_edge_base_url(
                rend_env,
                "REND_PLAYBACK_BASE_URL",
                &playback_base_url,
                allow_insecure_edge_urls,
            )?,
        }
        validate_optional_url(rend_env, "REND_EDGE_WARM_URL", edge_warm_url.as_deref())?;
        validate_optional_url(rend_env, "REND_EDGE_PURGE_URL", edge_purge_url.as_deref())?;

        let playback_signing_key = SigningKey::new(
            playback_signing_key_id,
            playback_signing_secret.into_bytes(),
        )?;
        let playback_keyring = SingleKeyring::from_key(playback_signing_key.clone());
        let playback_token_issuer =
            PlaybackTokenIssuer::new(playback_signing_key, playback_token_ttl)?;

        Ok(Self {
            bind_addr: env_socket_addr("REND_API_BIND_ADDR", "127.0.0.1:4000")?,
            database_url,
            object_store_health_url,
            dev_api_key,
            site_internal_token,
            s3_endpoint,
            s3_presign_endpoint,
            s3_region,
            s3_bucket,
            source_bucket,
            aws_access_key_id,
            aws_secret_access_key,
            playback_mode,
            playback_base_url,
            fast_embed_playback_base_urls,
            public_playback_enabled,
            public_playback_alias,
            playback_cookie_domain,
            cloudfront_cookie_signer,
            cloudfront_distribution_id,
            playback_token_issuer,
            playback_keyring,
            playback_bootstrap_prefetch_segments,
            edge_registry: EdgeRegistryConfig {
                internal_token: edge_internal_token.clone(),
                active_heartbeat_window: edge_active_heartbeat_window,
                expected_edges,
                rend_env,
                allow_insecure_edge_urls,
            },
            edge_warm: EdgeWarmConfig {
                enabled: playback_mode.is_edge(),
                url: edge_warm_url,
                internal_token: edge_internal_token.clone(),
                max_artifacts: edge_warm_max_artifacts,
            },
            edge_purge: EdgePurgeConfig {
                enabled: playback_mode.is_edge(),
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
            upload_limits: uploads::UploadLimits {
                part_size: uploads::DEFAULT_PART_SIZE,
                session_ttl: env_duration_secs("REND_UPLOAD_SESSION_TTL_SECS", 24 * 60 * 60)?,
                signed_url_ttl: env_duration_secs("REND_UPLOAD_SIGNED_URL_TTL_SECS", 15 * 60)?,
                video_limit: i32::try_from(organization_video_limit)
                    .context("REND_ORGANIZATION_VIDEO_LIMIT is too large")?,
                organization_byte_limit: i64::try_from(organization_storage_bytes)
                    .context("REND_ORGANIZATION_STORAGE_BYTES is too large")?,
                global_byte_limit: i64::try_from(platform_storage_bytes)
                    .context("REND_PLATFORM_STORAGE_BYTES is too large")?,
                max_open_sessions: i64::try_from(open_upload_sessions)
                    .context("REND_OPEN_UPLOAD_SESSIONS_PER_ORGANIZATION is too large")?,
                media_job_max_attempts: i32::try_from(media_job_max_attempts)
                    .context("REND_MEDIA_JOB_MAX_ATTEMPTS is too large")?,
                max_upload_bytes,
            },
            compute_budget: budget::ComputeBudgetConfig {
                monthly_cap_microusd: i64::try_from(env_u64(
                    "REND_MEDIA_MONTHLY_BUDGET_MICROUSD",
                    250_000_000,
                )?)
                .context("REND_MEDIA_MONTHLY_BUDGET_MICROUSD is too large")?,
                monthly_base_microusd: i64::try_from(env_u64(
                    "REND_MEDIA_MONTHLY_BASE_MICROUSD",
                    154_000_000,
                )?)
                .context("REND_MEDIA_MONTHLY_BASE_MICROUSD is too large")?,
                per_job_ceiling_microusd: i64::try_from(env_u64(
                    "REND_MEDIA_JOB_CEILING_MICROUSD",
                    25_000_000,
                )?)
                .context("REND_MEDIA_JOB_CEILING_MICROUSD is too large")?,
                task_microusd_per_second: i64::try_from(env_u64(
                    "REND_MEDIA_TASK_MICROUSD_PER_SECOND",
                    57,
                )?)
                .context("REND_MEDIA_TASK_MICROUSD_PER_SECOND is too large")?,
                output_microusd_per_gib: i64::try_from(env_u64(
                    "REND_MEDIA_EGRESS_MICROUSD_PER_GIB",
                    100_000,
                )?)
                .context("REND_MEDIA_EGRESS_MICROUSD_PER_GIB is too large")?,
                safety_factor: u32::try_from(env_u64("REND_MEDIA_BUDGET_SAFETY_FACTOR", 2)?)
                    .context("REND_MEDIA_BUDGET_SAFETY_FACTOR is too large")?,
            },
            media_job_max_attempts: i32::try_from(media_job_max_attempts)
                .context("REND_MEDIA_JOB_MAX_ATTEMPTS is too large")?,
            inline_media_processing,
            media_worker: MediaWorkerConfig {
                worker_id: media_worker_id(),
                poll_interval: env_duration_secs("REND_MEDIA_WORKER_POLL_INTERVAL_SECS", 1)?,
                lease_duration: env_duration_secs("REND_MEDIA_JOB_LEASE_SECS", 120)?,
                heartbeat_interval: env_duration_secs("REND_MEDIA_JOB_HEARTBEAT_SECS", 30)?,
                shutdown_grace: env_duration_secs("REND_MEDIA_SHUTDOWN_GRACE_SECS", 90)?,
                max_active_jobs_per_organization: i32::try_from(max_active_media_jobs)
                    .context("REND_ACTIVE_MEDIA_JOBS_PER_ORGANIZATION is too large")?,
            },
            auto_migrate: env_bool("REND_API_AUTO_MIGRATE", !rend_env.is_strict())?,
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

fn public_playback_alias_config_from_env(
    enabled: bool,
) -> Result<Option<media::PublicPlaybackAliasConfig>> {
    if !enabled {
        return Ok(None);
    }
    Ok(Some(media::PublicPlaybackAliasConfig {
        bucket: public_playback_alias_bucket_from_env(&env_string(
            "REND_PUBLIC_PLAYBACK_ALIAS_BUCKET",
            "",
        ))?,
        prefix: media::normalize_public_playback_alias_prefix(&env_string(
            "REND_PUBLIC_PLAYBACK_ALIAS_PREFIX",
            "v",
        ))?,
        acl: public_playback_alias_acl_from_env(&env_string(
            "REND_PUBLIC_PLAYBACK_ALIAS_ACL",
            "public-read",
        ))?,
    }))
}

fn public_playback_alias_bucket_from_env(value: &str) -> Result<Option<String>> {
    let bucket = value.trim();
    if bucket.is_empty() {
        return Ok(None);
    }
    anyhow::ensure!(
        bucket.len() >= 3
            && bucket.len() <= 63
            && bucket
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && bucket
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && bucket
                .bytes()
                .last()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()),
        "REND_PUBLIC_PLAYBACK_ALIAS_BUCKET must be a safe Tigris bucket name"
    );
    Ok(Some(bucket.to_owned()))
}

fn public_playback_alias_acl_from_env(value: &str) -> Result<media::PublicPlaybackAliasAcl> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "inherit" | "none" => Ok(media::PublicPlaybackAliasAcl::Inherit),
        "public-read" => Ok(media::PublicPlaybackAliasAcl::PublicRead),
        _ => anyhow::bail!("REND_PUBLIC_PLAYBACK_ALIAS_ACL must be public-read, inherit, or empty"),
    }
}

fn playback_base_url_for_mode(mode: PlaybackMode, rend_env: RendEnv) -> String {
    match mode {
        PlaybackMode::Tigris => tigris_playback_base_url(
            rend_env,
            &env_string("REND_TIGRIS_PLAYBACK_BASE_URL", ""),
            &env_string("REND_PUBLIC_API_BASE_URL", ""),
            &env_string("REND_API_BASE_URL", ""),
        ),
        PlaybackMode::Edge => env_string("REND_PLAYBACK_BASE_URL", "http://127.0.0.1:4100")
            .trim()
            .trim_end_matches('/')
            .to_owned(),
    }
}

fn tigris_playback_base_url(
    rend_env: RendEnv,
    explicit: &str,
    public_api_base_url: &str,
    api_base_url: &str,
) -> String {
    let explicit = normalize_base_url_value(explicit);
    if !explicit.is_empty() && !(rend_env.is_strict() && is_local_playback_base_url(&explicit)) {
        return explicit;
    }

    for candidate in [public_api_base_url, api_base_url] {
        let candidate = normalize_base_url_value(candidate);
        if !candidate.is_empty() {
            return candidate;
        }
    }

    if rend_env.is_strict() {
        "https://api.rend.so".to_owned()
    } else {
        "http://127.0.0.1:4000".to_owned()
    }
}

fn normalize_base_url_value(value: &str) -> String {
    value.trim().trim_end_matches('/').to_owned()
}

fn is_local_playback_base_url(value: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(value) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    host == "localhost"
        || host == "0.0.0.0"
        || host == "::"
        || host == "::1"
        || host == "host.docker.internal"
        || host.starts_with("127.")
        || host.ends_with(".local")
        || host.ends_with(".localhost")
        || matches!(
            host.as_str(),
            "postgres"
                | "redis"
                | "minio"
                | "clickhouse"
                | "rend-api"
                | "rend-edge"
                | "rend-edge-us-east"
                | "rend-edge-london"
        )
}

fn fast_embed_playback_base_urls_from_env(
    rend_env: RendEnv,
    allow_insecure_edge_urls: bool,
) -> Result<Vec<String>> {
    let configured = env_string("REND_FAST_EMBED_PLAYBACK_BASE_URLS", "");
    configured
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            normalize_fast_embed_playback_base_url(value, rend_env, allow_insecure_edge_urls)
        })
        .collect()
}

fn normalize_fast_embed_playback_base_url(
    value: &str,
    rend_env: RendEnv,
    allow_insecure_edge_urls: bool,
) -> Result<String> {
    let value = normalize_base_url_value(value);
    let parsed = reqwest::Url::parse(&value).with_context(|| {
        format!("REND_FAST_EMBED_PLAYBACK_BASE_URLS contains invalid URL {value}")
    })?;
    anyhow::ensure!(
        parsed.scheme() == "http" || parsed.scheme() == "https",
        "REND_FAST_EMBED_PLAYBACK_BASE_URLS entries must use http or https"
    );
    anyhow::ensure!(
        parsed.host_str().is_some(),
        "REND_FAST_EMBED_PLAYBACK_BASE_URLS entries must include a host"
    );
    anyhow::ensure!(
        !rend_env.is_strict() || parsed.scheme() == "https" || allow_insecure_edge_urls,
        "REND_FAST_EMBED_PLAYBACK_BASE_URLS entries must use https in {} mode",
        rend_env.as_str()
    );
    anyhow::ensure!(
        !rend_env.is_strict() || !is_local_playback_base_url(&value),
        "REND_FAST_EMBED_PLAYBACK_BASE_URLS entries must not point at localhost or a local service name in {} mode",
        rend_env.as_str()
    );
    anyhow::ensure!(
        parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none(),
        "REND_FAST_EMBED_PLAYBACK_BASE_URLS entries must be origins without credentials, query, or fragment"
    );
    anyhow::ensure!(
        parsed.path().is_empty() || parsed.path() == "/",
        "REND_FAST_EMBED_PLAYBACK_BASE_URLS entries must not include a path"
    );
    Ok(value)
}

fn cors_layer(allowed_origins: &[HeaderValue]) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(allowed_origins.to_vec())
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([
            header::ACCEPT,
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::RANGE,
            header::HeaderName::from_static("idempotency-key"),
        ])
        .allow_credentials(true)
        .expose_headers([
            header::ACCEPT_RANGES,
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-rend-origin"),
            header::HeaderName::from_static("x-rend-cache"),
        ])
}

#[derive(Clone)]
struct AppState {
    config: ApiConfig,
    db: PgPool,
    http: reqwest::Client,
    origin_playback_cache: Arc<OriginPlaybackCache>,
    s3: S3Client,
    source_s3: S3Client,
    upload_s3: S3Client,
    cloudfront: Option<CloudFrontClient>,
    started_at: Instant,
    metrics: Arc<ApiMetrics>,
}

#[derive(Clone)]
struct OriginPlaybackCacheEntry {
    bytes: Bytes,
    content_type: &'static str,
    inserted_at: Instant,
}

#[derive(Default)]
struct OriginPlaybackCache {
    entries: Mutex<HashMap<String, OriginPlaybackCacheEntry>>,
}

impl OriginPlaybackCache {
    fn get(&self, key: &str, ttl: Duration) -> Option<OriginPlaybackCacheEntry> {
        let mut entries = self.entries.lock().ok()?;
        let entry = entries.get(key)?;
        if entry.inserted_at.elapsed() > ttl {
            entries.remove(key);
            return None;
        }
        Some(entry.clone())
    }

    fn insert(&self, key: String, bytes: Bytes, content_type: &'static str) {
        if bytes.len() > ORIGIN_PLAYBACK_CACHE_MAX_OBJECT_BYTES {
            return;
        }

        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if entries.len() >= ORIGIN_PLAYBACK_CACHE_MAX_ENTRIES
            && let Some(oldest_key) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.inserted_at)
                .map(|(key, _)| key.clone())
        {
            entries.remove(&oldest_key);
        }
        entries.insert(
            key,
            OriginPlaybackCacheEntry {
                bytes,
                content_type,
                inserted_at: Instant::now(),
            },
        );
    }
}

#[derive(Default)]
struct ApiMetrics {
    telemetry_ingested_events_total: AtomicU64,
    telemetry_ingest_lag_ms: AtomicU64,
    analytics_rollup_lag_ms: AtomicU64,
    analytics_rollup_last_success_unix_seconds: AtomicU64,
    analytics_rollup_success_total: AtomicU64,
    analytics_rollup_failure_total: AtomicU64,
}

impl ApiMetrics {
    fn record_telemetry_ingest(&self, accepted: usize, lag_ms: u64) {
        self.telemetry_ingested_events_total.fetch_add(
            u64::try_from(accepted).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
        self.telemetry_ingest_lag_ms
            .store(lag_ms, Ordering::Relaxed);
    }

    fn record_analytics_rollup_success(&self, lag_ms: u64) {
        self.analytics_rollup_lag_ms
            .store(lag_ms, Ordering::Relaxed);
        self.analytics_rollup_success_total
            .fetch_add(1, Ordering::Relaxed);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        self.analytics_rollup_last_success_unix_seconds
            .store(now, Ordering::Relaxed);
    }

    fn record_analytics_rollup_failure(&self) {
        self.analytics_rollup_failure_total
            .fetch_add(1, Ordering::Relaxed);
    }
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
    upload_claims: Option<DashboardUploadTokenClaims>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DashboardUploadTokenClaims {
    v: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    purpose: Option<String>,
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
            upload_claims: None,
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

#[derive(Deserialize)]
struct CreateUploadRequest {
    content_type: String,
    content_length: i64,
    #[serde(default)]
    filename: Option<String>,
}

#[derive(Deserialize)]
struct SignUploadPartsRequest {
    parts: Vec<uploads::RequestedPart>,
}

#[derive(Deserialize)]
struct CompleteUploadRequest {
    parts: Vec<uploads::CompletedUploadPart>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<i64>,
    has_thumbnail: bool,
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct AssetThumbnailRecord {
    object_key: String,
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

#[derive(Deserialize)]
struct PlaybackOriginPath {
    asset_id: String,
    artifact_path: String,
}

#[derive(Deserialize)]
struct PlaybackOriginQuery {
    token: Option<String>,
}

#[derive(Deserialize)]
struct FastEmbedQuery {
    autoplay: Option<String>,
    controls: Option<String>,
    muted: Option<String>,
    #[serde(rename = "playbackBaseUrl")]
    playback_base_url: Option<String>,
    startup: Option<String>,
    #[serde(rename = "startupMode")]
    startup_mode: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FastEmbedPlaybackSelection {
    artifact_path: String,
    content_type: String,
    label: &'static str,
    url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FastEmbedInlineStartup {
    artifact_path: String,
    mime_type: String,
    startup_b64: String,
    segment_urls: Vec<String>,
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
    organization_id: String,
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

#[derive(Deserialize)]
struct InternalArtifactResolutionQuery {
    asset_id: String,
    artifact_path: String,
}

#[derive(Serialize)]
struct InternalArtifactResolutionResponse {
    storage_object_key: String,
    content_type: &'static str,
}

#[derive(Deserialize)]
struct InternalAssetAvailabilityQuery {
    asset_id: String,
}

#[derive(Serialize)]
struct InternalAssetAvailabilityResponse {
    available: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct OriginPlaybackArtifact {
    asset_id: String,
    artifact_path: String,
    object_key: String,
    content_type: &'static str,
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
    let command_args = std::env::args().skip(1).collect::<Vec<_>>();
    let command = command_args.iter().map(String::as_str).collect::<Vec<_>>();

    let config = ApiConfig::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await
        .context("failed to connect to Postgres")?;

    match command.as_slice() {
        ["migrate"] => {
            MIGRATOR
                .run(&db)
                .await
                .context("failed to apply database migrations")?;
            tracing::info!("rend-api database migrations applied");
            return Ok(());
        }
        [] | ["worker", "media"] => {}
        _ => anyhow::bail!("usage: rend-api [migrate|worker media]"),
    }

    if config.edge_registry.rend_env.is_strict() && config.auto_migrate {
        anyhow::bail!(
            "REND_API_AUTO_MIGRATE=true is not permitted for long-running production processes; run `rend-api migrate` before promotion"
        );
    }

    if config.auto_migrate {
        MIGRATOR
            .run(&db)
            .await
            .context("failed to apply database migrations")?;
    }

    let request_timeout = config.request_timeout;
    let s3 = build_s3_client(&config);
    let source_s3 = build_s3_client_for_endpoint(&config, &config.s3_endpoint);
    let upload_s3 = build_s3_client_for_endpoint(&config, &config.s3_presign_endpoint);
    let cloudfront = if config.cloudfront_distribution_id.is_some() {
        let sdk_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_sdk_cloudfront::config::Region::new("us-east-1"))
            .load()
            .await;
        Some(CloudFrontClient::new(&sdk_config))
    } else {
        None
    };
    let state = Arc::new(AppState {
        config,
        db,
        http: reqwest::Client::new(),
        origin_playback_cache: Arc::new(OriginPlaybackCache::default()),
        s3,
        source_s3,
        upload_s3,
        cloudfront,
        started_at: Instant::now(),
        metrics: Arc::new(ApiMetrics::default()),
    });

    match command.as_slice() {
        [] => {}
        ["worker", "media"] => {
            return run_media_worker(state).await;
        }
        _ => unreachable!("command was validated before state initialization"),
    }

    let app = build_app(state.clone(), request_timeout);
    cloudfront_invalidations::spawn_worker(state.clone());
    origin_cleanup::spawn_worker(state.clone());

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
    // Select one provider when both ring and aws-lc-rs are present in the
    // transitive dependency graph.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

async fn run_media_worker(state: Arc<AppState>) -> Result<()> {
    tracing::info!(
        worker_id = %state.config.media_worker.worker_id,
        poll_interval_ms = state.config.media_worker.poll_interval.as_millis(),
        "rend-api media worker listening for queued jobs",
    );

    let (shutdown_sender, mut shutdown) = watch::channel(false);
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown_sender.send(true);
    });
    let mut last_upload_expiry_sweep = Instant::now() - Duration::from_secs(60);
    let mut last_lease_recovery_sweep = Instant::now() - Duration::from_secs(30);
    let mut last_attempt_cleanup_sweep = Instant::now() - Duration::from_secs(10 * 60);
    let mut last_queue_metric = Instant::now() - Duration::from_secs(30);
    loop {
        if *shutdown.borrow() {
            tracing::info!(
                worker_id = %state.config.media_worker.worker_id,
                "rend-api media worker shutting down",
            );
            break;
        }
        if last_upload_expiry_sweep.elapsed() >= Duration::from_secs(60) {
            match uploads::expire_upload_sessions(
                &state.db,
                &state.source_s3,
                &state.config.source_bucket,
                100,
            )
            .await
            {
                Ok(expired) if expired > 0 => {
                    tracing::info!(expired, "expired abandoned multipart upload sessions");
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::error!(error = %error, "failed to expire multipart upload sessions");
                }
            }
            last_upload_expiry_sweep = Instant::now();
        }
        if last_lease_recovery_sweep.elapsed() >= Duration::from_secs(30) {
            match recover_expired_media_jobs(&state.db, 100).await {
                Ok(recovered) => {
                    for (asset_id, lease_token) in &recovered {
                        if let Err(error) = media::cleanup_attempt_prefix(
                            &state.db,
                            &state.s3,
                            &state.config.s3_bucket,
                            asset_id,
                            lease_token,
                        )
                        .await
                        {
                            tracing::warn!(asset_id, lease_token, error = %error, "failed to clean expired media attempt objects");
                        }
                    }
                    if !recovered.is_empty() {
                        tracing::warn!(
                            count = recovered.len(),
                            "recovered expired media job leases"
                        );
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "failed to recover expired media job leases")
                }
            }
            last_lease_recovery_sweep = Instant::now();
        }
        if last_attempt_cleanup_sweep.elapsed() >= Duration::from_secs(10 * 60) {
            match recent_terminal_media_attempts(&state.db, 100).await {
                Ok(attempts) => {
                    for (asset_id, lease_token) in attempts {
                        if let Err(error) = media::cleanup_attempt_prefix(
                            &state.db,
                            &state.s3,
                            &state.config.s3_bucket,
                            &asset_id,
                            &lease_token,
                        )
                        .await
                        {
                            tracing::warn!(asset_id, lease_token, error = %error, "failed to sweep unreferenced terminal media attempt objects");
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "failed to list terminal media attempts for object cleanup")
                }
            }
            last_attempt_cleanup_sweep = Instant::now();
        }
        if last_queue_metric.elapsed() >= Duration::from_secs(30) {
            if let Err(error) = publish_media_queue_metrics(&state).await {
                tracing::warn!(error = %error, "failed to publish media queue metrics");
            }
            last_queue_metric = Instant::now();
        }
        match process_next_media_job(state.clone(), shutdown.clone()).await {
            Ok(true) => {}
            Ok(false) => {
                tokio::select! {
                    changed = shutdown.changed() => {
                        let _ = changed;
                    }
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
                    changed = shutdown.changed() => {
                        let _ = changed;
                    }
                    _ = tokio::time::sleep(state.config.media_worker.poll_interval) => {}
                }
            }
        }
    }

    Ok(())
}

async fn publish_media_queue_metrics(state: &AppState) -> Result<()> {
    let (queued, oldest_age_seconds, active_workers): (i64, f64, i64) = sqlx::query_as(
        "
        SELECT
          count(*) FILTER (
            WHERE (attempts < max_attempts AND status IN ('queued', 'deferred_budget') AND run_after <= now())
               OR (status = 'running' AND lease_expires_at <= now())
          ),
          COALESCE(max(EXTRACT(EPOCH FROM (now() - job.created_at))) FILTER (
            WHERE (attempts < max_attempts AND status IN ('queued', 'deferred_budget') AND run_after <= now())
               OR (status = 'running' AND lease_expires_at <= now())
          ), 0)::double precision,
          GREATEST(count(DISTINCT locked_by) FILTER (
            WHERE status = 'running' AND lease_expires_at > now()
          ), 1)
        FROM rend.media_jobs job
        JOIN rend.assets asset
          ON asset.id = job.asset_id
         AND asset.deleted_at IS NULL
         AND asset.suspended_at IS NULL
        JOIN rend_auth.organization org
          ON org.id = asset.organization_id
         AND org.suspended_at IS NULL
        JOIN rend.organization_storage_usage quota
          ON quota.organization_id = asset.organization_id
        WHERE job.job_type = 'process_media'
        ",
    )
    .fetch_one(&state.db)
    .await?;
    let queued_per_worker = queued.max(0) as f64 / active_workers.max(1) as f64;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let metric = serde_json::json!({
        "_aws": {
            "Timestamp": timestamp,
            "CloudWatchMetrics": [{
                "Namespace": "Rend/Media",
                "Dimensions": [["Environment"]],
                "Metrics": [
                    {"Name": "QueuedJobsPerWorker", "Unit": "Count"},
                    {"Name": "OldestQueuedJobAgeSeconds", "Unit": "Seconds"}
                ]
            }]
        },
        "Environment": state.config.edge_registry.rend_env.as_str(),
        "QueuedJobsPerWorker": queued_per_worker,
        "OldestQueuedJobAgeSeconds": oldest_age_seconds.max(0.0)
    });
    println!("{metric}");
    Ok(())
}

async fn recover_expired_media_jobs(db: &PgPool, limit: i64) -> Result<Vec<(String, String)>> {
    let candidates: Vec<(String, String)> = sqlx::query_as(
        "
        SELECT id::text, asset_id::text
        FROM rend.media_jobs
        WHERE status = 'running' AND lease_expires_at <= now()
        ORDER BY lease_expires_at, id
        LIMIT $1
        ",
    )
    .bind(limit.clamp(1, 1_000))
    .fetch_all(db)
    .await?;
    let mut recovered = Vec::with_capacity(candidates.len());
    for (job_id, asset_id) in candidates {
        let mut tx = db.begin().await?;
        let asset: Option<(String, String, bool, bool, bool)> = sqlx::query_as(
            "
            SELECT asset.organization_id::text, asset.playable_state,
                   asset.deleted_at IS NOT NULL, asset.suspended_at IS NOT NULL,
                   org.suspended_at IS NOT NULL
            FROM rend.assets asset
            INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
            WHERE asset.id = $1::uuid
            FOR UPDATE OF asset
            ",
        )
        .bind(&asset_id)
        .fetch_optional(&mut *tx)
        .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(&job_id)
            .execute(&mut *tx)
            .await?;
        let job: Option<(String, i32, i32, i64, i64, Option<String>)> = sqlx::query_as(
            "
            SELECT lease_token::text, attempts, max_attempts,
                   reserved_output_bytes, reserved_microusd,
                   reservation_month::text
            FROM rend.media_jobs
            WHERE id = $1::uuid AND asset_id = $2::uuid
              AND status = 'running' AND lease_expires_at <= now()
            FOR UPDATE
            ",
        )
        .bind(&job_id)
        .bind(&asset_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((
            lease_token,
            attempts,
            max_attempts,
            reserved_output,
            reserved_compute,
            reservation_month,
        )) = job
        else {
            tx.commit().await?;
            continue;
        };
        let terminal = jobs::is_final_attempt(attempts, max_attempts);
        let reason = "media worker lease expired";

        if reserved_compute > 0 {
            let reservation_month = reservation_month.as_deref().ok_or_else(|| {
                sqlx::Error::Protocol(
                    "expired media job has a compute reservation without an accounting month"
                        .into(),
                )
            })?;
            let released = sqlx::query(
                "
                UPDATE rend.media_compute_months
                SET reserved_microusd = GREATEST(reserved_microusd - $1, 0),
                    spent_microusd = spent_microusd + $1
                WHERE month = $2::date
                ",
            )
            .bind(reserved_compute)
            .bind(reservation_month)
            .execute(&mut *tx)
            .await?;
            if released.rows_affected() != 1 {
                return Err(sqlx::Error::Protocol(
                    "expired media job reservation month has no accounting row".into(),
                )
                .into());
            }
        }

        if terminal
            && let Some((organization_id, _, _, _, _)) = asset.as_ref()
            && reserved_output > 0
        {
            sqlx::query(
                "UPDATE rend.organization_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $2, 0) WHERE organization_id = $1::uuid",
            )
            .bind(organization_id)
            .bind(reserved_output)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE rend.global_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $1, 0) WHERE singleton",
            )
            .bind(reserved_output)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "
                INSERT INTO rend.storage_ledger_entries (
                  organization_id, asset_id, reference_key, reason, reserved_bytes_delta
                ) VALUES ($1::uuid, $2::uuid, $3, 'media_output_released_expired_lease', $4)
                ON CONFLICT (organization_id, reference_key) DO NOTHING
                ",
            )
            .bind(organization_id)
            .bind(&asset_id)
            .bind(format!("media:{lease_token}:expired"))
            .bind(-reserved_output)
            .execute(&mut *tx)
            .await?;
        }

        if let Some((_, playable_state, deleted, asset_suspended, org_suspended)) = asset
            && !deleted
            && !asset_suspended
            && !org_suspended
        {
            events::insert_asset_event(
                &mut tx,
                &asset_id,
                events::EVENT_MEDIA_PROCESSING_FAILED,
                events::media_processing_failed_metadata(attempts, max_attempts, terminal, reason),
            )
            .await?;
            if terminal && !matches!(playable_state.as_str(), "opener_ready" | "hls_ready") {
                sqlx::query(
                    "UPDATE rend.assets SET source_state = 'uploaded', playable_state = 'failed', current_opener_artifact_id = NULL WHERE id = $1::uuid",
                )
                .bind(&asset_id)
                .execute(&mut *tx)
                .await?;
                if playable_state != "failed" {
                    events::insert_asset_event(
                        &mut tx,
                        &asset_id,
                        events::EVENT_PLAYABLE_STATE_CHANGED,
                        events::playable_state_changed_metadata(&playable_state, "failed"),
                    )
                    .await?;
                }
            } else {
                sqlx::query("UPDATE rend.assets SET source_state = 'uploaded' WHERE id = $1::uuid")
                    .bind(&asset_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }

        let status = if terminal {
            jobs::STATUS_FAILED
        } else {
            jobs::STATUS_QUEUED
        };
        sqlx::query(
            "
            UPDATE rend.media_jobs
            SET status = $2, last_error = $3,
                locked_at = NULL, locked_by = NULL, lease_token = NULL,
                lease_expires_at = NULL, heartbeat_at = NULL,
                reserved_output_bytes = CASE WHEN $4 THEN 0 ELSE reserved_output_bytes END,
                reserved_microusd = 0, reservation_month = NULL,
                actual_microusd = COALESCE(actual_microusd, 0) + $5,
                completed_at = CASE WHEN $4 THEN now() ELSE NULL END,
                run_after = now()
            WHERE id = $1::uuid
            ",
        )
        .bind(&job_id)
        .bind(status)
        .bind(reason)
        .bind(terminal)
        .bind(reserved_compute)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "
            UPDATE rend.media_job_attempts
            SET status = $3, finished_at = now(), error = $4,
                actual_microusd = COALESCE(actual_microusd, 0) + $5
            WHERE job_id = $1::uuid AND lease_token = $2::uuid AND status = 'running'
            ",
        )
        .bind(&job_id)
        .bind(&lease_token)
        .bind(if terminal { "failed" } else { "lease_lost" })
        .bind(reason)
        .bind(reserved_compute)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        recovered.push((asset_id, lease_token));
    }
    Ok(recovered)
}

async fn recent_terminal_media_attempts(db: &PgPool, limit: i64) -> Result<Vec<(String, String)>> {
    sqlx::query_as(
        "
        SELECT asset_id::text, lease_token::text
        FROM rend.media_job_attempts
        WHERE status <> 'running'
          AND finished_at <= now() - interval '5 minutes'
          AND finished_at >= now() - interval '24 hours'
        ORDER BY finished_at DESC
        LIMIT $1
        ",
    )
    .bind(limit.clamp(1, 1_000))
    .fetch_all(db)
    .await
    .context("failed to load recent terminal media attempts")
}

fn build_app(state: Arc<AppState>, request_timeout: Duration) -> Router {
    let authenticated_routes = Router::new()
        .route("/v1/videos", post(create_video))
        .route("/v1/uploads", post(create_upload))
        .route(
            "/v1/uploads/{upload_id}",
            get(get_upload).delete(abort_upload),
        )
        .route("/v1/uploads/{upload_id}/parts", post(sign_upload_parts))
        .route("/v1/uploads/{upload_id}/complete", post(complete_upload))
        .route("/v1/events", get(get_event_stream))
        .route(
            "/v1/analytics/overview",
            get(telemetry::get_analytics_overview),
        )
        .route("/v1/analytics/live", get(telemetry::get_analytics_live))
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
    let site_internal_routes = Router::new()
        .route("/assets/{asset_id}/thumbnail", get(get_asset_thumbnail))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_api_auth,
        ));
    let site_player_telemetry_routes = Router::new()
        .route(
            "/v1/site/player-telemetry",
            post(telemetry::post_player_telemetry),
        )
        .route_layer(DefaultBodyLimit::max(
            state.config.playback_telemetry.max_body_bytes,
        ))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_site_internal_token,
        ));
    let telemetry_routes = Router::new()
        .route("/playback", post(telemetry::post_playback_telemetry))
        .route("/player", post(telemetry::post_player_telemetry))
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
        .route("/playback/artifact", get(resolve_edge_playback_artifact))
        .route(
            "/playback/availability",
            get(resolve_edge_playback_availability),
        )
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
    let metrics_routes =
        Router::new()
            .route("/metrics", get(metrics))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_internal_edge_token,
            ));

    let playback_mode = state.config.playback_mode;
    let cors = cors_layer(&state.config.cors_allowed_origins);

    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/healthz", get(healthz))
        .route("/v1/readyz", get(readyz))
        .route("/player", get(player_harness))
        .merge(metrics_routes)
        .merge(authenticated_routes)
        .merge(site_player_telemetry_routes)
        .nest("/internal/site", site_internal_routes)
        .nest("/internal/edges", edge_routes)
        .nest("/internal/operator", operator_routes)
        .nest("/internal/telemetry", telemetry_routes);

    if playback_mode == PlaybackMode::Tigris {
        app = app.route("/embed-fast/{asset_id}", get(api_fast_embed));
        // This route validates Rend playback cookies/tokens and streams private
        // origin objects without exposing object-store signed URLs.
        app = app.route(
            "/v/{asset_id}/{*artifact_path}",
            get(playback_origin_artifact).route_layer(DefaultBodyLimit::disable()),
        );
    }

    app = app
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
        .layer(cors);

    app.with_state(state)
}

fn build_s3_client(config: &ApiConfig) -> S3Client {
    build_s3_client_for_endpoint(config, &config.s3_endpoint)
}

fn build_s3_client_for_endpoint(config: &ApiConfig, endpoint: &str) -> S3Client {
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
        .endpoint_url(endpoint)
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
        let hostname = env_string("HOSTNAME", "unknown-task")
            .trim()
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
            .take(80)
            .collect::<String>();
        format!("rend-media-worker-{hostname}-{}", std::process::id())
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

async fn metrics(State(state): State<Arc<AppState>>) -> Response {
    let body = format!(
        "# HELP rend_api_telemetry_ingested_events_total Telemetry events accepted into ClickHouse by rend-api.\n\
         # TYPE rend_api_telemetry_ingested_events_total counter\n\
         rend_api_telemetry_ingested_events_total {}\n\
         # HELP rend_api_telemetry_ingest_lag_ms Latest accepted telemetry ingest lag in milliseconds.\n\
         # TYPE rend_api_telemetry_ingest_lag_ms gauge\n\
         rend_api_telemetry_ingest_lag_ms {}\n\
         # HELP rend_api_analytics_rollup_lag_ms Latest successful analytics rollup lag in milliseconds.\n\
         # TYPE rend_api_analytics_rollup_lag_ms gauge\n\
         rend_api_analytics_rollup_lag_ms {}\n\
         # HELP rend_api_analytics_rollup_last_success_unix_seconds Last successful analytics rollup refresh time.\n\
         # TYPE rend_api_analytics_rollup_last_success_unix_seconds gauge\n\
         rend_api_analytics_rollup_last_success_unix_seconds {}\n\
         # HELP rend_api_analytics_rollup_refresh_total Analytics rollup refreshes by result.\n\
         # TYPE rend_api_analytics_rollup_refresh_total counter\n\
         rend_api_analytics_rollup_refresh_total{{result=\"success\"}} {}\n\
         rend_api_analytics_rollup_refresh_total{{result=\"failure\"}} {}\n",
        state
            .metrics
            .telemetry_ingested_events_total
            .load(Ordering::Relaxed),
        state
            .metrics
            .telemetry_ingest_lag_ms
            .load(Ordering::Relaxed),
        state
            .metrics
            .analytics_rollup_lag_ms
            .load(Ordering::Relaxed),
        state
            .metrics
            .analytics_rollup_last_success_unix_seconds
            .load(Ordering::Relaxed),
        state
            .metrics
            .analytics_rollup_success_total
            .load(Ordering::Relaxed),
        state
            .metrics
            .analytics_rollup_failure_total
            .load(Ordering::Relaxed),
    );

    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response()
}

async fn readyz(State(state): State<Arc<AppState>>) -> Response {
    let checks = vec![
        check_postgres(&state).await,
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

async fn create_upload(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    headers: HeaderMap,
    Json(request): Json<CreateUploadRequest>,
) -> Response {
    match create_upload_inner(state, auth, headers, request).await {
        Ok(response) => (StatusCode::CREATED, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn create_upload_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    headers: HeaderMap,
    request: CreateUploadRequest,
) -> Result<uploads::UploadSession, AppError> {
    require_scope(&auth, ApiScope::Upload)?;
    ensure_dashboard_upload_metadata(&auth, &request)?;
    ensure_org_not_suspended(&state.db, &auth.organization_id).await?;
    let idempotency_key = header_string(&headers, "idempotency-key")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::bad_request("Idempotency-Key is required"))?;
    uploads::create_upload_session(
        &state.db,
        &state.source_s3,
        &state.config.source_bucket,
        &state.config.upload_limits,
        uploads::CreateUploadInput {
            organization_id: auth.organization_id,
            idempotency_key: idempotency_key.to_owned(),
            content_type: request.content_type,
            content_length: request.content_length,
            filename: request.filename,
        },
    )
    .await
    .map_err(upload_app_error)
}

async fn sign_upload_parts(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(upload_id): AxumPath<String>,
    Json(request): Json<SignUploadPartsRequest>,
) -> Response {
    if let Err(error) = require_scope(&auth, ApiScope::Upload) {
        return error.into_response();
    }
    match uploads::sign_upload_parts(
        &state.db,
        &state.upload_s3,
        &state.config.source_bucket,
        &auth.organization_id,
        &upload_id,
        &request.parts,
        state.config.upload_limits.signed_url_ttl,
    )
    .await
    {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => upload_app_error(error).into_response(),
    }
}

async fn get_upload(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(upload_id): AxumPath<String>,
) -> Response {
    if let Err(error) = require_scope(&auth, ApiScope::Upload) {
        return error.into_response();
    }
    match uploads::get_upload_session(
        &state.db,
        &state.source_s3,
        &state.config.source_bucket,
        &auth.organization_id,
        &upload_id,
    )
    .await
    {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => upload_app_error(error).into_response(),
    }
}

async fn complete_upload(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(upload_id): AxumPath<String>,
    Json(request): Json<CompleteUploadRequest>,
) -> Response {
    if let Err(error) = require_scope(&auth, ApiScope::Upload) {
        return error.into_response();
    }
    match uploads::complete_upload_session(
        &state.db,
        &state.source_s3,
        &state.config.source_bucket,
        &auth.organization_id,
        &upload_id,
        &request.parts,
        state.config.upload_limits.media_job_max_attempts,
    )
    .await
    {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => upload_app_error(error).into_response(),
    }
}

async fn abort_upload(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(upload_id): AxumPath<String>,
) -> Response {
    if let Err(error) = require_scope(&auth, ApiScope::Upload) {
        return error.into_response();
    }
    match uploads::abort_upload_session(
        &state.db,
        &state.source_s3,
        &state.config.source_bucket,
        &auth.organization_id,
        &upload_id,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => upload_app_error(error).into_response(),
    }
}

fn ensure_dashboard_upload_metadata(
    auth: &RequestAuth,
    request: &CreateUploadRequest,
) -> Result<(), AppError> {
    if auth.credential != RequestCredential::DashboardUploadToken {
        return Ok(());
    }
    let claims = auth
        .upload_claims
        .as_ref()
        .ok_or_else(|| AppError::forbidden("upload token is missing multipart claims"))?;
    if claims.v != 2 || claims.purpose.as_deref() != Some("multipart_upload") {
        return Err(AppError::forbidden(
            "upload token is not valid for multipart uploads",
        ));
    }
    if claims.content_type != request.content_type
        || claims
            .content_length
            .and_then(|value| i64::try_from(value).ok())
            != Some(request.content_length)
    {
        return Err(AppError::forbidden(
            "upload token does not match declared file metadata",
        ));
    }
    Ok(())
}

fn upload_app_error(error: uploads::UploadError) -> AppError {
    match error {
        uploads::UploadError::Invalid(message) => AppError::bad_request(message),
        uploads::UploadError::NotFound => AppError::not_found("upload session not found"),
        uploads::UploadError::Conflict(message) => AppError {
            status: StatusCode::CONFLICT,
            message,
        },
        uploads::UploadError::Quota(message) => AppError {
            status: StatusCode::FORBIDDEN,
            message,
        },
        uploads::UploadError::TooLarge(message) => AppError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message,
        },
        uploads::UploadError::Unavailable(message) => AppError::forbidden(message),
        uploads::UploadError::Storage(message) => AppError::bad_gateway(message),
        uploads::UploadError::Database(error) => AppError::internal(error),
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

async fn get_asset_thumbnail(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(asset_id): AxumPath<String>,
) -> Response {
    match get_asset_thumbnail_inner(state, auth, asset_id).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn get_asset_thumbnail_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    asset_id: String,
) -> Result<Response, AppError> {
    if auth.credential != RequestCredential::SiteInternal {
        return Err(AppError::forbidden("site internal auth required"));
    }
    require_scope(&auth, ApiScope::Read)?;
    let thumbnail = fetch_asset_thumbnail_record(
        &state.db,
        &auth.organization_id,
        &asset_id,
        auth.allows_suspended_reads(),
    )
    .await?
    .ok_or_else(|| AppError::not_found("thumbnail not found"))?;

    let expected_size = thumbnail
        .byte_size
        .and_then(|value| usize::try_from(value).ok());
    if expected_size.is_some_and(|value| value > MAX_THUMBNAIL_BYTES) {
        return Err(AppError::internal("thumbnail artifact exceeds size limit"));
    }

    let object = state
        .s3
        .get_object()
        .bucket(&state.config.s3_bucket)
        .key(&thumbnail.object_key)
        .send()
        .await
        .map_err(AppError::internal)?;
    let mut reader = object
        .body
        .into_async_read()
        .take((MAX_THUMBNAIL_BYTES + 1) as u64);
    let mut bytes = Vec::with_capacity(expected_size.unwrap_or(32 * 1024).min(MAX_THUMBNAIL_BYTES));
    reader
        .read_to_end(&mut bytes)
        .await
        .map_err(AppError::internal)?;
    if bytes.len() > MAX_THUMBNAIL_BYTES {
        return Err(AppError::internal("thumbnail artifact exceeds size limit"));
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, thumbnail.content_type)
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header("x-content-type-options", "nosniff")
        .body(Body::from(bytes))
        .map_err(AppError::internal)
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
    ensure_asset_deletable(&state.db, &auth.organization_id, &asset_id).await?;
    uploads::abort_active_asset_upload(
        &state.db,
        &state.source_s3,
        &state.config.source_bucket,
        &auth.organization_id,
        &asset_id,
    )
    .await
    .map_err(upload_app_error)?;
    let (already_deleted, cloudfront_invalidation_queued) = mark_asset_deleted(
        &state.db,
        &auth.organization_id,
        &asset_id,
        state.config.cloudfront_distribution_id.as_deref(),
        state.config.source_bucket == state.config.s3_bucket,
    )
    .await?;
    if !already_deleted {
        billing::track_asset_delete(&state, &auth.organization_id, &asset_id).await;
    }
    let origin_objects_deleted = usize::try_from(
        origin_cleanup::wait_for_asset(&state.db, &asset_id, Duration::from_secs(5)).await,
    )
    .unwrap_or(usize::MAX);
    let purge_attempted = maybe_purge_edge(
        &state.db,
        &state.http,
        &state.config.edge_registry,
        &state.config.edge_purge,
        &asset_id,
        None,
    )
    .await;
    Ok(DeleteAssetResponse {
        asset_id,
        deleted: true,
        already_deleted,
        // A zero count can mean cleanup is still queued after the bounded
        // response wait; the durable worker continues until it succeeds.
        origin_objects_deleted,
        purge_attempted: purge_attempted || cloudfront_invalidation_queued,
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
    let asset_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id::text FROM rend.assets WHERE organization_id = $1::uuid AND deleted_at IS NULL ORDER BY id",
    )
    .bind(&organization_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    let invalidation_paths = organization_invalidation_paths(&asset_ids);
    let mut cloudfront_invalidation_queued = false;
    for (chunk_index, paths) in invalidation_paths
        .chunks(CLOUDFRONT_INVALIDATION_PATH_LIMIT)
        .enumerate()
    {
        cloudfront_invalidation_queued |= cloudfront_invalidations::enqueue(
            &mut tx,
            state.config.cloudfront_distribution_id.as_deref(),
            &format!("suspend-org:{audit_id}:{chunk_index}"),
            &format!("rend-suspend-org-{audit_id}-{chunk_index}"),
            paths,
        )
        .await
        .map_err(AppError::internal)?;
    }
    tx.commit().await.map_err(AppError::internal)?;

    let mut purge_attempted = cloudfront_invalidation_queued;
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

fn organization_invalidation_paths(asset_ids: &[String]) -> Vec<String> {
    asset_ids
        .iter()
        .map(|asset_id| format!("/v/{asset_id}/*"))
        .collect()
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
    let cloudfront_invalidation_queued = cloudfront_invalidations::enqueue(
        &mut tx,
        state.config.cloudfront_distribution_id.as_deref(),
        &format!("suspend-asset:{audit_id}"),
        &format!("rend-suspend-asset-{audit_id}"),
        &[format!("/v/{asset_id}/*")],
    )
    .await
    .map_err(AppError::internal)?;
    tx.commit().await.map_err(AppError::internal)?;

    let mut purge_attempted = cloudfront_invalidation_queued;
    purge_attempted |= maybe_purge_edge(
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
            for cookie in playback_cookie_headers(
                &response.playback_token,
                response.ttl_seconds,
                response.playback_token_expires_at,
                &state.config.playback_base_url,
                &response.asset_id,
                state.config.playback_cookie_domain.as_deref(),
                state.config.cloudfront_cookie_signer.as_ref(),
            ) {
                if let Ok(cookie) = cookie.parse() {
                    headers.append(header::SET_COOKIE, cookie);
                }
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

async fn api_fast_embed(
    State(state): State<Arc<AppState>>,
    AxumPath(asset_id): AxumPath<String>,
    Query(query): Query<FastEmbedQuery>,
) -> Response {
    match api_fast_embed_inner(state, asset_id, query).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn api_fast_embed_inner(
    state: Arc<AppState>,
    asset_id: String,
    query: FastEmbedQuery,
) -> Result<Response, AppError> {
    let playback_base_url =
        fast_embed_playback_base_url(state.as_ref(), query.playback_base_url.as_deref())?;
    let playback_credential_mode =
        fast_embed_playback_credential_mode(state.as_ref(), &playback_base_url);
    let response =
        get_public_asset_playback_inner(state.clone(), asset_id, &playback_base_url).await?;
    let startup =
        fast_embed_startup_mode(query.startup_mode.as_deref().or(query.startup.as_deref()));
    let selection = fast_embed_playback_selection(&response, startup)
        .ok_or_else(|| AppError::not_found("asset is not playable yet"))?;
    let auto_play = query_flag(query.autoplay.as_deref(), false);
    let controls = query_flag(query.controls.as_deref(), true);
    let muted = query
        .muted
        .as_deref()
        .map(|value| query_flag(Some(value), true))
        .unwrap_or(auto_play);
    let inline_startup = if startup == "mse" {
        fast_embed_inline_startup(state.as_ref(), &response, &selection, &playback_base_url)
            .await
            .unwrap_or(None)
    } else {
        None
    };
    let html = render_api_fast_embed_html(
        &response,
        &selection,
        inline_startup.as_ref(),
        auto_play,
        controls,
        muted,
        playback_credential_mode,
    );
    let mut rendered = Html(html).into_response();
    let headers = rendered.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-rend-fast-embed", HeaderValue::from_static("api"));
    for cookie in playback_cookie_headers(
        &response.playback_token,
        response.ttl_seconds,
        response.playback_token_expires_at,
        &playback_base_url,
        &response.asset_id,
        state.config.playback_cookie_domain.as_deref(),
        state.config.cloudfront_cookie_signer.as_ref(),
    ) {
        if let Ok(cookie) = cookie.parse() {
            headers.append(header::SET_COOKIE, cookie);
        }
    }
    Ok(rendered)
}

async fn get_public_asset_playback_inner(
    state: Arc<AppState>,
    asset_id: String,
    playback_base_url: &str,
) -> Result<PlaybackBootstrapResponse, AppError> {
    let asset = fetch_public_asset_playback_record(&state.db, &asset_id).await?;
    let artifacts = if let Some(asset) = asset.as_ref() {
        fetch_playback_artifacts(&state.db, &asset.organization_id, &asset.asset_id).await?
    } else {
        Vec::new()
    };
    let now = current_unix_timestamp().map_err(AppError::internal)?;

    playback_bootstrap_response(
        asset,
        &artifacts,
        playback_base_url,
        &state.config.playback_token_issuer,
        state.config.playback_bootstrap_prefetch_segments,
        now,
    )
}

async fn playback_origin_artifact(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<PlaybackOriginPath>,
    Query(query): Query<PlaybackOriginQuery>,
    headers: HeaderMap,
) -> Response {
    match playback_origin_artifact_inner(state, path, query, headers).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn resolve_edge_playback_artifact(
    State(state): State<Arc<AppState>>,
    Query(query): Query<InternalArtifactResolutionQuery>,
) -> Result<Json<InternalArtifactResolutionResponse>, AppError> {
    let artifact = origin_playback_artifact(&query.asset_id, &query.artifact_path)?;
    let storage_object_key = origin_playback_storage_object_key(state.as_ref(), &artifact).await?;
    Ok(Json(InternalArtifactResolutionResponse {
        storage_object_key,
        content_type: artifact.content_type,
    }))
}

async fn resolve_edge_playback_availability(
    State(state): State<Arc<AppState>>,
    Query(query): Query<InternalAssetAvailabilityQuery>,
) -> Result<Json<InternalAssetAvailabilityResponse>, AppError> {
    let asset_id = normalize_asset_id(&query.asset_id)?;
    let available: bool = sqlx::query_scalar(
        "
        SELECT EXISTS (
          SELECT 1
          FROM rend.assets asset
          INNER JOIN rend_auth.organization organization
            ON organization.id = asset.organization_id
          WHERE asset.id = $1::uuid
            AND asset.deleted_at IS NULL
            AND asset.suspended_at IS NULL
            AND organization.suspended_at IS NULL
        )
        ",
    )
    .bind(&asset_id)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::internal)?;
    if !available {
        return Err(AppError::not_found("asset not available"));
    }
    Ok(Json(InternalAssetAvailabilityResponse { available }))
}

async fn playback_origin_artifact_inner(
    state: Arc<AppState>,
    path: PlaybackOriginPath,
    query: PlaybackOriginQuery,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let artifact = origin_playback_artifact(&path.asset_id, &path.artifact_path)?;
    let cookie_token = playback_token_cookie(&headers);
    let token = query.token.as_deref().or(cookie_token.as_deref());
    let token = token.ok_or_else(|| AppError::unauthorized("unauthorized playback token"))?;
    let now = current_unix_timestamp().map_err(AppError::internal)?;
    validate_playback_token(
        token,
        &artifact.asset_id,
        &artifact.artifact_path,
        now,
        &state.config.playback_keyring,
    )
    .map_err(|_| AppError::unauthorized("unauthorized playback token"))?;

    let range_header = if is_hls_manifest_artifact_path(&artifact.artifact_path) {
        None
    } else {
        headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(normalize_single_byte_range_header)
    };

    if hls_progressive_rendition(&artifact.artifact_path).is_some() {
        match origin_playback_artifact_full_bytes(state.as_ref(), &artifact).await {
            Ok((bytes, content_type, cache_status)) => {
                return Ok(origin_playback_artifact_bytes_response(
                    artifact,
                    bytes,
                    content_type,
                    cache_status,
                    range_header.as_deref(),
                ));
            }
            Err(error) if error.status == StatusCode::NOT_FOUND => {
                return origin_playback_progressive_fmp4_response(state, artifact).await;
            }
            Err(error) => return Err(error),
        }
    }

    let cache_ttl = origin_playback_cache_ttl(&artifact);
    if cache_ttl.is_some() {
        let (bytes, content_type, cache_status) =
            origin_playback_artifact_full_bytes(state.as_ref(), &artifact).await?;
        return Ok(origin_playback_artifact_bytes_response(
            artifact,
            bytes,
            content_type,
            cache_status,
            range_header.as_deref(),
        ));
    }

    let storage_object_key = origin_playback_storage_object_key(state.as_ref(), &artifact).await?;
    let mut get_object = state
        .s3
        .get_object()
        .bucket(&state.config.s3_bucket)
        .key(&storage_object_key);
    if let Some(range_header) = range_header {
        get_object = get_object.range(range_header);
    }

    let object = get_object
        .send()
        .await
        .map_err(|error| origin_playback_artifact_error(&artifact, error))?;
    Ok(origin_playback_artifact_response(
        artifact,
        object,
        storage_object_key,
    ))
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
    .bind(&organization_id)
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
        Option<i64>,
        bool,
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
               asset.duration_ms,
               count(artifact.id) FILTER (WHERE artifact.kind = 'thumbnail') > 0 AS has_thumbnail,
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
                duration_ms,
                has_thumbnail,
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
                duration_ms,
                has_thumbnail,
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

async fn fetch_asset_thumbnail_record(
    db: &PgPool,
    organization_id: &str,
    asset_id: &str,
    include_suspended: bool,
) -> Result<Option<AssetThumbnailRecord>, AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let organization_id = normalize_org_id(organization_id)?;
    let row: Option<(String, String, Option<i64>)> = sqlx::query_as(
        "
        SELECT artifact.storage_object_key, artifact.content_type, artifact.byte_size
        FROM rend.artifacts artifact
        INNER JOIN rend.assets asset ON asset.id = artifact.asset_id
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE artifact.asset_id = $1::uuid
          AND asset.organization_id = $2::uuid
          AND asset.deleted_at IS NULL
          AND ($3::boolean OR asset.suspended_at IS NULL)
          AND ($3::boolean OR org.suspended_at IS NULL)
          AND artifact.kind = 'thumbnail'
          AND artifact.content_type = 'image/jpeg'
        ORDER BY artifact.created_at DESC
        LIMIT 1
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
    .bind(include_suspended)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    Ok(row.map(
        |(object_key, content_type, byte_size)| AssetThumbnailRecord {
            object_key,
            content_type,
            byte_size,
        },
    ))
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
    cloudfront_distribution_id: Option<&str>,
    source_is_media_bucket: bool,
) -> Result<(bool, bool), AppError> {
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
    .bind(&organization_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    origin_cleanup::enqueue(&mut tx, asset_id, source_is_media_bucket)
        .await
        .map_err(AppError::internal)?;

    let Some((source_state, playable_state, already_deleted)) = row else {
        return Err(AppError::not_found("asset not found"));
    };
    let invalidation_configured = cloudfront_distribution_id.is_some();
    cloudfront_invalidations::enqueue(
        &mut tx,
        cloudfront_distribution_id,
        &format!("delete:{asset_id}"),
        &format!("rend-delete-{asset_id}"),
        &[format!("/v/{asset_id}/*")],
    )
    .await
    .map_err(AppError::internal)?;

    if already_deleted && source_state == "deleted" && playable_state == "deleted" {
        tx.commit().await.map_err(AppError::internal)?;
        return Ok((true, invalidation_configured));
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

    let _: Vec<String> = sqlx::query_scalar(
        "SELECT id::text FROM rend.media_jobs WHERE asset_id = $1::uuid AND status IN ('queued', 'running', 'deferred_budget') FOR UPDATE",
    )
    .bind(asset_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(AppError::internal)?;

    let used_bytes: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(byte_size), 0)::bigint FROM rend.artifacts WHERE asset_id = $1::uuid",
    )
    .bind(asset_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    let reserved_output_bytes: i64 = sqlx::query_scalar(
        "
        SELECT COALESCE(sum(reserved_output_bytes), 0)::bigint
        FROM rend.media_jobs
        WHERE asset_id = $1::uuid AND status IN ('queued', 'running', 'deferred_budget')
        ",
    )
    .bind(asset_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    sqlx::query(
        "
        WITH reservations AS (
          SELECT reservation_month, sum(reserved_microusd)::bigint AS reserved_microusd
          FROM rend.media_jobs
          WHERE asset_id = $1::uuid
            AND status IN ('queued', 'running', 'deferred_budget')
            AND reservation_month IS NOT NULL
            AND reserved_microusd > 0
          GROUP BY reservation_month
        )
        UPDATE rend.media_compute_months month
        SET reserved_microusd = GREATEST(month.reserved_microusd - reservations.reserved_microusd, 0)
        FROM reservations
        WHERE month.month = reservations.reservation_month
        ",
    )
    .bind(asset_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    sqlx::query(
        "
        UPDATE rend.media_jobs
        SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL, locked_at = NULL, locked_by = NULL,
            reserved_output_bytes = 0, reserved_microusd = 0,
            reservation_month = NULL,
            completed_at = now(), last_error = 'asset deleted'
        WHERE asset_id = $1::uuid AND status IN ('queued', 'running', 'deferred_budget')
        ",
    )
    .bind(asset_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    sqlx::query(
        "
        UPDATE rend.media_job_attempts
        SET status = 'cancelled', finished_at = now(), error = 'asset deleted'
        WHERE asset_id = $1::uuid AND status = 'running'
        ",
    )
    .bind(asset_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    sqlx::query(
        "
        UPDATE rend.organization_storage_usage
        SET used_bytes = GREATEST(used_bytes - $2, 0),
            reserved_bytes = GREATEST(reserved_bytes - $3, 0)
        WHERE organization_id = $1::uuid
        ",
    )
    .bind(&organization_id)
    .bind(used_bytes)
    .bind(reserved_output_bytes)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    sqlx::query(
        "
        UPDATE rend.global_storage_usage
        SET used_bytes = GREATEST(used_bytes - $1, 0),
            reserved_bytes = GREATEST(reserved_bytes - $2, 0)
        WHERE singleton
        ",
    )
    .bind(used_bytes)
    .bind(reserved_output_bytes)
    .execute(&mut *tx)
    .await
    .map_err(AppError::internal)?;
    if used_bytes > 0 || reserved_output_bytes > 0 {
        sqlx::query(
            "
            INSERT INTO rend.storage_ledger_entries (
              organization_id, asset_id, reference_key, reason,
              reserved_bytes_delta, used_bytes_delta
            )
            VALUES ($1::uuid, $2::uuid, $3, 'asset_deleted', $4, $5)
            ON CONFLICT (organization_id, reference_key) DO NOTHING
            ",
        )
        .bind(&organization_id)
        .bind(asset_id)
        .bind(format!("asset:{asset_id}:delete"))
        .bind(-reserved_output_bytes)
        .bind(-used_bytes)
        .execute(&mut *tx)
        .await
        .map_err(AppError::internal)?;
    }
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
    Ok((false, invalidation_configured))
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

pub(crate) async fn ensure_org_not_suspended(
    db: &PgPool,
    organization_id: &str,
) -> Result<(), AppError> {
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

async fn ensure_asset_deletable(
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
        WHERE asset.id = $1::uuid AND asset.organization_id = $2::uuid
        ",
    )
    .bind(asset_id)
    .bind(organization_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;
    match row {
        Some((true, _, _)) | Some((false, false, false)) => Ok(()),
        None => Err(AppError::not_found("asset not found")),
        Some((false, _, true)) => Err(AppError::forbidden("organization is suspended")),
        Some((false, true, _)) => Err(AppError::forbidden("asset is suspended")),
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
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "
        SELECT asset.id::text,
               asset.organization_id::text,
               asset.source_state,
               asset.playable_state
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
        |(asset_id, organization_id, source_state, playable_state)| AssetPlaybackRecord {
            asset_id,
            organization_id,
            source_state,
            playable_state,
        },
    ))
}

async fn fetch_public_asset_playback_record(
    db: &PgPool,
    asset_id: &str,
) -> Result<Option<AssetPlaybackRecord>, AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "
        SELECT asset.id::text,
               asset.organization_id::text,
               asset.source_state,
               asset.playable_state
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
          AND asset.deleted_at IS NULL
          AND asset.suspended_at IS NULL
          AND org.suspended_at IS NULL
        ",
    )
    .bind(asset_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    Ok(row.map(
        |(asset_id, organization_id, source_state, playable_state)| AssetPlaybackRecord {
            asset_id,
            organization_id,
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

    let token = issue_playback_token(issuer, &asset.asset_id, Some(&asset.organization_id), now)
        .map_err(AppError::internal)?;
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

fn query_flag(value: Option<&str>, fallback: bool) -> bool {
    match value.map(str::trim) {
        None => fallback,
        Some("") | Some("1") | Some("true") => true,
        Some("0") | Some("false") => false,
        Some(_) => fallback,
    }
}

fn fast_embed_startup_mode(value: Option<&str>) -> &'static str {
    match value {
        Some("mse") | Some("inline") | Some("inline-mse") => "mse",
        Some("opener") => "opener",
        Some("hls") | Some("native") => "hls",
        Some("progressive") => "progressive",
        _ => "mse",
    }
}

fn fast_embed_playback_base_url(state: &AppState, value: Option<&str>) -> Result<String, AppError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(state.config.playback_base_url.clone());
    };
    let requested = normalize_fast_embed_playback_base_url(
        value,
        state.config.edge_registry.rend_env,
        state.config.edge_registry.allow_insecure_edge_urls,
    )
    .map_err(|error| AppError::bad_request(error.to_string()))?;

    let allowed = requested == state.config.playback_base_url
        || state
            .config
            .edge_registry
            .expected_edges
            .iter()
            .any(|edge| edge.base_url == requested)
        || state
            .config
            .fast_embed_playback_base_urls
            .iter()
            .any(|base_url| base_url == &requested);
    if !allowed {
        return Err(AppError::bad_request(
            "playbackBaseUrl is not allowed for fast embed",
        ));
    }

    Ok(requested)
}

fn fast_embed_playback_credential_mode(state: &AppState, playback_base_url: &str) -> &'static str {
    if state.config.public_playback_enabled && playback_base_url == state.config.playback_base_url {
        "omit"
    } else {
        "include"
    }
}

fn fast_embed_playback_selection(
    response: &PlaybackBootstrapResponse,
    startup: &str,
) -> Option<FastEmbedPlaybackSelection> {
    if startup == "opener" {
        if let Some(url) = response.opener_url.as_ref() {
            return Some(FastEmbedPlaybackSelection {
                artifact_path: "opener.mp4".to_owned(),
                content_type: response
                    .opener_content_type
                    .clone()
                    .unwrap_or_else(|| "video/mp4".to_owned()),
                label: "opener",
                url: url.clone(),
            });
        }
    }

    if matches!(startup, "mse" | "progressive")
        && let Some(selection) = fast_embed_progressive_selection(response)
    {
        return Some(selection);
    }

    if response.playable_state == "hls_ready"
        && let Some(url) = response.manifest_url.as_ref()
    {
        return Some(FastEmbedPlaybackSelection {
            artifact_path: "hls/master.m3u8".to_owned(),
            content_type: response
                .manifest_content_type
                .clone()
                .unwrap_or_else(|| "application/vnd.apple.mpegurl".to_owned()),
            label: "native_hls",
            url: url.clone(),
        });
    }

    if let Some(url) = response.opener_url.as_ref() {
        return Some(FastEmbedPlaybackSelection {
            artifact_path: "opener.mp4".to_owned(),
            content_type: response
                .opener_content_type
                .clone()
                .unwrap_or_else(|| "video/mp4".to_owned()),
            label: "opener",
            url: url.clone(),
        });
    }

    response
        .playback_url
        .as_ref()
        .map(|url| FastEmbedPlaybackSelection {
            artifact_path: if response.playable_state == "hls_ready" {
                "hls/master.m3u8".to_owned()
            } else {
                "opener.mp4".to_owned()
            },
            content_type: response.playback_content_type.clone().unwrap_or_default(),
            label: "primary",
            url: url.clone(),
        })
}

fn fast_embed_progressive_selection(
    response: &PlaybackBootstrapResponse,
) -> Option<FastEmbedPlaybackSelection> {
    if response.playable_state != "hls_ready" {
        return None;
    }
    let manifest_url = response.manifest_url.as_ref()?;
    let rendition = fast_embed_progressive_rendition(&response.prefetch_hints)?;
    let mut parsed = reqwest::Url::parse(manifest_url).ok()?;
    let prefix = format!("/v/{}/", response.asset_id);
    if !parsed.path().starts_with(&prefix) {
        return None;
    }
    let artifact_path = format!("hls/{rendition}/progressive.mp4");
    parsed.set_path(&format!("{prefix}{artifact_path}"));
    parsed.set_query(None);
    parsed.set_fragment(None);

    Some(FastEmbedPlaybackSelection {
        artifact_path,
        content_type: "video/mp4".to_owned(),
        label: "progressive_mp4",
        url: parsed.to_string(),
    })
}

fn fast_embed_progressive_rendition(hints: &[PlaybackPrefetchHint]) -> Option<String> {
    let mut by_rendition = HashMap::<&str, (bool, bool)>::new();
    for hint in hints {
        let parts = hint.artifact_path.split('/').collect::<Vec<_>>();
        let ["hls", rendition, name] = parts.as_slice() else {
            continue;
        };
        let entry = by_rendition.entry(rendition).or_insert((false, false));
        entry.0 |= *name == format!("init_{rendition}.mp4");
        entry.1 |= *name == "segment_00000.m4s";
    }

    HLS_STARTUP_RENDITION_ORDER.iter().find_map(|rendition| {
        by_rendition
            .get(rendition)
            .copied()
            .filter(|(has_init, has_segment)| *has_init && *has_segment)
            .map(|_| (*rendition).to_owned())
    })
}

async fn fast_embed_inline_startup(
    state: &AppState,
    response: &PlaybackBootstrapResponse,
    selection: &FastEmbedPlaybackSelection,
    playback_base_url: &str,
) -> Result<Option<FastEmbedInlineStartup>, AppError> {
    let Some(rendition) = hls_progressive_rendition(&selection.artifact_path) else {
        return Ok(None);
    };

    let master_artifact = origin_playback_artifact(&response.asset_id, "hls/master.m3u8")?;
    let playlist_artifact = hls_progressive_playlist_artifact(&response.asset_id, rendition)?;
    let init_artifact = hls_progressive_init_artifact(&response.asset_id, rendition)?;

    let (master_part, playlist_part) = tokio::try_join!(
        origin_playback_artifact_full_bytes(state, &master_artifact),
        origin_playback_artifact_full_bytes(state, &playlist_artifact)
    )?;
    let (master_bytes, _, _) = master_part;
    let (playlist_bytes, _, _) = playlist_part;
    let master = std::str::from_utf8(&master_bytes)
        .map_err(|_| AppError::bad_gateway("invalid master playlist"))?;
    let playlist = std::str::from_utf8(&playlist_bytes)
        .map_err(|_| AppError::bad_gateway("invalid media playlist"))?;
    let segment_names = hls_progressive_segment_names(playlist);
    let Some(first_segment) = segment_names.first() else {
        return Ok(None);
    };

    let first_segment_artifact =
        hls_progressive_segment_artifact(&response.asset_id, rendition, first_segment)?;
    let (init_part, first_segment_part) = tokio::try_join!(
        origin_playback_artifact_full_bytes(state, &init_artifact),
        origin_playback_artifact_full_bytes(state, &first_segment_artifact)
    )?;
    let (init_bytes, _, _) = init_part;
    let (first_segment_bytes, _, _) = first_segment_part;

    let startup_len = init_bytes.len() + first_segment_bytes.len();
    if startup_len > FAST_EMBED_INLINE_STARTUP_MAX_BYTES {
        return Ok(None);
    }

    let mut startup = Vec::with_capacity(startup_len);
    startup.extend_from_slice(&init_bytes);
    startup.extend_from_slice(&first_segment_bytes);

    let mime_type = hls_master_codecs_for_rendition(master, rendition)
        .map(|codecs| format!("video/mp4; codecs=\"{codecs}\""))
        .unwrap_or_else(|| "video/mp4".to_owned());
    let segment_urls = segment_names
        .iter()
        .skip(1)
        .map(String::as_str)
        .collect::<Vec<_>>();
    let segment_urls = fast_embed_inline_segment_urls(
        playback_base_url,
        &response.asset_id,
        rendition,
        &segment_urls,
    );

    Ok(Some(FastEmbedInlineStartup {
        artifact_path: format!(
            "hls/{rendition}/init_{rendition}.mp4+hls/{rendition}/{first_segment}"
        ),
        mime_type,
        startup_b64: BASE64_STANDARD.encode(startup),
        segment_urls,
    }))
}

fn fast_embed_inline_segment_urls(
    playback_base_url: &str,
    asset_id: &str,
    rendition: &str,
    segment_names: &[&str],
) -> Vec<String> {
    segment_names
        .iter()
        .map(|segment| {
            artifact_url(
                playback_base_url,
                asset_id,
                &format!("hls/{rendition}/{segment}"),
            )
        })
        .collect()
}

fn hls_master_codecs_for_rendition(master: &str, rendition: &str) -> Option<String> {
    let rendition_path = format!("{rendition}/index.m3u8");
    let mut pending_codecs = None;
    for line in master.lines().map(str::trim) {
        if line.starts_with("#EXT-X-STREAM-INF:") {
            pending_codecs = hls_attribute_value(line, "CODECS");
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let matches_rendition =
            line == rendition_path || line.ends_with(&format!("/{rendition_path}"));
        if matches_rendition {
            return pending_codecs;
        }
        pending_codecs = None;
    }
    None
}

fn hls_attribute_value(line: &str, name: &str) -> Option<String> {
    let attributes = line.split_once(':')?.1;
    let prefix = format!("{name}=\"");
    let start = attributes.find(&prefix)? + prefix.len();
    let value = &attributes[start..];
    let end = value.find('"')?;
    Some(value[..end].to_owned())
}

fn html_escape(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn script_json(value: serde_json::Value) -> String {
    serde_json::to_string(&value)
        .unwrap_or_else(|_| "null".to_owned())
        .replace('<', "\\u003c")
}

fn inline_startup_script_json(inline_startup: Option<&FastEmbedInlineStartup>) -> String {
    match inline_startup {
        Some(inline) => script_json(serde_json::json!({
            "artifactPath": inline.artifact_path,
            "mimeType": inline.mime_type,
            "startup": inline.startup_b64,
            "segmentUrls": inline.segment_urls,
        })),
        None => "null".to_owned(),
    }
}

fn render_api_fast_embed_html(
    response: &PlaybackBootstrapResponse,
    selection: &FastEmbedPlaybackSelection,
    inline_startup: Option<&FastEmbedInlineStartup>,
    auto_play: bool,
    controls: bool,
    muted: bool,
    playback_credential_mode: &str,
) -> String {
    let auto_play_attr = if auto_play { " autoplay" } else { "" };
    let controls_attr = if controls { " controls" } else { "" };
    let muted_attr = if muted { " muted" } else { "" };
    let poster_attr = "";
    let selected_label = if inline_startup.is_some() {
        "mse_inline"
    } else {
        selection.label
    };
    let selected_artifact = inline_startup
        .map(|inline| inline.artifact_path.as_str())
        .unwrap_or(&selection.artifact_path);
    let playback_engine = if inline_startup.is_some() {
        "mse-inline"
    } else {
        "native"
    };
    let source_attrs = if inline_startup.is_some() {
        String::new()
    } else {
        format!(
            r#" src="{}" type="{}""#,
            html_escape(&selection.url),
            html_escape(&selection.content_type)
        )
    };
    let cross_origin = if playback_credential_mode == "omit" {
        "anonymous"
    } else {
        "use-credentials"
    };
    let fetch_credentials = if playback_credential_mode == "omit" {
        "omit"
    } else {
        "include"
    };
    let preload_link = if let Some(inline) = inline_startup {
        inline
            .segment_urls
            .first()
            .map(|url| {
                format!(
                    r#"<link rel="preload" as="fetch" href="{}" type="video/mp4" crossorigin="{}" fetchpriority="high">"#,
                    html_escape(url),
                    cross_origin
                )
            })
            .unwrap_or_default()
    } else if selection.content_type == "video/mp4" {
        format!(
            r#"<link rel="preload" as="video" href="{}" type="{}" crossorigin="{}" fetchpriority="high">"#,
            html_escape(&selection.url),
            html_escape(&selection.content_type),
            cross_origin
        )
    } else {
        String::new()
    };
    let inline_startup_json = inline_startup_script_json(inline_startup);
    let fallback_json = script_json(serde_json::json!({
        "artifactPath": selection.artifact_path,
        "contentType": selection.content_type,
        "label": selection.label,
        "url": selection.url,
    }));

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Rend player</title>
{preload_link}
<style>
html,body{{margin:0;width:100%;height:100%;background:#050505;color:#f7f7f7}}
body{{overflow:hidden}}
.rend-fast{{position:fixed;inset:0;display:grid;place-items:center;background:#050505;font-family:Inter,ui-sans-serif,system-ui,sans-serif}}
.rend-fast__video{{width:100%;height:100%;display:block;object-fit:contain;background:#000}}
.rend-fast__message{{position:absolute;left:16px;bottom:14px;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.64);font-size:13px;line-height:1.2;color:#fff}}
.rend-fast[data-rend-player-state="ready"] .rend-fast__message,.rend-fast[data-rend-player-state="playing"] .rend-fast__message{{display:none}}
</style>
</head>
<body>
<main class="rend-fast" aria-label="Video player" data-rend-player-state="ready" data-rend-player-selected="{label}" data-rend-player-artifact="{artifact_path}" data-rend-ready-status="ready" data-rend-source-state="{source_state}" data-rend-playable-state="{playable_state}" data-rend-playback-engine="{playback_engine}" data-rend-document-start-ms="0" data-rend-bootstrap-ms="0" data-rend-asset-id="{asset_id}">
<video class="rend-fast__video"{source_attrs}{poster_attr}{auto_play_attr}{controls_attr}{muted_attr} playsinline preload="auto" crossorigin="{cross_origin}"></video>
<div class="rend-fast__message" role="status" aria-live="polite">Ready</div>
</main>
<script>
(()=>{{const root=document.querySelector("[data-rend-player-state]");const video=document.querySelector("video");if(!root||!video)return;const inlineStartup={inline_startup_json};const fallback={fallback_json};const autoPlay={auto_play_js};const fetchCredentials="{fetch_credentials}";const mark=(name)=>{{if(!root.getAttribute(name))root.setAttribute(name,String(Math.round(performance.now())))}};const dims=()=>{{if(video.videoWidth)root.setAttribute("data-rend-selected-width",String(video.videoWidth));if(video.videoHeight)root.setAttribute("data-rend-selected-height",String(video.videoHeight))}};const play=()=>{{if(autoPlay)video.play().catch(()=>{{}})}};const selection=(label,artifactPath,engine)=>{{root.setAttribute("data-rend-player-selected",label);root.setAttribute("data-rend-player-artifact",artifactPath);root.setAttribute("data-rend-playback-engine",engine);root.setAttribute("data-rend-player-state","ready")}};const bytes=(value)=>{{const binary=atob(value);const output=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)output[i]=binary.charCodeAt(i);return output}};const append=(buffer,data)=>new Promise((resolve,reject)=>{{const done=()=>{{cleanup();resolve()}};const fail=()=>{{cleanup();reject(new Error("append failed"))}};const cleanup=()=>{{buffer.removeEventListener("updateend",done);buffer.removeEventListener("error",fail)}};buffer.addEventListener("updateend",done);buffer.addEventListener("error",fail);buffer.appendBuffer(data)}});const sourceOpen=(mediaSource)=>new Promise((resolve,reject)=>{{if(mediaSource.readyState==="open"){{resolve();return}}const done=()=>{{cleanup();resolve()}};const fail=()=>{{cleanup();reject(new Error("source open failed"))}};const cleanup=()=>{{mediaSource.removeEventListener("sourceopen",done);mediaSource.removeEventListener("sourceclose",fail);mediaSource.removeEventListener("sourceended",fail)}};mediaSource.addEventListener("sourceopen",done,{{once:true}});mediaSource.addEventListener("sourceclose",fail,{{once:true}});mediaSource.addEventListener("sourceended",fail,{{once:true}})}});const fetchSegment=(url)=>fetch(url,{{credentials:fetchCredentials}}).then(response=>{{if(!response.ok)throw new Error("segment fetch failed");return response.arrayBuffer()}}).then(buffer=>new Uint8Array(buffer));const bufferedAhead=()=>{{try{{for(let index=0;index<video.buffered.length;index++){{const start=video.buffered.start(index);const end=video.buffered.end(index);if(start<=video.currentTime&&end>video.currentTime)return end-video.currentTime}}}}catch{{}}return 0}};const waitForBufferRoom=()=>new Promise(resolve=>{{if(bufferedAhead()<8){{resolve();return}}const cleanup=()=>{{video.removeEventListener("timeupdate",tick);video.removeEventListener("playing",tick);clearTimeout(timeout)}};const tick=()=>{{if(bufferedAhead()<5){{cleanup();resolve()}}}};const timeout=setTimeout(()=>{{cleanup();resolve()}},1000);video.addEventListener("timeupdate",tick);video.addEventListener("playing",tick)}});const startNative=()=>{{selection(fallback.label,fallback.artifactPath,"native");if(fallback.url&&video.getAttribute("src")!==fallback.url){{video.src=fallback.url;video.load()}}play()}};const startInline=async()=>{{if(!inlineStartup||!("MediaSource"in window)||!MediaSource.isTypeSupported(inlineStartup.mimeType))return false;selection("mse_inline",inlineStartup.artifactPath,"mse-inline");const mediaSource=new MediaSource();const objectUrl=URL.createObjectURL(mediaSource);video.removeAttribute("src");video.src=objectUrl;video.load();await sourceOpen(mediaSource);const sourceBuffer=mediaSource.addSourceBuffer(inlineStartup.mimeType);await append(sourceBuffer,bytes(inlineStartup.startup));play();(async()=>{{for(const url of inlineStartup.segmentUrls){{await waitForBufferRoom();await append(sourceBuffer,await fetchSegment(url))}}if(mediaSource.readyState==="open")mediaSource.endOfStream()}})().catch(()=>{{}});return true}};video.addEventListener("loadedmetadata",()=>{{dims();mark("data-rend-metadata-ms")}},{{once:true}});video.addEventListener("canplay",()=>{{dims();mark("data-rend-canplay-ms")}},{{once:true}});video.addEventListener("playing",()=>{{root.setAttribute("data-rend-player-state","playing");dims()}});if("requestVideoFrameCallback"in video){{video.requestVideoFrameCallback(()=>{{dims();mark("data-rend-first-frame-ms")}})}}else{{video.addEventListener("playing",()=>mark("data-rend-first-frame-ms"),{{once:true}})}}startInline().then((started)=>{{if(!started)startNative()}}).catch(()=>startNative())}})();
</script>
</body>
</html>"#,
        asset_id = html_escape(&response.asset_id),
        artifact_path = html_escape(selected_artifact),
        auto_play_js = if auto_play { "true" } else { "false" },
        cross_origin = cross_origin,
        fallback_json = fallback_json,
        fetch_credentials = fetch_credentials,
        inline_startup_json = inline_startup_json,
        label = html_escape(selected_label),
        playable_state = html_escape(&response.playable_state),
        playback_engine = html_escape(playback_engine),
        source_attrs = source_attrs,
        source_state = html_escape(&response.source_state),
    )
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
        "segment" => is_hls_media_artifact_path(artifact_path),
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

            if let Some(init_segment) = hls_startup_init_for_tier(artifacts, tier) {
                if push_prefetch_hint(&mut hints, limit, init_segment) {
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

fn hls_startup_init_for_tier<'a>(
    artifacts: &'a [PlaybackArtifact],
    tier: &str,
) -> Option<&'a PlaybackArtifact> {
    let init_path = format!("hls/{tier}/init_{tier}.mp4");
    artifacts
        .iter()
        .find(|artifact| artifact.artifact_path == init_path)
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
    if is_hls_init_artifact_path(path) {
        return (
            2,
            hls_rendition_rank(hls_rendition_name(path).unwrap_or_default()),
            0,
        );
    }
    if is_hls_segment_artifact_path(path) {
        return (
            3,
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
    path.starts_with("hls/")
        && (path.ends_with(".ts") || path.ends_with(".m4s"))
        && is_asset_playback_path(path)
}

fn is_hls_init_artifact_path(path: &str) -> bool {
    path.starts_with("hls/") && path.ends_with(".mp4") && is_asset_playback_path(path)
}

fn is_hls_media_artifact_path(path: &str) -> bool {
    is_hls_segment_artifact_path(path) || is_hls_init_artifact_path(path)
}

fn hls_segment_index(path: &str) -> Option<u32> {
    let name = path.split('/').next_back()?.strip_prefix("segment_")?;
    name.strip_suffix(".ts")
        .or_else(|| name.strip_suffix(".m4s"))?
        .parse::<u32>()
        .ok()
}

fn issue_playback_token(
    issuer: &PlaybackTokenIssuer,
    asset_id: &str,
    organization_id: Option<&str>,
    now: u64,
) -> Result<IssuedPlaybackToken, PlaybackAuthError> {
    let ttl_seconds = issuer.ttl().as_secs();
    let expires_at = now
        .checked_add(ttl_seconds)
        .ok_or(PlaybackAuthError::InvalidTtl)?;
    let token =
        issuer.issue_asset_playback_token_with_organization(asset_id, organization_id, now)?;

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
    let is_secure = playback_base_url.starts_with("https://");
    let mut parts = vec![
        format!("{PLAYBACK_COOKIE_NAME}={token}"),
        "Path=/v/".to_owned(),
        format!("Max-Age={ttl_seconds}"),
        "HttpOnly".to_owned(),
        if is_secure {
            "SameSite=None".to_owned()
        } else {
            "SameSite=Lax".to_owned()
        },
    ];
    if let Some(domain) = cookie_domain {
        parts.push(format!("Domain={domain}"));
    }
    if is_secure {
        parts.push("Secure".to_owned());
    }
    parts.join("; ")
}

fn playback_cookie_headers(
    token: &str,
    ttl_seconds: u64,
    expires_at: u64,
    playback_base_url: &str,
    asset_id: &str,
    cookie_domain: Option<&str>,
    cloudfront_signer: Option<&CloudFrontCookieSigner>,
) -> Vec<String> {
    let mut cookies = vec![playback_cookie_header(
        token,
        ttl_seconds,
        playback_base_url,
        cookie_domain,
    )];
    let Some(signer) = cloudfront_signer else {
        return cookies;
    };
    let resource = format!("{}/v/{asset_id}/*", playback_base_url.trim_end_matches('/'));
    let policy = serde_json::json!({
        "Statement": [{
            "Resource": resource,
            "Condition": {"DateLessThan": {"AWS:EpochTime": expires_at}}
        }]
    })
    .to_string();
    let signature = RsaSigningKey::<Sha1>::new(signer.private_key.clone()).sign(policy.as_bytes());
    cookies.push(playback_authorization_cookie(
        "CloudFront-Policy",
        &cloudfront_cookie_value(policy.as_bytes()),
        ttl_seconds,
        playback_base_url,
        cookie_domain,
    ));
    cookies.push(playback_authorization_cookie(
        "CloudFront-Signature",
        &cloudfront_cookie_value(&signature.to_bytes()),
        ttl_seconds,
        playback_base_url,
        cookie_domain,
    ));
    cookies.push(playback_authorization_cookie(
        "CloudFront-Key-Pair-Id",
        &signer.key_pair_id,
        ttl_seconds,
        playback_base_url,
        cookie_domain,
    ));
    cookies
}

fn playback_authorization_cookie(
    name: &str,
    value: &str,
    ttl_seconds: u64,
    playback_base_url: &str,
    cookie_domain: Option<&str>,
) -> String {
    let secure = playback_base_url.starts_with("https://");
    let mut parts = vec![
        format!("{name}={value}"),
        "Path=/v/".to_owned(),
        format!("Max-Age={ttl_seconds}"),
        "HttpOnly".to_owned(),
        if secure {
            "SameSite=None".to_owned()
        } else {
            "SameSite=Lax".to_owned()
        },
    ];
    if let Some(domain) = cookie_domain {
        parts.push(format!("Domain={domain}"));
    }
    if secure {
        parts.push("Secure".to_owned());
    }
    parts.join("; ")
}

fn cloudfront_cookie_value(value: &[u8]) -> String {
    BASE64_STANDARD
        .encode(value)
        .replace('+', "-")
        .replace('=', "_")
        .replace('/', "~")
}

fn cloudfront_cookie_signer_from_env() -> Result<Option<CloudFrontCookieSigner>> {
    let key_pair_id = env_string("REND_CLOUDFRONT_KEY_PAIR_ID", "");
    let private_key_pem = env_string("REND_CLOUDFRONT_PRIVATE_KEY", "");
    if key_pair_id.trim().is_empty() && private_key_pem.trim().is_empty() {
        return Ok(None);
    }
    anyhow::ensure!(
        !key_pair_id.trim().is_empty() && !private_key_pem.trim().is_empty(),
        "REND_CLOUDFRONT_KEY_PAIR_ID and REND_CLOUDFRONT_PRIVATE_KEY must be configured together"
    );
    let private_key_pem = if private_key_pem.contains("\\n") && !private_key_pem.contains('\n') {
        private_key_pem.replace("\\n", "\n")
    } else {
        private_key_pem
    };
    let private_key = RsaPrivateKey::from_pkcs8_pem(&private_key_pem)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(&private_key_pem))
        .context("REND_CLOUDFRONT_PRIVATE_KEY must be a PKCS#8 or PKCS#1 PEM RSA private key")?;
    Ok(Some(CloudFrontCookieSigner {
        key_pair_id: key_pair_id.trim().to_owned(),
        private_key,
    }))
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
    let legacy_reserved_bytes = content_length.unwrap_or(
        i64::try_from(state.config.max_upload_bytes)
            .map_err(|_| AppError::internal("legacy upload limit is too large"))?,
    );
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
        uploads::reserve_legacy_source(
            &mut tx,
            &auth.organization_id,
            &asset_id,
            legacy_reserved_bytes,
            &state.config.upload_limits,
        )
        .await
        .map_err(upload_app_error)?;
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
        .source_s3
        .put_object()
        .bucket(&state.config.source_bucket)
        .key(&source_object_key)
        .content_type(content_type.clone())
        .body(upload_body);

    if let Some(content_length) = content_length {
        put_object = put_object.content_length(content_length);
    }

    if let Err(error) = put_object.send().await {
        if let Err(release_error) = uploads::release_legacy_source(
            &state.db,
            &auth.organization_id,
            &asset_id,
            legacy_reserved_bytes,
        )
        .await
        {
            tracing::error!(asset_id, error = %release_error, "failed to release legacy source reservation");
        }
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
            INSERT INTO rend.artifacts (
              asset_id, kind, object_key, storage_object_key, content_type, byte_size
            )
            VALUES ($1::uuid, 'source', $2, $2, $3, $4)
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

        uploads::finalize_legacy_source(
            &mut tx,
            &auth.organization_id,
            &asset_id,
            legacy_reserved_bytes,
            byte_size,
        )
        .await
        .map_err(upload_app_error)?;

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
            if let Err(delete_error) = state
                .source_s3
                .delete_object()
                .bucket(&state.config.source_bucket)
                .key(&source_object_key)
                .send()
                .await
            {
                tracing::warn!(asset_id, error = %delete_error, "failed to delete uncommitted legacy source object");
            }
            if let Err(release_error) = uploads::release_legacy_source(
                &state.db,
                &auth.organization_id,
                &asset_id,
                legacy_reserved_bytes,
            )
            .await
            {
                tracing::error!(asset_id, error = %release_error, "failed to release uncommitted legacy source reservation");
            }
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
        source_bucket: state.config.source_bucket.clone(),
        source_s3: state.source_s3.clone(),
        s3_bucket: state.config.s3_bucket.clone(),
        s3: state.s3.clone(),
        db: state.db.clone(),
        config: state.config.media_processing.clone(),
        public_playback_alias: state.config.public_playback_alias.clone(),
        fence: None,
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

async fn process_next_media_job(
    state: Arc<AppState>,
    shutdown: watch::Receiver<bool>,
) -> Result<bool> {
    set_ecs_task_scale_in_protection(&state, true)
        .await
        .context("failed to acquire ECS task scale-in protection")?;
    if *shutdown.borrow() {
        set_ecs_task_scale_in_protection(&state, false)
            .await
            .context("failed to release ECS task scale-in protection")?;
        return Ok(false);
    }
    let claimed = jobs::claim_next_media_job(
        &state.db,
        &state.config.media_worker.worker_id,
        state.config.media_worker.lease_duration,
        state.config.media_worker.max_active_jobs_per_organization,
    )
    .await;
    let job = match claimed {
        Ok(Some(job)) => job,
        Ok(None) => {
            set_ecs_task_scale_in_protection(&state, false)
                .await
                .context("failed to release ECS task scale-in protection")?;
            return Ok(false);
        }
        Err(error) => {
            if let Err(release_error) = set_ecs_task_scale_in_protection(&state, false).await {
                tracing::error!(error = %release_error, "failed to release ECS task scale-in protection after claim error");
            }
            return Err(error).context("failed to claim media job");
        }
    };

    process_media_job(&state, job, shutdown).await;
    if let Err(error) = set_ecs_task_scale_in_protection(&state, false).await {
        tracing::error!(error = %error, "failed to release ECS task scale-in protection");
    }
    Ok(true)
}

async fn set_ecs_task_scale_in_protection(state: &AppState, enabled: bool) -> Result<()> {
    let Ok(agent_uri) = std::env::var("ECS_AGENT_URI") else {
        return Ok(());
    };
    let agent_uri = agent_uri.trim().trim_end_matches('/');
    if agent_uri.is_empty() {
        return Ok(());
    }
    let mut body = serde_json::json!({ "ProtectionEnabled": enabled });
    if enabled {
        body["ExpiresInMinutes"] = serde_json::json!(1500);
    }
    state
        .http
        .put(format!("{agent_uri}/task-protection/v1/state"))
        .json(&body)
        .send()
        .await
        .context("failed to call the ECS task protection endpoint")?
        .error_for_status()
        .context("ECS task protection endpoint rejected the update")?;
    Ok(())
}

#[derive(Clone, Copy)]
enum MediaCancellation {
    LeaseLost,
    Shutdown,
}

async fn process_media_job(
    state: &AppState,
    job: jobs::MediaJob,
    mut shutdown: watch::Receiver<bool>,
) {
    tracing::info!(
        job_id = %job.id,
        asset_id = %job.asset_id,
        attempt = job.attempts,
        max_attempts = job.max_attempts,
        worker_id = %state.config.media_worker.worker_id,
        "media worker claimed job",
    );

    let started = Instant::now();
    let mut heartbeat = tokio::time::interval(state.config.media_worker.heartbeat_interval);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut processing = Box::pin(process_media_job_inner(state, &job));
    let mut shutdown_deadline: Option<Pin<Box<tokio::time::Sleep>>> = None;
    let processing_result = loop {
        tokio::select! {
            result = &mut processing => break Some(result),
            changed = shutdown.changed(), if shutdown_deadline.is_none() => {
                if changed.is_err() || *shutdown.borrow() {
                    tracing::info!(
                        job_id = %job.id,
                        grace_seconds = state.config.media_worker.shutdown_grace.as_secs(),
                        "media worker draining active job after shutdown signal",
                    );
                    shutdown_deadline = Some(Box::pin(tokio::time::sleep(
                        state.config.media_worker.shutdown_grace,
                    )));
                }
            }
            _ = async {
                match shutdown_deadline.as_mut() {
                    Some(deadline) => deadline.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                tracing::warn!(job_id = %job.id, "media worker shutdown grace expired; terminating processing");
                break None;
            }
            _ = heartbeat.tick() => {
                match jobs::heartbeat_media_job(
                    &state.db,
                    &job,
                    state.config.media_worker.lease_duration,
                ).await {
                    Ok(true) => {}
                    Ok(false) => {
                        tracing::warn!(
                            job_id = %job.id,
                            asset_id = %job.asset_id,
                            lease_token = %job.lease_token,
                            "media worker lost its lease; cancelling local processing",
                        );
                        break None;
                    }
                    Err(error) => {
                        tracing::error!(
                            job_id = %job.id,
                            asset_id = %job.asset_id,
                            error = %error,
                            "media worker heartbeat failed; cancelling local processing",
                        );
                        break None;
                    }
                }
            }
        }
    };
    let Some(processing_result) = processing_result else {
        drop(processing);
        let cancellation = if *shutdown.borrow() {
            MediaCancellation::Shutdown
        } else {
            MediaCancellation::LeaseLost
        };
        cleanup_cancelled_media_attempt(state, &job, cancellation).await;
        return;
    };
    let output_bytes = match &processing_result {
        Ok(MediaJobDisposition::Completed(output_bytes)) => *output_bytes,
        _ => 0,
    };
    let actual_microusd = i64::try_from(started.elapsed().as_secs().max(1))
        .unwrap_or(i64::MAX)
        .saturating_mul(state.config.compute_budget.task_microusd_per_second)
        .saturating_add(budget::output_transfer_microusd(
            &state.config.compute_budget,
            output_bytes,
        ));
    if !matches!(processing_result, Ok(MediaJobDisposition::Deferred)) {
        match budget::reconcile_compute(&state.db, &job, actual_microusd).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!(job_id = %job.id, "media compute settlement lost its lease; terminalization skipped");
                return;
            }
            Err(error) => {
                tracing::error!(job_id = %job.id, error = %error, "failed to reconcile media compute reservation; terminalization skipped");
                return;
            }
        }
    }

    match processing_result {
        Ok(MediaJobDisposition::Completed(output_bytes)) => {
            match jobs::mark_media_job_succeeded(&state.db, &job, actual_microusd, output_bytes)
                .await
            {
                Ok(true) => {}
                Ok(false) => tracing::warn!(
                    job_id = %job.id,
                    lease_token = %job.lease_token,
                    "stale media worker could not publish successful terminal state",
                ),
                Err(error) => tracing::error!(
                    job_id = %job.id,
                    asset_id = %job.asset_id,
                    error = %error,
                    "failed to mark media job succeeded",
                ),
            }
        }
        Ok(MediaJobDisposition::Deferred) => {}
        Ok(MediaJobDisposition::DeferredUnavailable) => {
            match jobs::defer_media_job_for_budget(
                &state.db,
                &job,
                Duration::from_secs(60),
                "asset or organization became unavailable during processing",
            )
            .await
            {
                Ok(true) => {}
                Ok(false) => tracing::info!(
                    job_id = %job.id,
                    "unavailable media job was already cancelled or fenced"
                ),
                Err(error) => tracing::error!(
                    job_id = %job.id,
                    error = %error,
                    "failed to defer unavailable media job"
                ),
            }
        }
        Ok(MediaJobDisposition::Rejected(reason)) => {
            if let Err(error) = finalize_failed_media_attempt(&state.db, &job, &reason, true).await
            {
                tracing::error!(job_id = %job.id, error = %error, "failed to record over-budget media job rejection");
            }
        }
        Err(error) => {
            handle_media_job_failure(state, &job, error).await;
        }
    }
}

async fn cleanup_cancelled_media_attempt(
    state: &AppState,
    job: &jobs::MediaJob,
    cancellation: MediaCancellation,
) {
    let reason = match cancellation {
        MediaCancellation::LeaseLost => "media worker lost its lease",
        MediaCancellation::Shutdown => "media worker shutdown grace expired",
    };
    if let Err(error) = media::cleanup_attempt_prefix(
        &state.db,
        &state.s3,
        &state.config.s3_bucket,
        &job.asset_id,
        &job.lease_token,
    )
    .await
    {
        tracing::warn!(job_id = %job.id, error = %error, "failed to clean cancelled media attempt objects");
    }
    if let Err(error) = uploads::release_media_output_reservation(
        &state.db,
        job,
        "media_output_released_worker_cancellation",
    )
    .await
    {
        tracing::warn!(job_id = %job.id, error = %error, "failed to release cancelled media output reservation");
        return;
    }
    match budget::reconcile_compute(&state.db, job, 0).await {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            tracing::warn!(job_id = %job.id, error = %error, "failed to release cancelled media compute reservation");
            return;
        }
    }
    match jobs::mark_media_job_retryable(&state.db, job, reason, Duration::ZERO).await {
        Ok(true) => {}
        Ok(false) => tracing::info!(job_id = %job.id, "cancelled media lease was already fenced"),
        Err(error) => {
            tracing::warn!(job_id = %job.id, error = %error, "failed to release cancelled media lease")
        }
    }
}

async fn process_media_job_inner(
    state: &AppState,
    job: &jobs::MediaJob,
) -> Result<MediaJobDisposition> {
    if asset_is_unavailable_for_media_processing(&state.db, &job.asset_id).await? {
        tracing::info!(
            job_id = %job.id,
            asset_id = %job.asset_id,
            "media job asset is deleted, suspended, or missing",
        );
        return Ok(MediaJobDisposition::DeferredUnavailable);
    }

    if asset_is_already_playable(&state.db, &job.asset_id).await? {
        tracing::info!(
            job_id = %job.id,
            asset_id = %job.asset_id,
            "media job asset is already playable",
        );
        return Ok(MediaJobDisposition::Completed(0));
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
        return Ok(MediaJobDisposition::DeferredUnavailable);
    }

    let (source_object_key, source_bytes) =
        fetch_source_artifact(&state.db, &job.asset_id)
            .await
            .context("failed to fetch source artifact for media job")?;
    let mut media_request = media::ProcessMediaRequest {
        asset_id: job.asset_id.clone(),
        source_object_key,
        source_bucket: state.config.source_bucket.clone(),
        source_s3: state.source_s3.clone(),
        s3_bucket: state.config.s3_bucket.clone(),
        s3: state.s3.clone(),
        db: state.db.clone(),
        config: state.config.media_processing.clone(),
        public_playback_alias: state.config.public_playback_alias.clone(),
        fence: Some(media::MediaJobFence {
            job_id: job.id.clone(),
            lease_token: job.lease_token.clone(),
            worker_id: job.worker_id.clone(),
        }),
    };
    let source = media::probe_uploaded_source(&media_request)
        .await
        .context("failed to probe streamed source before compute admission")?;
    let estimated_output_bytes = uploads::estimate_processed_bytes(
        source.duration_ms,
        source.width,
        source.height,
        source_bytes,
    );
    if !uploads::reserve_media_output(&state.db, job, estimated_output_bytes).await? {
        jobs::defer_media_job_for_budget(
            &state.db,
            job,
            Duration::from_secs(60 * 60),
            "processed artifact storage budget is unavailable",
        )
        .await?;
        return Ok(MediaJobDisposition::Deferred);
    }
    let estimate = budget::estimate_compute(
        &state.config.compute_budget,
        source.duration_ms,
        source.width,
        source.height,
        estimated_output_bytes,
    );
    let estimate =
        match budget::reserve_compute(&state.db, job, &state.config.compute_budget, estimate)
            .await?
        {
            budget::Admission::Reserved(estimate) => estimate,
            budget::Admission::DeferredBudget => {
                uploads::release_media_output_reservation(
                    &state.db,
                    job,
                    "media_output_released_compute_budget",
                )
                .await?;
                jobs::defer_media_job_for_budget(
                    &state.db,
                    job,
                    Duration::from_secs(60 * 60),
                    "monthly media processing budget is fully reserved",
                )
                .await?;
                return Ok(MediaJobDisposition::Deferred);
            }
            budget::Admission::ExceedsJobCeiling => {
                uploads::release_media_output_reservation(
                    &state.db,
                    job,
                    "media_output_released_job_ceiling",
                )
                .await?;
                return Ok(MediaJobDisposition::Rejected(
                    "estimated processing cost exceeds the configured per-job ceiling".to_owned(),
                ));
            }
            budget::Admission::LeaseLost => return Ok(MediaJobDisposition::Deferred),
        };
    media_request.config.process_timeout = estimate.task_deadline;
    let outcome = tokio::time::timeout(
        estimate.task_deadline,
        media::try_process_uploaded_source(&media_request),
    )
    .await
    .map_err(|_| anyhow::anyhow!("media processing exceeded its reserved compute deadline"))??;

    if outcome.unavailable {
        media::cleanup_attempt_prefix(
            &state.db,
            &state.s3,
            &state.config.s3_bucket,
            &job.asset_id,
            &job.lease_token,
        )
        .await
        .context("failed to clean unavailable media attempt objects")?;
        uploads::release_media_output_reservation(
            &state.db,
            job,
            "media_output_released_asset_unavailable",
        )
        .await?;
        return Ok(MediaJobDisposition::DeferredUnavailable);
    }

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

    Ok(MediaJobDisposition::Completed(outcome.output_bytes))
}

async fn handle_media_job_failure(state: &AppState, job: &jobs::MediaJob, error: anyhow::Error) {
    let last_error = bounded_error_message(&error);
    tracing::warn!(
        job_id = %job.id,
        asset_id = %job.asset_id,
        attempt = job.attempts,
        max_attempts = job.max_attempts,
        error = %last_error,
        "media job processing failed",
    );
    if let Err(cleanup_error) = media::cleanup_attempt_prefix(
        &state.db,
        &state.s3,
        &state.config.s3_bucket,
        &job.asset_id,
        &job.lease_token,
    )
    .await
    {
        tracing::warn!(
            job_id = %job.id,
            error = %cleanup_error,
            "failed to clean failed media attempt objects",
        );
    }
    if let Err(release_error) = uploads::release_media_output_reservation(
        &state.db,
        job,
        "media_output_released_processing_failure",
    )
    .await
    {
        tracing::error!(
            job_id = %job.id,
            error = %release_error,
            "failed to release media output storage reservation",
        );
        return;
    }
    let final_attempt = jobs::is_final_attempt(job.attempts, job.max_attempts);
    if let Err(error) =
        finalize_failed_media_attempt(&state.db, job, &last_error, final_attempt).await
    {
        tracing::error!(
            job_id = %job.id,
            asset_id = %job.asset_id,
            error = %error,
            "failed to fence and finalize media job failure",
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

    Ok(playable_state.as_deref() == Some("hls_ready"))
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

async fn fetch_source_artifact(db: &PgPool, asset_id: &str) -> Result<(String, i64)> {
    let artifact: Option<(String, i64)> = sqlx::query_as(
        "
        SELECT storage_object_key, byte_size
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

    artifact.ok_or_else(|| anyhow::anyhow!("source artifact is missing"))
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
        FOR UPDATE OF asset
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

async fn finalize_failed_media_attempt(
    db: &PgPool,
    job: &jobs::MediaJob,
    reason: &str,
    terminal: bool,
) -> Result<bool> {
    let mut tx = db.begin().await?;
    let asset: Option<(String, bool, bool, bool)> = sqlx::query_as(
        "
        SELECT asset.playable_state,
               asset.deleted_at IS NOT NULL,
               asset.suspended_at IS NOT NULL,
               org.suspended_at IS NOT NULL
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
        FOR UPDATE OF asset
        ",
    )
    .bind(&job.asset_id)
    .fetch_optional(&mut *tx)
    .await?;
    let active: Option<String> = sqlx::query_scalar(
        "
        SELECT id::text
        FROM rend.media_jobs
        WHERE id = $1::uuid AND lease_token = $2::uuid AND locked_by = $3
          AND status = 'running' AND lease_expires_at > now()
        FOR UPDATE
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .fetch_optional(&mut *tx)
    .await?;
    if active.is_none() {
        tx.commit().await?;
        return Ok(false);
    }

    if let Some((playable_state, deleted, asset_suspended, org_suspended)) = asset
        && !deleted
        && !asset_suspended
        && !org_suspended
    {
        events::insert_asset_event(
            &mut tx,
            &job.asset_id,
            events::EVENT_MEDIA_PROCESSING_FAILED,
            events::media_processing_failed_metadata(
                job.attempts,
                job.max_attempts,
                terminal,
                reason,
            ),
        )
        .await?;
        if terminal {
            if matches!(playable_state.as_str(), "opener_ready" | "hls_ready") {
                sqlx::query("UPDATE rend.assets SET source_state = 'uploaded' WHERE id = $1::uuid")
                    .bind(&job.asset_id)
                    .execute(&mut *tx)
                    .await?;
            } else {
                sqlx::query(
                    "
                    UPDATE rend.assets
                    SET source_state = 'uploaded', playable_state = 'failed',
                        current_opener_artifact_id = NULL
                    WHERE id = $1::uuid
                    ",
                )
                .bind(&job.asset_id)
                .execute(&mut *tx)
                .await?;
                if playable_state != "failed" {
                    events::insert_asset_event(
                        &mut tx,
                        &job.asset_id,
                        events::EVENT_PLAYABLE_STATE_CHANGED,
                        events::playable_state_changed_metadata(&playable_state, "failed"),
                    )
                    .await?;
                }
            }
        } else {
            sqlx::query("UPDATE rend.assets SET source_state = 'uploaded' WHERE id = $1::uuid")
                .bind(&job.asset_id)
                .execute(&mut *tx)
                .await?;
        }
    }

    let delay_seconds =
        i64::try_from(jobs::retry_backoff(job.attempts).as_secs()).unwrap_or(i64::MAX);
    let job_status = if terminal {
        jobs::STATUS_FAILED
    } else {
        jobs::STATUS_QUEUED
    };
    let attempt_status = if terminal { "failed" } else { "retryable" };
    let updated = sqlx::query(
        "
        UPDATE rend.media_jobs
        SET status = $4, last_error = $5,
            locked_at = NULL, locked_by = NULL, lease_token = NULL,
            lease_expires_at = NULL, heartbeat_at = NULL,
            completed_at = CASE WHEN $6 THEN now() ELSE NULL END,
            run_after = CASE WHEN $6 THEN now() ELSE now() + ($7::bigint * interval '1 second') END
        WHERE id = $1::uuid AND lease_token = $2::uuid AND locked_by = $3
          AND status = 'running'
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .bind(job_status)
    .bind(reason)
    .bind(terminal)
    .bind(delay_seconds)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query(
        "
        UPDATE rend.media_job_attempts
        SET status = $3, finished_at = now(), error = $4
        WHERE job_id = $1::uuid AND lease_token = $2::uuid AND status = 'running'
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(attempt_status)
    .bind(reason)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
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

fn origin_playback_artifact(
    asset_id: &str,
    artifact_path: &str,
) -> Result<OriginPlaybackArtifact, AppError> {
    let asset_id = normalize_asset_id(asset_id)?;
    let content_type = match artifact_path.split('/').collect::<Vec<_>>().as_slice() {
        ["opener.mp4"] => "video/mp4",
        ["hls", "master.m3u8"] => "application/vnd.apple.mpegurl",
        ["hls", segment] if rend_playback_auth::is_valid_hls_segment_name(segment) => {
            hls_segment_content_type(segment)
        }
        ["hls", init] if rend_playback_auth::is_valid_hls_init_segment_name(init) => "video/mp4",
        ["hls", rendition, "index.m3u8"]
            if rend_playback_auth::is_valid_hls_rendition_name(rendition) =>
        {
            "application/vnd.apple.mpegurl"
        }
        ["hls", rendition, "progressive.mp4"]
            if rend_playback_auth::is_valid_hls_rendition_name(rendition) =>
        {
            "video/mp4"
        }
        ["hls", rendition, init]
            if rend_playback_auth::is_valid_hls_rendition_name(rendition)
                && rend_playback_auth::is_valid_hls_init_segment_name(init) =>
        {
            "video/mp4"
        }
        ["hls", rendition, segment]
            if rend_playback_auth::is_valid_hls_rendition_name(rendition)
                && rend_playback_auth::is_valid_hls_segment_name(segment) =>
        {
            hls_segment_content_type(segment)
        }
        _ => return Err(AppError::not_found("artifact not found")),
    };

    Ok(OriginPlaybackArtifact {
        asset_id: asset_id.clone(),
        artifact_path: artifact_path.to_owned(),
        object_key: format!("videos/{asset_id}/{artifact_path}"),
        content_type,
    })
}

fn hls_segment_content_type(segment: &str) -> &'static str {
    if segment.ends_with(".m4s") {
        "video/mp4"
    } else {
        "video/mp2t"
    }
}

fn hls_progressive_rendition(path: &str) -> Option<&str> {
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["hls", rendition, "progressive.mp4"]
            if rend_playback_auth::is_valid_hls_rendition_name(rendition) =>
        {
            Some(rendition)
        }
        _ => None,
    }
}

fn hls_progressive_init_artifact(
    asset_id: &str,
    rendition: &str,
) -> Result<OriginPlaybackArtifact, AppError> {
    origin_playback_artifact(asset_id, &format!("hls/{rendition}/init_{rendition}.mp4"))
}

fn hls_progressive_playlist_artifact(
    asset_id: &str,
    rendition: &str,
) -> Result<OriginPlaybackArtifact, AppError> {
    origin_playback_artifact(asset_id, &format!("hls/{rendition}/index.m3u8"))
}

fn hls_progressive_segment_artifact(
    asset_id: &str,
    rendition: &str,
    segment: &str,
) -> Result<OriginPlaybackArtifact, AppError> {
    origin_playback_artifact(asset_id, &format!("hls/{rendition}/{segment}"))
}

fn hls_progressive_segment_names(playlist: &str) -> Vec<String> {
    playlist
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty()
                || line.starts_with('#')
                || line.contains('/')
                || line.contains('\\')
                || line.contains("..")
                || !line.ends_with(".m4s")
                || !rend_playback_auth::is_valid_hls_segment_name(line)
            {
                return None;
            }
            Some(line.to_owned())
        })
        .collect()
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

fn origin_playback_artifact_error(
    artifact: &OriginPlaybackArtifact,
    error: impl std::fmt::Display,
) -> AppError {
    let message = error.to_string();
    if message.contains("NoSuchKey")
        || message.contains("NotFound")
        || message.contains("Not Found")
    {
        return AppError::not_found("artifact not found");
    }

    tracing::error!(
        artifact_path = %artifact.artifact_path,
        error = %message,
        "failed to fetch playback artifact from Tigris",
    );
    AppError::bad_gateway("artifact fetch failed")
}

async fn origin_playback_artifact_full_bytes(
    state: &AppState,
    artifact: &OriginPlaybackArtifact,
) -> Result<(Bytes, &'static str, &'static str), AppError> {
    let storage_object_key = origin_playback_storage_object_key(state, artifact).await?;
    let cache_ttl = origin_playback_cache_ttl(artifact);
    if let Some(ttl) = cache_ttl
        && let Some(entry) = state.origin_playback_cache.get(&storage_object_key, ttl)
    {
        return Ok((entry.bytes, entry.content_type, "HIT"));
    }

    let object = state
        .s3
        .get_object()
        .bucket(&state.config.s3_bucket)
        .key(&storage_object_key)
        .send()
        .await
        .map_err(|error| origin_playback_artifact_error(artifact, error))?;
    let bytes = object
        .body
        .collect()
        .await
        .map_err(|error| origin_playback_artifact_error(artifact, error))?
        .into_bytes();

    if cache_ttl.is_some() {
        state.origin_playback_cache.insert(
            storage_object_key,
            bytes.clone(),
            artifact.content_type,
        );
        return Ok((bytes, artifact.content_type, "MISS"));
    }

    Ok((bytes, artifact.content_type, "BYPASS"))
}

async fn origin_playback_storage_object_key(
    state: &AppState,
    artifact: &OriginPlaybackArtifact,
) -> Result<String, AppError> {
    let storage_object_key: Option<String> = sqlx::query_scalar(
        "
        SELECT stored.storage_object_key
        FROM rend.artifacts stored
        INNER JOIN rend.assets asset ON asset.id = stored.asset_id
        INNER JOIN rend_auth.organization organization
          ON organization.id = asset.organization_id
        WHERE stored.asset_id = $1::uuid
          AND stored.object_key = $2
          AND asset.deleted_at IS NULL
          AND asset.suspended_at IS NULL
          AND organization.suspended_at IS NULL
        ",
    )
    .bind(&artifact.asset_id)
    .bind(&artifact.object_key)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::internal)?;

    storage_object_key.ok_or_else(|| AppError::not_found("artifact not found"))
}

async fn origin_playback_progressive_fmp4_response(
    state: Arc<AppState>,
    artifact: OriginPlaybackArtifact,
) -> Result<Response, AppError> {
    let rendition = hls_progressive_rendition(&artifact.artifact_path)
        .ok_or_else(|| AppError::not_found("artifact not found"))?;
    let playlist_artifact = hls_progressive_playlist_artifact(&artifact.asset_id, rendition)?;
    let (playlist_bytes, _, _) =
        origin_playback_artifact_full_bytes(state.as_ref(), &playlist_artifact).await?;
    let playlist = std::str::from_utf8(&playlist_bytes)
        .map_err(|_| AppError::bad_gateway("invalid media playlist"))?;
    let segment_names = hls_progressive_segment_names(playlist);
    if segment_names.is_empty() {
        return Err(AppError::not_found("artifact not found"));
    }

    let mut segment_names = segment_names.into_iter();
    let first_segment = segment_names
        .next()
        .ok_or_else(|| AppError::not_found("artifact not found"))?;
    let init_artifact = hls_progressive_init_artifact(&artifact.asset_id, rendition)?;
    let first_segment_artifact =
        hls_progressive_segment_artifact(&artifact.asset_id, rendition, &first_segment)?;
    let (init_part, first_segment_part) = tokio::try_join!(
        origin_playback_artifact_full_bytes(state.as_ref(), &init_artifact),
        origin_playback_artifact_full_bytes(state.as_ref(), &first_segment_artifact)
    )?;
    let (init_bytes, _, _) = init_part;
    let (first_segment_bytes, _, _) = first_segment_part;
    let mut startup_bytes = Vec::with_capacity(init_bytes.len() + first_segment_bytes.len());
    startup_bytes.extend_from_slice(&init_bytes);
    startup_bytes.extend_from_slice(&first_segment_bytes);
    let startup_bytes = Bytes::from(startup_bytes);

    let mut remaining_parts = Vec::new();
    for segment in segment_names {
        remaining_parts.push(hls_progressive_segment_artifact(
            &artifact.asset_id,
            rendition,
            &segment,
        )?);
    }

    let stream = stream::try_unfold(
        (Some(startup_bytes), state, remaining_parts.into_iter()),
        |(startup_bytes, state, mut parts)| async move {
            if let Some(bytes) = startup_bytes {
                return Ok::<_, std::io::Error>(Some((bytes, (None, state, parts))));
            }
            let Some(part) = parts.next() else {
                return Ok::<_, std::io::Error>(None);
            };
            let (bytes, _, _) = origin_playback_artifact_full_bytes(state.as_ref(), &part)
                .await
                .map_err(|error| {
                    std::io::Error::other(format!(
                        "failed to stream progressive playback artifact {}: {}",
                        part.artifact_path, error.message
                    ))
                })?;
            Ok::<_, std::io::Error>(Some((bytes, (None, state, parts))))
        },
    );

    Ok(
        origin_playback_artifact_response_builder(artifact, "video/mp4", StatusCode::OK, "STREAM")
            .body(Body::from_stream(stream))
            .expect("progressive origin artifact response headers are valid"),
    )
}

fn origin_playback_cache_ttl(artifact: &OriginPlaybackArtifact) -> Option<Duration> {
    if artifact.content_type == "application/vnd.apple.mpegurl" {
        return Some(ORIGIN_PLAYBACK_CACHE_MANIFEST_TTL);
    }
    if artifact.artifact_path == "opener.mp4"
        || is_hls_init_artifact_path(&artifact.artifact_path)
        || matches!(hls_segment_index(&artifact.artifact_path), Some(index) if index <= 2)
    {
        return Some(ORIGIN_PLAYBACK_CACHE_MEDIA_TTL);
    }

    None
}

fn cached_byte_range(
    range_header: &str,
    content_length: u64,
) -> std::result::Result<Option<(u64, u64)>, ()> {
    let range_spec = range_header.trim().strip_prefix("bytes=").ok_or(())?.trim();
    let (start, end) = range_spec.split_once('-').ok_or(())?;
    let start = start.trim();
    let end = end.trim();
    if content_length == 0 || (start.is_empty() && end.is_empty()) {
        return Err(());
    }

    match (start.is_empty(), end.is_empty()) {
        (false, false) => {
            let start = start.parse::<u64>().map_err(|_| ())?;
            let end = end.parse::<u64>().map_err(|_| ())?;
            if start >= content_length || start > end {
                return Err(());
            }
            Ok(Some((start, end.min(content_length - 1))))
        }
        (false, true) => {
            let start = start.parse::<u64>().map_err(|_| ())?;
            if start >= content_length {
                return Err(());
            }
            Ok(Some((start, content_length - 1)))
        }
        (true, false) => {
            let suffix_length = end.parse::<u64>().map_err(|_| ())?;
            if suffix_length == 0 {
                return Err(());
            }
            let start = content_length.saturating_sub(suffix_length);
            Ok(Some((start, content_length - 1)))
        }
        (true, true) => Err(()),
    }
}

fn origin_playback_artifact_bytes_response(
    artifact: OriginPlaybackArtifact,
    bytes: Bytes,
    content_type: &'static str,
    cache_status: &'static str,
    range_header: Option<&str>,
) -> Response {
    let content_length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if let Some(range_header) = range_header {
        return match cached_byte_range(range_header, content_length) {
            Ok(Some((start, end))) => {
                let start_usize = usize::try_from(start).unwrap_or(usize::MAX);
                let end_usize = usize::try_from(end).unwrap_or(usize::MAX);
                let body = bytes.slice(start_usize..end_usize.saturating_add(1));
                origin_playback_artifact_static_response(
                    artifact,
                    body,
                    content_type,
                    cache_status,
                    StatusCode::PARTIAL_CONTENT,
                    Some(end - start + 1),
                    Some(format!("bytes {start}-{end}/{content_length}")),
                )
            }
            Ok(None) => origin_playback_artifact_static_response(
                artifact,
                bytes,
                content_type,
                cache_status,
                StatusCode::OK,
                Some(content_length),
                None,
            ),
            Err(()) => origin_playback_artifact_static_response(
                artifact,
                Bytes::new(),
                content_type,
                cache_status,
                StatusCode::RANGE_NOT_SATISFIABLE,
                Some(0),
                Some(format!("bytes */{content_length}")),
            ),
        };
    }

    origin_playback_artifact_static_response(
        artifact,
        bytes,
        content_type,
        cache_status,
        StatusCode::OK,
        Some(content_length),
        None,
    )
}

fn origin_playback_artifact_static_response(
    artifact: OriginPlaybackArtifact,
    body: Bytes,
    content_type: &'static str,
    cache_status: &'static str,
    status: StatusCode,
    content_length: Option<u64>,
    content_range: Option<String>,
) -> Response {
    let mut builder =
        origin_playback_artifact_response_builder(artifact, content_type, status, cache_status);
    if let Some(content_length) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, content_length.to_string());
    }
    if let Some(content_range) = content_range {
        builder = builder.header(header::CONTENT_RANGE, content_range);
    }

    builder
        .body(Body::from(body))
        .expect("origin artifact response headers are valid")
}

fn origin_playback_artifact_response_builder(
    artifact: OriginPlaybackArtifact,
    content_type: &'static str,
    status: StatusCode,
    cache_status: &'static str,
) -> axum::http::response::Builder {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CACHE_CONTROL,
            playback_artifact_cache_control(content_type),
        )
        .header("timing-allow-origin", "https://www.rend.so")
        .header("x-rend-origin", "tigris")
        .header("x-rend-cache", cache_status);
    if artifact.content_type != "application/vnd.apple.mpegurl"
        && hls_progressive_rendition(&artifact.artifact_path).is_none()
    {
        builder = builder.header(header::ACCEPT_RANGES, "bytes");
    }
    builder
}

fn origin_playback_artifact_response(
    artifact: OriginPlaybackArtifact,
    object: aws_sdk_s3::operation::get_object::GetObjectOutput,
    storage_object_key: String,
) -> Response {
    let content_length = object
        .content_length()
        .map(|value| u64::try_from(value).unwrap_or(u64::MAX));
    let content_range = object.content_range().map(str::to_owned);
    let status = if content_range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mut builder = origin_playback_artifact_response_builder(
        artifact.clone(),
        artifact.content_type,
        status,
        "BYPASS",
    );
    if let Some(content_length) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, content_length.to_string());
    }
    if let Some(content_range) = content_range.as_deref() {
        builder = builder.header(header::CONTENT_RANGE, content_range);
    }

    builder
        .body(Body::from_stream(byte_stream_body(
            object.body,
            storage_object_key,
        )))
        .expect("origin artifact response headers are valid")
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
                "failed to read playback artifact {object_key} from origin: {error}"
            ))),
        }
    })
}

fn playback_artifact_cache_control(content_type: &str) -> &'static str {
    match content_type {
        "application/vnd.apple.mpegurl" => "private, max-age=60, stale-while-revalidate=300",
        "video/mp4" | "video/mp2t" => "private, max-age=31536000, immutable",
        _ => "no-store",
    }
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
    let _token = issue_playback_token(issuer, asset_id, None, now)?;

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
    if !config.enabled {
        return;
    }

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
    if let Some(url) = config.url.as_deref() {
        return vec![EdgeFanoutTarget {
            edge_id: "single-edge-env-fallback".to_owned(),
            region: None,
            action_url: url.to_owned(),
            source: "env_fallback",
        }];
    }

    registered_edge_fanout_targets(db, registry, "warm").await
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

                    let init_path = format!("hls/{tier}/init_{tier}.mp4");
                    if contains_artifact_path(generated_artifact_paths, &init_path) {
                        if push_limited_unique_artifact_path(
                            &mut artifact_paths,
                            max_artifacts,
                            &init_path,
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
    if !config.enabled {
        return false;
    }

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
    if let Some(url) = config.url.as_deref() {
        return vec![EdgeFanoutTarget {
            edge_id: "single-edge-env-fallback".to_owned(),
            region: None,
            action_url: url.to_owned(),
            source: "env_fallback",
        }];
    }

    registered_edge_fanout_targets(Some(db), registry, "purge").await
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

    if claims.exp < current_unix_timestamp().map_err(AppError::internal)? {
        return Ok(None);
    }

    let organization_id = normalize_org_id(&claims.org_id)?;
    match claims.v {
        1 => {
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
        }
        2 if claims.purpose.as_deref() == Some("multipart_upload")
            && claims.content_length.is_some()
            && !claims.content_type.trim().is_empty() => {}
        _ => {
            return Err(AppError::forbidden(
                "upload token has an unsupported purpose or version",
            ));
        }
    }

    Ok(Some(RequestAuth {
        organization_id,
        scopes: [ApiScope::Upload].into_iter().collect(),
        credential: RequestCredential::DashboardUploadToken,
        upload_claims: Some(claims),
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
        upload_claims: None,
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

async fn require_site_internal_token(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get("x-rend-site-token")
        .and_then(|value| value.to_str().ok());

    if provided.is_some_and(|token| secret_matches(token, &state.config.site_internal_token)) {
        next.run(request).await
    } else {
        unauthorized_response()
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

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
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

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
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
