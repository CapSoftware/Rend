#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

manifest="${REND_RELEASE_MANIFEST:-}"
compose_file="${REND_CONTROL_PLANE_COMPOSE_FILE:-/opt/rend/control-plane.compose.yml}"
expected_platform="${REND_EXPECTED_IMAGE_PLATFORM:-linux/amd64}"
dry_run=false
allow_local_image_refs=false

usage() {
  cat <<'EOF'
Usage: scripts/deploy-control-plane-host.sh --manifest FILE [options]

Deploy control-plane services with immutable image refs from a release manifest.

Options:
  --manifest FILE             Release manifest with image_digest refs.
  --compose-file FILE         Compose file. Default: /opt/rend/control-plane.compose.yml.
  --expected-platform PLATFORM
                              Expected host image platform. Default: linux/amd64.
  --dry-run                   Print exact docker compose commands without running them.
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
    --expected-platform)
      expected_platform="${2:?missing value for $1}"
      shift 2
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

[[ -n "$manifest" ]] || {
  usage >&2
  exit 2
}

operator_require_command python3
operator_require_file "$compose_file"
operator_validate_manifest_services "$manifest" "$allow_local_image_refs" "$expected_platform" rend-api rend-media-worker
operator_finish

api_image="$(operator_manifest_image_ref "$manifest" rend-api "$allow_local_image_refs")"
worker_image="$(operator_manifest_image_ref "$manifest" rend-media-worker "$allow_local_image_refs")"

if [[ "$dry_run" != "true" ]]; then
  operator_check_docker_compose
  operator_require_command curl
  operator_info "checking manifest image pull readiness and platform"
  operator_check_manifest_image_pulls "$manifest" "$allow_local_image_refs" "$expected_platform" rend-api rend-media-worker
  operator_finish
fi

operator_run_or_dry_run "$dry_run" \
  env "REND_API_IMAGE=$api_image" "REND_MEDIA_WORKER_IMAGE=$worker_image" \
  docker compose -f "$compose_file" pull

operator_run_or_dry_run "$dry_run" \
  env "REND_API_IMAGE=$api_image" "REND_MEDIA_WORKER_IMAGE=$worker_image" \
  docker compose -f "$compose_file" up -d --no-deps rend-api

if [[ "$dry_run" != "true" ]]; then
  curl -fsS --retry 12 --retry-delay 5 --retry-all-errors http://127.0.0.1:4000/readyz >/dev/null
  echo "rend-api is ready"
fi

operator_run_or_dry_run "$dry_run" \
  env "REND_API_IMAGE=$api_image" "REND_MEDIA_WORKER_IMAGE=$worker_image" \
  docker compose -f "$compose_file" up -d --no-deps rend-media-worker

if [[ "$dry_run" == "true" ]]; then
  echo "Dry run complete; no control-plane deploy commands were executed"
else
  echo "Control-plane deploy commands completed"
fi
