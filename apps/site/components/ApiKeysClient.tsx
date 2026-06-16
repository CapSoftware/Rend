"use client";

import { KeyRound } from "lucide-react";
import { FormEvent, useState } from "react";
import type { ApiKeyRecord, ApiKeyScope } from "../lib/api-key-types.ts";
import { API_KEY_SCOPES } from "../lib/api-key-types.ts";
import type { DashboardState } from "../lib/dashboard-state.ts";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  Callout,
  CopyButton,
  DashboardContent,
  Panel,
  StatusBadge,
  SubHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/dashboard";

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

  return (
    <>
      <SubHeader title="API keys" docsHref="/docs#auth-api-keys" />

      <DashboardContent>
      <div className="mb-5 flex flex-col gap-3 empty:hidden">
        {createdSecret ? (
          <Callout tone="success" title="API key created">
            <p>Copy this secret now. You will not be able to see it again.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-[#cfe7d6] bg-card px-3 py-2 font-mono text-[12.5px] text-ink">
                {createdSecret}
              </code>
              <CopyButton value={createdSecret} />
            </div>
          </Callout>
        ) : null}

        {error ? <Callout tone="danger">{error}</Callout> : null}

        {dashboardState.status !== "ready_to_upload" ? (
          <Callout
            tone={dashboardState.status === "billing_unavailable" ? "danger" : "warn"}
            title={dashboardState.title}
            action={
              dashboardState.actionHref && dashboardState.actionLabel ? (
                <Button href={dashboardState.actionHref} variant="secondary" size="sm" className="rounded-md">
                  {dashboardState.actionLabel}
                </Button>
              ) : null
            }
          >
            {dashboardState.message}
          </Callout>
        ) : null}

        {readOnlyReason ? <Callout tone="danger">{readOnlyReason}</Callout> : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Panel title="Create key">
          <form className="flex flex-col gap-4" onSubmit={createKey}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="api-key-name" className="text-[13px] font-medium text-ink-soft">
                Name
              </label>
              <input
                id="api-key-name"
                type="text"
                maxLength={80}
                placeholder="Production server"
                disabled={submitting || Boolean(createDisabledReason)}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                className="h-10 w-full rounded-md border border-line bg-card px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-faint focus:border-ink/30 focus:ring-2 focus:ring-ink/15 disabled:opacity-60"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-soft">Scopes</span>
              <div className="grid grid-cols-2 gap-2">
                {API_KEY_SCOPES.map((scope) => {
                  const checked = scopes.includes(scope);
                  return (
                    <label
                      key={scope}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[13px] transition-colors",
                        checked
                          ? "border-ink/30 bg-bg-sunken text-ink"
                          : "border-line text-muted hover:border-ink/20",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-ink"
                        checked={checked}
                        disabled={submitting || Boolean(createDisabledReason)}
                        onChange={() => toggleScope(scope)}
                      />
                      <span className="font-medium">{scope}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <Button
              type="submit"
              className="rounded-md"
              disabled={submitting || Boolean(createDisabledReason) || !name.trim() || scopes.length === 0}
            >
              <KeyRound className="size-4" />
              {submitting ? "Creating" : "Create key"}
            </Button>
          </form>
        </Panel>

        <Panel
          title="Active keys"
          actions={<span className="text-[12px] text-muted">{keys.length} total</span>}
          flush
        >
          {keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-bg-sunken text-faint">
                <KeyRound className="size-6" />
              </span>
              <div>
                <p className="font-head text-[17px] text-ink">No API keys yet</p>
                <p className="mt-1 text-[13.5px] text-muted">
                  Create a key to start uploading from your own backend.
                </p>
              </div>
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Prefix</TH>
                  <TH className="hidden md:table-cell">Scopes</TH>
                  <TH className="hidden lg:table-cell">Created</TH>
                  <TH className="hidden lg:table-cell">Last used</TH>
                  <TH>Status</TH>
                  <TH className="text-right">{""}</TH>
                </TR>
              </THead>
              <TBody>
                {keys.map((key) => (
                  <TR key={key.id}>
                    <TD className="font-medium text-ink">{key.name}</TD>
                    <TD className="whitespace-nowrap font-mono text-[12px] text-muted">{key.prefix}</TD>
                    <TD className="hidden md:table-cell">
                      <span className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <span
                            key={scope}
                            className="rounded border border-line bg-bg-sunken px-1.5 py-0.5 text-[11px] text-muted"
                          >
                            {scope}
                          </span>
                        ))}
                      </span>
                    </TD>
                    <TD className="hidden whitespace-nowrap font-mono text-[12px] text-muted lg:table-cell">
                      {formatTimestamp(key.created_at)}
                    </TD>
                    <TD className="hidden whitespace-nowrap font-mono text-[12px] text-muted lg:table-cell">
                      {formatTimestamp(key.last_used_at)}
                    </TD>
                    <TD>
                      <StatusBadge tone={key.revoked_at ? "danger" : "success"}>
                        {key.revoked_at ? "Revoked" : "Active"}
                      </StatusBadge>
                    </TD>
                    <TD className="text-right">
                      <button
                        type="button"
                        disabled={Boolean(key.revoked_at) || Boolean(readOnlyReason)}
                        onClick={() => revokeKey(key.id)}
                        className="inline-flex h-8 items-center rounded-md border border-line px-2.5 text-[12.5px] font-medium text-[#9a2b22] transition-colors hover:border-[#eccac6] hover:bg-[#fcf3f1] disabled:pointer-events-none disabled:opacity-45"
                      >
                        Revoke
                      </button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Panel>
      </div>
      </DashboardContent>
    </>
  );
}
