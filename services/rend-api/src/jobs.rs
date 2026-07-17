use std::time::Duration;

use sqlx::{PgPool, Postgres, Transaction};

pub const JOB_TYPE_PROCESS_MEDIA: &str = "process_media";
pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_DEFERRED_BUDGET: &str = "deferred_budget";
pub const STATUS_SUCCEEDED: &str = "succeeded";
pub const STATUS_FAILED: &str = "failed";

const DEFAULT_RETRY_BACKOFF_SECONDS: u64 = 5;
const MAX_RETRY_BACKOFF_SECONDS: u64 = 60;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaJob {
    pub id: String,
    pub asset_id: String,
    pub lease_token: String,
    pub worker_id: String,
    pub attempts: i32,
    pub max_attempts: i32,
}

pub async fn enqueue_media_processing_job(
    tx: &mut Transaction<'_, Postgres>,
    asset_id: &str,
    max_attempts: i32,
) -> sqlx::Result<String> {
    sqlx::query_scalar(
        "
        INSERT INTO rend.media_jobs (asset_id, job_type, status, max_attempts)
        VALUES ($1::uuid, $2, $3, $4)
        RETURNING id::text
        ",
    )
    .bind(asset_id)
    .bind(JOB_TYPE_PROCESS_MEDIA)
    .bind(STATUS_QUEUED)
    .bind(max_attempts)
    .fetch_one(&mut **tx)
    .await
}

/// Claims one job while also locking the organization's quota row. The quota
/// row makes the per-organization concurrency check safe when several workers
/// claim at the same time.
pub async fn claim_next_media_job(
    db: &PgPool,
    worker_id: &str,
    lease_duration: Duration,
    max_active_jobs_per_organization: i32,
) -> sqlx::Result<Option<MediaJob>> {
    let lease_seconds = duration_seconds_i64(lease_duration);
    let row: Option<(String, String, String, String, i32, i32)> = sqlx::query_as(
        "
        WITH next_job AS (
          SELECT job.id
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
          WHERE job.job_type = $1
            AND job.attempts < job.max_attempts
            AND job.status IN ($2, $3)
            AND job.run_after <= now()
            AND (
              SELECT count(*)
              FROM rend.media_jobs active_job
              JOIN rend.assets active_asset ON active_asset.id = active_job.asset_id
              WHERE active_asset.organization_id = asset.organization_id
                AND active_job.status = $4
                AND active_job.lease_expires_at > now()
            ) < $7
          ORDER BY job.run_after,
            job.created_at,
            job.id
          FOR UPDATE OF job, quota SKIP LOCKED
          LIMIT 1
        ), claimed AS (
          UPDATE rend.media_jobs job
          SET status = $4,
              attempts = attempts + 1,
              locked_at = now(),
              locked_by = $5,
              lease_token = gen_random_uuid(),
              lease_expires_at = now() + ($6::bigint * interval '1 second'),
              heartbeat_at = now(),
              completed_at = NULL,
              last_error = NULL
          FROM next_job
          WHERE job.id = next_job.id
          RETURNING job.id, job.asset_id, job.lease_token, job.locked_by,
                    job.attempts, job.max_attempts
        ), recorded_attempt AS (
          INSERT INTO rend.media_job_attempts (
            job_id, asset_id, lease_token, worker_id, attempt, status,
            reserved_microusd
          )
          SELECT id, asset_id, lease_token, locked_by, attempts, 'running',
                 0
          FROM claimed
          RETURNING job_id
        )
        SELECT claimed.id::text,
               claimed.asset_id::text,
               claimed.lease_token::text,
               claimed.locked_by,
               claimed.attempts,
               claimed.max_attempts
        FROM claimed
        JOIN recorded_attempt ON recorded_attempt.job_id = claimed.id
        ",
    )
    .bind(JOB_TYPE_PROCESS_MEDIA)
    .bind(STATUS_QUEUED)
    .bind(STATUS_DEFERRED_BUDGET)
    .bind(STATUS_RUNNING)
    .bind(worker_id)
    .bind(lease_seconds)
    .bind(max_active_jobs_per_organization)
    .fetch_optional(db)
    .await?;

    Ok(row.map(
        |(id, asset_id, lease_token, worker_id, attempts, max_attempts)| MediaJob {
            id,
            asset_id,
            lease_token,
            worker_id,
            attempts,
            max_attempts,
        },
    ))
}

pub async fn heartbeat_media_job(
    db: &PgPool,
    job: &MediaJob,
    lease_duration: Duration,
) -> sqlx::Result<bool> {
    let lease_seconds = duration_seconds_i64(lease_duration);
    let result = sqlx::query(
        "
        WITH heartbeat AS (
          UPDATE rend.media_jobs
          SET heartbeat_at = now(),
              lease_expires_at = now() + ($4::bigint * interval '1 second')
          WHERE id = $1::uuid
            AND lease_token = $2::uuid
            AND locked_by = $3
            AND status = 'running'
            AND lease_expires_at > now()
          RETURNING id, lease_token
        )
        UPDATE rend.media_job_attempts attempt
        SET heartbeat_at = now()
        FROM heartbeat
        WHERE attempt.job_id = heartbeat.id
          AND attempt.lease_token = heartbeat.lease_token
          AND attempt.status = 'running'
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .bind(lease_seconds)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn mark_media_job_succeeded(
    db: &PgPool,
    job: &MediaJob,
    actual_microusd: i64,
    output_bytes: i64,
) -> sqlx::Result<bool> {
    finish_media_job(
        db,
        job,
        STATUS_SUCCEEDED,
        "succeeded",
        None,
        actual_microusd,
        output_bytes,
    )
    .await
}

pub async fn mark_media_job_retryable(
    db: &PgPool,
    job: &MediaJob,
    last_error: &str,
    run_after_delay: Duration,
) -> sqlx::Result<bool> {
    let run_after_delay_seconds = duration_seconds_i64(run_after_delay);
    let result = sqlx::query(
        "
        WITH released AS (
          UPDATE rend.media_jobs
          SET status = $4,
              last_error = $5,
              locked_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              run_after = now() + ($6::bigint * interval '1 second')
          WHERE id = $1::uuid
            AND lease_token = $2::uuid
            AND locked_by = $3
            AND status = 'running'
            AND lease_expires_at > now()
          RETURNING id
        )
        UPDATE rend.media_job_attempts attempt
        SET status = 'retryable', finished_at = now(), error = $5
        FROM released
        WHERE attempt.job_id = released.id
          AND attempt.lease_token = $2::uuid
          AND attempt.status = 'running'
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .bind(STATUS_QUEUED)
    .bind(last_error)
    .bind(run_after_delay_seconds)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn defer_media_job_for_budget(
    db: &PgPool,
    job: &MediaJob,
    run_after_delay: Duration,
    reason: &str,
) -> sqlx::Result<bool> {
    let delay_seconds = duration_seconds_i64(run_after_delay);
    let result = sqlx::query(
        "
        WITH deferred AS (
          UPDATE rend.media_jobs
          SET status = $4,
              attempts = GREATEST(attempts - 1, 0),
              last_error = $5,
              locked_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              run_after = now() + ($6::bigint * interval '1 second')
          WHERE id = $1::uuid
            AND lease_token = $2::uuid
            AND locked_by = $3
            AND status = 'running'
            AND lease_expires_at > now()
          RETURNING id
        )
        UPDATE rend.media_job_attempts attempt
        SET status = 'deferred_budget', finished_at = now(), error = $5
        FROM deferred
        WHERE attempt.job_id = deferred.id
          AND attempt.lease_token = $2::uuid
          AND attempt.status = 'running'
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .bind(STATUS_DEFERRED_BUDGET)
    .bind(reason)
    .bind(delay_seconds)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

async fn finish_media_job(
    db: &PgPool,
    job: &MediaJob,
    job_status: &str,
    attempt_status: &str,
    last_error: Option<&str>,
    actual_microusd: i64,
    output_bytes: i64,
) -> sqlx::Result<bool> {
    let result = sqlx::query(
        "
        WITH finished AS (
          UPDATE rend.media_jobs
          SET status = $4,
              last_error = $5,
              actual_microusd = $6,
              output_bytes = CASE WHEN $7 > 0 THEN $7 ELSE output_bytes END,
              locked_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              completed_at = now(),
              run_after = now()
          WHERE id = $1::uuid
            AND lease_token = $2::uuid
            AND locked_by = $3
            AND status = 'running'
            AND lease_expires_at > now()
          RETURNING id
        )
        UPDATE rend.media_job_attempts attempt
        SET status = $8,
            actual_microusd = $6,
            output_bytes = $7,
            finished_at = now(),
            error = $5
        FROM finished
        WHERE attempt.job_id = finished.id
          AND attempt.lease_token = $2::uuid
          AND attempt.status = 'running'
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .bind(job_status)
    .bind(last_error)
    .bind(actual_microusd.max(0))
    .bind(output_bytes.max(0))
    .bind(attempt_status)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub fn retry_backoff(attempts: i32) -> Duration {
    let attempts = attempts.max(1) as u32;
    let seconds = DEFAULT_RETRY_BACKOFF_SECONDS
        .saturating_mul(2_u64.saturating_pow(attempts.saturating_sub(1)))
        .min(MAX_RETRY_BACKOFF_SECONDS);
    Duration::from_secs(seconds)
}

pub fn is_final_attempt(attempts: i32, max_attempts: i32) -> bool {
    attempts >= max_attempts
}

fn duration_seconds_i64(duration: Duration) -> i64 {
    i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_attempt_uses_claimed_attempt_count() {
        assert!(!is_final_attempt(1, 3));
        assert!(!is_final_attempt(2, 3));
        assert!(is_final_attempt(3, 3));
        assert!(is_final_attempt(4, 3));
    }

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_backoff(1), Duration::from_secs(5));
        assert_eq!(retry_backoff(2), Duration::from_secs(10));
        assert_eq!(retry_backoff(3), Duration::from_secs(20));
        assert_eq!(retry_backoff(10), Duration::from_secs(60));
    }
}
