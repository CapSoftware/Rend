# Rend Edge Host Runbook V1

This runbook prepares the Docker deployment shape for initial us-east and
london production edge host deployments. It does not provision cloud resources,
DNS, anycast, Terraform, Kubernetes, Better Auth, billing, or dashboard
surfaces.

The local source of truth is still `compose.yml` and `.env.docker.example`.
The production-style examples in this runbook keep the same service names,
container ports, health endpoints, internal tokens, cache paths, and telemetry
paths used by the local Docker stack.

## Current Deployment Shape

- `rend-api`: control-plane HTTP API on container port `4000`. It owns
  migrations, upload ingest, asset state, playback bootstrap, the
  `rend.edge_nodes` registry, best-effort edge warm/purge fanout, and playback
  telemetry ingest into ClickHouse.
- `rend-media-worker`: same API binary started as `rend-api worker media`. It
  claims media jobs, runs `ffmpeg`/`ffprobe`, writes artifacts to object
  storage, and asks healthy registered edges to warm artifacts.
- `rend-edge`: playback edge on container port `4100`. It validates signed
  playback tokens locally, fills a node-local cache from object storage, exposes
  `/internal/warm` and `/internal/purge`, exposes token-protected `/metrics`,
  registers and heartbeats with `rend-api` when `REND_CONTROL_PLANE_URL` is set,
  and spools telemetry to local disk before sending it to `rend-api`.

`rend.edge_nodes` is the source of registered edge nodes. API and media worker
warm/purge fanout targets every row with `status='healthy'`, a non-empty
`base_url`, and a fresh heartbeat. Leave `REND_EDGE_WARM_URL` and
`REND_EDGE_PURGE_URL` unset in normal production; they are single-edge
fallbacks for local/dev or emergency debugging.

## Minimum Edge Host Requirements

These are initial production minimums for one `rend-edge` process. They are not final
capacity targets.

| Concern | Minimum | Preferred for production |
| --- | --- | --- |
| CPU | 4 dedicated x86_64 vCPU | 8 vCPU |
| RAM | 8 GiB | 16 GiB |
| Cache disk | 250 GiB local SSD/NVMe | 500 GiB to 1 TiB NVMe |
| Telemetry spool | 10 GiB persistent SSD | 20 GiB separate filesystem |
| Logs | 5 GiB retained by Docker logging | 20 GiB or external drain |
| Network | 1 Gbps NIC, low jitter | 10 Gbps NIC or provider equivalent |
| OS | Debian 12 or Ubuntu 24.04 LTS | Same, current kernel updates applied |
| Runtime | Docker Engine 25+ with Compose v2 | Docker Engine 26+ with Compose v2.26+ |

Bandwidth assumptions for initial production deployments:

- The edge should have enough egress for real playback tests without rate
  limiting. Assume public playback can burst to the NIC line rate.
- Origin/object-store egress must tolerate cold cache fills and explicit warm
  operations. A single cold request may pull the full requested artifact before
  it is served from cache.
- API telemetry traffic is small compared with playback, but it must be
  reliable. If the API telemetry endpoint is unavailable, the edge spools JSONL
  events locally until it can replay them.
- DNS and NTP outbound access must work. Playback tokens are time-bound, so
  clock skew will look like playback authorization failure.

Recommended disk layout:

```text
/opt/rend/edge.compose.yml              # compose template copy
/etc/rend/rend-edge.env                 # region-specific edge env
/var/lib/rend/edge-cache                # node-local SSD/NVMe cache
/var/spool/rend/edge-telemetry          # persistent telemetry JSONL spool
/var/log/rend                           # optional host log drain target
```

Mount `/var/lib/rend/edge-cache` on the fastest local disk. Use ext4 or XFS
with `noatime` if the provider allows it. Keep the telemetry spool on persistent
storage; cache files may be discarded, but spooled telemetry should survive
service restarts and image rollbacks.

`rend-edge` exposes an internal-only cache inspection endpoint for proving that
specific hot playback bytes are present on the node-local cache filesystem:

```sh
curl -fsS \
  -H "x-rend-internal-token: $REND_EDGE_INTERNAL_TOKEN" \
  "https://$REND_EDGE_PRIVATE_HOSTNAME/internal/cache/inspect?asset_id=$ASSET_ID&artifact_path=hls%2Fsegment_00000.ts"
```

The response is intentionally redacted. It includes the requested
`artifact_path`, whether that artifact exists in the local cache, its byte size,
edge id, region, cache mount target/source/fstype, optional block device and
rotational flag, and `inferred_storage_tier` (`nvme`, `ssd`, or `unknown`). It
does not return signed URLs, playback tokens, auth headers, object keys, raw
cache keys, full cache paths, cookies, or internal upstream endpoints. Use this
alongside playback response headers such as `x-rend-cache: HIT` to distinguish
"served from this edge cache" from "the cache filesystem is backed by NVMe/SSD."

The Docker image runs as uid/gid `10001`. Before first start:

```sh
sudo mkdir -p /opt/rend /etc/rend /var/lib/rend/edge-cache /var/spool/rend/edge-telemetry /var/log/rend
sudo chown -R 10001:10001 /var/lib/rend /var/spool/rend
```

If production env files are installed root-only under `/etc/rend`, run the
operator validators and preflights with `sudo` rather than weakening secret
file permissions. When `psql` runs as root against a Postgres URL that requires
CA verification, the operator scripts normalize `sslrootcert=system` out of the
URL for `psql` probes. If the host libpq setup still requires a CA file, add a
root trust reference:

```sh
sudo mkdir -p /root/.postgresql
sudo ln -sf /etc/ssl/certs/ca-certificates.crt /root/.postgresql/root.crt
sudo chmod 700 /root/.postgresql
```

## Firewall And Network Ports

This section covers public playback, private/internal endpoints, metrics, and
outbound origin/API telemetry.

All endpoints currently share the edge service port inside the container
(`4100`). For production exposure, bind the Docker publish address to loopback
or a private interface and put Caddy or an equivalent reverse proxy in front of
the container. Public browser media should enter through that `443` edge ingress
on signed `/v/...` paths. Direct public `4100` exposure is disabled by default
and requires an explicit `REND_EDGE_PUBLISH_ADDR` override plus
`scripts/preflight-edge-host.sh --allow-direct-edge-exposure`; use that only for
short production debugging with known test client IPs.

| Direction | Port | Source | Destination | Purpose |
| --- | --- | --- | --- | --- |
| Inbound public | TCP `443` | Viewers/test clients | Edge proxy | Signed playback paths under `/v/...`; optionally `/healthz` and `/readyz`. Requires allowed Rend origins for credentialed browser CORS. |
| Inbound debugging-only | TCP `4100` | Known test client IPs | `rend-edge` | Direct playback while debugging only. Requires the explicit direct-exposure preflight override. |
| Inbound private | TCP `4100` or private `443` | Control plane/VPN only | `rend-edge` | `/internal/warm`, `/internal/purge`, and `/metrics`. Requires `x-rend-internal-token`. |
| Metrics | TCP `4100` or private `443` | Monitoring/VPN only | `rend-edge` | `GET /metrics`; token-protected by the service and should also be network-restricted. |
| Outbound origin | TCP `443` | `rend-edge` | S3-compatible endpoint | Artifact fills and origin readiness checks. |
| Outbound control plane | TCP `443` or private `4000` | `rend-edge` | `rend-api` internal edge endpoints | `POST /internal/edges/register` and `/internal/edges/heartbeat`. |
| Outbound telemetry | TCP `443` or private `4000` | `rend-edge` | `rend-api` telemetry endpoint | `POST /internal/telemetry/playback`. |
| Outbound image pull | TCP `443` | Host Docker daemon | Container registry | Deploy and rollback image pulls. |
| Outbound platform | UDP/TCP `53`, UDP `123` | Host | DNS and NTP | Name resolution and token clock correctness. |

Control-plane host exposure:

- Public or private API ingress should terminate on `rend-api` port `4000`
  through a proxy. The template binds `4000` to `127.0.0.1` by default.
- `POST /internal/edges/register` and `/internal/edges/heartbeat` must be
  reachable from edge hosts and must require `x-rend-internal-token`.
- `POST /internal/telemetry/playback` must be reachable from edge hosts and
  must require `x-rend-internal-token` or `x-rend-telemetry-token`.
- Postgres, Redis, ClickHouse, and object storage are external dependencies for
  production deployments and are not included in the production-style compose
  templates.

For the first Latitude production shape, bind Rend services to loopback and let Caddy
own public TLS. Checked Caddy templates live in:

- `docs/templates/control-plane.Caddyfile`
- `docs/templates/edge-host.Caddyfile`

The control-plane template exposes `api.rend.so` for the public `/v1/*` API and
`/readyz`, blocks `/internal/*` on that public hostname, and allows only
configured edge source IPs to `/internal/*` on `api-internal.play.rend.so`.
The edge template has a public hostname that blocks `/internal/*` and
`/metrics`, proxies only canonical lowercase UUID playback paths, and returns
`404` for `/v/probe`, non-UUID `/v/*`, and every other path. It also has a
private hostname for `/internal/*`, `/metrics`, `/healthz`, and `/readyz`
restricted by source IP.

Set Caddy environment with space-separated source IP lists before reloading:

```sh
export REND_PUBLIC_API_HOSTNAME=api.rend.so
export REND_CONTROL_PLANE_HOSTNAME=api-internal.play.rend.so
export REND_CONTROL_PLANE_ALLOWED_EDGE_IPS="152.236.8.67 206.223.236.177 127.0.0.1 ::1"
export REND_EDGE_PUBLIC_HOSTNAME=ash-1.play.rend.so
export REND_EDGE_PRIVATE_HOSTNAME=ash-1-private.play.rend.so
export REND_EDGE_ALLOWED_PRIVATE_IPS="152.236.8.67 10.0.0.0/8 127.0.0.1 ::1"
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Use the edge hostname for each region, for example `ams-1.play.rend.so` on the
Amsterdam host. Keep host firewalls closed by default and allow only SSH, HTTP,
and HTTPS inbound:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 4000/tcp
sudo ufw deny 4100/tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw --force enable
```

## Volume Paths

| Service | Container path | Host path | Notes |
| --- | --- | --- | --- |
| `rend-edge` | `/var/lib/rend/edge-cache` | `/var/lib/rend/edge-cache` | Local cache. Safe to purge or replace during rollback. |
| `rend-edge` | `/var/spool/rend/edge-telemetry` | `/var/spool/rend/edge-telemetry` | JSONL spool at `playback-events.jsonl`. Preserve across restarts. |
| `rend-edge` | Docker logs | Docker `json-file` or host log drain | Template rotates at `100m` x `5`. |
| `rend-api` | Docker logs | Docker `json-file` or host log drain | Inspect for migrations, readiness, telemetry ingest. |
| `rend-media-worker` | Docker logs | Docker `json-file` or host log drain | Inspect for job claims, ffmpeg failures, warm failures. |

## Env Var Sets

Example files:

- API: `docs/env/rend-api.env.example`
- Worker: `docs/env/rend-media-worker.env.example`
- us-east edge: `docs/env/rend-edge-us-east.env.example`
- london edge: `docs/env/rend-edge-london.env.example`

Secrets in these files are placeholders. Production values must come from the
host or deployment platform and must not be committed.

API required set:

- Data dependencies: `DATABASE_URL`, `REND_REDIS_URL`, `CLICKHOUSE_URL`,
  `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`,
  `OBJECT_STORE_HEALTH_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- API/runtime: `REND_API_BIND_ADDR`, `REND_API_AUTO_MIGRATE`,
  `REND_API_INLINE_MEDIA_PROCESSING`, `REND_SITE_INTERNAL_TOKEN`,
  `REND_HTTP_TIMEOUT_SECS`
- Playback: `REND_PLAYBACK_BASE_URL`, `REND_PLAYBACK_COOKIE_DOMAIN`,
  `REND_PLAYBACK_SIGNING_KEY_ID`, `REND_PLAYBACK_SIGNING_SECRET`,
  `REND_PLAYBACK_TOKEN_TTL_SECS`, `REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS`
- Edge registry/fanout: `REND_EDGE_INTERNAL_TOKEN`,
  `REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS`, `REND_EDGE_WARM_MAX_ARTIFACTS`,
  `REND_EDGE_CORS_ALLOWED_ORIGINS`.
  `REND_EDGE_WARM_URL` and `REND_EDGE_PURGE_URL` are optional fallback-only
  overrides and should be unset for normal production fanout.
- Telemetry ingest/analytics: `REND_INTERNAL_TELEMETRY_TOKEN`,
  `REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES`,
  `REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH`,
  `REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS`,
  `REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS`
- Media config loaded by the API binary: `REND_FFMPEG_PATH`,
  `REND_FFPROBE_PATH`, `REND_MEDIA_PROCESS_TIMEOUT_SECS`,
  `REND_MEDIA_JOB_MAX_ATTEMPTS`, `REND_MEDIA_WORKER_POLL_INTERVAL_SECS`,
  `REND_MEDIA_JOB_LOCK_TIMEOUT_SECS`

Worker required set:

- Same data dependency, object storage, playback signing, edge internal, and
  telemetry values as the API.
- Worker-specific values: `REND_API_AUTO_MIGRATE=false`,
  `REND_API_INLINE_MEDIA_PROCESSING=false`, `REND_MEDIA_WORKER_ID`,
  `REND_MEDIA_WORKER_POLL_INTERVAL_SECS`, `REND_MEDIA_JOB_LOCK_TIMEOUT_SECS`,
  `REND_MEDIA_PROCESS_TIMEOUT_SECS`, `REND_FFMPEG_PATH`,
  `REND_FFPROBE_PATH`.

Edge required set:

- Object storage: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- Region identity: `REND_EDGE_ID`, `REND_EDGE_REGION`
- Runtime and volumes: `REND_EDGE_BIND_ADDR`, `REND_EDGE_CACHE_DIR`,
  `REND_EDGE_TELEMETRY_SPOOL_DIR`, `REND_HTTP_TIMEOUT_SECS`
- Control plane: `REND_CONTROL_PLANE_URL`, `REND_EDGE_BASE_URL`,
  `REND_EDGE_HEARTBEAT_INTERVAL_SECS`, optional `REND_EDGE_CACHE_MAX_BYTES`
- Origin health: `REND_EDGE_ORIGIN_HEALTH_URL`
- Internal auth and limits: `REND_EDGE_INTERNAL_TOKEN`,
  `REND_EDGE_WARM_MAX_ARTIFACTS`, `REND_EDGE_MAX_IN_FLIGHT_FILLS`
- Telemetry: `REND_EDGE_TELEMETRY_ENABLED`,
  `REND_EDGE_TELEMETRY_INGEST_URL`, `REND_INTERNAL_TELEMETRY_TOKEN`,
  `REND_EDGE_TELEMETRY_QUEUE_CAPACITY`,
  `REND_EDGE_TELEMETRY_BATCH_SIZE`,
  `REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS`,
  `REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS`,
  `REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES`
- Playback signing: `REND_PLAYBACK_SIGNING_KEY_ID`,
  `REND_PLAYBACK_SIGNING_SECRET`

us-east edge values should set `REND_EDGE_REGION=us-east`, a unique
`REND_EDGE_ID`, and an API-reachable `REND_EDGE_BASE_URL`, for example
`rend-edge-us-east-001` and `https://edge-us-east.example.com`. London should
set `REND_EDGE_REGION=london`, a unique `REND_EDGE_ID`, and its own
`REND_EDGE_BASE_URL`, for example `rend-edge-london-001` and
`https://edge-london.example.com`. Both regions must share the same playback
signing key and `REND_EDGE_INTERNAL_TOKEN` as the API for a given production deployment.
Set `REND_ENV=production` for hosted production deployments. The API, worker, and every edge
host must share the same `REND_EXPECTED_EDGES` list in
`edge_id=region=https://base-url` format; registration and warm/purge fanout
reject rows that do not match this list. Leave
`REND_ALLOW_INSECURE_EDGE_URLS=false` for hosted production deployments.

## Compose Templates

Production-style templates are checked in under `docs/templates/`:

- `docs/templates/control-plane.compose.yml`
- `docs/templates/edge-host.compose.yml`
- `docs/templates/control-plane.Caddyfile`
- `docs/templates/edge-host.Caddyfile`

Build production images from a clean git worktree before bootstrapping or deploy:

```sh
bun run release:images -- \
  --tag production-001 \
  --registry registry.example.com/rend \
  --manifest .rend/releases/production-001.json \
  --platform linux/amd64 \
  --push
```

Use the manifest `image_digest` values for compose image variables. They are
immutable deploy and rollback refs. The human `production-*` tag is only an operator
label for finding the release. Pushed releases also copy the accepted non-secret
manifest to `docs/releases/` so operators can recover the exact digest refs and
platform metadata later.

Before copying the manifest to hosts, verify release image metadata locally:

```sh
scripts/check-docker-image-versions.sh --tag production-001 --registry registry.example.com/rend --strict
```

For GHCR or another authenticated registry, log in as the same Unix user that
will run the operator commands. Docker CLI credentials are per user. If deploys
or preflights run with `sudo`, root also needs credentials:

```sh
docker login ghcr.io
sudo docker login ghcr.io
```

On the hosted production hosts, both `ubuntu` and `root` needed GHCR pull readiness
because operators used both non-root and `sudo` Docker commands. Run the
preflight without `--dry-run` before deploy or rollback; it now pulls each
manifest `image_digest` ref so credential or registry-scope problems fail
before Compose changes running containers. It also verifies manifest and pulled
image OS/architecture against the host expectation, `linux/amd64` by default.
Pass `--expected-platform` only when deploying to an intentionally different
host architecture.

Control-plane host bootstrap:

```sh
sudo mkdir -p /opt/rend /etc/rend
sudo cp docs/templates/control-plane.compose.yml /opt/rend/control-plane.compose.yml
sudo cp docs/templates/control-plane.Caddyfile /etc/caddy/Caddyfile
sudo cp docs/env/rend-api.env.example /etc/rend/rend-api.env
sudo cp docs/env/rend-media-worker.env.example /etc/rend/rend-media-worker.env
sudoedit /etc/rend/rend-api.env /etc/rend/rend-media-worker.env

scripts/validate-production-env.sh --role control-plane
scripts/preflight-control-plane-host.sh --manifest .rend/releases/production-001.json
scripts/deploy-control-plane-host.sh --manifest .rend/releases/production-001.json --dry-run
scripts/deploy-control-plane-host.sh --manifest .rend/releases/production-001.json
```

Edge host bootstrap:

```sh
sudo mkdir -p /opt/rend /etc/rend /var/lib/rend/edge-cache /var/spool/rend/edge-telemetry
sudo chown -R 10001:10001 /var/lib/rend /var/spool/rend
sudo cp docs/templates/edge-host.compose.yml /opt/rend/edge.compose.yml
sudo cp docs/templates/edge-host.Caddyfile /etc/caddy/Caddyfile
sudo cp docs/env/rend-edge-us-east.env.example /etc/rend/rend-edge.env
sudoedit /etc/rend/rend-edge.env

scripts/validate-production-env.sh --role edge-host
scripts/preflight-edge-host.sh --manifest .rend/releases/production-001.json
scripts/deploy-edge-host.sh --manifest .rend/releases/production-001.json --dry-run
scripts/deploy-edge-host.sh --manifest .rend/releases/production-001.json
```

Use `sudo` for these commands when `/etc/rend/*.env` is root-only.

For london, use `docs/env/rend-edge-london.env.example` and keep the same edge
compose template. The live edge preflight performs idempotent
`/internal/edges/register` and `/internal/edges/heartbeat` calls with the
configured edge id so it can prove the control-plane contract before the
container starts. Use `--dry-run` to skip those mutating probes.

## Remote Edge Health And Smoke Commands

Set these variables from the operator laptop or a bastion. `EDGE_INTERNAL_BASE`
should use a private address or VPN path when available.

```sh
API_BASE=https://api.rend.so
EDGE_BASE_US_EAST=https://edge-us-east.example.com
EDGE_BASE_LONDON=https://edge-london.example.com
EDGE_INTERNAL_US_EAST=http://10.0.10.12:4100
EDGE_INTERNAL_LONDON=http://10.0.20.12:4100
REND_API_KEY=replace-me
REND_EDGE_INTERNAL_TOKEN=replace-me
ASSET_ID=00000000-0000-0000-0000-000000000000
```

Run the combined verifier first. It checks API `/readyz`, private edge
`/readyz`, all expected edge registrations, public deny surfaces on each edge,
warmed `HIT` signed playback through every public edge, telemetry analytics
increasing, no telemetry dropped-counter increase, and spool bytes returning to
`0`. The verifier reads `DATABASE_URL`, `CLICKHOUSE_URL`,
`CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` from
`--api-env` when provided. For laptop or bastion runs without `/etc/rend`
access, pass those values explicitly with `--database-url`, `--clickhouse-url`,
`--clickhouse-database`, `--clickhouse-user`, and `--clickhouse-password`.
The verifier normalizes `sslrootcert=system` out of `DATABASE_URL` only for
`psql` probes; the service env file remains unchanged.

```sh
scripts/verify-first-host-deploy.sh \
  --api-base "$API_BASE" \
  --edge-base "$EDGE_BASE_US_EAST" \
  --edge-internal-base "$EDGE_INTERNAL_US_EAST" \
  --edge-base "$EDGE_BASE_LONDON" \
  --edge-internal-base "$EDGE_INTERNAL_LONDON" \
  --api-env /etc/rend/rend-api.env \
  --edge-env /etc/rend/rend-edge.env \
  --asset-id "$ASSET_ID" \
  --rewrite-playback-base
```

Use the manual checks below when the combined verifier identifies a failing
step or when running from a laptop that cannot read the host env files.

Health and readiness:

```sh
curl -fsS "$EDGE_BASE/healthz"
curl -fsS "$EDGE_BASE/readyz"
```

`/healthz` on API and edge includes `service`, `version`,
`package_version`, `git_sha`, and `build_time`. Compare those values with the
release manifest after deploy.

If the repo checkout is available on the host, inspect running container image
metadata:

```sh
scripts/inspect-docker-release.sh --all
scripts/check-docker-image-versions.sh --running
```

Metrics auth check. The first command should return `401`; the second should
return Prometheus text including `rend_edge_up`, `rend_edge_ready`,
`rend_edge_cache_requests_total`, `rend_edge_in_flight_fills`,
`rend_edge_active_streamed_fills`, `rend_edge_cache_evictions_total`,
`rend_edge_cache_evicted_bytes_total`, `rend_edge_cache_eviction_errors_total`,
`rend_edge_telemetry_events_total`, and `rend_edge_telemetry_spool_bytes`.

```sh
curl -sS -o /tmp/rend-edge-metrics-unauth.body -w "%{http_code}\n" "$EDGE_INTERNAL_BASE/metrics"
curl -fsS -H "x-rend-internal-token: $REND_EDGE_INTERNAL_TOKEN" "$EDGE_INTERNAL_BASE/metrics"
```

Control-plane registration check from the control-plane host:

```sh
psql "$DATABASE_URL" -c \
  "SELECT edge_id, region, base_url, status, last_heartbeat_at FROM rend.edge_nodes ORDER BY edge_id"
```

Fetch a signed playback token from the API for a known `hls_ready` asset:

```sh
curl -fsS \
  -H "authorization: Bearer $REND_API_KEY" \
  "$API_BASE/v1/assets/$ASSET_ID/playback" \
  -o /tmp/rend-playback-bootstrap.json

TOKEN="$(
  python3 - /tmp/rend-playback-bootstrap.json <<'PY'
import json, sys
from urllib.parse import parse_qs, urlparse
with open(sys.argv[1], "r", encoding="utf-8") as f:
    url = json.load(f)["playback_url"]
print(parse_qs(urlparse(url).query)["token"][0])
PY
)"
```

Direct edge warm endpoint check:

```sh
curl -fsS \
  -X POST "$EDGE_INTERNAL_BASE/internal/warm" \
  -H "x-rend-internal-token: $REND_EDGE_INTERNAL_TOKEN" \
  -H "content-type: application/json" \
  --data "{\"asset_id\":\"$ASSET_ID\",\"artifact_paths\":[\"hls/master.m3u8\",\"hls/720p/index.m3u8\",\"hls/720p/segment_00000.ts\",\"hls/720p/segment_00001.ts\",\"hls/1080p/index.m3u8\",\"hls/1080p/segment_00000.ts\",\"hls/1080p/segment_00001.ts\"]}"
```

With the default `REND_EDGE_WARM_MAX_ARTIFACTS=16`, the control plane can warm
the HLS master, every generated variant playlist, and the first two media
segments for each generated `720p`/`1080p`/`2k`/`4k` tier.

Registry fanout check. After an upload reaches `hls_ready`, the asset lifecycle
events should include `edge.warming_succeeded` with an `edges` array listing
each healthy registered edge and its per-edge status.

```sh
curl -fsS \
  -H "authorization: Bearer $REND_API_KEY" \
  "$API_BASE/v1/assets/$ASSET_ID/events?limit=100"
```

Signed playback check:

```sh
SIGNED_MANIFEST="$EDGE_BASE/v/$ASSET_ID/hls/master.m3u8?token=$TOKEN"
curl -fsS -D /tmp/rend-edge-playback.headers -o /tmp/rend-edge-master.m3u8 "$SIGNED_MANIFEST"
grep -i '^x-rend-cache:' /tmp/rend-edge-playback.headers
test -s /tmp/rend-edge-master.m3u8
```

Telemetry flush check:

```sh
curl -fsS -o /dev/null "$SIGNED_MANIFEST"
sleep 5
curl -fsS \
  -H "authorization: Bearer $REND_API_KEY" \
  "$API_BASE/v1/assets/$ASSET_ID/analytics/playback?window_seconds=600"
```

If analytics does not show recent playback, inspect the edge spool:

```sh
ssh edge-us-east 'docker compose -f /opt/rend/edge.compose.yml exec -T rend-edge sh -lc "ls -lh /var/spool/rend/edge-telemetry && wc -l /var/spool/rend/edge-telemetry/playback-events.jsonl 2>/dev/null || true"'
```

The spool file may be absent when telemetry has flushed successfully.

If a single malformed or semantically invalid JSONL line is blocking replay,
quarantine only that line and preserve the rest:

```sh
ssh edge-us-east 'sudo scripts/quarantine-telemetry-spool-lines.sh \
  --spool /var/spool/rend/edge-telemetry/playback-events.jsonl \
  --lines 17'
```

Use `--dry-run` first when identifying line numbers. The script writes a backup
next to the spool and appends quarantined raw records to
`playback-events.quarantine.jsonl`. New edge builds also quarantine malformed or
permanently rejected replay records automatically while preserving valid
records.

## Deploy Steps

Control-plane deploy:

```sh
sudoedit /etc/rend/rend-api.env /etc/rend/rend-media-worker.env
scripts/validate-production-env.sh --role control-plane
scripts/preflight-control-plane-host.sh --manifest .rend/releases/production-004.json
scripts/deploy-control-plane-host.sh --manifest .rend/releases/production-004.json --dry-run
scripts/deploy-control-plane-host.sh --manifest .rend/releases/production-004.json
curl -fsS http://127.0.0.1:4000/readyz
docker compose -f /opt/rend/control-plane.compose.yml ps
```

Edge deploy:

```sh
sudoedit /etc/rend/rend-edge.env
scripts/validate-production-env.sh --role edge-host
scripts/preflight-edge-host.sh --manifest .rend/releases/production-004.json
scripts/deploy-edge-host.sh --manifest .rend/releases/production-004.json --dry-run
scripts/deploy-edge-host.sh --manifest .rend/releases/production-004.json
curl -fsS http://127.0.0.1:4100/readyz
curl -fsS -H "x-rend-internal-token: $REND_EDGE_INTERNAL_TOKEN" http://127.0.0.1:4100/metrics
```

After each deploy, run the remote health and smoke commands above. For a
multi-edge production deployment, verify each registered edge appears in
`rend.edge_nodes`, the warm lifecycle event includes every healthy edge, each
edge can serve a warmed `HIT`, and at least one cold `MISS` still works after a
targeted purge.

## Rollback Steps

Edge rollback:

```sh
scripts/deploy-edge-host.sh --manifest .rend/releases/production-001.json --dry-run
scripts/deploy-edge-host.sh --manifest .rend/releases/production-001.json
curl -fsS http://127.0.0.1:4100/readyz
```

Control-plane rollback:

```sh
scripts/deploy-control-plane-host.sh --manifest .rend/releases/production-001.json --dry-run
scripts/deploy-control-plane-host.sh --manifest .rend/releases/production-001.json
curl -fsS http://127.0.0.1:4000/readyz
```

Rollback order:

1. Roll back `rend-edge` first for playback cache, token validation, origin, or
   telemetry-spool regressions.
2. Roll back `rend-media-worker` for ffmpeg, artifact-generation, or warm-call
   regressions.
3. Roll back `rend-api` last. Treat Postgres migrations as forward-only unless
   a tested rollback migration exists.

Do not delete `/var/spool/rend/edge-telemetry` during rollback unless the
telemetry ingest contract changed incompatibly. It is safe to purge
`/var/lib/rend/edge-cache` if cache contents are suspected bad.

## Logs And Metrics Guidance

API logs to inspect:

- Startup migration failures when `REND_API_AUTO_MIGRATE=true`
- `/readyz` dependency failures for Postgres, Redis, or object storage
- Upload errors and asset state transitions
- Edge warm/purge fanout lifecycle events, including per-edge status summaries
- Telemetry ingest failures, especially ClickHouse insert/query errors

Worker logs to inspect:

- Media job claim and completion cadence
- `ffmpeg`/`ffprobe` failures and timeout errors
- Jobs that reach max attempts
- Warm-call failures after artifact generation

Edge logs to inspect:

- Startup bind address, edge id, and region
- Control-plane registration or heartbeat failures
- Cache directory permission or disk errors
- `/readyz` origin failures
- Playback `401`, `404`, timeout, and origin fetch errors
- `too many in-flight edge cache fills`
- `failed to send playback telemetry batch; spooling locally`
- `playback telemetry spool is full; dropping event`

Current metric and counter signals:

- Edge `/metrics`: `rend_edge_up` and `rend_edge_ready`
- Edge cache counters:
  `rend_edge_cache_requests_total{cache_status="HIT|MISS|COALESCED|error"}`
  and `rend_edge_in_flight_fills`
- Edge cache eviction and streaming signals:
  `rend_edge_active_streamed_fills`, `rend_edge_cache_evictions_total`,
  `rend_edge_cache_evicted_bytes_total`, and
  `rend_edge_cache_eviction_errors_total`
- Edge telemetry counters:
  `rend_edge_telemetry_events_total{state="queued|sent|spooled|dropped"}`
  and `rend_edge_telemetry_spool_bytes`
- Playback response header: `X-Rend-Cache` with `HIT`, `MISS`, or `COALESCED`
- Warm response summary: `warmed`, `already_warm`, `not_found`, `failed`
- API playback analytics:
  `GET /v1/assets/<asset_id>/analytics/playback?window_seconds=...`
  returns `request_count`, `bytes_served`, `cache_status_counts`, and
  `status_code_counts`
- Telemetry health: edge spool file size and line count under
  `/var/spool/rend/edge-telemetry/playback-events.jsonl`
- Origin health: edge `/readyz` origin check plus playback `error_code` values
  in analytics for non-2xx responses

For initial production deployments, alert manually on any sustained `rend_edge_ready=0`, rising
spool size, `not_found` or `failed` warm summaries, elevated playback 5xx/401,
or a cache mix that stays mostly `MISS` after warm operations.

The production cache safety gate bounds upload size, origin artifact size,
cache free-space reserve, and optional cache size. Cold playback misses use
stream-while-write: origin bytes go to the viewer while the edge writes an
atomic cache file. Cache pressure evicts lower-priority old deep-tail artifacts
before manifests and first segments. `HIT`, `MISS`, and `COALESCED` response
header semantics are unchanged.

## Local Validation

Run the checked-in validator before using the examples:

```sh
scripts/validate-edge-deploy-templates.sh
```

Exercise the operator harness against the local Docker env example without
touching managed dependencies or host ports:

```sh
scripts/validate-production-env.sh --role all --allow-dev-defaults \
  --api-env .env.docker.example \
  --worker-env .env.docker.example \
  --edge-env .env.docker.example

scripts/preflight-control-plane-host.sh --dry-run --allow-dev-defaults \
  --allow-local-image-refs \
  --manifest .rend/releases/production-001.json \
  --api-env .env.docker.example \
  --worker-env .env.docker.example \
  --compose-file docs/templates/control-plane.compose.yml

scripts/preflight-edge-host.sh --dry-run --allow-dev-defaults \
  --allow-local-image-refs \
  --manifest .rend/releases/production-001.json \
  --edge-env .env.docker.example \
  --compose-file docs/templates/edge-host.compose.yml
```

Then run the local Docker smoke:

```sh
bun run backend:docker:smoke
```

The local smoke still uses `compose.yml` and `.env.docker.example`. The
production-style templates intentionally omit local Postgres, Redis, MinIO, and
ClickHouse because production host deployments should point at managed or separately
provisioned dependencies.
