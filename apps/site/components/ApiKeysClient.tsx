"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Check, KeyRound, Plus, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";
import type { ApiKeyRecord, ApiKeyScope } from "../lib/api-key-types.ts";
import { API_KEY_SCOPES } from "../lib/api-key-types.ts";
import type { DashboardState } from "../lib/dashboard-state.ts";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Callout, CopyButton, DashboardContent, StatusBadge, SubHeader } from "@/components/dashboard";

type CreateResponse =
  | { status: "ok"; api_key: ApiKeyRecord; secret: string }
  | { status: "error"; message: string };

type ListResponse =
  | { status: "ok"; api_keys: ApiKeyRecord[] }
  | { status: "error"; message: string };

const SCOPE_DETAILS: Record<ApiKeyScope, { label: string; description: string }> = {
  upload: { label: "Upload", description: "Create and upload new assets" },
  read: { label: "Read", description: "List and fetch asset details" },
  delete: { label: "Delete", description: "Permanently remove assets" },
  analytics: { label: "Analytics", description: "Read playback analytics" },
};

const DEFAULT_SCOPES: ApiKeyScope[] = ["upload", "read"];

const fieldClass =
  "h-11 w-full rounded-xl border border-line bg-card px-3.5 text-[14px] text-ink outline-none transition placeholder:text-faint focus:border-ink/40 focus:ring-4 focus:ring-ink/[0.06] disabled:cursor-not-allowed disabled:opacity-60";

const overlayClass =
  "fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0";

const contentClass =
  "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border border-line bg-card p-6 shadow-[0_30px_70px_-30px_rgba(22,21,19,0.5)] focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 sm:p-7";

const dangerButtonClass =
  "inline-flex h-11 w-full select-none items-center justify-center gap-2 border border-[#9a2b22] bg-[#b54033] px-5 text-sm font-medium leading-none text-bg transition duration-200 ease-out hover:bg-[#9a2b22] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b54033]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-55 sm:w-auto";

function formatDate(value: string | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatRelative(value: string | undefined) {
  if (!value) return "Never used";
  const date = new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return value;
  const diff = Date.now() - ms;
  if (diff < 60_000) return "Used just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `Used ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Used ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Used ${days}d ago`;
  return `Used ${formatDate(value)}`;
}

function ScopePill({ scope }: { scope: ApiKeyScope }) {
  return (
    <span className="rounded-md border border-line-soft bg-bg-sunken/60 px-1.5 py-0.5 text-[11px] font-medium text-muted">
      {SCOPE_DETAILS[scope]?.label ?? scope}
    </span>
  );
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
  const [error, setError] = useState(initialError ?? "");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(DEFAULT_SCOPES);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [createdSecret, setCreatedSecret] = useState("");
  const [createdKey, setCreatedKey] = useState<ApiKeyRecord | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null);
  const [revoking, setRevoking] = useState(false);

  const createDisabledReason =
    readOnlyReason ?? (dashboardState.blocksUpload ? dashboardState.message : undefined);
  const activeCount = keys.filter((key) => !key.revoked_at).length;

  async function refreshKeys() {
    const response = await fetch("/api/api-keys", { cache: "no-store" });
    const body = (await response.json()) as ListResponse;
    if (!response.ok || body.status !== "ok") {
      throw new Error("message" in body ? body.message : "Refresh failed");
    }
    setKeys(body.api_keys);
  }

  function resetCreateState() {
    setName("");
    setScopes(DEFAULT_SCOPES);
    setFormError("");
    setCreatedSecret("");
    setCreatedKey(null);
    setSubmitting(false);
  }

  function openCreate() {
    if (createDisabledReason) {
      setError(createDisabledReason);
      return;
    }
    setError("");
    resetCreateState();
    setCreateOpen(true);
  }

  function handleCreateOpenChange(open: boolean) {
    setCreateOpen(open);
    if (!open) resetCreateState();
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createDisabledReason) {
      setFormError(createDisabledReason);
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes }),
      });
      const body = (await response.json()) as CreateResponse;
      if (!response.ok || body.status !== "ok") {
        throw new Error("message" in body ? body.message : "Create failed");
      }
      setKeys((current) => [body.api_key, ...current]);
      setCreatedKey(body.api_key);
      setCreatedSecret(body.secret);
    } catch (createError) {
      setFormError(createError instanceof Error ? createError.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  }

  function requestRevoke(key: ApiKeyRecord) {
    if (readOnlyReason) {
      setError(readOnlyReason);
      return;
    }
    setError("");
    setRevokeTarget(key);
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    if (readOnlyReason) {
      setError(readOnlyReason);
      setRevokeTarget(null);
      return;
    }
    const keyId = revokeTarget.id;
    setRevoking(true);
    setError("");
    try {
      const response = await fetch(`/api/api-keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || "Revoke failed");
      }
      await refreshKeys().catch(() => {
        setKeys((current) =>
          current.map((key) =>
            key.id === keyId ? { ...key, revoked_at: new Date().toISOString() } : key
          )
        );
      });
      setRevokeTarget(null);
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Revoke failed");
      setRevokeTarget(null);
    } finally {
      setRevoking(false);
    }
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
      <SubHeader
        title="API keys"
        docsHref="/docs#auth-api-keys"
        actions={
          <Button type="button" size="sm" onClick={openCreate} disabled={Boolean(createDisabledReason)}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">Create key</span>
            <span className="sm:hidden">Create</span>
          </Button>
        }
      />

      <DashboardContent>
        <div className="mb-6 flex flex-col gap-3 empty:hidden">
          {error ? <Callout tone="danger">{error}</Callout> : null}

          {dashboardState.status !== "ready_to_upload" ? (
            <Callout
              tone={dashboardState.status === "billing_unavailable" ? "danger" : "warn"}
              title={dashboardState.title}
              action={
                dashboardState.actionHref && dashboardState.actionLabel ? (
                  <Button href={dashboardState.actionHref} variant="secondary" size="sm">
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

        <section className="animate-rise overflow-hidden rounded-[18px] border border-line bg-card">
          <header className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-4 sm:px-6">
            <h2 className="font-head text-[18px] leading-none text-ink">Active keys</h2>
            <span className="shrink-0 rounded-full border border-line bg-bg-sunken/60 px-2.5 py-1 text-[12px] font-medium tabular-nums text-muted">
              {activeCount} active
            </span>
          </header>

          {keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
              <span className="grid size-14 place-items-center rounded-2xl border border-line-soft bg-bg-sunken/60 text-faint">
                <KeyRound className="size-6" />
              </span>
              <div>
                <p className="font-head text-[18px] text-ink">No API keys yet</p>
                <p className="mx-auto mt-1.5 max-w-[330px] text-[13.5px] leading-[1.55] text-muted">
                  Create your first key to start uploading and managing assets from your backend.
                </p>
              </div>
              <Button type="button" onClick={openCreate} disabled={Boolean(createDisabledReason)}>
                <Plus className="size-4" />
                Create key
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-line-soft">
              {keys.map((key) => {
                const revoked = Boolean(key.revoked_at);
                return (
                  <li
                    key={key.id}
                    className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-bg-sunken/30 sm:px-6"
                  >
                    <span
                      className={cn(
                        "grid size-10 shrink-0 place-items-center rounded-xl border border-line-soft transition-colors",
                        revoked ? "bg-bg-sunken/40 text-faint/70" : "bg-bg-sunken/60 text-faint",
                      )}
                    >
                      <KeyRound className="size-[18px]" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <p
                          className={cn(
                            "truncate text-[14.5px] font-medium",
                            revoked ? "text-muted line-through" : "text-ink",
                          )}
                        >
                          {key.name}
                        </p>
                        <code className="shrink-0 rounded-md bg-bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-muted">
                          {key.prefix}
                        </code>
                        <StatusBadge tone={revoked ? "danger" : "success"} className="shrink-0">
                          {revoked ? "Revoked" : "Active"}
                        </StatusBadge>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        <span className="flex flex-wrap gap-1">
                          {key.scopes.map((scope) => (
                            <ScopePill key={scope} scope={scope} />
                          ))}
                        </span>
                        <span className="text-faint" aria-hidden="true">
                          &middot;
                        </span>
                        <span className="text-[12px] text-faint">Created {formatDate(key.created_at)}</span>
                        <span className="text-faint" aria-hidden="true">
                          &middot;
                        </span>
                        <span className="text-[12px] text-faint">{formatRelative(key.last_used_at)}</span>
                      </div>
                    </div>

                    {revoked ? null : (
                      <button
                        type="button"
                        onClick={() => requestRevoke(key)}
                        disabled={Boolean(readOnlyReason)}
                        aria-label={`Revoke ${key.name}`}
                        title="Revoke key"
                        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-transparent px-2.5 text-[12.5px] font-medium text-faint transition-colors hover:border-[#eccac6] hover:bg-[#fcf3f1] hover:text-[#9a2b22] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:pointer-events-none disabled:opacity-40"
                      >
                        <Trash2 className="size-4" />
                        <span className="hidden lg:inline">Revoke</span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </DashboardContent>

      <Dialog.Root open={createOpen} onOpenChange={handleCreateOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className={overlayClass} />
          <Dialog.Content className={contentClass}>
            {createdSecret ? (
              <div className="flex flex-col">
                <span className="grid size-12 place-items-center rounded-full border border-[#cfe7d6] bg-[#f4faf6] text-[#3f8f5b]">
                  <Check className="size-6" />
                </span>
                <Dialog.Title className="mt-4 font-head text-[21px] leading-tight text-ink">
                  API key created
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-[13.5px] leading-[1.55] text-muted">
                  Copy your secret now. For security, you will not be able to see it again.
                </Dialog.Description>

                <div className="mt-5 rounded-xl border border-line bg-bg-sunken/40 p-3">
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                      {createdSecret}
                    </code>
                    <CopyButton value={createdSecret} className="shrink-0" />
                  </div>
                </div>

                {createdKey ? (
                  <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px]">
                    <span className="font-medium text-ink-soft">{createdKey.name}</span>
                    <span className="text-faint" aria-hidden="true">
                      &middot;
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {createdKey.scopes.map((scope) => (
                        <ScopePill key={scope} scope={scope} />
                      ))}
                    </span>
                  </div>
                ) : null}

                <div className="mt-6 flex justify-end">
                  <Button
                    type="button"
                    className="w-full sm:w-auto"
                    onClick={() => handleCreateOpenChange(false)}
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Dialog.Title className="font-head text-[21px] leading-tight text-ink">
                  Create API key
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-[13.5px] leading-[1.55] text-muted">
                  Name your key and choose what it can do. The secret is shown once, right after you create it.
                </Dialog.Description>

                <form className="mt-6 flex flex-col gap-5" onSubmit={createKey}>
                  <div className="flex flex-col gap-2">
                    <label htmlFor="api-key-name" className="text-[13px] font-medium text-ink-soft">
                      Name
                    </label>
                    <input
                      id="api-key-name"
                      type="text"
                      maxLength={80}
                      autoFocus
                      placeholder="Production server"
                      disabled={submitting}
                      value={name}
                      onChange={(event) => setName(event.currentTarget.value)}
                      className={fieldClass}
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-[13px] font-medium text-ink-soft">Permissions</span>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {API_KEY_SCOPES.map((scope) => {
                        const checked = scopes.includes(scope);
                        return (
                          <label
                            key={scope}
                            className={cn(
                              "flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-all duration-200",
                              checked
                                ? "border-ink bg-bg-sunken/50"
                                : "border-line hover:border-ink/30 hover:bg-bg-sunken/30",
                              submitting && "pointer-events-none opacity-60",
                            )}
                          >
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={checked}
                              disabled={submitting}
                              onChange={() => toggleScope(scope)}
                            />
                            <span
                              className={cn(
                                "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-md border transition-all duration-200",
                                checked ? "border-ink bg-ink text-bg" : "border-line bg-card",
                              )}
                              aria-hidden="true"
                            >
                              {checked ? <Check className="size-3" /> : null}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[13px] font-medium text-ink">
                                {SCOPE_DETAILS[scope].label}
                              </span>
                              <span className="mt-0.5 block text-[11.5px] leading-[1.45] text-muted">
                                {SCOPE_DETAILS[scope].description}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {formError ? <Callout tone="danger">{formError}</Callout> : null}

                  <div className="mt-1 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full sm:w-auto"
                      onClick={() => handleCreateOpenChange(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      className="w-full sm:w-auto"
                      disabled={submitting || !name.trim() || scopes.length === 0}
                    >
                      <KeyRound className="size-4" />
                      {submitting ? "Creating..." : "Create key"}
                    </Button>
                  </div>
                </form>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !revoking) setRevokeTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={overlayClass} />
          <Dialog.Content className={contentClass}>
            <span className="grid size-12 place-items-center rounded-full border border-[#eccac6] bg-[#fcf3f1] text-[#b54033]">
              <Trash2 className="size-5" />
            </span>
            <Dialog.Title className="mt-4 font-head text-[21px] leading-tight text-ink">
              Revoke API key
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-[13.5px] leading-[1.55] text-muted">
              This immediately disables{" "}
              <span className="font-medium text-ink">{revokeTarget?.name}</span>. Any service using it
              will stop working, and this cannot be undone.
            </Dialog.Description>

            <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="secondary"
                className="w-full sm:w-auto"
                onClick={() => setRevokeTarget(null)}
                disabled={revoking}
              >
                Cancel
              </Button>
              <button type="button" onClick={confirmRevoke} disabled={revoking} className={dangerButtonClass}>
                <Trash2 className="size-4" />
                {revoking ? "Revoking..." : "Revoke key"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
