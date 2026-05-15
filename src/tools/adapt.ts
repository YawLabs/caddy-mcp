import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

interface AdaptWarning {
  directive?: unknown;
  message?: unknown;
}

interface AdaptResponse {
  result?: unknown;
  warnings?: unknown;
}

function formatWarning(w: unknown): string {
  if (!w || typeof w !== "object") return `  - unknown: ${JSON.stringify(w)}`;
  const obj = w as AdaptWarning;
  const directive = typeof obj.directive === "string" ? obj.directive : "unknown";
  const message = typeof obj.message === "string" ? obj.message : JSON.stringify(w);
  return `  - ${directive}: ${message}`;
}

export function registerAdaptTools(server: McpServer) {
  server.tool(
    "caddy_adapt",
    "Convert a config in any registered adapter format to Caddy JSON without loading it. Useful for previewing what a Caddyfile produces, or for porting from nginx/yaml configs when Caddy is built with the matching adapter module ('caddyfile' is built-in; 'nginx', 'yaml', etc. require their adapter modules to be compiled into the Caddy binary). Returns the adapted JSON and any warnings separately.",
    {
      config: z.string().describe("The raw config text (e.g., Caddyfile contents, nginx.conf, yaml)"),
      adapter: z
        .string()
        .regex(/^[a-z0-9_-]+$/, "Adapter must be lowercase alphanumeric, hyphens, or underscores")
        .max(64)
        .optional()
        .default("caddyfile")
        .describe(
          "Config format adapter. Must match an adapter Caddy was built with. Built-in: 'caddyfile' (default). Common external adapters: 'nginx' (caddy-nginx-adapter), 'yaml' (caddy-yaml).",
        ),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ config, adapter }) => {
      const res = await api.adapt<AdaptResponse>(config, adapter);
      if (!res.ok) return formatResult(res);
      const data: AdaptResponse = res.data ?? {};
      const warnings: unknown[] = Array.isArray(data.warnings) ? data.warnings : [];
      const result = data.result;
      const content: { type: "text"; text: string }[] = [];
      if (warnings.length > 0) {
        const warnLines = warnings.map(formatWarning);
        content.push({ type: "text" as const, text: `Warnings:\n${warnLines.join("\n")}` });
      }
      content.push({
        type: "text" as const,
        text: result !== undefined ? JSON.stringify(result, null, 2) : "OK (no output)",
      });
      return { content };
    },
  );
}
