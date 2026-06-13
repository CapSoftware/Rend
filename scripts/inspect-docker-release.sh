#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

services=(rend-api rend-media-worker rend-edge)
all_containers=false

usage() {
  cat <<'EOF'
Usage: scripts/inspect-docker-release.sh [options] [service...]

Inspect running Rend Docker containers and print image tag, digest, and
release/version metadata.

Options:
  --all       Inspect every running container with a com.rend.service label.
  -h, --help  Show this help.

With no service arguments, the command looks for rend-api, rend-media-worker,
and rend-edge containers.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      all_containers=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      services=("$@")
      break
      ;;
  esac
done

command -v docker >/dev/null 2>&1 || {
  echo "error: docker is required" >&2
  exit 1
}

clean_value() {
  local value="$1"
  if [[ -z "$value" || "$value" == "<no value>" ]]; then
    printf '%s\n' "-"
  else
    printf '%s\n' "$value"
  fi
}

container_label() {
  local container="$1"
  local label="$2"
  docker inspect --format "{{ index .Config.Labels \"$label\" }}" "$container" 2>/dev/null || true
}

image_label() {
  local image="$1"
  local label="$2"
  docker image inspect --format "{{ index .Config.Labels \"$label\" }}" "$image" 2>/dev/null || true
}

first_repo_digest() {
  local image="$1"
  docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$image" 2>/dev/null || true
}

ids_file="$(mktemp)"
cleanup() {
  rm -f "$ids_file"
}
trap cleanup EXIT

if [[ "$all_containers" == "true" ]]; then
  docker ps -q --filter "label=com.rend.service" >>"$ids_file"
else
  for service in "${services[@]}"; do
    docker ps -q --filter "label=com.rend.service=$service" >>"$ids_file"
    docker ps -q --filter "label=com.docker.compose.service=$service" >>"$ids_file"
  done
fi

container_ids="$(sort -u "$ids_file" | sed '/^$/d')"
if [[ -z "$container_ids" ]]; then
  echo "No running Rend containers found."
  exit 0
fi

printf '%-18s %-24s %-18s %-44s %-18s %-12s %-12s %-20s\n' \
  "SERVICE" "COMPOSE_SERVICE" "CONTAINER" "IMAGE" "DIGEST" "VERSION" "REVISION" "CREATED"

while IFS= read -r container_id; do
  image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
  image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  container_name="$(docker inspect --format '{{.Name}}' "$container_id" | sed 's#^/##')"
  service="$(clean_value "$(container_label "$container_id" "com.rend.service")")"
  compose_service="$(clean_value "$(container_label "$container_id" "com.docker.compose.service")")"
  version="$(clean_value "$(image_label "$image_id" "org.opencontainers.image.version")")"
  revision="$(clean_value "$(image_label "$image_id" "org.opencontainers.image.revision")")"
  created="$(clean_value "$(image_label "$image_id" "org.opencontainers.image.created")")"
  repo_digest="$(first_repo_digest "$image_id")"

  digest="$image_id"
  if [[ "$image_ref" == *@sha256:* ]]; then
    digest="${image_ref#*@}"
  elif [[ -n "$repo_digest" ]]; then
    digest="${repo_digest#*@}"
  fi

  printf '%-18s %-24s %-18s %-44s %-18s %-12s %-12s %-20s\n' \
    "$service" \
    "$compose_service" \
    "$container_name" \
    "$image_ref" \
    "$digest" \
    "$version" \
    "${revision:0:12}" \
    "$created"
done <<<"$container_ids"
