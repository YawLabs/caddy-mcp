# @yawlabs/caddy-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/caddy-mcp)](https://www.npmjs.com/package/@yawlabs/caddy-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**MCP server for managing Caddy web servers.** 13 tools for config management, reverse proxy setup, route operations, TLS, and server monitoring — all via Caddy's admin API.

Built and maintained by [Yaw Labs](https://yaw.sh).

## Quick start

```bash
npx @yawlabs/caddy-mcp
```

Or install globally:

```bash
npm install -g @yawlabs/caddy-mcp
caddy-mcp
```

## MCP client configuration

### Claude Code

```bash
claude mcp add caddy-mcp npx @yawlabs/caddy-mcp
```

### Claude Desktop / Cursor / Windsurf

Add to your MCP config file:

```json
{
  "mcpServers": {
    "caddy-mcp": {
      "command": "npx",
      "args": ["@yawlabs/caddy-mcp"],
      "env": {
        "CADDY_ADMIN_URL": "http://localhost:2019"
      }
    }
  }
}
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `CADDY_ADMIN_URL` | `http://localhost:2019` | Caddy admin API URL |
| `CADDY_API_TOKEN` | (none) | Optional Bearer token for authenticated admin endpoints |

## Tools

### Config management

- **caddy_config_get** — Read config at any JSON path (or full config)
- **caddy_config_set** — Create or replace config at a path
- **caddy_config_delete** — Delete config at a path
- **caddy_load** — Replace entire config atomically

### Route operations

- **caddy_reverse_proxy** — Add a reverse proxy in one call: `from='api.local' to=['localhost:3000']`
- **caddy_add_route** — Add a route with full match/handle control (any Caddy handler)
- **caddy_list_routes** — Human-readable route summary

### TLS & config conversion

- **caddy_tls** — Check/configure TLS settings, ACME email, CA
- **caddy_adapt** — Convert Caddyfile to JSON (preview before applying)

### Server operations

- **caddy_status** — Connectivity check + config summary
- **caddy_upstreams** — Reverse proxy backend health
- **caddy_pki** — CA info and certificate chains
- **caddy_stop** — Graceful shutdown (requires confirmation)

## Resources

- `caddy://config` — Current Caddy JSON configuration
- `caddy://upstreams` — Reverse proxy upstream health status

## Examples

```
> "Proxy api.local to my dev server on port 3000"
→ caddy_reverse_proxy(from: "api.local", to: ["localhost:3000"])

> "What routes are configured?"
→ caddy_list_routes()

> "Show me the full Caddy config"
→ caddy_config_get()

> "Convert this Caddyfile to JSON"
→ caddy_adapt(config: "example.com {\n  reverse_proxy localhost:8080\n}")

> "Is Caddy running?"
→ caddy_status()
```

## Requirements

- Node.js 18+
- Caddy server with admin API enabled (default: `localhost:2019`)

## License

MIT
