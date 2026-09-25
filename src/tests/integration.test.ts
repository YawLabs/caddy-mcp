import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiResponse } from "../api.js";
import * as api from "../api.js";
import { registerAdaptTools } from "../tools/adapt.js";
import { registerConfigTools } from "../tools/config.js";
import { registerOperationalTools } from "../tools/operational.js";
import { registerRouteTools } from "../tools/routes.js";
import { registerTlsTools } from "../tools/tls.js";

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

  /**
   * Block until the admin endpoint answers again.
   *
   * Caddy restarts its admin listener on EVERY `POST /load` -- its own log
   * emits "admin endpoint started" once per load, 34 times across a 24-load
   * run. The listener is briefly unavailable while it rebinds, and a request
   * landing in that window comes back as a connect error or a timeout.
   *
   * Retries do not paper over it: `POST /config/<path>` is deliberately NOT
   * retryable (it appends, so a replay could duplicate a route), so exactly the
   * calls this suite makes right after a load are the ones with no safety net.
   * That is what made the suite fail 1-3 tests non-deterministically on Windows
   * while every one of them passed in isolation.
   *
   * configGet is idempotent and self-retrying, which makes it the right probe.
   */
  async function waitForAdmin(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const probe = await api.configGet();
      if (probe.ok) return;
      if (Date.now() > deadline) {
        throw new Error(`admin endpoint did not return after /load: ${probe.error}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** loadConfig, then wait for the restarted admin endpoint to accept requests. */
  async function loadAndSettle(config: unknown, contentType?: string) {
    const res = await api.loadConfig(config, contentType);
    if (res.ok) await waitForAdmin();
    return res;
  }

  beforeEach(async () => {
    // Reset to empty config for a clean slate per test.
    const res = await loadAndSettle({}, "application/json");
    if (!res.ok) throw new Error(`Reset failed: ${res.error}`);
  });

  it("loadConfig + configGet round-trip", async () => {
    const cfg = { apps: { http: { servers: { srv0: { listen: [":18881"], routes: [] } } } } };
    const loadRes = await loadAndSettle(cfg);
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
    const loadRes = await loadAndSettle({
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
    const loadRes = await loadAndSettle({
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
    await loadAndSettle({
      apps: { http: { servers: { srv0: { listen: [":18885"] } } } },
    });

    const read = await api.configGet("apps/http/servers/srv0");
    expect(read.ok).toBe(true);

    const write = await api.configPatch("apps/http/servers/srv0", { listen: [":18886"] });
    expect(write.ok).toBe(true);
  });

  it("returns 412 when ETag is stale (caught concurrent modification)", async () => {
    await loadAndSettle({
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
    const loadRes = await loadAndSettle({
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
    const loadRes = await loadAndSettle({
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
    const loadRes = await loadAndSettle({
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
    const loadRes = await loadAndSettle({
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

  // THE FOOTGUN that hid a wrong config path for three minor versions. Caddy
  // answers a GET of ANY missing final key with 200 null -- it does not 404, and
  // it does not distinguish "a real key that is not set" from "a key that cannot
  // exist". caddy_tls ech_status read apps/tls/ech, which is only the Caddyfile
  // global option's name; the JSON key is encrypted_client_hello. Both come back
  // as the same 200 null, so the action said "not configured" with ECH on or off
  // and its mocked unit test, which pinned the wrong path, passed throughout.
  //
  // So this pins three things no mock can: a typo'd key is indistinguishable from
  // an unset one on a GET; the wrong key can never be PRESENT either, because a
  // load carrying it is rejected; and a missing PARENT is a 400, not a null.
  it("GET of a missing final key is 200 null -- for the real ECH key AND for any unknown sibling", async () => {
    const loadRes = await loadAndSettle({
      apps: { tls: { automation: { policies: [{ issuers: [{ module: "acme", email: "a@b.test" }] }] } } },
    });
    assertOk(loadRes, "loadConfig apps/tls without ECH");

    for (const key of ["encrypted_client_hello", "ech", "no_such_key_at_all"]) {
      const res = await api.configGet(`apps/tls/${key}`);
      assertOk(res, `configGet apps/tls/${key}`);
      expect(res.status, key).toBe(200);
      expect(res.data, key).toBeNull();
    }

    // The wrong key cannot be loaded, so reading it could only ever return null.
    // (A failed load leaves the running config untouched, so no settle needed.)
    const bad = await api.loadConfig({ apps: { tls: { ech: { configs: [{ public_name: "ech.example.test" }] } } } });
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(400);
    // The error is Caddy's raw JSON body, so the quotes around the field name
    // arrive backslash-escaped; tolerate either form.
    expect(bad.error).toMatch(/unknown field \\?"ech\\?"/);
  });

  it("GET under a missing parent is a 400 traversal failure, not a null and not a 404", async () => {
    // beforeEach left the config at {} -- no `apps` key.
    const noApps = await api.configGet("apps/tls/encrypted_client_hello");
    expect(noApps.ok).toBe(false);
    expect(noApps.status).toBe(400);
    expect(noApps.error).toContain("invalid traversal path at: config/apps/tls");
    expect(api.isMissingConfigPath(noApps)).toBe(true);

    // The most common real shape: apps.http only. apps/tls itself is a missing
    // FINAL key (200 null); one level below it is a missing PARENT (400).
    const loadRes = await loadAndSettle({ apps: { http: { servers: { srv0: { listen: [":18868"], routes: [] } } } } });
    assertOk(loadRes, "loadConfig http-only");

    const tls = await api.configGet("apps/tls");
    assertOk(tls, "configGet apps/tls on an http-only config");
    expect(tls.data).toBeNull();

    const ech = await api.configGet("apps/tls/encrypted_client_hello");
    expect(ech.ok).toBe(false);
    expect(ech.status).toBe(400);
    expect(ech.error).toContain("invalid traversal path at: config/apps/tls/encrypted_client_hello");
    expect(api.isMissingConfigPath(ech)).toBe(true);
  });

  // Pins the verb semantics caddy_tls's CREATE branch depends on, and that the
  // serverNotFoundError recipe depends on. POST walks the path and fails where a
  // parent is missing; PUT makes the parents as it goes. This predates every
  // Caddy the MCP supports (the branch dates from 2019) -- the MCP simply never
  // used it, and told operators that caddy_config_set "cannot create the
  // apps/http tree" when one mode:"insert" call does exactly that.
  it("PUT creates missing parent objects; POST and PATCH cannot", async () => {
    // A truly config-less instance: what a bare `caddy run` starts with. Loading
    // {} is not the same state -- that leaves an object with no `apps` key.
    const cleared = await api.configDelete("");
    assertOk(cleared, "configDelete whole config");
    const root = await api.configGet("");
    assertOk(root, "configGet root");
    expect(root.data).toBeNull();

    const fresh = { automation: { policies: [{ issuers: [{ module: "acme", email: "a@b.test" }] }] } };

    const getRes = await api.configGet("apps/tls");
    expect(getRes.ok).toBe(false);
    expect(getRes.status).toBe(400);
    expect(getRes.error).toContain("invalid traversal path at: config/apps");

    const postRes = await api.configPost("apps/tls", fresh);
    expect(postRes.ok).toBe(false);
    expect(postRes.status).toBe(500);
    expect(api.isMissingConfigPath(postRes)).toBe(true);

    const patchRes = await api.configPatch("apps/tls/automation/policies/0/issuers/0/email", "a@b.test");
    expect(patchRes.ok).toBe(false);
    expect(api.isMissingConfigPath(patchRes)).toBe(true);

    const putRes = await api.configPut("apps/tls", fresh);
    assertOk(putRes, "configPut apps/tls on a null config");

    const after = await api.configGet("");
    assertOk(after, "configGet root after PUT");
    expect(after.data).toEqual({ apps: { tls: fresh } });

    // Strictly-create: the second PUT conflicts instead of overwriting.
    const again = await api.configPut("apps/tls", fresh);
    expect(again.ok).toBe(false);
    expect(again.status).toBe(409);
    expect(again.error).toContain("key already exists: tls");
  });

  // Why the create-it recipes name mode "insert" and not "append": POST on an
  // object key that already exists REPLACES it and reports success. For a server,
  // that is every route gone behind a 200.
  it("POST over an existing object key replaces it; PUT answers 409 and leaves it alone", async () => {
    const loadRes = await loadAndSettle({
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [":18869"],
              routes: [{ handle: [{ handler: "static_response", status_code: 204 }] }],
            },
          },
        },
      },
    });
    assertOk(loadRes, "loadConfig one server with a route");

    const replacement = { listen: [":18869"], routes: [] };

    const putRes = await api.configPut("apps/http/servers/srv0", replacement);
    expect(putRes.ok).toBe(false);
    expect(putRes.status).toBe(409);
    expect(putRes.error).toContain("key already exists: srv0");
    const afterPut = await api.configGet<unknown[]>("apps/http/servers/srv0/routes");
    assertOk(afterPut, "configGet routes after the refused PUT");
    expect(afterPut.data).toHaveLength(1);

    const postRes = await api.configPost("apps/http/servers/srv0", replacement);
    assertOk(postRes, "configPost over the existing server");
    const afterPost = await api.configGet<unknown[]>("apps/http/servers/srv0/routes");
    assertOk(afterPost, "configGet routes after the POST");
    expect(afterPost.data).toEqual([]);
  });

  // A config write's body is a JSON value, so a string must be JSON-encoded.
  // Sending it bare makes Caddy answer 500 "decoding request body: invalid
  // character ...". Mocked tests cannot see this, which is how every
  // string-valued write shipped broken.
  it("writes a string value as JSON rather than a bare body", async () => {
    const loadRes = await loadAndSettle({
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
    const loadRes = await loadAndSettle({
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

  // Tool handlers, not the api module. Each case below turns on a response
  // shape only a real Caddy produces -- a failed path traversal, a server
  // object with no keys, an adapter syntax error -- so the mocked suite in
  // tools.test.ts (which feeds hand-built 200s) can never reach them.
  // The contract api.isRootConfigPath rests on: Caddy strips a lone trailing
  // "..." segment BEFORE it switches on the method (admin.go:1196-1199 at
  // v2.11.4), so `PATCH /config/...` is `PATCH /config/` -- a whole-config
  // replace, not a bulk append and not a key named "...". If a Caddy release
  // ever validates that segment against the destination type, this test says
  // so and the predicate can shrink; until then, the "..." family must be gated
  // as the root.
  it("a lone trailing '...' addresses the root for PATCH, as isRootConfigPath assumes", async () => {
    const known = { apps: { http: { servers: { srv0: { listen: [":18898"], routes: [] } } } } };
    assertOk(await loadAndSettle(known), "loadConfig known config");
    const replacement = { apps: { http: { servers: { srv1: { listen: [":18897"], routes: [] } } } } };

    const res = await api.configPatch("...", replacement);
    assertOk(res, "PATCH /config/...");

    await waitForAdmin();
    const after = await api.configGet();
    assertOk(after, "configGet after PATCH /config/...");
    expect(after.data).toEqual(replacement);
  });

  describe("tool handlers against live Caddy", () => {
    type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

    /**
     * Register a tool module against a stand-in server and return one tool's
     * handler (argument 5 of server.tool), the same way tools.test.ts does.
     *
     * Calling the handler directly bypasses zod, so every argument has to be
     * passed explicitly -- schema defaults like server="srv0" do not apply.
     */
    function getHandler(register: (server: any) => void, name: string) {
      const calls: any[][] = [];
      register({ tool: (...args: any[]) => calls.push(args), resource: () => {} });
      const handler = calls.find((c) => c[0] === name)?.[4];
      if (typeof handler !== "function") throw new Error(`tool ${name} was not registered`);
      return handler as (args: Record<string, unknown>) => Promise<ToolResult>;
    }

    // A server GET that fails must be surfaced verbatim rather than falling
    // through to the summary path. On an instance carrying no apps/http at all,
    // Caddy answers 400 "invalid traversal path" -- if that guard regressed the
    // tool would print "no routes configured" for a server it never read,
    // telling an operator a live server is empty and inviting an overwrite.
    //
    // The GET-FAILS path, reachable while apps/http/servers is absent entirely.
    // A traversal failure is DECISIVE -- no parent chain means no server -- so
    // unlike the ambiguous null body below, asserting non-existence is honest,
    // and the operator gets the create-it recipe instead of a Go error.
    it("caddy_list_routes answers a config-less instance with the create-it recipe", async () => {
      const handler = getHandler(registerRouteTools, "caddy_list_routes");
      const result = await handler({ server: "does-not-exist" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server "does-not-exist" does not exist');
      // The recipe must be one that works in THIS state. It used to send the
      // operator to caddy_load, claiming caddy_config_set "cannot create the
      // apps/http tree"; mode "insert" (PUT) creates it -- proven two tests down.
      expect(result.content[0].text).toContain('mode: "insert"');
      expect(result.content[0].text).not.toContain("caddy_load");
      expect(result.content[0].text).not.toContain("invalid traversal path");
      expect(result.content[0].text).not.toContain("no routes configured");
    });

    // The write-side counterpart, and the case isParentMissing exists for. Live
    // Caddy answers a POST under a missing server with 500 "invalid traversal
    // path", never the 404 / "key does not exist" every mocked fixture used --
    // so serverNotFoundError was unreachable here and callers saw the raw error.
    it("caddy_reverse_proxy names the missing server instead of leaking a Go error", async () => {
      const loaded = await loadAndSettle({
        apps: { http: { servers: { srv0: { listen: [":18875"], routes: [] } } } },
      });
      assertOk(loaded, "loadConfig one real server");

      const handler = getHandler(registerRouteTools, "caddy_reverse_proxy");
      const result = await handler({ from: "app.local", to: ["localhost:3000"], server: "nosuch" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server "nosuch" does not exist');
      expect(result.content[0].text).not.toContain("invalid traversal path");
    });

    // The advice has to WORK, not merely read well: following it verbatim must
    // produce a server that accepts its first route. The original text omitted
    // both `routes: []` and the mode, so an operator who followed it hit
    // "cannot unmarshal object into ... RouteList" on their very next call. Its
    // successor named mode "append", and was only ever tested HERE -- beside a
    // pre-seeded apps/http -- which is the one state where a POST can create the
    // key. The recipe is reached on a traversal failure, i.e. precisely when the
    // parents may be missing; the next test is the state that matters.
    it("the create-it advice actually produces a usable server", async () => {
      const loaded = await loadAndSettle({ apps: { http: { servers: { srv0: { listen: [":18876"], routes: [] } } } } });
      assertOk(loaded, "loadConfig seed server");

      // Exactly what serverNotFoundError tells the operator to do, through the
      // tool it names. (Handlers bypass zod, so every argument is explicit.)
      const configSet = getHandler(registerConfigTools, "caddy_config_set");
      const create = await configSet({
        path: "apps/http/servers/fresh",
        mode: "insert",
        value: { listen: [":18877"], routes: [], automatic_https: { disable_redirects: true } },
      });
      expect(create.isError, create.content?.[0]?.text).toBeFalsy();

      const handler = getHandler(registerRouteTools, "caddy_reverse_proxy");
      const added = await handler({ from: "/api", to: ["localhost:3000"], server: "fresh" });
      expect(added.isError, added.content?.[0]?.text).toBeFalsy();
      expect(added.content[0].text).toContain("Route added");

      // And the safety half of the recipe: run it again and the existing server,
      // route and all, is refused rather than replaced.
      const repeat = await configSet({
        path: "apps/http/servers/fresh",
        mode: "insert",
        value: { listen: [":18877"], routes: [] },
      });
      expect(repeat.isError).toBe(true);
      expect(repeat.content[0].text).toContain("key already exists: fresh");
      const routes = await api.configGet<unknown[]>("apps/http/servers/fresh/routes");
      assertOk(routes, "configGet routes after the refused repeat");
      expect(routes.data).toHaveLength(1);
    });

    // The state serverNotFoundError said caddy_config_set could not handle: "On
    // an instance with no config at all, use caddy_load instead". False on
    // 2.11.4 -- and the same recipe with mode "append" fails here with 500
    // "invalid traversal path", so the old advice did not work where it was given.
    it.each([
      ["a config of {}", async () => {}],
      [
        "no config at all (null)",
        async () => {
          assertOk(await api.configDelete(""), "configDelete whole config");
        },
      ],
    ])("the create-it advice works on %s, where mode 'append' cannot", async (_label, arrange) => {
      await arrange();

      const configSet = getHandler(registerConfigTools, "caddy_config_set");
      const value = { listen: [":18878"], routes: [], automatic_https: { disable_redirects: true } };

      const appended = await configSet({ path: "apps/http/servers/fresh", mode: "append", value });
      expect(appended.isError).toBe(true);
      expect(appended.content[0].text).toContain("invalid traversal path");

      const inserted = await configSet({ path: "apps/http/servers/fresh", mode: "insert", value });
      expect(inserted.isError, inserted.content?.[0]?.text).toBeFalsy();

      const handler = getHandler(registerRouteTools, "caddy_reverse_proxy");
      const added = await handler({ from: "/api", to: ["localhost:3000"], server: "fresh" });
      expect(added.isError, added.content?.[0]?.text).toBeFalsy();
      expect(added.content[0].text).toContain("Route added");
    });

    // "Works on both fresh and existing Caddy instances", the tool description
    // says. It did not: on either fresh state below, every set_* action came back
    // as two raw Go errors, because the fallback's GET fails the path walk with a
    // 400 rather than the 404 it was written for -- and the POST it would have
    // sent cannot create apps/tls without an `apps` parent anyway.
    it.each([
      ["a config of {}", async () => {}],
      [
        "no config at all (null)",
        async () => {
          assertOk(await api.configDelete(""), "configDelete whole config");
          const root = await api.configGet("");
          assertOk(root, "configGet root");
          expect(root.data).toBeNull();
        },
      ],
    ])("caddy_tls set_* builds apps/tls from %s", async (_label, arrange) => {
      await arrange();
      const handler = getHandler(registerTlsTools, "caddy_tls");

      // 1. Nothing to PATCH, nothing to GET: the create-PUT makes `apps` too.
      const email = await handler({ action: "set_email", email: "ops@example.test" });
      expect(email.isError, email.content?.[0]?.text).toBeFalsy();
      expect(email.content[0].text).toBe("ACME email set to: ops@example.test");

      // 2. and 3. The issuer now exists but carries neither key, so these take
      // the merge branch -- which must keep what step 1 wrote.
      const ca = await handler({ action: "set_acme_ca", ca: "https://acme.example.test/directory" });
      expect(ca.isError, ca.content?.[0]?.text).toBeFalsy();
      const profile = await handler({ action: "set_acme_profile", profile: "shortlived" });
      expect(profile.isError, profile.content?.[0]?.text).toBeFalsy();

      const tls = await api.configGet("apps/tls");
      assertOk(tls, "configGet apps/tls");
      expect(tls.data).toEqual({
        automation: {
          policies: [
            {
              issuers: [
                {
                  module: "acme",
                  email: "ops@example.test",
                  ca: "https://acme.example.test/directory",
                  profile: "shortlived",
                },
              ],
            },
          ],
        },
      });
    });

    it("caddy_tls set_email still creates apps/tls beside an existing apps/http", async () => {
      // The one absent-state the old POST did handle (GET 200 null). It must keep
      // working through the PUT, and must not disturb the sibling app.
      const loaded = await loadAndSettle({ apps: { http: { servers: { srv0: { listen: [":18879"], routes: [] } } } } });
      assertOk(loaded, "loadConfig http-only");

      const handler = getHandler(registerTlsTools, "caddy_tls");
      const result = await handler({ action: "set_email", email: "ops@example.test" });
      expect(result.isError, result.content?.[0]?.text).toBeFalsy();

      const apps = await api.configGet<{ http?: unknown; tls?: unknown }>("apps");
      assertOk(apps, "configGet apps");
      expect(apps.data?.http).toEqual({ servers: { srv0: { listen: [":18879"], routes: [] } } });
      expect(apps.data?.tls).toEqual({
        automation: { policies: [{ issuers: [{ module: "acme", email: "ops@example.test" }] }] },
      });
    });

    // Every state in which ECH is off, and none of them is an error. The first
    // two fail the GET outright (400 traversal) and used to reach the caller raw;
    // the http-only one is the most common real config there is.
    it("caddy_tls ech_status and status say 'not set' on every ECH-less state, never a Go error", async () => {
      const handler = getHandler(registerTlsTools, "caddy_tls");

      const expectNotConfigured = async (label: string) => {
        const result = await handler({ action: "ech_status" });
        expect(result.isError, `${label}: ${result.content?.[0]?.text}`).toBeFalsy();
        expect(result.content[0].text, label).toContain("ECH (Encrypted ClientHello) is not configured");
        expect(result.content[0].text, label).not.toContain("invalid traversal path");
      };
      const expectNoTlsConfig = async (label: string) => {
        const result = await handler({ action: "status" });
        expect(result.isError, `${label}: ${result.content?.[0]?.text}`).toBeFalsy();
        expect(result.content[0].text, label).toContain("No TLS config is set");
      };

      // {} from beforeEach: no `apps` key.
      await expectNotConfigured("config {}");
      await expectNoTlsConfig("config {}");

      assertOk(await api.configDelete(""), "configDelete whole config");
      await expectNotConfigured("null config");
      await expectNoTlsConfig("null config");

      const httpOnly = await loadAndSettle({
        apps: { http: { servers: { srv0: { listen: [":18880"], routes: [] } } } },
      });
      assertOk(httpOnly, "loadConfig http-only");
      await expectNotConfigured("http-only config");
      await expectNoTlsConfig("http-only config");

      const tlsNoEch = await loadAndSettle({
        apps: { tls: { automation: { policies: [{ issuers: [{ module: "acme", email: "a@b.test" }] }] } } },
      });
      assertOk(tlsNoEch, "loadConfig apps/tls without ECH");
      await expectNotConfigured("apps/tls without ECH");
      // ...and here `status` has a real config to show.
      const status = await handler({ action: "status" });
      expect(status.isError).toBeFalsy();
      expect(status.content[0].text).toContain("a@b.test");
    });

    // The test that would have caught the bug: ECH actually ON. With the old
    // path this action answered "not configured" right here.
    //
    // Self-contained on purpose. The internal issuer means no ACME traffic for
    // the public name; install_trust:false means Caddy never touches the OS trust
    // store (on Windows that is an interactive prompt); and the explicit storage
    // root keeps the ECH keys and the local CA out of whatever data directory the
    // Caddy under test normally uses.
    it("caddy_tls ech_status reports an ECH config that is actually on", async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), "caddy-mcp-ech-"));
      try {
        const loaded = await loadAndSettle({
          storage: { module: "file_system", root: storageRoot },
          apps: {
            pki: { certificate_authorities: { local: { install_trust: false } } },
            tls: {
              automation: { policies: [{ issuers: [{ module: "internal" }] }] },
              encrypted_client_hello: { configs: [{ public_name: "ech.example.test" }] },
            },
          },
        });
        assertOk(loaded, "loadConfig with ECH on");

        const handler = getHandler(registerTlsTools, "caddy_tls");
        const result = await handler({ action: "ech_status" });
        expect(result.isError, result.content?.[0]?.text).toBeFalsy();
        expect(result.content[0].text).not.toContain("not configured");
        expect(JSON.parse(result.content[0].text)).toEqual({ configs: [{ public_name: "ech.example.test" }] });

        // The old path, on the same ECH-enabled instance: still 200 null.
        const wrongKey = await api.configGet("apps/tls/ech");
        assertOk(wrongKey, "configGet apps/tls/ech");
        expect(wrongKey.data).toBeNull();
      } finally {
        // Drop the config first so Caddy lets go of the storage directory; a
        // leftover temp dir is not worth failing a test over.
        await loadAndSettle({}, "application/json");
        try {
          rmSync(storageRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          // best effort
        }
      }
    });

    // The live half of the null-body bug. Only a real Caddy produces this shape,
    // which is why it went unnoticed: every mocked fixture returned a populated
    // 200, so no test ever saw an unknown server answered with `200 null`.
    it("caddy_list_routes errors on a mistyped server name once servers exist", async () => {
      const loaded = await loadAndSettle({
        apps: { http: { servers: { real: { listen: [":18871"], routes: [] } } } },
      });
      assertOk(loaded, "loadConfig one real server");

      // Confirm the premise against this Caddy rather than trusting the note:
      // an unknown key really is 200 + null, not a 404.
      const probe = await api.configGet("apps/http/servers/typo");
      expect(probe.ok).toBe(true);
      expect(probe.data).toBeNull();

      const handler = getHandler(registerRouteTools, "caddy_list_routes");
      const result = await handler({ server: "typo" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("is not configured, or its config is null");
      expect(result.content[0].text).not.toContain("no routes configured");

      // The real neighbour must still list normally -- the guard keys on the
      // response body, not on the name.
      const good = await handler({ server: "real" });
      expect(good.isError).toBeFalsy();
      expect(good.content[0].text).toContain("no routes configured");
    });

    // 2.11.4 accepts a server object with no keys at all, and that is exactly
    // the shape serverNotFoundError tells operators to create. Without the
    // Array.isArray guards, routes.length would throw on undefined.
    it("caddy_list_routes reports a keyless or empty server instead of crashing", async () => {
      const noKeys = await loadAndSettle({ apps: { http: { servers: { srv0: {} } } } });
      assertOk(noKeys, "loadConfig keyless server");

      const handler = getHandler(registerRouteTools, "caddy_list_routes");
      const bare = await handler({ server: "srv0" });
      expect(bare.isError).toBeFalsy();
      expect(bare.content[0].text).toContain("Server srv0 (listen: default)");
      expect(bare.content[0].text).toContain("no routes configured");

      // Present-but-empty listen/routes take the same path: an empty listen
      // array still renders as "default", not as a trailing "listen: ".
      const empty = await loadAndSettle({ apps: { http: { servers: { srv0: { listen: [], routes: [] } } } } });
      assertOk(empty, "loadConfig empty listen and routes");

      const emptied = await handler({ server: "srv0" });
      expect(emptied.isError).toBeFalsy();
      expect(emptied.content[0].text).toContain("Server srv0 (listen: default)");
      expect(emptied.content[0].text).toContain("no routes configured");
    });

    // The first-run empty state, and the reason it needs a LIVE test: a bare
    // Caddy has no `apps` key, so GET /config/apps/http/servers fails the path
    // walk with HTTP 400 rather than returning {}. Every mocked fixture feeds
    // ok({...}), so the whole suite could stay green while this tool answered a
    // fresh instance with a raw Go error -- which is exactly what it used to do.
    it("caddy_list_servers reports an empty instance as empty, not as a Go error", async () => {
      const handler = getHandler(registerOperationalTools, "caddy_list_servers");
      const result = await handler({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe("No HTTP servers configured");
      expect(result.content[0].text).not.toContain("invalid traversal path");
    });

    // An adapter failure has to come back as an error result. If this guard
    // regressed, a typo'd Caddyfile would render as "OK (no output)" -- the
    // undefined `result` field of an error body -- and an operator would
    // believe it converted cleanly and go on to load it.
    it("caddy_adapt reports an adapter failure as an error, not a clean conversion", async () => {
      const handler = getHandler(registerAdaptTools, "caddy_adapt");

      const malformed = await handler({ config: "this is not { a valid", adapter: "caddyfile" });
      expect(malformed.isError).toBe(true);
      expect(malformed.content[0].text).toContain("syntax error");
      expect(malformed.content[0].text).not.toContain("OK (no output)");

      // Same for an adapter this Caddy build does not carry: the schema accepts
      // the name, only the server can reject it.
      const unknownAdapter = await handler({ config: "server {}", adapter: "nginx" });
      expect(unknownAdapter.isError).toBe(true);
      expect(unknownAdapter.content[0].text).toContain("unrecognized config adapter");
    });

    // The false success. Caddy writes a Caddyfile's adapter warnings into the
    // /load response BEFORE it runs the load, which fixes the status at 200; when
    // the load then fails, its error object is appended to a body that already
    // went out as a success (caddyconfig/load.go at v2.11.4, caddyserver/caddy#7246).
    // Two spaces of indentation are enough for the warning -- "Caddyfile input is
    // not formatted" fires on anything `caddy fmt` would change -- and a `tls`
    // directive naming a certificate that does not exist is enough for the
    // failure, which happens at provision, after adaptation. 2.5.2 reported this
    // load as a success, pushed a "pre-load" snapshot of a config that was never
    // replaced, and printed Caddy's error as if it were the result.
    //
    // Only the outcome is pinned, not the 200: caddyserver/caddy#7267 (milestoned
    // v2.11.5) moves this failure to a 400 with both parts in one object, and the
    // tool must report failure, with the error and the warning, on either Caddy.
    it("caddy_load reports a Caddyfile load that failed behind a 200 as a failure, and changes nothing", async () => {
      const known = {
        apps: {
          http: {
            servers: {
              srv0: {
                listen: [":18897"],
                routes: [{ handle: [{ handler: "static_response", body: "still the old config" }] }],
                ...noAutoHttps,
              },
            },
          },
        },
      };
      assertOk(await loadAndSettle(known), "loadConfig known config");
      const before = await api.configGet();
      assertOk(before, "configGet before the failing load");

      // Forward slashes: Windows accepts them, and Caddy's error echoes the path
      // inside a JSON string, where a backslash would arrive doubled and the
      // containment check below would miss it.
      const missing = join(tmpdir(), `caddy-mcp-no-such-cert-${process.pid}-${Date.now()}`).replace(/\\/g, "/");
      const caddyfile = [
        "{",
        "  auto_https off",
        "}",
        "",
        "https://127.0.0.1:18898 {",
        `  tls ${missing}/cert.pem ${missing}/key.pem`,
        '  respond "never served"',
        "}",
        "",
      ].join("\n");

      const { listSnapshots } = await import("../snapshots.js");
      const ringBefore = listSnapshots().length;

      const handler = getHandler(registerConfigTools, "caddy_load");
      const result = await handler({ config: caddyfile, format: "caddyfile", confirm: true });

      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      // Caddy's own error, naming the certificate it could not open...
      expect(text).toContain(`${missing}/cert.pem`);
      // ...and the adapter warning that came with it, both in the one item.
      expect(text).toContain("Caddyfile input is not formatted");

      // A failed load restarts Caddy's admin endpoint too (it is replaced ahead
      // of provisioning the apps), so wait for it the way loadAndSettle would.
      await waitForAdmin();
      const after = await api.configGet();
      assertOk(after, "configGet after the failing load");
      expect(after.data).toEqual(before.data);
      // No "pre-load" snapshot for a load that replaced nothing.
      expect(listSnapshots()).toHaveLength(ringBefore);
    });

    // A root caddy_config_delete is a different operation wearing the same tool:
    // Caddy deletes the "config" key itself, marshals the result to null and runs
    // it, so the whole configuration is unloaded. Nothing else in this server
    // records what was there, and the mocked tests can only prove that
    // saveSnapshot was called -- not that what it stored is re-loadable, which is
    // the entire point of the safety net. So the round trip is pinned live.
    //
    // Safe to run against the suite's shared instance because the configs here
    // carry no `admin` block: Caddy re-binds the admin endpoint to the same
    // default address it was already on (localhost:2019, or $CADDY_ADMIN), so the
    // endpoint this suite talks to does not move. An instance whose CONFIG sets
    // admin.listen is the dangerous case, and that is the one this test avoids
    // creating -- see the tool description.
    it("caddy_config_delete snapshots the whole config before unloading it, and caddy_revert brings it back", async () => {
      const known = {
        apps: {
          http: {
            servers: {
              srv0: {
                listen: [":18899"],
                routes: [{ handle: [{ handler: "static_response", body: "before the unload" }] }],
              },
            },
          },
        },
      };
      assertOk(await loadAndSettle(known), "loadConfig known config");
      const before = await api.configGet();
      assertOk(before, "configGet before the unload");

      const { listSnapshots } = await import("../snapshots.js");
      const ringBefore = listSnapshots().length;

      const del = getHandler(registerConfigTools, "caddy_config_delete");
      const result = await del({ path: "", confirm: true });

      expect(result.isError, result.content?.[0]?.text).toBeFalsy();
      expect(result.content[0].text).toContain("snapshot [0]");
      // No admin.listen was unloaded, so the endpoint did NOT move -- claiming
      // it did would send an operator after a listener that never changed.
      expect(result.content[0].text).not.toContain("set admin.listen to");

      // Unloading restarts the admin endpoint exactly as a load does.
      await waitForAdmin();
      const emptied = await api.configGet();
      assertOk(emptied, "configGet after the unload");
      expect(emptied.data).toBeNull();

      const snaps = listSnapshots();
      expect(snaps).toHaveLength(ringBefore + 1);
      expect(snaps[0].trigger).toBe("caddy_config_delete");
      // Exactly what was unloaded: the handler's own GET refreshes the "/config/"
      // ETag, so the DELETE carries If-Match and Caddy either removes that config
      // or answers 412.
      expect(snaps[0].config).toEqual(before.data);

      // The half a mock cannot reach: POST /load re-creates the "config" key that
      // the DELETE removed, so the snapshot is genuinely restorable afterwards.
      const revert = getHandler(registerConfigTools, "caddy_revert");
      const restored = await revert({ action: "apply", index: 0, confirm: true });
      expect(restored.isError, restored.content?.[0]?.text).toBeFalsy();
      expect(restored.content[0].text).toContain("Reverted to snapshot [0]");
      // And it says why no roll-forward snapshot was taken, in the words that fit
      // a 200 carrying `null` -- an unloaded instance is not a failed read.
      expect(restored.content[0].text).toContain("empty or not a JSON object");
      expect(restored.content[0].text).not.toContain("could not be read");

      await waitForAdmin();
      const after = await api.configGet();
      assertOk(after, "configGet after the revert");
      expect(after.data).toEqual(before.data);
    });

    // GHSA-6859-g3p8-jc93: a root caddy_config_set is caddy_load wearing
    // caddy_config_set's clothes -- PATCH /config/ sets the whole config to the
    // body and runs it. Same reasoning as the delete round trip above: the
    // mocked tests prove saveSnapshot was called, only a live Caddy proves the
    // snapshot is what was replaced and that it loads back. And the handler's
    // own GET refreshes the "/config/" ETag, so the PATCH goes out with an
    // If-Match Caddy accepts -- a stale one would 412 here.
    //
    // Safe on the shared instance for the reason the delete test gives: neither
    // config carries an `admin` block, so the endpoint re-binds to the address
    // it was already on.
    it("caddy_config_set at the root snapshots the whole config before replacing it, and caddy_revert brings it back", async () => {
      const known = {
        apps: {
          http: {
            servers: {
              srv0: {
                listen: [":18896"],
                routes: [{ handle: [{ handler: "static_response", body: "before the replace" }] }],
              },
            },
          },
        },
      };
      assertOk(await loadAndSettle(known), "loadConfig known config");
      const before = await api.configGet();
      assertOk(before, "configGet before the replace");

      const { listSnapshots } = await import("../snapshots.js");
      const ringBefore = listSnapshots().length;

      const set = getHandler(registerConfigTools, "caddy_config_set");
      const replacement = { apps: { http: { servers: { lockprobe: { listen: [":18895"], routes: [] } } } } };
      const result = await set({ path: "", value: replacement, mode: "overwrite", confirm: true });

      expect(result.isError, result.content?.[0]?.text).toBeFalsy();
      expect(result.content[0].text).toContain("Replaced the entire config");
      expect(result.content[0].text).toContain("snapshot [0]");
      expect(result.content[0].text).not.toContain("admin.listen");

      await waitForAdmin();
      const replaced = await api.configGet();
      assertOk(replaced, "configGet after the replace");
      expect(replaced.data).toEqual(replacement);

      const snaps = listSnapshots();
      expect(snaps).toHaveLength(ringBefore + 1);
      expect(snaps[0].trigger).toBe("caddy_config_set");
      expect(snaps[0].config).toEqual(before.data);

      const revert = getHandler(registerConfigTools, "caddy_revert");
      const restored = await revert({ action: "apply", index: 0, confirm: true });
      expect(restored.isError, restored.content?.[0]?.text).toBeFalsy();
      expect(restored.content[0].text).toContain("Reverted to snapshot [0]");

      await waitForAdmin();
      const after = await api.configGet();
      assertOk(after, "configGet after the revert");
      expect(after.data).toEqual(before.data);
    });

    // caddy_config_set's description and refusal tell callers that 'append' at
    // the root REPLACES the whole config (admin.go:1279 at v2.11.4: the root
    // value is a map, never an array, so POST sets it). Only 'overwrite' was
    // pinned live; a Caddy that started merging or appending here would turn
    // that warning into wrong advice with nothing failing.
    it("caddy_config_set 'append' at the root replaces the whole config, as its warning says", async () => {
      const known = { apps: { http: { servers: { srv0: { listen: [":18894"], routes: [] } } } } };
      assertOk(await loadAndSettle(known), "loadConfig known config");
      const replacement = { apps: { http: { servers: { srv1: { listen: [":18893"], routes: [] } } } } };

      const set = getHandler(registerConfigTools, "caddy_config_set");
      const result = await set({ path: "", value: replacement, mode: "append", confirm: true });
      expect(result.isError, result.content?.[0]?.text).toBeFalsy();
      expect(result.content[0].text).toContain("Replaced the entire config");

      await waitForAdmin();
      const after = await api.configGet();
      assertOk(after, "configGet after the root append");
      // Replaced, not merged: srv0 is gone.
      expect(after.data).toEqual(replacement);
    });

    // Issue #60, pinned live: Caddy accepts a top-level "@id" and resolves
    // `/id/<it>` to the config root, so caddy_config_by_id there is a
    // whole-config write. The tool must gate it, snapshot what it replaces or
    // unloads, and hand caddy_revert something that loads back. A subpath inside
    // it stays an ordinary write. Safe on the shared instance: no admin block.
    it("caddy_config_by_id on a top-level @id gates, snapshots and reverts like a root write", async () => {
      const known = {
        "@id": "root",
        apps: { http: { servers: { srv0: { listen: [":18890"], routes: [] } } } },
      };
      assertOk(await loadAndSettle(known), "loadConfig config with a top-level @id");
      const before = await api.configGet();
      assertOk(before, "configGet before");
      const byId = getHandler(registerConfigTools, "caddy_config_by_id");
      const revert = getHandler(registerConfigTools, "caddy_revert");
      const { listSnapshots } = await import("../snapshots.js");
      const replacement = { apps: { http: { servers: { srv1: { listen: [":18889"], routes: [] } } } } };

      // No confirm: refused, and nothing changed.
      const refused = await byId({
        id: "root",
        action: "set",
        value: replacement,
        subpath: "",
        mode: "overwrite",
        confirm: false,
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("ENTIRE config");
      const unchanged = await api.configGet();
      assertOk(unchanged, "configGet after the refusal");
      expect(unchanged.data).toEqual(before.data);

      // A subpath inside it is a leaf: no confirm needed.
      const leaf = await byId({
        id: "root",
        action: "set",
        value: [":18888"],
        subpath: "apps/http/servers/srv0/listen",
        mode: "overwrite",
        confirm: false,
      });
      expect(leaf.isError, leaf.content?.[0]?.text).toBeFalsy();
      await waitForAdmin();
      const edited = await api.configGet();
      assertOk(edited, "configGet after the leaf write");

      // Confirmed: replaced, snapshotted, and revertible.
      const ringBefore = listSnapshots().length;
      const set = await byId({
        id: "root",
        action: "set",
        value: replacement,
        subpath: "",
        mode: "overwrite",
        confirm: true,
      });
      expect(set.isError, set.content?.[0]?.text).toBeFalsy();
      expect(set.content[0].text).toContain("Replaced the entire config");
      await waitForAdmin();
      const replaced = await api.configGet();
      assertOk(replaced, "configGet after the root @id set");
      expect(replaced.data).toEqual(replacement);
      expect(listSnapshots()).toHaveLength(ringBefore + 1);
      expect(listSnapshots()[0].trigger).toBe("caddy_config_by_id");
      expect(listSnapshots()[0].config).toEqual(edited.data);

      const restored = await revert({ action: "apply", index: 0, confirm: true });
      expect(restored.isError, restored.content?.[0]?.text).toBeFalsy();
      await waitForAdmin();
      const back = await api.configGet();
      assertOk(back, "configGet after the revert");
      expect(back.data).toEqual(edited.data);

      // Delete through the root @id: unloaded, snapshotted.
      const del = await byId({ id: "root", action: "delete", subpath: "", mode: "overwrite", confirm: true });
      expect(del.isError, del.content?.[0]?.text).toBeFalsy();
      expect(del.content[0].text).toContain("Unloaded the entire config");
      await waitForAdmin();
      const unloaded = await api.configGet();
      assertOk(unloaded, "configGet after the root @id delete");
      expect(unloaded.data).toBeNull();
      expect(listSnapshots()[0].trigger).toBe("caddy_config_by_id");
      expect(listSnapshots()[0].config).toEqual(edited.data);
    });

    // The two sequences the description and refusal spell out. A root DELETE
    // removes Caddy's "config" key itself (admin.go:1304), which flips both
    // verbs: 'insert' (PUT) answers 409 while the key exists -- including on an
    // instance loaded with {} -- and loads once it is gone; 'overwrite' (PATCH)
    // answers 404 once it is gone. Driven through the tools so the If-Match the
    // root branch sends (from its own pre-read) is part of what is pinned.
    it("root 'insert' answers 409 until a root delete; after one, 'overwrite' answers 404 and 'insert' loads", async () => {
      const known = { apps: { http: { servers: { srv0: { listen: [":18892"], routes: [] } } } } };
      assertOk(await loadAndSettle(known), "loadConfig known config");
      const replacement = { apps: { http: { servers: { srv1: { listen: [":18891"], routes: [] } } } } };
      const set = getHandler(registerConfigTools, "caddy_config_set");
      const del = getHandler(registerConfigTools, "caddy_config_delete");

      const conflict = await set({ path: "", value: replacement, mode: "insert", confirm: true });
      expect(conflict.isError).toBe(true);
      expect(conflict.content[0].text).toContain("key already exists: config");
      const untouched = await api.configGet();
      assertOk(untouched, "configGet after the 409");
      expect(untouched.data).toEqual(known);

      const unloaded = await del({ path: "", confirm: true });
      expect(unloaded.isError, unloaded.content?.[0]?.text).toBeFalsy();
      await waitForAdmin();

      const missing = await set({ path: "", value: replacement, mode: "overwrite", confirm: true });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toContain("key does not exist: config");

      const created = await set({ path: "", value: replacement, mode: "insert", confirm: true });
      expect(created.isError, created.content?.[0]?.text).toBeFalsy();
      await waitForAdmin();
      const after = await api.configGet();
      assertOk(after, "configGet after the root insert");
      expect(after.data).toEqual(replacement);
    });
  });
});
