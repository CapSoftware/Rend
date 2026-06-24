CREATE TABLE IF NOT EXISTS rend.player_events
(
    event_id String,
    observed_at DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    organization_id UUID,
    asset_id UUID,
    playback_session_id String,
    viewer_id_hash String DEFAULT '',
    page_type LowCardinality(String) DEFAULT '',
    page_host String DEFAULT '',
    referrer_host String DEFAULT '',
    player_name LowCardinality(String) DEFAULT '',
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
    app_version LowCardinality(String) DEFAULT '',
    browser_name LowCardinality(String) DEFAULT '',
    browser_version LowCardinality(String) DEFAULT '',
    os_name LowCardinality(String) DEFAULT '',
    os_version LowCardinality(String) DEFAULT '',
    device_type LowCardinality(String) DEFAULT '',
    autoplay UInt8 DEFAULT 0,
    muted UInt8 DEFAULT 0,
    preload LowCardinality(String) DEFAULT '',
    startup_mode LowCardinality(String) DEFAULT '',
    geo_country LowCardinality(String) DEFAULT '',
    geo_region LowCardinality(String) DEFAULT '',
    geo_city String DEFAULT '',
    geo_continent LowCardinality(String) DEFAULT '',
    geo_asn LowCardinality(String) DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(observed_at)
ORDER BY (organization_id, toDate(observed_at), asset_id, playback_session_id, event_id)
TTL toDateTime(observed_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS viewer_id_hash String DEFAULT ''
    AFTER playback_session_id;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS page_type LowCardinality(String) DEFAULT ''
    AFTER viewer_id_hash;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS page_host String DEFAULT ''
    AFTER page_type;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS referrer_host String DEFAULT ''
    AFTER page_host;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS player_name LowCardinality(String) DEFAULT ''
    AFTER referrer_host;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS browser_name LowCardinality(String) DEFAULT ''
    AFTER app_version;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS browser_version LowCardinality(String) DEFAULT ''
    AFTER browser_name;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS os_name LowCardinality(String) DEFAULT ''
    AFTER browser_version;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS os_version LowCardinality(String) DEFAULT ''
    AFTER os_name;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS device_type LowCardinality(String) DEFAULT ''
    AFTER os_version;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS autoplay UInt8 DEFAULT 0
    AFTER device_type;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS muted UInt8 DEFAULT 0
    AFTER autoplay;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS preload LowCardinality(String) DEFAULT ''
    AFTER muted;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS startup_mode LowCardinality(String) DEFAULT ''
    AFTER preload;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS geo_country LowCardinality(String) DEFAULT ''
    AFTER startup_mode;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS geo_region LowCardinality(String) DEFAULT ''
    AFTER geo_country;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS geo_city String DEFAULT ''
    AFTER geo_region;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS geo_continent LowCardinality(String) DEFAULT ''
    AFTER geo_city;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS geo_asn LowCardinality(String) DEFAULT ''
    AFTER geo_continent;

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
    unique_viewers UInt64 DEFAULT 0,
    startup_failures UInt64,
    exits_before_start UInt64 DEFAULT 0,
    watch_time_ms UInt64,
    stalled_sessions UInt64,
    stall_count UInt64,
    stall_duration_ms UInt64,
    playback_failures UInt64,
    completions UInt64 DEFAULT 0,
    first_frame_p50_ms Float64,
    first_frame_p95_ms Float64,
    updated_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, bucket_start, asset_id)
TTL toDateTime(bucket_start) + INTERVAL 395 DAY
SETTINGS index_granularity = 8192;

ALTER TABLE rend.analytics_player_hourly
    ADD COLUMN IF NOT EXISTS unique_viewers UInt64 DEFAULT 0
    AFTER views;

ALTER TABLE rend.analytics_player_hourly
    ADD COLUMN IF NOT EXISTS exits_before_start UInt64 DEFAULT 0
    AFTER startup_failures;

ALTER TABLE rend.analytics_player_hourly
    ADD COLUMN IF NOT EXISTS completions UInt64 DEFAULT 0
    AFTER playback_failures;
