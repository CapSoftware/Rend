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

docker compose up -d
docker compose --profile two-edge up -d rend-edge-us-east rend-edge-london
wait_for_default_stack
wait_for_http "rend-edge-us-east" "$edge_us_east_base/readyz"
wait_for_http "rend-edge-london" "$edge_london_base/readyz"
ensure_fixture "$fixture_path"

upload_response="$tmp_dir/upload.json"
asset_id="$(upload_fixture "$fixture_path" "$upload_response")"
poll_asset_until_hls_ready "$asset_id" "$tmp_dir/asset.json"

bootstrap_response="$tmp_dir/bootstrap.json"
fetch_playback_bootstrap "$asset_id" "$bootstrap_response"
playback_url="$(playback_url_from_bootstrap "$bootstrap_response")"
token="$(playback_token_from_url "$playback_url")"

us_east_url="$edge_us_east_base/v/$asset_id/hls/master.m3u8?token=$token"
london_url="$edge_london_base/v/$asset_id/hls/master.m3u8?token=$token"

purge_edge_artifacts "$edge_us_east_base" "$asset_id" "hls/master.m3u8"
purge_edge_artifacts "$edge_london_base" "$asset_id" "hls/master.m3u8"
warm_edge_artifacts "$edge_us_east_base" "$asset_id" "hls/master.m3u8"
warm_edge_artifacts "$edge_london_base" "$asset_id" "hls/master.m3u8"

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

echo "Docker two-edge smoke passed for asset $asset_id"
