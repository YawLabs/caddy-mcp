import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";
import { getSnapshot, isSnapshotableConfig, listSnapshots, saveSnapshot } from "../snapshots.js";

/**
 * Does this path address the config ROOT -- i.e. the whole configuration?
 *
 * "", "/", "config" and "/config/" all normalize to the same request,
 * `DELETE /config/`, which is Caddy's documented "unload the entire current
 * configuration". The first replace is a copy of api.ts's normalizePath (it is
 * module-private there, so it cannot be imported); the test then accepts an
 * all-slashes remainder because "//", "config//" and "/config//" are still the
 * user asking for the root.
 *
 * That tolerance is why the root branch below sends the CANONICAL empty path
 * instead of the caller's spelling. api.ts would encode "//" to `/config//`,
 * and Caddy's admin endpoint is a plain `http.ServeMux` with the config route
 * registered at "/config/" (admin.go:222 and :263 at v2.11.4), so Go answers
 * that spelling with a redirect to /config/ rather than dispatching to
 * handleConfig. On the default transport `fetch` follows the redirect and the
 * unload still happens -- but the ETag this tool cached under "/config/" is
 * never found for "/config//", so the DELETE would go out with no `If-Match`
 * and silently lose the guarantee documented at the read below; over a unix
 * socket node:http does not follow redirects at all, so it would just fail.
 *
 * The two regexes MUST stay in step with api.ts: a path this predicate calls a
 * leaf but api.ts sends to the root would take the unloads-everything branch of
 * Caddy with the leaf branch of this tool -- no warning, no snapshot.
 */
function isRootConfigPath(path: string): boolean {
  return /^\/*$/.test(path.replace(/^\/?(config(\/|$))?/, ""));
}

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
    "Write config at a JSON path. Mode 'overwrite' (default) replaces existing values (PATCH) — safe and idempotent. Mode 'append' (POST) adds to an array — NOT idempotent: calling twice with the same route duplicates it — but on a non-array key it REPLACES whatever is there, and it cannot create missing parent objects. Mode 'insert' (PUT) inserts at an array index (useful for route ordering), or strictly creates an object key together with any missing parents and fails with 409 if the key already exists — the safe way to create a server or app, including on an instance with no config at all.",
    {
      path: z.string().describe("Config path to write to (e.g., 'apps/http/servers/srv0/routes')"),
      value: z.any().describe("The JSON value to set at the path"),
      mode: z
        .enum(["append", "overwrite", "insert"])
        .optional()
        .default("overwrite")
        .describe(
          "'overwrite' = PATCH (replace existing, default, idempotent; 404 if the key does not exist), 'append' = POST (appends to arrays, NOT idempotent; REPLACES an existing non-array key; cannot create missing parents), 'insert' = PUT (inserts at an array index, or strictly creates an object key and any missing parents; 409 if the key exists)",
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
    "Delete config at a JSON path. Removes the config node at the specified path. Deleting a parent node also deletes every descendant -- e.g. deleting 'apps/http/servers/srv0' removes that server and all of its routes. Requires confirm=true. " +
      "Any path that addresses the config ROOT ('', '/', 'config', '/config/', and slash-only variants of those) addresses the ENTIRE config and unloads it: every app and server goes, and so does the 'admin' block, after which Caddy re-binds its admin endpoint to its default address " +
      "(localhost:2019, or $CADDY_ADMIN in Caddy's environment). If CADDY_ADMIN_URL points anywhere else, neither this server nor caddy_revert can reach Caddy afterwards. A root delete is snapshotted first, so caddy_revert can " +
      "restore it while Caddy is still reachable; no other path is snapshotted. To REPLACE the config rather than unload it, use caddy_load.",
    {
      path: z.string().describe("Config path to delete (e.g., 'apps/http/servers/srv0/routes/0')"),
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe("Must be true to actually delete the config node (safety)"),
    },
    // idempotentHint is FALSE because the hint covers the whole tool and cannot see
    // the path it is called with. This tool's own documented example ends in an
    // array index -- 'apps/http/servers/srv0/routes/0' -- and Caddy re-packs an
    // array after a delete, so repeating that call removes a DIFFERENT route each
    // time. caddy_remove_route carries the same correction for the byte-identical
    // underlying request; the two must agree. Nothing here is auto-recoverable
    // either: apart from a root delete (below), only caddy_load captures a
    // snapshot, so a spurious repeat cannot be undone with caddy_revert.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ path, confirm }) => {
      // A root path is a different operation wearing the same tool: Caddy deletes
      // the "config" key itself, marshals the result to null and runs it, which
      // unloads every app AND drops the admin block -- the admin endpoint then
      // falls back to DefaultAdminListen (localhost:2019, or $CADDY_ADMIN in
      // Caddy's environment). Verified against Caddy 2.11.4: after DELETE /config/
      // on an instance whose config set admin.listen, the configured port closed
      // and the admin API answered on the default address instead. So this branch
      // has to (a) say that before the fact and (b) leave something to revert to.
      const root = isRootConfigPath(path);
      if (!confirm) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: root
                ? `Refusing to delete the ENTIRE config without confirm=true. The path "${path}" addresses the config root, so this ` +
                  `unloads every app and server, and the 'admin' block with them: Caddy then re-binds its admin endpoint to its default ` +
                  `address (localhost:2019, or $CADDY_ADMIN in Caddy's environment), and if CADDY_ADMIN_URL points anywhere else neither ` +
                  `this server nor caddy_revert can reach Caddy afterwards. The current config is snapshotted first, so caddy_revert can ` +
                  `restore it while Caddy is still reachable. To REPLACE the config rather than unload it, use caddy_load. Re-run with ` +
                  `confirm:true to proceed.`
                : `Refusing to delete "${path}" without confirm=true. Deleting a parent path also removes all descendants. Re-run with confirm:true to proceed.`,
            },
          ],
        };
      }
      if (!root) return formatResult(await api.configDelete(path));

      // Snapshot ONLY the root delete, and mirror caddy_load's pattern exactly:
      // read first, then defer the push until the delete has come back, because a
      // delete that failed changed nothing server-side and a snapshot for it would
      // just consume a slot in the 10-deep ring and shift the user's older rollback
      // targets one position deeper. Routine leaf deletes stay unsnapshotted for
      // the same reason -- one route removal per snapshot would evict the
      // caddy_load rollback targets that the ring exists for.
      //
      // The read is also what makes the snapshot trustworthy: it refreshes the
      // cached ETag for "/config/", so the DELETE carries If-Match and Caddy either
      // deletes exactly the config that was just read or answers 412 (passed
      // through verbatim). Verified against Caddy 2.11.4.
      //
      // The DELETE therefore has to go out under the SAME cache key the GET just
      // filled, which is why it is handed "" rather than the caller's `path`:
      // isRootConfigPath tolerates an all-slashes remainder, and api.ts would
      // encode "//" into `/config//` -- a different key, so the If-Match would
      // be dropped and the guarantee above would quietly not hold. See the
      // predicate's own comment for what Caddy does with that spelling.
      const current = await api.configGet();
      const res = await api.configDelete("");
      // Same exception as caddy_load: a deadline that fired (`res.outcomeUnknown`)
      // is not "nothing happened" -- Caddy goes on applying a config change it has
      // read after the client hangs up, and a timed-out change is never replayed,
      // so the config this delete may have unloaded is recorded nowhere else.
      const kept = (res.ok || res.outcomeUnknown === true) && current.ok && isSnapshotableConfig(current.data);
      if (kept) saveSnapshot(current.data, "caddy_config_delete");
      if (!res.ok) {
        if (res.outcomeUnknown && kept) {
          return formatResult({
            ...res,
            error:
              `${res.error}\nThe pre-delete config was kept anyway, as snapshot [0] (trigger=caddy_config_delete): if this delete ` +
              `did apply, caddy_revert { action: "apply", index: 0, confirm: true } restores what it unloaded -- as long as this ` +
              `server can still reach Caddy's admin endpoint, which moves back to Caddy's default address when the deleted ` +
              `config set an admin.listen of its own. If the delete did not apply, that snapshot is simply the config read ` +
              `just before it was sent.`,
          });
        }
        return formatResult(res);
      }
      // Say what was saved, or why nothing was -- and keep the two reasons apart
      // the way caddy_revert does. A 200 carrying a body that is not a JSON object
      // (Caddy answers a config-less instance with a literal `null`) is not a read
      // FAILURE, and calling it one would send the operator after a connectivity
      // problem that does not exist.
      const note = kept
        ? ` The prior config was saved as snapshot [0] (trigger=caddy_config_delete): caddy_revert { action: "apply", index: 0, confirm: true } restores it.`
        : current.ok
          ? " Warning: the prior config was empty or not a JSON object, so no snapshot was captured -- there was nothing to restore."
          : " Warning: the prior config could not be read, so no snapshot was captured and this unload cannot be reverted.";
      // The admin endpoint only MOVES when the unloaded block supplied a `listen`
      // that differs from DefaultAdminListen -- NOT on the mere presence of an
      // 'admin' key. Caddy substitutes DefaultAdminListen for an empty Listen on
      // both sides of the delete (admin.go:411 + :1391-1398 before it, :398-402
      // after), so the very common `{"admin":{"config":{"persist":false}}}`, and
      // an admin block carrying only origins / enforce_origin / identity /
      // remote, re-bind to the address they were already on: nothing moves, and
      // saying it did would send the operator looking for an endpoint that never
      // changed. `kept` is what makes current.data readable as a config object.
      //
      // The message stays hedged because this client cannot resolve the two
      // things that decide it: $CADDY_ADMIN lives in Caddy's environment, not
      // ours, and Caddy runs `listen` through the Replacer before the empty test
      // (admin.go:1392-1398), so "{env.X}" can expand to empty and mean the
      // default too. A literal "localhost:2019" is the default and does not move
      // either. One sentence has to cover all of them.
      const adm = kept ? (current.data as Record<string, unknown>).admin : undefined;
      const listen =
        adm !== null && typeof adm === "object" && !Array.isArray(adm)
          ? (adm as { listen?: unknown }).listen
          : undefined;
      const adminNote =
        typeof listen === "string" && listen !== ""
          ? ` The unloaded config set admin.listen to "${listen}". If that was not already Caddy's default admin address, the endpoint has moved back to the default (localhost:2019, unless $CADDY_ADMIN is set in Caddy's environment) and CADDY_ADMIN_URL (${process.env.CADDY_ADMIN_URL || "http://localhost:2019"}) may no longer reach it.`
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Unloaded the entire config (every app and server, and the 'admin' block).${note}${adminNote}`,
          },
        ],
      };
    },
  );

  server.tool(
    "caddy_load",
    "Replace the entire Caddy configuration atomically. Accepts a JSON config object, or a Caddyfile string with format='caddyfile'. This is the safest way to make large config changes. Runs on CADDY_LOAD_TIMEOUT (55 s by default), like every config change; a load that times out is not retried and may still apply, so re-read the config before loading again. Requires confirm=true: this DISCARDS the entire running config, including servers and routes not present in the supplied config. The prior config is snapshotted first and can be restored with caddy_revert.",
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
      //
      // "Failed" is api.loadConfig's verdict, not the HTTP status: Caddy answers
      // 200 for a Caddyfile load that adapted with warnings and then failed, and
      // the api layer reports that as ok:false (see readLoadBody in api.ts). It
      // used to arrive here as a success and burn a ring slot on a config that
      // had not been replaced -- so this guard must keep keying on `res.ok` and
      // never on `res.status`. Adapter warnings ride on the response either way
      // and formatResult prints them.
      //
      // The one failure that DOES keep the snapshot is a load whose deadline
      // fired (`res.outcomeUnknown`). A timed-out config change is never
      // replayed (shouldRetry rule 3 in api.ts), and Caddy goes on applying a
      // load it has read after the client hangs up -- so this load may have
      // replaced the running config after all. Dropping the pre-load config
      // already read into `current` would leave nothing to revert to in exactly
      // the case where the old config may be gone. If the load never applied,
      // the cost is the one this deferral otherwise avoids: a ring slot, holding
      // the config read just before the load was sent.
      const current = await api.configGet();
      const res = await api.loadConfig(config, contentType);
      const kept = (res.ok || res.outcomeUnknown === true) && current.ok && isSnapshotableConfig(current.data);
      if (kept) saveSnapshot(current.data, "caddy_load");
      if (res.outcomeUnknown && kept) {
        return formatResult({
          ...res,
          error:
            `${res.error}\nThe pre-load config was kept anyway, as snapshot [0] (trigger=caddy_load): if this ` +
            `load did apply, caddy_revert { action: "apply", index: 0, confirm: true } restores what it ` +
            `replaced. If it did not, that snapshot is simply the config read just before the load was sent.`,
        });
      }
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_revert",
    "Manage config snapshots for rollback. Snapshots are auto-captured before caddy_load, and before a caddy_config_delete " +
      "that unloads the whole config (an empty path); no other delete is snapshotted. Last 10. " +
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
      if (!res.ok) {
        // Except when the load's deadline fired (`res.outcomeUnknown`): then the
        // revert may have applied (see the same exception in caddy_load), and
        // the config it replaced is recorded nowhere else. Keep it -- and since
        // keeping it causes exactly the shift the deferral above avoids, SAY so,
        // with the target's new index, rather than let a retried `apply` quietly
        // load something else.
        if (res.outcomeUnknown && current.ok && isSnapshotableConfig(current.data)) {
          saveSnapshot(current.data, "caddy_revert");
          // Located by identity, not computed as index + 1: the ring is capped,
          // so the target can have fallen off the end.
          const now = listSnapshots().indexOf(snap);
          const target =
            now === -1
              ? `the snapshot you asked to apply ([${index}]) has dropped out of the ring`
              : `the snapshot you asked to apply is now [${now}]`;
          return formatResult({
            ...res,
            error:
              `${res.error}\nThe pre-revert config was kept anyway, as snapshot [0] (trigger=caddy_revert), so ` +
              `this revert can still be rolled back if it did apply. That moved every older snapshot down one ` +
              `index: ${target}, so re-running apply with index ${index} would load a different snapshot. List ` +
              `the snapshots before retrying.`,
          });
        }
        return formatResult(res);
      }
      const capturedRollforward = current.ok && isSnapshotableConfig(current.data);
      if (capturedRollforward) {
        saveSnapshot(current.data, "caddy_revert");
      }
      const when = new Date(snap.timestamp).toISOString();
      // Say so when the safety net was skipped. The load is what decides success,
      // so a skipped snapshot does NOT make this a failed revert -- but it does mean
      // the config just replaced went unrecorded, and reporting a bare success would
      // hide that at exactly the moment it matters.
      //
      // TWO distinct reasons reach here, and `current.ok` separates them, so the
      // message must not collapse them into one. A read that returned HTTP 200 with
      // a body that simply is not a JSON object (Caddy answers a config-less
      // instance with a literal `null`) is not a read FAILURE, and saying so would
      // send the operator after a connectivity or admin-listener problem that does
      // not exist. The save path above already draws exactly this distinction.
      // Naming a cause the signal does not support is what got 1.2.5 deprecated.
      const skipped = current.ok
        ? "the pre-revert config was empty or not a JSON object"
        : "the pre-revert config could not be read";
      // "cannot be rolled back to what it replaced", not "cannot be undone": other
      // snapshots may still sit in the ring, so the operator is not out of options
      // -- what is gone is specifically the state this revert overwrote.
      const note = capturedRollforward
        ? ""
        : ` Warning: ${skipped}, so no roll-forward snapshot was captured -- this revert cannot be rolled back to the config it replaced.`;
      return {
        content: [
          { type: "text" as const, text: `Reverted to snapshot [${index}] (${when}, trigger=${snap.trigger}).${note}` },
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
          "For 'set' action: 'overwrite' = PATCH (replace the identified object, or the value at subpath; default). 'append' = POST and 'insert' = PUT behave as in caddy_config_set at the resolved path: with a subpath into an array, POST appends and PUT inserts at the index; PUT also strictly creates an object key (409 if it exists). With NO subpath: for an array element (a route) neither replaces it — POST adds the value as a new element at the end of that array, PUT inserts it just before the identified one, and both are rejected with 'duplicate ID' if the value carries the same @id; for an object held under a key (a server) POST REPLACES it wholesale and PUT fails with 409. Use 'overwrite' to replace in place.",
        ),
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe("Must be true to actually delete (only enforced for action='delete')"),
    },
    // destructiveHint is keyed to the worst thing this tool can do, not the
    // default action: action='delete' removes the identified object and every
    // descendant, exactly like caddy_config_delete. Hosts gate on the hint
    // before they can see which action the call carries.
    // idempotentHint stays false for the same reason -- action='set' with
    // mode='append' is a POST, so a repeated call appends a second copy.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
      // Not live error handling: the three branches above cover every member of
      // the `action` enum, so `action` is `never` here. The assignment is the
      // exhaustiveness check -- adding a fourth action to the enum without a
      // branch for it fails to compile on this line rather than silently
      // falling through. The return only exists because TypeScript requires a
      // terminal one.
      const unhandled: never = action;
      return { isError: true, content: [{ type: "text" as const, text: `Unknown action: ${String(unhandled)}` }] };
    },
  );
}
