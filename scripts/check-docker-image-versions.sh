#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

services=(rend-api rend-media-worker rend-edge)
image_prefix="${REND_IMAGE_PREFIX:-}"
image_tag="${REND_IMAGE_TAG:-local}"
check_running=false
strict=false

usage() {
  cat <<'EOF'
Usage: scripts/check-docker-image-versions.sh [options]

Check that local Rend API, worker, and edge Docker images carry matching
release metadata.

Options:
  --tag TAG          Image tag to inspect. Defaults to local.
  --prefix PREFIX    Optional image repository prefix, for example ghcr.io/acme.
  --registry PREFIX  Alias for --prefix.
  --running          Check images used by currently running containers.
  --strict           Fail if release labels are missing or set to unknown.
  -h, --help         Show this help.

Environment aliases:
  REND_IMAGE_TAG, REND_IMAGE_PREFIX
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      image_tag="${2:?missing value for $1}"
      shift 2
      ;;
    --prefix | --image-prefix | --registry)
      image_prefix="${2:?missing value for $1}"
      shift 2
      ;;
    --running)
      check_running=true
      shift
      ;;
    --strict)
      strict=true
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

command -v docker >/dev/null 2>&1 || {
  echo "error: docker is required" >&2
  exit 1
}

image_prefix="${image_prefix%/}"

canonical_repo() {
  local service="$1"
  if [[ -n "$image_prefix" ]]; then
    printf '%s/%s\n' "$image_prefix" "$service"
  else
    printf '%s\n' "$service"
  fi
}

image_label() {
  local image="$1"
  local label="$2"
  docker image inspect --format "{{ index .Config.Labels \"$label\" }}" "$image" 2>/dev/null || true
}

clean_label() {
  local value="$1"
  if [[ -z "$value" || "$value" == "<no value>" ]]; then
    printf '\n'
  else
    printf '%s\n' "$value"
  fi
}

running_image_for() {
  local service="$1"
  local container_id

  container_id="$(docker ps -q --filter "label=com.rend.service=$service" | head -n 1)"
  if [[ -z "$container_id" ]]; then
    container_id="$(docker ps -q --filter "label=com.docker.compose.service=$service" | head -n 1)"
  fi

  if [[ -z "$container_id" ]]; then
    return 1
  fi

  docker inspect --format '{{.Image}}' "$container_id"
}

failures=0
expected_version=""
expected_revision=""

printf '%-18s %-44s %-14s %-12s %-20s\n' "SERVICE" "IMAGE" "VERSION" "REVISION" "CREATED"

for service in "${services[@]}"; do
  if [[ "$check_running" == "true" ]]; then
    if ! image_ref="$(running_image_for "$service")"; then
      echo "error: no running container found for $service" >&2
      failures=1
      continue
    fi
  else
    image_ref="$(canonical_repo "$service"):$image_tag"
  fi

  if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
    echo "error: missing Docker image for $service: $image_ref" >&2
    failures=1
    continue
  fi

  version="$(clean_label "$(image_label "$image_ref" "org.opencontainers.image.version")")"
  revision="$(clean_label "$(image_label "$image_ref" "org.opencontainers.image.revision")")"
  created="$(clean_label "$(image_label "$image_ref" "org.opencontainers.image.created")")"
  source="$(clean_label "$(image_label "$image_ref" "org.opencontainers.image.source")")"
  label_service="$(clean_label "$(image_label "$image_ref" "com.rend.service")")"

  printf '%-18s %-44s %-14s %-12s %-20s\n' \
    "$service" \
    "$image_ref" \
    "${version:-missing}" \
    "${revision:0:12}" \
    "${created:-missing}"

  if [[ "$label_service" != "$service" ]]; then
    echo "error: $image_ref has com.rend.service=${label_service:-missing}, expected $service" >&2
    failures=1
  fi

  if [[ -z "$version" ]]; then
    echo "error: $image_ref is missing org.opencontainers.image.version" >&2
    failures=1
  fi
  if [[ -z "$revision" ]]; then
    echo "error: $image_ref is missing org.opencontainers.image.revision" >&2
    failures=1
  fi
  if [[ -z "$created" ]]; then
    echo "error: $image_ref is missing org.opencontainers.image.created" >&2
    failures=1
  fi

  if [[ "$strict" == "true" ]]; then
    if [[ -z "$source" || "$source" == "unknown" ]]; then
      echo "error: $image_ref has non-production source label: ${source:-missing}" >&2
      failures=1
    fi
    if [[ "$version" == "unknown" ]]; then
      echo "error: $image_ref has non-production version label: unknown" >&2
      failures=1
    fi
    if [[ "$revision" == "unknown" || ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
      echo "error: $image_ref has non-production revision label: ${revision:-missing}" >&2
      failures=1
    fi
    if [[ "$created" == "unknown" || ! "$created" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
      echo "error: $image_ref has non-production created label: ${created:-missing}" >&2
      failures=1
    fi
  fi

  if [[ -z "$expected_version" ]]; then
    expected_version="$version"
  elif [[ "$version" != "$expected_version" ]]; then
    echo "error: $service image version $version does not match $expected_version" >&2
    failures=1
  fi

  if [[ -z "$expected_revision" ]]; then
    expected_revision="$revision"
  elif [[ "$revision" != "$expected_revision" ]]; then
    echo "error: $service image revision $revision does not match $expected_revision" >&2
    failures=1
  fi
done

if [[ "$failures" != "0" ]]; then
  exit 1
fi

echo "Docker image versions match across API, worker, and edge."
