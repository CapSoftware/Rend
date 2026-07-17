use std::{
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse, response::Response};
use chrono::{Duration as ChronoDuration, TimeZone, Utc};
use rend_config::{
    RendEnv, env_duration_secs, env_string, validate_required_secret, validate_required_url,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};

use crate::{AppError, AppState, normalize_org_id};

const DEFAULT_AUTUMN_API_URL: &str = "https://api.useautumn.com/v1";
const DEFAULT_AUTUMN_API_VERSION: &str = "2.3.0";
const DEFAULT_DELIVERY_SYNC_LAG_SECS: u64 = 60;
const DEFAULT_DELIVERY_SYNC_MAX_WINDOW_SECS: u64 = 3600;
const DEFAULT_STORAGE_SYNC_LAG_SECS: u64 = 60;
const DEFAULT_STORAGE_SYNC_MAX_WINDOW_SECS: u64 = 3600;
const DELIVERY_SYNC_THROTTLE_SECS: u64 = 60;
const SECONDS_PER_BILLING_MONTH: f64 = 30.0 * 24.0 * 60.0 * 60.0;

const DEFAULT_DELIVERY_720P_FEATURE_ID: &str = "delivery_720p_seconds";
const DEFAULT_DELIVERY_1080P_FEATURE_ID: &str = "delivery_1080p_seconds";
const DEFAULT_DELIVERY_2K_FEATURE_ID: &str = "delivery_2k_seconds";
const DEFAULT_DELIVERY_4K_FEATURE_ID: &str = "delivery_4k_seconds";
const DEFAULT_STORAGE_720P_FEATURE_ID: &str = "storage_720p_second_months";
const DEFAULT_STORAGE_1080P_FEATURE_ID: &str = "storage_1080p_second_months";
const DEFAULT_STORAGE_2K_FEATURE_ID: &str = "storage_2k_second_months";
const DEFAULT_STORAGE_4K_FEATURE_ID: &str = "storage_4k_second_months";

static LAST_DELIVERY_SYNC_ATTEMPT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BillingMode {
    Local,
    Autumn,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum BillingFailurePolicy {
    FailClosed,
    FailOpen,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BillingFeature {
    id: String,
}

#[derive(Clone, Debug)]
struct TieredBillingFeatures {
    p720: BillingFeature,
    p1080: BillingFeature,
    p2k: BillingFeature,
    p4k: BillingFeature,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolutionTier {
    P720,
    P1080,
    P2K,
    P4K,
}

#[derive(Clone, Debug)]
pub(crate) struct BillingConfig {
    mode: BillingMode,
    autumn_api_url: String,
    autumn_secret_key: String,
    autumn_api_version: String,
    failure_policy: BillingFailurePolicy,
    delivery_features: TieredBillingFeatures,
    storage_features: TieredBillingFeatures,
    delivery_sync_lag: Duration,
    delivery_sync_max_window: Duration,
    storage_sync_lag: Duration,
    storage_sync_max_window: Duration,
}

#[derive(Clone, Debug)]
pub(crate) struct UploadBillingReservation;

#[derive(Clone, Debug)]
struct ReservedUsage {
    feature_id: String,
    value: f64,
    idempotency_key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UsageEventInsert {
    Inserted,
    AlreadyFinalized,
}

#[derive(Debug, Deserialize)]
struct AutumnCheckResponse {
    allowed: bool,
}

#[derive(Debug, Serialize)]
struct BillingDeliverySyncResponse {
    status: &'static str,
    organizations_checked: usize,
    organizations_tracked: usize,
    delivery_seconds_tracked: f64,
    storage_second_months_tracked: f64,
}

#[derive(Debug, Deserialize)]
struct TierUsageRow {
    resolution_tier: String,
    value: f64,
}

#[derive(Debug)]
struct TierUsage {
    tier: ResolutionTier,
    value: f64,
}

#[derive(Debug)]
struct DeliverySyncSummary {
    organizations_checked: usize,
    organizations_tracked: usize,
    delivery_seconds_tracked: f64,
    storage_second_months_tracked: f64,
}

#[derive(Debug)]
struct BillingCustomerSeed {
    organization_id: String,
    name: String,
    email: Option<String>,
}

impl BillingConfig {
    pub(crate) fn from_env(rend_env: RendEnv) -> Result<Self> {
        let configured_mode = env_string("REND_BILLING_MODE", "");
        let mode = match configured_mode.trim().to_ascii_lowercase().as_str() {
            "" if rend_env.is_strict() => BillingMode::Autumn,
            "" => BillingMode::Local,
            "local" => BillingMode::Local,
            "autumn" => BillingMode::Autumn,
            _ => anyhow::bail!("REND_BILLING_MODE must be one of: local, autumn"),
        };
        anyhow::ensure!(
            !rend_env.is_strict() || mode == BillingMode::Autumn,
            "REND_BILLING_MODE=autumn is required in production"
        );

        let autumn_api_url = env_string("AUTUMN_API_URL", DEFAULT_AUTUMN_API_URL)
            .trim()
            .trim_end_matches('/')
            .to_owned();
        let autumn_secret_key = env_string("AUTUMN_SECRET_KEY", "");
        let autumn_api_version = env_string("AUTUMN_API_VERSION", DEFAULT_AUTUMN_API_VERSION);
        if mode == BillingMode::Autumn {
            validate_required_secret(rend_env, "AUTUMN_SECRET_KEY", &autumn_secret_key)?;
            validate_autumn_api_url(rend_env, &autumn_api_url)?;
        }

        Ok(Self {
            mode,
            autumn_api_url,
            autumn_secret_key,
            autumn_api_version,
            failure_policy: failure_policy_from_env(rend_env)?,
            delivery_features: TieredBillingFeatures::from_env(
                "REND_BILLING_FEATURE_DELIVERY",
                [
                    DEFAULT_DELIVERY_720P_FEATURE_ID,
                    DEFAULT_DELIVERY_1080P_FEATURE_ID,
                    DEFAULT_DELIVERY_2K_FEATURE_ID,
                    DEFAULT_DELIVERY_4K_FEATURE_ID,
                ],
            )?,
            storage_features: TieredBillingFeatures::from_env(
                "REND_BILLING_FEATURE_STORAGE",
                [
                    DEFAULT_STORAGE_720P_FEATURE_ID,
                    DEFAULT_STORAGE_1080P_FEATURE_ID,
                    DEFAULT_STORAGE_2K_FEATURE_ID,
                    DEFAULT_STORAGE_4K_FEATURE_ID,
                ],
            )?,
            delivery_sync_lag: env_duration_secs(
                "REND_BILLING_DELIVERY_SYNC_LAG_SECS",
                DEFAULT_DELIVERY_SYNC_LAG_SECS,
            )?,
            delivery_sync_max_window: env_duration_secs(
                "REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS",
                DEFAULT_DELIVERY_SYNC_MAX_WINDOW_SECS,
            )?,
            storage_sync_lag: env_duration_secs(
                "REND_BILLING_STORAGE_SYNC_LAG_SECS",
                DEFAULT_STORAGE_SYNC_LAG_SECS,
            )?,
            storage_sync_max_window: env_duration_secs(
                "REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS",
                DEFAULT_STORAGE_SYNC_MAX_WINDOW_SECS,
            )?,
        })
    }

    pub(crate) fn mode_name(&self) -> &'static str {
        match self.mode {
            BillingMode::Local => "local",
            BillingMode::Autumn => "autumn",
        }
    }

    fn fail_open(&self) -> bool {
        self.failure_policy == BillingFailurePolicy::FailOpen
    }
}

impl BillingFeature {
    fn new(id: String) -> Result<Self> {
        let id = id.trim().to_owned();
        anyhow::ensure!(
            !id.is_empty()
                && id.len() <= 128
                && id.bytes().all(|byte| byte.is_ascii_alphanumeric()
                    || matches!(byte, b'_' | b'-' | b'.' | b':')),
            "billing feature ids must be 1-128 safe token characters"
        );
        Ok(Self { id })
    }
}

impl TieredBillingFeatures {
    fn from_env(prefix: &str, defaults: [&str; 4]) -> Result<Self> {
        Ok(Self {
            p720: BillingFeature::new(env_string(&format!("{prefix}_720P"), defaults[0]))?,
            p1080: BillingFeature::new(env_string(&format!("{prefix}_1080P"), defaults[1]))?,
            p2k: BillingFeature::new(env_string(&format!("{prefix}_2K"), defaults[2]))?,
            p4k: BillingFeature::new(env_string(&format!("{prefix}_4K"), defaults[3]))?,
        })
    }

    fn feature_for(&self, tier: ResolutionTier) -> &BillingFeature {
        match tier {
            ResolutionTier::P720 => &self.p720,
            ResolutionTier::P1080 => &self.p1080,
            ResolutionTier::P2K => &self.p2k,
            ResolutionTier::P4K => &self.p4k,
        }
    }
}

impl ResolutionTier {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "720p" => Some(Self::P720),
            "1080p" => Some(Self::P1080),
            "2k" => Some(Self::P2K),
            "4k" => Some(Self::P4K),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::P720 => "720p",
            Self::P1080 => "1080p",
            Self::P2K => "2k",
            Self::P4K => "4k",
        }
    }
}

#[cfg(test)]
fn storage_second_months_value(duration_ms: i64, active_seconds: f64) -> f64 {
    if duration_ms <= 0 || !active_seconds.is_finite() || active_seconds <= 0.0 {
        return 0.0;
    }
    (duration_ms as f64 / 1000.0) * active_seconds / SECONDS_PER_BILLING_MONTH
}

#[cfg(test)]
fn storage_span_second_months_value(
    duration_ms: i64,
    span_start_ms: i64,
    span_end_ms: Option<i64>,
    window_start_ms: i64,
    window_end_ms: i64,
) -> f64 {
    let span_end_ms = span_end_ms.unwrap_or(window_end_ms);
    let active_ms = span_end_ms.min(window_end_ms) - span_start_ms.max(window_start_ms);
    if active_ms <= 0 {
        return 0.0;
    }
    storage_second_months_value(duration_ms, active_ms as f64 / 1000.0)
}

fn failure_policy_from_env(rend_env: RendEnv) -> Result<BillingFailurePolicy> {
    let raw = env_string("REND_BILLING_ENTITLEMENT_FAILURE_POLICY", "fail_closed");
    match raw.trim().to_ascii_lowercase().as_str() {
        "fail_closed" | "closed" => Ok(BillingFailurePolicy::FailClosed),
        "fail_open" | "open" => {
            if rend_env.is_strict() {
                tracing::warn!(
                    "REND_BILLING_ENTITLEMENT_FAILURE_POLICY=fail_open is configured in production"
                );
            }
            Ok(BillingFailurePolicy::FailOpen)
        }
        _ => anyhow::bail!(
            "REND_BILLING_ENTITLEMENT_FAILURE_POLICY must be fail_closed or fail_open"
        ),
    }
}

fn validate_autumn_api_url(rend_env: RendEnv, value: &str) -> Result<()> {
    match validate_required_url(rend_env, "AUTUMN_API_URL", value) {
        Ok(()) => Ok(()),
        Err(error) if rend_env == RendEnv::Local && is_official_autumn_api_url(value) => Ok(()),
        Err(error) => Err(error),
    }
}

fn is_official_autumn_api_url(value: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(value.trim()) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("api.useautumn.com")
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none()
        && parsed.path().trim_end_matches('/') == "/v1"
}

pub(crate) async fn ensure_customer(
    state: &AppState,
    organization_id: &str,
) -> Result<(), AppError> {
    let seed = fetch_customer_seed(&state.db, organization_id).await?;
    upsert_customer_sync(
        &state.db,
        &seed.organization_id,
        state.config.billing.mode_name(),
        None,
    )
    .await?;

    if state.config.billing.mode == BillingMode::Local {
        mark_customer_synced(
            &state.db,
            &seed.organization_id,
            state.config.billing.mode_name(),
        )
        .await?;
        return Ok(());
    }

    let body = json!({
        "customer_id": seed.organization_id,
        "name": seed.name,
        "email": seed.email,
        "metadata": {
            "source": "rend-api"
        }
    });
    match autumn_post(state, "/customers.get_or_create", body).await {
        Ok(_) => {
            mark_customer_synced(
                &state.db,
                &seed.organization_id,
                state.config.billing.mode_name(),
            )
            .await
        }
        Err(error) => {
            mark_customer_sync_failed(
                &state.db,
                &seed.organization_id,
                state.config.billing.mode_name(),
                &error.message,
            )
            .await?;
            tracing::warn!(error = %error.message, "billing customer sync failed");
            if state.config.billing.fail_open() {
                Ok(())
            } else {
                Err(AppError::limit_exceeded())
            }
        }
    }
}

pub(crate) async fn reserve_upload(
    state: &AppState,
    organization_id: &str,
    asset_id: &str,
    _content_length: Option<u64>,
) -> Result<UploadBillingReservation, AppError> {
    ensure_customer(state, organization_id).await?;

    let gate_entry = ReservedUsage {
        feature_id: state
            .config
            .billing
            .storage_features
            .feature_for(ResolutionTier::P720)
            .id
            .clone(),
        value: 0.0,
        idempotency_key: format!("asset:{asset_id}:upload-gate"),
    };
    let _ = check_usage(state, organization_id, asset_id, &gate_entry, "upload_gate").await?;

    Ok(UploadBillingReservation)
}

pub(crate) async fn refund_upload_reservation(
    _state: &AppState,
    _reservation: &UploadBillingReservation,
) {
}

pub(crate) async fn reconcile_upload_reservation(
    _state: &AppState,
    _reservation: &UploadBillingReservation,
    _actual_bytes: u64,
) {
}

pub(crate) async fn track_asset_delete(state: &AppState, organization_id: &str, asset_id: &str) {
    if state.config.billing.mode == BillingMode::Local {
        return;
    }
    if let Err(error) = sync_storage_usage(state).await {
        tracing::warn!(
            organization_id,
            asset_id,
            error = %error.message,
            "failed to flush storage usage before asset delete"
        );
    }
}

pub(crate) async fn open_asset_storage_span(
    tx: &mut Transaction<'_, Postgres>,
    asset_id: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "
        INSERT INTO rend.billing_storage_spans (
          organization_id,
          asset_id,
          duration_ms,
          resolution_tier,
          started_at
        )
        SELECT organization_id,
               id,
               duration_ms,
               max_resolution_tier,
               now()
        FROM rend.assets
        WHERE id = $1::uuid
          AND deleted_at IS NULL
          AND duration_ms IS NOT NULL
          AND duration_ms > 0
          AND max_resolution_tier IN ('720p', '1080p', '2k', '4k')
          AND playable_state IN ('opener_ready', 'hls_ready')
        ON CONFLICT (asset_id) WHERE ended_at IS NULL DO UPDATE
        SET duration_ms = EXCLUDED.duration_ms,
            resolution_tier = EXCLUDED.resolution_tier
        ",
    )
    .bind(asset_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(crate) async fn close_asset_storage_span(
    tx: &mut Transaction<'_, Postgres>,
    asset_id: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "
        UPDATE rend.billing_storage_spans
        SET ended_at = COALESCE(ended_at, now())
        WHERE asset_id = $1::uuid
          AND ended_at IS NULL
        ",
    )
    .bind(asset_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(crate) fn schedule_delivery_usage_sync(state: Arc<AppState>) {
    if state.config.billing.mode == BillingMode::Local {
        return;
    }
    let now = current_unix_secs();
    let previous = LAST_DELIVERY_SYNC_ATTEMPT.load(Ordering::Relaxed);
    if now.saturating_sub(previous) < DELIVERY_SYNC_THROTTLE_SECS {
        return;
    }
    if LAST_DELIVERY_SYNC_ATTEMPT
        .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }

    tokio::spawn(async move {
        if let Err(error) = sync_billing_usage(&state).await {
            tracing::warn!(error = %error.message, "billing usage sync failed");
        }
    });
}

pub(crate) async fn sync_delivery_usage_handler(State(state): State<Arc<AppState>>) -> Response {
    match sync_billing_usage(&state).await {
        Ok(summary) => (
            StatusCode::ACCEPTED,
            Json(BillingDeliverySyncResponse {
                status: "ok",
                organizations_checked: summary.organizations_checked,
                organizations_tracked: summary.organizations_tracked,
                delivery_seconds_tracked: summary.delivery_seconds_tracked,
                storage_second_months_tracked: summary.storage_second_months_tracked,
            }),
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}

async fn sync_billing_usage(state: &AppState) -> Result<DeliverySyncSummary, AppError> {
    let mut delivery = sync_delivery_usage(state).await?;
    let storage = sync_storage_usage(state).await?;
    delivery.organizations_checked = delivery
        .organizations_checked
        .max(storage.organizations_checked);
    delivery.organizations_tracked += storage.organizations_tracked;
    delivery.storage_second_months_tracked = storage.storage_second_months_tracked;
    Ok(delivery)
}

async fn sync_delivery_usage(state: &AppState) -> Result<DeliverySyncSummary, AppError> {
    if state.config.billing.mode == BillingMode::Local {
        return Ok(DeliverySyncSummary {
            organizations_checked: 0,
            organizations_tracked: 0,
            delivery_seconds_tracked: 0.0,
            storage_second_months_tracked: 0.0,
        });
    }

    let rows: Vec<(String, Option<i64>)> = sqlx::query_as(
        "
        SELECT organization_id::text,
               (EXTRACT(EPOCH FROM delivery_usage_cursor_at) * 1000)::bigint
        FROM rend.billing_customers
        WHERE billing_mode = 'autumn'
        ORDER BY updated_at DESC
        LIMIT 100
        ",
    )
    .fetch_all(&state.db)
    .await
    .map_err(AppError::internal)?;

    let now = Utc::now();
    let end = now
        - ChronoDuration::from_std(state.config.billing.delivery_sync_lag)
            .map_err(AppError::internal)?;
    let max_window = ChronoDuration::from_std(state.config.billing.delivery_sync_max_window)
        .map_err(AppError::internal)?;
    let mut summary = DeliverySyncSummary {
        organizations_checked: 0,
        organizations_tracked: 0,
        delivery_seconds_tracked: 0.0,
        storage_second_months_tracked: 0.0,
    };

    for (organization_id, cursor) in rows {
        summary.organizations_checked += 1;
        let cursor = cursor
            .and_then(|ms| Utc.timestamp_millis_opt(ms).single())
            .unwrap_or(end - max_window);
        let start = cursor.max(end - max_window);
        if start >= end {
            continue;
        }
        match clickhouse_delivery_seconds(state, &organization_id, start, end).await {
            Ok(usages) if !usages.is_empty() => {
                let mut tracked = 0.0;
                for usage in usages {
                    if usage.value <= 0.0 {
                        continue;
                    }
                    let feature = state
                        .config
                        .billing
                        .delivery_features
                        .feature_for(usage.tier);
                    let event = ReservedUsage {
                        feature_id: feature.id.clone(),
                        value: usage.value,
                        idempotency_key: delivery_idempotency_key(
                            &organization_id,
                            usage.tier,
                            start,
                            end,
                        ),
                    };
                    if let Err(error) = track_usage(
                        state,
                        &organization_id,
                        None,
                        &event,
                        "delivery_aggregation",
                    )
                    .await
                    {
                        update_delivery_sync_error(&state.db, &organization_id, &error.message)
                            .await?;
                        return Err(AppError::internal(error.message));
                    }
                    tracked += usage.value;
                }
                update_delivery_sync_success(&state.db, &organization_id, end).await?;
                summary.organizations_tracked += 1;
                summary.delivery_seconds_tracked += tracked;
            }
            Ok(_) => {
                update_delivery_sync_success(&state.db, &organization_id, end).await?;
            }
            Err(error) => {
                update_delivery_sync_error(&state.db, &organization_id, &error.message).await?;
                return Err(AppError::internal(error.message));
            }
        }
    }

    Ok(summary)
}

async fn sync_storage_usage(state: &AppState) -> Result<DeliverySyncSummary, AppError> {
    if state.config.billing.mode == BillingMode::Local {
        return Ok(DeliverySyncSummary {
            organizations_checked: 0,
            organizations_tracked: 0,
            delivery_seconds_tracked: 0.0,
            storage_second_months_tracked: 0.0,
        });
    }

    let rows: Vec<(String, Option<i64>)> = sqlx::query_as(
        "
        SELECT organization_id::text,
               (EXTRACT(EPOCH FROM storage_usage_cursor_at) * 1000)::bigint
        FROM rend.billing_customers
        WHERE billing_mode = 'autumn'
        ORDER BY updated_at DESC
        LIMIT 100
        ",
    )
    .fetch_all(&state.db)
    .await
    .map_err(AppError::internal)?;

    let now = Utc::now();
    let end = now
        - ChronoDuration::from_std(state.config.billing.storage_sync_lag)
            .map_err(AppError::internal)?;
    let max_window = ChronoDuration::from_std(state.config.billing.storage_sync_max_window)
        .map_err(AppError::internal)?;
    let mut summary = DeliverySyncSummary {
        organizations_checked: 0,
        organizations_tracked: 0,
        delivery_seconds_tracked: 0.0,
        storage_second_months_tracked: 0.0,
    };

    for (organization_id, cursor) in rows {
        summary.organizations_checked += 1;
        let cursor = cursor
            .and_then(|ms| Utc.timestamp_millis_opt(ms).single())
            .unwrap_or(end - max_window);
        let start = cursor.max(end - max_window);
        if start >= end {
            continue;
        }
        match postgres_storage_second_months(state, &organization_id, start, end).await {
            Ok(usages) if !usages.is_empty() => {
                let mut tracked = 0.0;
                for usage in usages {
                    if usage.value <= 0.0 {
                        continue;
                    }
                    let feature = state
                        .config
                        .billing
                        .storage_features
                        .feature_for(usage.tier);
                    let event = ReservedUsage {
                        feature_id: feature.id.clone(),
                        value: usage.value,
                        idempotency_key: storage_idempotency_key(
                            &organization_id,
                            usage.tier,
                            start,
                            end,
                        ),
                    };
                    if let Err(error) =
                        track_usage(state, &organization_id, None, &event, "storage_aggregation")
                            .await
                    {
                        update_storage_sync_error(&state.db, &organization_id, &error.message)
                            .await?;
                        return Err(AppError::internal(error.message));
                    }
                    tracked += usage.value;
                }
                update_storage_sync_success(&state.db, &organization_id, end).await?;
                summary.organizations_tracked += 1;
                summary.storage_second_months_tracked += tracked;
            }
            Ok(_) => {
                update_storage_sync_success(&state.db, &organization_id, end).await?;
            }
            Err(error) => {
                update_storage_sync_error(&state.db, &organization_id, &error.message).await?;
                return Err(AppError::internal(error.message));
            }
        }
    }

    Ok(summary)
}

async fn check_usage(
    state: &AppState,
    organization_id: &str,
    asset_id: &str,
    usage: &ReservedUsage,
    source: &str,
) -> Result<bool, AppError> {
    if insert_usage_event(&state.db, organization_id, Some(asset_id), usage, source).await?
        == UsageEventInsert::AlreadyFinalized
    {
        return Ok(true);
    }
    if state.config.billing.mode == BillingMode::Local {
        mark_usage_event(&state.db, &usage.idempotency_key, "skipped", None).await?;
        return Ok(false);
    }

    let body = json!({
        "customer_id": organization_id,
        "feature_id": usage.feature_id,
        "required_balance": usage.value,
        "send_event": false,
        "properties": {
            "idempotency_key": usage.idempotency_key,
            "source": source,
            "asset_id": asset_id
        }
    });
    match autumn_post(state, "/balances.check", body).await {
        Ok(value) => {
            let allowed = serde_json::from_value::<AutumnCheckResponse>(value)
                .map(|response| response.allowed)
                .unwrap_or(false);
            if allowed {
                mark_usage_event(&state.db, &usage.idempotency_key, "tracked", None).await?;
                Ok(true)
            } else {
                mark_usage_event(
                    &state.db,
                    &usage.idempotency_key,
                    "failed",
                    Some("limit_exceeded"),
                )
                .await?;
                Err(AppError::limit_exceeded())
            }
        }
        Err(error) => {
            mark_usage_event(
                &state.db,
                &usage.idempotency_key,
                "failed",
                Some(&error.message),
            )
            .await?;
            tracing::warn!(error = %error.message, "billing provider request failed");
            if state.config.billing.fail_open() {
                Ok(false)
            } else {
                Err(AppError::limit_exceeded())
            }
        }
    }
}

async fn track_usage(
    state: &AppState,
    organization_id: &str,
    asset_id: Option<&str>,
    usage: &ReservedUsage,
    source: &str,
) -> Result<(), BillingProviderError> {
    match insert_usage_event(&state.db, organization_id, asset_id, usage, source).await {
        Ok(UsageEventInsert::Inserted) => {}
        Ok(UsageEventInsert::AlreadyFinalized) => return Ok(()),
        Err(error) => return Err(BillingProviderError::new(error.message)),
    }
    if state.config.billing.mode == BillingMode::Local {
        let _ = mark_usage_event(&state.db, &usage.idempotency_key, "skipped", None).await;
        return Ok(());
    }
    let body = json!({
        "customer_id": organization_id,
        "feature_id": usage.feature_id,
        "value": usage.value,
        "idempotency_key": usage.idempotency_key,
        "properties": {
            "source": source,
            "asset_id": asset_id
        }
    });
    match autumn_post(state, "/balances.track", body).await {
        Ok(_) => {
            let _ = mark_usage_event(&state.db, &usage.idempotency_key, "tracked", None).await;
            Ok(())
        }
        Err(error) => {
            let _ = mark_usage_event(
                &state.db,
                &usage.idempotency_key,
                "failed",
                Some(&error.message),
            )
            .await;
            Err(error)
        }
    }
}

async fn insert_usage_event(
    db: &PgPool,
    organization_id: &str,
    asset_id: Option<&str>,
    usage: &ReservedUsage,
    source: &str,
) -> Result<UsageEventInsert, AppError> {
    let inserted: Option<String> = sqlx::query_scalar(
        "
        INSERT INTO rend.billing_usage_events (
          organization_id,
          asset_id,
          idempotency_key,
          feature_id,
          value,
          source
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id::text
        ",
    )
    .bind(organization_id)
    .bind(asset_id)
    .bind(&usage.idempotency_key)
    .bind(&usage.feature_id)
    .bind(usage.value)
    .bind(source)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    if inserted.is_some() {
        return Ok(UsageEventInsert::Inserted);
    }

    let status: Option<String> = sqlx::query_scalar(
        "
        SELECT status
        FROM rend.billing_usage_events
        WHERE idempotency_key = $1
        ",
    )
    .bind(&usage.idempotency_key)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    match status.as_deref() {
        Some("tracked" | "skipped") => Ok(UsageEventInsert::AlreadyFinalized),
        Some(_) => Err(AppError::internal(
            "billing usage event is already pending or failed",
        )),
        None => Err(AppError::internal(
            "billing usage event conflict could not be read",
        )),
    }
}

async fn mark_usage_event(
    db: &PgPool,
    idempotency_key: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "
        UPDATE rend.billing_usage_events
        SET status = $2,
            error = $3,
            tracked_at = CASE WHEN $2 IN ('tracked', 'skipped') THEN now() ELSE tracked_at END
        WHERE idempotency_key = $1
        ",
    )
    .bind(idempotency_key)
    .bind(status)
    .bind(error.map(truncate_error))
    .execute(db)
    .await
    .map_err(AppError::internal)?;
    Ok(())
}

#[derive(Debug)]
struct BillingProviderError {
    message: String,
}

impl BillingProviderError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: truncate_error(&message.into()),
        }
    }
}

async fn autumn_post(
    state: &AppState,
    path: &str,
    body: Value,
) -> Result<Value, BillingProviderError> {
    let url = format!(
        "{}{}",
        state.config.billing.autumn_api_url,
        if path.starts_with('/') {
            path.to_owned()
        } else {
            format!("/{path}")
        }
    );
    let response = state
        .http
        .post(url)
        .bearer_auth(&state.config.billing.autumn_secret_key)
        .header("x-api-version", &state.config.billing.autumn_api_version)
        .json(&body)
        .send()
        .await
        .map_err(|_| BillingProviderError::new("billing provider is unavailable"))?;
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .unwrap_or_else(|_| json!({ "error": "invalid billing provider response" }));
    if status.is_success() {
        Ok(value)
    } else {
        Err(BillingProviderError::new(
            value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("billing provider rejected the request"),
        ))
    }
}

async fn fetch_customer_seed(
    db: &PgPool,
    organization_id: &str,
) -> Result<BillingCustomerSeed, AppError> {
    let organization_id = normalize_org_id(organization_id)?;
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "
        SELECT org.id::text,
               org.name,
               min(owner_user.email) AS owner_email
        FROM rend_auth.organization org
        LEFT JOIN rend_auth.member owner_member
          ON owner_member.organization_id = org.id
         AND owner_member.role = 'owner'
        LEFT JOIN rend_auth.\"user\" owner_user
          ON owner_user.id = owner_member.user_id
        WHERE org.id = $1::uuid
        GROUP BY org.id
        ",
    )
    .bind(&organization_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::internal)?;

    let Some((organization_id, name, email)) = row else {
        return Err(AppError::forbidden("organization is not available"));
    };
    Ok(BillingCustomerSeed {
        organization_id,
        name,
        email,
    })
}

async fn upsert_customer_sync(
    db: &PgPool,
    organization_id: &str,
    billing_mode: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "
        INSERT INTO rend.billing_customers (
          organization_id,
          autumn_customer_id,
          billing_mode,
          customer_sync_error
        )
        VALUES ($1::uuid, $1::text, $2, $3)
        ON CONFLICT (organization_id) DO UPDATE
        SET billing_mode = EXCLUDED.billing_mode,
            customer_sync_error = EXCLUDED.customer_sync_error
        ",
    )
    .bind(organization_id)
    .bind(billing_mode)
    .bind(error.map(truncate_error))
    .execute(db)
    .await
    .map_err(AppError::internal)?;
    Ok(())
}

async fn mark_customer_synced(
    db: &PgPool,
    organization_id: &str,
    billing_mode: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "
        INSERT INTO rend.billing_customers (
          organization_id,
          autumn_customer_id,
          billing_mode,
          customer_synced_at,
          customer_sync_error
        )
        VALUES ($1::uuid, $1::text, $2, now(), NULL)
        ON CONFLICT (organization_id) DO UPDATE
        SET billing_mode = EXCLUDED.billing_mode,
            customer_synced_at = now(),
            customer_sync_error = NULL
        ",
    )
    .bind(organization_id)
    .bind(billing_mode)
    .execute(db)
    .await
    .map_err(AppError::internal)?;
    Ok(())
}

async fn mark_customer_sync_failed(
    db: &PgPool,
    organization_id: &str,
    billing_mode: &str,
    error: &str,
) -> Result<(), AppError> {
    upsert_customer_sync(db, organization_id, billing_mode, Some(error)).await
}

async fn update_delivery_sync_success(
    db: &PgPool,
    organization_id: &str,
    cursor: chrono::DateTime<Utc>,
) -> Result<(), AppError> {
    sqlx::query(
        "
        UPDATE rend.billing_customers
        SET delivery_usage_cursor_at = $2::timestamptz,
            delivery_usage_synced_at = now(),
            delivery_usage_error = NULL
        WHERE organization_id = $1::uuid
        ",
    )
    .bind(organization_id)
    .bind(cursor.to_rfc3339())
    .execute(db)
    .await
    .map_err(AppError::internal)?;
    Ok(())
}

async fn update_storage_sync_success(
    db: &PgPool,
    organization_id: &str,
    cursor: chrono::DateTime<Utc>,
) -> Result<(), AppError> {
    sqlx::query(
        "
        UPDATE rend.billing_customers
        SET storage_usage_cursor_at = $2::timestamptz,
            storage_usage_synced_at = now(),
            storage_usage_error = NULL
        WHERE organization_id = $1::uuid
        ",
    )
    .bind(organization_id)
    .bind(cursor.to_rfc3339())
    .execute(db)
    .await
    .map_err(AppError::internal)?;
    Ok(())
}

async fn update_delivery_sync_error(
    db: &PgPool,
    organization_id: &str,
    error: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "
        UPDATE rend.billing_customers
        SET delivery_usage_error = $2
        WHERE organization_id = $1::uuid
        ",
    )
    .bind(organization_id)
    .bind(truncate_error(error))
    .execute(db)
    .await
    .map_err(AppError::internal)?;
    Ok(())
}

async fn update_storage_sync_error(
    db: &PgPool,
    organization_id: &str,
    error: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "
        UPDATE rend.billing_customers
        SET storage_usage_error = $2
        WHERE organization_id = $1::uuid
        ",
    )
    .bind(organization_id)
    .bind(truncate_error(error))
    .execute(db)
    .await
    .map_err(AppError::internal)?;
    Ok(())
}

async fn clickhouse_delivery_seconds(
    state: &AppState,
    organization_id: &str,
    start: chrono::DateTime<Utc>,
    end: chrono::DateTime<Utc>,
) -> Result<Vec<TierUsage>, BillingProviderError> {
    let query = clickhouse_delivery_seconds_query(organization_id, start, end);
    let body = String::new();
    let response = state
        .http
        .post(&state.config.playback_telemetry.clickhouse_url)
        .basic_auth(
            &state.config.playback_telemetry.clickhouse_user,
            Some(&state.config.playback_telemetry.clickhouse_password),
        )
        .header(reqwest::header::CONTENT_LENGTH, body.len().to_string())
        .query(&[
            (
                "database",
                state.config.playback_telemetry.clickhouse_database.as_str(),
            ),
            ("query", query.as_str()),
            ("date_time_input_format", "best_effort"),
            ("output_format_json_quote_64bit_integers", "0"),
        ])
        .body(body)
        .send()
        .await
        .map_err(|_| BillingProviderError::new("ClickHouse delivery usage query failed"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(BillingProviderError::new(format!(
            "ClickHouse returned HTTP {status}"
        )));
    }
    let mut usages = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let row = serde_json::from_str::<TierUsageRow>(line)
            .with_context(|| "invalid ClickHouse delivery usage row")
            .map_err(|error| BillingProviderError::new(error.to_string()))?;
        if let Some(tier) = ResolutionTier::parse(&row.resolution_tier)
            && row.value.is_finite()
            && row.value > 0.0
        {
            usages.push(TierUsage {
                tier,
                value: row.value,
            });
        }
    }
    Ok(usages)
}

fn clickhouse_delivery_seconds_query(
    organization_id: &str,
    start: chrono::DateTime<Utc>,
    end: chrono::DateTime<Utc>,
) -> String {
    format!(
        "\
        SELECT \
          tier AS resolution_tier, \
          sum(delivered_duration_ms_value) / 1000.0 AS value \
        FROM ( \
          SELECT \
            event_id, \
            any(resolution_tier) AS tier, \
            any(delivered_duration_ms) AS delivered_duration_ms_value \
          FROM playback_events \
          WHERE organization_id = toUUID('{organization_id}') \
            AND observed_at >= fromUnixTimestamp64Milli({}) \
            AND observed_at < fromUnixTimestamp64Milli({}) \
            AND status_code >= 200 \
            AND status_code < 500 \
            AND delivered_duration_ms > 0 \
            AND resolution_tier IN ('720p', '1080p', '2k', '4k') \
          GROUP BY event_id \
        ) \
        GROUP BY tier \
        FORMAT JSONEachRow",
        start.timestamp_millis(),
        end.timestamp_millis(),
    )
}

fn delivery_idempotency_key(
    organization_id: &str,
    tier: ResolutionTier,
    start: chrono::DateTime<Utc>,
    end: chrono::DateTime<Utc>,
) -> String {
    format!(
        "delivery:{organization_id}:{}:{}:{}",
        tier.as_str(),
        start.timestamp_millis(),
        end.timestamp_millis()
    )
}

fn storage_idempotency_key(
    organization_id: &str,
    tier: ResolutionTier,
    start: chrono::DateTime<Utc>,
    end: chrono::DateTime<Utc>,
) -> String {
    format!(
        "storage:{organization_id}:{}:{}:{}",
        tier.as_str(),
        start.timestamp_millis(),
        end.timestamp_millis()
    )
}

async fn postgres_storage_second_months(
    state: &AppState,
    organization_id: &str,
    start: chrono::DateTime<Utc>,
    end: chrono::DateTime<Utc>,
) -> Result<Vec<TierUsage>, BillingProviderError> {
    let rows: Vec<(String, f64)> = sqlx::query_as(storage_second_months_query())
        .bind(organization_id)
        .bind(start.to_rfc3339())
        .bind(end.to_rfc3339())
        .bind(SECONDS_PER_BILLING_MONTH)
        .fetch_all(&state.db)
        .await
        .map_err(|error| BillingProviderError::new(error.to_string()))?;

    let mut usages = Vec::new();
    for (tier, value) in rows {
        if let Some(tier) = ResolutionTier::parse(&tier)
            && value.is_finite()
            && value > 0.0
        {
            usages.push(TierUsage { tier, value });
        }
    }
    Ok(usages)
}

fn storage_second_months_query() -> &'static str {
    "
    WITH bounds AS (
      SELECT $2::timestamptz AS start_at,
             $3::timestamptz AS end_at
    ),
    usage_spans AS (
      SELECT span.organization_id,
             span.asset_id,
             span.duration_ms,
             span.resolution_tier,
             span.started_at,
             span.ended_at
      FROM rend.billing_storage_spans span
      WHERE span.organization_id = $1::uuid

      UNION ALL

      SELECT asset.organization_id,
             asset.id AS asset_id,
             asset.duration_ms,
             asset.max_resolution_tier AS resolution_tier,
             asset.created_at AS started_at,
             asset.deleted_at AS ended_at
      FROM rend.assets asset
      WHERE asset.organization_id = $1::uuid
        AND asset.duration_ms IS NOT NULL
        AND asset.duration_ms > 0
        AND asset.max_resolution_tier IN ('720p', '1080p', '2k', '4k')
        AND asset.playable_state IN ('opener_ready', 'hls_ready', 'deleted')
        AND NOT EXISTS (
          SELECT 1
          FROM rend.billing_storage_spans existing_span
          WHERE existing_span.asset_id = asset.id
        )
    )
    SELECT usage_spans.resolution_tier,
           COALESCE(
             SUM(
               (usage_spans.duration_ms::double precision / 1000.0)
               * GREATEST(
                   0,
                   EXTRACT(EPOCH FROM (
                     LEAST(COALESCE(usage_spans.ended_at, bounds.end_at), bounds.end_at)
                     - GREATEST(usage_spans.started_at, bounds.start_at)
                   ))
                 )
               / $4::double precision
             ),
             0
           ) AS value
    FROM usage_spans
    CROSS JOIN bounds
    WHERE usage_spans.started_at < bounds.end_at
      AND COALESCE(usage_spans.ended_at, bounds.end_at) > bounds.start_at
    GROUP BY usage_spans.resolution_tier
    "
}

fn truncate_error(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .replace(['\r', '\n'], " ")
        .chars()
        .take(1000)
        .collect()
}

fn current_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_time(value: &str) -> chrono::DateTime<Utc> {
        chrono::DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn local_autumn_mode_allows_official_autumn_api_url() {
        validate_autumn_api_url(RendEnv::Local, "https://api.useautumn.com/v1").unwrap();
    }

    #[test]
    fn local_autumn_mode_still_rejects_other_external_urls() {
        let error =
            validate_autumn_api_url(RendEnv::Local, "https://billing.example.com/v1").unwrap_err();

        assert!(error.to_string().contains(
            "must point at localhost, loopback, .localhost, .local, or a Docker service"
        ));
    }

    #[test]
    fn production_autumn_mode_requires_non_local_api_url() {
        validate_autumn_api_url(RendEnv::Production, "https://api.useautumn.com/v1").unwrap();
        let error =
            validate_autumn_api_url(RendEnv::Production, "http://localhost:8080/v1").unwrap_err();

        assert!(error.to_string().contains("must not point at localhost"));
    }

    #[test]
    fn resolution_tiers_parse_required_autumn_suffixes() {
        assert_eq!(ResolutionTier::parse("720p"), Some(ResolutionTier::P720));
        assert_eq!(ResolutionTier::parse("1080p"), Some(ResolutionTier::P1080));
        assert_eq!(ResolutionTier::parse("2K"), Some(ResolutionTier::P2K));
        assert_eq!(ResolutionTier::parse("4k"), Some(ResolutionTier::P4K));
        assert_eq!(ResolutionTier::parse("source_bytes"), None);
    }

    #[test]
    fn storage_second_months_are_prorated() {
        let one_day = 24.0 * 60.0 * 60.0;
        assert_eq!(storage_second_months_value(60_000, one_day), 2.0);
        assert_eq!(storage_second_months_value(0, one_day), 0.0);
        assert_eq!(storage_second_months_value(60_000, -1.0), 0.0);
    }

    #[test]
    fn delivery_usage_query_dedupes_events_before_tier_sums() {
        let query = clickhouse_delivery_seconds_query(
            "00000000-0000-0000-0000-000000000001",
            test_time("2026-06-13T12:00:00.000Z"),
            test_time("2026-06-13T12:05:00.000Z"),
        );

        assert!(query.contains("GROUP BY event_id"));
        assert!(query.contains("sum(delivered_duration_ms_value) / 1000.0 AS value"));
        assert!(query.contains("any(delivered_duration_ms) AS delivered_duration_ms_value"));
        assert!(query.contains("resolution_tier IN ('720p', '1080p', '2k', '4k')"));
        assert!(query.contains("GROUP BY tier"));
    }

    #[test]
    fn aggregation_idempotency_keys_are_tiered_and_windowed() {
        let start = test_time("2026-06-13T12:00:00.000Z");
        let end = test_time("2026-06-13T13:00:00.000Z");
        let org_id = "00000000-0000-0000-0000-000000000001";

        assert_eq!(
            delivery_idempotency_key(org_id, ResolutionTier::P720, start, end),
            "delivery:00000000-0000-0000-0000-000000000001:720p:1781352000000:1781355600000"
        );
        assert_eq!(
            storage_idempotency_key(org_id, ResolutionTier::P4K, start, end),
            "storage:00000000-0000-0000-0000-000000000001:4k:1781352000000:1781355600000"
        );
    }

    #[test]
    fn aggregation_features_and_keys_cover_all_resolution_tiers() {
        let delivery_features = TieredBillingFeatures {
            p720: BillingFeature::new(DEFAULT_DELIVERY_720P_FEATURE_ID.to_owned()).unwrap(),
            p1080: BillingFeature::new(DEFAULT_DELIVERY_1080P_FEATURE_ID.to_owned()).unwrap(),
            p2k: BillingFeature::new(DEFAULT_DELIVERY_2K_FEATURE_ID.to_owned()).unwrap(),
            p4k: BillingFeature::new(DEFAULT_DELIVERY_4K_FEATURE_ID.to_owned()).unwrap(),
        };
        let storage_features = TieredBillingFeatures {
            p720: BillingFeature::new(DEFAULT_STORAGE_720P_FEATURE_ID.to_owned()).unwrap(),
            p1080: BillingFeature::new(DEFAULT_STORAGE_1080P_FEATURE_ID.to_owned()).unwrap(),
            p2k: BillingFeature::new(DEFAULT_STORAGE_2K_FEATURE_ID.to_owned()).unwrap(),
            p4k: BillingFeature::new(DEFAULT_STORAGE_4K_FEATURE_ID.to_owned()).unwrap(),
        };
        let start = test_time("2026-06-13T12:00:00.000Z");
        let end = test_time("2026-06-13T13:00:00.000Z");
        let org_id = "00000000-0000-0000-0000-000000000001";
        let tiers = [
            (
                ResolutionTier::P720,
                "delivery_720p_seconds",
                "storage_720p_second_months",
            ),
            (
                ResolutionTier::P1080,
                "delivery_1080p_seconds",
                "storage_1080p_second_months",
            ),
            (
                ResolutionTier::P2K,
                "delivery_2k_seconds",
                "storage_2k_second_months",
            ),
            (
                ResolutionTier::P4K,
                "delivery_4k_seconds",
                "storage_4k_second_months",
            ),
        ];

        let mut delivery_keys = std::collections::BTreeSet::new();
        let mut storage_keys = std::collections::BTreeSet::new();
        for (tier, delivery_feature, storage_feature) in tiers {
            assert_eq!(delivery_features.feature_for(tier).id, delivery_feature);
            assert_eq!(storage_features.feature_for(tier).id, storage_feature);
            assert!(delivery_keys.insert(delivery_idempotency_key(org_id, tier, start, end)));
            assert!(storage_keys.insert(storage_idempotency_key(org_id, tier, start, end)));
        }

        assert_eq!(delivery_keys.len(), 4);
        assert_eq!(storage_keys.len(), 4);
    }

    #[test]
    fn storage_query_uses_spans_with_legacy_asset_fallback() {
        let query = storage_second_months_query();

        assert!(query.contains("rend.billing_storage_spans"));
        assert!(query.contains("UNION ALL"));
        assert!(query.contains("NOT EXISTS"));
        assert!(query.contains("COALESCE(usage_spans.ended_at, bounds.end_at)"));
    }

    #[test]
    fn storage_spans_prorate_across_delete_restore_gaps() {
        let window_start = test_time("2026-06-01T00:00:00.000Z").timestamp_millis();
        let window_end = test_time("2026-06-03T00:00:00.000Z").timestamp_millis();
        let first_span_start = test_time("2026-06-01T00:00:00.000Z").timestamp_millis();
        let first_span_end = test_time("2026-06-01T12:00:00.000Z").timestamp_millis();
        let second_span_start = test_time("2026-06-02T00:00:00.000Z").timestamp_millis();
        let second_span_end = test_time("2026-06-02T12:00:00.000Z").timestamp_millis();

        let usage = storage_span_second_months_value(
            60_000,
            first_span_start,
            Some(first_span_end),
            window_start,
            window_end,
        ) + storage_span_second_months_value(
            60_000,
            second_span_start,
            Some(second_span_end),
            window_start,
            window_end,
        );

        assert_eq!(usage, 2.0);
    }
}
