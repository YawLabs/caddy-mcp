import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("api", () => {
  const originalFetch = globalThis.fetch;
  const savedUrl = process.env.CADDY_ADMIN_URL;
  const savedToken = process.env.CADDY_API_TOKEN;

  beforeEach(() => {
    delete process.env.CADDY_ADMIN_URL;
    delete process.env.CADDY_API_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedUrl !== undefined) {
      process.env.CADDY_ADMIN_URL = savedUrl;
    } else {
      delete process.env.CADDY_ADMIN_URL;
    }
    if (savedToken !== undefined) {
      process.env.CADDY_API_TOKEN = savedToken;
    } else {
      delete process.env.CADDY_API_TOKEN;
    }
  });

  it("uses default URL when CADDY_ADMIN_URL is not set", async () => {
    const api = await import("../api.js");
    let calledUrl = "";
    globalThis.fetch = vi.fn(async (url: any) => {
      calledUrl = url.toString();
      return new Response("{}", { status: 200 });
    }) as any;

    await api.configGet();
    expect(calledUrl).toContain("localhost:2019");
  });

  it("uses custom URL from CADDY_ADMIN_URL", async () => {
    process.env.CADDY_ADMIN_URL = "http://caddy.local:9999";
    const api = await import("../api.js");
    let calledUrl = "";
    globalThis.fetch = vi.fn(async (url: any) => {
      calledUrl = url.toString();
      return new Response("{}", { status: 200 });
    }) as any;

    await api.configGet();
    expect(calledUrl).toContain("caddy.local:9999");
  });

  it("includes auth header when CADDY_API_TOKEN is set", async () => {
    process.env.CADDY_API_TOKEN = "test-token-123";
    const api = await import("../api.js");
    let capturedHeaders: any = {};
    globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
      capturedHeaders = opts.headers;
      return new Response("{}", { status: 200 });
    }) as any;

    await api.configGet();
    expect(capturedHeaders.Authorization).toBe("Bearer test-token-123");
  });

  it("handles connection refused gracefully", async () => {
    const api = await import("../api.js");
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as any;

    const res = await api.configGet();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Cannot connect");
  });

  it("handles HTTP errors", async () => {
    const api = await import("../api.js");
    globalThis.fetch = vi.fn(async () => {
      return new Response("Not Found", { status: 404 });
    }) as any;

    const res = await api.configGet("nonexistent/path");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});
