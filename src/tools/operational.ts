import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

interface CaddyServerSummary {
  listen?: unknown;
  routes?: unknown;
  tls_connection_policies?: unknown;
  automatic_https?: unknown;
}

interface CaddyAutoHttps {
  disable?: unknown;
  skip?: unknown;
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
      http_port?: unknown;
      https_port?: unknown;
    };
    tls?: {
      automation?: {
        policies?: unknown;
      };
    };
  };
}

/**
 * Caddy's own http_port / https_port defaults. `app.httpPort()` / `httpsPort()`
 * (modules/caddyhttp/app.go:813-825 at v2.11.4) substitute these whenever the
 * configured value is 0, so "absent", "0" and "80"/"443" all mean the same thing.
 */
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

/** Inclusive listener port range, mirroring `caddy.NetworkAddress{StartPort,EndPort}`. */
interface PortRange {
  start: number;
  end: number;
}

/**
 * Read an app-level `http_port` / `https_port`, mirroring `app.httpPort()`
 * (app.go:813-825): 0 -- and anything that is not a usable port number -- means
 * "use Caddy's default", never "port 0".
 */
function appPort(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}

/**
 * The port token of a `host:port` string, mirroring Go's `net.SplitHostPort` as
 * `caddy.SplitNetworkAddress` calls it (listeners.go:378-405 at v2.11.4).
 *
 * Returns undefined for every shape Go reports an error for, because Caddy's
 * recovery path on that error throws the port away (`port = ""`) and re-parses,
 * which lands on port 0 -- so "Go errored" and "no port here" are one answer.
 */
function splitPort(hostport: string): string | undefined {
  const i = hostport.lastIndexOf(":");
  if (i < 0) return undefined; // Go: "missing port in address"
  if (hostport.startsWith("[")) {
    // Go expects the FIRST ']' immediately before the LAST ':', and rejects any
    // further bracket after the ones it consumed.
    const end = hostport.indexOf("]");
    if (end < 0 || end + 1 !== i) return undefined;
    if (hostport.slice(1).includes("[") || hostport.slice(end + 1).includes("]")) return undefined;
  } else {
    if (hostport.slice(0, i).includes(":")) return undefined; // Go: "too many colons in address"
    if (hostport.includes("[") || hostport.includes("]")) return undefined;
  }
  return hostport.slice(i + 1);
}

/**
 * The port range one Caddy listen string resolves to, mirroring
 * `caddy.ParseNetworkAddress` (listeners.go:315-374 at v2.11.4). Returns
 * undefined exactly where Caddy returns an error, because
 * `listenersUseAnyPortOtherThan` (server.go:548-551) `continue`s past those
 * entries -- an unparseable listener contributes nothing rather than counting
 * as port 0.
 *
 * Two shapes surprise people, and both used to be read wrong here:
 *   - The network is whatever precedes the FIRST '/', so `tcp/:443` is port 443
 *     while `:443/h3` is network ":443" with no port at all, i.e. port 0. There
 *     is no protocol suffix on a Caddy listen address; protocols live in the
 *     server's separate `listen_protocols` array. Verified against Caddy 2.11.4:
 *     POSTing a server with listen [":443/h3"] answers HTTP 400 {"error":"...
 *     listening on :443/h3:0: listen :443: unknown network :443"} -- network
 *     ":443", host "h3", port 0. Through 2.5.3 this file read it as port 443.
 *   - `unix*` and `fd*` networks carry no port and come back as 0-0
 *     (listeners.go:322-343), which is why a socket-activated `fd/3` listener
 *     (Caddy 2.9.0+) is neither "on the HTTP port" nor "on the HTTPS port".
 */
function parseListenPortRange(entry: string): PortRange | undefined {
  let rest = entry;
  const slash = entry.indexOf("/");
  if (slash >= 0) {
    // SplitNetworkAddress lowercases and trims the network token before its
    // HasPrefix tests, so "FD/3" and " unix//tmp/caddy.sock" resolve the same way.
    const network = entry.slice(0, slash).trim().toLowerCase();
    rest = entry.slice(slash + 1);
    if (network.startsWith("unix") || network.startsWith("fd")) return { start: 0, end: 0 };
  }
  const port = splitPort(rest);
  if (port === undefined || port === "") return { start: 0, end: 0 };
  // strings.Cut(port, "-"): a range is inclusive, and a bare port is its own end.
  const dash = port.indexOf("-");
  const start = parseUint16(dash < 0 ? port : port.slice(0, dash));
  const end = parseUint16(dash < 0 ? port : port.slice(dash + 1));
  if (start === undefined || end === undefined || end < start) return undefined;
  return { start, end };
}

/** `strconv.ParseUint(s, 10, 16)`: digits only, no sign, no separators, <= 65535. */
function parseUint16(s: string): number | undefined {
  if (!/^[0-9]+$/.test(s)) return undefined;
  const n = Number(s);
  return n <= 65535 ? n : undefined;
}

/**
 * Whether some TOP-LEVEL route carries a host matcher that qualifies the server
 * for automatic HTTPS. Mirrors autohttps.go:150-167 at v2.11.4: top-level
 * routes only (not routes nested in a subroute handler), `host` matchers only,
 * minus the names listed in `automatic_https.skip`.
 *
 * Caddy runs each name through the replacer first; a stored config can only
 * compare the raw string, so a placeholder host matcher is matched literally
 * against `skip` -- the closest a config reader can get without provisioning.
 */
function hasQualifyingHost(routes: unknown[], skip: Set<string>): boolean {
  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    const matcherSets = (route as { match?: unknown }).match;
    if (!Array.isArray(matcherSets)) continue;
    for (const set of matcherSets) {
      if (!set || typeof set !== "object") continue;
      const hosts = (set as { host?: unknown }).host;
      if (!Array.isArray(hosts)) continue;
      for (const host of hosts) {
        if (typeof host === "string" && !skip.has(host)) return true;
      }
    }
  }
  return false;
}

/**
 * Summarize one server entry for caddy_status / caddy_list_servers.
 *
 * The TLS label is the stored-config form of Caddy's own decision, not a
 * listen-port guess. Through 2.5.3 this tested the listen strings for ":443",
 * which mislabeled every server whose TLS comes from a host matcher on some
 * other port. Verified against Caddy 2.11.4: a server on 127.0.0.1:30238 with a
 * host matcher and NO tls_connection_policies served TLS 1.3 and answered plain
 * HTTP with 400 "Client sent an HTTP request to an HTTPS server", while the old
 * heuristic reported "TLS: off (HTTP only)". Socket-activated `fd/N` listeners
 * hit the same path (they parse to port 0), and were the symptom that surfaced
 * it -- but the common victim is an ordinary `example.com:8443` site.
 *
 * Branch order mirrors autohttps.go:119-231 with app.go:535:
 *   1. `tls_connection_policies: []` -> TLS OFF. Caddy compares the slice against
 *      nil (autohttps.go:138 and :230) and JSON `[]` unmarshals to a non-nil
 *      empty slice, so an empty array BLOCKS the policy Caddy would otherwise add
 *      and leaves `len(srv.TLSConnPolicies) > 0` false at app.go:535. Verified
 *      against Caddy 2.11.4: a server with `[]`, a host matcher and a non-443
 *      port served plain HTTP 200, failed the TLS handshake, and logged "HTTP/2
 *      skipped because it requires TLS". 2.5.2-2.5.3 asserted the opposite here.
 *   2. Policies present and non-empty -> TLS is configured outright. A
 *      present-but-non-array value is a malformed config we cannot interpret;
 *      keep the "something is configured here" reading rather than call it off.
 *      But app.go:535 decides PER SOCKET, so "configured" is not "served": a
 *      server whose every listener is http_port gets useTLS false everywhere
 *      and serves plain HTTP however many policies are written out, and one
 *      that binds http_port alongside other ports is plain HTTP on that socket
 *      and TLS on the rest. Both get their own label (see perListener below).
 *   3. `automatic_https.disable` -> autohttps.go:119-121 skips the server, so a
 *      `:443` listener really does serve plain HTTP.
 *   4. No listener on a port other than http_port -> autohttps.go:125-132
 *      disables automatic HTTPS for the server.
 *   5. No listener on a port other than https_port -> autohttps.go:138-145 adds
 *      a policy without needing one to be written out.
 *   6. A qualifying top-level host matcher -> autohttps.go:230-231 adds one.
 *   7. Otherwise autohttps.go:185-187 bails: no domains, no policy, no TLS.
 *
 * None of this shows up in GET /config: Caddy adds those policies in memory
 * while provisioning, so a reader of the stored config has to redo the rule.
 */
function describeServer(
  rawValue: unknown,
  httpPort: number = DEFAULT_HTTP_PORT,
  httpsPort: number = DEFAULT_HTTPS_PORT,
): string {
  // The config body is whatever the admin API returned, not a validated shape --
  // a malformed entry ("srv0": null, or a string) must render, not throw.
  const raw: CaddyServerSummary =
    rawValue !== null && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? (rawValue as CaddyServerSummary)
      : {};
  const listen: unknown[] = Array.isArray(raw.listen) ? raw.listen : [];
  const routes: unknown[] = Array.isArray(raw.routes) ? raw.routes : [];

  const ranges: PortRange[] = [];
  for (const entry of listen) {
    if (typeof entry !== "string") continue;
    const range = parseListenPortRange(entry);
    if (range) ranges.push(range);
  }
  /** `Server.listenersUseAnyPortOtherThan` (server.go:545-558) verbatim, including its answer of `false` for an empty listen array. */
  const usesAnyPortOtherThan = (port: number) => ranges.some((r) => port > r.end || port < r.start);
  /** The complement: app.go:535 decides useTLS per socket, so a server that also binds http_port is two things at once. */
  const bindsPort = (port: number) => ranges.some((r) => r.start <= port && port <= r.end);

  const autoHttps: CaddyAutoHttps =
    raw.automatic_https !== null && typeof raw.automatic_https === "object" && !Array.isArray(raw.automatic_https)
      ? (raw.automatic_https as CaddyAutoHttps)
      : {};
  const skip = new Set<string>(
    Array.isArray(autoHttps.skip) ? autoHttps.skip.filter((s): s is string => typeof s === "string") : [],
  );

  /**
   * Every socket this server opens is the HTTP port, so app.go:535 leaves
   * useTLS false on ALL of them and the policies are provisioned but never
   * wrapped around a listener.
   *
   * Deliberately NOT `!usesAnyPortOtherThan(httpPort)`: that is Caddy's
   * `listenersUseAnyPortOtherThan` (server.go:547-556), which asks whether
   * http_port falls OUTSIDE each range, so a range STRADDLING it -- `:80-443`
   * -- answers false while app.go:535's portOffset loop still serves TLS on
   * every socket but the first. `ranges.length > 0` keeps an absent or empty
   * `listen` out of this arm as well: there are no listeners at all there.
   */
  const allSocketsOnHttpPort = (port: number) =>
    ranges.length > 0 && ranges.every((r) => r.start === port && r.end === port);

  // A server that binds http_port AND something else serves plain HTTP on the
  // one and TLS on the others (app.go:535 excludes the http_port socket even
  // when a policy exists). Naming a single state for it would be wrong in one
  // direction or the other, so say it is both -- and when http_port is the ONLY
  // thing it binds, say that no listener gets TLS at all rather than "enabled".
  // Only the policies-present branch can reach that arm: everything below it
  // sits behind `usesAnyPortOtherThan(httpPort)`, which is false whenever every
  // socket is http_port, so branch 4 ("off (HTTP only)") claims those first.
  const perListener = (label: string) =>
    allSocketsOnHttpPort(httpPort)
      ? "enabled (no listener gets TLS: all are on the HTTP port)"
      : bindsPort(httpPort)
        ? "mixed (TLS on non-HTTP listeners only)"
        : label;

  const tlsPolicies = raw.tls_connection_policies;
  let tls: string;
  if (Array.isArray(tlsPolicies) && tlsPolicies.length === 0) {
    tls = "off (empty tls_connection_policies)";
  } else if (tlsPolicies) {
    tls = perListener("enabled");
  } else if (autoHttps.disable === true) {
    tls = "off (automatic HTTPS disabled)";
  } else if (!usesAnyPortOtherThan(httpPort)) {
    tls = "off (HTTP only)";
  } else if (!usesAnyPortOtherThan(httpsPort)) {
    tls = perListener("auto (HTTPS)");
  } else if (hasQualifyingHost(routes, skip)) {
    tls = perListener("auto (HTTPS: host matchers on a non-HTTP port)");
  } else {
    tls = "off (no host matchers)";
  }

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
 * trailing `# [truncated, N lines omitted; max_lines=M -- use filter or raise max_lines]` comment
 * is appended, where N is the number of lines cut and M is `maxLines`. If the input contained a
 * `# EOF` end-of-file marker that would have been dropped by the cut, it is re-appended after the
 * truncation comment so strict downstream parsers still see a terminated stream.
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
      const httpApp = config.apps?.http;
      const servers = httpApp?.servers ?? {};
      const serverNames = Object.keys(servers);

      // This tool already holds the whole config, so it can feed describeServer
      // the app's real http_port / https_port. Both change which listeners count
      // as plain-HTTP and which get an automatic TLS policy (autohttps.go:125-145).
      const httpPort = appPort(httpApp?.http_port, DEFAULT_HTTP_PORT);
      const httpsPort = appPort(httpApp?.https_port, DEFAULT_HTTPS_PORT);

      const lines: string[] = ["Caddy is running", ""];

      if (serverNames.length === 0) {
        lines.push("No HTTP servers configured");
      } else {
        for (const name of serverNames) {
          lines.push(`Server "${name}": ${describeServer(servers[name], httpPort, httpsPort)}`);
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

      // Deliberately still reading "apps/http/servers" and taking describeServer's
      // 80/443 defaults, rather than widening the read to "apps/http" to pick up a
      // custom http_port / https_port. The isMissingConfigPath contract above rests
      // on this path being a fixed literal whose every failure means "no HTTP
      // servers"; "apps/http" would succeed with no servers key and break that.
      // The cost is that a server on a non-default http_port/https_port can carry
      // the wrong TLS label here -- caddy_status reads the whole config and gets it
      // right, so the accurate answer is one tool call away.
      const lines = names.map((name) => `  ${name}: ${describeServer(servers[name])}`);
      return {
        content: [{ type: "text" as const, text: `HTTP Servers:\n${lines.join("\n")}` }],
      };
    },
  );

  server.tool(
    "caddy_upstreams",
    "Caddy's /reverse_proxy/upstreams array (address, num_requests, fails), returned verbatim. " +
      "On Caddy 2.11.2+ it is not the configured upstream list. Dynamic-upstream backends stay listed about 1 h " +
      "(up to ~65 min) after the dynamic source last returned them, even after a config change removes them, " +
      "so an address may appear that no current config references. A backend with requests in flight can appear " +
      "twice when its resolved address differs from the entry's text (dynamic upstreams, tcp/ or unix// dials, " +
      "placeholder dials). That extra copy always shows fails 0 and repeats num_requests, so do not sum " +
      "num_requests across entries.",
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
