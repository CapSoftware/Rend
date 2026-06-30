#!/usr/bin/env bash
set -euo pipefail

caddyfile="${REND_CADDYFILE:-/etc/caddy/Caddyfile}"
dry_run=false
skip_reload=false

usage() {
  cat <<'EOF'
Usage: scripts/sync-edge-caddy-playback-routes.sh [options]

Patch the edge Caddy public playback matcher so HLS ladder playlists, segments,
and fast embed pages reach rend-edge. The script edits only the signed playback
regexp plus the fast embed route, backs up the Caddyfile, validates the result,
and reloads Caddy. Hosts that do not keep a Caddy playback allowlist are left
unchanged.

Options:
  --caddyfile FILE  Caddyfile path. Default: /etc/caddy/Caddyfile.
  --dry-run         Print whether the file would change without writing.
  --skip-reload     Skip caddy fmt/validate and systemctl reload.
  -h, --help        Show this help.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --caddyfile)
      caddyfile="${2:?missing value for $1}"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --skip-reload)
      skip_reload=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -f "$caddyfile" ]] || die "missing Caddyfile: $caddyfile"
require_command python3

tmp="$(mktemp "${TMPDIR:-/tmp}/rend-edge-caddy.XXXXXX")"
cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

patch_status="$(
  python3 - "$caddyfile" "$tmp" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
renditions = r"(360p|480p|720p|1080p|2k|4k)"
segment = r"segment_[0-9]+\.(ts|m4s)"
init = r"init_(360p|480p|720p|1080p|2k|4k)\.mp4"
ladder = rf"hls/{renditions}/(index\.m3u8|{init}|{segment})"
strict_pattern = (
    r"^/v/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    r"[0-9a-f]{4}-[0-9a-f]{12}/"
    rf"(opener\.mp4|hls/master\.m3u8|hls/{segment}|"
    + ladder
    + r")$"
)
lines = source.read_text(encoding="utf-8").splitlines(keepends=True)
found = False
changed = False
output = []

for line in lines:
    stripped = line.rstrip("\n")
    newline = "\n" if line.endswith("\n") else ""
    leading = stripped[: len(stripped) - len(stripped.lstrip())]
    tokens = stripped.strip().split()
    if (
        "path_regexp" in line
        and "^/v/" in line
        and "hls/master\\.m3u8" in line
        and "hls/segment_" in line
    ):
        found = True
        if strict_pattern in stripped:
            output.append(line)
            continue
        if not tokens or not tokens[-1].startswith("^/v/"):
            raise SystemExit("signed playback regexp has an unsupported shape")
        output.append(f"{leading}{' '.join(tokens[:-1])} {strict_pattern}{newline}")
        changed = True
    elif (
        len(tokens) >= 2
        and "/v/" in line
        and "hls/master.m3u8" in line
        and "hls/segment_" in line
        and ("path" in {tokens[0], tokens[1]})
    ):
        found = True
        if tokens[0].startswith("@") and tokens[1] == "path":
            output.append(f"{leading}{tokens[0]} path_regexp canonical_playback {strict_pattern}{newline}")
        elif tokens[0] == "path":
            output.append(f"{leading}path_regexp canonical_playback {strict_pattern}{newline}")
        else:
            raise SystemExit("signed playback path matcher has an unsupported shape")
        changed = True
    else:
        output.append(line)

if not found:
    if ladder in "".join(lines) or "rend_hls_ladder_playback" in "".join(lines):
        target.write_text("".join(lines), encoding="utf-8")
        print("unchanged")
        raise SystemExit(0)

    inserted = False
    seen_public_playback = False
    output = []
    for line in lines:
        stripped = line.strip()
        if "/v/" in line and (
            "hls/master.m3u8" in line
            or "hls/master\\.m3u8" in line
            or "hls/*" in line
            or "hls/segment" in line
            or "opener.mp4" in line
            or "opener\\.mp4" in line
        ):
            seen_public_playback = True
        if seen_public_playback and (stripped == "handle {" or stripped.startswith("respond 404")):
            leading = line[: len(line) - len(line.lstrip())]
            inner = leading + "\t"
            output.extend(
                [
                    f"{leading}@rend_hls_ladder_playback {{\n",
                    f"{inner}path_regexp rend_hls_ladder_playback {strict_pattern}\n",
                    f"{leading}}}\n",
                    f"{leading}handle @rend_hls_ladder_playback {{\n",
                    f"{inner}reverse_proxy 127.0.0.1:4100\n",
                    f"{leading}}}\n",
                    "\n",
                ]
            )
            inserted = True
            seen_public_playback = False
        output.append(line)

    target.write_text("".join(output), encoding="utf-8")
    print("changed" if inserted else "not_found")
    raise SystemExit(0)

target.write_text("".join(output), encoding="utf-8")
print("changed" if changed else "unchanged")
PY
)"

fast_embed_status="$(
  python3 - "$tmp" <<'PY'
import sys
from pathlib import Path

target = Path(sys.argv[1])
text = target.read_text(encoding="utf-8")
if "path_regexp fast_embed" in text:
    print("unchanged")
    raise SystemExit(0)
if "path_regexp canonical_playback" not in text and "rend_hls_ladder_playback" not in text:
    print("not_found")
    raise SystemExit(0)

block = [
    "\n",
    "\t@fast_embed {\n",
    "\t\tpath_regexp fast_embed ^/embed-fast/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$\n",
    "\t}\n",
    "\thandle @fast_embed {\n",
    "\t\treverse_proxy 127.0.0.1:4100\n",
    "\t}\n",
]
lines = text.splitlines(keepends=True)
output = []
inserted = False
seen_public_playback = False
for line in lines:
    stripped = line.strip()
    if (
        "path_regexp canonical_playback" in line
        or "rend_hls_ladder_playback" in line
        or "handle @canonical_playback" in line
    ):
        seen_public_playback = True
    if seen_public_playback and not inserted and stripped == "handle {":
        output.extend(block)
        inserted = True
    output.append(line)

if not inserted:
    print("not_found")
    raise SystemExit(0)

target.write_text("".join(output), encoding="utf-8")
print("changed")
PY
)"

if [[ "$fast_embed_status" == "changed" ]]; then
  patch_status="changed"
elif [[ "$patch_status" == "not_found" && "$fast_embed_status" == "unchanged" ]]; then
  patch_status="unchanged"
elif [[ "$patch_status" != "not_found" && "$fast_embed_status" == "not_found" ]]; then
  die "managed edge Caddy playback routes were found, but fast embed route insertion failed"
fi

case "$patch_status" in
  changed | unchanged | not_found) ;;
  *) die "unexpected patch status: $patch_status" ;;
esac

if [[ "$patch_status" == "not_found" ]]; then
  echo "Edge Caddy playback routes do not use a deploy-managed allowlist; leaving $caddyfile unchanged"
  exit 0
fi

if [[ "$patch_status" == "unchanged" ]]; then
  echo "Edge Caddy playback routes already include HLS ladder and fast embed paths"
  exit 0
fi

if [[ "$dry_run" == "true" ]]; then
  echo "Edge Caddy playback routes would be updated in $caddyfile"
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$caddyfile" "${caddyfile}.bak.${stamp}"
cat "$tmp" > "$caddyfile"
echo "Updated edge Caddy playback routes in $caddyfile"

if [[ "$skip_reload" == "true" ]]; then
  echo "Skipped Caddy validate/reload"
  exit 0
fi

require_command caddy
require_command systemctl

caddy fmt --overwrite "$caddyfile"
caddy validate --config "$caddyfile"
systemctl reload caddy
echo "Caddy reload completed"
