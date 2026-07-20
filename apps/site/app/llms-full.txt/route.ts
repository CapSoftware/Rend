import { marketingPages } from "@/lib/marketing-pages";
import { siteDescription, siteOrigin } from "@/lib/seo";

export const dynamic = "force-static";

export function GET() {
  const lines: string[] = [
    "# Rend, full site content for LLMs",
    "",
    `> ${siteDescription}`,
    "",
    "This file contains the full plain-text content of Rend's marketing pages so language models can answer questions about Rend accurately. The canonical HTML lives at the linked URLs.",
    "",
    "## Core facts",
    "- Rend is video infrastructure for developers: one API call to upload, and one playback URL that starts fast and plays anywhere.",
    "- Encoding, storage and delivery are handled for you. Encoding is included on every upload and never appears as a separate charge.",
    "- Rend Cloud currently serves generated HLS from Tigris-backed origin by default, without requiring active edge nodes.",
    "- The bare-metal edge path remains in the codebase for future reactivation when regional coverage makes it worthwhile.",
    "- Rend is open source: the server is AGPL, the player and SDKs are MIT, and it is the exact code that runs Rend Cloud. Self-hosting is free forever, installs as one binary, and nothing phones home.",
    "- Pricing has two meters: $0.001 per delivered watch minute and $0.003 per stored video minute per month. Every resolution costs the same.",
    "- Rend Cloud is pay as you go with no base fee or lock-in.",
    "- Rend is built by Cap Software, the team behind Cap, the open source screen recorder. Cap runs entirely on Rend.",
    "- Rend is agent-ready: an llms.txt index, OpenAPI contract, generated TypeScript SDK, and copyable agent prompt help AI editors integrate it correctly.",
    "",
  ];

  for (const page of marketingPages) {
    lines.push(`## ${page.title}`);
    lines.push(`URL: ${siteOrigin}${page.path}`);
    lines.push("");
    lines.push(page.description);
    lines.push("");
    lines.push(page.summary);
    lines.push("");
    lines.push("### Frequently asked questions");
    lines.push("");
    for (const faq of page.faqs) {
      lines.push(`Q: ${faq.q}`);
      lines.push(`A: ${faq.a}`);
      lines.push("");
    }
  }

  lines.push("## Docs and reference");
  lines.push(`- Docs: ${siteOrigin}/docs`);
  lines.push(`- Agent setup: ${siteOrigin}/docs#agent-setup`);
  lines.push(`- OpenAPI contract: ${siteOrigin}/openapi.json`);
  lines.push(
    "- TypeScript SDK: https://github.com/CapSoftware/Rend/tree/main/packages/sdk",
  );
  lines.push(`- llms.txt index: ${siteOrigin}/llms.txt`);
  lines.push("");

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
