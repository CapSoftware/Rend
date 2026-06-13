use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rend_config::{env_duration_secs, env_path, env_socket_addr, env_string, load_dotenv};
use serde::{Deserialize, Serialize};
use tokio::{fs, net::TcpListener};
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
struct EdgeConfig {
    bind_addr: SocketAddr,
    edge_id: String,
    region: String,
    cache_dir: PathBuf,
    origin_health_url: String,
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
            internal_token: env_string("REND_EDGE_INTERNAL_TOKEN", "dev-internal-token"),
            request_timeout: env_duration_secs("REND_HTTP_TIMEOUT_SECS", 10)?,
        })
    }
}

#[derive(Clone)]
struct AppState {
    config: EdgeConfig,
    http: reqwest::Client,
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

#[derive(Deserialize)]
struct PlaybackPath {
    asset_id: String,
    artifact_path: String,
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
    let state = Arc::new(AppState {
        config,
        http: reqwest::Client::new(),
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
        .route("/v/{asset_id}/{*artifact_path}", get(playback_placeholder))
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

async fn playback_placeholder(Path(path): Path<PlaybackPath>) -> Response {
    let _ = (path.asset_id, path.artifact_path);
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(PlaceholderResponse {
            status: "not_implemented",
            message: "Playback is intentionally not implemented in the foundation slice.",
        }),
    )
        .into_response()
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
