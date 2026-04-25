import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("api", () => {
  const originalFetch = globalThis.fetch;
  const savedUrl = process.env.CADDY_ADMIN_URL;
  const savedToken = process.env.CADDY_API_TOKEN;
  const savedRetries = process.env.CADDY_MAX_RETRIES;

  beforeEach(() => {
    delete process.env.CADDY_ADMIN_URL;
    delete process.env.CADDY_API_TOKEN;
    // Disable retries by default so existing tests run in a single attempt.
    process.env.CADDY_MAX_RETRIES = "0";
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
    if (savedRetries !== undefined) {
      process.env.CADDY_MAX_RETRIES = savedRetries;
    } else {
      delete process.env.CADDY_MAX_RETRIES;
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

  describe("retry behavior", () => {
    it("retries transient 5xx up to CADDY_MAX_RETRIES times", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
    });

    it("retries network errors (fetch failed)", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 2) throw new TypeError("fetch failed");
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(true);
      expect(calls).toBe(2);
    });

    it("does not retry 4xx errors", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("bad request", { status: 400 });
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(false);
      expect(res.status).toBe(400);
      expect(calls).toBe(1);
    });

    it("does not retry 412 (concurrency conflict)", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("precondition failed", { status: 412 });
      }) as any;

      const res = await api.configPatch("apps/http", {});
      expect(res.ok).toBe(false);
      expect(res.status).toBe(412);
      expect(calls).toBe(1);
    });

    it("gives up after CADDY_MAX_RETRIES when error persists", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("still down", { status: 503 });
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(false);
      expect(res.status).toBe(503);
      expect(calls).toBe(3);
    });

    it("CADDY_MAX_RETRIES=0 disables retries", async () => {
      process.env.CADDY_MAX_RETRIES = "0";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("down", { status: 503 });
      }) as any;

      await api.configGet();
      expect(calls).toBe(1);
    });

    it("caps retries at hard limit even if env is higher", async () => {
      process.env.CADDY_MAX_RETRIES = "1000";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("down", { status: 503 });
      }) as any;

      await api.configGet();
      // Hard-capped at 5 retries = 6 attempts total, with per-retry delay capped at 2000ms
      expect(calls).toBe(6);
    }, 15000);

    it("treats non-numeric CADDY_MAX_RETRIES as default (2)", async () => {
      process.env.CADDY_MAX_RETRIES = "not-a-number";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("down", { status: 503 });
      }) as any;

      await api.configGet();
      expect(calls).toBe(3);
    });
  });

  describe("path traversal rejection", () => {
    it("rejects .. in configGet path without hitting fetch", async () => {
      const api = await import("../api.js");
      let called = 0;
      globalThis.fetch = vi.fn(async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configGet("../load");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("'..'");
      expect(called).toBe(0);
    });

    it("rejects .. in configPost, configPut, configPatch, configDelete", async () => {
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;

      for (const call of [
        api.configPost("apps/../stop", {}),
        api.configPut("apps/../load", {}),
        api.configPatch("apps/../stop", {}),
        api.configDelete("apps/../config"),
      ]) {
        const res = await call;
        expect(res.ok).toBe(false);
        expect(res.error).toContain("'..'");
      }
    });

    it("rejects .. in configById subpath", async () => {
      const api = await import("../api.js");
      let called = 0;
      globalThis.fetch = vi.fn(async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configByIdGet("my-route", "../../load");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("'..'");
      expect(called).toBe(0);
    });

    it("allows legitimate paths with .. as a substring of a segment", async () => {
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;

      // ".." only matches as a full path segment — substrings are fine.
      const res = await api.configGet("apps/http/servers/my..name");
      expect(res.ok).toBe(true);
    });
  });
});
