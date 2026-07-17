use std::{collections::BTreeSet, fmt, time::Duration};

use aws_sdk_s3::{
    Client as S3Client,
    presigning::PresigningConfig,
    types::{CompletedMultipartUpload, CompletedPart},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};

use crate::{events, jobs};

pub const DEFAULT_PART_SIZE: u64 = 16 * 1024 * 1024;
pub const MAX_PARALLEL_PARTS: u8 = 6;
pub const MAX_PART_URLS_PER_REQUEST: usize = 10;
pub const MAX_MULTIPART_PARTS: u64 = 10_000;

#[derive(Clone)]
pub struct UploadLimits {
    pub part_size: u64,
    pub session_ttl: Duration,
    pub signed_url_ttl: Duration,
    pub video_limit: i32,
    pub organization_byte_limit: i64,
    pub global_byte_limit: i64,
    pub max_open_sessions: i64,
    pub media_job_max_attempts: i32,
    pub max_upload_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct CreateUploadInput {
    pub organization_id: String,
    pub idempotency_key: String,
    pub content_type: String,
    pub content_length: i64,
    pub filename: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct UploadSession {
    pub asset_id: String,
    pub upload_id: String,
    pub part_size: u64,
    pub part_count: u64,
    pub max_parallel_parts: u8,
    pub expires_at: String,
    pub status: String,
    pub uploaded_parts: Vec<UploadedPart>,
}

#[derive(Clone, Debug, Serialize)]
pub struct UploadedPart {
    pub part_number: i32,
    pub etag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum_sha256: Option<String>,
    pub size: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RequestedPart {
    pub part_number: i32,
    pub checksum_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SignedPart {
    pub part_number: i32,
    pub url: String,
    pub method: &'static str,
    pub headers: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SignedPartsResponse {
    pub upload_id: String,
    pub parts: Vec<SignedPart>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CompletedUploadPart {
    pub part_number: i32,
    pub etag: String,
    pub checksum_sha256: String,
}

#[derive(Debug)]
pub enum UploadError {
    Invalid(String),
    NotFound,
    Conflict(String),
    Quota(String),
    TooLarge(String),
    Unavailable(String),
    Storage(String),
    Database(sqlx::Error),
}

impl fmt::Display for UploadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message)
            | Self::Conflict(message)
            | Self::Quota(message)
            | Self::TooLarge(message)
            | Self::Unavailable(message)
            | Self::Storage(message) => formatter.write_str(message),
            Self::NotFound => formatter.write_str("upload session not found"),
            Self::Database(_) => formatter.write_str("upload database operation failed"),
        }
    }
}

impl std::error::Error for UploadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            _ => None,
        }
    }
}

impl From<sqlx::Error> for UploadError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

pub async fn create_upload_session(
    db: &PgPool,
    s3: &S3Client,
    bucket: &str,
    limits: &UploadLimits,
    input: CreateUploadInput,
) -> Result<UploadSession, UploadError> {
    validate_create_input(limits, &input)?;
    if let Some(existing) = find_idempotent_session(db, &input).await? {
        return Ok(existing);
    }

    let (asset_id, session_id): (String, String) =
        sqlx::query_as("SELECT gen_random_uuid()::text, gen_random_uuid()::text")
            .fetch_one(db)
            .await?;
    let object_key = source_object_key(&asset_id);
    let provider = s3
        .create_multipart_upload()
        .bucket(bucket)
        .key(&object_key)
        .content_type(&input.content_type)
        .send()
        .await
        .map_err(|error| UploadError::Storage(error.to_string()))?;
    let provider_upload_id = provider
        .upload_id()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| UploadError::Storage("object store omitted multipart upload id".into()))?
        .to_owned();

    let result = reserve_and_insert_session(
        db,
        limits,
        &input,
        &asset_id,
        &session_id,
        &provider_upload_id,
        &object_key,
    )
    .await;
    match result {
        Ok(session) => Ok(session),
        Err(error) => {
            if let Err(abort_error) = s3
                .abort_multipart_upload()
                .bucket(bucket)
                .key(&object_key)
                .upload_id(&provider_upload_id)
                .send()
                .await
            {
                tracing::warn!(
                    asset_id,
                    error = %abort_error,
                    "failed to abort multipart upload after reservation rejection",
                );
            }
            if matches!(&error, UploadError::Database(db_error) if db_error.as_database_error().is_some())
            {
                if let Some(existing) = find_idempotent_session(db, &input).await? {
                    return Ok(existing);
                }
            }
            Err(error)
        }
    }
}

async fn reserve_and_insert_session(
    db: &PgPool,
    limits: &UploadLimits,
    input: &CreateUploadInput,
    asset_id: &str,
    session_id: &str,
    provider_upload_id: &str,
    object_key: &str,
) -> Result<UploadSession, UploadError> {
    let mut tx = db.begin().await?;
    ensure_organization_available_tx(&mut tx, &input.organization_id).await?;
    sqlx::query(
        "
        INSERT INTO rend.organization_storage_usage (
          organization_id, video_limit, byte_limit
        )
        VALUES ($1::uuid, $2, $3)
        ON CONFLICT (organization_id) DO NOTHING
        ",
    )
    .bind(&input.organization_id)
    .bind(limits.video_limit)
    .bind(limits.organization_byte_limit)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "
        INSERT INTO rend.global_storage_usage (singleton, byte_limit)
        VALUES (true, $1)
        ON CONFLICT (singleton) DO UPDATE SET byte_limit = EXCLUDED.byte_limit
        ",
    )
    .bind(limits.global_byte_limit)
    .execute(&mut *tx)
    .await?;

    let (org_reserved, org_used, video_limit, org_byte_limit): (i64, i64, i32, i64) =
        sqlx::query_as(
            "
            SELECT reserved_bytes, used_bytes, video_limit, byte_limit
            FROM rend.organization_storage_usage
            WHERE organization_id = $1::uuid
            FOR UPDATE
            ",
        )
        .bind(&input.organization_id)
        .fetch_one(&mut *tx)
        .await?;
    let (global_reserved, global_used, global_byte_limit): (i64, i64, i64) = sqlx::query_as(
        "
        SELECT reserved_bytes, used_bytes, byte_limit
        FROM rend.global_storage_usage
        WHERE singleton = true
        FOR UPDATE
        ",
    )
    .fetch_one(&mut *tx)
    .await?;
    let video_count: i64 = sqlx::query_scalar(
        "
        SELECT count(*)
        FROM rend.assets
        WHERE organization_id = $1::uuid AND deleted_at IS NULL
        ",
    )
    .bind(&input.organization_id)
    .fetch_one(&mut *tx)
    .await?;
    if video_count >= i64::from(video_limit) {
        return Err(UploadError::Quota(format!(
            "organization has reached its {video_limit}-video limit"
        )));
    }
    let open_sessions: i64 = sqlx::query_scalar(
        "
        SELECT count(*)
        FROM rend.upload_sessions
        WHERE organization_id = $1::uuid
          AND status IN ('uploading', 'completing')
          AND expires_at > now()
        ",
    )
    .bind(&input.organization_id)
    .fetch_one(&mut *tx)
    .await?;
    if open_sessions >= limits.max_open_sessions {
        return Err(UploadError::Quota(format!(
            "organization has reached its {} open upload session limit",
            limits.max_open_sessions
        )));
    }
    ensure_capacity(
        org_reserved,
        org_used,
        input.content_length,
        org_byte_limit,
        "organization storage allowance",
    )?;
    ensure_capacity(
        global_reserved,
        global_used,
        input.content_length,
        global_byte_limit,
        "platform storage budget",
    )?;

    let part_size = effective_part_size(input.content_length as u64, limits.part_size);
    let part_count = part_count(input.content_length as u64, part_size);
    sqlx::query(
        "
        INSERT INTO rend.assets (id, organization_id, source_state, playable_state)
        VALUES ($1::uuid, $2::uuid, 'uploading', 'not_playable')
        ",
    )
    .bind(asset_id)
    .bind(&input.organization_id)
    .execute(&mut *tx)
    .await?;
    events::insert_asset_event(
        &mut tx,
        asset_id,
        events::EVENT_ASSET_CREATED,
        events::asset_created_metadata("uploading", "not_playable"),
    )
    .await?;
    events::insert_asset_event(
        &mut tx,
        asset_id,
        events::EVENT_SOURCE_UPLOAD_STARTED,
        events::source_upload_started_metadata(&input.content_type, Some(input.content_length)),
    )
    .await?;
    sqlx::query(
        "
        INSERT INTO rend.upload_sessions (
          id, organization_id, asset_id, provider_upload_id, object_key,
          content_type, content_length, filename, part_size, part_count,
          idempotency_key, status, expires_at
        )
        VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
          $11, 'uploading', now() + ($12::bigint * interval '1 second')
        )
        ",
    )
    .bind(session_id)
    .bind(&input.organization_id)
    .bind(asset_id)
    .bind(provider_upload_id)
    .bind(object_key)
    .bind(&input.content_type)
    .bind(input.content_length)
    .bind(input.filename.as_deref())
    .bind(
        i32::try_from(part_size).map_err(|_| {
            UploadError::Invalid("multipart part size exceeds database range".into())
        })?,
    )
    .bind(
        i32::try_from(part_count)
            .map_err(|_| UploadError::Invalid("multipart upload has too many parts".into()))?,
    )
    .bind(&input.idempotency_key)
    .bind(duration_seconds(limits.session_ttl))
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "
        UPDATE rend.organization_storage_usage
        SET reserved_bytes = reserved_bytes + $2
        WHERE organization_id = $1::uuid
        ",
    )
    .bind(&input.organization_id)
    .bind(input.content_length)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE rend.global_storage_usage SET reserved_bytes = reserved_bytes + $1 WHERE singleton",
    )
    .bind(input.content_length)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "
        INSERT INTO rend.storage_ledger_entries (
          organization_id, asset_id, reference_key, reason, reserved_bytes_delta
        )
        VALUES ($1::uuid, $2::uuid, $3, 'source_upload_reserved', $4)
        ",
    )
    .bind(&input.organization_id)
    .bind(asset_id)
    .bind(format!("upload:{session_id}:reserve"))
    .bind(input.content_length)
    .execute(&mut *tx)
    .await?;
    let expires_at: String = sqlx::query_scalar(
        "SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM rend.upload_sessions WHERE id = $1::uuid",
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(UploadSession {
        asset_id: asset_id.to_owned(),
        upload_id: session_id.to_owned(),
        part_size,
        part_count,
        max_parallel_parts: MAX_PARALLEL_PARTS,
        expires_at,
        status: "uploading".to_owned(),
        uploaded_parts: Vec::new(),
    })
}

pub async fn sign_upload_parts(
    db: &PgPool,
    s3: &S3Client,
    bucket: &str,
    organization_id: &str,
    upload_id: &str,
    requested: &[RequestedPart],
    signed_url_ttl: Duration,
) -> Result<SignedPartsResponse, UploadError> {
    if requested.is_empty() || requested.len() > MAX_PART_URLS_PER_REQUEST {
        return Err(UploadError::Invalid(format!(
            "parts must contain between 1 and {MAX_PART_URLS_PER_REQUEST} entries"
        )));
    }
    let mut tx = db.begin().await?;
    let record = active_session_record_tx(&mut tx, organization_id, upload_id).await?;
    ensure_upload_session_available_tx(&mut tx, organization_id, upload_id).await?;
    let mut seen = BTreeSet::new();
    let presigning = PresigningConfig::expires_in(signed_url_ttl)
        .map_err(|error| UploadError::Invalid(error.to_string()))?;
    let mut parts = Vec::with_capacity(requested.len());
    for part in requested {
        if part.part_number < 1
            || i64::from(part.part_number) > record.part_count
            || !seen.insert(part.part_number)
        {
            return Err(UploadError::Invalid(
                "part numbers must be unique and within this upload session".into(),
            ));
        }
        validate_sha256(&part.checksum_sha256)?;
        let request = s3
            .upload_part()
            .bucket(bucket)
            .key(&record.object_key)
            .upload_id(&record.provider_upload_id)
            .part_number(part.part_number)
            .checksum_sha256(&part.checksum_sha256)
            .presigned(presigning.clone())
            .await
            .map_err(|error| UploadError::Storage(error.to_string()))?;
        let mut headers = std::collections::BTreeMap::new();
        headers.insert(
            "x-amz-checksum-sha256".to_owned(),
            part.checksum_sha256.clone(),
        );
        parts.push(SignedPart {
            part_number: part.part_number,
            url: request.uri().to_string(),
            method: "PUT",
            headers,
        });
    }
    tx.commit().await?;
    Ok(SignedPartsResponse {
        upload_id: upload_id.to_owned(),
        parts,
    })
}

pub async fn get_upload_session(
    db: &PgPool,
    s3: &S3Client,
    bucket: &str,
    organization_id: &str,
    upload_id: &str,
) -> Result<UploadSession, UploadError> {
    let record = session_record(db, organization_id, upload_id).await?;
    let uploaded_parts = if matches!(record.status.as_str(), "uploading" | "completing") {
        list_uploaded_parts(s3, bucket, &record).await?
    } else {
        Vec::new()
    };
    Ok(record.to_response(uploaded_parts))
}

pub async fn complete_upload_session(
    db: &PgPool,
    s3: &S3Client,
    bucket: &str,
    organization_id: &str,
    upload_id: &str,
    parts: &[CompletedUploadPart],
    media_job_max_attempts: i32,
) -> Result<UploadSession, UploadError> {
    let record = session_record(db, organization_id, upload_id).await?;
    let mut tx = db.begin().await?;
    let status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM rend.upload_sessions WHERE id = $1::uuid AND organization_id = $2::uuid FOR UPDATE",
    )
    .bind(upload_id)
    .bind(organization_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(status) = status else {
        return Err(UploadError::NotFound);
    };
    if status == "completed" {
        tx.commit().await?;
        return get_upload_session(db, s3, bucket, organization_id, upload_id).await;
    }
    if !matches!(status.as_str(), "uploading" | "completing") {
        return Err(UploadError::Conflict(format!(
            "upload session is {}",
            status
        )));
    }
    ensure_upload_session_available_tx(&mut tx, organization_id, upload_id).await?;
    validate_completed_parts(parts, record.part_count)?;
    let claimed = sqlx::query(
        "
        UPDATE rend.upload_sessions
        SET status = 'completing'
        WHERE id = $1::uuid AND organization_id = $2::uuid
          AND status IN ('uploading', 'completing') AND expires_at > now()
        ",
    )
    .bind(upload_id)
    .bind(organization_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if claimed != 1 {
        return Err(UploadError::Conflict("upload session has expired".into()));
    }

    let completed_parts = parts
        .iter()
        .map(|part| {
            CompletedPart::builder()
                .part_number(part.part_number)
                .e_tag(part.etag.trim_matches('"'))
                .checksum_sha256(&part.checksum_sha256)
                .build()
        })
        .collect::<Vec<_>>();
    let completed_upload = CompletedMultipartUpload::builder()
        .set_parts(Some(completed_parts))
        .build();
    if let Err(complete_error) = s3
        .complete_multipart_upload()
        .bucket(bucket)
        .key(&record.object_key)
        .upload_id(&record.provider_upload_id)
        .multipart_upload(completed_upload)
        .send()
        .await
    {
        if s3
            .head_object()
            .bucket(bucket)
            .key(&record.object_key)
            .send()
            .await
            .is_err()
        {
            sqlx::query(
                "UPDATE rend.upload_sessions SET status = 'uploading' WHERE id = $1::uuid AND status = 'completing'",
            )
            .bind(upload_id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Err(UploadError::Storage(complete_error.to_string()));
        }
    }
    let head = s3
        .head_object()
        .bucket(bucket)
        .key(&record.object_key)
        .send()
        .await
        .map_err(|error| UploadError::Storage(error.to_string()))?;
    let byte_size = head
        .content_length()
        .ok_or_else(|| UploadError::Storage("completed source omitted content length".into()))?;
    if byte_size != record.content_length {
        s3.delete_object()
            .bucket(bucket)
            .key(&record.object_key)
            .send()
            .await
            .map_err(|error| {
                UploadError::Storage(format!(
                    "failed to delete invalid completed source: {error}"
                ))
            })?;
        release_upload_reservation_tx(&mut tx, &record, "failed").await?;
        tx.commit().await?;
        return Err(UploadError::Conflict(format!(
            "completed source size {byte_size} does not match declared size {}",
            record.content_length
        )));
    }

    finalize_completed_upload(&mut tx, &record, byte_size, media_job_max_attempts).await?;
    tx.commit().await?;
    get_upload_session(db, s3, bucket, organization_id, upload_id).await
}

pub async fn abort_upload_session(
    db: &PgPool,
    s3: &S3Client,
    bucket: &str,
    organization_id: &str,
    upload_id: &str,
) -> Result<(), UploadError> {
    let record = session_record(db, organization_id, upload_id).await?;
    let mut tx = db.begin().await?;
    let status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM rend.upload_sessions WHERE id = $1::uuid AND organization_id = $2::uuid FOR UPDATE",
    )
    .bind(upload_id)
    .bind(organization_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(status) = status else {
        return Err(UploadError::NotFound);
    };
    if matches!(status.as_str(), "aborted" | "expired") {
        tx.commit().await?;
        return Ok(());
    }
    if status == "completed" {
        return Err(UploadError::Conflict(
            "completed uploads must be removed through the asset delete endpoint".into(),
        ));
    }
    abort_provider_upload_or_completed_object(s3, bucket, &record).await?;
    release_upload_reservation_tx(&mut tx, &record, "aborted").await?;
    tx.commit().await?;
    Ok(())
}

pub async fn abort_active_asset_upload(
    db: &PgPool,
    s3: &S3Client,
    bucket: &str,
    organization_id: &str,
    asset_id: &str,
) -> Result<(), UploadError> {
    let upload_id: Option<String> = sqlx::query_scalar(
        "
        SELECT id::text FROM rend.upload_sessions
        WHERE organization_id = $1::uuid AND asset_id = $2::uuid
          AND status IN ('uploading', 'completing')
        ",
    )
    .bind(organization_id)
    .bind(asset_id)
    .fetch_optional(db)
    .await?;
    if let Some(upload_id) = upload_id {
        abort_upload_session(db, s3, bucket, organization_id, &upload_id).await?;
    }
    Ok(())
}

pub async fn expire_upload_sessions(
    db: &PgPool,
    s3: &S3Client,
    bucket: &str,
    limit: i64,
) -> Result<u64, UploadError> {
    let rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        i32,
        i32,
        String,
        String,
    )> = sqlx::query_as(
        "
        SELECT id::text, organization_id::text, asset_id::text,
               provider_upload_id, object_key, content_type, content_length,
               part_size, part_count,
               to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               status
        FROM rend.upload_sessions
        WHERE status IN ('uploading', 'completing') AND expires_at <= now()
        ORDER BY expires_at, id
        LIMIT $1
        ",
    )
    .bind(limit.clamp(1, 1_000))
    .fetch_all(db)
    .await?;
    let mut expired = 0_u64;
    for row in rows {
        let record = SessionRecord::from_row(row);
        let mut tx = db.begin().await?;
        let eligible: Option<bool> = sqlx::query_scalar(
            "SELECT expires_at <= now() FROM rend.upload_sessions WHERE id = $1::uuid AND status IN ('uploading', 'completing') FOR UPDATE",
        )
        .bind(&record.upload_id)
        .fetch_optional(&mut *tx)
        .await?;
        if eligible != Some(true) {
            tx.commit().await?;
            continue;
        }
        abort_provider_upload_or_completed_object(s3, bucket, &record).await?;
        release_upload_reservation_tx(&mut tx, &record, "expired").await?;
        tx.commit().await?;
        expired = expired.saturating_add(1);
    }
    Ok(expired)
}

async fn abort_provider_upload_or_completed_object(
    s3: &S3Client,
    bucket: &str,
    record: &SessionRecord,
) -> Result<(), UploadError> {
    let abort_error = match s3
        .abort_multipart_upload()
        .bucket(bucket)
        .key(&record.object_key)
        .upload_id(&record.provider_upload_id)
        .send()
        .await
    {
        Ok(_) => return Ok(()),
        Err(error)
            if error
                .as_service_error()
                .is_some_and(|service_error| service_error.is_no_such_upload()) =>
        {
            error
        }
        Err(error) => {
            return Err(UploadError::Storage(format!(
                "multipart abort failed and will be retried: {error}"
            )));
        }
    };

    match s3
        .head_object()
        .bucket(bucket)
        .key(&record.object_key)
        .send()
        .await
    {
        Ok(_) => {
            s3.delete_object()
                .bucket(bucket)
                .key(&record.object_key)
                .send()
                .await
                .map_err(|error| {
                    UploadError::Storage(format!(
                        "multipart abort failed and completed source cleanup failed: {error}"
                    ))
                })?;
            Ok(())
        }
        Err(error)
            if error
                .as_service_error()
                .is_some_and(|service_error| service_error.is_not_found()) =>
        {
            // A previous provider abort can succeed while the database transaction
            // is interrupted. No upload or completed object remains in that case.
            Ok(())
        }
        Err(head_error) => Err(UploadError::Storage(format!(
            "multipart abort failed and object state could not be verified: abort={abort_error}; head={head_error}"
        ))),
    }
}

pub async fn reserve_legacy_source(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    asset_id: &str,
    reserved_bytes: i64,
    limits: &UploadLimits,
) -> Result<(), UploadError> {
    sqlx::query(
        "INSERT INTO rend.organization_storage_usage (organization_id, video_limit, byte_limit) VALUES ($1::uuid, $2, $3) ON CONFLICT (organization_id) DO NOTHING",
    )
    .bind(organization_id)
    .bind(limits.video_limit)
    .bind(limits.organization_byte_limit)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO rend.global_storage_usage (singleton, byte_limit) VALUES (true, $1) ON CONFLICT (singleton) DO UPDATE SET byte_limit = EXCLUDED.byte_limit",
    )
    .bind(limits.global_byte_limit)
    .execute(&mut **tx)
    .await?;
    let (org_reserved, org_used, video_limit, byte_limit): (i64, i64, i32, i64) =
        sqlx::query_as(
            "SELECT reserved_bytes, used_bytes, video_limit, byte_limit FROM rend.organization_storage_usage WHERE organization_id = $1::uuid FOR UPDATE",
        )
        .bind(organization_id)
        .fetch_one(&mut **tx)
        .await?;
    let video_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM rend.assets WHERE organization_id = $1::uuid AND deleted_at IS NULL",
    )
    .bind(organization_id)
    .fetch_one(&mut **tx)
    .await?;
    if video_count > i64::from(video_limit) {
        return Err(UploadError::Quota(format!(
            "organization has reached its {video_limit}-video limit"
        )));
    }
    let (global_reserved, global_used, global_limit): (i64, i64, i64) = sqlx::query_as(
        "SELECT reserved_bytes, used_bytes, byte_limit FROM rend.global_storage_usage WHERE singleton FOR UPDATE",
    )
    .fetch_one(&mut **tx)
    .await?;
    ensure_capacity(
        org_reserved,
        org_used,
        reserved_bytes,
        byte_limit,
        "organization storage allowance",
    )?;
    ensure_capacity(
        global_reserved,
        global_used,
        reserved_bytes,
        global_limit,
        "platform storage budget",
    )?;
    sqlx::query("UPDATE rend.organization_storage_usage SET reserved_bytes = reserved_bytes + $2 WHERE organization_id = $1::uuid")
        .bind(organization_id)
        .bind(reserved_bytes)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "UPDATE rend.global_storage_usage SET reserved_bytes = reserved_bytes + $1 WHERE singleton",
    )
    .bind(reserved_bytes)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO rend.storage_ledger_entries (organization_id, asset_id, reference_key, reason, reserved_bytes_delta) VALUES ($1::uuid, $2::uuid, $3, 'legacy_source_reserved', $4)",
    )
    .bind(organization_id)
    .bind(asset_id)
    .bind(format!("legacy:{asset_id}:reserve"))
    .bind(reserved_bytes)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn finalize_legacy_source(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    asset_id: &str,
    reserved_bytes: i64,
    used_bytes: i64,
) -> Result<(), UploadError> {
    sqlx::query("UPDATE rend.organization_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $2, 0), used_bytes = used_bytes + $3 WHERE organization_id = $1::uuid")
        .bind(organization_id)
        .bind(reserved_bytes)
        .bind(used_bytes)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE rend.global_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $1, 0), used_bytes = used_bytes + $2 WHERE singleton")
        .bind(reserved_bytes)
        .bind(used_bytes)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO rend.storage_ledger_entries (organization_id, asset_id, reference_key, reason, reserved_bytes_delta, used_bytes_delta) VALUES ($1::uuid, $2::uuid, $3, 'legacy_source_completed', $4, $5)",
    )
    .bind(organization_id)
    .bind(asset_id)
    .bind(format!("legacy:{asset_id}:complete"))
    .bind(-reserved_bytes)
    .bind(used_bytes)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn release_legacy_source(
    db: &PgPool,
    organization_id: &str,
    asset_id: &str,
    reserved_bytes: i64,
) -> Result<(), UploadError> {
    let mut tx = db.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO rend.storage_ledger_entries (organization_id, asset_id, reference_key, reason, reserved_bytes_delta) VALUES ($1::uuid, $2::uuid, $3, 'legacy_source_failed', $4) ON CONFLICT (organization_id, reference_key) DO NOTHING",
    )
    .bind(organization_id)
    .bind(asset_id)
    .bind(format!("legacy:{asset_id}:failed"))
    .bind(-reserved_bytes)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted > 0 {
        sqlx::query("UPDATE rend.organization_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $2, 0) WHERE organization_id = $1::uuid")
            .bind(organization_id)
            .bind(reserved_bytes)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE rend.global_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $1, 0) WHERE singleton")
            .bind(reserved_bytes)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE rend.assets SET deleted_at = COALESCE(deleted_at, now()), source_state = 'failed' WHERE id = $1::uuid")
        .bind(asset_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub fn estimate_processed_bytes(
    duration_ms: i64,
    width: i32,
    height: i32,
    source_bytes: i64,
) -> i64 {
    let max_dimension = i64::from(width.max(height).max(1));
    let ladder_bits_per_second = match max_dimension {
        value if value > 2_560 => 33_500_000_i64,
        value if value > 1_920 => 19_300_000_i64,
        value if value > 1_280 => 10_900_000_i64,
        value if value > 854 => 5_800_000_i64,
        value if value > 640 => 2_900_000_i64,
        _ => 1_100_000_i64,
    };
    let seconds = (duration_ms.max(1).saturating_add(999)) / 1_000;
    let bits = seconds.saturating_mul(ladder_bits_per_second);
    let bytes = bits.saturating_add(7) / 8;
    let hls_bytes = (bytes.saturating_mul(12).saturating_add(9) / 10).max(1024 * 1024);
    // A compatible H.264/AAC opener is stream-copied and can be almost as
    // large as the source. Reserve that worst case in addition to the HLS
    // ladder so a high-bitrate input cannot bypass the output quota.
    hls_bytes.saturating_add(source_bytes.max(0))
}

pub async fn reserve_media_output(
    db: &PgPool,
    job: &jobs::MediaJob,
    estimated_bytes: i64,
) -> Result<bool, UploadError> {
    let mut tx = db.begin().await?;
    let active: Option<(String, i64)> = sqlx::query_as(
        "
        SELECT asset.organization_id::text, job.reserved_output_bytes
        FROM rend.media_jobs job
        JOIN rend.assets asset ON asset.id = job.asset_id
        WHERE job.id = $1::uuid AND job.lease_token = $2::uuid
          AND job.locked_by = $3 AND job.status = 'running'
          AND job.lease_expires_at > now()
        FOR UPDATE OF job
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((organization_id, existing_reservation)) = active else {
        tx.commit().await?;
        return Ok(false);
    };
    if existing_reservation > 0 {
        tx.commit().await?;
        return Ok(true);
    }
    let (org_reserved, org_used, org_limit): (i64, i64, i64) = sqlx::query_as(
        "SELECT reserved_bytes, used_bytes, byte_limit FROM rend.organization_storage_usage WHERE organization_id = $1::uuid FOR UPDATE",
    )
    .bind(&organization_id)
    .fetch_one(&mut *tx)
    .await?;
    let (global_reserved, global_used, global_limit): (i64, i64, i64) = sqlx::query_as(
        "SELECT reserved_bytes, used_bytes, byte_limit FROM rend.global_storage_usage WHERE singleton FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await?;
    if ensure_capacity(
        org_reserved,
        org_used,
        estimated_bytes,
        org_limit,
        "organization storage allowance",
    )
    .is_err()
        || ensure_capacity(
            global_reserved,
            global_used,
            estimated_bytes,
            global_limit,
            "platform storage budget",
        )
        .is_err()
    {
        tx.commit().await?;
        return Ok(false);
    }
    sqlx::query(
        "UPDATE rend.organization_storage_usage SET reserved_bytes = reserved_bytes + $2 WHERE organization_id = $1::uuid",
    )
    .bind(&organization_id)
    .bind(estimated_bytes)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE rend.global_storage_usage SET reserved_bytes = reserved_bytes + $1 WHERE singleton",
    )
    .bind(estimated_bytes)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE rend.media_jobs SET reserved_output_bytes = $4 WHERE id = $1::uuid AND lease_token = $2::uuid AND locked_by = $3",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .bind(estimated_bytes)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "
        INSERT INTO rend.storage_ledger_entries (
          organization_id, asset_id, reference_key, reason, reserved_bytes_delta
        )
        VALUES ($1::uuid, $2::uuid, $3, 'media_output_reserved', $4)
        ON CONFLICT (organization_id, reference_key) DO NOTHING
        ",
    )
    .bind(&organization_id)
    .bind(&job.asset_id)
    .bind(format!("media:{}:reserve", job.lease_token))
    .bind(estimated_bytes)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn release_media_output_reservation(
    db: &PgPool,
    job: &jobs::MediaJob,
    reason: &str,
) -> Result<(), UploadError> {
    let mut tx = db.begin().await?;
    let row: Option<(String, i64)> = sqlx::query_as(
        "
        SELECT asset.organization_id::text, job.reserved_output_bytes
        FROM rend.media_jobs job
        JOIN rend.assets asset ON asset.id = job.asset_id
        WHERE job.id = $1::uuid AND job.lease_token = $2::uuid
          AND job.locked_by = $3 AND job.status = 'running'
        FOR UPDATE OF job
        ",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .bind(&job.worker_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((organization_id, reserved)) = row else {
        tx.commit().await?;
        return Ok(());
    };
    if reserved <= 0 {
        tx.commit().await?;
        return Ok(());
    }
    sqlx::query(
        "UPDATE rend.organization_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $2, 0) WHERE organization_id = $1::uuid",
    )
    .bind(&organization_id)
    .bind(reserved)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE rend.global_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $1, 0) WHERE singleton",
    )
    .bind(reserved)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE rend.media_jobs SET reserved_output_bytes = 0 WHERE id = $1::uuid AND lease_token = $2::uuid",
    )
    .bind(&job.id)
    .bind(&job.lease_token)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "
        INSERT INTO rend.storage_ledger_entries (
          organization_id, asset_id, reference_key, reason, reserved_bytes_delta
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, $5)
        ON CONFLICT (organization_id, reference_key) DO NOTHING
        ",
    )
    .bind(&organization_id)
    .bind(&job.asset_id)
    .bind(format!("media:{}:release", job.lease_token))
    .bind(reason)
    .bind(-reserved)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn finalize_completed_upload(
    tx: &mut Transaction<'_, Postgres>,
    record: &SessionRecord,
    byte_size: i64,
    media_job_max_attempts: i32,
) -> Result<(), UploadError> {
    sqlx::query(
        "
        INSERT INTO rend.artifacts (
          asset_id, kind, object_key, storage_object_key, content_type, byte_size
        )
        VALUES ($1::uuid, 'source', $2, $2, $3, $4)
        ON CONFLICT (asset_id, object_key) DO UPDATE
        SET storage_object_key = EXCLUDED.storage_object_key,
            content_type = EXCLUDED.content_type,
            byte_size = EXCLUDED.byte_size
        ",
    )
    .bind(&record.asset_id)
    .bind(&record.object_key)
    .bind(&record.content_type)
    .bind(byte_size)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'uploaded', playable_state = 'not_playable'
        WHERE id = $1::uuid AND deleted_at IS NULL
        ",
    )
    .bind(&record.asset_id)
    .execute(&mut **tx)
    .await?;
    events::insert_asset_event(
        tx,
        &record.asset_id,
        events::EVENT_SOURCE_UPLOADED,
        events::source_uploaded_metadata(&record.content_type, byte_size),
    )
    .await?;
    let media_job_id =
        jobs::enqueue_media_processing_job(tx, &record.asset_id, media_job_max_attempts).await?;
    events::insert_asset_event(
        tx,
        &record.asset_id,
        events::EVENT_MEDIA_PROCESSING_QUEUED,
        events::media_processing_queued_metadata(&media_job_id, media_job_max_attempts),
    )
    .await?;
    events::insert_asset_event(
        tx,
        &record.asset_id,
        events::EVENT_UPLOAD_RESPONSE_READY,
        events::upload_response_ready_metadata("uploaded", "not_playable", byte_size),
    )
    .await?;
    sqlx::query(
        "
        UPDATE rend.upload_sessions
        SET status = 'completed', completed_at = now()
        WHERE id = $1::uuid
        ",
    )
    .bind(&record.upload_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "
        UPDATE rend.organization_storage_usage
        SET reserved_bytes = GREATEST(reserved_bytes - $2, 0),
            used_bytes = used_bytes + $2
        WHERE organization_id = $1::uuid
        ",
    )
    .bind(&record.organization_id)
    .bind(byte_size)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "
        UPDATE rend.global_storage_usage
        SET reserved_bytes = GREATEST(reserved_bytes - $1, 0),
            used_bytes = used_bytes + $1
        WHERE singleton
        ",
    )
    .bind(byte_size)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "
        INSERT INTO rend.storage_ledger_entries (
          organization_id, asset_id, reference_key, reason,
          reserved_bytes_delta, used_bytes_delta
        )
        VALUES ($1::uuid, $2::uuid, $3, 'source_upload_completed', $4, $5)
        ",
    )
    .bind(&record.organization_id)
    .bind(&record.asset_id)
    .bind(format!("upload:{}:complete", record.upload_id))
    .bind(-byte_size)
    .bind(byte_size)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn release_upload_reservation_tx(
    tx: &mut Transaction<'_, Postgres>,
    record: &SessionRecord,
    terminal_status: &str,
) -> Result<(), UploadError> {
    let changed = sqlx::query(
        "
        UPDATE rend.upload_sessions
        SET status = $2,
            aborted_at = CASE WHEN $2 IN ('aborted', 'expired') THEN now() ELSE aborted_at END
        WHERE id = $1::uuid AND status IN ('uploading', 'completing')
        ",
    )
    .bind(&record.upload_id)
    .bind(terminal_status)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    if changed == 0 {
        return Ok(());
    }
    sqlx::query(
        "UPDATE rend.assets SET deleted_at = now(), source_state = 'failed' WHERE id = $1::uuid AND deleted_at IS NULL",
    )
    .bind(&record.asset_id)
    .execute(&mut **tx)
    .await?;
    for query in [
        "UPDATE rend.organization_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $2, 0) WHERE organization_id = $1::uuid",
        "UPDATE rend.global_storage_usage SET reserved_bytes = GREATEST(reserved_bytes - $2, 0) WHERE singleton AND $1::uuid IS NOT NULL",
    ] {
        sqlx::query(query)
            .bind(&record.organization_id)
            .bind(record.content_length)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query(
        "
        INSERT INTO rend.storage_ledger_entries (
          organization_id, asset_id, reference_key, reason, reserved_bytes_delta
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, $5)
        ",
    )
    .bind(&record.organization_id)
    .bind(&record.asset_id)
    .bind(format!("upload:{}:{terminal_status}", record.upload_id))
    .bind(format!("source_upload_{terminal_status}"))
    .bind(-record.content_length)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[derive(Clone, Debug)]
struct SessionRecord {
    upload_id: String,
    organization_id: String,
    asset_id: String,
    provider_upload_id: String,
    object_key: String,
    content_type: String,
    content_length: i64,
    part_size: i64,
    part_count: i64,
    expires_at: String,
    status: String,
}

impl SessionRecord {
    fn from_row(
        row: (
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            i32,
            i32,
            String,
            String,
        ),
    ) -> Self {
        let (
            upload_id,
            organization_id,
            asset_id,
            provider_upload_id,
            object_key,
            content_type,
            content_length,
            part_size,
            part_count,
            expires_at,
            status,
        ) = row;
        Self {
            upload_id,
            organization_id,
            asset_id,
            provider_upload_id,
            object_key,
            content_type,
            content_length,
            part_size: i64::from(part_size),
            part_count: i64::from(part_count),
            expires_at,
            status,
        }
    }

    fn to_response(&self, uploaded_parts: Vec<UploadedPart>) -> UploadSession {
        UploadSession {
            asset_id: self.asset_id.clone(),
            upload_id: self.upload_id.clone(),
            part_size: self.part_size as u64,
            part_count: self.part_count as u64,
            max_parallel_parts: MAX_PARALLEL_PARTS,
            expires_at: self.expires_at.clone(),
            status: self.status.clone(),
            uploaded_parts,
        }
    }
}

async fn session_record(
    db: &PgPool,
    organization_id: &str,
    upload_id: &str,
) -> Result<SessionRecord, UploadError> {
    sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            i32,
            i32,
            String,
            String,
        ),
    >(
        "
        SELECT id::text, organization_id::text, asset_id::text,
               provider_upload_id, object_key, content_type, content_length,
               part_size, part_count,
               to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               status
        FROM rend.upload_sessions
        WHERE id = $1::uuid AND organization_id = $2::uuid
        ",
    )
    .bind(upload_id)
    .bind(organization_id)
    .fetch_optional(db)
    .await?
    .map(|row| SessionRecord {
        upload_id: row.0,
        organization_id: row.1,
        asset_id: row.2,
        provider_upload_id: row.3,
        object_key: row.4,
        content_type: row.5,
        content_length: row.6,
        part_size: i64::from(row.7),
        part_count: i64::from(row.8),
        expires_at: row.9,
        status: row.10,
    })
    .ok_or(UploadError::NotFound)
}

async fn active_session_record_tx(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    upload_id: &str,
) -> Result<SessionRecord, UploadError> {
    let row = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            i32,
            i32,
            String,
            String,
            bool,
        ),
    >(
        "
        SELECT id::text, organization_id::text, asset_id::text,
               provider_upload_id, object_key, content_type, content_length,
               part_size, part_count,
               to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
               status, expires_at > now()
        FROM rend.upload_sessions
        WHERE id = $1::uuid AND organization_id = $2::uuid
        FOR SHARE
        ",
    )
    .bind(upload_id)
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Err(UploadError::NotFound);
    };
    if row.10 != "uploading" {
        return Err(UploadError::Conflict(format!(
            "upload session is {}",
            row.10
        )));
    }
    if !row.11 {
        return Err(UploadError::Conflict("upload session has expired".into()));
    }
    Ok(SessionRecord {
        upload_id: row.0,
        organization_id: row.1,
        asset_id: row.2,
        provider_upload_id: row.3,
        object_key: row.4,
        content_type: row.5,
        content_length: row.6,
        part_size: i64::from(row.7),
        part_count: i64::from(row.8),
        expires_at: row.9,
        status: row.10,
    })
}

async fn find_idempotent_session(
    db: &PgPool,
    input: &CreateUploadInput,
) -> Result<Option<UploadSession>, UploadError> {
    let row: Option<(String, String, i64, String, i64, i32, i32, String, String)> = sqlx::query_as(
        "
            SELECT asset_id::text, id::text, content_length, content_type,
                   part_size, part_count, 6,
                   to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                   status
            FROM rend.upload_sessions
            WHERE organization_id = $1::uuid AND idempotency_key = $2
            ",
    )
    .bind(&input.organization_id)
    .bind(&input.idempotency_key)
    .fetch_optional(db)
    .await?;
    let Some((
        asset_id,
        upload_id,
        content_length,
        content_type,
        part_size,
        part_count,
        max_parallel,
        expires_at,
        status,
    )) = row
    else {
        return Ok(None);
    };
    if content_length != input.content_length || content_type != input.content_type {
        return Err(UploadError::Conflict(
            "Idempotency-Key was already used with different upload metadata".into(),
        ));
    }
    Ok(Some(UploadSession {
        asset_id,
        upload_id,
        part_size: part_size as u64,
        part_count: part_count as u64,
        max_parallel_parts: max_parallel as u8,
        expires_at,
        status,
        uploaded_parts: Vec::new(),
    }))
}

async fn list_uploaded_parts(
    s3: &S3Client,
    bucket: &str,
    record: &SessionRecord,
) -> Result<Vec<UploadedPart>, UploadError> {
    let mut result = Vec::new();
    let mut marker = None;
    loop {
        let page = s3
            .list_parts()
            .bucket(bucket)
            .key(&record.object_key)
            .upload_id(&record.provider_upload_id)
            .set_part_number_marker(marker)
            .send()
            .await
            .map_err(|error| UploadError::Storage(error.to_string()))?;
        for part in page.parts() {
            result.push(UploadedPart {
                part_number: part.part_number().unwrap_or_default(),
                etag: part.e_tag().unwrap_or_default().to_owned(),
                checksum_sha256: part.checksum_sha256().map(str::to_owned),
                size: part.size().unwrap_or_default(),
            });
        }
        if !page.is_truncated().unwrap_or(false) {
            break;
        }
        marker = page.next_part_number_marker().map(str::to_owned);
    }
    Ok(result)
}

fn validate_create_input(
    limits: &UploadLimits,
    input: &CreateUploadInput,
) -> Result<(), UploadError> {
    if input.content_length <= 0 {
        return Err(UploadError::Invalid(
            "content_length must be greater than zero".into(),
        ));
    }
    if u64::try_from(input.content_length).unwrap_or(u64::MAX) > limits.max_upload_bytes {
        return Err(UploadError::TooLarge(format!(
            "content_length exceeds the configured maximum upload size of {} bytes",
            limits.max_upload_bytes
        )));
    }
    if input.content_type.trim().is_empty() || input.content_type.len() > 255 {
        return Err(UploadError::Invalid(
            "content_type must be between 1 and 255 characters".into(),
        ));
    }
    if input.idempotency_key.is_empty() || input.idempotency_key.len() > 200 {
        return Err(UploadError::Invalid(
            "Idempotency-Key must be between 1 and 200 characters".into(),
        ));
    }
    if input
        .filename
        .as_ref()
        .is_some_and(|name| name.len() > 1024)
    {
        return Err(UploadError::Invalid(
            "filename must not exceed 1024 characters".into(),
        ));
    }
    let effective_part_size = effective_part_size(input.content_length as u64, limits.part_size);
    let count = part_count(input.content_length as u64, effective_part_size);
    if count > MAX_MULTIPART_PARTS {
        return Err(UploadError::Quota(format!(
            "declared source needs {count} multipart parts, above the object-store limit; configure a larger part size"
        )));
    }
    Ok(())
}

async fn ensure_organization_available_tx(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
) -> Result<(), UploadError> {
    let suspended: Option<bool> = sqlx::query_scalar(
        "SELECT suspended_at IS NOT NULL FROM rend_auth.organization WHERE id = $1::uuid FOR SHARE",
    )
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await?;
    match suspended {
        Some(false) => Ok(()),
        Some(true) => Err(UploadError::Unavailable(
            "organization is suspended".to_owned(),
        )),
        None => Err(UploadError::NotFound),
    }
}

async fn ensure_upload_session_available_tx(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    upload_id: &str,
) -> Result<(), UploadError> {
    let availability: Option<(bool, bool, bool)> = sqlx::query_as(
        "
        SELECT asset.deleted_at IS NOT NULL,
               asset.suspended_at IS NOT NULL,
               org.suspended_at IS NOT NULL
        FROM rend.upload_sessions session
        INNER JOIN rend.assets asset ON asset.id = session.asset_id
        INNER JOIN rend_auth.organization org ON org.id = session.organization_id
        WHERE session.id = $1::uuid AND session.organization_id = $2::uuid
        FOR SHARE OF asset, org
        ",
    )
    .bind(upload_id)
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await?;
    match availability {
        Some((false, false, false)) => Ok(()),
        Some((true, _, _)) | None => Err(UploadError::NotFound),
        Some((_, _, true)) => Err(UploadError::Unavailable(
            "organization is suspended".to_owned(),
        )),
        Some((_, true, _)) => Err(UploadError::Unavailable("asset is suspended".to_owned())),
    }
}

fn validate_completed_parts(
    parts: &[CompletedUploadPart],
    expected_count: i64,
) -> Result<(), UploadError> {
    if parts.len() as i64 != expected_count {
        return Err(UploadError::Invalid(format!(
            "completion requires exactly {expected_count} parts"
        )));
    }
    let mut expected = 1;
    for part in parts {
        if part.part_number != expected || part.etag.trim().is_empty() {
            return Err(UploadError::Invalid(
                "completion parts must be ordered, contiguous, and include an etag".into(),
            ));
        }
        validate_sha256(&part.checksum_sha256)?;
        expected += 1;
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), UploadError> {
    let decoded = BASE64_STANDARD
        .decode(value)
        .map_err(|_| UploadError::Invalid("checksum_sha256 must be base64".into()))?;
    if decoded.len() != 32 {
        return Err(UploadError::Invalid(
            "checksum_sha256 must encode exactly 32 bytes".into(),
        ));
    }
    Ok(())
}

fn ensure_capacity(
    reserved: i64,
    used: i64,
    requested: i64,
    limit: i64,
    label: &str,
) -> Result<(), UploadError> {
    let projected = reserved
        .checked_add(used)
        .and_then(|value| value.checked_add(requested))
        .ok_or_else(|| UploadError::Quota(format!("{label} arithmetic overflow")))?;
    if projected > limit {
        return Err(UploadError::Quota(format!(
            "declared source exceeds the remaining {label}"
        )));
    }
    Ok(())
}

pub fn part_count(content_length: u64, part_size: u64) -> u64 {
    content_length.div_ceil(part_size)
}

pub fn effective_part_size(content_length: u64, configured_part_size: u64) -> u64 {
    let minimum_for_provider = content_length.div_ceil(MAX_MULTIPART_PARTS);
    let mebibyte = 1024 * 1024;
    let rounded_provider_minimum = minimum_for_provider.div_ceil(mebibyte) * mebibyte;
    configured_part_size.max(rounded_provider_minimum)
}

pub fn source_object_key(asset_id: &str) -> String {
    format!("videos/{asset_id}/source")
}

fn duration_seconds(duration: Duration) -> i64 {
    i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sixteen_mib_parts_round_up_and_expand_for_unusually_large_sources() {
        assert_eq!(part_count(1, DEFAULT_PART_SIZE), 1);
        assert_eq!(part_count(DEFAULT_PART_SIZE, DEFAULT_PART_SIZE), 1);
        assert_eq!(part_count(DEFAULT_PART_SIZE + 1, DEFAULT_PART_SIZE), 2);
        let huge = 5 * 1024 * 1024 * 1024 * 1024;
        let huge_part_size = effective_part_size(huge, DEFAULT_PART_SIZE);
        assert!(huge_part_size > DEFAULT_PART_SIZE);
        assert!(part_count(huge, huge_part_size) <= MAX_MULTIPART_PARTS);
    }

    #[test]
    fn checksum_validation_requires_base64_sha256() {
        let valid = BASE64_STANDARD.encode([7_u8; 32]);
        assert!(validate_sha256(&valid).is_ok());
        assert!(validate_sha256("not-base64").is_err());
        assert!(validate_sha256(&BASE64_STANDARD.encode([7_u8; 31])).is_err());
    }

    #[test]
    fn processed_output_estimate_has_headroom_and_a_one_mib_floor() {
        assert_eq!(estimate_processed_bytes(1, 320, 180, 0), 1024 * 1024);
        assert!(estimate_processed_bytes(60_000, 1920, 1080, 0) > 40 * 1024 * 1024);
        assert!(
            estimate_processed_bytes(60_000, 1920, 1080, 500 * 1024 * 1024) > 540 * 1024 * 1024
        );
    }

    #[test]
    fn multipart_create_enforces_configured_maximum() {
        let limits = UploadLimits {
            part_size: DEFAULT_PART_SIZE,
            session_ttl: Duration::from_secs(60),
            signed_url_ttl: Duration::from_secs(60),
            video_limit: 50,
            organization_byte_limit: i64::MAX,
            global_byte_limit: i64::MAX,
            max_open_sessions: 10,
            media_job_max_attempts: 3,
            max_upload_bytes: 1024,
        };
        let input = CreateUploadInput {
            organization_id: "00000000-0000-0000-0000-000000000001".to_owned(),
            idempotency_key: "max-upload-test".to_owned(),
            content_type: "video/mp4".to_owned(),
            content_length: 1025,
            filename: None,
        };
        assert!(matches!(
            validate_create_input(&limits, &input),
            Err(UploadError::TooLarge(_))
        ));
    }
}
