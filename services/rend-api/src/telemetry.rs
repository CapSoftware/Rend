use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use axum::{
    Json,
    body::Body,
    extract::{Extension, Path as AxumPath, Query, State},
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use rend_config::{env_string, env_usize};
use rend_playback_auth::is_asset_playback_path;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ApiScope, AppError, AppState, RequestAuth, billing, ensure_asset_not_suspended,
    ensure_org_not_suspended, normalize_asset_id, normalize_org_id, require_scope,
};

const DEFAULT_TELEMETRY_MAX_BODY_BYTES: usize = 256 * 1024;
const HARD_TELEMETRY_MAX_BODY_BYTES: usize = 1024 * 1024;
const DEFAULT_TELEMETRY_MAX_EVENTS_PER_BATCH: usize = 100;
const HARD_TELEMETRY_MAX_EVENTS_PER_BATCH: usize = 1000;
const DEFAULT_ANALYTICS_WINDOW_SECS: usize = 24 * 60 * 60;
const DEFAULT_ANALYTICS_MAX_WINDOW_SECS: usize = 7 * 24 * 60 * 60;
const ANALYTICS_ROLLUP_THROTTLE_SECS: u64 = 60;
const ANALYTICS_ROLLUP_LOOKBACK_SECS: i64 = 2 * 60 * 60;
const ANALYTICS_ROLLUP_LAG_SECS: i64 = 60;
const DEFAULT_OVERVIEW_WINDOW_SECS: u64 = 24 * 60 * 60;
const MAX_OVERVIEW_WINDOW_SECS: u64 = 90 * 24 * 60 * 60;
const PLAYER_WATCH_DELTA_MAX_MS: u32 = 60_000;

static LAST_ANALYTICS_ROLLUP_ATTEMPT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub(crate) struct TelemetryConfig {
    pub(crate) clickhouse_url: String,
    pub(crate) clickhouse_database: String,
    pub(crate) clickhouse_user: String,
    pub(crate) clickhouse_password: String,
    pub(crate) internal_token: String,
    pub(crate) max_body_bytes: usize,
    pub(crate) max_events_per_batch: usize,
    pub(crate) default_analytics_window_secs: u64,
    pub(crate) max_analytics_window_secs: u64,
}

impl TelemetryConfig {
    pub(crate) fn from_env(edge_internal_token: &str) -> Result<Self> {
        let dedicated_token = env_string("REND_INTERNAL_TELEMETRY_TOKEN", "");
        let internal_token = if dedicated_token.trim().is_empty() {
            edge_internal_token.to_owned()
        } else {
            dedicated_token
        };
        anyhow::ensure!(
            !internal_token.trim().is_empty(),
            "REND_INTERNAL_TELEMETRY_TOKEN or REND_EDGE_INTERNAL_TOKEN must not be empty"
        );

        let max_body_bytes = env_usize(
            "REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES",
            DEFAULT_TELEMETRY_MAX_BODY_BYTES,
        )?;
        anyhow::ensure!(
            (1..=HARD_TELEMETRY_MAX_BODY_BYTES).contains(&max_body_bytes),
            "REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES must be between 1 and {HARD_TELEMETRY_MAX_BODY_BYTES}"
        );

        let max_events_per_batch = env_usize(
            "REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH",
            DEFAULT_TELEMETRY_MAX_EVENTS_PER_BATCH,
        )?;
        anyhow::ensure!(
            (1..=HARD_TELEMETRY_MAX_EVENTS_PER_BATCH).contains(&max_events_per_batch),
            "REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH must be between 1 and {HARD_TELEMETRY_MAX_EVENTS_PER_BATCH}"
        );

        let default_analytics_window_secs = env_usize(
            "REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS",
            DEFAULT_ANALYTICS_WINDOW_SECS,
        )?;
        let max_analytics_window_secs = env_usize(
            "REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS",
            DEFAULT_ANALYTICS_MAX_WINDOW_SECS,
        )?;
        anyhow::ensure!(
            default_analytics_window_secs > 0,
            "REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS must be greater than 0"
        );
        anyhow::ensure!(
            max_analytics_window_secs >= default_analytics_window_secs,
            "REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS must be at least REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS"
        );

        Ok(Self {
            clickhouse_url: env_string("CLICKHOUSE_URL", "http://localhost:8123")
                .trim()
                .trim_end_matches('/')
                .to_owned(),
            clickhouse_database: env_string("CLICKHOUSE_DATABASE", "rend"),
            clickhouse_user: env_string("CLICKHOUSE_USER", "rend"),
            clickhouse_password: env_string("CLICKHOUSE_PASSWORD", "rend"),
            internal_token,
            max_body_bytes,
            max_events_per_batch,
            default_analytics_window_secs: u64::try_from(default_analytics_window_secs)
                .context("REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS is too large")?,
            max_analytics_window_secs: u64::try_from(max_analytics_window_secs)
                .context("REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS is too large")?,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlaybackTelemetryBatch {
    events: Vec<PlaybackTelemetryEventInput>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaybackTelemetryEventInput {
    event_id: String,
    observed_at: String,
    #[serde(default)]
    organization_id: Option<String>,
    asset_id: String,
    artifact_path: String,
    edge_id: String,
    region: String,
    cache_status: String,
    status_code: u16,
    bytes_served: u64,
    content_type: String,
    duration_ms: u32,
    #[serde(default)]
    error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NormalizedPlaybackTelemetryEvent {
    event_id: String,
    observed_at: DateTime<Utc>,
    asset_id: String,
    artifact_path: String,
    edge_id: String,
    region: String,
    cache_status: String,
    status_code: u16,
    bytes_served: u64,
    content_type: String,
    duration_ms: u32,
    error_code: Option<String>,
}

#[derive(Debug, Serialize)]
struct ClickHousePlaybackEventRow {
    event_id: String,
    observed_at: String,
    ingested_at: String,
    asset_id: String,
    organization_id: Option<String>,
    artifact_path: String,
    edge_id: String,
    region: String,
    cache_status: String,
    status_code: u16,
    bytes_served: u64,
    content_type: String,
    duration_ms: u32,
    delivered_duration_ms: u32,
    resolution_tier: Option<String>,
    error_code: Option<String>,
}

#[derive(Serialize)]
struct PlaybackTelemetryIngestResponse {
    accepted: usize,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PlaybackAnalyticsQuery {
    window_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AnalyticsOverviewQuery {
    window_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PlayerTelemetryBatch {
    events: Vec<PlayerTelemetryEventInput>,
}

#[derive(Debug, Deserialize)]
struct PlayerTelemetryEventInput {
    playback_session_id: String,
    asset_id: String,
    phase: String,
    event_time_ms: i64,
    #[serde(default)]
    selected_playback_mode: Option<String>,
    #[serde(default)]
    selected_artifact_path: Option<String>,
    #[serde(default)]
    first_frame_ms: Option<u32>,
    #[serde(default)]
    bootstrap_duration_ms: Option<u32>,
    #[serde(default)]
    bootstrap_http_status: Option<u16>,
    #[serde(default)]
    stall_duration_ms: Option<u32>,
    #[serde(default)]
    watch_delta_ms: Option<u32>,
    #[serde(default)]
    playback_failure_code: Option<String>,
    #[serde(default)]
    edge_label: Option<String>,
    #[serde(default)]
    region_label: Option<String>,
    #[serde(default)]
    player_version: Option<String>,
    #[serde(default)]
    app_version: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NormalizedPlaybackAnalyticsWindow {
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct ClickHouseAnalyticsRow {
    cache_status: String,
    status_code: u16,
    request_count: u64,
    bytes_served: u64,
    first_seen_ms: i64,
    last_seen_ms: i64,
}

#[derive(Debug, Deserialize)]
struct ClickHouseEdgeOverviewRow {
    request_count: u64,
    bytes_served: u64,
    cache_hit_count: u64,
    error_count: u64,
    request_duration_p50_ms: f64,
    request_duration_p95_ms: f64,
}

#[derive(Debug, Deserialize)]
struct ClickHousePlayerOverviewRow {
    sessions: u64,
    views: u64,
    startup_failures: u64,
    watch_time_ms: u64,
    stalled_sessions: u64,
    stall_count: u64,
    stall_duration_ms: u64,
    playback_failures: u64,
    first_frame_p50_ms: f64,
    first_frame_p95_ms: f64,
}

#[derive(Debug, Deserialize)]
struct ClickHouseAnalyticsSeriesRow {
    bucket_start_ms: i64,
    views: u64,
    watch_time_ms: u64,
    request_count: u64,
    bytes_served: u64,
}

#[derive(Debug, Deserialize)]
struct ClickHouseAnalyticsAssetRow {
    asset_id: String,
    views: u64,
    watch_time_ms: u64,
    request_count: u64,
    bytes_served: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NormalizedPlayerTelemetryEvent {
    event_id: String,
    observed_at: DateTime<Utc>,
    asset_id: String,
    playback_session_id: String,
    phase: String,
    selected_playback_mode: String,
    selected_artifact_path: String,
    first_frame_ms: u32,
    bootstrap_duration_ms: u32,
    bootstrap_http_status: u16,
    stall_duration_ms: u32,
    watch_delta_ms: u32,
    playback_failure_code: String,
    edge_label: String,
    region_label: String,
    player_version: String,
    app_version: String,
}

#[derive(Debug, Serialize)]
struct ClickHousePlayerEventRow {
    event_id: String,
    observed_at: String,
    received_at: String,
    organization_id: String,
    asset_id: String,
    playback_session_id: String,
    phase: String,
    selected_playback_mode: String,
    selected_artifact_path: String,
    first_frame_ms: u32,
    bootstrap_duration_ms: u32,
    bootstrap_http_status: u16,
    stall_duration_ms: u32,
    watch_delta_ms: u32,
    playback_failure_code: String,
    edge_label: String,
    region_label: String,
    player_version: String,
    app_version: String,
}

#[derive(Clone, Debug, Default)]
struct AssetPlaybackBillingMetadata {
    organization_id: Option<String>,
    duration_ms: Option<i64>,
    max_resolution_tier: Option<String>,
    artifacts: HashMap<String, ArtifactPlaybackBillingMetadata>,
}

#[derive(Clone, Debug)]
struct ArtifactPlaybackBillingMetadata {
    duration_ms: Option<i64>,
    resolution_tier: Option<String>,
}

#[derive(Debug, Serialize)]
struct PlaybackAnalyticsResponse {
    asset_id: String,
    window_started_at: String,
    window_ended_at: String,
    request_count: u64,
    bytes_served: u64,
    cache_status_counts: BTreeMap<String, u64>,
    status_code_counts: BTreeMap<String, u64>,
    first_seen: Option<String>,
    last_seen: Option<String>,
}

#[derive(Serialize)]
struct PlayerTelemetryIngestResponse {
    accepted: usize,
}

#[derive(Debug, Serialize)]
struct AnalyticsOverviewResponse {
    window_started_at: String,
    window_ended_at: String,
    views: u64,
    sessions: u64,
    watch_time_ms: u64,
    startup_success_rate: f64,
    startup_p50_ms: Option<f64>,
    startup_p95_ms: Option<f64>,
    rebuffer_ratio: f64,
    stalled_sessions: u64,
    stall_count: u64,
    stall_duration_ms: u64,
    playback_failures: u64,
    request_count: u64,
    bytes_served: u64,
    cache_hit_rate: f64,
    error_rate: f64,
    request_p50_ms: Option<f64>,
    request_p95_ms: Option<f64>,
    timeseries: Vec<AnalyticsTimeSeriesPoint>,
    top_assets: Vec<AnalyticsAssetSummary>,
}

#[derive(Debug, Serialize)]
struct AnalyticsTimeSeriesPoint {
    bucket_start: String,
    views: u64,
    watch_time_ms: u64,
    request_count: u64,
    bytes_served: u64,
}

#[derive(Debug, Serialize)]
struct AnalyticsAssetSummary {
    asset_id: String,
    views: u64,
    watch_time_ms: u64,
    request_count: u64,
    bytes_served: u64,
}

pub(crate) async fn post_playback_telemetry(
    State(state): State<Arc<AppState>>,
    Json(batch): Json<PlaybackTelemetryBatch>,
) -> Response {
    match post_playback_telemetry_inner(state, batch).await {
        Ok(response) => (StatusCode::ACCEPTED, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(crate) async fn post_player_telemetry(
    State(state): State<Arc<AppState>>,
    Json(batch): Json<PlayerTelemetryBatch>,
) -> Response {
    match post_player_telemetry_inner(state, batch).await {
        Ok(response) => (StatusCode::ACCEPTED, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn post_playback_telemetry_inner(
    state: Arc<AppState>,
    batch: PlaybackTelemetryBatch,
) -> std::result::Result<PlaybackTelemetryIngestResponse, AppError> {
    let ingested_at = Utc::now();
    let events = normalize_playback_telemetry_batch(
        batch,
        state.config.playback_telemetry.max_events_per_batch,
        ingested_at,
    )?;
    let billing_metadata = fetch_asset_playback_billing_metadata(&state.db, &events).await?;
    let rows = events
        .into_iter()
        .map(|event| event.into_clickhouse_row(ingested_at, &billing_metadata))
        .collect::<Vec<_>>();
    insert_clickhouse_playback_events(&state.http, &state.config.playback_telemetry, &rows).await?;
    schedule_analytics_rollup_refresh(state.clone());
    billing::schedule_delivery_usage_sync(state);

    Ok(PlaybackTelemetryIngestResponse {
        accepted: rows.len(),
    })
}

async fn post_player_telemetry_inner(
    state: Arc<AppState>,
    batch: PlayerTelemetryBatch,
) -> std::result::Result<PlayerTelemetryIngestResponse, AppError> {
    let received_at = Utc::now();
    let events = normalize_player_telemetry_batch(
        batch,
        state.config.playback_telemetry.max_events_per_batch,
        received_at,
    )?;
    let organizations = fetch_player_event_organizations(&state.db, &events).await?;
    let rows = events
        .into_iter()
        .filter_map(|event| event.into_clickhouse_row(received_at, &organizations))
        .collect::<Vec<_>>();

    if !rows.is_empty() {
        insert_clickhouse_player_events(&state.http, &state.config.playback_telemetry, &rows)
            .await?;
        schedule_analytics_rollup_refresh(state);
    }

    Ok(PlayerTelemetryIngestResponse {
        accepted: rows.len(),
    })
}

pub(crate) async fn get_playback_analytics(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    AxumPath(asset_id): AxumPath<String>,
    Query(query): Query<PlaybackAnalyticsQuery>,
) -> Response {
    match get_playback_analytics_inner(state, auth, asset_id, query).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(crate) async fn get_analytics_overview(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    Query(query): Query<AnalyticsOverviewQuery>,
) -> Response {
    match get_analytics_overview_inner(state, auth, query).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn get_playback_analytics_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    asset_id: String,
    query: PlaybackAnalyticsQuery,
) -> std::result::Result<PlaybackAnalyticsResponse, AppError> {
    require_scope(&auth, ApiScope::Analytics)?;
    let asset_id = normalize_asset_id(&asset_id)?;
    ensure_asset_not_suspended(&state.db, &auth.organization_id, &asset_id).await?;

    let window =
        normalize_playback_analytics_window(query, &state.config.playback_telemetry, Utc::now())?;
    let rows = query_clickhouse_playback_analytics(
        &state.http,
        &state.config.playback_telemetry,
        &asset_id,
        window,
    )
    .await?;

    Ok(playback_analytics_response(asset_id, window, rows))
}

async fn get_analytics_overview_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    query: AnalyticsOverviewQuery,
) -> std::result::Result<AnalyticsOverviewResponse, AppError> {
    require_scope(&auth, ApiScope::Analytics)?;
    let organization_id = normalize_org_id(&auth.organization_id)?;
    ensure_org_not_suspended(&state.db, &organization_id).await?;
    let window = normalize_overview_window(query, Utc::now())?;

    let edge = query_clickhouse_edge_overview(
        &state.http,
        &state.config.playback_telemetry,
        &organization_id,
        window,
    )
    .await?;
    let player = query_clickhouse_player_overview(
        &state.http,
        &state.config.playback_telemetry,
        &organization_id,
        window,
    )
    .await?;
    let timeseries = query_clickhouse_analytics_series(
        &state.http,
        &state.config.playback_telemetry,
        &organization_id,
        window,
    )
    .await?;
    let top_assets = query_clickhouse_analytics_top_assets(
        &state.http,
        &state.config.playback_telemetry,
        &organization_id,
        window,
    )
    .await?;

    Ok(analytics_overview_response(
        window, edge, player, timeseries, top_assets,
    ))
}

pub(crate) async fn require_internal_telemetry_token(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get("x-rend-internal-token")
        .or_else(|| request.headers().get("x-rend-telemetry-token"))
        .and_then(|value| value.to_str().ok());

    if provided == Some(state.config.playback_telemetry.internal_token.as_str()) {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "status": "unauthorized",
                "message": "internal telemetry endpoint requires x-rend-internal-token"
            })),
        )
            .into_response()
    }
}

pub(crate) fn normalize_playback_telemetry_batch(
    batch: PlaybackTelemetryBatch,
    max_events_per_batch: usize,
    ingested_at: DateTime<Utc>,
) -> std::result::Result<Vec<NormalizedPlaybackTelemetryEvent>, AppError> {
    if batch.events.is_empty() {
        return Err(AppError::bad_request(
            "events must include at least one item",
        ));
    }
    if batch.events.len() > max_events_per_batch {
        return Err(AppError::bad_request(format!(
            "events must include at most {max_events_per_batch} items"
        )));
    }

    batch
        .events
        .into_iter()
        .map(|event| normalize_playback_telemetry_event(event, ingested_at))
        .collect()
}

fn normalize_player_telemetry_batch(
    batch: PlayerTelemetryBatch,
    max_events_per_batch: usize,
    received_at: DateTime<Utc>,
) -> std::result::Result<Vec<NormalizedPlayerTelemetryEvent>, AppError> {
    if batch.events.is_empty() {
        return Err(AppError::bad_request(
            "events must include at least one item",
        ));
    }
    if batch.events.len() > max_events_per_batch {
        return Err(AppError::bad_request(format!(
            "events must include at most {max_events_per_batch} items"
        )));
    }

    batch
        .events
        .into_iter()
        .map(|event| normalize_player_telemetry_event(event, received_at))
        .collect()
}

fn normalize_playback_telemetry_event(
    event: PlaybackTelemetryEventInput,
    ingested_at: DateTime<Utc>,
) -> std::result::Result<NormalizedPlaybackTelemetryEvent, AppError> {
    let observed_at = DateTime::parse_from_rfc3339(event.observed_at.trim())
        .map_err(|_| AppError::bad_request("observed_at must be RFC3339"))?
        .with_timezone(&Utc);
    if observed_at > ingested_at + ChronoDuration::minutes(5) {
        return Err(AppError::bad_request(
            "observed_at must not be more than five minutes in the future",
        ));
    }

    let event_id = normalize_safe_token(&event.event_id, "event_id", 128)?;
    if let Some(organization_id) = event.organization_id.as_deref() {
        validate_optional_uuid(organization_id, "organization_id")?;
    }

    let asset_id = normalize_asset_id(&event.asset_id)?;
    let artifact_path = normalize_artifact_path(&event.artifact_path)?;
    let edge_id = normalize_safe_token(&event.edge_id, "edge_id", 64)?;
    let region = normalize_safe_token(&event.region, "region", 64)?;
    let cache_status = normalize_cache_status(&event.cache_status)?;
    if !(100..=599).contains(&event.status_code) {
        return Err(AppError::bad_request("status_code must be an HTTP status"));
    }
    if event.duration_ms > 3_600_000 {
        return Err(AppError::bad_request(
            "duration_ms must be at most one hour",
        ));
    }
    let content_type = normalize_safe_text(&event.content_type, "content_type", 128)?;
    let error_code = match event.error_code {
        Some(value) if !value.trim().is_empty() => {
            Some(normalize_safe_token(&value, "error_code", 64)?)
        }
        _ => None,
    };

    Ok(NormalizedPlaybackTelemetryEvent {
        event_id,
        observed_at,
        asset_id,
        artifact_path,
        edge_id,
        region,
        cache_status,
        status_code: event.status_code,
        bytes_served: event.bytes_served,
        content_type,
        duration_ms: event.duration_ms,
        error_code,
    })
}

fn normalize_player_telemetry_event(
    event: PlayerTelemetryEventInput,
    received_at: DateTime<Utc>,
) -> std::result::Result<NormalizedPlayerTelemetryEvent, AppError> {
    let observed_at =
        DateTime::<Utc>::from_timestamp_millis(event.event_time_ms).ok_or_else(|| {
            AppError::bad_request("event_time_ms must be a Unix millisecond timestamp")
        })?;
    if observed_at > received_at + ChronoDuration::minutes(5) {
        return Err(AppError::bad_request(
            "event_time_ms must not be more than five minutes in the future",
        ));
    }

    let asset_id = normalize_asset_id(&event.asset_id)?;
    let playback_session_id =
        normalize_safe_token(&event.playback_session_id, "playback_session_id", 160)?;
    let phase = normalize_player_phase(&event.phase)?;
    let selected_playback_mode = optional_safe_token(
        event.selected_playback_mode.as_deref(),
        "selected_playback_mode",
        32,
    )?;
    let selected_artifact_path = optional_artifact_path(event.selected_artifact_path.as_deref())?;
    let playback_failure_code = optional_safe_token(
        event.playback_failure_code.as_deref(),
        "playback_failure_code",
        80,
    )?;
    let edge_label = optional_safe_token(event.edge_label.as_deref(), "edge_label", 80)?;
    let region_label = optional_safe_token(event.region_label.as_deref(), "region_label", 80)?;
    let player_version =
        optional_safe_token(event.player_version.as_deref(), "player_version", 64)?;
    let app_version = optional_safe_token(event.app_version.as_deref(), "app_version", 64)?;
    let bootstrap_http_status = event.bootstrap_http_status.unwrap_or(0);
    if bootstrap_http_status != 0 && !(100..=599).contains(&bootstrap_http_status) {
        return Err(AppError::bad_request(
            "bootstrap_http_status must be an HTTP status",
        ));
    }
    let watch_delta_ms = event
        .watch_delta_ms
        .unwrap_or(0)
        .min(PLAYER_WATCH_DELTA_MAX_MS);

    Ok(NormalizedPlayerTelemetryEvent {
        event_id: player_event_id(
            &asset_id,
            &playback_session_id,
            &phase,
            event.event_time_ms,
            &selected_artifact_path,
        ),
        observed_at,
        asset_id,
        playback_session_id,
        phase,
        selected_playback_mode,
        selected_artifact_path,
        first_frame_ms: event.first_frame_ms.unwrap_or(0),
        bootstrap_duration_ms: event.bootstrap_duration_ms.unwrap_or(0),
        bootstrap_http_status,
        stall_duration_ms: event.stall_duration_ms.unwrap_or(0),
        watch_delta_ms,
        playback_failure_code,
        edge_label,
        region_label,
        player_version,
        app_version,
    })
}

fn normalize_player_phase(value: &str) -> std::result::Result<String, AppError> {
    let value = value.trim();
    match value {
        "player_load"
        | "bootstrap_complete"
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
        | "watch_heartbeat"
        | "bootstrap_failure"
        | "playback_failure"
        | "playback_ended" => Ok(value.to_owned()),
        _ => Err(AppError::bad_request("phase is not supported")),
    }
}

fn optional_safe_token(
    value: Option<&str>,
    field: &str,
    max_len: usize,
) -> std::result::Result<String, AppError> {
    match value {
        Some(value) if !value.trim().is_empty() => normalize_safe_token(value, field, max_len),
        _ => Ok(String::new()),
    }
}

fn optional_artifact_path(value: Option<&str>) -> std::result::Result<String, AppError> {
    match value {
        Some(value) if !value.trim().is_empty() => normalize_artifact_path(value),
        _ => Ok(String::new()),
    }
}

fn player_event_id(
    asset_id: &str,
    playback_session_id: &str,
    phase: &str,
    event_time_ms: i64,
    selected_artifact_path: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(asset_id.as_bytes());
    hasher.update([0]);
    hasher.update(playback_session_id.as_bytes());
    hasher.update([0]);
    hasher.update(phase.as_bytes());
    hasher.update([0]);
    hasher.update(event_time_ms.to_string().as_bytes());
    hasher.update([0]);
    hasher.update(selected_artifact_path.as_bytes());
    format!("player-{:x}", hasher.finalize())
}

fn validate_optional_uuid(value: &str, field: &str) -> std::result::Result<(), AppError> {
    let value = value.trim();
    if !value.is_empty() && !crate::is_canonical_uuid(value) {
        return Err(AppError::bad_request(format!("{field} must be a UUID")));
    }
    Ok(())
}

fn normalize_artifact_path(value: &str) -> std::result::Result<String, AppError> {
    let value = normalize_safe_text(value, "artifact_path", 256)?;
    if !is_asset_playback_path(&value) {
        return Err(AppError::bad_request("unsupported artifact_path"));
    }
    Ok(value)
}

fn normalize_cache_status(value: &str) -> std::result::Result<String, AppError> {
    let value = value.trim().to_ascii_uppercase();
    match value.as_str() {
        "HIT" | "MISS" | "COALESCED" | "ERROR" => Ok(value),
        _ => Err(AppError::bad_request(
            "cache_status must be HIT, MISS, COALESCED, or ERROR",
        )),
    }
}

fn normalize_safe_token(
    value: &str,
    field: &str,
    max_len: usize,
) -> std::result::Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_len {
        return Err(AppError::bad_request(format!(
            "{field} must be between 1 and {max_len} bytes"
        )));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(AppError::bad_request(format!(
            "{field} contains unsupported characters"
        )));
    }
    Ok(value.to_owned())
}

fn normalize_safe_text(
    value: &str,
    field: &str,
    max_len: usize,
) -> std::result::Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_len {
        return Err(AppError::bad_request(format!(
            "{field} must be between 1 and {max_len} bytes"
        )));
    }
    if value
        .bytes()
        .any(|byte| byte.is_ascii_control() || matches!(byte, b'?' | b'#'))
        || value.contains("://")
        || value
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return Err(AppError::bad_request(format!("{field} is not allowed")));
    }
    Ok(value.to_owned())
}

async fn fetch_asset_playback_billing_metadata(
    db: &sqlx::PgPool,
    events: &[NormalizedPlaybackTelemetryEvent],
) -> std::result::Result<HashMap<String, AssetPlaybackBillingMetadata>, AppError> {
    let mut asset_ids = events
        .iter()
        .map(|event| event.asset_id.clone())
        .collect::<Vec<_>>();
    asset_ids.sort();
    asset_ids.dedup();

    let asset_rows: Vec<(String, Option<String>, Option<i64>, Option<String>)> = sqlx::query_as(
        "
        SELECT id::text,
               organization_id::text,
               duration_ms,
               max_resolution_tier
        FROM rend.assets
        WHERE id::text = ANY($1::text[])
        ",
    )
    .bind(&asset_ids)
    .fetch_all(db)
    .await
    .map_err(AppError::internal)?;

    let mut metadata = asset_rows
        .into_iter()
        .map(
            |(asset_id, organization_id, duration_ms, max_resolution_tier)| {
                (
                    asset_id,
                    AssetPlaybackBillingMetadata {
                        organization_id,
                        duration_ms,
                        max_resolution_tier,
                        artifacts: HashMap::new(),
                    },
                )
            },
        )
        .collect::<HashMap<_, _>>();

    if metadata.is_empty() {
        return Ok(metadata);
    }

    let artifact_rows: Vec<(String, String, Option<i64>, Option<String>)> = sqlx::query_as(
        "
        SELECT asset_id::text,
               object_key,
               duration_ms,
               resolution_tier
        FROM rend.artifacts
        WHERE asset_id::text = ANY($1::text[])
        ",
    )
    .bind(&asset_ids)
    .fetch_all(db)
    .await
    .map_err(AppError::internal)?;

    for (asset_id, object_key, duration_ms, resolution_tier) in artifact_rows {
        let Some(asset_metadata) = metadata.get_mut(&asset_id) else {
            continue;
        };
        let prefix = format!("videos/{asset_id}/");
        let Some(artifact_path) = object_key.strip_prefix(&prefix) else {
            continue;
        };
        asset_metadata.artifacts.insert(
            artifact_path.to_owned(),
            ArtifactPlaybackBillingMetadata {
                duration_ms,
                resolution_tier,
            },
        );
    }

    Ok(metadata)
}

async fn fetch_player_event_organizations(
    db: &sqlx::PgPool,
    events: &[NormalizedPlayerTelemetryEvent],
) -> std::result::Result<HashMap<String, String>, AppError> {
    let mut asset_ids = events
        .iter()
        .map(|event| event.asset_id.clone())
        .collect::<Vec<_>>();
    asset_ids.sort();
    asset_ids.dedup();
    if asset_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows: Vec<(String, String)> = sqlx::query_as(
        "
        SELECT id::text,
               organization_id::text
        FROM rend.assets
        WHERE id::text = ANY($1::text[])
          AND deleted_at IS NULL
        ",
    )
    .bind(&asset_ids)
    .fetch_all(db)
    .await
    .map_err(AppError::internal)?;

    Ok(rows.into_iter().collect())
}

impl NormalizedPlaybackTelemetryEvent {
    fn into_clickhouse_row(
        self,
        ingested_at: DateTime<Utc>,
        billing_metadata: &HashMap<String, AssetPlaybackBillingMetadata>,
    ) -> ClickHousePlaybackEventRow {
        let metadata = billing_metadata.get(&self.asset_id);
        let artifact_metadata = metadata.and_then(|value| value.artifacts.get(&self.artifact_path));
        let organization_id = metadata.and_then(|value| value.organization_id.clone());
        let resolution_tier = artifact_metadata
            .and_then(|value| value.resolution_tier.clone())
            .or_else(|| metadata.and_then(|value| value.max_resolution_tier.clone()));
        let delivered_duration_ms = if (200..400).contains(&self.status_code) {
            artifact_metadata
                .and_then(|value| value.duration_ms)
                .or_else(|| fallback_delivered_duration_ms(&self.artifact_path, metadata))
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0)
        } else {
            0
        };

        ClickHousePlaybackEventRow {
            event_id: self.event_id,
            observed_at: clickhouse_datetime(self.observed_at),
            ingested_at: clickhouse_datetime(ingested_at),
            asset_id: self.asset_id,
            organization_id,
            artifact_path: self.artifact_path,
            edge_id: self.edge_id,
            region: self.region,
            cache_status: self.cache_status,
            status_code: self.status_code,
            bytes_served: self.bytes_served,
            content_type: self.content_type,
            duration_ms: self.duration_ms,
            delivered_duration_ms,
            resolution_tier,
            error_code: self.error_code,
        }
    }
}

impl NormalizedPlayerTelemetryEvent {
    fn into_clickhouse_row(
        self,
        received_at: DateTime<Utc>,
        organizations: &HashMap<String, String>,
    ) -> Option<ClickHousePlayerEventRow> {
        let organization_id = organizations.get(&self.asset_id)?.clone();

        Some(ClickHousePlayerEventRow {
            event_id: self.event_id,
            observed_at: clickhouse_datetime(self.observed_at),
            received_at: clickhouse_datetime(received_at),
            organization_id,
            asset_id: self.asset_id,
            playback_session_id: self.playback_session_id,
            phase: self.phase,
            selected_playback_mode: self.selected_playback_mode,
            selected_artifact_path: self.selected_artifact_path,
            first_frame_ms: self.first_frame_ms,
            bootstrap_duration_ms: self.bootstrap_duration_ms,
            bootstrap_http_status: self.bootstrap_http_status,
            stall_duration_ms: self.stall_duration_ms,
            watch_delta_ms: self.watch_delta_ms,
            playback_failure_code: self.playback_failure_code,
            edge_label: self.edge_label,
            region_label: self.region_label,
            player_version: self.player_version,
            app_version: self.app_version,
        })
    }
}

fn fallback_delivered_duration_ms(
    artifact_path: &str,
    metadata: Option<&AssetPlaybackBillingMetadata>,
) -> Option<i64> {
    if !is_asset_playback_path(artifact_path) {
        return None;
    }

    match artifact_path.split('/').collect::<Vec<_>>().as_slice() {
        ["opener.mp4"] => metadata
            .and_then(|value| value.duration_ms)
            .map(|duration_ms| duration_ms.min(5_000)),
        ["hls", "master.m3u8"] => Some(0),
        ["hls", _, "index.m3u8"] => Some(0),
        ["hls", _] | ["hls", _, _] => Some(2_000),
        _ => None,
    }
}

async fn insert_clickhouse_playback_events(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    rows: &[ClickHousePlaybackEventRow],
) -> std::result::Result<(), AppError> {
    let mut body = String::new();
    for row in rows {
        body.push_str(&serde_json::to_string(row).map_err(AppError::internal)?);
        body.push('\n');
    }

    let query = "\
        INSERT INTO playback_events \
        (event_id, observed_at, ingested_at, asset_id, organization_id, artifact_path, edge_id, region, cache_status, status_code, bytes_served, content_type, duration_ms, delivered_duration_ms, resolution_tier, error_code) \
        FORMAT JSONEachRow";

    clickhouse_post(http, config, query, body).await.map(|_| ())
}

async fn insert_clickhouse_player_events(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    rows: &[ClickHousePlayerEventRow],
) -> std::result::Result<(), AppError> {
    let mut body = String::new();
    for row in rows {
        body.push_str(&serde_json::to_string(row).map_err(AppError::internal)?);
        body.push('\n');
    }

    let query = "\
        INSERT INTO player_events \
        (event_id, observed_at, received_at, organization_id, asset_id, playback_session_id, phase, selected_playback_mode, selected_artifact_path, first_frame_ms, bootstrap_duration_ms, bootstrap_http_status, stall_duration_ms, watch_delta_ms, playback_failure_code, edge_label, region_label, player_version, app_version) \
        FORMAT JSONEachRow";

    clickhouse_post(http, config, query, body).await.map(|_| ())
}

async fn query_clickhouse_playback_analytics(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    asset_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> std::result::Result<Vec<ClickHouseAnalyticsRow>, AppError> {
    let query = clickhouse_playback_analytics_query(asset_id, window);
    let text = clickhouse_post(http, config, &query, String::new()).await?;
    let mut rows = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        rows.push(serde_json::from_str(line).map_err(AppError::internal)?);
    }
    Ok(rows)
}

async fn query_clickhouse_edge_overview(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> std::result::Result<ClickHouseEdgeOverviewRow, AppError> {
    let query = clickhouse_edge_overview_query(organization_id, window);
    query_clickhouse_single(http, config, &query).await
}

async fn query_clickhouse_player_overview(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> std::result::Result<ClickHousePlayerOverviewRow, AppError> {
    let query = clickhouse_player_overview_query(organization_id, window);
    query_clickhouse_single(http, config, &query).await
}

async fn query_clickhouse_analytics_series(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> std::result::Result<Vec<ClickHouseAnalyticsSeriesRow>, AppError> {
    let query = clickhouse_analytics_series_query(organization_id, window);
    query_clickhouse_rows(http, config, &query).await
}

async fn query_clickhouse_analytics_top_assets(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> std::result::Result<Vec<ClickHouseAnalyticsAssetRow>, AppError> {
    let query = clickhouse_analytics_top_assets_query(organization_id, window);
    query_clickhouse_rows(http, config, &query).await
}

async fn query_clickhouse_single<T: for<'de> Deserialize<'de>>(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    query: &str,
) -> std::result::Result<T, AppError> {
    let rows = query_clickhouse_rows(http, config, query).await?;
    rows.into_iter()
        .next()
        .ok_or_else(|| service_unavailable("ClickHouse returned no analytics rows"))
}

async fn query_clickhouse_rows<T: for<'de> Deserialize<'de>>(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    query: &str,
) -> std::result::Result<Vec<T>, AppError> {
    let text = clickhouse_post(http, config, query, String::new()).await?;
    let mut rows = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        rows.push(serde_json::from_str(line).map_err(AppError::internal)?);
    }
    Ok(rows)
}

async fn clickhouse_post(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    query: &str,
    body: String,
) -> std::result::Result<String, AppError> {
    let response = http
        .post(&config.clickhouse_url)
        .basic_auth(&config.clickhouse_user, Some(&config.clickhouse_password))
        .header(reqwest::header::CONTENT_LENGTH, body.len().to_string())
        .query(&[
            ("database", config.clickhouse_database.as_str()),
            ("query", query),
            ("date_time_input_format", "best_effort"),
            ("output_format_json_quote_64bit_integers", "0"),
        ])
        .body(body)
        .send()
        .await
        .map_err(|error| service_unavailable(format!("ClickHouse request failed: {error}")))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(service_unavailable(format!(
            "ClickHouse returned HTTP {status}: {}",
            truncate_for_error(&text)
        )));
    }

    Ok(text)
}

fn clickhouse_playback_analytics_query(
    asset_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> String {
    format!(
        "\
        SELECT \
          cache_status, \
          status_code, \
          count() AS request_count, \
          sum(bytes_served) AS bytes_served, \
          toUnixTimestamp64Milli(min(event_observed_at)) AS first_seen_ms, \
          toUnixTimestamp64Milli(max(event_observed_at)) AS last_seen_ms \
        FROM ( \
          SELECT \
            event_id, \
            any(cache_status) AS cache_status, \
            any(status_code) AS status_code, \
            any(bytes_served) AS bytes_served, \
            min(observed_at) AS event_observed_at \
          FROM playback_events \
          WHERE asset_id = toUUID('{asset_id}') \
            AND observed_at >= fromUnixTimestamp64Milli({}) \
            AND observed_at < fromUnixTimestamp64Milli({}) \
          GROUP BY event_id \
        ) \
        GROUP BY cache_status, status_code \
        FORMAT JSONEachRow",
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
    )
}

fn clickhouse_edge_rollup_refresh_query(window: NormalizedPlaybackAnalyticsWindow) -> String {
    format!(
        "\
        INSERT INTO analytics_edge_hourly \
        SELECT \
          rollup_organization_id AS organization_id, \
          toStartOfHour(event_observed_at) AS bucket_start, \
          rollup_asset_id AS asset_id, \
          count() AS request_count, \
          sum(bytes_served) AS bytes_served, \
          countIf(cache_status = 'HIT') AS cache_hit_count, \
          countIf(status_code >= 500 OR error_code != '') AS error_count, \
          quantileTDigest(0.5)(duration_ms) AS request_duration_p50_ms, \
          quantileTDigest(0.95)(duration_ms) AS request_duration_p95_ms, \
          now64(3) AS updated_at \
        FROM ( \
          SELECT \
            event_id, \
            assumeNotNull(any(organization_id)) AS rollup_organization_id, \
            any(asset_id) AS rollup_asset_id, \
            min(observed_at) AS event_observed_at, \
            any(bytes_served) AS bytes_served, \
            any(cache_status) AS cache_status, \
            any(status_code) AS status_code, \
            any(duration_ms) AS duration_ms, \
            ifNull(any(error_code), '') AS error_code \
          FROM playback_events \
          WHERE organization_id IS NOT NULL \
            AND observed_at >= fromUnixTimestamp64Milli({}) \
            AND observed_at < fromUnixTimestamp64Milli({}) \
          GROUP BY event_id \
        ) \
        GROUP BY rollup_organization_id, bucket_start, rollup_asset_id",
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
    )
}

fn clickhouse_player_rollup_refresh_query(window: NormalizedPlaybackAnalyticsWindow) -> String {
    format!(
        "\
        INSERT INTO analytics_player_hourly \
        SELECT \
          rollup_organization_id AS organization_id, \
          bucket_start, \
          rollup_asset_id AS asset_id, \
          count() AS sessions, \
          countIf(reached_first_frame) AS views, \
          countIf(startup_failed) AS startup_failures, \
          sum(session_watch_time_ms) AS watch_time_ms, \
          countIf(session_stall_duration_ms > 0) AS stalled_sessions, \
          sum(session_stall_count) AS stall_count, \
          sum(session_stall_duration_ms) AS stall_duration_ms, \
          sum(session_playback_failures) AS playback_failures, \
          quantileTDigestIf(0.5)(first_frame_ms, first_frame_ms > 0) AS first_frame_p50_ms, \
          quantileTDigestIf(0.95)(first_frame_ms, first_frame_ms > 0) AS first_frame_p95_ms, \
          now64(3) AS updated_at \
        FROM ( \
          SELECT \
            rollup_organization_id, \
            rollup_asset_id, \
            rollup_playback_session_id, \
            toStartOfHour(min(event_observed_at)) AS bucket_start, \
            countIf(phase = 'first_frame') > 0 AS reached_first_frame, \
            countIf(phase = 'bootstrap_failure') > 0 AS startup_failed, \
            minIf(first_frame_ms, phase = 'first_frame' AND first_frame_ms > 0) AS first_frame_ms, \
            sumIf(watch_delta_ms, phase = 'watch_heartbeat') AS session_watch_time_ms, \
            countIf(phase = 'stall_end') AS session_stall_count, \
            sumIf(stall_duration_ms, phase = 'stall_end') AS session_stall_duration_ms, \
            countIf(phase = 'playback_failure') AS session_playback_failures \
          FROM ( \
            SELECT \
              event_id, \
              any(organization_id) AS rollup_organization_id, \
              any(asset_id) AS rollup_asset_id, \
              any(playback_session_id) AS rollup_playback_session_id, \
              min(observed_at) AS event_observed_at, \
              any(phase) AS phase, \
              any(first_frame_ms) AS first_frame_ms, \
              any(stall_duration_ms) AS stall_duration_ms, \
              any(watch_delta_ms) AS watch_delta_ms \
            FROM player_events \
            WHERE observed_at >= fromUnixTimestamp64Milli({}) \
              AND observed_at < fromUnixTimestamp64Milli({}) \
            GROUP BY event_id \
          ) \
          GROUP BY rollup_organization_id, rollup_asset_id, rollup_playback_session_id \
        ) \
        GROUP BY rollup_organization_id, bucket_start, rollup_asset_id",
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
    )
}

fn clickhouse_edge_overview_query(
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> String {
    format!(
        "\
        SELECT \
          ifNull(sum(edge_rollups.request_count), 0) AS request_count, \
          ifNull(sum(edge_rollups.bytes_served), 0) AS bytes_served, \
          ifNull(sum(edge_rollups.cache_hit_count), 0) AS cache_hit_count, \
          ifNull(sum(edge_rollups.error_count), 0) AS error_count, \
          if(isFinite(avgIf(edge_rollups.request_duration_p50_ms, edge_rollups.request_count > 0)), avgIf(edge_rollups.request_duration_p50_ms, edge_rollups.request_count > 0), 0) AS request_duration_p50_ms, \
          if(isFinite(avgIf(edge_rollups.request_duration_p95_ms, edge_rollups.request_count > 0)), avgIf(edge_rollups.request_duration_p95_ms, edge_rollups.request_count > 0), 0) AS request_duration_p95_ms \
        FROM ( \
          SELECT \
            bucket_start, \
            asset_id, \
            argMax(request_count, updated_at) AS request_count, \
            argMax(bytes_served, updated_at) AS bytes_served, \
            argMax(cache_hit_count, updated_at) AS cache_hit_count, \
            argMax(error_count, updated_at) AS error_count, \
            argMax(request_duration_p50_ms, updated_at) AS request_duration_p50_ms, \
            argMax(request_duration_p95_ms, updated_at) AS request_duration_p95_ms \
          FROM analytics_edge_hourly \
          WHERE organization_id = toUUID('{organization_id}') \
            AND bucket_start >= fromUnixTimestamp64Milli({}) \
            AND bucket_start < fromUnixTimestamp64Milli({}) \
          GROUP BY bucket_start, asset_id \
        ) AS edge_rollups \
        FORMAT JSONEachRow",
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
    )
}

fn clickhouse_player_overview_query(
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> String {
    format!(
        "\
        SELECT \
          ifNull(sum(player_rollups.sessions), 0) AS sessions, \
          ifNull(sum(player_rollups.views), 0) AS views, \
          ifNull(sum(player_rollups.startup_failures), 0) AS startup_failures, \
          ifNull(sum(player_rollups.watch_time_ms), 0) AS watch_time_ms, \
          ifNull(sum(player_rollups.stalled_sessions), 0) AS stalled_sessions, \
          ifNull(sum(player_rollups.stall_count), 0) AS stall_count, \
          ifNull(sum(player_rollups.stall_duration_ms), 0) AS stall_duration_ms, \
          ifNull(sum(player_rollups.playback_failures), 0) AS playback_failures, \
          if(isFinite(avgIf(player_rollups.first_frame_p50_ms, player_rollups.views > 0)), avgIf(player_rollups.first_frame_p50_ms, player_rollups.views > 0), 0) AS first_frame_p50_ms, \
          if(isFinite(avgIf(player_rollups.first_frame_p95_ms, player_rollups.views > 0)), avgIf(player_rollups.first_frame_p95_ms, player_rollups.views > 0), 0) AS first_frame_p95_ms \
        FROM ( \
          SELECT \
            bucket_start, \
            asset_id, \
            argMax(sessions, updated_at) AS sessions, \
            argMax(views, updated_at) AS views, \
            argMax(startup_failures, updated_at) AS startup_failures, \
            argMax(watch_time_ms, updated_at) AS watch_time_ms, \
            argMax(stalled_sessions, updated_at) AS stalled_sessions, \
            argMax(stall_count, updated_at) AS stall_count, \
            argMax(stall_duration_ms, updated_at) AS stall_duration_ms, \
            argMax(playback_failures, updated_at) AS playback_failures, \
            argMax(first_frame_p50_ms, updated_at) AS first_frame_p50_ms, \
            argMax(first_frame_p95_ms, updated_at) AS first_frame_p95_ms \
          FROM analytics_player_hourly \
          WHERE organization_id = toUUID('{organization_id}') \
            AND bucket_start >= fromUnixTimestamp64Milli({}) \
            AND bucket_start < fromUnixTimestamp64Milli({}) \
          GROUP BY bucket_start, asset_id \
        ) AS player_rollups \
        FORMAT JSONEachRow",
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
    )
}

fn clickhouse_analytics_series_query(
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> String {
    format!(
        "\
        SELECT \
          toUnixTimestamp64Milli(bucket_start) AS bucket_start_ms, \
          ifNull(sum(views), 0) AS views, \
          ifNull(sum(watch_time_ms), 0) AS watch_time_ms, \
          ifNull(sum(request_count), 0) AS request_count, \
          ifNull(sum(bytes_served), 0) AS bytes_served \
        FROM ( \
          SELECT bucket_start, 0 AS views, 0 AS watch_time_ms, request_count, bytes_served \
          FROM ( \
            SELECT bucket_start, asset_id, argMax(request_count, updated_at) AS request_count, argMax(bytes_served, updated_at) AS bytes_served \
            FROM analytics_edge_hourly \
            WHERE organization_id = toUUID('{organization_id}') \
              AND bucket_start >= fromUnixTimestamp64Milli({}) \
              AND bucket_start < fromUnixTimestamp64Milli({}) \
            GROUP BY bucket_start, asset_id \
          ) \
          UNION ALL \
          SELECT bucket_start, views, watch_time_ms, 0 AS request_count, 0 AS bytes_served \
          FROM ( \
            SELECT bucket_start, asset_id, argMax(views, updated_at) AS views, argMax(watch_time_ms, updated_at) AS watch_time_ms \
            FROM analytics_player_hourly \
            WHERE organization_id = toUUID('{organization_id}') \
              AND bucket_start >= fromUnixTimestamp64Milli({}) \
              AND bucket_start < fromUnixTimestamp64Milli({}) \
            GROUP BY bucket_start, asset_id \
          ) \
        ) \
        GROUP BY bucket_start \
        ORDER BY bucket_start \
        FORMAT JSONEachRow",
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
    )
}

fn clickhouse_analytics_top_assets_query(
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> String {
    format!(
        "\
        SELECT \
          toString(asset_id) AS asset_id, \
          ifNull(sum(views), 0) AS views, \
          ifNull(sum(watch_time_ms), 0) AS watch_time_ms, \
          ifNull(sum(request_count), 0) AS request_count, \
          ifNull(sum(bytes_served), 0) AS bytes_served \
        FROM ( \
          SELECT asset_id, 0 AS views, 0 AS watch_time_ms, request_count, bytes_served \
          FROM ( \
            SELECT asset_id, bucket_start, argMax(request_count, updated_at) AS request_count, argMax(bytes_served, updated_at) AS bytes_served \
            FROM analytics_edge_hourly \
            WHERE organization_id = toUUID('{organization_id}') \
              AND bucket_start >= fromUnixTimestamp64Milli({}) \
              AND bucket_start < fromUnixTimestamp64Milli({}) \
            GROUP BY asset_id, bucket_start \
          ) \
          UNION ALL \
          SELECT asset_id, views, watch_time_ms, 0 AS request_count, 0 AS bytes_served \
          FROM ( \
            SELECT asset_id, bucket_start, argMax(views, updated_at) AS views, argMax(watch_time_ms, updated_at) AS watch_time_ms \
            FROM analytics_player_hourly \
            WHERE organization_id = toUUID('{organization_id}') \
              AND bucket_start >= fromUnixTimestamp64Milli({}) \
              AND bucket_start < fromUnixTimestamp64Milli({}) \
            GROUP BY asset_id, bucket_start \
          ) \
        ) \
        GROUP BY asset_id \
        ORDER BY views DESC, watch_time_ms DESC, request_count DESC \
        LIMIT 10 \
        FORMAT JSONEachRow",
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
    )
}

pub(crate) fn normalize_playback_analytics_window(
    query: PlaybackAnalyticsQuery,
    config: &TelemetryConfig,
    now: DateTime<Utc>,
) -> std::result::Result<NormalizedPlaybackAnalyticsWindow, AppError> {
    let window_seconds = query
        .window_seconds
        .unwrap_or(config.default_analytics_window_secs)
        .clamp(1, config.max_analytics_window_secs);
    let duration = ChronoDuration::seconds(
        i64::try_from(window_seconds).map_err(|_| AppError::bad_request("window is too large"))?,
    );
    Ok(NormalizedPlaybackAnalyticsWindow {
        started_at: now - duration,
        ended_at: now,
    })
}

fn normalize_overview_window(
    query: AnalyticsOverviewQuery,
    now: DateTime<Utc>,
) -> std::result::Result<NormalizedPlaybackAnalyticsWindow, AppError> {
    let window_seconds = query
        .window_seconds
        .unwrap_or(DEFAULT_OVERVIEW_WINDOW_SECS)
        .clamp(60, MAX_OVERVIEW_WINDOW_SECS);
    let duration = ChronoDuration::seconds(
        i64::try_from(window_seconds).map_err(|_| AppError::bad_request("window is too large"))?,
    );
    Ok(NormalizedPlaybackAnalyticsWindow {
        started_at: now - duration,
        ended_at: now,
    })
}

fn playback_analytics_response(
    asset_id: String,
    window: NormalizedPlaybackAnalyticsWindow,
    rows: Vec<ClickHouseAnalyticsRow>,
) -> PlaybackAnalyticsResponse {
    let mut request_count = 0_u64;
    let mut bytes_served = 0_u64;
    let mut cache_status_counts = BTreeMap::new();
    let mut status_code_counts = BTreeMap::new();
    let mut first_seen_ms: Option<i64> = None;
    let mut last_seen_ms: Option<i64> = None;

    for row in rows {
        request_count = request_count.saturating_add(row.request_count);
        bytes_served = bytes_served.saturating_add(row.bytes_served);
        *cache_status_counts.entry(row.cache_status).or_insert(0) += row.request_count;
        *status_code_counts
            .entry(row.status_code.to_string())
            .or_insert(0) += row.request_count;
        first_seen_ms =
            Some(first_seen_ms.map_or(row.first_seen_ms, |seen| seen.min(row.first_seen_ms)));
        last_seen_ms =
            Some(last_seen_ms.map_or(row.last_seen_ms, |seen| seen.max(row.last_seen_ms)));
    }

    PlaybackAnalyticsResponse {
        asset_id,
        window_started_at: rfc3339_millis(window.started_at),
        window_ended_at: rfc3339_millis(window.ended_at),
        request_count,
        bytes_served,
        cache_status_counts,
        status_code_counts,
        first_seen: first_seen_ms.and_then(rfc3339_millis_from_unix_millis),
        last_seen: last_seen_ms.and_then(rfc3339_millis_from_unix_millis),
    }
}

fn analytics_overview_response(
    window: NormalizedPlaybackAnalyticsWindow,
    edge: ClickHouseEdgeOverviewRow,
    player: ClickHousePlayerOverviewRow,
    timeseries: Vec<ClickHouseAnalyticsSeriesRow>,
    top_assets: Vec<ClickHouseAnalyticsAssetRow>,
) -> AnalyticsOverviewResponse {
    let startup_attempts = player.views.saturating_add(player.startup_failures);
    let startup_success_rate = ratio(player.views, startup_attempts);
    let rebuffer_ratio = ratio(player.stalled_sessions, player.views);
    let cache_hit_rate = ratio(edge.cache_hit_count, edge.request_count);
    let error_rate = ratio(edge.error_count, edge.request_count);

    AnalyticsOverviewResponse {
        window_started_at: rfc3339_millis(window.started_at),
        window_ended_at: rfc3339_millis(window.ended_at),
        views: player.views,
        sessions: player.sessions,
        watch_time_ms: player.watch_time_ms,
        startup_success_rate,
        startup_p50_ms: nonzero_float(player.first_frame_p50_ms),
        startup_p95_ms: nonzero_float(player.first_frame_p95_ms),
        rebuffer_ratio,
        stalled_sessions: player.stalled_sessions,
        stall_count: player.stall_count,
        stall_duration_ms: player.stall_duration_ms,
        playback_failures: player.playback_failures,
        request_count: edge.request_count,
        bytes_served: edge.bytes_served,
        cache_hit_rate,
        error_rate,
        request_p50_ms: nonzero_float(edge.request_duration_p50_ms),
        request_p95_ms: nonzero_float(edge.request_duration_p95_ms),
        timeseries: timeseries
            .into_iter()
            .filter_map(|row| {
                Some(AnalyticsTimeSeriesPoint {
                    bucket_start: rfc3339_millis_from_unix_millis(row.bucket_start_ms)?,
                    views: row.views,
                    watch_time_ms: row.watch_time_ms,
                    request_count: row.request_count,
                    bytes_served: row.bytes_served,
                })
            })
            .collect(),
        top_assets: top_assets
            .into_iter()
            .map(|row| AnalyticsAssetSummary {
                asset_id: row.asset_id,
                views: row.views,
                watch_time_ms: row.watch_time_ms,
                request_count: row.request_count,
                bytes_served: row.bytes_served,
            })
            .collect(),
    }
}

fn ratio(numerator: u64, denominator: u64) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn nonzero_float(value: f64) -> Option<f64> {
    if value.is_finite() && value > 0.0 {
        Some(value)
    } else {
        None
    }
}

fn schedule_analytics_rollup_refresh(state: Arc<AppState>) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let previous = LAST_ANALYTICS_ROLLUP_ATTEMPT.load(Ordering::Relaxed);
    if now.saturating_sub(previous) < ANALYTICS_ROLLUP_THROTTLE_SECS {
        return;
    }
    if LAST_ANALYTICS_ROLLUP_ATTEMPT
        .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }

    tokio::spawn(async move {
        if let Err(error) = refresh_recent_analytics_rollups(state).await {
            tracing::warn!(?error, "analytics rollup refresh failed");
        }
    });
}

async fn refresh_recent_analytics_rollups(
    state: Arc<AppState>,
) -> std::result::Result<(), AppError> {
    let window = analytics_rollup_refresh_window(Utc::now());
    let edge_query = clickhouse_edge_rollup_refresh_query(window);
    let player_query = clickhouse_player_rollup_refresh_query(window);
    clickhouse_post(
        &state.http,
        &state.config.playback_telemetry,
        &edge_query,
        String::new(),
    )
    .await?;
    clickhouse_post(
        &state.http,
        &state.config.playback_telemetry,
        &player_query,
        String::new(),
    )
    .await?;
    Ok(())
}

fn analytics_rollup_refresh_window(now: DateTime<Utc>) -> NormalizedPlaybackAnalyticsWindow {
    let ended_at = now - ChronoDuration::seconds(ANALYTICS_ROLLUP_LAG_SECS);
    let lookback_started_at = ended_at - ChronoDuration::seconds(ANALYTICS_ROLLUP_LOOKBACK_SECS);
    NormalizedPlaybackAnalyticsWindow {
        started_at: floor_datetime_to_hour(lookback_started_at),
        ended_at,
    }
}

fn floor_datetime_to_hour(value: DateTime<Utc>) -> DateTime<Utc> {
    let timestamp = value.timestamp();
    let hour_start = timestamp - timestamp.rem_euclid(60 * 60);
    DateTime::<Utc>::from_timestamp(hour_start, 0).unwrap_or(value)
}

fn clickhouse_datetime(value: DateTime<Utc>) -> String {
    value.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

fn rfc3339_millis(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn rfc3339_millis_from_unix_millis(value: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value).map(rfc3339_millis)
}

fn service_unavailable(message: impl Into<String>) -> AppError {
    AppError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message: message.into(),
    }
}

fn truncate_for_error(value: &str) -> String {
    const LIMIT: usize = 512;
    if value.len() <= LIMIT {
        value.to_owned()
    } else {
        format!("{}...", &value[..LIMIT])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> TelemetryConfig {
        TelemetryConfig {
            clickhouse_url: "http://127.0.0.1:8123".to_owned(),
            clickhouse_database: "rend".to_owned(),
            clickhouse_user: "rend".to_owned(),
            clickhouse_password: "rend".to_owned(),
            internal_token: "internal".to_owned(),
            max_body_bytes: DEFAULT_TELEMETRY_MAX_BODY_BYTES,
            max_events_per_batch: 2,
            default_analytics_window_secs: 60,
            max_analytics_window_secs: 3600,
        }
    }

    fn event_json() -> serde_json::Value {
        serde_json::json!({
            "event_id": "evt-1",
            "observed_at": "2026-06-13T12:00:00.000Z",
            "asset_id": "00000000-0000-0000-0000-000000000001",
            "artifact_path": "hls/master.m3u8",
            "edge_id": "edge-1",
            "region": "local",
            "cache_status": "MISS",
            "status_code": 200,
            "bytes_served": 123,
            "content_type": "application/vnd.apple.mpegurl",
            "duration_ms": 12
        })
    }

    #[test]
    fn playback_telemetry_batch_rejects_unknown_secret_fields() {
        let mut event = event_json();
        event["authorization"] = serde_json::json!("Bearer secret");
        let payload = serde_json::json!({ "events": [event] });

        let error = serde_json::from_value::<PlaybackTelemetryBatch>(payload).unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn playback_telemetry_batch_validates_bounds_and_artifact_paths() {
        let batch = serde_json::from_value::<PlaybackTelemetryBatch>(serde_json::json!({
            "events": [event_json()]
        }))
        .unwrap();
        let normalized = normalize_playback_telemetry_batch(
            batch,
            2,
            DateTime::parse_from_rfc3339("2026-06-13T12:00:01.000Z")
                .unwrap()
                .with_timezone(&Utc),
        )
        .unwrap();
        assert_eq!(normalized[0].cache_status, "MISS");
        assert_eq!(normalized[0].artifact_path, "hls/master.m3u8");

        let mut event = event_json();
        event["artifact_path"] = serde_json::json!("hls/720p/segment_00000.ts");
        let batch = serde_json::from_value::<PlaybackTelemetryBatch>(serde_json::json!({
            "events": [event]
        }))
        .unwrap();
        let normalized = normalize_playback_telemetry_batch(
            batch,
            2,
            DateTime::parse_from_rfc3339("2026-06-13T12:00:01.000Z")
                .unwrap()
                .with_timezone(&Utc),
        )
        .unwrap();
        assert_eq!(normalized[0].artifact_path, "hls/720p/segment_00000.ts");

        let mut event = event_json();
        event["artifact_path"] = serde_json::json!("hls/../secret");
        let batch = serde_json::from_value::<PlaybackTelemetryBatch>(serde_json::json!({
            "events": [event]
        }))
        .unwrap();
        let error = normalize_playback_telemetry_batch(
            batch,
            2,
            DateTime::parse_from_rfc3339("2026-06-13T12:00:01.000Z")
                .unwrap()
                .with_timezone(&Utc),
        )
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn playback_analytics_query_dedupes_by_event_id() {
        let now = DateTime::parse_from_rfc3339("2026-06-13T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let window = normalize_playback_analytics_window(
            PlaybackAnalyticsQuery {
                window_seconds: Some(60),
            },
            &test_config(),
            now,
        )
        .unwrap();
        let query =
            clickhouse_playback_analytics_query("00000000-0000-0000-0000-000000000001", window);

        assert!(query.contains("GROUP BY event_id"));
        assert!(query.contains("FORMAT JSONEachRow"));
    }

    #[test]
    fn overview_queries_do_not_reuse_aggregate_aliases_in_avgif_conditions() {
        let window = NormalizedPlaybackAnalyticsWindow {
            started_at: DateTime::parse_from_rfc3339("2026-06-13T11:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
            ended_at: DateTime::parse_from_rfc3339("2026-06-13T12:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
        };

        let edge_query =
            clickhouse_edge_overview_query("00000000-0000-0000-0000-000000000001", window);
        assert!(edge_query.contains("AS edge_rollups"));
        assert!(edge_query.contains(
            "avgIf(edge_rollups.request_duration_p50_ms, edge_rollups.request_count > 0)"
        ));
        assert!(edge_query.contains(
            "avgIf(edge_rollups.request_duration_p95_ms, edge_rollups.request_count > 0)"
        ));

        let player_query =
            clickhouse_player_overview_query("00000000-0000-0000-0000-000000000001", window);
        assert!(player_query.contains("AS player_rollups"));
        assert!(
            player_query
                .contains("avgIf(player_rollups.first_frame_p50_ms, player_rollups.views > 0)")
        );
        assert!(
            player_query
                .contains("avgIf(player_rollups.first_frame_p95_ms, player_rollups.views > 0)")
        );
    }

    #[test]
    fn rollup_queries_do_not_reuse_source_column_names_for_aggregates() {
        let window = NormalizedPlaybackAnalyticsWindow {
            started_at: DateTime::parse_from_rfc3339("2026-06-13T11:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
            ended_at: DateTime::parse_from_rfc3339("2026-06-13T12:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
        };

        let edge_query = clickhouse_edge_rollup_refresh_query(window);
        assert!(edge_query.contains("rollup_organization_id AS organization_id"));
        assert!(edge_query.contains("rollup_asset_id AS asset_id"));
        assert!(
            edge_query.contains("GROUP BY rollup_organization_id, bucket_start, rollup_asset_id")
        );

        let player_query = clickhouse_player_rollup_refresh_query(window);
        assert!(player_query.contains("rollup_organization_id AS organization_id"));
        assert!(player_query.contains("rollup_asset_id AS asset_id"));
        assert!(player_query.contains("min(observed_at) AS event_observed_at"));
        assert!(player_query.contains("sum(session_watch_time_ms) AS watch_time_ms"));
        assert!(player_query.contains("countIf(session_stall_duration_ms > 0)"));
        assert!(player_query.contains("sum(session_playback_failures) AS playback_failures"));
        assert!(player_query.contains(
            "GROUP BY rollup_organization_id, rollup_asset_id, rollup_playback_session_id"
        ));
    }

    #[test]
    fn rollup_refresh_window_starts_on_full_hour() {
        let now = DateTime::parse_from_rfc3339("2026-06-24T13:53:47.991Z")
            .unwrap()
            .with_timezone(&Utc);
        let window = analytics_rollup_refresh_window(now);

        assert_eq!(
            window.started_at,
            DateTime::parse_from_rfc3339("2026-06-24T11:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc)
        );
        assert_eq!(
            window.ended_at,
            DateTime::parse_from_rfc3339("2026-06-24T13:52:47.991Z")
                .unwrap()
                .with_timezone(&Utc)
        );
    }

    #[test]
    fn clickhouse_rows_use_artifact_billing_metadata_for_delivery() {
        let ingested_at = DateTime::parse_from_rfc3339("2026-06-13T12:00:01.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let batch = serde_json::from_value::<PlaybackTelemetryBatch>(serde_json::json!({
            "events": [{
                "event_id": "evt-1",
                "observed_at": "2026-06-13T12:00:00.000Z",
                "asset_id": "00000000-0000-0000-0000-000000000001",
                "artifact_path": "hls/segment_00000.ts",
                "edge_id": "edge-1",
                "region": "local",
                "cache_status": "HIT",
                "status_code": 200,
                "bytes_served": 123,
                "content_type": "video/mp2t",
                "duration_ms": 9
            }]
        }))
        .unwrap();
        let event = normalize_playback_telemetry_batch(batch, 2, ingested_at)
            .unwrap()
            .remove(0);
        let mut asset = AssetPlaybackBillingMetadata {
            organization_id: Some("00000000-0000-0000-0000-000000000009".to_owned()),
            duration_ms: Some(12_000),
            max_resolution_tier: Some("1080p".to_owned()),
            artifacts: HashMap::new(),
        };
        asset.artifacts.insert(
            "hls/segment_00000.ts".to_owned(),
            ArtifactPlaybackBillingMetadata {
                duration_ms: Some(1_234),
                resolution_tier: Some("720p".to_owned()),
            },
        );
        let metadata = HashMap::from([("00000000-0000-0000-0000-000000000001".to_owned(), asset)]);

        let row = event.into_clickhouse_row(ingested_at, &metadata);

        assert_eq!(row.duration_ms, 9);
        assert_eq!(row.delivered_duration_ms, 1_234);
        assert_eq!(row.resolution_tier.as_deref(), Some("720p"));
        assert_eq!(
            row.organization_id.as_deref(),
            Some("00000000-0000-0000-0000-000000000009")
        );
    }

    #[test]
    fn playback_analytics_response_folds_bounded_rows() {
        let window = NormalizedPlaybackAnalyticsWindow {
            started_at: DateTime::parse_from_rfc3339("2026-06-13T11:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
            ended_at: DateTime::parse_from_rfc3339("2026-06-13T12:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
        };
        let response = playback_analytics_response(
            "00000000-0000-0000-0000-000000000001".to_owned(),
            window,
            vec![
                ClickHouseAnalyticsRow {
                    cache_status: "MISS".to_owned(),
                    status_code: 200,
                    request_count: 1,
                    bytes_served: 10,
                    first_seen_ms: 1_800_000_000_000,
                    last_seen_ms: 1_800_000_000_000,
                },
                ClickHouseAnalyticsRow {
                    cache_status: "HIT".to_owned(),
                    status_code: 200,
                    request_count: 2,
                    bytes_served: 20,
                    first_seen_ms: 1_800_000_001_000,
                    last_seen_ms: 1_800_000_002_000,
                },
            ],
        );

        assert_eq!(response.request_count, 3);
        assert_eq!(response.bytes_served, 30);
        assert_eq!(response.cache_status_counts["MISS"], 1);
        assert_eq!(response.cache_status_counts["HIT"], 2);
        assert_eq!(response.status_code_counts["200"], 3);
        assert_eq!(
            response.first_seen.as_deref(),
            Some("2027-01-15T08:00:00.000Z")
        );
    }
}
