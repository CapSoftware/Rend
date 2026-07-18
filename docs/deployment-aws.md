# AWS deployment and self-hosting

Rend supports two deployment shapes from the same images and application code:

- Rend-hosted production: CloudFront, an internal ALB, ECS Fargate, external
  private Tigris buckets, PlanetScale PostgreSQL, and ClickHouse on encrypted
  EC2/EBS. Terraform is under `infra/aws`.
- Self-hosted: Docker Compose with PostgreSQL, ClickHouse, MinIO, the API, one
  media worker, one edge, the Rend site, and Caddy as one front door.

Neither path requires Redis. The API database queue is the single media queue.

## One-command self-host

Requirements are Docker Engine with Compose v2 and enough disk for source
videos, generated renditions, ClickHouse, and the edge cache.

```bash
scripts/selfhost.sh init
scripts/selfhost.sh up
```

`init` creates the ignored `.env.docker` with mode `0600` and generates the
database, object-storage, application, playback, and authentication secrets.
`up` also initializes automatically when needed, validates the merged Compose
model, builds all images, and waits for health checks. The default front door
is `http://localhost:8080`; Caddy routes the site, `/v1/*` API requests, and
`/v/*` playback requests on that single origin. Direct multipart uploads use
`http://uploads.localhost:8080`, which the same Caddy instance routes to
private MinIO without sending bytes through the API. Direct troubleshooting
ports remain available on the host loopback interface:

- Site: `http://localhost:3000`
- API: `http://localhost:4000`
- Playback edge: `http://localhost:4100`
- MinIO API/console: `http://localhost:9100` / `http://localhost:9101`
- ClickHouse HTTP: `http://localhost:8123`

Useful commands:

```bash
scripts/selfhost.sh status
scripts/selfhost.sh logs
scripts/selfhost.sh doctor
scripts/selfhost.sh down
```

Verify the public front door, direct multipart path, worker, playback edge,
telemetry, and deletion together after startup or restore:

```bash
node scripts/smoke-selfhost-public.mjs
```

Scale media concurrency without changing the application topology:

```bash
docker compose --env-file .env.docker \
  -f compose.yml -f compose.selfhost.yml \
  up -d --scale rend-media-worker=4
```

Persistent Docker volumes are not removed by `down`. Back them up before host
maintenance. `docker compose down -v` intentionally remains a manual,
destructive operation.

By default the one-command path builds the checked-out source. To use a pinned
published release instead, set all four `REND_API_IMAGE`, `REND_WORKER_IMAGE`,
`REND_EDGE_IMAGE`, and `REND_SITE_IMAGE` values to GHCR digest references.
`selfhost.sh up` then pulls those images and disables local builds.

For a real domain, set these in `.env.docker` before `up` and put the included
Caddy front door behind your HTTPS ingress:

```dotenv
REND_SELFHOST_SITE_URL=https://rend.example.com
REND_SELFHOST_API_URL=https://api.rend.example.com
REND_SELFHOST_PLAYBACK_URL=https://video.rend.example.com
REND_SELFHOST_UPLOADS_HOST=uploads.rend.example.com
REND_SELFHOST_UPLOADS_URL=https://uploads.rend.example.com
BETTER_AUTH_SECRET=replace-with-a-long-random-secret
```

Route the site/playback hostnames and the uploads hostname to Caddy. The
uploads hostname must reach Caddy without a path prefix so MinIO can validate
the presigned request path. Only Caddy's public port should be exposed;
database, MinIO, API, edge, and site troubleshooting ports bind to loopback.

MinIO initialization keeps both buckets private. The MinIO server-wide CORS
allowlist permits browser PUT/HEAD requests for multipart uploads. The legacy
raw `POST /v1/videos` upload remains
available for SDKs and stream inputs that cannot be split into retryable parts.

### Self-host backup and restore

Keep `.env.docker` in an encrypted secrets backup. Back up application data
independently so one damaged service does not invalidate the others:

```bash
mkdir -p backups/postgres backups/clickhouse backups/minio
backup_name="rend-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose --env-file .env.docker -f compose.yml -f compose.selfhost.yml \
  exec -T postgres pg_dump -U rend -d rend -Fc > backups/postgres/rend.dump
docker compose --env-file .env.docker -f compose.yml -f compose.selfhost.yml \
  exec -T clickhouse sh -c "clickhouse-client --user rend --password \"\$CLICKHOUSE_PASSWORD\" --query \"BACKUP DATABASE rend TO Disk('backups', '$backup_name')\""
docker cp "$(docker compose --env-file .env.docker -f compose.yml -f compose.selfhost.yml ps -q clickhouse):/var/lib/clickhouse/backups/$backup_name" backups/clickhouse/
docker run --rm --entrypoint /bin/sh --env-file .env.docker --network rend-selfhost_default \
  -v "$PWD/backups/minio:/backup" minio/mc:latest \
  sh -c 'mc alias set source http://minio:9000 "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" && mc mirror source/ /backup/'
```

Restore PostgreSQL before starting the API, restore both private MinIO buckets
before enabling uploads or playback, then restore ClickHouse. Run
`scripts/selfhost.sh doctor` and an upload-to-delete smoke test before exposing
the restored host. Volume-level snapshots are acceptable only when all four
data services are stopped consistently.

## Rend-hosted production

The production architecture has no direct public ALB and no NAT gateway:

1. CloudFront and WAF accept API and playback traffic.
2. A CloudFront VPC Origin reaches the internal ALB over HTTPS. The ALB reaches
   loopback-bound API/edge containers through task-local TLS proxies on 8443.
3. ALB path rules send `/v/*`, `/embed-fast/*`, warm, and purge requests to a
   two-task edge service. Other public routes go to the two-task API service.
4. Browsers upload multipart parts directly to the private Tigris source bucket.
5. Fargate workers stream source ranges through the task-local range proxy into
   ffmpeg instead of staging the full source. They use 100 GiB ephemeral space
   for generated work and write completed media directly to Tigris. Worker
   count is bounded from one to ten tasks. Every attempt writes immutable
   `videos/{asset}/attempts/{lease}/...` objects; PlanetScale atomically maps
   stable public artifact paths to the winning physical keys. The edge resolves
   that mapping over its authenticated control-plane connection and reads media
   directly from Tigris, so video bytes never transit the API and a stale worker
   cannot overwrite a winner's objects.
6. API, edge, and worker access PlanetScale over TLS. ClickHouse stays inside
   the VPC and is reached through the internal ALB's validated HTTPS hostname.
7. CloudFront requires trusted-key-group signed cookies for `/v/*`; no
   authorization cookie value is part of the cache key. A positive cache-policy
   minimum gives immutable playback objects a one-year CloudFront TTL after
   authorization. On a CloudFront origin miss, the edge reauthorizes cached
   disk bytes through a lightweight per-asset API availability check but avoids
   a Tigris HEAD. Positive availability is cached for five seconds and concurrent
   segment checks for the same asset are coalesced. Cold logical-to-physical
   resolutions are cached for five minutes in a bounded 10,000-entry LRU cache;
   per-asset purge fencing cannot abort an unrelated asset fill and clears that
   asset's mappings and bytes.
8. Deletion and suspension enqueue CloudFront invalidations in PlanetScale in
   the same transaction as the state change. API tasks lease the durable jobs,
   reuse stable caller references, retry submission with a bounded five-minute
   backoff, and poll every five seconds until CloudFront reports `Completed`.
   Signed cookies expire after 15 minutes; the edge's positive availability
   fallback is bounded to five seconds after an edge receives its purge.

Default hard ceilings are API 2-6 tasks, edge 2-6, workers 1-10, 50 videos and
10 open uploads per organization, and two active media jobs per organization.
API and edge tasks have 0.5 vCPU/1 GiB. Each worker has 4 vCPU, 8 GiB memory,
and 100 GiB ephemeral storage. The Rend-tag-filtered AWS alert budget defaults
to $400/month and ClickHouse starts with 100 GiB encrypted gp3. Raising any
ceiling is a reviewed cost-capacity decision.

The account is shared, so the GitHub role cannot mutate IAM, launch EC2, or
create general infrastructure. It can pass only the fixed Rend ECS task roles;
autoscaling writes are limited to the exact target ARNs enrolled after the
administrator bootstrap. Activate the `Application` cost allocation tag
before setting `rend_cost_allocation_tag_active=true`; otherwise Terraform
omits only the tag-filtered Budget. The AWS Organizations management account
must activate this tag when Rend runs in a linked account. Service, worker,
storage, and organization hard ceilings remain active while the Budget is
pending; set the flag true and apply again as soon as the tag is active.

CloudFront remains on pay-as-you-go pricing. Playback is authenticated and WAF
protected, while cost and abuse exposure is controlled by server-side quotas,
queue admission, and hard ECS autoscaling ceilings. Production keeps one media
worker warm and can run at most 50 workers globally; no quota or infrastructure
limit needs to be rendered in the dashboard.

The source and media buckets remain external to AWS but their full contract is
owned by Terraform. During apply, an idempotent reconciler reads Tigris
credentials directly from SSM, creates the buckets when absent, and enforces
private native access settings and ACLs plus CORS. Tigris object endpoints
accept HTTPS only, and its S3-compatible bucket-policy and
incomplete-multipart lifecycle operations are not implemented. Rend's
24-hour upload-session sweeper aborts each abandoned multipart upload and
releases its reservation. It keeps sources global for fast uploads and generated media
in `iad` beside the Fargate workers. Credential values never enter Terraform
state. CloudFront never connects directly to Tigris.

See `infra/aws/README.md` for bootstrap, prerequisites, exact Terraform commands,
migration-first deployment ordering, verification, and rollback.

## Production cutover safety

The first fenced-worker release requires a clean two-apply handoff:

1. Apply the platform with `services_enabled=false`; API, edge, worker,
   autoscaling policies, and public A/AAAA aliases remain off. Suspended
   zero-minimum autoscaling targets are created for safe exact-ARN enrollment.
2. Enroll only the emitted target ARNs into the scoped GitHub role, then run the
   additive PostgreSQL migration and the idempotent ClickHouse schema command.
   ClickHouse promotion waits for the exact schema-object ETag marker before
   the deployment workflow records the source revision in
   `/rend/production/deployment-gates/migration-ready`.
3. Drain and stop every old Latitude worker.
4. Confirm no old running media jobs remain after the 120-second lease expires.
5. Apply again with `services_enabled=true` and
   `worker_cutover_confirmed=true` for the same revision; Terraform refuses
   activation without an exact revision marker and explicit handoff
   confirmation.
   Successful public verification writes the persistent `activation-complete`
   gate, allowing later releases to migrate before task promotion without
   taking DNS or autoscaling offline.
6. Verify heartbeat/fencing behavior and run parallel multipart uploads,
   cancellation, expiry, suspension, and deletion tests.
7. Keep the aliases enabled only after API, playback, analytics, billing, and
   rollback checks pass against the AWS endpoints.

Old and new workers must not overlap during this first transition because old
workers do not understand lease fencing.

`services_enabled` remains true after first activation. It is deliberately
rejected as a shutdown toggle because autoscaling owns ECS desired counts. To
stop spend in an emergency, suspend the three
`service/rend-production/{api,edge,worker}` scalable targets at minimum zero,
then set those three Rend ECS services to desired count zero. Restore minima to
API 2, edge 2, and worker 1 before resuming. Do not remove the activation marker
or target any non-Rend cluster.
