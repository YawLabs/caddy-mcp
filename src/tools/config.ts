import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";
import { getSnapshot, isSnapshotableConfig, listSnapshots, saveSnapshot } from "../snapshots.js";

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
    "Write config at a JSON path. Mode 'overwrite' (default) replaces existing values (PATCH) — safe and idempotent. Mode 'append' adds to arrays or creates keys (POST) — NOT idempotent: calling twice with the same route duplicates it. Mode 'insert' places at a specific array index (PUT) — useful for route ordering.",
    {
      path: z.string().describe("Config path to write to (e.g., 'apps/http/servers/srv0/routes')"),
      value: z.any().describe("The JSON value to set at the path"),
      mode: z
        .enum(["append", "overwrite", "insert"])
        .optional()
        .default("overwrite")
        .describe(
          "'overwrite' = PATCH (replace existing, default, idempotent), 'append' = POST (add to arrays / create keys, NOT idempotent), 'insert' = PUT (insert at array index)",
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
    "Delete config at a JSON path. Removes the config node at the specified path. Deleting a parent node also deletes every descendant -- e.g. deleting 'apps/http/servers/srv0' removes that server and all of its routes. Requires confirm=true.",
    {
      path: z.string().describe("Config path to delete (e.g., 'apps/http/servers/srv0/routes/0')"),
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe("Must be true to actually delete the config node (safety)"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ path, confirm }) => {
      if (!confirm) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Refusing to delete "${path}" without confirm=true. Deleting a parent path also removes all descendants. Re-run with confirm:true to proceed.`,
            },
          ],
        };
      }
      return formatResult(await api.configDelete(path));
    },
  );

  server.tool(
    "caddy_load",
    "Replace the entire Caddy configuration atomically. Accepts a JSON config object, or a Caddyfile string with format='caddyfile'. This is the safest way to make large config changes. Has a 60-second timeout to allow for TLS provisioning. Requires confirm=true: this DISCARDS the entire running config, including servers and routes not present in the supplied config. The prior config is snapshotted first and can be restored with caddy_revert.",
    {
      config: z
        .union([z.record(z.string(), z.any()), z.string()])
        .describe("Full config — JSON object or Caddyfile text string"),
      format: z
        .enum(["json", "caddyfile"])
        .optional()
        .default("json")
        .describe("Config format: 'json' (default) or 'caddyfile'"),
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe("Must be true to replace the running configuration (safety)"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ config, format, confirm }) => {
      // Every other destructive tool here gates on confirm; this one replaces
      // ALL configuration, so it gets the same gate rather than the weakest one.
      if (!confirm) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Refusing to replace the running configuration without confirm=true. caddy_load discards every server and route not present in the supplied config. Re-run with confirm:true to proceed (the prior config is snapshotted and restorable via caddy_revert).",
            },
          ],
        };
      }
      const contentType = format === "caddyfile" ? "text/caddyfile" : "application/json";
      // Capture the pre-load state but defer the snapshot push until AFTER the
      // load returns ok. Mirrors the deferral in caddy_revert apply: a failed
      // load did not change anything server-side, so pushing a "pre-load"
      // snapshot would just consume a slot in the 10-deep ring and shift the
      // user's earlier rollback targets one position deeper for no gain.
      const current = await api.configGet();
      const res = await api.loadConfig(config, contentType);
      if (res.ok && current.ok && isSnapshotableConfig(current.data)) {
        saveSnapshot(current.data, "caddy_load");
      }
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_revert",
    "Manage config snapshots for rollback. Snapshots are auto-captured before caddy_load (last 10). " +
      "By default they live in memory only and are LOST when this server restarts -- set CADDY_MCP_SNAPSHOT_DIR " +
      "to a writable directory to persist them across restarts (they contain full Caddy configs, so pick the location deliberately). " +
      "Actions: 'list' shows snapshots with timestamps, 'save' manually captures the current config, 'apply' restores a snapshot (requires confirm=true).",
    {
      action: z.enum(["list", "save", "apply"]).describe("Action to perform"),
      index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Snapshot index for 'apply' (0 = most recent, default)"),
      confirm: z.boolean().optional().default(false).describe("Must be true to actually apply a snapshot (safety)"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ action, index, confirm }) => {
      if (action === "list") {
        const snaps = listSnapshots();
        if (snaps.length === 0) {
          return { content: [{ type: "text" as const, text: "No snapshots available" }] };
        }
        const lines = snaps.map((s, i) => {
          const when = new Date(s.timestamp).toISOString();
          const size = JSON.stringify(s.config).length;
          return `  [${i}] ${when} trigger=${s.trigger} size=${size}B`;
        });
        return { content: [{ type: "text" as const, text: `Snapshots:\n${lines.join("\n")}` }] };
      }
      if (action === "save") {
        const current = await api.configGet();
        if (!current.ok) return formatResult(current);
        if (!isSnapshotableConfig(current.data)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Error: cannot snapshot -- config response is empty or not a JSON object",
              },
            ],
          };
        }
        saveSnapshot(current.data, "manual");
        return { content: [{ type: "text" as const, text: "Snapshot saved." }] };
      }
      // apply
      if (!confirm) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Refusing to apply snapshot [${index}] without confirm=true. Re-run with confirm:true to proceed.`,
            },
          ],
        };
      }
      const snap = getSnapshot(index);
      if (!snap) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: no snapshot at index ${index}. Use action='list' to see available snapshots.`,
            },
          ],
        };
      }
      // Capture pre-revert state but defer the snapshot push until AFTER the
      // load returns ok. If we pushed unconditionally and the load failed, the
      // pre-revert snapshot would sit at index 0 -- a retried `apply 0` would
      // then target the failed-revert's pre-state instead of the original
      // snapshot the user meant to apply, silently shifting the target by one.
      const current = await api.configGet();
      const res = await api.loadConfig(snap.config, "application/json");
      if (!res.ok) return formatResult(res);
      if (current.ok && isSnapshotableConfig(current.data)) {
        saveSnapshot(current.data, "caddy_revert");
      }
      const when = new Date(snap.timestamp).toISOString();
      return {
        content: [
          { type: "text" as const, text: `Reverted to snapshot [${index}] (${when}, trigger=${snap.trigger}).` },
        ],
      };
    },
  );

  server.tool(
    "caddy_config_by_id",
    "Access config by @id tag. Any config object with an '@id' field can be read, updated, or deleted by its ID instead of needing its full path. This is the recommended way to manage individual routes and config objects. The 'delete' action requires confirm=true.",
    {
      id: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .describe("The @id value of the config object"),
      action: z.enum(["get", "set", "delete"]).optional().default("get").describe("Action to perform"),
      value: z.any().optional().describe("New value (required for 'set' action)"),
      subpath: z.string().optional().default("").describe("Optional sub-path within the identified object"),
      mode: z
        .enum(["append", "overwrite", "insert"])
        .optional()
        .default("overwrite")
        .describe(
          "For 'set' action: 'overwrite' = PATCH (replace existing, default), 'append' = POST (add to arrays, create on objects), 'insert' = PUT (insert at array index)",
        ),
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe("Must be true to actually delete (only enforced for action='delete')"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ id, action, value, subpath, mode, confirm }) => {
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
        const method = mode === "append" ? "POST" : mode === "insert" ? "PUT" : "PATCH";
        return formatResult(await api.configByIdSet(id, value, method, subpath));
      }
      if (action === "delete") {
        if (!confirm) {
          const target = subpath ? `@id="${id}" subpath "${subpath}"` : `@id="${id}"`;
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Refusing to delete ${target} without confirm=true. Re-run with confirm:true to proceed.`,
              },
            ],
          };
        }
        return formatResult(await api.configByIdDelete(id, subpath));
      }
      return { isError: true, content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
    },
  );
}
