<div align="center">

<img alt="Rend" src="./rend-logo.svg" width="220">

### Video infrastructure, built for speed

One API call to upload. One playback URL designed to start fast.

[**Rend.so**](https://rend.so)

![Status](https://img.shields.io/badge/status-v1_in_progress-E8590C)
![Server](https://img.shields.io/badge/server-AGPL--3.0-2F6FED)
![Player & SDKs](https://img.shields.io/badge/player_%26_SDKs-MIT-2F6FED)

</div>

## What Is Rend?

Rend is the video platform for developers: one API call to upload, one playback
URL that starts fast. Encoding, storage, delivery, signed playback, analytics,
player packages, and SDKs are handled by one open-source stack.

Rend currently serves generated HLS from Tigris-backed origin through
Rend-controlled playback URLs, so playback can start without exposing private
storage URLs. The bare-metal edge path remains in the repo, but it is dormant in
production until regional coverage makes it worthwhile.

## Performance Goals

Rend is built around startup latency, especially the first request for a video
that has not already been watched and cached everywhere.

- Minimize time to first frame, not just server response time.
- Generate a small opener during media processing so real frames can be served
  before the full HLS ladder is ready.
- Serve generated HLS from Tigris-backed origin by default while the bare-metal
  edge path stays dormant until regional coverage makes it worthwhile again.
- Keep playback credentials server-controlled: signed playback is validated
  before private origin artifacts are streamed, without exposing storage URLs.
- Measure the path with readiness and benchmark scripts covering upload
  response time, upload-to-playable timings, playback bootstrap latency,
  origin TTFB, optional edge cache behavior, and telemetry visibility.

## Current Shape

- [`apps/site/`](./apps/site) - Next.js app for the public site, docs,
  dashboard, auth, billing, and player-facing routes.
- [`services/rend-api/`](./services/rend-api) - Rust API/control plane for
  uploads, asset state, media jobs, playback bootstrap, Tigris-origin playback,
  optional edge registry, telemetry ingest, and billing hooks.
- [`services/rend-edge/`](./services/rend-edge) - Rust playback edge for signed
  playback validation, cache warm/purge, origin-backed cache fill/coalescing,
  and playback telemetry flushing. This code is currently dormant in production
  unless `REND_PLAYBACK_MODE=edge` is explicitly enabled.
- `rend-media-worker` - the `rend-api` binary running as `worker media`; claims
  queued media jobs and writes playback artifacts with `ffmpeg`/`ffprobe`.
- [`packages/player/`](./packages/player) - React/HLS player package.
- [`packages/sdk/`](./packages/sdk) - generated TypeScript public API client.
- [`migrations/`](./migrations) and [`clickhouse/`](./clickhouse) - Postgres
  and ClickHouse schema.
- [`compose.yml`](./compose.yml) - local Postgres, Redis, MinIO, ClickHouse,
  API, worker, and edge stack.

The local stack currently covers upload, queued media processing, source and
playback artifact storage, HLS/openers/thumbnails, signed playback bootstrap,
Tigris-origin playback, optional edge cache warm/purge/coalescing, API keys,
dashboard asset management, billing checks, and a generated public SDK.

## Requirements

- Bun `>=1.3.6`
- Node.js `>=20`
- Rust `1.93`
- Docker with Compose
- `ffmpeg` and `ffprobe` when running the media worker outside Docker

Some smoke scripts also expect common CLI tools such as `curl` and `jq`.

## Quick Start

```bash
cp .env.local.example .env.local
bun install
bun dev
```

`bun dev` validates the local env, starts the Docker backend, and runs the site.
The default local URLs are:

- Site: http://localhost:3000
- API: http://127.0.0.1:4000
- Edge: http://127.0.0.1:4100
- MinIO console: http://127.0.0.1:9101

Useful local commands:

```bash
bun run dev:site                 # site only, assuming backend is already up
bun run backend:docker:build     # rebuild local backend images
bun run backend:docker:up        # start backend stack and wait for health
bun run backend:down             # stop local stack
```

To run the Rust services on the host instead of the Docker service containers,
keep the local dependencies running and start each service in its own terminal:

```bash
bun run backend:api
bun run backend:media-worker
bun run backend:edge
```

## Verification

Common checks:

```bash
bun run env:local
bun run typecheck
bun run --cwd apps/site test
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
bun run openapi:check
bun run openapi:contract
bun run openapi:sdk-test
```

Representative end-to-end checks:

```bash
bun run backend:docker:smoke
bun run backend:smoke:async-media
bun run backend:smoke:playback-bootstrap
bun run backend:smoke:playback-telemetry
bun run backend:smoke:delete-purge
bun run sdk:integration-smoke
bun run e2e:site-assets
```

See [`package.json`](./package.json) for the full script list.

## API And SDK

The public API contract lives at
[`docs/openapi/rend-public-api.openapi.json`](./docs/openapi/rend-public-api.openapi.json).
The generated TypeScript client lives in [`packages/sdk/`](./packages/sdk).

```bash
bun run openapi:lint
bun run openapi:generate
bun run openapi:check
```

## Environments And Deploys

- [`docs/env/profiles.md`](./docs/env/profiles.md) - local vs production env
  loading and validation.
- [`docs/deployment-v1.md`](./docs/deployment-v1.md) - service topology,
  Docker targets, and production env surface.
- [`docs/edge-host-runbook-v1.md`](./docs/edge-host-runbook-v1.md) - edge host
  operations.
- [`docs/billing-autumn-v1.md`](./docs/billing-autumn-v1.md) - Autumn billing
  model and launch checks.
- [`docs/launch-gate-v1.md`](./docs/launch-gate-v1.md) - public V1 launch gate
  modes, artifacts, and triage.
- [`docs/release-images-v1.md`](./docs/release-images-v1.md) - release image
  build and verification flow.

For production-profile validation:

```bash
cp .env.production.example .env.production.local
bun run env:production
bun run verify:production-local
```

For a public V1 candidate:

```bash
bun run launch:gate
```

## License

The Rust server workspace is AGPL-3.0-or-later. The player and SDK packages are
MIT.
