# @yawlabs/caddy-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/caddy-mcp)](https://www.npmjs.com/package/@yawlabs/caddy-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/caddy-mcp)](https://github.com/YawLabs/caddy-mcp/stargazers)

**Manage Caddy web servers from Claude Code, Cursor, and any MCP client.** 18 tools + 4 resources covering every endpoint of Caddy's admin API — config, routes, reverse proxies, TLS, PKI, metrics, snapshots.

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to mcp.hosting](https://mcp.hosting/install-button.svg)](https://mcp.hosting/install?name=Caddy&command=npx&args=-y%2C%40yawlabs%2Fcaddy-mcp&env=CADDY_ADMIN_URL%2CCADDY_API_TOKEN&description=Manage%20Caddy%20web%20servers%20-%20config%2C%20routes%2C%20TLS%2C%20PKI&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fcaddy-mcp)

One click adds this to your [mcp.hosting](https://mcp.hosting) account so it syncs to every MCP client you use. Or install manually below.

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
      "args": ["-y", "@yawlabs/caddy-mcp"]
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
      "args": ["/c", "npx", "-y", "@yawlabs/caddy-mcp"]
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
| `CADDY_ADMIN_URL` | `http://localhost:2019` | Caddy admin API URL. Set to `http://caddy:2019` inside Docker, or an https URL for remote admin. |
| `CADDY_API_TOKEN` | (none) | Optional Bearer token for authenticated admin endpoints. Only needed if you've configured Caddy with auth. |
| `CADDY_MAX_RETRIES` | `2` | Number of retries on transient failures (5xx, network errors). 4xx and 412 never retry. Hard-capped at 5. Set to `0` to disable. |

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
- **caddy_config_delete** — Delete config at a path.
- **caddy_config_by_id** — Get/set/delete config by `@id` tag — much easier than navigating deep paths.
- **caddy_load** — Replace the entire config atomically. 60-second timeout for cert provisioning. Auto-snapshots the prior config.
- **caddy_revert** — Manage config snapshots for rollback. Actions: `list`, `save`, `apply` (confirm-gated). In-memory, last 10.

### Route operations (4)

- **caddy_reverse_proxy** — Add a reverse proxy in one call: `from='api.local' to=['localhost:3000']`.
- **caddy_add_route** — Add a route with full match/handle control (any Caddy handler).
- **caddy_remove_route** — Remove a route by `@id` (preferred) or by index. Requires `confirm=true`.
- **caddy_list_routes** — Human-readable route summary. Defensive: never crashes on weird config.

### TLS & config conversion (2)

- **caddy_tls** — Check or set TLS settings: ACME email, ACME CA URL. Falls back gracefully when paths don't yet exist.
- **caddy_adapt** — Convert a Caddyfile (or nginx config) to Caddy JSON without applying it. Great for previewing.

### Server operations (6)

- **caddy_status** — Connectivity check + config summary (server count, routes, TLS mode).
- **caddy_list_servers** — List all HTTP servers with names, addresses, route counts, and TLS status.
- **caddy_upstreams** — Reverse proxy backend health.
- **caddy_metrics** — Prometheus metrics (request counts, durations, connections, TLS handshakes).
- **caddy_pki** — CA info and certificate chains (default CA: `local`).
- **caddy_stop** — Graceful shutdown. Requires `confirm=true` to prevent accidents.

## Resources

Browsable read-only data — MCP clients can fetch these directly without a tool call:

- `caddy://config` — Current full Caddy JSON configuration.
- `caddy://servers` — Summary of all configured HTTP servers.
- `caddy://upstreams` — Reverse proxy upstream health status.
- `caddy://metrics` — Prometheus metrics (text exposition format).

## Examples

### Add a reverse proxy

```
> "Proxy api.example.com to my app on port 3000"
→ caddy_reverse_proxy({ from: "api.example.com", to: ["localhost:3000"] })
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

**Windows: MCP server doesn't start**

- Use the `cmd /c npx ...` pattern from the Quick start section. Node 20+ can't spawn `.cmd` files directly.

## Requirements

- Node.js 20+
- Caddy 2.x with admin API enabled (default: `localhost:2019`)

## Contributing

```bash
git clone https://github.com/YawLabs/caddy-mcp.git
cd caddy-mcp
npm install
npm run lint       # Biome check
npm run lint:fix   # Auto-fix
npm run build      # tsup bundle
npm test           # Vitest (106 unit tests; +7 live-Caddy integration tests gated by CADDY_MCP_INTEGRATION=1)
npm run typecheck  # tsc --noEmit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including release process.

## License

MIT
