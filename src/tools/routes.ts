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

/** Parse a "from" string like "api.example.com" or "example.com/api/*" into match object */
export function parseFrom(from: string): { host?: string[]; path?: string[] } {
  const cleaned = from.replace(/^https?:\/\//, "");
  const match: { host?: string[]; path?: string[] } = {};
  const slashIdx = cleaned.indexOf("/");
  if (slashIdx > 0) {
    match.host = [cleaned.substring(0, slashIdx)];
    match.path = [cleaned.substring(slashIdx)];
  } else if (cleaned.startsWith("/")) {
    match.path = [cleaned];
  } else {
    match.host = [cleaned];
  }
  return match;
}

/** Clean an upstream address — strip scheme, validate host:port format */
function cleanUpstreamAddr(addr: string): string {
  return addr.replace(/^https?:\/\//, "").replace(/\/+$/, "");
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
    "Add a reverse proxy route. The most common operation — just specify where traffic comes from and where it goes. Example: from='api.local' to=['localhost:3000'].",
    {
      from: z.string().describe("Domain, path, or domain/path to match (e.g., 'api.local', '/api/*', 'app.local/ws')"),
      to: z.array(z.string()).describe("Upstream addresses (e.g., ['localhost:3000', 'localhost:3001'])"),
      server: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name (default: srv0)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ from, to, server: srv }) => {
      const match = parseFrom(from);
      const cleanedTo = to.map(cleanUpstreamAddr);
      const route = {
        match: [match],
        handle: [
          {
            handler: "reverse_proxy",
            upstreams: cleanedTo.map((addr) => ({ dial: addr })),
          },
        ],
        terminal: true,
      };
      const res = await api.configPost(`apps/http/servers/${srv}/routes`, route);
      if (res.ok) {
        return { content: [{ type: "text" as const, text: `Route added: ${from} → ${cleanedTo.join(", ")}` }] };
      }
      if (!res.ok && res.error?.includes("key does not exist")) {
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
      if (!res.ok && res.error?.includes("key does not exist")) {
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
}
