use std::{
    fmt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rend_config::{env_bool, env_duration_secs, env_path, env_string, env_usize};
use serde::{Deserialize, Serialize};
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
    sync::{Mutex, mpsc},
};

const DEFAULT_QUEUE_CAPACITY: usize = 1024;
const HARD_QUEUE_CAPACITY: usize = 100_000;
const DEFAULT_BATCH_SIZE: usize = 100;
const HARD_BATCH_SIZE: usize = 1000;
const DEFAULT_SPOOL_MAX_BYTES: usize = 10 * 1024 * 1024;
const HARD_SPOOL_MAX_BYTES: usize = 1024 * 1024 * 1024;
const QUARANTINE_FILE_NAME: &str = "playback-events.quarantine.jsonl";

#[derive(Clone)]
pub(crate) struct TelemetryConfig {
    pub(crate) enabled: bool,
    pub(crate) ingest_url: Option<String>,
    pub(crate) internal_token: String,
    pub(crate) queue_capacity: usize,
    pub(crate) batch_size: usize,
    pub(crate) flush_interval: Duration,
    pub(crate) request_timeout: Duration,
    pub(crate) spool_dir: PathBuf,
    pub(crate) spool_max_bytes: usize,
}

impl TelemetryConfig {
    pub(crate) fn from_env(edge_internal_token: &str) -> Result<Self> {
        let queue_capacity =
            env_usize("REND_EDGE_TELEMETRY_QUEUE_CAPACITY", DEFAULT_QUEUE_CAPACITY)?;
        anyhow::ensure!(
            (1..=HARD_QUEUE_CAPACITY).contains(&queue_capacity),
            "REND_EDGE_TELEMETRY_QUEUE_CAPACITY must be between 1 and {HARD_QUEUE_CAPACITY}"
        );

        let batch_size = env_usize("REND_EDGE_TELEMETRY_BATCH_SIZE", DEFAULT_BATCH_SIZE)?;
        anyhow::ensure!(
            (1..=HARD_BATCH_SIZE).contains(&batch_size),
            "REND_EDGE_TELEMETRY_BATCH_SIZE must be between 1 and {HARD_BATCH_SIZE}"
        );

        let spool_max_bytes = env_usize(
            "REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES",
            DEFAULT_SPOOL_MAX_BYTES,
        )?;
        anyhow::ensure!(
            (1..=HARD_SPOOL_MAX_BYTES).contains(&spool_max_bytes),
            "REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES must be between 1 and {HARD_SPOOL_MAX_BYTES}"
        );

        let dedicated_token = env_string("REND_INTERNAL_TELEMETRY_TOKEN", "");
        let internal_token = if dedicated_token.trim().is_empty() {
            edge_internal_token.to_owned()
        } else {
            dedicated_token
        };

        Ok(Self {
            enabled: env_bool("REND_EDGE_TELEMETRY_ENABLED", true)?,
            ingest_url: optional_env_url(
                "REND_EDGE_TELEMETRY_INGEST_URL",
                "http://127.0.0.1:4000/internal/telemetry/playback",
            ),
            internal_token,
            queue_capacity,
            batch_size,
            flush_interval: env_duration_secs("REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS", 2)?,
            request_timeout: env_duration_secs("REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS", 2)?,
            spool_dir: env_path("REND_EDGE_TELEMETRY_SPOOL_DIR", ".rend/telemetry-spool"),
            spool_max_bytes,
        })
    }

    #[cfg(test)]
    pub(crate) fn disabled() -> Self {
        Self {
            enabled: false,
            ingest_url: None,
            internal_token: "test-internal-token".to_owned(),
            queue_capacity: DEFAULT_QUEUE_CAPACITY,
            batch_size: DEFAULT_BATCH_SIZE,
            flush_interval: Duration::from_secs(2),
            request_timeout: Duration::from_secs(2),
            spool_dir: std::env::temp_dir().join("rend-edge-telemetry-disabled"),
            spool_max_bytes: DEFAULT_SPOOL_MAX_BYTES,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct PlaybackTelemetryEvent {
    pub(crate) event_id: String,
    pub(crate) observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) organization_id: Option<String>,
    pub(crate) asset_id: String,
    pub(crate) artifact_path: String,
    pub(crate) edge_id: String,
    pub(crate) region: String,
    pub(crate) cache_status: String,
    pub(crate) status_code: u16,
    pub(crate) bytes_served: u64,
    pub(crate) content_type: String,
    pub(crate) duration_ms: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) resolution_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_code: Option<String>,
}

pub(crate) struct PlaybackTelemetryInput<'a> {
    pub(crate) organization_id: Option<&'a str>,
    pub(crate) asset_id: &'a str,
    pub(crate) artifact_path: &'a str,
    pub(crate) edge_id: &'a str,
    pub(crate) region: &'a str,
    pub(crate) cache_status: &'a str,
    pub(crate) status_code: u16,
    pub(crate) bytes_served: u64,
    pub(crate) content_type: &'a str,
    pub(crate) duration_ms: u32,
    pub(crate) resolution_tier: Option<&'a str>,
    pub(crate) error_code: Option<&'a str>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct TelemetryCounters {
    pub(crate) queued: u64,
    pub(crate) spooled: u64,
    pub(crate) sent: u64,
    pub(crate) dropped: u64,
    pub(crate) queue_depth: u64,
}

#[derive(Clone)]
pub(crate) struct TelemetryHandle {
    inner: Option<Arc<TelemetryInner>>,
}

struct TelemetryInner {
    config: TelemetryConfig,
    sender: mpsc::Sender<PlaybackTelemetryEvent>,
    spool: Arc<LocalSpool>,
    queued: AtomicU64,
    spooled: AtomicU64,
    sent: AtomicU64,
    dropped: AtomicU64,
    queue_depth: AtomicU64,
    sequence: AtomicU64,
}

struct LocalSpool {
    dir: PathBuf,
    max_bytes: usize,
    lock: Mutex<()>,
}

#[derive(Serialize, Deserialize)]
struct PlaybackTelemetryBatch {
    events: Vec<PlaybackTelemetryEvent>,
}

impl TelemetryHandle {
    pub(crate) fn start(config: TelemetryConfig, http: reqwest::Client) -> Self {
        if !config.enabled || config.ingest_url.is_none() {
            return Self::disabled();
        }

        let (sender, receiver) = mpsc::channel(config.queue_capacity);
        let inner = Arc::new(TelemetryInner {
            spool: Arc::new(LocalSpool::new(
                config.spool_dir.clone(),
                config.spool_max_bytes,
            )),
            config,
            sender,
            queued: AtomicU64::new(0),
            spooled: AtomicU64::new(0),
            sent: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            queue_depth: AtomicU64::new(0),
            sequence: AtomicU64::new(0),
        });

        tokio::spawn(run_worker(inner.clone(), http, receiver));
        Self { inner: Some(inner) }
    }

    pub(crate) fn disabled() -> Self {
        Self { inner: None }
    }

    pub(crate) fn record_playback(&self, input: PlaybackTelemetryInput<'_>) {
        let Some(inner) = &self.inner else {
            return;
        };
        let event = shape_playback_event(input, inner.next_event_id(), Utc::now());
        self.record_event(event);
    }

    fn record_event(&self, event: PlaybackTelemetryEvent) {
        let Some(inner) = &self.inner else {
            return;
        };

        match inner.sender.try_send(event) {
            Ok(()) => {
                inner.queued.fetch_add(1, Ordering::Relaxed);
                inner.queue_depth.fetch_add(1, Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Full(event))
            | Err(mpsc::error::TrySendError::Closed(event)) => {
                spill_event_async(inner.clone(), event);
            }
        }
    }

    pub(crate) fn counters(&self) -> TelemetryCounters {
        let Some(inner) = &self.inner else {
            return TelemetryCounters::default();
        };

        TelemetryCounters {
            queued: inner.queued.load(Ordering::Relaxed),
            spooled: inner.spooled.load(Ordering::Relaxed),
            sent: inner.sent.load(Ordering::Relaxed),
            dropped: inner.dropped.load(Ordering::Relaxed),
            queue_depth: inner.queue_depth.load(Ordering::Relaxed),
        }
    }

    pub(crate) async fn spool_bytes(&self) -> u64 {
        let Some(inner) = &self.inner else {
            return 0;
        };
        inner.spool.size_bytes().await.unwrap_or(0)
    }

    #[cfg(test)]
    fn for_test_without_worker(
        config: TelemetryConfig,
    ) -> (Self, mpsc::Receiver<PlaybackTelemetryEvent>) {
        let (sender, receiver) = mpsc::channel(config.queue_capacity);
        let inner = Arc::new(TelemetryInner {
            spool: Arc::new(LocalSpool::new(
                config.spool_dir.clone(),
                config.spool_max_bytes,
            )),
            config,
            sender,
            queued: AtomicU64::new(0),
            spooled: AtomicU64::new(0),
            sent: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            queue_depth: AtomicU64::new(0),
            sequence: AtomicU64::new(0),
        });

        (Self { inner: Some(inner) }, receiver)
    }
}

impl TelemetryInner {
    fn next_event_id(&self) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let edge_id = sanitize_event_id_part(&self.config_edge_id_hint());
        format!("evt-{edge_id}-{}-{sequence}", Utc::now().timestamp_millis())
    }

    fn config_edge_id_hint(&self) -> String {
        std::process::id().to_string()
    }
}

impl LocalSpool {
    fn new(dir: PathBuf, max_bytes: usize) -> Self {
        Self {
            dir,
            max_bytes,
            lock: Mutex::new(()),
        }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("playback-events.jsonl")
    }

    fn quarantine_path(&self) -> PathBuf {
        self.dir.join(QUARANTINE_FILE_NAME)
    }

    async fn append_event(&self, event: &PlaybackTelemetryEvent) -> Result<bool> {
        let mut line = serde_json::to_vec(event).context("failed to serialize telemetry event")?;
        line.push(b'\n');
        if line.len() > self.max_bytes {
            return Ok(false);
        }

        let _guard = self.lock.lock().await;
        fs::create_dir_all(&self.dir)
            .await
            .with_context(|| format!("failed to create telemetry spool {}", self.dir.display()))?;

        let path = self.path();
        let current_size = match fs::metadata(&path).await {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to inspect telemetry spool {}", path.display())
                });
            }
        };
        if current_size.saturating_add(u64::try_from(line.len()).unwrap_or(u64::MAX))
            > u64::try_from(self.max_bytes).unwrap_or(u64::MAX)
        {
            return Ok(false);
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .with_context(|| format!("failed to open telemetry spool {}", path.display()))?;
        file.write_all(&line)
            .await
            .with_context(|| format!("failed to write telemetry spool {}", path.display()))?;
        file.flush()
            .await
            .with_context(|| format!("failed to flush telemetry spool {}", path.display()))?;
        Ok(true)
    }

    async fn size_bytes(&self) -> Result<u64> {
        match fs::metadata(self.path()).await {
            Ok(metadata) => Ok(metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(error) => Err(error).context("failed to inspect telemetry spool size"),
        }
    }

    async fn append_quarantine_line_locked(&self, line: &str) -> Result<()> {
        fs::create_dir_all(&self.dir)
            .await
            .with_context(|| format!("failed to create telemetry spool {}", self.dir.display()))?;
        let path = self.quarantine_path();
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .with_context(|| format!("failed to open telemetry quarantine {}", path.display()))?;
        file.write_all(line.as_bytes())
            .await
            .with_context(|| format!("failed to write telemetry quarantine {}", path.display()))?;
        if !line.ends_with('\n') {
            file.write_all(b"\n").await.with_context(|| {
                format!("failed to write telemetry quarantine {}", path.display())
            })?;
        }
        file.flush()
            .await
            .with_context(|| format!("failed to flush telemetry quarantine {}", path.display()))?;
        Ok(())
    }

    async fn rewrite_records_locked(&self, records: &[SpoolRecord]) -> Result<()> {
        let path = self.path();
        if records.is_empty() {
            fs::remove_file(&path).await.ok();
            return Ok(());
        }

        fs::create_dir_all(&self.dir)
            .await
            .with_context(|| format!("failed to create telemetry spool {}", self.dir.display()))?;
        let temp_path = self.dir.join(format!(
            "playback-events.jsonl.rewrite.{}.{}.tmp",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .await
            .with_context(|| {
                format!(
                    "failed to open telemetry spool rewrite {}",
                    temp_path.display()
                )
            })?;
        for record in records {
            file.write_all(record.raw_line.as_bytes())
                .await
                .with_context(|| {
                    format!(
                        "failed to write telemetry spool rewrite {}",
                        temp_path.display()
                    )
                })?;
            if !record.raw_line.ends_with('\n') {
                file.write_all(b"\n").await.with_context(|| {
                    format!(
                        "failed to write telemetry spool rewrite {}",
                        temp_path.display()
                    )
                })?;
            }
        }
        file.flush().await.with_context(|| {
            format!(
                "failed to flush telemetry spool rewrite {}",
                temp_path.display()
            )
        })?;
        fs::rename(&temp_path, &path).await.with_context(|| {
            format!(
                "failed to replace telemetry spool {} with {}",
                path.display(),
                temp_path.display()
            )
        })?;
        Ok(())
    }
}

#[derive(Clone)]
struct SpoolRecord {
    raw_line: String,
    event: PlaybackTelemetryEvent,
}

#[derive(Debug)]
struct TelemetrySendError {
    status: Option<reqwest::StatusCode>,
    message: String,
}

impl TelemetrySendError {
    fn request(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
        }
    }

    fn http(status: reqwest::StatusCode, body: String) -> Self {
        let body = truncate_for_log(body.trim());
        let suffix = if body.is_empty() {
            String::new()
        } else {
            format!(": {body}")
        };
        Self {
            status: Some(status),
            message: format!("telemetry ingest returned HTTP {status}{suffix}"),
        }
    }

    fn is_permanent_replay_rejection(&self) -> bool {
        matches!(
            self.status,
            Some(reqwest::StatusCode::BAD_REQUEST)
                | Some(reqwest::StatusCode::PAYLOAD_TOO_LARGE)
                | Some(reqwest::StatusCode::UNPROCESSABLE_ENTITY)
        )
    }
}

impl fmt::Display for TelemetrySendError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TelemetrySendError {}

struct ReplaySplitResult {
    retry_records: Vec<SpoolRecord>,
    retry_error: Option<TelemetrySendError>,
}

pub(crate) fn shape_playback_event(
    input: PlaybackTelemetryInput<'_>,
    event_id: String,
    observed_at: DateTime<Utc>,
) -> PlaybackTelemetryEvent {
    PlaybackTelemetryEvent {
        event_id,
        observed_at: observed_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        organization_id: input.organization_id.map(str::to_owned),
        asset_id: input.asset_id.to_owned(),
        artifact_path: input.artifact_path.to_owned(),
        edge_id: input.edge_id.to_owned(),
        region: input.region.to_owned(),
        cache_status: input.cache_status.to_owned(),
        status_code: input.status_code,
        bytes_served: input.bytes_served,
        content_type: input.content_type.to_owned(),
        duration_ms: input.duration_ms,
        resolution_tier: input.resolution_tier.map(str::to_owned),
        error_code: input.error_code.map(str::to_owned),
    }
}

async fn run_worker(
    inner: Arc<TelemetryInner>,
    http: reqwest::Client,
    mut receiver: mpsc::Receiver<PlaybackTelemetryEvent>,
) {
    let mut pending = Vec::with_capacity(inner.config.batch_size);
    let mut interval = tokio::time::interval(inner.config.flush_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            received = receiver.recv() => {
                let Some(event) = received else {
                    flush_pending_or_spool(&inner, &http, &mut pending).await;
                    let _ = flush_spool_once(&inner.spool, &http, &inner.config, &inner.sent).await;
                    return;
                };
                pending.push(event);
                if pending.len() >= inner.config.batch_size {
                    flush_pending_or_spool(&inner, &http, &mut pending).await;
                }
            }
            _ = interval.tick() => {
                flush_pending_or_spool(&inner, &http, &mut pending).await;
                if let Err(error) = flush_spool_once(&inner.spool, &http, &inner.config, &inner.sent).await {
                    tracing::warn!(error = %error, "failed to replay playback telemetry spool");
                }
            }
        }
    }
}

async fn flush_pending_or_spool(
    inner: &Arc<TelemetryInner>,
    http: &reqwest::Client,
    pending: &mut Vec<PlaybackTelemetryEvent>,
) {
    if pending.is_empty() {
        return;
    }

    let events = std::mem::take(pending);
    match send_batch(http, &inner.config, &events).await {
        Ok(()) => {
            let count = u64::try_from(events.len()).unwrap_or(0);
            inner.sent.fetch_add(count, Ordering::Relaxed);
            inner.queue_depth.fetch_sub(count, Ordering::Relaxed);
        }
        Err(error) => {
            tracing::warn!(
                error = %error,
                count = events.len(),
                "failed to send playback telemetry batch; spooling locally",
            );
            append_batch_to_spool(inner, &events).await;
        }
    }
}

async fn append_batch_to_spool(inner: &Arc<TelemetryInner>, events: &[PlaybackTelemetryEvent]) {
    for event in events {
        match inner.spool.append_event(event).await {
            Ok(true) => {
                inner.spooled.fetch_add(1, Ordering::Relaxed);
                inner.queue_depth.fetch_sub(1, Ordering::Relaxed);
            }
            Ok(false) => {
                inner.dropped.fetch_add(1, Ordering::Relaxed);
                inner.queue_depth.fetch_sub(1, Ordering::Relaxed);
                tracing::warn!("playback telemetry spool is full; dropping event");
            }
            Err(error) => {
                inner.dropped.fetch_add(1, Ordering::Relaxed);
                inner.queue_depth.fetch_sub(1, Ordering::Relaxed);
                tracing::warn!(error = %error, "playback telemetry spool unavailable; dropping event");
            }
        }
    }
}

fn spill_event_async(inner: Arc<TelemetryInner>, event: PlaybackTelemetryEvent) {
    tokio::spawn(async move {
        match inner.spool.append_event(&event).await {
            Ok(true) => {
                inner.spooled.fetch_add(1, Ordering::Relaxed);
            }
            Ok(false) => {
                inner.dropped.fetch_add(1, Ordering::Relaxed);
                tracing::warn!("playback telemetry queue and spool are full; dropping event");
            }
            Err(error) => {
                inner.dropped.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(error = %error, "playback telemetry spool unavailable; dropping event");
            }
        }
    });
}

async fn flush_spool_once(
    spool: &LocalSpool,
    http: &reqwest::Client,
    config: &TelemetryConfig,
    sent: &AtomicU64,
) -> Result<()> {
    let _guard = spool.lock.lock().await;
    let path = spool.path();
    let data = match fs::read_to_string(&path).await {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read telemetry spool {}", path.display()));
        }
    };

    let mut records = Vec::new();
    for line in data.lines() {
        match serde_json::from_str::<PlaybackTelemetryEvent>(line) {
            Ok(event) => records.push(SpoolRecord {
                raw_line: line.to_owned(),
                event,
            }),
            Err(error) => {
                tracing::warn!(error = %error, "quarantining malformed playback telemetry spool line");
                spool.append_quarantine_line_locked(line).await?;
            }
        }
    }

    let mut remaining = Vec::new();
    let mut replay_error = None;
    let mut index = 0;
    while index < records.len() {
        let end = records.len().min(index + config.batch_size);
        let chunk = &records[index..end];
        let events = chunk
            .iter()
            .map(|record| record.event.clone())
            .collect::<Vec<_>>();
        match send_batch(http, config, &events).await {
            Ok(()) => {
                sent.fetch_add(u64::try_from(events.len()).unwrap_or(0), Ordering::Relaxed);
            }
            Err(error) if error.is_permanent_replay_rejection() => {
                tracing::warn!(
                    error = %error,
                    count = chunk.len(),
                    "telemetry spool replay batch was rejected; splitting records",
                );
                let split = replay_records_individually(spool, http, config, sent, chunk).await?;
                if !split.retry_records.is_empty() {
                    remaining.extend(split.retry_records);
                }
                if split.retry_error.is_some() {
                    remaining.extend(records[end..].iter().cloned());
                    replay_error = split.retry_error;
                    break;
                }
            }
            Err(error) => {
                remaining.extend(records[index..].iter().cloned());
                replay_error = Some(error);
                break;
            }
        }
        index = end;
    }

    spool.rewrite_records_locked(&remaining).await?;
    if let Some(error) = replay_error {
        Err(error.into())
    } else {
        Ok(())
    }
}

async fn replay_records_individually(
    spool: &LocalSpool,
    http: &reqwest::Client,
    config: &TelemetryConfig,
    sent: &AtomicU64,
    records: &[SpoolRecord],
) -> Result<ReplaySplitResult> {
    let mut retry_records = Vec::new();
    let mut retry_error = None;

    for record in records {
        match send_batch(http, config, std::slice::from_ref(&record.event)).await {
            Ok(()) => {
                sent.fetch_add(1, Ordering::Relaxed);
            }
            Err(error) if error.is_permanent_replay_rejection() => {
                if let Err(quarantine_error) =
                    spool.append_quarantine_line_locked(&record.raw_line).await
                {
                    retry_records.push(record.clone());
                    retry_error = Some(TelemetrySendError::request(format!(
                        "failed to quarantine rejected telemetry spool record: {quarantine_error}"
                    )));
                } else {
                    tracing::warn!(
                        error = %error,
                        event_id = %record.event.event_id,
                        "quarantined rejected playback telemetry spool record",
                    );
                }
            }
            Err(error) => {
                retry_records.push(record.clone());
                retry_error.get_or_insert(error);
            }
        }
    }

    Ok(ReplaySplitResult {
        retry_records,
        retry_error,
    })
}

async fn send_batch(
    http: &reqwest::Client,
    config: &TelemetryConfig,
    events: &[PlaybackTelemetryEvent],
) -> std::result::Result<(), TelemetrySendError> {
    let url = config
        .ingest_url
        .as_ref()
        .ok_or_else(|| TelemetrySendError::request("telemetry ingest URL is not configured"))?;
    let response = http
        .post(url)
        .timeout(config.request_timeout)
        .header("x-rend-internal-token", &config.internal_token)
        .json(&PlaybackTelemetryBatch {
            events: events.to_vec(),
        })
        .send()
        .await
        .map_err(|error| {
            TelemetrySendError::request(format!("telemetry ingest request failed: {error}"))
        })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(TelemetrySendError::http(status, body));
    }

    Ok(())
}

fn truncate_for_log(value: &str) -> String {
    const LIMIT: usize = 512;
    if value.len() <= LIMIT {
        value.to_owned()
    } else {
        format!("{}...", &value[..LIMIT])
    }
}

fn optional_env_url(key: &str, default: &str) -> Option<String> {
    let value = env_string(key, default);
    let value = value.trim().trim_end_matches('/').to_owned();
    (!value.is_empty()).then_some(value)
}

fn sanitize_event_id_part(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') {
                char::from(byte)
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
    use std::sync::Mutex as StdMutex;
    use tokio::net::TcpListener;

    #[derive(Clone)]
    struct Recorder {
        events: Arc<StdMutex<Vec<PlaybackTelemetryEvent>>>,
    }

    async fn record_batch(
        State(recorder): State<Recorder>,
        Json(batch): Json<PlaybackTelemetryBatch>,
    ) -> StatusCode {
        recorder.events.lock().unwrap().extend(batch.events);
        StatusCode::ACCEPTED
    }

    async fn reject_invalid_asset_batch(
        State(recorder): State<Recorder>,
        Json(batch): Json<PlaybackTelemetryBatch>,
    ) -> StatusCode {
        if batch
            .events
            .iter()
            .any(|event| event.asset_id == "not-a-uuid")
        {
            return StatusCode::BAD_REQUEST;
        }
        recorder.events.lock().unwrap().extend(batch.events);
        StatusCode::ACCEPTED
    }

    async fn spawn_recorder() -> (String, Recorder) {
        spawn_recorder_with_handler(record_batch).await
    }

    async fn spawn_validating_recorder() -> (String, Recorder) {
        spawn_recorder_with_handler(reject_invalid_asset_batch).await
    }

    async fn spawn_recorder_with_handler<H, T>(handler: H) -> (String, Recorder)
    where
        H: axum::handler::Handler<T, Recorder> + Clone + Send + Sync + 'static,
        T: 'static,
    {
        let recorder = Recorder {
            events: Arc::new(StdMutex::new(Vec::new())),
        };
        let app = Router::new()
            .route("/internal/telemetry/playback", post(handler))
            .with_state(recorder.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            format!("http://{addr}/internal/telemetry/playback"),
            recorder,
        )
    }

    fn config(spool_dir: PathBuf) -> TelemetryConfig {
        TelemetryConfig {
            enabled: true,
            ingest_url: Some("http://127.0.0.1:1/internal/telemetry/playback".to_owned()),
            internal_token: "internal".to_owned(),
            queue_capacity: 1,
            batch_size: 10,
            flush_interval: Duration::from_secs(60),
            request_timeout: Duration::from_millis(100),
            spool_dir,
            spool_max_bytes: 1024 * 1024,
        }
    }

    fn sample_input<'a>() -> PlaybackTelemetryInput<'a> {
        PlaybackTelemetryInput {
            organization_id: Some("00000000-0000-0000-0000-000000000009"),
            asset_id: "00000000-0000-0000-0000-000000000001",
            artifact_path: "hls/master.m3u8",
            edge_id: "edge-1",
            region: "local",
            cache_status: "MISS",
            status_code: 200,
            bytes_served: 123,
            content_type: "application/vnd.apple.mpegurl",
            duration_ms: 12,
            resolution_tier: None,
            error_code: None,
        }
    }

    fn sample_event(event_id: &str) -> PlaybackTelemetryEvent {
        shape_playback_event(
            sample_input(),
            event_id.to_owned(),
            DateTime::parse_from_rfc3339("2026-06-13T12:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
        )
    }

    fn invalid_semantic_event(event_id: &str) -> PlaybackTelemetryEvent {
        let mut event = sample_event(event_id);
        event.asset_id = "not-a-uuid".to_owned();
        event
    }

    #[test]
    fn playback_event_shape_excludes_url_tokens_and_headers() {
        let event = sample_event("evt-1");
        let json = serde_json::to_string(&event).unwrap().to_ascii_lowercase();

        for forbidden in [
            "?token=",
            "authorization",
            "cookie",
            "x-rend-internal-token",
            "full_url",
            "client_ip",
        ] {
            assert!(!json.contains(forbidden), "{forbidden}");
        }
        assert!(json.contains("hls/master.m3u8"));
        assert!(json.contains("miss"));
    }

    #[test]
    fn playback_event_shape_carries_safe_analytics_claims() {
        let mut input = sample_input();
        input.resolution_tier = Some("720p");
        let event = shape_playback_event(
            input,
            "evt-claims".to_owned(),
            DateTime::parse_from_rfc3339("2026-06-13T12:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
        );

        assert_eq!(
            event.organization_id.as_deref(),
            Some("00000000-0000-0000-0000-000000000009")
        );
        assert_eq!(event.resolution_tier.as_deref(), Some("720p"));
    }

    #[tokio::test]
    async fn queue_full_spills_to_spool_without_blocking_caller() {
        let spool_dir = std::env::temp_dir().join(format!(
            "rend-edge-telemetry-full-{}",
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let (handle, _receiver) =
            TelemetryHandle::for_test_without_worker(config(spool_dir.clone()));

        handle.record_event(sample_event("evt-queued"));
        handle.record_event(sample_event("evt-spooled"));

        for _ in 0..50 {
            if handle.counters().spooled == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(handle.counters().queued, 1);
        assert_eq!(handle.counters().spooled, 1);
        let data = fs::read_to_string(spool_dir.join("playback-events.jsonl"))
            .await
            .unwrap();
        assert!(data.contains("evt-spooled"));
        assert!(!data.contains("evt-queued"));
    }

    #[tokio::test]
    async fn spool_unavailable_counts_dropped_telemetry() {
        let spool_path = std::env::temp_dir().join(format!(
            "rend-edge-telemetry-unavailable-{}",
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::write(&spool_path, b"not a directory").await.unwrap();
        let (handle, _receiver) = TelemetryHandle::for_test_without_worker(config(spool_path));

        handle.record_event(sample_event("evt-queued"));
        handle.record_event(sample_event("evt-dropped"));

        for _ in 0..50 {
            if handle.counters().dropped == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(handle.counters().queued, 1);
        assert_eq!(handle.counters().dropped, 1);
    }

    #[tokio::test]
    async fn spool_replay_preserves_event_id() {
        let (url, recorder) = spawn_recorder().await;
        let spool_dir = std::env::temp_dir().join(format!(
            "rend-edge-telemetry-replay-{}",
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let mut config = config(spool_dir.clone());
        config.ingest_url = Some(url);
        let spool = LocalSpool::new(spool_dir.clone(), config.spool_max_bytes);
        spool
            .append_event(&sample_event("evt-preserved"))
            .await
            .unwrap();
        let sent = AtomicU64::new(0);

        flush_spool_once(&spool, &reqwest::Client::new(), &config, &sent)
            .await
            .unwrap();

        assert_eq!(sent.load(Ordering::Relaxed), 1);
        assert!(!spool_dir.join("playback-events.jsonl").exists());
        let events = recorder.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_id, "evt-preserved");
    }

    #[tokio::test]
    async fn spool_replay_quarantines_valid_json_rejected_by_ingest() {
        let (url, recorder) = spawn_validating_recorder().await;
        let spool_dir = std::env::temp_dir().join(format!(
            "rend-edge-telemetry-quarantine-{}",
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let mut config = config(spool_dir.clone());
        config.ingest_url = Some(url);
        let spool = LocalSpool::new(spool_dir.clone(), config.spool_max_bytes);
        spool
            .append_event(&sample_event("evt-valid"))
            .await
            .unwrap();
        spool
            .append_event(&invalid_semantic_event("evt-invalid"))
            .await
            .unwrap();
        let sent = AtomicU64::new(0);

        flush_spool_once(&spool, &reqwest::Client::new(), &config, &sent)
            .await
            .unwrap();

        assert_eq!(sent.load(Ordering::Relaxed), 1);
        assert!(!spool.path().exists());
        let events = recorder.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_id, "evt-valid");

        let quarantine = fs::read_to_string(spool.quarantine_path()).await.unwrap();
        assert!(quarantine.contains("evt-invalid"));
        assert!(!quarantine.contains("evt-valid"));
    }
}
