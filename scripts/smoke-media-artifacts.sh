#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
source "$root_dir/scripts/smoke-common.sh"

api_base="${REND_API_BASE_URL:-http://127.0.0.1:4000}"
fixture_path="${REND_SMOKE_FIXTURE:-$root_dir/fixtures/media/rend-fixture.mp4}"
response_file="$(mktemp)"
asset_response="$(mktemp)"
api_started=0
api_pid=""
worker_started=0
worker_pid=""

cleanup() {
  rm -f "$response_file" "$asset_response"
  stop_media_worker
  if [[ "$api_started" == "1" && -n "$api_pid" ]]; then
    kill "$api_pid" >/dev/null 2>&1 || true
    wait "$api_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "$1 is required for the media artifact smoke flow" >&2
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
export OBJECT_STORE_HEALTH_URL="${OBJECT_STORE_HEALTH_URL:-http://localhost:9100/minio/health/ready}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9100}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_BUCKET="${S3_BUCKET:-rend-local}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-rend_minio}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-rend_minio_password}"
export REND_API_BIND_ADDR="${REND_API_BIND_ADDR:-127.0.0.1:4000}"
export REND_API_AUTO_MIGRATE="${REND_API_AUTO_MIGRATE:-true}"
export REND_DEV_API_KEY="${REND_DEV_API_KEY:-dev-api-key}"
export REND_PLAYBACK_BASE_URL="${REND_PLAYBACK_BASE_URL:-http://127.0.0.1:4100}"
export REND_HTTP_TIMEOUT_SECS="${REND_HTTP_TIMEOUT_SECS:-120}"
export REND_MEDIA_PROCESS_TIMEOUT_SECS="${REND_MEDIA_PROCESS_TIMEOUT_SECS:-60}"
export REND_API_INLINE_MEDIA_PROCESSING="${REND_API_INLINE_MEDIA_PROCESSING:-false}"
export REND_MEDIA_JOB_MAX_ATTEMPTS="${REND_MEDIA_JOB_MAX_ATTEMPTS:-3}"
export REND_MEDIA_WORKER_POLL_INTERVAL_SECS="${REND_MEDIA_WORKER_POLL_INTERVAL_SECS:-1}"
export REND_MEDIA_JOB_LOCK_TIMEOUT_SECS="${REND_MEDIA_JOB_LOCK_TIMEOUT_SECS:-300}"
export REND_FFMPEG_PATH="${REND_FFMPEG_PATH:-ffmpeg}"
export REND_FFPROBE_PATH="${REND_FFPROBE_PATH:-ffprobe}"

docker compose up -d

for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U rend -d rend >/dev/null 2>&1 &&
    curl -fsS "$OBJECT_STORE_HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker compose exec -T postgres pg_isready -U rend -d rend >/dev/null
curl -fsS "$OBJECT_STORE_HEALTH_URL" >/dev/null

"$root_dir/scripts/generate-fixture-video.sh" "$fixture_path" >/dev/null

mkdir -p "$root_dir/.rend"
if ! curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-api >"$root_dir/.rend/rend-api-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null
start_media_worker "rend-api-media-worker-smoke"

status_code="$(
  curl -sS -o "$response_file" -w "%{http_code}" \
    -X POST "$api_base/v1/videos" \
    -H "authorization: Bearer $REND_DEV_API_KEY" \
    -H "content-type: video/mp4" \
    --data-binary @"$fixture_path"
)"

if [[ "$status_code" != "201" ]]; then
  echo "upload failed with HTTP $status_code" >&2
  cat "$response_file" >&2
  exit 1
fi

asset_id="$(
  assert_async_upload_response "$response_file"
)"

poll_asset_until_hls_ready "$asset_id" "$asset_response"

db_summary="$(
  docker compose exec -T postgres psql -U rend -d rend -t -A -F '|' -c "
    select a.source_state,
           a.playable_state,
           count(*) filter (where ar.kind = 'source') as source_count,
           count(*) filter (where ar.kind = 'opener') as opener_count,
           count(*) filter (where ar.kind = 'thumbnail') as thumbnail_count,
           count(*) filter (where ar.kind = 'manifest') as manifest_count,
           count(*) filter (where ar.kind = 'segment') as segment_count
    from rend.assets a
    left join rend.artifacts ar on ar.asset_id = a.id
    where a.id = '$asset_id'::uuid
    group by a.id, a.source_state, a.playable_state;
  "
)"

python3 - "$db_summary" <<'PY'
import sys
parts = sys.argv[1].strip().split("|")
if len(parts) != 7:
    raise SystemExit(f"unexpected DB summary: {sys.argv[1]!r}")
source_state, playable_state, source_count, opener_count, thumbnail_count, manifest_count, segment_count = parts
counts = {
    "source": int(source_count),
    "opener": int(opener_count),
    "thumbnail": int(thumbnail_count),
    "manifest": int(manifest_count),
    "segment": int(segment_count),
}
if source_state != "uploaded":
    raise SystemExit(f"expected DB source_state uploaded, got {source_state}")
if playable_state != "hls_ready":
    raise SystemExit(f"expected DB playable_state hls_ready, got {playable_state}")
for kind in ["source", "opener", "thumbnail", "manifest"]:
    if counts[kind] < 1:
        raise SystemExit(f"missing DB artifact row for {kind}")
if counts["segment"] < 1:
    raise SystemExit("missing DB artifact row for segment")
PY

artifact_objects="$(
  docker compose exec -T postgres psql -U rend -d rend -t -A -F '|' -c "
    select kind, object_key, byte_size
    from rend.artifacts
    where asset_id = '$asset_id'::uuid
      and kind in ('opener', 'thumbnail', 'manifest', 'segment')
    order by kind, object_key;
  "
)"

while IFS='|' read -r kind object_key db_byte_size; do
  if [[ -z "$kind" ]]; then
    continue
  fi
  if [[ -z "$object_key" || "$db_byte_size" -le 0 ]]; then
    echo "invalid DB artifact metadata for $kind: $object_key|$db_byte_size" >&2
    exit 1
  fi
  stat_json="$(
    docker compose run --rm -e OBJECT_KEY="$object_key" --entrypoint /bin/sh minio-init -c \
      'mc alias set local http://minio:9000 rend_minio rend_minio_password >/dev/null && mc stat --json "local/rend-local/$OBJECT_KEY"'
  )"
  actual_size="$(
    python3 -c 'import json,sys; print(json.load(sys.stdin)["size"])' <<<"$stat_json"
  )"
  if [[ "$actual_size" -le 0 ]]; then
    echo "MinIO object $object_key has zero bytes" >&2
    exit 1
  fi
done <<<"$artifact_objects"

echo "media artifact smoke passed for asset $asset_id"
