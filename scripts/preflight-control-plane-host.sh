#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

manifest="${REND_RELEASE_MANIFEST:-}"
api_env="${REND_API_ENV_FILE:-/etc/rend/rend-api.env}"
worker_env="${REND_MEDIA_WORKER_ENV_FILE:-/etc/rend/rend-media-worker.env}"
compose_file="${REND_CONTROL_PLANE_COMPOSE_FILE:-/opt/rend/control-plane.compose.yml}"
caddyfile="${REND_CONTROL_PLANE_CADDYFILE:-/etc/caddy/Caddyfile}"
caddy_upstream_file="${REND_CONTROL_PLANE_CADDY_UPSTREAM_FILE:-/etc/caddy/rend-control-plane-upstream.caddy}"
caddy_command="${REND_CADDY_COMMAND:-caddy}"
blue_port="${REND_API_BLUE_PUBLISH_PORT:-4001}"
green_port="${REND_API_GREEN_PUBLISH_PORT:-4002}"
expected_platform="${REND_EXPECTED_IMAGE_PLATFORM:-linux/amd64}"
allow_dev_defaults=false
allow_placeholders=false
allow_local_image_refs=false
dry_run=false
skip_connectivity=false
skip_bind_port_check=false

usage() {
  cat <<'EOF'
Usage: scripts/preflight-control-plane-host.sh --manifest FILE [options]

Run first-host control-plane operator preflight checks.

Options:
  --manifest FILE             Release manifest with rend-api and rend-media-worker image_digest refs.
  --api-env FILE              API env file. Default: /etc/rend/rend-api.env.
  --worker-env FILE           Worker env file. Default: /etc/rend/rend-media-worker.env.
  --compose-file FILE         Compose file. Default: /opt/rend/control-plane.compose.yml.
  --caddyfile FILE            Caddyfile that imports the managed upstream snippet.
                              Default: /etc/caddy/Caddyfile.
  --caddy-upstream-file FILE  Managed upstream snippet. Default:
                              /etc/caddy/rend-control-plane-upstream.caddy.
  --blue-port PORT            Host port for rend-api-blue. Default: 4001.
  --green-port PORT           Host port for rend-api-green. Default: 4002.
  --expected-platform PLATFORM
                              Expected host image platform. Default: linux/amd64.
  --dry-run                   Skip network probes; validate local inputs only.
  --skip-connectivity         Skip managed dependency connectivity probes.
  --skip-bind-port-check      Compatibility no-op; blue/green deploys keep the active slot bound.
  --allow-dev-defaults        Permit local Docker/dev defaults.
  --allow-placeholders        Permit placeholder example values.
  --allow-local-image-refs    Permit manifest image_tag fallback when image_digest is absent.
  -h, --help                  Show this help.

Local example dry-run:
  scripts/preflight-control-plane-host.sh --dry-run --allow-dev-defaults \
    --allow-local-image-refs --manifest .rend/releases/production-001.json \
    --api-env .env.docker.example --worker-env .env.docker.example \
    --compose-file docs/templates/control-plane.compose.yml
EOF
}

file_mode() {
  local path="$1"
  if stat -c '%a' "$path" >/dev/null 2>&1; then
    stat -c '%a' "$path"
  else
    stat -f '%Lp' "$path"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      manifest="${2:?missing value for $1}"
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
    --compose-file)
      compose_file="${2:?missing value for $1}"
      shift 2
      ;;
    --publish-addr | --publish-port)
      operator_warn "$1 is ignored for blue/green control-plane preflight"
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
    --blue-port)
      blue_port="${2:?missing value for $1}"
      shift 2
      ;;
    --green-port)
      green_port="${2:?missing value for $1}"
      shift 2
      ;;
    --expected-platform)
      expected_platform="${2:?missing value for $1}"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --skip-connectivity)
      skip_connectivity=true
      shift
      ;;
    --skip-bind-port-check)
      skip_bind_port_check=true
      shift
      ;;
    --allow-dev-defaults)
      allow_dev_defaults=true
      shift
      ;;
    --allow-placeholders)
      allow_placeholders=true
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

[[ -n "$manifest" ]] || {
  usage >&2
  exit 2
}

operator_require_command python3
operator_require_command curl
if [[ "$dry_run" != "true" ]]; then
  operator_require_command "$caddy_command"
fi
operator_check_docker_compose
operator_require_file "$compose_file"
operator_require_file "$caddyfile"
operator_require_file "$caddy_upstream_file"

if [[ "$blue_port" =~ ^[0-9]+$ && "$blue_port" -ge 1 && "$blue_port" -le 65535 ]]; then
  operator_ok "blue slot port is valid: $blue_port"
else
  operator_fail "blue slot port must be 1-65535"
fi
if [[ "$green_port" =~ ^[0-9]+$ && "$green_port" -ge 1 && "$green_port" -le 65535 ]]; then
  operator_ok "green slot port is valid: $green_port"
else
  operator_fail "green slot port must be 1-65535"
fi
if [[ "$blue_port" == "$green_port" ]]; then
  operator_fail "blue and green slot ports must differ"
fi

if grep -Fq "import rend_active_control_plane" "$caddyfile" &&
  (grep -Fq "$caddy_upstream_file" "$caddyfile" ||
    grep -Fq "/etc/caddy/rend-control-plane-upstream.caddy" "$caddyfile"); then
  operator_ok "Caddyfile imports the managed control-plane upstream snippet"
else
  operator_fail "$caddyfile must import $caddy_upstream_file and use import rend_active_control_plane"
fi
if grep -Eq "reverse_proxy[[:space:]]+[^[:space:]]+" "$caddy_upstream_file"; then
  operator_ok "control-plane upstream snippet contains a reverse_proxy target"
else
  operator_fail "$caddy_upstream_file must define rend_active_control_plane with reverse_proxy"
fi
upstream_mode="$(file_mode "$caddy_upstream_file")"
if [[ "$upstream_mode" =~ ^[0-7]+$ ]] && (((8#$upstream_mode & 4) == 4)); then
  operator_ok "control-plane upstream snippet is readable by the Caddy service"
else
  operator_fail "$caddy_upstream_file must be world-readable so the caddy service user can import it"
fi
if [[ "$dry_run" == "true" ]]; then
  operator_warn "skipping Caddy config validation"
elif "$caddy_command" validate --config "$caddyfile" >/dev/null; then
  operator_ok "Caddy config validation passed"
else
  operator_fail "Caddy config validation failed"
fi

operator_info "validating control-plane env files"
operator_validate_api_env "$api_env" "$allow_dev_defaults" "$allow_placeholders"
operator_validate_worker_env "$worker_env" "$allow_dev_defaults" "$allow_placeholders"

operator_info "validating release manifest image refs"
operator_validate_manifest_services "$manifest" "$allow_local_image_refs" "$expected_platform" rend-api rend-media-worker

if [[ "$dry_run" == "true" ]]; then
  operator_warn "skipping manifest image pull readiness check"
else
  operator_info "checking manifest image pull readiness"
  operator_check_manifest_image_pulls "$manifest" "$allow_local_image_refs" "$expected_platform" rend-api rend-media-worker
fi

if [[ "$skip_bind_port_check" == "true" ]]; then
  operator_warn "--skip-bind-port-check is no longer needed for blue/green control-plane deploys"
fi
operator_warn "skipping bind-port check; active blue/green slots are expected to keep one API port bound"

probe_postgres() {
  local database_url="$1"
  local psql_url
  if ! command -v psql >/dev/null 2>&1; then
    operator_warn "psql is not installed; skipping Postgres connectivity probe"
    return 0
  fi
  psql_url="$(operator_psql_database_url "$database_url")"
  if [[ "$psql_url" != "$database_url" ]]; then
    operator_info "normalized DATABASE_URL for psql by removing sslrootcert=system"
  fi
  if PGCONNECT_TIMEOUT=8 psql "$psql_url" -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null 2>&1; then
    operator_ok "Postgres connectivity probe passed"
  else
    operator_fail "Postgres connectivity probe failed"
  fi
}

probe_clickhouse() {
  local url="$1"
  local database="$2"
  local user="$3"
  local password="$4"
  local exists
  url="${url%/}"
  if curl --http1.1 -fsS --max-time 10 --retry 3 --retry-delay 2 --retry-all-errors -u "$user:$password" \
    "$url/?database=$database&query=SELECT%201" >/dev/null; then
    operator_ok "ClickHouse connectivity probe passed"
  else
    operator_warn "ClickHouse connectivity probe failed after retries; continuing because runtime telemetry can retry"
    return 0
  fi
  exists="$(
    curl --http1.1 -fsS --max-time 10 -u "$user:$password" \
      --retry 3 --retry-delay 2 --retry-all-errors \
      "$url/?database=$database&query=EXISTS%20TABLE%20playback_events" || true
  )"
  if [[ "$exists" == "1" ]]; then
    operator_ok "ClickHouse playback telemetry table probe passed"
  else
    operator_warn "ClickHouse playback_events table probe failed; continuing because runtime telemetry can retry"
  fi
}

probe_object_store() {
  local health_url="$1"
  if curl -fsS --max-time 10 "$health_url" >/dev/null; then
    operator_ok "object-store health probe passed"
  else
    operator_fail "object-store health probe failed"
  fi
}

if [[ "$dry_run" == "true" || "$skip_connectivity" == "true" ]]; then
  operator_warn "skipping managed dependency connectivity probes"
else
  probe_postgres "$(operator_env_value "$api_env" DATABASE_URL)"
  probe_clickhouse \
    "$(operator_env_value "$api_env" CLICKHOUSE_URL)" \
    "$(operator_env_value "$api_env" CLICKHOUSE_DATABASE)" \
    "$(operator_env_value "$api_env" CLICKHOUSE_USER)" \
    "$(operator_env_value "$api_env" CLICKHOUSE_PASSWORD)"
  probe_object_store "$(operator_env_value "$api_env" OBJECT_STORE_HEALTH_URL)"
fi

operator_finish
echo "Control-plane host preflight passed"
