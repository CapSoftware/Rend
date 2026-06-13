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

## Deploy

Deploy on Vercel with the project Root Directory set to `apps/site`. No other
configuration is needed.

## Structure

- `app/page.tsx` — the whole page, including the hand drawn SVG sketches
- `app/globals.css` — Tailwind theme tokens plus the sketch and loop animations
- `components/WaitlistForm.tsx` — client component for the email form
- `components/Effects.tsx` — scroll reveal and reduced motion handling
- `app/api/waitlist/route.ts` — stores waitlist emails in Redis
