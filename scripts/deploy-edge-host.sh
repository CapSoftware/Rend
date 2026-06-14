#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

manifest="${REND_RELEASE_MANIFEST:-}"
compose_file="${REND_EDGE_COMPOSE_FILE:-/opt/rend/edge.compose.yml}"
expected_platform="${REND_EXPECTED_IMAGE_PLATFORM:-linux/amd64}"
dry_run=false
allow_local_image_refs=false

usage() {
  cat <<'EOF'
Usage: scripts/deploy-edge-host.sh --manifest FILE [options]

Deploy an edge host with the immutable image ref from a release manifest.

Options:
  --manifest FILE             Release manifest with rend-edge image_digest ref.
  --compose-file FILE         Compose file. Default: /opt/rend/edge.compose.yml.
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
operator_validate_manifest_services "$manifest" "$allow_local_image_refs" "$expected_platform" rend-edge
operator_finish

edge_image="$(operator_manifest_image_ref "$manifest" rend-edge "$allow_local_image_refs")"

if [[ "$dry_run" != "true" ]]; then
  operator_check_docker_compose
  operator_info "checking manifest image pull readiness and platform"
  operator_check_manifest_image_pulls "$manifest" "$allow_local_image_refs" "$expected_platform" rend-edge
  operator_finish
fi

operator_run_or_dry_run "$dry_run" \
  env "REND_EDGE_IMAGE=$edge_image" \
  docker compose -f "$compose_file" pull rend-edge

operator_run_or_dry_run "$dry_run" \
  env "REND_EDGE_IMAGE=$edge_image" \
  docker compose -f "$compose_file" up -d --no-deps rend-edge

if [[ "$dry_run" == "true" ]]; then
  echo "Dry run complete; no edge deploy commands were executed"
else
  echo "Edge deploy commands completed"
fi
