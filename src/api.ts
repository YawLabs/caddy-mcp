import { request as httpRequest } from "node:http";

const DEFAULT_URL = "http://localhost:2019";
const TIMEOUT = 10000;
const RETRY_BASE_MS = 100;
const RETRY_MAX_DELAY_MS = 2000;
const RETRY_MAX_JITTER_MS = 50;
const RETRY_HARD_CAP = 5;
/**
 * How long a config-changing request waits for Caddy to close the keep-alive
 * sockets it holds before the request is reported complete (see
 * settleAdminRestart). Caddy does it within a millisecond of the response --
 * measured p99 0.3 ms over 200 changes against 2.11.4, with the admin server's
 * shutdown goroutine running about 10 ms late on a saturated host -- so this
 * bound is only ever reached when there is no restart to wait for: a `/load`
 * whose config was byte-identical to the running one (Caddy reports 200 and
 * changes nothing), or an admin endpoint reached through a proxy that keeps
 * its own client connections open.
 */
const ADMIN_RESTART_SETTLE_MS = 250;
/**
 * The default deadline for a config change (CADDY_LOAD_TIMEOUT unset). Kept
 * BELOW 60 s on purpose: the MCP SDK's client gives up on a tool call after
 * DEFAULT_REQUEST_TIMEOUT_MSEC = 60000 unless the host passes its own timeout,
 * and its timer starts before this one does (it is already running while the
 * tool handler is dispatched, and some tools make a GET before their write).
 * A deadline equal to the client's therefore always loses the race: the
 * client throws a bare MCP "Request timed out" (-32001), cancels the call, and
 * the SDK drops the handler's result -- so the outcome-unknown error in
 * sendOnce, the one message that says to re-read before retrying, was never
 * delivered at all. 5 s of headroom covers the client's head start, a GET in
 * front of the write, and the settle wait after it.
 */
const LOAD_TIMEOUT = 55000;

export interface ApiResponse<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  etag?: string;
  /**
   * Config-adapter warnings Caddy attached to a `POST /load` answer, set on a
   * load that applied and on one that failed alike (see readLoadBody). Kept
   * apart from `data` and `error` so neither has to be a rendered string;
   * formatResult prints them for every consumer, so none can drop them.
   * Elements are whatever Caddy sent -- `{file, line, directive, message}` on
   * 2.11.4 -- and are not validated here.
   */
  warnings?: unknown[];
  /**
   * Set (to true) only on a failure where this client's deadline fired on a
   * config change (isConfigChange): no answer came, and Caddy may have applied
   * the change, may still apply it, or may never have received it. `ok` is
   * false, because nothing confirmed success -- but unlike every other failure
   * it does NOT mean "nothing changed", and a caller that skips its bookkeeping
   * on `!ok` needs to know the difference. caddy_load and caddy_revert apply key
   * on it to keep the snapshot they would otherwise drop. A flag rather than a
   * match on the error text, so rewording the message cannot change behaviour.
   */
  outcomeUnknown?: boolean;
}

/** Cache of path → ETag from successful config GETs, used for optimistic concurrency */
const etagCache = new Map<string, string>();
const MAX_ETAG_CACHE = 256;

function setEtag(path: string, etag: string): void {
  if (etagCache.size >= MAX_ETAG_CACHE && !etagCache.has(path)) {
    const oldest = etagCache.keys().next().value;
    if (oldest !== undefined) etagCache.delete(oldest);
  }
  etagCache.set(path, etag);
}

/**
 * Invalidate cached ETags whose paths can no longer be trusted after a
 * successful write to `path`. Without prefix-awareness, a sequence like
 * "GET parent / POST child / write parent" would send a stale If-Match on the
 * parent write and get a spurious 412 -- the parent cache entry survived the
 * child write even though the parent's content changed underneath it.
 *
 * Drops, in order:
 *   1. the exact `path` (the just-written entry; PATCH/PUT may re-set after);
 *   2. ancestors of `path` (e.g. writing /config/a/b/c invalidates /config/a/b
 *      and /config/a);
 *   3. descendants of `path` (e.g. writing /config/a/b invalidates
 *      /config/a/b/c);
 *   4. for writes to `/id/<id>`, every `/config/...` entry -- we can't know
 *      which config sub-path the @id resolves to without an extra round-trip,
 *      so blow them all away (cheapest correct option). The reverse also holds:
 *      a write to `/config/...` invalidates any `/id/...` cached for paths that
 *      may resolve into that subtree.
 */
function isAncestorOf(ancestor: string, descendant: string): boolean {
  // Strip a trailing slash before building the prefix. The root config key is
  // "/config/", which already ends in "/" -- naively appending another would
  // test against "/config//" and match nothing, leaving the root entry cached
  // (and thus stale) after every descendant write.
  const base = ancestor.endsWith("/") ? ancestor.slice(0, -1) : ancestor;
  return descendant.startsWith(`${base}/`);
}

function invalidateRelated(path: string): void {
  etagCache.delete(path);
  for (const key of Array.from(etagCache.keys())) {
    if (key === path) continue;
    if (isAncestorOf(key, path) || isAncestorOf(path, key)) {
      etagCache.delete(key);
    }
  }
  const isIdWrite = path.startsWith("/id/");
  const isConfigWrite = path.startsWith("/config/");
  if (isIdWrite || isConfigWrite) {
    const otherNamespace = isIdWrite ? "/config/" : "/id/";
    for (const key of Array.from(etagCache.keys())) {
      if (key.startsWith(otherNamespace)) etagCache.delete(key);
    }
  }
}

/**
 * The admin API base URL, trailing slashes stripped.
 *
 * A PATH PREFIX in CADDY_ADMIN_URL is preserved on purpose. An admin endpoint
 * fronted by a reverse proxy commonly lives under one
 * (`https://gw.example.com/caddy-admin`), and dropping it would send every
 * request to the gateway's root. So the request URL is `<base><path>` --
 * `configGet("apps")` under that base is `/caddy-admin/config/apps`.
 *
 * Two places deliberately do NOT see the prefix:
 *   - the Origin header (getAdminOrigin), because an origin is scheme+host+port
 *     by definition and that is what Caddy's allowlist compares against;
 *   - the connect-failure message, which reports the origin so the operator
 *     reads a host:port and no credentials leak from a query string.
 * Everything keyed on the path -- the ETag cache, the retry policy -- runs on
 * the prefix-free path built by the exported helpers, so a prefix cannot change
 * either. Only URL composition in attemptRequest sees it.
 *
 * A query or fragment in CADDY_ADMIN_URL is operator error, not a supported
 * form: "http://h:2019/p?token=x" composes to "...?token=x/config/", where the
 * query swallows the path. Left as-is rather than stripped because there is no
 * legitimate base URL that carries one, and the connect message already hides
 * the secret; see the characterization test in api.test.ts.
 */
function getBaseUrl(): string {
  return (process.env.CADDY_ADMIN_URL || DEFAULT_URL).replace(/\/+$/, "");
}

/**
 * The unix socket path when CADDY_ADMIN_URL points at one, else undefined.
 *
 * Caddy's own hardening guidance is to move the admin endpoint onto a unix
 * socket (`admin { listen unix//var/run/caddy-admin.sock }`), where access is
 * governed by filesystem permissions instead of a loopback port. Node's global
 * `fetch` cannot dial a unix socket at all, so those instances are unreachable
 * without a separate transport -- see sendViaUnixSocket.
 *
 * Two spellings are accepted, because operators copy from both places:
 *   - URL form:   unix:///var/run/caddy-admin.sock
 *   - Caddy form: unix//var/run/caddy-admin.sock  (its network-address syntax,
 *                 `<network>/<address>`, as written in the admin config)
 */
function getUnixSocketPath(): string | undefined {
  const raw = (process.env.CADDY_ADMIN_URL || "").trim();
  if (!raw) return undefined;
  const urlForm = /^unix:\/\/(\/.*)$/.exec(raw);
  if (urlForm) return urlForm[1];
  const caddyForm = /^unix\/(\/.*)$/.exec(raw);
  if (caddyForm) return caddyForm[1];
  return undefined;
}

let warnedRetryClamp = false;
function getMaxRetries(): number {
  const raw = process.env.CADDY_MAX_RETRIES;
  if (raw === undefined) return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 2;
  const floored = Math.floor(n);
  // Warn once per process when the user-supplied value exceeds the hard cap.
  // getMaxRetries runs on every request, so an unconditional warn would
  // spam stderr; a per-process flag keeps the signal noticeable but quiet.
  if (floored > RETRY_HARD_CAP && !warnedRetryClamp) {
    warnedRetryClamp = true;
    console.error(`caddy-mcp: CADDY_MAX_RETRIES=${raw} exceeds hard cap; using ${RETRY_HARD_CAP}.`);
  }
  return Math.min(floored, RETRY_HARD_CAP);
}

/** The admin URL's origin (scheme://host:port), or undefined if it won't parse. */
function getAdminOrigin(): string | undefined {
  try {
    return new URL(getBaseUrl()).origin;
  } catch {
    return undefined;
  }
}

function getHeaders(contentType?: string, overUnixSocket = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  const token = process.env.CADDY_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  // Over a unix socket, send NO Origin -- the opposite of the TCP case below.
  // Caddy builds no default origin allowlist for a unix/fd admin listener (it
  // reasons that browsers can't reach a unix socket, so DNS rebinding and
  // cross-site requests don't apply), and it skips the Origin check entirely
  // unless the request carries an Origin or Sec-Fetch-Mode header. Sending one
  // opts us INTO a check against an empty allowlist, which always fails. The
  // node:http transport lets us omit both headers, so we do.
  if (overUnixSocket) return headers;
  // Node's global fetch ALWAYS sends `Sec-Fetch-Mode: cors`. Caddy's admin API
  // reads that as a browser-initiated cross-origin request and enforces its
  // Origin allowlist; with no Origin header the computed origin is "", which is
  // never allowed -- so every request 403s against a stock Caddy with
  // {"error":"client is not allowed to access from origin ''"}. curl and
  // node:http send no Sec-Fetch-Mode and are allowed, which is why manual
  // testing with curl never surfaces this. Sending an Origin that matches the
  // admin URL puts us back inside Caddy's default allowlist (which is derived
  // from the admin listen address).
  const origin = getAdminOrigin();
  if (origin) headers.Origin = origin;
  return headers;
}

/** Normalize config path — strip leading /config/ or / if present */
function normalizePath(path: string): string {
  return path.replace(/^\/?(config(\/|$))?/, "");
}

/**
 * Percent-encode a path one SEGMENT at a time.
 *
 * Caddy config keys are arbitrary strings -- a server named "prod#1", a key
 * holding a "?" -- but the result is interpolated straight into a request URL,
 * where "#" opens a fragment and "?" opens a query. Unencoded,
 * `configDelete("apps/http/servers/prod#1")` sends
 * `DELETE /config/apps/http/servers/prod`: everything from the "#" never leaves
 * the client, so it deletes the PARENT server and reports success. Encoding
 * turns those into %23 / %3F, so the whole key reaches Caddy and a key that
 * does not exist 404s instead of silently resolving to a different one.
 *
 * Per segment rather than whole-string because encodeURIComponent("/") is
 * "%2F" -- encoding in one shot would destroy the separator and address a
 * single top-level key whose name happens to contain slashes.
 *
 * Safe because Go decodes it back: net/http parses the request target and
 * Caddy's admin handler routes on r.URL.Path, which holds the DECODED path, so
 * %23 arrives at the config lookup as "#".
 *
 * ORDERING IS LOAD-BEARING: callers run rejectTraversal on the DECODED path
 * BEFORE encoding. Encoding first would let a caller-supplied "%2e%2e" past the
 * check and hand Caddy a real ".." segment; checking first means that input is
 * escaped to "%252e%252e" and lands as a literal key name.
 */
function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Reject path-traversal segments so config-scoped tools can't reach sibling admin endpoints like /load or /stop. */
function rejectTraversal(path: string): ApiResponse | null {
  if (/(^|\/)\.\.(\/|$)/.test(path)) {
    return {
      ok: false,
      status: 0,
      error: `Invalid path "${path}": '..' segments are not allowed`,
    };
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failed response could come out differently if the request were sent
 * again. Necessary, never sufficient: shouldRetry decides whether THIS request
 * may be replayed.
 *
 * Status 0 is a transport failure -- no response arrived at all.
 *
 * Of the 5xx range, only the gateway statuses 502 / 503 / 504 count. Caddy's
 * admin API never emits one: no AdminRoute handler at v2.11.4 (admin.go,
 * caddyconfig/load.go, and the reverse_proxy / pki / metrics admin routes)
 * writes a gateway status, so one can only come from a proxy in front of the
 * admin endpoint -- the case this retry was written for.
 *
 * What Caddy itself emits is 500, and its 500s are deterministic rejections,
 * not outages. handleError turns every error that is not an APIError into 500
 * (admin.go:894-899), which is how `loading new config: ...` (the new config
 * failed validation or provisioning), `decoding request body`, `array index out
 * of bounds` and `invalid traversal path` all arrive. Caddy either refused the
 * request before touching the config or restored the old one before answering
 * (changeConfig, caddy.go:247-264), so the change did not land and a replay
 * gets the same answer. Every replay cost an ERROR line in Caddy's log
 * (handleError logs each one), fired without the settle wait because that is
 * gated on success; what else it cost depends on where Caddy refused it:
 *   - `invalid traversal path`, `array index out of bounds` and `decoding
 *     request body` come out of unsyncedConfigAccess, which changeConfig runs
 *     and returns from (caddy.go:205-207) before any load starts, and so does a
 *     `loading new config` failure in StrictUnmarshalJSON (an unknown field,
 *     caddy.go:343). Nothing is loaded and nothing restarts: each replay was a
 *     wasted round trip and one more ERROR line.
 *   - A load that fails while PROVISIONING the apps (an unknown handler module,
 *     say) has already restarted Caddy's admin endpoint -- provisionContext
 *     replaces the admin server (caddy.go:565) ahead of the apps -- so each of
 *     those replays was another admin restart as well.
 * Verified against Caddy 2.11.4: a PATCH naming an unknown handler, a DELETE of
 * `routes/9` past the end of the array, a PATCH with a non-JSON body and a PATCH
 * carrying an unknown field all answer 500, and of the four only the unknown
 * handler restarts the admin endpoint (one more "admin endpoint started" log
 * line). One caddy_config_set with a bad handler cost 3 ERROR lines, 3 admin
 * restarts and 438 ms at the default CADDY_MAX_RETRIES, against 1, 1 and 35 ms
 * with retries off. The cheap kind was also the ordinary path, not an error
 * case: caddy_tls set_email against an instance with no `apps/tls` replayed its
 * doomed PATCH (500 `invalid traversal path`) twice on every call -- two wasted
 * round trips and two ERROR lines -- before falling back to the write that
 * creates the app.
 *
 * Status-only on purpose. Sniffing for Caddy's `{"error":...}` body to tell
 * "Caddy's 500" from "a proxy's 500" would be a heuristic over a shape any
 * proxy can also produce; a proxy that answers 500 for an outage is not
 * retried, which costs one un-retried request.
 *
 * Never 4xx, including 412 (a concurrency conflict is an answer, not a blip).
 */
function isTransientFailure(res: ApiResponse): boolean {
  if (res.ok) return false;
  if (res.status === 0) return true;
  return res.status === 502 || res.status === 503 || res.status === 504;
}

/**
 * Caddy's "a segment of this config path does not exist" failure.
 *
 * Caddy walks a config path one segment at a time and reports the first segment it
 * cannot enter as `invalid traversal path at: <path>`. The STATUS varies with the
 * verb -- 400 on a GET, 500 on a POST, both observed on 2.11.4 -- so the body is
 * the only signal that holds across call sites.
 *
 * DISTINCT from `404 key does not exist`, which Caddy emits when the object exists
 * but the named sub-key does not (a PATCH of an absent issuer field, say). Both
 * mean "what you named is not there", so a caller translating a missing parent
 * usually wants both markers; matching only the 404 form leaves the traversal case
 * falling through as a raw Go error.
 *
 * Exported because two tools need it and they live in different modules: the route
 * tools translate it into "that server does not exist", and caddy_list_servers
 * reads it as "no HTTP servers are configured at all".
 */
export function isMissingConfigPath(res: Pick<ApiResponse, "ok" | "error">): boolean {
  if (res.ok) return false;
  return (res.error ?? "").toLowerCase().includes("invalid traversal path");
}

/**
 * Matches a trailing array index, e.g. ".../routes/0" -- the shape Caddy PUT
 * inserts at and Caddy DELETE re-packs around.
 *
 * Trailing slashes are tolerated because Caddy tolerates them: it trims the
 * config path before walking it (`strings.Trim(path, "/")`, admin.go:1178), so
 * ".../routes/0/" addresses the same element, while normalizePath and
 * encodePathSegments here pass a trailing slash through untouched. Anchoring on
 * a bare `$` let that spelling walk straight past both carve-outs below.
 * Verified against Caddy 2.11.4: `DELETE .../routes/0/` answers 200 and removes
 * element 0.
 */
const ARRAY_INDEX_TAIL_RE = /\/\d+\/*$/;

/** A bare `/id/<id>` with no subpath -- see the PUT paragraph of isRetryableMethod. */
const BARE_ID_RE = /^\/id\/[^/]+\/*$/;

/**
 * Whether Caddy handles a (method, path) by loading a new config: `POST /load`,
 * and every non-GET under /config or /id.
 *
 * All of them run the same code inside Caddy. handleConfig hands the write to
 * changeConfig (admin.go:1069) and `/load` reaches the same function through
 * caddy.Load (caddy.go:136); changeConfig takes `rawCfgMu` and holds it while it
 * provisions and starts the ENTIRE new config and stops the old one
 * (caddy.go:168 through unsyncedDecodeAndRun at :247), and only then does the
 * response go out. It takes no request context, so nothing the client does --
 * a timeout, a closed connection -- cancels a change once Caddy has read it.
 *
 * Three things here key on that one fact, which is why it is one predicate:
 *   - the deadline (getTimeoutFor): a reload needs the CADDY_LOAD_TIMEOUT budget
 *     whichever endpoint started it;
 *   - the retry policy (shouldRetry): a deadline that fires on one of these says
 *     nothing about whether the change applied, and a replay cannot overtake it;
 *   - the settle wait (settleAdminRestart): a successful one restarts Caddy's
 *     admin endpoint.
 */
function isConfigChange(method: string, path: string): boolean {
  if (method === "GET") return false;
  return path === "/load" || path.startsWith("/config/") || path.startsWith("/id/");
}

/**
 * Whether replaying a (method, path) leaves the same end state as sending it
 * once -- the question that matters when a failure does not say whether Caddy
 * applied the request (no response arrived, or a proxy in front answered for it).
 *
 * GET and PATCH always are: a read changes nothing, and PATCH replaces the value
 * at a path with the same value.
 *
 * DELETE is, EXCEPT at an array index. Deleting a map key twice is harmless --
 * the replay answers 404 `key does not exist` -- and so is a bare
 * `DELETE /id/<id>`: Caddy rebuilds its id index after the first delete, so the
 * replay answers 404 `unknown object ID`. But Caddy removes an array element by
 * re-packing the array (`append(arr[:idx], arr[idx+1:]...)`, admin.go:1251), so
 * whatever sat at n+1 is at n by the time a replay arrives, and the replay
 * removes THAT. It compounds: replays of a change Caddy is still applying queue
 * on its config lock and then each run against the already re-packed array, so
 * one `DELETE .../routes/2` could remove up to 1 + CADDY_MAX_RETRIES routes
 * (3 by default, 6 at the cap) and still report a failure. Verified against
 * Caddy 2.11.4, with another reload holding the config lock for 4 s and a 1 s
 * deadline: 2.5.2 sent `DELETE .../routes/0` three times, routes r0, r1 AND r2
 * were gone afterwards, and the call reported "Request timed out"; under the
 * current policy (this carve-out, plus shouldRetry's rule 3 for the deadline)
 * Caddy receives it once and only r0 goes. caddy_remove_route by index is
 * fully exposed -- it reads `.../routes` and deletes `.../routes/<n>`, so no
 * cached ETag matches the path and no If-Match guards the replay.
 *
 * PUT is, EXCEPT at an array index, for the mirror-image reason. Caddy's PUT
 * semantics are "insert at a position in an array, strictly create otherwise"
 * -- so a PUT to `.../routes/0` that was applied but lost its response would
 * insert a SECOND element on replay. That is the same silent-duplicate hazard
 * the POST carve-out below exists to prevent.
 *
 * A bare `PUT /id/<id>` (no subpath) is the same hazard in disguise, so it is
 * excluded too. Caddy rewrites the id to the expanded path it indexes
 * (handleConfigID, admin.go:1108-1122), and for a route that path ENDS in an
 * array index -- `.../routes/2` -- so the PUT inserts the value just before the
 * identified element; ARRAY_INDEX_TAIL_RE cannot see that, because the index
 * is only in the path Caddy expands, never in the one sent. changeConfig then
 * rebuilds the id index, so a replay resolves the id to the element's NEW
 * position and inserts a second copy in front of it (a value carrying no @id
 * passes indexing, so nothing rejects the duplicate). Verified against Caddy
 * 2.11.4: the same `PUT /id/keep` (keep = a route, value with no @id) sent twice
 * answered 200 both times and left two copies in front of it. An id that names an
 * object held under a key (a server) loses nothing by the exclusion: PUT there
 * answers 409 `key already exists`, so a replay was never useful. The If-Match
 * guard does not cover it either: the ETag of a bare /id/ path is only cached
 * after a GET of exactly that path, and any /config write clears every /id/
 * entry (invalidateRelated).
 *
 * For all of these, a config key that is literally numeric (a server named "0")
 * is a false positive; the cost is one un-retried request, versus a duplicated
 * or wrongly deleted route if we guessed the other way.
 *
 * POST is split by path:
 *  - `/config/<path>` and `/id/<id>` are non-idempotent: they append to
 *    arrays (e.g. routes) or create new keys. When no response arrived
 *    (status 0) the request may already have been applied, and a gateway
 *    status from a proxy in front says nothing either way; replaying risks a
 *    silent duplicate append -- skip the loop and surface the failure verbatim.
 *  - `/load` is an atomic full-config replace: same input yields the same
 *    end state, so retry is safe and is genuinely useful against a flaky
 *    proxy during a large config push.
 *  - `/adapt` is a pure transformation (Caddyfile/etc -> JSON) with no
 *    side effects.
 *  - `/stop` is destructive but a second call against an already-stopped
 *    server is a no-op (it just yields ECONNREFUSED), so retry is benign.
 */
function isRetryableMethod(method: string, path: string): boolean {
  // Trailing slashes tolerated for the same reason as ARRAY_INDEX_TAIL_RE.
  if (method === "PUT" && BARE_ID_RE.test(path)) return false;
  if (method === "PUT" || method === "DELETE") return !ARRAY_INDEX_TAIL_RE.test(path);
  if (method !== "POST") return true;
  return !path.startsWith("/config/") && !path.startsWith("/id/");
}

/** One attempt's result, plus the transport facts the retry policy needs. */
interface Attempt<T> {
  res: ApiResponse<T>;
  /** The connection was refused: no byte of the request reached Caddy. */
  refused: boolean;
  /** This client's own deadline fired before any response arrived. */
  timedOut: boolean;
}

/**
 * The whole retry decision for one failed attempt. Four rules, in precedence
 * order, each answering a different question:
 *
 *  1. Could a second send come out differently at all? (isTransientFailure)
 *     No for every 4xx and for Caddy's own 500s -- stop.
 *
 *  2. Did the request provably never reach Caddy? A refused connection is
 *     retried for EVERY method, including the POST, array-index PUT and
 *     array-index DELETE that rule 4 excludes, and ahead of rule 3: the TCP
 *     handshake never completed, so not one byte of the request left this
 *     process and a replay cannot duplicate a write. That proof holds for
 *     ECONNREFUSED only -- a reset or a timeout can arrive after Caddy read
 *     and applied the request. A Caddy that is genuinely down still fails in a
 *     few hundred ms at the default budget, with the unchanged "is Caddy
 *     running?" message.
 *
 *  3. Could the first request still be running? A deadline that fires on a
 *     config change (isConfigChange) is never replayed, `/load` included. If
 *     Caddy read the request, it is not gone -- Caddy goes on applying it under
 *     its config lock and ignores the client having hung up -- so a replay
 *     does not race it, it QUEUES behind it, and then runs against a config
 *     the first request already changed. What comes back misreports the first
 *     request's own result: a 412 when an If-Match was cached (the path's hash
 *     changed), a 404 for a delete that in fact landed (observed on 2.11.4,
 *     see getTimeoutFor), a second removal at an array index (rule 4 stops
 *     that one independently). And when the reload outlasts the deadline,
 *     every replay times out as well: 1 + CADDY_MAX_RETRIES deadlines back to
 *     back, 165 s at the defaults, far past the 60 s the MCP SDK's client
 *     waits for a tool call by default (which is also why a single default
 *     deadline sits below 60 s -- see LOAD_TIMEOUT). The operator is told the
 *     outcome is unknown instead (see the timeout message in sendOnce), and the
 *     response carries `outcomeUnknown` so caddy_load and caddy_revert keep the
 *     snapshot a load that did apply would need. `/load` is held to the rule
 *     like the rest, although a replay of an identical `/load` is answered 200
 *     without reloading once it gets the lock: the replay could as easily land
 *     behind ANOTHER reloader's load and put this body back over it. A
 *     deadline on anything else -- a GET, `/adapt`, `/stop` -- may still
 *     retry: nothing is left half-applied behind it.
 *
 *  4. Otherwise: is a replay idempotent for this method and path?
 *     (isRetryableMethod)
 *
 * Same CADDY_MAX_RETRIES budget and backoff whichever rule lets a retry through.
 */
function shouldRetry(method: string, path: string, attempt: Attempt<unknown>): boolean {
  if (!isTransientFailure(attempt.res)) return false;
  if (attempt.refused) return true;
  if (attempt.timedOut && isConfigChange(method, path)) return false;
  return isRetryableMethod(method, path);
}

/**
 * A CADDY_ADMIN_URL that plainly means "unix socket" but does not parse as one.
 *
 * `unix:/run/caddy.sock` (one slash) and `unix://relative.sock` both fail both
 * patterns above and would otherwise fall through to the TCP path, where fetch
 * reports `Cannot connect to Caddy admin API at null` -- an error naming
 * neither the socket nor the actual mistake. Matching on `unix:` / `unix/`
 * rather than a bare `unix` prefix so a real host like `unix.example.com:2019`
 * is not swept up.
 */
function getMalformedUnixUrl(): string | undefined {
  const raw = (process.env.CADDY_ADMIN_URL || "").trim();
  if (!raw || !/^unix[:/]/i.test(raw)) return undefined;
  return getUnixSocketPath() === undefined ? raw : undefined;
}

async function caddyRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
  rawStringBody = false,
): Promise<ApiResponse<T>> {
  // Checked here rather than in attemptRequest so it bypasses the retry loop:
  // this is a static configuration mistake, and status 0 would otherwise be
  // treated as a transient failure and replayed.
  const malformed = getMalformedUnixUrl();
  if (malformed) {
    return {
      ok: false,
      status: 0,
      error:
        `CADDY_ADMIN_URL="${malformed}" looks like a unix socket address but is not a recognized form. ` +
        `Use "unix:///absolute/path.sock" (URL form) or "unix//absolute/path.sock" (Caddy's own spelling). ` +
        `A single slash after "unix:", or a relative path, will not parse.`,
    };
  }
  const maxRetries = getMaxRetries();
  let retries = 0;
  let attempt = await attemptRequest<T>(method, path, body, contentType, rawStringBody);
  // Whether a failure may be replayed is decided in one place: see shouldRetry.
  while (retries < maxRetries && shouldRetry(method, path, attempt)) {
    retries++;
    const backoff = Math.min(RETRY_BASE_MS * 2 ** (retries - 1), RETRY_MAX_DELAY_MS);
    const delay = backoff + Math.random() * RETRY_MAX_JITTER_MS;
    await sleep(delay);
    attempt = await attemptRequest<T>(method, path, body, contentType, rawStringBody);
  }
  return attempt.res;
}

/**
 * Whether a transport error is a refused connection, anywhere in its cause chain.
 *
 * fetch wraps the socket error: TypeError("fetch failed") with `cause` set to an
 * Error whose code is ECONNREFUSED -- or, for a hostname like `localhost` that
 * resolves to both ::1 and 127.0.0.1, an AggregateError carrying one refused
 * error per address. node:http (the unix-socket transport) rejects with the
 * socket error itself. A refusal means the connect never succeeded, so the
 * request was never written; that is what makes it safe to replay any method.
 */
function isConnectionRefused(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; errors?: unknown; cause?: unknown };
    if (e.code === "ECONNREFUSED") return true;
    if (
      Array.isArray(e.errors) &&
      e.errors.length > 0 &&
      e.errors.every((inner) => (inner as { code?: unknown } | null)?.code === "ECONNREFUSED")
    ) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/**
 * Whether a transport error is this client's own deadline firing, judged by the
 * error's NAME anywhere in its cause chain, not by its message.
 *
 * The message is runtime-specific text. Node's fetch rejects an
 * AbortSignal.timeout with DOMException TimeoutError "The operation was aborted
 * due to timeout"; oam's -- the runtime bin/caddy-mcp.mjs prefers when oam
 * 0.15.2 or newer is installed -- rejects with DOMException TimeoutError "The
 * operation timed out", which contains neither "abort" nor "timeout". Matching
 * on the text alone missed that, so under oam a timed-out config change was
 * never recognised as one: rule 3 of shouldRetry did not fire, the write was
 * replayed up to 1 + CADDY_MAX_RETRIES times (into the false 404 / 412 rule 3
 * exists to prevent), and the caller got the bare runtime message instead of
 * the outcome-unknown one. The name is what the platform standardises:
 * `TimeoutError` for an AbortSignal.timeout reason, `AbortError` for an abort
 * (node:http wraps a signal abort in one, with the TimeoutError as its cause).
 *
 * Walks `cause` like isConnectionRefused. The caller still keeps the old
 * substring test as a fallback for a runtime whose error carries neither name.
 */
function isTimeoutError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const e = current as { name?: unknown; cause?: unknown };
    if (e.name === "TimeoutError" || e.name === "AbortError") return true;
    current = e.cause;
  }
  return false;
}

/** The transport-agnostic shape both send paths reduce to. */
interface RawResponse {
  ok: boolean;
  status: number;
  text: string;
  etag?: string;
}

/**
 * Send one request over a unix socket via node:http.
 *
 * Errors reject rather than resolve, so sendOnce's catch block does the
 * classification for both transports. A fired deadline rejects with an error
 * NAMED TimeoutError, which that catch recognises by name (isTimeoutError).
 */
function sendViaUnixSocket(
  socketPath: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    // An absolute deadline, not req.setTimeout: setTimeout is an INACTIVITY
    // timer, so a response that trickles bytes steadily would never fire it,
    // while the fetch path below aborts on an absolute deadline. Keeping the two
    // alike keeps CADDY_TIMEOUT / CADDY_LOAD_TIMEOUT meaning one thing on both
    // transports.
    //
    // An explicit timer that destroys the request, rather than node:http's
    // `signal` option. On Node the two are the same thing -- a signal abort IS a
    // req.destroy -- but oam's node:http ignores `signal`: a request under
    // AbortSignal.timeout(200) had still not aborted after 3 s on oam 0.16.2
    // (Node: 203 ms), which left this transport with no deadline at all there.
    // Once the timer has fired, every rejection that follows is reported as the
    // deadline itself: destroying a request whose response has already started
    // also fails the response with a generic "aborted", and the catch must see
    // the timeout either way.
    //
    // agent: false gives every request its own connection. Since Node 19 the
    // global agent keeps sockets alive, and Caddy closes them whenever a config
    // change restarts its admin endpoint (see settleAdminRestart), so a pooled
    // socket can be dead by the time the next request is written to it. Over a
    // unix socket a connection per request is the right answer rather than the
    // TCP path's wait: connecting is cheap, and Caddy hands the same socket to
    // the new admin server by duplicating its descriptor (no unlink, no
    // shared-listener deadline -- that bug is TCP on Windows only), so a fresh
    // connect during the restart just queues in the backlog. A dedicated agent
    // (keepAlive off) also sends `Connection: close`.
    let deadlineHit = false;
    const deadline = Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: "TimeoutError" });
    function fail(err: unknown) {
      clearTimeout(timer);
      reject(deadlineHit ? deadline : err);
    }
    const req = httpRequest({ socketPath, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", fail);
      res.on("end", () => {
        clearTimeout(timer);
        const status = res.statusCode ?? 0;
        const etag = res.headers.etag;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: Buffer.concat(chunks).toString("utf8"),
          etag: typeof etag === "string" ? etag : undefined,
        });
      });
    });
    const timer = setTimeout(() => {
      deadlineHit = true;
      req.destroy(deadline);
    }, timeoutMs);
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Send one request over TCP via the global fetch.
 *
 * Plain keep-alive: fetch pools its connections and the next request reuses
 * one. That pooling is load-bearing -- see settleAdminRestart for the restart
 * race it interacts with, and why the obvious alternative (`Connection: close`
 * on every request) was measured and rejected.
 */
async function sendViaFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  const pending = fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  // Node creates the global dispatcher synchronously inside the first fetch()
  // call, so hooking here -- after the call, before the await -- still sees the
  // `connect` event for the very first socket.
  hookGlobalDispatcher();
  const res = await pending;
  return {
    ok: res.ok,
    status: res.status,
    text: await res.text(),
    etag: res.headers.get("ETag") || undefined,
  };
}

/**
 * The keep-alive sockets fetch currently holds, per origin, counted from the
 * global dispatcher's `connect` / `disconnect` events. Node's fetch is undici,
 * and undici's Agent emits one `connect` per socket it opens and one
 * `disconnect` per socket that closes -- its own idle timeout, or the server
 * hanging up -- with the origin as the first argument. The dispatcher lives at
 * a well-known symbol (the same one Node's fetch reads on every call), so no
 * import of undici is needed. If a future Node moves it, hookGlobalDispatcher
 * finds nothing, the count stays empty, and settleAdminRestart is a no-op:
 * the pre-fix behavior, never anything worse.
 */
const GLOBAL_DISPATCHER_KEY = Symbol.for("undici.globalDispatcher.1");
interface DispatcherEvents {
  on(event: "connect" | "disconnect", listener: (origin: unknown) => void): unknown;
}
const liveSockets = new Map<string, number>();
const socketWaiters = new Set<() => void>();
let dispatcherHooked = false;

function hookGlobalDispatcher(): void {
  if (dispatcherHooked) return;
  const dispatcher = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER_KEY] as DispatcherEvents | undefined;
  if (!dispatcher || typeof dispatcher.on !== "function") return;
  dispatcherHooked = true;
  dispatcher.on("connect", (origin) => {
    const key = originOf(origin);
    if (key) liveSockets.set(key, (liveSockets.get(key) ?? 0) + 1);
  });
  dispatcher.on("disconnect", (origin) => {
    const key = originOf(origin);
    if (!key) return;
    const left = Math.max(0, (liveSockets.get(key) ?? 0) - 1);
    liveSockets.set(key, left);
    if (left === 0) for (const wake of socketWaiters) wake();
  });
}

/** undici passes the origin as a URL; normalize to the same form getAdminOrigin yields. */
function originOf(origin: unknown): string | undefined {
  try {
    return new URL(String(origin)).origin;
  } catch {
    return undefined;
  }
}

/**
 * After a successful config change over TCP: wait until fetch holds no
 * keep-alive socket to the admin origin, so the caller's NEXT request opens a
 * fresh connection instead of reusing one Caddy is about to close.
 *
 * Why: Caddy restarts its admin endpoint after every config change (`POST
 * /load`, and every POST/PUT/PATCH/DELETE under /config or /id). The old
 * endpoint's shutdown closes each keep-alive connection -- the one that carried
 * the change within a millisecond of its response (measured p99 0.3 ms on
 * 2.11.4), the idle ones at the same moment. fetch pools those connections, so
 * a request dispatched right after the response was written to a socket Caddy
 * had just closed and came back as ECONNRESET / "other side closed", reported
 * as "Cannot connect to Caddy admin API ... is Caddy running?" while Caddy was
 * fine. Measured: 157 such failures in 15 runs of the live suite, every one on
 * a reused socket with no response byte, none on a fresh connection.
 *
 * Why not retry the reset: GET, PATCH and DELETE of a key already do, which is
 * why those only ever looked slow. A POST under /config appends, a PUT at an
 * array index inserts and a DELETE at one re-packs the array, and a reset does
 * not prove Caddy never read the request -- only that no response arrived -- so
 * replaying one risks a duplicate route, or the wrong route removed (see
 * isRetryableMethod). Waiting for the close means none of them is ever written
 * to a doomed socket in the first place, so there is nothing to replay.
 *
 * Why not `Connection: close` on every request: it also keeps requests off
 * doomed sockets, but it makes the request after a config change open a fresh
 * TCP connection the instant the response arrives, and on Windows that lands
 * in a Caddy bug. Caddy stops the old admin server asynchronously; on platforms
 * without SO_REUSEPORT the old and new servers share one listener, and the old
 * server's Close() parks a past deadline on it that only the old accept loop
 * clears -- and only if that loop is inside Accept() at that moment. A fresh
 * connection accepted by the old loop right then leaves the deadline set for
 * good, and the admin endpoint stops accepting until Caddy is restarted
 * ("http: Accept error: accept tcp: i/o timeout; retrying" forever). Measured
 * on a saturated host: two permanent wedges in about 1,400 restarts with
 * `Connection: close`, none in 1,709 with keep-alive. Keep-alive never opens a
 * fresh connection until Caddy has closed the pooled one, which happens after
 * that Close() by construction, so the accept loop is parked when it matters.
 *
 * The wait is event-driven and short (the close arrives with the response);
 * ADMIN_RESTART_SETTLE_MS caps it for the cases where no close is coming.
 */
function settleAdminRestart(origin: string | undefined): Promise<void> {
  if (!origin || !dispatcherHooked || (liveSockets.get(origin) ?? 0) === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ADMIN_RESTART_SETTLE_MS);
    function check() {
      if ((liveSockets.get(origin as string) ?? 0) === 0) done();
    }
    function done() {
      clearTimeout(timer);
      socketWaiters.delete(check);
      resolve();
    }
    socketWaiters.add(check);
  });
}

/** What the body of a 2xx answer to `POST /load` says, beyond its status line. */
interface LoadBody {
  /** Config-adapter warnings, in the order Caddy reported them. */
  warnings: unknown[];
  /** Caddy's trailing `{"error":...}` object exactly as it appeared, when the body carries one. */
  errorText?: string;
}

/**
 * The index just past the first complete JSON array or object in `text`, or -1
 * if it never closes.
 *
 * This finds a BOUNDARY and nothing else: it tracks string state (and escapes
 * inside strings) so a bracket or brace inside a warning's message cannot end
 * the value early, and it counts `[`/`{` against `]`/`}` without caring which
 * closes which. Whether the slice is valid JSON is JSON.parse's job, run on the
 * result by the caller. A regex over the text -- splitting on `]{`, say -- gets
 * this wrong the moment a message contains those characters, and a warning's
 * message is free text quoted from the operator's own config.
 */
function endOfFirstJsonValue(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth <= 0) return depth === 0 ? i + 1 : -1;
    }
  }
  return -1;
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Read the body of a 2xx answer to `POST /load` -- the one place Caddy's status
 * line cannot be taken at its word.
 *
 * handleLoad writes the config adapter's warnings to the response BEFORE it
 * runs the load (caddyconfig/load.go:104-110 at v2.11.4). That first write
 * commits the status at 200, so when caddy.Load then fails, the 400 handleError
 * sets arrives too late to change it and the error object is appended to what
 * was already sent. Verified against Caddy 2.11.4, loading a space-indented
 * Caddyfile (the adapter's "input is not formatted" warning fires on any file
 * `caddy fmt` would change, so this is the common case, not a corner) whose
 * `tls` directive names a certificate file that does not exist:
 *
 *   HTTP/1.1 200 OK
 *   Content-Type: text/plain; charset=utf-8
 *
 *   [{"file":"Caddyfile","line":2,"message":"Caddyfile input is not formatted; run 'caddy fmt --overwrite' to fix inconsistencies"}]{"error":"loading config: loading new config: loading http app module: provision http: getting tls app: loading tls app module: provision tls: loading certificates: open C:/nonexistent-caddy-mcp/cert.pem: The system cannot find the path specified."}
 *
 * and `GET /config/` afterwards still returned the previous config. The same
 * Caddyfile indented with tabs -- no warning, so nothing written early -- is
 * answered 400 with that error object alone. Read as ONE document the 200 body
 * is not JSON, so this client fell through to "a 2xx with a text body" and
 * reported the failed load as a success: caddy_load printed it with no isError,
 * pushed a "pre-load" snapshot of a config that had not been replaced, and the
 * ETag cache was cleared.
 *
 * Shapes recognized:
 *   [..warnings..]                   2.11.4, the load applied (observed live)
 *   [..warnings..]{"error":"..."}    2.11.4, the load FAILED behind a 200 (observed live)
 *   {"warnings":[..]}                the load applied, as caddyserver/caddy#7267 writes it
 *
 * #7267 is the upstream fix: open and milestoned v2.11.5 at the time of
 * writing, read from its diff, never run. It moves the failure to a real 400
 * carrying `{"error":"...","warnings":[..]}`, which needs nothing here -- a
 * non-2xx never reaches this function, and sendOnce already returns such a body
 * verbatim, so both parts stay visible. Only its success shape is handled, and
 * only when `warnings` is the object's sole key, so a body that grew another
 * field is shown whole by the fallback rather than trimmed to the part this
 * function knows about.
 *
 * Anything else returns undefined and the caller does what it always did. That
 * is deliberate: the one thing worth overriding a 200 for is an error object
 * Caddy itself appended, identified by structure (a JSON array, then a JSON
 * object with a string `error`), not by sniffing the text for the word "error".
 */
function readLoadBody(text: string): LoadBody | undefined {
  const body = text.trim();
  if (body.startsWith("[")) {
    const end = endOfFirstJsonValue(body);
    if (end === -1) return undefined;
    const warnings = parseJsonOrUndefined(body.slice(0, end));
    if (!Array.isArray(warnings)) return undefined;
    const tail = body.slice(end).trim();
    if (!tail) return { warnings };
    const trailing = parseJsonOrUndefined(tail);
    if (trailing === null || typeof trailing !== "object" || Array.isArray(trailing)) return undefined;
    if (typeof (trailing as { error?: unknown }).error !== "string") return undefined;
    return { warnings, errorText: tail };
  }
  if (body.startsWith("{")) {
    const parsed = parseJsonOrUndefined(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const warnings = (parsed as { warnings?: unknown }).warnings;
    if (Array.isArray(warnings) && Object.keys(parsed).length === 1) return { warnings };
  }
  return undefined;
}

async function attemptRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
  rawStringBody = false,
): Promise<Attempt<T>> {
  const transport = { refused: false, timedOut: false };
  const res = await sendOnce<T>(transport, method, path, body, contentType, rawStringBody);
  return { res, refused: transport.refused, timedOut: transport.timedOut };
}

async function sendOnce<T = any>(
  transport: { refused: boolean; timedOut: boolean },
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
  rawStringBody = false,
): Promise<ApiResponse<T>> {
  const socketPath = getUnixSocketPath();
  const url = `${getBaseUrl()}${path}`;
  const effectiveTimeout = getTimeoutFor(method, path);
  try {
    const hasBody = body !== undefined;
    const headers = getHeaders(hasBody ? contentType || "application/json" : undefined, socketPath !== undefined);

    // Send If-Match on config writes when we have a cached ETag for this path
    const isConfigPath = path.startsWith("/config/") || path.startsWith("/id/");
    const isWrite = method !== "GET";
    if (isWrite && isConfigPath) {
      const cachedEtag = etagCache.get(path);
      if (cachedEtag) headers["If-Match"] = cachedEtag;
    }

    // Only /load and /adapt take a raw document as the body (a Caddyfile, an
    // nginx.conf). Everywhere else the body is a JSON *value*, so a string must
    // be JSON-encoded -- sending it bare makes Caddy reject the request with
    //   500 {"error":"decoding request body: invalid character 'x' ..."}
    // which is what every string-valued config write used to do: caddy_tls's
    // set_email / set_acme_ca / set_acme_profile, and caddy_config_set or
    // caddy_config_by_id with a string value. Verified against Caddy 2.11.4:
    // bare -> 500, JSON-encoded -> 200.
    const serializedBody = hasBody
      ? rawStringBody && typeof body === "string"
        ? body
        : JSON.stringify(body)
      : undefined;
    const res = socketPath
      ? await sendViaUnixSocket(socketPath, path, method, headers, serializedBody, effectiveTimeout)
      : await sendViaFetch(url, method, headers, serializedBody, effectiveTimeout);
    // `/load` can answer 200 for a load that FAILED: see readLoadBody. Decided
    // here, ahead of everything below that keys on `res.ok`, so this failure is
    // handled exactly as the 400 Caddy sends for the same failure when no
    // warnings got in the way: returned as-is with no settle wait, and -- since
    // loadConfig and caddy_load key on the `ok` returned here -- no ETag cache
    // clear and no pre-load snapshot. Never retried either: isTransientFailure
    // wants status 0 or a gateway status, and this is neither.
    //
    // The status stays the 200 Caddy sent. Reporting the 400 it "meant" would be
    // inventing a response; what happened is a 200 whose body carries a load
    // error, and the message says that. The error object is Caddy's own bytes;
    // the hint explains the 200, which has one mechanism, and names no cause for
    // the load failure itself -- that is whatever Caddy's text says.
    const loadBody = path === "/load" && res.ok ? readLoadBody(res.text) : undefined;
    if (loadBody?.errorText !== undefined) {
      return {
        ok: false,
        status: res.status,
        error:
          `${loadBody.errorText} -- Caddy answered HTTP ${res.status}, but the response body carries this load ` +
          `error after its config-adapter warnings, so caddy-mcp reports the load as failed. Caddy writes the ` +
          `warnings before it runs the load, which fixes the status at 200 whatever the load then does ` +
          `(caddyserver/caddy#7246); without warnings it answers the same failure with 400. Re-read the ` +
          `config to confirm what is running.`,
        warnings: loadBody.warnings,
      };
    }
    // Caddy is now restarting its admin endpoint; hold the result until the
    // pooled sockets it will close are gone, so the caller's next request
    // cannot be written to one of them. Over a unix socket every request has
    // its own connection (agent: false), so there is nothing to wait for.
    if (!socketPath && res.ok && isConfigChange(method, path)) await settleAdminRestart(getAdminOrigin());
    const text = res.text;

    // Capture ETag from config GET responses
    const etag = res.etag;
    if (method === "GET" && etag && isConfigPath) {
      setEtag(path, etag);
    }

    // Method-aware ETag cache policy on successful config writes:
    //   PATCH / PUT: invalidate related entries (ancestors, descendants, cross-namespace),
    //     then re-set the path's own ETag from the response. The response describes the
    //     same path-resource we just modified, so it's safe to trust for that key.
    //   POST: invalidate everything related. POST appends to a collection, so the
    //     returned ETag (if any) may describe the parent or root config rather than
    //     the path-resource -- trusting it would risk a stale If-Match.
    //   DELETE: invalidate everything related. The path-resource is gone; any
    //     returned ETag describes a different scope.
    if (isWrite && res.ok && isConfigPath) {
      invalidateRelated(path);
      if ((method === "PATCH" || method === "PUT") && etag) {
        setEtag(path, etag);
      }
    }

    if (!res.ok) {
      if (res.status === 412) {
        // Clear stale ETag so the next attempt doesn't repeat the failure
        etagCache.delete(path);
        return {
          ok: false,
          status: 412,
          error:
            "Config has been modified since it was last read (HTTP 412 Precondition Failed). " +
            "Re-read the config and retry your change.",
        };
      }
      if (!text) {
        // Some Caddy errors (notably 401/403 behind an auth proxy) come back
        // with an empty body; point at the likely cause instead of a bare code.
        const hint = res.status === 401 || res.status === 403 ? " -- check CADDY_API_TOKEN" : "";
        return { ok: false, status: res.status, error: `HTTP ${res.status}${hint}` };
      }
      // A 403 naming an origin is Caddy's admin allowlist, not auth. We already
      // send a matching Origin, so reaching here means CADDY_ADMIN_URL differs
      // from the origin Caddy accepts -- say so instead of leaving the caller
      // with a bare "not allowed to access from origin ''".
      if (res.status === 403 && /origin/i.test(text)) {
        // The remedy differs by transport, and the TCP advice is actively wrong
        // over a socket -- it would tell the operator to abandon the socket.
        const hint = socketPath
          ? `Over a unix socket caddy-mcp deliberately sends no Origin header, because Caddy builds no ` +
            `default origin allowlist for a unix listener (sending one would fail against an empty list). ` +
            `Reaching here means admin.enforce_origin is enabled -- disable it, or move the admin endpoint ` +
            `to a TCP address.`
          : `Set CADDY_ADMIN_URL to the exact origin Caddy allows (default http://localhost:2019), ` +
            `or add this origin to the admin.origins list in Caddy's config.`;
        return {
          ok: false,
          status: 403,
          error: `${text.trim()} -- Caddy's admin API rejected this client's Origin. ${hint}`,
        };
      }
      return { ok: false, status: res.status, error: text };
    }
    if (!text) return { ok: true, status: res.status, etag };
    // A load that applied, with adapter warnings. They go out as `warnings`, not
    // `data`: a Caddyfile load has no result to return, and leaving the raw array
    // in `data` as well would print every warning twice.
    if (loadBody) return { ok: true, status: res.status, warnings: loadBody.warnings, etag };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T, etag };
    } catch {
      return { ok: true, status: res.status, data: text as T, etag };
    }
  } catch (err: unknown) {
    transport.refused = isConnectionRefused(err);
    const msg = err instanceof Error ? err.message : String(err);
    // ENOENT is the unix-socket-specific shape: the socket file itself is not
    // there. Distinguish it from ECONNREFUSED (file present, nothing accepting)
    // because the fixes differ -- wrong path vs. Caddy not running.
    if (socketPath && msg.includes("ENOENT")) {
      return {
        ok: false,
        status: 0,
        error: `No socket at ${socketPath} — check the path in CADDY_ADMIN_URL and that Caddy's admin endpoint is configured to listen on it.`,
      };
    }
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      let target = socketPath ?? getBaseUrl();
      if (!socketPath) {
        try {
          target = new URL(target).origin;
        } catch {
          // fall through — show raw value if unparseable
        }
      }
      return {
        ok: false,
        status: 0,
        error: `Cannot connect to Caddy admin API at ${target} — is Caddy running?`,
      };
    }
    // By name first (isTimeoutError explains why the text is not enough); the
    // substring test stays as a fallback for a runtime whose error carries no
    // standard name, with "timed out" added for oam's wording.
    if (isTimeoutError(err) || msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out")) {
      transport.timedOut = true;
      const timedOutMsg = `Request timed out after ${effectiveTimeout}ms`;
      if (!isConfigChange(method, path)) return { ok: false, status: 0, error: timedOutMsg };
      // A deadline on a config change is not "it failed". Caddy applies the
      // change synchronously inside the request and does not notice the client
      // giving up (see isConfigChange), so all this client knows is that no
      // answer came in time -- a reload still running, a change waiting on
      // Caddy's config lock behind someone else's reload, a response that was
      // lost, a request that never arrived. The hint therefore names no cause
      // and no outcome; it says the one thing that is true in every case (look
      // before doing it again), because an operator who reads a bare "timed
      // out" and re-issues `DELETE .../routes/2` by hand recreates the replay
      // hazard shouldRetry just declined to create.
      //
      // The CADDY_LOAD_TIMEOUT advice carries its ceiling: raised to or past the
      // MCP client's own request timeout, this message is never delivered (see
      // LOAD_TIMEOUT), which is worse than the timeout it was raised to avoid.
      return {
        ok: false,
        status: 0,
        outcomeUnknown: true,
        error:
          `${timedOutMsg} -- the outcome is unknown: Caddy may still be applying this change. A config change ` +
          `blocks until Caddy finishes reloading, and a client timeout does not cancel it, so it may have ` +
          `applied, may yet apply, or may not apply at all; caddy-mcp never replays a timed-out config change. ` +
          `Re-read the config before retrying. If reloads on this instance legitimately take this long, raise ` +
          `CADDY_LOAD_TIMEOUT, keeping it below your MCP client's request timeout (60 s by default in the MCP ` +
          `SDK), or this error never reaches the client.`,
      };
    }
    return { ok: false, status: 0, error: msg };
  }
}

export function configGet<T = any>(path = ""): Promise<ApiResponse<T>> {
  const normalized = normalizePath(path);
  const bad = rejectTraversal(normalized);
  if (bad) return Promise.resolve(bad);
  return caddyRequest("GET", `/config/${encodePathSegments(normalized)}`);
}

export function configPost<T = any>(path: string, value: unknown): Promise<ApiResponse<T>> {
  const normalized = normalizePath(path);
  const bad = rejectTraversal(normalized);
  if (bad) return Promise.resolve(bad);
  return caddyRequest("POST", `/config/${encodePathSegments(normalized)}`, value);
}

export function configPut<T = any>(path: string, value: unknown): Promise<ApiResponse<T>> {
  const normalized = normalizePath(path);
  const bad = rejectTraversal(normalized);
  if (bad) return Promise.resolve(bad);
  return caddyRequest("PUT", `/config/${encodePathSegments(normalized)}`, value);
}

export function configPatch<T = any>(path: string, value: unknown): Promise<ApiResponse<T>> {
  const normalized = normalizePath(path);
  const bad = rejectTraversal(normalized);
  if (bad) return Promise.resolve(bad);
  return caddyRequest("PATCH", `/config/${encodePathSegments(normalized)}`, value);
}

export function configDelete<T = any>(path: string): Promise<ApiResponse<T>> {
  const normalized = normalizePath(path);
  const bad = rejectTraversal(normalized);
  if (bad) return Promise.resolve(bad);
  return caddyRequest("DELETE", `/config/${encodePathSegments(normalized)}`);
}

function getRequestTimeout(): number {
  const raw = process.env.CADDY_TIMEOUT;
  if (raw === undefined) return TIMEOUT;
  const n = Number(raw);
  // Floor first, then bounds-check -- mirrors getLoadTimeout: "0.5" floors to 0
  // and would produce an immediate-abort timeout.
  if (!Number.isFinite(n)) return TIMEOUT;
  const floored = Math.floor(n);
  if (floored < 1) return TIMEOUT;
  return floored;
}

function getLoadTimeout(): number {
  const raw = process.env.CADDY_LOAD_TIMEOUT;
  if (raw === undefined) return LOAD_TIMEOUT;
  const n = Number(raw);
  // Reject anything that floors below 1ms -- "0.5" passes n>0 but Math.floor(0.5)=0
  // would produce an immediate-abort timeout. Floor first, then bounds-check.
  if (!Number.isFinite(n)) return LOAD_TIMEOUT;
  const floored = Math.floor(n);
  if (floored < 1) return LOAD_TIMEOUT;
  return floored;
}

/**
 * The deadline for one attempt, chosen by what the request makes Caddy do
 * rather than by which endpoint it names: CADDY_LOAD_TIMEOUT for every config
 * change, CADDY_TIMEOUT for everything else (GETs, `/adapt`, `/stop`, PKI,
 * metrics).
 *
 * `/load` used to be the only request on the larger budget, on the reasoning
 * that a full reload can be slow. But a PATCH / PUT / POST / DELETE under
 * /config or /id IS a full reload -- the same changeConfig, the same lock, the
 * same provision-everything-then-stop-the-old-config sequence (see
 * isConfigChange) -- and it sat on the 10 s budget, so the same reload that
 * `/load` would have waited out was reported as a timeout while Caddy carried
 * on applying it. The documented way to get there is
 * `apps.http.shutdown_delay`: stopping the old HTTP app sleeps for that long
 * INSIDE the reload whenever the change closes a listener (deleting a server,
 * editing `listen`; modules/caddyhttp/app.go:660-685 at v2.11.4). Verified
 * against Caddy 2.11.4 with `shutdown_delay: 4s` and a 2 s deadline: deleting a
 * server took 4.0 s and applied; 2.5.2 timed out, replayed, and -- the replay
 * having queued behind the original -- reported `404 key does not exist` for
 * its own successful delete. On the reload budget the same call answers 200.
 * A change that has to wait on Caddy's config lock behind another reloader
 * (`caddy reload`, caddy-docker-proxy) gets there too. ACME issuance does not:
 * certificates are managed asynchronously and do not hold up a reload.
 *
 * The reload budget defaults to 55 s, not the 60 s `/load` alone had in 2.5.2.
 * A config change now gets ONE attempt (shouldRetry rule 3), and the MCP SDK's
 * client abandons a tool call at 60 s by default, so a 60 s deadline meant the
 * outcome-unknown error was never delivered: the client had already given up
 * and the SDK dropped the result (see LOAD_TIMEOUT).
 *
 * Read per attempt, not cached: both values come from the environment.
 */
function getTimeoutFor(method: string, path: string): number {
  return isConfigChange(method, path) ? getLoadTimeout() : getRequestTimeout();
}

export async function loadConfig(config: unknown, contentType?: string): Promise<ApiResponse> {
  const res = await caddyRequest("POST", "/load", config, contentType, true);
  if (res.ok) etagCache.clear();
  return res;
}

export function adapt<T = any>(config: string, adapter = "caddyfile"): Promise<ApiResponse<T>> {
  return caddyRequest<T>("POST", "/adapt", config, `text/${adapter}`, true);
}

export function stop(): Promise<ApiResponse> {
  return caddyRequest("POST", "/stop");
}

export function getUpstreams(): Promise<ApiResponse> {
  return caddyRequest("GET", "/reverse_proxy/upstreams");
}

export function getPki(ca = "local"): Promise<ApiResponse> {
  const bad = rejectTraversal(ca);
  if (bad) return Promise.resolve(bad);
  return caddyRequest("GET", `/pki/ca/${encodePathSegments(ca)}`);
}

export function getPkiCertificates(ca = "local"): Promise<ApiResponse> {
  const bad = rejectTraversal(ca);
  if (bad) return Promise.resolve(bad);
  return caddyRequest("GET", `/pki/ca/${encodePathSegments(ca)}/certificates`);
}

/**
 * Compose `/id/<id>` or `/id/<id>/<subpath>`, both halves segment-encoded.
 *
 * Segment-encoded rather than encodeURIComponent'd whole so a "/" in either
 * half keeps the separator meaning it has today -- this fix is about "#" and
 * "?" truncating the URL, not about tightening what counts as one key.
 */
function idPath(id: string, subpath: string): string {
  const encodedId = encodePathSegments(id);
  return subpath ? `/id/${encodedId}/${encodePathSegments(subpath)}` : `/id/${encodedId}`;
}

export function configByIdGet<T = any>(id: string, subpath = ""): Promise<ApiResponse<T>> {
  const badId = rejectTraversal(id);
  if (badId) return Promise.resolve(badId);
  const bad = rejectTraversal(subpath);
  if (bad) return Promise.resolve(bad);
  const path = idPath(id, subpath);
  return caddyRequest("GET", path);
}

export function configByIdSet<T = any>(
  id: string,
  value: unknown,
  method: "POST" | "PATCH" | "PUT" = "PATCH",
  subpath = "",
): Promise<ApiResponse<T>> {
  const badId = rejectTraversal(id);
  if (badId) return Promise.resolve(badId);
  const bad = rejectTraversal(subpath);
  if (bad) return Promise.resolve(bad);
  const path = idPath(id, subpath);
  return caddyRequest(method, path, value);
}

export function configByIdDelete<T = any>(id: string, subpath = ""): Promise<ApiResponse<T>> {
  const badId = rejectTraversal(id);
  if (badId) return Promise.resolve(badId);
  const bad = rejectTraversal(subpath);
  if (bad) return Promise.resolve(bad);
  const path = idPath(id, subpath);
  return caddyRequest("DELETE", path);
}

export function getMetrics(): Promise<ApiResponse> {
  return caddyRequest("GET", "/metrics");
}
