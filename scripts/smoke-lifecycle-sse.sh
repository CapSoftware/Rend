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
    echo "$1 is required for the lifecycle SSE smoke flow" >&2
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
  cargo run -p rend-api >"$root_dir/.rend/rend-api-lifecycle-sse-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-lifecycle-sse-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null

start_sequence="$(
  docker compose exec -T postgres psql -U rend -d rend -t -A -c \
    "select coalesce(max(sequence), 0) from rend.asset_events;"
)"

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-edge >"$root_dir/.rend/rend-edge-lifecycle-sse-smoke.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" && -n "$edge_pid" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-lifecycle-sse-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$edge_base/readyz" >/dev/null
start_media_worker "rend-api-media-worker-lifecycle-sse-smoke"

python3 - "$api_base" "$REND_DEV_API_KEY" "$fixture_path" "$start_sequence" <<'PY'
import json
import queue
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

api_base, api_key, fixture_path, start_sequence = sys.argv[1:5]


class SseClient:
    def __init__(self, url, headers):
        request = urllib.request.Request(url, headers=headers)
        self.response = urllib.request.urlopen(request, timeout=45)
        if self.response.status != 200:
            raise RuntimeError(f"SSE stream returned HTTP {self.response.status}")
        self.events = queue.Queue()
        self.error = None
        self.closed = False
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        event_id = None
        event_name = None
        data_lines = []
        try:
            while not self.closed:
                raw = self.response.readline()
                if raw == b"":
                    break
                line = raw.decode("utf-8").rstrip("\r\n")
                if line == "":
                    if data_lines:
                        self.events.put(
                            {
                                "id": event_id,
                                "event": event_name or "message",
                                "data": "\n".join(data_lines),
                            }
                        )
                    event_id = None
                    event_name = None
                    data_lines = []
                    continue
                if line.startswith(":"):
                    continue
                field, _, value = line.partition(":")
                if value.startswith(" "):
                    value = value[1:]
                if field == "id":
                    event_id = value
                elif field == "event":
                    event_name = value
                elif field == "data":
                    data_lines.append(value)
        except Exception as exc:
            if not self.closed:
                self.error = exc

    def next_event(self, timeout=1):
        try:
            return self.events.get(timeout=timeout)
        except queue.Empty:
            if self.error is not None:
                raise RuntimeError(f"SSE reader failed: {self.error}") from self.error
            return None

    def close(self):
        self.closed = True
        self.response.close()


def upload_fixture():
    with open(fixture_path, "rb") as handle:
        body = handle.read()
    request = urllib.request.Request(
        f"{api_base}/v1/videos",
        data=body,
        method="POST",
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "video/mp4",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            status = response.status
            payload = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"upload failed with HTTP {exc.code}: {exc.read().decode('utf-8')}")
    if status != 201:
        raise SystemExit(f"upload failed with HTTP {status}: {payload}")
    data = json.loads(payload)
    required = [
        "asset_id",
        "source_state",
        "playable_state",
        "source_artifact_id",
        "source_object_key",
        "byte_size",
    ]
    missing = [key for key in required if key not in data]
    if missing:
        raise SystemExit(f"upload response missing fields: {', '.join(missing)}")
    if data["source_state"] != "uploaded":
        raise SystemExit(f"expected upload source_state uploaded, got {data['source_state']}")
    if data["playable_state"] != "not_playable":
        raise SystemExit(
            f"expected upload playable_state not_playable, got {data['playable_state']}"
        )
    if "playback_url" in data:
        raise SystemExit("upload response must not include playback_url before media processing")
    if int(data["byte_size"]) <= 0:
        raise SystemExit("expected uploaded byte_size to be nonzero")
    return data["asset_id"]


def decode_event(raw):
    payload = json.loads(raw["data"])
    for key in ["id", "asset_id", "sequence", "event_type", "created_at", "metadata"]:
        if key not in payload:
            raise SystemExit(f"SSE payload missing {key}: {payload}")
    if str(payload["sequence"]) != raw["id"]:
        raise SystemExit(f"SSE id did not match durable sequence: {raw}")
    if payload["event_type"] != raw["event"]:
        raise SystemExit(f"SSE event name did not match payload event_type: {raw}")
    if not isinstance(payload["metadata"], dict):
        raise SystemExit(f"SSE metadata is not an object: {payload}")
    encoded = json.dumps(payload, sort_keys=True).lower()
    for forbidden in ["?token=", "bearer ", "secret", "credential", "authorization", "playback_url"]:
        if forbidden in encoded:
            raise SystemExit(f"SSE payload exposed forbidden value {forbidden}: {payload}")
    return payload


def wait_for_lifecycle_events(client, asset_id):
    deadline = time.monotonic() + 240
    asset_events = []
    seen_sequences = set()
    playable_state = None
    warm_result_seen = False
    failed = False

    while time.monotonic() < deadline:
        raw = client.next_event(timeout=1)
        if raw is None:
            continue
        event = decode_event(raw)
        if event["asset_id"] != asset_id:
            continue
        sequence = int(event["sequence"])
        if sequence in seen_sequences:
            raise SystemExit(f"duplicate SSE sequence received: {sequence}")
        if asset_events and sequence <= int(asset_events[-1]["sequence"]):
            raise SystemExit(
                f"SSE sequences were not strictly increasing: "
                f"{[item['sequence'] for item in asset_events]} then {sequence}"
            )
        seen_sequences.add(sequence)
        asset_events.append(event)

        event_type = event["event_type"]
        metadata = event["metadata"]
        if event_type == "playable_state.changed":
            playable_state = metadata.get("current")
            if playable_state == "failed":
                failed = True
        if event_type == "media.processing_failed" and metadata.get("final") is True:
            failed = True
        if event_type in {"edge.warming_succeeded", "edge.warming_failed"}:
            warm_result_seen = True
        if failed:
            break
        if playable_state in {"hls_ready", "opener_ready"} and warm_result_seen:
            return asset_events

    types = [event["event_type"] for event in asset_events]
    raise SystemExit(f"timed out waiting for lifecycle SSE completion for {asset_id}: {types}")


def verify_required_events(asset_events):
    types = [event["event_type"] for event in asset_events]
    required = [
        "asset.created",
        "source.upload_started",
        "source.uploaded",
        "media.processing_queued",
        "upload.response_ready",
        "media.processing_started",
        "artifact.generated",
        "playable_state.changed",
        "edge.warming_attempted",
    ]
    for event_type in required:
        if event_type not in types:
            raise SystemExit(f"missing lifecycle SSE event {event_type}: {types}")
    if not ({"edge.warming_succeeded", "edge.warming_failed"} & set(types)):
        raise SystemExit(f"missing lifecycle SSE edge warming result: {types}")
    if not any(
        event["event_type"] == "playable_state.changed"
        and event["metadata"].get("current") in {"hls_ready", "opener_ready"}
        for event in asset_events
    ):
        raise SystemExit(f"asset did not become playable through SSE: {types}")


def verify_replay(asset_id, asset_events):
    if len(asset_events) < 3:
        raise SystemExit("not enough lifecycle events to verify replay cursor")
    cursor = int(asset_events[1]["sequence"])
    expected = [event for event in asset_events if int(event["sequence"]) > cursor]
    query = urllib.parse.urlencode({"asset_id": asset_id, "after_sequence": "0"})
    client = SseClient(
        f"{api_base}/v1/events?{query}",
        {
            "authorization": f"Bearer {api_key}",
            "accept": "text/event-stream",
            "last-event-id": str(cursor),
        },
    )
    replayed = []
    deadline = time.monotonic() + 30
    try:
        while len(replayed) < len(expected) and time.monotonic() < deadline:
            raw = client.next_event(timeout=1)
            if raw is None:
                continue
            event = decode_event(raw)
            if event["asset_id"] == asset_id:
                replayed.append(event)
    finally:
        client.close()

    if len(replayed) < len(expected):
        raise SystemExit(
            f"replay returned {len(replayed)} events, expected {len(expected)} after cursor {cursor}"
        )
    replay_sequences = [int(event["sequence"]) for event in replayed]
    expected_sequences = [int(event["sequence"]) for event in expected]
    if replay_sequences[: len(expected_sequences)] != expected_sequences:
        raise SystemExit(
            f"replay did not resume after cursor {cursor}: "
            f"got {replay_sequences}, expected {expected_sequences}"
        )
    if any(sequence <= cursor for sequence in replay_sequences):
        raise SystemExit(f"replay returned stale sequence at or before {cursor}: {replay_sequences}")


stream_url = f"{api_base}/v1/events?{urllib.parse.urlencode({'after_sequence': start_sequence})}"
client = SseClient(
    stream_url,
    {
        "authorization": f"Bearer {api_key}",
        "accept": "text/event-stream",
    },
)

try:
    time.sleep(0.2)
    asset_id = upload_fixture()
    asset_events = wait_for_lifecycle_events(client, asset_id)
finally:
    client.close()

verify_required_events(asset_events)
verify_replay(asset_id, asset_events)
print(f"lifecycle SSE smoke passed for asset {asset_id}")
PY
