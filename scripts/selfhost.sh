#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

env_file="${REND_SELFHOST_ENV_FILE:-.env.docker}"
compose=(docker compose --env-file "$env_file" -f compose.yml -f compose.selfhost.yml)

usage() {
  cat <<'EOF'
Usage: scripts/selfhost.sh COMMAND

Commands:
  init     Create a private self-host environment with generated secrets.
  up       Build and start the complete Rend self-host stack.
  down     Stop the stack without deleting persistent data.
  logs     Follow service logs.
  status   Show container state.
  config   Render and validate the merged Compose configuration.
  doctor   Check local prerequisites and configuration.

Set REND_SELFHOST_ENV_FILE to use an env file other than .env.docker.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: $1 is required" >&2
    exit 1
  }
}

prepare_env() {
  if [[ ! -f "$env_file" ]]; then
    init_env
  fi
}

random_hex() {
  openssl rand -hex "${1:-32}"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local temporary="${env_file}.tmp"
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    index($0, key "=") == 1 { print key "=" value; updated = 1; next }
    { print }
    END { if (!updated) print key "=" value }
  ' "$env_file" >"$temporary"
  mv "$temporary" "$env_file"
}

init_env() {
  require_command openssl
  if [[ -e "$env_file" ]]; then
    echo "$env_file already exists; refusing to replace its secrets."
    return 0
  fi
  umask 077
  cp .env.docker.example "$env_file"
  local postgres_password clickhouse_password minio_access_key minio_secret_key
  postgres_password="local_$(random_hex 24)"
  clickhouse_password="local_$(random_hex 24)"
  minio_access_key="rend_$(random_hex 8)"
  minio_secret_key="local_$(random_hex 32)"
  set_env_value POSTGRES_PASSWORD "$postgres_password"
  set_env_value DATABASE_URL "postgres://rend:${postgres_password}@postgres:5432/rend"
  set_env_value CLICKHOUSE_PASSWORD "$clickhouse_password"
  set_env_value AWS_ACCESS_KEY_ID "$minio_access_key"
  set_env_value AWS_SECRET_ACCESS_KEY "$minio_secret_key"
  set_env_value REND_DEV_API_KEY "rend_test_$(random_hex 24)"
  set_env_value REND_SITE_INTERNAL_TOKEN "local_$(random_hex 32)"
  set_env_value REND_EDGE_INTERNAL_TOKEN "local_$(random_hex 32)"
  set_env_value REND_INTERNAL_TELEMETRY_TOKEN "local_$(random_hex 32)"
  set_env_value REND_PLAYBACK_SIGNING_KEY_ID "selfhost-$(random_hex 8)"
  set_env_value REND_PLAYBACK_SIGNING_SECRET "local_$(random_hex 48)"
  set_env_value BETTER_AUTH_SECRET "local_$(random_hex 48)"
  chmod 600 "$env_file"
  echo "Created private self-host configuration at $env_file"
}

doctor() {
  require_command docker
  docker compose version >/dev/null
  prepare_env
  "${compose[@]}" config --quiet
  echo "Rend self-host prerequisites and Compose configuration are valid."
}

command_name="${1:-}"
case "$command_name" in
  init)
    init_env
    ;;
  up)
    doctor
    if "${compose[@]}" config --images | grep -q ':local$'; then
      "${compose[@]}" up -d --build --wait
    else
      "${compose[@]}" pull
      "${compose[@]}" up -d --no-build --wait
    fi
    echo "Rend is ready at http://localhost:${REND_SELFHOST_PORT:-8080}"
    echo "Direct uploads are ready at http://uploads.localhost:${REND_SELFHOST_PORT:-8080}"
    echo "Loopback troubleshooting ports: site ${REND_SELFHOST_SITE_PORT:-3000}, API 4000, playback 4100"
    ;;
  down)
    prepare_env
    "${compose[@]}" down
    ;;
  logs)
    prepare_env
    "${compose[@]}" logs -f "${@:2}"
    ;;
  status)
    prepare_env
    "${compose[@]}" ps
    ;;
  config)
    prepare_env
    "${compose[@]}" config
    ;;
  doctor)
    doctor
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
