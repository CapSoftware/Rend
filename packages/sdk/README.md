# @rend-sdk/client

Generated TypeScript client for the Rend public OpenAPI contract.

Source contract: `docs/openapi/rend-public-api.openapi.json`

Install:

```bash
npm install @rend-sdk/client
```

Generate and verify:

```bash
bun run openapi:generate
bun run openapi:check
```

Minimal self-serve upload and embed flow:

1. Sign in at `https://rend.so/login` with an email code. Rend creates your
   workspace automatically.
2. Choose a plan in the dashboard. API-key creation and billable uploads stay
   disabled until billing is ready.
3. Create an API key with `upload`, `read`, `delete`, and `analytics` scopes.

```bash
REND_API_KEY=rend_test_or_live_key \
REND_API_BASE_URL=http://127.0.0.1:4000 \
REND_SITE_BASE_URL=http://127.0.0.1:3000 \
bun packages/sdk/examples/upload-and-embed.ts
```

The example uploads `fixtures/media/rend-fixture.mp4`, waits for a playable
asset state, fetches the site playback bootstrap, prints a tokenless `<video>`
embed, and deletes the asset.

For large or resumable uploads, use `createMultipartUpload`,
`signMultipartUploadParts`, `getMultipartUpload`, and
`completeMultipartUpload`. Upload each signed part URL directly to object
storage, retain its ETag and base64 SHA-256 checksum, and call
`abortMultipartUpload` when cancelling. The legacy `uploadAsset` method remains
available for compatibility.

Local integration smoke:

```bash
bun run sdk:integration-smoke
```

The smoke creates or uses a local Rend API key, uploads the synthetic fixture,
checks playback bootstrap and embed paths, fetches analytics, deletes the asset,
and verifies playback is unavailable after deletion.

Billing and usage limits:

Uploads can fail with `RendApiError` status `403` when the organization's video
count, stored-byte allowance, or the platform storage budget has been reached.
Public V1 usage is metered as delivery seconds and storage second-months by
720p/1080p/2K/4K resolution tier. Treat a quota response as plan or capacity
state, not as a retryable transport failure.
