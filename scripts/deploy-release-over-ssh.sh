#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

role=""
host=""
user=""
port="${REND_DEPLOY_SSH_PORT:-22}"
manifest=""
expected_platform="${REND_EXPECTED_IMAGE_PLATFORM:-linux/amd64}"
remote_dir=""

usage() {
  cat <<'EOF'
Usage: scripts/deploy-release-over-ssh.sh --role control-plane|edge --host HOST --user USER --manifest FILE [options]

Upload a release manifest and the current deploy helpers to a host, then run
preflight, deploy, and local health checks over SSH.

Options:
  --role ROLE                 control-plane or edge.
  --host HOST                 SSH host.
  --user USER                 SSH user.
  --port PORT                 SSH port. Default: 22.
  --manifest FILE             Release manifest with immutable image_digest refs.
  --expected-platform VALUE   Expected image platform. Default: linux/amd64.
  --remote-dir DIR            Remote working dir. Default: /tmp/rend-deploy-<sha>.
  -h, --help                  Show this help.

Environment:
  REND_SSH_KEY_PATH           Optional private key path passed to ssh/scp.
  REND_SSH_EXTRA_OPTS         Optional extra ssh options, split by shell words.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

validate_safe_remote_path() {
  case "$1" in
    *[!A-Za-z0-9_./-]* | "" | "." | "/" | "/tmp" | "/tmp/")
      die "unsafe remote dir: $1"
      ;;
  esac
}

shell_quote() {
  printf "%q" "$1"
}

remote_sudo() {
  local command="$1"
  # Production env files under /etc/rend are root-only, and root may own the
  # Docker credentials used for GHCR pulls. Keep file upload as the SSH user,
  # then run the actual host checks and deploy through passwordless sudo.
  # shellcheck disable=SC2029 # remote command is intentionally built and quoted locally.
  ssh "${ssh_args[@]}" "$target" "sudo -n bash -lc $(shell_quote "$command")"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      role="${2:?missing value for $1}"
      shift 2
      ;;
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
    --manifest)
      manifest="${2:?missing value for $1}"
      shift 2
      ;;
    --expected-platform)
      expected_platform="${2:?missing value for $1}"
      shift 2
      ;;
    --remote-dir)
      remote_dir="${2:?missing value for $1}"
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

[[ "$role" == "control-plane" || "$role" == "edge" ]] || die "--role must be control-plane or edge"
[[ -n "$host" ]] || die "--host is required"
[[ -n "$user" ]] || die "--user is required"
[[ -f "$manifest" ]] || die "manifest not found: $manifest"
[[ "$port" =~ ^[0-9]+$ ]] || die "--port must be numeric"
[[ "$expected_platform" =~ ^[a-z0-9]+/[a-z0-9_]+(/[a-z0-9_.-]+)?$ ]] || die "invalid platform: $expected_platform"

require_command tar
require_command ssh
require_command scp
require_command python3

git_sha="$(
  python3 - "$manifest" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    manifest = json.load(f)
print(manifest["short_sha"])
PY
)"

if [[ -z "$remote_dir" ]]; then
  remote_dir="/tmp/rend-deploy-$git_sha"
fi
validate_safe_remote_path "$remote_dir"

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

target="$user@$host"
remote_dir_q="$(shell_quote "$remote_dir")"
remote_manifest="$remote_dir/release-manifest.json"
remote_bundle="$remote_dir/deploy-bundle.tgz"

bundle="$(mktemp "${TMPDIR:-/tmp}/rend-deploy-bundle.XXXXXX.tgz")"
cleanup() {
  rm -f "$bundle"
}
trap cleanup EXIT

tar -C "$root_dir" -czf "$bundle" scripts docs/templates docs/env

echo "Preparing $role deploy bundle on $target:$remote_dir"
# shellcheck disable=SC2029 # remote command uses validated, shell-quoted local values.
ssh "${ssh_args[@]}" "$target" "rm -rf $remote_dir_q && mkdir -p $remote_dir_q"
scp "${scp_args[@]}" "$bundle" "$target:$remote_bundle"
scp "${scp_args[@]}" "$manifest" "$target:$remote_manifest"
# shellcheck disable=SC2029 # remote command uses validated, shell-quoted local values.
ssh "${ssh_args[@]}" "$target" "tar -xzf $(shell_quote "$remote_bundle") -C $remote_dir_q && chmod +x $remote_dir_q/scripts/"'*.sh'

if [[ "$role" == "control-plane" ]]; then
  echo "Deploying control-plane on $target"
  remote_sudo \
    "cd $remote_dir_q && scripts/preflight-control-plane-host.sh --manifest release-manifest.json --expected-platform $(shell_quote "$expected_platform") --skip-bind-port-check && scripts/deploy-control-plane-host.sh --manifest release-manifest.json --expected-platform $(shell_quote "$expected_platform") --dry-run && scripts/deploy-control-plane-host.sh --manifest release-manifest.json --expected-platform $(shell_quote "$expected_platform") && curl -fsS http://127.0.0.1:4000/readyz && curl -fsS http://127.0.0.1:4000/healthz"
else
  echo "Deploying edge on $target"
  remote_sudo \
    "cd $remote_dir_q && scripts/sync-edge-caddy-playback-routes.sh && scripts/preflight-edge-host.sh --manifest release-manifest.json --expected-platform $(shell_quote "$expected_platform") --skip-bind-port-check && scripts/deploy-edge-host.sh --manifest release-manifest.json --expected-platform $(shell_quote "$expected_platform") --dry-run && scripts/deploy-edge-host.sh --manifest release-manifest.json --expected-platform $(shell_quote "$expected_platform") && curl -fsS http://127.0.0.1:4100/readyz && curl -fsS http://127.0.0.1:4100/healthz"
fi

echo "$role deploy completed on $target"
