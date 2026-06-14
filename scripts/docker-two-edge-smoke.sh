#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

source "$root_dir/scripts/docker-smoke-common.sh"

api_base="${REND_API_BASE_URL:-http://127.0.0.1:4000}"
edge_base="${REND_EDGE_BASE_URL:-http://127.0.0.1:4100}"
edge_us_east_base="${REND_EDGE_US_EAST_BASE_URL:-http://127.0.0.1:4101}"
edge_london_base="${REND_EDGE_LONDON_BASE_URL:-http://127.0.0.1:4102}"
api_base="${api_base%/}"
edge_base="${edge_base%/}"
edge_us_east_base="${edge_us_east_base%/}"
edge_london_base="${edge_london_base%/}"
dev_api_key="${REND_DEV_API_KEY:-dev-api-key}"
edge_internal_token="${REND_EDGE_INTERNAL_TOKEN:-dev-internal-token}"
clickhouse_user="${CLICKHOUSE_USER:-rend}"
clickhouse_password="${CLICKHOUSE_PASSWORD:-rend}"
minio_health_url="${OBJECT_STORE_HEALTH_URL:-http://127.0.0.1:9100/minio/health/ready}"
fixture_path="${REND_SMOKE_FIXTURE:-$root_dir/.rend/docker-smoke-fixture.mp4}"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

require_command cmp
require_command curl
require_command docker
require_command python3

wait_for_two_edge_registration() {
  local response
  for _ in $(seq 1 90); do
    response="$(
      docker compose exec -T postgres psql -U rend -d rend -Atc "
        SELECT edge_id
        FROM rend.edge_nodes
        WHERE edge_id IN ('rend-edge-us-east', 'rend-edge-london')
          AND status = 'healthy'
          AND last_heartbeat_at >= now() - interval '30 seconds'
        ORDER BY edge_id
      " 2>/dev/null || true
    )"
    if grep -qx "rend-edge-us-east" <<<"$response" &&
      grep -qx "rend-edge-london" <<<"$response"; then
      return 0
    fi
    sleep 1
  done

  echo "timed out waiting for both two-edge nodes to register healthy" >&2
  docker compose exec -T postgres psql -U rend -d rend -c \
    "SELECT edge_id, region, base_url, status, last_heartbeat_at FROM rend.edge_nodes ORDER BY edge_id" >&2 || true
  exit 1
}

wait_for_edge_fanout_event() {
  local asset_id="$1"
  local event_type="$2"
  local response_file="$tmp_dir/fanout-${event_type}.json"

  for _ in $(seq 1 120); do
    local status_code
    status_code="$(
      curl -sS -o "$response_file" -w "%{http_code}" \
        "$api_base/v1/assets/$asset_id/events?limit=100" \
        -H "authorization: Bearer $dev_api_key"
    )"
    if [[ "$status_code" == "200" ]] &&
      python3 - "$response_file" "$event_type" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    response = json.load(f)
wanted = sys.argv[2]
required = {"rend-edge-us-east", "rend-edge-london"}
for event in reversed(response.get("events", [])):
    if event.get("event_type") != wanted:
        continue
    edges = event.get("metadata", {}).get("edges", [])
    succeeded = {
        edge.get("edge_id")
        for edge in edges
        if edge.get("edge_id") in required and edge.get("status") == "succeeded"
    }
    if succeeded == required:
        raise SystemExit(0)
raise SystemExit(1)
PY
    then
      return 0
    fi
    sleep 1
  done

  echo "timed out waiting for $event_type fanout to both two-edge nodes for $asset_id" >&2
  cat "$response_file" >&2 || true
  exit 1
}

delete_asset_via_api() {
  local asset_id="$1"
  local response_file="$tmp_dir/delete.json"
  local status_code
  status_code="$(
    curl -sS -o "$response_file" -w "%{http_code}" \
      -X DELETE "$api_base/v1/assets/$asset_id" \
      -H "authorization: Bearer $dev_api_key"
  )"
  if [[ "$status_code" != "200" ]]; then
    echo "delete failed with HTTP $status_code" >&2
    cat "$response_file" >&2 || true
    exit 1
  fi
}

docker compose up -d
docker compose --profile two-edge up -d rend-edge-us-east rend-edge-london
wait_for_default_stack
wait_for_http "rend-edge-us-east" "$edge_us_east_base/readyz"
wait_for_http "rend-edge-london" "$edge_london_base/readyz"
wait_for_two_edge_registration
ensure_fixture "$fixture_path"

upload_response="$tmp_dir/upload.json"
asset_id="$(upload_fixture "$fixture_path" "$upload_response")"
poll_asset_until_hls_ready "$asset_id" "$tmp_dir/asset.json"
wait_for_edge_fanout_event "$asset_id" "edge.warming_succeeded"

bootstrap_response="$tmp_dir/bootstrap.json"
fetch_playback_bootstrap "$asset_id" "$bootstrap_response"

us_east_url="$edge_us_east_base/v/$asset_id/hls/master.m3u8"
london_url="$edge_london_base/v/$asset_id/hls/master.m3u8"

fetch_and_expect_cache "us-east-warmed-hit" "$us_east_url" "HIT" "$tmp_dir/us-east.body"
fetch_and_expect_cache "london-warmed-hit" "$london_url" "HIT" "$tmp_dir/london.body"

if ! cmp -s "$tmp_dir/us-east.body" "$tmp_dir/london.body"; then
  echo "us-east and london edge responses differed for the same asset" >&2
  exit 1
fi

docker compose --profile two-edge exec -T rend-edge-us-east \
  test -s "/var/lib/rend/edge-cache/videos/$asset_id/hls/master.m3u8"
docker compose --profile two-edge exec -T rend-edge-london \
  test -s "/var/lib/rend/edge-cache/videos/$asset_id/hls/master.m3u8"

delete_asset_via_api "$asset_id"
wait_for_edge_fanout_event "$asset_id" "edge.purge_succeeded"

docker compose --profile two-edge exec -T rend-edge-us-east \
  test ! -e "/var/lib/rend/edge-cache/videos/$asset_id/hls/master.m3u8"
docker compose --profile two-edge exec -T rend-edge-london \
  test ! -e "/var/lib/rend/edge-cache/videos/$asset_id/hls/master.m3u8"

echo "Docker two-edge smoke passed for asset $asset_id"
