import { afterEach, describe, expect, it, vi } from "vitest";

describe("caddy-mcp tools", () => {
  it("registers exactly 17 tools", async () => {
    const registeredTools: string[] = [];
    const mockServer = {
      tool: vi.fn((...args: any[]) => {
        registeredTools.push(args[0]);
      }),
      resource: vi.fn(),
    };

    // Import and call all register functions
    const { registerConfigTools } = await import("../tools/config.js");
    const { registerRouteTools } = await import("../tools/routes.js");
    const { registerAdaptTools } = await import("../tools/adapt.js");
    const { registerTlsTools } = await import("../tools/tls.js");
    const { registerOperationalTools } = await import("../tools/operational.js");
    const { registerResources } = await import("../resources.js");

    registerConfigTools(mockServer as any);
    registerRouteTools(mockServer as any);
    registerAdaptTools(mockServer as any);
    registerTlsTools(mockServer as any);
    registerOperationalTools(mockServer as any);
    registerResources(mockServer as any);

    expect(registeredTools.length).toBe(17);
  });

  it("all tool names start with caddy_", async () => {
    const registeredTools: string[] = [];
    const mockServer = {
      tool: vi.fn((...args: any[]) => {
        registeredTools.push(args[0]);
      }),
      resource: vi.fn(),
    };

    const { registerConfigTools } = await import("../tools/config.js");
    const { registerRouteTools } = await import("../tools/routes.js");
    const { registerAdaptTools } = await import("../tools/adapt.js");
    const { registerTlsTools } = await import("../tools/tls.js");
    const { registerOperationalTools } = await import("../tools/operational.js");

    registerConfigTools(mockServer as any);
    registerRouteTools(mockServer as any);
    registerAdaptTools(mockServer as any);
    registerTlsTools(mockServer as any);
    registerOperationalTools(mockServer as any);

    for (const name of registeredTools) {
      expect(name).toMatch(/^caddy_/);
    }
  });

  it("all tools have unique names", async () => {
    const registeredTools: string[] = [];
    const mockServer = {
      tool: vi.fn((...args: any[]) => {
        registeredTools.push(args[0]);
      }),
      resource: vi.fn(),
    };

    const { registerConfigTools } = await import("../tools/config.js");
    const { registerRouteTools } = await import("../tools/routes.js");
    const { registerAdaptTools } = await import("../tools/adapt.js");
    const { registerTlsTools } = await import("../tools/tls.js");
    const { registerOperationalTools } = await import("../tools/operational.js");

    registerConfigTools(mockServer as any);
    registerRouteTools(mockServer as any);
    registerAdaptTools(mockServer as any);
    registerTlsTools(mockServer as any);
    registerOperationalTools(mockServer as any);

    expect(new Set(registeredTools).size).toBe(registeredTools.length);
  });

  const expectedTools = [
    "caddy_config_get",
    "caddy_config_set",
    "caddy_config_delete",
    "caddy_load",
    "caddy_config_by_id",
    "caddy_reverse_proxy",
    "caddy_add_route",
    "caddy_list_routes",
    "caddy_adapt",
    "caddy_tls",
    "caddy_status",
    "caddy_list_servers",
    "caddy_upstreams",
    "caddy_pki",
    "caddy_metrics",
    "caddy_stop",
  ];

  for (const name of expectedTools) {
    it(`registers tool: ${name}`, async () => {
      const registeredTools: string[] = [];
      const mockServer = {
        tool: vi.fn((...args: any[]) => {
          registeredTools.push(args[0]);
        }),
        resource: vi.fn(),
      };

      const { registerConfigTools } = await import("../tools/config.js");
      const { registerRouteTools } = await import("../tools/routes.js");
      const { registerAdaptTools } = await import("../tools/adapt.js");
      const { registerTlsTools } = await import("../tools/tls.js");
      const { registerOperationalTools } = await import("../tools/operational.js");

      registerConfigTools(mockServer as any);
      registerRouteTools(mockServer as any);
      registerAdaptTools(mockServer as any);
      registerTlsTools(mockServer as any);
      registerOperationalTools(mockServer as any);

      expect(registeredTools).toContain(name);
    });
  }

  it("all tools have descriptions", async () => {
    const descriptions: string[] = [];
    const mockServer = {
      tool: vi.fn((...args: any[]) => {
        descriptions.push(args[1]);
      }),
      resource: vi.fn(),
    };

    const { registerConfigTools } = await import("../tools/config.js");
    const { registerRouteTools } = await import("../tools/routes.js");
    const { registerAdaptTools } = await import("../tools/adapt.js");
    const { registerTlsTools } = await import("../tools/tls.js");
    const { registerOperationalTools } = await import("../tools/operational.js");

    registerConfigTools(mockServer as any);
    registerRouteTools(mockServer as any);
    registerAdaptTools(mockServer as any);
    registerTlsTools(mockServer as any);
    registerOperationalTools(mockServer as any);

    for (const desc of descriptions) {
      expect(desc).toBeTruthy();
      expect(typeof desc).toBe("string");
    }
  });

  describe("parseFrom", () => {
    it("parses bare hostname", async () => {
      const { parseFrom } = await import("../tools/routes.js");
      expect(parseFrom("api.local")).toEqual({ host: ["api.local"] });
    });

    it("parses bare path", async () => {
      const { parseFrom } = await import("../tools/routes.js");
      expect(parseFrom("/api/*")).toEqual({ path: ["/api/*"] });
    });

    it("parses hostname + path", async () => {
      const { parseFrom } = await import("../tools/routes.js");
      expect(parseFrom("app.local/ws")).toEqual({ host: ["app.local"], path: ["/ws"] });
    });

    it("strips http:// scheme", async () => {
      const { parseFrom } = await import("../tools/routes.js");
      expect(parseFrom("http://api.local/test")).toEqual({ host: ["api.local"], path: ["/test"] });
    });

    it("strips https:// scheme", async () => {
      const { parseFrom } = await import("../tools/routes.js");
      expect(parseFrom("https://example.com")).toEqual({ host: ["example.com"] });
    });
  });

  it("registers 2 resources", async () => {
    const resources: string[] = [];
    const mockServer = {
      tool: vi.fn(),
      resource: vi.fn((...args: any[]) => {
        resources.push(args[0]);
      }),
    };

    const { registerResources } = await import("../resources.js");
    registerResources(mockServer as any);

    expect(resources.length).toBe(4);
  });

  describe("adapter validation", () => {
    async function getAdaptSchema() {
      const calls: any[] = [];
      const mockServer = {
        tool: vi.fn((...args: any[]) => calls.push(args)),
        resource: vi.fn(),
      };
      const { registerAdaptTools } = await import("../tools/adapt.js");
      registerAdaptTools(mockServer as any);
      return calls[0][2];
    }

    it("accepts valid adapter names", async () => {
      const schema = await getAdaptSchema();
      expect(() => schema.adapter.parse("caddyfile")).not.toThrow();
      expect(() => schema.adapter.parse("nginx")).not.toThrow();
      expect(() => schema.adapter.parse("my_adapter")).not.toThrow();
      expect(() => schema.adapter.parse("my-adapter-v2")).not.toThrow();
    });

    it("rejects adapter names with CRLF (header injection)", async () => {
      const schema = await getAdaptSchema();
      expect(() => schema.adapter.parse("caddyfile\r\nX-Evil: 1")).toThrow();
      expect(() => schema.adapter.parse("bad\nvalue")).toThrow();
    });

    it("rejects adapter names with special chars", async () => {
      const schema = await getAdaptSchema();
      expect(() => schema.adapter.parse("bad/value")).toThrow();
      expect(() => schema.adapter.parse("bad;value")).toThrow();
      expect(() => schema.adapter.parse("bad value")).toThrow();
      expect(() => schema.adapter.parse("")).toThrow();
    });
  });

  describe("identifier regex bounds", () => {
    async function getConfigByIdSchema() {
      const calls: any[] = [];
      const mockServer = {
        tool: vi.fn((...args: any[]) => calls.push(args)),
        resource: vi.fn(),
      };
      const { registerConfigTools } = await import("../tools/config.js");
      registerConfigTools(mockServer as any);
      return calls.find((c) => c[0] === "caddy_config_by_id")?.[2];
    }

    it("accepts ids within length bound", async () => {
      const schema = await getConfigByIdSchema();
      expect(() => schema.id.parse("my-route")).not.toThrow();
      expect(() => schema.id.parse("a".repeat(128))).not.toThrow();
    });

    it("rejects ids exceeding length bound", async () => {
      const schema = await getConfigByIdSchema();
      expect(() => schema.id.parse("a".repeat(129))).toThrow();
      expect(() => schema.id.parse("a".repeat(10000))).toThrow();
    });
  });

  describe("caddy_config_set default mode", () => {
    it("defaults to overwrite (PATCH), not append", async () => {
      const calls: any[] = [];
      const mockServer = {
        tool: vi.fn((...args: any[]) => calls.push(args)),
        resource: vi.fn(),
      };
      const { registerConfigTools } = await import("../tools/config.js");
      registerConfigTools(mockServer as any);
      const schema = calls.find((c) => c[0] === "caddy_config_set")?.[2];
      const parsed = schema.mode.parse(undefined);
      expect(parsed).toBe("overwrite");
    });
  });

  describe("caddy_list_routes robustness", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    async function getListRoutesHandler() {
      const calls: any[] = [];
      const mockServer = {
        tool: vi.fn((...args: any[]) => calls.push(args)),
        resource: vi.fn(),
      };
      const { registerRouteTools } = await import("../tools/routes.js");
      registerRouteTools(mockServer as any);
      return calls.find((c) => c[0] === "caddy_list_routes")?.[4];
    }

    it("does not throw on null/non-object routes", async () => {
      const handler = await getListRoutesHandler();
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              listen: [":443"],
              routes: [null, "string-route", 42, { match: [], handle: [] }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ) as any;
      const result = await handler({ server: "srv0" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Route 0: <invalid>");
      expect(result.content[0].text).toContain("Route 1: <invalid>");
      expect(result.content[0].text).toContain("Route 2: <invalid>");
    });

    it("does not throw on non-array match/handle fields", async () => {
      const handler = await getListRoutesHandler();
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              listen: [":443"],
              routes: [{ match: "not-array", handle: null }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ) as any;
      const result = await handler({ server: "srv0" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Route 0:");
    });

    it("does not throw on non-array matcher fields (host/path/method)", async () => {
      const handler = await getListRoutesHandler();
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              listen: [":443"],
              routes: [
                {
                  match: [{ host: null, path: "not-array", method: [null, 123, "GET"] }],
                  handle: [],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ) as any;
      const result = await handler({ server: "srv0" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("method=[123,GET]");
    });

    it("does not throw on non-array upstreams / subroute routes", async () => {
      const handler = await getListRoutesHandler();
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              listen: [":443"],
              routes: [
                {
                  match: [],
                  handle: [
                    { handler: "reverse_proxy", upstreams: "not-array" },
                    { handler: "subroute", routes: "nope" },
                  ],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ) as any;
      const result = await handler({ server: "srv0" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("reverse_proxy()");
      expect(result.content[0].text).toContain("subroute(0 routes)");
    });

    it("handles non-string @id and group without crashing", async () => {
      const handler = await getListRoutesHandler();
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              listen: [":443"],
              routes: [{ "@id": 42, group: true, match: [], handle: [] }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ) as any;
      const result = await handler({ server: "srv0" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).not.toContain('@id="42"');
      expect(result.content[0].text).not.toContain('group="true"');
    });
  });

  describe("caddy_tls set_email error surfacing", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    async function getTlsHandler() {
      const calls: any[] = [];
      const mockServer = {
        tool: vi.fn((...args: any[]) => calls.push(args)),
        resource: vi.fn(),
      };
      const { registerTlsTools } = await import("../tools/tls.js");
      registerTlsTools(mockServer as any);
      return calls.find((c) => c[0] === "caddy_tls")?.[4];
    }

    it("surfaces both PATCH and POST errors when fallback fails", async () => {
      const handler = await getTlsHandler();
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        if (opts?.method === "PATCH") {
          return new Response("patch-reason-unique", { status: 500 });
        }
        if (opts?.method === "POST") {
          return new Response("post-reason-unique", { status: 500 });
        }
        return new Response("{}", { status: 200 });
      }) as any;
      const result = await handler({ action: "set_email", email: "foo@bar.com" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("patch-reason-unique");
      expect(result.content[0].text).toContain("post-reason-unique");
    });

    it("surfaces both errors for set_acme_ca too", async () => {
      const handler = await getTlsHandler();
      globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
        if (opts?.method === "PATCH") {
          return new Response("acme-patch-err", { status: 500 });
        }
        if (opts?.method === "POST") {
          return new Response("acme-post-err", { status: 500 });
        }
        return new Response("{}", { status: 200 });
      }) as any;
      const result = await handler({ action: "set_acme_ca", ca: "https://ca.example.com/directory" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("acme-patch-err");
      expect(result.content[0].text).toContain("acme-post-err");
    });
  });

  describe("api connection-error message", () => {
    const originalFetch = globalThis.fetch;
    const savedUrl = process.env.CADDY_ADMIN_URL;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (savedUrl !== undefined) {
        process.env.CADDY_ADMIN_URL = savedUrl;
      } else {
        delete process.env.CADDY_ADMIN_URL;
      }
    });

    it("strips query/path from URL in connect-failed message", async () => {
      process.env.CADDY_ADMIN_URL = "http://caddy.local:2019/some/path?token=secret";
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as any;
      const api = await import("../api.js");
      const res = await api.configGet();
      expect(res.ok).toBe(false);
      expect(res.error).toContain("http://caddy.local:2019");
      expect(res.error).not.toContain("token=secret");
      expect(res.error).not.toContain("/some/path");
    });
  });
});
