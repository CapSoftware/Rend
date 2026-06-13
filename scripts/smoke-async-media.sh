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
    echo "$1 is required for the async media smoke flow" >&2
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
export REND_EDGE_CACHE_DIR="${REND_EDGE_CACHE_DIR:-$root_dir/.rend/edge-cache}"
export REND_EDGE_ORIGIN_HEALTH_URL="${REND_EDGE_ORIGIN_HEALTH_URL:-http://localhost:9100/minio/health/ready}"
export REND_EDGE_INTERNAL_TOKEN="${REND_EDGE_INTERNAL_TOKEN:-dev-internal-token}"
export REND_EDGE_WARM_MAX_ARTIFACTS="${REND_EDGE_WARM_MAX_ARTIFACTS:-4}"

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
  cargo run -p rend-api >"$root_dir/.rend/rend-api-async-media-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-async-media-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-edge >"$root_dir/.rend/rend-edge-async-media-smoke.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-async-media-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$edge_base/readyz" >/dev/null

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

asset_id="$(assert_async_upload_response "$upload_response")"

not_playable_response="$tmp_dir/not-playable-bootstrap.json"
status_code="$(
  curl -sS -o "$not_playable_response" -w "%{http_code}" \
    "$api_base/v1/assets/$asset_id/playback" \
    -H "authorization: Bearer $REND_DEV_API_KEY"
)"
if [[ "$status_code" != "404" ]]; then
  echo "expected not-playable bootstrap HTTP 404, got $status_code" >&2
  cat "$not_playable_response" >&2
  exit 1
fi

job_id="$(
  docker compose exec -T postgres psql -U rend -d rend -t -A -c "
    select id::text
    from rend.media_jobs
    where asset_id = '$asset_id'::uuid
      and job_type = 'process_media'
      and status = 'queued'
    order by created_at desc
    limit 1;
  "
)"
if [[ -z "$job_id" ]]; then
  echo "expected queued media job for asset $asset_id" >&2
  exit 1
fi

docker compose exec -T postgres psql -U rend -d rend -v ON_ERROR_STOP=1 -c "
  update rend.media_jobs
  set run_after = now() + interval '10 minutes'
  where id = '$job_id'::uuid;
" >/dev/null

start_media_worker "rend-api-media-worker-async-media-smoke-first"
sleep 2
stop_media_worker

queued_status="$(
  docker compose exec -T postgres psql -U rend -d rend -t -A -c "
    select status
    from rend.media_jobs
    where id = '$job_id'::uuid;
  "
)"
if [[ "$queued_status" != "queued" ]]; then
  echo "expected delayed queued job to survive worker restart, got $queued_status" >&2
  exit 1
fi

docker compose exec -T postgres psql -U rend -d rend -v ON_ERROR_STOP=1 -c "
  update rend.media_jobs
  set run_after = now()
  where id = '$job_id'::uuid;
" >/dev/null

start_media_worker "rend-api-media-worker-async-media-smoke-second"
asset_response="$tmp_dir/asset.json"
poll_asset_until_hls_ready "$asset_id" "$asset_response"

python3 - "$asset_response" "$asset_id" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
asset_id = sys.argv[2]
if response.get("asset_id") != asset_id:
    raise SystemExit(f"asset_id mismatch: {response.get('asset_id')}")
if response.get("source_state") != "uploaded":
    raise SystemExit(f"expected source_state uploaded, got {response.get('source_state')}")
if response.get("playable_state") != "hls_ready":
    raise SystemExit(f"expected playable_state hls_ready, got {response.get('playable_state')}")
counts = {}
for artifact in response.get("artifacts", []):
    counts[artifact.get("kind")] = counts.get(artifact.get("kind"), 0) + 1
for kind in ["source", "opener", "thumbnail", "manifest", "segment"]:
    if counts.get(kind, 0) < 1:
        raise SystemExit(f"missing artifact summary for {kind}: {response.get('artifacts')}")
PY

job_status="$(
  docker compose exec -T postgres psql -U rend -d rend -t -A -F '|' -c "
    select status, attempts, coalesce(last_error, '')
    from rend.media_jobs
    where id = '$job_id'::uuid;
  "
)"
python3 - "$job_status" <<'PY'
import sys
status, attempts, last_error = sys.argv[1].split("|", 2)
if status != "succeeded":
    raise SystemExit(f"expected media job succeeded, got {status}")
if int(attempts) < 1:
    raise SystemExit(f"expected media job attempts to increment, got {attempts}")
if last_error:
    raise SystemExit(f"expected succeeded media job to clear last_error, got {last_error}")
PY

events_response="$tmp_dir/events.json"
status_code="$(
  curl -sS -o "$events_response" -w "%{http_code}" \
    "$api_base/v1/assets/$asset_id/events?limit=100" \
    -H "authorization: Bearer $REND_DEV_API_KEY"
)"
if [[ "$status_code" != "200" ]]; then
  echo "asset events request failed with HTTP $status_code" >&2
  cat "$events_response" >&2
  exit 1
fi

python3 - "$events_response" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
events = response.get("events", [])
types = [event.get("event_type") for event in events]
for required in [
    "asset.created",
    "source.upload_started",
    "source.uploaded",
    "media.processing_queued",
    "upload.response_ready",
    "media.processing_started",
    "artifact.generated",
    "playable_state.changed",
]:
    if required not in types:
        raise SystemExit(f"missing event type {required}: {types}")
encoded = json.dumps([event.get("metadata", {}) for event in events]).lower()
for forbidden in ["?token=", "bearer ", "secret", "credential", "authorization", "playback_url"]:
    if forbidden in encoded:
        raise SystemExit(f"event metadata exposed forbidden value {forbidden}")
PY

bootstrap_response="$tmp_dir/bootstrap.json"
fetch_playback_bootstrap "$asset_id" "$bootstrap_response"
playback_url="$(playback_url_from_bootstrap "$bootstrap_response")"
expected_playback_prefix="$edge_base/v/$asset_id/hls/master.m3u8?token="
if [[ "$playback_url" != "$expected_playback_prefix"* ]]; then
  echo "expected signed HLS playback_url for asset $asset_id at the edge manifest path" >&2
  exit 1
fi

manifest_body="$tmp_dir/manifest.body"
status_code="$(curl -sS -o "$manifest_body" -w "%{http_code}" "$playback_url")"
if [[ "$status_code" != "200" ]]; then
  echo "edge manifest fetch expected HTTP 200, got $status_code" >&2
  cat "$manifest_body" >&2 || true
  exit 1
fi
if ! grep -q '#EXTM3U' "$manifest_body"; then
  echo "edge manifest response was not an HLS playlist" >&2
  exit 1
fi

echo "async media smoke passed for asset $asset_id"
