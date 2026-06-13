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
    error_code Nullable(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(observed_at)
ORDER BY (asset_id, observed_at, event_id)
TTL toDateTime(observed_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- ClickHouse does not enforce uniqueness. Playback analytics queries must
-- group by event_id before aggregating so retries and spool replay are
-- harmless for request/byte/cache/status counts.
