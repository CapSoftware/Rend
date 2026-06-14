#!/usr/bin/env bash

start_media_worker() {
  local log_name="${1:-media-worker}"
  mkdir -p "$root_dir/.rend"
  cargo build -p rend-api >/dev/null
  "$root_dir/target/debug/rend-api" worker media >"$root_dir/.rend/$log_name.log" 2>&1 &
  worker_pid="$!"
  worker_started=1
  sleep 1
  if ! kill -0 "$worker_pid" >/dev/null 2>&1; then
    echo "rend-api media worker exited before processing; see .rend/$log_name.log" >&2
    exit 1
  fi
}

stop_media_worker() {
  if [[ "${worker_started:-0}" != "1" || -z "${worker_pid:-}" ]]; then
    return 0
  fi

  kill "$worker_pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    if ! kill -0 "$worker_pid" >/dev/null 2>&1; then
      wait "$worker_pid" >/dev/null 2>&1 || true
      worker_started=0
      worker_pid=""
      return 0
    fi
    sleep 0.2
  done

  kill -KILL "$worker_pid" >/dev/null 2>&1 || true
  wait "$worker_pid" >/dev/null 2>&1 || true
  worker_started=0
  worker_pid=""
}

assert_async_upload_response() {
  local response_file="$1"
  python3 - "$response_file" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
required = ["asset_id", "source_state", "playable_state", "source_artifact_id", "source_object_key", "byte_size"]
missing = [key for key in required if key not in response]
if missing:
    raise SystemExit(f"upload response missing fields: {', '.join(missing)}")
if response["source_state"] != "uploaded":
    raise SystemExit(f"expected upload source_state uploaded, got {response['source_state']}")
if response["playable_state"] != "not_playable":
    raise SystemExit(f"expected upload playable_state not_playable, got {response['playable_state']}")
if "playback_url" in response:
    raise SystemExit("upload response must not include playback_url before media processing")
if int(response["byte_size"]) <= 0:
    raise SystemExit("expected uploaded byte_size to be nonzero")
print(response["asset_id"])
PY
}

poll_asset_until_hls_ready() {
  local asset_id="$1"
  local asset_response="$2"

  for _ in $(seq 1 180); do
    local status_code
    status_code="$(
      curl -sS -o "$asset_response" -w "%{http_code}" \
        "$api_base/v1/assets/$asset_id" \
        -H "authorization: Bearer $REND_DEV_API_KEY"
    )"
    if [[ "$status_code" == "200" ]]; then
      local state
      state="$(
        python3 - "$asset_response" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
print(response.get("playable_state", ""))
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
    sleep 1
  done

  echo "timed out waiting for asset $asset_id to become hls_ready" >&2
  cat "$asset_response" >&2 || true
  exit 1
}

fetch_playback_bootstrap() {
  local asset_id="$1"
  local bootstrap_response="$2"
  local status_code
  status_code="$(
    curl -sS -c "$(playback_cookie_jar)" -o "$bootstrap_response" -w "%{http_code}" \
      "$api_base/v1/assets/$asset_id/playback" \
      -H "authorization: Bearer $REND_DEV_API_KEY"
  )"

  if [[ "$status_code" != "200" ]]; then
    echo "bootstrap failed with HTTP $status_code" >&2
    cat "$bootstrap_response" >&2
    exit 1
  fi
}

playback_cookie_jar() {
  printf '%s\n' "${REND_PLAYBACK_COOKIE_JAR:-$tmp_dir/playback.cookies}"
}

playback_url_from_bootstrap() {
  local bootstrap_response="$1"
  python3 - "$bootstrap_response" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
playback_url = response.get("playback_url", "")
if not playback_url:
    raise SystemExit("bootstrap response missing playback_url")
print(playback_url)
PY
}
