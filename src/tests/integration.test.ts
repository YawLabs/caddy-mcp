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
    // Origin is required: Node's fetch sends Sec-Fetch-Mode: cors, which makes
    // Caddy enforce its admin origin allowlist. Without it this 403s.
    const directRes = await fetch(`${baseUrl}/config/apps/http/servers/srv0`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: new URL(baseUrl).origin },
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
  //   3. PATCH /id/<known> with a new body replaces in place; a follow-up GET
  //      via the original config path returns the new content.
  // NOTE: this test previously asserted PUT for step 3 and had never been run
  // against a live Caddy. It does not hold -- /id/<id> resolves to a position
  // in the routes array and PUT INSERTS there, producing a second route with
  // the same @id, which Caddy rejects with "indexing config: duplicate ID".
  // PATCH is the verb that replaces. See the PUT-inserts test below.
  // If a future Caddy version regresses any of these contracts the tool's
  // "supply id for idempotent writes" promise breaks; this test catches it.
  it("@id round-trip: POST registers, GET resolves, PATCH replaces in place", async () => {
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

    // 4. PATCH /id/<rp-route> with a new body replaces in place.
    const replacement = {
      "@id": "rp-route",
      match: [{ host: ["v2.test"] }],
      handle: [{ handler: "static_response", status_code: 202 }],
      terminal: true,
    };
    const patchRes = await api.configByIdSet("rp-route", replacement, "PATCH");
    assertOk(patchRes, "configByIdSet PATCH replace");

    // 4b. PUT at the same @id must NOT be used -- it inserts a duplicate and
    //     Caddy rejects the resulting config. Pinned so nobody "simplifies"
    //     the tool back to PUT.
    const putRes = await api.configByIdSet("rp-route", replacement, "PUT");
    expect(putRes.ok).toBe(false);
    expect(putRes.error).toContain("duplicate ID");

    // 5. The route at the original config path reflects the replacement, AND
    //    we still have exactly one route (no duplicate appended).
    const routes = await api.configGet<Array<{ handle?: Array<{ status_code?: unknown }> }>>(
      "apps/http/servers/srv0/routes",
    );
    assertOk(routes, "configGet routes after PATCH");
    expect(routes.data).toHaveLength(1);
    expect(routes.data?.[0]?.handle?.[0]?.status_code).toBe(202);
  });

  // Pins the Caddy semantics that api.ts's retry carve-out rests on: PUT at a
  // position in an array INSERTS, it does not replace. That is why
  // isRetryableMethod refuses to replay a PUT whose path ends in an array index
  // -- a replay after a success-but-lost-response would add a second element.
  // If a future Caddy version changes PUT-at-index to a replace, this test
  // fails and the carve-out can be relaxed. If it starts failing the other way
  // (length 1), the carve-out was never needed.
  it("PUT at an array index inserts rather than replaces", async () => {
    const loadRes = await api.loadConfig({
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [":18892"],
              routes: [
                {
                  match: [{ host: ["first.test"] }],
                  handle: [{ handler: "static_response", status_code: 201 }],
                },
              ],
              ...noAutoHttps,
            },
          },
        },
      },
    });
    assertOk(loadRes, "loadConfig one route");

    const putRes = await api.configPut("apps/http/servers/srv0/routes/0", {
      match: [{ host: ["second.test"] }],
      handle: [{ handler: "static_response", status_code: 202 }],
    });
    assertOk(putRes, "configPut at array index");

    const routes = await api.configGet<Array<{ handle?: Array<{ status_code?: unknown }> }>>(
      "apps/http/servers/srv0/routes",
    );
    assertOk(routes, "configGet routes after PUT");
    // Two routes, not one: the PUT inserted at position 0 and pushed the
    // original down. A replace would leave length 1.
    expect(routes.data).toHaveLength(2);
    expect(routes.data?.[0]?.handle?.[0]?.status_code).toBe(202);
    expect(routes.data?.[1]?.handle?.[0]?.status_code).toBe(201);
  });

  // Pins the Caddy write semantics caddy_tls's fallback depends on. The unit
  // tests for that fallback mock the api module, so they cannot see that Caddy
  // rejects one of these verbs -- which is exactly how a PUT that could never
  // succeed survived in the fallback path.
  //
  // PUT on a NON-array key is strictly-create: 409 "key already exists".
  // PATCH on the same key replaces it. If a future Caddy relaxes PUT, this test
  // fails and the fallback could be simplified; if PATCH ever starts requiring
  // something else, it fails the other way.
  it("PUT on an existing object key conflicts; PATCH replaces it", async () => {
    const loadRes = await api.loadConfig({
      apps: {
        tls: { automation: { policies: [{ issuers: [{ module: "acme", email: "a@b.test" }] }] } },
        http: { servers: { srv0: { listen: [":18893"] } } },
      },
    });
    assertOk(loadRes, "loadConfig with apps/tls");

    const merged = {
      automation: { policies: [{ issuers: [{ module: "acme", email: "a@b.test", profile: "shortlived" }] }] },
    };

    const putRes = await api.configPut("apps/tls", merged);
    expect(putRes.ok).toBe(false);
    expect(putRes.status).toBe(409);
    expect(putRes.error).toContain("already exists");

    const patchRes = await api.configPatch("apps/tls", merged);
    assertOk(patchRes, "configPatch apps/tls");

    const issuer = await api.configGet<{ profile?: unknown }>("apps/tls/automation/policies/0/issuers/0");
    assertOk(issuer, "configGet issuer");
    expect(issuer.data?.profile).toBe("shortlived");
  });

  // The other half of the same story: the sub-path PATCH that caddy_tls tries
  // FIRST fails on a key the issuer does not carry yet, which is why
  // set_acme_profile reaches the fallback on the normal path rather than as an
  // edge case.
  it("PATCH of an absent issuer sub-key 404s, sending set_acme_profile down the fallback", async () => {
    const loadRes = await api.loadConfig({
      apps: {
        tls: { automation: { policies: [{ issuers: [{ module: "acme", email: "a@b.test" }] }] } },
        http: { servers: { srv0: { listen: [":18894"] } } },
      },
    });
    assertOk(loadRes, "loadConfig with apps/tls");

    const res = await api.configPatch("apps/tls/automation/policies/0/issuers/0/profile", "shortlived");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error).toContain("key does not exist");
  });

  // A config write's body is a JSON value, so a string must be JSON-encoded.
  // Sending it bare makes Caddy answer 500 "decoding request body: invalid
  // character ...". Mocked tests cannot see this, which is how every
  // string-valued write shipped broken.
  it("writes a string value as JSON rather than a bare body", async () => {
    const loadRes = await api.loadConfig({
      apps: {
        tls: { automation: { policies: [{ issuers: [{ module: "acme", email: "a@b.test" }] }] } },
        http: { servers: { srv0: { listen: [":18895"] } } },
      },
    });
    assertOk(loadRes, "loadConfig with apps/tls");

    const res = await api.configPatch("apps/tls/automation/policies/0/issuers/0/email", "changed@b.test");
    assertOk(res, "configPatch string value");

    const issuer = await api.configGet<{ email?: unknown }>("apps/tls/automation/policies/0/issuers/0");
    assertOk(issuer, "configGet issuer");
    expect(issuer.data?.email).toBe("changed@b.test");
  });

  // The opposite side of that switch: /adapt takes a raw document, so a string
  // body must NOT be JSON-encoded on the way out.
  it("still sends a Caddyfile to /adapt as a raw document", async () => {
    const res = await api.adapt<{ result?: unknown }>(':18896 {\n  respond "ok"\n}\n');
    assertOk(res, "adapt Caddyfile");
    expect(res.data?.result).toBeDefined();
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
