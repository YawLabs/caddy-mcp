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

    it("returns server-not-found error when server does not exist", async () => {
      api.configPost.mockResolvedValue(err(500, "key does not exist"));

      const result = await handler({ from: "app.local", to: ["localhost:3000"], server: "srv99" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server "srv99" does not exist');
      expect(result.content[0].text).toContain("caddy_list_servers");
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

    it("returns server-not-found error when server does not exist", async () => {
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
      await handler({ path: "apps/http", value: {}, mode: "append" });
      expect(api.configPost).toHaveBeenCalled();
      expect(api.configPatch).not.toHaveBeenCalled();
      expect(api.configPut).not.toHaveBeenCalled();
    });

    it("uses PATCH for overwrite mode", async () => {
      api.configPatch.mockResolvedValue(ok());
      await handler({ path: "apps/http", value: {}, mode: "overwrite" });
      expect(api.configPatch).toHaveBeenCalled();
      expect(api.configPost).not.toHaveBeenCalled();
    });

    it("uses PUT for insert mode", async () => {
      api.configPut.mockResolvedValue(ok());
      await handler({ path: "apps/http/servers/srv0/routes/0", value: {}, mode: "insert" });
      expect(api.configPut).toHaveBeenCalled();
      expect(api.configPost).not.toHaveBeenCalled();
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

  // ─── caddy_tls fallback ───────────────────────────────────────────────

  describe("caddy_tls", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerTlsTools } = await import("../tools/tls.js");
      registerTlsTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_tls");
    });

    it("uses PATCH when path already exists", async () => {
      api.configPatch.mockResolvedValue(ok());

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(api.configPatch).toHaveBeenCalled();
      expect(api.configPost).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("test@example.com");
    });

    it("falls back to POST when PATCH fails (fresh instance)", async () => {
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configPost.mockResolvedValue(ok());

      const result = await handler({ action: "set_email", email: "test@example.com" });

      expect(api.configPatch).toHaveBeenCalled();
      expect(api.configPost).toHaveBeenCalledWith("apps/tls", {
        automation: {
          policies: [{ issuers: [{ module: "acme", email: "test@example.com" }] }],
        },
      });
      expect(result.content[0].text).toContain("test@example.com");
    });

    it("falls back to POST for set_acme_ca on fresh instance", async () => {
      api.configPatch.mockResolvedValue(err(500, "key does not exist"));
      api.configPost.mockResolvedValue(ok());

      const result = await handler({ action: "set_acme_ca", ca: "https://acme.example.com/dir" });

      expect(api.configPost).toHaveBeenCalledWith("apps/tls", {
        automation: {
          policies: [{ issuers: [{ module: "acme", ca: "https://acme.example.com/dir" }] }],
        },
      });
      expect(result.content[0].text).toContain("https://acme.example.com/dir");
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

    it("calls stop when confirm is true", async () => {
      api.stop.mockResolvedValue(ok());

      await handler({ confirm: true });

      expect(api.stop).toHaveBeenCalled();
    });
  });

  // ─── caddy_load ───────────────────────────────────────────────────────

  describe("caddy_load", () => {
    let handler: (...args: any[]) => Promise<any>;

    beforeEach(async () => {
      const mockServer = { tool: vi.fn(), resource: vi.fn() };
      const { registerConfigTools } = await import("../tools/config.js");
      registerConfigTools(mockServer as any);
      handler = getToolHandler(mockServer, "caddy_load");
    });

    it("sends JSON content type by default", async () => {
      api.loadConfig.mockResolvedValue(ok());

      await handler({ config: { apps: {} }, format: "json" });

      expect(api.loadConfig).toHaveBeenCalledWith({ apps: {} }, "application/json");
    });

    it("sends caddyfile content type when format is caddyfile", async () => {
      api.loadConfig.mockResolvedValue(ok());

      await handler({ config: "example.com { }", format: "caddyfile" });

      expect(api.loadConfig).toHaveBeenCalledWith("example.com { }", "text/caddyfile");
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
});
