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

Rend is the video platform for developers. POST a video, get back a playback URL. Upload, encoding, storage, delivery, signed playback, analytics, player and SDKs, one coherent surface instead of five services taped together.

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
| Analytics | Playback analytics for views, watch time, startup, region, and cache state |
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
- [ ] **Playback analytics**: views, watch minutes, startup success, region, cache state
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
- [`compose.yml`](./compose.yml) — local Postgres, MinIO, and Redis
- [`packages/`](./packages) — shared packages for future apps and services

## Develop

This repo uses Bun workspaces and Turborepo.

```bash
bun install
bun dev
```

Use `bun run build` for production builds and `bun typecheck` for TypeScript.
`bun build` is Bun's native bundler command, so it does not run the package
script.

Root `.env*` files are loaded into app scripts through `scripts/with-root-env.mjs`.
Copy `.env.example` to `.env.local` for local secrets. App-specific `.env*` files
inside `apps/*` can override shared root values when a service needs its own
configuration.

### Local backend foundation

This starts the V1 foundation: Postgres, MinIO, Redis, migrations,
health-checking API/edge skeletons, the raw source upload storage path, and
local media artifact generation for uploaded sources.

Local media processing requires `ffmpeg` and `ffprobe` on `PATH`, or explicit
binary paths in `REND_FFMPEG_PATH` and `REND_FFPROBE_PATH`. Inline processing is
bounded by `REND_MEDIA_PROCESS_TIMEOUT_SECS`; keep `REND_HTTP_TIMEOUT_SECS`
larger than the media timeout when using synchronous local uploads.
Playback URLs are signed with `REND_PLAYBACK_SIGNING_KEY_ID`,
`REND_PLAYBACK_SIGNING_SECRET`, and `REND_PLAYBACK_TOKEN_TTL_SECS`; API and edge
processes must use the same key id and secret. The local player bootstrap
returns up to `REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS` first HLS segment
hints, defaulting to `2`.

```bash
cp .env.example .env.local
bun run backend:up
cargo check --workspace
```

Run the services in separate terminals:

```bash
bun run backend:api
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
bun run backend:smoke:media
bun run backend:smoke:signed-playback
bun run backend:smoke:playback-bootstrap
```

The smoke flow starts local dependencies, checks `ffmpeg -version` and
`ffprobe -version`, generates a fixture video with ffmpeg, starts `rend-api` if
needed, uploads the fixture with `Authorization: Bearer <REND_DEV_API_KEY>`, and
verifies:

- the API response includes the existing upload fields with `source_state =
  uploaded` and `playable_state = hls_ready`
- Postgres has source, opener, thumbnail, manifest, and segment artifact rows
- generated MinIO objects exist with nonzero byte sizes

The playback bootstrap smoke also starts `rend-edge` if needed, calls
`GET /v1/assets/<asset_id>/playback` with the dev API key, checks unauthenticated
and unknown asset responses, verifies the signed primary, opener, manifest, and
first segment hint URLs through `rend-edge`, and confirms the local player
harness is served.

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

curl -s http://127.0.0.1:4000/v1/assets/$asset_id/playback \
  -H 'authorization: Bearer dev-api-key' | jq

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
