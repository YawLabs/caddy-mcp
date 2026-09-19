import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("api", () => {
  const originalFetch = globalThis.fetch;
  const savedUrl = process.env.CADDY_ADMIN_URL;
  const savedToken = process.env.CADDY_API_TOKEN;
  const savedRetries = process.env.CADDY_MAX_RETRIES;
  const savedLoadTimeout = process.env.CADDY_LOAD_TIMEOUT;
  const savedTimeout = process.env.CADDY_TIMEOUT;

  type Api = typeof import("../api.js");
  /** One exported api call, reduced to the fields the policy tests assert on. */
  type Call = (api: Api) => Promise<{ ok: boolean; status: number; error?: string; outcomeUnknown?: boolean }>;

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

  // ORDERING IS THE POINT: the empty-body check runs BEFORE the 403 origin-allowlist branch below, so a
  // bodiless 403 -- what an auth proxy fronting the admin API returns -- is diagnosed as a token problem
  // and never reaches the Origin explanation. A 403 that DOES name an origin still gets it (see the "403
  // origin rejection" block). Swapping the two branches, or widening the hint, sends the operator after
  // the wrong cause with nothing going red.
  it("hints at CADDY_API_TOKEN on an empty-body 403 and does not reach the Origin explanation", async () => {
    const api = await import("../api.js");
    globalThis.fetch = vi.fn(async () => new Response("", { status: 403 })) as any;

    const res = await api.configGet();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toBe("HTTP 403 -- check CADDY_API_TOKEN");
    expect(res.error).not.toContain("Origin");
    expect(res.error).not.toContain("admin.origins");
  });

  it("gives a bare HTTP 404 on an empty body, with no token hint", async () => {
    // Only 401/403 earn the hint. A bodiless 404 means the config path is absent, not that auth failed --
    // pointing that operator at CADDY_API_TOKEN would be a wrong-cause chase.
    const api = await import("../api.js");
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as any;

    const res = await api.configGet("apps/http/servers/nope");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error).toBe("HTTP 404");
  });

  it("does not add the token hint when the error body is non-empty", async () => {
    const api = await import("../api.js");
    globalThis.fetch = vi.fn(async () => new Response("forbidden by policy", { status: 403 })) as any;

    const res = await api.configGet();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("forbidden by policy");
  });

  describe("retry behavior", () => {
    // 503 throughout this block, deliberately: it is a GATEWAY status, which only
    // a proxy in front of Caddy can produce. Caddy's own 500s are not retried --
    // see "which 5xx statuses are transient" below.
    it("retries a gateway 503 up to CADDY_MAX_RETRIES times", async () => {
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
    it("retries POST to /load on a gateway 503 (idempotent full-config replace)", async () => {
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
    it("retries POST to /adapt on a gateway 503 (pure transformation)", async () => {
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

    it("still retries PATCH on a gateway 503 (idempotent method)", async () => {
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

    // A map KEY, not an array index: deleting a key twice is harmless (the
    // replay 404s), so DELETE keeps its retry here. This test used to delete
    // `.../routes/0` and so pinned the double-delete hazard as intended
    // behavior; the array-index half now lives in the DELETE block below.
    it("still retries DELETE of a key on a gateway 503 (idempotent there)", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("upstream down", { status: 503 });
        return new Response("", { status: 200 });
      }) as any;

      const res = await api.configDelete("apps/http/servers/srv0");
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
    });

    it("still retries PUT to a non-array path on a gateway 503 (idempotent there)", async () => {
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

    // A bare `PUT /id/<id>` carries no index in the path it SENDS, but Caddy
    // expands the id to the path it indexes -- `.../routes/2` for a route -- and
    // PUT there inserts before that element. The id index is rebuilt after the
    // write, so a replay resolves to the element's new position and inserts a
    // second copy. This used to be pinned as retried (3 sends on a 503).
    describe("PUT to a bare /id/<id>", () => {
      const reset = () =>
        new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
      const refusal = () =>
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:2019"), { code: "ECONNREFUSED" }),
        });

      it.each([
        ["a gateway 503", () => new Response("upstream down", { status: 503 })],
        ["a gateway 504", () => new Response("gateway timeout", { status: 504 })],
      ])("is sent exactly once on %s", async (_label, respond) => {
        process.env.CADDY_MAX_RETRIES = "3";
        const api = await import("../api.js");
        const sent: string[] = [];
        globalThis.fetch = vi.fn(async (url: any, opts: any) => {
          sent.push(`${opts.method} ${new URL(String(url)).pathname}`);
          return respond();
        }) as any;

        const res = await api.configByIdSet("r2", { handle: [] }, "PUT");
        expect(res.ok).toBe(false);
        expect(sent).toEqual(["PUT /id/r2"]);
      });

      it.each([
        ["r2", "/id/r2"],
        ["r2/", "/id/r2/"],
      ])("is sent exactly once when the response is lost to a reset (id %p)", async (id, path) => {
        process.env.CADDY_MAX_RETRIES = "3";
        const api = await import("../api.js");
        const sent: string[] = [];
        globalThis.fetch = vi.fn(async (url: any, opts: any) => {
          sent.push(`${opts.method} ${new URL(String(url)).pathname}`);
          throw reset();
        }) as any;

        const res = await api.configByIdSet(id, { handle: [] }, "PUT");
        expect(res.ok).toBe(false);
        expect(res.status).toBe(0);
        expect(sent).toEqual([`PUT ${path}`]);
      });

      // Rule 2 of shouldRetry runs ahead of isRetryableMethod: a refused connect
      // wrote nothing, so there is nothing to duplicate.
      it("IS replayed when the connection was refused", async () => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        const sent: string[] = [];
        globalThis.fetch = vi.fn(async (url: any, opts: any) => {
          sent.push(`${opts.method} ${new URL(String(url)).pathname}`);
          if (sent.length === 1) throw refusal();
          return new Response("", { status: 200 });
        }) as any;

        const res = await api.configByIdSet("r2", { handle: [] }, "PUT");
        expect(res.ok).toBe(true);
        expect(sent).toEqual(["PUT /id/r2", "PUT /id/r2"]);
      });

      // Only the BARE form is excluded: a subpath that names a key under the
      // identified object is an ordinary strictly-create PUT, as under /config.
      it("leaves a PUT to a keyed /id/ subpath retryable", async () => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          if (calls < 3) return new Response("upstream down", { status: 503 });
          return new Response("", { status: 200 });
        }) as any;

        const res = await api.configByIdSet("r2", true, "PUT", "terminal");
        expect(res.ok).toBe(true);
        expect(calls).toBe(3);
      });
    });

    // Caddy trims slashes off a config path before walking it (admin.go:1178),
    // so ".../routes/0/" is the same array position as ".../routes/0". The
    // carve-out used to anchor on a bare `$` and let that spelling through.
    it.each([
      "apps/http/servers/srv0/routes/0/",
      "apps/http/servers/srv0/routes/0//",
    ])("does NOT retry PUT at an array-index path spelled with a trailing slash (%s)", async (path) => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("upstream down", { status: 503 });
      }) as any;

      const res = await api.configPut(path, {});
      expect(res.ok).toBe(false);
      expect(calls).toBe(1);
    });

    // Caddy removes an array element by RE-PACKING the array (admin.go:1251), so
    // by the time a replayed `DELETE .../routes/<n>` arrives, <n> names whatever
    // slid into the gap, and the replay removes that instead. Same carve-out as
    // PUT, for the mirror-image reason (PUT there inserts a second element).
    describe("DELETE at an array index", () => {
      const indexDeletes: Array<[string, Call, string]> = [
        [
          "a /config array index",
          (api) => api.configDelete("apps/http/servers/srv0/routes/0"),
          "/config/apps/http/servers/srv0/routes/0",
        ],
        [
          "a /config array index with a trailing slash",
          (api) => api.configDelete("apps/http/servers/srv0/routes/0/"),
          "/config/apps/http/servers/srv0/routes/0/",
        ],
        ["an /id subpath array index", (api) => api.configByIdDelete("my-route", "handle/0"), "/id/my-route/handle/0"],
      ];

      /** A transport failure that is NOT a refusal: Caddy may have read the request. */
      const reset = () =>
        new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
      const refusal = () =>
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:2019"), { code: "ECONNREFUSED" }),
        });

      it.each(indexDeletes)("is NOT replayed when no response arrives (status 0): %s", async (_label, call, path) => {
        process.env.CADDY_MAX_RETRIES = "3";
        const api = await import("../api.js");
        const sent: string[] = [];
        globalThis.fetch = vi.fn(async (url: any, opts: any) => {
          sent.push(`${opts.method} ${new URL(String(url)).pathname}`);
          throw reset();
        }) as any;

        const res = await call(api);
        expect(res.ok).toBe(false);
        expect(res.status).toBe(0);
        expect(sent).toEqual([`DELETE ${path}`]);
      });

      it.each(indexDeletes)("is NOT replayed on a gateway 503: %s", async (_label, call, path) => {
        process.env.CADDY_MAX_RETRIES = "3";
        const api = await import("../api.js");
        const sent: string[] = [];
        globalThis.fetch = vi.fn(async (url: any, opts: any) => {
          sent.push(`${opts.method} ${new URL(String(url)).pathname}`);
          return new Response("upstream down", { status: 503 });
        }) as any;

        const res = await call(api);
        expect(res.ok).toBe(false);
        expect(res.status).toBe(503);
        expect(sent).toEqual([`DELETE ${path}`]);
      });

      // The one failure that PROVES the request never reached Caddy: the connect
      // was refused, so nothing was written and there is nothing to double-apply.
      it.each(indexDeletes)("IS replayed when the connection was refused: %s", async (_label, call, path) => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        const sent: string[] = [];
        globalThis.fetch = vi.fn(async (url: any, opts: any) => {
          sent.push(`${opts.method} ${new URL(String(url)).pathname}`);
          if (sent.length === 1) throw refusal();
          return new Response("", { status: 200 });
        }) as any;

        const res = await call(api);
        expect(res.ok).toBe(true);
        expect(sent).toEqual([`DELETE ${path}`, `DELETE ${path}`]);
      });

      // The other direction: everything that is not an array position keeps its
      // retry. A map key deleted twice 404s on the replay, and so does a bare
      // `DELETE /id/<id>` (Caddy rebuilds its id index after the first delete).
      // "srv0" and "route-10" END in digits without BEING an index -- the
      // carve-out must match a whole numeric segment, not a numeric suffix.
      it.each<[string, Call]>([
        ["a map key", (api) => api.configDelete("apps/http/servers/srv0")],
        ["a key that ends in digits", (api) => api.configDelete("apps/tls/certificates/route-10")],
        ["a bare /id/<id>", (api) => api.configByIdDelete("my-route")],
        ["an /id subpath that is a key", (api) => api.configByIdDelete("my-route", "terminal")],
      ])("still retries DELETE of %s when no response arrives", async (_label, call) => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          if (calls < 3) throw reset();
          return new Response("", { status: 200 });
        }) as any;

        const res = await call(api);
        expect(res.ok).toBe(true);
        expect(calls).toBe(3);
      });
    });

    // Caddy's admin API never emits 502 / 503 / 504 -- only a proxy in front of
    // it can -- and the 500s it DOES emit are deterministic rejections: Caddy
    // maps every non-APIError to 500, which is how a config that fails
    // validation, a bad body, an out-of-range index and a missing traversal
    // segment all arrive. None of them changes the config, so a replay gets the
    // same answer. What a replay cost depends on where Caddy refused it: a bad
    // body, an out-of-range index or a missing traversal segment is refused
    // before any load runs (nothing to roll back), so each replay was one more
    // ERROR line; a config that fails while provisioning the apps -- the body
    // below -- has already restarted the admin endpoint, so each replay was an
    // ERROR line AND an admin-endpoint restart. Verified against Caddy 2.11.4:
    // a PATCH naming an unknown handler answers 500 with the body below, and
    // 2.5.2 sent it three times (3 ERROR lines, 3 admin restarts, 378 ms) where
    // one send takes 20 ms; the traversal, index and decode 500s leave the
    // admin endpoint running.
    describe("which 5xx statuses are transient", () => {
      const caddy500 =
        '{"error":"loading new config: loading http app module: provision http: server s: setting up route ' +
        "handlers: route 0: loading handler modules: position 0: loading module 'no_such_handler': unknown " +
        'module: http.handlers.no_such_handler"}\n';

      it.each<[string, Call]>([
        ["PATCH", (api) => api.configPatch("apps/http/servers/srv0", { listen: [":443"] })],
        ["DELETE of a key", (api) => api.configDelete("apps/http/servers/srv0")],
        ["PUT to a key", (api) => api.configPut("apps/http/servers/srv0", {})],
        ["GET", (api) => api.configGet("apps/http/servers/srv0")],
        ["POST /load", (api) => api.loadConfig({ apps: {} })],
        ["POST /adapt", (api) => api.adapt("example.com { }")],
      ])("sends a %s that answers 500 exactly once and returns the body verbatim", async (_label, call) => {
        process.env.CADDY_MAX_RETRIES = "3";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          return new Response(caddy500, { status: 500 });
        }) as any;

        const res = await call(api);
        expect(res.ok).toBe(false);
        expect(res.status).toBe(500);
        expect(res.error).toBe(caddy500);
        expect(calls).toBe(1);
      });

      it.each([501, 505, 507, 599])("does not retry a %i either -- only gateway statuses are", async (status) => {
        process.env.CADDY_MAX_RETRIES = "3";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          return new Response("nope", { status });
        }) as any;

        const res = await api.configGet();
        expect(res.status).toBe(status);
        expect(calls).toBe(1);
      });

      it.each([502, 503, 504])("still retries a gateway %i on a GET", async (status) => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          if (calls < 3) return new Response("bad gateway", { status });
          return new Response("{}", { status: 200 });
        }) as any;

        const res = await api.configGet();
        expect(res.ok).toBe(true);
        expect(calls).toBe(3);
      });

      it.each([502, 504])("still retries a gateway %i on a PATCH and on POST /load", async (status) => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          if (calls % 3 !== 0) return new Response("bad gateway", { status });
          return new Response("", { status: 200 });
        }) as any;

        expect((await api.configPatch("apps/http/servers/srv0", { listen: [":443"] })).ok).toBe(true);
        expect(calls).toBe(3);
        expect((await api.loadConfig({ apps: {} })).ok).toBe(true);
        expect(calls).toBe(6);
      });

      it("gives up on a persistent gateway status with that status, after the full budget", async () => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          return new Response("gateway timeout", { status: 504 });
        }) as any;

        const res = await api.configGet();
        expect(res.ok).toBe(false);
        expect(res.status).toBe(504);
        expect(res.error).toBe("gateway timeout");
        expect(calls).toBe(3);
      });
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
    it("retries POST to /stop on a gateway 503 (second-call is a no-op against an already-stopped server)", async () => {
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
    // 55000, not 60000: the MCP SDK's client abandons a tool call at 60000 ms by
    // default and its timer starts first, so a 60 s deadline here meant the
    // outcome-unknown error for a timed-out config change was never delivered.
    it("defaults to 55000 when env unset -- below the MCP SDK's 60000 ms client timeout", async () => {
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as any;

      await api.loadConfig({});
      expect(timeoutSpy).toHaveBeenCalledWith(55000);
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
    ])("falls back to 55000 for invalid value %p", async (invalid) => {
      process.env.CADDY_LOAD_TIMEOUT = invalid;
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as any;

      await api.loadConfig({});
      expect(timeoutSpy).toHaveBeenCalledWith(55000);
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
      expect(timeoutSpy).toHaveBeenCalledWith(55000);
      timeoutSpy.mockRestore();
    });
  });

  // Every non-GET under /config or /id runs the SAME synchronous full reload
  // inside Caddy as POST /load -- one changeConfig, one lock, provision and
  // start the whole new config before the response goes out -- so they share
  // /load's budget. They used to sit on CADDY_TIMEOUT, which reported a slow
  // reload as a failure while Caddy carried on applying it.
  const configChanges: Array<[string, Call]> = [
    ["PATCH /config", (api) => api.configPatch("apps/http", {})],
    ["PUT /config", (api) => api.configPut("apps/http/servers/s", {})],
    ["POST /config", (api) => api.configPost("apps/http/servers/s/routes", {})],
    ["DELETE /config", (api) => api.configDelete("apps/http/servers/s")],
    ["PATCH /id", (api) => api.configByIdSet("r1", {})],
    ["PUT /id", (api) => api.configByIdSet("r1", {}, "PUT")],
    ["POST /id", (api) => api.configByIdSet("r1", {}, "POST")],
    ["DELETE /id", (api) => api.configByIdDelete("r1")],
    ["POST /load", (api) => api.loadConfig({ apps: {} })],
  ];
  // Nothing here makes Caddy reload, so nothing here can be left half-applied.
  const nonChanges: Array<[string, Call]> = [
    ["GET /config", (api) => api.configGet("apps")],
    ["GET /id", (api) => api.configByIdGet("r1")],
    ["POST /adapt", (api) => api.adapt("example.com { }")],
    ["POST /stop", (api) => api.stop()],
    ["GET /reverse_proxy/upstreams", (api) => api.getUpstreams()],
    ["GET /pki/ca/local", (api) => api.getPki()],
    ["GET /metrics", (api) => api.getMetrics()],
  ];

  describe("timeout budget by request kind", () => {
    it.each(configChanges)("%s runs on CADDY_LOAD_TIMEOUT", async (_label, call) => {
      process.env.CADDY_TIMEOUT = "5000";
      process.env.CADDY_LOAD_TIMEOUT = "45000";
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as any;

      try {
        expect((await call(api)).ok).toBe(true);
        expect(timeoutSpy.mock.calls).toEqual([[45000]]);
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it.each(nonChanges)("%s runs on CADDY_TIMEOUT", async (_label, call) => {
      process.env.CADDY_TIMEOUT = "5000";
      process.env.CADDY_LOAD_TIMEOUT = "45000";
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;

      try {
        expect((await call(api)).ok).toBe(true);
        expect(timeoutSpy.mock.calls).toEqual([[5000]]);
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it("gives a config write the 55000 default when neither variable is set", async () => {
      const api = await import("../api.js");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as any;

      try {
        await api.configPatch("apps/http", {});
        await api.configGet("apps/http");
        expect(timeoutSpy.mock.calls).toEqual([[55000], [10000]]);
      } finally {
        timeoutSpy.mockRestore();
      }
    });
  });

  // A deadline that fires on a config change does not mean the change failed:
  // Caddy applies it synchronously inside the request, under its config lock,
  // and takes no request context -- so it carries on after the client hangs up.
  // A replay therefore cannot overtake the first request; it queues behind it
  // and then runs against a config the first request already changed (a 412 or
  // 404 for a change that in fact landed, a second removal at an array index),
  // and when the reload outlasts the deadline every replay times out too.
  describe("a fired timeout", () => {
    const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

    it.each(configChanges)("on %s is NOT retried", async (_label, call) => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        throw timeoutError();
      }) as any;

      const res = await call(api);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.error).toContain("Request timed out after 55000ms");
      // The flag caddy_load / caddy_revert key on to keep their snapshot.
      expect(res.outcomeUnknown).toBe(true);
      expect(calls).toBe(1);
    });

    // oam -- which bin/caddy-mcp.mjs serves on by default when a recent one is
    // installed -- rejects a fired AbortSignal.timeout with DOMException
    // TimeoutError "The operation timed out": the same error NAME as Node, but
    // a message with neither "abort" nor "timeout" in it. Classified by message
    // alone, it fell through to the generic transport branch, so these writes
    // were replayed up to 1 + CADDY_MAX_RETRIES times and the caller got the
    // bare runtime text. Observed under oam 0.16.2 with the old classifier:
    // configPatch, configDelete of a key and loadConfig each reached a server
    // that never answered 3 times.
    describe("with oam's wording", () => {
      const oamTimeout = () => new DOMException("The operation timed out", "TimeoutError");

      it.each<[string, Call]>([
        ["PATCH", (api) => api.configPatch("apps/http/servers/srv0", { listen: [":443"] })],
        ["DELETE of a key", (api) => api.configDelete("apps/http/servers/srv0")],
        ["POST /load", (api) => api.loadConfig({ apps: {} })],
      ])("a timed-out %s is delivered once and reports the outcome as unknown", async (_label, call) => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          throw oamTimeout();
        }) as any;

        const res = await call(api);
        expect(calls).toBe(1);
        expect(res.ok).toBe(false);
        expect(res.status).toBe(0);
        expect(res.outcomeUnknown).toBe(true);
        expect(res.error).toMatch(/^Request timed out after 55000ms -- the outcome is unknown/);
        expect(res.error).not.toContain("The operation timed out");
      });

      it("a timed-out GET still retries, and reports the budget rather than the runtime's text", async () => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          throw oamTimeout();
        }) as any;

        const res = await api.configGet("apps");
        expect(calls).toBe(3);
        expect(res.error).toBe("Request timed out after 10000ms");
        expect(res.outcomeUnknown).toBeUndefined();
      });

      // By name, wherever it sits in the chain -- node:http wraps a signal
      // abort in an AbortError whose cause is the TimeoutError, and a runtime
      // may word either however it likes.
      it.each([
        ["an AbortError with unrelated text", () => new DOMException("request cancelled", "AbortError")],
        [
          "a TimeoutError two causes down",
          () =>
            new Error("request failed", {
              cause: new Error("wrapped", { cause: new DOMException("deadline", "TimeoutError") }),
            }),
        ],
      ])("recognises %s as a timeout", async (_label, make) => {
        process.env.CADDY_MAX_RETRIES = "2";
        const api = await import("../api.js");
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
          calls++;
          throw make();
        }) as any;

        const res = await api.configPatch("apps/http", {});
        expect(calls).toBe(1);
        expect(res.outcomeUnknown).toBe(true);
        expect(res.error).toContain("the outcome is unknown");
      });
    });

    // Nothing is left running inside Caddy behind a read or a pure
    // transformation, so these keep the ordinary transient-failure retry.
    it.each(nonChanges)("on %s is still retried", async (_label, call) => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) throw timeoutError();
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await call(api);
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
    });

    it("on a GET that never answers reports the bare timeout after the full retry budget", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        throw timeoutError();
      }) as any;

      const res = await api.configGet("apps");
      expect(res.status).toBe(0);
      expect(res.error).toBe("Request timed out after 10000ms");
      expect(calls).toBe(3);
    });

    // The rule is per attempt, not per call: a write that WAS retryable on its
    // first failure (a proxy's 503) stops the moment an attempt times out.
    it("stops a retry sequence at the first attempt that times out", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response("upstream down", { status: 503 });
        throw timeoutError();
      }) as any;

      const res = await api.configPatch("apps/http", {});
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(calls).toBe(2);
    });

    // Deliberately NOT invalidated on a timeout. If the timed-out change did
    // land, the path's hash moved, and an operator (or model) who re-issues the
    // write without re-reading gets Caddy's 412 instead of a second blind write.
    // Dropping the entry "to be safe" would remove exactly that guard.
    it("keeps the cached ETag across a timed-out write, so a blind re-issue still carries If-Match", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      const target = "timed-out-write-keeps-etag";
      const sent: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        sent.push({ method, ifMatch: opts?.headers?.["If-Match"] ?? null });
        if (method === "GET") return new Response("{}", { status: 200, headers: { ETag: '"/config/x abc"' } });
        if (sent.filter((s) => s.method === "PATCH").length === 1) throw timeoutError();
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet(target);
      expect((await api.configPatch(target, { a: 1 })).ok).toBe(false);
      await api.configPatch(target, { a: 1 });

      expect(sent).toEqual([
        { method: "GET", ifMatch: null },
        { method: "PATCH", ifMatch: '"/config/x abc"' },
        { method: "PATCH", ifMatch: '"/config/x abc"' },
      ]);
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

    // The bare "Request timed out after Nms" this used to pin read as "it
    // failed", which is the one thing a timed-out config change does not say.
    // The message still leads with the budget that fired; what follows states
    // the ambiguity and the safe next step, and names no cause and no outcome.
    // Pinned whole, so rewording it is a deliberate act.
    it("reports the /load timeout budget, not the per-request one, when /load aborts", async () => {
      process.env.CADDY_TIMEOUT = "1000";
      process.env.CADDY_LOAD_TIMEOUT = "45000";
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as any;

      const res = await api.loadConfig({ apps: {} });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.error).toBe(
        "Request timed out after 45000ms -- the outcome is unknown: Caddy may still be applying this change. " +
          "A config change blocks until Caddy finishes reloading, and a client timeout does not cancel it, so it " +
          "may have applied, may yet apply, or may not apply at all; caddy-mcp never replays a timed-out config " +
          "change. Re-read the config before retrying. If reloads on this instance legitimately take this long, " +
          "raise CADDY_LOAD_TIMEOUT, keeping it below your MCP client's request timeout (60 s by default in the " +
          "MCP SDK), or this error never reaches the client.",
      );
      expect(res.outcomeUnknown).toBe(true);
    });

    it.each<[string, Call]>([
      ["PATCH", (api) => api.configPatch("apps/http/servers/srv0", { listen: [":443"] })],
      ["DELETE at an array index", (api) => api.configDelete("apps/http/servers/srv0/routes/2")],
      ["POST under /id", (api) => api.configByIdSet("r1", {}, "POST")],
    ])("tells the operator a timed-out %s may still be applying, without claiming an outcome", async (_l, call) => {
      process.env.CADDY_TIMEOUT = "1000";
      process.env.CADDY_LOAD_TIMEOUT = "45000";
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as any;

      const res = await call(api);
      // The reload budget, not CADDY_TIMEOUT: a config write is a reload.
      expect(res.error).toMatch(/^Request timed out after 45000ms -- /);
      expect(res.error).toContain("the outcome is unknown");
      expect(res.error).toContain("Caddy may still be applying this change");
      expect(res.error).toContain("Re-read the config before retrying");
    });

    it("keeps the bare message for a request that changes nothing", async () => {
      // No hint on a read: nothing is left half-applied behind it, and "re-read
      // the config" would be advice about a change nobody made.
      process.env.CADDY_TIMEOUT = "1234";
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as any;

      for (const call of [() => api.adapt("example.com { }"), () => api.stop(), () => api.getMetrics()]) {
        expect((await call()).error).toBe("Request timed out after 1234ms");
      }
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

    // outcomeUnknown marks this client's own deadline firing on a config change
    // and nothing else -- it is not a synonym for status 0. Other transport
    // failures keep the plain shape they always had.
    it.each([
      [
        "a reset",
        () =>
          new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }),
      ],
      ["an unrecognized transport error", () => new Error("socket hang up")],
    ])("does not set outcomeUnknown for %s on a config change", async (_label, make) => {
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw make();
      }) as any;

      const res = await api.loadConfig({ apps: {} });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.outcomeUnknown).toBeUndefined();
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

  // A path prefix in CADDY_ADMIN_URL is PRESERVED on the wire -- intended, so
  // an admin endpoint behind a path-prefixed reverse proxy is reachable. The
  // only thing pinned before was the connect-error message (tools.test.ts),
  // which strips to the origin; the request URL itself was unpinned, so the
  // prefix could have been dropped without a single test going red.
  describe("path-prefixed CADDY_ADMIN_URL", () => {
    async function captureUrl(call: (a: typeof import("../api.js")) => Promise<unknown>) {
      const api = await import("../api.js");
      let raw = "";
      globalThis.fetch = vi.fn(async (url: any) => {
        raw = String(url);
        return new Response("{}", { status: 200 });
      }) as any;
      await call(api);
      return raw;
    }

    it("prepends the prefix to the request path", async () => {
      process.env.CADDY_ADMIN_URL = "http://caddy.local:2019/caddy-admin";
      const raw = await captureUrl((a) => a.configGet("apps"));
      expect(raw).toBe("http://caddy.local:2019/caddy-admin/config/apps");
    });

    it("strips a trailing slash from the prefix rather than doubling it", async () => {
      process.env.CADDY_ADMIN_URL = "http://caddy.local:2019/caddy-admin/";
      const raw = await captureUrl((a) => a.configGet("apps"));
      expect(raw).toBe("http://caddy.local:2019/caddy-admin/config/apps");
    });

    it("sends the bare origin as Origin, without the prefix", async () => {
      // Caddy's admin allowlist compares scheme+host+port; an Origin carrying a
      // path is not an origin and would never match.
      process.env.CADDY_ADMIN_URL = "http://caddy.local:2019/caddy-admin";
      const api = await import("../api.js");
      let headers: any = {};
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        headers = opts.headers;
        return new Response("{}", { status: 200 });
      }) as any;

      await api.configGet("apps");
      expect(headers.Origin).toBe("http://caddy.local:2019");
    });

    it("keys the retry policy on the prefix-free path", async () => {
      // POST /config/<path> is non-idempotent and must not retry. The policy
      // reads the path the exported helpers build, which never carries the
      // prefix -- if the prefix ever leaked into it, the startsWith("/config/")
      // check would miss and a failed append would be replayed.
      process.env.CADDY_ADMIN_URL = "http://caddy.local:2019/caddy-admin";
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("boom", { status: 500 });
      }) as any;

      const res = await api.configPost("apps/http/servers/srv0/routes", {});
      expect(res.ok).toBe(false);
      expect(calls).toBe(1);
    });

    it("reports only the origin when the connection fails under a prefix", async () => {
      process.env.CADDY_ADMIN_URL = "http://caddy.local:2019/caddy-admin";
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as any;

      const res = await api.configGet("apps");
      expect(res.error).toContain("http://caddy.local:2019");
      expect(res.error).not.toContain("/caddy-admin");
    });

    it("lets a query string in CADDY_ADMIN_URL swallow the request path", async () => {
      // Characterization, not an endorsement: a query in the base URL is
      // operator error (no legitimate admin base URL carries one), and it
      // corrupts every request -- the path lands inside the query. Pinned so
      // that stripping it later is a deliberate change rather than a silent
      // one. The surface that mattered is already handled: the connect-error
      // message reports the origin only, so the token does not leak (see
      // tools.test.ts).
      process.env.CADDY_ADMIN_URL = "http://caddy.local:2019/some/path?token=secret";
      const url = new URL(await captureUrl((a) => a.configGet("apps")));
      expect(url.pathname).toBe("/some/path");
      expect(url.search).toBe("?token=secret/config/apps");
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

  // Caddy writes a Caddyfile load's adapter warnings to the response BEFORE it
  // runs the load, which commits the status at 200; a load that then fails has
  // its error object appended to a body that already went out as a success.
  // The fixtures below are the bytes Caddy 2.11.4 sent, captured live, trailing
  // newline included -- hand-simplified bodies are how this client came to
  // report a failed load as a success in the first place.
  describe("the body of a /load response", () => {
    const WARNING = {
      file: "Caddyfile",
      line: 2,
      message: "Caddyfile input is not formatted; run 'caddy fmt --overwrite' to fix inconsistencies",
    };
    const WARNINGS_JSON = JSON.stringify([WARNING]);
    const ERROR_JSON =
      '{"error":"loading config: loading new config: loading http app module: provision http: getting tls app: ' +
      "loading tls app module: provision tls: loading certificates: open C:/nonexistent-caddy-mcp/cert.pem: " +
      'The system cannot find the path specified."}';
    /** 200 OK, text/plain: warnings, then the error object, then json.Encoder's newline. */
    const FAILED_BEHIND_A_200 = `${WARNINGS_JSON}${ERROR_JSON}\n`;
    const caddyfile = 'example.test {\n  respond "hi"\n}\n';

    /** Answer every POST /load with one canned response, and count the sends. */
    function answerLoadWith(body: string, status = 200) {
      const sends: string[] = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        sends.push(`${opts?.method ?? "GET"} ${new URL(String(url)).pathname}`);
        return new Response(body, { status });
      }) as any;
      return sends;
    }

    it("reports a load that failed behind a 200 as a failure, with Caddy's error and the warnings", async () => {
      const api = await import("../api.js");
      answerLoadWith(FAILED_BEHIND_A_200);

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.ok).toBe(false);
      // Caddy's error object, byte for byte, leads the message.
      expect(res.error?.startsWith(ERROR_JSON)).toBe(true);
      // The warnings are kept, structured, not folded away or dropped.
      expect(res.warnings).toEqual([WARNING]);
      expect(res.data).toBeUndefined();
    });

    it("keeps the 200 Caddy sent and says so, rather than reporting a status it never sent", async () => {
      const api = await import("../api.js");
      answerLoadWith(FAILED_BEHIND_A_200);

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.status).toBe(200);
      expect(res.error).toContain("Caddy answered HTTP 200");
      expect(res.error).toContain("load error");
    });

    it("sends a load that failed behind a 200 once, whatever the retry budget", async () => {
      process.env.CADDY_MAX_RETRIES = "5";
      const api = await import("../api.js");
      const sends = answerLoadWith(FAILED_BEHIND_A_200);

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.ok).toBe(false);
      expect(sends).toEqual(["POST /load"]);
    });

    it("keeps cached ETags when the load failed behind a 200, as it does for a 400", async () => {
      // The 200 used to read as a success and wipe the whole cache, so the next
      // write went out with no If-Match against a config that had not changed.
      const api = await import("../api.js");
      const target = "load-failed-behind-200-keeps-cache";
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        calls.push({ method, ifMatch: opts?.headers?.["If-Match"] ?? null });
        if (method === "GET") return new Response("{}", { status: 200, headers: { ETag: "survives-false-200" } });
        if (String(url).endsWith("/load")) return new Response(FAILED_BEHIND_A_200, { status: 200 });
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet(target);
      expect((await api.loadConfig(caddyfile, "text/caddyfile")).ok).toBe(false);
      await api.configPatch(target, { foo: 1 });

      expect(calls[2]?.method).toBe("PATCH");
      expect(calls[2]?.ifMatch).toBe("survives-false-200");
    });

    it("keeps a load that applied with warnings a success, and surfaces the warnings", async () => {
      const api = await import("../api.js");
      // Exactly what 2.11.4 sends: json.Marshal output, no trailing newline.
      answerLoadWith(WARNINGS_JSON);

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.error).toBeUndefined();
      expect(res.warnings).toEqual([WARNING]);
      // Not ALSO left in `data`, where formatResult would print them twice.
      expect(res.data).toBeUndefined();
    });

    it("still clears the ETag cache after a load that applied with warnings", async () => {
      const api = await import("../api.js");
      const target = "load-with-warnings-clears-cache";
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        calls.push({ method, ifMatch: opts?.headers?.["If-Match"] ?? null });
        if (method === "GET") return new Response("{}", { status: 200, headers: { ETag: "pre-load" } });
        if (String(url).endsWith("/load")) return new Response(WARNINGS_JSON, { status: 200 });
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet(target);
      expect((await api.loadConfig(caddyfile, "text/caddyfile")).ok).toBe(true);
      await api.configPatch(target, { foo: 1 });

      expect(calls[2]?.ifMatch).toBe(null);
    });

    it("leaves a plain successful load -- 200, empty body -- exactly as it was", async () => {
      const api = await import("../api.js");
      answerLoadWith("");

      const res = await api.loadConfig({ apps: {} });

      expect(res).toEqual({ ok: true, status: 200, etag: undefined });
    });

    it("leaves an ordinary 400 load failure exactly as it was: Caddy's body, verbatim", async () => {
      const api = await import("../api.js");
      answerLoadWith(`${ERROR_JSON}\n`, 400);

      const res = await api.loadConfig({ apps: {} });

      expect(res).toEqual({ ok: false, status: 400, error: `${ERROR_JSON}\n` });
    });

    // caddyserver/caddy#7267 (open, milestoned v2.11.5): the failure becomes a
    // real 400 whose one JSON object carries both parts. Read from the PR's
    // diff, never run. A non-2xx needs no special handling -- the body comes
    // through verbatim -- so this pins that both parts stay visible.
    it("passes the post-#7267 failure shape through with the error and the warnings both visible", async () => {
      const api = await import("../api.js");
      const body = `{"error":"loading config: loading new config: provision tls: open cert.pem: no such file or directory","warnings":${WARNINGS_JSON}}\n`;
      answerLoadWith(body, 400);

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.ok).toBe(false);
      expect(res.status).toBe(400);
      expect(res.error).toBe(body);
      expect(res.error).toContain("open cert.pem: no such file or directory");
      expect(res.error).toContain("Caddyfile input is not formatted");
    });

    it("reads the post-#7267 success shape, an object holding only the warnings", async () => {
      const api = await import("../api.js");
      answerLoadWith(`{"warnings":${WARNINGS_JSON}}\n`);

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.ok).toBe(true);
      expect(res.warnings).toEqual([WARNING]);
      expect(res.data).toBeUndefined();
    });

    it("shows a success object that carries more than warnings whole, instead of trimming it", async () => {
      const api = await import("../api.js");
      answerLoadWith(`{"warnings":${WARNINGS_JSON},"reloaded":true}`);

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.ok).toBe(true);
      expect(res.warnings).toBeUndefined();
      expect(res.data).toEqual({ warnings: [WARNING], reloaded: true });
    });

    // The split is on the JSON boundary, found by tracking string state. A
    // warning's message is free text -- it can quote the operator's own config,
    // brackets, braces and escaped quotes included.
    it("is not fooled by an error-shaped string INSIDE a warning of a load that applied", async () => {
      const api = await import("../api.js");
      const tricky = [{ file: "Caddyfile", line: 3, message: 'odd value ]{"error":"not real"} and a \\"quote\\" ]' }];
      answerLoadWith(JSON.stringify(tricky));

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.ok).toBe(true);
      expect(res.warnings).toEqual(tricky);
    });

    it("finds the real trailing error past a warning whose message is full of brackets", async () => {
      const api = await import("../api.js");
      const tricky = [{ file: "Caddyfile", line: 3, message: 'odd value ]{"error":"not real"} [[[ {{{ \\" ]' }];
      answerLoadWith(`${JSON.stringify(tricky)}${ERROR_JSON}\n`);

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.ok).toBe(false);
      expect(res.error?.startsWith(ERROR_JSON)).toBe(true);
      expect(res.warnings).toEqual(tricky);
    });

    // None of these is a shape Caddy sends. Each falls back to what this client
    // always did with a 2xx -- parsed JSON if it parses, the raw text if not --
    // because overriding a 200 on a guess is the failure mode in reverse.
    it.each([
      ["a warnings array followed by text that is not JSON", `${WARNINGS_JSON} load complete`],
      ["a warnings array followed by an object with no error", `${WARNINGS_JSON}{"result":"ok"}`],
      ["a warnings array followed by an error that is not a string", `${WARNINGS_JSON}{"error":42}`],
      ["a warnings array followed by a second array", `${WARNINGS_JSON}[1,2]`],
      ["an array that never closes", '[{"file":"Caddyfile"'],
      ["a bracket-balanced array that is not JSON", "[not json]"],
      ["plain text", "load complete"],
    ])("falls back to the old behaviour for %s", async (_label, body) => {
      const api = await import("../api.js");
      answerLoadWith(body);

      const res = await api.loadConfig(caddyfile, "text/caddyfile");

      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.warnings).toBeUndefined();
      expect(res.data).toBe(body);
    });

    it("applies only to /load: the same body from another endpoint is returned as before", async () => {
      const api = await import("../api.js");
      answerLoadWith(FAILED_BEHIND_A_200);

      const res = await api.getMetrics();

      expect(res.ok).toBe(true);
      expect(res.warnings).toBeUndefined();
      expect(res.data).toBe(FAILED_BEHIND_A_200);
    });

    // The success-side settle wait (see settleAdminRestart) is gated on `ok`, so
    // a load that failed behind a 200 must skip it, as a 400 does. Real sockets:
    // the wait only exists when fetch holds a keep-alive connection. The server
    // never closes one, so a load that DOES settle waits out the whole 250 ms
    // cap -- asserted here as the control, or "fast" would prove nothing.
    it("does not run the config-change settle wait for a load that failed behind a 200", async () => {
      const { createServer } = await import("node:http");
      let loadBody = "";
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          const body = req.method === "GET" ? "{}" : loadBody;
          res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as import("node:net").AddressInfo;
      process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${port}`;
      try {
        const api = await import("../api.js");
        // A read first, so fetch is holding a keep-alive socket to this origin.
        expect((await api.configGet("apps")).ok).toBe(true);

        loadBody = FAILED_BEHIND_A_200;
        let started = performance.now();
        const failed = await api.loadConfig(caddyfile, "text/caddyfile");
        const failedMs = performance.now() - started;

        loadBody = WARNINGS_JSON;
        started = performance.now();
        const applied = await api.loadConfig(caddyfile, "text/caddyfile");
        const appliedMs = performance.now() - started;

        expect(failed.ok).toBe(false);
        expect(applied.ok).toBe(true);
        expect(appliedMs).toBeGreaterThanOrEqual(240);
        expect(failedMs).toBeLessThan(200);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
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

  // Config keys are arbitrary strings, but they are interpolated into a URL.
  // Before segment-encoding, a "#" or "?" in a key silently truncated the
  // request path at the client: caddy_config_delete on
  // "apps/http/servers/prod#1" sent DELETE /config/apps/http/servers/prod --
  // it deleted the PARENT server and reported success. Nothing in the schema
  // stops that either; config_get/set/delete take a bare string.
  describe("config path percent-encoding", () => {
    async function captureUrl(call: (a: typeof import("../api.js")) => Promise<unknown>) {
      const api = await import("../api.js");
      let raw = "";
      globalThis.fetch = vi.fn(async (url: any) => {
        raw = String(url);
        return new Response("{}", { status: 200 });
      }) as any;
      await call(api);
      return new URL(raw);
    }

    const hashKeyVerbs: Array<[string, (a: typeof import("../api.js")) => Promise<unknown>]> = [
      ["configGet", (a) => a.configGet("apps/http/servers/prod#1")],
      ["configPost", (a) => a.configPost("apps/http/servers/prod#1", {})],
      ["configPut", (a) => a.configPut("apps/http/servers/prod#1", {})],
      ["configPatch", (a) => a.configPatch("apps/http/servers/prod#1", {})],
      ["configDelete", (a) => a.configDelete("apps/http/servers/prod#1")],
    ];

    it.each(hashKeyVerbs)("%s keeps a '#' key in the path instead of addressing its parent", async (_name, call) => {
      const url = await captureUrl(call);
      expect(url.pathname).toBe("/config/apps/http/servers/prod%231");
      // The tell for the old bug: the remainder ended up here, not on the wire.
      expect(url.hash).toBe("");
    });

    it("encodes '?' so a key cannot open a query string", async () => {
      const url = await captureUrl((a) => a.configGet("apps/http/servers/a?b"));
      expect(url.pathname).toBe("/config/apps/http/servers/a%3Fb");
      expect(url.search).toBe("");
    });

    it("keeps '/' as the segment separator", async () => {
      // Whole-string encodeURIComponent would send %2F here and address one
      // top-level key whose name contains slashes.
      const url = await captureUrl((a) => a.configGet("apps/http/servers/srv0"));
      expect(url.pathname).toBe("/config/apps/http/servers/srv0");
    });

    it("still produces exactly /config/ for the root path", async () => {
      const url = await captureUrl((a) => a.configGet(""));
      expect(url.pathname).toBe("/config/");
    });

    it("leaves unreserved characters alone, including '..' inside a segment", async () => {
      const url = await captureUrl((a) => a.configGet("apps/http/servers/my..name"));
      expect(url.pathname).toBe("/config/apps/http/servers/my..name");
    });

    it("rejects '..' before encoding, and escapes a pre-encoded '%2e%2e' rather than decoding it", async () => {
      // Order is load-bearing. rejectTraversal runs on the DECODED path, so a
      // literal ".." never reaches fetch; and because encoding comes after,
      // caller-supplied "%2e%2e" is escaped to %252e%252e -- Caddy decodes that
      // back to the literal text "%2e%2e", never to a real ".." segment.
      const api = await import("../api.js");
      let called = 0;
      let raw = "";
      globalThis.fetch = vi.fn(async (url: any) => {
        called++;
        raw = String(url);
        return new Response("{}", { status: 200 });
      }) as any;

      const rejected = await api.configGet("apps/../stop");
      expect(rejected.ok).toBe(false);
      expect(called).toBe(0);

      await api.configGet("apps/%2e%2e/stop");
      expect(new URL(raw).pathname).toBe("/config/apps/%252e%252e/stop");
    });

    it("encodes both the id and the subpath of an /id/ path", async () => {
      expect((await captureUrl((a) => a.configByIdGet("route#1"))).pathname).toBe("/id/route%231");
      expect((await captureUrl((a) => a.configByIdGet("route#1", "handle?x"))).pathname).toBe(
        "/id/route%231/handle%3Fx",
      );
      expect((await captureUrl((a) => a.configByIdSet("route#1", {}, "PATCH", "handle?x"))).pathname).toBe(
        "/id/route%231/handle%3Fx",
      );
      expect((await captureUrl((a) => a.configByIdDelete("route#1", "handle?x"))).pathname).toBe(
        "/id/route%231/handle%3Fx",
      );
    });

    it("encodes the CA id on both PKI endpoints", async () => {
      expect((await captureUrl((a) => a.getPki("ca#1"))).pathname).toBe("/pki/ca/ca%231");
      expect((await captureUrl((a) => a.getPkiCertificates("ca#1"))).pathname).toBe("/pki/ca/ca%231/certificates");
    });

    it("keys the ETag cache on the encoded path, so a read/write pair on a '#' key still sends If-Match", async () => {
      // The cache key is the composed path. Encoding on one side only would
      // silently drop optimistic concurrency for exactly these keys.
      const api = await import("../api.js");
      const calls: Array<{ method: string; ifMatch: string | null }> = [];
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        const method = opts?.method ?? "GET";
        calls.push({ method, ifMatch: opts?.headers?.["If-Match"] ?? null });
        if (method === "GET") {
          return new Response("{}", { status: 200, headers: { ETag: "encoded-key-etag" } });
        }
        return new Response("", { status: 200 });
      }) as any;

      await api.configGet("encode-probe/prod#1");
      await api.configPatch("encode-probe/prod#1", { listen: [":443"] });

      expect(calls[1]?.method).toBe("PATCH");
      expect(calls[1]?.ifMatch).toBe("encoded-key-etag");
    });
  });

  describe("request body encoding", () => {
    async function captureBody(call: (a: typeof import("../api.js")) => Promise<unknown>) {
      const api = await import("../api.js");
      let sent: any;
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        sent = opts.body;
        return new Response("{}", { status: 200 });
      }) as any;
      await call(api);
      return sent;
    }

    // A config write's body is a JSON *value*, so a string has to be
    // JSON-encoded. Sending it bare made Caddy answer
    //   500 {"error":"decoding request body: invalid character 'x' ..."}
    // which broke every string-valued write: caddy_tls set_email /
    // set_acme_ca / set_acme_profile, and caddy_config_set with a string.
    it.each([
      ["configPatch", (a: typeof import("../api.js")) => a.configPatch("apps/tls/.../email", "x@y.test")],
      ["configPost", (a: typeof import("../api.js")) => a.configPost("apps/tls/.../email", "x@y.test")],
      ["configPut", (a: typeof import("../api.js")) => a.configPut("apps/tls/.../email", "x@y.test")],
    ])("%s JSON-encodes a string value", async (_label, call) => {
      const sent = await captureBody(call);
      expect(sent).toBe('"x@y.test"');
      expect(JSON.parse(sent)).toBe("x@y.test");
    });

    it("configByIdSet JSON-encodes a string value", async () => {
      const sent = await captureBody((a) => a.configByIdSet("my-id", "some-string", "PATCH"));
      expect(sent).toBe('"some-string"');
    });

    it("still JSON-encodes objects", async () => {
      const sent = await captureBody((a) => a.configPatch("apps/tls", { automation: {} }));
      expect(JSON.parse(sent)).toEqual({ automation: {} });
    });

    // The other side of the same switch: /load and /adapt take a raw document,
    // so a string body must go out untouched. Double-encoding a Caddyfile here
    // would break both endpoints.
    it("sends a Caddyfile to /load verbatim, not JSON-encoded", async () => {
      const caddyfile = ':8080 {\n  respond "hi"\n}\n';
      const sent = await captureBody((a) => a.loadConfig(caddyfile, "text/caddyfile"));
      expect(sent).toBe(caddyfile);
    });

    it("sends a JSON config string to /load verbatim", async () => {
      const raw = '{"apps":{"http":{}}}';
      const sent = await captureBody((a) => a.loadConfig(raw, "application/json"));
      expect(sent).toBe(raw);
    });

    it("sends the adapt payload verbatim", async () => {
      const caddyfile = ":8080 {\n}\n";
      const sent = await captureBody((a) => a.adapt(caddyfile));
      expect(sent).toBe(caddyfile);
    });

    it("still JSON-encodes an object passed to /load", async () => {
      const sent = await captureBody((a) => a.loadConfig({ apps: { http: {} } }, "application/json"));
      expect(JSON.parse(sent)).toEqual({ apps: { http: {} } });
    });
  });

  describe("403 origin rejection", () => {
    // This branch is the whole reason requests work against a stock Caddy:
    // Node's fetch always sends Sec-Fetch-Mode, which makes Caddy enforce its
    // admin origin allowlist. When that still fails, this message is the only
    // thing pointing the operator at the cause.
    it("explains the admin origin allowlist on a 403 naming an origin", async () => {
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(
        async () => new Response(`{"error":"client is not allowed to access from origin ''"}`, { status: 403 }),
      ) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(false);
      expect(res.status).toBe(403);
      // Caddy's own body is preserved ahead of our explanation.
      expect(res.error).toContain("not allowed to access from origin");
      expect(res.error).toContain("CADDY_ADMIN_URL");
      expect(res.error).toContain("admin.origins");
    });

    it("leaves an unrelated 403 body alone", async () => {
      const api = await import("../api.js");
      globalThis.fetch = vi.fn(async () => new Response("forbidden: bad token", { status: 403 })) as any;

      const res = await api.configGet();
      expect(res.error).toBe("forbidden: bad token");
      expect(res.error).not.toContain("admin.origins");
    });
  });

  describe("malformed unix socket URLs", () => {
    // Both of these previously fell through to fetch and surfaced
    // "Cannot connect to Caddy admin API at null", naming neither the socket
    // nor the mistake.
    it.each([
      ["single slash after unix:", "unix:/run/caddy-admin.sock"],
      ["relative path", "unix://relative.sock"],
      ["bare scheme", "unix://"],
    ])("rejects %s with actionable guidance and never hits fetch", async (_label, adminUrl) => {
      const api = await import("../api.js");
      process.env.CADDY_ADMIN_URL = adminUrl;
      let fetchCalls = 0;
      globalThis.fetch = vi.fn(async () => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(false);
      expect(res.error).toContain("looks like a unix socket address");
      expect(res.error).toContain("unix:///absolute/path.sock");
      expect(fetchCalls).toBe(0);
    });

    it("does not retry a malformed URL despite status 0", async () => {
      // status 0 is normally treated as a transient failure and replayed; a
      // static config mistake must not burn the retry budget.
      process.env.CADDY_MAX_RETRIES = "3";
      process.env.CADDY_ADMIN_URL = "unix:/run/caddy-admin.sock";
      const api = await import("../api.js");
      let fetchCalls = 0;
      globalThis.fetch = vi.fn(async () => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(false);
      expect(fetchCalls).toBe(0);
    });

    it("does not mistake a real host starting with 'unix' for a socket", async () => {
      process.env.CADDY_ADMIN_URL = "http://unix.example.com:2019";
      const api = await import("../api.js");
      let calledUrl = "";
      globalThis.fetch = vi.fn(async (url: any) => {
        calledUrl = url.toString();
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(true);
      expect(calledUrl).toContain("unix.example.com:2019");
    });
  });

  describe("unix socket admin endpoint", () => {
    // A missing socket path is the cheapest way to prove the request was routed
    // to node:http rather than fetch: the global fetch stub stays untouched and
    // the error comes back in the socket-specific shape.
    it.each([
      ["URL form", `unix://${process.platform === "win32" ? "/nope" : "/tmp/caddy-mcp-does-not-exist.sock"}`],
      [
        "Caddy network-address form",
        `unix/${process.platform === "win32" ? "/nope" : "/tmp/caddy-mcp-does-not-exist.sock"}`,
      ],
    ])("routes %s away from fetch entirely", async (_label, adminUrl) => {
      const api = await import("../api.js");
      process.env.CADDY_ADMIN_URL = adminUrl;
      let fetchCalls = 0;
      globalThis.fetch = vi.fn(async () => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      }) as any;

      const res = await api.configGet();
      expect(res.ok).toBe(false);
      // Never fell through to the TCP transport.
      expect(fetchCalls).toBe(0);
    });

    // POSIX-only: a nonexistent path reliably yields ENOENT there. The Windows
    // named-pipe equivalent does not survive the unix:// URL form, so gating
    // keeps the assertion exact instead of loosening it to match both branches.
    it.skipIf(process.platform === "win32")(
      "reports a missing socket distinctly from a refused connection",
      async () => {
        const api = await import("../api.js");
        const sock = "/tmp/caddy-mcp-does-not-exist.sock";
        process.env.CADDY_ADMIN_URL = `unix://${sock}`;
        globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;

        const res = await api.configGet();
        expect(res.ok).toBe(false);
        expect(res.status).toBe(0);
        // Must be the socket-specific message, NOT the generic
        // "Cannot connect ... is Caddy running?" a refused connection gets --
        // the two point at different fixes (wrong path vs Caddy not running).
        expect(res.error).toContain("No socket at");
        expect(res.error).toContain(sock);
        expect(res.error).not.toContain("is Caddy running?");
      },
    );

    // The real round-trip. AF_UNIX is a POSIX deployment concern and Windows
    // uses named pipes with different semantics, so it runs where it matters.
    // The unix transport is the least-exercised code in this module, so these
    // drive a REAL unix socket rather than a mock. AF_UNIX is a POSIX
    // deployment concern and Caddy has no Windows named-pipe admin listener
    // (its admin address parser only knows unix/unixgram/unixpacket and fd),
    // so there is nothing to gain from a named-pipe variant here.
    describe.skipIf(process.platform === "win32")("against a live unix socket", () => {
      interface Captured {
        method?: string;
        url?: string;
        headers: Record<string, string | string[] | undefined>;
        body: string;
      }

      /**
       * Spin a unix-socket HTTP server that replies with `reply`, capturing the
       * request. A `reply` returning null accepts the connection and never
       * responds, which is what the timeout case needs.
       */
      async function withSocketServer(
        reply: (req: Captured) => { status?: number; headers?: Record<string, string>; body?: string } | null,
        run: (captured: Captured) => Promise<void>,
      ) {
        const { createServer } = await import("node:http");
        const { mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");

        // mkdtemp keeps the path short -- POSIX caps sun_path around 104 bytes.
        const dir = mkdtempSync(join(tmpdir(), "cmcp-"));
        const sockPath = join(dir, "s.sock");
        const captured: Captured = { headers: {}, body: "" };

        const srv = createServer((req, res) => {
          captured.method = req.method;
          captured.url = req.url;
          captured.headers = req.headers;
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            captured.body = Buffer.concat(chunks).toString("utf8");
            const r = reply(captured);
            if (r === null) return; // hang deliberately -- the timeout case
            for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
            res.statusCode = r.status ?? 200;
            res.end(r.body ?? "");
          });
        });
        await new Promise<void>((ok) => srv.listen(sockPath, ok));

        try {
          process.env.CADDY_ADMIN_URL = `unix://${sockPath}`;
          await run(captured);
        } finally {
          await new Promise<void>((ok) => srv.close(() => ok()));
          rmSync(dir, { recursive: true, force: true });
        }
      }

      /** Fetch stub that fails loudly if the unix path ever falls through to TCP. */
      function forbidFetch() {
        globalThis.fetch = vi.fn(async () => {
          throw new Error("fetch must not be used when CADDY_ADMIN_URL is a unix socket");
        }) as any;
      }

      it("completes a GET and sends NO Origin or Sec-Fetch-Mode header", async () => {
        await withSocketServer(
          () => ({ headers: { ETag: '"/config/ abc123"' }, body: JSON.stringify({ apps: { http: {} } }) }),
          async (captured) => {
            const api = await import("../api.js");
            forbidFetch();

            const res = await api.configGet<{ apps?: unknown }>();
            expect(res.ok).toBe(true);
            expect(res.data?.apps).toBeDefined();

            // The security-relevant assertion. Caddy builds NO default origin
            // allowlist for a unix admin listener and only runs its origin
            // check when the request carries Origin or Sec-Fetch-Mode -- so
            // sending either opts into a check against an empty list and 403s.
            expect(captured.headers.origin).toBeUndefined();
            expect(captured.headers["sec-fetch-mode"]).toBeUndefined();
          },
        );
      });

      it("sends a write request with its body and content type", async () => {
        // Writes are the point of this server, and req.write() plus chunked
        // encoding is a different path from the bodyless GET above.
        await withSocketServer(
          () => ({ status: 200, body: "" }),
          async (captured) => {
            const api = await import("../api.js");
            forbidFetch();

            const res = await api.configPost("apps/http/servers/srv0/routes", { handle: [{ handler: "static" }] });
            expect(res.ok).toBe(true);
            expect(captured.method).toBe("POST");
            expect(captured.url).toBe("/config/apps/http/servers/srv0/routes");
            expect(captured.headers["content-type"]).toBe("application/json");
            expect(JSON.parse(captured.body)).toEqual({ handle: [{ handler: "static" }] });
          },
        );
      });

      it("still sends Authorization when CADDY_API_TOKEN is set", async () => {
        // getHeaders returns early for the unix path; that early return sits
        // AFTER the token block. If it ever moves up, auth silently vanishes
        // on socket endpoints and only a user would notice.
        await withSocketServer(
          () => ({ body: "{}" }),
          async (captured) => {
            process.env.CADDY_API_TOKEN = "sock-token";
            const api = await import("../api.js");
            forbidFetch();

            await api.configGet();
            expect(captured.headers.authorization).toBe("Bearer sock-token");
            expect(captured.headers.origin).toBeUndefined();
          },
        );
      });

      it("maps a non-2xx socket response to the same error shape as TCP", async () => {
        // `ok` is hand-rolled here (status >= 200 && < 300) where the fetch
        // path gets res.ok for free.
        await withSocketServer(
          () => ({ status: 404, body: "key does not exist" }),
          async () => {
            const api = await import("../api.js");
            forbidFetch();

            const res = await api.configGet("apps/http/servers/nope");
            expect(res.ok).toBe(false);
            expect(res.status).toBe(404);
            expect(res.error).toBe("key does not exist");
          },
        );
      });

      it("returns an empty-body 2xx as ok with no data", async () => {
        await withSocketServer(
          () => ({ status: 200, body: "" }),
          async () => {
            const api = await import("../api.js");
            forbidFetch();

            const res = await api.configGet();
            expect(res.ok).toBe(true);
            expect(res.data).toBeUndefined();
          },
        );
      });

      it("explains enforce_origin, not CADDY_ADMIN_URL, on a 403 over a socket", async () => {
        // The TCP advice ("point CADDY_ADMIN_URL at the allowed origin") is
        // actively wrong here -- it would move the operator off the socket.
        await withSocketServer(
          () => ({ status: 403, body: `{"error":"client is not allowed to access from origin ''"}` }),
          async () => {
            const api = await import("../api.js");
            forbidFetch();

            const res = await api.configGet();
            expect(res.status).toBe(403);
            expect(res.error).toContain("enforce_origin");
            expect(res.error).not.toContain("Set CADDY_ADMIN_URL to the exact origin");
          },
        );
      });

      it("captures an ETag and replays it as If-Match on the next write", async () => {
        await withSocketServer(
          (req) => (req.method === "GET" ? { headers: { ETag: '"/config/apps 1234"' }, body: "{}" } : { body: "" }),
          async (captured) => {
            const api = await import("../api.js");
            forbidFetch();

            await api.configGet("apps");
            const res = await api.configPatch("apps", { http: {} });
            expect(res.ok).toBe(true);
            expect(captured.headers["if-match"]).toBe('"/config/apps 1234"');
          },
        );
      });

      // Node 19+ made the global http agent keep sockets alive, which exposes
      // this transport to the same stale-socket race as fetch once Caddy
      // restarts its admin endpoint after a config change. Each request must
      // therefore arrive on a connection of its own.
      it("gives every request its own connection", async () => {
        const { createServer } = await import("node:http");
        const { mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = mkdtempSync(join(tmpdir(), "cmcp-"));
        const sockPath = join(dir, "s.sock");
        const sockets: unknown[] = [];
        const srv = createServer((req, res) => {
          sockets.push(req.socket);
          res.end(req.method === "GET" ? "{}" : "");
        });
        await new Promise<void>((ok) => srv.listen(sockPath, ok));
        try {
          process.env.CADDY_ADMIN_URL = `unix://${sockPath}`;
          const api = await import("../api.js");
          forbidFetch();
          await api.configGet("apps");
          await api.configPatch("apps/http", {});
          await api.configGet("apps");
          expect(sockets).toHaveLength(3);
          expect(new Set(sockets).size).toBe(3);
        } finally {
          srv.closeAllConnections();
          await new Promise<void>((ok) => srv.close(() => ok()));
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("times out on an absolute deadline rather than an inactivity timer", async () => {
        // An absolute timer that destroys the request, not req.setTimeout (an
        // inactivity timer), and not node:http's `signal` option either, which
        // oam ignores. A server that accepts and never replies must still abort,
        // and the TimeoutError the timer rejects with must classify as a timeout
        // rather than falling through to the generic transport case.
        await withSocketServer(
          () => null,
          async () => {
            process.env.CADDY_TIMEOUT = "150";
            const api = await import("../api.js");
            forbidFetch();
            const started = Date.now();

            const res = await api.configGet();
            expect(res.ok).toBe(false);
            expect(res.status).toBe(0);
            expect(res.error).toContain("timed out after 150ms");
            expect(Date.now() - started).toBeLessThan(5000);
          },
        );
      }, 15000);

      // The same policy over node:http, whose deadline is sendViaUnixSocket's
      // own timer rather than fetch's AbortSignal -- a different error object
      // reaching the same classification. A config write whose deadline fired
      // is delivered once; a GET keeps its retries.
      it("does not replay a config write whose deadline fired, but still retries a GET", async () => {
        let requests = 0;
        await withSocketServer(
          () => {
            requests++;
            return null;
          },
          async () => {
            process.env.CADDY_MAX_RETRIES = "2";
            process.env.CADDY_TIMEOUT = "150";
            process.env.CADDY_LOAD_TIMEOUT = "200";
            const api = await import("../api.js");
            forbidFetch();

            const write = await api.configPatch("apps/http", {});
            expect(write.status).toBe(0);
            expect(write.error).toContain("Request timed out after 200ms");
            expect(write.error).toContain("Re-read the config before retrying");
            expect(requests).toBe(1);

            const read = await api.configGet("apps");
            expect(read.error).toBe("Request timed out after 150ms");
            expect(requests).toBe(4);
          },
        );
      }, 15000);
    });
  });

  // Caddy restarts its admin endpoint after every config change, and the old
  // endpoint's shutdown closes each idle keep-alive connection. These drive REAL
  // sockets through the real global fetch -- a stubbed fetch has no connection
  // pool, so it can never reproduce a request written to a socket the server
  // already dropped. That is why the mocked suites above never caught it.
  describe("surviving an admin endpoint restart (real sockets)", () => {
    interface Received {
      method: string;
      path: string;
      /** Which accepted connection carried it (1-based). */
      conn: number;
      /** The connection was open during an earlier config change, so Caddy was closing it. */
      stale: boolean;
      body: string;
    }

    type Behavior = "caddy" | "no-restart" | "reset-writes" | "hang";

    /**
     * A minimal HTTP/1.1 server on raw net sockets, so the test decides exactly
     * what happens to each connection.
     *
     * "caddy": every response is keep-alive. A successful non-GET is a config
     * change: the endpoint restarts, and the old one's shutdown closes every
     * connection that was open at that moment, this one included -- a moment
     * AFTER the response, as Caddy's does (measured within a millisecond of it).
     * A request that arrives on such a connection before the close lands is
     * answered with a TCP reset and no response byte: Caddy closed it before
     * reading, the exact shape measured against 2.11.4 (ECONNRESET / "other
     * side closed").
     *
     * "no-restart": a write is acknowledged but nothing is closed -- a `/load`
     * whose config was already the running one, or a proxy in front of the
     * admin API that keeps its own client connections open.
     *
     * "reset-writes": every non-GET is read in full and then reset without a
     * response, on whatever connection it arrives. Caddy has the request, and the
     * client cannot know whether it was applied.
     *
     * "hang": every request is read in full and never answered -- a reload that
     * outlasts the client's deadline. Caddy has the request and is still working
     * on it when the client gives up.
     */
    async function startServer(behavior: Behavior) {
      const net = await import("node:net");
      const received: Received[] = [];
      const sockets = new Set<import("node:net").Socket>();
      const stale = new WeakSet<import("node:net").Socket>();
      let connSeq = 0;

      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        const conn = ++connSeq;
        let buf = Buffer.alloc(0);

        socket.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          for (;;) {
            const headerEnd = buf.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;
            const head = buf.subarray(0, headerEnd).toString("latin1").split("\r\n");
            const [method, path] = (head[0] ?? "").split(" ");
            const headers = new Map<string, string>();
            for (const line of head.slice(1)) {
              const i = line.indexOf(":");
              if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
            }
            const length = Number(headers.get("content-length") ?? 0);
            if (buf.length < headerEnd + 4 + length) return;
            const body = buf.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
            buf = buf.subarray(headerEnd + 4 + length);

            received.push({ method, path, conn, stale: stale.has(socket), body });
            if (behavior === "hang") continue;

            const isWrite = method !== "GET";
            if (stale.has(socket) || (behavior === "reset-writes" && isWrite)) {
              socket.resetAndDestroy();
              return;
            }
            const payload = isWrite ? "" : "{}";
            const response =
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
              payload;
            if (!(isWrite && behavior === "caddy")) {
              socket.write(response);
              continue;
            }
            // The restart: every connection open right now, this one included,
            // is doomed. Caddy closes them just after the response goes out; a
            // client that dispatches its next request before that has already
            // lost the race, so the close is deliberately a short timer away.
            const doomed = [...sockets];
            for (const s of doomed) stale.add(s);
            socket.write(response, () => {
              setTimeout(() => {
                for (const s of doomed) if (!s.destroyed) s.destroy();
              }, 2);
            });
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as import("node:net").AddressInfo;
      process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${port}`;

      return {
        port,
        received,
        listenAgain: () => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve)),
        stopListening: () => new Promise<void>((resolve) => server.close(() => resolve())),
        close: async () => {
          for (const s of sockets) s.destroy();
          if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    }

    const route = { handle: [{ handler: "static_response" }] };

    // What an agent does when it calls two caddy-mcp tools back to back: create a
    // server, then add a route to it. The second POST used to be written to a
    // pooled socket the restart had closed, and POST is (rightly) never replayed,
    // so the call failed with "Cannot connect ... is Caddy running?".
    it("delivers a POST that follows a config change, exactly once", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const srv = await startServer("caddy");
      try {
        const api = await import("../api.js");
        // Several reads first, so the keep-alive pool holds idle sockets.
        for (let i = 0; i < 3; i++) expect((await api.configGet("apps")).ok).toBe(true);

        const create = await api.configPost("apps/http/servers/fresh", { listen: [":1"], routes: [] });
        expect(create.ok).toBe(true);
        const added = await api.configPost("apps/http/servers/fresh/routes", route);

        expect(added.error).toBeUndefined();
        expect(added.ok).toBe(true);
        const routePosts = srv.received.filter((r) => r.path === "/config/apps/http/servers/fresh/routes");
        expect(routePosts).toHaveLength(1);
        expect(routePosts[0]?.stale).toBe(false);
      } finally {
        await srv.close();
      }
    });

    // The mechanism behind the test above, stated directly: whatever its method,
    // no request may ride a connection that was open when an earlier config
    // change went through -- Caddy is closing every one of those. Reads before
    // any change may share a connection; that pooling is what keeps the client
    // clear of Caddy's accept-loop bug on Windows (see settleAdminRestart).
    it("never writes a request to a connection that was open during an earlier config change", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const srv = await startServer("caddy");
      try {
        const api = await import("../api.js");
        await api.configGet("apps");
        await api.configPatch("apps/http", {});
        await api.configGet("apps");
        await api.configPut("apps/http/servers/s/routes/0", route);
        await api.configDelete("apps/http/servers/s/routes/0");
        await api.configPost("apps/http/servers/s/routes", route);

        // Six calls, six deliveries: nothing was reset, so nothing was retried.
        expect(srv.received.map((r) => r.method)).toEqual(["GET", "PATCH", "GET", "PUT", "DELETE", "POST"]);
        expect(srv.received.map((r) => r.stale)).toEqual([false, false, false, false, false, false]);
        // And every request after a change is on a connection the change did not touch.
        for (let i = 1; i < srv.received.length; i++) {
          if (srv.received[i - 1]?.method !== "GET") expect(srv.received[i]?.conn).not.toBe(srv.received[i - 1]?.conn);
        }
      } finally {
        await srv.close();
      }
    });

    // (a) An idempotent read after a config change succeeds on its FIRST attempt:
    // it no longer depends on the retry budget to get past a dead socket.
    it("answers a GET that follows a config change without spending a retry", async () => {
      process.env.CADDY_MAX_RETRIES = "0";
      const srv = await startServer("caddy");
      try {
        const api = await import("../api.js");
        for (let i = 0; i < 3; i++) await api.configGet("apps");
        expect((await api.configPatch("apps/http", {})).ok).toBe(true);

        const res = await api.configGet("apps/http");
        expect(res.error).toBeUndefined();
        expect(res.ok).toBe(true);
      } finally {
        await srv.close();
      }
    });

    // The wait is for an event -- Caddy closing the pooled sockets -- not a
    // fixed delay. The server here closes them a couple of milliseconds after
    // the response; a change must come back in a fraction of the 250 ms cap.
    it("reports a config change complete as soon as the pooled sockets are closed", async () => {
      process.env.CADDY_MAX_RETRIES = "0";
      const srv = await startServer("caddy");
      try {
        const api = await import("../api.js");
        await api.configGet("apps");

        const started = performance.now();
        expect((await api.configPatch("apps/http", {})).ok).toBe(true);
        const elapsed = performance.now() - started;

        expect(elapsed).toBeLessThan(250);
        expect((await api.configGet("apps")).ok).toBe(true);
        expect(srv.received.map((r) => r.stale)).toEqual([false, false, false]);
      } finally {
        await srv.close();
      }
    });

    // A write that closes nothing -- a /load of the config already running, or
    // a proxy that keeps its connections -- waits out the cap and then carries
    // on over the connection it has: the pre-fix behavior, never anything worse.
    it("stops waiting after the cap when the server keeps its sockets open", async () => {
      process.env.CADDY_MAX_RETRIES = "0";
      const srv = await startServer("no-restart");
      try {
        const api = await import("../api.js");
        await api.configGet("apps");

        const started = performance.now();
        expect((await api.loadConfig({ apps: {} })).ok).toBe(true);
        const elapsed = performance.now() - started;

        expect(elapsed).toBeGreaterThanOrEqual(240);
        expect(elapsed).toBeLessThan(2000);
        expect((await api.configGet("apps")).ok).toBe(true);
        expect(srv.received.map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
      } finally {
        await srv.close();
      }
    });

    /**
     * Wrap the real fetch so the admin port refuses the first `refusals`
     * connection attempts and accepts after that. The listener comes back from
     * inside the failed attempt, so the timing is deterministic: the first try
     * is refused, the retry finds the port open.
     */
    function refuseFirst(srv: Awaited<ReturnType<typeof startServer>>, refusals: number) {
      let attempts = 0;
      let refused = 0;
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        attempts++;
        try {
          return await originalFetch(...args);
        } catch (err) {
          const code = (err as { cause?: { code?: string } }).cause?.code;
          if (code === "ECONNREFUSED" && ++refused === refusals) await srv.listenAgain();
          throw err;
        }
      }) as typeof fetch;
      return { attempts: () => attempts };
    }

    // (a) A read that lands while the port refuses connections is retried.
    it("retries a GET whose connection was refused, then succeeds", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      const srv = await startServer("caddy");
      try {
        await srv.stopListening();
        const counter = refuseFirst(srv, 1);
        const api = await import("../api.js");

        const res = await api.configGet("apps");
        expect(res.error).toBeUndefined();
        expect(res.ok).toBe(true);
        expect(counter.attempts()).toBe(2);
      } finally {
        await srv.close();
      }
    });

    // (b) A refused connect never sent a byte, so even an appending POST -- which
    // no other failure may replay -- is retried, and lands exactly once.
    it.each([
      ["POST under /config", (api: typeof import("../api.js")) => api.configPost("apps/http/servers/s/routes", route)],
      ["POST under /id", (api: typeof import("../api.js")) => api.configByIdSet("r1", route, "POST")],
      [
        "PUT at an array index",
        (api: typeof import("../api.js")) => api.configPut("apps/http/servers/s/routes/0", route),
      ],
      [
        "DELETE at an array index",
        (api: typeof import("../api.js")) => api.configDelete("apps/http/servers/s/routes/0"),
      ],
    ])("retries a %s whose connection was refused, and sends it once", async (_label, write) => {
      process.env.CADDY_MAX_RETRIES = "2";
      const srv = await startServer("caddy");
      try {
        await srv.stopListening();
        const counter = refuseFirst(srv, 1);
        const api = await import("../api.js");

        const res = await write(api);
        expect(res.error).toBeUndefined();
        expect(res.ok).toBe(true);
        expect(counter.attempts()).toBe(2);
        expect(srv.received).toHaveLength(1);
      } finally {
        await srv.close();
      }
    });

    // (b) A reset after Caddy read the request proves nothing about whether it was
    // applied, so a non-idempotent write is surfaced, never replayed -- even with
    // the maximum retry budget.
    it.each([
      ["POST under /config", (api: typeof import("../api.js")) => api.configPost("apps/http/servers/s/routes", route)],
      ["POST under /id", (api: typeof import("../api.js")) => api.configByIdSet("r1", route, "POST")],
      [
        "PUT at an array index",
        (api: typeof import("../api.js")) => api.configPut("apps/http/servers/s/routes/0", route),
      ],
      [
        "DELETE at an array index",
        (api: typeof import("../api.js")) => api.configDelete("apps/http/servers/s/routes/0"),
      ],
    ])("sends a %s that was reset after delivery exactly once", async (_label, write) => {
      process.env.CADDY_MAX_RETRIES = "5";
      const srv = await startServer("reset-writes");
      try {
        const api = await import("../api.js");

        const res = await write(api);
        expect(res.ok).toBe(false);
        expect(res.status).toBe(0);
        expect(res.error).toBe(`Cannot connect to Caddy admin API at http://127.0.0.1:${srv.port} — is Caddy running?`);
        expect(srv.received).toHaveLength(1);
      } finally {
        await srv.close();
      }
    });

    // (c) A Caddy that is genuinely down: every method gives up within the bound,
    // after exactly 1 + CADDY_MAX_RETRIES attempts, with the unchanged message.
    it.each([
      ["GET", (api: typeof import("../api.js")) => api.configGet("apps")],
      ["POST under /config", (api: typeof import("../api.js")) => api.configPost("apps/http/servers/s/routes", route)],
    ])("gives up on a %s to a Caddy that stays down, fast", async (_label, call) => {
      delete process.env.CADDY_MAX_RETRIES; // the default budget: 2 retries
      const srv = await startServer("caddy");
      const { port } = srv;
      await srv.close();
      let attempts = 0;
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        attempts++;
        return originalFetch(...args);
      }) as typeof fetch;
      const api = await import("../api.js");

      const started = Date.now();
      const res = await call(api);
      const elapsed = Date.now() - started;

      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.error).toBe(`Cannot connect to Caddy admin API at http://127.0.0.1:${port} — is Caddy running?`);
      expect(attempts).toBe(3);
      // Backoff is 100 ms then 200 ms, plus at most 50 ms jitter each: ~400 ms of
      // sleeping. 2 s leaves room for slow connects on a loaded machine.
      expect(elapsed).toBeLessThan(2000);
    });

    // fetch reports a refusal to a dual-stack name like `localhost` as an
    // AggregateError holding one ECONNREFUSED per address, with no code of its own.
    it("treats an AggregateError of refusals as a refusal", async () => {
      process.env.CADDY_MAX_RETRIES = "1";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          const refusal = (address: string) =>
            Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED" });
          throw new TypeError("fetch failed", {
            cause: new AggregateError([refusal("::1:2019"), refusal("127.0.0.1:2019")]),
          });
        }
        return new Response("", { status: 200 });
      }) as any;

      const res = await api.configPost("apps/http/servers/s/routes", route);
      expect(res.ok).toBe(true);
      expect(calls).toBe(2);
    });

    // The other half of that classification: a transport failure that is NOT a
    // refusal (here a reset) keeps a POST out of the retry loop.
    it("does not treat a reset as a refusal", async () => {
      process.env.CADDY_MAX_RETRIES = "3";
      const api = await import("../api.js");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        });
      }) as any;

      const res = await api.configPost("apps/http/servers/s/routes", route);
      expect(res.ok).toBe(false);
      expect(calls).toBe(1);
    });

    // The deadline, driven through the REAL fetch rather than a thrown
    // DOMException: what matters is that the error undici actually produces is
    // the one the policy recognizes. The server has the request and never
    // answers -- a reload that outlasts the client -- so a replay could only
    // queue behind it inside Caddy.
    it.each([
      ["PATCH", (api: typeof import("../api.js")) => api.configPatch("apps/http", {})],
      ["DELETE of a key", (api: typeof import("../api.js")) => api.configDelete("apps/http/servers/s")],
      ["POST /load", (api: typeof import("../api.js")) => api.loadConfig({ apps: {} })],
    ])("delivers a %s whose deadline fired exactly once", async (_label, write) => {
      process.env.CADDY_MAX_RETRIES = "5";
      process.env.CADDY_LOAD_TIMEOUT = "150";
      const srv = await startServer("hang");
      try {
        const api = await import("../api.js");

        const res = await write(api);
        expect(res.ok).toBe(false);
        expect(res.status).toBe(0);
        expect(res.error).toContain("Request timed out after 150ms");
        expect(res.error).toContain("Re-read the config before retrying");
        expect(srv.received).toHaveLength(1);
      } finally {
        await srv.close();
      }
    });

    it("still retries a GET whose deadline fired", async () => {
      process.env.CADDY_MAX_RETRIES = "2";
      process.env.CADDY_TIMEOUT = "150";
      const srv = await startServer("hang");
      try {
        const api = await import("../api.js");

        const res = await api.configGet("apps");
        expect(res.ok).toBe(false);
        expect(res.error).toBe("Request timed out after 150ms");
        expect(srv.received.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
      } finally {
        await srv.close();
      }
    });
  });
});
