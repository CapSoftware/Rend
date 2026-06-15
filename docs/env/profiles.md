# Rend Env Profiles

Rend has two supported env profiles:

- `local`: local development and Docker only.
- `production`: hosted production and local production-targeted checks.

`trial` is no longer an active product mode. Rust accepts it only as a
deprecated compatibility alias for `production`; examples, scripts, and docs
must use `local` or `production`.

## Local

Local secrets go in `.env.local`, copied from `.env.local.example`:

```sh
cp .env.local.example .env.local
bun run env:local
```

Rules for `.env.local`:

- `REND_ENV=local`
- `REND_BILLING_MODE=local` unless explicitly testing Autumn with a non-live
  Autumn key
- URLs must point at `localhost`, loopback, `.local`, or Docker service names
- local/dev secrets are allowed
- production provider URLs and production secrets are not allowed

Run the local Docker stack with:

```sh
bun run backend:docker:build
bun run backend:docker:up
```

The Docker stack uses local Postgres, Redis, ClickHouse, and MinIO from
`compose.yml`; it does not need production env files.

## Production

Production secrets do not go in `.env.local`.

For local production-targeted checks, copy `.env.production.example` to
`.env.production.local` and replace every placeholder:

```sh
cp .env.production.example .env.production.local
bun run env:production
bun run verify:production-local
```

For real deploys, set production secrets in the host or platform environment
instead of committing env files. `REND_ENV` must be `production`.
`REND_BILLING_MODE` must be `autumn`, and `AUTUMN_SECRET_KEY` must be provided
server-side only.

Autumn production launch checks require the live `AUTUMN_SECRET_KEY` to be in
`.env.production.local`. Keep sandbox/test Autumn keys in a separate file such as
`.env.local` and pass that file to catalog parity with
`--autumn-sandbox-env-file`; do not export a sandbox `AUTUMN_SECRET_KEY` in the
shell while running production-check.

Production validation rejects localhost/Docker service URLs, checked-in dev
defaults, placeholders, insecure edge URLs, and `REND_ENV=local`.

## Explicit Loading

Commands use `REND_ENV_PROFILE=local|production` or `REND_ENV_FILE=/path/to/env`
to choose env input. Production-profile commands never load `.env.local`.

Examples:

```sh
REND_ENV_PROFILE=local cargo run -p rend-api
REND_ENV_PROFILE=production cargo run -p rend-api
REND_ENV_FILE=.env.production.local cargo run -p rend-api
node scripts/with-root-env.mjs --profile production next build
```

`NEXT_PUBLIC_*` values are public client bundle values. Do not put tokens,
passwords, API keys, or secret-like values in `NEXT_PUBLIC_*`.
