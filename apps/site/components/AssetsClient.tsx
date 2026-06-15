"use client";

import Link from "next/link";
import { ChangeEvent, useMemo, useState } from "react";
import type {
  AssetListResponse,
  AssetSummary,
  AssetErrorResponse,
  AssetUploadResponse,
} from "../lib/asset-types.ts";
import { signOutOfDashboard } from "../lib/auth-client.ts";
import type { DashboardState } from "../lib/dashboard-state.ts";

type UploadState =
  | { status: "idle" }
  | { status: "uploading"; progress: number | null }
  | { status: "error"; message: string }
  | { status: "done"; message: string };

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

function uploadFile(file: File, onProgress: (progress: number | null) => void) {
  return new Promise<AssetUploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/assets");
    xhr.responseType = "json";
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    };
    xhr.onload = () => {
      const body = xhr.response as AssetUploadResponse | { message?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body && "asset" in body) {
        resolve(body);
      } else {
        const message =
          body && "message" in body && typeof body.message === "string"
            ? body.message
            : `Upload failed with HTTP ${xhr.status}`;
        reject(new Error(message));
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
