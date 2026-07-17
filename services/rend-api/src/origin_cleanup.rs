use std::{sync::Arc, time::Duration};

use aws_sdk_s3::{
    Client as S3Client,
    types::{Delete, ObjectIdentifier},
};
use sqlx::{PgPool, Postgres, Transaction};

use crate::AppState;

const CLEANUP_LEASE_SECS: i32 = 120;
const MAX_RETRY_BACKOFF_SECS: i32 = 300;
const DELETE_BATCH_SIZE: usize = 1_000;

#[derive(sqlx::FromRow)]
struct CleanupJob {
    id: String,
    asset_id: String,
    bucket_kind: String,
    attempts: i32,
}

pub async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    asset_id: &str,
    source_is_media_bucket: bool,
) -> Result<(), sqlx::Error> {
    let bucket_kinds: &[&str] = if source_is_media_bucket {
        &["media"]
    } else {
        &["media", "source"]
    };
    for bucket_kind in bucket_kinds {
        sqlx::query(
            "
            INSERT INTO rend.origin_cleanup_jobs (asset_id, bucket_kind)
            VALUES ($1::uuid, $2)
            ON CONFLICT (asset_id, bucket_kind) DO UPDATE
            SET next_attempt_at = CASE
                  WHEN rend.origin_cleanup_jobs.status = 'succeeded'
                    THEN rend.origin_cleanup_jobs.next_attempt_at
                  ELSE now()
                END
            ",
        )
        .bind(asset_id)
        .bind(bucket_kind)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub fn spawn_worker(state: Arc<AppState>) {
    let worker_id = format!("api-origin-cleanup-{}", std::process::id());
    tokio::spawn(async move {
        loop {
            match claim(&state.db, &worker_id).await {
                Ok(Some(job)) => process(&state, &worker_id, job).await,
                Ok(None) => tokio::time::sleep(Duration::from_secs(1)).await,
                Err(error) => {
                    tracing::error!(error = %error, "failed to claim origin cleanup job");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

pub async fn wait_for_asset(db: &PgPool, asset_id: &str, timeout: Duration) -> i64 {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let status: Result<(i64, i64), sqlx::Error> = sqlx::query_as(
            "SELECT count(*) FILTER (WHERE status <> 'succeeded')::bigint, COALESCE(sum(objects_deleted), 0)::bigint FROM rend.origin_cleanup_jobs WHERE asset_id = $1::uuid",
        )
        .bind(asset_id)
        .fetch_one(db)
        .await;
        match status {
            Ok((0, deleted)) => return deleted,
            Ok(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Ok(_) | Err(_) => return 0,
        }
    }
}

async fn claim(db: &PgPool, worker_id: &str) -> Result<Option<CleanupJob>, sqlx::Error> {
    sqlx::query_as(
        "
        WITH candidate AS (
          SELECT id
          FROM rend.origin_cleanup_jobs
          WHERE next_attempt_at <= now()
            AND (status = 'queued' OR (status = 'cleaning' AND lease_expires_at < now()))
          ORDER BY next_attempt_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE rend.origin_cleanup_jobs job
        SET status = 'cleaning', attempts = attempts + 1, locked_by = $1,
            lease_expires_at = now() + make_interval(secs => $2)
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.id::text, job.asset_id::text, job.bucket_kind, job.attempts
        ",
    )
    .bind(worker_id)
    .bind(CLEANUP_LEASE_SECS)
    .fetch_optional(db)
    .await
}

async fn process(state: &AppState, worker_id: &str, job: CleanupJob) {
    let (s3, bucket) = if job.bucket_kind == "source" {
        (&state.source_s3, state.config.source_bucket.as_str())
    } else {
        (&state.s3, state.config.s3_bucket.as_str())
    };
    match delete_asset_prefix(s3, bucket, &job.asset_id).await {
        Ok(deleted) => {
            if let Err(error) = mark_succeeded(&state.db, &job.id, worker_id, deleted).await {
                tracing::error!(job_id = %job.id, error = %error, "failed to complete origin cleanup job");
            }
        }
        Err(error) => {
            let backoff = retry_backoff_secs(job.attempts);
            if let Err(db_error) = mark_retry(&state.db, &job.id, worker_id, backoff, &error).await
            {
                tracing::error!(job_id = %job.id, error = %db_error, "failed to reschedule origin cleanup job");
            }
            tracing::warn!(job_id = %job.id, asset_id = %job.asset_id, backoff, error, "origin cleanup will retry");
        }
    }
}

async fn delete_asset_prefix(s3: &S3Client, bucket: &str, asset_id: &str) -> Result<i64, String> {
    let prefix = format!("videos/{asset_id}/");
    let mut deleted = 0_i64;
    loop {
        let page = s3
            .list_objects_v2()
            .bucket(bucket)
            .prefix(&prefix)
            .max_keys(DELETE_BATCH_SIZE as i32)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let objects = page
            .contents()
            .iter()
            .filter_map(|object| object.key())
            .filter(|key| is_owned_key(&prefix, key))
            .map(|key| ObjectIdentifier::builder().key(key).build())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if objects.is_empty() {
            return Ok(deleted);
        }
        let count = i64::try_from(objects.len()).unwrap_or(i64::MAX);
        let delete = Delete::builder()
            .set_objects(Some(objects))
            .quiet(true)
            .build()
            .map_err(|error| error.to_string())?;
        let response = s3
            .delete_objects()
            .bucket(bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.errors().is_empty() {
            return Err(format!(
                "object store reported {} cleanup deletion errors",
                response.errors().len()
            ));
        }
        deleted = deleted.saturating_add(count);
    }
}

fn is_owned_key(prefix: &str, key: &str) -> bool {
    key.starts_with(prefix) && !key.contains("/../") && !key.contains("/./")
}

async fn mark_succeeded(
    db: &PgPool,
    job_id: &str,
    worker_id: &str,
    deleted: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE rend.origin_cleanup_jobs SET status = 'succeeded', objects_deleted = objects_deleted + $3, completed_at = now(), locked_by = NULL, lease_expires_at = NULL, last_error = NULL WHERE id = $1::uuid AND locked_by = $2 AND status = 'cleaning'",
    )
    .bind(job_id)
    .bind(worker_id)
    .bind(deleted)
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
    let error = error.chars().take(1_000).collect::<String>();
    sqlx::query(
        "UPDATE rend.origin_cleanup_jobs SET status = 'queued', next_attempt_at = now() + make_interval(secs => $3), locked_by = NULL, lease_expires_at = NULL, last_error = $4 WHERE id = $1::uuid AND locked_by = $2 AND status = 'cleaning'",
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
    let exponent = u32::try_from(attempts.saturating_sub(1).min(9)).unwrap_or(9);
    2_i32.saturating_pow(exponent).min(MAX_RETRY_BACKOFF_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_key_fence_rejects_traversal() {
        assert!(is_owned_key("videos/a/", "videos/a/source"));
        assert!(!is_owned_key("videos/a/", "videos/a/../b/source"));
        assert!(!is_owned_key("videos/a/", "videos/b/source"));
    }

    #[test]
    fn cleanup_retry_backoff_is_bounded() {
        assert_eq!(retry_backoff_secs(1), 1);
        assert_eq!(retry_backoff_secs(100), MAX_RETRY_BACKOFF_SECS);
    }
}
