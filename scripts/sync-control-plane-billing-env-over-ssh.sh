#!/usr/bin/env bash
set -euo pipefail

host=""
user=""
port="${REND_DEPLOY_SSH_PORT:-22}"
api_env="${REND_API_ENV_FILE:-/etc/rend/rend-api.env}"
worker_env="${REND_MEDIA_WORKER_ENV_FILE:-/etc/rend/rend-media-worker.env}"

usage() {
  cat <<'EOF'
Usage: scripts/sync-control-plane-billing-env-over-ssh.sh --host HOST --user USER [options]

Sync the deploy-managed env allowlist into the production control-plane API and
media-worker env files over SSH. Values are read from this process environment;
only key names are printed.

Options:
  --host HOST           SSH host.
  --user USER           SSH user.
  --port PORT           SSH port. Default: 22.
  --api-env FILE        Remote API env file. Default: /etc/rend/rend-api.env.
  --worker-env FILE     Remote worker env file. Default: /etc/rend/rend-media-worker.env.
  -h, --help            Show this help.

Environment:
  CLICKHOUSE_URL        Required ClickHouse HTTP endpoint.
  CLICKHOUSE_DATABASE   ClickHouse database. Defaults to rend.
  CLICKHOUSE_USER       Required ClickHouse user.
  CLICKHOUSE_PASSWORD   Required ClickHouse password.
  REND_API_CORS_ALLOWED_ORIGINS
                        API CORS allowlist. Defaults to production Rend origins.
  AUTUMN_SECRET_KEY     Required live Autumn secret key.
  REND_SSH_KEY_PATH     Optional private key path passed to ssh/scp.
  REND_SSH_EXTRA_OPTS   Optional extra ssh options, split by shell words.
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

is_live_autumn_key() {
  local value="$1"
  [[ "$value" =~ ^am_sk_live_ || "$value" =~ (^|[_-])live([_-]|$) ]]
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
    --worker-env)
      worker_env="${2:?missing value for $1}"
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
[[ -n "${CLICKHOUSE_URL:-}" ]] || die "CLICKHOUSE_URL is required"
[[ -n "${CLICKHOUSE_USER:-}" ]] || die "CLICKHOUSE_USER is required"
[[ -n "${CLICKHOUSE_PASSWORD:-}" ]] || die "CLICKHOUSE_PASSWORD is required"
[[ -n "${AUTUMN_SECRET_KEY:-}" ]] || die "AUTUMN_SECRET_KEY is required"
is_live_autumn_key "$AUTUMN_SECRET_KEY" || die "AUTUMN_SECRET_KEY must be visibly marked as live"

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

fragment="$(mktemp "${TMPDIR:-/tmp}/rend-control-plane-env.XXXXXX")"
merge_script="$(mktemp "${TMPDIR:-/tmp}/rend-control-plane-env-merge.XXXXXX.py")"
cleanup() {
  rm -f "$fragment" "$merge_script"
}
trap cleanup EXIT

python3 - "$fragment" <<'PY'
import os
import sys

target = sys.argv[1]
defaults = {
    "CLICKHOUSE_DATABASE": "rend",
    "REND_API_CORS_ALLOWED_ORIGINS": "https://rend.so,https://www.rend.so",
    "REND_BILLING_MODE": "autumn",
    "AUTUMN_API_URL": "https://api.useautumn.com/v1",
    "AUTUMN_API_VERSION": "2.3.0",
    "REND_BILLING_FEATURE_DELIVERY_720P": "delivery_720p_seconds",
    "REND_BILLING_FEATURE_DELIVERY_1080P": "delivery_1080p_seconds",
    "REND_BILLING_FEATURE_DELIVERY_2K": "delivery_2k_seconds",
    "REND_BILLING_FEATURE_DELIVERY_4K": "delivery_4k_seconds",
    "REND_BILLING_FEATURE_STORAGE_720P": "storage_720p_second_months",
    "REND_BILLING_FEATURE_STORAGE_1080P": "storage_1080p_second_months",
    "REND_BILLING_FEATURE_STORAGE_2K": "storage_2k_second_months",
    "REND_BILLING_FEATURE_STORAGE_4K": "storage_4k_second_months",
    "REND_BILLING_ENTITLEMENT_FAILURE_POLICY": "fail_closed",
    "REND_BILLING_DELIVERY_SYNC_LAG_SECS": "60",
    "REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS": "3600",
    "REND_BILLING_STORAGE_SYNC_LAG_SECS": "60",
    "REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS": "3600",
}
keys = [
    "CLICKHOUSE_URL",
    "CLICKHOUSE_DATABASE",
    "CLICKHOUSE_USER",
    "CLICKHOUSE_PASSWORD",
    "REND_API_CORS_ALLOWED_ORIGINS",
    "REND_BILLING_MODE",
    "AUTUMN_SECRET_KEY",
    "AUTUMN_API_URL",
    "AUTUMN_API_VERSION",
    "REND_BILLING_FEATURE_DELIVERY_720P",
    "REND_BILLING_FEATURE_DELIVERY_1080P",
    "REND_BILLING_FEATURE_DELIVERY_2K",
    "REND_BILLING_FEATURE_DELIVERY_4K",
    "REND_BILLING_FEATURE_STORAGE_720P",
    "REND_BILLING_FEATURE_STORAGE_1080P",
    "REND_BILLING_FEATURE_STORAGE_2K",
    "REND_BILLING_FEATURE_STORAGE_4K",
    "REND_BILLING_ENTITLEMENT_FAILURE_POLICY",
    "REND_BILLING_DELIVERY_SYNC_LAG_SECS",
    "REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS",
    "REND_BILLING_STORAGE_SYNC_LAG_SECS",
    "REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS",
]

with open(target, "w", encoding="utf-8") as file:
    for key in keys:
        value = os.environ.get(key, defaults.get(key, ""))
        if not value:
            raise SystemExit(f"{key} is required")
        if "\n" in value or "\r" in value:
            raise SystemExit(f"{key} must be a single-line value")
        file.write(f"{key}={value}\n")
PY

cat >"$merge_script" <<'PY'
import datetime as dt
import os
import shutil
import sys
from pathlib import Path

fragment = Path(sys.argv[1])
targets = [Path(value) for value in sys.argv[2:]]
updates = {}
for line in fragment.read_text(encoding="utf-8").splitlines():
    key, value = line.split("=", 1)
    updates[key] = value
keys = list(updates)
stamp = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")

for target in targets:
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
        output.append("# Managed control-plane configuration synced by Rend deploy workflow.")
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
remote_dir="/tmp/rend-control-plane-env-sync-$(date +%s)-$$"
remote_dir_q="$(shell_quote "$remote_dir")"
remote_fragment="$remote_dir/control-plane.env"
remote_merge="$remote_dir/merge.py"

echo "Preparing control-plane env sync bundle on $target"
ssh "${ssh_args[@]}" "$target" "rm -rf $remote_dir_q && mkdir -p $remote_dir_q"
scp "${scp_args[@]}" "$fragment" "$target:$remote_fragment"
scp "${scp_args[@]}" "$merge_script" "$target:$remote_merge"

remote_command="python3 $(shell_quote "$remote_merge") $(shell_quote "$remote_fragment") $(shell_quote "$api_env") $(shell_quote "$worker_env")"
ssh "${ssh_args[@]}" "$target" "sudo -n bash -lc $(shell_quote "$remote_command")"
ssh "${ssh_args[@]}" "$target" "rm -rf $remote_dir_q"
echo "Control-plane env sync completed for keys: CLICKHOUSE_* REND_API_CORS_ALLOWED_ORIGINS REND_BILLING_MODE AUTUMN_SECRET_KEY AUTUMN_API_URL AUTUMN_API_VERSION REND_BILLING_FEATURE_* REND_BILLING_*_SYNC_*"
