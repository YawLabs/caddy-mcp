import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerResources } from "./resources.js";
import { registerAdaptTools } from "./tools/adapt.js";
import { registerConfigTools } from "./tools/config.js";
import { registerOperationalTools } from "./tools/operational.js";
import { registerRouteTools } from "./tools/routes.js";
import { registerTlsTools } from "./tools/tls.js";

// __VERSION__ is substituted at build time by the single-binary esbuild build
// (scripts/build-binary.mjs defines it). The SEA bundle is CJS, where
// `import.meta.url` is empty -- so calling `createRequire(import.meta.url)` at
// load time would throw ERR_INVALID_ARG_VALUE and crash the binary. Prefer the
// define when present; fall back to the createRequire+package.json read only
// when unbundled (ESM/dist or running from source), where `import.meta.url` is
// a real URL.
declare const __VERSION__: string;
function resolveVersion(): string {
  if (typeof __VERSION__ !== "undefined") return __VERSION__;
  return createRequire(import.meta.url)("../package.json").version;
}
export const version = resolveVersion();

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
