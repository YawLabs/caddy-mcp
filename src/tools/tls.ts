import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiResponse } from "../api.js";
import * as api from "../api.js";
import { formatResult } from "../format.js";

/**
 * The ACME issuer fields this tool can set. Each maps 1:1 onto a field of
 * Caddy's `acme` issuer module: `email`, `ca`, and `profile`.
 *
 * `profile` arrived in Caddy 2.10 (ACME profiles, an experimental draft). It
 * selects certificate properties the CA offers by name -- Let's Encrypt uses
 * it to issue 6-day short-lived certs under the "shortlived" profile. Caddy
 * passes the value through untouched, so the set of valid names is the CA's to
 * define, not ours to validate.
 */
interface IssuerFields {
  email?: string;
  ca?: string;
  profile?: string;
}

/** Build a minimal TLS automation config with ACME issuer fields (used only when apps/tls is absent) */
function buildTlsConfig(fields: IssuerFields) {
  const issuer: Record<string, string> = { module: "acme" };
  if (fields.email) issuer.email = fields.email;
  if (fields.ca) issuer.ca = fields.ca;
  if (fields.profile) issuer.profile = fields.profile;
  return {
    automation: {
      policies: [{ issuers: [issuer] }],
    },
  };
}

/**
 * Build an error result surfacing both PATCH and the follow-up write failure.
 *
 * `hint` is APPENDED on its own line, after both of Caddy's errors verbatim -- it
 * never replaces them. It exists for a failure whose status names a fact but not
 * a single cause (see CREATE_CONFLICT_HINT), where the caller is better served by
 * the possibilities than by a guess.
 */
function bothErrors(label: string, patchRes: ApiResponse, writeRes: ApiResponse, writeLabel: string, hint?: string) {
  const patchErr = patchRes.error || `HTTP ${patchRes.status}`;
  const writeErr = writeRes.error || `HTTP ${writeRes.status}`;
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text:
          `Error: Failed to set ${label}.\n  PATCH attempt: ${patchErr}\n  ${writeLabel} fallback: ${writeErr}` +
          (hint ? `\n  ${hint}` : ""),
      },
    ],
  };
}

/**
 * Whether a config GET says "nothing is set at this path".
 *
 * Caddy never answers a GET of a missing config path with a 404: every readConfig
 * error is wrapped as 400 (admin.go handleConfig, identical at v2.10.0 and v2.11.4),
 * and a missing FINAL key is not an error at all. Verified against Caddy 2.11.4:
 *   parent exists, final key absent  -> 200 null
 *   a parent segment is missing      -> 400 {"error":"invalid traversal path at: config/apps/tls"}
 *   the whole config is null         -> 400 {"error":"invalid traversal path at: config/apps"}
 * Both count as absent. Matching only "404 or null" -- which is what this file did
 * -- left the two traversal shapes falling through as raw Go errors, and those are
 * exactly the states a fresh instance is in (`caddy run` with no config, or a config
 * with no `apps` key).
 *
 * Deliberately no 404 arm: since Caddy does not send one here, a 404 is some other
 * layer talking (a proxy in front of the admin API, a wrong CADDY_ADMIN_URL) and
 * says nothing about what the config holds, so the read-only actions surface it
 * verbatim rather than reporting "not configured".
 *
 * A 200 null cannot tell "key absent" from "key present, value null" -- the bodies
 * are byte identical, and 2.11.4 does load {"apps":{"tls":{"encrypted_client_hello":null}}}
 * -- so messages built on this say "not set", not "does not exist".
 */
function isAbsentOnGet(res: ApiResponse): boolean {
  if (res.ok) return res.data === undefined || res.data === null;
  return api.isMissingConfigPath(res);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep clone via JSON round-trip — apps/tls is plain JSON config so this is safe. */
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Apply email/ca patch to a deep copy of an existing apps/tls config that already
 * contains automation.policies[0].issuers[0]. Caller must have validated the shape.
 */
function mergeIssuerFields(existing: Record<string, unknown>, fields: IssuerFields) {
  const merged = deepClone(existing);
  // Cast through unknown — we've shape-checked the path before reaching here.
  const automation = merged.automation as { policies: Array<{ issuers: Array<Record<string, unknown>> }> };
  const issuer = automation.policies[0].issuers[0];
  if (fields.email !== undefined) issuer.email = fields.email;
  if (fields.ca !== undefined) issuer.ca = fields.ca;
  if (fields.profile !== undefined) issuer.profile = fields.profile;
  return merged;
}

/**
 * Validate that an existing apps/tls config has the path we need to merge into:
 * automation.policies[0].issuers[0] must be a non-null plain object.
 * Returns null if shape is OK, or a specific error message naming the missing sub-path.
 */
function validateIssuerShape(tls: Record<string, unknown>): string | null {
  const automation = tls.automation;
  if (!isPlainObject(automation)) {
    return "apps/tls.automation is missing or not an object";
  }
  const policies = (automation as Record<string, unknown>).policies;
  if (!Array.isArray(policies) || policies.length === 0) {
    return "apps/tls.automation.policies is missing, not an array, or empty";
  }
  const policy0 = policies[0];
  if (!isPlainObject(policy0)) {
    return "apps/tls.automation.policies[0] is not an object";
  }
  const issuers = (policy0 as Record<string, unknown>).issuers;
  if (!Array.isArray(issuers) || issuers.length === 0) {
    return "apps/tls.automation.policies[0].issuers is missing, not an array, or empty";
  }
  const issuer0 = issuers[0];
  if (!isPlainObject(issuer0)) {
    return "apps/tls.automation.policies[0].issuers[0] is not an object";
  }
  return null;
}

/** The issuer module that `email` / `ca` / `profile` actually belong to. */
const ACME_ISSUER_MODULE = "acme";

/**
 * Confirm policies[0].issuers[0] is an ACME issuer before merging ACME fields into it.
 * Returns null when it is, or a message naming the module actually found.
 *
 * Structure is not enough: `{ "module": "internal" }` (Caddy's local CA) passes
 * validateIssuerShape and is an entirely ordinary config, yet carries none of these
 * fields. Writing `email` or `profile` onto it produces a config Caddy rejects on
 * load, and `ca` is worse -- `internal` has its own `ca` key naming a PKI CA id
 * ("local"), so set_acme_ca would silently repoint it at an ACME directory URL.
 *
 * Only the merge path needs this guard. The PATCH-first path in setIssuerField cannot
 * introduce a foreign field, because Caddy's PATCH requires the key to already exist at
 * the target path (see safeFallback below) -- it can only overwrite a field the issuer
 * already carries. And buildTlsConfig writes `module: "acme"` itself, so the
 * absent-apps/tls branch is ACME by construction.
 *
 * Caller must have run validateIssuerShape first: the path is assumed present.
 */
function validateIssuerModule(tls: Record<string, unknown>): string | null {
  // Same cast as mergeIssuerFields -- the path is shape-checked before we get here.
  const automation = tls.automation as { policies: Array<{ issuers: Array<Record<string, unknown>> }> };
  const found = automation.policies[0].issuers[0].module;
  if (found === ACME_ISSUER_MODULE) return null;
  const describe = found === undefined ? "absent" : JSON.stringify(found);
  return (
    `Refusing to write an ACME field onto a non-ACME issuer: ` +
    `apps/tls.automation.policies[0].issuers[0].module is ${describe}, not "${ACME_ISSUER_MODULE}". ` +
    `email/ca/profile are fields of the acme issuer module only. Use caddy_config_set with an explicit ` +
    `path to edit this issuer, or point this tool at a config whose first policy uses an acme issuer.`
  );
}

/**
 * Outcome of the safe fallback after a PATCH failure.
 *  - kind="ok": the fallback succeeded; caller emits the standard success message.
 *  - kind="tool-error": surface a tool error result (refusal or downstream failure).
 */
type FallbackOutcome =
  | { kind: "ok" }
  | { kind: "tool-error"; result: { isError: true; content: Array<{ type: "text"; text: string }> } };

/**
 * Build the "PATCH failed and the fallback will not proceed" result. All three refusal
 * branches below share the same two-line preamble; only the trailing reason differs.
 */
function refuseFallback(label: string, patchRes: ApiResponse, detail: string): FallbackOutcome {
  return {
    kind: "tool-error",
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `Error: Failed to set ${label}.\n` +
            `  PATCH attempt: ${patchRes.error || `HTTP ${patchRes.status}`}\n` +
            `  ${detail}`,
        },
      ],
    },
  };
}

/**
 * Appended when the create-PUT in safeFallback answers 409. On 2.11.4 that status has
 * exactly one source in the config handler -- "key already exists" -- so it is a FACT
 * that apps/tls is present now and that this write replaced nothing. How it came to be
 * present is not knowable from here, and there are two ways, so name both: another
 * writer won the race between the GET and the PUT, or api.ts replayed this PUT after a
 * transient failure whose first attempt had in fact landed.
 *
 * (A key that was there all along holding a JSON null -- which a GET renders exactly
 * like an absent one -- is NOT a third way here, though it is for a server key: apps/tls
 * is a module, and Caddy 2.11.4 refuses to load {"apps":{"tls":null}} with 400 "module
 * value cannot be null".)
 *
 * Either way the remedy is the same, and it is safe: re-running takes the merge branch.
 */
const CREATE_CONFLICT_HINT =
  "apps/tls read as not set, but Caddy now reports the key exists, so nothing was overwritten. Either something " +
  "else created it between the read and this write, or an earlier attempt of this same write landed and only " +
  "its response was lost. Check caddy_tls status, then re-run this action so it merges into what is there " +
  "instead of creating it.";

/**
 * Run the safe fallback after a PATCH failure: GET apps/tls, then either
 *  - PUT a fresh apps/tls when none is set -- which also creates a missing `apps`
 *    parent, or the whole config tree on an instance that has no config at all,
 *  - merge into the existing config and PATCH it back (preserves siblings), or
 *  - refuse: a shape-specific error (do not clobber), or a non-ACME issuer module.
 */
async function safeFallback(label: string, patchRes: ApiResponse, fields: IssuerFields): Promise<FallbackOutcome> {
  const getRes = await api.configGet<unknown>("apps/tls");

  // Branch 1: apps/tls is not set -> create it. "Not set" is a 200 null OR a traversal
  // 400 (see isAbsentOnGet); the traversal shapes are the fresh-instance states, and they
  // used to land in the "any other GET failure" arm below as two raw Go errors.
  //
  // No 404 arm, for the reason isAbsentOnGet gives: Caddy never answers a config GET
  // with 404, so one comes from some other layer and says nothing about apps/tls.
  // Treating it as "absent" was harmless to the config (the PUT that follows is
  // strictly-create), but not to the operator: when apps/tls did exist, the PUT's 409
  // got CREATE_CONFLICT_HINT, whose two causes were then both false, and a re-run met
  // the same 404 and the same 409 every time. A 404 now takes the "any other GET
  // failure" arm below: the GET's own error is shown verbatim and nothing is written.
  const absent = isAbsentOnGet(getRes);
  if (absent) {
    // PUT, not POST, for two reasons. Verified against Caddy 2.11.4:
    //
    //  1. PUT creates missing PARENTS as it walks the path (admin.go: `if v[part] == nil
    //     && method == http.MethodPut { v[part] = make(map[string]any) }`); POST does
    //     not. On a null config, or one with no `apps` key, POST apps/tls fails the same
    //     path walk the GET did -- 500 "invalid traversal path at: config/apps" -- while
    //     PUT answers 200 and leaves {"apps":{"tls":{...}}}. So POST could only ever
    //     create apps/tls where `apps` already existed, which is not what "works on a
    //     fresh instance" means.
    //  2. PUT on an object key is strictly-create; POST on one REPLACES it (`v[part] =
    //     val`). If apps/tls appears between the GET above and this write, PUT answers
    //     409 "key already exists: tls" where POST would silently swap a whole TLS
    //     config for this one-issuer stub. It is the same 409 that rules PUT out of the
    //     merge branch below; here the strictness is the point.
    const putRes = await api.configPut("apps/tls", buildTlsConfig(fields));
    if (putRes.ok) return { kind: "ok" };
    const hint = putRes.status === 409 ? CREATE_CONFLICT_HINT : undefined;
    return { kind: "tool-error", result: bothErrors(label, patchRes, putRes, "PUT", hint) };
  }

  // Any other GET failure: surface it alongside the PATCH error — do not clobber.
  if (!getRes.ok) {
    return { kind: "tool-error", result: bothErrors(label, patchRes, getRes, "GET apps/tls") };
  }

  // GET succeeded with a value — must be an object to be a usable apps/tls config.
  if (!isPlainObject(getRes.data)) {
    return refuseFallback(
      label,
      patchRes,
      `Refusing to clobber existing apps/tls: GET returned a non-object value. ` +
        `Use caddy_config_set with an explicit path to update it safely.`,
    );
  }

  // Branch 3: existing apps/tls but the issuer sub-path we'd merge into is missing/wrong.
  const shapeError = validateIssuerShape(getRes.data);
  if (shapeError) {
    return refuseFallback(
      label,
      patchRes,
      `Refusing to clobber existing apps/tls: ${shapeError}. ` +
        `Use caddy_config_set with an explicit path (e.g. apps/tls/automation/policies) ` +
        `to update it safely.`,
    );
  }

  // Branch 3b: the path exists, but the issuer sitting there is not an ACME one, so
  // `email`/`ca`/`profile` are not its fields. Refuse rather than write a foreign key.
  const moduleError = validateIssuerModule(getRes.data);
  if (moduleError) {
    return refuseFallback(label, patchRes, moduleError);
  }

  // Branch 2: shape is good — merge into a deep copy and write it back whole so siblings
  // (custom certs, on_demand, certificate_authorities, additional policies/issuers) are
  // preserved. Sibling preservation comes from merging the full object, not from the verb.
  //
  // PATCH, not PUT. Caddy's PUT on a non-array key is strictly-create: it returns
  //   409 {"error":"[/config/apps/tls] key already exists: tls"}
  // whenever apps/tls is already present -- which is exactly the condition this branch
  // runs under, so the PUT could never succeed. PATCH requires the key to exist, which it
  // does here. Verified against Caddy 2.11.4: PUT -> 409, PATCH -> 200 with the issuer
  // replaced. This mattered little for set_email/set_acme_ca (a configured issuer already
  // carries those keys, so the PATCH happy path handles them), but a fresh ACME issuer
  // never carries `profile`, so set_acme_profile reaches this branch on the normal path.
  const merged = mergeIssuerFields(getRes.data, fields);
  const mergeRes = await api.configPatch("apps/tls", merged);
  if (mergeRes.ok) return { kind: "ok" };
  return { kind: "tool-error", result: bothErrors(label, patchRes, mergeRes, "PATCH apps/tls") };
}

/**
 * Set one ACME issuer field: PATCH the exact sub-path first (which works
 * whenever the issuer already exists), then fall back to the shape-checked
 * create-or-merge path when it does not.
 *
 * Shared by set_email / set_acme_ca / set_acme_profile so all three keep
 * identical clobber-safety semantics -- the fallback is the delicate part, and
 * three hand-copied versions of it would drift.
 *
 * The PATCH here needs no issuer-module guard: it only succeeds when the key already
 * exists on that issuer, so it can overwrite an ACME field but never add one. The
 * fallback's merge path is the one that can, and it checks (see validateIssuerModule).
 */
async function setIssuerField(field: keyof IssuerFields, value: string, label: string) {
  const patchRes = await api.configPatch(`apps/tls/automation/policies/0/issuers/0/${field}`, value);
  const ok = { content: [{ type: "text" as const, text: `${label} set to: ${value}` }] };
  if (patchRes.ok) return ok;
  const outcome = await safeFallback(label, patchRes, { [field]: value });
  return outcome.kind === "ok" ? ok : outcome.result;
}

function missingArgError(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `Error: ${text}` }] };
}

export function registerTlsTools(server: McpServer) {
  server.tool(
    "caddy_tls",
    "Get or configure TLS/HTTPS settings. Actions: 'status' shows current TLS config, 'set_email' sets the ACME email, " +
      "'set_acme_ca' sets the ACME CA URL, 'set_acme_profile' sets the ACME profile (Caddy 2.10+), " +
      "'ech_status' reads the Encrypted ClientHello config at apps/tls/encrypted_client_hello (Caddy 2.10+, read-only here). " +
      "Works on both fresh and existing Caddy instances, including one with no config at all: the set_* actions " +
      "create apps/tls, and any missing parents, when it is not set. Writes target policies[0].issuers[0] only, and only " +
      "when that issuer's module is 'acme' -- on a multi-policy TLS config, or one whose first issuer is " +
      "'internal' (Caddy's local CA), edit the intended issuer with caddy_config_set instead.",
    {
      action: z
        .enum(["status", "set_email", "set_acme_ca", "set_acme_profile", "ech_status"])
        .describe("Action to perform"),
      email: z.string().optional().describe("ACME email address (for 'set_email' action)"),
      ca: z.string().optional().describe("ACME CA URL (for 'set_acme_ca' action)"),
      profile: z
        .string()
        .optional()
        .describe(
          "ACME profile name (for 'set_acme_profile'). Requires Caddy 2.10+ and a CA that offers profiles; " +
            "Let's Encrypt uses 'shortlived' for 6-day certificates. Valid names are defined by the CA, not by Caddy.",
        ),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ action, email, ca, profile }) => {
      if (action === "status") {
        const tlsRes = await api.configGet("apps/tls");
        // An instance with no explicit TLS config is an ordinary state, not a failure,
        // and on a fresh one the GET does not even succeed: a null config or one with
        // no `apps` key answers 400 "invalid traversal path" (see isAbsentOnGet), which
        // used to reach the caller as a raw Go error. Say what it means instead. The
        // 200 null case gets the same sentence rather than the bare word "null".
        if (isAbsentOnGet(tlsRes)) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "No TLS config is set on this instance (apps/tls is not set), so Caddy's TLS defaults apply. " +
                  "The set_email / set_acme_ca / set_acme_profile actions create it.",
              },
            ],
          };
        }
        return formatResult(tlsRes);
      }
      if (action === "ech_status") {
        // Encrypted ClientHello lives at apps/tls/encrypted_client_hello (Caddy 2.10+)
        // -- NOT apps/tls/ech, which is what this action read until 2.5.3. `ech` is
        // only the Caddyfile global option; the JSON tag on the TLS app is
        // `encrypted_client_hello` at v2.10.0, v2.11.4 and master alike.
        //
        // The wrong key failed SILENTLY, which is why it shipped. Caddy answers a GET
        // of any unknown final key with 200 null, and rejects apps.tls.ech on load as an
        // unknown field, so the old path could only ever come back null -- "not
        // configured", on an instance with ECH on. Verified against Caddy 2.11.4:
        //   ECH on:  GET apps/tls/ech                    -> 200 null
        //            GET apps/tls/encrypted_client_hello -> 200 {"configs":[{"public_name":...}]}
        //   POST /load with apps.tls.ech -> 400 ... tls: json: unknown field "ech"
        // A mocked test cannot see any of that (it pinned the wrong path and passed), so
        // the path is also asserted against a live Caddy in integration.test.ts.
        //
        // Read-only: enabling ECH needs a DNS provider credential and a publication
        // policy, which belong in a full config written via caddy_load, not a
        // one-field PATCH.
        const echRes = await api.configGet("apps/tls/encrypted_client_hello");
        // ECH is rarely enabled, so "not configured" is the ordinary answer rather
        // than a failure. Caddy does NOT report it as a 404: with apps/tls present the
        // missing final key is 200 null, and with no apps/tls at all -- the most common
        // real config, apps.http only -- the missing PARENT is 400 "invalid traversal
        // path at: config/apps/tls/encrypted_client_hello". Both mean ECH is not set;
        // anything else (a 5xx, an auth failure, a 404 from some other layer) is a real
        // read failure and goes out verbatim.
        if (isAbsentOnGet(echRes)) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "ECH (Encrypted ClientHello) is not configured on this instance: apps/tls/encrypted_client_hello " +
                  "is not set. Requires Caddy 2.10+; enable it by applying a config that sets " +
                  "apps.tls.encrypted_client_hello via caddy_load. The JSON key is 'encrypted_client_hello' -- " +
                  "'ech' is only the Caddyfile global option name, and Caddy rejects apps.tls.ech as an unknown field.",
              },
            ],
          };
        }
        return formatResult(echRes);
      }
      if (action === "set_email") {
        if (!email) return missingArgError("email is required for set_email action");
        return setIssuerField("email", email, "ACME email");
      }
      if (action === "set_acme_ca") {
        if (!ca) return missingArgError("ca is required for set_acme_ca action");
        return setIssuerField("ca", ca, "ACME CA");
      }
      if (action === "set_acme_profile") {
        if (!profile) return missingArgError("profile is required for set_acme_profile action");
        return setIssuerField("profile", profile, "ACME profile");
      }
      // Unreachable, and deliberately not live error handling: zod rejects any value
      // outside the enum before this handler runs, and every member is handled above.
      // TypeScript still demands a terminal return, so this one doubles as an
      // exhaustiveness assertion -- add a member to the action enum without a branch for
      // it and the assignment to `never` stops compiling, here, at the omission.
      const unhandled: never = action;
      return { isError: true, content: [{ type: "text" as const, text: `Unknown action: ${String(unhandled)}` }] };
    },
  );
}
