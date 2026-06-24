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
5. SSH to the control-plane host and run a host-side blue/green transaction:
   - `scripts/preflight-control-plane-host.sh --skip-bind-port-check`
   - `scripts/deploy-control-plane-host.sh --dry-run`
   - `scripts/deploy-control-plane-host.sh`
   Before preflight, the deploy wrapper installs the current
   `control-plane.compose.yml`, patches an existing concrete Caddyfile to use
   the managed upstream snippet, creates that snippet if it is missing, and
   leaves any existing upstream target intact. The bootstrap also removes
   legacy `admin off` Caddy settings and reloads Caddy while the upstream still
   points at the current slot; if that one-time reload fails, it restarts Caddy
   before the deploy transaction begins so later promotions can use normal
   reloads. The managed upstream snippet is written `0644` so the `caddy`
   service user can import it during reload. The env sync step also enforces
   `REND_API_AUTO_MIGRATE=false` for production serving containers.
   `scripts/deploy-release-over-ssh.sh` launches these control-plane commands
   through `sudo systemd-run --wait --collect --pipe`, so the transaction runs
   as a host-side transient unit. If the GitHub runner or SSH session dies after
   the unit starts, the host can still finish promotion rollback/cleanup. The
   deploy helper takes a host lock, runs one-shot `rend-api migrate`, starts the
   inactive API slot, probes private `/readyz` and `/healthz`, switches the
   managed Caddy upstream snippet, reloads Caddy, and rolls back the snippet if
   post-promotion checks fail. The previous API slot remains running.
6. SSH to each configured edge host, serially, and run:
   - sync deploy-managed edge env keys from `REND_READINESS_EDGES`:
     `REND_EDGE_ID`, `REND_EDGE_REGION`, `REND_EDGE_BASE_URL`,
     `REND_EXPECTED_EDGES`, plus `REND_EDGE_CORS_ALLOWED_ORIGINS`
   - `scripts/preflight-edge-host.sh --skip-bind-port-check`
   - `scripts/deploy-edge-host.sh --dry-run`
   - `scripts/deploy-edge-host.sh`
   - local `rend-edge` `/readyz` and `/healthz`
7. Monitor public API `/readyz` during the control-plane deploy, store the
   redacted JSONL monitor artifact, and check public API `/readyz`. Each monitor
   sample records the attempt count and only fails the workflow after three
   short failed attempts, so a single transport reset during Caddy's graceful
   reload is visible but not treated as a sustained outage.
8. When `run_first_host_verifier` is enabled, verify the edge registry from the
   control-plane host with `scripts/verify-edge-registry-over-ssh.sh`, then run
   `scripts/verify-first-host-deploy.sh` against production API and edge targets.
   The workflow reuses the edge SSH tunnels for private `/readyz`,
   `/internal/warm`, and `/metrics` checks, then verifies public deny rules,
   warmed signed playback, telemetry analytics, and ClickHouse reachability.
9. Run the synthetic playback readiness gate when the required readiness secrets
   and edge targets are configured.
10. For an explicit production rollback drill, set
    `verify_control_plane_rollback=true` on a manual workflow dispatch. The
    workflow switches Caddy back to the previous control-plane slot without a
    pull/build, checks public `/readyz`, then re-promotes the current digest and
    checks public `/readyz` again.

Control-plane preflight treats bound blue/green ports as expected because the
old slot must keep serving. It still validates env files, Caddy upstream wiring,
registry pullability, image platform, host dependencies, and managed dependency
reachability. Edge preflight still validates edge control-plane
registration/heartbeat and telemetry ingest.

## Host Requirements

Control-plane hosts must have `systemd-run` available to run deploy and rollback
transactions as transient host-side units. If `systemd-run` is missing, the
automated control-plane deploy fails before the transaction starts or traffic is
changed. Edge deploys still run as direct SSH commands because the edge path is
not yet transactional.

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
synthetic playback checks. During edge deploy, the workflow also syncs each
host's edge identity from these entries so registry checks and edge heartbeat
IDs use the same source of truth. The workflow verifies registry rows over SSH
from the control-plane host, using that host's `/etc/rend/rend-api.env`
`DATABASE_URL`; GitHub does not need a separate production Postgres URL for this
automated check.

## Optional Secrets

- `DATABASE_URL`: only needed when running
  `scripts/verify-first-host-deploy.sh` registry checks directly from a laptop,
  bastion, or custom workflow instead of the host-side SSH registry verifier.
  Prefer a secret over a variable.

## Optional Variables

- `REND_VERIFY_ASSET_ID`: existing `hls_ready` synthetic/non-customer asset id
  for the deeper warmed-playback path in `scripts/verify-first-host-deploy.sh`.
  A manual workflow dispatch can override it with `verify_asset_id`. If omitted,
  the workflow runs the verifier with `--skip-playback` and relies on the
  synthetic playback readiness gate for upload/playback/telemetry proof.

## Rollback

Use the previous `rend-release-manifest` artifact from a successful workflow
run for edge rollback. For the control plane, switch back to the previous API
slot without pulling/building:

```sh
scripts/deploy-release-over-ssh.sh --role edge --host <edge-host> --user <user> --manifest <previous-manifest>
scripts/deploy-release-over-ssh.sh --role control-plane --host <control-host> --user <user> --rollback
```

Roll back edges first, then the media worker/API control plane. The
control-plane rollback assumes the previous API slot is still running. Treat
database migrations as forward-only unless a tested rollback migration exists.

## Remaining Risk

This automation makes the single control-plane host action-safe at the Docker
service/Caddy-upstream layer, but it does not remove the single-host SPOF:
kernel, VM, disk, network, Docker daemon, and Caddy process failures can still
take the host down. Edge deploys are still in-place per edge host; deploy one
edge at a time and keep the other edge serving, then verify with the playback
readiness gate. A full edge blue/green transaction should add per-edge
blue/green ports, a managed Caddy upstream snippet, candidate private
`/readyz`/`/healthz`, and automatic snippet rollback matching the control-plane
pattern.
