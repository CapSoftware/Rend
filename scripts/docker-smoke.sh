#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

source "$root_dir/scripts/docker-smoke-common.sh"

api_base="${REND_API_BASE_URL:-http://127.0.0.1:4000}"
edge_base="${REND_EDGE_BASE_URL:-http://127.0.0.1:4100}"
api_base="${api_base%/}"
edge_base="${edge_base%/}"
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

require_command curl
require_command docker
require_command python3

docker compose up -d
wait_for_default_stack
ensure_fixture "$fixture_path"

upload_response="$tmp_dir/upload.json"
asset_id="$(upload_fixture "$fixture_path" "$upload_response")"
poll_asset_until_hls_ready "$asset_id" "$tmp_dir/asset.json"
wait_for_asset_event "$asset_id" "edge.warming_succeeded"

bootstrap_response="$tmp_dir/bootstrap.json"
fetch_playback_bootstrap "$asset_id" "$bootstrap_response"
playback_url="$(playback_url_from_bootstrap "$bootstrap_response")"
opener_url="$(opener_url_from_bootstrap "$bootstrap_response")"
expected_url="$edge_base/v/$asset_id/hls/master.m3u8"
if [[ "$playback_url" != "$expected_url" ]]; then
  echo "expected bootstrap playback_url to be $expected_url" >&2
  echo "got $playback_url" >&2
  exit 1
fi

purge_edge_artifacts "$edge_base" "$asset_id" "hls/master.m3u8"
fetch_and_expect_cache "manifest-miss" "$playback_url" "MISS" "$tmp_dir/manifest-miss.body"
fetch_and_expect_cache "manifest-hit" "$playback_url" "HIT" "$tmp_dir/manifest-hit.body"

if [[ -n "$opener_url" ]]; then
  purge_edge_artifacts "$edge_base" "$asset_id" "hls/master.m3u8" "opener.mp4"
  warm_edge_artifacts "$edge_base" "$asset_id" "hls/master.m3u8" "opener.mp4"
else
  purge_edge_artifacts "$edge_base" "$asset_id" "hls/master.m3u8"
  warm_edge_artifacts "$edge_base" "$asset_id" "hls/master.m3u8"
fi
fetch_and_expect_cache "manifest-warmed-hit" "$playback_url" "HIT" "$tmp_dir/manifest-warmed-hit.body"

wait_for_playback_analytics "$asset_id" 1 2

echo "Docker smoke passed for asset $asset_id"
