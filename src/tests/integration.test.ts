import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiResponse } from "../api.js";
import * as api from "../api.js";

const RUN = process.env.CADDY_MCP_INTEGRATION === "1";

function assertOk<T>(res: ApiResponse<T>, label: string): asserts res is ApiResponse<T> & { ok: true } {
  if (!res.ok) {
    throw new Error(`${label} failed: status=${res.status} error=${res.error ?? "(none)"}`);
  }
}

/**
 * Live-Caddy integration tests. Skipped unless CADDY_MCP_INTEGRATION=1 is set.
 * Requires a running Caddy admin API at CADDY_ADMIN_URL (default: http://localhost:2019).
 * Run locally before a release: start Caddy (`caddy start`), then
 * `CADDY_MCP_INTEGRATION=1 npm test`.
 */
describe.skipIf(!RUN)("integration: live Caddy admin API", () => {
  beforeAll(async () => {
    const res = await api.configGet();
    if (!res.ok) {
      throw new Error(`Cannot reach Caddy at ${process.env.CADDY_ADMIN_URL || "http://localhost:2019"}: ${res.error}`);
    }
  });

  /**
   * Host matchers trigger Caddy's automatic HTTPS, which tries to bind :80 for
   * HTTP->HTTPS redirects. Non-root test environments can't bind :80 and Caddy
   * returns a 500. Every server with host-matched routes must disable redirects.
   */
  const noAutoHttps = { automatic_https: { disable_redirects: true } };

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
    const loadRes = await api.loadConfig({
      apps: { http: { servers: { srv0: { listen: [":18883"], routes: [], ...noAutoHttps } } } },
    });
    assertOk(loadRes, "loadConfig");

    const route = {
      match: [{ host: ["api.test"] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:19999" }] }],
      terminal: true,
    };
    const postRes = await api.configPost("apps/http/servers/srv0/routes", route);
    assertOk(postRes, "configPost route");

    const getRes = await api.configGet<unknown[]>("apps/http/servers/srv0/routes");
    assertOk(getRes, "configGet routes");
    expect(Array.isArray(getRes.data)).toBe(true);
    expect(getRes.data).toHaveLength(1);
  });

  it("DELETE removes a route by path", async () => {
    const loadRes = await api.loadConfig({
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
              ...noAutoHttps,
            },
          },
        },
      },
    });
    assertOk(loadRes, "loadConfig");

    const del = await api.configDelete("apps/http/servers/srv0/routes/0");
    assertOk(del, "configDelete route");

    const get = await api.configGet<unknown[]>("apps/http/servers/srv0/routes");
    assertOk(get, "configGet after delete");
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

  // Validates Caddy's @id round-trip semantics that caddy_reverse_proxy's
  // GET-first dispatch depends on:
  //   1. POST a route with "@id" embedded under the routes path -> @id registers
  //      and is resolvable via /id/<id>.
  //   2. GET /id/<unknown> returns a non-OK response (the tool treats this as
  //      "first-create" and falls through to POST).
  //   3. PUT /id/<known> with a new body replaces in place; a follow-up GET
  //      via the original config path returns the new content.
  // If a future Caddy version regresses any of these contracts the tool's
  // "supply id for idempotent writes" promise breaks; this test catches it.
  it("@id round-trip: POST registers, GET resolves, PUT replaces in place", async () => {
    const loadRes = await api.loadConfig({
      apps: { http: { servers: { srv0: { listen: [":18891"], routes: [], ...noAutoHttps } } } },
    });
    assertOk(loadRes, "loadConfig empty server");

    // 1. Unknown @id resolves to a not-OK response (the tool's first-create signal).
    const missing = await api.configByIdGet("rp-route");
    expect(missing.ok).toBe(false);

    // 2. POST a route with @id embedded under the routes path -> @id registers.
    const initialRoute = {
      "@id": "rp-route",
      match: [{ host: ["v1.test"] }],
      handle: [{ handler: "static_response", status_code: 201 }],
      terminal: true,
    };
    const postRes = await api.configPost("apps/http/servers/srv0/routes", initialRoute);
    assertOk(postRes, "configPost route with @id");

    // 3. /id/<rp-route> now resolves to that route.
    const afterPost = await api.configByIdGet<{ handle?: Array<{ status_code?: unknown }> }>("rp-route");
    assertOk(afterPost, "configByIdGet after POST");
    expect(afterPost.data?.handle?.[0]?.status_code).toBe(201);

    // 4. PUT /id/<rp-route> with a new body replaces in place.
    const replacement = {
      "@id": "rp-route",
      match: [{ host: ["v2.test"] }],
      handle: [{ handler: "static_response", status_code: 202 }],
      terminal: true,
    };
    const putRes = await api.configByIdSet("rp-route", replacement, "PUT");
    assertOk(putRes, "configByIdSet PUT replace");

    // 5. The route at the original config path reflects the replacement, AND
    //    we still have exactly one route (no duplicate appended).
    const routes = await api.configGet<Array<{ handle?: Array<{ status_code?: unknown }> }>>(
      "apps/http/servers/srv0/routes",
    );
    assertOk(routes, "configGet routes after PUT");
    expect(routes.data).toHaveLength(1);
    expect(routes.data?.[0]?.handle?.[0]?.status_code).toBe(202);
  });

  it("configByIdGet + Delete works end-to-end", async () => {
    const loadRes = await api.loadConfig({
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
              ...noAutoHttps,
            },
          },
        },
      },
    });
    assertOk(loadRes, "loadConfig with @id");

    const get = await api.configByIdGet("integration-route");
    assertOk(get, "configByIdGet");

    const del = await api.configByIdDelete("integration-route");
    assertOk(del, "configByIdDelete");

    const getAfter = await api.configByIdGet("integration-route");
    expect(getAfter.ok).toBe(false);
  });
});
