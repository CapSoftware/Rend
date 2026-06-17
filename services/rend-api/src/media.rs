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
const HLS_X264_PRESET: &str = "superfast";
const HLS_AUDIO_BITRATE: &str = "96k";
const HLS_TARGET_SEGMENT_SECONDS: u32 = 2;
const HLS_DEFAULT_KEYFRAME_INTERVAL_FRAMES: u32 = 48;
const HLS_MIN_KEYFRAME_INTERVAL_FRAMES: u32 = 12;
const HLS_MAX_KEYFRAME_INTERVAL_FRAMES: u32 = 240;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HlsRendition {
    name: &'static str,
    max_dimension: i32,
    video_bitrate: &'static str,
    maxrate: &'static str,
    bufsize: &'static str,
    resolution_tier: &'static str,
}

const HLS_RENDITIONS: [HlsRendition; 4] = [
    HlsRendition {
        name: "720p",
        max_dimension: 1280,
        video_bitrate: "2800k",
        maxrate: "3200k",
        bufsize: "5600k",
        resolution_tier: "720p",
    },
    HlsRendition {
        name: "1080p",
        max_dimension: 1920,
        video_bitrate: "5000k",
        maxrate: "5800k",
        bufsize: "10000k",
        resolution_tier: "1080p",
    },
    HlsRendition {
        name: "2k",
        max_dimension: 2560,
        video_bitrate: "8000k",
        maxrate: "9200k",
        bufsize: "16000k",
        resolution_tier: "2k",
    },
    HlsRendition {
        name: "4k",
        max_dimension: 3840,
        video_bitrate: "14000k",
        maxrate: "16000k",
        bufsize: "28000k",
        resolution_tier: "4k",
    },
];

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

#[derive(Clone, Debug, PartialEq)]
struct SourceProbe {
    duration_ms: i64,
    width: i32,
    height: i32,
    resolution_tier: &'static str,
    has_audio: bool,
    frame_rate: Option<f64>,
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
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
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
        generate_and_upload_hls(request, processing_dir, &source_path, &source_probe)
            .await
            .context("failed to generate HLS artifacts")?;

    let mut artifacts = Vec::with_capacity(1 + hls_artifacts.len());
    if let Some(thumbnail_artifact) = thumbnail_artifact {
        artifacts.push(thumbnail_artifact);
    }
    artifacts.extend(hls_artifacts);

    let has_manifest = artifacts.iter().any(|artifact| artifact.kind == "manifest");
    let segment_count = artifacts
        .iter()
        .filter(|artifact| artifact.kind == "segment")
        .count();
    anyhow::ensure!(
        has_manifest && segment_count > 0,
        "HLS generation completed without playable manifest and segments"
    );
    let playable_state = "hls_ready";

    let promoted = persist_artifacts_and_state(
        &request.db,
        &request.asset_id,
        &artifacts,
        playable_state,
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
            os("-show_entries"),
            os("stream=codec_type,width,height,duration,avg_frame_rate,r_frame_rate:format=duration"),
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
        has_audio: parsed
            .streams
            .iter()
            .any(|stream| stream.codec_type.as_deref() == Some("audio")),
        frame_rate: source_frame_rate(stream),
    })
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
    let renditions = hls_renditions_for_source(source_probe);
    anyhow::ensure!(!renditions.is_empty(), "no HLS renditions selected");

    let hls_dir = processing_dir.join("hls");
    fs::create_dir_all(&hls_dir).await.with_context(|| {
        format!(
            "failed to create HLS output directory {}",
            hls_dir.display()
        )
    })?;
    let manifest_path = hls_dir.join("master.m3u8");
    let segment_pattern = hls_dir.join("%v").join("segment_%05d.ts");
    let variant_playlist_pattern = hls_dir.join("%v").join("index.m3u8");

    let mut args = vec![
        os("-y"),
        os("-i"),
        source_path.as_os_str().to_owned(),
        os("-filter_complex"),
        os(&hls_filter_complex(&renditions)),
    ];
    for rendition in &renditions {
        args.push(os("-map"));
        args.push(os(&format!("[{}]", hls_video_label(rendition))));
        if source_probe.has_audio {
            args.push(os("-map"));
            args.push(os("0:a:0"));
        }
    }
    let keyframe_interval = hls_keyframe_interval_frames(source_probe).to_string();
    let target_segment_seconds = HLS_TARGET_SEGMENT_SECONDS.to_string();
    args.extend([
        os("-c:v"),
        os("libx264"),
        os("-preset"),
        os(HLS_X264_PRESET),
        os("-profile:v"),
        os("main"),
        os("-pix_fmt"),
        os("yuv420p"),
        os("-g"),
        os(&keyframe_interval),
        os("-keyint_min"),
        os(&keyframe_interval),
        os("-sc_threshold"),
        os("0"),
        os("-force_key_frames"),
        os(&format!(
            "expr:gte(t,n_forced*{})",
            HLS_TARGET_SEGMENT_SECONDS
        )),
    ]);
    for (index, rendition) in renditions.iter().enumerate() {
        args.extend([
            os(&format!("-b:v:{index}")),
            os(rendition.video_bitrate),
            os(&format!("-maxrate:v:{index}")),
            os(rendition.maxrate),
            os(&format!("-bufsize:v:{index}")),
            os(rendition.bufsize),
        ]);
    }
    if source_probe.has_audio {
        args.extend([
            os("-c:a"),
            os("aac"),
            os("-b:a"),
            os(HLS_AUDIO_BITRATE),
            os("-ac"),
            os("2"),
        ]);
    }
    args.extend([
        os("-f"),
        os("hls"),
        os("-hls_time"),
        os(&target_segment_seconds),
        os("-hls_playlist_type"),
        os("vod"),
        os("-hls_flags"),
        os("independent_segments"),
        os("-hls_segment_filename"),
        segment_pattern.as_os_str().to_owned(),
        os("-master_pl_name"),
        os("master.m3u8"),
        os("-var_stream_map"),
        os(&hls_variant_stream_map(&renditions, source_probe.has_audio)),
        variant_playlist_pattern.as_os_str().to_owned(),
    ]);

    run_media_command(
        &request.config.ffmpeg_path,
        args,
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
        Some(0),
        Some(source_probe.resolution_tier),
    )
    .await?;
    artifacts.push(manifest_artifact);

    for rendition in &renditions {
        let playlist_path = hls_dir.join(rendition.name).join("index.m3u8");
        let segment_durations = hls_segment_durations(&playlist_path, rendition.name)
            .await
            .with_context(|| format!("failed to read {} HLS segment durations", rendition.name))?;
        let playlist_artifact = upload_generated_file(
            request,
            &playlist_path,
            hls_variant_playlist_object_key(&request.asset_id, rendition.name),
            "application/vnd.apple.mpegurl",
            "manifest",
            Some(0),
            Some(rendition.resolution_tier),
        )
        .await?;
        artifacts.push(playlist_artifact);

        let variant_dir = hls_dir.join(rendition.name);
        let mut segment_paths = Vec::new();
        let mut entries = fs::read_dir(&variant_dir).await.with_context(|| {
            format!(
                "failed to read HLS variant directory {}",
                variant_dir.display()
            )
        })?;
        while let Some(entry) = entries.next_entry().await.with_context(|| {
            format!(
                "failed to scan HLS variant directory {}",
                variant_dir.display()
            )
        })? {
            let path = entry.path();
            if path.extension().is_some_and(|extension| extension == "ts") {
                segment_paths.push(path);
            }
        }
        segment_paths.sort();

        anyhow::ensure!(
            !segment_paths.is_empty(),
            "ffmpeg did not create any {} HLS segments",
            rendition.name
        );

        for segment_path in segment_paths {
            let file_name = segment_path
                .file_name()
                .context("HLS segment path has no file name")?
                .to_string_lossy()
                .into_owned();
            let duration_key = format!("{}/{}", rendition.name, file_name);
            let duration_ms = segment_durations
                .get(&duration_key)
                .copied()
                .or(Some(2_000));
            let artifact = upload_generated_file(
                request,
                &segment_path,
                hls_segment_object_key(&request.asset_id, rendition.name, &file_name),
                "video/mp2t",
                "segment",
                duration_ms,
                Some(rendition.resolution_tier),
            )
            .await?;
            artifacts.push(artifact);
        }
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
        if artifact.kind == "opener" {
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

fn source_frame_rate(stream: &FfprobeStream) -> Option<f64> {
    stream
        .avg_frame_rate
        .as_deref()
        .and_then(parse_frame_rate)
        .or_else(|| stream.r_frame_rate.as_deref().and_then(parse_frame_rate))
}

fn parse_frame_rate(value: &str) -> Option<f64> {
    let value = value.trim();
    let frames_per_second = if let Some((numerator, denominator)) = value.split_once('/') {
        let numerator = numerator.trim().parse::<f64>().ok()?;
        let denominator = denominator.trim().parse::<f64>().ok()?;
        if denominator == 0.0 {
            return None;
        }
        numerator / denominator
    } else {
        value.parse::<f64>().ok()?
    };
    if frames_per_second.is_finite() && frames_per_second > 0.0 {
        Some(frames_per_second)
    } else {
        None
    }
}

fn hls_keyframe_interval_frames(source_probe: &SourceProbe) -> u32 {
    source_probe
        .frame_rate
        .map(|frame_rate| (frame_rate * f64::from(HLS_TARGET_SEGMENT_SECONDS)).round())
        .filter(|frames| frames.is_finite() && *frames > 0.0)
        .map(|frames| {
            (frames as u32).clamp(
                HLS_MIN_KEYFRAME_INTERVAL_FRAMES,
                HLS_MAX_KEYFRAME_INTERVAL_FRAMES,
            )
        })
        .unwrap_or(HLS_DEFAULT_KEYFRAME_INTERVAL_FRAMES)
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

fn hls_renditions_for_source(source_probe: &SourceProbe) -> Vec<HlsRendition> {
    let source_tier_index = HLS_RENDITIONS
        .iter()
        .position(|rendition| rendition.resolution_tier == source_probe.resolution_tier)
        .unwrap_or(0);
    let mut renditions = HLS_RENDITIONS[..=source_tier_index].to_vec();
    renditions.reverse();
    renditions
}

fn hls_video_label(rendition: &HlsRendition) -> String {
    format!(
        "v{}",
        rendition
            .name
            .chars()
            .filter(|value| value.is_ascii_alphanumeric())
            .collect::<String>()
    )
}

fn hls_source_label(rendition: &HlsRendition) -> String {
    format!("{}src", hls_video_label(rendition))
}

fn hls_filter_complex(renditions: &[HlsRendition]) -> String {
    let split_outputs = renditions
        .iter()
        .map(|rendition| format!("[{}]", hls_source_label(rendition)))
        .collect::<String>();
    let mut filter = format!("[0:v]split={}{};", renditions.len(), split_outputs);
    let scales = renditions
        .iter()
        .map(|rendition| {
            format!(
                "[{}]scale=w='if(gte(iw,ih),min({},iw),-2)':h='if(gte(iw,ih),-2,min({},ih))'[{}]",
                hls_source_label(rendition),
                rendition.max_dimension,
                rendition.max_dimension,
                hls_video_label(rendition)
            )
        })
        .collect::<Vec<_>>()
        .join(";");
    filter.push_str(&scales);
    filter
}

fn hls_variant_stream_map(renditions: &[HlsRendition], has_audio: bool) -> String {
    renditions
        .iter()
        .enumerate()
        .map(|(index, rendition)| {
            if has_audio {
                format!("v:{index},a:{index},name:{}", rendition.name)
            } else {
                format!("v:{index},name:{}", rendition.name)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

async fn hls_segment_durations(
    manifest_path: &Path,
    path_prefix: &str,
) -> Result<HashMap<String, i64>> {
    let manifest = fs::read_to_string(manifest_path)
        .await
        .with_context(|| format!("failed to read HLS manifest {}", manifest_path.display()))?;
    Ok(parse_hls_segment_durations(&manifest, path_prefix))
}

fn parse_hls_segment_durations(manifest: &str, path_prefix: &str) -> HashMap<String, i64> {
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
            && let Some(segment_path) = hls_segment_duration_key(line, path_prefix)
        {
            durations.insert(segment_path, duration_ms);
        }
    }
    durations
}

fn hls_segment_duration_key(line: &str, path_prefix: &str) -> Option<String> {
    let path = line.split('?').next()?.trim().trim_start_matches("./");
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains("..")
        || path.contains("://")
    {
        return None;
    }
    if path.contains('/') || path_prefix.is_empty() {
        Some(path.to_owned())
    } else {
        Some(format!("{path_prefix}/{path}"))
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

pub fn hls_variant_playlist_object_key(asset_id: &str, rendition_name: &str) -> String {
    format!("videos/{asset_id}/hls/{rendition_name}/index.m3u8")
}

pub fn hls_segment_object_key(asset_id: &str, rendition_name: &str, segment_name: &str) -> String {
    format!("videos/{asset_id}/hls/{rendition_name}/{segment_name}")
}

fn playback_artifact_paths(
    asset_id: &str,
    artifacts: &[UploadedArtifact],
    playable_state: &str,
) -> Vec<String> {
    let mut paths = Vec::new();
    let opener_key = opener_object_key(asset_id);
    let has_opener = artifacts
        .iter()
        .any(|artifact| artifact.object_key == opener_key);

    if playable_state == "opener_ready" && has_opener {
        paths.push("opener.mp4".to_owned());
    }

    if playable_state != "hls_ready" {
        return paths;
    }

    let object_prefix = format!("videos/{asset_id}/");
    let mut manifest_paths = artifacts
        .iter()
        .filter(|artifact| artifact.kind == "manifest")
        .filter_map(|artifact| artifact.object_key.strip_prefix(&object_prefix))
        .filter(|artifact_path| artifact_path.starts_with("hls/"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    manifest_paths.sort();
    if let Some(master_index) = manifest_paths
        .iter()
        .position(|artifact_path| artifact_path == "hls/master.m3u8")
    {
        paths.push(manifest_paths.remove(master_index));
    }
    paths.extend(manifest_paths);

    let mut segment_paths = artifacts
        .iter()
        .filter(|artifact| artifact.kind == "segment")
        .filter_map(|artifact| artifact.object_key.strip_prefix(&object_prefix))
        .filter(|artifact_path| artifact_path.starts_with("hls/"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    segment_paths.sort();
    paths.extend(segment_paths);
    if has_opener {
        paths.push("opener.mp4".to_owned());
    }

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
            hls_variant_playlist_object_key("asset-123", "720p"),
            "videos/asset-123/hls/720p/index.m3u8"
        );
        assert_eq!(
            hls_segment_object_key("asset-123", "720p", "segment_00000.ts"),
            "videos/asset-123/hls/720p/segment_00000.ts"
        );
    }

    #[test]
    fn playback_artifact_paths_include_manifest_playlists_and_sorted_segments_when_hls_ready() {
        let artifacts = vec![
            UploadedArtifact {
                kind: "segment",
                object_key: hls_segment_object_key("asset-123", "1080p", "segment_00001.ts"),
                content_type: "video/mp2t",
                byte_size: 1,
                duration_ms: Some(2_000),
                resolution_tier: Some("1080p".to_owned()),
            },
            UploadedArtifact {
                kind: "manifest",
                object_key: hls_variant_playlist_object_key("asset-123", "720p"),
                content_type: "application/vnd.apple.mpegurl",
                byte_size: 1,
                duration_ms: Some(0),
                resolution_tier: Some("720p".to_owned()),
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
                object_key: hls_segment_object_key("asset-123", "720p", "segment_00000.ts"),
                content_type: "video/mp2t",
                byte_size: 1,
                duration_ms: Some(2_000),
                resolution_tier: Some("720p".to_owned()),
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
                "hls/master.m3u8".to_owned(),
                "hls/720p/index.m3u8".to_owned(),
                "hls/1080p/segment_00001.ts".to_owned(),
                "hls/720p/segment_00000.ts".to_owned(),
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
                object_key: hls_segment_object_key("asset-123", "720p", "segment_00000.ts"),
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
    fn hls_ladder_selection_stays_with_supported_resolution_tiers() {
        let source_probe = SourceProbe {
            duration_ms: 12_000,
            width: 1920,
            height: 1080,
            resolution_tier: "1080p",
            has_audio: true,
            frame_rate: Some(30.0),
        };
        let renditions = hls_renditions_for_source(&source_probe);

        assert_eq!(
            renditions
                .iter()
                .map(|rendition| rendition.name)
                .collect::<Vec<_>>(),
            vec!["1080p", "720p"]
        );
        assert_eq!(
            hls_variant_stream_map(&renditions, true),
            "v:0,a:0,name:1080p v:1,a:1,name:720p"
        );
        assert_eq!(
            hls_variant_stream_map(&renditions, false),
            "v:0,name:1080p v:1,name:720p"
        );
    }

    #[test]
    fn frame_rate_parser_handles_ffprobe_ratios() {
        assert_eq!(parse_frame_rate("30/1"), Some(30.0));
        assert!((parse_frame_rate("30000/1001").unwrap() - 29.970_029).abs() < 0.000_001);
        assert_eq!(parse_frame_rate("0/0"), None);
        assert_eq!(parse_frame_rate("not-a-rate"), None);
    }

    #[test]
    fn hls_keyframe_interval_is_fps_aware_for_two_second_segments() {
        let mut source_probe = SourceProbe {
            duration_ms: 12_000,
            width: 1920,
            height: 1080,
            resolution_tier: "1080p",
            has_audio: true,
            frame_rate: Some(30.0),
        };

        assert_eq!(hls_keyframe_interval_frames(&source_probe), 60);
        source_probe.frame_rate = Some(24.0);
        assert_eq!(hls_keyframe_interval_frames(&source_probe), 48);
        source_probe.frame_rate = Some(60.0);
        assert_eq!(hls_keyframe_interval_frames(&source_probe), 120);
        source_probe.frame_rate = None;
        assert_eq!(
            hls_keyframe_interval_frames(&source_probe),
            HLS_DEFAULT_KEYFRAME_INTERVAL_FRAMES
        );
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
            "720p",
        );

        assert_eq!(durations["720p/segment_00000.ts"], 2_000);
        assert_eq!(durations["hls/segment_00001.ts"], 1_234);
    }
}
