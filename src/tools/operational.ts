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

/**
 * Match `:443` as a port suffix on a Caddy listen string. Allow trailing
 * non-digit (e.g. `:443/h3` for QUIC protocol annotation) or end-of-string,
 * so neighbors like `:4430` / `:4431` don't trigger a false "auto (HTTPS)"
 * classification under a naive substring check.
 */
const HTTPS_PORT_RE = /:443(?:\D|$)/;

function describeServer(rawValue: unknown): string {
  // The config body is whatever the admin API returned, not a validated shape --
  // a malformed entry ("srv0": null, or a string) must render, not throw.
  const raw: CaddyServerSummary =
    rawValue !== null && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? (rawValue as CaddyServerSummary)
      : {};
  const listen: unknown[] = Array.isArray(raw.listen) ? raw.listen : [];
  const routes: unknown[] = Array.isArray(raw.routes) ? raw.routes : [];
  // An empty tls_connection_policies array configures nothing, so it must read the same
  // as an absent key: fall through to the listen-port heuristic rather than claim
  // "enabled". A present-but-non-array value is a malformed config we can't interpret --
  // keep the old "something is there" reading for it rather than silently calling it off.
  const tlsPolicies = raw.tls_connection_policies;
  const hasExplicitTls = Array.isArray(tlsPolicies) ? tlsPolicies.length > 0 : !!tlsPolicies;
  const listensHttps = listen.some((l) => typeof l === "string" && HTTPS_PORT_RE.test(l));
  const tls = hasExplicitTls ? "enabled" : listensHttps ? "auto (HTTPS)" : "off (HTTP only)";
  const listenStr = listen.length > 0 ? listen.map(String).join(", ") : "default";
  return `${routes.length} route(s), listen: ${listenStr}, TLS: ${tls}`;
}

/** Default max_lines for caddy_metrics. Prometheus output on busy servers can be megabytes; 500 lines is enough to skim. */
export const METRICS_DEFAULT_MAX_LINES = 500;

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
 * trailing `# [truncated, N lines omitted -- use filter to narrow]` comment is appended. If the
 * input contained a `# EOF` end-of-file marker that would have been dropped by the cut, it is
 * re-appended after the truncation comment so strict downstream parsers still see a terminated
 * stream.
 */
export function applyMetricsControls(raw: string, filter: string | undefined, maxLines: number): string {
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let filtered: string[];
  if (filter && filter.length > 0) {
    filtered = lines.filter((line) => {
      // Preserve the Prometheus end-of-file marker so strict downstream parsers don't break.
      // Use trim() (not trimStart()) so CRLF inputs and stray trailing whitespace still match.
      if (line.trim() === "# EOF") return true;
      const name = metricNameFromLine(line);
      return name?.includes(filter) ?? false;
    });
  } else {
    filtered = lines;
  }

  if (filtered.length <= maxLines) return filtered.join("\n");

  const dropped = filtered.length - maxLines;
  const kept = filtered.slice(0, maxLines);
  kept.push(`# [truncated, ${dropped} lines omitted; max_lines=${maxLines} -- use filter or raise max_lines]`);
  // If the input had a `# EOF` marker and it landed in the dropped tail, re-emit it so the
  // output remains a well-formed Prometheus exposition. The filter path above already keeps
  // EOF unconditionally; only the unfiltered/truncated case can lose it.
  const keptHasEof = kept.some((l) => l.trim() === "# EOF");
  if (!keptHasEof && filtered.slice(maxLines).some((l) => l.trim() === "# EOF")) {
    kept.push("# EOF");
  }
  return kept.join("\n");
}

/**
 * Read the ACME email strictly from `policies[0].issuers[0].email`, mirroring the
 * write path in `caddy_tls set_email`. Returns undefined if any step of the path is
 * missing or non-conforming, so the read can never report an email that
 * `set_email` would not actually update.
 */
function findAcmeEmail(policies: unknown): string | undefined {
  if (!Array.isArray(policies) || policies.length === 0) return undefined;
  const rawPolicy = policies[0];
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) return undefined;
  const policy = rawPolicy as CaddyTlsPolicy;
  if (!Array.isArray(policy.issuers) || policy.issuers.length === 0) return undefined;
  const rawIssuer = policy.issuers[0];
  if (!rawIssuer || typeof rawIssuer !== "object" || Array.isArray(rawIssuer)) return undefined;
  const issuer = rawIssuer as CaddyTlsIssuer;
  return typeof issuer.email === "string" ? issuer.email : undefined;
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
      // A config-less Caddy has no `apps` key at all, so this read fails the path
      // walk rather than returning an empty object: 2.11.4 answers HTTP 400
      // {"error":"invalid traversal path at: config/apps/http"}. Surfacing that raw
      // made the tool whose entire job is "tell me what servers exist" answer a
      // fresh instance with a Go internal error instead of the obvious truth.
      //
      // The path is a fixed literal, so every way this walk can fail -- missing
      // apps, http, or servers -- means the same thing and only that thing: no HTTP
      // servers are configured. That makes the friendly answer honest here rather
      // than a guess. caddy_status already reports it this way for the same state.
      if (api.isMissingConfigPath(res)) {
        return { content: [{ type: "text" as const, text: "No HTTP servers configured" }] };
      }
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
      "Filter-mode drops blank lines and free-form '# comment' lines, keeping only '# HELP'/'# TYPE' lines for matching metrics; the '# EOF' end-of-file marker is always preserved. " +
      "Use `max_lines` to cap the response (default 500); a trailing comment reports how many lines were dropped.",
    {
      filter: z
        .string()
        .optional()
        .describe(
          "Substring to match against metric names. Keeps sample lines whose metric name contains this substring, " +
            "plus their `# HELP` and `# TYPE` comment lines. Empty/absent = no filtering. " +
            "Label values are NOT matched -- use a Prometheus-aware client for label filtering.",
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
