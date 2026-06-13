# Rend Image Release Workflow V1

This is the narrow release workflow for first edge trials. It builds the
existing Dockerfile targets, tags them, optionally pushes them, and writes a
manifest that operators can use for deploy and rollback.

It does not provision registries, hosts, DNS, TLS, Terraform, Kubernetes,
Better Auth, billing, signing, or SBOMs.

## Canonical Images

The canonical service repositories are:

- `rend-api`
- `rend-media-worker`
- `rend-edge`

For a real registry, pass a repository prefix. With
`--registry registry.example.com/rend`, the canonical repositories become:

- `registry.example.com/rend/rend-api`
- `registry.example.com/rend/rend-media-worker`
- `registry.example.com/rend/rend-edge`

## Build

Local dry-run build without registry credentials:

```sh
bun run release:images -- --tag trial-001
```

If you are testing uncommitted changes locally, make that explicit. Do not use
this flag with `--push`; pushed releases always require a clean git worktree.

```sh
bun run release:images -- --tag trial-001 --allow-dirty
```

Production release build:

```sh
bun run release:images -- \
  --tag trial-001 \
  --registry registry.example.com/rend \
  --push
```

For GHCR, authenticate as the Unix user that will pull images on each host.
Docker CLI credentials are stored per user, so a host that sometimes runs
operator commands as `ubuntu` and sometimes with `sudo` needs both contexts:

```sh
docker login ghcr.io
sudo docker login ghcr.io
```

Each image is tagged with the full git SHA. When `--tag` is provided, the same
image also receives the human release tag, for example `trial-001`.

The script writes a manifest under `.rend/releases/` by default. Override it
with `--manifest`:

```sh
bun run release:images -- \
  --tag trial-001 \
  --registry registry.example.com/rend \
  --manifest .rend/releases/trial-001.json \
  --push
```

The image labels are:

- `org.opencontainers.image.source`
- `org.opencontainers.image.revision`
- `org.opencontainers.image.version`
- `org.opencontainers.image.created`
- `com.rend.service`

## Production Gates

The Dockerfile keeps fallback metadata defaults such as
`ARG REND_GIT_SHA=unknown` so existing local `docker compose build` and smoke
commands still work. Those defaults are not accepted by the release workflow.

`scripts/release-images.sh` enforces these release gates:

- the git worktree must be clean, unless `--allow-dirty` is passed for a local
  dry run;
- `--push` is refused when the worktree is dirty;
- `--push` requires `--registry` or `--prefix`;
- source, revision, version, and created labels must be real values, not
  `unknown`;
- built image labels must match the requested service, source, git SHA,
  version, and build time;
- pushed builds must resolve registry digest refs before the manifest is
  written.

## Manifest

The manifest maps each service to its tag, digest, git SHA, and build time:

```json
{
  "services": {
    "rend-api": {
      "image_tag": "registry.example.com/rend/rend-api:<git-sha>",
      "digest": "sha256:...",
      "image_digest": "registry.example.com/rend/rend-api@sha256:...",
      "git_sha": "<git-sha>",
      "build_time": "2026-06-13T12:00:00Z"
    }
  }
}
```

For local dry-run builds, `digest_kind` is `local-image-id` and `image_digest`
is `null`. For pushed builds, `digest_kind` is `registry-manifest` and
`image_digest` is the immutable deploy reference.

## Deploy From Manifest

Prefer immutable digest refs from `image_digest` for production compose
templates. Define a small helper on the host or operator laptop:

```sh
MANIFEST=.rend/releases/trial-001.json

manifest_image() {
  python3 - "$MANIFEST" "$1" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    manifest = json.load(f)
service = manifest["services"][sys.argv[2]]
print(service["image_digest"] or service["image_tag"])
PY
}
```

Before deploy or rollback, run the relevant host preflight without `--dry-run`.
It validates the manifest and pulls each `image_digest` ref, which proves the
host user and Docker daemon context can read the registry before Compose
touches running services.

Control-plane deploy:

```sh
export REND_API_IMAGE="$(manifest_image rend-api)"
export REND_MEDIA_WORKER_IMAGE="$(manifest_image rend-media-worker)"

docker compose -f /opt/rend/control-plane.compose.yml pull
docker compose -f /opt/rend/control-plane.compose.yml up -d --no-deps rend-api
curl -fsS http://127.0.0.1:4000/readyz
docker compose -f /opt/rend/control-plane.compose.yml up -d --no-deps rend-media-worker
```

Edge deploy:

```sh
export REND_EDGE_IMAGE="$(manifest_image rend-edge)"

docker compose -f /opt/rend/edge.compose.yml pull
docker compose -f /opt/rend/edge.compose.yml up -d --no-deps rend-edge
curl -fsS http://127.0.0.1:4100/readyz
```

## Verify

Inspect running image metadata:

```sh
bun run backend:docker:inspect-release
```

Check local API, worker, and edge images for matching version metadata:

```sh
bun run backend:docker:check-versions
```

For release images, run strict mode so fallback `unknown` metadata fails:

```sh
scripts/check-docker-image-versions.sh --tag trial-001 --strict
```

For running containers on a host that has this repo checkout:

```sh
scripts/check-docker-image-versions.sh --running
scripts/inspect-docker-release.sh --all
```

API and edge `/healthz` include the service name, package version, git SHA, and
build time. Check both after deploy:

```sh
curl -fsS http://127.0.0.1:4000/healthz
curl -fsS http://127.0.0.1:4100/healthz
```

## Rollback

Use the previous release manifest and export its digest refs:

```sh
MANIFEST=.rend/releases/trial-000.json
export REND_API_IMAGE="$(manifest_image rend-api)"
export REND_MEDIA_WORKER_IMAGE="$(manifest_image rend-media-worker)"
export REND_EDGE_IMAGE="$(manifest_image rend-edge)"
```

Roll back edge first when playback, cache, origin, or telemetry behavior
regresses:

```sh
docker compose -f /opt/rend/edge.compose.yml pull rend-edge
docker compose -f /opt/rend/edge.compose.yml up -d --no-deps rend-edge
curl -fsS http://127.0.0.1:4100/readyz
```

Roll back control-plane services after edge:

```sh
docker compose -f /opt/rend/control-plane.compose.yml pull
docker compose -f /opt/rend/control-plane.compose.yml up -d --no-deps rend-api
curl -fsS http://127.0.0.1:4000/readyz
docker compose -f /opt/rend/control-plane.compose.yml up -d --no-deps rend-media-worker
```
