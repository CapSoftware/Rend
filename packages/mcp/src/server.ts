import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RendClient } from "@rend-sdk/client";
import { z } from "zod";
import type { RendMcpConfig } from "./config.js";
import { createRendToolHandlers, type ToolResult } from "./tools.js";

export const REND_MCP_VERSION = "0.1.0";

const assetIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, {
    message: "asset_id must be a UUID",
  });

export function createRendMcpServer(config: RendMcpConfig) {
  const server = new McpServer({
    name: "rend",
    version: REND_MCP_VERSION,
  });
  const client = new RendClient({
    apiKey: config.apiKey,
    apiBaseUrl: config.apiBaseUrl,
    siteBaseUrl: config.siteBaseUrl,
  });
  const tools = createRendToolHandlers(client, config);
  const registerTool = (
    name: string,
    options: Record<string, unknown>,
    handler: (args: never) => Promise<ToolResult>
  ) => {
    (server as unknown as { registerTool: typeof registerTool }).registerTool(name, options, handler);
  };

  registerTool(
    "rend_upload_video",
    {
      title: "Upload video",
      description: "Upload a local video file to Rend.",
      inputSchema: {
        file_path: z.string().min(1).describe("Local video file path."),
        content_type: z
          .enum(["video/mp4", "video/quicktime", "application/octet-stream"])
          .optional()
          .describe("Upload content type when known."),
        wait_for_playable: z.boolean().optional().describe("Poll until Rend creates a playable artifact."),
        timeout_ms: z.number().int().min(1_000).max(900_000).optional().describe("Playable wait timeout."),
        interval_ms: z.number().int().min(250).max(30_000).optional().describe("Playable polling interval."),
      },
    },
    tools.rend_upload_video as (args: never) => Promise<ToolResult>
  );

  registerTool(
    "rend_get_asset",
    {
      title: "Get asset",
      description: "Fetch Rend asset state and artifacts.",
      inputSchema: {
        asset_id: assetIdSchema,
      },
    },
    tools.rend_get_asset as (args: never) => Promise<ToolResult>
  );

  registerTool(
    "rend_list_assets",
    {
      title: "List assets",
      description: "List Rend assets for the API key.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum assets to return."),
      },
    },
    tools.rend_list_assets as (args: never) => Promise<ToolResult>
  );

  registerTool(
    "rend_get_playback",
    {
      title: "Get playback",
      description: "Fetch tokenless playback bootstrap and embed URLs.",
      inputSchema: {
        asset_id: assetIdSchema,
        playback_base_url: z.string().url().optional().describe("Allowed playback base override."),
      },
    },
    tools.rend_get_playback as (args: never) => Promise<ToolResult>
  );

  registerTool(
    "rend_delete_asset",
    {
      title: "Delete asset",
      description: "Delete a Rend asset.",
      inputSchema: {
        asset_id: assetIdSchema,
      },
    },
    tools.rend_delete_asset as (args: never) => Promise<ToolResult>
  );

  registerTool(
    "rend_get_analytics",
    {
      title: "Get analytics",
      description: "Fetch playback request analytics.",
      inputSchema: {
        asset_id: assetIdSchema,
        window_seconds: z.number().int().min(60).max(604_800).optional().describe("Analytics window."),
      },
    },
    tools.rend_get_analytics as (args: never) => Promise<ToolResult>
  );

  return server;
}
