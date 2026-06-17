import type { Metadata } from "next";
import type { ReactNode } from "react";
import Effects from "@/components/Effects";
import { AgentPromptButton } from "@/components/marketing/AgentPromptButton";
import { ArrowRight, GitHubMark } from "@/components/marketing/Icons";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Container } from "@/components/ui/Container";
import { agentResourceLinks } from "@/lib/agent-readiness";
import { GITHUB_URL } from "@/lib/marketing-pages";
import { ogImageSize, siteLocale, siteName } from "@/lib/seo";
import DocsCommandPalette from "../../components/DocsCommandPalette";
import DocsCopyButton from "../../components/DocsCopyButton";
import { DocsSidebarNav } from "../../components/DocsSidebarNav";
import {
  AGENT_PROMPT_CODE,
  AUTH_HEADER_CODE,
  CURL_UPLOAD_CODE,
  LOCAL_DOCKER_CODE,
  MCP_CLIENT_CONFIG_CODE,
  MCP_CURSOR_INSTALL_URL,
  MCP_INSTALL_COMMAND_CODE,
  MCP_LOCAL_CONFIG_CODE,
  MCP_SMOKE_CODE,
  PLAYBACK_BOOTSTRAP_CODE,
  QUICKSTART_SDK_CODE,
  SDK_GUIDE_CODE,
  docsCommandItems,
  docsNavItems,
} from "./docs-content";

const docsDescription =
  "Rend public API docs for uploading video, waiting for playback, embedding the player, analytics, deletion, SDK use, and MCP tools.";

export const metadata: Metadata = {
  title: "Docs",
  description: docsDescription,
  alternates: {
    canonical: "/docs",
  },
  openGraph: {
    type: "website",
    url: "/docs",
    siteName,
    locale: siteLocale,
    title: "Rend docs",
    description: docsDescription,
    images: [
      {
        url: "/opengraph-image",
        width: ogImageSize.width,
        height: ogImageSize.height,
        alt: "Rend docs",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Rend docs",
    description: docsDescription,
    images: [
      {
        url: "/twitter-image",
        width: ogImageSize.width,
        height: ogImageSize.height,
        alt: "Rend docs",
      },
    ],
  },
};

function CodeBlock({
  code,
  language,
  title,
}: {
  code: string;
  language: string;
  title: string;
}) {
  return (
    <figure className="my-6 overflow-hidden border border-line bg-card">
      <figcaption className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] font-medium text-muted">
          {title}
        </span>
        <DocsCopyButton value={code} />
      </figcaption>
      <pre
        tabIndex={0}
        className="max-h-[440px] overflow-auto bg-[#11100e] px-4 py-4 font-mono text-[12.5px] leading-[1.7] text-[#f7f2e8] outline-none [tab-size:2] focus-visible:ring-2 focus-visible:ring-ink/40 focus-visible:ring-inset"
      >
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </figure>
  );
}

function DocSection({
  id,
  label,
  title,
  children,
}: {
  id: string;
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-28">
      <p className="eyebrow mb-4">{label}</p>
      <h2
        id={`${id}-title`}
        className="font-head text-[clamp(25px,3.6vw,33px)] leading-[1.16] tracking-[-0.01em] text-ink"
      >
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

const quickstartSteps = [
  <>Sign in at <code>/login</code> with an email code. Rend creates your workspace automatically.</>,
  <>Choose a plan from the Billing page. Billable uploads and API-key creation stay disabled until billing is ready.</>,
  <>Create an API key from the Rend dashboard with <code>upload</code>, <code>read</code>, <code>delete</code>, and <code>analytics</code> scopes.</>,
  <>Upload a video with <code>POST /v1/videos</code> or <code>client.uploadAsset</code>.</>,
  <>Poll the asset until <code>playable_state</code> is <code>opener_ready</code> or <code>hls_ready</code>.</>,
  <>Fetch <code>/api/player/{"{assetId}"}</code> from the site and embed the returned same-origin source.</>,
  <>Delete the asset with <code>DELETE /v1/assets/{"{assetId}"}</code> when it is no longer needed.</>,
];

const authScopes = [
  { scope: "upload", allows: "Upload a source video." },
  {
    scope: "read",
    allows: "List assets, fetch asset details, poll lifecycle events, and bootstrap playback.",
  },
  { scope: "delete", allows: "Delete an asset and its Rend-owned origin objects." },
  { scope: "analytics", allows: "Fetch playback request analytics." },
];

const errorStates: { state: string; where: ReactNode; meaning: string }[] = [
  {
    state: "billing_required",
    where: "Dashboard API key creation returns 402",
    meaning: "The workspace needs an active plan before creating API keys.",
  },
  {
    state: "limit_exceeded",
    where: <><code>POST /v1/videos</code> returns 403</>,
    meaning: "Billing is missing, inactive, or out of plan balance before the upload body is accepted.",
  },
  {
    state: "not_playable",
    where: <><code>GET /api/player/{"{assetId}"}</code> returns 409</>,
    meaning: "The asset exists, but no opener or HLS artifact is ready yet.",
  },
  {
    state: "suspended",
    where: "API calls return 403, or asset summaries include suspension fields",
    meaning: "The asset or organization is blocked from normal API use.",
  },
  {
    state: "unauthorized",
    where: "API calls return 401",
    meaning: "The bearer API key is missing, malformed, revoked, or invalid.",
  },
  {
    state: "upload too large",
    where: <><code>POST /v1/videos</code> returns 413</>,
    meaning: "The upload exceeds the configured maximum size.",
  },
  {
    state: "deleted",
    where: "Asset reads or playback return unavailable/not found",
    meaning: "The asset was deleted; bootstrap and artifact paths should no longer play.",
  },
];

const mcpCapabilities = [
  {
    title: "Upload from local files",
    description: "Agents can send a local MP4 or QuickTime file through the public upload API.",
  },
  {
    title: "Inspect asset state",
    description: "Agents can list assets, fetch lifecycle state, and wait until playback is ready.",
  },
  {
    title: "Return playback links",
    description: "Agents can fetch tokenless bootstrap output with hosted embed and watch URLs.",
  },
  {
    title: "Clean up and measure",
    description: "Agents can delete assets and read playback request analytics with scoped keys.",
  },
];

export default function DocsPage() {
  return (
    <div className="overflow-x-clip">
      <Effects />
      <SiteHeader />
      <div className="border-b border-line bg-bg-sunken/60">
        <Container size="wide" className="py-2.5">
          <DocsCommandPalette items={docsCommandItems} />
        </Container>
      </div>

      <main>
        {/* ------------------------------- Hero ------------------------------- */}
        <section className="relative pb-10 pt-10 sm:pt-14 md:pb-12 md:pt-16">
          <Container size="wide">
            <div className="max-w-[760px]">
              <p className="eyebrow animate-rise mb-5">Documentation</p>
              <h1 className="animate-rise animate-rise-2 text-[clamp(32px,6vw,52px)] leading-[1.05] tracking-[-0.02em]">
                Upload a video, get a playable URL
              </h1>
              <p className="animate-rise animate-rise-3 mt-5 max-w-[640px] text-[17px] leading-[1.62] text-muted">
                This is the public integration path for Rend: API-key control-plane calls for assets,
                anonymous same-origin site routes for browser playback, and MCP tools for agents.
              </p>
              <div className="animate-rise animate-rise-4 mt-8 flex flex-col gap-3 sm:flex-row">
                <Button href="#quickstart" size="md">
                  Start the quickstart <ArrowRight />
                </Button>
                <Button href={MCP_CURSOR_INSTALL_URL} external variant="secondary" size="md">
                  Add MCP to Cursor
                </Button>
                <Button href={GITHUB_URL} external variant="secondary" size="md">
                  <GitHubMark />
                  SDK on GitHub
                </Button>
              </div>
              <div className="animate-rise animate-rise-5 mt-5">
                <AgentPromptButton
                  promptCode={AGENT_PROMPT_CODE}
                  resources={agentResourceLinks}
                  leadingLabel="or"
                />
              </div>
            </div>
          </Container>
        </section>

        {/* ------------------------------- Shell ------------------------------- */}
        <Container size="wide" className="pb-[clamp(56px,8vw,96px)]">
          {/* Mobile section menu */}
          <details className="mb-8 overflow-hidden rounded-[14px] border border-line bg-card lg:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[14px] font-medium text-ink [&::-webkit-details-marker]:hidden">
              Browse docs
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </summary>
            <div className="border-t border-line p-2">
              <DocsSidebarNav items={docsNavItems} />
            </div>
          </details>

          <div className="lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-14 xl:grid-cols-[228px_minmax(0,1fr)] xl:gap-20">
            <aside className="hidden lg:block">
              <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-8">
                <p className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
                  On this page
                </p>
                <DocsSidebarNav items={docsNavItems} />
              </div>
            </aside>

            <article className="docs-prose min-w-0 max-w-[768px] space-y-16 sm:space-y-[72px]">
              <DocSection id="quickstart" label="Quickstart" title="Sign up, upload, embed, delete">
                <ol className="docs-steps">
                  {quickstartSteps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
                <CodeBlock code={QUICKSTART_SDK_CODE} language="ts" title="quickstart.ts" />
              </DocSection>

              <DocSection id="agent-setup" label="Agents" title="Hand Rend to a coding agent">
                <p>
                  Rend exposes a small, stable surface for agents: <a href="/llms.txt">llms.txt</a>
                  {" "}for discovery, <a href="/llms-full.txt">llms-full.txt</a> for larger context
                  windows, <a href="/openapi.json">OpenAPI JSON</a> for the public contract, and the
                  generated{" "}
                  <a href="https://github.com/CapSoftware/Rend/tree/main/packages/sdk">TypeScript SDK</a>.
                </p>
                <p>
                  Use this prompt when you want an agent to add upload, playback, error handling and a
                  cleanup smoke test to an app without exposing API keys in browser code.
                </p>
                <div className="my-6">
                  <AgentPromptButton promptCode={AGENT_PROMPT_CODE} resources={agentResourceLinks} />
                </div>
                <ul>
                  <li>Authenticated API calls go to <code>https://api.rend.so</code> with bearer auth.</li>
                  <li>Browser playback uses <code>https://rend.so/embed/{"{assetId}"}</code> or <code>/api/player/{"{assetId}"}</code> on the site origin.</li>
                  <li>Agents should prefer the SDK for app code and OpenAPI for generated tools.</li>
                </ul>
              </DocSection>

              <DocSection id="mcp-server" label="MCP" title="Give your agent Rend tools">
                <p>
                  Use <code>@rend-sdk/mcp</code> when Claude, Cursor, or another MCP-compatible
                  agent should upload videos, inspect assets, fetch playback links, read analytics,
                  and clean up test assets through Rend without first writing app integration code.
                </p>
                <div className="my-6 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-[14px] border border-line bg-card p-4">
                    <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
                      Cursor
                    </p>
                    <h3 className="mt-2 font-head text-[20px] leading-tight text-ink">
                      Install with one click
                    </h3>
                    <p className="mt-2 text-[14.5px] leading-[1.6] text-muted">
                      Opens Cursor with the Rend MCP config prefilled. Review the command, paste
                      your Rend API key into the env block, then approve the install.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button href={MCP_CURSOR_INSTALL_URL} external size="sm">
                        Add to Cursor <ArrowRight />
                      </Button>
                      <DocsCopyButton
                        value={MCP_CLIENT_CONFIG_CODE}
                        label="Copy config"
                        copiedLabel="Config copied"
                        ariaLabel="Copy Rend MCP config"
                      />
                    </div>
                  </div>
                  <div className="rounded-[14px] border border-line bg-card p-4">
                    <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
                      Any MCP client
                    </p>
                    <h3 className="mt-2 font-head text-[20px] leading-tight text-ink">
                      Run the package with npx
                    </h3>
                    <p className="mt-2 text-[14.5px] leading-[1.6] text-muted">
                      Clients that accept a command and args can launch the server directly. Keep
                      <code>REND_API_KEY</code> in the client env, never in chat prompts.
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <code className="border border-line bg-bg-sunken px-2.5 py-2 font-mono text-[12px] text-ink">
                        {MCP_INSTALL_COMMAND_CODE}
                      </code>
                      <DocsCopyButton
                        value={MCP_INSTALL_COMMAND_CODE}
                        label="Copy command"
                        copiedLabel="Command copied"
                        ariaLabel="Copy Rend MCP npx command"
                      />
                    </div>
                  </div>
                </div>
                <CodeBlock code={MCP_CLIENT_CONFIG_CODE} language="json" title="mcp-config.json" />
                <div className="my-6 grid gap-3 sm:grid-cols-2">
                  {mcpCapabilities.map((capability) => (
                    <div key={capability.title} className="rounded-[14px] border border-line bg-card p-4">
                      <h3 className="font-head text-[18px] leading-tight text-ink">
                        {capability.title}
                      </h3>
                      <p className="mt-2 text-[14.5px] leading-[1.6] text-muted">
                        {capability.description}
                      </p>
                    </div>
                  ))}
                </div>
                <ul>
                  <li>Grant API keys only the scopes the workflow needs: <code>upload</code>, <code>read</code>, <code>delete</code>, and <code>analytics</code>.</li>
                  <li>Pass the API key through the MCP client <code>env</code> block, not as a tool argument or prompt text.</li>
                  <li>Override <code>REND_API_BASE_URL</code> and <code>REND_SITE_BASE_URL</code> for local or private deployments.</li>
                  <li>Uploads check local file size before sending data and reject detectable non-video files.</li>
                  <li>Playback tool output includes hosted embed/watch URLs and redacts secret-bearing fields.</li>
                </ul>
                <h3>Local development</h3>
                <p>
                  Point the MCP server at your local API and site when developing Rend itself, then
                  run the smoke to upload a fixture, wait for playback, fetch analytics, delete the
                  asset, and check that tool output stays public-safe.
                </p>
                <CodeBlock code={MCP_LOCAL_CONFIG_CODE} language="json" title="mcp-local-config.json" />
                <CodeBlock code={MCP_SMOKE_CODE} language="sh" title="mcp-smoke.sh" />
              </DocSection>

              <DocSection id="sdk-guide" label="SDK" title="Use the generated TypeScript SDK">
                <p>
                  The SDK lives in{" "}
                  <a href="https://github.com/CapSoftware/Rend/tree/main/packages/sdk">packages/sdk</a>
                  {" "}and is generated from the public OpenAPI contract. It uses the API base URL for
                  authenticated asset calls and the site base URL for browser-safe playback bootstrap.
                </p>
                <ul>
                  <li><code>apiKey</code> is sent only to the API server as a bearer token.</li>
                  <li><code>apiBaseUrl</code> defaults to <code>https://api.rend.so</code>.</li>
                  <li><code>siteBaseUrl</code> defaults to <code>https://rend.so</code>.</li>
                  <li><code>waitForPlayableAsset</code> returns when the asset can be played or throws on timeout.</li>
                </ul>
                <CodeBlock code={SDK_GUIDE_CODE} language="ts" title="sdk-usage.ts" />
              </DocSection>

              <DocSection id="curl-guide" label="curl" title="Use the public API directly">
                <p>
                  The public control-plane shape is <code>/v1/videos</code>, <code>/v1/assets</code>,
                  {" "}<code>/v1/assets/{"{assetId}"}/events</code>, and{" "}
                  <code>/v1/assets/{"{assetId}"}/analytics/playback</code>. Browser playback uses the
                  site route <code>/api/player/{"{assetId}"}</code>.
                </p>
                <CodeBlock code={CURL_UPLOAD_CODE} language="sh" title="curl-flow.sh" />
              </DocSection>

              <DocSection id="auth-api-keys" label="Auth" title="API keys and scopes">
                <p>
                  Authenticated API calls use a bearer API key. Store the key server-side, pass it to
                  the SDK as <code>apiKey</code>, and avoid exposing it in browser bundles.
                </p>
                <CodeBlock code={AUTH_HEADER_CODE} language="http" title="auth-header.txt" />
                <div className="my-6 overflow-hidden rounded-[14px] border border-line bg-card">
                  <table className="w-full border-separate border-spacing-0 text-left">
                    <thead>
                      <tr className="bg-bg-sunken/60">
                        <th scope="col" className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
                          Scope
                        </th>
                        <th scope="col" className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
                          Allows
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {authScopes.map((row, i) => (
                        <tr key={row.scope}>
                          <th
                            scope="row"
                            className={cn(
                              "whitespace-nowrap px-4 py-3.5 text-left align-top font-mono text-[13px] font-medium text-ink",
                              i !== 0 && "border-t border-line-soft",
                            )}
                          >
                            {row.scope}
                          </th>
                          <td
                            className={cn(
                              "px-4 py-3.5 align-top text-[14.5px] leading-[1.6] text-ink-soft",
                              i !== 0 && "border-t border-line-soft",
                            )}
                          >
                            {row.allows}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DocSection>

              <DocSection id="playback-embed" label="Playback" title="Tokenless same-origin browser playback">
                <p>
                  Browser code does not call the API server for playback. Call the site bootstrap route
                  and use the returned same-origin artifact URL in a <code>video</code> element or the
                  Rend player. The JSON response does not expose provider URLs or signed query strings.
                </p>
                <CodeBlock code={PLAYBACK_BOOTSTRAP_CODE} language="json" title="playback-bootstrap.json" />
                <ul>
                  <li>For a bare <code>video</code> element, use <code>manifest_url</code> first when present. The hosted Rend player starts with <code>opener_url</code> and hands off to HLS.</li>
                  <li>Artifact URLs are relative to the Rend site origin.</li>
                  <li>The hosted embed page is <code>/embed/{"{assetId}"}</code> and <code>/watch/{"{assetId}"}</code> aliases the same player.</li>
                </ul>
              </DocSection>

              <DocSection id="billing-usage" label="Billing" title="Autumn billing and usage limits">
                <p>
                  Hosted Rend uses Autumn as the source of truth for plans, credits, balances,
                  checkout, and the billing portal. New workspaces are created on first email-OTP
                  sign-in and synced to Autumn by organization ID. API-key creation and uploads can
                  return <code>billing_required</code> or <code>limit_exceeded</code> until a plan is
                  active and within limits; upload denials happen before the source body is accepted.
                </p>
                <ul>
                  <li>Customer-facing delivery usage is tracked as delivered video seconds by <code>720p</code>, <code>1080p</code>, <code>2K</code>, and <code>4K</code> tier.</li>
                  <li>Customer-facing storage usage is tracked as active asset duration prorated into second-months by the same tiers.</li>
                  <li>Upload/source bytes remain local safety limits and are not customer-facing Autumn meters.</li>
                  <li>Already-issued playback artifact URLs do not call Autumn, Postgres, or the Rend API on the playback hot path.</li>
                </ul>
              </DocSection>

              <DocSection id="error-states" label="Errors" title="Common states and responses">
                <div className="my-6 overflow-hidden rounded-[14px] border border-line bg-card">
                  <table className="w-full border-separate border-spacing-0 text-left">
                    <thead>
                      <tr className="bg-bg-sunken/60">
                        <th scope="col" className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
                          State
                        </th>
                        <th scope="col" className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
                          Where
                        </th>
                        <th scope="col" className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
                          Meaning
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {errorStates.map((row, i) => (
                        <tr key={row.state}>
                          <th
                            scope="row"
                            className={cn(
                              "whitespace-nowrap px-4 py-3.5 text-left align-top font-mono text-[13px] font-medium text-ink",
                              i !== 0 && "border-t border-line-soft",
                            )}
                          >
                            {row.state}
                          </th>
                          <td
                            className={cn(
                              "px-4 py-3.5 align-top text-[14px] leading-[1.55] text-ink-soft",
                              i !== 0 && "border-t border-line-soft",
                            )}
                          >
                            {row.where}
                          </td>
                          <td
                            className={cn(
                              "px-4 py-3.5 align-top text-[14px] leading-[1.55] text-ink-soft",
                              i !== 0 && "border-t border-line-soft",
                            )}
                          >
                            {row.meaning}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DocSection>

              <DocSection id="local-docker" label="Local" title="Local Docker development path">
                <p>
                  The local stack runs Postgres, Redis, ClickHouse, MinIO, the API, media worker, and
                  edge service. Create API keys through the local dashboard or run the SDK smoke, which
                  creates a local smoke key when <code>REND_API_KEY</code> is not set.
                </p>
                <CodeBlock code={LOCAL_DOCKER_CODE} language="sh" title="local-dev.sh" />
              </DocSection>

              <DocSection id="production-notes" label="Production" title="Production profile notes">
                <ul>
                  <li>Use <code>REND_ENV=production</code> for hosted production services.</li>
                  <li>Set <code>REND_SELF_SERVE_SIGNUP_ENABLED=true</code> intentionally for public self-serve signup.</li>
                  <li>Configure Better Auth with secure production secrets and Resend email delivery.</li>
                  <li>Keep API keys and provider credentials out of <code>NEXT_PUBLIC_*</code> values.</li>
                  <li>Set <code>REND_API_BASE_URL</code> for server-side API calls and <code>REND_SITE_BASE_URL</code> for playback bootstrap clients.</li>
                  <li>Run <code>bun run launch:self-serve-readiness</code> and <code>bun run launch:gate -- --mode production-check</code> before public V1 launch.</li>
                  <li>Run <code>bun run openapi:check</code> after changing the public contract or SDK generator.</li>
                </ul>
              </DocSection>

              <DocSection id="reference" label="Reference" title="OpenAPI and SDK source">
                <ul>
                  <li>
                    <a href="/openapi.json">OpenAPI JSON</a> is the canonical public API contract served by the site.
                  </li>
                  <li>
                    <a href="https://github.com/CapSoftware/Rend/tree/main/packages/sdk">packages/sdk</a>
                    {" "}contains the generated TypeScript client.
                  </li>
                  <li>
                    <a href="/llms.txt">llms.txt</a> lists stable docs anchors for agents.
                  </li>
                </ul>
              </DocSection>
            </article>
          </div>
        </Container>
      </main>
      <SiteFooter />
    </div>
  );
}
