import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

interface CaddyServerSummary {
  listen?: unknown;
  routes?: unknown;
  tls_connection_policies?: unknown;
}

interface CaddyTlsIssuer {
  email?: unknown;
  ca?: unknown;
  module?: unknown;
}

interface CaddyTlsPolicy {
  issuers?: unknown;
}

interface CaddyConfigShape {
  apps?: {
    http?: {
      servers?: Record<string, CaddyServerSummary>;
    };
    tls?: {
      automation?: {
        policies?: unknown;
      };
    };
  };
}

function describeServer(raw: CaddyServerSummary): string {
  const listen: unknown[] = Array.isArray(raw.listen) ? raw.listen : [];
  const routes: unknown[] = Array.isArray(raw.routes) ? raw.routes : [];
  const hasExplicitTls = !!raw.tls_connection_policies;
  const listensHttps = listen.some((l) => typeof l === "string" && l.includes(":443"));
  const tls = hasExplicitTls ? "enabled" : listensHttps ? "auto (HTTPS)" : "off (HTTP only)";
  const listenStr = listen.length > 0 ? listen.map(String).join(", ") : "default";
  return `${routes.length} route(s), listen: ${listenStr}, TLS: ${tls}`;
}

function findAcmeEmail(policies: unknown): string | undefined {
  if (!Array.isArray(policies)) return undefined;
  for (const rawPolicy of policies) {
    if (!rawPolicy || typeof rawPolicy !== "object") continue;
    const policy = rawPolicy as CaddyTlsPolicy;
    if (!Array.isArray(policy.issuers)) continue;
    for (const rawIssuer of policy.issuers) {
      if (!rawIssuer || typeof rawIssuer !== "object") continue;
      const issuer = rawIssuer as CaddyTlsIssuer;
      if (typeof issuer.email === "string") return issuer.email;
    }
  }
  return undefined;
}

export function registerOperationalTools(server: McpServer) {
  server.tool(
    "caddy_status",
    "Check Caddy connectivity and get a config summary: servers, routes, listen addresses, and TLS status.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      const res = await api.configGet<CaddyConfigShape>();
      if (!res.ok) return formatResult(res);

      const config = res.data ?? {};
      const servers = config.apps?.http?.servers ?? {};
      const serverNames = Object.keys(servers);

      const lines: string[] = ["Caddy is running", ""];

      if (serverNames.length === 0) {
        lines.push("No HTTP servers configured");
      } else {
        for (const name of serverNames) {
          lines.push(`Server "${name}": ${describeServer(servers[name])}`);
        }
      }

      const email = findAcmeEmail(config.apps?.tls?.automation?.policies);
      if (email) lines.push(`\nACME email: ${email}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "caddy_list_servers",
    "List all configured HTTP servers with their names, listen addresses, route counts, and TLS status. Use this to discover server names before calling route tools.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      const res = await api.configGet<Record<string, CaddyServerSummary>>("apps/http/servers");
      if (!res.ok) return formatResult(res);

      const servers = res.data ?? {};
      const names = Object.keys(servers);
      if (names.length === 0) {
        return { content: [{ type: "text" as const, text: "No HTTP servers configured" }] };
      }

      const lines = names.map((name) => `  ${name}: ${describeServer(servers[name])}`);
      return {
        content: [{ type: "text" as const, text: `HTTP Servers:\n${lines.join("\n")}` }],
      };
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
      ca: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("local")
        .describe("CA ID (default: 'local')"),
      certificates: z.boolean().optional().default(false).describe("If true, return the full CA certificate chain"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ ca, certificates }) => {
      const res = certificates ? await api.getPkiCertificates(ca) : await api.getPki(ca);
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_metrics",
    "Get Prometheus metrics from Caddy. Shows request counts, durations, TLS handshake stats, active connections, and more.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => formatResult(await api.getMetrics()),
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
