#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

failures=0

fail() {
  echo "error: $*" >&2
  failures=1
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || fail "missing file: $file"
}

require_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$file"; then
    fail "$file is missing required text: $needle"
  fi
}

require_env_vars() {
  local file="$1"
  shift

  require_file "$file"
  for var in "$@"; do
    if ! grep -Eq "^[[:space:]]*${var}=" "$file"; then
      fail "$file is missing env var: $var"
    fi
  done
}

require_compose_service() {
  local file="$1"
  local service="$2"
  require_contains "$file" "  $service:"
}

api_vars=(
  DATABASE_URL
  REND_REDIS_URL
  CLICKHOUSE_URL
  CLICKHOUSE_DATABASE
  CLICKHOUSE_USER
  CLICKHOUSE_PASSWORD
  OBJECT_STORE_HEALTH_URL
  S3_ENDPOINT
  S3_REGION
  S3_BUCKET
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  REND_API_BIND_ADDR
  REND_API_AUTO_MIGRATE
  REND_API_INLINE_MEDIA_PROCESSING
  REND_DEV_API_KEY
  REND_PLAYBACK_BASE_URL
  REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS
  REND_EDGE_WARM_URL
  REND_EDGE_PURGE_URL
  REND_EDGE_INTERNAL_TOKEN
  REND_INTERNAL_TELEMETRY_TOKEN
  REND_PLAYBACK_SIGNING_KEY_ID
  REND_PLAYBACK_SIGNING_SECRET
  REND_PLAYBACK_TOKEN_TTL_SECS
  REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS
  REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES
  REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH
  REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS
  REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS
  REND_EDGE_WARM_MAX_ARTIFACTS
  REND_HTTP_TIMEOUT_SECS
  REND_FFMPEG_PATH
  REND_FFPROBE_PATH
  REND_MEDIA_PROCESS_TIMEOUT_SECS
  REND_MEDIA_JOB_MAX_ATTEMPTS
  REND_MEDIA_WORKER_POLL_INTERVAL_SECS
  REND_MEDIA_JOB_LOCK_TIMEOUT_SECS
)

worker_vars=(
  DATABASE_URL
  REND_REDIS_URL
  CLICKHOUSE_URL
  CLICKHOUSE_DATABASE
  CLICKHOUSE_USER
  CLICKHOUSE_PASSWORD
  OBJECT_STORE_HEALTH_URL
  S3_ENDPOINT
  S3_REGION
  S3_BUCKET
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  REND_API_AUTO_MIGRATE
  REND_API_INLINE_MEDIA_PROCESSING
  REND_DEV_API_KEY
  REND_PLAYBACK_BASE_URL
  REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS
  REND_EDGE_WARM_URL
  REND_EDGE_PURGE_URL
  REND_EDGE_INTERNAL_TOKEN
  REND_INTERNAL_TELEMETRY_TOKEN
  REND_PLAYBACK_SIGNING_KEY_ID
  REND_PLAYBACK_SIGNING_SECRET
  REND_PLAYBACK_TOKEN_TTL_SECS
  REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS
  REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES
  REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH
  REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS
  REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS
  REND_EDGE_WARM_MAX_ARTIFACTS
  REND_HTTP_TIMEOUT_SECS
  REND_FFMPEG_PATH
  REND_FFPROBE_PATH
  REND_MEDIA_PROCESS_TIMEOUT_SECS
  REND_MEDIA_JOB_MAX_ATTEMPTS
  REND_MEDIA_WORKER_ID
  REND_MEDIA_WORKER_POLL_INTERVAL_SECS
  REND_MEDIA_JOB_LOCK_TIMEOUT_SECS
)

edge_vars=(
  S3_ENDPOINT
  S3_REGION
  S3_BUCKET
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  REND_EDGE_BIND_ADDR
  REND_EDGE_ID
  REND_EDGE_REGION
  REND_EDGE_BASE_URL
  REND_CONTROL_PLANE_URL
  REND_EDGE_HEARTBEAT_INTERVAL_SECS
  REND_EDGE_CACHE_MAX_BYTES
  REND_EDGE_CACHE_DIR
  REND_EDGE_ORIGIN_HEALTH_URL
  REND_EDGE_INTERNAL_TOKEN
  REND_EDGE_WARM_MAX_ARTIFACTS
  REND_EDGE_MAX_IN_FLIGHT_FILLS
  REND_EDGE_TELEMETRY_ENABLED
  REND_EDGE_TELEMETRY_INGEST_URL
  REND_INTERNAL_TELEMETRY_TOKEN
  REND_EDGE_TELEMETRY_QUEUE_CAPACITY
  REND_EDGE_TELEMETRY_BATCH_SIZE
  REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS
  REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS
  REND_EDGE_TELEMETRY_SPOOL_DIR
  REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES
  REND_PLAYBACK_SIGNING_KEY_ID
  REND_PLAYBACK_SIGNING_SECRET
  REND_HTTP_TIMEOUT_SECS
)

require_file compose.yml
require_file .env.docker.example
require_file docs/deployment-v1.md
require_file docs/edge-host-runbook-v1.md
require_file docs/templates/control-plane.compose.yml
require_file docs/templates/edge-host.compose.yml

require_compose_service compose.yml rend-api
require_compose_service compose.yml rend-media-worker
require_compose_service compose.yml rend-edge
require_compose_service compose.yml rend-edge-us-east
require_compose_service compose.yml rend-edge-london

require_contains compose.yml "REND_EDGE_CACHE_DIR: /var/lib/rend/edge-cache"
require_contains compose.yml "REND_EDGE_TELEMETRY_SPOOL_DIR: /var/spool/rend/edge-telemetry"
require_contains compose.yml "http://127.0.0.1:4100/readyz"
require_contains compose.yml "http://127.0.0.1:4000/readyz"
require_contains compose.yml "4101:4100"
require_contains compose.yml "4102:4100"

require_env_vars .env.docker.example "${api_vars[@]}" "${worker_vars[@]}" "${edge_vars[@]}"
require_env_vars docs/env/rend-api.env.example "${api_vars[@]}"
require_env_vars docs/env/rend-media-worker.env.example "${worker_vars[@]}"
require_env_vars docs/env/rend-edge-us-east.env.example "${edge_vars[@]}"
require_env_vars docs/env/rend-edge-london.env.example "${edge_vars[@]}"

require_contains docs/env/rend-edge-us-east.env.example "REND_EDGE_REGION=us-east"
require_contains docs/env/rend-edge-london.env.example "REND_EDGE_REGION=london"
require_contains docs/env/rend-edge-us-east.env.example "REND_EDGE_CACHE_DIR=/var/lib/rend/edge-cache"
require_contains docs/env/rend-edge-london.env.example "REND_EDGE_TELEMETRY_SPOOL_DIR=/var/spool/rend/edge-telemetry"

require_compose_service docs/templates/control-plane.compose.yml rend-api
require_compose_service docs/templates/control-plane.compose.yml rend-media-worker
require_contains docs/templates/control-plane.compose.yml '${REND_API_IMAGE:?set REND_API_IMAGE}'
require_contains docs/templates/control-plane.compose.yml '${REND_MEDIA_WORKER_IMAGE:?set REND_MEDIA_WORKER_IMAGE}'
require_contains docs/templates/control-plane.compose.yml "/etc/rend/rend-api.env"
require_contains docs/templates/control-plane.compose.yml "/etc/rend/rend-media-worker.env"
require_contains docs/templates/control-plane.compose.yml "http://127.0.0.1:4000/readyz"

require_compose_service docs/templates/edge-host.compose.yml rend-edge
require_contains docs/templates/edge-host.compose.yml '${REND_EDGE_IMAGE:?set REND_EDGE_IMAGE}'
require_contains docs/templates/edge-host.compose.yml "/etc/rend/rend-edge.env"
require_contains docs/templates/edge-host.compose.yml "/var/lib/rend/edge-cache"
require_contains docs/templates/edge-host.compose.yml "/var/spool/rend/edge-telemetry"
require_contains docs/templates/edge-host.compose.yml "http://127.0.0.1:4100/readyz"

require_contains docs/edge-host-runbook-v1.md "public playback"
require_contains docs/edge-host-runbook-v1.md "private/internal"
require_contains docs/edge-host-runbook-v1.md "metrics"
require_contains docs/edge-host-runbook-v1.md "/var/lib/rend/edge-cache"
require_contains docs/edge-host-runbook-v1.md "/var/spool/rend/edge-telemetry"
require_contains docs/edge-host-runbook-v1.md "x-rend-internal-token"
require_contains docs/edge-host-runbook-v1.md "rollback"
require_contains docs/deployment-v1.md "docs/edge-host-runbook-v1.md"

if [[ "$failures" != "0" ]]; then
  exit 1
fi

echo "Edge deployment docs/templates validation passed"
