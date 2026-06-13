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
    echo "$1 is required for the edge cache smoke flow" >&2
    exit 1
  }
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
export REND_EDGE_CACHE_DIR="${REND_EDGE_CACHE_DIR:-$root_dir/.rend/edge-cache}"
export REND_EDGE_ORIGIN_HEALTH_URL="${REND_EDGE_ORIGIN_HEALTH_URL:-http://localhost:9100/minio/health/ready}"
export REND_EDGE_INTERNAL_TOKEN="${REND_EDGE_INTERNAL_TOKEN:-dev-internal-token}"

docker compose up -d

for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U rend -d rend >/dev/null 2>&1 &&
    docker compose exec -T redis redis-cli ping >/dev/null 2>&1 &&
    curl -fsS "$OBJECT_STORE_HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker compose exec -T postgres pg_isready -U rend -d rend >/dev/null
docker compose exec -T redis redis-cli ping >/dev/null
curl -fsS "$OBJECT_STORE_HEALTH_URL" >/dev/null

"$root_dir/scripts/generate-fixture-video.sh" "$fixture_path" >/dev/null

mkdir -p "$root_dir/.rend" "$REND_EDGE_CACHE_DIR"
if ! curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-api >"$root_dir/.rend/rend-api-edge-cache-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-edge-cache-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-edge >"$root_dir/.rend/rend-edge-cache-smoke.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-cache-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$edge_base/readyz" >/dev/null
start_media_worker "rend-api-media-worker-edge-cache-smoke"

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

expected_playback_prefix="$edge_base/v/$asset_id/hls/master.m3u8?token="
if [[ "$playback_url" != "$expected_playback_prefix"* ]]; then
  echo "expected signed HLS playback_url for asset $asset_id at the edge manifest path" >&2
  exit 1
fi

token="${playback_url#*\?token=}"
if [[ "$token" == "$playback_url" || -z "$token" ]]; then
  echo "playback_url did not include a token query parameter" >&2
  exit 1
fi

header_value() {
  python3 - "$1" "$2" <<'PY'
import sys
name = sys.argv[2].lower()
with open(sys.argv[1], "r", encoding="iso-8859-1") as f:
    for line in f:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        if key.lower() == name:
            print(value.strip())
            raise SystemExit(0)
raise SystemExit(1)
PY
}

fetch_once() {
  local label="$1"
  local url="$2"
  local expected_cache="$3"
  local expected_content_type="$4"
  local body_file="$5"
  local headers_file="$tmp_dir/$label-$expected_cache.headers"

  local http_code
  http_code="$(curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" "$url")"
  if [[ "$http_code" != "200" ]]; then
    echo "$label fetch expected HTTP 200, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi

  local cache_header
  cache_header="$(header_value "$headers_file" "x-rend-cache")"
  if [[ "$cache_header" != "$expected_cache" ]]; then
    echo "$label expected X-Rend-Cache $expected_cache, got $cache_header" >&2
    exit 1
  fi

  local content_type
  content_type="$(header_value "$headers_file" "content-type")"
  content_type="${content_type%%;*}"
  if [[ "$content_type" != "$expected_content_type" ]]; then
    echo "$label expected Content-Type $expected_content_type, got $content_type" >&2
    exit 1
  fi

  local byte_size
  byte_size="$(wc -c <"$body_file" | tr -d ' ')"
  if [[ "$byte_size" -le 0 ]]; then
    echo "$label response body is empty" >&2
    exit 1
  fi
}

fetch_twice() {
  local label="$1"
  local url="$2"
  local expected_content_type="$3"
  local first_body="$tmp_dir/$label-first.body"
  local second_body="$tmp_dir/$label-second.body"

  fetch_once "$label-first" "$url" "MISS" "$expected_content_type" "$first_body"
  fetch_once "$label-second" "$url" "HIT" "$expected_content_type" "$second_body"
}

expect_rejected() {
  local label="$1"
  local url="$2"
  local body_file="$tmp_dir/$label-rejected.body"

  local http_code
  http_code="$(curl -sS -o "$body_file" -w "%{http_code}" "$url")"
  if [[ "$http_code" != "401" ]]; then
    echo "$label expected HTTP 401, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi
}

tamper_token() {
  local value="$1"
  local last="${value: -1}"
  local replacement="A"
  if [[ "$last" == "A" ]]; then
    replacement="B"
  fi
  printf '%s%s' "${value:0:${#value}-1}" "$replacement"
}

opener_url="$edge_base/v/$asset_id/opener.mp4?token=$token"
manifest_url="$playback_url"
manifest_body="$tmp_dir/manifest-first.body"

fetch_twice "opener" "$opener_url" "video/mp4"
fetch_once "manifest-first" "$manifest_url" "MISS" "application/vnd.apple.mpegurl" "$manifest_body"
fetch_once "manifest-second" "$manifest_url" "HIT" "application/vnd.apple.mpegurl" "$tmp_dir/manifest-second.body"

segment_name="$(
  python3 - "$manifest_body" <<'PY'
import sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.endswith(".ts") and "/" not in line:
            print(line)
            raise SystemExit(0)
raise SystemExit("manifest did not contain a local .ts segment")
PY
)"

segment_url="$edge_base/v/$asset_id/hls/$segment_name?token=$token"
fetch_twice "segment" "$segment_url" "video/mp2t"

unsigned_manifest_url="$edge_base/v/$asset_id/hls/master.m3u8"
tampered_token="$(tamper_token "$token")"
expect_rejected "missing-token" "$unsigned_manifest_url"
expect_rejected "tampered-token" "$unsigned_manifest_url?token=$tampered_token"
expect_rejected "wrong-asset-token" "$edge_base/v/00000000-0000-0000-0000-000000000000/hls/master.m3u8?token=$token"

echo "signed playback edge cache smoke passed for asset $asset_id with segment $segment_name"
