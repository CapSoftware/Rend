use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aws_sdk_cloudfront::{
    Client as CloudFrontClient,
    types::{InvalidationBatch, Paths},
};
use sqlx::{PgPool, Postgres, Transaction};

use crate::AppState;

const INVALIDATION_LEASE_SECS: i32 = 60;
const INVALIDATION_POLL_SECS: i32 = 5;
const MAX_RETRY_BACKOFF_SECS: i32 = 300;

#[derive(sqlx::FromRow)]
struct ClaimedInvalidation {
    id: String,
    caller_reference: String,
    paths: Vec<String>,
    invalidation_id: Option<String>,
    attempts: i32,
}

pub async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    distribution_id: Option<&str>,
    dedupe_key: &str,
    caller_reference: &str,
    paths: &[String],
) -> Result<bool, sqlx::Error> {
    let Some(distribution_id) = distribution_id else {
        return Ok(false);
    };
    if paths.is_empty() {
        return Ok(false);
    }
    let inserted = sqlx::query(
        "
        INSERT INTO rend.cloudfront_invalidations (
          distribution_id, dedupe_key, caller_reference, paths
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (dedupe_key) DO NOTHING
        ",
    )
    .bind(distribution_id)
    .bind(dedupe_key)
    .bind(caller_reference)
    .bind(paths)
    .execute(&mut **tx)
    .await?;
    Ok(inserted.rows_affected() > 0)
}

pub fn spawn_worker(state: Arc<AppState>) {
    let (Some(client), Some(distribution_id)) = (
        state.cloudfront.clone(),
        state.config.cloudfront_distribution_id.clone(),
    ) else {
        return;
    };
    let db = state.db.clone();
    let worker_nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let worker_id = format!("api-{}-{worker_nonce}", std::process::id());
    tokio::spawn(async move {
        loop {
            match claim(&db, &distribution_id, &worker_id).await {
                Ok(Some(job)) => process(&db, &client, &distribution_id, &worker_id, job).await,
                Ok(None) => tokio::time::sleep(Duration::from_secs(1)).await,
                Err(error) => {
                    tracing::error!(error = %error, "failed to claim CloudFront invalidation");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

async fn claim(
    db: &PgPool,
    distribution_id: &str,
    worker_id: &str,
) -> Result<Option<ClaimedInvalidation>, sqlx::Error> {
    sqlx::query_as(
        "
        WITH candidate AS (
          SELECT id
          FROM rend.cloudfront_invalidations
          WHERE distribution_id = $1
            AND next_attempt_at <= now()
            AND (
              status IN ('queued', 'submitted')
              OR (status = 'submitting' AND lease_expires_at < now())
            )
          ORDER BY next_attempt_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE rend.cloudfront_invalidations job
        SET status = 'submitting',
            attempts = attempts + 1,
            locked_by = $2,
            lease_expires_at = now() + make_interval(secs => $3)
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.id::text, job.caller_reference,
                  job.paths, job.invalidation_id, job.attempts
        ",
    )
    .bind(distribution_id)
    .bind(worker_id)
    .bind(INVALIDATION_LEASE_SECS)
    .fetch_optional(db)
    .await
}

async fn process(
    db: &PgPool,
    client: &CloudFrontClient,
    distribution_id: &str,
    worker_id: &str,
    job: ClaimedInvalidation,
) {
    let result = match job.invalidation_id.as_deref() {
        Some(invalidation_id) => poll(client, distribution_id, invalidation_id).await,
        None => submit(client, distribution_id, &job.caller_reference, &job.paths).await,
    };

    match result {
        Ok(InvalidationProgress::Completed(invalidation_id)) => {
            if let Err(error) = mark_completed(db, &job.id, worker_id, &invalidation_id).await {
                tracing::error!(job_id = %job.id, error = %error, "failed to mark CloudFront invalidation complete");
            }
        }
        Ok(InvalidationProgress::Pending(invalidation_id)) => {
            if let Err(error) = mark_pending(db, &job.id, worker_id, &invalidation_id).await {
                tracing::error!(job_id = %job.id, error = %error, "failed to persist CloudFront invalidation progress");
            }
        }
        Err(error) => {
            let backoff = retry_backoff_secs(job.attempts);
            if let Err(db_error) = mark_retry(db, &job.id, worker_id, backoff, &error).await {
                tracing::error!(job_id = %job.id, error = %db_error, "failed to reschedule CloudFront invalidation");
            }
            tracing::warn!(job_id = %job.id, attempts = job.attempts, backoff, error, "CloudFront invalidation will retry");
        }
    }
}

enum InvalidationProgress {
    Pending(String),
    Completed(String),
}

async fn submit(
    client: &CloudFrontClient,
    distribution_id: &str,
    caller_reference: &str,
    paths: &[String],
) -> Result<InvalidationProgress, String> {
    let path_count =
        i32::try_from(paths.len()).map_err(|_| "too many invalidation paths".to_owned())?;
    let paths = Paths::builder()
        .quantity(path_count)
        .set_items(Some(paths.to_vec()))
        .build()
        .map_err(|error| error.to_string())?;
    let batch = InvalidationBatch::builder()
        .caller_reference(caller_reference)
        .paths(paths)
        .build()
        .map_err(|error| error.to_string())?;
    let output = client
        .create_invalidation()
        .distribution_id(distribution_id)
        .invalidation_batch(batch)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let invalidation = output
        .invalidation()
        .ok_or_else(|| "CloudFront returned no invalidation".to_owned())?;
    let invalidation_id = invalidation.id().to_owned();
    if invalidation.status() == "Completed" {
        Ok(InvalidationProgress::Completed(invalidation_id))
    } else {
        Ok(InvalidationProgress::Pending(invalidation_id))
    }
}

async fn poll(
    client: &CloudFrontClient,
    distribution_id: &str,
    invalidation_id: &str,
) -> Result<InvalidationProgress, String> {
    let output = client
        .get_invalidation()
        .distribution_id(distribution_id)
        .id(invalidation_id)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let invalidation = output
        .invalidation()
        .ok_or_else(|| "CloudFront returned no invalidation".to_owned())?;
    if invalidation.status() == "Completed" {
        Ok(InvalidationProgress::Completed(invalidation_id.to_owned()))
    } else {
        Ok(InvalidationProgress::Pending(invalidation_id.to_owned()))
    }
}

async fn mark_pending(
    db: &PgPool,
    job_id: &str,
    worker_id: &str,
    invalidation_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "
        UPDATE rend.cloudfront_invalidations
        SET status = 'submitted', invalidation_id = $3,
            next_attempt_at = now() + make_interval(secs => $4),
            locked_by = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE id = $1::uuid AND locked_by = $2 AND status = 'submitting'
        ",
    )
    .bind(job_id)
    .bind(worker_id)
    .bind(invalidation_id)
    .bind(INVALIDATION_POLL_SECS)
    .execute(db)
    .await?;
    Ok(())
}

async fn mark_completed(
    db: &PgPool,
    job_id: &str,
    worker_id: &str,
    invalidation_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "
        UPDATE rend.cloudfront_invalidations
        SET status = 'succeeded', invalidation_id = $3, completed_at = now(),
            locked_by = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE id = $1::uuid AND locked_by = $2 AND status = 'submitting'
        ",
    )
    .bind(job_id)
    .bind(worker_id)
    .bind(invalidation_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn mark_retry(
    db: &PgPool,
    job_id: &str,
    worker_id: &str,
    backoff_secs: i32,
    error: &str,
) -> Result<(), sqlx::Error> {
    let error = error.chars().take(1000).collect::<String>();
    sqlx::query(
        "
        UPDATE rend.cloudfront_invalidations
        SET status = CASE WHEN invalidation_id IS NULL THEN 'queued' ELSE 'submitted' END,
            next_attempt_at = now() + make_interval(secs => $3),
            locked_by = NULL, lease_expires_at = NULL, last_error = $4
        WHERE id = $1::uuid AND locked_by = $2 AND status = 'submitting'
        ",
    )
    .bind(job_id)
    .bind(worker_id)
    .bind(backoff_secs)
    .bind(error)
    .execute(db)
    .await?;
    Ok(())
}

fn retry_backoff_secs(attempts: i32) -> i32 {
    let exponent = u32::try_from(attempts.saturating_sub(1).min(8)).unwrap_or(8);
    2_i32.saturating_pow(exponent).min(MAX_RETRY_BACKOFF_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_backoff_secs(1), 1);
        assert_eq!(retry_backoff_secs(2), 2);
        assert_eq!(retry_backoff_secs(20), 256);
    }
}
