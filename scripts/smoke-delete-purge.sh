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
edge_cache_backend="local"
edge_cache_root=""

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
    echo "$1 is required for the delete/purge smoke flow" >&2
    exit 1
  }
}

edge_cache_exists() {
  local path="$1"
  if [[ "$edge_cache_backend" == "compose" ]]; then
    docker compose exec -T rend-edge sh -c 'test -e "$1"' sh "$path" >/dev/null 2>&1
  else
    [[ -e "$path" ]]
  fi
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
export REND_ENV="${REND_SMOKE_REND_ENV:-local}"
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
export REND_EDGE_WARM_URL="${REND_EDGE_WARM_URL:-}"
export REND_EDGE_PURGE_URL="${REND_EDGE_PURGE_URL:-$edge_base/internal/purge}"
export REND_PLAYBACK_SIGNING_KEY_ID="${REND_PLAYBACK_SIGNING_KEY_ID:-local-dev-playback-key}"
export REND_PLAYBACK_SIGNING_SECRET="${REND_PLAYBACK_SIGNING_SECRET:-local-dev-playback-signing-secret}"
export REND_PLAYBACK_TOKEN_TTL_SECS="${REND_PLAYBACK_TOKEN_TTL_SECS:-900}"
export REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS="${REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS:-2}"
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
export REND_EDGE_BASE_URL="${REND_EDGE_BASE_URL:-$edge_base}"
export REND_EXPECTED_EDGES="${REND_SMOKE_EXPECTED_EDGES:-$REND_EDGE_ID=$REND_EDGE_REGION=$REND_EDGE_BASE_URL}"
export REND_EDGE_CACHE_DIR="${REND_EDGE_CACHE_DIR:-$root_dir/.rend/edge-cache}"
export REND_EDGE_ORIGIN_HEALTH_URL="${REND_EDGE_ORIGIN_HEALTH_URL:-http://localhost:9100/minio/health/ready}"
export REND_EDGE_INTERNAL_TOKEN="${REND_EDGE_INTERNAL_TOKEN:-dev-internal-token}"
export REND_EDGE_WARM_MAX_ARTIFACTS="${REND_EDGE_WARM_MAX_ARTIFACTS:-4}"

docker compose stop rend-api rend-media-worker rend-edge >/dev/null 2>&1 || true
docker compose up -d postgres redis clickhouse minio minio-init clickhouse-init

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
rm -rf "$REND_EDGE_CACHE_DIR"
mkdir -p "$REND_EDGE_CACHE_DIR"

if ! curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-api >"$root_dir/.rend/rend-api-delete-purge-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-delete-purge-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-edge >"$root_dir/.rend/rend-edge-delete-purge-smoke.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" && -n "$edge_pid" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-delete-purge-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$edge_base/readyz" >/dev/null
edge_cache_root="$REND_EDGE_CACHE_DIR"
if [[ "$edge_started" != "1" ]]; then
  compose_edge_cache_root="$(
    docker compose exec -T rend-edge sh -c 'printf "%s" "${REND_EDGE_CACHE_DIR:-/var/lib/rend/edge-cache}"' 2>/dev/null || true
  )"
  if [[ -n "$compose_edge_cache_root" ]]; then
    edge_cache_backend="compose"
    edge_cache_root="$compose_edge_cache_root"
  fi
fi
start_media_worker "rend-api-media-worker-delete-purge-smoke"

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

manifest_cache_path="$edge_cache_root/videos/$asset_id/hls/master.m3u8"
manifest_body="$tmp_dir/manifest.body"
status_code="$(curl -sS -b "$(playback_cookie_jar)" -o "$manifest_body" -w "%{http_code}" "$playback_url")"
if [[ "$status_code" != "200" ]]; then
  echo "edge playback fetch expected HTTP 200, got $status_code" >&2
  cat "$manifest_body" >&2 || true
  exit 1
fi
if ! edge_cache_exists "$manifest_cache_path"; then
  echo "expected edge playback fetch to populate $manifest_cache_path" >&2
  exit 1
fi
opener_url="$edge_base/v/$asset_id/opener.mp4"
opener_cache_path="$edge_cache_root/videos/$asset_id/opener.mp4"
opener_body="$tmp_dir/opener.body"
status_code="$(curl -sS -b "$(playback_cookie_jar)" -o "$opener_body" -w "%{http_code}" "$opener_url")"
if [[ "$status_code" != "200" ]]; then
  echo "edge opener fetch expected HTTP 200, got $status_code" >&2
  cat "$opener_body" >&2 || true
  exit 1
fi
if ! edge_cache_exists "$opener_cache_path"; then
  echo "expected edge opener fetch to populate $opener_cache_path" >&2
  exit 1
fi
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
segment_url="$edge_base/v/$asset_id/hls/$segment_name"
segment_cache_path="$edge_cache_root/videos/$asset_id/hls/$segment_name"
segment_body="$tmp_dir/segment.body"
status_code="$(curl -sS -b "$(playback_cookie_jar)" -o "$segment_body" -w "%{http_code}" "$segment_url")"
if [[ "$status_code" != "200" ]]; then
  echo "edge segment fetch expected HTTP 200, got $status_code" >&2
  cat "$segment_body" >&2 || true
  exit 1
fi
if ! edge_cache_exists "$segment_cache_path"; then
  echo "expected edge segment fetch to populate $segment_cache_path" >&2
  exit 1
fi

delete_response="$tmp_dir/delete.json"
status_code="$(
  curl -sS -o "$delete_response" -w "%{http_code}" \
    -X DELETE "$api_base/v1/assets/$asset_id" \
    -H "authorization: Bearer $REND_DEV_API_KEY"
)"
if [[ "$status_code" != "200" ]]; then
  echo "delete failed with HTTP $status_code" >&2
  cat "$delete_response" >&2
  exit 1
fi

python3 - "$delete_response" "$asset_id" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
asset_id = sys.argv[2]
if response.get("asset_id") != asset_id:
    raise SystemExit(f"delete asset_id mismatch: {response}")
if response.get("deleted") is not True:
    raise SystemExit(f"delete response did not report deleted: {response}")
if response.get("already_deleted") is not False:
    raise SystemExit(f"first delete unexpectedly reported already_deleted: {response}")
if int(response.get("origin_objects_deleted", 0)) < 1:
    raise SystemExit(f"delete response did not report origin object cleanup: {response}")
if response.get("purge_attempted") is not True:
    raise SystemExit(f"delete response did not attempt configured edge purge: {response}")
PY

for cache_path in "$opener_cache_path" "$manifest_cache_path" "$segment_cache_path"; do
  if edge_cache_exists "$cache_path"; then
    echo "expected edge purge to remove $cache_path" >&2
    exit 1
  fi
done

repeat_delete_response="$tmp_dir/repeat-delete.json"
status_code="$(
  curl -sS -o "$repeat_delete_response" -w "%{http_code}" \
    -X DELETE "$api_base/v1/assets/$asset_id" \
    -H "authorization: Bearer $REND_DEV_API_KEY"
)"
if [[ "$status_code" != "200" ]]; then
  echo "repeat delete failed with HTTP $status_code" >&2
  cat "$repeat_delete_response" >&2
  exit 1
fi

python3 - "$repeat_delete_response" "$asset_id" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
asset_id = sys.argv[2]
if response.get("asset_id") != asset_id:
    raise SystemExit(f"repeat delete asset_id mismatch: {response}")
if response.get("deleted") is not True:
    raise SystemExit(f"repeat delete response did not report deleted: {response}")
if response.get("already_deleted") is not True:
    raise SystemExit(f"repeat delete did not report already_deleted: {response}")
if response.get("origin_objects_deleted") is None:
    raise SystemExit(f"repeat delete response did not report origin object cleanup: {response}")
PY

bootstrap_after_delete="$tmp_dir/bootstrap-after-delete.json"
status_code="$(
  curl -sS -o "$bootstrap_after_delete" -w "%{http_code}" \
    "$api_base/v1/assets/$asset_id/playback" \
    -H "authorization: Bearer $REND_DEV_API_KEY"
)"
if [[ "$status_code" != "404" ]]; then
  echo "bootstrap after delete expected HTTP 404, got $status_code" >&2
  cat "$bootstrap_after_delete" >&2
  exit 1
fi

events_response="$tmp_dir/events.json"
status_code="$(
  curl -sS -o "$events_response" -w "%{http_code}" \
    "$api_base/v1/assets/$asset_id/events?limit=100" \
    -H "authorization: Bearer $REND_DEV_API_KEY"
)"
if [[ "$status_code" != "200" ]]; then
  echo "asset events after delete expected HTTP 200, got $status_code" >&2
  cat "$events_response" >&2
  exit 1
fi

python3 - "$events_response" "$asset_id" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
asset_id = sys.argv[2]
if response.get("asset_id") != asset_id:
    raise SystemExit(f"events asset_id mismatch: {response.get('asset_id')}")
events = response.get("events", [])
types = [event.get("event_type") for event in events]
for required in ["asset.deletion_requested", "asset.deleted", "edge.purge_attempted"]:
    if required not in types:
        raise SystemExit(f"missing deletion lifecycle event {required}: {types}")
purge_results = [event for event in events if event.get("event_type") in {"edge.purge_succeeded", "edge.purge_failed"}]
if not purge_results:
    raise SystemExit(f"missing edge purge result event: {types}")
if purge_results[-1].get("event_type") != "edge.purge_succeeded":
    raise SystemExit(f"expected successful edge purge event, got {purge_results[-1]}")
def purged_count(event):
    metadata = event.get("metadata", {})
    total = 0
    for edge in metadata.get("edges", []):
        summary = edge.get("purge_summary") or {}
        total += int(summary.get("purged") or 0)
    return total
if not any(event.get("event_type") == "edge.purge_succeeded" and purged_count(event) >= 1 for event in purge_results):
    raise SystemExit(f"expected at least one edge purge to report purged files: {purge_results}")
PY

old_urls=(
  "opener|$opener_url|$opener_cache_path"
  "manifest|$playback_url|$manifest_cache_path"
  "segment|$segment_url|$segment_cache_path"
)
for entry in "${old_urls[@]}"; do
  IFS='|' read -r label url cache_path <<<"$entry"
  old_url_body="$tmp_dir/old-url-after-delete-$label.body"
  status_code="$(curl -sS -o "$old_url_body" -w "%{http_code}" "$url")"
  if [[ "$status_code" == "200" ]]; then
    echo "already-issued $label URL unexpectedly remained usable after successful delete" >&2
    cat "$old_url_body" >&2 || true
    exit 1
  fi
  if edge_cache_exists "$cache_path"; then
    echo "old signed $label URL recreated the edge cache after delete" >&2
    exit 1
  fi
done

echo "delete/purge smoke passed for asset $asset_id; new bootstrap is blocked, local cache and origin objects were removed, and already-issued URLs cannot refetch"
