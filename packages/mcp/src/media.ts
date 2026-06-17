import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { RendMcpError } from "./errors.js";

export type PreparedVideoUpload = {
  path: string;
  size: number;
  contentType: "video/mp4" | "video/quicktime" | "application/octet-stream";
  stream: BodyInit;
};

type UploadContentType = PreparedVideoUpload["contentType"];

const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "application/octet-stream",
]);

const VIDEO_EXTENSIONS: Record<string, "video/mp4" | "video/quicktime"> = {
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".qt": "video/quicktime",
};

export async function prepareVideoUpload(input: {
  filePath: string;
  contentType?: string;
  maxUploadBytes: number;
}): Promise<PreparedVideoUpload> {
  const filePath = normalizeFilePath(input.filePath);
  const fileStat = await stat(filePath).catch((error) => {
    throw new RendMcpError("invalid_request", `Cannot read upload file: ${errorMessage(error)}`);
  });

  if (!fileStat.isFile()) {
    throw new RendMcpError("invalid_request", "Upload path must point to a file.");
  }

  if (fileStat.size > input.maxUploadBytes) {
    throw new RendMcpError("limit_exceeded", "Upload file exceeds the configured MCP file size limit.", {
      details: {
        file_size_bytes: fileStat.size,
        max_upload_bytes: input.maxUploadBytes,
      },
    });
  }

  const requestedType = normalizeContentType(input.contentType);
  if (requestedType && !ALLOWED_UPLOAD_CONTENT_TYPES.has(requestedType)) {
    throw new RendMcpError("unsupported_media_type", `Unsupported upload content type: ${requestedType}`);
  }

  const head = await readHead(filePath);
  const detectedType = detectVideoContentType(head, filePath);
  const detectedNonVideo = detectKnownNonVideo(head);

  if (detectedNonVideo) {
    throw new RendMcpError("unsupported_media_type", `Upload appears to be ${detectedNonVideo}, not a video.`);
  }

  const contentType = (requestedType as UploadContentType | undefined) ?? detectedType;
  if (!contentType) {
    throw new RendMcpError(
      "unsupported_media_type",
      "Could not determine a supported Rend video content type. Pass content_type as video/mp4, video/quicktime, or application/octet-stream."
    );
  }

  return {
    path: filePath,
    size: fileStat.size,
    contentType,
    stream: createReadStream(filePath) as unknown as BodyInit,
  };
}

function normalizeFilePath(filePath: string) {
  if (!filePath.trim() || filePath.includes("\0")) {
    throw new RendMcpError("invalid_request", "file_path must be a non-empty local file path.");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) {
    throw new RendMcpError("invalid_request", "file_path must be a local file path, not a URL.");
  }
  return resolve(filePath);
}

function normalizeContentType(value: string | undefined) {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

async function readHead(filePath: string) {
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function detectVideoContentType(head: Buffer, filePath: string): UploadContentType | undefined {
  const byExtension = VIDEO_EXTENSIONS[extname(filePath).toLowerCase()];
  if (isIsoBaseMediaFile(head)) {
    return byExtension ?? (head.includes(Buffer.from("qt  ")) ? "video/quicktime" : "video/mp4");
  }
  return byExtension;
}

function isIsoBaseMediaFile(head: Buffer) {
  return head.length >= 12 && head.toString("ascii", 4, 8) === "ftyp";
}

function detectKnownNonVideo(head: Buffer) {
  if (head.length === 0) return undefined;
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (head.toString("ascii", 0, 4) === "%PDF") return "application/pdf";
  if (head.toString("ascii", 0, 2) === "PK") return "application/zip";
  if (/^\s*</.test(head.toString("utf8", 0, Math.min(head.length, 32)))) return "text/html";
  if (looksLikeText(head)) return "text/plain";
  return undefined;
}

function looksLikeText(head: Buffer) {
  const sample = head.subarray(0, Math.min(head.length, 32));
  if (sample.length < 8) return false;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) printable += 1;
  }
  return printable / sample.length > 0.9;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
