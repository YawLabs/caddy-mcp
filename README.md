# @yawlabs/caddy-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/caddy-mcp)](https://www.npmjs.com/package/@yawlabs/caddy-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/caddy-mcp)](https://github.com/YawLabs/caddy-mcp/stargazers)

**Manage Caddy web servers from Claude Code, Cursor, and any MCP client.** 18 tools + 4 resources covering every endpoint in Caddy's admin API reference — config, routes, reverse proxies, TLS, PKI, metrics, snapshots.

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=Caddy&command=npx&args=-y%2C%40yawlabs%2Fcaddy-mcp&description=Manage%20Caddy%20web%20servers%20-%20config%2C%20routes%2C%20TLS%2C%20PKI&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fcaddy-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## Why this one?

Other Caddy MCP servers wrap half the admin API and silently swallow errors. This one doesn't.

- **Complete admin API coverage** — every endpoint in [Caddy's admin API reference](https://caddyserver.com/docs/api): `/load`, `/config/*`, `/id/*`, `/stop`, `/adapt`, `/pki/ca/*`, `/reverse_proxy/upstreams`, `/metrics`. No placeholder tools that 404. Caddy's Go runtime debug endpoints (`/debug/pprof/*`, `/debug/vars`) are deliberately not wrapped — for leak trends use `caddy_metrics` with `filter: "go_goroutines"` or `"go_memstats"`, which come from the same admin registry; for stack dumps, CPU profiles and traces, curl the admin endpoint directly ([Caddy profiling docs](https://caddyserver.com/docs/profiling)).
- **Safe concurrent writes** — uses ETags (`If-Match`) so your changes never silently overwrite someone else's. Surfaces `HTTP 412 Precondition Failed` as a clear message, not a cryptic error.
- **Safe-by-default mutations** — `caddy_config_set` defaults to idempotent `overwrite` (PATCH), not `append` (POST). Calling twice doesn't duplicate your route.
- **Defensive parsing** — `caddy_list_routes` never crashes on malformed config, even if routes are null, handlers are strings, or matchers are non-arrays. Regression-tested.
- **No leaked credentials in errors** — if `CADDY_ADMIN_URL` contains a token in the path/query, the connect-failed message shows only the origin.
- **Fallback error surfacing** — when a TLS write PATCH fails and the PUT fallback also fails, both error bodies are returned so you know what actually went wrong.
- **Tool annotations** — every tool declares `readOnlyHint`, `destructiveHint`, and `idempotentHint`, so MCP clients can skip confirmations for safe ops.
- **Instant startup** — ships as a single bundle with two runtime deps (the MCP SDK + Zod). No 5-minute `node_modules` install.
- **Input hardening** — adapter names, `@id` values, server names, and CA ids are all regex-validated with length caps. Blocks CRLF header injection and ReDoS.

## Quick start

**1. Enable the Caddy admin API**

Caddy ships with the admin API enabled on `localhost:2019` by default. If you're running Caddy in Docker or on a remote host, expose it via `CADDY_ADMIN_URL`.

**2. Create `.mcp.json` in your project root**

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "caddy": {
      "command": "npx",
      "args": ["-y", "@yawlabs/caddy-mcp@latest"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "caddy": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/caddy-mcp@latest"]
    }
  }
}
```

> **Why the extra step on Windows?** Since Node 20, `child_process.spawn` cannot directly execute `.cmd` files (that's what `npx` is on Windows). Wrapping with `cmd /c` is the standard workaround. This file is safe to commit — it contains no secrets.

**3. Restart and approve**

Restart Claude Code (or your MCP client) and approve the Caddy MCP server when prompted.

That's it. Now ask your AI assistant:

> "Proxy api.local to localhost:3000"
>
> "What routes are configured on srv0?"
>
> "Show me the Prometheus metrics"

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `CADDY_ADMIN_URL` | `http://localhost:2019` | Caddy admin API URL. Set to `http://caddy:2019` inside Docker, or an https URL for an admin endpoint behind a TLS-terminating reverse proxy — see Troubleshooting for the `Host` / `Origin` rules Caddy applies to anything that is not its own loopback address. Caddy's native remote admin listener (`admin.remote`, default `:2021`) is **not** supported: it requires a TLS client certificate, which caddy-mcp does not present. Also accepts a unix socket, in either `unix:///var/run/caddy-admin.sock` or Caddy's own `unix//var/run/caddy-admin.sock` spelling — see below. |
| `CADDY_API_TOKEN` | (none) | Optional Bearer token, sent as `Authorization: Bearer <token>` on every request. Caddy's admin API has no token auth of its own and ignores this header — it matters only to an authenticating proxy in front of the admin endpoint, so leave it unset when caddy-mcp reaches Caddy directly. If the header does arrive at the admin listener, Caddy 2.0 through 2.11.2 writes it in clear into the `admin.api` "received request" log line, at INFO — on every path except `/metrics`, which has logged at DEBUG since 2.2.1. Run Caddy 2.11.3 or later, which logs it as `REDACTED`, or have the proxy strip the header once it has authenticated (Caddy: `header_up -Authorization`; nginx: `proxy_set_header Authorization "";`). |
| `CADDY_MCP_SNAPSHOT_DIR` | (none) | Directory for persisting `caddy_revert` snapshots. Unset, snapshots live in memory only and are lost when this server restarts. Snapshots are full Caddy configs and can contain secrets, so the location is opt-in rather than defaulted. |
| `CADDY_MAX_RETRIES` | `2` | Number of retries on transient failures: network errors, and 502/503/504 (which only a proxy in front of Caddy sends). Caddy's own 500s are deterministic rejections and never retry, nor do 4xx and 412. Requests a replay could change the outcome of also skip retry: POSTs to `/config/*` and `/id/*` (they append, or replace an existing key -- retrying could duplicate routes), and a PUT or DELETE at an array index such as `.../routes/0` (a replay would insert a second route, or remove the one that slid into that index), including a PUT to a bare `/id/<id>`, which Caddy resolves to the identified element's array index. Those match however the path is spelled — with trailing slashes, or with the trailing `/...` segment Caddy strips before it picks a method, so `.../routes/0/...` and `PUT /id/<id>/...` are covered too. A config change whose timeout fired is never retried (see `CADDY_LOAD_TIMEOUT`). A refused connection retries for every method, since nothing was sent. POSTs to `/load`, `/adapt`, `/stop` still retry. Hard-capped at 5; values above the cap log a one-time stderr notice so the clamp is visible. Set to `0` to disable. |
| `CADDY_TIMEOUT` | `10000` | Timeout in ms for admin API requests that do not change the config: GETs, `/adapt`, `/stop`, PKI, upstreams and metrics. Config changes use `CADDY_LOAD_TIMEOUT`. Non-numeric, `<= 0`, or fractional values below 1ms fall back to the default. |
| `CADDY_LOAD_TIMEOUT` | `55000` | Timeout in ms for every request that changes the config: `POST /load`, and every POST/PUT/PATCH/DELETE under `/config/*` and `/id/*`. Each is a full synchronous reload inside Caddy, which can legitimately run long -- Caddy sleeps through `apps.http.shutdown_delay` inside the reload whenever a change closes a listener, and a change can wait behind another reload. A timeout here is never retried: Caddy keeps applying a change after the client gives up, so the error says the outcome is unknown and to re-read the config before retrying (`caddy_load` and `caddy_revert` keep their snapshot in that case). Keep it below your MCP client's request timeout (60 s by default in the MCP SDK), or that error arrives after the client has given up and is never shown; the default sits 5 s under it. Non-numeric, `<= 0`, or fractional values below 1ms fall back to the default. |

**Unix socket admin endpoints:**

Caddy's recommended hardening is to move the admin API off a loopback port and
onto a unix socket, where access is governed by filesystem permissions:

```
{
  admin unix//var/run/caddy-admin.sock
}
```

Point `CADDY_ADMIN_URL` at the same path (`unix:///var/run/caddy-admin.sock`)
and requests are sent over the socket instead of TCP. The process running
caddy-mcp needs read/write permission on the socket file. Leave
`CADDY_API_TOKEN` unset here unless an authenticating proxy actually listens on
that socket: over a unix path caddy-mcp is usually talking to Caddy's own
socket, where the token does nothing — and, before Caddy 2.11.3, is logged in
clear.

**Alternate MCP clients:**

| Client | Config file |
|---|---|
| Claude Code | `.mcp.json` (project root) or `~/.claude.json` (global) |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `.vscode/mcp.json` |

Use the same JSON block shown above in any of these.

## Tools

### Config management (6)

- **caddy_config_get** — Read config at any JSON path (or the full config).
- **caddy_config_set** — Write config at a path. Modes: `overwrite` (PATCH, default, idempotent; the key must exist), `append` (POST: appends to an array, but replaces an existing non-array key and cannot create missing parents), `insert` (PUT: inserts at an array position, or strictly creates a key along with any missing parents and fails with 409 if it exists — the way to create a server or app, even on an instance with no config). `append` at a path ending in `/...` (e.g. `apps/http/servers/srv0/routes/...`) with an **array** value appends every element in one request — all or nothing, one reload; without the `/...`, an array value is added as a single element and Caddy rejects the load for typed arrays like `routes` or `listen`.
- **caddy_config_delete** — Delete config at a path. Requires `confirm=true` (deleting a parent path also removes every descendant). An empty path (`''`, `'/'`, `'config'`, `'/config/'`) addresses the **entire** config: it unloads every app and server plus the `admin` block, after which Caddy re-binds its admin endpoint to its default address (`localhost:2019`, or `$CADDY_ADMIN` in Caddy's environment) — if `CADDY_ADMIN_URL` points anywhere else, neither caddy-mcp nor `caddy_revert` can reach Caddy afterwards. A root delete auto-snapshots the prior config first (when it can be read), so `caddy_revert` can restore it while Caddy is still reachable; no other path is snapshotted. To replace the config rather than unload it, use `caddy_load`.
- **caddy_config_by_id** — Get/set/delete config by `@id` tag — much easier than navigating deep paths. The `delete` action requires `confirm=true`.
- **caddy_load** — Replace the entire config atomically. Runs on `CADDY_LOAD_TIMEOUT` (55 seconds by default), like every config change. Auto-snapshots the prior config, and keeps that snapshot when the load times out with its outcome unknown. Lists the Caddyfile adapter's warnings, and reports a load that failed as an error even when Caddy answered HTTP 200 — which Caddy 2.11.4 does for a Caddyfile that adapted with warnings ([caddyserver/caddy#7246](https://github.com/caddyserver/caddy/issues/7246)). `format` is `json` (default) or `caddyfile`; stock Caddy registers only the `caddyfile` adapter, so for any other adapter compiled into a custom build, adapt first with `caddy_adapt` and load the JSON (the Atomic deploy example below).
- **caddy_revert** — Manage config snapshots for rollback. Actions: `list`, `save`, `apply` (confirm-gated). In-memory, last 10. Auto-captured before `caddy_load`, and before a `caddy_config_delete` at the config root. An `apply` that times out with its outcome unknown keeps the pre-revert config as snapshot [0], which shifts every older snapshot down one index; the error says where the target now sits.

### Route operations (4)

- **caddy_reverse_proxy** — Add a reverse proxy in one call: `from='api.local' to=['localhost:3000']`. Pass an optional `id` for idempotent writes — repeat calls replace the route in place instead of duplicating.
- **caddy_add_route** — Add a route with full match/handle control (any Caddy handler).
- **caddy_remove_route** — Remove a route by `@id` (preferred) or by index. Requires `confirm=true`.
- **caddy_list_routes** — Human-readable route summary. Defensive: never crashes on weird config.

### TLS & config conversion (2)

- **caddy_tls** — Check or set TLS settings. Actions: `status`, `set_email` (ACME email), `set_acme_ca` (ACME CA URL), `set_acme_profile` (ACME profile, Caddy 2.10+ — experimental upstream: the ACME profiles spec is still a draft and Caddy marks the field subject to change. Caddy accepts any profile name on load, so a name the CA does not advertise fails only at issuance, in Caddy's own logs), and the read-only `ech_status` (the Encrypted ClientHello config at `apps/tls/encrypted_client_hello`, Caddy 2.10+). The set actions PATCH first; when `apps/tls` is not set they PUT a minimal config, which also creates any missing parents, so they work on an instance with no config at all. On an existing config they deep-merge into the issuer path and PATCH the result back, preserving siblings (custom certs, `on_demand`, additional policies). Refuses with a shape-specific error if the existing structure is unexpected — never clobbers.
- **caddy_adapt** — Convert a config in any registered adapter format to Caddy JSON without applying it. `caddyfile` (built-in, default) plus any adapter module compiled into your Caddy binary — e.g., `nginx` ([caddy-nginx-adapter](https://github.com/caddyserver/nginx-adapter)), `yaml` ([caddy-yaml](https://github.com/abiosoft/caddy-yaml)). Great for previewing or porting from existing configs. One caveat on Caddy 2.11.4 and earlier: a Caddyfile `order` global option is not preview-only. It mutates that Caddy process's directive order, so it carries into later Caddyfile adapts and loads in the same process, and an `order` line that *fails* still removes the directive it names ([caddyserver/caddy#7995](https://github.com/caddyserver/caddy/pull/7995), fixed upstream but unreleased as of 2.11.4).

### Server operations (6)

- **caddy_status** — Connectivity check + config summary (server count, routes, TLS mode). The TLS label replays Caddy's own automatic-HTTPS rule over the stored config instead of guessing from the listen port, so it reads `enabled`, `enabled (no listener gets TLS: all are on the HTTP port)`, `auto (HTTPS)`, `auto (HTTPS: host matchers on a non-HTTP port)`, `mixed (TLS on non-HTTP listeners only)`, `off (HTTP only)`, `off (no host matchers)`, `off (automatic HTTPS disabled)` or `off (empty tls_connection_policies)`. The two qualified `enabled` readings come from Caddy deciding TLS per socket rather than per server (`app.go:535`): connection policies are ignored on the HTTP-port listener, so a server that binds only that port is configured for TLS and serves none of it.
- **caddy_list_servers** — List all HTTP servers with names, addresses, route counts, and TLS status. Same labels as `caddy_status`, but this tool reads only `apps/http/servers` and so assumes the default `http_port` 80 / `https_port` 443 — on an instance with custom ports, `caddy_status` is the one that gets the label right.
- **caddy_upstreams** — Reverse proxy backend health, as Caddy's `/reverse_proxy/upstreams` array returned verbatim. On Caddy 2.11.2+ this is **not** the configured upstream list: dynamic upstreams stay listed about 1 h after the dynamic source last returned them (so an address can outlive the config that referenced it), and a backend with requests in flight can appear twice when its resolved address differs from the entry's dial text. The extra copy always shows `fails 0` and repeats `num_requests` — do not sum `num_requests` across entries.
- **caddy_metrics** — Prometheus metrics (request counts, durations, connections, TLS handshakes). Optional `filter` (substring match on metric name, keeps `# HELP` / `# TYPE` lines for retained metrics) and `max_lines` (default 500) keep responses compact on busy servers.
- **caddy_pki** — CA info and certificate chains (default CA: `local`).
- **caddy_stop** — Graceful shutdown. Requires `confirm=true` to prevent accidents.

## Resources

Browsable read-only data — MCP clients can fetch these directly without a tool call:

- `caddy://config` — Current full Caddy JSON configuration.
- `caddy://servers` — Summary of all configured HTTP servers.
- `caddy://upstreams` — Reverse proxy upstream health status, verbatim. Same 2.11.2+ caveat as `caddy_upstreams`: lingering dynamic upstreams and duplicate in-flight entries; do not sum `num_requests`.
- `caddy://metrics` — Prometheus metrics (text exposition format). Capped at the first 500 lines to keep client context bounded; use the `caddy_metrics` tool with `filter` / `max_lines` for filtered or larger output.

## Examples

### Add a reverse proxy

```
> "Proxy api.example.com to my app on port 3000"
→ caddy_reverse_proxy({ from: "api.example.com", to: ["localhost:3000"] })
```

### Idempotent reverse proxy (safe to re-run from automation)

```
> "Make sure api.example.com points at localhost:3000, with a stable id"
→ caddy_reverse_proxy({ from: "api.example.com", to: ["localhost:3000"], id: "api-prod" })
  # First call creates the route under @id="api-prod".
  # Subsequent calls with the same id REPLACE in place — no duplicate routes.
  # Refuses with a clear error if "api-prod" is already in use by a non-route
  # config object (TLS issuer, server, etc.) — @ids are config-global in Caddy.
```

### Filter Prometheus metrics

```
> "Just the HTTP request metrics, please"
→ caddy_metrics({ filter: "http_requests" })
  # Keeps sample lines whose metric name contains "http_requests",
  # plus their `# HELP` / `# TYPE` lines. Drops the rest.
```

### Preview a Caddyfile before applying it

```
> "Convert this Caddyfile to JSON so I can review it:
   example.com {
     reverse_proxy localhost:8080
   }"
→ caddy_adapt({ config: "..." })
```

### Diagnose slow routes

```
> "Fetch Prometheus metrics and tell me which route is slowest"
→ caddy_metrics()
```

### Safely update a route by @id

```
> "Update the route with @id 'api-v2' to point to the new backend"
→ caddy_config_by_id({ id: "api-v2", action: "set", value: {...} })
  # Uses ETags — you'll get HTTP 412 if someone else changed it first
```

### Atomic deploy

```
> "Replace the whole config with this Caddyfile"
→ caddy_adapt({ config: "..." })  # validate first
→ caddy_load({ config: adaptedJson })  # apply atomically
```

## Troubleshooting

**"Cannot connect to Caddy admin API"**

- Make sure Caddy is running. `caddy run` or `systemctl status caddy`.
- Check the admin endpoint. Default is `http://localhost:2019`. If Caddy is in Docker, use the container hostname.
- Set `CADDY_ADMIN_URL` in your MCP config `env` to match.
- Over an SSH tunnel, map the **same** port on both ends (`ssh -L 2019:localhost:2019 <host>`) and leave `CADDY_ADMIN_URL` at its default. Caddy checks the `Host` header against its own listen address, so a tunnel on a different local port answers `403 host not allowed: localhost:<port>`.
- Behind a reverse proxy, add the proxy's `host:port` to the remote Caddy's `admin.origins`. Caddy checks both `Host` and `Origin`, and setting `admin.origins` **replaces** the default `localhost` / `127.0.0.1` / `::1` entries, so list `localhost:2019` too if local tools still need access. A non-loopback or wildcard `admin.listen` — the Docker `http://caddy:2019` above, for instance — does not allow an arbitrary `Host` either, so it needs `admin.origins` set as well.
- Pointing `CADDY_ADMIN_URL` at Caddy's native remote admin listener (`admin.remote`, default `:2021`) fails before any HTTP is exchanged, because that listener requires a TLS client certificate and caddy-mcp does not present one. It surfaces as this message even though Caddy is running and accepted the connection.

**"HTTP 412 Precondition Failed"**

- Someone (or something) changed the config between your read and your write.
- The cached ETag has been invalidated. Re-read the config and retry.

**"HTTP 401" or "HTTP 403" on any request**

- Caddy's own checks run on every admin request, reads included, and always answer with a JSON `{"error":...}` body. If you got one, it is Caddy: the `admin.listen` / `admin.origins` allowlists (`host not allowed: ...`, `client is not allowed to access from origin ...`, `required Origin header is missing or invalid` — see the tunnel and proxy bullets above), or, on `admin.remote`, its mTLS identity and permission checks.
- A **bodiless** 401/403 came from something in front of Caddy — a proxy, a gateway, an SSO layer. `CADDY_API_TOKEN` applies there and only there, so a missing or wrong token is one cause and the proxy's other access rules are another.
- Caddy's admin API has no bearer-token auth of its own, so setting `CADDY_API_TOKEN` will not clear a 401/403 that carries a Caddy error body.

**"directive 'X' is not an ordered HTTP handler"** from `caddy_adapt`, or from `caddy_load` with `format: "caddyfile"`

- Two causes, and Caddy's error cannot tell them apart:
  - The directive has no registered order — usually a plugin directive. Add an `order` global option, or wrap it in a `route` block.
  - On Caddy 2.11.4 and earlier, an earlier failed or concurrent Caddyfile adaptation that used `order` in this same Caddy process removed that directive from the process-wide directive order. Restarting Caddy restores the default order ([caddyserver/caddy#7995](https://github.com/caddyserver/caddy/pull/7995), unreleased).
- The second cause is why a Caddyfile that adapted a minute ago can start failing with no edit to it. Caddy's own advice ("try … using the order global option") fixes the first cause and papers over the second.

**`SIGUSR1` / `systemctl reload caddy` stops reloading the Caddyfile**

- Expected, and not caused by a bug here. Since Caddy 2.11.1, `SIGUSR1` reloads
  from the file on disk **only if the config has never been changed through the
  admin API**. The first write from caddy-mcp (or any other API client) makes
  Caddy consider the running config API-owned, and `SIGUSR1` becomes a no-op.
- Pick one owner per instance. If the Caddyfile is the source of truth, use
  caddy-mcp read-only tools (`caddy_status`, `caddy_list_routes`, `caddy_adapt`)
  and reload from the file. If caddy-mcp owns the config, apply changes with
  `caddy_load` instead of `SIGUSR1`.
- One qualification on Caddy 2.11.4 and earlier: `caddy_adapt` is read-only with
  respect to the config, but not with respect to the adapter. A Caddyfile `order`
  global option changes that process's directive order, and a failed `order` line
  can break later in-process adaptations — which is what a `SIGUSR1` reload and
  `caddy run --watch` do. `caddy reload`, which is what the packaged
  `systemctl reload caddy` runs, adapts in the CLI process and is unaffected.

**Windows: MCP server doesn't start**

- Use the `cmd /c npx ...` pattern from the Quick start section. Node 20+ can't spawn `.cmd` files directly.

## Requirements

- Node.js 20+
- Caddy 2.11.3 or later, with the admin API enabled (default: `localhost:2019`).
  The latest 2.11.x is recommended; verified against Caddy 2.11.4. Two admin-side
  reasons for that floor:
  - Caddy 2.11.2 and earlier log every admin request's headers at INFO, so if the
    `Authorization` header from `CADDY_API_TOKEN` reaches the admin listener, the
    token is written to Caddy's log in plain text
    ([caddyserver/caddy#7578](https://github.com/caddyserver/caddy/pull/7578)).
  - Caddy 2.11.1 and earlier accept a duplicate `@id` silently. A racing
    `caddy_reverse_proxy` create, or a `caddy_config_by_id` set with
    `mode: "insert"` on a route id, leaves two elements sharing one `@id`, and
    `/id/` resolves to only one of them.

  Older 2.x mostly works, but the `If-Match` (ETag) concurrency guard needs Caddy
  2.5.2 or later — before that Caddy ignores the header silently. The `@id` write
  path relies on `PATCH` semantics that the live integration suite pins per release.

## Contributing

```bash
git clone https://github.com/YawLabs/caddy-mcp.git
cd caddy-mcp
npm install
npm run lint       # Biome check
npm run lint:fix   # Auto-fix
npm run build      # tsup bundle
npm test           # Vitest (692 unit tests, +39 POSIX-only unix-socket and launcher tests; +33 live-Caddy integration tests gated by CADDY_MCP_INTEGRATION=1)
npm run typecheck  # tsc --noEmit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including release process.

## License

MIT

[![Follow @TokenLimitNews on X](https://img.shields.io/badge/follow-%40TokenLimitNews-000000?logo=x&logoColor=white)](https://x.com/TokenLimitNews)
