#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

manifest="${REND_RELEASE_MANIFEST:-}"
compose_file="${REND_CONTROL_PLANE_COMPOSE_FILE:-/opt/rend/control-plane.compose.yml}"
expected_platform="${REND_EXPECTED_IMAGE_PLATFORM:-linux/amd64}"
state_dir="${REND_CONTROL_PLANE_STATE_DIR:-/var/lib/rend/control-plane}"
lock_file="${REND_CONTROL_PLANE_LOCK_FILE:-/var/lock/rend-control-plane-deploy.lock}"
caddyfile="${REND_CONTROL_PLANE_CADDYFILE:-/etc/caddy/Caddyfile}"
caddy_upstream_file="${REND_CONTROL_PLANE_CADDY_UPSTREAM_FILE:-/etc/caddy/rend-control-plane-upstream.caddy}"
caddy_command="${REND_CADDY_COMMAND:-caddy}"
caddy_reload_mode="${REND_CADDY_RELOAD_MODE:-systemctl}"
api_publish_addr="${REND_API_PUBLISH_ADDR:-127.0.0.1}"
api_upstream_addr="${REND_API_SLOT_UPSTREAM_ADDR:-127.0.0.1}"
api_probe_host="${REND_API_SLOT_PROBE_HOST:-127.0.0.1}"
api_blue_port="${REND_API_BLUE_PUBLISH_PORT:-4001}"
api_green_port="${REND_API_GREEN_PUBLISH_PORT:-4002}"
candidate_ready_retries="${REND_DEPLOY_CANDIDATE_READY_RETRIES:-18}"
candidate_ready_delay="${REND_DEPLOY_CANDIDATE_READY_DELAY_SECS:-5}"
post_promotion_url="${REND_CONTROL_PLANE_POST_PROMOTION_READY_URL:-}"
post_promotion_retries="${REND_DEPLOY_POST_PROMOTION_RETRIES:-8}"
post_promotion_delay="${REND_DEPLOY_POST_PROMOTION_DELAY_SECS:-3}"
dry_run=false
allow_local_image_refs=false
rollback=false

usage() {
  cat <<'EOF'
Usage: scripts/deploy-control-plane-host.sh --manifest FILE [options]
       scripts/deploy-control-plane-host.sh --rollback [options]

Transactionally deploy the control plane with blue/green API slots.

Normal deploy:
  - validates immutable manifest refs and pulled image platform
  - runs the one-shot rend-api migrate service
  - starts the inactive API slot only
  - probes candidate /readyz and /healthz directly
  - promotes by atomically switching the Caddy upstream snippet and reloading Caddy
  - rolls Caddy back to the previous slot if post-promotion checks fail

Options:
  --manifest FILE             Release manifest with image_digest refs.
  --compose-file FILE         Compose file. Default: /opt/rend/control-plane.compose.yml.
  --state-dir DIR             Slot state dir. Default: /var/lib/rend/control-plane.
  --lock-file FILE            Deploy lock file. Default: /var/lock/rend-control-plane-deploy.lock.
  --caddyfile FILE            Caddyfile that imports the upstream snippet.
                              Default: /etc/caddy/Caddyfile.
  --caddy-upstream-file FILE  Managed Caddy snippet. Default:
                              /etc/caddy/rend-control-plane-upstream.caddy.
  --caddy-reload-mode MODE    systemctl, caddy, or none. Default: systemctl.
  --blue-port PORT            Host port for rend-api-blue. Default: 4001.
  --green-port PORT           Host port for rend-api-green. Default: 4002.
  --post-promotion-url URL    Optional public/Caddy readiness URL checked after reload.
  --expected-platform PLATFORM
                              Expected host image platform. Default: linux/amd64.
  --rollback                  Switch Caddy back to the previous recorded upstream without pulling/building.
  --dry-run                   Print the transaction without mutating services or Caddy.
  --allow-local-image-refs    Permit manifest image_tag fallback when image_digest is absent.
  -h, --help                  Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      manifest="${2:?missing value for $1}"
      shift 2
      ;;
    --compose-file)
      compose_file="${2:?missing value for $1}"
      shift 2
      ;;
    --state-dir)
      state_dir="${2:?missing value for $1}"
      shift 2
      ;;
    --lock-file)
      lock_file="${2:?missing value for $1}"
      shift 2
      ;;
    --caddyfile)
      caddyfile="${2:?missing value for $1}"
      shift 2
      ;;
    --caddy-upstream-file)
      caddy_upstream_file="${2:?missing value for $1}"
      shift 2
      ;;
    --caddy-reload-mode)
      caddy_reload_mode="${2:?missing value for $1}"
      shift 2
      ;;
    --blue-port)
      api_blue_port="${2:?missing value for $1}"
      shift 2
      ;;
    --green-port)
      api_green_port="${2:?missing value for $1}"
      shift 2
      ;;
    --post-promotion-url)
      post_promotion_url="${2:?missing value for $1}"
      shift 2
      ;;
    --expected-platform)
      expected_platform="${2:?missing value for $1}"
      shift 2
      ;;
    --rollback)
      rollback=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --allow-local-image-refs)
      allow_local_image_refs=true
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

if [[ "$rollback" != "true" && -z "$manifest" ]]; then
  usage >&2
  exit 2
fi

require_port() {
  local label="$1"
  local value="$2"
  if [[ "$value" =~ ^[0-9]+$ ]] && [[ "$value" -ge 1 && "$value" -le 65535 ]]; then
    return 0
  fi
  echo "error: $label must be a TCP port: $value" >&2
  exit 2
}

require_port "--blue-port" "$api_blue_port"
require_port "--green-port" "$api_green_port"
if [[ "$api_blue_port" == "$api_green_port" ]]; then
  echo "error: blue and green ports must differ" >&2
  exit 2
fi
case "$caddy_reload_mode" in
  systemctl | caddy | none) ;;
  *)
    echo "error: --caddy-reload-mode must be systemctl, caddy, or none" >&2
    exit 2
    ;;
esac

state_file() {
  printf '%s/%s\n' "$state_dir" "$1"
}

read_state() {
  local name="$1"
  local file
  file="$(state_file "$name")"
  [[ -f "$file" ]] || return 1
  sed -n '1p' "$file"
}

write_state() {
  local name="$1"
  local value="$2"
  local file tmp
  file="$(state_file "$name")"
  if [[ "$dry_run" == "true" ]]; then
    echo "write $(operator_shell_join "$file") <- $value"
    return 0
  fi
  tmp="$(mktemp "$state_dir/.${name}.XXXXXX")"
  printf '%s\n' "$value" >"$tmp"
  mv "$tmp" "$file"
}

slot_port() {
  case "$1" in
    blue) printf '%s\n' "$api_blue_port" ;;
    green) printf '%s\n' "$api_green_port" ;;
    *)
      echo "unknown slot: $1" >&2
      return 1
      ;;
  esac
}

slot_upstream() {
  printf '%s:%s\n' "$api_upstream_addr" "$(slot_port "$1")"
}

slot_from_upstream() {
  local upstream="$1"
  case "$upstream" in
    "$api_upstream_addr:$api_blue_port" | "127.0.0.1:$api_blue_port" | "localhost:$api_blue_port")
      printf 'blue\n'
      ;;
    "$api_upstream_addr:$api_green_port" | "127.0.0.1:$api_green_port" | "localhost:$api_green_port")
      printf 'green\n'
      ;;
    *)
      printf 'legacy\n'
      ;;
  esac
}

opposite_slot() {
  case "$1" in
    blue) printf 'green\n' ;;
    green) printf 'blue\n' ;;
    legacy | "") printf 'blue\n' ;;
    *)
      echo "unknown active slot: $1" >&2
      return 1
      ;;
  esac
}

current_upstream() {
  if [[ -f "$caddy_upstream_file" ]]; then
    awk '$1 == "reverse_proxy" { print $2; exit }' "$caddy_upstream_file"
    return 0
  fi
  printf '127.0.0.1:4000\n'
}

active_slot() {
  local slot upstream
  slot="$(read_state active-slot 2>/dev/null || true)"
  case "$slot" in
    blue | green) printf '%s\n' "$slot" && return 0 ;;
  esac
  upstream="$(current_upstream)"
  slot_from_upstream "$upstream"
}

compose_run() {
  operator_run_or_dry_run "$dry_run" \
    env \
    "REND_API_IMAGE=$api_image" \
    "REND_MEDIA_WORKER_IMAGE=$worker_image" \
    "REND_API_PUBLISH_ADDR=$api_publish_addr" \
    "REND_API_BLUE_PUBLISH_PORT=$api_blue_port" \
    "REND_API_GREEN_PUBLISH_PORT=$api_green_port" \
    docker compose -f "$compose_file" "$@"
}

probe_url() {
  local label="$1"
  local url="$2"
  local retries="${3:-$candidate_ready_retries}"
  local delay="${4:-$candidate_ready_delay}"
  if [[ "$dry_run" == "true" ]]; then
    operator_shell_join curl -fsS --retry "$retries" --retry-delay "$delay" --retry-all-errors "$url"
    return 0
  fi
  curl -fsS --retry "$retries" --retry-delay "$delay" --retry-all-errors "$url" >/dev/null
  echo "$label passed"
}

write_upstream_snippet() {
  local target="$1"
  local upstream="$2"
  {
    echo "# Managed by scripts/deploy-control-plane-host.sh."
    echo "(rend_active_control_plane) {"
    printf '\treverse_proxy %s\n' "$upstream"
    echo "}"
  } >"$target"
  chmod 0644 "$target"
}

restore_upstream() {
  local upstream="$1"
  local tmp
  if [[ "$dry_run" == "true" ]]; then
    echo "restore Caddy upstream to $upstream"
    return 0
  fi
  tmp="$(mktemp "$(dirname "$caddy_upstream_file")/.rend-control-plane-upstream.XXXXXX")"
  write_upstream_snippet "$tmp" "$upstream"
  mv "$tmp" "$caddy_upstream_file"
}

reload_caddy() {
  if [[ "$dry_run" == "true" ]]; then
    operator_shell_join "$caddy_command" validate --config "$caddyfile"
    case "$caddy_reload_mode" in
      systemctl) operator_shell_join systemctl reload caddy ;;
      caddy) operator_shell_join "$caddy_command" reload --config "$caddyfile" ;;
      none) echo "skip Caddy reload (--caddy-reload-mode none)" ;;
    esac
    return 0
  fi

  "$caddy_command" validate --config "$caddyfile"
  case "$caddy_reload_mode" in
    systemctl) systemctl reload caddy ;;
    caddy) "$caddy_command" reload --config "$caddyfile" ;;
    none) operator_warn "skipping Caddy reload because --caddy-reload-mode none was set" ;;
  esac
}

promote_upstream() {
  local new_upstream="$1"
  local old_upstream="$2"
  local tmp
  if [[ "$dry_run" == "true" ]]; then
    echo "promote Caddy upstream: $old_upstream -> $new_upstream"
    reload_caddy
    return 0
  fi

  tmp="$(mktemp "$(dirname "$caddy_upstream_file")/.rend-control-plane-upstream.XXXXXX")"
  write_upstream_snippet "$tmp" "$new_upstream"
  mv "$tmp" "$caddy_upstream_file"

  if [[ "${REND_DEPLOY_INJECT_CADDY_FAILURE:-}" == "true" ]]; then
    restore_upstream "$old_upstream"
    echo "error: injected Caddy validation/reload failure" >&2
    return 1
  fi

  if reload_caddy; then
    return 0
  fi

  operator_warn "Caddy validation/reload failed; restoring previous upstream $old_upstream"
  restore_upstream "$old_upstream"
  if ! reload_caddy; then
    operator_warn "restoring previous Caddy upstream also failed; active Caddy process should still be serving its last loaded config"
  fi
  return 1
}

current_worker_image() {
  local container_id
  container_id="$(
    env \
      "REND_API_IMAGE=${api_image:-placeholder}" \
      "REND_MEDIA_WORKER_IMAGE=${worker_image:-placeholder}" \
      "REND_API_PUBLISH_ADDR=$api_publish_addr" \
      "REND_API_BLUE_PUBLISH_PORT=$api_blue_port" \
      "REND_API_GREEN_PUBLISH_PORT=$api_green_port" \
      docker compose -f "$compose_file" ps -q rend-media-worker 2>/dev/null | head -n 1
  )"
  [[ -n "$container_id" ]] || return 0
  docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null || true
}

restore_worker_image() {
  local previous_image="$1"
  [[ -n "$previous_image" ]] || return 0
  operator_warn "restoring previous media worker image"
  operator_run_or_dry_run "$dry_run" \
    env \
    "REND_API_IMAGE=${api_image:-placeholder}" \
    "REND_MEDIA_WORKER_IMAGE=$previous_image" \
    "REND_API_PUBLISH_ADDR=$api_publish_addr" \
    "REND_API_BLUE_PUBLISH_PORT=$api_blue_port" \
    "REND_API_GREEN_PUBLISH_PORT=$api_green_port" \
    docker compose -f "$compose_file" up -d --no-deps --force-recreate rend-media-worker
}

rollback_to_previous() {
  local failed_slot="$1"
  local failed_upstream="$2"
  local reason="$3"
  local previous_slot previous_upstream previous_worker
  previous_slot="$(read_state previous-slot 2>/dev/null || true)"
  previous_upstream="$(read_state previous-upstream 2>/dev/null || true)"
  previous_worker="$(read_state previous-worker-image 2>/dev/null || true)"

  if [[ -z "$previous_upstream" ]]; then
    echo "error: cannot roll back after $reason because previous-upstream is not recorded" >&2
    return 1
  fi

  operator_warn "rolling Caddy back to $previous_upstream after $reason"
  if [[ "$previous_slot" == "blue" || "$previous_slot" == "green" ]]; then
    probe_url "rollback slot /readyz" "http://$api_probe_host:$(slot_port "$previous_slot")/readyz" "$post_promotion_retries" "$post_promotion_delay"
  elif [[ "$previous_upstream" =~ :([0-9]+)$ ]]; then
    probe_url "rollback upstream /readyz" "http://$api_probe_host:${BASH_REMATCH[1]}/readyz" "$post_promotion_retries" "$post_promotion_delay"
  fi

  promote_upstream "$previous_upstream" "$failed_upstream"
  write_state active-slot "${previous_slot:-legacy}"
  write_state active-upstream "$previous_upstream"
  write_state previous-slot "$failed_slot"
  write_state previous-upstream "$failed_upstream"
  restore_worker_image "$previous_worker"
}

run_rollback() {
  local current previous_slot previous_upstream
  operator_require_command curl
  if [[ "$dry_run" != "true" && "$caddy_reload_mode" != "none" ]]; then
    operator_require_command "$caddy_command"
  fi
  if [[ "$dry_run" != "true" && "$caddy_reload_mode" == "systemctl" ]]; then
    operator_require_command systemctl
  fi
  operator_require_file "$caddyfile"
  operator_finish
  current="$(current_upstream)"
  previous_slot="$(read_state previous-slot 2>/dev/null || true)"
  previous_upstream="$(read_state previous-upstream 2>/dev/null || true)"
  [[ -n "$previous_upstream" ]] || operator_die "previous-upstream is not recorded in $state_dir"

  if [[ "$previous_slot" == "blue" || "$previous_slot" == "green" ]]; then
    probe_url "rollback slot /readyz" "http://$api_probe_host:$(slot_port "$previous_slot")/readyz" "$post_promotion_retries" "$post_promotion_delay"
  elif [[ "$previous_upstream" =~ :([0-9]+)$ ]]; then
    probe_url "rollback upstream /readyz" "http://$api_probe_host:${BASH_REMATCH[1]}/readyz" "$post_promotion_retries" "$post_promotion_delay"
  fi

  promote_upstream "$previous_upstream" "$current"
  write_state active-slot "${previous_slot:-legacy}"
  write_state active-upstream "$previous_upstream"
  write_state previous-slot "$(slot_from_upstream "$current")"
  write_state previous-upstream "$current"
  echo "Control-plane rollback switched Caddy to $previous_upstream"
}

run_deploy() {
  local active candidate old_upstream candidate_upstream previous_worker candidate_port
  operator_require_command python3
  operator_require_command curl
  if [[ "$dry_run" != "true" && "$caddy_reload_mode" != "none" ]]; then
    operator_require_command "$caddy_command"
  fi
  if [[ "$dry_run" != "true" && "$caddy_reload_mode" == "systemctl" ]]; then
    operator_require_command systemctl
  fi
  operator_check_docker_compose
  operator_require_file "$compose_file"
  operator_require_file "$caddyfile"
  operator_validate_manifest_services "$manifest" "$allow_local_image_refs" "$expected_platform" rend-api rend-media-worker
  operator_finish

  api_image="$(operator_manifest_image_ref "$manifest" rend-api "$allow_local_image_refs")"
  worker_image="$(operator_manifest_image_ref "$manifest" rend-media-worker "$allow_local_image_refs")"

  if [[ "$dry_run" != "true" ]]; then
    operator_info "checking manifest image pull readiness and platform"
    operator_check_manifest_image_pulls "$manifest" "$allow_local_image_refs" "$expected_platform" rend-api rend-media-worker
    operator_finish
  fi

  active="$(active_slot)"
  candidate="$(opposite_slot "$active")"
  old_upstream="$(current_upstream)"
  candidate_upstream="$(slot_upstream "$candidate")"
  candidate_port="$(slot_port "$candidate")"
  previous_worker="$(current_worker_image || true)"

  echo "Active control-plane slot: $active ($old_upstream)"
  echo "Candidate control-plane slot: $candidate ($candidate_upstream)"

  write_state previous-slot "$active"
  write_state previous-upstream "$old_upstream"
  write_state previous-worker-image "$previous_worker"

  operator_info "pulling candidate images"
  compose_run pull

  operator_info "running one-shot Postgres migration with candidate API image"
  if [[ "${REND_DEPLOY_INJECT_BAD_ENV:-}" == "true" ]]; then
    echo "error: injected bad env failure before migration" >&2
    return 1
  fi
  compose_run run --rm --no-deps rend-api-migrate

  operator_info "starting inactive API slot $candidate"
  compose_run up -d --no-deps --force-recreate "rend-api-$candidate"

  if [[ "${REND_DEPLOY_INJECT_CANDIDATE_UNHEALTHY:-}" == "true" ]]; then
    echo "error: injected candidate health failure" >&2
    return 1
  fi

  probe_url "candidate /readyz" "http://$api_probe_host:$candidate_port/readyz"
  probe_url "candidate /healthz" "http://$api_probe_host:$candidate_port/healthz"

  operator_info "promoting Caddy upstream to $candidate_upstream"
  if ! promote_upstream "$candidate_upstream" "$old_upstream"; then
    echo "error: promotion failed before Caddy switched traffic; previous upstream remains $old_upstream" >&2
    return 1
  fi

  write_state active-slot "$candidate"
  write_state active-upstream "$candidate_upstream"
  write_state previous-slot "$active"
  write_state previous-upstream "$old_upstream"

  if [[ "${REND_DEPLOY_INJECT_POST_PROMOTION_FAILURE:-}" == "true" ]]; then
    rollback_to_previous "$candidate" "$candidate_upstream" "injected post-promotion health failure"
    return 1
  fi

  if ! probe_url "promoted slot /readyz" "http://$api_probe_host:$candidate_port/readyz" "$post_promotion_retries" "$post_promotion_delay"; then
    rollback_to_previous "$candidate" "$candidate_upstream" "promoted slot readiness failure"
    return 1
  fi
  if [[ -n "$post_promotion_url" ]] &&
    ! probe_url "post-promotion public readiness" "$post_promotion_url" "$post_promotion_retries" "$post_promotion_delay"; then
    rollback_to_previous "$candidate" "$candidate_upstream" "post-promotion public readiness failure"
    return 1
  fi

  operator_info "starting media worker with candidate image"
  if ! compose_run up -d --no-deps --force-recreate rend-media-worker; then
    rollback_to_previous "$candidate" "$candidate_upstream" "media worker update failure"
    return 1
  fi

  echo "Control-plane deploy promoted $candidate and kept previous slot $active available for rollback"
}

if [[ "$dry_run" != "true" ]]; then
  operator_require_command flock
  operator_finish
  mkdir -p "$state_dir" "$(dirname "$lock_file")" "$(dirname "$caddy_upstream_file")"
  exec 9>"$lock_file"
  if ! flock -n 9; then
    echo "error: another control-plane deploy holds $lock_file" >&2
    exit 75
  fi
fi

if [[ "$rollback" == "true" ]]; then
  run_rollback
else
  run_deploy
fi
