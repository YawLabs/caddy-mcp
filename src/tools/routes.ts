import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

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
        .regex(/^[\w-]+$/)
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
        .regex(/^[\w-]+$/)
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
        .regex(/^[\w-]+$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name (default: srv0)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ server: srv }) => {
      const serverRes = await api.configGet(`apps/http/servers/${srv}`);
      if (!serverRes.ok) return formatResult(serverRes);

      const serverConfig = serverRes.data;
      const routes = serverConfig?.routes || [];
      const listen = serverConfig?.listen || [];

      if (routes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Server ${srv} (listen: ${listen.join(", ") || "default"}) — no routes configured`,
            },
          ],
        };
      }

      const lines: string[] = [`Server: ${srv} (listen: ${listen.join(", ") || "default"})`, ""];
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i];

        const id = route["@id"] ? ` @id="${route["@id"]}"` : "";
        const group = route.group ? ` group="${route.group}"` : "";

        const matchers = (route.match || [])
          .map((m: any) => {
            const parts: string[] = [];
            if (m.host) parts.push(`host=[${m.host.join(",")}]`);
            if (m.path) parts.push(`path=[${m.path.join(",")}]`);
            if (m.method) parts.push(`method=[${m.method.join(",")}]`);
            if (m.protocol) parts.push(`protocol=${m.protocol}`);
            if (m.remote_ip) parts.push(`remote_ip=[${m.remote_ip.ranges?.join(",") || "..."}]`);
            if (m.client_ip) parts.push(`client_ip=[${m.client_ip.ranges?.join(",") || "..."}]`);
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

        const handlers = (route.handle || [])
          .map((h: any) => {
            if (h.handler === "reverse_proxy") {
              const upstreams = (h.upstreams || []).map((u: any) => u.dial).join(",");
              return `reverse_proxy(${upstreams})`;
            }
            if (h.handler === "file_server") return `file_server(${h.root || "."})`;
            if (h.handler === "static_response") return `static_response(${h.status_code || 200})`;
            if (h.handler === "rewrite") return `rewrite(${h.uri || "..."})`;
            if (h.handler === "subroute") return `subroute(${h.routes?.length || 0} routes)`;
            if (h.handler === "encode") return "encode";
            if (h.handler === "headers") return "headers";
            if (h.handler === "authentication")
              return `auth(${h.providers ? Object.keys(h.providers).join(",") : "..."})`;
            if (h.handler === "error") return `error(${h.status_code || "..."})`;
            return h.handler || "unknown";
          })
          .join(" → ");

        lines.push(`  Route ${i}:${id}${group} ${matchers} → ${handlers}${route.terminal ? " [terminal]" : ""}`);
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
