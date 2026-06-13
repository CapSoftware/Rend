#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

services=(rend-api rend-media-worker rend-edge)

release_tag="${REND_RELEASE_TAG:-}"
image_prefix="${REND_IMAGE_PREFIX:-}"
manifest_path="${REND_RELEASE_MANIFEST:-}"
source_label="${REND_IMAGE_SOURCE:-}"
image_version="${REND_IMAGE_VERSION:-}"
push_images="${REND_RELEASE_PUSH:-false}"
allow_dirty="${REND_RELEASE_ALLOW_DIRTY:-false}"

usage() {
  cat <<'EOF'
Usage: scripts/release-images.sh [options]

Build all first-trial container targets and write a release manifest.

Options:
  --tag TAG              Optional human release tag, for example trial-001.
  --prefix PREFIX        Optional image repository prefix, for example ghcr.io/acme.
  --registry PREFIX      Alias for --prefix.
  --manifest PATH        Release manifest path. Defaults under .rend/releases/.
  --source URL           OCI source label. Defaults to the git origin URL.
  --version VERSION      OCI image version label. Defaults to --tag or package version.
  --push                 Push all generated tags after local build.
  --no-push              Build locally only, even if REND_RELEASE_PUSH=true.
  --allow-dirty          Permit building from uncommitted changes. For local dry runs only.
  -h, --help             Show this help.

Environment aliases:
  REND_RELEASE_TAG, REND_IMAGE_PREFIX, REND_RELEASE_MANIFEST,
  REND_IMAGE_SOURCE, REND_IMAGE_VERSION, REND_RELEASE_PUSH,
  REND_RELEASE_ALLOW_DIRTY
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: $1 is required" >&2
    exit 1
  }
}

package_version() {
  awk '
    /^\[workspace.package\]/ { in_workspace_package = 1; next }
    /^\[/ { in_workspace_package = 0 }
    in_workspace_package && /^version[[:space:]]*=/ {
      gsub(/"/, "", $3)
      print $3
      exit
    }
  ' Cargo.toml
}

normalize_git_remote() {
  local remote="$1"
  local path

  case "$remote" in
    git@github.com:*)
      path="${remote#git@github.com:}"
      printf 'https://github.com/%s\n' "${path%.git}"
      ;;
    https://* | http://*)
      printf '%s\n' "${remote%.git}"
      ;;
    *)
      printf '%s\n' "$remote"
      ;;
  esac
}

is_truthy() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1 | true | yes | y) return 0 ;;
    *) return 1 ;;
  esac
}

validate_tag() {
  local tag="$1"
  if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "error: invalid Docker tag: $tag" >&2
    exit 1
  fi
}

validate_non_unknown() {
  local label="$1"
  local value="$2"
  if [[ -z "$value" || "$value" == "unknown" ]]; then
    echo "error: $label must be set for release images" >&2
    exit 1
  fi
}

git_is_dirty() {
  [[ -n "$(git status --porcelain)" ]]
}

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

require_image_label() {
  local image="$1"
  local label="$2"
  local expected="$3"
  local actual

  actual="$(clean_label "$(image_label "$image" "$label")")"
  if [[ "$actual" != "$expected" ]]; then
    echo "error: $image label $label is ${actual:-missing}, expected $expected" >&2
    exit 1
  fi
}

validate_release_image_metadata() {
  local image="$1"
  local service="$2"

  require_image_label "$image" "com.rend.service" "$service"
  require_image_label "$image" "org.opencontainers.image.source" "$source_label"
  require_image_label "$image" "org.opencontainers.image.revision" "$git_sha"
  require_image_label "$image" "org.opencontainers.image.version" "$image_version"
  require_image_label "$image" "org.opencontainers.image.created" "$build_time"
}

repo_digest_for() {
  local repo="$1"
  local ref="$2"
  local digest

  while IFS= read -r digest; do
    if [[ "$digest" == "$repo@"* ]]; then
      printf '%s\n' "$digest"
      return 0
    fi
  done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" 2>/dev/null || true)

  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag | --release-tag)
      release_tag="${2:?missing value for $1}"
      shift 2
      ;;
    --prefix | --image-prefix | --registry)
      image_prefix="${2:?missing value for $1}"
      shift 2
      ;;
    --manifest)
      manifest_path="${2:?missing value for $1}"
      shift 2
      ;;
    --source)
      source_label="${2:?missing value for $1}"
      shift 2
      ;;
    --version)
      image_version="${2:?missing value for $1}"
      shift 2
      ;;
    --push)
      push_images=true
      shift
      ;;
    --no-push)
      push_images=false
      shift
      ;;
    --allow-dirty)
      allow_dirty=true
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

require_command docker
require_command git
require_command python3

image_prefix="${image_prefix%/}"
git_sha="$(git rev-parse --verify HEAD)"
short_sha="${git_sha:0:12}"
build_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
pkg_version="$(package_version)"

if [[ -z "$pkg_version" ]]; then
  echo "error: failed to read workspace package version from Cargo.toml" >&2
  exit 1
fi

validate_tag "$git_sha"
if [[ -n "$release_tag" ]]; then
  validate_tag "$release_tag"
fi

if [[ -z "$source_label" ]]; then
  source_label="$(normalize_git_remote "$(git config --get remote.origin.url || true)")"
fi
if [[ -z "$source_label" ]]; then
  source_label="unknown"
fi

if [[ -z "$image_version" ]]; then
  if [[ -n "$release_tag" ]]; then
    image_version="$release_tag"
  else
    image_version="$pkg_version"
  fi
fi

if [[ -z "$manifest_path" ]]; then
  if [[ -n "$release_tag" ]]; then
    manifest_path=".rend/releases/rend-images-$release_tag.json"
  else
    manifest_path=".rend/releases/rend-images-$short_sha.json"
  fi
fi

push_flag=false
if is_truthy "$push_images"; then
  push_flag=true
fi

dirty=false
if git_is_dirty; then
  dirty=true
fi

if [[ "$dirty" == "true" && "$push_flag" == "true" ]]; then
  echo "error: pushed release builds require a clean git worktree; commit changes before using --push" >&2
  git status --short >&2
  exit 1
fi

if [[ "$dirty" == "true" ]] && ! is_truthy "$allow_dirty"; then
  echo "error: git worktree is dirty; commit changes before a release build or pass --allow-dirty for a local dry run" >&2
  git status --short >&2
  exit 1
fi

validate_non_unknown "org.opencontainers.image.source" "$source_label"
validate_non_unknown "org.opencontainers.image.revision" "$git_sha"
validate_non_unknown "org.opencontainers.image.version" "$image_version"
validate_non_unknown "org.opencontainers.image.created" "$build_time"

if [[ "$push_flag" == "true" && -z "$image_prefix" ]]; then
  echo "error: --push requires --registry/--prefix so images are pushed to an explicit repository namespace" >&2
  exit 1
fi

records_file="$(mktemp)"
cleanup() {
  rm -f "$records_file"
}
trap cleanup EXIT

echo "Building Rend release images"
echo "  git sha: $git_sha"
echo "  image version: $image_version"
echo "  build time: $build_time"
echo "  source: $source_label"
echo "  push: $push_flag"
echo "  dirty: $dirty"

for service in "${services[@]}"; do
  repo="$(canonical_repo "$service")"
  sha_image="$repo:$git_sha"
  release_image=""
  tag_args=(-t "$sha_image")

  if [[ -n "$release_tag" ]]; then
    release_image="$repo:$release_tag"
    tag_args+=(-t "$release_image")
  fi

  echo "Building $service as $sha_image"
  docker build \
    --file Dockerfile \
    --target "$service" \
    --build-arg "REND_IMAGE_SOURCE=$source_label" \
    --build-arg "REND_GIT_SHA=$git_sha" \
    --build-arg "REND_IMAGE_VERSION=$image_version" \
    --build-arg "REND_BUILD_TIME=$build_time" \
    "${tag_args[@]}" \
    .

  validate_release_image_metadata "$sha_image" "$service"
  if [[ -n "$release_image" ]]; then
    validate_release_image_metadata "$release_image" "$service"
  fi

  if [[ "$push_flag" == "true" ]]; then
    docker push "$sha_image"
    if [[ -n "$release_image" ]]; then
      docker push "$release_image"
    fi
  fi

  image_id="$(docker image inspect --format '{{.Id}}' "$sha_image")"
  digest="$image_id"
  digest_kind="local-image-id"
  immutable_ref=""

  if [[ "$push_flag" == "true" ]]; then
    if repo_digest="$(repo_digest_for "$repo" "$sha_image")"; then
      digest="${repo_digest#*@}"
      digest_kind="registry-manifest"
      immutable_ref="$repo_digest"
    else
      echo "error: no pushed repo digest found for $sha_image; refusing to write a production manifest without immutable refs" >&2
      exit 1
    fi
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$service" \
    "$service" \
    "$repo" \
    "$sha_image" \
    "$release_image" \
    "$digest" \
    "$digest_kind" \
    "$immutable_ref" >>"$records_file"
done

python3 - "$manifest_path" "$source_label" "$git_sha" "$short_sha" "$image_version" "$pkg_version" "$build_time" "$push_flag" "$release_tag" "$dirty" "$records_file" <<'PY'
import json
import os
import sys

(
    manifest_path,
    source,
    git_sha,
    short_sha,
    image_version,
    package_version,
    build_time,
    push_flag,
    release_tag,
    dirty,
    records_file,
) = sys.argv[1:]

services = {}
canonical_images = {}

with open(records_file, "r", encoding="utf-8") as records:
    for line in records:
        (
            service,
            target,
            repository,
            image_tag,
            release_tag_image,
            digest,
            digest_kind,
            immutable_ref,
        ) = line.rstrip("\n").split("\t")
        tags = [image_tag]
        if release_tag_image:
            tags.append(release_tag_image)

        canonical_images[service] = repository
        services[service] = {
            "target": target,
            "repository": repository,
            "image_tag": image_tag,
            "release_tag_image": release_tag_image or None,
            "tags": tags,
            "digest": digest,
            "digest_kind": digest_kind,
            "image_digest": immutable_ref or None,
            "git_sha": git_sha,
            "build_time": build_time,
        }

manifest = {
    "schema_version": 1,
    "source": source,
    "git_sha": git_sha,
    "short_sha": short_sha,
    "release_tag": release_tag or None,
    "image_version": image_version,
    "package_version": package_version,
    "build_time": build_time,
    "pushed": push_flag == "true",
    "dirty": dirty == "true",
    "canonical_images": canonical_images,
    "services": services,
}

directory = os.path.dirname(manifest_path)
if directory:
    os.makedirs(directory, exist_ok=True)

with open(manifest_path, "w", encoding="utf-8") as manifest_file:
    json.dump(manifest, manifest_file, indent=2)
    manifest_file.write("\n")
PY

echo "Wrote release manifest: $manifest_path"
