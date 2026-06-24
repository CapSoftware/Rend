#!/usr/bin/env bash
set -euo pipefail

host=""
user=""
port="${REND_DEPLOY_SSH_PORT:-22}"
edge_env="${REND_EDGE_ENV_FILE:-/etc/rend/rend-edge.env}"
remote_dir=""
target=""

usage() {
  cat <<'EOF'
Usage: scripts/sync-edge-deploy-env-over-ssh.sh --host HOST --user USER [options]

Sync the deploy-managed edge env allowlist into the production edge env file
over SSH. Values are read from this process environment; only key names are
printed.

Options:
  --host HOST       SSH host.
  --user USER       SSH user.
  --port PORT       SSH port. Default: 22.
  --edge-env FILE   Remote edge env file. Default: /etc/rend/rend-edge.env.
  -h, --help        Show this help.

Environment:
  REND_EDGE_CORS_ALLOWED_ORIGINS
                    Edge CORS allowlist. Defaults to production Rend origins.
  REND_EDGE_ID, REND_EDGE_REGION, REND_EDGE_BASE_URL, REND_EXPECTED_EDGES
                    Optional deploy-managed edge identity values derived from
                    REND_READINESS_EDGES by the production workflow.
  REND_SSH_KEY_PATH Optional private key path passed to ssh/scp.
  REND_SSH_EXTRA_OPTS
                    Optional extra ssh options, split by shell words.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
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
    --edge-env)
      edge_env="${2:?missing value for $1}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$host" ]] || die "--host is required"
[[ -n "$user" ]] || die "--user is required"
[[ "$port" =~ ^[0-9]+$ ]] || die "--port must be numeric"

require_command python3
require_command ssh
require_command scp

ssh_args=(-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -p "$port")
scp_args=(-P "$port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes)
if [[ -n "${REND_SSH_KEY_PATH:-}" ]]; then
  ssh_args+=(-i "$REND_SSH_KEY_PATH")
  scp_args+=(-i "$REND_SSH_KEY_PATH")
fi
if [[ -n "${REND_SSH_EXTRA_OPTS:-}" ]]; then
  # shellcheck disable=SC2206
  extra_opts=(${REND_SSH_EXTRA_OPTS})
  ssh_args+=("${extra_opts[@]}")
  scp_args+=("${extra_opts[@]}")
fi

fragment="$(mktemp "${TMPDIR:-/tmp}/rend-edge-env.XXXXXX")"
merge_script="$(mktemp "${TMPDIR:-/tmp}/rend-edge-env-merge.XXXXXX.py")"
cleanup() {
  rm -f "$fragment" "$merge_script"
  if [[ -n "$remote_dir" && -n "$target" ]]; then
    local remote_dir_q
    remote_dir_q="$(shell_quote "$remote_dir")"
    # shellcheck disable=SC2029
    ssh "${ssh_args[@]}" "$target" "rm -rf $remote_dir_q" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

python3 - "$fragment" <<'PY'
import os
import sys
from urllib.parse import urlparse

target = sys.argv[1]
updates = {}

def require_single_line(key, value):
    if not value:
        raise SystemExit(f"{key} is required")
    if "\n" in value or "\r" in value:
        raise SystemExit(f"{key} must be a single-line value")
    return value

def require_http_url(key, value):
    value = require_single_line(key, value).rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SystemExit(f"{key} must be an absolute http(s) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SystemExit(f"{key} must not include credentials, query, or fragment")
    return value

cors_key = "REND_EDGE_CORS_ALLOWED_ORIGINS"
cors_value = os.environ.get(cors_key, "https://rend.so,https://www.rend.so")
cors_value = require_single_line(cors_key, cors_value)
origins = [item.strip() for item in cors_value.split(",") if item.strip()]
if not origins:
    raise SystemExit(f"{cors_key} must include at least one origin")
for origin in origins:
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SystemExit(f"{cors_key} entry must be an absolute http(s) origin: {origin}")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SystemExit(f"{cors_key} entries must not include credentials, query, or fragment: {origin}")
    if parsed.path not in {"", "/"}:
        raise SystemExit(f"{cors_key} entries must be origins only: {origin}")
    if parsed.port is not None and not (1 <= parsed.port <= 65535):
        raise SystemExit(f"{cors_key} port must be 1-65535: {origin}")
updates[cors_key] = cors_value

for key in ("REND_EDGE_ID", "REND_EDGE_REGION"):
    value = os.environ.get(key)
    if value is not None:
        updates[key] = require_single_line(key, value)

value = os.environ.get("REND_EDGE_BASE_URL")
if value is not None:
    updates["REND_EDGE_BASE_URL"] = require_http_url("REND_EDGE_BASE_URL", value)

expected = os.environ.get("REND_EXPECTED_EDGES")
if expected is not None:
    expected = require_single_line("REND_EXPECTED_EDGES", expected)
    for item in [part.strip() for part in expected.split(",") if part.strip()]:
        pieces = item.split("=", 2)
        if len(pieces) != 3 or not pieces[0].strip() or not pieces[1].strip():
            raise SystemExit("REND_EXPECTED_EDGES entries must use edge_id=region=base_url")
        require_http_url("REND_EXPECTED_EDGES base_url", pieces[2].strip())
    updates["REND_EXPECTED_EDGES"] = expected

with open(target, "w", encoding="utf-8") as file:
    for key, value in updates.items():
        file.write(f"{key}={value}\n")
PY

cat >"$merge_script" <<'PY'
import datetime as dt
import os
import shutil
import sys
from pathlib import Path

fragment = Path(sys.argv[1])
target = Path(sys.argv[2])
updates = {}
for line in fragment.read_text(encoding="utf-8").splitlines():
    key, value = line.split("=", 1)
    updates[key] = value
keys = list(updates)
stamp = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")

if not target.exists():
    raise SystemExit(f"missing env file: {target}")

original = target.read_text(encoding="utf-8")
backup = target.with_name(f"{target.name}.bak.{stamp}")
shutil.copy2(target, backup)

output = []
seen = set()
changed = []
for line in original.splitlines():
    stripped = line.strip()
    key = None
    if stripped and not stripped.startswith("#") and "=" in line:
        left = line.split("=", 1)[0].strip()
        key = left.removeprefix("export ").strip()
    if key in updates:
        replacement = f"{key}={updates[key]}"
        output.append(replacement)
        seen.add(key)
        if line != replacement:
            changed.append(key)
    else:
        output.append(line)

missing = [key for key in keys if key not in seen]
if missing:
    if output and output[-1].strip():
        output.append("")
    output.append("# Managed edge configuration synced by Rend deploy workflow.")
    for key in missing:
        output.append(f"{key}={updates[key]}")
    changed.extend(missing)

tmp = target.with_name(f".{target.name}.tmp-{os.getpid()}")
tmp.write_text("\n".join(output) + "\n", encoding="utf-8")
os.chmod(tmp, 0o600)
os.replace(tmp, target)
print(f"updated {target}: {', '.join(changed) if changed else 'no changes'}")
PY

target="$user@$host"
remote_dir="/tmp/rend-edge-env-sync-$(date +%s)-$$"
remote_dir_q="$(shell_quote "$remote_dir")"
remote_fragment="$remote_dir/edge.env"
remote_merge="$remote_dir/merge.py"

echo "Preparing edge env sync bundle on $target"
# shellcheck disable=SC2029
ssh "${ssh_args[@]}" "$target" "rm -rf $remote_dir_q && umask 077 && mkdir -p $remote_dir_q"
scp "${scp_args[@]}" "$fragment" "$target:$remote_fragment"
scp "${scp_args[@]}" "$merge_script" "$target:$remote_merge"

remote_command="python3 $(shell_quote "$remote_merge") $(shell_quote "$remote_fragment") $(shell_quote "$edge_env")"
# shellcheck disable=SC2029
ssh "${ssh_args[@]}" "$target" "sudo -n bash -lc $(shell_quote "$remote_command")"
python3 - "$fragment" <<'PY'
import sys
from pathlib import Path
keys = []
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if "=" in line:
        keys.append(line.split("=", 1)[0])
print("Edge env sync completed for keys: " + ", ".join(keys))
PY
