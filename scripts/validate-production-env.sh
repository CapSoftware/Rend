#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root_dir/scripts/operator-common.sh"

role=""
api_env=""
worker_env=""
edge_env=""
allow_dev_defaults=false
allow_placeholders=false

usage() {
  cat <<'EOF'
Usage: scripts/validate-production-env.sh [options]

Validate Rend production env files before deploy.

Options:
  --role ROLE              api, worker, edge, control-plane, edge-host, or all.
  --api-env FILE           API env file. Defaults to /etc/rend/rend-api.env for control-plane/all.
  --worker-env FILE        Worker env file. Defaults to /etc/rend/rend-media-worker.env for control-plane/all.
  --edge-env FILE          Edge env file. Defaults to /etc/rend/rend-edge.env for edge-host/all.
  --allow-dev-defaults     Permit local Docker/dev defaults. Intended only for local dry-runs.
  --allow-placeholders     Permit placeholder example values. Intended only for template checks.
  -h, --help               Show this help.

Examples:
  scripts/validate-production-env.sh --role control-plane
  scripts/validate-production-env.sh --role edge-host --edge-env /etc/rend/rend-edge.env
  scripts/validate-production-env.sh --role all --allow-dev-defaults --api-env .env.docker.example --worker-env .env.docker.example --edge-env .env.docker.example
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      role="${2:?missing value for $1}"
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
    --edge-env)
      edge_env="${2:?missing value for $1}"
      shift 2
      ;;
    --allow-dev-defaults)
      allow_dev_defaults=true
      shift
      ;;
    --allow-placeholders)
      allow_placeholders=true
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

if [[ -z "$role" ]]; then
  if [[ -n "$api_env$worker_env$edge_env" ]]; then
    role="custom"
  else
    usage >&2
    exit 2
  fi
fi

case "$role" in
  api)
    api_env="${api_env:-/etc/rend/rend-api.env}"
    ;;
  worker)
    worker_env="${worker_env:-/etc/rend/rend-media-worker.env}"
    ;;
  edge | edge-host)
    edge_env="${edge_env:-/etc/rend/rend-edge.env}"
    ;;
  control-plane)
    api_env="${api_env:-/etc/rend/rend-api.env}"
    worker_env="${worker_env:-/etc/rend/rend-media-worker.env}"
    ;;
  all)
    api_env="${api_env:-/etc/rend/rend-api.env}"
    worker_env="${worker_env:-/etc/rend/rend-media-worker.env}"
    edge_env="${edge_env:-/etc/rend/rend-edge.env}"
    ;;
  custom)
    ;;
  *)
    echo "error: unsupported role: $role" >&2
    usage >&2
    exit 2
    ;;
esac

operator_require_command python3

if [[ -n "$api_env" ]]; then
  operator_info "validating API env: $api_env"
  operator_validate_api_env "$api_env" "$allow_dev_defaults" "$allow_placeholders"
fi
if [[ -n "$worker_env" ]]; then
  operator_info "validating worker env: $worker_env"
  operator_validate_worker_env "$worker_env" "$allow_dev_defaults" "$allow_placeholders"
fi
if [[ -n "$edge_env" ]]; then
  operator_info "validating edge env: $edge_env"
  operator_validate_edge_env "$edge_env" "$allow_dev_defaults" "$allow_placeholders"
fi

operator_finish
echo "Production env validation passed"
