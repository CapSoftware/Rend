# Rend Production Deploy Automation

This workflow keeps the bare-metal control plane and edge hosts on the latest
released binaries after a `main` build.

The GitHub Actions workflow is `.github/workflows/release-deploy.yml`.

## Flow

1. Build `rend-api`, `rend-media-worker`, and `rend-edge` Docker targets.
2. Push them to GHCR under `ghcr.io/<org>/rend/<service>`.
3. Write a release manifest with immutable `@sha256:` image refs.
4. Wait on the GitHub `Production` environment approval if that environment is
   configured with required reviewers.
5. SSH to the control-plane host and run:
   - `scripts/preflight-control-plane-host.sh --skip-bind-port-check`
   - `scripts/deploy-control-plane-host.sh --dry-run`
   - `scripts/deploy-control-plane-host.sh`
   - local `rend-api` `/readyz` and `/healthz`
   The deploy helper waits for `rend-api` `/readyz` before starting
   `rend-media-worker`.
6. SSH to each configured edge host, serially, and run:
   - `scripts/preflight-edge-host.sh --skip-bind-port-check`
   - `scripts/deploy-edge-host.sh --dry-run`
   - `scripts/deploy-edge-host.sh`
   - local `rend-edge` `/readyz` and `/healthz`
7. Check public API `/readyz`.
8. Run the synthetic playback readiness gate when the required readiness secrets
   and edge targets are configured.

Preflight skips bind-port checks during automated updates because the existing
service should already own the port. It still validates env files, registry
pullability, image platform, host dependencies, managed dependency reachability,
edge control-plane registration/heartbeat, and telemetry ingest.

## Required GitHub Environment

Create a GitHub Environment named `Production`. Configure required reviewers if
production deploys should pause for human approval after the image release.

## Required Secrets

Set these as `Production` environment secrets unless noted otherwise:

- `REND_SSH_PRIVATE_KEY`: private key with SSH access to the control-plane and
  edge hosts.
- `REND_SSH_KNOWN_HOSTS`: pinned host key lines for all SSH targets.
- `REND_CONTROL_PLANE_SSH_HOST`
- `REND_CONTROL_PLANE_SSH_USER`
- `REND_CONTROL_PLANE_SSH_PORT` (optional; defaults to `22`)
- `REND_EDGE_ASH_SSH_HOST`
- `REND_EDGE_ASH_SSH_USER`
- `REND_EDGE_ASH_SSH_PORT` (optional; defaults to `22`)
- `REND_EDGE_AMS_SSH_HOST`
- `REND_EDGE_AMS_SSH_USER`
- `REND_EDGE_AMS_SSH_PORT` (optional; defaults to `22`)
- `REND_READINESS_API_KEY`: API key with upload, read, delete, and analytics
  scopes for synthetic readiness media.
- `REND_EDGE_INTERNAL_TOKEN`: edge internal token for readiness warm, purge, and
  metrics checks.
- `CLICKHOUSE_PASSWORD`: production ClickHouse password. `CLICKHOUSE_URL`,
  `CLICKHOUSE_DATABASE`, and `CLICKHOUSE_USER` may also be set as secrets instead
  of variables.
- `AUTUMN_SECRET_KEY`: live Autumn secret key.

Generate known-hosts entries from a trusted operator machine, verify the
fingerprints out of band, then paste the lines into `REND_SSH_KNOWN_HOSTS`:

```sh
ssh-keyscan -H api-internal.play.rend.so ash-1.play.rend.so ams-1.play.rend.so
```

Each host must already be able to pull from GHCR in the Docker daemon context
used by the SSH user:

```sh
docker login ghcr.io
sudo docker login ghcr.io
```

## Required Variables

Set these as `Production` environment variables:

- `REND_API_BASE_URL`: defaults to `https://api.rend.so` when omitted.
- `CLICKHOUSE_URL`: production ClickHouse HTTP endpoint.
- `CLICKHOUSE_DATABASE`: defaults to `rend` when omitted.
- `CLICKHOUSE_USER`: production ClickHouse user.
- `REND_API_CORS_ALLOWED_ORIGINS`: defaults to
  `https://rend.so,https://www.rend.so` when omitted.
- `REND_READINESS_EDGES`: comma-separated
  `edge_id=region=public_base[=private_base]` entries, for example:

```text
rend-edge-ash-1=us-east=https://ash-1.play.rend.so=https://ash-1-private.play.rend.so,rend-edge-ams-1=amsterdam=https://ams-1.play.rend.so=https://ams-1-private.play.rend.so
```

The GitHub workflow opens SSH tunnels to the configured `rend-edge-ash-1` and
`rend-edge-ams-1` hosts and rewrites the private bases to runner-local tunnel
URLs for the readiness gate. This keeps `/internal/*` and `/metrics` off the
public edge hostnames while still allowing GitHub-hosted runners to run the
synthetic playback checks.

## Rollback

Use the previous `rend-release-manifest` artifact from a successful workflow
run, then run the same host deploy helper manually in this order:

```sh
scripts/deploy-release-over-ssh.sh --role edge --host <edge-host> --user <user> --manifest <previous-manifest>
scripts/deploy-release-over-ssh.sh --role control-plane --host <control-host> --user <user> --manifest <previous-manifest>
```

Roll back edges first, then the media worker/API control plane. Treat database
migrations as forward-only unless a tested rollback migration exists.
