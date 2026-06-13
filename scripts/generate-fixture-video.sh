#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_path="${1:-"$root_dir/fixtures/media/rend-fixture.mp4"}"

command -v ffmpeg >/dev/null 2>&1 || {
  echo "ffmpeg is required to generate the fixture video" >&2
  exit 1
}

mkdir -p "$(dirname "$output_path")"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=640x360:rate=24:duration=8" \
  -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=8" \
  -shortest \
  -c:v libx264 \
  -preset veryfast \
  -pix_fmt yuv420p \
  -c:a aac \
  -b:a 96k \
  -movflags +faststart \
  "$output_path"

printf '%s\n' "$output_path"
