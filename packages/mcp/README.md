# @rend-sdk/mcp

MCP server for the Rend public API. It exposes upload, asset, playback, delete,
and analytics tools for agents while keeping API keys out of tool output.

## Install

```bash
npm install -g @rend-sdk/mcp
```

Or run it with `npx` from an MCP client config.

## Configuration

Set the API key in the MCP client environment. The server reads:

- `REND_API_KEY` or `REND_MCP_API_KEY`
- `REND_API_BASE_URL` or `REND_MCP_API_BASE_URL`, default `https://api.rend.so`
- `REND_SITE_BASE_URL` or `REND_MCP_SITE_BASE_URL`, default `https://rend.so`
- `REND_MCP_MAX_UPLOAD_BYTES`, default `536870912`

The API key is never accepted as a tool argument and is not returned in tool
output.

```json
{
  "mcpServers": {
    "rend": {
      "command": "npx",
      "args": ["-y", "@rend-sdk/mcp"],
      "env": {
        "REND_API_KEY": "rend_live_...",
        "REND_API_BASE_URL": "https://api.rend.so",
        "REND_SITE_BASE_URL": "https://rend.so"
      }
    }
  }
}
```

Local development can point to local services:

```json
{
  "mcpServers": {
    "rend-local": {
      "command": "node",
      "args": ["packages/mcp/dist/bin/rend-mcp.js"],
      "env": {
        "REND_API_KEY": "rend_test_...",
        "REND_API_BASE_URL": "http://127.0.0.1:4000",
        "REND_SITE_BASE_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

## Tools

- `rend_upload_video`: upload a local MP4 or QuickTime file.
- `rend_get_asset`: fetch asset state and public artifact summaries.
- `rend_list_assets`: list assets for the API key organization.
- `rend_get_playback`: fetch tokenless playback bootstrap plus embed/watch URLs.
- `rend_delete_asset`: delete an asset.
- `rend_get_analytics`: fetch playback request analytics.

## Safety

The server uses `@rend-sdk/client`, which is generated from
`docs/openapi/rend-public-api.openapi.json`. It does not call operator or
server-only endpoints.

Before upload, the server checks the local file size and rejects detectable
non-video content. Playback output is allowlisted to public Rend, local, or
same-origin artifact URLs, and token, cookie, authorization, and signed URL
fields are redacted.

Errors are returned as stable JSON:

```json
{
  "status": "error",
  "error": {
    "code": "not_playable",
    "message": "Asset is not playable yet.",
    "asset_id": "018f52b2-5401-7f3b-ae2e-4923f4d62120"
  }
}
```

Expected codes include `not_playable`, `limit_exceeded`, `unauthorized`,
`suspended`, and `deleted`.

## Local Smoke

From the Rend repository:

```bash
bun install
bun run mcp:smoke
```

The smoke creates or uses a local scoped API key, uploads
`fixtures/media/rend-fixture.mp4` through the MCP tool, waits for a playable
asset, fetches playback, fetches analytics, deletes the asset, and checks that
tool output does not include signed playback material. By default it starts the
local Docker backend and a local site on an isolated port; set
`REND_MCP_SMOKE_SKIP_BACKEND_UP=1` or `REND_SITE_BASE_URL` to reuse running
services.
