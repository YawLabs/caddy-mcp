import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCaddyServer, version } from "../server.js";

const require_ = createRequire(import.meta.url);
const pkg = require_("../../package.json") as { version: string };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_CLI = join(REPO_ROOT, "dist", "index.js");

/**
 * Connect the real server to a real MCP client over an in-memory transport.
 *
 * Every other test in this suite registers tools against a hand-rolled
 * `{ tool: vi.fn(), resource: vi.fn() }`, which records names and validates
 * NOTHING. The real McpServer converts each zod shape into a JSON Schema at
 * registration time and serializes it on tools/list -- so a schema the SDK
 * rejects passes every mock-based test and throws on first launch. This is the
 * only path that catches that class of break.
 */
async function connectedClient() {
  const server = createCaddyServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "caddy-mcp-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("server assembly", () => {
  let open: Client | undefined;

  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  it("constructs without throwing", () => {
    // Registration is where a malformed zod shape blows up.
    expect(() => createCaddyServer()).not.toThrow();
  });

  it("serves tools/list over a real transport with all 18 tools", async () => {
    open = await connectedClient();
    const { tools } = await open.listTools();

    expect(tools).toHaveLength(18);
    expect(new Set(tools.map((t) => t.name)).size).toBe(18);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^caddy_/);
      expect(tool.description).toBeTruthy();
    }
  });

  it("serializes every tool's input schema to a valid JSON Schema object", async () => {
    // The assertion a vi.fn() mock cannot make: the zod shape survived
    // conversion and round-tripped through JSON-RPC intact.
    open = await connectedClient();
    const { tools } = await open.listTools();

    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} has no inputSchema`).toBeDefined();
      expect(tool.inputSchema.type, `${tool.name} schema is not an object schema`).toBe("object");
      // Must survive a JSON round-trip -- that is what the transport does.
      expect(() => JSON.parse(JSON.stringify(tool.inputSchema))).not.toThrow();
    }
  });

  it("exposes the documented required/optional params on a representative tool", async () => {
    // Guards against a schema that serializes but loses its shape --
    // caddy_reverse_proxy's `from`/`to` are required, `server`/`id` are not.
    open = await connectedClient();
    const { tools } = await open.listTools();
    const rp = tools.find((t) => t.name === "caddy_reverse_proxy");

    expect(rp).toBeDefined();
    const schema = rp?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["from", "id", "server", "to"]);
    expect((schema.required ?? []).sort()).toEqual(["from", "to"]);
  });

  // GHSA-6859-g3p8-jc93 was about what a HOST sees: a client that auto-approves
  // on destructiveHint:false let a root caddy_config_set replace the entire
  // config unasked. tools.test.ts reads the raw argument handed to server.tool,
  // which would still pass if the SDK dropped or misread it -- this reads what
  // actually crosses the wire.
  it("advertises caddy_config_set as destructive, with an optional boolean confirm, over tools/list", async () => {
    open = await connectedClient();
    const { tools } = await open.listTools();
    const set = tools.find((t) => t.name === "caddy_config_set");

    expect(set).toBeDefined();
    expect(set?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    const schema = set?.inputSchema as {
      properties?: Record<string, { type?: string; default?: unknown }>;
      required?: string[];
    };
    expect(schema.properties?.confirm?.type).toBe("boolean");
    expect(schema.properties?.confirm?.default).toBe(false);
    expect(schema.required ?? []).not.toContain("confirm");
  });

  it("serves resources/list with the four caddy:// resources", async () => {
    open = await connectedClient();
    const { resources } = await open.listResources();

    expect(resources).toHaveLength(4);
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "caddy://config",
      "caddy://metrics",
      "caddy://servers",
      "caddy://upstreams",
    ]);
  });
});

// The advisory's own reproduction, driven the way the reporter drove it: a real
// MCP client and a real tools/call, so zod's schema defaults are applied exactly
// as they are for a host. The handler tests call the handler directly and skip
// that layer, so a schema that lost `confirm` -- or defaulted it to anything
// but false -- would get past every one of them.
describe("GHSA-6859-g3p8-jc93 over the real protocol", () => {
  const originalFetch = globalThis.fetch;
  let open: Client | undefined;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await open?.close();
    open = undefined;
  });

  type CallResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
  const lockprobe = { apps: { http: { servers: { lockprobe: { listen: [":9595"], routes: [] } } } } };

  it("refuses the advisory's PoC call -- a root path with no confirm -- and sends nothing to Caddy", async () => {
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, opts: any) => {
      sent.push(`${opts?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      return new Response("{}", { status: 200 });
    }) as any;
    open = await connectedClient();

    const res = (await open.callTool({
      name: "caddy_config_set",
      arguments: { path: "", value: lockprobe },
    })) as CallResult;

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("ENTIRE config");
    expect(res.content[0].text).toContain("confirm=true");
    expect(sent).toEqual([]);
  });

  it("lets the same call through once confirm=true arrives over the wire, reading first and writing the canonical root", async () => {
    // Proves confirm survives the schema as `true`, not only that its default
    // is false: the handler reads the config, then PATCHes /config/ (the
    // default mode, applied by zod), and reports the snapshot.
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, opts: any) => {
      const method = opts?.method ?? "GET";
      sent.push(`${method} ${new URL(String(url)).pathname}`);
      return method === "GET"
        ? new Response(JSON.stringify({ apps: { http: { servers: { srv0: { listen: [":8080"] } } } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(null, { status: 200 });
    }) as any;
    open = await connectedClient();

    const res = (await open.callTool({
      name: "caddy_config_set",
      arguments: { path: "/config/...", value: lockprobe, confirm: true },
    })) as CallResult;

    expect(res.isError, res.content[0]?.text).toBeFalsy();
    expect(sent).toEqual(["GET /config/", "PATCH /config/"]);
    expect(res.content[0].text).toContain("Replaced the entire config");
    expect(res.content[0].text).toContain("trigger=caddy_config_set");
  });
});

describe("version resolution", () => {
  it("resolves the package version at import time", () => {
    // Covers the createRequire(import.meta.url) branch of resolveVersion --
    // the one that runs unbundled from dist/ or source.
    expect(version).toBe(pkg.version);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reports the same version through the McpServer handshake", async () => {
    const server = createCaddyServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "caddy-mcp-test", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const info = client.getServerVersion();
    expect(info?.name).toBe("caddy-mcp");
    expect(info?.version).toBe(pkg.version);
    await client.close();
  });

  // Runs only after a build. `npm test` alone skips it; `npm run test:ci`
  // (build + test) covers it. This is the branch resolveVersion's own comment
  // warns about -- the bundled CLI must print a version instead of crashing on
  // ERR_INVALID_ARG_VALUE, and only a real subprocess against real output proves it.
  describe.skipIf(!existsSync(DIST_CLI))("built CLI", () => {
    it("prints the version and exits 0 for --version", () => {
      const out = execFileSync(process.execPath, [DIST_CLI, "--version"], { encoding: "utf8" });
      expect(out.trim()).toBe(`caddy-mcp ${pkg.version}`);
    });

    it("accepts the -V short flag", () => {
      const out = execFileSync(process.execPath, [DIST_CLI, "-V"], { encoding: "utf8" });
      expect(out.trim()).toBe(`caddy-mcp ${pkg.version}`);
    });
  });
});

/**
 * End-to-end against the SHIPPED artifact: spawns `node dist/index.js` and
 * speaks real JSON-RPC over real pipes. This is the only test that exercises
 * `startServer()` -- the stdio transport wiring that is the actual production
 * entry point, and the one path a mocked transport would misrepresent.
 */
describe.skipIf(!existsSync(DIST_CLI))("built CLI over stdio", () => {
  it("completes an MCP handshake and serves tools/list from a spawned process", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_CLI] });
    const client = new Client({ name: "caddy-mcp-e2e", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);

      expect(client.getServerVersion()?.name).toBe("caddy-mcp");
      expect(client.getServerVersion()?.version).toBe(pkg.version);

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(18);

      const { resources } = await client.listResources();
      expect(resources).toHaveLength(4);
    } finally {
      await client.close();
    }
  }, 30000);

  it("surfaces a tool error over the wire when Caddy is unreachable", async () => {
    // Drives a real tool call through the real transport against an admin URL
    // nothing is listening on, proving errors round-trip as tool results rather
    // than killing the process.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_CLI],
      env: { ...process.env, CADDY_ADMIN_URL: "http://127.0.0.1:1", CADDY_MAX_RETRIES: "0" },
    });
    const client = new Client({ name: "caddy-mcp-e2e", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const res = (await client.callTool({ name: "caddy_status", arguments: {} })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Cannot connect to Caddy admin API");
    } finally {
      await client.close();
    }
  }, 30000);
});
