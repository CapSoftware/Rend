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
  if ! grep -Fq -- "$needle" "$file"; then
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
  REND_ENV
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
  REND_PLAYBACK_BASE_URL
  REND_PLAYBACK_COOKIE_DOMAIN
  REND_MAX_UPLOAD_BYTES
  REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS
  REND_EXPECTED_EDGES
  REND_ALLOW_INSECURE_EDGE_URLS
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
  REND_ENV
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
  REND_PLAYBACK_BASE_URL
  REND_PLAYBACK_COOKIE_DOMAIN
  REND_MAX_UPLOAD_BYTES
  REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS
  REND_EXPECTED_EDGES
  REND_ALLOW_INSECURE_EDGE_URLS
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
  REND_ENV
  S3_ENDPOINT
  S3_REGION
  S3_BUCKET
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  REND_EDGE_BIND_ADDR
  REND_EDGE_ID
  REND_EDGE_REGION
  REND_EDGE_BASE_URL
  REND_EXPECTED_EDGES
  REND_ALLOW_INSECURE_EDGE_URLS
  REND_CONTROL_PLANE_URL
  REND_EDGE_HEARTBEAT_INTERVAL_SECS
  REND_EDGE_CACHE_MAX_BYTES
  REND_EDGE_CACHE_MIN_FREE_BYTES
  REND_EDGE_CACHE_DIR
  REND_EDGE_ORIGIN_HEALTH_URL
  REND_EDGE_INTERNAL_TOKEN
  REND_EDGE_WARM_MAX_ARTIFACTS
  REND_EDGE_MAX_IN_FLIGHT_FILLS
  REND_EDGE_MAX_ORIGIN_ARTIFACT_BYTES
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
require_file docs/release-images-v1.md
require_file docs/releases/README.md
require_file docs/templates/control-plane.Caddyfile
require_file docs/templates/edge-host.Caddyfile
require_file docs/templates/control-plane.compose.yml
require_file docs/templates/edge-host.compose.yml
require_file scripts/operator-common.sh
require_file scripts/release-images.sh
require_file scripts/validate-production-env.sh
require_file scripts/preflight-control-plane-host.sh
require_file scripts/preflight-edge-host.sh
require_file scripts/deploy-control-plane-host.sh
require_file scripts/deploy-edge-host.sh
require_file scripts/quarantine-telemetry-spool-lines.sh
require_file scripts/verify-first-host-deploy.sh

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
require_contains docs/templates/control-plane.compose.yml "immutable digest refs"
require_contains docs/templates/control-plane.compose.yml "/etc/rend/rend-api.env"
require_contains docs/templates/control-plane.compose.yml "/etc/rend/rend-media-worker.env"
require_contains docs/templates/control-plane.compose.yml "http://127.0.0.1:4000/readyz"

require_compose_service docs/templates/edge-host.compose.yml rend-edge
require_contains docs/templates/edge-host.compose.yml '${REND_EDGE_IMAGE:?set REND_EDGE_IMAGE}'
require_contains docs/templates/edge-host.compose.yml "immutable digest ref"
require_contains docs/templates/edge-host.compose.yml "/etc/rend/rend-edge.env"
require_contains docs/templates/edge-host.compose.yml "/var/lib/rend/edge-cache"
require_contains docs/templates/edge-host.compose.yml "/var/spool/rend/edge-telemetry"
require_contains docs/templates/edge-host.compose.yml "http://127.0.0.1:4100/readyz"
require_contains docs/templates/edge-host.compose.yml '${REND_EDGE_PUBLISH_ADDR:-127.0.0.1}'

require_contains docs/templates/control-plane.Caddyfile 'remote_ip {$REND_CONTROL_PLANE_ALLOWED_EDGE_IPS}'
require_contains docs/templates/control-plane.Caddyfile 'REND_PUBLIC_API_HOSTNAME'
require_contains docs/templates/control-plane.Caddyfile "path /v1/* /readyz"
require_contains docs/templates/control-plane.Caddyfile "path /internal/*"
require_contains docs/templates/control-plane.Caddyfile "reverse_proxy 127.0.0.1:4000"
require_contains docs/templates/control-plane.Caddyfile "respond 404"

require_contains docs/templates/edge-host.Caddyfile "path /internal/* /metrics"
require_contains docs/templates/edge-host.Caddyfile "path_regexp canonical_playback ^/v/[0-9a-f]{8}"
require_contains docs/templates/edge-host.Caddyfile "opener\\.mp4|hls/master\\.m3u8|hls/segment_[0-9]+\\.ts"
require_contains docs/templates/edge-host.Caddyfile "reverse_proxy 127.0.0.1:4100"
require_contains docs/templates/edge-host.Caddyfile 'remote_ip {$REND_EDGE_ALLOWED_PRIVATE_IPS}'
require_contains docs/templates/edge-host.Caddyfile 'REND_EDGE_PRIVATE_HOSTNAME'

require_contains scripts/operator-common.sh "operator_check_manifest_image_pulls"
require_contains scripts/operator-common.sh "operator_manifest_service_platform"
require_contains scripts/operator-common.sh "operator_check_image_platform"
require_contains scripts/operator-common.sh "operator_psql_database_url"
require_contains scripts/operator-common.sh "docker image pull"
require_contains scripts/operator-common.sh "operator_check_edge_publish_addr_policy"
require_contains scripts/release-images.sh "--platform"
require_contains scripts/release-images.sh "require_pushed_git_sha"
require_contains scripts/release-images.sh "docs/releases"
require_contains scripts/preflight-control-plane-host.sh "operator_check_manifest_image_pulls"
require_contains scripts/preflight-control-plane-host.sh "--expected-platform"
require_contains scripts/preflight-edge-host.sh "operator_check_manifest_image_pulls"
require_contains scripts/preflight-edge-host.sh "--expected-platform"
require_contains scripts/preflight-edge-host.sh "--allow-direct-edge-exposure"
require_contains scripts/preflight-edge-host.sh 'publish_addr="${REND_EDGE_PUBLISH_ADDR:-127.0.0.1}"'
require_contains scripts/deploy-control-plane-host.sh "--expected-platform"
require_contains scripts/deploy-control-plane-host.sh "operator_check_manifest_image_pulls"
require_contains scripts/deploy-edge-host.sh "--expected-platform"
require_contains scripts/deploy-edge-host.sh "operator_check_manifest_image_pulls"
require_contains scripts/quarantine-telemetry-spool-lines.sh "playback-events.quarantine.jsonl"
require_contains scripts/verify-first-host-deploy.sh "--edge-internal-base"
require_contains scripts/verify-first-host-deploy.sh "--clickhouse-database"
require_contains scripts/verify-first-host-deploy.sh "operator_psql_database_url"
require_contains scripts/verify-first-host-deploy.sh "/v/not-a-uuid/hls/master.m3u8"
require_contains scripts/verify-first-host-deploy.sh "rend_edge_telemetry_spool_bytes"

require_contains docs/edge-host-runbook-v1.md "public playback"
require_contains docs/edge-host-runbook-v1.md "private/internal"
require_contains docs/edge-host-runbook-v1.md "metrics"
require_contains docs/edge-host-runbook-v1.md "docs/templates/edge-host.Caddyfile"
require_contains docs/edge-host-runbook-v1.md "docs/templates/control-plane.Caddyfile"
require_contains docs/edge-host-runbook-v1.md "quarantine-telemetry-spool-lines.sh"
require_contains docs/edge-host-runbook-v1.md "docker login ghcr.io"
require_contains docs/edge-host-runbook-v1.md "--edge-internal-base"
require_contains docs/edge-host-runbook-v1.md "REND_EXPECTED_EDGES"
require_contains docs/edge-host-runbook-v1.md "rend_edge_cache_requests_total"
require_contains docs/edge-host-runbook-v1.md "stream-while-write"
require_contains docs/edge-host-runbook-v1.md "/var/lib/rend/edge-cache"
require_contains docs/edge-host-runbook-v1.md "/var/spool/rend/edge-telemetry"
require_contains docs/edge-host-runbook-v1.md "x-rend-internal-token"
require_contains docs/edge-host-runbook-v1.md "rollback"
require_contains docs/edge-host-runbook-v1.md "--strict"
require_contains docs/edge-host-runbook-v1.md "scripts/preflight-control-plane-host.sh"
require_contains docs/edge-host-runbook-v1.md "scripts/preflight-edge-host.sh"
require_contains docs/edge-host-runbook-v1.md "scripts/deploy-control-plane-host.sh"
require_contains docs/edge-host-runbook-v1.md "scripts/deploy-edge-host.sh"
require_contains docs/edge-host-runbook-v1.md "scripts/verify-first-host-deploy.sh"
require_contains docs/edge-host-runbook-v1.md "sslrootcert=system"
require_contains docs/edge-host-runbook-v1.md "docs/releases"
require_contains docs/deployment-v1.md "docs/edge-host-runbook-v1.md"
require_contains docs/deployment-v1.md "REND_ENV=local|production"
require_contains docs/deployment-v1.md "REND_EXPECTED_EDGES"
require_contains docs/deployment-v1.md "streams cold playback misses"
require_contains docs/deployment-v1.md "docs/release-images-v1.md"
require_contains docs/deployment-v1.md "scripts/validate-production-env.sh"
require_contains docs/deployment-v1.md "scripts/preflight-control-plane-host.sh"
require_contains docs/deployment-v1.md "scripts/preflight-edge-host.sh"
require_contains docs/deployment-v1.md "scripts/verify-first-host-deploy.sh"
require_contains docs/deployment-v1.md "manifest image pull readiness"
require_contains docs/deployment-v1.md "pulled image OS/architecture"
require_contains docs/release-images-v1.md "Canonical Images"
require_contains docs/release-images-v1.md "Production Gates"
require_contains docs/release-images-v1.md "image_digest"
require_contains docs/release-images-v1.md "linux/amd64"
require_contains docs/release-images-v1.md "docs/releases"
require_contains docs/release-images-v1.md "docker login ghcr.io"
require_contains docs/release-images-v1.md "--allow-dirty"
require_contains docs/release-images-v1.md '`--push` requires'
require_contains docs/release-images-v1.md "scripts/check-docker-image-versions.sh --running"

scripts/validate-production-env.sh \
  --role all \
  --allow-placeholders \
  --api-env docs/env/rend-api.env.example \
  --worker-env docs/env/rend-media-worker.env.example \
  --edge-env docs/env/rend-edge-us-east.env.example

scripts/validate-production-env.sh \
  --role edge-host \
  --allow-placeholders \
  --edge-env docs/env/rend-edge-london.env.example

if [[ "$failures" != "0" ]]; then
  exit 1
fi

echo "Edge deployment docs/templates validation passed"
