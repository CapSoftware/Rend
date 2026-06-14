# @rend/sdk

Generated TypeScript client for the Rend public OpenAPI contract.

Source contract: `docs/openapi/rend-public-api.openapi.json`

Generate and verify:

```bash
bun run openapi:generate
bun run openapi:check
```

Minimal local upload and embed flow:

```bash
REND_API_KEY=rend_test_or_live_key \
REND_API_BASE_URL=http://127.0.0.1:4000 \
REND_SITE_BASE_URL=http://127.0.0.1:3000 \
bun packages/sdk/examples/upload-and-embed.ts
```

The example uploads `fixtures/media/rend-fixture.mp4`, waits for a playable
asset state, fetches the site playback bootstrap, prints a tokenless `<video>`
embed, and deletes the asset.

Local integration smoke:

```bash
bun run sdk:integration-smoke
```

The smoke creates or uses a local Rend API key, uploads the synthetic fixture,
checks playback bootstrap and embed paths, fetches analytics, deletes the asset,
and verifies playback is unavailable after deletion.
