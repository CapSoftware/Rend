# Rend landing page

The Rend marketing site, built with Next.js and Tailwind CSS v4.

## Develop

```bash
bun install
bun dev
```

Then visit http://localhost:3000.

From the repo root, `bun dev` starts the local Docker backend and then the
Next.js site. Use `bun run dev:site` when the backend is already running or you
intentionally want the site only.

For production builds, run `bun run build` from the repo root. Site commands
use the root env wrapper: `next dev` loads the `local` profile, while
`next build` and `next start` load the `production` profile and never read
root `.env.local`.

From the app workspace directly:

```bash
bun --filter @rend/site dev
```

## Player telemetry

The embed and watch players post player startup telemetry to
`/api/player/telemetry`. This data is separate from edge request telemetry and is
not billing-grade watch accounting. Recent sanitized events are available at
`/api/player/telemetry/recent` on localhost and non-production builds; set
`REND_PLAYER_TELEMETRY_DEBUG=1` to expose that JSON endpoint for a hosted environment
debug session.

## Dashboard assets

Sign in or create an account at `/login`, then use the asset dashboard at
`/dashboard/assets`. Dashboard routes use Better Auth email OTP sessions backed
by Postgres. Local development seeds `admin@rend.test` into a local organization,
allows new email OTP sign-ups, auto-creates a workspace on first dashboard access,
and logs OTP codes to the server console when `RESEND_API_KEY` is not configured.
Production self-serve signup must set `REND_SELF_SERVE_SIGNUP_ENABLED=true`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` or `REND_AUTH_BASE_URL`,
`REND_AUTH_TRUSTED_ORIGINS`, `RESEND_API_KEY`, `REND_AUTH_EMAIL_FROM`,
`REND_AUTH_OTP_PROBE_EMAIL`, `REND_SITE_INTERNAL_TOKEN`, and Autumn billing env.
Run `bun run launch:auth-otp-diagnostics` for a non-mutating production auth
config and DB-table check. Add `-- --probe-email ops-test@example.com` to send
one real self-serve OTP request through `/api/auth`; artifacts redact emails,
provider keys, cookies, headers, and OTP/code values.

The site keeps all Rend API calls server-side, scopes dashboard data by active
organization, and exposes only sanitized asset, analytics, startup telemetry,
and tokenless playback proxy data to the browser. Owner/admin users can manage
org API keys at `/dashboard/api-keys` after billing readiness; API keys are shown
once, stored hashed, and scoped to upload/read/delete/analytics permissions. The
local full-flow check is:

```bash
bun run e2e:site-assets
```

Do not put server-only tokens or API keys in `NEXT_PUBLIC_*`; those values are
client bundle values.

## Deploy

Deploy on Vercel with the project Root Directory set to `apps/site`. No other
configuration is needed.

## Structure

- `app/page.tsx` — the whole page, including the hand drawn SVG sketches
- `app/globals.css` — Tailwind theme tokens plus the sketch and loop animations
- `components/Effects.tsx` — scroll reveal and reduced motion handling
