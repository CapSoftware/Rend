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
    echo "$1 is required for the edge warming smoke flow" >&2
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
export REND_EDGE_WARM_MAX_ARTIFACTS="${REND_EDGE_WARM_MAX_ARTIFACTS:-16}"

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

mkdir -p "$root_dir/.rend"
if ! curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-api >"$root_dir/.rend/rend-api-edge-warming-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-edge-warming-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-edge >"$root_dir/.rend/rend-edge-warming-smoke.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-warming-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$edge_base/readyz" >/dev/null
rm -rf "$REND_EDGE_CACHE_DIR"
mkdir -p "$REND_EDGE_CACHE_DIR"
start_media_worker "rend-api-media-worker-edge-warming-smoke"

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

token="$(awk '$6 == "__rend_playback" { print $7; exit }' "$(playback_cookie_jar)")"
if [[ -z "$token" ]]; then
  echo "playback cookie jar did not include a playback token" >&2
  exit 1
fi

warm_payload() {
  python3 - "$asset_id" "$@" <<'PY'
import json, sys
asset_id = sys.argv[1]
paths = sys.argv[2:]
print(json.dumps({"asset_id": asset_id, "artifact_paths": paths}))
PY
}

expect_warm_rejected() {
  local label="$1"
  local token_header="$2"
  local body_file="$tmp_dir/$label-warm-rejected.body"
  local payload
  payload="$(warm_payload opener.mp4)"

  local args=(-sS -o "$body_file" -w "%{http_code}" -X POST "$edge_base/internal/warm" -H "content-type: application/json" --data "$payload")
  if [[ -n "$token_header" ]]; then
    args+=(-H "x-rend-internal-token: $token_header")
  fi

  local http_code
  http_code="$(curl "${args[@]}")"
  if [[ "$http_code" != "401" ]]; then
    echo "$label warm auth expected HTTP 401, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi
}

warm_artifacts() {
  local label="$1"
  shift
  local body_file="$tmp_dir/$label-warm.json"
  local payload
  payload="$(warm_payload "$@")"

  local http_code
  http_code="$(curl -sS -o "$body_file" -w "%{http_code}" \
    -X POST "$edge_base/internal/warm" \
    -H "x-rend-internal-token: $REND_EDGE_INTERNAL_TOKEN" \
    -H "content-type: application/json" \
    --data "$payload")"
  if [[ "$http_code" != "200" ]]; then
    echo "$label warm expected HTTP 200, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi

  python3 - "$body_file" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
results = response.get("results", [])
if not results:
    raise SystemExit("warm response had no results")
bad = [r for r in results if r.get("status") in {"not_found", "failed"}]
if bad:
    raise SystemExit(f"warm response had failed entries: {bad}")
for result in results:
    if result.get("status") not in {"warmed", "already_warm"}:
        raise SystemExit(f"unexpected warm status: {result}")
PY
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
  http_code="$(curl -sS -b "$(playback_cookie_jar)" -D "$headers_file" -o "$body_file" -w "%{http_code}" "$url")"
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

first_variant_path() {
  python3 - "$1" <<'PY'
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if re.fullmatch(r"(360p|480p|720p|1080p|2k|4k)/index\.m3u8", line):
            print(line)
            raise SystemExit(0)
raise SystemExit("master manifest did not contain a supported variant playlist")
PY
}

startup_hls_media_paths() {
  python3 - "$1" "$2" <<'PY'
import re
import sys

variant_path = sys.argv[2]
rendition = variant_path.split("/", 1)[0]
init_name = None
segment_name = None
map_pattern = re.compile(r'^#EXT-X-MAP:URI="([^"]+)"')
segment_pattern = re.compile(r"^segment_[0-9]+\.(ts|m4s)$")

with open(sys.argv[1], "r", encoding="utf-8") as f:
    for raw_line in f:
        line = raw_line.strip()
        match = map_pattern.match(line)
        if match:
            init_name = match.group(1)
            continue
        if segment_pattern.fullmatch(line):
            segment_name = line
            break

if not init_name or "/" in init_name:
    raise SystemExit("variant manifest did not contain a local fMP4 init segment")
if init_name != f"init_{rendition}.mp4":
    raise SystemExit(f"variant init segment did not match rendition: {init_name}")
if not segment_name:
    raise SystemExit("variant manifest did not contain a local media segment")

print(f"hls/{rendition}/{init_name}")
print(f"hls/{rendition}/{segment_name}")
PY
}

expect_warm_rejected "missing-token" ""
expect_warm_rejected "wrong-token" "wrong-token"

opener_url="$edge_base/v/$asset_id/opener.mp4"
manifest_url="$playback_url"
manifest_body="$tmp_dir/manifest-first.body"

warm_artifacts "initial" "opener.mp4" "hls/master.m3u8"
fetch_once "manifest-first" "$manifest_url" "HIT" "application/vnd.apple.mpegurl" "$manifest_body"
fetch_once "opener-first" "$opener_url" "HIT" "video/mp4" "$tmp_dir/opener-first.body"

variant_path="$(first_variant_path "$manifest_body")"
variant_url="$edge_base/v/$asset_id/hls/$variant_path"
variant_body="$tmp_dir/variant-first.body"
warm_artifacts "variant" "hls/$variant_path"
fetch_once "variant-first" "$variant_url" "HIT" "application/vnd.apple.mpegurl" "$variant_body"

media_paths="$(startup_hls_media_paths "$variant_body" "$variant_path")"
init_artifact_path="$(printf '%s\n' "$media_paths" | sed -n '1p')"
segment_artifact_path="$(printf '%s\n' "$media_paths" | sed -n '2p')"
segment_content_type="video/mp2t"
if [[ "$segment_artifact_path" == *.m4s ]]; then
  segment_content_type="video/mp4"
fi

warm_artifacts "startup-media" "$init_artifact_path" "$segment_artifact_path"
init_url="$edge_base/v/$asset_id/$init_artifact_path"
segment_url="$edge_base/v/$asset_id/$segment_artifact_path"
fetch_once "init-first" "$init_url" "HIT" "video/mp4" "$tmp_dir/init-first.body"
fetch_once "segment-first" "$segment_url" "HIT" "$segment_content_type" "$tmp_dir/segment-first.body"

echo "edge warming smoke passed for asset $asset_id with warmed variant $variant_path and segment $segment_artifact_path"
