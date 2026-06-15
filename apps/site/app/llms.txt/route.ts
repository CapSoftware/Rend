import { marketingPages } from "@/lib/marketing-pages";
import { siteDescription, siteOrigin } from "@/lib/seo";
import { docsNavItems } from "../docs/docs-content";

export const dynamic = "force-static";

const url = (path: string) => `${siteOrigin}${path}`;

export function GET() {
  const lines = [
    "# Rend",
    "",
    `> ${siteDescription}`,
    "",
    "Rend is open source. The server is AGPL; the player and SDKs are MIT. Self-hosting is free forever, and Rend Cloud adds a managed bare-metal edge network that warms each video's opening seconds close to viewers so playback starts fast even on a cold request.",
    "",
    "## Pages",
    ...marketingPages.map((page) => `- [${page.title}](${url(page.path)}): ${page.summary}`),
    "",
    "## Docs",
    `- [Docs home](${url("/docs")}): Public API docs for uploading video, waiting for playback, embedding the player, reading analytics, and deletion.`,
    ...docsNavItems.map((item) => `- [${item.title}](${url("/docs")}${item.href}): ${item.description}`),
    "",
    "## Reference",
    `- [OpenAPI JSON](${url("/openapi.json")}): Canonical public API contract.`,
    "- [TypeScript SDK](https://github.com/CapSoftware/Rend/tree/main/packages/sdk): Generated TypeScript client.",
    `- [Full content for LLMs](${url("/llms-full.txt")}): Plain-text content of every marketing page, including all FAQs.`,
    "",
    "## Notes for agents",
    "- Use only the public paths documented at /docs and /openapi.json.",
    "- Authenticated API calls use Authorization: Bearer <Rend API key>.",
    "- Browser playback uses /api/player/{assetId} and same-origin artifact URLs.",
    "- An MCP server is available for editor integrations; see /docs.",
  ];

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
