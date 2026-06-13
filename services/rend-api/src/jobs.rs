use std::time::Duration;

use sqlx::{PgPool, Postgres, Transaction};

pub const JOB_TYPE_PROCESS_MEDIA: &str = "process_media";
pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_SUCCEEDED: &str = "succeeded";
pub const STATUS_FAILED: &str = "failed";

const DEFAULT_RETRY_BACKOFF_SECONDS: u64 = 5;
const MAX_RETRY_BACKOFF_SECONDS: u64 = 60;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaJob {
    pub id: String,
    pub asset_id: String,
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

pub async fn claim_next_media_job(
    db: &PgPool,
    worker_id: &str,
    lock_timeout: Duration,
) -> sqlx::Result<Option<MediaJob>> {
    let lock_timeout_seconds = duration_seconds_i64(lock_timeout);
    let row: Option<(String, String, i32, i32)> = sqlx::query_as(
        "
        WITH next_job AS (
          SELECT job.id
          FROM rend.media_jobs job
          JOIN rend.assets asset
            ON asset.id = job.asset_id
           AND asset.deleted_at IS NULL
          WHERE job.job_type = $1
            AND (
              (job.status = $2 AND job.run_after <= now())
              OR (
                job.status = $3
                AND job.locked_at IS NOT NULL
                AND job.locked_at < now() - ($5::bigint * interval '1 second')
              )
            )
          ORDER BY
            CASE WHEN job.status = $2 THEN 0 ELSE 1 END,
            job.run_after,
            job.created_at,
            job.id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE rend.media_jobs job
        SET status = $3,
            attempts = attempts + 1,
            locked_at = now(),
            locked_by = $4,
            last_error = NULL
        FROM next_job
        WHERE job.id = next_job.id
        RETURNING job.id::text, job.asset_id::text, job.attempts, job.max_attempts
        ",
    )
    .bind(JOB_TYPE_PROCESS_MEDIA)
    .bind(STATUS_QUEUED)
    .bind(STATUS_RUNNING)
    .bind(worker_id)
    .bind(lock_timeout_seconds)
    .fetch_optional(db)
    .await?;

    Ok(row.map(|(id, asset_id, attempts, max_attempts)| MediaJob {
        id,
        asset_id,
        attempts,
        max_attempts,
    }))
}

pub async fn mark_media_job_succeeded(db: &PgPool, job_id: &str) -> sqlx::Result<()> {
    sqlx::query(
        "
        UPDATE rend.media_jobs
        SET status = $2,
            locked_at = NULL,
            locked_by = NULL,
            run_after = now(),
            last_error = NULL
        WHERE id = $1::uuid
        ",
    )
    .bind(job_id)
    .bind(STATUS_SUCCEEDED)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn mark_media_job_retryable(
    db: &PgPool,
    job_id: &str,
    last_error: &str,
    run_after_delay: Duration,
) -> sqlx::Result<()> {
    let run_after_delay_seconds = duration_seconds_i64(run_after_delay);
    sqlx::query(
        "
        UPDATE rend.media_jobs
        SET status = $2,
            last_error = $3,
            locked_at = NULL,
            locked_by = NULL,
            run_after = now() + ($4::bigint * interval '1 second')
        WHERE id = $1::uuid
        ",
    )
    .bind(job_id)
    .bind(STATUS_QUEUED)
    .bind(last_error)
    .bind(run_after_delay_seconds)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn mark_media_job_failed(
    db: &PgPool,
    job_id: &str,
    last_error: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "
        UPDATE rend.media_jobs
        SET status = $2,
            last_error = $3,
            locked_at = NULL,
            locked_by = NULL,
            run_after = now()
        WHERE id = $1::uuid
        ",
    )
    .bind(job_id)
    .bind(STATUS_FAILED)
    .bind(last_error)
    .execute(db)
    .await?;
    Ok(())
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
