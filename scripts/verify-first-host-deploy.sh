#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

api_base="${REND_API_BASE_URL:-http://127.0.0.1:4000}"
edge_base="${REND_EDGE_BASE_URL:-http://127.0.0.1:4100}"
asset_id="${ASSET_ID:-}"
dev_api_key="${REND_DEV_API_KEY:-}"
database_url="${DATABASE_URL:-}"
edge_id="${REND_EDGE_ID:-}"
edge_internal_token="${REND_EDGE_INTERNAL_TOKEN:-}"
control_plane_url="${REND_CONTROL_PLANE_URL:-}"
api_env=""
edge_env=""
skip_registration=false
skip_playback=false
skip_analytics=false
rewrite_playback_base=false

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: scripts/verify-first-host-deploy.sh [options]

Run first-host post-deploy verification.

Options:
  --api-base URL              API base URL. Default: http://127.0.0.1:4000.
  --edge-base URL             Edge base URL. Default: http://127.0.0.1:4100.
  --asset-id ID               Existing hls_ready asset id for signed playback smoke.
  --dev-api-key KEY           API bearer key for asset and analytics endpoints.
  --database-url URL          Optional Postgres URL for edge registry visibility.
  --edge-id ID                Edge id to verify in registry.
  --edge-internal-token TOKEN Internal edge token for heartbeat fallback.
  --control-plane-url URL     Internal API/control-plane URL for heartbeat fallback.
  --api-env FILE              Read REND_DEV_API_KEY and DATABASE_URL defaults from file.
  --edge-env FILE             Read edge id/token/control-plane/base URL defaults from file.
  --rewrite-playback-base     Rewrite API playback URL host to --edge-base before fetching.
  --skip-registration         Skip edge registration visibility check.
  --skip-playback             Skip signed playback and analytics checks.
  --skip-analytics            Skip analytics increase check after playback.
  -h, --help                  Show this help.

Example:
  scripts/verify-first-host-deploy.sh \
    --api-base https://api.example.com \
    --edge-base https://edge-us-east.example.com \
    --api-env /etc/rend/rend-api.env \
    --edge-env /etc/rend/rend-edge.env \
    --asset-id 00000000-0000-0000-0000-000000000000
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-base)
      api_base="${2:?missing value for $1}"
      shift 2
      ;;
    --edge-base)
      edge_base="${2:?missing value for $1}"
      shift 2
      ;;
    --asset-id)
      asset_id="${2:?missing value for $1}"
      shift 2
      ;;
    --dev-api-key)
      dev_api_key="${2:?missing value for $1}"
      shift 2
      ;;
    --database-url)
      database_url="${2:?missing value for $1}"
      shift 2
      ;;
    --edge-id)
      edge_id="${2:?missing value for $1}"
      shift 2
      ;;
    --edge-internal-token)
      edge_internal_token="${2:?missing value for $1}"
      shift 2
      ;;
    --control-plane-url)
      control_plane_url="${2:?missing value for $1}"
      shift 2
      ;;
    --api-env)
      api_env="${2:?missing value for $1}"
      shift 2
      ;;
    --edge-env)
      edge_env="${2:?missing value for $1}"
      shift 2
      ;;
    --rewrite-playback-base)
      rewrite_playback_base=true
      shift
      ;;
    --skip-registration)
      skip_registration=true
      shift
      ;;
    --skip-playback)
      skip_playback=true
      shift
      ;;
    --skip-analytics)
      skip_analytics=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

operator_require_command python3
operator_require_command curl

if [[ -n "$api_env" ]]; then
  operator_require_file "$api_env"
  dev_api_key="${dev_api_key:-$(operator_env_value "$api_env" REND_DEV_API_KEY 2>/dev/null || true)}"
  database_url="${database_url:-$(operator_env_value "$api_env" DATABASE_URL 2>/dev/null || true)}"
fi

if [[ -n "$edge_env" ]]; then
  operator_require_file "$edge_env"
  edge_id="${edge_id:-$(operator_env_value "$edge_env" REND_EDGE_ID 2>/dev/null || true)}"
  edge_internal_token="${edge_internal_token:-$(operator_env_value "$edge_env" REND_EDGE_INTERNAL_TOKEN 2>/dev/null || true)}"
  control_plane_url="${control_plane_url:-$(operator_env_value "$edge_env" REND_CONTROL_PLANE_URL 2>/dev/null || true)}"
  if [[ -z "${REND_EDGE_BASE_URL:-}" && "$edge_base" == "http://127.0.0.1:4100" ]]; then
    edge_base="$(operator_env_value "$edge_env" REND_EDGE_BASE_URL 2>/dev/null || printf '%s' "$edge_base")"
  fi
fi

api_base="${api_base%/}"
edge_base="${edge_base%/}"
control_plane_url="${control_plane_url%/}"

check_readyz() {
  local label="$1"
  local url="$2"
  local body_file="$tmp_dir/$label-readyz.json"
  if curl -fsS --max-time 10 "$url/readyz" -o "$body_file"; then
    operator_ok "$label /readyz passed"
  else
    operator_fail "$label /readyz failed at $url/readyz"
  fi
}

registry_sql_for_edge() {
  python3 - "$1" <<'PY'
import sys
edge_id = sys.argv[1].replace("'", "''")
print(
    "SELECT edge_id || ' ' || status || ' ' || COALESCE(to_char(last_heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '') "
    "FROM rend.edge_nodes "
    f"WHERE edge_id = '{edge_id}' AND status <> 'removed' AND last_heartbeat_at IS NOT NULL "
    "LIMIT 1"
)
PY
}

heartbeat_payload() {
  python3 - "$1" <<'PY'
import json
import sys
print(json.dumps({"edge_id": sys.argv[1], "status": "healthy", "cache_max_bytes": None}))
PY
}

check_registration() {
  if [[ "$skip_registration" == "true" ]]; then
    operator_warn "skipping edge registration visibility check"
    return 0
  fi

  if [[ -z "$edge_id" ]]; then
    operator_fail "edge registration check requires --edge-id or --edge-env"
    return 0
  fi

  if [[ -n "$database_url" ]] && command -v psql >/dev/null 2>&1; then
    local result sql
    sql="$(registry_sql_for_edge "$edge_id")"
    result="$(PGCONNECT_TIMEOUT=8 psql "$database_url" -At -c "$sql" 2>/tmp/rend-psql-error.$$ || true)"
    if [[ -n "$result" ]]; then
      operator_ok "edge registration is visible in Postgres: $result"
      rm -f /tmp/rend-psql-error.$$
      return 0
    fi
    operator_fail "edge $edge_id was not visible in rend.edge_nodes via Postgres: $(cat /tmp/rend-psql-error.$$ 2>/dev/null || true)"
    rm -f /tmp/rend-psql-error.$$
    return 0
  fi

  if [[ -n "$database_url" ]]; then
    operator_warn "psql is not installed; falling back to internal heartbeat check when possible"
  fi

  if [[ -z "$control_plane_url" || -z "$edge_internal_token" ]]; then
    operator_fail "edge registration check requires Postgres+psql or --control-plane-url plus --edge-internal-token"
    return 0
  fi

  local body_file http_code
  body_file="$tmp_dir/edge-heartbeat.json"
  http_code="$(
    curl -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
      -X POST "$control_plane_url/internal/edges/heartbeat" \
      -H "x-rend-internal-token: $edge_internal_token" \
      -H "content-type: application/json" \
      --data "$(heartbeat_payload "$edge_id")"
  )"
  if [[ "$http_code" == 2* ]]; then
    operator_ok "edge registration is visible via control-plane heartbeat endpoint"
  else
    operator_fail "edge heartbeat visibility check failed with HTTP $http_code: $(cat "$body_file")"
  fi
}

analytics_count() {
  local asset="$1"
  local body_file="$2"
  local status_code
  status_code="$(
    curl -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
      "$api_base/v1/assets/$asset/analytics/playback?window_seconds=600" \
      -H "authorization: Bearer $dev_api_key" || true
  )"
  if [[ "$status_code" != "200" ]]; then
    echo "-1"
    return 0
  fi
  python3 - "$body_file" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        print(int(json.load(f).get("request_count", 0)))
except Exception:
    print("-1")
PY
}

playback_url_from_bootstrap() {
  python3 - "$1" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
url = data.get("playback_url")
if not url:
    raise SystemExit("bootstrap response missing playback_url")
print(url)
PY
}

rewrite_playback_url() {
  python3 - "$1" "$2" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit

url, base = sys.argv[1], sys.argv[2].rstrip("/")
u = urlsplit(url)
b = urlsplit(base)
print(urlunsplit((b.scheme, b.netloc, u.path, u.query, "")))
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
raise SystemExit(0)
PY
}

check_playback_and_analytics() {
  if [[ "$skip_playback" == "true" ]]; then
    operator_warn "skipping signed playback and analytics checks"
    return 0
  fi
  if [[ -z "$asset_id" ]]; then
    operator_fail "signed playback smoke requires --asset-id"
    return 0
  fi
  if [[ -z "$dev_api_key" ]]; then
    operator_fail "signed playback smoke requires --dev-api-key or --api-env"
    return 0
  fi

  local before_count bootstrap_file status_code playback_url headers_file body_file cache_header after_count analytics_file
  analytics_file="$tmp_dir/analytics-before.json"
  before_count="$(analytics_count "$asset_id" "$analytics_file")"

  bootstrap_file="$tmp_dir/playback-bootstrap.json"
  status_code="$(
    curl -sS --max-time 15 -o "$bootstrap_file" -w "%{http_code}" \
      "$api_base/v1/assets/$asset_id/playback" \
      -H "authorization: Bearer $dev_api_key"
  )"
  if [[ "$status_code" != "200" ]]; then
    operator_fail "playback bootstrap failed with HTTP $status_code: $(cat "$bootstrap_file")"
    return 0
  fi

  playback_url="$(playback_url_from_bootstrap "$bootstrap_file")"
  if [[ "$rewrite_playback_base" == "true" ]]; then
    playback_url="$(rewrite_playback_url "$playback_url" "$edge_base")"
  fi

  headers_file="$tmp_dir/playback.headers"
  body_file="$tmp_dir/playback.body"
  status_code="$(curl -sS --max-time 20 -D "$headers_file" -o "$body_file" -w "%{http_code}" "$playback_url")"
  if [[ "$status_code" != "200" ]]; then
    operator_fail "signed playback fetch failed with HTTP $status_code"
    return 0
  fi
  if [[ ! -s "$body_file" ]]; then
    operator_fail "signed playback response body was empty"
    return 0
  fi
  cache_header="$(header_value "$headers_file" "x-rend-cache")"
  operator_ok "signed playback smoke passed${cache_header:+ with X-Rend-Cache=$cache_header}"

  if [[ "$skip_analytics" == "true" ]]; then
    operator_warn "skipping telemetry analytics smoke"
    return 0
  fi

  analytics_file="$tmp_dir/analytics-after.json"
  for _ in $(seq 1 90); do
    after_count="$(analytics_count "$asset_id" "$analytics_file")"
    if [[ "$after_count" =~ ^-?[0-9]+$ ]]; then
      if [[ "$before_count" -lt 0 && "$after_count" -ge 1 ]]; then
        operator_ok "telemetry analytics smoke passed with request_count=$after_count"
        return 0
      fi
      if [[ "$before_count" -ge 0 && "$after_count" -gt "$before_count" ]]; then
        operator_ok "telemetry analytics smoke passed; request_count increased from $before_count to $after_count"
        return 0
      fi
    fi
    sleep 1
  done
  operator_fail "telemetry analytics did not increase after signed playback; last response: $(cat "$analytics_file" 2>/dev/null || true)"
}

check_readyz "api" "$api_base"
check_readyz "edge" "$edge_base"
check_registration
check_playback_and_analytics

operator_finish
echo "First-host post-deploy verification passed"
