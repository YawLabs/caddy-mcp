import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiResponse } from "../api.js";
import * as api from "../api.js";
import { formatResult } from "../format.js";
import { getSnapshot, isSnapshotableConfig, listSnapshots, saveSnapshot } from "../snapshots.js";

// Whether a path addresses the config ROOT is decided by api.isRootConfigPath,
// which runs the SAME normalization the request functions do. It used to be a
// private copy of that regex here, with a note that the two had to stay in
// step -- and they did not: Caddy strips a trailing "..." segment before it
// picks a method, so "..." reached Caddy as the root while the copy here called
// it a leaf, and a root unload went through caddy_config_delete's leaf branch
// with no snapshot and no warning. One predicate, one place to be wrong.

/**
 * The `admin.listen` a config supplies, when it supplies one worth reporting.
 *
 * Only a NON-EMPTY string counts. Caddy substitutes DefaultAdminListen for an
 * absent or empty Listen (admin.go:398-402 and :1391-1398 at v2.11.4), so the
 * near-universal `{"admin":{"config":{"persist":false}}}`, and a block carrying
 * only origins / enforce_origin / identity / remote, bind to the same address a
 * config with no admin key does: nothing to report. Anything that is not a
 * config object -- Caddy answers a config-less instance with a literal `null`,
 * and a caller may hand caddy_config_set any JSON value -- yields undefined.
 */
function adminListenOf(config: unknown): string | undefined {
  if (!isSnapshotableConfig(config)) return undefined;
  const adm = config.admin;
  if (adm === null || typeof adm !== "object" || Array.isArray(adm)) return undefined;
  const listen = (adm as { listen?: unknown }).listen;
  return typeof listen === "string" && listen !== "" ? listen : undefined;
}

/** Does the config disable Caddy's admin endpoint outright (`admin.disabled: true`)? */
function adminDisabledIn(config: unknown): boolean {
  if (!isSnapshotableConfig(config)) return false;
  const adm = config.admin;
  return (
    adm !== null && typeof adm === "object" && !Array.isArray(adm) && (adm as { disabled?: unknown }).disabled === true
  );
}

/**
 * What a whole-config change says about the snapshot it did or did not take.
 * Shared by the root branches of caddy_config_delete and caddy_config_set so
 * the two report the same three outcomes in the same words.
 *
 * Keep the two "nothing was captured" reasons apart, the way caddy_revert does.
 * A 200 carrying a body that is not a JSON object (Caddy answers a config-less
 * instance with a literal `null`) is not a read FAILURE, and calling it one
 * would send the operator after a connectivity problem that does not exist.
 */
function priorConfigNote(kept: boolean, current: ApiResponse, trigger: string): string {
  if (kept) {
    return ` The prior config was saved as snapshot [0] (trigger=${trigger}): caddy_revert { action: "apply", index: 0, confirm: true } restores it.`;
  }
  return current.ok
    ? " Warning: the prior config was empty or not a JSON object, so no snapshot was captured -- there was nothing to restore."
    : " Warning: the prior config could not be read, so no snapshot was captured and this change cannot be reverted.";
}

/**
 * What a whole-config write did to Caddy's admin endpoint, as far as this
 * client can tell. Empty only when nothing can have moved -- NOT when this
 * client cannot tell: an unreadable prior config may have set an admin.listen
 * of its own, so that case says so (unreadablePriorAdminNote) rather than
 * falling silent the way a config known to set none does.
 *
 * Unlike a root delete, a root caddy_config_set holds BOTH sides: the replaced
 * config (when it was readable) and the value that replaced it. The endpoint
 * moves when the two resolve to different addresses, in either direction -- a
 * new config that ADDS an admin.listen moves it away from the address
 * CADDY_ADMIN_URL was pointed at just as surely as one that drops it. And a
 * value with `admin.disabled` leaves no endpoint at all: Caddy stops the old
 * listener and returns before binding a new one (admin.go:383-408 at v2.11.4).
 * `disabled` is a plain bool, so that case is stated flatly; the address cases
 * stay hedged for the reasons the delete branch gives -- $CADDY_ADMIN lives in
 * Caddy's environment, and a listen of "{env.X}" can expand to empty and mean
 * the default too.
 */
function rootWriteAdminNote(current: ApiResponse, value: unknown): string {
  if (adminDisabledIn(value)) {
    return " The new config sets admin.disabled, so Caddy no longer answers on ANY admin address: neither this server nor caddy_revert can reach it until Caddy is restarted with a config that does not disable the admin endpoint.";
  }
  const adminUrl = process.env.CADDY_ADMIN_URL || "http://localhost:2019";
  const before = current.ok ? adminListenOf(current.data) : undefined;
  const after = adminListenOf(value);
  if (before !== undefined && after !== before) {
    return (
      ` The replaced config set admin.listen to "${before}"` +
      (after !== undefined ? ` and the new one sets it to "${after}".` : " and the new one sets none.") +
      ` Unless those resolve to the same address, the admin endpoint has moved (to the new value, or back to the default: ` +
      `localhost:2019 unless $CADDY_ADMIN is set in Caddy's environment) and CADDY_ADMIN_URL (${adminUrl}) may no longer reach it.`
    );
  }
  if (before === undefined && after !== undefined) {
    return ` The new config sets admin.listen to "${after}". If that is not the address Caddy was already on, the admin endpoint has moved there and CADDY_ADMIN_URL (${adminUrl}) may no longer reach it.`;
  }
  if (!current.ok) return unreadablePriorAdminNote("replaced");
  return "";
}

/**
 * The admin note for a whole-config change whose prior config could not be
 * read. That config may have set an admin.listen of its own, in which case the
 * endpoint has moved back to the default -- or it may not have, and nothing
 * moved. This client cannot tell which, so the note names both rather than
 * picking one: silence would read as "nothing moved", which is only one of the
 * two possibilities.
 */
function unreadablePriorAdminNote(verb: "replaced" | "unloaded"): string {
  return (
    ` The ${verb} config could not be read, so this server cannot tell whether it set an admin.listen of its own. ` +
    `If it did, and that was not Caddy's default admin address, the endpoint has moved back to the default (localhost:2019, ` +
    `unless $CADDY_ADMIN is set in Caddy's environment) and CADDY_ADMIN_URL (${process.env.CADDY_ADMIN_URL || "http://localhost:2019"}) ` +
    `may no longer reach it.`
  );
}

/** Which Caddy verb each write mode sends: PATCH, POST or PUT. */
type WriteMode = "overwrite" | "append" | "insert";

function writeAt(mode: WriteMode, path: string, value: unknown): Promise<ApiResponse> {
  return mode === "overwrite"
    ? api.configPatch(path, value)
    : mode === "insert"
      ? api.configPut(path, value)
      : api.configPost(path, value);
}

/**
 * The refusal for a whole-config write sent without confirm=true. `target` is
 * one sentence saying why this call addresses the root; `narrower` says how to
 * change one part of the config instead. Shared by caddy_config_set (a root
 * path) and caddy_config_by_id (an @id that names the root), so the two warn
 * in the same words.
 */
function rootWriteRefusal(target: string, narrower: string) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text:
          `Refusing to write the ENTIRE config without confirm=true. ${target} This call REPLACES the whole configuration ` +
          `with \`value\` ('overwrite' and 'append' both do, and Caddy runs it exactly as caddy_load would; after a root ` +
          `caddy_config_delete 'overwrite' answers 404 instead, while 'insert' succeeds only then and answers 409 otherwise): ` +
          `every app, server and route not in \`value\` is discarded, and so is the 'admin' block unless \`value\` carries ` +
          `one. Caddy then re-binds its admin endpoint to the new config's admin.listen, or to its default address ` +
          `(localhost:2019, or $CADDY_ADMIN in Caddy's environment) when it sets none, or to no address at all when it sets ` +
          `admin.disabled; and if CADDY_ADMIN_URL points anywhere else neither this server nor caddy_revert can reach Caddy ` +
          `afterwards. The current config is snapshotted first, so caddy_revert can restore it while Caddy is still ` +
          `reachable. To change one part of the config, ${narrower}; to replace all of it deliberately, caddy_load does the ` +
          `same behind the same gate. Re-run with confirm:true to proceed.`,
      },
    ],
  };
}

/**
 * A confirmed whole-config write: PATCH, POST or PUT at the config root.
 *
 * Caddy never distinguishes the root from a leaf: PATCH and POST at `/config/`
 * set `rawCfg["config"]` to the body (admin.go:1279 and :1296 at v2.11.4) and
 * run it -- the same full replace as `POST /load`. It takes the 'admin' block
 * with it unless the new value carries one, after which Caddy re-binds its
 * admin endpoint to the new config's admin.listen or to DefaultAdminListen
 * (admin.go:398-402 and :411). So this has to leave something to revert to and
 * say where the endpoint went. `/id/<id>` for an @id that names the root is the
 * same request (Caddy resolves it to `/config`; verified against 2.11.4 for
 * PATCH, POST, PUT and DELETE), which is why caddy_config_by_id comes here too.
 *
 * Same pattern as rootConfigDelete, and for the same reasons (see there): read
 * first, so the write carries the If-Match for exactly the config being
 * snapshotted; send the CANONICAL "" rather than the caller's spelling, so the
 * request hits the same cache key the read filled and never the `/config//`
 * redirect; and defer the snapshot push until the write has come back, keeping
 * it only for a success or a deadline that fired -- Caddy goes on applying a
 * config change after the client hangs up, and a timed-out change is never
 * replayed. `trigger` names the calling tool on the snapshot and in the reply.
 */
async function rootConfigWrite(mode: WriteMode, value: unknown, trigger: string) {
  const current = await api.configGet();
  const res = await writeAt(mode, "", value);
  const kept = (res.ok || res.outcomeUnknown === true) && current.ok && isSnapshotableConfig(current.data);
  if (kept) saveSnapshot(current.data, trigger);
  // Computed once, from the same evidence, for both the success message and
  // the timed-out one below -- so the two can never make different claims
  // about where the admin endpoint went.
  const adminNote = rootWriteAdminNote(current, value);
  if (!res.ok) {
    // A deadline that fired carries the admin note whether or not a snapshot
    // was kept: the note's admin.disabled and new-listen cases depend only on
    // `value`, and an operator whose write disabled or moved the endpoint needs
    // to hear it most when the next re-read fails.
    if (res.outcomeUnknown && (kept || adminNote)) {
      const snapshotPart = kept
        ? `The pre-write config was kept anyway, as snapshot [0] (trigger=${trigger}): if this write did apply, ` +
          `caddy_revert { action: "apply", index: 0, confirm: true } restores what it replaced, as long as this server can ` +
          `still reach Caddy's admin endpoint.`
        : "";
      const adminPart = adminNote ? `If the write applied:${adminNote}` : "";
      const tail = kept ? "If it did not apply, that snapshot is simply the config read just before it was sent." : "";
      return formatResult({
        ...res,
        error: `${res.error}\n${[snapshotPart, adminPart, tail].filter(Boolean).join(" ")}`,
      });
    }
    return formatResult(res);
  }
  const note = priorConfigNote(kept, current, trigger);
  return {
    content: [
      {
        type: "text" as const,
        text: `Replaced the entire config (every app and server, and the 'admin' block).${note}${adminNote}`,
      },
    ],
  };
}

/** The refusal for a whole-config delete sent without confirm=true; `target` as for rootWriteRefusal. */
function rootDeleteRefusal(target: string) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text:
          `Refusing to delete the ENTIRE config without confirm=true. ${target} This unloads every app and server, and ` +
          `the 'admin' block with them: Caddy then re-binds its admin endpoint to its default address (localhost:2019, or ` +
          `$CADDY_ADMIN in Caddy's environment), and if CADDY_ADMIN_URL points anywhere else neither this server nor ` +
          `caddy_revert can reach Caddy afterwards. The current config is snapshotted first, so caddy_revert can restore it ` +
          `while Caddy is still reachable. To REPLACE the config rather than unload it, use caddy_load. Re-run with ` +
          `confirm:true to proceed.`,
      },
    ],
  };
}

/**
 * A confirmed whole-config delete: DELETE at the config root.
 *
 * Caddy deletes the "config" key itself, marshals the result to null and runs
 * it, which unloads every app AND drops the admin block -- the admin endpoint
 * then falls back to DefaultAdminListen (localhost:2019, or $CADDY_ADMIN in
 * Caddy's environment). Verified against Caddy 2.11.4: after DELETE /config/ on
 * an instance whose config set admin.listen, the configured port closed and the
 * admin API answered on the default address instead.
 *
 * Snapshot ONLY a root delete, and mirror caddy_load's pattern exactly: read
 * first, then defer the push until the delete has come back, because a delete
 * that failed changed nothing server-side and a snapshot for it would just
 * consume a slot in the 10-deep ring and shift the user's older rollback
 * targets one position deeper. Routine leaf deletes stay unsnapshotted for the
 * same reason -- one route removal per snapshot would evict the caddy_load
 * rollback targets that the ring exists for.
 *
 * The read is also what makes the snapshot trustworthy: it refreshes the cached
 * ETag for "/config/", so the DELETE carries If-Match and Caddy either deletes
 * exactly the config that was just read or answers 412 (passed through
 * verbatim). The DELETE therefore has to go out under the SAME cache key the
 * GET just filled, which is why it is sent to "" rather than the caller's
 * spelling: api.ts would encode "//" into `/config//` -- a different key, so
 * the If-Match would be dropped and the guarantee would quietly not hold.
 */
async function rootConfigDelete(trigger: string) {
  const current = await api.configGet();
  const res = await api.configDelete("");
  // Same exception as caddy_load: a deadline that fired (`res.outcomeUnknown`)
  // is not "nothing happened" -- Caddy goes on applying a config change it has
  // read after the client hangs up, and a timed-out change is never replayed,
  // so the config this delete may have unloaded is recorded nowhere else.
  const kept = (res.ok || res.outcomeUnknown === true) && current.ok && isSnapshotableConfig(current.data);
  if (kept) saveSnapshot(current.data, trigger);
  if (!res.ok) {
    if (res.outcomeUnknown && kept) {
      return formatResult({
        ...res,
        error:
          `${res.error}\nThe pre-delete config was kept anyway, as snapshot [0] (trigger=${trigger}): if this delete ` +
          `did apply, caddy_revert { action: "apply", index: 0, confirm: true } restores what it unloaded -- as long as this ` +
          `server can still reach Caddy's admin endpoint, which moves back to Caddy's default address when the deleted ` +
          `config set an admin.listen of its own. If the delete did not apply, that snapshot is simply the config read ` +
          `just before it was sent.`,
      });
    }
    return formatResult(res);
  }
  // Say what was saved, or why nothing was (priorConfigNote keeps the two
  // "nothing" reasons apart).
  const note = priorConfigNote(kept, current, trigger);
  // The admin endpoint only MOVES when the unloaded block supplied a `listen`
  // that differs from DefaultAdminListen -- NOT on the mere presence of an
  // 'admin' key (adminListenOf spells out why). `kept` is what makes
  // current.data readable as a config object. The message stays hedged because
  // this client cannot resolve the two things that decide it: $CADDY_ADMIN
  // lives in Caddy's environment, not ours, and Caddy runs `listen` through the
  // Replacer before the empty test (admin.go:1392-1398), so "{env.X}" can
  // expand to empty and mean the default too. An unreadable prior config gets
  // its own hedged note rather than none: it may have set an admin.listen, and
  // silence would read as "nothing moved".
  const listen = kept ? adminListenOf(current.data) : undefined;
  const adminNote =
    listen !== undefined
      ? ` The unloaded config set admin.listen to "${listen}". If that was not already Caddy's default admin address, the endpoint has moved back to the default (localhost:2019, unless $CADDY_ADMIN is set in Caddy's environment) and CADDY_ADMIN_URL (${process.env.CADDY_ADMIN_URL || "http://localhost:2019"}) may no longer reach it.`
      : current.ok
        ? ""
        : unreadablePriorAdminNote("unloaded");
  return {
    content: [
      {
        type: "text" as const,
        text: `Unloaded the entire config (every app and server, and the 'admin' block).${note}${adminNote}`,
      },
    ],
  };
}

/**
 * Does a caddy_config_by_id subpath leave the request AT the identified object?
 * Empty, slashes only, or a lone trailing "..." (which Caddy strips before it
 * picks a method, as for isRootConfigPath). Unlike a config path there is no
 * "config/" prefix to strip: under `/id/<id>/` a subpath of "config" is a key
 * named "config" inside the identified object, a leaf.
 */
function isAtIdentifiedObject(subpath: string): boolean {
  return /^\/*(\.\.\.\/*)?$/.test(subpath);
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
    "Write config at a JSON path. Mode 'overwrite' (default) replaces the value at the path (PATCH) — idempotent, but it replaces the WHOLE subtree there: writing [] to '.../routes' drops every route. Mode 'append' (POST) adds to an array — NOT idempotent: calling twice with the same route duplicates it — but on a non-array key it REPLACES whatever is there, and it cannot create missing parent objects. Mode 'insert' (PUT) inserts at an array index (useful for route ordering), or strictly creates an object key together with any missing parents and fails with 409 if the key already exists — the safe way to create a server or app, including on an instance with no config at all. " +
      "Any path that addresses the config ROOT ('', '/', 'config', '/config/', a slash-only variant, or any of those followed by a lone '...' segment) addresses the ENTIRE config and requires confirm=true: 'overwrite' and 'append' there REPLACE the whole configuration with `value` — Caddy runs it exactly as caddy_load would — so every app, server and route not in `value` is discarded, and so is the 'admin' block unless `value` carries one. Caddy then re-binds its admin endpoint to the new config's admin.listen, or to its default address (localhost:2019, or $CADDY_ADMIN in Caddy's environment) when it sets none, or to no address at all when it sets admin.disabled; if CADDY_ADMIN_URL points anywhere else, neither this server nor caddy_revert can reach Caddy afterwards. A root write is snapshotted first, so caddy_revert can restore it while Caddy is still reachable; no other path is snapshotted. 'insert' at the root only succeeds after a root caddy_config_delete (Caddy answers 409 on any other instance, including one started with no config), and 'overwrite' is the reverse: after a root caddy_config_delete it answers 404 until 'append', 'insert' or caddy_load re-creates the config. To replace the whole config deliberately, caddy_load does the same thing behind the same gate and also accepts a Caddyfile.",
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
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Must be true when `path` addresses the config root ('', '/', 'config', '/config/', slash-only variants, or a lone '...' segment): that write replaces the ENTIRE config (safety). Ignored for every other path.",
        ),
    },
    // destructiveHint is TRUE because the hint covers the whole tool and a host
    // gates on it before it can see the path or the mode: the default mode is a
    // PATCH that replaces whatever subtree the path names -- a route list, a
    // server, all of `apps` -- and at the root it replaces the entire config
    // (below). MCP defines destructiveHint:false as "only additive updates".
    // Appending to an array or strictly creating a key is additive; the
    // default mode is not, and neither is 'append' on a non-array key, which
    // replaces it. idempotentHint stays false for 'append', which is a POST: a
    // repeated call appends a second copy.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ path, value, mode, confirm }) => {
      // A root path is a different operation wearing the same tool. Caddy never
      // distinguishes the root from a leaf: PATCH and POST at `/config/` set
      // `rawCfg["config"]` to the body (admin.go:1279 and :1296 at v2.11.4) and
      // run it -- the same full replace as `POST /load`, minus caddy_load's
      // confirm gate and snapshot. It takes the 'admin' block with it unless the
      // new value carries one, after which Caddy re-binds its admin endpoint to
      // the new config's admin.listen or to DefaultAdminListen (admin.go:398-402
      // and :411). Verified against Caddy 2.11.4: `PATCH /config/` with a value
      // lacking an admin block replaced every server and moved the admin
      // endpoint back to the default address, on which this server -- still
      // pointed at the old one -- could no longer reach it. So this branch has to
      // (a) say that before the fact and (b) leave something to revert to.
      if (!api.isRootConfigPath(path)) return formatResult(await writeAt(mode, path, value));
      if (!confirm) {
        return rootWriteRefusal(
          `The path "${path}" addresses the config root.`,
          "pass its path instead (e.g. 'apps/http/servers/srv0')",
        );
      }
      return rootConfigWrite(mode, value, "caddy_config_set");
    },
  );

  server.tool(
    "caddy_config_delete",
    "Delete config at a JSON path. Removes the config node at the specified path. Deleting a parent node also deletes every descendant -- e.g. deleting 'apps/http/servers/srv0' removes that server and all of its routes. Requires confirm=true. " +
      "Any path that addresses the config ROOT ('', '/', 'config', '/config/', slash-only variants of those, or any of those followed by a lone '...' segment) addresses the ENTIRE config and unloads it: every app and server goes, and so does the 'admin' block, after which Caddy re-binds its admin endpoint to its default address " +
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
    // either: apart from a root delete (below), only whole-config changes
    // capture a snapshot -- caddy_load, a caddy_revert apply, and a root
    // caddy_config_set -- so a spurious repeat cannot be undone with
    // caddy_revert.
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
      const root = api.isRootConfigPath(path);
      if (!confirm) {
        if (root) return rootDeleteRefusal(`The path "${path}" addresses the config root.`);
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
      if (!root) return formatResult(await api.configDelete(path));
      return rootConfigDelete("caddy_config_delete");
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
      "or caddy_config_set at the config root (any path that addresses the whole config), and before a caddy_config_by_id set or delete whose @id names the root; no other delete or set is snapshotted. Last 10. " +
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
    "Access config by @id tag. Any config object with an '@id' field can be read, updated, or deleted by its ID instead of needing its full path. This is the recommended way to manage individual routes and config objects. The 'delete' action requires confirm=true. " +
      "If `id` is the config's own top-level '@id', it names the ENTIRE config: 'set' and 'delete' with no subpath (or a lone '...') then act on the whole configuration exactly as caddy_config_set and caddy_config_delete do at the config root -- 'set' replaces it and 'delete' unloads it, the 'admin' block included, so Caddy's admin endpoint can move and CADDY_ADMIN_URL stop reaching it. Both then require confirm=true, snapshot the prior config first so caddy_revert can restore it, and report where the admin endpoint went. A subpath inside it (e.g. 'apps/http') is an ordinary write.",
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
        .describe(
          "Must be true to actually delete, and to 'set' when `id` is the config's own top-level '@id' (that replaces the ENTIRE config). Ignored for every other 'set'.",
        ),
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
      if (action === "set" && value === undefined) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Error: value is required for 'set' action" }],
        };
      }
      // An @id can name the config ROOT: Caddy accepts a top-level "@id" and
      // indexes it at /config, so `/id/<id>` (and `/id/<id>/...`, whose "..."
      // Caddy strips before it picks a method) is then byte-for-byte the same
      // request as `/config/` -- PATCH and POST replace the whole config, PUT
      // answers 409, DELETE unloads it. Verified against Caddy 2.11.4. That is
      // the whole-config write caddy_config_set and caddy_config_delete gate,
      // snapshot and explain, so it takes their branch (issue #60).
      //
      // The check reads only the top-level "@id" -- a few bytes, not the whole
      // config -- and only when the subpath leaves the request AT the object;
      // any deeper subpath is a leaf even under a root @id. Caddy answers
      // `null` when the key is absent, including on an instance with no config
      // at all, so a failed read is a real failure and nothing is written: this
      // client cannot tell whether the call it was about to send would replace
      // the whole config. Race: a config that GAINS this top-level @id between
      // the read and the write would slip through; that needs a concurrent
      // whole-config change carrying exactly this id.
      if (isAtIdentifiedObject(subpath)) {
        const top = await api.configGet("@id");
        if (!top.ok) {
          return formatResult({
            ...top,
            error:
              `Could not read the config's top-level "@id" to check whether @id "${id}" names the whole config, so ` +
              `nothing was changed.\n${top.error}`,
          });
        }
        if (top.data === id) {
          const target = `The @id "${id}" is the config's own top-level "@id", so it names the config root.`;
          if (action === "set") {
            return confirm
              ? rootConfigWrite(mode, value, "caddy_config_by_id")
              : rootWriteRefusal(target, "pass a subpath inside it instead (e.g. subpath 'apps/http')");
          }
          return confirm ? rootConfigDelete("caddy_config_by_id") : rootDeleteRefusal(target);
        }
      }
      if (action === "set") {
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
