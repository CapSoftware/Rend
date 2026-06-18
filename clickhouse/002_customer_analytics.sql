CREATE TABLE IF NOT EXISTS rend.player_events
(
    event_id String,
    observed_at DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    organization_id UUID,
    asset_id UUID,
    playback_session_id String,
    phase LowCardinality(String),
    selected_playback_mode LowCardinality(String) DEFAULT '',
    selected_artifact_path String DEFAULT '',
    first_frame_ms UInt32 DEFAULT 0,
    bootstrap_duration_ms UInt32 DEFAULT 0,
    bootstrap_http_status UInt16 DEFAULT 0,
    stall_duration_ms UInt32 DEFAULT 0,
    watch_delta_ms UInt32 DEFAULT 0,
    playback_failure_code LowCardinality(String) DEFAULT '',
    edge_label LowCardinality(String) DEFAULT '',
    region_label LowCardinality(String) DEFAULT '',
    player_version LowCardinality(String) DEFAULT '',
    app_version LowCardinality(String) DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(observed_at)
ORDER BY (organization_id, toDate(observed_at), asset_id, playback_session_id, event_id)
TTL toDateTime(observed_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS rend.analytics_edge_hourly
(
    organization_id UUID,
    bucket_start DateTime64(3, 'UTC'),
    asset_id UUID,
    request_count UInt64,
    bytes_served UInt64,
    cache_hit_count UInt64,
    error_count UInt64,
    request_duration_p50_ms Float64,
    request_duration_p95_ms Float64,
    updated_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, bucket_start, asset_id)
TTL toDateTime(bucket_start) + INTERVAL 395 DAY
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS rend.analytics_player_hourly
(
    organization_id UUID,
    bucket_start DateTime64(3, 'UTC'),
    asset_id UUID,
    sessions UInt64,
    views UInt64,
    startup_failures UInt64,
    watch_time_ms UInt64,
    stalled_sessions UInt64,
    stall_count UInt64,
    stall_duration_ms UInt64,
    playback_failures UInt64,
    first_frame_p50_ms Float64,
    first_frame_p95_ms Float64,
    updated_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, bucket_start, asset_id)
TTL toDateTime(bucket_start) + INTERVAL 395 DAY
SETTINGS index_granularity = 8192;
