#!/usr/bin/env bash

operator_root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
operator_failures="${operator_failures:-0}"

operator_info() {
  echo "[info] $*"
}

operator_ok() {
  echo "[ok] $*"
}

operator_warn() {
  echo "[warn] $*" >&2
}

operator_fail() {
  echo "[fail] $*" >&2
  operator_failures=$((operator_failures + 1))
}

operator_die() {
  echo "error: $*" >&2
  exit 1
}

operator_finish() {
  if [[ "$operator_failures" != "0" ]]; then
    echo "preflight failed with $operator_failures error(s)" >&2
    exit 1
  fi
}

operator_is_truthy() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1 | true | yes | y | on) return 0 ;;
    *) return 1 ;;
  esac
}

operator_normalize_platform() {
  python3 - "$1" <<'PY'
import re
import sys

platform = sys.argv[1].strip().lower()
if not re.fullmatch(r"[a-z0-9]+/[a-z0-9_]+(?:/[a-z0-9_.-]+)?", platform):
    print(f"invalid Docker platform: {platform}", file=sys.stderr)
    raise SystemExit(1)
os_name, _architecture, *_variant = platform.split("/")
if os_name != "linux":
    print("release image platform must target linux hosts", file=sys.stderr)
    raise SystemExit(1)
print(platform)
PY
}

operator_psql_database_url() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

url = sys.argv[1]
parts = urlsplit(url)
query = [
    (key, value)
    for key, value in parse_qsl(parts.query, keep_blank_values=True)
    if not (key.lower() == "sslrootcert" and value.lower() == "system")
]
print(urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)))
PY
}

operator_require_command() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    operator_ok "$command_name is available"
  else
    operator_fail "$command_name is required"
  fi
}

operator_require_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    operator_ok "found $file"
  else
    operator_fail "missing file: $file"
  fi
}

operator_env_value() {
  local file="$1"
  local key="$2"
  python3 - "$file" "$key" <<'PY'
import sys

path, wanted = sys.argv[1], sys.argv[2]
try:
    lines = open(path, "r", encoding="utf-8").read().splitlines()
except FileNotFoundError:
    raise SystemExit(1)

for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        continue
    if stripped.startswith("export "):
        stripped = stripped[len("export "):].lstrip()
    if "=" not in stripped:
        continue
    key, value = stripped.split("=", 1)
    if key.strip() != wanted:
        continue
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    print(value)
    raise SystemExit(0)

raise SystemExit(1)
PY
}

operator_env_has_key() {
  local file="$1"
  local key="$2"
  operator_env_value "$file" "$key" >/dev/null 2>&1
}

operator_require_env_present() {
  local file="$1"
  local key="$2"
  if operator_env_has_key "$file" "$key"; then
    return 0
  fi
  operator_fail "$file is missing env var: $key"
  return 1
}

operator_require_env_nonempty() {
  local file="$1"
  local key="$2"
  local value
  if ! operator_env_has_key "$file" "$key"; then
    operator_fail "$file is missing env var: $key"
    return 1
  fi
  value="$(operator_env_value "$file" "$key")"
  if [[ -z "$value" ]]; then
    operator_fail "$file has empty required env var: $key"
    return 1
  fi
}

operator_value_is_placeholder() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    *replace-me* | *changeme* | *change-me* | *placeholder* | *example.com* | *example.org* | *example.net* | \<*\>)
      return 0
      ;;
    postgres://rend:replace-me@* | *api-internal.example.com* | *object-store.example.com*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

operator_value_is_dev_default() {
  local key="$1"
  local value
  value="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    dev-api-key | dev-internal-token | local-site-internal-token | local-dev-playback-key | local-dev-playback-signing-secret)
      return 0
      ;;
    rend-local | rend_minio | rend_minio_password | local | local-edge-001 | docker-media-worker-001)
      return 0
      ;;
    rend)
      [[ "$key" == "CLICKHOUSE_PASSWORD" ]] && return 0
      return 1
      ;;
    *localhost* | *127.0.0.1* | *"//postgres:"* | *"@postgres:"* | *"//redis:"* | *"//minio:"* | *"//clickhouse:"* | *"//rend-api:"* | *"//rend-edge:"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

operator_check_env_policy() {
  local file="$1"
  local key="$2"
  local allow_dev_defaults="$3"
  local allow_placeholders="$4"
  local value

  if ! operator_env_has_key "$file" "$key"; then
    return 0
  fi
  value="$(operator_env_value "$file" "$key")"
  if [[ -z "$value" ]]; then
    return 0
  fi

  if [[ "$allow_placeholders" != "true" ]] && operator_value_is_placeholder "$value"; then
    operator_fail "$file $key contains a placeholder value"
  fi
  if [[ "$allow_dev_defaults" != "true" ]] && operator_value_is_dev_default "$key" "$value"; then
    operator_fail "$file $key contains a local/dev default"
  fi
}

operator_check_all_env_policies() {
  local file="$1"
  local allow_dev_defaults="$2"
  local allow_placeholders="$3"
  shift 3
  local key
  for key in "$@"; do
    operator_check_env_policy "$file" "$key" "$allow_dev_defaults" "$allow_placeholders"
  done
}

operator_validate_http_url_value() {
  local label="$1"
  local value="$2"
  local expected_path="${3:-}"
  python3 - "$label" "$value" "$expected_path" <<'PY'
import sys
from urllib.parse import urlparse

label, value, expected_path = sys.argv[1], sys.argv[2].strip(), sys.argv[3]
parsed = urlparse(value)
if parsed.scheme not in {"http", "https"} or not parsed.hostname:
    print(f"{label} must be an absolute http(s) URL", file=sys.stderr)
    raise SystemExit(1)
if parsed.username or parsed.password or parsed.fragment:
    print(f"{label} must not include credentials or fragment", file=sys.stderr)
    raise SystemExit(1)
if expected_path and parsed.path.rstrip("/") != expected_path.rstrip("/"):
    print(f"{label} path must be {expected_path}", file=sys.stderr)
    raise SystemExit(1)
if parsed.port is not None and not (1 <= parsed.port <= 65535):
    print(f"{label} port must be 1-65535", file=sys.stderr)
    raise SystemExit(1)
PY
}

operator_check_http_url() {
  local file="$1"
  local key="$2"
  local expected_path="${3:-}"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  if [[ -z "$value" ]]; then
    return 0
  fi
  if operator_validate_http_url_value "$key" "$value" "$expected_path" >/dev/null; then
    operator_ok "$key has a valid URL"
  else
    operator_fail "$(operator_validate_http_url_value "$key" "$value" "$expected_path" 2>&1 >/dev/null)"
  fi
}

operator_check_http_origin_list() {
  local file="$1"
  local key="$2"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  [[ -n "$value" ]] || return 0
  if python3 - "$key" "$value" <<'PY'
import sys
from urllib.parse import urlparse

key, value = sys.argv[1], sys.argv[2]
origins = [item.strip() for item in value.split(",") if item.strip()]
if not origins:
    print(f"{key} must include at least one origin", file=sys.stderr)
    raise SystemExit(1)
for origin in origins:
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        print(f"{key} entry must be an absolute http(s) origin: {origin}", file=sys.stderr)
        raise SystemExit(1)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        print(f"{key} entries must not include credentials, query, or fragment: {origin}", file=sys.stderr)
        raise SystemExit(1)
    if parsed.path not in {"", "/"}:
        print(f"{key} entries must be origins only: {origin}", file=sys.stderr)
        raise SystemExit(1)
    if parsed.port is not None and not (1 <= parsed.port <= 65535):
        print(f"{key} port must be 1-65535: {origin}", file=sys.stderr)
        raise SystemExit(1)
PY
  then
    operator_ok "$key has valid HTTP origins"
  else
    operator_fail "$(python3 - "$key" "$value" <<'PY' 2>&1 >/dev/null
import sys
from urllib.parse import urlparse
key, value = sys.argv[1], sys.argv[2]
origins = [item.strip() for item in value.split(",") if item.strip()]
if not origins:
    print(f"{key} must include at least one origin", file=sys.stderr)
    raise SystemExit(1)
for origin in origins:
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        print(f"{key} entry must be an absolute http(s) origin: {origin}", file=sys.stderr)
        raise SystemExit(1)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        print(f"{key} entries must not include credentials, query, or fragment: {origin}", file=sys.stderr)
        raise SystemExit(1)
    if parsed.path not in {"", "/"}:
        print(f"{key} entries must be origins only: {origin}", file=sys.stderr)
        raise SystemExit(1)
    if parsed.port is not None and not (1 <= parsed.port <= 65535):
        print(f"{key} port must be 1-65535: {origin}", file=sys.stderr)
        raise SystemExit(1)
PY
)"
  fi
}

operator_check_database_url() {
  local file="$1"
  local key="$2"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  [[ -n "$value" ]] || return 0
  if python3 - "$key" "$value" <<'PY'
import sys
from urllib.parse import urlparse

key, value = sys.argv[1], sys.argv[2]
parsed = urlparse(value)
if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
    print(f"{key} must be a postgres:// or postgresql:// URL with a host", file=sys.stderr)
    raise SystemExit(1)
if not parsed.path or parsed.path == "/":
    print(f"{key} must include a database name", file=sys.stderr)
    raise SystemExit(1)
if parsed.port is not None and not (1 <= parsed.port <= 65535):
    print(f"{key} port must be 1-65535", file=sys.stderr)
    raise SystemExit(1)
PY
  then
    operator_ok "$key has a valid Postgres URL"
  else
    operator_fail "$(python3 - "$key" "$value" <<'PY' 2>&1 >/dev/null
import sys
from urllib.parse import urlparse
key, value = sys.argv[1], sys.argv[2]
parsed = urlparse(value)
if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
    print(f"{key} must be a postgres:// or postgresql:// URL with a host", file=sys.stderr)
    raise SystemExit(1)
if not parsed.path or parsed.path == "/":
    print(f"{key} must include a database name", file=sys.stderr)
    raise SystemExit(1)
if parsed.port is not None and not (1 <= parsed.port <= 65535):
    print(f"{key} port must be 1-65535", file=sys.stderr)
    raise SystemExit(1)
PY
)"
  fi
}

operator_check_redis_url() {
  local file="$1"
  local key="$2"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  [[ -n "$value" ]] || return 0
  if python3 - "$key" "$value" <<'PY'
import sys
from urllib.parse import urlparse

key, value = sys.argv[1], sys.argv[2]
parsed = urlparse(value)
if parsed.scheme not in {"redis", "rediss"} or not parsed.hostname:
    print(f"{key} must be a redis:// or rediss:// URL with a host", file=sys.stderr)
    raise SystemExit(1)
if parsed.port is not None and not (1 <= parsed.port <= 65535):
    print(f"{key} port must be 1-65535", file=sys.stderr)
    raise SystemExit(1)
PY
  then
    operator_ok "$key has a valid Redis URL"
  else
    operator_fail "$key is not a valid Redis URL"
  fi
}

operator_check_bind_addr() {
  local file="$1"
  local key="$2"
  local expected_port="${3:-}"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  [[ -n "$value" ]] || return 0
  if python3 - "$key" "$value" "$expected_port" <<'PY'
import sys

key, value, expected = sys.argv[1], sys.argv[2].strip(), sys.argv[3]
if value.startswith("["):
    end = value.find("]")
    if end == -1 or end + 2 > len(value) or value[end + 1] != ":":
        print(f"{key} must be host:port", file=sys.stderr)
        raise SystemExit(1)
    host, port_s = value[1:end], value[end + 2:]
elif ":" in value:
    host, port_s = value.rsplit(":", 1)
else:
    print(f"{key} must be host:port", file=sys.stderr)
    raise SystemExit(1)
if not host:
    print(f"{key} host must not be empty", file=sys.stderr)
    raise SystemExit(1)
try:
    port = int(port_s)
except ValueError:
    print(f"{key} port must be numeric", file=sys.stderr)
    raise SystemExit(1)
if not 1 <= port <= 65535:
    print(f"{key} port must be 1-65535", file=sys.stderr)
    raise SystemExit(1)
if expected and port != int(expected):
    print(f"{key} must bind container port {expected}", file=sys.stderr)
    raise SystemExit(1)
PY
  then
    operator_ok "$key has a valid bind address"
  else
    operator_fail "$key is not a valid bind address"
  fi
}

operator_check_bool() {
  local file="$1"
  local key="$2"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  [[ -n "$value" ]] || return 0
  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    true | false) operator_ok "$key is boolean" ;;
    *) operator_fail "$key must be true or false" ;;
  esac
}

operator_check_rend_env() {
  local file="$1"
  local allow_dev_defaults="$2"
  local value
  value="$(operator_env_value "$file" REND_ENV 2>/dev/null || true)"
  case "$value" in
    local | production)
      operator_ok "REND_ENV is $value"
      ;;
    *)
      operator_fail "REND_ENV must be one of: local, production"
      return 0
      ;;
  esac
  if [[ "$value" == "local" && "$allow_dev_defaults" != "true" ]]; then
    operator_fail "REND_ENV=local is only permitted with --allow-dev-defaults"
  fi
}

operator_check_billing_mode() {
  local file="$1"
  local allow_dev_defaults="$2"
  local value rend_env
  value="$(operator_env_value "$file" REND_BILLING_MODE 2>/dev/null || true)"
  rend_env="$(operator_env_value "$file" REND_ENV 2>/dev/null || true)"
  case "$value" in
    local | autumn)
      operator_ok "REND_BILLING_MODE is $value"
      ;;
    *)
      operator_fail "REND_BILLING_MODE must be one of: local, autumn"
      return 0
      ;;
  esac
  if [[ "$rend_env" == "production" && "$value" != "autumn" && "$allow_dev_defaults" != "true" ]]; then
    operator_fail "REND_BILLING_MODE=autumn is required when REND_ENV is production"
  fi
}

operator_check_billing_failure_policy() {
  local file="$1"
  local key="REND_BILLING_ENTITLEMENT_FAILURE_POLICY"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  case "$value" in
    fail_closed | fail_open)
      operator_ok "$key is $value"
      ;;
    *)
      operator_fail "$key must be fail_closed or fail_open"
      ;;
  esac
}

operator_check_billing_secret() {
  local file="$1"
  local mode
  mode="$(operator_env_value "$file" REND_BILLING_MODE 2>/dev/null || true)"
  if [[ "$mode" == "autumn" ]]; then
    operator_require_env_nonempty "$file" AUTUMN_SECRET_KEY
  else
    operator_require_env_present "$file" AUTUMN_SECRET_KEY
  fi
}

operator_check_positive_int() {
  local file="$1"
  local key="$2"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  [[ -n "$value" ]] || return 0
  if [[ "$value" =~ ^[0-9]+$ ]] && [[ "$value" -gt 0 ]]; then
    operator_ok "$key is a positive integer"
  else
    operator_fail "$key must be a positive integer"
  fi
}

operator_check_nonnegative_optional_int() {
  local file="$1"
  local key="$2"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  [[ -n "$value" ]] || return 0
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    operator_ok "$key is a non-negative integer"
  else
    operator_fail "$key must be empty or a non-negative integer"
  fi
}

operator_check_expected_edges() {
  local file="$1"
  local allow_dev_defaults="$2"
  local value rend_env allow_insecure
  value="$(operator_env_value "$file" REND_EXPECTED_EDGES 2>/dev/null || true)"
  rend_env="$(operator_env_value "$file" REND_ENV 2>/dev/null || true)"
  allow_insecure="$(operator_env_value "$file" REND_ALLOW_INSECURE_EDGE_URLS 2>/dev/null || true)"
  if python3 - "$value" "$rend_env" "$allow_insecure" "$allow_dev_defaults" <<'PY'
import re
import sys
from urllib.parse import urlparse

value, rend_env, allow_insecure, allow_dev_defaults = sys.argv[1:5]
allow_insecure = allow_insecure.lower() == "true"
allow_dev_defaults = allow_dev_defaults == "true"
strict = rend_env == "production"

if allow_insecure and not allow_dev_defaults:
    print("REND_ALLOW_INSECURE_EDGE_URLS=true is only permitted with --allow-dev-defaults", file=sys.stderr)
    raise SystemExit(1)

if not value.strip():
    if strict:
        print("REND_EXPECTED_EDGES must not be empty when REND_ENV is production", file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(0)

seen = set()
local_hosts = {
    "localhost", "0.0.0.0", "::", "::1", "postgres", "redis", "minio",
    "clickhouse", "rend-api", "rend-edge", "rend-edge-us-east", "rend-edge-london",
}
for raw in value.split(","):
    raw = raw.strip()
    if not raw:
        continue
    parts = raw.split("=", 2)
    if len(parts) != 3:
        print("REND_EXPECTED_EDGES entries must use edge_id=region=base_url", file=sys.stderr)
        raise SystemExit(1)
    edge_id, region, base_url = [part.strip() for part in parts]
    if not re.match(r"^[A-Za-z0-9_.-]{1,128}$", edge_id):
        print(f"invalid edge id in REND_EXPECTED_EDGES: {edge_id}", file=sys.stderr)
        raise SystemExit(1)
    if not re.match(r"^[A-Za-z0-9_.-]{1,128}$", region):
        print(f"invalid edge region in REND_EXPECTED_EDGES: {region}", file=sys.stderr)
        raise SystemExit(1)
    if edge_id in seen:
        print(f"duplicate edge id in REND_EXPECTED_EDGES: {edge_id}", file=sys.stderr)
        raise SystemExit(1)
    seen.add(edge_id)
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        print(f"edge {edge_id} base_url must be an absolute http(s) URL", file=sys.stderr)
        raise SystemExit(1)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        print(f"edge {edge_id} base_url must not include credentials, query, or fragment", file=sys.stderr)
        raise SystemExit(1)
    host = parsed.hostname.strip("[]").lower()
    is_local = host in local_hosts or host.startswith("127.") or host.endswith(".local")
    if strict and not allow_insecure:
        if parsed.scheme != "https":
            print(f"edge {edge_id} base_url must use https when REND_ENV is {rend_env}", file=sys.stderr)
            raise SystemExit(1)
        if is_local:
            print(f"edge {edge_id} base_url must not use a local host when REND_ENV is {rend_env}", file=sys.stderr)
            raise SystemExit(1)
PY
  then
    operator_ok "REND_EXPECTED_EDGES is valid"
  else
    operator_fail "REND_EXPECTED_EDGES is invalid"
  fi
}

operator_check_edge_matches_expected() {
  local file="$1"
  local edge_id region base_url expected
  edge_id="$(operator_env_value "$file" REND_EDGE_ID 2>/dev/null || true)"
  region="$(operator_env_value "$file" REND_EDGE_REGION 2>/dev/null || true)"
  base_url="$(operator_env_value "$file" REND_EDGE_BASE_URL 2>/dev/null || true)"
  expected="$(operator_env_value "$file" REND_EXPECTED_EDGES 2>/dev/null || true)"
  if python3 - "$edge_id" "$region" "${base_url%/}" "$expected" <<'PY'
import sys
edge_id, region, base_url, expected = sys.argv[1:5]
for raw in expected.split(","):
    parts = raw.strip().split("=", 2)
    if len(parts) == 3 and parts[0].strip() == edge_id:
        if parts[1].strip() == region and parts[2].strip().rstrip("/") == base_url:
            raise SystemExit(0)
        print(f"REND_EDGE_ID {edge_id} does not match its configured region/base_url in REND_EXPECTED_EDGES", file=sys.stderr)
        raise SystemExit(1)
print(f"REND_EDGE_ID {edge_id} is not present in REND_EXPECTED_EDGES", file=sys.stderr)
raise SystemExit(1)
PY
  then
    operator_ok "edge identity matches REND_EXPECTED_EDGES"
  else
    operator_fail "edge identity does not match REND_EXPECTED_EDGES"
  fi
}

operator_check_absolute_path() {
  local file="$1"
  local key="$2"
  local value
  value="$(operator_env_value "$file" "$key" 2>/dev/null || true)"
  [[ -n "$value" ]] || return 0
  case "$value" in
    /*)
      if [[ "$value" == *"/../"* || "$value" == *"/./"* ]]; then
        operator_fail "$key must not contain relative path segments"
      else
        operator_ok "$key is an absolute path"
      fi
      ;;
    *)
      operator_fail "$key must be an absolute path"
      ;;
  esac
}

operator_validate_api_env() {
  local file="$1"
  local allow_dev_defaults="$2"
  local allow_placeholders="$3"
  local required optional policy_keys numeric_keys

  required=(
    REND_ENV
    DATABASE_URL REND_REDIS_URL CLICKHOUSE_URL CLICKHOUSE_DATABASE CLICKHOUSE_USER
    CLICKHOUSE_PASSWORD OBJECT_STORE_HEALTH_URL S3_ENDPOINT S3_REGION S3_BUCKET
    AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY REND_API_BIND_ADDR REND_API_AUTO_MIGRATE
    REND_API_INLINE_MEDIA_PROCESSING REND_SITE_INTERNAL_TOKEN REND_PLAYBACK_BASE_URL
    REND_MAX_UPLOAD_BYTES REND_EXPECTED_EDGES REND_ALLOW_INSECURE_EDGE_URLS
    REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS REND_EDGE_INTERNAL_TOKEN
    REND_INTERNAL_TELEMETRY_TOKEN REND_PLAYBACK_SIGNING_KEY_ID
    REND_PLAYBACK_SIGNING_SECRET REND_PLAYBACK_TOKEN_TTL_SECS
    REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES
    REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH
    REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS
    REND_EDGE_WARM_MAX_ARTIFACTS REND_HTTP_TIMEOUT_SECS REND_FFMPEG_PATH
    REND_FFPROBE_PATH REND_MEDIA_PROCESS_TIMEOUT_SECS REND_MEDIA_JOB_MAX_ATTEMPTS
    REND_MEDIA_WORKER_POLL_INTERVAL_SECS REND_MEDIA_JOB_LOCK_TIMEOUT_SECS
    REND_BILLING_MODE
    REND_BILLING_FEATURE_DELIVERY_720P REND_BILLING_FEATURE_DELIVERY_1080P
    REND_BILLING_FEATURE_DELIVERY_2K REND_BILLING_FEATURE_DELIVERY_4K
    REND_BILLING_FEATURE_STORAGE_720P REND_BILLING_FEATURE_STORAGE_1080P
    REND_BILLING_FEATURE_STORAGE_2K REND_BILLING_FEATURE_STORAGE_4K
    REND_BILLING_ENTITLEMENT_FAILURE_POLICY
    REND_BILLING_DELIVERY_SYNC_LAG_SECS REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS
    REND_BILLING_STORAGE_SYNC_LAG_SECS REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS
  )
  optional=(REND_EDGE_WARM_URL REND_EDGE_PURGE_URL AUTUMN_SECRET_KEY AUTUMN_API_URL AUTUMN_API_VERSION)
  policy_keys=("${required[@]}" "${optional[@]}")
  numeric_keys=(
    REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS REND_PLAYBACK_TOKEN_TTL_SECS
    REND_MAX_UPLOAD_BYTES REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS
    REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES
    REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH
    REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS
    REND_EDGE_WARM_MAX_ARTIFACTS REND_HTTP_TIMEOUT_SECS
    REND_MEDIA_PROCESS_TIMEOUT_SECS REND_MEDIA_JOB_MAX_ATTEMPTS
    REND_MEDIA_WORKER_POLL_INTERVAL_SECS REND_MEDIA_JOB_LOCK_TIMEOUT_SECS
    REND_BILLING_DELIVERY_SYNC_LAG_SECS REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS
    REND_BILLING_STORAGE_SYNC_LAG_SECS REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS
  )

  operator_require_file "$file"
  local key
  for key in "${required[@]}"; do
    operator_require_env_nonempty "$file" "$key"
  done
  operator_check_all_env_policies "$file" "$allow_dev_defaults" "$allow_placeholders" "${policy_keys[@]}"
  operator_check_rend_env "$file" "$allow_dev_defaults"
  operator_check_billing_mode "$file" "$allow_dev_defaults"
  operator_check_billing_secret "$file"
  operator_check_billing_failure_policy "$file"
  operator_check_expected_edges "$file" "$allow_dev_defaults"
  operator_check_database_url "$file" DATABASE_URL
  operator_check_redis_url "$file" REND_REDIS_URL
  operator_check_http_url "$file" CLICKHOUSE_URL
  operator_check_http_url "$file" OBJECT_STORE_HEALTH_URL
  operator_check_http_url "$file" S3_ENDPOINT
  operator_check_http_url "$file" REND_PLAYBACK_BASE_URL
  operator_check_http_url "$file" AUTUMN_API_URL
  operator_check_http_url "$file" REND_EDGE_WARM_URL "/internal/warm"
  operator_check_http_url "$file" REND_EDGE_PURGE_URL "/internal/purge"
  operator_check_bind_addr "$file" REND_API_BIND_ADDR 4000
  operator_check_bool "$file" REND_API_AUTO_MIGRATE
  operator_check_bool "$file" REND_API_INLINE_MEDIA_PROCESSING
  operator_check_bool "$file" REND_ALLOW_INSECURE_EDGE_URLS
  if [[ "$(operator_env_value "$file" REND_ENV 2>/dev/null || true)" == "production" ]] &&
    [[ "$(operator_env_value "$file" REND_API_AUTO_MIGRATE 2>/dev/null || true)" != "false" ]]; then
    if [[ "$allow_dev_defaults" == "true" ]]; then
      operator_warn "API env REND_API_AUTO_MIGRATE is not false; allowed only because --allow-dev-defaults was set"
    else
      operator_fail "API env REND_API_AUTO_MIGRATE must be false for production serving containers; run rend-api migrate as a one-shot step"
    fi
  fi
  operator_check_absolute_path "$file" REND_FFMPEG_PATH
  operator_check_absolute_path "$file" REND_FFPROBE_PATH
  for key in "${numeric_keys[@]}"; do
    operator_check_positive_int "$file" "$key"
  done
}

operator_validate_worker_env() {
  local file="$1"
  local allow_dev_defaults="$2"
  local allow_placeholders="$3"
  local required optional policy_keys numeric_keys

  required=(
    REND_ENV
    DATABASE_URL REND_REDIS_URL CLICKHOUSE_URL CLICKHOUSE_DATABASE CLICKHOUSE_USER
    CLICKHOUSE_PASSWORD OBJECT_STORE_HEALTH_URL S3_ENDPOINT S3_REGION S3_BUCKET
    AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY REND_API_AUTO_MIGRATE
    REND_API_INLINE_MEDIA_PROCESSING REND_SITE_INTERNAL_TOKEN REND_PLAYBACK_BASE_URL
    REND_MAX_UPLOAD_BYTES REND_EXPECTED_EDGES REND_ALLOW_INSECURE_EDGE_URLS
    REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS REND_EDGE_INTERNAL_TOKEN
    REND_INTERNAL_TELEMETRY_TOKEN REND_PLAYBACK_SIGNING_KEY_ID
    REND_PLAYBACK_SIGNING_SECRET REND_PLAYBACK_TOKEN_TTL_SECS
    REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES
    REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH
    REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS
    REND_EDGE_WARM_MAX_ARTIFACTS REND_HTTP_TIMEOUT_SECS REND_FFMPEG_PATH
    REND_FFPROBE_PATH REND_MEDIA_PROCESS_TIMEOUT_SECS REND_MEDIA_JOB_MAX_ATTEMPTS
    REND_MEDIA_WORKER_ID REND_MEDIA_WORKER_POLL_INTERVAL_SECS
    REND_MEDIA_JOB_LOCK_TIMEOUT_SECS
    REND_BILLING_MODE
    REND_BILLING_FEATURE_DELIVERY_720P REND_BILLING_FEATURE_DELIVERY_1080P
    REND_BILLING_FEATURE_DELIVERY_2K REND_BILLING_FEATURE_DELIVERY_4K
    REND_BILLING_FEATURE_STORAGE_720P REND_BILLING_FEATURE_STORAGE_1080P
    REND_BILLING_FEATURE_STORAGE_2K REND_BILLING_FEATURE_STORAGE_4K
    REND_BILLING_ENTITLEMENT_FAILURE_POLICY
    REND_BILLING_DELIVERY_SYNC_LAG_SECS REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS
    REND_BILLING_STORAGE_SYNC_LAG_SECS REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS
  )
  optional=(REND_EDGE_WARM_URL REND_EDGE_PURGE_URL AUTUMN_SECRET_KEY AUTUMN_API_URL AUTUMN_API_VERSION)
  policy_keys=("${required[@]}" "${optional[@]}")
  numeric_keys=(
    REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS REND_PLAYBACK_TOKEN_TTL_SECS
    REND_MAX_UPLOAD_BYTES REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS
    REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES
    REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH
    REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS
    REND_EDGE_WARM_MAX_ARTIFACTS REND_HTTP_TIMEOUT_SECS
    REND_MEDIA_PROCESS_TIMEOUT_SECS REND_MEDIA_JOB_MAX_ATTEMPTS
    REND_MEDIA_WORKER_POLL_INTERVAL_SECS REND_MEDIA_JOB_LOCK_TIMEOUT_SECS
    REND_BILLING_DELIVERY_SYNC_LAG_SECS REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS
    REND_BILLING_STORAGE_SYNC_LAG_SECS REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS
  )

  operator_require_file "$file"
  local key
  for key in "${required[@]}"; do
    operator_require_env_nonempty "$file" "$key"
  done
  operator_check_all_env_policies "$file" "$allow_dev_defaults" "$allow_placeholders" "${policy_keys[@]}"
  operator_check_rend_env "$file" "$allow_dev_defaults"
  operator_check_billing_mode "$file" "$allow_dev_defaults"
  operator_check_billing_secret "$file"
  operator_check_billing_failure_policy "$file"
  operator_check_expected_edges "$file" "$allow_dev_defaults"
  operator_check_database_url "$file" DATABASE_URL
  operator_check_redis_url "$file" REND_REDIS_URL
  operator_check_http_url "$file" CLICKHOUSE_URL
  operator_check_http_url "$file" OBJECT_STORE_HEALTH_URL
  operator_check_http_url "$file" S3_ENDPOINT
  operator_check_http_url "$file" REND_PLAYBACK_BASE_URL
  operator_check_http_url "$file" AUTUMN_API_URL
  operator_check_http_url "$file" REND_EDGE_WARM_URL "/internal/warm"
  operator_check_http_url "$file" REND_EDGE_PURGE_URL "/internal/purge"
  operator_check_bool "$file" REND_API_AUTO_MIGRATE
  operator_check_bool "$file" REND_API_INLINE_MEDIA_PROCESSING
  operator_check_bool "$file" REND_ALLOW_INSECURE_EDGE_URLS
  if [[ "$(operator_env_value "$file" REND_API_AUTO_MIGRATE 2>/dev/null || true)" != "false" ]]; then
    if [[ "$allow_dev_defaults" == "true" ]]; then
      operator_warn "worker env REND_API_AUTO_MIGRATE is not false; allowed only because --allow-dev-defaults was set"
    else
      operator_fail "worker env REND_API_AUTO_MIGRATE must be false"
    fi
  fi
  if [[ "$(operator_env_value "$file" REND_API_INLINE_MEDIA_PROCESSING 2>/dev/null || true)" != "false" ]]; then
    operator_fail "worker env REND_API_INLINE_MEDIA_PROCESSING must be false"
  fi
  operator_check_absolute_path "$file" REND_FFMPEG_PATH
  operator_check_absolute_path "$file" REND_FFPROBE_PATH
  for key in "${numeric_keys[@]}"; do
    operator_check_positive_int "$file" "$key"
  done
}

operator_validate_edge_env() {
  local file="$1"
  local allow_dev_defaults="$2"
  local allow_placeholders="$3"
  local required optional policy_keys numeric_keys

  required=(
    REND_ENV
    S3_ENDPOINT S3_REGION S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    REND_EDGE_BIND_ADDR REND_EDGE_ID REND_EDGE_REGION REND_EDGE_BASE_URL
    REND_EXPECTED_EDGES REND_ALLOW_INSECURE_EDGE_URLS REND_CONTROL_PLANE_URL
    REND_EDGE_HEARTBEAT_INTERVAL_SECS REND_EDGE_CORS_ALLOWED_ORIGINS REND_EDGE_CACHE_DIR
    REND_EDGE_ORIGIN_HEALTH_URL REND_EDGE_INTERNAL_TOKEN REND_EDGE_WARM_MAX_ARTIFACTS
    REND_EDGE_MAX_IN_FLIGHT_FILLS REND_EDGE_MAX_ORIGIN_ARTIFACT_BYTES
    REND_EDGE_CACHE_MIN_FREE_BYTES REND_EDGE_TELEMETRY_ENABLED
    REND_EDGE_TELEMETRY_INGEST_URL REND_INTERNAL_TELEMETRY_TOKEN
    REND_EDGE_TELEMETRY_QUEUE_CAPACITY REND_EDGE_TELEMETRY_BATCH_SIZE
    REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS
    REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS REND_EDGE_TELEMETRY_SPOOL_DIR
    REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES REND_PLAYBACK_SIGNING_KEY_ID
    REND_PLAYBACK_SIGNING_SECRET REND_HTTP_TIMEOUT_SECS
  )
  optional=(REND_EDGE_CACHE_MAX_BYTES)
  policy_keys=("${required[@]}" "${optional[@]}")
  numeric_keys=(
    REND_EDGE_HEARTBEAT_INTERVAL_SECS REND_EDGE_WARM_MAX_ARTIFACTS
    REND_EDGE_MAX_IN_FLIGHT_FILLS REND_EDGE_MAX_ORIGIN_ARTIFACT_BYTES
    REND_EDGE_TELEMETRY_QUEUE_CAPACITY
    REND_EDGE_TELEMETRY_BATCH_SIZE REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS
    REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES
    REND_HTTP_TIMEOUT_SECS
  )

  operator_require_file "$file"
  local key
  for key in "${required[@]}"; do
    operator_require_env_nonempty "$file" "$key"
  done
  for key in "${optional[@]}"; do
    operator_require_env_present "$file" "$key"
  done
  operator_check_all_env_policies "$file" "$allow_dev_defaults" "$allow_placeholders" "${policy_keys[@]}"
  operator_check_rend_env "$file" "$allow_dev_defaults"
  operator_check_expected_edges "$file" "$allow_dev_defaults"
  operator_check_edge_matches_expected "$file"
  operator_check_http_url "$file" S3_ENDPOINT
  operator_check_http_url "$file" REND_EDGE_BASE_URL
  operator_check_http_url "$file" REND_CONTROL_PLANE_URL
  operator_check_http_url "$file" REND_EDGE_ORIGIN_HEALTH_URL
  operator_check_http_url "$file" REND_EDGE_TELEMETRY_INGEST_URL "/internal/telemetry/playback"
  operator_check_http_origin_list "$file" REND_EDGE_CORS_ALLOWED_ORIGINS
  operator_check_bind_addr "$file" REND_EDGE_BIND_ADDR 4100
  operator_check_bool "$file" REND_EDGE_TELEMETRY_ENABLED
  operator_check_bool "$file" REND_ALLOW_INSECURE_EDGE_URLS
  operator_check_absolute_path "$file" REND_EDGE_CACHE_DIR
  operator_check_absolute_path "$file" REND_EDGE_TELEMETRY_SPOOL_DIR
  operator_check_nonnegative_optional_int "$file" REND_EDGE_CACHE_MAX_BYTES
  operator_check_nonnegative_optional_int "$file" REND_EDGE_CACHE_MIN_FREE_BYTES
  for key in "${numeric_keys[@]}"; do
    operator_check_positive_int "$file" "$key"
  done
}

operator_manifest_image_ref() {
  local manifest="$1"
  local service="$2"
  local allow_local="${3:-false}"
  python3 - "$manifest" "$service" "$allow_local" <<'PY'
import json
import re
import sys

manifest_path, service_name, allow_local = sys.argv[1], sys.argv[2], sys.argv[3] == "true"
try:
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
except FileNotFoundError:
    print(f"missing release manifest: {manifest_path}", file=sys.stderr)
    raise SystemExit(1)
except json.JSONDecodeError as exc:
    print(f"invalid release manifest JSON: {exc}", file=sys.stderr)
    raise SystemExit(1)

service = manifest.get("services", {}).get(service_name)
if not service:
    print(f"release manifest missing services.{service_name}", file=sys.stderr)
    raise SystemExit(1)

image_digest = service.get("image_digest")
if image_digest:
    if not re.match(r"^\S+@sha256:[0-9a-fA-F]{64}$", image_digest):
        print(f"services.{service_name}.image_digest is not an immutable sha256 ref", file=sys.stderr)
        raise SystemExit(1)
    print(image_digest)
    raise SystemExit(0)

if allow_local:
    image_tag = service.get("image_tag") or service.get("release_tag_image")
    if image_tag:
        print(image_tag)
        raise SystemExit(0)

print(f"release manifest services.{service_name}.image_digest is required", file=sys.stderr)
raise SystemExit(1)
PY
}

operator_validate_manifest_services() {
  local manifest="$1"
  local allow_local="$2"
  local expected_platform="${3:-linux/amd64}"
  shift 3
  local service ref platform
  if ! expected_platform="$(operator_normalize_platform "$expected_platform" 2>/tmp/rend-platform-error.$$)"; then
    operator_fail "$(cat /tmp/rend-platform-error.$$)"
    rm -f /tmp/rend-platform-error.$$
    return 0
  fi
  rm -f /tmp/rend-platform-error.$$
  operator_require_file "$manifest"
  for service in "$@"; do
    if platform="$(operator_manifest_service_platform "$manifest" "$service" "$expected_platform" 2>/tmp/rend-manifest-platform-error.$$)"; then
      operator_ok "$service manifest platform matches host expectation: $platform"
    else
      operator_fail "$(cat /tmp/rend-manifest-platform-error.$$)"
    fi
    rm -f /tmp/rend-manifest-platform-error.$$
    if ref="$(operator_manifest_image_ref "$manifest" "$service" "$allow_local" 2>/tmp/rend-manifest-error.$$)"; then
      if [[ "$ref" == *@sha256:* ]]; then
        operator_ok "$service manifest image uses digest ref: $ref"
      else
        operator_warn "$service manifest fell back to local tag because --allow-local-image-refs was set: $ref"
      fi
    else
      operator_fail "$(cat /tmp/rend-manifest-error.$$)"
    fi
    rm -f /tmp/rend-manifest-error.$$
  done
}

operator_manifest_service_platform() {
  local manifest="$1"
  local service="$2"
  local expected_platform="$3"
  python3 - "$manifest" "$service" "$expected_platform" <<'PY'
import json
import sys

manifest_path, service_name, expected_platform = sys.argv[1:4]
try:
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
except FileNotFoundError:
    print(f"missing release manifest: {manifest_path}", file=sys.stderr)
    raise SystemExit(1)
except json.JSONDecodeError as exc:
    print(f"invalid release manifest JSON: {exc}", file=sys.stderr)
    raise SystemExit(1)

service = manifest.get("services", {}).get(service_name)
if not service:
    print(f"release manifest missing services.{service_name}", file=sys.stderr)
    raise SystemExit(1)

platform = service.get("platform") or manifest.get("platform")
os_name = service.get("os") or manifest.get("os")
architecture = service.get("architecture") or manifest.get("architecture")
variant = service.get("variant") or manifest.get("variant")

if not platform and os_name and architecture:
    platform = f"{os_name}/{architecture}" + (f"/{variant}" if variant else "")
if not platform:
    print(f"release manifest services.{service_name} is missing platform metadata", file=sys.stderr)
    raise SystemExit(1)

platform = platform.lower()
if platform != expected_platform:
    print(
        f"release manifest services.{service_name} platform {platform} does not match host expectation {expected_platform}",
        file=sys.stderr,
    )
    raise SystemExit(1)

print(platform)
PY
}

operator_check_image_platform() {
  local image_ref="$1"
  local service="$2"
  local expected_platform="$3"
  local actual_platform

  if ! actual_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}{{if .Variant}}/{{.Variant}}{{end}}' "$image_ref" 2>/tmp/rend-image-platform-error.$$)"; then
    operator_fail "$service pulled image platform could not be inspected for $image_ref: $(cat /tmp/rend-image-platform-error.$$)"
    rm -f /tmp/rend-image-platform-error.$$
    return 0
  fi
  rm -f /tmp/rend-image-platform-error.$$
  actual_platform="$(printf '%s' "$actual_platform" | tr '[:upper:]' '[:lower:]')"
  if [[ "$actual_platform" == "$expected_platform" ]]; then
    operator_ok "$service pulled image platform matches host expectation: $actual_platform"
  else
    operator_fail "$service pulled image platform is $actual_platform, expected $expected_platform"
  fi
}

operator_check_manifest_image_pulls() {
  local manifest="$1"
  local allow_local="$2"
  local expected_platform="${3:-linux/amd64}"
  shift 3
  local service ref
  if ! expected_platform="$(operator_normalize_platform "$expected_platform" 2>/tmp/rend-platform-error.$$)"; then
    operator_fail "$(cat /tmp/rend-platform-error.$$)"
    rm -f /tmp/rend-platform-error.$$
    return 0
  fi
  rm -f /tmp/rend-platform-error.$$
  for service in "$@"; do
    if ! ref="$(operator_manifest_image_ref "$manifest" "$service" "$allow_local" 2>/tmp/rend-manifest-pull-error.$$)"; then
      operator_fail "$(cat /tmp/rend-manifest-pull-error.$$)"
      rm -f /tmp/rend-manifest-pull-error.$$
      continue
    fi
    rm -f /tmp/rend-manifest-pull-error.$$
    if [[ "$ref" != *@sha256:* ]]; then
      operator_warn "skipping $service image pull readiness check for local tag ref: $ref"
      continue
    fi
    if docker image pull "$ref" >/dev/null; then
      operator_ok "$service manifest image is pullable: $ref"
      operator_check_image_platform "$ref" "$service" "$expected_platform"
    else
      operator_fail "$service manifest image could not be pulled: $ref"
    fi
  done
}

operator_check_edge_publish_addr_policy() {
  local publish_addr="$1"
  local allow_direct_exposure="$2"
  if python3 - "$publish_addr" <<'PY'
import ipaddress
import sys

value = sys.argv[1].strip().strip("[]")
if value in {"", "0.0.0.0", "::"}:
    print("wildcard")
    raise SystemExit(1)
if value.lower() == "localhost":
    raise SystemExit(0)
try:
    ip = ipaddress.ip_address(value)
except ValueError:
    print("unclassified")
    raise SystemExit(1)
if ip.is_loopback or ip.is_private or ip.is_link_local:
    raise SystemExit(0)
print("public")
raise SystemExit(1)
PY
  then
    operator_ok "edge publish address is private by default: $publish_addr"
    return 0
  fi

  if [[ "$allow_direct_exposure" == "true" ]]; then
    operator_warn "edge publish address $publish_addr is directly exposed; use only for short production debugging"
  else
    operator_fail "edge publish address $publish_addr is directly exposed; use 127.0.0.1/private IP or pass --allow-direct-edge-exposure for short production debugging"
  fi
}

operator_check_docker_compose() {
  if command -v docker >/dev/null 2>&1; then
    operator_ok "docker CLI is available"
  else
    operator_fail "docker CLI is required"
    return 0
  fi

  if docker compose version >/dev/null 2>&1; then
    operator_ok "docker compose v2 is available"
  else
    operator_fail "docker compose v2 is required"
  fi

  if docker info >/dev/null 2>&1; then
    operator_ok "Docker daemon is reachable"
  else
    operator_fail "Docker daemon is not reachable"
  fi
}

operator_check_bind_port_free() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY'
import socket
import sys

host, port_s = sys.argv[1], sys.argv[2]
try:
    port = int(port_s)
except ValueError:
    print("publish port must be numeric", file=sys.stderr)
    raise SystemExit(1)
if not 1 <= port <= 65535:
    print("publish port must be 1-65535", file=sys.stderr)
    raise SystemExit(1)
family = socket.AF_INET6 if ":" in host and host not in {"0.0.0.0", ""} else socket.AF_INET
probe_host = host or "0.0.0.0"
sock = socket.socket(family, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind((probe_host, port))
except OSError as exc:
    print(f"{host}:{port} is not bindable: {exc}", file=sys.stderr)
    raise SystemExit(1)
finally:
    sock.close()
PY
}

operator_check_uid_gid_writable_dir() {
  local path="$1"
  local uid="${2:-10001}"
  local gid="${3:-10001}"
  if python3 - "$path" "$uid" "$gid" <<'PY'
import os
import stat
import sys

path, uid_s, gid_s = sys.argv[1], sys.argv[2], sys.argv[3]
uid, gid = int(uid_s), int(gid_s)
if not os.path.isdir(path):
    print(f"{path} is not an existing directory", file=sys.stderr)
    raise SystemExit(1)
st = os.stat(path)
mode = st.st_mode
owner = st.st_uid == uid and mode & stat.S_IWUSR and mode & stat.S_IXUSR
group = st.st_gid == gid and mode & stat.S_IWGRP and mode & stat.S_IXGRP
other = mode & stat.S_IWOTH and mode & stat.S_IXOTH
if owner or group or other:
    raise SystemExit(0)
print(f"{path} is not writable/searchable by uid/gid {uid}:{gid}", file=sys.stderr)
raise SystemExit(1)
PY
  then
    operator_ok "$path is writable by uid/gid $uid:$gid"
  else
    operator_fail "$path is not writable by uid/gid $uid:$gid"
  fi
}

operator_shell_join() {
  python3 - "$@" <<'PY'
import shlex
import sys
print(" ".join(shlex.quote(arg) for arg in sys.argv[1:]))
PY
}

operator_run_or_dry_run() {
  local dry_run="$1"
  shift
  operator_shell_join "$@"
  if [[ "$dry_run" != "true" ]]; then
    "$@"
  fi
}
