import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

export function registerAdaptTools(server: McpServer) {
  server.tool(
    "caddy_adapt",
    "Convert a Caddyfile or other config format to Caddy JSON without loading it. Useful for previewing what a Caddyfile produces.",
    {
      config: z.string().describe("The raw config text (e.g., Caddyfile contents)"),
      adapter: z.string().optional().default("caddyfile").describe("Config format adapter (default: 'caddyfile')"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ config, adapter }) => formatResult(await api.adapt(config, adapter)),
  );
}
