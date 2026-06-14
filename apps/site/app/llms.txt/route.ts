import { docsNavItems } from "../docs/docs-content";

export const dynamic = "force-static";

export function GET() {
  const lines = [
    "# Rend Docs",
    "",
    "Rend public docs for API-key asset operations and tokenless same-origin browser playback.",
    "",
    "## Primary Docs",
    "- Docs home: https://rend.so/docs",
    ...docsNavItems.map((item) => `- ${item.title}: https://rend.so/docs${item.href}`),
    "",
    "## Reference",
    "- OpenAPI JSON: https://rend.so/openapi.json",
    "- TypeScript SDK: https://github.com/CapSoftware/Rend/tree/main/packages/sdk",
    "",
    "## Notes For Agents",
    "- Use only the public paths documented at /docs and /openapi.json.",
    "- Authenticated API calls use Authorization: Bearer <Rend API key>.",
    "- Browser playback uses /api/player/{assetId} and same-origin artifact URLs.",
  ];

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
