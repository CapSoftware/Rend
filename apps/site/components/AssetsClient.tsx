"use client";

import {
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  Ellipsis,
  ExternalLink,
  Eye,
  Inbox,
  Play,
  RefreshCw,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetListResponse,
  AssetSummary,
  AssetErrorResponse,
  AssetUploadResponse,
} from "../lib/asset-types.ts";
import type { DashboardUploadIntentResponse } from "../lib/dashboard-upload-token.ts";
import type { DashboardState } from "../lib/dashboard-state.ts";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
} from "@/components/dashboard";

const PAGE_SIZE = 10;

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

function formatCreated(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(ms: number) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minutesLabel = hours ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours ? `${hours}:` : ""}${minutesLabel}:${String(seconds).padStart(2, "0")}`;
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

function AssetThumb() {
  return (
    <span className="grid aspect-video w-16 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-bg-sunken">
      <Play className="size-3.5 fill-faint text-faint" />
    </span>
  );
}

function AssetRowActions({ assetId, origin }: { assetId: string; origin: string }) {
  const watchPath = `/watch/${assetId}`;
  const embedPath = `/embed/${assetId}`;
  const embedUrl = `${origin}${embedPath}`;
  const iframeSnippet = `<iframe src="${embedUrl || embedPath}" width="960" height="540" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;

  function copy(value: string) {
    void navigator.clipboard?.writeText(value).catch(() => {});
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Asset actions"
        className="inline-flex size-8 items-center justify-center rounded-md border border-line bg-card text-muted outline-none transition-colors hover:border-ink/25 hover:bg-bg-sunken hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/25 data-[state=open]:bg-bg-sunken data-[state=open]:text-ink"
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem asChild>
          <Link href={`/dashboard/assets/${assetId}`}>
            <Eye />
            Open details
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={watchPath} target="_blank" rel="noopener noreferrer">
            <ExternalLink />
            Watch video
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => copy(assetId)}>
          <Copy />
          Copy asset ID
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copy(iframeSnippet)}>
          <Code />
          Copy embed code
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
  const [page, setPage] = useState(0);
  const [origin, setOrigin] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const sortedAssets = useMemo(
    () => [...assets].sort((left, right) => right.created_at.localeCompare(left.created_at)),
    [assets]
  );

  const pageCount = Math.max(1, Math.ceil(sortedAssets.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageAssets = sortedAssets.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  const uploadDisabledReason =
    readOnlyReason ?? (dashboardState.blocksUpload ? dashboardState.message : undefined);
  const blocked = dashboardState.status !== "ready_to_upload";
  const blockedTone =
    dashboardState.status === "plan_limit_exceeded" || dashboardState.status === "billing_unavailable"
      ? "danger"
      : "warn";

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
      setPage(0);
      setUpload({ status: "done", message: `Uploaded ${file.name}` });
    } catch (error) {
      setUpload({
        status: "error",
        message: error instanceof Error ? error.message : "Upload failed",
      });
    }
  }

  return (
    <>
      <SubHeader
        title="Assets"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              className="rounded-md"
              onClick={refreshAssets}
              disabled={refreshing}
            >
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
              <span className="hidden sm:inline">{refreshing ? "Refreshing" : "Refresh"}</span>
            </Button>
            <Button
              size="sm"
              className="rounded-md"
              onClick={() => fileInputRef.current?.click()}
              disabled={Boolean(uploadDisabledReason)}
              title={uploadDisabledReason}
            >
              <Upload className="size-4" />
              <span className="hidden sm:inline">
                {uploadDisabledReason ? "Uploads disabled" : "Upload video"}
              </span>
            </Button>
          </>
        }
      />

      <DashboardContent>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="sr-only"
          disabled={Boolean(uploadDisabledReason)}
          onChange={onFileChange}
        />

        <div className="mb-5 flex flex-col gap-3 empty:hidden">
          {blocked ? (
            <Callout
              tone={blockedTone}
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

          {upload.status === "uploading" ? (
            <Callout tone="info" title="Uploading video" icon={null}>
              <div className="flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-sunken">
                  <div
                    className="h-full rounded-full bg-ink transition-[width] duration-200"
                    style={{ width: `${upload.progress ?? 12}%` }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-soft">
                  {upload.progress === null ? "Streaming" : `${upload.progress}%`}
                </span>
              </div>
            </Callout>
          ) : null}
          {upload.status === "done" ? <Callout tone="success">{upload.message}</Callout> : null}
          {upload.status === "error" ? <Callout tone="danger">{upload.message}</Callout> : null}

          {listError ? <Callout tone="danger">{listError}</Callout> : null}
        </div>

        <Panel
          flush
          footer={
            sortedAssets.length > 0 ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] text-muted">
                  {sortedAssets.length} {sortedAssets.length === 1 ? "asset" : "assets"}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label="Previous page"
                    disabled={currentPage === 0}
                    onClick={() => setPage(Math.max(0, currentPage - 1))}
                    className="inline-flex size-8 items-center justify-center rounded-md border border-line bg-card text-muted transition-colors hover:border-ink/25 hover:bg-bg-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <span className="px-1 text-[12.5px] tabular-nums text-ink-soft">
                    Page {currentPage + 1} of {pageCount}
                  </span>
                  <button
                    type="button"
                    aria-label="Next page"
                    disabled={currentPage >= pageCount - 1}
                    onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
                    className="inline-flex size-8 items-center justify-center rounded-md border border-line bg-card text-muted transition-colors hover:border-ink/25 hover:bg-bg-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>
              </div>
            ) : undefined
          }
        >
          {sortedAssets.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-bg-sunken text-faint">
                <Inbox className="size-6" />
              </span>
              <div>
                <p className="font-head text-[17px] text-ink">No assets yet</p>
                <p className="mt-1 text-[13.5px] text-muted">
                  Upload your first video to get a hosted, adaptive stream.
                </p>
              </div>
              {!uploadDisabledReason ? (
                <Button className="mt-1 rounded-md" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="size-4" />
                  Upload video
                </Button>
              ) : null}
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH className="w-[1%]">
                    <span className="sr-only">Thumbnail</span>
                  </TH>
                  <TH>Asset</TH>
                  <TH className="hidden md:table-cell">Duration</TH>
                  <TH>Status</TH>
                  <TH className="hidden sm:table-cell">Created</TH>
                  <TH className="w-[1%] text-right">
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {pageAssets.map((asset) => {
                  const suspended = Boolean(asset.suspended_at || asset.organization_suspended_at);
                  return (
                    <TR key={asset.asset_id}>
                      <TD className="pr-0">
                        <Link href={`/dashboard/assets/${asset.asset_id}`} aria-label={`Open ${asset.asset_id}`}>
                          <AssetThumb />
                        </Link>
                      </TD>
                      <TD>
                        <Link
                          href={`/dashboard/assets/${asset.asset_id}`}
                          className="block min-w-0 max-w-[40ch] truncate font-mono text-[12.5px] text-ink transition-colors hover:text-accent"
                        >
                          {asset.asset_id}
                        </Link>
                      </TD>
                      <TD className="hidden whitespace-nowrap font-mono text-[12px] text-muted md:table-cell">
                        {typeof asset.duration_ms === "number" ? formatDuration(asset.duration_ms) : "-"}
                      </TD>
                      <TD>
                        <div className="flex items-center gap-1.5">
                          <StatusBadge state={asset.playable_state} />
                          {suspended ? <StatusBadge state="suspended" /> : null}
                        </div>
                      </TD>
                      <TD
                        className="hidden whitespace-nowrap text-[12.5px] text-muted sm:table-cell"
                        suppressHydrationWarning
                      >
                        {formatCreated(asset.created_at)}
                      </TD>
                      <TD className="text-right">
                        <AssetRowActions assetId={asset.asset_id} origin={origin} />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Panel>
      </DashboardContent>
    </>
  );
}
