# @yawlabs/caddy-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/caddy-mcp)](https://www.npmjs.com/package/@yawlabs/caddy-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/caddy-mcp)](https://github.com/YawLabs/caddy-mcp/stargazers)

**Manage Caddy web servers from Claude Code, Cursor, and any MCP client.** 18 tools + 4 resources covering every endpoint of Caddy's admin API — config, routes, reverse proxies, TLS, PKI, metrics, snapshots.

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=Caddy&command=npx&args=-y%2C%40yawlabs%2Fcaddy-mcp&description=Manage%20Caddy%20web%20servers%20-%20config%2C%20routes%2C%20TLS%2C%20PKI&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fcaddy-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## Why this one?

Other Caddy MCP servers wrap half the admin API and silently swallow errors. This one doesn't.

- **Complete admin API coverage** — every documented endpoint: `/load`, `/config/*`, `/id/*`, `/stop`, `/adapt`, `/pki/ca/*`, `/reverse_proxy/upstreams`, `/metrics`. No placeholder tools that 404.
- **Safe concurrent writes** — uses ETags (`If-Match`) so your changes never silently overwrite someone else's. Surfaces `HTTP 412 Precondition Failed` as a clear message, not a cryptic error.
- **Safe-by-default mutations** — `caddy_config_set` defaults to idempotent `overwrite` (PATCH), not `append` (POST). Calling twice doesn't duplicate your route.
- **Defensive parsing** — `caddy_list_routes` never crashes on malformed config, even if routes are null, handlers are strings, or matchers are non-arrays. Regression-tested.
- **No leaked credentials in errors** — if `CADDY_ADMIN_URL` contains a token in the path/query, the connect-failed message shows only the origin.
- **Fallback error surfacing** — when a TLS write PATCH fails and the POST fallback also fails, both error bodies are returned so you know what actually went wrong.
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
| `CADDY_ADMIN_URL` | `http://localhost:2019` | Caddy admin API URL. Set to `http://caddy:2019` inside Docker, or an https URL for remote admin. Also accepts a unix socket, in either `unix:///var/run/caddy-admin.sock` or Caddy's own `unix//var/run/caddy-admin.sock` spelling — see below. |
| `CADDY_API_TOKEN` | (none) | Optional Bearer token for authenticated admin endpoints. Only needed if you've configured Caddy with auth. |
| `CADDY_MCP_SNAPSHOT_DIR` | (none) | Directory for persisting `caddy_revert` snapshots. Unset, snapshots live in memory only and are lost when this server restarts. Snapshots are full Caddy configs and can contain secrets, so the location is opt-in rather than defaulted. |
| `CADDY_MAX_RETRIES` | `2` | Number of retries on transient failures (5xx, network errors). 4xx and 412 never retry. POSTs to `/config/*` and `/id/*` also skip retry (non-idempotent appends/creates -- retrying could duplicate routes or 409 a half-applied create). POSTs to `/load`, `/adapt`, `/stop` still retry. Hard-capped at 5; values above the cap log a one-time stderr notice so the clamp is visible. Set to `0` to disable. |
| `CADDY_TIMEOUT` | `10000` | Timeout in ms for all admin API requests except `/load` (which uses `CADDY_LOAD_TIMEOUT`). Non-numeric, `<= 0`, or fractional values below 1ms fall back to the default. |
| `CADDY_LOAD_TIMEOUT` | `60000` | Timeout in ms for the `/load` endpoint; raise for ACME-heavy bring-ups where provisioning many certificates can exceed the default. Non-numeric, `<= 0`, or fractional values below 1ms fall back to the default. |

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
caddy-mcp needs read/write permission on the socket file. `CADDY_API_TOKEN`
still applies if you have auth in front of the endpoint.

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
- **caddy_config_set** — Write config at a path. Modes: `overwrite` (PATCH, default, idempotent), `append` (POST), `insert` (PUT, for array positions).
- **caddy_config_delete** — Delete config at a path. Requires `confirm=true` (deleting a parent path also removes every descendant).
- **caddy_config_by_id** — Get/set/delete config by `@id` tag — much easier than navigating deep paths. The `delete` action requires `confirm=true`.
- **caddy_load** — Replace the entire config atomically. 60-second timeout for cert provisioning. Auto-snapshots the prior config.
- **caddy_revert** — Manage config snapshots for rollback. Actions: `list`, `save`, `apply` (confirm-gated). In-memory, last 10.

### Route operations (4)

- **caddy_reverse_proxy** — Add a reverse proxy in one call: `from='api.local' to=['localhost:3000']`. Pass an optional `id` for idempotent writes — repeat calls replace the route in place instead of duplicating.
- **caddy_add_route** — Add a route with full match/handle control (any Caddy handler).
- **caddy_remove_route** — Remove a route by `@id` (preferred) or by index. Requires `confirm=true`.
- **caddy_list_routes** — Human-readable route summary. Defensive: never crashes on weird config.

### TLS & config conversion (2)

- **caddy_tls** — Check or set TLS settings: ACME email, ACME CA URL. PATCH first; on a fresh install, POSTs a minimal config. On an existing config it deep-merges into the issuer path and PUTs the result back, preserving siblings (custom certs, `on_demand`, additional policies). Refuses with a shape-specific error if the existing structure is unexpected — never clobbers.
- **caddy_adapt** — Convert a config in any registered adapter format to Caddy JSON without applying it. `caddyfile` (built-in, default) plus any adapter module compiled into your Caddy binary — e.g., `nginx` ([caddy-nginx-adapter](https://github.com/caddyserver/nginx-adapter)), `yaml` ([caddy-yaml](https://github.com/abiosoft/caddy-yaml)). Great for previewing or porting from existing configs.

### Server operations (6)

- **caddy_status** — Connectivity check + config summary (server count, routes, TLS mode).
- **caddy_list_servers** — List all HTTP servers with names, addresses, route counts, and TLS status.
- **caddy_upstreams** — Reverse proxy backend health.
- **caddy_metrics** — Prometheus metrics (request counts, durations, connections, TLS handshakes). Optional `filter` (substring match on metric name, keeps `# HELP` / `# TYPE` lines for retained metrics) and `max_lines` (default 500) keep responses compact on busy servers.
- **caddy_pki** — CA info and certificate chains (default CA: `local`).
- **caddy_stop** — Graceful shutdown. Requires `confirm=true` to prevent accidents.

## Resources

Browsable read-only data — MCP clients can fetch these directly without a tool call:

- `caddy://config` — Current full Caddy JSON configuration.
- `caddy://servers` — Summary of all configured HTTP servers.
- `caddy://upstreams` — Reverse proxy upstream health status.
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

**"HTTP 412 Precondition Failed"**

- Someone (or something) changed the config between your read and your write.
- The cached ETag has been invalidated. Re-read the config and retry.

**"HTTP 403" on /load or /config writes**

- You have `admin.listen` or `admin.origins` restrictions set in your Caddy config, or you're missing an `Authorization` header.
- Set `CADDY_API_TOKEN` in your MCP config env if Caddy expects a Bearer token.

**`SIGUSR1` / `systemctl reload caddy` stops reloading the Caddyfile**

- Expected, and not caused by a bug here. Since Caddy 2.11.1, `SIGUSR1` reloads
  from the file on disk **only if the config has never been changed through the
  admin API**. The first write from caddy-mcp (or any other API client) makes
  Caddy consider the running config API-owned, and `SIGUSR1` becomes a no-op.
- Pick one owner per instance. If the Caddyfile is the source of truth, use
  caddy-mcp read-only tools (`caddy_status`, `caddy_list_routes`, `caddy_adapt`)
  and reload from the file. If caddy-mcp owns the config, apply changes with
  `caddy_load` instead of `SIGUSR1`.

**Windows: MCP server doesn't start**

- Use the `cmd /c npx ...` pattern from the Quick start section. Node 20+ can't spawn `.cmd` files directly.

## Requirements

- Node.js 20+
- Caddy 2.x with admin API enabled (default: `localhost:2019`). Verified against
  Caddy 2.11.4; the `@id` write path relies on `PATCH` semantics that the live
  integration suite pins per release.

## Contributing

```bash
git clone https://github.com/YawLabs/caddy-mcp.git
cd caddy-mcp
npm install
npm run lint       # Biome check
npm run lint:fix   # Auto-fix
npm run build      # tsup bundle
npm test           # Vitest (333 unit tests, +2 POSIX-only unix-socket tests; +9 live-Caddy integration tests gated by CADDY_MCP_INTEGRATION=1)
npm run typecheck  # tsc --noEmit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including release process.

## License

MIT
