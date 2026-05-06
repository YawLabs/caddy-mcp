import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiResponse } from "../api.js";
import * as api from "../api.js";
import { formatResult } from "../format.js";

/** Build a minimal TLS automation config with ACME issuer fields (used only when apps/tls is absent) */
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

/** Build an error result surfacing both PATCH and the follow-up write failure */
function bothErrors(label: string, patchRes: ApiResponse, writeRes: ApiResponse, writeLabel: string) {
  const patchErr = patchRes.error || `HTTP ${patchRes.status}`;
  const writeErr = writeRes.error || `HTTP ${writeRes.status}`;
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: `Error: Failed to set ${label}.\n  PATCH attempt: ${patchErr}\n  ${writeLabel} fallback: ${writeErr}`,
      },
    ],
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep clone via JSON round-trip — apps/tls is plain JSON config so this is safe. */
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Apply email/ca patch to a deep copy of an existing apps/tls config that already
 * contains automation.policies[0].issuers[0]. Caller must have validated the shape.
 */
function mergeIssuerFields(existing: Record<string, unknown>, fields: { email?: string; ca?: string }) {
  const merged = deepClone(existing);
  // Cast through unknown — we've shape-checked the path before reaching here.
  const automation = merged.automation as { policies: Array<{ issuers: Array<Record<string, unknown>> }> };
  const issuer = automation.policies[0].issuers[0];
  if (fields.email !== undefined) issuer.email = fields.email;
  if (fields.ca !== undefined) issuer.ca = fields.ca;
  return merged;
}

/**
 * Validate that an existing apps/tls config has the path we need to merge into:
 * automation.policies[0].issuers[0] must be a non-null plain object.
 * Returns null if shape is OK, or a specific error message naming the missing sub-path.
 */
function validateIssuerShape(tls: Record<string, unknown>): string | null {
  const automation = tls.automation;
  if (!isPlainObject(automation)) {
    return "apps/tls.automation is missing or not an object";
  }
  const policies = (automation as Record<string, unknown>).policies;
  if (!Array.isArray(policies) || policies.length === 0) {
    return "apps/tls.automation.policies is missing, not an array, or empty";
  }
  const policy0 = policies[0];
  if (!isPlainObject(policy0)) {
    return "apps/tls.automation.policies[0] is not an object";
  }
  const issuers = (policy0 as Record<string, unknown>).issuers;
  if (!Array.isArray(issuers) || issuers.length === 0) {
    return "apps/tls.automation.policies[0].issuers is missing, not an array, or empty";
  }
  const issuer0 = issuers[0];
  if (!isPlainObject(issuer0)) {
    return "apps/tls.automation.policies[0].issuers[0] is not an object";
  }
  return null;
}

/**
 * Outcome of the safe fallback after a PATCH failure.
 *  - kind="ok": the fallback succeeded; caller emits the standard success message.
 *  - kind="tool-error": surface a tool error result (refusal or downstream failure).
 */
type FallbackOutcome =
  | { kind: "ok" }
  | { kind: "tool-error"; result: { isError: true; content: Array<{ type: "text"; text: string }> } };

/**
 * Run the safe fallback after a PATCH failure: GET apps/tls, then either
 *  - POST a fresh apps/tls (when none exists),
 *  - merge into existing config and PUT it back (preserves siblings), or
 *  - refuse with a shape-specific error (do not clobber).
 */
async function safeFallback(
  label: string,
  patchRes: ApiResponse,
  fields: { email?: string; ca?: string },
): Promise<FallbackOutcome> {
  const getRes = await api.configGet<unknown>("apps/tls");

  // Branch 1: apps/tls absent (404 or empty/null body) -> POST is safe.
  const absent =
    !getRes.ok && getRes.status === 404 ? true : getRes.ok && (getRes.data === undefined || getRes.data === null);
  if (absent) {
    const postRes = await api.configPost("apps/tls", buildTlsConfig(fields));
    if (postRes.ok) return { kind: "ok" };
    return { kind: "tool-error", result: bothErrors(label, patchRes, postRes, "POST") };
  }

  // Any other GET failure: surface it alongside the PATCH error — do not clobber.
  if (!getRes.ok) {
    return { kind: "tool-error", result: bothErrors(label, patchRes, getRes, "GET apps/tls") };
  }

  // GET succeeded with a value — must be an object to be a usable apps/tls config.
  if (!isPlainObject(getRes.data)) {
    return {
      kind: "tool-error",
      result: {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `Error: Failed to set ${label}.\n` +
              `  PATCH attempt: ${patchRes.error || `HTTP ${patchRes.status}`}\n` +
              `  Refusing to clobber existing apps/tls: GET returned a non-object value. ` +
              `Use caddy_config_set with an explicit path to update it safely.`,
          },
        ],
      },
    };
  }

  // Branch 3: existing apps/tls but the issuer sub-path we'd merge into is missing/wrong.
  const shapeError = validateIssuerShape(getRes.data);
  if (shapeError) {
    return {
      kind: "tool-error",
      result: {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `Error: Failed to set ${label}.\n` +
              `  PATCH attempt: ${patchRes.error || `HTTP ${patchRes.status}`}\n` +
              `  Refusing to clobber existing apps/tls: ${shapeError}. ` +
              `Use caddy_config_set with an explicit path (e.g. apps/tls/automation/policies) ` +
              `to update it safely.`,
          },
        ],
      },
    };
  }

  // Branch 2: shape is good — merge into a deep copy and PUT it back so siblings (custom certs,
  // on_demand, certificate_authorities, additional policies/issuers) are preserved.
  const merged = mergeIssuerFields(getRes.data, fields);
  const putRes = await api.configPut("apps/tls", merged);
  if (putRes.ok) return { kind: "ok" };
  return { kind: "tool-error", result: bothErrors(label, patchRes, putRes, "PUT") };
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
        const outcome = await safeFallback("ACME email", patchRes, { email });
        if (outcome.kind === "ok") return { content: [{ type: "text" as const, text: `ACME email set to: ${email}` }] };
        return outcome.result;
      }
      if (action === "set_acme_ca") {
        if (!ca)
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: ca is required for set_acme_ca action" }],
          };
        const patchRes = await api.configPatch("apps/tls/automation/policies/0/issuers/0/ca", ca);
        if (patchRes.ok) return { content: [{ type: "text" as const, text: `ACME CA set to: ${ca}` }] };
        const outcome = await safeFallback("ACME CA", patchRes, { ca });
        if (outcome.kind === "ok") return { content: [{ type: "text" as const, text: `ACME CA set to: ${ca}` }] };
        return outcome.result;
      }
      return { isError: true, content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
    },
  );
}
