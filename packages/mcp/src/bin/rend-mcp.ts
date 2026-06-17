#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv } from "../config.js";
import { redactText } from "../errors.js";
import { createRendMcpServer } from "../server.js";

async function main() {
  const server = createRendMcpServer(configFromEnv());
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(redactText(message));
  process.exit(1);
});
