use std::{
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
    extract::State,
    http::{HeaderMap, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
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
use sqlx::{PgPool, migrate::Migrator, postgres::PgPoolOptions};
use tokio::net::TcpListener;
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

mod media;

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

const DEFAULT_EDGE_WARM_MAX_ARTIFACTS: usize = 4;
const HARD_EDGE_WARM_MAX_ARTIFACTS: usize = 16;
const EDGE_WARM_LOG_BODY_LIMIT_BYTES: usize = 1024;

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
    edge_warm: EdgeWarmConfig,
    media_processing: media::MediaProcessingConfig,
    auto_migrate: bool,
    request_timeout: Duration,
}

#[derive(Clone)]
struct EdgeWarmConfig {
    url: Option<String>,
    internal_token: String,
    max_artifacts: usize,
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
        let edge_warm_url = optional_env_url("REND_EDGE_WARM_URL");
        let edge_internal_token = env_string("REND_EDGE_INTERNAL_TOKEN", "dev-internal-token");
        let edge_warm_max_artifacts = env_usize(
            "REND_EDGE_WARM_MAX_ARTIFACTS",
            DEFAULT_EDGE_WARM_MAX_ARTIFACTS,
        )?;
        anyhow::ensure!(
            (1..=HARD_EDGE_WARM_MAX_ARTIFACTS).contains(&edge_warm_max_artifacts),
            "REND_EDGE_WARM_MAX_ARTIFACTS must be between 1 and {HARD_EDGE_WARM_MAX_ARTIFACTS}"
        );
        if edge_warm_url.is_some() {
            anyhow::ensure!(
                !edge_internal_token.trim().is_empty(),
                "REND_EDGE_INTERNAL_TOKEN must not be empty when REND_EDGE_WARM_URL is configured"
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
            edge_warm: EdgeWarmConfig {
                url: edge_warm_url,
                internal_token: edge_internal_token,
                max_artifacts: edge_warm_max_artifacts,
            },
            media_processing: media::MediaProcessingConfig {
                ffmpeg_path: env_string("REND_FFMPEG_PATH", "ffmpeg"),
                ffprobe_path: env_string("REND_FFPROBE_PATH", "ffprobe"),
                process_timeout: env_duration_secs("REND_MEDIA_PROCESS_TIMEOUT_SECS", 60)?,
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
    playback_url: String,
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

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

struct CountedRequestBody {
    body: Mutex<Pin<Box<Body>>>,
    byte_count: Arc<AtomicU64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    load_dotenv();
    init_tracing();

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

    let upload_routes = Router::new()
        .route("/v1/videos", post(create_video))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_dev_api_key,
        ));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/healthz", get(healthz))
        .route("/v1/readyz", get(readyz))
        .merge(upload_routes)
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
        .with_state(state.clone());

    let listener = TcpListener::bind(state.config.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", state.config.bind_addr))?;

    tracing::info!(addr = %state.config.bind_addr, "rend-api listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("rend-api server failed")
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

async fn healthz(State(state): State<Arc<AppState>>) -> Json<HealthResponse<'static>> {
    Json(HealthResponse {
        service: "rend-api",
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        uptime_ms: state.started_at.elapsed().as_millis(),
    })
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

async fn create_video_inner(
    state: Arc<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Result<CreateVideoResponse, AppError> {
    let content_type = request_content_type(&headers);
    let content_length = request_content_length(&headers)?;
    let asset_id: String = sqlx::query_scalar(
        "
        INSERT INTO rend.assets (source_state, playable_state)
        VALUES ('uploading', 'not_playable')
        RETURNING id::text
        ",
    )
    .fetch_one(&state.db)
    .await
    .map_err(AppError::internal)?;

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
    tx.commit().await.map_err(AppError::internal)?;

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
) -> Result<String, PlaybackAuthError> {
    let artifact_path = playback_artifact_path(playable_state);
    let token = issuer.issue_asset_playback_token(asset_id, now)?;

    Ok(format!(
        "{}/v/{asset_id}/{artifact_path}?token={token}",
        base_url.trim_end_matches('/')
    ))
}

fn playback_artifact_path(playable_state: &str) -> &'static str {
    match playable_state {
        "hls_ready" => "hls/master.m3u8",
        "opener_ready" => "opener.mp4",
        _ => "opener.mp4",
    }
}

async fn maybe_warm_edge(
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

    if let Err(error) = send_edge_warm_request(http, config, &request).await {
        tracing::warn!(
            asset_id,
            error = %error,
            "edge warm request failed; upload remains playable",
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
) -> std::result::Result<(), String> {
    let Some(url) = config.url.as_deref() else {
        return Ok(());
    };

    let response = http
        .post(url)
        .header("x-rend-internal-token", &config.internal_token)
        .json(request)
        .send()
        .await
        .map_err(|error| format!("failed to call {url}: {error}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }

    let body = response
        .text()
        .await
        .unwrap_or_else(|error| format!("failed to read warm response body: {error}"));

    Err(format!(
        "edge warm endpoint returned {status}: {}",
        limit_log_body(&body)
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use rend_playback_auth::{POLICY_ASSET_PLAYBACK_V1, decode_unverified_claims};
    use std::sync::atomic::AtomicUsize;

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
    fn content_type_defaults_to_octet_stream() {
        assert_eq!(
            request_content_type(&HeaderMap::new()),
            "application/octet-stream".to_owned()
        );
    }
}
