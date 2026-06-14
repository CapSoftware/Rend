#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

manifest="${REND_RELEASE_MANIFEST:-}"
edge_env="${REND_EDGE_ENV_FILE:-/etc/rend/rend-edge.env}"
compose_file="${REND_EDGE_COMPOSE_FILE:-/opt/rend/edge.compose.yml}"
publish_addr="${REND_EDGE_PUBLISH_ADDR:-127.0.0.1}"
publish_port="${REND_EDGE_PUBLISH_PORT:-4100}"
cache_dir="${REND_EDGE_CACHE_VOLUME:-}"
spool_dir="${REND_EDGE_TELEMETRY_SPOOL_VOLUME:-}"
expected_platform="${REND_EXPECTED_IMAGE_PLATFORM:-linux/amd64}"
allow_dev_defaults=false
allow_placeholders=false
allow_local_image_refs=false
allow_direct_edge_exposure=false
dry_run=false
skip_connectivity=false
skip_bind_port_check=false
skip_dir_check=false

usage() {
  cat <<'EOF'
Usage: scripts/preflight-edge-host.sh --manifest FILE [options]

Run first-host edge operator preflight checks.

Options:
  --manifest FILE             Release manifest with rend-edge image_digest ref.
  --edge-env FILE             Edge env file. Default: /etc/rend/rend-edge.env.
  --compose-file FILE         Compose file. Default: /opt/rend/edge.compose.yml.
  --cache-dir DIR             Host cache dir. Defaults to REND_EDGE_CACHE_VOLUME or env REND_EDGE_CACHE_DIR.
  --spool-dir DIR             Host telemetry spool dir. Defaults to REND_EDGE_TELEMETRY_SPOOL_VOLUME or env REND_EDGE_TELEMETRY_SPOOL_DIR.
  --publish-addr ADDR         Host publish address to probe. Default: 127.0.0.1.
  --publish-port PORT         Host publish port to probe. Default: 4100.
  --expected-platform PLATFORM
                              Expected host image platform. Default: linux/amd64.
  --dry-run                   Skip mutating/network and host write probes; validate local inputs only.
  --skip-connectivity         Skip object-store, control-plane, and telemetry probes.
  --skip-bind-port-check      Skip bind-port probe.
  --skip-dir-check            Skip uid/gid 10001 cache/spool writeability checks.
  --allow-dev-defaults        Permit local Docker/dev defaults.
  --allow-placeholders        Permit placeholder example values.
  --allow-local-image-refs    Permit manifest image_tag fallback when image_digest is absent.
  --allow-direct-edge-exposure
                              Permit a public or wildcard direct :4100 bind for short production debugging.
  -h, --help                  Show this help.

Local example dry-run:
  scripts/preflight-edge-host.sh --dry-run --allow-dev-defaults \
    --allow-local-image-refs --manifest .rend/releases/production-001.json \
    --edge-env .env.docker.example --compose-file docs/templates/edge-host.compose.yml
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      manifest="${2:?missing value for $1}"
      shift 2
      ;;
    --edge-env)
      edge_env="${2:?missing value for $1}"
      shift 2
      ;;
    --compose-file)
      compose_file="${2:?missing value for $1}"
      shift 2
      ;;
    --cache-dir)
      cache_dir="${2:?missing value for $1}"
      shift 2
      ;;
    --spool-dir)
      spool_dir="${2:?missing value for $1}"
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
    --skip-dir-check)
      skip_dir_check=true
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
    --allow-direct-edge-exposure)
      allow_direct_edge_exposure=true
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

operator_info "validating edge env file"
operator_validate_edge_env "$edge_env" "$allow_dev_defaults" "$allow_placeholders"

operator_info "validating release manifest image ref"
operator_validate_manifest_services "$manifest" "$allow_local_image_refs" "$expected_platform" rend-edge
operator_check_edge_publish_addr_policy "$publish_addr" "$allow_direct_edge_exposure"

if [[ "$dry_run" == "true" ]]; then
  operator_warn "skipping manifest image pull readiness check"
else
  operator_info "checking manifest image pull readiness"
  operator_check_manifest_image_pulls "$manifest" "$allow_local_image_refs" "$expected_platform" rend-edge
fi

cache_dir="${cache_dir:-$(operator_env_value "$edge_env" REND_EDGE_CACHE_DIR 2>/dev/null || true)}"
spool_dir="${spool_dir:-$(operator_env_value "$edge_env" REND_EDGE_TELEMETRY_SPOOL_DIR 2>/dev/null || true)}"

if [[ "$dry_run" == "true" || "$skip_dir_check" == "true" ]]; then
  operator_warn "skipping uid/gid 10001 cache/spool directory checks"
else
  operator_check_uid_gid_writable_dir "$cache_dir" 10001 10001
  operator_check_uid_gid_writable_dir "$spool_dir" 10001 10001
fi

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

probe_object_store() {
  local health_url="$1"
  if curl -fsS --max-time 10 "$health_url" >/dev/null; then
    operator_ok "object-store origin health probe passed"
  else
    operator_fail "object-store origin health probe failed"
  fi
}

json_edge_registration_payload() {
  python3 - "$@" <<'PY'
import json
import sys

edge_id, region, base_url, cache_max_bytes = sys.argv[1:5]
payload = {
    "edge_id": edge_id,
    "region": region,
    "base_url": base_url,
    "status": "registered",
    "cache_max_bytes": int(cache_max_bytes) if cache_max_bytes else None,
}
print(json.dumps(payload, separators=(",", ":")))
PY
}

json_edge_heartbeat_payload() {
  python3 - "$@" <<'PY'
import json
import sys

edge_id, cache_max_bytes = sys.argv[1:3]
payload = {
    "edge_id": edge_id,
    "status": "registered",
    "cache_max_bytes": int(cache_max_bytes) if cache_max_bytes else None,
}
print(json.dumps(payload, separators=(",", ":")))
PY
}

probe_control_plane() {
  local control_plane_url="$1"
  local token="$2"
  local edge_id="$3"
  local region="$4"
  local base_url="$5"
  local cache_max_bytes="$6"
  local body_file http_code payload

  control_plane_url="${control_plane_url%/}"
  body_file="$(mktemp)"
  payload="$(json_edge_registration_payload "$edge_id" "$region" "$base_url" "$cache_max_bytes")"
  http_code="$(
    curl -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
      -X POST "$control_plane_url/internal/edges/register" \
      -H "x-rend-internal-token: $token" \
      -H "content-type: application/json" \
      --data "$payload"
  )"
  if [[ "$http_code" != 2* ]]; then
    operator_fail "control-plane edge register probe failed with HTTP $http_code: $(cat "$body_file")"
    rm -f "$body_file"
    return 0
  fi
  operator_ok "control-plane edge register probe passed"

  payload="$(json_edge_heartbeat_payload "$edge_id" "$cache_max_bytes")"
  http_code="$(
    curl -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
      -X POST "$control_plane_url/internal/edges/heartbeat" \
      -H "x-rend-internal-token: $token" \
      -H "content-type: application/json" \
      --data "$payload"
  )"
  if [[ "$http_code" != 2* ]]; then
    operator_fail "control-plane edge heartbeat probe failed with HTTP $http_code: $(cat "$body_file")"
  else
    operator_ok "control-plane edge heartbeat probe passed"
  fi
  rm -f "$body_file"
}

probe_telemetry_ingest() {
  local ingest_url="$1"
  local token="$2"
  local body_file http_code
  body_file="$(mktemp)"
  http_code="$(
    curl -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
      -X POST "$ingest_url" \
      -H "x-rend-internal-token: $token" \
      -H "content-type: application/json" \
      --data '{"events":[]}'
  )"
  case "$http_code" in
    400)
      operator_ok "telemetry ingest endpoint is reachable and authenticated"
      ;;
    401 | 403)
      operator_fail "telemetry ingest rejected the configured token with HTTP $http_code"
      ;;
    *)
      operator_fail "telemetry ingest reachability probe expected HTTP 400 validation response, got $http_code: $(cat "$body_file")"
      ;;
  esac
  rm -f "$body_file"
}

if [[ "$dry_run" == "true" || "$skip_connectivity" == "true" ]]; then
  operator_warn "skipping object-store, control-plane, and telemetry connectivity probes"
else
  edge_id="$(operator_env_value "$edge_env" REND_EDGE_ID)"
  region="$(operator_env_value "$edge_env" REND_EDGE_REGION)"
  base_url="$(operator_env_value "$edge_env" REND_EDGE_BASE_URL)"
  token="$(operator_env_value "$edge_env" REND_EDGE_INTERNAL_TOKEN)"
  telemetry_token="$(operator_env_value "$edge_env" REND_INTERNAL_TELEMETRY_TOKEN)"
  cache_max_bytes="$(operator_env_value "$edge_env" REND_EDGE_CACHE_MAX_BYTES 2>/dev/null || true)"
  probe_object_store "$(operator_env_value "$edge_env" REND_EDGE_ORIGIN_HEALTH_URL)"
  probe_control_plane \
    "$(operator_env_value "$edge_env" REND_CONTROL_PLANE_URL)" \
    "$token" "$edge_id" "$region" "$base_url" "$cache_max_bytes"
  probe_telemetry_ingest \
    "$(operator_env_value "$edge_env" REND_EDGE_TELEMETRY_INGEST_URL)" \
    "$telemetry_token"
fi

operator_finish
echo "Edge host preflight passed"
