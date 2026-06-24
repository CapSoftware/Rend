import type {
  AssetDeleteResponse,
  AssetDetail,
  AssetListResponse,
  AssetSummary,
  AssetUploadResponse,
  PlaybackAnalyticsResponse,
  PlaybackBootstrapResponse,
  UploadAssetOptions,
} from "@rend-sdk/client";
import type { RendMcpConfig } from "./config.js";
import { RendMcpError, safeErrorOutput } from "./errors.js";
import { prepareVideoUpload } from "./media.js";
import { redactSecrets, safePlaybackUrl } from "./redaction.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type RendOperations = {
  uploadAsset(body: BodyInit, options?: UploadAssetOptions): Promise<AssetUploadResponse>;
  waitForPlayableAsset(
    assetId: string,
    options?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<AssetDetail>;
  getAsset(assetId: string): Promise<AssetDetail>;
  listAssets(options?: { limit?: number }): Promise<AssetListResponse>;
  getPlaybackBootstrap(
    assetId: string,
    options?: { playbackBaseUrl?: string }
  ): Promise<PlaybackBootstrapResponse>;
  deleteAsset(assetId: string): Promise<AssetDeleteResponse>;
  getPlaybackAnalytics(assetId: string, options?: { windowSeconds?: number }): Promise<PlaybackAnalyticsResponse>;
};

export type RendToolHandlers = ReturnType<typeof createRendToolHandlers>;

export function createRendToolHandlers(client: RendOperations, config: RendMcpConfig) {
  return {
    rend_upload_video: (input: {
      file_path: string;
      content_type?: string;
      wait_for_playable?: boolean;
      timeout_ms?: number;
      interval_ms?: number;
    }) =>
      runTool(async () => {
        requireApiKey(config);
        const upload = await prepareVideoUpload({
          filePath: input.file_path,
          contentType: input.content_type,
          maxUploadBytes: config.maxUploadBytes,
        });
        const uploaded = await client.uploadAsset(upload.stream, {
          contentType: upload.contentType,
          contentLength: upload.size,
        });
        const links = assetLinks(config, uploaded.asset_id);
        const asset = input.wait_for_playable
          ? await client.waitForPlayableAsset(uploaded.asset_id, {
              timeoutMs: input.timeout_ms,
              intervalMs: input.interval_ms,
            })
          : undefined;

        return ok({
          status: "ok",
          asset_id: uploaded.asset_id,
          source_state: asset?.source_state ?? uploaded.source_state,
          playable_state: asset?.playable_state ?? uploaded.playable_state,
          byte_size: uploaded.byte_size,
          content_type: upload.contentType,
          embed_url: links.embed_url,
          watch_url: links.watch_url,
          asset: asset ? safeAssetDetail(asset, config) : undefined,
        });
      }),

    rend_get_asset: (input: { asset_id: string }) =>
      runTool(async () => {
        requireApiKey(config);
        const asset = await client.getAsset(input.asset_id);
        return ok({
          status: "ok",
          asset: safeAssetDetail(asset, config),
        });
      }, { assetId: input.asset_id }),

    rend_list_assets: (input: { limit?: number }) =>
      runTool(async () => {
        requireApiKey(config);
        const response = await client.listAssets({ limit: input.limit });
        return ok({
          status: "ok",
          count: response.assets.length,
          assets: response.assets.map((asset) => safeAssetSummary(asset, config)),
        });
      }),

    rend_get_playback: (input: { asset_id: string; playback_base_url?: string }) =>
      runTool(async () => {
        const bootstrap = await client.getPlaybackBootstrap(input.asset_id, {
          playbackBaseUrl: input.playback_base_url,
        });
        const safeBootstrap = safePlaybackBootstrap(bootstrap);
        const source = playbackSource(safeBootstrap);
        return ok({
          status: "ok",
          asset_id: bootstrap.asset_id,
          source_url: source?.url,
          source_content_type: source?.content_type,
          embed_url: assetLinks(config, bootstrap.asset_id).embed_url,
          watch_url: assetLinks(config, bootstrap.asset_id).watch_url,
          playback: safeBootstrap,
        });
      }, { assetId: input.asset_id }),

    rend_delete_asset: (input: { asset_id: string }) =>
      runTool(async () => {
        requireApiKey(config);
        const deleted = await client.deleteAsset(input.asset_id);
        return ok({
          status: "ok",
          delete: safeDeleteResponse(deleted),
        });
      }, { assetId: input.asset_id }),

    rend_get_analytics: (input: { asset_id: string; window_seconds?: number }) =>
      runTool(async () => {
        requireApiKey(config);
        const analytics = await client.getPlaybackAnalytics(input.asset_id, {
          windowSeconds: input.window_seconds,
        });
        return ok({
          status: "ok",
          analytics: redactSecrets(analytics),
        });
      }, { assetId: input.asset_id }),
  };
}

function requireApiKey(config: RendMcpConfig) {
  if (!config.apiKey) {
    throw new RendMcpError(
      "unauthorized",
      "Set REND_API_KEY or REND_MCP_API_KEY in the MCP client environment."
    );
  }
}

async function runTool(fn: () => Promise<ToolResult>, context: { assetId?: string } = {}) {
  try {
    return await fn();
  } catch (error) {
    return errorResult(safeErrorOutput(error, context));
  }
}

function ok(value: unknown): ToolResult {
  const output = outputRecord(value);
  return {
    content: [{ type: "text", text: `${JSON.stringify(output, null, 2)}\n` }],
    structuredContent: output,
  };
}

function errorResult(value: unknown): ToolResult {
  const output = outputRecord(value);
  return {
    content: [{ type: "text", text: `${JSON.stringify(output, null, 2)}\n` }],
    structuredContent: output,
    isError: true,
  };
}

function safeAssetSummary(asset: AssetSummary, config: RendMcpConfig) {
  return removeUndefined({
    asset_id: asset.asset_id,
    source_state: asset.source_state,
    playable_state: asset.playable_state,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
    source_byte_size: asset.source_byte_size,
    duration_ms: asset.duration_ms,
    has_thumbnail: asset.has_thumbnail,
    artifact_count: asset.artifact_count,
    suspended_at: asset.suspended_at,
    suspension_reason: asset.suspension_reason,
    organization_suspended_at: asset.organization_suspended_at,
    organization_suspension_reason: asset.organization_suspension_reason,
    ...assetLinks(config, asset.asset_id),
  });
}

function safeAssetDetail(asset: AssetDetail, config: RendMcpConfig) {
  return removeUndefined({
    asset_id: asset.asset_id,
    source_state: asset.source_state,
    playable_state: asset.playable_state,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
    source_byte_size: asset.source_byte_size,
    suspended_at: asset.suspended_at,
    suspension_reason: asset.suspension_reason,
    organization_suspended_at: asset.organization_suspended_at,
    organization_suspension_reason: asset.organization_suspension_reason,
    artifacts: asset.artifacts.map((artifact) =>
      removeUndefined({
        kind: artifact.kind,
        content_type: artifact.content_type,
        byte_size: artifact.byte_size,
      })
    ),
    ...assetLinks(config, asset.asset_id),
  });
}

function safePlaybackBootstrap(bootstrap: PlaybackBootstrapResponse) {
  return removeUndefined({
    status: bootstrap.status,
    asset_id: bootstrap.asset_id,
    source_state: bootstrap.source_state,
    playable_state: bootstrap.playable_state,
    playback_url: safePlaybackUrl(bootstrap.playback_url),
    playback_content_type: bootstrap.playback_content_type,
    playback_token_expires_at: bootstrap.playback_token_expires_at,
    ttl_seconds: bootstrap.ttl_seconds,
    opener_url: safePlaybackUrl(bootstrap.opener_url),
    opener_content_type: bootstrap.opener_content_type,
    manifest_url: safePlaybackUrl(bootstrap.manifest_url),
    manifest_content_type: bootstrap.manifest_content_type,
    prefetch_hints: bootstrap.prefetch_hints
      .map((hint) =>
        removeUndefined({
          artifact_path: hint.artifact_path,
          url: safePlaybackUrl(hint.url),
          content_type: hint.content_type,
        })
      )
      .filter((hint) => hint.url),
  });
}

function playbackSource(bootstrap: ReturnType<typeof safePlaybackBootstrap>) {
  if (typeof bootstrap.manifest_url === "string") {
    return {
      url: bootstrap.manifest_url,
      content_type: typeof bootstrap.manifest_content_type === "string"
        ? bootstrap.manifest_content_type
        : undefined,
    };
  }
  if (typeof bootstrap.playback_url === "string") {
    return {
      url: bootstrap.playback_url,
      content_type: typeof bootstrap.playback_content_type === "string"
        ? bootstrap.playback_content_type
        : undefined,
    };
  }
  if (typeof bootstrap.opener_url === "string") {
    return {
      url: bootstrap.opener_url,
      content_type: typeof bootstrap.opener_content_type === "string"
        ? bootstrap.opener_content_type
        : undefined,
    };
  }
  return undefined;
}

function safeDeleteResponse(deleted: AssetDeleteResponse) {
  return {
    asset_id: deleted.asset_id,
    deleted: deleted.deleted,
    already_deleted: deleted.already_deleted,
    origin_objects_deleted: deleted.origin_objects_deleted,
    purge_attempted: deleted.purge_attempted,
  };
}

function assetLinks(config: RendMcpConfig, assetId: string) {
  return {
    embed_url: new URL(`/embed/${encodeURIComponent(assetId)}`, config.siteBaseUrl).toString(),
    watch_url: new URL(`/watch/${encodeURIComponent(assetId)}`, config.siteBaseUrl).toString(),
  };
}

function removeUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

function outputRecord(value: unknown): Record<string, unknown> {
  const redacted = redactSecrets(value);
  return isRecord(redacted) ? removeUndefined(redacted) : { value: redacted };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
