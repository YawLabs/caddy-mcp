import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

/** Build a minimal TLS automation config with ACME issuer fields */
function buildTlsConfig(fields: { email?: string; ca?: string }) {
  const issuer: Record<string, string> = { module: "acme" };
  if (fields.email) issuer.email = fields.email;
  if (fields.ca) issuer.ca = fields.ca;
  return {
    automation: {
      policies: [{ issuers: [issuer] }],
    },
  };
}

export function registerTlsTools(server: McpServer) {
  server.tool(
    "caddy_tls",
    "Get or configure TLS/HTTPS settings. Actions: 'status' shows current TLS config, 'set_email' sets the ACME email, 'set_acme_ca' sets the ACME CA URL. Works on both fresh and existing Caddy instances.",
    {
      action: z.enum(["status", "set_email", "set_acme_ca"]).describe("Action to perform"),
      email: z.string().optional().describe("ACME email address (for 'set_email' action)"),
      ca: z.string().optional().describe("ACME CA URL (for 'set_acme_ca' action)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ action, email, ca }) => {
      if (action === "status") {
        return formatResult(await api.configGet("apps/tls"));
      }
      if (action === "set_email") {
        if (!email)
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: email is required for set_email action" }],
          };
        // Try PATCH first (works when the path already exists)
        const res = await api.configPatch("apps/tls/automation/policies/0/issuers/0/email", email);
        if (res.ok) return { content: [{ type: "text" as const, text: `ACME email set to: ${email}` }] };
        // Path doesn't exist — create the full TLS structure
        const fallback = await api.configPost("apps/tls", buildTlsConfig({ email }));
        if (fallback.ok) return { content: [{ type: "text" as const, text: `ACME email set to: ${email}` }] };
        return formatResult(fallback);
      }
      if (action === "set_acme_ca") {
        if (!ca)
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: ca is required for set_acme_ca action" }],
          };
        const res = await api.configPatch("apps/tls/automation/policies/0/issuers/0/ca", ca);
        if (res.ok) return { content: [{ type: "text" as const, text: `ACME CA set to: ${ca}` }] };
        // Path doesn't exist — create the full TLS structure
        const fallback = await api.configPost("apps/tls", buildTlsConfig({ ca }));
        if (fallback.ok) return { content: [{ type: "text" as const, text: `ACME CA set to: ${ca}` }] };
        return formatResult(fallback);
      }
      return { isError: true, content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
    },
  );
}
