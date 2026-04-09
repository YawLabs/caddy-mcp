const DEFAULT_URL = "http://localhost:2019";
const TIMEOUT = 10000;

export interface ApiResponse<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

function getBaseUrl(): string {
  return (process.env.CADDY_ADMIN_URL || DEFAULT_URL).replace(/\/+$/, "");
}

function getHeaders(contentType = "application/json"): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  const token = process.env.CADDY_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Normalize config path — strip leading /config/ or / if present */
function normalizePath(path: string): string {
  return path.replace(/^\/?(config\/?)?/, "");
}

async function caddyRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
): Promise<ApiResponse<T>> {
  const url = `${getBaseUrl()}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: getHeaders(contentType),
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text || `HTTP ${res.status}` };
    }
    if (!text) return { ok: true, status: res.status };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { ok: true, status: res.status, data: text as T };
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
      return { ok: false, status: 0, error: `Request timed out after ${TIMEOUT}ms` };
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

export function loadConfig(config: unknown): Promise<ApiResponse> {
  return caddyRequest("POST", "/load", config);
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
