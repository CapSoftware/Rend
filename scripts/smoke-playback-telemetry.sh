#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
source "$root_dir/scripts/smoke-common.sh"

api_base="${REND_API_BASE_URL:-http://127.0.0.1:4000}"
edge_base="${REND_EDGE_BASE_URL:-http://127.0.0.1:4100}"
api_base="${api_base%/}"
edge_base="${edge_base%/}"
fixture_path="${REND_SMOKE_FIXTURE:-$root_dir/fixtures/media/rend-fixture.mp4}"
tmp_dir="$(mktemp -d)"
api_started=0
api_pid=""
edge_started=0
edge_pid=""
worker_started=0
worker_pid=""

cleanup() {
  rm -rf "$tmp_dir"
  stop_media_worker
  if [[ "$edge_started" == "1" && -n "$edge_pid" ]]; then
    kill "$edge_pid" >/dev/null 2>&1 || true
    wait "$edge_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$api_started" == "1" && -n "$api_pid" ]]; then
    kill "$api_pid" >/dev/null 2>&1 || true
    wait "$api_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "$1 is required for the playback telemetry smoke flow" >&2
    exit 1
  }
}

header_value() {
  python3 - "$1" "$2" <<'PY'
import sys
name = sys.argv[2].lower()
with open(sys.argv[1], "r", encoding="iso-8859-1") as f:
    for line in f:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        if key.strip().lower() == name:
            print(value.strip())
            raise SystemExit(0)
PY
}

fetch_and_expect_cache() {
  local label="$1"
  local url="$2"
  local expected_cache_values="$3"
  local headers_file="$tmp_dir/$label.headers"
  local body_file="$tmp_dir/$label.body"
  local status_code
  status_code="$(curl -sS -b "$(playback_cookie_jar)" -D "$headers_file" -o "$body_file" -w "%{http_code}" "$url")"
  if [[ "$status_code" != "200" ]]; then
    echo "$label playback fetch expected HTTP 200, got $status_code" >&2
    cat "$body_file" >&2
    exit 1
  fi
  local cache_header
  cache_header="$(header_value "$headers_file" "x-rend-cache")"
  local matched=0
  local expected_cache
  IFS='|' read -r -a expected_cache_list <<<"$expected_cache_values"
  for expected_cache in "${expected_cache_list[@]}"; do
    if [[ "$cache_header" == "$expected_cache" ]]; then
      matched=1
      break
    fi
  done
  if [[ "$matched" != "1" ]]; then
    echo "$label expected X-Rend-Cache $expected_cache_values, got $cache_header" >&2
    exit 1
  fi
  if [[ ! -s "$body_file" ]]; then
    echo "$label expected nonempty playback body" >&2
    exit 1
  fi
  printf '%s\n' "$cache_header"
}

require_command cargo
require_command curl
require_command docker
require_command ffmpeg
require_command ffprobe
require_command python3

ffmpeg -version >/dev/null
ffprobe -version >/dev/null

export DATABASE_URL="${DATABASE_URL:-postgres://rend:rend@localhost:5432/rend}"
export REND_REDIS_URL="${REND_REDIS_URL:-redis://localhost:6379}"
export CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://localhost:8123}"
export CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-rend}"
export CLICKHOUSE_USER="${CLICKHOUSE_USER:-rend}"
export CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-rend}"
export OBJECT_STORE_HEALTH_URL="${OBJECT_STORE_HEALTH_URL:-http://localhost:9100/minio/health/ready}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9100}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_BUCKET="${S3_BUCKET:-rend-local}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-rend_minio}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-rend_minio_password}"
export REND_API_BIND_ADDR="${REND_API_BIND_ADDR:-127.0.0.1:4000}"
export REND_API_AUTO_MIGRATE="${REND_API_AUTO_MIGRATE:-true}"
export REND_DEV_API_KEY="${REND_DEV_API_KEY:-dev-api-key}"
export REND_PLAYBACK_BASE_URL="${REND_PLAYBACK_BASE_URL:-$edge_base}"
export REND_EDGE_WARM_URL=""
export REND_EDGE_PURGE_URL="${REND_EDGE_PURGE_URL:-$edge_base/internal/purge}"
export REND_INTERNAL_TELEMETRY_TOKEN="${REND_INTERNAL_TELEMETRY_TOKEN:-dev-internal-token}"
export REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES="${REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES:-262144}"
export REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH="${REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH:-100}"
export REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS="${REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS:-86400}"
export REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS="${REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS:-604800}"
export REND_PLAYBACK_SIGNING_KEY_ID="${REND_PLAYBACK_SIGNING_KEY_ID:-local-dev-playback-key}"
export REND_PLAYBACK_SIGNING_SECRET="${REND_PLAYBACK_SIGNING_SECRET:-local-dev-playback-signing-secret}"
export REND_PLAYBACK_TOKEN_TTL_SECS="${REND_PLAYBACK_TOKEN_TTL_SECS:-900}"
export REND_HTTP_TIMEOUT_SECS="${REND_HTTP_TIMEOUT_SECS:-120}"
export REND_MEDIA_PROCESS_TIMEOUT_SECS="${REND_MEDIA_PROCESS_TIMEOUT_SECS:-60}"
export REND_API_INLINE_MEDIA_PROCESSING="${REND_API_INLINE_MEDIA_PROCESSING:-false}"
export REND_MEDIA_JOB_MAX_ATTEMPTS="${REND_MEDIA_JOB_MAX_ATTEMPTS:-3}"
export REND_MEDIA_WORKER_POLL_INTERVAL_SECS="${REND_MEDIA_WORKER_POLL_INTERVAL_SECS:-1}"
export REND_MEDIA_JOB_LOCK_TIMEOUT_SECS="${REND_MEDIA_JOB_LOCK_TIMEOUT_SECS:-300}"
export REND_FFMPEG_PATH="${REND_FFMPEG_PATH:-ffmpeg}"
export REND_FFPROBE_PATH="${REND_FFPROBE_PATH:-ffprobe}"
export REND_EDGE_BIND_ADDR="${REND_EDGE_BIND_ADDR:-127.0.0.1:4100}"
export REND_EDGE_ID="${REND_EDGE_ID:-local-edge-001}"
export REND_EDGE_REGION="${REND_EDGE_REGION:-local}"
export REND_EDGE_CACHE_DIR="${REND_EDGE_CACHE_DIR:-$tmp_dir/edge-cache}"
export REND_EDGE_ORIGIN_HEALTH_URL="${REND_EDGE_ORIGIN_HEALTH_URL:-http://localhost:9100/minio/health/ready}"
export REND_EDGE_INTERNAL_TOKEN="${REND_EDGE_INTERNAL_TOKEN:-dev-internal-token}"
export REND_EDGE_TELEMETRY_ENABLED="${REND_EDGE_TELEMETRY_ENABLED:-true}"
export REND_EDGE_TELEMETRY_INGEST_URL="${REND_EDGE_TELEMETRY_INGEST_URL:-$api_base/internal/telemetry/playback}"
export REND_EDGE_TELEMETRY_QUEUE_CAPACITY="${REND_EDGE_TELEMETRY_QUEUE_CAPACITY:-32}"
export REND_EDGE_TELEMETRY_BATCH_SIZE="${REND_EDGE_TELEMETRY_BATCH_SIZE:-10}"
export REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS="${REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS:-1}"
export REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS="${REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS:-2}"
export REND_EDGE_TELEMETRY_SPOOL_DIR="${REND_EDGE_TELEMETRY_SPOOL_DIR:-$tmp_dir/telemetry-spool}"
export REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES="${REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES:-10485760}"

docker compose up -d

for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U rend -d rend >/dev/null 2>&1 &&
    docker compose exec -T redis redis-cli ping >/dev/null 2>&1 &&
    docker compose exec -T clickhouse clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT 1" >/dev/null 2>&1 &&
    curl -fsS "$OBJECT_STORE_HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker compose exec -T postgres pg_isready -U rend -d rend >/dev/null
docker compose exec -T redis redis-cli ping >/dev/null
docker compose exec -T clickhouse clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT 1" >/dev/null
curl -fsS "$OBJECT_STORE_HEALTH_URL" >/dev/null
for schema in "$root_dir"/clickhouse/*.sql; do
  docker compose exec -T clickhouse clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery <"$schema"
done

"$root_dir/scripts/generate-fixture-video.sh" "$fixture_path" >/dev/null

mkdir -p "$root_dir/.rend" "$REND_EDGE_CACHE_DIR" "$REND_EDGE_TELEMETRY_SPOOL_DIR"
if ! curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-api >"$root_dir/.rend/rend-api-playback-telemetry-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-playback-telemetry-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-edge >"$root_dir/.rend/rend-edge-playback-telemetry-smoke.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-playback-telemetry-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$edge_base/readyz" >/dev/null
start_media_worker "rend-api-media-worker-playback-telemetry-smoke"

upload_response="$tmp_dir/upload.json"
status_code="$(
  curl -sS -o "$upload_response" -w "%{http_code}" \
    -X POST "$api_base/v1/videos" \
    -H "authorization: Bearer $REND_DEV_API_KEY" \
    -H "content-type: video/mp4" \
    --data-binary @"$fixture_path"
)"

if [[ "$status_code" != "201" ]]; then
  echo "upload failed with HTTP $status_code" >&2
  cat "$upload_response" >&2
  exit 1
fi

asset_id="$(
  assert_async_upload_response "$upload_response"
)"

poll_asset_until_hls_ready "$asset_id" "$tmp_dir/asset.json"
bootstrap_response="$tmp_dir/bootstrap.json"
fetch_playback_bootstrap "$asset_id" "$bootstrap_response"
playback_url="$(
  playback_url_from_bootstrap "$bootstrap_response"
)"

expected_playback_url="$edge_base/v/$asset_id/hls/master.m3u8"
if [[ "$playback_url" != "$expected_playback_url" ]]; then
  echo "expected tokenless HLS playback_url for asset $asset_id at the edge manifest path" >&2
  echo "got $playback_url" >&2
  exit 1
fi

first_cache="$(
  fetch_and_expect_cache "first" "$playback_url" "${REND_SMOKE_FIRST_CACHE:-MISS|HIT}"
)"
second_cache="$(
  fetch_and_expect_cache "second" "$playback_url" "HIT"
)"

analytics_response="$tmp_dir/analytics.json"
for _ in $(seq 1 60); do
  status_code="$(
    curl -sS -o "$analytics_response" -w "%{http_code}" \
      "$api_base/v1/assets/$asset_id/analytics/playback?window_seconds=3600" \
      -H "authorization: Bearer $REND_DEV_API_KEY"
  )"
  if [[ "$status_code" == "200" ]] &&
    python3 - "$analytics_response" "$first_cache" "$second_cache" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
first_cache = sys.argv[2]
second_cache = sys.argv[3]
cache = data.get("cache_status_counts", {})
statuses = data.get("status_code_counts", {})
ok = (
    int(data.get("request_count", 0)) >= 2
    and int(data.get("bytes_served", 0)) > 0
    and int(cache.get(first_cache, 0)) >= 1
    and int(cache.get(second_cache, 0)) >= 1
    and int(statuses.get("200", 0)) >= 2
    and data.get("first_seen")
    and data.get("last_seen")
)
raise SystemExit(0 if ok else 1)
PY
  then
    echo "playback telemetry smoke passed for asset $asset_id"
    exit 0
  fi
  sleep 1
done

echo "timed out waiting for playback telemetry analytics for asset $asset_id" >&2
cat "$analytics_response" >&2 || true
exit 1
