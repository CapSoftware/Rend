use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use aws_sdk_s3::{
    Client as S3Client,
    primitives::ByteStream,
    types::{CompletedMultipartUpload, CompletedPart, ObjectCannedAcl},
};
use axum::{
    Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt, stream};
use serde::Deserialize;
use sqlx::{PgPool, Postgres, Transaction};
use tokio::{fs, io::AsyncReadExt, net::TcpListener, process::Command, task::JoinHandle, time};

use crate::{
    billing,
    events::{self, ArtifactEventInput},
};

const OUTPUT_LOG_LIMIT_BYTES: usize = 8 * 1024;
const HLS_X264_PRESET: &str = "superfast";
const HLS_AUDIO_BITRATE: &str = "96k";
const OPENER_MAX_DIMENSION: i32 = 640;
const OPENER_VIDEO_CRF: &str = "27";
const PRIVATE_ALIAS_RENAME_CONCURRENCY: usize = 16;
const HLS_TARGET_SEGMENT_SECONDS: u32 = 1;
const HLS_FFMPEG_INIT_FILENAME: &str = "init.mp4";
const HLS_DEFAULT_KEYFRAME_INTERVAL_FRAMES: u32 = 30;
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

const HLS_RENDITIONS: [HlsRendition; 6] = [
    HlsRendition {
        name: "360p",
        max_dimension: 640,
        video_bitrate: "800k",
        maxrate: "950k",
        bufsize: "1600k",
        resolution_tier: "720p",
    },
    HlsRendition {
        name: "480p",
        max_dimension: 854,
        video_bitrate: "1400k",
        maxrate: "1700k",
        bufsize: "2800k",
        resolution_tier: "720p",
    },
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
    pub source_bucket: String,
    pub source_s3: S3Client,
    pub s3_bucket: String,
    pub s3: S3Client,
    pub db: PgPool,
    pub config: MediaProcessingConfig,
    pub public_playback_alias: Option<PublicPlaybackAliasConfig>,
    pub fence: Option<MediaJobFence>,
}

#[derive(Clone, Debug)]
pub struct MediaJobFence {
    pub job_id: String,
    pub lease_token: String,
    pub worker_id: String,
}

pub struct ProcessMediaOutcome {
    pub playable_state: String,
    pub playback_artifact_paths: Vec<String>,
    pub output_bytes: i64,
    pub unavailable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicPlaybackAliasAcl {
    Inherit,
    PublicRead,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicPlaybackAliasConfig {
    pub bucket: Option<String>,
    pub prefix: String,
    pub acl: PublicPlaybackAliasAcl,
    pub metadata_rename: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PlaybackAliasBackfillSummary {
    pub examined: u64,
    pub moved: u64,
    pub already_canonical: u64,
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
    video_codec: Option<String>,
    audio_codec: Option<String>,
    frame_rate: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceMetadata {
    pub duration_ms: i64,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone)]
struct SourceProxyState {
    s3: S3Client,
    bucket: String,
    object_key: String,
    token: String,
}

struct SourceProxy {
    url: String,
    task: JoinHandle<()>,
}

impl Drop for SourceProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
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
    codec_name: Option<String>,
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
                output_bytes: 0,
                unavailable: false,
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

pub async fn probe_uploaded_source(request: &ProcessMediaRequest) -> Result<SourceMetadata> {
    let proxy = start_source_proxy(request).await?;
    let probe = probe_video_stream(&request.config, Path::new(&proxy.url)).await?;
    Ok(SourceMetadata {
        duration_ms: probe.duration_ms,
        width: probe.width,
        height: probe.height,
    })
}

async fn process_in_dir(
    request: &ProcessMediaRequest,
    processing_dir: &Path,
) -> Result<ProcessMediaOutcome> {
    let source_proxy = start_source_proxy(request).await?;
    let source_path = PathBuf::from(&source_proxy.url);
    let source_probe = probe_video_stream(&request.config, &source_path).await?;

    let opener_artifact =
        generate_and_upload_opener(request, processing_dir, &source_path, &source_probe)
            .await
            .context("failed to generate opener")?;
    let opener_artifacts = vec![opener_artifact];
    let opener_bytes = opener_artifacts
        .iter()
        .map(|artifact| artifact.byte_size)
        .sum::<i64>();
    let opener_promoted = persist_artifacts_and_state(
        request,
        &opener_artifacts,
        "opener_ready",
        "opener",
        &source_probe,
    )
    .await?;
    if !opener_promoted {
        return Ok(ProcessMediaOutcome {
            playable_state: "deleted".to_owned(),
            playback_artifact_paths: Vec::new(),
            output_bytes: 0,
            unavailable: true,
        });
    }

    let thumbnail_artifact =
        match generate_and_upload_thumbnail(request, processing_dir, &source_path).await {
            Ok(artifact) => {
                let thumbnail_promoted = persist_artifacts_and_state(
                    request,
                    std::slice::from_ref(&artifact),
                    "opener_ready",
                    "thumbnail",
                    &source_probe,
                )
                .await?;
                if !thumbnail_promoted {
                    return Ok(ProcessMediaOutcome {
                        playable_state: "deleted".to_owned(),
                        playback_artifact_paths: Vec::new(),
                        output_bytes: 0,
                        unavailable: true,
                    });
                }
                Some(artifact)
            }
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

    let thumbnail_bytes = thumbnail_artifact
        .as_ref()
        .map(|artifact| artifact.byte_size)
        .unwrap_or(0);
    let artifacts = hls_artifacts;

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

    let promoted =
        persist_artifacts_and_state(request, &artifacts, playable_state, "hls", &source_probe)
            .await?;

    if !promoted {
        return Ok(ProcessMediaOutcome {
            playable_state: "deleted".to_owned(),
            playback_artifact_paths: Vec::new(),
            output_bytes: 0,
            unavailable: true,
        });
    }

    Ok(ProcessMediaOutcome {
        playable_state: playable_state.to_owned(),
        playback_artifact_paths: playback_artifact_paths(
            &request.asset_id,
            &artifacts,
            playable_state,
        ),
        output_bytes: opener_bytes.saturating_add(thumbnail_bytes).saturating_add(
            artifacts
                .iter()
                .map(|artifact| artifact.byte_size)
                .sum::<i64>(),
        ),
        unavailable: false,
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

async fn start_source_proxy(request: &ProcessMediaRequest) -> Result<SourceProxy> {
    let token = request
        .fence
        .as_ref()
        .map(|fence| fence.lease_token.clone())
        .unwrap_or_else(|| format!("inline-{}", request.asset_id));
    let state = SourceProxyState {
        s3: request.source_s3.clone(),
        bucket: request.source_bucket.clone(),
        object_key: request.source_object_key.clone(),
        token: token.clone(),
    };
    let app = Router::new()
        .route(
            "/source/{token}",
            get(source_proxy_get).head(source_proxy_head),
        )
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("failed to bind task-local source proxy")?;
    let address = listener
        .local_addr()
        .context("failed to inspect task-local source proxy address")?;
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::warn!(error = %error, "task-local source proxy stopped unexpectedly");
        }
    });
    Ok(SourceProxy {
        url: format!("http://{address}/source/{token}"),
        task,
    })
}

async fn source_proxy_get(
    State(state): State<SourceProxyState>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if token != state.token {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut get = state
        .s3
        .get_object()
        .bucket(&state.bucket)
        .key(&state.object_key);
    if let Some(range) = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        get = get.range(range);
    }
    let object = match get.send().await {
        Ok(object) => object,
        Err(error) => {
            tracing::warn!(error = %error, "task-local source range request failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    let status = if object.content_range().is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CONTENT_TYPE,
            object.content_type().unwrap_or("application/octet-stream"),
        );
    if let Some(length) = object.content_length() {
        response = response.header(header::CONTENT_LENGTH, length);
    }
    if let Some(range) = object.content_range() {
        response = response.header(header::CONTENT_RANGE, range);
    }
    response
        .body(Body::from_stream(source_byte_stream(object.body)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn source_proxy_head(
    State(state): State<SourceProxyState>,
    AxumPath(token): AxumPath<String>,
) -> Response {
    if token != state.token {
        return StatusCode::NOT_FOUND.into_response();
    }
    match state
        .s3
        .head_object()
        .bucket(&state.bucket)
        .key(&state.object_key)
        .send()
        .await
    {
        Ok(object) => {
            let mut response = Response::builder()
                .status(StatusCode::OK)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(
                    header::CONTENT_TYPE,
                    object.content_type().unwrap_or("application/octet-stream"),
                );
            if let Some(length) = object.content_length() {
                response = response.header(header::CONTENT_LENGTH, length);
            }
            response
                .body(Body::empty())
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(error) => {
            tracing::warn!(error = %error, "task-local source HEAD failed");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

fn source_byte_stream(
    body: ByteStream,
) -> impl futures_util::Stream<Item = std::result::Result<Bytes, std::io::Error>> {
    stream::try_unfold(body, |mut body| async move {
        match body.try_next().await {
            Ok(Some(chunk)) => Ok(Some((chunk, body))),
            Ok(None) => Ok(None),
            Err(error) => Err(std::io::Error::other(format!(
                "source proxy body failed: {error}"
            ))),
        }
    })
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
            os("stream=codec_type,codec_name,width,height,duration,avg_frame_rate,r_frame_rate:format=duration"),
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
        video_codec: stream.codec_name.clone(),
        audio_codec: parsed
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("audio"))
            .and_then(|stream| stream.codec_name.clone()),
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
            os("-vf"),
            os(&format!(
                "scale=w='if(gte(iw,ih),min({OPENER_MAX_DIMENSION},iw),-2)':h='if(gte(iw,ih),-2,min({OPENER_MAX_DIMENSION},ih))'"
            )),
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

async fn generate_and_upload_opener(
    request: &ProcessMediaRequest,
    _processing_dir: &Path,
    source_path: &Path,
    source_probe: &SourceProbe,
) -> Result<UploadedArtifact> {
    let args = opener_ffmpeg_args(source_path, source_probe);
    let object_key = opener_object_key(&request.asset_id);
    let uploaded_object_key = uploaded_artifact_object_key(request, &object_key);
    let source_size = request
        .source_s3
        .head_object()
        .bucket(&request.source_bucket)
        .key(&request.source_object_key)
        .send()
        .await
        .context("failed to size streamed source for opener multipart upload")?
        .content_length()
        .unwrap_or_default()
        .max(1) as u64;
    let part_size = multipart_output_part_size(source_size.saturating_mul(2));
    let byte_size = stream_ffmpeg_to_multipart_upload(
        request,
        args,
        &uploaded_object_key,
        part_size,
        request.config.process_timeout,
    )
    .await?;
    if request.fence.is_none() {
        upload_public_playback_alias_from_object(
            request,
            &object_key,
            &uploaded_object_key,
            "video/mp4",
        )
        .await?;
    }
    Ok(UploadedArtifact {
        kind: "opener",
        object_key,
        content_type: "video/mp4",
        byte_size,
        duration_ms: Some(source_probe.duration_ms),
        resolution_tier: Some(
            if source_probe.width.max(source_probe.height) <= OPENER_MAX_DIMENSION {
                source_probe.resolution_tier
            } else {
                "720p"
            }
            .to_owned(),
        ),
    })
}

fn opener_ffmpeg_args(source_path: &Path, source_probe: &SourceProbe) -> Vec<OsString> {
    let copy_video = source_probe.video_codec.as_deref() == Some("h264")
        && source_probe.width.max(source_probe.height) <= OPENER_MAX_DIMENSION;
    let keyframe_interval = hls_keyframe_interval_frames(source_probe).to_string();
    let mut args = vec![
        os("-y"),
        os("-i"),
        source_path.as_os_str().to_owned(),
        os("-map"),
        os("0:v:0"),
    ];
    if source_probe.has_audio {
        args.extend([os("-map"), os("0:a:0")]);
    }
    if copy_video {
        args.extend([os("-c:v"), os("copy")]);
    } else {
        args.extend([
            os("-vf"),
            os(&format!(
                "scale=w='if(gte(iw,ih),min({OPENER_MAX_DIMENSION},iw),-2)':h='if(gte(iw,ih),-2,min({OPENER_MAX_DIMENSION},ih))'"
            )),
            os("-c:v"),
            os("libx264"),
            os("-preset"),
            os(HLS_X264_PRESET),
            os("-crf"),
            os(OPENER_VIDEO_CRF),
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
    }
    if source_probe.has_audio {
        if copy_video && source_probe.audio_codec.as_deref() == Some("aac") {
            args.extend([os("-c:a"), os("copy")]);
        } else {
            args.extend([os("-c:a"), os("aac"), os("-b:a"), os(HLS_AUDIO_BITRATE)]);
        }
    }
    args.extend([
        os("-movflags"),
        os("+frag_keyframe+empty_moov+default_base_moof"),
        os("-frag_duration"),
        os("1000000"),
        os("-f"),
        os("mp4"),
        os("pipe:1"),
    ]);
    args
}

fn multipart_output_part_size(estimated_bytes: u64) -> usize {
    const MIN_PART_SIZE: u64 = 16 * 1024 * 1024;
    const TARGET_PART_COUNT: u64 = 9_500;
    const MIB: u64 = 1024 * 1024;
    let required = estimated_bytes.saturating_add(TARGET_PART_COUNT - 1) / TARGET_PART_COUNT;
    let rounded = required.saturating_add(MIB - 1) / MIB * MIB;
    usize::try_from(rounded.max(MIN_PART_SIZE)).unwrap_or(usize::MAX)
}

struct MultipartUploadGuard {
    s3: S3Client,
    bucket: String,
    object_key: String,
    upload_id: String,
    finished: bool,
}

impl MultipartUploadGuard {
    async fn abort(&mut self) {
        if self.finished {
            return;
        }
        let _ = self
            .s3
            .abort_multipart_upload()
            .bucket(&self.bucket)
            .key(&self.object_key)
            .upload_id(&self.upload_id)
            .send()
            .await;
        self.finished = true;
    }

    fn complete(&mut self) {
        self.finished = true;
    }
}

impl Drop for MultipartUploadGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let s3 = self.s3.clone();
        let bucket = self.bucket.clone();
        let object_key = self.object_key.clone();
        let upload_id = self.upload_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = s3
                    .abort_multipart_upload()
                    .bucket(bucket)
                    .key(object_key)
                    .upload_id(upload_id)
                    .send()
                    .await;
            });
        }
    }
}

async fn stream_ffmpeg_to_multipart_upload(
    request: &ProcessMediaRequest,
    args: Vec<OsString>,
    object_key: &str,
    part_size: usize,
    timeout: Duration,
) -> Result<i64> {
    let upload = request
        .s3
        .create_multipart_upload()
        .bucket(&request.s3_bucket)
        .key(object_key)
        .content_type("video/mp4")
        .send()
        .await
        .with_context(|| format!("failed to create opener multipart upload {object_key}"))?;
    let upload_id = upload
        .upload_id()
        .context("object store omitted opener multipart upload id")?
        .to_owned();
    let mut upload_guard = MultipartUploadGuard {
        s3: request.s3.clone(),
        bucket: request.s3_bucket.clone(),
        object_key: object_key.to_owned(),
        upload_id: upload_id.clone(),
        finished: false,
    };
    let result = time::timeout(timeout, async {
        let mut command = Command::new(&request.config.ffmpeg_path);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .context("failed to start streamed opener ffmpeg")?;
        let mut stdout = child
            .stdout
            .take()
            .context("ffmpeg opener stdout was unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("ffmpeg opener stderr was unavailable")?;
        let stderr_task = tokio::spawn(read_limited_process_output(stderr));
        let mut completed_parts = Vec::new();
        let mut total_bytes = 0_i64;
        loop {
            let mut buffer = Vec::with_capacity(part_size);
            while buffer.len() < part_size {
                let read = stdout
                    .read_buf(&mut buffer)
                    .await
                    .context("failed to read streamed opener output")?;
                if read == 0 {
                    break;
                }
            }
            if buffer.is_empty() {
                break;
            }
            let part_number = i32::try_from(completed_parts.len() + 1)
                .context("opener multipart upload exceeded supported part count")?;
            anyhow::ensure!(
                part_number <= 10_000,
                "opener multipart upload exceeded 10000 parts"
            );
            let part_len = i64::try_from(buffer.len()).context("opener part is too large")?;
            let uploaded = request
                .s3
                .upload_part()
                .bucket(&request.s3_bucket)
                .key(object_key)
                .upload_id(&upload_id)
                .part_number(part_number)
                .content_length(part_len)
                .body(ByteStream::from(Bytes::from(buffer)))
                .send()
                .await
                .with_context(|| format!("failed to upload opener part {part_number}"))?;
            completed_parts.push(
                CompletedPart::builder()
                    .part_number(part_number)
                    .e_tag(
                        uploaded
                            .e_tag()
                            .context("opener part response omitted ETag")?,
                    )
                    .build(),
            );
            total_bytes = total_bytes.saturating_add(part_len);
        }
        let status = child
            .wait()
            .await
            .context("failed to wait for streamed opener ffmpeg")?;
        let stderr = stderr_task
            .await
            .context("failed to join ffmpeg stderr reader")??;
        anyhow::ensure!(
            status.success(),
            "streamed opener ffmpeg exited with status {status}; stderr: {stderr}"
        );
        anyhow::ensure!(total_bytes > 0, "streamed opener output was empty");
        request
            .s3
            .complete_multipart_upload()
            .bucket(&request.s3_bucket)
            .key(object_key)
            .upload_id(&upload_id)
            .multipart_upload(
                CompletedMultipartUpload::builder()
                    .set_parts(Some(completed_parts))
                    .build(),
            )
            .send()
            .await
            .with_context(|| format!("failed to complete opener multipart upload {object_key}"))?;
        Ok::<i64, anyhow::Error>(total_bytes)
    })
    .await;
    match result {
        Ok(Ok(byte_size)) => {
            upload_guard.complete();
            Ok(byte_size)
        }
        Ok(Err(error)) => {
            upload_guard.abort().await;
            Err(error)
        }
        Err(_) => {
            upload_guard.abort().await;
            anyhow::bail!(
                "streamed opener generation timed out after {} seconds",
                timeout.as_secs()
            )
        }
    }
}

async fn read_limited_process_output(mut stderr: tokio::process::ChildStderr) -> Result<String> {
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stderr.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        if captured.len() < OUTPUT_LOG_LIMIT_BYTES {
            let remaining = OUTPUT_LOG_LIMIT_BYTES - captured.len();
            captured.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
    Ok(String::from_utf8_lossy(&captured).into_owned())
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
    for rendition in &renditions {
        let variant_dir = hls_dir.join(rendition.name);
        fs::create_dir_all(&variant_dir).await.with_context(|| {
            format!(
                "failed to create HLS variant directory {}",
                variant_dir.display()
            )
        })?;
    }
    let manifest_path = hls_dir.join("master.m3u8");
    let segment_pattern = hls_dir.join("%v").join("segment_%05d.m4s");
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
        os("-hls_segment_type"),
        os("fmp4"),
        os("-hls_flags"),
        os("independent_segments"),
        os("-hls_fmp4_init_filename"),
        os(HLS_FFMPEG_INIT_FILENAME),
        os("-hls_segment_filename"),
        segment_pattern.as_os_str().to_owned(),
        os("-master_pl_name"),
        os("master.m3u8"),
        os("-var_stream_map"),
        os(&hls_variant_stream_map(&renditions, source_probe.has_audio)),
        variant_playlist_pattern.as_os_str().to_owned(),
    ]);

    let mut artifacts = run_hls_command_with_streaming_uploads(
        request,
        &request.config.ffmpeg_path,
        args,
        &hls_dir,
        &renditions,
        request.config.process_timeout,
    )
    .await?;

    for rendition in &renditions {
        let playlist_path = hls_dir.join(rendition.name).join("index.m3u8");
        let segment_durations = hls_segment_durations(&playlist_path, rendition.name)
            .await
            .with_context(|| format!("failed to read {} HLS segment durations", rendition.name))?;
        for artifact in &mut artifacts {
            let object_prefix = format!("videos/{}/hls/{}/", request.asset_id, rendition.name);
            let Some(file_name) = artifact.object_key.strip_prefix(&object_prefix) else {
                continue;
            };
            if artifact.kind == "segment" && !is_hls_init_segment_name(file_name) {
                artifact.duration_ms = segment_durations
                    .get(&format!("{}/{}", rendition.name, file_name))
                    .copied()
                    .or(Some(i64::from(HLS_TARGET_SEGMENT_SECONDS) * 1_000));
            }
        }
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
    }

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

    Ok(artifacts)
}

async fn run_hls_command_with_streaming_uploads(
    request: &ProcessMediaRequest,
    binary: &str,
    args: Vec<OsString>,
    hls_dir: &Path,
    renditions: &[HlsRendition],
    timeout: Duration,
) -> Result<Vec<UploadedArtifact>> {
    let command = run_media_command(binary, args, timeout);
    tokio::pin!(command);
    let mut poll = time::interval(Duration::from_millis(250));
    poll.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
    let mut artifacts = Vec::new();
    loop {
        tokio::select! {
            result = &mut command => {
                result?;
                break;
            }
            _ = poll.tick() => {
                upload_finalized_hls_fragments(request, hls_dir, renditions, false, &mut artifacts).await?;
            }
        }
    }
    normalize_hls_init_fragments(hls_dir, renditions).await?;
    upload_finalized_hls_fragments(request, hls_dir, renditions, true, &mut artifacts).await?;
    Ok(artifacts)
}

async fn normalize_hls_init_fragments(hls_dir: &Path, renditions: &[HlsRendition]) -> Result<()> {
    for (variant_index, rendition) in renditions.iter().enumerate() {
        let variant_dir = hls_dir.join(rendition.name);
        let ffmpeg_init_path = variant_dir.join(HLS_FFMPEG_INIT_FILENAME);
        let indexed_init_name = format!("init_{variant_index}.mp4");
        let indexed_init_path = variant_dir.join(&indexed_init_name);
        let normalized_init_name = format!("init_{}.mp4", rendition.name);
        let normalized_init_path = variant_dir.join(&normalized_init_name);

        // FFmpeg adds the numeric var_stream_map index even when the configured
        // init filename does not contain `%v`. Single-variant builds may still
        // emit the configured `init.mp4`, while retried normalization tests can
        // already contain Rend's rendition-named form. Accept exactly one of
        // those valid shapes and normalize it before uploading.
        let candidate_paths = [
            ffmpeg_init_path,
            indexed_init_path,
            normalized_init_path.clone(),
        ];
        let mut existing_paths = Vec::new();
        for candidate_path in candidate_paths {
            if fs::try_exists(&candidate_path).await? {
                existing_paths.push(candidate_path);
            }
        }
        anyhow::ensure!(
            existing_paths.len() == 1,
            "ffmpeg created an invalid {} HLS init file set; expected exactly one of {}, {}, or {}",
            rendition.name,
            HLS_FFMPEG_INIT_FILENAME,
            indexed_init_name,
            normalized_init_name,
        );
        let source_init_path = existing_paths.pop().expect("one init path was verified");
        if source_init_path != normalized_init_path {
            fs::rename(&source_init_path, &normalized_init_path)
                .await
                .with_context(|| {
                    format!(
                        "failed to normalize {} HLS init file {}",
                        rendition.name,
                        source_init_path.display()
                    )
                })?;
        }

        let playlist_path = variant_dir.join("index.m3u8");
        let playlist = fs::read_to_string(&playlist_path)
            .await
            .with_context(|| format!("failed to read {} HLS playlist", rendition.name))?;
        let normalized =
            normalize_hls_variant_playlist_init(&playlist, rendition.name, variant_index)?;
        if normalized != playlist {
            fs::write(&playlist_path, normalized)
                .await
                .with_context(|| format!("failed to normalize {} HLS playlist", rendition.name))?;
        }
    }
    Ok(())
}

fn normalize_hls_variant_playlist_init(
    playlist: &str,
    rendition: &str,
    variant_index: usize,
) -> Result<String> {
    let ffmpeg_reference = format!("URI=\"{HLS_FFMPEG_INIT_FILENAME}\"");
    let indexed_reference = format!("URI=\"init_{variant_index}.mp4\"");
    let normalized_reference = format!("URI=\"init_{rendition}.mp4\"");
    let init_maps = playlist
        .lines()
        .filter(|line| line.trim().starts_with("#EXT-X-MAP:"))
        .collect::<Vec<_>>();
    anyhow::ensure!(
        !init_maps.is_empty(),
        "{rendition} HLS playlist omitted its init map"
    );
    anyhow::ensure!(
        init_maps.iter().all(|line| {
            line.contains(&ffmpeg_reference)
                || line.contains(&indexed_reference)
                || line.contains(&normalized_reference)
        }),
        "{rendition} HLS playlist referenced an unexpected init file"
    );
    Ok(playlist
        .replace(&ffmpeg_reference, &normalized_reference)
        .replace(&indexed_reference, &normalized_reference))
}

async fn upload_finalized_hls_fragments(
    request: &ProcessMediaRequest,
    hls_dir: &Path,
    renditions: &[HlsRendition],
    include_active_segment: bool,
    artifacts: &mut Vec<UploadedArtifact>,
) -> Result<()> {
    for rendition in renditions {
        let variant_dir = hls_dir.join(rendition.name);
        let mut fragments = Vec::new();
        let mut media_segments = Vec::new();
        let mut entries = fs::read_dir(&variant_dir).await.with_context(|| {
            format!(
                "failed to scan HLS variant directory {}",
                variant_dir.display()
            )
        })?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !is_hls_media_fragment_path(&path) {
                continue;
            }
            if !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("init_"))
            {
                media_segments.push(path.clone());
            }
            fragments.push(path);
        }
        media_segments.sort();
        let active_segment = (!include_active_segment)
            .then(|| media_segments.last().cloned())
            .flatten();
        fragments.sort();
        for fragment_path in fragments {
            if active_segment.as_ref() == Some(&fragment_path) {
                continue;
            }
            if is_hls_init_segment_name(
                fragment_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default(),
            ) && media_segments.is_empty()
            {
                continue;
            }
            let file_name = fragment_path
                .file_name()
                .context("HLS fragment path has no file name")?
                .to_string_lossy()
                .into_owned();
            let artifact = upload_generated_file(
                request,
                &fragment_path,
                hls_segment_object_key(&request.asset_id, rendition.name, &file_name),
                "video/mp4",
                "segment",
                (!is_hls_init_segment_name(&file_name))
                    .then_some(i64::from(HLS_TARGET_SEGMENT_SECONDS) * 1_000),
                Some(rendition.resolution_tier),
            )
            .await?;
            fs::remove_file(&fragment_path).await.with_context(|| {
                format!(
                    "failed to remove uploaded HLS fragment {}",
                    fragment_path.display()
                )
            })?;
            artifacts.push(artifact);
        }
    }
    if include_active_segment {
        for rendition in renditions {
            anyhow::ensure!(
                artifacts.iter().any(|artifact| {
                    artifact.kind == "segment"
                        && artifact.object_key.starts_with(&format!(
                            "videos/{}/hls/{}/segment_",
                            request.asset_id, rendition.name
                        ))
                }),
                "ffmpeg did not create any {} HLS segments",
                rendition.name
            );
        }
    }
    Ok(())
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
    let uploaded_object_key = request
        .fence
        .as_ref()
        .map(|fence| attempt_object_key(&request.asset_id, &fence.lease_token, &object_key))
        .unwrap_or_else(|| object_key.clone());
    let metadata = fs::metadata(path)
        .await
        .with_context(|| format!("failed to stat generated artifact {}", path.display()))?;
    let byte_size =
        i64::try_from(metadata.len()).context("generated artifact is too large to record")?;
    anyhow::ensure!(
        byte_size > 0,
        "generated artifact {} is empty",
        path.display()
    );

    request
        .s3
        .put_object()
        .bucket(&request.s3_bucket)
        .key(&uploaded_object_key)
        .content_type(content_type)
        .content_length(byte_size)
        .body(
            ByteStream::read_from()
                .path(path)
                .build()
                .await
                .with_context(|| format!("failed to open generated artifact {}", path.display()))?,
        )
        .send()
        .await
        .with_context(|| format!("failed to upload generated artifact {uploaded_object_key}"))?;

    if request.fence.is_none() {
        upload_public_playback_alias(request, path, &object_key, content_type, byte_size).await?;
    }

    Ok(UploadedArtifact {
        kind,
        object_key,
        content_type,
        byte_size,
        duration_ms,
        resolution_tier: resolution_tier.map(str::to_owned),
    })
}

async fn upload_public_playback_alias(
    request: &ProcessMediaRequest,
    path: &Path,
    object_key: &str,
    content_type: &'static str,
    byte_size: i64,
) -> Result<()> {
    let Some(config) = request.public_playback_alias.as_ref() else {
        return Ok(());
    };
    let Some(alias_key) =
        public_playback_alias_object_key(&request.asset_id, object_key, &config.prefix)
    else {
        return Ok(());
    };

    let mut put = request
        .s3
        .put_object()
        .bucket(config.bucket.as_deref().unwrap_or(&request.s3_bucket))
        .key(&alias_key)
        .content_type(content_type)
        .content_length(byte_size)
        .body(
            ByteStream::read_from()
                .path(path)
                .build()
                .await
                .with_context(|| {
                    format!("failed to reopen generated artifact {}", path.display())
                })?,
        );
    if config.acl == PublicPlaybackAliasAcl::PublicRead {
        put = put.acl(ObjectCannedAcl::PublicRead);
    }

    put.send()
        .await
        .with_context(|| format!("failed to upload public playback alias {alias_key}"))?;
    Ok(())
}

async fn upload_public_playback_alias_from_object(
    request: &ProcessMediaRequest,
    canonical_object_key: &str,
    uploaded_object_key: &str,
    content_type: &'static str,
) -> Result<()> {
    let Some(config) = request.public_playback_alias.as_ref() else {
        return Ok(());
    };
    let Some(alias_key) =
        public_playback_alias_object_key(&request.asset_id, canonical_object_key, &config.prefix)
    else {
        return Ok(());
    };
    let mut copy = request
        .s3
        .copy_object()
        .bucket(config.bucket.as_deref().unwrap_or(&request.s3_bucket))
        .key(&alias_key)
        .copy_source(format!("{}/{}", request.s3_bucket, uploaded_object_key))
        .content_type(content_type)
        .metadata_directive(aws_sdk_s3::types::MetadataDirective::Replace);
    if config.acl == PublicPlaybackAliasAcl::PublicRead {
        copy = copy.acl(ObjectCannedAcl::PublicRead);
    }
    copy.send()
        .await
        .with_context(|| format!("failed to copy public playback alias {alias_key}"))?;
    Ok(())
}

async fn persist_artifacts_and_state(
    request: &ProcessMediaRequest,
    artifacts: &[UploadedArtifact],
    playable_state: &str,
    publication_phase: &str,
    source_probe: &SourceProbe,
) -> Result<bool> {
    let asset_id = &request.asset_id;
    let mut tx = request
        .db
        .begin()
        .await
        .context("failed to start artifact transaction")?;
    let mut opener_artifact_id = None;
    let row: Option<(String, String, bool, bool, bool)> = sqlx::query_as(
        "
        SELECT asset.organization_id::text,
               asset.playable_state,
               asset.deleted_at IS NOT NULL,
               asset.suspended_at IS NOT NULL,
               org.suspended_at IS NOT NULL
        FROM rend.assets asset
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE asset.id = $1::uuid
        FOR UPDATE OF asset
        ",
    )
    .bind(asset_id)
    .fetch_optional(&mut *tx)
    .await
    .context("failed to lock asset playable state")?;

    let Some((organization_id, previous_playable_state, deleted, asset_suspended, org_suspended)) =
        row
    else {
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

    let mut reserved_output_bytes = 0_i64;
    if let Some(fence) = request.fence.as_ref() {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(&fence.job_id)
            .execute(&mut *tx)
            .await
            .context("failed to acquire media artifact publication fence")?;
        let active: Option<i64> = sqlx::query_scalar(
            "
            SELECT reserved_output_bytes
            FROM rend.media_jobs
            WHERE id = $1::uuid AND lease_token = $2::uuid AND locked_by = $3
              AND status = 'running' AND lease_expires_at > clock_timestamp()
            ",
        )
        .bind(&fence.job_id)
        .bind(&fence.lease_token)
        .bind(&fence.worker_id)
        .fetch_optional(&mut *tx)
        .await
        .context("failed to validate media artifact fence")?;
        let Some(active) = active else {
            tx.commit().await?;
            return Ok(false);
        };
        reserved_output_bytes = active;
    }

    let artifact_keys = artifacts
        .iter()
        .map(|artifact| artifact.object_key.clone())
        .collect::<Vec<_>>();
    let existing_keys = sqlx::query_scalar::<_, String>(
        "SELECT object_key FROM rend.artifacts WHERE asset_id = $1::uuid AND object_key = ANY($2::text[])",
    )
    .bind(asset_id)
    .bind(&artifact_keys)
    .fetch_all(&mut *tx)
    .await
    .context("failed to load existing canonical media artifacts")?
    .into_iter()
    .collect::<HashSet<_>>();
    let new_artifacts = artifacts
        .iter()
        .filter(|artifact| !existing_keys.contains(&artifact.object_key))
        .collect::<Vec<_>>();
    // Fenced workers upload into immutable, lease-scoped keys. On Tigris we
    // metadata-rename the winning objects into their stable private `/v/`
    // names while the database publication fence is held. This is an O(1)
    // metadata operation: no media bytes are copied and stale workers can
    // never publish over the active lease.
    let uploaded_storage_keys = new_artifacts
        .iter()
        .map(|artifact| uploaded_artifact_object_key(request, &artifact.object_key))
        .collect::<Vec<_>>();
    let new_storage_keys = new_artifacts
        .iter()
        .map(|artifact| durable_artifact_storage_key(request, &artifact.object_key))
        .collect::<Vec<_>>();
    let publication_storage_keys = uploaded_storage_keys
        .iter()
        .chain(new_storage_keys.iter())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let database_result: Result<()> = async {
        if let Some(fence) = request.fence.as_ref() {
            let still_active: Option<String> = sqlx::query_scalar(
                "
                SELECT id::text FROM rend.media_jobs
                WHERE id = $1::uuid AND lease_token = $2::uuid AND locked_by = $3
                  AND status = 'running' AND lease_expires_at > clock_timestamp()
                ",
            )
            .bind(&fence.job_id)
            .bind(&fence.lease_token)
            .bind(&fence.worker_id)
            .fetch_optional(&mut *tx)
            .await
            .context("failed to revalidate media artifact fence before publication")?;
            if still_active.is_none() {
                anyhow::bail!("media artifact publication lease expired");
            }
        }

        promote_private_playback_aliases(request, &new_artifacts).await?;

        let planned_newly_used_bytes = new_artifacts.iter().fold(0_i64, |total, artifact| {
            total.saturating_add(artifact.byte_size)
        });
        let released_output_bytes = if playable_state == "hls_ready" {
            reserved_output_bytes
        } else {
            reserved_output_bytes.min(planned_newly_used_bytes)
        };
        let unreserved_bytes = planned_newly_used_bytes
            .saturating_sub(reserved_output_bytes)
            .max(0);
        let (org_reserved, org_used, org_limit): (i64, i64, i64) = sqlx::query_as(
            "SELECT reserved_bytes, used_bytes, byte_limit FROM rend.organization_storage_usage WHERE organization_id = $1::uuid FOR UPDATE",
        )
        .bind(&organization_id)
        .fetch_one(&mut *tx)
        .await
        .context("failed to lock organization output quota")?;
        let (global_reserved, global_used, global_limit): (i64, i64, i64) = sqlx::query_as(
            "SELECT reserved_bytes, used_bytes, byte_limit FROM rend.global_storage_usage WHERE singleton FOR UPDATE",
        )
        .fetch_one(&mut *tx)
        .await
        .context("failed to lock platform output quota")?;
        anyhow::ensure!(
            org_reserved
                .saturating_add(org_used)
                .saturating_add(unreserved_bytes)
                <= org_limit,
            "published media artifacts exceed the organization storage allowance"
        );
        anyhow::ensure!(
            global_reserved
                .saturating_add(global_used)
                .saturating_add(unreserved_bytes)
                <= global_limit,
            "published media artifacts exceed the platform storage budget"
        );

        let mut newly_used_bytes = 0_i64;
        for artifact in &new_artifacts {
            let storage_object_key = durable_artifact_storage_key(request, &artifact.object_key);
            let (artifact_id, byte_delta) =
                insert_artifact(&mut tx, asset_id, artifact, &storage_object_key)
                    .await
                    .with_context(|| format!("failed to insert {} artifact", artifact.kind))?;
            newly_used_bytes = newly_used_bytes.saturating_add(byte_delta);
            if artifact.kind == "opener" {
                opener_artifact_id = Some(artifact_id);
            }
        }

        let artifact_event_inputs = artifacts
            .iter()
            .filter(|artifact| !existing_keys.contains(&artifact.object_key))
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
            current_opener_artifact_id = COALESCE($3::uuid, current_opener_artifact_id),
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

    if newly_used_bytes != 0 || released_output_bytes > 0 {
        sqlx::query(
            "
            UPDATE rend.organization_storage_usage
            SET used_bytes = GREATEST(used_bytes + $2, 0),
                reserved_bytes = GREATEST(reserved_bytes - $3, 0)
            WHERE organization_id = $1::uuid
            ",
        )
        .bind(&organization_id)
        .bind(newly_used_bytes)
        .bind(released_output_bytes)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE rend.global_storage_usage SET used_bytes = GREATEST(used_bytes + $1, 0), reserved_bytes = GREATEST(reserved_bytes - $2, 0) WHERE singleton",
        )
        .bind(newly_used_bytes)
        .bind(released_output_bytes)
        .execute(&mut *tx)
        .await?;
        let reference = request
            .fence
            .as_ref()
            .map(|fence| format!("media:{}:{publication_phase}", fence.lease_token))
            .unwrap_or_else(|| format!("media:inline:{asset_id}:{publication_phase}"));
        sqlx::query(
            "
            INSERT INTO rend.storage_ledger_entries (
              organization_id, asset_id, reference_key, reason,
              reserved_bytes_delta, used_bytes_delta
            )
            VALUES ($1::uuid, $2::uuid, $3, 'media_artifacts_published', $4, $5)
            ON CONFLICT (organization_id, reference_key) DO NOTHING
            ",
        )
        .bind(&organization_id)
        .bind(asset_id)
        .bind(reference)
        .bind(-released_output_bytes)
        .bind(newly_used_bytes)
        .execute(&mut *tx)
        .await?;
        if let Some(fence) = request.fence.as_ref() {
            sqlx::query(
                "
                UPDATE rend.media_jobs
                SET reserved_output_bytes = GREATEST(reserved_output_bytes - $4, 0),
                    output_bytes = GREATEST(output_bytes + $5, 0)
                WHERE id = $1::uuid AND lease_token = $2::uuid AND locked_by = $3
                ",
            )
            .bind(&fence.job_id)
            .bind(&fence.lease_token)
            .bind(&fence.worker_id)
            .bind(released_output_bytes)
            .bind(newly_used_bytes)
            .execute(&mut *tx)
            .await?;
        }
    }

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

        Ok(())
    }
    .await;
    if let Err(error) = database_result {
        let _ = tx.rollback().await;
        return match resolve_uncertain_canonical_publication(
            request,
            &new_artifacts,
            &publication_storage_keys,
            playable_state,
        )
        .await
        {
            Ok(_) => Err(error),
            Err(cleanup_error) => Err(error.context(format!(
                "canonical publication resolution also failed: {cleanup_error}"
            ))),
        };
    }

    if let Err(error) = tx.commit().await {
        match resolve_uncertain_canonical_publication(
            request,
            &new_artifacts,
            &publication_storage_keys,
            playable_state,
        )
        .await
        {
            Ok(true) => tracing::warn!(
                asset_id,
                error = %error,
                "artifact transaction commit returned an error but publication was durably committed",
            ),
            Ok(false) => {
                return Err(error).context("failed to commit artifact transaction");
            }
            Err(verification_error) => {
                return Err(anyhow::Error::new(error).context(format!(
                    "artifact commit outcome could not be verified; immutable attempt objects were retained for safe retry: {verification_error}"
                )));
            }
        }
    }
    // A retry may regenerate a logical artifact that an earlier successful
    // publication already owns. Its lease-scoped duplicate is unreferenced and
    // can be reclaimed without touching the durable object's storage key.
    for artifact in artifacts
        .iter()
        .filter(|artifact| existing_keys.contains(&artifact.object_key))
    {
        let uploaded_object_key = uploaded_artifact_object_key(request, &artifact.object_key);
        if uploaded_object_key == artifact.object_key {
            continue;
        }
        if let Err(error) = request
            .s3
            .delete_object()
            .bucket(&request.s3_bucket)
            .key(&uploaded_object_key)
            .send()
            .await
        {
            tracing::warn!(
                asset_id,
                object_key = %uploaded_object_key,
                error = %error,
                "failed to clean duplicate media attempt object",
            );
        }
    }
    Ok(true)
}

fn durable_artifact_storage_key(request: &ProcessMediaRequest, canonical_key: &str) -> String {
    let Some(config) = request.public_playback_alias.as_ref() else {
        return uploaded_artifact_object_key(request, canonical_key);
    };
    if request.fence.is_none()
        || !config.metadata_rename
        || config.acl != PublicPlaybackAliasAcl::Inherit
        || config
            .bucket
            .as_deref()
            .is_some_and(|bucket| bucket != request.s3_bucket)
    {
        return uploaded_artifact_object_key(request, canonical_key);
    }
    public_playback_alias_object_key(&request.asset_id, canonical_key, &config.prefix)
        .unwrap_or_else(|| uploaded_artifact_object_key(request, canonical_key))
}

async fn promote_private_playback_aliases(
    request: &ProcessMediaRequest,
    artifacts: &[&UploadedArtifact],
) -> Result<()> {
    let Some(config) = request.public_playback_alias.as_ref() else {
        return Ok(());
    };
    if request.fence.is_none()
        || !config.metadata_rename
        || config.acl != PublicPlaybackAliasAcl::Inherit
        || config
            .bucket
            .as_deref()
            .is_some_and(|bucket| bucket != request.s3_bucket)
    {
        return Ok(());
    }

    // A typical 1080p asset has hundreds of segments. Renaming those aliases
    // serially kept hls_ready hidden for tens of seconds after FFmpeg had
    // finished. Preserve the publication fence and manifest-last ordering,
    // while allowing independent objects in each tier to move concurrently.
    for order in 0..=2 {
        let renames = artifacts
            .iter()
            .copied()
            .filter(|artifact| publication_order(&artifact.object_key) == order)
            .filter_map(|artifact| {
                let source_key = uploaded_artifact_object_key(request, &artifact.object_key);
                let destination_key = durable_artifact_storage_key(request, &artifact.object_key);
                (source_key != destination_key).then_some((source_key, destination_key))
            })
            .collect::<Vec<_>>();
        let s3 = request.s3.clone();
        let bucket = request.s3_bucket.clone();
        stream::iter(renames)
        .map(|(source_key, destination_key)| {
            let s3 = s3.clone();
            let bucket = bucket.clone();
            async move {
                tigris_metadata_rename(&s3, &bucket, &source_key, &destination_key)
                    .await
                    .with_context(|| {
                        format!(
                            "failed to metadata-rename private playback artifact {source_key} to {destination_key}"
                        )
                    })
            }
        })
        .buffer_unordered(PRIVATE_ALIAS_RENAME_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    }
    Ok(())
}

async fn tigris_metadata_rename(
    s3: &S3Client,
    bucket: &str,
    source_key: &str,
    destination_key: &str,
) -> Result<()> {
    s3.copy_object()
        .bucket(bucket)
        .key(destination_key)
        .copy_source(format!("{bucket}/{source_key}"))
        .customize()
        .mutate_request(|request| {
            request.headers_mut().append("x-tigris-rename", "true");
        })
        .send()
        .await?;
    Ok(())
}

pub async fn backfill_private_playback_aliases(
    db: &PgPool,
    s3: &S3Client,
    bucket: &str,
    alias_prefix: &str,
) -> Result<PlaybackAliasBackfillSummary> {
    let rows = sqlx::query_as::<_, (String, String, String, String, i64)>(
        "
        SELECT artifact.id::text,
               artifact.asset_id::text,
               artifact.object_key,
               artifact.storage_object_key,
               artifact.byte_size
        FROM rend.artifacts artifact
        INNER JOIN rend.assets asset ON asset.id = artifact.asset_id
        INNER JOIN rend_auth.organization org ON org.id = asset.organization_id
        WHERE artifact.kind <> 'source'
          AND asset.deleted_at IS NULL
          AND asset.suspended_at IS NULL
          AND org.suspended_at IS NULL
        ORDER BY artifact.asset_id,
                 CASE WHEN artifact.object_key LIKE '%/hls/master.m3u8' THEN 2
                      WHEN artifact.object_key LIKE '%.m3u8' THEN 1
                      ELSE 0 END,
                 artifact.object_key
        ",
    )
    .fetch_all(db)
    .await
    .context("failed to load playback artifacts for private alias backfill")?;

    let mut summary = PlaybackAliasBackfillSummary::default();
    for (artifact_id, asset_id, object_key, storage_object_key, byte_size) in rows {
        summary.examined = summary.examined.saturating_add(1);
        let destination_key =
            public_playback_alias_object_key(&asset_id, &object_key, alias_prefix)
                .with_context(|| format!("artifact {artifact_id} has no safe playback alias"))?;
        if storage_object_key == destination_key {
            summary.already_canonical = summary.already_canonical.saturating_add(1);
            continue;
        }

        let rename_result =
            tigris_metadata_rename(s3, bucket, &storage_object_key, &destination_key).await;
        if let Err(rename_error) = rename_result {
            let destination = s3
                .head_object()
                .bucket(bucket)
                .key(&destination_key)
                .send()
                .await
                .with_context(|| {
                    format!(
                        "failed to resume playback alias {destination_key} after rename error: {rename_error}"
                    )
                })?;
            anyhow::ensure!(
                destination.content_length() == Some(byte_size),
                "existing playback alias {destination_key} has an unexpected size"
            );
        }

        let updated = sqlx::query(
            "UPDATE rend.artifacts SET storage_object_key = $2 WHERE id = $1::uuid AND storage_object_key = $3",
        )
        .bind(&artifact_id)
        .bind(&destination_key)
        .bind(&storage_object_key)
        .execute(db)
        .await
        .with_context(|| format!("failed to commit playback alias for artifact {artifact_id}"))?;
        if updated.rows_affected() == 0 {
            let durable: Option<String> = sqlx::query_scalar(
                "SELECT storage_object_key FROM rend.artifacts WHERE id = $1::uuid",
            )
            .bind(&artifact_id)
            .fetch_optional(db)
            .await?;
            anyhow::ensure!(
                durable.as_deref() == Some(destination_key.as_str()),
                "artifact {artifact_id} changed concurrently during playback alias backfill"
            );
        }
        summary.moved = summary.moved.saturating_add(1);
    }
    Ok(summary)
}

fn publication_order(object_key: &str) -> u8 {
    if object_key.ends_with("/hls/master.m3u8") {
        2
    } else if object_key.ends_with(".m3u8") {
        1
    } else {
        0
    }
}

async fn cleanup_uncommitted_storage_objects(
    request: &ProcessMediaRequest,
    storage_keys: &[String],
) -> Result<()> {
    let mut first_error = None;
    for object_key in storage_keys.iter().rev() {
        if let Err(error) = request
            .s3
            .delete_object()
            .bucket(&request.s3_bucket)
            .key(object_key)
            .send()
            .await
        {
            tracing::error!(
                asset_id = %request.asset_id,
                object_key,
                error = %error,
                "failed to delete uncommitted immutable media object",
            );
            if first_error.is_none() {
                first_error = Some(anyhow::Error::new(error));
            }
        }
    }
    match first_error {
        Some(error) => Err(error.context("one or more uncommitted media objects remain")),
        None => Ok(()),
    }
}

async fn resolve_uncertain_canonical_publication(
    request: &ProcessMediaRequest,
    new_artifacts: &[&UploadedArtifact],
    storage_keys: &[String],
    playable_state: &str,
) -> Result<bool> {
    let mut tx = request
        .db
        .begin()
        .await
        .context("failed to begin canonical publication resolution")?;
    let durable_state: Option<String> = sqlx::query_scalar(
        "SELECT playable_state FROM rend.assets WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(&request.asset_id)
    .fetch_optional(&mut *tx)
    .await
    .context("failed to verify asset state after uncertain artifact commit")?;
    if let Some(fence) = request.fence.as_ref() {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(&fence.job_id)
            .execute(&mut *tx)
            .await
            .context("failed to lock uncertain canonical publication")?;
    }
    let object_keys = new_artifacts
        .iter()
        .map(|artifact| artifact.object_key.clone())
        .collect::<Vec<_>>();
    let durable_artifacts = sqlx::query_as::<_, (String, i64, String)>(
        "SELECT object_key, byte_size, storage_object_key FROM rend.artifacts WHERE asset_id = $1::uuid AND object_key = ANY($2::text[])",
    )
    .bind(&request.asset_id)
    .bind(&object_keys)
    .fetch_all(&mut *tx)
    .await
    .context("failed to verify artifacts after uncertain artifact commit")?
    .into_iter()
    .map(|(object_key, byte_size, storage_object_key)| {
        (object_key, (byte_size, storage_object_key))
    })
    .collect::<HashMap<_, _>>();
    let state_committed = publication_state_committed(playable_state, durable_state.as_deref());
    let committed = state_committed
        && new_artifacts.iter().all(|artifact| {
            let expected_storage_key = durable_artifact_storage_key(request, &artifact.object_key);
            durable_artifacts.get(&artifact.object_key)
                == Some(&(artifact.byte_size, expected_storage_key))
        });
    if !committed {
        cleanup_uncommitted_storage_objects(request, storage_keys).await?;
    }
    tx.commit()
        .await
        .context("failed to finish canonical publication resolution")?;
    Ok(committed)
}

fn publication_state_committed(expected: &str, durable: Option<&str>) -> bool {
    match (expected, durable) {
        ("opener_ready", Some("opener_ready" | "hls_ready")) => true,
        ("hls_ready", Some("hls_ready")) => true,
        (expected, Some(actual)) => expected == actual,
        (_, None) => false,
    }
}

async fn insert_artifact(
    tx: &mut Transaction<'_, Postgres>,
    asset_id: &str,
    artifact: &UploadedArtifact,
    storage_object_key: &str,
) -> Result<(String, i64)> {
    let artifact_id: String = sqlx::query_scalar(
        "
        INSERT INTO rend.artifacts (
          asset_id,
          kind,
          object_key,
          storage_object_key,
          content_type,
          byte_size,
          duration_ms,
          resolution_tier
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id::text
        ",
    )
    .bind(asset_id)
    .bind(artifact.kind)
    .bind(&artifact.object_key)
    .bind(storage_object_key)
    .bind(artifact.content_type)
    .bind(artifact.byte_size)
    .bind(artifact.duration_ms)
    .bind(artifact.resolution_tier.as_deref())
    .fetch_one(&mut **tx)
    .await?;

    Ok((artifact_id, artifact.byte_size))
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
        FOR UPDATE OF asset
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

    if matches!(
        previous_playable_state.as_str(),
        "opener_ready" | "hls_ready"
    ) {
        sqlx::query("UPDATE rend.assets SET source_state = 'uploaded' WHERE id = $1::uuid")
            .bind(asset_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
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
    let source_max_dimension = source_probe.width.max(source_probe.height);
    let renditions = HLS_RENDITIONS
        .iter()
        .copied()
        .filter(|rendition| rendition.max_dimension <= source_max_dimension)
        .collect::<Vec<_>>();
    if renditions.is_empty() {
        vec![HLS_RENDITIONS[0]]
    } else {
        renditions
    }
}

fn is_hls_media_fragment_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| is_hls_init_segment_name(name) || is_hls_media_segment_name(name))
}

fn is_hls_init_segment_name(name: &str) -> bool {
    name.strip_prefix("init_")
        .and_then(|value| value.strip_suffix(".mp4"))
        .is_some_and(|rendition| HLS_RENDITIONS.iter().any(|item| item.name == rendition))
}

fn is_hls_media_segment_name(name: &str) -> bool {
    let Some(number) = name
        .strip_prefix("segment_")
        .and_then(|value| value.strip_suffix(".m4s"))
    else {
        return false;
    };
    !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
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

fn attempt_object_key(asset_id: &str, lease_token: &str, canonical_key: &str) -> String {
    let asset_prefix = format!("videos/{asset_id}/");
    let relative = canonical_key
        .strip_prefix(&asset_prefix)
        .unwrap_or(canonical_key);
    format!("videos/{asset_id}/attempts/{lease_token}/{relative}")
}

pub async fn cleanup_attempt_prefix(
    db: &PgPool,
    s3: &S3Client,
    bucket: &str,
    asset_id: &str,
    lease_token: &str,
) -> Result<()> {
    let prefix = format!("videos/{asset_id}/attempts/{lease_token}/");
    let durable_keys = sqlx::query_scalar::<_, String>(
        "SELECT storage_object_key FROM rend.artifacts WHERE asset_id = $1::uuid AND storage_object_key LIKE $2",
    )
    .bind(asset_id)
    .bind(format!("{prefix}%"))
    .fetch_all(db)
    .await
    .context("failed to load durable media attempt objects")?
    .into_iter()
    .collect::<HashSet<_>>();
    let mut continuation_token = None;
    loop {
        let mut request = s3.list_objects_v2().bucket(bucket).prefix(&prefix);
        if let Some(token) = continuation_token.as_deref() {
            request = request.continuation_token(token);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("failed to list media attempt prefix {prefix}"))?;
        for object in response.contents() {
            let Some(key) = object.key() else {
                continue;
            };
            if durable_keys.contains(key) {
                continue;
            }
            s3.delete_object()
                .bucket(bucket)
                .key(key)
                .send()
                .await
                .with_context(|| format!("failed to delete media attempt object {key}"))?;
        }
        if !response.is_truncated().unwrap_or(false) {
            break;
        }
        continuation_token = response.next_continuation_token().map(str::to_owned);
        anyhow::ensure!(
            continuation_token.is_some(),
            "media attempt listing was truncated without a continuation token"
        );
    }
    Ok(())
}

fn uploaded_artifact_object_key(request: &ProcessMediaRequest, canonical_key: &str) -> String {
    request
        .fence
        .as_ref()
        .map(|fence| attempt_object_key(&request.asset_id, &fence.lease_token, canonical_key))
        .unwrap_or_else(|| canonical_key.to_owned())
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

pub fn normalize_public_playback_alias_prefix(value: &str) -> Result<String> {
    let prefix = value.trim().trim_matches('/');
    anyhow::ensure!(
        !prefix.is_empty(),
        "REND_PUBLIC_PLAYBACK_ALIAS_PREFIX must not be empty"
    );
    anyhow::ensure!(
        prefix.split('/').all(|part| !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))),
        "REND_PUBLIC_PLAYBACK_ALIAS_PREFIX must contain only safe path components"
    );
    Ok(prefix.to_owned())
}

fn public_playback_alias_object_key(
    asset_id: &str,
    object_key: &str,
    alias_prefix: &str,
) -> Option<String> {
    let object_prefix = format!("videos/{asset_id}/");
    let artifact_path = object_key.strip_prefix(&object_prefix)?;
    if artifact_path == "source" || artifact_path.contains("/../") || artifact_path.contains("/./")
    {
        return None;
    }
    Some(format!(
        "{}/{asset_id}/{artifact_path}",
        alias_prefix.trim_matches('/')
    ))
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
            hls_segment_object_key("asset-123", "480p", "init_480p.mp4"),
            "videos/asset-123/hls/480p/init_480p.mp4"
        );
        assert_eq!(
            hls_segment_object_key("asset-123", "720p", "segment_00000.m4s"),
            "videos/asset-123/hls/720p/segment_00000.m4s"
        );
    }

    #[test]
    fn fenced_artifact_storage_keys_are_immutable_per_lease() {
        let canonical = opener_object_key("asset-123");
        assert_eq!(
            attempt_object_key("asset-123", "lease-a", &canonical),
            "videos/asset-123/attempts/lease-a/opener.mp4"
        );
        assert_ne!(
            attempt_object_key("asset-123", "lease-a", &canonical),
            attempt_object_key("asset-123", "lease-b", &canonical)
        );
    }

    #[test]
    fn opener_publication_remains_committed_after_hls_advancement() {
        assert!(publication_state_committed(
            "opener_ready",
            Some("opener_ready")
        ));
        assert!(publication_state_committed(
            "opener_ready",
            Some("hls_ready")
        ));
        assert!(publication_state_committed("hls_ready", Some("hls_ready")));
        assert!(!publication_state_committed(
            "hls_ready",
            Some("opener_ready")
        ));
        assert!(!publication_state_committed("opener_ready", None));
    }

    #[test]
    fn public_playback_alias_object_keys_match_player_url_shape() {
        assert_eq!(normalize_public_playback_alias_prefix("/v/").unwrap(), "v");
        assert_eq!(
            public_playback_alias_object_key(
                "asset-123",
                "videos/asset-123/hls/360p/segment_00000.m4s",
                "v",
            )
            .as_deref(),
            Some("v/asset-123/hls/360p/segment_00000.m4s")
        );
        assert_eq!(
            public_playback_alias_object_key("asset-123", "videos/asset-123/hls/master.m3u8", "v",)
                .as_deref(),
            Some("v/asset-123/hls/master.m3u8")
        );
        assert_eq!(
            public_playback_alias_object_key("asset-123", "videos/other/hls/master.m3u8", "v"),
            None
        );
        assert_eq!(
            public_playback_alias_object_key("asset-123", "videos/asset-123/source", "v"),
            None
        );
    }

    #[test]
    fn public_playback_alias_prefix_rejects_unsafe_paths() {
        assert!(normalize_public_playback_alias_prefix("").is_err());
        assert!(normalize_public_playback_alias_prefix("../v").is_err());
        assert!(normalize_public_playback_alias_prefix("v//public").is_err());
        assert!(normalize_public_playback_alias_prefix("v/public").is_ok());
    }

    #[test]
    fn private_playback_publication_orders_master_manifest_last() {
        assert_eq!(publication_order("videos/asset/opener.mp4"), 0);
        assert_eq!(publication_order("videos/asset/hls/720p/init_720p.mp4"), 0);
        assert_eq!(publication_order("videos/asset/hls/720p/index.m3u8"), 1);
        assert_eq!(publication_order("videos/asset/hls/master.m3u8"), 2);
    }

    #[test]
    fn playback_artifact_paths_include_manifest_playlists_and_sorted_segments_when_hls_ready() {
        let artifacts = vec![
            UploadedArtifact {
                kind: "segment",
                object_key: hls_segment_object_key("asset-123", "1080p", "segment_00001.m4s"),
                content_type: "video/mp4",
                byte_size: 1,
                duration_ms: Some(1_000),
                resolution_tier: Some("1080p".to_owned()),
            },
            UploadedArtifact {
                kind: "manifest",
                object_key: hls_variant_playlist_object_key("asset-123", "1080p"),
                content_type: "application/vnd.apple.mpegurl",
                byte_size: 1,
                duration_ms: Some(0),
                resolution_tier: Some("1080p".to_owned()),
            },
            UploadedArtifact {
                kind: "manifest",
                object_key: hls_variant_playlist_object_key("asset-123", "480p"),
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
                object_key: hls_segment_object_key("asset-123", "480p", "init_480p.mp4"),
                content_type: "video/mp4",
                byte_size: 1,
                duration_ms: None,
                resolution_tier: Some("720p".to_owned()),
            },
            UploadedArtifact {
                kind: "segment",
                object_key: hls_segment_object_key("asset-123", "480p", "segment_00000.m4s"),
                content_type: "video/mp4",
                byte_size: 1,
                duration_ms: Some(1_000),
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
                "hls/1080p/index.m3u8".to_owned(),
                "hls/480p/index.m3u8".to_owned(),
                "hls/1080p/segment_00001.m4s".to_owned(),
                "hls/480p/init_480p.mp4".to_owned(),
                "hls/480p/segment_00000.m4s".to_owned(),
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
                object_key: hls_segment_object_key("asset-123", "720p", "segment_00000.m4s"),
                content_type: "video/mp4",
                byte_size: 1,
                duration_ms: Some(1_000),
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
            video_codec: Some("h264".to_owned()),
            audio_codec: Some("aac".to_owned()),
            frame_rate: Some(30.0),
        };
        let renditions = hls_renditions_for_source(&source_probe);

        assert_eq!(
            renditions
                .iter()
                .map(|rendition| rendition.name)
                .collect::<Vec<_>>(),
            vec!["360p", "480p", "720p", "1080p"]
        );
        assert_eq!(
            hls_variant_stream_map(&renditions, true),
            "v:0,a:0,name:360p v:1,a:1,name:480p v:2,a:2,name:720p v:3,a:3,name:1080p"
        );
        assert_eq!(
            hls_variant_stream_map(&renditions, false),
            "v:0,name:360p v:1,name:480p v:2,name:720p v:3,name:1080p"
        );
    }

    #[test]
    fn opener_downscales_large_compatible_video_and_reduces_audio() {
        let source_probe = SourceProbe {
            duration_ms: 75_000,
            width: 1920,
            height: 1080,
            resolution_tier: "1080p",
            has_audio: true,
            video_codec: Some("h264".to_owned()),
            audio_codec: Some("aac".to_owned()),
            frame_rate: Some(30.0),
        };

        let args = opener_ffmpeg_args(Path::new("source.mp4"), &source_probe)
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "aac"]));
        assert!(args.windows(2).any(|pair| pair == ["-b:a", "96k"]));
        assert!(args.iter().any(|value| value.contains("min(640,iw)")));
        assert!(args.iter().any(|value| value.contains("min(640,ih)")));
        assert!(args.windows(2).any(|pair| pair == ["-g", "30"]));
        assert!(args.windows(2).any(|pair| pair == ["-keyint_min", "30"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-force_key_frames", "expr:gte(t,n_forced*1)"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-frag_duration", "1000000"])
        );
        assert!(
            args.iter()
                .any(|value| value == "+frag_keyframe+empty_moov+default_base_moof")
        );
    }

    #[test]
    fn opener_keeps_zero_copy_for_small_compatible_video() {
        let source_probe = SourceProbe {
            duration_ms: 12_000,
            width: 640,
            height: 360,
            resolution_tier: "720p",
            has_audio: true,
            video_codec: Some("h264".to_owned()),
            audio_codec: Some("aac".to_owned()),
            frame_rate: Some(30.0),
        };

        let args = opener_ffmpeg_args(Path::new("source.mp4"), &source_probe)
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.windows(2).any(|pair| pair == ["-c:v", "copy"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "copy"]));
        assert!(!args.iter().any(|value| value == "-vf"));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-frag_duration", "1000000"])
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
    fn hls_keyframe_interval_is_fps_aware_for_one_second_segments() {
        let mut source_probe = SourceProbe {
            duration_ms: 12_000,
            width: 1920,
            height: 1080,
            resolution_tier: "1080p",
            has_audio: true,
            video_codec: Some("h264".to_owned()),
            audio_codec: Some("aac".to_owned()),
            frame_rate: Some(30.0),
        };

        assert_eq!(hls_keyframe_interval_frames(&source_probe), 30);
        source_probe.frame_rate = Some(24.0);
        assert_eq!(hls_keyframe_interval_frames(&source_probe), 24);
        source_probe.frame_rate = Some(60.0);
        assert_eq!(hls_keyframe_interval_frames(&source_probe), 60);
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
segment_00000.m4s
#EXTINF:1.234,
hls/segment_00001.ts
#EXT-X-ENDLIST
"#,
            "720p",
        );

        assert_eq!(durations["720p/segment_00000.m4s"], 2_000);
        assert_eq!(durations["hls/segment_00001.ts"], 1_234);
    }

    #[test]
    fn hls_variant_playlist_normalizes_ffmpeg_init_name_for_rendition() {
        let playlist = r#"#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1.000000,
segment_00000.m4s
#EXT-X-ENDLIST
"#;

        let normalized = normalize_hls_variant_playlist_init(playlist, "360p", 0).unwrap();

        assert!(normalized.contains("#EXT-X-MAP:URI=\"init_360p.mp4\""));
        assert!(!normalized.contains("URI=\"init.mp4\""));
    }

    #[test]
    fn hls_variant_playlist_rejects_literal_ffmpeg_variant_placeholder() {
        let playlist = r#"#EXTM3U
#EXT-X-MAP:URI="init_%v.mp4"
#EXTINF:1.000000,
segment_00000.m4s
"#;

        let error = normalize_hls_variant_playlist_init(playlist, "360p", 0).unwrap_err();

        assert!(error.to_string().contains("unexpected init file"));
    }

    #[tokio::test]
    async fn hls_init_fragment_normalization_renames_indexed_ffmpeg_output() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "rend-hls-init-normalization-{}-{unique}",
            std::process::id()
        ));
        let renditions = &HLS_RENDITIONS[..4];
        for (variant_index, rendition) in renditions.iter().enumerate() {
            let variant_dir = root.join(rendition.name);
            fs::create_dir_all(&variant_dir).await.unwrap();
            fs::write(
                variant_dir.join(format!("init_{variant_index}.mp4")),
                b"init",
            )
            .await
            .unwrap();
            fs::write(
                variant_dir.join("index.m3u8"),
                format!(
                    "#EXTM3U\n#EXT-X-MAP:URI=\"init_{variant_index}.mp4\"\nsegment_00000.m4s\n"
                ),
            )
            .await
            .unwrap();
        }

        normalize_hls_init_fragments(&root, renditions)
            .await
            .unwrap();

        for (variant_index, rendition) in renditions.iter().enumerate() {
            let variant_dir = root.join(rendition.name);
            assert!(
                !fs::try_exists(variant_dir.join(format!("init_{variant_index}.mp4")))
                    .await
                    .unwrap()
            );
            assert!(
                fs::try_exists(variant_dir.join(format!("init_{}.mp4", rendition.name)))
                    .await
                    .unwrap()
            );
            let playlist = fs::read_to_string(variant_dir.join("index.m3u8"))
                .await
                .unwrap();
            assert!(playlist.contains(&format!("#EXT-X-MAP:URI=\"init_{}.mp4\"", rendition.name)));
        }

        fs::remove_dir_all(root).await.unwrap();
    }
}
