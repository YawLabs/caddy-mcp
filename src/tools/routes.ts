import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

interface CaddyServerConfig {
  listen?: unknown;
  routes?: unknown;
}

interface CaddyRoute {
  "@id"?: unknown;
  group?: unknown;
  match?: unknown;
  handle?: unknown;
  terminal?: unknown;
}

interface CaddyMatcher {
  host?: unknown;
  path?: unknown;
  method?: unknown;
  protocol?: unknown;
  remote_ip?: unknown;
  client_ip?: unknown;
  query?: unknown;
  header?: unknown;
  expression?: unknown;
  not?: unknown;
}

interface CaddyHandler {
  handler?: unknown;
  upstreams?: unknown;
  root?: unknown;
  status_code?: unknown;
  uri?: unknown;
  routes?: unknown;
  providers?: unknown;
}

interface CaddyUpstream {
  dial?: unknown;
}

/** Join an unknown value as comma-separated strings if it's an array; return "" otherwise */
function safeJoin(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((v) => v !== null && v !== undefined)
    .map(String)
    .join(",");
}

/**
 * Strip an explicit `:port` suffix from a host string. Caddy `host` matchers
 * are evaluated against the Host header value with the port removed, so a
 * matcher of "example.com:8080" never fires for a real request hitting that
 * port. Callers commonly write the port to signal "this listener" -- accept
 * it but normalize it out so the route actually matches.
 *
 * Supports:
 *   - "example.com:8080"  -> "example.com"
 *   - "1.2.3.4:80"        -> "1.2.3.4"
 *   - "[::1]:8080"        -> "[::1]" (IPv6 bracket form)
 *   - "[::1]"             -> "[::1]" (no port — unchanged)
 *   - "example.com"       -> "example.com" (no port — unchanged)
 *   - "foo:bar"           -> "foo:bar" (non-numeric suffix — leave alone
 *                            rather than silently losing data we don't
 *                            recognize as a port).
 */
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const closeIdx = host.indexOf("]");
    if (closeIdx !== -1) return host.substring(0, closeIdx + 1);
    return host;
  }
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx === -1) return host;
  const portCandidate = host.substring(colonIdx + 1);
  if (portCandidate.length === 0 || !/^\d+$/.test(portCandidate)) return host;
  return host.substring(0, colonIdx);
}

/** Parse a "from" string like "api.example.com" or "example.com/api/*" into match object */
export function parseFrom(from: string): { host?: string[]; path?: string[] } {
  const cleaned = from.replace(/^https?:\/\//, "");
  const match: { host?: string[]; path?: string[] } = {};
  const slashIdx = cleaned.indexOf("/");
  if (slashIdx > 0) {
    match.host = [stripPort(cleaned.substring(0, slashIdx))];
    const path = cleaned.substring(slashIdx);
    // A bare trailing slash (path === "/") is dropped: Caddy path matchers are
    // exact-string (with optional trailing "*"), so path: ["/"] would match
    // ONLY requests for the literal root path. Callers writing "example.com/"
    // almost always mean host-only (= all paths). Real paths with trailing
    // slashes ("example.com/api/" -> "/api/") are preserved -- "/api" and
    // "/api/" are distinct matchers.
    if (path !== "/") {
      match.path = [path];
    }
  } else if (cleaned.startsWith("/")) {
    match.path = [cleaned];
  } else {
    match.host = [stripPort(cleaned)];
  }
  return match;
}

/** Clean an upstream address — strip scheme, validate host:port format */
function cleanUpstreamAddr(addr: string): string {
  return addr.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Detect Caddy's "parent path does not exist" failure mode for a config write.
 *
 * Caddy returns this when writing to a path whose parent (e.g.
 * `apps/http/servers/<srv>`) doesn't exist. Across versions the exact status
 * varies (observed: 400, 404, sometimes 500), but the body reliably contains
 * "key does not exist". Belt-and-braces: trust 404 as a status, OR any non-2xx
 * response whose body contains the marker phrase.
 */
function isParentMissing(res: { ok: boolean; status: number; error?: string }): boolean {
  if (res.ok) return false;
  if (res.status === 404) return true;
  return res.error?.includes("key does not exist") ?? false;
}

/**
 * Detect Caddy's "unknown @id" failure mode for a GET to /id/<id>.
 *
 * Caddy's /id/<id> virtual path resolves only @ids that ALREADY exist in the
 * config tree. A bare GET against an unknown @id returns 404, sometimes with
 * a body like "unknown object ID '<id>'" or "no ID found".
 *
 * Tight markers only: status 404, OR a body whose lowercased form contains
 * one of the specific phrases Caddy uses for missing @ids. Avoid matching the
 * loose token "unknown" alone -- validation errors like "unknown handler 'x'"
 * or "unknown directive 'y'" must not be misclassified as missing-id, since
 * we use this helper to decide whether to speculatively create on POST.
 */
function isUnknownId(res: { ok: boolean; status: number; error?: string }): boolean {
  if (res.ok) return false;
  if (res.status === 404) return true;
  const body = (res.error ?? "").toLowerCase();
  return body.includes("unknown object id") || body.includes("no id found");
}

/**
 * A Caddy route always carries a top-level `handle` array. Other config
 * objects an @id can point at -- TLS issuers, server blocks, listener entries,
 * individual handler configs nested elsewhere -- do not. We use this to refuse
 * clobbering when the supplied `id` resolves to something that isn't a route:
 * @ids are config-global in Caddy, not route-scoped, so a colliding id from a
 * different subsystem would otherwise get silently overwritten.
 */
function isRouteShape(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  return Array.isArray((obj as { handle?: unknown }).handle);
}

/** Build an error result for when a server doesn't exist */
function serverNotFoundError(srv: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Error: Server "${srv}" does not exist. Use caddy_list_servers to see available servers, or create one with caddy_load or caddy_config_set at path 'apps/http/servers/${srv}' with at minimum: { "listen": [":443"] }`,
      },
    ],
  };
}

export function registerRouteTools(server: McpServer) {
  server.tool(
    "caddy_reverse_proxy",
    "Add a reverse proxy route. The most common operation — just specify where traffic comes from and where it goes. Example: from='api.local' to=['localhost:3000']. " +
      "When `id` is OMITTED the route is appended to the server's routes array — calling the tool twice with the same args produces TWO duplicate routes (non-idempotent). " +
      "When `id` is SUPPLIED the route is written via PUT under that @id, so repeat calls REPLACE in place (idempotent). " +
      "Strongly recommended: supply a stable `id` for any route managed from automation or production tooling. " +
      "Note: @ids are config-global in Caddy (NOT route-scoped). If `id` collides with an @id used by a non-route object (TLS issuer, server, etc.) the call refuses with an error rather than clobbering it. Once an @id is registered to a route under one server, subsequent calls update that route in place regardless of the `server` argument.",
    {
      from: z.string().describe("Domain, path, or domain/path to match (e.g., 'api.local', '/api/*', 'app.local/ws')"),
      to: z.array(z.string()).describe("Upstream addresses (e.g., ['localhost:3000', 'localhost:3001'])"),
      server: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name (default: srv0)"),
      id: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .describe(
          "Optional stable @id for the route. When set, repeat calls REPLACE the route in place (idempotent). When omitted, the route is APPENDED — calling twice with identical args creates a duplicate route. @ids are config-global in Caddy: if this id is already used by a non-route object the call refuses rather than clobbering it.",
        ),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ from, to, server: srv, id }) => {
      const match = parseFrom(from);
      const cleanedTo = to.map(cleanUpstreamAddr);
      const route: Record<string, unknown> = {
        match: [match],
        handle: [
          {
            handler: "reverse_proxy",
            upstreams: cleanedTo.map((addr) => ({ dial: addr })),
          },
        ],
        terminal: true,
      };
      if (id) {
        route["@id"] = id;
        // GET-first dispatch on the supplied @id:
        //   200 + route shape  -> PUT /id/<id> to replace in place (idempotent).
        //   200 + non-route    -> refuse: @ids are config-global, don't clobber
        //                         a TLS issuer / server / handler that happens
        //                         to share this id.
        //   404 / unknown-id   -> POST the route body (with @id embedded) under
        //                         the real config path so the @id registers;
        //                         subsequent calls then hit the PUT happy path.
        //   any other error    -> surface verbatim (don't speculatively write).
        // The GET costs one extra round-trip on the replace path but eliminates
        // the speculative-PUT clobber risk and removes the need to body-match
        // failure modes on a write.
        const existing = await api.configByIdGet(id);
        if (existing.ok) {
          if (!isRouteShape(existing.data)) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    `Error: @id "${id}" is already in use by a non-route config object ` +
                    `(no top-level "handle" array). @ids are config-global in Caddy, not ` +
                    `route-scoped -- pick a different id, or remove the existing object first ` +
                    `with caddy_config_by_id { id: "${id}", action: "delete" }.`,
                },
              ],
            };
          }
          const putRes = await api.configByIdSet(id, route, "PUT");
          if (putRes.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Route set @id="${id}": ${from} → ${cleanedTo.join(", ")}`,
                },
              ],
            };
          }
          return formatResult(putRes);
        }
        // GET failed. Only treat tight unknown-id markers as "first-create";
        // any other GET failure surfaces verbatim so we don't follow a real
        // error (auth, transport, validation) with a speculative POST.
        if (!isUnknownId(existing)) {
          return formatResult(existing);
        }
        const postRes = await api.configPost(`apps/http/servers/${srv}/routes`, route);
        if (postRes.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Route created @id="${id}": ${from} → ${cleanedTo.join(", ")}`,
              },
            ],
          };
        }
        // POST failed -- parent-missing now genuinely means the server doesn't
        // exist (the @id is confirmed-absent by the GET above).
        if (isParentMissing(postRes)) {
          return serverNotFoundError(srv);
        }
        return formatResult(postRes);
      }
      const res = await api.configPost(`apps/http/servers/${srv}/routes`, route);
      if (res.ok) {
        return { content: [{ type: "text" as const, text: `Route added: ${from} → ${cleanedTo.join(", ")}` }] };
      }
      if (isParentMissing(res)) {
        return serverNotFoundError(srv);
      }
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_add_route",
    "Add a route with full control over match conditions and handlers. Supports any Caddy handler (reverse_proxy, file_server, static_response, redirect, encode, headers, etc.).",
    {
      match: z
        .array(z.record(z.string(), z.any()))
        .describe("Array of match objects (e.g., [{ host: ['example.com'], path: ['/api/*'] }])"),
      handle: z
        .array(z.record(z.string(), z.any()))
        .describe("Array of handler objects (e.g., [{ handler: 'file_server', root: '/var/www' }])"),
      server: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name (default: srv0)"),
      terminal: z.boolean().optional().default(true).describe("Stop processing further routes after this one matches"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ match, handle, server: srv, terminal }) => {
      const route = { match, handle, terminal };
      const res = await api.configPost(`apps/http/servers/${srv}/routes`, route);
      if (isParentMissing(res)) {
        return serverNotFoundError(srv);
      }
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_list_routes",
    "List all routes on a Caddy HTTP server with a human-readable summary of matchers and handlers.",
    {
      server: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name (default: srv0)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ server: srv }) => {
      const serverRes = await api.configGet<CaddyServerConfig>(`apps/http/servers/${srv}`);
      if (!serverRes.ok) return formatResult(serverRes);

      const serverConfig = serverRes.data || {};
      const routes: unknown[] = Array.isArray(serverConfig.routes) ? serverConfig.routes : [];
      const listen: unknown[] = Array.isArray(serverConfig.listen) ? serverConfig.listen : [];
      const listenStr = listen.map(String).join(", ") || "default";

      if (routes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Server ${srv} (listen: ${listenStr}) — no routes configured`,
            },
          ],
        };
      }

      const lines: string[] = [`Server: ${srv} (listen: ${listenStr})`, ""];
      for (let i = 0; i < routes.length; i++) {
        const rawRoute = routes[i];
        if (!rawRoute || typeof rawRoute !== "object") {
          lines.push(`  Route ${i}: <invalid>`);
          continue;
        }
        const route = rawRoute as CaddyRoute;

        const idVal = typeof route["@id"] === "string" ? route["@id"] : undefined;
        const groupVal = typeof route.group === "string" ? route.group : undefined;
        const id = idVal ? ` @id="${idVal}"` : "";
        const group = groupVal ? ` group="${groupVal}"` : "";

        const matchList: unknown[] = Array.isArray(route.match) ? route.match : [];
        const matchers = matchList
          .map((rawMatcher) => {
            if (!rawMatcher || typeof rawMatcher !== "object") return "catch-all";
            const m = rawMatcher as CaddyMatcher;
            const parts: string[] = [];
            const host = safeJoin(m.host);
            if (host) parts.push(`host=[${host}]`);
            const path = safeJoin(m.path);
            if (path) parts.push(`path=[${path}]`);
            const method = safeJoin(m.method);
            if (method) parts.push(`method=[${method}]`);
            if (typeof m.protocol === "string") parts.push(`protocol=${m.protocol}`);
            if (m.remote_ip && typeof m.remote_ip === "object") {
              const ranges = safeJoin((m.remote_ip as { ranges?: unknown }).ranges);
              parts.push(`remote_ip=[${ranges || "..."}]`);
            }
            if (m.client_ip && typeof m.client_ip === "object") {
              const ranges = safeJoin((m.client_ip as { ranges?: unknown }).ranges);
              parts.push(`client_ip=[${ranges || "..."}]`);
            }
            if (m.query) parts.push("query=...");
            if (m.header) parts.push("header=...");
            if (m.expression) parts.push(`expr(${typeof m.expression === "string" ? m.expression : "..."})`);
            if (m.not) parts.push("not(...)");
            // Show any unrecognized matcher types
            const known = new Set([
              "host",
              "path",
              "method",
              "protocol",
              "remote_ip",
              "client_ip",
              "query",
              "header",
              "expression",
              "not",
            ]);
            for (const key of Object.keys(m)) {
              if (!known.has(key)) parts.push(`${key}=...`);
            }
            if (parts.length === 0) return "catch-all";
            return parts.join(" ");
          })
          .join(" | ");

        const handleList: unknown[] = Array.isArray(route.handle) ? route.handle : [];
        const handlers = handleList
          .map((rawHandler) => {
            if (!rawHandler || typeof rawHandler !== "object") return "unknown";
            const h = rawHandler as CaddyHandler;
            if (h.handler === "reverse_proxy") {
              const upstreamsArr: unknown[] = Array.isArray(h.upstreams) ? h.upstreams : [];
              const upstreams = upstreamsArr
                .map((u) => {
                  if (u && typeof u === "object") {
                    const dial = (u as CaddyUpstream).dial;
                    if (typeof dial === "string") return dial;
                  }
                  return "?";
                })
                .join(",");
              return `reverse_proxy(${upstreams})`;
            }
            if (h.handler === "file_server") {
              const root = typeof h.root === "string" ? h.root : ".";
              return `file_server(${root})`;
            }
            if (h.handler === "static_response") {
              const status = typeof h.status_code === "number" ? h.status_code : 200;
              return `static_response(${status})`;
            }
            if (h.handler === "rewrite") {
              const uri = typeof h.uri === "string" ? h.uri : "...";
              return `rewrite(${uri})`;
            }
            if (h.handler === "subroute") {
              const count = Array.isArray(h.routes) ? h.routes.length : 0;
              return `subroute(${count} routes)`;
            }
            if (h.handler === "encode") return "encode";
            if (h.handler === "headers") return "headers";
            if (h.handler === "authentication") {
              const providers =
                h.providers && typeof h.providers === "object"
                  ? Object.keys(h.providers as Record<string, unknown>).join(",")
                  : "...";
              return `auth(${providers})`;
            }
            if (h.handler === "error") {
              const status = typeof h.status_code === "number" ? h.status_code : "...";
              return `error(${status})`;
            }
            return typeof h.handler === "string" ? h.handler : "unknown";
          })
          .join(" → ");

        const terminal = route.terminal === true ? " [terminal]" : "";
        lines.push(`  Route ${i}:${id}${group} ${matchers} → ${handlers}${terminal}`);
      }

      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          { type: "text" as const, text: JSON.stringify(routes, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "caddy_remove_route",
    "Remove a route. Target by @id (preferred — stable across reorderings) or by array index on a specific server. Index-based removal is a two-step read-then-delete and can race against concurrent edits; prefer @id when possible.",
    {
      id: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .describe("The @id of the route to remove (preferred — stable even if routes get reordered)"),
      index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Zero-based index of the route in the server's routes array (only used if id is not provided)"),
      server: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name when using index (default: srv0). Ignored when id is provided."),
      confirm: z.boolean().optional().default(false).describe("Must be true to actually remove the route (safety)"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ id, index, server: srv, confirm }) => {
      if (!id && index === undefined) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Error: must provide either id or index" }],
        };
      }
      if (!confirm) {
        const target = id ? `@id="${id}"` : `route ${index} on server "${srv}"`;
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Refusing to remove ${target} without confirm=true. Re-run with confirm:true to proceed.`,
            },
          ],
        };
      }
      if (id) {
        const res = await api.configByIdDelete(id);
        if (res.ok) return { content: [{ type: "text" as const, text: `Route @id="${id}" removed.` }] };
        return formatResult(res);
      }
      // Read first to bounds-check the index and give a clear error if out of range.
      const readRes = await api.configGet(`apps/http/servers/${srv}/routes`);
      if (!readRes.ok) return formatResult(readRes);
      const routes = readRes.data;
      if (!Array.isArray(routes)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: server "${srv}" has no routes array (or it is malformed)` }],
        };
      }
      if ((index as number) >= routes.length) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: index ${index} out of range — server "${srv}" has ${routes.length} route(s)`,
            },
          ],
        };
      }
      const res = await api.configDelete(`apps/http/servers/${srv}/routes/${index}`);
      if (res.ok) {
        return { content: [{ type: "text" as const, text: `Route ${index} removed from server "${srv}".` }] };
      }
      return formatResult(res);
    },
  );
}
