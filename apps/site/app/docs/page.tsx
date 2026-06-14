import type { Metadata } from "next";
import Link from "next/link";
import DocsCommandPalette from "../../components/DocsCommandPalette";
import DocsCopyButton from "../../components/DocsCopyButton";
import {
  AUTH_HEADER_CODE,
  CURL_UPLOAD_CODE,
  LOCAL_DOCKER_CODE,
  PLAYBACK_BOOTSTRAP_CODE,
  QUICKSTART_SDK_CODE,
  SDK_GUIDE_CODE,
  docsCommandItems,
  docsNavItems,
} from "./docs-content";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Rend public API docs for uploading video, waiting for playback, embedding the player, analytics, and deletion.",
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
    <figure className="docs-code-block">
      <figcaption>
        <span>{title}</span>
        <DocsCopyButton value={code} />
      </figcaption>
      <pre tabIndex={0}>
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </figure>
  );
}

function DocsNav({ label }: { label: string }) {
  return (
    <nav aria-label={label} className="docs-nav-list">
      {docsNavItems.map((item) => (
        <a href={item.href} key={item.href}>
          <span>{item.title}</span>
          <small>{item.description}</small>
        </a>
      ))}
    </nav>
  );
}

export default function DocsPage() {
  return (
    <div className="docs-page">
      <header className="docs-header">
        <Link href="/" aria-label="Rend home">
          <img src="/rend-logo.svg" alt="Rend" className="docs-logo" />
        </Link>
        <nav aria-label="Primary docs navigation">
          <Link href="/">Home</Link>
          <Link href="/dashboard/assets">Dashboard</Link>
          <DocsCommandPalette items={docsCommandItems} />
        </nav>
      </header>

      <main className="docs-main">
        <section className="docs-intro" aria-labelledby="docs-title">
          <p className="docs-kicker">Rend docs</p>
          <h1 id="docs-title">Upload video, get a playable Rend URL.</h1>
          <p>
            This is the public integration path for Rend: API-key control-plane calls for assets,
            and anonymous same-origin site routes for browser playback.
          </p>
        </section>

        <details className="docs-mobile-nav">
          <summary>Docs menu</summary>
          <DocsNav label="Mobile docs sections" />
        </details>

        <div className="docs-shell">
          <aside className="docs-sidebar">
            <DocsNav label="Docs sections" />
          </aside>

          <article className="docs-content">
            <section id="quickstart" aria-labelledby="quickstart-title">
              <p className="docs-section-label">Quickstart</p>
              <h2 id="quickstart-title">Create a key, upload, embed, delete</h2>
              <ol className="docs-steps">
                <li>Create an API key from the Rend dashboard with <code>upload</code>, <code>read</code>, <code>delete</code>, and <code>analytics</code> scopes.</li>
                <li>Upload a video with <code>POST /v1/videos</code> or <code>client.uploadAsset</code>.</li>
                <li>Poll the asset until <code>playable_state</code> is <code>opener_ready</code> or <code>hls_ready</code>.</li>
                <li>Fetch <code>/api/player/{"{assetId}"}</code> from the site and embed the returned same-origin source.</li>
                <li>Delete the asset with <code>DELETE /v1/assets/{"{assetId}"}</code> when it is no longer needed.</li>
              </ol>
              <CodeBlock code={QUICKSTART_SDK_CODE} language="ts" title="quickstart.ts" />
            </section>

            <section id="sdk-guide" aria-labelledby="sdk-guide-title">
              <p className="docs-section-label">SDK</p>
              <h2 id="sdk-guide-title">Use the generated TypeScript SDK</h2>
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
            </section>

            <section id="curl-guide" aria-labelledby="curl-guide-title">
              <p className="docs-section-label">curl</p>
              <h2 id="curl-guide-title">Use the public API directly</h2>
              <p>
                The public control-plane shape is <code>/v1/videos</code>, <code>/v1/assets</code>,
                <code>/v1/assets/{"{assetId}"}/events</code>, and <code>/v1/assets/{"{assetId}"}/analytics/playback</code>.
                Browser playback uses the site route <code>/api/player/{"{assetId}"}</code>.
              </p>
              <CodeBlock code={CURL_UPLOAD_CODE} language="sh" title="curl-flow.sh" />
            </section>

            <section id="auth-api-keys" aria-labelledby="auth-api-keys-title">
              <p className="docs-section-label">Auth</p>
              <h2 id="auth-api-keys-title">API keys and scopes</h2>
              <p>
                Authenticated API calls use a bearer API key. Store the key server-side, pass it to
                the SDK as <code>apiKey</code>, and avoid exposing it in browser bundles.
              </p>
              <CodeBlock code={AUTH_HEADER_CODE} language="http" title="auth-header.txt" />
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Allows</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>upload</td>
                    <td>Upload a source video.</td>
                  </tr>
                  <tr>
                    <td>read</td>
                    <td>List assets, fetch asset details, poll lifecycle events, and bootstrap playback.</td>
                  </tr>
                  <tr>
                    <td>delete</td>
                    <td>Delete an asset and its Rend-owned origin objects.</td>
                  </tr>
                  <tr>
                    <td>analytics</td>
                    <td>Fetch playback request analytics.</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section id="playback-embed" aria-labelledby="playback-embed-title">
              <p className="docs-section-label">Playback</p>
              <h2 id="playback-embed-title">Tokenless same-origin browser playback</h2>
              <p>
                Browser code does not call the API server for playback. Call the site bootstrap route
                and use the returned same-origin artifact URL in a <code>video</code> element or the Rend player.
                The JSON response does not expose provider URLs or signed query strings.
              </p>
              <CodeBlock code={PLAYBACK_BOOTSTRAP_CODE} language="json" title="playback-bootstrap.json" />
              <ul>
                <li>Use <code>manifest_url</code> first when present, then <code>playback_url</code>, then <code>opener_url</code>.</li>
                <li>Artifact URLs are relative to the Rend site origin.</li>
                <li>The hosted embed page is <code>/embed/{"{assetId}"}</code> and <code>/watch/{"{assetId}"}</code> aliases the same player.</li>
              </ul>
            </section>

            <section id="error-states" aria-labelledby="error-states-title">
              <p className="docs-section-label">Errors</p>
              <h2 id="error-states-title">Common states and responses</h2>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>State</th>
                    <th>Where</th>
                    <th>Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>not_playable</td>
                    <td><code>GET /api/player/{"{assetId}"}</code> returns 409</td>
                    <td>The asset exists, but no opener or HLS artifact is ready yet.</td>
                  </tr>
                  <tr>
                    <td>suspended</td>
                    <td>API calls return 403, or asset summaries include suspension fields</td>
                    <td>The asset or organization is blocked from normal API use.</td>
                  </tr>
                  <tr>
                    <td>unauthorized</td>
                    <td>API calls return 401</td>
                    <td>The bearer API key is missing, malformed, revoked, or invalid.</td>
                  </tr>
                  <tr>
                    <td>upload too large</td>
                    <td><code>POST /v1/videos</code> returns 413</td>
                    <td>The upload exceeds the configured maximum size.</td>
                  </tr>
                  <tr>
                    <td>deleted</td>
                    <td>Asset reads or playback return unavailable/not found</td>
                    <td>The asset was deleted; bootstrap and artifact paths should no longer play.</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section id="local-docker" aria-labelledby="local-docker-title">
              <p className="docs-section-label">Local</p>
              <h2 id="local-docker-title">Local Docker development path</h2>
              <p>
                The local stack runs Postgres, Redis, ClickHouse, MinIO, the API, media worker, and
                edge service. Create API keys through the local dashboard or run the SDK smoke, which
                creates a local smoke key when <code>REND_API_KEY</code> is not set.
              </p>
              <CodeBlock code={LOCAL_DOCKER_CODE} language="sh" title="local-dev.sh" />
            </section>

            <section id="production-notes" aria-labelledby="production-notes-title">
              <p className="docs-section-label">Production</p>
              <h2 id="production-notes-title">Production profile notes</h2>
              <ul>
                <li>Use <code>REND_ENV=production</code> for hosted production services.</li>
                <li>Keep API keys and provider credentials out of <code>NEXT_PUBLIC_*</code> values.</li>
                <li>Set <code>REND_API_BASE_URL</code> for server-side API calls and <code>REND_SITE_BASE_URL</code> for playback bootstrap clients.</li>
                <li>Run <code>bun run openapi:check</code> after changing the public contract or SDK generator.</li>
              </ul>
            </section>

            <section id="reference" aria-labelledby="reference-title">
              <p className="docs-section-label">Reference</p>
              <h2 id="reference-title">OpenAPI and SDK source</h2>
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
            </section>
          </article>

          <aside className="docs-toc" aria-label="On this page">
            <p>On this page</p>
            {docsNavItems.map((item) => (
              <a href={item.href} key={item.href}>
                {item.title}
              </a>
            ))}
          </aside>
        </div>
      </main>
    </div>
  );
}
