use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use aws_sdk_s3::{Client as S3Client, primitives::ByteStream};
use sqlx::{PgPool, Postgres, Transaction};
use tokio::{fs, io, process::Command, time};

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
}

#[derive(Clone)]
struct UploadedArtifact {
    kind: &'static str,
    object_key: String,
    content_type: &'static str,
    byte_size: i64,
}

struct CommandOutput {
    stdout: String,
}

pub async fn process_uploaded_source(request: ProcessMediaRequest) -> Result<ProcessMediaOutcome> {
    match process_uploaded_source_inner(&request).await {
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
            })
        }
    }
}

async fn process_uploaded_source_inner(
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
    probe_video_stream(&request.config, &source_path).await?;

    let opener_artifact = generate_and_upload_opener(request, processing_dir, &source_path)
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

    let hls_artifacts = match generate_and_upload_hls(request, processing_dir, &source_path).await {
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

    persist_artifacts_and_state(
        &request.db,
        &request.asset_id,
        &artifacts,
        playable_state,
        &opener_artifact.object_key,
    )
    .await?;

    Ok(ProcessMediaOutcome {
        playable_state: playable_state.to_owned(),
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

async fn probe_video_stream(config: &MediaProcessingConfig, source_path: &Path) -> Result<()> {
    let output = run_media_command(
        &config.ffprobe_path,
        vec![
            os("-v"),
            os("error"),
            os("-select_streams"),
            os("v:0"),
            os("-show_entries"),
            os("stream=codec_type"),
            os("-of"),
            os("csv=p=0"),
            source_path.as_os_str().to_owned(),
        ],
        config.process_timeout,
    )
    .await
    .context("ffprobe failed")?;

    anyhow::ensure!(
        output.stdout.lines().any(|line| line.trim() == "video"),
        "ffprobe found no video stream"
    );
    Ok(())
}

async fn generate_and_upload_opener(
    request: &ProcessMediaRequest,
    processing_dir: &Path,
    source_path: &Path,
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
    )
    .await
}

async fn generate_and_upload_hls(
    request: &ProcessMediaRequest,
    processing_dir: &Path,
    source_path: &Path,
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
    let manifest_artifact = upload_generated_file(
        request,
        &manifest_path,
        hls_manifest_object_key(&request.asset_id),
        "application/vnd.apple.mpegurl",
        "manifest",
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
        let artifact = upload_generated_file(
            request,
            &segment_path,
            hls_segment_object_key(&request.asset_id, &file_name),
            "video/mp2t",
            "segment",
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
    })
}

async fn persist_artifacts_and_state(
    db: &PgPool,
    asset_id: &str,
    artifacts: &[UploadedArtifact],
    playable_state: &str,
    opener_object_key: &str,
) -> Result<()> {
    let mut tx = db
        .begin()
        .await
        .context("failed to start artifact transaction")?;
    let mut opener_artifact_id = None;

    for artifact in artifacts {
        let artifact_id: String = insert_artifact(&mut tx, asset_id, artifact)
            .await
            .with_context(|| format!("failed to insert {} artifact", artifact.kind))?;
        if artifact.object_key == opener_object_key {
            opener_artifact_id = Some(artifact_id);
        }
    }

    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'uploaded',
            playable_state = $2,
            current_opener_artifact_id = $3::uuid
        WHERE id = $1::uuid
        ",
    )
    .bind(asset_id)
    .bind(playable_state)
    .bind(opener_artifact_id.as_deref())
    .execute(&mut *tx)
    .await
    .context("failed to update asset playable state")?;

    tx.commit()
        .await
        .context("failed to commit artifact transaction")?;
    Ok(())
}

async fn insert_artifact(
    tx: &mut Transaction<'_, Postgres>,
    asset_id: &str,
    artifact: &UploadedArtifact,
) -> Result<String> {
    let artifact_id = sqlx::query_scalar(
        "
        INSERT INTO rend.artifacts (asset_id, kind, object_key, content_type, byte_size)
        VALUES ($1::uuid, $2, $3, $4, $5)
        RETURNING id::text
        ",
    )
    .bind(asset_id)
    .bind(artifact.kind)
    .bind(&artifact.object_key)
    .bind(artifact.content_type)
    .bind(artifact.byte_size)
    .fetch_one(&mut **tx)
    .await?;

    Ok(artifact_id)
}

async fn set_failed_playable_state(db: &PgPool, asset_id: &str) -> Result<()> {
    sqlx::query(
        "
        UPDATE rend.assets
        SET source_state = 'uploaded',
            playable_state = 'failed',
            current_opener_artifact_id = NULL
        WHERE id = $1::uuid
        ",
    )
    .bind(asset_id)
    .execute(db)
    .await
    .context("failed to update failed playable state")?;
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
    fn command_output_is_limited() {
        let bytes = vec![b'a'; OUTPUT_LOG_LIMIT_BYTES + 4];
        let output = limit_bytes(&bytes);
        assert!(output.ends_with("...[truncated]"));
        assert!(output.len() < OUTPUT_LOG_LIMIT_BYTES + 32);
    }
}
