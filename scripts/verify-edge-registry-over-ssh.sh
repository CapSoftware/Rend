#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

host=""
user=""
port="${REND_DEPLOY_SSH_PORT:-22}"
api_env="${REND_API_ENV_FILE:-/etc/rend/rend-api.env}"
expected_edges="${REND_EXPECTED_EDGES:-}"

usage() {
  cat <<'EOF'
Usage: scripts/verify-edge-registry-over-ssh.sh --host HOST --user USER --expected-edges LIST [options]

Verify expected edge rows from the control-plane host, using that host's API env
file for DATABASE_URL. Output intentionally avoids printing URLs or database
connection details.

Options:
  --host HOST            Control-plane SSH host.
  --user USER            Control-plane SSH user.
  --port PORT            SSH port. Default: 22.
  --api-env FILE         Remote API env file. Default: /etc/rend/rend-api.env.
  --expected-edges LIST  Comma-separated edge_id=region=public_base[=private_base].
  -h, --help             Show this help.

Environment:
  REND_SSH_KEY_PATH      Optional private key path passed to ssh.
  REND_SSH_EXTRA_OPTS    Optional extra ssh options, split by shell words.
EOF
}

shell_quote() {
  printf "%q" "$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      host="${2:?missing value for $1}"
      shift 2
      ;;
    --user)
      user="${2:?missing value for $1}"
      shift 2
      ;;
    --port)
      port="${2:?missing value for $1}"
      shift 2
      ;;
    --api-env)
      api_env="${2:?missing value for $1}"
      shift 2
      ;;
    --expected-edges)
      expected_edges="${2:?missing value for $1}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      operator_die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$host" ]] || operator_die "--host is required"
[[ -n "$user" ]] || operator_die "--user is required"
[[ -n "$expected_edges" ]] || operator_die "--expected-edges is required"
[[ "$port" =~ ^[0-9]+$ ]] || operator_die "--port must be numeric"

operator_require_command python3
operator_require_command ssh
operator_finish

expected_edges_public="$(
  python3 - "$expected_edges" <<'PY'
import sys
from urllib.parse import urlparse

items = []
for raw in sys.argv[1].split(","):
    raw = raw.strip()
    if not raw:
        continue
    parts = [part.strip() for part in raw.split("=", 3)]
    if len(parts) not in {3, 4} or not all(parts[:3]):
        raise SystemExit("expected edge entries must use edge_id=region=public_base[=private_base]")
    edge_id, region, public_base = parts[:3]
    parsed = urlparse(public_base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SystemExit("expected edge public_base values must be absolute http(s) URLs")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SystemExit("expected edge public_base values must not include credentials, query, or fragment")
    items.append(f"{edge_id}={region}={public_base.rstrip('/')}")
if not items:
    raise SystemExit("no expected edge entries were provided")
print(",".join(items))
PY
)"

expected_edges_b64="$(printf '%s' "$expected_edges_public" | base64 | tr -d '\n')"

ssh_args=(-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -p "$port")
if [[ -n "${REND_SSH_KEY_PATH:-}" ]]; then
  ssh_args+=(-i "$REND_SSH_KEY_PATH")
fi
if [[ -n "${REND_SSH_EXTRA_OPTS:-}" ]]; then
  # shellcheck disable=SC2206
  extra_opts=(${REND_SSH_EXTRA_OPTS})
  ssh_args+=("${extra_opts[@]}")
fi

remote_command="sudo -n env REND_EXPECTED_EDGES_B64=$(shell_quote "$expected_edges_b64") REND_API_ENV_FILE=$(shell_quote "$api_env") bash -s"

operator_info "verifying expected edge registry rows from the control-plane host"
# shellcheck disable=SC2029
ssh "${ssh_args[@]}" "$user@$host" "$remote_command" <<'REMOTE'
set -euo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "[fail] python3 is required on the control-plane host" >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "[fail] psql is required on the control-plane host" >&2
  exit 1
fi

api_env="${REND_API_ENV_FILE:?}"
expected_edges="$(
  python3 - <<'PY'
import base64
import os

print(base64.b64decode(os.environ["REND_EXPECTED_EDGES_B64"]).decode("utf-8"))
PY
)"

if [[ ! -r "$api_env" ]]; then
  echo "[fail] remote API env file is not readable" >&2
  exit 1
fi

database_url="$(
  python3 - "$api_env" <<'PY'
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as file:
    for line in file:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export "):].lstrip()
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() != "DATABASE_URL":
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        print(value)
        raise SystemExit(0)
raise SystemExit("DATABASE_URL is missing from remote API env")
PY
)"

psql_url="$(
  python3 - "$database_url" <<'PY'
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

parts = urlsplit(sys.argv[1])
query = [
    (key, value)
    for key, value in parse_qsl(parts.query, keep_blank_values=True)
    if not (key.lower() == "sslrootcert" and value.lower() == "system")
]
print(urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)))
PY
)"

sql="$(
  python3 - "$expected_edges" <<'PY'
import sys

edge_ids = []
for raw in sys.argv[1].split(","):
    parts = raw.strip().split("=", 2)
    if len(parts) == 3 and parts[0].strip():
        edge_ids.append(parts[0].strip().replace("'", "''"))
if not edge_ids:
    raise SystemExit("expected edge entries did not contain any edge ids")
quoted = ",".join(f"'{edge_id}'" for edge_id in edge_ids)
print(
    "SELECT edge_id, region, COALESCE(base_url, ''), status, "
    "(last_heartbeat_at IS NOT NULL AND last_heartbeat_at >= now() - interval '120 seconds')::text "
    "FROM rend.edge_nodes "
    f"WHERE edge_id IN ({quoted}) AND status <> 'removed' "
    "ORDER BY edge_id"
)
PY
)"

psql_error="$(mktemp)"
cleanup() {
  rm -f "$psql_error"
}
trap cleanup EXIT

psql_status=0
rows="$(PGCONNECT_TIMEOUT=8 psql "$psql_url" -F $'\t' -At -c "$sql" 2>"$psql_error")" || psql_status=$?
if [[ "$psql_status" != "0" ]]; then
  echo "[fail] remote edge registry query failed with exit $psql_status; database connection details suppressed" >&2
  exit 1
fi

python3 - "$expected_edges" "$rows" <<'PY'
import sys

expected_raw, rows_raw = sys.argv[1], sys.argv[2]
expected = {}
for raw in expected_raw.split(","):
    parts = [part.strip() for part in raw.strip().split("=", 2)]
    if len(parts) == 3 and all(parts):
        expected[parts[0]] = (parts[1], parts[2].rstrip("/"))

rows = {}
for line in rows_raw.splitlines():
    cols = line.split("\t")
    if len(cols) >= 5:
        edge_id, region, base_url, status, active = cols[:5]
        rows[edge_id] = (region, base_url.rstrip("/"), status, active)

missing = sorted(set(expected) - set(rows))
if missing:
    raise SystemExit(f"[fail] missing expected edge registrations: {', '.join(missing)}")

bad = []
for edge_id, (region, base_url) in expected.items():
    row_region, row_base_url, status, active = rows[edge_id]
    if row_region != region:
        bad.append(f"{edge_id} region mismatch")
    if row_base_url != base_url:
        bad.append(f"{edge_id} base_url mismatch")
    if status != "healthy":
        bad.append(f"{edge_id} status is not healthy")
    if active != "true":
        bad.append(f"{edge_id} heartbeat is stale or missing")
if bad:
    raise SystemExit("[fail] " + "; ".join(bad))

print("[ok] all expected edges are registered healthy on the control-plane host")
for edge_id in sorted(expected):
    region = rows[edge_id][0]
    print(f"[ok] edge registry row verified: {edge_id} region={region} status=healthy active_recent=true")
PY
REMOTE
