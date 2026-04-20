import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as api from "../api.js";

const RUN = process.env.CADDY_MCP_INTEGRATION === "1";

/**
 * Live-Caddy integration tests. Skipped unless CADDY_MCP_INTEGRATION=1 is set.
 * Requires a running Caddy admin API at CADDY_ADMIN_URL (default: http://localhost:2019).
 * CI provisions this via the `integration` job in .github/workflows/ci.yml.
 */
describe.skipIf(!RUN)("integration: live Caddy admin API", () => {
  beforeAll(async () => {
    const res = await api.configGet();
    if (!res.ok) {
      throw new Error(`Cannot reach Caddy at ${process.env.CADDY_ADMIN_URL || "http://localhost:2019"}: ${res.error}`);
    }
  });

  beforeEach(async () => {
    // Reset to empty config for a clean slate per test.
    const res = await api.loadConfig({}, "application/json");
    if (!res.ok) throw new Error(`Reset failed: ${res.error}`);
  });

  it("loadConfig + configGet round-trip", async () => {
    const cfg = { apps: { http: { servers: { srv0: { listen: [":18881"], routes: [] } } } } };
    const loadRes = await api.loadConfig(cfg);
    expect(loadRes.ok).toBe(true);

    const getRes = await api.configGet<typeof cfg>();
    expect(getRes.ok).toBe(true);
    expect(getRes.data?.apps?.http?.servers?.srv0?.listen).toEqual([":18881"]);
  });

  it("adapts a Caddyfile to JSON", async () => {
    const res = await api.adapt<{ result?: unknown; warnings?: unknown[] }>(':18882 {\n  respond "hi"\n}\n');
    expect(res.ok).toBe(true);
    expect(res.data?.result).toBeDefined();
  });

  it("POSTs a reverse_proxy route and reads it back", async () => {
    await api.loadConfig({
      apps: { http: { servers: { srv0: { listen: [":18883"], routes: [] } } } },
    });

    const route = {
      match: [{ host: ["api.test"] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:19999" }] }],
      terminal: true,
    };
    const postRes = await api.configPost("apps/http/servers/srv0/routes", route);
    expect(postRes.ok).toBe(true);

    const getRes = await api.configGet<unknown[]>("apps/http/servers/srv0/routes");
    expect(getRes.ok).toBe(true);
    expect(Array.isArray(getRes.data)).toBe(true);
    expect(getRes.data).toHaveLength(1);
  });

  it("DELETE removes a route by path", async () => {
    await api.loadConfig({
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [":18884"],
              routes: [
                {
                  match: [{ host: ["x.test"] }],
                  handle: [{ handler: "static_response", status_code: 204 }],
                },
              ],
            },
          },
        },
      },
    });

    const del = await api.configDelete("apps/http/servers/srv0/routes/0");
    expect(del.ok).toBe(true);

    const get = await api.configGet<unknown[]>("apps/http/servers/srv0/routes");
    expect(get.ok).toBe(true);
    expect(get.data).toEqual([]);
  });

  it("PATCH applies successfully after a fresh GET (ETag round-trip)", async () => {
    await api.loadConfig({
      apps: { http: { servers: { srv0: { listen: [":18885"] } } } },
    });

    const read = await api.configGet("apps/http/servers/srv0");
    expect(read.ok).toBe(true);

    const write = await api.configPatch("apps/http/servers/srv0", { listen: [":18886"] });
    expect(write.ok).toBe(true);
  });

  it("returns 412 when ETag is stale (caught concurrent modification)", async () => {
    await api.loadConfig({
      apps: { http: { servers: { srv0: { listen: [":18887"] } } } },
    });

    // Prime the ETag cache with a GET.
    const first = await api.configGet("apps/http/servers/srv0");
    expect(first.ok).toBe(true);

    // Mutate via a direct fetch, bypassing the api client's ETag tracking.
    const baseUrl = process.env.CADDY_ADMIN_URL || "http://localhost:2019";
    const directRes = await fetch(`${baseUrl}/config/apps/http/servers/srv0`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listen: [":18888"] }),
    });
    expect(directRes.ok).toBe(true);

    // Our cached ETag is now stale — this PATCH must fail 412.
    const second = await api.configPatch("apps/http/servers/srv0", { listen: [":18889"] });
    expect(second.ok).toBe(false);
    expect(second.status).toBe(412);
  });

  it("configByIdGet + Delete works end-to-end", async () => {
    await api.loadConfig({
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [":18890"],
              routes: [
                {
                  "@id": "integration-route",
                  match: [{ host: ["id.test"] }],
                  handle: [{ handler: "static_response", status_code: 204 }],
                },
              ],
            },
          },
        },
      },
    });

    const get = await api.configByIdGet("integration-route");
    expect(get.ok).toBe(true);

    const del = await api.configByIdDelete("integration-route");
    expect(del.ok).toBe(true);

    const getAfter = await api.configByIdGet("integration-route");
    expect(getAfter.ok).toBe(false);
  });
});
