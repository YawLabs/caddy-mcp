import { request as httpRequest } from "node:http";

const DEFAULT_URL = "http://localhost:2019";
const TIMEOUT = 10000;
const RETRY_BASE_MS = 100;
const RETRY_MAX_DELAY_MS = 2000;
const RETRY_MAX_JITTER_MS = 50;
const RETRY_HARD_CAP = 5;

export interface ApiResponse<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  etag?: string;
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

/** Retry network failures (status 0) and 5xx. Never 4xx, including 412 (concurrency). */
function isTransientFailure(res: ApiResponse): boolean {
  if (res.ok) return false;
  if (res.status === 0) return true;
  if (res.status >= 500 && res.status <= 599) return true;
  return false;
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

/** Matches a trailing array index, e.g. ".../routes/0" -- the shape Caddy PUT inserts at. */
const ARRAY_INDEX_TAIL_RE = /\/\d+$/;

/**
 * Whether a (method, path) pair is safe to retry on a transient failure.
 *
 * GET / PATCH / DELETE are idempotent on every Caddy admin endpoint --
 * replaying them yields the same end state, so they always retry under the
 * normal transient-failure policy.
 *
 * PUT is idempotent only when the destination is NOT an array position. Caddy's
 * PUT semantics are "insert at a position in an array, strictly create
 * otherwise" -- so a PUT to `.../routes/0` that succeeded server-side but lost
 * its response (status 0), or 5xx'd after committing, would insert a SECOND
 * element on replay. That is the same silent-duplicate hazard the POST carve-out
 * below exists to prevent, so PUT to an array-index path skips the retry loop.
 * A config key that is literally numeric (a server named "0") is a false
 * positive here; the cost is one un-retried request, versus a duplicated route
 * if we guessed the other way.
 *
 * POST is split by path:
 *  - `/config/<path>` and `/id/<id>` are non-idempotent: they append to
 *    arrays (e.g. routes) or create new keys. On a network failure (status 0)
 *    the request may already have been processed server-side; retrying
 *    produces a duplicate append. On a 5xx, the server may have completed
 *    the mutation before erroring downstream. Either way, retry risks a
 *    silent duplicate -- skip the loop and surface the failure verbatim.
 *  - `/load` is an atomic full-config replace: same input yields the same
 *    end state, so retry is safe and is genuinely useful against a flaky
 *    server during a large config push.
 *  - `/adapt` is a pure transformation (Caddyfile/etc -> JSON) with no
 *    side effects.
 *  - `/stop` is destructive but a second call against an already-stopped
 *    server is a no-op (it just yields ECONNREFUSED), so retry is benign.
 */
function isRetryableMethod(method: string, path: string): boolean {
  if (method === "PUT") return !ARRAY_INDEX_TAIL_RE.test(path);
  if (method !== "POST") return true;
  return !path.startsWith("/config/") && !path.startsWith("/id/");
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
  timeout?: number,
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
  let attempt = 0;
  let res: ApiResponse<T> = await attemptRequest<T>(method, path, body, contentType, timeout, rawStringBody);
  while (isRetryableMethod(method, path) && isTransientFailure(res) && attempt < maxRetries) {
    attempt++;
    const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    const delay = backoff + Math.random() * RETRY_MAX_JITTER_MS;
    await sleep(delay);
    res = await attemptRequest<T>(method, path, body, contentType, timeout, rawStringBody);
  }
  return res;
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
 * Errors reject rather than resolve, so attemptRequest's existing catch block
 * does the classification for both transports. The timeout rejection carries
 * the literal word "timeout" because that catch matches on it.
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
    // AbortSignal.timeout, not req.setTimeout: setTimeout is an INACTIVITY
    // timer, so a response that trickles bytes steadily would never fire it,
    // while the fetch path below aborts on an absolute deadline. Using the same
    // signal here keeps CADDY_TIMEOUT / CADDY_LOAD_TIMEOUT meaning one thing on
    // both transports. The resulting AbortError message contains "aborted",
    // which attemptRequest's catch already classifies as a timeout.
    const req = httpRequest({ socketPath, path, method, headers, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
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
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Send one request over TCP via the global fetch. */
async function sendViaFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    ok: res.ok,
    status: res.status,
    text: await res.text(),
    etag: res.headers.get("ETag") || undefined,
  };
}

async function attemptRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
  timeout?: number,
  rawStringBody = false,
): Promise<ApiResponse<T>> {
  const socketPath = getUnixSocketPath();
  const url = `${getBaseUrl()}${path}`;
  const effectiveTimeout = timeout ?? getRequestTimeout();
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
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T, etag };
    } catch {
      return { ok: true, status: res.status, data: text as T, etag };
    }
  } catch (err: unknown) {
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
    if (msg.includes("abort") || msg.includes("timeout")) {
      return { ok: false, status: 0, error: `Request timed out after ${effectiveTimeout}ms` };
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
  if (raw === undefined) return 60000;
  const n = Number(raw);
  // Reject anything that floors below 1ms -- "0.5" passes n>0 but Math.floor(0.5)=0
  // would produce an immediate-abort timeout. Floor first, then bounds-check.
  if (!Number.isFinite(n)) return 60000;
  const floored = Math.floor(n);
  if (floored < 1) return 60000;
  return floored;
}

export async function loadConfig(config: unknown, contentType?: string): Promise<ApiResponse> {
  const res = await caddyRequest("POST", "/load", config, contentType, getLoadTimeout(), true);
  if (res.ok) etagCache.clear();
  return res;
}

export function adapt<T = any>(config: string, adapter = "caddyfile"): Promise<ApiResponse<T>> {
  return caddyRequest<T>("POST", "/adapt", config, `text/${adapter}`, undefined, true);
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
