# Rend Playback Edge V1 Deployment

This document defines the V1 production shape and the local Docker topology. It
does not provision cloud resources.

For initial us-east and london production edge host deployments, use the
operational runbook and production-style examples in
[`docs/edge-host-runbook-v1.md`](edge-host-runbook-v1.md).
Use the image release workflow in [`docs/release-images-v1.md`](release-images-v1.md)
to build production images and deploy immutable digest refs from the release
manifest.
Public V1 billing uses Autumn; see
[`docs/billing-autumn-v1.md`](billing-autumn-v1.md) for the customer mapping,
feature IDs, failure policy, and usage tracking model.
Run the public launch gate before deploy or promotion; see
[`docs/launch-gate-v1.md`](launch-gate-v1.md).

## Service Topology

- `rend-api`: Rust API and control plane. It owns upload ingest, asset state,
  Postgres migrations, playback bootstrap, Tigris-origin playback, the optional
  `rend.edge_nodes` registry, and telemetry ingestion into ClickHouse.
- `rend-media-worker`: the same repo runtime, started as `rend-api worker media`.
  It claims queued media jobs, uses `ffmpeg` and `ffprobe`, writes artifacts to
  S3-compatible storage. In the current default `REND_PLAYBACK_MODE=tigris`
  path it does not warm playback artifacts to edge nodes.
- `rend-edge`: Rust playback edge. It validates signed playback URLs locally,
  serves playback artifacts, fills and coalesces local cache misses from object
  storage, exposes internal warm/purge endpoints, registers and heartbeats with
  `rend-api` when configured, and spools playback telemetry locally before
  sending it to `rend-api`. This implementation is intentionally dormant in
  production unless `REND_PLAYBACK_MODE=edge` is explicitly enabled.

Production dependencies are external managed services: Postgres, Redis,
S3-compatible object storage, and ClickHouse.

## Browser Media Path

Production browser playback currently uses the site route for JSON bootstrap
and same-origin artifact URLs. The artifact route fetches Rend's API-origin
`/v/{assetId}/...` path, which validates the Rend playback cookie and streams
private Tigris-backed objects without exposing signed object-store URLs:

```txt
browser
  -> https://www.rend.so/api/player/{assetId}
  -> route returns tokenless /api/player/{assetId}/artifact/... URLs
  -> https://www.rend.so/api/player/{assetId}/artifact/{artifactPath}
  -> https://api.rend.so/v/{assetId}/{artifactPath}
  -> rend-api validates the playback cookie
  -> Tigris/object-storage origin
```

`REND_PLAYBACK_MODE=tigris` is the default for local and production. In this
mode `REND_TIGRIS_PLAYBACK_BASE_URL` should point at the public API origin, for
example `https://api.rend.so`, and warm/purge fanout is skipped even if edge
registry rows or legacy edge URLs are configured.

The checked-in `@rend/playback-routing` route table remains available for the
future edge mode. Set `REND_PLAYBACK_MODE=edge` to re-enable metal selection,
direct `/v/{assetId}/...` edge URLs, and warm/purge fanout. Current public metal
routes retained for that optional mode:

```txt
ash-1  us-east    https://ash-1.play.rend.so
ams-1  amsterdam  https://ams-1.play.rend.so
```

`REND_PLAYER_EDGE_BASE_URLS` and `REND_PLAYER_PLAYBACK_BASE_URL` are ignored by
the site player unless `REND_PLAYBACK_MODE=edge` is set or a request uses an
allowlisted explicit `playbackBaseUrl` override. In Tigris mode, `x-rend-origin:
tigris` on API-origin artifact responses is the expected proof signal; edge
headers such as `x-rend-cache`, `x-rend-edge-id`, and `x-rend-region` are not on
the active path.

The current path keeps playback tokens out of JavaScript-visible URLs, preserves
the HttpOnly playback credential boundary, avoids exposing `/internal/*`, and
keeps private/authenticated media private. The site route logs one structured
`rend_player_playback_selected` event per playback bootstrap without IP
addresses, cookies, auth headers, playback tokens, signed URLs, or raw
coordinates.

## Local Docker Topology

`compose.yml` mirrors the production roles with local services:

- Postgres on host port `5432`
- Redis on host port `6379`
- MinIO S3 API on host port `9100` and console on `9101`
- ClickHouse HTTP on host port `8123`
- `rend-api` on host port `4000`
- default `rend-edge` on host port `4100`
- optional `rend-edge-us-east` on host port `4101`
- optional `rend-edge-london` on host port `4102`

Container-to-container URLs use Docker service names: `postgres`, `redis`,
`minio`, `clickhouse`, `rend-api`, and `rend-edge`. Local playback defaults to
`REND_PLAYBACK_MODE=tigris` with `REND_TIGRIS_PLAYBACK_BASE_URL` pointing at
`rend-api`. Edge containers can still register API-reachable `REND_EDGE_BASE_URL`
values in `rend.edge_nodes`, but API and worker warm/purge fanout is skipped
unless `REND_PLAYBACK_MODE=edge` is set.

Run the default single-edge stack:

```sh
bun run backend:docker:build
bun run backend:docker:up
```

Run the two-edge simulation:

```sh
docker compose --profile two-edge up -d rend-edge-us-east rend-edge-london
bun run backend:docker:two-edge-smoke
```

## Production Topology

Deploy the same image targets:

- `rend-api`: `Dockerfile` target `rend-api`
- `rend-media-worker`: `Dockerfile` target `rend-media-worker`
- `rend-edge`: `Dockerfile` target `rend-edge`

The runtime image includes `ffmpeg` and `ffprobe` so the media worker can run
without host media tooling. In production, run API, worker, and edge as separate
services even when they share a repository and image lineage.

Canonical image repositories are `rend-api`, `rend-media-worker`, and
`rend-edge`. For a registry prefix such as `registry.example.com/rend`, the
release script builds `registry.example.com/rend/rend-api`,
`registry.example.com/rend/rend-media-worker`, and
`registry.example.com/rend/rend-edge`. Production compose variables should use
the manifest `image_digest` values, for example
`registry.example.com/rend/rend-api@sha256:...`, instead of mutable tags.

## Required Env Vars

API:

- `REND_ENV=local|production`
- `DATABASE_URL`
- `REND_REDIS_URL`
- `CLICKHOUSE_URL`
- `CLICKHOUSE_DATABASE`
- `CLICKHOUSE_USER`
- `CLICKHOUSE_PASSWORD`
- `OBJECT_STORE_HEALTH_URL`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `REND_API_BIND_ADDR`
- `REND_API_CORS_ALLOWED_ORIGINS`
- `REND_API_AUTO_MIGRATE`
- `REND_SITE_INTERNAL_TOKEN`
- `REND_BILLING_MODE=local|autumn` (`autumn` is required in production)
- `AUTUMN_SECRET_KEY` when `REND_BILLING_MODE=autumn`
- `AUTUMN_API_URL`
- `AUTUMN_API_VERSION`
- `REND_BILLING_FEATURE_DELIVERY_720P`
- `REND_BILLING_FEATURE_DELIVERY_1080P`
- `REND_BILLING_FEATURE_DELIVERY_2K`
- `REND_BILLING_FEATURE_DELIVERY_4K`
- `REND_BILLING_FEATURE_STORAGE_720P`
- `REND_BILLING_FEATURE_STORAGE_1080P`
- `REND_BILLING_FEATURE_STORAGE_2K`
- `REND_BILLING_FEATURE_STORAGE_4K`
- `REND_BILLING_ENTITLEMENT_FAILURE_POLICY`
- `REND_BILLING_DELIVERY_SYNC_LAG_SECS`
- `REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS`
- `REND_BILLING_STORAGE_SYNC_LAG_SECS`
- `REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS`
- `REND_PLAYBACK_MODE=tigris`
- `REND_TIGRIS_PLAYBACK_BASE_URL`
- `REND_PLAYBACK_COOKIE_DOMAIN`
- `REND_MAX_UPLOAD_BYTES`
- `REND_INTERNAL_TELEMETRY_TOKEN`
- `REND_PLAYBACK_SIGNING_KEY_ID`
- `REND_PLAYBACK_SIGNING_SECRET`
- `REND_PLAYBACK_TOKEN_TTL_SECS`

`REND_PLAYBACK_MODE=tigris` is the production default. Set
`REND_TIGRIS_PLAYBACK_BASE_URL` to the public API origin, for example
`https://api.rend.so`. `REND_PLAYBACK_BASE_URL`,
`REND_EDGE_WARM_URL`, and `REND_EDGE_PURGE_URL` are edge-mode settings; leave
them unset in normal production unless `REND_PLAYBACK_MODE=edge` is explicitly
enabled.
`REND_PLAYER_PLAYBACK_BASE_URL`, `REND_PLAYER_EDGE_BASE_URLS`,
`REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS`, `REND_EXPECTED_EDGES`,
`REND_ALLOW_INSECURE_EDGE_URLS`, and `REND_EDGE_INTERNAL_TOKEN` are required
only for explicit edge-mode deployments. `REND_EXPECTED_EDGES` uses
comma-separated `edge_id=region=base_url` entries. In `production`, edge base
URLs must be HTTPS.

Worker:

- all API dependency vars used for Postgres, Redis, S3, ClickHouse, playback
  signing, edge internal auth, and Autumn billing
- `REND_API_AUTO_MIGRATE=false` after the API migration step is deployed

The `Release and Deploy Backend` workflow syncs the deploy-managed allowlist
into the control-plane API and worker env files before deployment, including
`CLICKHOUSE_*`, `REND_API_CORS_ALLOWED_ORIGINS`, and billing keys. The
Production GitHub environment must include `CLICKHOUSE_URL`, `CLICKHOUSE_USER`,
`CLICKHOUSE_PASSWORD`, and `AUTUMN_SECRET_KEY`; the sync helper refuses to run
unless the Autumn key is visibly live, and logs only key names.

- `REND_MEDIA_WORKER_ID`
- `REND_MEDIA_WORKER_POLL_INTERVAL_SECS`
- `REND_MEDIA_JOB_LOCK_TIMEOUT_SECS`
- `REND_MEDIA_PROCESS_TIMEOUT_SECS`
- `REND_FFMPEG_PATH`
- `REND_FFPROBE_PATH`

Edge:

- `REND_ENV=local|production`
- `REND_EDGE_BIND_ADDR`
- `REND_EDGE_ID`
- `REND_EDGE_REGION`
- `REND_EDGE_BASE_URL`
- `REND_EDGE_CORS_ALLOWED_ORIGINS`
- `REND_EXPECTED_EDGES`
- `REND_ALLOW_INSECURE_EDGE_URLS`
- `REND_CONTROL_PLANE_URL`
- `REND_EDGE_HEARTBEAT_INTERVAL_SECS`
- `REND_EDGE_CACHE_MAX_BYTES`
- `REND_EDGE_CACHE_MIN_FREE_BYTES`
- `REND_EDGE_CACHE_DIR`
- `REND_EDGE_ORIGIN_HEALTH_URL`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `REND_EDGE_INTERNAL_TOKEN`
- `REND_EDGE_WARM_MAX_ARTIFACTS` (default `16`; enough for the HLS master, four variant playlists, and the first two segments for each generated tier)
- `REND_EDGE_MAX_IN_FLIGHT_FILLS`
- `REND_EDGE_MAX_ORIGIN_ARTIFACT_BYTES`
- `REND_INTERNAL_TELEMETRY_TOKEN`
- `REND_EDGE_TELEMETRY_ENABLED`
- `REND_EDGE_TELEMETRY_INGEST_URL`
- `REND_EDGE_TELEMETRY_QUEUE_CAPACITY`
- `REND_EDGE_TELEMETRY_BATCH_SIZE`
- `REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS`
- `REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS`
- `REND_EDGE_TELEMETRY_SPOOL_DIR`
- `REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES`
- `REND_PLAYBACK_SIGNING_KEY_ID`
- `REND_PLAYBACK_SIGNING_SECRET`

Use `.env.local.example` for host development and `.env.docker.example` for
Docker service-name defaults. Production secrets must come from
`.env.production.local` for local production-targeted checks or from the
deployment platform for real deploys, not from `.env.local`.

Production mode rejects empty required secrets, checked-in dev
defaults, and local service URLs such as `localhost`, `127.0.0.1`, `minio`,
`rend-api`, or `rend-edge`. `rend-edge` streams cold playback misses while writing
atomic cache files and enforces cache size/free-space bounds with deterministic
priority eviction.

Local validation and production-profile validation are separate:

```sh
bun run env:local
bun run env:production
bun run verify:production-local
```

Production-profile commands load `.env.production` and `.env.production.local`
or host/platform env vars. They do not load `.env.local`.

## Volumes

Local Compose uses persistent volumes for:

- `rend-postgres-data`
- `rend-redis-data`
- `rend-minio-data`
- `rend-clickhouse-data`
- `rend-edge-cache`
- `rend-edge-telemetry-spool`
- `rend-edge-us-east-cache`
- `rend-edge-us-east-telemetry-spool`
- `rend-edge-london-cache`
- `rend-edge-london-telemetry-spool`

In production, Postgres, Redis, object storage, and ClickHouse are managed
externally. Each edge node keeps local cache and telemetry spool volumes. These
edge volumes are node-local, not shared.

## Healthchecks

- Postgres: `pg_isready`
- Redis: `redis-cli ping`
- MinIO: `/minio/health/ready`
- ClickHouse: `SELECT 1`
- `rend-api`: `GET /readyz`
- `rend-edge`: `GET /readyz`
- `rend-media-worker`: process liveness check for `rend-api worker media`

API readiness checks Postgres, Redis, and object storage. Edge readiness checks
the local cache directory and object-store origin. Worker readiness is process
liveness because the worker has no HTTP listener.

## Bootstrap And Migrations

Postgres migrations are applied through the explicit one-shot
`rend-api migrate` command. Local Compose still sets
`REND_API_AUTO_MIGRATE=true` on the local API for developer convenience and sets
the worker to `false` to avoid duplicate startup migration work. Production
serving API and worker containers must use `REND_API_AUTO_MIGRATE=false`; the
control-plane deploy helper runs the candidate image's `rend-api-migrate`
service before any Caddy traffic promotion.

Treat production Postgres migrations as expand/contract and rollback-hostile
unless a tested rollback migration exists. A failed pre-promotion candidate
keeps the old API slot serving, but an already-applied schema migration is not
automatically reverted.

ClickHouse schema is applied by the local `clickhouse-init` one-shot service on
every Compose startup. The schema uses `CREATE DATABASE IF NOT EXISTS` and
`CREATE TABLE IF NOT EXISTS`, so repeated runs are safe.

MinIO bucket creation is handled by the local-only `minio-init` one-shot
service. Production object storage should be provisioned outside this repo.

## Operator Harness

Use the checked-in operator scripts for first-host production deployments. They do not provision
cloud resources, DNS, TLS, proxies, registry credentials, image signing, or
SBOMs.

Validate production env files before deploy:

```sh
scripts/validate-production-env.sh --role control-plane
scripts/validate-production-env.sh --role edge-host
```

The validator requires vars to be present, rejects placeholder values, rejects
local/dev defaults unless `--allow-dev-defaults` is passed, and checks URL,
port, boolean, numeric, and path shapes. For local Docker example dry-runs:

```sh
scripts/validate-production-env.sh --role all --allow-dev-defaults \
  --api-env .env.docker.example \
  --worker-env .env.docker.example \
  --edge-env .env.docker.example
```

Run host preflight before deploy. Production manifests must contain
`image_digest` refs and platform metadata for the required services. The host
expectation defaults to `linux/amd64`; pass `--expected-platform` only for an
intentional architecture change:

```sh
scripts/preflight-control-plane-host.sh \
  --manifest .rend/releases/production-001.json

scripts/preflight-edge-host.sh \
  --manifest .rend/releases/production-001.json
```

The control-plane preflight checks Docker/Compose, compose/env files, Caddy
upstream template wiring, manifest digest refs, manifest platform metadata,
manifest image pull readiness, pulled image OS/architecture, and managed
dependency connectivity where local tools allow it. The active blue/green API
slot is expected to keep one private port bound, so control-plane preflight does
not require API ports to be free. The edge preflight checks Docker/Compose, edge env,
manifest digest ref, manifest platform metadata, manifest image pull readiness,
pulled image OS/architecture,
private-by-default direct port publishing, uid/gid `10001` cache and spool
writeability, object-store health, control-plane register/heartbeat
reachability, telemetry ingest reachability, and host bind ports.

Use deploy helpers in dry-run mode first to print the exact Compose/Caddy
transaction with manifest image refs:

```sh
scripts/deploy-control-plane-host.sh \
  --manifest .rend/releases/production-001.json \
  --dry-run

scripts/deploy-edge-host.sh \
  --manifest .rend/releases/production-001.json \
  --dry-run
```

The control-plane helper is transactional on the host. It takes
`/var/lock/rend-control-plane-deploy.lock`, records active/previous slot state
under `/var/lib/rend/control-plane`, runs the one-shot migration, recreates only
the inactive API slot (`rend-api-blue` or `rend-api-green`), probes candidate
`/readyz` and `/healthz` directly, then atomically replaces
`/etc/caddy/rend-control-plane-upstream.caddy` and reloads Caddy. If promotion
or post-promotion checks fail, it restores the previous upstream. The previous
API slot remains running after a successful promotion for immediate rollback.
When invoked by `scripts/deploy-release-over-ssh.sh`, the control-plane
transaction runs under `sudo systemd-run --wait --collect --pipe` so rollback can
continue on the host if the GitHub runner or SSH session dies after the unit is
started.

The SSH wrapper also bootstraps production host files before preflight: it
installs the current control-plane Compose template, patches an existing
concrete Caddyfile to use the managed upstream snippet, creates
`/etc/caddy/rend-control-plane-upstream.caddy` only when missing, removes
legacy `admin off` Caddy settings, and preserves an existing upstream target.
The bootstrap reloads Caddy while the upstream still points at the current slot;
if an older running config cannot reload because admin was disabled, it performs
one restart before the transaction starts so later blue/green promotions can use
normal Caddy reloads. The managed upstream snippet must stay `0644`; preflight
fails if the file is root-only because the `caddy` service user imports it on
reload.

The edge helper remains an in-place per-host deploy. For production, deploy
edges serially and keep at least one edge serving while the other updates, then
run the multi-edge verifier/readiness gate. A future edge hardening pass should
mirror the control-plane slot model: `rend-edge-blue`/`rend-edge-green`, private
candidate probes, a managed Caddy upstream snippet, and automatic rollback on
post-promotion failures.

The production workflow derives each edge host's `REND_EDGE_ID`,
`REND_EDGE_REGION`, `REND_EDGE_BASE_URL`, and shared `REND_EXPECTED_EDGES` from
`REND_READINESS_EDGES` before restarting that edge. Keep those entries aligned
with the intended registry IDs; the verifier treats the registry as authoritative
after deploy.

After deploy, verify the first-host path:

```sh
scripts/verify-first-host-deploy.sh \
  --api-base https://api.rend.so \
  --edge-base https://edge-us-east.example.com \
  --edge-internal-base http://10.0.10.12:4100 \
  --edge-base https://edge-london.example.com \
  --edge-internal-base http://10.0.20.12:4100 \
  --api-env /etc/rend/rend-api.env \
  --edge-env /etc/rend/rend-edge.env \
  --asset-id 00000000-0000-0000-0000-000000000000 \
  --rewrite-playback-base
```

The verifier checks API `/readyz`, private edge `/readyz`, all expected edge
registrations, the public deny surface, warmed `HIT` signed playback on each
edge, playback analytics increasing after the smoke requests, no
dropped-telemetry increase, and telemetry spool bytes returning to `0`. It reads
Postgres and ClickHouse settings from `--api-env`, or from explicit
`--database-url`, `--clickhouse-url`, `--clickhouse-database`,
`--clickhouse-user`, and `--clickhouse-password` flags for laptop or bastion
runs. For `psql` probes only, it normalizes hosted Postgres URLs by removing
`sslrootcert=system`; the service `DATABASE_URL` is not rewritten.

## Playback Readiness Gate

Run the synthetic playback readiness gate before and after production deploys
that can affect upload ingest, media processing, playback bootstrap, edge
cache behavior, telemetry, or deploy routing. The gate uploads generated test
media only; it does not use customer media.

Local two-edge run:

```sh
bun run playback:readiness
```

The default target starts the local Docker stack plus the `two-edge` profile,
then verifies `rend-edge-us-east` on `http://127.0.0.1:4101` and
`rend-edge-london` on `http://127.0.0.1:4102`.

Production-style run:

```sh
REND_API_BASE_URL=https://api.rend.so \
REND_READINESS_API_KEY=<api-key-with-upload-read-delete-analytics> \
REND_EDGE_INTERNAL_TOKEN=<edge-internal-token> \
REND_READINESS_EDGES='edge-us=us-east=https://edge-us.example.com=http://10.0.10.12:4100,edge-eu=london=https://edge-eu.example.com=http://10.0.20.12:4100' \
bun run playback:readiness -- --target configured --skip-local-stack
```

`REND_READINESS_EDGES` uses
`edge_id=region=public_playback_base[=private_edge_base]`. The public base is
used for signed playback fetches; the private base is used for `/readyz`,
`/internal/warm`, `/internal/purge`, and `/metrics`. If the private base is
omitted, the public base is used for both.

To include the gate in first-host verification:

```sh
scripts/verify-first-host-deploy.sh \
  --api-base https://api.rend.so \
  --edge-base https://edge-us-east.example.com \
  --edge-internal-base http://10.0.10.12:4100 \
  --edge-base https://edge-london.example.com \
  --edge-internal-base http://10.0.20.12:4100 \
  --api-env /etc/rend/rend-api.env \
  --edge-env /etc/rend/rend-edge.env \
  --asset-id 00000000-0000-0000-0000-000000000000 \
  --rewrite-playback-base \
  --run-readiness-gate
```

The gate writes a run artifact and updates
`.rend/readiness/playback-readiness-latest.json` for the private operator UI.
Set `REND_READINESS_OUTPUT`, `REND_READINESS_LATEST_OUTPUT`, or
`REND_READINESS_ARTIFACT_PATH` to place or read the latest result elsewhere.
Artifacts are redacted and are checked before write: they must not contain full
URLs, cookies, signed URL query tokens, authorization headers, bearer tokens,
configured API keys, edge internal tokens, or client IPs.

The result status means:

- `pass`: correctness checks passed and all measured timings stayed under warn
  thresholds.
- `warn`: correctness checks passed, but one or more conservative performance
  warn thresholds were exceeded. Treat this as a deploy note unless the trend is
  regressing.
- `fail`: a correctness/safety check failed or a fail threshold was exceeded.
  Do not promote the deploy until the artifact's `failures` list is resolved.

Correctness failures include missing expected edges, non-200 upload/bootstrap/
playback responses, non-tokenless playback URL shape, wrong content types,
unexpected cache headers, telemetry visibility timeout, dropped telemetry
increase, nonzero telemetry spool bytes after the run, unredacted artifact
content, or synthetic cleanup failure.

Performance thresholds can be configured with env vars:

- `REND_READINESS_WARN_UPLOAD_RESPONSE_MS`,
  `REND_READINESS_FAIL_UPLOAD_RESPONSE_MS`
- `REND_READINESS_WARN_UPLOAD_TO_OPENER_PLAYABLE_MS`,
  `REND_READINESS_FAIL_UPLOAD_TO_OPENER_PLAYABLE_MS`
- `REND_READINESS_WARN_UPLOAD_TO_HLS_READY_MS`,
  `REND_READINESS_FAIL_UPLOAD_TO_HLS_READY_MS`
- `REND_READINESS_WARN_PLAYBACK_BOOTSTRAP_MS`,
  `REND_READINESS_FAIL_PLAYBACK_BOOTSTRAP_MS`
- `REND_READINESS_WARN_EDGE_TTFB_MISS_MS`,
  `REND_READINESS_FAIL_EDGE_TTFB_MISS_MS`
- `REND_READINESS_WARN_EDGE_TTFB_HIT_MS`,
  `REND_READINESS_FAIL_EDGE_TTFB_HIT_MS`
- `REND_READINESS_WARN_EDGE_TTFB_WARMED_HIT_MS`,
  `REND_READINESS_FAIL_EDGE_TTFB_WARMED_HIT_MS`
- `REND_READINESS_WARN_TELEMETRY_VISIBILITY_MS`,
  `REND_READINESS_FAIL_TELEMETRY_VISIBILITY_MS`

The bytes-per-delivered-minute value is a proxy from synthetic playback bytes
and fixture duration. It is useful for deploy comparison, not billing-grade
usage or watch accounting.

## Deploy Order

1. Provision managed Postgres, Redis, S3-compatible storage, and ClickHouse.
2. Apply or confirm ClickHouse schema.
3. From a clean git worktree, build and optionally push images with
   `bun run release:images -- --tag production-001 --registry <registry-prefix>
--platform linux/amd64 --push`. Pushed releases require the git SHA to be
   reachable from a pushed branch or tag and copy the accepted manifest to
   `docs/releases/`.
4. Copy production-style compose files, real env files, and the release
   manifest to the target hosts.
5. Run `scripts/validate-production-env.sh` and the relevant preflight script on
   each host.
6. Run the deploy helper with `--dry-run`, then run it without `--dry-run`.
7. On the control-plane host, let `scripts/deploy-control-plane-host.sh` run the
   candidate image's one-shot `rend-api migrate` service.
8. Let the control-plane helper start the inactive API slot, verify private
   `/readyz` and `/healthz`, then promote Caddy to the candidate slot.
9. Start `rend-edge` nodes with unique `REND_EDGE_ID`, `REND_EDGE_REGION`,
   API-reachable `REND_EDGE_BASE_URL`, cache volume, and telemetry spool volume.
10. Start or update `rend-media-worker` with `REND_API_AUTO_MIGRATE=false`.
11. Run `scripts/verify-first-host-deploy.sh` with a provided `hls_ready` asset
    to confirm edge registration, signed playback, and telemetry analytics.
12. Run `bun run playback:readiness -- --target configured --skip-local-stack`
    or pass `--run-readiness-gate` to the verifier before promoting traffic.

The production GitHub workflow runs the first-host verifier when
`run_first_host_verifier=true`. It first verifies edge registry rows from the
control-plane host with `scripts/verify-edge-registry-over-ssh.sh`, using the
host's deployed `/etc/rend/rend-api.env` instead of a separate GitHub
`DATABASE_URL`. It then rewrites private edge targets through SSH tunnels before
running API/edge health, ClickHouse, and public deny checks with
`scripts/verify-first-host-deploy.sh --skip-registration`.
When `REND_VERIFY_ASSET_ID` or `verify_asset_id` points at an existing
synthetic/non-customer `hls_ready` asset, the verifier also runs warmed
playback and analytics checks. If no asset id is configured, the workflow runs
the verifier with `--skip-playback` and relies on the synthetic playback
readiness gate for upload, playback, and telemetry proof.

## Rollback Basics

Roll back services in dependency order from the edge inward:

1. Roll back `rend-edge` first if playback cache behavior regresses.
2. Roll back `rend-media-worker` if artifact generation or warming regresses.
3. Roll back `rend-api` last. For the control plane, prefer
   `scripts/deploy-control-plane-host.sh --rollback` to switch Caddy back to the
   previous slot without pulling or rebuilding. Treat Postgres migrations as
   forward-only unless a tested rollback migration exists.

For a production rollback drill in GitHub Actions, run the workflow manually
with `verify_control_plane_rollback=true`. The workflow switches Caddy back to
the previous control-plane slot, verifies public `/readyz`, then deploys the
current digest manifest again to re-promote the candidate slot.

Edge cache can be purged or discarded during rollback. Telemetry spool files can
be retained for replay or deleted if the ingest contract changed incompatibly.

## Edge Region Config

US East and London edge nodes differ only by environment and attached volumes:

- `REND_EDGE_ID`
- `REND_EDGE_REGION`
- `REND_EDGE_BASE_URL`
- host port or load balancer target
- local cache volume
- local telemetry spool volume

The same `rend-edge` image and command run in both regions.

## Residual SPOFs

The blue/green control-plane transaction prevents a failed deploy, failed
candidate, failed Caddy reload, or failed post-promotion check from taking down
the currently serving API process. It does not remove single-host or
single-daemon failure modes. A kernel panic, VM outage, host network loss, disk
failure, Docker daemon failure, or Caddy process failure on the control-plane
host can still cause downtime. The current edge model is resilient only at the
multi-edge operational level; each individual edge host still updates
`rend-edge` in place.
