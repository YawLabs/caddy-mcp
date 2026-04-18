import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiResponse } from "../api.js";
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

/** Build an error result surfacing both PATCH and POST fallback failures */
function bothErrors(label: string, patchRes: ApiResponse, postRes: ApiResponse) {
  const patchErr = patchRes.error || `HTTP ${patchRes.status}`;
  const postErr = postRes.error || `HTTP ${postRes.status}`;
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: `Error: Failed to set ${label}.\n  PATCH attempt: ${patchErr}\n  POST fallback: ${postErr}`,
      },
    ],
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
        const patchRes = await api.configPatch("apps/tls/automation/policies/0/issuers/0/email", email);
        if (patchRes.ok) return { content: [{ type: "text" as const, text: `ACME email set to: ${email}` }] };
        // Path doesn't exist — create the full TLS structure
        const postRes = await api.configPost("apps/tls", buildTlsConfig({ email }));
        if (postRes.ok) return { content: [{ type: "text" as const, text: `ACME email set to: ${email}` }] };
        return bothErrors("ACME email", patchRes, postRes);
      }
      if (action === "set_acme_ca") {
        if (!ca)
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: ca is required for set_acme_ca action" }],
          };
        const patchRes = await api.configPatch("apps/tls/automation/policies/0/issuers/0/ca", ca);
        if (patchRes.ok) return { content: [{ type: "text" as const, text: `ACME CA set to: ${ca}` }] };
        // Path doesn't exist — create the full TLS structure
        const postRes = await api.configPost("apps/tls", buildTlsConfig({ ca }));
        if (postRes.ok) return { content: [{ type: "text" as const, text: `ACME CA set to: ${ca}` }] };
        return bothErrors("ACME CA", patchRes, postRes);
      }
      return { isError: true, content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
    },
  );
}
