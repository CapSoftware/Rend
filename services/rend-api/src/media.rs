use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use aws_sdk_s3::{Client as S3Client, primitives::ByteStream};
use serde::Deserialize;
use sqlx::{PgPool, Postgres, Transaction};
use tokio::{fs, io, process::Command, time};

use crate::{
    billing,
    events::{self, ArtifactEventInput},
};

const OUTPUT_LOG_LIMIT_BYTES: usize = 8 * 1024;

#[derive(Clone)]
pub struct MediaProcessingConfig {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub process_timeout: Duration,
}

pub struct ProcessMediaRequest {
    pub asset_id: String,
    pub source_object_key: String,
    pub s3_bucket: String,
    pub s3: S3Client,
    pub db: PgPool,
    pub config: MediaProcessingConfig,
}

pub struct ProcessMediaOutcome {
    pub playable_state: String,
    pub playback_artifact_paths: Vec<String>,
}

#[derive(Clone)]
struct UploadedArtifact {
    kind: &'static str,
    object_key: String,
    content_type: &'static str,
    byte_size: i64,
    duration_ms: Option<i64>,
    resolution_tier: Option<String>,
}

struct CommandOutput {
    stdout: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceProbe {
    duration_ms: i64,
    width: i32,
    height: i32,
    resolution_tier: &'static str,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    width: Option<i32>,
    height: Option<i32>,
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

pub async fn process_uploaded_source(request: ProcessMediaRequest) -> Result<ProcessMediaOutcome> {
    match try_process_uploaded_source(&request).await {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            tracing::warn!(
                asset_id = %request.asset_id,
                error = %limit_error(&error),
                "media artifact generation failed before producing a playable artifact",
            );
            set_failed_playable_state(&request.db, &request.asset_id).await?;
            Ok(ProcessMediaOutcome {
                playable_state: "failed".to_owned(),
                playback_artifact_paths: Vec::new(),
            })
        }
    }
}

pub async fn try_process_uploaded_source(
    request: &ProcessMediaRequest,
) -> Result<ProcessMediaOutcome> {
    let processing_dir = create_processing_dir(&request.asset_id).await?;
    let result = process_in_dir(request, &processing_dir).await;

    if let Err(error) = fs::remove_dir_all(&processing_dir).await {
        tracing::warn!(
            path = %processing_dir.display(),
            error = %error,
            "failed to remove media processing directory",
        );
    }

    result
}

async fn process_in_dir(
    request: &ProcessMediaRequest,
    processing_dir: &Path,
) -> Result<ProcessMediaOutcome> {
    let source_path = processing_dir.join("source");
    download_source_object(request, &source_path).await?;
    let source_probe = probe_video_stream(&request.config, &source_path).await?;

    let opener_artifact =
        generate_and_upload_opener(request, processing_dir, &source_path, &source_probe)
            .await
            .context("failed to generate opener artifact")?;

    let thumbnail_artifact =
        match generate_and_upload_thumbnail(request, processing_dir, &source_path).await {
            Ok(artifact) => Some(artifact),
            Err(error) => {
                tracing::warn!(
                    asset_id = %request.asset_id,
                    error = %limit_error(&error),
                    "thumbnail generation failed; continuing with playable artifacts",
                );
                None
            }
        };

    let hls_artifacts =
        match generate_and_upload_hls(request, processing_dir, &source_path, &source_probe).await {
            Ok(artifacts) => artifacts,
            Err(error) => {
                tracing::warn!(
                    asset_id = %request.asset_id,
                    error = %limit_error(&error),
                    "HLS generation failed; keeping opener-only playback state",
                );
                Vec::new()
            }
        };

    let mut artifacts = Vec::with_capacity(2 + hls_artifacts.len());
    artifacts.push(opener_artifact.clone());
    if let Some(thumbnail_artifact) = thumbnail_artifact {
        artifacts.push(thumbnail_artifact);
    }
    artifacts.extend(hls_artifacts);

    let has_manifest = artifacts.iter().any(|artifact| artifact.kind == "manifest");
    let segment_count = artifacts
        .iter()
        .filter(|artifact| artifact.kind == "segment")
        .count();
    let playable_state = if has_manifest && segment_count > 0 {
        "hls_ready"
    } else {
        "opener_ready"
    };

    let promoted = persist_artifacts_and_state(
        &request.db,
        &request.asset_id,
        &artifacts,
        playable_state,
        &opener_artifact.object_key,
        &source_probe,
    )
    .await?;

    if !promoted {
        return Ok(ProcessMediaOutcome {
            playable_state: "deleted".to_owned(),
            playback_artifact_paths: Vec::new(),
        });
    }

    Ok(ProcessMediaOutcome {
        playable_state: playable_state.to_owned(),
        playback_artifact_paths: playback_artifact_paths(
            &request.asset_id,
            &artifacts,
            playable_state,
        ),
    })
}

async fn create_processing_dir(asset_id: &str) -> Result<PathBuf> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before unix epoch")?
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "rend-media-{asset_id}-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&path)
        .await
        .with_context(|| format!("failed to create processing directory {}", path.display()))?;
    Ok(path)
}

async fn download_source_object(request: &ProcessMediaRequest, destination: &Path) -> Result<()> {
    let object = request
        .s3
        .get_object()
        .bucket(&request.s3_bucket)
        .key(&request.source_object_key)
        .send()
        .await
        .with_context(|| {
            format!(
                "failed to download source object {}",
                request.source_object_key
            )
        })?;
    let mut reader = object.body.into_async_read();
    let mut file = fs::File::create(destination)
        .await
        .with_context(|| format!("failed to create source file {}", destination.display()))?;
    io::copy(&mut reader, &mut file)
        .await
        .with_context(|| format!("failed to write source file {}", destination.display()))?;
    file.sync_all()
        .await
        .with_context(|| format!("failed to sync source file {}", destination.display()))?;
    Ok(())
}

pub async fn set_asset_media_failed(db: &PgPool, asset_id: &str) -> Result<()> {
    set_failed_playable_state(db, asset_id).await
}

async fn probe_video_stream(
    config: &MediaProcessingConfig,
    source_path: &Path,
) -> Result<SourceProbe> {
    let output = run_media_command(
        &config.ffprobe_path,
        vec![
            os("-v"),
            os("error"),
            os("-select_streams"),
            os("v:0"),
            os("-show_entries"),
            os("stream=codec_type,width,height,duration:format=duration"),
            os("-of"),
            os("json"),
            source_path.as_os_str().to_owned(),
        ],
        config.process_timeout,
    )
    .await
    .context("ffprobe failed")?;

    let parsed: FfprobeOutput =
        serde_json::from_str(&output.stdout).context("ffprobe returned invalid JSON")?;
    let stream = parsed
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .context("ffprobe found no video stream")?;
    let width = stream.width.context("ffprobe did not return video width")?;
    let height = stream
        .height
        .context("ffprobe did not return video height")?;
    anyhow::ensure!(
        width > 0 && height > 0,
        "ffprobe returned invalid video dimensions"
    );
    let duration_ms = stream
        .duration
        .as_deref()
        .and_then(parse_duration_ms)
        .or_else(|| {
            parsed
                .format
                .as_ref()
                .and_then(|format| format.duration.as_deref())
                .and_then(parse_duration_ms)
        })
        .context("ffprobe did not return video duration")?;
    anyhow::ensure!(duration_ms > 0, "ffprobe returned invalid video duration");

    Ok(SourceProbe {
        duration_ms,
        width,
        height,
        resolution_tier: classify_resolution_tier(width, height),
    })
}

async fn generate_and_upload_opener(
    request: &ProcessMediaRequest,
    processing_dir: &Path,
    source_path: &Path,
    source_probe: &SourceProbe,
) -> Result<UploadedArtifact> {
    let opener_path = processing_dir.join("opener.mp4");
    run_media_command(
        &request.config.ffmpeg_path,
        vec![
            os("-y"),
            os("-i"),
            source_path.as_os_str().to_owned(),
            os("-t"),
            os("5"),
            os("-map"),
            os("0:v:0"),
            os("-map"),
            os("0:a?"),
            os("-c:v"),
            os("libx264"),
            os("-preset"),
            os("veryfast"),
            os("-profile:v"),
            os("baseline"),
            os("-pix_fmt"),
            os("yuv420p"),
            os("-movflags"),
            os("+faststart"),
            os("-c:a"),
            os("aac"),
            os("-b:a"),
            os("96k"),
            os("-f"),
            os("mp4"),
            opener_path.as_os_str().to_owned(),
        ],
        request.config.process_timeout,
    )
    .await?;

    upload_generated_file(
        request,
        &opener_path,
        opener_object_key(&request.asset_id),
        "video/mp4",
        "opener",
        Some(source_probe.duration_ms.min(5_000)),
        Some(source_probe.resolution_tier),
    )
    .await
}

async fn generate_and_upload_thumbnail(
    request: &ProcessMediaRequest,
    processing_dir: &Path,
    source_path: &Path,
) -> Result<UploadedArtifact> {
    let thumbnail_path = processing_dir.join("thumbnail.jpg");
    run_media_command(
        &request.config.ffmpeg_path,
        vec![
            os("-y"),
            os("-ss"),
            os("0"),
            os("-i"),
            source_path.as_os_str().to_owned(),
            os("-frames:v"),
            os("1"),
            os("-q:v"),
            os("3"),
            thumbnail_path.as_os_str().to_owned(),
        ],
        request.config.process_timeout,
    )
    .await?;

    upload_generated_file(
        request,
        &thumbnail_path,
        thumbnail_object_key(&request.asset_id),
        "image/jpeg",
        "thumbnail",
        None,
        None,
    )
    .await
}

async fn generate_and_upload_hls(
    request: &ProcessMediaRequest,
    processing_dir: &Path,
    source_path: &Path,
    source_probe: &SourceProbe,
) -> Result<Vec<UploadedArtifact>> {
    let hls_dir = processing_dir.join("hls");
    fs::create_dir_all(&hls_dir).await.with_context(|| {
        format!(
            "failed to create HLS output directory {}",
            hls_dir.display()
        )
    })?;
    let manifest_path = hls_dir.join("master.m3u8");
    let segment_pattern = hls_dir.join("segment_%05d.ts");

    run_media_command(
        &request.config.ffmpeg_path,
        vec![
            os("-y"),
            os("-i"),
            source_path.as_os_str().to_owned(),
            os("-map"),
            os("0:v:0"),
            os("-map"),
            os("0:a?"),
            os("-c:v"),
            os("libx264"),
            os("-preset"),
            os("veryfast"),
            os("-profile:v"),
            os("baseline"),
            os("-pix_fmt"),
            os("yuv420p"),
            os("-g"),
            os("48"),
            os("-keyint_min"),
            os("48"),
            os("-sc_threshold"),
            os("0"),
            os("-c:a"),
            os("aac"),
            os("-b:a"),
            os("96k"),
            os("-hls_time"),
            os("2"),
            os("-hls_playlist_type"),
            os("vod"),
            os("-hls_segment_filename"),
            segment_pattern.as_os_str().to_owned(),
            manifest_path.as_os_str().to_owned(),
        ],
        request.config.process_timeout,
    )
    .await?;

    let mut artifacts = Vec::new();
    let segment_durations = hls_segment_durations(&manifest_path)
        .await
        .context("failed to read HLS segment durations")?;
    let manifest_artifact = upload_generated_file(
        request,
        &manifest_path,
        hls_manifest_object_key(&request.asset_id),
        "application/vnd.apple.mpegurl",
        "manifest",
        Some(0),
        Some(source_probe.resolution_tier),
    )
    .await?;
    artifacts.push(manifest_artifact);

    let mut segment_paths = Vec::new();
    let mut entries = fs::read_dir(&hls_dir)
        .await
        .with_context(|| format!("failed to read HLS output directory {}", hls_dir.display()))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .with_context(|| format!("failed to scan HLS output directory {}", hls_dir.display()))?
    {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "ts") {
            segment_paths.push(path);
        }
    }
    segment_paths.sort();

    anyhow::ensure!(
        !segment_paths.is_empty(),
        "ffmpeg did not create any HLS segments"
    );

    for segment_path in segment_paths {
        let file_name = segment_path
            .file_name()
            .context("HLS segment path has no file name")?
            .to_string_lossy()
            .into_owned();
        let duration_ms = segment_durations.get(&file_name).copied().or(Some(2_000));
        let artifact = upload_generated_file(
            request,
            &segment_path,
            hls_segment_object_key(&request.asset_id, &file_name),
            "video/mp2t",
            "segment",
            duration_ms,
            Some(source_probe.resolution_tier),
        )
        .await?;
        artifacts.push(artifact);
    }

    Ok(artifacts)
}

async fn upload_generated_file(
    request: &ProcessMediaRequest,
    path: &Path,
    object_key: String,
    content_type: &'static str,
    kind: &'static str,
    duration_ms: Option<i64>,
    resolution_tier: Option<&'static str>,
) -> Result<UploadedArtifact> {
    let bytes = fs::read(path)
        .await
        .with_context(|| format!("failed to read generated artifact {}", path.display()))?;
    let byte_size =
        i64::try_from(bytes.len()).context("generated artifact is too large to record")?;
    anyhow::ensure!(
        byte_size > 0,
        "generated artifact {} is empty",
        path.display()
    );

    request
        .s3
        .put_object()
        .bucket(&request.s3_bucket)
        .key(&object_key)
        .content_type(content_type)
        .content_length(byte_size)
        .body(ByteStream::from(bytes))
        .send()
        .await
        .with_context(|| format!("failed to upload generated artifact {object_key}"))?;

    Ok(UploadedArtifact {
        kind,
        object_key,
        content_type,
        byte_size,
        duration_ms,
        resolution_tier: resolution_tier.map(str::to_owned),
    })
}

async fn persist_artifacts_and_state(
    db: &PgPool,
    asset_id: &str,
    artifacts: &[UploadedArtifact],
    playable_state: &str,
    opener_object_key: &str,
    source_probe: &SourceProbe,
) -> Result<bool> {
    let mut tx = db
        .begin()
        .await
        .context("failed to start artifact transaction")?;
    let mut opener_artifact_id = None;
    let row: Option<(String, bool, bool, bool)> = sqlx::query_as(
        "
        SELECT asset.playable_state,
               asset.deleted_at IS NOT NULL,
               asset.suspended_at IS NOT NULL,
               org.suspended_at IS NOT NULL
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
        FOR UPDATE
        ",
    )
    .bind(asset_id)
    .fetch_optional(&mut *tx)
    .await
    .context("failed to lock asset playable state")?;

    let Some((previous_playable_state, deleted, asset_suspended, org_suspended)) = row else {
        tx.commit()
            .await
            .context("failed to commit missing-asset artifact transaction")?;
        return Ok(false);
    };

    if deleted || asset_suspended || org_suspended {
        tx.commit()
            .await
            .context("failed to commit unavailable-asset artifact transaction")?;
        return Ok(false);
    }

    for artifact in artifacts {
        let artifact_id: String = insert_artifact(&mut tx, asset_id, artifact)
            .await
            .with_context(|| format!("failed to insert {} artifact", artifact.kind))?;
        if artifact.object_key == opener_object_key {
            opener_artifact_id = Some(artifact_id);
        }
    }

    let artifact_event_inputs = artifacts
        .iter()
        .map(|artifact| ArtifactEventInput {
            kind: artifact.kind,
            object_key: &artifact.object_key,
            content_type: artifact.content_type,
            byte_size: artifact.byte_size,
        })
        .collect::<Vec<_>>();
    for event in events::artifact_generated_events(asset_id, &artifact_event_inputs) {
        events::insert_asset_event(&mut tx, asset_id, event.event_type, event.metadata)
            .await
            .with_context(|| format!("failed to insert {} event", event.event_type))?;
    }

    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'uploaded',
            playable_state = $2,
            current_opener_artifact_id = $3::uuid,
            duration_ms = $4,
            source_width = $5,
            source_height = $6,
            source_resolution_tier = $7,
            max_resolution_tier = $7
        WHERE id = $1::uuid
          AND deleted_at IS NULL
          AND suspended_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM rend_auth.organization org
            WHERE org.id = rend.assets.organization_id
              AND org.suspended_at IS NOT NULL
          )
        ",
    )
    .bind(asset_id)
    .bind(playable_state)
    .bind(opener_artifact_id.as_deref())
    .bind(source_probe.duration_ms)
    .bind(source_probe.width)
    .bind(source_probe.height)
    .bind(source_probe.resolution_tier)
    .execute(&mut *tx)
    .await
    .context("failed to update asset playable state")?;

    sqlx::query(
        "
        UPDATE rend.artifacts
        SET duration_ms = $2,
            resolution_tier = $3
        WHERE asset_id = $1::uuid
          AND kind = 'source'
        ",
    )
    .bind(asset_id)
    .bind(source_probe.duration_ms)
    .bind(source_probe.resolution_tier)
    .execute(&mut *tx)
    .await
    .context("failed to update source artifact billing metadata")?;

    billing::open_asset_storage_span(&mut tx, asset_id)
        .await
        .context("failed to open asset storage billing span")?;

    if previous_playable_state != playable_state {
        events::insert_asset_event(
            &mut tx,
            asset_id,
            events::EVENT_PLAYABLE_STATE_CHANGED,
            events::playable_state_changed_metadata(&previous_playable_state, playable_state),
        )
        .await
        .context("failed to insert playable state event")?;
    }

    tx.commit()
        .await
        .context("failed to commit artifact transaction")?;
    Ok(true)
}

async fn insert_artifact(
    tx: &mut Transaction<'_, Postgres>,
    asset_id: &str,
    artifact: &UploadedArtifact,
) -> Result<String> {
    let artifact_id = sqlx::query_scalar(
        "
        INSERT INTO rend.artifacts (
          asset_id,
          kind,
          object_key,
          content_type,
          byte_size,
          duration_ms,
          resolution_tier
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
        RETURNING id::text
        ",
    )
    .bind(asset_id)
    .bind(artifact.kind)
    .bind(&artifact.object_key)
    .bind(artifact.content_type)
    .bind(artifact.byte_size)
    .bind(artifact.duration_ms)
    .bind(artifact.resolution_tier.as_deref())
    .fetch_one(&mut **tx)
    .await?;

    Ok(artifact_id)
}

async fn set_failed_playable_state(db: &PgPool, asset_id: &str) -> Result<()> {
    let mut tx = db
        .begin()
        .await
        .context("failed to start failed-state transaction")?;
    let row: Option<(String, bool, bool, bool)> = sqlx::query_as(
        "
        SELECT asset.playable_state,
               asset.deleted_at IS NOT NULL,
               asset.suspended_at IS NOT NULL,
               org.suspended_at IS NOT NULL
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
        FOR UPDATE
        ",
    )
    .bind(asset_id)
    .fetch_optional(&mut *tx)
    .await
    .context("failed to lock asset playable state")?;

    let Some((previous_playable_state, deleted, asset_suspended, org_suspended)) = row else {
        tx.commit()
            .await
            .context("failed to commit missing-asset failed-state transaction")?;
        return Ok(());
    };

    if deleted || asset_suspended || org_suspended {
        tx.commit()
            .await
            .context("failed to commit unavailable-asset failed-state transaction")?;
        return Ok(());
    }

    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'uploaded',
            playable_state = 'failed',
            current_opener_artifact_id = NULL
        WHERE id = $1::uuid
          AND deleted_at IS NULL
          AND suspended_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM rend_auth.organization org
            WHERE org.id = rend.assets.organization_id
              AND org.suspended_at IS NOT NULL
          )
        ",
    )
    .bind(asset_id)
    .execute(&mut *tx)
    .await
    .context("failed to update failed playable state")?;

    if previous_playable_state != "failed" {
        events::insert_asset_event(
            &mut tx,
            asset_id,
            events::EVENT_PLAYABLE_STATE_CHANGED,
            events::playable_state_changed_metadata(&previous_playable_state, "failed"),
        )
        .await
        .context("failed to insert failed playable state event")?;
    }

    tx.commit()
        .await
        .context("failed to commit failed-state transaction")?;
    Ok(())
}

async fn run_media_command(
    binary: &str,
    args: Vec<OsString>,
    timeout: Duration,
) -> Result<CommandOutput> {
    anyhow::ensure!(
        !binary.trim().is_empty(),
        "media binary path must not be empty"
    );

    let command_for_error = format_command(binary, &args);
    let mut command = Command::new(binary);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = match time::timeout(timeout, command.output()).await {
        Ok(output) => output.with_context(|| format!("failed to run {command_for_error}"))?,
        Err(_) => anyhow::bail!(
            "{command_for_error} timed out after {} seconds",
            timeout.as_secs()
        ),
    };

    let stdout = limit_bytes(&output.stdout);
    let stderr = limit_bytes(&output.stderr);

    anyhow::ensure!(
        output.status.success(),
        "{command_for_error} exited with status {}; stdout: {}; stderr: {}",
        output.status,
        stdout,
        stderr
    );

    Ok(CommandOutput { stdout })
}

fn os(value: &str) -> OsString {
    OsString::from(value)
}

fn format_command(binary: &str, args: &[OsString]) -> String {
    let mut command = binary.to_owned();
    for arg in args {
        command.push(' ');
        command.push_str(&arg.to_string_lossy());
    }
    command
}

fn limit_bytes(bytes: &[u8]) -> String {
    let truncated = bytes.len() > OUTPUT_LOG_LIMIT_BYTES;
    let end = bytes.len().min(OUTPUT_LOG_LIMIT_BYTES);
    let mut output = String::from_utf8_lossy(&bytes[..end]).replace('\0', "\\0");
    if truncated {
        output.push_str("...[truncated]");
    }
    output
}

fn limit_error(error: &anyhow::Error) -> String {
    let message = error.to_string();
    if message.len() > OUTPUT_LOG_LIMIT_BYTES {
        format!("{}...[truncated]", &message[..OUTPUT_LOG_LIMIT_BYTES])
    } else {
        message
    }
}

fn parse_duration_ms(value: &str) -> Option<i64> {
    let seconds = value.trim().parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    let millis = (seconds * 1000.0).round();
    if millis <= 0.0 || millis > i64::MAX as f64 {
        None
    } else {
        Some(millis as i64)
    }
}

fn classify_resolution_tier(width: i32, height: i32) -> &'static str {
    let max_dimension = width.max(height);
    if max_dimension <= 1280 {
        "720p"
    } else if max_dimension <= 1920 {
        "1080p"
    } else if max_dimension <= 2560 {
        "2k"
    } else {
        "4k"
    }
}

async fn hls_segment_durations(manifest_path: &Path) -> Result<HashMap<String, i64>> {
    let manifest = fs::read_to_string(manifest_path)
        .await
        .with_context(|| format!("failed to read HLS manifest {}", manifest_path.display()))?;
    Ok(parse_hls_segment_durations(&manifest))
}

fn parse_hls_segment_durations(manifest: &str) -> HashMap<String, i64> {
    let mut durations = HashMap::new();
    let mut pending_duration_ms = None;
    for line in manifest.lines().map(str::trim) {
        if let Some(raw_duration) = line
            .strip_prefix("#EXTINF:")
            .and_then(|value| value.split(',').next())
        {
            pending_duration_ms = parse_duration_ms(raw_duration);
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(duration_ms) = pending_duration_ms.take()
            && let Some(file_name) = Path::new(line).file_name().and_then(|value| value.to_str())
        {
            durations.insert(file_name.to_owned(), duration_ms);
        }
    }
    durations
}

pub fn opener_object_key(asset_id: &str) -> String {
    format!("videos/{asset_id}/opener.mp4")
}

pub fn thumbnail_object_key(asset_id: &str) -> String {
    format!("videos/{asset_id}/thumbnail.jpg")
}

pub fn hls_manifest_object_key(asset_id: &str) -> String {
    format!("videos/{asset_id}/hls/master.m3u8")
}

pub fn hls_segment_object_key(asset_id: &str, segment_name: &str) -> String {
    format!("videos/{asset_id}/hls/{segment_name}")
}

fn playback_artifact_paths(
    asset_id: &str,
    artifacts: &[UploadedArtifact],
    playable_state: &str,
) -> Vec<String> {
    let mut paths = Vec::new();
    let opener_key = opener_object_key(asset_id);
    if matches!(playable_state, "opener_ready" | "hls_ready")
        && artifacts
            .iter()
            .any(|artifact| artifact.object_key == opener_key)
    {
        paths.push("opener.mp4".to_owned());
    }

    if playable_state != "hls_ready" {
        return paths;
    }

    let manifest_key = hls_manifest_object_key(asset_id);
    if artifacts
        .iter()
        .any(|artifact| artifact.object_key == manifest_key)
    {
        paths.push("hls/master.m3u8".to_owned());
    }

    let object_prefix = format!("videos/{asset_id}/");
    let mut segment_paths = artifacts
        .iter()
        .filter(|artifact| artifact.kind == "segment")
        .filter_map(|artifact| artifact.object_key.strip_prefix(&object_prefix))
        .filter(|artifact_path| artifact_path.starts_with("hls/"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    segment_paths.sort();
    paths.extend(segment_paths);

    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_object_keys_are_deterministic() {
        assert_eq!(
            opener_object_key("asset-123"),
            "videos/asset-123/opener.mp4"
        );
        assert_eq!(
            thumbnail_object_key("asset-123"),
            "videos/asset-123/thumbnail.jpg"
        );
        assert_eq!(
            hls_manifest_object_key("asset-123"),
            "videos/asset-123/hls/master.m3u8"
        );
        assert_eq!(
            hls_segment_object_key("asset-123", "segment_00000.ts"),
            "videos/asset-123/hls/segment_00000.ts"
        );
    }

    #[test]
    fn playback_artifact_paths_include_opener_manifest_and_sorted_segments_when_hls_ready() {
        let artifacts = vec![
            UploadedArtifact {
                kind: "segment",
                object_key: hls_segment_object_key("asset-123", "segment_00001.ts"),
                content_type: "video/mp2t",
                byte_size: 1,
                duration_ms: Some(2_000),
                resolution_tier: Some("1080p".to_owned()),
            },
            UploadedArtifact {
                kind: "opener",
                object_key: opener_object_key("asset-123"),
                content_type: "video/mp4",
                byte_size: 1,
                duration_ms: Some(5_000),
                resolution_tier: Some("1080p".to_owned()),
            },
            UploadedArtifact {
                kind: "manifest",
                object_key: hls_manifest_object_key("asset-123"),
                content_type: "application/vnd.apple.mpegurl",
                byte_size: 1,
                duration_ms: Some(0),
                resolution_tier: Some("1080p".to_owned()),
            },
            UploadedArtifact {
                kind: "segment",
                object_key: hls_segment_object_key("asset-123", "segment_00000.ts"),
                content_type: "video/mp2t",
                byte_size: 1,
                duration_ms: Some(2_000),
                resolution_tier: Some("1080p".to_owned()),
            },
            UploadedArtifact {
                kind: "thumbnail",
                object_key: thumbnail_object_key("asset-123"),
                content_type: "image/jpeg",
                byte_size: 1,
                duration_ms: None,
                resolution_tier: None,
            },
        ];

        assert_eq!(
            playback_artifact_paths("asset-123", &artifacts, "hls_ready"),
            vec![
                "opener.mp4".to_owned(),
                "hls/master.m3u8".to_owned(),
                "hls/segment_00000.ts".to_owned(),
                "hls/segment_00001.ts".to_owned(),
            ]
        );
    }

    #[test]
    fn playback_artifact_paths_include_only_opener_when_hls_is_not_ready() {
        let artifacts = vec![
            UploadedArtifact {
                kind: "opener",
                object_key: opener_object_key("asset-123"),
                content_type: "video/mp4",
                byte_size: 1,
                duration_ms: Some(5_000),
                resolution_tier: Some("720p".to_owned()),
            },
            UploadedArtifact {
                kind: "segment",
                object_key: hls_segment_object_key("asset-123", "segment_00000.ts"),
                content_type: "video/mp2t",
                byte_size: 1,
                duration_ms: Some(2_000),
                resolution_tier: Some("720p".to_owned()),
            },
        ];

        assert_eq!(
            playback_artifact_paths("asset-123", &artifacts, "opener_ready"),
            vec!["opener.mp4".to_owned()]
        );
    }

    #[test]
    fn command_output_is_limited() {
        let bytes = vec![b'a'; OUTPUT_LOG_LIMIT_BYTES + 4];
        let output = limit_bytes(&bytes);
        assert!(output.ends_with("...[truncated]"));
        assert!(output.len() < OUTPUT_LOG_LIMIT_BYTES + 32);
    }

    #[test]
    fn resolution_tier_uses_max_dimension() {
        assert_eq!(classify_resolution_tier(1280, 720), "720p");
        assert_eq!(classify_resolution_tier(1920, 1080), "1080p");
        assert_eq!(classify_resolution_tier(2048, 1080), "2k");
        assert_eq!(classify_resolution_tier(3840, 2160), "4k");
        assert_eq!(classify_resolution_tier(1080, 1920), "1080p");
    }

    #[test]
    fn hls_segment_duration_parser_maps_extinf_to_segment_names() {
        let durations = parse_hls_segment_durations(
            r#"#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2.000000,
segment_00000.ts
#EXTINF:1.234,
hls/segment_00001.ts
#EXT-X-ENDLIST
"#,
        );

        assert_eq!(durations["segment_00000.ts"], 2_000);
        assert_eq!(durations["segment_00001.ts"], 1_234);
    }
}
