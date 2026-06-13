#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

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

cleanup() {
  rm -rf "$tmp_dir"
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
    echo "$1 is required for the playback bootstrap smoke flow" >&2
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
  cargo run -p rend-api >"$root_dir/.rend/rend-api-playback-bootstrap-smoke.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-playback-bootstrap-smoke.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "$api_base/readyz" >/dev/null

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  cargo run -p rend-edge >"$root_dir/.rend/rend-edge-playback-bootstrap-smoke.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-playback-bootstrap-smoke.log" >&2
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

asset_id="$(
  python3 - "$upload_response" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
required = ["asset_id", "playable_state"]
missing = [key for key in required if key not in response]
if missing:
    raise SystemExit(f"upload response missing fields: {', '.join(missing)}")
if response["playable_state"] != "hls_ready":
    raise SystemExit(f"expected upload playable_state hls_ready, got {response['playable_state']}")
print(response["asset_id"])
PY
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

expect_http "unauthenticated-bootstrap" "401" "$api_base/v1/assets/$asset_id/playback"
expect_http "unknown-asset-bootstrap" "404" \
  "$api_base/v1/assets/00000000-0000-0000-0000-000000000000/playback" \
  -H "authorization: Bearer $REND_DEV_API_KEY"

bootstrap_response="$tmp_dir/bootstrap.json"
status_code="$(
  curl -sS -o "$bootstrap_response" -w "%{http_code}" \
    "$api_base/v1/assets/$asset_id/playback" \
    -H "authorization: Bearer $REND_DEV_API_KEY"
)"

if [[ "$status_code" != "200" ]]; then
  echo "bootstrap failed with HTTP $status_code" >&2
  cat "$bootstrap_response" >&2
  exit 1
fi

artifact_list="$tmp_dir/bootstrap-artifacts.tsv"
python3 - "$bootstrap_response" "$edge_base" "$asset_id" "$REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS" >"$artifact_list" <<'PY'
import json, sys

path, edge_base, asset_id, cap = sys.argv[1], sys.argv[2].rstrip("/"), sys.argv[3], int(sys.argv[4])
with open(path, "r", encoding="utf-8") as f:
    response = json.load(f)

required = [
    "asset_id",
    "source_state",
    "playable_state",
    "playback_url",
    "playback_content_type",
    "playback_token_expires_at",
    "ttl_seconds",
    "opener_url",
    "opener_content_type",
    "manifest_url",
    "manifest_content_type",
    "prefetch_hints",
]
missing = [key for key in required if key not in response]
if missing:
    raise SystemExit(f"bootstrap response missing fields: {', '.join(missing)}")
if response["asset_id"] != asset_id:
    raise SystemExit(f"bootstrap asset_id mismatch: {response['asset_id']}")
if response["source_state"] != "uploaded":
    raise SystemExit(f"expected source_state uploaded, got {response['source_state']}")
if response["playable_state"] != "hls_ready":
    raise SystemExit(f"expected playable_state hls_ready, got {response['playable_state']}")
if response["ttl_seconds"] <= 0 or response["playback_token_expires_at"] <= 0:
    raise SystemExit("expected positive playback token ttl and expiry")

expected_manifest_prefix = f"{edge_base}/v/{asset_id}/hls/master.m3u8?token="
if not response["playback_url"].startswith(expected_manifest_prefix):
    raise SystemExit("playback_url did not use the signed rend-edge manifest shape")
if response["manifest_url"] != response["playback_url"]:
    raise SystemExit("expected primary playback_url to match manifest_url for hls_ready asset")
if response["playback_content_type"] != "application/vnd.apple.mpegurl":
    raise SystemExit(f"unexpected playback content type {response['playback_content_type']}")
if response["manifest_content_type"] != "application/vnd.apple.mpegurl":
    raise SystemExit(f"unexpected manifest content type {response['manifest_content_type']}")
if not response["opener_url"].startswith(f"{edge_base}/v/{asset_id}/opener.mp4?token="):
    raise SystemExit("opener_url did not use the signed rend-edge opener shape")
if response["opener_content_type"] != "video/mp4":
    raise SystemExit(f"unexpected opener content type {response['opener_content_type']}")

hints = response["prefetch_hints"]
if not hints:
    raise SystemExit("expected at least one first segment prefetch hint")
if len(hints) > cap:
    raise SystemExit(f"expected at most {cap} prefetch hints, got {len(hints)}")
for hint in hints:
    for key in ["artifact_path", "url", "content_type"]:
        if key not in hint:
            raise SystemExit(f"prefetch hint missing {key}: {hint}")
    if not hint["artifact_path"].startswith("hls/segment_") or not hint["artifact_path"].endswith(".ts"):
        raise SystemExit(f"unexpected prefetch artifact path: {hint['artifact_path']}")
    expected_prefix = f"{edge_base}/v/{asset_id}/{hint['artifact_path']}?token="
    if not hint["url"].startswith(expected_prefix):
        raise SystemExit(f"prefetch hint did not use signed rend-edge shape: {hint['url']}")
    if hint["content_type"] != "video/mp2t":
        raise SystemExit(f"unexpected prefetch content type: {hint['content_type']}")

def emit(label, url, content_type):
    print(f"{label}\t{url}\t{content_type}")

emit("primary", response["playback_url"], response["playback_content_type"])
emit("manifest", response["manifest_url"], response["manifest_content_type"])
emit("opener", response["opener_url"], response["opener_content_type"])
for hint in hints:
    emit(hint["artifact_path"], hint["url"], hint["content_type"])
PY

playback_url="$(
  python3 - "$bootstrap_response" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    print(json.load(f)["playback_url"])
PY
)"

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

fetch_artifact() {
  local label="$1"
  local url="$2"
  local expected_content_type="$3"
  local safe_label="${label//[^A-Za-z0-9_.-]/_}"
  local headers_file="$tmp_dir/$safe_label.headers"
  local body_file="$tmp_dir/$safe_label.body"

  local http_code
  http_code="$(curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" "$url")"
  if [[ "$http_code" != "200" ]]; then
    echo "$label fetch expected HTTP 200, got $http_code" >&2
    cat "$body_file" >&2 || true
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

while IFS=$'\t' read -r label url content_type; do
  if [[ -z "$label" ]]; then
    continue
  fi
  fetch_artifact "$label" "$url" "$content_type"
done <"$artifact_list"

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

unsigned_playback_url="${playback_url%%\?token=*}"
tampered_token="$(tamper_token "$token")"
tampered_playback_url="${playback_url//$token/$tampered_token}"

expect_rejected "missing-token" "$unsigned_playback_url"
expect_rejected "tampered-token" "$tampered_playback_url"
expect_rejected "wrong-asset-token" \
  "$edge_base/v/00000000-0000-0000-0000-000000000000/hls/master.m3u8?token=$token"

player_html="$tmp_dir/player.html"
curl -fsS "$api_base/player?asset_id=$asset_id" -o "$player_html"
if ! grep -q "<title>Rend local playback</title>" "$player_html"; then
  echo "player harness did not render expected HTML" >&2
  exit 1
fi

echo "playback bootstrap smoke passed for asset $asset_id"
