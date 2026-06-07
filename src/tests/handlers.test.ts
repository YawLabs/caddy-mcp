import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse } from "../api.js";

// Mock the api module — all tests control responses via these mocks
vi.mock("../api.js", () => ({
  configGet: vi.fn(),
  configPost: vi.fn(),
  configPut: vi.fn(),
  configPatch: vi.fn(),
  configDelete: vi.fn(),
  loadConfig: vi.fn(),
  adapt: vi.fn(),
  stop: vi.fn(),
  getUpstreams: vi.fn(),
  getPki: vi.fn(),
  getPkiCertificates: vi.fn(),
  configByIdGet: vi.fn(),
  configByIdSet: vi.fn(),
  configByIdDelete: vi.fn(),
  getMetrics: vi.fn(),
}));

function ok<T>(data?: T): ApiResponse<T> {
  return { ok: true, status: 200, data };
}

function err(status: number, error: string): ApiResponse {
  return { ok: false, status, error };
}

/** Extract the handler function for a named tool from the mock server */
function getToolHandler(mockServer: { tool: ReturnType<typeof vi.fn> }, toolName: string) {
  const call = mockServer.tool.mock.calls.find((c: any[]) => c[0] === toolName);
  if (!call) throw new Error(`Tool "${toolName}" not found in mock server`);
  // handler is the last argument (position varies: name, desc, schema, hints, handler)
  return call[call.length - 1] as (...args: any[]) => Promise<any>;
}

describe("tool handler behavior", () => {
  let api: any;

  beforeEach(async () => {
    api = await import("../api.js");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── caddy_reverse_proxy ──────────────────────────────────────────────

  describe("caddy_reverse_proxy", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerRouteTools } = await import("../tools/routes.js");
      registerRouteTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_reverse_proxy");
    });

    it("builds correct route JSON and strips scheme from upstreams", async () => {
      api.configPost.mockResolvedValue(ok());

      const result = await handler({ from: "api.local", to: ["http://localhost:3000"], server: "srv0" });

      expect(api.configPost).toHaveBeenCalledWith("apps/http/servers/srv0/routes", {
        match: [{ host: ["api.local"] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:3000" }] }],
        terminal: true,
      });
      expect(result.content[0].text).toContain("Route added");
      expect(result.content[0].text).toContain("localhost:3000");
    });

    it("strips trailing slashes from upstream addresses", async () => {
      api.configPost.mockResolvedValue(ok());

      await handler({ from: "/api", to: ["localhost:3000/"], server: "srv0" });

      const routeArg = api.configPost.mock.calls[0][1];
      expect(routeArg.handle[0].upstreams[0].dial).toBe("localhost:3000");
    });

    it("returns server-not-found error when server does not exist (legacy body match, 500)", async () => {
      // Regression: keep the existing body-match path working even when status is non-404.
      api.configPost.mockResolvedValue(err(500, "key does not exist"));

      const result = await handler({ from: "app.local", to: ["localhost:3000"], server: "srv99" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server "srv99" does not exist');
      expect(result.content[0].text).toContain("caddy_list_servers");
    });

    it("returns server-not-found on a 404 status alone (no body match)", async () => {
      // Belt-and-braces: 404 must be treated as parent-missing even when the
      // body doesn't carry the legacy "key does not exist" phrase.
      api.configPost.mockResolvedValue(err(404, "Not Found"));

      const result = await handler({ from: "app.local", to: ["localhost:3000"], server: "srv99" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server "srv99" does not exist');
    });

    it("replaces in place via PUT when @id resolves to an existing route", async () => {
      // GET /id/<id> returns a route-shaped object (top-level handle array)
      // -> tool PUTs the new body in place. No POST, no clobber check fires.
      api.configByIdGet.mockResolvedValue(
        ok({
          "@id": "my-api-route",
          match: [{ host: ["old.local"] }],
          handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:9999" }] }],
          terminal: true,
        }),
      );
      api.configByIdSet.mockResolvedValue(ok());

      const result = await handler({
        from: "api.local",
        to: ["localhost:3000"],
        server: "srv0",
        id: "my-api-route",
      });

      expect(api.configByIdGet).toHaveBeenCalledWith("my-api-route");
      expect(api.configPost).not.toHaveBeenCalled();
      expect(api.configByIdSet).toHaveBeenCalledWith(
        "my-api-route",
        {
          "@id": "my-api-route",
          match: [{ host: ["api.local"] }],
          handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:3000" }] }],
          terminal: true,
        },
        "PUT",
      );
      expect(result.content[0].text).toContain('Route set @id="my-api-route"');
    });

    it("refuses to clobber when @id resolves to a non-route object", async () => {
      // The supplied id collides with a TLS issuer that the user @id'd. @ids
      // are config-global; the tool MUST refuse rather than silently overwrite
      // an unrelated subsystem's object with a route body.
      api.configByIdGet.mockResolvedValue(
        ok({
          "@id": "my-api-route",
          module: "acme",
          email: "ops@example.com",
          ca: "https://acme.example.com/dir",
        }),
      );

      const result = await handler({
        from: "api.local",
        to: ["localhost:3000"],
        server: "srv0",
        id: "my-api-route",
      });

      expect(api.configByIdGet).toHaveBeenCalledWith("my-api-route");
      // No write of any kind must happen.
      expect(api.configByIdSet).not.toHaveBeenCalled();
      expect(api.configPost).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("non-route config object");
      expect(result.content[0].text).toContain("config-global");
      // Error message should point at the recovery path so the caller doesn't
      // have to grep docs.
      expect(result.content[0].text).toContain("caddy_config_by_id");
    });

    it("refuses to clobber when @id resolves to a server (no top-level handle)", async () => {
      // Defense-in-depth: any non-route shape must refuse, not just TLS.
      api.configByIdGet.mockResolvedValue(ok({ "@id": "my-api-route", listen: [":443"], routes: [] }));

      const result = await handler({
        from: "api.local",
        to: ["localhost:3000"],
        server: "srv0",
        id: "my-api-route",
      });

      expect(api.configByIdSet).not.toHaveBeenCalled();
      expect(api.configPost).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("non-route config object");
    });

    it("first-create via id: GET 404 -> POST registers the @id", async () => {
      // GET reports the @id doesn't exist yet -> tool POSTs the route body
      // (with @id embedded) under the real config path so the @id registers.
      api.configByIdGet.mockResolvedValue(err(404, "unknown object ID"));
      api.configPost.mockResolvedValue(ok());

      const result = await handler({
        from: "api.local",
        to: ["localhost:3000"],
        server: "srv0",
        id: "new-route",
      });

      expect(api.configByIdGet).toHaveBeenCalledTimes(1);
      // Speculative PUT must NOT happen -- the GET already confirmed absent.
      expect(api.configByIdSet).not.toHaveBeenCalled();
      expect(api.configPost).toHaveBeenCalledWith("apps/http/servers/srv0/routes", {
        "@id": "new-route",
        match: [{ host: ["api.local"] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:3000" }] }],
        terminal: true,
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Route created @id="new-route"');
    });

    it("first-create via id: GET 404 + POST 'key does not exist' -> server-not-found", async () => {
      // GET 404 confirms the @id is absent. POST then fails parent-missing,
      // which now genuinely means the server doesn't exist.
      api.configByIdGet.mockResolvedValue(err(404, "unknown object ID"));
      api.configPost.mockResolvedValue(err(500, "key does not exist"));

      const result = await handler({
        from: "app.local",
        to: ["localhost:3000"],
        server: "srv99",
        id: "some-id",
      });

      expect(api.configPost).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server "srv99" does not exist');
    });

    it("first-create via id: GET 404 + POST 404 -> server-not-found", async () => {
      api.configByIdGet.mockResolvedValue(err(404, ""));
      api.configPost.mockResolvedValue(err(404, "Not Found"));

      const result = await handler({
        from: "app.local",
        to: ["localhost:3000"],
        server: "srv99",
        id: "some-id",
      });

      expect(api.configPost).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server "srv99" does not exist');
    });

    it("non-404 GET failure (e.g. 500 unrelated body) is surfaced verbatim, no speculative write", async () => {
      // A real GET error (auth failure, transport, server-side bug) must NOT
      // be reinterpreted as "first-create" -- otherwise we'd POST a route the
      // caller didn't ask to create. Loose token "unknown" by itself must not
      // trigger fallback either; only tight markers ("unknown object id" /
      // "no id found") + status 404 do.
      api.configByIdGet.mockResolvedValue(err(500, "unknown handler 'foo'"));

      const result = await handler({
        from: "api.local",
        to: ["localhost:3000"],
        server: "srv0",
        id: "some-id",
      });

      expect(api.configByIdSet).not.toHaveBeenCalled();
      expect(api.configPost).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("unknown handler 'foo'");
    });

    it("PUT failure on the replace path is surfaced verbatim", async () => {
      // GET said route is there; PUT then fails for a real reason (concurrency
      // conflict, validation, transport). Must not retry as POST -- that would
      // append a duplicate alongside the existing @id'd route.
      api.configByIdGet.mockResolvedValue(
        ok({
          "@id": "my-api-route",
          match: [{ host: ["old.local"] }],
          handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:9999" }] }],
        }),
      );
      api.configByIdSet.mockResolvedValue(err(412, "Config has been modified"));

      const result = await handler({
        from: "api.local",
        to: ["localhost:3000"],
        server: "srv0",
        id: "my-api-route",
      });

      expect(api.configPost).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Config has been modified");
    });

    it("PUT replace path: parent-missing body surfaces verbatim, NOT as server-not-found", async () => {
      // A 404 / "key does not exist" on PUT /id/<id> is ambiguous -- the more
      // common cause is a concurrent caddy_remove_route deleting the @id
      // between the GET above and the PUT, not the parent server being torn
      // down. Translating to serverNotFoundError would mislead the caller
      // about which thing is missing, so the raw body must surface as-is.
      // Regression guard against re-introducing the buggy translation.
      api.configByIdGet.mockResolvedValue(
        ok({
          "@id": "my-api-route",
          match: [{ host: ["api.local"] }],
          handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:9999" }] }],
        }),
      );
      api.configByIdSet.mockResolvedValue(err(500, "key does not exist"));

      const result = await handler({
        from: "api.local",
        to: ["localhost:3000"],
        server: "srv0",
        id: "my-api-route",
      });

      expect(api.configPost).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("key does not exist");
      expect(result.content[0].text).not.toContain("does not exist. Use caddy_list_servers");
    });
  });

  // ─── caddy_add_route ──────────────────────────────────────────────────

  describe("caddy_add_route", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerRouteTools } = await import("../tools/routes.js");
      registerRouteTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_add_route");
    });

    it("returns server-not-found error when server does not exist (legacy body match, 500)", async () => {
      // Regression: body-match path still works for non-404 statuses.
      api.configPost.mockResolvedValue(err(500, "key does not exist"));

      const result = await handler({
        match: [{ host: ["x.local"] }],
        handle: [{ handler: "file_server" }],
        server: "missing",
        terminal: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server "missing" does not exist');
    });

    it("returns server-not-found on a 404 status alone (no body match)", async () => {
      api.configPost.mockResolvedValue(err(404, "Not Found"));

      const result = await handler({
        match: [{ host: ["x.local"] }],
        handle: [{ handler: "file_server" }],
        server: "missing",
        terminal: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server "missing" does not exist');
    });
  });

  // ─── caddy_list_routes ────────────────────────────────────────────────

  describe("caddy_list_routes", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerRouteTools } = await import("../tools/routes.js");
      registerRouteTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_list_routes");
    });

    it("shows @id and group fields", async () => {
      api.configGet.mockResolvedValue(
        ok({
          listen: [":443"],
          routes: [
            {
              "@id": "my-route",
              group: "api-group",
              match: [{ host: ["api.local"] }],
              handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:3000" }] }],
              terminal: true,
            },
          ],
        }),
      );

      const result = await handler({ server: "srv0" });
      const text = result.content[0].text;

      expect(text).toContain('@id="my-route"');
      expect(text).toContain('group="api-group"');
    });

    it("shows unknown matchers with fallback", async () => {
      api.configGet.mockResolvedValue(
        ok({
          listen: [":443"],
          routes: [
            {
              match: [{ remote_ip: { ranges: ["192.168.1.0/24"] }, custom_matcher: true }],
              handle: [{ handler: "respond" }],
            },
          ],
        }),
      );

      const result = await handler({ server: "srv0" });
      const text = result.content[0].text;

      expect(text).toContain("remote_ip=[192.168.1.0/24]");
      expect(text).toContain("custom_matcher=...");
    });

    it("shows rewrite and subroute handler details", async () => {
      api.configGet.mockResolvedValue(
        ok({
          listen: [":443"],
          routes: [
            {
              match: [{ path: ["/old"] }],
              handle: [{ handler: "rewrite", uri: "/new" }],
            },
            {
              match: [{ host: ["app.local"] }],
              handle: [{ handler: "subroute", routes: [{}, {}, {}] }],
            },
          ],
        }),
      );

      const result = await handler({ server: "srv0" });
      const text = result.content[0].text;

      expect(text).toContain("rewrite(/new)");
      expect(text).toContain("subroute(3 routes)");
    });

    it("handles empty routes gracefully", async () => {
      api.configGet.mockResolvedValue(ok({ listen: [":80"], routes: [] }));

      const result = await handler({ server: "srv0" });

      expect(result.content[0].text).toContain("no routes configured");
    });
  });

  // ─── caddy_config_set modes ───────────────────────────────────────────

  describe("caddy_config_set", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerConfigTools } = await import("../tools/config.js");
      registerConfigTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_config_set");
    });

    it("uses POST for append mode", async () => {
      api.configPost.mockResolvedValue(ok());
      const result = await handler({ path: "apps/http", value: {}, mode: "append" });
      expect(api.configPost).toHaveBeenCalled();
      expect(api.configPatch).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBeDefined();
    });

    it("uses PATCH for overwrite mode", async () => {
      api.configPatch.mockResolvedValue(ok());
      const result = await handler({ path: "apps/http", value: {}, mode: "overwrite" });
      expect(api.configPatch).toHaveBeenCalled();
      expect(api.configPost).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBeDefined();
    });

    it("uses PUT for insert mode", async () => {
      api.configPut.mockResolvedValue(ok());
      const result = await handler({ path: "apps/http/servers/srv0/routes/0", value: {}, mode: "insert" });
      expect(api.configPut).toHaveBeenCalled();
      expect(api.configPost).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBeDefined();
    });
  });

  // ─── caddy_config_by_id ───────────────────────────────────────────────

  describe("caddy_config_by_id", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerConfigTools } = await import("../tools/config.js");
      registerConfigTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_config_by_id");
    });

    it("calls configByIdGet for get action", async () => {
      api.configByIdGet.mockResolvedValue(ok({ handler: "reverse_proxy" }));

      const result = await handler({ id: "my-route", action: "get", subpath: "" });

      expect(api.configByIdGet).toHaveBeenCalledWith("my-route", "");
      expect(result.content[0].text).toContain("reverse_proxy");
    });

    it("calls configByIdSet for set action", async () => {
      api.configByIdSet.mockResolvedValue(ok());

      await handler({ id: "my-route", action: "set", value: { listen: [":443"] }, subpath: "" });

      expect(api.configByIdSet).toHaveBeenCalledWith("my-route", { listen: [":443"] }, "PATCH", "");
    });

    it("uses POST for set action with mode=append", async () => {
      api.configByIdSet.mockResolvedValue(ok());

      await handler({ id: "routes", action: "set", value: { handle: [] }, subpath: "", mode: "append" });

      expect(api.configByIdSet).toHaveBeenCalledWith("routes", { handle: [] }, "POST", "");
    });

    it("uses PUT for set action with mode=insert", async () => {
      api.configByIdSet.mockResolvedValue(ok());

      await handler({ id: "my-route", action: "set", value: { handle: [] }, subpath: "", mode: "insert" });

      expect(api.configByIdSet).toHaveBeenCalledWith("my-route", { handle: [] }, "PUT", "");
    });

    it("calls configByIdDelete for delete action", async () => {
      api.configByIdDelete.mockResolvedValue(ok());

      await handler({ id: "my-route", action: "delete", subpath: "" });

      expect(api.configByIdDelete).toHaveBeenCalledWith("my-route", "");
    });

    it("returns error when set action has no value", async () => {
      const result = await handler({ id: "my-route", action: "set", value: undefined, subpath: "" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("value is required");
    });
  });

  // ─── caddy_tls (PATCH happy-path + safe-fallback branches) ────────────

  describe("caddy_tls", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerTlsTools } = await import("../tools/tls.js");
      registerTlsTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_tls");
    });

    it("uses PATCH when path already exists (no GET, no POST/PUT)", async () => {
      api.configPatch.mockResolvedValue(ok());

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(api.configPatch).toHaveBeenCalled();
      expect(api.configGet).not.toHaveBeenCalled();
      expect(api.configPost).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("test@example.com");
    });

    // Branch 1: apps/tls absent — POST a fresh structure.
    it("PATCH fails + apps/tls 404 -> POSTs fresh apps/tls", async () => {
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configGet.mockResolvedValue(err(404, "not found"));
      api.configPost.mockResolvedValue(ok());

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(api.configGet).toHaveBeenCalledWith("apps/tls");
      expect(api.configPost).toHaveBeenCalledWith("apps/tls", {
        automation: {
          policies: [{ issuers: [{ module: "acme", email: "test@example.com" }] }],
        },
      });
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("test@example.com");
    });

    it("PATCH fails + GET returns undefined data -> POSTs fresh apps/tls", async () => {
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configGet.mockResolvedValue(ok(undefined));
      api.configPost.mockResolvedValue(ok());

      const result = await handler({ action: "set_acme_ca", ca: "https://acme.example.com/dir" });

      expect(api.configPost).toHaveBeenCalledWith("apps/tls", {
        automation: {
          policies: [{ issuers: [{ module: "acme", ca: "https://acme.example.com/dir" }] }],
        },
      });
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("https://acme.example.com/dir");
    });

    // Branch 2: shape OK — deep-merge into existing config and PUT it back.
    it("PATCH fails + apps/tls exists with expected shape -> PUTs merged config (preserves siblings)", async () => {
      const existing = {
        automation: {
          policies: [{ issuers: [{ module: "acme", email: "old@example.com" }] }],
          on_demand: { rate_limit: { interval: "10s", burst: 5 } },
        },
        certificate_authorities: { custom: { name: "internal" } },
      };
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configGet.mockResolvedValue(ok(existing));
      api.configPut.mockResolvedValue(ok());

      const result = await handler({ action: "set_acme_ca", ca: "https://new.example.com/dir" });

      expect(api.configPut).toHaveBeenCalledTimes(1);
      const [putPath, putBody] = api.configPut.mock.calls[0];
      expect(putPath).toBe("apps/tls");
      // Sibling fields preserved
      expect(putBody.automation.on_demand).toEqual({ rate_limit: { interval: "10s", burst: 5 } });
      expect(putBody.certificate_authorities).toEqual({ custom: { name: "internal" } });
      // Existing email kept, ca added
      expect(putBody.automation.policies[0].issuers[0]).toEqual({
        module: "acme",
        email: "old@example.com",
        ca: "https://new.example.com/dir",
      });
      // Deep clone — original input untouched
      expect(existing.automation.policies[0].issuers[0]).toEqual({ module: "acme", email: "old@example.com" });
      expect(api.configPost).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("https://new.example.com/dir");
    });

    it("merge overwrites existing email when set_email targets a populated issuer", async () => {
      const existing = {
        automation: {
          policies: [{ issuers: [{ module: "acme", email: "old@example.com", ca: "https://old.example.com" }] }],
        },
      };
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configGet.mockResolvedValue(ok(existing));
      api.configPut.mockResolvedValue(ok());

      await handler({ action: "set_email", email: "new@example.com" });

      const [, putBody] = api.configPut.mock.calls[0];
      expect(putBody.automation.policies[0].issuers[0]).toEqual({
        module: "acme",
        email: "new@example.com",
        ca: "https://old.example.com",
      });
    });

    // Branch 3: unexpected shape — refuse, do not clobber.
    it("PATCH fails + apps/tls exists without automation -> refuses with shape-specific error", async () => {
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configGet.mockResolvedValue(ok({ certificate_authorities: { local: {} } }));

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(api.configPost).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Refusing to clobber");
      expect(result.content[0].text).toContain("automation");
      expect(result.content[0].text).toContain("caddy_config_set");
    });

    it("PATCH fails + apps/tls.automation.policies is empty -> refuses with shape-specific error", async () => {
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configGet.mockResolvedValue(ok({ automation: { policies: [] } }));

      const result = await handler({ action: "set_acme_ca", ca: "https://acme.example.com/dir" });

      expect(api.configPost).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("policies");
      expect(result.content[0].text).toContain("caddy_config_set");
    });

    it("PATCH fails + issuers empty -> refuses with shape-specific error", async () => {
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configGet.mockResolvedValue(ok({ automation: { policies: [{ issuers: [] }] } }));

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(api.configPost).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("issuers");
    });

    it("PATCH fails + issuers[0] is non-object -> refuses with shape-specific error", async () => {
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configGet.mockResolvedValue(ok({ automation: { policies: [{ issuers: ["acme"] }] } }));

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(api.configPost).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("issuers[0]");
    });

    // Failure paths through bothErrors.
    it("PATCH fails + GET non-404 error -> surfaces both PATCH and GET errors", async () => {
      api.configPatch.mockResolvedValue(err(500, "patch-err-here"));
      api.configGet.mockResolvedValue(err(500, "get-err-here"));

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(api.configPost).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("patch-err-here");
      expect(result.content[0].text).toContain("get-err-here");
    });

    it("PATCH fails + GET 404 + POST fails -> surfaces both PATCH and POST errors", async () => {
      api.configPatch.mockResolvedValue(err(500, "patch-fail"));
      api.configGet.mockResolvedValue(err(404, "not found"));
      api.configPost.mockResolvedValue(err(500, "post-fail"));

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("patch-fail");
      expect(result.content[0].text).toContain("post-fail");
    });

    it("PATCH fails + shape OK + PUT fails -> surfaces both PATCH and PUT errors", async () => {
      api.configPatch.mockResolvedValue(err(500, "patch-fail"));
      api.configGet.mockResolvedValue(ok({ automation: { policies: [{ issuers: [{ module: "acme" }] }] } }));
      api.configPut.mockResolvedValue(err(500, "put-fail"));

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("patch-fail");
      expect(result.content[0].text).toContain("put-fail");
    });

    it("returns error when email is missing for set_email", async () => {
      const result = await handler({ action: "set_email" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("email is required");
    });

    it("returns error when ca is missing for set_acme_ca", async () => {
      const result = await handler({ action: "set_acme_ca" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("ca is required");
    });

    it("returns TLS config for status action", async () => {
      api.configGet.mockResolvedValue(ok({ automation: { policies: [] } }));

      const result = await handler({ action: "status" });

      expect(api.configGet).toHaveBeenCalledWith("apps/tls");
      expect(result.content[0].text).toContain("automation");
    });
  });

  // ─── caddy_adapt ──────────────────────────────────────────────────────

  describe("caddy_adapt", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerAdaptTools } = await import("../tools/adapt.js");
      registerAdaptTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_adapt");
    });

    it("separates warnings from result", async () => {
      api.adapt.mockResolvedValue(
        ok({
          result: { apps: { http: {} } },
          warnings: [{ directive: "tls", message: "deprecated option" }],
        }),
      );

      const result = await handler({ config: "example.com { }", adapter: "caddyfile" });

      expect(result.content).toHaveLength(2);
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[0].text).toContain("tls: deprecated option");
      expect(result.content[1].text).toContain('"apps"');
    });

    it("returns only result when no warnings", async () => {
      api.adapt.mockResolvedValue(
        ok({
          result: { apps: {} },
          warnings: [],
        }),
      );

      const result = await handler({ config: "example.com { }", adapter: "caddyfile" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('"apps"');
    });
  });

  // ─── caddy_status ─────────────────────────────────────────────────────

  describe("caddy_status", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerOperationalTools } = await import("../tools/operational.js");
      registerOperationalTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_status");
    });

    it("shows HTTPS auto for port 443", async () => {
      api.configGet.mockResolvedValue(
        ok({
          apps: {
            http: {
              servers: { srv0: { listen: [":443"], routes: [] } },
            },
          },
        }),
      );

      const result = await handler({});
      expect(result.content[0].text).toContain("auto (HTTPS)");
    });

    it("shows HTTP only for port 80", async () => {
      api.configGet.mockResolvedValue(
        ok({
          apps: {
            http: {
              servers: { srv0: { listen: [":80"], routes: [] } },
            },
          },
        }),
      );

      const result = await handler({});
      expect(result.content[0].text).toContain("off (HTTP only)");
    });

    it("does not misclassify port 4430 as HTTPS (boundary-aware port match)", async () => {
      // A naive substring `.includes(":443")` matches ":4430" as well -- a
      // server on port 4430 must NOT report "auto (HTTPS)" since Caddy only
      // auto-provisions for port 443.
      api.configGet.mockResolvedValue(
        ok({
          apps: {
            http: {
              servers: { srv0: { listen: [":4430"], routes: [] } },
            },
          },
        }),
      );

      const result = await handler({});
      expect(result.content[0].text).toContain("off (HTTP only)");
      expect(result.content[0].text).not.toContain("auto (HTTPS)");
    });

    it("recognizes port 443 with a protocol suffix (e.g. `:443/h3` for QUIC)", async () => {
      // Caddy listen strings may carry protocol annotations after the port;
      // those must still classify as HTTPS-auto.
      api.configGet.mockResolvedValue(
        ok({
          apps: {
            http: {
              servers: { srv0: { listen: [":443/h3"], routes: [] } },
            },
          },
        }),
      );

      const result = await handler({});
      expect(result.content[0].text).toContain("auto (HTTPS)");
    });

    it("recognizes port 443 on a bound address (e.g. `127.0.0.1:443`)", async () => {
      api.configGet.mockResolvedValue(
        ok({
          apps: {
            http: {
              servers: { srv0: { listen: ["127.0.0.1:443"], routes: [] } },
            },
          },
        }),
      );

      const result = await handler({});
      expect(result.content[0].text).toContain("auto (HTTPS)");
    });

    it("shows enabled when tls_connection_policies present", async () => {
      api.configGet.mockResolvedValue(
        ok({
          apps: {
            http: {
              servers: { srv0: { listen: [":443"], routes: [], tls_connection_policies: [{}] } },
            },
          },
        }),
      );

      const result = await handler({});
      expect(result.content[0].text).toContain("TLS: enabled");
    });

    it("shows ACME email when present at policies[0].issuers[0].email", async () => {
      api.configGet.mockResolvedValue(
        ok({
          apps: {
            http: { servers: {} },
            tls: {
              automation: {
                policies: [{ issuers: [{ module: "acme", email: "ops@example.com" }] }],
              },
            },
          },
        }),
      );

      const result = await handler({});
      expect(result.content[0].text).toContain("ACME email: ops@example.com");
    });

    it("does not show ACME email when [0][0] is absent but later policies/issuers have one", async () => {
      api.configGet.mockResolvedValue(
        ok({
          apps: {
            http: { servers: {} },
            tls: {
              automation: {
                policies: [
                  // [0][0] has no email; [0][1] and [1][0] do.
                  { issuers: [{ module: "acme" }, { module: "acme", email: "second@example.com" }] },
                  { issuers: [{ module: "acme", email: "other-policy@example.com" }] },
                ],
              },
            },
          },
        }),
      );

      const result = await handler({});
      const text = result.content[0].text;
      expect(text).not.toContain("ACME email");
      expect(text).not.toContain("second@example.com");
      expect(text).not.toContain("other-policy@example.com");
    });
  });

  // ─── caddy_list_servers ───────────────────────────────────────────────

  describe("caddy_list_servers", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerOperationalTools } = await import("../tools/operational.js");
      registerOperationalTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_list_servers");
    });

    it("lists servers with names, routes, and listen addresses", async () => {
      api.configGet.mockResolvedValue(
        ok({
          srv0: { listen: [":443"], routes: [{}, {}] },
          api: { listen: [":8080"], routes: [{}] },
        }),
      );

      const result = await handler({});
      const text = result.content[0].text;

      expect(text).toContain("srv0: 2 route(s), listen: :443");
      expect(text).toContain("api: 1 route(s), listen: :8080");
    });

    it("shows message when no servers configured", async () => {
      api.configGet.mockResolvedValue(ok({}));

      const result = await handler({});

      expect(result.content[0].text).toContain("No HTTP servers configured");
    });
  });

  // ─── caddy_metrics ────────────────────────────────────────────────────

  describe("caddy_metrics", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerOperationalTools } = await import("../tools/operational.js");
      registerOperationalTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_metrics");
    });

    const sampleMetrics = [
      "# HELP caddy_http_requests_total Counter of HTTP requests.",
      "# TYPE caddy_http_requests_total counter",
      'caddy_http_requests_total{server="srv0",code="200"} 42',
      'caddy_http_requests_total{server="srv0",code="500"} 1',
      "# HELP caddy_tls_handshakes_total Counter of TLS handshakes.",
      "# TYPE caddy_tls_handshakes_total counter",
      "caddy_tls_handshakes_total 17",
      "# HELP go_goroutines Number of active goroutines.",
      "# TYPE go_goroutines gauge",
      "go_goroutines 23",
    ].join("\n");

    it("returns the full body when neither filter nor max_lines is provided and body is small", async () => {
      api.getMetrics.mockResolvedValue(ok(sampleMetrics));

      const result = await handler({});

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe(sampleMetrics);
    });

    it("filter substring keeps matching sample lines and their HELP/TYPE; drops others", async () => {
      api.getMetrics.mockResolvedValue(ok(sampleMetrics));

      const result = await handler({ filter: "http_requests" });
      const text = result.content[0].text;

      // Kept: HELP, TYPE, two sample lines for caddy_http_requests_total.
      expect(text).toContain("# HELP caddy_http_requests_total");
      expect(text).toContain("# TYPE caddy_http_requests_total");
      expect(text).toContain('caddy_http_requests_total{server="srv0",code="200"} 42');
      expect(text).toContain('caddy_http_requests_total{server="srv0",code="500"} 1');

      // Dropped: TLS and goroutines metrics (HELP, TYPE, samples).
      expect(text).not.toContain("caddy_tls_handshakes_total");
      expect(text).not.toContain("go_goroutines");
    });

    it("filter with no matches returns an empty body gracefully", async () => {
      api.getMetrics.mockResolvedValue(ok(sampleMetrics));

      const result = await handler({ filter: "no_such_metric_anywhere" });

      expect(result.isError).toBeFalsy();
      // No lines kept -> applyMetricsControls returns "" -> handler emits "OK".
      expect(result.content[0].text).toBe("OK");
    });

    it("max_lines truncation produces the expected trailing line with the correct dropped count", async () => {
      // 10 lines in sampleMetrics; max_lines=4 -> keep 4, drop 6.
      api.getMetrics.mockResolvedValue(ok(sampleMetrics));

      const result = await handler({ max_lines: 4 });
      const text = result.content[0].text;
      const lines = text.split("\n");

      // 4 kept lines + 1 truncation comment.
      expect(lines).toHaveLength(5);
      expect(lines[lines.length - 1]).toBe(
        "# [truncated, 6 lines omitted; max_lines=4 -- use filter or raise max_lines]",
      );
      // First four lines should be the first four of the input.
      expect(lines.slice(0, 4)).toEqual(sampleMetrics.split("\n").slice(0, 4));
    });

    it("does not truncate when line count is within max_lines", async () => {
      api.getMetrics.mockResolvedValue(ok(sampleMetrics));

      const result = await handler({ max_lines: 100 });

      expect(result.content[0].text).toBe(sampleMetrics);
      expect(result.content[0].text).not.toContain("# [truncated");
    });

    it("error path (api.getMetrics returns ok=false) surfaces the error via formatResult", async () => {
      api.getMetrics.mockResolvedValue(
        err(0, "Cannot connect to Caddy admin API at http://localhost:2019 -- is Caddy running?"),
      );

      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Cannot connect to Caddy");
    });

    it("filter and max_lines compose: filter narrows first, then truncation applies", async () => {
      api.getMetrics.mockResolvedValue(ok(sampleMetrics));

      // Filter to caddy_http_requests_total (4 lines: HELP, TYPE, 2 samples), then cap at 2.
      const result = await handler({ filter: "http_requests", max_lines: 2 });
      const text = result.content[0].text;
      const lines = text.split("\n");

      expect(lines).toHaveLength(3); // 2 kept + 1 truncation comment
      expect(lines[2]).toBe("# [truncated, 2 lines omitted; max_lines=2 -- use filter or raise max_lines]");
    });

    it("preserves the `# EOF` end-of-file marker when a filter is applied", async () => {
      const body = ["# HELP foo a counter", "# TYPE foo counter", "foo 1", "# EOF"].join("\n");
      api.getMetrics.mockResolvedValue(ok(body));

      const result = await handler({ filter: "foo" });
      const text = result.content[0].text;
      const lines = text.split("\n");

      expect(lines).toEqual(["# HELP foo a counter", "# TYPE foo counter", "foo 1", "# EOF"]);
    });

    it("preserves the `# EOF` marker even with trailing CR or whitespace (CRLF inputs)", async () => {
      // CRLF input -- the trailing \r stays attached to "# EOF" after split-on-\n.
      const body = "# HELP foo c\r\n# TYPE foo counter\r\nfoo 1\r\n# EOF\r\n";
      api.getMetrics.mockResolvedValue(ok(body));

      const result = await handler({ filter: "foo" });
      const lines = result.content[0].text.split("\n");

      // The "# EOF\r" line must be preserved; trim() tolerates the stray \r.
      expect(lines.some((l: string) => l.trim() === "# EOF")).toBe(true);
    });

    it("re-appends `# EOF` after truncation when the marker was in the dropped tail", async () => {
      // No filter: truncation cuts from the tail. If # EOF was in the dropped
      // segment, the contract is to re-emit it after the truncation comment so
      // strict downstream parsers still see a terminated stream.
      const body = [
        "# HELP a counter a",
        "# TYPE a counter",
        "a 1",
        "# HELP b counter b",
        "# TYPE b counter",
        "b 1",
        "# EOF",
      ].join("\n");
      api.getMetrics.mockResolvedValue(ok(body));

      // 7 lines total, cap at 3 -> 4 dropped (including # EOF). Output should be
      // 3 kept + truncation comment + re-emitted EOF = 5 lines.
      const result = await handler({ max_lines: 3 });
      const lines = result.content[0].text.split("\n");

      expect(lines).toHaveLength(5);
      expect(lines.slice(0, 3)).toEqual(["# HELP a counter a", "# TYPE a counter", "a 1"]);
      expect(lines[3]).toBe("# [truncated, 4 lines omitted; max_lines=3 -- use filter or raise max_lines]");
      expect(lines[4]).toBe("# EOF");
    });

    it("does not duplicate `# EOF` when it survives truncation in the kept slice", async () => {
      // If # EOF is within max_lines it stays in place; the re-append guard
      // must not duplicate it.
      const body = ["a 1", "# EOF", "trailing junk dropped"].join("\n");
      api.getMetrics.mockResolvedValue(ok(body));

      const result = await handler({ max_lines: 2 });
      const lines = result.content[0].text.split("\n");

      const eofCount = lines.filter((l: string) => l.trim() === "# EOF").length;
      expect(eofCount).toBe(1);
    });

    it("does not invent a `# EOF` when input had none", async () => {
      const body = ["a 1", "a 2", "a 3", "a 4"].join("\n");
      api.getMetrics.mockResolvedValue(ok(body));

      const result = await handler({ max_lines: 2 });
      const text = result.content[0].text;

      expect(text).not.toContain("# EOF");
    });
  });

  // ─── caddy_stop ───────────────────────────────────────────────────────

  describe("caddy_stop", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerOperationalTools } = await import("../tools/operational.js");
      registerOperationalTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_stop");
    });

    it("rejects when confirm is false", async () => {
      const result = await handler({ confirm: false });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("confirm must be true");
      expect(api.stop).not.toHaveBeenCalled();
    });

    it("calls stop and returns OK when confirm is true", async () => {
      api.stop.mockResolvedValue(ok());

      const result = await handler({ confirm: true });

      expect(api.stop).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe("OK");
    });

    it("surfaces the error when stop fails", async () => {
      api.stop.mockResolvedValue(err(500, "shutdown failed"));

      const result = await handler({ confirm: true });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("shutdown failed");
    });
  });

  // ─── caddy_load ───────────────────────────────────────────────────────

  describe("caddy_load", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const { clearSnapshots } = await import("../snapshots.js");
      clearSnapshots();
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerConfigTools } = await import("../tools/config.js");
      registerConfigTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_load");
    });

    it("sends JSON content type by default", async () => {
      api.configGet.mockResolvedValue(ok({ apps: { http: {} } }));
      api.loadConfig.mockResolvedValue(ok());

      await handler({ config: { apps: {} }, format: "json" });

      expect(api.loadConfig).toHaveBeenCalledWith({ apps: {} }, "application/json");
    });

    it("sends caddyfile content type when format is caddyfile", async () => {
      api.configGet.mockResolvedValue(ok({ apps: { http: {} } }));
      api.loadConfig.mockResolvedValue(ok());

      await handler({ config: "example.com { }", format: "caddyfile" });

      expect(api.loadConfig).toHaveBeenCalledWith("example.com { }", "text/caddyfile");
    });

    it("returns a non-error result on a successful load", async () => {
      api.configGet.mockResolvedValue(ok({ apps: { http: {} } }));
      api.loadConfig.mockResolvedValue(ok());

      const result = await handler({ config: { apps: {} }, format: "json" });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBeDefined();
    });

    it("snapshots the current config after a successful load", async () => {
      const prior = { apps: { http: { servers: { srv0: { listen: [":80"] } } } } };
      api.configGet.mockResolvedValue(ok(prior));
      api.loadConfig.mockResolvedValue(ok());

      await handler({ config: { apps: {} }, format: "json" });

      const { listSnapshots } = await import("../snapshots.js");
      const snaps = listSnapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].trigger).toBe("caddy_load");
      expect(snaps[0].config).toEqual(prior);
    });

    it("does not snapshot when the prior GET fails", async () => {
      api.configGet.mockResolvedValue(err(500, "down"));
      api.loadConfig.mockResolvedValue(ok());

      await handler({ config: { apps: {} }, format: "json" });

      const { listSnapshots } = await import("../snapshots.js");
      expect(listSnapshots()).toHaveLength(0);
    });

    it("does not snapshot when the prior GET returns a non-object body", async () => {
      // Re-applying "" / [] / null / a string via /load would fail or replay
      // garbage. Only object roots are snapshotable.
      const { listSnapshots } = await import("../snapshots.js");
      for (const bogus of ["", "raw-text", null, [], 42]) {
        api.configGet.mockResolvedValueOnce(ok(bogus));
        api.loadConfig.mockResolvedValueOnce(ok());
        await handler({ config: { apps: {} }, format: "json" });
        expect(listSnapshots()).toHaveLength(0);
      }
    });

    it("does NOT snapshot when loadConfig fails", async () => {
      // A failed load did not change anything server-side. Pushing a "pre-load"
      // snapshot would just consume a slot in the 10-deep ring and shift older
      // rollback targets one position deeper for no gain. Mirrors the same
      // deferral in caddy_revert apply.
      const prior = { apps: { http: { servers: { srv0: { listen: [":80"] } } } } };
      api.configGet.mockResolvedValue(ok(prior));
      api.loadConfig.mockResolvedValue(err(500, "config invalid"));

      const result = await handler({ config: { apps: {} }, format: "json" });

      expect(result.isError).toBe(true);
      const { listSnapshots } = await import("../snapshots.js");
      expect(listSnapshots()).toHaveLength(0);
    });
  });

  // ─── caddy_revert ─────────────────────────────────────────────────────

  describe("caddy_revert", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const { clearSnapshots } = await import("../snapshots.js");
      clearSnapshots();
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerConfigTools } = await import("../tools/config.js");
      registerConfigTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_revert");
    });

    it("list returns 'no snapshots' when empty", async () => {
      const result = await handler({ action: "list", index: 0, confirm: false });
      expect(result.content[0].text).toContain("No snapshots");
    });

    it("save captures current config as a snapshot", async () => {
      api.configGet.mockResolvedValue(ok({ apps: { http: {} } }));

      const result = await handler({ action: "save", index: 0, confirm: false });
      expect(result.isError).toBeFalsy();

      const { listSnapshots } = await import("../snapshots.js");
      const snaps = listSnapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].trigger).toBe("manual");
    });

    it("apply refuses without confirm=true", async () => {
      const { saveSnapshot } = await import("../snapshots.js");
      saveSnapshot({ apps: {} }, "caddy_load");

      const result = await handler({ action: "apply", index: 0, confirm: false });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("confirm=true");
      expect(api.loadConfig).not.toHaveBeenCalled();
    });

    it("apply errors when index is out of range", async () => {
      const result = await handler({ action: "apply", index: 5, confirm: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no snapshot at index 5");
    });

    it("apply reverts by loading the snapshotted config", async () => {
      const { saveSnapshot } = await import("../snapshots.js");
      const priorConfig = { apps: { http: { servers: { srv0: {} } } } };
      saveSnapshot(priorConfig, "caddy_load");

      api.configGet.mockResolvedValue(ok({ apps: { http: {} } }));
      api.loadConfig.mockResolvedValue(ok());

      const result = await handler({ action: "apply", index: 0, confirm: true });
      expect(result.isError).toBeFalsy();
      expect(api.loadConfig).toHaveBeenCalledWith(priorConfig, "application/json");
      expect(result.content[0].text).toContain("Reverted to snapshot");
    });

    it("apply snapshots current config before reverting", async () => {
      const { saveSnapshot, listSnapshots } = await import("../snapshots.js");
      saveSnapshot({ apps: { a: 1 } }, "caddy_load");

      const currentBefore = { apps: { b: 2 } };
      api.configGet.mockResolvedValue(ok(currentBefore));
      api.loadConfig.mockResolvedValue(ok());

      await handler({ action: "apply", index: 0, confirm: true });

      const snaps = listSnapshots();
      // Most recent snapshot should now be the caddy_revert trigger (the current config)
      expect(snaps[0].trigger).toBe("caddy_revert");
      expect(snaps[0].config).toEqual(currentBefore);
    });

    it("apply does NOT push a snapshot when loadConfig fails", async () => {
      // Regression: a failed revert must not shift the snapshot index. If the
      // pre-revert state were pushed unconditionally, a retried `apply 0` would
      // target the failed-revert's pre-state instead of the original target.
      const { saveSnapshot, listSnapshots } = await import("../snapshots.js");
      const target = { apps: { intended: true } };
      saveSnapshot(target, "caddy_load");

      api.configGet.mockResolvedValue(ok({ apps: { current: true } }));
      api.loadConfig.mockResolvedValue(err(500, "load failed"));

      const result = await handler({ action: "apply", index: 0, confirm: true });

      expect(result.isError).toBe(true);
      const snaps = listSnapshots();
      // Exactly one snapshot still -- the original target the user meant to apply.
      expect(snaps).toHaveLength(1);
      expect(snaps[0].trigger).toBe("caddy_load");
      expect(snaps[0].config).toEqual(target);
    });

    it("save refuses to capture a non-object config body", async () => {
      const { listSnapshots } = await import("../snapshots.js");
      for (const bogus of ["", "raw-text", null, [], 42]) {
        api.configGet.mockResolvedValueOnce(ok(bogus));
        const result = await handler({ action: "save", index: 0, confirm: false });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("empty or not a JSON object");
      }
      expect(listSnapshots()).toHaveLength(0);
    });
  });

  // ─── caddy_remove_route ───────────────────────────────────────────────

  describe("caddy_remove_route", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerRouteTools } = await import("../tools/routes.js");
      registerRouteTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_remove_route");
    });

    it("refuses to remove without confirm=true", async () => {
      const result = await handler({ id: "my-route", confirm: false });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("confirm=true");
      expect(api.configByIdDelete).not.toHaveBeenCalled();
    });

    it("errors if neither id nor index provided", async () => {
      const result = await handler({ confirm: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("id or index");
    });

    it("deletes by @id when id is given", async () => {
      api.configByIdDelete.mockResolvedValue(ok({}));
      const result = await handler({ id: "api-v2", confirm: true });
      expect(result.isError).toBeFalsy();
      expect(api.configByIdDelete).toHaveBeenCalledWith("api-v2");
      expect(result.content[0].text).toContain('@id="api-v2"');
    });

    it("rejects out-of-range index", async () => {
      api.configGet.mockResolvedValue(ok([{ match: [], handle: [] }]));
      const result = await handler({ index: 5, server: "srv0", confirm: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("out of range");
      expect(api.configDelete).not.toHaveBeenCalled();
    });

    it("deletes by index on named server", async () => {
      api.configGet.mockResolvedValue(
        ok([
          { match: [], handle: [] },
          { match: [], handle: [] },
        ]),
      );
      api.configDelete.mockResolvedValue(ok({}));
      const result = await handler({ index: 1, server: "srv0", confirm: true });
      expect(result.isError).toBeFalsy();
      expect(api.configDelete).toHaveBeenCalledWith("apps/http/servers/srv0/routes/1");
    });
  });

  // ─── formatResult ─────────────────────────────────────────────────────

  describe("formatResult", () => {
    it('returns "OK" for empty string data', async () => {
      const { formatResult } = await import("../format.js");
      const result = formatResult({ ok: true, status: 200, data: "" });
      expect(result.content[0].text).toBe("OK");
    });

    it('returns "OK" for undefined data', async () => {
      const { formatResult } = await import("../format.js");
      const result = formatResult({ ok: true, status: 200 });
      expect(result.content[0].text).toBe("OK");
    });

    it("returns JSON-stringified data for objects", async () => {
      const { formatResult } = await import("../format.js");
      const result = formatResult({ ok: true, status: 200, data: { key: "value" } });
      expect(result.content[0].text).toContain('"key": "value"');
    });

    it("returns error text for failed responses", async () => {
      const { formatResult } = await import("../format.js");
      const result = formatResult({ ok: false, status: 404, error: "not found" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  // ─── caddy_add_route (happy path) ─────────────────────────────────────

  describe("caddy_add_route happy path", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerRouteTools } = await import("../tools/routes.js");
      registerRouteTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_add_route");
    });

    it("POSTs the supplied match/handle/terminal verbatim under the server's routes path", async () => {
      api.configPost.mockResolvedValue(ok());
      const result = await handler({
        match: [{ host: ["x.local"], path: ["/api/*"] }],
        handle: [{ handler: "file_server", root: "/var/www" }],
        server: "srv0",
        terminal: false,
      });
      expect(api.configPost).toHaveBeenCalledWith("apps/http/servers/srv0/routes", {
        match: [{ host: ["x.local"], path: ["/api/*"] }],
        handle: [{ handler: "file_server", root: "/var/www" }],
        terminal: false,
      });
      expect(result.isError).toBeFalsy();
    });

    it("defaults terminal to true and uses srv0 when server is omitted", async () => {
      api.configPost.mockResolvedValue(ok());
      await handler({
        match: [{ host: ["x.local"] }],
        handle: [{ handler: "static_response", status_code: 204 }],
        server: "srv0",
        terminal: true,
      });
      const [path, body] = api.configPost.mock.calls[0];
      expect(path).toBe("apps/http/servers/srv0/routes");
      expect(body.terminal).toBe(true);
    });
  });

  // ─── caddy_pki ────────────────────────────────────────────────────────

  describe("caddy_pki", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerOperationalTools } = await import("../tools/operational.js");
      registerOperationalTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_pki");
    });

    it("calls getPki with the supplied ca when certificates is false", async () => {
      api.getPki.mockResolvedValue(ok({ name: "Caddy Local Authority" }));
      const result = await handler({ ca: "local", certificates: false });
      expect(api.getPki).toHaveBeenCalledWith("local");
      expect(api.getPkiCertificates).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("Caddy Local Authority");
    });

    it("calls getPkiCertificates when certificates is true", async () => {
      api.getPkiCertificates.mockResolvedValue(ok({ root: "PEM..." }));
      const result = await handler({ ca: "local", certificates: true });
      expect(api.getPkiCertificates).toHaveBeenCalledWith("local");
      expect(api.getPki).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("PEM");
    });
  });

  // ─── caddy_tls non-object GET branch ──────────────────────────────────

  describe("caddy_tls safeFallback: GET returns non-object body", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerTlsTools } = await import("../tools/tls.js");
      registerTlsTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_tls");
    });

    it("refuses to clobber when apps/tls resolves to a string", async () => {
      api.configPatch.mockResolvedValue(err(500, "patch-failed"));
      api.configGet.mockResolvedValue(ok("not-an-object"));
      const result = await handler({ action: "set_email", email: "foo@bar.com" });
      expect(api.configPost).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Refusing to clobber");
      expect(result.content[0].text).toContain("non-object value");
    });

    it("refuses to clobber when apps/tls resolves to an array", async () => {
      api.configPatch.mockResolvedValue(err(500, "patch-failed"));
      api.configGet.mockResolvedValue(ok([1, 2, 3]));
      const result = await handler({ action: "set_acme_ca", ca: "https://x.example/dir" });
      expect(api.configPost).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Refusing to clobber");
      expect(result.content[0].text).toContain("non-object value");
    });
  });

  // ─── caddy_remove_route additional branches ──────────────────────────

  describe("caddy_remove_route additional branches", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerRouteTools } = await import("../tools/routes.js");
      registerRouteTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_remove_route");
    });

    it("errors when index path reads back a non-array routes value", async () => {
      // Defensive: a malformed server config (routes is an object or string)
      // must produce a clear error, not a crash.
      api.configGet.mockResolvedValue(ok({ not: "an array" }));
      const result = await handler({ index: 0, server: "srv0", confirm: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("malformed");
      expect(api.configDelete).not.toHaveBeenCalled();
    });

    it("reports no routes configured when the routes key is absent", async () => {
      // A missing routes key (empty 200 body -> data undefined) mirrors
      // caddy_list_routes, which treats it as zero routes rather than malformed.
      api.configGet.mockResolvedValue(ok(undefined));
      const result = await handler({ index: 0, server: "srv0", confirm: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no routes configured");
      expect(api.configDelete).not.toHaveBeenCalled();
    });

    it("surfaces the api error verbatim when by-@id delete fails after confirm", async () => {
      api.configByIdDelete.mockResolvedValue(err(500, "id-delete-failed"));
      const result = await handler({ id: "missing-route", confirm: true });
      expect(api.configByIdDelete).toHaveBeenCalledWith("missing-route");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("id-delete-failed");
    });
  });

  // ─── caddy_list_routes handler-formatter branches ────────────────────

  describe("caddy_list_routes formatter branches", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerRouteTools } = await import("../tools/routes.js");
      registerRouteTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_list_routes");
    });

    it("renders authentication, error, encode, and headers handlers", async () => {
      api.configGet.mockResolvedValue(
        ok({
          listen: [":443"],
          routes: [
            {
              match: [{ path: ["/protected"] }],
              handle: [{ handler: "authentication", providers: { http_basic: {}, jwt: {} } }],
            },
            {
              match: [{ path: ["/boom"] }],
              handle: [{ handler: "error", status_code: 503 }],
            },
            {
              match: [{ path: ["/static"] }],
              handle: [{ handler: "encode" }, { handler: "headers" }],
            },
          ],
        }),
      );
      const result = await handler({ server: "srv0" });
      const text = result.content[0].text;
      expect(text).toContain("auth(http_basic,jwt)");
      expect(text).toContain("error(503)");
      expect(text).toContain("encode");
      expect(text).toContain("headers");
    });
  });

  // ─── caddy_adapt: result undefined + non-object warning ──────────────

  describe("caddy_adapt defensive branches", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerAdaptTools } = await import("../tools/adapt.js");
      registerAdaptTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_adapt");
    });

    it("emits 'OK (no output)' when adapt response has warnings but no result field", async () => {
      // Warning-only responses are real -- e.g. a Caddyfile that adapts to an
      // empty/null result while still emitting a deprecation warning.
      api.adapt.mockResolvedValue(
        ok({
          warnings: [{ directive: "tls", message: "deprecated option" }],
          // no result field
        }),
      );
      const result = await handler({ config: "x", adapter: "caddyfile" });
      expect(result.content).toHaveLength(2);
      expect(result.content[0].text).toContain("Warnings:");
      expect(result.content[1].text).toBe("OK (no output)");
    });

    it("renders a non-object warning entry via the unknown fallback", async () => {
      // formatWarning's defensive path: warnings array contains a primitive.
      api.adapt.mockResolvedValue(
        ok({
          result: { apps: {} },
          warnings: ["just a string", 42],
        }),
      );
      const result = await handler({ config: "x", adapter: "caddyfile" });
      expect(result.content[0].text).toContain("unknown:");
      expect(result.content[0].text).toContain('"just a string"');
      expect(result.content[0].text).toContain("42");
    });
  });

  // ─── caddy_status: apps.http.servers absent ──────────────────────────

  describe("caddy_status missing apps/http/servers", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerOperationalTools } = await import("../tools/operational.js");
      registerOperationalTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_status");
    });

    it("reports 'No HTTP servers' when apps.http is absent (not just empty)", async () => {
      // Optional-chain fallback path: config.apps.http is undefined, not {}.
      api.configGet.mockResolvedValue(ok({ apps: {} }));
      const result = await handler({});
      expect(result.content[0].text).toContain("No HTTP servers configured");
    });

    it("reports 'No HTTP servers' when apps itself is absent", async () => {
      api.configGet.mockResolvedValue(ok({}));
      const result = await handler({});
      expect(result.content[0].text).toContain("No HTTP servers configured");
    });
  });

  // ─── Snapshots ring eviction ─────────────────────────────────────────

  describe("snapshots ring buffer", () => {
    it("caps at MAX_SNAPSHOTS=10 and evicts the oldest when an 11th is pushed", async () => {
      const { clearSnapshots, saveSnapshot, listSnapshots } = await import("../snapshots.js");
      clearSnapshots();
      for (let i = 0; i < 11; i++) {
        saveSnapshot({ generation: i }, `seed-${i}`);
      }
      const snaps = listSnapshots();
      expect(snaps).toHaveLength(10);
      // Newest at index 0, oldest at index 9. Generation 0 must have been
      // evicted; generation 10 (newest) must be at the front.
      expect(snaps[0]?.trigger).toBe("seed-10");
      expect((snaps[0]?.config as { generation: number }).generation).toBe(10);
      expect(snaps[9]?.trigger).toBe("seed-1");
      expect(snaps.some((s) => s.trigger === "seed-0")).toBe(false);
    });
  });

  // ─── Resource handler responses ──────────────────────────────────────

  describe("resource handlers", () => {
    /** Capture and invoke a registered resource handler by name. */
    async function getResourceHandler(name: string) {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerResources } = await import("../resources.js");
      registerResources(mockServer as any);
      const call = mockServer.resource.mock.calls.find((c: any[]) => c[0] === name);
      if (!call) throw new Error(`Resource "${name}" not registered`);
      // server.resource signature is (name, uri, opts, handler) -- handler is last.
      return call[call.length - 1] as () => Promise<any>;
    }

    it("caddy://config: JSON mimeType + body on success", async () => {
      api.configGet.mockResolvedValue(ok({ apps: { http: {} } }));
      const handler = await getResourceHandler("caddy-config");
      const result = await handler();
      expect(result.contents[0].mimeType).toBe("application/json");
      expect(() => JSON.parse(result.contents[0].text)).not.toThrow();
    });

    it("caddy://config: text/plain mimeType + Error: prefix on failure", async () => {
      api.configGet.mockResolvedValue(err(500, "down"));
      const handler = await getResourceHandler("caddy-config");
      const result = await handler();
      expect(result.contents[0].mimeType).toBe("text/plain");
      expect(result.contents[0].text).toMatch(/^Error: /);
    });

    it("caddy://upstreams: JSON mimeType on success, text/plain on failure", async () => {
      api.getUpstreams.mockResolvedValueOnce(ok([{ address: "localhost:3000", num_requests: 0 }]));
      let handler = await getResourceHandler("caddy-upstreams");
      let result = await handler();
      expect(result.contents[0].mimeType).toBe("application/json");

      api.getUpstreams.mockResolvedValueOnce(err(0, "fetch failed"));
      handler = await getResourceHandler("caddy-upstreams");
      result = await handler();
      expect(result.contents[0].mimeType).toBe("text/plain");
      expect(result.contents[0].text).toMatch(/^Error: /);
    });

    it("caddy://servers: JSON mimeType on success, text/plain on failure", async () => {
      api.configGet.mockResolvedValueOnce(ok({ srv0: { listen: [":443"], routes: [] } }));
      let handler = await getResourceHandler("caddy-servers");
      let result = await handler();
      expect(result.contents[0].mimeType).toBe("application/json");

      api.configGet.mockResolvedValueOnce(err(404, "not found"));
      handler = await getResourceHandler("caddy-servers");
      result = await handler();
      expect(result.contents[0].mimeType).toBe("text/plain");
      expect(result.contents[0].text).toMatch(/^Error: /);
    });

    it("caddy://metrics: text/plain mimeType in both success and failure", async () => {
      api.getMetrics.mockResolvedValueOnce(ok("# HELP foo bar\nfoo 1\n"));
      let handler = await getResourceHandler("caddy-metrics");
      let result = await handler();
      expect(result.contents[0].mimeType).toBe("text/plain");
      expect(result.contents[0].text).toContain("foo 1");

      api.getMetrics.mockResolvedValueOnce(err(0, "Cannot connect"));
      handler = await getResourceHandler("caddy-metrics");
      result = await handler();
      expect(result.contents[0].mimeType).toBe("text/plain");
      expect(result.contents[0].text).toMatch(/^Error: /);
    });
  });
});
