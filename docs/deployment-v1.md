# Rend Playback Edge V1 Deployment

This document defines the V1 production shape and the local Docker topology. It
does not provision cloud resources.

For first real us-east and london edge host trials, use the operational runbook
and production-style examples in [`docs/edge-host-runbook-v1.md`](edge-host-runbook-v1.md).

## Service Topology

- `rend-api`: Rust API and control plane. It owns upload ingest, asset state,
  Postgres migrations, playback bootstrap, edge warm/purge calls, and telemetry
  ingestion into ClickHouse.
- `rend-media-worker`: the same repo runtime, started as `rend-api worker media`.
  It claims queued media jobs, uses `ffmpeg` and `ffprobe`, writes artifacts to
  S3-compatible storage, and asks the edge to warm playback artifacts.
- `rend-edge`: Rust playback edge. It validates signed playback URLs locally,
  serves playback artifacts, fills and coalesces local cache misses from object
  storage, exposes internal warm/purge endpoints, and spools playback telemetry
  locally before sending it to `rend-api`.

Production dependencies are external managed services: Postgres, Redis,
S3-compatible object storage, and ClickHouse.

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
`minio`, `clickhouse`, `rend-api`, and `rend-edge`. `REND_PLAYBACK_BASE_URL`
is the local client-facing URL and defaults to `http://127.0.0.1:4100`.

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

## Required Env Vars

API:

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
- `REND_API_AUTO_MIGRATE`
- `REND_DEV_API_KEY`
- `REND_PLAYBACK_BASE_URL`
- `REND_EDGE_WARM_URL`
- `REND_EDGE_PURGE_URL`
- `REND_EDGE_INTERNAL_TOKEN`
- `REND_INTERNAL_TELEMETRY_TOKEN`
- `REND_PLAYBACK_SIGNING_KEY_ID`
- `REND_PLAYBACK_SIGNING_SECRET`
- `REND_PLAYBACK_TOKEN_TTL_SECS`

Worker:

- all API dependency vars used for Postgres, Redis, S3, ClickHouse, playback
  signing, and edge internal auth
- `REND_API_AUTO_MIGRATE=false` after the API migration step is deployed
- `REND_MEDIA_WORKER_ID`
- `REND_MEDIA_WORKER_POLL_INTERVAL_SECS`
- `REND_MEDIA_JOB_LOCK_TIMEOUT_SECS`
- `REND_MEDIA_PROCESS_TIMEOUT_SECS`
- `REND_FFMPEG_PATH`
- `REND_FFPROBE_PATH`

Edge:

- `REND_EDGE_BIND_ADDR`
- `REND_EDGE_ID`
- `REND_EDGE_REGION`
- `REND_EDGE_CACHE_DIR`
- `REND_EDGE_ORIGIN_HEALTH_URL`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `REND_EDGE_INTERNAL_TOKEN`
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

Use `.env.example` for host development and `.env.docker.example` for Docker
service-name defaults. Production secrets must come from the deployment
platform, not checked-in env files.

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

Postgres migrations are applied by `rend-api` through SQLx when
`REND_API_AUTO_MIGRATE=true`. In local Compose, the worker waits for the API and
sets `REND_API_AUTO_MIGRATE=false` to avoid duplicate startup migration work.
For production, deploy or run the API migration step before starting workers.

ClickHouse schema is applied by the local `clickhouse-init` one-shot service on
every Compose startup. The schema uses `CREATE DATABASE IF NOT EXISTS` and
`CREATE TABLE IF NOT EXISTS`, so repeated runs are safe.

MinIO bucket creation is handled by the local-only `minio-init` one-shot
service. Production object storage should be provisioned outside this repo.

## Deploy Order

1. Provision managed Postgres, Redis, S3-compatible storage, and ClickHouse.
2. Apply or confirm ClickHouse schema.
3. Deploy `rend-api` with `REND_API_AUTO_MIGRATE=true` for the migration step.
4. Start `rend-api` serving traffic after `/readyz` passes.
5. Start `rend-edge` nodes with unique `REND_EDGE_ID`, `REND_EDGE_REGION`,
   cache volume, and telemetry spool volume.
6. Start `rend-media-worker` with `REND_API_AUTO_MIGRATE=false`.
7. Run upload/playback/telemetry smoke checks.

## Rollback Basics

Roll back services in dependency order from the edge inward:

1. Roll back `rend-edge` first if playback cache behavior regresses.
2. Roll back `rend-media-worker` if artifact generation or warming regresses.
3. Roll back `rend-api` last. Treat Postgres migrations as forward-only unless a
   tested rollback migration exists.

Edge cache can be purged or discarded during rollback. Telemetry spool files can
be retained for replay or deleted if the ingest contract changed incompatibly.

## Edge Region Config

US East and London edge nodes differ only by environment and attached volumes:

- `REND_EDGE_ID`
- `REND_EDGE_REGION`
- host port or load balancer target
- local cache volume
- local telemetry spool volume

The same `rend-edge` image and command run in both regions.
