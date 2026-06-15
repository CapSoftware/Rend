"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import type { ApiKeyRecord, ApiKeyScope } from "../lib/api-key-types.ts";
import { API_KEY_SCOPES } from "../lib/api-key-types.ts";
import { signOutOfDashboard } from "../lib/auth-client.ts";
import type { DashboardState } from "../lib/dashboard-state.ts";

type CreateResponse =
  | { status: "ok"; api_key: ApiKeyRecord; secret: string }
  | { status: "error"; message: string };

type ListResponse =
  | { status: "ok"; api_keys: ApiKeyRecord[] }
  | { status: "error"; message: string };

function formatTimestamp(value: string | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export default function ApiKeysClient({
  dashboardState,
  initialKeys,
  initialError,
  readOnlyReason,
}: {
  dashboardState: DashboardState;
  initialKeys: ApiKeyRecord[];
  initialError?: string;
  readOnlyReason?: string;
}) {
  const [keys, setKeys] = useState(initialKeys);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["upload", "read"]);
  const [createdSecret, setCreatedSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(initialError ?? "");
  const [submitting, setSubmitting] = useState(false);
  const createDisabledReason =
    readOnlyReason ?? (dashboardState.blocksUpload ? dashboardState.message : undefined);

  async function refreshKeys() {
    const response = await fetch("/api/api-keys", { cache: "no-store" });
    const body = (await response.json()) as ListResponse;
    if (!response.ok || body.status !== "ok") {
      throw new Error("message" in body ? body.message : "Refresh failed");
    }
    setKeys(body.api_keys);
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createDisabledReason) {
      setError(createDisabledReason);
      return;
    }
    setSubmitting(true);
    setError("");
    setCreatedSecret("");
    setCopied(false);
    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, scopes }),
      });
      const body = (await response.json()) as CreateResponse;
      if (!response.ok || body.status !== "ok") {
        throw new Error("message" in body ? body.message : "Create failed");
      }
      setKeys((current) => [body.api_key, ...current]);
      setCreatedSecret(body.secret);
      setName("");
      setScopes(["upload", "read"]);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeKey(keyId: string) {
    setError("");
    if (readOnlyReason) {
      setError(readOnlyReason);
      return;
    }
    const response = await fetch(`/api/api-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      cache: "no-store",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      setError(body.message || "Revoke failed");
      return;
    }
    await refreshKeys().catch(() => {
      setKeys((current) =>
        current.map((key) =>
          key.id === keyId ? { ...key, revoked_at: new Date().toISOString() } : key
        )
      );
    });
  }

  function toggleScope(scope: ApiKeyScope) {
    setScopes((current) => {
      if (current.includes(scope)) {
        return current.length === 1 ? current : current.filter((item) => item !== scope);
      }
      return [...current, scope];
    });
  }

  async function copyCreatedSecret() {
    if (!createdSecret) return;
    await navigator.clipboard.writeText(createdSecret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <a href="/" aria-label="Rend home">
          <img src="/rend-logo.svg" alt="Rend" className="app-logo" />
        </a>
        <nav>
          <Link href="/dashboard/assets">Assets</Link>
          <Link href="/dashboard/api-keys">API keys</Link>
          <Link href="/dashboard/billing">Billing</Link>
          <button onClick={signOutOfDashboard} type="button">
            Sign out
          </button>
        </nav>
      </header>

      <main className="app-main">
        <section className="app-page-head">
          <div>
            <p className="app-kicker">Rend app</p>
            <h1>API keys</h1>
          </div>
        </section>

        {createdSecret ? (
          <section className="app-callout app-callout-done app-key-callout">
            <div className="app-code-block">{createdSecret}</div>
            <button onClick={copyCreatedSecret} type="button">
              {copied ? "Copied" : "Copy"}
            </button>
          </section>
        ) : null}

        {error ? (
          <section className="app-callout app-callout-error">
            <span>{error}</span>
          </section>
        ) : null}

        <section
          className={`app-callout ${
            dashboardState.status === "ready_to_upload" ? "app-callout-done" : "app-callout-error"
          }`}
        >
          <div>
            <strong>{dashboardState.title}</strong>
            <span>{dashboardState.message}</span>
          </div>
          {dashboardState.actionHref && dashboardState.actionLabel ? (
            <Link className="app-link-button" href={dashboardState.actionHref}>
              {dashboardState.actionLabel}
            </Link>
          ) : null}
        </section>

        {readOnlyReason ? (
          <section className="app-callout app-callout-error">
            <span>{readOnlyReason}</span>
          </section>
        ) : null}

        <section className="app-panel app-form-panel">
          <h2>Create key</h2>
          <form className="app-key-form" onSubmit={createKey}>
            <label htmlFor="api-key-name">Name</label>
            <input
              disabled={submitting || Boolean(createDisabledReason)}
              id="api-key-name"
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
              type="text"
              value={name}
            />
            <div className="app-scope-grid">
              {API_KEY_SCOPES.map((scope) => (
                <label key={scope}>
                  <input
                    checked={scopes.includes(scope)}
                    disabled={submitting || Boolean(createDisabledReason)}
                    onChange={() => toggleScope(scope)}
                    type="checkbox"
                  />
                  <span>{scope}</span>
                </label>
              ))}
            </div>
            <button disabled={submitting || Boolean(createDisabledReason) || !name.trim() || scopes.length === 0} type="submit">
              {submitting ? "Creating..." : "Create key"}
            </button>
          </form>
        </section>

        <section className="app-panel">
          {keys.length === 0 ? (
            <div className="app-empty">No API keys.</div>
          ) : (
            <div className="app-table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Prefix</th>
                    <th>Scopes</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.id}>
                      <td>{key.name}</td>
                      <td className="app-mono">{key.prefix}</td>
                      <td>{key.scopes.join(", ")}</td>
                      <td>{formatTimestamp(key.created_at)}</td>
                      <td>{formatTimestamp(key.last_used_at)}</td>
                      <td>
                        <span className={`app-pill ${key.revoked_at ? "app-state-deleted" : "app-state-ready"}`}>
                          {key.revoked_at ? "revoked" : "active"}
                        </span>
                      </td>
                      <td>
                        <button
                          className="app-danger"
                          disabled={Boolean(key.revoked_at) || Boolean(readOnlyReason)}
                          onClick={() => revokeKey(key.id)}
                          type="button"
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
