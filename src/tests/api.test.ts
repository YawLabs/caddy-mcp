import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("api", () => {
  const originalFetch = globalThis.fetch;
  const savedUrl = process.env.CADDY_ADMIN_URL;
  const savedToken = process.env.CADDY_API_TOKEN;
  const savedRetries = process.env.CADDY_MAX_RETRIES;
  const savedLoadTimeout = process.env.CADDY_LOAD_TIMEOUT;

  beforeEach(() => {
    delete process.env.CADDY_ADMIN_URL;
    delete process.env.CADDY_API_TOKEN;
    delete process.env.CADDY_LOAD_TIMEOUT;
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
    if (savedLoadTimeout !== undefined) {
      process.env.CADDY_LOAD_TIMEOUT = savedLoadTimeout;
    } else {
      delete process.env.CADDY_LOAD_TIMEOUT;
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

    it("warns once on stderr when CADDY_MAX_RETRIES exceeds the hard cap", async () => {
      // Fresh module so the per-process warn-once flag isn't already tripped
      // by a sibling test that ran 1000-retries earlier.
      vi.resetModules();
      process.env.CADDY_MAX_RETRIES = "999";
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const api = await import("../api.js");
        globalThis.fetch = vi.fn(async () => new Response("down", { status: 503 })) as any;

        // Two requests -- the warning must fire only on the first.
        await api.configGet();
        await api.configGet();

        const calls = errSpy.mock.calls.map((c) => String(c[0]));
        const clampWarnings = calls.filter((c) => c.includes("CADDY_MAX_RETRIES=999"));
        expect(clampWarnings).toHaveLength(1);
        expect(clampWarnings[0]).toContain("exceeds hard cap");
      } finally {
        errSpy.mockRestore();
      }
    }, 15000);

    it("does not warn when CADDY_MAX_RETRIES is within the hard cap", async () => {
      vi.resetModules();
      process.env.CADDY_MAX_RETRIES = "3";
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const api = await import("../api.js");
        globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;

        await api.configGet();

        const clampWarnings = errSpy.mock.calls.map((c) => String(c[0])).filter((c) => c.includes("exceeds hard cap"));
        expect(clampWarnings).toHaveLength(0);
      } finally {
        errSpy.mockRestore();
      }
    });

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

    // POST against /config/<path> and /id/<id> is non-idempotent: it appends
    // to arrays or creates new keys. A retry after a server-side
    // success-but-lost-response would silently duplicate the write. Skip the
    // retry loop for those paths and surface the failure verbatim.
    it("does NOT retry POST to /config/<path> on 5xx", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("upstream down", { status: 503 });
      }) as any;

      const res = await api.configPost("apps/http/servers/srv0/routes", {});
      expect(res.ok).toBe(false);
      expect(res.status).toBe(503);
      expect(calls).toBe(1);
    });

    it("does NOT retry POST to /config/<path> on network error (status 0)", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        throw new TypeError("fetch failed");
      }) as any;

      const res = await api.configPost("apps/http/servers/srv0/routes", {});
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(calls).toBe(1);
    });

    it("does NOT retry POST to /id/<id> on 5xx (non-idempotent append/create)", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("upstream down", { status: 503 });
      }) as any;

      const res = await api.configByIdSet("my-route", { handle: [] }, "POST");
      expect(res.ok).toBe(false);
      expect(res.status).toBe(503);
      expect(calls).toBe(1);
    });

    // POST to /load is an atomic full-config replace -- same input yields the
    // same end state. Retrying on a flaky server is safe and useful.
    it("retries POST to /load on 5xx (idempotent full-config replace)", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response("", { status: 200 });
      }) as any;

      const res = await api.loadConfig({ apps: {} }, "application/json");
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
    });

    // POST to /adapt is a pure transformation (Caddyfile/etc -> JSON), no side
    // effects, safe to retry.
    it("retries POST to /adapt on 5xx (pure transformation)", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response('{"result":{}}', { status: 200 });
      }) as any;

      const res = await api.adapt("example.com { }");
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
    });

    it("still retries PATCH on 5xx (idempotent method)", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configPatch("apps/http/servers/srv0", { listen: [":443"] });
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
    });

    it("still retries DELETE on 5xx (idempotent method)", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response("", { status: 200 });
      }) as any;

      const res = await api.configDelete("apps/http/servers/srv0/routes/0");
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
    });

    it("still retries PUT on 5xx (idempotent method)", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response("", { status: 200 });
      }) as any;

      const res = await api.configPut("apps/http/servers/srv0/routes/0", {});
      expect(res.ok).toBe(true);
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

      // ".." only matches as a full path segment -- substrings are fine.
      const res = await api.configGet("apps/http/servers/my..name");
      expect(res.ok).toBe(true);
    });

    it("rejects .. in configByIdGet id without hitting fetch", async () => {
      const api = await import("../api.js");
      let called = 0;
      globalThis.fetch = vi.fn(async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configByIdGet("../load");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("'..'");
      expect(called).toBe(0);
    });

    it("rejects .. in configByIdSet id without hitting fetch", async () => {
      const api = await import("../api.js");
      let called = 0;
      globalThis.fetch = vi.fn(async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configByIdSet("../load", {});
      expect(res.ok).toBe(false);
      expect(res.error).toContain("'..'");
      expect(called).toBe(0);
    });

    it("rejects .. in configByIdDelete id without hitting fetch", async () => {
      const api = await import("../api.js");
      let called = 0;
      globalThis.fetch = vi.fn(async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configByIdDelete("../load");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("'..'");
      expect(called).toBe(0);
    });

    it("rejects .. in getPki ca arg without hitting fetch", async () => {
      const api = await import("../api.js");
      let called = 0;
      globalThis.fetch = vi.fn(async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.getPki("../stop");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("'..'");
      expect(called).toBe(0);
    });

    it("rejects .. in getPkiCertificates ca arg without hitting fetch", async () => {
      const api = await import("../api.js");
      let called = 0;
      globalThis.fetch = vi.fn(async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.getPkiCertificates("../stop");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("'..'");
      expect(called).toBe(0);
    });
  });

  describe("ETag cache refresh on writes", () => {
    it("refreshes cached ETag from a successful write response and uses it on the next chained write", async () => {
      const api = await import("../api.js");
      // Use a unique path so prior tests don't leak cache state.
      const target = "etag-refresh-target";
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "etag-1" } });
        }
        if (calls.length === 2) {
          // First PATCH -- return new ETag for refresh.
          return new Response("", { status: 200, headers: { ETag: "etag-2" } });
        }
        // Subsequent writes -- echo back so we can inspect headers.
        return new Response("", { status: 200 });
      }) as any;

      // Prime cache with a GET.
      const getRes = await api.configGet(target);
      expect(getRes.ok).toBe(true);

      // First PATCH -- should send If-Match: etag-1, then refresh to etag-2.
      const patch1 = await api.configPatch(target, { foo: 1 });
      expect(patch1.ok).toBe(true);

      // Second PATCH -- should send If-Match: etag-2 (refreshed from previous response).
      const patch2 = await api.configPatch(target, { foo: 2 });
      expect(patch2.ok).toBe(true);

      expect(calls).toHaveLength(3);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[1]?.method).toBe("PATCH");
      expect(calls[1]?.ifMatch).toBe("etag-1");
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.ifMatch).toBe("etag-2");
    });

    it("refreshes cached ETag from a successful PUT and uses it on the next chained write", async () => {
      const api = await import("../api.js");
      const target = "etag-put-refresh-target";
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "put-etag-1" } });
        }
        if (method === "PUT") {
          return new Response("", { status: 200, headers: { ETag: "put-etag-2" } });
        }
        // Follow-up PATCH -- echo back so we can inspect headers.
        return new Response("", { status: 200 });
      }) as any;

      // Prime cache with a GET.
      await api.configGet(target);

      // PUT -- should send If-Match: put-etag-1, then refresh to put-etag-2.
      const putRes = await api.configPut(target, { foo: 1 });
      expect(putRes.ok).toBe(true);

      // Chained PATCH -- should send If-Match: put-etag-2 (refreshed from PUT response).
      const patchRes = await api.configPatch(target, { foo: 2 });
      expect(patchRes.ok).toBe(true);

      expect(calls).toHaveLength(3);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[1]?.method).toBe("PUT");
      expect(calls[1]?.ifMatch).toBe("put-etag-1");
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.ifMatch).toBe("put-etag-2");
    });

    it("invalidates cache after a successful POST, even if response carries an ETag", async () => {
      const api = await import("../api.js");
      const target = "etag-post-invalidate-target";
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "post-etag-1" } });
        }
        if (method === "POST") {
          // POST returns an ETag, but it may describe the parent/root config --
          // policy says invalidate, don't trust it for the path-resource.
          return new Response("", { status: 200, headers: { ETag: "post-etag-bogus" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      // Prime cache with a GET.
      await api.configGet(target);

      // POST -- sends If-Match: post-etag-1, then cache should be invalidated
      // regardless of the returned ETag.
      const postRes = await api.configPost(target, { foo: 1 });
      expect(postRes.ok).toBe(true);

      // Follow-up PATCH at the same path -- cache empty, no If-Match.
      const patchRes = await api.configPatch(target, { foo: 2 });
      expect(patchRes.ok).toBe(true);

      expect(calls).toHaveLength(3);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[1]?.method).toBe("POST");
      expect(calls[1]?.ifMatch).toBe("post-etag-1");
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.ifMatch).toBe(null);
    });

    it("invalidates cache after a successful DELETE", async () => {
      const api = await import("../api.js");
      const target = "etag-delete-invalidate-target";
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "delete-etag-1" } });
        }
        if (method === "DELETE") {
          // Even if DELETE returns an ETag, the resource is gone -- invalidate.
          return new Response("", { status: 200, headers: { ETag: "delete-etag-bogus" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      // Prime cache with a GET.
      await api.configGet(target);

      // DELETE -- sends If-Match: delete-etag-1, then cache should be invalidated.
      const delRes = await api.configDelete(target);
      expect(delRes.ok).toBe(true);

      // Follow-up PATCH at the same path -- cache empty, no If-Match.
      const patchRes = await api.configPatch(target, { foo: 1 });
      expect(patchRes.ok).toBe(true);

      expect(calls).toHaveLength(3);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[1]?.method).toBe("DELETE");
      expect(calls[1]?.ifMatch).toBe("delete-etag-1");
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.ifMatch).toBe(null);
    });

    it("invalidates cache when a successful write returns no ETag", async () => {
      const api = await import("../api.js");
      const target = "etag-no-header-target";
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "etag-only-on-get" } });
        }
        // Writes return 200 OK with no ETag header.
        return new Response("", { status: 200 });
      }) as any;

      // Prime cache.
      await api.configGet(target);

      // First PATCH -- should send If-Match: etag-only-on-get, response has no ETag -> cache cleared.
      await api.configPatch(target, { foo: 1 });

      // Second PATCH -- cache is empty, no If-Match should be sent.
      await api.configPatch(target, { foo: 2 });

      expect(calls).toHaveLength(3);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[1]?.method).toBe("PATCH");
      expect(calls[1]?.ifMatch).toBe("etag-only-on-get");
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.ifMatch).toBe(null);
    });
  });

  describe("CADDY_LOAD_TIMEOUT", () => {
    it("defaults to 60000 when env unset", async () => {
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as any;

      await api.loadConfig({});
      expect(timeoutSpy).toHaveBeenCalledWith(60000);
      timeoutSpy.mockRestore();
    });

    it("uses custom value from CADDY_LOAD_TIMEOUT", async () => {
      process.env.CADDY_LOAD_TIMEOUT = "30000";
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as any;

      await api.loadConfig({});
      expect(timeoutSpy).toHaveBeenCalledWith(30000);
      timeoutSpy.mockRestore();
    });

    it.each([
      "not-a-number",
      "0",
      "-100",
      "0.5",
      "0.999",
    ])("falls back to 60000 for invalid value %p", async (invalid) => {
      process.env.CADDY_LOAD_TIMEOUT = invalid;
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as any;

      await api.loadConfig({});
      expect(timeoutSpy).toHaveBeenCalledWith(60000);
      timeoutSpy.mockRestore();
    });
  });
});
