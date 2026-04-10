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
    "Write config at a JSON path. Mode 'append' (default) adds to arrays or creates keys (POST). Mode 'overwrite' replaces existing values (PATCH). Mode 'insert' places at a specific array index (PUT) — useful for route ordering.",
    {
      path: z.string().describe("Config path to write to (e.g., 'apps/http/servers/srv0/routes')"),
      value: z.any().describe("The JSON value to set at the path"),
      mode: z
        .enum(["append", "overwrite", "insert"])
        .optional()
        .default("append")
        .describe(
          "'append' = POST (add to arrays, create on objects), 'overwrite' = PATCH (replace existing), 'insert' = PUT (insert at array index)",
        ),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ path, value, mode }) => {
      const res =
        mode === "overwrite"
          ? await api.configPatch(path, value)
          : mode === "insert"
            ? await api.configPut(path, value)
            : await api.configPost(path, value);
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
    "Replace the entire Caddy configuration atomically. Accepts a JSON config object, or a Caddyfile string with format='caddyfile'. This is the safest way to make large config changes. Has a 60-second timeout to allow for TLS provisioning.",
    {
      config: z.union([z.record(z.any()), z.string()]).describe("Full config — JSON object or Caddyfile text string"),
      format: z
        .enum(["json", "caddyfile"])
        .optional()
        .default("json")
        .describe("Config format: 'json' (default) or 'caddyfile'"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ config, format }) => {
      const contentType = format === "caddyfile" ? "text/caddyfile" : "application/json";
      return formatResult(await api.loadConfig(config, contentType));
    },
  );

  server.tool(
    "caddy_config_by_id",
    "Access config by @id tag. Any config object with an '@id' field can be read, updated, or deleted by its ID instead of needing its full path. This is the recommended way to manage individual routes and config objects.",
    {
      id: z
        .string()
        .regex(/^[\w-]+$/)
        .describe("The @id value of the config object"),
      action: z.enum(["get", "set", "delete"]).optional().default("get").describe("Action to perform"),
      value: z.any().optional().describe("New value (required for 'set' action)"),
      subpath: z.string().optional().default("").describe("Optional sub-path within the identified object"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ id, action, value, subpath }) => {
      if (action === "get") {
        return formatResult(await api.configByIdGet(id, subpath));
      }
      if (action === "set") {
        if (value === undefined) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: value is required for 'set' action" }],
          };
        }
        return formatResult(await api.configByIdSet(id, value, "PATCH", subpath));
      }
      if (action === "delete") {
        return formatResult(await api.configByIdDelete(id, subpath));
      }
      return { isError: true, content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
    },
  );
}
