# Rend landing page

The Rend marketing site, built with Next.js and Tailwind CSS v4.

## Develop

```bash
bun install
bun dev
```

Then visit http://localhost:3000.

For production builds, run `bun run build` from the repo root.

From the app workspace directly:

```bash
bun --filter @rend/site dev
```

## Waitlist

The waitlist form posts to `/api/waitlist`, which stores emails in a Redis set
named `waitlist`. Add a Redis database from the Vercel Marketplace (Upstash) and
the required environment variables are injected automatically:

- `KV_REST_API_URL` / `KV_REST_API_TOKEN`, or
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`

To read the list back, run `SMEMBERS waitlist` from the Upstash console.

## Player telemetry

The embed and watch players post player startup telemetry to
`/api/player/telemetry`. This data is separate from edge request telemetry and is
not billing-grade watch accounting. Recent sanitized events are available at
`/api/player/telemetry/recent` on localhost and non-production builds; set
`REND_PLAYER_TELEMETRY_DEBUG=1` to expose that JSON endpoint for a hosted environment
debug session.

## Dashboard assets

Sign in at `/login`, then use the asset dashboard at `/dashboard/assets`.
Dashboard routes and `/api/assets/*` require `REND_SITE_OPERATOR_TOKEN`; the
site keeps all Rend API calls server-side, and the browser receives only
sanitized asset, analytics, and startup telemetry data. The local full-flow
check is:

```bash
bun run e2e:site-assets
```

## Deploy

Deploy on Vercel with the project Root Directory set to `apps/site`. No other
configuration is needed.

## Structure

- `app/page.tsx` — the whole page, including the hand drawn SVG sketches
- `app/globals.css` — Tailwind theme tokens plus the sketch and loop animations
- `components/WaitlistForm.tsx` — client component for the email form
- `components/Effects.tsx` — scroll reveal and reduced motion handling
- `app/api/waitlist/route.ts` — stores waitlist emails in Redis
