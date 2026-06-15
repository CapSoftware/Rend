use std::{collections::BTreeMap, collections::HashMap, sync::Arc};

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
use rend_playback_auth::is_valid_hls_segment_name;
use serde::{Deserialize, Serialize};

use crate::{
    ApiScope, AppError, AppState, RequestAuth, billing, ensure_asset_not_suspended,
    normalize_asset_id, require_scope,
};

const DEFAULT_TELEMETRY_MAX_BODY_BYTES: usize = 256 * 1024;
const HARD_TELEMETRY_MAX_BODY_BYTES: usize = 1024 * 1024;
const DEFAULT_TELEMETRY_MAX_EVENTS_PER_BATCH: usize = 100;
const HARD_TELEMETRY_MAX_EVENTS_PER_BATCH: usize = 1000;
const DEFAULT_ANALYTICS_WINDOW_SECS: usize = 24 * 60 * 60;
const DEFAULT_ANALYTICS_MAX_WINDOW_SECS: usize = 7 * 24 * 60 * 60;

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

pub(crate) async fn post_playback_telemetry(
    State(state): State<Arc<AppState>>,
    Json(batch): Json<PlaybackTelemetryBatch>,
) -> Response {
    match post_playback_telemetry_inner(state, batch).await {
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
    billing::schedule_delivery_usage_sync(state);

    Ok(PlaybackTelemetryIngestResponse {
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

fn validate_optional_uuid(value: &str, field: &str) -> std::result::Result<(), AppError> {
    let value = value.trim();
    if !value.is_empty() && !crate::is_canonical_uuid(value) {
        return Err(AppError::bad_request(format!("{field} must be a UUID")));
    }
    Ok(())
}

fn normalize_artifact_path(value: &str) -> std::result::Result<String, AppError> {
    let value = normalize_safe_text(value, "artifact_path", 256)?;
    let supported = match value.split('/').collect::<Vec<_>>().as_slice() {
        ["opener.mp4"] => true,
        ["hls", "master.m3u8"] => true,
        ["hls", segment_name] => is_valid_hls_segment_name(segment_name),
        _ => false,
    };
    if !supported {
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

fn fallback_delivered_duration_ms(
    artifact_path: &str,
    metadata: Option<&AssetPlaybackBillingMetadata>,
) -> Option<i64> {
    match artifact_path.split('/').collect::<Vec<_>>().as_slice() {
        ["opener.mp4"] => metadata
            .and_then(|value| value.duration_ms)
            .map(|duration_ms| duration_ms.min(5_000)),
        ["hls", "master.m3u8"] => Some(0),
        ["hls", segment_name] if is_valid_hls_segment_name(segment_name) => Some(2_000),
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
