const DEFAULT_URL = "http://localhost:2019";
const TIMEOUT = 10000;

export interface ApiResponse<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  etag?: string;
}

/** Cache of path → ETag from successful config GETs, used for optimistic concurrency */
const etagCache = new Map<string, string>();

function getBaseUrl(): string {
  return (process.env.CADDY_ADMIN_URL || DEFAULT_URL).replace(/\/+$/, "");
}

function getHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  const token = process.env.CADDY_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Normalize config path — strip leading /config/ or / if present */
function normalizePath(path: string): string {
  return path.replace(/^\/?(config(\/|$))?/, "");
}

async function caddyRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
  timeout?: number,
): Promise<ApiResponse<T>> {
  const url = `${getBaseUrl()}${path}`;
  const effectiveTimeout = timeout ?? TIMEOUT;
  try {
    const hasBody = body !== undefined;
    const headers = getHeaders(hasBody ? contentType || "application/json" : undefined);

    // Send If-Match on config writes when we have a cached ETag for this path
    const isWrite = method !== "GET";
    if (isWrite && path.startsWith("/config/")) {
      const cachedEtag = etagCache.get(path);
      if (cachedEtag) headers["If-Match"] = cachedEtag;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(effectiveTimeout),
    });
    const text = await res.text();

    // Capture ETag from config GET responses
    const etag = res.headers.get("ETag") || undefined;
    if (method === "GET" && etag && path.startsWith("/config/")) {
      etagCache.set(path, etag);
    }

    // Invalidate cached ETags after successful config writes
    if (isWrite && res.ok && path.startsWith("/config/")) {
      etagCache.delete(path);
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
      return { ok: false, status: res.status, error: text || `HTTP ${res.status}` };
    }
    if (!text) return { ok: true, status: res.status, etag };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T, etag };
    } catch {
      return { ok: true, status: res.status, data: text as T, etag };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      return {
        ok: false,
        status: 0,
        error: `Cannot connect to Caddy admin API at ${getBaseUrl()} — is Caddy running?`,
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
  return caddyRequest("GET", `/config/${normalized}`);
}

export function configPost<T = any>(path: string, value: unknown): Promise<ApiResponse<T>> {
  const normalized = normalizePath(path);
  return caddyRequest("POST", `/config/${normalized}`, value);
}

export function configPut<T = any>(path: string, value: unknown): Promise<ApiResponse<T>> {
  const normalized = normalizePath(path);
  return caddyRequest("PUT", `/config/${normalized}`, value);
}

export function configPatch<T = any>(path: string, value: unknown): Promise<ApiResponse<T>> {
  const normalized = normalizePath(path);
  return caddyRequest("PATCH", `/config/${normalized}`, value);
}

export function configDelete<T = any>(path: string): Promise<ApiResponse<T>> {
  const normalized = normalizePath(path);
  return caddyRequest("DELETE", `/config/${normalized}`);
}

const LOAD_TIMEOUT = 60000;

export async function loadConfig(config: unknown, contentType?: string): Promise<ApiResponse> {
  const res = await caddyRequest("POST", "/load", config, contentType, LOAD_TIMEOUT);
  if (res.ok) etagCache.clear();
  return res;
}

export function adapt(config: string, adapter = "caddyfile"): Promise<ApiResponse> {
  return caddyRequest("POST", "/adapt", config, `text/${adapter}`);
}

export function stop(): Promise<ApiResponse> {
  return caddyRequest("POST", "/stop");
}

export function getUpstreams(): Promise<ApiResponse> {
  return caddyRequest("GET", "/reverse_proxy/upstreams");
}

export function getPki(ca = "local"): Promise<ApiResponse> {
  return caddyRequest("GET", `/pki/ca/${ca}`);
}

export function getPkiCertificates(ca = "local"): Promise<ApiResponse> {
  return caddyRequest("GET", `/pki/ca/${ca}/certificates`);
}

export function configByIdGet<T = any>(id: string, subpath = ""): Promise<ApiResponse<T>> {
  const path = subpath ? `/id/${id}/${subpath}` : `/id/${id}`;
  return caddyRequest("GET", path);
}

export function configByIdSet<T = any>(
  id: string,
  value: unknown,
  method: "POST" | "PATCH" | "PUT" = "PATCH",
  subpath = "",
): Promise<ApiResponse<T>> {
  const path = subpath ? `/id/${id}/${subpath}` : `/id/${id}`;
  return caddyRequest(method, path, value);
}

export function configByIdDelete<T = any>(id: string, subpath = ""): Promise<ApiResponse<T>> {
  const path = subpath ? `/id/${id}/${subpath}` : `/id/${id}`;
  return caddyRequest("DELETE", path);
}

export function getMetrics(): Promise<ApiResponse> {
  return caddyRequest("GET", "/metrics");
}
