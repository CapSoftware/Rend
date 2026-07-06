use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
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
const ANALYTICS_ROLLUP_CATCHUP_BUFFER_SECS: u64 = 5;
const DEFAULT_OVERVIEW_WINDOW_SECS: u64 = 24 * 60 * 60;
const MAX_OVERVIEW_WINDOW_SECS: u64 = 90 * 24 * 60 * 60;
const DEFAULT_LIVE_WINDOW_SECS: u64 = 60 * 60;
const MAX_LIVE_WINDOW_SECS: u64 = 60 * 60;
const LIVE_ACTIVE_SESSION_LOOKBACK_SECS: u64 = 5 * 60;
const LIVE_RECENT_ASSET_LOOKBACK_SECS: u64 = 5 * 60;
const PLAYER_WATCH_DELTA_MAX_MS: u32 = 60_000;
const NIL_ORGANIZATION_ID: &str = "00000000-0000-0000-0000-000000000000";

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
    resolution_tier: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NormalizedPlaybackTelemetryEvent {
    event_id: String,
    observed_at: DateTime<Utc>,
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
    resolution_tier: Option<String>,
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
pub(crate) struct AnalyticsLiveQuery {
    window_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PlayerTelemetryBatch {
    events: Vec<PlayerTelemetryEventInput>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PlayerTelemetryEventInput {
    #[serde(default)]
    event_id: Option<String>,
    #[serde(default)]
    organization_id: Option<String>,
    playback_session_id: String,
    asset_id: String,
    phase: String,
    event_time_ms: i64,
    #[serde(default)]
    bootstrap_start_ms: Option<u32>,
    #[serde(default)]
    bootstrap_end_ms: Option<u32>,
    #[serde(default)]
    viewer_id_hash: Option<String>,
    #[serde(default)]
    page_type: Option<String>,
    #[serde(default)]
    page_host: Option<String>,
    #[serde(default)]
    referrer_host: Option<String>,
    #[serde(default)]
    player_name: Option<String>,
    #[serde(default)]
    selected_playback_mode: Option<String>,
    #[serde(default)]
    selected_artifact_path: Option<String>,
    #[serde(default)]
    previous_playback_mode: Option<String>,
    #[serde(default)]
    previous_artifact_path: Option<String>,
    #[serde(default)]
    selected_width: Option<u32>,
    #[serde(default)]
    selected_height: Option<u32>,
    #[serde(default)]
    selected_bitrate: Option<u32>,
    #[serde(default)]
    hls_level_index: Option<u32>,
    #[serde(default)]
    hls_fragment_index: Option<u32>,
    #[serde(default)]
    hls_fragment_duration_ms: Option<u32>,
    #[serde(default)]
    hls_fragment_load_ms: Option<u32>,
    #[serde(default)]
    first_frame_ms: Option<u32>,
    #[serde(default)]
    bootstrap_duration_ms: Option<u32>,
    #[serde(default)]
    bootstrap_http_status: Option<u16>,
    #[serde(default)]
    stall_reason: Option<String>,
    #[serde(default)]
    stall_start_ms: Option<u32>,
    #[serde(default)]
    stall_end_ms: Option<u32>,
    #[serde(default)]
    stall_duration_ms: Option<u32>,
    #[serde(default)]
    watch_delta_ms: Option<u32>,
    #[serde(default)]
    metadata_loaded_ms: Option<u32>,
    #[serde(default)]
    canplay_ms: Option<u32>,
    #[serde(default)]
    playback_failure_code: Option<String>,
    #[serde(default)]
    playback_failure_reason: Option<String>,
    #[serde(default)]
    cache_headers: Option<BTreeMap<String, String>>,
    #[serde(default)]
    edge_label: Option<String>,
    #[serde(default)]
    region_label: Option<String>,
    #[serde(default)]
    player_version: Option<String>,
    #[serde(default)]
    app_version: Option<String>,
    #[serde(default)]
    browser_name: Option<String>,
    #[serde(default)]
    browser_version: Option<String>,
    #[serde(default)]
    os_name: Option<String>,
    #[serde(default)]
    os_version: Option<String>,
    #[serde(default)]
    device_type: Option<String>,
    #[serde(default)]
    autoplay: Option<bool>,
    #[serde(default)]
    muted: Option<bool>,
    #[serde(default)]
    preload: Option<String>,
    #[serde(default)]
    startup_mode: Option<String>,
    #[serde(default)]
    geo_country: Option<String>,
    #[serde(default)]
    geo_region: Option<String>,
    #[serde(default)]
    geo_city: Option<String>,
    #[serde(default)]
    geo_continent: Option<String>,
    #[serde(default)]
    geo_asn: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    utm_source: Option<String>,
    #[serde(default)]
    utm_medium: Option<String>,
    #[serde(default)]
    utm_campaign: Option<String>,
    #[serde(default)]
    utm_term: Option<String>,
    #[serde(default)]
    utm_content: Option<String>,
    #[serde(default)]
    document_start_ms: Option<u32>,
    #[serde(default)]
    video_created_ms: Option<u32>,
    #[serde(default)]
    src_assigned_ms: Option<u32>,
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
    unique_viewers: u64,
    startup_failures: u64,
    exits_before_start: u64,
    watch_time_ms: u64,
    stalled_sessions: u64,
    stall_count: u64,
    stall_duration_ms: u64,
    playback_failures: u64,
    completions: u64,
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

#[derive(Debug, Deserialize)]
struct ClickHouseAnalyticsBreakdownRow {
    dimension: String,
    value: String,
    views: u64,
    unique_viewers: u64,
    watch_time_ms: u64,
    request_count: u64,
    bytes_served: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NormalizedPlayerTelemetryEvent {
    event_id: String,
    observed_at: DateTime<Utc>,
    organization_id: String,
    asset_id: String,
    playback_session_id: String,
    viewer_id_hash: String,
    page_type: String,
    page_host: String,
    referrer_host: String,
    player_name: String,
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
    browser_name: String,
    browser_version: String,
    os_name: String,
    os_version: String,
    device_type: String,
    autoplay: u8,
    muted: u8,
    preload: String,
    startup_mode: String,
    geo_country: String,
    geo_region: String,
    geo_city: String,
    geo_continent: String,
    geo_asn: String,
    channel: String,
    utm_source: String,
    utm_medium: String,
    utm_campaign: String,
    utm_term: String,
    utm_content: String,
}

#[derive(Debug, Serialize)]
struct ClickHousePlayerEventRow {
    event_id: String,
    observed_at: String,
    received_at: String,
    organization_id: String,
    asset_id: String,
    playback_session_id: String,
    viewer_id_hash: String,
    page_type: String,
    page_host: String,
    referrer_host: String,
    player_name: String,
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
    browser_name: String,
    browser_version: String,
    os_name: String,
    os_version: String,
    device_type: String,
    autoplay: u8,
    muted: u8,
    preload: String,
    startup_mode: String,
    geo_country: String,
    geo_region: String,
    geo_city: String,
    geo_continent: String,
    geo_asn: String,
    channel: String,
    utm_source: String,
    utm_medium: String,
    utm_campaign: String,
    utm_term: String,
    utm_content: String,
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
    unique_viewers: u64,
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
    exits_before_start: u64,
    completions: u64,
    request_count: u64,
    bytes_served: u64,
    cache_hit_rate: f64,
    error_rate: f64,
    request_p50_ms: Option<f64>,
    request_p95_ms: Option<f64>,
    timeseries: Vec<AnalyticsTimeSeriesPoint>,
    top_assets: Vec<AnalyticsAssetSummary>,
    breakdowns: Vec<AnalyticsBreakdown>,
    previous: AnalyticsOverviewComparison,
}

/// Headline totals for the immediately-preceding window of equal length, used by
/// the dashboard to render period-over-period deltas on the stat strip.
#[derive(Debug, Serialize)]
struct AnalyticsOverviewComparison {
    views: u64,
    unique_viewers: u64,
    sessions: u64,
    watch_time_ms: u64,
    completions: u64,
    request_count: u64,
    bytes_served: u64,
    startup_success_rate: f64,
    rebuffer_ratio: f64,
    error_rate: f64,
    cache_hit_rate: f64,
}

#[derive(Debug, Serialize)]
struct AnalyticsTimeSeriesPoint {
    bucket_start: String,
    views: u64,
    watch_time_ms: u64,
    request_count: u64,
    bytes_served: u64,
}

#[derive(Debug, Deserialize)]
struct ClickHouseLiveAnalyticsRow {
    row_kind: String,
    bucket_start_ms: i64,
    views: u64,
    watch_time_ms: u64,
    unique_viewers: u64,
    active_sessions: u64,
    asset_id: String,
}

#[derive(Debug, Serialize)]
struct AnalyticsLiveMinutePoint {
    bucket_start: String,
    views: u64,
    watch_time_ms: u64,
}

#[derive(Debug, Serialize)]
struct AnalyticsLiveRecentAsset {
    asset_id: String,
    views: u64,
}

#[derive(Debug, Serialize)]
struct AnalyticsLiveResponse {
    window_started_at: String,
    window_ended_at: String,
    fetched_at: String,
    views: u64,
    watch_time_ms: u64,
    unique_viewers: u64,
    active_sessions: u64,
    views_last_minute: u64,
    timeseries: Vec<AnalyticsLiveMinutePoint>,
    recent_assets: Vec<AnalyticsLiveRecentAsset>,
    resolution: String,
}

#[derive(Debug, Serialize)]
struct AnalyticsAssetSummary {
    asset_id: String,
    views: u64,
    watch_time_ms: u64,
    request_count: u64,
    bytes_served: u64,
}

#[derive(Debug, Serialize)]
struct AnalyticsBreakdown {
    dimension: String,
    rows: Vec<AnalyticsBreakdownRow>,
}

#[derive(Debug, Serialize)]
struct AnalyticsBreakdownRow {
    value: String,
    views: u64,
    unique_viewers: u64,
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
    let ingest_lag_ms =
        max_observed_lag_ms(ingested_at, events.iter().map(|event| &event.observed_at));
    let rows = events
        .into_iter()
        .map(|event| event.into_clickhouse_row(ingested_at))
        .collect::<Vec<_>>();
    insert_clickhouse_playback_events(&state.http, &state.config.playback_telemetry, &rows).await?;
    state
        .metrics
        .record_telemetry_ingest(rows.len(), ingest_lag_ms);
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
    let ingest_lag_ms =
        max_observed_lag_ms(received_at, events.iter().map(|event| &event.observed_at));
    let rows = events
        .into_iter()
        .map(|event| event.into_clickhouse_row(received_at))
        .collect::<Vec<_>>();

    if !rows.is_empty() {
        insert_clickhouse_player_events(&state.http, &state.config.playback_telemetry, &rows)
            .await?;
        state
            .metrics
            .record_telemetry_ingest(rows.len(), ingest_lag_ms);
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

pub(crate) async fn get_analytics_live(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<RequestAuth>,
    Query(query): Query<AnalyticsLiveQuery>,
) -> Response {
    match get_analytics_live_inner(state, auth, query).await {
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
    let breakdowns = query_clickhouse_analytics_breakdowns(
        &state.http,
        &state.config.playback_telemetry,
        &organization_id,
        window,
    )
    .await?;

    let previous_window = previous_overview_window(window);
    let previous_edge = query_clickhouse_edge_overview(
        &state.http,
        &state.config.playback_telemetry,
        &organization_id,
        previous_window,
    )
    .await?;
    let previous_player = query_clickhouse_player_overview(
        &state.http,
        &state.config.playback_telemetry,
        &organization_id,
        previous_window,
    )
    .await?;

    Ok(analytics_overview_response(
        window,
        edge,
        player,
        timeseries,
        top_assets,
        breakdowns,
        previous_edge,
        previous_player,
    ))
}

async fn get_analytics_live_inner(
    state: Arc<AppState>,
    auth: RequestAuth,
    query: AnalyticsLiveQuery,
) -> std::result::Result<AnalyticsLiveResponse, AppError> {
    require_scope(&auth, ApiScope::Analytics)?;
    let organization_id = normalize_org_id(&auth.organization_id)?;
    ensure_org_not_suspended(&state.db, &organization_id).await?;
    let window = normalize_live_window(query, Utc::now())?;
    let fetched_at = Utc::now();
    match query_clickhouse_live_analytics(
        &state.http,
        &state.config.playback_telemetry,
        &organization_id,
        window,
    )
    .await
    {
        Ok(rows) => Ok(analytics_live_response(window, fetched_at, rows)),
        Err(error) => {
            tracing::warn!(
                ?error,
                "player_events live query failed; falling back to rollups"
            );
            analytics_live_from_rollups(state, &organization_id, window, fetched_at).await
        }
    }
}

async fn analytics_live_from_rollups(
    state: Arc<AppState>,
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
    fetched_at: DateTime<Utc>,
) -> std::result::Result<AnalyticsLiveResponse, AppError> {
    let player = query_clickhouse_player_overview(
        &state.http,
        &state.config.playback_telemetry,
        organization_id,
        window,
    )
    .await?;
    let series = query_clickhouse_analytics_series(
        &state.http,
        &state.config.playback_telemetry,
        organization_id,
        window,
    )
    .await?;
    let top_assets = query_clickhouse_analytics_top_assets(
        &state.http,
        &state.config.playback_telemetry,
        organization_id,
        window,
    )
    .await?;

    let timeseries = series
        .into_iter()
        .filter_map(|row| {
            Some(AnalyticsLiveMinutePoint {
                bucket_start: rfc3339_millis_from_unix_millis(row.bucket_start_ms)?,
                views: row.views,
                watch_time_ms: row.watch_time_ms,
            })
        })
        .collect();

    Ok(AnalyticsLiveResponse {
        window_started_at: rfc3339_millis(window.started_at),
        window_ended_at: rfc3339_millis(window.ended_at),
        fetched_at: rfc3339_millis(fetched_at),
        views: player.views,
        watch_time_ms: player.watch_time_ms,
        unique_viewers: player.unique_viewers,
        active_sessions: 0,
        views_last_minute: 0,
        timeseries,
        recent_assets: top_assets
            .into_iter()
            .take(5)
            .map(|row| AnalyticsLiveRecentAsset {
                asset_id: row.asset_id,
                views: row.views,
            })
            .collect(),
        resolution: "hourly".to_owned(),
    })
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
    let organization_id = optional_uuid(event.organization_id.as_deref(), "organization_id")?;

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
    let resolution_tier =
        optional_resolution_tier(event.resolution_tier.as_deref(), "resolution_tier")?;
    let error_code = match event.error_code {
        Some(value) if !value.trim().is_empty() => {
            Some(normalize_safe_token(&value, "error_code", 64)?)
        }
        _ => None,
    };

    Ok(NormalizedPlaybackTelemetryEvent {
        event_id,
        observed_at,
        organization_id,
        asset_id,
        artifact_path,
        edge_id,
        region,
        cache_status,
        status_code: event.status_code,
        bytes_served: event.bytes_served,
        content_type,
        duration_ms: event.duration_ms,
        resolution_tier,
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
    let organization_id = optional_uuid(event.organization_id.as_deref(), "organization_id")?
        .unwrap_or_else(|| NIL_ORGANIZATION_ID.to_owned());
    let playback_session_id =
        normalize_safe_token(&event.playback_session_id, "playback_session_id", 160)?;
    let phase = normalize_player_phase(&event.phase)?;
    let viewer_id_hash =
        optional_safe_token(event.viewer_id_hash.as_deref(), "viewer_id_hash", 96)?;
    let page_type = normalize_page_type(event.page_type.as_deref())?;
    let page_host = optional_safe_host(event.page_host.as_deref(), "page_host")?;
    let referrer_host = optional_safe_host(event.referrer_host.as_deref(), "referrer_host")?;
    let player_name = optional_safe_token(event.player_name.as_deref(), "player_name", 64)?;
    let selected_playback_mode = optional_safe_token(
        event.selected_playback_mode.as_deref(),
        "selected_playback_mode",
        32,
    )?;
    let selected_artifact_path = optional_artifact_path(event.selected_artifact_path.as_deref())?;
    let event_id = match event.event_id.as_deref() {
        Some(value) if !value.trim().is_empty() => normalize_safe_token(value, "event_id", 160)?,
        _ => player_event_id(
            &asset_id,
            &playback_session_id,
            &phase,
            event.event_time_ms,
            &selected_artifact_path,
        ),
    };
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
    let browser_name = optional_safe_token(event.browser_name.as_deref(), "browser_name", 64)?;
    let browser_version =
        optional_safe_token(event.browser_version.as_deref(), "browser_version", 64)?;
    let os_name = optional_safe_token(event.os_name.as_deref(), "os_name", 64)?;
    let os_version = optional_safe_token(event.os_version.as_deref(), "os_version", 64)?;
    let device_type = normalize_device_type(event.device_type.as_deref())?;
    let preload = normalize_preload(event.preload.as_deref())?;
    let startup_mode = optional_safe_token(event.startup_mode.as_deref(), "startup_mode", 32)?;
    let geo_country = optional_geo_token(event.geo_country.as_deref(), "geo_country", 16)?;
    let geo_region = optional_geo_token(event.geo_region.as_deref(), "geo_region", 32)?;
    let geo_city = optional_safe_dimension_text(event.geo_city.as_deref(), "geo_city", 160)?;
    let geo_continent = optional_geo_token(event.geo_continent.as_deref(), "geo_continent", 16)?;
    let geo_asn = optional_safe_token(event.geo_asn.as_deref(), "geo_asn", 32)?;
    let channel = normalize_channel(event.channel.as_deref());
    let utm_source = optional_safe_dimension_text(event.utm_source.as_deref(), "utm_source", 120)?;
    let utm_medium = optional_safe_dimension_text(event.utm_medium.as_deref(), "utm_medium", 120)?;
    let utm_campaign =
        optional_safe_dimension_text(event.utm_campaign.as_deref(), "utm_campaign", 120)?;
    let utm_term = optional_safe_dimension_text(event.utm_term.as_deref(), "utm_term", 120)?;
    let utm_content =
        optional_safe_dimension_text(event.utm_content.as_deref(), "utm_content", 120)?;
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
        event_id,
        observed_at,
        organization_id,
        asset_id,
        playback_session_id,
        viewer_id_hash,
        page_type,
        page_host,
        referrer_host,
        player_name,
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
        browser_name,
        browser_version,
        os_name,
        os_version,
        device_type,
        autoplay: u8::from(event.autoplay.unwrap_or(false)),
        muted: u8::from(event.muted.unwrap_or(false)),
        preload,
        startup_mode,
        geo_country,
        geo_region,
        geo_city,
        geo_continent,
        geo_asn,
        channel,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_term,
        utm_content,
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

fn optional_uuid(
    value: Option<&str>,
    field: &str,
) -> std::result::Result<Option<String>, AppError> {
    match value {
        Some(value) if !value.trim().is_empty() => {
            let value = value.trim().to_ascii_lowercase();
            validate_optional_uuid(&value, field)?;
            Ok(Some(value))
        }
        _ => Ok(None),
    }
}

fn optional_resolution_tier(
    value: Option<&str>,
    field: &str,
) -> std::result::Result<Option<String>, AppError> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value @ ("720p" | "1080p" | "2k" | "4k")) => Ok(Some(value.to_owned())),
        Some(_) => Err(AppError::bad_request(format!("{field} is not supported"))),
        None => Ok(None),
    }
}

fn normalize_page_type(value: Option<&str>) -> std::result::Result<String, AppError> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value @ ("watch" | "embed" | "direct" | "custom")) => Ok(value.to_owned()),
        Some(_) => Err(AppError::bad_request("page_type is not supported")),
        None => Ok(String::new()),
    }
}

fn normalize_device_type(value: Option<&str>) -> std::result::Result<String, AppError> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value @ ("desktop" | "mobile" | "tablet" | "tv" | "bot" | "unknown")) => {
            Ok(value.to_owned())
        }
        Some(_) => Err(AppError::bad_request("device_type is not supported")),
        None => Ok(String::new()),
    }
}

fn normalize_preload(value: Option<&str>) -> std::result::Result<String, AppError> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value @ ("auto" | "metadata" | "none")) => Ok(value.to_owned()),
        Some(_) => Err(AppError::bad_request("preload is not supported")),
        None => Ok(String::new()),
    }
}

/// Canonical acquisition channel slug derived client-side from referrer + UTM
/// tags. Unknown values are dropped (empty) rather than rejected so a stray
/// channel string never fails an otherwise-valid telemetry batch.
fn normalize_channel(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(
            value @ ("direct" | "referral" | "organic_search" | "social" | "email" | "paid"
            | "campaign"),
        ) => value.to_owned(),
        _ => String::new(),
    }
}

fn optional_geo_token(
    value: Option<&str>,
    field: &str,
    max_len: usize,
) -> std::result::Result<String, AppError> {
    match value {
        Some(value) if !value.trim().is_empty() => {
            let value = value.trim().to_ascii_uppercase();
            if value.len() > max_len
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err(AppError::bad_request(format!(
                    "{field} contains unsupported characters"
                )));
            }
            Ok(value)
        }
        _ => Ok(String::new()),
    }
}

fn optional_safe_host(value: Option<&str>, field: &str) -> std::result::Result<String, AppError> {
    match value {
        Some(value) if !value.trim().is_empty() => {
            let value = value.trim().to_ascii_lowercase();
            if value.len() > 160
                || value.contains("://")
                || value.contains('?')
                || value.contains('#')
                || value.contains('@')
                || value.bytes().any(|byte| {
                    !(byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b':' | b'_'))
                })
            {
                return Err(AppError::bad_request(format!("{field} is not allowed")));
            }
            Ok(value)
        }
        _ => Ok(String::new()),
    }
}

fn optional_safe_dimension_text(
    value: Option<&str>,
    field: &str,
    max_len: usize,
) -> std::result::Result<String, AppError> {
    match value {
        Some(value) if !value.trim().is_empty() => {
            let value = value.trim();
            if value.len() > max_len
                || value.contains("://")
                || value.contains('?')
                || value.contains('#')
                || value.bytes().any(|byte| byte.is_ascii_control())
                || value.to_ascii_lowercase().contains("token")
                || value.to_ascii_lowercase().contains("secret")
            {
                return Err(AppError::bad_request(format!("{field} is not allowed")));
            }
            Ok(value.to_owned())
        }
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

impl NormalizedPlaybackTelemetryEvent {
    fn into_clickhouse_row(self, ingested_at: DateTime<Utc>) -> ClickHousePlaybackEventRow {
        let delivered_duration_ms = if (200..400).contains(&self.status_code) {
            fallback_delivered_duration_ms(&self.artifact_path)
        } else {
            0
        };

        ClickHousePlaybackEventRow {
            event_id: self.event_id,
            observed_at: clickhouse_datetime(self.observed_at),
            ingested_at: clickhouse_datetime(ingested_at),
            asset_id: self.asset_id,
            organization_id: self.organization_id,
            artifact_path: self.artifact_path,
            edge_id: self.edge_id,
            region: self.region,
            cache_status: self.cache_status,
            status_code: self.status_code,
            bytes_served: self.bytes_served,
            content_type: self.content_type,
            duration_ms: self.duration_ms,
            delivered_duration_ms,
            resolution_tier: self.resolution_tier,
            error_code: self.error_code,
        }
    }
}

impl NormalizedPlayerTelemetryEvent {
    fn into_clickhouse_row(self, received_at: DateTime<Utc>) -> ClickHousePlayerEventRow {
        ClickHousePlayerEventRow {
            event_id: self.event_id,
            observed_at: clickhouse_datetime(self.observed_at),
            received_at: clickhouse_datetime(received_at),
            organization_id: self.organization_id,
            asset_id: self.asset_id,
            playback_session_id: self.playback_session_id,
            viewer_id_hash: self.viewer_id_hash,
            page_type: self.page_type,
            page_host: self.page_host,
            referrer_host: self.referrer_host,
            player_name: self.player_name,
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
            browser_name: self.browser_name,
            browser_version: self.browser_version,
            os_name: self.os_name,
            os_version: self.os_version,
            device_type: self.device_type,
            autoplay: self.autoplay,
            muted: self.muted,
            preload: self.preload,
            startup_mode: self.startup_mode,
            geo_country: self.geo_country,
            geo_region: self.geo_region,
            geo_city: self.geo_city,
            geo_continent: self.geo_continent,
            geo_asn: self.geo_asn,
            channel: self.channel,
            utm_source: self.utm_source,
            utm_medium: self.utm_medium,
            utm_campaign: self.utm_campaign,
            utm_term: self.utm_term,
            utm_content: self.utm_content,
        }
    }
}

fn fallback_delivered_duration_ms(artifact_path: &str) -> u32 {
    if !is_asset_playback_path(artifact_path) {
        return 0;
    }

    match artifact_path.split('/').collect::<Vec<_>>().as_slice() {
        ["opener.mp4"] | ["hls", "master.m3u8"] | ["hls", _, "index.m3u8"] => 0,
        ["hls", _] | ["hls", _, _] => 2_000,
        _ => 0,
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
        (event_id, observed_at, received_at, organization_id, asset_id, playback_session_id, viewer_id_hash, page_type, page_host, referrer_host, player_name, phase, selected_playback_mode, selected_artifact_path, first_frame_ms, bootstrap_duration_ms, bootstrap_http_status, stall_duration_ms, watch_delta_ms, playback_failure_code, edge_label, region_label, player_version, app_version, browser_name, browser_version, os_name, os_version, device_type, autoplay, muted, preload, startup_mode, geo_country, geo_region, geo_city, geo_continent, geo_asn, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content) \
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

async fn query_clickhouse_live_analytics(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> std::result::Result<Vec<ClickHouseLiveAnalyticsRow>, AppError> {
    let query = clickhouse_live_analytics_query(organization_id, window);
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

async fn query_clickhouse_analytics_breakdowns(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> std::result::Result<Vec<ClickHouseAnalyticsBreakdownRow>, AppError> {
    let query = clickhouse_analytics_breakdowns_query(organization_id, window);
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
          (organization_id, bucket_start, asset_id, sessions, views, unique_viewers, startup_failures, exits_before_start, watch_time_ms, stalled_sessions, stall_count, stall_duration_ms, playback_failures, completions, first_frame_p50_ms, first_frame_p95_ms, updated_at) \
        SELECT \
          rollup_organization_id AS organization_id, \
          bucket_start, \
          rollup_asset_id AS asset_id, \
          count() AS sessions, \
          countIf(reached_first_frame) AS views, \
          uniqExactIf(session_viewer_id_hash, session_viewer_id_hash != '') AS unique_viewers, \
          countIf(startup_failed) AS startup_failures, \
          countIf(NOT reached_first_frame AND NOT startup_failed) AS exits_before_start, \
          sum(session_watch_time_ms) AS watch_time_ms, \
          countIf(session_stall_duration_ms > 0) AS stalled_sessions, \
          sum(session_stall_count) AS stall_count, \
          sum(session_stall_duration_ms) AS stall_duration_ms, \
          sum(session_playback_failures) AS playback_failures, \
          sum(session_completions) AS completions, \
          quantileTDigestIf(0.5)(first_frame_ms, first_frame_ms > 0) AS first_frame_p50_ms, \
          quantileTDigestIf(0.95)(first_frame_ms, first_frame_ms > 0) AS first_frame_p95_ms, \
          now64(3) AS updated_at \
        FROM ( \
          SELECT \
            rollup_organization_id, \
            rollup_asset_id, \
            rollup_playback_session_id, \
            any(session_viewer_id_hash) AS session_viewer_id_hash, \
            toStartOfHour(min(event_observed_at)) AS bucket_start, \
            countIf(phase = 'first_frame') > 0 AS reached_first_frame, \
            countIf(phase = 'bootstrap_failure') > 0 AS startup_failed, \
            minIf(first_frame_ms, phase = 'first_frame' AND first_frame_ms > 0) AS first_frame_ms, \
            sumIf(watch_delta_ms, phase = 'watch_heartbeat') AS session_watch_time_ms, \
            countIf(phase = 'stall_end') AS session_stall_count, \
            sumIf(stall_duration_ms, phase = 'stall_end') AS session_stall_duration_ms, \
            countIf(phase = 'playback_failure') AS session_playback_failures, \
            countIf(phase = 'playback_ended') AS session_completions \
          FROM ( \
            SELECT \
              event_id, \
              any(organization_id) AS rollup_organization_id, \
              any(asset_id) AS rollup_asset_id, \
              any(playback_session_id) AS rollup_playback_session_id, \
              any(viewer_id_hash) AS session_viewer_id_hash, \
              min(observed_at) AS event_observed_at, \
              any(phase) AS phase, \
              any(first_frame_ms) AS first_frame_ms, \
              any(stall_duration_ms) AS stall_duration_ms, \
              any(watch_delta_ms) AS watch_delta_ms \
            FROM player_events \
            WHERE organization_id != toUUID('{NIL_ORGANIZATION_ID}') \
              AND observed_at >= fromUnixTimestamp64Milli({}) \
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
          ifNull(sum(player_rollups.unique_viewers), 0) AS unique_viewers, \
          ifNull(sum(player_rollups.startup_failures), 0) AS startup_failures, \
          ifNull(sum(player_rollups.exits_before_start), 0) AS exits_before_start, \
          ifNull(sum(player_rollups.watch_time_ms), 0) AS watch_time_ms, \
          ifNull(sum(player_rollups.stalled_sessions), 0) AS stalled_sessions, \
          ifNull(sum(player_rollups.stall_count), 0) AS stall_count, \
          ifNull(sum(player_rollups.stall_duration_ms), 0) AS stall_duration_ms, \
          ifNull(sum(player_rollups.playback_failures), 0) AS playback_failures, \
          ifNull(sum(player_rollups.completions), 0) AS completions, \
          if(isFinite(avgIf(player_rollups.first_frame_p50_ms, player_rollups.views > 0)), avgIf(player_rollups.first_frame_p50_ms, player_rollups.views > 0), 0) AS first_frame_p50_ms, \
          if(isFinite(avgIf(player_rollups.first_frame_p95_ms, player_rollups.views > 0)), avgIf(player_rollups.first_frame_p95_ms, player_rollups.views > 0), 0) AS first_frame_p95_ms \
        FROM ( \
          SELECT \
            bucket_start, \
            asset_id, \
            argMax(sessions, updated_at) AS sessions, \
            argMax(views, updated_at) AS views, \
            argMax(unique_viewers, updated_at) AS unique_viewers, \
            argMax(startup_failures, updated_at) AS startup_failures, \
            argMax(exits_before_start, updated_at) AS exits_before_start, \
            argMax(watch_time_ms, updated_at) AS watch_time_ms, \
            argMax(stalled_sessions, updated_at) AS stalled_sessions, \
            argMax(stall_count, updated_at) AS stall_count, \
            argMax(stall_duration_ms, updated_at) AS stall_duration_ms, \
            argMax(playback_failures, updated_at) AS playback_failures, \
            argMax(completions, updated_at) AS completions, \
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

fn clickhouse_live_analytics_query(
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> String {
    let start_ms = window.started_at.timestamp_millis();
    let end_ms = window.ended_at.timestamp_millis();
    let active_cutoff_ms = end_ms - (LIVE_ACTIVE_SESSION_LOOKBACK_SECS as i64) * 1000;
    let recent_cutoff_ms = end_ms - (LIVE_RECENT_ASSET_LOOKBACK_SECS as i64) * 1000;
    let last_minute_cutoff_ms = end_ms - 60_000;

    format!(
        "\
        SELECT \
          'bucket' AS row_kind, \
          toInt64(toUnixTimestamp(toStartOfMinute(observed_at))) * 1000 AS bucket_start_ms, \
          countIf(phase = 'first_frame') AS views, \
          sumIf(watch_delta_ms, phase = 'watch_heartbeat') AS watch_time_ms, \
          toUInt64(0) AS unique_viewers, \
          toUInt64(0) AS active_sessions, \
          '' AS asset_id \
        FROM player_events \
        WHERE organization_id = toUUID('{organization_id}') \
          AND observed_at >= fromUnixTimestamp64Milli({start_ms}) \
          AND observed_at < fromUnixTimestamp64Milli({end_ms}) \
        GROUP BY toStartOfMinute(observed_at) \
        UNION ALL \
        SELECT \
          'totals' AS row_kind, \
          toInt64(0) AS bucket_start_ms, \
          countIf(phase = 'first_frame') AS views, \
          sumIf(watch_delta_ms, phase = 'watch_heartbeat') AS watch_time_ms, \
          uniqExactIf(playback_session_id, phase = 'first_frame') AS unique_viewers, \
          uniqExactIf( \
            playback_session_id, \
            observed_at >= fromUnixTimestamp64Milli({active_cutoff_ms}) \
              AND phase IN ('watch_heartbeat', 'first_frame', 'stall_start') \
          ) AS active_sessions, \
          '' AS asset_id \
        FROM player_events \
        WHERE organization_id = toUUID('{organization_id}') \
          AND observed_at >= fromUnixTimestamp64Milli({start_ms}) \
          AND observed_at < fromUnixTimestamp64Milli({end_ms}) \
        UNION ALL \
        SELECT \
          'last_minute' AS row_kind, \
          toInt64(0) AS bucket_start_ms, \
          countIf(phase = 'first_frame') AS views, \
          toUInt64(0) AS watch_time_ms, \
          toUInt64(0) AS unique_viewers, \
          toUInt64(0) AS active_sessions, \
          '' AS asset_id \
        FROM player_events \
        WHERE organization_id = toUUID('{organization_id}') \
          AND observed_at >= fromUnixTimestamp64Milli({last_minute_cutoff_ms}) \
          AND observed_at < fromUnixTimestamp64Milli({end_ms}) \
        UNION ALL \
        SELECT row_kind, bucket_start_ms, views, watch_time_ms, unique_viewers, active_sessions, asset_id \
        FROM ( \
          SELECT \
            'recent' AS row_kind, \
            toInt64(0) AS bucket_start_ms, \
            countIf(phase = 'first_frame') AS views, \
            toUInt64(0) AS watch_time_ms, \
            toUInt64(0) AS unique_viewers, \
            toUInt64(0) AS active_sessions, \
            toString(asset_id) AS asset_id \
          FROM player_events \
          WHERE organization_id = toUUID('{organization_id}') \
            AND observed_at >= fromUnixTimestamp64Milli({recent_cutoff_ms}) \
            AND observed_at < fromUnixTimestamp64Milli({end_ms}) \
          GROUP BY asset_id \
          ORDER BY views DESC \
          LIMIT 5 \
        ) \
        FORMAT JSONEachRow",
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

fn clickhouse_player_breakdown_select(
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
    dimension: &str,
    column: &str,
) -> String {
    format!(
        "\
        SELECT \
          '{dimension}' AS dimension, \
          value, \
          countIf(reached_first_frame) AS views, \
          uniqExactIf(session_viewer_id_hash, session_viewer_id_hash != '') AS unique_viewers, \
          sum(session_watch_time_ms) AS watch_time_ms, \
          0 AS request_count, \
          0 AS bytes_served \
        FROM ( \
          SELECT \
            value, \
            session_id, \
            any(session_viewer_id_hash) AS session_viewer_id_hash, \
            countIf(phase = 'first_frame') > 0 AS reached_first_frame, \
            sumIf(watch_delta_ms, phase = 'watch_heartbeat') AS session_watch_time_ms \
          FROM ( \
            SELECT \
              event_id, \
              any({column}) AS value, \
              any(playback_session_id) AS session_id, \
              any(viewer_id_hash) AS session_viewer_id_hash, \
              any(phase) AS phase, \
              any(watch_delta_ms) AS watch_delta_ms \
            FROM player_events \
            WHERE organization_id = toUUID('{organization_id}') \
              AND observed_at >= fromUnixTimestamp64Milli({}) \
              AND observed_at < fromUnixTimestamp64Milli({}) \
            GROUP BY event_id \
          ) \
          WHERE value != '' \
          GROUP BY value, session_id \
        ) \
        GROUP BY value \
        ORDER BY views DESC, unique_viewers DESC, watch_time_ms DESC \
        LIMIT 8",
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
    )
}

fn clickhouse_edge_breakdown_select(
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
    dimension: &str,
    expression: &str,
) -> String {
    format!(
        "\
        SELECT \
          '{dimension}' AS dimension, \
          value, \
          0 AS views, \
          0 AS unique_viewers, \
          0 AS watch_time_ms, \
          count() AS request_count, \
          sum(bytes_served) AS bytes_served \
        FROM ( \
          SELECT \
            event_id, \
            {expression} AS value, \
            any(bytes_served) AS bytes_served \
          FROM playback_events \
          WHERE organization_id = toUUID('{organization_id}') \
            AND observed_at >= fromUnixTimestamp64Milli({}) \
            AND observed_at < fromUnixTimestamp64Milli({}) \
          GROUP BY event_id \
        ) \
        WHERE value != '' \
        GROUP BY value \
        ORDER BY request_count DESC, bytes_served DESC \
        LIMIT 8",
        window.started_at.timestamp_millis(),
        window.ended_at.timestamp_millis(),
    )
}

fn clickhouse_analytics_breakdowns_query(
    organization_id: &str,
    window: NormalizedPlaybackAnalyticsWindow,
) -> String {
    let selects = [
        clickhouse_player_breakdown_select(organization_id, window, "page_type", "page_type"),
        clickhouse_player_breakdown_select(organization_id, window, "hostname", "page_host"),
        clickhouse_player_breakdown_select(organization_id, window, "channel", "channel"),
        clickhouse_player_breakdown_select(organization_id, window, "referrer", "referrer_host"),
        clickhouse_player_breakdown_select(organization_id, window, "campaign", "utm_campaign"),
        clickhouse_player_breakdown_select(organization_id, window, "keyword", "utm_term"),
        clickhouse_player_breakdown_select(organization_id, window, "country", "geo_country"),
        clickhouse_player_breakdown_select(organization_id, window, "region", "geo_region"),
        clickhouse_player_breakdown_select(organization_id, window, "city", "geo_city"),
        clickhouse_player_breakdown_select(organization_id, window, "browser", "browser_name"),
        clickhouse_player_breakdown_select(organization_id, window, "os", "os_name"),
        clickhouse_player_breakdown_select(organization_id, window, "device", "device_type"),
        clickhouse_player_breakdown_select(
            organization_id,
            window,
            "player_version",
            "player_version",
        ),
        clickhouse_edge_breakdown_select(organization_id, window, "edge_region", "any(region)"),
        clickhouse_edge_breakdown_select(
            organization_id,
            window,
            "resolution_tier",
            "ifNull(any(resolution_tier), '')",
        ),
    ];
    format!("{} FORMAT JSONEachRow", selects.join(" UNION ALL "))
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

fn normalize_live_window(
    query: AnalyticsLiveQuery,
    now: DateTime<Utc>,
) -> std::result::Result<NormalizedPlaybackAnalyticsWindow, AppError> {
    let window_seconds = query
        .window_seconds
        .unwrap_or(DEFAULT_LIVE_WINDOW_SECS)
        .clamp(60, MAX_LIVE_WINDOW_SECS);
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

fn previous_overview_window(
    window: NormalizedPlaybackAnalyticsWindow,
) -> NormalizedPlaybackAnalyticsWindow {
    let duration = window.ended_at - window.started_at;
    NormalizedPlaybackAnalyticsWindow {
        started_at: window.started_at - duration,
        ended_at: window.started_at,
    }
}

fn analytics_overview_comparison(
    edge: ClickHouseEdgeOverviewRow,
    player: ClickHousePlayerOverviewRow,
) -> AnalyticsOverviewComparison {
    let startup_attempts = player.views.saturating_add(player.startup_failures);
    AnalyticsOverviewComparison {
        views: player.views,
        unique_viewers: player.unique_viewers,
        sessions: player.sessions,
        watch_time_ms: player.watch_time_ms,
        completions: player.completions,
        request_count: edge.request_count,
        bytes_served: edge.bytes_served,
        startup_success_rate: ratio(player.views, startup_attempts),
        rebuffer_ratio: ratio(player.stalled_sessions, player.views),
        error_rate: ratio(edge.error_count, edge.request_count),
        cache_hit_rate: ratio(edge.cache_hit_count, edge.request_count),
    }
}

fn analytics_overview_response(
    window: NormalizedPlaybackAnalyticsWindow,
    edge: ClickHouseEdgeOverviewRow,
    player: ClickHousePlayerOverviewRow,
    timeseries: Vec<ClickHouseAnalyticsSeriesRow>,
    top_assets: Vec<ClickHouseAnalyticsAssetRow>,
    breakdown_rows: Vec<ClickHouseAnalyticsBreakdownRow>,
    previous_edge: ClickHouseEdgeOverviewRow,
    previous_player: ClickHousePlayerOverviewRow,
) -> AnalyticsOverviewResponse {
    let startup_attempts = player.views.saturating_add(player.startup_failures);
    let startup_success_rate = ratio(player.views, startup_attempts);
    let rebuffer_ratio = ratio(player.stalled_sessions, player.views);
    let cache_hit_rate = ratio(edge.cache_hit_count, edge.request_count);
    let error_rate = ratio(edge.error_count, edge.request_count);
    let previous = analytics_overview_comparison(previous_edge, previous_player);

    AnalyticsOverviewResponse {
        window_started_at: rfc3339_millis(window.started_at),
        window_ended_at: rfc3339_millis(window.ended_at),
        views: player.views,
        unique_viewers: player.unique_viewers,
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
        exits_before_start: player.exits_before_start,
        completions: player.completions,
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
        breakdowns: analytics_breakdowns_response(breakdown_rows),
        previous,
    }
}

fn analytics_live_response(
    window: NormalizedPlaybackAnalyticsWindow,
    fetched_at: DateTime<Utc>,
    rows: Vec<ClickHouseLiveAnalyticsRow>,
) -> AnalyticsLiveResponse {
    let mut views = 0_u64;
    let mut watch_time_ms = 0_u64;
    let mut unique_viewers = 0_u64;
    let mut active_sessions = 0_u64;
    let mut views_last_minute = 0_u64;
    let mut bucket_map = BTreeMap::new();
    let mut recent_assets = Vec::new();

    for row in rows {
        match row.row_kind.as_str() {
            "bucket" => {
                bucket_map.insert(row.bucket_start_ms, (row.views, row.watch_time_ms));
            }
            "totals" => {
                views = row.views;
                watch_time_ms = row.watch_time_ms;
                unique_viewers = row.unique_viewers;
                active_sessions = row.active_sessions;
            }
            "last_minute" => {
                views_last_minute = row.views;
            }
            "recent" if row.views > 0 && !row.asset_id.is_empty() => {
                recent_assets.push(AnalyticsLiveRecentAsset {
                    asset_id: row.asset_id,
                    views: row.views,
                });
            }
            _ => {}
        }
    }

    let minute_ms = 60_000_i64;
    let end_ms = window.ended_at.timestamp_millis();
    let mut cursor = (window.started_at.timestamp_millis() / minute_ms) * minute_ms;
    let mut timeseries = Vec::new();
    while cursor < end_ms {
        let (bucket_views, bucket_watch_time_ms) =
            bucket_map.get(&cursor).copied().unwrap_or((0, 0));
        timeseries.push(AnalyticsLiveMinutePoint {
            bucket_start: rfc3339_millis_from_unix_millis(cursor).unwrap_or_default(),
            views: bucket_views,
            watch_time_ms: bucket_watch_time_ms,
        });
        cursor += minute_ms;
    }

    AnalyticsLiveResponse {
        window_started_at: rfc3339_millis(window.started_at),
        window_ended_at: rfc3339_millis(window.ended_at),
        fetched_at: rfc3339_millis(fetched_at),
        views,
        watch_time_ms,
        unique_viewers,
        active_sessions,
        views_last_minute,
        timeseries,
        recent_assets,
        resolution: "minute".to_owned(),
    }
}

fn analytics_breakdowns_response(
    rows: Vec<ClickHouseAnalyticsBreakdownRow>,
) -> Vec<AnalyticsBreakdown> {
    let mut grouped: BTreeMap<String, Vec<AnalyticsBreakdownRow>> = BTreeMap::new();
    for row in rows {
        grouped
            .entry(row.dimension)
            .or_default()
            .push(AnalyticsBreakdownRow {
                value: row.value,
                views: row.views,
                unique_viewers: row.unique_viewers,
                watch_time_ms: row.watch_time_ms,
                request_count: row.request_count,
                bytes_served: row.bytes_served,
            });
    }

    grouped
        .into_iter()
        .map(|(dimension, rows)| AnalyticsBreakdown { dimension, rows })
        .collect()
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

fn max_observed_lag_ms<'a, I>(received_at: DateTime<Utc>, observed_ats: I) -> u64
where
    I: IntoIterator<Item = &'a DateTime<Utc>>,
{
    observed_ats
        .into_iter()
        .map(|observed_at| {
            received_at
                .signed_duration_since(*observed_at)
                .num_milliseconds()
                .max(0) as u64
        })
        .max()
        .unwrap_or(0)
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

    spawn_analytics_rollup_refresh(state.clone(), "immediate", 0);
    spawn_analytics_rollup_refresh(
        state.clone(),
        "lag_catchup",
        analytics_rollup_lag_catchup_delay_secs(),
    );
    spawn_analytics_rollup_refresh(
        state,
        "throttle_catchup",
        analytics_rollup_throttle_catchup_delay_secs(),
    );
}

fn spawn_analytics_rollup_refresh(
    state: Arc<AppState>,
    refresh_kind: &'static str,
    delay_secs: u64,
) {
    tokio::spawn(async move {
        if delay_secs > 0 {
            tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        }
        if let Err(error) = refresh_recent_analytics_rollups(state.clone()).await {
            state.metrics.record_analytics_rollup_failure();
            tracing::warn!(?error, refresh_kind, "analytics rollup refresh failed");
        }
    });
}

fn analytics_rollup_lag_catchup_delay_secs() -> u64 {
    u64::try_from(ANALYTICS_ROLLUP_LAG_SECS)
        .unwrap_or(0)
        .saturating_add(ANALYTICS_ROLLUP_CATCHUP_BUFFER_SECS)
}

fn analytics_rollup_throttle_catchup_delay_secs() -> u64 {
    ANALYTICS_ROLLUP_THROTTLE_SECS.saturating_add(analytics_rollup_lag_catchup_delay_secs())
}

async fn refresh_recent_analytics_rollups(
    state: Arc<AppState>,
) -> std::result::Result<(), AppError> {
    let now = Utc::now();
    let window = analytics_rollup_refresh_window(now);
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
    state
        .metrics
        .record_analytics_rollup_success(max_observed_lag_ms(now, [&window.ended_at]));
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
    fn player_telemetry_without_org_uses_nil_org_for_clickhouse() {
        let received_at = DateTime::parse_from_rfc3339("2026-06-13T12:00:01.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let event_time_ms = received_at.timestamp_millis() - 1_000;
        let batch = serde_json::from_value::<PlayerTelemetryBatch>(serde_json::json!({
            "events": [{
                "event_id": "player-evt-1",
                "playback_session_id": "session-1",
                "asset_id": "00000000-0000-0000-0000-000000000001",
                "phase": "player_load",
                "event_time_ms": event_time_ms,
                "page_type": "watch"
            }]
        }))
        .unwrap();
        let event = normalize_player_telemetry_batch(batch, 2, received_at)
            .unwrap()
            .remove(0);
        let row = event.into_clickhouse_row(received_at);

        assert_eq!(row.organization_id, NIL_ORGANIZATION_ID);
        assert_eq!(row.page_type, "watch");
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
    fn live_analytics_bucket_query_keeps_clickhouse_datetime64_compatible() {
        let window = NormalizedPlaybackAnalyticsWindow {
            started_at: DateTime::parse_from_rfc3339("2026-06-13T11:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
            ended_at: DateTime::parse_from_rfc3339("2026-06-13T12:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
        };
        let query = clickhouse_live_analytics_query("00000000-0000-0000-0000-000000000001", window);

        assert!(query.contains("toInt64(toUnixTimestamp(toStartOfMinute(observed_at))) * 1000"));
        assert!(!query.contains("toUnixTimestamp64Milli(toStartOfMinute(observed_at))"));
    }

    #[test]
    fn analytics_breakdowns_query_covers_acquisition_dimensions() {
        let window = NormalizedPlaybackAnalyticsWindow {
            started_at: DateTime::parse_from_rfc3339("2026-06-13T11:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
            ended_at: DateTime::parse_from_rfc3339("2026-06-13T12:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
        };
        let query =
            clickhouse_analytics_breakdowns_query("00000000-0000-0000-0000-000000000001", window);

        for dimension in [
            "channel",
            "referrer",
            "campaign",
            "keyword",
            "hostname",
            "country",
            "region",
            "city",
            "browser",
            "os",
            "device",
            "page_type",
        ] {
            assert!(
                query.contains(&format!("'{dimension}' AS dimension")),
                "breakdown query is missing the {dimension} dimension"
            );
        }
        // Dedupe-by-event_id must survive so retries never double-count views.
        assert!(query.contains("GROUP BY event_id"));
        assert!(query.contains("FORMAT JSONEachRow"));
    }

    #[test]
    fn previous_overview_window_is_equal_length_and_adjacent() {
        let window = NormalizedPlaybackAnalyticsWindow {
            started_at: DateTime::parse_from_rfc3339("2026-06-13T12:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
            ended_at: DateTime::parse_from_rfc3339("2026-06-13T13:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
        };
        let previous = previous_overview_window(window);

        assert_eq!(previous.ended_at, window.started_at);
        assert_eq!(
            previous.started_at,
            DateTime::parse_from_rfc3339("2026-06-13T11:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc)
        );
    }

    #[test]
    fn normalize_channel_accepts_known_slugs_only() {
        assert_eq!(normalize_channel(Some("organic_search")), "organic_search");
        assert_eq!(normalize_channel(Some(" social ")), "social");
        assert_eq!(normalize_channel(Some("paid")), "paid");
        assert_eq!(normalize_channel(Some("bogus")), "");
        assert_eq!(normalize_channel(None), "");
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
        assert!(player_query.contains("uniqExactIf(session_viewer_id_hash"));
        assert!(player_query.contains("countIf(NOT reached_first_frame AND NOT startup_failed)"));
        assert!(player_query.contains("sum(session_watch_time_ms) AS watch_time_ms"));
        assert!(player_query.contains("countIf(session_stall_duration_ms > 0)"));
        assert!(player_query.contains("sum(session_playback_failures) AS playback_failures"));
        assert!(player_query.contains("countIf(phase = 'playback_ended')"));
        assert!(
            player_query.contains(
                "WHERE organization_id != toUUID('00000000-0000-0000-0000-000000000000')"
            )
        );
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
    fn rollup_catchup_delays_cover_lag_and_throttle_window() {
        assert_eq!(
            analytics_rollup_lag_catchup_delay_secs(),
            65,
            "first catch-up should run just after the rollup exclusion lag"
        );
        assert_eq!(
            analytics_rollup_throttle_catchup_delay_secs(),
            125,
            "final catch-up should include events received during the throttle window"
        );
    }

    #[test]
    fn clickhouse_rows_use_event_claims_without_postgres_metadata() {
        let ingested_at = DateTime::parse_from_rfc3339("2026-06-13T12:00:01.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let batch = serde_json::from_value::<PlaybackTelemetryBatch>(serde_json::json!({
            "events": [{
                "event_id": "evt-1",
                "observed_at": "2026-06-13T12:00:00.000Z",
                "organization_id": "00000000-0000-0000-0000-000000000009",
                "asset_id": "00000000-0000-0000-0000-000000000001",
                "artifact_path": "hls/segment_00000.ts",
                "edge_id": "edge-1",
                "region": "local",
                "cache_status": "HIT",
                "status_code": 200,
                "bytes_served": 123,
                "content_type": "video/mp2t",
                "duration_ms": 9,
                "resolution_tier": "720p"
            }]
        }))
        .unwrap();
        let event = normalize_playback_telemetry_batch(batch, 2, ingested_at)
            .unwrap()
            .remove(0);
        let row = event.into_clickhouse_row(ingested_at);

        assert_eq!(row.duration_ms, 9);
        assert_eq!(row.delivered_duration_ms, 2_000);
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
