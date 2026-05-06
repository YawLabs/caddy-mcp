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

/** Default max_lines for caddy_metrics. Prometheus output on busy servers can be megabytes; 500 lines is enough to skim. */
const METRICS_DEFAULT_MAX_LINES = 500;

/**
 * Extract the metric name from a Prometheus exposition line.
 * Returns undefined for blank lines or unrecognizable comments (e.g. `# arbitrary comment`).
 *
 * Handled forms:
 *   - `# HELP metric_name help text`
 *   - `# TYPE metric_name counter`
 *   - `metric_name{label="v"} 1.0`
 *   - `metric_name 1.0`
 */
function metricNameFromLine(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("#")) {
    const m = trimmed.match(/^#\s+(?:HELP|TYPE)\s+([A-Za-z_:][A-Za-z0-9_:]*)/);
    return m ? m[1] : undefined;
  }
  const m = trimmed.match(/^([A-Za-z_:][A-Za-z0-9_:]*)/);
  return m ? m[1] : undefined;
}

/**
 * Apply the optional substring filter and max_lines truncation to raw Prometheus exposition text.
 *
 * Filter rule: a line is kept if the metric name on that line contains the filter substring.
 * Both `# HELP` / `# TYPE` comment lines and sample lines are matched on their metric name, so any
 * retained metric keeps its descriptive comments alongside its samples. Lines with no parseable
 * metric name (blank lines, free-form `#` comments) are dropped when filtering.
 *
 * Truncation: if the resulting line count exceeds `maxLines`, output is cut at `maxLines` and a
 * trailing `# [truncated, N lines omitted -- use filter to narrow]` comment is appended.
 */
export function applyMetricsControls(raw: string, filter: string | undefined, maxLines: number): string {
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let filtered: string[];
  if (filter && filter.length > 0) {
    filtered = lines.filter((line) => {
      const name = metricNameFromLine(line);
      return name?.includes(filter) ?? false;
    });
  } else {
    filtered = lines;
  }

  if (filtered.length <= maxLines) return filtered.join("\n");

  const dropped = filtered.length - maxLines;
  const kept = filtered.slice(0, maxLines);
  kept.push(`# [truncated, ${dropped} lines omitted -- use filter to narrow]`);
  return kept.join("\n");
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
    "Get Prometheus metrics from Caddy. Shows request counts, durations, TLS handshake stats, active connections, and more. " +
      "Output can be megabytes on busy servers -- use `filter` to keep only metrics whose name contains a substring " +
      "(e.g. 'http_requests' or 'tls'); HELP/TYPE comment lines for retained metrics are kept. " +
      "Filter-mode drops blank lines and free-form '# comment' lines (including '# EOF'); only '# HELP'/'# TYPE' lines for matching metrics are kept. " +
      "Use `max_lines` to cap the response (default 500); a trailing comment reports how many lines were dropped.",
    {
      filter: z
        .string()
        .optional()
        .describe(
          "Substring to match against metric names. Keeps sample lines whose metric name contains this substring, " +
            "plus their `# HELP` and `# TYPE` comment lines. Empty/absent = no filtering.",
        ),
      max_lines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of output lines (default 500). Excess lines are dropped and a summary is appended."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ filter, max_lines }) => {
      const res = await api.getMetrics();
      if (!res.ok) return formatResult(res);

      const raw = typeof res.data === "string" ? res.data : res.data !== undefined ? String(res.data) : "";
      const limit = max_lines ?? METRICS_DEFAULT_MAX_LINES;
      const text = applyMetricsControls(raw, filter, limit);
      return { content: [{ type: "text" as const, text: text || "OK" }] };
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
