"use client";

import { ArrowLeft, Code, Eye, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetDetail,
  AssetDeleteResponse,
  AssetPlaybackAnalytics,
  AssetPlayerTelemetryEvent,
  AssetPlayerTelemetryResponse,
} from "../lib/asset-types.ts";
import { isAssetPlayable, isAssetProcessingComplete } from "../lib/asset-lifecycle.ts";
import EmbedCustomizer from "./EmbedCustomizer";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  Callout,
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
  Tabs,
} from "@/components/dashboard";

type AssetTab = "overview" | "artifacts" | "analytics" | "embed";

type DetailResponse = { status: "ok"; asset: AssetDetail };
type AnalyticsResponse = { status: "ok"; analytics: AssetPlaybackAnalytics };

const MAX_PROCESSING_POLLS = 30;

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">{label}</dt>
      <dd className="mt-1.5 text-[13.5px] text-ink-soft">{children}</dd>
    </div>
  );
}

export default function AssetDetailClient({
  initialAnalytics,
  initialAsset,
  initialTab,
  initialTelemetry,
  readOnlyReason,
}: {
  initialAnalytics: AssetPlaybackAnalytics | null;
  initialAsset: AssetDetail;
  initialTab: AssetTab;
  initialTelemetry: AssetPlayerTelemetryEvent[];
  readOnlyReason?: string;
}) {
  const [asset, setAsset] = useState(initialAsset);
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [origin, setOrigin] = useState("");
  const [pollError, setPollError] = useState("");
  const [pollExhausted, setPollExhausted] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [deleteState, setDeleteState] = useState<"idle" | "deleting" | "deleted" | "error">("idle");
  const [deleteMessage, setDeleteMessage] = useState("");
  const [tab, setTab] = useState<AssetTab>(initialTab);
  const pollAttempt = useRef(0);
  const router = useRouter();
  const pathname = usePathname();

  const assetId = asset.asset_id;
  const embedPath = `/embed/${assetId}`;
  const watchPath = `/watch/${assetId}`;
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
        "message" in body && typeof body.message === "string" ? body.message : "Asset refresh failed";
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
    setTab(initialTab);
  }, [initialTab]);

  const selectTab = useCallback(
    (next: AssetTab) => {
      setTab(next);
      const target = next === "overview" ? pathname : `${pathname}?tab=${next}`;
      router.push(target, { scroll: false });
    },
    [pathname, router],
  );

  useEffect(() => {
    if (
      isAssetProcessingComplete(asset.playable_state) ||
      pollExhausted ||
      deleteState === "deleted"
    ) {
      return;
    }
    if (pollAttempt.current >= MAX_PROCESSING_POLLS) {
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
          "message" in body && typeof body.message === "string" ? body.message : "Delete failed";
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

  const artifactRows = useMemo(
    () => [...asset.artifacts].sort((left, right) => left.kind.localeCompare(right.kind)),
    [asset.artifacts]
  );

  const showPreview = isAssetPlayable(asset.playable_state) && deleteState !== "deleted" && !readOnly;

  const artifactCount = artifactRows.length;
  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "artifacts", label: artifactCount ? `Artifacts (${artifactCount})` : "Artifacts" },
    { value: "analytics", label: "Analytics" },
    { value: "embed", label: "Embed" },
  ];
  const metricsRefresh = (
    <Button
      variant="secondary"
      size="sm"
      className="rounded-md"
      onClick={refreshMetrics}
      disabled={metricsLoading || readOnly}
    >
      <RefreshCw className={cn("size-3.5", metricsLoading && "animate-spin")} />
      {metricsLoading ? "Refreshing" : "Refresh"}
    </Button>
  );

  return (
    <>
      <SubHeader
        title={<span className="font-mono text-[13.5px] sm:text-[14.5px]">{assetId}</span>}
        docsHref="/docs#playback-embed"
        leading={
          <Link
            href="/dashboard/assets"
            aria-label="Back to assets"
            className="-ml-0.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-bg-sunken hover:text-ink"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden lg:inline">Assets</span>
          </Link>
        }
        actions={
          <>
            {!readOnly ? (
              <>
                <Button
                  href={watchPath}
                  external
                  variant="secondary"
                  size="sm"
                  className="rounded-md"
                  aria-label="Watch"
                >
                  <Eye className="size-4" />
                  <span className="hidden md:inline">Watch</span>
                </Button>
                <Button
                  href={embedPath}
                  external
                  variant="secondary"
                  size="sm"
                  className="rounded-md"
                  aria-label="Embed"
                >
                  <Code className="size-4" />
                  <span className="hidden md:inline">Embed</span>
                </Button>
              </>
            ) : null}
            <button
              type="button"
              onClick={deleteAsset}
              disabled={readOnly || deleteState === "deleting" || deleteState === "deleted"}
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-[#eccac6] bg-[#fcf3f1] px-3 text-[13px] font-medium text-[#9a2b22] transition-colors hover:bg-[#f9e7e3] disabled:pointer-events-none disabled:opacity-45"
            >
              <Trash2 className="size-4" />
              <span className="hidden sm:inline">{deleteState === "deleting" ? "Deleting" : "Delete"}</span>
            </button>
          </>
        }
      />

      <DashboardContent>
        <div className="mb-5 flex flex-col gap-3 empty:hidden">
        {readOnly ? <Callout tone="danger">{suspensionReason}</Callout> : null}
        {deleteMessage ? (
          <Callout tone={deleteState === "error" ? "danger" : "success"}>{deleteMessage}</Callout>
        ) : null}
        {pollError ? <Callout tone="danger">{pollError}</Callout> : null}
        {pollExhausted && !isAssetProcessingComplete(asset.playable_state) ? (
          <Callout tone="warn">
            Processing is taking longer than expected. The opener remains playable; refresh to check
            for the final adaptive stream.
          </Callout>
        ) : null}
      </div>

        <Tabs
          items={tabs}
          value={tab}
          onValueChange={(value) => selectTab(value as AssetTab)}
          ariaLabel="Asset sections"
          className="mb-5"
        />

        {tab === "overview" ? (
          <div className="flex flex-col gap-5">
            {showPreview ? (
              <div className="overflow-hidden rounded-xl border border-line bg-[#0f1115]">
                <iframe
                  allow="autoplay; fullscreen; picture-in-picture"
                  className="block aspect-video w-full border-0"
                  src={embedPath}
                  title={`Rend asset ${assetId}`}
                />
              </div>
            ) : (
              <Panel>
                <p className="py-6 text-center text-[13.5px] text-muted">
                  {readOnly
                    ? "Playback is unavailable while suspended."
                    : asset.playable_state === "deleted"
                      ? "Playback is unavailable."
                      : "Waiting for a playable rendition."}
                </p>
              </Panel>
            )}

            <Panel title="State">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
                <Field label="Source">
                  <StatusBadge state={asset.source_state} />
                </Field>
                <Field label="Playable">
                  <StatusBadge state={asset.playable_state} />
                </Field>
                <Field label="Access">
                  <StatusBadge tone={readOnly ? "danger" : "success"}>
                    {readOnly ? "Suspended" : "Active"}
                  </StatusBadge>
                </Field>
                <Field label="Source size">
                  <span className="font-mono text-[13px]">{formatBytes(asset.source_byte_size)}</span>
                </Field>
                <Field label="Updated">
                  <span className="font-mono text-[12.5px]">{formatTimestamp(asset.updated_at)}</span>
                </Field>
              </dl>
            </Panel>
          </div>
        ) : null}

        {tab === "artifacts" ? (
          <Panel title="Artifacts" flush={artifactRows.length > 0}>
            {artifactRows.length === 0 ? (
              <p className="text-[13.5px] text-muted">No artifacts yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Kind</TH>
                    <TH>Type</TH>
                    <TH className="text-right">Size</TH>
                  </TR>
                </THead>
                <TBody>
                  {artifactRows.map((artifact, index) => (
                    <TR key={`${artifact.kind}-${index}`}>
                      <TD className="font-medium text-ink">{artifact.kind}</TD>
                      <TD className="font-mono text-[12px] text-muted">{artifact.content_type}</TD>
                      <TD className="text-right font-mono text-[12px] text-muted">
                        {formatBytes(artifact.byte_size)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Panel>
        ) : null}

        {tab === "analytics" ? (
          <div className="flex flex-col gap-5">
            <Panel title="Edge requests" actions={metricsRefresh}>
              {analytics ? (
                <>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
                    <Field label="Requests">
                      <span className="font-mono text-[13px] tabular-nums text-ink">{analytics.request_count}</span>
                    </Field>
                    <Field label="Bytes">
                      <span className="font-mono text-[13px]">{formatBytes(analytics.bytes_served)}</span>
                    </Field>
                    <Field label="First seen">
                      <span className="font-mono text-[12.5px]">{formatTimestamp(analytics.first_seen)}</span>
                    </Field>
                    <Field label="Last seen">
                      <span className="font-mono text-[12.5px]">{formatTimestamp(analytics.last_seen)}</span>
                    </Field>
                  </dl>
                  <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line-soft pt-4">
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">Cache</p>
                      <div className="flex flex-col gap-0.5 font-mono text-[12px] text-ink-soft">
                        {countRows(analytics.cache_status_counts).map(([key, value]) => (
                          <span key={key}>
                            {key}: {value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">Status</p>
                      <div className="flex flex-col gap-0.5 font-mono text-[12px] text-ink-soft">
                        {countRows(analytics.status_code_counts).map(([key, value]) => (
                          <span key={key}>
                            {key}: {value}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-[13.5px] text-muted">No edge request metrics yet.</p>
              )}
            </Panel>

            <Panel title="Player startup" actions={metricsRefresh} flush={telemetry.length > 0}>
              {telemetry.length === 0 ? (
                <p className="text-[13.5px] text-muted">No startup telemetry yet.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Phase</TH>
                      <TH>Mode</TH>
                      <TH className="text-right">Bootstrap</TH>
                      <TH className="text-right">Canplay</TH>
                      <TH className="text-right">First frame</TH>
                      <TH className="hidden text-right md:table-cell">Received</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {telemetry.map((event) => (
                      <TR key={`${event.playback_session_id}-${event.phase}-${event.received_at_ms}`}>
                        <TD className="font-medium text-ink">{event.phase}</TD>
                        <TD className="font-mono text-[12px] text-muted">{event.selected_playback_mode || "-"}</TD>
                        <TD className="text-right font-mono text-[12px] tabular-nums text-ink-soft">
                          {event.bootstrap_duration_ms ?? "-"}
                        </TD>
                        <TD className="text-right font-mono text-[12px] tabular-nums text-ink-soft">
                          {event.canplay_ms ?? "-"}
                        </TD>
                        <TD className="text-right font-mono text-[12px] tabular-nums text-ink-soft">
                          {event.first_frame_ms ?? "-"}
                        </TD>
                        <TD className="hidden text-right font-mono text-[12px] text-muted md:table-cell">
                          {formatTimestamp(new Date(event.received_at_ms).toISOString())}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Panel>
          </div>
        ) : null}

        {tab === "embed" ? (
          <EmbedCustomizer
            origin={origin}
            embedPath={embedPath}
            assetId={assetId}
            previewable={showPreview}
            disabled={readOnly}
          />
        ) : null}
      </DashboardContent>
    </>
  );
}
