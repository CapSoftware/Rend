"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetDetail,
  AssetDeleteResponse,
  AssetPlaybackAnalytics,
  AssetPlayerTelemetryEvent,
  AssetPlayerTelemetryResponse,
} from "../lib/asset-types.ts";

type DetailResponse = { status: "ok"; asset: AssetDetail };
type AnalyticsResponse = { status: "ok"; analytics: AssetPlaybackAnalytics };

const MAX_PLAYABLE_POLLS = 30;

function playable(state: string) {
  return state === "opener_ready" || state === "hls_ready";
}

function terminal(state: string) {
  return playable(state) || state === "failed" || state === "deleted";
}

function pollDelay(attempt: number) {
  return Math.min(2_000 * Math.pow(1.35, attempt), 10_000);
}

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

function formatTimestamp(value: string | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function countRows(counts: Record<string, number>) {
  return Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
}

export default function AssetDetailClient({
  initialAnalytics,
  initialAsset,
  initialTelemetry,
  readOnlyReason,
}: {
  initialAnalytics: AssetPlaybackAnalytics | null;
  initialAsset: AssetDetail;
  initialTelemetry: AssetPlayerTelemetryEvent[];
  readOnlyReason?: string;
}) {
  const [asset, setAsset] = useState(initialAsset);
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [pollError, setPollError] = useState("");
  const [pollExhausted, setPollExhausted] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [deleteState, setDeleteState] = useState<
    "idle" | "deleting" | "deleted" | "error"
  >("idle");
  const [deleteMessage, setDeleteMessage] = useState("");
  const pollAttempt = useRef(0);

  const assetId = asset.asset_id;
  const embedPath = `/embed/${assetId}`;
  const watchPath = `/watch/${assetId}`;
  const embedUrl = `${origin}${embedPath}`;
  const iframeSnippet = `<iframe src="${embedUrl || embedPath}" width="960" height="540" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  const suspensionReason =
    readOnlyReason ??
    (asset.suspended_at
      ? asset.suspension_reason
        ? `Asset is suspended: ${asset.suspension_reason}`
        : "Asset is suspended. Playback and mutations are unavailable."
      : asset.organization_suspended_at
        ? asset.organization_suspension_reason
          ? `Organization is suspended: ${asset.organization_suspension_reason}`
          : "Organization is suspended. This asset is read-only."
        : "");
  const readOnly = Boolean(suspensionReason);

  const refreshAsset = useCallback(async () => {
    const response = await fetch(`/api/assets/${assetId}`, { cache: "no-store" });
    const body = (await response.json()) as DetailResponse | { message?: string };
    if (!response.ok || !("asset" in body)) {
      const message =
        "message" in body && typeof body.message === "string"
          ? body.message
          : "Asset refresh failed";
      throw new Error(message);
    }
    setAsset(body.asset);
    return body.asset;
  }, [assetId]);

  const refreshMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const [analyticsResponse, telemetryResponse] = await Promise.all([
        fetch(`/api/assets/${assetId}/analytics?windowSeconds=3600`, { cache: "no-store" }),
        fetch(`/api/assets/player-telemetry/recent?assetId=${encodeURIComponent(assetId)}&limit=20`, {
          cache: "no-store",
        }),
      ]);
      if (analyticsResponse.ok) {
        const body = (await analyticsResponse.json()) as AnalyticsResponse;
        setAnalytics(body.analytics);
      }
      if (telemetryResponse.ok) {
        const body = (await telemetryResponse.json()) as AssetPlayerTelemetryResponse;
        setTelemetry(body.events);
      }
    } finally {
      setMetricsLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (terminal(asset.playable_state) || pollExhausted || deleteState === "deleted") return;
    if (pollAttempt.current >= MAX_PLAYABLE_POLLS) {
      setPollExhausted(true);
      return;
    }

    const attempt = pollAttempt.current;
    const timer = window.setTimeout(() => {
      pollAttempt.current += 1;
      refreshAsset()
        .then(() => setPollError(""))
        .catch((error) => {
          setPollError(error instanceof Error ? error.message : "Asset refresh failed");
        })
        .finally(() => setPollVersion((version) => version + 1));
    }, pollDelay(attempt));

    return () => window.clearTimeout(timer);
  }, [asset.playable_state, deleteState, pollExhausted, pollVersion, refreshAsset]);

  async function copyText(label: string, value: string) {
    if (readOnly) return;
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1_500);
  }

  async function deleteAsset() {
    if (readOnly) {
      setDeleteState("error");
      setDeleteMessage(suspensionReason);
      return;
    }
    if (!window.confirm(`Delete asset ${assetId}?`)) return;

    setDeleteState("deleting");
    setDeleteMessage("");
    try {
      const response = await fetch(`/api/assets/${assetId}`, {
        method: "DELETE",
        cache: "no-store",
      });
      const body = (await response.json()) as AssetDeleteResponse | { message?: string };
      if (!response.ok || !("deleted" in body)) {
        const message =
          "message" in body && typeof body.message === "string"
            ? body.message
            : "Delete failed";
        throw new Error(message);
      }

      setAsset((current) => ({
        ...current,
        source_state: "deleted",
        playable_state: "deleted",
      }));

      const playbackResponse = await fetch(`/api/player/${assetId}`, { cache: "no-store" });
      const playbackBody = await playbackResponse.json().catch(() => ({}));
      const serialized = JSON.stringify(playbackBody);
      const unavailable = !playbackResponse.ok || playbackBody.status !== "ready";

      if (!unavailable || serialized.includes("playback_url") || serialized.includes("token=")) {
        throw new Error("Playback bootstrap still returned a playable source");
      }

      setDeleteState("deleted");
      setDeleteMessage("Deleted and playback bootstrap no longer returns a playable source.");
    } catch (error) {
      setDeleteState("error");
      setDeleteMessage(error instanceof Error ? error.message : "Delete failed");
    }
  }

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST", cache: "no-store" }).catch(() => undefined);
    window.location.assign("/login");
  }

  const artifactRows = useMemo(
    () => [...asset.artifacts].sort((left, right) => left.kind.localeCompare(right.kind)),
    [asset.artifacts]
  );

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <Link href="/dashboard/assets" className="app-back-link">
          Assets
        </Link>
        <nav>
          <Link href="/dashboard/api-keys">API keys</Link>
          {readOnly ? null : (
            <a href={watchPath} rel="noreferrer" target="_blank">
              Open watch
            </a>
          )}
          {readOnly ? null : (
            <a href={embedPath} rel="noreferrer" target="_blank">
              Open embed
            </a>
          )}
          <button onClick={signOut} type="button">
            Sign out
          </button>
        </nav>
      </header>

      <main className="app-main app-detail-main">
        <section className="app-page-head app-detail-head">
          <div>
            <p className="app-kicker">Asset</p>
            <h1 className="app-asset-title">{assetId}</h1>
          </div>
          <div className="app-detail-actions">
            <button disabled={readOnly} onClick={() => copyText("embed-url", embedUrl || embedPath)} type="button">
              Copy embed URL
            </button>
            <button disabled={readOnly} onClick={() => copyText("iframe", iframeSnippet)} type="button">
              Copy iframe
            </button>
            <button
              className="app-danger"
              disabled={readOnly || deleteState === "deleting" || deleteState === "deleted"}
              onClick={deleteAsset}
              type="button"
            >
              {deleteState === "deleting" ? "Deleting..." : "Delete"}
            </button>
          </div>
        </section>

        {copied ? <section className="app-callout app-callout-done">Copied {copied}.</section> : null}
        {readOnly ? <section className="app-callout app-callout-error">{suspensionReason}</section> : null}
        {deleteMessage ? (
          <section className={`app-callout app-callout-${deleteState === "error" ? "error" : "done"}`}>
            {deleteMessage}
          </section>
        ) : null}
        {pollError ? <section className="app-callout app-callout-error">{pollError}</section> : null}
        {pollExhausted && !terminal(asset.playable_state) ? (
          <section className="app-callout app-callout-error">
            Playable polling stopped. Refresh the asset when the worker finishes.
          </section>
        ) : null}

        <section className="app-detail-grid">
          <div className="app-panel">
            <h2>State</h2>
            <dl className="app-stats">
              <div>
                <dt>Source</dt>
                <dd>
                  <span className={`app-pill app-state-${asset.source_state}`}>{asset.source_state}</span>
                </dd>
              </div>
              <div>
                <dt>Playable</dt>
                <dd>
                  <span className={`app-pill app-state-${asset.playable_state}`}>{asset.playable_state}</span>
                </dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>
                  <span className={`app-pill ${readOnly ? "app-state-suspended" : "app-state-ready"}`}>
                    {readOnly ? "suspended" : "active"}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Source size</dt>
                <dd>{formatBytes(asset.source_byte_size)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatTimestamp(asset.updated_at)}</dd>
              </div>
            </dl>
          </div>

          <div className="app-panel">
            <h2>Embed</h2>
            <div className="app-code-block">{embedUrl || embedPath}</div>
            <div className="app-code-block">{iframeSnippet}</div>
          </div>
        </section>

        {playable(asset.playable_state) && deleteState !== "deleted" && !readOnly ? (
          <section className="app-panel app-preview-panel">
            <iframe
              allow="autoplay; fullscreen; picture-in-picture"
              className="app-preview"
              src={embedPath}
              title={`Rend asset ${assetId}`}
            />
          </section>
        ) : (
          <section className="app-panel app-empty">
            {readOnly
              ? "Playback is unavailable while suspended."
              : asset.playable_state === "deleted"
                ? "Playback is unavailable."
                : "Waiting for a playable rendition."}
          </section>
        )}

        <section className="app-detail-grid">
          <div className="app-panel">
            <h2>Artifacts</h2>
            {artifactRows.length === 0 ? (
              <div className="app-empty">No artifacts yet.</div>
            ) : (
              <table className="app-table app-compact-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Type</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {artifactRows.map((artifact, index) => (
                    <tr key={`${artifact.kind}-${index}`}>
                      <td>{artifact.kind}</td>
                      <td>{artifact.content_type}</td>
                      <td>{formatBytes(artifact.byte_size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="app-panel">
            <div className="app-panel-title-row">
              <h2>Edge requests</h2>
              <button disabled={metricsLoading || readOnly} onClick={refreshMetrics} type="button">
                {metricsLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            {analytics ? (
              <>
                <dl className="app-stats app-metric-stats">
                  <div>
                    <dt>Requests</dt>
                    <dd>{analytics.request_count}</dd>
                  </div>
                  <div>
                    <dt>Bytes</dt>
                    <dd>{formatBytes(analytics.bytes_served)}</dd>
                  </div>
                  <div>
                    <dt>First seen</dt>
                    <dd>{formatTimestamp(analytics.first_seen)}</dd>
                  </div>
                  <div>
                    <dt>Last seen</dt>
                    <dd>{formatTimestamp(analytics.last_seen)}</dd>
                  </div>
                </dl>
                <div className="app-counts">
                  <div>
                    <h3>Cache</h3>
                    {countRows(analytics.cache_status_counts).map(([key, value]) => (
                      <span key={key}>
                        {key}: {value}
                      </span>
                    ))}
                  </div>
                  <div>
                    <h3>Status</h3>
                    {countRows(analytics.status_code_counts).map(([key, value]) => (
                      <span key={key}>
                        {key}: {value}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="app-empty">No edge request metrics yet.</div>
            )}
          </div>
        </section>

        <section className="app-panel">
          <div className="app-panel-title-row">
            <h2>Player startup</h2>
            <button disabled={metricsLoading || readOnly} onClick={refreshMetrics} type="button">
              {metricsLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          {telemetry.length === 0 ? (
            <div className="app-empty">No startup telemetry yet.</div>
          ) : (
            <div className="app-table-wrap">
              <table className="app-table app-compact-table">
                <thead>
                  <tr>
                    <th>Phase</th>
                    <th>Mode</th>
                    <th>Bootstrap</th>
                    <th>Canplay</th>
                    <th>First frame</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {telemetry.map((event) => (
                    <tr key={`${event.playback_session_id}-${event.phase}-${event.received_at_ms}`}>
                      <td>{event.phase}</td>
                      <td>{event.selected_playback_mode || "-"}</td>
                      <td>{event.bootstrap_duration_ms ?? "-"}</td>
                      <td>{event.canplay_ms ?? "-"}</td>
                      <td>{event.first_frame_ms ?? "-"}</td>
                      <td>{formatTimestamp(new Date(event.received_at_ms).toISOString())}</td>
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
