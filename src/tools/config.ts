import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

export function registerConfigTools(server: McpServer) {
  server.tool(
    "caddy_config_get",
    "Read Caddy config at any JSON path. Returns the full config when path is empty, or a subtree at a specific path (e.g., 'apps/http/servers/srv0/routes').",
    { path: z.string().optional().default("").describe("Config path (e.g., 'apps/http/servers/srv0')") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ path }) => formatResult(await api.configGet(path)),
  );

  server.tool(
    "caddy_config_set",
    "Create or replace config at a JSON path. Mode 'create' (default) appends to arrays or creates objects (POST). Mode 'replace' overwrites existing values (PATCH).",
    {
      path: z.string().describe("Config path to write to (e.g., 'apps/http/servers/srv0/routes')"),
      value: z.any().describe("The JSON value to set at the path"),
      mode: z
        .enum(["create", "replace"])
        .optional()
        .default("create")
        .describe("'create' = POST (append), 'replace' = PATCH (overwrite)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ path, value, mode }) => {
      const res = mode === "replace" ? await api.configPatch(path, value) : await api.configPost(path, value);
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_config_delete",
    "Delete config at a JSON path. Removes the config node at the specified path.",
    { path: z.string().describe("Config path to delete (e.g., 'apps/http/servers/srv0/routes/0')") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ path }) => formatResult(await api.configDelete(path)),
  );

  server.tool(
    "caddy_load",
    "Replace the entire Caddy configuration atomically. Accepts a full Caddy JSON config object. This is the safest way to make large config changes.",
    { config: z.record(z.any()).describe("Full Caddy JSON configuration object") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ config }) => formatResult(await api.loadConfig(config)),
  );
}
