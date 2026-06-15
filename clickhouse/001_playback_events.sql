CREATE DATABASE IF NOT EXISTS rend;

CREATE TABLE IF NOT EXISTS rend.playback_events
(
    event_id String,
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    asset_id UUID,
    organization_id Nullable(UUID),
    artifact_path LowCardinality(String),
    edge_id LowCardinality(String),
    region LowCardinality(String),
    cache_status LowCardinality(String),
    status_code UInt16,
    bytes_served UInt64,
    content_type LowCardinality(String),
    duration_ms UInt32,
    delivered_duration_ms UInt32 DEFAULT 0,
    resolution_tier LowCardinality(Nullable(String)),
    error_code Nullable(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(observed_at)
ORDER BY (asset_id, observed_at, event_id)
TTL toDateTime(observed_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

ALTER TABLE rend.playback_events
    ADD COLUMN IF NOT EXISTS delivered_duration_ms UInt32 DEFAULT 0
    AFTER duration_ms;

ALTER TABLE rend.playback_events
    ADD COLUMN IF NOT EXISTS resolution_tier LowCardinality(Nullable(String))
    AFTER delivered_duration_ms;

-- ClickHouse does not enforce uniqueness. Playback analytics queries must
-- group by event_id before aggregating so retries and spool replay are
-- harmless for request/byte/cache/status counts.
