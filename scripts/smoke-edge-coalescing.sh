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
    echo "$1 is required for the edge coalescing smoke flow" >&2
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
export REND_EDGE_WARM_URL="${REND_EDGE_WARM_URL:-$edge_base/internal/warm}"
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
export REND_EDGE_WARM_MAX_ARTIFACTS="${REND_EDGE_WARM_MAX_ARTIFACTS:-4}"
export REND_EDGE_MAX_IN_FLIGHT_FILLS="${REND_EDGE_MAX_IN_FLIGHT_FILLS:-64}"

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
  cargo run -p rend-api >"$root_dir/.rend/rend-api-edge-coalescing-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-edge-coalescing-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-edge >"$root_dir/.rend/rend-edge-coalescing-smoke.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" && -n "$edge_pid" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-coalescing-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$edge_base/readyz" >/dev/null
start_media_worker "rend-api-media-worker-edge-coalescing-smoke"

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
opener_url="$(
  python3 - "$bootstrap_response" "$edge_base" "$asset_id" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
opener_url = response.get("opener_url", "")
if not opener_url:
    opener_url = f"{sys.argv[2]}/v/{sys.argv[3]}/opener.mp4"
print(opener_url)
PY
)"

expected_opener_url="$edge_base/v/$asset_id/opener.mp4"
if [[ "$opener_url" != "$expected_opener_url" ]]; then
  echo "expected tokenless opener_url at $expected_opener_url" >&2
  echo "got $opener_url" >&2
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

purge_opener_cache() {
  local body_file="$tmp_dir/purge-opener.json"
  local payload
  payload="$(
    python3 - "$asset_id" <<'PY'
import json, sys
print(json.dumps({"asset_id": sys.argv[1], "artifact_paths": ["opener.mp4"]}))
PY
  )"

  local http_code
  http_code="$(curl -sS -o "$body_file" -w "%{http_code}" \
    -X POST "$edge_base/internal/purge" \
    -H "x-rend-internal-token: $REND_EDGE_INTERNAL_TOKEN" \
    -H "content-type: application/json" \
    --data "$payload")"
  if [[ "$http_code" != "200" ]]; then
    echo "purge before coalescing expected HTTP 200, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi
}

fetch_concurrent_batch() {
  local attempt="$1"
  local count="$2"
  local batch_dir="$tmp_dir/batch-$attempt"
  mkdir -p "$batch_dir"

  local -a pids=()
  for index in $(seq 1 "$count"); do
    (
      curl -sS -b "$(playback_cookie_jar)" -D "$batch_dir/$index.headers" -o "$batch_dir/$index.body" \
        -w "%{http_code}" "$opener_url" >"$batch_dir/$index.code"
    ) &
    pids+=("$!")
  done

  local failed=0
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      failed=1
    fi
  done
  if [[ "$failed" == "1" ]]; then
    echo "one or more concurrent opener requests failed to complete" >&2
    exit 1
  fi

  local miss_count=0
  local coalesced_count=0
  local hit_count=0
  for index in $(seq 1 "$count"); do
    local code
    code="$(cat "$batch_dir/$index.code")"
    if [[ "$code" != "200" ]]; then
      echo "concurrent request $index expected HTTP 200, got $code" >&2
      cat "$batch_dir/$index.body" >&2 || true
      exit 1
    fi

    local byte_size
    byte_size="$(wc -c <"$batch_dir/$index.body" | tr -d ' ')"
    if [[ "$byte_size" -le 0 ]]; then
      echo "concurrent request $index returned an empty body" >&2
      exit 1
    fi

    if ! cmp -s "$batch_dir/1.body" "$batch_dir/$index.body"; then
      echo "concurrent request $index body differed from request 1" >&2
      exit 1
    fi

    local cache_header
    cache_header="$(header_value "$batch_dir/$index.headers" "x-rend-cache")"
    case "$cache_header" in
      MISS)
        miss_count=$((miss_count + 1))
        ;;
      COALESCED)
        coalesced_count=$((coalesced_count + 1))
        ;;
      HIT)
        hit_count=$((hit_count + 1))
        ;;
      *)
        echo "concurrent request $index returned unexpected X-Rend-Cache $cache_header" >&2
        exit 1
        ;;
    esac
  done

  if [[ "$miss_count" == "1" && "$coalesced_count" -ge 1 ]]; then
    printf '%s %s %s\n' "$miss_count" "$coalesced_count" "$hit_count"
    return 0
  fi
  if [[ "$miss_count" -gt 1 ]]; then
    echo "expected one MISS in coalesced batch, got $miss_count" >&2
    exit 1
  fi
  return 1
}

concurrency="${REND_EDGE_COALESCING_CONCURRENCY:-24}"
attempts="${REND_EDGE_COALESCING_ATTEMPTS:-5}"
miss_count=0
coalesced_count=0
hit_count=0

for attempt in $(seq 1 "$attempts"); do
  purge_opener_cache
  if counts="$(fetch_concurrent_batch "$attempt" "$concurrency")"; then
    read -r miss_count coalesced_count hit_count <<<"$counts"
    break
  fi
  sleep 0.2
done

if [[ "$miss_count" != "1" || "$coalesced_count" -lt 1 ]]; then
  echo "did not observe a coalesced cold fill after $attempts attempts" >&2
  exit 1
fi

later_headers="$tmp_dir/later-hit.headers"
later_body="$tmp_dir/later-hit.body"
later_code="$(curl -sS -b "$(playback_cookie_jar)" -D "$later_headers" -o "$later_body" -w "%{http_code}" "$opener_url")"
if [[ "$later_code" != "200" ]]; then
  echo "later opener fetch expected HTTP 200, got $later_code" >&2
  cat "$later_body" >&2 || true
  exit 1
fi
later_cache="$(header_value "$later_headers" "x-rend-cache")"
if [[ "$later_cache" != "HIT" ]]; then
  echo "later opener fetch expected X-Rend-Cache HIT, got $later_cache" >&2
  exit 1
fi

echo "edge coalescing smoke passed for asset $asset_id with $miss_count MISS, $coalesced_count COALESCED, $hit_count HIT in burst"
