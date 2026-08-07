import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("api", () => {
  const originalFetch = globalThis.fetch;
  const savedUrl = process.env.CADDY_ADMIN_URL;
  const savedToken = process.env.CADDY_API_TOKEN;
  const savedRetries = process.env.CADDY_MAX_RETRIES;
  const savedLoadTimeout = process.env.CADDY_LOAD_TIMEOUT;
  const savedTimeout = process.env.CADDY_TIMEOUT;

  beforeEach(() => {
    delete process.env.CADDY_ADMIN_URL;
    delete process.env.CADDY_API_TOKEN;
    delete process.env.CADDY_LOAD_TIMEOUT;
    delete process.env.CADDY_TIMEOUT;
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
    if (savedTimeout !== undefined) {
      process.env.CADDY_TIMEOUT = savedTimeout;
    } else {
      delete process.env.CADDY_TIMEOUT;
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

  it("hints at CADDY_API_TOKEN on an empty-body 401", async () => {
    const api = await import("../api.js");
    globalThis.fetch = vi.fn(async () => new Response("", { status: 401 })) as any;

    const res = await api.configGet();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error).toContain("CADDY_API_TOKEN");
  });

  it("does not add the token hint when the error body is non-empty", async () => {
    const api = await import("../api.js");
    globalThis.fetch = vi.fn(async () => new Response("forbidden by policy", { status: 403 })) as any;

    const res = await api.configGet();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("forbidden by policy");
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

    it("still retries PUT to a non-array path on 5xx (idempotent there)", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response("", { status: 200 });
      }) as any;

      const res = await api.configPut("apps/http/servers/srv0", {});
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
    });

    // Caddy PUT INSERTS when the destination is a position in an array. A
    // replay after a success-but-lost-response would add a second element --
    // the same silent-duplicate hazard that excludes POST to /config/.
    it("does NOT retry PUT at an array-index path on 5xx", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("upstream down", { status: 503 });
      }) as any;

      const res = await api.configPut("apps/http/servers/srv0/routes/0", {});
      expect(res.ok).toBe(false);
      expect(res.status).toBe(503);
      expect(calls).toBe(1);
    });

    it("does NOT retry PUT at an array-index path on a network error (status 0)", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        throw new TypeError("fetch failed");
      }) as any;

      const res = await api.configPut("apps/http/servers/srv0/routes/2", {});
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(calls).toBe(1);
    });

    it("does NOT retry PUT at an /id/ subpath array index", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("upstream down", { status: 503 });
      }) as any;

      const res = await api.configByIdSet("my-route", {}, "PUT", "handle/0");
      expect(res.ok).toBe(false);
      expect(calls).toBe(1);
    });

    // No array-index tail, so the carve-out doesn't apply and the retry loop
    // runs. (Separately: the TOOLS use PATCH for @id replaces -- PUT at /id/
    // inserts a duplicate. This test is about the retry policy, not the verb.)
    it("still retries PUT to /id/<id> with no subpath", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response("", { status: 200 });
      }) as any;

      const res = await api.configByIdSet("my-route", { handle: [] }, "PUT");
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

    it("invalidates ancestor entries on a successful child write", async () => {
      // GET parent caches its ETag. A subsequent child write invalidates the
      // parent so the next write to the parent path doesn't send a stale
      // If-Match and 412 spuriously.
      const api = await import("../api.js");
      const parent = "ancestor-parent";
      const child = "ancestor-parent/child";
      const calls: Array<{ method: string; path: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, path, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "parent-etag-1" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet(parent);
      await api.configPatch(child, { foo: 1 });
      await api.configPatch(parent, { foo: 2 });

      expect(calls).toHaveLength(3);
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.path).toBe(`/config/${parent}`);
      expect(calls[2]?.ifMatch).toBe(null);
    });

    it("invalidates descendant entries on a successful parent write", async () => {
      // GET child caches its ETag. A subsequent parent write invalidates the
      // child cache because the parent overwrote (or could have overwritten)
      // the child sub-tree.
      const api = await import("../api.js");
      const parent = "descendant-parent";
      const child = "descendant-parent/child";
      const calls: Array<{ method: string; path: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, path, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "child-etag-1" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet(child);
      await api.configPatch(parent, { foo: 1 });
      await api.configPatch(child, { foo: 2 });

      expect(calls).toHaveLength(3);
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.path).toBe(`/config/${child}`);
      expect(calls[2]?.ifMatch).toBe(null);
    });

    it("invalidates /config/ entries on an /id/ write (cross-namespace)", async () => {
      // GET a /config/ path caches its ETag. A subsequent /id/ write could
      // affect any sub-tree of /config/, so all /config/ entries must drop.
      const api = await import("../api.js");
      const configPath = "cross-ns-config-path";
      const calls: Array<{ method: string; path: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, path, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "config-etag-1" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet(configPath);
      await api.configByIdSet("some-id", { handle: [] }, "PATCH");
      await api.configPatch(configPath, { foo: 1 });

      expect(calls).toHaveLength(3);
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.path).toBe(`/config/${configPath}`);
      expect(calls[2]?.ifMatch).toBe(null);
    });

    it("invalidates /id/ entries on a /config/ write (cross-namespace)", async () => {
      // GET /id/<id> caches its ETag. A subsequent /config/ write may have
      // modified the @id-tagged resource indirectly, so drop the /id/ entry.
      const api = await import("../api.js");
      const calls: Array<{ method: string; path: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, path, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "id-etag-1" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      await api.configByIdGet("my-id");
      await api.configPatch("apps/http/servers/srv0", { listen: [":443"] });
      await api.configByIdSet("my-id", { handle: [] }, "PATCH");

      expect(calls).toHaveLength(3);
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.path).toBe("/id/my-id");
      expect(calls[2]?.ifMatch).toBe(null);
    });

    it("invalidates the root /config/ entry on a descendant write", async () => {
      // configGet("") caches under the key "/config/", which already ends in a
      // slash. The ancestor test must not build "/config//" -- otherwise the
      // root entry survives every child write and a later write to the root
      // path ships a stale If-Match and 412s spuriously.
      const api = await import("../api.js");
      const calls: Array<{ method: string; path: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, path, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "root-etag-1" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      // Prime the cache with a full-config read.
      await api.configGet();
      // A descendant write must drop the cached root entry.
      await api.configPatch("apps/http/servers/srv0", { listen: [":443"] });
      // Writing the root now must NOT carry the pre-child-write ETag.
      await api.configPatch("", { apps: {} });

      expect(calls).toHaveLength(3);
      expect(calls[0]?.path).toBe("/config/");
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.path).toBe("/config/");
      expect(calls[2]?.ifMatch).toBe(null);
    });

    it("does not invalidate a sibling whose path shares a prefix", async () => {
      // "/config/.../srv0" must not be dropped by a write to ".../srv01".
      const api = await import("../api.js");
      const calls: Array<{ method: string; path: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, path, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "sibling-etag-1" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet("prefix-siblings/srv0");
      await api.configPatch("prefix-siblings/srv01", { listen: [":80"] });
      await api.configPatch("prefix-siblings/srv0", { listen: [":443"] });

      expect(calls[2]?.ifMatch).toBe("sibling-etag-1");
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

  describe("412 handling", () => {
    it("returns the friendly Precondition Failed message on 412 and invalidates the cached ETag", async () => {
      // A 412 should: (a) surface a user-actionable message that names the
      // condition and tells the caller what to do, AND (b) clear the stale
      // cached ETag so the next attempt isn't doomed to repeat the failure.
      const api = await import("../api.js");
      const target = "412-target-path";
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      let patchCount = 0;
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "stale-etag" } });
        }
        patchCount++;
        if (patchCount === 1) return new Response("precondition failed", { status: 412 });
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet(target);
      const first = await api.configPatch(target, { foo: 1 });
      expect(first.ok).toBe(false);
      expect(first.status).toBe(412);
      expect(first.error).toContain("Config has been modified");
      expect(first.error).toContain("HTTP 412");
      expect(first.error).toContain("Re-read");

      // Cache was cleared by the 412 path -- the retry should send no If-Match.
      const second = await api.configPatch(target, { foo: 2 });
      expect(second.ok).toBe(true);
      expect(calls).toHaveLength(3);
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.ifMatch).toBe(null);
    });
  });

  describe("loadConfig cache behavior", () => {
    it("clears the full ETag cache on a successful /load", async () => {
      // /load atomically replaces the full config, so every cached ETag (from
      // any prior GET) is now potentially stale. loadConfig must wipe the cache
      // wholesale, not just the entry for /load.
      const api = await import("../api.js");
      const target = "loadconfig-clears-cache-target";
      const calls: Array<{ method: string; path: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        const ifMatch = opts?.headers?.["If-Match"] ?? null;
        calls.push({ method, path, ifMatch });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "pre-load-etag" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      // Prime cache with a GET on an unrelated config path.
      await api.configGet(target);
      // Successful /load -- should clear everything.
      const loadRes = await api.loadConfig({ apps: {} });
      expect(loadRes.ok).toBe(true);
      // Next write at the same path -- no If-Match because cache was wiped.
      const patchRes = await api.configPatch(target, { foo: 1 });
      expect(patchRes.ok).toBe(true);

      expect(calls).toHaveLength(3);
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.path).toBe(`/config/${target}`);
      expect(calls[2]?.ifMatch).toBe(null);
    });
  });

  describe("non-JSON response body", () => {
    it("returns the raw text as data when the response body is not JSON", async () => {
      // /metrics returns Prometheus exposition (text/plain). The client must
      // fall through to data:text when JSON.parse throws, not error out.
      const api = await import("../api.js");
      const promBody = "# HELP foo a counter\n# TYPE foo counter\nfoo 1\n";
      globalThis.fetch = vi.fn(async () => new Response(promBody, { status: 200 })) as any;

      const res = await api.getMetrics();
      expect(res.ok).toBe(true);
      expect(typeof res.data).toBe("string");
      expect(res.data).toBe(promBody);
    });
  });

  describe("retries POST to /stop (safe per policy)", () => {
    it("retries POST to /stop on 5xx (second-call is a no-op against an already-stopped server)", async () => {
      // /stop is documented in isRetryableMethod as benign to retry -- a
      // second call against an already-stopped server is a no-op.
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response("", { status: 200 });
      }) as any;

      const res = await api.stop();
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
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

  describe("CADDY_TIMEOUT", () => {
    it("defaults to 10000 when env unset", async () => {
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;

      await api.configGet();
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
      timeoutSpy.mockRestore();
    });

    it("uses custom value from CADDY_TIMEOUT", async () => {
      process.env.CADDY_TIMEOUT = "5000";
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;

      await api.configGet();
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
      timeoutSpy.mockRestore();
    });

    it.each(["not-a-number", "0", "-100", "0.5"])("falls back to 10000 for invalid value %p", async (invalid) => {
      process.env.CADDY_TIMEOUT = invalid;
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;

      await api.configGet();
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
      timeoutSpy.mockRestore();
    });

    it("does not affect /load, which keeps using CADDY_LOAD_TIMEOUT", async () => {
      process.env.CADDY_TIMEOUT = "5000";
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as any;

      await api.loadConfig({});
      expect(timeoutSpy).toHaveBeenCalledWith(60000);
      timeoutSpy.mockRestore();
    });
  });

  // The CADDY_TIMEOUT / CADDY_LOAD_TIMEOUT tests above assert only the value
  // handed to AbortSignal.timeout. These drive the abort itself, so the mapping
  // from a fired timeout to a legible message is pinned too.
  describe("error classification in the catch block", () => {
    it("maps a fired timeout to the friendly message carrying the effective ms", async () => {
      process.env.CADDY_TIMEOUT = "1234";
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.error).toBe("Request timed out after 1234ms");
    });

    it("reports the /load timeout budget, not the per-request one, when /load aborts", async () => {
      process.env.CADDY_TIMEOUT = "1000";
      process.env.CADDY_LOAD_TIMEOUT = "45000";
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as any;

      const res = await api.loadConfig({ apps: {} });
      expect(res.error).toBe("Request timed out after 45000ms");
    });

    it("surfaces an unrecognized transport error verbatim", async () => {
      // Neither connection-refused nor abort -- the catch-all branch decides
      // whether an unexpected failure is legible or swallowed.
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("socket hang up");
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.error).toBe("socket hang up");
    });

    it("stringifies a non-Error throw", async () => {
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw "bare string failure";
      }) as any;

      const res = await api.configGet();
      expect(res.error).toBe("bare string failure");
    });

    it("falls back to the raw admin URL when it cannot be parsed", async () => {
      // The origin-stripping path is tested elsewhere; this is the branch that
      // runs when CADDY_ADMIN_URL is malformed -- exactly when the user most
      // needs the value echoed back to spot the typo.
      process.env.CADDY_ADMIN_URL = "not a url";
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(false);
      expect(res.error).toContain("not a url");
      expect(res.error).toContain("is Caddy running?");
    });
  });

  describe("base URL normalization", () => {
    it.each([
      "http://caddy.local:2019/",
      "http://caddy.local:2019///",
    ])("strips trailing slashes from CADDY_ADMIN_URL=%p", async (url) => {
      // A trailing slash in the env var would otherwise produce "//config/".
      process.env.CADDY_ADMIN_URL = url;
      const api = await import("../api.js");
      let calledUrl = "";
      globalThis.fetch = vi.fn(async (u: any) => {
        calledUrl = u.toString();
        return new Response("{}", { status: 200 });
      }) as any;

      await api.configGet();
      expect(calledUrl).toBe("http://caddy.local:2019/config/");
    });
  });

  describe("ETag cache bounds", () => {
    it("evicts the oldest entry once the cache exceeds 256 paths", async () => {
      // An agent walking a large config issues hundreds of distinct GETs in one
      // session, so the FIFO drop fires in practice. A bug here either evicts a
      // live entry (spurious 412) or keeps a stale one (lost If-Match).
      const api = await import("../api.js");
      const calls: Array<{ path: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        calls.push({ path, ifMatch: opts?.headers?.["If-Match"] ?? null });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: `etag${path}` } });
        }
        return new Response("", { status: 200 });
      }) as any;

      // 257 distinct sibling paths -- one more than MAX_ETAG_CACHE. Siblings so
      // no ancestor/descendant invalidation fires between them.
      for (let i = 0; i < 257; i++) {
        await api.configGet(`evict-probe/p${i}`);
      }
      calls.length = 0;

      await api.configPatch("evict-probe/p0", { x: 1 });
      await api.configPatch("evict-probe/p256", { x: 1 });

      // Oldest was dropped; newest survived.
      expect(calls[0]?.ifMatch).toBe(null);
      expect(calls[1]?.ifMatch).toBe("etag/config/evict-probe/p256");
    });
  });

  describe("loadConfig failure does not touch the cache", () => {
    it("keeps cached ETags when /load fails", async () => {
      // loadConfig clears the whole cache on success. If that guard were ever
      // dropped, a FAILED load would silently wipe optimistic-concurrency
      // protection and the next write would go out with no If-Match -- a lost
      // update with no error surfaced anywhere.
      const api = await import("../api.js");
      const target = "load-failure-keeps-cache";
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        calls.push({ method, ifMatch: opts?.headers?.["If-Match"] ?? null });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "survives-failed-load" } });
        }
        if (String(url).endsWith("/load")) {
          return new Response("config invalid", { status: 400 });
        }
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet(target);
      const loadRes = await api.loadConfig({ apps: {} });
      expect(loadRes.ok).toBe(false);

      await api.configPatch(target, { foo: 1 });
      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.ifMatch).toBe("survives-failed-load");
    });
  });

  // The URL path IS the entire behavior of these thin wrappers. Handler tests
  // mock the api module wholesale and the traversal tests return before
  // fetching, so without these a typo'd endpoint passes the whole suite.
  describe("endpoint URL composition", () => {
    async function capture(call: (api: typeof import("../api.js")) => Promise<unknown>) {
      const api = await import("../api.js");
      let pathname = "";
      let method = "";
      let contentType: string | undefined;
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        pathname = new URL(String(url)).pathname;
        method = opts?.method ?? "GET";
        contentType = opts?.headers?.["Content-Type"];
        return new Response("{}", { status: 200 });
      }) as any;
      await call(api);
      return { pathname, method, contentType };
    }

    it("getUpstreams reads /reverse_proxy/upstreams", async () => {
      const { pathname, method } = await capture((a) => a.getUpstreams());
      expect(pathname).toBe("/reverse_proxy/upstreams");
      expect(method).toBe("GET");
    });

    it("getMetrics reads /metrics", async () => {
      expect((await capture((a) => a.getMetrics())).pathname).toBe("/metrics");
    });

    it("stop POSTs /stop", async () => {
      const { pathname, method } = await capture((a) => a.stop());
      expect(pathname).toBe("/stop");
      expect(method).toBe("POST");
    });

    it("getPki reads /pki/ca/<ca>, defaulting the CA to 'local'", async () => {
      expect((await capture((a) => a.getPki())).pathname).toBe("/pki/ca/local");
      expect((await capture((a) => a.getPki("internal"))).pathname).toBe("/pki/ca/internal");
    });

    it("getPkiCertificates appends /certificates to the CA path", async () => {
      // Segment order matters -- swapping it still returns 200 against a mock.
      expect((await capture((a) => a.getPkiCertificates())).pathname).toBe("/pki/ca/local/certificates");
      expect((await capture((a) => a.getPkiCertificates("internal"))).pathname).toBe("/pki/ca/internal/certificates");
    });

    it("adapt POSTs /adapt with a text/<adapter> content type", async () => {
      const { pathname, method, contentType } = await capture((a) => a.adapt("example.com { }", "nginx"));
      expect(pathname).toBe("/adapt");
      expect(method).toBe("POST");
      expect(contentType).toBe("text/nginx");
    });

    it("adapt defaults the adapter to caddyfile", async () => {
      expect((await capture((a) => a.adapt("example.com { }"))).contentType).toBe("text/caddyfile");
    });

    it("loadConfig POSTs /load", async () => {
      const { pathname, method } = await capture((a) => a.loadConfig({ apps: {} }));
      expect(pathname).toBe("/load");
      expect(method).toBe("POST");
    });

    it("configById* compose /id/<id> and /id/<id>/<subpath>", async () => {
      expect((await capture((a) => a.configByIdGet("my-route"))).pathname).toBe("/id/my-route");
      expect((await capture((a) => a.configByIdGet("my-route", "handle"))).pathname).toBe("/id/my-route/handle");
      const set = await capture((a) => a.configByIdSet("my-route", {}, "PUT", "terminal"));
      expect(set.pathname).toBe("/id/my-route/terminal");
      expect(set.method).toBe("PUT");
      const del = await capture((a) => a.configByIdDelete("my-route", "handle"));
      expect(del.pathname).toBe("/id/my-route/handle");
      expect(del.method).toBe("DELETE");
    });
  });

  describe("traversal rejection on the write-side subpaths", () => {
    it.each([
      ["configByIdSet", (a: typeof import("../api.js")) => a.configByIdSet("my-route", {}, "PATCH", "../../load")],
      ["configByIdDelete", (a: typeof import("../api.js")) => a.configByIdDelete("my-route", "../../stop")],
    ])("rejects .. in the %s subpath without hitting fetch", async (_name, call) => {
      // configByIdGet's subpath is already covered; these are the write and
      // delete paths, where an escape matters more than on a read.
      const api = await import("../api.js");
      let called = 0;
      globalThis.fetch = vi.fn(async () => {
        called++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await call(api);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("'..'");
      expect(called).toBe(0);
    });
  });
});
