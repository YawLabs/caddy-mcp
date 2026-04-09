import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

describe("caddy-mcp tools", () => {
  it("registers exactly 13 tools", async () => {
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

    expect(registeredTools.length).toBe(13);
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
    "caddy_reverse_proxy",
    "caddy_add_route",
    "caddy_list_routes",
    "caddy_adapt",
    "caddy_tls",
    "caddy_status",
    "caddy_upstreams",
    "caddy_pki",
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

    expect(resources.length).toBe(2);
  });
});
