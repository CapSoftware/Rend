<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/rend-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/rend-logo-light.svg">
  <img alt="Rend" src=".github/assets/rend-logo-light.svg" width="220">
</picture>

### Video infrastructure, built for speed

One API call to upload. One Rend playback URL. First bytes warmed on
Rend's bare-metal edge. And we're open source.

[**Rend.so**](https://rend.so)

![Status](https://img.shields.io/badge/status-under_construction-E8590C)
![Server](https://img.shields.io/badge/server-AGPL--3.0-2F6FED)
![Player & SDKs](https://img.shields.io/badge/player_%26_SDKs-MIT-2F6FED)

</div>

---

> [!NOTE]
> Rend is being built in public. Features become official as they are linked from [Rend.so](https://rend.so).

## What is Rend?

Rend is the video platform for developers. POST a video, get back a playback URL. Upload, encoding, storage, delivery, cookie-backed signed playback, analytics, player and SDKs, one coherent surface instead of five services taped together.

Our thesis is simple: latency is round trips, not server time. So Rend deletes round trips, places bytes physically near viewers before they ask, and owns the playback path from cache to viewer.

## The infrastructure

Rend Cloud serves video through bare-metal playback edge nodes backed by durable
storage. Rend controls the playback URL and pre-places the opening seconds of
each video on edge-local RAM and NVMe/SSD.

Cloud shape:

| Concern | Rend Cloud v1 |
|---|---|
| API and state | Rust control plane with Postgres metadata |
| Uploads | One-call upload path |
| Origin | S3-compatible object storage, Tigris by default |
| Encoding | ffmpeg workers generate opener, thumbnail, and HLS playback |
| Edge | Bare-metal `rend-edge` nodes in US East and London with local RAM/NVMe/SSD cache |
| Routing | Rend playback URLs routed by GeoDNS, latency DNS, or regional routing |
| Authorization | Signed playback URLs or tokens validated locally at the edge |
| Analytics | Playback request analytics for request counts, bytes, region, status, and cache state |
| Resilience | Origin or CDN backup path without exposing provider URLs |

## v1

Video on demand, built around fast startup:

- [ ] **Upload API**: POST a video, receive a playback URL. One call deep.
- [ ] **Fast opener path**: generate a playable opener early in the upload pipeline
- [ ] **Rend edge playback**: warm openers and first segments to US East and London
- [ ] **Origin-backed cache**: stream cache misses from durable object storage
- [ ] **HLS playback**: opener first, adaptive renditions after that
- [ ] **Drop-in player** with page-load prefetch
- [ ] **Signed playback**: tokens validated locally at the edge
- [ ] **Playback request analytics**: request counts, bytes, status, region, cache state
- [ ] **SDKs and an MCP server**, generated from one OpenAPI spec
- [ ] **Measured speed**: baseline upload-to-playable and first-frame metrics

Rend Cloud v1 is video on demand. Pricing uses two minute-based meters:
delivery and storage. Encoding is included. 4K starts in supported regions or
approved accounts while delivery economics are measured.

## In this repo

- [`apps/site/`](./apps/site) — the landing page at Rend.so, Next.js and Tailwind v4
- [`services/rend-api/`](./services/rend-api) — Rust control-plane API skeleton
- [`services/rend-edge/`](./services/rend-edge) — Rust playback edge skeleton
- [`crates/`](./crates) — shared Rust crates
- [`migrations/`](./migrations) — Postgres migrations for Rend-owned metadata
- [`clickhouse/`](./clickhouse) — ClickHouse schema for raw playback request telemetry
- [`compose.yml`](./compose.yml) — local Postgres, ClickHouse, MinIO, and Redis
- [`packages/`](./packages) — shared packages for future apps and services
- [`docs/openapi/rend-public-api.openapi.json`](./docs/openapi/rend-public-api.openapi.json) — canonical public OpenAPI contract
- [`packages/sdk/`](./packages/sdk) — generated TypeScript public API client

## Develop

This repo uses Bun workspaces and Turborepo.

```bash
bun install
bun dev
```

Use `bun run build` for production builds and `bun typecheck` for TypeScript.
`bun build` is Bun's native bundler command, so it does not run the package
script.

Public API contract and SDK commands:

```bash
bun run openapi:lint
bun run openapi:generate
bun run openapi:check
bun run openapi:contract
bun run openapi:sdk-test
```

The generated TypeScript client lives at [`packages/sdk/`](./packages/sdk) and
is generated from the single OpenAPI source file under `docs/openapi/`.

Before public V1 deploy or promotion, run the launch gate:

```bash
bun run launch:gate
```

The checklist, modes, artifacts, and failure triage live in
[`docs/launch-gate-v1.md`](./docs/launch-gate-v1.md).

Root env files are loaded by explicit profile through
`scripts/with-root-env.mjs` and `crates/rend-config`.
Copy `.env.local.example` to `.env.local` for local-only secrets and run
`bun run env:local` before starting services. `.env.local` must use
`REND_ENV=local` and must not point at production providers.

Production secrets do not go in `.env.local`. Use `.env.production.local` for
local production-targeted checks, or host/platform env vars for real deploys;
production env must use `REND_ENV=production`. See
[`docs/env/profiles.md`](./docs/env/profiles.md).

### Local backend foundation

This starts the V1 foundation: Postgres, ClickHouse, MinIO, Redis, migrations,
health-checking API/edge skeletons, the raw source upload storage path, local
async media artifact generation for uploaded sources, and minimal playback
request telemetry.

Local media processing requires `ffmpeg` and `ffprobe` on `PATH`, or explicit
binary paths in `REND_FFMPEG_PATH` and `REND_FFPROBE_PATH`. Uploads enqueue
Postgres-backed media jobs by default; run the media worker locally with
`cargo run -p rend-api -- worker media` or `bun run backend:media-worker`.
Set `REND_API_INLINE_MEDIA_PROCESSING=true` only when you explicitly want the
old synchronous dev behavior. Worker ffmpeg runs are bounded by
`REND_MEDIA_PROCESS_TIMEOUT_SECS`.
Playback URLs are signed with `REND_PLAYBACK_SIGNING_KEY_ID`,
`REND_PLAYBACK_SIGNING_SECRET`, and `REND_PLAYBACK_TOKEN_TTL_SECS`; API and edge
processes must use the same key id and secret. The local player bootstrap
returns up to `REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS` first HLS segment
hints, defaulting to `2`.
Edges can register with the API via `REND_CONTROL_PLANE_URL`; API and worker
warm/purge calls fan out to healthy rows in `rend.edge_nodes`. The
`REND_EDGE_WARM_URL` and `REND_EDGE_PURGE_URL` settings are local fallback
targets when no healthy registry edge is active.
Raw playback request telemetry is stored in ClickHouse, not
`rend.asset_events`. Postgres remains the source of truth for assets, artifacts,
jobs, lifecycle events, deletion state, and other control-plane state. Edge
telemetry is sent asynchronously through a bounded queue and local JSONL spool;
telemetry failures must not fail or materially delay playback. Analytics queries
dedupe by `event_id` because ClickHouse does not enforce uniqueness.

```bash
cp .env.local.example .env.local
bun run env:local
bun dev
cargo check --workspace
```

`bun dev` starts the local Docker backend and then the site. To run the Rust
services directly instead of Docker, use separate terminals:

```bash
bun run backend:api
bun run backend:media-worker
bun run backend:edge
```

Verify health and readiness:

```bash
curl http://127.0.0.1:4000/healthz
curl http://127.0.0.1:4000/readyz
curl http://127.0.0.1:4100/healthz
curl http://127.0.0.1:4100/readyz
curl -H 'x-rend-internal-token: dev-internal-token' http://127.0.0.1:4100/metrics
```

Smoke-test local media artifact generation:

```bash
bun run backend:smoke:async-media
bun run backend:smoke:media
bun run backend:smoke:signed-playback
bun run backend:smoke:playback-bootstrap
bun run backend:smoke:playback-telemetry
bun run backend:smoke:edge-coalescing
bun run backend:smoke:asset-events
bun run backend:smoke:lifecycle-sse
bun run backend:smoke:delete-purge
```

The smoke flow starts local dependencies, checks `ffmpeg -version` and
`ffprobe -version`, generates a fixture video with ffmpeg, starts `rend-api` if
needed, uploads the fixture with `Authorization: Bearer <REND_DEV_API_KEY>`, and
verifies:

- the API upload response is honest with `source_state = uploaded`,
  `playable_state = not_playable`, and no playback URL before media processing
- a queued `rend.media_jobs` row is claimed by the local media worker
- Postgres has source, opener, thumbnail, manifest, and segment artifact rows
- the media job ends in `succeeded` after artifact generation
- generated MinIO objects exist with nonzero byte sizes

The async media smoke also proves queued work survives a worker restart before
processing starts. The playback bootstrap smoke starts `rend-edge` if needed,
checks that `GET /v1/assets/<asset_id>/playback` returns 404 until the worker
marks the asset playable, verifies the signed primary, opener, manifest, and
first segment hint URLs through `rend-edge`, and confirms the local player
harness is served.

The asset events smoke starts `rend-api` and `rend-edge` if needed, uploads a
fixture, checks `GET /v1/assets/<asset_id>`, checks
`GET /v1/assets/<asset_id>/events`, verifies ordered lifecycle events and
`after_sequence` polling, and confirms unauthenticated and unknown-asset
requests are rejected.

The lifecycle SSE smoke opens authenticated `GET /v1/events`, uploads a
fixture, verifies durable lifecycle frames through media processing and edge
warming, and reconnects with `Last-Event-ID` to prove replay resumes after the
sequence cursor.

The delete/purge smoke uploads and processes a fixture, fetches signed opener,
manifest, and segment URLs to populate the local cache, deletes the asset,
verifies repeat DELETE idempotency, confirms new playback bootstrap returns
404, checks durable deletion and purge lifecycle events, verifies cached
playback files were removed, deletes Rend-owned origin objects, and proves
already-issued signed edge URLs cannot refill the cache after a successful
delete.

The edge coalescing smoke uploads and processes a fixture, fetches a signed
opener URL from playback bootstrap, purges that opener from the edge cache,
launches concurrent cold requests for the same URL, and verifies one `MISS`, at
least one `COALESCED`, identical nonempty bodies, and a later `HIT`.

The playback telemetry smoke starts Postgres, ClickHouse, Redis, MinIO, the API,
the edge, and the media worker; uploads a fixture; waits for HLS playback;
fetches the signed manifest twice; waits for the edge queue/flusher; and verifies
`GET /v1/assets/<asset_id>/analytics/playback` reports deduped request, byte,
`HIT`, `MISS`, and `200` status aggregates. It does not assert watch time,
startup success, viewer identity, or billing-grade accuracy.

Run the local playback benchmark separately from smoke tests:

```bash
bun run backend:benchmark:local
```

The benchmark starts or reuses the same local compose dependencies, API, edge,
and media worker, generates small and medium fixture videos, uploads each
fixture, waits for HLS playback, and records baseline timings for the Playback
Edge V1 path. It prints a human-readable table and writes machine-readable JSON
to `.rend/benchmarks/playback-edge-local-<timestamp>.json` by default.

The JSON includes git SHA when available, dirty state, host, timestamp, fixture
size and duration, cache-state handling, service reuse/startup state, selected
non-secret environment settings, and secret presence booleans. It records the
current baseline only; there are no performance thresholds and it is not part of
the smoke suite.

Useful benchmark overrides:

```bash
REND_BENCHMARK_FIXTURES=small bun run backend:benchmark:local
REND_BENCHMARK_OUTPUT=.rend/benchmarks/my-run.json bun run backend:benchmark:local
REND_BENCHMARK_COALESCING_CONCURRENCY=32 bun run backend:benchmark:local
```

Edge cache behavior:

- `rend-edge` validates signed playback tokens from an HttpOnly playback cookie
  or legacy query token locally before cache lookup, coalescing, origin fetch,
  or cache file I/O. The playback hot path does not call Postgres or the
  control plane.
- `X-Rend-Cache: HIT` means the response was served from an existing local
  cache file.
- `X-Rend-Cache: MISS` means this request led the cold fill, fetched from the
  S3-compatible origin, and wrote the local cache through a temp file followed
  by rename.
- `X-Rend-Cache: COALESCED` means this request waited for an in-flight fill for
  the same validated cache key and then served the filled local cache file.
- Cold fills are coalesced per playback artifact. Different artifacts fill
  independently and do not wait behind a single global origin lock.
- `REND_EDGE_MAX_IN_FLIGHT_FILLS` bounds distinct concurrent cold fills. The
  default is `64`, the hard max is `1024`, and new distinct fills above the
  limit fail fast with HTTP 503 while same-artifact waiters may still join the
  existing fill.
- Current cold fills still buffer the origin object before writing the cache and
  serving the response. True stream-while-writing cache fill remains a follow-up.

Playback telemetry behavior:

- `rend-edge` emits one request event for each public playback artifact request
  after the auth/cache/origin outcome is known.
- Events include `event_id`, `observed_at`, `asset_id`, `artifact_path`,
  `edge_id`, `region`, `cache_status`, `status_code`, `bytes_served`,
  `content_type`, `duration_ms`, and optional `error_code`.
- Events never include signed URL query strings, tokens, authorization headers,
  cookies, full request headers, full URLs, or client IPs.
- `GET /v1/assets/<asset_id>/analytics/playback` returns bounded-window,
  `event_id`-deduped aggregates only: request count, bytes served, cache status
  counts, status code counts, first seen, and last seen.

Manual upload, bootstrap, and local playback:

```bash
fixture=$(scripts/generate-fixture-video.sh)

curl -i -X POST http://127.0.0.1:4000/v1/videos \
  -H 'authorization: Bearer dev-api-key' \
  -H 'content-type: video/mp4' \
  --data-binary @"$fixture"

response=$(
  curl -s -X POST http://127.0.0.1:4000/v1/videos \
    -H 'authorization: Bearer dev-api-key' \
    -H 'content-type: video/mp4' \
    --data-binary @"$fixture"
)
echo "$response"

asset_id=$(printf '%s' "$response" | jq -r .asset_id)
object_key=$(printf '%s' "$response" | jq -r .source_object_key)

curl -s http://127.0.0.1:4000/v1/assets/$asset_id \
  -H 'authorization: Bearer dev-api-key' | jq

# Repeat until playable_state is hls_ready.
curl -s http://127.0.0.1:4000/v1/assets/$asset_id \
  -H 'authorization: Bearer dev-api-key' | jq

curl -s http://127.0.0.1:4000/v1/assets/$asset_id/events \
  -H 'authorization: Bearer dev-api-key' | jq

curl -s http://127.0.0.1:4000/v1/assets/$asset_id/playback \
  -H 'authorization: Bearer dev-api-key' | jq

# Delete is authenticated and idempotent. It marks rend.assets.deleted_at,
# deletes Rend-owned origin objects for the asset, and asks healthy registered
# edges, or the fallback purge URL, to purge cached playback bytes.
curl -s -X DELETE http://127.0.0.1:4000/v1/assets/$asset_id \
  -H 'authorization: Bearer dev-api-key' | jq

# New bootstrap/token issuance is blocked after deletion.
curl -i http://127.0.0.1:4000/v1/assets/$asset_id/playback \
  -H 'authorization: Bearer dev-api-key'

after_sequence=$(
  curl -s http://127.0.0.1:4000/v1/assets/$asset_id/events \
    -H 'authorization: Bearer dev-api-key' | jq -r '.next_after_sequence // 0'
)

curl -s "http://127.0.0.1:4000/v1/assets/$asset_id/events?after_sequence=$after_sequence&limit=25" \
  -H 'authorization: Bearer dev-api-key' | jq

# In another terminal, observe the durable lifecycle stream. Each SSE frame uses
# rend.asset_events.sequence as its id and rend.asset_events.event_type as its
# event name.
curl -N http://127.0.0.1:4000/v1/events \
  -H 'authorization: Bearer dev-api-key' \
  -H 'accept: text/event-stream'

# Optional asset filter. Unknown well-formed asset ids simply stream no events.
curl -N "http://127.0.0.1:4000/v1/events?asset_id=$asset_id" \
  -H 'authorization: Bearer dev-api-key' \
  -H 'accept: text/event-stream'

# Replay after a durable sequence cursor. Last-Event-ID takes precedence over
# after_sequence when both are present.
curl -N "http://127.0.0.1:4000/v1/events?after_sequence=$after_sequence" \
  -H 'authorization: Bearer dev-api-key' \
  -H 'accept: text/event-stream'

curl -N "http://127.0.0.1:4000/v1/events?after_sequence=0" \
  -H 'authorization: Bearer dev-api-key' \
  -H "Last-Event-ID: $after_sequence" \
  -H 'accept: text/event-stream'

# Edge purge is an internal operation protected by x-rend-internal-token. With
# artifact_paths omitted or empty, rend-edge removes supported local playback
# cache files under videos/<asset_id>/.
curl -s -X POST http://127.0.0.1:4100/internal/purge \
  -H 'x-rend-internal-token: dev-internal-token' \
  -H 'content-type: application/json' \
  --data "{\"asset_id\":\"$asset_id\"}" | jq

# To purge a bounded explicit list instead:
curl -s -X POST http://127.0.0.1:4100/internal/purge \
  -H 'x-rend-internal-token: dev-internal-token' \
  -H 'content-type: application/json' \
  --data "{\"asset_id\":\"$asset_id\",\"artifact_paths\":[\"opener.mp4\",\"hls/master.m3u8\"]}" | jq

# Deletion blocks new bootstrap responses and future token issuance, removes
# Rend-owned origin objects, and purges local edge-cache bytes. Already-issued
# playback cookies or legacy signed URLs should fail after successful delete
# instead of refilling edge cache from origin.

open "http://127.0.0.1:4000/player?asset_id=$asset_id"

docker compose exec postgres psql -U rend -d rend -c "
select a.id, a.source_state, a.playable_state, ar.kind, ar.id as artifact_id,
       ar.object_key, ar.content_type, ar.byte_size
from rend.assets a
join rend.artifacts ar on ar.asset_id = a.id
where a.id = '$asset_id'::uuid
order by ar.kind, ar.object_key;
"

docker compose run --rm --entrypoint /bin/sh minio-init -c "
  mc alias set local http://minio:9000 rend_minio rend_minio_password >/dev/null &&
  mc stat local/rend-local/$object_key &&
  mc stat local/rend-local/videos/$asset_id/opener.mp4 &&
  mc stat local/rend-local/videos/$asset_id/thumbnail.jpg &&
  mc stat local/rend-local/videos/$asset_id/hls/master.m3u8
"
```

Useful maintenance commands:

```bash
docker compose ps
bun run backend:down
```

## License

The server will be AGPL-3.0. The player and SDKs will be MIT.

---

<div align="center">

Built by [Cap Software](https://cap.so), the company behind Cap, the open source screen recorder.

**Rend.so** · **Rend.sh** · **Rend.video**

</div>
