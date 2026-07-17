use std::time::Duration;

use sqlx::PgPool;

use crate::jobs::MediaJob;

const MICROS_PER_DOLLAR: i64 = 1_000_000;
const ABSOLUTE_TASK_LIMIT: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug)]
pub struct ComputeBudgetConfig {
    pub monthly_cap_microusd: i64,
    pub monthly_base_microusd: i64,
    pub per_job_ceiling_microusd: i64,
    pub task_microusd_per_second: i64,
    pub output_microusd_per_gib: i64,
    pub safety_factor: u32,
}

impl Default for ComputeBudgetConfig {
    fn default() -> Self {
        Self {
            monthly_cap_microusd: 250 * MICROS_PER_DOLLAR,
            monthly_base_microusd: 154 * MICROS_PER_DOLLAR,
            per_job_ceiling_microusd: 25 * MICROS_PER_DOLLAR,
            // Four x86 vCPU, 8 GiB memory, and one public IPv4 in us-east-1,
            // rounded upward from the current per-second rates.
            task_microusd_per_second: 57,
            // Conservatively reserve AWS internet egress written to Tigris.
            // The AWS free data-transfer tier is intentionally not assumed.
            output_microusd_per_gib: 100_000,
            safety_factor: 2,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputeEstimate {
    pub reserved_microusd: i64,
    pub task_deadline: Duration,
}

#[derive(Debug)]
pub enum Admission {
    Reserved(ComputeEstimate),
    DeferredBudget,
    ExceedsJobCeiling,
    LeaseLost,
}

pub fn estimate_compute(
    config: &ComputeBudgetConfig,
    duration_ms: i64,
    width: i32,
    height: i32,
    estimated_output_bytes: i64,
) -> ComputeEstimate {
    let source_seconds = u64::try_from(duration_ms.max(1))
        .unwrap_or(u64::MAX)
        .div_ceil(1_000);
    let pixels = i64::from(width.max(1)).saturating_mul(i64::from(height.max(1)));
    let complexity_millis = match pixels {
        value if value > 3_840_i64 * 2_160 => 4_000_u64,
        value if value > 1_920_i64 * 1_080 => 3_000_u64,
        value if value > 1_280_i64 * 720 => 2_000_u64,
        _ => 1_000_u64,
    };
    let safety = u64::from(config.safety_factor.max(1));
    let estimated_runtime_seconds = source_seconds
        .saturating_mul(complexity_millis)
        .div_ceil(1_000)
        .saturating_mul(safety)
        .max(60);
    let compute_microusd = i64::try_from(estimated_runtime_seconds)
        .unwrap_or(i64::MAX)
        .saturating_mul(config.task_microusd_per_second.max(1));
    let transfer_microusd = output_transfer_microusd(config, estimated_output_bytes)
        .saturating_mul(i64::from(config.safety_factor.max(1)));
    let reserved_microusd = compute_microusd.saturating_add(transfer_microusd);
    let affordable_seconds = u64::try_from(
        reserved_microusd
            .checked_div(config.task_microusd_per_second.max(1))
            .unwrap_or(0),
    )
    .unwrap_or(u64::MAX);

    ComputeEstimate {
        reserved_microusd,
        task_deadline: Duration::from_secs(affordable_seconds.max(60)).min(ABSOLUTE_TASK_LIMIT),
    }
}

pub fn output_transfer_microusd(config: &ComputeBudgetConfig, output_bytes: i64) -> i64 {
    const GIB: i64 = 1024 * 1024 * 1024;
    output_bytes
        .max(0)
        .saturating_add(GIB - 1)
        .checked_div(GIB)
        .unwrap_or(i64::MAX)
        .saturating_mul(config.output_microusd_per_gib.max(0))
}

pub async fn reserve_compute(
    db: &PgPool,
    job: &MediaJob,
    config: &ComputeBudgetConfig,
    estimate: ComputeEstimate,
) -> sqlx::Result<Admission> {
    if estimate.reserved_microusd > config.per_job_ceiling_microusd {
        return Ok(Admission::ExceedsJobCeiling);
    }
    let mut tx = db.begin().await?;
    let active_reservation: Option<i64> = sqlx::query_scalar(
        "
        SELECT reserved_microusd FROM rend.media_jobs
        WHERE id = $1::uuid AND lease_token = $2::uuid
          AND locked_by = $3 AND status = 'running'
          AND lease_expires_at > now()
        FOR UPDATE
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(active_reservation) = active_reservation else {
        tx.commit().await?;
        return Ok(Admission::LeaseLost);
    };
    if active_reservation > 0 {
        let affordable_seconds = u64::try_from(
            active_reservation
                .checked_div(config.task_microusd_per_second.max(1))
                .unwrap_or(0),
        )
        .unwrap_or(u64::MAX);
        tx.commit().await?;
        return Ok(Admission::Reserved(ComputeEstimate {
            reserved_microusd: active_reservation,
            task_deadline: Duration::from_secs(affordable_seconds.max(60)).min(ABSOLUTE_TASK_LIMIT),
        }));
    }
    sqlx::query(
        "
        INSERT INTO rend.media_compute_months (month, cap_microusd, base_microusd)
        VALUES (date_trunc('month', now())::date, $1, $2)
        ON CONFLICT (month) DO UPDATE
        SET cap_microusd = EXCLUDED.cap_microusd,
            base_microusd = EXCLUDED.base_microusd
        ",
    )
    .bind(config.monthly_cap_microusd)
    .bind(config.monthly_base_microusd)
    .execute(&mut *tx)
    .await?;
    let (cap, base, reserved, spent): (i64, i64, i64, i64) = sqlx::query_as(
        "
        SELECT cap_microusd, base_microusd, reserved_microusd, spent_microusd
        FROM rend.media_compute_months
        WHERE month = date_trunc('month', now())::date
        FOR UPDATE
        ",
    )
    .fetch_one(&mut *tx)
    .await?;
    let available = cap
        .saturating_sub(base)
        .saturating_sub(reserved)
        .saturating_sub(spent);
    if available < estimate.reserved_microusd {
        tx.commit().await?;
        return Ok(Admission::DeferredBudget);
    }
    sqlx::query(
        "
        UPDATE rend.media_compute_months
        SET reserved_microusd = reserved_microusd + $1
        WHERE month = date_trunc('month', now())::date
        ",
    )
    .bind(estimate.reserved_microusd)
    .execute(&mut *tx)
    .await?;
    let updated = sqlx::query(
        "
        UPDATE rend.media_jobs
        SET reserved_microusd = $4,
            reservation_month = date_trunc('month', now())::date
        WHERE id = $1::uuid AND lease_token = $2::uuid AND locked_by = $3
          AND status = 'running'
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .bind(estimate.reserved_microusd)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        tx.rollback().await?;
        return Ok(Admission::LeaseLost);
    }
    sqlx::query(
        "
        UPDATE rend.media_job_attempts
        SET reserved_microusd = $3,
            reservation_month = date_trunc('month', now())::date
        WHERE job_id = $1::uuid AND lease_token = $2::uuid AND status = 'running'
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(estimate.reserved_microusd)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Admission::Reserved(estimate))
}

pub async fn reconcile_compute(
    db: &PgPool,
    job: &MediaJob,
    actual_microusd: i64,
) -> sqlx::Result<bool> {
    let actual_microusd = actual_microusd.max(0);
    let mut tx = db.begin().await?;
    let reservation: Option<(i64, Option<String>)> = sqlx::query_as(
        "
        SELECT reserved_microusd, reservation_month::text FROM rend.media_jobs
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
    let Some((reserved, reservation_month)) = reservation else {
        tx.commit().await?;
        return Ok(false);
    };
    if reserved > 0 && reservation_month.is_none() {
        return Err(sqlx::Error::Protocol(
            "media compute reservation is missing its accounting month".into(),
        ));
    }
    let settled = sqlx::query(
        "
        UPDATE rend.media_compute_months
        SET reserved_microusd = GREATEST(reserved_microusd - $1, 0),
            spent_microusd = spent_microusd + $2
        WHERE month = $3::date
        ",
    )
    .bind(reserved)
    .bind(actual_microusd)
    .bind(reservation_month.as_deref())
    .execute(&mut *tx)
    .await?;
    if reserved > 0 && settled.rows_affected() != 1 {
        return Err(sqlx::Error::Protocol(
            "media compute reservation month has no accounting row".into(),
        ));
    }
    sqlx::query(
        "
        UPDATE rend.media_jobs
        SET actual_microusd = $4,
            reserved_microusd = 0,
            reservation_month = NULL
        WHERE id = $1::uuid AND lease_token = $2::uuid AND locked_by = $3
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .bind(actual_microusd)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "
        UPDATE rend.media_job_attempts SET actual_microusd = $3
        WHERE job_id = $1::uuid AND lease_token = $2::uuid AND status = 'running'
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(actual_microusd)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_uses_two_x_safety_and_a_bounded_deadline() {
        let config = ComputeBudgetConfig::default();
        let hd = estimate_compute(&config, 60_000, 1920, 1080, 512 * 1024 * 1024);
        let uhd = estimate_compute(&config, 60_000, 3840, 2160, 2 * 1024 * 1024 * 1024);
        assert!(uhd.reserved_microusd > hd.reserved_microusd);
        assert!(uhd.task_deadline <= ABSOLUTE_TASK_LIMIT);
        assert!(hd.reserved_microusd > 0);
        assert_eq!(output_transfer_microusd(&config, 1), 100_000);
        assert_eq!(
            output_transfer_microusd(&config, 2 * 1024 * 1024 * 1024),
            200_000
        );
    }
}
