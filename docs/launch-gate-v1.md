# Rend V1 Public Launch Gate

`bun run launch:gate` is the single pre-deploy gate for a public Rend V1
candidate. It composes the existing env, OpenAPI, SDK, site, Rust, Docker,
playback, billing, E2E, docs, and release-image checks, then writes a redacted
machine-readable artifact under `.rend/launch/`.

The gate does not deploy, promote, create live Stripe or Autumn products, or
change player behavior.

## Modes

Local mode is the default:

```sh
bun run launch:gate
```

Local mode validates local env, uses the local billing stub expectations, runs
the local Docker and smoke flows, and treats skipped release image validation as
acceptable unless a manifest or dry run is configured.

Sandbox mode uses Autumn sandbox config for catalog and customer-mapping checks:

```sh
REND_BILLING_MODE=autumn \
AUTUMN_SECRET_KEY=<sandbox key> \
AUTUMN_API_URL=https://api.useautumn.com/v1 \
bun run launch:gate -- --mode sandbox
```

Sandbox mode verifies the pay-as-you-go plan, the delivery and storage feature
IDs, their per-minute rates, and the Rend organization UUID to Autumn
`customer_id` mapping.

Production-check mode validates real production env/config without mutating live
billing:

```sh
bun run launch:gate -- --mode production-check --autumn-sandbox-env-file .env.local
```

Production-check requires `.env.production.local` to supply the live Autumn key
used as `AUTUMN_SECRET_KEY`; inherited shell keys are rejected when they differ.
Use `--production-env-file FILE` to validate a specific production env file from
any mode, but the Autumn live key check remains tied to `.env.production.local`.
Production-check also runs read-only Autumn sandbox/live catalog parity using
`--autumn-sandbox-env-file` and `--autumn-production-env-file`. It skips
mutating live/API smoke by default. Only pass `--allow-live-billing-mutation`
when an operator intentionally wants to call Autumn `customers.get_or_create`
against the configured production account.

Public self-serve readiness has its own artifact command:

```sh
bun run launch:self-serve-readiness
```

For final public V1 signoff, run it after the live dry-run and require both
artifacts:

```sh
bun run launch:production-dry-run -- --allow-production-mutation --acknowledge-real-charge
bun run launch:self-serve-readiness -- --require-dry-run --require-launch-gate
```

## Required Checks

The gate reports explicit `pass`, `warn`, or `fail` status for each group:

- env: `env:local`, `env:production:example`, loaded profile policy, and
  production env validation when supplied.
- billing: launch mode policy, Autumn catalog expectations, sandbox/live
  catalog parity, customer mapping, and billing denial smoke.
- OpenAPI: lint/generated client check and public contract tests.
- SDK: unit tests and integration smoke.
- site: tests, typecheck, build, and E2E flows.
- cargo: `cargo fmt --all -- --check`, `cargo check --workspace`, and
  `cargo test --workspace`.
- Docker: build, up, and smoke.
- playback: production readiness gate.
- docs: public docs, `llms.txt`, public OpenAPI/static leak scan.
- release: public V1 self-serve readiness artifact, plus release image manifest
  validation or dry run when configured.

Release image validation is opt-in:

```sh
bun run launch:gate -- --release-manifest .rend/releases/production-001.json
bun run launch:gate -- --release-dry-run
```

## Artifacts

Each run writes:

- `.rend/launch/launch-readiness-<run-id>.json`
- `.rend/launch/launch-readiness-latest.json`
- `.rend/launch/<run-id>/logs/<step>.log`
- `.rend/launch/self-serve-readiness-<run-id>.json` when
  `launch:self-serve-readiness` runs
- `.rend/launch/production-dry-run-<run-id>.json` when the live self-serve
  dry-run runs

The JSON is intended for both humans and agents. Every failed step includes the
redacted command log path or artifact path needed for triage.

Launch artifacts redact secret-like values, bearer tokens, cookies, signed URL
parameters, Autumn and Stripe keys, AWS keys, JWTs, and internal URLs. The gate
also scans its own launch artifacts after writing and fails if a raw secret-like
value or internal URL remains.

## Failure Triage

Start with the first failed step in `launch-readiness-latest.json`, then open
its `log_path`.

Common failures:

- `env:local`: copy `.env.local.example` to `.env.local`, keep
  `REND_ENV=local`, and avoid production provider URLs or production secrets.
- `production-env-validation`: replace placeholders, remove `REND_DEV_API_KEY`,
  set `REND_SELF_SERVE_SIGNUP_ENABLED=true`, set secure Better Auth and Resend
  config, set `REND_AUTH_OTP_PROBE_EMAIL` for the accepted OTP probe, require
  `REND_BILLING_MODE=autumn`, and set an operator email allowlist.
- `auth-otp-diagnostics`: run
  `bun run launch:auth-otp-diagnostics -- --probe-email <test-inbox>` to check
  the same OTP route directly. The default diagnostics mode is non-mutating;
  the probe sends one real OTP request and redacts emails, keys, cookies,
  headers, and OTP/code values from artifacts.
- `autumn-catalog`: run the sandbox setup helper or fix the pay-as-you-go plan
  and its two meter feature IDs before re-running the gate.
- `autumn-catalog-parity`: make production match the verified sandbox catalog in
  Autumn. Do not copy customers/subscriptions and do not create Stripe
  products/prices directly outside Autumn.
- `site:build`: production-profile env is missing or incompatible with the
  Next.js build.
- `docker:up` or `docker:smoke`: inspect Docker Compose health and service logs,
  then rerun the individual `backend:docker:*` command.
- `playback:readiness`: inspect the readiness artifact under `.rend/readiness/`
  for cache, telemetry, edge, and cleanup details.
- `billing:denial-smoke`: check the local Docker dependencies and Autumn stub
  request counts in the step log.
- `docs-static-leak-scan`: remove internal endpoints, operator paths, signed URL
  material, dev API keys, or server-only auth headers from public docs.
- `release-image-manifest`: rebuild or validate the release manifest so all
  three services include matching metadata and immutable digest refs when
  pushed.

Existing individual commands remain the source of truth for their areas and can
be run independently while fixing a failure.
