"use client";

import Link from "next/link";
import { ChangeEvent, useMemo, useState } from "react";
import type {
  AssetListResponse,
  AssetSummary,
  AssetErrorResponse,
  AssetUploadResponse,
} from "../lib/asset-types.ts";
import type { DashboardUploadIntentResponse } from "../lib/dashboard-upload-token.ts";
import { signOutOfDashboard } from "../lib/auth-client.ts";
import type { DashboardState } from "../lib/dashboard-state.ts";

type UploadState =
  | { status: "idle" }
  | { status: "uploading"; progress: number | null }
  | { status: "error"; message: string }
  | { status: "done"; message: string };

type DirectUploadResponse = {
  asset_id?: unknown;
  source_state?: unknown;
  playable_state?: unknown;
  byte_size?: unknown;
  message?: unknown;
  error?: unknown;
};

function formatBytes(value: number | undefined) {
  if (value === undefined) return "-";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

async function requestUploadIntent(file: File) {
  const response = await fetch("/api/assets/upload-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contentLength: file.size,
      contentType: file.type || "application/octet-stream",
    }),
  });
  const body = (await response.json().catch(() => null)) as
    | DashboardUploadIntentResponse
    | AssetErrorResponse
    | null;
  if (!response.ok || !body || body.status !== "ok") {
    throw new Error(body && "message" in body ? body.message : "Could not prepare upload");
  }
  return body;
}

function directUploadResponseToAssetUpload(body: DirectUploadResponse): AssetUploadResponse | null {
  if (
    typeof body.asset_id !== "string" ||
    typeof body.source_state !== "string" ||
    typeof body.playable_state !== "string"
  ) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    status: "ok",
    asset: {
      asset_id: body.asset_id,
      source_state: body.source_state,
      playable_state: body.playable_state,
      created_at: now,
      updated_at: now,
      source_byte_size: typeof body.byte_size === "number" && Number.isFinite(body.byte_size) ? body.byte_size : undefined,
      artifact_count: 1,
    },
  };
}

function uploadErrorMessage(status: number, body: DirectUploadResponse | AssetErrorResponse | null) {
  if (body) {
    if ("message" in body && typeof body.message === "string") return body.message;
    if ("error" in body && typeof body.error === "string") return body.error;
  }
  return `Upload failed with HTTP ${status}`;
}

async function uploadFile(file: File, onProgress: (progress: number | null) => void) {
  const uploadIntent = await requestUploadIntent(file);

  return new Promise<AssetUploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadIntent.upload_url);
    xhr.responseType = "json";
    xhr.withCredentials = false;
    xhr.setRequestHeader("authorization", `Bearer ${uploadIntent.token}`);
    xhr.setRequestHeader("content-type", uploadIntent.content_type);

    xhr.upload.onprogress = (event) => {
      onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    };
    xhr.onload = () => {
      const body = xhr.response as DirectUploadResponse | AssetUploadResponse | AssetErrorResponse | null;
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        if ("asset" in body) {
          resolve(body as AssetUploadResponse);
          return;
        }
        const uploadResponse = directUploadResponseToAssetUpload(body);
        if (uploadResponse) {
          resolve(uploadResponse);
          return;
        }
        reject(new Error("Rend API returned an invalid upload response"));
      } else {
        const errorBody = body && !("asset" in body) ? body : null;
        reject(new Error(uploadErrorMessage(xhr.status, errorBody)));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(file);
  });
}

export default function AssetsClient({
  dashboardState,
  initialAssets,
  initialError,
  readOnlyReason,
}: {
  dashboardState: DashboardState;
  initialAssets: AssetSummary[];
  initialError?: string;
  readOnlyReason?: string;
}) {
  const [assets, setAssets] = useState(initialAssets);
  const [listError, setListError] = useState(initialError ?? "");
  const [upload, setUpload] = useState<UploadState>({ status: "idle" });
  const [refreshing, setRefreshing] = useState(false);

  const sortedAssets = useMemo(
    () => [...assets].sort((left, right) => right.created_at.localeCompare(left.created_at)),
    [assets]
  );
  const uploadDisabledReason =
    readOnlyReason ?? (dashboardState.blocksUpload ? dashboardState.message : undefined);

  async function refreshAssets() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/assets", { cache: "no-store" });
      const body = (await response.json()) as AssetListResponse | AssetErrorResponse;
      if (!response.ok || body.status !== "ok") {
        throw new Error("message" in body ? body.message : "Refresh failed");
      }
      setAssets(body.assets);
      setListError("");
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (uploadDisabledReason) {
      setUpload({ status: "error", message: uploadDisabledReason });
      return;
    }

    setUpload({ status: "uploading", progress: null });
    try {
      const result = await uploadFile(file, (progress) => {
        setUpload({ status: "uploading", progress });
      });
      setAssets((current) => [result.asset, ...current.filter((asset) => asset.asset_id !== result.asset.asset_id)]);
      setUpload({ status: "done", message: `Uploaded ${file.name}` });
    } catch (error) {
      setUpload({
        status: "error",
        message: error instanceof Error ? error.message : "Upload failed",
      });
    }
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <a href="/" aria-label="Rend home">
          <img src="/rend-logo.svg" alt="Rend" className="app-logo" />
        </a>
        <nav>
          <Link href="/dashboard/api-keys">API keys</Link>
          <Link href="/dashboard/billing">Billing</Link>
          <button onClick={refreshAssets} disabled={refreshing} type="button">
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button onClick={signOutOfDashboard} type="button">
            Sign out
          </button>
        </nav>
      </header>

      <main className="app-main">
        <section className="app-page-head">
          <div>
            <p className="app-kicker">Rend app</p>
            <h1>Assets</h1>
          </div>
          <label className="app-upload-button" aria-disabled={Boolean(uploadDisabledReason)}>
            <input accept="video/*" disabled={Boolean(uploadDisabledReason)} onChange={onFileChange} type="file" />
            {uploadDisabledReason ? "Uploads disabled" : "Upload video"}
          </label>
        </section>

        <section className="app-callout app-callout-done">
          <div>
            <strong>Workspace setup</strong>
            <span>Your workspace was created automatically after email verification.</span>
          </div>
        </section>

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

        {upload.status !== "idle" ? (
          <section className={`app-callout app-callout-${upload.status}`}>
            {upload.status === "uploading" ? (
              <>
                <span>Uploading</span>
                <div className="app-progress" aria-label="Upload progress">
                  <span style={{ width: `${upload.progress ?? 12}%` }} />
                </div>
                <strong>{upload.progress === null ? "Streaming..." : `${upload.progress}%`}</strong>
              </>
            ) : (
              <span>{upload.message}</span>
            )}
          </section>
        ) : null}

        {listError ? (
          <section className="app-callout app-callout-error">
            <span>{listError}</span>
          </section>
        ) : null}

        <section className="app-panel">
          {sortedAssets.length === 0 ? (
            <div className="app-empty">No assets uploaded yet.</div>
          ) : (
            <div className="app-table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Source</th>
                    <th>Playable</th>
                    <th>Access</th>
                    <th>Size</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedAssets.map((asset) => (
                    <tr key={asset.asset_id}>
                      <td className="app-mono">{asset.asset_id}</td>
                      <td>
                        <span className={`app-pill app-state-${asset.source_state}`}>
                          {asset.source_state}
                        </span>
                      </td>
                      <td>
                        <span className={`app-pill app-state-${asset.playable_state}`}>
                          {asset.playable_state}
                        </span>
                      </td>
                      <td>
                        {asset.suspended_at || asset.organization_suspended_at ? (
                          <span className="app-pill app-state-suspended">suspended</span>
                        ) : (
                          <span className="app-pill app-state-ready">active</span>
                        )}
                      </td>
                      <td>{formatBytes(asset.source_byte_size)}</td>
                      <td>{formatTimestamp(asset.updated_at)}</td>
                      <td>
                        <Link className="app-link-button" href={`/dashboard/assets/${asset.asset_id}`}>
                          Inspect
                        </Link>
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
