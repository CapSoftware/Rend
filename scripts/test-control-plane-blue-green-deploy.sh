#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rend-blue-green-test.XXXXXX")"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

file_mode() {
  local path="$1"
  if stat -c '%a' "$path" >/dev/null 2>&1; then
    stat -c '%a' "$path"
  else
    stat -f '%Lp' "$path"
  fi
}

fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

log="${FAKE_DOCKER_LOG:?}"

if [[ "$1" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "$1" == "info" ]]; then
  exit 0
fi
if [[ "$1" == "image" && "${2:-}" == "pull" ]]; then
  echo "docker image pull $3" >>"$log"
  if [[ "${FAKE_DOCKER_PULL_FAIL:-}" == "true" ]]; then
    echo "fake pull failure" >&2
    exit 1
  fi
  exit 0
fi
if [[ "$1" == "image" && "${2:-}" == "inspect" ]]; then
  echo "linux/amd64"
  exit 0
fi
if [[ "$1" == "inspect" ]]; then
  echo "${FAKE_PREVIOUS_WORKER_IMAGE:-registry.example/rend-media-worker:old}"
  exit 0
fi
if [[ "$1" == "compose" ]]; then
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f)
        shift 2
        ;;
      ps)
        echo "fake-worker-container"
        exit 0
        ;;
      pull)
        echo "docker compose pull" >>"$log"
        exit 0
        ;;
      run)
        echo "docker compose run $*" >>"$log"
        if [[ "${FAKE_DOCKER_MIGRATE_FAIL:-}" == "true" ]]; then
          echo "fake migration failure" >&2
          exit 1
        fi
        exit 0
        ;;
      up)
        echo "docker compose up $*" >>"$log"
        if [[ "${FAKE_DOCKER_UP_FAIL:-}" == "true" ]]; then
          echo "fake up failure" >&2
          exit 1
        fi
        exit 0
        ;;
      *)
        shift
        ;;
    esac
  done
fi

echo "unhandled fake docker command: $*" >&2
exit 1
EOF
chmod +x "$fake_bin/docker"

cat >"$fake_bin/caddy" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "caddy $*" >>"${FAKE_CADDY_LOG:?}"
if [[ "${FAKE_CADDY_FAIL:-}" == "true" ]]; then
  echo "fake caddy failure" >&2
  exit 1
fi
exit 0
EOF
chmod +x "$fake_bin/caddy"

cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${*: -1}"
echo "curl $url" >>"${FAKE_CURL_LOG:?}"
if [[ "${FAKE_CURL_FAIL_ALL:-}" == "true" ]]; then
  exit 7
fi
case "$url" in
  *:4001/readyz | *:4001/healthz | *:4002/readyz | *:4002/healthz)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$fake_bin/curl"

cat >"$fake_bin/flock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAKE_FLOCK_FAIL:-}" == "true" ]]; then
  echo "fake lock held" >&2
  exit 1
fi
exit 0
EOF
chmod +x "$fake_bin/flock"

cat >"$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "ssh $*" >>"${FAKE_SSH_LOG:?}"
exit 0
EOF
chmod +x "$fake_bin/ssh"

cat >"$fake_bin/scp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "scp $*" >>"${FAKE_SSH_LOG:?}"
exit 0
EOF
chmod +x "$fake_bin/scp"

make_manifest() {
  local path="$1"
  local kind="$2"
  if [[ "$kind" == "digest" ]]; then
    cat >"$path" <<'JSON'
{
  "short_sha": "test123",
  "platform": "linux/amd64",
  "services": {
    "rend-api": {
      "platform": "linux/amd64",
      "image_digest": "registry.example/rend-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "rend-media-worker": {
      "platform": "linux/amd64",
      "image_digest": "registry.example/rend-media-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  }
}
JSON
  else
    cat >"$path" <<'JSON'
{
  "short_sha": "test123",
  "platform": "linux/amd64",
  "services": {
    "rend-api": {
      "platform": "linux/amd64",
      "image_tag": "registry.example/rend-api:test"
    },
    "rend-media-worker": {
      "platform": "linux/amd64",
      "image_tag": "registry.example/rend-media-worker:test"
    }
  }
}
JSON
  fi
}

bootstrap_case="$tmp_dir/bootstrap-host-files"
mkdir -p "$bootstrap_case/etc/caddy" "$bootstrap_case/opt/rend" "$bootstrap_case/backups/old"
cat >"$bootstrap_case/backups/old/Caddyfile" <<'EOF'
{
	admin off
}

api.example.test {
	@public_api {
		path /v1/* /readyz
	}
	handle {
		reverse_proxy 127.0.0.1:4000
	}
}
EOF
cp "$root_dir/docs/templates/control-plane.Caddyfile" "$bootstrap_case/etc/caddy/Caddyfile"
REND_CONTROL_PLANE_COMPOSE_FILE="$bootstrap_case/opt/rend/control-plane.compose.yml" \
  REND_CONTROL_PLANE_CADDYFILE="$bootstrap_case/etc/caddy/Caddyfile" \
  REND_CONTROL_PLANE_CADDY_UPSTREAM_FILE="$bootstrap_case/etc/caddy/rend-control-plane-upstream.caddy" \
  REND_CONTROL_PLANE_BOOTSTRAP_BACKUP_DIR="$bootstrap_case/backups" \
  "$root_dir/scripts/bootstrap-control-plane-host-files.sh" >/dev/null
if grep -q 'REND_PUBLIC_API_HOSTNAME' "$bootstrap_case/etc/caddy/Caddyfile"; then
  echo "bootstrap-host-files: expected placeholder Caddyfile to be replaced from concrete backup" >&2
  exit 1
fi
if ! grep -q 'import rend_active_control_plane' "$bootstrap_case/etc/caddy/Caddyfile"; then
  echo "bootstrap-host-files: expected patched Caddyfile to use managed upstream import" >&2
  exit 1
fi
if ! grep -q 'path /v1/\* /v/\* /embed-fast/\* /readyz' "$bootstrap_case/etc/caddy/Caddyfile"; then
  echo "bootstrap-host-files: expected public Caddy matcher to include API-origin playback and fast embed paths" >&2
  exit 1
fi
if ! grep -q 'rend-control-plane-upstream.caddy' "$bootstrap_case/etc/caddy/Caddyfile"; then
  echo "bootstrap-host-files: expected patched Caddyfile to import managed upstream snippet" >&2
  exit 1
fi
if grep -q 'admin off' "$bootstrap_case/etc/caddy/Caddyfile"; then
  echo "bootstrap-host-files: expected legacy Caddy admin-off setting to be removed" >&2
  exit 1
fi
echo "ok: bootstrap host files repairs placeholder Caddyfile from concrete backup"

reset_case() {
  case_dir="$tmp_dir/$1"
  rm -rf "$case_dir"
  mkdir -p "$case_dir/state" "$case_dir/lock" "$case_dir/caddy"
  cp "$root_dir/docs/templates/control-plane.compose.yml" "$case_dir/control-plane.compose.yml"
  cat >"$case_dir/Caddyfile" <<EOF
{
	admin off
}
import $case_dir/caddy/upstream.caddy
localhost {
	handle {
		import rend_active_control_plane
	}
}
EOF
  cat >"$case_dir/caddy/upstream.caddy" <<'EOF'
(rend_active_control_plane) {
	reverse_proxy 127.0.0.1:4001
}
EOF
  printf 'blue\n' >"$case_dir/state/active-slot"
  printf '127.0.0.1:4001\n' >"$case_dir/state/active-upstream"
  make_manifest "$case_dir/manifest-local.json" local
  make_manifest "$case_dir/manifest-digest.json" digest
  export FAKE_DOCKER_LOG="$case_dir/docker.log"
  export FAKE_CADDY_LOG="$case_dir/caddy.log"
  export FAKE_CURL_LOG="$case_dir/curl.log"
  export FAKE_PREVIOUS_WORKER_IMAGE="registry.example/rend-media-worker:old"
}

active_upstream() {
  awk '$1 == "reverse_proxy" { print $2; exit }' "$case_dir/caddy/upstream.caddy"
}

assert_active_old() {
  local label="$1"
  local upstream
  upstream="$(active_upstream)"
  if [[ "$upstream" != "127.0.0.1:4001" ]]; then
    echo "$label: expected old active upstream 127.0.0.1:4001, got $upstream" >&2
    exit 1
  fi
}

assert_active_new() {
  local label="$1"
  local upstream
  upstream="$(active_upstream)"
  if [[ "$upstream" != "127.0.0.1:4002" ]]; then
    echo "$label: expected new active upstream 127.0.0.1:4002, got $upstream" >&2
    exit 1
  fi
}

assert_upstream() {
  local label="$1"
  local expected="$2"
  local upstream
  upstream="$(active_upstream)"
  if [[ "$upstream" != "$expected" ]]; then
    echo "$label: expected upstream $expected, got $upstream" >&2
    exit 1
  fi
}

assert_upstream_readable() {
  local label="$1"
  local mode
  mode="$(file_mode "$case_dir/caddy/upstream.caddy")"
  if [[ "$mode" != "644" ]]; then
    echo "$label: expected Caddy upstream snippet mode 644, got $mode" >&2
    exit 1
  fi
}

run_deploy() {
  PATH="$fake_bin:$PATH" \
    "$root_dir/scripts/deploy-control-plane-host.sh" \
    --manifest "$1" \
    --compose-file "$case_dir/control-plane.compose.yml" \
    --state-dir "$case_dir/state" \
    --lock-file "$case_dir/lock/deploy.lock" \
    --caddyfile "$case_dir/Caddyfile" \
    --caddy-upstream-file "$case_dir/caddy/upstream.caddy" \
    --caddy-reload-mode caddy \
    --allow-local-image-refs
}

run_rollback() {
  PATH="$fake_bin:$PATH" \
    "$root_dir/scripts/deploy-control-plane-host.sh" \
    --rollback \
    --compose-file "$case_dir/control-plane.compose.yml" \
    --state-dir "$case_dir/state" \
    --lock-file "$case_dir/lock/deploy.lock" \
    --caddyfile "$case_dir/Caddyfile" \
    --caddy-upstream-file "$case_dir/caddy/upstream.caddy" \
    --caddy-reload-mode caddy
}

expect_failure_result() {
  local label="$1"
  if [[ "$2" == "success" ]]; then
    echo "$label: expected failure" >&2
    exit 1
  fi
  assert_active_old "$label"
  echo "ok: $label kept old active slot serving"
}

reset_case bad-image-digest
if FAKE_DOCKER_PULL_FAIL=true run_deploy "$case_dir/manifest-digest.json"; then
  result=success
else
  result=failure
fi
expect_failure_result bad-image-digest "$result"

reset_case bad-env
if REND_DEPLOY_INJECT_BAD_ENV=true run_deploy "$case_dir/manifest-local.json"; then
  result=success
else
  result=failure
fi
expect_failure_result bad-env "$result"

reset_case candidate-never-healthy
if REND_DEPLOY_INJECT_CANDIDATE_UNHEALTHY=true run_deploy "$case_dir/manifest-local.json"; then
  result=success
else
  result=failure
fi
expect_failure_result candidate-never-healthy "$result"

reset_case caddy-reload-failure
if REND_DEPLOY_INJECT_CADDY_FAILURE=true run_deploy "$case_dir/manifest-local.json"; then
  result=success
else
  result=failure
fi
expect_failure_result caddy-reload-failure "$result"

reset_case post-promotion-failure
if REND_DEPLOY_INJECT_POST_PROMOTION_FAILURE=true run_deploy "$case_dir/manifest-local.json"; then
  result=success
else
  result=failure
fi
expect_failure_result post-promotion-failure "$result"

reset_case lock-held
if FAKE_FLOCK_FAIL=true run_deploy "$case_dir/manifest-local.json"; then
  echo "lock-held: expected failure" >&2
  exit 1
fi
assert_active_old lock-held
echo "ok: lock-held kept old active slot serving"

reset_case rollback
run_deploy "$case_dir/manifest-local.json"
assert_active_new rollback-promote
assert_upstream_readable rollback-promote
run_rollback
assert_active_old rollback
assert_upstream_readable rollback
if grep -q "image pull" "$case_dir/docker.log"; then
  echo "rollback: expected rollback without image pull" >&2
  exit 1
fi
echo "ok: rollback switched to previous slot without pulling/building"

reset_case legacy-bootstrap
rm -f "$case_dir/state/active-slot" "$case_dir/state/active-upstream"
cat >"$case_dir/caddy/upstream.caddy" <<'EOF'
(rend_active_control_plane) {
	reverse_proxy 127.0.0.1:4000
}
EOF
run_deploy "$case_dir/manifest-local.json"
assert_upstream legacy-bootstrap-promote "127.0.0.1:4001"
run_rollback
assert_upstream legacy-bootstrap-rollback "127.0.0.1:4000"
if grep -q "image pull" "$case_dir/docker.log"; then
  echo "legacy-bootstrap: expected rollback without image pull" >&2
  exit 1
fi
echo "ok: legacy bootstrap promoted blue and rolled back to port 4000 without pulling/building"

reset_case ssh-wrapper-systemd
export FAKE_SSH_LOG="$case_dir/ssh.log"
REND_CONTROL_PLANE_POST_PROMOTION_READY_URL="https://api.example.test/readyz" \
  PATH="$fake_bin:$PATH" \
  "$root_dir/scripts/deploy-release-over-ssh.sh" \
  --role control-plane \
  --host example.invalid \
  --user deploy \
  --manifest "$case_dir/manifest-digest.json" \
  --remote-dir "/tmp/rend-deploy-test"
if ! grep -q "systemd-run" "$case_dir/ssh.log"; then
  echo "ssh-wrapper-systemd: expected control-plane deploy to use systemd-run" >&2
  exit 1
fi
if ! grep -q "deploy-control-plane-host.sh" "$case_dir/ssh.log"; then
  echo "ssh-wrapper-systemd: expected control-plane transaction command in remote unit" >&2
  exit 1
fi
if ! grep -q -- "--post-promotion-url" "$case_dir/ssh.log"; then
  echo "ssh-wrapper-systemd: expected post-promotion public readiness URL to be forwarded" >&2
  exit 1
fi
if ! grep -q "bootstrap-control-plane-host-files.sh" "$case_dir/ssh.log"; then
  echo "ssh-wrapper-systemd: expected control-plane host file bootstrap" >&2
  exit 1
fi
echo "ok: SSH wrapper launches control-plane deploy through systemd-run"

reset_case ssh-wrapper-rollback-systemd
export FAKE_SSH_LOG="$case_dir/ssh.log"
PATH="$fake_bin:$PATH" \
  "$root_dir/scripts/deploy-release-over-ssh.sh" \
  --role control-plane \
  --host example.invalid \
  --user deploy \
  --rollback \
  --remote-dir "/tmp/rend-rollback-test"
if ! grep -q "systemd-run" "$case_dir/ssh.log"; then
  echo "ssh-wrapper-rollback-systemd: expected control-plane rollback to use systemd-run" >&2
  exit 1
fi
if ! grep -q -- "--rollback" "$case_dir/ssh.log"; then
  echo "ssh-wrapper-rollback-systemd: expected remote rollback command" >&2
  exit 1
fi
if ! grep -q "bootstrap-control-plane-host-files.sh" "$case_dir/ssh.log"; then
  echo "ssh-wrapper-rollback-systemd: expected control-plane host file bootstrap" >&2
  exit 1
fi
if grep -q "release-manifest.json" "$case_dir/ssh.log"; then
  echo "ssh-wrapper-rollback-systemd: rollback should not upload or reference a release manifest" >&2
  exit 1
fi
echo "ok: SSH wrapper launches control-plane rollback through systemd-run without a manifest"
