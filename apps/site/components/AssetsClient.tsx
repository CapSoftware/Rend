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
  X,
} from "lucide-react";
import Link from "next/link";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetListResponse,
  AssetSummary,
  AssetErrorResponse,
  AssetUploadResponse,
  MultipartUploadCompletedPart,
  MultipartUploadPartIntent,
  MultipartUploadPartRequest,
  MultipartUploadPartsResponse,
  MultipartUploadSession,
} from "../lib/asset-types.ts";
import type { DashboardUploadIntentResponse } from "../lib/dashboard-upload-token.ts";
import type { DashboardState } from "../lib/dashboard-state.ts";
import { shouldRefreshAssetLifecycle } from "../lib/asset-lifecycle.ts";
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
const MIN_MULTIPART_PART_SIZE = 16 * 1024 * 1024;
const MAX_MULTIPART_PART_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_PARALLEL_PARTS = 6;
const MAX_SIGNED_PARTS_PER_REQUEST = 10;
const MAX_PART_ATTEMPTS = 3;

type UploadResumeContext = {
  idempotencyKey: string;
  uploadId?: string;
  assetId?: string;
  completedParts: MultipartUploadCompletedPart[];
};

type UploadItem = {
  id: string;
  file: File;
  status: "queued" | "uploading" | "done" | "error" | "cancelled";
  progress: number;
  message?: string;
  resume?: UploadResumeContext;
};

class MultipartUploadFailure extends Error {
  constructor(
    message: string,
    readonly resume?: UploadResumeContext
  ) {
    super(message);
    this.name = "MultipartUploadFailure";
  }
}

class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

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

function uploadErrorMessage(status: number, body: AssetErrorResponse | null) {
  if (body) {
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  }
  return `Upload failed with HTTP ${status}`;
}

function isUploadSession(value: unknown): value is MultipartUploadSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.asset_id === "string" &&
    typeof session.upload_id === "string" &&
    typeof session.part_size === "number" &&
    Number.isInteger(session.part_size) &&
    session.part_size >= MIN_MULTIPART_PART_SIZE &&
    session.part_size <= MAX_MULTIPART_PART_SIZE &&
    typeof session.part_count === "number" &&
    Number.isInteger(session.part_count) &&
    session.part_count > 0 &&
    typeof session.max_parallel_parts === "number" &&
    Number.isInteger(session.max_parallel_parts) &&
    session.max_parallel_parts === MAX_PARALLEL_PARTS &&
    typeof session.expires_at === "string" &&
    ["uploading", "completing", "completed", "aborted", "expired", "failed"].includes(
      String(session.status)
    ) &&
    Array.isArray(session.uploaded_parts) &&
    session.uploaded_parts.every((part) => {
      if (!part || typeof part !== "object") return false;
      const candidate = part as Record<string, unknown>;
      return (
        typeof candidate.part_number === "number" &&
        Number.isInteger(candidate.part_number) &&
        candidate.part_number > 0 &&
        typeof candidate.etag === "string" &&
        (candidate.checksum_sha256 === undefined ||
          candidate.checksum_sha256 === null ||
          typeof candidate.checksum_sha256 === "string") &&
        typeof candidate.size === "number" &&
        Number.isInteger(candidate.size) &&
        candidate.size > 0
      );
    })
  );
}

function isUploadPartsResponse(value: unknown): value is MultipartUploadPartsResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.upload_id === "string" &&
    Array.isArray(response.parts) &&
    response.parts.every((part) => {
      if (!part || typeof part !== "object") return false;
      const candidate = part as Record<string, unknown>;
      return (
        typeof candidate.part_number === "number" &&
        Number.isInteger(candidate.part_number) &&
        candidate.part_number > 0 &&
        typeof candidate.url === "string" &&
        candidate.method === "PUT" &&
        Boolean(candidate.headers) &&
        typeof candidate.headers === "object" &&
        Object.values(candidate.headers as Record<string, unknown>).every(
          (header) => typeof header === "string"
        )
      );
    })
  );
}

async function uploadApiJson(
  url: string,
  token: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    ...init,
    signal,
    headers,
  });
  const body = (await response.json().catch(() => null)) as AssetErrorResponse | unknown;
  if (!response.ok) {
    throw new Error(uploadErrorMessage(response.status, body as AssetErrorResponse | null));
  }
  return body;
}

async function createUploadSession(
  file: File,
  uploadIntent: DashboardUploadIntentResponse,
  idempotencyKey: string,
  signal: AbortSignal
) {
  const body = await uploadApiJson(
    uploadIntent.upload_url,
    uploadIntent.token,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        content_type: uploadIntent.content_type,
        content_length: file.size,
        filename: file.name,
      }),
    },
    signal
  );
  if (!isUploadSession(body)) throw new Error("Rend API returned an invalid upload session");
  return body;
}

async function getUploadSession(
  uploadUrl: string,
  uploadId: string,
  token: string,
  signal: AbortSignal
) {
  const body = await uploadApiJson(
    `${uploadUrl}/${encodeURIComponent(uploadId)}`,
    token,
    { method: "GET" },
    signal
  );
  if (!isUploadSession(body)) throw new Error("Rend API returned an invalid upload session");
  return body;
}

async function requestSignedParts(
  uploadUrl: string,
  uploadId: string,
  token: string,
  parts: MultipartUploadPartRequest[],
  signal: AbortSignal
) {
  if (parts.length < 1 || parts.length > MAX_SIGNED_PARTS_PER_REQUEST) {
    throw new Error("Invalid multipart signing batch");
  }
  const body = await uploadApiJson(
    `${uploadUrl}/${encodeURIComponent(uploadId)}/parts`,
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
    },
    signal
  );
  if (!isUploadPartsResponse(body) || body.upload_id !== uploadId) {
    throw new Error("Rend API returned invalid signed upload parts");
  }
  return body.parts;
}

async function sha256Base64(blob: Blob, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function uploadPart(
  part: MultipartUploadPartIntent,
  body: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void
) {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => xhr.abort();

    xhr.open(part.method, part.url);
    for (const [name, value] of Object.entries(part.headers)) {
      if (["host", "content-length"].includes(name.toLowerCase())) continue;
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Part upload failed with HTTP ${xhr.status}`));
        return;
      }
      const etag = xhr.getResponseHeader("etag");
      if (!etag) {
        reject(new Error("Storage did not expose an ETag for the uploaded part"));
        return;
      }
      onProgress(body.size);
      resolve(etag);
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Part upload failed"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function waitBeforeRetry(attempt: number, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, attempt * 250);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function uploadPartWithRetry({
  uploadUrl,
  uploadId,
  token,
  partRequest,
  initialIntent,
  body,
  signal,
  limiter,
  onProgress,
}: {
  uploadUrl: string;
  uploadId: string;
  token: string;
  partRequest: MultipartUploadPartRequest;
  initialIntent: MultipartUploadPartIntent;
  body: Blob;
  signal: AbortSignal;
  limiter: ConcurrencyLimiter;
  onProgress: (loaded: number) => void;
}) {
  let intent = initialIntent;
  for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
    try {
      const etag = await limiter.run(() => uploadPart(intent, body, signal, onProgress));
      return { ...partRequest, etag };
    } catch (error) {
      if (isAbortError(error) || attempt === MAX_PART_ATTEMPTS) throw error;
      onProgress(0);
      const session = await getUploadSession(uploadUrl, uploadId, token, signal);
      if (session.status !== "uploading") {
        throw new Error(`Upload session is ${session.status}`);
      }
      await waitBeforeRetry(attempt, signal);
      const [refreshedIntent] = await requestSignedParts(
        uploadUrl,
        uploadId,
        token,
        [partRequest],
        signal
      );
      if (!refreshedIntent || refreshedIntent.part_number !== partRequest.part_number) {
        throw new Error("Rend API did not return the requested upload part");
      }
      intent = refreshedIntent;
    }
  }
  throw new Error("Part upload failed");
}

async function completeUpload(
  uploadUrl: string,
  uploadId: string,
  token: string,
  parts: MultipartUploadCompletedPart[],
  signal: AbortSignal
) {
  const body = await uploadApiJson(
    `${uploadUrl}/${encodeURIComponent(uploadId)}/complete`,
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
    },
    signal
  );
  if (!isUploadSession(body) || body.status !== "completed") {
    throw new Error("Rend API did not complete the upload session");
  }
  return body;
}

async function abortUpload(uploadUrl: string, uploadId: string, token: string) {
  await fetch(`${uploadUrl}/${encodeURIComponent(uploadId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
}

function completedSessionToAsset(session: MultipartUploadSession, file: File): AssetUploadResponse {
  const now = new Date().toISOString();
  return {
    status: "ok",
    asset: {
      asset_id: session.asset_id,
      source_state: "uploaded",
      playable_state: "not_playable",
      created_at: now,
      updated_at: now,
      source_byte_size: file.size,
      artifact_count: 1,
    },
  };
}

async function uploadFile(
  file: File,
  signal: AbortSignal,
  limiter: ConcurrencyLimiter,
  onProgress: (progress: number) => void,
  existingResume?: UploadResumeContext
) {
  if (file.size <= 0) throw new Error("Choose a non-empty video file");
  const uploadIntent = await requestUploadIntent(file);
  const resume: UploadResumeContext = existingResume ?? {
    idempotencyKey: crypto.randomUUID(),
    completedParts: [],
  };
  let session: MultipartUploadSession | undefined;

  try {
    if (resume.uploadId) {
      session = await getUploadSession(
        uploadIntent.upload_url,
        resume.uploadId,
        uploadIntent.token,
        signal
      );
    } else {
      session = await createUploadSession(
        file,
        uploadIntent,
        resume.idempotencyKey,
        signal
      );
      resume.uploadId = session.upload_id;
      resume.assetId = session.asset_id;
    }

    if (session.status === "completed") return completedSessionToAsset(session, file);
    if (session.status !== "uploading" && session.status !== "completing") {
      throw new Error(`Upload session is ${session.status}`);
    }
    if (session.part_count !== Math.ceil(file.size / session.part_size)) {
      throw new Error("Upload session part count does not match the selected file");
    }

    const uploadedPartNumbers = new Set<number>();
    resume.completedParts = await Promise.all(
      session.uploaded_parts.map(async ({ part_number, etag, checksum_sha256, size }) => {
        if (uploadedPartNumbers.has(part_number) || part_number > session!.part_count) {
          throw new Error("Upload session returned invalid completed parts");
        }
        uploadedPartNumbers.add(part_number);
        const start = (part_number - 1) * session!.part_size;
        const body = file.slice(start, Math.min(file.size, start + session!.part_size));
        if (body.size !== size) {
          throw new Error(`Uploaded part ${part_number} does not match the selected file`);
        }
        return {
          part_number,
          etag,
          checksum_sha256:
            checksum_sha256 ?? (await limiter.run(() => sha256Base64(body, signal))),
        };
      })
    );
    const loadedByPart = new Map<number, number>();
    for (const part of resume.completedParts) {
      const start = (part.part_number - 1) * session.part_size;
      loadedByPart.set(part.part_number, Math.min(session.part_size, file.size - start));
    }
    const reportProgress = () => {
      const loaded = [...loadedByPart.values()].reduce((total, value) => total + value, 0);
      onProgress(Math.min(100, Math.round((loaded / file.size) * 100)));
    };
    reportProgress();

    const completedByNumber = new Map(
      resume.completedParts.map((part) => [part.part_number, part])
    );
    const remainingPartNumbers = Array.from(
      { length: session.part_count },
      (_, index) => index + 1
    ).filter((partNumber) => !completedByNumber.has(partNumber));
    if (session.status === "completing" && remainingPartNumbers.length > 0) {
      throw new Error("Upload session is completing but has missing parts");
    }

    for (let offset = 0; offset < remainingPartNumbers.length; offset += MAX_SIGNED_PARTS_PER_REQUEST) {
      const partNumbers = remainingPartNumbers.slice(offset, offset + MAX_SIGNED_PARTS_PER_REQUEST);
      const requests = await Promise.all(
        partNumbers.map((partNumber) =>
          limiter.run(async () => {
            const start = (partNumber - 1) * session!.part_size;
            const body = file.slice(start, Math.min(file.size, start + session!.part_size));
            return {
              body,
              request: {
                part_number: partNumber,
                checksum_sha256: await sha256Base64(body, signal),
              },
            };
          })
        )
      );
      const intents = await requestSignedParts(
        uploadIntent.upload_url,
        session.upload_id,
        uploadIntent.token,
        requests.map(({ request }) => request),
        signal
      );
      const intentsByNumber = new Map(intents.map((part) => [part.part_number, part]));
      const settledParts = await Promise.allSettled(
        requests.map(({ body, request }) => {
          const intent = intentsByNumber.get(request.part_number);
          if (!intent) throw new Error(`Missing signed URL for part ${request.part_number}`);
          return uploadPartWithRetry({
            uploadUrl: uploadIntent.upload_url,
            uploadId: session!.upload_id,
            token: uploadIntent.token,
            partRequest: request,
            initialIntent: intent,
            body,
            signal,
            limiter,
            onProgress: (loaded) => {
              loadedByPart.set(request.part_number, loaded);
              reportProgress();
            },
          });
        })
      );
      for (const result of settledParts) {
        if (result.status === "fulfilled") {
          completedByNumber.set(result.value.part_number, result.value);
        }
      }
      resume.completedParts = [...completedByNumber.values()].sort(
        (left, right) => left.part_number - right.part_number
      );
      const failedPart = settledParts.find((result) => result.status === "rejected");
      if (failedPart?.status === "rejected") throw failedPart.reason;
    }

    session = await completeUpload(
      uploadIntent.upload_url,
      session.upload_id,
      uploadIntent.token,
      resume.completedParts,
      signal
    );
    onProgress(100);
    return completedSessionToAsset(session, file);
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      if (resume.uploadId) {
        await abortUpload(uploadIntent.upload_url, resume.uploadId, uploadIntent.token);
      }
      throw new DOMException("Upload cancelled", "AbortError");
    }
    throw new MultipartUploadFailure(
      error instanceof Error ? error.message : "Upload failed",
      resume
    );
  }
}

function AssetThumb({ assetId, hasThumbnail }: { assetId: string; hasThumbnail: boolean }) {
  const [showImage, setShowImage] = useState(true);
  const thumbnailSrc = `/api/assets/${encodeURIComponent(assetId)}/thumbnail`;
  const shouldLoadImage = hasThumbnail && showImage;

  return (
    <span className="grid aspect-video w-16 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-bg-sunken">
      {shouldLoadImage ? (
        <img
          src={thumbnailSrc}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setShowImage(false)}
        />
      ) : (
        <Play className="size-3.5 fill-faint text-faint" />
      )}
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
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const [origin, setOrigin] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const uploadLimiterRef = useRef(new ConcurrencyLimiter(MAX_PARALLEL_PARTS));
  const autoRefreshInFlightRef = useRef(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    const controllers = uploadControllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, []);

  const sortedAssets = useMemo(
    () => [...assets].sort((left, right) => right.created_at.localeCompare(left.created_at)),
    [assets]
  );

  const pageCount = Math.max(1, Math.ceil(sortedAssets.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageAssets = sortedAssets.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  const hasProcessingAssets = assets.some(shouldRefreshAssetLifecycle);

  const uploadDisabledReason =
    readOnlyReason ?? (dashboardState.blocksUpload ? dashboardState.message : undefined);
  const blocked = dashboardState.status !== "ready_to_upload";
  const blockedTone =
    dashboardState.status === "plan_limit_exceeded" || dashboardState.status === "billing_unavailable"
      ? "danger"
      : "warn";

  const refreshAssets = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setRefreshing(true);
    try {
      const response = await fetch("/api/assets", { cache: "no-store" });
      const body = (await response.json()) as AssetListResponse | AssetErrorResponse;
      if (!response.ok || body.status !== "ok") {
        throw new Error("message" in body ? body.message : "Refresh failed");
      }
      setAssets(body.assets);
      setListError("");
    } catch (error) {
      if (!silent) setListError(error instanceof Error ? error.message : "Refresh failed");
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!hasProcessingAssets) return;

    const interval = window.setInterval(() => {
      if (autoRefreshInFlightRef.current) return;
      autoRefreshInFlightRef.current = true;
      refreshAssets({ silent: true }).finally(() => {
        autoRefreshInFlightRef.current = false;
      });
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [hasProcessingAssets, refreshAssets]);

  function updateUpload(id: string, update: Partial<UploadItem>) {
    setUploads((current) =>
      current.map((item) => (item.id === id ? { ...item, ...update } : item))
    );
  }

  async function runUpload(id: string, file: File, resume?: UploadResumeContext) {
    const controller = new AbortController();
    uploadControllersRef.current.set(id, controller);
    updateUpload(id, { status: "uploading", progress: 0, message: undefined });

    try {
      const result = await uploadFile(
        file,
        controller.signal,
        uploadLimiterRef.current,
        (progress) => updateUpload(id, { status: "uploading", progress }),
        resume
      );
      setAssets((current) => [
        result.asset,
        ...current.filter((asset) => asset.asset_id !== result.asset.asset_id),
      ]);
      setPage(0);
      updateUpload(id, {
        status: "done",
        progress: 100,
        message: `Uploaded ${file.name}`,
        resume: undefined,
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        updateUpload(id, {
          status: "cancelled",
          message: `Cancelled ${file.name}`,
          resume: undefined,
        });
      } else {
        updateUpload(id, {
          status: "error",
          message: error instanceof Error ? error.message : "Upload failed",
          resume: error instanceof MultipartUploadFailure ? error.resume : resume,
        });
      }
    } finally {
      uploadControllersRef.current.delete(id);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;
    if (uploadDisabledReason) {
      const [file] = files;
      if (!file) return;
      setUploads((current) => [
        {
          id: crypto.randomUUID(),
          file,
          status: "error",
          progress: 0,
          message: uploadDisabledReason,
        },
        ...current,
      ]);
      return;
    }

    const nextUploads = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: "queued" as const,
      progress: 0,
    }));
    setUploads((current) => [...nextUploads, ...current]);
    for (const item of nextUploads) {
      void runUpload(item.id, item.file);
    }
  }

  function cancelUpload(id: string) {
    uploadControllersRef.current.get(id)?.abort();
  }

  function retryUpload(item: UploadItem) {
    void runUpload(item.id, item.file, item.resume);
  }

  function dismissUpload(id: string) {
    setUploads((current) => current.filter((item) => item.id !== id));
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
              onClick={() => void refreshAssets()}
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
                {uploadDisabledReason ? "Uploads disabled" : "Upload videos"}
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
          multiple
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

          {uploads.map((item) => {
            const isActive = item.status === "queued" || item.status === "uploading";
            const tone = item.status === "error" ? "danger" : item.status === "done" ? "success" : "info";
            return (
              <Callout
                key={item.id}
                tone={tone}
                title={isActive ? `Uploading ${item.file.name}` : item.message}
                icon={null}
                action={
                  item.status === "uploading" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="rounded-md"
                      onClick={() => cancelUpload(item.id)}
                    >
                      Cancel
                    </Button>
                  ) : item.status === "error" || item.status === "cancelled" ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="rounded-md"
                        onClick={() => retryUpload(item)}
                      >
                        Retry
                      </Button>
                      <button
                        type="button"
                        aria-label={`Dismiss ${item.file.name} upload`}
                        onClick={() => dismissUpload(item.id)}
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-sunken hover:text-ink"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  ) : item.status === "done" ? (
                    <button
                      type="button"
                      aria-label={`Dismiss ${item.file.name} upload`}
                      onClick={() => dismissUpload(item.id)}
                      className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-sunken hover:text-ink"
                    >
                      <X className="size-4" />
                    </button>
                  ) : null
                }
              >
                {isActive ? (
                  <div className="flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-sunken">
                      <div
                        className="h-full rounded-full bg-ink transition-[width] duration-200"
                        style={{ width: `${item.progress}%` }}
                      />
                    </div>
                    <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-soft">
                      {item.progress}%
                    </span>
                  </div>
                ) : item.status === "error" ? (
                  item.message
                ) : null}
              </Callout>
            );
          })}

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
                  Upload videos
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
                          <AssetThumb assetId={asset.asset_id} hasThumbnail={asset.has_thumbnail === true} />
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
