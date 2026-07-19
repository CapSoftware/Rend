# AWS deployment and self-hosting

Rend supports two deployment shapes from the same images and application code:

- Rend-hosted production: a public API ALB, ECS Fargate, external Tigris
  storage and delivery, PlanetScale PostgreSQL, and ClickHouse on encrypted
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

The hosted architecture has no NAT gateway and no duplicate CDN:

1. `api.rend.so` reaches two API tasks through an AWS WAF-protected public
   ALB and task-local TLS proxies on port 8443.
2. `video.rend.so` is a Tigris custom domain. Tigris serves immutable
   `v/{asset}/...` playback aliases directly from its distributed object
   network, so video bytes never pass through AWS, Vercel, or a second CDN.
3. Browsers upload multipart parts directly to the private global Tigris source
   bucket. Upload bytes never pass through the API.
4. Fargate workers stream source ranges into ffmpeg instead of staging complete
   inputs. Each task has 4 vCPU, 8 GiB memory, and 100 GiB ephemeral storage.
   Attempts are immutable and a fenced PlanetScale lease alone can publish the
   winning canonical media and public playback aliases.
5. The API and workers use PlanetScale over TLS. ClickHouse remains inside the
   VPC and is reached through the internal ALB's validated HTTPS hostname.
6. The media bucket is private except for the immutable `v/*` alias prefix.
   Canonical media, processing attempts, and all source objects remain private.
   Asset UUIDs are unguessable, the public bootstrap already grants playback by
   asset ID, and deletion removes canonical and alias keys.

Default hard ceilings are API 2-6 tasks, workers 1-50, 50 non-deleted videos,
250 GiB stored data, 10 open uploads, and two active media jobs per
organization. One worker remains warm. The Rend-tag-filtered AWS alert budget
defaults to $400/month and ClickHouse starts with 100 GiB encrypted gp3.

Tigris playback is pay-as-you-go with zero egress fees. Exposure is controlled
by API authentication and WAF rules, server-side quotas, Tigris request
pricing, storage reservations, compute-budget admission, and hard ECS
autoscaling ceilings. These limits remain backend configuration, not dashboard
billing controls.

Terraform owns the external Tigris contract. Its idempotent reconciler reads
credentials directly from SSM, creates missing buckets, and enforces a private
source bucket, private canonical media, scoped public playback aliases, CORS,
locations, and the custom domain. Credential values never enter Terraform
state.

See `infra/aws/README.md` for bootstrap, prerequisites, exact Terraform commands,
migration-first deployment ordering, verification, and rollback.

## Production cutover safety

The first fenced-worker release requires a clean two-apply handoff:

1. Apply the platform with `services_enabled=false`; API and worker services,
   autoscaling policies, and the public API alias remain off. Suspended
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
stop spend in an emergency, suspend the two
`service/rend-production/{api,worker}` scalable targets at minimum zero,
then set those two Rend ECS services to desired count zero. Restore minima to
API 2 and worker 1 before resuming. Do not remove the activation marker
or target any non-Rend cluster.
