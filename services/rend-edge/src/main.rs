use std::{
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
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
    extract::{Path as AxumPath, State},
    http::{Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rend_config::{env_duration_secs, env_path, env_socket_addr, env_string, load_dotenv};
use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt, net::TcpListener};
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

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
    request_timeout: Duration,
}

impl EdgeConfig {
    fn from_env() -> Result<Self> {
        Ok(Self {
            bind_addr: env_socket_addr("REND_EDGE_BIND_ADDR", "127.0.0.1:4100")?,
            edge_id: env_string("REND_EDGE_ID", "local-edge-001"),
            region: env_string("REND_EDGE_REGION", "local"),
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
            internal_token: env_string("REND_EDGE_INTERNAL_TOKEN", "dev-internal-token"),
            request_timeout: env_duration_secs("REND_HTTP_TIMEOUT_SECS", 10)?,
        })
    }
}

#[derive(Clone)]
struct AppState {
    config: EdgeConfig,
    http: reqwest::Client,
    s3: S3Client,
    started_at: Instant,
}

#[derive(Serialize)]
struct HealthResponse<'a> {
    service: &'a str,
    status: &'a str,
    version: &'a str,
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
struct PlaceholderResponse<'a> {
    status: &'a str,
    message: &'a str,
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

#[derive(Debug, PartialEq, Eq)]
struct PlaybackArtifact {
    object_key: String,
    cache_key: String,
    content_type: &'static str,
}

#[derive(Debug)]
enum PlaybackError {
    NotFound(String),
    OriginNotFound(String),
    Origin(String),
    Io(String),
}

#[tokio::main]
async fn main() -> Result<()> {
    load_dotenv();
    init_tracing();

    let config = EdgeConfig::from_env()?;
    fs::create_dir_all(&config.cache_dir)
        .await
        .with_context(|| format!("failed to create cache dir {}", config.cache_dir.display()))?;

    let request_timeout = config.request_timeout;
    let s3 = build_s3_client(&config);
    let state = Arc::new(AppState {
        config,
        http: reqwest::Client::new(),
        s3,
        started_at: Instant::now(),
    });

    let internal_routes = Router::new()
        .route("/warm", post(internal_placeholder))
        .route("/purge", post(internal_placeholder))
        .route("/reload-config", post(internal_placeholder))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_internal_token,
        ));

    let app = Router::new()
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
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            request_timeout,
        ))
        .with_state(state.clone());

    let listener = TcpListener::bind(state.config.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", state.config.bind_addr))?;

    tracing::info!(
        addr = %state.config.bind_addr,
        edge_id = %state.config.edge_id,
        region = %state.config.region,
        "rend-edge listening",
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("rend-edge server failed")
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

async fn healthz(State(state): State<Arc<AppState>>) -> Json<HealthResponse<'static>> {
    Json(HealthResponse {
        service: "rend-edge",
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
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

async fn metrics(State(state): State<Arc<AppState>>) -> Response {
    let ready =
        check_cache_dir(&state).await.status == "ok" && check_origin(&state).await.status == "ok";
    let body = format!(
        "# HELP rend_edge_up Edge process liveness.\n\
         # TYPE rend_edge_up gauge\n\
         rend_edge_up{{edge_id=\"{}\",region=\"{}\"}} 1\n\
         # HELP rend_edge_ready Edge readiness.\n\
         # TYPE rend_edge_ready gauge\n\
         rend_edge_ready{{edge_id=\"{}\",region=\"{}\"}} {}\n",
        state.config.edge_id,
        state.config.region,
        state.config.edge_id,
        state.config.region,
        if ready { 1 } else { 0 }
    );

    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response()
}

async fn playback(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<PlaybackPath>,
) -> Response {
    match playback_inner(state, path).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn playback_inner(
    state: Arc<AppState>,
    path: PlaybackPath,
) -> std::result::Result<Response, PlaybackError> {
    let artifact = map_playback_artifact(&path.asset_id, &path.artifact_path)?;
    let cache_path = state.config.cache_dir.join(&artifact.cache_key);

    match fs::read(&cache_path).await {
        Ok(bytes) => {
            let content_length = u64::try_from(bytes.len()).ok();
            return Ok(artifact_response(
                artifact.content_type,
                "HIT",
                Body::from(bytes),
                content_length,
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(PlaybackError::Io(format!(
                "failed to read cached artifact {}: {error}",
                cache_path.display()
            )));
        }
    }

    let bytes = fetch_origin_artifact(&state, &artifact).await?;
    let content_length = u64::try_from(bytes.len()).ok();
    write_cache_file(&cache_path, &bytes).await?;

    Ok(artifact_response(
        artifact.content_type,
        "MISS",
        Body::from(bytes),
        content_length,
    ))
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
        .header("x-rend-cache", cache_status);

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

    let bytes = object.body.collect().await.map_err(|error| {
        PlaybackError::Origin(format!(
            "failed to read artifact {} from origin: {error}",
            artifact.object_key
        ))
    })?;

    Ok(bytes.into_bytes().to_vec())
}

async fn write_cache_file(path: &FsPath, bytes: &[u8]) -> std::result::Result<(), PlaybackError> {
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
        && asset_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn is_valid_hls_segment_name(segment_name: &str) -> bool {
    let Some(number) = segment_name
        .strip_prefix("segment_")
        .and_then(|name| name.strip_suffix(".ts"))
    else {
        return false;
    };

    !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
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
        };

        (status, Json(ErrorResponse { error: message })).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_opener_to_goal_three_object_and_cache_key() {
        assert_eq!(
            map_playback_artifact("asset-123", "opener.mp4").unwrap(),
            PlaybackArtifact {
                object_key: "videos/asset-123/opener.mp4".to_owned(),
                cache_key: "videos/asset-123/opener.mp4".to_owned(),
                content_type: "video/mp4",
            }
        );
    }

    #[test]
    fn maps_hls_manifest_to_goal_three_object_and_cache_key() {
        assert_eq!(
            map_playback_artifact("asset-123", "hls/master.m3u8").unwrap(),
            PlaybackArtifact {
                object_key: "videos/asset-123/hls/master.m3u8".to_owned(),
                cache_key: "videos/asset-123/hls/master.m3u8".to_owned(),
                content_type: "application/vnd.apple.mpegurl",
            }
        );
    }

    #[test]
    fn maps_hls_segment_to_goal_three_object_and_cache_key() {
        assert_eq!(
            map_playback_artifact("asset-123", "hls/segment_00000.ts").unwrap(),
            PlaybackArtifact {
                object_key: "videos/asset-123/hls/segment_00000.ts".to_owned(),
                cache_key: "videos/asset-123/hls/segment_00000.ts".to_owned(),
                content_type: "video/mp2t",
            }
        );
    }

    #[test]
    fn rejects_unsupported_artifact_paths() {
        for artifact_path in [
            "source",
            "thumbnail.jpg",
            "hls",
            "hls/",
            "hls/master.m3u8/extra",
            "hls/segment_00000.m4s",
            "hls/segment_abc.ts",
            "hls/nested/segment_00000.ts",
            "../opener.mp4",
            "hls/../opener.mp4",
            "videos/asset-123/opener.mp4",
        ] {
            assert!(
                map_playback_artifact("asset-123", artifact_path).is_err(),
                "{artifact_path} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_unsafe_asset_ids() {
        for asset_id in [
            "",
            ".",
            "..",
            "../asset",
            "asset/123",
            "asset.123",
            "asset%2f123",
        ] {
            assert!(
                map_playback_artifact(asset_id, "opener.mp4").is_err(),
                "{asset_id} should be rejected"
            );
        }
    }
}
