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
    echo "$1 is required for the asset events smoke flow" >&2
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
  cargo run -p rend-api >"$root_dir/.rend/rend-api-asset-events-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-asset-events-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-edge >"$root_dir/.rend/rend-edge-asset-events-smoke.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-asset-events-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$edge_base/readyz" >/dev/null
start_media_worker "rend-api-media-worker-asset-events-smoke"

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

expect_http() {
  local label="$1"
  local expected="$2"
  local url="$3"
  shift 3
  local body_file="$tmp_dir/$label.body"
  local http_code
  http_code="$(curl -sS -o "$body_file" -w "%{http_code}" "$@" "$url")"
  if [[ "$http_code" != "$expected" ]]; then
    echo "$label expected HTTP $expected, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi
}

expect_http "unauthenticated-asset" "401" "$api_base/v1/assets/$asset_id"
expect_http "unauthenticated-events" "401" "$api_base/v1/assets/$asset_id/events"
expect_http "unknown-asset" "404" \
  "$api_base/v1/assets/00000000-0000-0000-0000-000000000000" \
  -H "authorization: Bearer $REND_DEV_API_KEY"
expect_http "unknown-events" "404" \
  "$api_base/v1/assets/00000000-0000-0000-0000-000000000000/events" \
  -H "authorization: Bearer $REND_DEV_API_KEY"

asset_response="$tmp_dir/asset.json"
poll_asset_until_hls_ready "$asset_id" "$asset_response"

status_code="$(
  curl -sS -o "$asset_response" -w "%{http_code}" \
    "$api_base/v1/assets/$asset_id" \
    -H "authorization: Bearer $REND_DEV_API_KEY"
)"

if [[ "$status_code" != "200" ]]; then
  echo "asset current-state request failed with HTTP $status_code" >&2
  cat "$asset_response" >&2
  exit 1
fi

python3 - "$asset_response" "$asset_id" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
asset_id = sys.argv[2]
required = ["asset_id", "source_state", "playable_state", "created_at", "updated_at", "artifacts"]
missing = [key for key in required if key not in response]
if missing:
    raise SystemExit(f"asset response missing fields: {', '.join(missing)}")
if response["asset_id"] != asset_id:
    raise SystemExit(f"asset_id mismatch: {response['asset_id']}")
if response["source_state"] != "uploaded":
    raise SystemExit(f"expected source_state uploaded, got {response['source_state']}")
if response["playable_state"] != "hls_ready":
    raise SystemExit(f"expected playable_state hls_ready, got {response['playable_state']}")
if "playback_url" in response or "playback_token" in response:
    raise SystemExit("current-state response must not include signed playback fields")

artifacts = response["artifacts"]
if not isinstance(artifacts, list) or not artifacts:
    raise SystemExit("asset response had no artifact summary")
for artifact in artifacts:
    for key in ["kind", "content_type", "byte_size"]:
        if key not in artifact:
            raise SystemExit(f"artifact missing {key}: {artifact}")
    if artifact["byte_size"] is not None and int(artifact["byte_size"]) <= 0:
        raise SystemExit(f"artifact byte_size must be positive: {artifact}")

counts = {}
for artifact in artifacts:
    counts[artifact["kind"]] = counts.get(artifact["kind"], 0) + 1
for kind in ["source", "opener", "thumbnail", "manifest", "segment"]:
    if counts.get(kind, 0) < 1:
        raise SystemExit(f"missing artifact summary for {kind}")
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

cursor_file="$tmp_dir/after-sequence.txt"
python3 - "$events_response" "$asset_id" >"$cursor_file" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
asset_id = sys.argv[2]
if response.get("asset_id") != asset_id:
    raise SystemExit(f"events asset_id mismatch: {response.get('asset_id')}")
events = response.get("events")
if not isinstance(events, list) or not events:
    raise SystemExit("events response had no events")

sequences = [event.get("sequence") for event in events]
if sequences != sorted(sequences):
    raise SystemExit(f"events were not ordered by sequence: {sequences}")
if len(sequences) != len(set(sequences)):
    raise SystemExit("event sequences were not unique")
for event in events:
    for key in ["id", "asset_id", "sequence", "event_type", "created_at", "metadata"]:
        if key not in event:
            raise SystemExit(f"event missing {key}: {event}")
    if event["asset_id"] != asset_id:
        raise SystemExit(f"event asset_id mismatch: {event}")
    if not isinstance(event["metadata"], dict):
        raise SystemExit(f"event metadata is not an object: {event}")
    encoded = json.dumps(event["metadata"]).lower()
    for forbidden in ["?token=", "bearer ", "secret", "credential", "authorization", "playback_url"]:
        if forbidden in encoded:
            raise SystemExit(f"event metadata exposed forbidden value {forbidden}: {event}")

types = [event["event_type"] for event in events]
def first(name):
    try:
        return types.index(name)
    except ValueError:
        raise SystemExit(f"missing event type: {name}")

asset_created = first("asset.created")
source_started = first("source.upload_started")
source_uploaded = first("source.uploaded")
media_queued = first("media.processing_queued")
response_ready = first("upload.response_ready")
media_started = first("media.processing_started")
artifact_indexes = [idx for idx, name in enumerate(types) if name == "artifact.generated"]
if not artifact_indexes:
    raise SystemExit("missing artifact.generated event")
state_changed = first("playable_state.changed")
warm_attempted = first("edge.warming_attempted")
warm_results = [idx for idx, name in enumerate(types) if name in {"edge.warming_succeeded", "edge.warming_failed"}]
if not warm_results:
    raise SystemExit("missing edge warming result event")

ordered = [
    asset_created,
    source_started,
    source_uploaded,
    media_queued,
    response_ready,
    media_started,
    min(artifact_indexes),
    state_changed,
    warm_attempted,
    min(warm_results),
]
if ordered != sorted(ordered):
    raise SystemExit(f"lifecycle events were out of expected order: {types}")

response_ready_event = events[response_ready]
if response_ready_event["metadata"].get("playable_state") != "not_playable":
    raise SystemExit(f"upload.response_ready should describe the initial async state: {response_ready_event}")

segment_events = [
    event for event in events
    if event["event_type"] == "artifact.generated" and event["metadata"].get("kind") == "segment"
]
if not segment_events:
    raise SystemExit("missing bounded segment artifact event")
segment_metadata = segment_events[0]["metadata"]
if int(segment_metadata.get("count", 0)) < 1:
    raise SystemExit(f"invalid segment aggregate metadata: {segment_metadata}")

print(sequences[1] if len(sequences) > 1 else sequences[0])
PY
after_sequence="$(cat "$cursor_file")"

events_after_response="$tmp_dir/events-after.json"
status_code="$(
  curl -sS -o "$events_after_response" -w "%{http_code}" \
    "$api_base/v1/assets/$asset_id/events?after_sequence=$after_sequence&limit=3" \
    -H "authorization: Bearer $REND_DEV_API_KEY"
)"

if [[ "$status_code" != "200" ]]; then
  echo "asset events after_sequence request failed with HTTP $status_code" >&2
  cat "$events_after_response" >&2
  exit 1
fi

python3 - "$events_after_response" "$after_sequence" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
after_sequence = int(sys.argv[2])
events = response.get("events", [])
if len(events) > 3:
    raise SystemExit(f"expected limit=3 to cap events, got {len(events)}")
if not events:
    raise SystemExit("expected after_sequence request to return later events")
for event in events:
    if int(event["sequence"]) <= after_sequence:
        raise SystemExit(f"after_sequence returned stale event: {event}")
PY

echo "asset events smoke passed for asset $asset_id"
