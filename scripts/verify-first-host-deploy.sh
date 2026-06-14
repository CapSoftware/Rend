#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

api_base="${REND_API_BASE_URL:-http://127.0.0.1:4000}"
edge_base_default="${REND_EDGE_BASE_URL:-http://127.0.0.1:4100}"
edge_internal_base_default="${REND_EDGE_INTERNAL_BASE:-${EDGE_INTERNAL_BASE:-}}"
asset_id="${ASSET_ID:-}"
dev_api_key="${REND_DEV_API_KEY:-}"
database_url="${DATABASE_URL:-}"
edge_id="${REND_EDGE_ID:-}"
expected_edges="${REND_EXPECTED_EDGES:-}"
edge_internal_token="${REND_EDGE_INTERNAL_TOKEN:-}"
control_plane_url="${REND_CONTROL_PLANE_URL:-}"
clickhouse_url="${CLICKHOUSE_URL:-}"
clickhouse_database="${CLICKHOUSE_DATABASE:-}"
clickhouse_user="${CLICKHOUSE_USER:-}"
clickhouse_password="${CLICKHOUSE_PASSWORD:-}"
api_env=""
edge_env=""
edge_bases=()
edge_internal_bases=()
edge_base_explicit=false
edge_internal_base_explicit=false
skip_registration=false
skip_public_deny=false
skip_playback=false
skip_analytics=false
rewrite_playback_base=false
run_readiness_gate=false
readiness_output="${REND_READINESS_OUTPUT:-}"
edge_labels=()
edge_public_bases=()
edge_private_bases=()

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
  --edge-base URL             Public edge base URL. May be repeated. Defaults to REND_EXPECTED_EDGES when set, else http://127.0.0.1:4100.
  --edge-internal-base URL    Private edge base URL for readyz, warm, and metrics. May be repeated in the same order as --edge-base.
  --asset-id ID               Existing hls_ready asset id for playback smoke.
  --dev-api-key KEY           API bearer key for asset and analytics endpoints.
  --database-url URL          Optional Postgres URL for edge registry visibility.
  --edge-id ID                Edge id to verify in registry.
  --expected-edges LIST       Expected edge_id=region=base_url list to verify in registry.
  --edge-internal-token TOKEN Internal edge token for heartbeat fallback.
  --control-plane-url URL     Internal API/control-plane URL for heartbeat fallback.
  --clickhouse-url URL        ClickHouse HTTP URL for telemetry health.
  --clickhouse-database NAME  ClickHouse database. Required unless --api-env provides CLICKHOUSE_DATABASE.
  --clickhouse-user USER      ClickHouse user.
  --clickhouse-password PASS  ClickHouse password.
  --api-env FILE              Read API, Postgres, and ClickHouse defaults from file.
  --edge-env FILE             Read edge id/token/control-plane/base URL defaults from file.
  --rewrite-playback-base     Rewrite API playback URL host to --edge-base before fetching.
  --run-readiness-gate        Run the synthetic playback readiness gate after verifier smokes.
  --readiness-output PATH     Readiness run artifact path.
  --skip-registration         Skip edge registration visibility check.
  --skip-public-deny          Skip public deny-surface checks for local direct-edge verification.
  --skip-playback             Skip playback and analytics checks.
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
      edge_bases+=("${2:?missing value for $1}")
      edge_base_explicit=true
      shift 2
      ;;
    --edge-internal-base)
      edge_internal_bases+=("${2:?missing value for $1}")
      edge_internal_base_explicit=true
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
    --expected-edges)
      expected_edges="${2:?missing value for $1}"
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
    --clickhouse-url)
      clickhouse_url="${2:?missing value for $1}"
      shift 2
      ;;
    --clickhouse-database)
      clickhouse_database="${2:?missing value for $1}"
      shift 2
      ;;
    --clickhouse-user)
      clickhouse_user="${2:?missing value for $1}"
      shift 2
      ;;
    --clickhouse-password)
      clickhouse_password="${2:?missing value for $1}"
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
    --run-readiness-gate)
      run_readiness_gate=true
      shift
      ;;
    --readiness-output)
      readiness_output="${2:?missing value for $1}"
      shift 2
      ;;
    --skip-registration)
      skip_registration=true
      shift
      ;;
    --skip-public-deny)
      skip_public_deny=true
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
  expected_edges="${expected_edges:-$(operator_env_value "$api_env" REND_EXPECTED_EDGES 2>/dev/null || true)}"
  clickhouse_url="${clickhouse_url:-$(operator_env_value "$api_env" CLICKHOUSE_URL 2>/dev/null || true)}"
  clickhouse_database="${clickhouse_database:-$(operator_env_value "$api_env" CLICKHOUSE_DATABASE 2>/dev/null || true)}"
  clickhouse_user="${clickhouse_user:-$(operator_env_value "$api_env" CLICKHOUSE_USER 2>/dev/null || true)}"
  clickhouse_password="${clickhouse_password:-$(operator_env_value "$api_env" CLICKHOUSE_PASSWORD 2>/dev/null || true)}"
fi

if [[ -n "$edge_env" ]]; then
  operator_require_file "$edge_env"
  edge_id="${edge_id:-$(operator_env_value "$edge_env" REND_EDGE_ID 2>/dev/null || true)}"
  expected_edges="${expected_edges:-$(operator_env_value "$edge_env" REND_EXPECTED_EDGES 2>/dev/null || true)}"
  edge_internal_token="${edge_internal_token:-$(operator_env_value "$edge_env" REND_EDGE_INTERNAL_TOKEN 2>/dev/null || true)}"
  control_plane_url="${control_plane_url:-$(operator_env_value "$edge_env" REND_CONTROL_PLANE_URL 2>/dev/null || true)}"
  if [[ "$edge_base_explicit" != "true" && -z "${REND_EDGE_BASE_URL:-}" && "$edge_base_default" == "http://127.0.0.1:4100" ]]; then
    edge_base_default="$(operator_env_value "$edge_env" REND_EDGE_BASE_URL 2>/dev/null || printf '%s' "$edge_base_default")"
  fi
fi

api_base="${api_base%/}"
control_plane_url="${control_plane_url%/}"

expected_edge_rows() {
  python3 - "$1" <<'PY'
import sys

for raw in sys.argv[1].split(","):
    parts = raw.strip().split("=", 2)
    if len(parts) != 3:
        continue
    edge_id, _region, base_url = [part.strip() for part in parts]
    if edge_id and base_url:
        print(f"{edge_id}\t{base_url.rstrip('/')}")
PY
}

append_edge_target() {
  local label="$1"
  local public_base="$2"
  local private_base="$3"
  edge_labels+=("$label")
  edge_public_bases+=("${public_base%/}")
  edge_private_bases+=("${private_base%/}")
}

initialize_edge_targets() {
  local row label public_base private_base index

  if [[ ${#edge_bases[@]} -eq 0 && -n "$expected_edges" ]]; then
    while IFS=$'\t' read -r label public_base; do
      [[ -n "$label" && -n "$public_base" ]] || continue
      edge_bases+=("$public_base")
      edge_labels+=("$label")
    done < <(expected_edge_rows "$expected_edges")
  fi

  if [[ ${#edge_bases[@]} -eq 0 ]]; then
    edge_bases+=("$edge_base_default")
    edge_labels+=("${edge_id:-edge}")
  elif [[ ${#edge_labels[@]} -ne ${#edge_bases[@]} ]]; then
    edge_labels=()
    for index in "${!edge_bases[@]}"; do
      edge_labels+=("edge-$((index + 1))")
    done
  fi

  if [[ ${#edge_internal_bases[@]} -eq 0 && -n "$edge_internal_base_default" ]]; then
    if [[ ${#edge_bases[@]} -eq 1 ]]; then
      edge_internal_bases+=("$edge_internal_base_default")
    else
      operator_warn "REND_EDGE_INTERNAL_BASE/EDGE_INTERNAL_BASE applies to one edge; pass repeated --edge-internal-base values for multi-edge verification"
    fi
  fi

  local selected_edge_labels=("${edge_labels[@]}")
  edge_labels=()
  edge_public_bases=()
  edge_private_bases=()
  for index in "${!edge_bases[@]}"; do
    public_base="${edge_bases[$index]}"
    if [[ ${#edge_internal_bases[@]} -gt "$index" ]]; then
      private_base="${edge_internal_bases[$index]}"
    else
      private_base="$public_base"
    fi
    append_edge_target "${selected_edge_labels[$index]}" "$public_base" "$private_base"
  done

  if [[ "$edge_internal_base_explicit" == "true" && ${#edge_internal_bases[@]} -ne ${#edge_bases[@]} ]]; then
    operator_fail "--edge-internal-base must be repeated once per --edge-base/expected edge"
  fi
}

initialize_edge_targets

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

registry_sql_for_expected_edges() {
  python3 - "$1" <<'PY'
import sys
edge_ids = []
for raw in sys.argv[1].split(","):
    parts = raw.strip().split("=", 2)
    if len(parts) == 3:
        edge_ids.append(parts[0].replace("'", "''"))
if not edge_ids:
    raise SystemExit("REND_EXPECTED_EDGES did not contain any edge ids")
quoted = ",".join(f"'{edge_id}'" for edge_id in edge_ids)
print(
    "SELECT edge_id, region, COALESCE(base_url, ''), status, "
    "(last_heartbeat_at IS NOT NULL AND last_heartbeat_at >= now() - interval '120 seconds')::text "
    "FROM rend.edge_nodes "
    f"WHERE edge_id IN ({quoted}) AND status <> 'removed' "
    "ORDER BY edge_id"
)
PY
}

validate_expected_edge_rows() {
  python3 - "$1" "$2" <<'PY'
import sys

expected_raw, rows_raw = sys.argv[1], sys.argv[2]
expected = {}
for raw in expected_raw.split(","):
    parts = raw.strip().split("=", 2)
    if len(parts) == 3:
        expected[parts[0].strip()] = (parts[1].strip(), parts[2].strip().rstrip("/"))

rows = {}
for line in rows_raw.splitlines():
    cols = line.split("\t")
    if len(cols) >= 5:
        edge_id, region, base_url, status, active = cols[:5]
        rows[edge_id] = (region, base_url.rstrip("/"), status, active)

missing = sorted(set(expected) - set(rows))
if missing:
    raise SystemExit(f"missing expected edge registrations: {', '.join(missing)}")

bad = []
for edge_id, (region, base_url) in expected.items():
    row_region, row_base_url, status, active = rows[edge_id]
    if row_region != region:
        bad.append(f"{edge_id} region {row_region!r} != {region!r}")
    if row_base_url != base_url:
        bad.append(f"{edge_id} base_url {row_base_url!r} != {base_url!r}")
    if status != "healthy":
        bad.append(f"{edge_id} status {status!r} != 'healthy'")
    if active != "true":
        bad.append(f"{edge_id} heartbeat is stale or missing")
if bad:
    raise SystemExit("; ".join(bad))
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

  if [[ -n "$expected_edges" ]]; then
    if [[ -z "$database_url" ]] || ! command -v psql >/dev/null 2>&1; then
      operator_fail "expected edge registry check requires --database-url/--api-env and psql"
      return 0
    fi
    local rows sql psql_url
    sql="$(registry_sql_for_expected_edges "$expected_edges")"
    psql_url="$(operator_psql_database_url "$database_url")"
    if [[ "$psql_url" != "$database_url" ]]; then
      operator_info "normalized DATABASE_URL for psql by removing sslrootcert=system"
    fi
    rows="$(PGCONNECT_TIMEOUT=8 psql "$psql_url" -F $'\t' -At -c "$sql" 2>/tmp/rend-psql-error.$$ || true)"
    if validate_expected_edge_rows "$expected_edges" "$rows" 2>/tmp/rend-edge-registry-error.$$; then
      operator_ok "all expected edges are registered healthy"
    else
      operator_fail "expected edge registry check failed: $(cat /tmp/rend-edge-registry-error.$$)"
    fi
    rm -f /tmp/rend-psql-error.$$ /tmp/rend-edge-registry-error.$$
    return 0
  fi

  if [[ -z "$edge_id" ]]; then
    operator_fail "edge registration check requires --edge-id or --edge-env"
    return 0
  fi

  if [[ -n "$database_url" ]] && command -v psql >/dev/null 2>&1; then
    local result sql psql_url
    sql="$(registry_sql_for_edge "$edge_id")"
    psql_url="$(operator_psql_database_url "$database_url")"
    if [[ "$psql_url" != "$database_url" ]]; then
      operator_info "normalized DATABASE_URL for psql by removing sslrootcert=system"
    fi
    result="$(PGCONNECT_TIMEOUT=8 psql "$psql_url" -At -c "$sql" 2>/tmp/rend-psql-error.$$ || true)"
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

check_clickhouse_telemetry() {
  if [[ -z "$clickhouse_url" ]]; then
    operator_fail "ClickHouse telemetry health requires --clickhouse-url or --api-env"
    return 0
  fi
  if [[ -z "$clickhouse_database" ]]; then
    operator_fail "ClickHouse telemetry health requires --clickhouse-database or CLICKHOUSE_DATABASE from --api-env"
    return 0
  fi
  if [[ -z "$clickhouse_user" || -z "$clickhouse_password" ]]; then
    operator_fail "ClickHouse telemetry health requires --clickhouse-user/--clickhouse-password or CLICKHOUSE_USER/CLICKHOUSE_PASSWORD from --api-env"
    return 0
  fi

  local url body_file exists
  url="${clickhouse_url%/}"
  body_file="$tmp_dir/clickhouse-telemetry-health.txt"
  if ! curl -fsS --max-time 10 -u "$clickhouse_user:$clickhouse_password" \
    "$url/?database=$clickhouse_database&query=SELECT%201" -o "$body_file"; then
    operator_fail "ClickHouse SELECT 1 telemetry health probe failed"
    return 0
  fi
  exists="$(
    curl -fsS --max-time 10 -u "$clickhouse_user:$clickhouse_password" \
      "$url/?database=$clickhouse_database&query=EXISTS%20TABLE%20playback_events" || true
  )"
  if [[ "$exists" == "1" ]]; then
    operator_ok "ClickHouse playback telemetry table is present"
  else
    operator_fail "ClickHouse playback_events table is missing or not queryable"
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

expect_public_denied() {
  local edge_label="$1"
  local base_url="$2"
  local method="$3"
  local path="$4"
  local body_file="$tmp_dir/public-deny-${edge_label//[^A-Za-z0-9_.-]/_}-${method}-${path//[^A-Za-z0-9_.-]/_}.body"
  local status_code
  status_code="$(
    curl -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
      -X "$method" "$base_url$path" || true
  )"
  if [[ "$status_code" == "404" ]]; then
    operator_ok "$edge_label public $method $path returned 404"
  else
    operator_fail "$edge_label public $method $path expected 404, got HTTP $status_code"
  fi
}

check_public_deny_surface() {
  if [[ "$skip_public_deny" == "true" ]]; then
    operator_warn "skipping public edge deny-surface checks"
    return 0
  fi

  local index edge_label public_base
  for index in "${!edge_public_bases[@]}"; do
    edge_label="${edge_labels[$index]}"
    public_base="${edge_public_bases[$index]}"
    expect_public_denied "$edge_label" "$public_base" "POST" "/internal/warm"
    expect_public_denied "$edge_label" "$public_base" "POST" "/internal/purge"
    expect_public_denied "$edge_label" "$public_base" "GET" "/metrics"
    expect_public_denied "$edge_label" "$public_base" "GET" "/v/probe"
    expect_public_denied "$edge_label" "$public_base" "GET" "/v/not-a-uuid/hls/master.m3u8?token=invalid"
  done
}

artifact_path_from_playback_url() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import urlsplit

path = urlsplit(sys.argv[1]).path.strip("/")
parts = path.split("/")
if len(parts) < 3 or parts[0] != "v":
    raise SystemExit("playback_url did not use /v/<asset_id>/<artifact_path>")
print("/".join(parts[2:]))
PY
}

warm_payload() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

asset_id, artifact_path = sys.argv[1:3]
print(json.dumps({"asset_id": asset_id, "artifact_paths": [artifact_path]}, separators=(",", ":")))
PY
}

metric_value() {
  local metrics_file="$1"
  local metric_name="$2"
  local required_label="${3:-}"
  python3 - "$metrics_file" "$metric_name" "$required_label" <<'PY'
import re
import sys

path, metric, required = sys.argv[1:4]
pattern = re.compile(rf"^{re.escape(metric)}(?:\{{([^}}]*)\}})?\s+([-+]?[0-9]+(?:\.[0-9]+)?)$")
try:
    lines = open(path, "r", encoding="utf-8").read().splitlines()
except FileNotFoundError:
    print("-1")
    raise SystemExit(0)
for line in lines:
    match = pattern.match(line.strip())
    if not match:
        continue
    labels = match.group(1) or ""
    if required and required not in labels:
        continue
    print(match.group(2))
    raise SystemExit(0)
print("-1")
PY
}

fetch_edge_metrics() {
  local edge_label="$1"
  local private_base="$2"
  local output_file="$3"
  local status_code
  status_code="$(
    curl -sS --max-time 10 -o "$output_file" -w "%{http_code}" \
      "$private_base/metrics" \
      -H "x-rend-internal-token: $edge_internal_token" || true
  )"
  if [[ "$status_code" == "200" ]]; then
    return 0
  fi
  operator_fail "$edge_label private metrics check failed with HTTP $status_code"
  return 1
}

edge_region_for_label() {
  python3 - "$expected_edges" "$1" <<'PY'
import sys

expected_edges, wanted = sys.argv[1:3]
for raw in expected_edges.split(","):
    parts = raw.strip().split("=", 2)
    if len(parts) == 3 and parts[0].strip() == wanted:
        print(parts[1].strip() or "unknown")
        raise SystemExit(0)
print("unknown")
PY
}

readiness_edges_env_value() {
  local entries=()
  local index edge_label region public_base private_base
  for index in "${!edge_public_bases[@]}"; do
    edge_label="${edge_labels[$index]}"
    region="$(edge_region_for_label "$edge_label")"
    public_base="${edge_public_bases[$index]}"
    private_base="${edge_private_bases[$index]}"
    entries+=("$edge_label=$region=$public_base=$private_base")
  done
  local IFS=,
  printf '%s' "${entries[*]}"
}

run_playback_readiness_gate() {
  if [[ "$run_readiness_gate" != "true" ]]; then
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    operator_fail "node is required for the playback readiness gate"
    return 0
  fi
  if [[ -z "$dev_api_key" ]]; then
    operator_fail "playback readiness gate requires --dev-api-key or --api-env"
    return 0
  fi
  if [[ -z "$edge_internal_token" ]]; then
    operator_fail "playback readiness gate requires --edge-internal-token or --edge-env"
    return 0
  fi

  local readiness_edges
  readiness_edges="$(readiness_edges_env_value)"
  local env_vars=(
    "REND_READINESS_TARGET=configured"
    "REND_API_BASE_URL=$api_base"
    "REND_READINESS_API_KEY=$dev_api_key"
    "REND_EDGE_INTERNAL_TOKEN=$edge_internal_token"
    "REND_READINESS_EDGES=$readiness_edges"
    "REND_READINESS_SKIP_LOCAL_STACK=1"
  )
  if [[ -n "$readiness_output" ]]; then
    env_vars+=("REND_READINESS_OUTPUT=$readiness_output")
  fi

  if env "${env_vars[@]}" node "$root_dir/scripts/playback-readiness-gate.mjs" --target configured --skip-local-stack; then
    operator_ok "playback readiness gate passed"
  else
    operator_fail "playback readiness gate failed"
  fi
}

check_playback_and_analytics() {
  if [[ "$skip_playback" == "true" ]]; then
    operator_warn "skipping playback and analytics checks"
    return 0
  fi
  if [[ -z "$asset_id" ]]; then
    operator_fail "playback smoke requires --asset-id"
    return 0
  fi
  if [[ -z "$dev_api_key" ]]; then
    operator_fail "playback smoke requires --dev-api-key or --api-env"
    return 0
  fi
  if [[ -z "$edge_internal_token" ]]; then
    operator_fail "warmed playback smoke requires --edge-internal-token or --edge-env"
    return 0
  fi

  local before_count bootstrap_file cookie_file playback_cookie_header status_code playback_url artifact_path analytics_file
  local index edge_label public_base private_base payload body_file headers_file cache_header playback_target
  local successes expected_count after_count metrics_file dropped_before dropped_after spool_bytes
  analytics_file="$tmp_dir/analytics-before.json"
  before_count="$(analytics_count "$asset_id" "$analytics_file")"

  bootstrap_file="$tmp_dir/playback-bootstrap.json"
  cookie_file="$tmp_dir/playback.cookies"
  status_code="$(
    curl -sS --max-time 15 -c "$cookie_file" -o "$bootstrap_file" -w "%{http_code}" \
      "$api_base/v1/assets/$asset_id/playback" \
      -H "authorization: Bearer $dev_api_key"
  )"
  if [[ "$status_code" != "200" ]]; then
    operator_fail "playback bootstrap failed with HTTP $status_code: $(cat "$bootstrap_file")"
    return 0
  fi
  playback_cookie_header="$(
    awk '$6 == "__rend_playback" { print "Cookie: __rend_playback=" $7; exit }' "$cookie_file"
  )"
  if [[ -z "$playback_cookie_header" ]]; then
    operator_fail "playback bootstrap did not set playback cookie"
    return 0
  fi

  playback_url="$(playback_url_from_bootstrap "$bootstrap_file")"
  if ! artifact_path="$(artifact_path_from_playback_url "$playback_url" 2>/tmp/rend-playback-url-error.$$)"; then
    operator_fail "$(cat /tmp/rend-playback-url-error.$$)"
    rm -f /tmp/rend-playback-url-error.$$
    return 0
  fi
  rm -f /tmp/rend-playback-url-error.$$

  successes=0
  for index in "${!edge_public_bases[@]}"; do
    edge_label="${edge_labels[$index]}"
    public_base="${edge_public_bases[$index]}"
    private_base="${edge_private_bases[$index]}"

    metrics_file="$tmp_dir/metrics-before-$index.txt"
    if fetch_edge_metrics "$edge_label" "$private_base" "$metrics_file"; then
      dropped_before="$(metric_value "$metrics_file" "rend_edge_telemetry_events_total" 'state="dropped"')"
    else
      dropped_before="-1"
    fi

    payload="$(warm_payload "$asset_id" "$artifact_path")"
    body_file="$tmp_dir/warm-$index.json"
    status_code="$(
      curl -sS --max-time 20 -o "$body_file" -w "%{http_code}" \
        -X POST "$private_base/internal/warm" \
        -H "x-rend-internal-token: $edge_internal_token" \
        -H "content-type: application/json" \
        --data "$payload" || true
    )"
    if [[ "$status_code" != 2* ]]; then
      operator_fail "$edge_label warm probe failed with HTTP $status_code: $(cat "$body_file" 2>/dev/null || true)"
      continue
    fi

    playback_target="$playback_url"
    if [[ "$rewrite_playback_base" == "true" || ${#edge_public_bases[@]} -gt 1 ]]; then
      playback_target="$(rewrite_playback_url "$playback_url" "$public_base")"
    fi

    headers_file="$tmp_dir/playback-$index.headers"
    body_file="$tmp_dir/playback-$index.body"
    status_code="$(curl -sS --max-time 20 -H "$playback_cookie_header" -D "$headers_file" -o "$body_file" -w "%{http_code}" "$playback_target" || true)"
    if [[ "$status_code" != "200" ]]; then
      operator_fail "$edge_label playback fetch failed with HTTP $status_code"
      continue
    fi
    if [[ ! -s "$body_file" ]]; then
      operator_fail "$edge_label playback response body was empty"
      continue
    fi
    cache_header="$(header_value "$headers_file" "x-rend-cache")"
    if [[ "$cache_header" != "HIT" ]]; then
      operator_fail "$edge_label warmed playback expected X-Rend-Cache=HIT, got ${cache_header:-missing}"
      continue
    fi
    operator_ok "$edge_label warmed playback HIT passed"
    successes=$((successes + 1))

    for _ in $(seq 1 90); do
      metrics_file="$tmp_dir/metrics-after-$index.txt"
      if ! fetch_edge_metrics "$edge_label" "$private_base" "$metrics_file"; then
        break
      fi
      dropped_after="$(metric_value "$metrics_file" "rend_edge_telemetry_events_total" 'state="dropped"')"
      spool_bytes="$(metric_value "$metrics_file" "rend_edge_telemetry_spool_bytes")"
      if [[ "$spool_bytes" == "0" ]]; then
        if [[ "$dropped_before" =~ ^-?[0-9]+(\.[0-9]+)?$ && "$dropped_after" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
          if python3 - "$dropped_before" "$dropped_after" <<'PY'
import sys
before, after = map(float, sys.argv[1:3])
raise SystemExit(0 if after <= before else 1)
PY
          then
            operator_ok "$edge_label telemetry spool returned to 0 bytes with no dropped-event increase"
            break
          fi
        fi
      fi
      sleep 1
    done

    metrics_file="$tmp_dir/metrics-after-$index.txt"
    dropped_after="$(metric_value "$metrics_file" "rend_edge_telemetry_events_total" 'state="dropped"')"
    spool_bytes="$(metric_value "$metrics_file" "rend_edge_telemetry_spool_bytes")"
    if [[ "$spool_bytes" != "0" ]]; then
      operator_fail "$edge_label telemetry spool did not return to 0 bytes; last value: $spool_bytes"
    fi
    if [[ "$dropped_before" =~ ^-?[0-9]+(\.[0-9]+)?$ && "$dropped_after" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
      if ! python3 - "$dropped_before" "$dropped_after" <<'PY'
import sys
before, after = map(float, sys.argv[1:3])
raise SystemExit(0 if after <= before else 1)
PY
      then
        operator_fail "$edge_label telemetry dropped counter increased from $dropped_before to $dropped_after"
      fi
    fi
  done

  if [[ "$successes" -ne "${#edge_public_bases[@]}" ]]; then
    operator_fail "warmed playback passed on $successes/${#edge_public_bases[@]} edge(s)"
  fi

  if [[ "$skip_analytics" == "true" ]]; then
    operator_warn "skipping telemetry analytics smoke"
    return 0
  fi

  analytics_file="$tmp_dir/analytics-after.json"
  expected_count="$successes"
  for _ in $(seq 1 90); do
    after_count="$(analytics_count "$asset_id" "$analytics_file")"
    if [[ "$after_count" =~ ^-?[0-9]+$ ]]; then
      if [[ "$before_count" -lt 0 && "$after_count" -ge "$expected_count" ]]; then
        operator_ok "telemetry analytics smoke passed with request_count=$after_count"
        return 0
      fi
      if [[ "$before_count" -ge 0 && "$after_count" -ge $((before_count + expected_count)) ]]; then
        operator_ok "telemetry analytics smoke passed; request_count increased from $before_count to $after_count"
        return 0
      fi
    fi
    sleep 1
  done
  operator_fail "telemetry analytics did not increase after signed playback; last response: $(cat "$analytics_file" 2>/dev/null || true)"
}

check_readyz "api" "$api_base"
for index in "${!edge_private_bases[@]}"; do
  check_readyz "edge ${edge_labels[$index]}" "${edge_private_bases[$index]}"
done
check_registration
check_clickhouse_telemetry
check_public_deny_surface
check_playback_and_analytics
run_playback_readiness_gate

operator_finish
echo "First-host post-deploy verification passed"
