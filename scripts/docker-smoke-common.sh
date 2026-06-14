#!/usr/bin/env bash

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "$1 is required for Docker smoke tests" >&2
    exit 1
  }
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local attempts="${3:-180}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "timed out waiting for $label at $url" >&2
  docker compose ps >&2 || true
  return 1
}

wait_for_default_stack() {
  wait_for_http "rend-api" "$api_base/readyz"
  wait_for_http "rend-edge" "$edge_base/readyz"

  for _ in $(seq 1 120); do
    if docker compose exec -T postgres pg_isready -U rend -d rend >/dev/null 2>&1 &&
      docker compose exec -T redis redis-cli ping >/dev/null 2>&1 &&
      docker compose exec -T clickhouse clickhouse-client --user "$clickhouse_user" --password "$clickhouse_password" --query "SELECT 1" >/dev/null 2>&1 &&
      curl -fsS "$minio_health_url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "timed out waiting for Docker dependency readiness" >&2
  docker compose ps >&2 || true
  return 1
}

ensure_fixture() {
  local fixture_path="$1"
  if [[ -s "$fixture_path" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$fixture_path")"
  docker compose run --rm --no-deps --entrypoint ffmpeg rend-media-worker \
    -hide_banner -loglevel error -y \
    -f lavfi -i testsrc=size=1280x720:rate=30 \
    -f lavfi -i sine=frequency=1000:sample_rate=48000 \
    -t 2 \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
    -c:a aac -shortest \
    -movflags frag_keyframe+empty_moov+default_base_moof \
    -f mp4 pipe:1 >"$fixture_path"
}

upload_fixture() {
  local fixture_path="$1"
  local response_file="$2"
  local status_code

  status_code="$(
    curl -sS -o "$response_file" -w "%{http_code}" \
      -X POST "$api_base/v1/videos" \
      -H "authorization: Bearer $dev_api_key" \
      -H "content-type: video/mp4" \
      --data-binary @"$fixture_path"
  )"

  if [[ "$status_code" != "201" ]]; then
    echo "upload failed with HTTP $status_code" >&2
    cat "$response_file" >&2 || true
    exit 1
  fi

  python3 - "$response_file" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
required = ["asset_id", "source_state", "playable_state", "source_artifact_id", "source_object_key", "byte_size"]
missing = [key for key in required if key not in response]
if missing:
    raise SystemExit(f"upload response missing fields: {', '.join(missing)}")
if response["source_state"] != "uploaded":
    raise SystemExit(f"expected source_state uploaded, got {response['source_state']}")
if response["playable_state"] != "not_playable":
    raise SystemExit(f"expected playable_state not_playable, got {response['playable_state']}")
if int(response["byte_size"]) <= 0:
    raise SystemExit("expected uploaded byte_size to be nonzero")
print(response["asset_id"])
PY
}

poll_asset_until_hls_ready() {
  local asset_id="$1"
  local response_file="$2"

  for _ in $(seq 1 240); do
    local status_code
    status_code="$(
      curl -sS -o "$response_file" -w "%{http_code}" \
        "$api_base/v1/assets/$asset_id" \
        -H "authorization: Bearer $dev_api_key"
    )"
    if [[ "$status_code" == "200" ]]; then
      local state
      state="$(
        python3 - "$response_file" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    print(json.load(f).get("playable_state", ""))
PY
      )"
      case "$state" in
        hls_ready)
          return 0
          ;;
        failed)
          echo "media worker marked asset failed" >&2
          cat "$response_file" >&2 || true
          exit 1
          ;;
      esac
    fi
    sleep 1
  done

  echo "timed out waiting for asset $asset_id to become hls_ready" >&2
  cat "$response_file" >&2 || true
  exit 1
}

fetch_playback_bootstrap() {
  local asset_id="$1"
  local response_file="$2"
  local status_code

  status_code="$(
    curl -sS -c "$(playback_cookie_jar)" -o "$response_file" -w "%{http_code}" \
      "$api_base/v1/assets/$asset_id/playback" \
      -H "authorization: Bearer $dev_api_key"
  )"

  if [[ "$status_code" != "200" ]]; then
    echo "bootstrap failed with HTTP $status_code" >&2
    cat "$response_file" >&2 || true
    exit 1
  fi

  python3 - "$response_file" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
if response.get("playable_state") != "hls_ready":
    raise SystemExit(f"expected hls_ready bootstrap, got {response.get('playable_state')}")
for key in ["playback_url", "manifest_url", "opener_url"]:
    if not response.get(key):
        raise SystemExit(f"bootstrap response missing {key}")
if not response.get("prefetch_hints"):
    raise SystemExit("bootstrap response missing prefetch_hints")
PY
}

playback_cookie_jar() {
  printf '%s\n' "${REND_PLAYBACK_COOKIE_JAR:-$tmp_dir/playback.cookies}"
}

playback_url_from_bootstrap() {
  python3 - "$1" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    print(json.load(f)["playback_url"])
PY
}

warm_payload() {
  local asset_id="$1"
  shift
  python3 - "$asset_id" "$@" <<'PY'
import json, sys
print(json.dumps({"asset_id": sys.argv[1], "artifact_paths": sys.argv[2:]}))
PY
}

purge_edge_artifacts() {
  local base_url="$1"
  local asset_id="$2"
  shift 2
  local payload body_file http_code
  payload="$(warm_payload "$asset_id" "$@")"
  body_file="$tmp_dir/purge-$(basename "$base_url").json"
  http_code="$(
    curl -sS -o "$body_file" -w "%{http_code}" \
      -X POST "$base_url/internal/purge" \
      -H "x-rend-internal-token: $edge_internal_token" \
      -H "content-type: application/json" \
      --data "$payload"
  )"
  if [[ "$http_code" != "200" ]]; then
    echo "edge purge at $base_url expected HTTP 200, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi
}

warm_edge_artifacts() {
  local base_url="$1"
  local asset_id="$2"
  shift 2
  local label payload body_file http_code
  label="$(basename "$base_url")"
  payload="$(warm_payload "$asset_id" "$@")"
  body_file="$tmp_dir/warm-$label.json"
  http_code="$(
    curl -sS -o "$body_file" -w "%{http_code}" \
      -X POST "$base_url/internal/warm" \
      -H "x-rend-internal-token: $edge_internal_token" \
      -H "content-type: application/json" \
      --data "$payload"
  )"
  if [[ "$http_code" != "200" ]]; then
    echo "edge warm at $base_url expected HTTP 200, got $http_code" >&2
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
bad = [r for r in results if r.get("status") not in {"warmed", "already_warm"}]
if bad:
    raise SystemExit(f"warm response had bad entries: {bad}")
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
        if key.strip().lower() == name:
            print(value.strip())
            raise SystemExit(0)
raise SystemExit(1)
PY
}

fetch_and_expect_cache() {
  local label="$1"
  local url="$2"
  local expected_cache="$3"
  local body_file="$4"
  local headers_file="$tmp_dir/$label.headers"
  local status_code

  status_code="$(curl -sS -b "$(playback_cookie_jar)" -D "$headers_file" -o "$body_file" -w "%{http_code}" "$url")"
  if [[ "$status_code" != "200" ]]; then
    echo "$label playback fetch expected HTTP 200, got $status_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi

  local cache_header
  cache_header="$(header_value "$headers_file" "x-rend-cache")"
  if [[ "$cache_header" != "$expected_cache" ]]; then
    echo "$label expected X-Rend-Cache $expected_cache, got $cache_header" >&2
    exit 1
  fi

  if [[ ! -s "$body_file" ]]; then
    echo "$label expected nonempty playback body" >&2
    exit 1
  fi
}

wait_for_asset_event() {
  local asset_id="$1"
  local event_type="$2"
  local response_file="$tmp_dir/events-$event_type.json"

  for _ in $(seq 1 90); do
    local status_code
    status_code="$(
      curl -sS -o "$response_file" -w "%{http_code}" \
        "$api_base/v1/assets/$asset_id/events?limit=100" \
        -H "authorization: Bearer $dev_api_key"
    )"
    if [[ "$status_code" == "200" ]] &&
      python3 - "$response_file" "$event_type" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
wanted = sys.argv[2]
raise SystemExit(0 if any(event.get("event_type") == wanted for event in response.get("events", [])) else 1)
PY
    then
      return 0
    fi
    sleep 1
  done

  echo "timed out waiting for asset event $event_type for $asset_id" >&2
  cat "$response_file" >&2 || true
  exit 1
}

wait_for_playback_analytics() {
  local asset_id="$1"
  local min_miss="$2"
  local min_hit="$3"
  local response_file="$tmp_dir/analytics.json"

  for _ in $(seq 1 120); do
    local status_code
    status_code="$(
      curl -sS -o "$response_file" -w "%{http_code}" \
        "$api_base/v1/assets/$asset_id/analytics/playback?window_seconds=3600" \
        -H "authorization: Bearer $dev_api_key"
    )"
    if [[ "$status_code" == "200" ]] &&
      python3 - "$response_file" "$min_miss" "$min_hit" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
min_miss = int(sys.argv[2])
min_hit = int(sys.argv[3])
cache = data.get("cache_status_counts", {})
statuses = data.get("status_code_counts", {})
ok = (
    int(data.get("request_count", 0)) >= min_miss + min_hit
    and int(data.get("bytes_served", 0)) > 0
    and int(cache.get("MISS", 0)) >= min_miss
    and int(cache.get("HIT", 0)) >= min_hit
    and int(statuses.get("200", 0)) >= min_miss + min_hit
    and data.get("first_seen")
    and data.get("last_seen")
)
raise SystemExit(0 if ok else 1)
PY
    then
      return 0
    fi
    sleep 1
  done

  echo "timed out waiting for playback telemetry analytics for $asset_id" >&2
  cat "$response_file" >&2 || true
  exit 1
}
