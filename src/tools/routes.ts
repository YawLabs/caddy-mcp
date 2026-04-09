import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

/** Parse a "from" string like "api.example.com" or "example.com/api/*" into match object */
function parseFrom(from: string): { host?: string[]; path?: string[] } {
  const match: { host?: string[]; path?: string[] } = {};
  const slashIdx = from.indexOf("/");
  if (slashIdx > 0) {
    match.host = [from.substring(0, slashIdx)];
    match.path = [from.substring(slashIdx)];
  } else if (from.startsWith("/")) {
    match.path = [from];
  } else {
    match.host = [from];
  }
  return match;
}

export function registerRouteTools(server: McpServer) {
  server.tool(
    "caddy_reverse_proxy",
    "Add a reverse proxy route. The most common operation — just specify where traffic comes from and where it goes. Example: from='api.local' to=['localhost:3000'].",
    {
      from: z.string().describe("Domain, path, or domain/path to match (e.g., 'api.local', '/api/*', 'app.local/ws')"),
      to: z.array(z.string()).describe("Upstream addresses (e.g., ['localhost:3000', 'localhost:3001'])"),
      server: z.string().optional().default("srv0").describe("Caddy server name (default: srv0)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ from, to, server: srv }) => {
      const match = parseFrom(from);
      const route = {
        match: [match],
        handle: [
          {
            handler: "reverse_proxy",
            upstreams: to.map((addr) => ({ dial: addr })),
          },
        ],
        terminal: true,
      };
      const res = await api.configPost(`apps/http/servers/${srv}/routes`, route);
      if (res.ok) {
        return { content: [{ type: "text" as const, text: `Route added: ${from} → ${to.join(", ")}` }] };
      }
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_add_route",
    "Add a route with full control over match conditions and handlers. Supports any Caddy handler (reverse_proxy, file_server, static_response, redirect, encode, headers, etc.).",
    {
      match: z
        .array(z.record(z.any()))
        .describe("Array of match objects (e.g., [{ host: ['example.com'], path: ['/api/*'] }])"),
      handle: z
        .array(z.record(z.any()))
        .describe("Array of handler objects (e.g., [{ handler: 'file_server', root: '/var/www' }])"),
      server: z.string().optional().default("srv0").describe("Caddy server name (default: srv0)"),
      terminal: z.boolean().optional().default(true).describe("Stop processing further routes after this one matches"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ match, handle, server: srv, terminal }) => {
      const route = { match, handle, terminal };
      const res = await api.configPost(`apps/http/servers/${srv}/routes`, route);
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_list_routes",
    "List all routes on a Caddy HTTP server with a human-readable summary of matchers and handlers.",
    {
      server: z.string().optional().default("srv0").describe("Caddy server name (default: srv0)"),
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
        const matchers = (route.match || [])
          .map((m: any) => {
            const parts: string[] = [];
            if (m.host) parts.push(`host=[${m.host.join(",")}]`);
            if (m.path) parts.push(`path=[${m.path.join(",")}]`);
            if (m.method) parts.push(`method=[${m.method.join(",")}]`);
            if (m.header) parts.push("header=...");
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
            if (h.handler === "encode") return "encode";
            if (h.handler === "headers") return "headers";
            return h.handler || "unknown";
          })
          .join(" → ");

        lines.push(`  Route ${i}: ${matchers} → ${handlers}${route.terminal ? " [terminal]" : ""}`);
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
