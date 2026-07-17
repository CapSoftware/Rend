CREATE DATABASE IF NOT EXISTS rend;

CREATE TABLE IF NOT EXISTS rend.cloudfront_requests
(
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    request_id String,
    edge_location LowCardinality(String),
    bytes_served UInt64,
    method LowCardinality(String),
    host LowCardinality(String),
    request_path String,
    status_code UInt16,
    cache_status LowCardinality(String),
    protocol LowCardinality(String),
    duration_ms UInt32,
    detailed_result LowCardinality(String),
    content_type LowCardinality(String),
    content_length UInt64
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(observed_at)
ORDER BY (request_id, observed_at)
TTL toDateTime(observed_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Standard logs are ingested without client IP, forwarded-for, referrer,
-- user-agent, query-string, or cookie columns. Reconciliation queries should
-- use FINAL (or group by request_id) so replayed log objects remain harmless.
