import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerResources } from "./resources.js";
import { registerAdaptTools } from "./tools/adapt.js";
import { registerConfigTools } from "./tools/config.js";
import { registerOperationalTools } from "./tools/operational.js";
import { registerRouteTools } from "./tools/routes.js";
import { registerTlsTools } from "./tools/tls.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export function createCaddyServer(): McpServer {
  const server = new McpServer({ name: "caddy-mcp", version });
  registerConfigTools(server);
  registerRouteTools(server);
  registerAdaptTools(server);
  registerTlsTools(server);
  registerOperationalTools(server);
  registerResources(server);
  return server;
}

export async function startServer(): Promise<void> {
  const server = createCaddyServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun = process.argv[1]?.endsWith("server.js");
if (isDirectRun) {
  startServer().catch((err) => {
    console.error("MCP server error:", err);
    process.exit(1);
  });
}
