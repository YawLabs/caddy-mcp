import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "../api.js";
import { formatResult } from "../format.js";

interface CaddyServerConfig {
  listen?: unknown;
  routes?: unknown;
}

interface CaddyRoute {
  "@id"?: unknown;
  group?: unknown;
  match?: unknown;
  handle?: unknown;
  terminal?: unknown;
}

interface CaddyMatcher {
  host?: unknown;
  path?: unknown;
  method?: unknown;
  protocol?: unknown;
  remote_ip?: unknown;
  client_ip?: unknown;
  query?: unknown;
  header?: unknown;
  expression?: unknown;
  not?: unknown;
}

interface CaddyHandler {
  handler?: unknown;
  upstreams?: unknown;
  root?: unknown;
  status_code?: unknown;
  uri?: unknown;
  routes?: unknown;
  providers?: unknown;
}

interface CaddyUpstream {
  dial?: unknown;
}

/**
 * Max characters of raw route JSON attached as the second content block of
 * caddy_list_routes. A server fronting many hosts can carry megabytes of route
 * config; the full JSON is always reachable via caddy_config_get.
 */
const ROUTES_JSON_MAX_CHARS = 20000;

/**
 * Max route summary lines emitted by caddy_list_routes. Matches the spirit of
 * METRICS_DEFAULT_MAX_LINES -- one line per route is cheap until a server
 * fronts thousands of them.
 */
const ROUTES_SUMMARY_MAX = 500;

/**
 * Serialize as many WHOLE routes as fit under ROUTES_JSON_MAX_CHARS.
 *
 * Two reasons this isn't `JSON.stringify(routes).slice(0, cap)`:
 *   1. A character-level cut lands mid-token, so the block stops being valid
 *      JSON -- and this block is the machine-readable half of the tool's
 *      output, which callers parse.
 *   2. Slicing still materializes the full megabyte string before throwing most
 *      of it away, which defeats the point of the cap.
 *
 * Output matches `JSON.stringify(array, null, 2)` formatting so a consumer
 * can't tell a capped block from a complete one except by its length. The
 * first route is always included even if it alone exceeds the cap -- an empty
 * array would be less useful than one oversized entry.
 */
function serializeRoutesCapped(routes: unknown[]): { json: string; shown: number } {
  const parts: string[] = [];
  // Fixed overhead of the wrapper: the opening "[", the "\n" that precedes the
  // closing bracket, and the "]" itself. The "\n" AFTER the "[" is charged to
  // the first entry below (as its cost of 1), so it is not counted here.
  let used = 3;
  for (const route of routes) {
    const entry = JSON.stringify(route, null, 2)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    const cost = entry.length + (parts.length > 0 ? 2 : 1); // ",\n" or the opening "\n"
    if (parts.length > 0 && used + cost > ROUTES_JSON_MAX_CHARS) break;
    parts.push(entry);
    used += cost;
  }
  if (parts.length === 0) return { json: "[]", shown: 0 };
  return { json: `[\n${parts.join(",\n")}\n]`, shown: parts.length };
}

/** Join an unknown value as comma-separated strings if it's an array; return "" otherwise */
function safeJoin(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((v) => v !== null && v !== undefined)
    .map(String)
    .join(",");
}

/**
 * Strip an explicit `:port` suffix from a host string. Caddy `host` matchers
 * are evaluated against the Host header value with the port removed, so a
 * matcher of "example.com:8080" never fires for a real request hitting that
 * port. Callers commonly write the port to signal "this listener" -- accept
 * it but normalize it out so the route actually matches.
 *
 * Supports:
 *   - "example.com:8080"  -> "example.com"
 *   - "1.2.3.4:80"        -> "1.2.3.4"
 *   - "[::1]:8080"        -> "[::1]" (IPv6 bracket form)
 *   - "[::1]"             -> "[::1]" (no port — unchanged)
 *   - "example.com"       -> "example.com" (no port — unchanged)
 *   - "::1"               -> "::1" (bare IPv6 — unchanged; see below)
 *   - "foo:bar"           -> "foo:bar" (non-numeric suffix — leave alone
 *                            rather than silently losing data we don't
 *                            recognize as a port).
 */
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const closeIdx = host.indexOf("]");
    if (closeIdx !== -1) return host.substring(0, closeIdx + 1);
    return host;
  }
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx === -1) return host;
  // Two or more colons with no brackets is a bare IPv6 literal ("::1",
  // "fe80::1"). Its last group is an address segment, not a port -- a port on
  // IPv6 requires the bracketed form handled above. Shearing at the final
  // colon would turn "::1" into ":", exactly the silent data loss the
  // non-numeric-suffix case below refuses to do.
  if (host.indexOf(":") !== colonIdx) return host;
  const portCandidate = host.substring(colonIdx + 1);
  if (portCandidate.length === 0 || !/^\d+$/.test(portCandidate)) return host;
  return host.substring(0, colonIdx);
}

/** Parse a "from" string like "api.example.com" or "example.com/api/*" into match object */
export function parseFrom(from: string): { host?: string[]; path?: string[] } {
  const cleaned = from.replace(/^https?:\/\//, "");
  const match: { host?: string[]; path?: string[] } = {};
  const slashIdx = cleaned.indexOf("/");
  if (slashIdx > 0) {
    match.host = [stripPort(cleaned.substring(0, slashIdx))];
    const path = cleaned.substring(slashIdx);
    // A bare trailing slash (path === "/") is dropped: Caddy path matchers are
    // exact-string (with optional trailing "*"), so path: ["/"] would match
    // ONLY requests for the literal root path. Callers writing "example.com/"
    // almost always mean host-only (= all paths). Real paths with trailing
    // slashes ("example.com/api/" -> "/api/") are preserved -- "/api" and
    // "/api/" are distinct matchers.
    if (path !== "/") {
      match.path = [path];
    }
  } else if (cleaned.startsWith("/")) {
    match.path = [cleaned];
  } else {
    match.host = [stripPort(cleaned)];
  }
  return match;
}

/** Strip scheme and trailing slashes from an upstream address. */
function cleanUpstreamAddr(addr: string): string {
  return addr.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Append `port` to an upstream dial address that carries none.
 *
 * A Caddy `dial` is a socket address, not a URL: it has no scheme left to
 * imply a port once cleanUpstreamAddr has stripped one. Writing the bare host
 * for "https://backend.example.com" would therefore aim the connection at
 * whatever a portless dial resolves to rather than at 443, so make the port
 * the caller meant explicit instead of inheriting a default.
 *
 * stripPort() doubles as the port DETECTOR here: it returns its input
 * unchanged exactly when there is nothing it recognizes as a port to strip
 * (including the bare-IPv6 case documented on it). That bare-IPv6 form has to
 * be bracketed before a port can be appended -- "::1:443" reads as another
 * address group, not as host + port.
 */
function withDefaultPort(dial: string, port: number): string {
  if (stripPort(dial) !== dial) return dial;
  const bareIpv6 = !dial.startsWith("[") && dial.indexOf(":") !== dial.lastIndexOf(":");
  return bareIpv6 ? `[${dial}]:${port}` : `${dial}:${port}`;
}

interface UpstreamPlan {
  /** Dial addresses, scheme stripped and (for TLS upstreams) port-normalized. */
  dials: string[];
  /** True when the handler must carry a TLS transport to reach these upstreams. */
  tls: boolean;
}

/**
 * Resolve the `to` list into dial addresses plus whether the reverse_proxy
 * handler needs a TLS transport.
 *
 * The scheme is load-bearing, not decoration. Caddy dials an upstream in the
 * clear unless the HANDLER also carries `transport: { protocol: "http",
 * tls: {} }`, so quietly reducing "https://backend" to `{ dial: "backend" }`
 * is a security downgrade the caller never sees. An https upstream therefore
 * emits the transport and pins :443 rather than having its scheme normalized
 * away.
 *
 * A list mixing http and https upstreams is REFUSED rather than resolved:
 * `transport` is a property of the whole handler, not of an individual
 * upstream, so either choice would silently apply one entry's scheme to the
 * other's connection. Splitting them into two routes -- or hand-writing the
 * handler with caddy_add_route -- keeps that decision with the caller.
 */
function planUpstreams(to: string[]): UpstreamPlan | { error: string } {
  if (to.length === 0) {
    return { error: `"to" must list at least one upstream address (e.g. ["localhost:3000"]).` };
  }
  const dials: string[] = [];
  let secure = 0;
  let plain = 0;
  for (const raw of to) {
    // Trim for the same reason `from` is trimmed: surrounding whitespace would
    // otherwise become part of the dial address.
    const trimmed = raw.trim();
    // Case-sensitive, matching cleanUpstreamAddr's strip -- a scheme this test
    // recognizes must be one the strip also removes, or the "scheme" would
    // survive into the dial address.
    const isTls = trimmed.startsWith("https://");
    const dial = cleanUpstreamAddr(trimmed);
    if (dial.length === 0) {
      return {
        error:
          `upstream ${JSON.stringify(raw)} has no address to dial. Each "to" entry needs a host ` +
          `and port (e.g. "localhost:3000", "https://backend.example.com:8443").`,
      };
    }
    if (isTls) secure++;
    else plain++;
    dials.push(isTls ? withDefaultPort(dial, 443) : dial);
  }
  if (secure > 0 && plain > 0) {
    return {
      error:
        `"to" mixes https:// and non-https upstreams. Caddy's TLS transport applies to the whole ` +
        `reverse_proxy handler, not per-upstream, so one scheme would be silently forced on the ` +
        `other's connection. Split them into two routes, or build the handler explicitly with ` +
        `caddy_add_route.`,
    };
  }
  return { dials, tls: secure > 0 };
}

/**
 * Detect Caddy's "parent path does not exist" failure mode for a config write.
 *
 * Caddy returns this when writing to a path whose parent (e.g.
 * `apps/http/servers/<srv>`) doesn't exist. Across versions the exact status
 * varies (observed: 400, 404, sometimes 500), but the body reliably contains
 * "key does not exist". Belt-and-braces: trust 404 as a status, OR any non-2xx
 * response whose body contains the marker phrase.
 */
function isParentMissing(res: { ok: boolean; status: number; error?: string }): boolean {
  if (res.ok) return false;
  if (res.status === 404) return true;
  // Both markers, because Caddy uses different ones depending on WHERE the path
  // breaks. Writing under a server that does not exist is the case this helper
  // exists for, and 2.11.4 answers it with 500 "invalid traversal path at:
  // config/apps/http/servers/<srv>/routes" -- no 404, and no "key does not exist".
  // Matching only the older marker made this return false for its own headline
  // case, so serverNotFoundError was unreachable from all three call sites and
  // callers got the raw Go error instead of the create-it recipe.
  if (api.isMissingConfigPath(res)) return true;
  return res.error?.includes("key does not exist") ?? false;
}

/**
 * Detect Caddy's "unknown @id" failure mode for a GET to /id/<id>.
 *
 * Caddy's /id/<id> virtual path resolves only @ids that ALREADY exist in the
 * config tree. A bare GET against an unknown @id returns 404, sometimes with
 * a body like "unknown object ID '<id>'" or "no ID found".
 *
 * Tight markers only: status 404, OR a body whose lowercased form contains
 * one of the specific phrases Caddy uses for missing @ids. Avoid matching the
 * loose token "unknown" alone -- validation errors like "unknown handler 'x'"
 * or "unknown directive 'y'" must not be misclassified as missing-id, since
 * we use this helper to decide whether to speculatively create on POST.
 */
function isUnknownId(res: { ok: boolean; status: number; error?: string }): boolean {
  if (res.ok) return false;
  if (res.status === 404) return true;
  const body = (res.error ?? "").toLowerCase();
  return body.includes("unknown object id") || body.includes("no id found");
}

/**
 * A Caddy route always carries a top-level `handle` array. Other config
 * objects an @id can point at -- TLS issuers, server blocks, listener entries,
 * individual handler configs nested elsewhere -- do not. We use this to refuse
 * clobbering when the supplied `id` resolves to something that isn't a route:
 * @ids are config-global in Caddy, not route-scoped, so a colliding id from a
 * different subsystem would otherwise get silently overwritten.
 */
function isRouteShape(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  return Array.isArray((obj as { handle?: unknown }).handle);
}

/** Build an error result for when a server doesn't exist. `op` names the calling tool so the caller can tell which operation hit the missing server. */
function serverNotFoundError(srv: string, op = "operation") {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `Error: Server "${srv}" does not exist (${op}). Use caddy_list_servers to see what is configured. ` +
          `To create it: caddy_config_set { path: "apps/http/servers/${srv}", mode: "append", ` +
          `value: { "listen": [":443"], "routes": [] } }. Both arguments are load-bearing: mode "append" ` +
          `creates the key, while the default "overwrite" fails with "key does not exist"; and "routes": [] ` +
          `must be present, or adding the first route fails, because a POST creates a missing routes key as ` +
          `an object rather than an array. On an instance with no config at all, use caddy_load instead -- ` +
          `caddy_config_set cannot create the apps/http tree it would write into.`,
      },
    ],
  };
}

/**
 * A read of `apps/http/servers/<srv>` that came back as a JSON `null`.
 *
 * Deliberately NOT serverNotFoundError, and deliberately not worded as "does not
 * exist". Caddy answers an UNKNOWN server with HTTP 200 and a body of literal
 * `null` -- not a 404 -- and it answers a server whose config IS null with byte
 * identical output. Verified against Caddy 2.11.4:
 *   GET /config/apps/http/servers/typo    -> 200 null   (no such key)
 *   GET /config/apps/http/servers/nulled  -> 200 null   (key present, value null)
 * Nothing downstream can separate the two, so this names both causes rather than
 * picking one. Asserting the likelier cause here is the mistake that shipped in
 * 1.2.5 and had to be deprecated: a confident message pointing at the wrong thing
 * is worse than an honest ambiguous one.
 *
 * An empty OBJECT is a different answer and must not land here -- `{}` is a real,
 * routeless server, which the summary path renders as "no routes configured".
 */
function serverNullError(srv: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `Error: Server "${srv}" is not configured, or its config is null -- Caddy returns the same ` +
          `response (HTTP 200 with a body of null) for both, so they cannot be told apart from here. ` +
          `Use caddy_list_servers to see which servers exist, or create this one with caddy_load or ` +
          `caddy_config_set at path 'apps/http/servers/${srv}' with at minimum: { "listen": [":443"] }`,
      },
    ],
  };
}

export function registerRouteTools(server: McpServer) {
  server.tool(
    "caddy_reverse_proxy",
    "Add a reverse proxy route. The most common operation — just specify where traffic comes from and where it goes. Example: from='api.local' to=['localhost:3000']. " +
      "When `id` is OMITTED the route is appended to the server's routes array — calling the tool twice with the same args produces TWO duplicate routes (non-idempotent). " +
      "When `id` is SUPPLIED the route is written via PATCH under that @id, so repeat calls REPLACE in place (idempotent). " +
      "Strongly recommended: supply a stable `id` for any route managed from automation or production tooling. " +
      "Note: @ids are config-global in Caddy (NOT route-scoped). If `id` collides with an @id used by a non-route object (TLS issuer, server, etc.) the call refuses with an error rather than clobbering it. Once an @id is registered to a route under one server, subsequent calls update that route in place regardless of the `server` argument. " +
      "Upstream scheme is honored: an `https://` upstream gets a TLS transport and defaults to port 443, anything else is dialed in the clear. A `to` list that MIXES https:// and non-https entries is refused — the TLS transport applies to the whole handler, not per-upstream — so split those into two routes or use caddy_add_route.",
    {
      from: z
        .string()
        .min(1)
        .describe("Domain, path, or domain/path to match (e.g., 'api.local', '/api/*', 'app.local/ws')"),
      to: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Upstream addresses, at least one (e.g., ['localhost:3000', 'localhost:3001']). An 'https://' prefix dials the upstream over TLS (port 443 unless one is given); http:// and bare addresses are dialed in the clear. Do not mix https:// and non-https entries in one call.",
        ),
      server: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name (default: srv0)"),
      id: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .describe(
          "Optional stable @id for the route. When set, repeat calls REPLACE the route in place (idempotent). When omitted, the route is APPENDED — calling twice with identical args creates a duplicate route. @ids are config-global in Caddy: if this id is already used by a non-route object the call refuses rather than clobbering it.",
        ),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ from, to, server: srv, id }) => {
      // Trim before parsing so surrounding whitespace doesn't become part of a
      // matcher: "  /api" is a legitimate path, but parsing it untrimmed yields
      // host ["   "] alongside it.
      const match = parseFrom(from.trim());
      // A `from` that carries no matchable token ("https://", " ", "  ")
      // survives the min(1) schema check but parses to an empty host matcher,
      // which can never fire. Refuse rather than write a dead route. The
      // trim() on the host covers any whitespace the parse leaves behind.
      if (match.host?.[0]?.trim() === "" || (match.host === undefined && match.path === undefined)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: "from" value ${JSON.stringify(from)} has no host or path to match on. Supply a domain ('api.local'), a path ('/api/*'), or both ('app.local/ws').`,
            },
          ],
        };
      }
      const plan = planUpstreams(to);
      if ("error" in plan) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${plan.error}` }],
        };
      }
      const cleanedTo = plan.dials;
      const proxyHandler: Record<string, unknown> = {
        handler: "reverse_proxy",
        upstreams: cleanedTo.map((addr) => ({ dial: addr })),
      };
      // Only set on the TLS path so a plain-http route keeps the exact handler
      // shape it has always had -- `transport` present-but-empty is not the
      // same config as `transport` absent.
      if (plan.tls) {
        proxyHandler.transport = { protocol: "http", tls: {} };
      }
      const route: Record<string, unknown> = {
        match: [match],
        handle: [proxyHandler],
        terminal: true,
      };
      if (id) {
        route["@id"] = id;
        // GET-first dispatch on the supplied @id:
        //   200 + route shape  -> PATCH /id/<id> to replace in place (idempotent).
        //   200 + non-route    -> refuse: @ids are config-global, don't clobber
        //                         a TLS issuer / server / handler that happens
        //                         to share this id.
        //   404 / unknown-id   -> POST the route body (with @id embedded) under
        //                         the real config path so the @id registers;
        //                         subsequent calls then hit the PUT happy path.
        //   any other error    -> surface verbatim (don't speculatively write).
        // The GET costs one extra round-trip on the replace path but eliminates
        // the speculative-PUT clobber risk and removes the need to body-match
        // failure modes on a write.
        const existing = await api.configByIdGet(id);
        if (existing.ok) {
          if (!isRouteShape(existing.data)) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    `Error: @id "${id}" is already in use by a non-route config object ` +
                    `(no top-level "handle" array). @ids are config-global in Caddy, not ` +
                    `route-scoped -- pick a different id, or remove the existing object first ` +
                    `with caddy_config_by_id { id: "${id}", action: "delete" }.`,
                },
              ],
            };
          }
          // PATCH, not PUT. Caddy's /id/<id> resolves to a position in the
          // routes array, and PUT at an array position INSERTS -- so a PUT
          // here appends a second copy carrying the same @id and Caddy then
          // rejects the whole config with
          //   "indexing config: duplicate ID '<id>' found at .../routes/0 and .../routes/1"
          // Verified against Caddy 2.11.4: PUT -> 400 duplicate ID (config
          // rolled back), PATCH -> 200 with the route replaced in place.
          const putRes = await api.configByIdSet(id, route, "PATCH");
          if (putRes.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Route set @id="${id}": ${from} → ${cleanedTo.join(", ")}`,
                },
              ],
            };
          }
          // PUT failures surface verbatim. A 404 / parent-missing body here
          // does NOT reliably mean "server gone" -- the more common cause is
          // a concurrent caddy_remove_route deleting the @id between the GET
          // above and the PUT. Translating to serverNotFoundError would
          // mislead the caller about which thing is missing, so leave the
          // raw body in place for them to read.
          return formatResult(putRes);
        }
        // GET failed. Only treat tight unknown-id markers as "first-create";
        // any other GET failure surfaces verbatim so we don't follow a real
        // error (auth, transport, validation) with a speculative POST.
        if (!isUnknownId(existing)) {
          return formatResult(existing);
        }
        const postRes = await api.configPost(`apps/http/servers/${srv}/routes`, route);
        if (postRes.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Route created @id="${id}": ${from} → ${cleanedTo.join(", ")}`,
              },
            ],
          };
        }
        // POST failed -- parent-missing now genuinely means the server doesn't
        // exist (the @id is confirmed-absent by the GET above).
        if (isParentMissing(postRes)) {
          return serverNotFoundError(srv, "caddy_reverse_proxy");
        }
        return formatResult(postRes);
      }
      const res = await api.configPost(`apps/http/servers/${srv}/routes`, route);
      if (res.ok) {
        return { content: [{ type: "text" as const, text: `Route added: ${from} → ${cleanedTo.join(", ")}` }] };
      }
      if (isParentMissing(res)) {
        return serverNotFoundError(srv, "caddy_reverse_proxy");
      }
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_add_route",
    "Add a route with full control over match conditions and handlers. Supports any Caddy handler (reverse_proxy, file_server, static_response, redirect, encode, headers, etc.).",
    {
      match: z
        .array(z.record(z.string(), z.any()))
        .describe("Array of match objects (e.g., [{ host: ['example.com'], path: ['/api/*'] }])"),
      handle: z
        .array(z.record(z.string(), z.any()))
        .describe("Array of handler objects (e.g., [{ handler: 'file_server', root: '/var/www' }])"),
      server: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name (default: srv0)"),
      terminal: z.boolean().optional().default(true).describe("Stop processing further routes after this one matches"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ match, handle, server: srv, terminal }) => {
      const route = { match, handle, terminal };
      const res = await api.configPost(`apps/http/servers/${srv}/routes`, route);
      if (isParentMissing(res)) {
        return serverNotFoundError(srv, "caddy_add_route");
      }
      return formatResult(res);
    },
  );

  server.tool(
    "caddy_list_routes",
    "List all routes on a Caddy HTTP server with a human-readable summary of matchers and handlers, followed by the raw route JSON. " +
      "Both halves are capped on large servers: the summary at 500 routes, the JSON at 20000 characters (truncated on whole-route boundaries, so it always parses). " +
      "When either cap trims output, a note says how many routes were omitted -- read the rest with caddy_config_get at 'apps/http/servers/<server>/routes'.",
    {
      server: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name (default: srv0)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ server: srv }) => {
      const serverRes = await api.configGet<CaddyServerConfig>(`apps/http/servers/${srv}`);
      // A traversal failure means a segment ABOVE the server name is missing --
      // apps, http, or servers -- so on a config-less instance this tool used to
      // answer with a raw `{"error":"invalid traversal path at: config/apps/http"}`,
      // which tells a first-time operator nothing about what to do next.
      //
      // Unlike the null body handled below, this one is NOT ambiguous: if the
      // parent chain does not exist then neither does the server, so asserting
      // non-existence here is honest, and serverNotFoundError carries the recipe.
      if (api.isMissingConfigPath(serverRes)) return serverNotFoundError(srv, "caddy_list_routes");
      if (!serverRes.ok) return formatResult(serverRes);

      // A `null` body is a 200, so the guard above never catches it. Without this
      // check the `|| {}` below collapses null into an empty config and an unknown
      // server renders as `Server "typo" (listen: default) -- no routes configured`
      // with no isError flag: the operator is told a server they believe is live
      // has no routes, which invites them to overwrite it. `undefined` (an empty
      // response body) is folded in here too -- it carries no more information than
      // null does. Anything else, INCLUDING `{}`, is a real server and falls
      // through: `{}` is a legitimately routeless server, not a missing one.
      if (serverRes.data === null || serverRes.data === undefined) {
        return serverNullError(srv);
      }

      const serverConfig = serverRes.data || {};
      const routes: unknown[] = Array.isArray(serverConfig.routes) ? serverConfig.routes : [];
      const listen: unknown[] = Array.isArray(serverConfig.listen) ? serverConfig.listen : [];
      const listenStr = listen.map(String).join(", ") || "default";

      if (routes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Server ${srv} (listen: ${listenStr}) — no routes configured`,
            },
          ],
        };
      }

      const lines: string[] = [`Server: ${srv} (listen: ${listenStr})`, ""];
      const summarized = Math.min(routes.length, ROUTES_SUMMARY_MAX);
      for (let i = 0; i < summarized; i++) {
        const rawRoute = routes[i];
        if (!rawRoute || typeof rawRoute !== "object") {
          lines.push(`  Route ${i}: <invalid>`);
          continue;
        }
        const route = rawRoute as CaddyRoute;

        const idVal = typeof route["@id"] === "string" ? route["@id"] : undefined;
        const groupVal = typeof route.group === "string" ? route.group : undefined;
        const id = idVal ? ` @id="${idVal}"` : "";
        const group = groupVal ? ` group="${groupVal}"` : "";

        const matchList: unknown[] = Array.isArray(route.match) ? route.match : [];
        const matchers = matchList
          .map((rawMatcher) => {
            if (!rawMatcher || typeof rawMatcher !== "object") return "catch-all";
            const m = rawMatcher as CaddyMatcher;
            const parts: string[] = [];
            const host = safeJoin(m.host);
            if (host) parts.push(`host=[${host}]`);
            const path = safeJoin(m.path);
            if (path) parts.push(`path=[${path}]`);
            const method = safeJoin(m.method);
            if (method) parts.push(`method=[${method}]`);
            if (typeof m.protocol === "string") parts.push(`protocol=${m.protocol}`);
            if (m.remote_ip && typeof m.remote_ip === "object") {
              const ranges = safeJoin((m.remote_ip as { ranges?: unknown }).ranges);
              parts.push(`remote_ip=[${ranges || "..."}]`);
            }
            if (m.client_ip && typeof m.client_ip === "object") {
              const ranges = safeJoin((m.client_ip as { ranges?: unknown }).ranges);
              parts.push(`client_ip=[${ranges || "..."}]`);
            }
            if (m.query) parts.push("query=...");
            if (m.header) parts.push("header=...");
            if (m.expression) parts.push(`expr(${typeof m.expression === "string" ? m.expression : "..."})`);
            if (m.not) parts.push("not(...)");
            // Show any unrecognized matcher types
            const known = new Set([
              "host",
              "path",
              "method",
              "protocol",
              "remote_ip",
              "client_ip",
              "query",
              "header",
              "expression",
              "not",
            ]);
            for (const key of Object.keys(m)) {
              if (!known.has(key)) parts.push(`${key}=...`);
            }
            if (parts.length === 0) return "catch-all";
            return parts.join(" ");
          })
          .join(" | ");

        const handleList: unknown[] = Array.isArray(route.handle) ? route.handle : [];
        const handlers = handleList
          .map((rawHandler) => {
            if (!rawHandler || typeof rawHandler !== "object") return "unknown";
            const h = rawHandler as CaddyHandler;
            if (h.handler === "reverse_proxy") {
              const upstreamsArr: unknown[] = Array.isArray(h.upstreams) ? h.upstreams : [];
              const upstreams = upstreamsArr
                .map((u) => {
                  if (u && typeof u === "object") {
                    const dial = (u as CaddyUpstream).dial;
                    if (typeof dial === "string") return dial;
                  }
                  return "?";
                })
                .join(",");
              return `reverse_proxy(${upstreams})`;
            }
            if (h.handler === "file_server") {
              const root = typeof h.root === "string" ? h.root : ".";
              return `file_server(${root})`;
            }
            if (h.handler === "static_response") {
              const status = typeof h.status_code === "number" ? h.status_code : 200;
              return `static_response(${status})`;
            }
            if (h.handler === "rewrite") {
              const uri = typeof h.uri === "string" ? h.uri : "...";
              return `rewrite(${uri})`;
            }
            if (h.handler === "subroute") {
              const count = Array.isArray(h.routes) ? h.routes.length : 0;
              return `subroute(${count} routes)`;
            }
            if (h.handler === "encode") return "encode";
            if (h.handler === "headers") return "headers";
            if (h.handler === "authentication") {
              const providers =
                h.providers && typeof h.providers === "object"
                  ? Object.keys(h.providers as Record<string, unknown>).join(",")
                  : "...";
              return `auth(${providers})`;
            }
            if (h.handler === "error") {
              const status = typeof h.status_code === "number" ? h.status_code : "...";
              return `error(${status})`;
            }
            return typeof h.handler === "string" ? h.handler : "unknown";
          })
          .join(" → ");

        const terminal = route.terminal === true ? " [terminal]" : "";
        lines.push(`  Route ${i}:${id}${group} ${matchers} → ${handlers}${terminal}`);
      }
      if (summarized < routes.length) {
        lines.push(
          `  ... ${routes.length - summarized} more route(s) not shown (summary caps at ${ROUTES_SUMMARY_MAX}).`,
        );
      }

      const { json, shown } = serializeRoutesCapped(routes);
      const content: { type: "text"; text: string }[] = [
        { type: "text" as const, text: lines.join("\n") },
        { type: "text" as const, text: json },
      ];
      // Truncation notes go in their own block so the JSON block above stays
      // parseable as-is.
      if (shown < routes.length) {
        content.push({
          type: "text" as const,
          text: `[JSON block truncated: showing ${shown} of ${routes.length} routes to stay under ${ROUTES_JSON_MAX_CHARS} characters. Read the rest with caddy_config_get at path 'apps/http/servers/${srv}/routes', or one route at a time with caddy_config_by_id.]`,
        });
      }
      return { content };
    },
  );

  server.tool(
    "caddy_remove_route",
    "Remove a route. Target by @id (preferred — stable across reorderings) or by array index on a specific server. Index-based removal is a two-step read-then-delete and can race against concurrent edits; prefer @id when possible. " +
      "Only the @id mode is idempotent: a repeat call cannot remove a different route, it just reports the id as gone. The index mode is NOT — Caddy re-packs the routes array after a removal, so calling with index 2 twice removes TWO DIFFERENT routes. " +
      "@ids are config-global in Caddy (NOT route-scoped): if `id` resolves to a non-route object (TLS issuer, server, etc.) the call refuses rather than deleting it.",
    {
      id: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .describe("The @id of the route to remove (preferred — stable even if routes get reordered)"),
      index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Zero-based index of the route in the server's routes array (only used if id is not provided)"),
      server: z
        .string()
        .regex(/^[\w-]{1,128}$/)
        .optional()
        .default("srv0")
        .describe("Caddy server name when using index (default: srv0). Ignored when id is provided."),
      confirm: z.boolean().optional().default(false).describe("Must be true to actually remove the route (safety)"),
    },
    // idempotentHint is false because the hint covers the TOOL, and hosts gate
    // on it before they can see which targeting mode a given call carries. The
    // @id path is idempotent; the index path is not -- Caddy re-packs the
    // routes array on removal, so a repeated index deletes a different route
    // each time. The weaker of the two has to win.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ id, index, server: srv, confirm }) => {
      if (!id && index === undefined) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Error: must provide either id or index" }],
        };
      }
      if (!confirm) {
        const target = id ? `@id="${id}"` : `route ${index} on server "${srv}"`;
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Refusing to remove ${target} without confirm=true. Re-run with confirm:true to proceed.`,
            },
          ],
        };
      }
      if (id) {
        // GET before DELETE, mirroring caddy_reverse_proxy's guard on the write
        // path. @ids are config-global in Caddy, not route-scoped, so
        // DELETE /id/<id> will happily remove a TLS issuer, a server block, or
        // a nested handler that happens to share the id -- and a delete, unlike
        // a botched write, has nothing left to inspect afterwards.
        const existing = await api.configByIdGet(id);
        // Keep the two failure modes distinct: an @id that does not resolve AT
        // ALL is a different problem from one that resolves to the wrong kind
        // of object, and only the caller can tell which one they meant. Surface
        // the API response verbatim rather than translating it into the
        // wrong-shape refusal below.
        if (!existing.ok) return formatResult(existing);
        if (!isRouteShape(existing.data)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  `Error: @id "${id}" resolves to a non-route config object ` +
                  `(no top-level "handle" array). @ids are config-global in Caddy, not ` +
                  `route-scoped -- refusing to delete it as a route. Inspect it with ` +
                  `caddy_config_by_id { id: "${id}", action: "get" }, and if you did mean to ` +
                  `remove that object, delete it deliberately with ` +
                  `caddy_config_by_id { id: "${id}", action: "delete", confirm: true }.`,
              },
            ],
          };
        }
        const res = await api.configByIdDelete(id);
        if (res.ok) return { content: [{ type: "text" as const, text: `Route @id="${id}" removed.` }] };
        return formatResult(res);
      }
      // The id branch always returns, and the top guard rejected the
      // both-absent case -- so an index is guaranteed here. Narrow it for the
      // type-checker (this branch is unreachable in practice).
      if (index === undefined) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Error: must provide either id or index" }],
        };
      }
      // Read first to bounds-check the index and give a clear error if out of range.
      const readRes = await api.configGet(`apps/http/servers/${srv}/routes`);
      if (!readRes.ok) return formatResult(readRes);
      const routes = readRes.data;
      if (routes === undefined || routes === null) {
        // routes key absent. caddy_list_routes renders this as "no routes
        // configured" and succeeds, but a delete naming a specific index has
        // nothing to act on, so report it as an error rather than a silent
        // no-op. The wording is shared with list_routes; the result kind is not.
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: server "${srv}" has no routes configured` }],
        };
      }
      if (!Array.isArray(routes)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: server "${srv}" routes value is malformed (not an array)` }],
        };
      }
      if (index >= routes.length) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: index ${index} out of range — server "${srv}" has ${routes.length} route(s)`,
            },
          ],
        };
      }
      const res = await api.configDelete(`apps/http/servers/${srv}/routes/${index}`);
      if (res.ok) {
        return { content: [{ type: "text" as const, text: `Route ${index} removed from server "${srv}".` }] };
      }
      return formatResult(res);
    },
  );
}
