#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

compose_file="${REND_CONTROL_PLANE_COMPOSE_FILE:-/opt/rend/control-plane.compose.yml}"
caddyfile="${REND_CONTROL_PLANE_CADDYFILE:-/etc/caddy/Caddyfile}"
caddy_upstream_file="${REND_CONTROL_PLANE_CADDY_UPSTREAM_FILE:-/etc/caddy/rend-control-plane-upstream.caddy}"
backup_root="${REND_CONTROL_PLANE_BOOTSTRAP_BACKUP_DIR:-/var/backups/rend-control-plane-bootstrap}"

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-control-plane-host-files.sh [options]

Install or repair production control-plane host files before blue/green preflight.
The script installs the current Compose template, creates the managed Caddy
upstream snippet if it is missing, and patches an existing concrete Caddyfile to
import the managed upstream without changing public host labels. It also removes
legacy Caddy "admin off" settings so systemd/Caddy reloads can apply promotion
changes.

Options:
  --compose-file FILE         Destination Compose file. Default: /opt/rend/control-plane.compose.yml.
  --caddyfile FILE            Destination Caddyfile. Default: /etc/caddy/Caddyfile.
  --caddy-upstream-file FILE  Destination managed upstream snippet. Default:
                              /etc/caddy/rend-control-plane-upstream.caddy.
  -h, --help                  Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file)
      compose_file="${2:?missing value for $1}"
      shift 2
      ;;
    --caddyfile)
      caddyfile="${2:?missing value for $1}"
      shift 2
      ;;
    --caddy-upstream-file)
      caddy_upstream_file="${2:?missing value for $1}"
      shift 2
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

mkdir -p "$(dirname "$compose_file")" "$(dirname "$caddyfile")" "$(dirname "$caddy_upstream_file")" "$backup_root"
backup_dir="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"

for path in "$compose_file" "$caddyfile" "$caddy_upstream_file"; do
  if [[ -e "$path" ]]; then
    cp -a "$path" "$backup_dir/"
  fi
done

install -m 0644 "$root_dir/docs/templates/control-plane.compose.yml" "$compose_file"
if [[ ! -e "$caddy_upstream_file" ]]; then
  install -m 0644 "$root_dir/docs/templates/control-plane-upstream.Caddyfile" "$caddy_upstream_file"
fi

python3 - "$root_dir/docs/templates/control-plane.Caddyfile" "$caddyfile" "$caddy_upstream_file" "$backup_root" <<'PY'
from pathlib import Path
import re
import sys

template = Path(sys.argv[1])
caddyfile = Path(sys.argv[2])
upstream = Path(sys.argv[3])
backup_root = Path(sys.argv[4])

placeholder_markers = ("{$REND_PUBLIC_API_HOSTNAME}", "{$REND_CONTROL_PLANE_HOSTNAME}")

def latest_backup_caddyfile():
    candidates = []
    if backup_root.exists():
        for path in backup_root.glob("*/Caddyfile"):
            if path.is_file():
                candidates.append(path)
    for candidate in sorted(candidates, key=lambda item: item.stat().st_mtime, reverse=True):
        text = candidate.read_text(encoding="utf-8")
        if not any(marker in text for marker in placeholder_markers):
            return candidate
    return None

if caddyfile.exists():
    source_text = caddyfile.read_text(encoding="utf-8")
else:
    source_text = template.read_text(encoding="utf-8")

if any(marker in source_text for marker in placeholder_markers):
    backup = latest_backup_caddyfile()
    if backup is not None:
        source_text = backup.read_text(encoding="utf-8")

if not caddyfile.exists() and not source_text.strip():
    source_text = template.read_text(encoding="utf-8")

upstream_import = f"import {upstream}"

def remove_admin_off_global_options(source_lines):
    cleaned = [line for line in source_lines if line.strip() != "admin off"]
    first_content = next((index for index, line in enumerate(cleaned) if line.strip()), None)
    if first_content is None or cleaned[first_content].strip() != "{":
        return cleaned

    depth = 0
    end = None
    for index in range(first_content, len(cleaned)):
        stripped = cleaned[index].strip()
        if stripped == "{":
            depth += 1
        elif stripped == "}":
            depth -= 1
            if depth == 0:
                end = index
                break

    if end is None:
        return cleaned

    meaningful_inner = [
        line.strip()
        for line in cleaned[first_content + 1 : end]
        if line.strip() and not line.strip().startswith("#")
    ]
    if not meaningful_inner:
        del cleaned[first_content : end + 1]
    return cleaned

lines = remove_admin_off_global_options(source_text.splitlines())

if not any(line.strip() == upstream_import for line in lines):
    insert_at = 0
    while insert_at < len(lines) and not lines[insert_at].strip():
        insert_at += 1
    if insert_at < len(lines) and lines[insert_at].strip() == "{":
        depth = 0
        for index in range(insert_at, len(lines)):
            stripped = lines[index].strip()
            if stripped == "{":
                depth += 1
            elif stripped == "}":
                depth -= 1
                if depth == 0:
                    insert_at = index + 1
                    break
    lines[insert_at:insert_at] = ["", upstream_import]

proxy_pattern = re.compile(r"^(\s*)reverse_proxy\s+127\.0\.0\.1:4000\s*$")
replaced = False
for index, line in enumerate(lines):
    match = proxy_pattern.match(line)
    if match:
        lines[index] = f"{match.group(1)}import rend_active_control_plane"
        replaced = True

public_path_pattern = re.compile(r"^(\s*)path\s+(.+)$")
for index, line in enumerate(lines):
    match = public_path_pattern.match(line)
    if not match:
        continue
    paths = match.group(2).split()
    if "/v1/*" in paths and "/readyz" in paths and "/v/*" not in paths:
        insert_at = paths.index("/v1/*") + 1
        paths.insert(insert_at, "/v/*")
        lines[index] = f"{match.group(1)}path {' '.join(paths)}"

has_snippet_import = any(line.strip() == "import rend_active_control_plane" for line in lines)
if not has_snippet_import:
    if not replaced and source_text == template.read_text(encoding="utf-8"):
        has_snippet_import = True
    else:
        raise SystemExit(f"{caddyfile} has no reverse_proxy 127.0.0.1:4000 line to replace")

caddyfile.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
PY

chmod 0644 "$compose_file" "$caddyfile" "$caddy_upstream_file"

reload_bootstrapped_caddy() {
  if [[ "${REND_CONTROL_PLANE_BOOTSTRAP_RELOAD:-true}" != "true" ]]; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  if ! systemctl is-active --quiet caddy; then
    return 0
  fi

  if command -v caddy >/dev/null 2>&1; then
    caddy validate --config "$caddyfile" >/dev/null
  fi

  if systemctl reload caddy; then
    echo "Control-plane Caddy bootstrap reload completed"
    return 0
  fi

  echo "Control-plane Caddy reload failed during bootstrap; restarting once to load reloadable config" >&2
  systemctl restart caddy
  echo "Control-plane Caddy bootstrap restart completed"
}

reload_bootstrapped_caddy
echo "Control-plane host files bootstrapped"
