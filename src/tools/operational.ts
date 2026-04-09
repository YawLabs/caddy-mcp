import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

export function registerOperationalTools(server: McpServer) {
  server.tool(
    "caddy_status",
    "Check Caddy connectivity and get a config summary: servers, routes, listen addresses, and TLS status.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      const res = await api.configGet();
      if (!res.ok) return formatResult(res);

      const config = res.data || {};
      const httpApp = config?.apps?.http;
      const servers = httpApp?.servers || {};
      const serverNames = Object.keys(servers);

      const lines: string[] = ["Caddy is running", ""];

      if (serverNames.length === 0) {
        lines.push("No HTTP servers configured");
      } else {
        for (const name of serverNames) {
          const srv = servers[name];
          const listen = srv.listen || [];
          const routes = srv.routes || [];
          const tls = srv.tls_connection_policies ? "enabled" : "auto";
          lines.push(
            `Server "${name}": ${routes.length} route(s), listen: ${listen.join(", ") || "default"}, TLS: ${tls}`,
          );
        }
      }

      const tlsApp = config?.apps?.tls;
      if (tlsApp?.automation?.policies) {
        const email = tlsApp.automation.policies.find((p: any) => p.issuers)?.issuers?.[0]?.email;
        if (email) lines.push(`\nACME email: ${email}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "caddy_upstreams",
    "Get the current health status of all reverse proxy upstreams. Shows address, active requests, and failure counts.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => formatResult(await api.getUpstreams()),
  );

  server.tool(
    "caddy_pki",
    "Get PKI certificate authority info or the CA certificate chain.",
    {
      ca: z.string().optional().default("local").describe("CA ID (default: 'local')"),
      certificates: z.boolean().optional().default(false).describe("If true, return the full CA certificate chain"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ ca, certificates }) => {
      const res = certificates ? await api.getPkiCertificates(ca) : await api.getPki(ca);
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_stop",
    "Gracefully shut down the Caddy server. Requires confirm=true to prevent accidental shutdown.",
    { confirm: z.boolean().describe("Must be true to confirm shutdown") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ confirm }) => {
      if (!confirm) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Error: confirm must be true to shut down Caddy" }],
        };
      }
      return formatResult(await api.stop());
    },
  );
}
