#!/usr/bin/env bash
set -euo pipefail

spool_file=""
quarantine_file=""
lines_spec=""
dry_run=false

usage() {
  cat <<'EOF'
Usage: scripts/quarantine-telemetry-spool-lines.sh --spool FILE --lines LIST [options]

Move selected JSONL line numbers out of an edge telemetry spool while preserving
all other records. LIST accepts comma-separated numbers and ranges, for example
3,8-10.

Options:
  --spool FILE        Spool file. Usually /var/spool/rend/edge-telemetry/playback-events.jsonl.
  --lines LIST        1-based line numbers/ranges to quarantine.
  --quarantine FILE   Destination file. Default: playback-events.quarantine.jsonl next to --spool.
  --dry-run           Print the selected lines without changing files.
  -h, --help          Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --spool)
      spool_file="${2:?missing value for $1}"
      shift 2
      ;;
    --lines)
      lines_spec="${2:?missing value for $1}"
      shift 2
      ;;
    --quarantine)
      quarantine_file="${2:?missing value for $1}"
      shift 2
      ;;
    --dry-run)
      dry_run=true
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

[[ -n "$spool_file" && -n "$lines_spec" ]] || {
  usage >&2
  exit 2
}

python3 - "$spool_file" "$lines_spec" "${quarantine_file:-}" "$dry_run" <<'PY'
import os
import shutil
import sys
import time

spool_path, spec, quarantine_path, dry_run_raw = sys.argv[1:5]
dry_run = dry_run_raw == "true"
if not quarantine_path:
    quarantine_path = os.path.join(
        os.path.dirname(spool_path),
        "playback-events.quarantine.jsonl",
    )

selected = set()
for part in spec.split(","):
    part = part.strip()
    if not part:
        continue
    if "-" in part:
        start_s, end_s = part.split("-", 1)
        start, end = int(start_s), int(end_s)
        if start <= 0 or end < start:
            raise SystemExit(f"invalid line range: {part}")
        selected.update(range(start, end + 1))
    else:
        line_no = int(part)
        if line_no <= 0:
            raise SystemExit(f"invalid line number: {part}")
        selected.add(line_no)

if not selected:
    raise SystemExit("no lines selected")

with open(spool_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

missing = sorted(line_no for line_no in selected if line_no > len(lines))
if missing:
    raise SystemExit(f"selected line(s) do not exist: {', '.join(map(str, missing))}")

quarantined = [
    line for index, line in enumerate(lines, start=1) if index in selected
]
remaining = [
    line for index, line in enumerate(lines, start=1) if index not in selected
]

if dry_run:
    for index, line in enumerate(lines, start=1):
        if index in selected:
            print(f"{index}: {line}", end="" if line.endswith("\n") else "\n")
    raise SystemExit(0)

backup_path = f"{spool_path}.bak.{int(time.time())}"
tmp_path = f"{spool_path}.tmp.{os.getpid()}"
shutil.copy2(spool_path, backup_path)
with open(tmp_path, "w", encoding="utf-8") as f:
    f.writelines(remaining)
os.replace(tmp_path, spool_path)

os.makedirs(os.path.dirname(quarantine_path) or ".", exist_ok=True)
with open(quarantine_path, "a", encoding="utf-8") as f:
    f.writelines(quarantined)

print(
    f"quarantined {len(quarantined)} line(s) from {spool_path} "
    f"to {quarantine_path}; backup: {backup_path}"
)
PY
