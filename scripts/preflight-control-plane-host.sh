#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

manifest="${REND_RELEASE_MANIFEST:-}"
api_env="${REND_API_ENV_FILE:-/etc/rend/rend-api.env}"
worker_env="${REND_MEDIA_WORKER_ENV_FILE:-/etc/rend/rend-media-worker.env}"
compose_file="${REND_CONTROL_PLANE_COMPOSE_FILE:-/opt/rend/control-plane.compose.yml}"
publish_addr="${REND_API_PUBLISH_ADDR:-127.0.0.1}"
publish_port="${REND_API_PUBLISH_PORT:-4000}"
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
  --publish-addr ADDR         Host publish address to probe. Default: 127.0.0.1.
  --publish-port PORT         Host publish port to probe. Default: 4000.
  --dry-run                   Skip network and bind-port probes; validate local inputs only.
  --skip-connectivity         Skip managed dependency connectivity probes.
  --skip-bind-port-check      Skip bind-port probe.
  --allow-dev-defaults        Permit local Docker/dev defaults.
  --allow-placeholders        Permit placeholder example values.
  --allow-local-image-refs    Permit manifest image_tag fallback when image_digest is absent.
  -h, --help                  Show this help.

Local example dry-run:
  scripts/preflight-control-plane-host.sh --dry-run --allow-dev-defaults \
    --allow-local-image-refs --manifest .rend/releases/trial-001.json \
    --api-env .env.docker.example --worker-env .env.docker.example \
    --compose-file docs/templates/control-plane.compose.yml
EOF
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
    --publish-addr)
      publish_addr="${2:?missing value for $1}"
      shift 2
      ;;
    --publish-port)
      publish_port="${2:?missing value for $1}"
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
operator_check_docker_compose
operator_require_file "$compose_file"

operator_info "validating control-plane env files"
operator_validate_api_env "$api_env" "$allow_dev_defaults" "$allow_placeholders"
operator_validate_worker_env "$worker_env" "$allow_dev_defaults" "$allow_placeholders"

operator_info "validating release manifest image refs"
operator_validate_manifest_services "$manifest" "$allow_local_image_refs" rend-api rend-media-worker

if [[ "$dry_run" == "true" || "$skip_bind_port_check" == "true" ]]; then
  operator_warn "skipping bind-port check"
else
  if operator_check_bind_port_free "$publish_addr" "$publish_port" 2>/tmp/rend-bind-error.$$; then
    operator_ok "$publish_addr:$publish_port is bindable"
  else
    operator_fail "$(cat /tmp/rend-bind-error.$$)"
  fi
  rm -f /tmp/rend-bind-error.$$
fi

probe_postgres() {
  local database_url="$1"
  if ! command -v psql >/dev/null 2>&1; then
    operator_warn "psql is not installed; skipping Postgres connectivity probe"
    return 0
  fi
  if PGCONNECT_TIMEOUT=8 psql "$database_url" -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null 2>&1; then
    operator_ok "Postgres connectivity probe passed"
  else
    operator_fail "Postgres connectivity probe failed"
  fi
}

probe_redis() {
  local redis_url="$1"
  if ! command -v redis-cli >/dev/null 2>&1; then
    operator_warn "redis-cli is not installed; skipping Redis connectivity probe"
    return 0
  fi
  if redis-cli -u "$redis_url" --no-auth-warning ping >/dev/null 2>&1; then
    operator_ok "Redis connectivity probe passed"
  else
    operator_fail "Redis connectivity probe failed"
  fi
}

probe_clickhouse() {
  local url="$1"
  local database="$2"
  local user="$3"
  local password="$4"
  local exists
  url="${url%/}"
  if curl -fsS --max-time 10 -u "$user:$password" \
    "$url/?database=$database&query=SELECT%201" >/dev/null; then
    operator_ok "ClickHouse connectivity probe passed"
  else
    operator_fail "ClickHouse connectivity probe failed"
    return 0
  fi
  exists="$(
    curl -fsS --max-time 10 -u "$user:$password" \
      "$url/?database=$database&query=EXISTS%20TABLE%20playback_events" || true
  )"
  if [[ "$exists" == "1" ]]; then
    operator_ok "ClickHouse playback telemetry table probe passed"
  else
    operator_fail "ClickHouse playback_events table is missing or not queryable"
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
  probe_redis "$(operator_env_value "$api_env" REND_REDIS_URL)"
  probe_clickhouse \
    "$(operator_env_value "$api_env" CLICKHOUSE_URL)" \
    "$(operator_env_value "$api_env" CLICKHOUSE_DATABASE)" \
    "$(operator_env_value "$api_env" CLICKHOUSE_USER)" \
    "$(operator_env_value "$api_env" CLICKHOUSE_PASSWORD)"
  probe_object_store "$(operator_env_value "$api_env" OBJECT_STORE_HEALTH_URL)"
fi

operator_finish
echo "Control-plane host preflight passed"
