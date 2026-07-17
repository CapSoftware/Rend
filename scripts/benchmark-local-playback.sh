#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
source "$root_dir/scripts/smoke-common.sh"

api_base="${REND_API_BASE_URL:-http://127.0.0.1:4000}"
edge_base="${REND_EDGE_BASE_URL:-http://127.0.0.1:4100}"
api_base="${api_base%/}"
edge_base="${edge_base%/}"

run_id="$(date -u +%Y%m%dT%H%M%SZ)"
started_at_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
output_path="${REND_BENCHMARK_OUTPUT:-$root_dir/.rend/benchmarks/playback-edge-local-$run_id.json}"
fixture_names="${REND_BENCHMARK_FIXTURES:-small,medium}"
poll_interval="${REND_BENCHMARK_POLL_INTERVAL_SECS:-0.2}"
poll_timeout_secs="${REND_BENCHMARK_TIMEOUT_SECS:-180}"
curl_max_time_secs="${REND_BENCHMARK_CURL_MAX_TIME_SECS:-120}"
coalescing_concurrency="${REND_BENCHMARK_COALESCING_CONCURRENCY:-24}"
coalescing_attempts="${REND_BENCHMARK_COALESCING_ATTEMPTS:-5}"

tmp_dir="$(mktemp -d)"
metrics_file="$tmp_dir/metrics.ndjson"
fixtures_file="$tmp_dir/fixtures.ndjson"
warnings_file="$tmp_dir/warnings.ndjson"
api_started=0
api_pid=""
edge_started=0
edge_pid=""
worker_started=0
worker_pid=""

: >"$metrics_file"
: >"$fixtures_file"
: >"$warnings_file"

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
    echo "$1 is required for the local playback benchmark" >&2
    exit 1
  }
}

now_ms() {
  python3 - <<'PY'
import time
print(time.time_ns() // 1_000_000)
PY
}

seconds_to_ms() {
  python3 - "$1" <<'PY'
import sys
print(f"{float(sys.argv[1]) * 1000:.3f}")
PY
}

timing_value() {
  python3 - "$1" "$2" <<'PY'
import sys
path, name = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    for line in f:
        if "=" not in line:
            continue
        key, value = line.rstrip("\n").split("=", 1)
        if key == name:
            print(value)
            raise SystemExit(0)
raise SystemExit(f"missing curl timing value {name} in {path}")
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

record_warning() {
  local fixture="$1"
  local message="$2"
  python3 - "$warnings_file" "$fixture" "$message" <<'PY'
import json, sys
path, fixture, message = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps({"fixture": fixture, "message": message}, sort_keys=True) + "\n")
PY
}

record_metric() {
  local fixture="$1"
  local name="$2"
  local value_ms="$3"
  local artifact="$4"
  local cache_status="$5"
  local note="$6"
  local extra_json="${7:-}"
  if [[ -z "$extra_json" ]]; then
    extra_json="{}"
  fi

  python3 - "$metrics_file" "$fixture" "$name" "$value_ms" "$artifact" "$cache_status" "$note" "$extra_json" <<'PY'
import json, sys

path, fixture, name, value, artifact, cache_status, note, extra_json = sys.argv[1:]
value_ms = None if value in {"", "null", "None", "nan", "n/a"} else round(float(value), 3)
extra = json.loads(extra_json) if extra_json else {}
metric = {
    "fixture": fixture,
    "name": name,
    "unit": "ms",
    "value_ms": value_ms,
}
if artifact:
    metric["artifact"] = artifact
if cache_status:
    metric["cache_status"] = cache_status
if note:
    metric["note"] = note
metric.update(extra)
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps(metric, sort_keys=True) + "\n")
PY
}

curl_timing_format=$'http_code=%{http_code}\ntime_connect=%{time_connect}\ntime_starttransfer=%{time_starttransfer}\ntime_total=%{time_total}\nsize_download=%{size_download}\nsize_upload=%{size_upload}\n'

fetch_timed() {
  local url="$1"
  local headers_file="$2"
  local body_file="$3"
  local timing_file="$4"

  curl -sS --max-time "$curl_max_time_secs" \
    -b "$(playback_cookie_jar)" \
    -D "$headers_file" \
    -o "$body_file" \
    -w "$curl_timing_format" \
    "$url" >"$timing_file"
}

post_upload_timed() {
  local fixture_path="$1"
  local response_file="$2"
  local timing_file="$3"

  curl -sS --max-time "$curl_max_time_secs" \
    -o "$response_file" \
    -w "$curl_timing_format" \
    -X POST "$api_base/v1/videos" \
    -H "authorization: Bearer $REND_DEV_API_KEY" \
    -H "content-type: video/mp4" \
    --data-binary @"$fixture_path" >"$timing_file"
}

purge_artifacts() {
  local asset_id="$1"
  shift
  local body_file="$tmp_dir/purge-$asset_id.json"
  local payload
  payload="$(
    python3 - "$asset_id" "$@" <<'PY'
import json, sys
print(json.dumps({"asset_id": sys.argv[1], "artifact_paths": sys.argv[2:]}))
PY
  )"

  local http_code
  http_code="$(
    curl -sS --max-time "$curl_max_time_secs" \
      -o "$body_file" \
      -w "%{http_code}" \
      -X POST "$edge_base/internal/purge" \
      -H "x-rend-internal-token: $REND_EDGE_INTERNAL_TOKEN" \
      -H "content-type: application/json" \
      --data "$payload"
  )"
  if [[ "$http_code" != "200" ]]; then
    echo "edge purge expected HTTP 200, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi
}

warm_artifacts() {
  local asset_id="$1"
  shift
  local body_file="$tmp_dir/warm-$asset_id.json"
  local payload
  payload="$(
    python3 - "$asset_id" "$@" <<'PY'
import json, sys
print(json.dumps({"asset_id": sys.argv[1], "artifact_paths": sys.argv[2:]}))
PY
  )"

  local http_code
  http_code="$(
    curl -sS --max-time "$curl_max_time_secs" \
      -o "$body_file" \
      -w "%{http_code}" \
      -X POST "$edge_base/internal/warm" \
      -H "x-rend-internal-token: $REND_EDGE_INTERNAL_TOKEN" \
      -H "content-type: application/json" \
      --data "$payload"
  )"
  if [[ "$http_code" != "200" ]]; then
    echo "edge warm expected HTTP 200, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi

  python3 - "$body_file" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
results = response.get("results", [])
bad = [r for r in results if r.get("status") not in {"warmed", "already_warm"}]
if not results or bad:
    raise SystemExit(f"unexpected warm response: {response}")
PY
}

measure_edge_ttfb() {
  local fixture="$1"
  local metric_name="$2"
  local artifact_label="$3"
  local artifact_path="$4"
  local url="$5"
  local expected_content_type="$6"
  local expected_cache="$7"
  local note="$8"
  local safe_label="${fixture}-${metric_name}-${artifact_label}-${expected_cache}"
  safe_label="${safe_label//[^A-Za-z0-9_.-]/_}"
  local headers_file="$tmp_dir/$safe_label.headers"
  local body_file="$tmp_dir/$safe_label.body"
  local timing_file="$tmp_dir/$safe_label.timing"

  fetch_timed "$url" "$headers_file" "$body_file" "$timing_file"

  local http_code
  http_code="$(timing_value "$timing_file" "http_code")"
  if [[ "$http_code" != "200" ]]; then
    echo "$metric_name $artifact_label expected HTTP 200, got $http_code" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi

  local cache_header
  cache_header="$(header_value "$headers_file" "x-rend-cache")"
  if [[ "$cache_header" != "$expected_cache" ]]; then
    echo "$metric_name $artifact_label expected X-Rend-Cache $expected_cache, got $cache_header" >&2
    exit 1
  fi

  local content_type
  content_type="$(header_value "$headers_file" "content-type")"
  content_type="${content_type%%;*}"
  if [[ "$content_type" != "$expected_content_type" ]]; then
    echo "$metric_name $artifact_label expected Content-Type $expected_content_type, got $content_type" >&2
    exit 1
  fi

  local byte_size
  byte_size="$(wc -c <"$body_file" | tr -d ' ')"
  if [[ "$byte_size" -le 0 ]]; then
    echo "$metric_name $artifact_label returned an empty body" >&2
    exit 1
  fi

  local ttfb_ms total_ms
  ttfb_ms="$(seconds_to_ms "$(timing_value "$timing_file" "time_starttransfer")")"
  total_ms="$(seconds_to_ms "$(timing_value "$timing_file" "time_total")")"

  record_metric "$fixture" "$metric_name" "$ttfb_ms" "$artifact_label" "$cache_header" "$note" "$(
    python3 - "$http_code" "$artifact_path" "$byte_size" "$total_ms" <<'PY'
import json, sys
print(json.dumps({
    "http_code": int(sys.argv[1]),
    "artifact_path": sys.argv[2],
    "byte_size": int(sys.argv[3]),
    "time_total_ms": round(float(sys.argv[4]), 3),
}))
PY
  )"

  printf '%s\n' "$total_ms"
}

measure_second_request_latency() {
  local fixture="$1"
  local artifact_label="$2"
  local artifact_path="$3"
  local url="$4"
  local expected_content_type="$5"
  local note="$6"
  local safe_label="${fixture}-second-request-${artifact_label}"
  safe_label="${safe_label//[^A-Za-z0-9_.-]/_}"
  local headers_file="$tmp_dir/$safe_label.headers"
  local body_file="$tmp_dir/$safe_label.body"
  local timing_file="$tmp_dir/$safe_label.timing"

  fetch_timed "$url" "$headers_file" "$body_file" "$timing_file"

  local http_code cache_header content_type byte_size ttfb_ms total_ms
  http_code="$(timing_value "$timing_file" "http_code")"
  cache_header="$(header_value "$headers_file" "x-rend-cache")"
  content_type="$(header_value "$headers_file" "content-type")"
  content_type="${content_type%%;*}"
  byte_size="$(wc -c <"$body_file" | tr -d ' ')"

  if [[ "$http_code" != "200" || "$cache_header" != "HIT" || "$content_type" != "$expected_content_type" || "$byte_size" -le 0 ]]; then
    echo "second request $artifact_label expected HTTP 200 HIT $expected_content_type with a nonempty body" >&2
    echo "got http=$http_code cache=$cache_header content_type=$content_type bytes=$byte_size" >&2
    exit 1
  fi

  ttfb_ms="$(seconds_to_ms "$(timing_value "$timing_file" "time_starttransfer")")"
  total_ms="$(seconds_to_ms "$(timing_value "$timing_file" "time_total")")"
  record_metric "$fixture" "second_request_latency" "$total_ms" "$artifact_label" "$cache_header" "$note" "$(
    python3 - "$http_code" "$artifact_path" "$byte_size" "$ttfb_ms" <<'PY'
import json, sys
print(json.dumps({
    "http_code": int(sys.argv[1]),
    "artifact_path": sys.argv[2],
    "byte_size": int(sys.argv[3]),
    "time_starttransfer_ms": round(float(sys.argv[4]), 3),
}))
PY
  )"
}

measure_coalesced_ttfb() {
  local fixture="$1"
  local asset_id="$2"
  local artifact_label="$3"
  local artifact_path="$4"
  local url="$5"
  local expected_content_type="$6"
  local observed=0

  for attempt in $(seq 1 "$coalescing_attempts"); do
    purge_artifacts "$asset_id" "$artifact_path"
    local batch_dir="$tmp_dir/coalesced-${fixture}-${artifact_label}-${attempt}"
    mkdir -p "$batch_dir"

    local -a pids=()
    for index in $(seq 1 "$coalescing_concurrency"); do
      (
        fetch_timed "$url" \
          "$batch_dir/$index.headers" \
          "$batch_dir/$index.body" \
          "$batch_dir/$index.timing"
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
      echo "one or more coalesced benchmark requests failed to complete" >&2
      exit 1
    fi

    if python3 - "$batch_dir" "$coalescing_concurrency" "$expected_content_type" "$metrics_file" "$fixture" "$artifact_label" "$artifact_path" "$attempt" "$coalescing_concurrency" <<'PY'
import hashlib
import json
import statistics
import sys
from pathlib import Path

batch_dir = Path(sys.argv[1])
count = int(sys.argv[2])
expected_content_type = sys.argv[3]
metrics_path = Path(sys.argv[4])
fixture = sys.argv[5]
artifact = sys.argv[6]
artifact_path = sys.argv[7]
attempt = int(sys.argv[8])
concurrency = int(sys.argv[9])

def timing(path):
    values = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if "=" in line:
                key, value = line.rstrip("\n").split("=", 1)
                values[key] = value
    return values

def header(path, name):
    name = name.lower()
    with open(path, "r", encoding="iso-8859-1") as f:
        for line in f:
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            if key.strip().lower() == name:
                return value.strip()
    return ""

samples = []
first_digest = None
counts = {"MISS": 0, "HIT": 0, "COALESCED": 0}
for index in range(1, count + 1):
    t = timing(batch_dir / f"{index}.timing")
    http_code = int(t.get("http_code", "0"))
    if http_code != 200:
        raise SystemExit(f"coalesced request {index} expected HTTP 200, got {http_code}")

    content_type = header(batch_dir / f"{index}.headers", "content-type").split(";", 1)[0]
    if content_type != expected_content_type:
        raise SystemExit(
            f"coalesced request {index} expected Content-Type {expected_content_type}, got {content_type}"
        )

    body = (batch_dir / f"{index}.body").read_bytes()
    if not body:
        raise SystemExit(f"coalesced request {index} returned an empty body")
    digest = hashlib.sha256(body).hexdigest()
    if first_digest is None:
        first_digest = digest
    elif digest != first_digest:
        raise SystemExit(f"coalesced request {index} body differed from request 1")

    cache_status = header(batch_dir / f"{index}.headers", "x-rend-cache")
    if cache_status not in counts:
        raise SystemExit(f"coalesced request {index} returned unexpected X-Rend-Cache {cache_status}")
    counts[cache_status] += 1
    samples.append({
        "index": index,
        "cache_status": cache_status,
        "http_code": http_code,
        "byte_size": len(body),
        "time_starttransfer_ms": round(float(t["time_starttransfer"]) * 1000, 3),
        "time_total_ms": round(float(t["time_total"]) * 1000, 3),
    })

if counts["MISS"] > 1:
    raise SystemExit(f"expected at most one MISS in coalesced batch, got {counts['MISS']}")

coalesced = [s["time_starttransfer_ms"] for s in samples if s["cache_status"] == "COALESCED"]
if not coalesced:
    raise SystemExit(2)

metric = {
    "fixture": fixture,
    "name": "edge_ttfb",
    "unit": "ms",
    "value_ms": round(statistics.median(coalesced), 3),
    "artifact": artifact,
    "artifact_path": artifact_path,
    "cache_status": "COALESCED",
    "note": "median TTFB across coalesced waiters",
    "attempt": attempt,
    "requested_concurrency": concurrency,
    "sample_count": len(coalesced),
    "counts": counts,
    "min_ms": round(min(coalesced), 3),
    "max_ms": round(max(coalesced), 3),
    "samples": samples,
}
with open(metrics_path, "a", encoding="utf-8") as f:
    f.write(json.dumps(metric, sort_keys=True) + "\n")
PY
    then
      observed=1
      break
    else
      local exit_code="$?"
      if [[ "$exit_code" != "2" ]]; then
        exit "$exit_code"
      fi
      sleep 0.2
    fi
  done

  if [[ "$observed" != "1" ]]; then
    record_warning "$fixture" "COALESCED cache status was not observed for $artifact_label after $coalescing_attempts attempts"
    record_metric "$fixture" "edge_ttfb" "null" "$artifact_label" "COALESCED" "not observed after concurrent cold-fill attempts" "$(
      python3 - "$artifact_path" "$coalescing_attempts" "$coalescing_concurrency" <<'PY'
import json, sys
print(json.dumps({
    "artifact_path": sys.argv[1],
    "attempts": int(sys.argv[2]),
    "requested_concurrency": int(sys.argv[3]),
    "observed": False,
}))
PY
    )"
  fi
}

generate_fixture() {
  local name="$1"
  local output="$2"
  local size duration tone

  case "$name" in
    small)
      size="320x180"
      duration="4"
      tone="660"
      ;;
    medium)
      size="640x360"
      duration="8"
      tone="880"
      ;;
    *)
      echo "unknown benchmark fixture '$name'; expected small or medium" >&2
      exit 1
      ;;
  esac

  mkdir -p "$(dirname "$output")"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc=size=${size}:rate=24:duration=${duration}" \
    -f lavfi -i "sine=frequency=${tone}:sample_rate=48000:duration=${duration}" \
    -shortest \
    -c:v libx264 \
    -preset veryfast \
    -pix_fmt yuv420p \
    -c:a aac \
    -b:a 96k \
    -movflags +faststart \
    "$output"
}

write_fixture_record() {
  local fixture="$1"
  local fixture_path="$2"
  local asset_id="$3"
  local upload_response="$4"
  local artifact_json="$5"
  local probe_json="$6"

  python3 - "$fixtures_file" "$fixture" "$fixture_path" "$asset_id" "$upload_response" "$artifact_json" "$probe_json" <<'PY'
import json
import os
import sys

out_path, name, fixture_path, asset_id, upload_response_path, artifact_json_path, probe_json_path = sys.argv[1:]
with open(upload_response_path, "r", encoding="utf-8") as f:
    upload = json.load(f)
with open(artifact_json_path, "r", encoding="utf-8") as f:
    artifacts = json.load(f)
with open(probe_json_path, "r", encoding="utf-8") as f:
    probe = json.load(f)

video_stream = next((s for s in probe.get("streams", []) if s.get("codec_type") == "video"), {})
fmt = probe.get("format", {})
record = {
    "name": name,
    "path": fixture_path,
    "byte_size": os.path.getsize(fixture_path),
    "duration_seconds": float(fmt.get("duration", 0) or 0),
    "width": video_stream.get("width"),
    "height": video_stream.get("height"),
    "asset_id": asset_id,
    "source_object_key": upload.get("source_object_key"),
    "source_byte_size": upload.get("byte_size"),
    "artifacts": artifacts.get("artifacts", []),
}
with open(out_path, "a", encoding="utf-8") as f:
    f.write(json.dumps(record, sort_keys=True) + "\n")
PY
}

extract_bootstrap_artifacts() {
  local bootstrap_response="$1"
  local asset_id="$2"
  local output_json="$3"

  python3 - "$bootstrap_response" "$edge_base" "$asset_id" "$output_json" <<'PY'
import json
import sys

response_path, edge_base, asset_id, output_path = sys.argv[1:]
edge_base = edge_base.rstrip("/")
with open(response_path, "r", encoding="utf-8") as f:
    response = json.load(f)

required = ["opener_url", "manifest_url", "prefetch_hints", "playback_url"]
missing = [key for key in required if not response.get(key)]
if missing:
    raise SystemExit(f"bootstrap response missing required benchmark fields: {', '.join(missing)}")

hints = response.get("prefetch_hints") or []
first_segment = next((hint for hint in hints if hint.get("artifact_path", "").endswith((".m4s", ".ts"))), None)
if not first_segment:
    raise SystemExit("bootstrap response did not include an HLS segment prefetch hint")

artifacts = [
    {
        "label": "opener",
        "artifact_path": "opener.mp4",
        "url": response["opener_url"],
        "content_type": response.get("opener_content_type", "video/mp4"),
    },
    {
        "label": "manifest",
        "artifact_path": "hls/master.m3u8",
        "url": response["manifest_url"],
        "content_type": response.get("manifest_content_type", "application/vnd.apple.mpegurl"),
    },
    {
        "label": "segment",
        "artifact_path": first_segment["artifact_path"],
        "url": first_segment["url"],
        "content_type": first_segment.get(
            "content_type",
            "video/mp4" if first_segment["artifact_path"].endswith(".m4s") else "video/mp2t",
        ),
    },
]

for artifact in artifacts:
    expected_url = f"{edge_base}/v/{asset_id}/{artifact['artifact_path']}"
    if artifact["url"] != expected_url:
        raise SystemExit(f"{artifact['label']} URL did not use tokenless edge playback shape")

with open(output_path, "w", encoding="utf-8") as f:
    json.dump({"playback_url": response["playback_url"], "artifacts": artifacts}, f, sort_keys=True)
PY
}

artifact_field() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
for artifact in data["artifacts"]:
    if artifact["label"] == sys.argv[2]:
        print(artifact[sys.argv[3]])
        raise SystemExit(0)
raise SystemExit(f"missing artifact {sys.argv[2]}")
PY
}

wait_for_asset_ready() {
  local asset_id="$1"
  local asset_response="$2"
  local deadline_ms
  deadline_ms=$(( $(now_ms) + poll_timeout_secs * 1000 ))

  while [[ "$(now_ms)" -lt "$deadline_ms" ]]; do
    local status_code
    status_code="$(
      curl -sS --max-time "$curl_max_time_secs" \
        -o "$asset_response" \
        -w "%{http_code}" \
        "$api_base/v1/assets/$asset_id" \
        -H "authorization: Bearer $REND_DEV_API_KEY"
    )"
    if [[ "$status_code" == "200" ]]; then
      local state
      state="$(
        python3 - "$asset_response" <<'PY'
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
          cat "$asset_response" >&2
          exit 1
          ;;
      esac
    fi

    if [[ "${worker_started:-0}" == "1" && -n "${worker_pid:-}" ]] &&
      ! kill -0 "$worker_pid" >/dev/null 2>&1; then
      echo "rend-api media worker exited before asset became playable" >&2
      exit 1
    fi
    sleep "$poll_interval"
  done

  echo "timed out waiting for asset $asset_id to become hls_ready" >&2
  cat "$asset_response" >&2 || true
  exit 1
}

fetch_bootstrap_ready() {
  local fixture="$1"
  local asset_id="$2"
  local upload_started_ms="$3"
  local bootstrap_response="$4"
  local timing_file="$5"
  local deadline_ms
  deadline_ms=$(( $(now_ms) + poll_timeout_secs * 1000 ))

  while [[ "$(now_ms)" -lt "$deadline_ms" ]]; do
    curl -sS --max-time "$curl_max_time_secs" \
      -c "$(playback_cookie_jar)" \
      -o "$bootstrap_response" \
      -w "$curl_timing_format" \
      "$api_base/v1/assets/$asset_id/playback" \
      -H "authorization: Bearer $REND_DEV_API_KEY" >"$timing_file"

    local status_code
    status_code="$(timing_value "$timing_file" "http_code")"
    if [[ "$status_code" == "200" ]]; then
      local ready_ms
      ready_ms="$(now_ms)"
      record_metric "$fixture" "upload_to_playback_bootstrap_ready" "$(( ready_ms - upload_started_ms ))" "" "" "first successful playback bootstrap response" "$(
        python3 - "$status_code" "$(seconds_to_ms "$(timing_value "$timing_file" "time_total")")" <<'PY'
import json, sys
print(json.dumps({
    "http_code": int(sys.argv[1]),
    "bootstrap_response_time_ms": round(float(sys.argv[2]), 3),
}))
PY
      )"
      return 0
    fi

    sleep "$poll_interval"
  done

  echo "timed out waiting for playback bootstrap for asset $asset_id" >&2
  cat "$bootstrap_response" >&2 || true
  exit 1
}

write_lifecycle_metrics() {
  local fixture="$1"
  local asset_id="$2"
  local lifecycle_json="$tmp_dir/$fixture-lifecycle.json"

  docker compose exec -T postgres psql -U rend -d rend -X -qAt >"$lifecycle_json" <<SQL
WITH selected_job AS (
  SELECT *
  FROM rend.media_jobs
  WHERE asset_id = '$asset_id'::uuid
    AND job_type = 'process_media'
  ORDER BY created_at
  LIMIT 1
),
opener AS (
  SELECT created_at
  FROM rend.artifacts
  WHERE asset_id = '$asset_id'::uuid
    AND kind = 'opener'
  ORDER BY created_at
  LIMIT 1
),
manifest AS (
  SELECT created_at
  FROM rend.artifacts
  WHERE asset_id = '$asset_id'::uuid
    AND kind = 'manifest'
  ORDER BY created_at
  LIMIT 1
),
first_segment AS (
  SELECT created_at
  FROM rend.artifacts
  WHERE asset_id = '$asset_id'::uuid
    AND kind = 'segment'
  ORDER BY object_key
  LIMIT 1
),
event_times AS (
  SELECT
    MIN(created_at) FILTER (
      WHERE event_type = 'media.processing_started'
    ) AS media_processing_started_at,
    MIN(created_at) FILTER (
      WHERE event_type = 'artifact.generated'
        AND metadata->>'kind' = 'opener'
    ) AS opener_generated_at,
    MIN(created_at) FILTER (
      WHERE event_type = 'playable_state.changed'
        AND metadata->>'current' = 'hls_ready'
    ) AS hls_ready_at,
    MAX(created_at) FILTER (
      WHERE event_type IN ('edge.warming_succeeded', 'playable_state.changed')
    ) AS media_worker_visible_done_at
  FROM rend.asset_events
  WHERE asset_id = '$asset_id'::uuid
)
SELECT jsonb_build_object(
  'asset_created_at', to_char(asset.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'asset_updated_at', to_char(asset.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'media_processing_started_at', to_char(event_times.media_processing_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'media_worker_visible_done_at', to_char(event_times.media_worker_visible_done_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'source_state', asset.source_state,
  'playable_state', asset.playable_state,
  'job_status', selected_job.status,
  'job_attempts', selected_job.attempts,
  'job_locked_by', selected_job.locked_by,
  'upload_to_media_job_claimed_ms',
    CASE WHEN event_times.media_processing_started_at IS NULL THEN NULL
         ELSE EXTRACT(EPOCH FROM (event_times.media_processing_started_at - asset.created_at)) * 1000 END,
  'media_worker_processing_duration_ms',
    CASE WHEN event_times.media_processing_started_at IS NULL OR event_times.media_worker_visible_done_at IS NULL THEN NULL
         ELSE EXTRACT(EPOCH FROM (event_times.media_worker_visible_done_at - event_times.media_processing_started_at)) * 1000 END,
  'upload_to_opener_ready_ms',
    CASE WHEN event_times.opener_generated_at IS NULL THEN NULL
         ELSE EXTRACT(EPOCH FROM (event_times.opener_generated_at - asset.created_at)) * 1000 END,
  'upload_to_hls_ready_ms',
    CASE WHEN event_times.hls_ready_at IS NULL THEN NULL
         ELSE EXTRACT(EPOCH FROM (event_times.hls_ready_at - asset.created_at)) * 1000 END,
  'upload_to_manifest_ready_ms',
    CASE WHEN manifest.created_at IS NULL THEN NULL
         ELSE EXTRACT(EPOCH FROM (manifest.created_at - asset.created_at)) * 1000 END,
  'upload_to_first_segment_ready_ms',
    CASE WHEN first_segment.created_at IS NULL THEN NULL
         ELSE EXTRACT(EPOCH FROM (first_segment.created_at - asset.created_at)) * 1000 END
)
FROM rend.assets asset
LEFT JOIN selected_job ON selected_job.asset_id = asset.id
LEFT JOIN opener ON true
LEFT JOIN manifest ON true
LEFT JOIN first_segment ON true
LEFT JOIN event_times ON true
WHERE asset.id = '$asset_id'::uuid;
SQL

  python3 - "$metrics_file" "$fixture" "$lifecycle_json" <<'PY'
import json
import sys

metrics_path, fixture, lifecycle_path = sys.argv[1:]
with open(lifecycle_path, "r", encoding="utf-8") as f:
    lifecycle = json.loads(f.read())

mapping = [
    ("upload_to_media_job_claimed_ms", "upload_to_media_job_claimed", "media.processing_started event - assets.created_at"),
    ("upload_to_opener_ready_ms", "upload_to_opener_ready", "opener artifact.generated event - assets.created_at"),
    ("upload_to_hls_ready_ms", "upload_to_hls_ready", "hls_ready playable_state.changed event - assets.created_at"),
    ("media_worker_processing_duration_ms", "media_worker_processing_duration", "media.processing_started to final worker-visible event; includes edge warm when present"),
]

with open(metrics_path, "a", encoding="utf-8") as f:
    for source_key, metric_name, note in mapping:
        value = lifecycle.get(source_key)
        metric = {
            "fixture": fixture,
            "name": metric_name,
            "unit": "ms",
            "value_ms": None if value is None else round(float(value), 3),
            "note": note,
            "lifecycle": lifecycle,
        }
        f.write(json.dumps(metric, sort_keys=True) + "\n")
PY
}

wait_for_telemetry_visibility() {
  local fixture="$1"
  local asset_id="$2"
  local poll_started_ms="$3"
  local expected_min_count="$4"
  local analytics_response="$tmp_dir/$fixture-analytics.json"
  local deadline_ms
  deadline_ms=$(( $(now_ms) + poll_timeout_secs * 1000 ))

  while [[ "$(now_ms)" -lt "$deadline_ms" ]]; do
    local status_code
    status_code="$(
      curl -sS --max-time "$curl_max_time_secs" \
        -o "$analytics_response" \
        -w "%{http_code}" \
        "$api_base/v1/assets/$asset_id/analytics/playback?window_seconds=3600" \
        -H "authorization: Bearer $REND_DEV_API_KEY"
    )"
    if [[ "$status_code" == "200" ]] &&
      python3 - "$analytics_response" "$expected_min_count" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
expected = int(sys.argv[2])
cache = data.get("cache_status_counts", {})
ok = (
    int(data.get("request_count", 0)) >= expected
    and int(data.get("bytes_served", 0)) > 0
    and int(cache.get("MISS", 0)) >= 1
    and int(cache.get("HIT", 0)) >= 1
    and (int(cache.get("COALESCED", 0)) >= 1 or expected == 0)
)
raise SystemExit(0 if ok else 1)
PY
    then
      local visible_ms
      visible_ms="$(now_ms)"
      record_metric "$fixture" "telemetry_flush_visibility_delay" "$(( visible_ms - poll_started_ms ))" "" "" "time from last benchmark playback request to analytics visibility" "$(
        python3 - "$analytics_response" "$expected_min_count" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    analytics = json.load(f)
print(json.dumps({
    "expected_min_request_count": int(sys.argv[2]),
    "analytics": analytics,
}))
PY
      )"
      return 0
    fi
    sleep "$poll_interval"
  done

  echo "timed out waiting for playback telemetry analytics for asset $asset_id" >&2
  cat "$analytics_response" >&2 || true
  exit 1
}

render_results() {
  mkdir -p "$(dirname "$output_path")"
  local git_sha git_dirty hostname_value uname_value ended_at_iso
  git_sha="$(git rev-parse HEAD 2>/dev/null || true)"
  if git diff --quiet >/dev/null 2>&1 && git diff --cached --quiet >/dev/null 2>&1; then
    git_dirty="false"
  else
    git_dirty="true"
  fi
  hostname_value="$(hostname 2>/dev/null || true)"
  uname_value="$(uname -a 2>/dev/null || true)"
  ended_at_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  python3 - "$metrics_file" "$fixtures_file" "$warnings_file" "$output_path" \
    "$started_at_iso" "$ended_at_iso" "$git_sha" "$git_dirty" "$hostname_value" "$uname_value" \
    "$api_started" "$edge_started" "$worker_started" "$api_base" "$edge_base" "$run_id" \
    "$fixture_names" "$coalescing_concurrency" "$coalescing_attempts" <<'PY'
import json
import os
import sys

(
    metrics_path,
    fixtures_path,
    warnings_path,
    output_path,
    started_at,
    ended_at,
    git_sha,
    git_dirty,
    hostname,
    uname,
    api_started,
    edge_started,
    worker_started,
    api_base,
    edge_base,
    run_id,
    fixture_names,
    coalescing_concurrency,
    coalescing_attempts,
) = sys.argv[1:]

def read_ndjson(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows

metrics = read_ndjson(metrics_path)
fixtures = read_ndjson(fixtures_path)
warnings = read_ndjson(warnings_path)

env_keys = [
    "OBJECT_STORE_HEALTH_URL",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "CLICKHOUSE_URL",
    "CLICKHOUSE_DATABASE",
    "REND_API_BIND_ADDR",
    "REND_API_AUTO_MIGRATE",
    "REND_PLAYBACK_BASE_URL",
    "REND_EDGE_WARM_URL",
    "REND_EDGE_PURGE_URL",
    "REND_PLAYBACK_SIGNING_KEY_ID",
    "REND_PLAYBACK_TOKEN_TTL_SECS",
    "REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS",
    "REND_HTTP_TIMEOUT_SECS",
    "REND_MEDIA_PROCESS_TIMEOUT_SECS",
    "REND_API_INLINE_MEDIA_PROCESSING",
    "REND_MEDIA_JOB_MAX_ATTEMPTS",
    "REND_MEDIA_WORKER_POLL_INTERVAL_SECS",
    "REND_MEDIA_JOB_LOCK_TIMEOUT_SECS",
    "REND_FFMPEG_PATH",
    "REND_FFPROBE_PATH",
    "REND_EDGE_BIND_ADDR",
    "REND_EDGE_ID",
    "REND_EDGE_REGION",
    "REND_EDGE_CACHE_DIR",
    "REND_EDGE_ORIGIN_HEALTH_URL",
    "REND_EDGE_WARM_MAX_ARTIFACTS",
    "REND_EDGE_MAX_IN_FLIGHT_FILLS",
    "REND_EDGE_TELEMETRY_ENABLED",
    "REND_EDGE_TELEMETRY_INGEST_URL",
    "REND_EDGE_TELEMETRY_QUEUE_CAPACITY",
    "REND_EDGE_TELEMETRY_BATCH_SIZE",
    "REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS",
    "REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS",
    "REND_EDGE_TELEMETRY_SPOOL_DIR",
    "REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES",
]
secret_keys = [
    "DATABASE_URL",
    "CLICKHOUSE_USER",
    "CLICKHOUSE_PASSWORD",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "REND_DEV_API_KEY",
    "REND_INTERNAL_TELEMETRY_TOKEN",
    "REND_EDGE_INTERNAL_TOKEN",
    "REND_PLAYBACK_SIGNING_SECRET",
]
env = {key: os.environ.get(key) for key in env_keys if key in os.environ}
secret_presence = {f"{key}_set": bool(os.environ.get(key)) for key in secret_keys}

document = {
    "schema_version": 1,
    "benchmark": "rend-playback-edge-v1-local",
    "run_id": run_id,
    "started_at": started_at,
    "ended_at": ended_at,
    "metadata": {
        "git": {
            "sha": git_sha or None,
            "dirty": git_dirty == "true",
        },
        "host": {
            "hostname": hostname or None,
            "uname": uname or None,
        },
        "base_urls": {
            "api": api_base,
            "edge": edge_base,
        },
        "services": {
            "api_started_by_script": api_started == "1",
            "edge_started_by_script": edge_started == "1",
            "media_worker_started_by_script": worker_started == "1",
        },
        "cache_state": {
            "mode": "cold samples purge each artifact before request; HIT samples immediately repeat; warmed samples purge then call /internal/warm",
            "edge_cache_dir": os.environ.get("REND_EDGE_CACHE_DIR"),
            "coalescing_concurrency": int(coalescing_concurrency),
            "coalescing_attempts": int(coalescing_attempts),
        },
        "env": env,
        "secret_presence": secret_presence,
        "fixture_selection": fixture_names,
    },
    "fixtures": fixtures,
    "metrics": metrics,
    "warnings": warnings,
}

with open(output_path, "w", encoding="utf-8") as f:
    json.dump(document, f, indent=2, sort_keys=True)
    f.write("\n")

metric_labels = {
    "post_v1_videos_response_time": "POST /v1/videos response",
    "upload_to_media_job_claimed": "upload-to-media-job-claimed",
    "upload_to_opener_ready": "upload-to-opener-ready",
    "upload_to_hls_ready": "upload-to-hls-ready",
    "upload_to_playback_bootstrap_ready": "upload-to-playback-bootstrap-ready",
    "edge_ttfb": "edge TTFB",
    "warmed_first_request_ttfb": "warmed first-request TTFB",
    "second_request_latency": "second-request latency",
    "telemetry_flush_visibility_delay": "telemetry flush visibility delay",
    "media_worker_processing_duration": "media worker processing duration",
}
order = {
    "post_v1_videos_response_time": 10,
    "upload_to_media_job_claimed": 20,
    "upload_to_opener_ready": 30,
    "upload_to_hls_ready": 40,
    "upload_to_playback_bootstrap_ready": 50,
    "edge_ttfb": 60,
    "warmed_first_request_ttfb": 70,
    "second_request_latency": 80,
    "telemetry_flush_visibility_delay": 90,
    "media_worker_processing_duration": 100,
}
artifact_order = {"opener": 1, "manifest": 2, "segment": 3}
cache_order = {"MISS": 1, "HIT": 2, "COALESCED": 3}

def sort_key(metric):
    return (
        metric.get("fixture", ""),
        order.get(metric.get("name"), 999),
        artifact_order.get(metric.get("artifact", ""), 99),
        cache_order.get(metric.get("cache_status", ""), 99),
    )

rows = []
for metric in sorted(metrics, key=sort_key):
    value = metric.get("value_ms")
    value_text = "n/a" if value is None else f"{value:.2f} ms"
    note = metric.get("note", "")
    if metric.get("name") == "edge_ttfb" and metric.get("sample_count"):
        note = f"median of {metric['sample_count']} samples"
    rows.append([
        metric.get("fixture", "-"),
        metric_labels.get(metric.get("name"), metric.get("name", "-")),
        metric.get("artifact", "-"),
        metric.get("cache_status", "-"),
        value_text,
        note,
    ])

headers = ["Fixture", "Measure", "Artifact", "Cache", "Value", "Notes"]
widths = [len(h) for h in headers]
for row in rows:
    for index, cell in enumerate(row):
        widths[index] = max(widths[index], len(str(cell)))

def fmt(row):
    return " | ".join(str(cell).ljust(widths[index]) for index, cell in enumerate(row))

print("Rend Playback Edge V1 local benchmark")
print(f"JSON: {output_path}")
print(fmt(headers))
print("-+-".join("-" * width for width in widths))
for row in rows:
    print(fmt(row))
if warnings:
    print("")
    print("Warnings:")
    for warning in warnings:
        fixture = warning.get("fixture") or "-"
        print(f"- {fixture}: {warning.get('message')}")
PY
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
export CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://localhost:8123}"
export CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-rend}"
export CLICKHOUSE_USER="${CLICKHOUSE_USER:-rend}"
export CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-rend}"
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
export REND_EDGE_PURGE_URL="${REND_EDGE_PURGE_URL:-$edge_base/internal/purge}"
export REND_INTERNAL_TELEMETRY_TOKEN="${REND_INTERNAL_TELEMETRY_TOKEN:-dev-internal-token}"
export REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES="${REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES:-262144}"
export REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH="${REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH:-100}"
export REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS="${REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS:-86400}"
export REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS="${REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS:-604800}"
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
export REND_EDGE_CACHE_DIR="${REND_EDGE_CACHE_DIR:-$root_dir/.rend/benchmark-edge-cache}"
export REND_EDGE_ORIGIN_HEALTH_URL="${REND_EDGE_ORIGIN_HEALTH_URL:-http://localhost:9100/minio/health/ready}"
export REND_EDGE_INTERNAL_TOKEN="${REND_EDGE_INTERNAL_TOKEN:-dev-internal-token}"
export REND_EDGE_WARM_MAX_ARTIFACTS="${REND_EDGE_WARM_MAX_ARTIFACTS:-16}"
export REND_EDGE_MAX_IN_FLIGHT_FILLS="${REND_EDGE_MAX_IN_FLIGHT_FILLS:-64}"
export REND_EDGE_TELEMETRY_ENABLED="${REND_EDGE_TELEMETRY_ENABLED:-true}"
export REND_EDGE_TELEMETRY_INGEST_URL="${REND_EDGE_TELEMETRY_INGEST_URL:-$api_base/internal/telemetry/playback}"
export REND_EDGE_TELEMETRY_QUEUE_CAPACITY="${REND_EDGE_TELEMETRY_QUEUE_CAPACITY:-1024}"
export REND_EDGE_TELEMETRY_BATCH_SIZE="${REND_EDGE_TELEMETRY_BATCH_SIZE:-100}"
export REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS="${REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS:-1}"
export REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS="${REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS:-2}"
export REND_EDGE_TELEMETRY_SPOOL_DIR="${REND_EDGE_TELEMETRY_SPOOL_DIR:-$root_dir/.rend/benchmark-telemetry-spool}"
export REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES="${REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES:-10485760}"

docker compose up -d

for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U rend -d rend >/dev/null 2>&1 &&
    docker compose exec -T clickhouse clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT 1" >/dev/null 2>&1 &&
    curl -fsS "$OBJECT_STORE_HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker compose exec -T postgres pg_isready -U rend -d rend >/dev/null
docker compose exec -T clickhouse clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT 1" >/dev/null
curl -fsS "$OBJECT_STORE_HEALTH_URL" >/dev/null
for schema in "$root_dir"/clickhouse/*.sql; do
  docker compose exec -T clickhouse clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery <"$schema"
done

mkdir -p "$root_dir/.rend" "$REND_EDGE_CACHE_DIR" "$REND_EDGE_TELEMETRY_SPOOL_DIR" "$(dirname "$output_path")"
cargo build -p rend-api -p rend-edge >/dev/null

if ! curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
  "$root_dir/target/debug/rend-api" >"$root_dir/.rend/rend-api-local-playback-benchmark.log" 2>&1 &
  api_pid="$!"
  api_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$api_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$api_started" == "1" ]] && ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "rend-api exited before readiness; see .rend/rend-api-local-playback-benchmark.log" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS "$api_base/readyz" >/dev/null

if ! curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
  "$root_dir/target/debug/rend-edge" >"$root_dir/.rend/rend-edge-local-playback-benchmark.log" 2>&1 &
  edge_pid="$!"
  edge_started=1
fi

for _ in $(seq 1 120); do
  if curl -fsS "$edge_base/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$edge_started" == "1" ]] && ! kill -0 "$edge_pid" >/dev/null 2>&1; then
    echo "rend-edge exited before readiness; see .rend/rend-edge-local-playback-benchmark.log" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS "$edge_base/readyz" >/dev/null

start_media_worker "rend-api-media-worker-local-playback-benchmark"

IFS=',' read -r -a fixtures <<<"$fixture_names"
for raw_fixture in "${fixtures[@]}"; do
  fixture="$(printf '%s' "$raw_fixture" | xargs)"
  if [[ -z "$fixture" ]]; then
    continue
  fi

  fixture_path="$root_dir/fixtures/media/rend-benchmark-$fixture.mp4"
  probe_json="$tmp_dir/$fixture-ffprobe.json"
  upload_response="$tmp_dir/$fixture-upload.json"
  upload_timing="$tmp_dir/$fixture-upload.timing"
  asset_response="$tmp_dir/$fixture-asset.json"
  bootstrap_response="$tmp_dir/$fixture-bootstrap.json"
  bootstrap_timing="$tmp_dir/$fixture-bootstrap.timing"
  artifact_json="$tmp_dir/$fixture-artifacts.json"

  generate_fixture "$fixture" "$fixture_path"
  ffprobe -v error \
    -select_streams v:0 \
    -show_entries stream=codec_type,width,height \
    -show_entries format=duration,size \
    -of json \
    "$fixture_path" >"$probe_json"

  upload_started_ms="$(now_ms)"
  post_upload_timed "$fixture_path" "$upload_response" "$upload_timing"
  upload_completed_ms="$(now_ms)"
  upload_status="$(timing_value "$upload_timing" "http_code")"
  if [[ "$upload_status" != "201" ]]; then
    echo "upload failed with HTTP $upload_status" >&2
    cat "$upload_response" >&2
    exit 1
  fi
  asset_id="$(assert_async_upload_response "$upload_response")"
  upload_total_ms="$(seconds_to_ms "$(timing_value "$upload_timing" "time_total")")"
  record_metric "$fixture" "post_v1_videos_response_time" "$upload_total_ms" "" "" "curl time_total for POST /v1/videos" "$(
    python3 - "$upload_status" "$(( upload_completed_ms - upload_started_ms ))" <<'PY'
import json, sys
print(json.dumps({
    "http_code": int(sys.argv[1]),
    "wall_time_ms": int(sys.argv[2]),
}))
PY
  )"

  wait_for_asset_ready "$asset_id" "$asset_response"
  fetch_bootstrap_ready "$fixture" "$asset_id" "$upload_started_ms" "$bootstrap_response" "$bootstrap_timing"
  write_lifecycle_metrics "$fixture" "$asset_id"
  extract_bootstrap_artifacts "$bootstrap_response" "$asset_id" "$artifact_json"
  write_fixture_record "$fixture" "$fixture_path" "$asset_id" "$upload_response" "$artifact_json" "$probe_json"

  expected_playback_events=0
  for artifact_label in opener manifest segment; do
    artifact_path="$(artifact_field "$artifact_json" "$artifact_label" "artifact_path")"
    artifact_url="$(artifact_field "$artifact_json" "$artifact_label" "url")"
    content_type="$(artifact_field "$artifact_json" "$artifact_label" "content_type")"

    purge_artifacts "$asset_id" "$artifact_path"
    measure_edge_ttfb "$fixture" "edge_ttfb" "$artifact_label" "$artifact_path" "$artifact_url" "$content_type" "MISS" "cold request after purge" >/dev/null
    expected_playback_events=$((expected_playback_events + 1))
    measure_edge_ttfb "$fixture" "edge_ttfb" "$artifact_label" "$artifact_path" "$artifact_url" "$content_type" "HIT" "immediate request after MISS" >/dev/null
    expected_playback_events=$((expected_playback_events + 1))
    measure_coalesced_ttfb "$fixture" "$asset_id" "$artifact_label" "$artifact_path" "$artifact_url" "$content_type"
    expected_playback_events=$((expected_playback_events + coalescing_concurrency))

    purge_artifacts "$asset_id" "$artifact_path"
    warm_artifacts "$asset_id" "$artifact_path"
    measure_edge_ttfb "$fixture" "warmed_first_request_ttfb" "$artifact_label" "$artifact_path" "$artifact_url" "$content_type" "HIT" "first request after explicit edge warm" >/dev/null
    expected_playback_events=$((expected_playback_events + 1))

    if [[ "$artifact_label" == "opener" ]]; then
      measure_second_request_latency "$fixture" "$artifact_label" "$artifact_path" "$artifact_url" "$content_type" "immediate request after warmed opener first request"
      expected_playback_events=$((expected_playback_events + 1))
    fi
  done

  telemetry_poll_started_ms="$(now_ms)"
  wait_for_telemetry_visibility "$fixture" "$asset_id" "$telemetry_poll_started_ms" "$expected_playback_events"
done

render_results
